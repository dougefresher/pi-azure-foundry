# AGENTS.md

Notes for agents working on this repo. Read this before changing `src/index.ts`.

## What this is

A [pi](https://pi.dev) extension that discovers Azure AI Foundry deployments at
startup and registers them as pi models. A fork of
[nquandt/pi-azure-foundry](https://github.com/nquandt/pi-azure-foundry).

Everything lives in two files:

| File | Role |
| ---- | ---- |
| `src/index.ts` | The whole extension: config, discovery, both API routes, streaming |
| `src/pi-ai-vendored.ts` | Copied pi-ai internals that an extension cannot import (see below) |

The extension registers ONE provider (`azure-foundry`) whose models route two
ways, chosen per deployment at discovery time from `modelPublisher`:

- `Anthropic` → `/anthropic/v1/messages` (native Messages API)
- everything else → `/openai/deployments/{id}/chat/completions` (OpenAI-compatible)

Model metadata (context window, pricing, reasoning support, `thinkingLevelMap`)
is resolved by matching the Azure catalog model name, case-insensitively, against
pi-ai's built-in catalogs, then overridden by the `models` key in config. Unknown
models fall back to 128K/4K/text-only/zero-cost, which is why an unmatched
deployment silently reports $0.

## The vendoring, and why you must not "clean it up"

`src/pi-ai-vendored.ts` holds copies of two pi-ai functions. It exists because
**pi's extension loader resolves a fixed allowlist of specifiers**, in
`pi-coding-agent/dist/core/extensions/loader.js`:

```text
@earendil-works/pi-ai                 -> ai/dist/compat.js
@earendil-works/pi-ai/compat          -> ai/dist/compat.js
@earendil-works/pi-ai/oauth           -> ai/dist/oauth.js
@earendil-works/pi-ai/providers/all   -> ai/dist/providers/all.js
@earendil-works/pi-coding-agent       -> coding-agent/dist/index.js
@earendil-works/pi-agent-core         -> agent/dist/index.js
@earendil-works/pi-tui                -> tui/dist/index.js
```

That is the entire map. Nothing else resolves.

Any other specifier is path-joined onto the resolved root — which is a *file* —
so `@earendil-works/pi-ai/api/transform-messages` becomes a module that cannot
exist, and the extension dies at load:

```text
Cannot find module '.../pi-ai/dist/compat.js/api/transform-messages'
```

**This shipped in v1.1.0.** `bun`, `tsc`, `bun test`, and a live end-to-end
harness all resolved that subpath happily against real `node_modules`; it fails
only in an installed extension. Neither vendored function is re-exported from
`compat.js`, so there is no permitted specifier that reaches them — copying is
the only option, not a preference.

Upstream sources, at the commits they were taken from
(<https://github.com/earendil-works/pi>, pi-ai `0.83.0`):

| Vendored | Upstream path | Commit |
| -------- | ------------- | ------ |
| `transformMessages` | `packages/ai/src/api/transform-messages.ts` | `8c0ccd14b34b6e5c403363518e331094b69ebf6c` |
| `adjustMaxTokensForThinking` | `packages/ai/src/api/simple-options.ts` | `027a5847901b5dde30270abaa1041046cd2b4b55` |
| loader allowlist (reference) | `packages/coding-agent/src/core/extensions/loader.ts` | `74caa2649f10ed71b4378ce69f5d9fbfd2466ca5` |

Re-diff against upstream when bumping pi-ai. `transformMessages` is load-bearing:
it synthesizes tool results for orphaned tool calls and drops aborted assistant
turns, which is what keeps an interrupted turn from poisoning every later request
with `400 ... tool_call_ids did not have response messages`.

`test/imports.test.ts` fails on any bare import outside the allowlist. If you add
a dependency, add it there deliberately — do not delete the test.

Two related resolution traps in the same family:

- Emitted specifiers need the `.js` extension (`./pi-ai-vendored.js`), even
  though the source is `.ts`. `moduleResolution: "bundler"` lets an extensionless
  import compile and then emit something Node ESM cannot resolve.
- `tsc` only type-checks `src` (`include: ["src"]`), so `test/` and `smoke/`
  import `.ts` paths directly and are checked by `bun` alone.

## Tests

```bash
npm test             # 18 offline tests. Free, no network.
npm run smoke-test   # 14 live tests, ~20s, a fraction of a cent
npm run check        # biome + tsc, run before every commit
```

**Offline** (`test/`) — conversion tests over the failure matrix pi-ai runs every
provider through (`.pi/skills/add-llm-provider.md` upstream): orphaned tool
calls, parallel tool results, image tool results, unpaired surrogates, empty
content, thinking replay. Plus the import guard above.

**Live** (`smoke/live.test.ts`) — one case per assumption about the remote API.
Offline tests prove the converters emit a shape; only this proves Azure accepts
it. Needs `~/.pi/azure-foundry.config.json` and `az login`.

Things to know before editing the smoke test:

- It is kept out of `bun test` by `[test] root = "test"` in `bunfig.toml`, not by
  its filename. An explicit path still runs it.
- **`test.skipIf` takes a value, not a predicate, and is evaluated while tests
  are collected — before any lifecycle hook.** Deployment discovery therefore
  happens at module scope via top-level await. Passing a function (always truthy)
  or populating the list in `beforeAll` skips the entire suite while reporting
  green. That happened; the guard test `at least one target deployment is live`
  exists because of it, and does not skip.
- **Tools are sent by default.** pi sends tools on nearly every turn and their
  presence changes what the API accepts. A version of this suite that passed
  `tools: []` everywhere hid a live 400.
- Deployment names (`SMOKE_*_MODEL` env vars) track an internal Pulumi stack and
  churn. Override per run rather than editing.

**Neither suite substitutes for loading the real thing.** Both of v1.1.0's
runtime bugs were invisible to them and obvious to `pi -ne -e . -p "..."`:

```bash
npm run build
pi -ne -e . -p "reply with exactly: LOADED" --model azure-foundry/<deployment>
```

`-ne` disables extension discovery while honouring explicit `-e`, which matters
because an installed copy of this extension would otherwise load alongside and
its errors get attributed to your build.

## Verified facts about Azure Foundry

Established against a live account, not from documentation. Do not "fix" these
based on assumption:

- **api-version `2024-10-21` accepts `reasoning_effort`** and reports
  `prompt_tokens_details` / `completion_tokens_details`. There is no need for a
  preview version; `openaiApiVersion` in config exists only as an escape hatch.
- **`reasoning_effort` + function tools = 400** on chat completions
  (`Function tools with reasoning_effort are not supported for this model in
  /v1/chat/completions`). It is gated on there being no tools, which in a coding
  agent means almost never. Exposing GPT reasoning properly requires the
  Responses API — a different route, not yet implemented.
- **Azure's GPT chat-completions route never returns reasoning text**, only
  `completion_tokens_details.reasoning_tokens`. The `reasoning_content` delta
  plumbing exists for publishers that do emit it (DeepSeek).
- **`prompt_tokens` is inclusive of cached tokens.** Ignoring
  `prompt_tokens_details.cached_tokens` bills cached input at full rate.
- **The Anthropic passthrough supports `cache_control` and `thinking`.** Caching
  needs a prefix over the 1024-token minimum to be eligible at all;
  `budget_tokens` must be ≥ 1024 and strictly less than `max_tokens`, and
  `adjustMaxTokensForThinking` can return a budget under that floor.
- **Anthropic requires all `tool_result` blocks for a turn in ONE user message.**
  One message per result breaks role alternation as soon as a model issues
  parallel tool calls, which Claude does constantly.
- Whitespace-only text blocks and thinking blocks with an empty signature are
  both rejected by Anthropic on replay.
- **Consecutive same-role messages are merged server-side, not rejected** (200,
  curl-verified). So an assistant turn whose every block gets filtered out is
  dropped rather than backfilled with a placeholder — same as upstream pi's
  `api/anthropic-messages.ts`. Do not "fix" the adjacent user messages.
- **`messages: []` IS rejected** ("at least one message is required"), which a
  history of nothing but a blank prompt filters down to. `toAnthropicMessages`
  guards that case explicitly.

## Release flow

- Versioning is [changesets](https://github.com/changesets/changesets).
  `npm run changeset` to describe a change, `npm run changeset:version` to
  consume changesets and bump.
- `CHANGELOG.md` is **generated**. Its first line must stay a single-line
  `# <package>` heading: changesets inserts each entry immediately after the
  first newline, so a preamble there ends up below the newest release.
  History through v1.1.0 is frozen in `CHANGELOG-FROM-FORK.md`.
- There is no `version` or `release` script on purpose: npm runs a script named
  `version` as a lifecycle hook during `npm version`, which would fire
  `changeset version` mid-bump.
- **Do not create git tags.** Tagging and releases are the maintainer's.
- npm publishing is not part of this fork's flow.
- Install dependencies with **npm**; run scripts and tests with **bun**.

## CI

**Buildkite, not GitHub Actions.** There is deliberately no `.github/workflows`
here — the inherited `publish.yml` published to npm on a `v*` tag, which both
failed (`ENEEDAUTH`) and contradicted the flow above. Do not add one back.

The pipelines live in `~/projects/me/buildkite` (`builds/npm/pipeline.yml`) and
are shared across projects, so a change there lands everywhere. The npm build
step is `npm ci && bun run check`, followed by `git diff --exit-code` — which
exists because a `check` script running a formatter with `--write` cannot fail on
drift: it fixes it in the container, exits 0, and the fix dies with the agent.
Hence `format` writes and `check` only reads. Note the pipeline does **not** run
`bun test` yet; the offline suite is on you to run.

## Config

`azure-foundry.config.json`, looked up in cwd then `~/.pi/`. Auth is either
`api-key` or `azure-identity` (`DefaultAzureCredential`, so `az login` locally).
Never commit a real config — it may hold an API key.

Header auth differs by route and is easy to get wrong: API-key auth sends
`api-key: <key>` on the OpenAI route but `Authorization: Bearer <key>` on the
Anthropic one; identity auth sends `Authorization: Bearer <entra-token>` on both.
