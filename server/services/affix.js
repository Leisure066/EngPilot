"use strict";

/**
 * Affix (prefix / suffix / root) catalogue and word decomposition.
 *
 * Matching is lexical, not etymological: "reproduction" is split because it
 * literally starts with re- and ends with -tion. Every match carries a
 * confidence level so the UI can flag the shaky ones instead of pretending
 * everything is a real morpheme boundary.
 */

const fs = require("node:fs");
const path = require("node:path");

const TYPES = ["prefix", "suffix", "root"];
const FILE = path.join(__dirname, "..", "data", "affixes.json");

let catalog = null;
const INDEX_CACHE = new Map();

function getCatalog() {
  if (catalog) return catalog;
  const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
  catalog = { prefix: doc.prefixes || [], suffix: doc.suffixes || [], root: doc.roots || [] };
  for (const type of TYPES) {
    for (const item of catalog[type]) item.type = type;
  }
  return catalog;
}

function allAffixes() {
  const current = getCatalog();
  return TYPES.flatMap((type) => current[type]);
}

function minStemFor(form, type) {
  if (type === "prefix") return form.length <= 2 ? 4 : 3;
  if (type === "suffix") return 3;
  return 2;
}

function scorePrefixOrSuffix(stemLength, formLength) {
  // A longer prefix/suffix is more specific ("inter-" wins over "in-"),
  // then a longer stem means the boundary is more likely to be real.
  return formLength * 10 + Math.min(stemLength, 6);
}

function confidenceFor(type, item, form, stem) {
  if (type === "root") {
    const left = stem.left;
    const right = stem.right;
    if (form.length >= 5 && left >= 2 && right >= 2) return "high";
    if (form.length >= 4 && (left >= 2 || right >= 2)) return "medium";
    return "low";
  }
  const stemLength = stem.stem.length;
  if (stemLength >= 6) return "high";
  if (stemLength >= 4) return "medium";
  return "low";
}

function bestPrefix(word, item) {
  const w = word.toLowerCase();
  let best = null;
  for (const form of item.forms) {
    if (!w.startsWith(form)) continue;
    const stem = w.slice(form.length);
    if (stem.length < minStemFor(form, "prefix")) continue;
    const score = scorePrefixOrSuffix(stem.length, form.length);
    if (!best || score > best.score || (score === best.score && form.length > best.form.length)) {
      best = { form, stem, score };
    }
  }
  return best;
}

function bestSuffix(word, item) {
  const w = word.toLowerCase();
  let best = null;
  for (const form of item.forms) {
    if (!w.endsWith(form)) continue;
    const stem = w.slice(0, w.length - form.length);
    if (stem.length < minStemFor(form, "suffix")) continue;
    const score = scorePrefixOrSuffix(stem.length, form.length);
    if (!best || score > best.score || (score === best.score && form.length > best.form.length)) {
      best = { form, stem, score };
    }
  }
  return best;
}

function bestRoots(word, item, max = 1) {
  const w = word.toLowerCase();
  const found = [];
  for (const form of item.forms) {
    let index = w.indexOf(form);
    while (index !== -1) {
      const left = index;
      const right = w.length - index - form.length;
      const stemLength = left + right;
      const ok =
        stemLength >= minStemFor(form, "root") &&
        (form.length > 3 ? left >= 1 || right >= 1 : left >= 2 || right >= 2);
      if (ok) {
        const score =
          form.length * 10 + Math.min(left, right) * 2 + (left > 0 && right > 0 ? 5 : 0);
        found.push({ form, stem: { left, right, length: stemLength }, score });
      }
      index = w.indexOf(form, index + 1);
    }
  }
  found.sort((a, b) => b.score - a.score || b.form.length - a.form.length);
  return found.slice(0, max);
}

/**
 * Decomposes a single word. Always returns a (possibly empty) hints array.
 * @returns {Array<{type,key,label,meaning,form,stem,confidence}>}
 */
function analyseWord(word, { maxRoots = 2 } = {}) {
  const current = getCatalog();
  const hints = [];

  let best = null;
  for (const item of current.prefix) {
    const match = bestPrefix(word, item);
    if (!match) continue;
    if (!best || match.score > best.match.score) best = { item, match };
  }
  if (best) {
    hints.push({
      type: "prefix",
      key: best.item.key,
      label: best.item.label,
      meaning: best.item.meaning,
      form: best.match.form,
      stem: best.match.stem,
      confidence: confidenceFor("prefix", best.item, best.match.form, best.match),
    });
  }

  best = null;
  for (const item of current.suffix) {
    const match = bestSuffix(word, item);
    if (!match) continue;
    if (!best || match.score > best.match.score) best = { item, match };
  }
  if (best) {
    hints.push({
      type: "suffix",
      key: best.item.key,
      label: best.item.label,
      meaning: best.item.meaning,
      form: best.match.form,
      stem: best.match.stem,
      confidence: confidenceFor("suffix", best.item, best.match.form, best.match),
    });
  }

  const roots = [];
  const w = word.toLowerCase();
  const occupied = [];
  const prefixHint = hints.find((hint) => hint.type === "prefix");
  if (prefixHint) occupied.push([0, prefixHint.form.length]);
  const suffixHint = hints.find((hint) => hint.type === "suffix");
  if (suffixHint) occupied.push([w.length - suffixHint.form.length, w.length]);

  for (const item of current.root) {
    for (const match of bestRoots(word, item, 1)) {
      const start = match.stem.left;
      const end = start + match.form.length;
      // A root that sits inside an already matched prefix/suffix is noise:
      // "postmodern" should not yield root "pos". Sharing one letter is fine
      // ("duct" + "-tion" in reproduction), so only drop bigger overlaps.
      const overlaps = occupied.some(([from, to]) => {
        const overlap = Math.min(end, to) - Math.max(start, from);
        return overlap > 1;
      });
      if (overlaps) continue;
      roots.push({ item, match });
    }
  }
  roots.sort((a, b) => b.match.score - a.match.score);
  const seen = new Set();
  for (const { item, match } of roots) {
    if (hints.filter((hint) => hint.type === "root").length >= maxRoots) break;
    const id = `${item.key}:${match.form}`;
    if (seen.has(id)) continue;
    seen.add(id);
    hints.push({
      type: "root",
      key: item.key,
      label: item.label,
      meaning: item.meaning,
      form: match.form,
      stem: word.toLowerCase().slice(match.stem.left, word.length - match.stem.right),
      confidence: confidenceFor("root", item, match.form, match.stem),
    });
  }

  return hints;
}

function groupHints(hints) {
  return {
    prefix: hints.find((hint) => hint.type === "prefix") || null,
    suffix: hints.find((hint) => hint.type === "suffix") || null,
    roots: hints.filter((hint) => hint.type === "root"),
  };
}

/** Cached per-book index: word hints, per-affix counts and examples. */
function getIndex(db, bookId) {
  // Only word text matters here, so status/starred updates (which touch
  // updated_at) don't invalidate the cache.
  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(headword), '') AS mx,
              COALESCE(SUM(LENGTH(headword)), 0) AS total
       FROM words WHERE book_id = ?`,
    )
    .get(bookId);
  const version = `${row.n}:${row.mx}:${row.total}`;
  const cached = INDEX_CACHE.get(bookId);
  if (cached && cached.version === version) return cached;

  const rows = db
    .prepare("SELECT id, headword FROM words WHERE book_id = ? ORDER BY sort_order ASC, id ASC")
    .all(bookId);
  const byWord = new Map();
  const stats = new Map();
  for (const item of allAffixes()) {
    stats.set(`${item.type}:${item.key}`, { type: item.type, count: 0, picks: [] });
  }

  for (const row of rows) {
    const hints = analyseWord(row.headword);
    byWord.set(row.id, hints);
    for (const hint of hints) {
      const stat = stats.get(`${hint.type}:${hint.key}`);
      if (!stat) continue;
      stat.count += 1;
      stat.picks.push({ headword: row.headword, length: row.headword.length });
    }
  }
  for (const stat of stats.values()) {
    stat.examples = stat.picks
      .sort((a, b) => a.length - b.length || a.headword.localeCompare(b.headword))
      .slice(0, 3)
      .map((pick) => pick.headword);
    delete stat.picks;
  }

  const index = { version, bookId, rows, byWord, stats };
  INDEX_CACHE.set(bookId, index);
  return index;
}

function invalidate(bookId) {
  if (bookId) INDEX_CACHE.delete(bookId);
  else INDEX_CACHE.clear();
}

function parseFilter(token) {
  const text = String(token || "").trim().toLowerCase();
  if (!text) return null;
  const [type, key] = text.includes(":") ? text.split(":") : ["", text];
  if (type && !TYPES.includes(type)) return null;
  if (!key) return null;
  return { type: type || null, key };
}

/** Returns word ids in book order that match every (or any) affix filter. */
function filterWordIds(index, filters, mode = "and") {
  const wanted = filters
    .map((token) => parseFilter(token))
    .filter(Boolean)
    .map((filter) => (filter.type ? `${filter.type}:${filter.key}` : filter.key));
  if (!wanted.length) return null;

  const matched = [];
  for (const row of index.rows) {
    const hints = index.byWord.get(row.id) || [];
    const keys = new Set(hints.map((hint) => `${hint.type}:${hint.key}`));
    const keysOnly = new Set(hints.map((hint) => hint.key));
    const hit = (token) =>
      token.includes(":") ? keys.has(token) : keysOnly.has(token);
    const isMatch = mode === "or" ? wanted.some(hit) : wanted.every(hit);
    if (isMatch) matched.push(row.id);
  }
  return matched;
}

module.exports = {
  TYPES,
  getCatalog,
  allAffixes,
  analyseWord,
  groupHints,
  getIndex,
  invalidate,
  filterWordIds,
  parseFilter,
};