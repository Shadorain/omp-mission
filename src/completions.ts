export interface CompletionSource { id: string; title: string }
export interface CompletionBead { id: string; title: string; category?: string }
export interface CompletionWorker { beadId: string; state: string; handle?: boolean }
export interface MissionCompletionState {
	sources: CompletionSource[];
	beads: CompletionBead[];
	workers: CompletionWorker[];
}

export interface CompletionItem { value: string; label: string; description?: string; hint?: string }

const VERBS: Array<{ name: string; description: string }> = [
	{ name: "show", description: "Open the inspector" },
	{ name: "continue", description: "Leave inspection and resume" },
	{ name: "mode", description: "Set auto, pause, or force" },
	{ name: "approve", description: "Approve the displayed gate" },
	{ name: "review", description: "Request an independent review" },
	{ name: "history", description: "Show bead history" },
	{ name: "focus", description: "Focus the worker session" },
	{ name: "resend", description: "Resend the assignment" },
	{ name: "dispatch", description: "Dispatch the ready wave" },
	{ name: "reap", description: "Close the worker session" },
	{ name: "actions", description: "Open the action menu" },
	{ name: "config", description: "Show or set graph, frontend, or config" },
];

const FLAGS: Array<{ name: string; alias?: string; description: string }> = [
	{ name: "--force", alias: "-f", description: "Skip plan mode and execute" },
	{ name: "--pause", description: "Start in pause" },
	{ name: "--keep", description: "Leave worker sessions up after close" },
	{ name: "--", description: "Freeform mission description" },
];

const MODES = [
	{ name: "auto", description: "Run waves without an extra pause" },
	{ name: "pause", description: "Wait at every gate" },
	{ name: "force", description: "Execute and request review" },
];

const FRONTENDS = [
	{ name: "none", description: "Background omp process" },
	{ name: "orca", description: "Orca tab" },
	{ name: "herdr", description: "Herdr tab and agent" },
	{ name: "custom", description: "User command template" },
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
				{ name: "frontend", description: "Session host: none, orca, herdr, custom" },
				{ name: "graph", description: "Work graph: local or beads" },
				{ name: "modelRole", description: "Model role for independent review" },
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
		if (rest.length === 1 && rest[0] === "modelRole") {
			const roles = [
				{ name: "smol", description: "Fast, cheap model (default)" },
				{ name: "default", description: "Same model as the coordinator" },
				{ name: "slow", description: "Strongest configured model" },
			];
			const items = roles.filter(role => matches(role.name, partial)).map(role => item(stem, role.name, role.description));
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
	if (verb === "focus" || verb === "resend" || verb === "reap") {
		if (rest.length > 0) return null;
		const workers = workerBeads(state, (worker, bead) => {
			if (verb === "focus") return worker.handle === true;
			if (verb === "resend") return worker.state === "awaiting-claim";
			return worker.handle === true && (worker.state === "closed" || bead?.category === "closed");
		});
		const items = beadItems(verb, workers, partial);
		return items.length ? items : null;
	}
	return null;
}

function firstToken(partial: string, state: MissionCompletionState): CompletionItem[] | null {
	const verbs = VERBS.filter(verb => matches(verb.name, partial)).map(verb => item("", verb.name, verb.description));
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
