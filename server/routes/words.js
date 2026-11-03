"use strict";

const crypto = require("node:crypto");
const { getDb, transaction, normalizeWord, counts } = require("../db");
const {
  httpError,
  sendJson,
  readJsonBody,
  intParam,
  boolParam,
  cleanString,
  normalizePhonetic,
  normalizeHeadword,
  encodeCursor,
  decodeCursor,
} = require("../http");

const affixService = require("../services/affix");

const STATUSES = new Set(["new", "learning", "known"]);

const SORTS = {
  order: "sort_order ASC, id ASC",
  az: "headword COLLATE NOCASE ASC, id ASC",
  recent: "created_at DESC, id DESC",
  starred: "starred DESC, starred_at DESC, id ASC",
};

/**
 * @param {object} row words table row
 * @param {Array|undefined} hints affix hints; undefined keeps the payload lean
 */
function toWord(row, hints) {
  const word = {
    id: row.id,
    bookId: row.book_id,
    headword: row.headword,
    phoneticUs: row.phonetic_us,
    phoneticUk: row.phonetic_uk,
    pos: row.pos,
    translation: row.translation,
    definitionEn: row.definition_en,
    exchange: row.exchange,
    tags: row.tags,
    collins: Number(row.collins),
    frq: Number(row.frq),
    starred: Boolean(row.starred),
    starredAt: row.starred_at || null,
    status: row.status,
    note: row.note,
    source: row.source,
    order: Number(row.sort_order),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (hints !== undefined) word.hints = hints;
  return word;
}

function pickBookId(db, requested) {
  if (requested) {
    const book = db.prepare("SELECT id FROM books WHERE id = ?").get(requested);
    if (!book) throw httpError("NOT_FOUND", `词书不存在：${requested}`);
    return requested;
  }
  const first = db.prepare("SELECT id FROM books ORDER BY created_at ASC LIMIT 1").get();
  if (!first) throw httpError("CONFLICT", "还没有任何词书，请先导入词库");
  return first.id;
}

function listWords({ query }) {
  const db = getDb();
  const limit = intParam(query, "limit", 50, { min: 1, max: 200 });
  const offset = decodeCursor(query.get("cursor"));
  const sort = query.get("sort") || "order";
  if (!SORTS[sort]) throw httpError("BAD_REQUEST", `不支持的排序方式：${sort}`);

  const bookId = query.get("book") || "";
  const q = cleanString(query.get("q"), 80);
  const status = query.get("status") || "";
  if (status && !STATUSES.has(status)) throw httpError("BAD_REQUEST", `未知状态：${status}`);
  const starred = query.has("starred") ? boolParam(query, "starred") : null;

  const where = [];
  const args = [];
  if (bookId) {
    where.push("book_id = ?");
    args.push(bookId);
  }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
    where.push("(headword LIKE ? ESCAPE '\\' OR translation LIKE ? ESCAPE '\\' OR pos LIKE ? ESCAPE '\\')");
    args.push(like, like, like);
  }
  if (status) {
    where.push("status = ?");
    args.push(status);
  }
  if (starred !== null) {
    where.push("starred = ?");
    args.push(starred ? 1 : 0);
  }
  const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

  const withHints = boolParam(query, "hints", true);
  const affixTokens = query
    .getAll("affix")
    .flatMap((value) => value.split(","))
    .map((value) => value.trim())
    .filter(Boolean);
  const affixMode = (query.get("affixMode") || "and").toLowerCase() === "or" ? "or" : "and";

  let total;
  let rows;
  let pageRows;
  if (affixTokens.length) {
    // The index lives per book, so an affix query always needs a concrete book.
    const indexBook = bookId || pickBookId(db, null);
    const index = affixService.getIndex(db, indexBook);
    const ids = new Set(affixService.filterWordIds(index, affixTokens, affixMode) || []);
    rows = db
      .prepare(`SELECT * FROM words ${whereSql} ORDER BY ${SORTS[sort]}`)
      .all(...args)
      .filter((row) => ids.has(row.id));
    total = rows.length;
    pageRows = rows.slice(offset, offset + limit);
    const hasMore = offset + limit < total;
    return {
      data: { words: pageRows.map((row) => toWord(row, withHints ? index.byWord.get(row.id) || [] : undefined)) },
      meta: {
        total,
        limit,
        hasMore,
        nextCursor: hasMore ? encodeCursor(offset + limit) : null,
        sort,
        affix: affixTokens,
        affixMode,
      },
    };
  }

  total = Number(db.prepare(`SELECT COUNT(*) AS n FROM words ${whereSql}`).get(...args).n);
  rows = db
    .prepare(`SELECT * FROM words ${whereSql} ORDER BY ${SORTS[sort]} LIMIT ? OFFSET ?`)
    .all(...args, limit + 1, offset);

  const hasMore = rows.length > limit;
  const pageRowsRaw = rows.slice(0, limit);
  const index = withHints ? affixService.getIndex(db, bookId || pickBookId(db, null)) : null;
  const page = pageRowsRaw.map((row) =>
    toWord(
      row,
      withHints ? index.byWord.get(row.id) || affixService.analyseWord(row.headword) : undefined,
    ),
  );
  return {
    data: { words: page },
    meta: {
      total,
      limit,
      hasMore,
      nextCursor: hasMore ? encodeCursor(offset + limit) : null,
      sort,
    },
  };
}

function getWord({ params }) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM words WHERE id = ?").get(params.id);
  if (!row) throw httpError("NOT_FOUND", "没有找到这个单词");
  return { data: toWord(row, affixService.analyseWord(row.headword)) };
}

function findDuplicate(db, bookId, normalized, exceptId) {
  return db
    .prepare("SELECT * FROM words WHERE book_id = ? AND normalized = ? AND id <> ?")
    .get(bookId, normalized, exceptId || "");
}

async function createWord({ req }) {
  const body = await readJsonBody(req);
  const db = getDb();
  const bookId = pickBookId(db, cleanString(body.bookId, 80));
  const headword = normalizeHeadword(body.word ?? body.headword);
  const normalized = normalizeWord(headword);

  const duplicate = findDuplicate(db, bookId, normalized);
  if (duplicate) {
    throw httpError("CONFLICT", `“${duplicate.headword}” 已经在词库中了`, {
      existing: toWord(duplicate),
    });
  }

  const now = new Date().toISOString();
  const status = STATUSES.has(body.status) ? body.status : "new";
  const starred = Boolean(body.starred);
  const maxOrder = Number(
    db.prepare("SELECT COALESCE(MAX(sort_order), 0) AS n FROM words WHERE book_id = ?").get(bookId).n,
  );
  const id = `c_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;

  db.prepare(
    `INSERT INTO words (
       id, book_id, headword, normalized, phonetic_us, phonetic_uk, pos, translation,
       definition_en, exchange, tags, collins, frq, starred, starred_at, status, note,
       source, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'custom', ?, ?, ?)`,
  ).run(
    id,
    bookId,
    headword,
    normalized,
    normalizePhonetic(body.phoneticUs ?? body.phonetic),
    normalizePhonetic(body.phoneticUk),
    cleanString(body.pos, 40),
    cleanString(body.translation ?? body.meaning, 300),
    cleanString(body.definitionEn, 1000),
    cleanString(body.exchange, 300),
    cleanString(body.tags, 120),
    Number.isFinite(Number(body.collins)) ? Number(body.collins) : 0,
    Number.isFinite(Number(body.frq)) ? Number(body.frq) : 0,
    starred ? 1 : 0,
    starred ? now : null,
    status,
    cleanString(body.note, 300),
    maxOrder + 1,
    now,
    now,
  );

  const row = db.prepare("SELECT * FROM words WHERE id = ?").get(id);
  return { status: 201, payload: { data: toWord(row, affixService.analyseWord(row.headword)) } };
}

async function updateWord({ req, params }) {
  const body = await readJsonBody(req);
  const db = getDb();
  const current = db.prepare("SELECT * FROM words WHERE id = ?").get(params.id);
  if (!current) throw httpError("NOT_FOUND", "没有找到这个单词");

  const sets = [];
  const args = [];
  const now = new Date().toISOString();

  if (body.word !== undefined || body.headword !== undefined) {
    const headword = normalizeHeadword(body.word ?? body.headword);
    const normalized = normalizeWord(headword);
    const duplicate = findDuplicate(db, current.book_id, normalized, current.id);
    if (duplicate) {
      throw httpError("CONFLICT", `“${duplicate.headword}” 已经在词库中了`, {
        existing: toWord(duplicate),
      });
    }
    sets.push("headword = ?", "normalized = ?");
    args.push(headword, normalized);
  }
  if (body.phoneticUs !== undefined || body.phonetic !== undefined) {
    sets.push("phonetic_us = ?");
    args.push(normalizePhonetic(body.phoneticUs ?? body.phonetic));
  }
  if (body.phoneticUk !== undefined) {
    sets.push("phonetic_uk = ?");
    args.push(normalizePhonetic(body.phoneticUk));
  }
  if (body.pos !== undefined) {
    sets.push("pos = ?");
    args.push(cleanString(body.pos, 40));
  }
  if (body.translation !== undefined || body.meaning !== undefined) {
    sets.push("translation = ?");
    args.push(cleanString(body.translation ?? body.meaning, 300));
  }
  if (body.definitionEn !== undefined) {
    sets.push("definition_en = ?");
    args.push(cleanString(body.definitionEn, 1000));
  }
  if (body.exchange !== undefined) {
    sets.push("exchange = ?");
    args.push(cleanString(body.exchange, 300));
  }
  if (body.tags !== undefined) {
    sets.push("tags = ?");
    args.push(cleanString(body.tags, 120));
  }
  if (body.note !== undefined) {
    sets.push("note = ?");
    args.push(cleanString(body.note, 300));
  }
  if (body.status !== undefined) {
    if (!STATUSES.has(body.status)) throw httpError("BAD_REQUEST", `未知状态：${body.status}`);
    sets.push("status = ?");
    args.push(body.status);
  }
  if (body.starred !== undefined) {
    const starred = Boolean(body.starred);
    const wasStarred = Boolean(current.starred);
    sets.push("starred = ?", "starred_at = ?");
    args.push(starred ? 1 : 0, starred ? (wasStarred && current.starred_at ? current.starred_at : now) : null);
  }

  if (!sets.length) throw httpError("BAD_REQUEST", "没有需要更新的字段");

  sets.push("updated_at = ?");
  args.push(now, current.id);
  db.prepare(`UPDATE words SET ${sets.join(", ")} WHERE id = ?`).run(...args);

  const row = db.prepare("SELECT * FROM words WHERE id = ?").get(current.id);
  return { data: toWord(row, affixService.analyseWord(row.headword)) };
}

function deleteWord({ params }) {
  const db = getDb();
  const row = db.prepare("SELECT * FROM words WHERE id = ?").get(params.id);
  if (!row) throw httpError("NOT_FOUND", "没有找到这个单词");
  db.prepare("DELETE FROM words WHERE id = ?").run(params.id);
  return { data: { id: row.id, headword: row.headword, deleted: true } };
}

async function batchDelete({ req }) {
  const body = await readJsonBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => cleanString(id, 80)).filter(Boolean) : [];
  if (!ids.length) throw httpError("BAD_REQUEST", "ids 不能为空");
  if (ids.length > 500) throw httpError("BAD_REQUEST", "一次最多删除 500 个单词");

  const db = getDb();
  const result = transaction(db, () => {
    const stmt = db.prepare("DELETE FROM words WHERE id = ?");
    let deleted = 0;
    for (const id of [...new Set(ids)]) {
      deleted += Number(stmt.run(id).changes || 0);
    }
    return deleted;
  });
  return { data: { requested: ids.length, deleted: result } };
}

async function batchStar({ req }) {
  const body = await readJsonBody(req);
  const ids = Array.isArray(body.ids) ? body.ids.map((id) => cleanString(id, 80)).filter(Boolean) : [];
  if (!ids.length) throw httpError("BAD_REQUEST", "ids 不能为空");
  if (ids.length > 500) throw httpError("BAD_REQUEST", "一次最多操作 500 个单词");
  const starred = Boolean(body.starred);
  const now = new Date().toISOString();

  const db = getDb();
  const changed = transaction(db, () => {
    const stmt = db.prepare(
      "UPDATE words SET starred = ?, starred_at = CASE WHEN ? = 1 THEN COALESCE(starred_at, ?) ELSE NULL END, updated_at = ? WHERE id = ?",
    );
    let total = 0;
    for (const id of [...new Set(ids)]) {
      total += Number(stmt.run(starred ? 1 : 0, starred ? 1 : 0, now, now, id).changes || 0);
    }
    return total;
  });
  return { data: { requested: ids.length, updated: changed, starred } };
}

function hashString(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function localDateString(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * Deterministic daily queue: same date + book always yields the same words,
 * so the client can cache progress in localStorage without losing sync.
 */
function dailyWords({ query }) {
  const db = getDb();
  const date = cleanString(query.get("date"), 20) || localDateString();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw httpError("BAD_REQUEST", "date 必须是 YYYY-MM-DD 格式");
  const size = intParam(query, "size", 20, { min: 1, max: 100 });
  const bookId = query.get("book") || pickBookId(db, null);

  const rows = db
    .prepare("SELECT * FROM words WHERE book_id = ? ORDER BY sort_order ASC, id ASC")
    .all(bookId);
  if (!rows.length) return { data: { date, size, bookId, words: [] } };

  const random = mulberry32(hashString(`${date}::${bookId}`));
  const pool = rows.slice();
  for (let i = pool.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  const picked = pool.slice(0, Math.min(size, pool.length)).map(toWord);
  return { data: { date, size: picked.length, bookId, words: picked } };
}

function listBooks() {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM words w WHERE w.book_id = b.id) AS words
       FROM books b ORDER BY b.created_at ASC`,
    )
    .all();
  return {
    data: {
      books: rows.map((row) => ({
        id: row.id,
        name: row.name,
        description: row.description,
        source: row.source,
        wordCount: Number(row.words),
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })),
    },
  };
}

function meta() {
  const db = getDb();
  const books = db.prepare("SELECT COUNT(*) AS n FROM books").get().n;
  const due = Number(
    db.prepare("SELECT COUNT(*) AS n FROM review_cards WHERE due_at <= ?").get(new Date().toISOString()).n,
  );
  return { data: { books: Number(books), counts: counts(db), review: { due } } };
}

const routes = [
  { method: "GET", pattern: /^\/api\/v1\/meta$/, handler: meta },
  { method: "GET", pattern: /^\/api\/v1\/books$/, handler: listBooks },
  { method: "GET", pattern: /^\/api\/v1\/words$/, handler: listWords },
  { method: "POST", pattern: /^\/api\/v1\/words$/, handler: createWord },
  { method: "POST", pattern: /^\/api\/v1\/words\/batch-delete$/, handler: batchDelete },
  { method: "POST", pattern: /^\/api\/v1\/words\/batch-star$/, handler: batchStar },
  { method: "GET", pattern: /^\/api\/v1\/words\/daily$/, handler: dailyWords },
  { method: "GET", pattern: /^\/api\/v1\/words\/([^/]+)$/, params: ["id"], handler: getWord },
  { method: "PATCH", pattern: /^\/api\/v1\/words\/([^/]+)$/, params: ["id"], handler: updateWord },
  { method: "DELETE", pattern: /^\/api\/v1\/words\/([^/]+)$/, params: ["id"], handler: deleteWord },
];

module.exports = { routes, toWord, pickBookId };