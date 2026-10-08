import { afterEach, beforeEach, expect, test } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import { captureRevision, Reviewer, type BeadReviewTarget, type ReviewOpener } from '../src/review';
import type { Mission, Run } from '../src/types';
import { loadMission, saveMission, validateMission } from '../src/store';

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
  const m: Mission = { version: 1, id: 'm', source: { kind: 'freeform', id: 'm', title: 'T', body: '', comments: '', extra: '' }, workspace: { key: 'k', cwd: root, delivery: 'local', base: 'HEAD', commonDir: join(root, '.git') }, graph: 'beads', scopes: { 'bd-a': ['a/**'], 'bd-b': ['b/**'] }, phase: 'review', evidence: {}, mode: 'auto', keep: false, reviewRequested: true, workers: [], reviews: [], repairLinks: {}, round: 1, createdAt: 'now', updatedAt: 'now' };
  m.evidence.verify = { outcome: 'passed', detail: 'ok', revision: (await captureRevision(m, real)).revision, at: 'now' };
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
/** Bead id of a recorded payload: undefined for the integration pass. Checked with `in`, not casts. */
const beadOf = (payload: Record<string, unknown>): string | undefined =>
  'bead' in payload && payload.bead && typeof payload.bead === 'object' && 'id' in payload.bead && typeof payload.bead.id === 'string' ? payload.bead.id : undefined;

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
  const first = await new Reviewer(opener([], payload => ({ summary: 's', findings: beadOf(payload)==='bd-a' ? [finding('f1')] : [] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  m.reviews.push(first);
  m.round = 2;
  await writeFile(join(root, 'a', 'one.txt'), 'repaired a');
  m.evidence.verify = { outcome: 'passed', detail: 'ok', revision: (await captureRevision(m, real)).revision, at: '' };
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  const second = await new Reviewer(opener(sent, () => ({ summary: 'clean', findings: [] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(sent).toHaveLength(1);
  expect((sent[0]!.payload.bead as { id: string }).id).toBe('bd-a');
  const decisions = sent[0]!.payload.priorDecisions as Array<{ id: string; status: string }>;
  expect(decisions.map(f => f.id)).toEqual(['bd-a:f1']);
  expect(decisions[0]!.status).toBe('open');
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
  const m = await missionAt();
  const round = await new Reviewer(opener([], payload => ({ summary: 's', findings: beadOf(payload)==='bd-a' ? [finding('f1')] : [] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  m.reviews.push(round);
  const now = new Date().toISOString();
  m.createdAt = m.updatedAt = now;
  m.evidence.verify!.at = now;
  const reloaded = validateMission(JSON.parse(JSON.stringify(m)));
  expect(reloaded.reviews[0]!.beads).toEqual(round.beads);
  expect(reloaded.reviews[0]!.findings.some(f => f.beadId === 'bd-a')).toBe(true);
});

test('each reviewer is reported as running then closed, and its transcript file is recorded on the round', async () => {
  const m = await missionAt();
  const events: string[] = [];
  const withFile: ReviewOpener = async (...args) => ({ ...(await opener([], () => ({ summary: 'ok', findings: [] }))(...args)), file: `/transcripts/${args[6]?.label}.jsonl` });
  const round = await new Reviewer(withFile, { progress: event => events.push(`${event.label}:${event.state}`) }).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(round.transcripts).toEqual({ 'bd-a': '/transcripts/bd-a.jsonl', 'bd-b': '/transcripts/bd-b.jsonl', integration: '/transcripts/integration.jsonl' });
  for (const label of ['bd-a', 'bd-b', 'integration']) expect(events.filter(event => event.startsWith(`${label}:`))).toEqual([`${label}:running`, `${label}:closed`]);
});

test('a reviewer that fails is reported as error', async () => {
  const m = await missionAt();
  const events: string[] = [];
  const failing: ReviewOpener = async (...args) => {
    const session = await opener([], () => ({ summary: 's', findings: [] }))(...args);
    if (args[6]?.label === 'bd-b') (session.session as { prompt: unknown }).prompt = async () => { throw new Error('model unavailable'); };
    return session;
  };
  await expect(new Reviewer(failing, { progress: event => events.push(`${event.label}:${event.state}`) }).runPerBead(m, ctx, real, 'default', undefined, targets)).rejects.toThrow(/\[bd-b\] model unavailable/);
  expect(events).toContain('bd-b:error');
  expect(events).toContain('bd-a:closed');
});

/** One checked hop into a payload object; returns undefined when the field is not an object. */
const dig = (value: unknown, key: string): unknown =>
  value && typeof value === 'object' && key in value ? (value as Record<string, unknown>)[key] : undefined;

test('a repair bead owns contested files and carries the current contract, so each file is reviewed once', async () => {
  await writeFile(join(root, 'a', 'one.txt'), 'conflict');
  const m = await missionAt();
  m.source.body = 'duplicate creates return HTTP 400';
  m.repairLinks['bd-r'] = ['bd-a:f1'];
  const three: BeadReviewTarget[] = [targets[0]!, targets[1]!, { id: 'bd-r', title: 'Repair', text: 'fix bd-a:f1: return 409 on conflict', files: ['a/**'] }];
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  const round = await new Reviewer(opener(sent, () => ({ summary: 's', findings: [] }))).runPerBead(m, ctx, real, 'default', undefined, three);
  const byBead = (id: string) => sent.find(item => beadOf(item.payload) === id);
  expect(byBead('bd-a')).toBeUndefined();
  expect(byBead('bd-r')!.payload.files).toEqual(['a/one.txt']);
  expect(byBead('bd-b')!.payload.files).toEqual(['b/two.txt']);
  expect(Object.keys(round.beads!)).toContain('bd-a');
});

test('accepted repairs retain distinct same-site findings', async () => {
  const m = await missionAt();
  m.source.body = 'duplicate creates return HTTP 400';
  const first = await new Reviewer(opener([], payload => ({ summary: 's', findings: beadOf(payload)==='bd-a' ? [finding('f1'), { ...finding('f2'), title: 'expect 409' }] : [] }))).runPerBead(m, ctx, real, 'default', undefined, targets);
  m.reviews.push(first);
  m.round = 2;
  m.repairLinks['bd-r'] = ['bd-a:f2'];
  const second = await new Reviewer(opener([], () => ({ summary: 's', findings: [{ ...finding('f3'), title: 'conflict returns 409 now' }] }))).runPerBead(m, ctx, real, 'default', undefined, [targets[0]!, targets[1]!, { id: 'bd-r', title: 'R', text: 'repair f2', files: ['a/**'] }]);
  m.reviews.push(second);
  m.round = 3;
  m.repairLinks['bd-r2'] = ['bd-r:f3'];
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  await new Reviewer(opener(sent, () => ({ summary: 's', findings: [] }))).runPerBead(m, ctx, real, 'default', undefined, [targets[0]!, targets[1]!, { id: 'bd-r2', title: 'R2', text: 'repair f3', files: ['a/**'] }]);
  expect(sent).toHaveLength(1);
  const decisions = sent[0]!.payload.priorDecisions as Array<Record<string, unknown>>;
  const byId = new Map(decisions.map(d => [d.id, d]));
  expect(byId.get('bd-a:f2')).toMatchObject({ status: 'accepted-repair-decision', repairedBy: ['bd-r'] });
  expect(byId.get('bd-a:f1')).toMatchObject({ status: 'open' });
  expect(byId.get('bd-r:f3')).toMatchObject({ status: 'accepted-repair-decision', repairedBy: ['bd-r2'] });
});

test('a reviewer cannot attach another bead file to itself',async()=>{
 await writeFile(join(root,'a','one.txt'),'changed a');
 await writeFile(join(root,'b','two.txt'),'changed b');
 const m=await missionAt();
 const round=await new Reviewer(opener([],payload=>({summary:'s',findings:beadOf(payload)==='bd-b'?[finding('foreign'),{...finding('own'),id:'own',path:'b/two.txt'},{...finding('nope'),id:'nope',path:'missing.txt'}]:[]}))).runPerBead(m,ctx,real,'default',[],targets);
 expect(round.findings.map(finding=>finding.id).sort()).toEqual(['bd-a:foreign','bd-b:own']);
 expect(round.findings.find(finding=>finding.id==='bd-a:foreign')).toMatchObject({beadId:'bd-a',path:'a/one.txt'});
 expect(round.summary).toContain('bd-b moved a/one.txt to bd-a');
 expect(round.summary).toContain('bd-b dropped missing.txt');
 expect(m.reviewProgress).toBeUndefined();
});

test('integration keeps a distinct same-line defect but still drops the exact duplicate', async () => {
  await writeFile(join(root, 'a', 'one.txt'), 'changed a');
  const m = await missionAt();
  const answer = (payload: Record<string, unknown>) => {
    const bead = beadOf(payload);
    if (bead === 'bd-a') return { summary: 's', findings: [finding('f1')] };
    if (bead) return { summary: 's', findings: [] };
    return { summary: 's', findings: [finding('dup'), { ...finding('other'), title: 'different bug same line' }, { ...finding('same-title'), body: 'A different defect despite the same generic title' }] };
  };
  const round = await new Reviewer(opener([], answer)).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(round.findings.map(f => f.id)).toEqual(['bd-a:f1', 'integration:other', 'integration:same-title']);
});

test('one failed target keeps finished outputs and a retry reruns only the failed target', async () => {
  const m = await missionAt();
  const checkpoints: string[] = [];
  const failing: ReviewOpener = async (...args) => {
    const opened = await opener([], () => ({ summary: `ok ${args[6]?.label}`, findings: [{ ...finding('f1'), title: `bug ${args[6]?.label}` }] }))(...args);
    if (args[6]?.label === 'bd-b') opened.session.prompt = async () => { throw new Error('model unavailable'); };
    return { ...opened, file: `/t/${args[6]?.label}.jsonl` };
  };
  const watch = { checkpoint: async () => { checkpoints.push(JSON.stringify(m.reviewProgress)); } };
  await expect(new Reviewer(failing, watch).runPerBead(m, ctx, real, 'default', undefined, targets)).rejects.toThrow(/\[bd-b\] model unavailable \(review incomplete; failed targets: bd-b\)/);
  expect(m.reviews).toHaveLength(0);
  expect(Object.keys(m.reviewProgress!.targets).sort()).toEqual(['bd-a', 'integration']);
  expect(m.reviewProgress!.failures['bd-b']).toBe('model unavailable');
  expect(m.reviewProgress!.targets['bd-a']!.transcript).toBe('/t/bd-a.jsonl');
  expect(m.reviewProgress!.inputs['bd-b']).toBeTruthy();
  expect(checkpoints.length).toBeGreaterThanOrEqual(2);
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  const round = await new Reviewer(opener(sent, () => ({ summary: 's', findings: [] })), watch).runPerBead(m, ctx, real, 'default', undefined, targets);
  expect(sent.map(item => beadOf(item.payload) ?? 'integration')).toEqual(['bd-b']);
  expect(round.summary).toContain('[bd-a] ok bd-a');
  expect(round.summary).toContain('[integration] ok integration');
  expect(round.findings.map(f => f.id)).toEqual(['bd-a:f1', 'integration:f1']);
  expect(round.transcripts!['bd-a']).toBe('/t/bd-a.jsonl');
  expect(m.reviewProgress).toBeUndefined();
});

for(const changed of ['revision','model','task','context'] as const)test(`changed ${changed} invalidates completed cached targets`, async () => {
  const m = await missionAt();
  let context = [{path: '/review-rules.md', content: 'Original rules'}];
  let model = ctx;
  let tasks = targets;
  const failing: ReviewOpener = async (...args) => {
    const opened = await opener([], () => ({ summary: 's', findings: [] }))(...args);
    if (args[6]?.label === 'bd-b') opened.session.prompt = async () => { throw new Error('boom'); };
    return opened;
  };
  await expect(new Reviewer(failing).runPerBead(m, model, real, 'default', context, tasks)).rejects.toThrow(/boom/);
  if(changed==='revision'){
    await writeFile(join(root, 'a', 'one.txt'), 'edited');
    m.evidence.verify = { outcome: 'passed', detail: 'ok', revision: (await captureRevision(m, real)).revision, at: '' };
  }else if(changed==='model')model={ model: { provider: 'p', id: 'm2' }, modelRegistry: { getAvailable: () => [] } } as unknown as ExtensionContext;
  else if(changed==='task')tasks=[{...targets[0]!,text:'Task A revised'},targets[1]!];
  else context=[{path:'/review-rules.md',content:'Revised rules'}];
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  await new Reviewer(opener(sent, () => ({ summary: 's', findings: [] }))).runPerBead(m, model, real, 'default', context, tasks);
  expect(sent.map(item => beadOf(item.payload) ?? 'integration')).toEqual(['bd-a', 'bd-b', 'integration']);
});

test('review progress survives save/load and still scopes the retry', async () => {
  const m = await missionAt();
  const failing: ReviewOpener = async (...args) => {
    const opened = await opener([], () => ({ summary: 'kept', findings: [finding('f1')] }))(...args);
    if (args[6]?.label === 'bd-b') opened.session.prompt = async () => { throw new Error('boom'); };
    return opened;
  };
  await expect(new Reviewer(failing).runPerBead(m, ctx, real, 'default', undefined, targets)).rejects.toThrow(/boom/);
  const dir = await mkdtemp(join(tmpdir(), 'mission-state-'));
  const file = join(dir, m.workspace.key, `${m.id}.json`);
  await saveMission(file, m);
  const reloaded = await loadMission(file);
  expect(reloaded.reviewProgress!.targets['bd-a']!.summary).toBe('kept');
  expect(reloaded.reviewProgress!.failures['bd-b']).toContain('boom');
  const sent: Array<{ note: string; payload: Record<string, unknown> }> = [];
  await new Reviewer(opener(sent, () => ({ summary: 's', findings: [] }))).runPerBead(reloaded, ctx, real, 'default', undefined, targets);
  expect(sent).toHaveLength(1);
  expect((sent[0]!.payload.bead as { id: string }).id).toBe('bd-b');
  await rm(dir, { recursive: true, force: true });
});

