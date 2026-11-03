/* 发布前清理：把一份数据库里的个人学习痕迹抹掉，只留词库和离线词典。
   用法：node scripts/clean-release-db.js <dbPath> */
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const dbPath = process.argv[2];
if (!dbPath) {
  console.error("用法：node scripts/clean-release-db.js <dbPath>");
  process.exit(1);
}
if (!fs.existsSync(dbPath)) {
  console.error(`数据库不存在：${dbPath}`);
  process.exit(1);
}

const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

const before = {
  cards: db.prepare("SELECT COUNT(*) AS n FROM review_cards").get().n,
  logs: db.prepare("SELECT COUNT(*) AS n FROM review_logs").get().n,
  imports: db.prepare("SELECT COUNT(*) AS n FROM imports").get().n,
  notes: db.prepare("SELECT COUNT(*) AS n FROM notes").get().n,
  known: db.prepare("SELECT COUNT(*) AS n FROM words WHERE status != 'new'").get().n,
  starred: db.prepare("SELECT COUNT(*) AS n FROM words WHERE starred = 1").get().n,
};

db.exec("BEGIN");
db.exec("DELETE FROM review_logs");
db.exec("DELETE FROM review_cards");
db.exec("DELETE FROM import_items");
db.exec("DELETE FROM imports");
db.exec("DELETE FROM notes");
db.exec("DELETE FROM words WHERE source = 'custom'");
db.exec("UPDATE words SET status = 'new', starred = 0, starred_at = NULL, note = ''");
db.exec("COMMIT");

// 把 WAL 合并回主库，分发出去的就是单个 .db 文件
db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
db.close();

for (const suffix of ["-wal", "-shm"]) {
  const extra = dbPath + suffix;
  if (fs.existsSync(extra) && fs.statSync(extra).size === 0) fs.rmSync(extra, { force: true });
}

const check = new DatabaseSync(dbPath, { readOnly: true });
const after = {
  words: check.prepare("SELECT COUNT(*) AS n FROM words").get().n,
  cards: check.prepare("SELECT COUNT(*) AS n FROM review_cards").get().n,
  logs: check.prepare("SELECT COUNT(*) AS n FROM review_logs").get().n,
  imports: check.prepare("SELECT COUNT(*) AS n FROM imports").get().n,
  notes: check.prepare("SELECT COUNT(*) AS n FROM notes").get().n,
  dict: check.prepare("SELECT COUNT(*) AS n FROM dict_entries").get().n,
  notNew: check.prepare("SELECT COUNT(*) AS n FROM words WHERE status != 'new'").get().n,
  starred: check.prepare("SELECT COUNT(*) AS n FROM words WHERE starred = 1").get().n,
};
check.close();

console.log("cleaned:", JSON.stringify(before), "->", JSON.stringify(after));
const leftovers = after.cards + after.logs + after.imports + after.notes + after.notNew + after.starred;
if (leftovers !== 0) {
  console.error("清理不彻底，仍有个人数据残留");
  process.exit(1);
}
console.log(`size: ${(fs.statSync(dbPath).size / 1024 / 1024).toFixed(0)} MB, words=${after.words}, dict=${after.dict}`);