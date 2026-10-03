import { expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionManager } from '@oh-my-pi/pi-coding-agent';
import { getTerminalSessionsDir } from '@oh-my-pi/pi-utils';
import { openUnlistedSession } from '../src/session-file';

// `omp -c` resumes the terminal's breadcrumb. A bead worker or reviewer that records itself there hijacks the coordinator's terminal.
test('an unlisted session never becomes the terminal session that omp -c resumes', async () => {
	if (process.stdin.isTTY) return; // the terminal id then comes from the tty, which a test must not overwrite
	const previousPane = process.env.TMUX_PANE;
	process.env.TMUX_PANE = `%mission-test-${crypto.randomUUID()}`;
	const crumb = join(getTerminalSessionsDir(), `tmux-${process.env.TMUX_PANE}`);
	const dir = await mkdtemp(join(tmpdir(), 'unlisted-'));
	try {
		const hidden = await openUnlistedSession(dir, dir);
		await hidden.setSessionName('worker', 'user');
		expect(existsSync(hidden.getSessionFile() ?? '')).toBe(true);
		expect(existsSync(crumb)).toBe(false);
		const resumed = await openUnlistedSession(dir, dir, hidden.getSessionFile());
		expect(resumed.getSessionFile()).toBe(hidden.getSessionFile());
		expect(existsSync(crumb)).toBe(false);
		// Control: an ordinary session does record the breadcrumb, so the assertions above prove something.
		SessionManager.create(dir, dir);
		expect(existsSync(crumb)).toBe(true);
	} finally {
		await rm(crumb, { force: true });
		await rm(dir, { recursive: true, force: true });
		if (previousPane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = previousPane;
	}
});
