"use strict";

/**
 * End-to-end smoke test for the M1 API surface.
 * Uses a throwaway database (data/.smoke.db) so the real data is untouched.
 *
 *   node scripts/smoke.js
 */

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const DB = path.join(ROOT, "data", ".smoke.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${DB}${suffix}`, { force: true });
process.env.ZHANCI_DB = DB;

const { createServer } = require("../server/app");

let passed = 0;
function ok(name) {
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function main() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(method, url, body, headers = {}) {
    const options = { method, headers: { ...headers } };
    if (body !== undefined) {
      options.body = typeof body === "string" ? body : JSON.stringify(body);
      if (!headers["Content-Type"]) options.headers["Content-Type"] = "application/json";
    }
    const response = await fetch(base + url, options);
    const text = await response.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: response.status, body: json, headers: response.headers };
  }

  try {
    const health = await call("GET", "/api/v1/health");
    assert.equal(health.status, 200);
    assert.equal(health.body.data.ok, true);
    ok("GET /api/v1/health");

    const meta = await call("GET", "/api/v1/meta");
    assert.equal(meta.status, 200);
    assert.equal(meta.body.data.counts.total, 2084);
    assert.equal(meta.body.data.books, 1);
    assert.equal(typeof meta.body.data.review.due, "number");
    assert.equal(meta.body.data.review.due, 0);
    ok(`GET /api/v1/meta（共 ${meta.body.data.counts.total} 词）`);

    const books = await call("GET", "/api/v1/books");
    assert.equal(books.body.data.books.length, 1);
    assert.equal(books.body.data.books[0].wordCount, 2084);
    ok("GET /api/v1/books");

    const page1 = await call("GET", "/api/v1/words?limit=5");
    assert.equal(page1.status, 200);
    assert.equal(page1.body.data.words.length, 5);
    assert.equal(page1.body.meta.total, 2084);
    assert.equal(page1.body.meta.hasMore, true);
    const page2 = await call(
      "GET",
      `/api/v1/words?limit=5&cursor=${encodeURIComponent(page1.body.meta.nextCursor)}`,
    );
    const ids1 = page1.body.data.words.map((w) => w.id);
    const ids2 = page2.body.data.words.map((w) => w.id);
    assert.equal(ids1.filter((id) => ids2.includes(id)).length, 0);
    ok("分页（cursor 翻页不重复）");

    const az = await call("GET", "/api/v1/words?sort=az&limit=3");
    const headwords = az.body.data.words.map((w) => w.headword.toLowerCase());
    assert.deepEqual(headwords, [...headwords].sort());
    ok("排序 az");

    const searchSeed = az.body.data.words[0].headword;
    const search = await call("GET", `/api/v1/words?q=${encodeURIComponent(searchSeed)}&limit=20`);
    assert.ok(search.body.data.words.some((w) => w.headword === searchSeed));
    const zh = page1.body.data.words[0].translation.slice(0, 2);
    if (zh) {
      const zhSearch = await call("GET", `/api/v1/words?q=${encodeURIComponent(zh)}&limit=20`);
      assert.equal(zhSearch.status, 200);
      assert.ok(zhSearch.body.meta.total > 0);
    }
    ok("搜索（英文 + 中文释义）");

    const starredList = await call("GET", "/api/v1/words?starred=1");
    assert.equal(starredList.body.meta.total, 0);
    ok("筛选 starred=1");

    const target = page1.body.data.words[0];
    const star = await call("PATCH", `/api/v1/words/${target.id}`, { starred: true });
    assert.equal(star.status, 200);
    assert.equal(star.body.data.starred, true);
    assert.ok(star.body.data.starredAt);
    const starredList2 = await call("GET", "/api/v1/words?starred=1");
    assert.equal(starredList2.body.meta.total, 1);
    const unstar = await call("PATCH", `/api/v1/words/${target.id}`, { starred: false });
    assert.equal(unstar.body.data.starred, false);
    assert.equal(unstar.body.data.starredAt, null);
    ok("星标切换 + starred_at");

    const created = await call("POST", "/api/v1/words", {
      word: "serendipity",
      pos: "n.",
      phoneticUs: "ˌserənˈdɪpəti",
      translation: "意外发现珍奇事物的能力",
      stars: 1,
    });
    assert.equal(created.status, 201);
    assert.equal(created.body.data.headword, "serendipity");
    assert.equal(created.body.data.phoneticUs, "/ˌserənˈdɪpəti/");
    assert.equal(created.body.data.source, "custom");
    ok("POST 新增单词（音标自动补斜杠）");

    const dup = await call("POST", "/api/v1/words", { word: "Serendipity", translation: "重复" });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, "CONFLICT");
    ok("重复单词返回 409");

    const badWord = await call("POST", "/api/v1/words", { word: "1234", translation: "数字" });
    assert.equal(badWord.status, 400);
    ok("非法单词返回 400");

    const patched = await call("PATCH", `/api/v1/words/${created.body.data.id}`, {
      headword: "serendipity!",
    });
    assert.equal(patched.status, 400);
    ok("PATCH 非法单词名返回 400");

    const updated = await call("PATCH", `/api/v1/words/${created.body.data.id}`, {
      translation: "意外发现珍宝的运气",
      status: "learning",
      note: "影视剧中高频出现",
    });
    assert.equal(updated.status, 200);
    assert.equal(updated.body.data.status, "learning");
    ok("PATCH 释义 / 状态 / 备注");

    const removed = await call("DELETE", `/api/v1/words/${created.body.data.id}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.data.deleted, true);
    const missing = await call("GET", `/api/v1/words/${created.body.data.id}`);
    assert.equal(missing.status, 404);
    ok("DELETE 单词 + 再查 404");

    const batchWords = page1.body.data.words.slice(1, 4).map((w) => w.id);
    const batchStar = await call("POST", "/api/v1/words/batch-star", {
      ids: batchWords,
      starred: true,
    });
    assert.equal(batchStar.body.data.updated, batchWords.length);
    assert.equal((await call("GET", "/api/v1/words?starred=1")).body.meta.total, 3);
    const batchUnstar = await call("POST", "/api/v1/words/batch-star", {
      ids: batchWords,
      starred: false,
    });
    assert.equal(batchUnstar.body.data.updated, batchWords.length);
    assert.equal((await call("GET", "/api/v1/words?starred=1")).body.meta.total, 0);
    ok("批量星标 / 取消星标");

    const dailyA = await call("GET", "/api/v1/words/daily?size=20&date=2026-10-29");
    const dailyB = await call("GET", "/api/v1/words/daily?size=20&date=2026-10-29");
    assert.equal(dailyA.body.data.words.length, 20);
    assert.deepEqual(
      dailyA.body.data.words.map((w) => w.id),
      dailyB.body.data.words.map((w) => w.id),
    );
    const dailyC = await call("GET", "/api/v1/words/daily?size=20&date=2026-10-30");
    assert.notDeepEqual(
      dailyA.body.data.words.map((w) => w.id),
      dailyC.body.data.words.map((w) => w.id),
    );
    ok("daily 队列按日期稳定且每天不同");

    const badSort = await call("GET", "/api/v1/words?sort=oops");
    assert.equal(badSort.status, 400);
    const badCursor = await call("GET", "/api/v1/words?cursor=oops");
    assert.equal(badCursor.status, 400);
    ok("非法参数返回 400");

    const wrongMethod = await call("PUT", "/api/v1/words");
    assert.equal(wrongMethod.status, 405);
    const notFound = await call("GET", "/api/v1/nope");
    assert.equal(notFound.status, 404);
    ok("405 / 404");

    /* ---------------------------- M2: txt 导入 ---------------------------- */

    const TXT = [
      "# 一行一行的单词表",
      "",
      "zzapple",
      "zzapricot  杏子",
      "zzbanana\tn. 香蕉",
      "1. zzcherry /ˈtʃeri/ n. 樱桃",
      "123 abc",
      "苹果",
    ].join("\r\n");

    const preview = await call("POST", "/api/v1/words/import?dryRun=1", TXT, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.data.encoding, "utf-8");
    assert.equal(preview.body.data.new, 4);
    assert.equal(preview.body.data.invalid, 2);
    assert.equal(preview.body.data.preview.length, 4);
    assert.equal(
      preview.body.data.preview.find((p) => p.headword === "zzcherry").phonetic,
      "/ˈtʃeri/",
    );
    assert.equal(
      preview.body.data.preview.find((p) => p.headword === "zzbanana").pos,
      "n.",
    );
    ok("导入 dry-run 预览（格式/音标/词性/错误行）");

    const imported = await call("POST", "/api/v1/words/import?mode=merge&filename=smoke.txt", TXT, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    assert.equal(imported.status, 201);
    assert.equal(imported.body.data.inserted, 4);
    assert.equal(imported.body.data.invalid, 2);
    const importId = imported.body.data.importId;
    const importedWords = await call("GET", "/api/v1/words?q=zz&limit=200");
    const zzWords = importedWords.body.data.words.filter((w) => w.headword.startsWith("zz"));
    assert.equal(zzWords.length, 4);
    assert.ok(zzWords.every((w) => w.source === "import"));
    ok("导入写入（4 个新词，source=import）");

    const reimport = await call("POST", "/api/v1/words/import?dryRun=1", TXT, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    assert.equal(reimport.body.data.new, 0);
    assert.equal(reimport.body.data.duplicates, 4);
    ok("重复导入被识别为 duplicate");

    const enrichFirst = await call(
      "POST",
      "/api/v1/words/import?mode=merge",
      "zztestenrich\n",
      { "Content-Type": "text/plain; charset=utf-8" },
    );
    assert.equal(enrichFirst.body.data.inserted, 1);
    const enrichSecond = await call(
      "POST",
      "/api/v1/words/import?mode=merge",
      "zztestenrich  补全释义\n",
      { "Content-Type": "text/plain; charset=utf-8" },
    );
    assert.equal(enrichSecond.body.data.enriched, 1);
    assert.equal(enrichSecond.body.data.inserted, 0);
    const enrichedWord = await call("GET", "/api/v1/words?q=zztestenrich&limit=5");
    assert.equal(enrichedWord.body.data.words[0].translation, "补全释义");
    const skipMode = await call(
      "POST",
      "/api/v1/words/import?mode=skip&dryRun=1",
      "zztestenrich  另一个释义\n",
      { "Content-Type": "text/plain; charset=utf-8" },
    );
    assert.equal(skipMode.body.data.duplicates, 1);
    ok("merge 模式补全空释义 / skip 模式只跳过");

    const importList = await call("GET", "/api/v1/imports");
    assert.ok(importList.body.data.imports.length >= 3);
    const firstBatch = importList.body.data.imports.find((item) => item.id === importId);
    assert.equal(firstBatch.filename, "smoke.txt");
    ok("GET /imports 批次列表");

    const rollback = await call("POST", `/api/v1/imports/${importId}/rollback`);
    assert.equal(rollback.status, 200);
    assert.equal(rollback.body.data.deleted, 4);
    const afterRollback = await call("GET", "/api/v1/words?q=zz&limit=200");
    const remaining = afterRollback.body.data.words.filter((w) => w.headword.startsWith("zz"));
    assert.equal(remaining.length, 1);
    assert.equal(remaining[0].headword, "zztestenrich");
    const rollbackMissing = await call("POST", "/api/v1/imports/imp_nope/rollback");
    assert.equal(rollbackMissing.status, 404);
    ok("按批次回滚 + 不存在批次 404");

    const emptyImport = await call("POST", "/api/v1/words/import", "   \n\n", {
      "Content-Type": "text/plain; charset=utf-8",
    });
    assert.equal(emptyImport.status, 400);
    const tooMany = Array.from({ length: 5001 }, (_, i) => `zzword${i}`).join("\n");
    const tooManyImport = await call("POST", "/api/v1/words/import?dryRun=1", tooMany, {
      "Content-Type": "text/plain; charset=utf-8",
    });
    assert.equal(tooManyImport.status, 413);
    ok("空内容 400 / 超过 5000 行 413");

    /* ------------------------- M3: 词缀 + 离线查词 ------------------------- */

    const affixCatalog = await call("GET", "/api/v1/affixes");
    assert.equal(affixCatalog.status, 200);
    assert.equal(affixCatalog.body.data.prefixes.length, 57);
    assert.equal(affixCatalog.body.data.suffixes.length, 46);
    assert.equal(affixCatalog.body.data.roots.length, 45);
    const reAffix = affixCatalog.body.data.prefixes.find((item) => item.key === "re");
    assert.ok(reAffix.count > 0);
    assert.ok(reAffix.examples.length > 0);
    const onlyPrefixes = await call("GET", "/api/v1/affixes?type=prefix");
    assert.equal(onlyPrefixes.body.data.type, "prefix");
    assert.equal(onlyPrefixes.body.data.affixes.length, 57);
    ok("GET /affixes 目录 + 命中计数 + 例词");

    const match = await call("GET", "/api/v1/affixes/match?word=reproduction");
    assert.equal(match.status, 200);
    assert.equal(match.body.data.prefix.key, "re");
    assert.equal(match.body.data.suffix.key, "ion");
    assert.ok(match.body.data.roots.some((root) => root.key === "duc"));
    const modern = await call("GET", "/api/v1/affixes/match?word=postmodern");
    assert.ok(!modern.body.data.roots.some((root) => root.key === "pos"));
    ok("拆词（reproduction / postmodern 不误报 pos）");

    const reWords = await call("GET", "/api/v1/affixes/prefix/re/words?limit=5");
    assert.equal(reWords.status, 200);
    assert.ok(reWords.body.meta.total > 0);
    assert.ok(reWords.body.data.words.every((word) => word.headword.toLowerCase().startsWith("re")));
    assert.ok(reWords.body.data.words.every((word) => word.hints.some((h) => h.key === "re")));
    ok("GET /affixes/:type/:key/words");

    const combo = await call("GET", "/api/v1/words?affix=prefix:un,suffix:able&limit=20");
    assert.ok(combo.body.meta.total >= 1);
    assert.ok(
      combo.body.data.words.every((word) => {
        const keys = word.hints.map((hint) => hint.key);
        return keys.includes("un") && keys.includes("able");
      }),
    );
    const orCombo = await call("GET", "/api/v1/words?affix=prefix:un,suffix:able&affixMode=or&limit=5");
    assert.ok(orCombo.body.meta.total >= combo.body.meta.total);
    assert.equal(orCombo.body.meta.affixMode, "or");
    ok("词缀组合筛选（AND / OR）");

    const noHints = await call("GET", "/api/v1/words?limit=2&hints=0");
    assert.ok(noHints.body.data.words.every((word) => word.hints === undefined));
    const withHints = await call("GET", "/api/v1/words?limit=2");
    assert.ok(withHints.body.data.words.every((word) => Array.isArray(word.hints)));
    ok("hints=0 可关闭拆解信息");

    const dict = await call("GET", "/api/v1/dict/reproduction");
    assert.equal(dict.status, 200);
    assert.equal(dict.body.data.found, true);
    assert.equal(dict.body.data.source, "book");
    assert.equal(dict.body.data.entry.headword, "reproduction");
    assert.ok(dict.body.data.affixes.prefix);
    const dictMiss = await call("GET", "/api/v1/dict/zzzznotaword");
    assert.equal(dictMiss.status, 200);
    assert.equal(dictMiss.body.data.found, false);
    assert.equal(dictMiss.body.data.entry, null);
    assert.ok(Array.isArray(dictMiss.body.data.hints));
    ok("GET /dict/:word（命中 + 未收录）");

    const suggest = await call("GET", "/api/v1/dict/suggest?q=re");
    assert.equal(suggest.status, 200);
    assert.ok(suggest.body.data.words.length > 0);
    assert.ok(suggest.body.data.affixes.some((item) => item.key === "re"));
    ok("GET /dict/suggest（单词 + 词缀联想）");

    const badAffixType = await call("GET", "/api/v1/affixes?type=oops");
    assert.equal(badAffixType.status, 400);
    const missingAffix = await call("GET", "/api/v1/affixes/prefix/nope/words");
    assert.equal(missingAffix.status, 404);
    ok("词缀参数校验 400 / 404");

    const beforeRe = (await call("GET", "/api/v1/affixes/prefix/re/words?limit=1")).body.meta.total;
    const reCreated = await call("POST", "/api/v1/words", { word: "rezztest", translation: "测试词" });
    assert.equal(reCreated.status, 201);
    const afterRe = (await call("GET", "/api/v1/affixes/prefix/re/words?limit=1")).body.meta.total;
    assert.equal(afterRe, beforeRe + 1);
    await call("DELETE", `/api/v1/words/${reCreated.body.data.id}`);
    const restoredRe = (await call("GET", "/api/v1/affixes/prefix/re/words?limit=1")).body.meta.total;
    assert.equal(restoredRe, beforeRe);
    ok("新增/删除单词后词缀索引自动刷新");

    /* ------------------------- M4: stardict 词典 ------------------------- */

    const { normalizeEcdictPhonetic } = require("../server/http");
    assert.equal(normalizeEcdictPhonetic(".ri:prә'dʌkʃәn"), "/ˌriːprəˈdʌkʃən/");
    assert.equal(normalizeEcdictPhonetic(",serәn'dipiti"), "/ˌserənˈdipiti/");
    assert.equal(normalizeEcdictPhonetic("'rʌniŋ"), "/ˈrʌniŋ/");
    assert.equal(normalizeEcdictPhonetic(""), "");
    ok("ECDICT 音标规范化（ә / : / ' / , ）");

    const db = require("../server/db").getDb();
    const insertDict = db.prepare(
      `INSERT OR REPLACE INTO dict_entries
       (word, normalized, phonetic, definition, translation, pos, collins, oxford, tag, bnc, frq, exchange, lemma)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertDict.run(
      "reproduction", "reproduction", "/ˌriːprəˈdʌkʃən/", "n. the act of copying",
      "n. 再现", "n", 1, 0, "cet6 toefl", 4803, 5658, "s:reproductions", "",
    );
    insertDict.run(
      "serendipity", "serendipity", "/ˌserənˈdipiti/", "n. good luck",
      "n. 意外发现", "n", 0, 0, "gre", 34544, 23199, "s:serendipities", "",
    );
    insertDict.run("zzzruns", "zzzruns", "", "", "测试变形", "", 0, 0, "", 0, 0, "", "zzzrun");

    const both = await call("GET", "/api/v1/dict/reproduction");
    assert.equal(both.body.data.source, "both");
    assert.equal(both.body.data.inBook, true);
    assert.ok(both.body.data.dict);
    assert.equal(both.body.data.dict.phonetic, "/ˌriːprəˈdʌkʃən/");
    assert.equal(both.body.data.entry.headword, "reproduction");

    const ecdictOnly = await call("GET", "/api/v1/dict/serendipity");
    assert.equal(ecdictOnly.body.data.source, "ecdict");
    assert.equal(ecdictOnly.body.data.inBook, false);
    assert.equal(ecdictOnly.body.data.entry, null);
    assert.equal(ecdictOnly.body.data.dict.translation, "n. 意外发现");
    assert.ok(ecdictOnly.body.data.affixes.suffix);
    ok("GET /dict 词书 + 词典合并（both / ecdict）");

    const lemmaHit = await call("GET", "/api/v1/dict/zzzrun");
    assert.equal(lemmaHit.body.data.found, true);
    assert.equal(lemmaHit.body.data.lemmatized, true);
    assert.equal(lemmaHit.body.data.dict.word, "zzzruns");
    ok("词形反查（lemma → 原形）");

    const suggestDict = await call("GET", "/api/v1/dict/suggest?q=seren");
    assert.ok(suggestDict.body.data.dict.some((item) => item.word === "serendipity"));
    assert.ok(Array.isArray(suggestDict.body.data.words));
    assert.ok(Array.isArray(suggestDict.body.data.affixes));
    ok("GET /dict/suggest 带词典联想");

    /* ------------------------- M5: 搜索栏 ------------------------- */

    const searchAll = await call("GET", "/api/v1/search?q=re&limit=3");
    assert.equal(searchAll.status, 200);
    assert.ok(Array.isArray(searchAll.body.data.results.book));
    assert.ok(Array.isArray(searchAll.body.data.results.dict));
    assert.ok(Array.isArray(searchAll.body.data.results.affix));
    assert.ok(Array.isArray(searchAll.body.data.results.notes));
    assert.ok(searchAll.body.data.results.affix.some((item) => item.key === "re"));
    ok("GET /search 聚合四组结果");

    const searchBookOnly = await call("GET", "/api/v1/search?q=re&sources=book");
    assert.deepEqual(Object.keys(searchBookOnly.body.data.results), ["book"]);
    const searchBadSource = await call("GET", "/api/v1/search?q=re&sources=paper");
    assert.equal(searchBadSource.status, 400);
    const searchEmpty = await call("GET", "/api/v1/search?q=zzznothinghere");
    assert.equal(searchEmpty.body.data.total, 0);
    ok("搜索 sources 过滤 / 非法 400 / 空结果");

/* ------------------------- M5: 单词笔记本 ------------------------- */

    const firstWord = (await call("GET", "/api/v1/words?limit=1")).body.data.words[0];
    const noteByWord = await call("POST", "/api/v1/notes", {
      wordId: firstWord.id,
      content: "第一个笔记：注意词缀 re- 表示“再”",
    });
    assert.equal(noteByWord.status, 201);
    assert.equal(noteByWord.body.data.wordId, firstWord.id);
    assert.equal(noteByWord.body.data.headword, firstWord.headword);

    const noteByHeadword = await call("POST", "/api/v1/notes", {
      headword: "serendipity",
      content: "词典里的词也能记笔记",
    });
    assert.equal(noteByHeadword.status, 201);
    assert.equal(noteByHeadword.body.data.wordId, null);
    assert.equal(noteByHeadword.body.data.normalized, "serendipity");

    const noteEmpty = await call("POST", "/api/v1/notes", { wordId: firstWord.id, content: "   " });
    assert.equal(noteEmpty.status, 400);
    ok("POST /notes（词书词 / 词典词 / 空内容）");

    const notesOfWord = await call("GET", `/api/v1/notes?word=${encodeURIComponent(firstWord.headword)}`);
    assert.equal(notesOfWord.body.data.notes.length, 1);
    assert.equal(notesOfWord.body.data.notes[0].id, noteByWord.body.data.id);

    const notePatched = await call("PATCH", `/api/v1/notes/${noteByWord.body.data.id}`, {
      content: "改过的笔记：re- = 再",
    });
    assert.equal(notePatched.body.data.content, "改过的笔记：re- = 再");

    const noteSearch = await call("GET", "/api/v1/notes?q=词典");
    assert.ok(noteSearch.body.data.notes.some((note) => note.id === noteByHeadword.body.data.id));

    const noteSearchEmpty = await call("GET", "/api/v1/notes?q=不存在的内容zzz");
    assert.equal(noteSearchEmpty.body.data.notes.length, 0);

    const noteStats = await call("GET", "/api/v1/notes/stats");
    assert.equal(noteStats.body.data.total, 2);
    assert.equal(noteStats.body.data.words, 2);
    ok("笔记列表 / 修改 / 搜索 / 统计");

    const noteDeleted = await call("DELETE", `/api/v1/notes/${noteByHeadword.body.data.id}`);
    assert.equal(noteDeleted.body.data.deleted, true);
    const noteDeletedAgain = await call("DELETE", `/api/v1/notes/${noteByHeadword.body.data.id}`);
    assert.equal(noteDeletedAgain.status, 404);
    ok("DELETE /notes 与 404");

/* ------------------------- M5: 记忆曲线 ------------------------- */

    const emptyQueue = await call("GET", "/api/v1/review/queue");
    assert.equal(emptyQueue.status, 200);
    assert.equal(emptyQueue.body.data.words.length, 0);
    assert.equal(emptyQueue.body.meta.due, 0);

    const rated1 = await call("POST", `/api/v1/review/${firstWord.id}`, { rating: "good" });
    assert.equal(rated1.status, 200);
    assert.equal(rated1.body.data.review.stage, 1);
    assert.equal(rated1.body.data.review.interval, 1);
    assert.equal(rated1.body.data.status, "learning");
    assert.ok(new Date(rated1.body.data.review.dueAt) > new Date());
    ok("POST /review 首次评分（good → 1 天）");

    const cardInfo = await call("GET", `/api/v1/review/${firstWord.id}`);
    assert.equal(cardInfo.body.data.started, true);
    assert.equal(cardInfo.body.data.review.reps, 1);
    assert.equal(cardInfo.body.data.status, "learning");

    const ratedAgain = await call("POST", `/api/v1/review/${firstWord.id}`, { rating: "again" });
    assert.equal(ratedAgain.body.data.review.interval, 0);
    assert.equal(ratedAgain.body.data.review.stage, 0);
    assert.equal(ratedAgain.body.data.review.lapses, 1);
    const dueIn = new Date(ratedAgain.body.data.review.dueAt).getTime() - Date.now();
    assert.ok(dueIn > 0 && dueIn <= 11 * 60 * 1000);
    ok("again → 10 分钟后重来 + lapses 计数");

    const badRating = await call("POST", `/api/v1/review/${firstWord.id}`, { rating: "perfect" });
    assert.equal(badRating.status, 400);
    const missingWord = await call("POST", "/api/v1/review/w_missing", { rating: "good" });
    assert.equal(missingWord.status, 404);
    ok("评分参数校验 400 / 404");

    let lastInterval = 0;
    let lastStatus = "learning";
    for (const rating of ["good", "good", "good", "good", "good"]) {
      const res = await call("POST", `/api/v1/review/${firstWord.id}`, { rating });
      lastInterval = res.body.data.review.interval;
      lastStatus = res.body.data.status;
    }
    assert.ok(lastInterval > 20);
    assert.equal(lastStatus, "known");
    ok("连续 good 升级 interval 并标记 known");

    const reviewStats = await call("GET", "/api/v1/review/stats?days=7");
    assert.equal(reviewStats.status, 200);
    assert.equal(reviewStats.body.data.today.reviewed, 7);
    assert.equal(reviewStats.body.data.streak, 1);
    assert.equal(reviewStats.body.data.cards.total, 1);
    assert.equal(reviewStats.body.data.daily.length, 7);
    ok("GET /review/stats 今日 / 连续天数 / 卡片分布");

    // 前端学习页会先写主观状态：已是 known 的词评「记得」不该被降级，「忘了」才降级
    await call("PATCH", `/api/v1/words/${firstWord.id}`, { status: "known" });
    const hardOnKnown = await call("POST", `/api/v1/review/${firstWord.id}`, { rating: "hard" });
    assert.equal(hardOnKnown.body.data.status, "known");
    const againOnKnown = await call("POST", `/api/v1/review/${firstWord.id}`, { rating: "again" });
    assert.equal(againOnKnown.body.data.status, "learning");
    ok("known 词评 hard 不降级、评 again 降级");

    const resetCard = await call("POST", `/api/v1/review/reset/${firstWord.id}`);
    assert.equal(resetCard.body.data.reset, true);
    const afterReset = await call("GET", `/api/v1/review/${firstWord.id}`);
    assert.equal(afterReset.body.data.started, false);
    assert.equal(afterReset.body.data.status, "new");
    ok("POST /review/reset 重置卡片");

    const textImportPlaceholder = await call("GET", "/api/v1/words?limit=1");
    assert.equal(textImportPlaceholder.status, 200);
    ok("基础回归");

    console.log(`\n全部通过：${passed} 项`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${DB}${suffix}`, { force: true });
  }
}

main().catch((error) => {
  console.error("\n冒烟测试失败：", error.message);
  console.error(error.stack);
  process.exitCode = 1;
});