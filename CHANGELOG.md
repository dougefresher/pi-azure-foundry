# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
- Model metadata is now resolved from pi-ai's built-in provider catalogs instead of a hardcoded MODEL_DEFAULTS table. Unknown models fall back to conservative defaults (128K context / 4K output / text-only / zero cost).
- Config now supports an optional `models` key for per-model metadata overrides.

### Fixed
- `DefaultAzureCredential` is now a module-level singleton instead of being recreated on every token refresh.
- Anthropic text blocks are no longer filtered by `.trim()` — whitespace-only blocks are preserved to avoid empty message arrays.
- Unknown `finish_reason` and `stop_reason` values from streaming responses are logged instead of silently ignored.
- Tool call JSON parse failures in streaming finalization are logged instead of silently swallowed.
- `temperature` from options is now forwarded to both OpenAI and Anthropic API requests.
- CHANGELOG format fixed (was literal `\n` escapes instead of actual newlines).

## [1.0.6] - 2026-08-01

### Fixed
- OpenAI-compat route no longer sends assistant messages with a missing/null `content`. A turn that reduced to no text and no tool calls (e.g. a thinking-only turn in history) now serializes `content: ""`, fixing `400 invalid_request_error: expected a string, got null` from strict OpenAI/GPT deployments.

## [1.0.0] - 2025-05-22

### Added
- Initial release
- Azure Foundry provider for Pi
- API Key authentication
- Entra ID OAuth support via `DefaultAzureCredential`
- Dynamic model discovery from Azure Foundry Deployments API
- Support for OpenAI models via chat completions API
- Support for Anthropic models via native Messages API (tool use, extended thinking)
- GPT-5/o-series automatic `max_completion_tokens` routing
- Config file search: project root, then `~/.pi/azure-foundry.config.json`

## Release Instructions

1. Update this file with changes
2. Update `package.json` version
3. Run `npm run build`
4. Commit and tag: `git tag vX.X.X`
5. Push and create GitHub release
6. GitHub Actions will publish to NPM