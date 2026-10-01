import { expect, test } from 'bun:test';
import { autoDispatchAllowed } from '../src/controller';
import { DEFAULT_MISSION_CONFIG, validateMissionConfig } from '../src/config';
import { pickRoleModel } from '../src/review';
import { createWorkerDriver } from '../src/workers';
import type { Action, Mission, PolicyContext } from '../src/types';

const policy: PolicyContext = { resumeHold: false, owned: true, nativePlan: false, fresh: true, maxWorkers: 2 };
const dispatch: Action = { kind: 'dispatch', detail: 'Start workers: a', ids: ['a'] };
const mission = (extra: Partial<Mission> = {}): Mission => ({ version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'm', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd: '/tmp', delivery: 'local', beadsDir: '/tmp/beads' }, scopes: {}, phase: 'execute', evidence: {}, mode: 'auto', keep: false, reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 1, createdAt: '', updatedAt: '', ...extra });

test('auto-dispatch runs only for an unpaused, owned, unheld mission with the flag on', () => {
  expect(autoDispatchAllowed(mission(), dispatch, true, policy)).toBe(true);
  expect(autoDispatchAllowed(mission(), dispatch, false, policy)).toBe(false);
  expect(autoDispatchAllowed(mission({ mode: 'force' }), dispatch, true, policy)).toBe(true);
  expect(autoDispatchAllowed(mission({ mode: 'pause' }), dispatch, true, policy)).toBe(false);
  expect(autoDispatchAllowed(mission(), { ...dispatch, gate: { kind: 'wave', token: 't', detail: 'd', approved: false } }, true, policy)).toBe(false);
  expect(autoDispatchAllowed(mission({ blocker: 'stop' }), dispatch, true, policy)).toBe(false);
  for (const held of [{ resumeHold: true }, { owned: false }, { nativePlan: true }]) expect(autoDispatchAllowed(mission(), dispatch, true, { ...policy, ...held })).toBe(false);
  expect(autoDispatchAllowed(mission(), { ...dispatch, kind: 'verify' }, true, policy)).toBe(false);
});

test('role config defaults to the coordinator for review and task for workers, and accepts @role', () => {
  expect(DEFAULT_MISSION_CONFIG).toMatchObject({ modelRole: 'default', workerRole: 'task', autoDispatch: false });
  expect(validateMissionConfig({ version: 1 })).toMatchObject({ modelRole: 'default', workerRole: 'task', autoDispatch: false });
  expect(validateMissionConfig({ version: 1, modelRole: 'slow', workerRole: 'smol', autoDispatch: true })).toMatchObject({ modelRole: 'slow', workerRole: 'smol', autoDispatch: true });
  expect(validateMissionConfig({ version: 1, modelRole: '@default', workerRole: '@task' })).toMatchObject({ modelRole: 'default', workerRole: 'task' });
  expect(() => validateMissionConfig({ version: 1, modelRole: 'bad role!' })).toThrow(/modelRole/);
  expect(() => validateMissionConfig({ version: 1, workerRole: '' })).toThrow(/workerRole/);
  expect(() => validateMissionConfig({ version: 1, autoDispatch: 'yes' })).toThrow(/autoDispatch/);
});

test('role models resolve only to a plain available model, else the caller keeps the coordinator model', () => {
  const models = [{ provider: 'google', id: 'flash' }, { provider: 'anthropic', id: 'sonnet:beta' }];
  expect(pickRoleModel('google/flash', models)).toBe(models[0]);
  expect(pickRoleModel('google/flash:high', models)).toBe(models[0]);
  expect(pickRoleModel('missing/x, anthropic/sonnet:beta', models)).toBe(models[1]);
  expect(pickRoleModel('some-alias', models)).toBeUndefined();
  expect(pickRoleModel(undefined, models)).toBeUndefined();
});

test('workers launch on the worker role model, and inherit the default model when the role names none', async () => {
  for (const [model, expected] of [['devin/swe-2:high', " --model 'devin/swe-2:high' @"], [undefined, ' @']] as const) {
    const commands: string[] = [];
    const run = async (_command: string, args: string[]) => {
      if (args[1] === 'create') commands.push(args[args.indexOf('--command') + 1]!);
      return { code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-x', incarnationId: 'inc-x' } } }) };
    };
    const driver = createWorkerDriver(run, { persist: async () => {}, prompt: () => 'do it', model: () => model });
    await driver.dispatch(mission({ graph: 'beads' }), [{ beadId: 'b', cwd: '/tmp', files: ['a.ts'] }]);
    expect(commands[0]).toContain(`omp${expected}`);
  }
});

test('herdr workers receive the worker role model as an agent argument', async () => {
  const calls: string[][] = [];
  const run = async (command: string, args: string[]) => {
    if (command === 'herdr') calls.push(args);
    const stdout = args[0] === 'tab' ? JSON.stringify({ result: { tab: { tab_id: 't1' }, root_pane: { pane_id: 'p1' } } }) : '';
    return { code: 0, stderr: '', stdout };
  };
  const driver = createWorkerDriver(run, { persist: async () => {}, prompt: () => 'do it', model: () => 'devin/swe-2:high', frontend: 'herdr' });
  await driver.dispatch(mission({ graph: 'beads' }), [{ beadId: 'b', cwd: '/tmp', files: ['a.ts'] }]);
  const start = calls.find(args => args[0] === 'agent' && args[1] === 'start')!;
  expect(start.slice(-3)).toEqual(['--', '--model', 'devin/swe-2:high']);
});
