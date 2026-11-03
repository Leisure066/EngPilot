/* 没有 git 时，按 .gitignore 规则粗算哪些文件会被提交。
   用法：node .runtime/simulate-gitignore.js <repoRoot> */
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(process.argv[2] || ".");
const rules = fs
  .readFileSync(path.join(root, ".gitignore"), "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"));

function toRegex(rule) {
  const dirOnly = rule.endsWith("/");
  const body = dirOnly ? rule.slice(0, -1) : rule;
  let pattern = body
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "\u0000")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, ".*")
    .replace(/\?/g, "[^/]");
  if (dirOnly) pattern += "(/|$)";
  return new RegExp(`^${pattern}$`);
}

const matchers = rules.map((rule) => ({ dirOnly: rule.endsWith("/"), regex: toRegex(rule) }));

function isIgnored(relPath, isDirectory) {
  const base = path.basename(relPath);
  const segments = relPath.split("/");
  for (const { dirOnly, regex } of matchers) {
    if (dirOnly) {
      // 命中自身或任一祖先目录即忽略
      for (let i = 1; i <= segments.length; i += 1) {
        if (regex.test(segments.slice(0, i).join("/"))) return true;
      }
    } else if (regex.test(relPath) || regex.test(base)) {
      return true;
    }
  }
  return false;
}

const keep = [];
const skipped = { files: 0, bytes: 0 };

function walk(dir, prefix) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === ".git") continue;
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    const full = path.join(dir, entry.name);
    if (isIgnored(rel, entry.isDirectory())) {
      if (entry.isFile()) {
        skipped.files += 1;
        skipped.bytes += fs.statSync(full).size;
      }
      continue;
    }
    if (entry.isDirectory()) walk(full, rel);
    else keep.push({ rel, size: fs.statSync(full).size });
  }
}

walk(root, "");

const total = keep.reduce((sum, item) => sum + item.size, 0);
console.log(`会提交：${keep.length} 个文件，${(total / 1024 / 1024).toFixed(2)} MB`);
console.log(`被忽略：${skipped.files} 个文件，${(skipped.bytes / 1024 / 1024).toFixed(0)} MB`);
console.log("\n最大的 6 个：");
keep
  .sort((a, b) => b.size - a.size)
  .slice(0, 6)
  .forEach((item) => console.log(`  ${(item.size / 1024).toFixed(0).padStart(6)} KB  ${item.rel}`));

const oversize = keep.filter((item) => item.size > 100 * 1024 * 1024);
if (oversize.length) {
  console.error("\n超过 GitHub 单文件 100 MB 限制：", oversize.map((i) => i.rel));
  process.exit(1);
}
console.log("\n没有超过 100 MB 的文件 ✓");