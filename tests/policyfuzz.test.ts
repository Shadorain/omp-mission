import { test, expect } from "bun:test";
import { setMode, nextAction, enforceMutation, enforceGate, approveGate, waveGate, revisionGate } from "../src/controller";
import { captureRevision, parseReview } from "../src/review";
import type { Mission, Snapshot, PolicyContext, Bead, Worker, Finding } from "../src/types";
import { mkdtemp, rm, writeFile, symlink, unlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

let rngState = 12345;
function nextRng() {
  rngState = (rngState * 1664525 + 1013904223) >>> 0;
  return rngState / 4294967296;
}
function randInt(min: number, max: number) {
  return Math.floor(nextRng() * (max - min)) + min;
}
function randBool() {
  return nextRng() > 0.5;
}
function randChoice<T>(arr: T[]): T {
  return arr[randInt(0, arr.length)];
}
function createBaseSnapshot(): Snapshot {
  return { beads: [], leaves: [], ready: [], closed: 0, active: 0, blocked: 0, fetchedAt: 12345 };
}
function createMockMission(): Mission {
  return {
    version: 1,
    id: "m-1",
    source: { kind: "freeform", id: "1", title: "T", body: "B", comments: "", extra: "" },
    workspace: { key: "wk", cwd: "/tmp", delivery: "local" },
    epicId: "e-1",
    scopes: {},
    phase: "execute",
    evidence: {},
    mode: "pause",
    keep: false,
    reviewRequested: false,
    workers: [],
    reviews: [],
    repairLinks: {},
    round: 1,
    createdAt: "2024",
    updatedAt: "2024"
  };
}

const basePolicy: PolicyContext = { resumeHold: false, owned: true, nativePlan: false, fresh: true, maxWorkers: 2 };

// ---------- targeted gate lifecycle tests ----------

test("pause wave gate: hold, approve once, dispatch, invalidate on status change", () => {
  const m = createMockMission();
  const s = createBaseSnapshot();
  s.beads.push({ id: "b-1", title: "t", status: "todo", children: [], ready: true, category: "ready" });
  s.leaves = s.beads;
  s.ready.push("b-1");
  m.scopes["b-1"] = ["a.ts"];

  const action = nextAction(m, s, basePolicy);
  expect(action.kind).toBe("hold");
  expect(action.gate).toBeDefined();

  expect(() => enforceGate(m, action.gate!)).toThrow(/Approval required/);
  expect(m.gate?.token).toBe(action.gate!.token);
  expect(m.gate?.approved).toBe(false);

  approveGate(m, m.gate!.token);
  expect(m.gate?.approved).toBe(true);
  expect(nextAction(m, s, basePolicy).kind).toBe("dispatch");

  s.beads[0].status = "in-progress";
  const after = nextAction(m, s, basePolicy);
  expect(after.kind).toBe("hold");
  expect(after.gate?.token).not.toBe(m.gate!.token);
});

test("enforceGate consumes the approved gate before the mutation runs; a failed dispatch loses the approval", () => {
  const m = createMockMission();
  const s = createBaseSnapshot();
  s.beads.push({ id: "b-1", title: "t", status: "todo", children: [], ready: true, category: "ready" });
  s.leaves = s.beads;
  s.ready.push("b-1");
  m.scopes["b-1"] = ["a.ts"];

  const action = nextAction(m, s, basePolicy);
  expect(() => enforceGate(m, action.gate!)).toThrow();
  approveGate(m, m.gate!.token);
  enforceGate(m, m.gate!); // consumed here, before driver.dispatch runs in extension.ts
  expect(m.gate).toBeDefined();
});

test("gate tokens are kind-bound: wave/review/repairs never share a token", () => {
  const m = createMockMission();
  const s = createBaseSnapshot();
  s.beads.push({ id: "b-1", title: "t", status: "todo", children: [], ready: true, category: "ready" });
  s.leaves = s.beads;
  s.ready.push("b-1");
  m.scopes["b-1"] = ["a.ts"];
  m.reviews.push({ round: 1, revision: "rev", model: "m", summary: "s", at: "d", findings: [{ id: "f1", severity: "low", path: "a.ts", line: 1, title: "t", body: "b" }] });

  const wave = waveGate(m, ["b-1"], s);
  const review = revisionGate(m, "review", "rev");
  const repairs = revisionGate(m, "repairs", "rev");
  const tokens = new Set([wave.token, review.token, repairs.token]);
  expect(tokens.size).toBe(3);
});

test("setMode('force') latches reviewRequested; setMode non-pause clears gate; mode never touches resumeHold semantics", () => {
  const m = createMockMission();
  m.gate = { kind: "wave", token: "t", detail: "d", approved: true };
  setMode(m, "force");
  expect(m.reviewRequested).toBe(true);
  expect(m.gate).toBeUndefined();
});

// ---------- model-based fuzz over controller ----------

test("fuzz nextAction/setMode/enforceGate invariants over random sequences", () => {
  for (let i = 0; i < 4000; i++) {
    const m = createMockMission();
    const pc = { ...basePolicy };
    const s = createBaseSnapshot();
    let resumeHold = false; // external; setMode must never clear it

    // Random ops sequence
    const steps = randInt(1, 12);
    for (let step = 0; step < steps; step++) {
      const op = randChoice(["setMode", "approve", "worker", "review", "evidence", "snapshot", "policy", "noop"]);
      switch (op) {
        case "setMode":
          setMode(m, randChoice(["auto", "pause", "force"]));
          break;
        case "approve":
          if (m.gate) approveGate(m, m.gate.token);
          break;
        case "worker":
          if (randBool() && m.workers.length < 5) {
            m.workers.push({
              beadId: `w-${m.workers.length}`, attempt: "a", cwd: "/tmp", files: [], assignment: "x",
              state: randChoice(["reserved", "starting", "awaiting-claim", "running", "closed", "missing"]),
              error: randBool() ? "err" : undefined,
            });
          } else if (m.workers.length) {
            m.workers[randInt(0, m.workers.length)].state = randChoice(["closed", "missing", "running"]);
          }
          break;
        case "review": {
          const findings: Finding[] = [];
          for (let k = 0; k < randInt(0, 3); k++) {
            findings.push({ id: `f-${k}`, severity: "low", path: "a.ts", line: 1, title: "t", body: "b", rejection: randBool() ? "n/a" : undefined });
          }
          m.reviews.push({ round: m.reviews.length + 1, revision: "rev", model: "m", summary: "s", findings, at: "d", invalidated: randBool() ? "inv" : undefined });
          break;
        }
        case "evidence":
          if (randBool()) m.evidence.verify = { outcome: randChoice(["passed", "failed", "pending"]), detail: "d", revision: "rev", at: "d" };
          if (randBool()) m.evidence.deliver = { outcome: randChoice(["passed", "failed", "pending"]), detail: "d", at: "d" };
          if (randBool()) m.evidence.review = { outcome: randChoice(["passed", "failed", "pending"]), detail: "d", revision: "rev", at: "d" };
          break;
        case "snapshot": {
          s.leaves = [];
          s.beads = [];
          s.ready = [];
          for (let j = 0; j < randInt(0, 5); j++) {
            const b: Bead = {
              id: `b-${j}`, title: "t", status: randChoice(["todo", "in-progress", "done"]), children: [],
              ready: randBool(), category: randChoice(["closed", "active", "ready", "blocked", "waiting"]),
            };
            s.leaves.push(b); s.beads.push(b);
            if (b.category === "ready") s.ready.push(b.id);
            if (randBool()) m.scopes[b.id] = ["file.ts"];
          }
          if (randBool()) s.error = "err";
          break;
        }
        case "policy":
          resumeHold = randBool();
          pc.resumeHold = resumeHold;
          pc.owned = randBool();
          pc.nativePlan = randBool();
          pc.fresh = randBool();
          pc.maxWorkers = randInt(1, 5);
          if (randBool()) m.blocker = "blocked"; else delete m.blocker;
          m.phase = randChoice(["execute", "verify", "deliver", "review", "repair", "complete"]);
          m.reviewRequested = randBool();
          break;
      }

      const action = nextAction(m, s, pc);
      const mustHold = pc.resumeHold || !pc.owned || pc.nativePlan || m.blocker !== undefined || s.error !== undefined || !pc.fresh;
      if (mustHold && action.kind !== "hold") {
        throw new Error(`hold-state violation: kind=${action.kind} hold=${pc.resumeHold} owned=${pc.owned} plan=${pc.nativePlan} blocker=${m.blocker} err=${s.error} fresh=${pc.fresh}`);
      }
      // pause dispatch is always preceded by hold+gate; nextAction must never return dispatch in pause
      if (action.kind === "dispatch" && m.mode === "pause") {
        const gate = waveGate(m, action.ids!, s);
        if (m.gate?.token !== gate.token || !m.gate.approved) {
          throw new Error(`pause dispatch without matching approved token`);
        }
      }
      if (action.kind === "complete") {
        const rev = m.evidence.verify?.revision;
        const review = m.reviews.at(-1);
        const clean = !!review && !review.invalidated && review.revision === rev && review.findings.every(f => !!f.rejection);
        if (m.evidence.verify?.outcome !== "passed" || m.evidence.deliver?.outcome !== "passed" || !clean || !m.reviewRequested) {
          throw new Error(`complete with dirty state`);
        }
      }
      if (action.kind === "repairs" && m.mode === "pause") {
        const gate = revisionGate(m, "repairs", m.evidence.verify!.revision!);
        if (m.gate?.token !== gate.token || !m.gate.approved) throw new Error("repairs in pause without gate");
      }
      if (action.kind === "review" && m.mode === "pause") {
        const gate = revisionGate(m, "review", m.evidence.verify!.revision!);
        if (m.gate?.token !== gate.token || !m.gate.approved) throw new Error("review in pause without gate");
      }
      // mode switch never clears resumeHold
      setMode(m, m.mode);
      expect(pc.resumeHold).toBe(resumeHold);
    }
  }
});

// ---------- parseReview fuzz + adversarial findings ----------

test("parseReview rejects malformed inputs", () => {
  const rev = "r1";
  expect(() => parseReview("not json", rev)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"other","summary":"s","findings":[]}', rev)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"r1","summary":123,"findings":[]}', rev)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"s","findings":"x"}', rev)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"s","findings":[{"id":"a","severity":"bogus","path":"p","line":1,"title":"t","body":"b"}]}', rev)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"s","findings":[{"id":"a","severity":"low","path":"p","line":0,"title":"t","body":"b"}]}', rev)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"s","findings":[{"id":"a","severity":"low","path":"p","line":1.5,"title":"t","body":"b"}]}', rev)).toThrow();
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"s","findings":[{"id":"a","severity":"low","path":"p","line":1,"title":"t","body":"b"},{"id":"a","severity":"low","path":"p","line":2,"title":"t","body":"b"}]}', rev)).toThrow(); // dup id
  expect(() => parseReview('{"reviewedRevision":"r1","summary":"s","findings":null}', rev)).toThrow();

  const good = parseReview('```json\n{"reviewedRevision":"r1","summary":"s","findings":[]}\n```', rev);
  expect(good.findings).toHaveLength(0);
});

test("parseReview preserves attacker-supplied 'rejection' on findings, letting reviewer silently discard findings", () => {
  const rev = "r1";
  const res = parseReview(JSON.stringify({
    reviewedRevision: rev, summary: "s",
    findings: [{ id: "f1", severity: "low", path: "p", line: 1, title: "t", body: "b", rejection: "not a bug" }],
  }), rev);
  // nextAction treats f.rejection as a coordinator-approved rejection → finding never repaired.
  // parseReview must strip or forbid the field.
  expect(res.findings[0]!.rejection).toBeUndefined();
});

// ---------- captureRevision in a real git repo ----------

async function makeRepo(): Promise<{ dir: string; run: (c: string, a: string[], cwd: string) => Promise<{ stdout: string; stderr: string; code: number }> }> {
  const dir = await mkdtemp(join(tmpdir(), "omp-mission-fuzz-"));
  const run = async (c: string, a: string[], cwd: string) => {
    try {
      const { stdout, stderr } = await execFileAsync(c, a, { cwd });
      return { stdout: String(stdout), stderr: String(stderr), code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; code?: number };
      return { stdout: String(err.stdout ?? ""), stderr: String(err.stderr ?? ""), code: err.code ?? 1 };
    }
  };
  await run("git", ["init"], dir);
  await run("git", ["config", "user.email", "a@a"], dir);
  await run("git", ["config", "user.name", "a"], dir);
  await writeFile(join(dir, "a.txt"), "hello");
  await run("git", ["add", "a.txt"], dir);
  await run("git", ["commit", "-m", "init"], dir);
  return { dir, run };
}

function gitMission(dir: string): Mission {
  const m = createMockMission();
  m.workspace = { key: "k", cwd: dir, delivery: "local", commonDir: join(dir, ".git"), base: "HEAD" };
  return m;
}

test("captureRevision changes iff content changes", async () => {
  const { dir, run } = await makeRepo();
  try {
    const m = gitMission(dir);
    const r1 = await captureRevision(m, run);
    const r1b = await captureRevision(m, run);
    expect(r1b.revision).toBe(r1.revision); // deterministic

    await writeFile(join(dir, "b.txt"), "untracked");
    const r2 = await captureRevision(m, run);
    expect(r2.revision).not.toBe(r1.revision);

    await writeFile(join(dir, "a.txt"), "modified");
    const r3 = await captureRevision(m, run);
    expect(r3.revision).not.toBe(r2.revision);

    await unlink(join(dir, "a.txt"));
    const r4 = await captureRevision(m, run);
    expect(r4.revision).not.toBe(r3.revision);

    await writeFile(join(dir, "a.txt"), "modified");
    await unlink(join(dir, "b.txt"));
    const r5 = await captureRevision(m, run);
    expect(r5.revision).not.toBe(r3.revision); // a.txt modified, b.txt gone — new state
    expect(r5.revision).not.toBe(r4.revision);
    const r5b = await captureRevision(m, run);
    expect(r5b.revision).toBe(r5.revision); // same state → same revision
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureRevision hashes content through a symlink that escapes the workspace", async () => {
  const { dir, run } = await makeRepo();
  try {
    const outside = await mkdtemp(join(tmpdir(), "omp-outside-"));
    await writeFile(join(outside, "secret.txt"), "TOPSECRET");
    await symlink(join(outside, "secret.txt"), join(dir, "escape.txt"));

    const m = gitMission(dir);
    // ls-files --others lists escape.txt; resolve() does not dereference the link,
    // so the escape check passes and readFile hashes /tmp/.../secret.txt.
    await expect(captureRevision(m, run)).rejects.toThrow(/escapes workspace/);
    await rm(outside, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureRevision ignores mode-only changes; a chmod during review is not invalidated", async () => {
  const { dir, run } = await makeRepo();
  try {
    const m = gitMission(dir);
    const r1 = await captureRevision(m, run);
    await chmod(join(dir, "a.txt"), 0o755);
    const r2 = await captureRevision(m, run);
    // git diff shows a mode change but the fingerprint is content-only
    expect(r2.revision).not.toBe(r1.revision);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureRevision file-boundary collision: no length prefix lets crafted content forge a revision", async () => {
  // Repo A: file "a" containing bytes "\0b\0X". Stream = "a\0" + "\0b\0X" + "\0" = "a\0\0b\0X\0"
  // Repo B: file "a" empty + file "b" containing "X". Stream = "a\0" + "" + "\0" + "b\0" + "X" + "\0" = "a\0\0b\0X\0"
  const a = await makeRepo();
  const b = await makeRepo();
  try {
    // Both repos share same HEAD? No — makeRepo commits differ? Both init+commit identical content "hello" in a.txt, so HEAD hashes should match only if timestamps match — they won't.
    // Use non-git path instead: workspace.commonDir undefined → scopes-declared files hashed directly.
    const mA = createMockMission();
    mA.workspace = { key: "k", cwd: a.dir, delivery: "local" };
    mA.scopes = { t: ["a"] };
    await writeFile(join(a.dir, "a"), Buffer.from([0, 0x62, 0, 0x58])); // "\0b\0X"
    const rA = await captureRevision(mA, a.run);

    const mB = createMockMission();
    mB.workspace = { key: "k", cwd: b.dir, delivery: "local" };
    mB.scopes = { t: ["a", "b"] };
    await writeFile(join(b.dir, "a"), "");
    await writeFile(join(b.dir, "b"), "X");
    const rB = await captureRevision(mB, b.run);

    expect(rA.revision).not.toBe(rB.revision);
  } finally {
    await rm(a.dir, { recursive: true, force: true });
    await rm(b.dir, { recursive: true, force: true });
  }
});
