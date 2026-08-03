/**
 * Live smoke test against a real Azure AI Foundry account.
 *
 * Ad-hoc only — `bun run smoke`. Deliberately NOT named *.test.ts so `bun test`
 * cannot pick it up and start spending money on every check.
 *
 * What it is for: the unit tests in test/ prove the converters emit a given
 * shape. They cannot prove Azure accepts that shape. Every fix in this extension
 * is ultimately a bet about a remote API's tolerance — thinking budgets,
 * cache_control markers, reasoning_effort on a given api-version, whether an
 * orphaned tool call still 400s. This exercises those bets end to end through
 * the real extension entry point.
 *
 * Costs a fraction of a cent per run. Requires the same config and credentials
 * the extension itself uses (~/.pi/azure-foundry.config.json, plus `az login`
 * when auth.type is azure-identity).
 */
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import type { Api, AssistantMessage, Context, Message, Model } from '@earendil-works/pi-ai';
import ext from '../src/index.ts';

// Deployment names on the target account. These track infra/foundry.ts, which
// churns — override per run rather than editing, e.g.
//   SMOKE_ANTHROPIC_MODEL=claude-opus-5 bun run smoke
// A name that is not deployed skips its cases instead of failing them.
const OPENAI_MODEL = process.env.SMOKE_OPENAI_MODEL ?? 'gpt-5.6-luna';
const ANTHROPIC_MODEL = process.env.SMOKE_ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
const REASONING_MODEL = process.env.SMOKE_REASONING_MODEL ?? 'DeepSeek-V4-Flash';

const LONE_SURROGATE = String.fromCharCode(0xd83d);

type Stream = (model: Model<Api>, context: Context, options?: any) => AsyncIterable<any>;

interface Case {
  name: string;
  run: () => Promise<string>;
}

let failures = 0;
let skipped = 0;
let ran = 0;

// -----------------------------------------------------------------------------
// Harness
// -----------------------------------------------------------------------------

function preflight(): void {
  const candidates = [
    resolve(process.cwd(), 'azure-foundry.config.json'),
    resolve(homedir(), '.pi', 'azure-foundry.config.json'),
  ];
  if (!candidates.some(existsSync)) {
    console.error('No azure-foundry.config.json found. Checked:');
    for (const c of candidates) console.error(`  ${c}`);
    console.error('\nThis is a live test — it needs a real account. Nothing was run.');
    process.exit(1);
  }
}

/** Register the provider exactly as pi would, and hand back its streamer + models. */
async function loadProvider(): Promise<{ stream: Stream; models: Model<Api>[] }> {
  let stream: Stream | undefined;
  let models: Model<Api>[] = [];
  await ext({
    registerProvider: (_id: string, p: any) => {
      stream = p.streamSimple;
      models = p.models.map((m: any) => ({
        ...m,
        provider: 'azure-foundry',
        api: 'azure-foundry',
        baseUrl: p.baseUrl,
      }));
    },
    // Everything else on ExtensionAPI is unused by this extension's entry point.
  } as any);
  if (!stream) throw new Error('extension did not register a provider');
  return { stream, models };
}

function pick(models: Model<Api>[], id: string): Model<Api> | undefined {
  return models.find((m) => m.id === id);
}

/** Drive one request to completion, returning the final assistant message. */
async function complete(
  stream: Stream,
  model: Model<Api>,
  messages: Message[],
  options: Record<string, unknown> = {},
  systemPrompt = 'You are terse. Answer in under ten words.',
): Promise<AssistantMessage> {
  const context = { systemPrompt, messages, tools: [] } as unknown as Context;
  let final: AssistantMessage | undefined;
  for await (const ev of stream(model, context, { maxTokens: 4096, ...options })) {
    if (ev.type === 'done') final = ev.message;
    else if (ev.type === 'error') final = ev.error;
  }
  if (!final) throw new Error('stream ended without a done or error event');
  if (final.stopReason === 'error' || final.stopReason === 'aborted') {
    throw new Error(final.errorMessage ?? `stopReason=${final.stopReason}`);
  }
  return final;
}

/** An assistant turn that called a tool, with no result following it. */
function orphanedToolCall(modelId: string): Message[] {
  return [
    { role: 'user', content: 'Call the noop tool.' },
    {
      role: 'assistant',
      provider: 'azure-foundry',
      api: 'azure-foundry',
      model: modelId,
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call_smoke_orphan', name: 'noop', arguments: {} }],
    },
    { role: 'user', content: 'Never mind, just say hello.' },
  ] as unknown as Message[];
}

/** Parallel tool calls, both answered — the shape that broke role alternation. */
function parallelToolResults(modelId: string): Message[] {
  return [
    { role: 'user', content: 'Read two files.' },
    {
      role: 'assistant',
      provider: 'azure-foundry',
      api: 'azure-foundry',
      model: modelId,
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
}

function usageSummary(m: AssistantMessage): string {
  const u = m.usage;
  return `in=${u.input} cr=${u.cacheRead} cw=${u.cacheWrite} out=${u.output} $${u.cost.total.toFixed(6)}`;
}

// -----------------------------------------------------------------------------
// Cases
// -----------------------------------------------------------------------------

function buildCases(stream: Stream, models: Model<Api>[]): Case[] {
  const cases: Case[] = [];
  const openai = pick(models, OPENAI_MODEL);
  const anthropic = pick(models, ANTHROPIC_MODEL);
  const reasoner = pick(models, REASONING_MODEL);

  const need = (model: Model<Api> | undefined, id: string, name: string, body: (m: Model<Api>) => Promise<string>) => {
    if (!model) {
      cases.push({
        name,
        run: () => Promise.reject(new Error(`SKIP deployment "${id}" not on this account`)),
      });
      return;
    }
    cases.push({ name, run: () => body(model) });
  };

  // The bug that started all of this: an orphaned tool call used to 400.
  need(openai, OPENAI_MODEL, 'openai: orphaned tool call round-trips', async (m) => {
    const r = await complete(stream, m, orphanedToolCall(m.id));
    return usageSummary(r);
  });

  need(anthropic, ANTHROPIC_MODEL, 'anthropic: orphaned tool call round-trips', async (m) => {
    const r = await complete(stream, m, orphanedToolCall(m.id));
    return usageSummary(r);
  });

  // Parallel results must land in one user message or alternation breaks.
  need(anthropic, ANTHROPIC_MODEL, 'anthropic: parallel tool results accepted', async (m) => {
    const r = await complete(stream, m, parallelToolResults(m.id));
    return usageSummary(r);
  });

  need(openai, OPENAI_MODEL, 'openai: parallel tool results accepted', async (m) => {
    const r = await complete(stream, m, parallelToolResults(m.id));
    return usageSummary(r);
  });

  // reasoning_effort must be accepted at whatever api-version is configured.
  need(openai, OPENAI_MODEL, 'openai: reasoning_effort accepted', async (m) => {
    const r = await complete(stream, m, [{ role: 'user', content: 'What is 17*23?' }] as Message[], {
      reasoning: 'high',
    });
    // Azure's chat-completions route reports reasoning as a token count only; it
    // does not stream the text. A count of 0 is legitimate on a trivial prompt.
    return `${usageSummary(r)} reasoning_tokens=${r.usage.reasoning ?? 0}`;
  });

  // Extended thinking must produce an actual thinking block.
  need(anthropic, ANTHROPIC_MODEL, 'anthropic: thinking returns a thinking block', async (m) => {
    const r = await complete(stream, m, [{ role: 'user', content: 'What is 17*23? Think first.' }] as Message[], {
      reasoning: 'medium',
    });
    const kinds = r.content.map((b) => b.type);
    if (!kinds.includes('thinking')) throw new Error(`no thinking block; got [${kinds.join(', ')}]`);
    return `blocks=[${kinds.join(',')}] ${usageSummary(r)}`;
  });

  // Publishers that DO stream reasoning text should surface a thinking block.
  need(reasoner, REASONING_MODEL, 'deepseek: reasoning_content surfaces as thinking', async (m) => {
    const r = await complete(stream, m, [
      { role: 'user', content: 'Is 91 prime? Reason step by step, then answer.' },
    ] as Message[]);
    const kinds = r.content.map((b) => b.type);
    // Not an assertion: whether reasoning is emitted is the deployment's call.
    return kinds.includes('thinking')
      ? `thinking present, ${usageSummary(r)}`
      : `no thinking emitted (allowed), ${usageSummary(r)}`;
  });

  // Prompt caching: second identical call must read from cache. Needs a prefix
  // over Anthropic's 1024-token minimum to be eligible at all.
  need(anthropic, ANTHROPIC_MODEL, 'anthropic: prompt cache is read on replay', async (m) => {
    const bigSystem = 'You are a meticulous code reviewer. '.repeat(320);
    const msgs = [{ role: 'user', content: 'Say OK.' }] as Message[];
    const first = await complete(stream, m, msgs, {}, bigSystem);
    const second = await complete(stream, m, msgs, {}, bigSystem);
    const wrote = first.usage.cacheWrite > 0 || first.usage.cacheRead > 0;
    if (!wrote) throw new Error(`first call neither wrote nor read cache (${usageSummary(first)})`);
    if (second.usage.cacheRead <= 0) throw new Error(`second call did not read cache (${usageSummary(second)})`);
    return `write=${first.usage.cacheWrite} read=${second.usage.cacheRead}`;
  });

  // cacheRetention: "none" must suppress the markers without breaking the call.
  need(anthropic, ANTHROPIC_MODEL, 'anthropic: cacheRetention=none still succeeds', async (m) => {
    const r = await complete(stream, m, [{ role: 'user', content: 'Say OK.' }] as Message[], {
      cacheRetention: 'none',
    });
    if (r.usage.cacheWrite > 0) throw new Error('cache was written despite cacheRetention=none');
    return usageSummary(r);
  });

  // Unpaired surrogates must be stripped before they reach Azure, which 400s.
  for (const [label, model, id] of [
    ['openai', openai, OPENAI_MODEL],
    ['anthropic', anthropic, ANTHROPIC_MODEL],
  ] as const) {
    need(model, id, `${label}: lone surrogate in tool output survives`, async (m) => {
      const msgs = [
        { role: 'user', content: `Read a file ${LONE_SURROGATE}` },
        {
          role: 'assistant',
          provider: 'azure-foundry',
          api: 'azure-foundry',
          model: m.id,
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
      const r = await complete(stream, m, msgs, {}, `You are terse ${LONE_SURROGATE}`);
      return usageSummary(r);
    });
  }

  // Reported usage must reconcile: input excludes cached tokens, total covers all.
  need(openai, OPENAI_MODEL, 'openai: usage totals reconcile', async (m) => {
    const r = await complete(stream, m, [{ role: 'user', content: 'Say OK.' }] as Message[]);
    const u = r.usage;
    const sum = u.input + u.output + u.cacheRead + u.cacheWrite;
    if (u.totalTokens !== sum) {
      // Azure reports total_tokens itself; a mismatch means our split is wrong.
      throw new Error(`total_tokens=${u.totalTokens} but input+output+cache=${sum}`);
    }
    if (u.input < 0) throw new Error(`negative input tokens: ${u.input}`);
    return `total=${u.totalTokens} == ${sum}`;
  });

  return cases;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

preflight();

const { stream, models } = await loadProvider();
console.log(`\nSmoke test — ${models.length} deployment(s) registered\n${'-'.repeat(72)}`);

for (const c of buildCases(stream, models)) {
  const started = Date.now();
  try {
    const detail = await c.run();
    ran++;
    console.log(`PASS  ${c.name.padEnd(48)} ${detail}  (${Date.now() - started}ms)`);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.startsWith('SKIP ')) {
      skipped++;
      console.log(`SKIP  ${c.name.padEnd(48)} ${msg.slice(5)}`);
    } else {
      failures++;
      console.log(`FAIL  ${c.name.padEnd(48)} ${msg.replace(/\s+/g, ' ').slice(0, 240)}`);
    }
  }
}

console.log('-'.repeat(72));

// Everything skipping is not a pass — it means the deployment names drifted and
// this run verified precisely nothing. Fail rather than report a green no-op.
if (failures === 0 && ran === 0) {
  console.log(`NOTHING RAN — all ${skipped} case(s) skipped; no deployment names matched`);
  console.log('Set SMOKE_OPENAI_MODEL / SMOKE_ANTHROPIC_MODEL / SMOKE_REASONING_MODEL to live deployments.\n');
  process.exit(1);
}

console.log(`${failures === 0 ? 'OK' : 'FAILED'} — ${ran} ran, ${failures} failure(s), ${skipped} skipped\n`);
process.exit(failures === 0 ? 0 : 1);
