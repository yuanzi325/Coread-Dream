// Shared, dependency-free text-splitting helpers used by both the web reader
// (web/StudyApp.tsx) and the MCP tools (lib/mcp-tools.mjs).
//
// Design goals:
//   • CJK (Chinese/Japanese/Korean) text has no spaces, so it is paginated at
//     the character level, with a light preference for breaking after CJK
//     punctuation.
//   • English/Latin text must never split a word across a page/chunk boundary,
//     and a page/chunk should not start with trailing punctuation. We prefer a
//     sentence boundary, then a word boundary.
//   • Mixed text is handled conservatively: embedded English words are still
//     protected, while CJK runs keep character-level breaks.
//   • Every helper only *advises* a break point. Callers re-validate (layout
//     fit on the web, byte budget in MCP) and fall back to the raw offset, so
//     pagination always makes forward progress — no empty pages, no deadlock on
//     a single very long word.

// CJK punctuation, Hiragana, Katakana, CJK ideographs (+ ext A / compat),
// fullwidth forms and Hangul.
export const CJK_RE = /[　-〿぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿＀-￯가-힯]/;
// Latin "trailing" punctuation that should never start a line/chunk.
export const LATIN_TRAILING_PUNCT = /[,.;:!?)\]}"'”’]/;
// Latin sentence-ending punctuation (preferred chunk boundary).
const LATIN_SENTENCE_END = /[.?!;:]/;
// CJK sentence/clause punctuation (preferred CJK break, kept on current page).
const CJK_PUNCT = /[。！？；，、：]/;

export function isLatinSpace(ch) {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ' ';
}

// Word characters: latin letters/digits + latin-1/extended + intra-word marks
// (apostrophe, hyphen) so "don't" and "well-known" count as one word.
export function isLatinWordChar(ch) {
  if (!ch) return false;
  return /[A-Za-z0-9À-ɏ'’\-]/.test(ch);
}

// Classify a paragraph as 'latin', 'cjk' or 'mixed' from a leading sample.
export function classifyText(text) {
  const sample = text.length > 400 ? text.slice(0, 400) : text;
  let cjk = 0, latin = 0;
  for (const ch of sample) {
    if (CJK_RE.test(ch)) cjk++;
    else if (/[A-Za-z]/.test(ch)) latin++;
  }
  if (cjk === 0 && latin === 0) return 'latin';
  if (cjk > 0 && latin > 0) {
    if (cjk <= latin * 0.15) return 'latin';
    if (latin <= cjk * 0.15) return 'cjk';
    return 'mixed';
  }
  return cjk > 0 ? 'cjk' : 'latin';
}

export function isMostlyLatinText(text) { return classifyText(text) === 'latin'; }
export function isMostlyCjkText(text) { return classifyText(text) === 'cjk'; }

// A break at index `b` is bad if it sits inside a word (word char on both
// sides) or the next page would open with trailing punctuation glued to the
// previous word (e.g. ", of course").
export function isBadLatinPageStart(text, b) {
  if (b <= 0 || b >= text.length) return false;
  const prev = text[b - 1], cur = text[b];
  if (isLatinWordChar(prev) && isLatinWordChar(cur)) return true;
  if (isLatinWordChar(prev) && LATIN_TRAILING_PUNCT.test(cur)) return true;
  return false;
}

// Move a break index back to the nearest clean word start (char after a space,
// not itself a space or trailing punctuation). Returns the original `b` if no
// clean earlier boundary exists (e.g. one giant word).
export function snapLatinBreakOffset(text, b) {
  for (let i = b; i > 0; i--) {
    const prev = text[i - 1], cur = text[i];
    if (isLatinSpace(prev) && cur !== undefined && !isLatinSpace(cur) && !LATIN_TRAILING_PUNCT.test(cur)) {
      return i;
    }
  }
  return b;
}

// Nearest word start (> floor, <= b) that begins a new sentence (preceded,
// across any spaces, by sentence-ending punctuation). Returns -1 if none.
function snapLatinSentenceOffset(text, b, floor) {
  for (let i = b; i > floor; i--) {
    const cur = text[i];
    if (cur === undefined || isLatinSpace(cur) || LATIN_TRAILING_PUNCT.test(cur)) continue;
    let k = i - 1;
    while (k > floor && isLatinSpace(text[k])) k--;
    if (k >= floor && LATIN_SENTENCE_END.test(text[k])) return i;
  }
  return -1;
}

// ── Page-level breaks (web reader) ───────────────────────────────────────────
// Fixed-height pages: protect Latin words; only nudge CJK onto punctuation when
// it's very close, so existing Chinese pagination is essentially unchanged.

const CJK_PAGE_WINDOW = 8;

export function findCjkPageBreak(text, best, start, window = CJK_PAGE_WINDOW) {
  if (!(best > start && best < text.length)) return best;
  const floor = Math.max(start + 1, best - window);
  for (let i = best; i >= floor; i--) {
    if (CJK_PUNCT.test(text[i - 1]) && !CJK_PUNCT.test(text[i])) return i;
  }
  return best;
}

export function findLatinPageBreak(text, best, start) {
  if (!(best > start && best < text.length)) return best;
  if (!isBadLatinPageStart(text, best)) return best; // already a clean boundary
  const w = snapLatinBreakOffset(text, best);
  if (w > start && w < best) return w;
  return best; // giant word: caller keeps the character split
}

// Unified page break used by the web reader.
//
// Word protection comes first and applies to *any* script: even a mostly-CJK
// paragraph can contain an embedded English word that must not be sliced. Only
// when the break isn't cutting a Latin word do we apply the light CJK
// punctuation nudge, so existing Chinese pagination stays essentially the same.
export function findPageBreakOffset(text, best, start) {
  if (!(best > start && best < text.length)) return best;
  if (isBadLatinPageStart(text, best)) {
    const w = snapLatinBreakOffset(text, best);
    if (w > start && w < best) return w;
    return best; // giant word with no earlier boundary: keep the char split
  }
  if (classifyText(text) === 'cjk') return findCjkPageBreak(text, best, start);
  return best;
}

// ── Chunk-level breaks (MCP read_range) ──────────────────────────────────────
// Large character budgets: prefer a sentence boundary, then a word boundary,
// within a bounded look-back so we never throw away too much of the chunk.
// Returns a length in [1, len]; returns `len` unchanged when nothing better is
// found (e.g. a single very long token), which keeps continuation offsets valid.

export function findChunkBreakLength(text, len, opts = {}) {
  if (len <= 0 || len >= text.length) return len;
  const kind = classifyText(text);

  if (kind === 'cjk') {
    const floor = Math.max(1, Math.floor(len * 0.5));
    for (let i = len; i >= floor; i--) {
      if (CJK_PUNCT.test(text[i - 1])) return i; // keep punctuation on this chunk
    }
    return len;
  }

  // latin / mixed: sentence boundary first, then word boundary.
  const sentenceFloor = Math.max(1, Math.floor(len * 0.6));
  const s = snapLatinSentenceOffset(text, len, sentenceFloor);
  if (s > 0 && s <= len) return s;

  const wordFloor = Math.max(1, Math.floor(len * 0.85));
  for (let i = len; i > wordFloor; i--) {
    if (isLatinSpace(text[i - 1]) && !isLatinSpace(text[i]) && !LATIN_TRAILING_PUNCT.test(text[i])) {
      return i;
    }
  }
  return len;
}

// ── Hyphenation cleanup ──────────────────────────────────────────────────────
// Repair words split by a hard line break, e.g. "some-\nthing" -> "something".
// Conservative: only when a lowercase continuation follows, so normal hyphenated
// words ("well-known"), em dashes ("—") and spaced dashes (" - ") are untouched.
export function dehyphenateWrap(text) {
  if (!text || text.indexOf('-') === -1) return text;
  return text.replace(/([A-Za-zÀ-ÿ])-\n[ \t]*([a-zà-ÿ])/g, '$1$2');
}
