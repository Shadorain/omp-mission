import { expect, test } from 'bun:test';
import type { ExtensionAskDialogQuestion, ExtensionAskDialogResult, ExtensionUIContext } from '@oh-my-pi/pi-coding-agent';
import { buildResult, installAskBridge } from '../src/ask-bridge';

const questions: ExtensionAskDialogQuestion[] = [
 { id: 'scope', question: 'How far?', options: [{ label: 'Status only' }, { label: 'Status + send' }], recommended: 0 },
 { id: 'tags', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }, { label: 'c' }], multi: true },
];

/** A pane dialog that only ever ends by abort, like a user who walked away. */
function paneUi() {
 const seen: { signal?: AbortSignal } = {};
 const ui = {
  askDialog: (_q: ExtensionAskDialogQuestion[], options?: { signal?: AbortSignal }) => {
   seen.signal = options?.signal;
   return new Promise<ExtensionAskDialogResult | undefined>(resolve => options?.signal?.addEventListener('abort', () => resolve(undefined)));
  },
 } as unknown as ExtensionUIContext;
 return { ui, seen };
}

test('a board answer settles the open dialog, closes the pane side and is what the ask tool receives', async () => {
 const { ui, seen } = paneUi();
 let changes = 0;
 const bridge = installAskBridge(ui, () => { changes++; });
 expect(bridge.answer([{ option: 0 }, { options: [0] }])).toBe('No ask dialog is open in the pane');
 const shown = ui.askDialog!(questions, {});
 expect(bridge.open()).toBe(questions);
 expect(bridge.answer([{ option: 5 }, { options: [0] }])).toBe('Question 1 has no option 5');
 expect(bridge.answer([{ text: 'just status' }, { options: [2, 0] }])).toBeUndefined();
 expect(await shown).toEqual({ kind: 'submit', results: [
  { id: 'scope', question: 'How far?', options: ['Status only', 'Status + send'], multi: false, selectedOptions: [], customInput: 'just status' },
  { id: 'tags', question: 'Which?', options: ['a', 'b', 'c'], multi: true, selectedOptions: ['c', 'a'] },
 ] });
 expect(seen.signal?.aborted).toBe(true);
 expect(bridge.open()).toBeUndefined();
 expect(changes).toBe(2);
 // Installing twice keeps one wrapper.
 expect(installAskBridge(ui, () => {})).toBe(bridge);
});

test('answers that do not fit the questions are refused before anything settles', () => {
 expect(buildResult(questions, [{ option: 0 }])).toBe('Answer all 2 questions');
 expect(buildResult(questions, [{ options: [0] }, { options: [0] }])).toBe('Question 1 takes one option');
 expect(buildResult(questions, [{ text: '  ' }, { options: [0] }])).toBe('Question 1 needs an option or some text');
});
