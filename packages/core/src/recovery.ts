/**
 * Crash recovery for journaled commits.
 *
 * Recovery is deterministic and never invents new content:
 *  - PREPARED            → roll back (nothing authoritative was touched)
 *  - FILES_APPLIED       → redo if every file (incl. manifest) is verifiably in
 *                          place, otherwise roll back from the recorded backups
 *  - PORTABLE_COMMITTED  → finalize/clean up only
 *
 * If a target file matches neither the recorded before nor after hash, recovery
 * refuses to overwrite it (`ROLLBACK_FAILED` / preserve) and reports a
 * corruption instead of guessing.
 */

import { CorruptionError, type JournalFileEntry, type JournalTransaction } from '@narrative-studio/contracts';
import {
  MANIFEST_REL_PATH,
  ROLLBACK_DIR,
  STAGING_DIR,
} from './constants.js';
import {
  copyFileDurable,
  listDirectory,
  moveFileAtomic,
  pathExists,
  removePath,
  sha256File,
} from './fsx.js';
import {
  appendRecoveryAudit,
  cleanupTransactionArtifacts,
  listJournals,
  writeJournal,
} from './journal.js';
import type { SanitizedLogger } from './logging.js';
import { resolveInside, toNativePath } from './paths.js';

export type RecoveryAction = 'redo' | 'rollback' | 'finalize' | 'preserve' | 'none';
export type RecoveryAuditAction = Exclude<RecoveryAction, 'none'>;

export interface RecoveryOutcome {
  txnId: string;
  projectId: string;
  fromState: JournalTransaction['state'];
  action: RecoveryAction;
  ok: boolean;
  filesChecked: number;
  filesRestored: number;
  detail: string;
}

export interface RecoveryReport {
  ok: boolean;
  outcomes: RecoveryOutcome[];
  errors: string[];
}

export interface RecoveryOptions {
  projectDir: string;
  logger?: SanitizedLogger | null;
  now?: () => Date;
  dryRun?: boolean;
}

type FileState = 'after' | 'before' | 'foreign';

function hashOf(projectDir: string, relPath: string): string | null {
  const target = resolveInside(projectDir, relPath, `recovery file ${relPath}`);
  if (!pathExists(target)) return null;
  return sha256File(target);
}

function classify(projectDir: string, entry: JournalFileEntry): FileState {
  const current = hashOf(projectDir, entry.rel_path);
  if (current === entry.after_hash) return 'after';
  if (entry.before_hash === null) {
    if (current === null) return 'before';
    return 'foreign';
  }
  return current === entry.before_hash ? 'before' : 'foreign';
}

function classifyAll(projectDir: string, txn: JournalTransaction): Map<string, FileState> {
  const states = new Map<string, FileState>();
  for (const entry of txn.files) states.set(entry.rel_path, classify(projectDir, entry));
  return states;
}

function entryByPath(txn: JournalTransaction, relPath: string): JournalFileEntry | undefined {
  return txn.files.find((entry) => entry.rel_path === relPath);
}

function restoreBefore(projectDir: string, entry: JournalFileEntry): void {
  const target = resolveInside(projectDir, entry.rel_path, `restore ${entry.rel_path}`);
  if (entry.before_hash === null) {
    if (pathExists(target)) {
      const current = sha256File(target);
      if (current !== entry.after_hash) {
        throw new CorruptionError('Refusing to delete a file that is not the transaction output', {
          relPath: entry.rel_path,
        });
      }
      removePath(target);
    }
    return;
  }
  if (!entry.backup_path) {
    throw new CorruptionError('Journal has no rollback backup for a replaced file', {
      relPath: entry.rel_path,
    });
  }
  const backupAbs = resolveInside(projectDir, entry.backup_path, 'rollback backup');
  if (!pathExists(backupAbs)) {
    throw new CorruptionError('Rollback backup is missing', { relPath: entry.rel_path });
  }
  if (sha256File(backupAbs) !== entry.before_hash) {
    throw new CorruptionError('Rollback backup is corrupt', { relPath: entry.rel_path });
  }
  copyFileDurable(backupAbs, target);
  if (sha256File(target) !== entry.before_hash) {
    throw new CorruptionError('Restored file does not match its recorded hash', {
      relPath: entry.rel_path,
    });
  }
}

function ensureManifestApplied(
  projectDir: string,
  manifestEntry: JournalFileEntry,
): boolean {
  const target = resolveInside(projectDir, MANIFEST_REL_PATH, 'manifest');
  if (pathExists(target) && sha256File(target) === manifestEntry.after_hash) return true;
  const staged = resolveInside(projectDir, manifestEntry.staged_path, 'staged manifest');
  if (!pathExists(staged) || sha256File(staged) !== manifestEntry.after_hash) return false;
  moveFileAtomic(staged, target);
  return sha256File(target) === manifestEntry.after_hash;
}

function setState(
  projectDir: string,
  txn: JournalTransaction,
  state: JournalTransaction['state'],
  action: RecoveryAction,
  now: () => Date,
  error: string | null = null,
): void {
  txn.state = state;
  txn.updated_at = now().toISOString();
  txn.recovered_at = now().toISOString();
  txn.recovery_action = action;
  txn.last_error = error;
  writeJournal(projectDir, txn);
}

function audit(
  projectDir: string,
  txn: JournalTransaction,
  action: RecoveryAuditAction,
  detail: string,
  now: () => Date,
): void {
  appendRecoveryAudit(projectDir, {
    ts: now().toISOString(),
    txn_id: txn.txn_id,
    state: txn.state,
    action,
    pid: process.pid,
    details: { detail, target_revision: txn.target_revision, base_revision: txn.base_revision },
  });
}

export function recoverProject(options: RecoveryOptions): RecoveryReport {
  const now = options.now ?? (() => new Date());
  const { projectDir } = options;
  const outcomes: RecoveryOutcome[] = [];
  const errors: string[] = [];

  const journals = listJournals(projectDir);
  for (const record of journals) {
    const txn = record.txn;
    try {
      const outcome = recoverOne(projectDir, txn, { now, dryRun: options.dryRun === true, logger: options.logger });
      outcomes.push(outcome);
      if (!outcome.ok) errors.push(`${txn.txn_id}: ${outcome.detail}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${txn.txn_id}: ${message}`);
      outcomes.push({
        txnId: txn.txn_id,
        projectId: txn.project_id,
        fromState: txn.state,
        action: 'preserve',
        ok: false,
        filesChecked: txn.files.length,
        filesRestored: 0,
        detail: message,
      });
      options.logger?.error('recovery.failed', {
        txn_id: txn.txn_id,
        error: message,
      });
    }
  }

  return { ok: errors.length === 0, outcomes, errors };
}

interface RecoverOneContext {
  now: () => Date;
  dryRun: boolean;
  logger?: SanitizedLogger | null;
}

function recoverOne(projectDir: string, txn: JournalTransaction, context: RecoverOneContext): RecoveryOutcome {
  const { now, dryRun } = context;
  const base = {
    txnId: txn.txn_id,
    projectId: txn.project_id,
    fromState: txn.state,
    filesChecked: txn.files.length,
  };

  const finish = (
    action: RecoveryAction,
    ok: boolean,
    filesRestored: number,
    detail: string,
  ): RecoveryOutcome => {
    if (!dryRun && ok) {
      cleanupTransactionArtifacts(projectDir, txn.txn_id);
    }
    return { ...base, action, ok, filesRestored, detail };
  };

  if (txn.state === 'ROLLED_BACK') {
    audit(projectDir, txn, 'rollback', 'already rolled back; cleaning artifacts', now);
    return finish('rollback', true, 0, 'already rolled back');
  }

  if (txn.state === 'ROLLBACK_FAILED') {
    return {
      ...base,
      action: 'preserve',
      ok: false,
      filesRestored: 0,
      detail: txn.last_error ?? 'previous rollback failed; manual inspection required',
    };
  }

  if (txn.state === 'PORTABLE_COMMITTED') {
    const states = classifyAll(projectDir, txn);
    const foreign = [...states.entries()].filter(([, state]) => state === 'foreign');
    if (foreign.length > 0) {
      if (!dryRun) {
        setState(projectDir, txn, 'ROLLBACK_FAILED', 'preserve', now, 'foreign content detected after commit');
        audit(projectDir, txn, 'preserve', 'foreign content after PORTABLE_COMMITTED', now);
      }
      return {
        ...base,
        action: 'preserve',
        ok: false,
        filesRestored: 0,
        detail: `foreign content in ${foreign.map(([rel]) => rel).join(', ')}`,
      };
    }
    if (!dryRun) audit(projectDir, txn, 'finalize', 'commit already durable; cleaned staging', now);
    return finish('finalize', true, 0, 'commit was already durable');
  }

  const manifestEntry = entryByPath(txn, MANIFEST_REL_PATH);
  if (!manifestEntry) {
    throw new CorruptionError('Journal is missing its manifest entry', { txnId: txn.txn_id });
  }

  const states = classifyAll(projectDir, txn);
  const foreign = [...states.entries()].filter(([, state]) => state === 'foreign');
  if (foreign.length > 0) {
    if (!dryRun) {
      setState(projectDir, txn, 'ROLLBACK_FAILED', 'preserve', now, 'foreign content detected');
      audit(projectDir, txn, 'preserve', `foreign content in ${foreign.map(([rel]) => rel).join(', ')}`, now);
    }
    return {
      ...base,
      action: 'preserve',
      ok: false,
      filesRestored: 0,
      detail: `foreign content in ${foreign.map(([rel]) => rel).join(', ')} — refusing to overwrite`,
    };
  }

  const contentEntries = txn.files.filter((entry) => entry.rel_path !== MANIFEST_REL_PATH);
  const contentApplied = contentEntries.filter((entry) => states.get(entry.rel_path) === 'after');
  const allContentApplied = contentApplied.length === contentEntries.length;

  if (txn.state === 'PREPARED') {
    if (!dryRun) {
      setState(projectDir, txn, 'ROLLED_BACK', 'rollback', now);
      audit(projectDir, txn, 'rollback', 'transaction had not applied any file', now);
    }
    return finish('rollback', true, 0, 'rolled back a PREPARED transaction (no files were applied)');
  }

  // FILES_APPLIED
  if (allContentApplied) {
    if (dryRun) {
      return { ...base, action: 'redo', ok: true, filesRestored: 0, detail: 'would redo the manifest' };
    }
    const manifestOk = ensureManifestApplied(projectDir, manifestEntry);
    if (!manifestOk) {
      // Manifest cannot be recovered (staged copy lost): fall back to rollback.
      const restored = rollbackAppliedFiles(projectDir, txn, contentApplied);
      setState(projectDir, txn, 'ROLLED_BACK', 'rollback', now, 'manifest staging lost; rolled back');
      audit(projectDir, txn, 'rollback', 'manifest could not be redone; rolled back', now);
      return finish('rollback', true, restored, 'manifest staging was lost; rolled back instead of redo');
    }
    setState(projectDir, txn, 'PORTABLE_COMMITTED', 'redo', now);
    audit(projectDir, txn, 'redo', 'all content files verified; manifest re-applied', now);
    return finish('redo', true, 0, 'redo completed: manifest re-applied from staging');
  }

  if (contentApplied.length === 0) {
    if (!dryRun) {
      setState(projectDir, txn, 'ROLLED_BACK', 'rollback', now);
      audit(projectDir, txn, 'rollback', 'no content file had been applied', now);
    }
    return finish('rollback', true, 0, 'rolled back: no content file had been applied');
  }

  if (dryRun) {
    return {
      ...base,
      action: 'rollback',
      ok: true,
      filesRestored: contentApplied.length,
      detail: `would roll back ${contentApplied.length} of ${contentEntries.length} content files`,
    };
  }

  const restored = rollbackAppliedFiles(projectDir, txn, contentApplied);
  setState(projectDir, txn, 'ROLLED_BACK', 'rollback', now);
  audit(projectDir, txn, 'rollback', `restored ${restored} files from rollback backups`, now);
  return finish('rollback', true, restored, `partially applied transaction rolled back (${restored} files restored)`);
}

function rollbackAppliedFiles(
  projectDir: string,
  txn: JournalTransaction,
  applied: JournalFileEntry[],
): number {
  let restored = 0;
  try {
    for (const entry of applied) {
      restoreBefore(projectDir, entry);
      restored += 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setState(projectDir, txn, 'ROLLBACK_FAILED', 'preserve', () => new Date(), message);
    appendRecoveryAudit(projectDir, {
      ts: new Date().toISOString(),
      txn_id: txn.txn_id,
      state: 'ROLLBACK_FAILED',
      action: 'preserve',
      pid: process.pid,
      details: { error: message, restored },
    });
    throw error;
  }
  // Verify the whole transaction is back to its before state before declaring success.
  for (const entry of txn.files) {
    const current = hashOf(projectDir, entry.rel_path);
    const expected = entry.before_hash;
    if (current !== expected) {
      throw new CorruptionError('Rollback verification failed', {
        relPath: entry.rel_path,
        expected,
        current,
      });
    }
  }
  return restored;
}

export function pendingTransactionCount(projectDir: string): number {
  return listJournals(projectDir).length;
}

export function describePendingTransactions(projectDir: string): { txnId: string; state: string; target: string }[] {
  return listJournals(projectDir).map((record) => ({
    txnId: record.txn.txn_id,
    state: record.txn.state,
    target: record.txn.target_revision,
  }));
}

/** Staging/rollback directories that have no matching journal (crash during cleanup). */
export function listOrphanArtifacts(projectDir: string): string[] {
  const journalIds = new Set(listJournals(projectDir).map((record) => record.txn.txn_id));
  const orphans: string[] = [];
  for (const root of [STAGING_DIR, ROLLBACK_DIR]) {
    const directory = toNativePath(projectDir, root);
    for (const entry of listDirectory(directory)) {
      if (!entry.isDirectory()) continue;
      if (journalIds.has(entry.name)) continue;
      orphans.push(`${root}/${entry.name}`);
    }
  }
  return orphans;
}

/** Removes staging/rollback directories whose journal disappeared (crash during cleanup). */
export function cleanupOrphanArtifacts(projectDir: string): string[] {
  const removed = listOrphanArtifacts(projectDir);
  for (const relative of removed) {
    removePath(toNativePath(projectDir, relative));
  }
  return removed;
}
