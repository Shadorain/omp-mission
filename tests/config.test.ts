import { expect, test } from 'bun:test';
import { validateMissionConfig } from '../src/config';

test('compact transcript cards are opt-in and validated as a boolean setting', () => {
	expect(validateMissionConfig({ version: 1 }).compactTranscript).toBe(false);
	expect(validateMissionConfig({ version: 1, compactTranscript: true }).compactTranscript).toBe(true);
	expect(() => validateMissionConfig({ version: 1, compactTranscript: 'on' })).toThrow();
});
