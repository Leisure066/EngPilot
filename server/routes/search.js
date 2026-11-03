"use strict";

const { getDb } = require("../db");
const { httpError, intParam, cleanString } = require("../http");
const affixService = require("../services/affix");
const { pickBookId, toWord } = require("./words");

const ALL_SOURCES = ["book", "dict", "affix", "notes"];

function escapeLike(value) {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** Same range trick as /dict/suggest so the unique index is used. */
function prefixRange(prefix) {
  const lower = prefix.toLowerCase();
  const upper = lower.slice(0, -1) + String.fromCharCode(lower.charCodeAt(lower.length - 1) + 1);
  return [lower, upper];
}

/**
 * GET /api/v1/search?q=&sources=book,dict,affix,notes&limit=10
 * Aggregated local search for the search bar. "online" is planned for M5 and
 * is currently ignored.
 */
function search({ query }) {
  const db = getDb();
  const q = cleanString(query.get("q"), 80);
  if (!q) throw httpError("BAD_REQUEST", "请提供 q 参数");
  const limit = intParam(query, "limit", 10, { min: 1, max: 50 });
  const requested = (query.get("sources") || ALL_SOURCES.join(","))
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
  const sources = new Set(requested.filter((item) => ALL_SOURCES.includes(item)));
  if (!sources.size) throw httpError("BAD_REQUEST", `sources 只能是 ${ALL_SOURCES.join(" / ")}`);

  const bookId = cleanString(query.get("book"), 80) || pickBookId(db, null);
  const like = `%${escapeLike(q)}%`;
  const exact = q.toLowerCase();
  // 中文查询只走词书（2 千条，LIKE 很快）；词典表 340 万条没有中文索引，
  // 全表扫描会让输入卡顿，所以中文时跳过词典源。
  const hasCjk = /[\u3400-\u9fff]/.test(q);
  const data = { q, bookId, results: {}, total: 0 };

  if (sources.has("book")) {
    const rows = db
      .prepare(
        `SELECT * FROM words
         WHERE headword LIKE ? ESCAPE '\\' COLLATE NOCASE
            OR translation LIKE ? ESCAPE '\\'
            OR pos LIKE ? ESCAPE '\\'
         ORDER BY CASE WHEN LOWER(headword) = ? THEN 0 ELSE 1 END, LENGTH(headword), headword
         LIMIT ?`,
      )
      .all(like, like, like, exact, limit);
    const index = affixService.getIndex(db, bookId);
    data.results.book = rows.map((row) =>
      toWord(row, index.byWord.get(row.id) || []),
    );
    data.total += data.results.book.length;
  }

  if (sources.has("dict") && !hasCjk) {
    const [lower, upper] = prefixRange(q);
    const rows = db
      .prepare(
        `SELECT word, phonetic, translation, tag FROM dict_entries
         WHERE normalized >= ? AND normalized < ?
         ORDER BY LENGTH(word), word LIMIT ?`,
      )
      .all(lower, upper, limit);
    data.results.dict = rows.map((row) => ({
      word: row.word,
      phonetic: row.phonetic,
      translation: row.translation,
      tags: row.tag,
    }));
    data.total += data.results.dict.length;
  }

  if (sources.has("affix")) {
    const catalog = affixService.getCatalog();
    const lower = q.toLowerCase();
    const index = affixService.getIndex(db, bookId);
    const hits = [];
    for (const type of affixService.TYPES) {
      for (const item of catalog[type]) {
        const whole = item.key.includes(lower) || item.forms.some((form) => form.includes(lower));
        if (!whole) continue;
        const stat = index.stats.get(`${item.type}:${item.key}`) || { count: 0, examples: [] };
        hits.push({
          type,
          key: item.key,
          label: item.label,
          meaning: item.meaning,
          count: stat.count,
          examples: stat.examples,
          startsWith: item.key.startsWith(lower) || item.forms.some((form) => form.startsWith(lower)),
        });
      }
    }
    hits.sort((a, b) => Number(b.startsWith) - Number(a.startsWith) || b.count - a.count);
    data.results.affix = hits.slice(0, limit).map(({ startsWith, ...rest }) => rest);
    data.total += data.results.affix.length;
  }

  if (sources.has("notes")) {
    const rows = db
      .prepare(
        `SELECT * FROM notes
         WHERE content LIKE ? ESCAPE '\\' OR headword LIKE ? ESCAPE '\\'
         ORDER BY updated_at DESC LIMIT ?`,
      )
      .all(like, like, limit);
    data.results.notes = rows.map((row) => ({
      id: row.id,
      wordId: row.word_id || null,
      headword: row.headword,
      content: row.content,
      updatedAt: row.updated_at,
    }));
    data.total += data.results.notes.length;
  }

  return { data };
}

const routes = [
  { method: "GET", pattern: /^\/api\/v1\/search$/, handler: search },
];

module.exports = { routes };