/**
 * Read-only export of a project to a plain directory.
 *
 * Export never depends on the device-local SQLite projection and never mutates
 * the Vault. Every written file is re-hashed after the copy, and a
 * `snapshot-manifest.json` records the source revision so the export can be
 * verified independently.
 */

import path from 'node:path';
import {
  InvalidArgumentError,
  snapshotIdFor,
} from '@narrative-studio/contracts';
import { ensureDir } from './fsx.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest } from './manifest.js';
import { isPathInside } from './paths.js';
import {
  assertEmptyOrMissingDirectory,
  buildSnapshotManifest,
  collectSourceFiles,
  copyFilesIntoSnapshot,
  writeSnapshotManifest,
  type SourceFileEntry,
} from './snapshot.js';
import { openProject } from './vault.js';
import type { SnapshotManifest } from '@narrative-studio/contracts';

export interface ExportOptions {
  vaultDir: string;
  projectId?: string | null;
  outDir: string;
  includeHistory?: boolean;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface ExportResult {
  outDir: string;
  sourceRevision: string;
  projectId: string;
  files: string[];
  manifest: SnapshotManifest;
}

export function exportProject(options: ExportOptions): ExportResult {
  const now = options.now ?? (() => new Date());
  const opened = openProject(options.vaultDir, options.projectId);
  const outDir = path.resolve(options.outDir);

  if (isPathInside(opened.projectDir, outDir)) {
    throw new InvalidArgumentError('Export directory may not be inside the project being exported', {
      outDir,
      projectDir: opened.projectDir,
    });
  }
  if (isPathInside(outDir, opened.projectDir)) {
    throw new InvalidArgumentError('Export directory may not contain the project being exported', {
      outDir,
      projectDir: opened.projectDir,
    });
  }

  return withProjectLock(opened.projectDir, (): ExportResult => {
    const manifest = readManifest(opened.projectDir);
    const files: SourceFileEntry[] = collectSourceFiles(opened.projectDir, manifest, {
      includeHistory: options.includeHistory ?? true,
    });

    assertEmptyOrMissingDirectory(outDir, 'Export directory');
    ensureDir(outDir);
    copyFilesIntoSnapshot(opened.projectDir, outDir, files);

    const snapshot = buildSnapshotManifest({
      kind: 'export',
      snapshotId: snapshotIdFor('export'),
      projectId: manifest.project_id,
      sourceRevision: manifest.revision,
      files,
      createdAt: now().toISOString(),
    });
    writeSnapshotManifest(outDir, snapshot);
    options.logger?.info('export.completed', {
      project_id: manifest.project_id,
      revision: manifest.revision,
      files: files.length,
      out_dir: outDir,
    });

    return {
      outDir,
      sourceRevision: manifest.revision,
      projectId: manifest.project_id,
      files: files.map((entry) => entry.relPath),
      manifest: snapshot,
    };
  });
}
