"use strict";

const { getDb } = require("../db");
const {
  httpError,
  readRawBody,
  intParam,
  boolParam,
  cleanString,
} = require("../http");
const { parseTxt, MAX_LINES } = require("../importers/txt");
const importer = require("../services/importer");
const { pickBookId } = require("./words");

function resolveBook(db, query) {
  return pickBookId(db, cleanString(query.get("book"), 80) || null);
}

function previewPayload(bookId, parsed, analysis, mode) {
  const preview = [];
  const push = (entry, action, extra = {}) => {
    if (preview.length >= 20) return;
    preview.push({
      line: entry.line,
      headword: entry.headword,
      translation: entry.translation,
      phonetic: entry.phonetic,
      pos: entry.pos,
      action,
      ...extra,
    });
  };
  for (const entry of analysis.toInsert) push(entry, "insert");
  for (const pair of analysis.toEnrich) push(pair.entry, "enrich", { existingId: pair.existing.id });
  for (const pair of analysis.duplicates) push(pair.entry, "duplicate", { existingId: pair.existing.id });
  for (const entry of analysis.batchDuplicates.slice(0, 5)) push(entry, "batch-duplicate");

  return {
    data: {
      bookId,
      mode,
      encoding: parsed.encoding,
      totalLines: parsed.totalLines,
      total: analysis.unique.length + analysis.batchDuplicates.length,
      new: analysis.toInsert.length,
      enrichable: analysis.toEnrich.length,
      duplicates: analysis.duplicates.length,
      batchDuplicates: analysis.batchDuplicates.length,
      invalid: parsed.invalid.length,
      truncated: parsed.truncated,
      preview,
      errors: parsed.invalid.slice(0, 20),
    },
  };
}

async function importWords({ req, query }) {
  const db = getDb();
  const bookId = resolveBook(db, query);
  const dryRun = boolParam(query, "dryRun", false);
  const mode = (query.get("mode") || "merge").toLowerCase();
  if (!importer.MODES.has(mode)) throw httpError("BAD_REQUEST", "mode 只能是 merge 或 skip");
  const filename = cleanString(query.get("filename"), 120);

  const buffer = await readRawBody(req);
  if (!buffer.length) throw httpError("BAD_REQUEST", "请求体为空，请上传 txt 内容");

  const parsed = parseTxt(buffer);
  if (!parsed.entries.length) {
    throw httpError("BAD_REQUEST", "没有解析出任何单词", {
      encoding: parsed.encoding,
      totalLines: parsed.totalLines,
      errors: parsed.invalid.slice(0, 20),
    });
  }
  if (parsed.truncated) {
    throw httpError("PAYLOAD_TOO_LARGE", `一次最多导入 ${MAX_LINES} 行，请拆分文件后重试`);
  }

  if (dryRun) {
    const analysis = importer.analyse(db, { bookId, entries: parsed.entries, mode });
    return previewPayload(bookId, parsed, analysis, mode);
  }

  const result = importer.perform(db, {
    bookId,
    parsed,
    mode,
    filename,
    encoding: parsed.encoding,
  });
  return { status: 201, payload: { data: result } };
}

function listImports({ query }) {
  const db = getDb();
  const limit = intParam(query, "limit", 50, { min: 1, max: 200 });
  const rows = importer.list(db, limit);
  return {
    data: {
      imports: rows.map((row) => ({
        id: row.id,
        bookId: row.book_id,
        filename: row.filename,
        encoding: row.encoding,
        mode: row.mode,
        total: Number(row.total),
        inserted: Number(row.inserted),
        enriched: Number(row.enriched),
        duplicated: Number(row.duplicated),
        invalid: Number(row.invalid),
        createdAt: row.created_at,
      })),
    },
  };
}

function rollbackImport({ params }) {
  const db = getDb();
  const result = importer.rollback(db, params.id);
  if (!result) throw httpError("NOT_FOUND", "没有找到这个导入批次");
  return { data: result };
}

const routes = [
  { method: "POST", pattern: /^\/api\/v1\/words\/import$/, handler: importWords },
  { method: "GET", pattern: /^\/api\/v1\/imports$/, handler: listImports },
  { method: "POST", pattern: /^\/api\/v1\/imports\/([^/]+)\/rollback$/, params: ["id"], handler: rollbackImport },
];

module.exports = { routes, importWords };