import { spawnSync, type SpawnSyncReturns } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
export const CLI_PATH = path.join(REPO_ROOT, 'apps', 'cli', 'dist', 'main.js');
export const FIXTURES = path.join(REPO_ROOT, 'tests', 'fixtures');

export interface Workspace {
  root: string;
  vault: string;
  appdata: string;
  cleanup: () => void;
}

export function assertCliBuilt(): void {
  if (!fs.existsSync(CLI_PATH)) {
    throw new Error(
      `CLI build missing at ${CLI_PATH}. Run \`pnpm build\` before the integration tests.`,
    );
  }
}

/** Creates an isolated temp workspace (optionally with Chinese/space in its path). */
export function createWorkspace(options: { unicodePath?: boolean; label?: string } = {}): Workspace {
  const label = options.label ?? 'ns-test';
  const base = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-`));
  const root = options.unicodePath ? path.join(base, '暮光 港 工作区') : base;
  const vault = path.join(root, 'vault');
  const appdata = path.join(root, 'appdata');
  fs.mkdirSync(vault, { recursive: true });
  fs.mkdirSync(appdata, { recursive: true });
  return {
    root,
    vault,
    appdata,
    cleanup: () => {
      try {
        fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
      } catch {
        /* Windows may hold a transient handle; the OS temp cleaner handles the rest */
      }
    },
  };
}

export interface CliResult<T = Record<string, unknown>> {
  status: number;
  stdout: string;
  stderr: string;
  json: T | null;
  errorCode: string | null;
  raw: SpawnSyncReturns<string>;
}

export interface RunCliOptions {
  env?: Record<string, string | undefined>;
  input?: string | Buffer;
}

export function runCli<T = Record<string, unknown>>(
  args: string[],
  options: RunCliOptions = {},
): CliResult<T> {
  assertCliBuilt();
  const env: Record<string, string | undefined> = {
    ...process.env,
    NS_LOG_LEVEL: 'silent',
    NODE_ENV: 'test',
    ...options.env,
  };
  delete env.NS_FAULT_INJECT;
  delete env.NS_VAULT;
  delete env.NS_PROJECT;
  if (options.env) {
    for (const [key, value] of Object.entries(options.env)) {
      if (value === undefined) delete env[key];
      else env[key] = value;
    }
  }

  const raw = spawnSync(process.execPath, [CLI_PATH, ...args], {
    encoding: 'utf8',
    env: env as NodeJS.ProcessEnv,
    input: options.input,
    timeout: 120_000,
    windowsHide: true,
  });

  const stdout = raw.stdout ?? '';
  const stderr = raw.stderr ?? '';
  let json: unknown = null;
  for (const candidate of [stdout, stderr]) {
    const trimmed = candidate.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) continue;
    try {
      json = JSON.parse(trimmed);
      break;
    } catch {
      /* try the next stream */
    }
  }
  const errorJson = json as { error?: { code?: string } } | null;
  return {
    status: raw.status ?? -1,
    stdout,
    stderr,
    json: (json as T | null) ?? null,
    errorCode: errorJson?.error?.code ?? null,
    raw,
  };
}

export function okJson<T = Record<string, unknown>>(result: CliResult<T>): T {
  if (result.status !== 0) {
    throw new Error(
      `CLI failed (${result.status}):\nstdout: ${result.stdout}\nstderr: ${result.stderr}`,
    );
  }
  if (!result.json) throw new Error(`CLI produced no JSON output: ${result.stdout}${result.stderr}`);
  return result.json;
}

export function initVault(workspace: Workspace, title = '暮光港纪事'): Record<string, unknown> {
  const result = runCli([
    'init',
    '--vault',
    workspace.vault,
    '--title',
    title,
    '--appdata',
    workspace.appdata,
    '--json',
  ]);
  return okJson(result);
}

export function addChapter(
  workspace: Workspace,
  options: { title?: string; file?: string; text?: string; projectId?: string; message?: string },
): Record<string, unknown> {
  const args = [
    'chapter',
    'add',
    '--vault',
    workspace.vault,
    '--appdata',
    workspace.appdata,
    '--title',
    options.title ?? '第一章 潮声',
    '--json',
  ];
  if (options.projectId) args.push('--project', options.projectId);
  if (options.file) args.push('--file', options.file);
  if (options.text !== undefined) args.push('--text', options.text);
  if (options.message) args.push('--message', options.message);
  return okJson(runCli(args));
}

export function fixture(name: string): string {
  return path.join(FIXTURES, 'novel', name);
}

export function readJsonFile<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
}

export function projectDirOf(workspace: Workspace, projectId: string): string {
  return path.join(workspace.vault, projectId);
}

export function listDir(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir);
}
