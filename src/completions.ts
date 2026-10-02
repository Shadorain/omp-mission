export interface CompletionSource { id: string; title: string }
export interface CompletionBead { id: string; title: string; category?: string }
export interface CompletionWorker { beadId: string; state: string; handle?: boolean; /** A subagent worker that stopped with an error and awaits guidance or release. */ stopped?: boolean }
export interface MissionCompletionState {
	sources: CompletionSource[];
	beads: CompletionBead[];
	workers: CompletionWorker[];
	/** Verb the operator should run now (from the mission's next step); listed first and marked. */
	recommended?: string;
}

export interface CompletionItem { value: string; label: string; description?: string; hint?: string }

/** `description` says when to run it (autocomplete); `short` fits the action menu. */
export const VERBS: Array<{ name: string; description: string; short: string }> = [
	{ name: "show", short: "Open the inspector", description: "Open the inspector overlay. Read-only, safe any time" },
	{ name: "continue", short: "Take control of a resumed mission", description: "After a restart: take control of the saved mission (needed first)" },
	{ name: "mode", short: "Switch auto / pause / force", description: "How it runs: auto, pause (you approve each gate) or force" },
	{ name: "approve", short: "Approve the waiting gate", description: "Pause mode: approve the gate shown in the widget" },
	{ name: "review", short: "Request or retry independent review", description: "After delivery: request an independent review, or retry one" },
	{ name: "history", short: "Show a bead's audit log", description: "Beads graph: show the audit log of one bead" },
	{ name: "focus", short: "Jump to a worker session", description: "Beads graph: jump to the session of a bead's worker" },
	{ name: "resend", short: "Resend assignment or guide a worker", description: "Worker never claimed its bead, or stopped: resend or guide it" },
	{ name: "release", short: "Hand a bead back for a fresh worker", description: "Worker stuck or stopped: hand its bead back to be retaken" },
	{ name: "dispatch", short: "Start the ready wave", description: "Beads graph: start the ready wave yourself" },
	{ name: "reap", short: "Close a finished worker's session", description: "Beads graph: close the session of a worker whose bead is done" },
	{ name: "actions", short: "Open this menu", description: "Menu of what is valid now, next step first (same as /mission)" },
	{ name: "config", short: "Show or set options", description: "Show or set graph, frontend, model roles and other options" },
];

const FLAGS: Array<{ name: string; alias?: string; description: string }> = [
	{ name: "--force", alias: "-f", description: "Skip plan mode and execute" },
	{ name: "--pause", description: "Start in pause" },
	{ name: "--keep", description: "Leave worker sessions up after close" },
	{ name: "--", description: "Freeform mission description" },
];

const MODES = [
	{ name: "auto", description: "Coordinator runs each wave without asking; review only when you request it" },
	{ name: "pause", description: "You approve every gate with /mission approve before work starts" },
	{ name: "force", description: "Run without gates and always request independent review" },
];

const FRONTENDS = [
	{ name: "none", description: "Background omp process" },
	{ name: "orca", description: "Orca tab" },
	{ name: "herdr", description: "Herdr tab and agent" },
	{ name: "custom", description: "User command template" },
	{ name: "subagent", description: "In-process OMP subagents (Agent Hub)" },
];

const GRAPHS = [
	{ name: "local", description: "This pane; subagents are visibility only" },
	{ name: "beads", description: "Durable bead graph" },
];
const VERB_NAMES = new Set(VERBS.map(verb => verb.name));

function item(stem: string, name: string, description?: string, hint?: string): CompletionItem {
	return { value: stem ? `${stem} ${name} ` : `${name} `, label: name, description, hint };
}

function matches(name: string, partial: string): boolean {
	if (!partial) return true;
	const query = partial.toLowerCase();
	const target = name.toLowerCase();
	return target.startsWith(query) || (query.length > 1 && target.includes(query));
}

function flagMatches(flag: { name: string; alias?: string }, partial: string): boolean {
	if (!partial || partial === "-") return true;
	const query = partial.toLowerCase();
	return flag.name.startsWith(query) || (flag.alias?.startsWith(query) ?? false);
}

function split(prefix: string): { tokens: string[]; partial: string } {
	const trailing = prefix.length > 0 && /\s$/.test(prefix);
	const tokens = prefix.trim().split(/\s+/).filter(Boolean);
	const partial = trailing ? "" : (tokens.pop() ?? "");
	return { tokens, partial };
}

function beadItems(stem: string, beads: CompletionBead[], partial: string): CompletionItem[] {
	return beads
		.filter(bead => matches(bead.id, partial) || matches(bead.title, partial))
		.slice(0, 40)
		.map(bead => item(stem, bead.id, bead.title));
}

function workerBeads(state: MissionCompletionState, predicate: (worker: CompletionWorker, bead?: CompletionBead) => boolean): CompletionBead[] {
	const byId = new Map(state.beads.map(bead => [bead.id, bead]));
	return state.workers.filter(worker => predicate(worker, byId.get(worker.beadId))).map(worker => {
		const bead = byId.get(worker.beadId);
		return { id: worker.beadId, title: bead?.title ?? worker.state };
	});
}

function completeVerb(verb: string, rest: string[], partial: string, state: MissionCompletionState): CompletionItem[] | null {
	const stem = [verb, ...rest].join(" ");
	if (verb === "mode") {
		if (rest.length > 0) return null;
		const items = MODES.filter(mode => matches(mode.name, partial)).map(mode => item(verb, mode.name, mode.description));
		return items.length ? items : null;
	}
	if (verb === "config") {
		if (rest.length === 0) {
			const keys = [
				{ name: "frontend", description: "Session host: none, orca, herdr, custom, subagent" },
				{ name: "graph", description: "Work graph: local or beads" },
				{ name: "modelRole", description: "Model role for independent review" },
				{ name: "workerRole", description: "Model role for bead workers" },
				{ name: "workerContext", description: "Context files for subagent workers" },
				{ name: "reviewContext", description: "Context files for review sessions" },
				{ name: "autoDispatch", description: "Start ready waves without a model turn" },
			].filter((key) => matches(key.name, partial));
			return keys.length ? keys.map((key) => item(verb, key.name, key.description)) : null;
		}
		if (rest.length === 1 && rest[0] === "frontend") {
			const items = FRONTENDS.filter(host => matches(host.name, partial)).map(host => item(stem, host.name, host.description));
			return items.length ? items : null;
		}
		if (rest.length === 1 && rest[0] === "graph") {
			const items = GRAPHS.filter(graph => matches(graph.name, partial)).map(graph => item(stem, graph.name, graph.description));
			return items.length ? items : null;
		}
		if (rest.length === 1 && (rest[0] === "modelRole" || rest[0] === "workerRole")) {
			const roles = [
				{ name: "default", description: "Same model as the coordinator" },
				{ name: "task", description: "Your task role model" },
				{ name: "smol", description: "Fast, cheap model" },
				{ name: "slow", description: "Strongest configured model" },
			];
			const items = roles.filter(role => matches(role.name, partial)).map(role => item(stem, role.name, role.description));
			return items.length ? items : null;
		}
		if (rest.length === 1 && (rest[0] === "workerContext" || rest[0] === "reviewContext")) {
			const modes = [
				{ name: "project", description: "Only the checkout's AGENTS.md (default)" },
				{ name: "all", description: "Everything OMP discovers" },
				{ name: "none", description: "No context files" },
			];
			const items = modes.filter(mode => matches(mode.name, partial)).map(mode => item(stem, mode.name, mode.description));
			return items.length ? items : null;
		}
		if (rest.length === 1 && rest[0] === "autoDispatch") {
			const flags = [{ name: "on", description: "Start ready waves directly" }, { name: "off", description: "Ask the coordinator each wave" }];
			const items = flags.filter(flag => matches(flag.name, partial)).map(flag => item(stem, flag.name, flag.description));
			return items.length ? items : null;
		}
		return null;
	}
	if (verb === "history") {
		if (rest.length > 0) return null;
		const items = beadItems(verb, state.beads, partial);
		return items.length ? items : null;
	}
	if (verb === "focus" || verb === "resend" || verb === "release" || verb === "reap") {
		if (rest.length > 0) return null;
		const workers = workerBeads(state, (worker, bead) => {
			if (verb === "focus") return worker.handle === true;
			if (verb === "resend") return worker.state === "awaiting-claim" || worker.stopped === true;
			if (verb === "release") return worker.stopped === true || worker.state === "running";
			return worker.handle === true && (worker.state === "closed" || bead?.category === "closed");
		});
		const items = beadItems(verb, workers, partial);
		return items.length ? items : null;
	}
	return null;
}

function firstToken(partial: string, state: MissionCompletionState): CompletionItem[] | null {
	const verbs = VERBS.filter(verb => matches(verb.name, partial))
		.map(verb => verb.name === state.recommended ? item("", verb.name, `▸ Next: ${verb.description}`) : item("", verb.name, verb.description))
		.sort((a, b) => Number(b.label === state.recommended) - Number(a.label === state.recommended));
	const flags = partial.startsWith("-") || partial.length === 0
		? FLAGS.filter(flag => flagMatches(flag, partial)).map(flag => item("", flag.name, flag.description))
		: [];
	const sources = partial.startsWith("-")
		? []
		: state.sources.filter(source => matches(source.id, partial) || matches(source.title, partial)).slice(0, 12).map(source => item("", source.id.replace(/^(?:linear|github|freeform):/i, ""), source.title));
	const items = [...verbs, ...flags, ...sources];
	return items.length ? items : null;
}

export function missionArgumentCompletions(prefix: string, state: MissionCompletionState = { sources: [], beads: [], workers: [] }): CompletionItem[] | null {
	if (prefix.includes(" -- ") || prefix.trim() === "--" || prefix.trimStart().startsWith("-- ")) return null;
	const { tokens, partial } = split(prefix);
	if (tokens.includes("--")) return null;
	const head = tokens[0]?.toLowerCase();
	if (head && VERB_NAMES.has(head)) return completeVerb(head, tokens.slice(1), partial, state);
	if (tokens.length === 0) return firstToken(partial, state);
	const used = new Set(tokens);
	const stem = tokens.join(" ");
	const flags = FLAGS.filter(flag => !used.has(flag.name) && !(flag.alias && used.has(flag.alias)) && flagMatches(flag, partial));
	if (partial && !partial.startsWith("-")) return null;
	const items = flags.map(flag => item(stem, flag.name, flag.description));
	return items.length ? items : null;
}
