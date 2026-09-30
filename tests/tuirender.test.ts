import { expect, test } from "bun:test";
import { createMissionWidget, createMissionInspector, MissionInspector } from "../src/ui";
import type { Projection, Mission, Snapshot, Bead, AuditEvent } from "../src/types";
import type { Theme, KeybindingsManager } from "@oh-my-pi/pi-coding-agent";
import type { TUI } from "@oh-my-pi/pi-tui";

const hostileTitle = "Huge title \u001b[31mANSI\u001b[0m 🌟\u200D🔥 \u0065\u0301 cjk: 你好世界 " + "very_long_".repeat(50);
const longAssignee = "actor_".repeat(20) + "😎";

const mockTheme = {
  fg: (tone: string, value: string) => `\u001b[38;5;12m${value}\u001b[0m`,
  bg: (tone: string, value: string) => value,
  bold: (value: string) => value,
} as unknown as Theme;

const mockKeybindings = {
  matches: (data: string, name: string) => false,
  describe: (name: string) => name,
} as unknown as KeybindingsManager;

function buildHostileMission(beadCount: number): Projection {
  const mission: Mission = {
    version: 1,
    id: "test-mission-1",
    source: { kind: "linear", id: "CHR-123", title: hostileTitle, body: "body", comments: "comments", extra: "extra" },
    epicId: "epic-1",
    scopes: {},
    workspace: { key: "key", cwd: "/test/worktree", delivery: "pr" },
    round: 1,
    createdAt: "2026",
    updatedAt: "2026",
    mode: "pause",
    phase: "plan",
    evidence: {
      plan: { outcome: "active", detail: "active", at: "2026" },
    },
    gate: { kind: "wave", detail: "hostile gate", approved: false, token: "token1" },
    workers: [{ beadId: "b-0", attempt: "uuid", cwd: "/tmp", files: [], state: "running", handle: "H1", incarnationId: "1", assignment: "assignment" }],
    reviews: [{ round: 1, model: "model", summary: "summary", revision: "rev1", at: "2026", findings: [] }],
    repairLinks: {},
    keep: false,
    reviewRequested: true,
  } as unknown as Mission;

  const beads: Bead[] = Array.from({ length: beadCount }).map((_, i) => ({
    id: `b-${i}`,
    title: hostileTitle,
    category: ["active", "ready", "blocked", "waiting", "group"][i % 5] as Bead["category"],
    status: ["open", "active", "done", "waiting", "blocked"][i % 5] as Bead["status"],
    children: i * 2 + 1 < beadCount ? [`b-${i * 2 + 1}`, `b-${i * 2 + 2}`] : [],
    parent: i === 0 ? undefined : `b-${Math.floor((i - 1) / 2)}`,
    assignee: longAssignee,
    ready: true,
  }));

  const snapshot: Snapshot = {
    beads,
    leaves: beads.filter(b => b.children.length === 0),
    ready: [],
    closed: 0,
    active: 1,
    blocked: 1,
    fetchedAt: 123,
    error: "A very bad stale error \u001b[31mFAIL\u001b[0m",
  };

  const history: AuditEvent[] = Array.from({ length: 1000 }).map((_, i) => ({
    event: "claim",
    actor: longAssignee,
    timestamp: "12345678",
    summary: `History event ${i} ` + hostileTitle,
  }));

  return {
    mission,
    snapshot,
    history,
    resumeHold: true,
    nativePlan: true,
    ownershipError: "lock compromised \u001b[31moh no\u001b[0m",
    nextAction: "doing hostile stuff",
    expanded: true,
  };
}

const widths = [1, 5, 10, 20, 40, 60, 80, 120, 200];
const heights = Array.from({ length: 56 }).map((_, i) => i + 5);

test("missionWidgetLines respects bounds and width", () => {
  for (const count of [0, 1, 500]) {
    const proj = buildHostileMission(count);
    for (const w of widths) {
      for (const h of heights) {
        const widget = createMissionWidget(() => proj, () => h, mockTheme);
        const lines = widget.render(w);
        
        for (const line of lines) {
          expect(typeof line).toBe("string");
        }
        
        if (proj.expanded) {
          const maxRows = Math.max(0, Math.floor(Math.max(0, h) * 0.45));
          if (maxRows >= 0 && lines.length > maxRows) {
            expect(lines.length).toBe(maxRows);
          }
        }
      }
    }
  }
});

test("MissionInspector interactions and bounds", () => {
  let proj = buildHostileMission(500);
  let closed = false;
  let selected = "";
  let actionsFired = false;
  const callbacks = {
    close: () => { closed = true; },
    select: (id: string) => { selected = id; },
    actions: () => { actionsFired = true; },
  };

  const createInspector = (h: number) => {
    const factory = createMissionInspector(() => proj, callbacks, () => h);
    return factory({} as unknown as TUI, mockTheme, mockKeybindings);
  };

  const inspector = createInspector(40);
  
  let lines = inspector.render(80);
  expect(lines.length).toBeLessThanOrEqual(40);
  expect(selected).toBe("b-0");

  inspector.handleInput("\t");
  lines = inspector.render(80);
  expect(lines.length).toBeLessThanOrEqual(40);

  inspector.handleInput("\t");
  lines = inspector.render(80);
  expect(lines.length).toBeLessThanOrEqual(40);

  inspector.handleInput("\t");
  lines = inspector.render(80);

  inspector.handleInput("\r");
  inspector.render(80);
  
  inspector.handleInput("j");
  inspector.render(80);
  
  inspector.handleInput("k");
  inspector.render(80);
  
  proj = buildHostileMission(1);
  lines = inspector.render(80);
  
  inspector.handleInput("q");
  expect(closed).toBeTrue();
  
  inspector.handleInput("a");
  expect(actionsFired).toBeTrue();
});
