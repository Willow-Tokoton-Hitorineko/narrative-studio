/** Shared constants for the portable Vault layout and app identity. */

export const APP_NAME = 'Narrative Studio';
export const APP_VERSION = '0.1.0';
export const GENERATOR_NAME = 'narrative-studio';

/** File/folder names inside a project directory (portable, human readable). */
export const PROJECT_FILE = 'project.json';
export const MANUSCRIPT_DIR = 'manuscript';
export const STORY_DIR = '.story';
export const MANIFEST_REL_PATH = '.story/manifest.json';
export const OPERATIONS_REL_PATH = '.story/operations/operations.jsonl';
export const APPROVALS_REL_PATH = '.story/approvals/approvals.jsonl';
export const REVISIONS_DIR = '.story/revisions';
export const JOURNAL_DIR = '.story/journal';
export const STAGING_DIR = '.story/staging';
export const ROLLBACK_DIR = '.story/rollback';
export const PROPOSALS_DIR = '.story/proposals';
export const AUDIT_DIR = '.story/audit';
export const RECOVERY_AUDIT_REL_PATH = '.story/audit/recovery.jsonl';
export const LOCK_REL_PATH = '.story/lock';
export const VAULT_FILE = 'vault.json';

export const DEFAULT_VOLUME_ID = 'vol_000001';
export const DEFAULT_LANGUAGE = 'zh-CN';

/** Hard safety limits (not literary limits). */
export const LIMITS = {
  maxRelativePathLength: 400,
  maxSegmentLength: 120,
  maxChapterBytes: 8 * 1024 * 1024,
  maxTitleLength: 200,
  maxMessageLength: 2000,
  maxProjectTitleLength: 120,
  lockStaleAfterMs: 30_000,
} as const;

/** Snapshot (backup/export) metadata file name. */
export const SNAPSHOT_MANIFEST_FILE = 'snapshot-manifest.json';
