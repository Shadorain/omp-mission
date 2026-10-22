import { afterEach, expect, setSystemTime, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { appendFile, lstat, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createConnection } from 'node:net';
import { resolveLocalUrlToPath } from '@oh-my-pi/pi-coding-agent/internal-urls/local-protocol';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import missionExtension from '../src/extension';
import { listMissions, loadMission, missionPath, saveMission } from '../src/store';
import {
	buildContactStatus,
	gateTokenId,
	autostartMessage,
	envBase,
	envCheckout,
	envDelivery,
	envGraph,
	planRevision,
	sumAssistantUsage,
	UsageProbe,
	missionReport,
	type ContactStatus,
} from '../src/holotable';
import { planSlug } from '../src/prompts';
import type { Bead, Finding, Mission, Snapshot } from '../src/types';
import { QUOTA_BLOCKER } from '../src/controller';
import { captureRevision } from '../src/review';

type Handler = (event: unknown, context: ExtensionContext) => Promise<any>;
const roots: string[] = [];
const envKeys = [
	'PI_CODING_AGENT_DIR',
	'OMP_HOLOTABLE_CHILD',
	'OMP_MISSION_AUTOSTART',
	'OMP_MISSION_DELIVERY',
	'OMP_MISSION_BASE',
] as const;
const savedEnv = new Map<string, string | undefined>();
function setEnv(key: (typeof envKeys)[number], value: string | undefined) {
	if (!savedEnv.has(key)) savedEnv.set(key, process.env[key]);
	if (value === undefined) delete process.env[key];
	else process.env[key] = value;
}
afterEach(async () => {
	for (const [key, value] of savedEnv) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	savedEnv.clear();
	await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function baseMission(cwd: string, over: Partial<Mission> = {}): Mission {
	return {
		version: 1,
		id: 'smoke-run',
		graph: 'local',
		round: 1,
		mode: 'auto',
		keep: false,
		reviewRequested: false,
		phase: 'execute',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:00:00Z',
		source: { kind: 'freeform', id: 'smoke', title: 'Smoke', body: '', comments: '', extra: '' },
		workspace: { key: 'workspace', cwd, delivery: 'local' },
		scopes: {},
		evidence: {},
		workers: [],
		reviews: [],
		repairLinks: {},
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
	conn.on('data', chunk => {
		data += chunk;
	});
	conn.on('end', () => {
		try {
			resolve(JSON.parse(data.trim()));
		} catch (error) {
			reject(error);
		}
	});
	conn.on('error', reject);
	return promise;
}
let sessionSeq = 0;

// Real extension, real store; pi.exec/UI faked as in autostart.test.ts.
async function session(
	options: {
		plan?: boolean;
		child?: boolean;
		autostart?: string;
		mission?: Mission;
		models?: Array<{ provider: string; id: string }>;
		entries?: Array<Record<string, unknown>>;
		root?: string;
		beforeLoad?: (root: string) => Promise<void> | void;
		git?: boolean;
	} = {},
) {
	const root = options.root ?? (await realpath(await mkdtemp(join(tmpdir(), 'holotable-'))));
	if (!options.root) roots.push(root);
	const cwd = join(root, 'workspace');
	await mkdir(cwd, { recursive: true });
	if (options.git) {
		for (const args of [
			['init', '-q', '-b', 'main'],
			['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '--allow-empty', '-m', 'base'],
		])
			await Bun.spawn(['git', ...args], { cwd, stdout: 'ignore', stderr: 'ignore' }).exited;
	}
	await writeFile(join(root, 'mission.json'), JSON.stringify({ version: 1, graph: 'beads', frontend: 'orca' }));
	let path: string | undefined;
	if (options.mission) {
		path = missionPath(root, options.mission);
		await saveMission(path, options.mission);
	}
	const events = new Map<string, Handler>();
	// Same-pid test sessions need distinct ids or publish suppression cannot tell panes apart.
	const sessionTag = `test-session-${++sessionSeq}`;
	const sent: string[] = [];
	const notices: string[] = [];
	let command: ((args: string, context: ExtensionContext) => Promise<void>) | undefined;
	let active: string[] = [];
	let poll: (() => Promise<void>) | undefined;
	const branch: Array<Record<string, unknown>> = [
		...(path ? [{ type: 'custom', customType: 'mission:pointer', data: { path } }] : []),
		...(options.plan ? [{ type: 'mode_change', mode: 'plan' }] : []),
		...(options.entries ?? []),
	];
	const context = {
		agent: { kind: 'main' },
		cwd,
		hasUI: false,
		modelRegistry: { getAvailable: () => options.models ?? [] },
		sessionManager: {
			getBranch: () => branch,
			getEntries: () => branch,
			getSessionName: () => undefined,
			getSessionFile: () => join(root, 'coordinator.jsonl'),
			getSessionId: () => sessionTag,
		},
		localProtocolOptions: { getArtifactsDir: () => join(root, 'artifacts'), getSessionId: () => 'test-session' },
		ui: {
			notify: (message: string) => {
				notices.push(message);
			},
			setWidget: () => {},
			// Like the pane's dialog: it settles only when answered locally or aborted.
			askDialog: (_questions: unknown, options?: { signal?: AbortSignal }) =>
				new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve(undefined))),
			approve: (_prompt: unknown, options?: { signal?: AbortSignal }) =>
				new Promise(resolve => options?.signal?.addEventListener('abort', () => resolve('deny'))),
		},
		isIdle: () => true,
		hasPendingMessages: () => false,
		setInterval: (callback: () => Promise<void>) => {
			poll = callback;
			return 1;
		},
		clearTimer: () => {},
		setTimeout: () => 1,
	} as unknown as ExtensionContext;
	const api = {
		pi: { VERSION: '18.12.5' },
		registerTool: () => {},
		registerShortcut: () => {},
		registerCommand: (_name: string, spec: { handler: typeof command }) => {
			command = spec.handler;
		},
		on: (name: string, handler: Handler) => events.set(name, handler),
		events: { on: () => {} },
		getActiveTools: () => active,
		setActiveTools: async (names: string[]) => {
			active = names;
		},
		appendEntry: (customType: string, data: unknown) => {
			branch.push({ type: 'custom', customType, data });
		},
		sendUserMessage: (message: string) => {
			sent.push(message);
		},
		sendMessage: async () => {},
		setSessionName: async () => {},
		setModel: async (model: ExtensionContext['model']) => {
			Object.assign(context, { model });
			return true;
		},
		exec: async (name: string, args: string[], opts?: { cwd?: string }) => {
			if (name === 'git' && options.git) {
				const proc = Bun.spawn(['git', ...args], { cwd: opts?.cwd ?? cwd, stdout: 'pipe', stderr: 'pipe' });
				return {
					code: await proc.exited,
					stdout: await new Response(proc.stdout).text(),
					stderr: await new Response(proc.stderr).text(),
				};
			}
			if (name === 'git') return { code: 128, stdout: '', stderr: 'not a git repository' };
			if (name === 'lin')
				return {
					code: 0,
					stdout: JSON.stringify({
						issue: { identifier: 'CHR-123', title: 'Startup', description: '', comments: { nodes: [] } },
					}),
					stderr: '',
				};
			const bd = name === 'env' ? args.indexOf('bd') : name === 'bd' ? 0 : -1;
			if (bd >= 0 && args.includes('where'))
				return { code: 0, stdout: JSON.stringify({ path: join(root, 'beads') }), stderr: '' };
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
		root,
		cwd,
		events,
		context,
		sent,
		notices,
		branch,
		command: (args: string) => command!(args, context),
		pending: () =>
			branch.find(entry => entry.type === 'custom' && entry.customType === 'mission:pending')?.data as
				| Mission
				| undefined,
		event: (name: string, event: unknown) => events.get(name)!(event, context),
		poll: () => poll?.(),
	};
}

test('a board-launched local-graph mission plans with the delivery its launch named', async () => {
	// A conflict mission runs in a git checkout on the local graph: nothing re-binds it, so the launch's
	// delivery must hold from the start, or record_delivery later demands a PR it was told not to open.
	const run = await session({
		plan: true,
		child: true,
		git: true,
		autostart: '/mission -- Resolve the conflict markers',
		beforeLoad: () => {
			setEnv('OMP_MISSION_DELIVERY', 'local');
			setEnv('OMP_MISSION_BASE', 'main');
		},
	});
	try {
		for (let i = 0; i < 50 && !run.pending(); i++) await Bun.sleep(10);
		expect(run.pending()?.workspace.delivery).toBe('local');
	} finally {
		await run.event('session_shutdown', {});
	}
});

function socketName(missionId: string): string {
	return `${createHash('sha256').update(missionId).digest('hex').slice(0, 12)}-${process.pid}.sock`;
}

test('only an evidence-backed escalation parks review and Continue cannot release it', async () => {
	const mission = baseMission('/tmp', { phase: 'review', reviewRequested: true });
	const { revision } = await captureRevision(mission, async () => {
		throw new Error('Unexpected command');
	});
	mission.evidence.verify = { outcome: 'passed', revision, detail: 'Verified output', at: 'now' };
	mission.evidence.deliver = { ...mission.evidence.verify, detail: 'Delivered output' };
	mission.reviews = [
		{
			round: 1,
			revision,
			model: 'independent',
			at: 'now',
			summary: 'Defect',
			findings: [
				{
					id: 'f',
					severity: 'high',
					path: 'task.ts',
					line: 1,
					title: 'Unresolved defect',
					body: 'A consumer workflow fails',
					triage: { disposition: 'escalate', detail: 'task.ts:1 confirmed defect survives prior repair attempts' },
				},
			],
		},
	];
	const run = await session({ mission, child: true });
	try {
		const status = await statusOf(run, mission);
		expect(status.hold).toBe('resume');
		expect(status.problem?.source).toBe('triage');
		const socket = status.ctl!.socket;
		expect((await ctl(socket, { v: 1, op: 'continue', operator: true })).ok).toBe(true);
		const continued = await statusOf(run, mission);
		expect(continued.hold).toBe('blocked');
		expect(continued.actions).toContain('review');
		expect(run.sent).toEqual([]);
		expect((await ctl(socket, { v: 1, op: 'review' })).ok).toBe(false);
		expect((await ctl(socket, { v: 1, op: 'review', operator: true, args: { repairBudgetOnly: true } })).ok).toBe(
			false,
		);
		expect((await ctl(socket, { v: 1, op: 'review', operator: true })).ok).toBe(true);
		const saved = (await listMissions(run.root))[0]!.mission;
		expect(saved.reviews[0]!.findings[0]!.triage).toMatchObject({
			disposition: 'repair',
			detail: expect.stringContaining('Operator authorized'),
		});
		expect(saved.reviews[0]!.findings[0]!.rejection).toBeUndefined();
		expect((await statusOf(run, mission)).hold).toBe('none');
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('untriaged findings wake the coordinator and do not appear as a blocked review', async () => {
	const mission = baseMission('/tmp', { phase: 'review', reviewRequested: true });
	const { revision } = await captureRevision(mission, async () => {
		throw new Error('Unexpected command');
	});
	mission.evidence.verify = { outcome: 'passed', revision, detail: 'Verified output', at: 'now' };
	mission.evidence.deliver = { ...mission.evidence.verify, detail: 'Delivered output' };
	mission.reviews = [
		{
			round: 1,
			revision,
			model: 'independent',
			at: 'now',
			summary: 'Defect',
			findings: [
				{
					id: 'f',
					severity: 'high',
					path: 'task.ts',
					line: 1,
					title: 'Payment defect',
					body: 'A consumer workflow fails',
				},
			],
		},
	];
	const run = await session({ mission, child: true });
	try {
		const initial = await statusOf(run, mission);
		expect((await ctl(initial.ctl!.socket, { v: 1, op: 'continue', operator: true })).ok).toBe(true);
		const status = await statusOf(run, mission);
		expect(status.hold).toBe('none');
		expect(status.problem).toBeNull();
		expect(status.actions).not.toContain('review');
		expect(run.sent.at(-1)).toContain('Next: triage');
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('the poll wakes a local-graph mission the way it wakes a beads one', async () => {
	// A timed review retry has no event to ride on: only the poll notices retryAt has passed. Local-graph
	// missions (board conflict missions) have no epic, and the poll used to skip them entirely.
	const mission = baseMission('/tmp', { phase: 'review', reviewRequested: true });
	const { revision } = await captureRevision(mission, async () => {
		throw new Error('Unexpected command');
	});
	mission.evidence.verify = { outcome: 'passed', revision, detail: 'Verified output', at: 'now' };
	mission.evidence.deliver = { ...mission.evidence.verify, detail: 'Delivered output' };
	mission.reviews = [
		{
			round: 1,
			revision,
			model: 'independent',
			at: 'now',
			summary: 'Defect',
			findings: [
				{
					id: 'f',
					severity: 'high',
					path: 'task.ts',
					line: 1,
					title: 'Payment defect',
					body: 'A consumer workflow fails',
				},
			],
		},
	];
	const run = await session({ mission, child: true });
	try {
		let pending = true;
		Object.assign(run.context, { hasPendingMessages: () => pending });
		expect((await ctl((await statusOf(run, mission)).ctl!.socket, { v: 1, op: 'continue', operator: true })).ok).toBe(
			true,
		);
		expect(run.sent).toEqual([]);
		pending = false;
		setSystemTime(new Date(Date.now() + 60_000));
		await run.poll();
		for (let i = 0; i < 50 && !run.sent.length; i++) await Bun.sleep(10);
		expect(run.sent.join('\n')).toContain('Next: triage');
	} finally {
		setSystemTime();
		await run.event('session_shutdown', {});
	}
});

test('pending questions replace plan approval until the matching tool finishes', async () => {
	const run = await session({ plan: true, child: true, autostart: 'CHR-123' });
	try {
		const pending = run.pending()!;
		let approvals = 0;
		run.context.getPendingPlanReview = () => ({ reviewId: 'review', options: [] }) as any;
		run.context.resolvePlanReview = () => {
			approvals++;
			return true;
		};
		await run.event('tool_execution_start', {
			toolName: 'ask',
			toolCallId: 'question',
			args: { questions: [{ question: 'Where should the parent hub live?' }] },
		});
		const waiting = await statusOf(run, pending);
		expect(waiting.hold).toBe('question');
		expect(waiting.next).toContain('Where should the parent hub live?');
		expect(waiting.actions).toEqual([]);
		expect((await ctl(waiting.ctl!.socket, { v: 1, op: 'plan-approve', operator: true })).ok).toBe(false);
		expect(approvals).toBe(0);
		await run.event('tool_execution_end', { toolName: 'read', toolCallId: 'other', result: {} });
		expect((await statusOf(run, pending)).hold).toBe('question');
		await run.event('tool_execution_end', { toolName: 'ask', toolCallId: 'question', result: {} });
		expect((await statusOf(run, pending)).hold).toBe('plan-approval');
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('the board answers an open ask through the socket while every other op still waits on the question', async () => {
	const run = await session({ plan: true, child: true, autostart: 'CHR-123' });
	try {
		const pending = run.pending()!;
		const args = {
			questions: [
				{
					id: 'hub',
					question: 'Where should the parent hub live?',
					options: [{ label: 'Here' }, { label: 'There' }],
					recommended: 1,
				},
			],
		};
		await run.event('tool_execution_start', { toolName: 'ask', toolCallId: 'q1', args });
		// The ask tool opens the dialog through the same UI object the extension wrapped.
		const shown = run.context.ui.askDialog!(args.questions, {});
		for (let i = 0; i < 100 && !(await statusOf(run, pending)).ask; i++) await Bun.sleep(5);
		const open = await statusOf(run, pending);
		expect(open.ask).toEqual({
			id: 'q1',
			questions: [
				{ question: 'Where should the parent hub live?', options: ['Here', 'There'], recommended: 1, multi: false },
			],
		});
		expect(open.actions).toEqual(['answer']);
		const socket = open.ctl!.socket;
		expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true })).error.code).toBe('question-waiting');
		expect(
			(await ctl(socket, { v: 1, op: 'answer', operator: true, args: { id: 'q0', answers: [{ option: 0 }] } })).error
				.code,
		).toBe('stale');
		expect(
			(await ctl(socket, { v: 1, op: 'answer', operator: true, args: { id: 'q1', answers: [{ option: 9 }] } })).error
				.code,
		).toBe('rejected');
		expect(
			await ctl(socket, { v: 1, op: 'answer', operator: true, args: { id: 'q1', answers: [{ option: 0 }] } }),
		).toMatchObject({ ok: true });
		expect(await shown).toMatchObject({ kind: 'submit', results: [{ id: 'hub', selectedOptions: ['Here'] }] });
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('the board answers an open tool approval through the socket while every other op waits on it', async () => {
	const run = await session({ plan: true, child: true, autostart: 'CHR-123' });
	try {
		const pending = run.pending()!;
		// OMP's tool wrapper reads ui.approve from the same UI object at call time.
		const approve = (run.context.ui as unknown as { approve(prompt: unknown): Promise<unknown> }).approve;
		const shown = approve({
			full: 'Allow tool: bash\nCommand: rm -rf build',
			compact: 'Allow tool: bash\nCommand: rm -rf build',
			session: 'Approve bash for this session',
		});
		for (let i = 0; i < 100 && !(await statusOf(run, pending)).approval; i++) await Bun.sleep(5);
		const open = await statusOf(run, pending);
		expect(open.hold).toBe('question');
		expect(open.next).toBe('Answer in mission: Allow tool: bash Command: rm -rf build');
		expect(open.approval).toMatchObject({
			tool: 'bash',
			options: ['Approve', 'Approve bash for this session', 'Deny'],
		});
		expect(open.actions).toEqual(['permit']);
		const socket = open.ctl!.socket;
		const id = open.approval!.id;
		expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true })).error.code).toBe('question-waiting');
		expect(
			(await ctl(socket, { v: 1, op: 'permit', operator: true, args: { id: 'old', answer: 'Approve' } })).error.code,
		).toBe('stale');
		expect((await ctl(socket, { v: 1, op: 'permit', operator: true, args: { id } })).error.code).toBe('bad-request');
		expect((await ctl(socket, { v: 1, op: 'permit', operator: true, args: { id, answer: 'Always' } })).error.code).toBe(
			'rejected',
		);
		expect(
			await ctl(socket, { v: 1, op: 'permit', operator: true, args: { id, answer: 'Approve bash for this session' } }),
		).toMatchObject({ ok: true });
		expect(await shown).toBe('session');
		for (let i = 0; i < 100 && (await statusOf(run, pending)).approval; i++) await Bun.sleep(5);
		const closed = await statusOf(run, pending);
		expect(closed.approval).toBeNull();
		expect(closed.hold).toBe('plan-approval');
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('planning rate limits replace plan approval and clear when a new turn starts', async () => {
	const run = await session({ plan: true, child: true, autostart: 'CHR-123' });
	try {
		const pending = run.pending()!;
		await run.event('agent_end', {
			willContinue: false,
			messages: [
				{ role: 'assistant', stopReason: 'error', errorMessage: '429 rate_limit_error: Please try again later' },
			],
		});
		const stopped = await statusOf(run, pending);
		expect(stopped.hold).toBe('blocked');
		expect(stopped.problem?.kind).toBe('rate-limit');
		expect(stopped.next).toContain('rate limit');
		expect(stopped.actions).toEqual([]);
		await run.event('turn_start', {});
		const resumed = await statusOf(run, pending);
		expect(resumed.hold).toBe('plan-approval');
		expect(resumed.problem).toBeNull();
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('the status reports the coordinator mid-turn until its turn ends with nothing scheduled', async () => {
	// A coordinator that ends its turn asking a plain-text question sits idle in its pane: the board must see that.
	const mission = baseMission('/tmp');
	const run = await session({ mission, child: true });
	try {
		expect((await statusOf(run, mission)).coordinator).toBeNull();
		await run.event('agent_start', {});
		const working = (await statusOf(run, mission)).coordinator!;
		expect(working.state).toBe('working');
		await run.event('agent_end', { willContinue: true, messages: [] });
		expect((await statusOf(run, mission)).coordinator).toEqual(working);
		let queued = true;
		Object.assign(run.context, { hasPendingMessages: () => queued });
		await run.event('agent_end', { willContinue: false, messages: [] });
		expect((await statusOf(run, mission)).coordinator).toEqual(working);
		queued = false;
		setSystemTime(new Date(Date.parse(working.since) + 60_000));
		await run.event('agent_end', { willContinue: false, messages: [] });
		expect((await statusOf(run, mission)).coordinator).toEqual({
			state: 'idle',
			since: new Date(Date.parse(working.since) + 60_000).toISOString(),
		});
		await run.event('agent_start', {});
		expect((await statusOf(run, mission)).coordinator?.state).toBe('working');
	} finally {
		setSystemTime();
		await run.event('session_shutdown', {});
	}
});

test('the status builder maps each hold state and the C5 field list', async () => {
	const cwd = '/tmp';
	const input = (mission: Mission, over: Partial<Parameters<typeof buildContactStatus>[0]> = {}) =>
		buildContactStatus({
			mission,
			pending: false,
			resumeHold: false,
			snapshot: undefined,
			policy: idlePolicy,
			step: undefined,
			owned: true,
			selected: undefined,
			operation: false,
			ctl: null,
			usage: null,
			...over,
		});

	const pending = await input(baseMission(cwd), {
		pending: true,
		resumeHold: true,
		step: { text: 'Approve the plan' },
	});
	expect(pending.hold).toBe('plan-approval');
	expect(pending.actions).toEqual([]);
	expect(pending.progress).toEqual({ step: 3, of: 9 });

	const held = await input(baseMission(cwd), {
		resumeHold: true,
		step: { command: '/mission continue', text: 'Take control of this resumed mission' },
	});
	expect(held.hold).toBe('resume');
	expect(held.next).toBe('/mission continue — Take control of this resumed mission');

	const completed = await input(baseMission(cwd, { phase: 'complete' }), {
		resumeHold: true,
		policy: { ...idlePolicy, resumeHold: true },
	});
	expect(completed.complete).toBe(true);
	expect(completed.hold).toBe('none');
	expect(completed.actions).not.toContain('continue');

	const gated = await input(
		baseMission(cwd, { gate: { kind: 'wave', token: 'tok', detail: 'wave', approved: false } }),
		{ step: { command: '/mission approve', text: 'wave' }, ctl: { socket: '/tmp/x.sock', generation: 7 } },
	);
	expect(gated.hold).toBe('gate');
	expect(gated.gate).toEqual({ kind: 'wave', id: gateTokenId('tok') });
	expect(gated.ctl).toEqual({ socket: '/tmp/x.sock', generation: 7 });

	const blocked = await input(baseMission(cwd, { blocker: 'Upstream stalled' }));
	expect(blocked.hold).toBe('blocked');

	const graphError = 'Dolt server unreachable at 127.0.0.1:38581';
	const outage = {
		beads: [],
		leaves: [],
		ready: [],
		closed: 0,
		active: 0,
		blocked: 0,
		fetchedAt: 0,
		error: graphError,
	};
	const beadsMission = baseMission(cwd, { graph: 'beads', epicId: 'epic' });
	const graphDown = await input(beadsMission, { snapshot: outage, step: { text: graphError } });
	expect(graphDown.hold).toBe('blocked');
	expect(graphDown.next).toBe(graphError);
	expect((await input(baseMission(cwd), { snapshot: outage })).hold).toBe('none');
	expect((await input(beadsMission, { snapshot: { ...outage, error: undefined, fetchedAt: 1 } })).hold).toBe('none');

	const quota = await input(
		baseMission(cwd, {
			phase: 'review',
			evidence: { review: { outcome: 'failed', detail: 'Reviewer quota exhausted on provider', at: 'now' } },
		}),
	);
	expect(quota.hold).toBe('quota');
	expect(quota.complete).toBe(false);

	const delivered = {
		verify: { outcome: 'passed' as const, detail: 'ok', revision: 'rev', at: 'now' },
		deliver: { outcome: 'passed' as const, detail: 'local', at: 'now' },
	};
	const credits = await input(
		baseMission(cwd, {
			phase: 'review',
			reviewRequested: true,
			evidence: {
				...delivered,
				review: { outcome: 'failed', detail: '403 You have run out of credits', revision: 'rev', at: 'now' },
			},
		}),
	);
	expect(credits.hold).toBe('quota');
	expect(credits.actions).toContain('review');
	expect(credits.complete).toBe(false);

	const throttled = {
		outcome: 'failed' as const,
		detail: 'status 429 Too Many Requests',
		revision: 'rev',
		at: new Date().toISOString(),
	};
	const rate = await input(
		baseMission(cwd, { phase: 'review', reviewRequested: true, evidence: { ...delivered, review: throttled } }),
	);
	expect(rate.hold).toBe('none');
	// The extension reruns a throttled review by itself, so the board does not ask for it.
	expect(rate.actions).not.toContain('review');
	const spent = await input(
		baseMission(cwd, {
			phase: 'review',
			reviewRequested: true,
			evidence: { ...delivered, review: { ...throttled, attempts: 4 } },
		}),
	);
	expect(spent.actions).toContain('review');
	expect(rate.problem?.kind).toBe('rate-limit');
	expect(rate.problem?.retryAt).not.toBeNull();
	expect(spent.problem?.retryAt).toBeNull();
	expect(credits.problem).toMatchObject({ kind: 'quota', source: 'review', retryAt: null });
	expect(credits.problem?.detail).toContain('run out of credits');

	const workerQuota = await input(
		baseMission(cwd, {
			workers: [
				{ beadId: 'b1', attempt: 'a', cwd, files: [], state: 'running', assignment: '', error: 'usage limit reached' },
			],
		}),
	);
	expect(workerQuota.hold).toBe('quota');
	expect(workerQuota.complete).toBe(false);

	const parked = baseMission(cwd, {
		blocker: 'Provider quota exhausted. Restore quota or change the model, then /mission continue',
	});
	const resumedQuota = await input(parked, { resumeHold: true, pending: true, step: { text: 'Approve the plan' } });
	expect(resumedQuota.hold).toBe('quota');
	expect(parked.phase).toBe('execute');

	const plain = await input(
		baseMission(cwd, {
			workspace: { key: 'k', cwd, delivery: 'pr', branch: 'feat', base: 'main' },
			workers: [
				{ beadId: 'b1', attempt: 'a', cwd, files: [], state: 'running', assignment: '' },
				{ beadId: 'b2', attempt: 'a', cwd, files: [], state: 'closed', assignment: '' },
			],
		}),
	);
	expect(plain.hold).toBe('none');
	expect(plain.workers).toEqual({ live: 1, total: 2 });
	expect(plain.delivery).toEqual({ url: null, branch: 'feat' });
	expect(plain.base).toBe('main');
	expect(plain.complete).toBe(false);
});

test('closed implementation leaves report verification, while local work and unreadable graphs do not', async () => {
	const m = baseMission('/tmp', { graph: 'beads', epicId: 'E' });
	const leaf = { id: 'L', title: 'L', status: 'closed', category: 'closed' as const, children: [], ready: false };
	const snapshot = {
		beads: [leaf],
		leaves: [leaf],
		ready: [],
		closed: 1,
		active: 0,
		blocked: 0,
		fetchedAt: Date.now(),
	};
	const input = {
		mission: m,
		pending: false,
		resumeHold: false,
		snapshot,
		policy: idlePolicy,
		step: undefined,
		owned: true,
		selected: undefined,
		operation: false,
		ctl: null,
		usage: null,
	};
	expect((await buildContactStatus(input)).phase).toBe('verify');
	expect((await buildContactStatus({ ...input, mission: baseMission('/tmp'), snapshot: undefined })).phase).toBe(
		'execute',
	);
	expect((await buildContactStatus({ ...input, snapshot: { ...snapshot, error: 'Graph unavailable' } })).hold).toBe(
		'blocked',
	);
});

// OMP session entries: {type:'message', message:{role:'assistant', usage:{input,output,cacheRead,cacheWrite,cost:{total}}}}
// (SessionMessageEntry/AssistantMessage/Usage in @oh-my-pi). Anything else in the stream is ignored.
function usageEntry(input: number, output: number, total?: number) {
	return {
		type: 'message',
		message: {
			role: 'assistant',
			usage: {
				input,
				output,
				cacheRead: 4,
				cacheWrite: 2,
				totalTokens: input + output + 6,
				...(total === undefined ? {} : { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } }),
			},
		},
	};
}

test('usage sums assistant message usage and tolerates foreign and partial records', () => {
	expect(sumAssistantUsage([])).toBeNull();
	expect(
		sumAssistantUsage([
			{ type: 'mode_change', mode: 'plan' },
			{ type: 'message', message: { role: 'user' } },
			{ type: 'message', message: { role: 'assistant' } },
		]),
	).toBeNull();
	const totals = sumAssistantUsage([
		usageEntry(100, 10, 0.5),
		usageEntry(200, 20),
		{ type: 'model_usage', usage: { input: 9, output: 9 } },
		'junk',
		null,
	]);
	expect(totals).toEqual({
		tokens: { input: 300, output: 30, cacheRead: 8, cacheWrite: 4 },
		costUsd: 0.5,
		sessions: 1,
	});
});

test('usage isolates mission-owned workers, includes independent reviews and deduplicates lazy snapshots', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'holotable-usage-')));
	roots.push(root);
	const mission = baseMission(root),
		other = baseMission(root, { id: 'second-run' });
	const workerDir = join(root, 'missions', mission.workspace.key, 'workers'),
		workerFile = join(workerDir, 'b1.jsonl');
	const reviewDir = join(root, 'missions', mission.workspace.key, 'reviews', mission.id);
	await mkdir(workerDir, { recursive: true });
	await mkdir(reviewDir, { recursive: true });
	mission.workers.push({
		beadId: 'b1',
		attempt: '1',
		cwd: root,
		files: [],
		state: 'closed',
		assignment: 'test',
		frontend: 'subagent',
		incarnationId: workerFile,
	});
	await writeFile(workerFile, `${JSON.stringify(usageEntry(100, 10, 0.5))}\n{"type":"message","mes`);
	await writeFile(join(workerDir, 'foreign.jsonl'), `${JSON.stringify(usageEntry(900, 900, 9))}\n`);
	await writeFile(join(reviewDir, 'failed-review.jsonl'), `${JSON.stringify(usageEntry(20, 2, 0.2))}\n`);
	let now = 1_000;
	const probe = new UsageProbe(root, () => now);
	const coordinator = () => ({ sessionFile: '/private/coordinator.jsonl', entries: [usageEntry(50, 5, 0.25)] });
	const first = await probe.measure(mission, coordinator);
	expect(first.usage).toEqual({
		tokens: { input: 170, output: 17, cacheRead: 12, cacheWrite: 6 },
		costUsd: 0.95,
		sessions: 3,
	});
	expect(first.evidence.sources.map(s => s.role)).toEqual(['coordinator', 'worker', 'review']);
	expect(JSON.stringify(first.evidence)).not.toContain('/private/');
	expect(first.evidence.backlogBytes).toBeGreaterThan(0);
	await appendFile(workerFile, `sage":{}}\n${JSON.stringify(usageEntry(10, 1, 0.1))}\n`);
	expect(
		await probe.measure(mission, () => {
			throw Error('must be lazy');
		}),
	).toBe(first);
	now += 40_000;
	const second = await probe.measure(mission, coordinator);
	expect(second.usage?.tokens.input).toBe(180);
	expect(second.evidence.backlogBytes).toBe(0);
	expect(
		(await probe.measure(other, () => ({ sessionFile: '/another.jsonl', entries: [usageEntry(7, 7)] }))).usage?.tokens
			.input,
	).toBe(7);
	expect((await probe.measure(mission, coordinator)).usage?.tokens.input).toBe(180);
	await rm(workerFile);
	now += 40_000;
	const deleted = await probe.measure(mission, coordinator);
	expect(deleted.usage?.tokens.input).toBe(180);
	expect(deleted.evidence.missing).toBe(1);
	expect((await new UsageProbe(root, () => now).measure(mission, coordinator)).usage?.tokens.input).toBe(70);
});

test('usage reads bounded deltas, preserves split UTF8 and counts completed lines exactly once', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'holotable-usage-')));
	roots.push(root);
	const mission = baseMission(root),
		dir = join(root, 'missions', mission.workspace.key, 'workers'),
		path = join(dir, 'worker.jsonl');
	await mkdir(dir, { recursive: true });
	mission.workers.push({
		beadId: 'b',
		attempt: 'a',
		cwd: root,
		files: [],
		state: 'running',
		assignment: 'test',
		frontend: 'subagent',
		incarnationId: path,
	});
	const record = { ...usageEntry(3, 4, 0), text: 'é'.repeat(35_000) },
		text = JSON.stringify(record);
	await writeFile(path, text);
	const probe = new UsageProbe(root, () => 1000),
		coordinator = () => ({ sessionFile: '/session', entries: [] });
	expect((await probe.measure(mission, coordinator)).usage).toBeNull();
	await appendFile(path, '\n');
	const complete = await probe.measure(mission, coordinator, true);
	expect(complete.usage?.tokens.input).toBe(3);
	expect(complete.evidence.backlogBytes).toBe(0);
	expect(complete.evidence.partial).toBe(false);
	expect(complete.evidence.sources[0]?.pricedMessages).toBe(1);
	expect((await probe.measure(mission, coordinator, true)).usage).toEqual(complete.usage);
	await appendFile(path, `x`.repeat(5 * 1024 * 1024) + `\n${JSON.stringify(usageEntry(8, 2, 0.1))}\n`);
	const reset = await probe.measure(mission, coordinator, true);
	expect(reset.evidence.resets).toBe(0);
	expect(reset.evidence.backlogBytes).toBeGreaterThan(1024 * 1024);
	const caught = await probe.measure(mission, coordinator, true);
	expect(caught.usage?.tokens.input).toBe(11);
	expect(caught.evidence.backlogBytes).toBe(0);
	expect(caught.evidence.malformedLines).toBe(1);
	await writeFile(path, `${JSON.stringify(usageEntry(1, 2, 0.1))}\n`);
	const shrunk = await probe.measure(mission, coordinator, true);
	expect(shrunk.usage?.tokens.input).toBe(1);
	expect(shrunk.evidence.resets).toBe(1);
	await rm(path);
	await writeFile(path, `${JSON.stringify(usageEntry(9, 2, 0.1))}\n`);
	const replaced = await probe.measure(mission, coordinator, true);
	expect(replaced.usage?.tokens.input).toBe(9);
	expect(replaced.evidence.resets).toBe(2);
});

test('missing recorded reviewer transcripts stay partial even when other review files survive', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'holotable-review-coverage-')));
	roots.push(root);
	const mission = baseMission(root),
		dir = join(root, 'missions', mission.workspace.key, 'reviews', mission.id);
	await mkdir(dir, { recursive: true });
	const kept = join(dir, 'kept.jsonl'),
		missing = join(dir, 'missing.jsonl'),
		checkpoint = join(dir, 'checkpoint.jsonl');
	await writeFile(kept, `${JSON.stringify(usageEntry(10, 1, 0.1))}\n`);
	mission.reviews = [
		{
			round: 1,
			revision: 'old',
			model: 'test',
			summary: 'Done',
			findings: [],
			at: mission.createdAt,
			invalidated: 'changed',
			transcripts: { review: missing },
		},
		{
			round: 2,
			revision: 'new',
			model: 'test',
			summary: 'Done',
			findings: [],
			at: mission.createdAt,
			transcripts: { review: kept },
		},
	];
	mission.reviewProgress = {
		round: 3,
		revision: 'next',
		model: 'test',
		inputs: {},
		targets: { integration: { summary: 'Done', findings: [], transcript: checkpoint } },
		failures: {},
		at: mission.createdAt,
	};
	const probe = new UsageProbe(root, () => 1000),
		coordinator = () => ({ sessionFile: '/coordinator', entries: [] });
	const partial = await probe.measure(mission, coordinator);
	expect(partial.evidence).toMatchObject({ missing: 2, partial: true });
	expect(partial.usage?.tokens.input).toBe(10);
	await writeFile(missing, `${JSON.stringify(usageEntry(20, 2, 0.2))}\n`);
	await writeFile(checkpoint, `${JSON.stringify(usageEntry(30, 3, 0.3))}\n`);
	const recovered = await probe.measure(mission, coordinator, true);
	expect(recovered.evidence).toMatchObject({ missing: 0, partial: false });
	expect(recovered.usage?.tokens.input).toBe(60);
	expect(recovered.evidence.sources.find(source => source.role === 'review')?.sessions).toBe(3);
});

test('usage rejects escaped worker paths, reports unsupported workers and malformed or unpriced usage', async () => {
	const root = await realpath(await mkdtemp(join(tmpdir(), 'holotable-usage-')));
	roots.push(root);
	const mission = baseMission(root),
		dir = join(root, 'missions', mission.workspace.key, 'workers');
	await mkdir(dir, { recursive: true });
	const outside = join(root, 'outside.jsonl'),
		link = join(dir, 'escape.jsonl');
	await writeFile(outside, `${JSON.stringify(usageEntry(900, 9, 9))}\n`);
	await symlink(outside, link);
	for (const [attempt, frontend, incarnationId] of [
		['a', 'subagent', link],
		['b', 'none', undefined],
	] as const)
		mission.workers.push({
			beadId: attempt,
			attempt,
			cwd: root,
			files: [],
			state: 'closed',
			assignment: 'test',
			frontend,
			incarnationId,
		});
	const bad = { type: 'message', message: { role: 'assistant', usage: { input: -1, output: 9 } } };
	const result = await new UsageProbe(root, () => 1000).measure(mission, () => ({
		sessionFile: '/session',
		entries: [bad, usageEntry(2, 3)],
	}));
	expect(result.usage?.tokens.input).toBe(2);
	expect(result.usage?.costUsd).toBeNull();
	expect(result.evidence).toMatchObject({ missing: 1, unsupportedWorkers: 1, malformedLines: 1, partial: true });
	expect(result.evidence.sources[0]).toMatchObject({ pricedMessages: 0, unpricedMessages: 1 });
});

test('a resume hold over failed verification still says verification failed', async () => {
	const base = baseMission('/tmp');
	const failed = {
		...base,
		evidence: { ...base.evidence, verify: { outcome: 'failed' as const, detail: 'tests red', at: base.updatedAt } },
	};
	const status = await buildContactStatus({
		mission: failed,
		pending: false,
		resumeHold: true,
		snapshot: undefined,
		policy: idlePolicy,
		step: undefined,
		owned: true,
		selected: undefined,
		operation: false,
		ctl: null,
		usage: null,
	});
	// hold alone reads as an ordinary resume; verify is what tells a board not to continue it automatically.
	expect(status.hold).toBe('resume');
	expect(status.verify).toBe('failed');
	expect(
		(
			await buildContactStatus({
				mission: base,
				pending: false,
				resumeHold: true,
				snapshot: undefined,
				policy: idlePolicy,
				step: undefined,
				owned: true,
				selected: undefined,
				operation: false,
				ctl: null,
				usage: null,
			})
		).verify,
	).toBe(base.evidence.verify?.outcome ?? null);
});

test('the status file reports mission mode and estimated usage', async () => {
	const cwd = '/tmp';
	const status = await buildContactStatus({
		mission: baseMission(cwd, { mode: 'force' }),
		pending: false,
		resumeHold: false,
		snapshot: undefined,
		policy: idlePolicy,
		step: undefined,
		owned: true,
		selected: undefined,
		operation: false,
		ctl: null,
		usage: { tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 }, costUsd: 0.01, sessions: 2 },
	});
	expect(status.mode).toBe('force');
	expect(status.usage).toEqual({
		tokens: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
		costUsd: 0.01,
		sessions: 2,
	});

	// A pending plan reports the planned mode; nothing recorded means usage stays null.
	const planned = await session({ plan: true });
	await planned.command('--pause -- demo');
	expect((await statusOf(planned, planned.pending()!)).mode).toBe('pause');
	expect((await statusOf(planned, planned.pending()!)).usage).toBeNull();

	// A saved mission sums the coordinator session entries and the worker session files.
	const mission = baseMission('/tmp');
	const workerDir = `missions/${mission.workspace.key}/workers`;
	const run = await session({
		mission,
		entries: [usageEntry(50, 5, 0.25)],
		beforeLoad: async root => {
			await mkdir(join(root, workerDir), { recursive: true });
			await writeFile(join(root, workerDir, 'b1.jsonl'), `${JSON.stringify(usageEntry(100, 10, 0.5))}\n`);
			mission.workers.push({
				beadId: 'b1',
				attempt: 'a',
				cwd: root,
				files: [],
				state: 'closed',
				assignment: 'test',
				frontend: 'subagent',
				incarnationId: join(root, workerDir, 'b1.jsonl'),
			});
			await saveMission(missionPath(root, mission), mission);
		},
	});
	const published = await statusOf(run, mission);
	expect(published.mode).toBe('auto');
	expect(published.usage).toEqual({
		tokens: { input: 150, output: 15, cacheRead: 8, cacheWrite: 4 },
		costUsd: 0.75,
		sessions: 2,
	});
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
	const foreign = Bun.spawn(
		[
			process.execPath,
			'-e',
			`const c=require('node:net').createConnection(${JSON.stringify(socket)});let d='';c.on('connect',()=>c.write('{"v":1,"op":"ping"}\\n'));c.on('data',x=>{d+=x});c.on('end',()=>{process.stdout.write(d);process.exit(0)});`,
		],
		{ stdout: 'pipe' },
	);
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

test('a second pane of a saved mission stays read-only until the owner exits, then takes the socket', async () => {
	const cwd = join(await realpath(await mkdtemp(join(tmpdir(), 'holotable-shared-'))), 'workspace');
	roots.push(join(cwd, '..'));
	await mkdir(cwd, { recursive: true });
	const mission = baseMission(cwd);
	const a = await session({ mission, child: true });
	const live = await statusOf(a, mission);
	expect(live.ctl).not.toBeNull();
	expect(live.session?.owned).toBe(true);
	const b = await session({ mission, root: a.root });
	try {
		// The lock is held by A: B publishes nothing over a fresh owner file.
		const unchanged = await statusOf(a, mission);
		expect(unchanged.session?.owned).toBe(true);
		expect(unchanged.ctl?.socket).toBe(live.ctl!.socket);
		await a.event('session_shutdown', {});
		// The owner's final write retires authority; B's continue re-acquires and serves.
		await b.command('continue');
		const recovered = await statusOf(a, mission);
		expect(recovered.session?.owned).toBe(true);
		expect(recovered.session?.id).not.toBe(live.session?.id);
		expect(recovered.ctl).not.toBeNull();
		expect(await ctl(recovered.ctl!.socket, { v: 1, op: 'ping' })).toMatchObject({ ok: true });
	} finally {
		await b.event('session_shutdown', {});
	}
});

test('a revived owner without the child env serves once the board backfills the marker', async () => {
	const cwd = join(await realpath(await mkdtemp(join(tmpdir(), 'holotable-revived-'))), 'workspace');
	roots.push(join(cwd, '..'));
	await mkdir(cwd, { recursive: true });
	const mission = baseMission(cwd);
	// Revived pane: no OMP_HOLOTABLE_CHILD, no .ctl marker (mission predates it).
	const run = await session({ mission });
	const held = await statusOf(run, mission);
	expect(held.session?.owned).toBe(true);
	expect(held.ctl).toBeNull();
	await expect(
		ctl(join(tmpdir(), `omp-mission-ctl-${process.getuid!()}`, socketName(mission.id)), { v: 1, op: 'ping' }),
	).rejects.toThrow();
	// Board sighted the tracked status file and backfilled the marker: the owner serves.
	await writeFile(join(missionPath(run.root, mission), '..', 'status', `${mission.id}.ctl`), `${process.pid}\n`);
	await run.poll();
	const serving = await statusOf(run, mission);
	expect(serving.ctl).not.toBeNull();
	expect(await ctl(serving.ctl!.socket, { v: 1, op: 'ping' })).toMatchObject({ ok: true });
	await run.event('session_shutdown', {});
});

test('socket ops enforce the resume hold and the pause gate, and shutdown closes the socket', async () => {
	const mission = baseMission('/tmp', {
		mode: 'pause',
		reviewRequested: true,
		phase: 'review',
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
	expect((await ctl(socket, { v: 1, op: 'approve', operator: true, args: { gate: 'deadbeefdead' } })).error.code).toBe(
		'stale',
	);
	expect(await ctl(socket, { v: 1, op: 'approve', operator: true, args: { gate: armed.gate!.id } })).toMatchObject({
		ok: true,
	});
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
	const plan = resolveLocalUrlToPath(`local://${planSlug(mission.source)}-plan.md`, {
		getArtifactsDir: () => join(run.root, 'artifacts'),
		getSessionId: () => 'test-session',
	});
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
	expect(reply.plan).toEqual({
		text: '# Plan\nStep one.\n',
		path: plan,
		revision: planRevision('# Plan\nStep one.\n'),
	});
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
	expect(
		(await ctl(socket, { v: 1, op: 'plan-edit', operator: true, args: { text: 'v2\n', base: 'deadbeefdead' } })).error
			.code,
	).toBe('stale');
	expect(await Bun.file(plan).text()).toBe('v1\n');
	// Over the 256 KiB cap is a bad request.
	expect(
		(await ctl(socket, { v: 1, op: 'plan-edit', operator: true, args: { text: 'x'.repeat(256 * 1024 + 1) } })).error
			.code,
	).toBe('bad-request');
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
	expect((await ctl(otherSocket, { v: 1, op: 'plan-edit', operator: true, args: { text: 'x' } })).error.code).toBe(
		'rejected',
	);
	await run.event('session_shutdown', {});
	await other.event('session_shutdown', {});
});

test('plan-refine sends the message into the session and is rejected without a pending plan', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const socket = (await statusOf(run, mission)).ctl!.socket;
	const sentBefore = run.sent.length;
	expect(
		await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'Add a rollback step.' } }),
	).toMatchObject({ ok: true });
	expect(run.sent.length).toBe(sentBefore + 1);
	expect(run.sent.at(-1)).toBe('Add a rollback step.');
	expect((await ctl(socket, { v: 1, op: 'plan-refine', args: { message: 'x' } })).error.code).toBe('bad-request');
	expect((await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: '' } })).error.code).toBe(
		'bad-request',
	);
	// Outside a pending plan the op is rejected and sends nothing.
	const active = baseMission('/tmp', { phase: 'execute' });
	const other = await session({ child: true, mission: active });
	const otherSocket = (await statusOf(other, active)).ctl!.socket;
	expect(
		(await ctl(otherSocket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'hi' } })).error.code,
	).toBe('rejected');
	expect(other.sent.length).toBe(0);
	await run.event('session_shutdown', {});
	await other.event('session_shutdown', {});
});

// Older running OMP sessions can lack the native review API.
function planReviewApi(
	run: { context: ExtensionContext },
	calls: Array<[string, string, { feedback?: string } | undefined]>,
	pending?: { reviewId: string },
) {
	const api = run.context as unknown as Record<string, unknown>;
	api.resolvePlanReview = (reviewId: string, choice: string, input?: { feedback?: string }) => {
		calls.push([reviewId, choice, input]);
		return true;
	};
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
	expect(
		(await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision: 'deadbeefdead' } })).error.code,
	).toBe('stale');
	expect(calls).toEqual([]);
	// A review routed through the API keeps plan-refine out of sendUserMessage.
	const sentBefore = run.sent.length;
	expect((await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'Tighter scope.' } })).ok).toBe(
		true,
	);
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
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision } })).error.code).toBe(
		'rejected',
	);
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
	expect(
		(await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision: 'anything' } })).error.code,
	).toBe('rejected');
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

test('idle pending plans open native review once per revision, never while streaming', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const file = await writePlan(run, mission, '# Ready\nImplement it.\n');
	let idle = false;
	let opened = 0;
	run.context.isIdle = () => idle;
	run.context.openPlanReview = async () => {
		opened++;
		await run.event('plan_review_requested', {
			type: 'plan_review_requested',
			reviewId: `review-${opened}`,
			planFilePath: file,
			options: [{ id: 'compact', disabled: false }],
		});
		return true;
	};
	const calls: Array<[string, string, { feedback?: string } | undefined]> = [];
	planReviewApi(run, calls);
	await run.poll();
	expect(opened).toBe(0);
	idle = true;
	await run.poll();
	expect((await statusOf(run, mission)).actions).toContain('plan-approve');
	await run.event('plan_review_resolved', { type: 'plan_review_resolved', reviewId: 'review-1' });
	await run.poll();
	expect(opened).toBe(1);
	await run.event('session_shutdown', {});
});

test('native review path is authoritative and a closed refinement never queues a fallback prompt', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	await writePlan(run, mission, 'Old plan\n');
	const file = join(run.root, 'native-plan.md');
	await writeFile(file, 'Native plan\n');
	const calls: Array<[string, string, { feedback?: string } | undefined]> = [];
	planReviewApi(run, calls);
	await run.event('plan_review_requested', {
		type: 'plan_review_requested',
		reviewId: 'native',
		planFilePath: file,
		options: [{ id: 'compact', disabled: false }],
	});
	expect((await statusOf(run, mission)).plan?.path).toBe(file);
	const socket = (await statusOf(run, mission)).ctl!.socket;
	expect(
		(await ctl(socket, { v: 1, op: 'plan-approve', operator: true, args: { revision: planRevision('Old plan\n') } }))
			.error.code,
	).toBe('stale');
	run.context.resolvePlanReview = () => false;
	const before = run.sent.length;
	expect(
		(await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'Tighter scope' } })).error.code,
	).toBe('rejected');
	expect(run.sent.length).toBe(before);
	await run.event('session_shutdown', {});
});

test('native local plan URL resolves to the file edited and approved by the board', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	const file = await writePlan(run, mission, 'Reviewed plan\n');
	const calls: Array<[string, string, { feedback?: string } | undefined]> = [];
	planReviewApi(run, calls);
	await run.event('plan_review_requested', {
		type: 'plan_review_requested',
		reviewId: 'local-review',
		planFilePath: `local://${planSlug(mission.source)}-plan.md`,
		options: [{ id: 'compact', disabled: false }],
	});
	const status = await statusOf(run, mission);
	expect(status.plan).toEqual({ path: file, revision: planRevision('Reviewed plan\n') });
	const socket = status.ctl!.socket;
	expect(
		(
			await ctl(socket, {
				v: 1,
				op: 'plan-edit',
				operator: true,
				args: { base: status.plan!.revision, text: 'Edited native plan\n' },
			})
		).ok,
	).toBe(true);
	expect(await Bun.file(file).text()).toBe('Edited native plan\n');
	expect(
		(
			await ctl(socket, {
				v: 1,
				op: 'plan-approve',
				operator: true,
				args: { revision: planRevision('Edited native plan\n') },
			})
		).ok,
	).toBe(true);
	await run.event('session_shutdown', {});
});

test('disabled compact approval still permits native refinement without bypassing approval', async () => {
	const run = await session({ plan: true, child: true });
	await run.command('-- demo');
	const mission = run.pending()!;
	await writePlan(run, mission, 'Pending\n');
	const calls: Array<[string, string, { feedback?: string } | undefined]> = [];
	planReviewApi(run, calls);
	await run.event('plan_review_requested', {
		type: 'plan_review_requested',
		reviewId: 'disabled',
		options: [
			{ id: 'compact', disabled: true },
			{ id: 'refine', disabled: false },
		],
	});
	const status = await statusOf(run, mission);
	expect(status.actions).not.toContain('plan-approve');
	const socket = status.ctl!.socket;
	expect((await ctl(socket, { v: 1, op: 'plan-approve', operator: true })).error.code).toBe('rejected');
	expect((await ctl(socket, { v: 1, op: 'plan-refine', operator: true, args: { message: 'Narrow scope' } })).ok).toBe(
		true,
	);
	expect(calls).toEqual([['disabled', 'refine', { feedback: 'Narrow scope' }]]);
	await run.event('session_shutdown', {});
});

test('operator model recovery uses the live socket, preserves holds and refuses stale or unavailable retries', async () => {
	const mission = baseMission('/tmp', { blocker: QUOTA_BLOCKER });
	const run = await session({ child: true, mission, models: [{ provider: 'p', id: 'replacement' }] });
	try {
		let status = await statusOf(run, mission);
		const socket = status.ctl!.socket;
		const retry = (model = 'p/replacement', operator = true) =>
			ctl(socket, { v: 1, op: 'retry-model', operator, args: { model } });
		expect((await loadMission(missionPath(run.root, mission))).modelOverrides).toBeUndefined();
		status = await statusOf(run, mission);
		await run.command('continue');
		await run.event('agent_end', {
			messages: [{ role: 'assistant', stopReason: 'error', errorMessage: 'usage_limit_reached' }],
		});
		status = await statusOf(run, mission);
		expect(status.hold).toBe('quota');
		expect(status.actions).toContain('retry-model');
		expect((await retry('missing/model')).ok).toBe(false);
		expect((await loadMission(missionPath(run.root, mission))).blocker).toBe(`${QUOTA_BLOCKER}\nusage_limit_reached`);
		expect((await retry()).ok).toBe(true);
		const saved = await loadMission(missionPath(run.root, mission));
		expect(saved.blocker).toBeUndefined();
		expect(saved.modelOverrides).toEqual({ worker: 'p/replacement', review: 'p/replacement' });
		expect(saved.mode).toBe(mission.mode);
		expect(saved.phase).toBe(mission.phase);
		expect((await retry()).ok).toBe(false);
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('continue preserves the operator model instead of restoring a previous recovery choice', async () => {
	const mission = baseMission('/tmp', {
		modelOverrides: { worker: 'p/old', review: 'p/old', ...{ coordinator: 'p/old' } },
	});
	const run = await session({
		child: true,
		mission,
		models: [
			{ provider: 'p', id: 'old' },
			{ provider: 'p', id: 'chosen' },
		],
	});
	try {
		Object.assign(run.context, { model: { provider: 'p', id: 'chosen' } });
		await run.command('continue');
		expect((await statusOf(run, mission)).model).toBe('p/chosen');
	} finally {
		await run.event('session_shutdown', {});
	}
});

const PR_URL = 'https://github.com/acme/lab/pull/242';
const prMission = (cwd: string, over: Partial<Mission> = {}): Mission =>
	baseMission(cwd, {
		phase: 'complete',
		workspace: { key: 'workspace', cwd, delivery: 'pr', base: 'main', branch: 'feat/smoke' },
		evidence: {
			verify: { outcome: 'passed', detail: 'ok', revision: 'rev', at: 'now' },
			deliver: { outcome: 'passed', detail: `${PR_URL}\ndelivered`, revision: 'rev', at: 'now' },
		},
		...over,
	});

test('a completed mission with a delivered PR advertises check and publishes its result', async () => {
	const cwd = '/tmp';
	const input = (mission: Mission) =>
		buildContactStatus({
			mission,
			pending: false,
			resumeHold: false,
			snapshot: undefined,
			policy: idlePolicy,
			step: undefined,
			owned: true,
			selected: undefined,
			operation: false,
			ctl: null,
			usage: null,
		});
	const delivered = await input(prMission(cwd));
	expect(delivered.actions).toContain('check');
	expect(delivered.check).toBeNull();
	// No PR URL means no check; local delivery never gets the button.
	expect(
		(await input(prMission(cwd, { evidence: { deliver: { outcome: 'passed', detail: 'local merge', at: 'now' } } })))
			.actions,
	).not.toContain('check');
	const check = {
		at: '2026-10-15T20:00:00Z',
		state: 'threads' as const,
		detail: '2 threads open',
		conflicts: [],
		threads: { open: 2, total: 3 },
	};
	expect((await input(prMission(cwd, { check }))).check).toEqual(check);
});

const leaf = (id: string, category: Bead['category'], title = `Leaf ${id}`): Bead => ({
	id,
	title,
	status: category,
	children: [],
	ready: false,
	category,
});
const leafSnapshot = (leaves: Bead[]): Snapshot => ({
	beads: leaves,
	leaves,
	ready: [],
	closed: leaves.filter(bead => bead.category === 'closed').length,
	active: 0,
	blocked: 0,
	fetchedAt: 0,
});
const finding = (id: string, over: Partial<Finding> = {}): Finding => ({
	id,
	severity: 'medium',
	path: `src/${id}.ts`,
	line: 1,
	title: `Finding ${id}`,
	body: '',
	...over,
});

test('the final report maps delivery, verification, review triage and leaves', () => {
	const mission = prMission('/tmp', {
		graph: 'beads',
		evidence: {
			verify: { outcome: 'passed', detail: 'bun test: 412 pass', revision: 'rev2', at: '2026-10-20T10:00:00.000Z' },
			deliver: {
				outcome: 'passed',
				detail: `${PR_URL}\nAdds typed ids.\nVerified with bun test.`,
				revision: 'rev2',
				at: '2026-10-20T11:00:00.000Z',
			},
		},
		reviews: [
			{
				round: 1,
				revision: 'rev1',
				model: 'm',
				summary: '',
				at: '2026-10-20T09:00:00.000Z',
				findings: [
					finding('a', { severity: 'high', triage: { disposition: 'repair', detail: 'real' } }),
					finding('b', { rejection: 'speculative' }),
					finding('c', { severity: 'low', triage: { disposition: 'defer', detail: 'advisory' } }),
				],
			},
			{
				round: 2,
				revision: 'rev2',
				model: 'm',
				summary: '',
				at: '2026-10-20T10:30:00.000Z',
				findings: [
					finding('d', { triage: { disposition: 'reject', detail: 'already fixed' } }),
					finding('e', { severity: 'critical', triage: { disposition: 'escalate', detail: 'spec conflict' } }),
					// The same deferred note reported again is one follow-up.
					finding('c2', {
						path: 'src/c.ts',
						title: 'Finding  c',
						severity: 'low',
						triage: { disposition: 'defer', detail: 'again' },
					}),
				],
			},
			{
				round: 3,
				revision: 'old',
				model: 'm',
				summary: '',
				at: '2026-10-21T00:00:00.000Z',
				invalidated: 'files changed',
				findings: [finding('x')],
			},
		],
	});
	const snapshot = leafSnapshot([leaf('l1', 'closed'), leaf('l2', 'active'), leaf('l3', 'deferred')]);
	expect(missionReport(mission, snapshot)).toEqual({
		v: 1,
		at: '2026-10-20T11:00:00.000Z',
		revision: 'rev2',
		summary: 'Adds typed ids.\nVerified with bun test.',
		work: [
			{ title: 'Leaf l1', state: 'done' },
			{ title: 'Leaf l2', state: 'open' },
			{ title: 'Leaf l3', state: 'dropped' },
		],
		verification: { outcome: 'passed', detail: 'bun test: 412 pass', revision: 'rev2' },
		review: { rounds: 2, findings: 6, repaired: 1, rejected: 2, deferred: 2, escalated: 1 },
		followUps: [
			{ title: 'Finding c', severity: 'low', source: 'deferred' },
			{ title: 'Finding e', severity: 'critical', source: 'escalated' },
		],
		delivery: { outcome: 'passed', url: PR_URL },
	});
});

test('an oversize report trims list tails and clips text to fit 8 KiB', () => {
	const mission = prMission('/tmp', {
		evidence: {
			verify: { outcome: 'failed', detail: 'é'.repeat(5000), revision: 'rev', at: 'now' },
			deliver: { outcome: 'passed', detail: `${PR_URL}\n${'ü'.repeat(5000)}`, revision: 'rev', at: 'now' },
		},
		reviews: [
			{
				round: 1,
				revision: 'rev',
				model: 'm',
				summary: '',
				at: 'now',
				findings: Array.from({ length: 30 }, (_, i) =>
					finding(`f${i}`, { title: 'ä'.repeat(300), triage: { disposition: 'defer', detail: 'later' } }),
				),
			},
		],
	});
	const snapshot = leafSnapshot(Array.from({ length: 60 }, (_, i) => leaf(`l${i}`, 'closed', 'ö'.repeat(300))));
	const report = missionReport(mission, snapshot)!;
	expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(8 * 1024);
	expect(report.truncated).toBe(true);
	expect(report.work.length).toBeGreaterThan(0);
	expect(report.followUps.length).toBeGreaterThan(0);
	expect(report.review).toMatchObject({ findings: 30, deferred: 30 });
	expect(report.delivery.url).toBe(PR_URL);
});

test('a mission without verification or delivery evidence publishes no report', async () => {
	const mission = baseMission('/tmp', { reviews: [] });
	expect(missionReport(mission, leafSnapshot([leaf('l1', 'closed')]))).toBeNull();
	const status = await buildContactStatus({
		mission,
		pending: false,
		resumeHold: false,
		snapshot: undefined,
		policy: idlePolicy,
		step: undefined,
		owned: true,
		selected: undefined,
		operation: false,
		ctl: null,
		usage: null,
	});
	expect(status.report).toBeNull();
});

test('the status file publishes the final report of a delivered mission', async () => {
	const mission = prMission('/tmp');
	const run = await session({ mission });
	try {
		expect((await statusOf(run, mission)).report).toMatchObject({
			v: 1,
			summary: 'delivered',
			verification: { outcome: 'passed', detail: 'ok', revision: 'rev' },
			delivery: { outcome: 'passed', url: PR_URL },
		});
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('check over the socket marks the PR fixing, asks the pane, and record_check lands the outcome', async () => {
	const mission = prMission('/tmp');
	const run = await session({ child: true, mission });
	try {
		const socket = (await statusOf(run, mission)).ctl!.socket;
		// The coordinator's own bookkeeping op is never reachable over the board socket.
		expect((await ctl(socket, { v: 1, op: 'record_check', operator: true })).error.code).toBe('bad-request');
		expect((await ctl(socket, { v: 1, op: 'check' })).error.code).toBe('bad-request');
		const reply = await ctl(socket, { v: 1, op: 'check', operator: true, args: {} });
		expect(reply).toMatchObject({ ok: true });
		expect(run.sent.some(m => m.includes(PR_URL) && m.includes('record_check'))).toBe(true);
		expect((await statusOf(run, mission)).check).toMatchObject({ state: 'fixing' });
		const saved = await loadMission(missionPath(run.root, mission));
		expect(saved.check?.state).toBe('fixing');
	} finally {
		await run.event('session_shutdown', {});
	}
});

test('check is refused on an unfinished mission, or a completed one without a PR', async () => {
	const workingMission = baseMission('/tmp', { phase: 'execute' });
	const noPrMission = prMission('/tmp', {
		evidence: { deliver: { outcome: 'passed', detail: 'local merge', at: 'now' } },
	});
	const working = await session({ child: true, mission: workingMission });
	const done = await session({ child: true, mission: noPrMission });
	try {
		for (const [run, mission] of [
			[working, workingMission],
			[done, noPrMission],
		] as const) {
			const socket = (await statusOf(run, mission)).ctl!.socket;
			const reply = await ctl(socket, { v: 1, op: 'check', operator: true, args: {} });
			expect(reply.ok).toBe(false);
			expect(['rejected', 'busy']).toContain(reply.error.code);
		}
	} finally {
		await working.event('session_shutdown', {});
		await done.event('session_shutdown', {});
	}
});

test('bounded status measurements distinguish historic findings from invalidated current evidence', async () => {
	const m = baseMission('/tmp');
	m.measurements = {
		v: 1,
		since: '2026-01-01T00:00:00Z',
		recordedPassed: 2,
		recordedFailed: 1,
		repeatedFailedRevision: 0,
		mergePreflightFailures: 0,
		boundaryFailures: 0,
		reviewFailures: 1,
		acceptedRepairs: 1,
	};
	const finding = { id: 'f', severity: 'high' as const, path: 'a', line: 1, title: 'Defect', body: 'Detail' };
	m.reviews = [
		{ round: 1, revision: 'old', model: 'test', summary: 'Defect', findings: [finding], at: 'then' },
		{
			round: 2,
			revision: 'new',
			model: 'test',
			summary: 'Stale',
			findings: [finding],
			at: 'then',
			invalidated: 'revision changed',
		},
	];
	m.repairLinks = { f: ['repair-a', 'repair-b'] };
	const status = await buildContactStatus({
		mission: m,
		pending: false,
		resumeHold: false,
		snapshot: undefined,
		policy: idlePolicy,
		step: undefined,
		owned: true,
		selected: undefined,
		operation: false,
		ctl: null,
		usage: null,
		measurementConfig: { graph: 'local', frontend: 'none', maxWorkers: 2, reviewConcurrency: 3, mode: 'auto' },
	});
	expect(status.measurements).toMatchObject({
		completedRounds: 2,
		invalidatedRounds: 1,
		findingOccurrences: 2,
		latestActionable: 0,
		latestRejected: 0,
		severity: { critical: 0, high: 2, medium: 0, low: 0 },
		repairLinks: 2,
		recordedPassed: 2,
		recordedFailed: 1,
	});
	expect(
		Buffer.byteLength(JSON.stringify({ measurements: status.measurements, usageEvidence: status.usageEvidence })),
	).toBeLessThanOrEqual(4096);
});

test('detach flushes late coordinator usage inside the normal sampling window', async () => {
	const m = baseMission('/tmp'),
		run = await session({ mission: m, entries: [usageEntry(1, 2, 0.1)] });
	expect((await statusOf(run, m)).usage?.tokens.input).toBe(1);
	run.branch.push(usageEntry(8, 2, 0.2));
	await run.poll();
	expect((await statusOf(run, m)).usage?.tokens.input).toBe(1);
	await run.event('session_shutdown', {});
	const final = await statusOf(run, m);
	expect(final.usage?.tokens.input).toBe(9);
	expect(final.usageEvidence?.sources[0]?.pricedMessages).toBe(2);
	expect(final.ctl).toBeNull();
});

test('a confirmed repair-budget hold publishes its capability and grants exactly one cycle over the socket', async () => {
	const mission = baseMission('/tmp', { phase: 'review', reviewRequested: true, repairBudget: 0 });
	const { revision } = await captureRevision(mission, async () => {
		throw new Error('Unexpected command');
	});
	mission.evidence.verify = { outcome: 'passed', revision, detail: 'Verified output', at: 'now' };
	mission.evidence.deliver = { ...mission.evidence.verify, detail: 'Delivered output' };
	mission.reviews = [
		{
			round: 1,
			revision,
			model: 'independent',
			at: 'now',
			summary: 'Defect',
			findings: [
				{
					id: 'f',
					severity: 'high',
					path: 'task.ts',
					line: 1,
					title: 'Unresolved defect',
					body: 'A consumer workflow fails',
					triage: { disposition: 'repair', detail: 'task.ts:1 confirmed against acceptance' },
				},
			],
		},
	];
	const run = await session({ mission, child: true });
	try {
		const socket = (await statusOf(run, mission)).ctl!.socket;
		expect((await ctl(socket, { v: 1, op: 'continue', operator: true })).ok).toBe(true);
		expect((await statusOf(run, mission)).problem?.source).toBe('repair-budget');
		expect((await ctl(socket, { v: 1, op: 'mode', operator: true, args: { mode: 'pause' } })).ok).toBe(true);
		expect((await ctl(socket, { v: 1, op: 'review', operator: true, args: { repairBudgetOnly: true } })).ok).toBe(
			false,
		);
		expect((await ctl(socket, { v: 1, op: 'mode', operator: true, args: { mode: 'auto' } })).ok).toBe(true);
		expect((await ctl(socket, { v: 1, op: 'review', operator: true, args: { repairBudgetOnly: true } })).ok).toBe(true);
		const saved = (await listMissions(run.root))[0]!.mission;
		expect(saved.repairBudget).toBe(1);
		expect(saved.evidence.verify?.outcome).toBe('passed');
		expect(saved.reviews[0]!.findings[0]!.triage?.disposition).toBe('repair');
		expect((await ctl(socket, { v: 1, op: 'review', operator: true, args: { repairBudgetOnly: true } })).ok).toBe(
			false,
		);
	} finally {
		await run.event('session_shutdown', {});
	}
});
