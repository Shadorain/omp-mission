import { test, expect } from 'bun:test';
import { nextAction } from '../src/controller';
import type { Mission, Snapshot, Bead } from '../src/types';
import { Reviewer } from '../src/review';

const leaf: Bead = { id: 'L', title: 'L', status: 'closed', children: [], ready: false, category: 'closed' };
const emptySnapshot: Snapshot = { beads: [leaf], leaves: [leaf], ready: [], closed: 1, active: 0, blocked: 0, fetchedAt: Date.now() };
const basePolicy = {
  nativePlan: false, resumeHold: false, owned: true, fresh: true, maxWorkers: 2
};
function mkMission(): Mission {
  return {
    version: 1, id: 'test', round: 1, mode: 'auto', keep: false, reviewRequested: false, phase: 'plan',
    createdAt: '', updatedAt: '', source: { kind: 'freeform', id: '1', title: '', body: '', comments: '', extra: '' },
    workspace: { key: '', cwd: '', delivery: 'local' }, scopes: {}, evidence: {}, workers: [], reviews: [], repairLinks: {}
  };
}

test('independent review -> repair -> rereview loop state transitions', () => {
  const m = mkMission();
  m.epicId = 'E';
  
  // Setup complete implementation
  m.evidence.verify = { outcome: 'passed', revision: 'hash1', detail: 'OK', at: 'now' };
  m.evidence.deliver = { outcome: 'passed', revision: 'hash1', detail: 'OK', at: 'now' };
  
  // Review not requested
  expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('hold');
  
  // Request review, auto mode
  m.reviewRequested = true;
  expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('review');
  
  // Pause mode review gate
  m.mode = 'pause';
  const reviewAct = nextAction(m, emptySnapshot, basePolicy);
  expect(reviewAct.kind).toBe('hold');
  expect(reviewAct.gate?.kind).toBe('review');
  
  // Approve review
  m.gate = reviewAct.gate;
  m.gate!.approved = true;
  expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('review');
  
  // Simulate review findings
  m.evidence.review = { outcome: 'passed', revision: 'hash1', detail: 'Found issues', at: 'now' };
  m.reviews.push({
    revision: 'hash1', summary: 'Defects', findings: [
      { id: 'f1', severity: 'high', path: 'f.js', line: 1, title: 'B', body: 'Bug' }
    ], round: 1, model: '', at: ''
  });
  delete m.gate;
  
  // Pause mode repair gate
  const repairAct = nextAction(m, emptySnapshot, basePolicy);
  expect(repairAct.kind).toBe('hold');
  expect(repairAct.gate?.kind).toBe('repairs');
  
  // Approve repairs
  m.gate = repairAct.gate;
  m.gate!.approved = true;
  expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('repairs');
  
  // Simulate repair implementation: fresh verification invalidates old review
  m.evidence.verify = { outcome: 'passed', revision: 'hash2', detail: 'Fixed', at: 'now' };
  delete m.gate;
  
  // Fresh revision needs fresh review
  const rereviewAct = nextAction(m, emptySnapshot, basePolicy);
  expect(rereviewAct.kind).toBe('hold');
  expect(rereviewAct.gate?.kind).toBe('review');
  
  // Unresolved finding retry/loop: If review is requested again
  m.gate = rereviewAct.gate;
  m.gate!.approved = true;
  expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('review');
  
  // Simulate clean review
  m.reviews.push({
    revision: 'hash2', summary: 'Clean', findings: [], round: 2, model: '', at: ''
  });
  delete m.gate;
  expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('complete');
});

test('reviewer abort disposes session', async () => {
  const r = new Reviewer();
  // Mock createAgentSession on global or just test that dispose works
  r['session'] = { dispose: async () => { r['session'] = undefined; } } as any;
  await r.dispose();
  expect(r['session']).toBeUndefined();
});

test('reject_finding logic', () => {
  const m = mkMission();
  m.epicId = 'E';
  m.evidence.verify = { outcome: 'passed', revision: 'hash1', detail: 'OK', at: 'now' };
  m.evidence.deliver = { outcome: 'passed', revision: 'hash1', detail: 'OK', at: 'now' };
  m.reviewRequested = true;
  m.reviews.push({
    revision: 'hash1', summary: 'Defects', findings: [
      { id: 'f1', severity: 'high', path: 'f.js', line: 1, title: 'B', body: 'Bug' }
    ], round: 1, model: '', at: ''
  });
  const finding = m.reviews.at(-1)?.findings.find(f => f.id === 'f1');
  if (!finding || !'reason'.trim()) throw new Error('Finding and visible non-actionable explanation required');
  finding.rejection = 'reason';
  
  // nextAction should ignore rejected findings
  const act = nextAction(m, emptySnapshot, basePolicy);
  // Without other findings, it should complete
  expect(act.kind).toBe('complete');
});