import fs from 'node:fs';
import path from 'node:path';
import { CasMismatchError, SCHEMA_VERSION, assertContract, operationIdFor, type Actor, type PlanningState } from '@narrative-studio/contracts';
import { jsonBytes } from './json.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest } from './manifest.js';
import { runTransaction } from './transaction.js';
import { openProject, readProjectFile } from './vault.js';

export const PLANNING_STATE_REL_PATH = 'story/planning/state.json';

export function readPlanningState(projectDir: string): PlanningState | null {
  const target = path.join(projectDir, PLANNING_STATE_REL_PATH);
  if (!fs.existsSync(target)) return null;
  return assertContract<PlanningState>('planningState', JSON.parse(fs.readFileSync(target, 'utf8')) as unknown);
}

export function writePlanningState(options: {
  vaultDir: string;
  projectId?: string | null;
  value: PlanningState;
  baseRevision?: string | null;
  actor?: Actor;
  logger?: SanitizedLogger | null;
}): { value: PlanningState; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const actor: Actor = options.actor ?? { kind: 'author', id: 'local-author' };
  if (actor.kind !== 'author') throw new Error('Planning can only be written by an author action');
  return withProjectLock(opened.projectDir, () => {
    const manifest = readManifest(opened.projectDir);
    const base = options.baseRevision ?? manifest.revision;
    if (base !== manifest.revision) throw new CasMismatchError(base, manifest.revision);
    const now = new Date().toISOString();
    const value = assertContract<PlanningState>('planningState', {
      ...options.value, schema_version: SCHEMA_VERSION, project_id: opened.project.project_id,
    });
    const result = runTransaction({
      projectDir: opened.projectDir, projectId: opened.project.project_id, baseRevision: base,
      files: [{ relPath: PLANNING_STATE_REL_PATH, bytes: jsonBytes(value), mode: manifest.files[PLANNING_STATE_REL_PATH] ? 'replace' : 'create' }],
      chapters: manifest.chapters, headRevision: manifest.head_revision, title: readProjectFile(opened.projectDir).title,
      logger: options.logger ?? null, now: () => new Date(now),
      buildOperation: (resultRevision) => ({
        schema_version: SCHEMA_VERSION, operation_id: operationIdFor(manifest.seq + 1, resultRevision), seq: manifest.seq + 1,
        project_id: opened.project.project_id, type: 'planning.state', created_at: now, actor,
        base_revision: base, result_revision: resultRevision,
        payload: { ideas: value.ideas.length, plans: value.plans.length, branches: value.branches.length },
        approval_id: null, provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' }, status: 'committed',
      }),
    });
    return { value, manifestRevision: result.manifest.revision };
  });
}
