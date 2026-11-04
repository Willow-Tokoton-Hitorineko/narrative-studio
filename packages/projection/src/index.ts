/**
 * Device-local SQLite projection.
 *
 * The projection is derived state: it can be deleted at any time and rebuilt
 * from the portable Vault. It is never a source of truth and nothing in the UI
 * may write back into it as if it were canon (ADR-044-01).
 *
 * `node:sqlite` (bundled with Node 24) is used instead of a native addon so the
 * Gate 0 toolchain needs no compiler, no network at install time, and no
 * platform-specific binary (ADR-0004).
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  CorruptionError,
  ProjectionError,
  assertContract,
  sha256Hex,
  stableStringify,
  type Approval,
  type Manifest,
  type Operation,
  type Project,
  type ProjectionStatus,
  type Revision,
} from '@narrative-studio/contracts';
import {
  ensureAppDataRoot,
  hasPendingJournals,
  listJournals,
  listRevisions,
  openProject,
  projectionPaths,
  readApprovals,
  readFileBytes,
  readManifest,
  readOperations,
  readProjectFile,
  resolveAppDataRoot,
  sha256File,
  verifyManifest,
  withProjectLock,
  type SanitizedLogger,
} from '@narrative-studio/core';

export const PROJECTION_SCHEMA_VERSION = 1;

export interface ProjectionCounts {
  chapters: number;
  revisions: number;
  operations: number;
  approvals: number;
}

export interface ProjectionResult {
  database: string;
  project_id: string;
  source_revision: string;
  projection_digest: string;
  counts: ProjectionCounts;
  rebuilt_at: string;
  duration_ms: number;
}

export interface ProjectionRequest {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

const CREATE_SCHEMA = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE projects (
  project_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  language TEXT NOT NULL,
  revision TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE chapters (
  chapter_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  volume_id TEXT NOT NULL,
  title TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  current_revision_id TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  word_count INTEGER NOT NULL,
  path TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE revisions (
  revision_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  chapter_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_revision_id TEXT,
  content_hash TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  encoding TEXT NOT NULL,
  line_ending TEXT NOT NULL,
  origin TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  approval_id TEXT,
  message TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE operations (
  operation_id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  base_revision TEXT,
  result_revision TEXT NOT NULL,
  approval_id TEXT,
  payload_json TEXT NOT NULL
);
CREATE TABLE approvals (
  approval_id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  action TEXT NOT NULL,
  decision TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  note TEXT,
  status TEXT NOT NULL
);
CREATE TABLE projection_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  source_revision TEXT NOT NULL,
  projection_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  computed_at TEXT,
  digest TEXT NOT NULL,
  file_count INTEGER NOT NULL
);
CREATE INDEX idx_chapters_volume ON chapters(volume_id, ordinal);
CREATE INDEX idx_revisions_chapter ON revisions(chapter_id, seq);
CREATE INDEX idx_operations_seq ON operations(seq);
`;

function resolveRoots(request: ProjectionRequest): {
  projectDir: string;
  projectId: string;
  appDataRoot: string;
  vaultRoot: string;
} {
  const opened = openProject(request.vaultDir, request.projectId);
  const appDataRoot = ensureAppDataRoot(resolveAppDataRoot(request.appDataRoot), {
    vaultRoot: opened.vaultRoot,
  }).root;
  return {
    projectDir: opened.projectDir,
    projectId: opened.project.project_id,
    appDataRoot,
    vaultRoot: opened.vaultRoot,
  };
}

function assertProjectionSafe(projectDir: string): void {
  if (hasPendingJournals(projectDir)) {
    const pending = listJournals(projectDir).map((record) => `${record.txn.txn_id}:${record.txn.state}`);
    throw new CorruptionError('Refusing to rebuild a projection while a commit journal is pending', {
      pending,
      hint: 'Run `ns recover` or `ns doctor --repair` first',
    });
  }
}

function collectRevisions(projectDir: string, manifest: Manifest): Revision[] {
  const revisions: Revision[] = [];
  const chapterIds = Object.keys(manifest.chapters).sort();
  for (const chapterId of chapterIds) {
    for (const revision of listRevisions(projectDir, chapterId)) {
      revisions.push(revision);
    }
  }
  revisions.sort((a, b) => (a.revision_id < b.revision_id ? -1 : a.revision_id > b.revision_id ? 1 : 0));
  return revisions;
}

interface CanonicalRows {
  project: Project;
  manifest: Manifest;
  revisions: Revision[];
  operations: Operation[];
  approvals: Approval[];
}

export function computeProjectionDigest(rows: CanonicalRows): string {
  return sha256Hex(
    stableStringify({
      projection_schema_version: PROJECTION_SCHEMA_VERSION,
      project: rows.project,
      manifest_revision: rows.manifest.revision,
      manifest_seq: rows.manifest.seq,
      chapters: Object.values(rows.manifest.chapters)
        .map((entry) => ({
          chapter_id: entry.chapter_id,
          volume_id: entry.volume_id,
          title: entry.title,
          ordinal: entry.ordinal,
          current_revision_id: entry.current_revision_id,
          content_hash: entry.content_hash,
          word_count: entry.word_count,
          revision_seq: entry.revision_seq,
          path: entry.path,
          updated_at: entry.updated_at,
        }))
        .sort((a, b) => a.chapter_id.localeCompare(b.chapter_id)),
      revisions: rows.revisions,
      operations: rows.operations,
      approvals: rows.approvals,
    }),
  );
}

export function rebuildProjection(request: ProjectionRequest): ProjectionResult {
  const startedAt = Date.now();
  const now = request.now ?? (() => new Date());
  const { projectDir, projectId, appDataRoot } = resolveRoots(request);
  assertProjectionSafe(projectDir);

  return withProjectLock(projectDir, (): ProjectionResult => {
    const manifest = readManifest(projectDir);
    const verification = verifyManifest(projectDir, manifest);
    if (!verification.ok) {
      throw new CorruptionError('Refusing to project a Vault that fails manifest verification', {
        missing: verification.missing,
        mismatched: verification.mismatched,
      });
    }
    const project = readProjectFile(projectDir);
    const revisions = collectRevisions(projectDir, manifest);
    const operations = readOperations(projectDir);
    const approvals = readApprovals(projectDir);
    const digest = computeProjectionDigest({ project, manifest, revisions, operations, approvals });

    const paths = projectionPaths(appDataRoot, projectId);
    fs.mkdirSync(paths.dir, { recursive: true });
    for (const file of [paths.database, paths.wal, paths.shm]) {
      try {
        fs.rmSync(file, { force: true });
      } catch (error) {
        throw new ProjectionError('Could not remove the previous projection database', {
          file,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    }

    let database: DatabaseSync | null = null;
    try {
      database = new DatabaseSync(paths.database);
      database.exec('PRAGMA journal_mode = WAL');
      database.exec('PRAGMA synchronous = FULL');
      database.exec('PRAGMA foreign_keys = ON');
      database.exec('PRAGMA busy_timeout = 5000');
      database.exec(CREATE_SCHEMA);

      database.exec('BEGIN IMMEDIATE');
      try {
        insertSnapshot(database, project, manifest, revisions, operations, approvals, digest, now().toISOString());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      database.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch (error) {
      throw new ProjectionError('Failed to build the SQLite projection', {
        database: paths.database,
        cause: error instanceof Error ? error.message : String(error),
      });
    } finally {
      database?.close();
    }

    const result: ProjectionResult = {
      database: paths.database,
      project_id: projectId,
      source_revision: manifest.revision,
      projection_digest: digest,
      counts: {
        chapters: Object.keys(manifest.chapters).length,
        revisions: revisions.length,
        operations: operations.length,
        approvals: approvals.length,
      },
      rebuilt_at: now().toISOString(),
      duration_ms: Date.now() - startedAt,
    };
    request.logger?.info('projection.rebuilt', {
      project_id: projectId,
      source_revision: manifest.revision,
      projection_digest: digest,
      files: verification.checked,
      duration_ms: result.duration_ms,
    });
    return result;
  });
}

function insertSnapshot(
  database: DatabaseSync,
  project: Project,
  manifest: Manifest,
  revisions: Revision[],
  operations: Operation[],
  approvals: Approval[],
  digest: string,
  computedAt: string,
): void {
  const meta = database.prepare('INSERT INTO meta(key, value) VALUES (?, ?)');
  meta.run('projection_schema_version', String(PROJECTION_SCHEMA_VERSION));
  meta.run('projection_digest', digest);
  meta.run('source_revision', manifest.revision);
  meta.run('built_at', computedAt);
  meta.run('app_version', '0.1.0');

  database
    .prepare('INSERT INTO projects(project_id, title, language, revision, seq, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(project.project_id, project.title, project.language, manifest.revision, manifest.seq, manifest.updated_at);

  const chapterStatement = database.prepare(
    'INSERT INTO chapters(chapter_id, project_id, volume_id, title, ordinal, current_revision_id, content_hash, word_count, path, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const entry of Object.values(manifest.chapters).sort((a, b) => a.chapter_id.localeCompare(b.chapter_id))) {
    chapterStatement.run(
      entry.chapter_id,
      project.project_id,
      entry.volume_id,
      entry.title,
      entry.ordinal,
      entry.current_revision_id,
      entry.content_hash,
      entry.word_count,
      entry.path,
      entry.updated_at,
    );
  }

  const revisionStatement = database.prepare(
    'INSERT INTO revisions(revision_id, project_id, chapter_id, seq, parent_revision_id, content_hash, byte_length, encoding, line_ending, origin, actor_kind, actor_id, approval_id, message, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const revision of revisions) {
    revisionStatement.run(
      revision.revision_id,
      revision.project_id,
      revision.chapter_id,
      revision.seq,
      revision.parent_revision_id,
      revision.content_hash,
      revision.byte_length,
      revision.encoding,
      revision.line_ending,
      revision.origin,
      revision.actor.kind,
      revision.actor.id,
      revision.approval_id,
      revision.message,
      revision.created_at,
    );
  }

  const operationStatement = database.prepare(
    'INSERT INTO operations(operation_id, seq, project_id, type, created_at, actor_kind, actor_id, base_revision, result_revision, approval_id, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const operation of operations) {
    operationStatement.run(
      operation.operation_id,
      operation.seq,
      operation.project_id,
      operation.type,
      operation.created_at,
      operation.actor.kind,
      operation.actor.id,
      operation.base_revision,
      operation.result_revision,
      operation.approval_id,
      JSON.stringify(operation.payload),
    );
  }

  const approvalStatement = database.prepare(
    'INSERT INTO approvals(approval_id, project_id, created_at, action, decision, actor_kind, actor_id, scope_json, note, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  );
  for (const approval of approvals) {
    approvalStatement.run(
      approval.approval_id,
      approval.project_id,
      approval.created_at,
      approval.action,
      approval.decision,
      approval.actor.kind,
      approval.actor.id,
      JSON.stringify(approval.scope),
      approval.note,
      approval.status,
    );
  }

  database
    .prepare(
      'INSERT INTO projection_status(id, source_revision, projection_revision, status, computed_at, digest, file_count) VALUES (1, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      manifest.revision,
      manifest.revision,
      'current',
      computedAt,
      digest,
      Object.keys(manifest.files).length,
    );
}

export interface ProjectionLookup {
  exists: boolean;
  sourceRevision: string | null;
  projectionRevision: string | null;
  digest: string | null;
  computedAt: string | null;
  database: string;
}

export function readProjectionDatabase(appDataRoot: string, projectId: string): ProjectionLookup {
  const paths = projectionPaths(appDataRoot, projectId);
  if (!fs.existsSync(paths.database)) {
    return {
      exists: false,
      sourceRevision: null,
      projectionRevision: null,
      digest: null,
      computedAt: null,
      database: paths.database,
    };
  }
  let database: DatabaseSync | null = null;
  try {
    database = new DatabaseSync(paths.database, { readOnly: true });
    const row = database
      .prepare('SELECT source_revision, projection_revision, digest, computed_at FROM projection_status WHERE id = 1')
      .get() as
      | { source_revision?: string; projection_revision?: string; digest?: string; computed_at?: string }
      | undefined;
    if (!row) {
      return {
        exists: false,
        sourceRevision: null,
        projectionRevision: null,
        digest: null,
        computedAt: null,
        database: paths.database,
      };
    }
    return {
      exists: true,
      sourceRevision: row.source_revision ?? null,
      projectionRevision: row.projection_revision ?? null,
      digest: row.digest ?? null,
      computedAt: row.computed_at ?? null,
      database: paths.database,
    };
  } catch {
    return {
      exists: false,
      sourceRevision: null,
      projectionRevision: null,
      digest: null,
      computedAt: null,
      database: paths.database,
    };
  } finally {
    database?.close();
  }
}

export function readProjectionStatus(request: ProjectionRequest): ProjectionStatus {
  const opened = openProject(request.vaultDir, request.projectId);
  const appDataRoot = resolveAppDataRoot(request.appDataRoot);
  const lookup = readProjectionDatabase(appDataRoot, opened.project.project_id);
  const manifest = readManifest(opened.projectDir);
  let status: ProjectionStatus['status'] = 'current';
  if (!lookup.exists) status = 'pending';
  else if (lookup.sourceRevision !== manifest.revision) status = 'stale';

  return assertContract<ProjectionStatus>('projectionStatus', {
    schema_version: SCHEMA_VERSION,
    project_id: opened.project.project_id,
    source_revision: manifest.revision,
    projection_revision: lookup.projectionRevision ?? '',
    status,
    computed_at: lookup.computedAt,
    evidence_refs: [`manifest:${manifest.revision}`, `sqlite:${lookup.database}`],
    details: {
      database_exists: lookup.exists,
      projection_digest: lookup.digest,
    },
  });
}

/** Brings the projection up to date only when it is missing or stale. */
export function syncProjection(request: ProjectionRequest): ProjectionResult | null {
  const status = readProjectionStatus(request);
  if (status.status === 'current') return null;
  return rebuildProjection(request);
}

/** Read a chapter's text through the module-level API (no projection needed). */
export function readChapterContent(projectDir: string, relativePath: string): string | null {
  const bytes = readFileBytes(path.join(projectDir, relativePath));
  return bytes ? bytes.toString('utf8') : null;
}

/** Compact integrity check used by `doctor`/tests: every hash recomputed from disk. */
export function projectionFileCount(databasePath: string): number {
  if (!fs.existsSync(databasePath)) return 0;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare('SELECT COUNT(*) AS count FROM chapters').get() as
      | { count?: number }
      | undefined;
    return Number(row?.count ?? 0);
  } finally {
    database.close();
  }
}

export function projectionDigestFromDatabase(databasePath: string): string | null {
  if (!fs.existsSync(databasePath)) return null;
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare("SELECT value FROM meta WHERE key = 'projection_digest'").get() as
      | { value?: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    database.close();
  }
}

export function assertChapterFileHash(projectDir: string, relativePath: string, expected: string): void {
  const bytes = readFileBytes(path.join(projectDir, relativePath));
  if (!bytes) throw new CorruptionError(`Chapter file missing: ${relativePath}`);
  const actual = sha256File(path.join(projectDir, relativePath));
  if (`sha256:${actual}` !== expected) {
    throw new CorruptionError(`Chapter file hash mismatch: ${relativePath}`, { expected, actual });
  }
}
