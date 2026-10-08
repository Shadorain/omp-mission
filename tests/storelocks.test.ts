// Adversarial tests for durable state, ownership locking, and mission config.
// StoreLocks slice. Uses a real bun subprocess for cross-process lock exclusion.
import { test, expect, describe } from "bun:test";
import {
  acquireOwnership, listMissions, loadMission,
  missionDirectory, missionId, missionPath, saveMission, validateMission, workspaceKey,
} from "../src/store";
import type { Ownership } from "../src/store";
import { readMissionConfig, resolveAgentDir, validateMissionConfig } from "../src/config";
import { mkdtempSync, mkdirSync, writeFileSync, readdirSync, existsSync, statSync, utimesSync, symlinkSync, rmSync, rmdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Mission } from "../src/types";

const TMP_PREFIX = "storelocks-";

function mkMission(id: string, key = "ws1"): Mission {
  return {
    version: 1, id,
    source: { kind: "freeform", id: "freeform:x", title: "T", body: "", comments: "", extra: "" },
    workspace: { key, cwd: "/tmp/x", delivery: "local" },
    scopes: {}, phase: "plan", evidence: {}, mode: "auto", keep: false,
    reviewRequested: false, workers: [], reviews: [], repairLinks: {}, round: 0,
    createdAt: "t", updatedAt: "t",
  };
}

type Hostile = Record<string, unknown>;
const hostile = (id = "m1", key = "ws1"): Hostile => JSON.parse(JSON.stringify(mkMission(id, key))) as Hostile;

const delay = (ms: number): Promise<void> => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

// ---------------------------------------------------------------- validateMission
describe("validateMission hostile input", () => {
  const bad = (name: string, mut: (m: Hostile) => void) =>
    test(name, () => {
      const m = hostile();
      mut(m);
      expect(() => validateMission(m)).toThrow(/Invalid mission state/);
    });

  test("non-object roots", () => {
    for (const v of [null, undefined, [], "x", 42]) expect(() => validateMission(v)).toThrow(/must be an object/);
  });
  test("wrong/unknown version", () => {
    for (const v of [0, 2, "1", null]) expect(() => validateMission({ ...hostile(), version: v })).toThrow(/version must be 1/);
  });
  bad("bad phase", m => m.phase = "nope");
  bad("phase case-sensitive", m => m.phase = "EXECUTE");
  bad("bad mode", m => m.mode = "AUTO");
  bad("non-boolean keep", m => m.keep = "yes");
  bad("workers not array", m => m.workers = {});
  bad("worker empty assignment", m => m.workers = [{ beadId: "b", attempt: "a", cwd: "/t", files: [], state: "reserved", assignment: "" }]);
  bad("worker bad state", m => m.workers = [{ beadId: "b", attempt: "a", cwd: "/t", files: [], state: "zombie", assignment: "x" }]);
  bad("worker non-string files", m => m.workers = [{ beadId: "b", attempt: "a", cwd: "/t", files: [1], state: "reserved", assignment: "x" }]);
  bad("round negative", m => m.round = -1);
  bad("round non-integer", m => m.round = 1.5);
  bad("round NaN", m => m.round = NaN);
  bad("gate bad kind", m => m.gate = { kind: "backdoor", token: "t", detail: "d", approved: false });
  bad("gate non-boolean approved", m => m.gate = { kind: "wave", token: "t", detail: "d", approved: "yes" });
  bad("gate empty token", m => m.gate = { kind: "wave", token: "", detail: "d", approved: false });
  bad("evidence unknown phase key", m => m.evidence = { launch: { outcome: "passed", detail: "", at: "t" } });
  bad("evidence bad outcome", m => m.evidence = { plan: { outcome: "won", detail: "", at: "t" } });
  bad("scopes empty bead id", m => m.scopes = { "": ["f"] });
  bad("scopes non-string paths", m => m.scopes = { b: [42] });
  bad("review round 0", m => m.reviews = [{ round: 0, revision: "r", model: "m", summary: "s", findings: [], at: "t" }]);
  bad("finding line 0", m => m.reviews = [{ round: 1, revision: "r", model: "m", summary: "s", at: "t", findings: [{ id: "f", severity: "high", path: "p", line: 0, title: "t", body: "b" }] }]);
  bad("finding bad severity", m => m.reviews = [{ round: 1, revision: "r", model: "m", summary: "s", at: "t", findings: [{ id: "f", severity: "info", path: "p", line: 1, title: "t", body: "b" }] }]);
  bad("finding fractional line", m => m.reviews = [{ round: 1, revision: "r", model: "m", summary: "s", at: "t", findings: [{ id: "f", severity: "low", path: "p", line: 1.5, title: "t", body: "b" }] }]);
  bad("github source missing repo", m => m.source = { kind: "github", id: "g", title: "t", body: "", comments: "", extra: "", number: 1 });
  bad("github source missing number", m => m.source = { kind: "github", id: "g", title: "t", body: "", comments: "", extra: "", repo: "a/b" });
  bad("source number 0", m => (m.source as Hostile).number = 0);
  bad("workspace delivery bogus", m => (m.workspace as Hostile).delivery = "shipit");
  bad("empty controllerNonce", m => m.controllerNonce = "");

  test("path-unsafe mission ids rejected", () => {
    for (const id of ["../x", "a/b", "a b", "", ".x", "x/../y", "ém", "m☃", "-lead"]) {
      expect(() => validateMission({ ...hostile(), id })).toThrow(/Invalid mission state/);
    }
  });
  test("path-unsafe workspace keys rejected", () => {
    for (const key of ["../e", ".hidden", "w☃", "a/b", "a b"]) {
      expect(() => validateMission({ ...hostile(), workspace: { key, cwd: "/t", delivery: "local" } })).toThrow(/unsafe/);
    }
  });
  test("unknown extra keys tolerated, prototype not polluted", () => {
    const raw = JSON.parse(`{"version":1,"id":"m1","__proto__":{"polluted":true},"backdoor":1,"source":{"kind":"freeform","id":"f","title":"t","body":"","comments":"","extra":""},"workspace":{"key":"ws1","cwd":"/t","delivery":"local"},"scopes":{},"phase":"plan","evidence":{},"mode":"auto","keep":false,"reviewRequested":false,"workers":[],"reviews":[],"repairLinks":{},"round":0,"createdAt":"t","updatedAt":"t"}`);
    expect(validateMission(raw).id).toBe("m1");
    expect(({} as Hostile).polluted).toBeUndefined();
  });
});

// ---------------------------------------------------------------- paths
describe("state paths", () => {
  test("missionDirectory rejects traversal keys", () => {
    for (const k of ["a/../b", ".x", "a b", "x/y"]) expect(() => missionDirectory("/tmp/a", k)).toThrow(/workspace key/);
  });
  test("missionPath rejects traversal ids", () => {
    for (const id of ["../evil", "a/b", ".x"]) {
      expect(() => missionPath("/tmp/a", { id, workspace: { key: "ws", cwd: "/", delivery: "local" } })).toThrow(/Invalid mission ID/);
    }
  });
  test("workspaceKey canonicalizes symlinked dirs, yields 24-hex", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const real = join(root, "real"); mkdirSync(real);
    const link = join(root, "link"); symlinkSync(real, link);
    const k1 = await workspaceKey(real);
    expect(k1).toBe(await workspaceKey(link));
    expect(k1).toMatch(/^[0-9a-f]{24}$/);
    await expect(workspaceKey(join(root, "nope"))).rejects.toThrow(/ENOENT/);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- save / load / list
describe("save/load/list", () => {
  test("0600 mode, roundtrip, atomic tmp cleanup on failed rename", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m1.json");
    await saveMission(p, mkMission("m1"));
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect((await loadMission(p)).id).toBe("m1");
    rmSync(p); mkdirSync(p); // directory at the target path forces rename to fail
    await expect(saveMission(p, mkMission("m1"))).rejects.toThrow();
    expect(readdirSync(dir).filter(n => n.endsWith(".tmp")).length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
  test("loadMission rejects truncated/empty/corrupt/unknown-version/oversize", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const p = join(root, "x.json");
    for (const data of ['{"version":1,"id":"x",', "", "{nope"]) {
      writeFileSync(p, data);
      await expect(loadMission(p)).rejects.toThrow(/Cannot load/);
    }
    writeFileSync(p, JSON.stringify({ ...mkMission("x"), version: 2 }));
    await expect(loadMission(p)).rejects.toThrow(/version must be 1/);
    writeFileSync(p, Buffer.alloc(5_000_001, 65));
    await expect(loadMission(p)).rejects.toThrow(/exceeds|Cannot load/);
    rmSync(root, { recursive: true, force: true });
  });
  test("saveMission refuses >5MB valid mission", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const m = mkMission("big");
    m.workers = Array.from({ length: 300 }, (_, i) => ({
      beadId: `b${i}`, attempt: `a${i}`, cwd: "/t", files: ["x".repeat(4000)],
      state: "reserved" as const, assignment: "x".repeat(16000),
    }));
    await expect(saveMission(join(dir, "big.json"), m)).rejects.toThrow(/exceeds/);
    rmSync(root, { recursive: true, force: true });
  });
  test("concurrent saves leave valid file and no tmp litter", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    await Promise.all(Array.from({ length: 20 }, (_, i) => saveMission(p, { ...mkMission("m"), blocker: `b${i}` })));
    expect((await loadMission(p)).id).toBe("m");
    expect(readdirSync(dir).filter(n => n.endsWith(".tmp")).length).toBe(0);
    rmSync(root, { recursive: true, force: true });
  });
  test("listMissions surfaces corrupt file instead of hiding valid ones", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "wk"); mkdirSync(dir, { recursive: true });
    await saveMission(join(dir, "good.json"), mkMission("good", "wk"));
    writeFileSync(join(dir, "bad.json"), "{corrupt");
    await expect(listMissions(root)).rejects.toThrow(/Cannot load/);
    writeFileSync(join(dir, "bad.json"), JSON.stringify(mkMission("different-id", "wk")));
    await expect(listMissions(root)).rejects.toThrow(/identity/);
    rmSync(root, { recursive: true, force: true });
  });
  test("listMissions ignores tmp/non-json leftovers; empty tree -> []", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "wk"); mkdirSync(dir, { recursive: true });
    await saveMission(join(dir, "good.json"), mkMission("good", "wk"));
    writeFileSync(join(dir, ".good.deadbeef.tmp"), "junk");
    writeFileSync(join(dir, "note.txt"), "junk");
    expect((await listMissions(root)).map(x => x.mission.id)).toEqual(["good"]);
    expect(await listMissions(join(root, "absent"))).toEqual([]);
    rmSync(root, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------- ownership
describe("acquireOwnership", () => {
  test("two competing controllers: second gets ELOCKED", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    const o1 = await acquireOwnership(p, mkMission("m"));
    await expect(acquireOwnership(p, mkMission("m"))).rejects.toMatchObject({ code: "ELOCKED" });
    await o1.release();
    const o2 = await acquireOwnership(p, mkMission("m"));
    expect(o2.nonce).not.toBe(o1.nonce);
    await o2.release();
    rmSync(root, { recursive: true, force: true });
  });
  test("cross-process exclusion via bun child", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const childFile = join(root, "child.ts");
    writeFileSync(childFile, [
      `import { acquireOwnership } from ${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))};`,
      "await acquireOwnership(process.argv[2], JSON.parse(process.argv[3]));",
      'console.log("ACQUIRED");',
      "setInterval(() => {}, 60000);", // keep process alive; parent kills it
    ].join("\n"));
    const p = join(dir, "m.json");
    const proc = Bun.spawn([process.execPath, childFile, p, JSON.stringify(mkMission("m"))], { stdout: "pipe", stderr: "pipe" });
    try {
      // Real subprocess startup cannot be faked; poll its stdout for the acquisition marker.
      const decoder = new TextDecoder();
      const reader = (proc.stdout as ReadableStream<Uint8Array>).getReader();
      let out = "";
      const deadline = Date.now() + 15_000;
      while (!out.includes("ACQUIRED") && Date.now() < deadline) {
        const { done, value } = await Promise.race([reader.read(), delay(500).then(() => ({ done: false, value: undefined }))]);
        if (done) break;
        if (value) out += decoder.decode(value);
      }
      expect(out).toContain("ACQUIRED");
      await expect(acquireOwnership(p, mkMission("m"))).rejects.toMatchObject({ code: "ELOCKED" });
    } finally {
      proc.kill(9);
      await proc.exited;
      rmSync(root, { recursive: true, force: true });
    }
  });
  test("orphaned lockdir: fresh -> ELOCKED, stale (>30s mtime) -> takeover", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    writeFileSync(p, JSON.stringify(mkMission("m")));
    mkdirSync(p + ".lock");
    await expect(acquireOwnership(p, mkMission("m"))).rejects.toMatchObject({ code: "ELOCKED" });
    // Backdating mtime exercises the stale-takeover path without a real 30s wait.
    utimesSync(p + ".lock", new Date(Date.now() - 31_000), new Date(Date.now() - 31_000));
    const o = await acquireOwnership(p, mkMission("m"));
    expect(o.mission.controllerNonce).toBe(o.nonce);
    await o.release();
    rmSync(root, { recursive: true, force: true });
  });
  test("empty crash-leftover file is adopted by input mission", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    writeFileSync(p, "");
    const o = await acquireOwnership(p, mkMission("m"));
    expect((await loadMission(p)).id).toBe("m");
    await o.release();
    rmSync(root, { recursive: true, force: true });
  });
  test("corrupt file acquire fails and cleans lock", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    writeFileSync(p, "{bad json");
    await expect(acquireOwnership(p, mkMission("m"))).rejects.toThrow(/Cannot load|Invalid/);
    expect(existsSync(p + ".lock")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
  test("identity mismatch (id or key) fails and cleans lock", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    await saveMission(p, mkMission("m"));
    await expect(acquireOwnership(p, mkMission("other"))).rejects.toThrow(/identity/);
    writeFileSync(p, JSON.stringify(mkMission("m", "otherkey"))); // path says ws1, file says otherkey
    await expect(acquireOwnership(p, mkMission("m"))).rejects.toThrow(/identity|Invalid/);
    expect(existsSync(p + ".lock")).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
  test("nonce mismatch after foreign overwrite -> assertOwned fails", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    const o = await acquireOwnership(p, mkMission("m"));
    await saveMission(p, { ...o.mission, controllerNonce: "foreign" });
    await expect(o.assertOwned()).rejects.toThrow(/nonce changed/);
    await o.release();
    rmSync(root, { recursive: true, force: true });
  });
  test("release idempotent and strips nonce", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    const o = await acquireOwnership(p, mkMission("m"));
    await o.release(); await o.release();
    expect(existsSync(p + ".lock")).toBe(false);
    expect((await loadMission(p)).controllerNonce).toBeUndefined();
    await expect(o.assertOwned()).rejects.toThrow(/ownership lost/);
    rmSync(root, { recursive: true, force: true });
  });
  test("two missions same workspace own independently", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const oa = await acquireOwnership(join(dir, "a.json"), mkMission("a"));
    const ob = await acquireOwnership(join(dir, "b.json"), mkMission("b"));
    expect(oa.nonce).not.toBe(ob.nonce);
    await oa.release(); await ob.release();
    rmSync(root, { recursive: true, force: true });
  });
  test("acquire race: exactly one winner", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => acquireOwnership(p, mkMission("m"))));
    const wins = results.filter(r => r.status === "fulfilled");
    expect(wins.length).toBe(1);
    await (wins[0] as PromiseFulfilledResult<Ownership>).value.release();
    rmSync(root, { recursive: true, force: true });
  });
  test("symlinked missions dir still mutually excludes (same physical lock)", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const real = join(root, "real"); mkdirSync(join(real, "missions", "ws1"), { recursive: true });
    const link = join(root, "link"); symlinkSync(real, link);
    const rp = join(real, "missions", "ws1", "m.json");
    const lp = join(link, "missions", "ws1", "m.json");
    const o = await acquireOwnership(rp, mkMission("m"));
    await expect(acquireOwnership(lp, mkMission("m"))).rejects.toMatchObject({ code: "ELOCKED" });
    await o.release();
    rmSync(root, { recursive: true, force: true });
  });
  // Compromise detection latency is proper-lockfile's real 10s heartbeat timer;
  // it cannot be driven by fake timers because the interval lives inside the library.
  test("compromised lock: onCompromised fires, assertOwned holds, no crash", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    const { promise: compromisedPromise, resolve: markCompromised } = Promise.withResolvers<void>();
    let code = "";
    const o = await acquireOwnership(p, mkMission("m"), e => {
      code = (e as NodeJS.ErrnoException).code || e.message;
      markCompromised();
    });
    rmdirSync(p + ".lock");
    await compromisedPromise;
    expect(code).toBe("ECOMPROMISED");
    await expect(o.assertOwned()).rejects.toThrow(/ownership lost/);
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
  // BUG (filed): release() after a compromised lock throws ERELEASED
  // ("Lock is already released") instead of being a clean no-op. extension.ts
  // detach()/attach() call release() unconditionally on session switch/shutdown,
  // so the throw can abort cleanup and leave stale mission state.
  test("release() after compromise should be clean no-op", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const dir = join(root, "missions", "ws1"); mkdirSync(dir, { recursive: true });
    const p = join(dir, "m.json");
    const { promise: compromisedPromise, resolve: markCompromised } = Promise.withResolvers<void>();
    const o = await acquireOwnership(p, mkMission("m"), () => markCompromised());
    rmdirSync(p + ".lock");
    await compromisedPromise;
    await o.release(); // currently throws "Lock is already released"
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
});

// ---------------------------------------------------------------- missionId
describe("missionId mapping", () => {
  test("a fresh run of the same source preserves the completed run", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    try {
      const completed = mkMission("old");
      completed.id = missionId(completed.source);
      completed.phase = "complete";
      const fresh = { ...completed, id: missionId(completed.source), phase: "plan" as const, evidence: {} };
      await saveMission(missionPath(root, completed), completed);
      await saveMission(missionPath(root, fresh), fresh);
      expect((await loadMission(missionPath(root, completed))).phase).toBe("complete");
      expect((await loadMission(missionPath(root, fresh))).phase).toBe("plan");
      expect((await listMissions(root)).map(entry => entry.mission.id).sort()).toEqual([completed.id, fresh.id].sort());
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

});

// ---------------------------------------------------------------- config
describe("mission config", () => {
  test("rejects malformed values", () => {
    for (const v of [
      42, null, [], { version: 2 }, {},
      { version: 1, controls: 1 }, { version: 1, controls: null },
      { version: 1, maxWorkers: 0 }, { version: 1, maxWorkers: 9 },
      { version: 1, maxWorkers: 1.5 }, { version: 1, maxWorkers: null },
      { version: 1, maxWorkers: "3" }, { version: 1, maxWorkers: NaN },
      { version: 1, keys: "x" }, { version: 1, keys: null },
      { version: 1, keys: { expand: "alt+g", fullscreen: "ALT+G" } },
      { version: 1, keys: { expand: "g" } },
      { version: 1, keys: { expand: "super+g" } },
      { version: 1, keys: { expand: "alt+alt+g" } },
      { version: 1, keys: { expand: "alt+" } },
      { version: 1, keys: { expand: "" } },
      { version: 1, keys: { expand: `alt+${"x".repeat(48)}` } },
    ]) {
      expect(() => validateMissionConfig(v)).toThrow(/Invalid mission configuration/);
    }
  });
  test("accepts valid configs; null disables individual chords; upper-case normalized", () => {
    expect(validateMissionConfig({ version: 1 }).keys).toEqual({ expand: "ctrl+shift+m", fullscreen: "ctrl+shift+f", mode: "ctrl+shift+o" });
    const c = validateMissionConfig({ version: 1, maxWorkers: 8, controls: true, keys: { expand: null, mode: "meta+m" } });
    expect(c.maxWorkers).toBe(8);
    expect(c.keys.expand).toBeNull();
    expect(c.keys.mode).toBe("meta+m");
    expect(c.keys.fullscreen).toBe("ctrl+shift+f");
    expect(validateMissionConfig({ version: 1, keys: { expand: "ALT+Q" } }).keys.expand).toBe("alt+q");
  });
  test("readMissionConfig: missing -> defaults; malformed/duplicate/dir -> throws", async () => {
    const root = mkdtempSync(join(tmpdir(), TMP_PREFIX));
    const d = await readMissionConfig(root);
    expect(d.maxWorkers).toBe(2);
    expect(d.controls).toBe(false);
    writeFileSync(join(root, "mission.json"), "{bad");
    await expect(readMissionConfig(root)).rejects.toThrow(/Invalid JSON/);
    writeFileSync(join(root, "mission.json"), JSON.stringify({ version: 1, keys: { expand: "alt+g", mode: "alt+g" } }));
    await expect(readMissionConfig(root)).rejects.toThrow(/distinct/);
    rmSync(join(root, "mission.json")); mkdirSync(join(root, "mission.json"));
    await expect(readMissionConfig(root)).rejects.toThrow(/Cannot read/);
    rmSync(root, { recursive: true, force: true });
  });
  test("resolveAgentDir precedence PI > OMP > ~/.omp/agent", () => {
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "/pi", OMP_AGENT_DIR: "/omp" }, "/h")).toBe("/pi");
    expect(resolveAgentDir({ OMP_AGENT_DIR: "/omp" }, "/h")).toBe("/omp");
    expect(resolveAgentDir({}, "/h")).toBe("/h/.omp/agent");
    expect(resolveAgentDir({ PI_CODING_AGENT_DIR: "  ", OMP_AGENT_DIR: "/omp" }, "/h")).toBe("/omp");
  });
});
