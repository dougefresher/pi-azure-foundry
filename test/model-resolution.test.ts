import { describe, expect, test } from 'bun:test';
import { buildKnownModelCatalog, resolveModelDetails } from '../src/index.ts';

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
});
