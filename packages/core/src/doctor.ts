/**
 * `ns doctor`: prove (or disprove) that this Vault is healthy.
 *
 * Read-only by default. `--repair` only performs safe, reversible actions:
 * finishing/rolling back an interrupted journaled commit, removing orphan
 * staging directories, and clearing a lock whose owner is provably dead.
 * It never rewrites manuscript text or approves anything on the author's behalf.
 */

import fs from 'node:fs';
import path from 'node:path';
import { defaultAppDataRoot } from './appdata.js';
import { directoryFsyncIsSupported } from './fsx.js';
import { breakLock, readLock, withProjectLock } from './lock.js';
import { listJournals, readRecoveryAudit } from './journal.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest, verifyManifest } from './manifest.js';
import { assertLocalFilesystemPath, isPathInside } from './paths.js';
import { readProposalsFromProject } from './proposals.js';
import {
  cleanupOrphanArtifacts,
  listOrphanArtifacts,
  recoverProject,
  type RecoveryOutcome,
} from './recovery.js';
import {
  listProjectSummaries,
  openProject,
  readApprovals,
  readOperations,
} from './vault.js';

export type DoctorCheckStatus = 'pass' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: string;
  status: DoctorCheckStatus;
  detail: string;
  data?: Record<string, unknown>;
}

export interface DoctorOptions {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  repair?: boolean;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface DoctorReport {
  ok: boolean;
  generated_at: string;
  vault_root: string;
  project_id: string | null;
  checks: DoctorCheck[];
  repairs: string[];
  recovery: RecoveryOutcome[];
}

export function runDoctor(options: DoctorOptions): DoctorReport {
  const now = options.now ?? (() => new Date());
  const checks: DoctorCheck[] = [];
  const repairs: string[] = [];
  const recovery: RecoveryOutcome[] = [];
  const vaultRoot = path.resolve(options.vaultDir);
  let projectId: string | null = options.projectId ?? null;

  const add = (check: DoctorCheck): void => {
    checks.push(check);
  };

  const fsyncSupported = directoryFsyncIsSupported();
  add({
    id: 'runtime.directory_fsync',
    status: fsyncSupported ? 'pass' : 'warn',
    detail: fsyncSupported
      ? 'Directory fsync is available on this platform.'
      : 'Directory fsync is unavailable (expected on Windows). File fsync + atomic rename is used; power-loss durability remains a documented residual risk.',
  });

  let opened;
  try {
    const summaries = listProjectSummaries(vaultRoot);
    if (projectId === null && summaries.projects.length === 1) {
      projectId = summaries.projects[0]?.project_id ?? null;
    }
    add({
      id: 'vault.projects',
      status: summaries.invalid.length === 0 ? 'pass' : 'warn',
      detail: `${summaries.projects.length} readable project(s), ${summaries.invalid.length} unreadable`,
      data: { projects: summaries.projects, invalid: summaries.invalid },
    });
    opened = openProject(vaultRoot, projectId ?? undefined);
    projectId = opened.project.project_id;
    add({
      id: 'project.open',
      status: 'pass',
      detail: `Project ${opened.project.project_id} (${opened.project.title}) is readable`,
    });
  } catch (error) {
    add({
      id: 'project.open',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
    return finalize(checks, repairs, recovery, vaultRoot, projectId, now);
  }

  const projectDir = opened.projectDir;

  try {
    const appDataRoot = assertLocalFilesystemPath(
      options.appDataRoot ?? process.env.NS_APPDATA_ROOT ?? defaultAppDataRoot(),
      'AppDataRoot',
    );
    if (isPathInside(vaultRoot, appDataRoot)) {
      throw new Error('AppDataRoot must not be inside the writing Vault');
    }
    if (isPathInside(appDataRoot, vaultRoot)) {
      throw new Error('The writing Vault must not be inside AppDataRoot');
    }
    if (fs.existsSync(appDataRoot)) {
      fs.accessSync(appDataRoot, fs.constants.W_OK);
      add({ id: 'storage.separation', status: 'pass', detail: `AppDataRoot is writable: ${appDataRoot}` });
    } else {
      add({
        id: 'storage.separation',
        status: 'pass',
        detail: `AppDataRoot will be created on first use: ${appDataRoot}`,
      });
    }
  } catch (error) {
    add({
      id: 'storage.separation',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const lockSnapshot = readLock(projectDir, now);
  if (!lockSnapshot.exists) {
    add({ id: 'writer.lock', status: 'pass', detail: 'No writer lock is held.' });
  } else if (lockSnapshot.corrupt) {
    add({ id: 'writer.lock', status: 'warn', detail: 'Writer lock file is corrupt.' });
    if (options.repair) {
      const result = breakLock(projectDir, { force: true, now });
      if (result.removed) repairs.push(`removed corrupt writer lock (${result.reason})`);
    }
  } else if (lockSnapshot.holderAlive === true) {
    add({
      id: 'writer.lock',
      status: 'warn',
      detail: `Another process (pid ${lockSnapshot.info?.pid}) currently holds the writer lock.`,
    });
  } else {
    add({ id: 'writer.lock', status: 'warn', detail: 'Stale writer lock from a dead process.' });
    if (options.repair) {
      const result = breakLock(projectDir, { now });
      if (result.removed) repairs.push(`removed stale writer lock (${result.reason})`);
    }
  }

  let journals = listJournals(projectDir);
  add({
    id: 'journal.pending',
    status: journals.length === 0 ? 'pass' : 'warn',
    detail:
      journals.length === 0
        ? 'No interrupted commit journals.'
        : `${journals.length} journal(s) need recovery.`,
    data: { transactions: journals.map((record) => ({ id: record.txn.txn_id, state: record.txn.state })) },
  });

  if (options.repair && journals.length > 0) {
    try {
      withProjectLock(projectDir, () => {
        const report = recoverProject({ projectDir, logger: options.logger, now });
        recovery.push(...report.outcomes);
        for (const outcome of report.outcomes) {
          repairs.push(`recovery ${outcome.action} for ${outcome.txnId}: ${outcome.detail}`);
        }
        if (!report.ok) throw new Error(report.errors.join('; '));
      });
      journals = [];
    } catch (error) {
      add({
        id: 'journal.recovery',
        status: 'fail',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const orphanArtifacts = listOrphanArtifacts(projectDir);
  add({
    id: 'artifacts.orphans',
    status: orphanArtifacts.length === 0 ? 'pass' : 'warn',
    detail:
      orphanArtifacts.length === 0
        ? 'No orphan staging/rollback directories.'
        : `${orphanArtifacts.length} orphan staging/rollback director(ies).`,
    data: { orphans: orphanArtifacts },
  });
  if (options.repair && orphanArtifacts.length > 0) {
    const removed = cleanupOrphanArtifacts(projectDir);
    repairs.push(`removed ${removed.length} orphan artifact director(ies)`);
  }

  try {
    const manifest = readManifest(projectDir);
    const verification = verifyManifest(projectDir, manifest);
    add({
      id: 'manifest.integrity',
      status: verification.ok ? 'pass' : 'fail',
      detail: verification.ok
        ? `All ${verification.checked} authoritative files match the manifest at ${manifest.revision}.`
        : `Manifest mismatch: missing ${verification.missing.length}, mismatched ${verification.mismatched.length}.`,
      data: {
        revision: manifest.revision,
        checked: verification.checked,
        missing: verification.missing,
        mismatched: verification.mismatched,
        extra: verification.extra,
      },
    });
  } catch (error) {
    add({
      id: 'manifest.integrity',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const operations = readOperations(projectDir);
    add({ id: 'operations.log', status: 'pass', detail: `${operations.length} authoritative operation(s).` });
  } catch (error) {
    add({
      id: 'operations.log',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const approvals = readApprovals(projectDir);
    add({ id: 'approvals.log', status: 'pass', detail: `${approvals.length} approval receipt(s).` });
  } catch (error) {
    add({
      id: 'approvals.log',
      status: 'fail',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  try {
    const proposals = readProposalsFromProject(projectDir);
    add({
      id: 'proposals',
      status: 'pass',
      detail: `${proposals.length} proposal(s) readable; none is authoritative.`,
    });
  } catch (error) {
    add({
      id: 'proposals',
      status: 'warn',
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const recoveryAudit = readRecoveryAudit(projectDir);
  add({
    id: 'recovery.audit',
    status: 'pass',
    detail: `${recoveryAudit.length} recovery audit entr(ies) recorded.`,
  });

  return finalize(checks, repairs, recovery, vaultRoot, projectId, now);
}

function finalize(
  checks: DoctorCheck[],
  repairs: string[],
  recovery: RecoveryOutcome[],
  vaultRoot: string,
  projectId: string | null,
  now: () => Date,
): DoctorReport {
  const ok = checks.every((check) => check.status !== 'fail');
  return {
    ok,
    generated_at: now().toISOString(),
    vault_root: vaultRoot,
    project_id: projectId,
    checks,
    repairs,
    recovery,
  };
}
