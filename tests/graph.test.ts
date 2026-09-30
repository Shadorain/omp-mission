import { expect, test } from "bun:test";
import { configNotice, displayConfigPath, validateMissionConfig } from "../src/config";
import { effectiveGraph, nextAction, requireBeadsGraph } from "../src/controller";
import { validateMission } from "../src/store";
import { noteSubagentSpawn, noteSubagentToolEnd, noteSubagentToolStart, noteSubagentTurnEnd } from "../src/subagents";
import { displayBeads, missionWidgetLines } from "../src/ui";
import type { Bead, Mission, PolicyContext, Projection } from "../src/types";
import type { Theme } from "@oh-my-pi/pi-coding-agent";
const theme = { fg: (_tone: string, text: string) => text } as Theme;
const policy: PolicyContext = { resumeHold: false, owned: true, nativePlan: false, fresh: true, maxWorkers: 2 };

function mission(graph?: Mission["graph"], epicId?: string): Mission {
	return {
		version: 1, id: "mission-x", source: { kind: "freeform", id: "x", title: "x", body: "", comments: "", extra: "" },
		workspace: { key: "x", cwd: "/tmp/work", delivery: "local" }, scopes: {}, phase: "execute", evidence: {},
		mode: "auto", keep: false, reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 1,
		createdAt: "now", updatedAt: "now", ...(graph ? { graph } : {}), ...(epicId ? { epicId } : {}),
	};
}

test("config writes name the file", () => {
	expect(displayConfigPath("/home/daedalus/.omp/agent", "/home/daedalus")).toBe("~/.omp/agent/mission.json");
	expect(displayConfigPath("/tmp/agent", "/home/daedalus")).toBe("/tmp/agent/mission.json");
	expect(configNotice("~/.omp/agent/mission.json", true, "graph beads")).toBe("Configuration set at ~/.omp/agent/mission.json: graph beads");
	expect(configNotice("~/.omp/agent/mission.json", false, "frontend none · graph local")).toBe("Configuration loaded at ~/.omp/agent/mission.json: frontend none · graph local");
});

test("graph defaults to local and beads is explicit", () => {
	expect(validateMissionConfig({ version: 1 }).graph).toBe("local");
	expect(validateMissionConfig({ version: 1, graph: "beads" }).graph).toBe("beads");
	expect(() => validateMissionConfig({ version: 1, graph: "agenda" })).toThrow("graph must be local or beads");
});

test("unstamped and epic missions stay beads; a stamp does not follow a later default", () => {
	expect(effectiveGraph(mission(undefined, "epic"))).toBe("beads");
	expect(effectiveGraph(mission())).toBe("beads");
	expect(effectiveGraph(mission("local"))).toBe("local");
	expect(effectiveGraph(mission("beads"))).toBe("beads");
	expect(validateMission(mission("local")).graph).toBe("local");
	expect(validateMission(mission(undefined, "epic")).graph).toBeUndefined();
});

test("local graph verifies in pane and refuses bead waves", () => {
	const local = mission("local");
	expect(nextAction(local, undefined, policy)).toEqual({ kind: "verify", detail: "Implement in this pane. Subagents are visibility only. Record verification when done" });
	expect(() => requireBeadsGraph(local)).toThrow("Local graph has no bead epic");
	expect(() => requireBeadsGraph(mission(undefined, "epic"))).not.toThrow();
});

test("subagent rows stay out of bead counts", () => {
	let rows = noteSubagentToolStart([], { toolCallId: "call-1", toolName: "task", args: { name: "Scout" } });
	rows = noteSubagentSpawn(rows, { agent: "Eval", invocationKind: "eval" });
	rows = noteSubagentToolEnd(rows, { toolCallId: "call-1", toolName: "task", isError: false });
	rows = noteSubagentTurnEnd(rows);
	expect(rows.map((row) => [row.name, row.state])).toEqual([["Scout", "closed"], ["Eval", "closed"]]);
	const leaf: Bead = { id: "leaf", title: "Leaf", status: "open", children: [], ready: true, category: "ready" };
	const projection: Projection = {
		mission: mission("beads", "epic"),
		snapshot: { beads: [leaf], leaves: [leaf], ready: ["leaf"], closed: 0, active: 1, blocked: 2, fetchedAt: 1 },
		resumeHold: false,
		expanded: true,
		subagents: rows,
	};
	const rendered = missionWidgetLines(projection, 120, true, 40, theme).join("\n");
	expect(rendered).toContain("leaf");
	expect(rendered).toContain("Scout");
	expect(rendered).toContain("0/1");
	expect(displayBeads({ ...projection, mission: mission("local") }).map((bead) => bead.id)).toEqual(rows.map((row) => row.id));
	expect(displayBeads({ ...projection, mission: mission("local") }).some((bead) => bead.id === "leaf")).toBe(false);
});
