export type Mode = 'auto' | 'pause' | 'force';
export type Phase = 'plan' | 'isolate' | 'graph' | 'execute' | 'verify' | 'deliver' | 'review' | 'repair' | 'complete';
export const phases: Phase[] = ['plan','isolate','graph','execute','verify','deliver','review','repair','complete'];
export interface Source { kind: 'linear' | 'github' | 'freeform'; id: string; title: string; body: string; url?: string; comments: string; extra: string; repo?: string; number?: number }
export interface ParsedInput { force: boolean; pause: boolean; keep: boolean; source?: string; freeform?: string; extra: string }
export interface Workspace { key: string; cwd: string; commonDir?: string; branch?: string; base?: string; beadsDir?: string; delivery: 'pr' | 'local' }
export interface Evidence { outcome: 'pending' | 'active' | 'passed' | 'failed' | 'skipped'; detail: string; revision?: string; at: string }
export interface Gate { kind: 'wave' | 'review' | 'repairs'; token: string; detail: string; approved: boolean }
export interface Worker { beadId: string; attempt: string; cwd: string; files: string[]; state: 'reserved' | 'starting' | 'awaiting-claim' | 'running' | 'missing' | 'closed'; handle?: string; incarnationId?: string; assignment: string; error?: string; frontend?: Frontend; launchedAt?: string }
export interface Finding { id: string; severity: 'critical' | 'high' | 'medium' | 'low'; path: string; line: number; title: string; body: string; rejection?: string }
export interface ReviewRound { round: number; revision: string; model: string; summary: string; findings: Finding[]; at: string; invalidated?: string }
export interface Mission { version: 1; id: string; source: Source; workspace: Workspace; epicId?: string; graph?: Graph; scopes: Record<string,string[]>; phase: Phase; evidence: Partial<Record<Phase,Evidence>>; mode: Mode; keep: boolean; reviewRequested: boolean; gate?: Gate; workers: Worker[]; reviews: ReviewRound[]; repairLinks: Record<string,string[]>; round: number; controllerNonce?: string; createdAt: string; updatedAt: string; blocker?: string }
export interface Bead { id: string; title: string; status: string; assignee?: string; claimActor?: string; description?: string; issue_type?: string; children: string[]; parent?: string; ready: boolean; category: 'closed' | 'active' | 'ready' | 'blocked' | 'waiting' | 'deferred' | 'group' }
export interface AuditEvent { timestamp: string; actor: string; event: string; summary: string }
export interface Snapshot { beads: Bead[]; leaves: Bead[]; ready: string[]; closed: number; active: number; blocked: number; fetchedAt: number; error?: string }
export interface Terminal { handle: string; incarnationId: string; worktreePath: string; writable: boolean; connected: boolean; [key: string]: unknown }
export interface CommandResult { stdout: string; stderr: string; code: number }
export type Run = (command: string, args: string[], cwd: string, env?: Record<string,string>) => Promise<CommandResult>;
export type Frontend = 'none' | 'orca' | 'herdr' | 'custom';
export type Graph = 'local' | 'beads';
export interface SubagentRow { id: string; name: string; kind: 'task' | 'eval'; state: 'running' | 'closed' | 'error' }
export interface MissionConfig { version: 1; controls: boolean; maxWorkers: number; frontend: Frontend; graph: Graph; modelRole: string; workerRole: string; autoDispatch: boolean; customCommand?: string; keys: { expand: string | null; fullscreen: string | null; mode: string | null } }
export interface Projection { mission: Mission; snapshot?: Snapshot; resumeHold: boolean; ownershipError?: string; selected?: string; history?: AuditEvent[]; expanded?: boolean; outlineOffset?: number; nativePlan?: boolean; nextAction?: string; frontend?: Frontend; expandKey?: string | null; subagents?: SubagentRow[] }
export interface PolicyContext { resumeHold: boolean; owned: boolean; nativePlan: boolean; fresh: boolean; maxWorkers: number }
export interface Action { kind: 'hold' | 'dispatch' | 'resend' | 'verify' | 'deliver' | 'review' | 'repairs' | 'complete'; detail: string; ids?: string[]; gate?: Gate }
