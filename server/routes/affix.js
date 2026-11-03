"use strict";

const { getDb } = require("../db");
const { httpError, intParam, encodeCursor, decodeCursor, cleanString, boolParam } = require("../http");
const affixService = require("../services/affix");
const { pickBookId, toWord } = require("./words");

function resolveBook(db, query) {
  return pickBookId(db, cleanString(query.get("book"), 80) || null);
}

function catalogResponse({ query }) {
  const db = getDb();
  const type = cleanString(query.get("type"), 20).toLowerCase();
  if (type && !affixService.TYPES.includes(type)) {
    throw httpError("BAD_REQUEST", `type 只能是 ${affixService.TYPES.join(" / ")}`);
  }
  const bookId = resolveBook(db, query);
  const index = affixService.getIndex(db, bookId);
  const catalog = affixService.getCatalog();

  const build = (name) =>
    catalog[name].map((item) => {
      const stat = index.stats.get(`${item.type}:${item.key}`) || { count: 0, examples: [] };
      return {
        key: item.key,
        label: item.label,
        meaning: item.meaning,
        forms: item.forms,
        count: stat.count,
        examples: stat.examples,
      };
    });

  if (type) return { data: { type, bookId, affixes: build(type) } };
  return {
    data: {
      bookId,
      prefixes: build("prefix"),
      suffixes: build("suffix"),
      roots: build("root"),
    },
  };
}

function affixWords({ query, params }) {
  const db = getDb();
  const type = params.type;
  if (!affixService.TYPES.includes(type)) {
    throw httpError("BAD_REQUEST", `type 只能是 ${affixService.TYPES.join(" / ")}`);
  }
  const catalog = affixService.getCatalog();
  const item = catalog[type].find((entry) => entry.key === params.key);
  if (!item) throw httpError("NOT_FOUND", `没有这个词缀：${type}:${params.key}`);

  const bookId = resolveBook(db, query);
  const index = affixService.getIndex(db, bookId);
  const limit = intParam(query, "limit", 50, { min: 1, max: 200 });
  const offset = decodeCursor(query.get("cursor"));
  const withHints = boolParam(query, "hints", true);

  const ids = affixService.filterWordIds(index, [`${type}:${item.key}`], "and") || [];
  const pageIds = ids.slice(offset, offset + limit);
  const stmt = db.prepare("SELECT * FROM words WHERE id = ?");
  const words = pageIds
    .map((id) => stmt.get(id))
    .filter(Boolean)
    .map((row) => toWord(row, withHints ? index.byWord.get(row.id) || [] : undefined));

  return {
    data: {
      type,
      affix: { key: item.key, label: item.label, meaning: item.meaning, forms: item.forms },
      bookId,
      words,
    },
    meta: {
      total: ids.length,
      limit,
      hasMore: offset + limit < ids.length,
      nextCursor: offset + limit < ids.length ? encodeCursor(offset + limit) : null,
    },
  };
}

function matchWord({ query }) {
  const word = cleanString(query.get("word"), 64);
  if (!word) throw httpError("BAD_REQUEST", "请提供 word 参数");
  const hints = affixService.analyseWord(word);
  return { data: { word, hints, ...affixService.groupHints(hints) } };
}

const routes = [
  { method: "GET", pattern: /^\/api\/v1\/affixes$/, handler: catalogResponse },
  { method: "GET", pattern: /^\/api\/v1\/affixes\/match$/, handler: matchWord },
  {
    method: "GET",
    pattern: /^\/api\/v1\/affixes\/([a-z]+)\/([^/]+)\/words$/,
    params: ["type", "key"],
    handler: affixWords,
  },
];

module.exports = { routes };