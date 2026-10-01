import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { DEFAULT_MISSION_CONFIG } from '../src/config';
import { changedSince, extractYield, snapshotChanges, SubagentRunner, type SessionFactory, type Settled, type SubagentSession } from '../src/subagent';
import type { Mission, Run, Worker } from '../src/types';

const real: Run = async (command, args, cwd, env) => {
  const child = Bun.spawn([command, ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};
const git = async (cwd: string, ...args: string[]) => { const result = await real('git', args, cwd); if (result.code) throw new Error(result.stderr); return result.stdout.trim(); };

let root: string;
let cwd: string;
let agentDir: string;
let bdCalls: Array<{ args: string[]; env?: Record<string, string> }>;
let bdFail: (args: string[]) => boolean;
const run: Run = async (command, args, where, env) => {
  if (command !== 'bd') return real(command, args, where, env);
  bdCalls.push({ args, env });
  return bdFail(args) ? { code: 1, stdout: '', stderr: 'boom' } : { code: 0, stdout: '{}', stderr: '' };
};

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'subagent-')));
  cwd = join(root, 'repo');
  agentDir = join(root, 'agent');
  await mkdir(join(cwd, 'a'), { recursive: true });
  await mkdir(join(cwd, 'b'), { recursive: true });
  await mkdir(agentDir);
  await real('git', ['init', '-q', '-b', 'main', cwd], root);
  await git(cwd, 'config', 'user.email', 't@t');
  await git(cwd, 'config', 'user.name', 't');
  await writeFile(join(cwd, 'a', 'one.txt'), '1');
  await writeFile(join(cwd, 'b', 'two.txt'), '2');
  await git(cwd, 'add', '.');
  await git(cwd, 'commit', '-qm', 'init');
  bdCalls = [];
  bdFail = () => false;
});
afterEach(() => rm(root, { recursive: true, force: true }));

const mission = (workers: Worker[] = []): Mission => ({ version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'm', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd, delivery: 'local', beadsDir: join(root, 'beads') }, graph: 'beads', scopes: {}, phase: 'execute', evidence: {}, mode: 'auto', keep: false, reviewRequested: false, workers, reviews: [], repairLinks: {}, round: 1, createdAt: '', updatedAt: '' });
const worker = (beadId: string, files: string[]): Worker => ({ beadId, attempt: 'x', cwd, files, state: 'reserved', assignment: `do ${beadId}` });
const context = { model: { provider: 'p', id: 'm' }, modelRegistry: { getAvailable: () => [], authStorage: {} } } as unknown as ExtensionContext;

type Script = (ctx: { cwd: string; prompts: string[]; messages: unknown[] }) => Promise<void> | void;
const yielded = (data: unknown) => ({ role: 'toolResult', toolName: 'yield', details: { status: 'success', data } });
interface Fake { session: SubagentSession; prompts: string[]; prompted: Promise<void>; disposed: () => boolean; release: () => void }
/** `hang` keeps the first prompt unresolved until abort() or release(), like a model still working. */
function fake(script: Script, hang = false): Fake {
  const prompts: string[] = [];
  const messages: unknown[] = [];
  let disposed = false;
  let wake: () => void = () => {};
  const gate = new Promise<void>(resolve => { wake = resolve; });
  let markPrompted: () => void = () => {};
  const prompted = new Promise<void>(resolve => { markPrompted = resolve; });
  const session: SubagentSession = {
    state: { messages },
    async prompt(text) { prompts.push(text); markPrompted(); await script({ cwd, prompts, messages }); if (hang) await gate; },
    async steer(text) { prompts.push(`steer:${text}`); },
    async abort() { wake(); },
    async dispose() { disposed = true; },
  };
  return { session, prompts, prompted, disposed: () => disposed, release: () => wake() };
}

function harness(factory: SessionFactory) {
  const settled: Array<[string, Settled]> = [];
  const runner = new SubagentRunner({ run, agentDir, config: () => ({ ...DEFAULT_MISSION_CONFIG, workerContext: 'none' }), context: () => context, onSettled: (id, outcome) => settled.push([id, outcome]), sessionFactory: factory });
  return { runner, settled };
}

test('a worker that finishes in scope has its bead claimed first and closed from its yielded result', async () => {
  const f = fake(async ({ cwd, messages }) => { await writeFile(join(cwd, 'a', 'one.txt'), 'changed'); messages.push(yielded({ done: true, summary: 'edited one', verification: 'ran the check' })); });
  const { runner, settled } = harness(async () => ({ session: f.session, file: join(root, 's.jsonl') }));
  const w = worker('bd-1', ['a/**']);
  const identity = await runner.launch(mission([w]), w);
  expect(identity.handle).toBe('bd-1');
  await runner.whenDone('bd-1');
  expect(settled[0]).toEqual(['bd-1', { ok: true, summary: 'edited one' }]);
  expect(bdCalls.map(call => call.args.slice(0, 2))).toEqual([['update', 'bd-1'], ['close', 'bd-1']]);
  expect(bdCalls[0]!.env).toMatchObject({ BEADS_ACTOR: 'bd-1', BEADS_DIR: join(root, 'beads') });
  expect(bdCalls[1]!.args).toContain('edited one\nVerified: ran the check');
  expect(f.prompts[0]).toBe('do bd-1');
  expect(f.disposed()).toBe(true);
  expect(runner.isLive('bd-1')).toBe(false);
});

test('edits outside the allowed paths leave the bead open with the offending files named', async () => {
  const f = fake(async ({ cwd, messages }) => { await writeFile(join(cwd, 'b', 'two.txt'), 'oops'); await writeFile(join(cwd, 'stray.txt'), 'new'); messages.push(yielded({ done: true, summary: 'x' })); });
  const { runner, settled } = harness(async () => ({ session: f.session, file: join(root, 's.jsonl') }));
  const w = worker('bd-1', ['a/**']);
  await runner.launch(mission([w]), w);
  await runner.whenDone('bd-1');
  expect(settled[0]![1]).toMatchObject({ ok: false, error: expect.stringMatching(/outside the allowed paths \(b\/two\.txt, stray\.txt\)/) });
  expect(bdCalls.some(call => call.args[0] === 'close')).toBe(false);
});

test('a file that was already dirty at launch is judged by what the worker changed, not by being dirty', async () => {
  await writeFile(join(cwd, 'b', 'two.txt'), 'dirty before the worker');
  const f = fake(async ({ cwd, messages }) => { await writeFile(join(cwd, 'a', 'one.txt'), 'mine'); messages.push(yielded({ done: true, summary: 'ok' })); });
  const { runner, settled } = harness(async () => ({ session: f.session, file: join(root, 's.jsonl') }));
  const w = worker('bd-1', ['a/**']);
  await runner.launch(mission([w]), w);
  await runner.whenDone('bd-1');
  expect(settled[0]![1].ok).toBe(true);
});

test('missing yields are chased twice, then the worker is reported as failed', async () => {
  const f = fake(() => {});
  const { runner, settled } = harness(async () => ({ session: f.session, file: join(root, 's.jsonl') }));
  const w = worker('bd-1', ['a/**']);
  await runner.launch(mission([w]), w);
  await runner.whenDone('bd-1');
  expect(f.prompts.length).toBe(3);
  expect(settled[0]![1]).toEqual({ ok: false, error: 'worker ended without yielding a result' });
});

test('done:false and a failing bd close are reported, never swallowed', async () => {
  const notDone = fake(({ messages }) => { messages.push(yielded({ done: false, summary: 'blocked on X' })); });
  const first = harness(async () => ({ session: notDone.session, file: join(root, 's.jsonl') }));
  const w = worker('bd-1', ['a/**']);
  await first.runner.launch(mission([w]), w);
  await first.runner.whenDone('bd-1');
  expect(first.settled[0]![1]).toMatchObject({ ok: false, error: expect.stringContaining('blocked on X') });

  bdCalls = [];
  bdFail = args => args[0] === 'close';
  const clean = fake(({ messages }) => { messages.push(yielded({ done: true, summary: 'ok' })); });
  const second = harness(async () => ({ session: clean.session, file: join(root, 's2.jsonl') }));
  const w2 = worker('bd-2', ['a/**']);
  await second.runner.launch(mission([w2]), w2);
  await second.runner.whenDone('bd-2');
  expect(second.settled[0]![1]).toMatchObject({ ok: false, error: expect.stringMatching(/bd close failed: boom/) });
});

test('a failed claim starts no session, and a session that cannot start gives the claim back', async () => {
  let created = 0;
  const factory: SessionFactory = async () => { created++; throw new Error('no model'); };
  const { runner } = harness(factory);
  const w = worker('bd-1', ['a/**']);
  bdFail = args => args[0] === 'update';
  await expect(runner.launch(mission([w]), w)).rejects.toThrow(/claim failed for bd-1: boom/);
  expect(created).toBe(0);
  bdFail = () => false;
  bdCalls = [];
  await expect(runner.launch(mission([w]), w)).rejects.toThrow(/no model/);
  expect(bdCalls.map(call => call.args.slice(0, 3))).toEqual([['update', 'bd-1', '--claim'], ['unclaim', 'bd-1', '--if-assignee']]);
});

test('shutdown keeps the claim, and the session resumes from its transcript with the baseline it started from', async () => {
  const file = join(root, 'sessions', 'bd-1.jsonl');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{}');
  const requests: Array<string | undefined> = [];
  const sessions: Fake[] = [
    fake(async ({ cwd }) => { await writeFile(join(cwd, 'a', 'one.txt'), 'half done'); }, true),
    fake(async ({ cwd, messages }) => { await writeFile(join(cwd, 'a', 'one.txt'), 'finished'); messages.push(yielded({ done: true, summary: 'resumed ok' })); }),
  ];
  let next = 0;
  const { runner, settled } = harness(async request => { requests.push(request.resumeFile); return { session: sessions[next++]!.session, file }; });
  const w = worker('bd-1', ['a/**']);
  await runner.launch(mission([w]), w);
  await sessions[0]!.prompted;
  await runner.abortAll();
  expect(settled).toEqual([]);
  expect(bdCalls.some(call => call.args[0] === 'unclaim' || call.args[0] === 'close')).toBe(false);
  expect(runner.isLive('bd-1')).toBe(false);

  w.incarnationId = file;
  expect(await runner.resume(mission([w]), w, 'custom note')).toBe(true);
  await runner.whenDone('bd-1');
  expect(requests).toEqual([undefined, file]);
  expect(sessions[1]!.prompts[0]).toBe('custom note');
  expect(settled[0]![1]).toEqual({ ok: true, summary: 'resumed ok' });
});

test('resume reports false when the transcript is gone, so the caller can release the claim', async () => {
  const { runner } = harness(async () => { throw new Error('unreachable'); });
  const w = worker('bd-1', ['a/**']);
  w.incarnationId = join(root, 'missing.jsonl');
  expect(await runner.resume(mission([w]), w)).toBe(false);
  await runner.release(mission([w]), w);
  expect(bdCalls.at(-1)!.args).toEqual(['unclaim', 'bd-1', '--if-assignee', 'bd-1', '--json']);
});

test('concurrent workers may edit their own scopes, but nothing outside every scope', async () => {
  const a = worker('bd-a', ['a/**']);
  const b = worker('bd-b', ['b/**']);
  const m = mission([a, b]);
  const fa = fake(async ({ cwd }) => { await writeFile(join(cwd, 'a', 'one.txt'), 'A'); }, true);
  const fb = fake(async ({ cwd, messages }) => { await writeFile(join(cwd, 'b', 'two.txt'), 'B'); await fa.prompted; messages.push(yielded({ done: true, summary: 'b done' })); });
  const sessions = [fa, fb];
  let n = 0;
  const { runner, settled } = harness(async () => ({ session: sessions[n++]!.session, file: join(root, `s${n}.jsonl`) }));
  await runner.launch(m, a);
  await runner.launch(m, b);
  await runner.whenDone('bd-b');
  expect(settled.find(([id]) => id === 'bd-b')![1].ok).toBe(true);
  (fa.session.state.messages as unknown[]).push(yielded({ done: true, summary: 'a done' }));
  fa.release();
  await runner.whenDone('bd-a');
  expect(settled.find(([id]) => id === 'bd-a')![1].ok).toBe(true);
});

test('steering reaches only a live worker', async () => {
  const f = fake(() => {}, true);
  const { runner } = harness(async () => ({ session: f.session, file: join(root, 's.jsonl') }));
  const w = worker('bd-1', ['a/**']);
  await runner.launch(mission([w]), w);
  await runner.steer('bd-1', 'look at X');
  expect(f.prompts).toContain('steer:look at X');
  await runner.abortAll();
  await expect(runner.steer('bd-1', 'again')).rejects.toThrow(/no live subagent/);
});

test('git snapshots see content changes to already dirty files and deletions; yields parse only successful results', async () => {
  await writeFile(join(cwd, 'a', 'one.txt'), 'v1');
  const before = await snapshotChanges(real, cwd);
  await writeFile(join(cwd, 'a', 'one.txt'), 'v2');
  await rm(join(cwd, 'b', 'two.txt'));
  await writeFile(join(cwd, 'new file.txt'), 'n');
  expect(changedSince(before, await snapshotChanges(real, cwd))).toEqual(['a/one.txt', 'b/two.txt', 'new file.txt']);
  expect(extractYield([{ role: 'toolResult', toolName: 'yield', details: { status: 'aborted', data: { done: true, summary: 's' } } }])).toBeUndefined();
  expect(extractYield([yielded({ done: 'yes', summary: 's' })])).toBeUndefined();
  expect(extractYield([yielded({ done: true, summary: 's', verification: 'v' })])).toEqual({ done: true, summary: 's', verification: 'v' });
});

test('a resumed worker is not blamed for sibling beads\' edits made while it was stopped, but still for paths nobody owns', async () => {
  const file = join(root, 'sessions', 'bd-a.jsonl');
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, '{}');
  const a = worker('bd-a', ['a/**']);
  const sibling = worker('bd-b', ['b/**']);
  const m = mission([a, sibling]);
  const first = fake(() => {}, true);
  const second = fake(async ({ cwd, messages }) => {
    await writeFile(join(cwd, 'a', 'one.txt'), 'A');
    await writeFile(join(cwd, 'b', 'two.txt'), 'sibling edit while A was down');
    await writeFile(join(cwd, 'nobody.txt'), 'stray');
    messages.push(yielded({ done: true, summary: 'a' }));
  });
  const sessions = [first, second];
  let n = 0;
  const { runner, settled } = harness(async () => ({ session: sessions[n++]!.session, file }));
  await runner.launch(m, a);
  await first.prompted;
  await runner.abortAll();
  a.incarnationId = file;
  await runner.resume(m, a);
  await runner.whenDone('bd-a');
  expect(settled[0]![1]).toMatchObject({ ok: false, error: expect.stringMatching(/outside the allowed paths \(nobody\.txt\)/) });
});
