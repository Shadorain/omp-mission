import { randomUUID } from 'node:crypto';
import type {
	ExtensionApprovalAnswer,
	ExtensionApprovalPrompt,
	ExtensionUIContext,
} from '@oh-my-pi/pi-coding-agent/extensibility/extensions';

type Approve = NonNullable<ExtensionUIContext['approve']>;

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

const WRAPPED = Symbol.for('omp-mission.approvalBridge');

/**
 * Race the session's tool-approval prompt with an answer from the board, the way ask-bridge.ts races the ask
 * dialog. OMP's tool wrapper and eval preludes read `ui.approve` from the runner's UI object at call time, the
 * object extensions get as `ctx.ui`, so replacing it here lets the control socket settle the prompt; the pane's
 * prompt is aborted when the board answers first. A UI without `approve` falls back to a select OMP builds
 * itself, which stays pane-only.
 */
export function installApprovalBridge(ui: ExtensionUIContext, onChange: () => void): ApprovalBridge {
	const target = ui as unknown as { [WRAPPED]?: ApprovalBridge; approve?: Approve };
	const installed = target[WRAPPED];
	if (installed) return installed;
	const open = new Map<
		string,
		{ view: OpenApproval; prompt: ExtensionApprovalPrompt; resolve(answer: ExtensionApprovalAnswer): void }
	>();
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
			const remote = Promise.withResolvers<ExtensionApprovalAnswer>();
			const id = randomUUID();
			open.set(id, { view: approvalView(id, prompt), prompt, resolve: remote.resolve });
			onChange();
			const signal = options?.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
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
function approvalOptions(prompt: ExtensionApprovalPrompt): string[] {
	const grants = prompt.grants ?? [];
	return [
		...grants.map(grant => grant.label),
		...grants.map(grant => grant.alwaysLabel),
		onceLabel(prompt),
		...(prompt.session ? [prompt.session] : []),
		'Deny',
	];
}

function onceLabel(prompt: ExtensionApprovalPrompt): string {
	return prompt.grants?.length ? 'Approve Once' : 'Approve';
}

/** The answer a label from {@link approvalOptions} stands for; undefined for a label the prompt does not offer. */
function approvalAnswer(prompt: ExtensionApprovalPrompt, choice: string): ExtensionApprovalAnswer | undefined {
	if (choice === 'Deny') return 'deny';
	if (choice === onceLabel(prompt)) return 'once';
	if (prompt.session && choice === prompt.session) return 'session';
	for (const grant of prompt.grants ?? []) {
		if (choice === grant.label) return { grant: grant.scope, always: false };
		if (choice === grant.alwaysLabel) return { grant: grant.scope, always: true };
	}
	return undefined;
}

function approvalView(id: string, prompt: ExtensionApprovalPrompt): OpenApproval {
	const tool = /^Allow tool: (\S+)/.exec(prompt.full)?.[1] ?? null;
	const full = prompt.full.length > MAX_APPROVAL_PROMPT ? `${prompt.full.slice(0, MAX_APPROVAL_PROMPT)}…` : prompt.full;
	return { id, tool, summary: prompt.compact, prompt: full, options: approvalOptions(prompt) };
}
