"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const SEED_FILE = path.join(DATA_DIR, "words.seed.json");
const DB_FILE = process.env.ZHANCI_DB
  ? path.resolve(process.env.ZHANCI_DB)
  : path.join(DATA_DIR, "zhanci.db");

const SCHEMA_VERSION = 6;

const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS books (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        source      TEXT NOT NULL DEFAULT '',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS words (
        id            TEXT PRIMARY KEY,
        book_id       TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
        headword      TEXT NOT NULL,
        normalized    TEXT NOT NULL,
        phonetic_us   TEXT NOT NULL DEFAULT '',
        phonetic_uk   TEXT NOT NULL DEFAULT '',
        pos           TEXT NOT NULL DEFAULT '',
        translation   TEXT NOT NULL DEFAULT '',
        definition_en TEXT NOT NULL DEFAULT '',
        exchange      TEXT NOT NULL DEFAULT '',
        tags          TEXT NOT NULL DEFAULT '',
        collins       INTEGER NOT NULL DEFAULT 0,
        frq           INTEGER NOT NULL DEFAULT 0,
        starred       INTEGER NOT NULL DEFAULT 0,
        starred_at    TEXT,
        status        TEXT NOT NULL DEFAULT 'new'
                      CHECK (status IN ('new', 'learning', 'known')),
        note          TEXT NOT NULL DEFAULT '',
        source        TEXT NOT NULL DEFAULT '',
        sort_order    INTEGER NOT NULL DEFAULT 0,
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL,
        UNIQUE (book_id, normalized)
      );

      CREATE INDEX IF NOT EXISTS idx_words_book_order ON words(book_id, sort_order);
      CREATE INDEX IF NOT EXISTS idx_words_starred    ON words(starred, starred_at);
      CREATE INDEX IF NOT EXISTS idx_words_status     ON words(book_id, status);
      CREATE INDEX IF NOT EXISTS idx_words_normalized ON words(normalized);
      CREATE INDEX IF NOT EXISTS idx_words_headword   ON words(headword COLLATE NOCASE);
    `,
  },
  {
    version: 2,
    sql: `
      CREATE TABLE IF NOT EXISTS imports (
        id          TEXT PRIMARY KEY,
        book_id     TEXT NOT NULL,
        filename    TEXT NOT NULL DEFAULT '',
        encoding    TEXT NOT NULL DEFAULT '',
        mode        TEXT NOT NULL DEFAULT 'merge',
        total       INTEGER NOT NULL DEFAULT 0,
        inserted    INTEGER NOT NULL DEFAULT 0,
        enriched    INTEGER NOT NULL DEFAULT 0,
        duplicated  INTEGER NOT NULL DEFAULT 0,
        invalid     INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS import_items (
        import_id  TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
        word_id    TEXT NOT NULL,
        PRIMARY KEY (import_id, word_id)
      );

      CREATE INDEX IF NOT EXISTS idx_import_items_word ON import_items(word_id);
      CREATE INDEX IF NOT EXISTS idx_imports_created   ON imports(created_at DESC);
    `,
  },
  {
    version: 3,
    sql: `
      CREATE TABLE IF NOT EXISTS dict_entries (
        id          INTEGER PRIMARY KEY,
        word        TEXT NOT NULL,
        normalized  TEXT NOT NULL,
        phonetic    TEXT NOT NULL DEFAULT '',
        definition  TEXT NOT NULL DEFAULT '',
        translation TEXT NOT NULL DEFAULT '',
        pos         TEXT NOT NULL DEFAULT '',
        collins     INTEGER NOT NULL DEFAULT 0,
        oxford      INTEGER NOT NULL DEFAULT 0,
        tag         TEXT NOT NULL DEFAULT '',
        bnc         INTEGER NOT NULL DEFAULT 0,
        frq         INTEGER NOT NULL DEFAULT 0,
        exchange    TEXT NOT NULL DEFAULT '',
        UNIQUE (normalized)
      );
    `,
  },
  {
    version: 4,
    sql: `
      ALTER TABLE dict_entries ADD COLUMN lemma TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_dict_lemma ON dict_entries(lemma) WHERE lemma <> '';
    `,
  },
  {
    version: 5,
    sql: `
      CREATE TABLE IF NOT EXISTS notes (
        id         TEXT PRIMARY KEY,
        word_id    TEXT REFERENCES words(id) ON DELETE CASCADE,
        headword   TEXT NOT NULL,
        normalized TEXT NOT NULL,
        content    TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notes_normalized ON notes(normalized);
      CREATE INDEX IF NOT EXISTS idx_notes_updated    ON notes(updated_at DESC);
    `,
  },
  {
    version: 6,
    sql: `
      CREATE TABLE IF NOT EXISTS review_cards (
        word_id       TEXT PRIMARY KEY REFERENCES words(id) ON DELETE CASCADE,
        book_id       TEXT NOT NULL,
        stage         INTEGER NOT NULL DEFAULT 0,
        ease          REAL NOT NULL DEFAULT 2.5,
        interval      INTEGER NOT NULL DEFAULT 0,
        due_at        TEXT NOT NULL,
        reps          INTEGER NOT NULL DEFAULT 0,
        lapses        INTEGER NOT NULL DEFAULT 0,
        last_rating   TEXT,
        last_rated_at TEXT,
        created_at    TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_due ON review_cards(due_at ASC);

      CREATE TABLE IF NOT EXISTS review_logs (
        id          INTEGER PRIMARY KEY,
        word_id     TEXT NOT NULL,
        book_id     TEXT NOT NULL,
        rating      TEXT NOT NULL,
        interval    INTEGER NOT NULL DEFAULT 0,
        reviewed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_review_logs_at   ON review_logs(reviewed_at ASC);
      CREATE INDEX IF NOT EXISTS idx_review_logs_word ON review_logs(word_id);
    `,
  },
];

let handle = null;

function getDb() {
  if (handle) return handle;
  fs.mkdirSync(path.dirname(DB_FILE), { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  migrate(db);
  seedIfEmpty(db);
  handle = db;
  return db;
}

function closeDb() {
  if (!handle) return;
  try {
    handle.close();
  } finally {
    handle = null;
  }
}

function migrate(db) {
  const row = db.prepare("PRAGMA user_version").get();
  let current = Number(row.user_version || 0);
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(migration.sql);
      db.exec(`PRAGMA user_version = ${migration.version}`);
      db.exec("COMMIT");
      current = migration.version;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }
  if (current !== SCHEMA_VERSION) {
    throw new Error(`数据库版本不匹配：期望 ${SCHEMA_VERSION}，实际 ${current}`);
  }
}

/** Runs fn inside a single write transaction. */
function transaction(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore rollback errors */
    }
    throw error;
  }
}

const SEED_BOOK_ID = "cet6-pdf";

function seedIfEmpty(db) {
  const { count } = db.prepare("SELECT COUNT(*) AS count FROM books").get();
  if (count > 0) return;
  if (!fs.existsSync(SEED_FILE)) {
    console.warn(`[db] 未找到 seed 文件，跳过初始化：${SEED_FILE}`);
    return;
  }
  const doc = JSON.parse(fs.readFileSync(SEED_FILE, "utf8"));
  const words = Array.isArray(doc.words) ? doc.words : [];
  if (!words.length) return;

  const now = new Date().toISOString();
  const insertBook = db.prepare(
    "INSERT INTO books (id, name, description, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
  );
  const insertWord = db.prepare(`
    INSERT INTO words (
      id, book_id, headword, normalized, phonetic_us, phonetic_uk, pos, translation,
      definition_en, exchange, tags, collins, frq, starred, starred_at, status, note,
      source, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', '', '', 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  transaction(db, () => {
    insertBook.run(
      SEED_BOOK_ID,
      doc.title || "大学英语六级词汇 · 乱序版",
      "由工作区 PDF 提取，共 2,084 个不重复单词",
      doc.source || "pdf",
      now,
      now,
    );
    let order = 0;
    for (const word of words) {
      order += 1;
      const headword = String(word.word || "").trim();
      if (!headword) continue;
      insertWord.run(
        String(word.id || `w${String(order).padStart(4, "0")}`),
        SEED_BOOK_ID,
        headword,
        normalizeWord(headword),
        String(word.phonetic || ""),
        String(word.phonetic || ""),
        String(word.pos || ""),
        String(word.meaning || ""),
        word.starred ? 1 : 0,
        word.starred ? now : null,
        ["new", "learning", "known"].includes(word.status) ? word.status : "new",
        String(word.note || ""),
        String(word.source || "pdf"),
        Number(word.order) || order,
        String(word.createdAt || now),
        now,
      );
    }
  });
  console.log(`[db] 已从 seed 初始化 ${words.length} 个单词`);
}

function normalizeWord(value) {
  return String(value || "").trim().toLowerCase();
}

function counts(db = getDb(), bookId = null) {
  const params = bookId ? [bookId] : [];
  const where = bookId ? "WHERE book_id = ?" : "";
  const row = db
    .prepare(
      `SELECT
         COUNT(*)                                        AS total,
         COALESCE(SUM(starred), 0)                       AS starred,
         COALESCE(SUM(status = 'known'), 0)              AS known,
         COALESCE(SUM(status = 'learning'), 0)           AS learning,
         COALESCE(SUM(status = 'new'), 0)                AS fresh,
         COALESCE(SUM(source = 'custom'), 0)             AS custom
       FROM words ${where}`,
    )
    .get(...params);
  return {
    total: Number(row.total),
    starred: Number(row.starred),
    known: Number(row.known),
    learning: Number(row.learning),
    new: Number(row.fresh),
    custom: Number(row.custom),
  };
}

module.exports = {
  ROOT,
  DATA_DIR,
  DB_FILE,
  SEED_FILE,
  SEED_BOOK_ID,
  SCHEMA_VERSION,
  getDb,
  closeDb,
  transaction,
  normalizeWord,
  counts,
};