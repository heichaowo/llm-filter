# llm-filter

Local reverse proxy in front of an LLM API. It masks PII and secrets in request
bodies and blocks requests that contain listed terms, before anything leaves the
machine. Zero runtime dependencies.

```
client -> llm-filter (127.0.0.1:8079) -> upstream (default http://127.0.0.1:8080)
```

## Run

```bash
npm test
PORT=8079 UPSTREAM=http://127.0.0.1:8080 npm start
curl localhost:8079/__filter/health
```

Env: `PORT`, `HOST` (default `127.0.0.1`), `UPSTREAM`, `RULES` (default `rules.json`), `LOG` (default `logs/filter.jsonl`).

## What it does

- Filters JSON `POST` bodies: string values under `text` / `content` / `system`,
  for both Anthropic Messages and OpenAI Chat shapes, including `tool_result`.
- Never touches `thinking` blocks (provider-signed), media, `tools`, `model`, `metadata`.
- `redact` rules: regex → placeholder. Optional `validate: "luhn"`.
- `terms.replace`: literal terms (case-insensitive) → `terms.replaceWith`.
- `terms.block`: if the latest user turn contains one, the request is answered
  locally (`/messages` gets a valid reply with `block.reply`, streaming or not;
  other paths get 403). Older turns only get the term masked.
- Responses are streamed back unchanged.
- Log (`logs/filter.jsonl`) records rule ids and counts, never prompt text.
- `rules.json` hot-reloads; a broken file keeps the last good rules.

Add a test case in `test/filter.test.mjs` before changing a rule.
