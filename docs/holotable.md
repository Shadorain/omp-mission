# Status file and control socket

Every mission publishes a status file, and a board-launched mission also serves a control socket. [Holotable](https://github.com/Shadorain/holotable) uses both to show and drive many missions; anything else can read the same file. The shared field-by-field contract is Holotable's [docs/contract.md](https://github.com/Shadorain/holotable/blob/main/docs/contract.md). This page covers what omp-mission publishes and accepts. Implementation notes are in [architecture.md](architecture.md#operator-socket-and-status-file).

## Status file

Every session with an active or pending mission writes `<agentDir>/missions/<workspace-key>/status/<run-id>.json` (schema 1). Writes are atomic (tmp+rename) and happen only when the content changes. The board joins missions by worktree and shows phase, holds, workers, delivery and the next step verbatim.

| Field | Meaning |
| --- | --- |
| `ticket`, `title`, `worktree`, `base` | What the mission is and where it runs |
| `phase`, `progress` | Display phase and position on the phase rail |
| `hold` | `none`, `plan-approval`, `resume`, `gate`, `blocked`, `quota` or `question` |
| `gate` | The armed Pause gate's kind and id |
| `next`, `actions` | The next step text, and the socket ops legal now |
| `workers`, `delivery`, `complete` | Live and total workers, PR URL and branch, completion |
| `verify` | The latest verification outcome; a resume hold can cover a failed verification |
| `mode` | The current mode, or the planned mode for a pending plan |
| `plan` | `{path, revision}` while a plan awaits approval |
| `problem` | Current failure details, or `null` when healthy |
| `review` | Running review progress |
| `check` | The latest PR check (see [lifecycle.md](lifecycle.md#check-a-delivered-pr)) |
| `report` | The final report (below) |
| `coordinator` | Whether the pane's main agent is working or idle |
| `ask`, `approval` | An open question or tool-approval prompt the board can answer |
| `usage`, `measurements`, `usageEvidence` | Spend and rework metrics (below) |
| `ctl` | The control socket path, or `null` |

A beads mission whose graph cannot be read (for example a down Dolt server) reports `hold: blocked`, so the board does not show it as running. A beads mission with a readable, fully closed implementation graph reports Verify rather than Running while awaiting verification.

A completed mission stays Complete after its pane restarts; the resumed session's inspection-only flag is not published as unfinished work. This does not authorize Continue or clear gates, blockers or quota holds.

### Problem

`problem` covers failed reviews, active-worker errors, coordinator blockers, verification failures and graph outages: kind, source, full detail, automatic retry timestamp, failed attempt and retained review counts. `null` means healthy; a missing field means an older producer. Closed-worker historical errors are not current failures. A spent repair budget is reported as `problem.source: repair-budget`; a genuine escalation as `problem.source: triage`.

### Report

Once a mission has verification or delivery evidence, status carries `report`, the mission's final report for the board card:

| Field | Content |
| --- | --- |
| `summary` | The `record_delivery` detail without the PR URL line. The deliver step asks the coordinator for a few reader-facing lines on what changed, why and what was verified. |
| `work` | Graph leaves as done, open or dropped; empty on the local graph |
| `verification` | Outcome, detail and revision |
| `review` | Valid rounds, findings, and their repair, reject, defer and escalate counts |
| `followUps` | Deferred and escalated findings, once per path and title |
| `delivery` | Outcome and PR URL |
| `revision`, `at` | The newest evidence the report reflects |

It is rebuilt on every publish and kept under 8 KiB: list tails are dropped and long text clipped, with `truncated: true`. It is `null` before any evidence.

### Coordinator activity

`coordinator: {state, since}` is `working` while the pane's main agent is in a turn or OMP has already scheduled the next one (an automatic retry, a compaction continuation, awaited background work on OMP 18.12+, or a queued message), and `idle` once its turn ends with nothing scheduled. The board uses minutes of idleness with nothing else running to flag a mission that stopped to ask something in plain text. It is `null` until the pane's first turn.

### Usage and measurements

`usage` keeps its aggregate shape: input, output, cache-read and cache-write tokens, known estimated cost and sessions, or `null` before any recorded usage.

Usage includes the whole associated coordinator session, only this mission's subagent worker incarnation files, and independent reviewer sessions under `reviews/<mission-id>/` (including failed and aborted reviews). Other missions' workers are excluded; terminal-worker usage is unsupported, not free. Up to three role-scoped, hashed sources expose priced and unpriced message counts and missing, malformed, reset and backlog coverage. Known associated spend is neither exact billing nor exclusive mission cost.

Status publication samples usage lazily: at most every 30 s, immediately on a run switch, once on completion and on detach. It creates no timer or model call. Transcript reads use offsets, a reusable 64 KiB chunk and 1 MiB line buffer, and a shared 4 MiB read budget per invocation. Complete lines are counted once; oversized lines are discarded with a coverage warning. File replacement and shrink resets are flagged, deleted parsed usage survives while the probe lives, and a cold restart rebuilds gradually without a persistent usage ledger. Same-inode rewrites that grow between observations cannot be detected reliably.

Reviewer usage coverage checks transcript references from every saved round (including invalidated rounds) and incomplete-round checkpoints, alongside discovered reviewer files. A missing historical transcript keeps usage partial even if other reviews still have files; restoring it clears the current missing-file gauge. This uses the existing bounded usage sample, not an additional scan loop or model call.

Optional schema-1 `measurements` and `usageEvidence` are bounded numerical summaries for Holotable, not model context. Persisted counters distinguish explicit verification outcomes, repeated failures on the same captured revision, merge preflight failures, coordinator boundary failures, failed reviews and accepted repair transitions. New missions measure from creation; legacy missions begin at their first measured mutation without inventing earlier counts. Review rounds and findings, invalidations, repair links and worker reservations are derived from mission state. These are quality and rework proxies, not externally verified correctness.

## Questions and tool approvals

A main-agent `ask` wait publishes `hold: question` and the question text. At session start the extension wraps the pane's ask dialog (`src/ask-bridge.ts`), because OMP's `ask` tool reads it from the same UI object at call time and offers no other way to answer from outside. While that dialog is on screen and every question parses, status also carries `ask` (the tool call id and each question's option labels, recommendation and multi-select flag) and the single action `answer`. The socket's `answer` op (`{id, answers: [{option} | {options} | {text}]}`) settles the dialog exactly as if it were answered in the pane, and closes the pane's copy; a different `id` is `stale`. Every other socket op is refused with `question-waiting` until the question is answered. Without `ask`, Holotable shows **Answer in mission** to focus the OMP prompt.

An open tool-approval prompt (OMP's Approve/Deny prompt before a tool runs, when `tools.approvalMode` or a `tools.approval.<tool>` policy asks) is held the same way. On OMP 18.11.3 and later the extension also wraps `ui.approve` (`src/approval-bridge.ts`). While a prompt is on screen, status publishes `hold: question`, the prompt's summary as the question text, `approval` and the action `permit`. `approval` holds a per-prompt `id`, the `tool` when the prompt names one, the one-row `summary`, the whole `prompt` cut at 4000 characters, and its `options` in the pane's order: remembered grants, Approve, the for-this-session choice when offered, Deny last. The socket's `permit` op (`{id, answer: <option label>}`) answers exactly as that choice in the pane would and closes the pane's prompt. A different `id` is `stale`; a label the prompt does not offer is `rejected`, never a denial. Every other op is refused with `question-waiting` meanwhile, because a message steered into the pane while a prompt is open denies the call. Older OMP returns a boolean from `approve`, so its prompts stay pane-only and publish no `approval`.

## Plan review

While a pending plan awaits approval, the status file carries `plan: {path, revision}`. The open native review's file path is authoritative; otherwise the mission's `local://<slug>-plan.md` is used. Socket ops read (`plan`), atomically edit (`plan-edit`, up to 256 KiB, with stale-base checks), refine (`plan-refine`, 1 to 8000 characters) and approve (`plan-approve`, with stale-revision checks) that plan.

On OMP 18.10.4 or newer, idle pending plans open native review through `ctx.openPlanReview()` once per written revision, without interrupting streaming or queued work or reopening a dismissed unchanged plan. Typed review events refresh the context and status; `getPendingPlanReview()` also recovers an already-open review. Approval is advertised only while the native compact choice is available. It resolves with `compact`, preserving the pending mission for the usual approved-plan start; it never uses `execute`, which clears the session. Refinement resolves the native `refine` choice; a review that closes before resolution rejects instead of queuing duplicate feedback. Older runtimes keep in-pane approval and feedback prompts. Existing panes need relaunching to load updated extension code.

## Control socket

A pane launched by the board (`OMP_HOLOTABLE_CHILD=1`) listens on a unix socket at `<tmpdir>/omp-mission-ctl-<uid>/<sha256(missionId)[:12]>-<pid>.sock` (mode `0600`), advertised in the status file's `ctl` field. The protocol is newline-delimited JSON, one request and one reply per connection, up to 1 MiB per line. A request looks like `{"v":1,"op":"approve","args":{...},"operator":true}`.

| Op | Needs `"operator": true` | Notes |
| --- | --- | --- |
| `ping`, `plan` | no | |
| `answer` | yes | Only while a question is open |
| `permit` | yes | Only while a tool approval is open |
| `approve` | yes | May carry `args.gate`; `stale` when it is not the current gate |
| `continue`, `mode`, `review`, `dispatch`, `resend`, `release`, `reap`, `clear` | yes | Same as the slash commands |
| `check` | yes | PR check on a completed mission |
| `retry-model` | yes | `args {model}`; see [lifecycle.md](lifecycle.md#provider-quota-and-model-failures) |
| `plan-edit`, `plan-refine`, `plan-approve` | yes | See [Plan review](#plan-review) |

Each operator op runs through the same `control()`/`decision()` path as the slash commands: resume hold, plan mode, Pause gates and ownership are enforced identically. Reply errors are `bad-request`, `stale`, `busy`, `rejected`, `no-plan`, `no-session` and `question-waiting`.

The socket is the owner pane's control authority. A second pane that attaches the same saved mission stays read-only: it holds no ownership lock, opens no socket and never overwrites a fresh owner-published status file. The pid suffix means a relaunched pane does not unlink the previous owner's stale file. A `<mission-id>.ctl` marker inside the status directory makes a pane eligible to serve without the launch environment; the extension leaves it behind after the first serve, and the board backfills it for tracked missions that predate the marker. An owning pane retries the socket on each poll pass while eligible but not serving, so a revived owner that missed its marker starts serving on its own. `continue` acquires the lock, reopens the socket and republishes status, and the poll loop's ~15 s ownership retry notices a released lock first.

## Extra repair cycle

Holotable can opt into **Extra repair cycle** (`auto.repairs`): one additional repair authorization per contact, durably bounded by its history. Updated panes mark a confirmed budget hold as `problem.source: repair-budget`. A scoped socket `review` with `args.repairBudgetOnly: true` rejects Pause and every other hold, including genuine escalations. Ordinary ownership, resume, gate and revision guards still apply. Existing panes need a restart or relaunch to load this capability; board Auto and Recovery remain separate opt-ins. See [review.md](review.md#repair-budget).

## Launch overrides

Board launches set per-launch environment overrides instead of changing `mission.json`:

| Variable | Effect |
| --- | --- |
| `OMP_MISSION_AUTOSTART` | The `/mission` arguments run at `session_start`, used with `plan.defaultOnStartup` |
| `OMP_MISSION_BASE` | Explicit base for workspace inspection |
| `OMP_MISSION_CHECKOUT` + `OMP_MISSION_DELIVERY` | Reuse-only `bind_workspace` of the lane at the first turn, skipping ticket-name matching |
| `OMP_MISSION_GRAPH` | `local` or `beads` for the planned mission |

See [holotable-launch.md](holotable-launch.md) for the launch recipe.
