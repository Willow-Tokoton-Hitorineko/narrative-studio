export interface Draft {
  text: string;
  baseRevision: string;
  savedAt: string;
  /** Monotonic edit sequence captured with this text; absent on legacy drafts. */
  seq?: number;
}

const PREFIX = 'narrative-studio.draft';

function key(projectId: string, chapterId: string): string {
  return `${PREFIX}.${projectId}.${chapterId}`;
}

export function readDraft(projectId: string, chapterId: string): Draft | null {
  try {
    const raw = window.localStorage.getItem(key(projectId, chapterId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<Draft>;
    if (typeof parsed.text !== 'string' || typeof parsed.baseRevision !== 'string') return null;
    return {
      text: parsed.text,
      baseRevision: parsed.baseRevision,
      savedAt: typeof parsed.savedAt === 'string' ? parsed.savedAt : new Date().toISOString(),
      seq: typeof parsed.seq === 'number' ? parsed.seq : undefined,
    };
  } catch {
    return null;
  }
}

/** Returns false when the browser storage is unavailable/full. */
export function writeDraft(projectId: string, chapterId: string, draft: Draft): boolean {
  try {
    window.localStorage.setItem(key(projectId, chapterId), JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

export function clearDraft(projectId: string, chapterId: string): void {
  try {
    window.localStorage.removeItem(key(projectId, chapterId));
  } catch {
    /* storage unavailable; nothing to clear */
  }
}

export function clearAllDrafts(projectId: string): void {
  try {
    for (const storageKey of Object.keys(window.localStorage)) {
      if (storageKey.startsWith(`${PREFIX}.${projectId}.`)) window.localStorage.removeItem(storageKey);
    }
  } catch {
    /* ignore */
  }
}
