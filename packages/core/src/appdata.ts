/**
 * Device-local runtime root (AppDataRoot).
 *
 * The portable Vault holds manuscripts, approvals and history; this directory
 * holds disposable SQLite projections, the job queue, caches and sanitized
 * logs. Losing it must never lose a word of the manuscript.
 */

import os from 'node:os';
import path from 'node:path';
import { InvalidArgumentError, matchesIdPattern } from '@narrative-studio/contracts';
import { ensureDir, pathExists, writeFileAtomic, removePath } from './fsx.js';
import { assertLocalFilesystemPath, assertSafeSegment, assertSeparatedRoots } from './paths.js';

export function defaultAppDataRoot(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.length > 0) {
    return path.join(localAppData, 'NarrativeStudio');
  }
  return path.join(os.homedir(), '.narrative-studio');
}

export function resolveAppDataRoot(override?: string | null): string {
  const configured = override ?? process.env.NS_APPDATA_ROOT ?? null;
  const target = configured && configured.trim().length > 0 ? configured : defaultAppDataRoot();
  return assertLocalFilesystemPath(target, 'AppDataRoot');
}

export interface EnsuredAppDataRoot {
  root: string;
  created: boolean;
  writable: true;
}

export function ensureAppDataRoot(root: string, options: { vaultRoot?: string | null } = {}): EnsuredAppDataRoot {
  const resolved = assertLocalFilesystemPath(root, 'AppDataRoot');
  if (options.vaultRoot) assertSeparatedRoots(options.vaultRoot, resolved);

  const existed = pathExists(resolved);
  ensureDir(resolved);

  const probe = path.join(resolved, `.write-probe-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileAtomic(probe, 'ok');
  } catch (error) {
    throw new InvalidArgumentError(`AppDataRoot is not writable: ${resolved}`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  } finally {
    removePath(probe);
  }

  return { root: resolved, created: !existed, writable: true };
}

export function projectRuntimeDir(appDataRoot: string, projectId: string): string {
  if (!matchesIdPattern('project', projectId)) {
    throw new InvalidArgumentError(`Invalid project id: ${projectId}`);
  }
  return path.join(appDataRoot, 'projects', assertSafeSegment(projectId, 'project id'));
}

export function jobsDir(appDataRoot: string, projectId: string | null): string {
  const base = projectId ? projectRuntimeDir(appDataRoot, projectId) : path.join(appDataRoot, 'jobs');
  return path.join(base, 'jobs');
}

export function projectionPaths(
  appDataRoot: string,
  projectId: string,
): { dir: string; database: string; wal: string; shm: string } {
  const dir = projectRuntimeDir(appDataRoot, projectId);
  const database = path.join(dir, 'store.sqlite');
  return { dir, database, wal: `${database}-wal`, shm: `${database}-shm` };
}

export function sanitizedLogsDir(appDataRoot: string): string {
  return path.join(appDataRoot, 'sanitized-logs');
}

export function cacheDir(appDataRoot: string): string {
  return path.join(appDataRoot, 'cache');
}

export function indexPathFor(appDataRoot: string, projectId: string): string {
  return path.join(projectRuntimeDir(appDataRoot, projectId), 'indexes');
}
