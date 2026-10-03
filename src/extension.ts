import { realpath } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { matchesKey } from '@oh-my-pi/pi-tui';
import { z } from '@oh-my-pi/pi-coding-agent';
import { resolveLocalUrlToPath } from '@oh-my-pi/pi-coding-agent/internal-urls/local-protocol';
import type { ExtensionAPI, ExtensionContext } from '@oh-my-pi/pi-coding-agent';
import type { KeyId } from '@oh-my-pi/pi-tui';
import type { Action, Evidence, Mission, MissionConfig, Mode, Projection, Run, Snapshot, SubagentRow } from './types';
import { configNotice, displayConfigPath, formatMissionConfig, readMissionConfig, resolveAgentDir, validateMissionConfig, writeMissionConfig } from './config';
import { isRecord } from './guards';
import { assertSourceCheckout, displaySourceId, fetchSource, inferMissionSource, inspectWorkspace, parseMissionInput } from './sources';
import { acquireOwnership, listMissions, loadMission, missionId, missionPath, saveMission, validateMission } from './store';
import type { Ownership } from './store';
import { readClaimActor, readGraph, readHistory } from './beads';
import { createWorkerDriver } from './workers';
import { approveGate, autoDispatchAllowed, consumeGate, effectiveGraph, enforceGate, enforceMutation, nextAction, operatorStep, requireBeadsGraph, revisionGate, setMode, waveGate } from './controller';
import { captureRevision, Reviewer, roleModelString } from './review';
import { beadTask, coordinatorPrompt, guide, planSlug, workerPrompt } from './prompts';
import { createMissionWidget, createMissionInspector, phaseLabel } from './ui';
import { briefView, statusView, type NextView } from './status';
import { missionArgumentCompletions, VERBS, type MissionCompletionState } from './completions';
import { discoverBeadsDir, isolateCheckout } from './isolate';
import { contextFilesFor } from './context';
import { SubagentRunner, subagentPrompt } from './subagent';
import { copyPlanFile, sourceFilePath, writeSourceFile } from './hosts';
import { noteSubagentSpawn, noteSubagentToolEnd, noteSubagentToolStart, noteSubagentTurnEnd } from './subagents';

const controls = ['show','continue','mode','approve','review','history','focus','resend','release','dispatch','reap','actions','config'];
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
 try{config=await readMissionConfig(agentDir);}catch(error){configError=String(error);config={version:1,controls:false,maxWorkers:2,frontend:'none',graph:'local',modelRole:'default',workerRole:'default',workerContext:'project',reviewContext:'project',autoDispatch:false,keys:{expand:null,fullscreen:null,mode:null}};}
 let ctx:ExtensionContext|undefined;let mission:Mission|undefined;let path:string|undefined;let pending:Mission|undefined;
 let snapshot:Snapshot|undefined;let ownership:Ownership|undefined;let resumeHold=true;let ownershipError:string|undefined;
 let generation=0;let refreshing=false;let lastPoll=0;let lastWake='';let autoBlocked='';let quiet=false;let expanded=false;let outlineOffset=0;let selected:string|undefined;let history:Projection['history'];let timer:Timer|undefined;let overlayAbort:AbortController|undefined;let operation=false;let terminalInputDispose:(()=>void)|undefined;let subagents:SubagentRow[]=[];
 let lifetime=new AbortController();let operationSignal:AbortSignal|undefined;
 let inspectionIntent:{mode?:Mode;reviewRequested?:boolean}={};
 let reviewRows:SubagentRow[]=[];
 // Reviewers are in-process sessions: list them in the mission outline while they run, and keep their transcripts (also in Agent Hub) so a finished review can be inspected.
 const reviewDir=(m:Mission)=>join(agentDir,'missions',m.workspace.key,'reviews',m.id);
 const reviewer=new Reviewer(undefined,{sessionDir:reviewDir,progress:({label,state})=>{const id=`review:${label}`;reviewRows=[...reviewRows.filter(row=>row.id!==id),{id,name:label==='review'?'review':`review ${label}`,kind:'task',state}];void render();}});
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
 const projection = (): Projection | undefined => {
  const current = mission ?? pending;
  if (!current) return undefined;
  return {
   mission: current, snapshot, resumeHold: mission ? resumeHold : false,
   ownershipError, selected, history, expanded, outlineOffset,
   nativePlan: ctx ? nativePlan(ctx) : false,
   step: ctx ? currentStep(ctx) : undefined,
   frontend: config.frontend, expandKey: config.keys.expand, subagents: [...subagents,...reviewRows],
  };
 };
 // A pending mission has no saved action yet; a saved one asks the controller what a person can do now.
 function currentStep(context:ExtensionContext){
  if(operation&&mission)return {text:mission.evidence.review?.outcome==='active'?'Independent review running; the result is reported here when it ends':'Mission operation running'};
  if(mission){const p=policy(context);return operatorStep(mission,nextAction(mission,snapshot,p),p,ownershipError);}
  return pending&&nativePlan(context)?{text:'Approve the plan to start the mission'}:undefined;
 }
 let completionState:MissionCompletionState={sources:[],beads:[],workers:[]};
 function syncCompletions(){completionState={sources:completionState.sources,recommended:(ctx?currentStep(ctx)?.command:undefined)?.match(/^\/mission (\w+)/)?.[1],beads:(snapshot?.beads??[]).map(bead=>({id:bead.id,title:bead.title,category:bead.category})),workers:(mission?.workers??[]).map(worker=>({beadId:worker.beadId,state:worker.state,handle:!!worker.handle,stopped:worker.frontend==='subagent'&&!!worker.error&&worker.state!=='closed'}))};}
 async function refreshCompletionSources(){try{const saved=await listMissions(agentDir);completionState.sources=saved.map(item=>({id:item.mission.source.id,title:item.mission.source.title}));}catch{/* keep the previous source list */}}
 async function persist(value:Mission){if(value!==mission||!path||!ownership)throw new Error('No current controller ownership');await ownership.assertOwned();value.controllerNonce=ownership.nonce;value.updatedAt=new Date().toISOString();await saveMission(path,value);}
 // In-process workers report back here: a clean result already closed the bead; a rejected one waits for the operator.
 async function settleSubagent(beadId:string,outcome:{ok:true;summary:string}|{ok:false;error:string}){const m=mission;if(!m)return;const w=m.workers.findLast(x=>x.beadId===beadId&&x.state!=='closed');if(!w)return;if(outcome.ok){w.state='closed';w.error=undefined;}else w.error=outcome.error;try{if(ownership&&!resumeHold)await persist(m);}catch{/* ownership lost: the next resume reconciles from bd */}if(!outcome.ok&&ctx)ctx.ui.notify(`Worker ${beadId}: ${outcome.error}`,'warning');await refresh(true);}
 const workerAgents=new SubagentRunner({run,agentDir,config:()=>config,context:()=>ctx,onSettled:(beadId,outcome)=>{void settleSubagent(beadId,outcome);}});
 const driver=createWorkerDriver(run,{subagent:workerAgents,canMutate:()=>!!ctx&&!!ownership&&!resumeHold&&!ownershipError&&!nativePlan(ctx),persist:async value=>{if(value!==mission)throw new Error('Session changed during worker operation');if(ownership&&!resumeHold)await persist(value);},prompt:(mission,worker,task)=>config.frontend==='subagent'?subagentPrompt(mission,worker,task):workerPrompt(mission,worker,config.frontend,task),agentDir,model:()=>roleModelString(config.workerRole),frontend:()=>config.frontend,customCommand:()=>config.customCommand});
 function policy(context:ExtensionContext){return {resumeHold,owned:!!ownership&&!ownershipError,nativePlan:nativePlan(context),fresh:!!snapshot&&!snapshot.error&&Date.now()-snapshot.fetchedAt<35000,maxWorkers:config.maxWorkers};}
 // A guide is sent once per step: with the wake message, or with the first result that reaches that step.
 let guided='';
 function withGuide(next:Action|undefined,always:boolean):NextView|undefined{if(!next)return undefined;const text=guide(next.kind);if(!text||(!always&&guided===next.kind))return next;guided=next.kind;return {...next,guide:text};}
 function status(context:ExtensionContext,brief=false){const action=mission?nextAction(mission,snapshot,policy(context)):undefined;const running=action?extensionRuns(context,action):undefined;const next=withGuide(running?{kind:'hold',detail:`The extension is running ${running==='review'?'the review':'the wave'} itself and wakes you when it ends. Do not call ${running==='review'?'run_review':'dispatch'}; wait.`}:action,!brief);return (brief?briefView:statusView)({mission,pending,snapshot,resumeHold,ownershipError,next});}
 function bindTerminalInput(context:ExtensionContext){
  terminalInputDispose?.();
  terminalInputDispose=undefined;
  if(!context.hasUI)return;
  terminalInputDispose=context.ui.onTerminalInput(data=>{
   if(!projection()||overlayAbort)return;
   if(config.keys.expand&&matchesKey(data,config.keys.expand as KeyId)){
    expanded=!expanded;
    void render().catch(error=>context.ui.notify(error instanceof Error?error.message:String(error),'error'));
    return {consume:true};
   }
   if(!expanded)return;
   const direction=matchesKey(data,'alt+up')?-1:matchesKey(data,'alt+down')?1:0;
   if(!direction)return;
   outlineOffset=Math.max(0,Math.min(Math.max(0,(snapshot?.beads.length??1)-1),outlineOffset+direction));
   void render();
   return {consume:true};
  });
 }
 async function render(){
  syncCompletions();
  const context=ctx;
  const epoch=generation;
  if(!context||!eligible(context))return;const active=pi.getActiveTools();const enabled=!!(mission||pending);
  const current=mission??pending;
  if(current&&context.sessionManager.getSessionName()===`${current.source.id} ${current.source.title}`)await pi.setSessionName(`${displaySourceId(current.source)} ${current.source.title}`);
  if(active.includes('mission_status')!==enabled||active.includes('mission_control')!==enabled)await pi.setActiveTools([...active.filter(name=>!['mission_status','mission_control'].includes(name)),...(enabled?['mission_status','mission_control']:[])]);
  if(ctx!==context||generation!==epoch)return;
  bindTerminalInput(context);
  if(!context.hasUI)return;
  if(!projection()||overlayAbort){context.ui.setWidget('mission',undefined);return;}
  context.ui.setWidget('mission',(tui,theme)=>createMissionWidget(()=>projection()!,()=>tui.terminal.rows,theme),{placement:'aboveEditor'});
 }
 async function acquire(){if(!mission||!path)throw new Error('No saved mission');if(ownership){await ownership.assertOwned();return;}ownershipError=undefined;ownership=await acquireOwnership(path,mission,error=>{ownershipError=`Controller lost: ${error.message}`;resumeHold=true;lastWake='';void reviewer.dispose();void render();});mission=ownership.mission;mission.controllerNonce=ownership.nonce;}
 async function release(){const current=ownership;ownership=undefined;await current?.release();}
 async function detach(context?:ExtensionContext){generation++;lifetime.abort();lifetime=new AbortController();terminalInputDispose?.();terminalInputDispose=undefined;overlayAbort?.abort();overlayAbort=undefined;if(timer&&ctx)ctx.clearTimer(timer);timer=undefined;await reviewer.dispose();await workerAgents.abortAll();await release();ctx?.ui.setWidget('mission',undefined);ctx=context;mission=undefined;pending=undefined;path=undefined;snapshot=undefined;resumeHold=true;ownershipError=undefined;lastWake='';guided='';selected=undefined;history=undefined;lastPoll=0;outlineOffset=0;inspectionIntent={};subagents=[];reviewRows=[];}
 async function attach(file:string,context:ExtensionContext,announce=true){await release();mission=await loadMission(file);path=file;pending=undefined;snapshot=undefined;resumeHold=true;ownershipError=undefined;ctx=context;await refresh(false);await render();
  const step=announce?currentStep(context):undefined;
  if(step)context.ui.notify(`${displaySourceId(mission.source)} · ${phaseLabel(mission.phase)}. ${step.command?`Next: ${step.command} — `:''}${step.text}. /mission opens the action menu.`,'info');
 }
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
    if(ctx&&ownership&&!resumeHold&&!ownershipError&&!nativePlan(ctx)){for(const worker of current.workers.filter(w=>w.state==='missing')){const bead=next.beads.find(b=>b.id===worker.beadId);if(bead)try{await driver.recover(current,worker.beadId,bead);}catch{/* claimed or not ready: stays held for the operator */}}}
    if(epoch!==generation||mission!==current)return;
    if(selected)history=await readHistory(run,current.workspace.cwd,selected,{BEADS_DIR:current.workspace.beadsDir??''});
    if(epoch!==generation)return;
   }
   await render();if(wake)await wakeCoordinator();
  }catch(error){if(epoch===generation){snapshot=snapshot?{...snapshot,error:String(error)}:{beads:[],leaves:[],ready:[],closed:0,active:0,blocked:0,fetchedAt:0,error:String(error)};await render();}}
  finally{refreshing=false;}
 }
 const dispatchSignature=(m:Mission,action:Action)=>JSON.stringify([m.id,m.round,action.ids,m.workers.length]);
 const reviewSignature=(m:Mission)=>JSON.stringify([m.id,m.round,m.evidence.verify?.revision,m.reviews.length]);
 // The step the extension starts by itself once the current operation ends. A control result must not tell the coordinator to run it too:
 // the model's own call raced the extension's and failed ("Workers running", "Mission operation already running").
 function extensionRuns(context:ExtensionContext,action:Action):'dispatch'|'review'|undefined{
  const m=mission;if(!m)return undefined;
  if(autoDispatchAllowed(m,action,config.autoDispatch,policy(context))&&dispatchSignature(m,action)!==autoBlocked)return 'dispatch';
  if(action.kind==='review'&&!action.gate&&m.reviewRequested&&reviewSignature(m)!==reviewBlocked)return 'review';
  return undefined;
 }
 async function autoDispatch(context:ExtensionContext,action:Action):Promise<boolean>{
  const m=mission;if(!m||!autoDispatchAllowed(m,action,config.autoDispatch,policy(context)))return false;
  const signature=dispatchSignature(m,action);
  if(signature===autoBlocked)return false;
  try{await control({operation:'dispatch'},context);context.ui.notify(`Auto-dispatched ${action.ids?.join(', ')}`,'info');return true;}
  catch(error){autoBlocked=signature;context.ui.notify(`Auto-dispatch held, handing to the coordinator: ${error instanceof Error?error.message:String(error)}`,'warning');return false;}
 }
 // Workers cannot resolve the coordinator's local:// root, so the approved plan is copied where their assignment points. Best effort: a missing plan only costs workers the slice text.
 async function sharePlan(m:Mission,context:ExtensionContext){
  const options=context.localProtocolOptions;if(!options)return;
  try{await copyPlanFile(m,resolveLocalUrlToPath(`local://${planSlug(m.source)}-plan.md`,options));}catch{/* no plan written (forced run, or local graph) */}
 }
 // A clean independent review of the verified revision ends the mission. That is bookkeeping, not judgement: recording it here saves the
 // coordinator a full-context turn (~$0.24 on a large session) that only answers "complete", and fixes a mission re-verified after its
 // review (a PR retarget, say) that otherwise stays in phase `review` forever.
 async function finishMission(context:ExtensionContext){
  const m=mission;const review=m?.reviews.at(-1);if(!m||!review||!ownership||resumeHold||ownershipError)return;
  await ownership.assertOwned();
  m.phase='complete';
  m.evidence.complete={outcome:'passed',detail:'Verification, delivery and independent review complete',revision:review.revision,at:new Date().toISOString()};
  if(m.evidence.repair?.outcome==='active')m.evidence.repair={...m.evidence.complete};
  await persist(m);await render();
  context.ui.notify('Mission complete: verified, delivered and independently reviewed clean. /mission clear starts fresh.','info');
 }
 async function wakeCoordinator(){if(quiet||!ctx||!mission||operation||!eligible(ctx))return;const action=nextAction(mission,snapshot,policy(ctx));if(action.gate){mission.gate=action.gate;if(ownership&&!resumeHold)await persist(mission);await render();return;}if(action.kind==='hold')return;if(action.kind==='complete'){await finishMission(ctx).catch(error=>ctx?.ui.notify(`Could not mark the mission complete: ${error instanceof Error?error.message:String(error)}`,'warning'));return;}if(await autoDispatch(ctx,action))return;if(autoReview(ctx,action))return;
 // Only the model needs an idle session with an empty queue. Dispatch above never touches it, so a stuck queue cannot stall the wave.
 if(!ctx.isIdle()||ctx.hasPendingMessages())return;const signature=JSON.stringify([mission.id,mission.round,action.kind,action.ids,mission.evidence.verify?.revision,mission.reviews.length]);if(signature===lastWake)return;lastWake=signature;const view=withGuide(action,true)!;pi.sendUserMessage(`Mission: ${action.detail}${action.ids?.length?` [${action.ids.join(', ')}]`:''}. Next: ${action.kind}. ${view.guide??''}`.trim(),{attribution:'agent'});}
 async function request(context:ExtensionContext,op:string,extra:Record<string,unknown>={}){
  if(!eligible(context))throw new Error('Mission coordinator only');
  await control({operation:op,...extra},context);
  const step=currentStep(context);
  context.ui.notify(`Mission ${op} done${step?`. Next: ${step.command?`${step.command} — `:''}${step.text}`:''}`,'info');
 }
 async function inspect(context:ExtensionContext){
  if(!projection())throw new Error('No active mission');
  if(!context.hasUI)throw new Error('Fullscreen requires terminal UI');
  overlayAbort?.abort();
  const abort=new AbortController();
  overlayAbort=abort;
  await render();
  try{
   await context.ui.custom<void>((tui,theme,keys,done)=>createMissionInspector(()=>projection()!,{
    close:()=>done(),
    select:async id=>{selected=id;if(mission&&!id.startsWith('subagent:')&&effectiveGraph(mission)==='beads')history=await readHistory(run,mission.workspace.cwd,id,{BEADS_DIR:mission.workspace.beadsDir??''});else history=undefined;tui.requestRender();},
    actions:config.controls?()=>actions(context):undefined,
   },()=>tui.terminal.rows)(tui,theme,keys),{signal:abort.signal});
  }finally{
   if(overlayAbort===abort){overlayAbort=undefined;await render();}
  }
 }
 async function decision(context:ExtensionContext,verb:string,arg?:string){
  if(!mission)throw new Error('No active mission');if(nativePlan(context))throw new Error('Mission mutations are forbidden in native plan mode');
  if(verb==='mode'){const modes:Mode[]=['auto','pause','force'];const mode=z.enum(['auto','pause','force']).parse(arg??modes[(modes.indexOf(mission.mode)+1)%3]);setMode(mission,mode);if(resumeHold)inspectionIntent.mode=mode;}
  else if(verb==='review'){mission.reviewRequested=true;if(mission.evidence.review?.outcome==='failed')delete mission.evidence.review;if(resumeHold)inspectionIntent.reviewRequested=true;}
  else if(verb==='approve'){if(resumeHold)throw new Error('Resumed session is read-only: run /mission continue first, then /mission approve');if(!mission.gate)throw new Error('No gate is waiting for approval. /mission shows what is next');approveGate(mission,mission.gate.token);}
  if(ownership)await persist(mission);await render();
  if(!resumeHold&&ownership&&!operation&&(verb==='review'||verb==='approve')){
   reviewBlocked='';
   await refresh(false);
   // Approving a gate is the operator's authorization of exactly that step, and the step is mechanical once approved, so run it here instead of paying a coordinator turn to relay a tool call.
   if(verb==='approve'){
    const next=nextAction(mission,snapshot,policy(context));
    if(next.kind==='dispatch'){await request(context,'dispatch');return;}
    if(next.kind==='repairs'&&mission.evidence.repair?.outcome!=='active'){await request(context,'accept_repairs');return;}
   }
  }
  await wakeCoordinator();
  // A hold wakes nothing and renders no gate, so say why instead of leaving the command silent.
  const after=nextAction(mission,snapshot,policy(context));
  if(!operation&&after.kind==='hold'&&!after.gate&&(verb==='review'||resumeHold))context.ui.notify(resumeHold?`Resumed session is read-only: run /mission continue first. Your ${verb==='review'?'review request is queued and starts':'change is queued and applies'} then.`:after.detail,resumeHold?'warning':'info');
 }
 // The review runs in its own session, so the coordinator would only relay a tool call (a full-context turn). A requested review that is ready (and, in Pause, approved) starts here, the way autoDispatch does for waves.
 let reviewBlocked='';
 function autoReview(context:ExtensionContext,action:Action):boolean{
  const m=mission;if(!m||action.kind!=='review'||action.gate||!m.reviewRequested)return false;
  const signature=reviewSignature(m);
  if(signature===reviewBlocked)return false;
  const startedAt=Date.now();
  context.ui.notify('Independent review started in its own session. It can take several minutes; the result is reported here.','info');
  // Fire and forget: a review can outlast the command handler, and every outcome is reported through notify.
  void control({operation:'run_review'},context).then(()=>{
   const round=mission?.reviews.at(-1);const open=round?.findings.filter(finding=>!finding.rejection).length??0;
   const took=`${Math.round((Date.now()-startedAt)/1000)}s`;
   const transcripts=mission?.reviews.at(-1)?.transcripts?` Reviewer transcripts: ${Object.keys(mission.reviews.at(-1)!.transcripts!).join(', ')} (paths in /mission show, evidence view; open one with omp --resume <path>).`:'';
   // A bare "passed" proves nothing happened; say what the reviewers reported, and where the full text is.
   const checked=round?.summary.replace(/\s+/g,' ').trim();const excerpt=checked?` ${checked.length>280?`${checked.slice(0,280)}…`:checked} (full text: /mission show, evidence view)`:'';
   context.ui.notify(round?(open?`Independent review found ${open} issue${open===1?'':'s'} in ${took}. /mission shows the next step.${transcripts}`:`Independent review passed with no findings in ${took}.${excerpt}${transcripts}`):'Independent review finished.','info');
  },error=>{reviewBlocked=signature;context.ui.notify(`Review failed: ${error instanceof Error?error.message:String(error)}. /mission review retries it.`,'error');});
  return true;
 }
 async function configure(context:ExtensionContext, raw:string){
  const rest=raw.trim().replace(/^config\b/,'').trim();
  const active=mission??pending;
  const missionGraph=active?effectiveGraph(active):undefined;
  const where=displayConfigPath(agentDir);
  if(!rest){await pi.sendMessage({customType:'mission:config',content:formatMissionConfig(config,where,missionGraph),display:true},{triggerTurn:false});return;}
  if(configError)throw new Error(configError);
  const [key,value]=rest.split(/\s+/);
  if(key==='graph'){
   if((value!=='local'&&value!=='beads')||rest.split(/\s+/).length!==2)throw new Error('Usage: /mission config graph local|beads');
   const written=validateMissionConfig({...config,graph:value});await writeMissionConfig(agentDir,written);config=written;
   const stay=missionGraph&&missionGraph!==config.graph?`. This mission stays ${missionGraph}`:'';
   context.ui.notify(configNotice(where,true,`graph ${config.graph}${stay}`),'info');
   return;
  }
  if(key==='modelRole'||key==='workerRole'||key==='workerContext'||key==='reviewContext'||key==='autoDispatch'){
   const words=rest.split(/\s+/);const flags=['on','off','true','false'];
   if(words.length!==2||!value||(key==='autoDispatch'&&!flags.includes(value)))throw new Error(key==='autoDispatch'?'Usage: /mission config autoDispatch on|off':key==='workerContext'||key==='reviewContext'?`Usage: /mission config ${key} project|all|none`:`Usage: /mission config ${key} <role>  (default, task, smol, slow, ...)`);
   const written=validateMissionConfig({...config,...(key==='autoDispatch'?{autoDispatch:value==='on'||value==='true'}:{[key]:value})});await writeMissionConfig(agentDir,written);config=written;
   if(key==='autoDispatch'){autoBlocked='';await wakeCoordinator();}
   context.ui.notify(configNotice(where,true,key==='autoDispatch'?`autoDispatch ${config.autoDispatch?'on':'off'}`:`${key} ${config[key]}`),'info');
   return;
  }
  if(key!=='frontend'||!value)throw new Error('Usage: /mission config [frontend none|orca|herdr|custom|subagent -- <command>] | [graph local|beads] | [modelRole <role>] | [workerRole <role>] | [workerContext project|all|none] | [reviewContext project|all|none] | [autoDispatch on|off]');
  const customCommand = value === 'custom' ? rest.slice(rest.indexOf(value) + value.length).trim().replace(/^--\s*/, '') : undefined;
  if (value === 'custom' && !customCommand) throw new Error('Usage: /mission config frontend custom -- <command>');
  const next = validateMissionConfig({...config, frontend: value, ...(customCommand ? {customCommand} : {})});
  await writeMissionConfig(agentDir, next);
  config = next;
  const savedCustom = config.frontend === 'custom' && config.customCommand ? ` · ${config.customCommand}` : '';
  context.ui.notify(configNotice(where, true, `frontend ${config.frontend}${savedCustom}`), 'info');
 }
 async function actions(context:ExtensionContext){
  if(!projection())throw new Error('No active mission');
  const options=['show'];
  if(mission){
   if(resumeHold)options.push('continue');
   if(!nativePlan(context)){
    options.push('mode','review');
    if(!resumeHold&&mission.gate)options.push('approve');
    if(!resumeHold&&snapshot?.ready.length)options.push('dispatch');
    const worker=mission.workers.findLast(w=>w.beadId===selected);
    if(worker?.handle){
     options.push('focus');
     if(!resumeHold){
      options.push('resend');
      if(worker.state!=='closed'&&worker.frontend==='subagent')options.push('release');
      if(!mission.keep&&snapshot?.leaves.find(b=>b.id===selected)?.status==='closed')options.push('reap');
     }
    }
   }
  }
  const step=currentStep(context);
  const recommended=step?.command?.match(/^\/mission (\w+)/)?.[1];
  const ordered=recommended&&options.includes(recommended)?[recommended,...options.filter(verb=>verb!==recommended)]:options;
  const labels=new Map(ordered.map(verb=>[`${verb===recommended?'▸':' '} ${verb} — ${VERBS.find(entry=>entry.name===verb)?.short??''}`,verb]));
  const head=projection()!.mission;
  const picked=await context.ui.select(`${displaySourceId(head.source)} · ${phaseLabel(head.phase)}${step?` — ${step.command?`Next: ${step.command} — `:''}${step.text}`:''}`,[...labels.keys()]);
  const chosen=picked?labels.get(picked):undefined;
  if(chosen)await command(chosen+(selected&&['focus','resend','release','reap'].includes(chosen)?' '+selected:''),context);
 }
 async function command(args:string,context:ExtensionContext){
  if(!eligible(context))return;ctx=context;
  try{
   const [verb,arg]=args.trim().split(/\s+/);
   if(verb==='config')return await configure(context,args);
   if(controls.includes(verb??'')){
    if(verb==='actions')return await actions(context);
    if(verb==='show')return await inspect(context);
    if(verb==='history'){
     if(!mission||!arg)throw new Error('Usage: /mission history <bead-id>');requireBeadsGraph(mission);
     if(!snapshot?.beads.some(b=>b.id===arg))throw new Error('Bead is outside mission');
     selected=arg;history=await readHistory(run,mission.workspace.cwd,arg,{BEADS_DIR:mission.workspace.beadsDir??''});
     await pi.sendMessage({customType:'mission:history',content:history.slice(0,12).map(event=>`${event.timestamp} ${event.actor} ${event.event}: ${event.summary}`).join('\n'),display:true},{triggerTurn:false});
     await render();return;
    }
    if(verb==='focus'){
     if(!arg)throw new Error('Usage: /mission focus <bead-id>');
     if(!mission)throw new Error('No active mission');
     const current=mission;
     const file=path;
     const saved=file?await loadMission(file):current;
     if(mission!==current||path!==file)throw new Error('Session changed during worker focus');
     const worker=saved.workers.findLast(w=>w.beadId===arg);
     if(!worker)throw new Error(`No dispatched mission worker for ${arg}`);
     selected=arg;
     await driver.focus(worker);return;
    }
    if(['mode','review','approve'].includes(verb!))return await decision(context,verb!,arg);
    if(verb==='continue')return await request(context,'continue');
    if(verb==='resend'){const note=args.trim().split(/\s+/).slice(2).join(' ');return await request(context,'resend',{beadId:arg,...(note?{detail:note}:{})});}
    if(['release','reap'].includes(verb!))return await request(context,verb!,{beadId:arg});
    return await request(context,'dispatch');
   }
 const parsed=parseMissionInput(args);if(parsed.force&&nativePlan(context))throw new Error('Force cannot execute inside native plan mode');const saved=await listMissions(agentDir);let target=parsed;
 if(!target.source&&target.freeform===undefined){
  if(mission){if(parsed.force&&mission.phase!=='complete')await request(context,'continue',{mode:parsed.pause?'pause':'force',keep:parsed.keep});if(!parsed.force&&context.hasUI)return await actions(context);return await render();}
  const inferred=await inferMissionSource(context.cwd,run,saved.map(item=>({path:item.path,source:item.mission.source,workspace:item.mission.workspace})));
  if(inferred.ambiguous.length){
   const choice=await context.ui.select('Select mission (inspection)',inferred.ambiguous);if(!choice)return;
   const hit=saved.find(item=>item.mission.source.id===choice||item.path===choice);if(hit)return await attach(hit.path,context,!parsed.force);
   target={...target,source:choice};
  }else if(inferred.source){
   const hit=saved.find(item=>item.path===inferred.source);if(hit){await attach(hit.path,context,!parsed.force);if(parsed.force&&mission!.phase!=='complete')await request(context,'continue',{mode:parsed.pause?'pause':'force',keep:parsed.keep});return;}
   target={...target,source:inferred.source};
  }else throw new Error(inferred.reason??'Usage: /mission CHR-142 | owner/repo#123 | -- description');
 }
 const source=await fetchSource(target,context.cwd,run);const workspace=await inspectWorkspace(context.cwd,run,{githubRepo:source.repo});assertSourceCheckout(source,workspace);const existing=saved.find(item=>item.mission.workspace.key===workspace.key&&item.mission.source.id===source.id);if(existing){await attach(existing.path,context,!parsed.force);if(parsed.force&&mission!.phase!=='complete')await request(context,'continue',{mode:parsed.pause?'pause':'force',keep:parsed.keep});return;}
 const bound=saved.find(item=>item.mission.workspace.cwd===workspace.cwd&&item.mission.source.id!==source.id&&item.mission.phase!=='complete');if(bound)throw new Error(`Checkout is bound to ${bound.mission.source.id}`);
 if(!parsed.force&&!nativePlan(context))throw new Error('Start through /plan /mission, or use --force outside plan mode');
 const planned: Mission = {version:1,id:missionId(source),source,workspace,graph:config.graph,scopes:{},phase:'plan',evidence:{},mode:parsed.pause?'pause':parsed.force?'force':'auto',keep:parsed.keep,reviewRequested:parsed.force,workers:[],reviews:[],repairLinks:{},round:1,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
 pending = planned;
 const prompt = `${coordinatorPrompt(source, parsed.force, config.frontend, planned.graph)}\nMission pending recovery JSON:\n${JSON.stringify(planned)}`;
 await pi.setSessionName(`${displaySourceId(source)} ${source.title}`);
 await render();
 context.setTimeout(() => pi.sendUserMessage(prompt, {attribution:'agent'}), 0);
 }catch(error){context.ui.notify(error instanceof Error?error.message:String(error),'error');}}
 const scopesSchema=z.record(z.string(),z.array(z.string()).min(1));
 pi.registerTool({name:'mission_status',defaultInactive:true,loadMode:'essential',label:'Mission status',description:'Inspect authoritative cached mission graph, hold, gates and next coordinator action.',approval:'read',parameters:z.object({}),execute:async(_id,_params,_signal,_update,context)=>{if(!eligible(context))throw new Error('Mission coordinator only');if(!operation)await refresh(false);return {content:[{type:'text',text:JSON.stringify(status(context))}],details:{}};}});
 const controlSchema=z.object({
  operation:z.enum(['start','continue','bind_workspace','bind_graph','dispatch','record_verification','record_delivery','run_review','accept_repairs','bind_repairs','resend','release','reap','reject_finding']),
  cwd:z.string().optional(),base:z.string().optional(),beadsDir:z.string().optional(),delivery:z.enum(['pr','local']).optional(),
  epicId:z.string().optional(),scopes:scopesSchema.optional(),repairLinks:z.record(z.string(),z.array(z.string())).optional(),
  beadId:z.string().optional(),detail:z.string().optional(),passed:z.boolean().optional(),url:z.string().optional(),
  mode:z.enum(['auto','pause','force']).optional(),keep:z.boolean().optional(),findingId:z.string().optional()
 });
 async function control(rawParams:unknown,context:ExtensionContext,_signal?:AbortSignal,internal:{reuseOnly?:boolean}={}){
  const params=controlSchema.parse(rawParams);
  if(!eligible(context)||nativePlan(context))throw new Error('Mission mutations are forbidden for children or native plan mode');if(operation)throw new Error('Mission operation already running');operation=true;operationSignal=_signal;ctx=context;const epoch=generation;let reviewStarted=false;
  const cancelReview=()=>{void reviewer.dispose();};_signal?.addEventListener('abort',cancelReview,{once:true});
  try{
   if(params.operation==='start'){if(mission)throw new Error('Mission already started');if(!pending)throw new Error('Resolve /mission source first');mission=pending;pending=undefined;path=missionPath(agentDir,mission);await acquire();resumeHold=false;mission.phase='isolate';mission.evidence.plan={outcome:'passed',detail:'Operator approved plan or explicit Force start',at:new Date().toISOString()};await persist(mission);pi.appendEntry('mission:pointer',{path});await writeSourceFile(mission);}
   else if(params.operation==='continue'){
    if(!mission)throw new Error('No saved mission');await acquire();const mode=params.mode??inspectionIntent.mode;if(mode)setMode(mission,mode);
    if(inspectionIntent.reviewRequested){mission.reviewRequested=true;if(mission.evidence.review?.outcome==='failed')delete mission.evidence.review;}
    if(params.keep!==undefined)mission.keep=params.keep;resumeHold=false;await persist(mission);inspectionIntent={};pi.appendEntry('mission:pointer',{path});
   }
   else{
    if(!mission)throw new Error('No active mission');enforceMutation(mission,policy(context));await ownership!.assertOwned();
    if(params.operation==='bind_workspace'){
     let {cwd,beadsDir,delivery,base}=params;let note='';
     if(!cwd){const isolated=await isolateCheckout(run,{source:mission.source,start:mission.workspace.cwd,base,delivery,create:!internal.reuseOnly});cwd=isolated.cwd;base??=isolated.base;delivery??=isolated.delivery;note=`${isolated.created?'created':'reusing'} ${cwd}`;}
     else if(!delivery&&mission.source.kind==='freeform')delivery='local';
     beadsDir??=await discoverBeadsDir(run,cwd);
     const workspace=await inspectWorkspace(cwd,run,{explicitBase:base,delivery,githubRepo:mission.source.repo});if(workspace.key!==mission.workspace.key)throw new Error('Workspace repository identity differs');if(workspace.commonDir&&!workspace.base)throw new Error('Repository base unresolved');const bd=await run('bd',['--readonly','where','--json'],workspace.cwd,{BEADS_DIR:beadsDir});if(bd.code)throw new Error(bd.stderr||'Bead database unreachable');const where=JSON.parse(bd.stdout);if(await realpath(where.path)!==await realpath(beadsDir))throw new Error('BEADS_DIR does not match canonical database');workspace.beadsDir=await realpath(beadsDir);mission.workspace=workspace;mission.phase='graph';mission.evidence.isolate={outcome:'passed',detail:params.detail??(note||workspace.cwd),at:new Date().toISOString()};
    }else if(params.operation==='bind_graph'||params.operation==='bind_repairs'){
     requireBeadsGraph(mission);const epic=params.epicId??mission.epicId;if(!epic||!params.scopes||!mission.workspace.beadsDir)throw new Error('Bound workspace, epic and complete file scopes required');const graph=await readGraph(run,mission.workspace.cwd,epic,{BEADS_DIR:mission.workspace.beadsDir});if(graph.error)throw new Error(graph.error);for(const [id,files] of Object.entries(params.scopes)){if(!graph.leaves.some(b=>b.id===id))throw new Error(`Not a descendant implementation leaf: ${id}`);for(const file of files){if(isAbsolute(file)||file.split('/').includes('..')||file==='.'||!file.trim())throw new Error(`Invalid file scope: ${file}`);}}
     if(params.operation==='bind_graph'&&graph.leaves.some(b=>!params.scopes![b.id]))throw new Error('Every implementation leaf requires scope');if(params.operation==='bind_repairs'){if(mission.phase!=='repair'||mission.evidence.repair?.outcome!=='active')throw new Error('Accept findings before binding repairs');if(!params.repairLinks)throw new Error('Finding links required');const findingIds=mission.reviews.at(-1)!.findings.filter(f=>!f.rejection).map(f=>f.id);for(const id of Object.keys(params.scopes)){const links=params.repairLinks[id];if(!links?.length||links.some(link=>!findingIds.includes(link)))throw new Error(`Invalid finding links: ${id}`);}if(findingIds.some(id=>!Object.values(params.repairLinks!).some(links=>links.includes(id))))throw new Error('Every actionable finding needs a repair bead');Object.assign(mission.repairLinks,params.repairLinks);mission.round++;delete mission.evidence.verify;delete mission.evidence.deliver;delete mission.gate;}
     mission.epicId=epic;Object.assign(mission.scopes,params.scopes);snapshot=graph;mission.phase=params.operation==='bind_repairs'?'repair':'execute';mission.evidence.graph={outcome:'passed',detail:`Epic ${epic}; scoped leaves ${Object.keys(mission.scopes).join(', ')}`,at:new Date().toISOString()};
    }else if(params.operation==='dispatch'){
     requireBeadsGraph(mission);await refresh(false);const action=nextAction(mission,snapshot,policy(context));if(action.gate){mission.gate=action.gate;await persist(mission);throw new Error(`Approval required: ${action.detail}`);}if(action.kind!=='dispatch'||!action.ids||!snapshot)throw new Error(action.detail);
     enforceGate(mission,waveGate(mission,action.ids,snapshot));
     await sharePlan(mission,context);
     await driver.dispatch(mission,action.ids.map(id=>({beadId:id,cwd:mission!.workspace.cwd,files:mission!.scopes[id]!,task:beadTask(snapshot?.beads.find(b=>b.id===id))})));
     consumeGate(mission);mission.phase=mission.repairLinks[action.ids[0]!]?'repair':'execute';
    }else if(params.operation==='record_verification'){
     if (effectiveGraph(mission) !== 'local') {
      await refresh(false);
      if (!snapshot || snapshot.error || !snapshot.leaves.length || snapshot.leaves.some(bead => bead.category !== 'closed')) {
       throw new Error('Fresh closed implementation leaves required');
      }
     }
     if (!params.detail || params.passed === undefined) throw new Error('Actual command/result detail and passed required');
     const captured = await captureRevision(mission, run);
     const previous = mission.reviews.at(-1);
     if (params.passed && previous && previous.findings.some(finding => !finding.rejection) && mission.round > previous.round && previous.revision === captured.revision) {
      throw new Error('Repair output unchanged; verification cannot resolve findings');
     }
     const evidence: Evidence = {
      outcome: params.passed ? 'passed' : 'failed',
      detail: params.detail,
      revision: captured.revision,
      ...(params.passed?{tree:captured.tree}:{}),
      at: new Date().toISOString(),
     };
     mission.evidence.verify = evidence;
     if (mission.evidence.repair && mission.evidence.repair.outcome !== 'skipped' && previous && mission.round > previous.round) {
      mission.evidence.repair = { ...evidence };
     }
     delete mission.evidence.deliver;
     mission.phase = params.passed ? 'deliver' : 'verify';
    }else if(params.operation==='record_delivery'){
     if(mission.evidence.verify?.outcome!=='passed'||!params.detail)throw new Error('Passed verification and actual delivery evidence required');const captured=await captureRevision(mission,run);
     if(captured.revision!==mission.evidence.verify.revision){
      // Committing the verified files moves HEAD but not their bytes: the verification still describes what ships, so carry it to the new HEAD instead of failing and forcing a rerun.
      if(!mission.evidence.verify.tree||captured.tree!==mission.evidence.verify.tree)throw new Error('Revision changed since verification');
      mission.evidence.verify={...mission.evidence.verify,revision:captured.revision};
     }
     if(mission.workspace.delivery==='pr'&&!/^https:\/\/[^\s]+\/pull\/\d+$/.test(params.url??''))throw new Error('Actual PR URL required');mission.evidence.deliver={outcome:'passed',detail:params.url?`${params.url}\n${params.detail}`:params.detail,revision:captured.revision,at:new Date().toISOString()};mission.phase='review';
    }else if(params.operation==='run_review'){
     await refresh(false);const action=nextAction(mission,snapshot,policy(context));
     if(!(action.kind==='review'||action.kind==='hold'&&action.gate?.kind==='review')||!mission.reviewRequested||mission.evidence.verify?.outcome!=='passed'||mission.evidence.deliver?.outcome!=='passed')throw new Error(action.detail);
     // The review diff is measured from the PR's real base; the mission's guess (e.g. the repo default branch) is wrong for stacked or integration-branch PRs.
     if(mission.workspace.delivery==='pr'&&mission.workspace.commonDir){const pr=await run('gh',['pr','view','--json','baseRefName'],mission.workspace.cwd);let prBase:unknown;try{prBase=pr.code===0?JSON.parse(pr.stdout).baseRefName:undefined;}catch{/* no PR yet: keep the recorded base */}if(typeof prBase==='string'&&prBase&&prBase!==mission.workspace.base)mission.workspace.base=prBase;}
     const revision=(await captureRevision(mission,run)).revision;if(revision!==mission.evidence.verify.revision)throw new Error('Revision changed since verification');
     enforceGate(mission,revisionGate(mission,'review',revision));mission.phase='review';mission.evidence.review={outcome:'active',detail:'Independent reviewer running',revision,at:new Date().toISOString()};await persist(mission);reviewStarted=true;reviewRows=[];await render();
     const reviewFiles=await contextFilesFor(config.reviewContext,mission.workspace.cwd,agentDir);const targets=config.frontend==='subagent'&&mission.graph==='beads'&&snapshot?snapshot.leaves.filter(b=>mission!.scopes[b.id]?.length).map(b=>({id:b.id,title:b.title,text:beadTask(b)??b.title,files:mission!.scopes[b.id]!})):[];const result=targets.length>1?await reviewer.runPerBead(mission,context,run,config.modelRole,reviewFiles,targets):await reviewer.run(mission,context,run,config.modelRole,reviewFiles);if(epoch!==generation)throw new Error('Session changed during review');
     consumeGate(mission);
     mission.reviews.push(result);
     mission.evidence.review = {outcome:'passed',detail:result.summary,revision:result.revision,at:result.at};
     if (!result.findings.length) {
      mission.phase = 'complete';
      mission.evidence.complete = {outcome:'passed',detail:'Verification, delivery and independent review complete',revision:result.revision,at:result.at};
      if (mission.evidence.repair?.outcome === 'active') mission.evidence.repair = {...mission.evidence.complete};
     }
    }else if(params.operation==='accept_repairs'){
     const review = mission.reviews.at(-1);
     if (!review || review.invalidated || !review.findings.some(finding => !finding.rejection)) throw new Error('No actionable findings');
     if ((await captureRevision(mission, run)).revision !== review.revision) throw new Error('Review revision changed; reverify/rereview');
     enforceGate(mission, revisionGate(mission, 'repairs', review.revision));
     const local = effectiveGraph(mission) === 'local';
     if (local) {
      mission.round = Math.max(mission.round, review.round + 1);
      delete mission.evidence.verify;
      delete mission.evidence.deliver;
     }
     mission.phase = 'repair';
     mission.evidence.repair = {
      outcome: 'active',
      detail: local ? 'Repair in this pane authorized' : 'Repair bead creation authorized; bind exact finding links/scopes',
      revision: review.revision,
      at: new Date().toISOString(),
     };
     consumeGate(mission);
    }else if(params.operation==='reject_finding'){
     const review = mission.reviews.at(-1);
     const finding = review?.findings.find(finding => finding.id === params.findingId);
     if (!review || !finding || !params.detail?.trim()) throw new Error('Finding and visible non-actionable explanation required');
     if ((await captureRevision(mission, run)).revision !== review.revision) throw new Error('Finding belongs to a changed revision');
     finding.rejection = params.detail;
     const evidence: Evidence = {outcome:'passed',detail:'All independent findings explicitly rejected with recorded reasons',revision:review.revision,at:new Date().toISOString()};
     if (!review.findings.some(finding => !finding.rejection) && mission.evidence.repair?.outcome === 'active') {
      mission.evidence.repair = {...evidence, outcome:'skipped'};
     }
     await refresh(false);
     if (nextAction(mission, snapshot, policy(context)).kind === 'complete') {
      mission.phase = 'complete';
      mission.evidence.complete = evidence;
     }
    }else if(params.operation==='resend'||params.operation==='release'||params.operation==='reap'){
     requireBeadsGraph(mission);if(!params.beadId)throw new Error('beadId required');await refresh(false);
     const bead=snapshot?.beads.find(b=>b.id===params.beadId);if(!bead||snapshot?.error)throw new Error('Fresh mission bead required');
     if(params.operation==='resend')await driver.resend(mission,params.beadId,bead,params.detail);
     else if(params.operation==='release'){await driver.release(mission,params.beadId,bead);await refresh(false);}
     else await driver.reap(mission,params.beadId,bead);
    }
    if(epoch!==generation)throw new Error('Session changed during operation');await persist(mission);
   }
   await render();return status(context,true);
  }catch(error){if(epoch===generation&&mission&&ownership&&reviewStarted){mission.evidence.review={outcome:'failed',detail:String(error),revision:mission.evidence.verify?.revision,at:new Date().toISOString()};await persist(mission);}await render();throw error;}
  finally{_signal?.removeEventListener('abort',cancelReview);operation=false;operationSignal=undefined;if(epoch===generation){lastWake='';await wakeCoordinator();}}
 }
 pi.registerTool({name:'mission_control',defaultInactive:true,loadMode:'essential',label:'Mission control',description:'Drive approved mission phases/workers/review. Every operation preserves native approvals, Pause gates, resume hold and ownership.',approval:'exec',parameters:controlSchema,execute:async(_id,rawParams,signal,_update,context)=>({content:[{type:'text',text:JSON.stringify(await control(rawParams,context,signal))}],details:{}})});
 pi.registerCommand('mission',{description:'Plan and coordinate work from a ticket or task through verification and review.',getArgumentCompletions:prefix=>missionArgumentCompletions(prefix,completionState),handler:command});
 void refreshCompletionSources();
 for(const [name,chord] of Object.entries(config.keys)){if(name==='expand'||!chord)continue;pi.registerShortcut(chord as KeyId,{description:`Mission ${name}`,handler:async context=>{if(!eligible(context)||!projection())return;try{if(name==='fullscreen')await inspect(context);else await decision(context,'mode');}catch(error){context.ui.notify(error instanceof Error?error.message:String(error),'error');}}});}
 pi.on('input',(event,context)=>{if(!eligible(context)||event.text.trim().split(/\s+/)[0]!=='/mission')return;const args=event.text.trim().slice('/mission'.length);const verb=args.trim().split(/\s+/)[0];if(controls.includes(verb??'')||mission)return;try{if(!parseMissionInput(args).force&&!nativePlan(context))return {text:`/plan ${event.text}`};}catch{ return; }});
 pi.on('session_start',async(_event,context)=>restore(context));pi.on('session_switch',async(_event,context)=>restore(context));pi.on('session_branch',async(_event,context)=>restore(context));pi.on('session_shutdown',async()=>detach());
 pi.on('auto_compaction_end',async(_event,context)=>{ctx=context;await render();});
 // Approving the plan is the approval to start. Start (and bind a checkout that already belongs to the ticket)
 // before the first execution turn, and hand the model its next step in the same turn.
 pi.on('before_agent_start',async(event,context)=>{
  if(!eligible(context)||mission||!pending||nativePlan(context))return;
  if(!event.prompt.startsWith('Plan approved.')&&!event.prompt.includes('Mission pending recovery JSON'))return;
  const notes:string[]=[];quiet=true;
  try{
   await control({operation:'start'},context);notes.push('Mission started.');
   const started=mission as Mission|undefined;
   if(started&&effectiveGraph(started)==='beads'){
    try{await control({operation:'bind_workspace'},context,undefined,{reuseOnly:true});const bound=mission as Mission|undefined;if(bound)notes.push(`Checkout bound: ${bound.workspace.cwd}, delivery ${bound.workspace.delivery}, beads ${bound.workspace.beadsDir}.`);}
    catch(error){notes.push(`Checkout not bound automatically (${error instanceof Error?error.message:String(error)}).`);}
   }
  }catch(error){context.ui.notify(`Mission did not start: ${error instanceof Error?error.message:String(error)}`,'error');return;}
  finally{quiet=false;}
  const current=mission as Mission|undefined;if(!current)return;
  const action=nextAction(current,snapshot,policy(context));
  lastWake=JSON.stringify([current.id,current.round,action.kind,action.ids,current.evidence.verify?.revision,current.reviews.length]);
  const view=withGuide(action,true);
  return {message:{customType:'mission:started',content:`${notes.join(' ')} Next: ${action.kind}. ${view?.guide??action.detail}`,display:false}};
 });
 // Pin what a lossy summary must not lose, and re-teach the current step afterwards.
 pi.on('session.compacting',async()=>{
  const m=mission as Mission|undefined;if(!m)return;
  await writeSourceFile(m).catch(()=>{});
  const open=m.workers.filter(w=>w.state!=='closed').map(w=>`${w.beadId}:${w.state}`).join(', ')||'none';
  const waiting=snapshot?.leaves.filter(b=>b.category!=='closed').map(b=>`${b.id}:${b.category}`).join(', ')||'none';
  return {context:[
   `Mission ${m.id} (${displaySourceId(m.source)}): ${m.source.title}. The full ticket is in ${sourceFilePath(m)}; it is not in this summary, read it when needed.`,
   `Phase ${m.phase}, mode ${m.mode}, graph ${effectiveGraph(m)}, epic ${m.epicId??'unbound'}, round ${m.round}. Checkout ${m.workspace.cwd}${m.workspace.branch?` on ${m.workspace.branch}`:''}, base ${m.workspace.base??'none'}, delivery ${m.workspace.delivery}.`,
   `Open workers: ${open}. Unfinished beads: ${waiting}.`,
   'Call mission_status for evidence and review findings, then follow the next-step guidance it returns.',
  ]};
 });
 pi.on('session_compact',()=>{guided='';});
 pi.on('before_subagent_spawn',(event)=>{subagents=noteSubagentSpawn(subagents,{agent:event.agent,invocationKind:event.invocationKind,spawnKey:event.spawnKey});void render();});
 pi.on('tool_execution_start',(event)=>{subagents=noteSubagentToolStart(subagents,event);void render();});
 pi.on('tool_execution_end',(event)=>{subagents=noteSubagentToolEnd(subagents,event);void render();});
 pi.on('agent_end',()=>{subagents=noteSubagentTurnEnd(subagents);void render();});
 pi.events.on('mission:query',(request:unknown)=>{
  if(!isRecord(request)||typeof request.cwd!=='string'||typeof request.reply!=='function'||!ctx||!eligible(ctx)||!mission||request.cwd!==ctx.cwd)return;
  request.reply({workspace:mission.workspace.cwd,beadsDir:mission.workspace.beadsDir,epicId:mission.epicId,graph:effectiveGraph(mission),mode:mission.mode,hold:nativePlan(ctx)?'Native plan mode':resumeHold?'Resume hold':ownershipError??(!ownership?'Controller ownership required':false),projection:snapshot?{ready:snapshot.ready,closed:snapshot.closed,total:snapshot.leaves.length,error:snapshot.error}:undefined});
 });
}
