/**
 * Durable, conservative filesystem primitives.
 *
 * Design notes (see ADR-0003):
 * - Every authoritative write goes through a temp file in the same directory,
 *   `fsync`s the file, then renames it over the target. Rename over an existing
 *   file is atomic on NTFS; the temp file is on the same volume by construction.
 * - On Windows Node cannot reliably open a directory handle to `fsync` it, so
 *   directory fsync is best effort and reported by `doctor` instead of being
 *   claimed as a guarantee.
 * - Nothing here silently swallows corruption errors: callers decide.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { NarrativeStudioError } from '@narrative-studio/contracts';

export interface FileHashInfo {
  sha256: string;
  size: number;
}

let directoryFsyncSupport: boolean | null = null;

export function pathExists(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch {
    return false;
  }
}

export function isDirectory(target: string): boolean {
  try {
    return fs.lstatSync(target).isDirectory();
  } catch {
    return false;
  }
}

export function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
}

export function readFileBytes(target: string): Buffer | null {
  try {
    return fs.readFileSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function readFileText(target: string): string {
  return fs.readFileSync(target, 'utf8');
}

export function sha256Bytes(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

export function sha256File(target: string): string {
  const hash = createHash('sha256');
  const fd = fs.openSync(target, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    for (;;) {
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytes <= 0) break;
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

export function fileInfo(target: string): FileHashInfo | null {
  try {
    const stat = fs.statSync(target);
    if (!stat.isFile()) return null;
    return { sha256: sha256File(target), size: stat.size };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function sleepSync(milliseconds: number): void {
  if (milliseconds <= 0) return;
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, milliseconds);
}

function writeAllSync(fd: number, data: Uint8Array): void {
  let offset = 0;
  while (offset < data.length) {
    offset += fs.writeSync(fd, data, offset, data.length - offset);
  }
}

function renameWithRetry(from: string, to: string): void {
  let attempt = 0;
  for (;;) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      const transient = code === 'EPERM' || code === 'EBUSY' || code === 'EACCES';
      if (!transient || attempt >= 5) throw error;
      attempt += 1;
      sleepSync(20 * attempt);
    }
  }
}

/** Best-effort durability for directory entries (metadata of a rename). */
export function fsyncDirectoryBestEffort(dir: string): boolean {
  if (directoryFsyncSupport === null) {
    try {
      const fd = fs.openSync(dir, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      directoryFsyncSupport = true;
    } catch {
      directoryFsyncSupport = false;
    }
  }
  if (!directoryFsyncSupport) return false;
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

export function directoryFsyncIsSupported(): boolean {
  if (directoryFsyncSupport === null) {
    const probe = fs.mkdtempSync(path.join(process.env.TEMP ?? process.cwd(), 'ns-fsync-'));
    try {
      fsyncDirectoryBestEffort(probe);
    } finally {
      fs.rmSync(probe, { recursive: true, force: true });
    }
  }
  return directoryFsyncSupport === true;
}

/** fsync an existing file (used after a rename to harden the target). */
export function fsyncFile(target: string): void {
  const fd = fs.openSync(target, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export function writeFileDurable(
  target: string,
  data: Uint8Array | string,
  options: { exclusive?: boolean } = {},
): void {
  ensureDir(path.dirname(target));
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const fd = fs.openSync(target, options.exclusive ? 'wx' : 'w');
  try {
    writeAllSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fsyncDirectoryBestEffort(path.dirname(target));
}

/** Write a temp file, fsync it, then atomically replace the target. */
export function writeFileAtomic(target: string, data: Uint8Array | string): void {
  const dir = path.dirname(target);
  ensureDir(dir);
  const buffer = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  const temp = path.join(dir, `.${path.basename(target)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const fd = fs.openSync(temp, 'wx');
  try {
    writeAllSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    renameWithRetry(temp, target);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      /* temp cleanup is best effort */
    }
    throw error;
  }
  fsyncDirectoryBestEffort(dir);
}

/** Atomically move an already-durable file over the target. */
export function moveFileAtomic(from: string, to: string): void {
  ensureDir(path.dirname(to));
  renameWithRetry(from, to);
  fsyncDirectoryBestEffort(path.dirname(to));
}

/** Copy a file through a durable temp file + atomic replace. */
export function copyFileDurable(from: string, to: string): void {
  const bytes = fs.readFileSync(from);
  writeFileAtomic(to, bytes);
}

export function removePath(target: string): void {
  try {
    fs.rmSync(target, { recursive: true, force: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    throw error;
  }
}

export function listDirectory(target: string): fs.Dirent[] {
  try {
    return fs.readdirSync(target, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
}

/** Walk a directory tree; returns POSIX-style relative file paths, sorted. */
export function walkRelativeFiles(root: string, options: { followSymlinks?: boolean } = {}): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of listDirectory(dir)) {
      const absolute = path.join(dir, entry.name);
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isSymbolicLink()) {
        if (!options.followSymlinks) continue;
        const stat = fs.statSync(absolute);
        if (stat.isDirectory()) walk(absolute, relative);
        else out.push(relative);
      } else if (entry.isDirectory()) {
        walk(absolute, relative);
      } else if (entry.isFile()) {
        out.push(relative);
      }
    }
  };
  walk(root, '');
  out.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return out;
}

export function statOrNull(target: string): fs.Stats | null {
  try {
    return fs.statSync(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function realPathOrNull(target: string): string | null {
  try {
    return fs.realpathSync.native(target);
  } catch {
    return null;
  }
}

export function ioError(message: string, error: unknown, details: Record<string, unknown> = {}): NarrativeStudioError {
  const code = (error as NodeJS.ErrnoException).code;
  const suffix = code ? ` (${code})` : '';
  return new NarrativeStudioError('IO_ERROR', `${message}${suffix}`, {
    ...details,
    code,
    cause: error instanceof Error ? error.message : String(error),
  });
}

export function removeEmptyDir(dir: string): void {
  try {
    fs.rmdirSync(dir);
  } catch {
    /* not empty or already gone */
  }
}
