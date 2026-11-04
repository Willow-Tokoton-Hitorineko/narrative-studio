/**
 * Gate 1 import: one atomic Story Core transaction writes the raw source, its
 * provenance metadata and every parsed chapter revision. The raw bytes are
 * immutable and included in the manifest, so an export can prove byte-for-byte
 * what was imported even when chapter storage is UTF-8 text.
 */

import path from 'node:path';
import {
  InvalidArgumentError,
  SCHEMA_VERSION,
  assertContract,
  chapterIdFor,
  contentDigest,
  encodeUtf8,
  newImportId,
  operationIdFor,
  revisionIdForChapter,
  sha256Hex,
  textStats,
  wordCount,
  type Actor,
  type ImportMetadata,
  type ManifestChapterEntry,
  type Operation,
  type Revision,
} from '@narrative-studio/contracts';
import { jsonBytes } from './json.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest } from './manifest.js';
import { decodeSource, parseManuscript, volumeIdFor } from './text-import.js';
import { runTransaction } from './transaction.js';
import {
  chapterRelPath,
  readProjectFile,
  revisionRelPaths,
} from './vault.js';

export interface ImportManuscriptOptions {
  projectDir: string;
  sourceBytes: Buffer;
  sourceFilename: string;
  actor?: Actor;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface ImportedChapterSummary {
  chapter_id: string;
  title: string;
  volume_id: string;
  ordinal: number;
  chars: number;
  empty: boolean;
}

export interface ImportManuscriptResult {
  importId: string;
  metadata: ImportMetadata;
  manifestRevision: string;
  operation: Operation;
  chapters: ImportedChapterSummary[];
  volumes: number;
  encoding: string;
  durationMs: number;
}

function safeSourceFilename(input: string): string {
  const base = path.basename(input.replace(/\\/g, '/'));
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  const cleaned = base.replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/[. ]+$/, '');
  return (cleaned.length > 0 ? cleaned : 'manuscript.txt').slice(0, 200);
}

function rawExtension(filename: string): string {
  const extension = path.extname(filename).toLowerCase();
  return extension === '.md' || extension === '.markdown' || extension === '.txt' ? extension : '.txt';
}

export function importManuscript(options: ImportManuscriptOptions): ImportManuscriptResult {
  const startedAt = Date.now();
  const now = options.now ?? (() => new Date());
  const actor: Actor = options.actor ?? { kind: 'author', id: 'local-author' };
  const sourceFilename = safeSourceFilename(options.sourceFilename);
  const decoded = decodeSource(options.sourceBytes);
  const parsed = parseManuscript(decoded.text);

  return withProjectLock(options.projectDir, (): ImportManuscriptResult => {
    const manifest = readManifest(options.projectDir);
    if (Object.keys(manifest.chapters).length > 0) {
      throw new InvalidArgumentError(
        'Text import requires an empty project; refusing to mix an import into existing chapters',
        { projectId: manifest.project_id },
      );
    }
    const project = readProjectFile(options.projectDir);
    const importId = newImportId();
    const createdAt = now().toISOString();
    const rawRelPath = `.story/imports/${importId}/original${rawExtension(sourceFilename)}`;
    const metadataRelPath = `.story/imports/${importId}/import.json`;
    const sourceSha256 = sha256Hex(options.sourceBytes);

    const metadata: ImportMetadata = assertContract<ImportMetadata>('importMetadata', {
      schema_version: SCHEMA_VERSION,
      import_id: importId,
      project_id: manifest.project_id,
      created_at: createdAt,
      source_filename: sourceFilename,
      source_sha256: sourceSha256,
      source_bytes: options.sourceBytes.length,
      source_encoding: decoded.encoding,
      line_ending: decoded.lineEnding,
      chapter_count: parsed.chapters.length,
      volume_count: parsed.volumes,
      empty_chapter_count: parsed.empty_chapters,
      raw_path: rawRelPath,
      provenance: { source: 'import', actor_id: actor.id, tool: 'ns-cli' },
      status: 'committed',
    });

    const chapters: Record<string, ManifestChapterEntry> = {};
    const summaries: ImportedChapterSummary[] = [];
    const files: { relPath: string; bytes: Buffer; mode: 'create' }[] = [
      { relPath: rawRelPath, bytes: options.sourceBytes, mode: 'create' },
      { relPath: metadataRelPath, bytes: jsonBytes(metadata), mode: 'create' },
    ];

    for (const parsedChapter of parsed.chapters) {
      const volumeId = volumeIdFor(parsedChapter.volume_ordinal);
      const chapterId = chapterIdFor(volumeId, parsedChapter.title, parsedChapter.ordinal);
      const bodyBytes = encodeUtf8(parsedChapter.body);
      const contentHash = contentDigest(bodyBytes);
      const revisionId = revisionIdForChapter(chapterId, 1, contentHash);
      const revision: Revision = assertContract<Revision>('revision', {
        schema_version: SCHEMA_VERSION,
        revision_id: revisionId,
        project_id: manifest.project_id,
        chapter_id: chapterId,
        seq: 1,
        parent_revision_id: null,
        content_hash: contentHash,
        byte_length: bodyBytes.length,
        encoding: 'utf-8',
        line_ending: parsedChapter.line_ending,
        created_at: createdAt,
        actor,
        origin: 'import',
        message: `Imported from ${sourceFilename}`,
        approval_id: null,
        provenance: { source: 'import', actor_id: actor.id, tool: 'ns-cli' },
        status: 'committed',
      });
      const paths = revisionRelPaths(chapterId, revisionId);
      const chapterRelative = chapterRelPath(volumeId, chapterId);
      const wordCountValue = wordCount(parsedChapter.body);
      chapters[chapterId] = {
        chapter_id: chapterId,
        volume_id: volumeId,
        title: parsedChapter.title,
        ordinal: parsedChapter.ordinal,
        current_revision_id: revisionId,
        content_hash: contentHash,
        word_count: wordCountValue,
        revision_seq: 1,
        path: chapterRelative,
        created_at: createdAt,
        updated_at: createdAt,
      };
      summaries.push({
        chapter_id: chapterId,
        title: parsedChapter.title,
        volume_id: volumeId,
        ordinal: parsedChapter.ordinal,
        chars: parsedChapter.chars,
        empty: parsedChapter.body.trim().length === 0,
      });
      files.push(
        { relPath: paths.body, bytes: bodyBytes, mode: 'create' },
        { relPath: paths.meta, bytes: jsonBytes(revision), mode: 'create' },
        { relPath: chapterRelative, bytes: bodyBytes, mode: 'create' },
      );
    }

    const stats = textStats(decoded.text);
    const result = runTransaction({
      projectDir: options.projectDir,
      projectId: manifest.project_id,
      baseRevision: manifest.revision,
      files,
      chapters,
      headRevision: summaries.at(-1)?.chapter_id
        ? chapters[summaries.at(-1)!.chapter_id]!.current_revision_id
        : null,
      title: project.title,
      logger: options.logger ?? null,
      now,
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(manifest.seq + 1, resultRevision),
        seq: manifest.seq + 1,
        project_id: manifest.project_id,
        type: 'import.apply',
        created_at: createdAt,
        actor,
        base_revision: manifest.revision,
        result_revision: resultRevision,
        payload: {
          import_id: importId,
          source_filename: sourceFilename,
          source_sha256: sourceSha256,
          source_encoding: decoded.encoding,
          chapters: parsed.chapters.length,
          volumes: parsed.volumes,
          empty_chapters: parsed.empty_chapters,
          duplicate_titles: parsed.duplicate_titles,
          characters: stats.characters,
          raw_path: rawRelPath,
        },
        approval_id: null,
        provenance: { source: 'import', actor_id: actor.id, tool: 'ns-cli' },
        status: 'committed',
      }),
    });

    options.logger?.info('import.completed', {
      project_id: manifest.project_id,
      import_id: importId,
      encoding: decoded.encoding,
      chapters: parsed.chapters.length,
      volumes: parsed.volumes,
      source_bytes: options.sourceBytes.length,
      duration_ms: Date.now() - startedAt,
    });

    return {
      importId,
      metadata,
      manifestRevision: result.manifest.revision,
      operation: result.operation,
      chapters: summaries,
      volumes: parsed.volumes,
      encoding: decoded.encoding,
      durationMs: Date.now() - startedAt,
    };
  });
}
