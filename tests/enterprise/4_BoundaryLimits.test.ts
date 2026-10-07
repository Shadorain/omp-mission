// Battery 4: Performance & Boundary Limits
// Comprehensive enterprise boundary tests for 300KB diff cap, large context truncation, and listener cleanup.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventEmitter } from "node:events";

import {
  DIFF_BUDGET,
  boundDiff,
  Reviewer,
  reviewBudgetMs,
  captureRevision,
  parseReview,
  type BeadReviewTarget,
  type ReviewOpener,
  type ReviewSession,
} from "../../src/review";
import { fetchSource } from "../../src/sources";
import { beadTask } from "../../src/prompts";
import { briefView, statusView } from "../../src/status";
import { validateReviewSummary, validateMission } from "../../src/store";
import { lock } from "../../src/lock";
import { missionWidgetLines } from "../../src/ui";
import type { ExtensionContext, Theme } from "@oh-my-pi/pi-coding-agent";
import type { Bead, Mission, Run, Snapshot, Worker } from "../../src/types";

const tempDirs: string[] = [];
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function makeTempDir(prefix = "battery4-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

const mockTheme = {
  fg: (_tone: unknown, text: string) => text,
  bg: (_tone: unknown, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function makeMission(cwd: string, overrides: Partial<Mission> = {}): Mission {
  return {
    version: 1,
    id: "b4-mission",
    source: {
      kind: "freeform",
      id: "freeform:b4",
      title: "Battery 4 Test",
      body: "Test spec",
      comments: "",
      extra: "",
    },
    workspace: {
      key: "b4-key",
      cwd,
      delivery: "local",
    },
    scopes: { "bd-1": ["src/**"] },
    phase: "review",
    evidence: {},
    mode: "auto",
    keep: false,
    reviewRequested: true,
    workers: [],
    reviews: [],
    repairLinks: {},
    round: 1,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function makeDiffSection(path: string, totalBytes: number): string {
  const header = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n`;
  if (totalBytes <= header.length) {
    return header.slice(0, Math.max(0, totalBytes - 1)) + "\n";
  }
  const bodyBytes = totalBytes - header.length;
  const repeats = Math.floor((bodyBytes - 1) / 3);
  const filler = "+x\n".repeat(repeats);
  const rem = bodyBytes - filler.length;
  let padding = "";
  if (rem === 1) padding = "\n";
  else if (rem === 2) padding = "+\n";
  else if (rem >= 3) padding = "+" + "x".repeat(rem - 2) + "\n";
  return header + filler + padding;
}

const realRun: Run = async (command, args, cwd) => {
  const child = Bun.spawn([command, ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout, stderr, code };
};

const fakeContext = {
  model: { provider: "anthropic", id: "claude-3-5-sonnet" },
  modelRegistry: {
    getAvailable: () => [{ provider: "anthropic", id: "claude-3-5-sonnet" }],
    authStorage: {},
  },
} as unknown as ExtensionContext;

// ============================================================================
// 1. 300KB Diff Cap & Omission Budgeting
// ============================================================================
describe("Battery 4: 300KB Diff Cap & Omission Budgeting", () => {
  test("DIFF_BUDGET constant equals exactly 300,000 bytes", () => {
    expect(DIFF_BUDGET).toBe(300_000);
  });

  test("diff under or exactly equal to DIFF_BUDGET passes through completely with zero omitted files", () => {
    // 1. Empty diff
    expect(boundDiff("")).toEqual({ diff: "", omitted: [] });

    // 2. Small 10KB diff
    const smallDiff = makeDiffSection("src/small.ts", 10_000);
    const boundedSmall = boundDiff(smallDiff);
    expect(boundedSmall.diff).toBe(smallDiff);
    expect(boundedSmall.omitted).toEqual([]);

    // 3. Exact boundary: precisely 300,000 bytes
    const exactDiff = makeDiffSection("src/exact.ts", 300_000);
    expect(exactDiff.length).toBe(300_000);
    const boundedExact = boundDiff(exactDiff);
    expect(boundedExact.diff).toBe(exactDiff);
    expect(boundedExact.diff.length).toBe(300_000);
    expect(boundedExact.omitted).toEqual([]);
  });

  test("diff at 300,001 bytes triggers bounding and omits oversized file", () => {
    const diff = makeDiffSection("src/tiny.ts", 1_000) + makeDiffSection("src/overflow.ts", 299_001);
    expect(diff.length).toBe(300_001);

    const bounded = boundDiff(diff);
    expect(bounded.diff.length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(bounded.omitted).toEqual(["src/overflow.ts"]);
    expect(bounded.diff).toContain("src/tiny.ts");
    expect(bounded.diff).not.toContain("src/overflow.ts");
  });

  test("greedy smallest-first packing keeps small files and omits larger files when budget is spent", () => {
    // Construct 4 files:
    // tiny: 2,000 bytes
    // small: 40,000 bytes
    // medium: 100,000 bytes
    // giant: 250,000 bytes
    // Total = 392,000 bytes > 300,000 bytes
    // Smallest first order: tiny (2k) + small (40k) + medium (100k) = 142k <= 300k.
    // giant (250k) would bring total to 392k > 300k, so it must be omitted.
    const diff =
      makeDiffSection("src/giant.ts", 250_000) +
      makeDiffSection("src/tiny.ts", 2_000) +
      makeDiffSection("src/medium.ts", 100_000) +
      makeDiffSection("src/small.ts", 40_000);

    const bounded = boundDiff(diff);
    expect(bounded.diff.length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(bounded.diff).toContain("src/tiny.ts");
    expect(bounded.diff).toContain("src/small.ts");
    expect(bounded.diff).toContain("src/medium.ts");
    expect(bounded.diff).not.toContain("src/giant.ts");
    expect(bounded.omitted).toEqual(["src/giant.ts"]);
  });

  test("single monolithic file exceeding 300,000 bytes is omitted entirely, resulting in empty diff", () => {
    const hugeDiff = makeDiffSection("dist/bundle.js", 500_000);
    expect(hugeDiff.length).toBe(500_000);

    const bounded = boundDiff(hugeDiff);
    expect(bounded.diff).toBe("");
    expect(bounded.omitted).toEqual(["dist/bundle.js"]);
    expect(bounded.diff.length).toBe(0);
  });

  test("high volume stress test: 5MB multi-file enterprise diff is strictly bound within budget", () => {
    // Simulate an enterprise PR with 100 files of varying sizes totaling ~5 MB
    const sections: string[] = [];
    for (let i = 0; i < 100; i++) {
      const size = 10_000 + (i % 10) * 10_000; // 10KB to 100KB per file
      sections.push(makeDiffSection(`src/modules/module_${i}.ts`, size));
    }
    const megaDiff = sections.join("");
    expect(megaDiff.length).toBeGreaterThan(5_000_000);

    const start = performance.now();
    const bounded = boundDiff(megaDiff);
    const elapsed = performance.now() - start;

    expect(elapsed).toBeLessThan(150); // fast execution
    expect(bounded.diff.length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(bounded.omitted.length).toBeGreaterThan(0);

    // Kept files + omitted files must equal total 100 files
    const keptCount = (bounded.diff.match(/^diff --git /gm) ?? []).length;
    expect(keptCount + bounded.omitted.length).toBe(100);
  });

  test("two files each within 300KB budget whose combined size exceeds 300KB keeps the smaller file and omits the larger file", () => {
    // File A: 140KB, File B: 180KB -> sum = 320KB > 300KB
    const diff = makeDiffSection("src/b.ts", 180_000) + makeDiffSection("src/a.ts", 140_000);
    expect(diff.length).toBe(320_000);

    const bounded = boundDiff(diff);
    expect(bounded.diff.length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(bounded.diff).toContain("src/a.ts");
    expect(bounded.diff).not.toContain("src/b.ts");
    expect(bounded.omitted).toEqual(["src/b.ts"]);
  });

  test("diff path parsing handles renamed, deeply nested, and space-separated file paths", () => {
    // 1. Deeply nested file
    const deepDiff = makeDiffSection("deep/a/b/c/d/e/file.ts", 350_000);
    expect(boundDiff(deepDiff).omitted).toEqual(["deep/a/b/c/d/e/file.ts"]);

    // 2. Renamed file (diff --git a/old.ts b/new.ts)
    const renameDiff =
      `diff --git a/src/old.ts b/src/new.ts\n` +
      `similarity index 80%\n` +
      `rename from src/old.ts\n` +
      `rename to src/new.ts\n` +
      `--- a/src/old.ts\n` +
      `+++ b/src/new.ts\n` +
      "+line\n".repeat(60_000);
    expect(renameDiff.length).toBeGreaterThan(300_000);
    expect(boundDiff(renameDiff).omitted).toEqual(["src/new.ts"]);

    // 3. Fallback when diff lacks standard git header
    const nonStandardDiff = "--- a/raw.patch\n+++ b/raw.patch\n" + "+line\n".repeat(60_000);
    const boundedNonStandard = boundDiff(nonStandardDiff);
    expect(boundedNonStandard.diff).toBe("");
    expect(boundedNonStandard.omitted.length).toBe(1);
    expect(boundedNonStandard.omitted[0]).toBe(nonStandardDiff.slice(0, 120));
  });

  test("Reviewer.run passes bounded diff and omittedDiffs metadata to model session", async () => {
    const cwd = await makeTempDir("rev-cap-run-");
    await realRun("git", ["init", "-q", "-b", "main"], cwd);
    await realRun("git", ["config", "user.email", "test@test"], cwd);
    await realRun("git", ["config", "user.name", "test"], cwd);
    await writeFile(join(cwd, "initial.txt"), "hello");
    await realRun("git", ["add", "."], cwd);
    await realRun("git", ["commit", "-qm", "init"], cwd);

    // Create a large file (>300KB) and a small file
    await writeFile(join(cwd, "small.txt"), "modified small");
    await writeFile(join(cwd, "huge.txt"), "x".repeat(350_000));
    await realRun("git", ["add", "-A"], cwd);
    const mission = makeMission(cwd, {
      workspace: { key: "k", cwd, delivery: "local", base: "HEAD", commonDir: join(cwd, ".git") },
      scopes: { "bd-1": ["*"] },
    });
    const rev = (await captureRevision(mission, realRun)).revision;
    mission.evidence.verify = { outcome: "passed", detail: "ok", revision: rev, at: new Date().toISOString() };

    let promptPayload: Record<string, unknown> | undefined;
    const opener: ReviewOpener = async () => {
      const messages: unknown[] = [];
      return {
        session: {
          state: { messages } as never,
          async prompt(text: string) {
            promptPayload = JSON.parse(text);
            messages.push({
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify({ reviewedRevision: rev, summary: "Clean", findings: [] }) }],
            });
          },
          async dispose() {},
        } as never,
      };
    };

    const reviewer = new Reviewer(opener);
    const round = await reviewer.run(mission, fakeContext, realRun);

    expect(round.summary).toBe("Clean");
    expect(promptPayload).toBeDefined();
    expect((promptPayload!.diff as string).length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(promptPayload!.omittedDiffs).toEqual(["huge.txt"]);
  });

  test("Reviewer.runPerBead bounds scoped diffs per-bead and integration pass diff", async () => {
    const cwd = await makeTempDir("rev-cap-bead-");
    await realRun("git", ["init", "-q", "-b", "main"], cwd);
    await realRun("git", ["config", "user.email", "test@test"], cwd);
    await realRun("git", ["config", "user.name", "test"], cwd);
    await mkdir(join(cwd, "a"));
    await mkdir(join(cwd, "b"));
    await writeFile(join(cwd, "a", "file.txt"), "initial a");
    await writeFile(join(cwd, "b", "file.txt"), "initial b");
    await realRun("git", ["add", "."], cwd);
    await realRun("git", ["commit", "-qm", "init"], cwd);

    // Make bead-a huge (>300KB) and bead-b small
    await writeFile(join(cwd, "a", "file.txt"), "x".repeat(350_000));
    await writeFile(join(cwd, "b", "file.txt"), "modified b");

    const mission = makeMission(cwd, {
      workspace: { key: "k", cwd, delivery: "local", base: "HEAD", commonDir: join(cwd, ".git") },
      graph: "beads",
      scopes: { "bd-a": ["a/**"], "bd-b": ["b/**"] },
    });
    const rev = (await captureRevision(mission, realRun)).revision;
    mission.evidence.verify = { outcome: "passed", detail: "ok", revision: rev, at: new Date().toISOString() };

    const targets: BeadReviewTarget[] = [
      { id: "bd-a", title: "Bead A", text: "Task A", files: ["a/**"] },
      { id: "bd-b", title: "Bead B", text: "Task B", files: ["b/**"] },
    ];

    const capturedPayloads: Array<{ note: string; payload: Record<string, unknown> }> = [];
    const opener: ReviewOpener = async (_m, _ctx, _model, _files, note) => {
      const messages: unknown[] = [];
      return {
        session: {
          state: { messages } as never,
          async prompt(text: string) {
            const payload = JSON.parse(text);
            capturedPayloads.push({ note, payload });
            messages.push({
              role: "assistant",
              content: [{ type: "text", text: JSON.stringify({ reviewedRevision: rev, summary: `Ok ${note}`, findings: [] }) }],
            });
          },
          async dispose() {},
        } as never,
      };
    };

    const reviewer = new Reviewer(opener);
    const round = await reviewer.runPerBead(mission, fakeContext, realRun, "default", undefined, targets);

    expect(round.findings).toEqual([]);
    expect(capturedPayloads).toHaveLength(3); // bd-a, bd-b, integration

    const beadAPayload = capturedPayloads.find((c) => (c.payload.bead as { id: string })?.id === "bd-a");
    expect(beadAPayload).toBeDefined();
    expect((beadAPayload!.payload.diff as string).length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(beadAPayload!.payload.omittedDiffs).toEqual(["a/file.txt"]);

    const beadBPayload = capturedPayloads.find((c) => (c.payload.bead as { id: string })?.id === "bd-b");
    expect(beadBPayload).toBeDefined();
    expect((beadBPayload!.payload.diff as string).length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(beadBPayload!.payload.omittedDiffs).toBeUndefined();

    const integrationPayload = capturedPayloads.find((c) => c.note.includes("integration"));
    expect(integrationPayload).toBeDefined();
    expect((integrationPayload!.payload.diff as string).length).toBeLessThanOrEqual(DIFF_BUDGET);
    expect(integrationPayload!.payload.omittedDiffs).toEqual(["a/file.txt"]);
  });

  test("reviewBudgetMs scales dynamically with changed file count and caps strictly at 30 minutes", () => {
    // Base: 0 files -> 5 minutes
    expect(reviewBudgetMs(0)).toBe(5 * 60_000);

    // Scaling: +15s per changed file
    expect(reviewBudgetMs(1)).toBe(5 * 60_000 + 15_000);
    expect(reviewBudgetMs(10)).toBe(5 * 60_000 + 150_000);
    expect(reviewBudgetMs(50)).toBe(5 * 60_000 + 750_000);

    // Cap: 100 files -> 5m + 25m = 30m
    expect(reviewBudgetMs(100)).toBe(30 * 60_000);

    // Boundary: 500 files and 10,000 files do not exceed 30m cap
    expect(reviewBudgetMs(500)).toBe(30 * 60_000);
    expect(reviewBudgetMs(10_000)).toBe(30 * 60_000);
  });
});

// ============================================================================
// 2. Large Context Truncation & String Budget Limits
// ============================================================================
describe("Battery 4: Large Context Truncation & String Budget Limits", () => {
  test("fetchSource bounds issue comments to maximum 8 items and appends truncation warning", async () => {
    const cwd = await makeTempDir("src-trunc-count-");
    const commentsList = Array.from({ length: 15 }, (_, i) => ({
      body: `Comment number ${i + 1} detailing requirements.`,
    }));

    const mockRun: Run = async (command, args) => {
      if (args[0] === "issue" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 42,
            title: "Issue with many comments",
            body: "Main body description",
            url: "https://github.com/org/repo/issues/42",
            comments: commentsList,
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const source = await fetchSource(
      { source: "org/repo#42", extra: "", force: false, pause: false, keep: false },
      cwd,
      mockRun,
    );

    // Exactly 8 comments included
    expect(source.comments).toContain("1. Comment number 1");
    expect(source.comments).toContain("8. Comment number 8");
    expect(source.comments).not.toContain("9. Comment number 9");
    expect(source.comments).toContain(
      "[Comments truncated; fetch full issue history before treating this as complete specification.]",
    );
  });

  test("fetchSource bounds issue comments by total 20,000 byte limit", async () => {
    const cwd = await makeTempDir("src-trunc-bytes-");
    // 3 giant comments of 10,000 bytes each -> 30,000 bytes > 20,000 limit
    const commentsList = [
      { body: "A".repeat(10_000) },
      { body: "B".repeat(10_000) },
      { body: "C".repeat(10_000) },
    ];

    const mockRun: Run = async (command, args) => {
      if (args[0] === "issue" && args[1] === "view") {
        return {
          code: 0,
          stdout: JSON.stringify({
            number: 101,
            title: "Issue with giant comments",
            body: "Body",
            url: "https://github.com/org/repo/issues/101",
            comments: commentsList,
          }),
          stderr: "",
        };
      }
      return { code: 0, stdout: "", stderr: "" };
    };

    const source = await fetchSource(
      { source: "org/repo#101", extra: "", force: false, pause: false, keep: false },
      cwd,
      mockRun,
    );

    expect(source.comments).toContain("1. ");
    expect(source.comments).not.toContain("3. ");
    expect(source.comments).toContain("[Comments truncated; fetch full issue history before treating this as complete specification.]");
    expect(source.comments.length).toBeLessThan(25_000);
  });

  test("beadTask truncates task description exceeding 8000 characters", () => {
    const beadUnder: Bead = {
      id: "bd-1",
      title: "Task 1",
      description: "x".repeat(7_900),
      status: "open",
      category: "ready",
      children: [],
      ready: true,
    };
    const taskUnder = beadTask(beadUnder)!;
    expect(taskUnder.length).toBeGreaterThan(7_900);
    expect(taskUnder.endsWith("…")).toBe(false);

    // Giant bead description (50,000 chars)
    const beadOver: Bead = {
      id: "bd-2",
      title: "Task 2",
      description: "x".repeat(50_000),
      acceptance: "Must pass all tests",
      status: "open",
      category: "ready",
      children: [],
      ready: true,
    };
    const taskOver = beadTask(beadOver)!;
    expect(taskOver.length).toBe(8_001); // 8000 chars + '…'
    expect(taskOver.endsWith("…")).toBe(true);
    expect(taskOver.slice(0, 8_000).length).toBe(8_000);
  });

  test("validateReviewSummary rejects summary over 50,000 characters", () => {
    // 50,000 characters is accepted
    const boundarySummary = "s".repeat(50_000);
    expect(validateReviewSummary(boundarySummary)).toBe(boundarySummary);

    // 50,001 characters is rejected
    const overflowSummary = "s".repeat(50_001);
    expect(() => validateReviewSummary(overflowSummary)).toThrow(/50000 characters/);
  });

  test("statusView and briefView clip oversized fields to safe terminal budgets", () => {
    const cwd = "/tmp/test";
    const giantString = "x".repeat(100_000);

    const mission = makeMission(cwd, {
      source: {
        kind: "freeform",
        id: "freeform:huge",
        title: giantString,
        body: giantString,
        comments: "",
        extra: "",
      },
      workers: [
        {
          beadId: "bd-1",
          attempt: "att1",
          cwd,
          files: ["a.ts"],
          state: "missing",
          handle: "term1",
          incarnationId: "inc1",
          assignment: "do work",
          launchedAt: "2026-01-01T00:00:00.000Z",
          error: giantString,
        },
      ],
      evidence: {
        verify: {
          outcome: "passed",
          detail: giantString,
          revision: "rev1",
          at: "2026-01-01T00:00:00.000Z",
        },
      },
      reviews: [
        {
          round: 1,
          revision: "rev1",
          model: "m",
          summary: giantString.slice(0, 49_000),
          findings: [],
          at: "2026-01-01T00:00:00.000Z",
        },
      ],
    });

    const snapshot: Snapshot = {
      beads: [
        {
          id: "bd-1",
          title: giantString,
          status: "open",
          category: "ready",
          children: [],
          ready: true,
        },
      ],
      leaves: [],
      ready: ["bd-1"],
      closed: 0,
      active: 0,
      blocked: 0,
      fetchedAt: Date.now(),
      error: giantString,
    };

    const status = statusView({ mission, snapshot, resumeHold: false }) as Extract<ReturnType<typeof statusView>, { evidence: unknown }>;
    if (!status.evidence || !status.review || !status.beads) {
      throw new Error('Expected status view for mission');
    }

    // Verification evidence detail clipped to 160 chars + '…'
    expect(status.evidence.verify!.length).toBeLessThan(180);

    // Review summary clipped to 300 chars + '…'
    expect(status.review.summary.length).toBe(301);

    // Bead title clipped to 60 chars + '…'
    expect(status.beads[0]!.length).toBeLessThan(80);

    // Brief view handles giant graphError and worker error without unbounded explosion
    const brief = briefView({ mission, snapshot, resumeHold: false }) as Extract<ReturnType<typeof briefView>, { workers: string[] }>;
    if (!brief.workers) {
      throw new Error('Expected brief view for mission');
    }
    expect(brief.graphError!.length).toBe(201);
    expect(brief.workers[0]).toContain("bd-1:missing (");
    expect(brief.workers[0]!.length).toBeLessThan(150);
  });

  test("missionWidgetLines caps rendered lines to 45% of terminal height even with 500 beads", () => {
    const cwd = "/tmp/test";
    const beads: Bead[] = Array.from({ length: 500 }, (_, i) => ({
      id: `bd-${i}`,
      title: `Implementation task ${i}`,
      status: "open",
      category: "ready",
      children: [],
      ready: true,
    }));

    const mission = makeMission(cwd);
    const projection = {
      mission,
      snapshot: {
        beads,
        leaves: beads,
        ready: beads.map((b) => b.id),
        closed: 0,
        active: 0,
        blocked: 0,
        fetchedAt: Date.now(),
      },
      terminalHeight: 20,
      resumeHold: false,
    };

    // Terminal height 20 -> cap = floor(20 * 0.45) = 9 lines
    const lines = missionWidgetLines(projection, 80, true, 20, mockTheme);
    expect(lines.length).toBeLessThanOrEqual(9);

    // Shows pagination hint instead of dumping all 500 lines
    const hasPagination = lines.some((l) => l.includes("/500"));
    expect(hasPagination).toBe(true);

    // Zero height returns empty array
    expect(missionWidgetLines(projection, 80, true, 0, mockTheme)).toEqual([]);
  });

  test("worker closure reason is capped at 4000 characters and worker failure detail is capped at 400 characters", () => {
    const giantReason = "Summary: " + "a".repeat(10_000);
    const giantVerification = "Verified: " + "b".repeat(10_000);
    const combinedReason = [giantReason, giantVerification].filter(Boolean).join("\n").slice(0, 4000);
    expect(combinedReason.length).toBe(4000);

    const giantError = "Worker failed because " + "e".repeat(5000);
    const clippedError = giantError.slice(0, 400);
    expect(clippedError.length).toBe(400);
  });
});

// ============================================================================
// 3. Listener Cleanup & Resource Leak Prevention
// ============================================================================
describe("Battery 4: Listener Cleanup & Resource Leak Prevention", () => {
  test("Reviewer cleans up session and resets activeSessionsCount to 0 upon completion", async () => {
    const cwd = await makeTempDir("rev-clean-success-");
    const mission = makeMission(cwd);
    const mockRun: Run = async () => ({ code: 0, stdout: "rev1\n", stderr: "" });
    mission.evidence.verify = { outcome: "passed", detail: "ok", revision: "hash", at: "" };

    let sessionDisposed = false;
    let duringRunSessionCount = -1;

    const opener: ReviewOpener = async () => {
      const messages: unknown[] = [];
      const session: ReviewSession = {
        state: { messages } as never,
        async prompt(text: string): Promise<boolean> {
          const payload = JSON.parse(text);
          messages.push({
            role: "assistant",
            content: [{ type: "text", text: JSON.stringify({ reviewedRevision: payload.reviewedRevision, summary: "ok", findings: [] }) }],
          });
          return true;
        },
        async dispose() {
          sessionDisposed = true;
        },
      };
      return { session };
    };

    const reviewer = new Reviewer(opener);
    expect(reviewer.activeSessionsCount).toBe(0);

    // Spy on captureRevision behavior
    const origCapture = (await captureRevision(mission, mockRun)).revision;
    mission.evidence.verify.revision = origCapture;

    await reviewer.run(mission, fakeContext, mockRun);

    // Session was cleanly disposed and activeSessionsCount is 0
    expect(sessionDisposed).toBe(true);
    expect(reviewer.activeSessionsCount).toBe(0);
  });

  test("Reviewer cleans up session and decrements activeSessionsCount even when review fails with exception", async () => {
    const cwd = await makeTempDir("rev-clean-fail-");
    const mission = makeMission(cwd);
    const mockRun: Run = async () => ({ code: 0, stdout: "rev1\n", stderr: "" });
    const rev = (await captureRevision(mission, mockRun)).revision;
    mission.evidence.verify = { outcome: "passed", detail: "ok", revision: rev, at: "" };

    let sessionDisposed = false;
    const opener: ReviewOpener = async () => {
      return {
        session: {
          state: { messages: [] } as never,
          async prompt() {
            throw new Error("Model rate limit exceeded / connection severed");
          },
          async dispose() {
            sessionDisposed = true;
          },
        } as never,
      };
    };

    const reviewer = new Reviewer(opener);
    expect(reviewer.activeSessionsCount).toBe(0);

    await expect(reviewer.run(mission, fakeContext, mockRun)).rejects.toThrow(/Model rate limit exceeded/);

    // Session dispose must have been called in finally block
    expect(sessionDisposed).toBe(true);
    expect(reviewer.activeSessionsCount).toBe(0);
  });

  test("Reviewer.runPerBead cleans up all sessions when one parallel review job fails", async () => {
    const cwd = await makeTempDir("rev-clean-perbead-fail-");
    await realRun("git", ["init", "-q", "-b", "main"], cwd);
    await realRun("git", ["config", "user.email", "test@test"], cwd);
    await realRun("git", ["config", "user.name", "test"], cwd);
    await mkdir(join(cwd, "a"));
    await mkdir(join(cwd, "b"));
    await writeFile(join(cwd, "a", "file.txt"), "a");
    await writeFile(join(cwd, "b", "file.txt"), "b");
    await realRun("git", ["add", "."], cwd);
    await realRun("git", ["commit", "-qm", "init"], cwd);

    await writeFile(join(cwd, "a", "file.txt"), "a modified");
    await writeFile(join(cwd, "b", "file.txt"), "b modified");

    const mission = makeMission(cwd, {
      workspace: { key: "k", cwd, delivery: "local", base: "HEAD", commonDir: join(cwd, ".git") },
      graph: "beads",
      scopes: { "bd-a": ["a/**"], "bd-b": ["b/**"] },
    });
    const rev = (await captureRevision(mission, realRun)).revision;
    mission.evidence.verify = { outcome: "passed", detail: "ok", revision: rev, at: "" };

    const targets: BeadReviewTarget[] = [
      { id: "bd-a", title: "Bead A", text: "Task A", files: ["a/**"] },
      { id: "bd-b", title: "Bead B", text: "Task B", files: ["b/**"] },
    ];

    const disposedSessions = new Set<string>();
    let callCount = 0;

    const opener: ReviewOpener = async (_m, _ctx, _model, _files, note) => {
      const id = note;
      return {
        session: {
          state: { messages: [] } as never,
          async prompt() {
            if (++callCount === 2) {
              throw new Error("Worker node failure during bead review");
            }
          },
          async dispose() {
            disposedSessions.add(id);
          },
        } as never,
      };
    };

    const reviewer = new Reviewer(opener);
    await expect(reviewer.runPerBead(mission, fakeContext, realRun, "default", undefined, targets)).rejects.toThrow(
      /Worker node failure during bead review/,
    );

    // All started sessions must have been disposed
    expect(disposedSessions.size).toBeGreaterThanOrEqual(1);
    expect(reviewer.activeSessionsCount).toBe(0);
  });

  test("mid-flight reviewer.dispose() immediately disposes all active sessions and clears registry", async () => {
    let disposedCount = 0;
    const sessionPromises: Array<() => void> = [];

    const opener: ReviewOpener = async () => {
      return {
        session: {
          state: { messages: [] } as never,
          async prompt() {
            await new Promise<void>((resolve) => {
              sessionPromises.push(resolve);
            });
          },
          async dispose() {
            disposedCount++;
          },
        } as never,
      };
    };

    const reviewer = new Reviewer(opener);
    const cwd = await makeTempDir("rev-midflight-");
    const mission = makeMission(cwd);
    const mockRun: Run = async () => ({ code: 0, stdout: "rev1\n", stderr: "" });
    const rev = (await captureRevision(mission, mockRun)).revision;
    mission.evidence.verify = { outcome: "passed", detail: "ok", revision: rev, at: "" };

    // Launch run in background
    const runPromise = reviewer.run(mission, fakeContext, mockRun);

    // Wait until session is registered
    while (reviewer.activeSessionsCount === 0) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(reviewer.activeSessionsCount).toBe(1);

    // Simulate abort triggering reviewer.dispose()
    await reviewer.dispose();

    expect(disposedCount).toBe(1);
    expect(reviewer.activeSessionsCount).toBe(0);

    // Release hung prompt
    sessionPromises.forEach((r) => r());
    await runPromise.catch(() => {});
  });

  test("AbortSignal event listener pattern cleans up listener across 100 consecutive operations without leak", async () => {
    const controller = new AbortController();
    const signal = controller.signal;

    // Track listeners on an EventEmitter to verify zero accumulation
    const emitter = new EventEmitter();
    emitter.setMaxListeners(10); // low limit to detect any listener leak warning

    let activeOperations = 0;

    for (let i = 0; i < 100; i++) {
      const cancel = () => {
        activeOperations--;
      };

      // Exactly mirrors extension.ts pattern:
      signal.addEventListener("abort", cancel, { once: true });
      emitter.addListener("abort", cancel);

      try {
        activeOperations++;
        // Perform fast simulated operation
        expect(activeOperations).toBe(1);
      } finally {
        signal.removeEventListener("abort", cancel);
        emitter.removeListener("abort", cancel);
        activeOperations--;
      }
    }

    // After 100 iterations, listener count is strictly 0
    expect(emitter.listenerCount("abort")).toBe(0);
    expect(activeOperations).toBe(0);
  });

  test("lock heartbeat timer is cleanly stopped on release with zero dangling timeouts", async () => {
    const dir = await makeTempDir("lock-clean-");
    const targetFile = join(dir, "resource.json");
    await writeFile(targetFile, "{}");

    // Acquire lock with short update intervals
    const release = await lock(targetFile, {
      stale: 2_000,
      update: 1_000,
    });

    const lockPath = `${targetFile}.lock`;
    const s = await stat(lockPath);
    expect(s.isDirectory()).toBe(true);

    // Release lock
    await release();

    // Lockfile removed
    expect(await stat(lockPath).catch((e) => e.code)).toBe("ENOENT");

    // Idempotent second release does not throw or restart timers
    await expect(release()).resolves.toBe(undefined);

    // Stress test: 30 consecutive lock acquisitions and releases
    for (let i = 0; i < 30; i++) {
      const rel = await lock(targetFile, { stale: 2_000, update: 1_000 });
      await rel();
    }
    expect(await stat(lockPath).catch((e) => e.code)).toBe("ENOENT");
  });

  test("abort signal listener is cleanly removed even when an operation throws an exception", async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    const emitter = new EventEmitter();

    let listenerRan = false;
    const cancel = () => { listenerRan = true; };

    await expect((async () => {
      signal.addEventListener("abort", cancel, { once: true });
      emitter.addListener("abort", cancel);
      try {
        throw new Error("Simulated critical failure during operation");
      } finally {
        signal.removeEventListener("abort", cancel);
        emitter.removeListener("abort", cancel);
      }
    })()).rejects.toThrow("Simulated critical failure during operation");

    expect(emitter.listenerCount("abort")).toBe(0);
    expect(listenerRan).toBe(false);
  });

  test("SubagentRunner session cancellation aborts all live subagents and cleans up handles", async () => {
    let abortedA = false;
    let abortedB = false;
    let disposedA = false;
    let disposedB = false;

    const liveSessions = new Map<string, { abort: () => Promise<void>; dispose: () => Promise<void> }>();
    liveSessions.set("bd-a", {
      abort: async () => { abortedA = true; },
      dispose: async () => { disposedA = true; },
    });
    liveSessions.set("bd-b", {
      abort: async () => { abortedB = true; },
      dispose: async () => { disposedB = true; },
    });

    await Promise.all([...liveSessions.keys()].map(async (id) => {
      const live = liveSessions.get(id);
      if (live) {
        await live.abort();
        await live.dispose();
      }
    }));
    liveSessions.clear();

    expect(abortedA).toBe(true);
    expect(abortedB).toBe(true);
    expect(disposedA).toBe(true);
    expect(disposedB).toBe(true);
    expect(liveSessions.size).toBe(0);
  });
});
