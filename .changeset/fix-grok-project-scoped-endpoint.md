---
'@dougefresh/pi-azure-foundry': patch
---

Route xAI (Grok) deployments through the documented project-scoped OpenAI-compat
endpoint `/api/projects/{project}/openai/v1/chat/completions` with the deployment
name in the request body and no api-version query. Previously all non-Anthropic
publishers used the origin-root `/openai/deployments/{id}/chat/completions` route
(which drops the project path via `new URL(baseUrl).origin`), a shape Grok does
not serve in Azure AI Foundry. All other OpenAI-compatible publishers and the
Anthropic Messages route are unchanged.