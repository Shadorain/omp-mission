import {test,expect} from 'bun:test';
import {nextAction,operatorStep,operatorCommands,modelRetryTargets,setMode,approveGate,enforceMutation,enforceGate,waveGate,terminalCapacity,QUOTA_BLOCKER,reviewChurnReason} from '../src/controller';
import { validateMission } from '../src/store';
import type {Mission,Snapshot,PolicyContext,ReviewRound} from '../src/types';
export function fixture(): Mission {return {version:1,id:'freeform-test',source:{kind:'freeform',id:'test',title:'test',body:'test',comments:'',extra:''},workspace:{key:'key',cwd:'/tmp',delivery:'local'},epicId:'epic',scopes:{a:['a.ts'],b:['b.ts']},phase:'execute',evidence:{},mode:'auto',keep:false,reviewRequested:false,workers:[],reviews:[],repairLinks:{},round:1,createdAt:'now',updatedAt:'now'};}
const ready:Snapshot={beads:[{id:'a',title:'a',status:'open',children:[],ready:true,category:'ready'},{id:'b',title:'b',status:'open',children:[],ready:true,category:'ready'}],leaves:[],ready:['a','b'],closed:0,active:0,blocked:0,fetchedAt:Date.now()};ready.leaves=ready.beads;
const policy:PolicyContext={resumeHold:false,owned:true,nativePlan:false,fresh:true,maxWorkers:2};
const closedBeads=ready.beads.map(bead=>({...bead,status:'closed',category:'closed' as const,ready:false}));
const closed:Snapshot={...ready,beads:closedBeads,leaves:closedBeads,ready:[],closed:2};
test('resume hold survives mode switch and Force request',()=>{const m=fixture();setMode(m,'force');expect(m.reviewRequested).toBe(true);expect(nextAction(m,ready,{...policy,resumeHold:true}).kind).toBe('hold');expect(()=>enforceMutation(m,{...policy,resumeHold:true})).toThrow('Resumed inspection');});
test('force plus pause retains review but gates wave',()=>{const m=fixture();setMode(m,'force');setMode(m,'pause');const action=nextAction(m,ready,policy);expect(m.reviewRequested).toBe(true);expect(action.gate?.kind).toBe('wave');m.gate=action.gate;approveGate(m,m.gate!.token);expect(nextAction(m,ready,policy).kind).toBe('dispatch');});
test('changed scope invalidates approval',()=>{const m=fixture();m.mode='pause';m.gate=waveGate(m,['a','b'],ready);approveGate(m,m.gate.token);m.scopes.a=['changed.ts'];expect(nextAction(m,ready,policy).kind).toBe('hold');expect(()=>enforceGate(m,waveGate(m,['a','b'],ready))).toThrow('Approval required');});
test('Pause mid wave neither cancels nor backfills',()=>{const m=fixture();m.workers=[{beadId:'a',attempt:'1',cwd:'/tmp',files:['a.ts'],state:'running',assignment:'a'}];setMode(m,'pause');const action=nextAction(m,ready,policy);expect(action.kind).toBe('hold');expect(action.ids).toBeUndefined();expect(m.workers[0]?.state).toBe('running');});
test('stale reads never dispatch and plan blocks all mutations',()=>{const m=fixture();expect(nextAction(m,{...ready,error:'bd failed'},policy).kind).toBe('hold');expect(()=>enforceMutation(m,{...policy,nativePlan:true})).toThrow('native plan');});
test('delivery without requested review is not complete',()=>{const m=fixture();m.evidence.verify={outcome:'passed',revision:'rev',detail:'actual',at:'now'};m.evidence.deliver={outcome:'passed',detail:'local',at:'now'};expect(nextAction(m,closed,policy).kind).toBe('hold');m.reviewRequested=true;expect(nextAction(m,closed,policy).kind).toBe('review');m.reviews=[{round:1,revision:'rev',model:'model',summary:'clean',findings:[],at:'now'}];expect(nextAction(m,closed,policy).kind).toBe('complete');});
test('failed review holds until explicitly retried or a new revision is verified',()=>{const m=fixture();m.reviewRequested=true;m.evidence.verify={outcome:'passed',revision:'rev',detail:'Node assertions passed',at:'now'};m.evidence.deliver={outcome:'passed',revision:'rev',detail:'local',at:'now'};m.evidence.review={outcome:'failed',revision:'rev',detail:'Malformed reviewer JSON',at:'now'};expect(nextAction(m,closed,policy).kind).toBe('hold');delete m.evidence.review;expect(nextAction(m,closed,policy).kind).toBe('review');});
test('empty graph cannot advance to verification or delivery',()=>{const m=fixture();expect(nextAction(m,{...ready,beads:[],leaves:[],ready:[]},policy).kind).toBe('hold');});
test('Pause independently gates review entry and repair acceptance',()=>{const m=fixture();m.mode='pause';m.reviewRequested=true;m.evidence.verify={outcome:'passed',revision:'rev',detail:'Node assertions passed',at:'now'};m.evidence.deliver={outcome:'passed',revision:'rev',detail:'local',at:'now'};m.gate=nextAction(m,closed,policy).gate;expect(m.gate?.kind).toBe('review');approveGate(m,m.gate!.token);expect(nextAction(m,closed,policy).kind).toBe('review');m.reviews=[{round:1,revision:'rev',model:'independent',summary:'Defect',findings:[{id:'R1',severity:'high',path:'a.ts',line:1,title:'Boundary defect',body:'Boundary defect'}],at:'now'}];m.gate=nextAction(m,closed,policy).gate;expect(m.gate?.kind).toBe('repairs');approveGate(m,m.gate!.token);expect(nextAction(m,closed,policy).kind).toBe('repairs');});

test('failed verification holds all automatic work until explicitly continued',()=>{
 const m=fixture();m.graph='local';m.phase='verify';m.evidence.verify={outcome:'failed',revision:'rev',detail:'Remote build host unavailable',at:'now'};
 expect(nextAction(m,undefined,policy).kind).toBe('hold');
 expect(()=>enforceMutation(m,policy)).toThrow('Verification failed');
 expect(operatorCommands(m,false,undefined,policy)).toContain('continue');
 expect(operatorStep(m,nextAction(m,undefined,policy),policy).command).toBe('/mission continue');
 setMode(m,'force');
 expect(nextAction(m,undefined,policy).kind).toBe('hold');
});

test('an unbound open leaf is a bind step, not a silent hold',()=>{
 const m=fixture();m.scopes={a:['a.ts']};m.evidence.verify={outcome:'pending',detail:'held',at:'now'};
 const leaf=(id:string,category:'closed'|'ready'):Snapshot['beads'][number]=>({id,title:id,status:category,children:[],ready:category==='ready',category});
 const snap:Snapshot={beads:[leaf('a','closed'),leaf('repair','ready')],leaves:[leaf('a','closed'),leaf('repair','ready')],ready:['repair'],closed:1,active:0,blocked:0,fetchedAt:Date.now()};
 const action=nextAction(m,snap,policy);
 expect(action.kind).toBe('graph');
 expect(action.ids).toEqual(['repair']);
 m.evidence.verify={outcome:'failed',detail:'compile error',at:'now'};
 expect(operatorStep(m,nextAction(m,snap,policy),policy).text).not.toContain('only when the blocker is resolved');
});

test('a released verification failure asks for a repair leaf instead of the same gate',()=>{
 const m=fixture();m.graph='beads';m.evidence.verify={outcome:'pending',detail:'compile error at aftercare.rs',at:'now'};
 const done={id:'a',title:'a',status:'closed',children:[],ready:false,category:'closed' as const};
 const closedOnly:Snapshot={beads:[done],leaves:[done],ready:[],closed:1,active:0,blocked:0,fetchedAt:Date.now()};
 const action=nextAction(m,closedOnly,policy);
 expect(action.kind).toBe('graph');
 expect(action.detail).toContain('Do not record verification');
 expect(action.detail).toContain('compile error');
 m.evidence.verify={outcome:'failed',detail:'compile error',at:'now'};
 expect(nextAction(m,closedOnly,policy).kind).toBe('graph');
 expect(nextAction(m,closedOnly,policy).detail).toContain('Do not record verification');
 expect(nextAction(m,closedOnly,policy).detail).toContain('repair leaf');
});

test('beads force does not park on a failed verification',()=>{
 const m=fixture();m.graph='beads';m.mode='force';m.evidence.verify={outcome:'failed',detail:'fmt wrote aftercare.rs',at:'now'};
 const done={id:'a',title:'a',status:'closed',children:[],ready:false,category:'closed' as const};
 const snap:Snapshot={beads:[done],leaves:[done],ready:[],closed:1,active:0,blocked:0,fetchedAt:Date.now()};
 expect(nextAction(m,snap,policy).kind).toBe('graph');
 expect(()=>enforceMutation(m,policy)).not.toThrow();
 expect(operatorStep(m,nextAction(m,snap,policy),policy).command).toBeUndefined();
 m.mode='pause';
 expect(nextAction(m,snap,policy).kind).toBe('hold');
});

test('operator step names the command a person must run, and stays silent when the coordinator is working',()=>{
 const step=(m:Mission,p:PolicyContext=policy,snap:Snapshot|undefined=ready,err?:string)=>operatorStep(m,nextAction(m,snap,p),p,err);
 const m=fixture();
 expect(step(m,{...policy,resumeHold:true}).command).toBe('/mission continue');
 expect(step(m,{...policy,owned:false},ready,'lock lost').command).toBe('/mission continue');
 expect(step(m,{...policy,nativePlan:true}).command).toBeUndefined();
 expect(step(m).command).toBeUndefined();
 m.mode='pause';
 expect(step(m).command).toBe('/mission approve');
 m.mode='auto';m.evidence.verify={outcome:'passed',revision:'rev',detail:'ok',at:'now'};m.evidence.deliver={outcome:'passed',detail:'local',at:'now'};
 expect(step(m,policy,closed).command).toBe('/mission review');
 m.reviewRequested=true;m.evidence.review={outcome:'failed',revision:'rev',detail:'boom',at:'now'};
 expect(step(m,policy,closed)).toMatchObject({command:'/mission review'});
 m.evidence.review.detail='Your daily usage quota has been exhausted';
 expect(step(m,policy,closed).command).toBeUndefined();
 expect(step(m,policy,closed).text).toContain('provider quota');
 for (const detail of [
  '403 You have run out of credits or need a Grok subscription (type=personal-team-blocked:spending-limit)',
  '402 This request requires more credits, or fewer max_tokens',
  'You have hit your ChatGPT usage limit',
  'resource_exhausted',
 ]) {
  m.evidence.review.detail=detail;
  expect(step(m,policy,closed).command).toBeUndefined();
  expect(step(m,policy,closed).text).toContain('provider quota');
  expect(m.phase).toBe('execute');
 }
 m.evidence.review.detail='429 Too Many Requests: rate limit exceeded';
 expect(step(m,policy,closed).command).toBe('/mission review');
 m.phase='complete';
 expect(step(m,{...policy,resumeHold:true,nativePlan:true,owned:false}).command).toBe('/mission show');
 expect(()=>enforceMutation(m,{...policy,nativePlan:true})).toThrow('native plan');
});

test('operatorCommands offers only commands that can run now',()=>{
 const base=['show','config','history'];
 expect(operatorCommands(undefined,false,ready,policy)).toEqual(base);
 expect(operatorCommands(undefined,true,ready,policy)).toEqual([...base,'clear']);
 const m=fixture();
 // Ownership, holds and plan mode leave only read-only commands.
 expect(operatorCommands(m,false,ready,{...policy,resumeHold:true})).toEqual([...base,'continue','mode']);
 expect(operatorCommands(m,false,ready,{...policy,owned:false})).toEqual([...base,'continue','mode']);
 expect(operatorCommands(m,false,ready,{...policy,nativePlan:true})).toEqual(base);
 // A dispatchable wave, a waiting gate and a stale read are mutually exclusive offers.
 expect(operatorCommands(m,false,ready,policy)).toEqual([...base,'mode','dispatch']);
 m.mode='pause';const gated=nextAction(m,ready,policy);m.gate=gated.gate;
 expect(operatorCommands(m,false,ready,policy)).toEqual([...base,'mode','approve']);
 approveGate(m,m.gate!.token);
 expect(operatorCommands(m,false,ready,policy)).toEqual([...base,'mode','dispatch']);
 m.mode='auto';delete m.gate;
 expect(operatorCommands(m,false,{...ready,error:'bd failed'},policy)).toEqual([...base,'mode']);
 // Review is offered only after delivery; an operation freezes every mutating verb.
 m.evidence.deliver={outcome:'passed',detail:'local',at:'now'};
 expect(operatorCommands(m,false,closed,policy)).toEqual([...base,'mode','review']);
 expect(operatorCommands(m,false,closed,policy,undefined,true)).toEqual(base);
 // Complete missions inspect and clear only.
 m.phase='complete';
 expect(operatorCommands(m,false,closed,policy,'a')).toEqual([...base,'clear','history a']);
 expect(operatorCommands(m,false,closed,{...policy,resumeHold:true,owned:false,nativePlan:true},'a')).toEqual([...base,'clear','history a']);
});

test('operatorCommands binds selected worker commands to their bead',()=>{
 const m=fixture();m.scopes={a:['a.ts']};
 const noWave:Snapshot={...ready,ready:[],leaves:ready.beads.map(bead=>({...bead,category:'active' as const,ready:false}))};
 const worker={beadId:'a',attempt:'1',cwd:'/tmp',files:['a.ts'],state:'awaiting-claim' as const,assignment:'a',handle:'t1',incarnationId:'i1',frontend:'orca' as const};
 m.workers=[worker];
 // Read-only focus survives holds and plan mode; resend waits for control and a fresh graph.
 expect(operatorCommands(m,false,noWave,{...policy,resumeHold:true},'a')).toEqual(['show','config','history','history a','focus a','continue','mode']);
 expect(operatorCommands(m,false,noWave,{...policy,nativePlan:true},'a')).toEqual(['show','config','history','history a','focus a']);
 expect(operatorCommands(m,false,noWave,policy,'a')).toEqual(['show','config','history','history a','focus a','mode','resend a']);
 expect(operatorCommands(m,false,{...noWave,error:'bd failed'},policy,'a')).not.toContain('resend a');
 expect(operatorCommands(m,false,undefined,policy,'a')).not.toContain('resend a');
 // A stopped subagent resends and releases; a closed bead reaps; keep forbids cleanup.
 m.workers=[{...worker,frontend:'subagent',state:'running',error:'rejected'}];
 expect(operatorCommands(m,false,noWave,policy,'a')).toEqual(expect.arrayContaining(['resend a','release a']));
 // The widget's next step is runnable without selecting the bead first.
 expect(operatorCommands(m,false,noWave,policy)).toContain('resend a');
 m.workers=[{...worker,frontend:'subagent',state:'running'}];
 expect(operatorCommands(m,false,noWave,policy,'a')).toEqual(expect.arrayContaining(['release a']));
 expect(operatorCommands(m,false,noWave,policy,'a')).not.toEqual(expect.arrayContaining(['resend a','focus a']));
 m.workers=[{...worker,frontend:'orca',state:'running'}];
 expect(operatorCommands(m,false,closed,policy,'a')).toEqual(expect.arrayContaining(['reap a']));
 expect(operatorCommands(m,false,closed,policy,'a')).not.toEqual(expect.arrayContaining(['resend a','release a']));
 m.keep=true;
 expect(operatorCommands(m,false,closed,policy,'a')).not.toContain('reap a');
 m.keep=false;m.blocker='blocked upstream';
 expect(operatorCommands(m,false,closed,policy,'a')).not.toContain('reap a');
});

test('quota or rate-limit worker failures hold without completing or advertising a blind retry',()=>{
 const m=fixture();
 const worker={beadId:'a',attempt:'1',cwd:'/tmp',files:['a.ts'],state:'running' as const,assignment:'a',frontend:'subagent' as const,error:'403 You have run out of credits (type=personal-team-blocked:spending-limit)'};
 m.workers=[worker];
 const before=JSON.stringify({phase:m.phase,reviews:m.reviews,blocker:m.blocker,state:worker.state});
 const action=nextAction(m,ready,policy);
 expect(action.kind).toBe('hold');
 expect(action.kind).not.toBe('complete');
 expect(action.kind).not.toBe('resend');
 expect(operatorStep(m,action,policy).command).toBeUndefined();
 expect(operatorStep(m,action,policy).text).toContain('provider quota');
 expect(operatorCommands(m,false,ready,policy,'a')).not.toContain('resend a');
 expect(operatorCommands(m,false,ready,policy,'a')).toContain('release a');
 expect(JSON.stringify({phase:m.phase,reviews:m.reviews,blocker:m.blocker,state:worker.state})).toBe(before);
 m.workers=[{...worker,error:'status 429 Too Many Requests'}];
 const limited=nextAction(m,ready,policy);
 expect(limited.kind).toBe('hold');
 expect(limited.detail).toContain('/mission resend when it clears');
 expect(operatorCommands(m,false,ready,policy,'a')).toContain('resend a');
 m.mode='pause';
 m.workers=[{...worker,error:'worker reported it is not done'}];
 expect(nextAction(m,ready,policy).kind).toBe('resend');
});

test('a terminal quota error parks; a clean stop and an in-flight retry do not',()=>{
 expect(terminalCapacity([{role:'assistant',stopReason:'error',errorMessage:'Your weekly usage quota has been exhausted'}])).toBe('quota');
 expect(terminalCapacity([{role:'assistant',stopReason:'error',errorMessage:'rate limit exceeded'}])).toBe('rate');
 expect(terminalCapacity([{role:'assistant',stopReason:'stop',errorMessage:'quota exhausted'}])).toBeUndefined();
 expect(terminalCapacity([])).toBeUndefined();
 const m=fixture();
 m.blocker=QUOTA_BLOCKER;
 const action=nextAction(m,ready,policy);
 expect(action.kind).toBe('hold');
 expect(operatorCommands(m,false,ready,policy)).toContain('continue');
 expect(operatorStep(m,action,policy).command).toBe('/mission continue');
});


test('model recovery respects holds and targets only failed owned subagents',()=>{
 const m=fixture();m.graph='beads';
 m.workers=[
  {beadId:'a',attempt:'1',cwd:'/tmp',files:['a.ts'],state:'running',frontend:'subagent',assignment:'worker',error:'quota exhausted'},
  {beadId:'b',attempt:'2',cwd:'/tmp',files:['b.ts'],state:'running',frontend:'subagent',assignment:'worker'},
 ];
 const activeBeads=ready.beads.map(bead=>({...bead,category:'active' as const,claimActor:bead.id}));
 const active={...ready,beads:activeBeads,leaves:activeBeads};
 expect(modelRetryTargets(m,active,policy)).toEqual({coordinator:false,review:false,workers:['a']});
 for(const guard of [{resumeHold:true},{owned:false},{nativePlan:true},{fresh:false}])
  expect(modelRetryTargets(m,active,{...policy,...guard})).toBeUndefined();
 expect(modelRetryTargets(m,{...active,error:'graph offline'},policy)).toBeUndefined();
 activeBeads[0]!.claimActor='someone-else';
 expect(modelRetryTargets(m,active,policy)).toBeUndefined();
 activeBeads[0]!.claimActor='a';
 m.gate={kind:'wave',token:'scope',detail:'Approve',approved:false};
 expect(modelRetryTargets(m,active,policy)).toBeUndefined();
 delete m.gate;
 m.evidence.verify={outcome:'failed',detail:'tests failed',at:'now'};
 expect(modelRetryTargets(m,active,policy)).toBeUndefined();
 delete m.evidence.verify;
 m.blocker='Unrelated ownership conflict';
 expect(modelRetryTargets(m,active,policy)).toBeUndefined();
});

function reviewRound(round:number,title=`Defect ${round}`):ReviewRound{
 return {round,revision:`rev-${round}`,model:'independent',summary:'Concrete defect',at:'now',findings:[{id:`r${round}`,path:'a.ts',line:round,title,body:'A consumer operation fails',severity:'high'}]};
}

test('review repair work stops after two unsuccessful cycles without losing findings',()=>{
 const m=fixture();m.reviewRequested=true;
 m.reviews=[reviewRound(1)];
 expect(nextAction(m,ready,policy).kind).toBe('dispatch');
 m.reviews.push(reviewRound(2));
 expect(nextAction(m,ready,policy).kind).toBe('dispatch');
 m.reviews.push(reviewRound(3));
 expect(nextAction(m,ready,policy)).toMatchObject({kind:'hold',detail:expect.stringContaining('Two repair cycles')});
 expect(operatorStep(m,nextAction(m,ready,policy),policy).command).toBe('/mission review');
 expect(operatorCommands(m,false,ready,policy)).not.toContain('dispatch');
 expect(m.reviews.flatMap(review=>review.findings).map(finding=>finding.rejection)).toEqual([undefined,undefined,undefined]);
 setMode(m,'force');
 expect(nextAction(m,ready,policy).kind).toBe('hold');
});

test('repeated review findings stop the next repair even when labels and line numbers change',()=>{
 const m=fixture();m.reviews=[reviewRound(1,'Lost payment'),reviewRound(2,'  LOST   payment ')];
 expect(reviewChurnReason(m)).toContain('Repeated finding');
 m.reviews[0]!.findings[0]!.rejection='Not applicable: fixture is unreachable';
 expect(reviewChurnReason(m)).toBeUndefined();
 delete m.reviews[0]!.findings[0]!.rejection;
 m.reviews[0]!.invalidated='Source changed';
 expect(reviewChurnReason(m)).toBeUndefined();
});

test('clean and rejected reviews can finish while acknowledged churn gets a bounded new window',()=>{
 const m=fixture();m.reviews=[reviewRound(1),reviewRound(2),reviewRound(3)];
 m.reviewAcknowledged=m.reviews.length;
 const restored=validateMission(m);
 expect(restored.reviewAcknowledged).toBe(3);
 expect(reviewChurnReason(restored)).toBeUndefined();
 restored.reviews.push(reviewRound(4));
 expect(reviewChurnReason(restored)).toBeUndefined();
 restored.reviews.push(reviewRound(5));
 expect(reviewChurnReason(restored)).toContain('Two repair cycles');
 restored.reviews.at(-1)!.findings[0]!.rejection='Specification explicitly requires this behavior';
 expect(reviewChurnReason(restored)).toBeUndefined();
 restored.reviews.at(-1)!.findings=[];
 expect(reviewChurnReason(restored)).toBeUndefined();
 expect(()=>validateMission({...restored,reviewAcknowledged:6})).toThrow('reviewAcknowledged');
});

test('waves serialize overlapping scopes and do not overlap an existing worker',()=>{
 const m=fixture();m.scopes={a:['shared'],b:['shared/file.ts']};
 expect(nextAction(m,ready,policy).ids).toEqual(['a']);
 m.workers=[{beadId:'a',attempt:'1',cwd:'/tmp',files:['shared'],state:'running',assignment:'repair'}];
 expect(nextAction(m,ready,policy).kind).toBe('hold');
 m.scopes.b=['separate.ts'];
 expect(nextAction(m,ready,policy).ids).toEqual(['b']);
 m.workers[0]!.state='closed';m.scopes.b=['shared/file.ts'];
 expect(nextAction(m,ready,policy).ids).toEqual(['a']);
});
