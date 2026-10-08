import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readMissionConfig, resolveAgentDir, validateMissionConfig } from "../src/config";
import { assertSourceCheckout, fetchSource, inferMissionSource, inspectWorkspace, parseMissionInput } from "../src/sources";
import { acquireOwnership, loadMission, missionPath, saveMission, workspaceKey } from "../src/store";
import type { Mission, Run } from "../src/types";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function temp(): Promise<string> { const root = await mkdtemp(join(tmpdir(), "omp-mission-")); roots.push(root); return root; }
function mission(workspace: Mission["workspace"]): Mission {
  return { version: 1, id: "linear-chr-42", source: { kind: "linear", id: "linear:CHR-42", title: "Fix", body: "", comments: "", extra: "" }, workspace, scopes: {}, phase: "plan", evidence: {}, mode: "auto", keep: false, reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" };
}
const noRun: Run = async (command, args) => ({ stdout: "", stderr: `${command} ${args.join(" ")} unavailable`, code: 1 });

describe("mission input and source resolution", () => {
  test("parses flags before source and preserves freeform text only after delimiter", () => {
    expect(parseMissionInput("--force --pause --keep CHR-42 please fix it")).toEqual({ force: true, pause: true, keep: true, source: "CHR-42", extra: "please fix it" });
    expect(parseMissionInput("-f -- --pause preserve literally")).toEqual({ force: true, pause: false, keep: false, freeform: "--pause preserve literally", extra: "" });
    expect(() => parseMissionInput("--")).toThrow("must not be empty");
    expect(() => parseMissionInput("--wat")).toThrow("Unknown mission option");
  });
  test("constructs freeform source with stable caller-provided identity", async () => {
    const parsed = parseMissionInput("-- improve the migration path");
    const source = await fetchSource(parsed, "/workspace", noRun, { freeformId: "stable-id" });
    expect(source).toMatchObject({ kind: "freeform", id: "freeform:stable-id", title: "improve the migration path", body: "improve the migration path" });
  });

  test("fetches GitHub URL and shorthand through read-only CLI calls and retains full body", async () => {
    const calls: string[][] = [];
    const run: Run = async (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "issue") {
        const number = Number(args[2]);
        return { stdout: JSON.stringify({ number, title: "Bug", body: "full issue requirements", url: `https://github.com/acme/app/issues/${number}`, comments: [{ body: "clarification" }] }), stderr: "", code: 0 };
      }
      return { stdout: JSON.stringify({ nameWithOwner: "acme/app", defaultBranchRef: { name: "trunk" } }), stderr: "", code: 0 };
    };
    const source = await fetchSource(parseMissionInput("https://github.com/acme/app/issues/9 extra"), "/repo", run);
    expect(source).toMatchObject({ kind: "github", id: "github:acme/app#9", title: "Bug", body: "full issue requirements", comments: "1. clarification", repo: "acme/app", number: 9 });
    expect(calls.some((call) => call[1] === "issue" && call.includes("--repo"))).toBe(true);
    expect(calls.every((call) => call[0] === "gh")).toBe(true);
    expect((await fetchSource(parseMissionInput("acme/app#10"), "/repo", run)).number).toBe(10);
  });

  test("requires repository resolution for numeric GitHub shorthand and preserves Linear comments with truncation notice", async () => {
    let calls = 0;
    const linearRun: Run = async () => {
      calls++;
      return { stdout: JSON.stringify({ issue: { identifier: "CHR-42", title: "Issue", description: "body", comments: { nodes: Array.from({ length: 9 }, (_, i) => ({ body: `comment-${i}` })) } } }), stderr: "", code: 0 };
    };
    const issue = await fetchSource(parseMissionInput("chr-42"), "/repo", linearRun);
    expect(issue.comments).toContain("comment-7");
    expect(issue.comments).toContain("Comments truncated");
    expect(issue.id).toBe("linear:CHR-42");
    expect(calls).toBe(1);
    await expect(fetchSource(parseMissionInput("123"), "/repo", noRun)).rejects.toThrow("gh repo view");
  });

  test("infers only explicit issue patterns and surfaces multiple checkout identifiers", async () => {
    const root = await temp();
    await mkdir(join(root, ".git"));
    const run: Run = async (_command, args) => {
      if (args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: root, stderr: "", code: 0 };
      if (args[0] === "rev-parse" && args[1] === "--git-common-dir") return { stdout: ".git", stderr: "", code: 0 };
      if (args[0] === "branch") return { stdout: "feature/CHR-1-CHR-2", stderr: "", code: 0 };
      if (args[0] === "repo" && args[1] === "view") return { stdout: JSON.stringify({ nameWithOwner: "acme/app" }), stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 1 };
    };
    const savedWorkspace = { key: "different", cwd: root, delivery: "pr" as const };
    const inferred = await inferMissionSource(root, run, [{ path: "/saved/one.json", source: mission(savedWorkspace).source, workspace: savedWorkspace }]);
    expect(inferred.ambiguous).toEqual(["CHR-1", "CHR-2"]);
    const workspace = await inspectWorkspace(root, async (command, args) => args[0] === "rev-parse" && args[1] === "--show-toplevel" ? { stdout: "", stderr: "not git", code: 128 } : noRun(command, args, root));
    expect(workspace.delivery).toBe("local");
    const githubRun: Run = async (_command, args) => {
      if (args[0] === "branch") return { stdout: "gh-77", stderr: "", code: 0 };
      if (args[0] === "repo" && args[1] === "view") return { stdout: JSON.stringify({ nameWithOwner: "acme/app" }), stderr: "", code: 0 };
      return run(_command, args, root);
    };
    expect(await inferMissionSource(root, githubRun, [])).toMatchObject({ source: "acme/app#77", ambiguous: [] });
    const multipleGithub: Run = async (_command, args) => args[0] === "branch" ? { stdout: "gh-77-issue-78", stderr: "", code: 0 } : githubRun(_command, args, root);
    expect((await inferMissionSource(root, multipleGithub, [])).ambiguous).toEqual(["gh-77", "issue-78"]);
    expect((await inferMissionSource(root, async (_command, args) => args[0] === "branch" ? { stdout: "feature/123", stderr: "", code: 0 } : githubRun(_command, args, root), [])).source).toBeUndefined();
    expect(() => assertSourceCheckout(mission({ key: "x", cwd: root, branch: "work/CHR-1", delivery: "pr" }).source, { key: "x", cwd: root, branch: "work/CHR-2", delivery: "pr" })).toThrow("This checkout belongs to CHR-2");
  });
});

describe("mission configuration", () => {
  test("reports malformed mission configuration rather than falling back", async () => {
    const root = await temp();
    await writeFile(join(root, "mission.json"), "{");
    await expect(readMissionConfig(root)).rejects.toThrow("Invalid JSON in mission configuration");
  });

  test("rejects invalid worker bounds and duplicate shortcut chords", () => {
    expect(() => validateMissionConfig({ version: 1, maxWorkers: 0 })).toThrow("maxWorkers");
    expect(() => validateMissionConfig({ version: 1, keys: { expand: "alt+g", fullscreen: "ALT+G", mode: null } })).toThrow("distinct");
    expect(() => validateMissionConfig({ version: 1, keys: { expand: "g", fullscreen: null, mode: null } })).toThrow("valid key chord");
    expect(validateMissionConfig({ version: 1, keys: { expand: null, fullscreen: null, mode: null } }).keys.expand).toBeNull();
  });
});

describe("durable mission state and ownership", () => {
  test("atomically persists valid state with restrictive permissions and rejects corrupt versions", async () => {
    const root = await temp();
    const workspace = { key: "workspace-hash", cwd: root, delivery: "local" as const };
    const path = missionPath(root, { id: mission(workspace).id, workspace });
    await saveMission(path, mission(workspace));
    expect((await loadMission(path)).source.id).toBe("linear:CHR-42");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await writeFile(path, JSON.stringify({ version: 7 }));
    await expect(loadMission(path)).rejects.toThrow("version must be 1");
  });

  test("canonicalizes worktree identity and excludes concurrent controllers until release", async () => {
    const root = await temp();
    const workspace = { key: await workspaceKey(root), cwd: root, delivery: "local" as const };
    const path = missionPath(root, { id: mission(workspace).id, workspace });
    const persisted = { ...mission(workspace), mode: "pause" as const };
    await saveMission(path, persisted);
    const first = await acquireOwnership(path, mission(workspace));
    expect(first.mission.mode).toBe("pause");
    await first.assertOwned();
    await expect(acquireOwnership(path, mission(workspace))).rejects.toThrow();
    await saveMission(path, { ...first.mission, controllerNonce: "replaced-controller" });
    await expect(first.assertOwned()).rejects.toThrow("nonce changed");
    await first.release();
    expect((await loadMission(path)).controllerNonce).toBe("replaced-controller");
    const second = await acquireOwnership(path, mission(workspace));
    expect(second.mission.mode).toBe("pause");
    await second.assertOwned();
    await second.release();
    expect((await loadMission(path)).controllerNonce).toBeUndefined();
  });

  test("takes over a stale proper-lockfile lock", async () => {
    const root = await temp();
    const workspace = { key: "stale", cwd: root, delivery: "local" as const };
    const path = missionPath(root, { id: mission(workspace).id, workspace });
    await saveMission(path, mission(workspace));
    const staleLock = `${path}.lock`;
    await mkdir(staleLock);
    const old = new Date(Date.now() - 60_000);
    await utimes(staleLock, old, old);
    const owner = await acquireOwnership(path, mission(workspace));
    await owner.assertOwned();
    await owner.release();
  });
});
