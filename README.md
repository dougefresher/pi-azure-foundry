# pi-azure-foundry

A [pi](https://pi.dev) extension that connects to your [Azure AI Foundry](https://ai.azure.com) project, auto-discovers your chat deployments, and registers them as models in pi.

Supports both **API key** and **Azure identity** (Managed Identity, Azure CLI, service principal, etc.) authentication.

## Requirements

- A pi installation (`npm install -g @earendil-works/pi-coding-agent`)
- An Azure AI Foundry project with one or more chat-capable deployments

---

## Installation

### Global (works in any project)

```bash
pi install npm:@nquandt/pi-azure-foundry
```

### Try without installing

```bash
pi -e npm:@nquandt/pi-azure-foundry
```

---

## Configuration

Create an `azure-foundry.config.json` file. The extension looks in two places, in order:

1. `<current working directory>/azure-foundry.config.json` — project-specific
2. `~/.pi/azure-foundry.config.json` — global fallback

The global location is recommended for most users since it works across all projects.

### Finding your resource and project IDs

Both values come from your Azure AI Foundry project URL:

```
https://ai.azure.com/build/overview?wsid=/subscriptions/.../resourceGroups/.../providers/Microsoft.MachineLearningServices/workspaces/YOUR-PROJECT
```

Or from the Azure portal — your **resource name** is the Azure AI Services resource name, and your **project name** is the Foundry project name. They are often the same value.

### API key auth

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "api-key",
    "apiKey": "your-api-key-here"
  }
}
```

Get your API key from the Azure AI Foundry portal under **Settings → API keys**.

### Azure identity auth

```json
{
  "resourceId": "my-resource-eastus2",
  "projectId": "my-project-eastus2",
  "auth": {
    "type": "azure-identity"
  }
}
```

No key needed. Uses [`DefaultAzureCredential`](https://learn.microsoft.com/en-us/javascript/api/@azure/identity/defaultazurecredential) which automatically tries, in order:

| Method | How to set up |
|---|---|
| Environment variables | Set `AZURE_CLIENT_ID`, `AZURE_CLIENT_SECRET`, `AZURE_TENANT_ID` |
| Workload identity | Configured automatically in AKS |
| Managed identity | Configured automatically on Azure VMs / App Service / Container Apps |
| Azure CLI | Run `az login` |
| Azure Developer CLI | Run `azd auth login` |
| Visual Studio Code | Sign in via the Azure extension |

For local development, `az login` is the easiest option.

---

## Usage

Once installed and configured, start pi normally. On startup you'll see:

```
[Azure Foundry] Loading config from: /Users/you/.pi/azure-foundry.config.json
[Azure Foundry] Auth: api-key
[Azure Foundry] Fetching deployments from: https://my-resource.services.ai.azure.com/...
[Azure Foundry] Found 3 deployment(s): claude-sonnet (Anthropic), gpt-4o (Microsoft), ...
[Azure Foundry] ✓ Registered 3 model(s)
```

Your deployments will appear in the pi model picker under the **Azure Foundry** provider.

---

## How it works

- **Deployment discovery** — on startup the extension calls the Foundry deployments API and filters to chat-capable deployments. No model list to maintain manually.
- **Routing** — Anthropic deployments are routed to `/anthropic/v1/messages` (native Messages API with tool use and extended thinking). All other deployments use `/openai/deployments/{id}/chat/completions` (OpenAI-compatible).
- **Auth headers** — API key auth sends `api-key: <key>` on the OpenAI route and `Authorization: Bearer <key>` on the Anthropic route. Azure identity sends `Authorization: Bearer <entra-token>` on both. Tokens are cached and refreshed automatically 5 minutes before expiry.

---

## Supported models

The extension auto-discovers whatever is deployed in your Foundry project. Known model capabilities are pre-configured for:

| Model | Context | Max output | Reasoning | Vision |
|---|---|---|---|---|
| claude-sonnet-4-5 / 4-6 | 200K | 16K | ✅ | ✅ |
| claude-haiku-4-5 | 200K | 16K | — | ✅ |
| claude-opus-4-5 | 200K | 32K | ✅ | ✅ |
| gpt-4o | 128K | 4K | — | ✅ |
| gpt-4o-mini | 128K | 4K | — | ✅ |
| Kimi-K2.5 / K2.6 | 131K | 8K | — | — |

Any deployment not in the above list falls back to 128K context / 4K output / text-only.

---

## Development

```bash
git clone https://github.com/nquandt/pi-azure-foundry
cd pi-azure-foundry
npm install
npm run build

# Test against your own config
cp azure-foundry.config.example.json azure-foundry.config.json
# edit azure-foundry.config.json with your real values
pi -e .
```

```bash
npm run dev       # watch mode
npm run type-check  # type check without building
```

---

## License

MIT
