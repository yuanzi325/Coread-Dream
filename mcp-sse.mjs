#!/usr/bin/env node
import http from 'http';
import crypto from 'crypto';
import path from 'path';
import { initDb, getDbPath } from './lib/db.mjs';
import { tools, handleTool, buildToolResult, buildToolError } from './lib/mcp-tools.mjs';

const DB_PATH = process.env.COREAD_DB || path.join(process.cwd(), 'data', 'coread.db');
const PORT = parseInt(process.env.COREAD_MCP_PORT || '3001');
const PROTOCOL_VERSION = '2024-11-05';
const SERVICE = 'coread-mcp';
initDb(DB_PATH);

// sessionId -> { res, createdAt, lastSeen, initialized }
const sessions = new Map();

// ── Logging ──────────────────────────────────────────────────────────────────
// Intentionally conservative: never log epub base64, full book text, full
// tokens, or secrets. Long string args are truncated below.

function ts() { return new Date().toISOString(); }
function log(...args) { console.log(`[${ts()}] [${SERVICE}]`, ...args); }
function logErr(...args) { console.error(`[${ts()}] [${SERVICE}]`, ...args); }

const SENSITIVE_KEYS = new Set(['data', 'token', 'secret', 'password', 'authorization', 'auth']);

// Produce a safe, compact summary of tool arguments for logs.
function summarizeArgs(args) {
  if (!args || typeof args !== 'object') return args;
  const out = {};
  for (const [k, v] of Object.entries(args)) {
    if (SENSITIVE_KEYS.has(k.toLowerCase())) {
      out[k] = typeof v === 'string' ? `<redacted ${v.length} chars>` : '<redacted>';
    } else if (typeof v === 'string') {
      out[k] = v.length > 80 ? `${v.slice(0, 80)}…(${v.length})` : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

// ── JSON-RPC handling ────────────────────────────────────────────────────────

function initializeResult(id) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: 'coread', version: '0.1.0' },
    },
  };
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

// Returns a JSON-RPC response object, or null for notifications / no-reply.
// `session` is the optional session record (for SSE transport state refresh).
function handleJsonRpc(msg, session) {
  if (!msg || typeof msg !== 'object') {
    return jsonRpcError(null, -32600, 'Invalid Request');
  }

  if (msg.method === 'initialize') {
    // Tolerate repeated / out-of-order initialize: always answer with a fresh
    // initialize result and (re)mark the session as initialized.
    if (session) {
      if (session.initialized) log('initialize (repeat) — refreshing session state');
      session.initialized = true;
      session.lastSeen = Date.now();
    } else {
      log('initialize');
    }
    return initializeResult(msg.id);
  }

  if (msg.method === 'notifications/initialized') {
    return null;
  }

  if (msg.method === 'tools/list') {
    log(`tools/list — ${tools.length} tools`);
    return { jsonrpc: '2.0', id: msg.id, result: { tools } };
  }

  if (msg.method === 'tools/call') {
    const params = msg.params || {};
    const { name, arguments: args } = params;
    log('tools/call', JSON.stringify({ tool: name, args: summarizeArgs(args || {}) }));
    try {
      const result = handleTool(name, args || {});
      const rpcResult = buildToolResult(name, result);
      if (rpcResult.isError) {
        logErr(`tools/call FAILED tool=${name} message=${result && result.error}`);
      } else {
        log(`tools/call OK tool=${name}`);
      }
      return { jsonrpc: '2.0', id: msg.id, result: rpcResult };
    } catch (e) {
      logErr(`tools/call THREW tool=${name} message=${e.message}`);
      if (e.stack) logErr(e.stack);
      return { jsonrpc: '2.0', id: msg.id, result: buildToolError(e.message) };
    }
  }

  // ping at JSON-RPC level (some clients send this for keepalive)
  if (msg.method === 'ping') {
    return { jsonrpc: '2.0', id: msg.id, result: {} };
  }

  if (msg.id !== undefined) {
    log(`method not found: ${msg.method}`);
    return jsonRpcError(msg.id, -32601, 'Method not found');
  }
  return null;
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// Read and JSON-parse a request body. Resolves with { msg } or { error }.
function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      if (!body) return resolve({ msg: null });
      try {
        resolve({ msg: JSON.parse(body) });
      } catch (e) {
        resolve({ error: e.message });
      }
    });
    req.on('error', (e) => resolve({ error: e.message }));
  });
}

// ── HTTP server ──────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept, Mcp-Session-Id');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://localhost:${PORT}`);
  const accept = req.headers['accept'] || '';
  const contentType = req.headers['content-type'] || '';
  const headerSessionId = req.headers['mcp-session-id'] || null;

  log('HTTP', JSON.stringify({
    method: req.method,
    pathname: url.pathname,
    accept: accept || '(none)',
    contentType: contentType || '(none)',
    hasSession: !!(headerSessionId || url.searchParams.get('sessionId')),
  }));

  // ── Health check ───────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/health') {
    const dbPath = getDbPath();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      service: SERVICE,
      transport: ['sse', 'streamable-http'],
      time: ts(),
      // Don't leak the full filesystem path; basename is enough to confirm config.
      db: dbPath ? path.basename(dbPath) : null,
      db_configured: !!dbPath,
      tools: tools.length,
      sessions: sessions.size,
    }));
    return;
  }

  // ── SSE endpoint ─────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/sse') {
    const sessionId = crypto.randomUUID();
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'Mcp-Session-Id': sessionId,
    });

    sessions.set(sessionId, { res, createdAt: Date.now(), lastSeen: Date.now(), initialized: false });
    log(`SSE open session=${sessionId} (active=${sessions.size})`);

    const cleanup = () => {
      if (sessions.delete(sessionId)) {
        log(`SSE close session=${sessionId} (active=${sessions.size})`);
      }
    };
    res.on('close', cleanup);
    res.on('error', cleanup);

    res.write(`event: endpoint\ndata: /messages?sessionId=${sessionId}\n\n`);
    return;
  }

  // ── SSE message endpoint ─────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId') || headerSessionId;
    const session = sessionId ? sessions.get(sessionId) : null;
    const { msg, error } = await readJsonBody(req);

    if (error) {
      logErr(`/messages invalid JSON: ${error}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON')));
      return;
    }

    if (!session) {
      // Missing / expired session: respond with a clear JSON-RPC error in the
      // HTTP body (we have no SSE channel to push it over) and log it.
      logErr(`/messages no active transport for sessionId=${sessionId || '(missing)'}`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(
        msg ? msg.id : null,
        -32001,
        sessionId ? 'No active transport for session (expired or unknown sessionId). Reconnect to /sse.'
                  : 'Missing sessionId. Open /sse first and use the returned /messages?sessionId=… endpoint.',
      )));
      return;
    }

    session.lastSeen = Date.now();
    const response = handleJsonRpc(msg, session);
    // Ack over HTTP; actual response is delivered on the SSE channel.
    res.writeHead(202);
    res.end();
    if (response) {
      try {
        sseWrite(session.res, 'message', response);
      } catch (e) {
        logErr(`failed writing to SSE session=${sessionId}: ${e.message}`);
      }
    }
    return;
  }

  // ── Streamable HTTP endpoint (POST /mcp) ─────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/mcp') {
    const { msg, error } = await readJsonBody(req);

    if (error) {
      logErr(`/mcp invalid JSON: ${error}`);
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jsonRpcError(null, -32700, 'Parse error: invalid JSON')));
      return;
    }

    // Stateless streamable-http: track a session id loosely for clients that use
    // it, but never require it for subsequent calls.
    let sessionId = headerSessionId;
    if (msg && msg.method === 'initialize') {
      sessionId = sessionId || crypto.randomUUID();
    }

    const response = handleJsonRpc(msg, null);
    const headers = { 'Content-Type': 'application/json' };
    if (sessionId) headers['Mcp-Session-Id'] = sessionId;

    if (response) {
      res.writeHead(200, headers);
      res.end(JSON.stringify(response));
    } else {
      res.writeHead(202, sessionId ? { 'Mcp-Session-Id': sessionId } : undefined);
      res.end();
    }
    return;
  }

  // GET /mcp — some clients probe this; respond politely instead of 404.
  if (req.method === 'GET' && url.pathname === '/mcp') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, service: SERVICE, hint: 'POST JSON-RPC to this endpoint, or GET /sse for SSE transport.' }));
    return;
  }

  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: 'Not found', service: SERVICE }));
});

server.listen(PORT, () => {
  console.log(`\n  📚 coread MCP server (SSE + Streamable HTTP)`);
  console.log(`  ❤️  Health:           http://localhost:${PORT}/health`);
  console.log(`  🔗 SSE:              http://localhost:${PORT}/sse`);
  console.log(`  🔗 Streamable HTTP:  http://localhost:${PORT}/mcp`);
  console.log(`  📂 Database: ${path.basename(DB_PATH)}\n`);
});
