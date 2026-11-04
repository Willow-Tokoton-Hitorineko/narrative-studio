import { CorruptionError } from '@narrative-studio/contracts';
import {
  breakLock,
  initProject,
  listProjectSummaries,
  openProject,
  projectStatus,
  readManifest,
  recoverProject,
  runDoctor,
  verifyManifest,
  withProjectLock,
} from '@narrative-studio/core';
import { rebuildProjection, readProjectionStatus } from '@narrative-studio/projection';
import type { CliContext } from '../context.js';
import { flagBool, flagString, requireFlag, type ParsedArgs } from '../flags.js';
import type { CommandResult } from './types.js';

export function commandInit(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault', 'new Vault directory');
  const title = requireFlag(args, 'title', 'project title');
  const result = initProject({
    vaultDir,
    title,
    description: flagString(args, 'description'),
    language: flagString(args, 'language') ?? undefined,
    projectId: flagString(args, 'project-id') ?? undefined,
    logger: context.logger,
    now: context.now,
  });
  const projectId = result.opened.project.project_id;
  let projection: { ok: boolean; digest?: string | null; database?: string; error?: string } = {
    ok: false,
  };
  try {
    const built = rebuildProjection({
      vaultDir,
      projectId,
      appDataRoot: context.appDataRoot,
      logger: context.logger,
      now: context.now,
    });
    projection = { ok: true, digest: built.projection_digest, database: built.database };
  } catch (error) {
    projection = { ok: false, error: error instanceof Error ? error.message : String(error) };
  }

  return {
    data: {
      project_id: projectId,
      vault_root: result.opened.vaultRoot,
      project_dir: result.opened.projectDir,
      title: result.opened.project.title,
      revision: result.opened.manifest.revision,
      operation_id: result.operation.operation_id,
      projection,
    },
    human: [
      `Created project ${projectId} in ${result.opened.projectDir}`,
      `Manifest revision: ${result.opened.manifest.revision}`,
      projection.ok
        ? `Local SQLite projection built: ${projection.database}`
        : `Local SQLite projection deferred (${projection.error}); the Vault is authoritative.`,
      'Next: ns chapter add --vault "<vault>" --title "Chapter 1" --file draft.md',
    ],
  };
}

export function commandStatus(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const status = projectStatus({ vaultDir, projectId: context.projectId, now: context.now });
  let projection: Record<string, unknown>;
  try {
    projection = {
      ...readProjectionStatus({
        vaultDir,
        projectId: status.project.project_id,
        appDataRoot: context.appDataRoot,
        now: context.now,
      }),
    };
  } catch (error) {
    projection = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
  }
  const lockText = status.lock.heldByLiveProcess
    ? `locked by pid ${status.lock.pid}`
    : status.lock.exists
      ? 'stale lock present'
      : 'unlocked';
  return {
    data: { ...status, projection },
    human: [
      `${status.project.title} (${status.project.project_id})`,
      `Vault: ${status.vault_root}`,
      `Saved revision: ${status.manifest.revision}  (seq ${status.manifest.seq})`,
      `Chapters: ${status.chapter_count}  Words: ${status.total_word_count}`,
      `Writer lock: ${lockText}`,
      `Pending journals: ${status.pending_transactions.length}`,
      `SQLite projection: ${String(projection.status ?? 'unknown')}`,
    ],
  };
}

export function commandVerify(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const opened = openProject(vaultDir, context.projectId);
  const manifest = readManifest(opened.projectDir);
  const verification = verifyManifest(opened.projectDir, manifest);
  if (!verification.ok) {
    throw new CorruptionError('Vault verification failed', {
      revision: manifest.revision,
      missing: verification.missing,
      mismatched: verification.mismatched,
    });
  }
  return {
    data: {
      ok: true,
      revision: manifest.revision,
      checked_files: verification.checked,
      missing: verification.missing,
      mismatched: verification.mismatched,
      extra: verification.extra,
    },
    human: [
      `Verified ${verification.checked} authoritative files at ${manifest.revision}.`,
      verification.extra.length > 0
        ? `Note: ${verification.extra.length} untracked file(s) inside tracked folders.`
        : 'No untracked files in tracked folders.',
    ],
  };
}

export function commandDoctor(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const report = runDoctor({
    vaultDir,
    projectId: context.projectId,
    appDataRoot: context.appDataRoot,
    repair: flagBool(args, 'repair'),
    logger: context.logger,
    now: context.now,
  });

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  report.checks.unshift({
    id: 'runtime.node_version',
    status: nodeMajor === 24 ? 'pass' : 'warn',
    detail:
      nodeMajor === 24
        ? `Node ${process.version} is in the tested Gate 0 range (24.x, bundles SQLite 3.51.3).`
        : `Node ${process.version} is outside the tested range (24.x). The projection uses node:sqlite; re-run the full projection tests before trusting it.`,
  });

  if (report.project_id) {
    try {
      const projectionStatus = readProjectionStatus({
        vaultDir,
        projectId: report.project_id,
        appDataRoot: context.appDataRoot,
        now: context.now,
      });
      report.checks.push({
        id: 'projection.status',
        status: projectionStatus.status === 'current' ? 'pass' : 'warn',
        detail:
          projectionStatus.status === 'current'
            ? 'SQLite projection matches the Vault head.'
            : `SQLite projection is ${projectionStatus.status}; run \`ns rebuild\` (it is disposable).`,
        data: { ...projectionStatus },
      });
    } catch (error) {
      report.checks.push({
        id: 'projection.status',
        status: 'warn',
        detail: `Projection unavailable: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  report.ok = report.checks.every((check) => check.status !== 'fail');
  return {
    data: { ...report },
    human: [
      `Doctor ${report.ok ? 'PASS' : 'FAIL'} for ${report.vault_root}`,
      ...report.checks.map((check) => `  [${check.status.toUpperCase()}] ${check.id}: ${check.detail}`),
      ...(report.repairs.length > 0
        ? ['Repairs:', ...report.repairs.map((repairText) => `  - ${repairText}`)]
        : []),
    ],
  };
}

export function commandRecover(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const opened = openProject(vaultDir, context.projectId);
  const report = withProjectLock(
    opened.projectDir,
    () =>
      recoverProject({
        projectDir: opened.projectDir,
        logger: context.logger,
        now: context.now,
      }),
    { logger: context.logger },
  );
  if (!report.ok) {
    throw new CorruptionError('Recovery did not complete cleanly', {
      outcomes: report.outcomes,
      errors: report.errors,
    });
  }
  return {
    data: { ...report },
    human: [
      report.outcomes.length === 0
        ? 'No interrupted transactions to recover.'
        : `Recovered ${report.outcomes.length} transaction(s).`,
      ...report.outcomes.map(
        (outcome) => `  ${outcome.txnId}: ${outcome.action} — ${outcome.detail}`,
      ),
    ],
  };
}

export function commandUnlock(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireFlag(args, 'vault');
  const opened = openProject(vaultDir, context.projectId);
  const result = breakLock(opened.projectDir, {
    force: flagBool(args, 'force'),
    now: context.now,
  });
  return {
    data: { ...result },
    human: [result.removed ? `Lock removed: ${result.reason}` : `No lock removed: ${result.reason}`],
  };
}

export function commandProjects(args: ParsedArgs, context: CliContext): CommandResult {
  void context;
  const vaultDir = requireFlag(args, 'vault');
  const summaries = listProjectSummaries(vaultDir);
  return {
    data: { ...summaries },
    human:
      summaries.projects.length === 0
        ? [`No projects found in ${summaries.vaultRoot}`]
        : summaries.projects.map(
            (project) =>
              `${project.project_id}  ${project.title}  ${project.chapter_count} chapter(s)  ${project.revision}`,
          ),
  };
}
