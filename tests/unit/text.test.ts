import { describe, expect, it } from 'vitest';
import {
  InvalidArgumentError,
  chapterIdFor,
  contentDigest,
  decodeUtf8Strict,
  detectLineEnding,
  encodeUtf8,
  operationIdFor,
  projectRevisionToken,
  revisionIdFor,
  sha256Hex,
  stableStringify,
  textStats,
  wordCount,
} from '@narrative-studio/contracts';
import { computeManifestRevision } from '@narrative-studio/core';

describe('UTF-8 and line ending handling', () => {
  it('decodes UTF-8 with BOM and records it', () => {
    const bytes = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('潮声\r\n', 'utf8')]);
    const decoded = decodeUtf8Strict(bytes);
    expect(decoded.encoding).toBe('utf-8-bom');
    expect(decoded.lineEnding).toBe('crlf');
    expect(decoded.text.startsWith('潮声')).toBe(true);
  });

  it('rejects invalid UTF-8 instead of replacing characters', () => {
    expect(() => decodeUtf8Strict(Buffer.from([0xff, 0xfe, 0xfd]))).toThrow(InvalidArgumentError);
  });

  it('classifies line endings', () => {
    expect(detectLineEnding('')).toBe('none');
    expect(detectLineEnding('a\nb\n')).toBe('lf');
    expect(detectLineEnding('a\r\nb\r\n')).toBe('crlf');
    expect(detectLineEnding('a\r\nb\nc')).toBe('mixed');
  });

  it('preserves CRLF bytes exactly through encode/decode', () => {
    const source = '第一行\r\n第二行\r\n';
    const decoded = decodeUtf8Strict(encodeUtf8(source));
    expect(decoded.text).toBe(source);
    expect(decoded.lineEnding).toBe('crlf');
  });
});

describe('Chinese-aware word counting', () => {
  it('counts CJK characters and Latin word runs', () => {
    const stats = textStats('林知远站在灯塔下。\nThe tide is high.\n');
    expect(stats.cjk_characters).toBeGreaterThanOrEqual(8);
    expect(stats.latin_words).toBe(4);
    expect(stats.paragraph_count).toBe(2);
    expect(wordCount('你好 world')).toBe(3);
  });

  it('treats an empty chapter as zero words', () => {
    expect(wordCount('')).toBe(0);
    expect(textStats('').paragraph_count).toBe(0);
  });
});

describe('deterministic hashing and ids', () => {
  it('stableStringify sorts nested keys', () => {
    expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('content hash has the contract shape', () => {
    expect(contentDigest('潮声')).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('chapter ids stay distinct for duplicate titles', () => {
    const first = chapterIdFor('vol_000001', '第一章', 1);
    const second = chapterIdFor('vol_000001', '第一章', 2);
    expect(first).not.toBe(second);
    expect(first).toMatch(/^ch_[a-z0-9]{8,40}$/);
    expect(chapterIdFor('vol_000001', '第一章', 1)).toBe(first);
  });

  it('revision and operation ids follow their patterns', () => {
    expect(revisionIdFor(3, `sha256:${'b'.repeat(64)}`)).toBe('rev_00000003_bbbbbbbbbbbb');
    expect(operationIdFor(3, 'prj_00000003_cccccccccccc')).toMatch(/^op_00000003_[0-9a-f]{12}$/);
    expect(projectRevisionToken(7, 'd'.repeat(64))).toBe('prj_00000007_dddddddddddd');
  });

  it('hash helpers are stable across calls', () => {
    expect(sha256Hex('暮光港')).toBe(sha256Hex('暮光港'));
  });
});

describe('manifest revision digest', () => {
  const chapters = {
    ch_0123456789abcdef: {
      chapter_id: 'ch_0123456789abcdef',
      volume_id: 'vol_000001',
      title: '第一章',
      ordinal: 1,
      current_revision_id: 'rev_00000001_aaaaaaaaaaaa',
      content_hash: `sha256:${'a'.repeat(64)}`,
      word_count: 10,
      revision_seq: 1,
      path: 'manuscript/vol_000001/ch_0123456789abcdef.md',
      created_at: '2026-10-20T00:00:00.000Z',
      updated_at: '2026-10-20T00:00:00.000Z',
    },
  };
  const files = {
    'project.json': { sha256: 'a'.repeat(64), size: 10 },
    '.story/operations/operations.jsonl': { sha256: 'b'.repeat(64), size: 20 },
  };

  it('is deterministic and independent of the operations log hash', () => {
    const one = computeManifestRevision({ seq: 2, projectId: 'prj_0123456789abcdef', chapters, files });
    const two = computeManifestRevision({ seq: 2, projectId: 'prj_0123456789abcdef', chapters, files });
    expect(one).toBe(two);
    const differentOps = {
      ...files,
      '.story/operations/operations.jsonl': { sha256: 'c'.repeat(64), size: 30 },
    };
    expect(computeManifestRevision({ seq: 2, projectId: 'prj_0123456789abcdef', chapters, files: differentOps })).toBe(
      one,
    );
  });

  it('changes when an authoritative file or the sequence changes', () => {
    const base = computeManifestRevision({ seq: 2, projectId: 'prj_0123456789abcdef', chapters, files });
    const newFile = computeManifestRevision({
      seq: 2,
      projectId: 'prj_0123456789abcdef',
      chapters,
      files: { ...files, 'manuscript/vol_000001/ch_0123456789abcdef.md': { sha256: 'd'.repeat(64), size: 12 } },
    });
    const newSeq = computeManifestRevision({ seq: 3, projectId: 'prj_0123456789abcdef', chapters, files });
    expect(newFile).not.toBe(base);
    expect(newSeq).not.toBe(base);
  });
});
