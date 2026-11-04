/**
 * Gate 2 narrative memory projection.
 *
 * Author-confirmed canon lives in `story/narrative/canon.json` (written through
 * the Story Core transaction journal). This package builds a disposable SQLite
 * index in AppDataRoot for fast Chinese n-gram search, evidence lookup,
 * timeline/knowledge queries and candidate facts. Nothing here writes canon or
 * chapter text; deleting the database and rebuilding is always safe.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  contentDigest,
  stableStringify,
  type CharacterKnowledge,
  type EvidenceAnchor,
  type Foreshadow,
  type NarrativeAssertion,
  type NarrativeCanonBundle,
  type NarrativeEntity,
  type NarrativeEvent,
  type NarrativeRelationship,
} from '@narrative-studio/contracts';
import {
  indexPathFor,
  openProject,
  readFileBytes,
  readManifest,
  readNarrativeCanon,
  readRevision,
  resolveAppDataRoot,
  resolveInside,
} from '@narrative-studio/core';

export * from './confirm.js';

export const NARRATIVE_SCHEMA_VERSION = 1;
export const NARRATIVE_DB_NAME = 'narrative.sqlite';
export type NarrativeIndexStatus = 'current' | 'stale' | 'building' | 'error' | 'missing';

export interface ChapterSource {
  chapter_id: string;
  revision_id: string;
  content_hash: string;
  chapter_order: number;
  title: string;
  content: string;
}

export interface NarrativeSearchHit {
  chapter_id: string;
  title: string;
  chapter_order: number;
  score: number;
  matches: { start: number; end: number; quote: string; exact: string; kind: 'exact' | 'partial' | 'alias' }[];
}

export interface NarrativeOverview {
  status: NarrativeIndexStatus;
  source_revision: string;
  indexed_at: string | null;
  counts: Record<string, number>;
  entities: NarrativeEntity[];
  assertions: NarrativeAssertion[];
  events: NarrativeEvent[];
  knowledge: CharacterKnowledge[];
  relationships: NarrativeRelationship[];
  foreshadowing: Foreshadow[];
  candidates: NarrativeCandidate[];
  evidence: EvidenceAnchor[];
  stale_evidence: number;
  pending_chapters: number;
  canon_stale: boolean;
}

export interface NarrativeCandidate {
  candidate_id: string;
  kind: 'knowledge' | 'relationship' | 'entity';
  text: string;
  chapter_id: string;
  chapter_order: number;
  subject_name: string;
  revision_id: string;
  chapter_content_hash: string;
  start_offset: number;
  end_offset: number;
  status: 'inferred' | 'source-extracted' | 'disputed';
  rule: string;
  quote: string;
}

export interface IndexNarrativeOptions {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  /** If omitted, compares chapter revisions and indexes only changed chapters. */
  chapters?: string[];
  full?: boolean;
  signal?: AbortSignal;
  now?: () => Date;
}

export interface IndexNarrativeResult {
  database: string;
  project_id: string;
  source_revision: string;
  status: NarrativeIndexStatus;
  indexed_chapters: number;
  total_chapters: number;
  entities: number;
  assertions: number;
  evidence: number;
  candidates: number;
  stale_evidence: number;
  pending_chapters: number;
  duration_ms: number;
}

export function narrativeDatabasePath(appDataRoot: string, projectId: string): string {
  return path.join(indexPathFor(resolveAppDataRoot(appDataRoot), projectId), NARRATIVE_DB_NAME);
}

function openDb(database: string): DatabaseSync {
  fs.mkdirSync(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;');
  createSchema(db);
  const candidateColumns = new Set((db.prepare('PRAGMA table_info(narrative_candidates)').all() as Array<{ name: string }>).map((row) => row.name));
  for (const column of ['subject_name', 'revision_id', 'chapter_content_hash']) {
    if (!candidateColumns.has(column)) db.exec('ALTER TABLE narrative_candidates ADD COLUMN ' + column + ' TEXT');
  }
  for (const column of ['start_offset', 'end_offset']) {
    if (!candidateColumns.has(column)) db.exec('ALTER TABLE narrative_candidates ADD COLUMN ' + column + ' INTEGER');
  }
  return db;
}

function createSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS narrative_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS narrative_chapters (
      chapter_id TEXT PRIMARY KEY, revision_id TEXT NOT NULL, content_hash TEXT NOT NULL,
      chapter_order INTEGER NOT NULL, title TEXT NOT NULL, indexed_at TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narrative_entities (
      entity_id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
      description TEXT, evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narrative_aliases (
      alias TEXT NOT NULL, entity_id TEXT NOT NULL, status TEXT NOT NULL, PRIMARY KEY(alias, entity_id)
    );
    CREATE TABLE IF NOT EXISTS narrative_evidence (
      anchor_id TEXT PRIMARY KEY, chapter_id TEXT NOT NULL, revision_id TEXT NOT NULL,
      start_offset INTEGER NOT NULL, end_offset INTEGER NOT NULL, quote TEXT NOT NULL,
      quote_hash TEXT NOT NULL, chapter_content_hash TEXT NOT NULL, status TEXT NOT NULL, note TEXT
    );
    CREATE INDEX IF NOT EXISTS narrative_evidence_chapter ON narrative_evidence(chapter_id, status);
    CREATE TABLE IF NOT EXISTS narrative_assertions (
      assertion_id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, predicate TEXT NOT NULL,
      object_id TEXT, value TEXT, status TEXT NOT NULL, story_kind TEXT NOT NULL,
      story_label TEXT NOT NULL, story_sort REAL, reveal_order INTEGER NOT NULL,
      knowledge_scope TEXT NOT NULL, confidence REAL NOT NULL, note TEXT
    );
    CREATE TABLE IF NOT EXISTS narrative_assertion_evidence (
      assertion_id TEXT NOT NULL, anchor_id TEXT NOT NULL, PRIMARY KEY(assertion_id, anchor_id)
    );
    CREATE TABLE IF NOT EXISTS narrative_events (
      event_id TEXT PRIMARY KEY, kind TEXT NOT NULL, description TEXT NOT NULL,
      chapter_id TEXT NOT NULL, chapter_order INTEGER NOT NULL, story_kind TEXT NOT NULL,
      story_label TEXT NOT NULL, story_sort REAL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narrative_event_participants (
      event_id TEXT NOT NULL, entity_id TEXT NOT NULL, PRIMARY KEY(event_id, entity_id)
    );
    CREATE TABLE IF NOT EXISTS narrative_event_evidence (
      event_id TEXT NOT NULL, anchor_id TEXT NOT NULL, PRIMARY KEY(event_id, anchor_id)
    );
    CREATE TABLE IF NOT EXISTS narrative_knowledge (
      knowledge_id TEXT PRIMARY KEY, character_id TEXT NOT NULL, assertion_id TEXT NOT NULL,
      learns_at_order INTEGER NOT NULL, source TEXT NOT NULL, status TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narrative_knowledge_evidence (
      knowledge_id TEXT NOT NULL, anchor_id TEXT NOT NULL, PRIMARY KEY(knowledge_id, anchor_id)
    );
    CREATE TABLE IF NOT EXISTS narrative_relationships (
      relationship_id TEXT PRIMARY KEY, from_entity_id TEXT NOT NULL, to_entity_id TEXT NOT NULL,
      kind TEXT NOT NULL, status TEXT NOT NULL, valid_from_order INTEGER NOT NULL,
      valid_to_order INTEGER, evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narrative_foreshadowing (
      clue_id TEXT PRIMARY KEY, label TEXT NOT NULL, setup_order INTEGER NOT NULL,
      payoff_order INTEGER, status TEXT NOT NULL, setup_evidence_json TEXT NOT NULL,
      payoff_evidence_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS narrative_candidates (
      candidate_id TEXT PRIMARY KEY, kind TEXT NOT NULL, text TEXT NOT NULL,
      chapter_id TEXT NOT NULL, chapter_order INTEGER NOT NULL, status TEXT NOT NULL,
      rule TEXT NOT NULL, quote TEXT NOT NULL, subject_name TEXT, revision_id TEXT, chapter_content_hash TEXT,
      start_offset INTEGER, end_offset INTEGER
    );
    CREATE TABLE IF NOT EXISTS narrative_alias_hits (
      alias TEXT NOT NULL, chapter_id TEXT NOT NULL, start_offset INTEGER NOT NULL,
      end_offset INTEGER NOT NULL, quote TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS narrative_alias_hits_alias ON narrative_alias_hits(alias);
    CREATE VIRTUAL TABLE IF NOT EXISTS narrative_chapter_fts USING fts5(
      chapter_id UNINDEXED, revision_id UNINDEXED, tokens, tokenize='unicode61'
    );
  `);
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO narrative_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function metaGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM narrative_meta WHERE key=?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function chapterSources(vaultDir: string, projectId?: string | null): { sources: ChapterSource[]; manifestRevision: string } {
  const opened = openProject(vaultDir, projectId ?? undefined);
  const manifest = readManifest(opened.projectDir);
  const sources = Object.values(manifest.chapters)
    .sort((left, right) => left.ordinal - right.ordinal)
    .map((entry) => {
      const bytes = readFileBytes(resolveInside(opened.projectDir, entry.path, 'chapter'));
      if (!bytes) throw new Error(`Missing chapter file: ${entry.chapter_id}`);
      const revision = readRevision(opened.projectDir, entry.chapter_id, entry.current_revision_id);
      return {
        chapter_id: entry.chapter_id,
        revision_id: revision.revision_id,
        content_hash: entry.content_hash,
        chapter_order: entry.ordinal,
        title: entry.title,
        content: bytes.toString('utf8'),
      };
    });
  return { sources, manifestRevision: manifest.revision };
}

function searchTerms(query: string): string[] {
  const terms = new Set<string>([query]);
  for (const part of query.split(/[\s，。；：、！？,.!?]+/)) if (part.length >= 2) terms.add(part);
  for (const match of query.matchAll(/[\u3400-\u9fff]+/g)) {
    const chars = [...match[0]];
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) terms.add(chars.slice(index, index + size).join(''));
    }
  }
  return [...terms].filter((term) => term.length >= 2);
}

function allOccurrences(text: string, needle: string): number[] {
  const positions: number[] = [];
  let from = 0;
  while (needle.length > 0) {
    const at = text.indexOf(needle, from);
    if (at < 0) break;
    positions.push(at);
    from = at + Math.max(1, needle.length);
  }
  return positions;
}

export function createEvidenceAnchor(input: {
  anchorId: string;
  chapter: { chapter_id: string; revision_id: string; content: string; content_hash: string };
  quote: string;
  occurrence?: number;
  start_offset?: number;
}): EvidenceAnchor {
  const positions = allOccurrences(input.chapter.content, input.quote);
  let occurrence = input.occurrence ?? 0;
  if (input.start_offset !== undefined) {
    if (input.chapter.content.slice(input.start_offset, input.start_offset + input.quote.length) !== input.quote) {
      throw new Error(`Quote does not match the supplied offset in ${input.chapter.chapter_id}`);
    }
    positions.splice(0, positions.length, input.start_offset);
    occurrence = 0;
  }
  if (positions.length <= occurrence) {
    throw new Error(`Quote not found in ${input.chapter.chapter_id}: ${input.quote.slice(0, 30)}`);
  }
  const start = positions[occurrence]!;
  return {
    anchor_id: input.anchorId,
    chapter_id: input.chapter.chapter_id,
    revision_id: input.chapter.revision_id,
    start_offset: start,
    end_offset: start + input.quote.length,
    quote: input.quote,
    quote_hash: contentDigest(Buffer.from(input.quote, 'utf8')),
    chapter_content_hash: input.chapter.content_hash,
    status: 'current',
    note: null,
  };
}

function resolveAnchor(anchor: EvidenceAnchor, sources: Map<string, ChapterSource>): EvidenceAnchor {
  const chapter = sources.get(anchor.chapter_id);
  if (!chapter) return { ...anchor, status: 'missing', note: 'chapter no longer exists' };
  const quoteMatches =
    chapter.content.slice(anchor.start_offset, anchor.end_offset) === anchor.quote &&
    contentDigest(Buffer.from(anchor.quote, 'utf8')) === anchor.quote_hash &&
    chapter.content_hash === anchor.chapter_content_hash &&
    chapter.revision_id === anchor.revision_id;
  if (quoteMatches) return { ...anchor, status: 'current', note: null };
  const occurrences = allOccurrences(chapter.content, anchor.quote);
  if (occurrences.length === 1) {
    return {
      ...anchor,
      revision_id: chapter.revision_id,
      start_offset: occurrences[0]!,
      end_offset: occurrences[0]! + anchor.quote.length,
      chapter_content_hash: chapter.content_hash,
      status: 'current',
      note: `reanchored from ${anchor.revision_id}`,
    };
  }
  if (occurrences.length === 0) return { ...anchor, status: 'missing', note: 'quote no longer present' };
  return { ...anchor, status: 'stale', note: 'quote is now ambiguous' };
}

function insertCanonMetadata(db: DatabaseSync, canon: NarrativeCanonBundle | null): { stale: number } {
  db.exec('DELETE FROM narrative_entities; DELETE FROM narrative_aliases; DELETE FROM narrative_assertions; DELETE FROM narrative_assertion_evidence; DELETE FROM narrative_events; DELETE FROM narrative_event_participants; DELETE FROM narrative_event_evidence; DELETE FROM narrative_knowledge; DELETE FROM narrative_knowledge_evidence; DELETE FROM narrative_relationships; DELETE FROM narrative_foreshadowing;');
  if (!canon) return { stale: 0 };
  const entity = db.prepare('INSERT INTO narrative_entities(entity_id,name,kind,status,description,evidence_json) VALUES (?,?,?,?,?,?)');
  for (const item of canon.entities) entity.run(item.entity_id, item.name, item.kind, item.status, item.description, JSON.stringify(item.evidence_anchor_ids));
  const alias = db.prepare('INSERT INTO narrative_aliases(alias,entity_id,status) VALUES (?,?,?)');
  for (const item of canon.entities) for (const name of new Set([item.name, ...item.aliases])) alias.run(name, item.entity_id, item.status);
  const assertion = db.prepare('INSERT INTO narrative_assertions(assertion_id,subject_id,predicate,object_id,value,status,story_kind,story_label,story_sort,reveal_order,knowledge_scope,confidence,note) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const ae = db.prepare('INSERT OR IGNORE INTO narrative_assertion_evidence(assertion_id,anchor_id) VALUES (?,?)');
  for (const item of canon.assertions) {
    assertion.run(item.assertion_id, item.subject_id, item.predicate, item.object_id, item.value, item.status, item.story_time.kind, item.story_time.label, item.story_time.sort_key, item.reveal_order, item.knowledge_scope, item.confidence, item.note);
    for (const id of item.evidence_anchor_ids) ae.run(item.assertion_id, id);
  }
  const event = db.prepare('INSERT INTO narrative_events(event_id,kind,description,chapter_id,chapter_order,story_kind,story_label,story_sort,status) VALUES (?,?,?,?,?,?,?,?,?)');
  const ep = db.prepare('INSERT OR IGNORE INTO narrative_event_participants(event_id,entity_id) VALUES (?,?)');
  const ee = db.prepare('INSERT OR IGNORE INTO narrative_event_evidence(event_id,anchor_id) VALUES (?,?)');
  for (const item of canon.events) {
    event.run(item.event_id, item.kind, item.description, item.chapter_id, item.chapter_order, item.story_time.kind, item.story_time.label, item.story_time.sort_key, item.status);
    for (const id of item.participant_ids) ep.run(item.event_id, id);
    for (const id of item.evidence_anchor_ids) ee.run(item.event_id, id);
  }
  const knowledge = db.prepare('INSERT INTO narrative_knowledge(knowledge_id,character_id,assertion_id,learns_at_order,source,status) VALUES (?,?,?,?,?,?)');
  const ke = db.prepare('INSERT OR IGNORE INTO narrative_knowledge_evidence(knowledge_id,anchor_id) VALUES (?,?)');
  for (const item of canon.knowledge) {
    knowledge.run(item.knowledge_id, item.character_id, item.assertion_id, item.learns_at_order, item.source, item.status);
    for (const id of item.evidence_anchor_ids) ke.run(item.knowledge_id, id);
  }
  const relationship = db.prepare('INSERT INTO narrative_relationships(relationship_id,from_entity_id,to_entity_id,kind,status,valid_from_order,valid_to_order,evidence_json) VALUES (?,?,?,?,?,?,?,?)');
  for (const item of canon.relationships) {
    relationship.run(item.relationship_id, item.from_entity_id, item.to_entity_id, item.kind, item.status, item.valid_from_order, item.valid_to_order, JSON.stringify(item.evidence_anchor_ids));
  }
  const clue = db.prepare('INSERT INTO narrative_foreshadowing(clue_id,label,setup_order,payoff_order,status,setup_evidence_json,payoff_evidence_json) VALUES (?,?,?,?,?,?,?)');
  for (const item of canon.foreshadowing) {
    clue.run(item.clue_id, item.label, item.setup_order, item.payoff_order, item.status, JSON.stringify(item.setup_evidence_anchor_ids), JSON.stringify(item.payoff_evidence_anchor_ids));
  }
  return { stale: canon.evidence.filter((entry) => entry.status !== 'current').length };
}

function extractCandidates(chapter: ChapterSource, canon: NarrativeCanonBundle | null): NarrativeCandidate[] {
  const known = new Set<string>();
  for (const entity of canon?.entities ?? []) {
    known.add(entity.name);
    for (const alias of entity.aliases) known.add(alias);
  }
  const candidates: NarrativeCandidate[] = [];
  const knowledgePattern = /([\u4e00-\u9fff]{2,3}?)(?:早就|终于|也|却)?(知道|听说|看见|相信)([^。！？\n]{2,30})/g;
  for (const match of chapter.content.matchAll(knowledgePattern)) {
    const name = match[1]!;
    if (!known.has(name)) continue;
    candidates.push({
      candidate_id: `cand_${contentDigest(Buffer.from(`${chapter.chapter_id}:knowledge:${match.index}:${match[0]}`, 'utf8')).slice(7, 27)}`,
      kind: 'knowledge',
      text: `${name}${match[2]}${match[3]}`,
      chapter_id: chapter.chapter_id,
      chapter_order: chapter.chapter_order,
      subject_name: name,
      revision_id: chapter.revision_id,
      chapter_content_hash: chapter.content_hash,
      start_offset: match.index!,
      end_offset: match.index! + match[0].length,
      status: 'inferred',
      rule: 'knowledge-verb',
      quote: match[0],
    });
  }
  const relationshipPattern = /([\u4e00-\u9fff]{2,4})(?:可能)?是([\u4e00-\u9fff]{2,4})的(父亲|母亲|兄弟|姐妹|师父|徒弟|妻子|丈夫|儿子|女儿|远亲|亲戚)/g;
  for (const match of chapter.content.matchAll(relationshipPattern)) {
    if (!known.has(match[1]!) || !known.has(match[2]!)) continue;
    candidates.push({
      candidate_id: `cand_${contentDigest(Buffer.from(`${chapter.chapter_id}:relationship:${match.index}:${match[0]}`, 'utf8')).slice(7, 27)}`,
      kind: 'relationship',
      text: match[0],
      chapter_id: chapter.chapter_id,
      chapter_order: chapter.chapter_order,
      subject_name: match[1]!,
      revision_id: chapter.revision_id,
      chapter_content_hash: chapter.content_hash,
      start_offset: match.index!,
      end_offset: match.index! + match[0].length,
      status: 'inferred',
      rule: 'relationship-copula',
      quote: match[0],
    });
  }
  return candidates;
}

function cjkTokens(text: string): string {
  const tokens: string[] = [];
  for (const match of text.matchAll(/[\u3400-\u9fff]+/g)) {
    const run = match[0];
    const chars = [...run];
    for (let size = 2; size <= 3; size += 1) {
      for (let index = 0; index + size <= chars.length; index += 1) tokens.push(chars.slice(index, index + size).join(''));
    }
  }
  for (const match of text.matchAll(/[A-Za-z0-9_]{2,}/g)) tokens.push(match[0].toLowerCase());
  return tokens.join(' ');
}

function indexChapterSearch(db: DatabaseSync, chapter: ChapterSource): void {
  db.prepare('DELETE FROM narrative_chapter_fts WHERE chapter_id=?').run(chapter.chapter_id);
  db.prepare('INSERT INTO narrative_chapter_fts(chapter_id,revision_id,tokens) VALUES (?,?,?)').run(chapter.chapter_id, chapter.revision_id, cjkTokens(chapter.content));
}

function indexAliasHits(
  db: DatabaseSync,
  chapter: ChapterSource,
  canon: NarrativeCanonBundle | null,
): void {
  db.prepare('DELETE FROM narrative_alias_hits WHERE chapter_id=?').run(chapter.chapter_id);
  for (const entity of canon?.entities ?? []) {
    for (const alias of new Set([entity.name, ...entity.aliases])) {
      for (const start of allOccurrences(chapter.content, alias)) {
        db.prepare('INSERT INTO narrative_alias_hits(alias,chapter_id,start_offset,end_offset,quote) VALUES (?,?,?,?,?)').run(
          alias,
          chapter.chapter_id,
          start,
          start + alias.length,
          chapter.content.slice(start, start + alias.length),
        );
      }
    }
  }
}

function indexCandidates(
  db: DatabaseSync,
  chapter: ChapterSource,
  canon: NarrativeCanonBundle | null,
): number {
  db.prepare('DELETE FROM narrative_candidates WHERE chapter_id=?').run(chapter.chapter_id);
  const candidates = extractCandidates(chapter, canon);
  for (const candidate of candidates) {
    db.prepare('INSERT INTO narrative_candidates(candidate_id,kind,text,chapter_id,chapter_order,status,rule,quote,subject_name,revision_id,chapter_content_hash,start_offset,end_offset) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      candidate.candidate_id, candidate.kind, candidate.text, candidate.chapter_id, candidate.chapter_order, candidate.status, candidate.rule, candidate.quote,
      candidate.subject_name, candidate.revision_id, candidate.chapter_content_hash, candidate.start_offset, candidate.end_offset,
    );
  }
  return candidates.length;
}

function upsertEvidence(db: DatabaseSync, anchors: EvidenceAnchor[]): void {
  for (const anchor of anchors) {
    db.prepare('INSERT INTO narrative_evidence(anchor_id,chapter_id,revision_id,start_offset,end_offset,quote,quote_hash,chapter_content_hash,status,note) VALUES (?,?,?,?,?,?,?,?,?,?) ON CONFLICT(anchor_id) DO UPDATE SET chapter_id=excluded.chapter_id,revision_id=excluded.revision_id,start_offset=excluded.start_offset,end_offset=excluded.end_offset,quote=excluded.quote,quote_hash=excluded.quote_hash,chapter_content_hash=excluded.chapter_content_hash,status=excluded.status,note=excluded.note').run(
      anchor.anchor_id, anchor.chapter_id, anchor.revision_id, anchor.start_offset, anchor.end_offset,
      anchor.quote, anchor.quote_hash, anchor.chapter_content_hash, anchor.status, anchor.note,
    );
  }
}

export function indexNarrative(options: IndexNarrativeOptions): IndexNarrativeResult {
  const started = Date.now();
  const now = options.now ?? (() => new Date());
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const appDataRoot = resolveAppDataRoot(options.appDataRoot ?? null);
  const database = narrativeDatabasePath(appDataRoot, opened.project.project_id);
  const canon = readNarrativeCanon(opened.projectDir);
  const { sources, manifestRevision } = chapterSources(options.vaultDir, opened.project.project_id);
  const sourceMap = new Map(sources.map((source) => [source.chapter_id, source]));
  const db = openDb(database);
  const statusRevision = metaGet(db, 'source_revision');
  const canonHash = contentDigest(Buffer.from(stableStringify(canon ?? null), 'utf8'));
  const priorCanonHash = metaGet(db, 'canon_hash');
  const canonChanged = priorCanonHash !== canonHash;
  const indexedRevisions = new Map(
    (db.prepare('SELECT chapter_id, revision_id FROM narrative_chapters').all() as Array<{ chapter_id: string; revision_id: string }>)
      .map((row) => [row.chapter_id, row.revision_id]),
  );
  const dirtyIds = sources
    .filter((source) => indexedRevisions.get(source.chapter_id) !== source.revision_id)
    .map((source) => source.chapter_id);
  let targetIds: string[] = [];
  if (options.full || !statusRevision || canonChanged) {
    targetIds = sources.map((source) => source.chapter_id);
  } else {
    const requested = options.chapters ?? [];
    targetIds = [...new Set([...requested, ...dirtyIds])];
  }
  if (options.signal?.aborted) throw new Error('narrative indexing cancelled');

  db.exec('BEGIN IMMEDIATE');
  try {
    metaSet(db, 'status', 'building');
    if (options.full) {
      db.exec('DELETE FROM narrative_evidence; DELETE FROM narrative_candidates; DELETE FROM narrative_alias_hits; DELETE FROM narrative_chapter_fts; DELETE FROM narrative_chapters;');
    }
    const stale = insertCanonMetadata(db, canon);
    const resolvedAnchors: EvidenceAnchor[] = [];
    for (const anchor of canon?.evidence ?? []) {
      const resolved = resolveAnchor(anchor, sourceMap);
      resolvedAnchors.push(resolved);
    }
    upsertEvidence(db, resolvedAnchors);
    for (const chapterId of targetIds) {
      if (options.signal?.aborted) {
        db.exec('ROLLBACK');
        metaSet(db, 'status', 'stale');
        return {
          database, project_id: opened.project.project_id, source_revision: manifestRevision,
          status: 'stale', indexed_chapters: 0, total_chapters: sources.length,
          entities: canon?.entities.length ?? 0, assertions: canon?.assertions.length ?? 0,
          evidence: canon?.evidence.length ?? 0, candidates: 0, stale_evidence: stale.stale,
          pending_chapters: sources.length, duration_ms: Date.now() - started,
        };
      }
      const chapter = sourceMap.get(chapterId);
      if (!chapter) continue;
      db.prepare('DELETE FROM narrative_evidence WHERE chapter_id=?').run(chapter.chapter_id);
      for (const anchor of resolvedAnchors.filter((entry) => entry.chapter_id === chapter.chapter_id)) upsertEvidence(db, [anchor]);
      indexChapterSearch(db, chapter);
      indexAliasHits(db, chapter, canon);
      indexCandidates(db, chapter, canon);
      db.prepare('INSERT INTO narrative_chapters(chapter_id,revision_id,content_hash,chapter_order,title,indexed_at,status) VALUES (?,?,?,?,?,?,?) ON CONFLICT(chapter_id) DO UPDATE SET revision_id=excluded.revision_id,content_hash=excluded.content_hash,chapter_order=excluded.chapter_order,title=excluded.title,indexed_at=excluded.indexed_at,status=excluded.status').run(
        chapter.chapter_id, chapter.revision_id, chapter.content_hash, chapter.chapter_order, chapter.title, now().toISOString(), 'current',
      );
    }
    const totalCandidates = (db.prepare('SELECT COUNT(*) AS n FROM narrative_candidates').get() as { n: number }).n;
    const totalEvidence = (db.prepare('SELECT COUNT(*) AS n FROM narrative_evidence').get() as { n: number }).n;
    const staleEvidence = (db.prepare("SELECT COUNT(*) AS n FROM narrative_evidence WHERE status != 'current'").get() as { n: number }).n;
    const afterRows = new Map(
      (db.prepare('SELECT chapter_id, revision_id FROM narrative_chapters').all() as Array<{ chapter_id: string; revision_id: string }>)
        .map((row) => [row.chapter_id, row.revision_id]),
    );
    const pendingChapters = sources.filter((source) => afterRows.get(source.chapter_id) !== source.revision_id).length;
    metaSet(db, 'source_revision', manifestRevision);
    metaSet(db, 'canon_hash', canonHash);
    metaSet(db, 'pending_chapters', String(pendingChapters));
    db.exec('COMMIT');
    const currentRevision = readManifest(opened.projectDir).revision;
    const finalStatus: NarrativeIndexStatus =
      currentRevision === manifestRevision && pendingChapters === 0 ? 'current' : 'stale';
    metaSet(db, 'status', finalStatus);
    metaSet(db, 'indexed_at', now().toISOString());
    metaSet(db, 'indexed_chapters', String(targetIds.length));
    metaSet(db, 'stale_evidence', String(staleEvidence));
    db.close();
    return {
      database,
      project_id: opened.project.project_id,
      source_revision: manifestRevision,
      status: finalStatus,
      indexed_chapters: targetIds.length,
      total_chapters: sources.length,
      entities: canon?.entities.length ?? 0,
      assertions: canon?.assertions.length ?? 0,
      evidence: totalEvidence,
      candidates: totalCandidates,
      stale_evidence: staleEvidence,
      pending_chapters: pendingChapters,
      duration_ms: Date.now() - started,
    };
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      /* already rolled back */
    }
    metaSet(db, 'status', 'error');
    metaSet(db, 'error', error instanceof Error ? error.message : String(error));
    db.close();
    throw error;
  }
}

export function rebuildNarrativeIndex(options: Omit<IndexNarrativeOptions, 'chapters' | 'full'>): IndexNarrativeResult {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const database = narrativeDatabasePath(resolveAppDataRoot(options.appDataRoot ?? null), opened.project.project_id);
  for (const suffix of ['', '-wal', '-shm']) {
    try {
      fs.rmSync(`${database}${suffix}`, { force: true });
    } catch {
      /* best effort; open will recreate */
    }
  }
  return indexNarrative({ ...options, full: true });
}

function queryEntities(db: DatabaseSync): NarrativeEntity[] {
  return (db.prepare('SELECT * FROM narrative_entities ORDER BY name').all() as Array<Record<string, unknown>>).map((row) => ({
    entity_id: String(row.entity_id),
    name: String(row.name),
    kind: String(row.kind) as NarrativeEntity['kind'],
    aliases: (db.prepare('SELECT alias FROM narrative_aliases WHERE entity_id=?').all(String(row.entity_id)) as Array<{ alias: string }>).map((entry) => entry.alias),
    description: row.description === null ? null : String(row.description),
    status: String(row.status) as NarrativeEntity['status'],
    evidence_anchor_ids: JSON.parse(String(row.evidence_json ?? '[]')) as string[],
  }));
}

function queryAssertions(db: DatabaseSync): NarrativeAssertion[] {
  return (db.prepare('SELECT * FROM narrative_assertions ORDER BY reveal_order, assertion_id').all() as Array<Record<string, unknown>>).map((row) => ({
    assertion_id: String(row.assertion_id),
    subject_id: String(row.subject_id),
    predicate: String(row.predicate),
    object_id: row.object_id === null ? null : String(row.object_id),
    value: row.value === null ? null : String(row.value),
    status: String(row.status) as NarrativeAssertion['status'],
    story_time: {
      kind: String(row.story_kind) as NarrativeAssertion['story_time']['kind'],
      label: String(row.story_label),
      sort_key: row.story_sort === null ? null : Number(row.story_sort),
    },
    reveal_order: Number(row.reveal_order),
    knowledge_scope: String(row.knowledge_scope),
    confidence: Number(row.confidence),
    evidence_anchor_ids: (db.prepare('SELECT anchor_id FROM narrative_assertion_evidence WHERE assertion_id=?').all(String(row.assertion_id)) as Array<{ anchor_id: string }>).map((entry) => entry.anchor_id),
    note: row.note === null ? null : String(row.note),
  }));
}

function queryEvents(db: DatabaseSync): NarrativeEvent[] {
  return (db.prepare('SELECT * FROM narrative_events ORDER BY chapter_order, event_id').all() as Array<Record<string, unknown>>).map((row) => ({
    event_id: String(row.event_id),
    kind: String(row.kind) as NarrativeEvent['kind'],
    description: String(row.description),
    chapter_id: String(row.chapter_id),
    chapter_order: Number(row.chapter_order),
    story_time: {
      kind: String(row.story_kind) as NarrativeEvent['story_time']['kind'],
      label: String(row.story_label),
      sort_key: row.story_sort === null ? null : Number(row.story_sort),
    },
    participant_ids: (db.prepare('SELECT entity_id FROM narrative_event_participants WHERE event_id=?').all(String(row.event_id)) as Array<{ entity_id: string }>).map((entry) => entry.entity_id),
    status: String(row.status) as NarrativeEvent['status'],
    evidence_anchor_ids: (db.prepare('SELECT anchor_id FROM narrative_event_evidence WHERE event_id=?').all(String(row.event_id)) as Array<{ anchor_id: string }>).map((entry) => entry.anchor_id),
  }));
}

function queryKnowledge(db: DatabaseSync): CharacterKnowledge[] {
  return (db.prepare('SELECT * FROM narrative_knowledge ORDER BY learns_at_order, knowledge_id').all() as Array<Record<string, unknown>>).map((row) => ({
    knowledge_id: String(row.knowledge_id),
    character_id: String(row.character_id),
    assertion_id: String(row.assertion_id),
    learns_at_order: Number(row.learns_at_order),
    source: String(row.source) as CharacterKnowledge['source'],
    status: String(row.status) as CharacterKnowledge['status'],
    evidence_anchor_ids: (db.prepare('SELECT anchor_id FROM narrative_knowledge_evidence WHERE knowledge_id=?').all(String(row.knowledge_id)) as Array<{ anchor_id: string }>).map((entry) => entry.anchor_id),
  }));
}

function queryRelationships(db: DatabaseSync): NarrativeRelationship[] {
  return (db.prepare('SELECT * FROM narrative_relationships ORDER BY relationship_id').all() as Array<Record<string, unknown>>).map((row) => ({
    relationship_id: String(row.relationship_id),
    from_entity_id: String(row.from_entity_id),
    to_entity_id: String(row.to_entity_id),
    kind: String(row.kind),
    status: String(row.status) as NarrativeRelationship['status'],
    valid_from_order: Number(row.valid_from_order),
    valid_to_order: row.valid_to_order === null ? null : Number(row.valid_to_order),
    evidence_anchor_ids: JSON.parse(String(row.evidence_json ?? '[]')) as string[],
  }));
}

function queryForeshadowing(db: DatabaseSync): Foreshadow[] {
  return (db.prepare('SELECT * FROM narrative_foreshadowing ORDER BY setup_order, clue_id').all() as Array<Record<string, unknown>>).map((row) => ({
    clue_id: String(row.clue_id),
    label: String(row.label),
    setup_order: Number(row.setup_order),
    payoff_order: row.payoff_order === null ? null : Number(row.payoff_order),
    status: String(row.status) as Foreshadow['status'],
    setup_evidence_anchor_ids: JSON.parse(String(row.setup_evidence_json ?? '[]')) as string[],
    payoff_evidence_anchor_ids: JSON.parse(String(row.payoff_evidence_json ?? '[]')) as string[],
  }));
}

function queryCandidates(db: DatabaseSync): NarrativeCandidate[] {
  return (db.prepare('SELECT * FROM narrative_candidates ORDER BY chapter_order, candidate_id').all() as Array<Record<string, unknown>>).map((row) => ({
    candidate_id: String(row.candidate_id),
    kind: String(row.kind) as NarrativeCandidate['kind'],
    text: String(row.text),
    chapter_id: String(row.chapter_id),
    chapter_order: Number(row.chapter_order),
    subject_name: row.subject_name === null || row.subject_name === undefined ? '' : String(row.subject_name),
    revision_id: row.revision_id === null || row.revision_id === undefined ? '' : String(row.revision_id),
    chapter_content_hash: row.chapter_content_hash === null || row.chapter_content_hash === undefined ? '' : String(row.chapter_content_hash),
    start_offset: row.start_offset === null || row.start_offset === undefined ? 0 : Number(row.start_offset),
    end_offset: row.end_offset === null || row.end_offset === undefined ? 0 : Number(row.end_offset),
    status: String(row.status) as NarrativeCandidate['status'],
    rule: String(row.rule),
    quote: String(row.quote),
  }));
}

export function readNarrativeOverview(options: { vaultDir: string; projectId?: string | null; appDataRoot?: string | null }): NarrativeOverview {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const database = narrativeDatabasePath(resolveAppDataRoot(options.appDataRoot ?? null), opened.project.project_id);
  if (!fs.existsSync(database)) {
    return {
      status: 'missing', source_revision: '', indexed_at: null, counts: {}, entities: [], assertions: [],
      events: [], knowledge: [], relationships: [], foreshadowing: [], candidates: [], evidence: [], stale_evidence: 0, pending_chapters: 0, canon_stale: false,
    };
  }
  const db = new DatabaseSync(database);
  try {
    const canon = readNarrativeCanon(opened.projectDir);
    const confirmedCandidateIds = new Set(
      (canon?.assertions ?? [])
        .flatMap((assertion) => assertion.note?.match(/cand_[a-z0-9:]+/g) ?? []),
    );
    const candidates = queryCandidates(db).filter((candidate) => !confirmedCandidateIds.has(candidate.candidate_id));
    const counts = {
      chapters: Number((db.prepare('SELECT COUNT(*) AS n FROM narrative_chapters').get() as { n: number }).n),
      entities: Number((db.prepare('SELECT COUNT(*) AS n FROM narrative_entities').get() as { n: number }).n),
      assertions: Number((db.prepare('SELECT COUNT(*) AS n FROM narrative_assertions').get() as { n: number }).n),
      evidence: Number((db.prepare('SELECT COUNT(*) AS n FROM narrative_evidence').get() as { n: number }).n),
      candidates: candidates.length,
    };
    const manifest = readManifest(opened.projectDir);
    const rows = new Map(
      (db.prepare('SELECT chapter_id, revision_id FROM narrative_chapters').all() as Array<{ chapter_id: string; revision_id: string }>)
        .map((row) => [row.chapter_id, row.revision_id]),
    );
    const pendingChapters = Object.values(manifest.chapters).filter((entry) => rows.get(entry.chapter_id) !== entry.current_revision_id).length;
    const storedRevision = metaGet(db, 'source_revision') ?? '';
    const storedStatus = (metaGet(db, 'status') ?? 'stale') as NarrativeIndexStatus;
    const canonStale = metaGet(db, 'canon_hash') !== contentDigest(Buffer.from(stableStringify(canon ?? null), 'utf8'));
    const actualStatus: NarrativeIndexStatus =
      storedStatus === 'current' && (pendingChapters > 0 || canonStale || storedRevision !== manifest.revision)
        ? 'stale'
        : storedStatus;
    return {
      status: actualStatus,
      source_revision: storedRevision,
      indexed_at: metaGet(db, 'indexed_at'),
      counts,
      entities: queryEntities(db),
      assertions: queryAssertions(db),
      events: queryEvents(db),
      knowledge: queryKnowledge(db),
      relationships: queryRelationships(db),
      foreshadowing: queryForeshadowing(db),
      candidates,
      pending_chapters: pendingChapters,
      canon_stale: canonStale,
      evidence: (db.prepare('SELECT * FROM narrative_evidence ORDER BY chapter_id, start_offset').all() as Array<Record<string, unknown>>).map((row) => ({
        anchor_id: String(row.anchor_id),
        chapter_id: String(row.chapter_id),
        revision_id: String(row.revision_id),
        start_offset: Number(row.start_offset),
        end_offset: Number(row.end_offset),
        quote: String(row.quote),
        quote_hash: String(row.quote_hash),
        chapter_content_hash: String(row.chapter_content_hash),
        status: String(row.status) as EvidenceAnchor['status'],
        note: row.note === null ? null : String(row.note),
      })),
      stale_evidence: Number((db.prepare("SELECT COUNT(*) AS n FROM narrative_evidence WHERE status != 'current'").get() as { n: number }).n),
    };
  } finally {
    db.close();
  }
}

export function searchNarrative(options: {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  query: string;
  limit?: number;
  atOrder?: number | null;
}): NarrativeSearchHit[] {
  const query = options.query.trim();
  if (query.length === 0) return [];
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const database = narrativeDatabasePath(resolveAppDataRoot(options.appDataRoot ?? null), opened.project.project_id);
  if (!fs.existsSync(database)) return [];
  const db = new DatabaseSync(database);
  try {
    const limit = Math.min(100, Math.max(1, options.limit ?? 20));
    const chapterOrder = new Map(
      (db.prepare('SELECT chapter_id,title,chapter_order FROM narrative_chapters').all() as Array<{ chapter_id: string; title: string; chapter_order: number }>).map((row) => [row.chapter_id, row]),
    );
    const scores = new Map<string, number>();
    const tokens = cjkTokens(query);
    if (tokens.length > 0) {
      const ftsQuery = tokens.split(' ').slice(0, 12).map((token) => `"${token.replace(/"/g, '""')}"`).join(' OR ');
      try {
        for (const row of db.prepare('SELECT chapter_id FROM narrative_chapter_fts WHERE tokens MATCH ? LIMIT ?').all(ftsQuery, limit) as Array<{ chapter_id: string }>) {
          scores.set(row.chapter_id, (scores.get(row.chapter_id) ?? 0) + 2);
        }
      } catch {
        /* query tokenizer edge case: exact alias path below still works */
      }
    }
    const aliasChapters = new Set<string>(
      (db.prepare('SELECT DISTINCT chapter_id FROM narrative_alias_hits WHERE alias=? LIMIT ?').all(query, limit) as Array<{ chapter_id: string }>)
        .map((row) => row.chapter_id),
    );
    for (const chapterId of aliasChapters) {
      scores.set(chapterId, (scores.get(chapterId) ?? 0) + 4);
    }
    const hits: NarrativeSearchHit[] = [];
    for (const [chapterId, score] of scores) {
      const chapter = chapterOrder.get(chapterId);
      if (!chapter) continue;
      if (options.atOrder !== undefined && options.atOrder !== null && chapter.chapter_order > options.atOrder) continue;
      const entry = readManifest(opened.projectDir).chapters[chapterId];
      const bytes = entry ? readFileBytes(resolveInside(opened.projectDir, entry.path, 'chapter')) : null;
      const content = bytes?.toString('utf8') ?? '';
      const matches: { start: number; end: number; quote: string; exact: string; kind: 'exact' | 'partial' | 'alias' }[] = [];
      const seen = new Set<string>();
      const add = (needle: string, kind: 'exact' | 'partial' | 'alias') => {
        for (const start of allOccurrences(content, needle).slice(0, 3)) {
          const end = start + needle.length;
          if (content.slice(start, end) !== needle) continue;
          const key = `${start}:${end}:${kind}:${needle}`;
          if (seen.has(key)) continue;
          seen.add(key);
          matches.push({
            start,
            end,
            exact: needle,
            kind,
            quote: content.slice(Math.max(0, start - 24), Math.min(content.length, end + 24)),
          });
        }
      };
      if (aliasChapters.has(chapterId)) add(query, 'alias');
      else if (allOccurrences(content, query).length > 0) add(query, 'exact');
      if (matches.length === 0) {
        for (const term of searchTerms(query)) {
          if (term === query) continue;
          add(term, 'partial');
          if (matches.length >= 5) break;
        }
      }
      hits.push({ chapter_id: chapterId, title: chapter.title, chapter_order: chapter.chapter_order, score, matches: matches.slice(0, 5) });
    }
    return hits.sort((left, right) => right.score - left.score || left.chapter_order - right.chapter_order).slice(0, limit);
  } finally {
    db.close();
  }
}

export function chapterEvidence(options: {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  chapterId: string;
}): { evidence: EvidenceAnchor[]; assertion_ids: string[]; event_ids: string[] } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const database = narrativeDatabasePath(resolveAppDataRoot(options.appDataRoot ?? null), opened.project.project_id);
  if (!fs.existsSync(database)) return { evidence: [], assertion_ids: [], event_ids: [] };
  const db = new DatabaseSync(database);
  try {
    const evidence = (db.prepare('SELECT * FROM narrative_evidence WHERE chapter_id=? ORDER BY start_offset').all(options.chapterId) as Array<Record<string, unknown>>).map((row) => ({
      anchor_id: String(row.anchor_id),
      chapter_id: String(row.chapter_id),
      revision_id: String(row.revision_id),
      start_offset: Number(row.start_offset),
      end_offset: Number(row.end_offset),
      quote: String(row.quote),
      quote_hash: String(row.quote_hash),
      chapter_content_hash: String(row.chapter_content_hash),
      status: String(row.status) as EvidenceAnchor['status'],
      note: row.note === null ? null : String(row.note),
    }));
    const assertionIds = (db.prepare('SELECT DISTINCT ae.assertion_id FROM narrative_assertion_evidence ae JOIN narrative_evidence e ON e.anchor_id=ae.anchor_id WHERE e.chapter_id=?').all(options.chapterId) as Array<{ assertion_id: string }>).map((row) => row.assertion_id);
    const eventIds = (db.prepare('SELECT DISTINCT ee.event_id FROM narrative_event_evidence ee JOIN narrative_evidence e ON e.anchor_id=ee.anchor_id WHERE e.chapter_id=?').all(options.chapterId) as Array<{ event_id: string }>).map((row) => row.event_id);
    return { evidence, assertion_ids: assertionIds, event_ids: eventIds };
  } finally {
    db.close();
  }
}

export function narrativeCounts(database: string): Record<string, number> {
  const db = new DatabaseSync(database);
  try {
    const count = (table: string): number => Number((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return {
      chapters: count('narrative_chapters'),
      entities: count('narrative_entities'),
      assertions: count('narrative_assertions'),
      evidence: count('narrative_evidence'),
      candidates: count('narrative_candidates'),
      alias_hits: count('narrative_alias_hits'),
    };
  } finally {
    db.close();
  }
}
