# omp-mission

Plan and run a ticket or task through verification and review. The row above the editor is the live state.

![Compact gate, compact auto, and expanded bead list](docs/preview.png)

OMP 18.4.4 or later. Restart OMP after install.

## Install

```text
/marketplace add Shadorain/omp-mission
/marketplace install mission@omp-mission
```

Or clone it into the extensions directory:

```bash
git clone https://github.com/Shadorain/omp-mission.git ~/.omp/agent/extensions/omp-mission
```

## Use

```text
/mission CHR-142
/mission owner/repo#123
/mission -- Fix the session cookie path
/mission CHR-142 --force --pause --keep
```

`--force` starts outside plan mode and requests review. `--pause` waits at each gate. `--keep` leaves worker tabs up.

```text
/mission show | continue | mode | approve | review
/mission history | focus | resend | reap | dispatch | actions | config
```

Commands you type run directly, with no model turn. Only model-initiated operations go through the `mission_control` tool and its native approval. Tool results are compact; the full source and worker assignments stay in the saved mission, not in context.

Tab completes the next argument. `ctrl+shift+m` expands the row. `ctrl+shift+f` opens the inspector. `ctrl+shift+o` cycles mode.

The compact row shows the ticket, phase, mode, and actionable status. Session names and rows omit source prefixes such as `linear:`; custom session names are preserved. Source, frontend, graph, native plan state, and the expand shortcut appear in the expanded row and inspector instead. The inspector hides the editor row while open. While a mission is visible, its configured expand key takes precedence over OMP's model-picker shortcut; without a mission, OMP keeps its normal key handling.

## Configuration

`~/.omp/agent/mission.json`. Bare `/mission config` displays the path and all configured values, including shortcuts. If the active mission uses a different graph, that graph is shown separately. A write says `Configuration set at ~/.omp/agent/mission.json: graph beads`.

```text
/mission config graph beads
/mission config frontend orca
/mission config frontend custom -- omp --print
/mission config modelRole smol
/mission config autoDispatch on
```

| Key | Default | |
| --- | --- | --- |
| `graph` | `local` | `local` works in this pane. `beads` is the durable worker graph. A running mission keeps the graph it started with. |
| `frontend` | `none` | `none`, `orca`, `herdr`, or `custom`. |
| `maxWorkers` | `2` | Integer from 1 through 8. |
| `modelRole` | `smol` | OMP model role for the independent review session, e.g. `smol`, `slow`, or `default` (the coordinator's own model). A role that does not name one available `provider/id` model falls back to the coordinator's model; the model used is recorded on each review round. |
| `autoDispatch` | `false` | When on, ready waves in Auto and Force modes start without a model turn or per-wave tool approval. Pause mode, resume hold, plan mode, and lost ownership still stop it, and a failed attempt is handed to the coordinator. |
| `controls` | `false` | Inspector action button. `/mission actions` and other commands remain available either way. |
| `keys` | `ctrl+shift+m`, `ctrl+shift+f`, `ctrl+shift+o` | `expand`, `fullscreen`, `mode`. `null` turns one off. |

`PI_CODING_AGENT_DIR` or `OMP_AGENT_DIR` replaces `~/.omp/agent`.

## Orca workers

Workers receive the full multiline assignment through OMP's startup `@file` argument, not a composer paste. The assignment is short: bead, paths, rules. The ticket text is written once per mission to a shared file the worker reads only when the bead lacks context. `/mission focus <bead-id>` reads the persisted worker identity before switching tabs.

`/mission resend <bead-id>` sends a short instruction to read the assignment file. Input acceptance alone is not delivery: if Orca cannot confirm a started turn, inspect the worker tab before retrying. For an old worker with its assignment still pasted in the composer, submit that existing draft rather than pasting it again.

Restart or resume OMP after updating extension code. `/reload-plugins` does not reload extension factories.

A worker never stalls a mission silently. If its terminal disappears while the bead is unclaimed, the dead record is replaced automatically and the next action becomes `dispatch`. A live worker that has not claimed its bead within 3 minutes surfaces as `resend`, answered by one `resend` after inspecting the tab. A resume hold blocks both until `/mission continue`. Auto missions stop at delivery unless review was requested; run `/mission review` to continue into the independent review.

## Checkout and bead database

`mission_control bind_workspace` with no arguments does the isolate step in code: it reuses a checkout whose branch or path already names the ticket, or creates `mission/<slug>` in a sibling `<repo>-mission-<slug>` worktree from the primary checkout, then finds the canonical bead database and picks `pr` or `local` delivery. It stops with the reason when the base branch is unresolved, the branch or path is taken, or the checkout is a linked worktree for something else. A retry reuses the worktree it already made. It never runs `bd init`: a missing database is reported with the command. Passing `cwd`, `beadsDir`, `delivery`, or `base` overrides any default.

## Review and repairs

Independent review results must match the verified revision and persisted field limits. Invalid results are rejected before they enter mission history.

Accepting local repairs advances the review round and clears earlier verification and delivery evidence. Passing verification requires changed output while actionable findings remain. Beads repairs advance the round when their finding-linked graph is bound; verification requires a nonempty graph whose implementation leaves are completed (`closed` or `done`).

Repair evidence becomes passed or failed with verification, rather than staying active through delivery. Explicitly rejecting every accepted finding skips repair evidence and allows unchanged output to be reverified. Delivery and independent rereview remain required for changed output.


## Develop

```bash
git clone https://github.com/Shadorain/omp-mission.git
cd omp-mission
bun install
bun test
bun run typecheck
```

## License

[MIT](LICENSE)
