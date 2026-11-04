import fs from 'node:fs';
import { InvalidArgumentError } from '@narrative-studio/contracts';
import type { ParsedArgs } from './flags.js';
import { flagBool, flagString } from './flags.js';

/**
 * Reads chapter content from `--file <path>` (or `-`), `--stdin`, or `--text`.
 * Bytes are passed through unchanged so encoding/line-ending detection happens
 * once, inside Story Core, and never silently normalises the author's text.
 */
export function readContent(args: ParsedArgs): Buffer {
  const sources = [flagString(args, 'file') !== null, flagBool(args, 'stdin'), flagString(args, 'text') !== null].filter(
    Boolean,
  );
  if (sources.length === 0) {
    throw new InvalidArgumentError('Provide chapter content with --file <path>, --stdin, or --text <string>');
  }
  if (sources.length > 1) {
    throw new InvalidArgumentError('Use only one of --file, --stdin, --text');
  }
  const file = flagString(args, 'file');
  if (file !== null) {
    if (file === '-') return fs.readFileSync(0);
    return fs.readFileSync(file);
  }
  if (flagBool(args, 'stdin')) return fs.readFileSync(0);
  const text = flagString(args, 'text');
  if (text === null) throw new InvalidArgumentError('Missing --text');
  return Buffer.from(text, 'utf8');
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}
