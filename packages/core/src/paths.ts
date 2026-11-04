/**
 * Path safety: every user-supplied identifier or relative path that reaches
 * the filesystem is validated here before use.
 *
 * Threat model for Gate 0: a malformed or hostile chapter/volume id, export
 * path, or a symlink/junction inside the Vault must never cause a write
 * outside the project directory.
 */

import path from 'node:path';
import fs from 'node:fs';
import {
  PathOutsideRootError,
  PathUnsafeError,
} from '@narrative-studio/contracts';
import { LIMITS } from './constants.js';

const DRIVE_PREFIX = /^[a-zA-Z]:/;
// eslint-disable-next-line no-control-regex -- control characters are exactly what must be rejected
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const ILLEGAL_SEGMENT_CHARS = /[<>:"|?*\\/]/;
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function isUncPath(input: string): boolean {
  return /^\\\\/.test(input) || /^\/\//.test(input) || /^\\\\\?\\/.test(input);
}

export function assertSafeSegment(segment: string, label = 'path segment'): string {
  if (typeof segment !== 'string' || segment.length === 0) {
    throw new PathUnsafeError(`${label} must be a non-empty string`, { label, segment });
  }
  if (segment === '.' || segment === '..') {
    throw new PathUnsafeError(`${label} may not be "." or ".."`, { label, segment });
  }
  if (CONTROL_CHARS.test(segment)) {
    throw new PathUnsafeError(`${label} contains control characters`, { label });
  }
  if (ILLEGAL_SEGMENT_CHARS.test(segment)) {
    throw new PathUnsafeError(`${label} contains characters not allowed in Windows paths`, {
      label,
      segment,
    });
  }
  if (WINDOWS_RESERVED.test(segment)) {
    throw new PathUnsafeError(`${label} is a reserved Windows device name`, { label, segment });
  }
  if (/[. ]$/.test(segment)) {
    throw new PathUnsafeError(`${label} may not end with a dot or space`, { label, segment });
  }
  if (segment.length > LIMITS.maxSegmentLength) {
    throw new PathUnsafeError(`${label} is too long (${segment.length} > ${LIMITS.maxSegmentLength})`, {
      label,
    });
  }
  return segment;
}

/** Normalizes separators and rejects absolute, traversal or malformed paths. */
export function assertSafeRelativePath(relativePath: string, label = 'path'): string {
  if (typeof relativePath !== 'string' || relativePath.length === 0) {
    throw new PathUnsafeError(`${label} must be a non-empty relative path`, { label });
  }
  if (DRIVE_PREFIX.test(relativePath)) {
    throw new PathUnsafeError(`${label} may not contain a drive letter`, { label });
  }
  if (isUncPath(relativePath)) {
    throw new PathUnsafeError(`${label} may not be a UNC/network path`, { label });
  }
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/')) {
    throw new PathUnsafeError(`${label} may not be absolute`, { label });
  }
  const segments = normalized.split('/');
  for (const segment of segments) assertSafeSegment(segment, label);
  if (normalized.length > LIMITS.maxRelativePathLength) {
    throw new PathUnsafeError(`${label} is too long (${normalized.length})`, { label });
  }
  return segments.join('/');
}

export function toNativePath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split('/'));
}

function canonicalRoot(root: string): string {
  const resolved = path.resolve(root);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function isInsideLexical(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolves the deepest existing ancestor through `realpath` so a symlink or
 * NTFS junction cannot redirect a write outside the root.
 */
function resolveThroughExistingAncestor(target: string): string {
  let current = path.resolve(target);
  const missing: string[] = [];
  for (;;) {
    try {
      const real = fs.realpathSync.native(current);
      return path.join(real, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(current);
      if (parent === current) return target;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function assertWithinRoot(root: string, target: string, label = 'path'): string {
  const rootCanonical = canonicalRoot(root);
  const targetResolved = path.resolve(target);
  if (!isInsideLexical(rootCanonical, targetResolved)) {
    throw new PathOutsideRootError(`${label} resolves outside of ${rootCanonical}`, {
      root: rootCanonical,
      target: targetResolved,
    });
  }
  const throughLinks = resolveThroughExistingAncestor(targetResolved);
  if (!isInsideLexical(rootCanonical, throughLinks)) {
    throw new PathOutsideRootError(`${label} escapes ${rootCanonical} through a symlink or junction`, {
      root: rootCanonical,
      target: throughLinks,
    });
  }
  return targetResolved;
}

/** Validated absolute path for a vault-relative file, with symlink escape checks. */
export function resolveInside(root: string, relativePath: string, label = 'path'): string {
  const safeRelative = assertSafeRelativePath(relativePath, label);
  const target = toNativePath(canonicalRoot(root), safeRelative);
  return assertWithinRoot(root, target, label);
}

export function isPathInside(root: string, target: string): boolean {
  const rootCanonical = canonicalRoot(root);
  const throughLinks = resolveThroughExistingAncestor(path.resolve(target));
  return isInsideLexical(rootCanonical, throughLinks);
}

/** Device-local runtime data must never live on a UNC share. */
export function assertLocalFilesystemPath(target: string, label = 'path'): string {
  if (isUncPath(target)) {
    throw new PathUnsafeError(`${label} may not be a UNC/network path (${target})`, { label, target });
  }
  return path.resolve(target);
}

/** Keeps the portable Vault and device-local AppDataRoot disjoint. */
export function assertSeparatedRoots(
  vaultRoot: string,
  appDataRoot: string,
): void {
  if (isPathInside(vaultRoot, appDataRoot)) {
    throw new PathUnsafeError('AppDataRoot must not be inside the writing Vault', {
      vaultRoot,
      appDataRoot,
    });
  }
  if (isPathInside(appDataRoot, vaultRoot)) {
    throw new PathUnsafeError('The writing Vault must not be inside AppDataRoot', {
      vaultRoot,
      appDataRoot,
    });
  }
}

export function normalizeRelative(input: string): string {
  return input.replace(/\\/g, '/');
}

export function relativeTo(root: string, target: string): string {
  return normalizeRelative(path.relative(root, target));
}

export function fileNameForTitle(title: string): string {
  const trimmed = title.trim().slice(0, LIMITS.maxSegmentLength - 8);
  const safe = trimmed
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_') // eslint-disable-line no-control-regex
    .replace(/[. ]+$/, '');
  return safe.length > 0 ? safe : 'untitled';
}
