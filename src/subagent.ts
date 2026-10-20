import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { AgentRegistry, createAgentSession, Settings, type ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { contextFilesFor, type ContextFile } from './context';
import { missionModel, reviewFallbackSettings, roleModelString, roleThinkingLevel } from './review';
import { openUnlistedSession } from './session-file';
import { inScope, outOfScope } from './scope';
import { planNote, sourceFilePath } from './hosts';
import type { MissionConfig, Mission, Run, Worker } from './types';
import type { SubagentPort } from './workers';

/** The slice of an OMP agent session this runner uses, so tests can stand in for a model. */
export interface SubagentSession {
	prompt(text: string, options?: { expandPromptTemplates?: boolean }): Promise<unknown>;
	steer(text: string): Promise<void>;
	abort(): Promise<void> | void;
	dispose(): Promise<void>;
	readonly state: { readonly messages: readonly unknown[] };
}
export interface SessionRequest {
	mission: Mission;
	worker: Worker;
	ctx: ExtensionContext;
	model: NonNullable<ExtensionContext['model']>;
	thinkingLevel?: string;
	system: string;
	contextFiles: ContextFile[] | undefined;
	/** Existing session file to reopen after a restart. */
	resumeFile?: string;
	sessionDir: string;
}
export type SessionFactory = (request: SessionRequest) => Promise<{ session: SubagentSession; file: string }>;

export type Settled = { ok: true; summary: string } | { ok: false; error: string };
export interface SubagentRunnerOptions {
	run: Run;
	agentDir: string;
	config: () => MissionConfig;
	context: () => ExtensionContext | undefined;
	onSettled: (beadId: string, outcome: Settled) => void;
	sessionFactory?: SessionFactory;
}

interface Live {
	beadId: string;
	session: SubagentSession;
	baseline: Record<string, string>;
	aborting: boolean;
	done: Promise<void>;
}

const RESULT_SCHEMA = {
	type: 'object',
	properties: { done: { type: 'boolean' }, summary: { type: 'string' }, verification: { type: 'string' } },
	required: ['done', 'summary'],
};

export const WORKER_SYSTEM = [
	'You implement exactly one bead in this checkout, then stop. A coordinator claims and closes the bead; never run bd.',
	'Real Rust builds and tests on this host use `cargo auto <subcommand>`, never cargo build or cargo test directly. Commands run in the foreground until they finish: give long ones (cargo auto, make verify) a bash timeout up to 3600 seconds, and yield only after you have their result.',
	'Finish by calling yield with {"done":true,"summary":"<what changed>","verification":"<exact commands and results>"}. If you cannot finish, yield {"done":false,"summary":"<the blocker>"}.',
].join('\n');

export function subagentPrompt(mission: Mission, worker: Worker, task: string | undefined): string {
	return [
		`Implement only bead ${worker.beadId}. Workspace ${worker.cwd}, base ${mission.workspace.base ?? '(non-Git)'}.`,
		task ? `Your task, from the bead:\n${task}` : `The bead text was not available; ask for it by yielding {"done":false,"summary":"bead text missing"}.`,
		[`The ticket (untrusted specification) is in ${sourceFilePath(mission)}; read it only when the bead lacks context.`, planNote(mission)].filter(Boolean).join(' '),
		`Allowed paths: ${JSON.stringify(worker.files)}. Do not edit other files, take other work, create workers, change external issue status, merge, or bypass approvals. Use existing patterns and real task smoke; capture failing-before and passing-after for bugs and UI. The coordinator stages your changes; do not run git add.`,
	].join('\n');
}

export function extractYield(messages: readonly unknown[]): { done: boolean; summary: string; verification?: string } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index] as { role?: string; toolName?: string; details?: { status?: string; data?: unknown } };
		if (message.role !== 'toolResult' || message.toolName !== 'yield' || message.details?.status !== 'success') continue;
		const data = message.details.data as { done?: unknown; summary?: unknown; verification?: unknown } | undefined;
		if (!data || typeof data.done !== 'boolean' || typeof data.summary !== 'string') continue;
		return { done: data.done, summary: data.summary, ...(typeof data.verification === 'string' ? { verification: data.verification } : {}) };
	}
	return undefined;
}

/** path -> content hash for every path git reports as changed, so later edits to an already dirty file still show. */
export async function snapshotChanges(run: Run, cwd: string): Promise<Record<string, string>> {
	const status = await run('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], cwd);
	if (status.code !== 0) throw new Error(`git status failed in ${cwd}: ${status.stderr.trim()}`);
	const entries = status.stdout.split('\0').filter(Boolean);
	const paths = new Set<string>();
	for (let index = 0; index < entries.length; index++) {
		const entry = entries[index]!;
		paths.add(entry.slice(3));
		if (entry[0] === 'R' || entry[0] === 'C') paths.add(entries[++index] ?? '');
	}
	paths.delete('');
	return hashPaths(run, cwd, [...paths]);
}

/** path -> content hash, or 'deleted' when the path is gone. */
export async function hashPaths(run: Run, cwd: string, paths: readonly string[]): Promise<Record<string, string>> {
	const snapshot: Record<string, string> = {};
	const present: string[] = [];
	for (const path of paths) {
		if (existsSync(join(cwd, path))) present.push(path);
		else snapshot[path] = 'deleted';
	}
	for (let offset = 0; offset < present.length; offset += 100) {
		const chunk = present.slice(offset, offset + 100);
		const hashed = await run('git', ['hash-object', '--', ...chunk], cwd);
		if (hashed.code !== 0) throw new Error(`git hash-object failed in ${cwd}: ${hashed.stderr.trim()}`);
		const hashes = hashed.stdout.trim().split('\n');
		chunk.forEach((path, i) => { snapshot[path] = hashes[i] ?? ''; });
	}
	return snapshot;
}

/**
 * Everything a worker's mutating tools were asked to touch, one `<tool>\t<json>` line per call: the evidence for who made a stray file.
 * Edit and write calls record only their target paths: a doc edit that cites `crates/x/src/lib.rs` in its text did not edit that file.
 */
export function mutationText(messages: readonly unknown[]): string {
	const parts: string[] = [];
	for (const message of messages) {
		const content = (message as { role?: string; content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		for (const block of content as Array<{ type?: string; name?: string; arguments?: unknown }>) {
			if (block.type !== 'toolCall' || (block.name !== 'edit' && block.name !== 'write' && block.name !== 'bash')) continue;
			const targets = block.name === 'bash' ? undefined : writeTargets(block.arguments);
			parts.push(`${block.name}\t${JSON.stringify(targets ?? block.arguments ?? {})}`);
		}
	}
	return parts.join('\n');
}

/** Paths an edit/write call writes: path-style arguments, hashline `[path#TAG]` section headers and `MV` destinations. Undefined for an unknown shape. */
function writeTargets(args: unknown): string[] | undefined {
	if (!args || typeof args !== 'object') return undefined;
	const a = args as Record<string, unknown>;
	const targets: string[] = [];
	for (const key of ['path', 'file_path', 'filePath']) if (typeof a[key] === 'string') targets.push(a[key] as string);
	if (typeof a.input === 'string') {
		for (const match of a.input.matchAll(/^\[([^\]\n#]+)#[0-9A-Fa-f]{4}\]/gm)) targets.push(match[1]!);
		for (const match of a.input.matchAll(/^MV\s+"?([^"\n]+?)"?\s*$/gm)) targets.push(match[1]!);
	}
	return targets.length ? targets : undefined;
}

function mentions(text: string, path: string): boolean {
	return text.includes(path);
}

/** Named by an edit or write call: unlike a bash line, which is as often `grep path` as `sed -i path`, that is authorship. */
function edited(text: string, path: string): boolean {
	return text.split('\n').some(line => (line.startsWith('edit\t') || line.startsWith('write\t')) && line.includes(path));
}

export function changedSince(before: Record<string, string>, after: Record<string, string>): string[] {
	const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...paths].filter(path => before[path] !== after[path]).sort();
}

const defaultFactory: SessionFactory = async request => {
	const { ctx, model } = request;
	// Unlisted: a worker session must never become what `omp -c` resumes in the coordinator's terminal.
	const manager = await openUnlistedSession(request.worker.cwd, request.sessionDir, request.resumeFile);
	const { session } = await createAgentSession({
		cwd: request.worker.cwd, authStorage: ctx.modelRegistry.authStorage, modelRegistry: ctx.modelRegistry, model, ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel as never } : {}),
		...(request.contextFiles ? { contextFiles: request.contextFiles } : {}),
		appendSystemPrompt: request.system,
		hasUI: false, enableLsp: false, enableMCP: false, enableIrc: false, skipPythonPreflight: true,
		disableExtensionDiscovery: true, bindProcessState: false, skills: [], rules: [], promptTemplates: [], slashCommands: [], customTools: [],
		toolNames: ['read', 'edit', 'write', 'bash', 'grep', 'glob', 'find'], restrictToolNames: true,
		requireYieldTool: true, outputSchema: RESULT_SCHEMA,
		agentId: request.worker.beadId, agentDisplayName: `mission ${request.worker.beadId}`, parentAgentId: 'Main', taskDepth: 1,
		agentRegistry: AgentRegistry.global(), sessionManager: manager,
		// A worker has no wait tool and its turn ends at yield, so a command moved to a background job left it
		// yielding "not done: waiting" while the job still ran. Long commands block instead.
		settings: Settings.isolated({ 'advisor.enabled': false, 'autolearn.enabled': false, 'tools.approvalMode': 'yolo', 'bash.autoBackground.enabled': false, 'async.enabled': false, ...reviewFallbackSettings() }),
	});
	return { session: session as unknown as SubagentSession, file: manager.getSessionFile() ?? '' };
};

/**
 * Runs one bead per in-process OMP subagent. The runner claims the bead before the session
 * starts and closes it from the worker's yielded result after checking the edits stayed inside
 * the bead's allowed paths, so the worker never touches bd. Sessions are persisted, so after an
 * OMP restart a lost worker is resumed from its transcript or, failing that, its claim released.
 */
export class SubagentRunner implements SubagentPort {
	readonly #live = new Map<string, Live>();
	readonly #o: SubagentRunnerOptions;
	readonly #factory: SessionFactory;

	constructor(options: SubagentRunnerOptions) {
		this.#o = options;
		this.#factory = options.sessionFactory ?? defaultFactory;
	}

	isLive(beadId: string): boolean { return this.#live.has(beadId); }

	/** Resolves once the bead's session has ended and its outcome was reported. */
	whenDone(beadId: string): Promise<void> { return this.#live.get(beadId)?.done ?? Promise.resolve(); }

	#env(mission: Mission, worker: Worker): Record<string, string> {
		return { BEADS_ACTOR: worker.beadId, BEADS_DIR: mission.workspace.beadsDir ?? '' };
	}
	#dir(mission: Mission): string { return join(this.#o.agentDir, 'missions', mission.workspace.key, 'workers'); }
	#baselineFile(mission: Mission, worker: Worker): string { return join(this.#dir(mission), `${worker.beadId}.baseline.json`); }

	async launch(mission: Mission, worker: Worker): Promise<{ handle: string; incarnationId: string }> {
		if (this.#live.has(worker.beadId)) throw new Error(`a worker is already running for ${worker.beadId}`);
		const claimed = await this.#o.run('bd', ['update', worker.beadId, '--claim', '--json'], worker.cwd, this.#env(mission, worker));
		if (claimed.code !== 0) throw new Error(`claim failed for ${worker.beadId}: ${(claimed.stderr || claimed.stdout).trim().slice(0, 300)}`);
		try { return await this.#start(mission, worker, undefined, undefined); }
		catch (error) { await this.release(mission, worker).catch(() => {}); throw error; }
	}

	/** Reopens a worker session that was lost to a restart. False means there is nothing to reopen. */
	async resume(mission: Mission, worker: Worker, note?: string): Promise<boolean> {
		if (this.#live.has(worker.beadId)) return true;
		const file = worker.incarnationId;
		if (!file || !existsSync(file)) return false;
		try { await this.#start(mission, worker, file, note); return true; }
		catch { return false; }
	}

	async release(mission: Mission, worker: Worker): Promise<void> {
		const result = await this.#o.run('bd', ['unclaim', worker.beadId, '--if-assignee', worker.beadId, '--json'], worker.cwd, this.#env(mission, worker));
		if (result.code !== 0 && !/not claimed|no assignee|already/i.test(result.stderr + result.stdout)) throw new Error(`could not release ${worker.beadId}: ${(result.stderr || result.stdout).trim().slice(0, 200)}`);
	}

	async steer(beadId: string, text: string): Promise<void> {
		const live = this.#live.get(beadId);
		if (!live) throw new Error(`no live subagent for ${beadId}; it is resumed or replaced on the next refresh`);
		await live.session.steer(text);
	}

	async abort(beadId: string): Promise<void> {
		const live = this.#live.get(beadId);
		if (!live) return;
		live.aborting = true;
		await live.session.abort();
		await live.done.catch(() => {});
	}

	async abortAll(): Promise<void> {
		await Promise.all([...this.#live.keys()].map(id => this.abort(id)));
	}

	async #start(mission: Mission, worker: Worker, resumeFile: string | undefined, note: string | undefined): Promise<{ handle: string; incarnationId: string }> {
		const ctx = this.#o.context();
		if (!ctx?.model || !ctx.modelRegistry) throw new Error('coordinator model/registry unavailable');
		const config = this.#o.config();
		const roleValue = mission.modelOverrides?.worker ?? roleModelString(config.workerRole);
		const model = missionModel(mission, 'worker', config.workerRole, ctx);
		const thinkingLevel = roleThinkingLevel(roleValue);
		const dir = this.#dir(mission);
		await mkdir(dir, { recursive: true });
		const baselineFile = this.#baselineFile(mission, worker);
		let baseline: Record<string, string>;
		if (resumeFile && existsSync(baselineFile)) baseline = JSON.parse(await readFile(baselineFile, 'utf8')) as Record<string, string>;
		else { baseline = await snapshotChanges(this.#o.run, worker.cwd); await writeFile(baselineFile, JSON.stringify(baseline)); }
		const contextFiles = await contextFilesFor(config.workerContext, worker.cwd, this.#o.agentDir);
		const { session, file } = await this.#factory({ mission, worker, ctx, model, system: WORKER_SYSTEM, contextFiles, resumeFile, sessionDir: dir, thinkingLevel });
		const live: Live = { beadId: worker.beadId, session, baseline, aborting: false, done: Promise.resolve() };
		this.#live.set(worker.beadId, live);
		const first = !resumeFile
			? worker.assignment
			: note ?? 'Your session was interrupted by an OMP restart. Check git status and the diff of your allowed paths to see your progress, continue from there, and finish by calling yield.';
		live.done = this.#drive(live, mission, worker, first);
		return { handle: worker.beadId, incarnationId: file || worker.beadId };
	}

	async #drive(live: Live, mission: Mission, worker: Worker, first: string): Promise<void> {
		let outcome: Settled | undefined;
		try {
			await live.session.prompt(first, { expandPromptTemplates: false });
			for (let reminder = 0; reminder < 2 && !live.aborting && !extractYield(live.session.state.messages); reminder++) {
				await live.session.prompt('You have not called yield. Finish now: call yield with {"done":true|false,"summary":"..."}.', { expandPromptTemplates: false });
			}
			if (live.aborting) return;
			outcome = await this.#finish(live, mission, worker);
		} catch (error) {
			if (live.aborting) return;
			outcome = { ok: false, error: `worker session failed: ${error instanceof Error ? error.message : String(error)}` };
		} finally {
			await this.#writeMentions(mission, worker, mutationText(live.session.state.messages));
			this.#live.delete(live.beadId);
			await live.session.dispose().catch(() => {});
		}
		if (outcome) this.#o.onSettled(live.beadId, outcome);
	}

	#gitQueue: Promise<unknown> = Promise.resolve();
	/** Concurrent workers share one git index; serialise writes to it. */
	#serial<T>(task: () => Promise<T>): Promise<T> {
		const next = this.#gitQueue.then(task, task);
		this.#gitQueue = next.catch(() => {});
		return next;
	}

	#mentionsFile(mission: Mission, worker: Worker): string { return join(this.#dir(mission), `${worker.beadId}.mentions.txt`); }
	async #writeMentions(mission: Mission, worker: Worker, text: string): Promise<void> {
		try { await writeFile(this.#mentionsFile(mission, worker), text); } catch { /* attribution evidence is best effort */ }
	}
	async #readMentions(mission: Mission, worker: Worker): Promise<string> {
		try { return await readFile(this.#mentionsFile(mission, worker), 'utf8'); } catch { return ''; }
	}

	async #finish(live: Live, mission: Mission, worker: Worker): Promise<Settled> {
		const result = extractYield(live.session.state.messages);
		if (!result) return { ok: false, error: 'worker ended without yielding a result' };
		if (!result.done) return { ok: false, error: `worker reported it is not done: ${result.summary.slice(0, 400)}` };
		const owned = (beadId: string, files: readonly string[]) => [...files, ...(mission.scopes[beadId] ?? [])];
		const mine = owned(worker.beadId, worker.files);
		const sibling = mission.workers.filter(other => other.beadId !== worker.beadId).flatMap(other => owned(other.beadId, other.files));
		const dirty = await snapshotChanges(this.#o.run, worker.cwd);
		// A path that left git status was committed (a repair finishing the base merge commits every auto-merged base file):
		// it changed only if its content differs from the baseline.
		const after = { ...dirty, ...await hashPaths(this.#o.run, worker.cwd, Object.keys(live.baseline).filter(path => !(path in dirty))) };
		const changed = changedSince(live.baseline, after);
		const mutations = mutationText(live.session.state.messages);
		const others: string[] = [];
		for (const other of mission.workers) {
			if (other.beadId === worker.beadId) continue;
			const running = this.#live.get(other.beadId);
			others.push(running ? mutationText(running.session.state.messages) : await this.#readMentions(mission, other));
		}
		// A sibling scope, including one rebound after dispatch, is that sibling's edit. A shared lockfile in both scopes is neither worker's stray. Basename matches are not attribution: lib.rs is not crates/http/src/lib.rs.
		// Workers share one checkout, so reading a sibling's file in bash is not editing it: a path another worker wrote with edit/write is that worker's unless this one did too.
		const blamed = (path: string) => edited(mutations, path) || (mentions(mutations, path) && !others.some(text => edited(text, path)));
		const unowned = outOfScope(changed, [...mine, ...sibling]).filter(path => blamed(path) || !others.some(text => mentions(text, path)));
		const crossed = outOfScope(changed, mine).filter(path => inScope(path, sibling) && blamed(path));
		const stray = [...new Set([...unowned, ...crossed])];
		if (stray.length) return { ok: false, error: `edits outside the allowed paths (${stray.slice(0, 8).join(', ')}${stray.length > 8 ? ', …' : ''}); bead left open for review` };
		// Review diffs only see new files once they are staged, and staging is bookkeeping, not judgment: do it here instead of
		// spending a model call (a full ~10k-token prefix re-read) on it. Only this worker's own paths, never a sibling's work in progress.
		// A path already committed has nothing to stage. A deleted path goes through `git rm --cached --ignore-unmatch`:
		// `git add` rejects a path gone from both index and disk, which is exactly a deletion already staged.
		const own = changed.filter(path => inScope(path, worker.files) && path in dirty);
		const present = own.filter(path => dirty[path] !== 'deleted');
		const gone = own.filter(path => dirty[path] === 'deleted');
		const stage = async (args: string[]) => {
			const staged = await this.#serial(() => this.#o.run('git', args, worker.cwd));
			return staged.code === 0 ? undefined : `git ${args[0]} failed: ${(staged.stderr || staged.stdout).trim().slice(0, 300)}`;
		};
		const failed = (present.length ? await stage(['add', '-A', '--', ...present]) : undefined)
			?? (gone.length ? await stage(['rm', '-r', '--cached', '--quiet', '--ignore-unmatch', '--', ...gone]) : undefined);
		if (failed) return { ok: false, error: failed };
		const reason = [result.summary, result.verification ? `Verified: ${result.verification}` : ''].filter(Boolean).join('\n').slice(0, 4000);
		const closed = await this.#o.run('bd', ['close', worker.beadId, '--reason', reason, '--json'], worker.cwd, this.#env(mission, worker));
		if (closed.code !== 0) return { ok: false, error: `bd close failed: ${(closed.stderr || closed.stdout).trim().slice(0, 300)}` };
		return { ok: true, summary: result.summary };
	}
}
