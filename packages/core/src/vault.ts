/**
 * Portable WritingVault: project discovery, chapter revisions and the
 * author-facing commit API.
 *
 * Layout (relative to the Vault root):
 *   vault.json
 *   <project_id>/project.json
 *   <project_id>/manuscript/<volume_id>/<chapter_id>.md
 *   <project_id>/.story/manifest.json
 *   <project_id>/.story/revisions/<chapter_id>/<revision_id>.{md,json}
 *   <project_id>/.story/operations/operations.jsonl
 *   <project_id>/.story/approvals/approvals.jsonl
 *   <project_id>/.story/journal|staging|rollback|proposals|audit/
 *
 * `vault.json` is a descriptor only; the authoritative project list is derived
 * by scanning for `project.json`, so a crash cannot desynchronise a registry.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  AlreadyExistsError,
  CasMismatchError,
  CorruptionError,
  ID_PATTERNS,
  InvalidArgumentError,
  NotFoundError,
  SCHEMA_VERSION,
  UnauthorizedError,
  assertContract,
  chapterIdFor,
  contentDigest,
  decodeUtf8Strict,
  encodeUtf8,
  matchesIdPattern,
  newProjectId,
  newVaultId,
  operationIdFor,
  revisionIdFor,
  textStats,
  wordCount,
  type Actor,
  type Approval,
  type Chapter,
  type Manifest,
  type ManifestChapterEntry,
  type Operation,
  type Project,
  type Revision,
  type RevisionOrigin,
  type VaultDescriptor,
} from '@narrative-studio/contracts';
import {
  APP_VERSION,
  APPROVALS_REL_PATH,
  DEFAULT_LANGUAGE,
  DEFAULT_VOLUME_ID,
  LIMITS,
  OPERATIONS_REL_PATH,
  PROJECT_FILE,
  STORY_DIR,
  VAULT_FILE,
} from './constants.js';
import {
  ensureDir,
  isDirectory,
  listDirectory,
  pathExists,
  readFileBytes,
  writeFileAtomic,
} from './fsx.js';
import { jsonBytes } from './json.js';
import { withProjectLock, type WriterLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import {
  assertSafeSegment,
  isUncPath,
  resolveInside,
  toNativePath,
} from './paths.js';
import { readManifest } from './manifest.js';
import { runTransaction } from './transaction.js';

export interface OpenedProject {
  vaultRoot: string;
  projectDir: string;
  descriptor: VaultDescriptor;
  project: Project;
  manifest: Manifest;
}

export interface ProjectSummary {
  project_id: string;
  title: string;
  revision: string;
  updated_at: string;
  chapter_count: number;
}

export interface OpenedVault {
  vaultRoot: string;
  descriptor: VaultDescriptor;
}

export function vaultDescriptorPath(vaultRoot: string): string {
  return path.join(vaultRoot, VAULT_FILE);
}

export function resolveVaultRoot(vaultDir: string): string {
  if (typeof vaultDir !== 'string' || vaultDir.trim().length === 0) {
    throw new InvalidArgumentError('A Vault directory is required');
  }
  if (isUncPath(vaultDir)) {
    throw new InvalidArgumentError(
      'Gate 0 requires a local Vault directory: network shares cannot provide the single-writer lock guarantees',
      { vaultDir },
    );
  }
  return path.resolve(vaultDir);
}

export function readVaultDescriptor(vaultRoot: string): VaultDescriptor {
  const target = vaultDescriptorPath(vaultRoot);
  if (!pathExists(target)) {
    throw new NotFoundError(`Vault descriptor (${target})`, {
      hint: 'Run `ns init --vault <dir> --title "<title>"` to create a new vault',
    });
  }
  return assertContract<VaultDescriptor>(
    'vaultDescriptor',
    JSON.parse(fs.readFileSync(target, 'utf8')) as unknown,
  );
}

export function openVault(vaultDir: string): OpenedVault {
  const vaultRoot = resolveVaultRoot(vaultDir);
  if (!isDirectory(vaultRoot)) {
    throw new NotFoundError(`Vault directory ${vaultRoot}`);
  }
  return { vaultRoot, descriptor: readVaultDescriptor(vaultRoot) };
}

export function projectDirFor(vaultRoot: string, projectId: string): string {
  if (!matchesIdPattern('project', projectId)) {
    throw new InvalidArgumentError(`Invalid project id: ${projectId}`, { projectId });
  }
  assertSafeSegment(projectId, 'project id');
  return resolveInside(vaultRoot, projectId, 'project directory');
}

export function listProjectSummaries(vaultDir: string): {
  vaultRoot: string;
  projects: ProjectSummary[];
  invalid: { directory: string; error: string }[];
} {
  const { vaultRoot } = openVault(vaultDir);
  const projects: ProjectSummary[] = [];
  const invalid: { directory: string; error: string }[] = [];
  for (const entry of listDirectory(vaultRoot)) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.')) continue;
    if (entry.name === 'backups') continue;
    const projectDir = path.join(vaultRoot, entry.name);
    if (!pathExists(path.join(projectDir, PROJECT_FILE))) continue;
    try {
      const project = readProjectFile(projectDir);
      const manifest = readManifest(projectDir);
      projects.push({
        project_id: project.project_id,
        title: project.title,
        revision: manifest.revision,
        updated_at: manifest.updated_at,
        chapter_count: Object.keys(manifest.chapters).length,
      });
    } catch (error) {
      invalid.push({ directory: entry.name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  projects.sort((a, b) => a.project_id.localeCompare(b.project_id));
  return { vaultRoot, projects, invalid };
}

export function openProject(vaultDir: string, projectId?: string | null): OpenedProject {
  const vaultRoot = resolveVaultRoot(vaultDir);
  const descriptor = readVaultDescriptor(vaultRoot);

  let selected = projectId ?? null;
  if (selected === null) {
    const summaries = listProjectSummaries(vaultRoot).projects;
    if (summaries.length === 0) {
      throw new NotFoundError('A project in the Vault', { vaultRoot });
    }
    if (summaries.length > 1) {
      throw new InvalidArgumentError('The Vault contains multiple projects; pass --project <id>', {
        vaultRoot,
        projects: summaries.map((summary) => summary.project_id),
      });
    }
    const only = summaries[0];
    if (!only) throw new NotFoundError('A project in the Vault', { vaultRoot });
    selected = only.project_id;
  }

  const projectDir = projectDirFor(vaultRoot, selected);
  if (!pathExists(projectDir)) {
    throw new NotFoundError(`Project ${selected}`, { vaultRoot });
  }
  const project = readProjectFile(projectDir);
  const manifest = readManifest(projectDir);
  if (project.project_id !== manifest.project_id) {
    throw new InvalidArgumentError('project.json and manifest disagree about project_id', {
      projectId: project.project_id,
      manifestProjectId: manifest.project_id,
    });
  }
  return { vaultRoot, projectDir, descriptor, project, manifest };
}

export function readProjectFile(projectDir: string): Project {
  const target = toNativePath(projectDir, PROJECT_FILE);
  if (!pathExists(target)) throw new NotFoundError(`Project file (${target})`);
  return assertContract<Project>('project', JSON.parse(fs.readFileSync(target, 'utf8')) as unknown);
}

// ---------------------------------------------------------------------------
// Chapter paths and reads
// ---------------------------------------------------------------------------

export function chapterRelPath(volumeId: string, chapterId: string): string {
  assertSafeSegment(volumeId, 'volume id');
  assertSafeSegment(chapterId, 'chapter id');
  return `manuscript/${volumeId}/${chapterId}.md`;
}

export function revisionRelPaths(
  chapterId: string,
  revisionId: string,
): { body: string; meta: string } {
  assertSafeSegment(chapterId, 'chapter id');
  assertSafeSegment(revisionId, 'revision id');
  return {
    body: `.story/revisions/${chapterId}/${revisionId}.md`,
    meta: `.story/revisions/${chapterId}/${revisionId}.json`,
  };
}

export function readChapterBytes(projectDir: string, chapterId: string): Buffer {
  const manifest = readManifest(projectDir);
  const entry = manifest.chapters[chapterId];
  if (!entry) throw new NotFoundError(`Chapter ${chapterId}`);
  const target = resolveInside(projectDir, entry.path, 'chapter file');
  const bytes = readFileBytes(target);
  if (bytes === null) throw new NotFoundError(`Chapter file for ${chapterId}`, { path: entry.path });
  return bytes;
}

export function readRevision(projectDir: string, chapterId: string, revisionId: string): Revision {
  const { meta } = revisionRelPaths(chapterId, revisionId);
  const target = resolveInside(projectDir, meta, 'revision metadata');
  if (!pathExists(target)) throw new NotFoundError(`Revision ${revisionId}`, { chapterId });
  return assertContract<Revision>(
    'revision',
    JSON.parse(fs.readFileSync(target, 'utf8')) as unknown,
  );
}

export function listRevisions(projectDir: string, chapterId: string): Revision[] {
  assertSafeSegment(chapterId, 'chapter id');
  const directory = resolveInside(projectDir, `.story/revisions/${chapterId}`, 'revision directory');
  const revisions: Revision[] = [];
  for (const entry of listDirectory(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const target = path.join(directory, entry.name);
    revisions.push(
      assertContract<Revision>('revision', JSON.parse(fs.readFileSync(target, 'utf8')) as unknown),
    );
  }
  revisions.sort((a, b) => a.seq - b.seq);
  return revisions;
}

export function readOperations(projectDir: string): Operation[] {
  const target = resolveInside(projectDir, OPERATIONS_REL_PATH, 'operations log');
  const bytes = readFileBytes(target);
  if (bytes === null) return [];
  const text = bytes.toString('utf8');
  const operations: Operation[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CorruptionError(
        `Operations log line ${index + 1} is not valid JSON; run \`ns doctor --repair\``,
        { line: index + 1 },
      );
    }
    operations.push(assertContract<Operation>('operation', parsed));
  }
  return operations;
}

export function readApprovals(projectDir: string): Approval[] {
  const target = resolveInside(projectDir, APPROVALS_REL_PATH, 'approvals log');
  const bytes = readFileBytes(target);
  if (bytes === null) return [];
  const text = bytes.toString('utf8');
  const approvals: Approval[] = [];
  const lines = text.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line === undefined) continue;
    if (line.trim().length === 0) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new CorruptionError(
        `Approvals log line ${index + 1} is not valid JSON; run \`ns doctor --repair\``,
        { line: index + 1 },
      );
    }
    approvals.push(assertContract<Approval>('approval', parsed));
  }
  return approvals;
}

// ---------------------------------------------------------------------------
// Vault / project creation
// ---------------------------------------------------------------------------

export interface InitProjectOptions {
  vaultDir: string;
  title: string;
  description?: string | null;
  language?: string;
  projectId?: string;
  actor?: Actor;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface InitProjectResult {
  opened: OpenedProject;
  operation: Operation;
  txnId: string;
}

export function initProject(options: InitProjectOptions): InitProjectResult {
  const now = options.now ?? (() => new Date());
  const createdAt = now().toISOString();
  const title = options.title.trim();
  if (title.length === 0 || title.length > LIMITS.maxProjectTitleLength) {
    throw new InvalidArgumentError(`Project title must be 1-${LIMITS.maxProjectTitleLength} characters`);
  }
  const vaultRoot = resolveVaultRoot(options.vaultDir);
  if (pathExists(vaultRoot) && !isDirectory(vaultRoot)) {
    throw new InvalidArgumentError(`Vault path exists and is not a directory: ${vaultRoot}`);
  }
  ensureDir(vaultRoot);
  if (pathExists(vaultDescriptorPath(vaultRoot))) {
    throw new AlreadyExistsError('Vault descriptor', {
      hint: 'This directory is already a Narrative Studio Vault',
      vaultRoot,
    });
  }
  const existing = listDirectory(vaultRoot);
  if (existing.length > 0) {
    throw new InvalidArgumentError('A new Vault must be created in an empty directory', {
      vaultRoot,
      entries: existing.map((entry) => entry.name).slice(0, 20),
    });
  }

  const descriptor: VaultDescriptor = {
    schema_version: SCHEMA_VERSION,
    vault_id: newVaultId(),
    kind: 'narrative-studio-vault',
    created_at: createdAt,
    app_version: APP_VERSION,
  };
  assertContract<VaultDescriptor>('vaultDescriptor', descriptor);
  writeFileAtomic(vaultDescriptorPath(vaultRoot), jsonBytes(descriptor));

  const projectId = options.projectId ?? newProjectId();
  if (!matchesIdPattern('project', projectId)) {
    throw new InvalidArgumentError('Project id must match ^prj_[a-z0-9]{8,32}$', { projectId });
  }
  const projectDir = projectDirFor(vaultRoot, projectId);
  if (pathExists(projectDir)) throw new AlreadyExistsError(`Project ${projectId}`, { projectDir });
  ensureDir(toNativePath(projectDir, STORY_DIR));

  const actor: Actor = options.actor ?? { kind: 'author', id: 'local-author' };
  const project: Project = {
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    title,
    description: options.description ?? null,
    language: options.language ?? DEFAULT_LANGUAGE,
    default_volume_id: DEFAULT_VOLUME_ID,
    created_at: createdAt,
    updated_at: createdAt,
    status: 'active',
    provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
  };
  assertContract<Project>('project', project);

  const result = withProjectLock(projectDir, (_lock: WriterLock) => {
    return runTransaction({
      projectDir,
      projectId,
      baseRevision: null,
      allowCreateManifest: true,
      files: [{ relPath: PROJECT_FILE, bytes: jsonBytes(project), mode: 'create' }],
      chapters: {},
      headRevision: null,
      title,
      logger: options.logger ?? null,
      now,
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(1, resultRevision),
        seq: 1,
        project_id: projectId,
        type: 'project.init',
        created_at: createdAt,
        actor,
        base_revision: null,
        result_revision: resultRevision,
        payload: {
          title,
          vault_id: descriptor.vault_id,
          volume_id: DEFAULT_VOLUME_ID,
          language: project.language,
        },
        approval_id: null,
        provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
        status: 'committed',
      }),
    });
  });

  return {
    opened: {
      vaultRoot,
      projectDir,
      descriptor,
      project,
      manifest: result.manifest,
    },
    operation: result.operation,
    txnId: result.txnId,
  };
}

// ---------------------------------------------------------------------------
// Author-facing chapter writes
// ---------------------------------------------------------------------------

export interface ChapterWriteBase {
  vaultDir: string;
  projectId?: string | null;
  actor?: Actor;
  origin?: RevisionOrigin;
  approvalId?: string | null;
  baseRevision?: string | null;
  message?: string | null;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface CreateChapterOptions extends ChapterWriteBase {
  title: string;
  volumeId?: string;
  content: Buffer;
}

export interface CommitChapterOptions extends ChapterWriteBase {
  chapterId: string;
  content: Buffer;
}

export interface ChapterWriteResult {
  opened: OpenedProject;
  projectDir: string;
  chapter: Chapter;
  revision: Revision;
  manifest: Manifest;
  operation: Operation;
  txnId: string;
}

function requireAuthorApproval(
  projectDir: string,
  input: { approvalId: string | null | undefined; chapterId: string; contentHash: string },
): Approval {
  if (!input.approvalId) {
    throw new UnauthorizedError(
      'Model/agent-origin commits require an explicit author approval receipt (ADR-044-03)',
      { chapterId: input.chapterId },
    );
  }
  const approvals = readApprovals(projectDir);
  const approval = approvals.find((candidate) => candidate.approval_id === input.approvalId);
  if (!approval) {
    throw new UnauthorizedError('Approval receipt was not found in this project', {
      approvalId: input.approvalId,
    });
  }
  if (approval.decision !== 'approved' || approval.status !== 'active') {
    throw new UnauthorizedError('Approval receipt is not an active approval', {
      approvalId: input.approvalId,
      decision: approval.decision,
      status: approval.status,
    });
  }
  if (approval.action !== 'commit_chapter') {
    throw new UnauthorizedError('Approval receipt does not authorize a chapter commit', {
      action: approval.action,
    });
  }
  if (approval.actor.kind !== 'author') {
    throw new UnauthorizedError('Only an author action can produce a trusted approval', {
      actor: approval.actor,
    });
  }
  if (approval.scope.chapter_id !== undefined && approval.scope.chapter_id !== input.chapterId) {
    throw new UnauthorizedError('Approval receipt is scoped to a different chapter', {
      expected: approval.scope.chapter_id,
      actual: input.chapterId,
    });
  }
  if (approval.scope.content_hash !== input.contentHash) {
    throw new UnauthorizedError('Approval receipt does not cover this exact content', {
      approved: approval.scope.content_hash,
      actual: input.contentHash,
    });
  }
  const used = readOperations(projectDir).some(
    (operation) => operation.type !== 'approval.record' && operation.approval_id === approval.approval_id,
  );
  if (used) {
    throw new UnauthorizedError('Approval receipt has already been used', {
      approvalId: approval.approval_id,
    });
  }
  return approval;
}

function resolveActor(input: ChapterWriteBase): Actor {
  return input.actor ?? { kind: 'author', id: 'local-author' };
}

function resolveOrigin(input: ChapterWriteBase): RevisionOrigin {
  return input.origin ?? 'author';
}

function needsApproval(actor: Actor, origin: RevisionOrigin, approvalId?: string | null): boolean {
  return origin === 'model' || actor.kind === 'agent' || Boolean(approvalId);
}

function buildRevision(args: {
  projectId: string;
  chapterId: string;
  seq: number;
  parentRevisionId: string | null;
  contentHash: string;
  bytes: Buffer;
  encoding: Revision['encoding'];
  lineEnding: Revision['line_ending'];
  createdAt: string;
  actor: Actor;
  origin: RevisionOrigin;
  message: string | null;
  approvalId: string | null;
}): Revision {
  return assertContract<Revision>('revision', {
    schema_version: SCHEMA_VERSION,
    revision_id: revisionIdFor(args.seq, args.contentHash),
    project_id: args.projectId,
    chapter_id: args.chapterId,
    seq: args.seq,
    parent_revision_id: args.parentRevisionId,
    content_hash: args.contentHash,
    byte_length: args.bytes.length,
    encoding: args.encoding,
    line_ending: args.lineEnding,
    created_at: args.createdAt,
    actor: args.actor,
    origin: args.origin,
    message: args.message,
    approval_id: args.approvalId,
    provenance: {
      source: args.origin === 'model' ? 'model' : args.origin === 'import' ? 'import' : 'author',
      actor_id: args.actor.id,
      tool: 'ns-cli',
    },
    status: 'committed',
  });
}

export function commitChapter(options: CommitChapterOptions): ChapterWriteResult {
  const now = options.now ?? (() => new Date());
  const opened = openProject(options.vaultDir, options.projectId);
  const actor = resolveActor(options);
  const origin = resolveOrigin(options);

  return withProjectLock(opened.projectDir, (): ChapterWriteResult => {
    const manifest = readManifest(opened.projectDir);
    const base = options.baseRevision ?? manifest.revision;
    if (base !== manifest.revision) throw new CasMismatchError(base, manifest.revision);

    const entry = manifest.chapters[options.chapterId];
    if (!entry) throw new NotFoundError(`Chapter ${options.chapterId}`, { projectId: manifest.project_id });

    const decoded = decodeUtf8Strict(options.content);
    const stored = encodeUtf8(decoded.text);
    const contentHash = contentDigest(stored);
    const approval = needsApproval(actor, origin, options.approvalId)
      ? requireAuthorApproval(opened.projectDir, {
          approvalId: options.approvalId,
          chapterId: options.chapterId,
          contentHash,
        })
      : null;

    const previous = readRevision(opened.projectDir, options.chapterId, entry.current_revision_id);
    const seq = previous.seq + 1;
    const createdAt = now().toISOString();
    const message = options.message ?? null;
    if (message !== null && message.length > LIMITS.maxMessageLength) {
      throw new InvalidArgumentError(`Commit message must be at most ${LIMITS.maxMessageLength} characters`);
    }

    const revision = buildRevision({
      projectId: manifest.project_id,
      chapterId: options.chapterId,
      seq,
      parentRevisionId: entry.current_revision_id,
      contentHash,
      bytes: stored,
      encoding: decoded.encoding,
      lineEnding: decoded.lineEnding,
      createdAt,
      actor,
      origin,
      message,
      approvalId: approval?.approval_id ?? null,
    });

    const stats = textStats(decoded.text);
    const nextEntry: ManifestChapterEntry = {
      ...entry,
      current_revision_id: revision.revision_id,
      content_hash: contentHash,
      word_count: wordCount(decoded.text),
      revision_seq: seq,
      updated_at: createdAt,
    };
    const chapters = { ...manifest.chapters, [options.chapterId]: nextEntry };
    const paths = revisionRelPaths(options.chapterId, revision.revision_id);
    const chapterRelative = entry.path;

    const result = runTransaction({
      projectDir: opened.projectDir,
      projectId: manifest.project_id,
      baseRevision: manifest.revision,
      files: [
        { relPath: paths.body, bytes: stored, mode: 'create' },
        { relPath: paths.meta, bytes: jsonBytes(revision), mode: 'create' },
        { relPath: chapterRelative, bytes: stored, mode: 'replace' },
      ],
      chapters,
      headRevision: revision.revision_id,
      title: opened.project.title,
      logger: options.logger ?? null,
      now,
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(manifest.seq + 1, resultRevision),
        seq: manifest.seq + 1,
        project_id: manifest.project_id,
        type: 'chapter.commit',
        created_at: createdAt,
        actor,
        base_revision: manifest.revision,
        result_revision: resultRevision,
        payload: {
          chapter_id: options.chapterId,
          revision_id: revision.revision_id,
          previous_revision_id: entry.current_revision_id,
          content_hash: contentHash,
          word_count: wordCount(decoded.text),
          characters: stats.characters,
          line_ending: decoded.lineEnding,
          encoding: decoded.encoding,
          message,
        },
        approval_id: approval?.approval_id ?? null,
        provenance: {
          source: origin === 'model' ? 'model' : origin === 'import' ? 'import' : 'author',
          actor_id: actor.id,
          tool: 'ns-cli',
        },
        status: 'committed',
      }),
    });

    const chapter: Chapter = assertContract<Chapter>('chapter', {
      schema_version: SCHEMA_VERSION,
      chapter_id: options.chapterId,
      project_id: manifest.project_id,
      volume_id: entry.volume_id,
      title: entry.title,
      ordinal: entry.ordinal,
      current_revision_id: revision.revision_id,
      content_hash: contentHash,
      word_count: wordCount(decoded.text),
      created_at: entry.created_at,
      updated_at: createdAt,
      provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
      status: 'committed',
    });

    return {
      opened: { ...opened, manifest: result.manifest },
      projectDir: opened.projectDir,
      chapter,
      revision,
      manifest: result.manifest,
      operation: result.operation,
      txnId: result.txnId,
    };
  });
}

export function createChapter(options: CreateChapterOptions): ChapterWriteResult {
  const now = options.now ?? (() => new Date());
  const opened = openProject(options.vaultDir, options.projectId);
  const actor = resolveActor(options);
  const origin = resolveOrigin(options);
  const title = options.title.trim();
  if (title.length === 0 || title.length > LIMITS.maxTitleLength) {
    throw new InvalidArgumentError(`Chapter title must be 1-${LIMITS.maxTitleLength} characters`);
  }
  const volumeId = options.volumeId ?? opened.project.default_volume_id;
  if (!ID_PATTERNS.volume.test(volumeId)) {
    throw new InvalidArgumentError('Volume id must match ^vol_[a-z0-9]{6,32}$', { volumeId });
  }

  return withProjectLock(opened.projectDir, (): ChapterWriteResult => {
    const manifest = readManifest(opened.projectDir);
    const base = options.baseRevision ?? manifest.revision;
    if (base !== manifest.revision) throw new CasMismatchError(base, manifest.revision);

    const volumeChapters = Object.values(manifest.chapters).filter(
      (entry: ManifestChapterEntry) => entry.volume_id === volumeId,
    );
    const ordinal = volumeChapters.reduce((max, entry) => Math.max(max, entry.ordinal), 0) + 1;
    const chapterId = chapterIdFor(volumeId, title, ordinal);
    if (manifest.chapters[chapterId]) {
      throw new AlreadyExistsError(`Chapter ${chapterId}`);
    }

    const decoded = decodeUtf8Strict(options.content);
    const stored = encodeUtf8(decoded.text);
    const contentHash = contentDigest(stored);
    const approval = needsApproval(actor, origin, options.approvalId)
      ? requireAuthorApproval(opened.projectDir, {
          approvalId: options.approvalId,
          chapterId,
          contentHash,
        })
      : null;
    const createdAt = now().toISOString();
    const message = options.message ?? null;
    const revision = buildRevision({
      projectId: manifest.project_id,
      chapterId,
      seq: 1,
      parentRevisionId: null,
      contentHash,
      bytes: stored,
      encoding: decoded.encoding,
      lineEnding: decoded.lineEnding,
      createdAt,
      actor,
      origin,
      message,
      approvalId: approval?.approval_id ?? null,
    });
    const chapterRelative = chapterRelPath(volumeId, chapterId);
    const nextEntry: ManifestChapterEntry = {
      chapter_id: chapterId,
      volume_id: volumeId,
      title,
      ordinal,
      current_revision_id: revision.revision_id,
      content_hash: contentHash,
      word_count: wordCount(decoded.text),
      revision_seq: 1,
      path: chapterRelative,
      created_at: createdAt,
      updated_at: createdAt,
    };
    const chapters = { ...manifest.chapters, [chapterId]: nextEntry };
    const paths = revisionRelPaths(chapterId, revision.revision_id);

    const result = runTransaction({
      projectDir: opened.projectDir,
      projectId: manifest.project_id,
      baseRevision: manifest.revision,
      files: [
        { relPath: paths.body, bytes: stored, mode: 'create' },
        { relPath: paths.meta, bytes: jsonBytes(revision), mode: 'create' },
        { relPath: chapterRelative, bytes: stored, mode: 'create' },
      ],
      chapters,
      headRevision: revision.revision_id,
      title: opened.project.title,
      logger: options.logger ?? null,
      now,
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(manifest.seq + 1, resultRevision),
        seq: manifest.seq + 1,
        project_id: manifest.project_id,
        type: 'chapter.create',
        created_at: createdAt,
        actor,
        base_revision: manifest.revision,
        result_revision: resultRevision,
        payload: {
          chapter_id: chapterId,
          volume_id: volumeId,
          title,
          ordinal,
          revision_id: revision.revision_id,
          content_hash: contentHash,
          word_count: wordCount(decoded.text),
          message,
        },
        approval_id: approval?.approval_id ?? null,
        provenance: {
          source: origin === 'model' ? 'model' : origin === 'import' ? 'import' : 'author',
          actor_id: actor.id,
          tool: 'ns-cli',
        },
        status: 'committed',
      }),
    });

    const chapter: Chapter = assertContract<Chapter>('chapter', {
      schema_version: SCHEMA_VERSION,
      chapter_id: chapterId,
      project_id: manifest.project_id,
      volume_id: volumeId,
      title,
      ordinal,
      current_revision_id: revision.revision_id,
      content_hash: contentHash,
      word_count: wordCount(decoded.text),
      created_at: createdAt,
      updated_at: createdAt,
      provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
      status: 'committed',
    });

    return {
      opened: { ...opened, manifest: result.manifest },
      projectDir: opened.projectDir,
      chapter,
      revision,
      manifest: result.manifest,
      operation: result.operation,
      txnId: result.txnId,
    };
  });
}

export function assertProjectIntegrity(projectDir: string): void {
  const manifest = readManifest(projectDir);
  const project = readProjectFile(projectDir);
  if (project.project_id !== manifest.project_id) {
    throw new CorruptionError('project.json and manifest disagree about project_id', {
      projectId: project.project_id,
      manifestProjectId: manifest.project_id,
    });
  }
}
