import { expect, test } from 'bun:test';
import { rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyPlanFile, planFilePath } from '../src/hosts';
import { beadTask, workerPrompt } from '../src/prompts';
import { createWorkerDriver } from '../src/workers';
import type { Bead, Mission, Worker } from '../src/types';

const bead: Bead = { id: 'b1', title: 'Add typed ids', description: 'Introduce PaymentProcessor.', acceptance: 'round-trip tests pass', status: 'open', children: [], ready: true, category: 'ready' };
const mission = (): Mission => ({ version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'm', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd: '/tmp', delivery: 'local', beadsDir: '/tmp/beads' }, graph: 'beads', scopes: {}, phase: 'execute', evidence: {}, mode: 'auto', keep: false, reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 1, createdAt: '', updatedAt: '' });
const worker: Worker = { beadId: 'b1', attempt: 'a', cwd: '/tmp', files: ['a.ts'], state: 'reserved', assignment: '' };

test('the bead text rides in the worker prompt, so no bd show round trip is needed', () => {
  const text = beadTask(bead)!;
  expect(text).toBe('Add typed ids\nIntroduce PaymentProcessor.\nAcceptance: round-trip tests pass');
  const withTask = workerPrompt(mission(), worker, 'orca', text);
  expect(withTask).toContain('Your task, from the bead:\nAdd typed ids');
  expect(withTask).not.toContain('bd show');
  expect(workerPrompt(mission(), worker, 'orca')).toContain('Read bd show b1');
});

test('a very long bead is cut rather than flooding every worker', () => {
  expect(beadTask({ ...bead, description: 'x'.repeat(20_000) })!.length).toBeLessThan(8100);
  expect(beadTask(undefined)).toBeUndefined();
});

test('dispatch hands the bead text to the prompt builder and keeps the assignment it built', async () => {
  const seen: Array<string | undefined> = [];
  const run = async (_c: string, args: string[]) => ({ code: 0, stderr: '', stdout: JSON.stringify({ ok: true, result: { terminal: { handle: 'term-x', incarnationId: 'inc-x' } } }) + (args.length ? '' : '') });
  const driver = createWorkerDriver(run, { persist: async () => {}, prompt: (_m, w, task) => { seen.push(task); return `prompt for ${w.beadId}: ${task}`; } });
  const m = mission();
  const [started] = await driver.dispatch(m, [{ beadId: 'b1', cwd: '/tmp', files: ['a.ts'], task: 'the task' }]);
  expect(seen).toEqual(['the task']);
  expect(started!.assignment).toBe('prompt for b1: the task');
});

test('workers are pointed at a shared copy of the plan only when one exists', async () => {
  const m = { ...mission(), id: `plan-note-${process.pid}` };
  const source = join(tmpdir(), `${m.id}-source.md`);
  try {
    expect(workerPrompt(m, worker, 'orca')).not.toContain('approved plan');
    await writeFile(source, '# plan');
    await copyPlanFile(m, source);
    const prompt = workerPrompt(m, worker, 'orca');
    expect(prompt).toContain(`The approved plan is in ${planFilePath(m)}`);
    expect(prompt).toContain('local://');
  } finally {
    await rm(source, { force: true });
    await rm(planFilePath(m), { force: true });
  }
});
