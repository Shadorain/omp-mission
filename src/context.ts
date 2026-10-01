import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ContextMode } from './types';

export interface ContextFile { path: string; content: string }

const PROJECT_FILES = ['AGENTS.md', 'CLAUDE.md'];

async function readIfPresent(path: string): Promise<ContextFile | undefined> {
	try { return { path, content: await readFile(path, 'utf8') }; }
	catch (error: unknown) {
		if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
		throw error;
	}
}

/**
 * Context files an in-process session (worker or reviewer) loads. They are in the prompt
 * prefix of every request the session makes, so this is the largest fixed cost of a worker.
 * `all` returns undefined: let OMP discover everything. `project` keeps the user's own
 * cross-repo rules (`<agentDir>/AGENTS.md`, small, holds host constraints) plus the bound
 * checkout's rules file; `none` loads nothing.
 */
export async function contextFilesFor(mode: ContextMode, cwd: string, agentDir: string): Promise<ContextFile[] | undefined> {
	if (mode === 'all') return undefined;
	if (mode === 'none') return [];
	const files: ContextFile[] = [];
	const user = await readIfPresent(join(agentDir, 'AGENTS.md'));
	if (user) files.push(user);
	for (const name of PROJECT_FILES) {
		const project = await readIfPresent(join(cwd, name));
		if (project) { files.push(project); break; }
	}
	return files;
}
