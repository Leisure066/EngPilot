"use strict";

const { getDb, normalizeWord } = require("../db");
const { httpError, intParam, cleanString, boolParam } = require("../http");
const affixService = require("../services/affix");
const { pickBookId, toWord } = require("./words");

function toDictEntry(row) {
  return {
    word: row.word,
    phonetic: row.phonetic,
    definition: row.definition,
    translation: row.translation,
    pos: row.pos,
    collins: Number(row.collins),
    oxford: Number(row.oxford),
    tags: row.tag,
    bnc: Number(row.bnc),
    frq: Number(row.frq),
    exchange: row.exchange,
    lemma: row.lemma || null,
  };
}

function findDictEntry(db, normalized) {
  const exact = db.prepare("SELECT * FROM dict_entries WHERE normalized = ?").get(normalized);
  if (exact) return { row: exact, lemmatized: false };
  const viaLemma = db
    .prepare("SELECT * FROM dict_entries WHERE lemma = ? ORDER BY bnc DESC, frq DESC LIMIT 1")
    .get(normalized);
  if (viaLemma) return { row: viaLemma, lemmatized: true };
  return { row: null, lemmatized: false };
}

function lookupWord({ query, params }) {
  const db = getDb();
  const raw = cleanString(params.word, 64);
  if (!raw) throw httpError("BAD_REQUEST", "请提供要查询的单词");
  const normalized = normalizeWord(raw);
  const withHints = boolParam(query, "hints", true);
  const bookId = cleanString(query.get("book"), 80) || null;

  const bookRow = bookId
    ? db.prepare("SELECT * FROM words WHERE book_id = ? AND normalized = ?").get(bookId, normalized)
    : db
        .prepare(
          `SELECT * FROM words WHERE normalized = ?
           ORDER BY CASE WHEN book_id = ? THEN 0 ELSE 1 END, sort_order ASC
           LIMIT 1`,
        )
        .get(normalized, pickBookId(db, null));

  const { row: dictRow, lemmatized } = findDictEntry(db, normalized);
  const hintSource = dictRow ? dictRow.word : raw;
  const hints = withHints ? affixService.analyseWord(hintSource) : [];
  const grouped = affixService.groupHints(hints);

  const source = bookRow && dictRow ? "both" : bookRow ? "book" : dictRow ? "ecdict" : "none";

  return {
    data: {
      word: raw,
      normalized,
      found: Boolean(bookRow || dictRow),
      inBook: Boolean(bookRow),
      source,
      entry: bookRow ? toWord(bookRow, hints) : null,
      dict: dictRow ? toDictEntry(dictRow) : null,
      lemmatized,
      lemma: lemmatized && dictRow ? dictRow.word : null,
      hints,
      affixes: {
        prefix: grouped.prefix,
        suffix: grouped.suffix,
        roots: grouped.roots,
      },
    },
  };
}

const SUGGEST_LIMIT = 10;

/** Range scan on the normalized unique index; LIKE '%…' would not use it. */
function prefixRange(prefix) {
  const lower = prefix.toLowerCase();
  const last = lower.charCodeAt(lower.length - 1);
  const upper = lower.slice(0, -1) + String.fromCharCode(last + 1);
  return [lower, upper];
}

function suggest({ query }) {
  const db = getDb();
  const q = cleanString(query.get("q"), 40);
  if (!q) throw httpError("BAD_REQUEST", "请提供 q 参数");
  const limit = intParam(query, "limit", SUGGEST_LIMIT, { min: 1, max: 30 });
  const like = `${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;

  const words = db
    .prepare(
      `SELECT id, headword, phonetic_us, translation, status, starred
       FROM words WHERE headword LIKE ? ESCAPE '\\' COLLATE NOCASE
       ORDER BY LENGTH(headword) ASC, headword ASC LIMIT ?`,
    )
    .all(like, limit)
    .map((row) => ({
      id: row.id,
      headword: row.headword,
      phoneticUs: row.phonetic_us,
      translation: row.translation,
      status: row.status,
      starred: Boolean(row.starred),
    }));

  const known = new Set(words.map((word) => word.headword.toLowerCase()));
  const [lower, upper] = prefixRange(q);
  const dict = db
    .prepare(
      `SELECT word, phonetic, translation, tag FROM dict_entries
       WHERE normalized >= ? AND normalized < ?
       ORDER BY normalized LIMIT 200`,
    )
    .all(lower, upper)
    .filter((row) => !known.has(row.word.toLowerCase()))
    .sort((a, b) => a.word.length - b.word.length || a.word.localeCompare(b.word))
    .slice(0, limit)
    .map((row) => ({
      word: row.word,
      phonetic: row.phonetic,
      translation: row.translation,
      tags: row.tag,
      inBook: false,
    }));

  const catalog = affixService.getCatalog();
  const lowerQ = q.toLowerCase();
  const affixes = [];
  for (const type of affixService.TYPES) {
    for (const item of catalog[type]) {
      if (affixes.length >= limit) break;
      if (!item.key.startsWith(lowerQ) && !item.forms.some((form) => form.startsWith(lowerQ))) continue;
      affixes.push({
        type,
        key: item.key,
        label: item.label,
        meaning: item.meaning,
      });
    }
  }

  return { data: { q, words, dict, affixes } };
}

const routes = [
  { method: "GET", pattern: /^\/api\/v1\/dict\/suggest$/, handler: suggest },
  { method: "GET", pattern: /^\/api\/v1\/dict\/([^/]+)$/, params: ["word"], handler: lookupWord },
];

module.exports = { routes, toDictEntry };