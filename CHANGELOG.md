# @dougefresh/pi-azure-foundry

## 1.2.0

### Minor Changes

- 95af265: Bring both routes up to parity with pi-ai's own provider implementations, working
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

### Patch Changes

- 95af265: Fix two runtime bugs that only appear in an installed extension.

  - **The extension failed to load entirely.** pi's extension loader resolves a
    fixed allowlist of pi-ai specifiers, so `@earendil-works/pi-ai/api/transform-messages`
    was path-joined onto `dist/compat.js` and produced
    `Cannot find module '.../pi-ai/dist/compat.js/api/transform-messages'`.
    `transformMessages` and `adjustMaxTokensForThinking` are now vendored in
    `src/pi-ai-vendored.ts`, since neither is reachable from any permitted
    specifier. `test/imports.test.ts` fails on any bare import outside the
    allowlist.
  - **`reasoning_effort` 400'd whenever tools were present** — "Function tools with
    reasoning_effort are not supported for this model in /v1/chat/completions" —
    which for a coding agent is every turn. It is now sent only when a request
    carries no tools.

  Adds AGENTS.md documenting both traps, and the smoke suite now sends tools by
  default, since passing `tools: []` was what hid the second bug.

- c745b20: Lowercase the package scope: `@dougEfresh/pi-azure-foundry` is now
  `@dougefresh/pi-azure-foundry`. npm's naming rules forbid uppercase characters in
  package names, so the old spelling was never publishable. Nothing at runtime
  reads the package name — pi keys the provider off `azure-foundry` and Homebrew
  installs to a path that never carried the scope.
- 95af265: Split formatting out of `check`. `bun run format` writes fixes; `bun run check`
  is now read-only, so it fails on drift instead of silently rewriting files —
  which is what CI needs, since a fix applied inside a build container is thrown
  away with the container.
- 95af265: Harden two message-conversion edge cases found in review:

  - Reasoning replay on the OpenAI route now validates the recorded field name
    against the allowlist the stream actually probes. A stored Anthropic thinking
    signature could otherwise become a top-level JSON key on an outgoing request,
    poisoning a stored history in a way no retry could clear.
  - An Anthropic history that filters down to nothing now sends one placeholder
    user message instead of `messages: []`, which the endpoint rejects.
