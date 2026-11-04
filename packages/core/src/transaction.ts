/**
 * The Story Core transaction engine.
 *
 * One authoritative commit goes through these durable states:
 *
 *   PREPARED            journal + staged copies + rollback copies on disk,
 *                       no authoritative file touched yet
 *     ↓ (journal updated to FILES_APPLIED, then atomic renames)
 *   FILES_APPLIED       content/operation files are in place, manifest is not
 *     ↓ (manifest atomically replaced = the authoritative commit point)
 *   PORTABLE_COMMITTED  manifest head updated; cleanup may be interrupted
 *
 * There is deliberately no claim of ACID across the filesystem and SQLite.
 * The SQLite projection is rebuilt from the Vault afterwards and can always be
 * discarded (ADR-0003).
 */

import os from 'node:os';
import path from 'node:path';
import {
  AlreadyExistsError,
  CasMismatchError,
  CorruptionError,
  InvalidArgumentError,
  NotFoundError,
  assertContract,
  contentDigest,
  newTransactionId,
  sha256Hex,
  type JournalFileEntry,
  type JournalTransaction,
  type Manifest,
  type ManifestChapterEntry,
  type ManifestFileEntry,
  type Operation,
} from '@narrative-studio/contracts';
import {
  MANIFEST_REL_PATH,
  OPERATIONS_REL_PATH,
  ROLLBACK_DIR,
  STAGING_DIR,
} from './constants.js';
import {
  copyFileDurable,
  ensureDir,
  moveFileAtomic,
  readFileBytes,
  removePath,
  sha256File,
  writeFileDurable,
} from './fsx.js';
import { faultInject } from './faults.js';
import {
  removeJournal,
  rollbackDirectory,
  stagingDirectory,
  writeJournal,
} from './journal.js';
import type { SanitizedLogger } from './logging.js';
import {
  buildManifest,
  computeFileEntry,
  computeManifestRevision,
  manifestBytes,
  manifestExists,
  manifestPath,
  readManifest,
} from './manifest.js';
import { assertSafeRelativePath, resolveInside } from './paths.js';

export type TransactionFileMode = 'create' | 'replace' | 'upsert';

export interface TransactionFileInput {
  relPath: string;
  bytes: Buffer;
  mode?: TransactionFileMode;
}

export interface RunTransactionOptions {
  projectDir: string;
  projectId: string;
  /** CAS token the caller observed. `null` is only valid when creating a project. */
  baseRevision: string | null;
  files: TransactionFileInput[];
  chapters: Record<string, ManifestChapterEntry>;
  headRevision: string | null;
  title: string;
  buildOperation: (resultRevision: string) => Operation;
  allowCreateManifest?: boolean;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface TransactionResult {
  manifest: Manifest;
  operation: Operation;
  txnId: string;
  filesApplied: number;
}

interface PreparedFile {
  relPath: string;
  target: string;
  bytes: Buffer;
  beforeHash: string | null;
  afterHash: string;
}

function log(logger: SanitizedLogger | null | undefined, event: string, fields: Record<string, unknown>): void {
  logger?.info(event, fields);
}

export function runTransaction(options: RunTransactionOptions): TransactionResult {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const { projectDir, projectId } = options;

  if (!path.isAbsolute(projectDir)) {
    throw new InvalidArgumentError('projectDir must be an absolute path', { projectDir });
  }

  const creatingManifest = options.allowCreateManifest === true && !manifestExists(projectDir);
  if (creatingManifest && options.files.length === 0) {
    throw new InvalidArgumentError('A project creation transaction needs at least one file');
  }
  const previous = creatingManifest ? null : readManifest(projectDir);
  const expectedBase = previous?.revision ?? null;
  if (options.baseRevision !== expectedBase) {
    throw new CasMismatchError(options.baseRevision, expectedBase, {
      projectId,
      hint: 'Re-read the project status and retry with the current revision',
    });
  }

  const seq = (previous?.seq ?? 0) + 1;
  const opsTarget = resolveInside(projectDir, OPERATIONS_REL_PATH, 'operations log');
  const opsExisting = readFileBytes(opsTarget);
  if (opsExisting && opsExisting.length > 0 && opsExisting[opsExisting.length - 1] !== 0x0a) {
    throw new CorruptionError(
      'The operations log does not end with a newline. Run `ns doctor --repair` before committing.',
      { operationsLog: OPERATIONS_REL_PATH },
    );
  }

  const seen = new Set<string>();
  const preparedFiles: PreparedFile[] = [];
  for (const input of options.files) {
    const relPath = assertSafeRelativePath(input.relPath, 'transaction file');
    if (relPath === MANIFEST_REL_PATH) {
      throw new InvalidArgumentError('The manifest is written by the transaction engine, not by callers');
    }
    if (relPath === OPERATIONS_REL_PATH) {
      throw new InvalidArgumentError('The operations log is appended by the transaction engine');
    }
    if (seen.has(relPath)) {
      throw new InvalidArgumentError(`Duplicate file in one transaction: ${relPath}`, { relPath });
    }
    seen.add(relPath);

    const target = resolveInside(projectDir, relPath, `transaction file ${relPath}`);
    const existing = readFileBytes(target);
    const mode = input.mode ?? 'upsert';
    const bytes = Buffer.from(input.bytes);
    if (mode === 'create' && existing !== null && sha256Hex(existing) !== sha256Hex(bytes)) {
      throw new AlreadyExistsError(`Vault file ${relPath}`, { relPath });
    }
    if (mode === 'replace' && existing === null) {
      throw new NotFoundError(`Vault file ${relPath}`, { relPath });
    }
    preparedFiles.push({
      relPath,
      target,
      bytes,
      beforeHash: existing === null ? null : sha256Hex(existing),
      afterHash: sha256Hex(bytes),
    });
  }

  const nextFiles: Record<string, ManifestFileEntry> = { ...(previous?.files ?? {}) };
  for (const file of preparedFiles) nextFiles[file.relPath] = computeFileEntry(file.relPath, file.bytes);

  // The operation log excludes itself from the digest (the newest operation
  // line embeds the resulting revision token), so the token is computable now.
  const resultRevision = computeManifestRevision({
    seq,
    projectId,
    chapters: options.chapters,
    files: nextFiles,
  });

  const operation = options.buildOperation(resultRevision);
  assertContract<Operation>('operation', operation);
  if (operation.project_id !== projectId) {
    throw new InvalidArgumentError('Operation project_id does not match the transaction', {
      projectId,
      operation,
    });
  }
  if (operation.seq !== seq) {
    throw new InvalidArgumentError('Operation seq does not match the transaction sequence', {
      expected: seq,
      actual: operation.seq,
    });
  }
  if (operation.result_revision !== resultRevision) {
    throw new InvalidArgumentError('Operation result_revision does not match the computed revision', {
      expected: resultRevision,
      actual: operation.result_revision,
    });
  }
  if (operation.base_revision !== expectedBase) {
    throw new InvalidArgumentError('Operation base_revision does not match the CAS token', {
      expected: expectedBase,
      actual: operation.base_revision,
    });
  }

  const opsLine = Buffer.from(`${JSON.stringify(operation)}\n`, 'utf8');
  const nextOps = Buffer.concat([opsExisting ?? Buffer.alloc(0), opsLine]);
  const opsPrepared: PreparedFile = {
    relPath: OPERATIONS_REL_PATH,
    target: opsTarget,
    bytes: nextOps,
    beforeHash: opsExisting === null ? null : sha256Hex(opsExisting),
    afterHash: sha256Hex(nextOps),
  };
  nextFiles[OPERATIONS_REL_PATH] = computeFileEntry(OPERATIONS_REL_PATH, nextOps);

  const manifest = buildManifest({
    projectId,
    title: previous?.title ?? options.title,
    seq,
    headRevision: options.headRevision,
    chapters: options.chapters,
    files: nextFiles,
    createdAt: previous?.created_at ?? createdAt,
    updatedAt: createdAt,
  });
  const manifestData = manifestBytes(manifest);
  const manifestTarget = manifestPath(projectDir);

  const txnId = newTransactionId();
  const stagingDir = stagingDirectory(projectDir, txnId);
  const rollbackDir = rollbackDirectory(projectDir, txnId);
  ensureDir(stagingDir);
  ensureDir(rollbackDir);

  const entries: JournalFileEntry[] = [];
  const stagedTargets: string[] = [];
  const applyQueue: PreparedFile[] = [...preparedFiles, opsPrepared];

  const stageFile = (index: number, file: PreparedFile): JournalFileEntry => {
    const stagedRel = `${STAGING_DIR}/${txnId}/${String(index).padStart(3, '0')}.bin`;
    const stagedAbs = resolveInside(projectDir, stagedRel, 'staged file');
    writeFileDurable(stagedAbs, file.bytes, { exclusive: true });
    const stagedHash = sha256File(stagedAbs);
    if (stagedHash !== file.afterHash) {
      throw new CorruptionError('Staged file hash mismatch right after write', {
        relPath: file.relPath,
        expected: file.afterHash,
        actual: stagedHash,
      });
    }
    let backupRel: string | null = null;
    if (file.beforeHash !== null) {
      backupRel = `${ROLLBACK_DIR}/${txnId}/${String(index).padStart(3, '0')}.bak`;
      const backupAbs = resolveInside(projectDir, backupRel, 'rollback backup');
      copyFileDurable(file.target, backupAbs);
      const backupHash = sha256File(backupAbs);
      if (backupHash !== file.beforeHash) {
        throw new CorruptionError('Rollback backup hash mismatch', {
          relPath: file.relPath,
          expected: file.beforeHash,
          actual: backupHash,
        });
      }
    }
    return {
      rel_path: file.relPath,
      mode: file.beforeHash === null ? 'create' : 'replace',
      before_hash: file.beforeHash,
      after_hash: file.afterHash,
      staged_path: stagedRel,
      backup_path: backupRel,
      size: file.bytes.length,
    };
  };

  for (const file of applyQueue) {
    entries.push(stageFile(entries.length, file));
    stagedTargets.push(file.target);
  }

  const existingManifestBytes = readFileBytes(manifestTarget);
  const manifestEntry: JournalFileEntry = {
    rel_path: MANIFEST_REL_PATH,
    mode: existingManifestBytes === null ? 'create' : 'replace',
    before_hash: existingManifestBytes === null ? null : sha256Hex(existingManifestBytes),
    after_hash: sha256Hex(manifestData),
    staged_path: `${STAGING_DIR}/${txnId}/manifest.json`,
    backup_path: null,
    size: manifestData.length,
  };
  if (manifestEntry.before_hash !== null) {
    manifestEntry.backup_path = `${ROLLBACK_DIR}/${txnId}/manifest.bak`;
    const backupAbs = resolveInside(projectDir, manifestEntry.backup_path, 'manifest rollback backup');
    copyFileDurable(manifestTarget, backupAbs);
    if (sha256File(backupAbs) !== manifestEntry.before_hash) {
      throw new CorruptionError('Manifest rollback backup hash mismatch');
    }
  }
  writeFileDurable(resolveInside(projectDir, manifestEntry.staged_path, 'staged manifest'), manifestData, {
    exclusive: true,
  });
  entries.push(manifestEntry);

  const journal: JournalTransaction = {
    schema_version: 1,
    txn_id: txnId,
    project_id: projectId,
    state: 'PREPARED',
    created_at: createdAt,
    updated_at: createdAt,
    pid: process.pid,
    host: os.hostname(),
    base_revision: expectedBase,
    target_revision: resultRevision,
    operation,
    files: entries,
    manifest_after_hash: manifestEntry.after_hash,
    last_error: null,
    recovered_at: null,
    recovery_action: 'none',
  };
  writeJournal(projectDir, journal);
  log(options.logger, 'transaction.prepared', {
    txn_id: txnId,
    project_id: projectId,
    base_revision: expectedBase,
    target_revision: resultRevision,
    files: entries.length,
  });

  faultInject('prepared');

  journal.state = 'FILES_APPLIED';
  journal.updated_at = now().toISOString();
  writeJournal(projectDir, journal);

  const contentEntries = entries.slice(0, -1);
  for (let index = 0; index < contentEntries.length; index += 1) {
    const entry = contentEntries[index];
    const target = stagedTargets[index];
    if (!entry || !target) throw new CorruptionError('Internal transaction bookkeeping mismatch');
    const stagedAbs = resolveInside(projectDir, entry.staged_path, 'staged file');
    moveFileAtomic(stagedAbs, target);
    const actual = sha256File(target);
    if (actual !== entry.after_hash) {
      throw new CorruptionError('File hash mismatch after atomic replace', {
        relPath: entry.rel_path,
        expected: entry.after_hash,
        actual,
      });
    }
  }

  log(options.logger, 'transaction.files_applied', { txn_id: txnId, files: contentEntries.length });
  faultInject('files_applied');

  moveFileAtomic(resolveInside(projectDir, manifestEntry.staged_path, 'staged manifest'), manifestTarget);
  if (sha256File(manifestTarget) !== manifestEntry.after_hash) {
    throw new CorruptionError('Manifest hash mismatch after atomic replace');
  }
  journal.state = 'PORTABLE_COMMITTED';
  journal.updated_at = now().toISOString();
  writeJournal(projectDir, journal);
  log(options.logger, 'transaction.committed', {
    txn_id: txnId,
    revision: resultRevision,
    operation_id: operation.operation_id,
  });
  faultInject('portable_committed');

  removePath(stagingDir);
  removePath(rollbackDir);
  removeJournal(projectDir, txnId);

  return {
    manifest,
    operation,
    txnId,
    filesApplied: entries.length,
  };
}

/** Convenience: hash of a byte buffer expressed as a content contract hash. */
export function hashContent(bytes: Uint8Array): string {
  return contentDigest(bytes);
}
