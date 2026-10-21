import { randomUUID } from 'node:crypto';
import type { ExtensionUIContext, ExtensionUIDialogOptions } from '@oh-my-pi/pi-coding-agent';

// OMP 18.11.3 changed `ui.approve()` from a boolean to this answer (18.12 added grants); the pinned
// devDependency still declares the boolean, so the newer shapes are spelled out here.
interface ApprovalGrant { scope: 'folder' | 'target'; label: string; alwaysLabel: string }
type ApprovalAnswer = 'once' | 'session' | 'deny' | { grant: ApprovalGrant['scope']; always: boolean };
interface ApprovalPrompt { full: string; compact: string; session?: string; grants?: readonly ApprovalGrant[] }
type Approve = (prompt: ApprovalPrompt, options?: ExtensionUIDialogOptions) => Promise<ApprovalAnswer>;

/** The longest prompt published to the board; a write approval's full prompt carries the whole file. */
export const MAX_APPROVAL_PROMPT = 4000;

/** An open tool-approval prompt as the board sees it: the choices in the pane's order, Deny last. */
export interface OpenApproval {
	id: string;
	/** The tool asking, when the prompt is OMP's own `Allow tool: <name>` prompt. */
	tool: string | null;
	/** The prompt summarized for little room, as the pane shows it. */
	summary: string;
	/** The whole prompt (command, path, content), cut at {@link MAX_APPROVAL_PROMPT}. */
	prompt: string;
	options: string[];
}

export interface ApprovalBridge {
	/** The oldest approval prompt still open in the pane, if any. */
	open(): OpenApproval | undefined;
	/** Answer approval `id` with one of its option labels as if chosen in the pane; returns why it cannot, or undefined once answered. */
	permit(id: string, choice: string): string | undefined;
}

/** True when this OMP's `ui.approve()` takes the answer the bridge returns (18.11.3 and later). */
export function approvalAnswersSupported(version: string | undefined): boolean {
	const [major = 0, minor = 0, patch = 0] = (version ?? '').split('.').map(part => Number.parseInt(part, 10) || 0);
	if (major !== 18) return major > 18;
	if (minor !== 11) return minor > 11;
	return patch >= 3;
}

const WRAPPED = Symbol.for('omp-mission.approvalBridge');

/**
 * Race the session's tool-approval prompt with an answer from the board, the way ask-bridge.ts races the ask
 * dialog. OMP's tool wrapper and eval preludes read `ui.approve` from the runner's UI object at call time, the
 * object extensions get as `ctx.ui`, so replacing it here lets the control socket settle the prompt; the pane's
 * prompt is aborted when the board answers first. A UI without `approve` falls back to a select OMP builds
 * itself, which stays pane-only.
 */
export function installApprovalBridge(ui: ExtensionUIContext, onChange: () => void): ApprovalBridge {
	// The pinned types declare approve() → boolean; the OMP this is installed on (approvalAnswersSupported) takes ApprovalAnswer.
	const target = ui as unknown as { [WRAPPED]?: ApprovalBridge; approve?: Approve };
	if (target[WRAPPED]) return target[WRAPPED];
	const open = new Map<string, { view: OpenApproval; prompt: ApprovalPrompt; resolve(answer: ApprovalAnswer): void }>();
	const original = target.approve;
	const bridge: ApprovalBridge = {
		open: () => open.values().next().value?.view,
		permit(id, choice) {
			const entry = open.get(id);
			if (!entry) return 'That approval is no longer open in the pane';
			const answer = approvalAnswer(entry.prompt, choice);
			if (!answer) return `No such option: ${choice}`;
			entry.resolve(answer);
			return undefined;
		},
	};
	if (original) {
		target.approve = (prompt, options) => {
			const local = new AbortController();
			const signal = options?.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
			const remote = Promise.withResolvers<ApprovalAnswer>();
			const id = randomUUID();
			open.set(id, { view: approvalView(id, prompt), prompt, resolve: remote.resolve });
			onChange();
			return Promise.race([original.call(ui, prompt, { ...options, signal }), remote.promise]).finally(() => {
				open.delete(id);
				local.abort();
				onChange();
			});
		};
	}
	target[WRAPPED] = bridge;
	return bridge;
}

/** The prompt's choices as OMP's select fallback labels them: grants this session, grants always, approve once, the session answer, Deny. */
function approvalOptions(prompt: ApprovalPrompt): string[] {
	const grants = prompt.grants ?? [];
	return [...grants.map(grant => grant.label), ...grants.map(grant => grant.alwaysLabel), onceLabel(prompt), ...(prompt.session ? [prompt.session] : []), 'Deny'];
}

function onceLabel(prompt: ApprovalPrompt): string {
	return prompt.grants?.length ? 'Approve Once' : 'Approve';
}

/** The answer a label from {@link approvalOptions} stands for; undefined for a label the prompt does not offer. */
function approvalAnswer(prompt: ApprovalPrompt, choice: string): ApprovalAnswer | undefined {
	if (choice === 'Deny') return 'deny';
	if (choice === onceLabel(prompt)) return 'once';
	if (prompt.session && choice === prompt.session) return 'session';
	for (const grant of prompt.grants ?? []) {
		if (choice === grant.label) return { grant: grant.scope, always: false };
		if (choice === grant.alwaysLabel) return { grant: grant.scope, always: true };
	}
	return undefined;
}

function approvalView(id: string, prompt: ApprovalPrompt): OpenApproval {
	const tool = /^Allow tool: (\S+)/.exec(prompt.full)?.[1] ?? null;
	const full = prompt.full.length > MAX_APPROVAL_PROMPT ? `${prompt.full.slice(0, MAX_APPROVAL_PROMPT)}…` : prompt.full;
	return { id, tool, summary: prompt.compact, prompt: full, options: approvalOptions(prompt) };
}
