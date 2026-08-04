---
'@dougefresh/pi-azure-foundry': patch
---

Split formatting out of `check`. `bun run format` writes fixes; `bun run check`
is now read-only, so it fails on drift instead of silently rewriting files —
which is what CI needs, since a fix applied inside a build container is thrown
away with the container.
