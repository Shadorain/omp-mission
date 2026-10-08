import {test,expect} from 'bun:test';
import {nextAction,operatorStep,operatorCommands,setMode,approveGate,enforceMutation,enforceGate,waveGate} from '../src/controller';
import type {Mission,Snapshot,PolicyContext} from '../src/types';
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
