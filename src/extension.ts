import { realpath } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { matchesKey } from '@oh-my-pi/pi-tui';
import { z } from '@oh-my-pi/pi-coding-agent';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { KeyId } from '@oh-my-pi/pi-tui';
import type { Frontend, Mission, MissionConfig, Mode, Projection, Run, Snapshot, SubagentRow } from './types';
import { configNotice, displayConfigPath, readMissionConfig, resolveAgentDir, validateMissionConfig, writeMissionConfig } from './config';
import { assertSourceCheckout, fetchSource, inferMissionSource, inspectWorkspace, parseMissionInput } from './sources';
import { acquireOwnership, listMissions, loadMission, missionId, missionPath, saveMission, validateMission } from './store';
import type { Ownership } from './store';
import { readClaimActor, readGraph, readHistory } from './beads';
import { createWorkerDriver } from './workers';
import { approveGate, effectiveGraph, enforceGate, enforceMutation, nextAction, requireBeadsGraph, revisionGate, setMode, waveGate } from './controller';
import { captureRevision, Reviewer } from './review';
import { coordinatorPrompt, workerPrompt } from './prompts';
import { createMissionWidget, createMissionInspector } from './ui';
import { missionArgumentCompletions, type MissionCompletionState } from './completions';
import { noteSubagentSpawn, noteSubagentToolEnd, noteSubagentToolStart, noteSubagentTurnEnd } from './subagents';

const controls = ['show','continue','mode','approve','review','history','focus','resend','dispatch','reap','actions','config'];
export function nativePlan(ctx: ExtensionContext): boolean {
 let mode = 'none';
 for (const entry of ctx.sessionManager.getBranch()) {
  if ('mode' in entry && entry.type === 'mode_change' && typeof entry.mode === 'string') mode = entry.mode;
 }
 return mode === 'plan';
}
export default async function missionExtension(pi: ExtensionAPI) {
 if(process.env.OMP_MISSION_WORKER==='1')return;
 const agentDir=resolveAgentDir();let config:MissionConfig;let configError:string|undefined;
 try{config=await readMissionConfig(agentDir);}catch(error){configError=String(error);config={version:1,controls:false,maxWorkers:2,frontend:'none',graph:'local',keys:{expand:null,fullscreen:null,mode:null}};}
 let ctx:ExtensionContext|undefined;let mission:Mission|undefined;let path:string|undefined;let pending:Mission|undefined;
 let snapshot:Snapshot|undefined;let ownership:Ownership|undefined;let resumeHold=true;let ownershipError:string|undefined;
 let generation=0;let refreshing=false;let lastPoll=0;let lastWake='';let expanded=false;let outlineOffset=0;let selected:string|undefined;let history:Projection['history'];let timer:Timer|undefined;let overlayAbort:AbortController|undefined;let operation=false;let terminalInputDispose:(()=>void)|undefined;let subagents:SubagentRow[]=[];
 let lifetime=new AbortController();let operationSignal:AbortSignal|undefined;
 let inspectionIntent:{mode?:Mode;reviewRequested?:boolean}={};
 const reviewer=new Reviewer();
 const run:Run=async(command,args,cwd,env)=>{
  const epoch=generation;const signal=operationSignal?AbortSignal.any([lifetime.signal,operationSignal]):lifetime.signal;signal.throwIfAborted();
  const mutating=(command==='orca'&&args[0]==='terminal'&&['create','send','close'].includes(args[1]??''))||(command==='herdr'&&((args[0]==='tab'&&['create','close'].includes(args[1]??''))||(args[0]==='agent'&&['start','prompt'].includes(args[1]??''))))||command==='bash'||(command==='kill'&&args[0]!=='-0');
  if(mutating){if(!ctx||!mission||!ownership)throw new Error('No controller for worker mutation');enforceMutation(mission,policy(ctx));await ownership.assertOwned();signal.throwIfAborted();if(epoch!==generation)throw new Error('Session changed');}
  const invocation=env?Object.entries(env).map(([key,value])=>`${key}=${value}`).concat(command,args):args;
  const slow=command==='orca'||(command==='herdr'&&args[0]==='agent'&&args[1]==='start');
  const result=await pi.exec(env?'env':command,invocation,{cwd,timeout:slow?130000:30000,signal});
  signal.throwIfAborted();if(epoch!==generation)throw new Error('Session changed during command');return {stdout:result.stdout,stderr:result.stderr,code:result.code??1};
 };
 const eligible=(context:ExtensionContext)=>context.agent.kind==='main';
 const projection=():Projection|undefined=>mission||pending?{mission:(mission??pending)!,snapshot,resumeHold:mission?resumeHold:false,ownershipError,selected,history,expanded,outlineOffset,nativePlan:ctx?nativePlan(ctx):false,nextAction:ctx&&mission?nextAction(mission,snapshot,policy(ctx)).detail:undefined,frontend:config.frontend,expandKey:config.keys.expand,subagents}:undefined;
 let completionState:MissionCompletionState={sources:[],beads:[],workers:[]};
 function syncCompletions(){completionState={sources:completionState.sources,beads:(snapshot?.beads??[]).map(bead=>({id:bead.id,title:bead.title,category:bead.category})),workers:(mission?.workers??[]).map(worker=>({beadId:worker.beadId,state:worker.state,handle:!!worker.handle}))};}
 async function refreshCompletionSources(){try{const saved=await listMissions(agentDir);completionState.sources=saved.map(item=>({id:item.mission.source.id,title:item.mission.source.title}));}catch{/* keep the previous source list */}}
 async function persist(value:Mission){if(value!==mission||!path||!ownership)throw new Error('No current controller ownership');await ownership.assertOwned();value.controllerNonce=ownership.nonce;value.updatedAt=new Date().toISOString();await saveMission(path,value);}
 const driver=createWorkerDriver(run,{persist:async value=>{if(value!==mission)throw new Error('Session changed during worker operation');if(ownership&&!resumeHold)await persist(value);},prompt:(mission,worker)=>workerPrompt(mission,worker,config.frontend),agentDir,frontend:()=>config.frontend,customCommand:()=>config.customCommand});
 function policy(context:ExtensionContext){return {resumeHold,owned:!!ownership&&!ownershipError,nativePlan:nativePlan(context),fresh:!!snapshot&&!snapshot.error&&Date.now()-snapshot.fetchedAt<35000,maxWorkers:config.maxWorkers};}
 function status(context:ExtensionContext){return {mission,pending,snapshot,resumeHold,ownershipError,next:mission?nextAction(mission,snapshot,policy(context)):undefined};}
 async function render(){
  syncCompletions();
  if(!ctx||!eligible(ctx))return;const active=pi.getActiveTools();const enabled=!!(mission||pending);
  if(active.includes('mission_status')!==enabled||active.includes('mission_control')!==enabled)await pi.setActiveTools([...active.filter(name=>!['mission_status','mission_control'].includes(name)),...(enabled?['mission_status','mission_control']:[])]);
  if(!ctx.hasUI)return;if(!projection()){ctx.ui.setWidget('mission',undefined);return;}ctx.ui.setWidget('mission',(tui,theme)=>createMissionWidget(()=>projection()!,()=>tui.terminal.rows,theme),{placement:'aboveEditor'});
 }
 async function acquire(){if(!mission||!path)throw new Error('No saved mission');if(ownership){await ownership.assertOwned();return;}ownershipError=undefined;ownership=await acquireOwnership(path,mission,error=>{ownershipError=`Controller lost: ${error.message}`;resumeHold=true;lastWake='';void reviewer.dispose();void render();});mission=ownership.mission;mission.controllerNonce=ownership.nonce;}
 async function release(){const current=ownership;ownership=undefined;await current?.release();}
 async function detach(context?:ExtensionContext){generation++;lifetime.abort();lifetime=new AbortController();terminalInputDispose?.();terminalInputDispose=undefined;overlayAbort?.abort();overlayAbort=undefined;if(timer&&ctx)ctx.clearTimer(timer);timer=undefined;await reviewer.dispose();await release();ctx?.ui.setWidget('mission',undefined);ctx=context;mission=undefined;pending=undefined;path=undefined;snapshot=undefined;resumeHold=true;ownershipError=undefined;lastWake='';selected=undefined;history=undefined;lastPoll=0;outlineOffset=0;inspectionIntent={};subagents=[];}
 async function attach(file:string,context:ExtensionContext){await release();mission=await loadMission(file);path=file;pending=undefined;snapshot=undefined;resumeHold=true;ownershipError=undefined;ctx=context;await refresh(false);await render();}
 async function restore(context:ExtensionContext){
  if(!eligible(context))return;
  await detach(context);
  if(configError)context.ui.notify(configError,'error');
  const pointerEntry=[...context.sessionManager.getBranch()].reverse().find(entry=>entry.type==='custom'&&entry.customType==='mission:pointer');
  const pointer = pointerEntry && 'data' in pointerEntry ? z.object({path:z.string()}).safeParse(pointerEntry.data) : undefined;
  try{
   if(pointer?.success)await attach(pointer.data.path,context);
   else{
    const saved=await listMissions(agentDir);const workspace=await inspectWorkspace(context.cwd,run);
    const matches=saved.filter(item=>item.mission.workspace.key===workspace.key&&item.mission.workspace.cwd===workspace.cwd);
    if(matches.length===1)await attach(matches[0]!.path,context);
   }
  }catch(error){const msg=error instanceof Error?error.message:String(error);ownershipError=msg;context.ui.notify(msg,'error');}
  if(!mission){
   for(const entry of [...context.sessionManager.getBranch()].reverse()){
    if(entry.type!=='message'||entry.message.role!=='user')continue;
    const content=typeof entry.message.content==='string'?entry.message.content:entry.message.content.filter(block=>block.type==='text').map(block=>block.type==='text'?block.text:'').join('\n');
    const marker='\nMission pending recovery JSON:\n';
    const index=content.lastIndexOf(marker);if(index<0)continue;
    try{const recovered=validateMission(JSON.parse(content.slice(index+marker.length)));if(recovered.phase==='plan'){pending=recovered;await render();}break;}
    catch(error){ownershipError=`Pending mission recovery failed: ${String(error)}`;context.ui.notify(ownershipError,'error');break;}
   }
  }
  if(context.hasUI)terminalInputDispose=context.ui.onTerminalInput(data=>{if(!expanded||!projection())return;const direction=matchesKey(data,'alt+up')?-1:matchesKey(data,'alt+down')?1:0;if(!direction)return;outlineOffset=Math.max(0,Math.min(Math.max(0,(snapshot?.beads.length??1)-1),outlineOffset+direction));void render();return {consume:true};});
  await refreshCompletionSources();
  await render();
  timer=context.setInterval(()=>{if(operation)return;const interval=mission&&(mission.phase==='execute'||mission.phase==='repair')?5000:30000;if(Date.now()-lastPoll>=interval)void refresh(true);},1000);
 }
 async function refresh(wake:boolean){
  if(refreshing||!mission||!mission.epicId||!ctx)return;
  refreshing=true;const epoch=generation;const current=mission;lastPoll=Date.now();
  try{
   const next=await readGraph(run,current.workspace.cwd,current.epicId!,{BEADS_DIR:current.workspace.beadsDir??''},snapshot);
   if(epoch!==generation||mission!==current)return;
   snapshot=next;
   if(!next.error){
    for(const worker of current.workers){
     const bead=next.beads.find(b=>b.id===worker.beadId);
     if(bead?.status==='in_progress')bead.claimActor=await readClaimActor(run,current.workspace.cwd,bead.id,{BEADS_DIR:current.workspace.beadsDir??''});
     if(epoch!==generation||mission!==current)return;
    }
    await driver.reconcile(current,new Map(next.beads.map(bead=>[bead.id,bead])));
    if(epoch!==generation||mission!==current)return;
    if(selected)history=await readHistory(run,current.workspace.cwd,selected,{BEADS_DIR:current.workspace.beadsDir??''});
    if(epoch!==generation)return;
   }
   await render();if(wake)await wakeCoordinator();
  }catch(error){if(epoch===generation){snapshot=snapshot?{...snapshot,error:String(error)}:{beads:[],leaves:[],ready:[],closed:0,active:0,blocked:0,fetchedAt:0,error:String(error)};await render();}}
  finally{refreshing=false;}
 }
 async function wakeCoordinator(){if(!ctx||!mission||operation||!eligible(ctx)||!ctx.isIdle()||ctx.hasPendingMessages())return;const action=nextAction(mission,snapshot,policy(ctx));if(action.gate){mission.gate=action.gate;if(ownership&&!resumeHold)await persist(mission);await render();return;}if(action.kind==='hold')return;const signature=JSON.stringify([mission.id,mission.round,action.kind,action.ids,mission.evidence.verify?.revision,mission.reviews.length]);if(signature===lastWake)return;lastWake=signature;pi.sendUserMessage(`Mission state changed: ${action.detail}. Consult mission_status and use mission_control for ${action.kind}. Do not bypass Pause, ownership, resume hold, or native approvals.`,{deliverAs:'followUp',attribution:'agent'});}
 async function request(context:ExtensionContext,op:string,extra:Record<string,unknown>={}){if(!eligible(context))throw new Error('Mission coordinator only');if(nativePlan(context))throw new Error('Mission mutations are forbidden in native plan mode');pi.sendUserMessage(`Operator requested mission_control ${JSON.stringify({operation:op,...extra})}. Execute through that tool and its ordinary native approval; do not use raw shell to bypass mission gates.`,{deliverAs:'followUp',attribution:'agent'});}
 async function inspect(context:ExtensionContext){if(!projection())throw new Error('No active mission');if(!context.hasUI)throw new Error('Fullscreen requires terminal UI');overlayAbort?.abort();overlayAbort=new AbortController();try{await context.ui.custom<void>((tui,theme,keys,done)=>createMissionInspector(()=>projection()!,{close:()=>done(),select:async id=>{selected=id;if(mission&&!id.startsWith('subagent:')&&effectiveGraph(mission)==='beads')history=await readHistory(run,mission.workspace.cwd,id,{BEADS_DIR:mission.workspace.beadsDir??''});else history=undefined;tui.requestRender();},actions:config.controls?()=>actions(context):undefined},()=>tui.terminal.rows)(tui,theme,keys),{signal:overlayAbort.signal});}finally{overlayAbort=undefined;}}
 async function decision(context:ExtensionContext,verb:string,arg?:string){
  if(!mission)throw new Error('No active mission');if(nativePlan(context))throw new Error('Mission mutations are forbidden in native plan mode');
  if(verb==='mode'){const modes:Mode[]=['auto','pause','force'];const mode=z.enum(['auto','pause','force']).parse(arg??modes[(modes.indexOf(mission.mode)+1)%3]);setMode(mission,mode);if(resumeHold)inspectionIntent.mode=mode;}
  else if(verb==='review'){mission.reviewRequested=true;if(mission.evidence.review?.outcome==='failed')delete mission.evidence.review;if(resumeHold)inspectionIntent.reviewRequested=true;}
  else if(verb==='approve'){if(resumeHold)throw new Error('Resumed inspection: continue before approving');if(!mission.gate)throw new Error('No displayed gate');approveGate(mission,mission.gate.token);}
  if(ownership)await persist(mission);await render();await wakeCoordinator();
 }
 async function configure(context:ExtensionContext, raw:string){
  const rest=raw.trim().replace(/^config\b/,'').trim();
  const active=mission??pending;
  const missionGraph=active?effectiveGraph(active):undefined;
  const custom=config.frontend==='custom'&&config.customCommand?` · ${config.customCommand}`:'';
  const where=displayConfigPath(agentDir);
  if(!rest){context.ui.notify(configNotice(where,false,`frontend ${config.frontend}${custom} · graph ${config.graph}${missionGraph?` · mission ${missionGraph}`:''}`),'info');return;}
  if(configError)throw new Error(configError);
  const [key,value]=rest.split(/\s+/);
  if(key==='graph'){
   if((value!=='local'&&value!=='beads')||rest.split(/\s+/).length!==2)throw new Error('Usage: /mission config graph local|beads');
   const written=validateMissionConfig({...config,graph:value});await writeMissionConfig(agentDir,written);config=written;
   const stay=missionGraph&&missionGraph!==config.graph?`. This mission stays ${missionGraph}`:'';
   context.ui.notify(configNotice(where,true,`graph ${config.graph}${stay}`),'info');
   return;
  }
  if(key!=='frontend'||!value)throw new Error('Usage: /mission config [frontend none|orca|herdr|custom -- <command>] | [graph local|beads]');
  if(!['none','orca','herdr','custom'].includes(value))throw new Error('frontend must be none, orca, herdr, or custom');
  const next:MissionConfig={...config,frontend:value as Frontend};
  if(value==='custom'){const command=rest.slice(rest.indexOf(value)+value.length).trim().replace(/^--\s*/,'');if(!command)throw new Error('Usage: /mission config frontend custom -- <command>');next.customCommand=command;}
  const written=validateMissionConfig(next);await writeMissionConfig(agentDir,written);config=written;const savedCustom=config.frontend==='custom'&&config.customCommand?` · ${config.customCommand}`:'';context.ui.notify(configNotice(where,true,`frontend ${config.frontend}${savedCustom}`),'info');
 }
 async function actions(context:ExtensionContext){if(!config.controls){context.ui.notify('Mission controls disabled. Set controls: true in mission.json; commands remain available.','info');return;}if(!mission)return;const options=['show'];if(resumeHold)options.push('continue');if(!nativePlan(context)){options.push('mode','review');if(!resumeHold&&mission.gate)options.push('approve');if(!resumeHold&&snapshot?.ready.length)options.push('dispatch');const worker=mission.workers.find(w=>w.beadId===selected);if(worker?.handle){options.push('focus');if(!resumeHold){options.push('resend');if(!mission.keep&&snapshot?.leaves.find(b=>b.id===selected)?.status==='closed')options.push('reap');}}}const chosen=await context.ui.select(`Mission actions${mission.gate?': '+mission.gate.detail:''}`,options);if(chosen)await command(chosen+(selected&&['focus','resend','reap'].includes(chosen)?' '+selected:''),context);}
 async function command(args:string,context:ExtensionContext){
  if(!eligible(context))return;ctx=context;
  try{
   const [verb,arg]=args.trim().split(/\s+/);
   if(verb==='config')return await configure(context,args);
   if(controls.includes(verb??'')){
    if(verb==='show')return await inspect(context);
    if(verb==='history'){
     if(!mission||!arg)throw new Error('Usage: /mission history <bead-id>');requireBeadsGraph(mission);
     if(!snapshot?.beads.some(b=>b.id===arg))throw new Error('Bead is outside mission');
     selected=arg;history=await readHistory(run,mission.workspace.cwd,arg,{BEADS_DIR:mission.workspace.beadsDir??''});
     await pi.sendMessage({customType:'mission:history',content:history.map(event=>`${event.timestamp} ${event.actor} ${event.event}: ${event.summary}`).join('\n'),display:true},{triggerTurn:false});
     await render();return;
    }
    if(verb==='focus'){
     const worker=mission?.workers.find(w=>w.beadId===arg);if(!worker)throw new Error('No mission worker for bead');
     await driver.focus(worker);return;
    }
    if(['mode','review','approve'].includes(verb!))return await decision(context,verb!,arg);
    if(verb==='continue')return await request(context,'continue');
    if(['resend','reap'].includes(verb!))return await request(context,verb!,{beadId:arg});
    return await request(context,'dispatch');
   }
 const parsed=parseMissionInput(args);if(parsed.force&&nativePlan(context))throw new Error('Force cannot execute inside native plan mode');const saved=await listMissions(agentDir);let target=parsed;
 if(!target.source&&target.freeform===undefined){
  if(mission){if(parsed.force&&mission.phase!=='complete')await request(context,'continue',{mode:parsed.pause?'pause':'force',keep:parsed.keep});return await render();}
  const inferred=await inferMissionSource(context.cwd,run,saved.map(item=>({path:item.path,source:item.mission.source,workspace:item.mission.workspace})));
  if(inferred.ambiguous.length){
   const choice=await context.ui.select('Select mission (inspection)',inferred.ambiguous);if(!choice)return;
   const hit=saved.find(item=>item.mission.source.id===choice||item.path===choice);if(hit)return await attach(hit.path,context);
   target={...target,source:choice};
  }else if(inferred.source){
   const hit=saved.find(item=>item.path===inferred.source);if(hit){await attach(hit.path,context);if(parsed.force&&mission!.phase!=='complete')await request(context,'continue',{mode:parsed.pause?'pause':'force',keep:parsed.keep});return;}
   target={...target,source:inferred.source};
  }else throw new Error(inferred.reason??'Usage: /mission CHR-142 | owner/repo#123 | -- description');
 }
 const source=await fetchSource(target,context.cwd,run);const workspace=await inspectWorkspace(context.cwd,run,{githubRepo:source.repo});assertSourceCheckout(source,workspace);const existing=saved.find(item=>item.mission.workspace.key===workspace.key&&item.mission.source.id===source.id);if(existing){await attach(existing.path,context);if(parsed.force&&mission!.phase!=='complete')await request(context,'continue',{mode:parsed.pause?'pause':'force',keep:parsed.keep});return;}
 const bound=saved.find(item=>item.mission.workspace.cwd===workspace.cwd&&item.mission.source.id!==source.id&&item.mission.phase!=='complete');if(bound)throw new Error(`Checkout is bound to ${bound.mission.source.id}`);
 if(!parsed.force&&!nativePlan(context))throw new Error('Start through /plan /mission, or use --force outside plan mode');
 pending={version:1,id:missionId(source),source,workspace,graph:config.graph,scopes:{},phase:'plan',evidence:{},mode:parsed.pause?'pause':parsed.force?'force':'auto',keep:parsed.keep,reviewRequested:parsed.force,workers:[],reviews:[],repairLinks:{},round:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 await pi.setSessionName(`${source.id} ${source.title}`);await render();
 const recovery=JSON.stringify(pending);
 context.setTimeout(()=>pi.sendUserMessage(`${coordinatorPrompt(source,parsed.force,config.frontend,pending!.graph)}\nMission pending recovery JSON:\n${recovery}`,{attribution:'agent'}),0);
 }catch(error){context.ui.notify(error instanceof Error?error.message:String(error),'error');}}
 const scopesSchema=z.record(z.string(),z.array(z.string()).min(1));
 pi.registerTool({name:'mission_status',defaultInactive:true,loadMode:'essential',label:'Mission status',description:'Inspect authoritative cached mission graph, hold, gates and next coordinator action.',approval:'read',parameters:z.object({}),execute:async(_id,_params,_signal,_update,context)=>{if(!eligible(context))throw new Error('Mission coordinator only');if(!operation)await refresh(false);return {content:[{type:'text',text:JSON.stringify(status(context))}],details:{}};}});
 const controlSchema=z.object({
  operation:z.enum(['start','continue','bind_workspace','bind_graph','dispatch','record_verification','record_delivery','run_review','accept_repairs','bind_repairs','resend','reap','reject_finding']),
  cwd:z.string().optional(),base:z.string().optional(),beadsDir:z.string().optional(),delivery:z.enum(['pr','local']).optional(),
  epicId:z.string().optional(),scopes:scopesSchema.optional(),repairLinks:z.record(z.string(),z.array(z.string())).optional(),
  beadId:z.string().optional(),detail:z.string().optional(),passed:z.boolean().optional(),url:z.string().optional(),
  mode:z.enum(['auto','pause','force']).optional(),keep:z.boolean().optional(),findingId:z.string().optional()
 });
 pi.registerTool({name:'mission_control',defaultInactive:true,loadMode:'essential',label:'Mission control',description:'Drive approved mission phases/workers/review. Every operation preserves native approvals, Pause gates, resume hold and ownership.',approval:'exec',parameters:controlSchema,execute:async(_id,rawParams,_signal,_update,context)=>{
  const params=controlSchema.parse(rawParams);
  if(!eligible(context)||nativePlan(context))throw new Error('Mission mutations are forbidden for children or native plan mode');if(operation)throw new Error('Mission operation already running');operation=true;operationSignal=_signal;ctx=context;const epoch=generation;let reviewStarted=false;
  const cancelReview=()=>{void reviewer.dispose();};_signal?.addEventListener('abort',cancelReview,{once:true});
  try{
   if(params.operation==='start'){if(mission)throw new Error('Mission already started');if(!pending)throw new Error('Resolve /mission source first');mission=pending;pending=undefined;path=missionPath(agentDir,mission);await acquire();resumeHold=false;mission.phase='isolate';mission.evidence.plan={outcome:'passed',detail:'Operator approved plan or explicit Force start',at:new Date().toISOString()};await persist(mission);pi.appendEntry('mission:pointer',{path});}
   else if(params.operation==='continue'){
    if(!mission)throw new Error('No saved mission');await acquire();const mode=params.mode??inspectionIntent.mode;if(mode)setMode(mission,mode);
    if(inspectionIntent.reviewRequested){mission.reviewRequested=true;if(mission.evidence.review?.outcome==='failed')delete mission.evidence.review;}
    if(params.keep!==undefined)mission.keep=params.keep;resumeHold=false;await persist(mission);inspectionIntent={};pi.appendEntry('mission:pointer',{path});
   }
   else{
    if(!mission)throw new Error('No active mission');enforceMutation(mission,policy(context));await ownership!.assertOwned();
    if(params.operation==='bind_workspace'){
     if(!params.cwd||!params.beadsDir||!params.delivery)throw new Error('cwd, canonical beadsDir and delivery required');const workspace=await inspectWorkspace(params.cwd,run,{explicitBase:params.base,delivery:params.delivery,githubRepo:mission.source.repo});if(workspace.key!==mission.workspace.key)throw new Error('Workspace repository identity differs');if(workspace.commonDir&&!workspace.base)throw new Error('Repository base unresolved');const bd=await run('bd',['--readonly','where','--json'],workspace.cwd,{BEADS_DIR:params.beadsDir});if(bd.code)throw new Error(bd.stderr||'Bead database unreachable');const where=JSON.parse(bd.stdout);if(await realpath(where.path)!==await realpath(params.beadsDir))throw new Error('BEADS_DIR does not match canonical database');workspace.beadsDir=await realpath(params.beadsDir);mission.workspace=workspace;mission.phase='graph';mission.evidence.isolate={outcome:'passed',detail:params.detail??workspace.cwd,at:new Date().toISOString()};
    }else if(params.operation==='bind_graph'||params.operation==='bind_repairs'){
     requireBeadsGraph(mission);const epic=params.epicId??mission.epicId;if(!epic||!params.scopes||!mission.workspace.beadsDir)throw new Error('Bound workspace, epic and complete file scopes required');const graph=await readGraph(run,mission.workspace.cwd,epic,{BEADS_DIR:mission.workspace.beadsDir});if(graph.error)throw new Error(graph.error);for(const [id,files] of Object.entries(params.scopes)){if(!graph.leaves.some(b=>b.id===id))throw new Error(`Not a descendant implementation leaf: ${id}`);for(const file of files){if(isAbsolute(file)||file.split('/').includes('..')||file==='.'||!file.trim())throw new Error(`Invalid file scope: ${file}`);}}
     if(params.operation==='bind_graph'&&graph.leaves.some(b=>!params.scopes![b.id]))throw new Error('Every implementation leaf requires scope');if(params.operation==='bind_repairs'){if(mission.phase!=='repair'||mission.evidence.repair?.outcome!=='active')throw new Error('Accept findings before binding repairs');if(!params.repairLinks)throw new Error('Finding links required');const findingIds=mission.reviews.at(-1)!.findings.filter(f=>!f.rejection).map(f=>f.id);for(const id of Object.keys(params.scopes)){const links=params.repairLinks[id];if(!links?.length||links.some(link=>!findingIds.includes(link)))throw new Error(`Invalid finding links: ${id}`);}if(findingIds.some(id=>!Object.values(params.repairLinks!).some(links=>links.includes(id))))throw new Error('Every actionable finding needs a repair bead');Object.assign(mission.repairLinks,params.repairLinks);mission.round++;delete mission.evidence.verify;delete mission.evidence.deliver;delete mission.gate;}
     mission.epicId=epic;Object.assign(mission.scopes,params.scopes);snapshot=graph;mission.phase=params.operation==='bind_repairs'?'repair':'execute';mission.evidence.graph={outcome:'passed',detail:`Epic ${epic}; scoped leaves ${Object.keys(mission.scopes).join(', ')}`,at:new Date().toISOString()};
    }else if(params.operation==='dispatch'){
     requireBeadsGraph(mission);await refresh(false);const action=nextAction(mission,snapshot,policy(context));if(action.gate){mission.gate=action.gate;await persist(mission);throw new Error(`Approval required: ${action.detail}`);}if(action.kind!=='dispatch'||!action.ids||!snapshot)throw new Error(action.detail);enforceGate(mission,waveGate(mission,action.ids,snapshot));await driver.dispatch(mission,action.ids.map(id=>({beadId:id,cwd:mission!.workspace.cwd,files:mission!.scopes[id]!})));mission.phase=mission.repairLinks[action.ids[0]!]?'repair':'execute';
    }else if(params.operation==='record_verification'){
     if(effectiveGraph(mission)!=='local'){await refresh(false);if(!snapshot||snapshot.error||snapshot.leaves.some(b=>b.status!=='closed'))throw new Error('Fresh closed implementation leaves required');}if(!params.detail||params.passed===undefined)throw new Error('Actual command/result detail and passed required');const captured=await captureRevision(mission,run);const previous=mission.reviews.at(-1);if(params.passed&&previous&&mission.round>previous.round&&previous.revision===captured.revision)throw new Error('Repair output unchanged; verification cannot resolve findings');mission.evidence.verify={outcome:params.passed?'passed':'failed',detail:params.detail,revision:captured.revision,at:new Date().toISOString()};delete mission.evidence.deliver;mission.phase=params.passed?'deliver':'verify';
    }else if(params.operation==='record_delivery'){
     if(mission.evidence.verify?.outcome!=='passed'||!params.detail)throw new Error('Passed verification and actual delivery evidence required');const captured=await captureRevision(mission,run);if(captured.revision!==mission.evidence.verify.revision)throw new Error('Revision changed since verification');if(mission.workspace.delivery==='pr'&&!/^https:\/\/[^\s]+\/pull\/\d+$/.test(params.url??''))throw new Error('Actual PR URL required');mission.evidence.deliver={outcome:'passed',detail:params.url?`${params.url}\n${params.detail}`:params.detail,revision:captured.revision,at:new Date().toISOString()};mission.phase='review';
    }else if(params.operation==='run_review'){
     await refresh(false);const action=nextAction(mission,snapshot,policy(context));
     if(!(action.kind==='review'||action.kind==='hold'&&action.gate?.kind==='review')||!mission.reviewRequested||mission.evidence.verify?.outcome!=='passed'||mission.evidence.deliver?.outcome!=='passed')throw new Error(action.detail);
     const revision=(await captureRevision(mission,run)).revision;if(revision!==mission.evidence.verify.revision)throw new Error('Revision changed since verification');
     enforceGate(mission,revisionGate(mission,'review',revision));mission.phase='review';mission.evidence.review={outcome:'active',detail:'Independent reviewer running',revision,at:new Date().toISOString()};await persist(mission);reviewStarted=true;
     const result=await reviewer.run(mission,context,run);if(epoch!==generation)throw new Error('Session changed during review');
     mission.reviews.push(result);mission.evidence.review={outcome:'passed',detail:result.summary,revision:result.revision,at:result.at};if(!result.findings.length){mission.phase='complete';mission.evidence.complete={outcome:'passed',detail:'Verification, delivery and independent review complete',revision:result.revision,at:result.at};}
    }else if(params.operation==='accept_repairs'){
     const review=mission.reviews.at(-1);if(!review||review.invalidated||!review.findings.some(f=>!f.rejection))throw new Error('No actionable findings');if((await captureRevision(mission,run)).revision!==review.revision)throw new Error('Review revision changed; reverify/rereview');enforceGate(mission,revisionGate(mission,'repairs',review.revision));mission.phase='repair';mission.evidence.repair={outcome:'active',detail:effectiveGraph(mission)==='local'?'Repair in this pane authorized':'Repair bead creation authorized; bind exact finding links/scopes',revision:review.revision,at:new Date().toISOString()};
    }else if(params.operation==='reject_finding'){
     const review=mission.reviews.at(-1);const finding=review?.findings.find(f=>f.id===params.findingId);if(!finding||!params.detail?.trim())throw new Error('Finding and visible non-actionable explanation required');
     if((await captureRevision(mission,run)).revision!==review!.revision)throw new Error('Finding belongs to a changed revision');
     finding.rejection=params.detail;await refresh(false);if(nextAction(mission,snapshot,policy(context)).kind==='complete'){mission.phase='complete';mission.evidence.complete={outcome:'passed',detail:'All independent findings explicitly rejected with recorded reasons',revision:review!.revision,at:new Date().toISOString()};}
    }else if(params.operation==='resend'||params.operation==='reap'){
     requireBeadsGraph(mission);if(!params.beadId)throw new Error('beadId required');await refresh(false);
     const bead=snapshot?.beads.find(b=>b.id===params.beadId);if(!bead||snapshot?.error)throw new Error('Fresh mission bead required');
     if(params.operation==='resend')await driver.resend(mission,params.beadId,bead);
     else await driver.reap(mission,params.beadId,bead);
    }
    if(epoch!==generation)throw new Error('Session changed during operation');await persist(mission);
   }
   await render();return {content:[{type:'text',text:JSON.stringify(status(context))}],details:{}};
  }catch(error){if(epoch===generation&&mission&&ownership&&reviewStarted){mission.evidence.review={outcome:'failed',detail:String(error),revision:mission.evidence.verify?.revision,at:new Date().toISOString()};await persist(mission);}await render();throw error;}
  finally{_signal?.removeEventListener('abort',cancelReview);operation=false;operationSignal=undefined;if(epoch===generation){lastWake='';await wakeCoordinator();}}
 }});
 pi.registerCommand('mission',{description:'Plan and coordinate work from a ticket or task through verification and review.',getArgumentCompletions:prefix=>missionArgumentCompletions(prefix,completionState),handler:command});
 void refreshCompletionSources();
 for(const [name,chord] of Object.entries(config.keys)){if(!chord)continue;pi.registerShortcut(chord as KeyId,{description:`Mission ${name}`,handler:async context=>{if(!eligible(context)||!projection())return;try{if(name==='expand'){expanded=!expanded;await render();}else if(name==='fullscreen')await inspect(context);else await decision(context,'mode');}catch(error){context.ui.notify(error instanceof Error?error.message:String(error),'error');}}});}
 pi.on('input',(event,context)=>{if(!eligible(context)||event.text.trim().split(/\s+/)[0]!=='/mission')return;const args=event.text.trim().slice('/mission'.length);const verb=args.trim().split(/\s+/)[0];if(controls.includes(verb??'')||mission)return;try{if(!parseMissionInput(args).force&&!nativePlan(context))return {text:`/plan ${event.text}`};}catch{ return; }});
 pi.on('session_start',async(_event,context)=>restore(context));pi.on('session_switch',async(_event,context)=>restore(context));pi.on('session_branch',async(_event,context)=>restore(context));pi.on('session_shutdown',async()=>detach());
 pi.on('auto_compaction_end',async(_event,context)=>{ctx=context;await render();});
 pi.on('before_subagent_spawn',(event)=>{subagents=noteSubagentSpawn(subagents,{agent:event.agent,invocationKind:event.invocationKind,spawnKey:event.spawnKey});void render();});
 pi.on('tool_execution_start',(event)=>{subagents=noteSubagentToolStart(subagents,event);void render();});
 pi.on('tool_execution_end',(event)=>{subagents=noteSubagentToolEnd(subagents,event);void render();});
 pi.on('agent_end',()=>{subagents=noteSubagentTurnEnd(subagents);void render();});
 pi.on('before_agent_start',(event,context)=>{if(!eligible(context)||!mission)return;const action=nextAction(mission,snapshot,policy(context));return {systemPrompt:[...(Array.isArray(event.systemPrompt)?event.systemPrompt:[event.systemPrompt]),`Mission ${mission.source.id}; phase ${mission.phase}; graph ${effectiveGraph(mission)}; epic ${mission.epicId??'unbound'}; mode ${mission.mode}; ${action.detail}. Coordinator never claims implementation beads or dispatches raw Orca. Use mission_status/mission_control.`]};});
 pi.events.on('mission:query',(request:unknown)=>{
  const query=request as {cwd?:unknown;reply?:unknown};
  if(typeof query.cwd!=='string'||typeof query.reply!=='function'||!ctx||!eligible(ctx)||!mission||query.cwd!==ctx.cwd)return;
  (query.reply as (value:unknown)=>void)({workspace:mission.workspace.cwd,beadsDir:mission.workspace.beadsDir,epicId:mission.epicId,graph:effectiveGraph(mission),mode:mission.mode,hold:nativePlan(ctx)?'Native plan mode':resumeHold?'Resume hold':ownershipError??(!ownership?'Controller ownership required':false),projection:snapshot?{ready:snapshot.ready,closed:snapshot.closed,total:snapshot.leaves.length,error:snapshot.error}:undefined});
 });
}
