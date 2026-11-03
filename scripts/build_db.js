"use strict";

/**
 * Builds / rebuilds the local SQLite database from the PDF-derived seed file.
 *
 *   node scripts/build_db.js            # create the db if it does not exist
 *   node scripts/build_db.js --reset    # drop the db and rebuild from seed
 *
 * NOTE: --reset also drops the offline dictionary (dict_entries); run
 * `node scripts/import_stardict.js` afterwards to restore it.
 */

const fs = require("node:fs");
const path = require("node:path");

const args = new Set(process.argv.slice(2));
const reset = args.has("--reset") || args.has("--force");

const dbPath = process.env.ZHANCI_DB
  ? path.resolve(process.env.ZHANCI_DB)
  : path.resolve(__dirname, "..", "data", "zhanci.db");

if (reset) {
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${dbPath}${suffix}`;
    if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
      console.log(`[build:db] 已删除 ${path.relative(process.cwd(), target)}`);
    }
  }
}

const started = Date.now();
const { getDb, closeDb, DB_FILE, counts } = require("../server/db");
const db = getDb();

const books = db.prepare("SELECT id, name FROM books ORDER BY created_at").all();
const stats = counts(db);
const extra = db.prepare("PRAGMA user_version").get();

console.log(`[build:db] 数据库：${DB_FILE}`);
console.log(`[build:db] schema 版本：${extra.user_version}`);
for (const book of books) {
  const n = db.prepare("SELECT COUNT(*) AS n FROM words WHERE book_id = ?").get(book.id).n;
  console.log(`[build:db] 词书 ${book.id}「${book.name}」：${n} 个单词`);
}
console.log(
  `[build:db] 统计：总数 ${stats.total}，星标 ${stats.starred}，已掌握 ${stats.known}，学习中 ${stats.learning}`,
);
console.log(`[build:db] 完成，用时 ${Date.now() - started} ms`);

closeDb();