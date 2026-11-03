"use strict";

const crypto = require("node:crypto");
const { getDb, transaction, normalizeWord } = require("../db");
const {
  httpError,
  readJsonBody,
  intParam,
  cleanString,
  encodeCursor,
  decodeCursor,
} = require("../http");

const MAX_CONTENT = 5000;

function toNote(row) {
  return {
    id: row.id,
    wordId: row.word_id || null,
    headword: row.headword,
    normalized: row.normalized,
    content: row.content,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function newId() {
  return `note_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

/**
 * GET /api/v1/notes?word=&q=&limit=&cursor=
 * - no filter: the notebook page (most recently updated first)
 * - ?word= : notes attached to one word (newest first)
 * - ?q=    : full text search over content and headword
 */
function listNotes({ query }) {
  const db = getDb();
  const limit = intParam(query, "limit", 50, { min: 1, max: 200 });
  const offset = decodeCursor(query.get("cursor"));
  const word = cleanString(query.get("word"), 120);
  const q = cleanString(query.get("q"), 80);

  const where = [];
  const args = [];
  if (word) {
    where.push("normalized = ?");
    args.push(normalizeWord(word));
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(content LIKE ? ESCAPE '\\' OR headword LIKE ? ESCAPE '\\')");
    args.push(like, like);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const orderSql = q ? "updated_at DESC, id DESC" : "created_at DESC, id DESC";

  const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM notes ${whereSql}`).get(...args).n);
  const rows = db
    .prepare(`SELECT * FROM notes ${whereSql} ORDER BY ${orderSql} LIMIT ? OFFSET ?`)
    .all(...args, limit + 1, offset);

  const hasMore = rows.length > limit;
  return {
    data: { notes: rows.slice(0, limit).map(toNote) },
    meta: {
      total,
      limit,
      hasMore,
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
      word: word || null,
      q: q || null,
    },
  };
}

async function createNote({ req }) {
  const body = await readJsonBody(req);
  const content = cleanString(body.content, MAX_CONTENT);
  if (!content) throw httpError("BAD_REQUEST", "笔记内容不能为空");

  const db = getDb();
  const wordId = cleanString(body.wordId, 80);
  let headword = "";
  let normalized = "";

  if (wordId) {
    const word = db.prepare("SELECT * FROM words WHERE id = ?").get(wordId);
    if (!word) throw httpError("NOT_FOUND", `词条不存在：${wordId}`);
    headword = word.headword;
    normalized = word.normalized;
  } else {
    headword = cleanString(body.headword, 120);
    if (!headword) throw httpError("BAD_REQUEST", "请提供 wordId 或 headword");
    normalized = normalizeWord(headword);
  }

  const now = new Date().toISOString();
  const id = newId();
  db.prepare(
    `INSERT INTO notes (id, word_id, headword, normalized, content, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, wordId || null, headword, normalized, content, now, now);

  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(id);
  return { status: 201, payload: { data: toNote(row) } };
}

async function updateNote({ req, params }) {
  const body = await readJsonBody(req);
  const db = getDb();
  const current = db.prepare("SELECT * FROM notes WHERE id = ?").get(params.id);
  if (!current) throw httpError("NOT_FOUND", "笔记不存在");

  const content = cleanString(body.content, MAX_CONTENT);
  if (!content) throw httpError("BAD_REQUEST", "笔记内容不能为空");

  const now = new Date().toISOString();
  db.prepare("UPDATE notes SET content = ?, updated_at = ? WHERE id = ?").run(content, now, current.id);
  const row = db.prepare("SELECT * FROM notes WHERE id = ?").get(current.id);
  return { data: toNote(row) };
}

function deleteNote({ params }) {
  const db = getDb();
  const current = db.prepare("SELECT * FROM notes WHERE id = ?").get(params.id);
  if (!current) throw httpError("NOT_FOUND", "笔记不存在");
  db.prepare("DELETE FROM notes WHERE id = ?").run(current.id);
  return { data: { id: current.id, deleted: true } };
}

function noteStats() {
  const db = getDb();
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM notes").get().n);
  const words = Number(db.prepare("SELECT COUNT(DISTINCT normalized) AS n FROM notes").get().n);
  const since = new Date(Date.now() - 7 * 86400000).toISOString();
  const recent = Number(db.prepare("SELECT COUNT(*) AS n FROM notes WHERE created_at >= ?").get(since).n);
  return { data: { total, words, recentWeek: recent } };
}

const routes = [
  { method: "GET", pattern: /^\/api\/v1\/notes$/, handler: listNotes },
  { method: "GET", pattern: /^\/api\/v1\/notes\/stats$/, handler: noteStats },
  { method: "POST", pattern: /^\/api\/v1\/notes$/, handler: createNote },
  { method: "PATCH", pattern: /^\/api\/v1\/notes\/([^/]+)$/, params: ["id"], handler: updateNote },
  { method: "DELETE", pattern: /^\/api\/v1\/notes\/([^/]+)$/, params: ["id"], handler: deleteNote },
];

module.exports = { routes };