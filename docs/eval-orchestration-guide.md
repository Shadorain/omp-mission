# Orchestration Architecture & Eval DAG Guide

## 1. Architectural Reality: Naive Schedulers vs. Native OMP Eval

When running multi-agent workflows across codebases, three execution models exist in this ecosystem:

| Dimension | Naive Swarm (`omp-mission`) | Native `orchestrate` Keyword | Native `eval` DAG (`workflowz`) |
| :--- | :--- | :--- | :--- |
| **Workspace Safety** | ❌ **High Collision**: All workers share `cwd`. Uncommitted edits break sibling test runs. | ⚠️ **Medium**: Relies on model respecting strict file-level disjunction. | ✅ **Hard Isolation**: `isolated: true` spins up dedicated physical Git worktrees. |
| **Scheduling Model** | ❌ **String Sort**: Naive `ready.sort().slice(0, capacity)` ignores critical path and priority. | ⚠️ **Heuristic**: Model batches independent `task` calls in one turn. | ✅ **Deterministic Code**: Python/TS scripts orchestrate acyclic waves with `wait()`. |
| **Failure Handling** | ❌ **Fragile**: Single unhandled failure or timeout hangs or cascades through the whole graph. | ⚠️ **Advisory**: Model inspects return and re-dispatches. | ✅ **Subtree Isolation**: `wait(hs, raise_errors=False)` isolates failures to affected paths. |
| **Execution Medium** | Terminal/Orca/Beads loop | Conversational tool loops | Persistent `eval` REPL (Bun/Python) |

---

## 2. Does the User "Just Type `eval`"?

**No.** In OMP, `eval` is a tool callable by the model, not a user-facing interactive slash command (like `/mission` or `/model`).

To direct OMP to use the deterministic `eval` DAG workflow, there are three methods:

### Method A: The Built-in Magic Keyword (`workflowz`)
OMP includes a native keyword parser. When the exact lowercase word **`workflowz`** is included anywhere in prose, OMP injects a contract requiring the model to use the persistent `eval` kernel (`agent()`, `workpool()`, `wait()`, `completion()`):

```text
workflowz refactor the authentication module into separate OAuth and JWT handlers
```

*Note: The keyword must be standalone lowercase `workflowz` (not `Workflowz` or `workflow`).*

### Method B: Direct Prompting (Zero Ambiguity)
To bypass keyword detection and instruct the model directly, specify the tool and flags:

```text
Run this in eval using agent() with isolated=True and wave barriers with wait().
Do not use raw task subagents in the main workspace.
```

### Method C: Persistent Repository Rule (`AGENTS.md`)
To make this the default behavior for the repository, add a policy section to `AGENTS.md`.

---

## 3. How to Express Instructions for the LLM

### Template 1: For Multi-File Migrations / Batch Tasks (`workpool`)
Use this for 3+ independent items with zero inter-file dependencies (e.g., adding unit tests, migrating file formats):

```markdown
workflowz execute this migration:
1. Initialize an eval workpool for the target files.
2. Run workers with `isolated=True` so test runs do not collide.
3. Collect results via workpool barrier and report verified passes.
```

### Template 2: For Dependent Multi-Phase Feature Work (DAG Waves)
Use this when Step 2 depends on Step 1:

```markdown
Execute this using an eval DAG in acyclic waves:
- Wave 1 (Contracts & Types): Spawn worker with `isolated=True` to define interfaces. Wait on handle `wait([h1])`. Verify exit code.
- Wave 2 (Implementation): Pass Wave 1's output into Wave 2 workers. Run in parallel isolated worktrees. Wait with `wait([h2, h3], raise_errors=False)`.
- Reconcile & Verify: Merge worktrees and run full test suite `bun test`.
```

---

## 4. Under the Hood: The Native `eval` Code Pattern

The code executed by the model inside the `eval` kernel looks like this:

```python
# Wave 1: Core Type / Contract Definition
h_types = agent(
    "Define auth interfaces in src/types/auth.ts. Do not touch other files.",
    isolated=True
)
types_result = wait([h_types])

# Wave 2: Independent Consumers (Parallel in isolated Git worktrees)
h_oauth = agent(
    f"Implement OAuth provider using contract:\n{types_result[0]}",
    isolated=True
)
h_jwt = agent(
    f"Implement JWT validator using contract:\n{types_result[0]}",
    isolated=True
)

# Wave Barrier: Collect results with subtree fault tolerance
results = wait([h_oauth, h_jwt], raise_errors=False)
```

---

## 5. Summary Rules for the Product Owner

1. **Avoid Shared-Directory Swarms**: Never let parallel agents edit the same working tree simultaneously. If running parallel workers, enforce `isolated=True`.
2. **Batch Tasks vs. Feature Logic**:
   * Independent bulk edits: Use `workflowz` / `eval.workpool()`.
   * Coupled feature logic: Run sequential linear turns (`omp plan`). It avoids coordination overhead and completes faster.
