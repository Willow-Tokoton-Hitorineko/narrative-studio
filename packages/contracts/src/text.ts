/**
 * Text analysis helpers shared by Story Core and projections.
 * Deterministic, dependency-free, and safe for long Chinese manuscripts.
 */

import type { LineEnding, ProjectTextStats, TextEncoding } from './types.js';
import { InvalidArgumentError } from './errors.js';

export interface DecodedText {
  text: string;
  encoding: TextEncoding;
  lineEnding: LineEnding;
  byteLength: number;
}

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

/**
 * Strictly decodes UTF-8. A leading BOM is recorded and stripped from the
 * stored text. Invalid byte sequences are rejected instead of silently
 * replaced (`U+FFFD`), because a silently damaged manuscript is worse than a
 * failed save.
 */
export function decodeUtf8Strict(bytes: Uint8Array): DecodedText {
  const buffer = Buffer.from(bytes);
  const hasBom = buffer.length >= 3 && buffer.subarray(0, 3).equals(UTF8_BOM);
  const body = hasBom ? buffer.subarray(3) : buffer;
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    throw new InvalidArgumentError('File is not valid UTF-8; refusing to import damaged text', {
      byteLength: body.length,
    });
  }
  return {
    text,
    encoding: hasBom ? 'utf-8-bom' : 'utf-8',
    lineEnding: detectLineEnding(text),
    byteLength: body.length,
  };
}

export function encodeUtf8(text: string): Buffer {
  return Buffer.from(text, 'utf8');
}

export function detectLineEnding(text: string): LineEnding {
  if (text.length === 0) return 'none';
  let crlf = 0;
  let loneLf = 0;
  let loneCr = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code === 0x0d) {
      if (i + 1 < text.length && text.charCodeAt(i + 1) === 0x0a) {
        crlf += 1;
        i += 1;
      } else {
        loneCr += 1;
      }
    } else if (code === 0x0a) {
      loneLf += 1;
    }
  }
  const kinds = [crlf > 0, loneLf > 0, loneCr > 0].filter(Boolean).length;
  if (kinds > 1) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (loneLf > 0) return 'lf';
  return 'none';
}

const CJK_PATTERN = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\u3040-\u30ff\uac00-\ud7af]/u;

/**
 * Counts "words" the way a Chinese writer expects: one CJK ideograph counts
 * as one character-word, a Latin run counts as one word, and whitespace is
 * ignored. This is a rough progress metric, not a literary judgement.
 */
export function textStats(text: string): ProjectTextStats {
  let cjk = 0;
  let latinWords = 0;
  let inLatinRun = false;
  let paragraphs = 0;
  let lineHasContent = false;

  for (const char of text) {
    if (char === '\n' || char === '\r') {
      if (lineHasContent) paragraphs += 1;
      lineHasContent = false;
      inLatinRun = false;
      continue;
    }
    if (/\s/u.test(char)) {
      inLatinRun = false;
      continue;
    }
    lineHasContent = true;
    if (CJK_PATTERN.test(char)) {
      cjk += 1;
      inLatinRun = false;
    } else if (/[\p{L}\p{N}]/u.test(char)) {
      if (!inLatinRun) {
        latinWords += 1;
        inLatinRun = true;
      }
    } else {
      inLatinRun = false;
    }
  }
  if (lineHasContent) paragraphs += 1;

  return {
    characters: [...text].length,
    cjk_characters: cjk,
    latin_words: latinWords,
    paragraph_count: paragraphs,
  };
}

/** Human-facing word count: CJK characters + Latin word runs. */
export function wordCount(text: string): number {
  const stats = textStats(text);
  return stats.cjk_characters + stats.latin_words;
}

/** Truncates titles safely for file names without splitting surrogate pairs. */
export function truncateForFileName(name: string, maxLength = 60): string {
  if (name.length <= maxLength) return name;
  return [...name].slice(0, maxLength).join('');
}
