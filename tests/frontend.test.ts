import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";
import { validateMissionConfig, writeMissionConfig } from "../src/config";
import { fillCommand, parseHerdrIds } from "../src/hosts";
import { workerPrompt } from "../src/prompts";
import type { Bead, Mission, Run } from "../src/types";
import { createWorkerDriver } from "../src/workers";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

function mission(): Mission {
	return {
		version: 1, id: "mission-x",
		source: { kind: "freeform", id: "x", title: "x", body: "", comments: "", extra: "" },
		workspace: { key: "x", cwd: "/tmp/mission-wt", beadsDir: "/tmp/beads", delivery: "local" },
		scopes: { "bd-1": ["src/a.ts"] }, phase: "execute", evidence: {}, mode: "auto", keep: false,
		reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 0,
		createdAt: "", updatedAt: "",
	};
}

function bead(id: string, category: Bead["category"]): Bead {
	return { id, title: id, status: category, children: [], ready: category === "ready", category };
}

test("frontend defaults to none and custom requires a one-line command", () => {
	expect(validateMissionConfig({ version: 1 }).frontend).toBe("none");
	expect(() => validateMissionConfig({ version: 1, frontend: "tmux" })).toThrow("frontend");
	expect(() => validateMissionConfig({ version: 1, frontend: "custom" })).toThrow("customCommand");
	expect(() => validateMissionConfig({ version: 1, frontend: "custom", customCommand: "ok\nrm -rf /" })).toThrow("one line");
	expect(validateMissionConfig({ version: 1, frontend: "herdr" }).frontend).toBe("herdr");
});

test("config write round-trips the chosen frontend", async () => {
	const root = await mkdtemp(join(tmpdir(), "mission-frontend-"));
	roots.push(root);
	const config = validateMissionConfig({ version: 1, frontend: "custom", customCommand: "launcher --cwd {cwd}" });
	await writeMissionConfig(root, config);
	const text = await readFile(join(root, "mission.json"), "utf8");
	expect(JSON.parse(text).frontend).toBe("custom");
	expect(JSON.parse(text).customCommand).toBe("launcher --cwd {cwd}");
});

test("custom placeholders are shell-quoted", () => {
	expect(fillCommand("run {cwd} {prompt}", { cwd: "/tmp/a b", prompt: "it's done" })).toBe("run '/tmp/a b' 'it'\\''s done'");
});

test("herdr create JSON accepts tab and root pane objects", () => {
	expect(parseHerdrIds(JSON.stringify({ result: { tab: { tab_id: "w1:t1" }, root_pane: { pane_id: "w1:p1" } } }))).toEqual({ tabId: "w1:t1", paneId: "w1:p1" });
});

test("herdr dispatch creates a tab, starts omp, then prompts", async () => {
	const calls: string[][] = [];
	const run: Run = async (command, args) => {
		calls.push([command, ...args]);
		if (args[0] === "tab" && args[1] === "create") return { stdout: JSON.stringify({ result: { tab: { tab_id: "w1:t1" }, root_pane: "w1:p1" } }), stderr: "", code: 0 };
		return { stdout: "", stderr: "", code: 0 };
	};
	const current = mission();
	const workers = await createWorkerDriver(run, { persist: async () => {}, frontend: "herdr", prompt: () => "do the thing" }).dispatch(current, ["bd-1"]);
	expect(workers[0]?.handle).toMatch(/^mission-bd-1-/);
	expect(workers[0]?.frontend).toBe("herdr");
	expect(workers[0]?.incarnationId).toBe("w1:t1");
	expect(calls[0]?.slice(0, 2)).toEqual(["herdr", "tab"]);
	expect(calls[0]).toContain("--no-focus");
	expect(calls[0]).toContain("--cwd");
	expect(calls[1]?.slice(0, 3)).toEqual(["herdr", "agent", "start"]);
	expect(calls[1]).toContain("--kind");
	expect(calls[1]).toContain("omp");
	expect(calls[1]).toContain("w1:p1");
	expect(calls[2]?.slice(0, 3)).toEqual(["herdr", "agent", "prompt"]);
	expect(calls[2]).toContain("do the thing");
	expect(workerPrompt(current, workers[0]!, "herdr")).toContain("Do not close the Herdr tab");
	expect(workerPrompt(current, workers[0]!, "herdr")).not.toContain("orca terminal close");
});

test("none dispatch backgrounds omp and refuses resend", async () => {
	const calls: string[][] = [];
	const run: Run = async (command, args) => {
		calls.push([command, ...args]);
		return { stdout: "4242\n", stderr: "", code: 0 };
	};
	const current = mission();
	const [worker] = await createWorkerDriver(run, { persist: async () => {}, frontend: "none", prompt: () => "do the thing" }).dispatch(current, ["bd-1"]);
	expect(calls[0]?.[0]).toBe("bash");
	expect(calls[0]?.[2]).toContain("omp -p");
	expect(calls[0]?.[2]).toContain("BEADS_ACTOR='bd-1'");
	expect(worker?.handle).toBe("4242");
	const driver = createWorkerDriver(run, { persist: async () => {}, frontend: "none" });
	await expect(driver.resend(current, "bd-1", bead("bd-1", "ready"))).rejects.toThrow("no terminal to resend");
});

test("custom dispatch runs the template and requires JSON", async () => {
	const calls: string[][] = [];
	const run: Run = async (_command, args) => {
		calls.push(args);
		return { stdout: JSON.stringify({ handle: "job-9", incarnationId: "job-9" }), stderr: "", code: 0 };
	};
	const current = mission();
	const [worker] = await createWorkerDriver(run, {
		persist: async () => {},
		frontend: "custom",
		customCommand: "launcher --cwd {cwd} --bead {bead}",
		prompt: () => "do the thing",
	}).dispatch(current, ["bd-1"]);
	expect(calls[0]?.[0]).toBe("-lc");
	expect(calls[0]?.[1]).toContain("launcher --cwd '/tmp/mission-wt' --bead 'bd-1'");
	expect(worker?.handle).toBe("job-9");
	const broken: Run = async () => ({ stdout: "started", stderr: "", code: 0 });
	await expect(createWorkerDriver(broken, { persist: async () => {}, frontend: "custom", customCommand: "launcher", prompt: () => "x" }).dispatch(mission(), ["bd-1"])).rejects.toThrow("JSON");
});
