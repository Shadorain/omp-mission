import {test,expect} from 'bun:test';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {captureRevision,parseReview} from '../src/review';
import type {Mission,Run} from '../src/types';
function mission(cwd:string):Mission{return {version:1,id:'review-test',source:{kind:'freeform',id:'test',title:'review',body:'behavior',comments:'',extra:''},workspace:{key:'key',cwd,delivery:'local'},scopes:{a:['a.ts']},phase:'review',mode:'pause',keep:false,reviewRequested:true,evidence:{},workers:[],reviews:[],repairLinks:{},round:1,createdAt:'now',updatedAt:'now'};}
const noRun:Run=async()=>{throw new Error('Unexpected CLI');};
test('malformed and wrong revision never mean clean',()=>{expect(()=>parseReview('', 'rev')).toThrow();expect(()=>parseReview('{"reviewedRevision":"other","summary":"clean","findings":[]}','rev')).toThrow();expect(()=>parseReview('{"reviewedRevision":"rev","summary":"defect","findings":[{"id":"x","severity":"high","path":"a.ts","line":0,"title":"x","body":"x"}]}','rev')).toThrow();expect(parseReview('{"reviewedRevision":"rev","summary":"clean","findings":[]}','rev').findings).toEqual([]);});
test('declared local file modifications and deletion invalidate captured revision',async()=>{const cwd=await mkdtemp(join(tmpdir(),'mission-revision-'));try{await writeFile(join(cwd,'a.ts'),'broken');const m=mission(cwd);const before=await captureRevision(m,noRun);await writeFile(join(cwd,'a.ts'),'fixed');const after=await captureRevision(m,noRun);expect(after.revision).not.toBe(before.revision);await rm(join(cwd,'a.ts'));expect((await captureRevision(m,noRun)).revision).not.toBe(after.revision);}finally{await rm(cwd,{recursive:true,force:true});}});
test('local fingerprint refuses escaping scopes',async()=>{const cwd=await mkdtemp(join(tmpdir(),'mission-escape-'));try{const m=mission(cwd);m.scopes.a=['../secret'];await expect(captureRevision(m,noRun)).rejects.toThrow('escapes');}finally{await rm(cwd,{recursive:true,force:true});}});
