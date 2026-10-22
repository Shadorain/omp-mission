/**
 * Recapture the README screenshots from the real TUI.
 *
 *   bun run screens            # rewrite docs/screens/*.webp
 *   bun run screens --text     # print the captured screens as plain text instead
 *
 * Each scene saves a generic mission (and, for the beads graph, a real `bd` graph) in a throwaway
 * PI_CODING_AGENT_DIR under the system temp directory, resumes it in a real `omp` that loads this
 * checkout's extension inside a pseudo-terminal, types what a person would, and reads the screen
 * back through a headless xterm. omp runs with a clean environment and an empty HOME, so it finds
 * no credentials and never calls a model. Panels are cut from those screens, laid out as HTML in
 * the dark-cosmos colours the TUI emitted, and screenshotted at 2x with headless Chromium.
 *
 * Needs `omp`, `bd`, `git`, the JetBrainsMono Nerd Font and Chromium or Chrome (set CHROME to
 * choose the binary).
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SessionManager } from '@oh-my-pi/pi-coding-agent';
import { type IBufferCell, Terminal } from '@xterm/headless';
import puppeteer from 'puppeteer-core';
import { missionPath, saveMission } from '../src/store';
import type { Mission } from '../src/types';

const REPO = resolve(import.meta.dir, '..');
const COLS = 110;
const ROWS = 40;
const KEY = {
	expand: '\x1b[109;6u', // ctrl+shift+m in the kitty keyboard protocol
	clearLine: '\x15',
	enter: '\r',
	tab: '\t',
	escape: '\x1b',
};

// ---------------------------------------------------------------- fixtures

const TICKET = 'ENG-123';
const TITLE = 'Migrate user auth off the legacy session table';
const REVISION = 'a1b2c3d4';
const AT = '2026-01-01T00:00:00Z';

type Scene = 'running' | 'gate' | 'repair' | 'complete';

async function sh(cwd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
	const proc = Bun.spawn(args, { cwd, env: { ...process.env, ...env }, stdout: 'pipe', stderr: 'pipe' });
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if (code !== 0) throw new Error(`${args.join(' ')} failed (${code}): ${err || out}`);
	return out.trim();
}

const passed = (detail: string) => ({ outcome: 'passed' as const, detail, revision: REVISION, at: AT });

/**
 * The same mission at each stop: an epic of six scoped leaves. While running, two are done and two
 * in progress; at the gate those two are ready; after delivery all six are closed.
 */
async function beadGraph(cwd: string, mission: Mission, scene: Scene) {
	await sh(cwd, ['git', 'init', '-q']);
	await sh(cwd, ['bd', 'init', '-p', 'bd', '--non-interactive', '--quiet']);
	const bd = (...args: string[]) => sh(cwd, ['bd', ...args], { BEADS_DIR: join(cwd, '.beads') });
	const epic = 'bd-a7f';
	await bd('create', TITLE, '-t', 'epic', '--id', epic, '--silent');
	const leaves = [
		['Add the session table migration', 'db/migrations/0042_sessions.sql'],
		['Backfill existing sessions', 'scripts/backfill-sessions.ts'],
		['Update auth middleware', 'src/auth/middleware.ts'],
		['Update login handler', 'src/auth/login.ts'],
		['Add unit tests for the session cookie', 'tests/session-cookie.test.ts'],
		['Drop the legacy table', 'db/migrations/0043_drop_legacy.sql'],
	] as const;
	// Children of an explicit epic ID are numbered in order: bd-a7f.1, bd-a7f.2, …
	const ids: string[] = [];
	for (const [title] of leaves) ids.push(await bd('create', title, '--parent', epic, '--silent'));
	await bd('dep', 'add', ids[4]!, ids[2]!);
	await bd('dep', 'add', ids[5]!, ids[3]!);
	const delivered = scene === 'repair' || scene === 'complete';
	for (const id of delivered ? ids : ids.slice(0, 2)) await bd('close', id);
	if (scene === 'running') for (const id of ids.slice(2, 4)) await bd('update', id, '--status', 'in_progress');
	mission.graph = 'beads';
	mission.epicId = epic;
	mission.workspace.beadsDir = join(cwd, '.beads');
	mission.scopes = Object.fromEntries(ids.map((id, index) => [id, [leaves[index]![1]]]));
	mission.evidence.isolate = { outcome: 'passed', detail: 'Worktree mission/eng-123 from main', at: AT };
	mission.evidence.graph = { outcome: 'passed', detail: `Epic ${epic}; scoped leaves ${ids.join(', ')}`, at: AT };
}

/** Saves the scene's mission and a session that points at it; returns the session file to resume. */
async function fixture(scene: Scene, root: string): Promise<string> {
	const cwd = join(root, 'workspace');
	await mkdir(cwd, { recursive: true });
	await writeFile(
		join(root, 'config.yml'),
		'symbolPreset: nerd\ntheme:\n  dark: dark-cosmos\nstartup:\n  checkUpdate: false\n',
	);
	const mission: Mission = {
		version: 1,
		id: 'eng-123-demo',
		round: 1,
		keep: false,
		workers: [],
		reviews: [],
		repairLinks: {},
		source: {
			kind: 'linear',
			id: `linear:${TICKET}`,
			title: TITLE,
			body: 'Move session lookups to the new table, then drop the old one.',
			comments: '',
			extra: '',
		},
		workspace: { key: 'demo', cwd, delivery: 'pr' },
		scopes: {},
		phase: 'execute',
		mode: 'auto',
		reviewRequested: false,
		evidence: { plan: { outcome: 'passed', detail: 'Operator approved plan', at: AT } },
		createdAt: AT,
		updatedAt: AT,
	};
	await beadGraph(cwd, mission, scene);
	if (scene === 'gate') mission.mode = 'pause';
	if (scene === 'repair' || scene === 'complete') {
		mission.phase = scene === 'complete' ? 'complete' : 'review';
		mission.mode = scene === 'repair' ? 'pause' : 'auto';
		mission.reviewRequested = true;
		mission.evidence.verify = passed('bun test: 214 passed');
		mission.evidence.deliver = passed('https://github.com/acme/webapp/pull/482');
		mission.reviews = [
			{
				round: 1,
				revision: REVISION,
				model: 'reviewer',
				summary: scene === 'complete' ? 'No blocking findings' : 'One confirmed defect',
				at: AT,
				findings:
					scene === 'complete'
						? []
						: [
								{
									id: 'F1',
									severity: 'high',
									path: 'src/auth/middleware.ts',
									line: 48,
									title: 'Expired sessions still authenticate',
									body: 'The new lookup skips the expires_at check the legacy table enforced.',
									triage: {
										disposition: 'repair',
										detail: 'Confirmed: middleware.ts:48 never reads expires_at; acceptance requires expiry',
									},
								},
								{
									id: 'F2',
									severity: 'medium',
									path: 'src/auth/login.ts',
									line: 12,
									title: 'Rename sessionRow',
									body: 'sessionRow could be called session.',
									rejection: 'Style preference; not a defect against the ticket',
								},
							],
			},
		];
		if (scene === 'complete') {
			mission.evidence.review = passed('No blocking findings');
			mission.evidence.complete = passed('Reviewed revision has no open findings; branch merges cleanly');
		}
	}
	const path = missionPath(root, mission);
	await saveMission(path, mission);
	const session = SessionManager.create(cwd, join(root, 'sessions'));
	session.appendMessage({ role: 'user', content: `/mission ${TICKET}`, timestamp: Date.now() } as never);
	// The session file is written only once it holds an assistant reply.
	session.appendMessage({
		role: 'assistant',
		content: [{ type: 'text', text: 'Mission loaded.' }],
		api: 'openai-responses',
		provider: 'openai',
		model: 'gpt-5',
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: 'stop',
		timestamp: Date.now(),
	} as never);
	session.appendCustomEntry('mission:pointer', { path });
	await session.flush();
	const file = session.getSessionFile();
	if (!file) throw new Error('Session file was not written');
	return file;
}

// ---------------------------------------------------------------- driving the real TUI

type Cell = { ch: string; fg?: string; bg?: string; bold: boolean; dim: boolean; italic: boolean };
type Screen = Cell[][];
/** Type `keys`, wait until `until` is on screen, then optionally keep the screen as `snap`. */
type Step = { keys: string; until?: string; snap?: string };

const ANSI16 = [
	'#1a1a22',
	'#e06c75',
	'#7ec699',
	'#e5c07b',
	'#7aa2f7',
	'#bb9af7',
	'#56b6c2',
	'#d4d4d8',
	'#6b6b7b',
	'#f07178',
	'#9ece6a',
	'#f5d08b',
	'#8db4ff',
	'#d2b0ff',
	'#7fd6e0',
	'#ffffff',
];

/** xterm's 256-colour palette; the theme emits truecolor, so this only covers stray palette escapes. */
function paletteColor(index: number): string {
	if (index < 16) return ANSI16[index]!;
	const hex = (value: number) => value.toString(16).padStart(2, '0');
	if (index >= 232) return `#${hex(8 + (index - 232) * 10).repeat(3)}`;
	const cube = [0, 95, 135, 175, 215, 255];
	const n = index - 16;
	return `#${hex(cube[Math.floor(n / 36)]!)}${hex(cube[Math.floor(n / 6) % 6]!)}${hex(cube[n % 6]!)}`;
}

function cellColor(rgb: boolean, palette: boolean, value: number): string | undefined {
	if (rgb) return `#${value.toString(16).padStart(6, '0')}`;
	if (palette) return paletteColor(value);
	return undefined;
}

function snapshot(term: Terminal): Screen {
	const buffer = term.buffer.active;
	const scratch = buffer.getNullCell();
	const rows: Screen = [];
	for (let y = 0; y < term.rows; y++) {
		const line = buffer.getLine(buffer.viewportY + y);
		const row: Cell[] = [];
		for (let x = 0; line && x < term.cols; x++) {
			const cell: IBufferCell | undefined = line.getCell(x, scratch);
			// The right half of a wide character is an empty cell.
			if (!cell || cell.getWidth() === 0) continue;
			let fg = cellColor(cell.isFgRGB(), cell.isFgPalette(), cell.getFgColor());
			let bg = cellColor(cell.isBgRGB(), cell.isBgPalette(), cell.getBgColor());
			if (cell.isInverse()) [fg, bg] = [bg ?? BG, fg ?? FG];
			row.push({
				ch: cell.getChars() || ' ',
				fg,
				bg,
				bold: !!cell.isBold(),
				dim: !!cell.isDim(),
				italic: !!cell.isItalic(),
			});
		}
		rows.push(row);
	}
	return rows;
}

const text = (row: Cell[]) =>
	row
		.map(cell => cell.ch)
		.join('')
		.trimEnd();

async function drive(scene: Scene, steps: Step[]): Promise<Record<string, Screen>> {
	const root = await mkdtemp(join(tmpdir(), `omp-mission-shots-${scene}-`));
	const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true, scrollback: 0 });
	const pty = new Bun.Terminal({ cols: COLS, rows: ROWS, data: (_pty, data) => term.write(data) });
	// Answer the TUI's terminal queries (device attributes, cursor position) like a real emulator.
	term.onData(reply => pty.write(reply));
	let proc: Bun.Subprocess | undefined;
	const screen = async () => {
		const parsed = Promise.withResolvers<void>();
		term.write('', parsed.resolve);
		await parsed.promise;
		return snapshot(term);
	};
	const waitFor = async (needle: string) => {
		const deadline = Date.now() + 30_000;
		while (Date.now() < deadline) {
			if ((await screen()).some(row => text(row).includes(needle))) {
				// Let the frame that drew it finish.
				await Bun.sleep(400);
				return;
			}
			await Bun.sleep(100);
		}
		const dump = (await screen()).map(text).join('\n');
		throw new Error(`${scene}: "${needle}" never appeared. Screen:\n${dump}`);
	};
	try {
		const session = await fixture(scene, root);
		// A clean environment: no provider keys, no host hooks, and a throwaway HOME, so omp finds no
		// credentials and nothing can reach a model.
		const home = join(root, 'home');
		await mkdir(home);
		const env = {
			PATH: process.env.PATH ?? '/usr/bin:/bin',
			HOME: home,
			LANG: 'C.UTF-8',
			PI_CODING_AGENT_DIR: root,
			TERM: 'xterm-256color',
			COLORTERM: 'truecolor',
		};
		proc = Bun.spawn(
			[
				'omp',
				'--no-extensions',
				'-e',
				join(REPO, 'index.ts'),
				'--no-tools',
				'--no-lsp',
				'--no-skills',
				'--resume',
				session,
			],
			{ cwd: join(root, 'workspace'), env, terminal: pty },
		);
		await waitFor(`${RAIL} ${TICKET}`);
		const snaps: Record<string, Screen> = {};
		for (const step of steps) {
			pty.write(step.keys);
			if (step.until) await waitFor(step.until);
			else await Bun.sleep(300);
			if (step.snap) snaps[step.snap] = await screen();
		}
		return snaps;
	} finally {
		proc?.kill('SIGKILL');
		await proc?.exited;
		pty.close();
		await rm(root, { recursive: true, force: true });
	}
}

// ---------------------------------------------------------------- scenes

const RAIL = '▎';
const CONTINUED = 'Mission continue done';

const SCENES: Record<Scene, Step[]> = {
	running: [
		{ keys: '/mission continue' },
		{ keys: KEY.enter, until: CONTINUED },
		{ keys: KEY.expand, until: 'Source: Linear', snap: 'running' },
	],
	gate: [
		{ keys: '/mission continue' },
		{ keys: KEY.enter, until: CONTINUED, snap: 'gate' },
		{ keys: '/mission ', until: '▸ Next:', snap: 'completion' },
		{ keys: KEY.clearLine },
		{ keys: '/mission' },
		{ keys: KEY.enter, until: 'navigate', snap: 'menu' },
		{ keys: KEY.escape },
		{ keys: '/mission show' },
		{ keys: KEY.enter, until: 'outline  j/k', snap: 'inspector' },
	],
	repair: [
		{ keys: '/mission continue' },
		{ keys: KEY.enter, until: CONTINUED, snap: 'repair' },
		{ keys: '/mission show' },
		{ keys: KEY.enter, until: 'outline  j/k' },
		{ keys: KEY.tab, until: 'history  j/k' },
		{ keys: KEY.tab, until: 'evidence  j/k', snap: 'evidence' },
	],
	complete: [{ keys: '', snap: 'delivered' }],
};

// ---------------------------------------------------------------- panels and images

const FG = '#d4d4d8';
const BG = '#0b0b12';

/** The status line is omp's, not the mission's, and shows temp paths; panels leave it out. */
const isStatusLine = (row: Cell[]) => text(row).startsWith('\ue0b6');

/** From the mission row down to the status line: the row as it sits above the editor. */
function missionRow(screen: Screen): Screen {
	const start = screen.findIndex(row => text(row).startsWith(RAIL));
	const end = screen.findIndex((row, index) => index > start && isStatusLine(row));
	if (start < 0 || end < 0) throw new Error('Mission row not found');
	return screen.slice(start, end);
}

/** From the mission row to the last drawn line, for dialogs and lists drawn below it. */
function belowRow(screen: Screen): Screen {
	const start = screen.findIndex(row => text(row).startsWith(RAIL));
	const end = screen.findLastIndex(row => text(row).trim() !== '');
	if (start < 0) throw new Error('Mission row not found');
	return screen.slice(start, end + 1).filter(row => !isStatusLine(row));
}

type Panel = { caption?: string; screen: string; crop: (screen: Screen) => Screen };

const IMAGES: Record<string, Panel[]> = {
	running: [{ screen: 'running', crop: missionRow }],
	stops: [
		{ caption: 'Pause gate — approve the next wave', screen: 'gate', crop: missionRow },
		{ caption: 'Review → repair — approve the confirmed finding', screen: 'repair', crop: missionRow },
		{ caption: 'Complete — delivered and reviewed', screen: 'delivered', crop: missionRow },
	],
	completion: [{ screen: 'completion', crop: belowRow }],
	menu: [{ screen: 'menu', crop: belowRow }],
	inspector: [
		{ caption: 'Outline — the bead graph', screen: 'inspector', crop: belowRow },
		{ caption: 'Evidence — phases, review findings and triage', screen: 'evidence', crop: belowRow },
	],
};

const escapeHtml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function rowHtml(row: Cell[]): string {
	let html = '';
	let style = '';
	let run = '';
	const flush = () => {
		if (run) html += style ? `<span style="${style}">${escapeHtml(run)}</span>` : escapeHtml(run);
		run = '';
	};
	for (const cell of row) {
		const next = [
			cell.fg ? `color:${cell.fg}` : '',
			cell.bg ? `background:${cell.bg}` : '',
			cell.bold ? 'font-weight:700' : '',
			cell.italic ? 'font-style:italic' : '',
			cell.dim ? 'opacity:.6' : '',
		]
			.filter(Boolean)
			.join(';');
		if (next !== style) {
			flush();
			style = next;
		}
		run += cell.ch;
	}
	flush();
	return html;
}

function pageHtml(panels: Array<{ caption?: string; rows: Screen }>): string {
	const body = panels
		.map(
			({ caption, rows }) =>
				`${caption ? `<div class="caption">${escapeHtml(caption)}</div>` : ''}<pre>${rows.map(rowHtml).join('\n')}</pre>`,
		)
		.join('');
	return `<!doctype html><meta charset="utf-8"><style>
html, body { margin: 0; background: transparent; }
.frame { display: inline-block; margin: 0; padding: 0 0 6px; background: ${BG}; border: 1px solid #23232f;
  border-radius: 10px; overflow: hidden; }
.bar { display: flex; gap: 7px; padding: 11px 14px 4px; }
.bar i { width: 11px; height: 11px; border-radius: 50%; background: #2a2a38; }
.caption { font: 11px/1 "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM", monospace; letter-spacing: .12em;
  text-transform: uppercase; color: #7c7c8f; padding: 14px 18px 0; }
pre { margin: 0; padding: 8px 18px 10px; font: 14px/19px "JetBrainsMono Nerd Font Mono", "JetBrainsMono NFM",
  monospace; color: ${FG}; white-space: pre; width: ${COLS}ch; }
</style><div class="frame"><div class="bar"><i></i><i></i><i></i></div>${body}</div>`;
}

async function screenshot(pages: Record<string, string>): Promise<void> {
	const executablePath =
		process.env.CHROME ??
		['chromium', 'chromium-browser', 'google-chrome', 'google-chrome-stable']
			.map(name => Bun.which(name))
			.find(Boolean);
	if (!executablePath) throw new Error('Chromium not found; set CHROME to a Chromium or Chrome binary');
	const browser = await puppeteer.launch({ executablePath, headless: true });
	try {
		const page = await browser.newPage();
		await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 2 });
		for (const [name, html] of Object.entries(pages)) {
			await page.setContent(html, { waitUntil: 'load' });
			await page.evaluate(() => document.fonts.ready);
			const frame = await page.$('.frame');
			if (!frame) throw new Error(`${name}: frame missing`);
			const out = join(OUT, `${name}.webp`);
			// Transparent outside the rounded frame, so it sits on GitHub's light and dark themes alike.
			await frame.screenshot({ path: out as `${string}.webp`, type: 'webp', quality: 92, omitBackground: true });
			console.log(`${out}  ${Math.round(Bun.file(out).size / 1024)} KB`);
		}
	} finally {
		await browser.close();
	}
}

// ---------------------------------------------------------------- main

const OUT = join(REPO, 'docs', 'screens');
const screens: Record<string, Screen> = {};
for (const scene of Object.keys(SCENES) as Scene[]) Object.assign(screens, await drive(scene, SCENES[scene]));

if (process.argv.includes('--text')) {
	for (const [name, rows] of Object.entries(screens)) {
		console.log(`===== ${name}`);
		for (const row of rows) if (text(row)) console.log(text(row));
	}
} else {
	await mkdir(OUT, { recursive: true });
	const pages = Object.fromEntries(
		Object.entries(IMAGES).map(([name, panels]) => [
			name,
			pageHtml(panels.map(({ caption, screen, crop }) => ({ caption, rows: crop(screens[screen]!) }))),
		]),
	);
	await screenshot(pages);
}
