---
"@dougEfresh/pi-azure-foundry": minor
---

Bring both routes up to parity with pi-ai's own provider implementations, working
through the failure matrix upstream tests every built-in provider against.

Fixed:

- **Parallel tool calls no longer break the Anthropic route.** Every `tool_result`
  for a turn is now grouped into a single user message. Emitting one message per
  result broke role alternation the moment a model issued parallel tool calls.
- **Unpaired UTF-16 surrogates are stripped** from every outgoing string. Azure
  rejects them with a 400, and tool output truncated mid-emoji produces them.
- **Cached prompt tokens are accounted for** on the OpenAI route:
  `prompt_tokens_details.cached_tokens` was ignored, so cached input was billed at
  the full input rate. Also captures `completion_tokens_details.reasoning_tokens`.
- **Whitespace-only text blocks are dropped** on the Anthropic route, which
  rejects them; messages left with no blocks are omitted rather than sent empty.
- **Thinking blocks with no signature degrade to plain text** instead of being
  replayed with `signature: ""`, which Anthropic rejects.
- Tool-call blocks are keyed by stream index, so a deployment that repeats the
  tool call id across argument chunks no longer spawns duplicate blocks.
- Empty tool output sends `(no tool output)` rather than an empty string, and a
  zero-argument tool call no longer logs a bogus JSON parse failure.
- The OpenAI route now emits `thinking_end`, so thinking blocks are terminated.

Added:

- **Reasoning on the OpenAI route.** `reasoning_effort` is derived from the
  model's `thinkingLevelMap` (verified accepted on api-version 2024-10-21), and
  `reasoning_content` / `reasoning` / `reasoning_text` deltas are surfaced as
  thinking blocks — DeepSeek deployments emit these; Azure's GPT chat-completions
  route does not expose reasoning text, only token counts.
- **Extended thinking on the Anthropic route**, budgeted with pi-ai's own
  level→budget table, and skipped when a tight `maxTokens` would drive the budget
  under Anthropic's 1024 floor. Temperature is omitted when thinking is on.
- **Prompt caching on the Anthropic route.** `cache_control` markers on the system
  prompt and the conversation tail; verified against a live Foundry deployment
  (2889 tokens served as `cache_read_input_tokens`). Honours
  `cacheRetention: "none"`.
- Images in tool results are forwarded — hoisted into a follow-up user message on
  the OpenAI route, nested in `tool_result` content on the Anthropic route.
- `openaiApiVersion` config key for resources that need a non-default api-version.
- A `bun test` suite covering the conversion failure matrix.
- An ad-hoc live smoke test (`bun run smoke`, or `bun run smoke-test` to run the
  cases concurrently) that exercises the remote assumptions offline tests cannot
  reach. It is a `bun:test` file kept outside `[test] root` in bunfig.toml, so
  plain `bun test` stays offline and free.
