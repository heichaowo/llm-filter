// Local filtering reverse proxy: client -> llm-filter -> upstream LLM API.
// Filters JSON POST bodies, streams the upstream response back unchanged.
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import { compile, filterBody } from './filter.mjs';

export function createServer({ upstream, rulesPath, logPath }) {
  const up = new URL(upstream);
  const client = up.protocol === 'https:' ? https : http;
  let rules = compile(JSON.parse(fs.readFileSync(rulesPath, 'utf8')));

  // Hot reload; a broken rules file keeps the last good rules.
  fs.watchFile(rulesPath, { interval: 2000 }, () => {
    try { rules = compile(JSON.parse(fs.readFileSync(rulesPath, 'utf8'))); log({ event: 'rules_reloaded' }); }
    catch (e) { log({ event: 'rules_reload_failed', error: e.message }); }
  });

  // Log rule ids and counts only, never prompt text.
  function log(entry) {
    if (!logPath) return;
    fs.appendFile(logPath, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n', () => {});
  }

  const server = http.createServer((req, res) => {
    if (req.url === '/__filter/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, upstream }));
    }
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body = Buffer.concat(chunks);
      const isJson = (req.headers['content-type'] || '').includes('application/json');
      if (req.method === 'POST' && isJson && body.length) {
        let parsed;
        try { parsed = JSON.parse(body); } catch { parsed = null; }
        if (parsed) {
          const r = filterBody(parsed, rules);
          log({ path: req.url, model: parsed.model, hits: r.hits, blocked: r.blocked });
          if (r.blocked) return replyBlocked(req, res, parsed, rules.blockReply);
          body = Buffer.from(JSON.stringify(r.body));
        }
      }
      forward(req, res, body);
    });
  });

  function forward(req, res, body) {
    const headers = { ...req.headers, host: up.host, 'content-length': String(body.length) };
    delete headers['transfer-encoding'];
    const basePath = up.pathname.replace(/\/$/, '');
    const upReq = client.request({
      protocol: up.protocol, hostname: up.hostname, port: up.port,
      method: req.method, path: basePath + req.url, headers,
    }, (upRes) => {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
    });
    upReq.on('error', (e) => {
      log({ event: 'upstream_error', error: e.message });
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: `llm-filter upstream error: ${e.message}` } }));
    });
    upReq.end(body);
  }

  return server;
}

// Answer a blocked request locally so nothing reaches the upstream.
// Anthropic Messages gets a well-formed reply; other APIs get a 403.
function replyBlocked(req, res, body, text) {
  if (!req.url.split('?')[0].endsWith('/messages')) {
    res.writeHead(403, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: { type: 'blocked', message: 'blocked by llm-filter' } }));
  }
  const id = `msg_filter_${Date.now()}`;
  const message = {
    id, type: 'message', role: 'assistant', model: body.model,
    content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null,
    usage: { input_tokens: 0, output_tokens: 0 },
  };
  if (!body.stream) {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify(message));
  }
  const ev = (type, data) => `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
  res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
  res.end(
    ev('message_start', { message: { ...message, content: [], stop_reason: null } })
    + ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } })
    + ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text } })
    + ev('content_block_stop', { index: 0 })
    + ev('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 0 } })
    + ev('message_stop', {}),
  );
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT || 8079);
  const host = process.env.HOST || '127.0.0.1';
  const upstream = process.env.UPSTREAM || 'http://127.0.0.1:8080';
  const rulesPath = process.env.RULES || new URL('../rules.json', import.meta.url).pathname;
  const logPath = process.env.LOG || new URL('../logs/filter.jsonl', import.meta.url).pathname;
  fs.mkdirSync(new URL('../logs/', import.meta.url).pathname, { recursive: true });
  createServer({ upstream, rulesPath, logPath }).listen(port, host, () => {
    console.log(`llm-filter listening on http://${host}:${port} -> ${upstream}`);
  });
}
