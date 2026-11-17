export type MissionNavigation =
	| { missionId: string; view: 'status' | 'plan' }
	| { missionId: string; view: 'work'; beadId: string };

const LINK = /^mission:\/\/([A-Za-z0-9_-]{1,128})\/(status|plan|work)(?:\/([A-Za-z0-9][A-Za-z0-9_.:-]{0,127}))?$/;

export function parseMissionNavigation(value: string): MissionNavigation | undefined {
	const match = LINK.exec(value);
	if (!match) return undefined;
	if (match[2] === 'work') return match[3] ? { missionId: match[1]!, view: 'work', beadId: match[3] } : undefined;
	if (match[3]) return undefined;
	return { missionId: match[1]!, view: match[2] as 'status' | 'plan' };
}
