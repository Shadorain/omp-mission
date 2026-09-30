import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { replaceTabs, truncateToWidth, wrapTextWithAnsi, visibleWidth } from "@oh-my-pi/pi-tui";
import type { KeybindingsManager, Theme, ThemeColor } from "@oh-my-pi/pi-coding-agent";
import { phases, type Bead, type Evidence, type Mission, type Mode, type Phase, type Projection, type SubagentRow } from "./types.ts";
import { effectiveGraph } from "./controller.ts";

export interface MissionInspectorCallbacks { close(): void; select(beadId: string): void | Promise<void>; actions?: () => void | Promise<void> }
export type MissionView = "outline" | "history" | "evidence";

const phaseLabel = (phase: Phase) => phase[0]?.toUpperCase() + phase.slice(1);
const phaseStatus = (mission: Mission, phase: Phase) => {
	const evidence = mission.evidence[phase];
	return evidence?.outcome ?? (mission.phase === phase ? "active" : "pending");
};
const clip = (value: string, width: number) => truncateToWidth(replaceTabs(value), Math.max(1, width));
const paint = (theme: Theme, tone: ThemeColor, value: string) => theme.fg(tone, value);

function glyph(theme: Theme, key: string, fallback: string): string {
	const symbol = (theme as { symbol?: (key: string) => string }).symbol;
	if (typeof symbol !== "function") return fallback;
	return symbol.call(theme, key) || fallback;
}

function dot(theme: Theme): string {
	return ` ${paint(theme, "dim", glyph(theme, "sep.dot", "·").trim() || "·")} `;
}

function modeChip(theme: Theme, mode: Mode): string {
	if (mode === "auto") return paint(theme, "success", `${glyph(theme, "icon.auto", "▸")} auto`);
	if (mode === "pause") return paint(theme, "warning", `${glyph(theme, "cmd.shield", "▣")} gate`);
	return paint(theme, "accent", `${glyph(theme, "icon.fast", "»")} force`);
}

function alertChip(projection: Projection, theme: Theme): string {
	if (projection.ownershipError) return paint(theme, "error", `${glyph(theme, "status.error", "✘")} lock`);
	if (projection.resumeHold) return paint(theme, "warning", `${glyph(theme, "status.warning", "!")} resume`);
	if (projection.nativePlan) return paint(theme, "warning", `${glyph(theme, "status.warning", "!")} plan`);
	if (projection.mission.gate && !projection.mission.gate.approved) return paint(theme, "warning", `${glyph(theme, "status.warning", "!")} approve`);
	if (projection.snapshot?.error) return paint(theme, "error", `${glyph(theme, "status.error", "✘")} stale`);
	return "";
}

function countChip(projection: Projection, theme: Theme): string {
	const snapshot = projection.snapshot;
	if (!snapshot) return "";
	const bits = [
		snapshot.active ? paint(theme, "success", `${glyph(theme, "status.running", "⟳")} ${snapshot.active}`) : "",
		snapshot.ready.length ? paint(theme, "accent", `${glyph(theme, "status.pending", "○")} ${snapshot.ready.length}`) : "",
		snapshot.blocked ? paint(theme, "error", `${glyph(theme, "status.error", "✘")} ${snapshot.blocked}`) : "",
	].filter(Boolean);
	return bits.join(" ");
}

function fitLine(projection: Projection, theme: Theme, width: number): string {
	const { mission } = projection;
	const snapshot = projection.snapshot;
	const required = [
		paint(theme, "accent", mission.source.id),
		paint(theme, "text", phaseLabel(mission.phase)),
		modeChip(theme, mission.mode),
	];
	const runningSubagents = projection.subagents?.filter((row) => row.state === "running").length ?? 0;
	const optional = [
		projection.frontend ? paint(theme, "dim", projection.frontend) : "",
		paint(theme, "dim", effectiveGraph(projection.mission)),
		alertChip(projection, theme),
		snapshot ? paint(theme, "dim", `${snapshot.closed}/${snapshot.leaves.length}`) : "",
		countChip(projection, theme),
		runningSubagents ? paint(theme, "dim", `task ${runningSubagents}`) : "",
		projection.expandKey ? paint(theme, "dim", projection.expandKey) : "",
	].filter(Boolean);
	const rail = paint(theme, "accent", glyph(theme, "advisor.rail", "▎"));
	const build = (parts: string[]) => `${rail} ${parts.join(dot(theme))}`;
	let parts = [...required, ...optional];
	let line = build(parts);
	while (visibleWidth(line) > width && parts.length > 1) {
		parts = parts.slice(0, -1);
		line = build(parts);
	}
	return clip(line, width);
}

function phaseTrack(mission: Mission, theme: Theme, width: number): string {
	const index = Math.max(0, phases.indexOf(mission.phase));
	const slots = phases.length;
	const barWidth = Math.min(slots, Math.max(4, Math.min(9, width - 18)));
	const filledCount = Math.round(((index + 1) / slots) * barWidth);
	const bar = paint(theme, "accent", glyph(theme, "progress.filled", "━").repeat(filledCount))
		+ paint(theme, "dim", glyph(theme, "progress.empty", "─").repeat(Math.max(0, barWidth - filledCount)));
	const names = phases.map((phase) => {
		const label = phaseLabel(phase);
		if (phase === mission.phase) return paint(theme, "accent", label);
		if (phaseStatus(mission, phase) === "passed") return paint(theme, "dim", label);
		return paint(theme, "muted", label);
	}).join(" ");
	const full = `  ${bar}  ${names}`;
	if (visibleWidth(full) <= width) return full;
	return clip(`  ${bar}  ${paint(theme, "accent", phaseLabel(mission.phase))}`, width);
}

function beadTone(bead: Bead): ThemeColor {
	if (bead.issue_type === "subagent") return "dim";
	if (bead.category === "closed") return "dim";
	if (bead.category === "active") return "success";
	if (bead.category === "ready") return "accent";
	if (bead.category === "blocked") return "error";
	return "muted";
}

function beadMark(bead: Bead, theme: Theme): string {
	if (bead.category === "group") return paint(theme, "muted", glyph(theme, "nav.expand", "▸"));
	if (bead.category === "active") return paint(theme, "success", glyph(theme, "status.running", "⟳"));
	if (bead.category === "ready") return paint(theme, "accent", glyph(theme, "status.pending", "○"));
	if (bead.category === "blocked") return paint(theme, "error", glyph(theme, "status.error", "✘"));
	if (bead.category === "closed") return paint(theme, "dim", glyph(theme, "status.success", "✔"));
	return paint(theme, "muted", glyph(theme, "format.bullet", "•"));
}
function subagentBead(row: SubagentRow): Bead {
	return { id: row.id, title: row.name, status: row.state, issue_type: "subagent", children: [], ready: false, category: row.state === "running" ? "active" : "waiting" };
}

export function displayBeads(projection: Projection): Bead[] {
	const extras = (projection.subagents ?? []).map(subagentBead);
	if (effectiveGraph(projection.mission) === "local") return extras;
	return [...(projection.snapshot?.beads ?? []), ...extras];
}

function beadLine(bead: Bead, mission: Mission, theme: Theme, width: number): string {
	const worker = mission.workers.find((item) => item.beadId === bead.id);
	const tail = worker?.error ? paint(theme, "error", " error") : "";
	return clip(`  ${beadMark(bead, theme)} ${paint(theme, "dim", bead.id)}  ${paint(theme, beadTone(bead), bead.status)}  ${bead.title}${tail}`, width);
}

export function missionWidgetLines(projection: Projection, width: number, expanded = false, terminalHeight = 18, theme: Theme): readonly string[] {
	const summary = fitLine(projection, theme, width);
	if (!expanded) return [summary];
	const cap = Math.max(0, Math.floor(Math.max(0, terminalHeight) * 0.45));
	if (cap <= 0) return [];
	const lines = [summary];
	const title = projection.mission.source.title.replace(/\s+/g, " ").trim();
	if (title && lines.length < cap) lines.push(clip(paint(theme, "dim", `  ${title}`), width));
	if (lines.length < cap) lines.push(phaseTrack(projection.mission, theme, width));
	const beads = displayBeads(projection);
	const room = cap - lines.length;
	const hint = beads.length > room && room > 1;
	const visible = Math.max(0, hint ? room - 1 : room);
	const offset = Math.max(0, Math.min(projection.outlineOffset ?? 0, Math.max(0, beads.length - visible)));
	for (const bead of beads.slice(offset, offset + visible)) lines.push(beadLine(bead, projection.mission, theme, width));
	if (hint && lines.length < cap) lines.push(clip(paint(theme, "dim", `  ${offset + 1}-${Math.min(beads.length, offset + visible)}/${beads.length}`), width));
	return lines.slice(0, cap);
}

export class MissionWidget {
	constructor(private readonly getProjection: () => Projection, private readonly getTerminalRows: () => number, private readonly theme: Theme) {}
	render(width: number): readonly string[] {
		const projection = this.getProjection();
		return missionWidgetLines(projection, width, projection.expanded ?? false, this.getTerminalRows(), this.theme);
	}
	invalidate(): void {}
}

interface OutlineRow { bead: Bead; depth: number }
function outlineRows(beads: Bead[], collapsed: Set<string>): OutlineRow[] {
	const byId = new Map(beads.map((bead) => [bead.id, bead]));
	const roots = beads.filter((bead) => !bead.parent || !byId.has(bead.parent));
	const result: OutlineRow[] = [];
	const visited = new Set<string>();
	const visit = (bead: Bead, depth: number) => {
		if (visited.has(bead.id)) return;
		visited.add(bead.id);
		result.push({ bead, depth });
		if (collapsed.has(bead.id)) return;
		for (const id of bead.children) {
			const child = byId.get(id);
			if (child) visit(child, depth + 1);
		}
	};
	for (const bead of roots) visit(bead, 0);
	for (const bead of beads) {
		if (visited.has(bead.id)) continue;
		let parent = bead.parent;
		const ancestors = new Set<string>();
		let concealed = false;
		while (parent && byId.has(parent) && !ancestors.has(parent)) {
			if (collapsed.has(parent)) {
				concealed = true;
				break;
			}
			ancestors.add(parent);
			parent = byId.get(parent)?.parent;
		}
		if (!concealed) visit(bead, 0);
	}
	return result;
}

function evidenceRows(mission: Mission): string[] {
	const rows = phases.map((phase) => {
		const item: Evidence | undefined = mission.evidence[phase];
		const outcome = phaseStatus(mission, phase);
		return `${phaseLabel(phase)} · ${outcome}${item?.revision ? ` · ${item.revision}` : ""}${item?.detail ? ` · ${item.detail}` : ""}`;
	});
	for (const review of mission.reviews) {
		rows.push(`Review ${review.revision} · ${review.at}`);
		for (const finding of review.findings) {
			rows.push(`${finding.id} · ${finding.severity} · ${finding.path}:${finding.line} · ${finding.title}: ${finding.body}`);
			if (finding.rejection) rows.push(`Rejected: ${finding.rejection}`);
			const repairs = Object.entries(mission.repairLinks).filter(([, findings]) => findings.includes(finding.id)).map(([beadId]) => beadId);
			if (repairs.length) rows.push(`Repair beads: ${repairs.join(", ")}`);
		}
	}
	for (const worker of mission.workers) rows.push(`Worker ${worker.beadId} · ${worker.state} · ${worker.handle ?? "identity missing"} · ${worker.incarnationId ?? "incarnation missing"}${worker.error ? ` · ${worker.error}` : ""}`);
	return rows;
}

function eventRows(projection: Projection): string[] {
	return (projection.history ?? []).map((event) => `${event.timestamp} · ${event.actor} · ${event.event}: ${event.summary}`);
}

export class MissionInspector implements Component {
	private selectedId?: string;
	private collapsed = new Set<string>();
	private view: MissionView = "outline";
	private scroll = 0;
	private bodyCount = 0;

	constructor(
		private readonly getProjection: () => Projection,
		private readonly callbacks: MissionInspectorCallbacks,
		private readonly getTerminalRows: () => number,
		private readonly theme: Theme,
		private readonly keybindings: KeybindingsManager,
	) {
		const projection = getProjection();
		this.selectedId = projection.selected ?? displayBeads(projection)[0]?.id;
		if (this.selectedId) void callbacks.select(this.selectedId);
	}
	private projection(): Projection { return this.getProjection(); }
	private rows(): OutlineRow[] { return outlineRows(displayBeads(this.projection()), this.collapsed); }
	private selectedIndex(): number { return Math.max(0, this.rows().findIndex((row) => row.bead.id === this.selectedId)); }
	private syncGraph(): void {
		const projection = this.projection();
		const beads = displayBeads(projection);
		const previous = this.selectedId;
		if (!beads.some((bead) => bead.id === previous)) {
			this.selectedId = projection.selected ?? beads[0]?.id;
			if (this.selectedId && this.selectedId !== previous) void this.callbacks.select(this.selectedId);
		}
		for (const id of [...this.collapsed]) if (!beads.some((bead) => bead.id === id)) this.collapsed.delete(id);
		if (this.view === "outline") this.clampScroll(0);
	}
	private clampScroll(height: number): void {
		const rows = this.rows();
		if (!rows.some((row) => row.bead.id === this.selectedId)) this.selectedId = rows[0]?.bead.id;
		const visible = Math.max(1, height);
		const index = this.selectedIndex();
		this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, rows.length - visible)));
		if (index < this.scroll) this.scroll = index;
		if (index >= this.scroll + visible) this.scroll = index - visible + 1;
	}
	render(width: number): readonly string[] {
		this.syncGraph();
		const projection = this.projection();
		const fullHeight = Math.max(8, this.getTerminalRows());
		const budget = Math.max(1, fullHeight - 1);
		const header = [
			fitLine(projection, this.theme, width),
			phaseTrack(projection.mission, this.theme, width),
			paint(this.theme, "dim", `${this.view}  j/k  tab  esc${this.callbacks.actions ? "  a" : ""}`),
		].map((line) => clip(line, width));
		let body: string[];
		if (this.view === "outline") {
			const all = this.rows();
			const available = Math.max(1, budget - header.length);
			this.clampScroll(available);
			body = all.map(({ bead, depth }) => {
				const marker = bead.children.length ? (this.collapsed.has(bead.id) ? glyph(this.theme, "nav.expand", "▸") : glyph(this.theme, "nav.collapse", "▾")) : " ";
				const isSelected = bead.id === this.selectedId;
				const select = isSelected ? glyph(this.theme, "nav.cursor", "❯") : " ";
				const statusColor = bead.issue_type === "subagent" ? "dim" : bead.category === "active" ? "success" : bead.category === "ready" ? "accent" : bead.category === "blocked" ? "error" : "muted";
				const rowText = `${"  ".repeat(Math.min(depth, 12))}${marker} ${bead.category}/${bead.status} ${bead.id} ${bead.title}${bead.assignee ? ` · ${bead.assignee}` : ""}`;
				return paint(this.theme, isSelected ? "accent" : statusColor, `${select}${rowText}`);
			});
			if (all.length === 0) body = [paint(this.theme, "muted", effectiveGraph(projection.mission) === "local" ? "No subagents" : "No bead graph")];
		} else if (this.view === "history") {
			body = eventRows(projection);
			if (!body.length) body = [paint(this.theme, "muted", this.selectedId ? `No history for ${this.selectedId}` : "Select a bead")];
		} else {
			body = evidenceRows(projection.mission);
		}
		if (this.view !== "outline") body = body.flatMap((line) => wrapMissionText(line, width));
		this.bodyCount = body.length;
		const visibleBody = Math.max(1, budget - header.length);
		if (this.view !== "outline") this.scroll = Math.max(0, Math.min(this.scroll, Math.max(0, body.length - visibleBody)));
		return [...header, ...body.slice(this.scroll, this.scroll + visibleBody)].map((line) => clip(line, width));
	}
	invalidate(): void {}
	handleInput(data: string): void {
		if (this.keybindings.matches(data, "tui.select.cancel") || data === "q") {
			this.callbacks.close();
			return;
		}
		if (data === "\t") {
			this.view = this.view === "outline" ? "history" : this.view === "history" ? "evidence" : "outline";
			this.scroll = 0;
			return;
		}
		if (data === "a" && this.callbacks.actions) {
			void this.callbacks.actions();
			return;
		}
		if (this.keybindings.matches(data, "tui.select.up") || data === "k") {
			if (this.view !== "outline") {
				this.scroll = Math.max(0, this.scroll - 1);
				return;
			}
			const rows = this.rows();
			this.selectedId = rows[Math.max(0, this.selectedIndex() - 1)]?.bead.id;
			if (this.selectedId) void this.callbacks.select(this.selectedId);
			this.clampScroll(1);
			return;
		}
		if (this.keybindings.matches(data, "tui.select.down") || data === "j") {
			if (this.view !== "outline") {
				const count = this.bodyCount;
				this.scroll = Math.min(Math.max(0, count - 1), this.scroll + 1);
				return;
			}
			const rows = this.rows();
			this.selectedId = rows[Math.min(rows.length - 1, this.selectedIndex() + 1)]?.bead.id;
			if (this.selectedId) void this.callbacks.select(this.selectedId);
			this.clampScroll(1);
			return;
		}
		if ((this.keybindings.matches(data, "tui.select.confirm") || data === "\r" || data === "\n") && this.view === "outline") {
			const bead = this.rows()[this.selectedIndex()]?.bead;
			if (bead?.children.length) {
				if (this.collapsed.has(bead.id)) this.collapsed.delete(bead.id);
				else this.collapsed.add(bead.id);
				this.clampScroll(1);
			}
		}
	}
}

export function createMissionWidget(getProjection: () => Projection, getTerminalRows: () => number, theme: Theme): MissionWidget {
	return new MissionWidget(getProjection, getTerminalRows, theme);
}

export function createMissionInspector(
	getProjection: () => Projection,
	callbacks: MissionInspectorCallbacks,
	getTerminalRows: () => number,
) {
	return (_tui: TUI, theme: Theme, keybindings: KeybindingsManager) =>
		new MissionInspector(getProjection, callbacks, getTerminalRows, theme, keybindings);
}

export function wrapMissionText(text: string, width: number): string[] {
	return wrapTextWithAnsi(replaceTabs(text), Math.max(1, width));
}
