import { describe, expect, test } from "bun:test";
import { visibleWidth } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager, Theme } from "@oh-my-pi/pi-coding-agent";
import { MissionInspector, MissionWidget } from "../src/ui.ts";
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
