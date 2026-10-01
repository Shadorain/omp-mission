# omp-mission

OMP extension: runs a ticket or task through plan, isolate, graph, execute, verify, deliver, review. Bun + TypeScript, no build step. `index.ts` re-exports `src/extension.ts`.

## Commands

```bash
bun test              # full suite
bun run typecheck     # tsc --noEmit
```

Both MUST pass before a commit, except failures you can show are pre-existing: name them.

## Map

|Area|Read|
|---|---|
|Phases, gates, ownership, graphs, tool surface|@docs/architecture.md|
|Worker launch, Orca/Herdr transport|@docs/workers.md|
|Running the extension for real, safely|@docs/runtime-smoke.md|
|User-facing behavior, config keys|`README.md`|

## Rules

- Native approval, Pause gates, resume hold, and controller ownership are the safety model. NEVER route around them to make a flow shorter.
- `mission_control` is the only model-facing mutation path. Slash commands you type call the same `control()` directly.
- Keep tool results small: shape model-facing output in `src/status.ts`, never return saved mission JSON whole.
- Pure policy lives in `src/controller.ts`. Side effects stay in `extension.ts`, `workers.ts`, `hosts.ts`.
- Clean cutover: when a flow changes, migrate every caller and delete the old path. No shims.
- Match the surrounding file's style. `extension.ts` is dense by convention.
- A change to behavior updates `README.md` and the matching `docs/` file in the same commit.

## Verification

- Bug: reproduce first, keep a failing-before test, confirm after.
- UI or worker flow: run the real thing per @docs/runtime-smoke.md. Tests alone do not count.
- Extension code loads once per OMP process. Restart OMP to see a change; `/reload-plugins` does not reload it.
- NEVER touch real missions under the agent dir (`~/.omp/agent/missions`) or the live `mission.json` while testing. Use an isolated `PI_CODING_AGENT_DIR`.

## Commits

- Conventional commits: `feat:`, `fix:`, `refactor:`, `test:`, `docs:`, `chore:`; optional scope, e.g. `fix(workers): ...`.
- One commit per work slice. Do not bundle unrelated slices; split dirty files by slice when needed.
- Commit freely. NEVER push until the user approves, unless they directed it.
