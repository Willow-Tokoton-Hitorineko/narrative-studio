/**
 * Gate 2 narrative canon store.
 *
 * Canon is author-confirmed and therefore lives in the portable Vault, written
 * through the same CAS/journal transaction engine as chapters. Automatic
 * candidates live only in the disposable narrative projection and can never
 * overwrite this file without an explicit author confirmation.
 */

import fs from 'node:fs';
import path from 'node:path';
import {
  CasMismatchError,
  InvalidArgumentError,
  SCHEMA_VERSION,
  assertContract,
  operationIdFor,
  type Actor,
  type NarrativeCanonBundle,
} from '@narrative-studio/contracts';
import { jsonBytes } from './json.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest } from './manifest.js';
import { runTransaction } from './transaction.js';
import { openProject, readProjectFile } from './vault.js';

export const NARRATIVE_CANON_REL_PATH = 'story/narrative/canon.json';

export function readNarrativeCanon(projectDir: string): NarrativeCanonBundle | null {
  const target = path.join(projectDir, NARRATIVE_CANON_REL_PATH);
  if (!fs.existsSync(target)) return null;
  return assertContract<NarrativeCanonBundle>(
    'narrativeCanon',
    JSON.parse(fs.readFileSync(target, 'utf8')) as unknown,
  );
}

export interface WriteNarrativeCanonOptions {
  vaultDir: string;
  projectId?: string | null;
  bundle: NarrativeCanonBundle;
  baseRevision?: string | null;
  actor?: Actor;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface WriteNarrativeCanonResult {
  bundle: NarrativeCanonBundle;
  manifestRevision: string;
  operationId: string;
}

/**
 * Author-confirmed canon write. Deliberately has no `origin=model`/agent path:
 * only a direct author write is accepted here.
 */
export function writeNarrativeCanon(options: WriteNarrativeCanonOptions): WriteNarrativeCanonResult {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const actor: Actor = options.actor ?? { kind: 'author', id: 'local-author' };
  if (actor.kind !== 'author') {
    throw new InvalidArgumentError('Narrative canon can only be written by an author action');
  }
  const now = options.now ?? (() => new Date());
  const bundle = assertContract<NarrativeCanonBundle>('narrativeCanon', {
    ...options.bundle,
    schema_version: SCHEMA_VERSION,
    project_id: opened.project.project_id,
    updated_at: now().toISOString(),
  });

  return withProjectLock(opened.projectDir, (): WriteNarrativeCanonResult => {
    const manifest = readManifest(opened.projectDir);
    const base = options.baseRevision ?? manifest.revision;
    if (base !== manifest.revision) throw new CasMismatchError(base, manifest.revision);
    const project = readProjectFile(opened.projectDir);
    const exists = manifest.files[NARRATIVE_CANON_REL_PATH] !== undefined;
    const result = runTransaction({
      projectDir: opened.projectDir,
      projectId: opened.project.project_id,
      baseRevision: base,
      files: [
        {
          relPath: NARRATIVE_CANON_REL_PATH,
          bytes: jsonBytes(bundle),
          mode: exists ? 'replace' : 'create',
        },
      ],
      chapters: manifest.chapters,
      headRevision: manifest.head_revision,
      title: project.title,
      logger: options.logger ?? null,
      now,
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(manifest.seq + 1, resultRevision),
        seq: manifest.seq + 1,
        project_id: opened.project.project_id,
        type: 'narrative.canon',
        created_at: now().toISOString(),
        actor,
        base_revision: base,
        result_revision: resultRevision,
        payload: {
          bundle_id: bundle.bundle_id,
          entities: bundle.entities.length,
          assertions: bundle.assertions.length,
          evidence: bundle.evidence.length,
          events: bundle.events.length,
        },
        approval_id: null,
        provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
        status: 'committed',
      }),
    });
    return {
      bundle,
      manifestRevision: result.manifest.revision,
      operationId: result.operation.operation_id,
    };
  });
}
