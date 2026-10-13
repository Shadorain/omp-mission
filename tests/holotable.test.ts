import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { resolveLocalUrlToPath } from '@oh-my-pi/pi-coding-agent/internal-urls/local-protocol';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import missionExtension from '../src/extension';
import { listMissions, missionPath, saveMission } from '../src/store';
import { buildContactStatus, gateTokenId, autostartMessage, envBase, envCheckout, envDelivery, envGraph, planRevision, parseUsageLines, sumAssistantUsage, UsageProbe, type ContactStatus } from '../src/holotable';
import { planSlug } from '../src/prompts';
import type { Mission } from '../src/types';

type Handler = (event: unknown, context: ExtensionContext) => Promise<any>;
const roots: string[] = [];
const envKeys = ['PI_CODING_AGENT_DIR', 'OMP_HOLOTABLE_CHILD', 'OMP_MISSION_AUTOSTART'] as const;
const savedEnv = new Map<string, string | undefined>();
function setEnv(key: (typeof envKeys)[number], value: string | undefined) {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
afterEach(async () => {
	for (const [key, value] of savedEnv) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
	savedEnv.clear();
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function baseMission(cwd: string, over: Partial<Mission> = {}): Mission {
	return {
		version: 1, id: 'smoke-run', graph: 'local', round: 1, mode: 'auto', keep: false,
		reviewRequested: false, phase: 'execute', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
		source: { kind: 'freeform', id: 'smoke', title: 'Smoke', body: '', comments: '', extra: '' },
		workspace: { key: 'workspace', cwd, delivery: 'local' }, scopes: {}, evidence: {}, workers: [], reviews: [], repairLinks: {},
		...over,
	};
}
const idlePolicy = { resumeHold: false, owned: true, nativePlan: false, fresh: true, maxWorkers: 2 };

function statusFile(run: { root: string }, mission: Mission): string {
	return join(run.root, 'missions', mission.workspace.key, 'status', `${mission.id}.json`);
}
async function statusOf(run: { root: string }, mission: Mission): Promise<ContactStatus> {
	return JSON.parse(await Bun.file(statusFile(run, mission)).text());
}

// One newline-delimited request per connection; resolves with the single response line.
function ctl(socket: string, request: unknown): Promise<Record<string, any>> {
	const { promise, resolve, reject } = Promise.withResolvers<Record<string, any>>();
	const conn = createConnection(socket);
	let data = '';
	conn.setEncoding('utf8');
	conn.on('connect', () => conn.write(`${JSON.stringify(request)}\n`));
	conn.on('data', chunk => { data += chunk; });
	conn.on('end', () => { try { resolve(JSON.parse(data.trim())); } catch (error) { reject(error); } });
	conn.on('error', reject);
	return promise;
}

// Real extension, real store; pi.exec/UI faked as in autostart.test.ts.
async function session(options: { plan?: boolean; child?: boolean; autostart?: string; mission?: Mission; entries?: Array<Record<string, unknown>>; beforeLoad?: (root: string) => Promise<void> | void } = {}) {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'holotable-')));
	roots.push(root);
	const cwd = join(root, 'workspace');
	await mkdir(cwd);
	await writeFile(join(root, 'mission.json'), JSON.stringify({ version: 1, graph: 'beads', frontend: 'orca' }));
	let path: string | undefined;
	if (options.mission) {
		path = missionPath(root, options.mission);
		await saveMission(path, options.mission);
	}
	const events = new Map<string, Handler>();
	const sent: string[] = [];
	const notices: string[] = [];
	let command: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
	let active: string[] = [];
	const branch: Array<Record<string, unknown>> = [
		...(path ? [{ type: 'custom', customType: 'mission:pointer', data: { path } }] : []),
		...(options.plan ? [{ type: 'mode_change', mode: 'plan' }] : []),
		...(options.entries ?? []),
	];
	const context = {
		agent: { kind: 'main' }, cwd, hasUI: false,
		sessionManager: { getBranch: () => branch, getEntries: () => branch, getSessionName: () => undefined },
		localProtocolOptions: { getArtifactsDir: () => join(root, 'artifacts'), getSessionId: () => 'test-session' },
		ui: { notify: (message: string) => { notices.push(message); }, setWidget: () => {} },
		isIdle: () => true, hasPendingMessages: () => false,
		setInterval: () => 1, clearTimer: () => {}, setTimeout: () => 1,
	} as unknown as ExtensionContext;
	const api = {
		registerTool: () => {}, registerShortcut: () => {},
		registerCommand: (_name: string, spec: { handler: typeof command }) => { command = spec.handler; },
		on: (name: string, handler: Handler) => events.set(name, handler), events: { on: () => {} },
		getActiveTools: () => active, setActiveTools: async (names: string[]) => { active = names; },
		appendEntry: (customType: string, data: unknown) => { branch.push({ type: 'custom', customType, data }) },
		sendUserMessage: (message: string) => { sent.push(message); },
		sendMessage: async () => {}, setSessionName: async () => {},
		exec: async (name: string, args: string[]) => {
			if (name === 'git') return { code: 128, stdout: '', stderr: 'not a git repository' };
			if (name === 'lin') return { code: 0, stdout: JSON.stringify({ issue: { identifier: 'CHR-123', title: 'Startup', description: '', comments: { nodes: [] } } }), stderr: '' };
			const bd = name === 'env' ? args.indexOf('bd') : name === 'bd' ? 0 : -1;
			if (bd >= 0 && args.includes('where')) return { code: 0, stdout: JSON.stringify({ path: join(root, 'beads') }), stderr: '' };
			throw new Error(`Unexpected command: ${name} ${args.join(' ')}`);
		},
	} as unknown as ExtensionAPI;
	setEnv('PI_CODING_AGENT_DIR', root);
	setEnv('OMP_HOLOTABLE_CHILD', options.child ? '1' : undefined);
	setEnv('OMP_MISSION_AUTOSTART', options.autostart);
	await options.beforeLoad?.(root);
	await missionExtension(api);
	await events.get('session_start')!({}, context);
	return {
		root, cwd, events, context, sent, notices, branch,
		command: (args: string) => command!(args, context),
		pending: () => branch.find(entry => entry.type === 'custom' && entry.customType === 'mission:pending')?.data as Mission | undefined,
		event: (name: string, event: unknown) => events.get(name)!(event, context),
	};
}

function socketName(missionId: string): string {
	return `${createHash('sha256').update(missionId).digest('hex').slice(0, 16)}.sock`;
}

test('the status builder maps each hold state and the C5 field list', async () => {
	const cwd = '/tmp';
	const input = (mission: Mission, over: Partial<Parameters<typeof buildContactStatus>[0]> = {}) => buildContactStatus({
		mission, pending: false, resumeHold: false, snapshot: undefined, policy: idlePolicy, step: undefined,
		owned: true, selected: undefined, operation: false, ctl: null, usage: null, ...over,
	});

	const pending = await input(baseMission(cwd), { pending: true, resumeHold: true, step: { text: 'Approve the plan' } });
	expect(pending.hold).toBe('plan-approval');
	expect(pending.actions).toEqual([]);
	expect(pending.progress).toEqual({ step: 3, of: 9 });

	const held = await input(baseMission(cwd), { resumeHold: true, step: { command: '/mission continue', text: 'Take control of this resumed mission' } });
	expect(held.hold).toBe('resume');
	expect(held.next).toBe('/mission continue — Take control of this resumed mission');

	const gated = await input(baseMission(cwd, { gate: { kind: 'wave', token: 'tok', detail: 'wave', approved: false } }), { step: { command: '/mission approve', text: 'wave' }, ctl: { socket: '/tmp/x.sock', generation: 7 } });
	expect(gated.hold).toBe('gate');
	expect(gated.gate).toEqual({ kind: 'wave', id: gateTokenId('tok') });
	expect(gated.ctl).toEqual({ socket: '/tmp/x.sock', generation: 7 });

	const blocked = await input(baseMission(cwd, { blocker: 'Upstream stalled' }));
	expect(blocked.hold).toBe('blocked');

	const quota = await input(baseMission(cwd, { phase: 'review', evidence: { review: { outcome: 'failed', detail: 'Reviewer quota exhausted on provider', at: 'now' } } }));
	expect(quota.hold).toBe('quota');

	const plain = await input(baseMission(cwd, {
		workspace: { key: 'k', cwd, delivery: 'pr', branch: 'feat', base: 'main' },
		workers: [
			{ beadId: 'b1', attempt: 'a', cwd, files: [], state: 'running', assignment: '' },
			{ beadId: 'b2', attempt: 'a', cwd, files: [], state: 'closed', assignment: '' },
		],
	}));
	expect(plain.hold).toBe('none');
	expect(plain.workers).toEqual({ live: 1, total: 2 });
	expect(plain.delivery).toEqual({ url: null, branch: 'feat' });
	expect(plain.base).toBe('main');
	expect(plain.complete).toBe(false);
});

// OMP session entries: {type:'message', message:{role:'assistant', usage:{input,output,cacheRead,cacheWrite,cost:{total}}}}
// (SessionMessageEntry/AssistantMessage/Usage in @oh-my-pi). Anything else in the stream is ignored.
function usageEntry(input: number, output: number, total?: number) {
	return {
		type: 'message',
		message: {
			role: 'assistant',
			usage: { input, output, cacheRead: 4, cacheWrite: 2, totalTokens: input + output + 6, ...(total === undefined ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } }) },
		},
	};
}

test('usage sums assistant message usage and tolerates foreign and partial records', () => {
	expect(sumAssistantUsage([])).toBeNull();
	expect(sumAssistantUsage([{ type: 'mode_change', mode: 'plan' }, { type: 'message', message: { role: 'user' } }, { type: 'message', message: { role: 'assistant' } }])).toBeNull();
	const totals = sumAssistantUsage([usageEntry(100, 10, 0.5), usageEntry(200, 20), { type: 'model_usage', usage: { input: 9, output: 9 } }, 'junk', null]);
	expect(totals).toEqual({ tokens: { input: 300, output: 30, cacheRead: 8, cacheWrite: 4 }, costUsd: 0.5, sessions: 1 });
	expect(parseUsageLines('')).toBeNull();
	expect(parseUsageLines(`{"type":"message","message":{"role":"assistant","usage":{"input":7,"output":3}}}\n{broken\n${JSON.stringify(usageEntry(1, 1, 0.25))}\n`))
		.toEqual({ tokens: { input: 8, output: 4, cacheRead: 4, cacheWrite: 2 }, costUsd: 0.25, sessions: 1 });
});

test('the usage probe sums worker session files, throttles, resumes mid-file and restarts on mission switch', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'holotable-usage-')));
	roots.push(root);
	const mission = baseMission(root);
	const other = baseMission(root, { id: 'second-run' });
	const workerDir = join(root, 'missions', mission.workspace.key, 'workers');
	const workerFile = join(workerDir, 'b1.jsonl');
	let now = 1_000;
	const probe = new UsageProbe(root, () => now, 30_000);
	const none = () => undefined;

	expect(await probe.measure(mission, none)).toBeNull(); // no coordinator entries, no workers dir
	now += 40_000;
	await mkdir(workerDir, { recursive: true });
	await writeFile(join(workerDir, 'b1.baseline.json'), '{}'); // sidecars in the dir are not session files
	expect(await probe.measure(mission, none)).toBeNull();

	// A mid-write tail line is skipped; the offset stops at the last newline.
	await writeFile(workerFile, `${JSON.stringify(usageEntry(100, 10, 0.5))}\n{"type":"message","mes`);
	now += 40_000;
	const first = await probe.measure(mission, () => [usageEntry(50, 5, 0.25)]);
	expect(first).toEqual({ tokens: { input: 150, output: 15, cacheRead: 8, cacheWrite: 4 }, costUsd: 0.75, sessions: 2 });

	// Inside the window the coordinator thunk is not consulted and nothing is re-read.
	await appendFile(workerFile, 'sage":{}}\n');
	expect(await probe.measure(mission, () => { throw new Error('throttled'); })).toEqual(first);

	// The deferred tail completes; only the new bytes are parsed.
	await appendFile(workerFile, `${JSON.stringify(usageEntry(10, 1, 0.1))}\n`);
	now += 40_000;
	expect(await probe.measure(mission, none)).toEqual({ tokens: { input: 110, output: 11, cacheRead: 8, cacheWrite: 4 }, costUsd: 0.6, sessions: 1 });

	// A mission switch recomputes immediately even inside the window.
	expect(await probe.measure(other, () => [usageEntry(7, 7)])).toEqual({ tokens: { input: 117, output: 18, cacheRead: 12, cacheWrite: 6 }, costUsd: 0.6, sessions: 2 });

	// A deleted worker file keeps its already-counted usage; a new probe reads it as foreign.
	await rm(workerFile);
	now += 40_000;
	expect(await probe.measure(other, none)).toEqual({ tokens: { input: 110, output: 11, cacheRead: 8, cacheWrite: 4 }, costUsd: 0.6, sessions: 1 });
	expect(await new UsageProbe(root, () => now).measure(other, none)).toBeNull();
});

test('a resume hold over failed verification still says verification failed', async () => {
	const base = baseMission('/tmp');
	const failed = { ...base, evidence: { ...base.evidence, verify: { outcome: 'failed' as const, detail: 'tests red', at: base.updatedAt } } };
	const status = await buildContactStatus({
		mission: failed, pending: false, resumeHold: true, snapshot: undefined,
		policy: idlePolicy, step: undefined, owned: true, selected: undefined, operation: false, ctl: null, usage: null,
	});
	// hold alone reads as an ordinary resume; verify is what tells a board not to continue it automatically.
	expect(status.hold).toBe('resume');
	expect(status.verify).toBe('failed');
	expect((await buildContactStatus({
		mission: base, pending: false, resumeHold: true, snapshot: undefined,
		policy: idlePolicy, step: undefined, owned: true, selected: undefined, operation: false, ctl: null, usage: null,
	})).verify).toBe(base.evidence.verify?.outcome ?? null);
});

test('the status file reports mission mode and estimated usage', async () => {
	const cwd = '/tmp';
	const status = await buildContactStatus({
		mission: baseMission(cwd, { mode: 'force' }), pending: false, resumeHold: false, snapshot: undefined,
		policy: idlePolicy, step: undefined, owned: true, selected: undefined, operation: false, ctl: null,
		usage: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.01, sessions: 2 },
	});
	expect(status.mode).toBe('force');
	expect(status.usage).toEqual({ tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.01, sessions: 2 });

	// A pending plan reports the planned mode; nothing recorded means usage stays null.
	const planned = await session({ plan: true });
	await planned.command('--pause -- demo');
	expect((await statusOf(planned, planned.pending()!)).mode).toBe('pause');
	expect((await statusOf(planned, planned.pending()!)).usage).toBeNull();

	// A saved mission sums the coordinator session entries and the worker session files.
	const mission = baseMission('/tmp');
	const workerDir = `missions/${mission.workspace.key}/workers`;
	const run = await session({ mission, entries: [usageEntry(50, 5, 0.25)], beforeLoad: async root => {
		await mkdir(join(root, workerDir), { recursive: true });
		await writeFile(join(root, workerDir, 'b1.jsonl'), `${JSON.stringify(usageEntry(100, 10, 0.5))}\n`);
	} });
	const published = await statusOf(run, mission);
	expect(published.mode).toBe('auto');
	expect(published.usage).toEqual({ tokens: { input: 150, output: 15, cacheRead: 8, cacheWrite: 4 }, costUsd: 0.75, sessions: 2 });
	await planned.event('session_shutdown', {});
	await run.event('session_shutdown', {});
});

test('environment overrides are validated and the autostart message strips /mission', () => {
	expect(envGraph({ OMP_MISSION_GRAPH: 'beads' })).toBe('beads');
	expect(envDelivery({ OMP_MISSION_DELIVERY: 'local' })).toBe('local');
	expect(envBase({ OMP_MISSION_BASE: 'v2/x' })).toBe('v2/x');
	expect(envCheckout({ OMP_MISSION_CHECKOUT: '/w' })).toBe('/w');
	expect(() => envGraph({ OMP_MISSION_GRAPH: 'bogus' })).toThrow('Invalid OMP_MISSION_GRAPH');
	expect(() => envDelivery({ OMP_MISSION_DELIVERY: 'fork' })).toThrow('Invalid OMP_MISSION_DELIVERY');
	expect(autostartMessage({ OMP_MISSION_AUTOSTART: '/mission CHR-1 --pause' })).toBe('CHR-1 --pause');
	expect(autostartMessage({ OMP_MISSION_AUTOSTART: '-- fix' })).toBe('-- fix');
	expect(autostartMessage({})).toBeUndefined();
});

test('a pending plan publishes a plan-approval status file and listMissions still works', async () => {
	const run = await session({ plan: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	expect(mission?.phase).toBe('plan');
	const status = await statusOf(run, mission);
	expect(status.hold).toBe('plan-approval');
	expect(status.phase).toBe('plan');
	expect(status.ctl).toBeNull();
	expect(status.actions).toEqual([]);
	// status/ sits inside the workspace dir; listMissions must ignore it, not throw.
	await mkdir(join(run.root, 'missions', mission.workspace.key), { recursive: true });
	expect(await listMissions(run.root)).toEqual([]);
	await run.event('session_shutdown', {});
});

test('without OMP_HOLOTABLE_CHILD there is no control socket', async () => {
	const run = await session({ plan: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const status = await statusOf(run, mission);
	expect(status.ctl).toBeNull();
	const dir = join(tmpdir(), `omp-mission-ctl-${process.getuid!()}`);
	expect(await Bun.file(join(dir, socketName(mission.id))).exists()).toBe(false);
	await run.event('session_shutdown', {});
});

test('OMP_MISSION_AUTOSTART creates the pending plan under plan mode; without it the launch is refused', async () => {
	const planned = await session({ plan: true, autostart: '/mission -- board demo' });
	expect(planned.pending()?.phase).toBe('plan');
	const refused = await session({ autostart: '/mission -- board demo' });
	expect(refused.pending()).toBeUndefined();
	// Outside plan mode the retry defers, and the same refusal fires from a direct call.
	await refused.command('-- board demo');
	expect(refused.notices.some(n => n.includes('/plan /mission'))).toBe(true);
	await planned.event('session_shutdown', {});
	await refused.event('session_shutdown', {});
});

test('a board child exposes ping and operator ops on a 0600 socket in a 0700 dir', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const status = await statusOf(run, mission);
	expect(status.ctl).not.toBeNull();
	const socket = status.ctl!.socket;
	expect(socket).toBe(join(tmpdir(), `omp-mission-ctl-${process.getuid!()}`, socketName(mission.id)));
	expect((await lstat(socket)).mode & 0o777).toBe(0o600);
	expect((await lstat(join(socket, '..'))).mode & 0o777).toBe(0o700);
	expect(await ctl(socket, { v: 1, op: 'ping' })).toMatchObject({ v: 1, ok: true });
	// A foreign process can ping too (spawned bun, no extension state).
	const foreign = Bun.spawn([process.execPath, '-e', `const c=require('node:net').createConnection(${JSON.stringify(socket)});let d='';c.on('connect',()=>c.write('{"v":1,"op":"ping"}\\n'));c.on('data',x=>{d+=x});c.on('end',()=>{process.stdout.write(d);process.exit(0)});`], { stdout: 'pipe' });
	expect(await foreign.exited).toBe(0);
	expect(JSON.parse((await new Response(foreign.stdout).text()).trim())).toMatchObject({ v: 1, ok: true });
	// approve on a pending plan: no saved mission, so the decision path rejects.
	const approve = await ctl(socket, { v: 1, op: 'approve', operator: true, args: {} });
	expect(approve.ok).toBe(false);
	expect(approve.error.code).toBe('rejected');
	expect((await ctl(socket, { v: 1, op: 'approve', args: {} })).error.code).toBe('bad-request');
	expect((await ctl(socket, { v: 1, op: 'record_verification', operator: true })).error.code).toBe('bad-request');
	// clear discards the pending plan: the reply flushes, then socket and status file are gone.
	expect(await ctl(socket, { v: 1, op: 'clear', operator: true, args: {} })).toMatchObject({ ok: true });
	await expect(ctl(socket, { v: 1, op: 'ping' })).rejects.toThrow();
	expect(await Bun.file(statusFile(run, mission)).exists()).toBe(false);
	await run.event('session_shutdown', {});
});

test('socket ops enforce the resume hold and the pause gate, and shutdown closes the socket', async () => {
	const mission = baseMission('/tmp', {
		mode: 'pause', reviewRequested: true, phase: 'review',
		evidence: {
			verify: { outcome: 'passed', detail: 'checked', revision: 'rev1', at: 'now' },
			deliver: { outcome: 'passed', detail: 'done', revision: 'rev1', at: 'now' },
		},
	});
	const run = await session({ child: true, mission });
	const socket = (await statusOf(run, mission)).ctl!.socket;
	// Resume hold: mutating ops are rejected; continue is allowed and takes control.
	const held = await ctl(socket, { v: 1, op: 'approve', operator: true, args: {} });
	expect(held.error.code).toBe('rejected');
	expect(held.error.message).toContain('Resumed session is read-only');
	expect((await ctl(socket, { v: 1, op: 'dispatch', operator: true, args: {} })).error.code).toBe('rejected');
	expect(await ctl(socket, { v: 1, op: 'continue', operator: true, args: {} })).toMatchObject({ ok: true });
	// continue armed the review gate; the status file advertises its id.
	const armed = await statusOf(run, mission);
	expect(armed.hold).toBe('gate');
	expect(armed.gate).not.toBeNull();
	expect(armed.actions).toContain('approve');
	expect((await ctl(socket, { v: 1, op: 'approve', operator: true, args: { gate: 'deadbeefdead' } })).error.code).toBe('stale');
	expect(await ctl(socket, { v: 1, op: 'approve', operator: true, args: { gate: armed.gate!.id } })).toMatchObject({ ok: true });
	await run.event('session_shutdown', {});
	await expect(ctl(socket, { v: 1, op: 'ping' })).rejects.toThrow();
	expect((await statusOf(run, mission)).ctl).toBeNull();
});

test('approve without a waiting gate is rejected', async () => {
	const mission = baseMission('/tmp', { phase: 'execute' });
	const run = await session({ child: true, mission });
	const socket = (await statusOf(run, mission)).ctl!.socket;
	// Lift the hold first; this mission is mid-execution, so no gate exists.
	expect(await ctl(socket, { v: 1, op: 'continue', operator: true, args: {} })).toMatchObject({ ok: true });
	const approve = await ctl(socket, { v: 1, op: 'approve', operator: true, args: {} });
	expect(approve.error.code).toBe('rejected');
	expect(approve.error.message).toContain('No gate is waiting');
	await run.event('session_shutdown', {});
});

async function writePlan(run: { root: string }, mission: Mission, text: string): Promise<string> {
	const plan = resolveLocalUrlToPath(`local://${planSlug(mission.source)}-plan.md`, { getArtifactsDir: () => join(run.root, 'artifacts'), getSessionId: () => 'test-session' });
	await mkdir(join(plan, '..'), { recursive: true });
	await writeFile(plan, text);
	return plan;
}

test('a pending plan with a written file advertises plan path and revision; otherwise null', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	let status = await statusOf(run, mission);
	expect(status.plan).toBeNull();
	const plan = await writePlan(run, mission, '# Plan\nDo the thing.\n');
	await run.event('auto_compaction_end', {});
	status = await statusOf(run, mission);
	expect(status.plan).toEqual({ path: plan, revision: planRevision('# Plan\nDo the thing.\n') });
	// A running (non-pending) mission never advertises a plan.
	const active = baseMission(run.cwd, { phase: 'execute' });
	const other = await session({ child: true, mission: active });
	expect((await statusOf(other, active)).plan).toBeNull();
	await run.event('session_shutdown', {});
	await other.event('session_shutdown', {});
});

test('plan reads the pending plan file without the operator flag', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const socket = (await statusOf(run, mission)).ctl!.socket;
	expect((await ctl(socket, { v: 1, op: 'plan' })).error.code).toBe('no-plan');
	const plan = await writePlan(run, mission, '# Plan\nStep one.\n');
	const reply = await ctl(socket, { v: 1, op: 'plan' });
	expect(reply.ok).toBe(true);
	expect(reply.revision).toBe(mission.updatedAt);
	expect(reply.plan).toEqual({ text: '# Plan\nStep one.\n', path: plan, revision: planRevision('# Plan\nStep one.\n') });
	// A saved mission has no pending plan at all.
	const active = baseMission('/tmp', { phase: 'execute' });
	const other = await session({ child: true, mission: active });
	const otherSocket = (await statusOf(other, active)).ctl!.socket;
	expect((await ctl(otherSocket, { v: 1, op: 'plan' })).error.code).toBe('no-plan');
	await run.event('session_shutdown', {});
	await other.event('session_shutdown', {});
});

test('plan-edit writes atomically, bumps the revision, and enforces base and limits', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const socket = (await statusOf(run, mission)).ctl!.socket;
	const plan = await writePlan(run, mission, 'v1\n');
	const revision = planRevision('v1\n');
	// The operator flag is mandatory.
	expect((await ctl(socket, { v: 1, op: 'plan-edit', args: { text: 'v2\n' } })).error.code).toBe('bad-request');
	// A stale base is refused and writes nothing.
	expect((await ctl(socket, { v: 1, op: 'plan-edit', operator: true, args: { text: 'v2\n', base: 'deadbeefdead' } })).error.code).toBe('stale');
	expect(await Bun.file(plan).text()).toBe('v1\n');
	// Over the 256 KiB cap is a bad request.
	expect((await ctl(socket, { v: 1, op: 'plan-edit', operator: true, args: { text: 'x'.repeat(256 * 1024 + 1) } })).error.code).toBe('bad-request');
	// Editing with the current base writes the file and republishes the status.
	const before = (await statusOf(run, mission)).revision;
	const edit = await ctl(socket, { v: 1, op: 'plan-edit', operator: true, args: { text: 'v2\n', base: revision } });
	expect(edit.ok).toBe(true);
	expect(edit.revision).not.toBe(before);
	expect(edit.plan).toEqual({ text: 'v2\n', path: plan, revision: planRevision('v2\n') });
	expect(await Bun.file(plan).text()).toBe('v2\n');
	const status = await statusOf(run, mission);
	expect(status.plan).toEqual({ path: plan, revision: planRevision('v2\n') });
	expect(status.revision).toBe(edit.revision);
	// plan-edit on a saved mission is rejected: nothing is awaiting approval.
	const active = baseMission('/tmp', { phase: 'execute' });
	const other = await session({ child: true, mission: active });
	const otherSocket = (await statusOf(other, active)).ctl!.socket;
	expect((await ctl(otherSocket, { v: 1, op: 'plan-edit', operator: true, args: { text: 'x' } })).error.code).toBe('rejected');
	await run.event('session_shutdown', {});
	await other.event('session_shutdown', {});
});

test('plan-refine sends the message into the session and is rejected without a pending plan', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const socket = (await statusOf(run, mission)).ctl!.socket;
	const sentBefore = run.sent.length;
	expect(await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'Add a rollback step.' } })).toMatchObject({ ok: true });
	expect(run.sent.length).toBe(sentBefore + 1);
	expect(run.sent.at(-1)).toBe('Add a rollback step.');
	expect((await ctl(socket, { v: 1, op: 'plan-refine', args: { message: 'x' } })).error.code).toBe('bad-request');
	expect((await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: '' } })).error.code).toBe('bad-request');
	// Outside a pending plan the op is rejected and sends nothing.
	const active = baseMission('/tmp', { phase: 'execute' });
	const other = await session({ child: true, mission: active });
	const otherSocket = (await statusOf(other, active)).ctl!.socket;
	expect((await ctl(otherSocket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'hi' } })).error.code).toBe('rejected');
	expect(other.sent.length).toBe(0);
	await run.event('session_shutdown', {});
	await other.event('session_shutdown', {});
});

// Installs the OMP plan-review API (omp 18.x lacks it; presence is feature-detected) on the fake context.
function planReviewApi(run: { context: ExtensionContext }, calls: Array<[string, string, { feedback?: string } | undefined]>, pending?: { reviewId: string }) {
	const api = run.context as unknown as Record<string, unknown>;
	api.resolvePlanReview = (reviewId: string, choice: string, input?: { feedback?: string }) => { calls.push([reviewId, choice, input]); return true; };
	if (pending) api.getPendingPlanReview = () => pending;
}

test('plan-approve advertises while a review is open and resolves it with compact', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const socket = (await statusOf(run, mission)).ctl!.socket;
	// Without the API the op stays hidden and is rejected.
	expect((await statusOf(run, mission)).actions).toEqual([]);
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true })).error.code).toBe('rejected');
	// With the API but no open review it stays rejected too.
	const calls: Array<[string, string, { feedback?: string } | undefined]> = [];
	planReviewApi(run, calls);
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true })).error.code).toBe('rejected');
	await writePlan(run, mission, '# Plan\nDo it.\n');
	await run.event('plan_review_requested', { type: 'plan_review_requested', reviewId: 'r1' });
	const status = await statusOf(run, mission);
	expect(status.actions).toEqual(['plan-approve']);
	const revision = status.plan!.revision;
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision: 'deadbeefdead' } })).error.code).toBe('stale');
	expect(calls).toEqual([]);
	// A review routed through the API keeps plan-refine out of sendUserMessage.
	const sentBefore = run.sent.length;
	expect((await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'Tighter scope.' } })).ok).toBe(true);
	expect(run.sent.length).toBe(sentBefore);
	const ok = await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision } });
	expect(ok.ok).toBe(true);
	expect(ok.revision).toBe(mission.updatedAt);
	expect(calls).toEqual([
		['r1', 'refine', { feedback: 'Tighter scope.' }],
		['r1', 'compact', undefined],
	]);
	expect(calls.some(([, choice]) => choice === 'execute')).toBe(false);
	// When the review closes the op leaves the actions list and is rejected again.
	await run.event('plan_review_resolved', { type: 'plan_review_resolved', reviewId: 'r1' });
	expect((await statusOf(run, mission)).actions).toEqual([]);
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision } })).error.code).toBe('rejected');
	await run.event('session_shutdown', {});
});

test('plan-approve stays hidden and rejected on an OMP without the plan-review API', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const socket = (await statusOf(run, mission)).ctl!.socket;
	// A tracked review alone does not advertise: without resolvePlanReview the op is not advertised and is rejected.
	await run.event('plan_review_requested', { type: 'plan_review_requested', reviewId: 'r1' });
	expect((await statusOf(run, mission)).actions).toEqual([]);
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision: 'anything' } })).error.code).toBe('rejected');
	await run.event('session_shutdown', {});
});

test('plan-approve picks up a review that opened before the handlers saw it', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const socket = (await statusOf(run, mission)).ctl!.socket;
	// The review opened before this session bound its events; getPendingPlanReview still reports it.
	const calls: Array<[string, string, { feedback?: string } | undefined]> = [];
	planReviewApi(run, calls, { reviewId: 'restored' });
	await run.event('auto_compaction_end', {}); // republish so the status file sees the API
	expect((await statusOf(run, mission)).actions).toEqual(['plan-approve']);
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true })).ok).toBe(true);
	expect(calls).toEqual([['restored', 'compact', undefined]]);
	await run.event('session_shutdown', {});
});
