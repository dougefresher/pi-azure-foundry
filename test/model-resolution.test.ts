import { describe, expect, test } from 'bun:test';
import { buildKnownModelCatalog, resolveApiRoute, resolveModelDetails } from '../src/index.ts';

const catalog = buildKnownModelCatalog();

describe('Azure Foundry model metadata resolution', () => {
  test('prefers Azure OpenAI metadata over direct OpenAI metadata', () => {
    // Foundry's deployments API labels this modelPublisher simply "OpenAI".
    // Azure OpenAI's 1.05M context limit differs from direct OpenAI's 272K.
    const resolved = resolveModelDetails('gpt-5.6-terra', 'OpenAI', catalog, undefined);

    expect(resolved.source).toBe('catalog');
    expect(resolved.contextWindow).toBe(1_050_000);
    expect(resolved.maxTokens).toBe(128_000);
  });

  test('uses direct OpenAI metadata when the Azure catalog has no matching model', () => {
    const resolved = resolveModelDetails(
      'gpt-5.6-terra',
      'OpenAI',
      {
        ...catalog,
        byProvider: new Map([...catalog.byProvider].filter(([provider]) => provider !== 'azure-openai-responses')),
      },
      undefined,
    );

    expect(resolved.source).toBe('catalog');
    expect(resolved.contextWindow).toBe(272_000);
  });

  test('routes OpenAI deployments to Responses, preserving tools and reasoning together', () => {
    const route = resolveApiRoute({ name: 'gpt-prod', modelName: 'gpt-5.6-sol', modelPublisher: 'OpenAI' }, {} as any);
    expect(route).toEqual({ kind: 'openai-responses' });
  });

  test('uses max_completion_tokens for GPT-6 Astra on a compatible Chat Completions route', () => {
    expect(
      resolveApiRoute({ name: 'astra', modelName: 'gpt-6-astra', modelPublisher: 'SomeCompatPublisher' }, {} as any),
    ).toMatchObject({
      kind: 'openai-chat-completions',
      tokenLimit: 'max_completion_tokens',
    });
  });

  test('leaves non-OpenAI publishers on their native or compatible routes', () => {
    expect(resolveApiRoute({ name: 'claude', modelPublisher: 'Anthropic' }, {} as any)).toEqual({
      kind: 'anthropic-messages',
    });
    expect(resolveApiRoute({ name: 'grok', modelPublisher: 'xAI' }, {} as any)).toMatchObject({
      kind: 'openai-chat-completions',
      projectScoped: true,
    });
  });
});
