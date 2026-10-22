# Reference

Commands, flags, ticket sources, the mission row, configuration and environment variables. For how a mission moves through its phases, see [lifecycle.md](lifecycle.md).

## Starting a mission

```text
/mission CHR-142
/mission owner/repo#123
/mission -- Fix the session cookie path
/mission CHR-142 --force --pause --keep
```

### Ticket sources

| Input | Source | Needs |
| --- | --- | --- |
| `CHR-142` | Linear issue (2–5 letters, a dash, 1–5 digits; case-insensitive) | `lin` CLI |
| `owner/repo#123` | GitHub issue in that repository | `gh` CLI |
| `#123` or `123` | GitHub issue in the current repository | `gh` CLI |
| `https://github.com/owner/repo/issues/123` | GitHub issue | `gh` CLI |
| `-- <text>` | Freeform task; everything after `--` is the description | nothing |
| (nothing) | Ticket inferred from the checkout's branch or path | depends on the ticket |

A freeform description cannot be combined with a ticket. Words after a ticket are passed to the coordinator as extra instructions. An unknown `-` option is an error.

With no active mission, a bare `/mission` infers the ticket from the checkout. A saved mission for that ticket and worktree attaches read-only (run `/mission continue` to take control). If several tickets match, you pick one. Otherwise it starts planning the inferred ticket.

Linear checkout inference uses the first ticket identifier in each branch or path component. Later identifiers for the same project, or uppercase identifiers for other projects, still flag conflicts. Lowercase title suffixes such as `chr-143-domain-error-2` do not create an `ERROR-2` ticket.

Saved-ticket lookup matches repository **and worktree path**, not just repository and ticket ID. A new worktree for the same ticket does not inherit an older worktree's completed mission.

### Flags

| Flag | Effect |
| --- | --- |
| `--force`, `-f` | Start outside native plan mode in Force mode, which requests independent review. Refused inside plan mode. On an existing unfinished mission, continues it in Force mode. |
| `--pause` | Start in Pause mode: wait at each gate. With `--force`, skips plan mode but runs in Pause. |
| `--keep` | Leave worker tabs up after their beads close. |
| `--` | Everything after it is a freeform description. |

Typing `/mission <ticket>` without `--force` outside plan mode is rewritten to `/plan /mission <ticket>`, so planning always starts in native plan mode.

## Commands

| Command | What it does |
| --- | --- |
| `/mission` | On an active mission, opens the action menu. With no mission, infers the ticket from the checkout (see above). |
| `/mission show` | Opens the inspector. Read-only, safe any time. |
| `/mission continue` | Takes control of a saved mission after an OMP restart or resume. Required before any change. |
| `/mission approve` | Approves the waiting Pause gate and runs the step it approves. |
| `/mission mode [auto\|pause\|force]` | Sets the mode. With no argument, cycles auto → pause → force. |
| `/mission review` | Requests independent review, retries a failed one, or authorizes one more repair cycle. |
| `/mission check` | On a completed mission with a pull request, sends the pane to inspect and fix the PR. |
| `/mission history [run-id\|ticket\|bead-id]` | Browses completed runs read-only, or shows an active bead's audit log. |
| `/mission clear` | Detaches a completed mission or discards an unstarted plan. |
| `/mission config [key value]` | Shows or sets configuration. |
| `/mission actions` | Opens the action menu (same as bare `/mission`). |
| `/mission dispatch` | Beads graph: starts the ready wave yourself. |
| `/mission focus <bead-id>` | Beads graph: jumps to the bead's worker session. |
| `/mission resend <bead-id> [guidance]` | Resends the assignment, or continues a stopped subagent worker with guidance. |
| `/mission release <bead-id>` | Hands a bead back so a fresh worker can take it. |
| `/mission reap <bead-id>` | Closes the session of a worker whose bead is done. |

Commands you type run directly, with no model turn: typing the command is the approval. Only model-initiated operations go through the `mission_control` tool and its native approval prompt. Tool results are compact; the full source and worker assignments stay in the saved mission, not in context.

### The action menu

**Not sure what to run? Type `/mission`.** On an active mission it opens the action menu: only commands valid right now, the next step first (`▸`) and preselected. Completed missions put `show` first and preselect it; `clear` remains an explicit start-over choice.

`continue` is not a next-step command. It takes control of a saved mission after an OMP restart or resume. Until you run it, `approve`, `review` and `dispatch` stay read-only. `review` and `mode` are queued and applied by `continue`.

### Autocomplete

Tab completes the next argument and lists the next-step command first. Autocomplete keeps `show`, `config` and `history` visible. `continue`, `approve`, `review`, `mode` and `clear` appear only when relevant. Worker controls (`focus`, `resend`, `release`, `dispatch`, `reap`) stay out of the first-word suggestions, but the one the widget recommends is listed there and in the action menu without selecting a bead first. The others remain directly callable, and their arguments still complete when typed. Ticket IDs complete once you type a prefix. The bare `/mission` menu holds commands and flags only.

### History

`/mission history` opens a read-only browser of completed missions. `/mission history <run-id>` opens a specific run; a ticket ID filters its completed runs. Browsing does not attach the archived run, change the active mission, or take controller ownership. Cleared runs remain in history. `/mission history <bead-id>` shows an active mission bead's audit log.

### Clear

`/mission clear` detaches a completed mission or discards an unstarted plan, including in plan mode. Saved mission history, beads, files and external worker panes stay untouched. The cleared mission is excluded from lookup in this session, including after resume; `/mission` can then create a fresh plan with a new run ID. Clearing an unfinished saved mission is refused. Plan approval, Pause gates and controller ownership still apply to the new run.

### Check a delivered PR

`/mission check` works on a completed mission with a pull request. See [lifecycle.md](lifecycle.md#check-a-delivered-pr) for what the pane does and the outcomes it records.

## The mission row

The row above the editor is the live state. The line under it shows the next action, for example `/mission continue` for a resumed mission, `/mission approve` at a Pause gate, or `/mission review` after a failed review. Commands appear only when the operator can act; quota blocks explain the prerequisite instead of offering a blind retry. Worker-level recommendations stay in the action menu. Attaching a saved mission also prints the next step.

The compact row shows the ticket, phase, mode and actionable status. Session names and rows omit source prefixes such as `linear:`; custom session names are preserved. Source, frontend, graph, native plan state and the expand shortcut appear in the expanded row and inspector instead. The inspector hides the editor row while open.

The header labels dependency-waiting beads as **waiting** with a neutral indicator. Only explicitly blocked beads use the error indicator; waiting for another worker is not a failed task. Phase labels follow recorded verification and delivery, so a review-ready mission shows **Review**, not **Execute**.

### Shortcuts

| Key | Default | Action |
| --- | --- | --- |
| `expand` | `ctrl+shift+m` | Expand the row |
| `fullscreen` | `ctrl+shift+f` | Open the inspector |
| `mode` | `ctrl+shift+o` | Cycle the mode |

While a mission is visible, its expand key takes precedence over OMP's model-picker shortcut; without a mission, OMP keeps its normal key handling. Change or disable keys in `mission.json` (see `keys` below).

## Configuration

Configuration lives in `~/.omp/agent/mission.json`. `PI_CODING_AGENT_DIR` or `OMP_AGENT_DIR` replaces `~/.omp/agent`. A missing file means all defaults.

Bare `/mission config` shows the path and every value, including shortcuts. If the active mission uses a different graph, that graph is shown separately. A write reports the result, for example `Configuration set at ~/.omp/agent/mission.json: graph beads`.

```text
/mission config graph beads
/mission config frontend orca
/mission config frontend custom -- <launcher> {cwd} {title} {command} {prompt}
/mission config modelRole slow
/mission config workerRole task
/mission config workerContext none
/mission config autoDispatch on
```

`/mission config` sets `graph`, `frontend` (with `customCommand` for `custom`), `modelRole`, `workerRole`, `workerContext`, `reviewContext` and `autoDispatch`. Edit the file for `maxWorkers`, `reviewConcurrency`, `controls` and `keys`. The file must contain `"version": 1`.

| Key | Default | Meaning |
| --- | --- | --- |
| `graph` | `local` | `local` works in this pane. `beads` is the durable worker graph. A running mission keeps the graph it started with. |
| `frontend` | `none` | Where beads workers run: `none` (background `omp -p`), `orca`, `herdr`, `custom` or `subagent`. See [workers.md](workers.md). |
| `customCommand` | (unset) | Worker launch template for `frontend: custom`; required there. One line, under 2000 characters. It must print JSON with the new session's `handle`. Placeholders are listed in [workers.md](workers.md#custom-frontend). |
| `workerContext` | `project` | Context files a `subagent` worker loads: `project` (your `<agentDir>/AGENTS.md` plus the checkout's `AGENTS.md`, else `CLAUDE.md`), `all` (everything OMP discovers) or `none`. Context files ride in every request, so this is the largest fixed cost of a worker. |
| `reviewContext` | `project` | The same choice for review sessions. |
| `maxWorkers` | `2` | Integer from 1 through 8: the most live workers at once. |
| `reviewConcurrency` | `3` | Integer from 1 through 8: how many per-bead review sessions run at once (subagent frontend; see [review.md](review.md#per-bead-review)). |
| `modelRole` | `default` | OMP model role for the independent review session: `default` (the coordinator's own model), `slow`, `smol` or any role in `modelRoles`. `@default` and `default` are the same. A role that does not name one available `provider/id` model falls back to the coordinator's model; the model used is recorded on each review round. |
| `workerRole` | `task` | Model role for bead workers, passed as `--model` for every frontend. A role with no configured model, or `default`, leaves workers on the default model. The role resolves at launch, so a change applies to the next worker. |
| `autoDispatch` | `false` | When on, ready waves in Auto and Force modes start without a model turn or per-wave tool approval. Pause mode, resume hold, plan mode, a blocker and lost ownership still stop it, and a failed attempt is handed to the coordinator. |
| `controls` | `false` | Inspector action button. `/mission actions` and the other commands remain available either way. |
| `keys` | see [Shortcuts](#shortcuts) | `expand`, `fullscreen`, `mode`. `null` turns one off. Enabled chords must be distinct. |

## Environment variables

| Variable | Effect |
| --- | --- |
| `PI_CODING_AGENT_DIR`, `OMP_AGENT_DIR` | Replace `~/.omp/agent` as the agent directory. |
| `OMP_HOLOTABLE_CHILD=1` | Marks a board-launched pane; it serves the control socket. |
| `OMP_MISSION_AUTOSTART` | `/mission` arguments run at `session_start` (used with `plan.defaultOnStartup`). |
| `OMP_MISSION_BASE` | Explicit base branch for workspace inspection. |
| `OMP_MISSION_CHECKOUT`, `OMP_MISSION_DELIVERY` | Reuse-only checkout binding at the first turn, skipping ticket-name matching. Delivery is `pr` or `local`. |
| `OMP_MISSION_GRAPH` | `local` or `beads` for the planned mission, overriding `graph`. |

The `OMP_MISSION_*` variables are per-launch overrides that Holotable sets; see [holotable.md](holotable.md#launch-overrides).

## Updating

Restart or resume OMP after updating the extension. `/reload-plugins` does not reload extension factories. Existing panes need a restart or relaunch to load new capabilities.
