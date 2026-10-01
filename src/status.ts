import type { Action, Bead, Mission, Snapshot } from './types';

// Coordinator-facing view. The saved mission keeps full source text and every
// worker assignment (tens of KB each); returning them on every tool call burns
// the coordinator's context while adding nothing it can act on.
const NOTE = 500;
const clip = (text: string, max = NOTE): string => text.length > max ? `${text.slice(0, max)}…` : text;

export function missionView(mission: Mission) {
	const { source, workers, reviews, evidence, ...rest } = mission;
	const { body, comments, extra, ...ref } = source;
	return {
		...rest,
		source: { ...ref, bodyChars: body.length, commentChars: comments.length },
		evidence: Object.fromEntries(Object.entries(evidence).map(([phase, item]) => [phase, item && { ...item, detail: clip(item.detail) }])),
		workers: workers.map(({ assignment: _assignment, ...worker }) => worker),
		reviews: reviews.map((review, index) => index === reviews.length - 1
			? review
			: { round: review.round, revision: review.revision, summary: clip(review.summary), findings: review.findings.length, at: review.at, invalidated: review.invalidated }),
	};
}

function beadView({ description: _description, children, ...bead }: Bead) {
	return { ...bead, children: children.length };
}

export function snapshotView(snapshot: Snapshot) {
	const { beads, leaves, ...rest } = snapshot;
	return { ...rest, beads: beads.map(beadView), leaves: leaves.map(bead => bead.id) };
}

export function snapshotBrief(snapshot: Snapshot) {
	const { beads: _beads, leaves, ...rest } = snapshot;
	return { ...rest, total: leaves.length, outstanding: leaves.filter(bead => bead.category !== 'closed').map(bead => `${bead.id}:${bead.category}`) };
}

export function statusView(input: { mission?: Mission; pending?: Mission; snapshot?: Snapshot; resumeHold: boolean; ownershipError?: string; next?: Action & { guide?: string } }, brief = false) {
	const mission = input.mission && missionView(input.mission);
	return {
		mission: mission && brief ? { ...mission, scopes: undefined, reviews: mission.reviews.length, source: undefined, workspace: undefined, repairLinks: undefined } : mission,
		pending: input.pending && missionView(input.pending),
		snapshot: input.snapshot && (brief ? snapshotBrief(input.snapshot) : snapshotView(input.snapshot)),
		resumeHold: input.resumeHold,
		ownershipError: input.ownershipError,
		next: input.next,
	};
}
