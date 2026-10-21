/**
 * Standalone benchmark for UsageProbe: incremental transcript reads and 4 MiB budget.
 * bun examples/benchmark-usage.ts
 * Prints one JSON object; exit 1 when a gate fails. Temp fixtures only.
 * Run under the service quota with systemd-run -p CPUQuota=25% -p MemoryMax=2G.
 */
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UsageProbe } from '../src/holotable.ts';
import type { Mission } from '../src/types.ts';

const rchar = () => Number(readFileSync('/proc/self/io', 'utf8').match(/rchar: (\d+)/)![1]);
const cpu = () => {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1000;
};
const rss = () => process.memoryUsage().rss;
const percentile = (xs: number[], p: number) => {
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.ceil(s.length * p) - 1)];
};
const dist = (xs: number[]) => ({ p50: percentile(xs, 0.5), p95: percentile(xs, 0.95), max: Math.max(...xs) });
const gateReport: Record<string, { value: number; budget: number; unit: string; pass: boolean }> = {};
const failures: string[] = [];
const gate = (name: string, value: number, budget: number, unit = 'ms') => {
	const pass = value <= budget;
	if (!pass) failures.push(`${name}: ${value}${unit} > ${budget}${unit}`);
	gateReport[name] = { value, budget, unit, pass };
};

const dir = mkdtempSync(join(tmpdir(), 'usage-bench-'));
const WORKERS = 8,
	BYTES_PER_FILE = 256 * 1024,
	COORD_ENTRIES = 5_000;
const assistant = () =>
	JSON.stringify({
		type: 'message',
		message: {
			role: 'assistant',
			usage: { input: 100, output: 50, cacheRead: 10, cacheWrite: 0, cost: { total: 0.001 } },
		},
	}) + '\n';

try {
	const base = join(dir, 'missions', 'benchws');
	const workerDir = join(base, 'workers'),
		reviewDir = join(base, 'reviews', 'bench-m1');
	mkdirSync(workerDir, { recursive: true });
	mkdirSync(reviewDir, { recursive: true });
	const line = assistant();
	const fill = (path: string, bytes: number) => {
		let text = '';
		while (text.length < bytes) text += line;
		writeFileSync(path, text);
		return text.length;
	};
	const workerFiles: string[] = [];
	let fixtureBytes = 0;
	for (let i = 0; i < WORKERS; i++) {
		const f = join(workerDir, `w${i}.jsonl`);
		fixtureBytes += fill(f, BYTES_PER_FILE);
		workerFiles.push(f);
	}
	const reviewFile = join(reviewDir, 'r1.jsonl');
	fixtureBytes += fill(reviewFile, BYTES_PER_FILE);
	// A >1 MiB line exercises the discard path without ever buffering the line.
	const badFile = join(workerDir, 'bad.jsonl');
	writeFileSync(badFile, 'x'.repeat(1024 * 1024 + 16) + '\n' + assistant());
	workerFiles.push(badFile);
	fixtureBytes += 1024 * 1024 + 16 + line.length;

	const mission: Mission = {
		version: 1,
		id: 'bench-m1',
		graph: 'beads',
		round: 1,
		mode: 'auto',
		keep: false,
		reviewRequested: true,
		phase: 'execute',
		createdAt: '2026-01-01T00:00:00Z',
		updatedAt: '2026-01-01T00:10:00Z',
		source: { kind: 'freeform', id: 'bench', title: 'Bench', body: '', comments: '', extra: '' },
		workspace: { key: 'benchws', cwd: dir, delivery: 'local' },
		scopes: {},
		evidence: {},
		workers: workerFiles.map((f, i) => ({
			beadId: `b${i}`,
			attempt: 'a',
			cwd: dir,
			files: ['x'],
			state: 'closed' as const,
			assignment: '',
			frontend: 'subagent' as const,
			incarnationId: f,
		})),
		reviews: [{ round: 1, revision: 'r1', model: 'm', summary: '', findings: [], at: '2026-01-01T00:05:00Z' }],
		repairLinks: {},
	};
	const entries = Array.from({ length: COORD_ENTRIES }, () => ({
		type: 'message',
		message: {
			role: 'assistant',
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: { total: 0.0001 } },
		},
	}));
	const coordinator = () => ({ sessionFile: 'coord-session', entries });

	// Cold: a fresh probe reads the whole fixture once, within budget.
	const coldMs: number[] = [],
		coldReads: number[] = [];
	let coldRss = rss();
	for (let i = 0; i < 10; i++) {
		const probe = new UsageProbe(dir);
		const b0 = rchar(),
			c0 = cpu();
		const measured = await probe.measure(mission, coordinator, true);
		coldMs.push(cpu() - c0);
		coldReads.push(rchar() - b0);
		if (!measured.usage?.tokens.input) failures.push('cold measure produced no usage');
		if (measured.evidence.malformedLines !== 1)
			failures.push(`malformedLines ${measured.evidence.malformedLines} != 1`);
	}
	gate('cold cpu p95', percentile(coldMs, 0.95), 1000);
	gate('cold read bytes vs fixture', percentile(coldReads, 0.95), fixtureBytes + 64 * 1024, 'B');
	gate('cold rss growth', Math.round((rss() - coldRss) / 1_048_576), 32, 'MiB');

	// Warm: same probe, unchanged files → high-water offsets mean ~zero file reads.
	const probe = new UsageProbe(dir);
	await probe.measure(mission, coordinator, true);
	const warmReads: number[] = [],
		warmMs: number[] = [];
	for (let i = 0; i < 20; i++) {
		const b0 = rchar(),
			c0 = cpu();
		await probe.measure(mission, coordinator, true);
		warmReads.push(rchar() - b0);
		warmMs.push(cpu() - c0);
	}
	gate('warm cpu p95', percentile(warmMs, 0.95), 250);
	gate('warm read bytes', Math.max(...warmReads), 4 * 1024, 'B');

	// Throttle: a repeat inside the 30s window without force does no work at all.
	const t0 = rchar();
	const cached = await probe.measure(mission, coordinator);
	const inputBefore = cached.usage?.tokens.input ?? 0;
	gate('throttled read bytes', rchar() - t0, 4 * 1024, 'B');

	// Append: ~32 KiB of complete lines → only the appended bytes are re-read.
	// A mid-line tail would be a real partial write and honestly count as backlog.
	const appended = Math.floor((32 * 1024) / line.length) * line.length;
	let text = '';
	while (text.length < appended) text += line;
	appendFileSync(workerFiles[0]!, text.slice(0, appended));
	const a0 = rchar(),
		ac = cpu();
	const after = await probe.measure(mission, coordinator, true);
	gate('append cpu', cpu() - ac, 500);
	gate('append read bytes vs delta', rchar() - a0, appended + 8 * 1024, 'B');
	const appendedLines = appended / line.length;
	if ((after.usage?.tokens.input ?? 0) !== inputBefore + appendedLines * 100)
		failures.push(`append delta input ${after.usage?.tokens.input} != ${inputBefore + appendedLines * 100}`);
	writeFileSync(workerFiles[1]!, assistant());
	const rotated = await probe.measure(mission, coordinator, true);
	if (rotated.evidence.resets < 1) failures.push('rotation not detected as reset');
	if (!rotated.evidence.partial) failures.push('reset should mark evidence partial');

	// Budget: an extra 8 MiB file exceeds the 4 MiB per-call budget → backlog recorded.
	const bigFile = join(workerDir, 'big.jsonl');
	fixtureBytes += fill(bigFile, 8 * 1024 * 1024);
	mission.workers.push({
		beadId: 'big',
		attempt: 'a',
		cwd: dir,
		files: ['x'],
		state: 'closed',
		assignment: '',
		frontend: 'subagent',
		incarnationId: bigFile,
	});
	const fresh = new UsageProbe(dir);
	const limited = await fresh.measure(mission, coordinator, true);
	if (limited.evidence.backlogBytes < 4 * 1024 * 1024) failures.push(`backlogBytes ${limited.evidence.backlogBytes}`);
	gate('budgeted cold cpu', percentile(coldMs, 0.95), 1000);

	console.log(
		JSON.stringify({
			tool: 'benchmark-usage',
			bun: Bun.version,
			fixtureBytes,
			cold: { ms: dist(coldMs), bytes: dist(coldReads) },
			warm: { ms: dist(warmMs), bytes: dist(warmReads) },
			resets: rotated.evidence.resets,
			backlogBytes: limited.evidence.backlogBytes,
			gates: gateReport,
			failures,
		}),
	);
} finally {
	rmSync(dir, { recursive: true, force: true });
}
if (failures.length) process.exit(1);
