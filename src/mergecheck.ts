import { implementationScopes } from './coordinator-guard';
import { inScope } from './scope';
import type { Mission, Run } from './types';

async function baseRef(m: Mission, run: Run): Promise<string | undefined> {
	const base = m.workspace.base;
	if (!base) return undefined;
	for (const candidate of [`origin/${base}`, base]) {
		if ((await run('git', ['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], m.workspace.cwd)).code === 0) return candidate;
	}
	return undefined;
}

/**
 * Committed paths the branch changes against its base that no bead scope or worker owns. Workers can
 * only change scoped files, so anything else is foreign: a stale tree replanted onto a newer base
 * reverts every base change since, and each reverted file shows up here. Null when the check cannot
 * run (local graph, no scopes, non-Git workspace, unresolved base).
 */
export async function foreignPaths(m: Mission, run: Run): Promise<string[] | null> {
	if (m.graph === 'local' || !m.workspace.commonDir) return null;
	const scopes = implementationScopes(m);
	if (!scopes.length) return null;
	const ref = await baseRef(m, run);
	if (!ref) return null;
	const fork = await run('git', ['merge-base', 'HEAD', ref], m.workspace.cwd);
	if (fork.code || !fork.stdout.trim()) return null;
	const diff = await run('git', ['diff', '--name-only', '-z', '--no-renames', fork.stdout.trim(), 'HEAD'], m.workspace.cwd);
	if (diff.code) return null;
	return diff.stdout.split('\0').filter(path => path && !inScope(path, scopes));
}

export function foreignDetail(m: Mission, paths: readonly string[]): string {
	const shown = paths.slice(0, 12).join(', ');
	const more = paths.length > 12 ? ` and ${paths.length - 12} more` : '';
	return `Branch changes ${paths.length} file${paths.length === 1 ? '' : 's'} no bead owns (${shown}${more}): not mission work. A tree rebuilt onto a newer base reverts that base's changes. Bind a leaf scoped to exactly these paths that restores their ${m.workspace.base} content, dispatch it, then verify again. Integrate the base only with mission_control merge_base; never rebuild commits with git plumbing.`;
}

/**
 * Merges the bound base into the mission branch with a merge commit. The coordinator's guard forbids
 * `git merge`, so this is the only sanctioned way to integrate a base that moved on. A conflicted merge
 * is left in progress with markers in place for a scoped repair leaf to resolve.
 */
export async function mergeBaseInto(m: Mission, run: Run): Promise<{ ref: string; merged: boolean; conflicts: string[] }> {
	if (m.workspace.base) await run('git', ['fetch', '--quiet', 'origin', m.workspace.base], m.workspace.cwd);
	const ref = await baseRef(m, run);
	if (!ref) throw new Error('Bound base branch unresolved; bind the workspace base first');
	const before = (await run('git', ['rev-parse', 'HEAD'], m.workspace.cwd)).stdout.trim();
	const merged = await run('git', ['merge', '--no-ff', '--no-edit', '-m', `Merge ${ref} into the mission branch`, ref], m.workspace.cwd);
	if (merged.code === 0) return { ref, merged: (await run('git', ['rev-parse', 'HEAD'], m.workspace.cwd)).stdout.trim() !== before, conflicts: [] };
	const unmerged = await run('git', ['diff', '--name-only', '-z', '--diff-filter=U'], m.workspace.cwd);
	const conflicts = unmerged.stdout.split('\0').filter(Boolean);
	if (!conflicts.length) throw new Error(`git merge ${ref} refused: ${(merged.stderr || merged.stdout).trim().slice(0, 500)}`);
	return { ref, merged: false, conflicts };
}

/**
 * Paths that would conflict merging this mission's worktree HEAD into its base
 * branch. Returns null when the check cannot run (non-Git workspace, no bound
 * base, or a git error) — the caller decides whether that blocks completion.
 */
export async function mergeConflictPaths(m: Mission, run: Run): Promise<string[] | null> {
	if (!m.workspace.commonDir) return null;
	const ref = await baseRef(m, run);
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
