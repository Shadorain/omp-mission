import type {
	ExtensionAskDialogQuestion,
	ExtensionAskDialogResult,
	ExtensionUIContext,
} from '@oh-my-pi/pi-coding-agent';

/** One answer from the board: an option index, several (multi-select), or free text ("Other"). */
export type BoardAnswer = { option: number } | { options: number[] } | { text: string };

interface OpenDialog {
	questions: readonly ExtensionAskDialogQuestion[];
	resolve(result: ExtensionAskDialogResult): void;
}

export interface AskBridge {
	/** The ask dialog on screen, if one is open. */
	open(): readonly ExtensionAskDialogQuestion[] | undefined;
	/** Answer the open dialog as if typed in the pane; returns why it cannot, or undefined once answered. */
	answer(answers: readonly BoardAnswer[]): string | undefined;
}

const WRAPPED = Symbol.for('omp-mission.askBridge');

/**
 * Race the session's ask dialog with an answer from the board. OMP has no API to answer an open `ask`
 * from outside the pane, but the `ask` tool reads `ui.askDialog` from the same UI object extensions get
 * at call time, so wrapping it here lets the control socket settle the dialog the way OMP's own collab
 * guest does: first answer wins, the other side is aborted. The pane's dialog stays fully usable.
 */
export function installAskBridge(ui: ExtensionUIContext, onChange: () => void): AskBridge {
	const target = ui as ExtensionUIContext & { [WRAPPED]?: AskBridge };
	if (target[WRAPPED]) return target[WRAPPED];
	let current: OpenDialog | undefined;
	const original = ui.askDialog;
	const bridge: AskBridge = {
		open: () => current?.questions,
		answer(answers) {
			const dialog = current;
			if (!dialog) return 'No ask dialog is open in the pane';
			const result = buildResult(dialog.questions, answers);
			if (typeof result === 'string') return result;
			dialog.resolve(result);
			return undefined;
		},
	};
	if (original) {
		ui.askDialog = (questions, options) => {
			const local = new AbortController();
			const signal = options?.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
			const remote = Promise.withResolvers<ExtensionAskDialogResult>();
			const dialog: OpenDialog = { questions, resolve: remote.resolve };
			current = dialog;
			onChange();
			return Promise.race([original.call(ui, questions, { ...options, signal }), remote.promise]).finally(() => {
				if (current === dialog) current = undefined;
				local.abort();
				onChange();
			});
		};
	}
	target[WRAPPED] = bridge;
	return bridge;
}

/** The dialog's submit result for these answers, or why they do not fit its questions. */
export function buildResult(
	questions: readonly ExtensionAskDialogQuestion[],
	answers: readonly BoardAnswer[],
): ExtensionAskDialogResult | string {
	if (answers.length !== questions.length)
		return `Answer all ${questions.length} question${questions.length === 1 ? '' : 's'}`;
	const results = [];
	for (const [index, question] of questions.entries()) {
		const answer = answers[index]!;
		const labels = question.options.map(option => option.label);
		const pick = (i: number) => (Number.isSafeInteger(i) && i >= 0 && i < labels.length ? labels[i] : undefined);
		const base = { id: question.id, question: question.question, options: labels, multi: question.multi === true };
		if ('text' in answer) {
			const text = answer.text.trim();
			if (!text) return `Question ${index + 1} needs an option or some text`;
			results.push({ ...base, selectedOptions: [], customInput: text });
		} else if ('options' in answer) {
			if (!question.multi) return `Question ${index + 1} takes one option`;
			const chosen = answer.options.map(pick);
			if (!chosen.length || chosen.some(label => label === undefined))
				return `Question ${index + 1} has no such options`;
			results.push({ ...base, selectedOptions: [...new Set(chosen as string[])] });
		} else {
			const label = pick(answer.option);
			if (label === undefined) return `Question ${index + 1} has no option ${answer.option}`;
			results.push({ ...base, selectedOptions: [label] });
		}
	}
	return { kind: 'submit', results };
}

/** Parse the socket's `answers` argument; undefined when it is not a list of answers. */
export function parseBoardAnswers(raw: unknown): BoardAnswer[] | undefined {
	if (!Array.isArray(raw)) return undefined;
	const out: BoardAnswer[] = [];
	for (const value of raw) {
		if (typeof value !== 'object' || value === null) return undefined;
		const v = value as Record<string, unknown>;
		if (typeof v.text === 'string') out.push({ text: v.text });
		else if (Array.isArray(v.options) && v.options.every(n => typeof n === 'number'))
			out.push({ options: v.options as number[] });
		else if (typeof v.option === 'number') out.push({ option: v.option });
		else return undefined;
	}
	return out;
}
