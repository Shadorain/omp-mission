# Architecture

## Modules

|File|Owns|
|---|---|
|`src/extension.ts`|Wiring: events, command, tools, widget, shortcuts. `control()` is the single mutation entry.|
|`src/controller.ts`|Pure policy: `nextAction`, gates, mode, mutation enforcement. No I/O.|
|`src/store.ts`|Mission persistence, validation, controller ownership lock.|
|`src/workers.ts`, `src/hosts.ts`|Worker driver and per-frontend spawn/send/focus/reap. See @docs/workers.md.|
|`src/isolate.ts`|Checkout reuse or worktree creation, bead database discovery. Used by `bind_workspace` when arguments are omitted.|
|`src/beads.ts`|Reads the bead graph and history through `bd`.|
|`src/sources.ts`|Parses `/mission` input, fetches ticket source, inspects the workspace.|
|`src/review.ts`|Revision fingerprint and the independent reviewer session.|
|`src/prompts.ts`|Coordinator and worker prompts, plus per-step guides.|
|`src/status.ts`|Model-facing views of mission and graph state.|
|`src/ui.ts`, `src/completions.ts`, `src/config.ts`|Widget and inspector, argument completion, `mission.json`.|

## Lifecycle

Phases run in order: `plan`, `isolate`, `graph`, `execute`, `verify`, `deliver`, `review`, `repair`, `complete`. Evidence per phase is recorded on the mission. `nextAction` derives what is next from mission, graph snapshot, and policy; it never mutates.

Two graph kinds. `local`: work happens in the coordinator pane, no workers. `beads`: a bead epic with scoped leaves, executed by workers. A running mission keeps the graph it started with.

## Safety model

- **Native plan mode** forbids all mutation.
- **Resume hold**: a resumed mission is inspect-only until `/mission continue`.
- **Ownership**: one controller per mission, held by a lock. Losing it forces a resume hold.
- **Pause mode**: each wave, review, and repair acceptance needs an approved gate. A gate token binds to the exact scope, so a changed scope invalidates approval.
- **Native approval**: `mission_control` is an `exec` tool. Its approval prompt is part of the model-initiated path.

## Two entry paths

- Model: `mission_control` tool, native approval, brief result.
- Operator: `/mission <verb>` calls `control()` directly. Typing the command is the approval.

Both go through the same enforcement. Add an operation once, in `control()`.

## Coordinator context budget

Cost drivers, in order: saved mission JSON (source plus worker assignments), bead descriptions, repeated protocol text. Rules that follow:

- Tool results use `statusView` (`brief` after a control call).
- The source reaches the coordinator once, in the recovery JSON of the first message.
- Late-phase instructions are per-step guides returned with `mission_status`, not part of the first prompt.
- The coordinator never polls; the extension wakes it on state change.
- With `autoDispatch` on, `wakeCoordinator` runs `dispatch` itself when `autoDispatchAllowed` says so, so a plain wave costs no model turn. A failure hands the same wake to the model once.
- Model-chosen work (verify, deliver, review, repairs) stays with the coordinator. Deterministic work belongs in code.
