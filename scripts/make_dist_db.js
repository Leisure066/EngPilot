// 开发用：把工作区数据库压成一致快照，供 dist 发布包使用。
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");

const source = path.join(__dirname, "..", "data", "zhanci.db");
const target = path.join(__dirname, "..", "dist", "EngPilot", "data", "zhanci.db");

fs.rmSync(target, { force: true });

const db = new DatabaseSync(source);
db.exec(`VACUUM INTO '${target.replace(/\\/g, "/")}'`);
db.close();

const size = fs.statSync(target).size;
const copy = new DatabaseSync(target);
const words = copy.prepare("SELECT COUNT(*) AS n FROM words").get().n;
const dict = copy.prepare("SELECT COUNT(*) AS n FROM dict_entries").get().n;
const cards = copy.prepare("SELECT COUNT(*) AS n FROM review_cards").get().n;
copy.close();

console.log(`snapshot: ${(size / 1024 / 1024).toFixed(1)} MB, words=${words}, dict=${dict}, cards=${cards}`);