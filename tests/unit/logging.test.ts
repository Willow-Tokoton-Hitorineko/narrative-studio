import { describe, expect, it } from 'vitest';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  SanitizedLogger,
  looksLikeSecret,
  redactRecord,
  scrubSecrets,
} from '@narrative-studio/core';

const buildFakeKey = (fingerprint: string): string => ['sk', fingerprint, 'abcdefghijklmnopqrstuvwxyz'].join('-');

describe('sanitized logging', () => {
  it('redacts manuscript text, secrets and long strings', () => {
    const redacted = redactRecord({
      content: '林知远的秘密手稿正文不该进日志',
      chapter_body: '另一段正文',
      api_key: buildFakeKey('live'),
      authorization: 'Bearer abcdefghijklmnop',
      note: buildFakeKey('ant'),
      long_text: 'x'.repeat(500),
      safe_count: 12,
    });
    const serialized = JSON.stringify(redacted);
    expect(serialized).not.toContain('林知远');
    expect(serialized).not.toContain('另一段正文');
    expect(serialized).not.toContain(buildFakeKey('live'));
    expect(serialized).not.toContain('Bearer');
    expect(serialized).not.toContain('x'.repeat(40));
    expect(serialized).toContain('[redacted-manuscript-text]');
    expect(serialized).toContain('[redacted]');
    expect(serialized).toContain('safe_count');
  });

  it('scrubs credential shapes inside free text', () => {
    const fake = buildFakeKey('test');
    expect(looksLikeSecret(`token ${fake}`)).toBe(true);
    expect(scrubSecrets(`key=${fake}`)).toContain('[redacted-secret]');
    expect(scrubSecrets('ordinary sentence about 潮声')).toBe('ordinary sentence about 潮声');
  });

  it('writes structured JSONL without ever storing the manuscript', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-log-'));
    try {
      const logger = new SanitizedLogger({ appDataRoot: root, level: 'debug' });
      logger.info('chapter.commit', {
        chapter_id: 'ch_0123456789abcdef',
        content: '这是绝不能被写进日志的小说正文。',
        token: buildFakeKey('test'),
        words: 12,
      });
      const logsDir = path.join(root, 'sanitized-logs');
      const files = fs.readdirSync(logsDir);
      expect(files.length).toBe(1);
      const raw = fs.readFileSync(path.join(logsDir, files[0] as string), 'utf8');
      expect(raw).not.toContain('绝不能被写进日志');
      expect(raw).not.toContain(buildFakeKey('test'));
      expect(raw).toContain('chapter.commit');
      expect(raw).toContain('ch_0123456789abcdef');
      const parsed = JSON.parse(raw.trim().split('\n')[0] as string) as Record<string, unknown>;
      expect(parsed.level).toBe('info');
      expect(parsed.pid).toBe(process.pid);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('respects the silent level', () => {
    const lines: string[] = [];
    const logger = new SanitizedLogger({ level: 'silent', sink: (line) => lines.push(line) });
    logger.error('boom', { detail: 'x' });
    expect(lines).toHaveLength(0);
  });
});
