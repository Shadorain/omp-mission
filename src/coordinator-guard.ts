import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { basename, isAbsolute, join, relative } from 'node:path';
import { inScope, normalizeRel } from './scope';
import type { Mission, Run } from './types';
import { isRecord } from './guards';

/**
 * Coordinator mutation guard for active beads missions. Two layers:
 *
 * - checkToolCall/checkCommand run BEFORE the tool executes. edit/write are blocked from touching the
 *   bound checkout except .artifacts/ output (a scope covering .artifacts still wins), so the coordinator
 *   cannot create new unscoped implementation files either. bash analysis is a shallow, fail-closed scan:
 *   it stops blanket git staging (add -A/--all/-u/., commit -a, whole-tree pathspecs) and commands that
 *   rewrite checkout files, even inside && chains, subshells, $(), backticks, bash -c, and eval. It is
 *   not a sandbox: redirections, sed -i, scripts and variables can still write files.
 * - fingerprintScopes/mutatedPaths run around a bash result while no workers are live, comparing file
 *   CONTENT and mode under the bound scopes (never index/HEAD), so commit/push/read-only probes are fine.
 *   Only the paths handed in are watched: pass ['**', ...implementationScopes(mission)] and filter
 *   with isImplementationPath to also catch writes to not-yet-bound files. Violations are reported,
 *   never rolled back.
 */

export type GuardVerdict = { allowed: true } | { allowed: false; reason: string; path?: string };

const ALLOW: GuardVerdict = { allowed: true };
const deny = (reason: string, path?: string): GuardVerdict => ({ allowed: false, reason, ...(path ? { path } : {}) });

/** Everything the coordinator must not mutate: bound leaf scopes plus every worker's files. */
export function implementationScopes(mission: Mission): string[] {
	return [...new Set([...Object.values(mission.scopes).flat(), ...mission.workers.map(worker => worker.files).flat()])];
}

// ---------------------------------------------------------------------------
// edit/write targets
// ---------------------------------------------------------------------------

export interface GuardScope {
	/** Bound checkout root: the implementation boundary. */
	cwd: string;
	scopes: readonly string[];
	beadsDir?: string;
	/** Where relative tool paths resolve (context.cwd); defaults to cwd. Can differ after a worktree bind. */
	toolCwd?: string;
}

/**
 * Checkout-relative normalized path, or undefined when the target cannot be a file inside the boundary.
 * Relative targets resolve against base (the tool's cwd), so ../../ escapes that land back inside the
 * checkout are still classified, and file:// URIs resolve to the real filesystem path first.
 */
export function relInCheckout(target: string, boundary: string, base = boundary): string | undefined {
	let path = target;
	if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(path)) {
		// A URI is not evidence of being outside the checkout: file:// can point right into it.
		if (!path.startsWith('file://')) return undefined;
		try { path = fileURLToPath(path); } catch { return undefined; }
	}
	path = path.replace(/\\/g, '/');
	const rel = normalizeRel(relative(boundary, isAbsolute(path) ? path : join(base, path)));
	if (rel === '..' || rel.startsWith('../') || isAbsolute(rel)) return undefined;
	return rel || '.';
}

/** True when rel (already inside cwd) is VCS/beads metadata — prohibited separately, not implementation. */
function metadataPath(rel: string, guard: GuardScope): boolean {
	if (rel === '.git' || rel.startsWith('.git/')) return true;
	const beads = guard.beadsDir ? relInCheckout(guard.beadsDir, guard.cwd) : undefined;
	return !!beads && (rel === beads || rel.startsWith(`${beads}/`));
}

/**
 * The single write classifier: implementation = a real file inside the bound checkout that is not
 * explicitly allowed planning/artifact output. Scopes are always implementation, even under .artifacts;
 * paths outside cwd (source file, plan file, tmp), non-file URIs and metadata paths are not.
 * Parent uses this to filter a `**` fingerprint diff so unbound new repo files still count.
 */
export function isImplementationPath(path: string, guard: GuardScope): boolean {
	const rel = relInCheckout(path, guard.cwd, guard.toolCwd ?? guard.cwd);
	if (rel === undefined || rel === '.') return false;
	if (inScope(rel, guard.scopes)) return true;
	if (metadataPath(rel, guard)) return false;
	return !(rel === '.artifacts' || rel.startsWith('.artifacts/'));
}

function writeVerdict(target: string, guard: GuardScope): GuardVerdict {
	const rel = relInCheckout(target, guard.cwd, guard.toolCwd ?? guard.cwd);
	if (rel === undefined || rel === '.') return ALLOW;
	if (inScope(rel, guard.scopes)) return deny(`${rel} is inside a bound implementation scope`, rel);
	if (metadataPath(rel, guard)) return deny('writes inside .git or the bead database are not allowed', rel);
	if (rel === '.artifacts' || rel.startsWith('.artifacts/')) return ALLOW;
	return deny(`coordinator may not create or edit repo files (${rel}); workers own implementation paths, and planning output goes to .artifacts/ or external files`, rel);
}

/** Paths a write-like call will touch: explicit path fields, plus [PATH#TAG] headers inside edit patches. */
function targetPaths(input: Record<string, unknown>): string[] {
	const paths: string[] = [];
	for (const key of ['path', 'file', 'filePath', 'filename']) {
		const value = input[key];
		if (typeof value === 'string' && value) paths.push(value);
	}
	for (const key of ['input', 'patch']) {
		const value = input[key];
		if (typeof value !== 'string') continue;
		for (const match of value.matchAll(/^\[([^\]\n#]+)#[0-9A-Fa-f]{4,}\]/gm)) paths.push(match[1]!);
	}
	return [...new Set(paths)];
}

/** tool_call hook entry point: inspects edit/write targets and bash commands; other tools pass. */
export function checkToolCall(toolName: string, input: unknown, guard: GuardScope): GuardVerdict {
	if(!isRecord(input))return toolName==='edit'||toolName==='write'?deny('Cannot inspect write targets'):ALLOW;
	if (toolName === 'bash') {
		return typeof input.command === 'string' ? checkCommand(input.command) : ALLOW;
	}
	if (toolName !== 'edit' && toolName !== 'write') return ALLOW;
	for (const target of targetPaths(input)) {
		const verdict = writeVerdict(target, guard);
		if (!verdict.allowed) return verdict;
	}
	return ALLOW;
}

// ---------------------------------------------------------------------------
// bash: bounded shell scan, fail-closed on git mutations
// ---------------------------------------------------------------------------

interface Word { kind: 'word'; text: string; target?: boolean }
interface Sep { kind: 'sep'; text: string }
type Token = Word | Sep;

const KEYWORDS: Record<string, true> = { if: true, then: true, elif: true, else: true, fi: true, while: true, until: true, for: true, in: true, do: true, done: true, case: true, esac: true, '{': true, '}': true, '!': true, time: true, select: true };
const ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*(\[[^\]]*\])?=/;
const WRAPPERS: Record<string, true> = { sudo: true, doas: true, timeout: true, nice: true, xargs: true, chroot: true, env: true, command: true, builtin: true, nohup: true, setsid: true, exec: true, stdbuf: true, ionice: true, taskset: true, watch: true };
/** Wrappers whose first plain argument is still theirs (a duration or root dir), not the wrapped command. */
const WRAPPER_EXTRA: Record<string, true> = { timeout: true, chroot: true };
/** Wrapper flags that consume the following word, so the word after is not mistaken for the command. */
const WRAPPER_VALUE_FLAGS: Record<string, readonly string[]> = {
	sudo: ['-u', '-g', '-h', '-p', '-C', '-T', '-D', '-R', '-U'], doas: ['-u'],
	timeout: ['-s', '-k', '--signal', '--kill-after'], nice: ['-n', '--adjustment'],
	xargs: ['-I', '-n', '-P', '-d', '-a', '-E', '-e', '-L', '-l', '-s', '-o'],
	env: ['-u', '-C', '--unset', '--chdir', '-S', '--split-string'],
};
const SHELLS: Record<string, true> = { bash: true, sh: true, zsh: true, dash: true, ksh: true, fish: true };
const GIT_VALUE_OPTS: Record<string, true> = { '-C': true, '-c': true, '--git-dir': true, '--work-tree': true, '--namespace': true, '--exec-path': true };

interface Lexed { tokens: Token[]; nested: string[] }

/** Reads a balanced `$(` … `)` region; returns its inner text and end index, or undefined when unclosed. */
function commandSub(text: string, start: number): { inner: string; end: number } | undefined {
	let depth = 1;
	for (let i = start + 2; i < text.length; i++) {
		const c = text[i]!;
		if (c === '\\') { i++; continue; }
		if (c === "'" || c === '"') {
			const end = text.indexOf(c, i + 1);
			if (end === -1) return undefined;
			i = end;
			continue;
		}
		if (c === '(') depth++;
		else if (c === ')' && --depth === 0) return { inner: text.slice(start + 2, i), end: i };
	}
	return undefined;
}

/** Queues `$( )` and backtick bodies found inside arbitrary text (quoted strings, heredocs, expansions). */
function collectExpansions(text: string, nested: string[]): void {
	for (let j = 0; j < text.length; j++) {
		if (text[j] === '`') {
			const end = text.indexOf('`', j + 1);
			if (end === -1) break;
			nested.push(text.slice(j + 1, end));
			j = end;
		} else if (text[j] === '$' && text[j + 1] === '(') {
			const sub = commandSub(text, j);
			if (!sub) break;
			nested.push(sub.inner);
			j = sub.end;
		}
	}
}

interface Heredoc { delim: string; quoted: boolean }

/**
 * Minimal shell lexer: words vs separators, quotes stripped, redirect targets tagged, heredoc bodies
 * consumed (command substitutions inside unquoted delimiters still collected), and `$( )`/backticks
 * queued in `nested` for recursive analysis. Not a POSIX parser — unknown syntax degrades to a flat
 * word stream, which argvVerdict scans fail-closed.
 */
function lex(command: string): Lexed {
	const tokens: Token[] = [];
	const nested: string[] = [];
	const heredocs: Heredoc[] = [];
	let i = 0;
	const n = command.length;
	let buf = '';
	let pendingTarget = false;

	const flush = () => {
		if (buf) tokens.push(pendingTarget ? { kind: 'word', text: buf, target: true } : { kind: 'word', text: buf });
		buf = '';
		pendingTarget = false;
	};
	const blank = /[ \t\r]/;

	// After a newline, heredoc bodies are raw text until the delimiter line; only unquoted delimiters expand.
	const skipHeredocBodies = () => {
		while (heredocs.length) {
			const { delim, quoted } = heredocs.shift()!;
			let body = '';
			while (i < n) {
				const end = command.indexOf('\n', i);
				const line = end === -1 ? command.slice(i) : command.slice(i, end);
				i = end === -1 ? n : end + 1;
				if (line.replace(/^\t+/, '') === delim) break;
				body += `${line}\n`;
			}
			if (!quoted) collectExpansions(body, nested);
		}
	};

	while (i < n) {
		const c = command[i]!;
		if (blank.test(c)) { flush(); i++; continue; }
		if (c === '\n') { flush(); tokens.push({ kind: 'sep', text: '\n' }); i++; skipHeredocBodies(); continue; }
		if (c === '#') { const end = command.indexOf('\n', i); i = end === -1 ? n : end; continue; }
		if (c === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) { buf += command.slice(i + 1); i = n; } else { buf += command.slice(i + 1, end); i = end + 1; }
			continue;
		}
		if (c === '"') {
			i++;
			while (i < n && command[i] !== '"') {
				if (command[i] === '\\' && i + 1 < n) { buf += command[i + 1]!; i += 2; continue; }
				if (command[i] === '`' || (command[i] === '$' && command[i + 1] === '(')) {
					const end = command[i] === '`' ? command.indexOf('`', i + 1) : commandSub(command, i)?.end;
					if (end === undefined || end === -1) { i = n; break; }
					nested.push(command.slice(command[i] === '`' ? i + 1 : i + 2, end));
					buf += ' ';
					i = end + 1;
					continue;
				}
				buf += command[i]!;
				i++;
			}
			i++;
			continue;
		}
		if (c === '\\') {
			if (command[i + 1] === '\n') { i += 2; continue; }
			if (i + 1 < n) buf += command[i + 1]!;
			i += 2;
			continue;
		}
		if (c === '`' || (c === '$' && command[i + 1] === '(')) {
			const end = c === '`' ? command.indexOf('`', i + 1) : commandSub(command, i)?.end;
			if (end === undefined || end === -1) { buf += command.slice(i); break; }
			nested.push(command.slice(i + (c === '`' ? 1 : 2), end));
			buf += ' ';
			i = end + 1;
			continue;
		}
		const two = command.slice(i, i + 2);
		if (two === '&&' || two === '||' || two === '|&' || c === ';' || c === '|' || c === '&' || c === '(' || c === ')') {
			flush();
			tokens.push({ kind: 'sep', text: two === '&&' || two === '||' || two === '|&' ? two : c });
			i += two === '&&' || two === '||' || two === '|&' ? 2 : 1;
			continue;
		}
		if (c === '>' || c === '<') {
			// A bare fd number directly left of the operator is part of the redirect, not an argument.
			if (/^\d+$/.test(buf)) buf = '';
			flush();
			const three = command.slice(i, i + 3);
			const len = three === '<<<' ? 3 : two === '<<' || two === '>>' || two === '>&' || two === '<&' || two === '>|' ? 2 : 1;
			if (two === '<<' && three !== '<<<') {
				let j = i + 2;
				if (command[j] === '-') j++;
				while (j < n && blank.test(command[j]!)) j++;
				const quoted = command[j] === "'" || command[j] === '"';
				let delim = '';
				if (quoted) {
					const end = command.indexOf(command[j]!, j + 1);
					delim = end === -1 ? '' : command.slice(j + 1, end);
				} else {
					while (j < n && !blank.test(command[j]!) && command[j] !== '\n' && command[j] !== ';' && command[j] !== '&' && command[j] !== '|') { delim += command[j]!; j++; }
				}
				if (delim) heredocs.push({ delim, quoted });
			}
			tokens.push({ kind: 'sep', text: '>' });
			pendingTarget = true;
			i += len;
			continue;
		}
		buf += c;
		i++;
	}
	flush();
	return { tokens, nested };
}

/** Pathspecs that mean the whole tree rather than a bounded path. */
function wholeTree(pathspec: string): boolean {
	// normalizeRel strips trailing slashes, so the root pathspec ':/' collapses to ':' — test raw too.
	// ':/src' is scoped (repo-rooted src); only bare ':/' or ':' means the whole tree.
	if (pathspec === ':/' || pathspec === ':') return true;
	const p = normalizeRel(pathspec);
	return p === '.' || p === '' || p === '*' || p === '..' || p.startsWith('../') || p === ':(top)' || p.startsWith(':(top,');
}

/** Stops whole-tree staging/commit and checkout-rewriting git; returns the violation or undefined. */
function gitVerdict(argv: readonly string[]): string | undefined {
	let i = 0;
	while (i < argv.length) {
		const arg = argv[i]!;
		if (GIT_VALUE_OPTS[arg] === true) { i += 2; continue; }
		if (arg.startsWith('-')) { i++; continue; }
		break;
	}
	const sub = argv[i];
	if (!sub) return undefined;
	const rest = argv.slice(i + 1);

	if (sub === 'add' || sub === 'stage') {
		let blanket = false, dry = false;
		const paths: string[] = [];
		let after = false;
		for (const arg of rest) {
			if (after) { paths.push(arg); continue; }
			if (arg === '--') { after = true; continue; }
			if (arg.startsWith('--')) { if (arg === '--all' || arg === '--update') blanket = true; else if (arg === '--dry-run') dry = true; continue; }
			if (arg.startsWith('-') && arg.length > 1) { if (arg.includes('A') || arg.includes('u')) blanket = true; if (arg.includes('n')) dry = true; continue; }
			paths.push(arg);
		}
		if (dry) return undefined;
		if (paths.some(wholeTree)) return 'git add stages the whole checkout; workers stage their own paths, so stage explicit paths only';
		if (blanket && !paths.length) return `git ${sub} -A/--all/-u stages every change including other workers'; stage explicit paths`;
		return undefined;
	}
	if (sub === 'commit') {
		let all = false;
		const paths: string[] = [];
		let after = false;
		for (const arg of rest) {
			if (after) { paths.push(arg); continue; }
			if (arg === '--') { after = true; continue; }
			if (arg === '--all') { all = true; continue; }
			if (arg.startsWith('--')) continue;
			if (arg.startsWith('-') && arg.length > 1) { if (arg.includes('a')) all = true; continue; }
			paths.push(arg);
		}
		if (paths.some(wholeTree)) return 'git commit with a whole-tree pathspec bypasses scoped staging';
		if (all) return 'git commit -a/--all stages every modified file; commit the staged paths only';
		return undefined;
	}
	if (sub === 'checkout' || sub === 'switch' || sub === 'restore')
		return `git ${sub} rewrites checkout files mid-mission; the coordinator stays on the bound branch`;
	if (sub === 'clean')
		return rest.some(arg => arg === '--dry-run' || (arg.startsWith('-') && !arg.startsWith('--') && arg.includes('n'))) ? undefined : 'git clean deletes untracked files that belong to workers';
	if (sub === 'reset')
		return rest.some(arg => arg === '--hard' || arg === '--merge' || arg === '--keep') ? `git reset ${rest.find(arg => arg.startsWith('--'))} discards checkout changes` : undefined;
	if (sub === 'stash') {
		const action = rest.find(arg => !arg.startsWith('-')) ?? 'push';
		return ['list', 'show', 'create', 'store'].includes(action) ? undefined : `git stash ${action} moves checkout files; leave the workers' tree alone`;
	}
	if (sub === 'merge' || sub === 'rebase' || sub === 'pull' || sub === 'cherry-pick' || sub === 'revert' || sub === 'am' || sub === 'apply' || sub === 'rm' || sub === 'mv' || sub === 'worktree' || sub === 'bisect')
		return `git ${sub} mutates the mission checkout; use mission_control and scoped staging`;
	if (sub === 'submodule')
		return rest.find(arg => !arg.startsWith('-')) === 'update' ? 'git submodule update rewrites checkout files' : undefined;
	return undefined;
}

/** Consumes env-assignment and wrapper prefixes so `sudo timeout 5 git add -A` still reaches the git check. */
function stripPrefix(argv: readonly string[]): readonly string[] {
	let args = argv;
	for (let guard = 0; guard < 6 && args.length; guard++) {
		const [first, ...rest] = args;
		if (ASSIGN.test(first!) && !first!.startsWith('-')) { args = rest; continue; }
		const cmd = basename(first!);
		if (WRAPPERS[cmd] !== true) break;
		const valueFlags = WRAPPER_VALUE_FLAGS[cmd] ?? [];
		let dropped = rest;
		while (dropped.length) {
			const t = dropped[0]!;
			if (cmd === 'env' && ASSIGN.test(t) && !t.startsWith('-')) { dropped = dropped.slice(1); continue; }
			if (!t.startsWith('-')) break;
			dropped = dropped.slice(valueFlags.includes(t) ? 2 : 1);
		}
		if (WRAPPER_EXTRA[cmd] === true && dropped.length) dropped = dropped.slice(1);
		args = dropped;
	}
	return args;
}

function argvVerdict(argv: readonly string[], depth: number): string | undefined {
	const stripped = stripPrefix(argv);
	const cmd = stripped[0];
	if (!cmd) return undefined;
	const name = basename(cmd);
	if (SHELLS[name] === true) {
		const dashC = stripped.findIndex(arg => arg === '-c');
		if (dashC !== -1 && stripped[dashC + 1] && depth < 3) return commandVerdict(stripped[dashC + 1]!, depth + 1);
		return undefined;
	}
	if (name === 'eval' && depth < 3) {
		const inner = stripped.slice(1).join(' ');
		if (inner.trim()) return commandVerdict(inner, depth + 1);
		return undefined;
	}
	if (name === 'git') return gitVerdict(stripped.slice(1));
	if (name === 'rustfmt' || name === 'cargo-fmt') return 'rustfmt writes implementation files; run cargo fmt --all -- --check, and assign format fixes to a scoped worker';
	if ((name === 'cargo' || name === 'cargo-auto') && stripped[1] === 'fmt' && !stripped.includes('--check')) return 'cargo fmt writes implementation files; run cargo fmt --all -- --check, and assign format fixes to a scoped worker';
	return undefined;
}

function commandVerdict(command: string, depth: number): string | undefined {
	if (depth > 3) return undefined;
	const { tokens, nested } = lex(command);
	for (const text of nested) {
		const verdict = commandVerdict(text, depth + 1);
		if (verdict) return verdict;
	}
	let expectCmd = true;
	let argv: string[] = [];
	const flush = () => {
		const verdict = argvVerdict(argv, depth);
		argv = [];
		return verdict;
	};
	for (const token of tokens) {
		if (token.kind === 'sep') {
			if (token.text === '>') continue;
			const verdict = flush();
			if (verdict) return verdict;
			expectCmd = true;
			continue;
		}
		if (token.target) continue;
		if (expectCmd && KEYWORDS[token.text] === true) continue;
		argv.push(token.text);
		expectCmd = false;
	}
	return flush();
}

/**
 * Static check on a bash command before it runs. Not a sandbox: it only finds the git mutations it can
 * recognize (blanket staging, commit -a, tree rewriting) across separators, wrappers, subshells, $(),
 * backticks, bash -c and eval. Everything else is left to post-execution fingerprinting.
 */
export function checkCommand(command: string): GuardVerdict {
	const reason = commandVerdict(command, 0);
	return reason ? deny(reason) : ALLOW;
}

// ---------------------------------------------------------------------------
// post-execution fingerprint over bound scopes (content + mode, never index/HEAD)
// ---------------------------------------------------------------------------

function fingerprint(abs: string): string {
	try {
		const st = lstatSync(abs);
		const mode = (st.mode & 0o777).toString(8);
		if (st.isDirectory()) return `dir:${mode}`;
		const hash = createHash('sha1').update(st.isSymbolicLink() ? readlinkSync(abs) : readFileSync(abs)).digest('hex');
		return `${st.isSymbolicLink() ? 'link' : 'file'}:${mode}:${hash}`;
	} catch(error) {
		if(isRecord(error)&&error.code==='ENOENT')return 'absent';
		throw error;
	}
}

/** Git's non-ignored file set excludes verification output; explicit literal scopes remain watched. */
export async function fingerprintScopes(run: Run, cwd: string, scopes: readonly string[], beadsDir?: string): Promise<Record<string, string>> {
	const paths=new Set<string>();const globs:string[]=[];
	const artifactsScoped=scopes.some(raw=>normalizeRel(raw).split('/')[0]==='.artifacts');
	const beadsRel=beadsDir?relInCheckout(beadsDir,cwd):undefined;
	const excluded=(rel:string)=>rel==='.git'||rel.startsWith('.git/')||
		(!artifactsScoped&&(rel==='.artifacts'||rel.startsWith('.artifacts/')))||
		(!!beadsRel&&(rel===beadsRel||rel.startsWith(`${beadsRel}/`)));
	for(const raw of scopes){
		const scope=normalizeRel(raw);if(!scope)continue;
		if(scope==='.'||/[*?[]/.test(scope)){globs.push(scope==='.'?'**':scope);continue;}
		let directory=false;
		try{directory=lstatSync(join(cwd,scope)).isDirectory();}
		catch(error){if(!isRecord(error)||error.code!=='ENOENT')throw error;}
		if(directory)globs.push(`${scope}/**`);
		else if(!excluded(scope))paths.add(scope);
	}
	const listed=await run('git',['ls-files','-c','-o','--exclude-standard','-z'],cwd);
	if(listed.code===0){
		for(const file of listed.stdout.split('\0'))if(file&&!excluded(file)&&inScope(file,scopes))paths.add(file);
	}else if(/not a git repository/i.test(listed.stderr)){
		for(const pattern of globs)for(const file of new Bun.Glob(pattern).scanSync({cwd,onlyFiles:true,dot:true})){
			const rel=normalizeRel(file);if(!excluded(rel))paths.add(rel);
		}
	}else throw new Error(listed.stderr||'Cannot enumerate implementation files');
	return Object.fromEntries([...paths].map(rel=>[rel,fingerprint(join(cwd,rel))]));
}

/** Paths whose content/mode fingerprint changed, appeared, or vanished between two scans. */
export function mutatedPaths(before: Record<string, string>, after: Record<string, string>): string[] {
	const paths = new Set([...Object.keys(before), ...Object.keys(after)]);
	return [...paths].filter(path => before[path] !== after[path]).sort();
}
