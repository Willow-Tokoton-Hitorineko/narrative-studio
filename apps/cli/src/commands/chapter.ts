import {
  InvalidArgumentError,
  type Actor,
  type RevisionOrigin,
} from '@narrative-studio/contracts';
import {
  commitChapter,
  createChapter,
  exportProject,
  listRevisions,
  openProject,
} from '@narrative-studio/core';
import { rebuildProjection } from '@narrative-studio/projection';
import type { CliContext } from '../context.js';
import { readContent } from '../content.js';
import { flagBool, flagString, requireFlag, type ParsedArgs } from '../flags.js';
import type { CommandResult } from './types.js';

function actorFrom(args: ParsedArgs): Actor {
  return { kind: 'author', id: flagString(args, 'actor') ?? 'local-author' };
}

function originFrom(args: ParsedArgs): RevisionOrigin {
  const origin = flagString(args, 'origin') ?? 'author';
  if (origin !== 'author' && origin !== 'import' && origin !== 'model') {
    throw new InvalidArgumentError('--origin must be author, import, or model', { origin });
  }
  return origin;
}

function syncProjection(
  context: CliContext,
  vaultDir: string,
  projectId: string,
): { ok: boolean; status: string; digest?: string; error?: string } {
  try {
    const result = rebuildProjection({
      vaultDir,
      projectId,
      appDataRoot: context.appDataRoot,
      logger: context.logger,
      now: context.now,
    });
    return { ok: true, status: 'current', digest: result.projection_digest };
  } catch (error) {
    return {
      ok: false,
      status: 'stale',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function commandChapterAdd(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const title = requireFlag(args, 'title');
  const content = readContent(args);
  const result = createChapter({
    vaultDir,
    projectId: context.projectId,
    title,
    volumeId: flagString(args, 'volume') ?? undefined,
    content,
    message: flagString(args, 'message'),
    baseRevision: flagString(args, 'base-revision'),
    actor: actorFrom(args),
    origin: originFrom(args),
    approvalId: flagString(args, 'approval'),
    logger: context.logger,
    now: context.now,
  });
  const projection = syncProjection(context, vaultDir, result.manifest.project_id);
  return {
    data: {
      ok: true,
      chapter_id: result.chapter.chapter_id,
      revision_id: result.revision.revision_id,
      manifest_revision: result.manifest.revision,
      content_hash: result.chapter.content_hash,
      word_count: result.chapter.word_count,
      operation_id: result.operation.operation_id,
      projection,
    },
    human: [
      `Created chapter ${result.chapter.chapter_id} "${result.chapter.title}".`,
      `Revision ${result.revision.revision_id}  ${result.chapter.content_hash}`,
      `Manifest is now ${result.manifest.revision} (${result.chapter.word_count} words).`,
      projection.ok ? 'Local projection updated.' : `Projection not updated: ${projection.error}`,
    ],
  };
}

export function commandCommit(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const chapterId = requireFlag(args, 'chapter', 'chapter id');
  const content = readContent(args);
  const result = commitChapter({
    vaultDir,
    projectId: context.projectId,
    chapterId,
    content,
    message: flagString(args, 'message'),
    baseRevision: flagString(args, 'base-revision'),
    actor: actorFrom(args),
    origin: originFrom(args),
    approvalId: flagString(args, 'approval'),
    logger: context.logger,
    now: context.now,
  });
  const projection = syncProjection(context, vaultDir, result.manifest.project_id);
  return {
    data: {
      ok: true,
      chapter_id: chapterId,
      revision_id: result.revision.revision_id,
      previous_revision_id: result.revision.parent_revision_id,
      manifest_revision: result.manifest.revision,
      content_hash: result.revision.content_hash,
      byte_length: result.revision.byte_length,
      line_ending: result.revision.line_ending,
      encoding: result.revision.encoding,
      operation_id: result.operation.operation_id,
      projection,
    },
    human: [
      `Committed ${chapterId} as ${result.revision.revision_id}.`,
      `Manifest is now ${result.manifest.revision}.`,
      `Content hash ${result.revision.content_hash}; ${result.revision.encoding}, ${result.revision.line_ending} line endings.`,
      projection.ok ? 'Local projection updated.' : `Projection not updated: ${projection.error}`,
    ],
  };
}

export function commandHistory(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const chapterId = requireFlag(args, 'chapter');
  const opened = openProject(vaultDir, context.projectId);
  const revisions = listRevisions(opened.projectDir, chapterId);
  if (revisions.length === 0) {
    throw new InvalidArgumentError(`No revisions found for chapter ${chapterId}`);
  }
  return {
    data: { chapter_id: chapterId, revisions },
    human: revisions.map(
      (revision) =>
        `${String(revision.seq).padStart(3, '0')}  ${revision.revision_id}  ${revision.content_hash.slice(0, 19)}…  ${revision.created_at}  ${revision.message ?? ''}`,
    ),
  };
}

export function commandExport(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const outDir = requireFlag(args, 'out', 'export directory');
  const result = exportProject({
    vaultDir,
    projectId: context.projectId,
    outDir,
    includeHistory: !flagBool(args, 'without-history'),
    logger: context.logger,
    now: context.now,
  });
  return {
    data: { ...result },
    human: [
      `Exported ${result.files.length} file(s) of ${result.projectId} at ${result.sourceRevision}.`,
      `Destination: ${result.outDir}`,
      `Verify with: ns verify --vault "${result.outDir}" (export carries its own snapshot manifest)`,
    ],
  };
}
