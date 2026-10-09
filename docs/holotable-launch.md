# Holotable launch message

Decided 2026-10-09 by the V5 smoke (isolated `PI_CODING_AGENT_DIR`, real Orca pane, real OMP).

## The launch command

```bash
env OMP_HOLOTABLE_CHILD=1 \
    OMP_MISSION_AUTOSTART='/mission <ticket-or-args>' \
    omp -e <omp-mission>/index.ts --config <overlay.yml>
```

where `overlay.yml` contains:

```yaml
plan:
  defaultOnStartup: true
```

- `OMP_MISSION_AUTOSTART` carries the `/mission` arguments verbatim (a leading `/mission` is stripped). `session_start` runs it through the normal command path once the session is in plan mode, so the pending plan is created exactly as if the operator had typed it.
- The `--config` overlay puts the new session into native plan mode at startup, which is what allows the autostarted `/mission` to create a pending plan rather than be refused.
- `OMP_HOLOTABLE_CHILD=1` marks the pane as board-launched: only then does the operator control socket exist. The status file is written either way.

Autostart creates the plan. It never approves it: approval still happens in the pane.

## Why this variant

Three launch shapes were tried in the smoke:

1. `omp "/mission -- demo"` as the first positional message — the `input` hook that rewrites `/mission …` to `/plan /mission …` does not fire for argv messages, and without plan mode the command is refused. No pending plan.
2. `omp "/plan /mission -- demo"` — the built-in `/plan` is not honored from a positional argv message; the session just chats. No pending plan.
3. `OMP_MISSION_AUTOSTART` + `plan.defaultOnStartup: true` overlay — the session opens in plan mode, `session_start` runs the mission command, and the session JSONL gains a `custom` entry with `customType: "mission:pending"`. **This is the variant that works.**

Evidence: `/tmp/holotable-v5-JniC1h` smoke, session `2026-10-09T00-56-58` — screen showed `Plan mode enabled` plus the pending-mission widget (`Approve the plan to start the mission`), the status file appeared at `missions/<key>/status/freeform-….json` with `hold: "plan-approval"`, and `ping`/`approve` over the control socket returned `ok`/`rejected` as specified.
