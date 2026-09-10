import { describe, expect, test } from 'bun:test';
import type { Api, AssistantMessage, Message, Model } from '@earendil-works/pi-ai';
import { processResponsesEvents, toResponsesInput } from '../src/openai-responses.ts';

const model = {
  id: 'gpt-5.6-sol',
  provider: 'azure-foundry',
  api: 'azure-foundry',
  input: ['text', 'image'],
  reasoning: true,
  maxTokens: 4096,
  contextWindow: 1_050_000,
  cost: { input: 1, output: 1, cacheRead: 0.1, cacheWrite: 0 },
} as unknown as Model<Api>;

function assistant(content: AssistantMessage['content']): Message {
  return {
    role: 'assistant',
    provider: 'azure-foundry',
    api: 'azure-foundry',
    model: 'gpt-5.6-sol',
    stopReason: 'toolUse',
    content,
  } as unknown as Message;
}

describe('OpenAI Responses input conversion', () => {
  test('uses typed function call/output items and preserves the opaque reasoning item', () => {
    const encryptedReasoning = {
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'opaque-to-pi',
    };
    const input = toResponsesInput(model, 'Be concise.', [
      { role: 'user', content: 'Inspect the file.' } as Message,
      assistant([
        { type: 'thinking', thinking: '', thinkingSignature: JSON.stringify(encryptedReasoning) },
        { type: 'toolCall', id: 'call_1|fc_1', name: 'read', arguments: { path: 'x.ts' } },
      ]),
      {
        role: 'toolResult',
        toolCallId: 'call_1|fc_1',
        toolName: 'read',
        content: [{ type: 'text', text: 'source' }],
        isError: false,
      } as unknown as Message,
      { role: 'user', content: 'Now summarize.' } as Message,
    ]) as any[];

    expect(input).toContainEqual({
      type: 'reasoning',
      id: 'rs_1',
      summary: [],
      encrypted_content: 'opaque-to-pi',
    });
    expect(input).toContainEqual({
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_1',
      name: 'read',
      arguments: '{"path":"x.ts"}',
    });
    expect(input).toContainEqual({ type: 'function_call_output', call_id: 'call_1', output: 'source' });
    expect(input[0]).toEqual({ type: 'message', role: 'developer', content: 'Be concise.' });
  });

  test('does not send a chat-completions reasoning field as a fake Responses item', () => {
    const input = toResponsesInput(model, undefined, [
      assistant([
        { type: 'thinking', thinking: 'hidden', thinkingSignature: 'reasoning_content' },
        { type: 'text', text: 'visible' },
      ]),
    ]) as any[];

    expect(input).toHaveLength(1);
    expect(input[0]).toMatchObject({ type: 'message', role: 'assistant' });
  });
});

describe('OpenAI Responses stream assembly', () => {
  test('retains terminal encrypted reasoning and assembles an interleaved function call', async () => {
    async function* payloads(): AsyncGenerator<string> {
      // Keep this an AsyncIterable, matching fetch/SSE production input.
      await Promise.resolve();
      yield JSON.stringify({ type: 'response.created', response: { id: 'resp_1' } });
      yield JSON.stringify({
        type: 'response.output_item.added',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1' },
      });
      yield JSON.stringify({ type: 'response.reasoning_summary_text.delta', output_index: 0, delta: 'Plan.' });
      yield JSON.stringify({
        type: 'response.output_item.done',
        output_index: 0,
        item: { type: 'reasoning', id: 'rs_1', summary: [{ text: 'Plan.' }] },
      });
      yield JSON.stringify({
        type: 'response.output_item.added',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '' },
      });
      yield JSON.stringify({ type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"path":' });
      yield JSON.stringify({
        type: 'response.function_call_arguments.done',
        output_index: 1,
        arguments: '{"path":"x.ts"}',
      });
      yield JSON.stringify({
        type: 'response.output_item.done',
        output_index: 1,
        item: { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read', arguments: '{"path":"x.ts"}' },
      });
      yield JSON.stringify({
        type: 'response.completed',
        response: {
          id: 'resp_1',
          status: 'completed',
          output: [{ type: 'reasoning', id: 'rs_1', encrypted_content: 'opaque-to-pi' }],
          usage: {
            input_tokens: 30,
            input_tokens_details: { cached_tokens: 10 },
            output_tokens: 8,
            output_tokens_details: { reasoning_tokens: 5 },
            total_tokens: 38,
          },
        },
      });
    }

    const output = {
      role: 'assistant',
      content: [],
      api: 'azure-foundry',
      provider: 'azure-foundry',
      model: 'gpt-5.6-sol',
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'pending',
      timestamp: Date.now(),
    } as unknown as AssistantMessage;
    const events: any[] = [];
    await processResponsesEvents(payloads(), output, { push: (event: any) => events.push(event) }, model);

    expect(output.responseId).toBe('resp_1');
    expect(output.stopReason).toBe('toolUse');
    expect(output.usage).toMatchObject({ input: 20, cacheRead: 10, output: 8, reasoning: 5, totalTokens: 38 });
    expect(output.content).toContainEqual({
      type: 'toolCall',
      id: 'call_1|fc_1',
      name: 'read',
      arguments: { path: 'x.ts' },
    });
    const thought = output.content.find((block) => block.type === 'thinking') as any;
    expect(JSON.parse(thought.thinkingSignature)).toMatchObject({ encrypted_content: 'opaque-to-pi' });
    expect(events.map((event) => event.type)).toContain('toolcall_end');
  });
});
