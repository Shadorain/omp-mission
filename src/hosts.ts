import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Mission, Run, Source, Worker } from "./types.ts";

export interface SpawnedSession { handle: string; incarnationId: string }

function record(value: unknown): Record<string, unknown> | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	return value as Record<string, unknown>;
}

function text(value: unknown, ...keys: string[]): string | undefined {
	if (typeof value === "string" && value) return value;
	const row = record(value);
	if (!row) return undefined;
	for (const key of keys) {
		const item = row[key];
		if (typeof item === "string" && item) return item;
	}
	return undefined;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function fail(result: { code: number; stderr: string; stdout: string }, label: string): void {
	if (result.code === 0) return;
	throw new Error(result.stderr.trim() || result.stdout.trim() || `${label} failed (${result.code})`);
}

export function parseHerdrIds(stdout: string): { tabId: string; paneId: string } {
	let payload: unknown;
	try { payload = JSON.parse(stdout); }
	catch { throw new Error("herdr tab create returned invalid JSON"); }
	const result = record(record(payload)?.result) ?? record(payload);
	const tabId = text(result?.tab, "tab_id", "id") ?? text(result, "tab_id");
	const paneId = text(result?.root_pane, "pane_id", "id") ?? text(result, "pane_id");
	if (!tabId || !paneId) throw new Error("herdr tab create omitted tab or root pane id");
	return { tabId, paneId };
}

export function agentName(worker: Worker): string {
	const bead = worker.beadId.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
	const suffix = worker.attempt.replace(/-/g, "").slice(0, 6);
	return `mission-${bead || "worker"}-${suffix}`;
}

export function fillCommand(template: string, vars: Record<string, string>): string {
	return template.replace(/\{(cwd|title|command|bead|prompt|handle)\}/g, (token, key: string) => {
		if (!(key in vars)) throw new Error(`custom command placeholder ${token} is not available`);
		return shellQuote(vars[key] ?? "");
	});
}

export async function writePromptFile(worker: Worker): Promise<string> {
	if (!worker.assignment) throw new Error(`worker prompt missing for ${worker.beadId}`);
	const name = agentName(worker);
	const dir = join(tmpdir(), "omp-mission-workers");
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const promptFile = join(dir, `${name}.prompt`);
	await writeFile(promptFile, worker.assignment, { mode: 0o600 });
	return promptFile;
}

function renderSource(s: Source): string {
	const lines = [`${s.id}: ${s.title}`];
	if (s.url) lines.push(`URL: ${s.url}`);
	if (s.body) lines.push(`Body:\n${s.body}`);
	if (s.comments) lines.push(`Comments:\n${s.comments}`);
	if (s.extra) lines.push(`Extra:\n${s.extra}`);
	return lines.join("\n\n");
}

const WORKER_DIR = join(tmpdir(), "omp-mission-workers");

export function sourceFilePath(mission: Pick<Mission, "id">): string {
	return join(WORKER_DIR, `${mission.id}.source.md`);
}

// The ticket is identical for every worker of a mission, so it lives in one file
// they read on demand instead of being pasted into every assignment.
export async function writeSourceFile(mission: Pick<Mission, "id" | "source">): Promise<string> {
	await mkdir(WORKER_DIR, { recursive: true, mode: 0o700 });
	const file = sourceFilePath(mission);
	await writeFile(file, renderSource(mission.source), { mode: 0o600 });
	return file;
}
export async function spawnHerdr(run: Run, mission: Mission, worker: Worker, agentDir?: string): Promise<SpawnedSession> {
	const name = agentName(worker);
	const env = [
		"--env", "OMP_MISSION_WORKER=1",
		"--env", `BEADS_ACTOR=${worker.beadId}`,
		...(mission.workspace.beadsDir ? ["--env", `BEADS_DIR=${mission.workspace.beadsDir}`] : []),
		...(agentDir ? ["--env", `PI_CODING_AGENT_DIR=${agentDir}`] : []),
	];
	const created = await run("herdr", ["tab", "create", "--cwd", worker.cwd, "--label", name, "--no-focus", ...env], worker.cwd);
	fail(created, "herdr tab create");
	const ids = parseHerdrIds(created.stdout);
	const started = await run("herdr", ["agent", "start", name, "--kind", "omp", "--pane", ids.paneId, "--timeout", "30000"], worker.cwd);
	if (started.code !== 0) {
		await run("herdr", ["tab", "close", ids.tabId], worker.cwd);
		fail(started, "herdr agent start");
	}
	return { handle: name, incarnationId: ids.tabId };
}


export async function spawnBackground(run: Run, mission: Mission, worker: Worker, agentDir?: string, model?: string): Promise<SpawnedSession> {
	const promptFile = await writePromptFile(worker);
	const logFile = join(join(tmpdir(), "omp-mission-workers"), `${agentName(worker)}.log`);
	const script = [
		"export OMP_MISSION_WORKER=1",
		`export BEADS_ACTOR=${shellQuote(worker.beadId)}`,
		...(mission.workspace.beadsDir ? [`export BEADS_DIR=${shellQuote(mission.workspace.beadsDir)}`] : []),
		...(agentDir ? [`export PI_CODING_AGENT_DIR=${shellQuote(agentDir)}`] : []),
		`omp${model ? ` --model ${shellQuote(model)}` : ""} -p "$(cat ${shellQuote(promptFile)})" >${shellQuote(logFile)} 2>&1 & echo $!`,
	].join("; ");
	const result = await run("bash", ["-c", script], worker.cwd);
	fail(result, "background omp");
	const pid = result.stdout.trim();
	if (!/^\d+$/.test(pid)) throw new Error(`background omp did not print a pid: ${pid || result.stderr}`);
	return { handle: pid, incarnationId: logFile };
}


export async function spawnCustom(run: Run, mission: Mission, worker: Worker, template: string, launch: string): Promise<SpawnedSession> {
	const command = fillCommand(template, {
		cwd: worker.cwd,
		title: `mission-${worker.beadId}`,
		command: launch,
		bead: worker.beadId,
		prompt: worker.assignment,
		handle: "",
	});
	const result = await run("bash", ["-lc", command], worker.cwd);
	fail(result, "custom frontend");
	let payload: unknown;
	try { payload = JSON.parse(result.stdout); }
	catch { throw new Error("custom frontend must print JSON { handle, incarnationId }"); }
	const row = record(record(payload)?.result) ?? record(payload);
	const terminal = record(row?.terminal) ?? row;
	const handle = text(terminal, "handle", "id");
	const incarnationId = text(terminal, "incarnationId", "incarnation_id") ?? handle;
	if (!handle || !incarnationId) throw new Error("custom frontend JSON omitted handle");
	return { handle, incarnationId };
}
