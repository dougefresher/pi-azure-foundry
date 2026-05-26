# Azure Foundry Provider for Pi

A custom pi extension that provides access to Azure Foundry models with **two authentication methods**:

1. **API Key Authentication** - Direct API key access
2. **Entra ID/Managed Identity** - OAuth via Azure Entra ID (supports managed identity, device code, service principal)

## Features

- ✅ Support for multiple Azure Foundry models (GPT-4, GPT-4o, GPT-3.5)
- ✅ API Key authentication for simple setup
- ✅ Entra ID OAuth with managed identity support for enterprise environments
- ✅ Device code flow for restricted environments
- ✅ Full streaming support via OpenAI-compatible API
- ✅ Token counting and usage tracking

## Installation

```bash
npm install
npm run build
```

Or use directly with pi during development:

```bash
pi -e /path/to/pi-azure-foundry
```

## Usage

### Method 1: API Key Authentication

Set the environment variable and start pi:

```bash
export AZURE_FOUNDRY_API_KEY="your-api-key-here"
pi -e /path/to/pi-azure-foundry
```

Or inline:

```bash
AZURE_FOUNDRY_API_KEY="your-api-key-here" pi -e /path/to/pi-azure-foundry
```

### Method 2: Entra ID Authentication

No API key needed - use OAuth with Entra ID:

```bash
pi -e /path/to/pi-azure-foundry
```

Then in pi, run:

```
/login azure-foundry
```

This supports three options:

#### Option A: Device Code Flow (Recommended for corporate environments)

- Most compatible with corporate networks and restricted environments
- No browser needed
- Supports managed identity in containerized environments

#### Option B: API Key Entry

- Paste your API key directly when prompted

#### Option C: Automatic (with environment variables)

Set these environment variables and authentication happens automatically:

```bash
# Service Principal
export AZURE_CLIENT_ID="your-client-id"
export AZURE_CLIENT_SECRET="your-client-secret"
export AZURE_TENANT_ID="your-tenant-id"

# Or Managed Identity (in Azure VM/Container)
export AZURE_CLIENT_ID="your-managed-identity-client-id"  # optional

# Then start pi
pi -e /path/to/pi-azure-foundry
```

## Configuration

### Environment Variables

```bash
# Authentication (choose one)
AZURE_FOUNDRY_API_KEY="sk-..."                    # API key
AZURE_FOUNDRY_API_URL="https://..."               # Override default endpoint

# Service Principal (optional, for automatic Entra ID auth)
AZURE_CLIENT_ID="..."
AZURE_CLIENT_SECRET="..."
AZURE_TENANT_ID="..."

# Or use managed identity in Azure (automatic)
IDENTITY_ENDPOINT="http://..."                    # Set by Azure
```

### API Endpoint

By default, uses `https://api.azurefoundry.com/v1`. Override with:

```bash
export AZURE_FOUNDRY_API_URL="https://your-custom-endpoint.com/v1"
```

## Available Models

- `gpt-4-turbo` - GPT-4 Turbo (reasoning support)
- `gpt-4o` - GPT-4o (reasoning support)
- `gpt-4o-mini` - GPT-4o Mini
- `gpt-3.5-turbo` - GPT-3.5 Turbo

Models support:
- Text and image inputs (except GPT-3.5-Turbo which is text-only)
- Streaming responses
- Token counting
- Extended thinking (where available)

## Architecture

### Authentication Flow

```
┌─────────────────────────────────────────┐
│  User starts pi with -e flag             │
└────────────┬────────────────────────────┘
             │
             ├─ Check AZURE_FOUNDRY_API_KEY
             │  ├─ YES → Use API Key Auth ✓
             │  └─ NO  ↓
             │
             ├─ Check Azure Environment
             │  ├─ YES → Use Entra ID ✓
             │  └─ NO  ↓
             │
             ├─ User runs /login azure-foundry
             │  ├─ Select: API Key
             │  ├─ Select: Device Code ✓
             │  └─ Select: Manual Token Entry
             │
             └─ Authentication ready

```

### Provider Configuration

The extension registers a provider with:
- **API**: `openai-completions` (OpenAI-compatible streaming)
- **OAuth**: Entra ID device code, service principal, managed identity
- **Models**: Full model definitions with costs and context windows

### Credential Storage

OAuth credentials are stored in `~/.pi/agent/auth.json`:

```json
{
  "azure-foundry": {
    "access": "token_value",
    "refresh": "refresh_token_or_marker",
    "expires": 1234567890000
  }
}
```

## Example Usage in Pi

```bash
# With API key
AZURE_FOUNDRY_API_KEY="sk-..." pi -e ./pi-azure-foundry

# With Entra ID (manual login)
pi -e ./pi-azure-foundry
# Then: /login azure-foundry

# With service principal (automatic)
AZURE_CLIENT_ID="..." AZURE_CLIENT_SECRET="..." AZURE_TENANT_ID="..." \
  pi -e ./pi-azure-foundry

# With custom endpoint
AZURE_FOUNDRY_API_URL="https://custom.azurefoundry.com/v1" \
  AZURE_FOUNDRY_API_KEY="sk-..." \
  pi -e ./pi-azure-foundry
```

## Troubleshooting

### "No authentication detected"

Make sure you either:
1. Set `AZURE_FOUNDRY_API_KEY` before starting pi
2. Run `/login azure-foundry` after starting pi
3. Set Azure credential environment variables (AZURE_CLIENT_ID, AZURE_CLIENT_SECRET, AZURE_TENANT_ID)

### "Failed to acquire Entra ID token"

Ensure:
1. You have `@azure/identity` installed in pi's node_modules
2. Your Azure credentials are valid
3. You have permissions to access Azure Foundry

### Device Code Not Working

Try setting explicitly:

```bash
export IDENTITY_ENDPOINT="http://localhost:40342/metadata/identity/oauth2/token"
pi -e ./pi-azure-foundry
```

## Development

### Build

```bash
npm run build
```

### Watch mode

```bash
npm run dev
```

## Advanced Configuration

### Custom Models

Edit `src/index.ts` and modify the `MODELS` array:

```typescript
{
  id: "custom-model",
  name: "My Custom Model",
  reasoning: true,
  input: ["text", "image"],
  cost: { input: X, output: Y, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 4096,
}
```

### Multiple Azure Foundry Accounts

Register multiple providers:

```typescript
pi.registerProvider("azure-foundry-prod", { /* prod config */ });
pi.registerProvider("azure-foundry-dev", { /* dev config */ });
```

### Token Refresh Customization

Modify the `refreshEntraIDToken` function to implement custom refresh logic for your enterprise setup.

## License

MIT

## Support

For issues with:
- **Pi extension system**: See pi documentation
- **Azure Foundry API**: Check Azure Foundry documentation
- **Entra ID authentication**: Consult Azure AD documentation
