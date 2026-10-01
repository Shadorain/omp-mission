import { expect, test } from 'bun:test';
import { inScope, outOfScope } from '../src/scope';

test('scopes match exact files, directory prefixes, and globs, but not look-alike siblings', () => {
  expect(inScope('src/a.ts', ['src/a.ts'])).toBe(true);
  expect(inScope('src/dir/a.ts', ['src/dir'])).toBe(true);
  expect(inScope('src/dir/a.ts', ['./src/dir/'])).toBe(true);
  expect(inScope('src/directory/a.ts', ['src/dir'])).toBe(false);
  expect(inScope('crates/platform/src/x/y.rs', ['crates/platform/**'])).toBe(true);
  expect(inScope('crates/platformer/x.rs', ['crates/platform/**'])).toBe(false);
  expect(inScope('crates/http/src/athletics.rs', ['crates/http/src/**'])).toBe(true);
  expect(inScope('Cargo.lock', ['Cargo.toml', 'Cargo.lock'])).toBe(true);
  expect(inScope('a.ts', [])).toBe(false);
  expect(inScope('a.ts', [''])).toBe(false);
});

test('outOfScope lists only the violations', () => {
  expect(outOfScope(['src/a.ts', 'docs/x.md', 'src/b.ts'], ['src/**'])).toEqual(['docs/x.md']);
});
