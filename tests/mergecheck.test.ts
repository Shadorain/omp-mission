import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { foreignPaths, mergeBaseInto, mergeConflictPaths } from '../src/mergecheck';
import type { Mission, Run } from '../src/types';

const run: Run = async (command, args, cwd, env) => {
	const child = Bun.spawn([command, ...args], { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
	return { stdout, stderr, code };
};
const git = async (cwd: string, ...args: string[]) => { const result = await run('git', args, cwd); if (result.code) throw new Error(result.stderr); return result.stdout.trim(); };

const mission = (cwd: string, commonDir = '.git'): Mission => ({
	version: 1, id: 'mc', graph: 'local', round: 1, mode: 'auto', keep: false, reviewRequested: true,
	phase: 'review', createdAt: 'now', updatedAt: 'now',
	source: { kind: 'freeform', id: 'mc', title: 'Merge check', body: '', comments: '', extra: '' },
	workspace: { key: 'k', cwd, commonDir, base: 'main', delivery: 'local' },
	evidence: {}, workers: [], reviews: [], repairLinks: {}, scopes: {},
});

let root: string;
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), 'mergecheck-'));
	await run('git', ['init', '-q', '-b', 'main', root], root);
	await git(root, 'config', 'user.email', 't@t');
	await git(root, 'config', 'user.name', 't');
	await writeFile(join(root, 'f.txt'), 'a\n');
	await writeFile(join(root, 'g.txt'), 'b\n');
	await git(root, 'add', '.');
	await git(root, 'commit', '-qm', 'init');
});
afterEach(() => rm(root, { recursive: true, force: true }));

test('conflicting merge names each contested path', async () => {
	await git(root, 'checkout', '-qb', 'feat');
	await writeFile(join(root, 'f.txt'), 'feat\n');
	await writeFile(join(root, 'g.txt'), 'feat\n');
	await git(root, 'add', '.');
	await git(root, 'commit', '-qm', 'feat');
	await git(root, 'checkout', '-q', 'main');
	await writeFile(join(root, 'f.txt'), 'main\n');
	await writeFile(join(root, 'g.txt'), 'main\n');
	await git(root, 'add', '.');
	await git(root, 'commit', '-qm', 'main');
	await git(root, 'checkout', '-q', 'feat');
	const conflicts = await mergeConflictPaths(mission(root), run);
	expect(conflicts?.sort()).toEqual(['f.txt', 'g.txt']);
	// The probe never touches the worktree.
	expect(await git(root, 'status', '--porcelain')).toBe('');
});

test('clean merge returns an empty list', async () => {
	await git(root, 'checkout', '-qb', 'feat');
	await writeFile(join(root, 'h.txt'), 'new\n');
	await git(root, 'add', '.');
	await git(root, 'commit', '-qm', 'feat');
	expect(await mergeConflictPaths(mission(root), run)).toEqual([]);
});

test('non-git workspace or missing base skips the check', async () => {
	expect(await mergeConflictPaths(mission(root, ''), run)).toBeNull();
	expect(await mergeConflictPaths({ ...mission(root), workspace: { ...mission(root).workspace, base: undefined } }, run)).toBeNull();
});

const beads = (cwd: string): Mission => ({ ...mission(cwd), graph: 'beads', scopes: { leaf: ['f.txt'] } });

test('a stale tree replanted onto a newer base is caught as files no bead owns', async () => {
	await git(root, 'checkout', '-qb', 'feat');
	await writeFile(join(root, 'f.txt'), 'mission\n');
	await git(root, 'commit', '-qam', 'mission work');
	expect(await foreignPaths(beads(root), run)).toEqual([]);
	await git(root, 'checkout', '-q', 'main');
	await writeFile(join(root, 'g.txt'), 'base moved on\n');
	await writeFile(join(root, 'h.txt'), 'new base file\n');
	await git(root, 'add', '.');
	await git(root, 'commit', '-qm', 'base work');
	// The coordinator's replant: the feature tree committed on top of the new base.
	const replant = await git(root, 'commit-tree', 'feat^{tree}', '-p', 'main', '-m', 'replant');
	await git(root, 'checkout', '-q', replant);
	expect((await foreignPaths(beads(root), run))?.sort()).toEqual(['g.txt', 'h.txt']);
	expect(await foreignPaths(mission(root), run)).toBeNull();
	expect(await foreignPaths({ ...beads(root), scopes: {} }, run)).toBeNull();
});

test('merging the base integrates it with a merge commit, or stops on conflicts with markers in place', async () => {
	await git(root, 'checkout', '-qb', 'feat');
	await writeFile(join(root, 'f.txt'), 'mission\n');
	await git(root, 'commit', '-qam', 'mission work');
	await git(root, 'checkout', '-q', 'main');
	await writeFile(join(root, 'g.txt'), 'base\n');
	await git(root, 'commit', '-qam', 'base work');
	await git(root, 'checkout', '-q', 'feat');
	expect(await mergeBaseInto(beads(root), run)).toEqual({ ref: 'main', merged: true, conflicts: [] });
	expect(await git(root, 'show', 'HEAD:g.txt')).toBe('base');
	expect(await foreignPaths(beads(root), run)).toEqual([]);
	expect(await mergeBaseInto(beads(root), run)).toEqual({ ref: 'main', merged: false, conflicts: [] });
	await git(root, 'checkout', '-q', 'main');
	await writeFile(join(root, 'f.txt'), 'base edit\n');
	await git(root, 'commit', '-qam', 'base edits f');
	await git(root, 'checkout', '-q', 'feat');
	expect(await mergeBaseInto(beads(root), run)).toEqual({ ref: 'main', merged: false, conflicts: ['f.txt'] });
	expect(await run('git', ['rev-parse', '-q', '--verify', 'MERGE_HEAD'], root)).toMatchObject({ code: 0 });
});
