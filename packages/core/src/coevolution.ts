import fs from 'node:fs';
import path from 'node:path';
import {
  CasMismatchError,
  SCHEMA_VERSION,
  assertContract,
  operationIdFor,
  type Actor,
  type CoevolutionState,
} from '@narrative-studio/contracts';
import { jsonBytes } from './json.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest } from './manifest.js';
import { runTransaction } from './transaction.js';
import { openProject, readProjectFile } from './vault.js';

export const COEVOLUTION_STATE_REL_PATH = 'story/coevolution/state.json';

export function readCoevolutionState(projectDir: string): CoevolutionState | null {
  const target = path.join(projectDir, COEVOLUTION_STATE_REL_PATH);
  if (!fs.existsSync(target)) return null;
  return assertContract<CoevolutionState>('coevolutionState', JSON.parse(fs.readFileSync(target, 'utf8')) as unknown);
}

export function writeCoevolutionState(options: {
  vaultDir: string;
  projectId?: string | null;
  value: CoevolutionState;
  baseRevision?: string | null;
  actor?: Actor;
  logger?: SanitizedLogger | null;
}): { value: CoevolutionState; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const actor: Actor = options.actor ?? { kind: 'author', id: 'local-author' };
  if (actor.kind !== 'author') throw new Error('Co-Evolution state can only be written by an author action');
  return withProjectLock(opened.projectDir, () => {
    const manifest = readManifest(opened.projectDir);
    const base = options.baseRevision ?? manifest.revision;
    if (base !== manifest.revision) throw new CasMismatchError(base, manifest.revision);
    const now = new Date().toISOString();
    const value = assertContract<CoevolutionState>('coevolutionState', {
      ...options.value,
      schema_version: SCHEMA_VERSION,
      project_id: opened.project.project_id,
      updated_at: now,
      consent: { ...options.value.consent, external_send: false },
    });
    const result = runTransaction({
      projectDir: opened.projectDir,
      projectId: opened.project.project_id,
      baseRevision: base,
      files: [{ relPath: COEVOLUTION_STATE_REL_PATH, bytes: jsonBytes(value), mode: manifest.files[COEVOLUTION_STATE_REL_PATH] ? 'replace' : 'create' }],
      chapters: manifest.chapters,
      headRevision: manifest.head_revision,
      title: readProjectFile(opened.projectDir).title,
      logger: options.logger ?? null,
      now: () => new Date(now),
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(manifest.seq + 1, resultRevision),
        seq: manifest.seq + 1,
        project_id: opened.project.project_id,
        type: 'coevolution.state',
        created_at: now,
        actor,
        base_revision: base,
        result_revision: resultRevision,
        payload: { observations: value.observations.length, policies: value.policies.length },
        approval_id: null,
        provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
        status: 'committed',
      }),
    });
    return { value, manifestRevision: result.manifest.revision };
  });
}
