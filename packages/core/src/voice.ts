/**
 * Gate 3A authoritative Voice Forge files.
 *
 * Source licences and the Style Constitution are authorship decisions and live
 * in the portable Vault, written through the same Story Core CAS/journal path as
 * manuscripts and narrative canon. Profiles and statistics remain rebuildable
 * local projections and are never written here by the analyser.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CasMismatchError,
  SCHEMA_VERSION,
  assertContract,
  operationIdFor,
  type Actor,
  type StyleConstitution,
  type VoiceCorpusRegistry,
} from '@narrative-studio/contracts';
import { jsonBytes } from './json.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest } from './manifest.js';
import { runTransaction } from './transaction.js';
import { openProject, readProjectFile } from './vault.js';

export const VOICE_CORPUS_REL_PATH = 'story/voice/corpus.json';
export const STYLE_CONSTITUTION_REL_PATH = 'story/voice/constitution.json';

export function readVoiceCorpus(projectDir: string): VoiceCorpusRegistry | null {
  const target = path.join(projectDir, VOICE_CORPUS_REL_PATH);
  if (!fs.existsSync(target)) return null;
  return assertContract<VoiceCorpusRegistry>('voiceCorpus', JSON.parse(fs.readFileSync(target, 'utf8')) as unknown);
}

export function readStyleConstitution(projectDir: string): StyleConstitution | null {
  const target = path.join(projectDir, STYLE_CONSTITUTION_REL_PATH);
  if (!fs.existsSync(target)) return null;
  return assertContract<StyleConstitution>('styleConstitution', JSON.parse(fs.readFileSync(target, 'utf8')) as unknown);
}

export interface WriteVoiceFileOptions<T> {
  vaultDir: string;
  projectId?: string | null;
  value: T;
  baseRevision?: string | null;
  actor?: Actor;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

function writeVoiceFile<T extends { project_id: string; updated_at: string }>(options: {
  options: WriteVoiceFileOptions<T>;
  relPath: string;
  type: 'voice.corpus' | 'voice.constitution';
  schema: 'voiceCorpus' | 'styleConstitution';
  counts: (value: T) => Record<string, number>;
}): { value: T; manifestRevision: string; operationId: string } {
  const { relPath, schema, type } = options;
  const input = options.options;
  const opened = openProject(input.vaultDir, input.projectId ?? undefined);
  const actor: Actor = input.actor ?? { kind: 'author', id: 'local-author' };
  if (actor.kind !== 'author') throw new Error('Voice Forge author files can only be written by an author action');
  const now = input.now ?? (() => new Date());
  const value = assertContract<T>(schema, {
    ...input.value,
    schema_version: SCHEMA_VERSION,
    project_id: opened.project.project_id,
    updated_at: now().toISOString(),
  });
  return withProjectLock(opened.projectDir, () => {
    const manifest = readManifest(opened.projectDir);
    const base = input.baseRevision ?? manifest.revision;
    if (base !== manifest.revision) throw new CasMismatchError(base, manifest.revision);
    const project = readProjectFile(opened.projectDir);
    const exists = manifest.files[relPath] !== undefined;
    const result = runTransaction({
      projectDir: opened.projectDir,
      projectId: opened.project.project_id,
      baseRevision: base,
      files: [{ relPath, bytes: jsonBytes(value), mode: exists ? 'replace' : 'create' }],
      chapters: manifest.chapters,
      headRevision: manifest.head_revision,
      title: project.title,
      logger: input.logger ?? null,
      now,
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(manifest.seq + 1, resultRevision),
        seq: manifest.seq + 1,
        project_id: opened.project.project_id,
        type,
        created_at: now().toISOString(),
        actor,
        base_revision: base,
        result_revision: resultRevision,
        payload: options.counts(value),
        approval_id: null,
        provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
        status: 'committed',
      }),
    });
    return { value, manifestRevision: result.manifest.revision, operationId: result.operation.operation_id };
  });
}

export function writeVoiceCorpus(options: WriteVoiceFileOptions<VoiceCorpusRegistry>) {
  return writeVoiceFile({
    options,
    relPath: VOICE_CORPUS_REL_PATH,
    type: 'voice.corpus',
    schema: 'voiceCorpus',
    counts: (value) => ({ sources: value.sources.length }),
  });
}

export function writeStyleConstitution(options: WriteVoiceFileOptions<StyleConstitution>) {
  return writeVoiceFile({
    options,
    relPath: STYLE_CONSTITUTION_REL_PATH,
    type: 'voice.constitution',
    schema: 'styleConstitution',
    counts: (value) => ({ rules: value.rules.length, version: value.version }),
  });
}
