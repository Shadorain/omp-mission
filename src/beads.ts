import type { AuditEvent, Bead, Run, Snapshot } from './types.ts';

export interface BeadReader {
  graph(epicId: string, previous?: Snapshot): Promise<Snapshot>;
  history(beadId: string): Promise<AuditEvent[]>;
}

export function createBeadReader(run: Run, cwd: string, env?: Record<string, string>): BeadReader {
  return {
    graph: (epicId, previous) => readGraph(run, cwd, epicId, env, previous),
    history: beadId => readHistory(run, cwd, beadId, env),
  };
}

export async function readClaimActor(run: Run, cwd: string, beadId: string, env?: Record<string, string>): Promise<string | undefined> {
  const history = await readHistory(run, cwd, beadId, env);
  for (let index = history.length - 1; index >= 0; index--) {
    const event = history[index]!;
    const action = event.event.toLowerCase();
    if (!action.includes('claim')) continue;
    if (action.includes('unclaim') || action.includes('release')) return undefined;
    return event.actor || undefined;
  }
  return undefined;
}


async function invoke(run: Run, cwd: string, args: string[], env?: Record<string, string>): Promise<unknown> {
  const result = await run('bd', args, cwd, env);
  if (result.code !== 0) throw new Error(result.stderr || `bd ${args.slice(1).join(' ')} failed (${result.code})`);
  try { return JSON.parse(result.stdout); }
  catch { throw new Error(`bd ${args.slice(1).join(' ')} returned invalid JSON`); }
}

function rows(value: unknown, label: string): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    if (!value.every(isRecord)) throw new Error(`${label} contains an invalid row`);
    return value as Record<string, unknown>[];
  }
  if (!isRecord(value)) throw new Error(`${label} response is not an object`);
  for (const key of ['issues', 'beads', 'children', 'events', 'history', 'results']) {
    if (Array.isArray(value[key])) {
      const entries = value[key] as unknown[];
      if (!entries.every(isRecord)) throw new Error(`${label} contains an invalid row`);
      return entries as Record<string, unknown>[];
    }
  }
  if (value.truncated === true) throw new Error(`${label} response is truncated`);
  throw new Error(`${label} response has no row list`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(row: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const v = row[key];
    if (typeof v === 'string') return v;
  }
  return undefined;
}
function idOf(row: Record<string, unknown>): string | undefined { return text(row, 'id', 'issue_id', 'bead_id'); }
function statusOf(row: Record<string, unknown>): string {
  const status = text(row, 'status', 'state')?.toLowerCase();
  if (!status || !['open', 'in_progress', 'blocked', 'deferred', 'closed', 'pinned', 'hooked', 'done'].includes(status)) throw new Error(`Invalid bead status for ${idOf(row) ?? 'unknown'}`);
  return status;
}

export async function readGraph(run: Run, cwd: string, epicId: string, env?: Record<string, string>, previous?: Snapshot): Promise<Snapshot> {
  try {
    const epicResponse = await invoke(run, cwd, ['--readonly', 'show', epicId, '--json'], env);
    const epicRows = Array.isArray(epicResponse) ? rows(epicResponse, 'bd show epic') : isRecord(epicResponse) && idOf(epicResponse) ? [epicResponse] : rows(epicResponse, 'bd show epic');
    if (!epicRows.some(row => idOf(row) === epicId && text(row, 'issue_type', 'type') === 'epic')) throw new Error(`Mission epic missing or not an epic: ${epicId}`);
    const found = new Map<string, Record<string, unknown>>();
    const visited = new Set<string>();
    const active = new Set<string>();
    const walk = async (parentId: string): Promise<void> => {
      if (active.has(parentId)) throw new Error(`bead graph cycle at ${parentId}`);
      if (visited.has(parentId)) return;
      visited.add(parentId); active.add(parentId);
      const response = await invoke(run, cwd, ['--readonly', 'list', '--parent', parentId, '--all', '--limit', '0', '--json'], env);
      const children = rows(response, `bd list --parent ${parentId}`);
      if (isRecord(response) && response.truncated === true) throw new Error(`bead graph truncated below ${parentId}`);
      for (const child of children) {
        const id = idOf(child);
        if (!id) throw new Error(`bead graph row below ${parentId} has no ID`);
        if (active.has(id)) throw new Error(`bead graph cycle at ${id}`);
        const declaredParent = text(child, 'parent_id', 'parent');
        if (declaredParent && declaredParent !== parentId) throw new Error(`bead ${id} returned outside queried parent`);
        const prior = found.get(id);
        if (prior) {
          if (text(prior, 'parent_id') !== parentId) throw new Error(`bead ${id} appears under multiple parents`);
          continue;
        }
        found.set(id, { ...child, parent_id: parentId });
        await walk(id);
      }
      active.delete(parentId);
    };
    await walk(epicId);
    const readyResponse = await invoke(run, cwd, ['--readonly', 'ready', '--parent', epicId, '--limit', '0', '--json'], env);
    const readyRows = rows(readyResponse, 'bd ready');
    if (isRecord(readyResponse) && readyResponse.truncated === true) throw new Error('ready bead response is truncated');
    const readyIds = new Set(readyRows.map(idOf).filter((id): id is string => !!id));
    const beads: Bead[] = [];
    const descendants = new Map<string, string[]>();
    for (const [id, row] of found) {
      const parent = text(row, 'parent_id', 'parent');
      if (parent) {
        const siblings = descendants.get(parent) ?? [];
        siblings.push(id);
        descendants.set(parent, siblings);
      }
    }
    for (const [id, row] of found) {
      const status = statusOf(row);
      const issueType = (text(row, 'issue_type', 'type') ?? '').toLowerCase();
      const children = descendants.get(id) ?? [];
      const group = ['epic', 'convoy', 'molecule', 'gate'].includes(issueType) || children.length > 0;
      const closed = status === 'closed' || status === 'done';
      const deferred = status === 'deferred';
      const activeClaim = status === 'in_progress';
      const explicitlyBlocked = status === 'blocked';
      const ready = readyIds.has(id) && status === 'open' && !group;
      const category: Bead['category'] = group ? 'group' : closed ? 'closed' : deferred ? 'deferred' : activeClaim ? 'active' : explicitlyBlocked ? 'blocked' : ready ? 'ready' : 'waiting';
      beads.push({
        id, title: text(row, 'title', 'name') ?? id, status,
        assignee: text(row, 'assignee', 'assignee_name'), description: text(row, 'description', 'desc'), acceptance: text(row, 'acceptance_criteria', 'acceptance'),
        issue_type: issueType || undefined, children, parent: text(row, 'parent_id', 'parent'), ready,
        category,
      });
    }
    beads.sort((a, b) => a.id.localeCompare(b.id));
    const leaves = beads.filter(bead => bead.category !== 'group');
    return {
      beads, leaves, ready: beads.filter(bead => bead.ready).map(bead => bead.id),
      closed: leaves.filter(bead => bead.category === 'closed').length,
      active: leaves.filter(bead => bead.category === 'active').length,
      blocked: leaves.filter(bead => bead.category === 'blocked' || bead.category === 'waiting').length,
      fetchedAt: Date.now(),
    };
  } catch (error) {
    if (!previous) throw error;
    return { ...previous, beads: previous.beads, leaves: previous.leaves, ready: previous.ready, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function readHistory(run: Run, cwd: string, beadId: string, env?: Record<string, string>): Promise<AuditEvent[]> {
  const response = await invoke(run, cwd, ['--readonly', 'history', beadId, '--events', '--limit', '20', '--json'], env);
  const events = rows(response, `bd history ${beadId}`);
  if (isRecord(response) && response.truncated === true) throw new Error(`history for ${beadId} is truncated`);
  return events.map(event => {
    const action = text(event, 'event_type', 'event', 'action', 'type') ?? '';
    const explicit = text(event, 'summary', 'description', 'message');
    const reason = text(event, 'new_value') ?? '';
    const summary = explicit ?? (action === 'closed' && !reason.startsWith('{') ? reason.slice(0, 240) : action === 'claimed' ? 'Claimed implementation' : action === 'created' ? 'Created bead' : action);
    return {
      timestamp: text(event, 'timestamp', 'at', 'created_at') ?? '',
      actor: text(event, 'actor', 'actor_name') ?? '',
      event: action,
      summary,
    };
  }).sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
