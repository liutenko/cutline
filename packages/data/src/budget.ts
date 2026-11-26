import { existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export type CallKind = 'assessment' | 'ranking';

export interface Usage {
  date: string; // UTC yyyy-mm-dd
  calls: number;
  byKind: Record<string, number>;
}

export class CournotBudgetError extends Error {}

let processCalls = 0;
export function processCallCount(): number {
  return processCalls;
}
/** For tests only. */
export function resetProcessCalls(): void {
  processCalls = 0;
}

export function dailyMaxFromEnv(): number {
  const n = Number(process.env.COURNOT_DAILY_MAX);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 600;
}

export function usagePath(proofDir: string): string {
  return path.join(proofDir, 'usage.json');
}

export function readUsage(proofDir: string, now: number = Date.now()): Usage {
  const today = new Date(now).toISOString().slice(0, 10);
  try {
    const u = JSON.parse(readFileSync(usagePath(proofDir), 'utf8')) as Usage;
    if (u.date === today) return u;
  } catch {
    // missing or unreadable: start the day at zero
  }
  return { date: today, calls: 0, byKind: {} };
}

/** Cross-process lock: mkdir is atomic. A lock older than 15s is treated as abandoned. */
function withLock<T>(dir: string, fn: () => T): T {
  mkdirSync(dir, { recursive: true });
  const lock = path.join(dir, '.usage.lock');
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      mkdirSync(lock);
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 15_000) rmdirSync(lock);
      } catch {
        // raced with another process
      }
      if (Date.now() > deadline) throw new CournotBudgetError('Could not take the Cournot usage lock; refusing to spend a call');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lock);
    } catch {
      // ignore
    }
  }
}

/**
 * Reserves one billable call. Checks the per-process cap (COURNOT_MAX_CALLS) and the cross-process daily cap
 * (COURNOT_DAILY_MAX, ledger in <proofDir>/usage.json) and records the call BEFORE it is made, because an
 * uncertain failure may still bill.
 */
export function reserveLiveCall(opts: { maxCalls: number; kind: CallKind; proofDir: string; dailyMax?: number; now?: number }): void {
  if (processCalls >= opts.maxCalls) {
    throw new CournotBudgetError(`Live call budget for this process is ${opts.maxCalls} (COURNOT_MAX_CALLS).`);
  }
  const dailyMax = opts.dailyMax ?? dailyMaxFromEnv();
  withLock(opts.proofDir, () => {
    const u = readUsage(opts.proofDir, opts.now);
    if (u.calls >= dailyMax) throw new CournotBudgetError(`Daily Cournot call cap reached: ${u.calls}/${dailyMax} (COURNOT_DAILY_MAX).`);
    u.calls += 1;
    u.byKind[opts.kind] = (u.byKind[opts.kind] ?? 0) + 1;
    const file = usagePath(opts.proofDir);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(u, null, 2) + '\n');
    renameSync(tmp, file);
  });
  processCalls += 1;
}

export function ledgerExists(proofDir: string): boolean {
  return existsSync(usagePath(proofDir));
}
