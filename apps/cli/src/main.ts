#!/usr/bin/env node
/**
 * `ns` — Narrative Studio Gate 0 command line interface.
 *
 * The CLI is the trusted local operator surface: every authoritative write goes
 * through Story Core commands, base-revision CAS and (for model/agent origins)
 * an explicit author approval receipt.
 */

import {
  InvalidArgumentError,
  NarrativeStudioError,
  isNarrativeStudioError,
  toErrorMessage,
} from '@narrative-studio/contracts';
import { rebuildProjection } from '@narrative-studio/projection';
import { createContext, requireVault, type CliContext } from './context.js';
import { HELP_TEXT } from './help.js';
import { flagBool, parseArgs, type ParsedArgs } from './flags.js';
import { commandBackup } from './commands/backup.js';
import {
  commandChapterAdd,
  commandCommit,
  commandExport,
  commandHistory,
} from './commands/chapter.js';
import { commandJob } from './commands/jobs.js';
import { commandNarrative } from './commands/narrative.js';
import { commandVoice } from './commands/voice.js';
import { commandChapters, commandImport, commandRead } from './commands/import.js';
import { commandProposal } from './commands/proposals.js';
import { commandStudio } from './commands/studio.js';
import {
  commandDoctor,
  commandInit,
  commandProjects,
  commandRecover,
  commandStatus,
  commandUnlock,
  commandVerify,
} from './commands/vault.js';
import type { CommandResult } from './commands/types.js';

const EXIT_CODES: Record<string, number> = {
  CONTRACT_VIOLATION: 10,
  INVALID_ARGUMENT: 2,
  PATH_UNSAFE: 5,
  PATH_OUTSIDE_ROOT: 5,
  NOT_FOUND: 7,
  ALREADY_EXISTS: 7,
  CAS_MISMATCH: 3,
  WRITER_LOCKED: 4,
  CORRUPTION: 6,
  UNAUTHORIZED: 8,
  PROJECTION_FAILED: 9,
  JOB_CANCELLED: 11,
  IO_ERROR: 1,
  INTERNAL: 1,
};

function commandRebuild(_args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireVault(context);
  const result = rebuildProjection({
    vaultDir,
    projectId: context.projectId,
    appDataRoot: context.appDataRoot,
    logger: context.logger,
    now: context.now,
  });
  return {
    data: { ...result },
    human: [
      `Rebuilt the disposable SQLite projection at ${result.source_revision}.`,
      `Database: ${result.database}`,
      `Chapters ${result.counts.chapters}, revisions ${result.counts.revisions}, operations ${result.counts.operations}.`,
      `Digest ${result.projection_digest}`,
    ],
  };
}

async function dispatch(args: ParsedArgs, context: CliContext): Promise<CommandResult> {
  switch (args.command) {
    case 'init':
      return commandInit(args, context);
    case 'status':
      return commandStatus(args, context);
    case 'verify':
      return commandVerify(args, context);
    case 'doctor':
      return commandDoctor(args, context);
    case 'recover':
      return commandRecover(args, context);
    case 'unlock':
      return commandUnlock(args, context);
    case 'projects':
      return commandProjects(args, context);
    case 'rebuild':
      return commandRebuild(args, context);
    case 'import':
      return commandImport(args, context);
    case 'chapters':
      return commandChapters(args, context);
    case 'read':
      return commandRead(args, context);
    case 'export':
      return commandExport(args, context);
    case 'chapter':
      if (args.subcommand === 'add') return commandChapterAdd(args, context);
      if (args.subcommand === 'commit') return commandCommit(args, context);
      if (args.subcommand === 'history') return commandHistory(args, context);
      throw new Error('Usage: ns chapter add|commit|history …');
    case 'commit':
      return commandCommit(args, context);
    case 'history':
      return commandHistory(args, context);
    case 'backup':
      return commandBackup(args, context);
    case 'job':
      return commandJob(args, context);
    case 'narrative':
      return commandNarrative(args, context);
    case 'voice':
      return commandVoice(args, context);
    case 'proposal':
      return commandProposal(args, context);
    case 'studio':
      return commandStudio(args, context);
    default:
      throw new InvalidArgumentError(`Unknown command "${args.command ?? ''}". Run \`ns --help\`.`);
  }
}

function emitResult(result: CommandResult, context: CliContext): void {
  if (context.json) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...result.data }, null, 2)}\n`);
    return;
  }
  process.stdout.write(`${result.human.join('\n')}\n`);
}

function emitError(error: unknown, context: CliContext): number {
  const code = isNarrativeStudioError(error) ? error.code : 'INTERNAL';
  const message = toErrorMessage(error);
  const details = error instanceof NarrativeStudioError ? error.details : {};
  if (context.json) {
    process.stderr.write(
      `${JSON.stringify({ ok: false, error: { code, message, details } }, null, 2)}\n`,
    );
  } else {
    process.stderr.write(`Error (${code}): ${message}\n`);
  }
  return EXIT_CODES[code] ?? 1;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const context = createContext(args);

  if (flagBool(args, 'version') || args.command === 'version') {
    if (context.json) process.stdout.write(`${JSON.stringify({ name: 'narrative-studio', version: '0.1.0' })}\n`);
    else process.stdout.write('Narrative Studio 0.1.0 (Gate 0)\n');
    process.exitCode = 0;
    return;
  }

  if (flagBool(args, 'help') || args.command === null || args.command === 'help') {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 0;
    return;
  }

  try {
    const result = await dispatch(args, context);
    emitResult(result, context);
    process.exitCode = 0;
  } catch (error) {
    process.exitCode = emitError(error, context);
  }
}

void main();
