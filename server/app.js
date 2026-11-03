"use strict";

const http = require("node:http");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

const { ROOT, DB_FILE, SEED_BOOK_ID, getDb, closeDb } = require("./db");
const {
  httpError,
  sendJson,
  sendError,
  sendErrorFromException,
  queryOf,
} = require("./http");
const { routes: wordRoutes } = require("./routes/words");
const { routes: importRoutes } = require("./routes/import");
const { routes: affixRoutes } = require("./routes/affix");
const { routes: dictRoutes } = require("./routes/dict");
const { routes: notesRoutes } = require("./routes/notes");
const { routes: searchRoutes } = require("./routes/search");
const { routes: reviewRoutes } = require("./routes/review");
const { scanInbox } = require("./inbox");

const PUBLIC_DIR = path.join(ROOT, "public");
const VERSION = "1.0.0";
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

const ROUTES = [
  {
    method: "GET",
    pattern: /^\/api\/v1\/health$/,
    handler: () => ({ data: { ok: true, version: VERSION, db: DB_FILE } }),
  },
  ...importRoutes,
  ...affixRoutes,
  ...dictRoutes,
  ...searchRoutes,
  ...notesRoutes,
  ...reviewRoutes,
  ...wordRoutes,
];

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) return;
  let allowed = false;
  try {
    const { hostname, protocol } = new URL(origin);
    allowed =
      (protocol === "http:" || protocol === "https:") &&
      (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]");
  } catch {
    allowed = false;
  }
  if (!allowed) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}

function matchRoute(method, pathname) {
  const matched = [];
  for (const route of ROUTES) {
    const match = route.pattern.exec(pathname);
    if (!match) continue;
    matched.push({ route, match });
    if (route.method !== method) continue;
    const params = {};
    (route.params || []).forEach((name, index) => {
      params[name] = match[index + 1];
    });
    return { route, params };
  }
  if (matched.length) throw httpError("METHOD_NOT_ALLOWED", `${method} 不支持这个接口`);
  return null;
}

async function serveStatic(req, res, pathname) {
  let relative = pathname;
  if (relative === "/") relative = "/index.html";
  const filePath = path.resolve(PUBLIC_DIR, `.${relative}`);
  if (!filePath.startsWith(`${PUBLIC_DIR}${path.sep}`) && filePath !== PUBLIC_DIR) {
    return sendError(res, 403, "FORBIDDEN", "禁止访问");
  }
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
      "Content-Length": stat.size,
    });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(filePath).pipe(res);
  } catch {
    if (pathname.includes(".")) {
      return sendError(res, 404, "NOT_FOUND", "文件不存在");
    }
    const index = path.join(PUBLIC_DIR, "index.html");
    try {
      const html = await fsp.readFile(index);
      res.writeHead(200, { "Content-Type": MIME[".html"], "Cache-Control": "no-cache" });
      return res.end(html);
    } catch {
      return sendError(res, 404, "NOT_FOUND", "前端页面尚未就绪（public/index.html 不存在）");
    }
  }
}

async function handle(req, res) {
  const { pathname, params: query } = queryOf(req.url);
  applyCors(req, res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  if (pathname.startsWith("/api/")) {
    const found = matchRoute(req.method, pathname);
    if (!found) throw httpError("NOT_FOUND", "接口不存在");
    const result = await found.route.handler({
      req,
      res,
      pathname,
      query,
      params: found.params,
    });
    if (!result) {
      if (!res.headersSent) sendError(res, 500, "INTERNAL", "接口没有返回数据");
      return undefined;
    }
    if (result.status && result.payload) return sendJson(res, result.status, result.payload);
    return sendJson(res, 200, result);
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return sendError(res, 405, "METHOD_NOT_ALLOWED", "静态资源只支持 GET / HEAD");
  }
  return serveStatic(req, res, pathname);
}

function createServer() {
  getDb();
  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    try {
      await handle(req, res);
    } catch (error) {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendErrorFromException(res, error);
    }
  });
  server.on("close", () => closeDb());
  return server;
}

if (require.main === module) {
  const port = Number(process.env.PORT || 5188);
  const host = process.env.HOST || "127.0.0.1";
  const server = createServer();
  server.listen(port, host, () => {
    console.log(`EngPilot API http://${host}:${port}`);
    console.log(`数据库：${DB_FILE}`);
    console.log(`默认词书：${SEED_BOOK_ID}`);
    try {
      const results = scanInbox(getDb());
      for (const result of results) {
        if (result.error) console.warn(`[inbox] ${result.file} 导入失败：${result.error}`);
        else if (result.skipped) console.warn(`[inbox] ${result.file} 跳过：${result.reason}`);
        else
          console.log(
            `[inbox] ${result.file}：新增 ${result.inserted}，补全 ${result.enriched}，重复 ${result.duplicated}，错误 ${result.invalid}`,
          );
      }
    } catch (error) {
      console.warn(`[inbox] 扫描失败：${error.message}`);
    }
  });
  const shutdown = () => {
    console.log("\n[server] 正在关闭…");
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = { createServer, ROUTES, PUBLIC_DIR };