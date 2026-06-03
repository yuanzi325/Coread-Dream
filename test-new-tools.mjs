#!/usr/bin/env node
/**
 * Test script for the three new token-efficient co-reading MCP tools:
 *   get_chapters, read_range, reading_note
 * Also verifies existing tools are unaffected.
 */
import path from 'path';
import { initDb } from './lib/db.mjs';
import { handleTool } from './lib/mcp-tools.mjs';

const DB_PATH = path.join(process.cwd(), 'data', 'coread.db');
initDb(DB_PATH);

let passed = 0;
let failed = 0;

function assert(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed++;
  } else {
    console.error(`  ✗ ${label}${detail ? ': ' + detail : ''}`);
    failed++;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function importSampleBook() {
  // ~30 short paragraphs with two chapter headers so we can test chapter detection
  const lines = [
    '第一章 开端',
    '这是第一章第一段。内容较短。',
    '这是第一章第二段。内容较短。',
    '这是第一章第三段，稍微长一点的文字，用来测试 max_chars 截断逻辑是否正常工作。',
    '这是第一章第四段。',
    '这是第一章第五段。',
    '这是第一章第六段。',
    '这是第一章第七段。',
    '这是第一章第八段。',
    '这是第一章第九段。',
    '第二章 发展',
    '这是第二章第一段。',
    '这是第二章第二段。',
    '这是第二章第三段。',
    '这是第二章第四段。',
    '这是第二章第五段。',
    '这是第二章第六段。',
    '这是第二章第七段。',
    '这是第二章第八段。',
    '这是第二章第九段，也是最后一段。',
  ];
  return handleTool('import_book', { title: '测试书籍_' + Date.now(), content: lines.join('\n\n') });
}

// ── Run tests ─────────────────────────────────────────────────────────────────

console.log('\n=== coread new-tool smoke tests ===\n');

// Setup: import a fresh test book
const importResult = importSampleBook();
assert('import_book succeeds', importResult.ok === true, JSON.stringify(importResult));
const bookId = importResult.book_id;
const totalParas = importResult.paragraphs;
console.log(`  (book_id=${bookId}, paragraphs=${totalParas})\n`);

// ── Test 1: get_chapters ──────────────────────────────────────────────────────
console.log('--- Test 1: get_chapters ---');
const toc = handleTool('get_chapters', { book_id: bookId });
assert('returns chapters array', Array.isArray(toc.chapters));
assert('detects 2 chapters', toc.chapters.length === 2, JSON.stringify(toc.chapters.map(c => c.title)));
assert('total_chapters === 2', toc.total_chapters === 2);
assert('total_pages is a number', typeof toc.total_pages === 'number' && toc.total_pages >= 1);
assert('chapter 1 title contains 开端', toc.chapters[0].title.includes('开端'));
assert('chapter 2 title contains 发展', toc.chapters[1].title.includes('发展'));
assert('chapter 1 start_idx < chapter 2 start_idx', toc.chapters[0].start_idx < toc.chapters[1].start_idx);
assert('chapter 1 end_idx < chapter 2 start_idx', toc.chapters[0].end_idx < toc.chapters[1].start_idx);
assert('chapter 2 end_idx is last para', toc.chapters[1].end_idx === totalParas - 1);

// ── Test 2: read_range with truncation ───────────────────────────────────────
console.log('\n--- Test 2: read_range truncation at paragraph boundary ---');
const ch1 = toc.chapters[0];
const rangeSmall = handleTool('read_range', { book_id: bookId, start_idx: ch1.start_idx, end_idx: ch1.end_idx, max_chars: 100, include_comments: false });
assert('returns book title', typeof rangeSmall.book === 'string');
assert('text is non-empty', rangeSmall.text.length > 0);
assert('chars <= 100 + paragraph overhead', rangeSmall.chars <= 200); // generous bound
assert('truncated is boolean', typeof rangeSmall.truncated === 'boolean');
if (rangeSmall.truncated) {
  assert('next_start_idx is a number when truncated', typeof rangeSmall.next_start_idx === 'number');
  assert('next_start_idx > returned_end_idx', rangeSmall.next_start_idx > rangeSmall.returned_end_idx);
}
assert('text contains [idx] markers', /\[\d+\]/.test(rangeSmall.text));

// ── Test 3: read_range continuation – no overlap, no gap ─────────────────────
console.log('\n--- Test 3: read_range continuation (no overlap, no gap) ---');
const r1 = handleTool('read_range', { book_id: bookId, start_idx: 0, end_idx: totalParas - 1, max_chars: 300, include_comments: false });
let allIdxs = [];
let collectedText = r1.text;
// Extract idx markers from text
const extractIdxs = txt => [...txt.matchAll(/\[(\d+)\]/g)].map(m => Number(m[1]));
allIdxs.push(...extractIdxs(r1.text));

if (r1.truncated && r1.next_start_idx !== null) {
  const r2 = handleTool('read_range', { book_id: bookId, start_idx: r1.next_start_idx, end_idx: totalParas - 1, max_chars: 300, include_comments: false });
  collectedText += r2.text;
  const r2Idxs = extractIdxs(r2.text);
  assert('r2 starts where r1 left off (next_start_idx)', r2.returned_start_idx === r1.next_start_idx,
    `expected ${r1.next_start_idx}, got ${r2.returned_start_idx}`);
  assert('no overlap between r1 and r2', !r2Idxs.some(i => allIdxs.includes(i)),
    `overlap: ${r2Idxs.filter(i => allIdxs.includes(i))}`);
  allIdxs.push(...r2Idxs);
}
assert('at least first para returned in r1', allIdxs.includes(0));

// ── Test 4: include_comments filters to range ────────────────────────────────
console.log('\n--- Test 4: include_comments only returns in-range comments ---');
// Add a comment inside chapter 1 and one outside (chapter 2)
const commentIn = handleTool('add_comment', { book_id: bookId, paragraph_idx: ch1.start_idx, content: 'Comment inside ch1', from_who: 'ai' });
const ch2 = toc.chapters[1];
const commentOut = handleTool('add_comment', { book_id: bookId, paragraph_idx: ch2.start_idx, content: 'Comment inside ch2', from_who: 'ai' });
assert('add_comment in-range ok', commentIn.ok === true);
assert('add_comment out-range ok', commentOut.ok === true);

const rangeWithComments = handleTool('read_range', { book_id: bookId, start_idx: ch1.start_idx, end_idx: ch1.end_idx, max_chars: 8000, include_comments: true });
const commentIds = rangeWithComments.comments.map(c => c.id);
assert('in-range comment present', commentIds.includes(commentIn.id), `ids: ${commentIds}`);
assert('out-of-range comment absent', !commentIds.includes(commentOut.id), `ids: ${commentIds}`);

// ── Test 5: reading_note get/update/append ───────────────────────────────────
console.log('\n--- Test 5: reading_note get/update/append ---');
const n1 = handleTool('reading_note', { book_id: bookId, action: 'get' });
assert('get returns empty note on first call', n1.note === '');
assert('get action echoed', n1.action === 'get');

const n2 = handleTool('reading_note', { book_id: bookId, action: 'update', content: '第一章笔记：讲述了开始。' });
assert('update returns saved note', n2.note === '第一章笔记：讲述了开始。');
assert('update action echoed', n2.action === 'update');
assert('updated_at is set', !!n2.updated_at);

const n3 = handleTool('reading_note', { book_id: bookId, action: 'append', content: '第二章笔记：发展情节。' });
assert('append note contains original', n3.note.includes('第一章笔记'));
assert('append note contains new content', n3.note.includes('第二章笔记'));
assert('append adds separator line', n3.note.includes('---'));

const n4 = handleTool('reading_note', { book_id: bookId, action: 'get' });
assert('get after append returns appended note', n4.note.includes('第二章笔记'));

// ── Test 6: existing tools unaffected ────────────────────────────────────────
console.log('\n--- Test 6: existing tools unaffected ---');
const rb = handleTool('read_book', { book_id: bookId, page: 1, per_page: 10 });
assert('read_book still works', typeof rb.text === 'string' && rb.text.length > 0);
assert('read_book has totalPages', typeof rb.totalPages === 'number');

const ac = handleTool('add_comment', { book_id: bookId, paragraph_idx: 0, content: 'Legacy comment', from_who: 'human' });
assert('add_comment still works', ac.ok === true);

const up = handleTool('update_progress', { book_id: bookId, page: 2 });
assert('update_progress still works', up.ok === true);

const lc = handleTool('list_comments', { book_id: bookId });
assert('list_comments still works', Array.isArray(lc));

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n=== Results: ${passed} passed, ${failed} failed ===\n`);
if (failed > 0) process.exit(1);
