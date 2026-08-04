/**
 * Guards against the class of bug that shipped in 1.1.0: an import that `bun`
 * and `tsc` both resolve, but pi's extension loader cannot.
 *
 * pi-coding-agent's loader (dist/core/extensions/loader.js) maps a FIXED set of
 * specifiers for extensions. Anything else is path-joined onto the resolved root
 * — `@earendil-works/pi-ai/api/transform-messages` became
 * `.../pi-ai/dist/compat.js/api/transform-messages`, which fails at load time in
 * an installed extension and nowhere else.
 */
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Specifiers pi's extension loader resolves — the complete map from
 * `pi-coding-agent/dist/core/extensions/loader.js`. Everything else must be
 * vendored. Verify against that file before adding an entry here.
 */
const ALLOWED_BARE_IMPORTS = new Set([
  '@earendil-works/pi-ai',
  '@earendil-works/pi-ai/compat',
  '@earendil-works/pi-ai/oauth',
  '@earendil-works/pi-ai/providers/all',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-tui',
  // Bundled into the extension via bundledDependencies, so it resolves normally.
  '@azure/identity',
]);

const isNodeBuiltin = (spec: string) => spec.startsWith('node:');
const isRelative = (spec: string) => spec.startsWith('./') || spec.startsWith('../');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : [],
  );
}

/** Every import/export specifier in a source string, in every syntactic form. */
function specifiersIn(src: string): string[] {
  const specifiers: string[] = [];
  // from '...' covers both `import ... from` and `export ... from`.
  for (const m of src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)) specifiers.push(m[1]);
  for (const m of src.matchAll(/\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);
  // Side-effect imports have no `from` clause and no parentheses.
  for (const m of src.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)) specifiers.push(m[1]);
  for (const m of src.matchAll(/\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(m[1]);
  return specifiers;
}

const importsOf = (file: string): string[] => specifiersIn(readFileSync(file, 'utf-8'));

describe('extension imports are loader-resolvable', () => {
  const files = sourceFiles('src');

  test('src/ has files to check', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  test.each(files)('%s imports nothing the loader cannot resolve', (file) => {
    const offenders = importsOf(file).filter(
      (spec) => !isNodeBuiltin(spec) && !isRelative(spec) && !ALLOWED_BARE_IMPORTS.has(spec),
    );
    expect(offenders).toEqual([]);
  });

  test('the pi-ai subpath that broke 1.1.0 is specifically absent', () => {
    const all = files.flatMap(importsOf);
    expect(all.filter((s) => /^@earendil-works\/pi-ai\/(api|utils)\//.test(s))).toEqual([]);
  });

  // A guard that misses a syntactic form is worse than no guard: it reports green.
  test('the scanner sees every import form, not just `from`', () => {
    const src = [
      `import { a } from '@scope/from-clause';`,
      `export { b } from '@scope/export-from';`,
      `import '@scope/side-effect';`,
      `await import('@scope/dynamic');`,
      `const c = require('@scope/require');`,
    ].join('\n');
    expect(specifiersIn(src).sort()).toEqual([
      '@scope/dynamic',
      '@scope/export-from',
      '@scope/from-clause',
      '@scope/require',
      '@scope/side-effect',
    ]);
  });
});
