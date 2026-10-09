import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { displayPhase, operatorCommands, quotaHold } from './controller';
import { isRecord } from './guards';
import { displaySourceId } from './sources';
import { missionDirectory } from './store';
import { phases, type Mission, type PolicyContext, type Snapshot, type Step } from './types';

// The holotable fleet contract (omp-holotable/docs/contract.md). Kept local: the repos do not import across.
export const OPERATOR_OPS = ['approve', 'continue', 'mode', 'review', 'dispatch', 'resend', 'release', 'reap', 'clear'] as const;
const SOCKET_OPS: Record<string, true> = { ping: true, approve: true, continue: true, mode: true, review: true, dispatch: true, resend: true, release: true, reap: true, clear: true, plan: true, 'plan-edit': true, 'plan-refine': true };
// 1 MiB: a plan-edit request carries up to 256 KiB of text plus JSON escaping overhead.
const MAX_LINE = 1024 * 1024;
const MAX_PLAN = 256 * 1024;

export interface ContactStatus {
	schema: 1;
	id: string;
	ticket: string;
	title: string;
	worktree: string;
	base: string | null;
	phase: string;
	progress: { step: number; of: number } | null;
	hold: 'none' | 'plan-approval' | 'resume' | 'gate' | 'blocked' | 'quota';
	gate: { kind: string; id: string } | null;
	next: string | null;
	actions: string[];
	workers: { live: number; total: number } | null;
	delivery: { url: string | null; branch: string | null } | null;
	complete: boolean;
	revision: string;
	plan: { path: string; revision: string } | null;
	ctl: { socket: string; generation: number } | null;
	updatedAt: string;
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
	planPath?: string;
}

// Pure projection of mission state into the fleet status file. Async only for the worktree realpath.
export async function buildContactStatus(input: StatusInput): Promise<ContactStatus> {
	const m = input.mission;
	const phase = displayPhase(m, input.snapshot);
	const worktree = await realpath(m.workspace.cwd).catch(() => m.workspace.cwd);
	const hold = input.pending ? 'plan-approval'
		: input.resumeHold ? 'resume'
		: m.gate ? 'gate'
		: m.blocker ? 'blocked'
		: m.evidence.review?.outcome === 'failed' && quotaHold.test(m.evidence.review.detail) ? 'quota'
		: 'none';
	const actions = input.pending ? [] : [...new Set(
		operatorCommands(m, false, input.snapshot, input.policy, input.selected, input.operation)
			.map(command => command.split(' ')[0]!)
			.filter((verb): verb is (typeof OPERATOR_OPS)[number] => (OPERATOR_OPS as readonly string[]).includes(verb)),
	)];
	const detail = m.evidence.deliver?.detail ?? '';
	const first = detail.split('\n', 1)[0]!.trim();
	const url = /^https?:\/\/\S+$/.test(first) ? first : null;
	const branch = m.workspace.branch ?? null;
	const next = input.step ? `${input.step.command ? `${input.step.command} — ` : ''}${input.step.text}`.replace(/\s*\n\s*/g, ' ').slice(0, 240) : null;
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
	gateId(): string | undefined;
	decide(context: ExtensionContext, verb: string, arg?: string): Promise<void>;
	request(context: ExtensionContext, op: string, extra?: Record<string, unknown>): Promise<void>;
	clear(context: ExtensionContext): Promise<void>;
	planPath(): string | undefined;
	touchPending(): void;
	sendUserMessage(message: string): void;
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

	constructor(private readonly agentDir: string, private readonly hooks: HolotableHooks) {}

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
			planPath: this.hooks.planPath(),
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
				const planPath = this.hooks.planPath();
				const current = planPath ? await readFile(planPath, 'utf8').catch(() => undefined) : undefined;
				if (planPath === undefined || current === undefined) return fail('no-plan', 'No pending plan file');
				if (args.base !== undefined && args.base !== planRevision(current)) return fail('stale', 'The plan changed since this revision; read it again');
				const mode = (await lstat(planPath)).mode & 0o777;
				const temporary = `${planPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
				try {
					await writeFile(temporary, args.text, { mode });
					await rename(temporary, planPath);
				} catch (error) {
					await rm(temporary, { force: true }).catch(() => undefined);
					throw error;
				}
				this.hooks.touchPending();
				await this.publish();
				return { v: 1, ok: true, revision: this.hooks.source().pending?.updatedAt ?? '', plan: { text: args.text, path: planPath, revision: planRevision(args.text) } };
			} else if (op === 'plan-refine') {
				if (mission || !pending) return fail('rejected', 'No pending plan is awaiting approval');
				if (typeof args.message !== 'string' || args.message.length < 1 || args.message.length > 8000) return fail('bad-request', 'plan-refine requires args.message of 1..8000 characters');
				this.hooks.sendUserMessage(args.message);
			} else {
				const extra: Record<string, unknown> = {};
				if (typeof args.beadId === 'string') extra.beadId = args.beadId;
				if (typeof args.detail === 'string') extra.detail = args.detail;
				await this.hooks.request(context, op, extra);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(message === 'Mission operation already running' ? 'busy' : 'rejected', message);
		}
		return { v: 1, ok: true, revision: this.hooks.source().mission?.updatedAt ?? '' };
	}
}
