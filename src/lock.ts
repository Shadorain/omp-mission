import { mkdir, realpath, rename, rmdir, stat, utimes } from "node:fs/promises";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";

export interface LockOptions {
  stale?: number;
  update?: number;
  realpath?: boolean;
  retries?: number | { retries?: number; minTimeout?: number; maxTimeout?: number };
  lockfilePath?: string;
  onCompromised?: (err: Error) => void;
}

export type ReleaseLock = () => Promise<void>;

export async function lock(file: string, options: LockOptions = {}): Promise<ReleaseLock> {
  const target = options.realpath ? await realpath(file).catch(() => resolve(file)) : resolve(file);
  const lockfilePath = options.lockfilePath ?? `${target}.lock`;
  const stale = Math.max(options.stale ?? 10_000, 2_000);
  const update = Math.max(Math.min(options.update ?? Math.floor(stale / 2), Math.floor(stale / 2)), 1_000);
  const onCompromised = options.onCompromised ?? ((err: Error) => { throw err; });
  const retriesOpt = options.retries;
  const maxRetries = typeof retriesOpt === "number"
    ? Math.max(0, retriesOpt)
    : typeof retriesOpt === "object" && retriesOpt !== null && typeof retriesOpt.retries === "number"
    ? Math.max(0, retriesOpt.retries)
    : 0;
  const minTimeout = typeof retriesOpt === "object" && retriesOpt !== null && typeof retriesOpt.minTimeout === "number"
    ? Math.max(1, retriesOpt.minTimeout)
    : 25;

  async function tryAcquire(): Promise<{ mtime: number }> {
    try {
      await mkdir(lockfilePath);
      const s = await stat(lockfilePath);
      return { mtime: s.mtime.getTime() };
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "EEXIST") throw error;

      // Check if existing lock is stale
      try {
        const s = await stat(lockfilePath);
        if (s.mtime.getTime() < Date.now() - stale) {
          const stalePath = `${lockfilePath}.stale.${randomUUID()}`;
          let renamed = false;
          try {
            await rename(lockfilePath, stalePath);
            renamed = true;
            await rmdir(stalePath);
          } catch (renameErr: unknown) {
            const rError = renameErr as NodeJS.ErrnoException;
            if (rError.code !== "ENOENT") throw rError;
          }
          if (renamed) {
            try {
              await mkdir(lockfilePath);
              const fresh = await stat(lockfilePath);
              return { mtime: fresh.mtime.getTime() };
            } catch (mkdirErr: unknown) {
              const mkdirError = mkdirErr as NodeJS.ErrnoException;
              if (mkdirError.code === "EEXIST") {
                throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: target });
              }
              throw mkdirError;
            }
          }
        }
      } catch (statErr: unknown) {
        const statError = statErr as NodeJS.ErrnoException;
        if (statError.code === "ENOENT") {
          try {
            await mkdir(lockfilePath);
            const fresh = await stat(lockfilePath);
            return { mtime: fresh.mtime.getTime() };
          } catch (mkdirErr: unknown) {
            const mkdirError = mkdirErr as NodeJS.ErrnoException;
            if (mkdirError.code === "EEXIST") {
              throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: target });
            }
            throw mkdirError;
          }
        }
        if (statError.code === "EEXIST" || (statError as NodeJS.ErrnoException & { code?: string }).code === "ELOCKED") {
          throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: target });
        }
        throw statError;
      }

      throw Object.assign(new Error("Lock file is already being held"), { code: "ELOCKED", file: target });
    }
  }

  async function acquireWithRetries(): Promise<{ mtime: number }> {
    let attempts = 0;
    while (true) {
      try {
        return await tryAcquire();
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
        if (error.code === "ELOCKED" && attempts < maxRetries) {
          attempts++;
          await new Promise((resolve) => setTimeout(resolve, minTimeout));
          continue;
        }
        throw err;
      }
    }
  }

  const { mtime: initialMtime } = await acquireWithRetries();

  let held = true;
  let currentMtime = initialMtime;
  let timer: Timer | undefined;

  function scheduleUpdate() {
    if (!held) return;
    timer = setTimeout(async () => {
      if (!held) return;
      try {
        const s = await stat(lockfilePath);
        if (Math.abs(s.mtime.getTime() - currentMtime) > 1000) {
          throw Object.assign(new Error("Unable to update lock within the stale threshold"), { code: "ECOMPROMISED" });
        }
        const now = new Date();
        await utimes(lockfilePath, now, now);
        const fresh = await stat(lockfilePath);
        currentMtime = fresh.mtime.getTime();
        scheduleUpdate();
      } catch (err: unknown) {
        if (!held) return;
        held = false;
        clearTimeout(timer);
        const errObj = Object.assign(
          err instanceof Error ? err : new Error(String(err)),
          { code: "ECOMPROMISED" },
        ) as NodeJS.ErrnoException;
        onCompromised(errObj);
      }
    }, update);
    if (timer.unref) timer.unref();
  }

  scheduleUpdate();

  return async function release(): Promise<void> {
    if (!held) return;
    held = false;
    clearTimeout(timer);
    try {
      await rmdir(lockfilePath);
    } catch (err: unknown) {
      const error = err as NodeJS.ErrnoException;
      if (error.code !== "ENOENT") throw error;
    }
  };
}
