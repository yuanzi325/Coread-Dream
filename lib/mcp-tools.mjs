import { getDb, getImageDir } from './db.mjs';
import { parseEpub, extractImages, extractCover, smartSplit } from './epub.mjs';
import { findChunkBreakLength } from './text-split.mjs';
import fs from 'fs';
import path from 'path';

const CHAPTER_RE = /^第[\d一二三四五六七八九十百千万]+[章节回]|^#|^Chapter\s+\d/i;

export const tools = [
  {
    name: 'list_books',
    description: 'List all books in the co-reading library',
    inputSchema: { type: 'object', properties: {}, required: [] },
  },
  {
    name: 'read_book',
    description: 'Read a section of a book by page number',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        page: { type: 'number', description: 'Page number (default 1)' },
        per_page: { type: 'number', description: 'Paragraphs per page (default 10)' },
      },
      required: ['book_id'],
    },
  },
  {
    name: 'add_comment',
    description: 'Add a comment/annotation to a paragraph in a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        paragraph_idx: { type: 'number', description: 'Paragraph index to comment on' },
        content: { type: 'string', description: 'Comment text' },
        from_who: { type: 'string', description: 'Who is commenting (default: "ai")' },
        selected_text: { type: 'string', description: 'Optional: highlighted text from the paragraph' },
        reply_to: { type: 'number', description: 'Optional: comment ID to reply to' },
      },
      required: ['book_id', 'paragraph_idx', 'content'],
    },
  },
  {
    name: 'list_comments',
    description: 'List all comments for a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
      },
      required: ['book_id'],
    },
  },
  {
    name: 'get_toc',
    description: 'Get the table of contents for a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
      },
      required: ['book_id'],
    },
  },
  {
    name: 'import_book',
    description: 'Import a book from text content or epub (base64)',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Book title' },
        content: { type: 'string', description: 'Plain text content (for text import)' },
        format: { type: 'string', description: '"epub" for epub import' },
        data: { type: 'string', description: 'Base64-encoded epub file data' },
      },
      required: ['title'],
    },
  },
  {
    name: 'delete_comment',
    description: 'Delete a comment by ID',
    inputSchema: {
      type: 'object',
      properties: { comment_id: { type: 'number', description: 'Comment ID to delete' } },
      required: ['comment_id'],
    },
  },
  {
    name: 'update_progress',
    description: 'Update reading progress for a book',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        page: { type: 'number', description: 'Current page number' },
      },
      required: ['book_id', 'page'],
    },
  },
  {
    name: 'get_chapters',
    description: 'Get chapter list with paragraph index ranges for a book (token-efficient co-reading)',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
      },
      required: ['book_id'],
    },
  },
  {
    name: 'read_range',
    description: 'Read a paragraph index range of a book, with max_chars to control token usage',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        start_idx: { type: 'number', description: 'Starting paragraph index (inclusive)' },
        end_idx: { type: 'number', description: 'Ending paragraph index (inclusive)' },
        max_chars: { type: 'number', description: 'Max characters to return (default 8000, min 1000, max 20000)' },
        include_comments: { type: 'boolean', description: 'Include comments in the returned range (default true)' },
        start_offset: { type: 'number', description: 'Character offset within the first paragraph (default 0). Pass partial_next_offset from a previous partial response to continue reading a long paragraph.' },
      },
      required: ['book_id', 'start_idx', 'end_idx'],
    },
  },
  {
    name: 'reading_note',
    description: 'Get or update a per-book reading note for context recovery in co-reading sessions',
    inputSchema: {
      type: 'object',
      properties: {
        book_id: { type: 'number', description: 'Book ID' },
        action: { type: 'string', description: '"get", "update", or "append"' },
        content: { type: 'string', description: 'Note content (required for update/append)' },
      },
      required: ['book_id', 'action'],
    },
  },
  {
    name: 'ping',
    description: 'Minimal connectivity check. Returns the message back (or "pong") with a timestamp. Use this to tell transport problems apart from business-tool problems.',
    inputSchema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'Optional message to echo back' },
      },
      required: [],
    },
  },
];

export function handleTool(name, args) {
  switch (name) {
    case 'list_books': {
      const db = getDb(true);
      const books = db.prepare('SELECT b.id, b.title, b.total_paragraphs, b.created_at, b.cover_image, p.page as current_page FROM books b LEFT JOIN book_progress p ON b.id = p.book_id ORDER BY b.created_at DESC').all();
      const counts = db.prepare('SELECT book_id, COUNT(*) as count FROM book_comments GROUP BY book_id').all();
      db.close();
      const countMap = {};
      for (const c of counts) countMap[c.book_id] = c.count;
      return books.map(b => ({ ...b, comment_count: countMap[b.id] || 0 }));
    }
    case 'read_book': {
      const { book_id, page = 1, per_page = 10 } = args;
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(book_id);
      if (!book) { db.close(); return { error: 'Book not found' }; }
      const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(book_id);
      const pages = [];
      let cur = [], curWeight = 0;
      for (const p of paras) {
        if (CHAPTER_RE.test(p.content.trim().substring(0, 60)) && cur.length > 0) { pages.push(cur); cur = []; curWeight = 0; }
        const lines = Math.max(1, Math.ceil(p.content.length / 22));
        if (curWeight + lines > per_page && cur.length > 0) { pages.push(cur); cur = []; curWeight = 0; }
        cur.push(p); curWeight += lines;
      }
      if (cur.length > 0) pages.push(cur);
      const totalPages = pages.length || 1;
      const p = Math.max(1, Math.min(page, totalPages));
      const pageParas = pages[p - 1] || [];
      const idxSet = new Set(pageParas.map(x => x.idx));
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, created_at').all(book_id)
        .filter(c => idxSet.has(c.paragraph_idx));
      db.close();
      const text = pageParas.map(x => `[${x.idx}] ${x.content}`).join('\n\n');
      const commentText = comments.length ? '\n---\nComments on this page:\n' + comments.map(c => `  [${c.from_who}@${c.paragraph_idx}] ${c.selected_text ? `"${c.selected_text}" → ` : ''}${c.content}`).join('\n') : '';
      return { book: book.title, page: p, totalPages, text: text + commentText };
    }
    case 'add_comment': {
      const { book_id, paragraph_idx, content, from_who = 'ai', selected_text, reply_to } = args;
      const db = getDb();
      let startIdx = null, endIdx = null;
      if (selected_text) {
        const para = db.prepare('SELECT content FROM book_paragraphs WHERE book_id = ? AND idx = ?').get(book_id, paragraph_idx);
        if (para?.content) { const i = para.content.indexOf(selected_text); if (i >= 0) { startIdx = i; endIdx = i + selected_text.length; } }
      }
      const result = db.prepare('INSERT INTO book_comments (book_id, paragraph_idx, sel_start_idx, sel_end_idx, selected_text, from_who, content, reply_to) VALUES (?,?,?,?,?,?,?,?)').run(book_id, paragraph_idx, startIdx, endIdx, selected_text || null, from_who, content, reply_to || null);
      db.close();
      return { ok: true, id: Number(result.lastInsertRowid) };
    }
    case 'list_comments': {
      const { book_id } = args;
      const db = getDb(true);
      const comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? ORDER BY paragraph_idx, created_at').all(book_id);
      db.close();
      return comments;
    }
    case 'get_toc': {
      const { book_id } = args;
      const db = getDb(true);
      const paras = db.prepare('SELECT idx, substr(content, 1, 100) as content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(book_id);
      db.close();
      const chapters = [];
      for (const p of paras) {
        if (CHAPTER_RE.test(p.content.trim())) {
          chapters.push({ idx: p.idx, title: p.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60) });
        }
      }
      return chapters;
    }
    case 'import_book': {
      const { title, content, format, data } = args;
      let paragraphs = [];
      let epubResult = null;
      if (format === 'epub' && data) { epubResult = parseEpub(data); paragraphs = epubResult.paragraphs; }
      else if (content) { paragraphs = smartSplit(content); }
      else return { error: 'content or epub data required' };
      if (!paragraphs.length) return { error: 'no paragraphs extracted' };
      const db = getDb();
      const r = db.prepare('INSERT INTO books (title, total_paragraphs) VALUES (?, ?)').run(title, paragraphs.length);
      const bookId = Number(r.lastInsertRowid);
      const ins = db.prepare('INSERT INTO book_paragraphs (book_id, idx, content) VALUES (?, ?, ?)');
      db.transaction(() => { for (let i = 0; i < paragraphs.length; i++) ins.run(bookId, i, paragraphs[i]); })();
      db.close();
      if (epubResult) {
        const imgDir = getImageDir(bookId);
        const images = extractImages(epubResult.zip, epubResult.epubImageMap, paragraphs);
        for (const [fname, d] of images) fs.writeFileSync(path.join(imgDir, fname), d);
        const cover = extractCover(epubResult.zip, epubResult.epubCoverFile);
        if (cover) {
          fs.writeFileSync(path.join(imgDir, cover.name), cover.data);
          const db2 = getDb();
          db2.prepare('UPDATE books SET cover_image = ? WHERE id = ?').run(cover.name, bookId);
          db2.close();
        }
      }
      return { ok: true, book_id: bookId, paragraphs: paragraphs.length };
    }
    case 'delete_comment': {
      const db = getDb();
      db.prepare('DELETE FROM book_comments WHERE id = ?').run(args.comment_id);
      db.close();
      return { ok: true };
    }
    case 'update_progress': {
      const db = getDb();
      db.prepare("INSERT INTO book_progress (book_id, page, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET page = ?, updated_at = datetime('now')").run(args.book_id, args.page, args.page);
      db.close();
      return { ok: true };
    }
    case 'get_chapters': {
      const { book_id } = args;
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(book_id);
      if (!book) { db.close(); return { error: 'Book not found' }; }
      const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? ORDER BY idx').all(book_id);
      db.close();
      if (!paras.length) return { chapters: [{ title: '全文', start_idx: 0, end_idx: 0, page: 1 }], total_chapters: 1, total_pages: 1 };

      // Compute page breaks (same algorithm as read_book default per_page=10)
      const per_page = 10;
      const pages = [];
      let cur = [], curWeight = 0;
      for (const p of paras) {
        if (CHAPTER_RE.test(p.content.trim().substring(0, 60)) && cur.length > 0) { pages.push(cur); cur = []; curWeight = 0; }
        const lines = Math.max(1, Math.ceil(p.content.length / 22));
        if (curWeight + lines > per_page && cur.length > 0) { pages.push(cur); cur = []; curWeight = 0; }
        cur.push(p); curWeight += lines;
      }
      if (cur.length > 0) pages.push(cur);
      const totalPages = pages.length || 1;

      // Build idx -> page number map
      const idxToPage = {};
      for (let i = 0; i < pages.length; i++) {
        for (const p of pages[i]) idxToPage[p.idx] = i + 1;
      }

      // Find chapter header paragraphs
      const chapterStarts = paras.filter(p => CHAPTER_RE.test(p.content.trim().substring(0, 60)));
      if (!chapterStarts.length) {
        return {
          chapters: [{ title: '全文', start_idx: paras[0].idx, end_idx: paras[paras.length - 1].idx, page: 1 }],
          total_chapters: 1,
          total_pages: totalPages,
        };
      }

      const chapters = chapterStarts.map((p, i) => {
        const endIdx = i + 1 < chapterStarts.length
          ? chapterStarts[i + 1].idx - 1
          : paras[paras.length - 1].idx;
        const title = p.content.trim().split('\n')[0].replace(/^#+\s*/, '').slice(0, 60);
        return { title, start_idx: p.idx, end_idx: endIdx, page: idxToPage[p.idx] || 1 };
      });
      return { chapters, total_chapters: chapters.length, total_pages: totalPages };
    }
    case 'read_range': {
      const { book_id, start_idx, end_idx, max_chars: rawMax = 8000, include_comments = true, start_offset = 0 } = args;
      const max_chars = Math.max(1000, Math.min(20000, rawMax));
      const db = getDb(true);
      const book = db.prepare('SELECT * FROM books WHERE id = ?').get(book_id);
      if (!book) { db.close(); return { error: 'Book not found' }; }
      const paras = db.prepare('SELECT idx, content FROM book_paragraphs WHERE book_id = ? AND idx >= ? AND idx <= ? ORDER BY idx').all(book_id, start_idx, end_idx);

      const parts = [];
      const returnedIdxs = [];
      let totalChars = 0;
      let truncated = false;
      let next_start_idx = null;
      let returned_start_idx = null;
      let returned_end_idx = start_idx;
      let partial_paragraph = false;
      let partial_start_offset = null;
      let partial_next_offset = null;

      for (let i = 0; i < paras.length; i++) {
        const p = paras[i];
        // start_offset applies only to the very first paragraph of this call
        const rawContent = (i === 0 && start_offset > 0) ? p.content.slice(start_offset) : p.content;
        if (i === 0 && start_offset > 0 && rawContent.length === 0) {
          continue;
        }
        const prefix = `[${p.idx}] `;
        const segment = prefix + rawContent;
        const addedChars = parts.length === 0 ? segment.length : segment.length + 2; // +2 for '\n\n'

        // First paragraph alone exceeds budget → partial in-paragraph slice
        if (parts.length === 0 && segment.length > max_chars) {
          const availableForContent = Math.max(1, max_chars - prefix.length);
          // Snap the cut onto a clean sentence/word (Latin) or punctuation (CJK)
          // boundary so the chunk never ends mid-word. Falls back to the raw
          // length when no boundary fits, keeping partial_next_offset valid and
          // continuation reads gap-free.
          const sliceLen = findChunkBreakLength(rawContent, availableForContent);
          const sliced = rawContent.slice(0, sliceLen);
          parts.push(prefix + sliced);
          returnedIdxs.push(p.idx);
          totalChars = parts[0].length;
          truncated = true;
          next_start_idx = p.idx;
          partial_paragraph = true;
          partial_start_offset = start_offset;
          partial_next_offset = start_offset + sliced.length;
          returned_start_idx = p.idx;
          returned_end_idx = p.idx;
          break;
        }

        // Subsequent paragraph would exceed budget → stop at paragraph boundary
        if (parts.length > 0 && totalChars + addedChars > max_chars) {
          truncated = true;
          next_start_idx = p.idx;
          break;
        }

        parts.push(segment);
        returnedIdxs.push(p.idx);
        totalChars += addedChars;
        if (returned_start_idx === null) returned_start_idx = p.idx;
        returned_end_idx = p.idx;
      }

      const text = parts.join('\n\n');
      const final_returned_start_idx = returned_start_idx ?? start_idx;

      let comments = [];
      if (include_comments && parts.length > 0) {
        if (partial_paragraph) {
          // Partial paragraph: only return comments for that one paragraph
          comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? AND paragraph_idx = ? ORDER BY created_at').all(book_id, final_returned_start_idx);
        } else {
          const returnedIdxSet = new Set(returnedIdxs);
          comments = db.prepare('SELECT * FROM book_comments WHERE book_id = ? AND paragraph_idx >= ? AND paragraph_idx <= ? ORDER BY paragraph_idx, created_at').all(book_id, final_returned_start_idx, returned_end_idx)
            .filter(c => returnedIdxSet.has(c.paragraph_idx));
        }
      }
      db.close();

      return {
        book: book.title,
        start_idx,
        end_idx,
        returned_start_idx: final_returned_start_idx,
        returned_end_idx,
        text,
        chars: text.length,
        truncated,
        next_start_idx: truncated ? next_start_idx : null,
        comments,
        partial_paragraph,
        partial_start_offset,
        partial_next_offset,
      };
    }
    case 'reading_note': {
      const { book_id, action, content } = args;
      if (!['get', 'update', 'append'].includes(action)) {
        return { error: 'action must be "get", "update", or "append"' };
      }
      const db = getDb();
      // Safety net for existing dbs initialized before this feature
      db.exec(`CREATE TABLE IF NOT EXISTS reading_notes (
        book_id INTEGER PRIMARY KEY,
        content TEXT NOT NULL DEFAULT '',
        updated_at TEXT
      )`);

      if (action === 'get') {
        const row = db.prepare('SELECT content, updated_at FROM reading_notes WHERE book_id = ?').get(book_id);
        db.close();
        return { book_id, action, note: row?.content || '', updated_at: row?.updated_at || null };
      }
      if (content == null) { db.close(); return { error: 'content required for update/append' }; }

      if (action === 'update') {
        db.prepare("INSERT INTO reading_notes (book_id, content, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET content = ?, updated_at = datetime('now')").run(book_id, content, content);
      } else {
        // append: add time-stamped separator
        const existing = db.prepare('SELECT content FROM reading_notes WHERE book_id = ?').get(book_id);
        const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
        const newContent = existing?.content ? `${existing.content}\n\n--- ${now} ---\n${content}` : content;
        db.prepare("INSERT INTO reading_notes (book_id, content, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(book_id) DO UPDATE SET content = ?, updated_at = datetime('now')").run(book_id, newContent, newContent);
      }
      const row = db.prepare('SELECT content, updated_at FROM reading_notes WHERE book_id = ?').get(book_id);
      db.close();
      return { book_id, action, note: row.content, updated_at: row.updated_at };
    }
    case 'ping': {
      return { ok: true, message: args.message || 'pong', time: new Date().toISOString() };
    }
    default:
      return { error: `Unknown tool: ${name}` };
  }
}

// ── Tool result formatting (shared by stdio + sse transports) ────────────────
// Conservative MCP tools/call result shape:
//   { structuredContent, content: [{ type:'text', text }], isError? }
// structuredContent carries the full object for machine parsing; content.text is
// a short human-readable summary (never the full JSON dump).

function toStructuredContent(result) {
  // structuredContent must be a JSON object. Wrap arrays/primitives so strict
  // clients don't choke on a top-level array or scalar.
  if (Array.isArray(result)) return { items: result, count: result.length };
  if (result === null || typeof result !== 'object') return { value: result };
  return result;
}

export function summarizeToolResult(name, result) {
  if (result && typeof result === 'object' && result.error) {
    return `Error: ${result.error}`;
  }
  switch (name) {
    case 'ping':
      return result.message || 'pong';
    case 'list_books':
      return `Returned ${Array.isArray(result) ? result.length : 0} books.`;
    case 'list_comments':
      return `Returned ${Array.isArray(result) ? result.length : 0} comments.`;
    case 'get_toc':
      return `Returned ${Array.isArray(result) ? result.length : 0} TOC entries.`;
    case 'get_chapters':
      return `Returned ${result.total_chapters ?? (result.chapters ? result.chapters.length : 0)} chapters across ${result.total_pages ?? '?'} pages.`;
    case 'read_book':
      // Real reading content is the deliverable; return the page text itself.
      return result.text || `${result.book || 'book'} — page ${result.page}/${result.totalPages}.`;
    case 'read_range': {
      const more = result.truncated ? ` (truncated, next_start_idx=${result.next_start_idx})` : '';
      return result.text
        ? result.text + (more ? `\n\n[${more.trim()}]` : '')
        : `${result.book || 'book'} — paragraphs ${result.returned_start_idx}–${result.returned_end_idx}, ${result.chars} chars${more}.`;
    }
    case 'add_comment':
      return `Comment added (id=${result.id}).`;
    case 'delete_comment':
      return 'Comment deleted.';
    case 'update_progress':
      return 'Reading progress updated.';
    case 'import_book':
      return `Imported book_id=${result.book_id}, ${result.paragraphs} paragraphs.`;
    case 'reading_note':
      return `reading_note "${result.action}" for book ${result.book_id} (${(result.note || '').length} chars).`;
    default:
      return typeof result === 'string' ? result : 'OK';
  }
}

// Build the JSON-RPC `result` field for a successful (non-throwing) tool call.
// Note: a returned object carrying an `error` key is surfaced as isError so
// clients can branch on it, while structuredContent still holds the full object.
export function buildToolResult(name, result) {
  const isError = !!(result && typeof result === 'object' && result.error);
  const res = {
    structuredContent: toStructuredContent(result),
    content: [{ type: 'text', text: summarizeToolResult(name, result) }],
  };
  if (isError) res.isError = true;
  return res;
}

// Build the JSON-RPC `result` field when a tool throws.
export function buildToolError(message) {
  return {
    content: [{ type: 'text', text: `Error: ${message}` }],
    isError: true,
  };
}
