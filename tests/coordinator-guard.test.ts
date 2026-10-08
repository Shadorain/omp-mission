import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkCommand, checkToolCall, fingerprintScopes, isImplementationPath, mutatedPaths, type GuardScope } from '../src/coordinator-guard';
import type { Run } from '../src/types';

const real: Run = async (command, args, cwd, env) => {
  const child = Bun.spawn([command, ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};
const bash = (cwd: string, command: string) => real('bash', ['-c', command], cwd);
const git = async (cwd: string, ...args: string[]) => { const result = await real('git', args, cwd); if (result.code) throw new Error(result.stderr); };

let root: string;
let cwd: string;
let guard: GuardScope;

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'guard-')));
  cwd = join(root, 'repo');
  await mkdir(join(cwd, 'src'), { recursive: true });
  await mkdir(join(cwd, '.artifacts'), { recursive: true });
  await writeFile(join(cwd, 'src', 'a.ts'), 'a');
  await writeFile(join(cwd, 'src', 'b.ts'), 'b');
  await writeFile(join(cwd, 'notes.md'), 'notes');
  await real('git', ['init', '-q', '-b', 'main', cwd], root);
  await git(cwd, 'config', 'user.email', 't@t');
  await git(cwd, 'config', 'user.name', 't');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'init');
  guard = { cwd, scopes: ['src/**'] };
});
afterEach(() => rm(root, { recursive: true, force: true }));

const blocked = (command: string) => expect(checkCommand(command).allowed).toBe(false);
const allowed = (command: string) => expect(checkCommand(command).allowed).toBe(true);

test('direct coordinator edit/write of implementation paths is blocked, artifacts and external outputs pass', () => {
  expect(checkToolCall('write', { path: 'src/a.ts' }, guard).allowed).toBe(false);
  // A new unscoped repo file is still implementation: workers own the checkout.
  expect(checkToolCall('write', { path: 'src/c.ts' }, guard).allowed).toBe(false);
  expect(checkToolCall('write', { path: 'notes.md' }, guard).allowed).toBe(false);
  expect(checkToolCall('write', { path: 'new-impl.ts' }, guard).allowed).toBe(false);
  expect(checkToolCall('edit', { input: '[src/a.ts#1A2B]\nPUT 1.:\n+x' }, guard).allowed).toBe(false);
  expect(checkToolCall('edit', { input: '[notes.md#1A2B]\nPUT 1.:\n+x' }, guard).allowed).toBe(false);
  expect(checkToolCall('write', { path: '.artifacts/run.log' }, guard).allowed).toBe(true);
  expect(checkToolCall('write', { path: 'local://mission-plan.md' }, guard).allowed).toBe(true);
  expect(checkToolCall('write', { path: '/tmp/omp-mission-workers/m.plan.md' }, guard).allowed).toBe(true);
  expect(checkToolCall('read', { path: 'src/a.ts' }, guard).allowed).toBe(true);
  expect(checkToolCall('grep', { pattern: 'x' }, guard).allowed).toBe(true);
});

test('scopes win over .artifacts, and URIs/escapes cannot dodge the boundary', () => {
  const scoped = { ...guard, scopes: ['src/**', '.artifacts/evidence/**'] };
  expect(checkToolCall('write', { path: '.artifacts/evidence/out.json' }, scoped).allowed).toBe(false);
  expect(checkToolCall('write', { path: `file://${join(cwd, 'src', 'a.ts')}` }, guard).allowed).toBe(false);
  expect(checkToolCall('write', { path: 'file:///tmp/outside.ts' }, guard).allowed).toBe(true);
  expect(checkToolCall('write', { path: '../repo/src/a.ts' }, guard).allowed).toBe(false);
  const nested = { ...guard, toolCwd: join(cwd, 'src') };
  expect(checkToolCall('write', { path: '../notes.md' }, nested).allowed).toBe(false);
  expect(checkToolCall('write', { path: '../.artifacts/x' }, nested).allowed).toBe(true);
  expect(checkToolCall('write', { path: '.git/config' }, guard).allowed).toBe(false);
  const beads = { ...guard, beadsDir: join(cwd, '.beads') };
  expect(checkToolCall('write', { path: '.beads/db.jsonl' }, beads).allowed).toBe(false);
  expect(isImplementationPath('.beads/db.jsonl', beads)).toBe(false);
});

test('blanket git staging and commit -a are blocked even inside compound commands', () => {
  for (const command of [
    'git add -A', 'git add --all', 'git add -u', 'git add .', 'git add ./', 'git add :/', 'git add ..',
    'git stage .', 'git commit -a', 'git commit -am done', 'git commit --all', 'git commit -- .',
    'git status && git add -A', 'git add . && git commit -m x', 'echo hi; git commit -a',
    '(git add -A)', 'x=$(git add .)', 'echo `git add -A`', 'bash -c "git add ."', "sh -c 'git commit -a'",
    'eval "git add -A"', 'sudo git add .', 'timeout 60 git add -A', 'env F=1 git add --all',
    'git -C /repo add .', 'git --git-dir=x add -A', 'for f in a; do git add .; done',
    'if true; then git commit -a; fi', 'cat <<EOF\n$(git add -A)\nEOF',
  ]) blocked(command);
});

test('scoped integration, inspection, and non-git commands pass', () => {
  for (const command of [
    'git add src/a.ts', 'git add -A -- src/', 'git add -- src/a.ts notes.md', 'git add :/src',
    'git commit -m done', 'git commit -m "run git add -A first"', 'git commit -- src/a.ts', 'git commit --amend -m x',
    'git push origin feature', 'git status --porcelain', 'git diff HEAD', 'git log --oneline -5',
    'git stash list', 'git clean -n', 'git reset', 'git branch -D old', 'git tag v1', 'git fetch origin',
    'echo git add -A', 'cat <<EOF\ngit add -A\nEOF', 'bd create --title x', 'gh pr create --fill',
    'cargo auto test', 'cargo fmt --all -- --check', 'cargo fmt --check', 'npm run build', 'echo ok > out.txt', 'git rev-parse HEAD',
    'bd update leaf --description current --acceptance "returns 400"',
  ]) allowed(command);
});

test('commands that rewrite checkout files are blocked', () => {
  for (const command of [
    'git clean -fd', 'git reset --hard', 'git stash', 'git stash pop', 'git checkout -b x',
    'git switch main', 'git restore src/a.ts', 'git merge other', 'git rebase main', 'git pull',
    'git cherry-pick abc', 'git revert abc', 'git rm src/a.ts', 'git mv src/a.ts x', 'git worktree add ../w',
    'cargo fmt --all', 'cargo fmt', 'rustfmt src/a.ts',
  ]) blocked(command);
});

test('fingerprinting reports bash-made content and mode mutations inside scopes with exact paths', async () => {
  const before = await fingerprintScopes(real, cwd, guard.scopes);
  await bash(cwd, 'echo changed >> src/b.ts && chmod 755 src/a.ts && echo new > src/c.ts && rm notes.md');
  const after = await fingerprintScopes(real, cwd, guard.scopes);
  expect(mutatedPaths(before, after)).toEqual(['src/a.ts', 'src/b.ts', 'src/c.ts']);
  // notes.md left the fingerprint only because it was never inside a scope.
  const wide = await fingerprintScopes(real, cwd, ['**']);
  await bash(cwd, 'echo touch >> notes.md');
  expect(mutatedPaths(wide, await fingerprintScopes(real, cwd, ['**']))).toEqual(['notes.md']);
});

test('a scope with a literal file still catches its later creation, and vanished files are reported', async () => {
  const before = await fingerprintScopes(real, cwd, ['src/**', 'build/out.js']);
  await bash(cwd, 'mkdir -p build && echo js > build/out.js && rm src/a.ts');
  expect(mutatedPaths(before, await fingerprintScopes(real, cwd, ['src/**', 'build/out.js']))).toEqual(['build/out.js', 'src/a.ts']);
});

test('index/HEAD bookkeeping is not a mutation: committing scoped files leaves the fingerprint identical', async () => {
  await bash(cwd, 'echo x >> src/a.ts');
  const before = await fingerprintScopes(real, cwd, guard.scopes);
  await bash(cwd, 'git add src/a.ts && git commit -qm x && git tag t1');
  expect(mutatedPaths(before, await fingerprintScopes(real, cwd, guard.scopes))).toEqual([]);
});

test('.artifacts and the bead database are not implementation mutations, unless a scope owns them', async () => {
  const beadsDir = join(cwd, '.beads');
  const before = await fingerprintScopes(real, cwd, ['**'], beadsDir);
  await mkdir(beadsDir, { recursive: true });
  await bash(cwd, 'echo log > .artifacts/verify.log && echo db > .beads/db.jsonl');
  expect(mutatedPaths(before, await fingerprintScopes(real, cwd, ['**'], beadsDir))).toEqual([]);
  const scopedArtifacts = { ...guard, scopes: ['.artifacts/evidence/**'] };
  const beforeScoped = await fingerprintScopes(real, cwd, scopedArtifacts.scopes);
  await bash(cwd, 'mkdir -p .artifacts/evidence && echo x > .artifacts/evidence/f.json');
  expect(mutatedPaths(beforeScoped, await fingerprintScopes(real, cwd, scopedArtifacts.scopes))).toEqual(['.artifacts/evidence/f.json']);
  expect(isImplementationPath('.artifacts/evidence/f.json', scopedArtifacts)).toBe(true);
  expect(isImplementationPath('notes.md', guard)).toBe(true);
  expect(isImplementationPath(join(root, 'outside.ts'), guard)).toBe(false);
});

test('ignored verification output is excluded while an explicitly scoped ignored file stays protected',async()=>{
  await writeFile(join(cwd,'.gitignore'),'target/\n');
  await mkdir(join(cwd,'target'),{recursive:true});
  await writeFile(join(cwd,'target','owned.txt'),'before');
  const before=await fingerprintScopes(real,cwd,['**','target/owned.txt']);
  await bash(cwd,'echo generated > target/output.bin && echo changed > target/owned.txt');
  expect(mutatedPaths(before,await fingerprintScopes(real,cwd,['**','target/owned.txt']))).toEqual(['target/owned.txt']);
});
