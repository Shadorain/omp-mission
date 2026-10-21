import { expect, test } from 'bun:test';
import { askQuestions } from '../src/holotable';

test('an ask call publishes each question with its option labels in dialog order', () => {
	expect(
		askQuestions([
			{
				id: 'scope',
				question: 'How far?',
				options: [{ label: 'Status only' }, { label: 'Status + send' }],
				recommended: 0,
			},
			{ id: 'tags', question: 'Which?', options: [{ label: 'a' }, { label: 'b' }], multi: true, recommended: 5 },
		]),
	).toEqual([
		{ question: 'How far?', options: ['Status only', 'Status + send'], recommended: 0, multi: false },
		// An out-of-range recommendation is no recommendation: the dialog's cursor would not start there.
		{ question: 'Which?', options: ['a', 'b'], recommended: null, multi: true },
	]);
});

test('malformed questions are dropped rather than published with guessed options', () => {
	expect(
		askQuestions([
			{ question: 'No options' },
			{ question: '', options: [] },
			{ question: 'Bad', options: [{ text: 'x' }] },
		]),
	).toEqual([]);
	expect(askQuestions('nope')).toEqual([]);
});
