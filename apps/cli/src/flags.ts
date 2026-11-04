/** Minimal, dependency-free flag parser for the `ns` CLI. */

export type FlagValue = string | boolean;

export interface ParsedArgs {
  command: string | null;
  subcommand: string | null;
  flags: Record<string, FlagValue>;
  positionals: string[];
  argv: string[];
}

const SUBCOMMAND_COMMANDS = new Set(['chapter', 'backup', 'job', 'proposal', 'narrative']);

export const BOOLEAN_FLAGS = new Set([
  'json',
  'human',
  'help',
  'version',
  'verbose',
  'quiet',
  'repair',
  'force',
  'stdin',
  'without-history',
  'dry-run',
  'all',
  'full',
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const flags: Record<string, FlagValue> = {};
  const positionals: string[] = [];
  let command: string | null = null;
  let subcommand: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === undefined) continue;
    if (token === '--') {
      for (const rest of argv.slice(index + 1)) positionals.push(rest);
      break;
    }
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        flags[body.slice(0, equals)] = body.slice(equals + 1);
        continue;
      }
      if (BOOLEAN_FLAGS.has(body)) {
        flags[body] = true;
        continue;
      }
      const next = argv[index + 1];
      if (next !== undefined && !next.startsWith('-')) {
        flags[body] = next;
        index += 1;
      } else {
        flags[body] = true;
      }
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      flags[token.slice(1)] = true;
      continue;
    }
    if (command === null) {
      command = token;
      continue;
    }
    if (subcommand === null && command !== null && SUBCOMMAND_COMMANDS.has(command)) {
      subcommand = token;
      continue;
    }
    positionals.push(token);
  }

  return { command, subcommand, flags, positionals, argv };
}

export function flagString(args: ParsedArgs, name: string): string | null {
  const value = args.flags[name];
  return typeof value === 'string' ? value : null;
}

export function flagBool(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true;
}

export function requireFlag(args: ParsedArgs, name: string, hint?: string): string {
  const value = flagString(args, name);
  if (value === null || value.trim().length === 0) {
    throw new Error(`Missing required option --${name}${hint ? ` (${hint})` : ''}`);
  }
  return value;
}

export function optionalNumber(args: ParsedArgs, name: string): number | null {
  const value = flagString(args, name);
  if (value === null) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`Option --${name} must be a number`);
  return parsed;
}
