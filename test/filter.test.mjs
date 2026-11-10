import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { compile, filterBody } from '../src/filter.mjs';

const base = JSON.parse(fs.readFileSync(new URL('../rules.json', import.meta.url), 'utf8'));
const rules = compile(base);
const run = (text, c = rules) => filterBody({ messages: [{ role: 'user', content: text }] }, c).body.messages[0].content;

test('masks PII and secrets', () => {
  const cases = [
    ['我的手机 13812345678 你记一下', '我的手机 [手机号] 你记一下'],
    ['打 +86 138-1234-5678', '打 [手机号]'],
    ['身份证 11010519491231002X', '身份证 [身份证号]'],
    ['卡号 4111 1111 1111 1111', '卡号 [银行卡号]'],
    ['邮箱 a.b@example.co.uk', '邮箱 [邮箱]'],
    ['服务器 10.0.5.109 挂了', '服务器 [IP] 挂了'],
    ['key sk-ant-api03-abcdefghijklmnopqrstuvwxyz', 'key [密钥]'],
    ['token ghp_abcdefghijklmnopqrstuvwxyz0123456789', 'token [密钥]'],
    ['bot 123456789:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'bot [密钥]'],
  ];
  for (const [input, want] of cases) assert.equal(run(input), want, input);
});

test('leaves look-alikes alone', () => {
  for (const s of [
    '时间戳 1794312602000',          // 13 digits, not a phone
    '毫秒 1794312602003',            // 13 digits that pass Luhn: still not a card
    '订单号 1234567812345678',       // fails Luhn
    '版本 2.31.0 和 node v26.13.0', // not an IPv4
    '端口 8080 和 127 个用户',
  ]) assert.equal(run(s), s, s);
});

test('walks Anthropic content blocks, system and tool results; skips thinking and tools', () => {
  const body = {
    model: 'gemini-3-flash',
    system: [{ type: 'text', text: '管理员邮箱 root@example.com' }],
    tools: [{ name: 't', description: '联系 root@example.com' }],
    messages: [
      { role: 'user', content: [{ type: 'text', text: '电话 13812345678' }] },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: '13812345678', signature: 'sig' },
        { type: 'tool_use', id: 'x', name: 'n', input: { q: 'raw' } },
      ] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '查到 IP 1.2.3.4' }] },
    ],
  };
  const { body: out, hits } = filterBody(body, rules);
  assert.equal(out.system[0].text, '管理员邮箱 [邮箱]');
  assert.equal(out.tools[0].description, '联系 root@example.com');
  assert.equal(out.messages[0].content[0].text, '电话 [手机号]');
  assert.deepEqual(out.messages[1].content[0], body.messages[1].content[0]);
  assert.equal(out.messages[2].content[0].content, '查到 IP [IP]');
  assert.deepEqual(hits, { email: 1, phone_cn: 1, ipv4: 1 });
});

test('OpenAI chat format is filtered too', () => {
  const { body } = filterBody({ messages: [{ role: 'system', content: '邮箱 a@b.com' }, { role: 'user', content: '13812345678' }] }, rules);
  assert.equal(body.messages[0].content, '邮箱 [邮箱]');
  assert.equal(body.messages[1].content, '[手机号]');
});

test('custom terms are replaced case-insensitively', () => {
  const c = compile({ ...base, terms: { replace: ['Protocol 7', '黑茶'], replaceWith: '[X]', block: [] } });
  assert.equal(run('protocol 7 是黑茶的公司', c), '[X] 是[X]的公司');
});

test('block terms: latest user turn blocks, older turns get masked', () => {
  const c = compile({ ...base, terms: { replace: [], block: ['禁词'] } });
  assert.equal(filterBody({ messages: [{ role: 'user', content: '这里有禁词' }] }, c).blocked, true);
  const r = filterBody({ messages: [
    { role: 'user', content: '以前说过禁词' },
    { role: 'assistant', content: 'NO_REPLY' },
    { role: 'user', content: '今天天气不错' },
  ] }, c);
  assert.equal(r.blocked, false);
  assert.equal(r.body.messages[0].content, '以前说过[已屏蔽]');
});

test('bad rules fail loudly', () => {
  assert.throws(() => compile({ redact: [{ id: 'x', pattern: '(', replace: '' }] }));
  assert.throws(() => compile({ redact: [{ id: 'x', pattern: 'a', replace: '', validate: 'nope' }] }));
});
