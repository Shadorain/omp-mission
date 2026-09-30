import { expect, test } from "bun:test";
import { missionArgumentCompletions, type MissionCompletionState } from "../src/completions";

const state: MissionCompletionState = {
	sources: [{ id: "CHR-142", title: "Fix the gate" }],
	beads: [
		{ id: "bd-1", title: "Implement", category: "ready" },
		{ id: "bd-2", title: "Done", category: "closed" },
	],
	workers: [
		{ beadId: "bd-1", state: "awaiting-claim", handle: true },
		{ beadId: "bd-2", state: "running", handle: true },
	],
};

const labels = (prefix: string) => missionArgumentCompletions(prefix, state)?.map(item => item.label) ?? [];

test("empty prefix lists every subcommand", () => {
	const names = labels("");
	for (const verb of ["show", "continue", "mode", "approve", "review", "history", "focus", "resend", "dispatch", "reap", "actions", "config"]) {
		expect(names).toContain(verb);
	}
	expect(names).toContain("--force");
	expect(names).toContain("CHR-142");
});

test("partial verbs and flags filter", () => {
	expect(labels("con")).toEqual(["continue", "config"]);
	expect(labels("--f")).toEqual(["--force"]);
	expect(labels("-f")).toEqual(["--force"]);
});

test("mode, config, and bead arguments complete", () => {
	expect(labels("mode ")).toEqual(["auto", "pause", "force"]);
	expect(labels("mode p")).toEqual(["pause"]);
	expect(labels("mode auto ")).toEqual([]);
	expect(labels("config ")).toEqual(["frontend", "graph"]);
	expect(labels("config frontend ")).toEqual(["none", "orca", "herdr", "custom"]);
	expect(labels("config graph ")).toEqual(["local", "beads"]);
	expect(labels("config graph b")).toEqual(["beads"]);
	expect(labels("config frontend her")).toEqual(["herdr"]);
	expect(labels("config frontend custom ")).toEqual([]);
	expect(labels("history ")).toEqual(["bd-1", "bd-2"]);
	expect(labels("focus ")).toEqual(["bd-1", "bd-2"]);
	expect(labels("resend ")).toEqual(["bd-1"]);
	expect(labels("reap ")).toEqual(["bd-2"]);
	expect(labels("show ")).toEqual([]);
});

test("saved source keeps flag completion", () => {
	expect(labels("CHR-142 ")).toEqual(["--force", "--pause", "--keep", "--"]);
	expect(labels("CHR-142 --force ")).toEqual(["--pause", "--keep", "--"]);
	expect(labels("CHR-142 -- ")).toEqual([]);
});

test("completion values replace the whole argument with a trailing space", () => {
	const item = missionArgumentCompletions("config frontend ", state)?.find(entry => entry.label === "orca");
	expect(item?.value).toBe("config frontend orca ");
	expect(item?.description).toBe("Orca tab");
});
