// Tests for the shared text-splitting helpers (lib/text-split.mjs).
// Covers: (a) Chinese paragraph pagination, (b) English long paragraphs never
// split mid-word, (c) mixed CN/EN protects embedded English words,
// (d) hard-wrap hyphenation cleanup. Run: node test-text-split.mjs
import {
  classifyText, isMostlyLatinText, isMostlyCjkText,
  isBadLatinPageStart, snapLatinBreakOffset,
  findPageBreakOffset, findChunkBreakLength, dehyphenateWrap,
} from './lib/text-split.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  if (cond) { pass++; console.log('  ✓', name); }
  else { fail++; console.log('  ✗', name, extra ? `— ${extra}` : ''); }
};
const isWord = ch => !!ch && /[A-Za-z0-9]/.test(ch);

// Simulate the reader's page loop on one paragraph: fill `budget` chars per
// page using the same advise-then-progress contract the UI uses.
function paginate(text, budget) {
  const pages = [];
  let offset = 0, guard = 0;
  while (offset < text.length) {
    if (++guard > 100000) throw new Error('pagination deadlock');
    let best = Math.min(text.length, offset + budget);
    if (best < text.length) {
      const snapped = findPageBreakOffset(text, best, offset);
      if (snapped > offset && snapped <= best) best = snapped;
    }
    if (best <= offset) best = Math.min(text.length, offset + 1); // forward-progress guarantee
    pages.push(text.slice(offset, best));
    offset = best;
  }
  return pages;
}

// ── (a) Chinese paragraph pagination ─────────────────────────────────────────
console.log('\n--- (a) Chinese / CJK pagination ---');
const zh = '这是一段中文文本，用来测试分页是否正常。' + '中文没有空格，应该按字符切分，'.repeat(6) + '结尾。';
ok('classified as cjk', classifyText(zh) === 'cjk');
ok('isMostlyCjkText', isMostlyCjkText(zh) === true);
const zhPages = paginate(zh, 20);
ok('cjk: pages cover full text', zhPages.join('') === zh, `got ${zhPages.join('').length}/${zh.length}`);
ok('cjk: every page non-empty', zhPages.every(p => p.length > 0));
ok('cjk: makes progress (>1 page for long text)', zhPages.length > 1);

// ── (b) English long paragraph: never split mid-word ─────────────────────────
console.log('\n--- (b) English never splits mid-word ---');
const en = 'I could only stand and stare at the horizon, of course, while the waves kept rolling in one after another without any sign of stopping at all today.';
ok('classified as latin', classifyText(en) === 'latin');
ok('isMostlyLatinText', isMostlyLatinText(en) === true);
const enPages = paginate(en, 30);
ok('en: pages cover full text', enPages.join('') === en);
let midWord = false, leadPunct = false;
for (let i = 1; i < enPages.length; i++) {
  const prevLast = enPages[i - 1].slice(-1);
  const curFirst = enPages[i][0];
  if (isWord(prevLast) && isWord(curFirst)) midWord = true;          // word cut across pages
  if (isWord(prevLast) && /[,.;:!?]/.test(curFirst)) leadPunct = true; // punctuation at line start
}
ok('en: no page starts mid-word', midWord === false);
ok('en: no page starts with trailing punctuation', leadPunct === false);
ok('en: multiple pages produced', enPages.length > 1);

// giant word with no spaces must still progress (fallback, no deadlock)
const giant = 'x'.repeat(500);
const giantPages = paginate(giant, 30);
ok('giant word: covered & progressed', giantPages.join('') === giant && giantPages.length > 1);

// ── (c) Mixed CN/EN protects embedded English words ──────────────────────────
console.log('\n--- (c) Mixed text protects English words ---');
const mixed = '他说 internationalization 这个词 ' + '很长很难 supercalifragilistic 表达，'.repeat(4) + '完毕。';
ok('classified as mixed or cjk (not latin)', classifyText(mixed) !== 'latin');
// Budget must exceed the longest single word; a word longer than a whole page
// is physically unsplittable and is handled by the char-split fallback.
const mixedPages = paginate(mixed, 40);
ok('mixed: pages cover full text', mixedPages.join('') === mixed);
let mixedMidWord = false;
for (let i = 1; i < mixedPages.length; i++) {
  if (isWord(mixedPages[i - 1].slice(-1)) && isWord(mixedPages[i][0])) mixedMidWord = true;
}
ok('mixed: embedded English not split mid-word', mixedMidWord === false);
ok('mixed: pages all non-empty & progressed', mixedPages.every(p => p.length > 0) && mixedPages.length > 1);

// ── (d) Hyphenation cleanup ──────────────────────────────────────────────────
console.log('\n--- (d) Hard-wrap hyphenation cleanup ---');
ok('some-\\nthing -> something', dehyphenateWrap('some-\nthing') === 'something');
ok('joins across spaces after newline', dehyphenateWrap('under-\n  standing') === 'understanding');
ok('keeps real hyphenated word "well-known"', dehyphenateWrap('well-known') === 'well-known');
ok('does not touch spaced dash " - "', dehyphenateWrap('a - b') === 'a - b');
ok('does not touch em dash', dehyphenateWrap('wait—\nno') === 'wait—\nno');
ok('keeps hyphen before capital (compound)', dehyphenateWrap('Sino-\nJapanese') === 'Sino-\nJapanese');
ok('no-op when no hyphen', dehyphenateWrap('plain text') === 'plain text');

// ── chunk-level (MCP read_range) boundary snapping ───────────────────────────
console.log('\n--- chunk boundary (MCP read_range) ---');
const para = 'The quick brown fox jumps over the lazy dog. Then it runs away quickly into the woods.';
const cut = 30; // lands inside "jumps"
const len = findChunkBreakLength(para, cut);
ok('chunk: length within budget', len <= cut && len >= 1);
ok('chunk: does not end mid-word', !(isWord(para[len - 1]) && isWord(para[len])), `len=${len} around="${para.slice(len-2, len+2)}"`);
ok('chunk: no-boundary run falls back to full length', findChunkBreakLength('x'.repeat(1500), 1000) === 1000);

console.log(`\n=== Results: ${pass} passed, ${fail} failed ===`);
process.exit(fail ? 1 : 0);
