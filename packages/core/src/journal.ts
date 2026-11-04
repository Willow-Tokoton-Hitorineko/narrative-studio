/**
 * Journal records: the durable intent of an in-flight commit.
 *
 * A journal is written (state PREPARED) before *any* authoritative file is
 * touched, updated to FILES_APPLIED before the rename phase, and to
 * PORTABLE_COMMITTED only after the manifest (the authoritative head) is in
 * place. Recovery can therefore reconstruct exactly what to redo or roll back.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  assertContract,
  type JournalTransaction,
} from '@narrative-studio/contracts';
import {
  AUDIT_DIR,
  JOURNAL_DIR,
  RECOVERY_AUDIT_REL_PATH,
  ROLLBACK_DIR,
  STAGING_DIR,
} from './constants.js';
import { ensureDir, listDirectory, pathExists, removePath, writeFileAtomic } from './fsx.js';
import { jsonBytes, readJsonFile } from './json.js';
import { assertSafeSegment, resolveInside, toNativePath } from './paths.js';

export interface JournalRecord {
  file: string;
  txn: JournalTransaction;
}

export function journalDirectory(projectDir: string): string {
  return toNativePath(projectDir, JOURNAL_DIR);
}

export function journalFilePath(projectDir: string, txnId: string): string {
  assertSafeSegment(txnId, 'transaction id');
  return resolveInside(projectDir, `${JOURNAL_DIR}/${txnId}.json`, 'journal path');
}

export function writeJournal(projectDir: string, txn: JournalTransaction): void {
  assertContract<JournalTransaction>('journal', txn);
  writeFileAtomic(journalFilePath(projectDir, txn.txn_id), jsonBytes(txn));
}

export function readJournal(file: string): JournalTransaction {
  const parsed = readJsonFile(file, 'Journal') as JournalTransaction;
  return assertContract<JournalTransaction>('journal', parsed);
}

export function listJournals(projectDir: string): JournalRecord[] {
  const directory = journalDirectory(projectDir);
  const records: JournalRecord[] = [];
  for (const entry of listDirectory(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const file = path.join(directory, entry.name);
    records.push({ file, txn: readJournal(file) });
  }
  records.sort((a, b) => (a.txn.created_at < b.txn.created_at ? -1 : a.txn.created_at > b.txn.created_at ? 1 : 0));
  return records;
}

export function hasPendingJournals(projectDir: string): boolean {
  return listJournals(projectDir).some(
    (record) =>
      record.txn.state === 'PREPARED' ||
      record.txn.state === 'FILES_APPLIED' ||
      record.txn.state === 'PORTABLE_COMMITTED' ||
      record.txn.state === 'ROLLED_BACK',
  );
}

export function removeJournal(projectDir: string, txnId: string): void {
  removePath(journalFilePath(projectDir, txnId));
}

export function stagingDirectory(projectDir: string, txnId: string): string {
  assertSafeSegment(txnId, 'transaction id');
  return resolveInside(projectDir, `${STAGING_DIR}/${txnId}`, 'staging dir');
}

export function rollbackDirectory(projectDir: string, txnId: string): string {
  assertSafeSegment(txnId, 'transaction id');
  return resolveInside(projectDir, `${ROLLBACK_DIR}/${txnId}`, 'rollback dir');
}

export function cleanupTransactionArtifacts(projectDir: string, txnId: string): void {
  removePath(stagingDirectory(projectDir, txnId));
  removePath(rollbackDirectory(projectDir, txnId));
  removeJournal(projectDir, txnId);
}

export interface RecoveryAuditEntry {
  ts: string;
  txn_id: string;
  state: string;
  action: 'redo' | 'rollback' | 'finalize' | 'preserve';
  pid: number;
  details: Record<string, unknown>;
}

export function appendRecoveryAudit(projectDir: string, entry: RecoveryAuditEntry): void {
  const target = toNativePath(projectDir, RECOVERY_AUDIT_REL_PATH);
  ensureDir(path.dirname(target));
  fs.appendFileSync(target, `${JSON.stringify(entry)}\n`, 'utf8');
}

export function readRecoveryAudit(projectDir: string): RecoveryAuditEntry[] {
  const target = toNativePath(projectDir, RECOVERY_AUDIT_REL_PATH);
  if (!pathExists(target)) return [];
  const raw = fs.readFileSync(target, 'utf8');
  const entries: RecoveryAuditEntry[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line) as RecoveryAuditEntry);
    } catch {
      /* audit log is append-only diagnostics; skip damaged lines */
    }
  }
  return entries;
}

export function auditDirectoryExists(projectDir: string): boolean {
  return pathExists(toNativePath(projectDir, AUDIT_DIR));
}
