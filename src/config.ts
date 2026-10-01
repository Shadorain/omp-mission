import { homedir } from "node:os";
import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import type { Frontend, Graph, MissionConfig } from "./types";
import { isRecord } from "./guards";

export const DEFAULT_MISSION_CONFIG: MissionConfig = {
  version: 1,
  controls: false,
  maxWorkers: 2,
  frontend: "none",
  graph: "local",
  keys: { expand: "ctrl+shift+m", fullscreen: "ctrl+shift+f", mode: "ctrl+shift+o" },
};

const FRONTENDS = new Set<Frontend>(["none", "orca", "herdr", "custom"]);
const GRAPHS = new Set<Graph>(["local", "beads"]);
function isFrontend(v: unknown): v is Frontend {
	return typeof v === "string" && FRONTENDS.has(v as Frontend);
}
function isGraph(v: unknown): v is Graph {
	return typeof v === "string" && GRAPHS.has(v as Graph);
}

export function resolveAgentDir(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  return env.PI_CODING_AGENT_DIR?.trim() || env.OMP_AGENT_DIR?.trim() || join(home, ".omp", "agent");
}

function validChord(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 48) return false;
  const parts = value.toLowerCase().split("+");
  const key = parts.pop();
  if (!key || !/^[a-z0-9][a-z0-9_-]*$/.test(key)) return false;
  const modifiers: Record<string, true> = { alt: true, ctrl: true, shift: true, meta: true };
  return parts.length > 0 && parts.every((part, index) => modifiers[part] === true && parts.indexOf(part) === index);
}

export function validateMissionConfig(value: unknown, path = "mission.json"): MissionConfig {
  const fail = (message: string): never => { throw new Error(`Invalid mission configuration at ${path}: ${message}`); };
  if (!isRecord(value)) return fail("expected a JSON object");
  if (value.version !== 1) return fail("version must be 1");
  if (value.controls !== undefined && typeof value.controls !== "boolean") return fail("controls must be boolean");
  const maxWorkers = value.maxWorkers === undefined ? 2 : value.maxWorkers;
  if (typeof maxWorkers !== "number" || !Number.isInteger(maxWorkers) || maxWorkers < 1 || maxWorkers > 8) return fail("maxWorkers must be an integer from 1 through 8");
  const keys = value.keys === undefined ? DEFAULT_MISSION_CONFIG.keys : value.keys;
  if (!isRecord(keys)) return fail("keys must be an object");
  const normalized: Record<"expand" | "fullscreen" | "mode", string | null> = { expand: null, fullscreen: null, mode: null };
  for (const name of ["expand", "fullscreen", "mode"] as const) {
    const chord = keys[name] === undefined ? DEFAULT_MISSION_CONFIG.keys[name] : keys[name];
    if (chord !== null && !validChord(chord)) return fail(`keys.${name} must be a valid key chord or null`);
    normalized[name] = chord === null ? null : chord.toLowerCase();
  }
  const enabled = Object.values(normalized).filter((key): key is string => key !== null);
  if (new Set(enabled).size !== enabled.length) return fail("enabled shortcut chords must be distinct");
  const frontend = value.frontend === undefined ? "none" : value.frontend;
  if (typeof frontend !== "string" || !isFrontend(frontend)) return fail("frontend must be none, orca, herdr, or custom");
  const graph = value.graph === undefined ? "local" : value.graph;
  if (typeof graph !== "string" || !isGraph(graph)) return fail("graph must be local or beads");
  const customCommand = typeof value.customCommand === "string" ? value.customCommand.trim() : undefined;
  if (value.customCommand !== undefined && !customCommand) return fail("customCommand must be a non-empty command");
  if (customCommand && (customCommand.length > 2000 || /[\0\n\r]/.test(customCommand))) return fail("customCommand must be one line under 2000 characters");
  if (frontend === "custom" && !customCommand) return fail("customCommand is required when frontend is custom");
  return { version: 1, controls: value.controls ?? false, maxWorkers, frontend, graph, ...(customCommand ? { customCommand } : {}), keys: normalized };
}

export async function readMissionConfig(agentDir: string): Promise<MissionConfig> {
  const path = missionConfigFile(agentDir);
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error: unknown) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return structuredClone(DEFAULT_MISSION_CONFIG);
    throw new Error(`Cannot read mission configuration at ${path}: ${String(error)}`);
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch (error) { throw new Error(`Invalid JSON in mission configuration at ${path}: ${String(error)}`); }
  return validateMissionConfig(value, path);
}

export function missionConfigFile(agentDir: string): string {
  return join(agentDir, "mission.json");
}

export function displayConfigPath(agentDir: string, home = homedir()): string {
  const path = missionConfigFile(agentDir);
  const prefix = home.endsWith("/") ? home : `${home}/`;
  return path.startsWith(prefix) ? `~/${path.slice(prefix.length)}` : path;
}

export function configNotice(path: string, saved: boolean, detail: string): string {
  return `Configuration ${saved ? "set" : "loaded"} at ${path}: ${detail}`;
}

export async function writeMissionConfig(agentDir: string, config: MissionConfig): Promise<void> {
  const path = missionConfigFile(agentDir);
  await writeFile(path, `${JSON.stringify(validateMissionConfig(config, path), null, 2)}\n`, { mode: 0o600 });
}
