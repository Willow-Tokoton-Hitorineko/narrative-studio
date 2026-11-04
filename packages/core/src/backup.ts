/**
 * Backup and restore drill.
 *
 * A backup is a verified, self-describing directory snapshot (not a ZIP): every
 * file is copied, re-hashed, and listed in `snapshot-manifest.json`. Restore
 * verifies every hash again and refuses to overwrite an existing project, so a
 * restore either produces exactly the backed-up bytes or fails loudly.
 */

import path from 'node:path';
import {
  CorruptionError,
  InvalidArgumentError,
  NotFoundError,
  SCHEMA_VERSION,
  assertContract,
  newVaultId,
  snapshotIdFor,
  type Manifest,
  type Project,
  type SnapshotManifest,
  type VaultDescriptor,
} from '@narrative-studio/contracts';
import { APP_VERSION, PROJECT_FILE, VAULT_FILE } from './constants.js';
import {
  ensureDir,
  pathExists,
  readFileBytes,
  sha256File,
  writeFileAtomic,
} from './fsx.js';
import { jsonBytes } from './json.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest, verifyManifest } from './manifest.js';
import { assertWithinRoot, isPathInside, resolveInside, toNativePath } from './paths.js';
import {
  assertEmptyOrMissingDirectory,
  buildSnapshotManifest,
  collectSourceFiles,
  copyFilesIntoSnapshot,
  readSnapshotManifest,
  verifySnapshotDirectory,
  writeSnapshotManifest,
  type SnapshotVerification,
  type SourceFileEntry,
} from './snapshot.js';
import { openProject, readProjectFile, resolveVaultRoot } from './vault.js';

export interface BackupOptions {
  vaultDir: string;
  projectId?: string | null;
  destRoot?: string | null;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface BackupResult {
  backupDir: string;
  sourceRevision: string;
  projectId: string;
  files: string[];
  manifest: SnapshotManifest;
  warnings: string[];
}

export function createBackup(options: BackupOptions): BackupResult {
  const now = options.now ?? (() => new Date());
  const opened = openProject(options.vaultDir, options.projectId);
  const destRoot = options.destRoot
    ? path.resolve(options.destRoot)
    : path.join(opened.vaultRoot, 'backups');
  if (isPathInside(opened.projectDir, destRoot)) {
    throw new InvalidArgumentError('Backup destination may not be inside the project', { destRoot });
  }

  return withProjectLock(opened.projectDir, (): BackupResult => {
    const manifest = readManifest(opened.projectDir);
    const files: SourceFileEntry[] = collectSourceFiles(opened.projectDir, manifest, {
      includeHistory: true,
    });
    const warnings: string[] = [];
    if (isPathInside(opened.vaultRoot, destRoot)) {
      warnings.push(
        'This backup is inside the Vault directory tree: it protects against accidental edits and bad commits, but NOT against disk failure, ransomware or losing the whole laptop. Copy it to an independent disk (or an encrypted backup you control) for disaster recovery.',
      );
    }
    const snapshotId = snapshotIdFor('backup');
    const backupDir = path.join(destRoot, `backup-${snapshotId}`);
    if (pathExists(backupDir)) {
      throw new InvalidArgumentError('A backup with this id already exists', { backupDir });
    }
    ensureDir(destRoot);
    copyFilesIntoSnapshot(opened.projectDir, backupDir, files);
    const snapshot = buildSnapshotManifest({
      kind: 'backup',
      snapshotId,
      projectId: manifest.project_id,
      sourceRevision: manifest.revision,
      files,
      createdAt: now().toISOString(),
    });
    writeSnapshotManifest(backupDir, snapshot);
    options.logger?.info('backup.created', {
      project_id: manifest.project_id,
      revision: manifest.revision,
      files: files.length,
      backup_dir: backupDir,
      same_disk_as_vault: warnings.length > 0,
    });
    return {
      backupDir,
      sourceRevision: manifest.revision,
      projectId: manifest.project_id,
      files: files.map((entry) => entry.relPath),
      manifest: snapshot,
      warnings,
    };
  });
}

export function verifyBackup(backupDir: string): SnapshotVerification {
  const verification = verifySnapshotDirectory(path.resolve(backupDir));
  if (verification.manifest.kind !== 'backup' && verification.manifest.kind !== 'export') {
    throw new InvalidArgumentError('Snapshot kind is not a backup or export', {
      kind: verification.manifest.kind,
    });
  }
  return verification;
}

export interface RestoreOptions {
  backupDir: string;
  destVault: string;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface RestoreResult {
  vaultRoot: string;
  projectDir: string;
  project: Project;
  manifest: Manifest;
  snapshot: SnapshotManifest;
}

export function restoreBackup(options: RestoreOptions): RestoreResult {
  const now = options.now ?? (() => new Date());
  const backupDir = path.resolve(options.backupDir);
  const verification = verifyBackup(backupDir);
  if (!verification.ok) {
    throw new CorruptionError('Backup verification failed; refusing to restore', {
      missing: verification.missing,
      mismatched: verification.mismatched,
      digestOk: verification.digestOk,
      backupDir,
    });
  }
  const snapshot = verification.manifest;
  const vaultRoot = resolveVaultRoot(options.destVault);
  const projectId = snapshot.project_id;

  const descriptorPath = path.join(vaultRoot, VAULT_FILE);
  const hasDescriptor = pathExists(descriptorPath);
  if (pathExists(vaultRoot)) {
    if (!hasDescriptor) {
      assertEmptyOrMissingDirectory(vaultRoot, 'Restore destination');
    }
  }
  ensureDir(vaultRoot);

  if (!hasDescriptor) {
    const descriptor: VaultDescriptor = assertContract<VaultDescriptor>('vaultDescriptor', {
      schema_version: SCHEMA_VERSION,
      vault_id: newVaultId(),
      kind: 'narrative-studio-vault',
      created_at: now().toISOString(),
      app_version: APP_VERSION,
    });
    writeFileAtomic(descriptorPath, jsonBytes(descriptor));
  }

  const projectDir = resolveInside(vaultRoot, projectId, 'restore project directory');
  if (pathExists(projectDir)) {
    throw new InvalidArgumentError('Restore destination already contains this project', {
      projectDir,
      hint: 'Restore into a fresh directory to avoid overwriting a manuscript',
    });
  }
  ensureDir(projectDir);

  for (const entry of snapshot.files) {
    const source = resolveInside(backupDir, entry.rel_path, `backup file ${entry.rel_path}`);
    const destination = resolveInside(projectDir, entry.rel_path, `restore file ${entry.rel_path}`);
    assertWithinRoot(projectDir, destination, 'restore path');
    const bytes = readFileBytes(source);
    if (bytes === null) {
      throw new CorruptionError('Backup file disappeared during restore', { relPath: entry.rel_path });
    }
    writeFileAtomic(destination, bytes);
    const copied = sha256File(destination);
    if (copied !== entry.sha256) {
      throw new CorruptionError('Restored file hash mismatch', {
        relPath: entry.rel_path,
        expected: entry.sha256,
        actual: copied,
      });
    }
  }

  const projectFile = toNativePath(projectDir, PROJECT_FILE);
  if (!pathExists(projectFile)) {
    throw new CorruptionError('Restored snapshot has no project.json', { backupDir });
  }
  const project = readProjectFile(projectDir);
  const manifest = readManifest(projectDir);
  const integrity = verifyManifest(projectDir, manifest);
  if (!integrity.ok) {
    throw new CorruptionError('Restored project failed manifest verification', {
      missing: integrity.missing,
      mismatched: integrity.mismatched,
    });
  }
  if (manifest.revision !== snapshot.source_revision) {
    throw new CorruptionError('Restored manifest revision differs from the snapshot revision', {
      expected: snapshot.source_revision,
      actual: manifest.revision,
    });
  }
  if (project.project_id !== projectId) {
    throw new CorruptionError('Restored project id differs from the snapshot project id');
  }

  options.logger?.info('backup.restored', {
    project_id: projectId,
    revision: manifest.revision,
    files: snapshot.files.length,
    vault_root: vaultRoot,
  });

  return { vaultRoot, projectDir, project, manifest, snapshot };
}

export function describeSnapshot(backupDir: string): {
  snapshot: SnapshotManifest;
  ok: boolean;
  missing: string[];
  mismatchedCount: number;
} {
  if (!pathExists(backupDir)) {
    throw new NotFoundError(`Backup directory ${backupDir}`);
  }
  const snapshot = readSnapshotManifest(backupDir);
  const verification = verifySnapshotDirectory(backupDir);
  return {
    snapshot,
    ok: verification.ok,
    missing: verification.missing,
    mismatchedCount: verification.mismatched.length,
  };
}
