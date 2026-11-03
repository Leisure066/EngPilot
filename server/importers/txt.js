"use strict";

/**
 * Parser for the "one word per line" txt files.
 *
 * Supported (automatically detected, no flag needed):
 *   apple
 *   apple<TAB>苹果
 *   apple  苹果
 *   1. apple /ˈæpl/ n. 苹果
 *   apple, n. 苹果
 *
 * The parser is deliberately forgiving: unknown trailing text becomes the
 * translation, and lines it cannot make sense of are reported as errors
 * instead of failing the whole file.
 */

const MAX_LINES = 5000;
const MAX_WORD_LENGTH = 64;
const MAX_TRANSLATION_LENGTH = 300;

// One headword token: letters, digits (mp3), apostrophes and hyphens
// (sitting-room). Spaces are handled separately: TAB wins as a separator,
// otherwise a single token is taken so "apple n. 苹果" keeps n. as its POS.
const WORD_CHARS = /^[A-Za-z][A-Za-z0-9'’\-]*/;
const VALID_WORD = /^[A-Za-z][A-Za-z0-9'’\- ]*$/;
const LEADING_INDEX = /^\s*\d+\s*[.、)．:：]\s+/;
const IPA = /^\/[^/\n]{1,60}\/\s*/;
const POS = /^(v\.aux\.?|n\.|vt\.|vi\.|v\.|a\.|ad\.|adv\.|adj\.|prep\.|conj\.|pron\.|num\.|art\.|int\.|aux\.|abbr\.)\s*((?:[/&]\s*)(v\.aux\.?|n\.|vt\.|vi\.|v\.|a\.|ad\.|adv\.|adj\.|prep\.|conj\.|pron\.|num\.|art\.|int\.|aux\.|abbr\.)\s*)*/i;
const LEADING_PUNCT = /^[\s,，;；:：\-–—、.]+/;

function decodeBuffer(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString("utf8"), encoding: "utf-8" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return { text: new TextDecoder("utf-16le").decode(buffer.subarray(2)), encoding: "utf-16le" };
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return { text: new TextDecoder("utf-16be").decode(buffer.subarray(2)), encoding: "utf-16be" };
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    return { text, encoding: "utf-8" };
  } catch {
    // Not valid UTF-8; Chinese users very often save txt as GBK.
  }
  try {
    return { text: new TextDecoder("gbk").decode(buffer), encoding: "gbk" };
  } catch {
    return { text: buffer.toString("utf8"), encoding: "utf-8" };
  }
}

function parseEntry(line) {
  let content = line.trim();
  if (!content) return null;

  content = content.replace(LEADING_INDEX, "").trim();
  if (!content) return null;
  if (!/[A-Za-z]/.test(content)) {
    return { error: "这一行没有英文单词" };
  }

  let wordPart = content;
  let restPart = "";
  const tabIndex = content.indexOf("\t");
  if (tabIndex !== -1) {
    wordPart = content.slice(0, tabIndex).trim();
    restPart = content.slice(tabIndex + 1);
  } else {
    const wordMatch = content.match(WORD_CHARS);
    if (!wordMatch) return { error: "这一行不是合法的英文单词" };
    wordPart = wordMatch[0];
    restPart = content.slice(wordMatch[0].length);
  }

  const headword = wordPart.trim();
  if (!headword) return { error: "这一行不是合法的英文单词" };
  if (headword.length > MAX_WORD_LENGTH) return { error: "单词过长" };
  if (!VALID_WORD.test(headword)) return { error: "单词包含不支持的字符" };

  let rest = restPart.replace(LEADING_PUNCT, "");

  let phonetic = "";
  const ipaMatch = rest.match(IPA);
  if (ipaMatch) {
    phonetic = ipaMatch[0].trim();
    rest = rest.slice(ipaMatch[0].length).replace(LEADING_PUNCT, "");
  }

  let pos = "";
  const posMatch = rest.match(POS);
  if (posMatch) {
    pos = posMatch[0].trim().replace(/\s*&\s*/g, " / ").replace(/\s*\/\s*/g, " / ");
    rest = rest.slice(posMatch[0].length).replace(LEADING_PUNCT, "");
  }

  const translation = rest.trim().slice(0, MAX_TRANSLATION_LENGTH);
  return { headword, translation, phonetic, pos };
}

/**
 * @returns {{encoding:string, totalLines:number, entries:Array, invalid:Array, truncated:boolean}}
 */
function parseTxt(buffer, { maxLines = MAX_LINES } = {}) {
  const { text, encoding } = decodeBuffer(buffer);
  const lines = text.split(/\r\n|\r|\n/);
  const entries = [];
  const invalid = [];
  let considered = 0;
  let truncated = false;

  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1;
    const raw = lines[index].replace(/^\uFEFF/, "").trim();
    if (!raw) continue;
    if (raw.startsWith("#") || raw.startsWith("//")) continue;
    considered += 1;
    if (considered > maxLines) {
      truncated = true;
      break;
    }
    const parsed = parseEntry(raw);
    if (!parsed) continue;
    if (parsed.error) {
      if (invalid.length < 100) invalid.push({ line: lineNo, raw: raw.slice(0, 120), reason: parsed.error });
      continue;
    }
    entries.push({
      line: lineNo,
      headword: parsed.headword,
      normalized: parsed.headword.toLowerCase(),
      translation: parsed.translation,
      phonetic: parsed.phonetic,
      pos: parsed.pos,
    });
  }

  return { encoding, totalLines: considered, entries, invalid, truncated };
}

module.exports = { parseTxt, parseEntry, decodeBuffer, MAX_LINES };