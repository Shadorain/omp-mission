import { expect, test } from "bun:test";
import { missionArgumentCompletions, type MissionCompletionState } from "../src/completions";

const state: MissionCompletionState = {
	sources: [{ id: "CHR-142", title: "Fix the gate" }],
	completed: [
		{ id: "CHR-142", title: "Fix the gate", runId: "chr-142-a1b2" },
		{ id: "CHR-142", title: "Fix the gate", runId: "chr-142-c3d4" },
	],
	beads: [
		{ id: "bd-1", title: "Implement", category: "ready" },
		{ id: "bd-2", title: "Done", category: "closed" },
	],
	workers: [
		{ beadId: "bd-1", state: "awaiting-claim", handle: true },
		{ beadId: "bd-2", state: "running", handle: true },
	],
};

const items = (prefix: string, extra: Partial<MissionCompletionState> = {}) => missionArgumentCompletions(prefix, { ...state, ...extra }) ?? [];
const labels = (prefix: string, extra: Partial<MissionCompletionState> = {}) => items(prefix, extra).map(item => item.label);

test("empty prefix lists core commands and flags, not saved tickets", () => {
	const names = labels("");
	expect(names.slice(0, 3)).toEqual(["show", "history", "config"]);
	expect(names).toContain("--force");
	expect(names).not.toContain("CHR-142");
	for (const hidden of ["clear", "continue", "mode", "approve", "review", "focus", "resend", "release", "dispatch", "reap", "actions"]) {
		expect(names).not.toContain(hidden);
	}
});

test("completed runs never appear as source suggestions", () => {
	expect(labels("")).not.toContain("CHR-142");
	expect(labels("")).not.toContain("chr-142-a1b2");
	expect(labels("chr")).toEqual(["CHR-142"]);
});

test("available state reveals contextual verbs, workers stay hidden", () => {
	const available = ["continue", "mode", "approve", "review", "clear", "focus bd-1", "dispatch", "actions"];
	const names = labels("", { available });
	for (const shown of ["continue", "mode", "approve", "review", "clear"]) {
		expect(names).toContain(shown);
	}
	for (const hidden of ["focus", "dispatch", "actions", "resend", "release", "reap"]) {
		expect(names).not.toContain(hidden);
	}
	// Full commands in `available` also enable the contextual verb's bare form.
	expect(labels("", { available: ["mode pause"] })).toContain("mode");
});

test("the recommended worker verb is suggested even though it is otherwise hidden", () => {
	expect(labels("", { recommended: "resend", available: ["resend bd-1"], workers: [{ beadId: "bd-1", state: "running", stopped: true }] })).toContain("resend");
	expect(labels("resend ", { recommended: "resend", workers: [{ beadId: "bd-1", state: "running", stopped: true }] }).map(name => name)).toContain("bd-1");
});

test("partial verbs and flags filter", () => {
	expect(labels("con")).toEqual(["config"]);
	expect(labels("con", { available: ["continue"] })).toEqual(["continue", "config"]);
	expect(labels("--f")).toEqual(["--force"]);
	expect(labels("-f")).toEqual(["--force"]);
});

test("mode and config arguments complete", () => {
	expect(labels("mode ")).toEqual(["auto", "pause", "force"]);
	expect(labels("mode p")).toEqual(["pause"]);
	expect(labels("mode auto ")).toEqual([]);
	expect(labels("config ")).toEqual(["frontend", "graph", "modelRole", "workerRole", "workerContext", "reviewContext", "autoDispatch"]);
	expect(labels("config workerContext ")).toEqual(["project", "all", "none"]);
	expect(labels("config modelRole ")).toEqual(["default", "task", "smol", "slow"]);
	expect(labels("config workerRole t")).toEqual(["task"]);
	expect(labels("config autoDispatch o")).toEqual(["on", "off"]);
	expect(labels("config frontend ")).toEqual(["none", "orca", "herdr", "custom", "subagent"]);
	expect(labels("config graph ")).toEqual(["local", "beads"]);
	expect(labels("config graph b")).toEqual(["beads"]);
	expect(labels("config frontend her")).toEqual(["herdr"]);
	expect(labels("config frontend custom ")).toEqual([]);
	expect(labels("show ")).toEqual([]);
});

test("history completes completed runs by runId plus beads", () => {
	const history = items("history ");
	expect(history.map(item => item.value)).toEqual(["history chr-142-a1b2 ", "history chr-142-c3d4 ", "history bd-1 ", "history bd-2 "]);
	expect(history[0]?.label).toBe("CHR-142");
	expect(history[0]?.description).toBe("Fix the gate · chr-142-a1b2");
	// Distinct runs of the same source stay selectable by runId.
	expect(items("history chr-142-c").map(item => item.value)).toEqual(["history chr-142-c3d4 "]);
	expect(items("history bd-1").map(item => item.value)).toEqual(["history bd-1 "]);
});

test("specialist argument completions still work when typed directly", () => {
	expect(labels("focus ")).toEqual(["bd-1", "bd-2"]);
	expect(labels("resend ")).toEqual(["bd-1"]);
	expect(labels("release ")).toEqual(["bd-2"]);
	expect(labels("reap ")).toEqual(["bd-2"]);
	expect(labels("dispatch ")).toEqual([]);
	expect(labels("actions ")).toEqual([]);
});

test("saved source keeps flag completion", () => {
	expect(labels("CHR-142 ")).toEqual(["--force", "--pause", "--keep", "--"]);
	expect(labels("CHR-142 --force ")).toEqual(["--pause", "--keep", "--"]);
	expect(labels("CHR-142 -- ")).toEqual([]);
});

test("completion values replace the whole argument with a trailing space", () => {
	const item = items("config frontend ").find(entry => entry.label === "orca");
	expect(item?.value).toBe("config frontend orca ");
	expect(item?.description).toBe("Orca tab");
});

test("the recommended verb is listed first only when visible", () => {
	const available = ["continue", "mode"];
	const recommended = items("", { available, recommended: "continue" });
	expect(recommended[0]?.label).toBe("continue");
	expect(recommended[0]?.description).toStartWith("▸ Next:");
	expect(recommended.filter(item => item.description?.startsWith("▸")).length).toBe(1);
	// A hidden contextual recommendation is ignored entirely.
	expect(items("", { recommended: "continue" })[0]?.label).toBe("show");
	// Specialist recommendations never surface, even when listed as available.
	const specialist = items("", { available: ["focus bd-1", "mode"], recommended: "focus bd-1" });
	expect(specialist[0]?.label).toBe("show");
	expect(specialist.map(item => item.label)).not.toContain("focus");
});
