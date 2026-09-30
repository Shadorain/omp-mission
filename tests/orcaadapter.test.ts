import { describe, expect, test } from 'bun:test';
import { assertNonOverlapping, createWorkerDriver, validateTerminal } from '../src/workers.ts';
import type { Bead, Mission, Run, Terminal, Worker } from '../src/types.ts';

// Real envelopes captured from `orca` CLI on this host (runtimeId elided).
// create:  orca terminal create --worktree path:<wt> --command <sh> --title t --json
// list:    orca terminal list --json
// wait:    orca terminal wait --terminal <h> --for tui-idle --timeout-ms N --json
// send:    orca terminal send --terminal <h> --text <t> --enter --json
// close:   orca terminal close --terminal <h> --tab --json
// switch:  orca terminal switch --terminal <h> --json

const WT = '/tmp/mission-wt';
const HANDLE = 'term_11111111-1111-4111-8111-111111111111';
const INC = 'aaaaaaaa-1111-4111-8111-111111111111';

const CREATE_ENVELOPE = {
  id: 'req-1', ok: true,
  result: {
    terminal: {
      handle: HANDLE, tabId: 'tab-1', paneKey: 'tab-1:leaf-1',
      ptyId: 'repo::/tmp/mission-wt@@abc', worktreeId: 'repo::/tmp/mission-wt',
      title: 'mission-bead-1', executionHostId: 'local', incarnationId: INC,
      hostPlatform: 'linux', surface: 'background',
      warning: 'Terminal is running, but Orca could not make it discoverable.',
    },
  },
  _meta: { runtimeId: 'rt' },
};

function liveTerminal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    handle: HANDLE, ptyId: 'repo::/tmp/mission-wt@@abc', incarnationId: INC,
    orphaned: false, worktreeId: 'repo::/tmp/mission-wt', worktreePath: WT,
    branch: '', tabId: 'tab-1', leafId: 'leaf-1', title: 'mission-bead-1',
    connected: true, writable: true, lastOutputAt: 1, preview: '',
    executionHostId: 'local', ...overrides,
  };
}

function listEnvelope(terminals: Record<string, unknown>[], truncated = false) {
  return {
    id: 'req-2', ok: true,
    result: {
      terminals,
      hostScope: { hostIds: ['local'], omittedHostIds: [] },
      topologyRevisions: {}, totalCount: terminals.length, truncated,
    },
    _meta: { runtimeId: 'rt' },
  };
}

const WAIT_SATISFIED = {
  id: 'req-3', ok: true,
  result: { wait: { handle: HANDLE, condition: 'tui-idle', satisfied: true, status: 'running', exitCode: null } },
  _meta: { runtimeId: 'rt' },
};

const WAIT_UNSATISFIED_OK = {
  id: 'req-3', ok: true,
  result: { wait: { handle: HANDLE, condition: 'tui-idle', satisfied: false, status: 'running', exitCode: null } },
  _meta: { runtimeId: 'rt' },
};

const SEND_ACCEPTED = {
  id: 'req-4', ok: true,
  result: {
    send: {
      handle: HANDLE, accepted: true, bytesWritten: 8,
      prompt: { requestId: 'r', stages: ['input_accepted'], provider: 'omp', observation: 'observed', processIncarnation: INC, generation: 1, baselineWorkingSequence: 0 },
    },
    mutation: { requestId: 'r', replayed: false },
    warnings: [],
  },
  _meta: { runtimeId: 'rt' },
};

const SEND_REJECTED = {
  id: 'req-4', ok: true,
  result: {
    send: {
      handle: HANDLE, accepted: false, bytesWritten: 0,
      prompt: { requestId: 'r', stages: [], provider: 'omp', observation: 'rejected', processIncarnation: INC, generation: 1, baselineWorkingSequence: 0 },
    },
    mutation: { requestId: 'r', replayed: false },
    warnings: ['input rejected'],
  },
  _meta: { runtimeId: 'rt' },
};

const CLOSE_TAB = {
  id: 'req-5', ok: true,
  result: { close: { handle: HANDLE, tabId: 'tab-1', closeMode: 'tab', ptyKilled: false } },
  _meta: { runtimeId: 'rt' },
};

const SWITCH_OK = {
  id: 'req-6', ok: true,
  result: { focus: { handle: HANDLE, tabId: 'tab-1', worktreeId: 'repo::/tmp/mission-wt', navigated: false } },
  _meta: { runtimeId: 'rt' },
};

function pack(value: unknown, code = 0, stderr = '') {
  return { stdout: JSON.stringify(value), stderr, code };
}

interface RecordedCall { args: string[] }

function mission(overrides: Partial<Mission> = {}): Mission {
  return {
    version: 1, id: 'mission-x',
    source: { kind: 'freeform', id: 'x', title: 'x', body: '', comments: '', extra: '' },
    workspace: { key: 'x', cwd: WT, beadsDir: '/tmp/beads', delivery: 'local' },
    scopes: {}, phase: 'execute', evidence: {}, mode: 'auto', keep: false,
    reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 0,
    createdAt: '', updatedAt: '', ...overrides,
  };
}

function bead(id: string, category: Bead['category'], claimActor?: string): Bead {
  return { id, title: id, status: category, children: [], ready: category === 'ready', category, claimActor };
}

function worker(overrides: Partial<Worker> = {}): Worker {
  return {
    beadId: 'bead-1', attempt: 'att-1', cwd: WT, files: ['a.txt'],
    state: 'awaiting-claim', assignment: 'do the thing',
    handle: HANDLE, incarnationId: INC, ...overrides,
  };
}

// Routes orca subcommands to queued/static responses and records every call.
function router(handlers: Record<string, unknown | ((args: string[], call: number) => unknown | { stdout: string; stderr: string; code: number })>) {
  const calls: RecordedCall[] = [];
  const counts = new Map<string, number>();
  const run: Run = async (_command, args) => {
    calls.push({ args });
    const key = args[1]!;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    const handler = handlers[key];
    if (handler === undefined) throw new Error(`unexpected orca terminal ${key}: ${args.join(' ')}`);
    const value = typeof handler === 'function' ? handler(args, n) : handler;
    if (value && typeof value === 'object' && 'code' in (value as Record<string, unknown>)) return value as { stdout: string; stderr: string; code: number };
    return pack(value);
  };
  return { run, calls, counts };
}

function subCalls(calls: RecordedCall[], sub: string) {
  return calls.filter(c => c.args[1] === sub);
}

describe('worker driver against real Orca envelopes', () => {
  test('parses create envelope, persists handle+incarnation, sends with --enter never --submit', async () => {
    const { run, calls } = router({
      create: CREATE_ENVELOPE,
      wait: WAIT_SATISFIED,
      list: listEnvelope([liveTerminal()]),
      send: SEND_ACCEPTED,
    });
    const persisted: Mission[] = [];
    const driver = createWorkerDriver(run, { persist: async m => { persisted.push(structuredClone(m)); } });
    const m = mission();
    const workers = await driver.dispatch(m, [{ beadId: 'bead-1', cwd: WT, files: ['a.txt'], assignment: 'do the thing' }]);
    expect(workers[0]!.handle).toBe(HANDLE);
    expect(workers[0]!.incarnationId).toBe(INC);
    expect(workers[0]!.state).toBe('awaiting-claim');
    // handle+incarnation persisted BEFORE send
    const preSend = [...persisted].reverse().find(p => p.workers[0]?.handle === HANDLE);
    expect(preSend).toBeDefined();
    const sendCall = subCalls(calls, 'send')[0]!;
    expect(sendCall.args).toContain('--enter');
    expect(sendCall.args).not.toContain('--submit');
    expect(sendCall.args).toContain('do the thing');
    // reservation persisted before create
    const firstCreate = calls.findIndex(c => c.args[1] === 'create');
    const reservation = persisted[0]!;
    expect(reservation.workers[0]!.state).toBe('reserved');
    expect(firstCreate).toBeGreaterThanOrEqual(0);
  });

  test('reserve persisted before create; failed reservation persist means zero terminals spawned', async () => {
    const { run, calls } = router({ create: CREATE_ENVELOPE });
    const driver = createWorkerDriver(run, { persist: async () => { throw new Error('disk full'); } });
    const m = mission();
    await expect(driver.dispatch(m, [{ beadId: 'bead-1', cwd: WT, files: ['a'], assignment: 'x' }])).rejects.toThrow('disk full');
    expect(subCalls(calls, 'create')).toHaveLength(0);
  });

  test('persist failure after create: catch-block persist rescues identity; if that also fails, retry holds instead of respawning', async () => {
    let persistCalls = 0;
    const { run, calls } = router({ create: CREATE_ENVELOPE });
    const persisted: Mission[] = [];
    const driver = createWorkerDriver(run, {
      persist: async m => {
        persistCalls++;
        // fail the identity persist (3) AND the error persist (4) to simulate the
        // disk dying between terminal create and identity persistence
        if (persistCalls >= 3) throw new Error('fsync failed');
        persisted.push(structuredClone(m));
      },
    });
    const m = mission();
    await expect(driver.dispatch(m, [{ beadId: 'bead-1', cwd: WT, files: ['a'], assignment: 'x' }])).rejects.toThrow();
    expect(subCalls(calls, 'create')).toHaveLength(1);
    // reload from last good snapshot: worker 'starting' without handle
    const m2 = structuredClone(persisted.at(-1)!);
    expect(m2.workers[0]!.handle).toBeUndefined();
    const live = router({ list: listEnvelope([liveTerminal()]) });
    const driver2 = createWorkerDriver(live.run, { persist: async x => { persisted.push(structuredClone(x)); } });
    await driver2.reconcile(m2, new Map([['bead-1', bead('bead-1', 'ready')]]));
    expect(m2.workers[0]!.error).toMatch(/recovery held/);
    // retrying dispatch must NOT spawn a second terminal even though the first is orphaned in Orca
    await expect(driver2.dispatch(m2, [{ beadId: 'bead-1', cwd: WT, files: ['a'], assignment: 'x' }])).rejects.toThrow(/already reserved/);
    expect(subCalls(live.calls, 'create')).toHaveLength(0);
  });

  test('reconcile: wrong incarnationId or wrong worktreePath marks missing; live terminal validates', async () => {
    const m = mission({ workers: [worker()] });
    const live = router({ list: listEnvelope([liveTerminal()]) });
    const driver = createWorkerDriver(live.run, { persist: async () => {} });
    await driver.reconcile(m, new Map([['bead-1', bead('bead-1', 'ready')]]));
    expect(m.workers[0]!.state).toBe('awaiting-claim');

    const wrongInc = router({ list: listEnvelope([liveTerminal({ incarnationId: 'other-inc' })]) });
    const m2 = mission({ workers: [worker()] });
    await createWorkerDriver(wrongInc.run, { persist: async () => {} })
      .reconcile(m2, new Map([['bead-1', bead('bead-1', 'ready')]]));
    expect(m2.workers[0]!.state).toBe('missing');

    const wrongWt = router({ list: listEnvelope([liveTerminal({ worktreePath: '/tmp/other-wt' })]) });
    const m3 = mission({ workers: [worker()] });
    await createWorkerDriver(wrongWt.run, { persist: async () => {} })
      .reconcile(m3, new Map([['bead-1', bead('bead-1', 'ready')]]));
    expect(m3.workers[0]!.state).toBe('missing');
  });

  test('truncated listing blocks reconcile, focus, resend, and reap', async () => {
    const trunc = router({ list: listEnvelope([liveTerminal()], true) });
    const driver = createWorkerDriver(trunc.run, { persist: async () => {} });
    const m = mission({ workers: [worker()] });
    await expect(driver.reconcile(m, new Map([['bead-1', bead('bead-1', 'ready')]]))).rejects.toThrow(/truncated/);
    await expect(driver.focus(worker())).rejects.toThrow(/truncated/);
    await expect(driver.resend(m, 'bead-1', bead('bead-1', 'ready'))).rejects.toThrow(/truncated/);
    await expect(driver.reap(m, 'bead-1', bead('bead-1', 'closed'))).rejects.toThrow(/truncated/);
    expect(subCalls(trunc.calls, 'send')).toHaveLength(0);
    expect(subCalls(trunc.calls, 'close')).toHaveLength(0);
    expect(subCalls(trunc.calls, 'switch')).toHaveLength(0);
  });

  test('resend only fires for awaiting-claim worker with validated terminal and unclaimed bead', async () => {
    const { run, calls } = router({ wait: WAIT_SATISFIED, list: listEnvelope([liveTerminal()]), send: SEND_ACCEPTED });
    const driver = createWorkerDriver(run, { persist: async () => {} });
    const m = mission({ workers: [worker()] });
    await driver.resend(m, 'bead-1', bead('bead-1', 'ready'));
    expect(subCalls(calls, 'send')).toHaveLength(1);
    // claimed bead refuses
    await expect(driver.resend(m, 'bead-1', bead('bead-1', 'ready', 'other'))).rejects.toThrow(/claimed/);
    // running worker refuses
    const m2 = mission({ workers: [worker({ state: 'running' })] });
    await expect(driver.resend(m2, 'bead-1', bead('bead-1', 'ready'))).rejects.toThrow(/awaiting-claim/);
    // wrong bead id refuses
    await expect(driver.resend(m, 'bead-1', bead('bead-9', 'ready'))).rejects.toThrow(/exact/);
    expect(subCalls(calls, 'send')).toHaveLength(1);
  });

  test('reap closes only the exact recorded terminal of the closed bead', async () => {
    const { run, calls } = router({ list: listEnvelope([liveTerminal()]), close: CLOSE_TAB });
    const driver = createWorkerDriver(run, { persist: async () => {} });
    const m = mission({ workers: [worker()] });
    await driver.reap(m, 'bead-1', bead('bead-1', 'closed'));
    const closeArgs = subCalls(calls, 'close')[0]!.args;
    expect(closeArgs).toContain(HANDLE);
    expect(m.workers[0]!.state).toBe('closed');
    // open bead refuses
    const m2 = mission({ workers: [worker()] });
    await expect(driver.reap(m2, 'bead-1', bead('bead-1', 'ready'))).rejects.toThrow(/closed/);
    // keep policy refuses
    const m3 = mission({ keep: true, workers: [worker()] });
    await expect(driver.reap(m3, 'bead-1', bead('bead-1', 'closed'))).rejects.toThrow(/keep/);
    // terminal in different worktree refuses even with same handle
    const other = router({ list: listEnvelope([liveTerminal({ worktreePath: '/elsewhere' })]), close: CLOSE_TAB });
    const driverO = createWorkerDriver(other.run, { persist: async () => {} });
    const m4 = mission({ workers: [worker()] });
    await expect(driverO.reap(m4, 'bead-1', bead('bead-1', 'closed'))).rejects.toThrow(/identity/);
    expect(subCalls(other.calls, 'close')).toHaveLength(0);
  });

  test('focus validates identity then switches', async () => {
    const { run, calls } = router({ list: listEnvelope([liveTerminal()]), switch: SWITCH_OK });
    const driver = createWorkerDriver(run, { persist: async () => {} });
    await driver.focus(worker());
    expect(subCalls(calls, 'switch')).toHaveLength(1);
    const wrong = router({ list: listEnvelope([liveTerminal({ incarnationId: 'nope' })]) });
    await expect(createWorkerDriver(wrong.run, { persist: async () => {} }).focus(worker())).rejects.toThrow(/identity/);
    expect(subCalls(wrong.calls, 'switch')).toHaveLength(0);
  });

  test('assertNonOverlapping catches pathological scopes', () => {
    const pair = (a: string, b: string, cwd = WT) =>
      () => assertNonOverlapping([
        { beadId: 'x', cwd, files: [a] },
        { beadId: 'y', cwd, files: [b] },
      ]);
    expect(pair('a', 'a/b')).toThrow(/overlap/);
    expect(pair('a', './a')).toThrow(/overlap/);
    expect(pair('a', 'a//b')).toThrow(/overlap/);
    expect(pair('a/', 'a/b')).toThrow(/overlap/);
    expect(pair('a', 'a\\b')).toThrow(/overlap/); // literal backslash treated as separator
    expect(pair('dir with space', 'dir with space/f')).toThrow(/overlap/);
    expect(pair('a', 'a/../b')).toThrow(/scope/);
    expect(pair('a', 'a/../a')).toThrow(/scope/);
    expect(pair('a', '/abs')).toThrow(/scope/);
    expect(pair('a', 'C:\\x')).toThrow(/scope/);
    expect(pair('a', ' ')).toThrow(/empty/);
    expect(pair('a', 'A')).not.toThrow();
    expect(pair('a', 'a b')).not.toThrow();
    expect(pair('a', 'b')).not.toThrow();
    // different cwd never collides even with identical paths
    expect(() => assertNonOverlapping([
      { beadId: 'x', cwd: WT, files: ['a'] },
      { beadId: 'y', cwd: '/other', files: ['a/b'] },
    ])).not.toThrow();
  });

  // --- reproduced defects (each fails against current source) ---

  test('empty file scope must not silently allow unscoped workers in one wave', () => {
    // files: [] means "no declared scope"; two such workers in the same cwd can
    // stomp each other. scopesOverlap is never reached for empty arrays.
    expect(() => assertNonOverlapping([
      { beadId: 'x', cwd: WT, files: [] },
      { beadId: 'y', cwd: WT, files: [] },
    ])).toThrow(/overlap|scope/);
  });

  test('dispatch of string beads with no entry in mission.scopes must reject or scope them', () => {
    // scopes[item] ?? [] silently produces files: [] — an unrestricted worker.
    expect(() => assertNonOverlapping([
      { beadId: 'x', cwd: WT, files: [] },
      { beadId: 'y', cwd: WT, files: ['a'] },
    ])).toThrow(/overlap|scope/);
  });

  test('empty assignment must be rejected before spawning a terminal (no orphan)', async () => {
    // Current order: create → build prompt → throw if still empty → handle never
    // persisted → orphaned terminal + permanently held reservation.
    const { run, calls } = router({ create: CREATE_ENVELOPE });
    const driver = createWorkerDriver(run, { persist: async () => {}, prompt: () => '' });
    const m = mission();
    await expect(driver.dispatch(m, [{ beadId: 'bead-1', cwd: WT, files: ['a'] }])).rejects.toThrow(/prompt|assignment/);
    expect(subCalls(calls, 'create')).toHaveLength(0);
  });

  test('send accepted:false must fail instead of losing the assignment', async () => {
    const { run } = router({
      wait: WAIT_SATISFIED,
      list: listEnvelope([liveTerminal()]),
      send: SEND_REJECTED,
    });
    const driver = createWorkerDriver(run, { persist: async () => {} });
    const m = mission({ workers: [worker()] });
    await expect(driver.resend(m, 'bead-1', bead('bead-1', 'ready'))).rejects.toThrow(/accept|deliver|send/i);
  });

  test('unsatisfied-but-ok idle wait must revalidate the terminal before retrying', async () => {
    // Real wait envelope nests satisfied under result.wait; the driver checks the
    // top level so the revalidate-and-retry branch is dead code.
    const { run, calls } = router({
      wait: WAIT_UNSATISFIED_OK,
      list: listEnvelope([liveTerminal()]),
      send: SEND_ACCEPTED,
    });
    const driver = createWorkerDriver(run, { persist: async () => {} });
    const m = mission({ workers: [worker()] });
    await expect(driver.resend(m, 'bead-1', bead('bead-1', 'ready'))).rejects.toThrow(/never reached TUI idle/);
    // expected: one requireLive (list) between the two wait attempts
    expect(subCalls(calls, 'wait').length).toBe(2);
    expect(subCalls(calls, 'list').length).toBeGreaterThanOrEqual(1);
  });
});
