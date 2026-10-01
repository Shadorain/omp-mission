import { access, realpath } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { checkoutMatchesSource, displaySourceId, inspectWorkspace } from './sources';
import type { Run, Source, Workspace } from './types';

export interface IsolateInput {
	source: Source;
	/** Checkout the mission started in. */
	start: string;
	base?: string;
	delivery?: 'pr' | 'local';
	/** False: only reuse a checkout that already fits; never create a worktree. */
	create?: boolean;
}
export interface Isolated { cwd: string; base?: string; delivery: 'pr' | 'local'; created: boolean }

async function exists(path: string): Promise<boolean> {
	try { await access(path); return true; } catch { return false; }
}

export function branchSlug(source: Source): string {
	return displaySourceId(source).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

function primaryCheckout(workspace: Workspace): boolean {
	return !!workspace.commonDir && basename(workspace.commonDir) === '.git' && dirname(workspace.commonDir) === workspace.cwd;
}

/**
 * Picks the checkout workers run in: reuses one that already belongs to the ticket, or
 * creates `<repo>-mission-<slug>` on `mission/<slug>` from a primary checkout. Every
 * ambiguous case throws with the reason so the coordinator decides instead of guessing.
 */
export async function isolateCheckout(run: Run, input: IsolateInput): Promise<Isolated> {
	const { source } = input;
	const workspace = await inspectWorkspace(input.start, run, { explicitBase: input.base, githubRepo: source.repo });
	const delivery = input.delivery ?? (source.kind === 'freeform' || !workspace.commonDir ? 'local' : 'pr');
	const result = (cwd: string, created: boolean): Isolated => ({ cwd, delivery, created, ...(workspace.base ? { base: workspace.base } : {}) });
	if (!workspace.commonDir) return result(workspace.cwd, false);
	if (checkoutMatchesSource(source, workspace)) return result(workspace.cwd, false);
	if (!primaryCheckout(workspace)) {
		throw new Error(`Checkout ${workspace.cwd} is a linked worktree that does not belong to ${source.id}; pass cwd of the ticket checkout, or start from the primary checkout`);
	}
	if (input.create === false) throw new Error(`No existing checkout for ${source.id}; a mission worktree must be created explicitly`);
	if (!workspace.base) throw new Error('Repository base branch unresolved; pass base explicitly');
	const slug = branchSlug(source);
	if (!slug) throw new Error(`Cannot derive a branch name from ${source.id}`);
	const branch = `mission/${slug}`;
	const path = `${workspace.cwd}-mission-${slug}`;
	if (await exists(path)) {
		// A previous attempt created it and a later step failed: reuse only the exact worktree we would have made.
		const there = await run('git', ['branch', '--show-current'], path);
		if (there.code === 0 && there.stdout.trim() === branch) return result(await realpath(path), false);
		throw new Error(`Worktree path already exists: ${path}`);
	}
	const taken = await run('git', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], workspace.cwd);
	if (taken.code === 0) throw new Error(`Branch already exists: ${branch}`);
	let baseRef: string | undefined;
	for (const candidate of [`origin/${workspace.base}`, workspace.base]) {
		if ((await run('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], workspace.cwd)).code === 0) { baseRef = candidate; break; }
	}
	if (!baseRef) throw new Error(`Base branch ${workspace.base} not found locally or on origin`);
	const added = await run('git', ['worktree', 'add', '-b', branch, path, baseRef], workspace.cwd);
	if (added.code !== 0) throw new Error(added.stderr.trim() || `git worktree add failed (${added.code})`);
	return result(await realpath(path), true);
}

/** The canonical bead database visible from a checkout. A missing one is an error, never initialised here. */
export async function discoverBeadsDir(run: Run, cwd: string): Promise<string> {
	const found = await run('bd', ['--readonly', 'where', '--json'], cwd);
	if (found.code !== 0) {
		throw new Error(`No bead database found from ${cwd}: ${found.stderr.trim() || found.stdout.trim() || 'bd where failed'}. Initialize with bd init --stealth --skip-agents --skip-hooks --non-interactive --prefix <repository-prefix>, then retry`);
	}
	let path: unknown;
	try { path = (JSON.parse(found.stdout) as { path?: unknown }).path; } catch { path = undefined; }
	if (typeof path !== 'string' || !path) throw new Error('bd where returned no database path');
	return realpath(path);
}
