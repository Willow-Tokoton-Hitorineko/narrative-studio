import fs from 'node:fs';
import path from 'node:path';
import {
  initProject,
  importManuscript,
  openProject,
  pathExists,
  readFileBytes,
  resolveInside,
} from '@narrative-studio/core';
import { rebuildProjection } from '@narrative-studio/projection';
import type { CliContext } from '../context.js';
import { flagString, requireFlag, type ParsedArgs } from '../flags.js';
import type { CommandResult } from './types.js';

function ensureProject(
  vaultDir: string,
  context: CliContext,
  title: string | null,
): ReturnType<typeof openProject> {
  const descriptor = path.join(vaultDir, 'vault.json');
  if (!pathExists(descriptor)) {
    const result = initProject({
      vaultDir,
      title: title ?? 'Imported manuscript',
      logger: context.logger,
      now: context.now,
    });
    return result.opened;
  }
  return openProject(vaultDir, context.projectId ?? undefined);
}

export function commandImport(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const file = requireFlag(args, 'file', 'UTF-8/UTF-16/GB18030 manuscript file');
  const sourceBytes = fs.readFileSync(file);
  const opened = ensureProject(vaultDir, context, flagString(args, 'title'));
  const result = importManuscript({
    projectDir: opened.projectDir,
    sourceBytes,
    sourceFilename: path.basename(file),
    actor: { kind: 'author', id: flagString(args, 'actor') ?? 'local-author' },
    logger: context.logger,
    now: context.now,
  });
  let projection: { ok: boolean; error?: string; digest?: string } = { ok: false };
  try {
    const built = rebuildProjection({
      vaultDir,
      projectId: opened.project.project_id,
      appDataRoot: context.appDataRoot,
      logger: context.logger,
      now: context.now,
    });
    projection = { ok: true, digest: built.projection_digest };
  } catch (error) {
    projection = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  return {
    data: {
      project_id: opened.project.project_id,
      vault_root: opened.vaultRoot,
      import_id: result.importId,
      manifest_revision: result.manifestRevision,
      source_filename: result.metadata.source_filename,
      source_sha256: result.metadata.source_sha256,
      source_encoding: result.encoding,
      line_ending: result.metadata.line_ending,
      chapters: result.chapters.length,
      volumes: result.volumes,
      empty_chapters: result.chapters.filter((chapter) => chapter.empty).length,
      duration_ms: result.durationMs,
      projection,
    },
    human: [
      `Imported ${result.metadata.source_filename} into ${opened.project.project_id}.`,
      `Encoding ${result.encoding}, line endings ${result.metadata.line_ending}, source ${result.metadata.source_bytes} bytes.`,
      `${result.chapters.length} chapters across ${result.volumes} volume(s); ${result.chapters.filter((chapter) => chapter.empty).length} empty.`,
      `Manifest is now ${result.manifestRevision}; import ${result.importId} took ${result.durationMs} ms.`,
      projection.ok ? 'Local projection updated.' : `Projection deferred: ${projection.error}`,
      `Next: ns chapters --vault "${vaultDir}"`,
    ],
  };
}

export function commandChapters(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const opened = openProject(vaultDir, context.projectId ?? undefined);
  const chapters = Object.values(opened.manifest.chapters)
    .sort((left, right) =>
      left.volume_id === right.volume_id
        ? left.ordinal - right.ordinal
        : left.volume_id.localeCompare(right.volume_id),
    )
    .map((entry) => ({
      chapter_id: entry.chapter_id,
      volume_id: entry.volume_id,
      ordinal: entry.ordinal,
      title: entry.title,
      word_count: entry.word_count,
      current_revision_id: entry.current_revision_id,
    }));
  return {
    data: { project_id: opened.project.project_id, chapters },
    human: chapters.map(
      (chapter) =>
        `${chapter.volume_id}/${String(chapter.ordinal).padStart(3, '0')}  ${chapter.chapter_id}  ${chapter.title}  (${chapter.word_count} words)`,
    ),
  };
}

export function commandRead(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const chapterId = requireFlag(args, 'chapter', 'chapter id');
  const opened = openProject(vaultDir, context.projectId ?? undefined);
  const entry = opened.manifest.chapters[chapterId];
  if (!entry) throw new Error(`Chapter not found: ${chapterId}`);
  const target = resolveInside(opened.projectDir, entry.path, 'chapter file');
  const bytes = readFileBytes(target);
  if (bytes === null) throw new Error(`Chapter file missing: ${entry.path}`);
  const text = bytes.toString('utf8');
  return {
    data: {
      chapter_id: entry.chapter_id,
      title: entry.title,
      revision_id: entry.current_revision_id,
      content_hash: entry.content_hash,
      content: text,
    },
    human: [text],
  };
}
