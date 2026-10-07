// Battery 2: State Resilience & Recovery
// Comprehensive test suite for crash recovery, network timeouts & stalls, and lock concurrency.
import { test, expect, describe } from "bun:test";
import {
  acquireOwnership,
  listMissions,
  loadMission,
  missionDirectory,
  missionId,
  missionPath,
  saveMission,
  validateMission,
  workspaceKey,
} from "../../src/store";
import type { Ownership } from "../../src/store";
import { lock } from "../../src/lock";
import { nextAction } from "../../src/controller";
import { createWorkerDriver } from "../../src/workers";
import { readGraph } from "../../src/beads";
import { fetchSource } from "../../src/sources";
import type { Bead, Mission, PolicyContext, Run, Snapshot, Worker } from "../../src/types";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  existsSync,
  statSync,
  utimesSync,
  rmdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TMP_PREFIX = "battery2-resilience-";

function mkMission(id: string, key = "ws1"): Mission {
  return {
    version: 1,
    id,
    source: { kind: "freeform", id: `freeform:${id}`, title: id, body: "", comments: "", extra: "" },
    workspace: { key, cwd: "/tmp/test", delivery: "local" },
    scopes: { a: ["a.ts"] },
    phase: "execute",
    evidence: {},
    mode: "auto",
    keep: false,
    reviewRequested: false,
    workers: [],
    reviews: [],
    repairLinks: {},
    round: 1,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function mkWorker(beadId = "a", extra: Partial<Worker> = {}): Worker {
  return {
    beadId,
    attempt: "att1",
    cwd: "/tmp/test",
    files: ["a.ts"],
    state: "awaiting-claim",
    handle: "term_1",
    incarnationId: "inc_1",
    assignment: "work on a",
    launchedAt: new Date().toISOString(),
    ...extra,
  };
}

function mkBead(id: string, category: Bead["category"] = "ready", extra: Partial<Bead> = {}): Bead {
  return {
    id,
    title: id,
    status: category === "ready" ? "open" : category,
    children: [],
    ready: category === "ready",
    category,
    ...extra,
  };
}

function mkSnapshot(beads: Bead[]): Snapshot {
  const leaves = beads.filter((b) => b.category !== "group");
  return {
    beads,
    leaves,
    ready: beads.filter((b) => b.ready).map((b) => b.id),
    closed: leaves.filter((b) => b.category === "closed").length,
    active: leaves.filter((b) => b.category === "active").length,
    blocked: leaves.filter((b) => b.category === "blocked" || b.category === "waiting").length,
    fetchedAt: Date.now(),
  };
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// 1. Crash Recovery
// ============================================================================
describe("Battery 2: Crash Recovery", () => {
  test("recovers from crashed atomic writes leaving orphaned .tmp files", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    // Establish canonical mission state
    await saveMission(p, mkMission("m1"));

    // Simulate crash artifacts: aborted writers leaving partial or garbage .tmp files
    writeFileSync(join(dir, ".m1.abort1.tmp"), '{"version":1,"id":"m1"'); // truncated
    writeFileSync(join(dir, ".m1.abort2.tmp"), ""); // 0-byte
    writeFileSync(join(dir, ".m1.abort3.tmp"), JSON.stringify({ ...mkMission("m1"), blocker: "uncommitted" }));

    // Recovery check 1: loadMission reads the canonical state, unaffected by .tmp litter
    const loaded = await loadMission(p);
    expect(loaded.id).toBe("m1");
    expect(loaded.blocker).toBeUndefined();

    // Recovery check 2: listMissions ignores all .tmp artifacts and surfaces only the valid mission
    const list = await listMissions(root);
    expect(list.length).toBe(1);
    expect(list[0]!.mission.id).toBe("m1");

    // Subsequent atomic write succeeds and preserves cleanliness
    await saveMission(p, { ...loaded, blocker: "recovered" });
    expect((await loadMission(p)).blocker).toBe("recovered");

    rmSync(root, { recursive: true, force: true });
  });

  test("failed atomic write preserves existing canonical mission and leaves no tmp litter", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    await saveMission(p, mkMission("m1"));

    // Attempt to save an oversized mission (> 5MB) to simulate failure during serialize/write
    const huge = mkMission("m1");
    huge.workers = Array.from({ length: 400 }, (_, i) => ({
      beadId: `b${i}`,
      attempt: `a${i}`,
      cwd: "/tmp",
      files: ["x".repeat(3000)],
      state: "reserved" as const,
      assignment: "x".repeat(15000),
    }));

    await expect(saveMission(p, huge)).rejects.toThrow(/exceeds/);

    // Existing canonical file is unmodified
    const loaded = await loadMission(p);
    expect(loaded.id).toBe("m1");
    expect(loaded.workers.length).toBe(0);

    // No temporary files leaked
    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".tmp")).length).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });

  test("0-byte crash-leftover file is adopted and restored to valid mission", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    // Simulate power failure/crash creating an empty 0-byte file
    writeFileSync(p, "");
    expect(statSync(p).size).toBe(0);

    // acquireOwnership detects empty file, adopts input mission, and writes nonce
    const ownership = await acquireOwnership(p, mkMission("m1"));
    expect(ownership.nonce).toBeDefined();

    // Mission on disk is restored and fully valid
    const loaded = await loadMission(p);
    expect(loaded.id).toBe("m1");
    expect(loaded.controllerNonce).toBe(ownership.nonce);

    await ownership.release();
    expect((await loadMission(p)).controllerNonce).toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  });

  test("corrupted JSON crash file fails safely and cleans lock without leaking", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    // Partial JSON write leftover from sudden termination
    writeFileSync(p, '{"version":1,"id":"m1","workspace":{"ke');

    await expect(loadMission(p)).rejects.toThrow(/Cannot load/);
    await expect(acquireOwnership(p, mkMission("m1"))).rejects.toThrow(/Cannot load/);

    // Lock file must NOT remain held after failure
    expect(existsSync(p + ".lock")).toBe(false);

    rmSync(root, { recursive: true, force: true });
  });

  test("orphaned lock after controller crash (SIGKILL) is safely taken over when stale", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    // Subprocess script acquiring ownership and holding it until killed
    const childFile = join(root, "child.ts");
    const storeModule = join(import.meta.dir, "..", "..", "src", "store.ts");
    writeFileSync(
      childFile,
      [
        `import { acquireOwnership } from ${JSON.stringify(storeModule)};`,
        `await acquireOwnership(process.argv[2], JSON.parse(process.argv[3]));`,
        `console.log("ACQUIRED");`,
        `setInterval(() => {}, 60000);`,
      ].join("\n"),
    );

    const proc = Bun.spawn([process.execPath, childFile, p, JSON.stringify(mkMission("m1"))], {
      stdout: "pipe",
      stderr: "pipe",
    });

    try {
      const decoder = new TextDecoder();
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let output = "";
      const deadline = Date.now() + 10_000;
      while (!output.includes("ACQUIRED") && Date.now() < deadline) {
        const { done, value } = await Promise.race([
          reader.read(),
          delay(200).then(() => ({ done: false, value: undefined })),
        ]);
        if (done) break;
        if (value) output += decoder.decode(value);
        if (output.includes("ACQUIRED")) break;
      }
      reader.releaseLock();
      expect(output).toContain("ACQUIRED");
      // While child lives, parent cannot acquire ownership
      await expect(acquireOwnership(p, mkMission("m1"))).rejects.toMatchObject({ code: "ELOCKED" });

      // Simulate abrupt controller crash (SIGKILL, e.g. OOM or kernel kill)
      proc.kill(9);
      await proc.exited;

      // Lock dir remains orphaned
      expect(existsSync(p + ".lock")).toBe(true);

      // Fresh orphaned lock is still protected against immediate preemption
      await expect(acquireOwnership(p, mkMission("m1"))).rejects.toMatchObject({ code: "ELOCKED" });

      // Backdate lock mtime past stale threshold (30 seconds)
      const staleTime = new Date(Date.now() - 32_000);
      utimesSync(p + ".lock", staleTime, staleTime);

      // Stale takeover succeeds: new controller breaks stale lock and assumes ownership
      const recovered = await acquireOwnership(p, mkMission("m1"));
      expect(recovered.nonce).toBeDefined();
      await recovered.assertOwned();

      const diskMission = await loadMission(p);
      expect(diskMission.controllerNonce).toBe(recovered.nonce);

      await recovered.release();
    } finally {
      proc.kill(9);
      await proc.exited;
      rmSync(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("worker crash recovery transitions missing worker and redispatches seamlessly", async () => {
    const w = mkWorker("a", { state: "missing", error: "worker host crashed" });
    const m: Mission = { ...mkMission("m1"), epicId: "epic-1", workers: [w], scopes: { a: ["a.ts"] }, phase: "execute" };
    const snap = mkSnapshot([mkBead("a", "ready")]);
    const policy: PolicyContext = { resumeHold: false, owned: true, nativePlan: false, fresh: true, maxWorkers: 2 };

    const driver = createWorkerDriver(async () => ({ stdout: "", stderr: "", code: 0 }), {
      persist: async () => {},
    });

    // Recover dead worker
    await driver.recover(m, "a", mkBead("a", "ready"));
    expect(m.workers[0]!.state).toBe("closed");
    expect(m.workers[0]!.error).toMatch(/^replaced:/);

    // Controller detects capacity and schedules dispatch
    const next = nextAction(m, snap, policy);
    expect(next.kind).toBe("dispatch");
    expect(next.ids).toEqual(["a"]);
  });
});

// ============================================================================
// 2. Network Timeouts & I/O Resilience
// ============================================================================
describe("Battery 2: Network Timeouts & I/O Resilience", () => {
  test("lock heartbeat detects network/storage stall and fires onCompromised", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    const { promise: compromisedPromise, resolve: onCompromisedFired } = Promise.withResolvers<void>();
    let errorCaught: Error | undefined;

    const ownership = await acquireOwnership(p, mkMission("m1"), (err) => {
      errorCaught = err;
      onCompromisedFired();
    });

    await ownership.assertOwned();

    // Simulate network filesystem / remote storage dropping the lock directory
    rmdirSync(p + ".lock");

    await Promise.race([
      compromisedPromise,
      delay(20_000).then(() => {
        throw new Error("Heartbeat compromise detection timed out");
      }),
    ]);

    expect(errorCaught).toBeDefined();
    expect((errorCaught as NodeJS.ErrnoException).code).toBe("ECOMPROMISED");

    // Mutation assertion immediately fails
    await expect(ownership.assertOwned()).rejects.toThrow(/ownership lost/);

    // release() after compromise is safe and does not throw
    await expect(ownership.release()).resolves.toBeUndefined();

    rmSync(root, { recursive: true, force: true });
  }, 30_000);

  test("remote source fetch network timeout fails cleanly without corrupting state", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const timeoutRun: Run = async () => {
      // Simulate network request timing out
      throw Object.assign(new Error("ETIMEDOUT: network request timed out"), { code: "ETIMEDOUT" });
    };

    await expect(
      fetchSource({ source: "org/repo#42", extra: "", force: false, pause: false, keep: false }, root, timeoutRun),
    ).rejects.toThrow(/ETIMEDOUT/);

    // Ensure no state was written to disk
    expect(readdirSync(root).length).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });

  test("bead graph network timeout falls back to previous snapshot and safely holds mutations", async () => {
    const beadA = mkBead("a", "ready");
    const initialSnapshot = mkSnapshot([beadA]);

    // Network timeout during subsequent graph refresh
    const timeoutRun: Run = async () => {
      throw new Error("Network timeout: connection reset by peer");
    };

    const fallbackSnapshot = await readGraph(timeoutRun, "/tmp", "epic1", undefined, initialSnapshot);

    // Preserves bead structure from previous snapshot
    expect(fallbackSnapshot.beads.length).toBe(1);
    expect(fallbackSnapshot.error).toContain("Network timeout");

    // Policy context with error holds nextAction from initiating destructive mutations
    const mission = mkMission("m1");
    mission.epicId = "epic1";
    mission.scopes = { a: ["a.ts"] };
    const policy: PolicyContext = {
      resumeHold: false,
      owned: true,
      nativePlan: false,
      fresh: false, // marked stale due to snapshot error
      maxWorkers: 2,
    };

    const action = nextAction(mission, fallbackSnapshot, policy);
    expect(action.kind).toBe("hold");
    expect(action.detail).toContain("Network timeout");
  });

  test("lock acquisition retries on transient contention and succeeds upon release", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const target = join(root, "resource.json");
    writeFileSync(target, "{}");

    // Lock holder acquires lock
    const releaseInitial = await lock(target, { stale: 10_000 });

    // Lock contender initiates acquisition with retries
    let acquired = false;
    const contenderPromise = lock(target, {
      stale: 10_000,
      retries: { retries: 10, minTimeout: 30 },
    }).then((rel) => {
      acquired = true;
      return rel;
    });

    // Contender should be waiting, not immediately resolved
    await delay(50);
    expect(acquired).toBe(false);

    // Initial lock holder releases
    await releaseInitial();

    // Contender successfully acquires lock via retry loop
    const releaseContender = await contenderPromise;
    expect(acquired).toBe(true);

    await releaseContender();
    rmSync(root, { recursive: true, force: true });
  });

  test("lock acquisition retries exhaust and throw ELOCKED if lock not released", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const target = join(root, "busy.json");
    writeFileSync(target, "{}");

    const releaseHolder = await lock(target, { stale: 10_000 });

    // Contender retries 2 times then gives up
    await expect(
      lock(target, {
        stale: 10_000,
        retries: { retries: 2, minTimeout: 20 },
      }),
    ).rejects.toMatchObject({ code: "ELOCKED" });

    await releaseHolder();
    rmSync(root, { recursive: true, force: true });
  });
});

// ============================================================================
// 3. Lock Concurrency
// ============================================================================
describe("Battery 2: Lock Concurrency", () => {
  test("50 concurrent saveMission calls complete atomically with zero tmp litter", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    // 50 concurrent saves with varying fields
    await Promise.all(
      Array.from({ length: 50 }, (_, i) =>
        saveMission(p, {
          ...mkMission("m1"),
          blocker: `iteration-${i}`,
          round: i,
        }),
      ),
    );

    // Canonical file is intact and valid
    const loaded = await loadMission(p);
    expect(loaded.id).toBe("m1");
    expect(loaded.version).toBe(1);

    // Absolute zero tmp files leaked
    const files = readdirSync(dir);
    expect(files.filter((f) => f.endsWith(".tmp")).length).toBe(0);

    rmSync(root, { recursive: true, force: true });
  });

  test("10 concurrent controllers racing acquireOwnership: exactly one winner, losers get ELOCKED", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => acquireOwnership(p, mkMission("m1"))),
    );

    const winners = results.filter((r): r is PromiseFulfilledResult<Ownership> => r.status === "fulfilled");
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    expect(winners.length).toBe(1);
    expect(losers.length).toBe(9);

    for (const loser of losers) {
      expect((loser.reason as NodeJS.ErrnoException).code).toBe("ELOCKED");
    }

    // Winner can assert ownership and release
    const winner = winners[0]!.value;
    await winner.assertOwned();
    await winner.release();

    // After release, a subsequent controller can acquire
    const nextOwner = await acquireOwnership(p, mkMission("m1"));
    expect(nextOwner.nonce).toBeDefined();
    await nextOwner.release();

    rmSync(root, { recursive: true, force: true });
  });

  test("concurrent stale lock takeover race: exactly one recovers, others get ELOCKED without EEXIST", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    await saveMission(p, mkMission("m1"));

    // Create stale lock directory (35 seconds in the past)
    mkdirSync(p + ".lock");
    const staleTime = new Date(Date.now() - 35_000);
    utimesSync(p + ".lock", staleTime, staleTime);

    // 10 controllers race to break the stale lock concurrently
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, () => acquireOwnership(p, mkMission("m1"))),
    );

    const winners = results.filter((r): r is PromiseFulfilledResult<Ownership> => r.status === "fulfilled");
    const losers = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");

    // Exactly one winner breaks and takes over the stale lock
    expect(winners.length).toBe(1);
    expect(losers.length).toBe(9);

    // Losers MUST receive ELOCKED, never raw unhandled EEXIST
    for (const loser of losers) {
      expect((loser.reason as NodeJS.ErrnoException).code).toBe("ELOCKED");
    }

    await winners[0]!.value.release();
    rmSync(root, { recursive: true, force: true });
  });

  test("cross-process lock exclusion with multiple child processes", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");

    const childFile = join(root, "racer.ts");
    const storeModule = join(import.meta.dir, "..", "..", "src", "store.ts");
    writeFileSync(
      childFile,
      [
        `import { acquireOwnership } from ${JSON.stringify(storeModule)};`,
        `try {`,
        `  await acquireOwnership(process.argv[2], JSON.parse(process.argv[3]));`,
        `  console.log("WON");`,
        `  setInterval(() => {}, 60000);`,
        `} catch (err) {`,
        `  console.log("LOST:" + (err?.code || err?.message));`,
        `  process.exit(0);`,
        `}`,
      ].join("\n"),
    );

    // Spawn 2 competing children
    const proc1 = Bun.spawn([process.execPath, childFile, p, JSON.stringify(mkMission("m1"))], { stdout: "pipe" });
    const proc2 = Bun.spawn([process.execPath, childFile, p, JSON.stringify(mkMission("m1"))], { stdout: "pipe" });

    try {
      const decoder = new TextDecoder();
      const reader1 = (proc1.stdout as ReadableStream<Uint8Array>).getReader();
      const reader2 = (proc2.stdout as ReadableStream<Uint8Array>).getReader();
      let combined = "";
      const deadline = Date.now() + 10_000;
      while ((!combined.includes("WON") || !combined.includes("LOST:ELOCKED")) && Date.now() < deadline) {
        const chunk1 = await Promise.race([reader1.read(), delay(100).then(() => undefined)]);
        if (chunk1 && chunk1.value) combined += decoder.decode(chunk1.value);
        const chunk2 = await Promise.race([reader2.read(), delay(100).then(() => undefined)]);
        if (chunk2 && chunk2.value) combined += decoder.decode(chunk2.value);
      }
      reader1.releaseLock();
      reader2.releaseLock();

      // Exactly one WON, one LOST:ELOCKED
      expect(combined).toContain("WON");
      expect(combined).toContain("LOST:ELOCKED");
    } finally {
      proc1.kill(9);
      proc2.kill(9);
      await Promise.all([proc1.exited, proc2.exited]);
      rmSync(root, { recursive: true, force: true });
    }
  }, 15_000);

  test("concurrent independent missions in same workspace operate without crosstalk", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1");
    mkdirSync(dir, { recursive: true });

    const missionIds = ["m1", "m2", "m3", "m4", "m5"];

    // Acquire all 5 concurrently
    const owners = await Promise.all(
      missionIds.map((id) => acquireOwnership(join(dir, `${id}.json`), mkMission(id))),
    );

    expect(owners.length).toBe(5);
    const nonces = new Set(owners.map((o) => o.nonce));
    expect(nonces.size).toBe(5); // unique nonces

    // Assert owned concurrently
    await Promise.all(owners.map((o) => o.assertOwned()));

    // Concurrent saves on distinct missions
    await Promise.all(
      owners.map((o, idx) =>
        saveMission(join(dir, `${o.mission.id}.json`), {
          ...o.mission,
          round: idx + 1,
        }),
      ),
    );

    // Release all concurrently
    await Promise.all(owners.map((o) => o.release()));

    // Verify all 5 missions on disk
    for (let idx = 0; idx < missionIds.length; idx++) {
      const id = missionIds[idx]!;
      const loaded = await loadMission(join(dir, `${id}.json`));
      expect(loaded.id).toBe(id);
      expect(loaded.round).toBe(idx + 1);
      expect(loaded.controllerNonce).toBeUndefined();
    }

    rmSync(root, { recursive: true, force: true });
  });
});
