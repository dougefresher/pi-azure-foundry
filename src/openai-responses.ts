/**
 * Azure OpenAI Responses API conversion and stream assembly.
 *
 * Chat Completions cannot combine function tools with reasoning_effort on
 * gpt-5.6+ ("Please use /v1/responses instead"). This module is that route:
 * typed input items, encrypted reasoning replay, tools and thinking together.
 *
 * Deliberately narrower than pi-ai's openai-responses-shared.ts — no grammar
 * tools, no deferred tools, no service-tier pricing. A coding agent needs
 * function calls and reasoning items, not Lark.
 *
 * Keep behaviour aligned with packages/ai/src/api/openai-responses-shared.ts
 * and azure-openai-responses.ts; re-diff on a pi-ai bump.
 */
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type ImageContent,
  type Message,
  type Model,
  type TextContent,
  type ThinkingContent,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
} from '@earendil-works/pi-ai';
import { transformMessages } from './pi-ai-vendored.js';

/** OpenAI Responses rejects max_output_tokens below 16. */
export const OPENAI_RESPONSES_MIN_OUTPUT_TOKENS = 16;

type ResponsesItem = Record<string, unknown>;

function sanitizeSurrogates(text: string): string {
  return text.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

function parsePartialJson(raw: string): Record<string, unknown> {
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function splitToolCallId(id: string): { callId: string; itemId?: string } {
  const sep = id.indexOf('|');
  if (sep === -1) return { callId: id };
  const callId = id.slice(0, sep);
  const itemId = id.slice(sep + 1);
  return itemId ? { callId, itemId } : { callId };
}

function isReasoningItem(value: unknown): value is ResponsesItem {
  return typeof value === 'object' && value !== null && (value as ResponsesItem).type === 'reasoning';
}

function toolResultOutput(model: Model<Api>, content: ToolResultMessage['content']): string | ResponsesItem[] {
  const text = content
    .filter((c): c is TextContent => c.type === 'text')
    .map((c) => c.text)
    .join('\n');
  const images = content.filter((c): c is ImageContent => c.type === 'image');
  const hasText = text.length > 0;

  if (images.length === 0 || !model.input.includes('image')) {
    return sanitizeSurrogates(hasText ? text : images.length > 0 ? '(see attached image)' : '(no tool output)');
  }

  const output: ResponsesItem[] = [];
  if (hasText) output.push({ type: 'input_text', text: sanitizeSurrogates(text) });
  for (const image of images) {
    output.push({
      type: 'input_image',
      detail: 'auto',
      image_url: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return output;
}

/**
 * pi Message[] → Responses `input` items.
 *
 * Tool calls are stored as `${call_id}|${item_id}` when we minted them on this
 * route; chat-completions leftovers are a bare call_id and replay without an
 * item id. Reasoning items are the JSON blob we stuffed into thinkingSignature
 * on the way in — a leftover field name from chat completions is dropped, not
 * sent as a key.
 */
export function toResponsesInput(
  model: Model<Api>,
  systemPrompt: string | undefined,
  rawMessages: Message[],
): ResponsesItem[] {
  const messages = transformMessages(rawMessages, model);
  const out: ResponsesItem[] = [];

  if (systemPrompt) {
    out.push({
      type: 'message',
      role: model.reasoning ? 'developer' : 'system',
      content: sanitizeSurrogates(systemPrompt),
    });
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.role === 'user') {
      if (typeof msg.content === 'string') {
        const text = sanitizeSurrogates(msg.content);
        if (text.length === 0) continue;
        out.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] });
      } else {
        const content: ResponsesItem[] = [];
        for (const c of msg.content) {
          if (c.type === 'text') {
            const text = sanitizeSurrogates((c as TextContent).text);
            if (text.length > 0) content.push({ type: 'input_text', text });
          } else if (c.type === 'image') {
            const img = c as ImageContent;
            content.push({
              type: 'input_image',
              detail: 'auto',
              image_url: `data:${img.mimeType};base64,${img.data}`,
            });
          }
        }
        if (content.length) out.push({ type: 'message', role: 'user', content });
      }
    } else if (msg.role === 'assistant') {
      const assistantMsg = msg as AssistantMessage;
      const isSameModel =
        assistantMsg.provider === model.provider && assistantMsg.api === model.api && assistantMsg.model === model.id;
      let textBlockIndex = 0;

      for (const block of assistantMsg.content) {
        if (block.type === 'thinking') {
          const t = block as ThinkingContent;
          if (!t.thinkingSignature) continue;
          try {
            const item = JSON.parse(t.thinkingSignature) as unknown;
            if (isReasoningItem(item)) out.push(item);
          } catch {
            // Chat-completions leftover (`reasoning_content` etc.). Not an item.
          }
        } else if (block.type === 'text') {
          const text = sanitizeSurrogates((block as TextContent).text);
          const stored = (block as TextContent & { textSignature?: string }).textSignature;
          let msgId = stored;
          if (msgId?.startsWith('{')) {
            try {
              const parsed = JSON.parse(msgId) as { v?: number; id?: string };
              if (parsed.v === 1 && typeof parsed.id === 'string') msgId = parsed.id;
            } catch {
              /* keep stored */
            }
          }
          if (!msgId) {
            msgId = textBlockIndex === 0 ? `msg_pi_${i}` : `msg_pi_${i}_${textBlockIndex}`;
          }
          textBlockIndex++;
          if (msgId.length > 64) msgId = `msg_${msgId.slice(0, 60)}`;
          out.push({
            type: 'message',
            role: 'assistant',
            id: msgId,
            status: 'completed',
            content: [{ type: 'output_text', text, annotations: [] }],
          });
        } else if (block.type === 'toolCall') {
          const tc = block as ToolCall;
          const { callId, itemId } = splitToolCallId(tc.id);
          const item: ResponsesItem = {
            type: 'function_call',
            call_id: callId,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments ?? {}),
          };
          // Only replay item ids we minted (fc_*). A chat-completions call_id, or
          // a cross-model fc_ id, is omitted so Azure does not try to pair it
          // with a reasoning item from a different turn.
          if (isSameModel && itemId?.startsWith('fc_')) item.id = itemId;
          out.push(item);
        }
      }
    } else if (msg.role === 'toolResult') {
      const m = msg as ToolResultMessage;
      const { callId } = splitToolCallId(m.toolCallId);
      out.push({
        type: 'function_call_output',
        call_id: callId,
        output: toolResultOutput(model, m.content),
      });
    }
  }

  return out;
}

export function toResponsesTools(tools: Tool[]): ResponsesItem[] {
  return tools.map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));
}

type StreamSink = Pick<AssistantMessageEventStream, 'push'>;

type StreamingToolCall = ToolCall & { partialJson?: string };

type OutputSlot =
  | { type: 'thinking'; block: ThinkingContent; contentIndex: number }
  | { type: 'text'; block: TextContent; contentIndex: number }
  | { type: 'toolCall'; block: StreamingToolCall; contentIndex: number };

function mapStopReason(
  status: string | undefined,
  incompleteReason?: string,
): { stopReason: AssistantMessage['stopReason']; errorMessage?: string } {
  if (!status || status === 'completed' || status === 'in_progress' || status === 'queued') {
    return { stopReason: 'stop' };
  }
  if (status === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') return { stopReason: 'length' };
    return {
      stopReason: 'error',
      errorMessage: incompleteReason
        ? `Response incomplete: ${incompleteReason}`
        : 'Response incomplete without a provider reason',
    };
  }
  return { stopReason: 'error' };
}

/**
 * Fold Responses SSE JSON payloads into `output` and emit pi stream events.
 * Does not end the stream — the caller does, after this returns.
 */
export async function processResponsesEvents(
  payloads: AsyncIterable<string>,
  output: AssistantMessage,
  stream: StreamSink,
  model: Model<Api>,
): Promise<void> {
  let sawTerminal = false;
  const slots = new Map<number, OutputSlot>();
  const reasoningById = new Map<string, ThinkingContent>();

  const getSlot = <T extends OutputSlot['type']>(
    index: number,
    type: T,
  ): Extract<OutputSlot, { type: T }> | undefined => {
    const slot = slots.get(index);
    return slot?.type === type ? (slot as Extract<OutputSlot, { type: T }>) : undefined;
  };

  const createSlot = (outputIndex: number, item: any): OutputSlot | undefined => {
    if (item?.type === 'reasoning') {
      const block: ThinkingContent = { type: 'thinking', thinking: '' };
      output.content.push(block);
      const slot: OutputSlot = { type: 'thinking', block, contentIndex: output.content.length - 1 };
      slots.set(outputIndex, slot);
      stream.push({ type: 'thinking_start', contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item?.type === 'message') {
      const block: TextContent = { type: 'text', text: '' };
      output.content.push(block);
      const slot: OutputSlot = { type: 'text', block, contentIndex: output.content.length - 1 };
      slots.set(outputIndex, slot);
      stream.push({ type: 'text_start', contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    if (item?.type === 'function_call') {
      const block: StreamingToolCall = {
        type: 'toolCall',
        id: item.id ? `${item.call_id}|${item.id}` : String(item.call_id ?? ''),
        name: item.name ?? '',
        arguments: {},
        partialJson: item.arguments || '',
      };
      output.content.push(block);
      const slot: OutputSlot = { type: 'toolCall', block, contentIndex: output.content.length - 1 };
      slots.set(outputIndex, slot);
      stream.push({ type: 'toolcall_start', contentIndex: slot.contentIndex, partial: output });
      return slot;
    }
    return undefined;
  };

  const backfillReasoningSignatures = (responseOutput: any[]): void => {
    // Azure can omit encrypted_content on output_item.done and only attach it
    // on response.completed. Without this, store:false replay 400s next turn.
    for (const item of responseOutput) {
      if (item?.type !== 'reasoning' || !item.encrypted_content) continue;
      const block = reasoningById.get(item.id);
      if (!block?.thinkingSignature) continue;
      try {
        const stored = JSON.parse(block.thinkingSignature) as ResponsesItem;
        if (stored.encrypted_content) continue;
        block.thinkingSignature = JSON.stringify({ ...stored, encrypted_content: item.encrypted_content });
      } catch {
        block.thinkingSignature = JSON.stringify(item);
      }
    }
  };

  const finalize = (response: any): void => {
    sawTerminal = true;
    backfillReasoningSignatures(response?.output ?? []);
    if (response?.id) output.responseId = response.id;
    if (response?.usage) {
      const inputDetails = response.usage.input_tokens_details as
        | { cached_tokens?: number; cache_write_tokens?: number }
        | undefined;
      const cachedTokens = inputDetails?.cached_tokens || 0;
      const cacheWriteTokens = inputDetails?.cache_write_tokens || 0;
      output.usage.input = Math.max(0, (response.usage.input_tokens || 0) - cachedTokens - cacheWriteTokens);
      output.usage.output = response.usage.output_tokens || 0;
      output.usage.cacheRead = cachedTokens;
      output.usage.cacheWrite = cacheWriteTokens;
      output.usage.reasoning = response.usage.output_tokens_details?.reasoning_tokens || 0;
      output.usage.totalTokens = response.usage.total_tokens || 0;
      output.usage.cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
      calculateCost(model, output.usage);
    }
    const status = response?.status as string | undefined;
    const incompleteReason =
      typeof response?.incomplete_details?.reason === 'string' ? response.incomplete_details.reason : undefined;
    const mapped = mapStopReason(status, incompleteReason);
    output.stopReason = mapped.stopReason;
    if (mapped.errorMessage === undefined) delete output.errorMessage;
    else output.errorMessage = mapped.errorMessage;
    if (output.content.some((b) => b.type === 'toolCall') && output.stopReason === 'stop') {
      output.stopReason = 'toolUse';
    }
  };

  for await (const data of payloads) {
    let event: any;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }

    if (event.type === 'response.created' && event.response?.id) {
      output.responseId = event.response.id;
    } else if (event.type === 'response.output_item.added') {
      createSlot(event.output_index, event.item);
    } else if (
      event.type === 'response.reasoning_summary_text.delta' ||
      event.type === 'response.reasoning_text.delta'
    ) {
      const slot = getSlot(event.output_index, 'thinking');
      if (!slot || typeof event.delta !== 'string') continue;
      slot.block.thinking += event.delta;
      stream.push({ type: 'thinking_delta', contentIndex: slot.contentIndex, delta: event.delta, partial: output });
    } else if (event.type === 'response.reasoning_summary_part.done') {
      const slot = getSlot(event.output_index, 'thinking');
      if (!slot) continue;
      slot.block.thinking += '\n\n';
      stream.push({ type: 'thinking_delta', contentIndex: slot.contentIndex, delta: '\n\n', partial: output });
    } else if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
      const slot = getSlot(event.output_index, 'text');
      if (!slot || typeof event.delta !== 'string') continue;
      slot.block.text += event.delta;
      stream.push({ type: 'text_delta', contentIndex: slot.contentIndex, delta: event.delta, partial: output });
    } else if (event.type === 'response.function_call_arguments.delta') {
      const slot = getSlot(event.output_index, 'toolCall');
      if (!slot || slot.block.partialJson === undefined || typeof event.delta !== 'string') continue;
      slot.block.partialJson += event.delta;
      slot.block.arguments = parsePartialJson(slot.block.partialJson);
      stream.push({
        type: 'toolcall_delta',
        contentIndex: slot.contentIndex,
        delta: event.delta,
        partial: output,
      });
    } else if (event.type === 'response.function_call_arguments.done') {
      const slot = getSlot(event.output_index, 'toolCall');
      if (!slot || slot.block.partialJson === undefined) continue;
      const previous = slot.block.partialJson;
      if (typeof event.arguments === 'string') {
        slot.block.partialJson = event.arguments;
        slot.block.arguments = parsePartialJson(event.arguments);
        if (event.arguments.startsWith(previous)) {
          const delta = event.arguments.slice(previous.length);
          if (delta.length > 0) {
            stream.push({
              type: 'toolcall_delta',
              contentIndex: slot.contentIndex,
              delta,
              partial: output,
            });
          }
        }
      }
    } else if (event.type === 'response.output_item.done') {
      const item = event.item;
      const slot = slots.get(event.output_index) ?? createSlot(event.output_index, item);
      if (item?.type === 'reasoning' && slot?.type === 'thinking') {
        const summaryText = Array.isArray(item.summary) ? item.summary.map((s: any) => s.text).join('\n\n') : '';
        const contentText = Array.isArray(item.content) ? item.content.map((c: any) => c.text).join('\n\n') : '';
        slot.block.thinking = summaryText || contentText || slot.block.thinking;
        slot.block.thinkingSignature = JSON.stringify(item);
        if (typeof item.id === 'string') reasoningById.set(item.id, slot.block);
        stream.push({
          type: 'thinking_end',
          contentIndex: slot.contentIndex,
          content: slot.block.thinking,
          partial: output,
        });
        slots.delete(event.output_index);
      } else if (item?.type === 'message' && slot?.type === 'text') {
        slot.block.text =
          item.content
            ?.map((c: any) => (c.type === 'output_text' ? c.text : c.refusal))
            .filter((t: unknown) => typeof t === 'string')
            .join('') || slot.block.text;
        if (typeof item.id === 'string') {
          (slot.block as TextContent & { textSignature?: string }).textSignature = JSON.stringify({
            v: 1,
            id: item.id,
          });
        }
        stream.push({
          type: 'text_end',
          contentIndex: slot.contentIndex,
          content: slot.block.text,
          partial: output,
        });
        slots.delete(event.output_index);
      } else if (item?.type === 'function_call' && slot?.type === 'toolCall') {
        const raw = item.arguments || slot.block.partialJson || '{}';
        slot.block.arguments = parsePartialJson(raw);
        if (item.call_id) {
          slot.block.id = item.id ? `${item.call_id}|${item.id}` : item.call_id;
        }
        if (item.name) slot.block.name = item.name;
        delete slot.block.partialJson;
        stream.push({ type: 'toolcall_end', contentIndex: slot.contentIndex, toolCall: slot.block, partial: output });
        slots.delete(event.output_index);
      }
    } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      finalize(event.response);
    } else if (event.type === 'error') {
      const nested = event.error && typeof event.error === 'object' ? event.error : undefined;
      const code =
        typeof event.code === 'string' ? event.code : typeof nested?.code === 'string' ? nested.code : undefined;
      const message =
        typeof event.message === 'string'
          ? event.message
          : typeof nested?.message === 'string'
            ? nested.message
            : undefined;
      throw new Error(`Azure OpenAI Responses error: ${message || code || JSON.stringify(event)}`);
    } else if (event.type === 'response.failed') {
      sawTerminal = true;
      const error = event.response?.error;
      const details = event.response?.incomplete_details;
      const msg = error
        ? `${error.code || 'unknown'}: ${error.message || 'no message'}`
        : details?.reason
          ? `incomplete: ${details.reason}`
          : 'Unknown error (no error details in response)';
      throw new Error(msg);
    }
  }

  if (!sawTerminal) {
    throw new Error('Azure OpenAI Responses stream ended before a terminal response event');
  }
}
