import fs from 'node:fs';
import path from 'node:path';
import {
  assertContract,
  type NarrativeCanonBundle,
} from '@narrative-studio/contracts';
import { openProject, readManifest, writeNarrativeCanon } from '@narrative-studio/core';
import {
  chapterEvidence,
  indexNarrative,
  readNarrativeOverview,
  rebuildNarrativeIndex,
  searchNarrative,
} from '@narrative-studio/narrative';
import type { CliContext } from '../context.js';
import { flagBool, flagString, requireFlag, type ParsedArgs } from '../flags.js';
import type { CommandResult } from './types.js';

function requireNarrativeVault(context: CliContext): string {
  if (!context.vaultDir) throw new Error('--vault is required');
  return context.vaultDir;
}

function projectIdFor(vaultDir: string, context: CliContext): string {
  return openProject(vaultDir, context.projectId ?? undefined).project.project_id;
}

export function commandNarrative(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireNarrativeVault(context);
  const projectId = projectIdFor(vaultDir, context);
  const sub = args.subcommand ?? 'status';

  if (sub === 'index') {
    const chapters = flagString(args, 'chapter');
    const full = flagBool(args, 'full') || flagBool(args, 'force');
    const result = full
      ? rebuildNarrativeIndex({ vaultDir, projectId, appDataRoot: context.appDataRoot, now: context.now })
      : indexNarrative({
          vaultDir,
          projectId,
          appDataRoot: context.appDataRoot,
          chapters: chapters ? [chapters] : undefined,
          now: context.now,
        });
    return {
      data: { ...result },
      human: [
        `Narrative index ${result.status}: ${result.indexed_chapters}/${result.total_chapters} chapters, ${result.duration_ms} ms.`,
        `Entities ${result.entities}, assertions ${result.assertions}, evidence ${result.evidence}, candidates ${result.candidates}, stale ${result.stale_evidence}.`,
        `Database: ${result.database}`,
      ],
    };
  }

  if (sub === 'seed') {
    const file = requireFlag(args, 'file', 'author canon JSON bundle');
    const bundle = assertContract<NarrativeCanonBundle>(
      'narrativeCanon',
      JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')) as unknown,
    );
    const written = writeNarrativeCanon({ vaultDir, projectId, bundle, now: context.now });
    const index = rebuildNarrativeIndex({ vaultDir, projectId, appDataRoot: context.appDataRoot, now: context.now });
    return {
      data: { canon: written, index },
      human: [
        `Author-confirmed canon written at ${written.manifestRevision} (${written.operationId}).`,
        `Narrative index ${index.status}, ${index.indexed_chapters} chapters, ${index.duration_ms} ms.`,
      ],
    };
  }

  if (sub === 'search') {
    const query = args.positionals[0] ?? requireFlag(args, 'query', 'search text');
    const atOrderRaw = flagString(args, 'at-order');
    const results = searchNarrative({
      vaultDir,
      projectId,
      appDataRoot: context.appDataRoot,
      query,
      atOrder: atOrderRaw ? Number(atOrderRaw) : null,
    });
    return {
      data: { query, results },
      human: results.length === 0
        ? [`No narrative matches for “${query}”.`]
        : results.flatMap((hit) => [
            `${hit.chapter_order}. ${hit.title} (${hit.chapter_id}) score ${hit.score}`,
            ...hit.matches.map((match) => `   …${match.quote.replace(/\s+/g, ' ')}…`),
          ]),
    };
  }

  if (sub === 'chapter') {
    const chapterId = requireFlag(args, 'chapter', 'chapter id');
    const evidence = chapterEvidence({ vaultDir, projectId, appDataRoot: context.appDataRoot, chapterId });
    return {
      data: { ...evidence },
      human: [
        `${evidence.evidence.length} evidence anchors in ${chapterId}.`,
        ...evidence.evidence.map((anchor) => `${anchor.status}: ${anchor.quote.slice(0, 80)}`),
      ],
    };
  }

  if (sub === 'status') {
    const overview = readNarrativeOverview({ vaultDir, projectId, appDataRoot: context.appDataRoot });
    return {
      data: { ...overview },
      human: [
        `Narrative projection: ${overview.status} at ${overview.source_revision || '(never built)'}.`,
        `Chapters ${overview.counts.chapters ?? 0}, entities ${overview.counts.entities ?? 0}, assertions ${overview.counts.assertions ?? 0}, evidence ${overview.counts.evidence ?? 0}.`,
        `Candidates (never canon): ${overview.candidates.length}; stale evidence: ${overview.stale_evidence}.`,
      ],
    };
  }

  throw new Error('Usage: ns narrative index|status|search|chapter|seed');
}

export function narrativeRevisionFor(vaultDir: string, projectId: string): string {
  return readManifest(openProject(vaultDir, projectId).projectDir).revision;
}
