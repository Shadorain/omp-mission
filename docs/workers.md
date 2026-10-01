# Workers

Beads graphs run each leaf in its own worker session. The frontend setting picks the host: `none` (background `omp -p`), `orca`, `herdr`, `custom`.

## Launch

- Orca: the assignment is written to a prompt file and the worker starts as `omp @<file>`. NEVER paste a multiline assignment into a live composer: a bracketed paste is not submitted by a trailing Enter, and the worker sits idle with a pasted draft.
- The worker prompt stays short. The ticket is written once per mission to `<tmp>/omp-mission-workers/<mission-id>.source.md` and the prompt points at it; the worker reads it only when its bead lacks context. The bead itself (`bd show`) carries the task.
- Orca injects `ORCA_TERMINAL_HANDLE` into the terminal; the close instruction uses it, so the prompt needs no handle at generation time.

## Identity

A worker is recorded with its terminal handle and incarnation id. Every focus, resend, and reap re-validates both against the live terminal list and the worktree path. A mismatch means missing, never a guess.

Records are append-only per bead. A replaced worker is marked `closed` with `replaced:` in its error, and lookups use the latest record for a bead.

## Claim and stalls

- `awaiting-claim`: launched, bead not yet claimed by the worker actor.
- A live worker with no claim after the stall window surfaces as next action `resend`.
- A worker whose terminal is gone while the bead is unclaimed is replaced automatically during refresh, only when the mission is not on hold and is owned. A claimed bead is never auto-replaced.

## Resend

`resend` types one short line pointing at the prompt file. Orca's prompt receipt is the only delivery evidence: `turn_started` is success. `input_accepted` alone, or an `unsupported` provider, is reported as unconfirmed and is NEVER retried blindly. A stranded draft is submitted with a bare Enter send, no text.

## Cleanup

Close only the exact recorded terminal. NEVER close all terminals or the coordinator's own tab. `--keep` leaves worker tabs up.
