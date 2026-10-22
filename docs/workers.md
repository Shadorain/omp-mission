# Workers

Beads graphs run each leaf in its own worker session. The `frontend` setting picks where workers run:

| Frontend | Worker runs as |
| --- | --- |
| `none` (default) | A background `omp -p` process |
| `orca` | An Orca terminal tab |
| `herdr` | A Herdr tab and agent |
| `custom` | Whatever `customCommand` launches |
| `subagent` | An in-process OMP session, shown in the Agent Hub |

Workers start on the `workerRole` model. The local graph has no workers.

## Terminal workers

The `none`, `orca`, `herdr` and `custom` frontends start a separate `omp` process for each bead.

A worker never stalls a mission silently. If its terminal disappears while the bead is unclaimed, the dead record is replaced automatically and the next action becomes `dispatch`. A live worker that has not claimed its bead within 3 minutes surfaces as `resend`, answered by one `resend` after inspecting the tab. A resume hold blocks both until `/mission continue`.

### Orca

Workers receive the full multiline assignment through OMP's startup `@file` argument, not a composer paste. The assignment is short: bead, paths, rules. The ticket text is written once per mission to a shared file the worker reads only when the bead lacks context. `/mission focus <bead-id>` reads the persisted worker identity before switching tabs.

`/mission resend <bead-id>` sends a short instruction to read the assignment file. Input acceptance alone is not delivery: if Orca cannot confirm a started turn, inspect the worker tab before retrying. For an old worker with its assignment still pasted in the composer, submit that existing draft rather than pasting it again.

### Custom frontend

```text
/mission config frontend custom -- <launcher> {cwd} {title} {command} {prompt}
```

`<launcher>` stands for your own tab or session launcher; the rest of the line is a template. It runs through `bash -lc` in the worker's checkout. Each placeholder becomes one shell-quoted argument, and your launcher decides how to use them:

| Placeholder | Value |
| --- | --- |
| `{cwd}` | The worker's checkout |
| `{title}` | `mission-<bead-id>` |
| `{command}` | The worker's `omp` command line (environment and `--model`), without the assignment |
| `{bead}` | The bead ID |
| `{prompt}` | The assignment text |
| `{handle}` | Empty |

The command must print JSON with the new session's `handle` (or `id`) and, optionally, `incarnationId`. A custom frontend has no send or close channel: `resend` is refused, and liveness checks and `reap` work only when the handle is a process ID.

## Subagent workers

`/mission config frontend subagent` runs each bead in an in-process OMP session instead of a separate terminal or `omp -p` process. Beads graphs only. The session has file, shell and search tools plus `yield`; no extensions, MCP, skills or rules; and approvals are off (`yolo`). Shell commands run in the foreground until they finish (no auto-background, no async jobs): the session has no wait tool and its turn ends at yield, so a backgrounded `cargo auto` used to end in a `done: false, "waiting"` result. Sessions appear in the Agent Hub (`Alt+A`) as `<bead-id>`.

The extension, not the worker, owns `bd`. It claims the bead as the bead's own actor before the session starts. The worker returns `{done, summary, verification}` through the native yield tool. A launch baseline and mutating-tool traces attribute shared-checkout changes: unrelated sibling edits do not blame an innocent finisher, but attributed edits outside the worker's scope and unattributed changes outside all worker scopes leave its bead open.

A clean result stages only the worker's own changes and closes the bead with its summary and verification. `done: false`, a missing yield, or a failed `bd close` leaves the bead claimed and surfaces `resend` with the reason.

`/mission resend <bead-id> [guidance]` continues the same session with the rejection and guidance (a live session is steered). `mission_control resend` and the socket `resend` also take `files`: extra workspace-relative paths added to that worker's allowed paths and the bead's scope before it continues, refused when they overlap another open worker's scope. A leaf whose text asks it to update a doc, index or audit file outside its scope finishes on one resend instead of stopping twice and blocking the mission. `/mission release <bead-id>` aborts the session, unclaims the bead, and closes the worker record so a fresh worker can take the next dispatch.

Sibling scopes do not authorize a worker's own edits: mutating tools naming a changed file outside its assigned paths are rejected even when the sibling owning it is already closed. Scope checks attribute changes after execution; they are not a filesystem sandbox.

Sessions are saved under `missions/<workspace>/workers/`. After an OMP restart, once the session owns the mission and `/mission continue` has lifted the hold, a worker whose claim is still held resumes from its transcript. A session that cannot take ownership, or is still held, only observes; after a crash the old session's lock expires in 30 seconds. If the transcript is gone, the claim is released and the bead is dispatched again. Closing OMP aborts live sessions and keeps their claims.

With this frontend, review also runs per bead; see [review.md](review.md#per-bead-review).

---

The rest of this file describes the implementation.

## Launch

- Orca: the assignment is written to a prompt file and the worker starts as `omp @<file>`. NEVER paste a multiline assignment into a live composer: a bracketed paste is not submitted by a trailing Enter, and the worker sits idle with a pasted draft.
- The worker prompt stays short. The ticket is written once per mission to `<tmp>/omp-mission-workers/<mission-id>.source.md` and the prompt points at it; the worker reads it only when its bead lacks context. The bead itself (`bd show`) carries the task.
- Orca injects `ORCA_TERMINAL_HANDLE` into the terminal; the close instruction uses it, so the prompt needs no handle at generation time.

## Model

Workers start on the `workerRole` model (default `task`) via `--model`. The role resolves when the worker launches, so a config change applies to the next worker, not running ones. `default` or an unconfigured role means no flag.

## Identity

A worker is recorded with its terminal handle and incarnation id. Every focus, resend, and reap re-validates both against the live terminal list and the worktree path. A mismatch means missing, never a guess.

Records are append-only per bead. A replaced worker is marked `closed` with `replaced:` in its error, and lookups use the latest record for a bead.

## Claim and stalls

- `awaiting-claim`: launched, bead not yet claimed by the worker actor.
- A live worker with no claim after the stall window surfaces as next action `resend`.
- A worker whose terminal is gone while the bead is unclaimed is replaced automatically during refresh, only when the mission is not on hold and is owned. A claimed bead is never auto-replaced.

## Resend

`resend` types one short line pointing at the prompt file. Orca's prompt receipt is the only delivery evidence: `turn_started` is success. `input_accepted` alone, or an `unsupported` provider, is reported as unconfirmed and is NEVER retried blindly. A stranded draft is submitted with a bare Enter send, no text.

## Subagent frontend

Code: `src/subagent.ts` (`SubagentRunner`), driven by the worker driver through `SubagentPort`. No terminal exists; the worker `handle` is the bead id and `incarnationId` is the persisted session file.

- **Claim.** The runner claims with `BEADS_ACTOR=<bead id> bd update --claim` before creating the session; a failed claim starts nothing, a failed session start releases the claim (`bd unclaim --if-assignee`).
- **Tools.** `read edit write bash grep glob find` plus `yield` with schema `{done, summary, verification?}`. `restrictToolNames`, no extensions, MCP, skills, rules, or slash commands. `tools.approvalMode` is `yolo`; the scope check below is the guard.
- **Scope check.** `git status` plus `git hash-object` before launch (saved beside the session) and after yield. Sibling changes do not blame an innocent finisher, but mutating tool calls naming changed files outside this worker's scope reject completion even when the sibling owner is closed. Unattributed changes outside all worker scopes also leave the bead open. This is post-run attribution, not filesystem isolation; arbitrary scripts whose arguments do not name their changed paths cannot always be attributed. A stopped worker does not hold back other ready beads: `resend` surfaces once nothing else can start.
- **Stage.** After the scope check, the runner runs `git add -A` on the worker's own changed paths (serialised across workers; never a sibling's), because review diffs only include new files once staged. Telling the worker to do it cost a model call, a full prefix re-read, per bead: across 12 beads the average fell from 5.7 to 4.1 calls and from 60k to 42k tokens read per bead.
- **Close.** On a clean, in-scope `done:true`, the runner runs `bd close` with summary and verification. The worker never runs `bd`.
- **Chasing.** A session that stops without yielding gets up to two reminders, then is reported failed.
- **Restart.** Resume and release mutate beads, so they follow the same gate as `recover`: ownership held, no resume hold, not in plan mode (`WorkerHooks.canMutate`). A crashed session's controller lock goes stale after 30 seconds. `refresh` finds a subagent worker whose session is gone but whose bead is still claimed by that worker. `SessionManager.open` reopens the transcript with the saved baseline; with no transcript the claim is released and the worker goes `missing`, so `recover` re-dispatches. A worker that failed on its own keeps its error and waits for the operator.
- **Resend.** Live: `session.steer` with the operator's guidance, else a one-line continue. Not live: reopen the saved session with the last rejection and the guidance as the prompt. `files` first widens the worker's `files` and `mission.scopes[bead]` (normalized, no `..`, checked with `assertNonOverlapping` against every other open worker) and tells the worker its new paths. A subagent worker with a stored error makes the next action `resend` (not the generic recovery hold).
- **Release.** `release` aborts the session, runs `bd unclaim --if-assignee`, and closes the worker record; the bead returns to ready for a fresh dispatch.
- **Focus / reap.** No tab. `focus` points at the Agent Hub; `reap` aborts a live session.
- **Context.** `workerContext` picks the context files (`src/context.ts`); the bead title, description, and acceptance are inlined into the assignment.

## Cleanup

Close only the exact recorded terminal. NEVER close all terminals or the coordinator's own tab. `--keep` leaves worker tabs up.

Coordinator boundaries (blocked writes, Git guards, quiescent-checkout fingerprints) are described in [lifecycle.md](lifecycle.md#coordinator-boundaries).
