/**
 * Message-conversion tests, modelled on the failure matrix pi-ai runs every
 * built-in provider through (see pi's .pi/skills/add-llm-provider.md):
 * tool-call-without-result, image-tool-result, unicode-surrogate, empty,
 * cross-provider-handoff.
 *
 * Run with `bun test`.
 */
import { describe, expect, test } from 'bun:test';
import type { Api, Message, Model } from '@earendil-works/pi-ai';
import { sanitizeSurrogates, toAnthropicMessages, toOpenAIMessages } from '../src/index.ts';

const gpt = {
  id: 'gpt-5',
  provider: 'azure-foundry',
  api: 'azure-foundry',
  input: ['text', 'image'],
  reasoning: true,
  maxTokens: 4096,
  contextWindow: 128000,
} as unknown as Model<Api>;

const claude = { ...gpt, id: 'claude-sonnet-4-5' } as unknown as Model<Api>;

const textOnly = { ...gpt, input: ['text'] } as unknown as Model<Api>;

/** An assistant turn that issued tool calls, tagged as same-model so nothing is downgraded. */
function assistantWithCalls(...calls: Array<{ id: string; name: string }>): Message {
  return {
    role: 'assistant',
    provider: 'azure-foundry',
    api: 'azure-foundry',
    model: 'gpt-5',
    stopReason: 'toolUse',
    content: calls.map((c) => ({ type: 'toolCall', id: c.id, name: c.name, arguments: {} })),
  } as unknown as Message;
}

function toolResult(id: string, text: string, extra: Record<string, unknown> = {}): Message {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'bash',
    content: text ? [{ type: 'text', text }] : [],
    isError: false,
    ...extra,
  } as unknown as Message;
}

describe('tool calls without results', () => {
  const history: Message[] = [
    { role: 'user', content: 'go' } as Message,
    assistantWithCalls({ id: 'call_1', name: 'bash' }),
    { role: 'user', content: 'never mind' } as Message,
  ];

  test('OpenAI: every tool_call_id gets a tool message', () => {
    const out = toOpenAIMessages(gpt, undefined, history) as any[];
    const ids = out.filter((m) => m.role === 'assistant').flatMap((m) => m.tool_calls?.map((t: any) => t.id) ?? []);
    const answered = out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id);
    expect(ids).toEqual(['call_1']);
    expect(answered).toEqual(['call_1']);
    // and the synthetic result must precede the interrupting user message
    expect(out.findIndex((m) => m.role === 'tool')).toBeLessThan(out.length - 1);
  });

  test('Anthropic: every tool_use gets a tool_result', () => {
    const out = toAnthropicMessages(claude, history) as any[];
    const uses = out.flatMap((m: any) =>
      (Array.isArray(m.content) ? m.content : []).filter((b: any) => b.type === 'tool_use').map((b: any) => b.id),
    );
    const results = out.flatMap((m: any) =>
      (Array.isArray(m.content) ? m.content : [])
        .filter((b: any) => b.type === 'tool_result')
        .map((b: any) => b.tool_use_id),
    );
    expect(uses).toEqual(['call_1']);
    expect(results).toEqual(['call_1']);
  });
});

describe('parallel tool results', () => {
  const history: Message[] = [
    { role: 'user', content: 'go' } as Message,
    assistantWithCalls({ id: 'call_a', name: 'bash' }, { id: 'call_b', name: 'read' }),
    toolResult('call_a', 'a output'),
    toolResult('call_b', 'b output'),
  ];

  test('Anthropic groups them into ONE user message', () => {
    const out = toAnthropicMessages(claude, history) as any[];
    const userMsgs = out.filter((m) => m.role === 'user');
    // user "go" + a single tool_result carrier. Two carriers would break alternation.
    expect(userMsgs).toHaveLength(2);
    const results = userMsgs[1].content.filter((b: any) => b.type === 'tool_result');
    expect(results.map((b: any) => b.tool_use_id)).toEqual(['call_a', 'call_b']);
    // roles must strictly alternate
    const roles = out.map((m) => m.role);
    expect(roles.some((r, i) => i > 0 && r === roles[i - 1])).toBe(false);
  });

  test('OpenAI keeps one tool message per call', () => {
    const out = toOpenAIMessages(gpt, undefined, history) as any[];
    expect(out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id)).toEqual(['call_a', 'call_b']);
  });
});

describe('image tool results', () => {
  const withImage: Message[] = [
    { role: 'user', content: 'shot' } as Message,
    assistantWithCalls({ id: 'call_i', name: 'screenshot' }),
    {
      role: 'toolResult',
      toolCallId: 'call_i',
      toolName: 'screenshot',
      content: [{ type: 'image', mimeType: 'image/png', data: 'AAAA' }],
      isError: false,
    } as unknown as Message,
  ];

  test('OpenAI hoists images into a follow-up user message', () => {
    const out = toOpenAIMessages(gpt, undefined, withImage) as any[];
    const toolMsg = out.find((m) => m.role === 'tool');
    expect(toolMsg.content).toBe('(see attached image)');
    const last = out[out.length - 1];
    expect(last.role).toBe('user');
    expect(last.content.some((b: any) => b.type === 'image_url')).toBe(true);
  });

  test('Anthropic nests images inside tool_result content', () => {
    const out = toAnthropicMessages(claude, withImage) as any[];
    const result = out.at(-1).content[0];
    expect(result.type).toBe('tool_result');
    expect(result.content.some((b: any) => b.type === 'image')).toBe(true);
  });

  test('non-vision models get a text placeholder, never an image block', () => {
    const out = toOpenAIMessages(textOnly, undefined, withImage) as any[];
    expect(JSON.stringify(out)).not.toContain('image_url');
    expect(JSON.stringify(out)).toContain('image omitted');
  });
});

describe('empty content', () => {
  test('empty tool output gets a placeholder, not an empty string', () => {
    const history: Message[] = [
      { role: 'user', content: 'go' } as Message,
      assistantWithCalls({ id: 'call_e', name: 'bash' }),
      toolResult('call_e', ''),
    ];
    expect((toOpenAIMessages(gpt, undefined, history) as any[]).find((m) => m.role === 'tool').content).toBe(
      '(no tool output)',
    );
  });

  test('Anthropic never emits a whitespace-only text block', () => {
    const history: Message[] = [
      { role: 'user', content: 'hi' } as Message,
      {
        role: 'assistant',
        provider: 'azure-foundry',
        api: 'azure-foundry',
        model: 'claude-sonnet-4-5',
        stopReason: 'stop',
        content: [
          { type: 'text', text: '   ' },
          { type: 'text', text: 'real' },
        ],
      } as unknown as Message,
    ];
    const out = toAnthropicMessages(claude, history) as any[];
    const texts = out.at(-1).content.map((b: any) => b.text);
    expect(texts).toEqual(['real']);
  });
});

describe('thinking blocks', () => {
  const thinkingTurn = (signature: string | undefined): Message =>
    ({
      role: 'assistant',
      provider: 'azure-foundry',
      api: 'azure-foundry',
      model: 'claude-sonnet-4-5',
      stopReason: 'stop',
      content: [
        { type: 'thinking', thinking: 'pondering', thinkingSignature: signature },
        { type: 'text', text: 'answer' },
      ],
    }) as unknown as Message;

  test('Anthropic: signed thinking replays as a thinking block', () => {
    const out = toAnthropicMessages(claude, [
      { role: 'user', content: 'hi' } as Message,
      thinkingTurn('sig-abc'),
    ]) as any[];
    const block = out.at(-1).content[0];
    expect(block).toEqual({ type: 'thinking', thinking: 'pondering', signature: 'sig-abc' });
  });

  test('Anthropic: unsigned thinking degrades to text instead of a 400', () => {
    const out = toAnthropicMessages(claude, [
      { role: 'user', content: 'hi' } as Message,
      thinkingTurn(undefined),
    ]) as any[];
    const blocks = out.at(-1).content;
    expect(blocks.every((b: any) => b.type === 'text')).toBe(true);
    expect(blocks.some((b: any) => b.signature === '')).toBe(false);
  });

  test('OpenAI: reasoning replays on the field it streamed on', () => {
    const out = toOpenAIMessages(gpt, undefined, [
      { role: 'user', content: 'hi' } as Message,
      {
        role: 'assistant',
        provider: 'azure-foundry',
        api: 'azure-foundry',
        model: 'gpt-5',
        stopReason: 'stop',
        content: [
          { type: 'thinking', thinking: 'pondering', thinkingSignature: 'reasoning_content' },
          { type: 'text', text: 'answer' },
        ],
      } as unknown as Message,
    ]) as any[];
    expect(out.at(-1).reasoning_content).toBe('pondering');
  });
});

describe('unicode surrogates', () => {
  const lone = String.fromCharCode(0xd83d);

  test('paired surrogates survive, unpaired are stripped', () => {
    expect(sanitizeSurrogates('hi 🙈')).toBe('hi 🙈');
    expect(sanitizeSurrogates(`bad ${lone} here`)).toBe('bad  here');
  });

  test('nothing unpaired reaches the wire on either route', () => {
    const history: Message[] = [
      { role: 'user', content: `user ${lone}` } as Message,
      assistantWithCalls({ id: 'call_s', name: 'bash' }),
      toolResult('call_s', `tool ${lone} out`),
    ];
    const hasLone = (s: string) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
    expect(hasLone(JSON.stringify(toOpenAIMessages(gpt, `sys ${lone}`, history)))).toBe(false);
    expect(hasLone(JSON.stringify(toAnthropicMessages(claude, history)))).toBe(false);
  });
});
