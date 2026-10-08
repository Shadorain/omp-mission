import { expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import missionExtension from '../src/extension';
import { isRecord } from '../src/guards';
import { captureRevision } from '../src/review';
import { loadMission, missionPath, saveMission, workspaceKey } from '../src/store';
import type { Graph, Mission, Run } from '../src/types';

type Operation = 'start' | 'clear' | 'continue' | 'bind_graph' | 'accept_repairs' | 'record_verification' | 'record_delivery' | 'run_review' | 'reject_finding';
type Params = { operation: Operation; passed?: boolean; detail?: string; findingId?: string; url?: string; epicId?: string; scopes?: Record<string,string[]> };
type Execute = (id: string, params: Params, signal: undefined, update: undefined, context: ExtensionContext) => Promise<unknown>;
type EventHandler = (event: unknown, context: ExtensionContext) => Promise<unknown>;
const noRun: Run = async () => { throw new Error('Unexpected command'); };

async function fixture(graph: Graph, leaves = true, host: { idle?: boolean; pending?: boolean; resumed?: boolean; unreviewed?: boolean; clean?: boolean; complete?: boolean; plan?: boolean; otherCheckout?: boolean; linearCheckout?: boolean; archived?: boolean; prBase?: string; delivered?: boolean; reviewRequested?: boolean; legacyFingerprint?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'mission-lifecycle-'));
  const cwd = join(root, 'workspace');
  await mkdir(cwd);
  await writeFile(join(cwd, 'task.txt'), 'before');
  const mission: Mission = {
    version: 1, id: 'smoke', graph, round: 1, mode: 'auto', keep: false,
    reviewRequested: host.reviewRequested ?? true, phase: 'execute', createdAt: 'now', updatedAt: 'now',
    source: { kind: 'freeform', id: 'smoke', title: 'Lifecycle', body: '', comments: '', extra: '' },
    workspace: { key: 'workspace', cwd, delivery: 'local', ...(graph==='beads'?{beadsDir:join(root,'beads')}:{}), ...(host.prBase?{base:'v2/backend-rewrite'}:{}) }, scopes: { leaf: ['task.txt'] },
    evidence: {}, workers: [], reviews: [], repairLinks: {},
    ...(graph === 'beads' ? { epicId: 'epic' } : {}),
  };
  const revision = (await captureRevision(mission, noRun)).revision;
  if (graph === 'local') {
    mission.phase = 'review';
    mission.evidence.verify = { outcome: 'passed', revision, detail: 'before', at: 'now' };
    mission.evidence.deliver = { outcome: 'passed', revision, detail: 'before', at: 'now' };
    mission.reviews = host.unreviewed ? [] : [{ round: 1, revision, summary: host.clean ? 'Clean' : 'Defect', model: 'test', at: 'now', findings: host.clean ? [] : [{ id: 'f', severity: 'high', path: 'task.txt', line: 1, title: 'Defect', body: 'Fix task.txt' }] }];
  }
  if (host.legacyFingerprint && mission.evidence.verify) {
   const captured = await captureRevision(mission, noRun);
   mission.evidence.verify = { ...mission.evidence.verify, revision: captured.legacyRevision, tree: captured.legacyTree };
   if (mission.evidence.deliver) mission.evidence.deliver = { ...mission.evidence.deliver, revision: captured.legacyRevision };
  }
  if(host.prBase){mission.workspace.delivery='pr';mission.workspace.base='v2/backend-rewrite';mission.reviews=[];mission.reviewRequested=!!host.delivered;if(host.delivered)mission.mode='pause';else{delete mission.evidence.deliver;mission.phase='deliver';}}
  if (host.complete) mission.phase = 'complete';
  if (host.otherCheckout || host.linearCheckout) {
    await mkdir(join(root, '.git'));
    mission.source = { ...mission.source, kind: 'linear', id: 'linear:CHR-143' };
    mission.workspace = { ...mission.workspace, key: await workspaceKey(join(root, '.git')), cwd: host.otherCheckout ? join(root, 'old-worktree') : cwd };
  }
  const path = missionPath(root, mission);
  await saveMission(path, mission);
  if (host.archived) await saveMission(missionPath(root, { ...mission, id: 'archived' }), {
    ...mission, id: 'archived', phase: 'complete',
    source: { kind: 'linear', id: 'linear:CHR-99', title: 'Archived task', body: '', comments: '', extra: '' },
  });
  const tools = new Map<string, Execute>();
  let commandHandler: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
  let completions: ((prefix: string) => Array<{ value: string; label: string }> | null) | undefined;
  const messages: string[] = [];
  const sent: string[] = [];
  const sentOptions: unknown[] = [];
  const notices: string[] = [];
  const noticeEvents:Array<{message:string;level?:string}>=[];
  const noticeWaiters: Array<{ prefix?: string; level?:string; count: number; resolve: (message: string) => void }> = [];
  const settleNoticeWaiters = () => {
    for (const waiter of noticeWaiters) {
      const hits = noticeEvents.filter(({message,level}) => (waiter.prefix===undefined||message.startsWith(waiter.prefix))&&(waiter.level===undefined||level===waiter.level));
      if (hits.length >= waiter.count) waiter.resolve(hits[waiter.count - 1]!.message);
    }
  };
  const events = new Map<string, EventHandler>();
  let active: string[] = [];
  const branch: unknown[] = [...(host.otherCheckout ? [] : [{ type: 'custom', customType: 'mission:pointer', data: { path } }]), ...(host.plan ? [{ type: 'mode_change', mode: 'plan' }] : [])];
  // This fixture supplies only host services used by these operations. Storage,
  // revision capture, graph parsing, and mission transitions are real.
  const context = {
    agent: { kind: 'main' }, cwd, hasUI: false,
    sessionManager: { getBranch: () => branch, getSessionName: () => undefined },
    ui: { notify: (message: string,level?:string) => { notices.push(message);noticeEvents.push({message,level});settleNoticeWaiters(); }, setWidget: () => {} },
    isIdle: () => host.idle ?? false, hasPendingMessages: () => host.pending ?? false,
    setInterval: () => 1, clearTimer: () => {}, setTimeout: (fn: () => void) => { fn(); return 1; },
  } as unknown as ExtensionContext;
  const api = {
    registerTool(tool: unknown) {
      if (!isRecord(tool) || typeof tool.name !== 'string' || typeof tool.execute !== 'function') throw new Error('Invalid tool');
      tools.set(tool.name, tool.execute as Execute);
    },
    registerCommand: (_name: string, spec: { handler: (args: string, context: ExtensionContext) => Promise<void>; getArgumentCompletions: (prefix: string) => Array<{ value: string; label: string }> | null }) => { commandHandler = spec.handler; completions = spec.getArgumentCompletions; }, registerShortcut: () => {},
    on: (name: string, handler: EventHandler) => events.set(name, handler), events: { on: () => {} },
    getActiveTools: () => active, setActiveTools: async (names: string[]) => { active = names; },
    appendEntry: (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data }); },
    setSessionName: async () => {},
    sendUserMessage: (message: string, options?: unknown) => { sent.push(message); sentOptions.push(options); branch.push({ type: 'message', message: { role: 'user', content: message } }); },
    sendMessage: async (message: { content: string }) => { messages.push(message.content); },
    exec: async (command: string, args: string[]) => {
      const bdIndex = args.indexOf('bd');
      if (command === 'env' && bdIndex >= 0) args = args.slice(bdIndex + 1);
      else if (command === 'git') {
        if (!host.otherCheckout && !host.linearCheckout) return { code: 128, stdout: '', stderr: 'not a git repository' };
        const stdout = args[1] === '--show-toplevel' ? cwd : args[1] === '--git-common-dir' ? join(root, '.git') : args[0] === 'branch' ? 'chr-143-domain-error-2' : args[0] === 'config' ? 'main' : '';
        return { code: stdout ? 0 : 1, stdout, stderr: '' };
      }
      else if (command === 'lin') return { code: 0, stdout: JSON.stringify({ issue: { identifier: 'CHR-143', title: 'Fresh CHR-143', description: '' } }), stderr: '' };
      else if (command === 'gh' && host.prBase) return {code: 0, stdout: JSON.stringify({baseRefName: host.prBase}), stderr: ''};
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
  // Named assertion: the execute seam is typed unknown; the tool result shape is fixed by the extension.
  const continued = host.resumed ? undefined : await execute({ operation: 'continue' }) as { content: Array<{ text: string }> };
  return {
    first: continued ? JSON.parse(continued.content[0]!.text) : undefined,
    command: async (args: string) => { await commandHandler!(args, context); }, sent, sentOptions, notices,
    completions: (prefix: string) => completions!(prefix) ?? [], messages,
    noticeCount: (prefix: string, count: number) => { const { promise, resolve } = Promise.withResolvers<string>(); noticeWaiters.push({ prefix, count, resolve }); settleNoticeWaiters(); return promise; },
    errorCount: (count:number) => {const {promise,resolve}=Promise.withResolvers<string>();noticeWaiters.push({level:'error',count,resolve});settleNoticeWaiters();return promise;},
    execute, cwd, state: () => loadMission(path),
    event: (name:string,event:unknown) => events.get(name)!(event,context),
    restore: () => start({}, context),
    status: async () => {
      const result = await tools.get('mission_status')!('status', {} as Params, undefined, undefined, context) as { content: Array<{ text: string }> };
      return JSON.parse(result.content[0]!.text);
    },
    dispose: async () => { try { await shutdown({}, context); } finally { await rm(root, { recursive: true, force: true }); } },
  };
}

test('binding changed graph scopes requires fresh verification and delivery',async()=>{
 const mission=await fixture('beads',true,{reviewRequested:false});
 try{
  await mission.execute({operation:'record_verification',passed:true,detail:'Task output checked'});
  await mission.execute({operation:'record_delivery',detail:'Local result ready'});
  await mission.execute({operation:'bind_graph',epicId:'epic',scopes:{leaf:['task.txt','new.txt']}});
  const saved=await mission.state();
  expect(saved.evidence.verify).toBeUndefined();
  expect(saved.evidence.deliver).toBeUndefined();
  expect((await mission.status()).next.kind).toBe('verify');
 }finally{await mission.dispose();}
});

test('a beads auto verification failure wakes the repair step instead of parking',async()=>{
 const mission=await fixture('beads',true,{idle:true,reviewRequested:false});
 try{
  const before=mission.sent.length;
  await mission.execute({operation:'record_verification',passed:false,detail:'Remote host offline; stop until available'});
  expect(mission.sent.length).toBe(before+1);
  expect(mission.sent.at(-1)).toContain('Do not record verification');
  expect(mission.sent.at(-1)).not.toContain('Next: verify');
  expect((await mission.state()).evidence.verify?.outcome).toBe('failed');
 }finally{await mission.dispose();}
});

test('a coordinator shell write to an unbound implementation file holds verification without rollback',async()=>{
 const mission=await fixture('beads',true,{reviewRequested:false});
 try{
  await mission.execute({operation:'record_verification',passed:true,detail:'Verified'});
  await mission.execute({operation:'record_delivery',passed:true,detail:'Local result'});
  const call={toolCallId:'shell-write',toolName:'bash',input:{command:'printf unexpected > new.rs'}};
  const blocked=await mission.event('tool_call',call);
  expect(blocked).toBeUndefined();
  const child=Bun.spawn(['sh','-c',call.input.command],{cwd:mission.cwd,stdout:'pipe',stderr:'pipe'});
  expect(await child.exited).toBe(0);
  const result=await mission.event('tool_result',{...call,isError:false,content:[]}) as {isError:boolean};
  expect(result.isError).toBe(true);
  const saved=await mission.state();
  expect(saved.evidence.verify?.outcome).toBe('failed');
  expect(saved.evidence.verify?.detail).toContain('new.rs');
  expect(saved.evidence.deliver).toBeUndefined();
  expect((await mission.status()).next.kind).toBe('graph');
  expect(await readFile(join(mission.cwd,'new.rs'),'utf8')).toBe('unexpected');
 }finally{await mission.dispose();}
});

test('delivery refuses a PR targeting main instead of the bound integration branch', async () => {
 const mission = await fixture('local', true, {prBase: 'main'});
 try{
  await expect(mission.execute({operation: 'record_delivery',url:'https://github.com/owner/repo/pull/1',detail:'PR opened'})).rejects.toThrow('PR base main differs from bound base v2/backend-rewrite');
  expect((await mission.state()).evidence.deliver).toBeUndefined();
  expect((await mission.state()).phase).toBe('deliver');
 }finally{await mission.dispose();}
});

test('review refuses a PR retargeted away from the integration branch after delivery', async () => {
 const mission = await fixture('local', true, {prBase: 'main',delivered:true});
 try{
  await expect(mission.execute({operation:'run_review'})).rejects.toThrow('PR base main differs from bound base v2/backend-rewrite');
  expect((await mission.state()).workspace.base).toBe('v2/backend-rewrite');
  expect((await mission.state()).evidence.review).toBeUndefined();
 }finally{await mission.dispose();}
});

test('delivery accepts the explicitly bound integration branch', async () => {
 const mission = await fixture('local', true, {prBase:'v2/backend-rewrite'});
 try{
  await mission.execute({operation:'record_delivery',url:'https://github.com/owner/repo/pull/1',detail:'PR opened against integration branch'});
  expect((await mission.state()).evidence.deliver?.outcome).toBe('passed');
  expect((await mission.state()).phase).toBe('review');
 }finally{await mission.dispose();}
});

test('completed missions appear only in history completion and browsing preserves the active mission', async () => {
  const mission = await fixture('local', true, { resumed: true, archived: true });
  try {
    expect(mission.completions('').map(item => item.label)).not.toContain('CHR-99');
    expect(mission.completions('history CHR').map(item => item.value)).toContain('history archived ');
    await mission.command('history');
    expect(mission.messages.at(-1)).toContain('CHR-99');
    expect(mission.messages.at(-1)).not.toContain('Lifecycle');
    await mission.command('history archived');
    expect((await mission.status()).mission).toBe('smoke');
    expect((await mission.state()).phase).toBe('review');
  } finally { await mission.dispose(); }
});

test('clear preserves completed history and survives restore, including discarded pending plans', async () => {
  const mission = await fixture('local', true, { resumed: true, complete: true, plan: true, linearCheckout: true });
  try {
    await mission.execute({ operation: 'clear' });
    expect((await mission.status()).mission).toBeUndefined();
    expect((await mission.state()).phase).toBe('complete');
    expect(mission.completions('history CHR').map(item => item.value)).toContain('history smoke ');
    await mission.command('history smoke');
    expect((await mission.status()).mission).toBeUndefined();
    await mission.restore();
    expect((await mission.status()).mission).toBeUndefined();
    await mission.command('');
    expect((await mission.status()).pending.source).toBe('linear:CHR-143');
    await expect(mission.execute({ operation: 'start' })).rejects.toThrow('native plan mode');
    await mission.command('clear');
    await mission.restore();
    expect((await mission.status()).pending).toBeUndefined();
    expect((await mission.state()).phase).toBe('complete');
  } finally { await mission.dispose(); }
});

test('clear refuses an unfinished saved mission without detaching it', async () => {
  const mission = await fixture('local', true, { resumed: true });
  try {
    await expect(mission.execute({ operation: 'clear' })).rejects.toThrow('unfinished mission');
    expect((await mission.status()).mission).toBe('smoke');
    expect((await mission.state()).phase).toBe('review');
  } finally { await mission.dispose(); }
});

test.each(['', 'CHR-143'])('same ticket in another worktree starts a fresh plan via /mission %s', async (args) => {
  const mission = await fixture('local', true, { resumed: true, complete: true, plan: true, otherCheckout: true });
  try {
    await mission.command(args);
    const status = await mission.status();
    expect(status.mission).toBeUndefined();
    expect(status.pending.source).toBe('linear:CHR-143');
    expect(status.pending.id).not.toBe('smoke');
    expect((await mission.state()).phase).toBe('complete');
  } finally { await mission.dispose(); }
});

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
    await expect(mission.execute({ operation: 'record_verification', passed: true, detail: 'Still held' })).rejects.toThrow();
    await mission.command('continue');
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

test('/mission review in a resumed session says to run /mission continue instead of staying silent', async () => {
  const mission = await fixture('local', true, { idle: true, resumed: true });
  try {
    await mission.command('review');
    expect(mission.notices.some(notice => notice.includes('/mission continue'))).toBe(true);
    expect(mission.sent).toEqual([]);
  } finally { await mission.dispose(); }
});

test('a clean review of the verified revision completes the mission in the extension, without a model turn', async () => {
  const mission = await fixture('local', true, { idle: true, clean: true, resumed: true });
  try {
    expect(mission.completions('').map(item => item.label)).not.toContain('smoke');
    expect(mission.completions('sm').map(item => item.label)).toContain('smoke');
    await mission.execute({ operation: 'continue' });
    expect(await mission.noticeCount('Mission complete', 1)).toContain('/mission clear');
    expect(mission.sent).toEqual([]);
    const saved = await mission.state();
    expect(saved.phase).toBe('complete');
    expect(saved.evidence.complete?.outcome).toBe('passed');
    expect(mission.completions('').map(item => item.label)).not.toContain('smoke');
    expect(mission.completions('').map(item => item.label)).toContain('clear');
    expect(mission.completions('history ').map(item => item.value)).toContain('history smoke ');
  } finally { await mission.dispose(); }
});

test('a requested review starts in the extension without waking the model, and /mission review retries a failure', async () => {
  const mission = await fixture('local', true, { idle: true, unreviewed: true });
  try {
    // The fixture host has no model, so each review fails once it starts; reaching that failure proves the extension ran run_review itself.
    await mission.errorCount(1);
    expect(mission.sent).toEqual([]);
    expect((await mission.state()).evidence.review?.outcome).toBe('failed');
    const retried = mission.errorCount(2);
    await mission.command('review');
    await retried;
    expect(mission.sent).toEqual([]);
  } finally { await mission.dispose(); }
});

test('review migrates a pre-prefix fingerprint instead of rejecting an unchanged checkout', async () => {
 const mission = await fixture('local', true, { idle: true, unreviewed: true, legacyFingerprint: true });
 try {
  const notice = await mission.errorCount(1);
  expect(notice).not.toContain('Files changed since verification');
  expect(notice).not.toContain('Revision changed');
  const saved = await mission.state();
  expect(saved.evidence.review?.outcome).toBe('failed');
  expect(saved.evidence.verify?.revision).toBe((await captureRevision(saved, noRun)).revision);
  expect(saved.evidence.deliver?.revision).toBe(saved.evidence.verify?.revision);
 } finally { await mission.dispose(); }
});

test('/mission approve at a repairs gate accepts the repairs in the extension', async () => {
  const mission = await fixture('local', true, { idle: true });
  try {
    await mission.command('mode pause');
    expect((await mission.state()).gate?.kind).toBe('repairs');
    await mission.command('approve');
    const accepted = await mission.state();
    expect(accepted.phase).toBe('repair');
    expect(accepted.evidence.repair?.outcome).toBe('active');
    // The model is woken for the repair work itself, not to relay accept_repairs.
    expect(mission.sent.at(-1)).toContain('Next: verify');
  } finally { await mission.dispose(); }
});

test('a control result does not tell the coordinator to run a step the extension is already running', async () => {
  const mission = await fixture('local', true, { idle: true, unreviewed: true });
  try {
    expect(mission.first.next.kind).toBe('hold');
    // The fixture has no model, so the extension's start fails; the status then reports the failure, not "extension is running".
    await mission.errorCount(1);
    expect((await mission.state()).evidence.review?.outcome).toBe('failed');
    expect((await mission.status()).next.kind).toBe('hold');
  } finally { await mission.dispose(); }
});
