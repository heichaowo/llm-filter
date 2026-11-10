import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/server.mjs';

let upstream, filter, received, filterUrl;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'llm-filter-'));
const rulesPath = path.join(dir, 'rules.json');
const logPath = path.join(dir, 'filter.jsonl');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

before(async () => {
  const rules = JSON.parse(fs.readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
  rules.terms.block = ['禁词'];
  fs.writeFileSync(rulesPath, JSON.stringify(rules));
  // Fake upstream: records what it got, answers with an SSE stream.
  upstream = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      received = { url: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() };
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: a\ndata: 1\n\n');
      setTimeout(() => res.end('event: b\ndata: 2\n\n'), 20);
    });
  });
  const upPort = await listen(upstream);
  filter = createServer({ upstream: `http://127.0.0.1:${upPort}`, rulesPath, logPath });
  filterUrl = `http://127.0.0.1:${await listen(filter)}`;
});
after(() => { filter.close(); upstream.close(); fs.unwatchFile(rulesPath); });

const post = (body) => fetch(`${filterUrl}/v1/messages`, {
  method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': 'k' }, body: JSON.stringify(body),
});

test('forwards filtered body with headers, streams response back', async () => {
  received = null;
  const res = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: '电话 13812345678' }] });
  assert.equal(await res.text(), 'event: a\ndata: 1\n\nevent: b\ndata: 2\n\n');
  assert.equal(received.url, '/v1/messages');
  assert.equal(received.headers['x-api-key'], 'k');
  assert.equal(JSON.parse(received.body).messages[0].content, '电话 [手机号]');
  assert.equal(Number(received.headers['content-length']), Buffer.byteLength(received.body));
});

test('blocked request never reaches upstream, gets a valid SSE reply', async () => {
  received = null;
  const res = await post({ model: 'm', stream: true, messages: [{ role: 'user', content: '有禁词' }] });
  const text = await res.text();
  assert.equal(received, null);
  assert.match(text, /event: message_start/);
  assert.match(text, /"text":"NO_REPLY"/);
  assert.match(text, /event: message_stop/);
});

test('blocked non-stream request gets a JSON message', async () => {
  const res = await post({ model: 'm', messages: [{ role: 'user', content: '有禁词' }] });
  const msg = await res.json();
  assert.equal(msg.content[0].text, 'NO_REPLY');
  assert.equal(msg.stop_reason, 'end_turn');
});

test('log has rule ids, never prompt text', async () => {
  await new Promise((r) => setTimeout(r, 50));
  const log = fs.readFileSync(logPath, 'utf8');
  assert.match(log, /"phone_cn":1/);
  assert.doesNotMatch(log, /13812345678|禁词/);
});

test('health endpoint', async () => {
  const res = await fetch(`${filterUrl}/__filter/health`);
  assert.equal((await res.json()).ok, true);
});
