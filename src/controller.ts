import { createHash } from 'node:crypto';
import type { Action, Gate, Graph, Mission, Mode, Phase, PolicyContext, Snapshot, Step } from './types';
export function token(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
const quotaHold = /quota.{0,80}exhausted|insufficient.{0,40}(?:credits|balance|funds)|usage[_ -]?limit|usage_limit_reached|run out of credits|out of credits|out of (?:extra )?usage|spending[- ]?limit|personal-team-blocked|requires more credits|more credits, or fewer max_tokens/i;
/** Transient throttle wording. OMP already retries these; the mission must not start another loop. */
export const rateLimitHold = /\brate[_ -]?limit(?:_error)?\b|too many requests|\b429\b/i;
export function providerCapacity(detail: string): 'quota' | 'rate' | undefined {
 if (quotaHold.test(detail)) return 'quota';
 if (rateLimitHold.test(detail)) return 'rate';
 if (/resource[_ -]?exhausted/i.test(detail)) return 'quota';
 return undefined;
}
/** Persisted coordinator park. `/mission continue` clears it; it is not a completed mission. */
export const QUOTA_BLOCKER = 'Provider quota exhausted. Restore quota or change the model, then /mission continue';
export function quotaBlocked(m: Pick<Mission, 'blocker' | 'workers' | 'evidence'>): boolean {
 if (m.blocker && providerCapacity(m.blocker) === 'quota') return true;
 if (m.evidence.review?.outcome === 'failed' && providerCapacity(m.evidence.review.detail) === 'quota') return true;
 return m.workers.some(worker => worker.state !== 'closed' && !!worker.error && providerCapacity(worker.error) === 'quota');
}
/** Last assistant error of a finished turn. A clean stop is not a hold, so an OMP fallback success is left alone. */
export function terminalCapacity(messages: readonly unknown[]): 'quota' | 'rate' | undefined {
 for (let i = messages.length - 1; i >= 0; i--) {
  const message = messages[i];
  if (!message || typeof message !== 'object') continue;
  const row = message as { role?: string; stopReason?: string; errorMessage?: string };
  if (row.role !== 'assistant') continue;
  if (row.stopReason !== 'error') return undefined;
  return providerCapacity(row.errorMessage ?? '');
 }
 return undefined;
}
export function reviewFailureStep(detail:string,completed=0,total=0):Step{
 const progress=total?` (${completed}/${total} reviewers complete)`:'';
 if(providerCapacity(detail)==='quota')return {text:`Review blocked by provider quota${progress}. Restore quota or configure a funded review model, then /mission review`};
 if(/deadline exceeded|timed out|timeout/i.test(detail))return {command:'/mission review',text:`Review timed out${progress}.${completed?' Retry only failed reviewers; completed results are retained':' Retry the failed review'}`};
 return {command:'/mission review',text:`Review failed${progress}.${completed?' Retry only failed reviewers; completed results are retained':' Retry it'}`};
}
/** Review failures a later run clears by itself: throttles, provider overload, dropped connections, a reviewer deadline. Quota needs a person. */
const transientReview = /deadline exceeded|timed out|timeout|overloaded|rate_limit_error|\b(?:502|503|504|529)\b|internal server error|econnreset|socket hang up|fetch failed|network error/i;
export const REVIEW_RETRIES = 3;
const REVIEW_BACKOFF_MS = [2 * 60_000, 10 * 60_000, 30 * 60_000];
/**
 * When a failed review reruns without the operator, or undefined when it waits for `/mission review`.
 * Honors the provider's retry-after, and spreads missions that failed together by up to
 * a minute; a multi-hour provider reset must not gain another hour of jitter.
 */
export function reviewRetryAt(m: Pick<Mission, 'id' | 'evidence'>): number | undefined {
 const review = m.evidence.review;
 if (review?.outcome !== 'failed' || providerCapacity(review.detail) === 'quota') return undefined;
 if (providerCapacity(review.detail) !== 'rate' && !transientReview.test(review.detail)) return undefined;
 const attempts = review.attempts ?? 1;
 if (attempts > REVIEW_RETRIES) return undefined;
 const failedAt = Date.parse(review.at);
 const hints = [...review.detail.matchAll(/retry-after-ms=(\d+)/g)].map(match => Number(match[1])).filter(Number.isFinite);
 for (const match of review.detail.matchAll(/\breset(?:s|ting)?\s+in\s+(\d+)\s+(seconds?|minutes?|hours?)\b/gi))
  hints.push(Number(match[1]) * (/hour/i.test(match[2]!) ? 3_600_000 : /minute/i.test(match[2]!) ? 60_000 : 1000));
 for (const match of review.detail.matchAll(/\bat\s+(\d{1,2}):(\d{2})\s+UTC\b/gi)) {
  const hour = Number(match[1]), minute = Number(match[2]);
  if (hour > 23 || minute > 59) continue;
  const reset = new Date(failedAt);
  reset.setUTCHours(hour, minute, 0, 0);
  if (reset.getTime() < failedAt) reset.setUTCDate(reset.getUTCDate() + 1);
  hints.push(reset.getTime() - failedAt);
 }
 const wait = Math.max(REVIEW_BACKOFF_MS[attempts - 1]!, ...hints);
 const spread = Math.floor(parseInt(token(m.id).slice(0, 4), 16) / 0xffff * Math.min(wait / 4, 60_000));
 const retryAt = failedAt + wait + spread;
 return Number.isFinite(new Date(retryAt).getTime()) ? retryAt : undefined;
}
export function displayPhase(m: Mission, snapshot?: Snapshot): Phase {
 if (['complete','plan','isolate','graph'].includes(m.phase)) return m.phase;
 if (m.workers.some(worker=>worker.state!=='closed') || snapshot?.leaves.some(bead=>bead.category!=='closed')) return m.phase;
 if (m.evidence.verify?.outcome === 'passed') return m.evidence.deliver?.outcome === 'passed' ? (m.phase === 'repair' ? 'repair' : 'review') : 'deliver';
 if (m.epicId && snapshot?.leaves.length && !snapshot.error && (m.phase === 'execute' || m.phase === 'repair')) return 'verify';
 return m.phase;
}
export function waveGate(m: Mission, ids: string[], snapshot: Snapshot): Gate {
  return {kind:'wave',token:token([m.id,m.round,ids.map(id=>[id,m.scopes[id],snapshot.beads.find(b=>b.id===id)?.status,snapshot.ready.includes(id)])]),detail:`Start workers: ${ids.join(', ')}`,approved:false};
}
export function revisionGate(m: Mission, kind: 'review' | 'repairs', revision: string): Gate {
 return {kind,token:token([m.id,m.round,kind,revision,kind==='repairs'?m.reviews.at(-1)?.findings:[]]),detail:kind==='review'?`Review revision ${revision}`:`Repair findings: ${m.reviews.at(-1)?.findings.filter(f=>!f.rejection).map(f=>f.id).join(', ')}`,approved:false};
}
export function setMode(m: Mission, mode: Mode): void { m.mode=mode; if(mode==='force')m.reviewRequested=true; if(mode!=='pause')delete m.gate; }
/** Beads Auto/Force keep moving: the failure detail becomes the repair step. Pause and the local graph wait for the operator. */
export function verificationParked(m: Mission): boolean {
 return m.evidence.verify?.outcome==='failed' && (m.mode==='pause' || effectiveGraph(m)==='local');
}
export function approveGate(m: Mission, expected: string): void { if(!m.gate || m.gate.token!==expected)throw new Error('Approval scope changed; inspect the current gate'); m.gate.approved=true; }
export function enforceMutation(m: Mission, p: PolicyContext): void {
 if(p.nativePlan)throw new Error('Mission mutations are forbidden in native plan mode');
 if(p.resumeHold)throw new Error('Resumed inspection: use /mission continue');
 if(!p.owned)throw new Error('Controller ownership required');
 if(m.blocker)throw new Error(m.blocker);
 if(verificationParked(m))throw new Error('Verification failed; /mission continue releases the hold');
}
// Checks an approved gate without spending it. The caller spends it with consumeGate
// once the mutation has succeeded, so a failed dispatch or review keeps its approval.
export function enforceGate(m: Mission, gate: Gate): void {
 if(m.mode!=='pause')return;
 if(m.gate?.token!==gate.token || !m.gate.approved){m.gate=gate;throw new Error(`Approval required: ${gate.detail}`);}
}
export function consumeGate(m: Mission): void { delete m.gate; }
export function effectiveGraph(m: Pick<Mission, 'graph' | 'epicId'>): Graph {
 if (m.graph === 'local' || m.graph === 'beads') return m.graph;
 return 'beads';
}
export function requireBeadsGraph(m: Mission): void {
 if (effectiveGraph(m) === 'local') throw new Error('Local graph has no bead epic or wave; implement in this pane');
}
export const CLAIM_STALL_MS = 3 * 60_000;
// Dispatch needs no judgment once the wave is ready and unpaused, so with the opt-in
// flag the extension runs it directly. Pause keeps its explicit gate, and a hold of any
// kind (resume, plan mode, lost ownership) keeps the model and operator in charge.
export function autoDispatchAllowed(m: Mission, action: Action, enabled: boolean, p: PolicyContext): boolean {
 return enabled && action.kind === 'dispatch' && !action.gate && m.mode !== 'pause' && p.owned && !p.resumeHold && !p.nativePlan && !m.blocker;
}
export function nextAction(m: Mission, snapshot: Snapshot | undefined, policy: PolicyContext): Action {
 if (m.phase === 'complete') return {kind: 'hold', detail: 'Complete; inspection only'};
 if (policy.nativePlan) return {kind: 'hold', detail: 'Native plan mode'};
 if (policy.resumeHold) return {kind: 'hold', detail: 'Resumed inspection; continue explicitly'};
 if (!policy.owned) return {kind: 'hold', detail: 'Controller ownership required'};
 if (m.blocker) return {kind: 'hold', detail: m.blocker};
 if(verificationParked(m))return {kind:'hold',detail:`Verification failed; stop. /mission continue releases the hold. Then bind an unbound repair leaf, or create one, and dispatch it. Do not record verification until that leaf closes: ${m.evidence.verify!.detail}`};

 const local = effectiveGraph(m) === 'local';
 if (local) {
  if (m.workers.length) return {kind: 'hold', detail: 'Local graph cannot own bead workers'};
 } else {
  if (!m.epicId) return m.phase === 'isolate' ? {kind: 'isolate', detail: 'Bind the ticket checkout and bead database'} : {kind: 'graph', detail: 'Create the epic and scoped leaves, then bind them'};
  if (!snapshot || !policy.fresh || snapshot.error) return {kind: 'hold', detail: snapshot?.error ?? 'Fresh graph required'};
  if (!snapshot.leaves.length) return {kind: 'hold', detail: 'Graph has no implementation leaves'};
  const workers = m.workers.filter(worker => worker.state !== 'closed');
  const stalled = workers.filter(worker => worker.state === 'awaiting-claim' && !worker.error && worker.launchedAt && Date.now() - Date.parse(worker.launchedAt) > CLAIM_STALL_MS && snapshot.leaves.some(bead => bead.id === worker.beadId && bead.category === 'ready'));
  if (stalled.length) return {kind: 'resend', detail: `No claim ${Math.round(CLAIM_STALL_MS / 60000)}+ min after launch: ${stalled.map(worker => worker.beadId).join(', ')}. Inspect the tab, then resend once`, ids: stalled.map(worker => worker.beadId).sort()};
  const stopped = workers.filter(worker => worker.frontend === 'subagent' && worker.error && worker.state !== 'missing');
  const capped = stopped.filter(worker => providerCapacity(worker.error ?? ''));
  if (capped.length) {
   const quota = capped.filter(worker => providerCapacity(worker.error ?? '') === 'quota');
   const shown = (quota.length ? quota : capped).map(worker => `${worker.beadId} (${worker.error!.slice(0, 180)})`).join('; ');
   return {kind: 'hold', detail: quota.length
    ? `Worker blocked by provider quota: ${shown}. Restore quota or change the worker model, then /mission resend`
    : `Worker rate-limited after the provider retry: ${shown}. /mission resend when it clears`};
  }
  if (workers.some(worker => worker.state === 'missing' || (worker.error && worker.frontend !== 'subagent'))) return {kind: 'hold', detail: 'Worker identity or claim requires recovery'};
  const outstanding = snapshot.leaves.filter(bead => bead.category !== 'closed');
  if (outstanding.length) {
   const reserved = new Set(workers.map(worker => worker.beadId));
   const capacity = Math.max(0, policy.maxWorkers - workers.length);
   const ids = snapshot.ready.filter(id => m.scopes[id] && !reserved.has(id)).sort().slice(0, capacity);
   // A stopped subagent worker waits for the operator but does not hold back other ready beads; it surfaces once nothing else can start.
   if (stopped.length && (m.mode === 'pause' || !ids.length)) return {kind: 'resend', detail: `Worker stopped: ${stopped.map(worker => `${worker.beadId} (${worker.error!.slice(0, 240)})`).join('; ')}`, ids: stopped.map(worker => worker.beadId).sort()};
   if (m.mode === 'pause' && workers.length) return {kind: 'hold', detail: 'Current wave still running'};
   if (ids.length) {
    const gate = waveGate(m, ids, snapshot);
    if (m.mode === 'pause' && (m.gate?.token !== gate.token || !m.gate.approved)) return {kind: 'hold', detail: gate.detail, gate};
    return {kind: 'dispatch', detail: gate.detail, ids};
   }
   const unbound = outstanding.filter(bead => !m.scopes[bead.id]).map(bead => bead.id).sort();
   if (unbound.length) return {kind: 'graph', detail: `Bind scopes for unbound leaves: ${unbound.join(', ')}`, ids: unbound};
   const running = workers.length || outstanding.some(bead => bead.category === 'active');
   return {kind: 'hold', detail: running ? 'Workers running' : 'No eligible leaves; inspect dependencies and scopes'};
  }
 }

 if (!local && m.evidence.verify?.detail && (m.evidence.verify.outcome === 'pending' || m.evidence.verify.outcome === 'failed')) {
  const blocker = m.evidence.verify.detail.length > 240 ? `${m.evidence.verify.detail.slice(0, 240)}…` : m.evidence.verify.detail;
  return {kind: 'graph', detail: `Verification hold released. Create and bind a scoped repair leaf for this blocker, then dispatch. Do not record verification until it closes: ${blocker}`};
 }
 if (m.evidence.verify?.outcome !== 'passed') {
  return {kind: 'verify', detail: local ? 'Implement in this pane. Subagents are visibility only. Record verification when done' : 'Run task smoke verification and record revision evidence'};
 }
 if (m.evidence.deliver?.outcome !== 'passed') return {kind: 'deliver', detail: 'Prepare local result or existing/new PR and record evidence'};
 if (!m.reviewRequested) return {kind: 'hold', detail: 'PR/local result ready. Review not requested'};
 const revision = m.evidence.verify.revision;
 if (!revision) return {kind: 'hold', detail: 'Verification fingerprint missing'};
 const reviewEvidence = m.evidence.review;
 if (reviewEvidence?.outcome === 'failed' && reviewEvidence.revision === revision) {
  const retryAt = reviewRetryAt(m);
  if (retryAt === undefined) return {kind: 'hold', detail: `Review failed; /mission review explicitly retries: ${reviewEvidence.detail}`};
  if (Date.now() < retryAt) return {kind: 'hold', detail: `Review retries automatically at ${new Date(retryAt).toISOString().slice(11, 16)} UTC (attempt ${(reviewEvidence.attempts ?? 1) + 1} of ${REVIEW_RETRIES + 1}) after: ${reviewEvidence.detail.slice(0, 200)}`};
 }
 const review = m.reviews.at(-1);
 if (review && !review.invalidated && review.revision === revision) {
  if (!review.findings.some(finding => !finding.rejection)) return {kind: 'complete', detail: 'Verified current revision independently reviewed clean'};
  const gate = revisionGate(m, 'repairs', revision);
  if (m.mode === 'pause' && (m.gate?.token !== gate.token || !m.gate.approved)) return {kind: 'hold', detail: gate.detail, gate};
  return {kind: 'repairs', detail: local ? 'Repair findings in this pane, then rereview' : 'Create scoped repair beads linked to actionable findings'};
 }
 const gate = revisionGate(m, 'review', revision);
 if (m.mode === 'pause' && (m.gate?.token !== gate.token || !m.gate.approved)) return {kind: 'hold', detail: gate.detail, gate};
 return {kind: 'review', detail: 'Run independent revision-bound review'};
}
/**
 * Every /mission verb valid right now: always-on controls, contextual commands, then
 * commands bound to the selected bead as full strings (`focus bd-1`). Mutating verbs
 * mirror the guards their control operation enforces, so the menu never offers a
 * command that can only fail on ownership, holds, plan mode, or a stale snapshot.
 */
export function operatorCommands(m: Mission | undefined, pending: boolean, snapshot: Snapshot | undefined, p: PolicyContext, selected?: string, operation = false): string[] {
 const commands = ['show', 'config', 'history'];
 if (pending || m?.phase === 'complete') {
  if (!operation) commands.push('clear');
 }
 if (m && effectiveGraph(m) === 'beads' && selected && snapshot?.beads.some(bead => bead.id === selected)) commands.push(`history ${selected}`);
 const worker = m && selected ? m.workers.findLast(item => item.beadId === selected) : undefined;
 // Focus only inspects a terminal, so holds and native plan mode still allow it; a closed
 // worker or a frontend without a tab would surface a guaranteed failure instead.
 if (worker?.handle && worker.state !== 'closed' && ['orca', 'herdr'].includes(worker.frontend ?? 'orca')) commands.push(`focus ${worker.beadId}`);
 if (!m || m.phase === 'complete' || p.nativePlan || operation) return commands;
 if (p.resumeHold || !p.owned || m.evidence.verify?.outcome==='failed' || m.blocker?.startsWith(QUOTA_BLOCKER)) commands.push('continue');
 commands.push('mode');
 // A scheduled automatic retry is the extension's step, so the operator is not asked for it.
 if (m.evidence.deliver?.outcome === 'passed' && m.evidence.verify?.outcome !== 'failed' && !m.blocker &&
  (!quotaBlocked(m) || m.evidence.review?.outcome === 'failed') && reviewRetryAt(m) === undefined) commands.push('review');
 if (m.gate && !m.gate.approved && p.owned && !p.resumeHold && m.evidence.verify?.outcome !== 'failed') commands.push('approve');
 const action = nextAction(m, snapshot, p);
 if (action.kind === 'dispatch') commands.push('dispatch');
 // Worker mutations mirror enforceMutation plus a fresh graph read: each op re-checks
 // the bead, so an errored or stale snapshot would surface only a guaranteed failure.
 const mutable = p.owned && !p.resumeHold && !m.blocker && m.evidence.verify?.outcome !== 'failed' && !!snapshot && !snapshot.error && p.fresh;
 if (mutable && action.kind === 'resend') for (const id of action.ids ?? []) if (!commands.includes(`resend ${id}`)) commands.push(`resend ${id}`);
 if (mutable && worker) {
  if (worker.frontend === 'subagent' ? worker.state !== 'closed' && !!worker.error && providerCapacity(worker.error) !== 'quota' : worker.state === 'awaiting-claim' && !!worker.handle) if (!commands.includes(`resend ${worker.beadId}`)) commands.push(`resend ${worker.beadId}`);
  if (worker.frontend === 'subagent' && worker.state !== 'closed') commands.push(`release ${worker.beadId}`);
  if (!m.keep && worker.handle && snapshot?.leaves.some(bead => bead.id === worker.beadId && bead.category === 'closed')) commands.push(`reap ${worker.beadId}`);
 }
 return commands;
}
/**
 * The one thing the operator can do now. Holds that wait on a person get a command; states the
 * coordinator drives get a status line only, so a command is never offered that would do nothing.
 */
export function operatorStep(m: Mission, action: Action, p: PolicyContext, ownershipError?: string): Step {
 if (m.phase === 'complete') return {command: '/mission show', text: 'Complete. Inspect the result; /mission clear starts a fresh mission'};
 if (p.nativePlan) return {text: m.phase === 'plan' ? 'Approve the plan to start the mission' : 'Plan mode is read-only; leave plan mode to continue'};
 if (ownershipError) return {command: '/mission continue', text: `Lost control of the mission (${ownershipError}); take it back`};
 if (p.resumeHold) return {command: '/mission continue', text: 'Take control of this resumed mission'};
 if (action.gate) return {command: '/mission approve', text: action.gate.detail};
 if (m.blocker) return {command: m.blocker.startsWith(QUOTA_BLOCKER) ? '/mission continue' : '/mission', text: m.blocker};
 if(verificationParked(m))return {command:'/mission continue',text:`Verification blocked: ${m.evidence.verify!.detail}. Continue releases the hold so the fix can be bound and dispatched; it does not mark the blocker fixed`};
 if (action.kind === 'resend' && action.ids?.length) return {command: `/mission resend ${action.ids[0]}`, text: action.detail};
 if (action.kind === 'hold') {
  const delivered = m.evidence.deliver?.outcome === 'passed';
  if (delivered && !m.reviewRequested) return {command: '/mission review', text: 'Result is ready. Request an independent review, or stop here'};
  if (delivered && m.evidence.review?.outcome === 'failed') {
   if (reviewRetryAt(m) !== undefined) return {text: action.detail};
   return reviewFailureStep(m.evidence.review.detail,m.reviewProgress?Object.keys(m.reviewProgress.targets).length:0,m.reviewProgress?Object.keys(m.reviewProgress.inputs).length:0);
  }
  if (action.detail.startsWith('Worker identity')) return {command: '/mission', text: action.detail};
  return {text: action.detail};
 }
 return {text: `Coordinator: ${action.detail}`};
}
