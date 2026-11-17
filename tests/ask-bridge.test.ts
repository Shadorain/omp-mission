import { expect, test } from 'bun:test';
import type { ExtensionFormDialogResult, ExtensionUIContext } from '@oh-my-pi/pi-coding-agent';
import { installAskBridge } from '../src/ask-bridge';

const html = `<form>
  <input type="hidden" name="token" value="secret">
  <fieldset><legend>Options</legend>
    <label><input type="radio" name="mode" value="fast" checked> Fast</label>
    <label><input type="radio" name="mode" value="slow" disabled> Slow</label>
    <label>Count <input type="number" name="count" min="0" max="4" value="0"></label>
    <label><input type="checkbox" name="tags" value="a"> A</label>
    <label><input type="checkbox" name="tags" value="b"> B</label>
  </fieldset>
</form>`;

function paneUi() {
	const seen: { signal?: AbortSignal } = {};
	const ui = {
		formDialog: (_html: string, options?: { signal?: AbortSignal }) => {
			seen.signal = options?.signal;
			return new Promise<ExtensionFormDialogResult | undefined>(resolve =>
				options?.signal?.addEventListener('abort', () => resolve(undefined), { once: true }),
			);
		},
	} as unknown as ExtensionUIContext;
	return { ui, seen };
}

test('a matching board form submission wins and aborts the native pane form', async () => {
	const { ui, seen } = paneUi();
	let changes = 0;
	const bridge = installAskBridge(ui, () => changes++);
	const shown = ui.formDialog!(html, {});
	const open = bridge.open();
	expect(open?.html).toBe(html);
	expect(open?.form.fields.map(field => field.name)).toEqual(['mode', 'count', 'tags']);
	expect(bridge.bind('call-1', `${html} `)).toBe(false);
	expect(bridge.bind('call-1', html)).toBe(true);
	expect(bridge.answer('wrong-call', { mode: 'fast' })).toBeString();
	expect(bridge.answer('call-1', { mode: 'fast', count: 0, tags: ['a'] })).toBeUndefined();
	expect(await shown).toEqual({ data: { token: 'secret', mode: 'fast', count: 0, tags: ['a'] } });
	expect(seen.signal?.aborted).toBe(true);
	expect(bridge.open()).toBeUndefined();
	expect(changes).toBe(2);
	expect(installAskBridge(ui, () => {})).toBe(bridge);
});

test('malformed, unknown, disabled, hidden, and invalid field values never settle the form', () => {
	const { ui } = paneUi();
	const bridge = installAskBridge(ui, () => {});
	void ui.formDialog!(html, {});
	expect(bridge.answer('call', { mode: 'fast' })).toBeString();
	bridge.bind('call', html);
	expect(bridge.answer('call', { mode: 'fast', count: 0, tags: [], unknown: 'x' })).toBeString();
	expect(bridge.answer('call', { token: 'changed', mode: 'fast', count: 0, tags: [] })).toBeString();
	expect(bridge.answer('call', { mode: 'slow', count: 0, tags: [] })).toBeString();
	expect(bridge.answer('call', { mode: 'fast', count: 5, tags: [] })).toBeString();
	expect(bridge.answer('call', { mode: 'fast', count: 'not a number', tags: [] })).toBeString();
});

test('only one pending tool call with identical HTML can bind to the live dialog', () => {
	const { ui } = paneUi();
	const bridge = installAskBridge(ui, () => {});
	void ui.formDialog!(html, {});
	expect(bridge.bind('call-1', html)).toBe(true);
	expect(bridge.bind('call-2', html)).toBe(false);
});

test('clearing a checked default does not restore it, while hidden values remain immutable', async () => {
	const { ui } = paneUi();
	const bridge = installAskBridge(ui, () => {});
	const form =
		'<form><input type="hidden" name="revision" value="rev-1"><label><input type="checkbox" name="enabled" value="yes" checked>Enabled</label></form>';
	const shown = ui.formDialog!(form, {});
	expect(bridge.bind('unchecked', form)).toBe(true);
	expect(bridge.answer('unchecked', {})).toBeUndefined();
	expect(await shown).toEqual({ data: { revision: 'rev-1' } });
});

test('omitting a required control cannot silently accept its preselected default', async () => {
	const { ui } = paneUi();
	const bridge = installAskBridge(ui, () => {});
	const form = '<form><label>Workers <input type="number" name="workers" value="2" required min="0"></label></form>';
	const shown = ui.formDialog!(form, {});
	bridge.bind('required', form);
	expect(bridge.answer('required', {})).toBeString();
	expect(bridge.open()).toBeDefined();
	expect(bridge.answer('required', { workers: 0 })).toBeUndefined();
	expect(await shown).toEqual({ data: { workers: 0 } });
});
