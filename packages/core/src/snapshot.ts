/**
 * Verified snapshots: read-only exports and backups share one format so that a
 * restore can prove it reproduced the exact bytes it read.
 */

import path from 'node:path';
import {
  CorruptionError,
  InvalidArgumentError,
  NotFoundError,
  SCHEMA_VERSION,
  assertContract,
  sha256Hex,
  stableStringify,
  type Manifest,
  type SnapshotFileEntry,
  type SnapshotKind,
  type SnapshotManifest,
} from '@narrative-studio/contracts';
import {
  APP_VERSION,
  MANIFEST_REL_PATH,
  SNAPSHOT_MANIFEST_FILE,
} from './constants.js';
import {
  copyFileDurable,
  ensureDir,
  listDirectory,
  pathExists,
  readFileBytes,
  sha256File,
  writeFileAtomic,
} from './fsx.js';
import { jsonBytes } from './json.js';
import { resolveInside } from './paths.js';

export interface SourceFileEntry {
  relPath: string;
  sha256: string;
  size: number;
}

export const SNAPSHOT_HISTORY_PREFIX = '.story/revisions/';

export function collectSourceFiles(
  projectDir: string,
  manifest: Manifest,
  options: { includeHistory?: boolean } = {},
): SourceFileEntry[] {
  const includeHistory = options.includeHistory ?? true;
  const paths = new Set<string>(Object.keys(manifest.files));
  paths.add(MANIFEST_REL_PATH);
  const entries: SourceFileEntry[] = [];
  for (const relPath of [...paths].sort()) {
    if (!includeHistory && relPath.startsWith(SNAPSHOT_HISTORY_PREFIX)) continue;
    const target = resolveInside(projectDir, relPath, `snapshot source ${relPath}`);
    if (!pathExists(target)) {
      throw new CorruptionError(`Authoritative file is missing: ${relPath}`, { relPath });
    }
    const expected = manifest.files[relPath];
    const actual = sha256File(target);
    if (expected && expected.sha256 !== actual) {
      throw new CorruptionError(`Authoritative file hash mismatch: ${relPath}`, {
        relPath,
        expected: expected.sha256,
        actual,
      });
    }
    entries.push({ relPath, sha256: actual, size: readFileBytes(target)?.length ?? 0 });
  }
  return entries;
}

export function snapshotDigest(files: SourceFileEntry[]): string {
  const canonical = [...files]
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map((entry) => ({ rel_path: entry.relPath, sha256: entry.sha256, size: entry.size }));
  return sha256Hex(stableStringify({ files: canonical }));
}

export function buildSnapshotManifest(args: {
  kind: SnapshotKind;
  snapshotId: string;
  projectId: string;
  sourceRevision: string;
  files: SourceFileEntry[];
  createdAt: string;
}): SnapshotManifest {
  const files: SnapshotFileEntry[] = [...args.files]
    .sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0))
    .map((entry) => ({ rel_path: entry.relPath, sha256: entry.sha256, size: entry.size }));
  return assertContract<SnapshotManifest>('snapshotManifest', {
    schema_version: SCHEMA_VERSION,
    snapshot_id: args.snapshotId,
    kind: args.kind,
    project_id: args.projectId,
    created_at: args.createdAt,
    source_revision: args.sourceRevision,
    app_version: APP_VERSION,
    file_count: files.length,
    digest: snapshotDigest(
      files.map((entry) => ({ relPath: entry.rel_path, sha256: entry.sha256, size: entry.size })),
    ),
    files,
  });
}

export function writeSnapshotManifest(directory: string, manifest: SnapshotManifest): void {
  writeFileAtomic(path.join(directory, SNAPSHOT_MANIFEST_FILE), jsonBytes(manifest));
}

export function readSnapshotManifest(directory: string): SnapshotManifest {
  const target = path.join(directory, SNAPSHOT_MANIFEST_FILE);
  if (!pathExists(target)) {
    throw new NotFoundError(`Snapshot manifest (${target})`, {
      hint: 'Point --backup at the directory produced by `ns backup create`',
    });
  }
  return assertContract<SnapshotManifest>(
    'snapshotManifest',
    JSON.parse(readFileBytes(target)?.toString('utf8') ?? '') as unknown,
  );
}

export function copyFilesIntoSnapshot(
  projectDir: string,
  directory: string,
  files: SourceFileEntry[],
): void {
  ensureDir(directory);
  for (const entry of files) {
    const source = resolveInside(projectDir, entry.relPath, `snapshot source ${entry.relPath}`);
    const destination = resolveInside(directory, entry.relPath, `snapshot destination ${entry.relPath}`);
    copyFileDurable(source, destination);
    const copied = sha256File(destination);
    if (copied !== entry.sha256) {
      throw new CorruptionError('Copied file hash mismatch', {
        relPath: entry.relPath,
        expected: entry.sha256,
        actual: copied,
      });
    }
  }
}

export interface SnapshotVerification {
  ok: boolean;
  manifest: SnapshotManifest;
  missing: string[];
  mismatched: { rel_path: string; expected: string; actual: string | null }[];
  extra: string[];
  digestOk: boolean;
}

export function verifySnapshotDirectory(directory: string): SnapshotVerification {
  const manifest = readSnapshotManifest(directory);
  const missing: string[] = [];
  const mismatched: SnapshotVerification['mismatched'] = [];
  for (const entry of manifest.files) {
    const target = resolveInside(directory, entry.rel_path, `snapshot file ${entry.rel_path}`);
    if (!pathExists(target)) {
      missing.push(entry.rel_path);
      continue;
    }
    const actual = sha256File(target);
    if (actual !== entry.sha256) {
      mismatched.push({ rel_path: entry.rel_path, expected: entry.sha256, actual });
    }
  }
  const expectedDigest = snapshotDigest(
    manifest.files.map((entry) => ({ relPath: entry.rel_path, sha256: entry.sha256, size: entry.size })),
  );
  const digestOk = expectedDigest === manifest.digest;
  const known = new Set(manifest.files.map((entry) => entry.rel_path));
  known.add(SNAPSHOT_MANIFEST_FILE);
  const extra: string[] = [];
  for (const entry of listDirectory(directory)) {
    if (entry.isFile() && !known.has(entry.name)) extra.push(entry.name);
  }
  return {
    ok: missing.length === 0 && mismatched.length === 0 && digestOk,
    manifest,
    missing,
    mismatched,
    extra,
    digestOk,
  };
}

export function assertEmptyOrMissingDirectory(directory: string, label: string): void {
  if (!pathExists(directory)) return;
  const entries = listDirectory(directory);
  if (entries.length > 0) {
    throw new InvalidArgumentError(`${label} must be empty or absent`, {
      directory,
      entries: entries.map((entry) => entry.name).slice(0, 20),
    });
  }
}
