import { expect, test } from 'bun:test';
import { parseBoardData } from '../src/ask-bridge';

test('socket form data accepts only serializable HTML form values', () => {
	expect(parseBoardData({ choice: 'a', count: 0, tags: ['x', 'y'], blank: '' })).toEqual({
		choice: 'a',
		count: 0,
		tags: ['x', 'y'],
		blank: '',
	});
	expect(parseBoardData(null)).toBeUndefined();
	expect(parseBoardData(['not', 'an object'])).toBeUndefined();
	expect(parseBoardData({ invalid: Number.NaN })).toBeUndefined();
	expect(parseBoardData({ invalid: [1] })).toBeUndefined();
});
