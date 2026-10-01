import { expect, test } from 'bun:test';
import { CLAIM_STALL_MS, nextAction } from '../src/controller';
import { briefView, statusView } from '../src/status';
import { createWorkerDriver } from '../src/workers';
import type { Bead, Mission, PolicyContext, Snapshot, Worker } from '../src/types';

const policy: PolicyContext = { resumeHold: false, owned: true, nativePlan: false, fresh: true, maxWorkers: 2 };
const bead = (id: string, category: Bead['category'], extra: Partial<Bead> = {}): Bead => ({ id, title: id, status: category, children: [], ready: category === 'ready', category, ...extra });
const snapshot = (beads: Bead[]): Snapshot => ({ beads, leaves: beads, ready: beads.filter(b => b.ready).map(b => b.id), closed: 0, active: 0, blocked: 0, fetchedAt: Date.now() });
const worker = (extra: Partial<Worker> = {}): Worker => ({ beadId: 'a', attempt: 'att', cwd: '/tmp', files: ['a.ts'], state: 'awaiting-claim', handle: 'term_x', incarnationId: 'inc', assignment: 'do', launchedAt: new Date().toISOString(), ...extra });
const mission = (workers: Worker[]): Mission => ({ version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'm', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd: '/tmp', delivery: 'local', beadsDir: '/tmp/beads' }, epicId: 'epic', graph: 'beads', scopes: { a: ['a.ts'] }, phase: 'execute', evidence: {}, mode: 'auto', keep: false, reviewRequested: false, workers, reviews: [], repairLinks: {}, round: 1, createdAt: 'now', updatedAt: 'now' });

test('unclaimed live worker becomes resend only after the claim stall window', () => {
  const fresh = mission([worker()]);
  expect(nextAction(fresh, snapshot([bead('a', 'ready')]), policy).detail).toBe('Workers running');
  const old = mission([worker({ launchedAt: new Date(Date.now() - CLAIM_STALL_MS - 1000).toISOString() })]);
  const action = nextAction(old, snapshot([bead('a', 'ready')]), policy);
  expect(action.kind).toBe('resend');
  expect(action.ids).toEqual(['a']);
  expect(nextAction(old, snapshot([bead('a', 'active', { claimActor: 'a' })]), policy).kind).not.toBe('resend');
});

test('recover replaces only a missing worker on an unclaimed bead and redispatch ignores the replaced record', async () => {
  const m = mission([worker({ state: 'missing', error: 'gone' })]);
  const driver = createWorkerDriver(async () => { throw new Error('no external command expected'); }, { persist: async () => {} });
  await expect(driver.recover(m, 'a', bead('a', 'ready', { assignee: 'someone' }))).rejects.toThrow(/unclaimed/);
  await expect(driver.recover(mission([worker()]), 'a', bead('a', 'ready'))).rejects.toThrow(/terminal is gone/);
  await driver.recover(m, 'a', bead('a', 'ready'));
  expect(m.workers[0]!.state).toBe('closed');
  expect(m.workers[0]!.error).toMatch(/^replaced:/);
  const action = nextAction(m, snapshot([bead('a', 'ready')]), policy);
  expect(action.kind).toBe('dispatch');
  expect(action.ids).toEqual(['a']);
  // a replaced record must not flip back to missing on later reconciliation
  await driver.reconcile(m, new Map([['a', bead('a', 'ready')]]));
  expect(m.workers[0]!.state).toBe('closed');
});

test('status and control views drop source text, assignments, descriptions and bookkeeping but keep decision state', () => {
  const m = mission([worker({ assignment: 'x'.repeat(30_000) }), worker({ beadId: 'old', state: 'closed' })]);
  m.source.body = 'y'.repeat(30_000);
  m.controllerNonce = 'nonce-secret';
  const snap = snapshot([bead('a', 'ready', { description: 'z'.repeat(5000) }), bead('b', 'closed')]);
  const input = { mission: m, snapshot: snap, resumeHold: false, next: { kind: 'dispatch' as const, detail: 'Start workers: a', ids: ['a'] } };
  const status = JSON.stringify(statusView(input));
  const brief = JSON.stringify(briefView(input));
  expect(status.length).toBeLessThan(1500);
  expect(brief.length).toBeLessThan(700);
  for (const text of [status, brief]) {
    expect(text).not.toContain('nonce-secret');
    expect(text).not.toContain('xxxx');
    expect(text).not.toContain('zzzz');
    expect(text).not.toContain('yyyy');
  }
  expect(JSON.parse(brief)).toMatchObject({ phase: 'execute', next: { kind: 'dispatch', ids: ['a'] }, workers: [{ beadId: 'a', state: 'awaiting-claim', handle: 'term_x' }], outstanding: ['a:ready'] });
  expect(brief).not.toContain('old');
  expect(JSON.parse(status).beads).toEqual(['a ready a', 'b closed b']);
});

test('a pending mission is described by id only until it starts', () => {
  expect(briefView({ pending: mission([]), resumeHold: true })).toEqual({ pending: 'm', next: undefined });
});
