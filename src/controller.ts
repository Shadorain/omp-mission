import { createHash } from 'node:crypto';
import type { Action, Gate, Graph, Mission, Mode, PolicyContext, Snapshot } from './types';
export function token(value: unknown): string { return createHash('sha256').update(JSON.stringify(value)).digest('hex'); }
export function waveGate(m: Mission, ids: string[], snapshot: Snapshot): Gate {
  return {kind:'wave',token:token([m.id,m.round,ids.map(id=>[id,m.scopes[id],snapshot.beads.find(b=>b.id===id)?.status,snapshot.ready.includes(id)])]),detail:`Start workers: ${ids.join(', ')}`,approved:false};
}
export function revisionGate(m: Mission, kind: 'review' | 'repairs', revision: string): Gate {
 return {kind,token:token([m.id,m.round,kind,revision,kind==='repairs'?m.reviews.at(-1)?.findings:[]]),detail:kind==='review'?`Review revision ${revision}`:`Repair findings: ${m.reviews.at(-1)?.findings.filter(f=>!f.rejection).map(f=>f.id).join(', ')}`,approved:false};
}
export function setMode(m: Mission, mode: Mode): void { m.mode=mode; if(mode==='force')m.reviewRequested=true; if(mode!=='pause')delete m.gate; }
export function approveGate(m: Mission, expected: string): void { if(!m.gate || m.gate.token!==expected)throw new Error('Approval scope changed; inspect the current gate'); m.gate.approved=true; }
export function enforceMutation(m: Mission, p: PolicyContext): void {
 if(p.nativePlan)throw new Error('Mission mutations are forbidden in native plan mode');
 if(p.resumeHold)throw new Error('Resumed inspection: use /mission continue');
 if(!p.owned)throw new Error('Controller ownership required');
 if(m.blocker)throw new Error(m.blocker);
}
export function enforceGate(m: Mission, gate: Gate): void {
 if(m.mode!=='pause')return;
 if(m.gate?.token!==gate.token || !m.gate.approved){m.gate=gate;throw new Error(`Approval required: ${gate.detail}`);}
 delete m.gate;
}
export function effectiveGraph(m: Pick<Mission, 'graph' | 'epicId'>): Graph {
 if (m.graph === 'local' || m.graph === 'beads') return m.graph;
 return 'beads';
}
export function requireBeadsGraph(m: Mission): void {
 if (effectiveGraph(m) === 'local') throw new Error('Local graph has no bead epic or wave; implement in this pane');
}
export function nextAction(m: Mission, snapshot: Snapshot | undefined, policy: PolicyContext): Action {
 if (policy.nativePlan) return {kind: 'hold', detail: 'Native plan mode'};
 if (policy.resumeHold) return {kind: 'hold', detail: 'Resumed inspection; continue explicitly'};
 if (!policy.owned) return {kind: 'hold', detail: 'Controller ownership required'};
 if (m.blocker) return {kind: 'hold', detail: m.blocker};
 if (m.phase === 'complete') return {kind: 'hold', detail: 'Complete; inspection only'};

 const local = effectiveGraph(m) === 'local';
 if (local) {
  if (m.workers.length) return {kind: 'hold', detail: 'Local graph cannot own bead workers'};
 } else {
  if (!m.epicId) return {kind: 'hold', detail: 'Bind workspace and task graph'};
  if (!snapshot || !policy.fresh || snapshot.error) return {kind: 'hold', detail: snapshot?.error ?? 'Fresh graph required'};
  if (!snapshot.leaves.length) return {kind: 'hold', detail: 'Graph has no implementation leaves'};
  const workers = m.workers.filter(worker => worker.state !== 'closed');
  if (workers.some(worker => worker.state === 'missing' || worker.error)) return {kind: 'hold', detail: 'Worker identity or claim requires recovery'};
  const outstanding = snapshot.leaves.filter(bead => bead.category !== 'closed');
  if (outstanding.length) {
   const reserved = new Set(workers.map(worker => worker.beadId));
   const capacity = Math.max(0, policy.maxWorkers - workers.length);
   const ids = snapshot.ready.filter(id => m.scopes[id] && !reserved.has(id)).sort().slice(0, capacity);
   if (m.mode === 'pause' && workers.length) return {kind: 'hold', detail: 'Current wave still running'};
   if (ids.length) {
    const gate = waveGate(m, ids, snapshot);
    if (m.mode === 'pause' && (m.gate?.token !== gate.token || !m.gate.approved)) return {kind: 'hold', detail: gate.detail, gate};
    return {kind: 'dispatch', detail: gate.detail, ids};
   }
   const running = workers.length || outstanding.some(bead => bead.category === 'active');
   return {kind: 'hold', detail: running ? 'Workers running' : 'No eligible leaves; inspect dependencies and scopes'};
  }
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
  return {kind: 'hold', detail: `Review failed; /mission review explicitly retries: ${reviewEvidence.detail}`};
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
