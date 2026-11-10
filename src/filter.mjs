// Request-side filter for LLM API bodies (Anthropic Messages and OpenAI Chat).
// Pure functions: no I/O, so every rule can be unit-tested with fixtures.

// String values under these keys are prompt text and get filtered.
const TEXT_KEYS = new Set(['text', 'content', 'system']);
// Blocks of these types are never touched: thinking text is signed by the
// provider (editing it breaks the signature), media is base64 payload.
const SKIP_TYPES = new Set(['thinking', 'redacted_thinking', 'image', 'document']);
// Top-level request keys that are configuration, not conversation.
const SKIP_KEYS = new Set(['tools', 'tool_choice', 'metadata', 'model']);

const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function luhn(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}
const VALIDATORS = { luhn };

/** Turn a rules.json object into ready-to-run matchers. Throws on bad rules. */
export function compile(rules) {
  const redact = (rules.redact || []).map((r) => {
    if (r.validate && !VALIDATORS[r.validate]) throw new Error(`rule ${r.id}: unknown validator ${r.validate}`);
    return { id: r.id, re: new RegExp(r.pattern, 'gu'), replace: r.replace, validate: VALIDATORS[r.validate] };
  });
  const terms = rules.terms || {};
  const termRe = (list) => (list && list.length
    ? new RegExp(list.map(escapeRegex).join('|'), 'giu')
    : null);
  return {
    redact,
    replaceTerms: termRe(terms.replace),
    replaceWith: terms.replaceWith || '[已隐去]',
    blockTerms: termRe(terms.block),
    blockReply: rules.block?.reply ?? 'NO_REPLY',
  };
}

function redactString(str, c, hits) {
  const count = (id) => { hits[id] = (hits[id] || 0) + 1; };
  let out = str;
  for (const r of c.redact) {
    out = out.replace(r.re, (m) => {
      if (r.validate && !r.validate(m.replace(/\D/g, ''))) return m;
      count(r.id);
      return r.replace;
    });
  }
  if (c.replaceTerms) out = out.replace(c.replaceTerms, () => { count('term'); return c.replaceWith; });
  // Blocked terms that survive in history are masked so they never leave.
  if (c.blockTerms) out = out.replace(c.blockTerms, () => { count('block_term'); return '[已屏蔽]'; });
  return out;
}

function walk(node, fn, top = false) {
  if (Array.isArray(node)) return node.map((n) => walk(n, fn));
  if (node === null || typeof node !== 'object') return node;
  if (SKIP_TYPES.has(node.type)) return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (top && SKIP_KEYS.has(k)) out[k] = v;
    else if (typeof v === 'string' && TEXT_KEYS.has(k)) out[k] = fn(v);
    else out[k] = walk(v, fn);
  }
  return out;
}

function textOf(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((b) => (typeof b?.text === 'string' ? b.text
    : b?.type === 'tool_result' ? textOf(b.content) : '')).join('\n');
}

/**
 * Filter one parsed request body.
 * Block check looks only at the latest user turn, so one bad message does not
 * poison every later request of the same conversation.
 * @returns {{ body: object, hits: Record<string, number>, blocked: boolean }}
 */
export function filterBody(body, c) {
  const msgs = Array.isArray(body?.messages) ? body.messages : [];
  const lastUser = [...msgs].reverse().find((m) => m?.role === 'user');
  if (c.blockTerms && lastUser) {
    c.blockTerms.lastIndex = 0;
    if (c.blockTerms.test(textOf(lastUser.content))) return { body, hits: { block_term: 1 }, blocked: true };
  }
  const hits = {};
  const filtered = walk(body, (s) => redactString(s, c, hits), true);
  return { body: filtered, hits, blocked: false };
}
