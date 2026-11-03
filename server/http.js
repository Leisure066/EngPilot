"use strict";

const MAX_JSON_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 8 * 1024 * 1024;

class HttpError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const ERROR_STATUS = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  CONFLICT: 409,
  PAYLOAD_TOO_LARGE: 413,
  UNSUPPORTED_MEDIA_TYPE: 415,
  TOO_MANY_REQUESTS: 429,
  INTERNAL: 500,
  NOT_IMPLEMENTED: 501,
};

function httpError(code, message, details) {
  return new HttpError(ERROR_STATUS[code] || 500, code, message, details);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function sendData(res, data, meta) {
  const payload = meta === undefined ? { data } : { data, meta };
  sendJson(res, 200, payload);
}

function sendError(res, status, code, message, details) {
  sendJson(res, status, { error: { code, message, ...(details === undefined ? {} : { details }) } });
}

function sendErrorFromException(res, error) {
  if (error instanceof HttpError) {
    return sendError(res, error.status, error.code, error.message, error.details);
  }
  console.error("[http] unhandled error:", error);
  return sendError(res, 500, "INTERNAL", "服务器开小差了，请稍后重试");
}

async function readBody(req, { limit = MAX_JSON_BYTES, charset = "utf-8" } = {}) {
  const buffer = await readRawBody(req, { limit });
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return buffer.toString("utf8");
  }
}

/** Collects the raw body as a Buffer; the txt importer needs the bytes to guess encoding. */
function readRawBody(req, { limit = MAX_TEXT_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(httpError("PAYLOAD_TOO_LARGE", `请求内容超过 ${Math.round(limit / 1024)} KB 限制`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

async function readJsonBody(req) {
  const text = await readBody(req, { limit: MAX_JSON_BYTES });
  if (!text.trim()) return {};
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("not an object");
    }
    return parsed;
  } catch {
    throw httpError("BAD_REQUEST", "请求体不是合法的 JSON 对象");
  }
}

async function readTextBody(req) {
  return readBody(req, { limit: MAX_TEXT_BYTES });
}

/** RFC 3986-friendly query parser that survives `+` and `%2B`. */
function queryOf(url) {
  const parsed = new URL(url, "http://localhost");
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw httpError("BAD_REQUEST", "无效的请求路径");
  }
  return { pathname, params: parsed.searchParams, url: parsed };
}

function intParam(params, name, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || !Number.isInteger(value)) {
    throw httpError("BAD_REQUEST", `参数 ${name} 必须是整数`);
  }
  return Math.min(max, Math.max(min, value));
}

function boolParam(params, name, fallback = false) {
  const raw = params.get(name);
  if (raw === null || raw === "") return fallback;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw httpError("BAD_REQUEST", `参数 ${name} 必须是布尔值`);
}

function cleanString(value, max = 200) {
  return String(value ?? "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function requireString(value, field, { max = 200, allowEmpty = false } = {}) {
  const text = cleanString(value, max);
  if (!text && !allowEmpty) throw httpError("BAD_REQUEST", `${field} 不能为空`);
  return text;
}

function normalizePhonetic(value) {
  const raw = cleanString(value, 80);
  if (!raw) return "";
  const body = raw.replace(/^\/+|\/+$/g, "").trim();
  if (!body) return "";
  return `/${body}/`;
}

const ECDICT_PHONETIC_FIXES = [
  [/ә/g, "ə"], // Cyrillic schwa → IPA schwa
  [/:/g, "ː"], // ASCII length mark → IPA
  [/\^/g, "ʌ"],
  [/'/g, "ˈ"],
];

/**
 * ECDICT stores a legacy ASCII-ish IPA: "ә" for schwa, ":" for length,
 * "'" for primary stress and a leading "." for secondary stress.
 * Convert it to regular IPA so both the book and the dictionary look right.
 */
function normalizeEcdictPhonetic(value) {
  let text = cleanString(value, 120);
  if (!text) return "";
  text = text.replace(/^\/+|\/+$/g, "").trim();
  if (!text) return "";
  for (const [pattern, replacement] of ECDICT_PHONETIC_FIXES) text = text.replace(pattern, replacement);
  // Leading "," or "." marks secondary stress in ECDICT ("'rʌniŋ" vs ",serən'dipiti").
  text = text.replace(/^[,.]/, "ˌ").replace(/\./g, "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return `/${text}/`;
}

const WORD_RE = /^[A-Za-z][A-Za-z0-9'’\- ]*$/;

function normalizeHeadword(value) {
  const word = cleanString(value, 64);
  if (!word) throw httpError("BAD_REQUEST", "请输入单词");
  if (!WORD_RE.test(word)) {
    throw httpError("BAD_REQUEST", "单词只能包含英文字母、数字、空格、连字符或撇号");
  }
  return word;
}

function encodeCursor(offset) {
  return Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64url");
}

function decodeCursor(cursor) {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(String(cursor), "base64url").toString("utf8"));
    if (!Number.isInteger(parsed.o) || parsed.o < 0) throw new Error("bad cursor");
    return parsed.o;
  } catch {
    throw httpError("BAD_REQUEST", "cursor 参数无效");
  }
}

module.exports = {
  HttpError,
  httpError,
  sendJson,
  sendData,
  sendError,
  sendErrorFromException,
  readBody,
  readRawBody,
  readJsonBody,
  readTextBody,
  queryOf,
  intParam,
  boolParam,
  cleanString,
  requireString,
  normalizePhonetic,
  normalizeEcdictPhonetic,
  normalizeHeadword,
  encodeCursor,
  decodeCursor,
  MAX_JSON_BYTES,
  MAX_TEXT_BYTES,
};