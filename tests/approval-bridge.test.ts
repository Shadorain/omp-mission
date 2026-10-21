import { expect, test } from 'bun:test';
import type { ExtensionUIContext } from '@oh-my-pi/pi-coding-agent';
import { approvalAnswersSupported, installApprovalBridge, MAX_APPROVAL_PROMPT } from '../src/approval-bridge';

type Prompt = {
	full: string;
	compact: string;
	session?: string;
	grants?: { scope: 'folder' | 'target'; label: string; alwaysLabel: string }[];
};
type Approve = (prompt: Prompt, options?: { signal?: AbortSignal }) => Promise<unknown>;

/** A pane approval prompt answered only by `answerInPane` or by abort (OMP then reports `deny`). */
function paneUi() {
	const seen: { signal?: AbortSignal; answerInPane?: (answer: unknown) => void } = {};
	const pane: { approve: Approve } = {
		approve: (_prompt: Prompt, options?: { signal?: AbortSignal }) => {
			const { promise, resolve } = Promise.withResolvers<unknown>();
			seen.signal = options?.signal;
			seen.answerInPane = resolve;
			options?.signal?.addEventListener('abort', () => resolve('deny'));
			return promise;
		},
	};
	// `approve` reads the member at call time, as OMP's tool wrapper does, so it sees the bridge's replacement.
	return { ui: pane as unknown as ExtensionUIContext, approve: (prompt: Prompt) => pane.approve(prompt), seen };
}

const cached: Prompt = {
	full: 'Allow tool: write\nPath: src/a.ts\nContent:\nline 1\nline 2',
	compact: 'Allow tool: write\nPath: src/a.ts · Content: line 1 …',
	grants: [
		{ scope: 'folder', label: 'Approve Directory: src', alwaysLabel: 'Always Approve Directory: src' },
		{ scope: 'target', label: 'Approve File', alwaysLabel: 'Always Approve File' },
	],
};

test('an open approval is published with its choices and a board answer settles it and closes the pane prompt', async () => {
	const { ui, approve, seen } = paneUi();
	let changes = 0;
	const bridge = installApprovalBridge(ui, () => {
		changes++;
	});
	const shown = approve(cached);
	const open = bridge.open()!;
	expect(open).toEqual({
		id: expect.any(String),
		tool: 'write',
		summary: cached.compact,
		prompt: cached.full,
		options: [
			'Approve Directory: src',
			'Approve File',
			'Always Approve Directory: src',
			'Always Approve File',
			'Approve Once',
			'Deny',
		],
	});
	expect(bridge.permit('other', 'Deny')).toBe('That approval is no longer open in the pane');
	// A label the prompt does not offer is refused, never read as a denial.
	expect(bridge.permit(open.id, 'Approve')).toBe('No such option: Approve');
	expect(bridge.open()).toBe(open);
	expect(bridge.permit(open.id, 'Always Approve File')).toBeUndefined();
	expect(await shown).toEqual({ grant: 'target', always: true });
	expect(seen.signal?.aborted).toBe(true);
	expect(bridge.open()).toBeUndefined();
	expect(changes).toBe(2);
	expect(installApprovalBridge(ui, () => {})).toBe(bridge);
});

test('each choice maps to the answer the pane would give', async () => {
	const { ui, approve } = paneUi();
	const bridge = installApprovalBridge(ui, () => {});
	const session: Prompt = {
		full: 'Allow tool: bash\nCommand: ls',
		compact: 'Allow tool: bash\nCommand: ls',
		session: 'Approve bash for this session',
	};
	const answers = [];
	for (const choice of ['Approve', 'Approve bash for this session', 'Deny']) {
		const shown = approve(session);
		expect(bridge.open()!.options).toEqual(['Approve', 'Approve bash for this session', 'Deny']);
		expect(bridge.permit(bridge.open()!.id, choice)).toBeUndefined();
		answers.push(await shown);
	}
	expect(answers).toEqual(['once', 'session', 'deny']);
});

test('a pane answer clears the published approval and a later board answer is stale', async () => {
	const { ui, approve, seen } = paneUi();
	const bridge = installApprovalBridge(ui, () => {});
	const shown = approve({
		full: `Allow tool: write\n${'x'.repeat(MAX_APPROVAL_PROMPT)}`,
		compact: 'Allow tool: write',
	});
	const open = bridge.open()!;
	expect(open.prompt.length).toBe(MAX_APPROVAL_PROMPT + 1);
	seen.answerInPane!('once');
	expect(await shown).toBe('once');
	expect(bridge.open()).toBeUndefined();
	expect(bridge.permit(open.id, 'Approve')).toBe('That approval is no longer open in the pane');
});

test('a UI without approve keeps approvals pane-only', () => {
	const ui = {} as ExtensionUIContext;
	const bridge = installApprovalBridge(ui, () => {});
	expect('approve' in ui).toBe(false);
	expect(bridge.open()).toBeUndefined();
	expect(bridge.permit('any', 'Approve')).toBe('That approval is no longer open in the pane');
});

test('only OMP whose approve() takes an answer is bridged', () => {
	expect(['18.10.4', '18.11.2', '18.11.3', '18.12.5', '19.0.0', undefined].map(approvalAnswersSupported)).toEqual([
		false,
		false,
		true,
		true,
		true,
		false,
	]);
});
