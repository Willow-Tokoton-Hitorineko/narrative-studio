/**
 * Sanitized structured logging.
 *
 * Hard rule (V4.4 privacy invariant): manuscript text, prompts containing
 * manuscript text, API keys and personal data never reach a log file. The
 * logger refuses sensitive field names, hashes long strings, and scrubs common
 * credential shapes even inside free text.
 */

import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsx.js';
import { sanitizedLogsDir } from './appdata.js';

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVEL_ORDER: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

const SENSITIVE_KEY = /(^|[_.-])(api[_-]?key|apikey|auth|authorization|bearer|credential|cookie|password|passwd|secret|session|token|private[_-]?key)($|[_.-])/i;
const CONTENT_KEY = /(manuscript|chapter[_-]?body|content|body|text|prompt|quote|excerpt|draft|novel|fulltext)/i;

const SECRET_PATTERNS: RegExp[] = [
  /sk-[A-Za-z0-9_-]{16,}/g,
  /ghp_[A-Za-z0-9]{20,}/g,
  /AIza[0-9A-Za-z_-]{20,}/g,
  /Bearer\s+[A-Za-z0-9._~+/-]{12,}=*/gi,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/g,
];

const LONG_STRING_LIMIT = 200;
const MAX_DEPTH = 6;

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

export function scrubSecrets(text: string): string {
  let output = text;
  for (const pattern of SECRET_PATTERNS) {
    output = output.replace(pattern, '[redacted-secret]');
  }
  return output;
}

function redactValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return '[max-depth]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') {
    if (value.length > LONG_STRING_LIMIT) {
      return `[redacted-long-text:${value.length}chars]`;
    }
    return scrubSecrets(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: scrubSecrets(value.message) };
  }
  if (Buffer.isBuffer(value)) return `[redacted-buffer:${value.length}bytes]`;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        output[key] = '[redacted]';
      } else if (CONTENT_KEY.test(key)) {
        output[key] = '[redacted-manuscript-text]';
      } else {
        output[key] = redactValue(nested, depth + 1);
      }
    }
    return output;
  }
  return String(value);
}

export function redactRecord(record: Record<string, unknown>): Record<string, unknown> {
  return redactValue(record, 0) as Record<string, unknown>;
}

export interface SanitizedLoggerOptions {
  appDataRoot?: string | null;
  level?: LogLevel;
  projectId?: string | null;
  sink?: ((line: string) => void) | null;
  now?: () => Date;
  maxFileBytes?: number;
}

export class SanitizedLogger {
  readonly level: LogLevel;
  private readonly appDataRoot: string | null;
  private readonly projectId: string | null;
  private readonly sink: ((line: string) => void) | null;
  private readonly now: () => Date;
  private readonly maxFileBytes: number;

  constructor(options: SanitizedLoggerOptions = {}) {
    this.appDataRoot = options.appDataRoot ?? null;
    this.projectId = options.projectId ?? null;
    this.sink = options.sink ?? null;
    this.now = options.now ?? (() => new Date());
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    const envLevel = (process.env.NS_LOG_LEVEL ?? '').toLowerCase();
    const candidate = options.level ?? (envLevel as LogLevel);
    this.level = candidate in LEVEL_ORDER ? candidate : 'info';
  }

  child(fields: { projectId?: string | null }): SanitizedLogger {
    return new SanitizedLogger({
      appDataRoot: this.appDataRoot,
      level: this.level,
      projectId: fields.projectId ?? this.projectId,
      sink: this.sink,
      now: this.now,
      maxFileBytes: this.maxFileBytes,
    });
  }

  debug(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('debug', event, fields);
  }

  info(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('info', event, fields);
  }

  warn(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('warn', event, fields);
  }

  error(event: string, fields: Record<string, unknown> = {}): void {
    this.emit('error', event, fields);
  }

  private emit(level: Exclude<LogLevel, 'silent'>, event: string, fields: Record<string, unknown>): void {
    if (LEVEL_ORDER[this.level] < LEVEL_ORDER[level]) return;
    const record: Record<string, unknown> = {
      ts: this.now().toISOString(),
      level,
      event,
      pid: process.pid,
      ...(this.projectId ? { project_id: this.projectId } : {}),
      ...redactRecord(fields),
    };
    const line = JSON.stringify(record);
    if (this.sink) {
      this.sink(line);
      return;
    }
    if (!this.appDataRoot) return;
    try {
      this.appendToFile(line);
    } catch {
      /* logging must never break a save operation */
    }
  }

  private appendToFile(line: string): void {
    const dir = sanitizedLogsDir(this.appDataRoot as string);
    ensureDir(dir);
    const day = this.now().toISOString().slice(0, 10).replace(/-/g, '');
    const base = path.join(dir, `ns-${day}.jsonl`);
    let target = base;
    for (let index = 1; index < 100; index += 1) {
      let size = 0;
      try {
        size = fs.statSync(target).size;
      } catch {
        size = 0;
      }
      if (size < this.maxFileBytes) break;
      target = path.join(dir, `ns-${day}.${index}.jsonl`);
    }
    fs.appendFileSync(target, `${line}\n`, 'utf8');
  }
}

export const silentLogger = new SanitizedLogger({ level: 'silent' });

export function createLogger(options: SanitizedLoggerOptions = {}): SanitizedLogger {
  return new SanitizedLogger(options);
}
