# llm-filter 需求规格

> 本文件是需求说明。仓库里现有的 `src/`、`test/`、`rules.json` 是一版**未经审查的参考草稿**（Sable 误解需求后写的）：可以参考、改写或整个推翻，测试样本可直接复用。以本文件为准。

## 1. 要解决的问题

群聊 agent 准备改用经 antigravity 代理调用的 Gemini（免费，但是灰色用法，数据会发给 Google，账号有被封风险）。需要在请求离开本机前：

1. 把隐私和密钥打码（手机号、身份证、邮箱、API key 等）。
2. 命中敏感词时整条拦截，内容不发出去，降低封号风险。

## 2. 范围

**要做**
- 一个本地反向代理服务，只做请求侧过滤。
- 通用：不依赖 OpenClaw，任何走 HTTP 调 LLM 的客户端都能接（OpenClaw、Claude Code 的 `ANTHROPIC_BASE_URL` 等）。

**不做**
- 不做多提供商路由、负载均衡、自动切换、计费。这些由 OpenClaw 负责，重复做会导致两层路由难以排查。
- 不处理模型的回复（回复原样转回）。
- 不做 OpenClaw 插件。原因：OpenClaw 插件钩子不能改写原文（`llm_input` 只读，`before_prompt_build` 只能追加，`before_agent_run` 只能整条放行或拦截），见 `/opt/homebrew/lib/node_modules/openclaw/docs/plugins/hooks/reference.md`。
- 不改 antigravity 代理源码（`~/.openclaw/acc-original`，上游项目，更新会覆盖）。

## 3. 架构

```
OpenClaw ──> llm-filter (127.0.0.1:8079) ──> antigravity 代理 (127.0.0.1:8080) ──> Google
```

- 只监听 127.0.0.1。
- 上游地址可配置（http / https 都要支持，上游可以带路径前缀）。
- 运行时零依赖，只用 Node 内置模块（与 Fiducia 一致）。Node >= 22，本机是 v26。
- 用 launchd 托管，开机自启、崩溃自动重启。

## 4. 过滤对象

请求格式至少支持：
- Anthropic Messages（`POST /v1/messages`，OpenClaw 对 antigravity 用的就是这个，`api: anthropic-messages`）。
- OpenAI Chat Completions（`/v1/chat/completions`）。

**必须过滤的字符串**
- `system`（字符串或 text block 数组）
- `messages[].content`（字符串或 block 数组）里的 `text`
- `tool_result` 的 `content`（字符串或 block 数组）

**绝对不能改的**
- `thinking` / `redacted_thinking` block：内容带 provider 签名，改了下一轮请求会被拒（OpenClaw 文档 `help/faq-models.md` 有「thinking signature required」报错说明）。
- `image` / `document` 等媒体 block。
- 顶层的 `tools`、`tool_choice`、`model`、`metadata`。
- 非 JSON 请求、GET 请求：原样转发。

请求头原样转发（含 `x-api-key`、`anthropic-version`），`host` 和 `content-length` 按新 body 重算。

## 5. 规则

规则放在单独的 JSON 文件，改完热加载；新规则有错时保留上一版，服务不能挂。

**5.1 打码（正则 → 占位符）**，默认规则：

| 类型 | 占位符 | 注意 |
|---|---|---|
| 中国大陆手机号（含 +86、空格/横线分隔） | `[手机号]` | 不能误伤 13 位时间戳 |
| 18 位身份证号 | `[身份证号]` | |
| 银行卡号 16–19 位 | `[银行卡号]` | 必须做 Luhn 校验，避免误伤订单号 |
| 邮箱 | `[邮箱]` | |
| IPv4 | `[IP]` | 不能误伤 `2.31.0`、`v26.13.0` 这类版本号 |
| API key / token：Anthropic `sk-ant-`、OpenAI `sk-`、GitHub `ghp_` 等与 `github_pat_`、AWS `AKIA`、Google `AIza`、Telegram bot token、`Bearer xxx` | `[密钥]` | |

**5.2 自定义替换词表**：字面量、忽略大小写，替换成统一占位符（默认 `[已隐去]`）。初始为空，词表由黑茶提供。

**5.3 拦截词表**：初始为空，词表由黑茶提供（不要自行编造）。
- 只检查**最新一条 user 消息**。如果检查整段历史，一条坏消息会让同一会话之后的每次请求都被拦。
- 历史消息里出现的拦截词：打码成 `[已屏蔽]`，不拦截。
- 命中时本地直接回复，**请求不能到达上游**：
  - Anthropic `/messages`：返回结构合法的 assistant 消息，文本可配置，默认 `NO_REPLY`（群聊 agent 用这个表示静默）。`stream: true` 时必须返回合法的 SSE 序列（`message_start` → `content_block_start` → `content_block_delta` → `content_block_stop` → `message_delta` → `message_stop`）。
  - 其他路径：返回 403 JSON 错误。

## 6. 转发与流式

- 上游响应（含 SSE）必须边收边转，不能等完整响应再返回。状态码和响应头原样转回。
- 上游连不上：返回 502，body 是 Anthropic 风格的错误 JSON，让 OpenClaw 能切到备用模型。

## 7. 日志与运维

- 日志用 JSONL，每次请求一行：时间、路径、模型、各规则命中次数、是否拦截。**任何情况下都不能写入原文**（包括被拦截的内容）。
- 健康检查接口：`GET /__filter/health` → `{ ok: true, upstream }`。
- 配置用环境变量：端口、监听地址、上游、规则文件路径、日志路径。

## 8. 测试要求

用 `node:test`，`npm test` 全绿才算完成。至少覆盖：

1. 第 5.1 节每类数据都被打码。
2. 不误伤的反例：13 位时间戳、Luhn 校验不通过的 16 位数字、13 位且碰巧通过 Luhn 的数字、版本号、端口号。
3. Anthropic block 结构：system 数组、text block、tool_result 都被过滤；thinking block 和 `tools` 原样保留。
4. OpenAI Chat 格式能被过滤。
5. 自定义词表忽略大小写。
6. 拦截：最新 user 消息命中就拦截；只在历史里出现时只打码、不拦截。
7. 端到端（假上游）：过滤后的 body 送达上游，请求头保留，content-length 正确，SSE 分块按原样流回。
8. 拦截请求不到达上游；stream 和非 stream 两种回复都合法。
9. 日志里有规则 id，没有原文。
10. 规则文件写错时 `compile` 抛错，服务继续使用旧规则。

**上线前实测**（接真实的 8080 antigravity 代理，模型 `gemini-3-flash`）：
- 让模型原样复述含手机号、邮箱、IP 的句子，回复里只能出现占位符。
- 流式请求正常。
- 带 `tools` 的请求和 `tool_use` → `tool_result` 往返不报错。

## 9. 上线步骤（代码完成后由 Sable 执行，执行前需黑茶确认）

1. 黑茶确认规则，补齐两个词表。
2. 写 launchd plist（`~/Library/LaunchAgents/`），日志放 `~/.openclaw/logs/`。
3. `~/.openclaw/openclaw.json` 里 `models.providers.antigravity-proxy.baseUrl` 从 `http://127.0.0.1:8080` 改成 `http://127.0.0.1:8079`。
4. 群聊 agent（`agents.entries.group`）主模型改为 `antigravity-proxy/gemini-3-flash`，备用 `meridian/claude-haiku-4-5`，并移除 rightcode。
5. `openclaw config validate`，重启 Gateway。

## 10. 已知局限

- 中文人名、住址等无固定格式的信息无法用正则识别，只能靠自定义词表。
- IP 规则会把技术讨论里的 IP 也打码，影响回答质量。
- 过滤器挂掉时 antigravity 整条路径不可用；依赖 OpenClaw 自动切到备用模型。
