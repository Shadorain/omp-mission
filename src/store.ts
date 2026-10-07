import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, readdir, realpath, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, resolve, join } from "node:path";
import { lock } from "./lock";
import { isRecord, isNonNegativeSafeInteger, isPositiveSafeInteger } from "./guards";
import type { Evidence, Finding, Frontend, Mission, Mode, Phase, Source, Workspace } from "./types";

const MAX_STATE_BYTES = 5_000_000;
const MODES: Mode[] = ["auto", "pause", "force"];
const PHASES: Phase[] = ["plan", "isolate", "graph", "execute", "verify", "deliver", "review", "repair", "complete"];
const EVIDENCE_OUTCOMES = ["pending", "active", "passed", "failed", "skipped"] as const;

function invalid(message: string): never { throw new Error(`Invalid mission state: ${message}`); }
function workerFrontend(value: unknown, index: number): Frontend {
  if (value === "none" || value === "orca" || value === "herdr" || value === "custom" || value === "subagent") return value;
  invalid(`workers[${index}].frontend is unsupported`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) invalid(`${label} must be an object`);
  return value;
}
function text(value: unknown, label: string, max = 100_000): string {
  if (typeof value !== "string" || value.trim() === "" || value.length > max) invalid(`${label} must be non-empty text up to ${max} characters`);
  return value;
}
function optionalText(value: unknown, label: string, max = 100_000): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label, max);
}
function stringArray(value: unknown, label: string, max = 100_000): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length > max)) invalid(`${label} must be an array of strings`);
  return value as string[];
}
function content(value: unknown, label: string, max = 1_000_000): string {
  if (typeof value !== "string" || value.length > max) invalid(`${label} must be text up to ${max} characters`);
  return value;
}

export function validateReviewSummary(value: unknown): string {
  return text(value, "review.summary", 50_000);
}

export function validateFinding(value: unknown): Finding {
  const row = object(value, "finding");
  const severity = row.severity;
  if (severity !== "critical" && severity !== "high" && severity !== "medium" && severity !== "low") invalid("finding.severity is unsupported");
  const line = row.line;
  if (!isPositiveSafeInteger(line)) invalid("finding.line must be a positive integer");
  return { id: text(row.id, "finding.id", 1000), severity, path: text(row.path, "finding.path", 4000), line, title: text(row.title, "finding.title", 10_000), body: text(row.body, "finding.body", 50_000), ...(row.rejection === undefined ? {} : { rejection: text(row.rejection, "finding.rejection", 10_000) }), ...(row.beadId === undefined ? {} : { beadId: text(row.beadId, "finding.beadId", 1000) }) };
}

function validSource(value: unknown): Source {
  const row = object(value, "source");
  if (row.kind !== "linear" && row.kind !== "github" && row.kind !== "freeform") invalid("source.kind is unsupported");
  const source: Source = { kind: row.kind, id: text(row.id, "source.id", 1000), title: text(row.title, "source.title", 10_000), body: content(row.body, "source.body"), comments: content(row.comments, "source.comments", 100_000), extra: content(row.extra, "source.extra", 100_000) };
  const url = optionalText(row.url, "source.url", 4000);
  const repo = optionalText(row.repo, "source.repo", 1000);
  if (url !== undefined) source.url = url;
  if (repo !== undefined) source.repo = repo;
  if (row.number !== undefined) {
    const num = row.number;
    if (!isPositiveSafeInteger(num)) invalid("source.number must be a positive integer");
    source.number = num;
  }
  if (source.kind === "github" && (!source.repo || source.number === undefined)) invalid("GitHub source requires repo and number");
  return source;
}
function validWorkspace(value: unknown): Workspace {
  const row = object(value, "workspace");
  if (row.delivery !== "pr" && row.delivery !== "local") invalid("workspace.delivery is unsupported");
  const key = text(row.key, "workspace.key", 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) invalid("workspace.key contains unsafe path characters");
  const workspace: Workspace = { key, cwd: text(row.cwd, "workspace.cwd", 4000), delivery: row.delivery };
  for (const field of ["commonDir", "branch", "base", "beadsDir"] as const) {
    const item = optionalText(row[field], `workspace.${field}`, 4000);
    if (item !== undefined) workspace[field] = item;
  }
  return workspace;
}
export function validateMission(value: unknown): Mission {
  const row = object(value, "root");
  if (row.version !== 1) invalid("version must be 1");
  if (!PHASES.includes(row.phase as Phase)) invalid("phase is unsupported");
  if (!MODES.includes(row.mode as Mode)) invalid("mode is unsupported");
  if (typeof row.keep !== "boolean" || typeof row.reviewRequested !== "boolean") invalid("keep and reviewRequested must be booleans");
  if (!Array.isArray(row.workers) || !Array.isArray(row.reviews)) invalid("workers and reviews must be arrays");
  const evidence: Mission["evidence"] = {};
  const rawEvidence = object(row.evidence, "evidence");
  for (const [key, raw] of Object.entries(rawEvidence)) {
    if (!PHASES.includes(key as Phase)) invalid(`unsupported evidence phase ${key}`);
    const item = object(raw, `evidence.${key}`);
    if (!(EVIDENCE_OUTCOMES as readonly unknown[]).includes(item.outcome)) invalid(`evidence.${key}.outcome is unsupported`);
    evidence[key as Phase] = { outcome: item.outcome as Evidence["outcome"], detail: content(item.detail, `evidence.${key}.detail`, 50_000), at: text(item.at, `evidence.${key}.at`, 100), ...(item.revision === undefined ? {} : { revision: text(item.revision, `evidence.${key}.revision`, 1000) }) };
  }
  const scopesRow = object(row.scopes, "scopes");
  const scopes: Record<string, string[]> = {};
  for (const [id, paths] of Object.entries(scopesRow)) scopes[text(id, "scope bead ID", 1000)] = stringArray(paths, `scope ${id}`, 4000);
  const workers: Mission["workers"] = row.workers.map((raw, index) => {
    const item = object(raw, `workers[${index}]`);
    if (!["reserved", "starting", "awaiting-claim", "running", "closed", "missing"].includes(String(item.state))) invalid(`workers[${index}].state is unsupported`);
    return { beadId: text(item.beadId, "worker.beadId", 1000), attempt: text(item.attempt, "worker.attempt", 100), cwd: text(item.cwd, "worker.cwd", 4000), files: stringArray(item.files, "worker.files", 4000), state: item.state as Mission["workers"][number]["state"], assignment: text(item.assignment, "worker.assignment", 100_000), ...(item.handle === undefined ? {} : { handle: text(item.handle, "worker.handle", 1000) }), ...(item.incarnationId === undefined ? {} : { incarnationId: text(item.incarnationId, "worker.incarnationId", 1000) }), ...(item.error === undefined ? {} : { error: text(item.error, "worker.error", 10_000) }), ...(item.frontend === undefined ? {} : { frontend: workerFrontend(item.frontend, index) }), ...(item.launchedAt === undefined ? {} : { launchedAt: text(item.launchedAt, "worker.launchedAt", 100) }) };
  });
  const reviews: Mission["reviews"] = row.reviews.map((raw, index) => {
    const item = object(raw, `reviews[${index}]`);
    const round = item.round;
    if (!isPositiveSafeInteger(round) || !Array.isArray(item.findings)) invalid(`reviews[${index}] is invalid`);
    return { round, revision: text(item.revision, "review.revision", 1000), model: text(item.model, "review.model", 1000), summary: text(item.summary, "review.summary", 50_000), findings: item.findings.map(validateFinding), at: text(item.at, "review.at", 100), ...(item.invalidated === undefined ? {} : { invalidated: text(item.invalidated, "review.invalidated", 10_000) }), ...(item.beads === undefined ? {} : { beads: Object.fromEntries(Object.entries(object(item.beads, "review.beads")).map(([id, hash]) => [text(id, "review.beads id", 1000), text(hash, "review.beads hash", 200)])) }) };
  });
  const repairLinksRow = object(row.repairLinks, "repairLinks");
  const repairLinks: Record<string, string[]> = {};
  for (const [id, linked] of Object.entries(repairLinksRow)) repairLinks[text(id, "repair bead ID", 1000)] = stringArray(linked, `repair links ${id}`, 1000);
  let gate: Mission["gate"];
  if (row.gate !== undefined) {
    const item = object(row.gate, "gate");
    if (!["wave", "review", "repairs"].includes(String(item.kind)) || typeof item.approved !== "boolean") invalid("gate is invalid");
    gate = { kind: item.kind as NonNullable<Mission["gate"]>["kind"], token: text(item.token, "gate.token", 1000), detail: text(item.detail, "gate.detail", 20_000), approved: item.approved };
  }
  const round = row.round;
  if (!isNonNegativeSafeInteger(round)) invalid("round must be a non-negative integer");
  const missionId = text(row.id, "id", 1000);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(missionId)) invalid("id contains unsafe path characters");
  const mission: Mission = { version: 1, id: missionId, source: validSource(row.source), workspace: validWorkspace(row.workspace), scopes, phase: row.phase as Phase, evidence, mode: row.mode as Mode, keep: row.keep, reviewRequested: row.reviewRequested, workers, reviews, repairLinks, round, createdAt: text(row.createdAt, "createdAt", 100), updatedAt: text(row.updatedAt, "updatedAt", 100) };
  const epicId = optionalText(row.epicId, "epicId", 1000);
  const controllerNonce = optionalText(row.controllerNonce, "controllerNonce", 100);
  const blocker = optionalText(row.blocker, "blocker", 20_000);
  if (epicId !== undefined) mission.epicId = epicId;
  if (row.graph !== undefined) {
    if (row.graph !== "local" && row.graph !== "beads") invalid("graph must be local or beads");
    mission.graph = row.graph;
  }
  if (controllerNonce !== undefined) mission.controllerNonce = controllerNonce;
  if (blocker !== undefined) mission.blocker = blocker;
  if (gate) mission.gate = gate;
  return mission;
}

export async function workspaceKey(identityPath: string): Promise<string> {
  const canonical = await realpath(identityPath);
  return createHash("sha256").update(canonical).digest("hex").slice(0, 24);
}
export function missionDirectory(agentDir: string, key: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key) || key.includes("..")) throw new Error("Invalid mission workspace key");
  return join(agentDir, "missions", key);
}
export function missionId(source: Source): string {
  const hash = createHash("sha256").update(source.id).digest("hex").slice(0, 8);
  const slug = source.id.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
  return slug ? `${slug}-${hash}` : hash;
}
export function missionPath(agentDir: string, mission: Pick<Mission, "id" | "workspace">): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(mission.id)) throw new Error("Invalid mission ID");
  return join(missionDirectory(agentDir, mission.workspace.key), `${mission.id}.json`);
}

export async function atomicWriteMission(path: string, value: unknown): Promise<Mission> {
  const mission = validateMission(value);
  const target = resolve(path);
  if (basename(target) !== `${mission.id}.json` || basename(dirname(target)) !== mission.workspace.key) throw new Error("Mission state path does not match mission identity");
  const serialized = `${JSON.stringify(mission, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > MAX_STATE_BYTES) invalid(`state exceeds ${MAX_STATE_BYTES} bytes`);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(target), `.${mission.id}.${randomBytes(12).toString("hex")}.tmp`);
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, 0o600);
    await rename(temporary, target);
    const directory = await open(dirname(target), "r");
    try { await directory.sync(); } finally { await directory.close(); }
    return mission;
  } catch (error) {
    if (handle) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
export async function saveMission(path: string, mission: Mission): Promise<Mission> { return atomicWriteMission(path, mission); }
export async function loadMission(path: string): Promise<Mission> {
  let data: Buffer;
  try { data = await readFile(path); }
  catch (error) { throw new Error(`Cannot read mission state at ${path}: ${String(error)}`); }
  if (data.byteLength > MAX_STATE_BYTES) invalid(`state exceeds ${MAX_STATE_BYTES} bytes`);
  try { return validateMission(JSON.parse(data.toString("utf8"))); }
  catch (error) { throw new Error(`Cannot load mission state at ${path}: ${String(error)}`); }
}
export async function listMissions(agentDir: string, key?: string): Promise<Array<{ path: string; mission: Mission }>> {
  const root = join(agentDir, "missions");
  let workspaces: string[];
  try { workspaces = key ? [key] : (await readdir(root, { withFileTypes: true })).filter((item) => item.isDirectory()).map((item) => item.name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const result: Array<{ path: string; mission: Mission }> = [];
  for (const workspace of workspaces) {
    const directory = missionDirectory(agentDir, workspace);
    let names: string[];
    try { names = await readdir(directory); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      const path = join(directory, name);
      const mission = await loadMission(path);
      if (mission.workspace.key !== workspace || `${mission.id}.json` !== name) invalid(`state path does not match mission identity: ${path}`);
      result.push({ path, mission });
    }
  }
  return result;
}

export interface Ownership {
  nonce: string;
  mission: Mission;
  assertOwned(): Promise<void>;
  release(): Promise<void>;
}
export async function acquireOwnership(
  path: string,
  mission: Mission,
  onCompromised: (error: Error) => void = () => undefined,
): Promise<Ownership> {
  const target = resolve(path);
  const input = validateMission(mission);
  if (basename(target) !== `${input.id}.json` || basename(dirname(target)) !== input.workspace.key) throw new Error("Mission ownership path does not match mission identity");
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  try {
    const file = await open(target, "wx", 0o600);
    await file.close();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  let compromised = false;
  const releaseLock = await lock(target, {
    realpath: false,
    stale: 30_000,
    update: 10_000,
    retries: 0,
    onCompromised(error) {
      compromised = true;
      onCompromised(error);
    },
  }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ELOCKED") throw Object.assign(new Error("Another OMP session controls this mission. If that session crashed, its lock expires after 30 seconds: retry /mission continue then."), { code: "ELOCKED" });
    throw error;
  });
  const nonce = randomUUID();
  let ownedMission: Mission;
  try {
    const current = (await stat(target)).size === 0 ? input : await loadMission(target);
    if (current.source.id !== input.source.id || current.workspace.key !== input.workspace.key) invalid("ownership target contains a different mission source identity");
    ownedMission = await saveMission(target, { ...current, controllerNonce: nonce });
  } catch (error) {
    await releaseLock();
    throw error;
  }
  let released = false;
  return {
    nonce,
    mission: ownedMission,
    async assertOwned() {
      if (released || compromised) throw new Error("Mission controller ownership lost");
      const current = await loadMission(target);
      if (current.controllerNonce !== nonce) throw new Error("Mission controller nonce changed");
    },
    async release() {
      if (released) return;
      released = true;
      try {
        if (!compromised) {
          const current = await loadMission(target);
          if (current.controllerNonce === nonce) {
            const { controllerNonce: _nonce, ...withoutNonce } = current;
            await saveMission(target, withoutNonce as Mission);
          }
        }
      } finally {
        if (!compromised) await releaseLock();
      }
    },
  };
}

