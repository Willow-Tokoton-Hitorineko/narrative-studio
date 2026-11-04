/**
 * Manifest: the authoritative head of a project.
 *
 * `manifest.revision` is the CAS token. It is derived from the commit sequence,
 * the chapter index and the SHA-256 of every authoritative file *except* the
 * append-only operation log (whose newest line contains this very token, so it
 * cannot take part in its own digest). The operation log is still covered by
 * the manifest's `files` hash map, and `doctor`/`verify` check it.
 */

import path from 'node:path';
import {
  SCHEMA_VERSION,
  VAULT_SCHEMA_VERSION,
  CorruptionError,
  assertContract,
  projectRevisionToken,
  sha256Hex,
  stableStringify,
  type Manifest,
  type ManifestChapterEntry,
  type ManifestFileEntry,
} from '@narrative-studio/contracts';
import { MANIFEST_REL_PATH, OPERATIONS_REL_PATH, APP_NAME, APP_VERSION } from './constants.js';
import { fileInfo, pathExists, sha256File, writeFileAtomic, walkRelativeFiles, readFileBytes } from './fsx.js';
import { readJsonContract, jsonBytes } from './json.js';
import { resolveInside } from './paths.js';

export interface BuildManifestInput {
  projectId: string;
  title: string;
  seq: number;
  headRevision: string | null;
  chapters: Record<string, ManifestChapterEntry>;
  files: Record<string, ManifestFileEntry>;
  createdAt: string;
  updatedAt: string;
}

export function filesForDigest(files: Record<string, ManifestFileEntry>): Record<string, ManifestFileEntry> {
  const output: Record<string, ManifestFileEntry> = {};
  for (const [key, value] of Object.entries(files)) {
    if (key === OPERATIONS_REL_PATH) continue;
    output[key] = value;
  }
  return output;
}

export function computeManifestRevision(input: {
  seq: number;
  projectId: string;
  chapters: Record<string, ManifestChapterEntry>;
  files: Record<string, ManifestFileEntry>;
}): string {
  const payload = stableStringify({
    schema_version: SCHEMA_VERSION,
    project_id: input.projectId,
    seq: input.seq,
    chapters: input.chapters,
    files: filesForDigest(input.files),
  });
  return projectRevisionToken(input.seq, sha256Hex(payload));
}

export function buildManifest(input: BuildManifestInput): Manifest {
  const revision = computeManifestRevision({
    seq: input.seq,
    projectId: input.projectId,
    chapters: input.chapters,
    files: input.files,
  });
  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    vault_schema_version: VAULT_SCHEMA_VERSION,
    project_id: input.projectId,
    title: input.title,
    seq: input.seq,
    revision,
    head_revision: input.headRevision,
    created_at: input.createdAt,
    updated_at: input.updatedAt,
    generator: {
      name: APP_NAME,
      version: APP_VERSION,
      node: process.version,
    },
    chapters: input.chapters,
    files: input.files,
  };
  return assertContract<Manifest>('manifest', manifest);
}

export function manifestPath(projectDir: string): string {
  return resolveInside(projectDir, MANIFEST_REL_PATH, 'manifest path');
}

export function readManifest(projectDir: string): Manifest {
  const target = manifestPath(projectDir);
  const manifest = readJsonContract<Manifest>(target, 'manifest', 'Project manifest');
  const expected = computeManifestRevision({
    seq: manifest.seq,
    projectId: manifest.project_id,
    chapters: manifest.chapters,
    files: manifest.files,
  });
  if (expected !== manifest.revision) {
    throw new CorruptionError('Manifest revision token does not match its own contents', {
      expected,
      actual: manifest.revision,
      manifest: target,
    });
  }
  return manifest;
}

export function manifestExists(projectDir: string): boolean {
  return pathExists(manifestPath(projectDir));
}

export function manifestBytes(manifest: Manifest): Buffer {
  return jsonBytes(manifest);
}

export function writeManifestDurable(projectDir: string, manifest: Manifest): void {
  writeFileAtomic(manifestPath(projectDir), manifestBytes(manifest));
}

export function manifestFileEntry(projectDir: string, relativePath: string): ManifestFileEntry | null {
  const target = resolveInside(projectDir, relativePath, 'manifest file entry');
  const info = fileInfo(target);
  if (!info) return null;
  return { sha256: info.sha256, size: info.size };
}

export function computeFileEntry(_relativePath: string, bytes: Uint8Array): ManifestFileEntry {
  const buffer = Buffer.from(bytes);
  return { sha256: sha256Hex(buffer), size: buffer.length };
}

export interface ManifestVerification {
  ok: boolean;
  checked: number;
  missing: string[];
  mismatched: { relPath: string; expected: string; actual: string | null }[];
  extra: string[];
  manifestPath: string;
}

const VERIFIABLE_ROOTS = ['manuscript/', '.story/revisions/', '.story/operations/', '.story/approvals/'];
const IGNORED_EXTRA = ['.story/lock', '.story/journal/', '.story/staging/', '.story/rollback/', '.story/audit/', '.story/proposals/'];

/**
 * Re-hashes every record in the manifest. Read-only; never repairs. This is the
 * primitive `doctor` and `export` use to prove the Vault still matches its head.
 */
export function verifyManifest(projectDir: string, manifest: Manifest): ManifestVerification {
  const missing: string[] = [];
  const mismatched: ManifestVerification['mismatched'] = [];
  let checked = 0;

  for (const relPath of Object.keys(manifest.files).sort()) {
    const entry = manifest.files[relPath];
    if (!entry) continue;
    const target = resolveInside(projectDir, relPath, `manifest file ${relPath}`);
    const bytes = readFileBytes(target);
    checked += 1;
    if (bytes === null) {
      missing.push(relPath);
      continue;
    }
    const actual = sha256File(target);
    if (actual !== entry.sha256) {
      mismatched.push({ relPath, expected: entry.sha256, actual });
    }
  }

  const tracked = new Set(Object.keys(manifest.files));
  tracked.add(MANIFEST_REL_PATH);
  const extra: string[] = [];
  for (const relative of walkRelativeFiles(projectDir)) {
    if (tracked.has(relative)) continue;
    if (IGNORED_EXTRA.some((prefix) => relative.startsWith(prefix))) continue;
    if (relative === '.story/lock') continue;
    if (VERIFIABLE_ROOTS.some((prefix) => relative.startsWith(prefix))) extra.push(relative);
  }

  return {
    ok: missing.length === 0 && mismatched.length === 0,
    checked,
    missing,
    mismatched,
    extra,
    manifestPath: path.join(projectDir, MANIFEST_REL_PATH),
  };
}

export function assertManifestFileHashes(
  projectDir: string,
  manifest: Manifest,
  label = 'Vault integrity',
): void {
  const verification = verifyManifest(projectDir, manifest);
  if (!verification.ok) {
    throw new CorruptionError(`${label} check failed`, {
      missing: verification.missing,
      mismatched: verification.mismatched,
    });
  }
}
