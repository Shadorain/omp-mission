import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import type { ExtensionContext, PlanReviewChoice } from '@oh-my-pi/pi-coding-agent';
import { deliverUrl, displayPhase, effectiveGraph, modelRetryTargets, operatorCommands, providerCapacity, quotaBlocked, repairBudgetReason, reviewTriageAction, reviewRetryAt } from './controller';
import { isRecord } from './guards';
import { displaySourceId } from './sources';
import { missionDirectory } from './store';
import { phases, type Evidence, type Frontend, type Mission, type MissionCheck, type MissionMeasurements, type Mode, type PolicyContext, type Snapshot, type Step } from './types';

// The holotable fleet contract (omp-holotable/docs/contract.md). Kept local: the repos do not import across.
export const OPERATOR_OPS = ['approve', 'continue', 'mode', 'review', 'dispatch', 'check', 'resend', 'release', 'reap', 'clear', 'plan-approve', 'retry-model'] as const;
const SOCKET_OPS: Record<string, true> = { ping: true, approve: true, continue: true, mode: true, review: true, dispatch: true, check: true, resend: true, release: true, reap: true, clear: true, plan: true, 'plan-edit': true, 'plan-refine': true, 'plan-approve': true, 'retry-model': true };
// 1 MiB: a plan-edit request carries up to 256 KiB of text plus JSON escaping overhead.
const MAX_LINE = 1024 * 1024;
const MAX_PLAN = 256 * 1024;

export interface MissionProblem {
 kind: 'quota' | 'rate-limit' | 'timeout' | 'error';
 source: string;
 detail: string;
 retryAt: string | null;
 attempt: number | null;
 completed: number | null;
 total: number | null;
}

function missionProblem(m: Mission, graphError?: string): MissionProblem | null {
 if (m.phase === 'complete') return null;
 const review = m.evidence.review;
 const worker = m.workers.find(w => w.state !== 'closed' && w.error);
 const triage=reviewTriageAction(m);
 const escalation=triage?.kind==='hold'?triage.detail:undefined;
 const budgetExhausted=escalation!==undefined&&escalation===repairBudgetReason(m);
 const source = graphError ? 'graph' : m.blocker ? 'coordinator' : escalation ? budgetExhausted?'repair-budget':'triage'
  : review?.outcome === 'failed' ? 'review' : worker ? 'worker'
  : m.evidence.verify?.outcome === 'failed' ? 'verification' : undefined;
 const detail = graphError ?? m.blocker ?? escalation ?? (source === 'review' ? review!.detail : worker?.error ?? (source === 'verification' ? m.evidence.verify!.detail : undefined));
 if (!source || !detail) return null;
 const capacity = providerCapacity(detail);
 const retry = source === 'review' ? reviewRetryAt(m) : undefined;
 return {
  kind: source === 'repair-budget' ? 'error' : capacity === 'quota' ? 'quota' : capacity === 'rate' ? 'rate-limit'
   : /deadline exceeded|timed out|timeout/i.test(detail) ? 'timeout' : 'error',
  source, detail, retryAt: retry === undefined ? null : new Date(retry).toISOString(),
  attempt: source === 'review' ? review!.attempts ?? 1 : null,
  completed: source === 'review' && m.reviewProgress ? Object.keys(m.reviewProgress.targets).length : null,
  total: source === 'review' && m.reviewProgress ? Object.keys(m.reviewProgress.inputs).length : null,
 };
}
export interface ReviewStatus {
 startedAt:string; deadlineAt:string; active:number; completed:number; total:number; models:string[];
}
export interface ContactStatus {
	schema: 1;
	id: string;
	ticket: string;
	title: string;
	worktree: string;
	base: string | null;
	phase: string;
	progress: { step: number; of: number } | null;
	hold: 'none' | 'plan-approval' | 'resume' | 'gate' | 'blocked' | 'quota' | 'question';
	gate: { kind: string; id: string } | null;
	next: string | null;
	actions: string[];
	workers: { live: number; total: number } | null;
	delivery: { url: string | null; branch: string | null } | null;
	complete: boolean;
	revision: string;
	plan: { path: string; revision: string } | null;
	mode: Mode | null;
	/** Latest verification outcome; 'failed' means `continue` would re-open broken work, so automation must not send it. */
	verify: Evidence['outcome'] | null;
 problem?: MissionProblem | null;
 review?:ReviewStatus|null;
 model?:string|null;
	/** Latest operator-requested PR check; absent until the first check or on older missions. */
	check?: MissionCheck | null;
	usage: UsageTotals | null;
 measurements?: Measurements | null;
 usageEvidence?: UsageEvidence | null;
	ctl: { socket: string; generation: number } | null;
	updatedAt: string;
	/** Identity of the publishing process; owned=false marks a read-only inspection pane. */
	session?: { id: string; pid: number; processStart: string | null; terminal: string | null; owned: boolean };
}

// Linux /proc start-time beats PID reuse; null on other platforms or an exited process.
let selfStart: string | null | undefined;
export function processStartTicks(pid: number): string | null {
	if (pid === process.pid && selfStart !== undefined) return selfStart;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const ticks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
		const result = ticks && /^\d+$/.test(ticks) ? ticks : null;
		if (pid === process.pid) selfStart = result;
		return result;
	} catch {
		if (pid === process.pid) selfStart = null;
		return null;
	}
}

export interface UsageTotals {
	tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
	costUsd: number | null;
	sessions: number;
}

export interface MeasurementConfig { graph:'local'|'beads'; frontend:Frontend; maxWorkers:number; reviewConcurrency:number; mode:Mode }
export interface Measurements extends Omit<MissionMeasurements,'lastVerification'> {
 completedRounds:number; invalidatedRounds:number; findingOccurrences:number; latestActionable:number; latestRejected:number;
 severity:{critical:number;high:number;medium:number;low:number};
 workerAttempts:number; workerBeads:number; repairRound:number; repairLinks:number; config:MeasurementConfig;
}
export interface UsageSource extends UsageTotals { role:'coordinator'|'worker'|'review'; id:string; pricedMessages:number; unpricedMessages:number }
export interface UsageEvidence {
 v:1; measuredAt:string; sources:UsageSource[]; missing:number; unsupportedWorkers:number;
 malformedLines:number; resets:number; backlogBytes:number; partial:boolean;
}
export interface UsageMeasurement { usage:UsageTotals|null; evidence:UsageEvidence }
interface UsageAccumulator { totals:UsageTotals; pricedMessages:number; unpricedMessages:number; malformedLines:number }

function usageAccumulator():UsageAccumulator {
 return {totals:{tokens:{input:0,output:0,cacheRead:0,cacheWrite:0},costUsd:null,sessions:0},pricedMessages:0,unpricedMessages:0,malformedLines:0};
}
function consumeUsage(acc:UsageAccumulator,record:unknown):void {
 if(!isRecord(record)||record.type!=='message'||!isRecord(record.message)||record.message.role!=='assistant')return;
 const usage=record.message.usage;
 if(!isRecord(usage)){acc.malformedLines++;return;}
 for(const key of TOKEN_KEYS){
  const value=usage[key];
  if(value===undefined&&(key==='cacheRead'||key==='cacheWrite'))continue;
  if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0){acc.malformedLines++;return;}
 }
 const cost=isRecord(usage.cost)?usage.cost.total:undefined;
 if(cost!==undefined&&(typeof cost!=='number'||!Number.isFinite(cost)||cost<0)){acc.malformedLines++;return;}
 for(const key of TOKEN_KEYS)acc.totals.tokens[key]+=(usage[key] as number|undefined)??0;
 acc.totals.sessions=1;
 if(typeof cost==='number'){acc.totals.costUsd=(acc.totals.costUsd??0)+cost;acc.pricedMessages++;}
 else acc.unpricedMessages++;
}

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'] as const;

function mergeUsage(target: UsageTotals, source: UsageTotals | null): void {
	if (!source) return;
	for (const key of TOKEN_KEYS) target.tokens[key] += source.tokens[key];
	if (source.costUsd !== null) target.costUsd = (target.costUsd ?? 0) + source.costUsd;
	target.sessions += source.sessions;
}

export function sumAssistantUsage(records:readonly unknown[],acc=usageAccumulator()):UsageTotals|null {
 for(const record of records)consumeUsage(acc,record);
 return acc.totals.sessions?acc.totals:null;
}

export function gateTokenId(token: string): string {
	return createHash('sha256').update(token).digest('hex').slice(0, 12);
}
export function planRevision(text: string): string {
	return createHash('sha256').update(text).digest('hex').slice(0, 12);
}

export function statusFilePath(agentDir: string, mission: Pick<Mission, 'id' | 'workspace'>): string {
	return join(missionDirectory(agentDir, mission.workspace.key), 'status', `${mission.id}.json`);
}

interface FileUsage extends UsageAccumulator { offset:number; size:number; dev:number; ino:number; discard:boolean; role:'worker'|'review' }

export class UsageProbe {
 private readonly files=new Map<string,FileUsage>();
 private stamp=0;
 private key='';
 private cursor=0;
 private resetCount=0;
 private cache:UsageMeasurement|undefined;
 private scratch:{chunk:Buffer;line:Buffer}|undefined;
 constructor(private readonly agentDir:string,private readonly now:()=>number=Date.now,private readonly intervalMs=30_000){}

 async measure(mission:Mission,coordinator:()=>{sessionFile:string|null;entries:readonly unknown[]}|undefined,force=false):Promise<UsageMeasurement>{
  const key=`${mission.workspace.key} ${mission.id}`,now=this.now();
  if(!force&&this.key===key&&this.cache&&now-this.stamp<this.intervalMs)return this.cache;
  if(this.key!==key){this.files.clear();this.cursor=0;this.resetCount=0;}
  this.key=key;this.stamp=now;
  const evidence:UsageEvidence={v:1,measuredAt:new Date(now).toISOString(),sources:[],missing:0,unsupportedWorkers:0,malformedLines:0,resets:0,backlogBytes:0,partial:false};
  const totals:UsageTotals={tokens:{input:0,output:0,cacheRead:0,cacheWrite:0},costUsd:null,sessions:0};
  const coord=coordinator(),acc=usageAccumulator();
  const coordinatorUsage=sumAssistantUsage(coord?.entries??[],acc);
  mergeUsage(totals,coordinatorUsage);
  evidence.malformedLines+=acc.malformedLines;
  if(!coord?.sessionFile)evidence.missing++;
  else if(coordinatorUsage)evidence.sources.push({role:'coordinator',id:`coordinator:${createHash('sha256').update(coord.sessionFile).digest('hex').slice(0,32)}`,...coordinatorUsage,pricedMessages:acc.pricedMessages,unpricedMessages:acc.unpricedMessages});
  const base=missionDirectory(this.agentDir,mission.workspace.key);
  const workerDir=await realpath(join(base,'workers')).catch(()=>resolve(base,'workers'));
  const reviewDir=await realpath(join(base,'reviews',mission.id)).catch(()=>resolve(base,'reviews',mission.id));
  const owned=new Map<string,'worker'|'review'>();
  const add=async(path:string,root:string,role:'worker'|'review')=>{
   const canonical=await realpath(path).catch(()=>resolve(path));
   if(!canonical.startsWith(`${root}${sep}`)||!canonical.endsWith('.jsonl')){evidence.missing++;return;}
   owned.set(canonical,role);
  };
  for(const worker of mission.workers){
   if(worker.frontend!=='subagent'){evidence.unsupportedWorkers++;continue;}
   if(!worker.incarnationId){evidence.missing++;continue;}
   await add(worker.incarnationId,workerDir,'worker');
  }
  let reviewNames:string[]=[];
  try{reviewNames=await readdir(reviewDir);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')evidence.missing++;}
  for(const name of reviewNames)if(name.endsWith('.jsonl'))await add(join(reviewDir,name),reviewDir,'review');
  if(![...owned.values()].includes('review')&&mission.evidence.review&&['active','passed','failed'].includes(mission.evidence.review.outcome))evidence.missing++;
  const paths=[...owned.keys()].sort(),seen=new Set<string>();
  const scratch=paths.length?(this.scratch??={chunk:Buffer.allocUnsafe(64*1024),line:Buffer.allocUnsafe(1024*1024)}):undefined;
  const budget={remaining:4*1024*1024};
  for(let i=0;i<paths.length;i++){
   const path=paths[(this.cursor+i)%paths.length]!;
   seen.add(path);
   await this.readUsageFile(path,owned.get(path)!,budget,scratch!.chunk,scratch!.line,evidence);
  }
  if(paths.length)this.cursor=(this.cursor+1)%paths.length;
  for(const [path] of this.files)if(!seen.has(path))evidence.missing++;
  for(const role of ['worker','review'] as const){
   const aggregate=usageAccumulator();
   for(const entry of this.files.values())if(entry.role===role){
    mergeUsage(aggregate.totals,entry.totals);
    aggregate.pricedMessages+=entry.pricedMessages;aggregate.unpricedMessages+=entry.unpricedMessages;aggregate.malformedLines+=entry.malformedLines;
   }
   evidence.malformedLines+=aggregate.malformedLines;
   if(aggregate.totals.sessions){
    const source:UsageSource={role,id:`${role}:${createHash('sha256').update(mission.id).digest('hex').slice(0,32)}`,...aggregate.totals,pricedMessages:aggregate.pricedMessages,unpricedMessages:aggregate.unpricedMessages};
    evidence.sources.push(source);mergeUsage(totals,source);
   }
  }
  evidence.resets=this.resetCount;
  evidence.partial=evidence.missing>0||evidence.unsupportedWorkers>0||evidence.malformedLines>0||evidence.resets>0||evidence.backlogBytes>0||acc.unpricedMessages>0||evidence.sources.some(s=>s.unpricedMessages>0);
  this.cache={usage:totals.sessions?totals:null,evidence};
  return this.cache;
 }

 private async readUsageFile(path:string,role:'worker'|'review',budget:{remaining:number},chunk:Buffer,line:Buffer,evidence:UsageEvidence):Promise<void>{
  let file;
  try{file=await open(path,'r');}catch{evidence.missing++;return;}
  try{
   const stat=await file.stat();
   let entry=this.files.get(path);
   if(entry&&(entry.dev!==stat.dev||entry.ino!==stat.ino||stat.size<entry.size)){this.resetCount++;entry=undefined;}
   if(!entry){entry={...usageAccumulator(),offset:0,size:stat.size,dev:stat.dev,ino:stat.ino,discard:false,role};this.files.set(path,entry);}
   entry.size=stat.size;
   let position=entry.offset,length=0;
   while(position<stat.size&&budget.remaining>0){
    const size=Math.min(chunk.length,stat.size-position,budget.remaining);
    const {bytesRead}=await file.read(chunk,0,size,position);
    if(!bytesRead)break;
    budget.remaining-=bytesRead;
    let start=0;
    while(start<bytesRead){
     const newline=chunk.indexOf(0x0a,start),end=newline===-1||newline>=bytesRead?bytesRead:newline;
     const bytes=end-start;
     if(!entry.discard){
      if(length+bytes>line.length){entry.discard=true;entry.malformedLines++;length=0;}
      else{chunk.copy(line,length,start,end);length+=bytes;}
     }
     if(end<bytesRead){
      if(!entry.discard&&length){
       try{consumeUsage(entry,JSON.parse(line.toString('utf8',0,length)));}catch{entry.malformedLines++;}
      }
      entry.discard=false;length=0;entry.offset=position+end+1;
     }
     start=end+1;
    }
    position+=bytesRead;
    if(entry.discard)entry.offset=position;
   }
   evidence.backlogBytes+=Math.max(0,stat.size-entry.offset);
  }catch{evidence.missing++;}
  finally{await file.close();}
 }
}

export interface StatusInput {
	mission: Mission;
	pending: boolean;
	resumeHold: boolean;
	snapshot: Snapshot | undefined;
	policy: PolicyContext;
	step: Step | undefined;
	owned: boolean;
	selected: string | undefined;
	operation: boolean;
	ctl: { socket: string; generation: number } | null;
	usage: UsageTotals | null;
 usageEvidence?:UsageEvidence;
 measurementConfig?:MeasurementConfig;
 review?:ReviewStatus|null;
 model?:string|null;
	planPath?: string;
	planReview?: boolean;
	question?: string;
	/** Publish identity: the board tests process liveness directly, independent of socket or freshness. */
	session?: { id: string; owned: boolean };
}

// Pure projection of mission state into the fleet status file. Async only for the worktree realpath.
export async function buildContactStatus(input: StatusInput): Promise<ContactStatus> {
	const m = input.mission;
	const phase = displayPhase(m, input.snapshot);
	const worktree = await realpath(m.workspace.cwd).catch(() => m.workspace.cwd);
	// An unreadable bead graph stops the controller (nextAction holds on snapshot.error) even though no blocker is saved.
	const graphDown = phase !== 'complete' && !!m.epicId && effectiveGraph(m) === 'beads' && !!input.snapshot?.error;
	const question = phase !== 'complete' ? input.question : undefined;
 const triage=reviewTriageAction(m);const escalation=triage?.kind==='hold'?triage.detail:undefined;
	const hold = question ? 'question'
		: quotaBlocked(m) ? 'quota'
		: input.pending ? (m.blocker ? 'blocked' : 'plan-approval')
		: input.resumeHold && phase !== 'complete' ? 'resume'
  : escalation ? 'blocked'
		: m.gate ? 'gate'
		: m.blocker || graphDown ? 'blocked'
		: 'none';
	const actions = question ? [] : input.pending
		// plan-approve answers OMP's interactive plan review, never a question or a parked planning turn.
		? (!m.blocker && input.planReview ? ['plan-approve'] : [])
		: [...new Set(
			operatorCommands(m, false, input.snapshot, input.policy, input.selected, input.operation)
				.map(command => command.split(' ')[0]!)
				.filter((verb): verb is (typeof OPERATOR_OPS)[number] => (OPERATOR_OPS as readonly string[]).includes(verb)),
		)];
	if (!question && !input.pending && !input.operation && modelRetryTargets(m, input.snapshot, input.policy)) actions.push('retry-model');
	const url = deliverUrl(m);
	const branch = m.workspace.branch ?? null;
	const next = question ? `Answer in mission: ${question}`.replace(/\s+/g, ' ').slice(0, 240)
		: m.blocker ? m.blocker.replace(/\s+/g, ' ').slice(0, 240)
  : escalation && !input.resumeHold ? escalation.slice(0,240)
		: input.step ? `${input.step.command ? `${input.step.command} — ` : ''}${input.step.text}`.replace(/\s*\n\s*/g, ' ').slice(0, 240) : null;
 const measured=m.measurements;
 const latest=m.reviews.at(-1);
 const severity={critical:0,high:0,medium:0,low:0};
 let findingOccurrences=0,invalidatedRounds=0,repairLinks=0;
 for(const round of m.reviews){if(round.invalidated)invalidatedRounds++;for(const finding of round.findings){findingOccurrences++;severity[finding.severity]++;}}
 for(const links of Object.values(m.repairLinks))repairLinks+=links.length;
 const measurements:Measurements|null=measured&&input.measurementConfig?{
  v:1,since:measured.since,recordedPassed:measured.recordedPassed,recordedFailed:measured.recordedFailed,
  repeatedFailedRevision:measured.repeatedFailedRevision,mergePreflightFailures:measured.mergePreflightFailures,
  boundaryFailures:measured.boundaryFailures,reviewFailures:measured.reviewFailures,acceptedRepairs:measured.acceptedRepairs,
  completedRounds:m.reviews.length,invalidatedRounds,findingOccurrences,
  latestActionable:latest&&!latest.invalidated?latest.findings.filter(f=>!f.rejection).length:0,
  latestRejected:latest&&!latest.invalidated?latest.findings.filter(f=>!!f.rejection).length:0,
  severity,workerAttempts:m.workers.length,workerBeads:new Set(m.workers.map(w=>w.beadId)).size,
  repairRound:m.round,repairLinks,config:input.measurementConfig,
 }:null;
	return {
		schema: 1,
		id: m.id,
		ticket: displaySourceId(m.source),
		title: m.source.title,
		worktree,
		base: m.workspace.base ?? null,
		phase,
		progress: { step: phases.indexOf(phase), of: phases.length },
		hold,
		gate: m.gate ? { kind: m.gate.kind, id: gateTokenId(m.gate.token) } : null,
		next,
		actions,
		workers: m.workers.length ? { live: m.workers.filter(w => w.state !== 'closed').length, total: m.workers.length } : null,
		delivery: url || branch ? { url, branch } : null,
		complete: phase === 'complete',
		plan: input.pending && input.planPath ? await readFile(input.planPath, 'utf8').then(text => ({ path: input.planPath!, revision: planRevision(text) })).catch(() => null) : null,
		revision: m.updatedAt,
		mode: m.mode ?? null,
		verify: m.evidence.verify?.outcome ?? null,
		problem: missionProblem(m, graphDown ? input.snapshot?.error : undefined),
  review:input.review??null,
  model:input.model??null,
		check: m.check ?? null,
		session: input.session ? { ...input.session, pid: process.pid, processStart: processStartTicks(process.pid), terminal: process.env.ORCA_TERMINAL_HANDLE ?? null } : undefined,
		ctl: input.ctl,
		usage: input.usage,
  measurements,
  usageEvidence:input.usageEvidence??null,
		updatedAt: new Date().toISOString(),
	};
}

// Per-call-site environment overrides for board-launched missions. Invalid values throw instead of silently half-applying.
export function envGraph(env: NodeJS.ProcessEnv = process.env): 'local' | 'beads' | undefined {
	const value = env.OMP_MISSION_GRAPH;
	if (value === undefined || value === '') return undefined;
	if (value !== 'local' && value !== 'beads') throw new Error(`Invalid OMP_MISSION_GRAPH: ${value} (local|beads)`);
	return value;
}
export function envDelivery(env: NodeJS.ProcessEnv = process.env): 'pr' | 'local' | undefined {
	const value = env.OMP_MISSION_DELIVERY;
	if (value === undefined || value === '') return undefined;
	if (value !== 'pr' && value !== 'local') throw new Error(`Invalid OMP_MISSION_DELIVERY: ${value} (pr|local)`);
	return value;
}
export function envBase(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.OMP_MISSION_BASE?.trim() || undefined;
}
export function envCheckout(env: NodeJS.ProcessEnv = process.env): string | undefined {
	return env.OMP_MISSION_CHECKOUT?.trim() || undefined;
}
// argv messages never fire the input hook, so the board's message arrives here: OMP_MISSION_AUTOSTART plus
// a plan.defaultOnStartup config overlay put the session in plan mode before the command runs.
export function autostartMessage(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const value = env.OMP_MISSION_AUTOSTART?.trim();
	if (!value) return undefined;
	return value.startsWith('/mission') ? value.slice('/mission'.length).trim() : value;
}

export interface HolotableHooks {
	context(): ExtensionContext | undefined;
	source(): { mission: Mission | undefined; pending: Mission | undefined };
	resumeHold(): boolean;
	snapshot(): Snapshot | undefined;
	policy(): PolicyContext;
	step(): Step | undefined;
	owned(): boolean;
	selected(): string | undefined;
	operation(): boolean;
 measurementConfig?():MeasurementConfig;
 review?():ReviewStatus|null;
	question(): string | undefined;
	gateId(): string | undefined;
	decide(context: ExtensionContext, verb: string, arg?: string): Promise<void>;
	request(context: ExtensionContext, op: string, extra?: Record<string, unknown>): Promise<void>;
	clear(context: ExtensionContext): Promise<void>;
	planPath(): string | undefined;
	touchPending(): void;
	sendUserMessage(message: string): void;
	// The open interactive plan review, when OMP exposes the review API (ctx.resolvePlanReview) and a review awaits an answer.
	planReview(): { reviewId: string; canApprove: boolean; resolve(choice: PlanReviewChoice, input?: { feedback?: string }): boolean } | undefined;
	onNotify(message: string): void;
	/** Publish identity: id distinguishes panes of one mission; owned is false for read-only inspections. */
	sessionInfo?(): { id: string; owned: boolean } | undefined;
}

interface Reply {
	v: 1;
	ok: boolean;
	revision?: string;
	plan?: { text: string; path: string; revision: string };
	error?: { code: string; message: string };
}

function fail(code: string, message: string): Reply {
	return { v: 1, ok: false, error: { code, message } };
}

export class HolotableBridge {
	private server: Server | undefined;
	private socketPath: string | undefined;
	private generation = 0;
	private socketId: string | undefined;
	private inflight = new Set<Socket>();
	private last = '';
	private lastPath = '';
	private failed = false;
	private writing: Promise<void> = Promise.resolve();
	private readonly usage: UsageProbe;
 private completedKey='';

	constructor(private readonly agentDir: string, private readonly hooks: HolotableHooks) {
		this.usage = new UsageProbe(agentDir);
	}

	ctlFor(missionId: string): { socket: string; generation: number } | null {
		return this.socketId === missionId && this.server && this.socketPath ? { socket: this.socketPath, generation: this.generation } : null;
	}

	// Fire-and-forget status publication; serialized so concurrent renders cannot interleave the tmp file.
 publish(forceUsage=false):Promise<void> {
  this.writing=this.writing.then(()=>this.write(forceUsage)).catch(()=>undefined);
		return this.writing;
	}

 private async write(forceUsage:boolean):Promise<void> {
		const { mission, pending } = this.hooks.source();
		const current = mission ?? pending;
		if (!current) return;
		// getEntries() (not getBranch()): every assistant message in the coordinator session counts toward spend.
		// Lazy so a publish inside the probe's throttle window does not pay for the copy.
  const coordinator=()=>{try{const context=this.hooks.context();if(!context)return undefined;const manager=context.sessionManager;return {sessionFile:typeof manager.getSessionFile==='function'?manager.getSessionFile()??null:null,entries:manager.getEntries()};}catch{return undefined;}};
  const key=`${current.workspace.key} ${current.id}`;
  const complete=current.phase==='complete';
  const measured=await this.usage.measure(current,coordinator,forceUsage||(complete&&this.completedKey!==key));
  this.completedKey=complete?key:'';
		const status = await buildContactStatus({
			mission: current,
			pending: !mission && !!pending,
			resumeHold: this.hooks.resumeHold(),
			snapshot: this.hooks.snapshot(),
			policy: this.hooks.policy(),
			step: this.hooks.step(),
			owned: this.hooks.owned(),
			selected: this.hooks.selected(),
			operation: this.hooks.operation(),
			session: this.hooks.sessionInfo?.(),
			ctl: this.ctlFor(current.id),
   usage:measured.usage,
   usageEvidence:measured.evidence,
   measurementConfig:this.hooks.measurementConfig?.(),
   review:this.hooks.review?.(),
   model:(()=>{const model=this.hooks.context()?.model;return model?`${model.provider}/${model.id}`:null;})(),
			planPath: this.hooks.planPath(),
			planReview: this.hooks.planReview()?.canApprove === true,
			question: this.hooks.question(),
		});
		const serialized = `${JSON.stringify(status, null, 2)}\n`;
		const file = statusFilePath(this.agentDir, current);
		if (file === this.lastPath && serialized === this.last) return;
		// A read-only inspection pane never overwrites a live owner's fresh file; the board
		// would flap between controlled and uncontrolled snapshots on every render.
		if (status.session && status.session.owned === false) {
			try {
				const meta = await stat(file);
				const existing = JSON.parse(await readFile(file, 'utf8'));
				const prior = isRecord(existing) && isRecord(existing.session) ? existing.session : null;
				if (prior && prior.owned === true && prior.id !== status.session.id && Date.now() - meta.mtimeMs < 45_000) return;
			} catch { /* absent or unreadable: this pane is the only reporter */ }
		}
		try {
			await mkdir(join(file, '..'), { recursive: true, mode: 0o700 });
			const temporary = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
			try {
				await writeFile(temporary, serialized, { mode: 0o600 });
				await rename(temporary, file);
			} catch (error) {
				await rm(temporary, { force: true }).catch(() => undefined);
				throw error;
			}
			this.last = serialized;
			this.lastPath = file;
			this.failed = false;
		} catch (error) {
			if (!this.failed) {
				this.failed = true;
				this.hooks.onNotify(`Holotable status write failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}
	}

	// A discarded pending plan leaves no status file: the run never existed. Saved missions keep their final snapshot.
	async discard(mission: Pick<Mission, 'id' | 'workspace'>): Promise<void> {
		const file = statusFilePath(this.agentDir, mission);
		if (file === this.lastPath) { this.last = ''; this.lastPath = ''; }
		await rm(file, { force: true });
	}

	// Board children always serve (OMP_HOLOTABLE_CHILD=1); the .ctl marker left by that first
	// open lets a manually resumed pane serve again. Only the ownership holder serves: an
	// inspection pane must not present control authority it cannot honor.
	async open(mission: Pick<Mission, 'id' | 'workspace'>): Promise<void> {
		if (this.socketId === mission.id && this.server) return;
		const marker = join(statusFilePath(this.agentDir, mission), '..', `${mission.id}.ctl`);
		const eligible = process.env.OMP_HOLOTABLE_CHILD === '1'
			|| await lstat(marker).then(stat => stat.isFile()).catch(() => false);
		const owned = mission.id === this.hooks.source().pending?.id || this.hooks.owned();
		if (!eligible || !owned) return;
		await this.close();
		const dir = join(tmpdir(), `omp-mission-ctl-${process.getuid?.() ?? 0}`);
		// Per-process names: a second pane of the same mission never unlinks a live peer's socket.
		const path = join(dir, `${createHash('sha256').update(mission.id).digest('hex').slice(0, 12)}-${process.pid}.sock`);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const stat = await lstat(dir);
		if (!stat.isDirectory() || stat.uid !== process.getuid!()) throw new Error(`Refusing control socket dir ${dir}: not owned by uid ${process.getuid!()}`);
		await chmod(dir, 0o700);
		// Drop sibling sockets whose pid exited so the directory does not grow forever.
		for (const entry of await readdir(dir).catch(() => [] as string[])) {
			const pid = Number(/-(\d+)\.sock$/.exec(entry)?.[1]);
			if (Number.isInteger(pid) && pid !== process.pid && !processStartTicks(pid)) await rm(join(dir, entry), { force: true }).catch(() => undefined);
		}
		await rm(path, { force: true });
		this.generation = Date.now();
		this.socketPath = path;
		const server = createServer({ allowHalfOpen: true }, socket => this.serve(socket));
		server.on('error', error => this.hooks.onNotify(`Holotable control socket error: ${error.message}`));
		await new Promise<void>((resolve, reject) => {
			server.once('error', reject);
			server.listen(path, () => {
				server.removeListener('error', reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
		this.server = server;
		this.socketId = mission.id;
		await mkdir(join(marker, '..'), { recursive: true, mode: 0o700 });
		await writeFile(marker, `${process.pid}\n`, { mode: 0o600 }).catch(() => undefined);
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = undefined;
		this.socketId = undefined;
		if (!server) return;
		server.close();
		const path = this.socketPath;
		this.socketPath = undefined;
		if (path) await rm(path, { force: true }).catch(() => undefined);
	}

	private serve(socket: Socket): void {
		this.inflight.add(socket);
		let buffer = '';
		const reply = (line: string) => {
			void this.handle(line).then(r => {
				socket.end(`${JSON.stringify(r)}\n`);
			}, () => {
				socket.end(`${JSON.stringify(fail('bad-request', 'The request could not be handled'))}\n`);
			});
		};
		socket.on('data', chunk => {
			buffer += chunk.toString('utf8');
			const newline = buffer.indexOf('\n');
			if (newline < 0) {
				if (buffer.length > MAX_LINE) socket.destroy();
				return;
			}
			const line = buffer.slice(0, newline);
			buffer = '';
			reply(line);
		});
		// A client that half-closes without a trailing newline still gets a reply.
		socket.on('end', () => { if (buffer.length > 0 && buffer.length <= MAX_LINE) reply(buffer); buffer = ''; });
		socket.on('error', () => undefined);
		socket.on('close', () => this.inflight.delete(socket));
	}

	private async handle(line: string): Promise<Reply> {
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			return fail('bad-request', 'Request is not valid JSON');
		}
		if (!isRecord(request) || request.v !== 1 || typeof request.op !== 'string' || !SOCKET_OPS[request.op] || (request.args !== undefined && !isRecord(request.args))) {
			return fail('bad-request', 'Expected {"v":1,"op":"<op>","args":{...}}');
		}
		const { mission, pending } = this.hooks.source();
		const revision = (mission ?? pending)?.updatedAt;
		if (request.op === 'ping') return { v: 1, ok: true, ...(revision ? { revision } : {}) };
		if (request.op === 'plan') {
			const path = pending && !mission ? this.hooks.planPath() : undefined;
			const text = path ? await readFile(path, 'utf8').catch(() => undefined) : undefined;
			if (text === undefined || path === undefined) return fail('no-plan', 'No pending plan file');
			return { v: 1, ok: true, revision: revision ?? '', plan: { text, path, revision: planRevision(text) } };
		}
		if (request.operator !== true) return fail('bad-request', 'Operator operations require "operator":true');
		const context = this.hooks.context();
		if (!context) return fail('no-session', 'No main-session context is attached');
		if (this.hooks.question()) return fail('question-waiting', 'Answer the pending question in the mission pane before controlling the mission');
		const args = (request.args ?? {}) as Record<string, unknown>;
		const op = request.op;
		try {
			if (op === 'approve') {
				const gate = args.gate;
				if (gate !== undefined && gate !== this.hooks.gateId()) return fail('stale', 'The gate id no longer matches; read the status file again');
				await this.hooks.decide(context, 'approve', undefined);
			} else if (op === 'mode' || op === 'review') {
				await this.hooks.decide(context, op, typeof args.mode === 'string' ? args.mode : undefined);
			} else if (op === 'clear') {
				await this.hooks.clear(context);
			} else if (op === 'plan-edit') {
        if (op === 'review' && args.repairBudgetOnly === true && (!mission || mission.mode === 'pause' || missionProblem(mission)?.source !== 'repair-budget'))
          return fail('rejected', 'No confirmed repair-budget hold to authorize');
				if (mission || !pending) return fail('rejected', 'No pending plan is awaiting approval');
				if (typeof args.text !== 'string') return fail('bad-request', 'plan-edit requires args.text');
				if (Buffer.byteLength(args.text, 'utf8') > MAX_PLAN) return fail('bad-request', 'Plan text exceeds 256 KiB');
				if (args.base !== undefined && typeof args.base !== 'string') return fail('bad-request', 'args.base must be a string');
				const editPath = this.hooks.planPath();
				const current = editPath ? await readFile(editPath, 'utf8').catch(() => undefined) : undefined;
				if (editPath === undefined || current === undefined) return fail('no-plan', 'No pending plan file');
				if (args.base !== undefined && args.base !== planRevision(current)) return fail('stale', 'The plan changed since this revision; read it again');
				const mode = (await lstat(editPath)).mode & 0o777;
				const temporary = `${editPath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
				try {
					await writeFile(temporary, args.text, { mode });
					await rename(temporary, editPath);
				} catch (error) {
					await rm(temporary, { force: true }).catch(() => undefined);
					throw error;
				}
				this.hooks.touchPending();
				await this.publish();
				return { v: 1, ok: true, revision: this.hooks.source().pending?.updatedAt ?? '', plan: { text: args.text, path: editPath, revision: planRevision(args.text) } };
			} else if (op === 'plan-approve') {
				if (mission || !pending) return fail('rejected', 'No pending plan is awaiting approval');
				if (args.revision !== undefined && typeof args.revision !== 'string') return fail('bad-request', 'args.revision must be a string');
				const review = this.hooks.planReview();
				if (!review?.canApprove) return fail('rejected', 'No plan review with compact approval is available');
				if (args.revision !== undefined) {
					const planPath = this.hooks.planPath();
					const current = planPath ? await readFile(planPath, 'utf8').catch(() => undefined) : undefined;
					if (planPath === undefined || current === undefined) return fail('no-plan', 'No pending plan file');
					if (args.revision !== planRevision(current)) return fail('stale', 'The plan changed since this revision; read it again');
				}
				// 'compact' approves and keeps the session, so the mission:pending entry survives and the mission starts on the
				// before_agent_start 'Plan approved.' path. 'execute' would clear the session and lose the pending mission — never use it here.
				if (!review.resolve('compact')) return fail('rejected', 'The plan review closed before it could be resolved');
				return { v: 1, ok: true, revision: this.hooks.source().pending?.updatedAt ?? '' };
			} else if (op === 'plan-refine') {
				if (mission || !pending) return fail('rejected', 'No pending plan is awaiting approval');
				if (typeof args.message !== 'string' || args.message.length < 1 || args.message.length > 8000) return fail('bad-request', 'plan-refine requires args.message of 1..8000 characters');
				const review = this.hooks.planReview();
				if (review) {
					if (!review.resolve('refine', { feedback: args.message })) return fail('rejected', 'The plan review closed before it could be refined');
				} else this.hooks.sendUserMessage(args.message);
			} else {
				const extra: Record<string, unknown> = {};
				if (op === 'retry-model') {
					if (typeof args.model !== 'string' || !args.model.trim() || args.model.length > 1000) return fail('bad-request', 'retry-model requires a concrete args.model');
					extra.model = args.model;
				}
				if (typeof args.beadId === 'string') extra.beadId = args.beadId;
				if (typeof args.detail === 'string') extra.detail = args.detail;
				if (Array.isArray(args.files) && args.files.every(file => typeof file === 'string')) extra.files = args.files;
				await this.hooks.request(context, op, extra);
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(message === 'Mission operation already running' ? 'busy' : 'rejected', message);
		}
		return { v: 1, ok: true, revision: this.hooks.source().mission?.updatedAt ?? '' };
	}
}
