import fs from 'node:fs';
import {
  CorruptionError,
  NotFoundError,
  assertContract,
  stableStringify,
  type DomainSchemaName,
} from '@narrative-studio/contracts';

export function readJsonFile(target: string, label: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new NotFoundError(label, { target });
    throw error;
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new CorruptionError(`${label} is not valid JSON`, {
      target,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

export function readJsonContract<T>(target: string, schema: DomainSchemaName, label: string): T {
  return assertContract<T>(schema, readJsonFile(target, label));
}

/** Deterministic, human-diffable JSON bytes for authoritative files. */
export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${stableStringify(value, 2)}\n`, 'utf8');
}

export function stableJsonDigestInput(value: unknown): string {
  return stableStringify(value);
}
