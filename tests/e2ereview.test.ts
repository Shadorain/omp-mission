import { test, expect } from 'bun:test';
import {
	nextAction,
	operatorStep,
	providerCapacity,
	quotaBlocked,
	REVIEW_RETRIES,
	reviewRetryAt,
} from '../src/controller';
import type { Mission, Snapshot, Bead } from '../src/types';

const leaf: Bead = { id: 'L', title: 'L', status: 'closed', children: [], ready: false, category: 'closed' };
const emptySnapshot: Snapshot = {
	beads: [leaf],
	leaves: [leaf],
	ready: [],
	closed: 1,
	active: 0,
	blocked: 0,
	fetchedAt: Date.now(),
};
const basePolicy = {
	nativePlan: false,
	resumeHold: false,
	owned: true,
	fresh: true,
	maxWorkers: 2,
};
function mkMission(): Mission {
	return {
		version: 1,
		id: 'test',
		round: 1,
		mode: 'auto',
		keep: false,
		reviewRequested: false,
		phase: 'plan',
		createdAt: '',
		updatedAt: '',
		source: { kind: 'freeform', id: '1', title: '', body: '', comments: '', extra: '' },
		workspace: { key: '', cwd: '', delivery: 'local' },
		scopes: {},
		evidence: {},
		workers: [],
		reviews: [],
		repairLinks: {},
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
		revision: 'hash1',
		summary: 'Defects',
		findings: [
			{
				id: 'f1',
				severity: 'high',
				path: 'f.js',
				line: 1,
				title: 'B',
				body: 'Bug',
				triage: { disposition: 'repair', detail: 'f.js:1 verified defect' },
			},
		],
		round: 1,
		model: '',
		at: '',
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
		revision: 'hash2',
		summary: 'Clean',
		findings: [],
		round: 2,
		model: '',
		at: '',
	});
	delete m.gate;
	expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('complete');
});

test('a failed review reruns by itself after its backoff, and only quota or a spent budget waits for the operator', () => {
	const m = mkMission();
	m.epicId = 'E';
	m.reviewRequested = true;
	m.evidence.verify = { outcome: 'passed', revision: 'r', detail: 'OK', at: 'now' };
	m.evidence.deliver = { outcome: 'passed', revision: 'r', detail: 'OK', at: 'now' };
	const fail = (detail: string, ageMs: number, attempts?: number) => {
		m.evidence.review = {
			outcome: 'failed',
			detail,
			revision: 'r',
			at: new Date(Date.now() - ageMs).toISOString(),
			...(attempts ? { attempts } : {}),
		};
		return nextAction(m, emptySnapshot, basePolicy);
	};
	const throttle =
		'Error: [integration] Reviewer error: 429 {"type":"rate_limit_error"} retry-after-ms=3600000 (review incomplete; failed targets: integration)';

	// The provider asked for an hour: an hour in it still waits, and the operator sees when it reruns, not a command.
	const waiting = fail(throttle, 30 * 60_000);
	expect(waiting.kind).toBe('hold');
	expect(waiting.detail).toMatch(/^Review retries automatically at \d\d:\d\d UTC \(attempt 2 of 4\)/);
	expect(operatorStep(m, waiting, basePolicy).command).toBeUndefined();
	// Past the retry-after plus the per-mission spread (at most a quarter of the wait), it is a review again.
	expect(fail(throttle, 76 * 60_000).kind).toBe('review');
	expect(fail('Error: [bd-1] Reviewer aborted: Deadline exceeded', 3 * 60_000).kind).toBe('review');
	expect(fail('Error: [bd-1] Reviewer aborted: Deadline exceeded', 60_000).kind).toBe('hold');

	// Later attempts back off further; past the budget the operator retries explicitly.
	expect(fail('Reviewer aborted: Deadline exceeded', 5 * 60_000, 2).kind).toBe('hold');
	expect(fail('Reviewer aborted: Deadline exceeded', 13 * 60_000, 2).kind).toBe('review');
	const spent = fail(throttle, 24 * 3600_000, REVIEW_RETRIES + 1);
	expect(spent.detail).toStartWith('Review failed; /mission review explicitly retries');
	expect(operatorStep(m, spent, basePolicy).command).toBe('/mission review');

	// Quota never reruns by itself; any other failure (including a deterministic one) retries within the budget.
	expect(fail('Reviewer error: quota exhausted for this month', 24 * 3600_000).detail).toStartWith(
		'Review failed; /mission review explicitly retries',
	);
	expect(fail('Revision changed during review; result invalidated', 24 * 3600_000).kind).toBe('review');
	expect(fail('Reviewer returned invalid JSON twice', 24 * 3600_000, REVIEW_RETRIES + 1).detail).toStartWith(
		'Review failed; /mission review explicitly retries',
	);
});

test('provider waits longer than six hours are honored with bounded jitter and the longest hint wins', () => {
	const m = mkMission();
	const failedAt = Date.parse('2026-10-14T00:00:00Z');
	m.evidence.review = {
		outcome: 'failed',
		detail: '429 rate_limit_error retry-after-ms=1000 retry-after-ms=28800000',
		at: new Date(failedAt).toISOString(),
		attempts: 1,
	};
	const retry = reviewRetryAt(m)!;
	expect(retry).toBeGreaterThanOrEqual(failedAt + 28800000);
	expect(retry).toBeLessThanOrEqual(failedAt + 28800000 + 60000);
	m.evidence.review.detail = 'quota exhausted for this month';
	expect(reviewRetryAt(m)).toBeUndefined();
});

test('resource_exhausted with a timed free-model rate limit waits for reset, not restored credits', () => {
	const m = mkMission();
	const detail =
		'Devin stream error resource_exhausted: Reached free model rate limit. Your limit will reset in 10 minutes (at 22:01 UTC).';
	m.evidence.review = { outcome: 'failed', detail, at: '2026-10-14T21:49:09.317Z', attempts: 1 };
	expect(providerCapacity(detail)).toBe('rate');
	expect(quotaBlocked(m)).toBe(false);
	expect(reviewRetryAt(m)!).toBeGreaterThanOrEqual(Date.parse('2026-10-14T22:01:00Z'));
	expect(reviewRetryAt(m)!).toBeLessThanOrEqual(Date.parse('2026-10-14T22:02:00Z'));
	m.evidence.review.at = '2026-10-14T23:59:00Z';
	m.evidence.review.detail = 'resource_exhausted: rate limit. Your limit will reset in 5 minutes (at 00:04 UTC).';
	expect(reviewRetryAt(m)!).toBeGreaterThanOrEqual(Date.parse('2026-10-15T00:04:00Z'));
	expect(reviewRetryAt(m)!).toBeLessThanOrEqual(Date.parse('2026-10-15T00:05:00Z'));
	m.evidence.review.detail = 'resource_exhausted: rate limit. Your limit will reset in 20 minutes.';
	expect(reviewRetryAt(m)!).toBeGreaterThanOrEqual(Date.parse('2026-10-15T00:19:00Z'));
	m.evidence.review.detail = 'resource_exhausted: insufficient credits. Rate limit retries cannot restore funds.';
	expect(quotaBlocked(m)).toBe(true);
	expect(reviewRetryAt(m)).toBeUndefined();
	expect(providerCapacity('resource_exhausted')).toBe('quota');
});

test('a follow-up review retries twice, not through the full-audit backoff ladder', () => {
	const m = mkMission();
	m.epicId = 'E';
	m.reviewRequested = true;
	m.evidence.verify = { outcome: 'passed', revision: 'repair', detail: 'Verified', at: 'now' };
	m.evidence.deliver = { ...m.evidence.verify };
	m.reviews = [
		{ round: 1, revision: 'previous', model: 'independent', summary: 'Earlier audit', findings: [], at: 'now' },
	];
	m.evidence.review = {
		outcome: 'failed',
		revision: 'repair',
		detail: 'Reviewer deadline exceeded',
		attempts: 1,
		at: new Date(Date.now() - 3 * 60_000).toISOString(),
	};
	expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('review');
	m.evidence.review.attempts = 2;
	m.evidence.review.at = new Date(Date.now() - 24 * 3600_000).toISOString();
	expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('review');
	m.evidence.review.attempts = 3;
	expect(reviewRetryAt(m)).toBeUndefined();
	expect(nextAction(m, emptySnapshot, basePolicy).kind).toBe('hold');
	expect(nextAction(m, emptySnapshot, basePolicy).detail).toContain('explicitly retries');
});
