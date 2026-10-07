// Battery 3: Platform & File System Quirks
// Comprehensive test suite for CRLF line-ending normalization, case sensitivity/collisions, and deep/quirky paths.
import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { inScope, normalizeRel, outOfScope } from '../../src/scope';
import { boundDiff, captureRevision, parseReview, scopeHash } from '../../src/review';
import {
	acquireOwnership,
	atomicWriteMission,
	loadMission,
	missionDirectory,
	missionPath,
	saveMission,
	validateMission,
	workspaceKey,
} from '../../src/store';
import { branchSlug } from '../../src/isolate';
import { assertNonOverlapping } from '../../src/workers';
import { agentName, fillCommand, writePromptFile, writeSourceFile } from '../../src/hosts';
import { parseMissionInput } from '../../src/sources';
import { lock } from '../../src/lock';
import { mutationText } from '../../src/subagent';
import type { Finding, Mission, Run, Source, Worker } from '../../src/types';

const tempDirs: string[] = [];
afterEach(async () => {
	await Promise.all(tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(prefix = 'battery3-fs-'): Promise<string> {
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
		id: 'battery3-mission-1',
		source: {
			kind: 'freeform',
			id: 'platform:freeform-1',
			title: 'Platform Target',
			body: 'Target body',
			comments: '',
			extra: '',
		},
		workspace: { key: 'ws-platform', cwd: '/tmp', delivery: 'local' },
		scopes: { 'bead-1': ['src/index.ts'] },
		phase: 'execute',
		evidence: {},
		mode: 'auto',
		keep: false,
		reviewRequested: false,
		workers: [],
		reviews: [],
		repairLinks: {},
		round: 0,
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		...overrides,
	};
}

describe('Battery 3: Platform & File System Quirks', () => {
	// ============================================================================
	// 1. CRLF Normalization & Line-Ending Agnosticism
	// ============================================================================
	describe('1. CRLF Normalization & Line-Ending Agnosticism', () => {
		test('parseReview parses review payloads with CRLF line endings in code fences, JSON bodies, and multiline text', () => {
			const rev = 'rev-crlf-1';
			const payloadObj = {
				reviewedRevision: rev,
				summary: 'CRLF Summary Heading\r\nLine two with details\r\nLine three concluded',
				findings: [
					{
						id: 'f-crlf-1',
						severity: 'high',
						path: 'src/windows/service.ts',
						line: 42,
						title: 'CRLF Line Ending Defect',
						body: 'Step 1: Inspect headers\r\nStep 2: Parse buffer\r\nStep 3: Handle \\r\\n safely',
					},
				],
			};
			const jsonString = JSON.stringify(payloadObj, null, 2).replace(/\n/g, '\r\n');

			// Case 1: Markdown code fence with CRLF
			const fencedCRLF = `\`\`\`json\r\n${jsonString}\r\n\`\`\`\r\n`;
			const parsedFenced = parseReview(fencedCRLF, rev);
			expect(parsedFenced.revision).toBe(rev);
			expect(parsedFenced.summary).toBe(payloadObj.summary);
			expect(parsedFenced.findings.length).toBe(1);
			expect(parsedFenced.findings[0]?.id).toBe('f-crlf-1');
			expect(parsedFenced.findings[0]?.body).toContain('\r\nStep 2: Parse buffer\r\n');

			// Case 2: Bare code fence with CRLF
			const bareFenced = `\`\`\`\r\n${jsonString}\r\n\`\`\``;
			const parsedBare = parseReview(bareFenced, rev);
			expect(parsedBare.summary).toBe(payloadObj.summary);

			// Case 3: Raw JSON text with CRLF line breaks
			const parsedRaw = parseReview(jsonString, rev);
			expect(parsedRaw.summary).toBe(payloadObj.summary);

			// Case 4: Validation through validateMission preserving CRLF state
			const mission = makeMission({
				reviews: [
					{
						round: 1,
						revision: rev,
						model: 'test/crlf-model',
						summary: parsedFenced.summary,
						findings: parsedFenced.findings,
						at: '2026-10-07T00:00:00.000Z',
					},
				],
			});
			const validated = validateMission(mission);
			expect(validated.reviews[0]?.summary).toBe(payloadObj.summary);
			expect(validated.reviews[0]?.findings[0]?.body).toBe(payloadObj.findings[0]?.body);
		});

		test('boundDiff correctly partitions and truncates git diffs containing CRLF line endings', () => {
			const diffCRLF = [
				'diff --git a/src/first.ts b/src/first.ts\r\n',
				'index 1111111..2222222 100644\r\n',
				'--- a/src/first.ts\r\n',
				'+++ b/src/first.ts\r\n',
				'@@ -1,3 +1,3 @@\r\n',
				'-const a = 1;\r\n',
				'+const a = 2;\r\n',
				'diff --git a/src/second.ts b/src/second.ts\r\n',
				'index 3333333..4444444 100644\r\n',
				'--- a/src/second.ts\r\n',
				'+++ b/src/second.ts\r\n',
				'@@ -1,3 +1,3 @@\r\n',
				'-const b = "old";\r\n',
				'+const b = "new";\r\n',
				'diff --git a/src/third.ts b/src/third.ts\r\n',
				'index 5555555..6666666 100644\r\n',
				'--- a/src/third.ts\r\n',
				'+++ b/src/third.ts\r\n',
				'@@ -1,3 +1,3 @@\r\n',
				'-const c = false;\r\n',
				'+const c = true;\r\n',
			].join('');

			// Case 1: Within limit preserves entire diff
			const full = boundDiff(diffCRLF, diffCRLF.length + 100);
			expect(full.omitted).toEqual([]);
			expect(full.diff).toBe(diffCRLF);

			// Case 2: Smaller limit omits files and strips carriage return from omitted paths
			const sectionLen = diffCRLF.indexOf('diff --git a/src/second.ts');
			const bounded = boundDiff(diffCRLF, sectionLen + 10);
			expect(bounded.omitted.length).toBeGreaterThan(0);
			for (const omittedPath of bounded.omitted) {
				// Must not contain trailing carriage return
				expect(omittedPath.endsWith('\r')).toBe(false);
				expect(['src/second.ts', 'src/third.ts']).toContain(omittedPath);
			}
		});

		test('scopeHash deterministically hashes CRLF, LF, and mixed line endings on disk', async () => {
			const ws = await makeTempDir('crlf-hash-ws-');
			const crlfFile = 'windows.txt';
			const lfFile = 'posix.txt';
			const mixedFile = 'mixed.txt';

			const crlfContent = 'Alpha\r\nBeta\r\nGamma\r\n';
			const lfContent = 'Alpha\nBeta\nGamma\n';
			const mixedContent = 'Alpha\r\nBeta\nGamma\r\n';

			await writeFile(join(ws, crlfFile), crlfContent);
			await writeFile(join(ws, lfFile), lfContent);
			await writeFile(join(ws, mixedFile), mixedContent);

			// Each file hashes reliably and deterministically
			const hash1 = await scopeHash(ws, [crlfFile]);
			const hash2 = await scopeHash(ws, [crlfFile]);
			expect(hash1).toBe(hash2);

			const hashLF = await scopeHash(ws, [lfFile]);
			const hashMixed = await scopeHash(ws, [mixedFile]);

			// Byte-level fidelity: CRLF and LF produce distinct SHA256 digests
			expect(hash1).not.toBe(hashLF);
			expect(hash1).not.toBe(hashMixed);
			expect(hashLF).not.toBe(hashMixed);

			// Multi-file scope order is deterministic regardless of passed array order
			const multiForward = await scopeHash(ws, [crlfFile, lfFile, mixedFile]);
			const multiReverse = await scopeHash(ws, [mixedFile, lfFile, crlfFile]);
			expect(multiForward).toBe(multiReverse);
		});

		test('captureRevision tracks CRLF workspace files and detects line-ending transitions as revision changes', async () => {
			const ws = await makeTempDir('crlf-rev-ws-');
			const filePath = join(ws, 'service.ts');

			// Write initial LF file
			await writeFile(filePath, 'export const host = "localhost";\nexport const port = 8080;\n');
			const mission = makeMission({
				workspace: { key: 'ws-crlf', cwd: ws, delivery: 'local' },
				scopes: { 'bd-1': ['service.ts'] },
			});

			const revLF = await captureRevision(mission, realRun);
			expect(revLF.files).toEqual(['service.ts']);

			// Rewrite with CRLF line endings (same text, different byte encoding)
			await writeFile(filePath, 'export const host = "localhost";\r\nexport const port = 8080;\r\n');
			const revCRLF = await captureRevision(mission, realRun);

			expect(revCRLF.files).toEqual(['service.ts']);
			expect(revCRLF.revision).not.toBe(revLF.revision);

			// Git-backed workspace mock with CRLF rev-parse and CRLF diff
			const gitMission = makeMission({
				workspace: { key: 'ws-crlf-git', cwd: ws, commonDir: join(ws, '.git'), delivery: 'pr' },
				scopes: { 'bd-1': ['service.ts'] },
			});
			const mockGitRun: Run = async (_cmd, args) => {
				if (args[0] === 'rev-parse') return { code: 0, stdout: '4b825dc642cb6eb9a060e54bf8d69288fbee4904\r\n', stderr: '' };
				if (args[0] === 'ls-files') return { code: 0, stdout: 'service.ts\0', stderr: '' };
				if (args[0] === 'diff') return { code: 0, stdout: 'diff --git a/service.ts b/service.ts\r\n+line\r\n', stderr: '' };
				return { code: 0, stdout: '', stderr: '' };
			};

			const gitRev = await captureRevision(gitMission, mockGitRun);
			expect(gitRev.files).toEqual(['service.ts']);
			expect(gitRev.diff).toContain('\r\n');
		});

		test('writePromptFile, writeSourceFile, and fillCommand handle CRLF strings cleanly', async () => {
			const crlfAssignment = 'Task Title\r\n\r\n1. Read specs\r\n2. Implement tests\r\n3. Verify results\r\n';
			const worker: Worker = {
				beadId: 'bd-crlf-worker',
				attempt: 'att-112233',
				cwd: '/tmp',
				files: ['src/task.ts'],
				state: 'reserved',
				assignment: crlfAssignment,
			};

			// Prompt file preservation
			const promptPath = await writePromptFile(worker);
			const promptContent = await readFile(promptPath, 'utf8');
			expect(promptContent).toBe(crlfAssignment);
			await rm(promptPath, { force: true });

			// Source file preservation
			const crlfSource: Source = {
				kind: 'freeform',
				id: 'freeform:crlf-task',
				title: 'CRLF Source Title',
				body: 'Line 1 body\r\nLine 2 body\r\nLine 3 body',
				comments: 'Comment 1\r\nComment 2',
				extra: 'Extra info\r\nMore extra',
			};
			const mission = makeMission({ id: 'crlf-ticket-1', source: crlfSource });
			const sourcePath = await writeSourceFile(mission);
			const sourceContent = await readFile(sourcePath, 'utf8');
			expect(sourceContent).toContain('Line 1 body\r\nLine 2 body\r\nLine 3 body');
			expect(sourceContent).toContain('Comment 1\r\nComment 2');
			await rm(sourcePath, { force: true });

			// fillCommand shell-quotes CRLF payload safely without bash syntax errors
			const multilinePayload = 'echo "hello"\r\nwhoami\r\necho "done"';
			const command = fillCommand('printf %s {prompt}', { prompt: multilinePayload });
			const runResult = await realRun('bash', ['-c', command], tmpdir());
			expect(runResult.code).toBe(0);
			expect(runResult.stdout).toBe(multilinePayload);
		});

		test('mission persistence roundtrips CRLF content in state without corruption', async () => {
			const root = await makeTempDir('crlf-store-');
			const m = makeMission({
				id: 'crlf-mission-1',
				workspace: { key: 'ws-crlf-store', cwd: root, delivery: 'local' },
				blocker: 'Line 1 blocker\r\nLine 2 blocker details',
				source: {
					kind: 'freeform',
					id: 'sec:crlf-store',
					title: 'CRLF Persistence',
					body: 'CRLF Body\r\nNext Line',
					comments: 'Comment A\r\nComment B',
					extra: 'Extra X\r\nExtra Y',
				},
				reviews: [
					{
						round: 1,
						revision: 'rev-store-1',
						model: 'model/v1',
						summary: 'Review Summary\r\nWith CRLF',
						findings: [
							{
								id: 'find-1',
								severity: 'medium',
								path: 'src/lib.ts',
								line: 10,
								title: 'Title',
								body: 'Finding body\r\nWith CRLF steps',
							},
						],
						at: '2026-10-07T00:00:00.000Z',
					},
				],
			});

			const filePath = missionPath(root, m);
			await saveMission(filePath, m);

			const loaded = await loadMission(filePath);
			expect(loaded.blocker).toBe('Line 1 blocker\r\nLine 2 blocker details');
			expect(loaded.source.body).toBe('CRLF Body\r\nNext Line');
			expect(loaded.source.comments).toBe('Comment A\r\nComment B');
			expect(loaded.reviews[0]?.summary).toBe('Review Summary\r\nWith CRLF');
			expect(loaded.reviews[0]?.findings[0]?.body).toBe('Finding body\r\nWith CRLF steps');

			// atomicWriteMission also preserves state
			await atomicWriteMission(filePath, loaded);
			const reloaded = await loadMission(filePath);
			expect(reloaded.reviews[0]?.findings[0]?.body).toBe('Finding body\r\nWith CRLF steps');
		});

		test('parseMissionInput and mutationText handle CRLF line endings', () => {
			const parsed = parseMissionInput('--force --keep -- \r\nFirst line task\r\nSecond line details\r\n');
			expect(parsed.force).toBe(true);
			expect(parsed.keep).toBe(true);
			expect(parsed.freeform).toBe('First line task Second line details');

			const messages = [
				{
					role: 'assistant',
					content: [
						{
							type: 'toolCall',
							name: 'write',
							arguments: { path: 'src/a.ts', content: 'hello\r\nworld\r\n' },
						},
						{
							type: 'toolCall',
							name: 'bash',
							arguments: { command: 'echo "a"\r\necho "b"\r\n' },
						},
					],
				},
			];
			const mutation = mutationText(messages);
			expect(mutation).toContain('hello\\r\\nworld\\r\\n');
			expect(mutation).toContain('echo \\"a\\"\\r\\necho \\"b\\"\\r\\n');
		});
	});

	// ============================================================================
	// 2. Case Sensitivity & Platform Collisions
	// ============================================================================
	describe('2. Case Sensitivity & Platform Collisions', () => {
		test('normalizeRel and inScope reject Windows drive letters across both uppercase and lowercase', () => {
			const driveLetterPaths = [
				'C:/Users/app/main.ts',
				'c:/Users/app/main.ts',
				'D:\\workspace\\project\\src\\index.ts',
				'd:\\workspace\\project\\src\\index.ts',
				'X:/data/config.json',
				'x:/data/config.json',
				'Z:\\root\\secret.env',
				'z:\\root\\secret.env',
			];

			for (const drivePath of driveLetterPaths) {
				expect(normalizeRel(drivePath)).toBe('');
				expect(inScope(drivePath, ['**'])).toBe(false);
				expect(inScope(drivePath, ['src/**'])).toBe(false);
				expect(inScope(drivePath, ['Users/**'])).toBe(false);
			}
		});

		test('normalizeRel and inScope reject mixed-case URL-encoded path traversals', () => {
			const encodedHostile = [
				'src/%2E%2E/outside.env',
				'src/%2e%2e/outside.env',
				'src/%2E%2e/outside.env',
				'src/%2e%2E/outside.env',
				'..%2F..%2Fetc/passwd',
				'..%2f..%2fetc/passwd',
				'..%5C..%5Cwindows/system32',
				'..%5c..%5cwindows/system32',
				'src/file.ts%00.bak',
			];

			for (const hostile of encodedHostile) {
				expect(normalizeRel(hostile)).toBe('');
				expect(inScope(hostile, ['src/**', '**'])).toBe(false);
			}
		});

		test('normalizeRel, inScope, and outOfScope enforce case sensitivity and preserve path casing', () => {
			// normalizeRel preserves casing verbatim
			expect(normalizeRel('Src\\Components\\Header.TSX')).toBe('Src/Components/Header.TSX');
			expect(normalizeRel('./SRC//nested/./File.ts/')).toBe('SRC/nested/File.ts');

			// Exact match case sensitivity
			expect(inScope('src/app.ts', ['src/app.ts'])).toBe(true);
			expect(inScope('SRC/app.ts', ['src/app.ts'])).toBe(false);
			expect(inScope('src/APP.ts', ['src/app.ts'])).toBe(false);

			// Directory prefix case sensitivity
			expect(inScope('src/nested/file.ts', ['src/nested'])).toBe(true);
			expect(inScope('SRC/nested/file.ts', ['src/nested'])).toBe(false);
			expect(inScope('src/Nested/file.ts', ['src/nested'])).toBe(false);

			// Glob matching case sensitivity
			expect(inScope('src/deep/file.ts', ['src/**/*.ts'])).toBe(true);
			expect(inScope('src/deep/file.TS', ['src/**/*.ts'])).toBe(false);
			expect(inScope('SRC/deep/file.ts', ['src/**/*.ts'])).toBe(false);

			// outOfScope filtering
			const candidates = ['src/a.ts', 'SRC/a.ts', 'src/B.TS', 'src/sub/c.ts'];
			expect(outOfScope(candidates, ['src/**/*.ts'])).toEqual(['SRC/a.ts', 'src/B.TS']);
		});

		test('assertNonOverlapping detects scope collisions across path separator variations while honoring casing', () => {
			// Collision detection across forward slash and backslash separators
			expect(() =>
				assertNonOverlapping([
					{ beadId: 'worker-1', cwd: '/workspace', files: ['src/utils/math.ts'] },
					{ beadId: 'worker-2', cwd: '/workspace', files: ['src\\utils\\math.ts'] },
				]),
			).toThrow(/overlap/);

			// Prefix collision across separators
			expect(() =>
				assertNonOverlapping([
					{ beadId: 'worker-1', cwd: '/workspace', files: ['src\\utils'] },
					{ beadId: 'worker-2', cwd: '/workspace', files: ['src/utils/math.ts'] },
				]),
			).toThrow(/overlap/);

			// Redundant ./ prefixes colliding
			expect(() =>
				assertNonOverlapping([
					{ beadId: 'worker-1', cwd: '/workspace', files: ['./src/dir/file.ts'] },
					{ beadId: 'worker-2', cwd: '/workspace', files: ['src/dir/file.ts'] },
				]),
			).toThrow(/overlap/);

			// Uppercase and lowercase drive letters in worker scopes are rejected
			expect(() =>
				assertNonOverlapping([
					{ beadId: 'worker-1', cwd: '/workspace', files: ['C:/src/app.ts'] },
				]),
			).toThrow(/workspace-relative/);
			expect(() =>
				assertNonOverlapping([
					{ beadId: 'worker-2', cwd: '/workspace', files: ['c:\\src\\app.ts'] },
				]),
			).toThrow(/workspace-relative/);

			// Distinct scopes differing by casing do not collide
			expect(() =>
				assertNonOverlapping([
					{ beadId: 'worker-1', cwd: '/workspace', files: ['src/moduleA/index.ts'] },
					{ beadId: 'worker-2', cwd: '/workspace', files: ['src/moduleB/index.ts'] },
				]),
			).not.toThrow();
		});

		test('workspaceKey, missionDirectory, and missionPath handle case variants and enforce isolation', async () => {
			const root = await makeTempDir('case-store-');

			// Valid keys with various casings
			expect(missionDirectory(root, 'ws-alpha')).toBe(join(root, 'missions', 'ws-alpha'));
			expect(missionDirectory(root, 'WS-ALPHA')).toBe(join(root, 'missions', 'WS-ALPHA'));
			expect(missionDirectory(root, 'Ws_Alpha.123')).toBe(join(root, 'missions', 'Ws_Alpha.123'));

			// Invalid characters blocked regardless of case
			for (const bad of ['WS/ALPHA', 'ws\\alpha', 'WS..ALPHA', 'ws\0alpha', '   ']) {
				expect(() => missionDirectory(root, bad)).toThrow(/Invalid mission workspace key/);
			}

			// missionPath preserves case of mission ID
			const mLower = makeMission({ id: 'linear-chr-42', workspace: { key: 'ws-test', cwd: root, delivery: 'local' } });
			const mUpper = makeMission({ id: 'LINEAR-CHR-42', workspace: { key: 'ws-test', cwd: root, delivery: 'local' } });
			expect(missionPath(root, mLower)).toBe(join(root, 'missions', 'ws-test', 'linear-chr-42.json'));
			expect(missionPath(root, mUpper)).toBe(join(root, 'missions', 'ws-test', 'LINEAR-CHR-42.json'));

			// workspaceKey produces deterministic 24-char hex slice
			const key1 = await workspaceKey(root);
			const key2 = await workspaceKey(root);
			expect(key1).toBe(key2);
			expect(key1.length).toBe(24);
		});

		test('branchSlug and agentName case transformations', () => {
			// branchSlug lowercases and sanitizes identifiers
			const sourceLinear: Source = {
				kind: 'linear',
				id: 'linear:CHR-42',
				title: 'Fix Bug',
				body: '',
				comments: '',
				extra: '',
			};
			expect(branchSlug(sourceLinear)).toBe('chr-42');

			const sourceGithub: Source = {
				kind: 'github',
				id: 'github:ACME/Enterprise-Project#99',
				repo: 'ACME/Enterprise-Project',
				number: 99,
				title: 'Feature',
				body: '',
				comments: '',
				extra: '',
			};
			expect(branchSlug(sourceGithub)).toBe('acme-enterprise-project-99');

			// agentName preserves valid alphanumeric and underscore case while enforcing naming convention
			const worker: Worker = {
				beadId: 'BEAD_CoreEngine_v2',
				attempt: 'ATT-998877',
				cwd: '/tmp',
				files: ['src/a.ts'],
				state: 'reserved',
				assignment: 'task',
			};
			const name = agentName(worker);
			expect(name).toBe('mission-BEAD_CoreEngine_v2-ATT998');
		});

		test('real filesystem case handling on disk: case distinct files in workspace', async () => {
			const ws = await makeTempDir('case-fs-ws-');
			const lowerFile = 'config.json';
			const upperFile = 'CONFIG.JSON';

			await writeFile(join(ws, lowerFile), '{"mode":"production"}');
			await writeFile(join(ws, upperFile), '{"mode":"DEVELOPMENT"}');

			const statLower = await stat(join(ws, lowerFile));
			const statUpper = await stat(join(ws, upperFile));

			// If filesystem is case-sensitive, both files coexist with distinct stats
			// If filesystem is case-preserving / insensitive (e.g. APFS/NTFS), stat succeeds
			expect(statLower.isFile()).toBe(true);
			expect(statUpper.isFile()).toBe(true);

			const hashLower = await scopeHash(ws, [lowerFile]);
			const hashUpper = await scopeHash(ws, [upperFile]);
			expect(typeof hashLower).toBe('string');
			expect(typeof hashUpper).toBe('string');

			const mission = makeMission({
				workspace: { key: 'ws-case', cwd: ws, delivery: 'local' },
				scopes: { 'bd-1': [lowerFile, upperFile] },
			});
			const rev = await captureRevision(mission, realRun);
			expect(rev.files).toContain(lowerFile);
		});
	});

	// ============================================================================
	// 3. Deep Paths & File System Quirks
	// ============================================================================
	describe('3. Deep Paths & File System Quirks', () => {
		test('normalizeRel and inScope handle extreme directory depths (50+ segments, > 300 chars)', () => {
			const segments = Array.from({ length: 60 }, (_, i) => `level_${i}`);
			const deepFile = `${segments.join('/')}/target_component.ts`;
			expect(deepFile.length).toBeGreaterThan(400);

			// Normalization preserves deep path
			const normalized = normalizeRel(deepFile);
			expect(normalized).toBe(deepFile);

			// inScope matches deep path against shallow prefix and globs
			expect(inScope(deepFile, ['level_0'])).toBe(true);
			expect(inScope(deepFile, ['level_0/**'])).toBe(true);
			expect(inScope(deepFile, [`${segments.slice(0, 10).join('/')}/**`])).toBe(true);
			expect(inScope(deepFile, ['level_0/other_branch'])).toBe(false);

			// Path traversal deep inside hierarchy is caught and rejected
			const hostileDeep = `${segments.slice(0, 30).join('/')}/../../../../../../outside.ts`;
			expect(normalizeRel(hostileDeep)).toBe('');
			expect(inScope(hostileDeep, ['level_0/**'])).toBe(false);

			// outOfScope handles deep paths accurately
			const deepSafe = `${segments.join('/')}/safe.ts`;
			const deepTraverse = `${segments.join('/')}/../evil.ts`;
			expect(outOfScope([deepSafe, deepTraverse], ['level_0/**'])).toEqual([deepTraverse]);
		});

		test('atomic writes, locks, and mission persistence operate cleanly in deeply nested directory trees', async () => {
			const root = await makeTempDir('deep-store-');
			const deepSubtree = Array.from({ length: 15 }, (_, i) => `dir_${i}`).join('/');
			const deepAgentDir = join(root, deepSubtree);
			await mkdir(deepAgentDir, { recursive: true });

			const m = makeMission({
				id: 'deep-mission-1',
				workspace: { key: 'ws-deep', cwd: root, delivery: 'local' },
				scopes: { 'bd-deep': ['deep/path/to/nested/file.ts'] },
			});

			// missionPath inside deep hierarchy
			const mPath = missionPath(deepAgentDir, m);
			expect(mPath.length).toBeGreaterThan(150);

			// atomicWriteMission and saveMission in deep path
			await saveMission(mPath, m);
			const loaded = await loadMission(mPath);
			expect(loaded.id).toBe('deep-mission-1');
			expect(loaded.scopes['bd-deep']).toEqual(['deep/path/to/nested/file.ts']);

			// acquireOwnership and lock in deep path
			const ownership = await acquireOwnership(mPath, loaded);
			expect(ownership.nonce).toBeDefined();

			const lockedMission = await loadMission(mPath);
			expect(lockedMission.controllerNonce).toBe(ownership.nonce);

			await ownership.release();
			const releasedMission = await loadMission(mPath);
			expect(releasedMission.controllerNonce).toBeUndefined();

			// Native file lock in deep path
			const deepLockTarget = join(deepAgentDir, 'resource.data');
			const releaseLock = await lock(deepLockTarget, { stale: 5000 });
			const lockStat = await stat(`${deepLockTarget}.lock`);
			expect(lockStat.isDirectory()).toBe(true);
			await releaseLock();
			await expect(stat(`${deepLockTarget}.lock`)).rejects.toThrow();
		});

		test('redundant path separators, dot segments, and mixed slashes', () => {
			// Consecutive slashes
			expect(normalizeRel('src///components////buttons/////Primary.tsx')).toBe('src/components/buttons/Primary.tsx');

			// Consecutive backslashes
			expect(normalizeRel('src\\\\components\\\\buttons\\\\Primary.tsx')).toBe('src/components/buttons/Primary.tsx');

			// Mixed slashes
			expect(normalizeRel('src\\components/buttons\\Primary.tsx')).toBe('src/components/buttons/Primary.tsx');

			// Redundant ./ and current directory segments
			expect(normalizeRel('./src/./components/./buttons/./Primary.tsx')).toBe('src/components/buttons/Primary.tsx');
			expect(normalizeRel('./././src//dir/./file.ts')).toBe('src/dir/file.ts');

			// Trailing slashes
			expect(normalizeRel('src/components/buttons/')).toBe('src/components/buttons');
			expect(normalizeRel('src/components/buttons///')).toBe('src/components/buttons');

			// Degenerate inputs normalizing to empty string
			expect(normalizeRel('')).toBe('');
			expect(normalizeRel('.')).toBe('');
			expect(normalizeRel('./')).toBe('');
			expect(normalizeRel('.///')).toBe('');
			expect(normalizeRel('///')).toBe('');
			expect(normalizeRel('\\\\\\')).toBe('');
		});

		test('quirky characters, multi-byte UTF-8, spaces, and Windows device names', async () => {
			const ws = await makeTempDir('quirk-chars-ws-');

			// 1. Paths with spaces
			const spacedPath = 'enterprise suite/core modules/data grid component.tsx';
			expect(normalizeRel(spacedPath)).toBe(spacedPath);
			expect(inScope(spacedPath, ['enterprise suite/**'])).toBe(true);

			// 2. Multi-byte UTF-8, Japanese characters, and emojis
			const utf8Path = 'src/日本語/🚀_core/tëst_file.ts';
			expect(normalizeRel(utf8Path)).toBe(utf8Path);
			expect(inScope(utf8Path, ['src/日本語/**'])).toBe(true);

			// 3. Special valid symbols
			const specialSymbolsPath = 'src/@scoped/pkg+v2/#1_build~bak.ts';
			expect(normalizeRel(specialSymbolsPath)).toBe(specialSymbolsPath);
			expect(inScope(specialSymbolsPath, ['src/@scoped/**'])).toBe(true);

			// 4. Windows reserved device names as relative filenames
			for (const devName of ['con.ts', 'aux.ts', 'nul.ts', 'prn.ts', 'com1.ts', 'lpt1.ts']) {
				expect(normalizeRel(`src/${devName}`)).toBe(`src/${devName}`);
				expect(inScope(`src/${devName}`, ['src/**'])).toBe(true);
			}

			// Real files on disk with spaces and multi-byte UTF-8 paths
			const fullSpaced = join(ws, 'folder with spaces', 'file with spaces.txt');
			const fullUtf8 = join(ws, 'src', '日本語', '🚀_core');
			await mkdir(join(ws, 'folder with spaces'), { recursive: true });
			await mkdir(fullUtf8, { recursive: true });

			await writeFile(fullSpaced, 'spaced content');
			await writeFile(join(fullUtf8, 'tëst_file.ts'), 'export const greeting = "こんにちは世界";\n');

			// scopeHash on spaced and multi-byte UTF-8 files
			const spacedRel = 'folder with spaces/file with spaces.txt';
			const utf8Rel = 'src/日本語/🚀_core/tëst_file.ts';

			const hashSpaced = await scopeHash(ws, [spacedRel]);
			const hashUtf8 = await scopeHash(ws, [utf8Rel]);
			expect(typeof hashSpaced).toBe('string');
			expect(typeof hashUtf8).toBe('string');

			// captureRevision on spaced and UTF-8 files
			const m = makeMission({
				workspace: { key: 'ws-quirks', cwd: ws, delivery: 'local' },
				scopes: { 'bd-1': [spacedRel, utf8Rel] },
			});
			const rev = await captureRevision(m, realRun);
			expect(rev.files).toEqual([spacedRel, utf8Rel].sort());
		});

		test('complex directory structures with symlinks, 0-byte files, and missing entries', async () => {
			const ws = await makeTempDir('complex-tree-ws-');
			const outside = await makeTempDir('complex-outside-');

			const subDir = join(ws, 'deep', 'nested', 'tree');
			await mkdir(subDir, { recursive: true });

			const emptyFile = join(subDir, 'empty.txt');
			const validFile = join(subDir, 'valid.txt');
			const internalSymlink = join(subDir, 'link-internal.txt');
			const escapingSymlink = join(subDir, 'link-leak.txt');
			const outsideFile = join(outside, 'secret.env');

			await writeFile(emptyFile, '');
			await writeFile(validFile, 'valid content');
			await writeFile(outsideFile, 'TOP_SECRET=1');

			// Internal symlink pointing inside workspace
			await symlink(validFile, internalSymlink);
			// Escaping symlink pointing outside workspace
			await symlink(outsideFile, escapingSymlink);

			// Safe mission capturing internal symlink, 0-byte file, and missing file
			const safeMission = makeMission({
				workspace: { key: 'ws-tree', cwd: ws, delivery: 'local' },
				scopes: {
					'bd-1': [
						'deep/nested/tree/empty.txt',
						'deep/nested/tree/valid.txt',
						'deep/nested/tree/link-internal.txt',
						'deep/nested/tree/missing.txt',
					],
				},
			});

			const revSafe = await captureRevision(safeMission, realRun);
			expect(revSafe.files.length).toBe(4);
			expect(revSafe.revision).toBeDefined();

			// Escaping symlink is detected and throws
			const hostileMission = makeMission({
				workspace: { key: 'ws-tree', cwd: ws, delivery: 'local' },
				scopes: {
					'bd-leak': ['deep/nested/tree/link-leak.txt'],
				},
			});

			await expect(captureRevision(hostileMission, realRun)).rejects.toThrow(/escapes workspace/);
		});

		test('boundDiff partitions high volume of deeply nested file diffs without memory or stack failure', () => {
			const fileCount = 150;
			const diffParts: string[] = [];

			for (let i = 0; i < fileCount; i++) {
				const deepPath = `packages/module_${i}/src/nested/deep/service_${i}.ts`;
				diffParts.push(
					`diff --git a/${deepPath} b/${deepPath}\n` +
					`index 1111111..2222222 100644\n` +
					`--- a/${deepPath}\n` +
					`+++ b/${deepPath}\n` +
					`@@ -1,2 +1,2 @@\n` +
					`-const val${i} = 0;\n` +
					`+const val${i} = 1;\n`
				);
			}

			const largeDiff = diffParts.join('');
			const limit = 4000; // Small limit to force omission of most files
			const bounded = boundDiff(largeDiff, limit);

			expect(bounded.diff.length).toBeLessThanOrEqual(limit);
			expect(bounded.omitted.length).toBeGreaterThan(100);

			// Every omitted file name is correctly extracted and formatted
			for (const omittedPath of bounded.omitted) {
				expect(omittedPath).toMatch(/^packages\/module_\d+\/src\/nested\/deep\/service_\d+\.ts$/);
			}
		});
	});
});
