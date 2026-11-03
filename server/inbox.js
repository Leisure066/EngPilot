"use strict";

/**
 * Drop-in folder: any *.txt placed in data/inbox/ is imported on startup
 * (one word per line, same format as the upload import) and then moved to
 * data/inbox/done/ so it is not imported twice.
 */

const fs = require("node:fs");
const path = require("node:path");

const { DATA_DIR } = require("./db");
const { parseTxt } = require("./importers/txt");
const importer = require("./services/importer");
const { pickBookId } = require("./routes/words");

const INBOX_DIR = path.join(DATA_DIR, "inbox");
const DONE_DIR = path.join(INBOX_DIR, "done");

function nextDonePath(name) {
  fs.mkdirSync(DONE_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  let target = path.join(DONE_DIR, `${stamp}-${name}`);
  let counter = 2;
  while (fs.existsSync(target)) {
    target = path.join(DONE_DIR, `${stamp}-${counter}-${name}`);
    counter += 1;
  }
  return target;
}

function scanInbox(db) {
  if (!fs.existsSync(INBOX_DIR)) return [];
  const files = fs
    .readdirSync(INBOX_DIR, { withFileTypes: true })
    .filter((item) => item.isFile() && item.name.toLowerCase().endsWith(".txt"))
    .map((item) => item.name)
    .sort();

  const results = [];
  for (const name of files) {
    const file = path.join(INBOX_DIR, name);
    try {
      const buffer = fs.readFileSync(file);
      const parsed = parseTxt(buffer);
      if (!parsed.entries.length) {
        results.push({ file: name, skipped: true, reason: "没有解析出任何单词", invalid: parsed.invalid.length });
        fs.renameSync(file, nextDonePath(name));
        continue;
      }
      const bookId = pickBookId(db, null);
      const summary = importer.perform(db, {
        bookId,
        parsed,
        mode: "merge",
        filename: name,
        encoding: parsed.encoding,
      });
      fs.renameSync(file, nextDonePath(name));
      results.push({ file: name, ...summary });
    } catch (error) {
      results.push({ file: name, error: error.message });
    }
  }
  return results;
}

module.exports = { scanInbox, INBOX_DIR, DONE_DIR };