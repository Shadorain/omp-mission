import type { Action, Mission, Snapshot } from './types';

// What the coordinator model sees. The saved mission keeps everything (source text,
// worker assignments, timestamps, lock nonce); none of it helps a decision, and every
// tool result stays in context for the rest of the session, so views carry only state
// the model can act on.
const clip = (text: string, max: number): string => text.length > max ? `${text.slice(0, max)}…` : text;

export type NextView = Action & { guide?: string };
interface Input { mission?: Mission; pending?: Mission; snapshot?: Snapshot; resumeHold: boolean; ownershipError?: string; next?: NextView }

function openWorkers(mission: Mission) {
	return mission.workers.filter(worker => worker.state !== 'closed').map(({ beadId, state, handle, error }) => ({ beadId, state, ...(handle ? { handle } : {}), ...(error ? { error: clip(error, 160) } : {}) }));
}

function outstanding(snapshot: Snapshot | undefined): string[] | undefined {
	return snapshot?.leaves.filter(bead => bead.category !== 'closed').map(bead => `${bead.id}:${bead.category}`);
}

/** Result of a control call: the new position and what to do next. */
export function briefView({ mission, pending, snapshot, resumeHold, ownershipError, next }: Input) {
	if (!mission) return { pending: pending ? pending.source.id : undefined, next };
	return {
		phase: mission.phase,
		mode: mission.mode,
		round: mission.round,
		...(mission.gate ? { gate: `${mission.gate.detail}${mission.gate.approved ? ' (approved)' : ''}` } : {}),
		...(mission.blocker ? { blocker: mission.blocker } : {}),
		...(resumeHold ? { resumeHold: true } : {}),
		...(ownershipError ? { ownershipError } : {}),
		next,
		workers: openWorkers(mission),
		outstanding: outstanding(snapshot),
		...(snapshot?.error ? { graphError: clip(snapshot.error, 200) } : {}),
	};
}

/** Result of mission_status: the brief view plus evidence, review, and the bead list. */
export function statusView(input: Input) {
	const { mission, pending, snapshot } = input;
	const brief = briefView(input);
	if (!mission) return { ...brief, pending: pending ? { id: pending.id, source: pending.source.id, title: pending.source.title } : undefined };
	const review = mission.reviews.at(-1);
	return {
		...brief,
		mission: mission.id,
		graph: mission.graph,
		epic: mission.epicId,
		keep: mission.keep,
		reviewRequested: mission.reviewRequested,
		evidence: Object.fromEntries(Object.entries(mission.evidence).map(([phase, item]) => [phase, item && `${item.outcome}: ${clip(item.detail, 160)}`])),
		review: review && { round: review.round, summary: clip(review.summary, 300), invalidated: review.invalidated, findings: review.findings },
		reviewRounds: mission.reviews.length,
		beads: snapshot?.beads.map(bead => `${bead.id} ${bead.category} ${clip(bead.title, 60)}`),
		ready: snapshot?.ready,
		closed: snapshot?.closed,
	};
}
