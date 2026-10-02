# Workers

Beads graphs run each leaf in its own worker session. The frontend setting picks the host: `none` (background `omp -p`), `orca`, `herdr`, `custom`.

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
- **Scope check.** `git status` plus `git hash-object` before launch (saved beside the session) and after the yield. Files whose content differs are the worker's changes; each must fall inside its own `files` or those of any other dispatched bead (their workers answer for them, so a resumed worker is not blamed for what its siblings did). A path nobody owns, such as a stray file from a verification step, leaves the bead open. A stopped worker does not hold back other ready beads: dispatch continues, and `resend` surfaces once nothing else can start.
- **Stage.** After the scope check, the runner runs `git add -A` on the worker's own changed paths (serialised across workers; never a sibling's), because review diffs only include new files once staged. Telling the worker to do it cost a model call, a full prefix re-read, per bead: across 12 beads the average fell from 5.7 to 4.1 calls and from 60k to 42k tokens read per bead.
- **Close.** On a clean, in-scope `done:true`, the runner runs `bd close` with summary and verification. The worker never runs `bd`.
- **Chasing.** A session that stops without yielding gets up to two reminders, then is reported failed.
- **Restart.** Resume and release mutate beads, so they follow the same gate as `recover`: ownership held, no resume hold, not in plan mode (`WorkerHooks.canMutate`). A crashed session's controller lock goes stale after 30 seconds. `refresh` finds a subagent worker whose session is gone but whose bead is still claimed by that worker. `SessionManager.open` reopens the transcript with the saved baseline; with no transcript the claim is released and the worker goes `missing`, so `recover` re-dispatches. A worker that failed on its own keeps its error and waits for the operator.
- **Resend.** Live: `session.steer` with the operator's guidance, else a one-line continue. Not live: reopen the saved session with the last rejection and the guidance as the prompt. A subagent worker with a stored error makes the next action `resend` (not the generic recovery hold).
- **Release.** `release` aborts the session, runs `bd unclaim --if-assignee`, and closes the worker record; the bead returns to ready for a fresh dispatch.
- **Focus / reap.** No tab. `focus` points at the Agent Hub; `reap` aborts a live session.
- **Context.** `workerContext` picks the context files (`src/context.ts`); the bead title, description, and acceptance are inlined into the assignment.

## Cleanup

Close only the exact recorded terminal. NEVER close all terminals or the coordinator's own tab. `--keep` leaves worker tabs up.
