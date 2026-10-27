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

- `OMP_MISSION_AUTOSTART` carries the `/mission` arguments verbatim (a leading `/mission` is stripped). `session_start` schedules the normal command path after session restoration; native plan entry succeeds before a pending plan is written.
- The `--config` overlay may establish the intended startup state before extension work. A fresh-plan overlay is not required for native entry; Holotable retains its fresh-plan/resume overlays, and resuming a past-plan mission still disables startup planning.
- `OMP_HOLOTABLE_CHILD=1` marks the pane as board-launched: only then does the operator control socket exist. The status file is written either way.

## Autostart behavior

Autostart creates the plan. It never approves it: approval still happens in the pane. Startup retries a busy mode transition for a bounded interval; other refusals are reported without creating mission state. A saved mission or recovered pending plan suppresses autostart.
