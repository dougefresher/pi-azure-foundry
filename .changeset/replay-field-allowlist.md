---
'@dougEfresh/pi-azure-foundry': patch
---

Harden two message-conversion edge cases found in review:

- Reasoning replay on the OpenAI route now validates the recorded field name
  against the allowlist the stream actually probes. A stored Anthropic thinking
  signature could otherwise become a top-level JSON key on an outgoing request,
  poisoning a stored history in a way no retry could clear.
- An Anthropic history that filters down to nothing now sends one placeholder
  user message instead of `messages: []`, which the endpoint rejects.
