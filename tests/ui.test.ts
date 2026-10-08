import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager, Theme } from "@oh-my-pi/pi-coding-agent";
import { displayBeads, MissionInspector, MissionWidget } from "../src/ui.ts";
import type { Bead, Mission, Projection, Snapshot } from "../src/types.ts";

const theme = { fg: (_tone: string, text: string) => text } as Theme;
const keys = {
	matches(data: string, action: string) {
		return (action === "tui.select.up" && data === "up") || (action === "tui.select.down" && data === "down") || (action === "tui.select.confirm" && data === "enter") || (action === "tui.select.cancel" && data === "escape");
	},
} as KeybindingsManager;

function bead(id: string, children: string[] = [], parent?: string): Bead {
	return { id, title: `Task ${id}`, status: "open", children, ...(parent ? { parent } : {}), ready: true, category: children.length ? "group" : "ready" };
}
function makeMission(): Mission {
	return {
		version: 1, id: "mission-1", source: { kind: "freeform", id: "m1", title: "A narrow rendering mission", body: "", comments: "", extra: "" },
		workspace: { key: "workspace", cwd: "/tmp/work", delivery: "local" }, phase: "execute", evidence: {}, mode: "auto", keep: false,
		reviewRequested: false, workers: [], reviews: [], scopes: {}, repairLinks: {}, round: 0, createdAt: "now", updatedAt: "now",
	};
}
function projection(beads: Bead[], expanded = false): Projection {
	const leaves = beads.filter((item) => item.children.length === 0);
	const snapshot: Snapshot = { beads, leaves, ready: leaves.map((item) => item.id), closed: 0, active: 0, blocked: 0, fetchedAt: 1 };
	return { mission: makeMission(), snapshot, resumeHold: false, expanded };
}

test("dependency waiting is not rendered as a failed task", () => {
	const task = {...bead("waiting-on-domain"), ready: false, category: "waiting" as const};
	const current = projection([task]);
	current.snapshot!.ready = [];
	current.snapshot!.blocked = 1;
	const widget = new MissionWidget(() => current, () => 40, theme);
	expect(widget.render(120)[0]).toContain("1 waiting");
	expect(widget.render(120)[0]).not.toContain("✘");
	current.snapshot!.leaves[0] = {...task, category: "blocked"};
	current.snapshot!.beads[0] = current.snapshot!.leaves[0]!;
	expect(widget.render(120)[0]).toContain("✘ 1");
	expect(widget.render(120)[0]).not.toContain("waiting");
});

test("review-ready evidence overrides an old execute label without changing saved state", () => {
 const current = projection([]);
 current.mission.evidence.verify = {outcome: "passed", detail: "Smoke passed", revision: "same", at: "now"};
 current.mission.evidence.deliver = {outcome: "passed", detail: "PR ready", revision: "same", at: "now"};
 current.step = {command: "/mission review", text: "Request independent review"};
 const widget = new MissionWidget(() => current, () => 40, theme);
 expect(widget.render(120)[0]).toContain("Review");
 expect(widget.render(120)[0]).not.toContain("Execute");
 expect(current.mission.phase).toBe("execute");
 delete current.mission.evidence.deliver;
 expect(widget.render(120)[0]).toContain("Deliver");
 current.snapshot = projection([bead("new-repair")]).snapshot;
 expect(widget.render(120)[0]).toContain("Execute");
 expect(widget.render(120)[0]).not.toContain("Deliver");
});

test("saved reviewers remain visible after history restore and live rows do not duplicate them", () => {
	const current = projection([]);
	current.mission.graph = "local";
	current.mission.phase = "complete";
	current.mission.reviews = [
		{ round: 1, revision: "old", model: "test", summary: "Old review", findings: [], at: "before", transcripts: { integration: "/tmp/old-review.jsonl" } },
		{ round: 2, revision: "new", model: "test", summary: "Clean", findings: [], at: "now", transcripts: { integration: "/tmp/new-review.jsonl", leaf: "/tmp/leaf-review.jsonl" } },
	];
	const inspector = new MissionInspector(() => current, { close() {}, select() {} }, () => 40, theme, keys);
	expect(inspector.render(120).join("\n")).toContain("review integration");
	expect(displayBeads(current).map(row => row.id)).toEqual([
		"subagent:review:0:integration", "subagent:review:1:integration", "subagent:review:1:leaf",
	]);
	expect(displayBeads(current).every(row => row.category === "closed")).toBe(true);
	current.subagents = [{ id: "subagent:review:1:leaf", name: "review leaf", kind: "task", state: "closed" }];
	expect(displayBeads(current).filter(row => row.id === "subagent:review:1:leaf")).toHaveLength(1);
	inspector.handleInput("\t");
	inspector.handleInput("\t");
	expect(inspector.render(120).join("\n")).toContain("/tmp/new-review.jsonl");
});

test("incomplete restored review keeps completed, failed and pending targets distinct", () => {
	const current = projection([]);
	current.mission.graph = "local";
	current.mission.phase = "review";
	current.mission.reviewProgress = {
		round: 1, revision: "same", model: "test", at: "now",
		inputs: { completed: "a", failed: "b", pending: "c" },
		targets: { completed: { summary: "Clean", findings: [], transcript: "/tmp/completed-review.jsonl" } },
		failures: { failed: "Deadline exceeded" },
	};
	expect(displayBeads(current).map(row => [row.id, row.category])).toEqual([
		["subagent:review:0:completed", "closed"],
		["subagent:review:0:failed", "blocked"],
		["subagent:review:0:pending", "waiting"],
	]);
	current.subagents = [{ id: "subagent:review:0:failed", name: "review failed", kind: "task", state: "running" }];
	expect(displayBeads(current).filter(row => row.id === "subagent:review:0:failed").map(row => row.category)).toEqual(["active"]);
});
describe("mission UI", () => {
	test("compact and expanded widgets remain terminal-width and height bounded", () => {
		const beads = [bead("epic", ["one", "two"]), bead("one", [], "epic"), bead("two", [], "epic")];
		let current = projection(beads, true);
		const widget = new MissionWidget(() => current, () => 12, theme);
		const rendered = widget.render(24);
		expect(rendered.length).toBeLessThanOrEqual(Math.floor(12 * 0.45));
		for (const row of rendered) expect(visibleWidth(row)).toBeLessThanOrEqual(24);
		current = { ...current, expanded: false };
		expect(widget.render(13).every((row) => visibleWidth(row) <= 13)).toBe(true);
	});

	test("widget shows the next command under the summary and keeps it within the width", () => {
		const current: Projection = { ...projection([bead("one")]), step: { command: "/mission continue", text: "Take control of this resumed mission" } };
		const wide = new MissionWidget(() => current, () => 40, theme).render(120);
		expect(wide).toHaveLength(2);
		expect(wide[1]).toContain("/mission continue");
		expect(wide[1]).toContain("/mission for the action menu");
		const narrow = new MissionWidget(() => current, () => 40, theme).render(30);
		expect(narrow[1]).not.toContain("action menu");
		for (const row of narrow) expect(visibleWidth(row)).toBeLessThanOrEqual(30);
		expect(new MissionWidget(() => ({ ...current, step: undefined }), () => 40, theme).render(120)).toHaveLength(1);
	});

	test("inspector keeps selected bead and clamps after graph refresh", () => {
		const selected: string[] = [];
		let current = projection([bead("root", ["a", "b"]), bead("a", [], "root"), bead("b", [], "root")]);
		const inspector = new MissionInspector(() => current, {
			close() {},
			select: (id) => { selected.push(id); },
		}, () => 12, theme, keys);
		inspector.handleInput("down");
		expect(inspector.render(50).join("\n")).toMatch(/❯\s+ready\/open a /);
		current = projection([bead("root", ["a", "b", "c"]), bead("a", [], "root"), bead("b", [], "root"), bead("c", [], "root")]);
		expect(inspector.render(50).join("\n")).toMatch(/❯\s+ready\/open a /);
		current = projection([bead("replacement")]);
		expect(inspector.render(50).join("\n")).toContain("replacement");
		expect(selected).toEqual(["root", "a", "replacement"]);
	});

	test("Enter folds parent; action shortcut calls optional action provider", () => {
		let actionCount = 0;
		const inspector = new MissionInspector(
			() => projection([bead("root", ["child"]), bead("child", [], "root")]),
			{ close() {}, select() {}, actions: () => { actionCount += 1; } },
			() => 12,
			theme,
			keys,
		);
		inspector.handleInput("enter");
		expect(inspector.render(60).join("\n")).not.toContain("child");
		inspector.handleInput("a");
		expect(actionCount).toBe(1);
	});
});
