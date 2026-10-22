# Mission lifecycle

How a mission moves from a ticket to a completed, reviewed change, and what stops it on the way. Commands and settings are in [reference.md](reference.md); review and repair rules are in [review.md](review.md).

Phases run in order: **Plan**, **Isolate**, **Graph**, **Execute**, **Verify**, **Deliver**, **Review**, **Repair**, **Complete**. On the `local` graph the coordinator works in its own pane, so Isolate and Graph are skipped. On the `beads` graph the coordinator binds a checkout, builds a bead epic with scoped leaves, and workers implement the leaves.

## Plan

`/mission <ticket>` enters OMP's native plan mode, fetches the ticket and asks the coordinator for a plan. Startup shows the ticket title and a readable specification-file path, not a ticket or JSON dump; the full ticket stays available to the coordinator. Pending plans recover from session metadata. Plan mode forbids every mission mutation.

Approve the plan with **Approve and compact context** or **Approve and keep context**. **Approve and clear context** starts a new session, which loses the pending mission, so nothing starts; run `/mission` again there. Approving the plan starts the mission automatically. Workers get the approved plan as a file (`omp-mission-workers/<mission-id>.plan.md`) and are told to read only their slice.

On OMP 18.10.4 or newer, an idle pending plan opens OMP's native plan review once per written revision, without interrupting streaming or queued work, and a dismissed unchanged plan is not reopened. Approval from outside the pane (Holotable) answers that review with the compact choice; see [holotable.md](holotable.md#plan-review). Older runtimes keep in-pane approval and feedback prompts.

`--force` skips plan mode and starts executing immediately in Force mode.

## Isolate: checkout, bead database and base

On the beads graph, when the plan is approved, a checkout that already belongs to the ticket (its branch or path names it, as with an Orca worktree made for the issue) is bound too, with its bead database, and delivery defaults to `pr` for Linear and GitHub tickets. The coordinator is told the result and its next step in the same turn. A worktree is never created at this point.

`mission_control bind_workspace` with no arguments does the isolate step in code:

1. It reuses a checkout whose branch or path already names the ticket, or creates branch `mission/<slug>` in a sibling `<repo>-mission-<slug>` worktree from the primary checkout.
2. It finds the canonical bead database.
3. It picks delivery: `local` for freeform tasks or a non-Git directory, otherwise `pr`.

It stops with the reason when the base branch is unresolved, the branch or path is taken, or the checkout is a linked worktree for something else. A retry reuses the worktree it already made. It never runs `bd init`: a missing database is reported with the command to run. Passing `cwd`, `beadsDir`, `delivery` or `base` overrides any default.

### Base branch

The base is chosen in this order:

1. Explicit `bind_workspace base` (or `OMP_MISSION_BASE` for a board launch).
2. Repository `git config mission.baseBranch`.
3. Written branch instructions in `AGENTS.md`, `CLAUDE.md`, `CONTRIBUTING.md` or `README.md`, such as "base branch is `x`", "`x` is the integration branch", or "feature branches start from `x`".
4. GitHub's default branch, then `origin/HEAD`.

Pin an integration line with `git config mission.baseBranch v2/backend-rewrite`. Control and status results report the bound base; delivery must use it explicitly rather than assuming `main`.

## Graph

`local` (the default) keeps all work in the coordinator pane. `beads` builds a bead epic whose implementation leaves each carry a file scope, and runs every leaf in a worker. A running mission keeps the graph it started with, even if `/mission config graph` changes later.

Binding repair work, a different epic, unfinished leaves or changed scopes clears verification, delivery, review, completion evidence and partial review progress. Verification requires a nonempty graph whose implementation leaves are completed (`closed` or `done`).

## Execute

Ready leaves start in waves; live workers never exceed `maxWorkers`. Automatic waves serialize overlapping file scopes, including scopes held by live workers. With `autoDispatch` on, a ready wave in Auto or Force mode starts without a model turn. A failed automatic dispatch is handed to the coordinator once instead of retrying inside the preceding tool call. Control results and board actions are republished when the operation releases its busy flag.

In Pause mode each wave waits at a gate, and the next wave waits for the current one to finish. `/mission approve` also runs the step it approves: at a wave gate it dispatches the wave, and at a repairs gate it accepts the repairs. Judgement stays with the coordinator: graph scopes, verification, delivery, repair work and rejecting findings. A gate binds to the exact scope it was raised for, so a changed scope needs a new approval.

A control result or `mission_status` that arrives while the extension is about to run a step itself (an automatic dispatch or a review) says so and tells the coordinator to wait, instead of suggesting a call that would fail with "Workers running" or "Mission operation already running".

Worker frontends, stalls and recovery are covered in [workers.md](workers.md).

## Coordinator boundaries

In beads missions, implementation fixes belong to scoped worker leaves, not coordinator edits.

- Direct `edit`/`write` into the bound checkout is blocked, including new unbound files. `.artifacts/` remains available for evidence unless a worker scope owns it.
- Blanket staging (`git add -A`, `git add .`, `git commit -a`), recognized checkout-rewriting Git commands and branch-history rewrites (`commit-tree`, `update-ref`, `read-tree`, `reset --soft`, `replace`, `filter-branch`, force pushes) are blocked before they run.
- When all workers are closed and no implementation leaf is active, shell commands are checked against fingerprints of non-ignored Git files plus explicitly scoped literal paths. A detected change fails verification and clears delivery, review, completion evidence and partial review progress. Nothing is rolled back.

These checks are not a filesystem or shell sandbox: concurrent workers, ignored build output and commands that outlive their tool result limit attribution.

### Integrating a moved base

A base that moved on is integrated only through `mission_control merge_base`. With every worker closed, the extension merges the bound base (preferring a fetched `origin/<base>`) with a merge commit and clears verification and delivery. A conflicted merge stays in progress with markers in place: verification reopens naming the paths, a leaf scoped to them resolves the markers, and the coordinator concludes the merge with `git commit --no-edit`.

## Verify

The coordinator runs the project's checks and records the outcome with `record_verification`. A failure stops the mission in one of two ways:

- **Pause mode and the local graph park.** After you resolve the blocker, run `/mission continue`; it resets verification to pending, not passed. A model `continue` or a fresh success record cannot release this hold.
- **Beads Auto and Force keep moving.** The failure becomes the coordinator's repair step: bind or create a scoped repair leaf, dispatch it, then verify again, without an operator Continue.

Repair evidence becomes passed or failed with verification, rather than staying active through delivery. While actionable findings remain, passing verification requires changed output; explicitly rejecting every accepted finding skips repair evidence and allows unchanged output to be reverified. Delivery and independent rereview remain required for changed output.

## Deliver

The coordinator delivers against the bound base and records it with `record_delivery`. Its detail is the reader-facing summary the board shows: what changed, why and what was verified, in a few short lines. PR delivery requires the actual PR URL, and a PR whose base differs from the bound base is refused; retargeting needs fresh evidence and a full review. Tickets are referenced (`Refs`), never closed by the PR, and Linear issues are never moved to Done.

`record_delivery` accepts a commit of the verified files (same contents, new HEAD); any other edit after `record_verification` means verifying again.

**Delivery carries only mission work.** `record_delivery` and completion compare the branch with its merge-base: any committed file that no bead scope or worker owns reopens verification with the paths and the fix (a leaf scoped to them restoring the base content). A stale tree replanted onto a newer base reverts every base change since, and is caught here instead of reaching review or the PR. Local-graph missions have no scopes and skip this check.

After delivery, what happens depends on the mode:

| Mode | After delivery |
| --- | --- |
| Auto | Stops: "Result is ready. Request an independent review, or stop here." Run `/mission review` to continue. |
| Force | Review starts on its own. |
| Pause | Stops like Auto unless review was already requested (`--force --pause`). A requested review then waits at a review gate: `/mission approve`. |

## Review and repair

A requested review starts in the extension without a coordinator turn. Every round with remaining findings goes to the coordinator for evidence-based triage, and confirmed defects become one scoped repair wave, which runs verification, delivery and review again. Automatic repair has a budget of two waves. See [review.md](review.md).

## Complete

When the latest independent review of the verified revision leaves no repair findings (clean, or only rejected and deferred ones), the extension marks the mission complete without a model turn. Two checks run first:

1. The delivery check above (no foreign files).
2. A merge-clean check: `git merge-tree --write-tree` against the bound base must merge without conflicts. Otherwise verification reopens as failed, naming the contested paths, and the coordinator runs `merge_base`.

When a PR-delivered mission completes, its deferred findings are posted once as an **Advisory review notes** PR comment.

A completed mission stays Complete after its pane restarts. The resumed session's inspection-only state is not reported as unfinished work, and it does not authorize Continue or clear gates, blockers or quota holds.

## Check a delivered PR

`/mission check` on a completed mission with a pull request sends the pane to inspect it:

- It merges the base into the PR head with a merge commit (never a rebase or force push) and resolves conflicts.
- It answers every open review thread and resolves the ones it fixed.
- It fixes failing CI checks from their failed logs, including PR-description or policy checks, and runs the matching local gate before pushing. A failure the base shares (a new dependency advisory, a lint rule) still blocks the PR and is fixed when the fix is small and safe. Only what cannot be fixed safely (infrastructure, an external outage) is reported, with evidence. A check is never disabled, skipped or weakened.
- A merged or closed PR is reported immediately with no other action.

The pane records the outcome as `mission.check` through `record_check`: `clean`, `merged`, `closed`, `conflict`, `threads`, `checks`, `fixing` or `unknown`, with open and total thread counts and any paths still conflicting. The result republishes to the status file, so Holotable's **Check PR** button shows it under the card's Delivery section. The socket op is `check` (an operator click, or Holotable auto mode before landing); the board socket cannot call `record_check`.

## Holds and recovery

### Resume hold and ownership

A mission belongs to one controlling session at a time, held by a lock. A resumed or restarted session attaches the saved mission read-only (the **resume hold**) until you run `/mission continue`. Losing ownership forces a resume hold. After a crash, the old session's lock expires in 30 seconds.

Worker and reviewer sessions are saved but never recorded as the terminal's last session, so `omp -c` in the coordinator's terminal always resumes the coordinator and not a bead worker.

### Provider quota and model failures

Provider quota or credit exhaustion parks the coordinator, worker or reviewer without completing the mission or discarding its pending plan. The park keeps the provider's error text below the blocker line. OMP owns transient retries and model fallback; the mission does not start a second retry loop. Planning rate-limit and provider failures publish their blocker instead of inviting plan approval.

Restore quota or change the model, then:

| Parked | Run |
| --- | --- |
| Coordinator | `/mission continue` |
| Worker | `/mission resend <bead-id>` |
| Reviewer | `/mission review` |

A board-launched pane also accepts the operator-only socket op `retry-model` (`args {model}`, a `provider/id` from the session's available models). It changes the current coordinator model, saves worker and review overrides, clears the provider park, and retries only failed coordinator, review or subagent-worker work. Finished review targets are reused with their recorded model. It is advertised only while the mission is owned, out of plan mode and free of resume holds, unapproved gates and failed verification. Holotable Recovery leaves quota-held contacts alone.

Reviewer and subagent-worker sessions run on isolated settings but inherit the configured `retry.fallbackChains` and `modelRoles`, so OMP fails them over to the next model in their chain (for example a `mission-review` chain) before a capacity failure reaches the mission. Configure a chain for the review and worker roles; without one, the `default` chain applies.

Coordinator model selection belongs to OMP. `/mission continue` never selects a model: a later manual choice remains in effect, including when Holotable sends an automatic Continue. Obsolete saved coordinator overrides are ignored on load.
