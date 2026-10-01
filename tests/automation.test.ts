import { expect, test } from 'bun:test';
import { autoDispatchAllowed } from '../src/controller';
import { DEFAULT_MISSION_CONFIG, validateMissionConfig } from '../src/config';
import { pickRoleModel } from '../src/review';
import type { Action, Mission, PolicyContext } from '../src/types';

const policy: PolicyContext = { resumeHold: false, owned: true, nativePlan: false, fresh: true, maxWorkers: 2 };
const dispatch: Action = { kind: 'dispatch', detail: 'Start workers: a', ids: ['a'] };
const mission = (extra: Partial<Mission> = {}): Mission => ({ version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'm', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd: '/tmp', delivery: 'local' }, scopes: {}, phase: 'execute', evidence: {}, mode: 'auto', keep: false, reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 1, createdAt: '', updatedAt: '', ...extra });

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

test('new config keys default safely and reject bad values', () => {
  expect(DEFAULT_MISSION_CONFIG).toMatchObject({ modelRole: 'smol', autoDispatch: false });
  expect(validateMissionConfig({ version: 1 })).toMatchObject({ modelRole: 'smol', autoDispatch: false });
  expect(validateMissionConfig({ version: 1, modelRole: 'slow', autoDispatch: true })).toMatchObject({ modelRole: 'slow', autoDispatch: true });
  expect(() => validateMissionConfig({ version: 1, modelRole: 'bad role!' })).toThrow(/modelRole/);
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
