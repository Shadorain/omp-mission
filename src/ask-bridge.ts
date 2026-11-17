import type { ExtensionFormDialogResult, ExtensionUIContext } from '@oh-my-pi/pi-coding-agent';
import {
	fieldError,
	isArrayChoice,
	textValue,
	type HtmlFormData,
	type HtmlFormValue,
} from '@oh-my-pi/pi-tui/html-form/data';
import { parseHtmlForm, type ChoiceField, type HtmlForm } from '@oh-my-pi/pi-tui/html-form/parse';

export type AskForm = HtmlForm;
export function parseBoardData(raw: unknown): Record<string, string | number | string[]> | undefined {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
	const data: Record<string, string | number | string[]> = {};
	for (const [name, value] of Object.entries(raw)) {
		if (
			typeof value === 'string' ||
			(typeof value === 'number' && Number.isFinite(value)) ||
			(Array.isArray(value) && value.every(item => typeof item === 'string'))
		) {
			Object.defineProperty(data, name, { value, enumerable: true, configurable: true, writable: true });
		} else return undefined;
	}
	return data;
}

interface OpenDialog {
	html: string;
	form?: HtmlForm;
	id?: string;
	finished?: boolean;
	resolve(result: ExtensionFormDialogResult): void;
}

export interface AskBridge {
	open(): { html: string; form: AskForm } | undefined;
	bind(id: string, html: string): boolean;
	answer(id: string, data: Record<string, string | number | string[]>): string | undefined;
}

const WRAPPED = Symbol.for('omp-mission.askBridge');
const MAX_FORM_BYTES = 256 * 1024;
const MAX_FIELDS = 100;

/** Race the native form dialog against a socket answer, cancelling the losing pane dialog. */
export function installAskBridge(ui: ExtensionUIContext, onChange: () => void): AskBridge {
	const target = ui as ExtensionUIContext & { [WRAPPED]?: AskBridge };
	if (target[WRAPPED]) return target[WRAPPED];
	let current: OpenDialog | undefined;
	const original = ui.formDialog;
	const bridge: AskBridge = {
		open() {
			const dialog = current;
			return dialog?.form ? { html: dialog.html, form: dialog.form } : undefined;
		},
		bind(id, html) {
			const dialog = current;
			if (!dialog || dialog.finished || dialog.html !== html || (dialog.id && dialog.id !== id)) return false;
			dialog.id = id;
			return true;
		},
		answer(id, data) {
			const dialog = current;
			if (!dialog || dialog.finished || dialog.id !== id) return 'That form is no longer open in the pane';
			if (!dialog.form) return 'The open form cannot be answered from outside';
			const result = validatedData(dialog.form, data);
			if (typeof result === 'string') return result;
			dialog.finished = true;
			dialog.resolve({ data: result });
			return undefined;
		},
	};
	if (original) {
		ui.formDialog = (html, options) => {
			const local = new AbortController();
			const signal = options?.signal ? AbortSignal.any([options.signal, local.signal]) : local.signal;
			const remote = Promise.withResolvers<ExtensionFormDialogResult>();
			const dialog: OpenDialog = { html, form: publishableForm(html), resolve: remote.resolve };
			current = dialog;
			onChange();
			const pane = original.call(ui, html, { ...options, signal }).then(
				result => {
					dialog.finished = true;
					return result;
				},
				error => {
					dialog.finished = true;
					throw error;
				},
			);
			return Promise.race([pane, remote.promise]).finally(() => {
				if (current === dialog) current = undefined;
				local.abort();
				onChange();
			});
		};
	}
	target[WRAPPED] = bridge;
	return bridge;
}

function parsePublishableForm(html: string): HtmlForm | undefined {
	try {
		const form = parseHtmlForm(html);
		if (!form.fields.length || form.fields.length > MAX_FIELDS) return undefined;
		const names = new Set<string>();
		for (const field of form.fields) {
			if (!field.name || ['__proto__', 'constructor', 'prototype'].includes(field.name) || names.has(field.name))
				return undefined;
			names.add(field.name);
		}
		const hiddenNames = new Set<string>();
		for (const [name] of form.hidden) {
			if (!name || ['__proto__', 'constructor', 'prototype'].includes(name) || names.has(name) || hiddenNames.has(name))
				return undefined;
			hiddenNames.add(name);
		}
		const serialized = JSON.stringify(form);
		if (Buffer.byteLength(serialized, 'utf8') > MAX_FORM_BYTES) return undefined;
		return form;
	} catch {
		return undefined;
	}
}

function publishableForm(html: string): HtmlForm | undefined {
	const form = parsePublishableForm(html);
	if (!form) return undefined;
	return {
		...form,
		sections: form.sections.map(section => ({
			...section,
			blocks: section.blocks.map(block => {
				if (block.kind !== 'image') return block;
				const src = safeImageSource(block.src);
				return src
					? { ...block, src }
					: { kind: 'text' as const, spans: [{ text: block.alt || 'Image unavailable' }], heading: false };
			}),
		})),
	};
}

function safeImageSource(raw: string): string | undefined {
	if (/^data:image\/(?:png|jpeg|gif|webp|svg\+xml);/i.test(raw) && raw.length <= MAX_FORM_BYTES) return raw;
	try {
		const url = new URL(raw);
		if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) return raw;
	} catch {}
	return undefined;
}

/** Defaults belong to the dialog; omitted controls must stay unchecked or unanswered. */
function validatedData(form: HtmlForm, submitted: Record<string, string | number | string[]>): HtmlFormData | string {
	const hiddenData = Object.fromEntries(form.hidden);
	const fields = new Map(form.fields.map(field => [field.name, field]));
	const hidden = new Set(form.hidden.map(([name]) => name));
	for (const name of Object.keys(submitted)) {
		if (!fields.has(name) && !hidden.has(name)) return `Unknown form field: ${name}`;
	}
	const data: HtmlFormData = { ...hiddenData };
	for (const [name, value] of Object.entries(submitted)) {
		if (hidden.has(name)) {
			if (value !== hiddenData[name]) return `Hidden field cannot be changed: ${name}`;
			continue;
		}
		const field = fields.get(name)!;
		if (field.kind === 'text') {
			if (typeof value !== 'string' && typeof value !== 'number') return `Invalid value for ${name}`;
			data[name] = textValue(field, String(value));
		} else {
			const issue = validateChoice(field, value);
			if (issue) return issue;
			data[name] = value as HtmlFormValue;
		}
	}
	for (const field of form.fields) {
		const error = fieldError(field, data[field.name]);
		if (error) return `${field.name}: ${error}`;
	}
	return data;
}

function validateChoice(field: ChoiceField, value: string | number | string[]): string | undefined {
	const values = Array.isArray(value) ? value : [value];
	if (isArrayChoice(field) !== Array.isArray(value)) return `Invalid value type for ${field.name}`;
	if (values.some(item => typeof item !== 'string')) return `Invalid choice for ${field.name}`;
	const selected = values as string[];
	if (new Set(selected).size !== selected.length) return `Duplicate choice for ${field.name}`;
	for (const item of selected) {
		const option = field.options.find(candidate => candidate.value === item);
		if (option?.disabled) return `Disabled choice for ${field.name}`;
		if (!option && !field.other) return `Unknown choice for ${field.name}`;
	}
	return undefined;
}
