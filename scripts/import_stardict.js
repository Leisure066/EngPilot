"use strict";

/**
 * Imports the ECDICT / stardict CSV dump into the local dict_entries table.
 * Run once, offline:
 *
 *   node scripts/import_stardict.js                       # full import (~3 min)
 *   node scripts/import_stardict.js --limit 100000        # sample import
 *   node scripts/import_stardict.js --reset               # wipe and re-import
 *   node scripts/import_stardict.js --no-enrich           # skip word enrichment
 *
 * After importing it also calibrates the 2,084 book words (IPA, English
 * definition, word forms, exam tags, Collins stars, frequency).
 */

const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const { getDb, closeDb, transaction, DB_FILE, SEED_BOOK_ID } = require("../server/db");
const { parseCsvLine } = require("../server/importers/csv");
const { normalizeEcdictPhonetic } = require("../server/http");

const ROOT = path.resolve(__dirname, "..");

function parseArgs(argv) {
  const options = { file: path.join(ROOT, "stardict", "stardict.csv"), limit: 0, reset: false, enrich: true, batch: 5000 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--reset") options.reset = true;
    else if (arg === "--no-enrich") options.enrich = false;
    else if (arg === "--file") options.file = path.resolve(argv[++i]);
    else if (arg === "--limit") options.limit = Number(argv[++i]) || 0;
    else if (arg === "--batch") options.batch = Number(argv[++i]) || 5000;
  }
  return options;
}

function clean(value, max) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ")
    .trim()
    .slice(0, max);
}

function toInt(value) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** ECDICT exchange: "p:ran/d:run/i:running/3:runs/0:run" → "run". */
function lemmaOf(exchange) {
  for (const part of String(exchange || "").split("/")) {
    if (part.startsWith("0:")) return part.slice(2).trim().toLowerCase();
  }
  return "";
}

const INSERT_SQL = `
  INSERT OR IGNORE INTO dict_entries
    (word, normalized, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, lemma)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

async function importFile(db, options) {
  const insert = db.prepare(INSERT_SQL);
  const stats = { lines: 0, inserted: 0, duplicate: 0, skipped: 0, truncated: false };
  let batch = [];

  const flush = () => {
    if (!batch.length) return;
    const rows = batch;
    batch = [];
    transaction(db, () => {
      for (const row of rows) insert.run(...row);
    });
  };

  const stream = readline.createInterface({
    input: fs.createReadStream(options.file, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });

  let headerSeen = false;
  const started = Date.now();

  for await (const rawLine of stream) {
    stats.lines += 1;
    if (!headerSeen) {
      headerSeen = true;
      if (rawLine.toLowerCase().startsWith("word,")) continue;
    }
    if (!rawLine.trim()) continue;
    if (options.limit && stats.lines > options.limit) {
      stats.truncated = true;
      break;
    }

    const { fields, closed } = parseCsvLine(rawLine);
    if (!closed || fields.length < 12) {
      stats.skipped += 1;
      continue;
    }

    const word = clean(fields[0], 120);
    const normalized = word.toLowerCase();
    if (!word || !/[a-z]/i.test(word)) {
      stats.skipped += 1;
      continue;
    }

    const phonetic = normalizeEcdictPhonetic(fields[1]);
    const exchange = clean(fields[10], 500);
    const lemma = lemmaOf(exchange);
    batch.push([
      word,
      normalized,
      phonetic,
      clean(fields[2], 4000),
      clean(fields[3], 4000),
      clean(fields[4], 120),
      toInt(fields[5]),
      toInt(fields[6]),
      clean(fields[7], 200),
      toInt(fields[8]),
      toInt(fields[9]),
      exchange,
      lemma && lemma !== normalized ? lemma : "",
    ]);

    if (batch.length >= options.batch) {
      flush();
      if (stats.lines % 500000 === 0) {
        const rate = Math.round(stats.lines / ((Date.now() - started) / 1000));
        console.log(`[import] ${stats.lines.toLocaleString()} 行，${rate.toLocaleString()} 行/秒`);
      }
    }
  }
  flush();

  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM dict_entries").get().n);
  stats.inserted = total;
  stats.seconds = ((Date.now() - started) / 1000).toFixed(1);
  return stats;
}

/** Fills book words with dictionary data without touching the PDF translation. */
function enrichBookWords(db) {
  const rows = db.prepare("SELECT * FROM words").all();
  const lookup = db.prepare("SELECT * FROM dict_entries WHERE normalized = ?");
  const update = db.prepare(
    `UPDATE words SET
       phonetic_uk = ?, phonetic_us = ?, definition_en = ?, exchange = ?, tags = ?,
       collins = ?, frq = ?, updated_at = ?
     WHERE id = ?`,
  );

  const now = new Date().toISOString();
  const result = { total: rows.length, matched: 0, ipa: 0, definition: 0, missing: [] };
  transaction(db, () => {
    for (const row of rows) {
      const dict = lookup.get(row.normalized);
      if (!dict) {
        result.missing.push(row.headword);
        continue;
      }
      result.matched += 1;
      const ipa = dict.phonetic || "";
      const phoneticUk = ipa || row.phonetic_uk;
      const phoneticUs = ipa || row.phonetic_us;
      const definition = row.definition_en || dict.definition;
      const exchange = row.exchange || dict.exchange;
      const tags = row.tags || dict.tag;
      const collins = row.collins || dict.collins;
      const frq = row.frq || dict.frq;

      if (ipa) result.ipa += 1;
      if (definition && !row.definition_en) result.definition += 1;

      const changed =
        phoneticUk !== row.phonetic_uk ||
        phoneticUs !== row.phonetic_us ||
        definition !== row.definition_en ||
        exchange !== row.exchange ||
        tags !== row.tags ||
        collins !== row.collins ||
        frq !== row.frq;
      if (!changed) continue;
      update.run(phoneticUk, phoneticUs, definition, exchange, tags, collins, frq, now, row.id);
    }
  });
  return result;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(options.file)) {
    console.error(`找不到文件：${options.file}`);
    process.exit(1);
  }

  const db = getDb();
  console.log(`[import] 数据库：${DB_FILE}`);
  console.log(`[import] 源文件：${options.file}（${(fs.statSync(options.file).size / 1024 / 1024).toFixed(1)} MB）`);

  if (options.reset) {
    db.exec("DELETE FROM dict_entries");
    console.log("[import] 已清空 dict_entries");
  }
  const before = Number(db.prepare("SELECT COUNT(*) AS n FROM dict_entries").get().n);

  const stats = await importFile(db, options);
  console.log(
    `[import] 完成：扫描 ${stats.lines.toLocaleString()} 行，库内词条 ${stats.inserted.toLocaleString()}（本次新增 ${(stats.inserted - before).toLocaleString()}），跳过 ${stats.skipped.toLocaleString()}，用时 ${stats.seconds}s`,
  );

  if (options.enrich) {
    const result = enrichBookWords(db);
    console.log(
      `[enrich] 词书 ${result.total} 词，词典命中 ${result.matched}，音标 ${result.ipa}，英文释义 ${result.definition}`,
    );
    if (result.missing.length) {
      console.log(`[enrich] 未命中 ${result.missing.length} 个：${result.missing.slice(0, 30).join(", ")}`);
    }
  }

  const size = fs.statSync(DB_FILE).size / 1024 / 1024;
  console.log(`[import] 数据库大小：${size.toFixed(0)} MB`);
  closeDb();
}

main().catch((error) => {
  console.error("[import] 失败：", error);
  process.exit(1);
});