/**
 * Deployment-cache tests: the config toggle (cache: boolean), TTL resolution
 * (cacheTtlMinutes), freshness/key semantics, and the read/write round-trip.
 *
 * The cache I/O functions take an explicit file path so these tests stay out of
 * the real ~/.cache/pi-azure-foundry and hit an isolated temp file instead.
 *
 * Run with `bun test`.
 */
import { describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deployment } from '../src/index.ts';
import {
  DEFAULT_CACHE_TTL_MS,
  deploymentCacheKey,
  isDeploymentCacheEntryUsable,
  readDeploymentCache,
  resolveCachePolicy,
  writeDeploymentCache,
} from '../src/index.ts';

/** A temp cache file present for the duration of one test run. */
function tempCacheFile(): string {
  return join(mkdtempSync(join(tmpdir(), 'pi-azure-foundry-cache-')), 'deployments.json');
}

const sample: Deployment = {
  name: 'gpt-5-6',
  modelName: 'gpt-5.6',
  modelPublisher: 'OpenAI',
  capabilities: { chat_completion: 'true' },
};

describe('resolveCachePolicy (config toggle + TTL)', () => {
  test('omitted cache defaults to enabled with the 1-hour default TTL', () => {
    const { enabled, ttlMs } = resolveCachePolicy({});
    expect(enabled).toBe(true);
    expect(ttlMs).toBe(DEFAULT_CACHE_TTL_MS);
  });

  test('cache: false disables the cache entirely', () => {
    const { enabled } = resolveCachePolicy({ cache: false });
    expect(enabled).toBe(false);
  });

  test('cache: true keeps it enabled', () => {
    expect(resolveCachePolicy({ cache: true }).enabled).toBe(true);
  });

  test('cacheTtlMinutes overrides the default TTL', () => {
    const { ttlMs } = resolveCachePolicy({ cacheTtlMinutes: 15 });
    expect(ttlMs).toBe(15 * 60 * 1000);
  });

  test('cacheTtlMinutes is ignored when the cache is disabled', () => {
    const { enabled, ttlMs } = resolveCachePolicy({ cache: false, cacheTtlMinutes: 15 });
    expect(enabled).toBe(false);
    // Policy still reports the configured TTL, but the entry point never consults
    // the cache when enabled is false.
    expect(ttlMs).toBe(15 * 60 * 1000);
  });
});

describe('deploymentCacheKey', () => {
  test('scopes the cache to resource + project', () => {
    const a = deploymentCacheKey('res-a', 'proj-a');
    const b = deploymentCacheKey('res-b', 'proj-a');
    const c = deploymentCacheKey('res-a', 'proj-b');
    expect(a).not.toBe(b);
    expect(a).not.toBe(c);
    expect(b).not.toBe(c);
  });
});

describe('isDeploymentCacheEntryUsable', () => {
  const now = Date.now();
  const base = { key: 'k', fetchedAt: now, deployments: [sample] };

  test('fresh, matching, well-formed entry is usable', () => {
    expect(isDeploymentCacheEntryUsable(base, 'k', DEFAULT_CACHE_TTL_MS)).toBe(true);
  });

  test('stale entry (older than TTL) is a miss', () => {
    const stale = { ...base, fetchedAt: now - DEFAULT_CACHE_TTL_MS - 1 };
    expect(isDeploymentCacheEntryUsable(stale, 'k', DEFAULT_CACHE_TTL_MS)).toBe(false);
  });

  test('exactly-at-TTL entry is still usable', () => {
    const atEdge = { ...base, fetchedAt: now - DEFAULT_CACHE_TTL_MS };
    expect(isDeploymentCacheEntryUsable(atEdge, 'k', DEFAULT_CACHE_TTL_MS)).toBe(true);
  });

  test('key mismatch (different resource/project) is a miss', () => {
    expect(isDeploymentCacheEntryUsable(base, 'other-key', DEFAULT_CACHE_TTL_MS)).toBe(false);
  });

  test('non-array deployments payload is a miss', () => {
    expect(
      isDeploymentCacheEntryUsable({ ...base, deployments: {} as unknown as Deployment[] }, 'k', DEFAULT_CACHE_TTL_MS),
    ).toBe(false);
  });

  test('null entry is a miss', () => {
    expect(isDeploymentCacheEntryUsable(null, 'k', DEFAULT_CACHE_TTL_MS)).toBe(false);
  });

  test('future fetchedAt is a miss (clock skew / crafted entry)', () => {
    const future = { ...base, fetchedAt: now + 60_000 };
    expect(isDeploymentCacheEntryUsable(future, 'k', DEFAULT_CACHE_TTL_MS)).toBe(false);
  });

  test('non-numeric fetchedAt is a miss', () => {
    for (const bad of [
      '1712345678901' as unknown as number, // numeric string coerces silently otherwise
      Number.POSITIVE_INFINITY as unknown as number,
      Number.NaN as unknown as number,
      undefined as unknown as number,
    ]) {
      expect(isDeploymentCacheEntryUsable({ ...base, fetchedAt: bad }, 'k', DEFAULT_CACHE_TTL_MS)).toBe(false);
    }
  });
});

describe('readDeploymentCache / writeDeploymentCache round-trip', () => {
  test('write then read returns the same deployments for a matching key', () => {
    const file = tempCacheFile();
    writeDeploymentCache('k', [sample], file);
    const read = readDeploymentCache('k', DEFAULT_CACHE_TTL_MS, file);
    expect(read).not.toBeNull();
    expect(read!.deployments).toEqual([sample]);
  });

  test('missing file is a soft miss', () => {
    const file = tempCacheFile();
    expect(readDeploymentCache('k', DEFAULT_CACHE_TTL_MS, join(file, 'nope.json'))).toBeNull();
  });

  test('corrupt JSON is a miss and the file is deleted', () => {
    const file = tempCacheFile();
    writeFileSync(file, '{ this is not json', 'utf-8');
    expect(readDeploymentCache('k', DEFAULT_CACHE_TTL_MS, file)).toBeNull();
    // The corrupt file was swept so a later read is a clean miss (file gone).
    expect(existsSync(file)).toBe(false);
  });

  test('stale cached payload is a miss (TTL governs freshness)', () => {
    const file = tempCacheFile();
    // Write an entry whose fetchedAt is already far in the past.
    writeFileSync(
      file,
      JSON.stringify({ key: 'k2', fetchedAt: Date.now() - DEFAULT_CACHE_TTL_MS - 5000, deployments: [sample] }),
      'utf-8',
    );
    expect(readDeploymentCache('k2', DEFAULT_CACHE_TTL_MS, file)).toBeNull();

    // And the same on-disk entry is a *hit* under a larger TTL — proving the TTL,
    // not the file, is what decides freshness.
    const bigTtl = DEFAULT_CACHE_TTL_MS * 24;
    expect(readDeploymentCache('k2', bigTtl, file)).not.toBeNull();
  });

  test('wrong key (different project) is a miss even when fresh', () => {
    const file = tempCacheFile();
    writeDeploymentCache('k', [sample], file);
    expect(readDeploymentCache('other', DEFAULT_CACHE_TTL_MS, file)).toBeNull();
  });
});
