import type { Mission, Run } from './types';

/**
 * Paths that would conflict merging this mission's worktree HEAD into its base
 * branch. Returns null when the check cannot run (non-Git workspace, no bound
 * base, or a git error) — the caller decides whether that blocks completion.
 */
export async function mergeConflictPaths(m: Mission, run: Run): Promise<string[] | null> {
	const base = m.workspace.base;
	if (!base || !m.workspace.commonDir) return null;
	let ref: string | undefined;
	for (const candidate of [`origin/${base}`, base]) {
		if ((await run('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], m.workspace.cwd)).code === 0) { ref = candidate; break; }
	}
	if (!ref) return null;
	const merged = await run('git', ['merge-tree', '--write-tree', '-z', '--name-only', ref, 'HEAD'], m.workspace.cwd);
	if (merged.code === 0) return [];
	if (merged.code !== 1) return null;
	// Layout: <tree OID>\0 then NUL-separated conflicted paths, ended by an empty
	// field, then per-path records we ignore.
	const fields = merged.stdout.split('\0').slice(1);
	const end = fields.indexOf('');
	return fields.slice(0, end === -1 ? fields.length : end);
}
