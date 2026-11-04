import { afterAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  PathOutsideRootError,
  PathUnsafeError,
} from '@narrative-studio/contracts';
import {
  assertLocalFilesystemPath,
  assertSafeRelativePath,
  assertSafeSegment,
  assertSeparatedRoots,
  isUncPath,
  resolveInside,
} from '@narrative-studio/core';

const tempRoots: string[] = [];

function makeTemp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-path-'));
  tempRoots.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempRoots) {
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
    } catch {
      /* best effort on Windows */
    }
  }
});

describe('relative path validation', () => {
  it('accepts normal nested paths, Chinese and spaces', () => {
    expect(assertSafeRelativePath('manuscript/vol_000001/ch_abc.md')).toBe(
      'manuscript/vol_000001/ch_abc.md',
    );
    expect(assertSafeRelativePath('manuscript/卷一 潮声/第一章.md')).toBe(
      'manuscript/卷一 潮声/第一章.md',
    );
  });

  it('rejects traversal, absolute paths, drive letters and UNC paths', () => {
    for (const bad of ['../escape.md', 'a/../../b.md', '/abs.md', 'C:/x.md', 'c:x.md', '//server/share/x.md']) {
      expect(() => assertSafeRelativePath(bad)).toThrow(PathUnsafeError);
    }
  });

  it('rejects Windows-illegal and reserved segments', () => {
    for (const bad of ['a<b.md', 'a>b.md', 'a:b.md', 'a"b.md', 'a|b.md', 'a?b.md', 'a*b.md', 'CON.md', 'nul', 'lpt1.txt', 'trailing.', 'trailing ']) {
      expect(() => assertSafeSegment(bad)).toThrow(PathUnsafeError);
    }
  });

  it('rejects oversized segments and paths', () => {
    expect(() => assertSafeSegment('x'.repeat(200))).toThrow(PathUnsafeError);
    expect(() => assertSafeRelativePath(Array.from({ length: 10 }, () => 'x'.repeat(60)).join('/'))).toThrow(
      PathUnsafeError,
    );
  });

  it('rejects control characters and null bytes', () => {
    expect(() => assertSafeSegment('bad\u0000name')).toThrow(PathUnsafeError);
    expect(() => assertSafeSegment('bad\nname')).toThrow(PathUnsafeError);
  });
});

describe('root containment', () => {
  it('keeps resolved paths inside the project directory', () => {
    const root = makeTemp();
    const resolved = resolveInside(root, 'manuscript/vol_000001/ch_1.md');
    expect(resolved.startsWith(root)).toBe(true);
  });

  it('rejects a directory junction that escapes the root', () => {
    const root = makeTemp();
    const outside = makeTemp();
    const link = path.join(root, 'link');
    fs.symlinkSync(outside, link, 'junction');
    expect(() => resolveInside(root, 'link/evil.md')).toThrow(PathOutsideRootError);
  });

  it('rejects a file symlink that escapes the root', () => {
    const root = makeTemp();
    const outside = makeTemp();
    const secret = path.join(outside, 'secret.md');
    fs.writeFileSync(secret, 'private', 'utf8');
    const link = path.join(root, 'notes.md');
    try {
      fs.symlinkSync(secret, link, 'file');
    } catch {
      return; // symlink creation may be restricted; the junction test still covers the escape
    }
    expect(() => resolveInside(root, 'notes.md')).toThrow(PathOutsideRootError);
  });

  it('refuses UNC runtime paths and overlapping vault/appdata roots', () => {
    expect(isUncPath('\\\\server\\share\\vault')).toBe(true);
    expect(() => assertLocalFilesystemPath('\\\\server\\share\\appdata')).toThrow(PathUnsafeError);
    const vault = makeTemp();
    const appdata = path.join(vault, 'appdata');
    expect(() => assertSeparatedRoots(vault, appdata)).toThrow(PathUnsafeError);
    expect(() => assertSeparatedRoots(vault, makeTemp())).not.toThrow();
  });
});
