---
"@dougEfresh/pi-azure-foundry": patch
---

Fix two runtime bugs that only appear in an installed extension.

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
