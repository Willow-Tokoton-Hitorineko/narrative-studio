import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  decodeSource,
  parseManuscript,
  readJsonFile,
  resolveInside,
} from '@narrative-studio/core';
import {
  REPO_ROOT,
  createWorkspace,
  initVault,
  okJson,
  projectDirOf,
  runCli,
  type Workspace,
} from '../helpers/cli.js';

const GENERATOR = path.join(REPO_ROOT, 'tools', 'synthetic-corpus', 'generate.mjs');
const roots: string[] = [];

interface ImportOutput {
  project_id: string;
  import_id: string;
  manifest_revision: string;
  source_sha256: string;
  source_encoding: string;
  chapters: number;
  volumes: number;
  duration_ms: number;
  projection: { ok: boolean; digest?: string };
}

interface ManifestLike {
  revision: string;
  chapters: Record<string, { chapter_id: string; title: string; path: string; content_hash: string; word_count: number; volume_id: string; ordinal: number }>;
}

interface ImportMetadataLike {
  import_id: string;
  source_sha256: string;
  source_encoding: string;
  source_bytes: number;
  raw_path: string;
}

function makeRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ns-import-test-'));
  roots.push(root);
  return root;
}

function readJson<T>(file: string): T {
  return readJsonFile(file, file) as T;
}

function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

function corpus(): string {
  const out = path.join(makeRoot(), 'corpus');
  const result = spawnSync(process.execPath, [GENERATOR, '--out', out, '--seed', '20261020'], {
    encoding: 'utf8',
    timeout: 120_000,
  });
  expect(result.status, result.stderr).toBe(0);
  return out;
}

function importFile(workspace: Workspace, file: string, title = '导入测试', env?: Record<string, string>): ReturnType<typeof runCli> {
  return runCli(
    ['import', '--vault', workspace.vault, '--appdata', workspace.appdata, '--title', title, '--file', file, '--json'],
    env ? { env } : {},
  );
}

function metadataOf(workspace: Workspace, projectId: string, importId: string): ImportMetadataLike {
  const projectDir = projectDirOf(workspace, projectId);
  return readJson<ImportMetadataLike>(path.join(projectDir, '.story', 'imports', importId, 'import.json'));
}

afterAll(() => {
  for (const root of roots.splice(0)) {
    try {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch {
      /* best effort */
    }
  }
});

describe('Gate 1 text import against the synthetic corpus', () => {
  let corpusDir: string;
  let smallPath: string;
  let complexPath: string;
  let longPath: string;
  let workspace: Workspace;
  let imported: ImportOutput;
  let manifest: ManifestLike;
  let sourceBytes: Buffer;

  beforeAll(() => {
    corpusDir = corpus();
    smallPath = path.join(corpusDir, 'small', 'small-novel.md');
    complexPath = path.join(corpusDir, 'complex', 'complex-volumes.md');
    longPath = path.join(corpusDir, 'long', 'long-novel.md');
    workspace = createWorkspace({ unicodePath: true, label: 'ns-import' });
    sourceBytes = fs.readFileSync(smallPath);
    imported = okJson(importFile(workspace, smallPath)) as unknown as ImportOutput;
    manifest = readJson<ManifestLike>(
      path.join(projectDirOf(workspace, imported.project_id), '.story', 'manifest.json'),
    );
  });

  afterAll(() => {
    workspace?.cleanup();
  });

  it('imports the small corpus with counts, encoding and projection', () => {
    expect(imported.chapters).toBe(3);
    expect(imported.volumes).toBe(1);
    expect(imported.source_encoding).toBe('utf-8');
    expect(imported.projection.ok).toBe(true);
    expect(Object.keys(manifest.chapters)).toHaveLength(3);
    const mapped = Object.values(manifest.chapters).sort((left, right) => left.ordinal - right.ordinal);
    expect(mapped.map((chapter) => chapter.title)).toEqual([
      '第一章 潮声',
      '第二章 第九级',
      '第三章 未寄出的信',
    ]);
    expect(mapped.map((chapter) => chapter.ordinal)).toEqual([1, 2, 3]);
    expect(mapped.every((chapter) => chapter.volume_id === 'vol_000001')).toBe(true);
    expect(mapped.every((chapter) => chapter.word_count > 0)).toBe(true);
  });

  it('preserves the untouched source bytes and records their hash', () => {
    const metadata = metadataOf(workspace, imported.project_id, imported.import_id);
    const projectDir = projectDirOf(workspace, imported.project_id);
    const raw = fs.readFileSync(resolveInside(projectDir, metadata.raw_path, 'raw import'));
    expect(raw.equals(sourceBytes)).toBe(true);
    expect(sha256(raw)).toBe(imported.source_sha256);
    expect(metadata.source_sha256).toBe(imported.source_sha256);
    expect(metadata.source_bytes).toBe(sourceBytes.length);
  });

  it('stores chapter bodies exactly as parsed (no Unicode normalization or line-ending rewrite)', () => {
    const decoded = decodeSource(sourceBytes);
    const parsed = parseManuscript(decoded.text);
    const projectDir = projectDirOf(workspace, imported.project_id);
    const manifestNow = readJson<ManifestLike>(path.join(projectDir, '.story', 'manifest.json'));
    const byTitle = new Map(Object.values(manifestNow.chapters).map((chapter) => [chapter.title, chapter]));
    expect(parsed.chapters.length).toBe(3);
    for (const expected of parsed.chapters) {
      const actual = byTitle.get(expected.title);
      expect(actual, expected.title).toBeDefined();
      const text = fs.readFileSync(path.join(projectDir, actual!.path), 'utf8');
      expect(text).toBe(expected.body);
      expect(actual!.content_hash).toBe(`sha256:${createHash('sha256').update(Buffer.from(expected.body, 'utf8')).digest('hex')}`);
    }
  });

  it('exports the original source byte-for-byte and chapter text readably', () => {
    const exportDir = path.join(workspace.root, 'export-small');
    okJson(runCli(['export', '--vault', workspace.vault, '--appdata', workspace.appdata, '--out', exportDir, '--json']));
    const metadata = metadataOf(workspace, imported.project_id, imported.import_id);
    const exportedRaw = fs.readFileSync(path.join(exportDir, metadata.raw_path));
    expect(sha256(exportedRaw)).toBe(imported.source_sha256);
    expect(exportedRaw.equals(sourceBytes)).toBe(true);
    const first = Object.values(manifest.chapters)[0]!;
    const exportedChapter = fs.readFileSync(path.join(exportDir, first.path), 'utf8');
    expect(exportedChapter.length).toBeGreaterThan(0);
  });

  it('keeps edits version-safe while the imported source stays immutable', () => {
    const chapter = Object.values(manifest.chapters)[0]!;
    const edited = path.join(workspace.root, 'edited.md');
    fs.writeFileSync(edited, `${fs.readFileSync(path.join(projectDirOf(workspace, imported.project_id), chapter.path), 'utf8')}\n\n（编辑测试）\n`, 'utf8');
    const commit = okJson(
      runCli([
        'commit',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--chapter',
        chapter.chapter_id,
        '--file',
        edited,
        '--message',
        'editor pass',
        '--json',
      ]),
    ) as { revision_id: string; manifest_revision: string };
    expect(commit.revision_id).toMatch(/^rev_/);
    const history = okJson(
      runCli(['history', '--vault', workspace.vault, '--appdata', workspace.appdata, '--chapter', chapter.chapter_id, '--json']),
    ) as { revisions: unknown[] };
    expect(history.revisions).toHaveLength(2);
    const metadata = metadataOf(workspace, imported.project_id, imported.import_id);
    const raw = fs.readFileSync(resolveInside(projectDirOf(workspace, imported.project_id), metadata.raw_path, 'raw import'));
    expect(sha256(raw)).toBe(imported.source_sha256);
  });

  it('parses complex volumes, duplicate titles, empty chapters and extreme titles', () => {
    const complexWorkspace = createWorkspace({ label: 'ns-import-complex' });
    try {
      const result = okJson(importFile(complexWorkspace, complexPath, '复杂卷章')) as unknown as ImportOutput;
      expect(result.chapters).toBeGreaterThanOrEqual(40);
      expect(result.volumes).toBe(5);
      const projectDir = projectDirOf(complexWorkspace, result.project_id);
      const manifestNow = readJson<ManifestLike>(path.join(projectDir, '.story', 'manifest.json'));
      const chapters = Object.values(manifestNow.chapters);
      expect(chapters.some((chapter) => chapter.title.includes('长'.repeat(200)))).toBe(true);
      const duplicate = chapters.filter((chapter) => chapter.title.endsWith('潮声之前'));
      expect(duplicate.length).toBeGreaterThanOrEqual(2);
      const empty = chapters.find((chapter) => chapter.title.endsWith('空阶'));
      expect(empty).toBeDefined();
      expect(fs.readFileSync(path.join(projectDir, empty!.path), 'utf8').trim()).toBe('');
      expect(Math.max(...chapters.map((chapter) => chapter.word_count))).toBeGreaterThan(15_000);
    } finally {
      complexWorkspace.cleanup();
    }
  });

  it('handles all declared source encodings as equivalent text', () => {
    const variants = [
      ['SmallUtf8', path.join(corpusDir, 'encodings', 'small-utf8-lf.md'), 'utf-8'],
      ['SmallBom', path.join(corpusDir, 'encodings', 'small-utf8-bom-crlf.md'), 'utf-8-bom'],
      ['SmallGb', path.join(corpusDir, 'encodings', 'small-gb18030.txt'), 'gb18030'],
      ['SmallU16', path.join(corpusDir, 'encodings', 'small-utf16le.txt'), 'utf-16le'],
      ['SmallU16Be', path.join(corpusDir, 'encodings', 'small-utf16be-crlf.txt'), 'utf-16be'],
    ] as const;
    for (const [label, file, encoding] of variants) {
      const variantWorkspace = createWorkspace({ label: `ns-import-${label}` });
      try {
        const result = okJson(importFile(variantWorkspace, file, `编码 ${label}`)) as unknown as ImportOutput;
        expect(result.source_encoding).toBe(encoding);
        const projectDir = projectDirOf(variantWorkspace, result.project_id);
        const manifestNow = readJson<ManifestLike>(path.join(projectDir, '.story', 'manifest.json'));
        const first = Object.values(manifestNow.chapters)[0]!;
        const text = fs.readFileSync(path.join(projectDir, first.path), 'utf8');
        expect(text.length).toBeGreaterThan(0);
        const expected = parseManuscript(decodeSource(fs.readFileSync(file)).text).chapters[0]!;
        expect(text).toBe(expected.body);
      } finally {
        variantWorkspace.cleanup();
      }
    }
  });

  it('imports the 450k long corpus within the recorded performance budget', () => {
    const longWorkspace = createWorkspace({ label: 'ns-import-long' });
    try {
      const result = okJson(importFile(longWorkspace, longPath, '长篇导入')) as unknown as ImportOutput;
      expect(result.chapters).toBe(300);
      expect(result.volumes).toBe(6);
      expect(result.duration_ms).toBeLessThan(60_000);
      const projectDir = projectDirOf(longWorkspace, result.project_id);
      const manifestNow = readJson<ManifestLike>(path.join(projectDir, '.story', 'manifest.json'));
      expect(Object.keys(manifestNow.chapters)).toHaveLength(300);
      const metadata = metadataOf(longWorkspace, result.project_id, result.import_id);
      const raw = fs.readFileSync(resolveInside(projectDir, metadata.raw_path, 'raw import'));
      expect(sha256(raw)).toBe(result.source_sha256);
      console.log(`[gate1] long import: ${result.duration_ms} ms, ${result.chapters} chapters, ${result.volumes} volumes`);
    } finally {
      longWorkspace.cleanup();
    }
  });

  it('recovers an interrupted import at FILES_APPLIED', () => {
    const crashWorkspace = createWorkspace({ label: 'ns-import-crash' });
    try {
      // Initialize first so the fault hits the import transaction, not project.init.
      initVault(crashWorkspace, '崩溃导入');
      const crash = importFile(crashWorkspace, smallPath, '崩溃导入', { NS_FAULT_INJECT: 'files_applied' });
      expect(crash.status).not.toBe(0);
      const projectDir = path.join(crashWorkspace.vault, fs.readdirSync(crashWorkspace.vault).find((name) => name.startsWith('prj_')) ?? '');
      expect(fs.readdirSync(path.join(projectDir, '.story', 'journal')).length).toBeGreaterThan(0);
      const recovered = okJson(
        runCli(['recover', '--vault', crashWorkspace.vault, '--appdata', crashWorkspace.appdata, '--json']),
      ) as { outcomes: { action: string }[] };
      expect(['redo', 'rollback']).toContain(recovered.outcomes[0]?.action);
      const verify = okJson(
        runCli(['verify', '--vault', crashWorkspace.vault, '--appdata', crashWorkspace.appdata, '--json']),
      ) as { ok: boolean };
      expect(verify.ok).toBe(true);
    } finally {
      crashWorkspace.cleanup();
    }
  });

  it('backs up and restores an imported project with identical source hash', () => {
    const backupRoot = path.join(workspace.root, 'backups-import');
    const backup = okJson(
      runCli(['backup', 'create', '--vault', workspace.vault, '--appdata', workspace.appdata, '--dest', backupRoot, '--json']),
    ) as { backupDir: string };
    const destVault = path.join(workspace.root, 'restored-import');
    const restored = okJson(
      runCli([
        'backup',
        'restore',
        '--backup',
        backup.backupDir,
        '--dest-vault',
        destVault,
        '--appdata',
        workspace.appdata,
        '--json',
      ]),
    ) as { project_id: string; revision: string; projection: { ok: boolean } };
    expect(restored.projection.ok).toBe(true);
    const restoredProject = projectDirOf({ ...workspace, vault: destVault } as Workspace, restored.project_id);
    const metadata = metadataOf({ ...workspace, vault: destVault } as Workspace, restored.project_id, imported.import_id);
    const raw = fs.readFileSync(resolveInside(restoredProject, metadata.raw_path, 'raw import'));
    expect(sha256(raw)).toBe(imported.source_sha256);
  });

  it('rejects malformed sources with typed errors', () => {
    const bad = createWorkspace({ label: 'ns-import-bad' });
    try {
      for (const name of ['invalid-utf8.bin', 'nul-bytes.txt', 'empty.txt']) {
        const result = importFile(bad, path.join(corpusDir, 'malformed', name), `坏文件 ${name}`);
        expect(result.status).toBe(2);
        expect(result.errorCode).toBe('INVALID_ARGUMENT');
      }
    } finally {
      bad.cleanup();
    }
  });

  it('accepts recoverable oddities (mixed endings, truncated heading, one 200k line) with explicit results', () => {
    const cases = [
      ['mixed-endings.md', 1, 'mixed'],
      ['truncated-heading.md', 1, 'lf'],
      ['huge-line.txt', 1, 'none'],
    ] as const;
    for (const [name, expectedChapters, expectedLineEnding] of cases) {
      const odd = createWorkspace({ label: `ns-import-odd-${name.replace('.', '-')}` });
      try {
        const result = okJson(importFile(odd, path.join(corpusDir, 'malformed', name), `可接受 ${name}`)) as unknown as ImportOutput & {
          line_ending: string;
        };
        expect(result.chapters, name).toBe(expectedChapters);
        expect(result.line_ending, name).toBe(expectedLineEnding);
        const metadata = metadataOf(odd, result.project_id, result.import_id);
        expect(metadata.source_bytes, name).toBe(fs.readFileSync(path.join(corpusDir, 'malformed', name)).length);
      } finally {
        odd.cleanup();
      }
    }
  });

  it('offers a usable read-only CLI workbench (chapters/read) for imported text', () => {
    const chapters = okJson(
      runCli(['chapters', '--vault', workspace.vault, '--appdata', workspace.appdata, '--json']),
    ) as { chapters: { chapter_id: string; title: string }[] };
    expect(chapters.chapters.length).toBeGreaterThan(0);
    const first = chapters.chapters[0]!;
    const read = okJson(
      runCli(['read', '--vault', workspace.vault, '--appdata', workspace.appdata, '--chapter', first.chapter_id, '--json']),
    ) as { content: string };
    expect(read.content.length).toBeGreaterThan(100);
  });
});
