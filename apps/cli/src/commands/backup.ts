import { CorruptionError, InvalidArgumentError } from '@narrative-studio/contracts';
import { createBackup, restoreBackup, verifyBackup } from '@narrative-studio/core';
import { rebuildProjection } from '@narrative-studio/projection';
import type { CliContext } from '../context.js';
import { flagString, requireFlag, type ParsedArgs } from '../flags.js';
import type { CommandResult } from './types.js';

export function commandBackup(args: ParsedArgs, context: CliContext): CommandResult {
  const subcommand = args.subcommand;
  if (subcommand === 'create') {
    const vaultDir = requireFlag(args, 'vault');
    const result = createBackup({
      vaultDir,
      projectId: context.projectId,
      destRoot: flagString(args, 'dest'),
      logger: context.logger,
      now: context.now,
    });
    return {
      data: { ...result },
      human: [
        `Backup created: ${result.backupDir}`,
        `Project ${result.projectId} at ${result.sourceRevision}, ${result.files.length} file(s).`,
        ...result.warnings.map((warning) => `WARNING: ${warning}`),
        `Verify with: ns backup verify --backup "${result.backupDir}"`,
      ],
    };
  }

  if (subcommand === 'verify') {
    const backupDir = requireFlag(args, 'backup', 'backup directory');
    const verification = verifyBackup(backupDir);
    if (!verification.ok) {
      throw new CorruptionError('Backup verification failed', {
        backupDir,
        missing: verification.missing,
        mismatched: verification.mismatched,
        digestOk: verification.digestOk,
      });
    }
    return {
      data: {
        ok: true,
        backup_dir: backupDir,
        snapshot_id: verification.manifest.snapshot_id,
        kind: verification.manifest.kind,
        project_id: verification.manifest.project_id,
        source_revision: verification.manifest.source_revision,
        file_count: verification.manifest.file_count,
        digest: verification.manifest.digest,
      },
      human: [
        `Backup verified: ${verification.manifest.file_count} file(s), digest ${verification.manifest.digest.slice(0, 16)}…`,
        `Project ${verification.manifest.project_id} at ${verification.manifest.source_revision}.`,
      ],
    };
  }

  if (subcommand === 'restore') {
    const backupDir = requireFlag(args, 'backup', 'backup directory');
    const destVault = requireFlag(args, 'dest-vault', 'new vault directory');
    const result = restoreBackup({
      backupDir,
      destVault,
      logger: context.logger,
      now: context.now,
    });
    let projection: { ok: boolean; error?: string } = { ok: false };
    try {
      rebuildProjection({
        vaultDir: result.vaultRoot,
        projectId: result.project.project_id,
        appDataRoot: context.appDataRoot,
        logger: context.logger,
        now: context.now,
      });
      projection = { ok: true };
    } catch (error) {
      projection = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      data: {
        ok: true,
        vault_root: result.vaultRoot,
        project_dir: result.projectDir,
        project_id: result.project.project_id,
        revision: result.manifest.revision,
        file_count: result.snapshot.file_count,
        projection,
      },
      human: [
        `Restored ${result.project.project_id} to ${result.projectDir}`,
        `Manifest revision ${result.manifest.revision}; all hashes verified.`,
        projection.ok ? 'Local projection rebuilt for the restored Vault.' : `Projection deferred: ${projection.error}`,
      ],
    };
  }

  throw new InvalidArgumentError('Usage: ns backup create|verify|restore …');
}
