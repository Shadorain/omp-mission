import { expect, test } from 'bun:test';
import { createWorkerDriver, type SubagentPort } from '../src/workers';
import type { Bead, Mission, Run, Worker } from '../src/types';

const run: Run = async () => { throw new Error('no external command expected'); };
const bead = (category: Bead['category'], claimActor?: string): Bead => ({ id: 'bd-1', title: 't', status: category, children: [], ready: category === 'ready', category, claimActor });
const worker = (extra: Partial<Worker> = {}): Worker => ({ beadId: 'bd-1', attempt: 'a', cwd: '/w', files: ['a/**'], state: 'running', assignment: 'x', frontend: 'subagent', handle: 'bd-1', incarnationId: '/s/bd-1.jsonl', ...extra });
const mission = (w: Worker): Mission => ({ version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'm', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd: '/w', beadsDir: '/b', delivery: 'local' }, scopes: {}, phase: 'execute', evidence: {}, mode: 'auto', keep: false, reviewRequested: false, workers: [w], reviews: [], repairLinks: {}, round: 1, createdAt: '', updatedAt: '' });

function port(options: { live?: boolean; canResume?: boolean } = {}) {
  const calls: string[] = [];
  const subagent: SubagentPort = {
    async launch() { calls.push('launch'); return { handle: 'bd-1', incarnationId: '/s/bd-1.jsonl' }; },
    isLive: () => options.live ?? false,
    async steer(_id, text) { calls.push(`steer:${text.slice(0, 20)}`); },
    async resume(_m, _w, note) { calls.push(`resume:${note ?? ''}`); return options.canResume ?? false; },
    async release() { calls.push('release'); },
    async abort() { calls.push('abort'); },
  };
  const driver = createWorkerDriver(run, { persist: async () => {}, subagent, frontend: 'subagent' });
  return { driver, calls };
}

test('after a restart a claimed bead with a saved transcript resumes instead of going missing', async () => {
  const w = worker();
  const { driver, calls } = port({ canResume: true });
  await driver.reconcile(mission(w), new Map([['bd-1', bead('active', 'bd-1')]]));
  expect(calls).toEqual(['resume:']);
  expect(w.state).toBe('running');
  expect(w.error).toBeUndefined();
});

test('without a transcript the claim is released and the worker is marked missing so it can be replaced', async () => {
  const w = worker();
  const { driver, calls } = port({ canResume: false });
  await driver.reconcile(mission(w), new Map([['bd-1', bead('active', 'bd-1')]]));
  expect(calls).toEqual(['resume:', 'release']);
  expect(w.state).toBe('missing');
});

test('a worker whose result was rejected keeps its reason and is not resumed behind the operator\'s back', async () => {
  const w = worker({ error: 'edits outside the allowed paths (x)' });
  const { driver, calls } = port({ canResume: true });
  await driver.reconcile(mission(w), new Map([['bd-1', bead('active', 'bd-1')]]));
  expect(calls).toEqual([]);
  expect(w.error).toBe('edits outside the allowed paths (x)');
  expect(w.state).toBe('running');
});

test('a live session is left alone, and a closed bead closes its worker', async () => {
  const w = worker();
  const { driver, calls } = port({ live: true });
  await driver.reconcile(mission(w), new Map([['bd-1', bead('active', 'bd-1')]]));
  expect(calls).toEqual([]);
  await driver.reconcile(mission(w), new Map([['bd-1', bead('closed', 'bd-1')]]));
  expect(w.state).toBe('closed');
});

test('resend steers a live session, and reopens a rejected one with the rejection as the prompt', async () => {
  const live = worker();
  const first = port({ live: true });
  await first.driver.resend(mission(live), 'bd-1', bead('active', 'bd-1'));
  expect(first.calls).toEqual(['steer:Your full assignment']);

  const rejected = worker({ error: 'edits outside the allowed paths (x)' });
  const second = port({ canResume: true });
  await second.driver.resend(mission(rejected), 'bd-1', bead('active', 'bd-1'));
  expect(second.calls).toEqual(['resume:Your last result was rejected: edits outside the allowed paths (x). Finish by calling yield.']);
  expect(rejected.error).toBeUndefined();
  expect(rejected.state).toBe('running');

  const gone = port({ canResume: false });
  await expect(gone.driver.resend(mission(worker()), 'bd-1', bead('active', 'bd-1'))).rejects.toThrow(/no saved session/);
  await expect(second.driver.resend(mission(worker()), 'bd-1', bead('active', 'someone-else'))).rejects.toThrow(/own active bead/);
});

test('reap aborts the session and focus points at the Agent Hub instead of a tab', async () => {
  const w = worker();
  const { driver, calls } = port({ live: true });
  await driver.reap(mission(w), 'bd-1', bead('closed', 'bd-1'));
  expect(calls).toEqual(['abort']);
  expect(w.state).toBe('closed');
  await expect(driver.focus(worker())).rejects.toThrow(/Alt\+A/);
});

test('a stopped subagent worker becomes a resend action naming the reason, while other frontends still hold', async () => {
  const { nextAction } = await import('../src/controller');
  const snapshot = (ready = false): import('../src/types').Snapshot => { const beads = [bead('active', 'bd-1'), ...(ready ? [{ ...bead('ready'), id: 'bd-2' }] : [])]; return { beads, leaves: beads, ready: ready ? ['bd-2'] : [], closed: 0, active: 1, blocked: 0, fetchedAt: Date.now() }; };
  const policy = { owned: true, resumeHold: false, nativePlan: false, fresh: true, maxWorkers: 2 } as never;
  const stopped = worker({ error: 'worker reported it is not done: blocked on X' });
  const m = mission(stopped);
  m.scopes = { 'bd-1': ['a/**'], 'bd-2': ['b/**'] };
  m.epicId = 'epic';
  const action = nextAction(m, snapshot(), policy);
  expect(action.kind).toBe('resend');
  expect(action.ids).toEqual(['bd-1']);
  expect(action.detail).toContain('blocked on X');
  // Other ready beads keep flowing while the stopped worker waits.
  expect(nextAction(m, snapshot(true), policy)).toMatchObject({ kind: 'dispatch', ids: ['bd-2'] });
  m.mode = 'pause';
  expect(nextAction(m, snapshot(true), policy)).toMatchObject({ kind: 'resend' });
  m.mode = 'auto';

  const orca = mission(worker({ error: 'x', frontend: 'orca' }));
  orca.scopes = m.scopes;
  orca.epicId = 'epic';
  expect(nextAction(orca, snapshot(), policy)).toMatchObject({ kind: 'hold' });
});

test('resend with guidance continues the stopped session with the rejection and the guidance together', async () => {
  const w = worker({ error: 'edits outside the allowed paths (docs.txt)' });
  const { driver, calls } = port({ canResume: true });
  await driver.resend(mission(w), 'bd-1', bead('active', 'bd-1'), 'Leave docs.txt alone.');
  expect(calls).toEqual(['resume:Your last result was rejected: edits outside the allowed paths (docs.txt). Leave docs.txt alone. Finish by calling yield.']);

  const live = port({ live: true });
  await live.driver.resend(mission(worker()), 'bd-1', bead('active', 'bd-1'), 'Use the v2 helper.');
  expect(live.calls).toEqual(['steer:Use the v2 helper.']);
});

test('release gives the bead back: aborts, unclaims, and closes the worker record so a fresh one can start', async () => {
  const w = worker({ error: 'worker reported it is not done: blocked' });
  const { driver, calls } = port();
  await driver.release(mission(w), 'bd-1', bead('active', 'bd-1'));
  expect(calls).toEqual(['abort', 'release']);
  expect(w.state).toBe('closed');
  expect(w.error).toBe('released: worker reported it is not done: blocked');
  await expect(driver.release(mission(worker()), 'bd-1', bead('active', 'someone-else'))).rejects.toThrow(/still claimed by its own worker/);
  await expect(driver.release(mission(worker({ frontend: 'orca' })), 'bd-1', bead('active', 'bd-1'))).rejects.toThrow(/subagent worker/);
});

test('a session that may not mutate the mission never reopens or releases a worker', async () => {
  const w = worker();
  const calls: string[] = [];
  const subagent: SubagentPort = {
    async launch() { return { handle: 'bd-1', incarnationId: '/s/bd-1.jsonl' }; },
    isLive: () => false,
    async steer() {},
    async resume() { calls.push('resume'); return true; },
    async release() { calls.push('release'); },
    async abort() {},
  };
  let allowed = false;
  const driver = createWorkerDriver(run, { persist: async () => {}, subagent, frontend: 'subagent', canMutate: () => allowed });
  await driver.reconcile(mission(w), new Map([['bd-1', bead('active', 'bd-1')]]));
  expect(calls).toEqual([]);
  expect(w.state).toBe('running');
  allowed = true;
  await driver.reconcile(mission(w), new Map([['bd-1', bead('active', 'bd-1')]]));
  expect(calls).toEqual(['resume']);
});
