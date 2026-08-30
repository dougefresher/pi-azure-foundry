---
"@dougefresh/pi-azure-foundry": minor
---

Cache the discovered deployments manifest on disk so pi startups skip the Azure/Entra network round-trip. Cache lives at `~/.cache/pi-azure-foundry/deployments.json`, defaults to a 1-hour TTL, is scoped to resourceId + projectId + api-version, and falls through to the live API (and re-writes the cache) on any miss, staleness, mismatch, or corruption. Configurable via the `cache` boolean (set `false` to disable) and `cacheTtlMinutes` for the TTL.