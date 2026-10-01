import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverBeadsDir, isolateCheckout } from '../src/isolate';
import type { Run, Source } from '../src/types';

const run: Run = async (command, args, cwd, env) => {
  const child = Bun.spawn([command, ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};
const git = async (cwd: string, ...args: string[]) => { const result = await run('git', args, cwd); if (result.code) throw new Error(result.stderr); return result.stdout.trim(); };
const linear = (id: string): Source => ({ kind: 'linear', id: `linear:${id}`, title: 'Ticket', body: '', comments: '', extra: '' });

let root: string;
let repo: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'isolate-')));
  repo = join(root, 'app');
  await run('git', ['init', '-q', '-b', 'main', repo], root);
  await git(repo, 'config', 'user.email', 't@t');
  await git(repo, 'config', 'user.name', 't');
  await writeFile(join(repo, 'a.txt'), 'a');
  await git(repo, 'add', '.');
  await git(repo, 'commit', '-qm', 'init');
});
afterEach(() => rm(root, { recursive: true, force: true }));

test('primary checkout gets a sibling mission worktree on a mission branch', async () => {
  const out = await isolateCheckout(run, { source: linear('CHR-9'), start: repo, base: 'main' });
  expect(out).toMatchObject({ cwd: join(root, 'app-mission-chr-9'), created: true, base: 'main', delivery: 'pr' });
  expect(await git(out.cwd, 'branch', '--show-current')).toBe('mission/chr-9');
  expect(await git(repo, 'branch', '--show-current')).toBe('main');
});

test('retry after a later failure reuses the worktree it made, and a different branch at that path is refused', async () => {
  const first = await isolateCheckout(run, { source: linear('CHR-9'), start: repo, base: 'main' });
  const again = await isolateCheckout(run, { source: linear('CHR-9'), start: repo, base: 'main' });
  expect(again).toMatchObject({ cwd: first.cwd, created: false });
  await git(first.cwd, 'checkout', '-q', '-b', 'other');
  await expect(isolateCheckout(run, { source: linear('CHR-9'), start: repo, base: 'main' })).rejects.toThrow(/already exists/);
});

test('a checkout that already belongs to the ticket is reused untouched', async () => {
  const ticket = join(root, 'ticket');
  await git(repo, 'worktree', 'add', '-q', '-b', 'chr-9-feature', ticket);
  const out = await isolateCheckout(run, { source: linear('CHR-9'), start: ticket });
  expect(out).toMatchObject({ cwd: await realpath(ticket), created: false });
});

test('a linked worktree for another purpose is refused instead of guessed', async () => {
  const other = join(root, 'scratch');
  await git(repo, 'worktree', 'add', '-q', '-b', 'scratch', other);
  await expect(isolateCheckout(run, { source: linear('CHR-9'), start: other })).rejects.toThrow(/does not belong/);
});

test('unresolved base, a missing base ref, and a taken branch name stop with the reason', async () => {
  await expect(isolateCheckout(run, { source: linear('CHR-9'), start: repo })).rejects.toThrow(/base branch unresolved/);
  await expect(isolateCheckout(run, { source: linear('CHR-10'), start: repo, base: 'nope' })).rejects.toThrow(/not found/);
  await git(repo, 'branch', 'mission/chr-9');
  await expect(isolateCheckout(run, { source: linear('CHR-9'), start: repo, base: 'main' })).rejects.toThrow(/Branch already exists/);
});

test('non-git directories and freeform work default to local delivery', async () => {
  const plain = join(root, 'plain');
  await mkdir(plain);
  expect(await isolateCheckout(run, { source: linear('CHR-9'), start: plain })).toMatchObject({ cwd: plain, created: false, delivery: 'local' });
  const freeform: Source = { kind: 'freeform', id: 'freeform:x', title: 'x', body: '', comments: '', extra: '' };
  expect((await isolateCheckout(run, { source: freeform, start: repo, base: 'main' })).delivery).toBe('local');
});

test('a missing bead database is reported with the init command, never initialised', async () => {
  await expect(discoverBeadsDir(async () => ({ stdout: '', stderr: 'no database', code: 1 }), repo)).rejects.toThrow(/bd init --stealth/);
  expect(await discoverBeadsDir(async () => ({ stdout: JSON.stringify({ path: root }), stderr: '', code: 0 }), repo)).toBe(root);
});
