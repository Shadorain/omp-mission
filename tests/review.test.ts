import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureRevision,parseReview} from '../src/review';
import type {Mission,Run} from '../src/types';
import {validateMission} from '../src/store';
function mission(cwd:string):Mission{return {version:1,id:'review-test',source:{kind:'freeform',id:'test',title:'review',body:'behavior',comments:'',extra:''},workspace:{key:'key',cwd,delivery:'local'},scopes:{a:['a.ts']},phase:'review',mode:'pause',keep:false,reviewRequested:true,evidence:{},workers:[],reviews:[],repairLinks:{},round:1,createdAt:'now',updatedAt:'now'};}
const noRun:Run=async()=>{throw new Error('Unexpected CLI');};
test('declared local file modifications and deletion invalidate captured revision',async()=>{const cwd=await mkdtemp(join(tmpdir(),'mission-revision-'));try{await writeFile(join(cwd,'a.ts'),'broken');const m=mission(cwd);const before=await captureRevision(m,noRun);await writeFile(join(cwd,'a.ts'),'fixed');const after=await captureRevision(m,noRun);expect(after.revision).not.toBe(before.revision);await rm(join(cwd,'a.ts'));expect((await captureRevision(m,noRun)).revision).not.toBe(after.revision);}finally{await rm(cwd,{recursive:true,force:true});}});
test('local fingerprint refuses escaping scopes',async()=>{const cwd=await mkdtemp(join(tmpdir(),'mission-escape-'));try{const m=mission(cwd);m.scopes.a=['../secret'];await expect(captureRevision(m,noRun)).rejects.toThrow('escapes');}finally{await rm(cwd,{recursive:true,force:true});}});

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
