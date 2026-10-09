import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import missionExtension from '../src/extension';
import { listMissions, missionPath, saveMission } from '../src/store';
import { buildContactStatus, gateTokenId, autostartMessage, envBase, envCheckout, envDelivery, envGraph, type ContactStatus } from '../src/holotable';
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
async function session(options: { plan?: boolean; child?: boolean; autostart?: string; mission?: Mission } = {}) {
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
	];
	const context = {
		agent: { kind: 'main' }, cwd, hasUI: false,
		sessionManager: { getBranch: () => branch, getSessionName: () => undefined },
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
		owned: true, selected: undefined, operation: false, ctl: null, ...over,
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
