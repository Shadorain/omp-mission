# Runtime smoke

Tests prove logic. UI and worker flows need the real program.

## Isolate

Use a throwaway agent dir so real missions and `mission.json` are untouched:

1. Make a temp root with a `workspace/` directory.
2. Write a `mission.json` and a mission file under `<root>/missions/<workspace-key>/` using `saveMission` and `missionPath`.
3. Create a session with `SessionManager.create(cwd, <root>/sessions)` and append a `mission:pointer` custom entry holding the mission path. Resume it, so the extension attaches.
4. Run OMP with `PI_CODING_AGENT_DIR=<root>`, `--no-extensions -e <repo>/index.ts`, and no tools or LSP.

## Drive and read (Orca)

```bash
orca terminal create --worktree path:<a registered worktree> --title <t> --command '<omp ...>' --json
orca terminal wait --terminal <handle> --for tui-idle --json
orca terminal send --terminal <handle> --text '/mission show' --enter --json
orca terminal read --terminal <handle> --screen --json
```

- `--worktree` MUST be a path Orca already knows; a temp dir fails with `selector_not_found`.
- Local sends return `observation: unsupported`. Acceptance is not delivery: read the screen to confirm.
- Send an Escape (`$'\e'`) to close an overlay before the next command.

## Controller and scope guards

Use an isolated deterministic provider to emit actual native tool calls; do not disable native approvals or Pause gates. Boot with an existing model, then select the registered fixture model in `session_start` because CLI provider selection happens before extension registration. Register its custom API with `registerCustomApi` as well as `pi.registerProvider` so SDK worker sessions can use it.

- Seed passed verification/delivery, bind a new scoped leaf through `mission_control`, and check saved evidence is cleared and the Pause wave still requires `/mission approve`.
- Dispatch a worker beside a closed sibling, have it write the sibling's file, then submit native `yield` as `{data:{done:true,summary:"..."}}`. Check its bead stays claimed/open, the scope error names the file, and the foreign change was not staged.
- Probe coordinator `write` and blanket Git staging, then a shell write to a previously unbound file. Check rejection/hold, invalidated delivery, unchanged blocked-write bytes, and retained shell-written bytes (no rollback).
- While verification is held, attempt model `record_verification passed=true` and `continue`; both must fail. An operator `/mission continue` resets verification to pending.
- Restore incomplete quota and deadline reviews. Read the actual widget and inspector: quota requires funding first; deadlines offer retry; completed and failed rows survive without a finalized round.
- Seed `round: 1` with multiple scoped beads. Let one target finish and make integration return invalid JSON twice. Confirm a saved completed target plus failure, without a finalized round. Restart OMP, release its resume hold, and retry with a valid reply carrying the requested `reviewedRevision`, `summary`, and `findings`. Compare provider calls and transcript paths: the completed reviewer must not run again; successful finalization clears partial progress. Classify fixture targets from their input (`bead` versus `beads`), not only the legacy flat `Context.systemPrompt`.

## Worker transport

To prove a multiline assignment starts cleanly, dispatch a throwaway worker whose prompt only asks for a fixed reply, with the worker command rewritten to `omp --no-tools -p @<file>`. Expect the reply on screen and no pasted draft.

## Clean up

Close only terminals you created, by exact handle with `--tab`. Delete the temp root and any `omp-mission-workers/*.prompt` you generated. Keep evidence under `.artifacts/`, which is ignored.
