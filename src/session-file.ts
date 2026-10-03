import { join } from 'node:path';
import { SessionManager } from '@oh-my-pi/pi-coding-agent';

/**
 * A persisted session that `omp --continue` can never resume. SessionManager.create and open record the
 * terminal's "last session", so a bead worker or reviewer created while the coordinator runs would take
 * that slot: the next `omp -c` in the same terminal reopened a finished worker's transcript as the
 * coordinator. Pass `file` to reopen an existing transcript.
 */
export function openUnlistedSession(cwd: string, dir: string, file?: string): Promise<SessionManager> {
	const target = file ?? join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}_${crypto.randomUUID()}.jsonl`);
	return SessionManager.open(target, dir, undefined, { suppressBreadcrumb: true, initialCwd: cwd });
}
