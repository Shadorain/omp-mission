import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { captureRevision, Reviewer, type BeadReviewTarget, type ReviewOpener } from '../src/review';
import type { Mission, Run } from '../src/types';

const real: Run = async (command, args, cwd) => {
  const child = Bun.spawn([command, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};
let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'perbead-')));
  await mkdir(join(root, 'a'));
  await mkdir(join(root, 'b'));
  await real('git', ['init', '-q', '-b', 'main'], root);
  await real('git', ['config', 'user.email', 't@t'], root);
  await real('git', ['config', 'user.name', 't'], root);
  await writeFile(join(root, 'a', 'one.txt'), '1');
  await writeFile(join(root, 'b', 'two.txt'), '2');
  await real('git', ['add', '.'], root);
  await real('git', ['commit', '-qm', 'init'], root);
});
afterEach(() => rm(root, { recursive: true, force: true }));

const targets: BeadReviewTarget[] = [
  { id: 'bd-a', title: 'A', text: 'task A', files: ['a/**'] },
  { id: 'bd-b', title: 'B', text: 'task B', files: ['b/**'] },
];
async function missionAt(): Promise<Mission> {
  const m: Mission = { version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'T', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd: root, delivery: 'local', base: 'HEAD', commonDir: join(root, '.git') }, graph: 'beads', scopes: { 'bd-a': ['a/**'], 'bd-b': ['b/**'] }, phase: 'review', evidence: {}, mode: 'auto', keep: false, reviewRequested: true, workers: [], reviews: [], repairLinks: {}, round: 1, createdAt: '', updatedAt: '' };
  m.evidence.verify = { outcome: 'passed', detail: 'ok', revision: (await captureRevision(m, real)).revision, at: '' };
  return m;
}
const ctx = { model: { provider: 'p', id: 'm' }, modelRegistry: { getAvailable: () => [] } } as unknown as ExtensionContext;

/** Each fake reviewer answers from the payload it receives, so tests see exactly what was sent. */
function opener(sent: Array<{ note: string; payload: Record<string, unknown> }>, answer: (payload: Record<string, unknown>, note: string) => { summary: string; findings: unknown[] }): ReviewOpener {
  return async (_m, _ctx, _model, _files, note) => {
    const messages: unknown[] = [];
    return {
      session: {
        state: { messages } as never,
        async prompt(text: string) {
          const payload = JSON.parse(text) as Record<string, unknown>;
          sent.push({ note, payload });
          messages.push({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ reviewedRevision: payload.reviewedRevision, ...answer(payload, note) }) }] });
        },
        async dispose() {},
      } as never,
    };
  };
}
const finding = (id: string) => ({ id, severity: 'high', path: 'a/one.txt', line: 1, title: 't', body: 'b' });

test('first round reviews every bead on its scoped diff plus one integration pass, and tags findings with their bead', async () => {
  await writeFile(join(root, 'a', 'one.txt'), 'changed a');
  await writeFile(join(root, 'b', 'two.txt'), 'changed b');
  const m = await missionAt();
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  const reviewer = new Reviewer(opener(sent, (payload, note) => ({ summary: note.includes('integration') ? 'seams fine' : `ok ${(payload.bead as { id: string }).id}`, findings: (payload.bead as { id?: string } | undefined)?.id === 'bd-a' ? [finding('f1')] : [] })));
  const round = await reviewer.runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(sent).toHaveLength(3);
  const beadA = sent.find(item => (item.payload.bead as { id?: string } | undefined)?.id === 'bd-a')!;
  expect(beadA.payload.diff).toContain('changed a');
  expect(beadA.payload.diff).not.toContain('changed b');
  expect(beadA.payload.files).toEqual(['a/one.txt']);
  expect(sent.filter(item => item.note.includes('integration'))).toHaveLength(1);
  expect(round.findings).toEqual([expect.objectContaining({ id: 'bd-a:f1', beadId: 'bd-a' })]);
  expect(round.summary).toContain('[bd-a] ok bd-a');
  expect(round.summary).toContain('[integration] seams fine');
  expect(Object.keys(round.beads!).sort()).toEqual(['bd-a', 'bd-b']);
});

test('a later round re-reviews only the beads whose files changed, with no integration pass', async () => {
  await writeFile(join(root, 'a', 'one.txt'), 'changed a');
  const m = await missionAt();
  const first = await new Reviewer(opener([], () => ({ summary: 's', findings: [finding('f1')] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  m.reviews.push(first);
  m.round = 2;
  await writeFile(join(root, 'a', 'one.txt'), 'repaired a');
  m.evidence.verify = { outcome: 'passed', detail: 'ok', revision: (await captureRevision(m, real)).revision, at: '' };
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  const second = await new Reviewer(opener(sent, () => ({ summary: 'clean', findings: [] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(sent).toHaveLength(1);
  expect((sent[0]!.payload.bead as { id: string }).id).toBe('bd-a');
  expect((sent[0]!.payload.previousFindings as Array<{ id: string }>).map(f => f.id)).toEqual(['bd-a:f1']);
  expect(second.findings).toEqual([]);
  expect(second.beads!['bd-b']).toBe(first.beads!['bd-b']);
  expect(second.beads!['bd-a']).not.toBe(first.beads!['bd-a']);
});

test('when no bead owns the change, the integration pass covers the whole revision', async () => {
  const m = await missionAt();
  const first = await new Reviewer(opener([], () => ({ summary: 's', findings: [] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  m.reviews.push(first);
  await writeFile(join(root, 'outside.txt'), 'x');
  m.evidence.verify = { outcome: 'passed', detail: 'ok', revision: (await captureRevision(m, real)).revision, at: '' };
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  await new Reviewer(opener(sent, () => ({ summary: 's', findings: [] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(sent).toHaveLength(1);
  expect(sent[0]!.note).toContain('integration');
});

test('one failed reviewer fails the whole round instead of passing a partial review', async () => {
  const m = await missionAt();
  let calls = 0;
  const failing: ReviewOpener = async (...args) => {
    const session = await opener([], () => ({ summary: 's', findings: [] }))(...args);
    if (++calls === 2) (session.session as { prompt: unknown }).prompt = async () => { throw new Error('model unavailable'); };
    return session;
  };
  await expect(new Reviewer(failing).runPerBead(m, ctx, real, 'default', undefined, targets)).rejects.toThrow(/model unavailable/);
});

/** A reviewer whose first reply echoes a slipped revision; when told the reply was rejected it answers correctly, or stays wrong if stubborn. */
function slipping(stubborn: boolean, prompts: string[]): ReviewOpener {
  return async () => {
    const messages: unknown[] = [];
    let revision = '';
    const say = (reviewedRevision: string) => messages.push({ role: 'assistant', content: [{ type: 'text', text: JSON.stringify({ reviewedRevision, summary: 'ok', findings: [] }) }] });
    return {
      session: {
        state: { messages } as never,
        async prompt(text: string) {
          prompts.push(text);
          if (text.startsWith('Your reply was rejected')) return say(stubborn ? 'still-wrong' : revision);
          revision = String((JSON.parse(text) as Record<string, unknown>).reviewedRevision);
          say(`${revision.slice(0, 8)}-slipped`);
        },
        async dispose() {},
      } as never,
    };
  };
}

test('a reply that fails to parse is corrected once in the same session instead of failing the round', async () => {
  const m = await missionAt();
  const prompts: string[] = [];
  const round = await new Reviewer(slipping(false, prompts)).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(round.summary).toContain('[bd-a] ok');
  const corrections = prompts.filter(text => text.startsWith('Your reply was rejected'));
  expect(corrections).toHaveLength(3);
  expect(corrections[0]).toContain('does not match the revision under review');
  expect(corrections[0]).toContain(round.revision);
});

test('a reply that stays invalid fails the round and names the reviewer and the reason', async () => {
  const m = await missionAt();
  await expect(new Reviewer(slipping(true, [])).runPerBead(m, ctx, real, 'default', undefined, targets)).rejects.toThrow(/^\[(bd-a|bd-b|integration)\] reviewedRevision "still-wrong" does not match the revision under review \(the reviewer was asked once to correct/);
});

test('files edited during review invalidate the round', async () => {
  const m = await missionAt();
  const sneaky = opener([], () => ({ summary: 's', findings: [] }));
  const edits: ReviewOpener = async (...args) => {
    await writeFile(join(root, 'a', 'one.txt'), 'edited mid-review');
    return sneaky(...args);
  };
  await expect(new Reviewer(edits).runPerBead(m, ctx, real, 'default', undefined, targets)).rejects.toThrow(/Files changed since verification|Revision changed/);
});

test('the integration pass does not repeat a defect a bead reviewer already owns, but keeps its own', async () => {
  await writeFile(join(root, 'a', 'one.txt'), 'changed a');
  const m = await missionAt();
  const answer = (payload: Record<string, unknown>) => {
    const bead = (payload.bead as { id?: string } | undefined)?.id;
    if (bead === 'bd-a') return { summary: 's', findings: [finding('f1')] };
    if (bead) return { summary: 's', findings: [] };
    return { summary: 's', findings: [finding('dup'), { ...finding('seam'), line: 9 }] };
  };
  const round = await new Reviewer(opener([], answer)).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(round.findings.map(f => [f.id, f.beadId])).toEqual([['bd-a:f1', 'bd-a'], ['integration:seam', undefined]]);
});

test('per-bead hashes and finding bead ids survive saving the mission, so the next round can be incremental', async () => {
  const { validateMission } = await import('../src/store');
  const m = await missionAt();
  const round = await new Reviewer(opener([], () => ({ summary: 's', findings: [finding('f1')] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  m.reviews.push(round);
  const now = new Date().toISOString();
  m.createdAt = m.updatedAt = now;
  m.evidence.verify!.at = now;
  const reloaded = validateMission(JSON.parse(JSON.stringify(m)));
  expect(reloaded.reviews[0]!.beads).toEqual(round.beads);
  expect(reloaded.reviews[0]!.findings.some(f => f.beadId === 'bd-a')).toBe(true);
});
