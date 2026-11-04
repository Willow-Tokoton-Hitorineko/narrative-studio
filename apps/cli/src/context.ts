import { createLogger, resolveAppDataRoot, type SanitizedLogger } from '@narrative-studio/core';
import type { ParsedArgs } from './flags.js';
import { flagBool, flagString } from './flags.js';

export interface CliContext {
  vaultDir: string | null;
  projectId: string | null;
  appDataRoot: string;
  logger: SanitizedLogger;
  json: boolean;
  verbose: boolean;
  now: () => Date;
}

export function createContext(args: ParsedArgs): CliContext {
  const json = flagBool(args, 'json') || !flagBool(args, 'human');
  const vaultDir = flagString(args, 'vault') ?? process.env.NS_VAULT ?? null;
  const projectId = flagString(args, 'project') ?? process.env.NS_PROJECT ?? null;
  const appDataRoot = flagString(args, 'appdata') ?? resolveAppDataRoot();
  const verbose = flagBool(args, 'verbose');
  const quiet = flagBool(args, 'quiet');
  const logger = createLogger({
    appDataRoot,
    level: quiet ? 'error' : verbose ? 'debug' : undefined,
    projectId,
  });
  return {
    vaultDir,
    projectId,
    appDataRoot,
    logger,
    json,
    verbose,
    now: () => new Date(),
  };
}

export function requireVault(context: CliContext): string {
  if (!context.vaultDir) {
    throw new Error('No Vault specified. Pass --vault <dir> or set NS_VAULT.');
  }
  return context.vaultDir;
}
