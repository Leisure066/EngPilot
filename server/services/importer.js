"use strict";

const crypto = require("node:crypto");
const { transaction } = require("../db");

const MODES = new Set(["skip", "merge"]);

function makeImportId() {
  return `imp_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
}

/** Loads existing rows for a set of normalized headwords, in chunks of 300. */
function loadExisting(db, bookId, normalizedList) {
  const map = new Map();
  for (let i = 0; i < normalizedList.length; i += 300) {
    const chunk = normalizedList.slice(i, i + 300);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, headword, normalized, translation, phonetic_us, phonetic_uk, pos
         FROM words WHERE book_id = ? AND normalized IN (${placeholders})`,
      )
      .all(bookId, ...chunk);
    for (const row of rows) map.set(row.normalized, row);
  }
  return map;
}

function canEnrich(existing, entry) {
  if (entry.translation && !existing.translation) return true;
  if (entry.phonetic && !existing.phonetic_us && !existing.phonetic_uk) return true;
  if (entry.pos && !existing.pos) return true;
  return false;
}

/**
 * Decides what would happen for every parsed entry, without writing anything.
 */
function analyse(db, { bookId, entries, mode = "merge" }) {
  if (!MODES.has(mode)) throw new Error(`未知导入模式：${mode}`);
  const unique = [];
  const seen = new Set();
  const batchDuplicates = [];
  for (const entry of entries) {
    if (seen.has(entry.normalized)) {
      batchDuplicates.push(entry);
      continue;
    }
    seen.add(entry.normalized);
    unique.push(entry);
  }

  const existingMap = loadExisting(
    db,
    bookId,
    unique.map((entry) => entry.normalized),
  );

  const toInsert = [];
  const toEnrich = [];
  const duplicates = [];
  for (const entry of unique) {
    const existing = existingMap.get(entry.normalized);
    if (!existing) {
      toInsert.push(entry);
    } else if (mode === "merge" && canEnrich(existing, entry)) {
      toEnrich.push({ entry, existing });
    } else {
      duplicates.push({ entry, existing });
    }
  }

  return { unique, toInsert, toEnrich, duplicates, batchDuplicates };
}

function applyEnrichment(db, { entry, existing }, now) {
  const sets = [];
  const args = [];
  if (entry.translation && !existing.translation) {
    sets.push("translation = ?");
    args.push(entry.translation);
  }
  if (entry.phonetic && !existing.phonetic_us && !existing.phonetic_uk) {
    sets.push("phonetic_us = ?", "phonetic_uk = ?");
    args.push(entry.phonetic, entry.phonetic);
  }
  if (entry.pos && !existing.pos) {
    sets.push("pos = ?");
    args.push(entry.pos);
  }
  if (!sets.length) return false;
  sets.push("updated_at = ?");
  args.push(now, existing.id);
  db.prepare(`UPDATE words SET ${sets.join(", ")} WHERE id = ?`).run(...args);
  return true;
}

/**
 * Writes one import batch inside a single transaction.
 * @returns statistics object (also persisted in the `imports` table).
 */
function perform(db, { bookId, parsed, mode = "merge", filename = "", encoding = "" }) {
  if (!MODES.has(mode)) throw new Error(`未知导入模式：${mode}`);
  const analysis = analyse(db, { bookId, entries: parsed.entries, mode });
  const importId = makeImportId();
  const now = new Date().toISOString();
  const invalidCount = parsed.invalid.length;

  const summary = transaction(db, () => {
    let maxOrder = Number(
      db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM words WHERE book_id = ?").get(bookId).n,
    );

    db.prepare(
      `INSERT INTO imports (id, book_id, filename, encoding, mode, total, inserted, enriched, duplicated, invalid, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
    ).run(importId, bookId, filename, encoding, mode, now);

    const insertWord = db.prepare(
      `INSERT INTO words (
         id, book_id, headword, normalized, phonetic_us, phonetic_uk, pos, translation,
         definition_en, exchange, tags, collins, frq, starred, starred_at, status, note,
         source, sort_order, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 0, 0, 0, NULL, 'new', '', 'import', ?, ?, ?)`,
    );
    const linkItem = db.prepare("INSERT OR IGNORE INTO import_items (import_id, word_id) VALUES (?, ?)");

    let inserted = 0;
    for (const [index, entry] of analysis.toInsert.entries()) {
      const id = `i_${importId.slice(4)}_${index + 1}`;
      insertWord.run(
        id,
        bookId,
        entry.headword,
        entry.normalized,
        entry.phonetic || "",
        entry.phonetic || "",
        entry.pos || "",
        entry.translation || "",
        maxOrder + index + 1,
        now,
        now,
      );
      linkItem.run(importId, id);
      inserted += 1;
    }

    let enriched = 0;
    for (const pair of analysis.toEnrich) {
      if (applyEnrichment(db, pair, now)) enriched += 1;
    }

    db.prepare(
      `UPDATE imports SET total = ?, inserted = ?, enriched = ?, duplicated = ?, invalid = ? WHERE id = ?`,
    ).run(
      analysis.unique.length + analysis.batchDuplicates.length,
      inserted,
      enriched,
      analysis.duplicates.length + analysis.batchDuplicates.length,
      invalidCount,
      importId,
    );

    return {
      importId,
      total: analysis.unique.length + analysis.batchDuplicates.length,
      inserted,
      enriched,
      duplicated: analysis.duplicates.length + analysis.batchDuplicates.length,
      invalid: invalidCount,
    };
  });

  return {
    ...summary,
    bookId,
    mode,
    filename,
    encoding,
    truncated: Boolean(parsed.truncated),
    invalidLines: parsed.invalid.slice(0, 20),
    duplicatesSample: analysis.duplicates.slice(0, 20).map((item) => ({
      line: item.entry.line,
      headword: item.entry.headword,
    })),
  };
}

function rollback(db, importId) {
  const row = db.prepare("SELECT * FROM imports WHERE id = ?").get(importId);
  if (!row) return null;
  const deleted = transaction(db, () => {
    const changes = Number(
      db
        .prepare(
          `DELETE FROM words
           WHERE source = 'import'
             AND id IN (SELECT word_id FROM import_items WHERE import_id = ?)`,
        )
        .run(importId).changes || 0,
    );
    db.prepare("DELETE FROM imports WHERE id = ?").run(importId);
    return changes;
  });
  return { importId, deleted, inserted: row.inserted };
}

function list(db, limit = 50) {
  return db.prepare("SELECT * FROM imports ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
}

module.exports = { analyse, perform, rollback, list, MODES };