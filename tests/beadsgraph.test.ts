import { describe, expect, test } from 'bun:test';
import { readGraph, readHistory, readClaimActor } from '../src/beads.ts';
import type { Run } from '../src/types.ts';

// Real-format fixtures captured from `bd` 1.3.0

const showEpic = [
  {
    "id": "zz-frc",
    "title": "Main Epic 🌟",
    "status": "open",
    "priority": 2,
    "issue_type": "epic"
  }
];

const listEpicChildren = [
  { "id": "zz-frc.1", "title": "Group L1 0", "status": "open", "issue_type": "task", "parent": "zz-frc" },
  { "id": "zz-frc.4", "title": "Closed Child", "status": "closed", "issue_type": "task", "parent": "zz-frc" },
  { "id": "zz-frc.5", "title": "Deferred Child", "status": "deferred", "issue_type": "task", "parent": "zz-frc" },
  { "id": "zz-frc.6", "title": "In Prog Child", "status": "in_progress", "issue_type": "task", "parent": "zz-frc" },
  { "id": "zz-frc.7", "title": "Blocked Child", "status": "open", "issue_type": "task", "parent": "zz-frc", "dependencies": [{"type": "blocks", "depends_on_id": "zz-frc.8"}] },
  { "id": "zz-frc.8", "title": "Blocker Child", "status": "open", "issue_type": "task", "parent": "zz-frc" },
  { "id": "zz-frc.11", "title": "Claimed Bead", "status": "in_progress", "issue_type": "task", "assignee": "bd-worker-1", "parent": "zz-frc" },
  { "id": "zz-dot.1.2", "title": "Dot Bead", "status": "open", "issue_type": "task", "parent": "zz-frc" }
];

// simulate bd list --parent zz-frc.7 --all
const listChild7 = [];
const listDotBead = [];

const readyEpic = [
  { "id": "zz-frc.8", "title": "Blocker Child", "status": "open", "issue_type": "task" },
  { "id": "zz-dot.1.2", "title": "Dot Bead", "status": "open", "issue_type": "task" }
];

const mockRun = (responses: Record<string, any>): Run => async (command, args) => {
  const argStr = args.join(' ');
  for (const [key, val] of Object.entries(responses)) {
    if (argStr.includes(key)) {
      if (val instanceof Error) throw val;
      return { stdout: JSON.stringify(val), stderr: '', code: 0 };
    }
  }
  return { stdout: '[]', stderr: '', code: 0 };
};

describe('real bd json projection', () => {
  test('correctly maps raw array shapes and states to bead categories', async () => {
    const snap = await readGraph(mockRun({
      'show zz-frc': showEpic,
      'list --parent zz-frc ': listEpicChildren,
      'list --parent zz-frc.': [], // Catch all other list calls
      'ready --parent zz-frc': readyEpic,
    }), '/tmp', 'zz-frc');

    expect(snap.beads.length).toBe(listEpicChildren.length);
    
    // Group L1 has no children in this truncated fixture, but it should still be a leaf unless its type makes it a group
    // Wait, in real it had children. Since it doesn't here, it will be a leaf.
    
    const closed = snap.beads.find(b => b.id === 'zz-frc.4')!;
    expect(closed.category).toBe('closed');
    
    const deferred = snap.beads.find(b => b.id === 'zz-frc.5')!;
    expect(deferred.category).toBe('deferred');

    const inProg = snap.beads.find(b => b.id === 'zz-frc.6')!;
    expect(inProg.category).toBe('active');

    const claimed = snap.beads.find(b => b.id === 'zz-frc.11')!;
    expect(claimed.category).toBe('active');
    expect(claimed.assignee).toBe('bd-worker-1');
    
    // Even though bd didn't mark zz-frc.7 as explicitly status="blocked" (it is open but depends on 8),
    // wait, bd graph doesn't change status to blocked automatically?
    // In our test, we checked `status === 'blocked'` for category='blocked', else category='waiting' if not ready.
    const blocked = snap.beads.find(b => b.id === 'zz-frc.7')!;
    expect(blocked.category).toBe('waiting'); // Not explicitly blocked, just not ready

    const blocker = snap.beads.find(b => b.id === 'zz-frc.8')!;
    expect(blocker.category).toBe('ready'); // Ready

    const dotBead = snap.beads.find(b => b.id === 'zz-dot.1.2')!;
    expect(dotBead.category).toBe('ready');
  });

  test('extracts claim actor from real history shape', async () => {
    const rawHistory = [
      {
        "event_type": "updated",
        "actor": "Shadorain",
        "new_value": "{\"metadata\":{\"huge_data\":\"x\"}}",
        "created_at": "2026-09-30T02:25:39Z"
      },
      {
        "event_type": "claimed",
        "actor": "bd-worker-1",
        "new_value": "{\"assignee\":\"bd-worker-1\",\"status\":\"in_progress\"}",
        "created_at": "2026-09-30T02:25:39Z"
      },
      {
        "event_type": "created",
        "actor": "Shadorain",
        "new_value": "",
        "created_at": "2026-09-30T02:25:39Z"
      }
    ];
    const events = await readHistory(mockRun({
      'history zz-frc.11': rawHistory
    }), '/tmp', 'zz-frc.11');
    expect(events.length).toBe(3);
    expect(events[1]!.event).toBe('claimed');
    
    const actor = await readClaimActor(mockRun({
      'history zz-frc.11': rawHistory
    }), '/tmp', 'zz-frc.11');
    expect(actor).toBe('bd-worker-1');
  });
});
