import { createHash, randomBytes } from 'node:crypto';

/** Stable SHA-256 hex digest for UTF-8 text or raw bytes. */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash('sha256');
  hash.update(input);
  return hash.digest('hex');
}

/** Prefixed digest used in contracts (`sha256:...`). */
export function contentDigest(input: string | Uint8Array): string {
  return `sha256:${sha256Hex(input)}`;
}

export function isContentHash(value: unknown): value is string {
  return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value);
}

export function shortDigest(input: string | Uint8Array, length = 12): string {
  return sha256Hex(input).slice(0, length);
}

/** Deterministic JSON: recursively sorted object keys, stable array order. */
export function stableStringify(value: unknown, indent = 0): string {
  return JSON.stringify(sortValue(value), null, indent);
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) out[key] = sortValue(source[key]);
    return out;
  }
  return value;
}

export function randomHex(bytes = 8): string {
  return randomBytes(bytes).toString('hex');
}

/** Monotonic-ish, collision-resistant transaction id (time base32 + random). */
export function newTransactionId(): string {
  const time = Date.now().toString(36).padStart(9, '0');
  return `txn_${time}${randomHex(4)}`;
}

export function newProjectId(): string {
  return `prj_${randomHex(8)}`;
}

export function newVaultId(): string {
  return `vlt_${randomHex(8)}`;
}

export function newProposalId(): string {
  return `prop_${Date.now().toString(36)}${randomHex(3)}`;
}

export function newVoiceId(prefix: 'vsrc' | 'srule' | 'vprof'): string {
  return `${prefix}_${Date.now().toString(36)}${randomHex(4)}`;
}

export function newNarrativeId(prefix: 'ncan' | 'ent' | 'anc' | 'asr' | 'evt' | 'knw' | 'rel' | 'fsh'): string {
  return `${prefix}_${Date.now().toString(36)}${randomHex(4)}`;
}

export function newImportId(): string {
  return `imp_${Date.now().toString(36)}${randomHex(4)}`;
}

/** Stable chapter id derived from volume + title + ordinal (duplicate titles stay distinct). */
export function chapterIdFor(volumeId: string, title: string, ordinal: number): string {
  return `ch_${shortDigest(`${volumeId}\u0000${title}\u0000${ordinal}`, 16)}`;
}

export function revisionSeqSuffix(seq: number): string {
  return String(seq).padStart(8, '0');
}

export function revisionIdFor(seq: number, contentHash: string): string {
  return `rev_${revisionSeqSuffix(seq)}_${contentHash.replace(/^sha256:/, '').slice(0, 12)}`;
}

/**
 * Chapter-scoped revision id for imports, where several chapters may share the
 * same first-revision content hash (for example two empty chapters).
 */
export function revisionIdForChapter(chapterId: string, seq: number, contentHash: string): string {
  return `rev_${revisionSeqSuffix(seq)}_${shortDigest(`${chapterId}\u0000${contentHash}`, 12)}`;
}

export function operationIdFor(seq: number, resultRevision: string): string {
  return `op_${revisionSeqSuffix(seq)}_${shortDigest(`${seq}\u0000${resultRevision}`, 12)}`;
}

export function approvalIdFor(seq: number, contentHash: string): string {
  return `apr_${revisionSeqSuffix(seq)}_${contentHash.replace(/^sha256:/, '').slice(0, 12)}`;
}

export function snapshotIdFor(kind: 'backup' | 'export'): string {
  const prefix = kind === 'backup' ? 'bk' : 'ex';
  return `snap_${prefix}${Date.now().toString(36)}${randomHex(3)}`;
}

/**
 * Project revision token: `prj_<seq8>_<digest12>`.
 * It changes whenever the authoritative manifest state changes and is the CAS token.
 */
export function projectRevisionToken(seq: number, digest: string): string {
  return `prj_${revisionSeqSuffix(seq)}_${digest.slice(0, 12)}`;
}

export const ID_PATTERNS = {
  project: /^prj_[a-z0-9]{8,32}$/,
  volume: /^vol_[a-z0-9]{6,32}$/,
  chapter: /^ch_[a-z0-9]{8,40}$/,
  revision: /^rev_[0-9]{8}_[0-9a-f]{12}$/,
  operation: /^op_[0-9]{8}_[0-9a-f]{12}$/,
  approval: /^apr_[0-9]{8}_[0-9a-f]{12}$/,
  proposal: /^prop_[a-z0-9]{8,40}$/,
  import: /^imp_[a-z0-9]{8,40}$/,
  narrative: /^(ncan|ent|anc|asr|evt|knw|rel|fsh)_[a-z0-9]{8,40}$/,
  voice: /^(vsrc|srule|vprof)_[a-z0-9]{8,40}$/,
  transaction: /^txn_[a-z0-9]{8,40}$/,
  backup: /^snap_[a-z0-9]{8,40}$/,
  snapshot: /^snap_[a-z0-9]{8,40}$/,
  projectRevision: /^prj_[0-9]{8}_[0-9a-f]{12}$/,
  vault: /^vlt_[a-z0-9]{8,32}$/,
  job: /^job_[a-z0-9]{8,40}$/,
} as const;

export function matchesIdPattern(kind: keyof typeof ID_PATTERNS, value: string): boolean {
  return ID_PATTERNS[kind].test(value);
}
