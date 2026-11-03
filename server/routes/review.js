"use strict";

const { getDb, transaction } = require("../db");
const { httpError, intParam, cleanString, readJsonBody } = require("../http");
const srs = require("../services/srs");
const { pickBookId, toWord } = require("./words");

function toCard(row) {
  return {
    wordId: row.word_id,
    bookId: row.book_id,
    stage: Number(row.stage),
    ease: Number(row.ease),
    interval: Number(row.interval),
    dueAt: row.due_at,
    reps: Number(row.reps),
    lapses: Number(row.lapses),
    lastRating: row.last_rating || null,
    lastRatedAt: row.last_rated_at || null,
    createdAt: row.created_at,
  };
}

function localDateKey(date) {
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function startOfToday() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

/** Due cards first, then the words they belong to. */
function queue({ query }) {
  const db = getDb();
  const size = intParam(query, "size", 20, { min: 1, max: 100 });
  const bookId = cleanString(query.get("book"), 80) || pickBookId(db, null);
  const now = new Date().toISOString();

  const due = Number(
    db.prepare("SELECT COUNT(*) AS n FROM review_cards WHERE book_id = ? AND due_at <= ?").get(bookId, now).n,
  );
  const cards = db
    .prepare(
      "SELECT * FROM review_cards WHERE book_id = ? AND due_at <= ? ORDER BY due_at ASC LIMIT ?",
    )
    .all(bookId, now, size);

  const stmt = db.prepare("SELECT * FROM words WHERE id = ?");
  const words = [];
  for (const card of cards) {
    const row = stmt.get(card.word_id);
    if (!row) continue;
    words.push({ ...toWord(row), review: toCard(card) });
  }

  return {
    data: { words },
    meta: { bookId, due, size, hasMore: due > words.length, source: "review" },
  };
}

async function rate({ req, params }) {
  const body = await readJsonBody(req);
  const rating = cleanString(body.rating, 20).toLowerCase();
  if (!srs.RATINGS.includes(rating)) {
    throw httpError("BAD_REQUEST", `rating 只能是 ${srs.RATINGS.join(" / ")}`);
  }

  const db = getDb();
  const word = db.prepare("SELECT * FROM words WHERE id = ?").get(params.wordId);
  if (!word) throw httpError("NOT_FOUND", "没有找到这个单词");

  const existing = db.prepare("SELECT * FROM review_cards WHERE word_id = ?").get(word.id);
  const base = existing ? toCard(existing) : srs.DEFAULT_CARD;
  const next = srs.nextCard(base, rating);
  const now = new Date().toISOString();
  // 只有「忘了」才让已掌握的词退回学习中；评「记得 / 太简单」不降级。
  let status = srs.statusForCard(next);
  if (rating !== "again" && word.status === "known") status = "known";

  transaction(db, () => {
    if (existing) {
      db.prepare(
        `UPDATE review_cards SET stage = ?, ease = ?, interval = ?, due_at = ?, reps = ?,
           lapses = ?, last_rating = ?, last_rated_at = ? WHERE word_id = ?`,
      ).run(next.stage, next.ease, next.interval, next.dueAt, next.reps, next.lapses, rating, now, word.id);
    } else {
      db.prepare(
        `INSERT INTO review_cards
           (word_id, book_id, stage, ease, interval, due_at, reps, lapses, last_rating, last_rated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        word.id, word.book_id, next.stage, next.ease, next.interval, next.dueAt,
        next.reps, next.lapses, rating, now, now,
      );
    }
    db.prepare(
      "INSERT INTO review_logs (word_id, book_id, rating, interval, reviewed_at) VALUES (?, ?, ?, ?, ?)",
    ).run(word.id, word.book_id, rating, next.interval, now);
    db.prepare("UPDATE words SET status = ? WHERE id = ?").run(status, word.id);
  });

  return {
    data: {
      wordId: word.id,
      headword: word.headword,
      rating,
      status,
      review: {
        stage: next.stage,
        ease: next.ease,
        interval: next.interval,
        dueAt: next.dueAt,
        reps: next.reps,
        lapses: next.lapses,
      },
    },
  };
}

function cardOf({ params }) {
  const db = getDb();
  const word = db.prepare("SELECT id, headword, status FROM words WHERE id = ?").get(params.wordId);
  if (!word) throw httpError("NOT_FOUND", "没有找到这个单词");
  const row = db.prepare("SELECT * FROM review_cards WHERE word_id = ?").get(word.id);
  return {
    data: {
      wordId: word.id,
      headword: word.headword,
      status: word.status,
      started: Boolean(row),
      review: row ? toCard(row) : null,
    },
  };
}

function resetCard({ params }) {
  const db = getDb();
  const word = db.prepare("SELECT * FROM words WHERE id = ?").get(params.wordId);
  if (!word) throw httpError("NOT_FOUND", "没有找到这个单词");
  transaction(db, () => {
    db.prepare("DELETE FROM review_cards WHERE word_id = ?").run(word.id);
    db.prepare("UPDATE words SET status = 'new' WHERE id = ?").run(word.id);
  });
  return { data: { wordId: word.id, reset: true } };
}

function stats({ query }) {
  const db = getDb();
  const days = intParam(query, "days", 30, { min: 1, max: 365 });
  const bookId = cleanString(query.get("book"), 80) || pickBookId(db, null);
  const now = new Date();
  const todayStart = startOfToday();
  const since = new Date(todayStart.getTime() - (days - 1) * 86400000);

  const logs = db
    .prepare("SELECT rating, reviewed_at FROM review_logs WHERE book_id = ? AND reviewed_at >= ?")
    .all(bookId, since.toISOString());

  const buckets = new Map();
  for (let i = 0; i < days; i += 1) {
    const day = new Date(since.getTime() + i * 86400000);
    buckets.set(localDateKey(day), { date: localDateKey(day), reviewed: 0, correct: 0 });
  }
  const activeDays = new Set();
  for (const log of logs) {
    const key = localDateKey(new Date(log.reviewed_at));
    activeDays.add(key);
    const bucket = buckets.get(key);
    if (!bucket) continue;
    bucket.reviewed += 1;
    if (log.rating === "good" || log.rating === "easy") bucket.correct += 1;
  }

  // Streak: consecutive days with at least one review, counting back from today.
  let streak = 0;
  for (let i = 0; i < 400; i += 1) {
    const day = new Date(todayStart.getTime() - i * 86400000);
    if (!activeDays.has(localDateKey(day))) break;
    streak += 1;
  }

  const todayKey = localDateKey(now);
  const today = buckets.get(todayKey) || { reviewed: 0, correct: 0 };
  const due = Number(
    db.prepare("SELECT COUNT(*) AS n FROM review_cards WHERE book_id = ? AND due_at <= ?")
      .get(bookId, now.toISOString()).n,
  );
  const total = Number(db.prepare("SELECT COUNT(*) AS n FROM review_cards WHERE book_id = ?").get(bookId).n);
  const mature = Number(
    db.prepare("SELECT COUNT(*) AS n FROM review_cards WHERE book_id = ? AND interval >= 21").get(bookId).n,
  );

  return {
    data: {
      bookId,
      days,
      streak,
      today: { reviewed: today.reviewed, correct: today.correct },
      due,
      cards: { total, mature, learning: total - mature },
      daily: [...buckets.values()],
    },
  };
}

const routes = [
  { method: "GET", pattern: /^\/api\/v1\/review\/queue$/, handler: queue },
  { method: "GET", pattern: /^\/api\/v1\/review\/stats$/, handler: stats },
  { method: "POST", pattern: /^\/api\/v1\/review\/reset\/([^/]+)$/, params: ["wordId"], handler: resetCard },
  { method: "GET", pattern: /^\/api\/v1\/review\/([^/]+)$/, params: ["wordId"], handler: cardOf },
  { method: "POST", pattern: /^\/api\/v1\/review\/([^/]+)$/, params: ["wordId"], handler: rate },
];

module.exports = { routes };