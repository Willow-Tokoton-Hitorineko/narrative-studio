/**
 * Read-only project status: the truthful saved state a UI or CLI may show.
 * Projection (SQLite) status is attached by the caller because the projection
 * package sits above Story Core.
 */

import {
  type ManifestChapterEntry,
  type Project,
  type Manifest,
} from '@narrative-studio/contracts';
import { readLock, type LockSnapshot } from './lock.js';
import { readManifest } from './manifest.js';
import { listJournals } from './journal.js';
import { openProject, readApprovals, readOperations } from './vault.js';

export interface ChapterStatus {
  chapter_id: string;
  volume_id: string;
  title: string;
  ordinal: number;
  word_count: number;
  revision_seq: number;
  current_revision_id: string;
  content_hash: string;
  path: string;
  updated_at: string;
}

export interface PendingTransactionStatus {
  txnId: string;
  state: string;
  targetRevision: string;
  createdAt: string;
}

export interface LockStatus {
  exists: boolean;
  heldByLiveProcess: boolean;
  corrupt: boolean;
  pid: number | null;
  host: string | null;
  ageMs: number | null;
}

export interface ProjectStatus {
  vault_root: string;
  project_dir: string;
  project: Project;
  manifest: Manifest;
  chapters: ChapterStatus[];
  chapter_count: number;
  total_word_count: number;
  pending_transactions: PendingTransactionStatus[];
  lock: LockStatus;
  operation_count: number;
  approval_count: number;
  manifest_file_count: number;
  audit_note: string;
}

export interface StatusOptions {
  vaultDir: string;
  projectId?: string | null;
  now?: () => Date;
}

function toChapterStatus(entry: ManifestChapterEntry): ChapterStatus {
  return {
    chapter_id: entry.chapter_id,
    volume_id: entry.volume_id,
    title: entry.title,
    ordinal: entry.ordinal,
    word_count: entry.word_count,
    revision_seq: entry.revision_seq,
    current_revision_id: entry.current_revision_id,
    content_hash: entry.content_hash,
    path: entry.path,
    updated_at: entry.updated_at,
  };
}

function toLockStatus(snapshot: LockSnapshot): LockStatus {
  return {
    exists: snapshot.exists,
    heldByLiveProcess: snapshot.holderAlive === true,
    corrupt: snapshot.corrupt,
    pid: snapshot.info?.pid ?? null,
    host: snapshot.info?.host ?? null,
    ageMs: snapshot.ageMs,
  };
}

export function projectStatus(options: StatusOptions): ProjectStatus {
  const opened = openProject(options.vaultDir, options.projectId);
  const manifest = readManifest(opened.projectDir);
  const chapters = Object.values(manifest.chapters)
    .map(toChapterStatus)
    .sort((a, b) => (a.volume_id === b.volume_id ? a.ordinal - b.ordinal : a.volume_id.localeCompare(b.volume_id)));
  const pending = listJournals(opened.projectDir).map((record) => ({
    txnId: record.txn.txn_id,
    state: record.txn.state,
    targetRevision: record.txn.target_revision,
    createdAt: record.txn.created_at,
  }));
  return {
    vault_root: opened.vaultRoot,
    project_dir: opened.projectDir,
    project: opened.project,
    manifest,
    chapters,
    chapter_count: chapters.length,
    total_word_count: chapters.reduce((sum, chapter) => sum + chapter.word_count, 0),
    pending_transactions: pending,
    lock: toLockStatus(readLock(opened.projectDir, options.now)),
    operation_count: readOperations(opened.projectDir).length,
    approval_count: readApprovals(opened.projectDir).length,
    manifest_file_count: Object.keys(manifest.files).length,
    audit_note: 'SQLite projections are disposable; the Vault manifest is authoritative.',
  };
}
