/**
 * Vendored from pi-ai 0.83.0. DO NOT import these from pi-ai directly.
 *
 * pi's extension loader (pi-coding-agent dist/core/extensions/loader.js) resolves
 * a fixed allowlist of specifiers for extensions — the whole map is:
 *
 *   @earendil-works/pi-ai                 -> ai/dist/compat.js
 *   @earendil-works/pi-ai/compat          -> ai/dist/compat.js
 *   @earendil-works/pi-ai/oauth           -> ai/dist/oauth.js
 *   @earendil-works/pi-ai/providers/all   -> ai/dist/providers/all.js
 *   @earendil-works/pi-coding-agent       -> coding-agent/dist/index.js
 *   @earendil-works/pi-agent-core         -> agent/dist/index.js
 *   @earendil-works/pi-tui                -> tui/dist/index.js
 *
 * Anything else — `@earendil-works/pi-ai/api/transform-messages`, say — is
 * path-joined onto the resolved root and produces a module that cannot exist:
 *
 *   Cannot find module '.../pi-ai/dist/compat.js/api/transform-messages'
 *
 * `bun` and `tsc` both resolve those subpaths happily against real node_modules,
 * so this fails only in an installed extension, at load time. Neither function
 * below is re-exported from `compat.js`, so copying is the only option.
 *
 * Note this is a RUNTIME gap, not a type gap: the types these use are all
 * exported from the pi-ai root. If upstream ever re-exports these two functions
 * from `compat.js`, this file can be deleted and the imports restored.
 *
 * Sources:
 *   packages/ai/src/api/transform-messages.ts  (transformMessages)
 *   packages/ai/src/api/simple-options.ts      (adjustMaxTokensForThinking)
 *
 * Keep behaviour identical to upstream; re-check on a pi-ai bump.
 */
import type {
  Api,
  AssistantMessage,
  ImageContent,
  Message,
  Model,
  TextContent,
  ThinkingLevel,
  ToolCall,
  ToolResultMessage,
} from '@earendil-works/pi-ai';

const NON_VISION_USER_IMAGE_PLACEHOLDER = '(image omitted: model does not support images)';
const NON_VISION_TOOL_IMAGE_PLACEHOLDER = '(tool image omitted: model does not support images)';

function replaceImagesWithPlaceholder(content: (TextContent | ImageContent)[], placeholder: string): TextContent[] {
  const result: TextContent[] = [];
  let previousWasPlaceholder = false;

  for (const block of content) {
    if (block.type === 'image') {
      if (!previousWasPlaceholder) {
        result.push({ type: 'text', text: placeholder });
      }
      previousWasPlaceholder = true;
      continue;
    }

    result.push(block);
    previousWasPlaceholder = block.text === placeholder;
  }

  return result;
}

function downgradeUnsupportedImages<TApi extends Api>(messages: Message[], model: Model<TApi>): Message[] {
  if (model.input.includes('image')) {
    return messages;
  }

  return messages.map((msg) => {
    if (msg.role === 'user' && Array.isArray(msg.content)) {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_USER_IMAGE_PLACEHOLDER),
      };
    }

    if (msg.role === 'toolResult') {
      return {
        ...msg,
        content: replaceImagesWithPlaceholder(msg.content, NON_VISION_TOOL_IMAGE_PLACEHOLDER),
      };
    }

    return msg;
  });
}

/**
 * Normalize a message history so it satisfies provider requirements:
 * downgrade images for non-vision models, clean up thinking blocks that cannot
 * be replayed, drop aborted/errored assistant turns, and synthesize tool results
 * for orphaned tool calls.
 */
export function transformMessages<TApi extends Api>(
  messages: Message[],
  model: Model<TApi>,
  normalizeToolCallId?: (id: string, model: Model<TApi>, source: AssistantMessage) => string,
): Message[] {
  const toolCallIdMap = new Map<string, string>();
  // Normalize null/undefined content from untyped callers (custom tools, hand-built
  // histories, old session files) so downstream code can rely on the type contract.
  const normalizedMessages = messages.map((msg) => (msg.content == null ? { ...msg, content: [] } : msg));
  const imageAwareMessages = downgradeUnsupportedImages(normalizedMessages, model);

  // First pass: image downgrade, thinking blocks, tool call ID normalization.
  const transformed = imageAwareMessages.map((msg) => {
    if (msg.role === 'user') return msg;

    if (msg.role === 'toolResult') {
      const normalizedId = toolCallIdMap.get(msg.toolCallId);
      if (normalizedId && normalizedId !== msg.toolCallId) {
        return { ...msg, toolCallId: normalizedId };
      }
      return msg;
    }

    if (msg.role === 'assistant') {
      const assistantMsg = msg as AssistantMessage;
      const isSameModel =
        assistantMsg.provider === model.provider && assistantMsg.api === model.api && assistantMsg.model === model.id;

      const transformedContent = assistantMsg.content.flatMap((block) => {
        if (block.type === 'thinking') {
          // Redacted thinking is opaque encrypted content, only valid for the same
          // model. Drop it cross-model to avoid API errors.
          if ((block as { redacted?: boolean }).redacted) {
            return isSameModel ? block : [];
          }
          // Same model: keep signed thinking blocks even when the text is empty
          // (OpenAI encrypted reasoning), since replay needs the signature.
          if (isSameModel && block.thinkingSignature) return block;
          if (!block.thinking || block.thinking.trim() === '') return [];
          if (isSameModel) return block;
          return { type: 'text' as const, text: block.thinking };
        }

        if (block.type === 'text') {
          if (isSameModel) return block;
          return { type: 'text' as const, text: block.text };
        }

        if (block.type === 'toolCall') {
          const toolCall = block as ToolCall;
          let normalizedToolCall: ToolCall = toolCall;

          if (!isSameModel && toolCall.thoughtSignature) {
            normalizedToolCall = { ...toolCall };
            delete normalizedToolCall.thoughtSignature;
          }

          if (!isSameModel && normalizeToolCallId) {
            const normalizedId = normalizeToolCallId(toolCall.id, model, assistantMsg);
            if (normalizedId !== toolCall.id) {
              toolCallIdMap.set(toolCall.id, normalizedId);
              normalizedToolCall = { ...normalizedToolCall, id: normalizedId };
            }
          }

          return normalizedToolCall;
        }

        return block;
      });

      return { ...assistantMsg, content: transformedContent };
    }

    return msg;
  });

  // Second pass: insert synthetic tool results for orphaned tool calls. This is
  // what keeps an interrupted turn from poisoning every later request.
  const result: Message[] = [];
  let pendingToolCalls: ToolCall[] = [];
  let existingToolResultIds = new Set<string>();

  const insertSyntheticToolResults = () => {
    if (pendingToolCalls.length > 0) {
      for (const tc of pendingToolCalls) {
        if (!existingToolResultIds.has(tc.id)) {
          result.push({
            role: 'toolResult',
            toolCallId: tc.id,
            toolName: tc.name,
            content: [{ type: 'text', text: 'No result provided' }],
            isError: true,
            timestamp: Date.now(),
          } as ToolResultMessage);
        }
      }
      pendingToolCalls = [];
      existingToolResultIds = new Set();
    }
  };

  for (let i = 0; i < transformed.length; i++) {
    const msg = transformed[i];

    if (msg.role === 'assistant') {
      insertSyntheticToolResults();

      // Skip errored/aborted assistant turns entirely: they may hold partial
      // content, replaying them causes API errors, and the model should retry
      // from the last valid state.
      const assistantMsg = msg as AssistantMessage;
      if (assistantMsg.stopReason === 'error' || assistantMsg.stopReason === 'aborted') {
        continue;
      }

      const toolCalls = assistantMsg.content.filter((b) => b.type === 'toolCall') as ToolCall[];
      if (toolCalls.length > 0) {
        pendingToolCalls = toolCalls;
        existingToolResultIds = new Set();
      }

      result.push(msg);
    } else if (msg.role === 'toolResult') {
      existingToolResultIds.add(msg.toolCallId);
      result.push(msg);
    } else if (msg.role === 'user') {
      // A user message interrupts the tool flow.
      insertSyntheticToolResults();
      result.push(msg);
    } else {
      result.push(msg);
    }
  }

  // A conversation ending on unresolved tool calls still needs results.
  insertSyntheticToolResults();

  return result;
}

/** Thinking budgets per level, matching pi-ai's defaults. */
export interface ThinkingBudgets {
  minimal?: number;
  low?: number;
  medium?: number;
  high?: number;
}

function clampReasoning(effort: ThinkingLevel | undefined): Exclude<ThinkingLevel, 'xhigh' | 'max'> | undefined {
  return effort === 'xhigh' || effort === 'max' ? 'high' : effort;
}

/**
 * Split a max_tokens cap into an output allowance and a thinking budget.
 * Note the caller must still check the result: a tight `baseMaxTokens` can drive
 * `thinkingBudget` below Anthropic's 1024 floor (or to 0), which the API rejects.
 */
export function adjustMaxTokensForThinking(
  baseMaxTokens: number | undefined,
  modelMaxTokens: number,
  reasoningLevel: ThinkingLevel,
  customBudgets?: ThinkingBudgets,
): { maxTokens: number; thinkingBudget: number } {
  const defaultBudgets: ThinkingBudgets = {
    minimal: 1024,
    low: 2048,
    medium: 8192,
    high: 16384,
  };
  const budgets = { ...defaultBudgets, ...customBudgets };

  const minOutputTokens = 1024;
  const level = clampReasoning(reasoningLevel)!;
  let thinkingBudget = budgets[level]!;
  const maxTokens =
    baseMaxTokens === undefined ? modelMaxTokens : Math.min(baseMaxTokens + thinkingBudget, modelMaxTokens);

  if (maxTokens <= thinkingBudget) {
    thinkingBudget = Math.max(0, maxTokens - minOutputTokens);
  }

  return { maxTokens, thinkingBudget };
}
