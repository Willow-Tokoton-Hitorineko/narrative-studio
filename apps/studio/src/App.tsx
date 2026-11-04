import {resolvePromptTarget} from './prompt-scope';
import EditorToolbar from './EditorToolbar';
import AtelierArt,{AtelierPortrait,AtelierToggle,useAtelierArt} from './AtelierArt';
import {editorText,editorOffset,sourceRange,editorAiRanges} from './source-coordinates';
import AutoMenu from './AutoMenu';
import {type WritingAnchor} from './writing-target';
import BookLibrary from './BookLibrary';
import CoWriting, {textHash} from './CoWriting';
import BookWorkspace from './BookWorkspace';
import FileActions from './FileActions';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { diffLines } from 'diff';
import Editor, { type EditorHandle } from './Editor';
import NarrativePanel from './NarrativePanel';
import VoiceAtelier from './VoiceAtelier';
import EditorialDrawer from './EditorialDrawer';
import GrowthDrawer from './GrowthDrawer';
import PlanningDrawer from './PlanningDrawer';
import ContinuationDrawer from './ContinuationDrawer';
import LiteraryDrawer from './LiteraryDrawer';
import {
  ApiError,
  api,
  type Bootstrap,
  type ChapterPayload,
  type ChapterSummary,
  type RevisionSummary,
} from './api';
import { clearDraft, readDraft, writeDraft, type Draft } from './drafts';
import { applyTheme, preferredTheme, type Theme } from './theme';

type SaveState = 'saved' | 'dirty' | 'saving' | 'error' | 'conflict';

interface ChapterSession {
  text: string;
  baseRevision: string;
  dirty: boolean;
  seq: number;
}

interface DraftNotice {
  draft: Draft;
  stale: boolean;
}

interface DraftDiff {
  draft: Draft;
  current: string;
}

interface CompareState {
  revision: RevisionSummary;
  content: string;
}

interface PendingDraft {
  projectId: string;
  chapterId: string;
  text: string;
  baseRevision: string;
  seq: number;
}

interface Typography {
  size: number;
  leading: number;
  measure: number;
  indent: boolean;
  font: 'serif' | 'sans';
}

const TYPOGRAPHY_KEY = 'narrative-studio.typography';
const DEFAULT_TYPOGRAPHY: Typography = { size: 17, leading: 1.95, measure: 820, indent: false, font: 'serif' };

function readTypography(): Typography {
  try {
    const raw = window.localStorage.getItem(TYPOGRAPHY_KEY);
    if (!raw) return DEFAULT_TYPOGRAPHY;
    const parsed = JSON.parse(raw) as Partial<Typography>;
    return {
      size: typeof parsed.size === 'number' ? Math.min(20, Math.max(15, parsed.size)) : DEFAULT_TYPOGRAPHY.size,
      leading: typeof parsed.leading === 'number' ? Math.min(2.2, Math.max(1.7, parsed.leading)) : DEFAULT_TYPOGRAPHY.leading,
      measure: typeof parsed.measure === 'number' ? Math.min(860, Math.max(620, parsed.measure)) : DEFAULT_TYPOGRAPHY.measure,
      indent: parsed.indent === true,
      font: parsed.font === 'sans' ? 'sans' : 'serif',
    };
  } catch {
    return DEFAULT_TYPOGRAPHY;
  }
}

function volumeLabel(volumeId: string): string {
  const value = Number(volumeId.replace(/^vol_/, '').replace(/^0+/, '')) || 1;
  return `第 ${value} 卷`;
}

function shortRevision(revision: string): string {
  const project = /^prj_(\d+)_([a-f0-9]+)$/i.exec(revision);
  if (project) return `v${Number(project[1])}·${project[2]!.slice(0, 6)}`;
  const chapter = /^rev_(\d+)_([a-f0-9]+)$/i.exec(revision);
  if (chapter) return `r${Number(chapter[1])}·${chapter[2]!.slice(0, 6)}`;
  return revision.length > 18 ? `${revision.slice(0, 18)}…` : revision;
}

function revisionSeq(revision: string): number {
  const match = /^prj_(\d+)_/i.exec(revision);
  return match ? Number(match[1]) : 0;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function chapterGroups(chapters: ChapterSummary[]): { volumeId: string; chapters: ChapterSummary[] }[] {
  const groups = new Map<string, ChapterSummary[]>();
  for (const chapter of chapters) {
    const list = groups.get(chapter.volume_id) ?? [];
    list.push(chapter);
    groups.set(chapter.volume_id, list);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([volumeId, list]) => ({
      volumeId,
      chapters: list.sort((left, right) => left.ordinal - right.ordinal),
    }));
}

function diffRows(before: string, after: string) {
  const rows: { left: string; right: string; kind: 'same' | 'removed' | 'added' | 'changed' }[] = [];
  let removed: string[] = [];
  let added: string[] = [];

  const flush = (): void => {
    const count = Math.max(removed.length, added.length);
    for (let index = 0; index < count; index += 1) {
      const left = removed[index] ?? '';
      const right = added[index] ?? '';
      rows.push({
        left,
        right,
        kind: left && right ? 'changed' : left ? 'removed' : 'added',
      });
    }
    removed = [];
    added = [];
  };

  for (const part of diffLines(before, after)) {
    const lines = part.value.replace(/\n$/, '').split('\n');
    if (part.removed) {
      if (added.length > 0) flush();
      removed.push(...lines);
    } else if (part.added) {
      added.push(...lines);
    } else {
      flush();
      for (const line of lines) rows.push({ left: line, right: line, kind: 'same' });
    }
  }
  flush();
  return rows;
}

export default function App() {
  const atelierShown=useAtelierArt();
  const [showSources,setShowSources]=useState(true);
  const [chapterNav,setChapterNav]=useState<'open'|'rail'|'hidden'>(()=>{try{const saved=localStorage.getItem('ns.chapter-nav.v1');return saved==='rail'||saved==='hidden'?saved:'open';}catch{return 'open';}});
  const changeChapterNav=(mode:'open'|'rail'|'hidden')=>{setChapterNav(mode);try{localStorage.setItem('ns.chapter-nav.v1',mode);}catch{/* optional layout */}};

  const [writingOnly,setWritingOnly]=useState(false),[newTitle,setNewTitle]=useState<string|null>(null);
  const [applicationLocked,setApplicationLocked]=useState(false);
  const [editorStatus,setEditorStatus]=useState({canUndo:false,canRedo:false,hasSelection:false});
  const [screen,setScreen]=useState<'home'|'writer'|'book'>(()=>location.hash==='#book'?'book':'home');
  const [aiWorkspace,setAiWorkspace]=useState<'focus'|'split'>(()=>{try{return localStorage.getItem('ns.ai-workspace.v1')==='split'?'split':'focus';}catch{return 'focus';}});
  const [layoutSerial,setLayoutSerial]=useState(0);
  const paperSnapshot=useRef<{scrollTop:number;start:number;end:number}|null>(null),restorePaper=useRef(false),pendingPaperReveal=useRef<{start:number;end:number}|null>(null);
  const [chatHeight,setChatHeight]=useState(()=>Number(localStorage.getItem('ns.chat-height.v2'))||55);
  const bookDirtyRef=useRef(false);
  const navigate=(next:'home'|'writer'|'book')=>{if(screen==='book'&&bookDirtyRef.current&&!window.confirm('规划有未保存修改，确定离开？'))return;setScreen(next);};
  const pendingScroll=useRef<{scrollTop:number;start:number;end:number}|null>(null);
  const pendingAiJump=useRef<{start:number;end:number}|null>(null);
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [writingAnchor,setWritingAnchor]=useState<WritingAnchor|null>(null);
  const writingAnchorRef=useRef<WritingAnchor|null>(null),writingAnchorSerial=useRef(0);
  useEffect(()=>{writingAnchorRef.current=null;setWritingAnchor(null);paperSnapshot.current=null;pendingPaperReveal.current=null;},[selectedId]);
  const [chapter, setChapter] = useState<ChapterPayload | null>(null);
  const [loadingChapter, setLoadingChapter] = useState(false);
  const [editorEpoch, setEditorEpoch] = useState(0);
  const [history, setHistory] = useState<RevisionSummary[]>([]);
  const [compare, setCompare] = useState<CompareState | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saveState, setSaveState] = useState<SaveState>('saved');
  const [notice, setNotice] = useState<{ kind: 'info' | 'warn' | 'error'; text: string } | null>(null);
  useEffect(()=>{if(notice?.kind!=='info')return;const timer=window.setTimeout(()=>setNotice(null),4000);return()=>clearTimeout(timer);},[notice]);
  const [draftNotice, setDraftNotice] = useState<DraftNotice | null>(null);
  const [draftDiff, setDraftDiff] = useState<DraftDiff | null>(null);
  const [draftError, setDraftError] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(preferredTheme);
  const [typography, setTypography] = useState<Typography>(readTypography);
  const [typographyOpen, setTypographyOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [narrativeOpen, setNarrativeOpen] = useState(false);
  const [voiceOpen, setVoiceOpen] = useState(false);
  const [editorialOpen, setEditorialOpen] = useState(false);
  const [growthOpen, setGrowthOpen] = useState(false);
  const [planningOpen, setPlanningOpen] = useState(false);
  const [continuationOpen, setContinuationOpen] = useState(false);
  const [literaryOpen, setLiteraryOpen] = useState(false);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const anyDrawerOpen = narrativeOpen || voiceOpen || editorialOpen || growthOpen || planningOpen || continuationOpen || literaryOpen;
  const openDrawer = (setter: (value: boolean) => void) => { lastTriggerRef.current = document.activeElement as HTMLElement | null; setter(true); };
  const [coevolutionMode, setCoevolutionMode] = useState<'focus' | 'collaborate' | 'study'>(() => (localStorage.getItem('narrative-studio.coevolution-mode') as 'focus' | 'collaborate' | 'study') ?? 'collaborate');
  const narrativeJumpRef = useRef<{ chapterId: string; quote: string } | null>(null);
  const [filter, setFilter] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyDrawer, setHistoryDrawer] = useState(false);

  useEffect(()=>{if(chapter&&pendingScroll.current){const snapshot=pendingScroll.current;pendingScroll.current=null;requestAnimationFrame(()=>editorRef.current?.restore(snapshot));}if(chapter && pendingAiJump.current){const range=pendingAiJump.current;pendingAiJump.current=null;requestAnimationFrame(()=>editorRef.current?.reveal(editorOffset(chapter.content,range.start),editorOffset(chapter.content,range.end)));}},[chapter]);
  const editorRef = useRef<EditorHandle | null>(null);
  const changeWorkspace=(next:'focus'|'split',manual=false)=>{
    if(writingOnly||aiWorkspace==='split')paperSnapshot.current=editorRef.current?.snapshot()??null;
    if(next==='split'&&aiWorkspace==='focus')restorePaper.current=true;
    setWritingOnly(false);setAiWorkspace(next);
    if(manual){setLayoutSerial(v=>v+1);try{localStorage.setItem('ns.ai-workspace.v1',next);}catch{/* local layout preference is optional */}}
  };
  const revealWritingRange=(start:number,end:number)=>{
    const raw=chapterRef.current?.content??'';start=editorOffset(raw,start);end=editorOffset(raw,end);
    if(screen==='writer'&&!writingOnly&&aiWorkspace==='split'){editorRef.current?.reveal(start,end);return;}
    pendingPaperReveal.current={start,end};changeWorkspace('split',true);
  };
  useEffect(()=>{
    if(screen!=='writer'||(!writingOnly&&aiWorkspace!=='split'))return;
    const pending=pendingPaperReveal.current;pendingPaperReveal.current=null;
    if(pending){restorePaper.current=false;editorRef.current?.reveal(pending.start,pending.end);}
    else if(restorePaper.current&&paperSnapshot.current){restorePaper.current=false;editorRef.current?.restore(paperSnapshot.current);}
  },[screen,writingOnly,aiWorkspace,chapter]);
  const selectedRef = useRef<string | null>(null);
  const projectIdRef = useRef<string | null>(null);
  const chapterRef = useRef<ChapterPayload | null>(null);
  const baseRevisionRef = useRef('');
  const dirtyRef = useRef(false);
  const sessionsRef = useRef(new Map<string, ChapterSession>());
  const pendingDraftsRef = useRef(new Map<string, PendingDraft>());
  const draftTimerRef = useRef<number | null>(null);
  const loadSeqRef = useRef(0);
  const editSeqRef = useRef(0);
  const saveRequestRef = useRef(0);
  const saveInFlightRef = useRef(false);

  const setDirtyState = useCallback((value: boolean) => {
    dirtyRef.current = value;
    setDirty(value);
  }, []);

  const persistPendingDraft = useCallback((chapterId?: string): boolean => {
    const id = chapterId ?? chapterRef.current?.chapter.chapter_id;
    if (!id) return true;
    const pending = pendingDraftsRef.current.get(id);
    if (!pending) return true;
    const ok = writeDraft(pending.projectId, pending.chapterId, {
      text: pending.text,
      baseRevision: pending.baseRevision,
      savedAt: new Date().toISOString(),
      seq: pending.seq,
    });
    if (!ok) {
      setDraftError('本地草稿写入失败（浏览器存储不可用或已满）。当前文本仍在编辑器中，请立即 Ctrl+S 保存到 Vault。');
      return false;
    }
    setDraftError(null);
    return true;
  }, []);

  const clearDraftTimer = useCallback(() => {
    if (draftTimerRef.current !== null) {
      window.clearTimeout(draftTimerRef.current);
      draftTimerRef.current = null;
    }
  }, []);

  /** Synchronously persist the last snapshot; never reads the editor after a chapter switch. */
  const flushDraft = useCallback((): boolean => {
    clearDraftTimer();
    const chapterId = chapterRef.current?.chapter.chapter_id;
    if (!chapterId) return true;
    const ok = persistPendingDraft(chapterId);
    if (ok) pendingDraftsRef.current.delete(chapterId);
    return ok;
  }, [clearDraftTimer, persistPendingDraft]);

  const loadChapter = useCallback(async (projectId: string, chapterId: string,preserveHistory=false): Promise<void> => {
    const token = ++loadSeqRef.current;
    const keepEditor=preserveHistory&&chapterRef.current?.chapter.chapter_id===chapterId&&!!editorRef.current;
    if(!keepEditor){setLoadingChapter(true);setChapter(null);chapterRef.current = null;}
    setHistory([]);
    setCompare(null);
    setDraftNotice(null);
    setDraftDiff(null);
    setNotice(null);
    try {
      const [payload, revisions] = await Promise.all([api.chapter(chapterId), api.history(chapterId)]);
      if (token !== loadSeqRef.current || selectedRef.current !== chapterId) return;
      const seq = ++editSeqRef.current;
      sessionsRef.current.set(chapterId, {
        text: payload.content,
        baseRevision: payload.manifest_revision,
        dirty: false,
        seq,
      });
      setChapter(payload);
      chapterRef.current = payload;
      baseRevisionRef.current = payload.manifest_revision;
      setDirtyState(false);
      setSaveState('saved');
      if(keepEditor)editorRef.current?.setValue(payload.content,editorAiRanges(payload.content,payload.revision.message));
      else setEditorEpoch((value) => value + 1);
      setHistory(revisions.revisions);
      const draft = readDraft(projectId, chapterId);
      if (draft) {
        if (draft.text === payload.content) clearDraft(projectId, chapterId);
        else setDraftNotice({ draft, stale: draft.baseRevision !== payload.manifest_revision });
      }
    } catch (caught) {
      if (token === loadSeqRef.current) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : String(caught) });
      }
    } finally {
      if (token === loadSeqRef.current) setLoadingChapter(false);
    }
  }, [setDirtyState]);

  const switchChapter = useCallback(
    (nextId: string): void => {
      if (!nextId || nextId === selectedRef.current) return;
      if (dirtyRef.current) {
        const saved = flushDraft();
        if (!saved && !window.confirm('草稿无法写入本地存储。仍要切换章节吗？未保存内容可能丢失。')) return;
      }
      clearDraftTimer();
      selectedRef.current = nextId;
      setSelectedId(nextId);
      setHistoryDrawer(false);
      setDirtyState(false);
      setSaveState('saved');
    },
    [clearDraftTimer, flushDraft, setDirtyState],
  );

  useEffect(() => {
    if (!anyDrawerOpen && lastTriggerRef.current) { lastTriggerRef.current.focus(); lastTriggerRef.current = null; }
  }, [anyDrawerOpen]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      setNarrativeOpen(false); setVoiceOpen(false); setEditorialOpen(false);
      setGrowthOpen(false); setPlanningOpen(false); setContinuationOpen(false); setLiteraryOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const pending = narrativeJumpRef.current;
    if (!pending || !chapter || chapter.chapter.chapter_id !== pending.chapterId) return;
    narrativeJumpRef.current = null;
    const index = chapter.content.indexOf(pending.quote);
    if (index >= 0) editorRef.current?.setSelection(index, index + pending.quote.length);
  }, [chapter]);

  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  useEffect(() => {
    try {
      window.localStorage.setItem(TYPOGRAPHY_KEY, JSON.stringify(typography));
    } catch {
      /* typography remains session-local when storage is unavailable */
    }
  }, [typography]);

  useEffect(() => {
    void (async () => {
      try {
        const payload = await api.bootstrap();
        setBoot(payload);
        projectIdRef.current = payload.project.project_id;
        const stored = window.localStorage.getItem('narrative-studio.selected');
        const candidate =
          stored && payload.chapters.some((item) => item.chapter_id === stored)
            ? stored
            : payload.chapters[0]?.chapter_id ?? null;
        selectedRef.current = candidate;
        setSelectedId(candidate);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      }
    })();
  }, []);

  useEffect(() => {
    if (!boot || !selectedId) return;
    projectIdRef.current = boot.project.project_id;
    window.localStorage.setItem('narrative-studio.selected', selectedId);
    void loadChapter(boot.project.project_id, selectedId);
    // Deliberately depend on the project id, not the boot object: a save updates
    // boot.manifest and must not reload/replace the active chapter.
  }, [boot?.project.project_id, selectedId, loadChapter]);

  useEffect(() => () => {
    clearDraftTimer();
  }, [clearDraftTimer]);

  const onEditorChange = useCallback(() => {
    const current = chapterRef.current;
    const projectId = projectIdRef.current;
    if (!current || !projectId) return;
    const text = editorRef.current?.getValue() ?? '';
    const seq = ++editSeqRef.current;
    sessionsRef.current.set(current.chapter.chapter_id, {
      text,
      baseRevision: baseRevisionRef.current,
      dirty: true,
      seq,
    });
    const chapterId = current.chapter.chapter_id;
    pendingDraftsRef.current.set(chapterId, {
      projectId,
      chapterId,
      text,
      baseRevision: baseRevisionRef.current,
      seq,
    });
    setDirtyState(true);
    setSaveState((state) => (state === 'saving' ? 'saving' : 'dirty'));
    clearDraftTimer();
    draftTimerRef.current = window.setTimeout(() => {
      draftTimerRef.current = null;
      if (persistPendingDraft(chapterId)) pendingDraftsRef.current.delete(chapterId);
    }, 350);
  }, [clearDraftTimer, persistPendingDraft, setDirtyState]);

  const save = useCallback(async (): Promise<void> => {
    const current = chapterRef.current;
    const projectId = projectIdRef.current;
    if (!current || !projectId) return;
    if (saveInFlightRef.current) {
      setNotice({ kind: 'info', text: '上一次保存仍在进行中；完成后再保存新输入。' });
      return;
    }
    const chapterId = current.chapter.chapter_id;
    const text = editorRef.current?.getValue() ?? '';
    const snapshotSeq = sessionsRef.current.get(chapterId)?.seq ?? editSeqRef.current;
    if (!dirtyRef.current && text === editorText(current.content)) {
      setNotice(null);
      return;
    }
    const requestId = ++saveRequestRef.current;
    saveInFlightRef.current = true;
    setSaveState('saving');
    setNotice(null);
    try {
      const aiRanges=editorRef.current?.getAiRanges()??[];
      const source=current.revision.line_ending==='crlf'?text.replace(/\r?\n/g,'\r\n'):text;
      const saved = await api.save(chapterId, text, baseRevisionRef.current,aiRanges.length?JSON.stringify({kind:'author-with-ai',coordinateSpace:'source',ranges:aiRanges.map(r=>sourceRange(source,r))}):undefined);
      let fresh: ChapterPayload | null = null;
      try {
        fresh = await api.chapter(chapterId);
      } catch {
        fresh = null;
      }
      if (requestId !== saveRequestRef.current) return;

      const session = sessionsRef.current.get(chapterId);
      const storedDraft = readDraft(projectId, chapterId);
      const sessionSeq = session?.seq ?? -1;
      const draftSeq = storedDraft?.seq ?? -1;
      const sessionIsNewer = sessionSeq > snapshotSeq;
      const draftIsNewer = draftSeq > snapshotSeq;
      const hasNewerEdits = sessionIsNewer || draftIsNewer;
      let newerText = text;
      let newerSeq = snapshotSeq;
      if (sessionIsNewer && draftIsNewer) {
        if (sessionSeq >= draftSeq) {
          newerText = session?.text ?? text;
          newerSeq = sessionSeq;
        } else {
          newerText = storedDraft!.text;
          newerSeq = draftSeq;
        }
      } else if (sessionIsNewer) {
        newerText = session?.text ?? text;
        newerSeq = sessionSeq;
      } else if (draftIsNewer) {
        newerText = storedDraft!.text;
        newerSeq = draftSeq;
      }
      if (session) {
        session.baseRevision = saved.manifest_revision;
        session.dirty = hasNewerEdits;
        if (!hasNewerEdits) session.text = text;
      }

      setBoot((existing) =>
        existing
          ? {
              ...existing,
              manifest: { ...existing.manifest, revision: saved.manifest_revision },
              chapters: fresh
                ? existing.chapters.map((item) => (item.chapter_id === chapterId ? fresh!.chapter : item))
                : existing.chapters,
              projection: saved.projection,
            }
          : existing,
      );

      // A commit advances the project-level manifest. If another chapter is
      // currently loaded and its own chapter revision did not change, its
      // old base becomes an unnecessary CAS conflict. Advance only forward;
      // an external change after our commit still leaves a newer server base
      // and will fail CAS normally.
      const selected = selectedRef.current;
      if (selected && selected !== chapterId && revisionSeq(saved.manifest_revision) > revisionSeq(baseRevisionRef.current)) {
        baseRevisionRef.current = saved.manifest_revision;
        const selectedSession = sessionsRef.current.get(selected);
        if (selectedSession) selectedSession.baseRevision = saved.manifest_revision;
        const currentChapter = chapterRef.current;
        if (currentChapter) {
          const next = { ...currentChapter, manifest_revision: saved.manifest_revision };
          chapterRef.current = next;
          setChapter(next);
        }
        const pending = pendingDraftsRef.current.get(selected);
        if (pending) {
          pending.baseRevision = saved.manifest_revision;
          writeDraft(pending.projectId, pending.chapterId, {
            text: pending.text,
            baseRevision: saved.manifest_revision,
            savedAt: new Date().toISOString(),
            seq: pending.seq,
          });
        } else if (selectedSession?.dirty) {
          const stored = readDraft(projectId, selected);
          if (stored && revisionSeq(stored.baseRevision) < revisionSeq(saved.manifest_revision)) {
            writeDraft(projectId, selected, { ...stored, baseRevision: saved.manifest_revision });
          }
        }
      }

      if (hasNewerEdits) {
        const nextDraft = {
          projectId,
          chapterId,
          text: newerText,
          baseRevision: saved.manifest_revision,
          seq: newerSeq,
        };
        pendingDraftsRef.current.set(chapterId, nextDraft);
        if (!writeDraft(projectId, chapterId, { ...nextDraft, savedAt: new Date().toISOString() })) {
          setDraftError('保存期间的新输入未能写入本地草稿；请保持页面打开并再次保存。');
        }
        if (selectedRef.current === chapterId) {
          const editorTextNow = editorRef.current?.getValue() ?? '';
          const editorHasLocalEdits = editorTextNow !== current.content;
          const nextChapter: ChapterPayload = {
            ...current,
            content: text,
            chapter: fresh?.chapter ?? { ...current.chapter, current_revision_id: saved.revision.revision_id },
            revision: fresh?.revision ?? saved.revision,
            manifest_revision: saved.manifest_revision,
          };
          setChapter(nextChapter);
          chapterRef.current = nextChapter;
            baseRevisionRef.current = saved.manifest_revision;
          if (!editorHasLocalEdits) {
            // We returned to this chapter after the request started: show the
            // durable snapshot, while the newer local draft remains recoverable.
            editorRef.current?.setValue(text);
            setDirtyState(false);
            setSaveState('saved');
            if (storedDraft) {
              setDraftNotice({ draft: { ...storedDraft, baseRevision: saved.manifest_revision }, stale: false });
            }
          } else {
            setDirtyState(true);
            setSaveState('dirty');
            setNotice({
              kind: 'warn',
              text: '已保存提交时的文本快照；保存期间继续输入的内容仍未保存，请再次 Ctrl+S。',
            });
          }
        }
        return;
      }

      clearDraft(projectId, chapterId);
      pendingDraftsRef.current.delete(chapterId);
      if (selectedRef.current === chapterId) {
        const nextChapter: ChapterPayload = {
          ...current,
          content: text,
          chapter: fresh?.chapter ?? { ...current.chapter, current_revision_id: saved.revision.revision_id },
          revision: fresh?.revision ?? saved.revision,
          manifest_revision: saved.manifest_revision,
        };
        setChapter(nextChapter);
        chapterRef.current = nextChapter;
        baseRevisionRef.current = saved.manifest_revision;
        const editorNow = editorRef.current?.getValue() ?? '';
        if (editorNow !== text) editorRef.current?.setValue(text);
        setDirtyState(false);
        setSaveState('saved');
        setNotice({ kind: 'info', text: '已保存' });
        try {
          const revisions = await api.history(chapterId);
          if (selectedRef.current === chapterId) setHistory(revisions.revisions);
        } catch {
          /* history is auxiliary; the save is already durable */
        }
        editorRef.current?.focus();
      }
    } catch (caught) {
      if (selectedRef.current === chapterId) {
        if (caught instanceof ApiError && caught.status === 409) {
          setSaveState('conflict');
          setNotice({
            kind: 'warn',
            text: '这个章节已在另一处更新。当前文本没有覆盖磁盘版本；本地草稿已保留，请重新载入后决定。',
          });
        } else {
          setSaveState('error');
          setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : String(caught) });
        }
      }
    } finally {
      saveInFlightRef.current = false;
    }
  }, [setDirtyState]);

  useEffect(() => {
    const handler = (event: KeyboardEvent): void => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault();
        void save();
      }
      if (event.altKey && event.key.toLowerCase() === 'f') {
        event.preventDefault();
        setFocusMode((value) => !value);
      }
      if (event.key === 'Escape') {
        if (draftDiff) setDraftDiff(null);
        else if (compare) setCompare(null);
        else if (typographyOpen) setTypographyOpen(false);
        else if (focusMode) setFocusMode(false);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [save, focusMode, compare, draftDiff, typographyOpen]);

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent): void => {
      if (dirtyRef.current) {
        flushDraft();
        event.preventDefault();
        event.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [flushDraft]);

  const visibleGroups = useMemo(() => {
    if (!boot) return [];
    const needle = filter.trim().toLowerCase();
    return chapterGroups(
      boot.chapters.filter((item) => needle.length === 0 || item.title.toLowerCase().includes(needle)),
    );
  }, [boot, filter]);

  const currentText = editorRef.current?.getValue() ?? '';
  const rows = useMemo(
    () => (compare ? diffRows(compare.content, currentText) : []),
    [compare, currentText],
  );
  const draftRows = useMemo(
    () => (draftDiff ? diffRows(draftDiff.draft.text, draftDiff.current) : []),
    [draftDiff],
  );

  const createChapter = async (): Promise<void> => {
    const title = newTitle;
    if (!title || !title.trim() || !boot) return;
    if (dirtyRef.current && !flushDraft()) return;
    try {
      const created = await api.createChapter(title.trim());
      const payload = await api.bootstrap();
      setBoot(payload);
      selectedRef.current = created.chapter.chapter_id;
      setSelectedId(created.chapter.chapter_id);
      setNewTitle(null);setScreen('writer');setNotice({ kind: 'info', text: `已创建 ${created.chapter.title}` });
    } catch (caught) {
      setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  const restoreRevision = async (revision: RevisionSummary): Promise<void> => {
    const current = chapterRef.current;
    if (!boot || !current) return;
    if (!window.confirm(`恢复 ${revision.revision_id} 为新的当前版本？原始历史不会被删除。`)) return;
    try {
      await api.revert(current.chapter.chapter_id, revision.revision_id, baseRevisionRef.current);
      await loadChapter(boot.project.project_id, current.chapter.chapter_id,true);
      setNotice({ kind: 'info', text: '已从历史版本创建新的修订。' });
    } catch (caught) {
      setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  const viewRevision = async (revision: RevisionSummary): Promise<void> => {
    const current = chapterRef.current;
    if (!current) return;
    try {
      const payload = await api.revision(current.chapter.chapter_id, revision.revision_id);
      setCompare(payload);
      setHistoryOpen(true);
    } catch (caught) {
      setNotice({ kind: 'error', text: caught instanceof Error ? caught.message : String(caught) });
    }
  };

  const restoreDraft = (): void => {
    const noticeDraft = draftNotice;
    const current = chapterRef.current;
    const projectId = projectIdRef.current;
    if (!noticeDraft || noticeDraft.stale || !current || !projectId) return;
    const seq = ++editSeqRef.current;
    if (!writeDraft(projectId, current.chapter.chapter_id, { ...noticeDraft.draft, seq })) {
      setDraftError('草稿恢复失败：浏览器存储不可用。');
      return;
    }
    editorRef.current?.setValue(noticeDraft.draft.text);
    sessionsRef.current.set(current.chapter.chapter_id, {
      text: noticeDraft.draft.text,
      baseRevision: current.manifest_revision,
      dirty: true,
      seq,
    });
    pendingDraftsRef.current.set(current.chapter.chapter_id, {
      projectId,
      chapterId: current.chapter.chapter_id,
      text: noticeDraft.draft.text,
      baseRevision: current.manifest_revision,
      seq,
    });
    setDirtyState(true);
    setSaveState('dirty');
    setDraftNotice(null);
  };

  const discardDraft = (): void => {
    const current = chapterRef.current;
    const projectId = projectIdRef.current;
    if (current && projectId) clearDraft(projectId, current.chapter.chapter_id);
    if (current) pendingDraftsRef.current.delete(current.chapter.chapter_id);
    setDraftNotice(null);
  };

  if (error && !boot) {
    return (
      <main className="fatal">
        <h1>无法打开工作台</h1>
        <p>{error}</p>
        <p className="muted">请从 `ns studio` 打印的本地地址打开，并确认 Vault 可读。</p>
      </main>
    );
  }

  if (!boot) {
    return <main className="fatal"><p>正在打开本地工作台…</p></main>;
  }

  const statusLabel: Record<SaveState, string> = {
    saved: '已保存',
    dirty: '未保存',
    saving: '保存中',
    error: '保存失败',
    conflict: '版本冲突',
  };

  const appStyle = {
    '--body-size': `${typography.size}px`,
    '--body-leading': String(typography.leading),
    '--measure': `${typography.measure}px`,
    '--font-body': typography.font === 'sans' ? 'var(--font-sans)' : 'var(--font-serif)',
  } as CSSProperties;

  return (
    <div
      className={`app ${focusMode ? 'focus-mode' : ''} ${historyDrawer ? 'history-drawer' : ''}`}
      data-sources={showSources?'on':'off'}
      data-atelier={atelierShown?'on':'off'}
      data-save-state={saveState}
      data-dirty={dirty}
      data-indent={typography.indent ? 'on' : 'off'}
      style={{...appStyle, "--chat-size": `${chatHeight}%`} as CSSProperties}
    >
      <header className="topbar">
        <div className="brand"><button className="brand-home link atelier-home" aria-label="返回首页" onClick={()=>navigate('home')}>{atelierShown?<AtelierPortrait/>:'N'}</button>

          <div>
            <h1>{boot.project.title}</h1>
            <p className="muted small">Narrative Studio · 写作工作台</p>
          </div>
        </div>
        <select
          className="mobile-chapters"
          aria-label="选择章节"
          value={selectedId ?? ''}
          onChange={(event) => switchChapter(event.target.value)}
        >
          {boot.chapters.map((item) => (
            <option key={item.chapter_id} value={item.chapter_id}>
              {item.title}
            </option>
          ))}
        </select>
        <div className="top-actions">
          <span className={`save-pill save-${saveState}`} role="status" aria-live="polite">
            <span className="dot" aria-hidden="true" />
            {statusLabel[saveState]}
          </span>
          <button className="ghost" onClick={()=>{setWritingOnly(false);navigate('writer');}}>续写</button>
          <button className="ghost" onClick={()=>navigate('book')}>灵感共创</button>
          <FileActions beforeExport={async()=>{await save();if(dirtyRef.current||saveInFlightRef.current)throw new Error('请先完成保存，再导出最新正文');}} chapterId={selectedId} onImported={async(id)=>{const b=await api.bootstrap();setBoot(b);switchChapter(id);setWritingOnly(true);setScreen('writer');}}/>
          <AutoMenu label="更多"><label><input type="checkbox" checked={showSources} onChange={e=>setShowSources(e.target.checked)}/>显示已采用 AI 来源</label>          <button type="button" className="ghost" onClick={() => openDrawer(setNarrativeOpen)}>
            叙事
          </button>
          <button type="button" className="ghost" onClick={() => openDrawer(setVoiceOpen)}>
            文风
          </button>
          <button type="button" className="ghost" onClick={() => openDrawer(setEditorialOpen)}>
            编辑
          </button>
          <button type="button" className="ghost" onClick={() => openDrawer(setGrowthOpen)}>
            成长
          </button>
          <button type="button" className="ghost" onClick={() => openDrawer(setPlanningOpen)}>
            新书骨架
          </button>
          <button type="button" className="ghost" onClick={() => openDrawer(setContinuationOpen)}>
            智能续写
          </button>
          <button type="button" className="ghost" onClick={() => openDrawer(setLiteraryOpen)}>
            实验
          </button>
          <select aria-label="成长模式" value={coevolutionMode} onChange={(event) => { const mode = event.target.value as 'focus' | 'collaborate' | 'study'; setCoevolutionMode(mode); localStorage.setItem('narrative-studio.coevolution-mode', mode); }} title="成长提示模式">
            <option value="focus">专注 Focus</option>
            <option value="collaborate">协作 Collaborate</option>
            <option value="study">学习 Study</option>
          </select>
</AutoMenu>
          <button type="button" className="ghost history-toggle" onClick={() => setHistoryDrawer((value) => !value)}>
            版本
          </button>
          <AutoMenu label="视图" className="view-options"><button type="button" className="ghost" onClick={() => setFocusMode((value) => !value)}>
            {focusMode ? '退出专注' : '专注模式'}
          </button>
          <button type="button" className="ghost" onClick={() => setTypographyOpen((value) => !value)} aria-expanded={typographyOpen}>
            排版
          </button>
          <button type="button" className="ghost" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '浅色' : '深色'}
          </button><AtelierToggle/></AutoMenu>
          <button type="button" className="primary" onClick={() => void save()} disabled={saveState === 'saving'}>
            保存 <span className="mono">Ctrl+S</span>
          </button>
        </div>
      </header>

      {typographyOpen && (
        <aside className="typography-panel" role="dialog" aria-label="排版设置">
          <div className="typography-head">
            <h2>排版</h2>
            <button type="button" className="link" onClick={() => setTypographyOpen(false)}>关闭</button>
          </div>
          <label className="setting">
            <span>字号 <output>{typography.size}px</output></span>
            <input
              type="range"
              min={15}
              max={20}
              step={1}
              value={typography.size}
              onChange={(event) => setTypography((value) => ({ ...value, size: Number(event.target.value) }))}
            />
          </label>
          <label className="setting">
            <span>行距 <output>{typography.leading.toFixed(2)}</output></span>
            <input
              type="range"
              min={1.7}
              max={2.2}
              step={0.05}
              value={typography.leading}
              onChange={(event) => setTypography((value) => ({ ...value, leading: Number(event.target.value) }))}
            />
          </label>
          <label className="setting">
            <span>阅读宽度 <output>{typography.measure}px</output></span>
            <input
              type="range"
              min={620}
              max={860}
              step={20}
              value={typography.measure}
              onChange={(event) => setTypography((value) => ({ ...value, measure: Number(event.target.value) }))}
            />
          </label>
          <label className="setting inline">
            <span>首行缩进</span>
            <input
              type="checkbox"
              checked={typography.indent}
              onChange={(event) => setTypography((value) => ({ ...value, indent: event.target.checked }))}
            />
          </label>
          <label className="setting inline">
            <span>正文字体</span>
            <select
              value={typography.font}
              onChange={(event) => setTypography((value) => ({ ...value, font: event.target.value === 'sans' ? 'sans' : 'serif' }))}
            >
              <option value="serif">宋体 / 衬线</option>
              <option value="sans">黑体 / 无衬线</option>
            </select>
          </label>
          <button type="button" className="ghost reset-type" onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}>
            恢复默认
          </button>
          <p className="muted small">只影响显示，不改写 Markdown 源文本。</p>
        </aside>
      )}

      {notice && (
        <div className={`banner banner-${notice.kind}`} role="status">
          <span>{notice.text}</span>
          <button type="button" className="link" onClick={() => setNotice(null)} aria-label="关闭提示">×</button>
          {saveState === 'conflict' && chapter && (
            <button type="button" className="link" onClick={() => void loadChapter(boot.project.project_id, chapter.chapter.chapter_id)}>
              重新载入磁盘版本
            </button>
          )}
        </div>
      )}

      {draftError && (
        <div className="banner banner-error" role="alert">
          <span>{draftError}</span>
          <button type="button" className="link" onClick={() => setDraftError(null)} aria-label="关闭草稿错误">×</button>
        </div>
      )}

      {draftNotice && (
        <div className={`banner ${draftNotice.stale ? 'banner-error' : 'banner-warn'}`} role="status">
          {draftNotice.stale ? (
            <>
              <span>
                发现基于旧修订 {shortRevision(draftNotice.draft.baseRevision)} 的本地草稿；当前已是{' '}
                {shortRevision(chapter?.manifest_revision ?? '')}。直接恢复会被 Vault 拒绝覆盖。
              </span>
              <button
                type="button"
                className="link"
                onClick={() => {
                  if (!chapter) return;
                  setDraftDiff({ draft: draftNotice.draft, current: chapter.content });
                }}
              >
                查看差异
              </button>
            </>
          ) : (
            <>
              <span>发现未保存的本地草稿（基于当前修订 {shortRevision(draftNotice.draft.baseRevision)}）。</span>
              <button type="button" className="link" onClick={restoreDraft}>恢复草稿</button>
            </>
          )}
          <button type="button" className="link" onClick={discardDraft}>丢弃</button>
        </div>
      )}

      {screen==='home'&&<main className="studio-home"><div className="home-art"><AtelierArt/></div><p className="eyebrow">NACRE · 纸页与灵感 · 0.1.0 · 开发预览</p><h2>让故事，发生。</h2><p className="home-intro">把念头写成文字，把文字写成你的故事。</p><div className="home-choices"><button onClick={()=>{setWritingOnly(true);setScreen('writer');}}><span className="choice-number">01 / 写作</span><strong>自己写文章</strong><span>输入、修改、自动保存<br/>随时导入导出</span></button><button onClick={()=>{setWritingOnly(false);setScreen('writer');}}><span className="choice-number">02 / 续写</span><strong>接着已有文章写</strong><span>读懂前文，讨论下一步<br/>再一起打磨正文</span></button><button onClick={()=>setScreen('book')}><span className="choice-number">03 / 共创</span><strong>从灵感开始</strong><span>聊人物、梳理关系和剧情<br/>从想法走进正文</span></button></div><p className="muted">当前作品：{boot.project.title} · {boot.chapters.length} 章</p><BookLibrary/></main>}
      {screen==='book'&&<BookWorkspace projectId={boot.project.project_id} projectTitle={boot.project.title} onDirty={value=>{bookDirtyRef.current=value;}} onBack={()=>setScreen('writer')} onChapter={id=>{setWritingOnly(false);void api.bootstrap().then(b=>{setBoot(b);switchChapter(id);setScreen('writer');});}}/>}
      <div className={`workspace nav-${chapterNav} ${screen!=="writer"?"workspace-hidden":""}`}>
        <aside className="sidebar chapter-sidebar" aria-label="章节树">{chapterNav==='rail'&&<div className="chapter-rail"><button onClick={()=>changeChapterNav('open')} title="展开章节">章节</button><button onClick={()=>changeChapterNav('hidden')} aria-label="关闭章节栏">×</button>{boot.chapters.slice(0,8).map((item,i)=><button key={item.chapter_id} aria-label={`打开章节：${item.title}`} title={item.title} onClick={()=>switchChapter(item.chapter_id)}>{i+1}</button>)}</div>}<div className="chapter-nav-content">
          <div className="sidebar-heading">
            <span>章节</span><div className="chapter-nav-controls"><button className="link" onClick={()=>changeChapterNav('rail')} aria-label="缩小章节栏">−</button><button className="link" onClick={()=>changeChapterNav('hidden')} aria-label="关闭章节栏">×</button></div>
            <button type="button" className="link" onClick={() => setNewTitle('')}>＋ 新文章</button>
          </div>
          {newTitle!==null&&<form className="new-article" onSubmit={e=>{e.preventDefault();void createChapter();}}><label>新文章标题<input autoFocus aria-label="新文章标题" value={newTitle} onChange={e=>setNewTitle(e.target.value)}/></label><button className="primary" disabled={!newTitle.trim()}>开始写</button><button type="button" onClick={()=>setNewTitle(null)}>取消</button></form>}
          <input
            className="search"
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="搜索章节标题"
            aria-label="搜索章节标题"
          />
          <div className="chapter-scroll">
            {visibleGroups.length === 0 && <p className="muted small">没有匹配的章节。</p>}
            {visibleGroups.map((group) => (
              <section key={group.volumeId} className="volume">
                <h2 className="volume-title">{volumeLabel(group.volumeId)}</h2>
                <ul className="chapter-list">
                  {group.chapters.map((item) => (
                    <li key={item.chapter_id}>
                      <button
                        type="button"
                        className={`chapter-item ${item.chapter_id === selectedId ? 'active' : ''}`}
                        aria-current={item.chapter_id === selectedId ? 'page' : undefined}
                        onClick={() => switchChapter(item.chapter_id)}
                      >
                        <span className="chapter-title">{item.title}</span>
                        <span className="chapter-meta">{item.word_count} 字</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          <AtelierArt variant="companion"/>
          <div className="sidebar-foot muted small">
            <p>{boot.status.chapter_count} 章 · {boot.status.total_word_count.toLocaleString('zh-CN')} 字</p>

          </div>
        </div></aside>

        <main style={{'--chat-size':`${chatHeight}%`} as CSSProperties} className={`editor-column ${!writingOnly&&aiWorkspace==='focus'?'ai-workspace-full':''} ${!writingOnly&&aiWorkspace==='split'?'workspace-split':''}`}>
          <div className="workspace-layout-bar" role="group" aria-label="工作区布局"><button className="chapter-toggle" aria-expanded={chapterNav!=='hidden'} onClick={()=>changeChapterNav(chapterNav==='open'?'hidden':'open')}>章节</button><span>{chapter?.chapter.title??'写作工作区'}</span><button aria-pressed={writingOnly} onClick={()=>{if(aiWorkspace==='focus')restorePaper.current=true;setWritingOnly(true);setLayoutSerial(v=>v+1);}}>正文编辑</button><button aria-pressed={!writingOnly&&aiWorkspace==='focus'} onClick={()=>changeWorkspace('focus',true)}>AI 工作区</button><button aria-pressed={!writingOnly&&aiWorkspace==='split'} onClick={()=>changeWorkspace('split',true)}>上下分屏</button></div>
          {chapter&&<EditorToolbar active={screen==='writer'} locked={applicationLocked} status={editorStatus} editor={editorRef} onSave={()=>void save()} onReveal={()=>{if(!writingOnly&&aiWorkspace==='focus')changeWorkspace('split',true);}} onError={text=>setNotice({kind:'error',text})}/>}
          <div className="writing-surfaces">
          <div className="paper" data-testid="editor-paper">
            {loadingChapter ? (
              <div className="editor-loading" role="status">
                <p>正在载入章节…</p>
              </div>
            ) : chapter ? (
              <>
                <header className="chapter-heading">
                  <p className="eyebrow">{volumeLabel(chapter.chapter.volume_id)} · 第 {chapter.chapter.ordinal} 章</p>
                  <h2>{chapter.chapter.title}</h2>
                  <p className="muted small">
                    {chapter.chapter.word_count} 字 · {(() => { const rev = history.find((item) => item.revision_id === chapter.chapter.current_revision_id); return rev ? `第 ${rev.seq} 版` : '已保存'; })()}
                  </p>
                </header>
                <Editor
                  key={`${chapter.chapter.chapter_id}:${editorEpoch}`}
                  ref={editorRef}
                  initialValue={chapter.content}
                  readOnly={applicationLocked}
                  initialAiRanges={editorAiRanges(chapter.content,chapter.revision.message)}
                  onSelectionChange={range=>{const next={...range,serial:++writingAnchorSerial.current};writingAnchorRef.current=next;setWritingAnchor(next);}}
                  onChange={onEditorChange}
                  onSave={() => void save()}
                  onHistoryChange={setEditorStatus}
                />
              </>
            ) : (
              <div className="empty-state">
                <h2>还没有章节</h2>
                <p>先导入一部长篇，或创建一个章节。</p>
              </div>
            )}
          </div>
          {!writingOnly&&aiWorkspace==='split'&&<div className="chat-divider" role="separator" aria-label="调整对话高度" aria-orientation="horizontal" aria-valuemin={18} aria-valuemax={70} aria-valuenow={Math.round(chatHeight)} aria-valuetext={`对话区 ${Math.round(chatHeight)}%`} tabIndex={0} onKeyDown={e=>{if(e.key==='ArrowUp'||e.key==='ArrowDown'){e.preventDefault();const v=Math.max(18,Math.min(70,chatHeight+(e.key==='ArrowUp'?4:-4)));setChatHeight(v);localStorage.setItem('ns.chat-height.v2',String(v));}}} onPointerDown={e=>{const box=e.currentTarget.parentElement!.getBoundingClientRect();const move=(event:PointerEvent)=>{const v=Math.max(18,Math.min(70,(box.bottom-event.clientY)/box.height*100));setChatHeight(v);localStorage.setItem('ns.chat-height.v2',String(v));};const stop=()=>{window.removeEventListener('pointermove',move);window.removeEventListener('pointerup',stop);};window.addEventListener('pointermove',move);window.addEventListener('pointerup',stop);}}>···</div>}
          {selectedId&&<CoWriting active={screen==='writer'&&!writingOnly} workspace={aiWorkspace} layoutSerial={layoutSerial} onWorkspace={changeWorkspace} anchor={writingAnchor&&chapter?{...writingAnchor,...sourceRange(chapter.content,writingAnchor)}:writingAnchor} shouldFollow={(start,end)=>aiWorkspace==='split'&&(editorRef.current?.shouldFollow(editorOffset(chapterRef.current?.content??'',start),editorOffset(chapterRef.current?.content??'',end))??false)} onReveal={revealWritingRange} onApplying={setApplicationLocked} chapterId={selectedId} getTarget={async(mode,instruction)=>{const requestedRange=writingAnchorRef.current??editorRef.current?.getSelection()??{start:0,end:0};const positionChosen=!!writingAnchorRef.current;const requestedText=editorRef.current?.getValue()??'';if(dirtyRef.current)await save();const current=chapterRef.current;if(!current||current.chapter.chapter_id!==selectedRef.current||dirtyRef.current||saveInFlightRef.current)throw new Error('请先等待正文保存完成');const text=editorRef.current?.getValue()??'';if(text!==requestedText)throw new Error('请求期间正文发生编辑，请重新生成；原文保留。');const latest=await api.chapter(current.chapter.chapter_id);if(editorText(latest.content)!==text)throw new Error('服务器正文已改变；请通过版本对照重新载入，不会覆盖当前编辑内容');if(editorRef.current?.getValue()!==text)throw new Error('正文仍在编辑，请保存后重试');baseRevisionRef.current=latest.manifest_revision;chapterRef.current=latest;const target=sourceRange(latest.content,resolvePromptTarget(text,requestedRange,mode,positionChosen,instruction));return {chapterId:current.chapter.chapter_id,baseRevision:baseRevisionRef.current,baseHash:await textHash(latest.content),text:latest.content,...target};}} onApplied={async(range,follow)=>{writingAnchorRef.current=null;setWritingAnchor(null);pendingScroll.current=editorRef.current?.snapshot()??null;if(range&&follow)pendingAiJump.current=range;await loadChapter(boot.project.project_id,selectedRef.current!,true);setBoot(await api.bootstrap());}}/>}
          </div>
        </main>

        {historyDrawer && (
          <button
            type="button"
            className="drawer-scrim"
            aria-label="关闭版本面板"
            onClick={() => setHistoryDrawer(false)}
          />
        )}
        <aside className="sidebar history-sidebar" aria-label="版本与对照">
          <div className="sidebar-heading">
            <span>版本</span>
            <button type="button" className="link" onClick={() => setHistoryOpen((value) => !value)}>
              {historyOpen ? '收起' : '展开'}
            </button>
          </div>
          {historyOpen && (
            <ol className="history-list">
              {history.map((revision) => (
                <li key={revision.revision_id} className={revision.revision_id === chapter?.chapter.current_revision_id ? 'current' : ''}>
                  <div>
                    <strong>第 {revision.seq} 版</strong>
                  </div>
                  <p className="muted small">{formatTime(revision.created_at)} · {revision.message?.includes('ai-adopted') ? 'AI 草拟 · 作者已确认采用' : revision.message?.includes('author-with-ai') ? '作者修改 · 含已采用 AI 片段' : revision.message === 'created in workbench' ? '新建章节' : revision.message ?? '自动保存'}</p>
                  <div className="history-actions">
                    <button type="button" className="link" onClick={() => void viewRevision(revision)}>
                      对照
                    </button>
                    {revision.revision_id !== chapter?.chapter.current_revision_id && (
                      <button type="button" className="link" onClick={() => void restoreRevision(revision)}>
                        恢复
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>

      {compare && (
        <div
          className="diff-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setCompare(null);
          }}
        >
          <section className="diff-dialog" role="dialog" aria-modal="true" aria-label="版本对照">
            <header className="diff-dialog-head">
              <div>
                <p className="eyebrow">版本对照 · 旧版本与当前编辑</p>
                <h3>{shortRevision(compare.revision.revision_id)}</h3>
              </div>
              <button type="button" className="ghost" autoFocus onClick={() => setCompare(null)}>关闭</button>
            </header>
            <div className="diff-columns" role="table" aria-label="旧版本与当前文本逐行对照">
              <div className="diff-head-row" role="row">
                <span role="columnheader">旧版本</span>
                <span role="columnheader">当前编辑</span>
              </div>
              {rows.map((row, index) => (
                <div className={`diff-row diff-${row.kind}`} role="row" key={`${index}-${row.kind}`}>
                  <span role="cell"><span className="diff-sign">{row.kind === 'removed' || row.kind === 'changed' ? '−' : ' '}</span>{row.left}</span>
                  <span role="cell"><span className="diff-sign">{row.kind === 'added' || row.kind === 'changed' ? '+' : ' '}</span>{row.right}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      {draftDiff && (
        <div
          className="diff-overlay"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDraftDiff(null);
          }}
        >
          <section className="diff-dialog" role="dialog" aria-modal="true" aria-label="旧草稿与当前磁盘差异">
            <header className="diff-dialog-head">
              <div>
                <p className="eyebrow">旧草稿与当前磁盘 · 只读对照</p>
                <h3>{shortRevision(draftDiff.draft.baseRevision)}</h3>
              </div>
              <button type="button" className="ghost" autoFocus onClick={() => setDraftDiff(null)}>关闭</button>
            </header>
            <div className="diff-columns" role="table" aria-label="旧草稿与当前磁盘逐行对照">
              <div className="diff-head-row" role="row">
                <span role="columnheader">本地旧草稿</span>
                <span role="columnheader">当前磁盘</span>
              </div>
              {draftRows.map((row, index) => (
                <div className={`diff-row diff-${row.kind}`} role="row" key={`${index}-${row.kind}`}>
                  <span role="cell"><span className="diff-sign">{row.kind === 'removed' || row.kind === 'changed' ? '−' : ' '}</span>{row.left}</span>
                  <span role="cell"><span className="diff-sign">{row.kind === 'added' || row.kind === 'changed' ? '+' : ' '}</span>{row.right}</span>
                </div>
              ))}
            </div>
          </section>
        </div>
      )}

      <NarrativePanel
        open={narrativeOpen}
        projectTitle={boot.project.title}
        chapters={boot.chapters}
        currentChapterId={selectedId}
        onClose={() => setNarrativeOpen(false)}
        onJump={(chapterId, quote) => {
          setNarrativeOpen(false);
          if (chapterId === selectedRef.current) {
            const index = chapterRef.current?.content.indexOf(quote) ?? -1;
            if (index >= 0) editorRef.current?.setSelection(index, index + quote.length);
            return;
          }
          narrativeJumpRef.current = { chapterId, quote };
          switchChapter(chapterId);
        }}
      />

      <VoiceAtelier open={voiceOpen} onClose={() => setVoiceOpen(false)} />
      <GrowthDrawer open={growthOpen} onClose={() => setGrowthOpen(false)} mode={coevolutionMode} />
      <PlanningDrawer open={planningOpen} onClose={() => setPlanningOpen(false)} chapterId={selectedId ?? ''} revisionId={chapter?.revision.revision_id ?? ''} contentHash={chapter?.revision.content_hash ?? ''} initialTab="ai" />
      <LiteraryDrawer open={literaryOpen} onClose={() => setLiteraryOpen(false)} />
      <ContinuationDrawer open={continuationOpen} onClose={() => setContinuationOpen(false)} chapterId={selectedId ?? ''} chapterTitle={chapter?.chapter.title ?? ''} chapterOrdinal={chapter?.chapter.ordinal ?? 1} />
      <EditorialDrawer
        open={editorialOpen}
        onClose={() => setEditorialOpen(false)}
        chapterId={selectedId ?? ''}
        chapterTitle={chapter?.chapter.title ?? ''}
        chapterText={chapter?.content ?? ''}
        baseRevision={chapter?.revision.revision_id ?? ''}
        baseHash={chapter?.revision.content_hash ?? ''}
        getSelection={() => editorRef.current?.getSelection() ?? { start: 0, end: 0 }}
        mode={coevolutionMode}
      />

      <footer className="statusbar">
        <span className={`status ${saveState}`}>
          <span className="dot" aria-hidden="true" />
          {statusLabel[saveState]}
        </span>

        <span>本机自动保存</span>

      </footer>
    </div>
  );
}
