import type { Bead, Frontend, Mission, Run, Terminal, Worker } from './types.ts';
import { spawnBackground, spawnCustom, spawnHerdr, writePromptFile, writeSourceFile } from './hosts.ts';

export interface WorkerAssignment { beadId: string; cwd: string; files: string[]; assignment?: string; task?: string }
/** In-process subagent runner, as the driver sees it. */
export interface SubagentPort {
  launch(mission: Mission, worker: Worker): Promise<{ handle: string; incarnationId: string }>;
  isLive(beadId: string): boolean;
  steer(beadId: string, text: string): Promise<void>;
  /** Reopen a lost session from its transcript. False: nothing to reopen. */
  resume(mission: Mission, worker: Worker, note?: string): Promise<boolean>;
  release(mission: Mission, worker: Worker): Promise<void>;
  abort(beadId: string): Promise<void>;
}
export interface WorkerHooks { persist(mission: Mission): Promise<void>; subagent?: SubagentPort; /** False while this session may not mutate the mission (no ownership, resume hold, plan mode). Reopening or releasing a subagent session mutates beads, so it waits. */ canMutate?: () => boolean; prompt?(mission: Mission, worker: Worker, task?: string): string; agentDir?: string; model?: () => string | undefined; frontend?: Frontend | (() => Frontend); customCommand?: string | (() => string | undefined) }
export interface WorkerDriver {
  dispatch(mission: Mission, assignments: WorkerAssignment[] | string[]): Promise<Worker[]>;
  reconcile(mission: Mission, beadStates: Map<string, Bead>): Promise<Worker[]>;
  focus(worker: Worker): Promise<void>;
  reap(mission: Mission, beadId: string, bead: Bead): Promise<void>;
  /** `note` is operator guidance; only subagent workers can take it (they are resumed with it as the prompt). */
  resend(mission: Mission, beadId: string, bead: Bead, note?: string): Promise<void>;
  /** Gives a stopped subagent worker's bead back (abort, unclaim, close the record) so a fresh worker can take it. */
  release(mission: Mission, beadId: string, bead: Bead): Promise<void>;
  recover(mission: Mission, beadId: string, bead: Bead): Promise<void>;
}

export function assertNonOverlapping(assignments: WorkerAssignment[]): void {
  for (const assignment of assignments) {
    if (assignment.files.length === 0) throw new Error(`worker file scope required: ${assignment.beadId}`);
    for (const file of assignment.files) normalizeScope(file);
  }
  for (let i = 0; i < assignments.length; i++) {
    const left = assignments[i]!;
    for (let j = i + 1; j < assignments.length; j++) {
      const right = assignments[j]!;
      if (left.cwd !== right.cwd) continue;
      const collision = left.files.some(a => right.files.some(b => scopesOverlap(a, b)));
      if (collision) throw new Error(`worker file scopes overlap: ${left.beadId} and ${right.beadId}`);
    }
  }
}

function scopesOverlap(left: string, right: string): boolean {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  return a === '' || b === '' || a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}
function normalizeScope(path: string): string {
  if (path.trim().length === 0) throw new Error('worker file scope cannot be empty');
  if (path.startsWith('/') || /^[A-Za-z]:/.test(path)) throw new Error(`worker scope must be workspace-relative: ${path}`);
  const parts = path.replaceAll('\\', '/').split('/').filter(part => part && part !== '.');
  if (parts.includes('..')) throw new Error(`invalid worker file scope: ${path}`);
  return parts.join('/');
}
function quote(value: string): string { return `'${value.replaceAll("'", "'\\''")}'`; }
function orcaError(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const error = (value as Record<string, unknown>).error;
  if (typeof error === 'string') return error;
  if (typeof error !== 'object' || error === null) return undefined;
  const { code, message } = error as Record<string, unknown>;
  const detail = [code, message].filter((part, index, all): part is string => typeof part === 'string' && all.indexOf(part) === index).join(': ');
  if (!detail) return undefined;
  return code === 'selector_not_found' ? `${detail} (Orca does not know this worktree; register the checkout with Orca before dispatching workers)` : detail;
}
function unwrap(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Orca returned invalid JSON object');
  const outer = value as Record<string, unknown>;
  if (outer.ok === false) throw new Error(orcaError(outer) ?? 'Orca command failed');
  if (typeof outer.result === 'object' && outer.result !== null && !Array.isArray(outer.result)) return outer.result as Record<string, unknown>;
  return outer;
}
function decode(result: { stdout: string; stderr: string; code: number }): Record<string, unknown> {
  if (result.code !== 0) {
    let reported: string | undefined;
    try { reported = orcaError(JSON.parse(result.stdout)); } catch { /* stdout was not JSON */ }
    throw new Error(result.stderr || reported || `orca command failed (${result.code})`);
  }
  try { return unwrap(JSON.parse(result.stdout)); }
  catch (error) { throw new Error(`invalid Orca JSON: ${error instanceof Error ? error.message : String(error)}`); }
}

export async function listTerminals(run: Run, cwd: string): Promise<{ terminals: Terminal[]; truncated: boolean }> {
  const payload = decode(await run('orca', ['terminal', 'list', '--json'], cwd));
  if (!Array.isArray(payload.terminals)) throw new Error('Orca terminal list omitted terminals');
  const terminals: Terminal[] = payload.terminals.map((value: unknown) => {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Orca terminal list contains invalid terminal');
    const terminal = value as Record<string, unknown>;
    if (typeof terminal.handle !== 'string' || typeof terminal.incarnationId !== 'string' || typeof terminal.worktreePath !== 'string') throw new Error('Orca terminal lacks identity fields');
    return { ...terminal, handle: terminal.handle, incarnationId: terminal.incarnationId, worktreePath: terminal.worktreePath, writable: terminal.writable === true, connected: terminal.connected === true } as Terminal;
  });
  return { terminals, truncated: payload.truncated === true };
}

export function validateTerminal(worker: Worker, terminals: Terminal[]): Terminal | undefined {
  if (!worker.handle || !worker.incarnationId) return undefined;
  return terminals.find(terminal => terminal.handle === worker.handle && terminal.incarnationId === worker.incarnationId && terminal.worktreePath === worker.cwd && terminal.writable && terminal.connected);
}

export function createWorkerDriver(run: Run, hooks: WorkerHooks): WorkerDriver {
  const persist = async (mission: Mission) => hooks.persist(mission);
  function frontend(): Frontend {
    const value = hooks.frontend;
    return typeof value === 'function' ? value() : value ?? 'orca';
  }
  function customCommand(): string | undefined {
    const value = hooks.customCommand;
    return typeof value === 'function' ? value() : value;
  }
  // Workers inherit the default model unless the worker role resolves to one.
  function modelFlag(): string {
    const model = hooks.model?.();
    return model ? ` --model ${quote(model)}` : '';
  }
  function launchCommand(mission: Mission, worker: Worker): string {
    const beads = mission.workspace.beadsDir ? ` BEADS_DIR=${quote(mission.workspace.beadsDir)}` : '';
    const agentEnvironment = hooks.agentDir ? ` PI_CODING_AGENT_DIR=${quote(hooks.agentDir)}` : '';
    return `env OMP_MISSION_WORKER=${quote('1')} BEADS_ACTOR=${quote(worker.beadId)}${beads}${agentEnvironment} omp${modelFlag()}`;
  }
  function hostOf(worker: Worker): Frontend {
    return worker.frontend ?? 'orca';
  }
  async function sessionAlive(worker: Worker): Promise<boolean> {
    const kind = hostOf(worker);
    if (kind === 'herdr') return (await run('herdr', ['agent', 'get', worker.handle!], worker.cwd)).code === 0;
    if (kind === 'subagent') return hooks.subagent?.isLive(worker.beadId) ?? false;
    if (kind === 'none' || (kind === 'custom' && /^\d+$/.test(worker.handle ?? ''))) return (await run('kill', ['-0', worker.handle!], worker.cwd)).code === 0;
    return false;
  }

  async function requireLive(worker: Worker, mission: Mission): Promise<Terminal> {
    if (hostOf(worker) !== 'orca') {
      if (!worker.handle || !worker.incarnationId || !(await sessionAlive(worker))) throw new Error(`worker session identity missing or changed for ${worker.beadId}`);
      return { handle: worker.handle, incarnationId: worker.incarnationId, worktreePath: worker.cwd, writable: true, connected: true };
    }
    const listing = await listTerminals(run, mission.workspace.cwd);
    if (listing.truncated) throw new Error('Orca terminal topology truncated; worker identity cannot be validated');
    const terminal = validateTerminal(worker, listing.terminals);
    if (!terminal) throw new Error(`worker terminal identity missing or changed for ${worker.beadId}`);
    return terminal;
  }

  async function waitIdle(worker: Worker, mission: Mission): Promise<void> {
    if (hostOf(worker) !== 'orca') return;
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await run('orca', ['terminal', 'wait', '--terminal', worker.handle!, '--for', 'tui-idle', '--timeout-ms', '120000', '--json'], mission.workspace.cwd);
      if (result.code !== 0) {
        if (attempt === 1) throw new Error(result.stderr || `worker ${worker.beadId} idle wait failed`);
        await requireLive(worker, mission);
        continue;
      }
      const wait = decode(result).wait;
      const satisfied = typeof wait === 'object' && wait !== null && (wait as Record<string, unknown>).satisfied === true;
      if (satisfied) return;
      if (attempt === 1) throw new Error(`worker ${worker.beadId} never reached TUI idle; refusing to send assignment`);
      await requireLive(worker, mission);
    }
  }

  async function send(worker: Worker, mission: Mission, again = false): Promise<void> {
    const kind = hostOf(worker);
    if (kind === 'subagent') {
      if (!again) return;
      if (!hooks.subagent) throw new Error('subagent runner unavailable');
      await hooks.subagent.steer(worker.beadId, `Your full assignment for bead ${worker.beadId} is unchanged. Continue it and finish by calling yield.`);
      return;
    }
    if (kind === 'none') {
      if (again) throw new Error('background omp already received its assignment; there is no terminal to resend');
      return;
    }
    if (kind === 'custom') {
      if (again) throw new Error('custom frontend has no send channel');
      return;
    }
    if (kind === 'herdr') {
      if (!worker.handle) throw new Error(`worker has no recorded Herdr agent for ${worker.beadId}`);
      if (!worker.assignment) throw new Error(`worker prompt missing for ${worker.beadId}`);
      const result = await run('herdr', ['agent', 'prompt', worker.handle, worker.assignment], worker.cwd);
      if (result.code !== 0) throw new Error(result.stderr.trim() || `herdr agent prompt failed for ${worker.beadId}`);
      return;
    }
    await waitIdle(worker, mission);
    await requireLive(worker, mission);
    await writeSourceFile(mission);
    const promptFile = await writePromptFile(worker);
    const notice = `Your full assignment for bead ${worker.beadId} is in the file ${promptFile} — read it and execute it exactly as written.`;
    const sent = decode(await run('orca', ['terminal', 'send', '--terminal', worker.handle!, '--text', notice, '--enter', '--wait-submit', '120', '--json'], mission.workspace.cwd)).send;
    if (typeof sent !== 'object' || sent === null || Array.isArray(sent)) throw new Error(`Orca send omitted result.send for ${worker.beadId}`);
    const row = sent as Record<string, unknown>;
    if (row.accepted !== true) throw new Error(`Orca did not accept the assignment for ${worker.beadId}`);
    const prompt = row.prompt;
    if (typeof prompt !== 'object' || prompt === null || Array.isArray(prompt)) throw new Error(`Orca send omitted the prompt receipt for ${worker.beadId}; submission unobservable`);
    const pr = prompt as Record<string, unknown>;
    if (pr.provider === 'old-host') throw new Error(`Orca host cannot observe prompt submission for ${worker.beadId} (old-host); refusing to treat input acceptance as delivery`);
    if (pr.observation === 'rejected') throw new Error(`Orca rejected the assignment prompt for ${worker.beadId}`);
    const stages = Array.isArray(pr.stages) ? pr.stages : [];
    if (stages.includes('turn_started')) return;
    if (pr.observation === 'observed') throw new Error(`Orca observed no turn start for the assignment of ${worker.beadId}; draft may sit unsubmitted in the composer`);
    throw new Error(`Orca accepted the assignment for ${worker.beadId} but submission is unconfirmed (provider cannot report delivery); inspect the tab before retrying`);
  }

  async function start(mission: Mission, worker: Worker): Promise<void> {
    worker.state = 'starting';
    worker.frontend = frontend();
    await persist(mission);
    const kind = worker.frontend;
    if (!worker.assignment) worker.assignment = hooks.prompt?.(mission, worker) ?? '';
    if (!worker.assignment) throw new Error(`worker prompt missing for ${worker.beadId}`);
    await writeSourceFile(mission);
    if (kind === 'subagent') {
      if (!hooks.subagent) throw new Error('subagent runner unavailable');
      const identity = await hooks.subagent.launch(mission, worker);
      worker.handle = identity.handle;
      worker.incarnationId = identity.incarnationId;
      worker.state = 'awaiting-claim';
      worker.launchedAt = new Date().toISOString();
      await persist(mission);
      return;
    }
    if (kind !== 'orca') {
      if (kind === 'custom' && !customCommand()) throw new Error('customCommand is required when frontend is custom');
      const spawned = kind === 'herdr'
        ? await spawnHerdr(run, mission, worker, hooks.agentDir, hooks.model?.())
        : kind === 'none'
          ? await spawnBackground(run, mission, worker, hooks.agentDir, hooks.model?.())
          : await spawnCustom(run, mission, worker, customCommand()!, launchCommand(mission, worker));
      worker.handle = spawned.handle;
      worker.incarnationId = spawned.incarnationId;
      worker.state = 'awaiting-claim';
      worker.launchedAt = new Date().toISOString();
      await persist(mission);
      await send(worker, mission);
      return;
    }
    if (!mission.workspace.beadsDir) throw new Error('canonical BEADS_DIR missing; refusing to start worker');
    const promptFile = await writePromptFile(worker);
    const agentEnvironment = hooks.agentDir ? ` PI_CODING_AGENT_DIR=${quote(hooks.agentDir)}` : '';
    const pRef = quote(promptFile);
    const command = `env OMP_MISSION_WORKER=${quote('1')} BEADS_ACTOR=${quote(worker.beadId)} BEADS_DIR=${quote(mission.workspace.beadsDir)}${agentEnvironment} omp${modelFlag()} @${pRef}`;
    const result = await run('orca', ['terminal', 'create', '--worktree', `path:${worker.cwd}`, '--title', `mission-${worker.beadId}`, '--command', command, '--json'], mission.workspace.cwd);
    const payload = decode(result);
    const terminal = payload.terminal;
    if (typeof terminal !== 'object' || terminal === null || Array.isArray(terminal)) throw new Error('Orca terminal create omitted result.terminal');
    const created = terminal as Record<string, unknown>;
    if (typeof created.handle !== 'string' || typeof created.incarnationId !== 'string') throw new Error('Orca terminal create omitted handle or incarnationId');
    worker.handle = created.handle;
    worker.incarnationId = created.incarnationId;
    worker.state = 'awaiting-claim';
    worker.launchedAt = new Date().toISOString();
    await persist(mission);
    // initial assignment delivered at launch via OMP @file CLI arg (avoids orca send paste/escaped-newline into composer); send path used only by resend
  }

  return {
    async dispatch(mission, assignments) {
      const specs: WorkerAssignment[] = assignments.map(item => typeof item === 'string'
        ? { beadId: item, cwd: mission.workspace.cwd, files: mission.scopes[item] ?? [] }
        : item);
      assertNonOverlapping(specs);
      const existing = new Set(mission.workers.filter(worker => worker.state !== 'closed').map(worker => worker.beadId));
      if (specs.some(assignment => existing.has(assignment.beadId))) throw new Error('worker assignment already reserved or active');
      const workers: Worker[] = specs.map(assignment => {
        const worker: Worker = {
          beadId: assignment.beadId, attempt: crypto.randomUUID(), cwd: assignment.cwd,
          files: [...assignment.files], state: 'reserved' as const, assignment: assignment.assignment ?? '',
        };
        worker.assignment ||= hooks.prompt?.(mission, worker, assignment.task) ?? '';
        if (!worker.assignment) throw new Error(`worker prompt missing for ${worker.beadId}`);
        return worker;
      });
      mission.workers.push(...workers);
      await persist(mission);
      for (const worker of workers) {
        try { await start(mission, worker); }
        catch (error) { worker.error = error instanceof Error ? error.message : String(error); await persist(mission); throw error; }
      }
      return workers;
    },
    async reconcile(mission, beadStates) {
      const changed: Worker[] = [];
      for (const worker of mission.workers) {
        const bead = beadStates.get(worker.beadId);
        if (!bead) continue;
        if (worker.state === 'closed') continue;
        if (bead.category === 'closed') {
          worker.state = 'closed'; changed.push(worker);
          continue;
        }
        if (!worker.handle || !worker.incarnationId) {
          if (worker.state === 'reserved' || worker.state === 'starting' || bead.category === 'active') {
            worker.error = 'reservation has no persisted terminal identity; recovery held';
            if (!changed.includes(worker)) changed.push(worker);
          }
          continue;
        }
        if (hostOf(worker) !== 'orca') {
          if (!(await sessionAlive(worker))) {
            // A restart killed the in-process session while it held the claim: reopen its transcript,
            // or give the bead back. A worker that failed on its own (error set) waits for the operator.
            if (hostOf(worker) === 'subagent' && hooks.subagent && bead.category === 'active' && bead.claimActor === worker.beadId) {
              if (worker.error || hooks.canMutate?.() === false) continue; // rejected result keeps its reason; a non-owning or held session only observes
              if (await hooks.subagent.resume(mission, worker)) { worker.state = 'running'; changed.push(worker); continue; }
              await hooks.subagent.release(mission, worker).catch(() => {});
            }
            worker.state = 'missing';
            worker.error = 'recorded worker session is absent or has changed identity';
            changed.push(worker);
            continue;
          }
        } else {
          const listing = await listTerminals(run, mission.workspace.cwd);
          if (listing.truncated) throw new Error('Orca terminal topology truncated; recovery held');
          if (!validateTerminal(worker, listing.terminals)) {
            worker.state = 'missing';
            worker.error = 'recorded worker terminal is absent or has changed identity';
            changed.push(worker);
            continue;
          }
        }
        if (worker.state === 'missing') { worker.state = 'awaiting-claim'; worker.error = undefined; changed.push(worker); }
        if (bead.category === 'active') {
          if (bead.claimActor !== worker.beadId) {
            worker.error = bead.claimActor ? `claim belongs to ${bead.claimActor}; refusing to treat worker as running` : 'fresh claim actor unavailable; worker remains unconfirmed';
            if (!changed.includes(worker)) changed.push(worker);
            continue;
          }
          if (worker.state !== 'running' || worker.error) { worker.state = 'running'; worker.error = undefined; changed.push(worker); }
        } else if (worker.state === 'running') {
          worker.state = 'awaiting-claim';
          worker.error = 'fresh bead claim no longer confirms worker activity';
          changed.push(worker);
        } else if (worker.state === 'awaiting-claim' && bead.assignee) {
          worker.error = `claim belongs to ${bead.assignee}; refusing to resend or replace worker`;
          if (!changed.includes(worker)) changed.push(worker);
        }
      }
      if (changed.length) await persist(mission);
      return changed;
    },
    async focus(worker) {
      if (!worker.handle || !worker.incarnationId) throw new Error('worker has no recorded terminal identity');
      const kind = hostOf(worker);
      if (kind === 'herdr') {
        const result = await run('herdr', ['agent', 'focus', worker.handle], worker.cwd);
        if (result.code !== 0) throw new Error(result.stderr.trim() || 'herdr agent focus failed');
        return;
      }
      if (kind === 'subagent') throw new Error(`subagent workers have no tab: press Alt+A (Agent Hub) and select ${worker.beadId}`);
      if (kind !== 'orca') throw new Error(`${kind} frontend has no tab to focus`);
      const result = decode(await run('orca', ['terminal', 'list', '--json'], worker.cwd));
      if (result.truncated === true) throw new Error('Orca terminal topology truncated; focus held');
      if (!Array.isArray(result.terminals)) throw new Error('Orca terminal list omitted terminals');
      const terminals = result.terminals as Terminal[];
      if (!validateTerminal(worker, terminals)) throw new Error('worker terminal identity missing or changed');
      decode(await run('orca', ['terminal', 'switch', '--terminal', worker.handle, '--json'], worker.cwd));
    },
    async reap(mission, beadId, bead) {
      if (mission.keep) throw new Error('mission keep policy forbids worker cleanup');
      if (bead.id !== beadId || bead.category !== 'closed') throw new Error('only the exact closed mission bead may be reaped');
      const worker = mission.workers.findLast(item => item.beadId === beadId);
      if (!worker?.handle || !worker.incarnationId) throw new Error('no recorded worker terminal to reap');
      const kind = hostOf(worker);
      if (kind !== 'subagent') await requireLive(worker, mission);
      if (kind === 'subagent') {
        await hooks.subagent?.abort(worker.beadId);
      } else if (kind === 'herdr') {
        const result = await run('herdr', ['tab', 'close', worker.incarnationId], mission.workspace.cwd);
        if (result.code !== 0) throw new Error(result.stderr.trim() || 'herdr tab close failed');
      } else if (kind === 'none' || (kind === 'custom' && /^\d+$/.test(worker.handle))) {
        const result = await run('kill', [worker.handle], mission.workspace.cwd);
        if (result.code !== 0) throw new Error(result.stderr.trim() || 'worker process close failed');
      } else if (kind === 'custom') {
        throw new Error('custom frontend has no close channel');
      } else {
        decode(await run('orca', ['terminal', 'close', '--terminal', worker.handle, '--tab', '--json'], mission.workspace.cwd));
      }
      worker.state = 'closed';
      await persist(mission);
    },
    async recover(mission, beadId, bead) {
      if (bead.id !== beadId || bead.category !== 'ready' || bead.assignee || bead.claimActor) throw new Error('recover requires the exact ready, unclaimed mission bead');
      const worker = mission.workers.find(item => item.beadId === beadId && item.state !== 'closed');
      if (!worker || worker.state !== 'missing') throw new Error('recover requires a worker whose recorded terminal is gone; use resend while it is alive');
      worker.state = 'closed';
      worker.error = `replaced: ${worker.error ?? 'recorded worker terminal is gone'}`;
      await persist(mission);
    },
    async release(mission, beadId, bead) {
      const worker = mission.workers.findLast(item => item.beadId === beadId && item.state !== 'closed');
      if (!worker || hostOf(worker) !== 'subagent') throw new Error('release applies to a running or stopped subagent worker');
      if (!hooks.subagent) throw new Error('subagent runner unavailable');
      if (bead.id !== beadId || bead.category !== 'active' || bead.claimActor !== beadId) throw new Error('release requires the bead still claimed by its own worker');
      await hooks.subagent.abort(beadId);
      await hooks.subagent.release(mission, worker);
      worker.state = 'closed';
      worker.error = `released: ${worker.error ?? 'by operator'}`;
      await persist(mission);
    },
    async resend(mission, beadId, bead, note) {
      const latest = mission.workers.findLast(item => item.beadId === beadId);
      if (latest && hostOf(latest) === 'subagent' && latest.state !== 'closed') {
        // The bead is in_progress under the worker's own claim, so the ready-bead rule below does not apply.
        if (bead.id !== beadId || bead.category !== 'active' || bead.claimActor !== beadId) throw new Error('resend requires the worker\'s own active bead');
        if (!hooks.subagent) throw new Error('subagent runner unavailable');
        if (hooks.subagent.isLive(beadId)) { if (note) await hooks.subagent.steer(beadId, note); else await send(latest, mission, true); return; }
        // Not running: either a failed result waiting for the operator, or a session lost to a restart.
        const rejected = latest.error ? `Your last result was rejected: ${latest.error}.` : '';
        const prompt = [rejected, note, 'Finish by calling yield.'].filter(Boolean).join(' ');
        if (!(await hooks.subagent.resume(mission, latest, prompt))) throw new Error(`no saved session to resume for ${beadId}; release the claim with bd unclaim and dispatch again`);
        latest.error = undefined;
        latest.state = 'running';
        await persist(mission);
        return;
      }
      if (bead.id !== beadId || bead.category !== 'ready') throw new Error('resend requires the exact currently ready mission bead');
      const worker = latest;
      if (!worker || worker.state !== 'awaiting-claim' || !worker.handle || !worker.incarnationId) throw new Error('no awaiting-claim worker to resend');
      if (bead.claimActor) throw new Error(`bead already claimed by ${bead.claimActor}; refusing duplicate assignment`);
      await requireLive(worker, mission);
      await send(worker, mission, true);
    },
  };
}
