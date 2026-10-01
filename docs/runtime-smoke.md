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

## Worker transport

To prove a multiline assignment starts cleanly, dispatch a throwaway worker whose prompt only asks for a fixed reply, with the worker command rewritten to `omp --no-tools -p @<file>`. Expect the reply on screen and no pasted draft.

## Clean up

Close only terminals you created, by exact handle with `--tab`. Delete the temp root and any `omp-mission-workers/*.prompt` you generated. Keep evidence under `.artifacts/`, which is ignored.
