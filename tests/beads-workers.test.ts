import { describe, expect, test } from 'bun:test';
import { readGraph, readHistory, readClaimActor } from '../src/beads.ts';
import { assertNonOverlapping, createWorkerDriver, validateTerminal } from '../src/workers.ts';
import type { Bead, Mission, Run, Terminal, Worker } from '../src/types.ts';

function result(value: unknown, code = 0, stderr = '') { return { stdout: JSON.stringify(value), stderr, code }; }
function treeRun(tree: Map<string, Record<string, unknown>[]>, ready: unknown[] = []): Run {
  return async (_command, args) => {
    if (args[1] === 'show') return result([{id:args[2],issue_type:'epic',status:'open'}]);
    if (args[1] === 'list') return result({ issues: tree.get(args[args.indexOf('--parent') + 1]!) ?? [], truncated: false });
    if (args[1] === 'ready') return result({ issues: ready, truncated: false });
    if (args[1] === 'history') return result({ events: [{ timestamp: '2026-01-01', actor: 'bead-x', event: 'claimed', summary: 'claim' }] });
    throw new Error(`unexpected bd args: ${args.join(' ')}`);
  };
}

function mission(): Mission {
  return {
    version: 1, id: 'mission-x', source: { kind: 'freeform', id: 'x', title: 'x', body: '', comments: '', extra: '' },
    workspace: { key: 'x', cwd: '/tmp/work', beadsDir: '/tmp/beads', delivery: 'local' }, scopes: {}, phase: 'execute',
    evidence: {}, mode: 'auto', keep: false, reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 0,
    createdAt: '', updatedAt: '',
  };
}

function bead(id: string, category: Bead['category'], claimActor?: string): Bead {
  return { id, title: id, status: category, children: [], ready: category === 'ready', category, claimActor };
}

describe('scoped graph and history reads', () => {
  test('traverses more than fifty nested descendants and scopes readiness', async () => {
    const tree = new Map<string, Record<string, unknown>[]>();
    for (let i = 0; i < 67; i++) tree.set(i === 0 ? 'epic' : `b${i - 1}`, [{ id: `b${i}`, title: `bead ${i}`, status: 'open', type: 'task' }]);
    const snapshot = await readGraph(treeRun(tree, [{ id: 'b66' }]), '/tmp/work', 'epic');
    expect(snapshot.beads).toHaveLength(67);
    expect(snapshot.leaves.map(bead=>bead.id)).toEqual(['b66']);
    expect(snapshot.ready).toEqual(['b66']);
  });

  test('rejects duplicate-parent cycles rather than returning partial graph', async () => {
    const tree = new Map<string, Record<string, unknown>[]>([
      ['epic', [{ id: 'child', title: 'child', status: 'open', parent_id: 'epic' }]],
      ['child', [{ id: 'epic', title: 'epic', status: 'open', parent_id: 'child' }]],
    ]);
    await expect(readGraph(treeRun(tree), '/tmp/work', 'epic')).rejects.toThrow(/cycle/);
  });
  test('holds on a truncated descendant read', async () => {
    const run: Run = async (_command, args) => args[1] === 'show'
      ? result([{id:'epic',issue_type:'epic',status:'open'}])
      : args[1] === 'list'
        ? result({ issues: [{ id: 'b1', title: 'one', status: 'open' }], truncated: true })
        : result({ issues: [] });
    await expect(readGraph(run, '/tmp/work', 'epic')).rejects.toThrow(/truncated/);
  });

  test('retains last good graph with visible read failure and rejects missing prior state', async () => {
    const run: Run = async () => ({ stdout: '', stderr: 'database unavailable', code: 2 });
    const previous = { beads: [], leaves: [], ready: [], closed: 0, active: 0, blocked: 0, fetchedAt: 1 };
    const stale = await readGraph(run, '/tmp/work', 'epic', undefined, previous);
    expect(stale.error).toContain('database unavailable');
    expect(stale.fetchedAt).toBe(1);
    await expect(readGraph(run, '/tmp/work', 'epic')).rejects.toThrow(/database unavailable/);
  });

  test('reads recent history and extracts actual claim actor', async () => {
    const events = [{ created_at: '2', actor: 'worker-x', event_type: 'claimed', new_value: '{"assignee":"worker-x","status":"in_progress"}' }, { created_at: '1', actor: 'user', event_type: 'created', new_value: '' }];
    const run: Run = async () => result({ events });
    expect(await readHistory(run, '/tmp/work', 'bead-x')).toHaveLength(2);
    expect(await readClaimActor(run, '/tmp/work', 'bead-x')).toBe('worker-x');
  });
});

describe('worker safety boundaries', () => {
  test('rejects overlapping file and directory scopes', () => {
    expect(() => assertNonOverlapping([
      { beadId: 'a', cwd: '/tmp/work', files: ['src'], assignment: '' },
      { beadId: 'b', cwd: '/tmp/work', files: ['src/module.ts'], assignment: '' },
    ])).toThrow(/overlap/);
    expect(() => assertNonOverlapping([
      { beadId: 'a', cwd: '/tmp/work', files: ['src/a.ts'], assignment: '' },
      { beadId: 'b', cwd: '/tmp/work', files: ['src/b.ts'], assignment: '' },
    ])).not.toThrow();
    expect(() => assertNonOverlapping([
      { beadId: 'a', cwd: '/tmp/work', files: ['../outside'], assignment: '' },
      { beadId: 'b', cwd: '/tmp/work', files: ['safe.ts'], assignment: '' },
    ])).toThrow(/invalid worker file scope/);
  });

  test('claim from another actor never marks worker running', async () => {
    const current = mission();
    current.workers.push({ beadId: 'bead-x', attempt: 'attempt', cwd: '/tmp/work', files: ['a'], state: 'awaiting-claim', handle: 'term-x', incarnationId: 'inc-x', assignment: 'task' });
    const persisted: Mission[] = [];
    const driver = createWorkerDriver(async () => result({ terminals: [{ handle: 'term-x', incarnationId: 'inc-x', worktreePath: '/tmp/work', writable: true, connected: true }], truncated: false }), { persist: async state => { persisted.push(structuredClone(state)); } });
    await driver.reconcile(current, new Map([['bead-x', bead('bead-x', 'active', 'someone-else')]]));
    expect(current.workers[0]!.state).toBe('awaiting-claim');
    expect(current.workers[0]!.error).toContain('someone-else');
  });

  test('persists reservation with assignment, refreshes prompt after terminal identity, sends with Enter', async () => {
    const current = mission();
    const calls: { command: string; args: string[] }[] = [];
    const run: Run = async (command, args) => {
      calls.push({ command, args });
      if (args[1] === 'create') return result({ ok: true, result: { terminal: { handle: 'term-x', incarnationId: 'inc-x' } } });
      if (args[1] === 'list') return result({ ok: true, result: { terminals: [{ handle: 'term-x', incarnationId: 'inc-x', worktreePath: '/tmp/work', writable: true, connected: true }], truncated: false } });
      if (args[1] === 'wait') return result({ ok: true, result: { wait: { satisfied: true } } });
      if (args[1] === 'send') return result({ ok: true, result: {} });
      throw new Error(`unexpected Orca args: ${args.join(' ')}`);
    };
    const saved: Mission[] = [];
    const driver = createWorkerDriver(run, {
      persist: async state => { saved.push(structuredClone(state)); },
      prompt: (_state, worker) => `worker prompt for ${worker.handle ?? 'pending-terminal'}`,
    });
    const workers = await driver.dispatch(current, [{ beadId: 'bead-x', cwd: '/tmp/work', files: ['a'] }]);
    expect(saved[0]!.workers[0]!.assignment).toBe('worker prompt for pending-terminal');
    expect(saved[0]!.workers[0]!.state).toBe('reserved');
    expect(saved.some(state => state.workers[0]!.handle === 'term-x' && state.workers[0]!.incarnationId === 'inc-x')).toBe(true);
    expect(saved.some(state => state.workers[0]!.assignment === 'worker prompt for term-x')).toBe(true);
    expect(calls.find(call => call.args[1] === 'send')!.args).toContain('worker prompt for term-x');
    const create = calls.find(call => call.args[1] === 'create')!;
    expect(create.args[create.args.indexOf('--command') + 1]).toContain("BEADS_ACTOR='bead-x'");
    expect(create.args[create.args.indexOf('--command') + 1]).toContain("BEADS_DIR='/tmp/beads'");
    expect(calls.find(call => call.args[1] === 'send')!.args).toContain('--enter');
    expect(workers[0]!.state).toBe('awaiting-claim');
  });

  test('refuses wrong terminal incarnation and truncated topology', async () => {
    const worker: Worker = { beadId: 'bead-x', attempt: 'a', cwd: '/tmp/work', files: [], state: 'running', handle: 'term-x', incarnationId: 'inc-x', assignment: 'task' };
    const otherIncarnation: Terminal[] = [{ handle: 'term-x', incarnationId: 'inc-other', worktreePath: '/tmp/work', writable: true, connected: true }];
    expect(validateTerminal(worker, otherIncarnation)).toBeUndefined();
    const current = mission(); current.workers.push(worker);
    const changedTerminal = createWorkerDriver(async () => result({ terminals: otherIncarnation, truncated: false }), { persist: async () => {} });
    await changedTerminal.reconcile(current, new Map([['bead-x', bead('bead-x', 'active', 'bead-x')]]));
    expect(current.workers[0]!.state).toBe('missing');
    expect(current.workers[0]!.error).toContain('changed identity');
    const truncated = createWorkerDriver(async () => result({ terminals: [], truncated: true }), { persist: async () => {} });
    await expect(truncated.reconcile(current, new Map([['bead-x', bead('bead-x', 'active', 'bead-x')]]))).rejects.toThrow(/truncated/);
  });

  test('reservation without identity is held and never respawned', async () => {
    const current = mission();
    current.workers.push({ beadId: 'bead-x', attempt: 'a', cwd: '/tmp/work', files: ['a'], state: 'reserved', assignment: '' });
    let createCalls = 0;
    const driver = createWorkerDriver(async (_command, args) => { if (args[1] === 'create') createCalls++; return result({}); }, { persist: async () => {} });
    await expect(driver.dispatch(current, [{ beadId: 'bead-x', cwd: '/tmp/work', files: ['a'], assignment: 'duplicate' }])).rejects.toThrow(/already reserved/);
    expect(createCalls).toBe(0);
    await driver.reconcile(current, new Map([['bead-x', bead('bead-x', 'active', 'bead-x')]]));
    expect(current.workers[0]!.error).toContain('no persisted terminal identity');
  });
});
