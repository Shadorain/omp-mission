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

Every tool result and message stays in context for the rest of the session, and anything that changes the prompt prefix forces the whole conversation to be re-cached. Rules:

- **Results carry decisions only.** `briefView` (control results) and `statusView` (`mission_status`) in `src/status.ts` drop source text, worker assignments, bead descriptions, timestamps, and the lock nonce. Add a field only if the model acts on it.
- **The wake message is the status call.** It names the next step, its ids, and the guide for it, so the coordinator rarely needs `mission_status`. A guide is sent once per step: with the wake or with the first result that reaches that step.
- **The system prompt never changes mid-session.** The extension does not use `before_agent_start`. Phase, mode, and next-step text are volatile; putting them in the system prompt turned every state change into a cache miss on the whole history.
- **The ticket reaches the coordinator once**, in the recovery JSON of the first message, and reaches workers as a file they read on demand.
- **The coordinator never polls**; the extension wakes it on state change.
- **autoDispatch** runs `dispatch` in `wakeCoordinator` when `autoDispatchAllowed` says so, so a plain wave costs no model turn. A failure hands the same wake to the model once.
- **Model-chosen work** (verify, deliver, review, repairs) stays with the coordinator. Deterministic work belongs in code.
- Operator output sent with `sendMessage` enters context. Keep it short (`/mission history` shows 12 events).
