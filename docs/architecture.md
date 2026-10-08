# Architecture

## Modules

|File|Owns|
|---|---|
|`src/extension.ts`|Wiring: events, command, tools, widget, shortcuts. `control()` is the single mutation entry.|
|`src/controller.ts`|Pure policy: `nextAction`, `operatorStep` (the command a person should run now, shown in the widget, menu and completions), gates, mode, mutation enforcement. No I/O.|
|`src/store.ts`|Mission persistence, validation, controller ownership lock.|
|`src/workers.ts`, `src/hosts.ts`|Worker driver and per-frontend spawn/send/focus/reap. See @docs/workers.md.|
|`src/subagent.ts`, `src/scope.ts`, `src/context.ts`|In-process worker sessions for `frontend: subagent`, allowed-path matching, context file selection. See @docs/workers.md.|
|`src/coordinator-guard.ts`|Coordinator file-write and Git-command classification, plus quiescent-checkout fingerprints consumed by extension hooks.|
|`src/isolate.ts`|Checkout reuse or worktree creation, bead database discovery. Used by `bind_workspace` when arguments are omitted.|
|`src/beads.ts`|Reads the bead graph and history through `bd`.|
|`src/sources.ts`|Parses `/mission` input, fetches ticket source, inspects the workspace.|
|`src/review.ts`|Revision fingerprint and the independent reviewer session. `runPerBead` runs one reviewer per bead in parallel plus an integration pass, and re-reviews only beads whose owned files changed. Reviewers are registered as subagents of Main (global registry, `taskDepth: 1`), emit progress events, and persist transcripts that `ReviewRound.transcripts` points at.|
|`src/prompts.ts`|Coordinator and worker prompts, plus per-step guides.|
|`src/status.ts`|Model-facing views of mission and graph state.|
|`src/ui.ts`, `src/completions.ts`, `src/config.ts`|Widget and inspector, argument completion, `mission.json`.|

## Lifecycle

Phases run in order: `plan`, `isolate`, `graph`, `execute`, `verify`, `deliver`, `review`, `repair`, `complete`. Evidence per phase is recorded on the mission. `nextAction` derives what is next from mission, graph snapshot, and policy; it never mutates.

Two graph kinds. `local`: work happens in the coordinator pane, no workers. `beads`: a bead epic with scoped leaves, executed by workers. A running mission keeps the graph it started with.

## Evidence and review progress

Binding repair work, a different epic, unfinished leaves, or changed scopes invalidates verification, delivery, review, completion evidence and partial review progress before execution. Saved rounds remain history; Pause approval is rebuilt for the new scope.

Per-bead review partitions file ownership before launching sessions: repair-link insertion order takes precedence over original scopes. The full mission source is authoritative; prior decisions are contextual history, not same-line supersedence. A per-bead finding on a file another bead owns is moved to that owner; a path no bead owns is dropped. Neither fails the target. Integration deduplicates exact findings while preserving distinct same-site defects.

`Mission.reviewProgress` checkpoints completed targets and failed labels without finalizing the round. Reuse binds to round, revision, model, prompt, input and context hashes; canonical JSON serialization keeps save/load property ordering from invalidating equivalent inputs. Each checkpoint is serialized and awaited. Successful completion creates the round and clears partial progress; old missions need no progress field.


## Safety model

- **Native plan mode** forbids all mutation.
- **Resume hold**: a resumed mission is inspect-only until `/mission continue`.
- **Ownership**: one controller per mission, held by a lock. Losing it forces a resume hold.
- **Pause mode**: each wave, review, and repair acceptance needs an approved gate. A gate token binds to the exact scope, so a changed scope invalidates approval.
- **Native approval**: `mission_control` is an `exec` tool. Its approval prompt is part of the model-initiated path.
- **Verification hold**: a failed verification parks only in Pause and on the local graph. Only the operator's `continue` resets that park; model `continue` and a fresh success record cannot bypass it. Beads Auto and Force do not park: the failure detail is the next step, which is bind an unbound leaf or create and bind a repair leaf, and not another verification. `cargo fmt` without `--check` is rejected before it writes. A formatter that still changes files records the paths and, outside Pause, tells the coordinator to assign them to a leaf instead of waiting.
- **Coordinator boundaries**: active beads missions reject direct checkout writes and blanket staging. Quiescent shell postflight detects implementation changes, invalidates later evidence and holds verification without rollback. It is not filesystem isolation.

## Automatic start

Approving the plan is the approval to start. A `before_agent_start` hook sees the synthetic `Plan approved.` prompt (or the first message of a `--force` start) and, before the first execution turn, runs `start`. For a beads graph it also runs `bind_workspace` in reuse-only mode: a checkout whose branch or path already names the ticket is bound, with its bead database; a worktree is never created here. The hook returns one message with the result and the next step's guide, and records the wake signature so the model is not woken twice. Any failure is reported in that message and the model falls back to the manual operation. The hook never changes the system prompt.

## Compaction

`session.compacting` pins mission essentials into the summary (ticket file path, phase, epic, checkout, open workers, unfinished beads), because the summarizer is lossy. The ticket file is rewritten at that point if /tmp was cleaned. `session_compact` forgets which guides were sent, so the next result re-teaches the current step.

## Two entry paths

- Model: `mission_control` tool, native approval, brief result.
- Operator: `/mission <verb>` calls `control()` directly. Typing the command is the approval.

Both go through the same enforcement. Add an operation once, in `control()`.

`src/sources.ts` shares Linear identifier parsing across source inference, checkout guards, and checkout reuse. Each slash-separated component establishes its project from the first non-reserved identifier. Subsequent lowercase identifiers for different projects are title text; uppercase identifiers and same-project identifiers remain candidates, preserving ambiguity and conflict checks.

Workspace base precedence is explicit `bind_workspace base`, repository `mission.baseBranch`, written branch instructions, hosted default, then `origin/HEAD`. The instruction parser accepts both “branch from” and “start from”; it never treats the current feature branch as the base. Compact control/status results include the bound base. Delivery guidance uses that base explicitly, and delivery/review reject an actual PR-base mismatch rather than overwriting mission intent. Both revision and tree fingerprints include the base so evidence from a different target cannot complete the mission.

Saved-ticket attachment is scoped by `workspace.key`, `workspace.cwd`, and source ID. Each newly planned run gets a unique mission ID, so restarting a ticket cannot overwrite its prior state.

`clear` goes through `control()` and only detaches a completed mission or discards an unstarted plan; it refuses unfinished saved missions and concurrent operations. It is allowed in native plan mode because it changes session attachment, not saved mission state or task output. A `mission:pointer` entry with `path: null` and accumulated `ignoredPaths` prevents restoration and lookup of cleared missions in that session. Pending-plan recovery stops at that tombstone; later plan messages can still recover normally. `start` and `continue` preserve exclusions in their pointer entries. Clear tears down local attachment and releases ownership without deleting saved history, beads, or external panes. Completed missions recommend `show` for safe inspection, even in plan mode; `clear` stays available but is not the default selection.

`operatorCommands()` in `src/controller.ts` supplies the same context-valid commands to the action menu and autocomplete. Autocomplete always suggests `show`, `config`, and `history`; it conditionally suggests `continue`, `approve`, `review`, `mode`, and `clear`. Worker controls and the redundant `actions` alias remain callable but never appear as first-token suggestions. Specialist arguments still complete when explicitly typed.

Completion sources contain only unfinished saved missions; completed runs have a separate history list keyed by run ID. Completing a run refreshes that cache. `/mission history` lists completed runs, including cleared runs, and optionally filters by ticket or run ID. Its inspector uses a separate projection with no action callback: it never calls `attach()`, changes the session pointer, or acquires ownership. The active mission, selected bead, and audit history stay untouched. `history <bead-id>` retains the current graph's audit view.

`displayBeads()` derives saved reviewer rows from round transcripts and `reviewProgress`. Incomplete rounds retain completed, failed and pending target states after restart; progress counts are not a verdict. Reviewer IDs include the round index and label with a `subagent:` prefix. Live progress replaces the matching saved row, and reviewer selection never reads a bead audit log. Completed transcript paths remain in the evidence view.


## Coordinator context budget

Every tool result and message stays in context for the rest of the session, and anything that changes the prompt prefix forces the whole conversation to be re-cached. Rules:

- **Results carry decisions only.** `briefView` (control results) and `statusView` (`mission_status`) in `src/status.ts` drop source text, worker assignments, bead descriptions, timestamps, and the lock nonce. Add a field only if the model acts on it.
- **The wake message is the status call.** It names the next step, its ids, and the guide for it, so the coordinator rarely needs `mission_status`. A guide is sent once per step: with the wake or with the first result that reaches that step.
- **The system prompt stays stable.** Startup hooks add hidden messages, not volatile system instructions.
- **Startup points to a ticket file**, containing the complete specification, comments and extras. Coordinator instructions are a hidden `mission:instructions` message, so visible startup contains only a title and file pointer. Pending recovery state lives in a non-message `mission:pending` session entry; restoring recreates the ticket file before planning resumes. Old pending JSON transcripts are migrated once into that metadata without rewriting history.
- **Phase labels follow evidence.** With no outstanding workers or graph leaves, the widget, phase rail and action menu show Deliver after passed verification and Review after delivery, even if the stored execution phase has not advanced. This changes presentation only, not approval or ownership policy. Provider-quota failures tell the operator to restore quota or fund the review model before retrying.
- **Waiting is not failure.** The header counts dependency-waiting leaves separately from explicitly blocked leaves; only the latter get the red error indicator. The graph's aggregate blocked count still includes both for scheduling/status compatibility.
- **The coordinator never polls**; the extension wakes it on state change.
- **autoDispatch** runs `dispatch` in `wakeCoordinator` when `autoDispatchAllowed` says so, so a plain wave costs no model turn. A failure hands the same wake to the model once.
- **Model-chosen work** (graph and scopes, verify, deliver, repair work, rejecting findings) stays with the coordinator. Mechanical steps run in the extension once the operator's request is satisfied: `autoReview` in `wakeCoordinator` starts a requested, ready (and in Pause approved) review, and `decision()` runs `dispatch` or `accept_repairs` when `/mission approve` approves that exact gate. A review is its own session, so the coordinator would only relay a tool call.
- **Never hand the model a step the extension is taking.** `extensionRuns` (in `status()`) mirrors the `autoDispatch` and `autoReview` conditions; when either will run, the control result says to wait rather than `Next: dispatch|review`. Otherwise the model's call raced the extension's.
- **Worker and reviewer sessions are unlisted** (`src/session-file.ts`). `SessionManager.create` and `open` write the terminal breadcrumb that `omp -c` resumes, so every launched worker used to replace the coordinator as that terminal's last session.
- **Completion is bookkeeping.** When the latest review is clean for the verified revision, `finishMission` in `wakeCoordinator` marks the mission complete. Waking the model for it cost a full-context turn that only answered "complete", and a mission re-verified after its review (a PR retarget) otherwise stayed in `review`.
- **Verification survives a commit.** `captureRevision` returns `revision` (HEAD, file bytes, and target base) and `tree` (bytes and base, no HEAD). A passed `record_verification` stores both. `record_delivery` and `run_review` carry that evidence onto a new HEAD when the tree is unchanged, including evidence recorded before the base prefix. A content or base change still fails with "Files changed since verification". Committing the verified files no longer forces a second verification run, and review is not stricter than delivery about that commit.
- **Workers get the approved plan as a file.** The plan lives under the coordinator's `local://` root, which workers cannot resolve. `dispatch` copies it to `omp-mission-workers/<mission-id>.plan.md` (`sharePlan`), and worker assignments point at it with a "read only your section" note. Without a plan file the note is omitted.
- Operator output sent with `sendMessage` enters context. Keep it short (`/mission history <bead-id>` shows 12 events; without a TUI, completed-history listings show at most 12 runs).
