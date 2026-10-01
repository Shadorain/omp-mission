import { afterEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { contextFilesFor } from '../src/context';

const dirs: string[] = [];
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function layout() {
  const root = await mkdtemp(join(tmpdir(), 'ctx-'));
  dirs.push(root);
  const cwd = join(root, 'checkout');
  const agentDir = join(root, 'agent');
  await mkdir(cwd);
  await mkdir(agentDir);
  return { cwd, agentDir };
}

test('project mode keeps the user rules and the checkout rules, preferring AGENTS.md over CLAUDE.md', async () => {
  const { cwd, agentDir } = await layout();
  await writeFile(join(agentDir, 'AGENTS.md'), 'use cargo auto');
  await writeFile(join(cwd, 'AGENTS.md'), 'repo rules');
  await writeFile(join(cwd, 'CLAUDE.md'), 'other');
  expect((await contextFilesFor('project', cwd, agentDir))!.map(file => file.content)).toEqual(['use cargo auto', 'repo rules']);
});

test('project mode degrades to what exists: CLAUDE.md fallback, then nothing', async () => {
  const { cwd, agentDir } = await layout();
  expect(await contextFilesFor('project', cwd, agentDir)).toEqual([]);
  await writeFile(join(cwd, 'CLAUDE.md'), 'claude rules');
  expect((await contextFilesFor('project', cwd, agentDir))!.map(file => file.content)).toEqual(['claude rules']);
});

test('all defers to OMP discovery and none loads nothing', async () => {
  const { cwd, agentDir } = await layout();
  await writeFile(join(cwd, 'AGENTS.md'), 'rules');
  expect(await contextFilesFor('all', cwd, agentDir)).toBeUndefined();
  expect(await contextFilesFor('none', cwd, agentDir)).toEqual([]);
});
