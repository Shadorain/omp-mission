# Review and repair

After delivery, an independent reviewer session checks the verified revision. The coordinator triages what it finds, confirmed defects are repaired in a scoped wave, and the loop repeats until no open findings remain or the repair budget runs out. The coordinator never reviews its own work.

## When review runs

Review runs only when it was requested: Force mode requests it from the start; in Auto and Pause, `/mission review` requests it after delivery. In Pause the review then waits at a review gate (`/mission approve`). A requested review that is ready and approved starts in the extension without a coordinator model turn.

The reviewer runs on the `modelRole` model with the `reviewContext` context files (see [reference.md](reference.md#configuration)). Results must match the verified revision and persisted field limits; invalid results are rejected before they enter mission history.

## What the reviewer sees

The first review measures the full change from the merge-base of `HEAD` and the bound base (preferring `origin/<base>`).

Follow-up reviews check the repair delta against the last reviewed file snapshot, plus unresolved findings. Reassigning files to a repair bead does not reopen settled scopes or launch a whole-branch integration audit. Each snapshot records its merge-base, so after `merge_base` a follow-up covers only files the mission changed in either round, not files only the base changed. Git snapshots include uncommitted and untracked files without changing the real index or checkout. Old rounds without snapshots get one finding- and task-focused follow-up, which establishes the baseline. A missing saved snapshot fails explicitly rather than silently falling back to a full rescan.

Delivery and review refuse a PR-base mismatch; retargeting needs fresh evidence and a full review.

The diff sent to the reviewer is capped at about 300 KB. Whole per-file sections are kept smallest first; files over the cap are listed in `omittedDiffs` and the reviewer reads them directly.

### Deadlines

| Review | Deadline |
| --- | --- |
| Initial | 5 minutes plus 15 seconds per changed file, doubled after each timed-out attempt (up to 8×), capped at 30 minutes |
| Follow-up | A fixed 10 minutes, with no timeout-driven expansion |

Small repair deltas can still require tracing substantial surrounding behavior, so file count does not shorten the follow-up allowance.

### Per-bead review

With the `subagent` frontend on a beads graph with more than one scoped bead, review runs per bead in parallel (up to `reviewConcurrency` sessions), plus an integration pass for cross-bead defects on the first round. Other setups use a single reviewer session.

- Overlapping scopes have one review owner: repair beads outrank originals, with the newest repair-link entry owning contested files.
- Findings carry their `beadId`. A citation outside that bead's owned files is moved to the owner, or dropped if no bead owns the path; it does not fail the target.
- Integration drops exact duplicate findings, not distinct defects at the same line.
- Later rounds re-review only beads whose owned files changed, plus owners of unresolved findings.

## Failures and retries

A reviewer turn that errors or returns no text fails with its real cause (`Reviewer error: …`, `Reviewer returned no text`) instead of a JSON parse error. A malformed reply is sent back once in the same session with the reason; a reply that stays invalid fails the round with `[bead-id] <reason>`.

Every failure except unfunded quota retries on its own: initial reviews up to three times with 2-, 10- and 30-minute backoff, follow-ups twice. A longer provider retry-after is honored, with mission-keyed jitter of at most one minute. On a provider-capacity failure, no further uncached targets start; in-flight results and completed checkpoints survive. Aggregation prioritizes capacity errors and the longest retry-after. Scheduled retries advertise their time.

Quota exhaustion and an exhausted retry budget need an explicit `/mission review` after correcting the failure. Pause, resume and ownership guards still apply.

`resource_exhausted` with an explicit rate limit is a temporary throttle, not proof of exhausted credits. Retries honor provider reset durations and UTC reset times, including resets across midnight. Explicit insufficient-credit errors still need operator action.

### Checkpoints

Each completed per-bead or integration result is checkpointed immediately. A timeout or another target's failure leaves the round incomplete, not clean. A retry reuses finished results only when the round, revision, model, prompt, inputs and context still match. Valid finished results stay in the first retry checkpoint, even while earlier unfinished targets occupy every reviewer slot, so progress does not reset and an interrupted retry cannot discard them. Progress survives restart and appears in the inspector. Older failed rounds without saved progress cannot recover their discarded results automatically.

### Reviewer sessions

Reviewers appear in the Agent Hub while running and as `review <bead-id>` rows in the mission outline. Saved round transcripts and incomplete-round progress reconstruct completed and failed rows after restart; live rows replace their saved counterpart. Completed transcript paths stay in the inspector's evidence view under `~/.omp/agent/missions/<workspace>/reviews/<mission-id>/`; open one with `omp --resume <path>`. Older reviews without saved transcript or progress records cannot reconstruct individual rows.

## Severity

Reviewers use the full mission requirements and recorded repair and rejection decisions, and exclude cosmetic-only findings. Repair history does not silently settle distinct defects at the same location. Severity follows consumer impact:

| Severity | Meaning | Handling |
| --- | --- | --- |
| critical | Data loss, security, money, or a main workflow broken | Never deferred |
| high | An acceptance criterion or main consumer path fails | Never deferred |
| medium | Edge-path defect or degraded behavior with a workaround | Triage may defer it; deferred automatically once the repair budget is spent |
| low | Comments, docs, naming, fixtures or mocks, accessibility polish | Deferred automatically; follow-up reviews do not report them |

Deferred findings are recorded, never repaired, and never block completion.

## Triage

Every completed review with remaining findings wakes the coordinator for evidence-based triage before any repair work. It checks each claim against the requirements, current code and earlier repairs, then records `mission_control triage_findings` with one decision for every pending finding:

| Decision | When |
| --- | --- |
| repair | A confirmed defect |
| reject | With evidence: duplicate, cosmetic, speculative or already fixed |
| defer | Medium only, when no acceptance criterion or main consumer path breaks |
| escalate | A genuine unresolved conflict in the requirements |

Critical and high findings cannot be deferred. Confirmed defects become one scoped repair wave. Rejected claims need a recorded explanation, not another blind fix-and-review cycle. Later review covers changed scopes and scopes with unresolved findings; deferred findings are passed to reviewers as settled notes, not reopened. A round with no remaining repair findings completes the mission.

When a PR-delivered mission completes, its deferred findings (each path and title once, from valid rounds) are posted once as an **Advisory review notes** PR comment. A failed post never blocks completion.

## Repair

Accepting repairs needs confirmed findings. On the local graph the coordinator repairs in its pane; on the beads graph it creates scoped repair beads linked to the findings. In Pause, accepting repairs waits at a repairs gate.

Accepting local repairs advances the round and clears earlier verification and delivery. Binding beads repair work advances the round and clears verification, delivery, review, completion evidence and partial progress. Either way the repair goes through verification, delivery and independent review again.

### Repair budget

Automatic repair has a persisted **two-cycle budget**. One cycle is a whole repair wave, not each worker or reviewer.

- The last allowed wave still runs verification, delivery and independent review.
- Once the budget is spent, new medium findings are deferred as well, so only critical and high defects can hold the mission.
- Pending claims can still be rejected with evidence, and a clean result completes normally.
- If confirmed critical or high findings remain afterward (even different new findings), the mission stops **blocked**, names the unresolved IDs and creates no more repair work.
- `/mission review` grants exactly one more cycle after you inspect it. Continue, Force, model recovery and restarts never refill the budget.
- An already-active legacy repair wave counts as the first cycle when resumed under this policy.

Holotable can opt into **Extra repair cycle** (`auto.repairs`); see [holotable.md](holotable.md#extra-repair-cycle).

### Escalation

A confirmed defect that survives two linked repair attempts on distinct reviewed revisions may escalate earlier. Invalidated, unchanged and untriaged legacy verdicts do not count as confirmed failed attempts. An escalation stops the mission until you inspect it; `/mission review` authorizes another repair attempt. Native approval, Pause gates and ownership remain required.
