/**
 * Live smoke test against a real Azure AI Foundry account.
 *
 * Ad-hoc only: `bun run smoke`. Plain `bun test` must never reach this file —
 * it spends money — which is why it lives outside `root` in bunfig.toml rather
 * than in test/.
 *
 * What it is for: the tests in test/ prove the converters emit a given shape.
 * They cannot prove Azure accepts that shape, and every fix in this extension is
 * ultimately a bet about a remote API's tolerance — thinking budgets,
 * cache_control markers, reasoning_effort on a given api-version, whether an
 * orphaned tool call still 400s. This exercises those bets end to end through
 * the real extension entry point.
 *
 * Costs a fraction of a cent per run. Needs the same config and credentials the
 * extension itself uses: ~/.pi/azure-foundry.config.json, plus `az login` when
 * auth.type is azure-identity.
 *
 * Deployment names track infra/foundry.ts, which churns. Override per run:
 *   SMOKE_ANTHROPIC_MODEL=claude-opus-5 bun run smoke
 */

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Api, AssistantMessage, Context, Message, Model } from '@earendil-works/pi-ai';
import ext from '../src/index.ts';

const OPENAI_MODEL = process.env.SMOKE_OPENAI_MODEL ?? 'gpt-5.6-luna';
const ANTHROPIC_MODEL = process.env.SMOKE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const REASONING_MODEL = process.env.SMOKE_REASONING_MODEL ?? 'DeepSeek-V4-Flash';

const LONE_SURROGATE = String.fromCharCode(0xd83d);
/** Generous: a reasoning deployment under load can take a minute or more. */
const TIMEOUT = 180_000;

type Stream = (model: Model<Api>, context: Context, options?: any) => AsyncIterable<any>;

// A config file is required before anything else — failing here beats a dozen
// identical auth errors further down.
if (
  ![resolve(process.cwd(), 'azure-foundry.config.json'), resolve(homedir(), '.pi', 'azure-foundry.config.json')].some(
    existsSync,
  )
) {
  throw new Error('No azure-foundry.config.json in cwd or ~/.pi — this is a live test and needs a real account.');
}

// Deployments are discovered at MODULE scope, not in beforeAll. `test.skipIf`
// takes a value and evaluates it while tests are being collected, which happens
// before any lifecycle hook runs — so a hook-populated list would read as empty
// and silently skip the entire suite.
let stream: Stream | undefined;
let models: Model<Api>[] = [];
await ext({
  registerProvider: (_id: string, p: any) => {
    stream = p.streamSimple;
    models = p.models.map((m: any) => ({ ...m, provider: 'azure-foundry', api: 'azure-foundry', baseUrl: p.baseUrl }));
  },
} as any);

/** True when the deployment is absent — pass straight to test.skipIf. */
const missing = (id: string): boolean => !models.some((m) => m.id === id);
const model = (id: string): Model<Api> => {
  const m = models.find((x) => x.id === id);
  if (!m) throw new Error(`deployment "${id}" not registered`);
  return m;
};

/** Drive one request to completion and return the final assistant message. */
async function complete(
  id: string,
  messages: Message[],
  options: Record<string, unknown> = {},
  systemPrompt = 'You are terse. Answer in under ten words.',
): Promise<AssistantMessage> {
  const context = { systemPrompt, messages, tools: [] } as unknown as Context;
  let final: AssistantMessage | undefined;
  for await (const ev of stream!(model(id), context, { maxTokens: 4096, ...options })) {
    if (ev.type === 'done') final = ev.message;
    else if (ev.type === 'error') final = ev.error;
  }
  expect(final, 'stream ended without a done or error event').toBeDefined();
  // Surface the provider's own message rather than a bare stopReason.
  expect(final!.errorMessage ?? null).toBeNull();
  expect(final!.stopReason).not.toBe('error');
  expect(final!.stopReason).not.toBe('aborted');
  return final!;
}

/** An assistant turn that called a tool, with no result following it. */
const orphanedToolCall = (id: string): Message[] =>
  [
    { role: 'user', content: 'Call the noop tool.' },
    {
      role: 'assistant',
      provider: 'azure-foundry',
      api: 'azure-foundry',
      model: id,
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call_smoke_orphan', name: 'noop', arguments: {} }],
    },
    { role: 'user', content: 'Never mind, just say hello.' },
  ] as unknown as Message[];

/** Parallel tool calls, both answered — the shape that broke role alternation. */
const parallelToolResults = (id: string): Message[] =>
  [
    { role: 'user', content: 'Read two files.' },
    {
      role: 'assistant',
      provider: 'azure-foundry',
      api: 'azure-foundry',
      model: id,
      stopReason: 'toolUse',
      content: [
        { type: 'toolCall', id: 'call_smoke_a', name: 'read', arguments: { path: 'a' } },
        { type: 'toolCall', id: 'call_smoke_b', name: 'read', arguments: { path: 'b' } },
      ],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_smoke_a',
      toolName: 'read',
      content: [{ type: 'text', text: 'aaa' }],
      isError: false,
    },
    {
      role: 'toolResult',
      toolCallId: 'call_smoke_b',
      toolName: 'read',
      content: [{ type: 'text', text: 'bbb' }],
      isError: false,
    },
    { role: 'user', content: 'Summarize in three words.' },
  ] as unknown as Message[];

/** History whose every string carries an unpaired surrogate. */
const surrogateHistory = (id: string): Message[] =>
  [
    { role: 'user', content: `Read a file ${LONE_SURROGATE}` },
    {
      role: 'assistant',
      provider: 'azure-foundry',
      api: 'azure-foundry',
      model: id,
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call_smoke_uni', name: 'read', arguments: {} }],
    },
    {
      role: 'toolResult',
      toolCallId: 'call_smoke_uni',
      toolName: 'read',
      content: [{ type: 'text', text: `truncated ${LONE_SURROGATE} output` }],
      isError: false,
    },
    { role: 'user', content: 'Say OK.' },
  ] as unknown as Message[];

// -----------------------------------------------------------------------------

// Guard against the silent no-op: if every deployment name has drifted, the
// suite below skips itself into a green run that verified nothing. This test
// does not skip, so that shows up as a failure.
test('at least one target deployment is live', () => {
  const targets = [OPENAI_MODEL, ANTHROPIC_MODEL, REASONING_MODEL];
  const present = targets.filter((id) => models.some((m) => m.id === id));
  if (present.length === 0) {
    // Thrown rather than asserted so the remedy survives into the output; a
    // matcher's own failure message would replace it.
    throw new Error(
      `None of [${targets.join(', ')}] are deployed on this account.\n` +
        `Registered: ${models.map((m) => m.id).join(', ') || '(none)'}\n` +
        'Set SMOKE_OPENAI_MODEL / SMOKE_ANTHROPIC_MODEL / SMOKE_REASONING_MODEL to live deployment names.',
    );
  }
  expect(present.length).toBeGreaterThan(0);
});

describe('openai route', () => {
  // The bug that started all of this: an orphaned tool call used to 400.
  test.skipIf(missing(OPENAI_MODEL))(
    'orphaned tool call round-trips',
    async () => {
      const r = await complete(OPENAI_MODEL, orphanedToolCall(OPENAI_MODEL));
      expect(r.content).not.toBeEmpty();
    },
    TIMEOUT,
  );

  test.skipIf(missing(OPENAI_MODEL))(
    'parallel tool results accepted',
    async () => {
      const r = await complete(OPENAI_MODEL, parallelToolResults(OPENAI_MODEL));
      expect(r.content).not.toBeEmpty();
    },
    TIMEOUT,
  );

  test.skipIf(missing(OPENAI_MODEL))(
    'reasoning_effort is accepted',
    async () => {
      // Azure's chat-completions route reports reasoning as a token count only,
      // never as text, so assert acceptance rather than a thinking block.
      const r = await complete(OPENAI_MODEL, [{ role: 'user', content: 'What is 17*23?' }] as Message[], {
        reasoning: 'high',
      });
      expect(r.usage.output).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test.skipIf(missing(OPENAI_MODEL))(
    'usage totals reconcile with prompt_tokens',
    async () => {
      const { usage } = await complete(OPENAI_MODEL, [{ role: 'user', content: 'Say OK.' }] as Message[]);
      // A mismatch means the cached-token split is wrong, not that Azure lied.
      expect(usage.input + usage.output + usage.cacheRead + usage.cacheWrite).toBe(usage.totalTokens);
      expect(usage.input).toBeGreaterThanOrEqual(0);
    },
    TIMEOUT,
  );
});

describe('anthropic route', () => {
  test.skipIf(missing(ANTHROPIC_MODEL))(
    'orphaned tool call round-trips',
    async () => {
      const r = await complete(ANTHROPIC_MODEL, orphanedToolCall(ANTHROPIC_MODEL));
      expect(r.content).not.toBeEmpty();
    },
    TIMEOUT,
  );

  // One user message per tool_result would break role alternation here.
  test.skipIf(missing(ANTHROPIC_MODEL))(
    'parallel tool results accepted',
    async () => {
      const r = await complete(ANTHROPIC_MODEL, parallelToolResults(ANTHROPIC_MODEL));
      expect(r.content).not.toBeEmpty();
    },
    TIMEOUT,
  );

  test.skipIf(missing(ANTHROPIC_MODEL))(
    'thinking returns a thinking block',
    async () => {
      const r = await complete(
        ANTHROPIC_MODEL,
        [{ role: 'user', content: 'What is 17*23? Think first.' }] as Message[],
        {
          reasoning: 'medium',
        },
      );
      expect(r.content.map((b) => b.type)).toContain('thinking');
    },
    TIMEOUT,
  );

  test.skipIf(missing(ANTHROPIC_MODEL))(
    'prompt cache is read back on replay',
    async () => {
      // Needs a prefix over Anthropic's 1024-token minimum to be eligible.
      const system = 'You are a meticulous code reviewer. '.repeat(320);
      const messages = [{ role: 'user', content: 'Say OK.' }] as Message[];
      const first = await complete(ANTHROPIC_MODEL, messages, {}, system);
      expect(first.usage.cacheWrite + first.usage.cacheRead).toBeGreaterThan(0);
      const second = await complete(ANTHROPIC_MODEL, messages, {}, system);
      expect(second.usage.cacheRead).toBeGreaterThan(0);
    },
    TIMEOUT,
  );

  test.skipIf(missing(ANTHROPIC_MODEL))(
    'cacheRetention=none suppresses caching without breaking the call',
    async () => {
      const r = await complete(ANTHROPIC_MODEL, [{ role: 'user', content: 'Say OK.' }] as Message[], {
        cacheRetention: 'none',
      });
      expect(r.usage.cacheWrite).toBe(0);
    },
    TIMEOUT,
  );
});

describe('reasoning passthrough', () => {
  // Whether reasoning text is emitted is the deployment's call, so this asserts
  // only that a reasoning-capable deployment answers at all. If a thinking block
  // does come back, the delta plumbing is exercised.
  test.skipIf(missing(REASONING_MODEL))(
    `${REASONING_MODEL} answers, surfacing reasoning if it emits any`,
    async () => {
      const r = await complete(REASONING_MODEL, [
        { role: 'user', content: 'Is 91 prime? Reason step by step, then answer.' },
      ] as Message[]);
      expect(r.content.map((b) => b.type)).toContainAnyValues(['text', 'thinking']);
    },
    TIMEOUT,
  );
});

describe.each([
  ['openai', OPENAI_MODEL],
  ['anthropic', ANTHROPIC_MODEL],
])('%s route: unicode', (_label, id) => {
  // Azure 400s on unpaired surrogates; tool output truncated mid-emoji has them.
  test.skipIf(missing(id))(
    'lone surrogate in history survives the round trip',
    async () => {
      const r = await complete(id, surrogateHistory(id), {}, `You are terse ${LONE_SURROGATE}`);
      expect(r.content).not.toBeEmpty();
    },
    TIMEOUT,
  );
});
