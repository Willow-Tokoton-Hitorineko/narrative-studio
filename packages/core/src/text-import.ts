/**
 * Gate 1 text import: strict decoding and a conservative chapter parser.
 *
 * The parser stores chapter **bodies** (without heading lines) so an empty
 * chapter is truly empty. The untouched source bytes are preserved separately
 * by the import transaction, which is what proves byte-for-byte provenance.
 */

import {
  InvalidArgumentError,
  detectLineEnding,
  type ImportEncoding,
  type LineEnding,
} from '@narrative-studio/contracts';

const MAX_SOURCE_BYTES = 64 * 1024 * 1024;
const CN_NUMBER = '0-9０-９〇零一二三四五六七八九十百千万两';

const VOLUME_RE = new RegExp(`^第[${CN_NUMBER}]+卷(?:[ \\u3000:：、.．-]*(.*))?$`);
const CHAPTER_RE = new RegExp(`^第[${CN_NUMBER}]+[章回](?:[ \\u3000:：、.．-]*(.*))?$`);
const SPECIAL_CHAPTER_RE = /^(序章|楔子|引子|尾声|终章|后记|番外)(?:[ \u3000:：、.．-]*(.*))?$/;
const MD_HEADING_RE = /^(#{1,3})\s+(.+)$/;

export interface DecodedSource {
  text: string;
  encoding: ImportEncoding;
  lineEnding: LineEnding;
  byteLength: number;
}

export interface ParsedChapter {
  title: string;
  volume_title: string;
  volume_ordinal: number;
  ordinal: number;
  body: string;
  chars: number;
  line_ending: LineEnding;
  source_start: number;
  source_end: number;
}

export interface ParsedManuscript {
  chapters: ParsedChapter[];
  volumes: number;
  chars: number;
  empty_chapters: number;
  duplicate_titles: number;
  format: 'plain' | 'markdown';
}

function decodeWith(bytes: Uint8Array, encoding: string, fatal = true): string {
  return new TextDecoder(encoding, { fatal }).decode(bytes);
}

function utf8Bom(bytes: Buffer): boolean {
  return bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function utf16Bom(bytes: Buffer): 'utf-16le' | 'utf-16be' | null {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return 'utf-16le';
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return 'utf-16be';
  return null;
}

function looksLikeUtf16Le(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 400));
  let zeroOdd = 0;
  let zeroEven = 0;
  for (let index = 0; index < sample.length; index += 1) {
    if (sample[index] === 0) {
      if (index % 2 === 0) zeroEven += 1;
      else zeroOdd += 1;
    }
  }
  const half = Math.max(1, Math.floor(sample.length / 2));
  return zeroOdd / half > 0.25 && zeroEven / half < 0.05;
}

/**
 * Decodes UTF-8, UTF-8 BOM, UTF-16LE/BE and GB18030. Unknown or invalid byte
 * streams are rejected rather than silently replaced with U+FFFD.
 */
export function decodeSource(input: Uint8Array): DecodedSource {
  const bytes = Buffer.from(input);
  if (bytes.length === 0) {
    throw new InvalidArgumentError('The source file is empty');
  }
  if (bytes.length > MAX_SOURCE_BYTES) {
    throw new InvalidArgumentError(`Source file is too large (${bytes.length} bytes)`);
  }

  let text: string;
  let encoding: ImportEncoding | null = null;
  const bom16 = utf16Bom(bytes);
  try {
    if (utf8Bom(bytes)) {
      text = decodeWith(bytes.subarray(3), 'utf-8');
      encoding = 'utf-8-bom';
    } else if (bom16 === 'utf-16le') {
      text = decodeWith(bytes.subarray(2), 'utf-16le');
      encoding = 'utf-16le';
    } else if (bom16 === 'utf-16be') {
      text = decodeWith(bytes.subarray(2), 'utf-16be');
      encoding = 'utf-16be';
    } else if (looksLikeUtf16Le(bytes)) {
      text = decodeWith(bytes, 'utf-16le');
      encoding = 'utf-16le';
    } else {
      try {
        text = decodeWith(bytes, 'utf-8');
        encoding = 'utf-8';
      } catch {
        try {
          text = decodeWith(bytes, 'gb18030');
          encoding = 'gb18030';
        } catch {
          throw new InvalidArgumentError(
            'Source is not valid UTF-8, UTF-16 or GB18030; refusing to import damaged text',
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof InvalidArgumentError) throw error;
    throw new InvalidArgumentError(
      `Could not decode the source (${encoding ?? 'unknown'}): ${(error as Error).message}`,
    );  }

  if (text.includes('\u0000')) {
    throw new InvalidArgumentError('Source contains NUL bytes; refusing to import binary/damaged text');
  }
  return {
    text,
    encoding,
    lineEnding: detectLineEnding(text),
    byteLength: bytes.length,
  };
}

function classifyLine(rawLine: string): { kind: 'volume' | 'chapter'; title: string } | null {
  const line = rawLine.trim();
  if (line.length === 0) return null;

  const markdown = MD_HEADING_RE.exec(line);
  if (markdown) {
    const title = markdown[2]?.trim() ?? '';
    if (markdown[1] === '##' || CHAPTER_RE.test(title) || SPECIAL_CHAPTER_RE.test(title)) {
      return { kind: 'chapter', title };
    }
    return { kind: 'volume', title };
  }
  if (VOLUME_RE.test(line)) return { kind: 'volume', title: line };
  if (CHAPTER_RE.test(line) || SPECIAL_CHAPTER_RE.test(line)) return { kind: 'chapter', title: line };
  return null;
}

interface LineEntry {
  line: string;
  start: number;
  end: number;
}

function linesOf(text: string): LineEntry[] {
  const lines: LineEntry[] = [];
  const pattern = /^([^\r\n]*)(\r\n|\n|\r|$)/gm;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    if (match[0].length === 0) break;
    lines.push({ line: match[1] ?? '', start: match.index, end: match.index + match[0].length });
  }
  return lines;
}

function bodyLineEnding(body: string): LineEnding {
  return detectLineEnding(body);
}

function normalizeHashTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed.length === 0) return '未命名章节';
  if (trimmed.length > 300) {
    throw new InvalidArgumentError(`Chapter title is longer than 300 characters: ${trimmed.slice(0, 24)}…`);
  }
  return trimmed;
}

/**
 * Splits a decoded manuscript into volumes and chapters by headings.
 *
 * Rules:
 *  - `第N卷 …` / `# …` (non-chapter) starts a volume.
 *  - `第N章|回 …`, `序章|楔子|引子|尾声|终章|后记|番外 …`, and `## …` start a chapter.
 *  - Document order is authoritative; out-of-order chapter numbers are preserved as text.
 *  - Chapter body excludes the heading line and ends where the next heading starts.
 *  - Text before the first heading becomes an “开篇” chapter when non-empty.
 */
export function parseManuscript(text: string): ParsedManuscript {
  if (text.trim().length === 0) {
    throw new InvalidArgumentError('The source contains no readable text');
  }
  const lines = linesOf(text);
  const chapters: ParsedChapter[] = [];
  let format: ParsedManuscript['format'] = 'plain';
  let currentVolume = { ordinal: 1, title: '正文' };
  let volumeSeen = false;
  let volumeMax = 1;
  const ordinalByVolume = new Map<number, number>();
  let open: { title: string; volumeOrdinal: number; volumeTitle: string; ordinal: number; bodyStart: number } | null = null;
  let firstHeadingStart: number | null = null;

  const close = (end: number): void => {
    if (!open) return;
    const body = text.slice(open.bodyStart, end);
    chapters.push({
      title: open.title,
      volume_title: open.volumeTitle,
      volume_ordinal: open.volumeOrdinal,
      ordinal: open.ordinal,
      body,
      chars: [...body].length,
      line_ending: bodyLineEnding(body),
      source_start: open.bodyStart,
      source_end: end,
    });
    open = null;
  };

  for (const entry of lines) {
    const heading = classifyLine(entry.line);
    if (!heading) continue;
    if (heading.kind === 'volume') {
      if (firstHeadingStart === null) firstHeadingStart = entry.start;
      close(entry.start);
      if (volumeSeen) {
        currentVolume = { ordinal: volumeMax + 1, title: normalizeVolumeTitle(heading.title) };
        volumeMax += 1;
      } else {
        currentVolume = { ordinal: 1, title: normalizeVolumeTitle(heading.title) };
        volumeSeen = true;
      }
      continue;
    }

    if (entry.line.trim().startsWith('##')) format = 'markdown';
    if (firstHeadingStart === null) firstHeadingStart = entry.start;
    close(entry.start);
    const ordinal = (ordinalByVolume.get(currentVolume.ordinal) ?? 0) + 1;
    ordinalByVolume.set(currentVolume.ordinal, ordinal);
    open = {
      title: normalizeHashTitle(heading.title),
      volumeOrdinal: currentVolume.ordinal,
      volumeTitle: currentVolume.title,
      ordinal,
      bodyStart: entry.end,
    };
  }
  close(text.length);

  if (chapters.length === 0) {
    chapters.push({
      title: '正文',
      volume_title: currentVolume.title,
      volume_ordinal: 1,
      ordinal: 1,
      body: text,
      chars: [...text].length,
      line_ending: bodyLineEnding(text),
      source_start: 0,
      source_end: text.length,
    });
  } else if (firstHeadingStart !== null && firstHeadingStart > 0) {
    const preface = text.slice(0, firstHeadingStart);
    if (preface.trim().length > 0) {
      chapters.unshift({
        title: '开篇',
        volume_title: '正文',
        volume_ordinal: 1,
        ordinal: 0,
        body: preface,
        chars: [...preface].length,
        line_ending: bodyLineEnding(preface),
        source_start: 0,
        source_end: firstHeadingStart,
      });
    }
  }

  const titles = new Map<string, number>();
  for (const chapter of chapters) titles.set(chapter.title, (titles.get(chapter.title) ?? 0) + 1);
  const duplicateTitles = [...titles.values()].filter((count) => count > 1).length;
  const volumeOrdinals = new Set(chapters.map((chapter) => chapter.volume_ordinal));
  return {
    chapters,
    volumes: Math.max(volumeMax, volumeOrdinals.size),
    chars: [...text].length,
    empty_chapters: chapters.filter((chapter) => chapter.body.trim().length === 0).length,
    duplicate_titles: duplicateTitles,
    format,
  };
}

function normalizeVolumeTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed.length > 0 ? trimmed : '正文';
}

export function volumeIdFor(ordinal: number): string {
  return `vol_${String(ordinal).padStart(6, '0')}`;
}
