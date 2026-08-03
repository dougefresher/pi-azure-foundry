/**
 * Azure Foundry Extension
 *
 * Discovers models from Azure AI Foundry Deployments API and registers them with pi.
 * Routes to the correct API based on model publisher:
 *   - Anthropic → native Messages API at /anthropic/v1/messages
 *   - OpenAI/others → OpenAI-compat at /openai/deployments/{id}/chat/completions
 *
 * Config: ./azure-foundry.config.json
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { type AccessToken, DefaultAzureCredential } from '@azure/identity';
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Context,
  calculateCost,
  createAssistantMessageEventStream,
  type ImageContent,
  type Message,
  type Model,
  type ModelCost,
  type SimpleStreamOptions,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { transformMessages } from '@earendil-works/pi-ai/api/transform-messages';
import { getBuiltinModels, getBuiltinProviders } from '@earendil-works/pi-ai/providers/all';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

// =============================================================================
// Config & Types
// =============================================================================

type AuthConfig = { type: 'api-key'; apiKey: string } | { type: 'azure-identity' };

type OpenAITokenLimitParam = 'max_tokens' | 'max_completion_tokens';

interface ModelConfigOverride {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: ('text' | 'image')[];
  cost?: ModelCost;
  openaiTokenLimit?: OpenAITokenLimitParam;
}

interface RetryConfig {
  maxRetries?: number;
  maxRetryDelayMs?: number;
}

interface Config {
  resourceId: string;
  projectId: string;
  auth: AuthConfig;
  models?: Record<string, ModelConfigOverride>;
  retry?: RetryConfig;
}

// =============================================================================
// Token Provider
// =============================================================================

/** Azure AI Foundry scope for Entra ID tokens */
const AZURE_AI_SCOPE = 'https://ai.azure.com/.default';

/** Cached token — refreshed when within 5 min of expiry */
let cachedToken: AccessToken | null = null;

/** Singleton DefaultAzureCredential — walks the credential chain once, not on every refresh. */
const credential = new DefaultAzureCredential();

async function getIdentityToken(): Promise<string> {
  const now = Date.now();
  const expiryBuffer = 5 * 60 * 1000; // 5 minutes
  if (cachedToken && cachedToken.expiresOnTimestamp - now > expiryBuffer) {
    return cachedToken.token;
  }
  cachedToken = await credential.getToken(AZURE_AI_SCOPE);
  if (!cachedToken) throw new Error('[Azure Foundry] Failed to acquire identity token');
  return cachedToken.token;
}

/**
 * Returns a token getter function appropriate for the configured auth type.
 * For api-key: always returns the static key.
 * For azure-identity: fetches/caches an Entra ID token via DefaultAzureCredential.
 */
function makeTokenGetter(auth: AuthConfig): () => Promise<string> {
  if (auth.type === 'api-key') {
    return () => Promise.resolve(auth.apiKey);
  }
  return getIdentityToken;
}

interface Deployment {
  name: string;
  modelName?: string;
  modelPublisher?: string;
  capabilities?: Record<string, string>;
}

function loadConfig(): Config {
  // Search order: project root → ~/.pi/azure-foundry.config.json
  const candidates = [
    resolve(process.cwd(), 'azure-foundry.config.json'),
    resolve(homedir(), '.pi', 'azure-foundry.config.json'),
  ];
  for (const p of candidates) {
    if (existsSync(p)) {
      console.log(`[Azure Foundry] Loading config from: ${p}`);
      return JSON.parse(readFileSync(p, 'utf-8'));
    }
  }
  throw new Error(
    'azure-foundry.config.json not found. Checked:\n' +
      candidates.map((p) => `  ${p}`).join('\n') +
      '\n\nCreate one in your project root or at ~/.pi/azure-foundry.config.json',
  );
}

// =============================================================================
// Deployment → Model mapping
// =============================================================================

interface ResolvedModelDetails {
  contextWindow: number;
  maxTokens: number;
  reasoning: boolean;
  input: ('text' | 'image')[];
  cost: ModelCost;
  thinkingLevelMap?: Model<Api>['thinkingLevelMap'];
  openaiTokenLimit?: OpenAITokenLimitParam;
  source: 'config' | 'catalog' | 'fallback';
}

const ZERO_COST: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

const FALLBACK: ResolvedModelDetails = {
  contextWindow: 128000,
  maxTokens: 4096,
  reasoning: false,
  input: ['text'],
  cost: ZERO_COST,
  source: 'fallback',
};

/** Lower-case a model/catalog name so Azure and pi-ai ids can be matched. */
function normalizeModelName(name: string): string {
  return name.toLowerCase();
}

/** Build a map from normalized model id to pi-ai's built-in model metadata. */
function buildKnownModelCatalog(): Map<string, Model<Api>> {
  const catalog = new Map<string, Model<Api>>();
  for (const provider of getBuiltinProviders()) {
    for (const model of getBuiltinModels(provider)) {
      const key = normalizeModelName(model.id);
      if (catalog.has(key)) continue;
      catalog.set(key, model as Model<Api>);
    }
  }
  return catalog;
}

/**
 * Resolve model details in precedence order:
 *   1. User override in azure-foundry.config.json (exact Azure modelName)
 *   2. pi-ai built-in model catalog (normalized id match)
 *   3. Conservative fallback defaults
 */
function resolveModelDetails(
  modelName: string,
  catalog: Map<string, Model<Api>>,
  overrides: Record<string, ModelConfigOverride> | undefined,
): ResolvedModelDetails {
  const override = overrides?.[modelName];
  const catalogModel = catalog.get(normalizeModelName(modelName));

  // Start with catalog metadata, or the conservative fallback if unknown.
  const base: ResolvedModelDetails = catalogModel
    ? (() => {
        const compatMaxTokensField = (catalogModel as any).compat?.maxTokensField;
        return {
          contextWindow: catalogModel.contextWindow,
          maxTokens: catalogModel.maxTokens,
          reasoning: catalogModel.reasoning,
          input: catalogModel.input,
          cost: catalogModel.cost,
          thinkingLevelMap: catalogModel.thinkingLevelMap,
          openaiTokenLimit:
            compatMaxTokensField === 'max_tokens' || compatMaxTokensField === 'max_completion_tokens'
              ? compatMaxTokensField
              : undefined,
          source: 'catalog',
        };
      })()
    : FALLBACK;

  if (!override) return base;

  // Apply only the override keys that are present.
  return {
    ...base,
    ...override,
    cost: {
      ...base.cost,
      ...override.cost, // spreading undefined in JS is fine
    },
    source: 'config',
  };
}

/** Per-deployment API route resolved at discovery time */
type ApiRoute = { kind: 'anthropic-messages' } | { kind: 'openai-chat-completions'; tokenLimit: OpenAITokenLimitParam };

const apiRouteMap = new Map<string, ApiRoute>();

/** Infer OpenAI-compat token limit from resolved metadata or model name patterns. */
function inferOpenAITokenLimit(modelName: string, resolved: ResolvedModelDetails): OpenAITokenLimitParam {
  if (resolved.openaiTokenLimit) return resolved.openaiTokenLimit;
  // GPT-5 and o-series models reject max_tokens on Azure/OpenAI chat completions
  if (/^(gpt-5|o[1-9])([-.]|$)/i.test(modelName)) return 'max_completion_tokens';
  return 'max_tokens';
}

function resolveApiRoute(d: Deployment, resolved: ResolvedModelDetails): ApiRoute {
  if (d.modelPublisher === 'Anthropic') return { kind: 'anthropic-messages' };
  const modelName = d.modelName ?? d.name;
  return { kind: 'openai-chat-completions', tokenLimit: inferOpenAITokenLimit(modelName, resolved) };
}

function describeApiRoute(route: ApiRoute): string {
  if (route.kind === 'anthropic-messages') return 'anthropic-messages';
  return `openai-chat-completions (${route.tokenLimit})`;
}

/** Auth context per-provider, keyed by provider id */
interface ProviderAuth {
  type: AuthConfig['type'];
  getToken: () => Promise<string>;
}
const providerAuthMap = new Map<string, ProviderAuth>();

function deploymentToModel(
  d: Deployment,
  catalog: Map<string, Model<Api>>,
  overrides: Record<string, ModelConfigOverride> | undefined,
) {
  const modelName = d.modelName ?? d.name;
  const details = resolveModelDetails(modelName, catalog, overrides);
  apiRouteMap.set(d.name, resolveApiRoute(d, details));

  const model = {
    id: d.name,
    name: modelName,
    reasoning: details.reasoning,
    input: details.input,
    cost: details.cost,
    contextWindow: details.contextWindow,
    maxTokens: details.maxTokens,
    thinkingLevelMap: details.thinkingLevelMap,
  };

  if (details.source === 'fallback') {
    console.log(`[Azure Foundry] ${d.name}: no metadata for "${modelName}" — using fallback defaults`);
  } else if (details.source === 'config') {
    console.log(`[Azure Foundry] ${d.name}: using config override for "${modelName}"`);
  }

  return model;
}

// =============================================================================
// Retry / backoff for transient errors (429 throttling, 5xx)
// =============================================================================

/** Throttling (429), conflict/timeout, and transient upstream failures. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);
let retryConfig: Required<RetryConfig> = { maxRetries: 4, maxRetryDelayMs: 60_000 };
class AbortError extends Error {
  constructor() {
    super('Request aborted');
    this.name = 'AbortError';
  }
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AbortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AbortError());
    };
    const timer = setTimeout(
      () => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      },
      Math.max(0, ms),
    );
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function clampRetryDelay(delayMs: number): number {
  const max = retryConfig.maxRetryDelayMs;
  if (max > 0 && delayMs > max) {
    throw new Error(
      `Azure Foundry: server requested ${Math.ceil(delayMs / 1000)}s retry delay (max ${Math.ceil(max / 1000)}s)`,
    );
  }
  return Math.max(0, delayMs);
}

/**
 * Delay before the next attempt. Prefers the server's back-pressure hint
 * (`retry-after-ms`, then `retry-after` as seconds or an HTTP date); otherwise
 * decorrelated exponential backoff (0.5·2^attempt s, capped at 8s) with ~25%
 * jitter. Honoring Retry-After is the whole point — the coding-agent's outer
 * retry loop can't see this header, only the error string.
 */
function retryDelayMs(headers: Headers, attempt: number): number {
  const afterMs = headers.get('retry-after-ms');
  if (afterMs) {
    const v = Number.parseFloat(afterMs);
    if (!Number.isNaN(v)) return clampRetryDelay(v);
  }
  const after = headers.get('retry-after');
  if (after) {
    const secs = Number.parseFloat(after);
    const v = Number.isNaN(secs) ? Date.parse(after) - Date.now() : secs * 1000;
    return clampRetryDelay(v);
  }
  const expo = Math.min(0.5 * 2 ** attempt, 8) * 1000;
  return expo * (1 - Math.random() * 0.25);
}

/**
 * POST with bounded retry on 429/5xx. `buildInit` runs fresh per attempt so the
 * auth token is re-fetched — important when a long Retry-After outlives the
 * cached Entra token. Retries only happen BEFORE the response body streams, so
 * no partial output is ever discarded. Returns the first OK response; on
 * exhaustion throws `Azure Foundry <status>: <body>` (status preserved so the
 * outer session-level classifier can still catch genuine exhaustion).
 */
async function fetchWithRetry(
  url: string,
  buildInit: () => Promise<RequestInit>,
  signal?: AbortSignal,
): Promise<Response> {
  let attempt = 0;
  for (;;) {
    if (signal?.aborted) throw new AbortError();
    const response = await fetch(url, await buildInit());
    if (response.ok) return response;

    const body = await response.text().catch(() => '');
    if (attempt >= retryConfig.maxRetries || !RETRYABLE_STATUS.has(response.status)) {
      throw new Error(`Azure Foundry ${response.status}: ${body.slice(0, 500)}`);
    }
    // clampRetryDelay may throw on an over-long Retry-After; surface it verbatim.
    const delay = retryDelayMs(response.headers, attempt);
    console.log(
      `[Azure Foundry] ${response.status} — retry ${attempt + 1}/${retryConfig.maxRetries} in ${Math.round(delay)}ms: ${body.slice(0, 160)}`,
    );
    await abortableSleep(delay, signal);
    attempt++;
  }
}

// =============================================================================
// SSE Stream Parser
// =============================================================================

async function* parseSSE(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        const data = trimmed.slice(6);
        if (data === '[DONE]') return;
        yield data;
      }
    }
  }
}

// =============================================================================
// OpenAI-format message conversion  (for OpenAI / MoonshotAI / etc.)
// =============================================================================

function toOpenAIMessages(model: Model<Api>, systemPrompt: string | undefined, rawMessages: Message[]): unknown[] {
  const out: unknown[] = [];
  if (systemPrompt) out.push({ role: 'system', content: systemPrompt });

  // pi-ai's normalization pass: drops aborted/errored assistant turns and inserts
  // synthetic tool results for orphaned tool calls. Without it, an interrupted turn
  // leaves an assistant `tool_calls` with no matching `tool` message and OpenAI
  // rejects the whole request with "tool_call_ids did not have response messages".
  const messages = transformMessages(rawMessages, model);

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else {
        out.push({
          role: 'user',
          content: msg.content.map((c) =>
            c.type === 'text'
              ? { type: 'text', text: (c as TextContent).text }
              : c.type === 'image'
                ? {
                    type: 'image_url',
                    image_url: { url: `data:${(c as ImageContent).mimeType};base64,${(c as ImageContent).data}` },
                  }
                : { type: 'text', text: '' },
          ),
        });
      }
    } else if (msg.role === 'assistant') {
      const entry: Record<string, unknown> = { role: 'assistant' };
      const text = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => (b as TextContent).text)
        .join('\n');
      const tcs = msg.content
        .filter((b) => b.type === 'toolCall')
        .map((b) => ({
          id: (b as any).id,
          type: 'function',
          function: { name: (b as any).name, arguments: JSON.stringify((b as any).arguments) },
        }));
      if (tcs.length) entry.tool_calls = tcs;
      // OpenAI requires `content` to be a string on assistant messages; it may be
      // null only when tool_calls is present. A turn that reduced to no text and
      // no tool calls (e.g. a thinking-only turn) must still send content: "".
      entry.content = text ? text : tcs.length ? null : '';
      out.push(entry);
    } else if (msg.role === 'toolResult') {
      const m = msg as ToolResultMessage;
      out.push({
        role: 'tool',
        tool_call_id: m.toolCallId,
        content: m.content
          .filter((c): c is TextContent => c.type === 'text')
          .map((c) => c.text)
          .join('\n'),
      });
    }
  }
  return out;
}

function toOpenAITools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.parameters },
  }));
}

// =============================================================================
// Anthropic-format message conversion
// =============================================================================

function toAnthropicMessages(model: Model<Api>, rawMessages: Message[]): unknown[] {
  const out: unknown[] = [];
  // Same normalization as the OpenAI route — Anthropic is equally strict about a
  // `tool_use` block with no matching `tool_result`.
  const messages = transformMessages(rawMessages, model);
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        out.push({ role: 'user', content: msg.content });
      } else {
        out.push({
          role: 'user',
          content: msg.content.map((c) =>
            c.type === 'text'
              ? { type: 'text', text: (c as TextContent).text }
              : c.type === 'image'
                ? {
                    type: 'image',
                    source: {
                      type: 'base64',
                      media_type: (c as ImageContent).mimeType,
                      data: (c as ImageContent).data,
                    },
                  }
                : { type: 'text', text: '' },
          ),
        });
      }
    } else if (msg.role === 'assistant') {
      const blocks: unknown[] = [];
      for (const b of msg.content) {
        if (b.type === 'text') blocks.push({ type: 'text', text: (b as TextContent).text });
        if (b.type === 'thinking')
          blocks.push({
            type: 'thinking',
            thinking: (b as ThinkingContent).thinking,
            signature: (b as ThinkingContent).thinkingSignature ?? '',
          });
        if (b.type === 'toolCall')
          blocks.push({ type: 'tool_use', id: (b as any).id, name: (b as any).name, input: (b as any).arguments });
      }
      if (blocks.length) out.push({ role: 'assistant', content: blocks });
    } else if (msg.role === 'toolResult') {
      const m = msg as ToolResultMessage;
      const text = m.content
        .filter((c): c is TextContent => c.type === 'text')
        .map((c) => c.text)
        .join('\n');
      // Anthropic tool results go inside a user message
      out.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: m.toolCallId, content: text, is_error: m.isError }],
      });
    }
  }
  return out;
}

function toAnthropicTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: {
      type: 'object',
      properties: (t.parameters as any).properties ?? {},
      required: (t.parameters as any).required ?? [],
    },
  }));
}

// =============================================================================
// OpenAI-compatible streaming (OpenAI, MoonshotAI, etc.)
// =============================================================================

function streamOpenAI(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  baseHost: string,
  auth: ProviderAuth,
  route: Extract<ApiRoute, { kind: 'openai-chat-completions' }>,
): Promise<void> {
  return (async () => {
    const url = `${baseHost}/openai/deployments/${model.id}/chat/completions?api-version=2024-10-21`;
    const maxOutput = options?.maxTokens ?? model.maxTokens;
    const body: Record<string, unknown> = {
      messages: toOpenAIMessages(model, context.systemPrompt, context.messages),
      [route.tokenLimit]: maxOutput,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (context.tools?.length) body.tools = toOpenAITools(context.tools);

    const payload = JSON.stringify(body);
    const response = await fetchWithRetry(
      url,
      async () => {
        const token = await auth.getToken();
        // OpenAI-compat route: api-key auth uses the "api-key" header;
        // Entra ID (azure-identity) uses "Authorization: Bearer".
        const authHeaders: Record<string, string> =
          auth.type === 'api-key' ? { 'api-key': token } : { Authorization: `Bearer ${token}` };
        return {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...authHeaders },
          body: payload,
          signal: options?.signal,
        };
      },
      options?.signal,
    );
    if (!response.body) throw new Error('No response body');

    stream.push({ type: 'start', partial: output });

    const tcJsonBufs = new Map<number, string>();
    const tcContentIdx = new Map<number, number>();
    const reader = response.body.getReader();

    for await (const data of parseSSE(reader)) {
      let chunk: any;
      try {
        chunk = JSON.parse(data);
      } catch {
        continue;
      }

      if (chunk.usage) {
        output.usage.input = chunk.usage.prompt_tokens ?? 0;
        output.usage.output = chunk.usage.completion_tokens ?? 0;
        output.usage.totalTokens = chunk.usage.total_tokens ?? 0;
        calculateCost(model, output.usage);
      }

      const choice = chunk.choices?.[0];
      if (!choice?.delta) continue;
      const delta = choice.delta;

      if (typeof delta.content === 'string') {
        let idx = output.content.findIndex((b) => b.type === 'text');
        if (idx === -1) {
          output.content.push({ type: 'text', text: '' });
          idx = output.content.length - 1;
          stream.push({ type: 'text_start', contentIndex: idx, partial: output });
        }
        const block = output.content[idx];
        if (block.type === 'text') {
          block.text += delta.content;
          stream.push({ type: 'text_delta', contentIndex: idx, delta: delta.content, partial: output });
        }
      }

      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const tci = tc.index ?? 0;
          if (tc.id) {
            output.content.push({ type: 'toolCall', id: tc.id, name: tc.function?.name ?? '', arguments: {} });
            const ci = output.content.length - 1;
            tcContentIdx.set(tci, ci);
            tcJsonBufs.set(tci, '');
            stream.push({ type: 'toolcall_start', contentIndex: ci, partial: output });
          }
          if (tc.function?.arguments) {
            const ci = tcContentIdx.get(tci);
            if (ci === undefined) continue;
            const buf = (tcJsonBufs.get(tci) ?? '') + tc.function.arguments;
            tcJsonBufs.set(tci, buf);
            const block = output.content[ci];
            if (block.type === 'toolCall') {
              try {
                block.arguments = JSON.parse(buf);
              } catch {}
            }
            stream.push({ type: 'toolcall_delta', contentIndex: ci, delta: tc.function.arguments, partial: output });
          }
        }
      }

      if (choice.finish_reason === 'stop') output.stopReason = 'stop';
      else if (choice.finish_reason === 'length') output.stopReason = 'length';
      else if (choice.finish_reason === 'tool_calls') output.stopReason = 'toolUse';
      else if (choice.finish_reason) console.log(`[Azure Foundry] Unknown finish_reason: ${choice.finish_reason}`);
    }

    // Finalize blocks
    for (let i = 0; i < output.content.length; i++) {
      if (output.content[i].type === 'text')
        stream.push({
          type: 'text_end',
          contentIndex: i,
          content: (output.content[i] as TextContent).text,
          partial: output,
        });
    }
    for (const [tci, ci] of tcContentIdx) {
      const b = output.content[ci];
      if (b.type !== 'toolCall') continue;
      const raw = tcJsonBufs.get(tci) ?? '{}';
      try {
        b.arguments = JSON.parse(raw);
      } catch {
        console.log(`[Azure Foundry] Failed to parse tool call arguments for index ${tci}: ${raw.slice(0, 200)}`);
      }
      stream.push({ type: 'toolcall_end', contentIndex: ci, toolCall: b, partial: output });
    }
  })();
}

// =============================================================================
// Anthropic Messages API streaming
// =============================================================================

function streamAnthropic(
  model: Model<Api>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  output: AssistantMessage,
  stream: ReturnType<typeof createAssistantMessageEventStream>,
  baseHost: string,
  auth: ProviderAuth,
): Promise<void> {
  return (async () => {
    const url = `${baseHost}/anthropic/v1/messages`;
    const body: Record<string, unknown> = {
      model: model.id,
      messages: toAnthropicMessages(model, context.messages),
      max_tokens: options?.maxTokens ?? model.maxTokens,
      stream: true,
    };
    if (options?.temperature !== undefined) body.temperature = options.temperature;
    if (context.systemPrompt) body.system = context.systemPrompt;
    if (context.tools?.length) body.tools = toAnthropicTools(context.tools);

    const payload = JSON.stringify(body);
    const response = await fetchWithRetry(
      url,
      async () => {
        const token = await auth.getToken();
        // Anthropic route on Azure Foundry always uses "Authorization: Bearer"
        // regardless of auth type — api-key values are valid Bearer tokens here.
        return {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            'anthropic-version': '2023-06-01',
          },
          body: payload,
          signal: options?.signal,
        };
      },
      options?.signal,
    );
    if (!response.body) throw new Error('No response body');

    stream.push({ type: 'start', partial: output });

    // Anthropic SSE events: message_start, content_block_start, content_block_delta, content_block_stop, message_delta, message_stop
    const blockIndices = new Map<number, number>(); // anthropic block index → output.content index
    const tcJsonBufs = new Map<number, string>();
    const reader = response.body.getReader();

    for await (const data of parseSSE(reader)) {
      let event: any;
      try {
        event = JSON.parse(data);
      } catch {
        continue;
      }

      if (event.type === 'message_start' && event.message?.usage) {
        output.usage.input = event.message.usage.input_tokens ?? 0;
        output.usage.cacheRead = event.message.usage.cache_read_input_tokens ?? 0;
        output.usage.cacheWrite = event.message.usage.cache_creation_input_tokens ?? 0;
      }

      if (event.type === 'content_block_start') {
        const cb = event.content_block;
        const anthropicIdx = event.index;
        if (cb.type === 'text') {
          output.content.push({ type: 'text', text: '' });
          const ci = output.content.length - 1;
          blockIndices.set(anthropicIdx, ci);
          stream.push({ type: 'text_start', contentIndex: ci, partial: output });
        } else if (cb.type === 'thinking') {
          output.content.push({ type: 'thinking', thinking: '', thinkingSignature: '' } as ThinkingContent);
          blockIndices.set(anthropicIdx, output.content.length - 1);
          stream.push({ type: 'thinking_start', contentIndex: output.content.length - 1, partial: output });
        } else if (cb.type === 'tool_use') {
          output.content.push({ type: 'toolCall', id: cb.id, name: cb.name, arguments: {} });
          const ci = output.content.length - 1;
          blockIndices.set(anthropicIdx, ci);
          tcJsonBufs.set(anthropicIdx, '');
          stream.push({ type: 'toolcall_start', contentIndex: ci, partial: output });
        }
      }

      if (event.type === 'content_block_delta') {
        const ci = blockIndices.get(event.index);
        if (ci === undefined) continue;
        const block = output.content[ci];
        const d = event.delta;

        if (d.type === 'text_delta' && block.type === 'text') {
          block.text += d.text;
          stream.push({ type: 'text_delta', contentIndex: ci, delta: d.text, partial: output });
        } else if (d.type === 'thinking_delta' && block.type === 'thinking') {
          (block as ThinkingContent).thinking += d.thinking;
          stream.push({ type: 'thinking_delta', contentIndex: ci, delta: d.thinking, partial: output });
        } else if (d.type === 'signature_delta' && block.type === 'thinking') {
          (block as ThinkingContent).thinkingSignature =
            ((block as ThinkingContent).thinkingSignature ?? '') + d.signature;
        } else if (d.type === 'input_json_delta' && block.type === 'toolCall') {
          const buf = (tcJsonBufs.get(event.index) ?? '') + d.partial_json;
          tcJsonBufs.set(event.index, buf);
          try {
            block.arguments = JSON.parse(buf);
          } catch {}
          stream.push({ type: 'toolcall_delta', contentIndex: ci, delta: d.partial_json, partial: output });
        }
      }

      if (event.type === 'content_block_stop') {
        const ci = blockIndices.get(event.index);
        if (ci === undefined) continue;
        const block = output.content[ci];
        if (block.type === 'text')
          stream.push({ type: 'text_end', contentIndex: ci, content: block.text, partial: output });
        else if (block.type === 'thinking')
          stream.push({
            type: 'thinking_end',
            contentIndex: ci,
            content: (block as ThinkingContent).thinking,
            partial: output,
          });
        else if (block.type === 'toolCall') {
          const raw = tcJsonBufs.get(event.index) ?? '{}';
          try {
            block.arguments = JSON.parse(raw);
          } catch {
            console.log(
              `[Azure Foundry] Failed to parse Anthropic tool call arguments for index ${event.index}: ${raw.slice(0, 200)}`,
            );
          }
          stream.push({ type: 'toolcall_end', contentIndex: ci, toolCall: block, partial: output });
        }
      }

      if (event.type === 'message_delta') {
        if (event.usage) {
          output.usage.output = event.usage.output_tokens ?? 0;
          output.usage.totalTokens =
            output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
          calculateCost(model, output.usage);
        }
        const sr = event.delta?.stop_reason;
        if (sr === 'end_turn' || sr === 'stop_sequence') output.stopReason = 'stop';
        else if (sr === 'max_tokens') output.stopReason = 'length';
        else if (sr === 'tool_use') output.stopReason = 'toolUse';
        else if (sr) console.log(`[Azure Foundry] Unknown Anthropic stop_reason: ${sr}`);
      }
    }
  })();
}

// =============================================================================
// Unified streamSimple — routes based on publisher
// =============================================================================

function streamAzureFoundry(
  model: Model<Api>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: Date.now(),
    };

    try {
      const baseHost = new URL(model.baseUrl).origin;
      const route = apiRouteMap.get(model.id) ?? { kind: 'openai-chat-completions', tokenLimit: 'max_tokens' };
      // Resolve auth: use registered provider auth, fall back to api-key from options.
      const auth: ProviderAuth = providerAuthMap.get(model.provider) ?? {
        type: 'api-key',
        getToken: () => Promise.resolve(options?.apiKey ?? ''),
      };

      if (route.kind === 'anthropic-messages') {
        await streamAnthropic(model, context, options, output, stream, baseHost, auth);
      } else {
        await streamOpenAI(model, context, options, output, stream, baseHost, auth, route);
      }

      stream.push({ type: 'done', reason: output.stopReason as 'stop' | 'length' | 'toolUse', message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? 'aborted' : 'error';
      output.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: 'error', reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

// =============================================================================
// Extension Entry Point
// =============================================================================

export default async function (pi: ExtensionAPI) {
  const config = loadConfig();
  if (config.retry) {
    retryConfig = {
      maxRetries: config.retry.maxRetries ?? retryConfig.maxRetries,
      maxRetryDelayMs: config.retry.maxRetryDelayMs ?? retryConfig.maxRetryDelayMs,
    };
  }
  console.log(
    `[Azure Foundry] Retry: ${retryConfig.maxRetries} attempts, ${Math.round(retryConfig.maxRetryDelayMs / 1000)}s Retry-After cap`,
  );
  const endpoint = `https://${config.resourceId}.services.ai.azure.com/api/projects/${config.projectId}`;

  // Discover deployments
  const url = `${endpoint}/deployments?api-version=v1`;
  console.log(`[Azure Foundry] Fetching deployments from: ${url}`);

  const getToken = makeTokenGetter(config.auth);
  console.log(`[Azure Foundry] Auth: ${config.auth.type}`);

  const token = await getToken();
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const b = await response.text().catch(() => '');
    throw new Error(`Azure Foundry API ${response.status}: ${b.slice(0, 200)}`);
  }

  const data = (await response.json()) as { value?: Deployment[] };
  const deployments = (data.value ?? []).filter((d) => d.capabilities?.chat_completion === 'true');
  if (deployments.length === 0) throw new Error('No chat-capable deployments found');

  const catalog = buildKnownModelCatalog();
  const models = deployments.map((d) => deploymentToModel(d, catalog, config.models));

  const summary = deployments
    .map((d) => {
      const route = apiRouteMap.get(d.name)!;
      return `${d.name} (${d.modelPublisher}, ${describeApiRoute(route)})`;
    })
    .join(', ');
  console.log(`[Azure Foundry] Found ${deployments.length} deployment(s): ${summary}`);

  const providerId = 'azure-foundry';
  // Store the auth context so streamAzureFoundry can build the right headers per-request.
  providerAuthMap.set(providerId, { type: config.auth.type, getToken });

  pi.registerProvider(providerId, {
    name: 'Azure Foundry',
    baseUrl: endpoint,
    // For api-key auth, store the real key. For azure-identity, pass a sentinel
    // so pi's required-field validation passes — tokens are always fetched at
    // request time via providerAuthMap and this value is never used.
    apiKey: config.auth.type === 'api-key' ? config.auth.apiKey : 'azure-identity',
    api: 'azure-foundry' as Api,
    streamSimple: streamAzureFoundry,
    models,
  });

  console.log(`[Azure Foundry] ✓ Registered ${deployments.length} model(s)`);
}
