import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {alignVerifiedRevision,captureRevision,parseReview,reviewBudgetMs} from '../src/review';
import type {Mission,Run} from '../src/types';
import {validateMission} from '../src/store';
function mission(cwd:string):Mission{return {version:1,id:'review-test',source:{kind:'freeform',id:'test',title:'review',body:'behavior',comments:'',extra:''},workspace:{key:'key',cwd,delivery:'local'},scopes:{a:['a.ts']},phase:'review',mode:'pause',keep:false,reviewRequested:true,evidence:{},workers:[],reviews:[],repairLinks:{},round:1,createdAt:'now',updatedAt:'now'};}
const noRun:Run=async()=>{throw new Error('Unexpected CLI');};
test('declared local file modifications and deletion invalidate captured revision',async()=>{const cwd=await mkdtemp(join(tmpdir(),'mission-revision-'));try{await writeFile(join(cwd,'a.ts'),'broken');const m=mission(cwd);const before=await captureRevision(m,noRun);await writeFile(join(cwd,'a.ts'),'fixed');const after=await captureRevision(m,noRun);expect(after.revision).not.toBe(before.revision);await rm(join(cwd,'a.ts'));expect((await captureRevision(m,noRun)).revision).not.toBe(after.revision);}finally{await rm(cwd,{recursive:true,force:true});}});
test('local fingerprint refuses escaping scopes',async()=>{const cwd=await mkdtemp(join(tmpdir(),'mission-escape-'));try{const m=mission(cwd);m.scopes.a=['../secret'];await expect(captureRevision(m,noRun)).rejects.toThrow('escapes');}finally{await rm(cwd,{recursive:true,force:true});}});
test('the review diff is measured from the merge-base of the freshest base ref',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'mission-base-'));
 try{
  const m=mission(cwd);m.workspace={key:'key',cwd,commonDir:cwd,base:'dev',delivery:'pr'};
  const diffs:string[][]=[];let originExists=true;
  const run:Run=async(cmd,args)=>{
   if(args[0]==='merge-base')return args[2]==='origin/dev'&&originExists?{code:0,stdout:'fresh123\n',stderr:''}:args[2]==='dev'?{code:0,stdout:'stale456\n',stderr:''}:{code:1,stdout:'',stderr:'bad ref'};
   if(args[0]==='diff'){diffs.push(args);return {code:0,stdout:'',stderr:''};}
   return {code:0,stdout:'',stderr:''};
  };
  await captureRevision(m,run);originExists=false;await captureRevision(m,run);
  expect(diffs.map(args=>args[1])).toEqual(['fresh123','stale456']);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('fingerprints bind content and target base while the tree survives a new HEAD',async()=>{
 const cwd=await mkdtemp(join(tmpdir(),'mission-tree-'));
 try{
  await writeFile(join(cwd,'a.ts'),'verified');
  const m=mission(cwd);m.workspace={key:'key',cwd,commonDir:cwd,base:'main',delivery:'pr'};
  let head='commit-one';
  const run:Run=async(cmd,args)=>args[0]==='rev-parse'?{code:0,stdout:head,stderr:''}:args[0]==='ls-files'?{code:0,stdout:'a.ts\0',stderr:''}:{code:0,stdout:'',stderr:''};
  const verified=await captureRevision(m,run);
  head='commit-two';
  const committed=await captureRevision(m,run);
  expect(committed.revision).not.toBe(verified.revision);
  expect(committed.tree).toBe(verified.tree);
  expect(committed.legacyRevision).not.toBe(verified.legacyRevision);
  expect(committed.legacyTree).toBe(verified.legacyTree);
  m.evidence.verify={outcome:'passed',revision:verified.revision,tree:verified.tree,detail:'verified',at:'now'};
  expect(alignVerifiedRevision(m,committed)).toBe(committed.revision);
  expect(m.evidence.verify.revision).toBe(committed.revision);
  m.evidence.verify={outcome:'passed',revision:verified.legacyRevision,tree:verified.legacyTree,detail:'old',at:'now'};
  m.evidence.deliver={outcome:'passed',revision:verified.legacyRevision,detail:'old',at:'now'};
  expect(alignVerifiedRevision(m,committed)).toBe(committed.revision);
  expect(m.evidence.verify).toMatchObject({revision:committed.revision,tree:committed.tree});
  expect(m.evidence.deliver.revision).toBe(committed.revision);
  m.workspace.base='v2/backend-rewrite';
  const retargeted=await captureRevision(m,run);
  expect(retargeted.revision).not.toBe(committed.revision);
  expect(retargeted.tree).not.toBe(committed.tree);
  expect(retargeted.legacyTree).toBe(committed.legacyTree);
  m.evidence.verify={outcome:'passed',revision:committed.revision,tree:committed.tree,detail:'verified',at:'now'};
  expect(()=>alignVerifiedRevision(m,retargeted)).toThrow(/Files changed since verification/);
  await writeFile(join(cwd,'a.ts'),'edited after verification');
  expect((await captureRevision(m,run)).tree).not.toBe(retargeted.tree);
 }finally{await rm(cwd,{recursive:true,force:true});}
});
test('reviewer time budget grows with the change and is capped',()=>{
 expect(reviewBudgetMs(0)).toBe(5*60_000);
 expect(reviewBudgetMs(10)).toBe(5*60_000+150_000);
 expect(reviewBudgetMs(10_000)).toBe(30*60_000);
});

// parser/persistence compatibility regressions: parseReview must reject cases validateMission rejects for reviews
test('parseReview rejects empty/blank/oversized summary (matches review.summary text contract)', () => {
  const r = 'r1';
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"","findings":[]}', r)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"   ","findings":[]}', r)).toThrow();
  const big = 'x'.repeat(50001);
  expect(() => parseReview(JSON.stringify({reviewedRevision:r, summary: big, findings:[]}), r)).toThrow();
});
test('parseReview rejects unsafe integer line and oversized/whitespace finding fields (matches validFinding/text)', () => {
  const r = 'r1';
  const base = (line: unknown, id='f1', p='p.ts', t='t', b='b') => JSON.stringify({reviewedRevision:r, summary:'s', findings:[{id,severity:'low',path:p,line,title:t,body:b}]});
  expect(() => parseReview(base(0), r)).toThrow();
  expect(() => parseReview(base(1.5), r)).toThrow();
  const unsafe = 9007199254740992; // 2**53 : isInteger but !isSafe
  expect(() => parseReview(base(unsafe), r)).toThrow();
  expect(() => parseReview(base(1, '   '), r)).toThrow(); // ws id
  expect(() => parseReview(base(1, 'f1', '   '), r)).toThrow();
  const bigTitle = 'x'.repeat(10001);
  expect(() => parseReview(base(1,'f1','p', bigTitle), r)).toThrow();
  const bigBody = 'x'.repeat(50001);
  expect(() => parseReview(base(1,'f1','p','t', bigBody), r)).toThrow();
});
test('parseReview + validateMission roundtrip for valid review data; rejects stay out before mutation', () => {
  const r = 'r1';
  const good = parseReview('{"reviewedRevision":"r1","summary":"ok sum","findings":[{"id":"f1","severity":"medium","path":"a.ts","line":42,"title":"defect","body":"detail"}]}', r);
  expect(good.summary).toBe('ok sum');
  expect(good.findings[0]?.line).toBe(42);
  const m = mission('/tmp');
  m.reviews = [{round:1, revision: good.revision, model:'test/m', summary: good.summary, findings: good.findings, at: '2026-01-01'}];
  expect(validateMission(m).reviews).toEqual(m.reviews);
});
test('review parsing rejects malformed responses, mismatched revisions and duplicate findings', () => {
  const finding = {id:'f',severity:'high',path:'a.ts',line:1,title:'Defect',body:'Details'};
  expect(() => parseReview('not JSON', 'r')).toThrow();
  expect(() => parseReview(JSON.stringify({reviewedRevision:'old',summary:'Clean',findings:[]}), 'r')).toThrow();
  expect(() => parseReview(JSON.stringify({reviewedRevision:'r',summary:'Defects',findings:[finding,finding]}), 'r')).toThrow();
});

test('roleThinkingLevel reads the level suffix from a role value', async () => {
  const { roleThinkingLevel } = await import('../src/review');
  expect(roleThinkingLevel('devin/swe-2:high')).toBe('high');
  expect(roleThinkingLevel('a/x:low, b/y:max')).toBe('low');
  expect(roleThinkingLevel('devin/swe-2')).toBeUndefined();
  expect(roleThinkingLevel(undefined)).toBeUndefined();
  expect(roleThinkingLevel('')).toBeUndefined();
});

test('boundDiff keeps small file sections and names oversized ones instead of sending them inline', async () => {
  const { boundDiff } = await import('../src/review');
  const section = (path: string, size: number) => `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${'+x\n'.repeat(size)}`;
  const diff = section('small.ts', 2) + section('lock.yaml', 5000) + section('tiny.ts', 1);
  const bounded = boundDiff(diff, 500);
  expect(bounded.omitted).toEqual(['lock.yaml']);
  expect(bounded.diff).toBe(section('small.ts', 2) + section('tiny.ts', 1));
  expect(boundDiff(diff, diff.length)).toEqual({ diff, omitted: [] });
});
