"use strict";

/**
 * SM-2 style spaced repetition.
 *
 * Ratings: again | hard | good | easy.
 * "again" schedules the card 10 minutes later (same session), everything else
 * moves it out in whole days. Ease is clamped to [1.3, 2.8], intervals to
 * 365 days.
 */

const RATINGS = ["again", "hard", "good", "easy"];
const MIN_EASE = 1.3;
const MAX_EASE = 2.8;
const MAX_INTERVAL = 365;

function clampEase(value) {
  return Math.min(MAX_EASE, Math.max(MIN_EASE, Math.round(value * 100) / 100));
}

/**
 * @param {{stage:number, ease:number, interval:number, reps:number, lapses:number}} card
 * @param {string} rating
 * @param {Date} [now]
 * @returns {{stage:number, ease:number, interval:number, reps:number, lapses:number, dueAt:string}}
 */
function nextCard(card, rating, now = new Date()) {
  if (!RATINGS.includes(rating)) {
    throw new Error(`未知评分：${rating}`);
  }
  let { stage, ease, interval, reps, lapses } = {
    stage: Number(card.stage) || 0,
    ease: Number(card.ease) || 2.5,
    interval: Number(card.interval) || 0,
    reps: Number(card.reps) || 0,
    lapses: Number(card.lapses) || 0,
  };

  switch (rating) {
    case "again":
      interval = 0;
      ease = clampEase(ease - 0.2);
      lapses += 1;
      stage = 0;
      break;
    case "hard":
      interval = Math.max(1, Math.round(interval * 1.2));
      ease = clampEase(ease - 0.15);
      stage += 1;
      break;
    case "good":
      interval = stage === 0 ? 1 : Math.round(interval * ease);
      stage += 1;
      break;
    case "easy":
      interval = stage === 0 ? 3 : Math.round(interval * ease * 1.3);
      ease = clampEase(ease + 0.15);
      stage += 1;
      break;
    default:
      break;
  }

  interval = Math.min(MAX_INTERVAL, Math.max(0, interval));
  const dueAt = new Date(
    now.getTime() + (interval === 0 ? 10 * 60 * 1000 : interval * 24 * 60 * 60 * 1000),
  ).toISOString();

  return { stage, ease, interval, reps: reps + 1, lapses, dueAt };
}

/** Words that survive a few long intervals count as known. */
function statusForCard(card) {
  if (Number(card.interval) >= 21 && Number(card.stage) >= 3) return "known";
  return "learning";
}

const DEFAULT_CARD = { stage: 0, ease: 2.5, interval: 0, reps: 0, lapses: 0 };

module.exports = { RATINGS, DEFAULT_CARD, nextCard, statusForCard, MAX_INTERVAL, MIN_EASE, MAX_EASE };