import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import missionExtension from '../src/extension';
import { isRecord } from '../src/guards';
import { captureRevision } from '../src/review';
import { loadMission, missionPath, saveMission } from '../src/store';
import type { Graph, Mission, Run } from '../src/types';

type Operation = 'continue' | 'accept_repairs' | 'record_verification' | 'reject_finding';
type Params = { operation: Operation; passed?: boolean; detail?: string; findingId?: string };
type Execute = (id: string, params: Params, signal: undefined, update: undefined, context: ExtensionContext) => Promise<unknown>;
type EventHandler = (event: unknown, context: ExtensionContext) => Promise<void>;
const noRun: Run = async () => { throw new Error('Unexpected command'); };

async function fixture(graph: Graph, leaves = true, host: { idle?: boolean; pending?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mission-lifecycle-'));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'task.txt'), 'before');
  const mission: Mission = {
    version: 1, id: 'smoke', graph, round: 1, mode: 'auto', keep: false,
    reviewRequested: true, phase: 'execute', createdAt: 'now', updatedAt: 'now',
    source: { kind: 'freeform', id: 'smoke', title: 'Lifecycle', body: '', comments: '', extra: '' },
    workspace: { key: 'workspace', cwd, delivery: 'local' }, scopes: { leaf: ['task.txt'] },
    evidence: {}, workers: [], reviews: [], repairLinks: {},
    ...(graph === 'beads' ? { epicId: 'epic' } : {}),
  };
  const revision = (await captureRevision(mission, noRun)).revision;
  if (graph === 'local') {
    mission.phase = 'review';
    mission.evidence.verify = { outcome: 'passed', revision, detail: 'before', at: 'now' };
    mission.evidence.deliver = { outcome: 'passed', revision, detail: 'before', at: 'now' };
    mission.reviews = [{ round: 1, revision, summary: 'Defect', model: 'test', at: 'now', findings: [{ id: 'f', severity: 'high', path: 'task.txt', line: 1, title: 'Defect', body: 'Fix task.txt' }] }];
  }
  const path = missionPath(root, mission);
  await saveMission(path, mission);
  const tools = new Map<string, Execute>();
  let commandHandler: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
  const sent: string[] = [];
  const sentOptions: unknown[] = [];
  const notices: string[] = [];
  const events = new Map<string, EventHandler>();
  let active: string[] = [];
  // This fixture supplies only host services used by these operations. Storage,
  // revision capture, graph parsing, and mission transitions are real.
  const context = {
    agent: { kind: 'main' }, cwd, hasUI: false,
    sessionManager: { getBranch: () => [{ type: 'custom', customType: 'mission:pointer', data: { path } }], getSessionName: () => undefined },
    ui: { notify: (message: string) => { notices.push(message); }, setWidget: () => {} },
    isIdle: () => host.idle ?? false, hasPendingMessages: () => host.pending ?? false,
    setInterval: () => 1, clearTimer: () => {},
  } as unknown as ExtensionContext;
  const api = {
    registerTool(tool: unknown) {
      if (!isRecord(tool) || typeof tool.name !== 'string' || typeof tool.execute !== 'function') throw new Error('Invalid tool');
      tools.set(tool.name, tool.execute as Execute);
    },
    registerCommand: (_name: string, spec: { handler: (args: string, context: ExtensionContext) => Promise<void> }) => { commandHandler = spec.handler; }, registerShortcut: () => {},
    on: (name: string, handler: EventHandler) => events.set(name, handler), events: { on: () => {} },
    getActiveTools: () => active, setActiveTools: async (names: string[]) => { active = names; },
    appendEntry: () => {}, sendUserMessage: (message: string, options?: unknown) => { sent.push(message); sentOptions.push(options); },
    exec: async (command: string, args: string[]) => {
      const bdIndex = args.indexOf('bd');
      if (command === 'env' && bdIndex >= 0) args = args.slice(bdIndex + 1);
      else if (command !== 'bd') throw new Error(`Unexpected command: ${command}`);
      let rows: unknown[];
      if (args.includes('show')) rows = [{ id: 'epic', issue_type: 'epic', status: 'open' }];
      else if (args.includes('ready')) rows = [];
      else if (args.includes('list')) rows = leaves && args[args.indexOf('--parent') + 1] === 'epic' ? [{ id: 'leaf', title: 'Leaf', status: 'done' }] : [];
      else throw new Error(`Unexpected bd command: ${args.join(' ')}`);
      return { code: 0, stdout: JSON.stringify(rows), stderr: '' };
    },
  } as unknown as ExtensionAPI;
  const old = process.env.PI_CODING_AGENT_DIR;
  try {
    process.env.PI_CODING_AGENT_DIR = root;
    await missionExtension(api);
  } finally {
    if (old === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = old;
  }
  const start = events.get('session_start');
  const shutdown = events.get('session_shutdown');
  const control = tools.get('mission_control');
  if (!start || !shutdown || !control) throw new Error('Mission extension unavailable');
  await start({}, context);
  const execute = (params: Params) => control('test', params, undefined, undefined, context);
  await execute({ operation: 'continue' });
  return {
    command: async (args: string) => { await commandHandler!(args, context); }, sent, sentOptions, notices,
    execute, cwd, state: () => loadMission(path),
    dispose: async () => { try { await shutdown({}, context); } finally { await rm(root, { recursive: true, force: true }); } },
  };
}

test('done implementation leaves can be verified; empty graphs cannot', async () => {
  for (const leaves of [true, false]) {
    const mission = await fixture('beads', leaves);
    try {
      const verification = mission.execute({ operation: 'record_verification', passed: true, detail: 'Smoke passed' });
      if (!leaves) await expect(verification).rejects.toThrow();
      else {
        await verification;
        expect((await mission.state()).phase).toBe('deliver');
        expect((await mission.state()).evidence.verify?.outcome).toBe('passed');
      }
    } finally { await mission.dispose(); }
  }
});

test('local repairs require changed output and fresh verification/delivery', async () => {
  const mission = await fixture('local');
  try {
    await mission.execute({ operation: 'accept_repairs' });
    const accepted = await mission.state();
    expect(accepted.round).toBe(2);
    expect(accepted.evidence.verify).toBeUndefined();
    expect(accepted.evidence.deliver).toBeUndefined();
    await expect(mission.execute({ operation: 'record_verification', passed: true, detail: 'Unchanged' })).rejects.toThrow();
    await writeFile(join(mission.cwd, 'task.txt'), 'after');
    await mission.execute({ operation: 'record_verification', passed: false, detail: 'Smoke failed' });
    expect((await mission.state()).evidence.repair?.outcome).toBe('failed');
    await mission.execute({ operation: 'record_verification', passed: true, detail: 'Smoke passed' });
    const verified = await mission.state();
    expect(verified.evidence.repair?.outcome).toBe('passed');
    expect(verified.phase).toBe('deliver');
    expect(verified.evidence.deliver).toBeUndefined();
    expect(verified.evidence.verify?.revision).not.toBe(accepted.reviews[0]?.revision);
  } finally { await mission.dispose(); }
});

test('rejecting every accepted repair finalizes repair evidence without requiring edits', async () => {
  const mission = await fixture('local');
  try {
    await mission.execute({ operation: 'accept_repairs' });
    await mission.execute({ operation: 'reject_finding', findingId: 'f', detail: 'Existing behavior is intentional' });
    expect((await mission.state()).evidence.repair?.outcome).toBe('skipped');
    await mission.execute({ operation: 'record_verification', passed: true, detail: 'Original output reverified' });
    expect((await mission.state()).phase).toBe('deliver');
    expect((await mission.state()).evidence.repair?.outcome).toBe('skipped');
  } finally { await mission.dispose(); }
});

test('operator commands run the control operation directly instead of asking the model to', async () => {
  const mission = await fixture('beads');
  try {
    await mission.command('continue');
    expect(mission.sent).toEqual([]);
    expect(mission.notices.some(message => message.startsWith('Mission continue done'))).toBe(true);
    expect((await mission.state()).phase).toBe('execute');
  } finally { await mission.dispose(); }
});

test('an idle session is woken with a plain prompt, never a queued follow-up that nothing would drain', async () => {
  const mission = await fixture('beads', true, { idle: true });
  try {
    expect(mission.sent).toHaveLength(1);
    expect(mission.sent[0]).toContain('Next: verify');
    expect(mission.sentOptions[0]).toEqual({ attribution: 'agent' });
  } finally { await mission.dispose(); }
});

test('a queued message keeps the model from being woken again', async () => {
  const mission = await fixture('beads', true, { idle: true, pending: true });
  try { expect(mission.sent).toEqual([]); } finally { await mission.dispose(); }
});
