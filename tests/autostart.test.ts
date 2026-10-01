import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import missionExtension from '../src/extension';
import { loadMission } from '../src/store';

type Handler = (event: unknown, context: ExtensionContext) => Promise<any>;
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

// Real extension, real storage and ownership; only the host (pi.exec, UI) is faked.
async function session(options: { bd: boolean }) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'autostart-')));
  roots.push(root);
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  await mkdir(join(root, 'beads'));
  await writeFile(join(root, 'mission.json'), JSON.stringify({ version: 1, graph: 'beads', frontend: 'orca' }));
  const events = new Map<string, Handler>();
  const sent: string[] = [];
  let command: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
  let active: string[] = [];
  const context = {
    agent: { kind: 'main' }, cwd, hasUI: false,
    sessionManager: { getBranch: () => [], getSessionName: () => undefined },
    ui: { notify: () => {}, setWidget: () => {} },
    isIdle: () => true, hasPendingMessages: () => false,
    setInterval: () => 1, clearTimer: () => {}, setTimeout: () => 1,
  } as unknown as ExtensionContext;
  const api = {
    registerTool: () => {}, registerShortcut: () => {},
    registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
    on: (name: string, handler: Handler) => events.set(name, handler), events: { on: () => {} },
    getActiveTools: () => active, setActiveTools: async (names: string[]) => { active = names; },
    appendEntry: () => {}, sendUserMessage: (message: string) => { sent.push(message); }, sendMessage: () => {}, setSessionName: async () => {},
    exec: async (name: string, args: string[]) => {
      if (name === 'git') return { code: 128, stdout: '', stderr: 'not a git repository' };
      const bd = name === 'env' ? args.indexOf('bd') : name === 'bd' ? 0 : -1;
      if (bd >= 0 && args.includes('where')) return options.bd ? { code: 0, stdout: JSON.stringify({ path: join(root, 'beads') }), stderr: '' } : { code: 1, stdout: '', stderr: 'no database' };
      throw new Error(`Unexpected command: ${name} ${args.join(' ')}`);
    },
  } as unknown as ExtensionAPI;
  const old = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try { await missionExtension(api); } finally { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; }
  await events.get('session_start')!({}, context);
  await command!('--force -- build a thing', context);
  return { root, cwd, events, context, sent, hasHook: events.has('before_agent_start') };
}

const approved = { prompt: 'Plan approved.\n<plan>…</plan>', systemPrompt: [] as string[] };

test('approving the plan starts the mission, binds an existing checkout, and hands over the next step', async () => {
  const run = await session({ bd: true });
  const result = await run.events.get('before_agent_start')!(approved, run.context);
  expect(result.message.content).toMatch(/^Mission started\. Checkout bound: .+ delivery local, beads .+beads\. Next: graph\. Read the repository/);
  expect(result.systemPrompt).toBeUndefined();
  const saved = await loadMission((await Array.fromAsync(new Bun.Glob('missions/*/*.json').scan({ cwd: run.root, absolute: true })))[0]!);
  expect(saved.phase).toBe('graph');
  expect(saved.workspace.beadsDir).toBe(join(run.root, 'beads'));
  expect(saved.evidence.plan?.outcome).toBe('passed');
  // already started: a later turn must not start or rebind anything
  expect(await run.events.get('before_agent_start')!(approved, run.context)).toBeUndefined();
  // the extension already told the model; it must not also wake it with the same step
  expect(run.sent).toEqual([]);
});

test('an unbindable checkout is reported to the model instead of failing the turn', async () => {
  const run = await session({ bd: false });
  const result = await run.events.get('before_agent_start')!(approved, run.context);
  expect(result.message.content).toMatch(/^Mission started\. Checkout not bound automatically \(No bead database found/);
  expect(result.message.content).toMatch(/Next: isolate\. Run mission_control bind_workspace/);
});

test('ordinary turns and plan-mode turns never start a pending mission', async () => {
  const run = await session({ bd: true });
  expect(await run.events.get('before_agent_start')!({ prompt: 'please continue', systemPrompt: [] }, run.context)).toBeUndefined();
  const planning = { ...run.context, sessionManager: { getBranch: () => [{ type: 'mode_change', mode: 'plan' }], getSessionName: () => undefined } } as unknown as ExtensionContext;
  expect(await run.events.get('before_agent_start')!(approved, planning)).toBeUndefined();
});

test('compaction is told what the summary must keep, and the ticket stays re-readable', async () => {
  const run = await session({ bd: true });
  expect(await run.events.get('session.compacting')!({}, run.context)).toBeUndefined(); // nothing to pin before the mission starts
  await run.events.get('before_agent_start')!(approved, run.context);
  const pinned = (await run.events.get('session.compacting')!({}, run.context)).context as string[];
  expect(pinned.join('\n')).toMatch(/full ticket is in .+\.source\.md/);
  expect(pinned.join('\n')).toMatch(/Phase graph, mode force, graph beads, epic unbound/);
  expect(await Bun.file(pinned[0]!.match(/in (\S+\.source\.md);/)![1]!).text()).toContain('build a thing');
});
