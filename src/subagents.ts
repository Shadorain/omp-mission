import type { SubagentRow } from "./types";

export function noteSubagentSpawn(rows: readonly SubagentRow[], event: { agent: string; invocationKind: "task" | "eval"; spawnKey?: string }): SubagentRow[] {
	const name = event.agent.trim() || event.invocationKind;
	if (event.invocationKind === "task" && rows.some((row) => row.kind === "task" && row.state === "running" && row.name === name)) return [...rows];
	const id = event.spawnKey ? `subagent:${event.spawnKey}` : `subagent:${event.invocationKind}:${rows.length + 1}:${name}`;
	if (rows.some((row) => row.id === id)) return [...rows];
	return [...rows, { id, name, kind: event.invocationKind, state: "running" }];
}

export function noteSubagentToolStart(rows: readonly SubagentRow[], event: { toolCallId: string; toolName: string; args: unknown }): SubagentRow[] {
	if (event.toolName !== "task") return [...rows];
	const id = `subagent:${event.toolCallId}`;
	if (rows.some((row) => row.id === id)) return [...rows];
	const argRec = (event.args && typeof event.args === "object" && !Array.isArray(event.args)) ? (event.args as Record<string, unknown>) : {};
	const named = typeof argRec.name === "string" ? argRec.name : typeof argRec.agent === "string" ? argRec.agent : undefined;
	const tasksRaw = argRec.tasks;
	const firstItem = Array.isArray(tasksRaw) ? tasksRaw.find((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : undefined;
	const firstName = firstItem && typeof firstItem.name === "string" ? firstItem.name : undefined;
	return [...rows, { id, name: named ?? firstName ?? "task", kind: "task", state: "running" }];
}

export function noteSubagentToolEnd(rows: readonly SubagentRow[], event: { toolCallId: string; toolName: string; isError: boolean }): SubagentRow[] {
	if (event.toolName === "task") {
		const id = `subagent:${event.toolCallId}`;
		return rows.map((row) => row.id === id && row.state === "running" ? { ...row, state: event.isError ? "error" : "closed" } : row);
	}
	if (event.toolName !== "eval") return [...rows];
	let closed = false;
	return rows.map((row) => {
		if (closed || row.kind !== "eval" || row.state !== "running") return row;
		closed = true;
		return { ...row, state: event.isError ? "error" : "closed" };
	});
}

export function noteSubagentTurnEnd(rows: readonly SubagentRow[]): SubagentRow[] {
	return rows.map((row) => row.state === "running" ? { ...row, state: "closed" } : row);
}
