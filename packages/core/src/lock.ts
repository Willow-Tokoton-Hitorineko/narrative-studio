/**
 * Single-writer lock per project.
 *
 * V4.4 allows exactly one active writer per project. The lock is an advisory
 * file created with `O_EXCL`, containing pid/host/creation time so a crashed
 * process can be detected and its stale lock removed explicitly or after a
 * bounded age. It is never silently ignored: a live holder always wins.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { InvalidArgumentError, WriterLockedError } from '@narrative-studio/contracts';
import { LIMITS, LOCK_REL_PATH } from './constants.js';
import { ensureDir, pathExists, removePath, sleepSync } from './fsx.js';
import { toNativePath } from './paths.js';

export interface LockInfo {
  schema_version: 1;
  pid: number;
  host: string;
  created_at: string;
  txn_id: string | null;
  token: string;
}

export interface AcquireLockOptions {
  txnId?: string | null;
  staleAfterMs?: number;
  force?: boolean;
  now?: () => Date;
}

export function lockPathFor(projectDir: string): string {
  return toNativePath(projectDir, LOCK_REL_PATH);
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return false;
    return code === 'EPERM';
  }
}

export interface LockSnapshot {
  info: LockInfo | null;
  corrupt: boolean;
  exists: boolean;
  ageMs: number | null;
  holderAlive: boolean | null;
}

export function readLock(projectDir: string, now: () => Date = () => new Date()): LockSnapshot {
  const target = lockPathFor(projectDir);
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { info: null, corrupt: false, exists: false, ageMs: null, holderAlive: null };
    }
    throw error;
  }
  let ageMs: number | null = null;
  try {
    ageMs = now().getTime() - fs.statSync(target).mtimeMs;
  } catch {
    ageMs = null;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<LockInfo>;
    if (
      typeof parsed.pid !== 'number' ||
      typeof parsed.host !== 'string' ||
      typeof parsed.created_at !== 'string' ||
      typeof parsed.token !== 'string'
    ) {
      return { info: null, corrupt: true, exists: true, ageMs, holderAlive: null };
    }
    const info: LockInfo = {
      schema_version: 1,
      pid: parsed.pid,
      host: parsed.host,
      created_at: parsed.created_at,
      txn_id: parsed.txn_id ?? null,
      token: parsed.token,
    };
    const holderAlive = info.host === os.hostname() ? isProcessAlive(info.pid) : null;
    return { info, corrupt: false, exists: true, ageMs, holderAlive };
  } catch {
    return { info: null, corrupt: true, exists: true, ageMs, holderAlive: null };
  }
}

export class WriterLock {
  readonly projectDir: string;
  readonly info: LockInfo;
  private released = false;

  private constructor(projectDir: string, info: LockInfo) {
    this.projectDir = projectDir;
    this.info = info;
  }

  static acquire(projectDir: string, options: AcquireLockOptions = {}): WriterLock {
    const now = options.now ?? (() => new Date());
    const staleAfterMs = options.staleAfterMs ?? LIMITS.lockStaleAfterMs;
    const directory = path.dirname(lockPathFor(projectDir));
    ensureDir(directory);
    const token = randomBytes(8).toString('hex');

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const info: LockInfo = {
        schema_version: 1,
        pid: process.pid,
        host: os.hostname(),
        created_at: now().toISOString(),
        txn_id: options.txnId ?? null,
        token,
      };
      try {
        const fd = fs.openSync(lockPathFor(projectDir), 'wx');
        try {
          fs.writeFileSync(fd, `${JSON.stringify(info, null, 2)}\n`, 'utf8');
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        return new WriterLock(projectDir, info);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }

      const snapshot = readLock(projectDir, now);
      if (!snapshot.exists) continue;

      const staleReason = staleLockReason(snapshot, staleAfterMs);
      const deadHolder = snapshot.info !== null && snapshot.holderAlive === false;
      const uncertainButOld =
        (snapshot.corrupt || snapshot.info === null) && (snapshot.ageMs ?? 0) >= staleAfterMs;
      if ((staleReason && deadHolder) || (staleReason && uncertainButOld) || (staleReason && options.force)) {
        removePath(lockPathFor(projectDir));
        sleepSync(10);
        continue;
      }

      throw new WriterLockedError(
        staleReason ??
          `Project is already open for writing by pid ${snapshot.info?.pid ?? '?'} on ${snapshot.info?.host ?? '?'}`,
        {
          projectDir,
          lock: snapshot.info,
          corrupt: snapshot.corrupt,
          ageMs: snapshot.ageMs,
          staleReason,
        },
      );
    }

    throw new WriterLockedError('Could not acquire the project writer lock', { projectDir });
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const target = lockPathFor(this.projectDir);
    const snapshot = readLock(this.projectDir);
    if (!snapshot.exists) return;
    if (
      snapshot.info === null ||
      snapshot.info.pid !== process.pid ||
      snapshot.info.token !== this.info.token
    ) {
      throw new WriterLockedError('Refusing to release a lock owned by another process', {
        projectDir: this.projectDir,
        lock: snapshot.info,
      });
    }
    removePath(target);
  }
}

function staleLockReason(snapshot: LockSnapshot, _staleAfterMs: number): string | null {
  if (snapshot.corrupt) return 'Lock file is corrupt';
  if (!snapshot.info) return 'Lock file is unreadable';
  if (snapshot.info.host !== os.hostname()) {
    return `Project is locked by another machine (${snapshot.info.host}, pid ${snapshot.info.pid})`;
  }
  if (snapshot.holderAlive === false) {
    return `Stale writer lock left by dead process ${snapshot.info.pid}`;
  }
  if (snapshot.holderAlive === true) {
    return null;
  }
  return null;
}

export interface BreakLockResult {
  removed: boolean;
  reason: string;
  lock: LockInfo | null;
}

/**
 * Explicit operator action (`ns doctor --repair` / `ns unlock`). Only removes a
 * lock whose holder is provably dead, corrupt, or `force` is requested.
 */
export function breakLock(
  projectDir: string,
  options: { force?: boolean; now?: () => Date } = {},
): BreakLockResult {
  const snapshot = readLock(projectDir, options.now ?? (() => new Date()));
  if (!snapshot.exists) return { removed: false, reason: 'no lock present', lock: null };
  const reason = staleLockReason(snapshot, 0);
  if (reason === null && !options.force) {
    throw new WriterLockedError('Lock is held by a live local process; refusing to break it', {
      lock: snapshot.info,
    });
  }
  if (reason === null && options.force) {
    removePath(lockPathFor(projectDir));
    return { removed: true, reason: 'forced removal of a live lock', lock: snapshot.info };
  }
  removePath(lockPathFor(projectDir));
  return { removed: true, reason: reason ?? 'removed', lock: snapshot.info };
}

export function projectLockHeldByThisProcess(projectDir: string): boolean {
  const snapshot = readLock(projectDir);
  return snapshot.info?.pid === process.pid;
}

export interface WithLockOptions extends AcquireLockOptions {
  logger?: { info: (event: string, fields?: Record<string, unknown>) => void } | null;
}

const heldLocks = new Map<string, { lock: WriterLock; depth: number }>();

function lockKey(projectDir: string): string {
  return path.resolve(projectDir).toLowerCase();
}

/** Hold the single-writer lock for the duration of a synchronous operation. */
export function withProjectLock<T>(
  projectDir: string,
  action: (lock: WriterLock) => T,
  options: WithLockOptions = {},
): T {
  if (!projectDir) throw new InvalidArgumentError('projectDir is required');
  const key = lockKey(projectDir);
  const existing = heldLocks.get(key);
  if (existing) {
    // Re-entrant call from the same process (e.g. proposal approval → commit):
    // the outer lock stays held and is released exactly once.
    existing.depth += 1;
    try {
      return action(existing.lock);
    } finally {
      existing.depth -= 1;
    }
  }

  const lock = WriterLock.acquire(projectDir, options);
  heldLocks.set(key, { lock, depth: 1 });
  let actionError: unknown = null;
  let result: T | null = null;
  try {
    result = action(lock);
  } catch (error) {
    actionError = error;
  }

  const held = heldLocks.get(key);
  let releaseError: unknown = null;
  if (held && held.lock === lock) {
    heldLocks.delete(key);
    try {
      lock.release();
    } catch (error) {
      releaseError = error;
    }
  }

  if (actionError !== null) {
    if (releaseError !== null) {
      options.logger?.info('lock.release.failed', {
        error: releaseError instanceof Error ? releaseError.message : String(releaseError),
      });
    }
    throw actionError;
  }
  if (releaseError !== null) {
    options.logger?.info('lock.release.failed', {
      error: releaseError instanceof Error ? releaseError.message : String(releaseError),
    });
    throw releaseError;
  }
  return result as T;
}

export function lockTokenForTesting(projectDir: string): string | null {
  const snapshot = readLock(projectDir);
  if (!snapshot.info) return null;
  return createHash('sha256').update(snapshot.info.token).digest('hex').slice(0, 8);
}

export function lockExists(projectDir: string): boolean {
  return pathExists(lockPathFor(projectDir));
}
