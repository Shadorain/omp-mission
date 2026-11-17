import { expect, test } from 'bun:test';
import { parseMissionNavigation } from '../src/navigation';

test('mission navigation accepts only the current inspector routes', () => {
	expect(parseMissionNavigation('mission://mission-1/status')).toEqual({ missionId: 'mission-1', view: 'status' });
	expect(parseMissionNavigation('mission://mission-1/plan')).toEqual({ missionId: 'mission-1', view: 'plan' });
	expect(parseMissionNavigation('mission://mission-1/work/bead-2')).toEqual({
		missionId: 'mission-1',
		view: 'work',
		beadId: 'bead-2',
	});
});

test('mission navigation rejects mutations, paths, and URL tricks', () => {
	for (const value of [
		'mission://mission-1/approve',
		'mission://mission-1/clear',
		'mission://mission-1/work/../../etc/passwd',
		'mission://mission-1/status?approve=true',
		'mission://user@mission-1/status',
		'mission://mission-1:443/status',
		'mission://mission-1/%2e%2e/status',
		'mission://mission-1/work/bead/extra',
	])
		expect(parseMissionNavigation(value)).toBeUndefined();
});
