import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext, PlanReviewChoice } from '@oh-my-pi/pi-coding-agent';
import { deliverUrl, displayPhase, effectiveGraph, modelRetryTargets, operatorCommands, providerCapacity, quotaBlocked, reviewRetryAt } from './controller';
import { isRecord } from './guards';
import { displaySourceId } from './sources';
import { missionDirectory } from './store';
import { phases, type Evidence, type Mission, type MissionCheck, type Mode, type PolicyContext, type Snapshot, type Step } from './types';

// The holotable fleet contract (omp-holotable/docs/contract.md). Kept local: the repos do not import across.
export const OPERATOR_OPS = ['approve', 'continue', 'mode', 'review', 'dispatch', 'check', 'resend', 'release', 'reap', 'clear', 'plan-approve', 'retry-model'] as const;
const SOCKET_OPS: Record<string, true> = { ping: true, approve: true, continue: true, mode: true, review: true, dispatch: true, check: true, resend: true, release: true, reap: true, clear: true, plan: true, 'plan-edit': true, 'plan-refine': true, 'plan-approve': true, 'retry-model': true };
// 1 MiB: a plan-edit request carries up to 256 KiB of text plus JSON escaping overhead.
const MAX_LINE = 1024 * 1024;
const MAX_PLAN = 256 * 1024;

export interface MissionProblem {
 kind: 'quota' | 'rate-limit' | 'timeout' | 'error';
 source: string;
 detail: string;
 retryAt: string | null;
 attempt: number | null;
 completed: number | null;
 total: number | null;
}

function missionProblem(m: Mission, graphError?: string): MissionProblem | null {
 if (m.phase === 'complete') return null;
 const review = m.evidence.review;
 const worker = m.workers.find(w => w.state !== 'closed' && w.error);
 const source = graphError ? 'graph' : m.blocker ? 'coordinator'
  : review?.outcome === 'failed' ? 'review' : worker ? 'worker'
  : m.evidence.verify?.outcome === 'failed' ? 'verification' : undefined;
 const detail = graphError ?? m.blocker ?? (source === 'review' ? review!.detail : worker?.error ?? (source === 'verification' ? m.evidence.verify!.detail : undefined));
 if (!source || !detail) return null;
 const capacity = providerCapacity(detail);
 const retry = source === 'review' ? reviewRetryAt(m) : undefined;
 return {
  kind: capacity === 'quota' ? 'quota' : capacity === 'rate' ? 'rate-limit'
   : /deadline exceeded|timed out|timeout/i.test(detail) ? 'timeout' : 'error',
  source, detail, retryAt: retry === undefined ? null : new Date(retry).toISOString(),
  attempt: source === 'review' ? review!.attempts ?? 1 : null,
  completed: source === 'review' && m.reviewProgress ? Object.keys(m.reviewProgress.targets).length : null,
  total: source === 'review' && m.reviewProgress ? Object.keys(m.reviewProgress.inputs).length : null,
 };
}
export interface ContactStatus {
	schema: 1;
	id: string;
	ticket: string;
	title: string;
	worktree: string;
	base: string | null;
	phase: string;
	progress: { step: number; of: number } | null;
	hold: 'none' | 'plan-approval' | 'resume' | 'gate' | 'blocked' | 'quota' | 'question';
	gate: { kind: string; id: string } | null;
	next: string | null;
	actions: string[];
	workers: { live: number; total: number } | null;
	delivery: { url: string | null; branch: string | null } | null;
	complete: boolean;
	revision: string;
	plan: { path: string; revision: string } | null;
	mode: Mode | null;
	/** Latest verification outcome; 'failed' means `continue` would re-open broken work, so automation must not send it. */
	verify: Evidence['outcome'] | null;
 problem?: MissionProblem | null;
	/** Latest operator-requested PR check; absent until the first check or on older missions. */
	check?: MissionCheck | null;
	usage: UsageTotals | null;
	ctl: { socket: string; generation: number } | null;
	updatedAt: string;
}

export interface UsageTotals {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd: number | null;
	sessions: number;
}

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function mergeUsage(target: UsageTotals, source: UsageTotals | null): void {
	if (!source) return;
	for (const key of TOKEN_KEYS) target.tokens[key] += source.tokens[key];
	if (source.costUsd !== null) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
	target.sessions += source.sessions;
}

// One session counts once when at least one of its records is a {type:'message', message:{role:'assistant'}}
// entry whose message carries a usage object — the OMP AssistantMessage.usage shape. Anything else is skipped.
export function sumAssistantUsage(records: readonly unknown[]): UsageTotals | null {
	const totals: UsageTotals = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, sessions: 0 };
	let found = false;
	for (const record of records) {
		if (!isRecord(record) || record.type !== 'message' || !isRecord(record.message) || record.message.role !== 'assistant') continue;
		const usage = record.message.usage;
		if (!isRecord(usage)) continue;
		found = true;
		for (const key of TOKEN_KEYS) if (typeof usage[key] === 'number' && Number.isFinite(usage[key])) totals.tokens[key] += usage[key];
		if (isRecord(usage.cost) && typeof usage.cost.total === 'number' && Number.isFinite(usage.cost.total)) totals.costUsd = (totals.costUsd ?? 0) + usage.cost.total;
	}
	if (!found) return null;
	totals.sessions = 1;
	return totals;
}

// Worker transcripts are OMP session files: one JSON object per line. A mid-write tail line is skipped,
// so offset bookkeeping only ever ends on a newline boundary.
export function parseUsageLines(text: string): UsageTotals | null {
	const records: unknown[] = [];
	for (const line of text.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try { records.push(JSON.parse(trimmed)); } catch { /* partial or foreign line */ }
	}
	return sumAssistantUsage(records);
}

export function gateTokenId(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
export function planRevision(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export function statusFilePath(agentDir: string, mission: Pick<Mission, 'id' | 'workspace'>): string {
	return join(missionDirectory(agentDir, mission.workspace.key), 'status', `${mission.id}.json`);
}

interface FileUsage { offset: number; counted: boolean; tokens: { input: number; output: number; cacheRead: number; cacheWrite: number }; costUsd: number | null }

/**
 * Usage probe for the status file. Sums assistant-message usage in the coordinator session
 * (`SessionManager.getEntries()`) and in the mission's worker session files under
 * missions/<key>/workers/*.jsonl (read-only). Recomputed at most once per `intervalMs` (default
 * 30 s): worker files are re-parsed incrementally from the byte offset after the last newline.
 * A mission switch recomputes immediately. Null means nothing has recorded usage yet.
 */
export class UsageProbe {
	private readonly files = new Map<string, FileUsage>();
	private stamp = 0;
	private key = '';
	private cache: UsageTotals | null = null;

	constructor(private readonly agentDir: string, private readonly now: () => number = Date.now, private readonly intervalMs = 30_000) {}

	async measure(mission: Mission, coordinatorEntries: () => readonly unknown[] | undefined): Promise<UsageTotals | null> {
		const key = `${mission.workspace.key} ${mission.id}`;
		const now = this.now();
		if (this.key === key && now - this.stamp < this.intervalMs) return this.cache;
		if (this.key !== key) this.files.clear();
		this.key = key;
		this.stamp = now;
		this.cache = await this.compute(mission, coordinatorEntries);
		return this.cache;
	}

	private async compute(mission: Mission, coordinatorEntries: () => readonly unknown[] | undefined): Promise<UsageTotals | null> {
		const totals: UsageTotals = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null, sessions: 0 };
		mergeUsage(totals, sumAssistantUsage(coordinatorEntries() ?? []));
		const dir = join(missionDirectory(this.agentDir, mission.workspace.key), 'workers');
		const names = new Set(await readdir(dir).catch(() => [] as string[]));
		for (const name of [...names].sort()) {
			if (!name.endsWith('.jsonl')) continue;
			mergeUsage(totals, await this.file(join(dir, name)));
		}
		// A worker file deleted since the last pass keeps the usage already parsed from it.
		for (const [path, entry] of this.files) {
			if (path.startsWith(`${dir}/`) && !names.has(path.slice(dir.length + 1)) && entry.counted) {
				mergeUsage(totals, { tokens: { ...entry.tokens }, costUsd: entry.costUsd, sessions: 1 });
			}
		}
		return totals.sessions > 0 ? totals : null;
	}

	private async file(path: string): Promise<UsageTotals | null> {
		let entry = this.files.get(path);
		const data = await readFile(path).catch(() => null);
		if (data === null) return entry ? { tokens: { ...entry.tokens }, costUsd: entry.costUsd, sessions: entry.counted ? 1 : 0 } : null;
		const end = data.lastIndexOf(0x0a);
		if (!entry) { entry = { offset: 0, counted: false, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, costUsd: null }; this.files.set(path, entry); }
		if (end > entry.offset) {
			const parsed = parseUsageLines(data.toString('utf8', entry.offset, end + 1));
			entry.offset = end + 1;
			if (parsed) {
				for (const key of TOKEN_KEYS) entry.tokens[key] += parsed.tokens[key];
				if (parsed.costUsd !== null) entry.costUsd = (entry.costUsd ?? 0) + parsed.costUsd;
				entry.counted = true;
			}
		}
		return { tokens: { ...entry.tokens }, costUsd: entry.costUsd, sessions: entry.counted ? 1 : 0 };
	}
}

export interface StatusInput {
	mission: Mission;
	pending: boolean;
	resumeHold: boolean;
	snapshot: Snapshot | undefined;
	policy: PolicyContext;
	step: Step | undefined;
	owned: boolean;
	selected: string | undefined;
	operation: boolean;
	ctl: { socket: string; generation: number } | null;
	usage: UsageTotals | null;
	planPath?: string;
	planReview?: boolean;
	question?: string;
}

// Pure projection of mission state into the fleet status file. Async only for the worktree realpath.
export async function buildContactStatus(input: StatusInput): Promise<ContactStatus> {
	const m = input.mission;
	const phase = displayPhase(m, input.snapshot);
	const worktree = await realpath(m.workspace.cwd).catch(() => m.workspace.cwd);
	// An unreadable bead graph stops the controller (nextAction holds on snapshot.error) even though no blocker is saved.
	const graphDown = phase !== 'complete' && !!m.epicId && effectiveGraph(m) === 'beads' && !!input.snapshot?.error;
	const question = phase !== 'complete' ? input.question : undefined;
	const hold = question ? 'question'
		: quotaBlocked(m) ? 'quota'
		: input.pending ? (m.blocker ? 'blocked' : 'plan-approval')
		: input.resumeHold && phase !== 'complete' ? 'resume'
		: m.gate ? 'gate'
		: m.blocker || graphDown ? 'blocked'
		: 'none';
	const actions = question ? [] : input.pending
		// plan-approve answers OMP's interactive plan review, never a question or a parked planning turn.
		? (!m.blocker && input.planReview ? ['plan-approve'] : [])
		: [...new Set(
			operatorCommands(m, false, input.snapshot, input.policy, input.selected, input.operation)
				.map(command => command.split(' ')[0]!)
				.filter((verb): verb is (typeof OPERATOR_OPS)[number] => (OPERATOR_OPS as readonly string[]).includes(verb)),
		)];
	if (!question && !input.pending && !input.operation && modelRetryTargets(m, input.snapshot, input.policy)) actions.push('retry-model');
	const url = deliverUrl(m);
	const branch = m.workspace.branch ?? null;
	const next = question ? `Answer in mission: ${question}`.replace(/\s+/g, ' ').slice(0, 240)
		: m.blocker ? m.blocker.replace(/\s+/g, ' ').slice(0, 240)
		: input.step ? `${input.step.command ? `${input.step.command} — ` : ''}${input.step.text}`.replace(/\s*\n\s*/g, ' ').slice(0, 240) : null;
	return {
		schema: 1,
		id: m.id,
		ticket: displaySourceId(m.source),
		title: m.source.title,
		worktree,
		base: m.workspace.base ?? null,
		phase,
		progress: { step: phases.indexOf(phase), of: phases.length },
		hold,
		gate: m.gate ? { kind: m.gate.kind, id: gateTokenId(m.gate.token) } : null,
		next,
		actions,
		workers: m.workers.length ? { live: m.workers.filter(w => w.state !== 'closed').length, total: m.workers.length } : null,
		delivery: url || branch ? { url, branch } : null,
		complete: phase === 'complete',
		plan: input.pending && input.planPath ? await readFile(input.planPath, 'utf8').then(text => ({ path: input.planPath!, revision: planRevision(text) })).catch(() => null) : null,
		revision: m.updatedAt,
		mode: m.mode ?? null,
		verify: m.evidence.verify?.outcome ?? null,
		problem: missionProblem(m, graphDown ? input.snapshot?.error : undefined),
		check: m.check ?? null,
		usage: input.usage,
		ctl: input.ctl,
		updatedAt: m.updatedAt,
	};
}

// Per-call-site environment overrides for board-launched missions. Invalid values throw instead of silently half-applying.
export function envGraph(env: NodeJS.ProcessEnv = process.env): 'local' | 'beads' | undefined {
	const value = env.OMP_MISSION_GRAPH;
	if (value === undefined || value === '') return undefined;
	if (value !== 'local' && value !== 'beads') throw new Error(`Invalid OMP_MISSION_GRAPH: ${value} (local|beads)`);
	return value;
}
export function envDelivery(env: NodeJS.ProcessEnv = process.env): 'pr' | 'local' | undefined {
	const value = env.OMP_MISSION_DELIVERY;
	if (value === undefined || value === '') return undefined;
	if (value !== 'pr' && value !== 'local') throw new Error(`Invalid OMP_MISSION_DELIVERY: ${value} (pr|local)`);
	return value;
}
export function envBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.OMP_MISSION_BASE?.trim() || undefined;
}
export function envCheckout(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.OMP_MISSION_CHECKOUT?.trim() || undefined;
}
// argv messages never fire the input hook, so the board's message arrives here: OMP_MISSION_AUTOSTART plus
// a plan.defaultOnStartup config overlay put the session in plan mode before the command runs.
export function autostartMessage(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.OMP_MISSION_AUTOSTART?.trim();
	if (!value) return undefined;
	return value.startsWith('/mission') ? value.slice('/mission'.length).trim() : value;
}

export interface HolotableHooks {
	context(): ExtensionContext | undefined;
	source(): { mission: Mission | undefined; pending: Mission | undefined };
	resumeHold(): boolean;
	snapshot(): Snapshot | undefined;
	policy(): PolicyContext;
	step(): Step | undefined;
	owned(): boolean;
	selected(): string | undefined;
	operation(): boolean;
	question(): string | undefined;
	gateId(): string | undefined;
	decide(context: ExtensionContext, verb: string, arg?: string): Promise<void>;
	request(context: ExtensionContext, op: string, extra?: Record<string, unknown>): Promise<void>;
	clear(context: ExtensionContext): Promise<void>;
	planPath(): string | undefined;
	touchPending(): void;
	sendUserMessage(message: string): void;
	// The open interactive plan review, when OMP exposes the review API (ctx.resolvePlanReview) and a review awaits an answer.
	planReview(): { reviewId: string; canApprove: boolean; resolve(choice: PlanReviewChoice, input?: { feedback?: string }): boolean } | undefined;
	onNotify(message: string): void;
}

interface Reply {
	v: 1;
	ok: boolean;
	revision?: string;
	plan?: { text: string; path: string; revision: string };
	error?: { code: string; message: string };
}

function fail(code: string, message: string): Reply {
	return { v: 1, ok: false, error: { code, message } };
}

export class HolotableBridge {
	private server: Server | undefined;
	private socketPath: string | undefined;
	private generation = 0;
	private socketId: string | undefined;
	private inflight = new Set<Socket>();
	private last = '';
	private lastPath = '';
	private failed = false;
	private writing: Promise<void> = Promise.resolve();
	private readonly usage: UsageProbe;

	constructor(private readonly agentDir: string, private readonly hooks: HolotableHooks) {
		this.usage = new UsageProbe(agentDir);
	}

	ctlFor(missionId: string): { socket: string; generation: number } | null {
		return this.socketId === missionId && this.server && this.socketPath ? { socket: this.socketPath, generation: this.generation } : null;
	}

	// Fire-and-forget status publication; serialized so concurrent renders cannot interleave the tmp file.
	publish(): Promise<void> {
		this.writing = this.writing.then(() => this.write()).catch(() => undefined);
		return this.writing;
	}

	private async write(): Promise<void> {
		const { mission, pending } = this.hooks.source();
		const current = mission ?? pending;
		if (!current) return;
		// getEntries() (not getBranch()): every assistant message in the coordinator session counts toward spend.
		// Lazy so a publish inside the probe's throttle window does not pay for the copy.
		const coordinatorEntries = () => { try { return this.hooks.context()?.sessionManager.getEntries(); } catch { return undefined; } };
		const status = await buildContactStatus({
			mission: current,
			pending: !mission && !!pending,
			resumeHold: this.hooks.resumeHold(),
			snapshot: this.hooks.snapshot(),
			policy: this.hooks.policy(),
			step: this.hooks.step(),
			owned: this.hooks.owned(),
			selected: this.hooks.selected(),
			operation: this.hooks.operation(),
			ctl: this.ctlFor(current.id),
			usage: await this.usage.measure(current, coordinatorEntries),
			planPath: this.hooks.planPath(),
			planReview: this.hooks.planReview()?.canApprove === true,
			question: this.hooks.question(),
		});
		const serialized = `${JSON.stringify(status, null, 2)}\n`;
		const file = statusFilePath(this.agentDir, current);
		if (file === this.lastPath && serialized === this.last) return;
		try {
			await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
			const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
			try {
				await writeFile(temporary, serialized, { mode: 0o600 });
				await rename(temporary, file);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
			this.last = serialized;
			this.lastPath = file;
			this.failed = false;
		} catch (error) {
			if (!this.failed) {
				this.failed = true;
				this.hooks.onNotify(`Holotable status write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// A discarded pending plan leaves no status file: the run never existed. Saved missions keep their final snapshot.
	async discard(mission: Pick<Mission, 'id' | 'workspace'>): Promise<void> {
		const file = statusFilePath(this.agentDir, mission);
		if (file === this.lastPath) { this.last = ''; this.lastPath = ''; }
		await rm(file, { force: true });
	}

	// The socket exists only for board-launched children (OMP_HOLOTABLE_CHILD=1).
	async open(missionId: string): Promise<void> {
		if (process.env.OMP_HOLOTABLE_CHILD !== '1') return;
		if (this.socketId === missionId && this.server) return;
		await this.close();
		const dir = join(tmpdir(), `omp-mission-ctl-${process.getuid?.() ?? 0}`);
		const path = join(dir, `${createHash('sha256').update(missionId).digest('hex').slice(0, 16)}.sock`);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const stat = await lstat(dir);
		if (!stat.isDirectory() || stat.uid !== process.getuid!()) throw new Error(`Refusing control socket dir ${dir}: not owned by uid ${process.getuid!()}`);
		await chmod(dir, 0o700);
		await rm(path, { force: true });
		this.generation = Date.now();
		this.socketPath = path;
		const server = createServer({ allowHalfOpen: true }, socket => this.serve(socket));
		server.on('error', error => this.hooks.onNotify(`Holotable control socket error: ${error.message}`));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(path, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		this.server = server;
		this.socketId = missionId;
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.socketId = undefined;
		if (!server) return;
		server.close();
		const path = this.socketPath;
		this.socketPath = undefined;
		if (path) await rm(path, { force: true }).catch(() => undefined);
	}

	private serve(socket: Socket): void {
		this.inflight.add(socket);
		let buffer = '';
		const reply = (line: string) => {
			void this.handle(line).then(r => {
				socket.end(`${JSON.stringify(r)}\n`);
			}, () => {
				socket.end(`${JSON.stringify(fail('bad-request', 'The request could not be handled'))}\n`);
			});
		};
		socket.on('data', chunk => {
			buffer += chunk.toString('utf8');
			const newline = buffer.indexOf('\n');
			if (newline < 0) {
				if (buffer.length > MAX_LINE) socket.destroy();
				return;
			}
			const line = buffer.slice(0, newline);
			buffer = '';
			reply(line);
		});
		// A client that half-closes without a trailing newline still gets a reply.
		socket.on('end', () => { if (buffer.length > 0 && buffer.length <= MAX_LINE) reply(buffer); buffer = ''; });
		socket.on('error', () => undefined);
		socket.on('close', () => this.inflight.delete(socket));
	}

	private async handle(line: string): Promise<Reply> {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			return fail('bad-request', 'Request is not valid JSON');
		}
		if (!isRecord(request) || request.v !== 1 || typeof request.op !== 'string' || !SOCKET_OPS[request.op] || (request.args !== undefined && !isRecord(request.args))) {
			return fail('bad-request', 'Expected {"v":1,"op":"<op>","args":{...}}');
		}
		const { mission, pending } = this.hooks.source();
		const revision = (mission ?? pending)?.updatedAt;
		if (request.op === 'ping') return { v: 1, ok: true, ...(revision ? { revision } : {}) };
		if (request.op === 'plan') {
			const path = pending && !mission ? this.hooks.planPath() : undefined;
			const text = path ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
			if (text === undefined || path === undefined) return fail('no-plan', 'No pending plan file');
			return { v: 1, ok: true, revision: revision ?? '', plan: { text, path, revision: planRevision(text) } };
		}
		if (request.operator !== true) return fail('bad-request', 'Operator operations require "operator":true');
		const context = this.hooks.context();
		if (!context) return fail('no-session', 'No main-session context is attached');
		if (this.hooks.question()) return fail('question-waiting', 'Answer the pending question in the mission pane before controlling the mission');
		const args = (request.args ?? {}) as Record<string, unknown>;
		const op = request.op;
		try {
			if (op === 'approve') {
				const gate = args.gate;
				if (gate !== undefined && gate !== this.hooks.gateId()) return fail('stale', 'The gate id no longer matches; read the status file again');
				await this.hooks.decide(context, 'approve', undefined);
			} else if (op === 'mode' || op === 'review') {
				await this.hooks.decide(context, op, typeof args.mode === 'string' ? args.mode : undefined);
			} else if (op === 'clear') {
				await this.hooks.clear(context);
			} else if (op === 'plan-edit') {
				if (mission || !pending) return fail('rejected', 'No pending plan is awaiting approval');
				if (typeof args.text !== 'string') return fail('bad-request', 'plan-edit requires args.text');
				if (Buffer.byteLength(args.text, 'utf8') > MAX_PLAN) return fail('bad-request', 'Plan text exceeds 256 KiB');
				if (args.base !== undefined && typeof args.base !== 'string') return fail('bad-request', 'args.base must be a string');
				const editPath = this.hooks.planPath();
				const current = editPath ? await readFile(editPath, 'utf8').catch(() => undefined) : undefined;
				if (editPath === undefined || current === undefined) return fail('no-plan', 'No pending plan file');
				if (args.base !== undefined && args.base !== planRevision(current)) return fail('stale', 'The plan changed since this revision; read it again');
				const mode = (await lstat(editPath)).mode & 0o777;
				const temporary = `${editPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
				try {
					await writeFile(temporary, args.text, { mode });
					await rename(temporary, editPath);
				} catch (error) {
					await rm(temporary, { force: true }).catch(() => undefined);
					throw error;
				}
				this.hooks.touchPending();
				await this.publish();
				return { v: 1, ok: true, revision: this.hooks.source().pending?.updatedAt ?? '', plan: { text: args.text, path: editPath, revision: planRevision(args.text) } };
			} else if (op === 'plan-approve') {
				if (mission || !pending) return fail('rejected', 'No pending plan is awaiting approval');
				if (args.revision !== undefined && typeof args.revision !== 'string') return fail('bad-request', 'args.revision must be a string');
				const review = this.hooks.planReview();
				if (!review?.canApprove) return fail('rejected', 'No plan review with compact approval is available');
				if (args.revision !== undefined) {
					const planPath = this.hooks.planPath();
					const current = planPath ? await readFile(planPath, 'utf8').catch(() => undefined) : undefined;
					if (planPath === undefined || current === undefined) return fail('no-plan', 'No pending plan file');
					if (args.revision !== planRevision(current)) return fail('stale', 'The plan changed since this revision; read it again');
				}
				// 'compact' approves and keeps the session, so the mission:pending entry survives and the mission starts on the
				// before_agent_start 'Plan approved.' path. 'execute' would clear the session and lose the pending mission — never use it here.
				if (!review.resolve('compact')) return fail('rejected', 'The plan review closed before it could be resolved');
				return { v: 1, ok: true, revision: this.hooks.source().pending?.updatedAt ?? '' };
			} else if (op === 'plan-refine') {
				if (mission || !pending) return fail('rejected', 'No pending plan is awaiting approval');
				if (typeof args.message !== 'string' || args.message.length < 1 || args.message.length > 8000) return fail('bad-request', 'plan-refine requires args.message of 1..8000 characters');
				const review = this.hooks.planReview();
				if (review) {
					if (!review.resolve('refine', { feedback: args.message })) return fail('rejected', 'The plan review closed before it could be refined');
				} else this.hooks.sendUserMessage(args.message);
			} else {
				const extra: Record<string, unknown> = {};
				if (op === 'retry-model') {
					if (typeof args.model !== 'string' || !args.model.trim() || args.model.length > 1000) return fail('bad-request', 'retry-model requires a concrete args.model');
					extra.model = args.model;
				}
				if (typeof args.beadId === 'string') extra.beadId = args.beadId;
				if (typeof args.detail === 'string') extra.detail = args.detail;
				if (Array.isArray(args.files) && args.files.every(file => typeof file === 'string')) extra.files = args.files;
				await this.hooks.request(context, op, extra);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(message === 'Mission operation already running' ? 'busy' : 'rejected', message);
		}
		return { v: 1, ok: true, revision: this.hooks.source().mission?.updatedAt ?? '' };
	}
}
