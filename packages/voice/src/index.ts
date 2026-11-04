/**
 * Gate 3A Voice Forge.
 *
 * Authoritative source licences and Style Constitution live in the Vault via
 * packages/core/voice.ts. This package only derives deterministic, explainable
 * statistics into a disposable SQLite projection; it never writes source text,
 * never approves a rule, and never calls a model.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  contentDigest,
  newVoiceId,
  type EvidenceAnchor,
  type StyleRule,
  type VoiceCharacterProfile,
  type VoiceConfidence,
  type VoiceCorpusRegistry,
  type VoiceCorpusSource,
  type VoiceMetric,
  type VoicePermissions,
  type VoiceProfile,
  type VoiceScope,
} from '@narrative-studio/contracts';
import {
  indexPathFor,
  openProject,
  readChapterBytes,
  readManifest,
  readRevision,
  readStyleConstitution,
  readVoiceCorpus,
  resolveAppDataRoot,
  writeStyleConstitution,
  writeVoiceCorpus,
} from '@narrative-studio/core';

export const VOICE_ALGORITHM_VERSION = 'voice.metrics.v1';
export const VOICE_DB_NAME = 'voice.sqlite';

export interface VoiceProposal {
  proposal_id: string;
  project_id: string;
  scope: VoiceScope;
  scope_ref: string | null;
  intent: 'retain' | 'prefer' | 'avoid' | 'explore';
  text: string;
  conditions: string;
  source_ids: string[];
  evidence_anchor_ids: string[];
  metric_ids: string[];
  status: 'proposal';
  created_at: string;
}

export interface VoiceSourceView extends VoiceCorpusSource {
  effective_status: 'active' | 'stale' | 'revoked' | 'deleted';
  stale_reason: string | null;
  chapter_count: number;
}

export interface VoiceRuleView extends StyleRule {
  effective_status: 'approved' | 'revoked' | 'stale';
  stale_reason: string | null;
}

export interface VoiceOverview {
  status: 'current' | 'stale' | 'missing' | 'error';
  project_id: string;
  registry_version: number;
  constitution_version: number;
  sources: VoiceSourceView[];
  profiles: VoiceProfile[];
  proposals: VoiceProposal[];
  rules: VoiceRuleView[];
  generated_at: string | null;
  stale_reason: string | null;
}

export interface RegisterVoiceSourceInput {
  name: string;
  description?: string;
  scope: VoiceScope;
  scopeRef?: string | null;
  category: 'author-owned' | 'licensed-reference' | 'synthetic';
  rightsStatement: string;
  permissions: Partial<VoicePermissions>;
  chapterIds?: string[];
  encoding?: string;
}

interface LoadedSource {
  source: VoiceCorpusSource;
  text: string;
  valid: boolean;
  staleReason: string | null;
  chapters: { chapter_id: string; revision_id: string; content_hash: string }[];
  segments: { ref: { chapter_id: string; revision_id: string; content_hash: string }; text: string }[];
  evidenceAllowed: boolean;
}

interface TextEvidence {
  quote: string;
  chapterId: string;
  revisionId: string;
  contentHash: string;
  start: number;
  end: number;
}

export function voiceDatabasePath(appDataRoot: string, projectId: string): string {
  return path.join(indexPathFor(resolveAppDataRoot(appDataRoot), projectId), VOICE_DB_NAME);
}

function openDb(database: string): DatabaseSync {
  fs.mkdirSync(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS voice_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS voice_profiles (
      profile_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, scope TEXT NOT NULL,
      scope_ref TEXT, status TEXT NOT NULL, generated_at TEXT NOT NULL, json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS voice_proposals (
      proposal_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL,
      created_at TEXT NOT NULL, json TEXT NOT NULL
    );
  `);
  return db;
}

function metaSet(db: DatabaseSync, key: string, value: string): void {
  db.prepare('INSERT INTO voice_meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key, value);
}

function metaGet(db: DatabaseSync, key: string): string | null {
  const row = db.prepare('SELECT value FROM voice_meta WHERE key=?').get(key) as { value?: string } | undefined;
  return row?.value ?? null;
}

function defaultPermissions(permissions: Partial<VoicePermissions> | undefined): VoicePermissions {
  return {
    local_analysis: permissions?.local_analysis === true,
    quote_display: permissions?.quote_display === true,
    sample_storage: permissions?.sample_storage === true,
    cross_project_reuse: permissions?.cross_project_reuse === true,
    external_send: permissions?.external_send === true,
    public_release: permissions?.public_release === true,
  };
}

function chapterRefs(opened: ReturnType<typeof openProject>, chapterIds?: string[]): VoiceCorpusSource['chapters'] {
  const entries = chapterIds
    ? chapterIds.map((id) => opened.manifest.chapters[id]).filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
    : Object.values(opened.manifest.chapters);
  return entries.map((entry) => ({
    chapter_id: entry.chapter_id,
    revision_id: entry.current_revision_id,
    content_hash: entry.content_hash,
  }));
}

export function registerVoiceSource(options: {
  vaultDir: string;
  projectId?: string | null;
  input: RegisterVoiceSourceInput;
  actorId?: string;
}): { source: VoiceCorpusSource; registry: VoiceCorpusRegistry; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const input = options.input;
  const permissions = defaultPermissions(input.permissions);
  if (!permissions.local_analysis) {
    throw new Error('来源必须明确允许本地分析（local_analysis）后才能登记');
  }
  if (input.scope === 'character' && !input.scopeRef) {
    throw new Error('角色来源必须指定角色名/ID');
  }
  if (input.scope === 'scene' && !input.scopeRef) {
    throw new Error('场景来源必须指定场景标签');
  }
  const existing = readVoiceCorpus(opened.projectDir);
  const now = new Date().toISOString();
  const source: VoiceCorpusSource = {
    source_id: newVoiceId('vsrc'),
    project_id: opened.project.project_id,
    scope: input.scope,
    scope_ref: input.scopeRef ?? null,
    category: input.category,
    name: input.name.trim(),
    description: input.description?.trim() ?? '',
    rights_statement: input.rightsStatement.trim(),
    permissions,
    chapters: chapterRefs(opened, input.chapterIds),
    encoding: input.encoding ?? 'utf-8',
    registered_at: now,
    updated_at: now,
    status: 'active',
    revoked_at: null,
    revoke_reason: null,
  };
  if (source.chapters.length === 0) throw new Error('来源没有关联任何 Vault 章节');
  const registry: VoiceCorpusRegistry = {
    schema_version: SCHEMA_VERSION,
    project_id: opened.project.project_id,
    version: (existing?.version ?? 0) + 1,
    updated_at: now,
    sources: [...(existing?.sources ?? []), source],
  };
  const written = writeVoiceCorpus({
    vaultDir: options.vaultDir,
    projectId: opened.project.project_id,
    value: registry,
    actor: { kind: 'author', id: options.actorId ?? 'local-author' },
  });
  return { source, registry: written.value, manifestRevision: written.manifestRevision };
}

export function revokeVoiceSource(options: {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  sourceId: string;
  reason: string;
  actorId?: string;
}): { registry: VoiceCorpusRegistry; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const registry = readVoiceCorpus(opened.projectDir);
  if (!registry) throw new Error('Voice corpus registry not found');
  const source = registry.sources.find((item) => item.source_id === options.sourceId);
  if (!source) throw new Error('Voice source not found');
  const now = new Date().toISOString();
  const next: VoiceCorpusRegistry = {
    ...registry,
    version: registry.version + 1,
    updated_at: now,
    sources: registry.sources.map((item) => item.source_id === options.sourceId
      ? { ...item, status: 'revoked' as const, revoked_at: now, revoke_reason: options.reason, updated_at: now }
      : item),
  };
  const written = writeVoiceCorpus({
    vaultDir: options.vaultDir,
    projectId: opened.project.project_id,
    value: next,
    actor: { kind: 'author', id: options.actorId ?? 'local-author' },
  });
  if (options.appDataRoot) {
    analyzeVoice({ vaultDir: options.vaultDir, projectId: opened.project.project_id, appDataRoot: options.appDataRoot });
  }
  return { registry: written.value, manifestRevision: written.manifestRevision };
}

export function deleteVoiceSource(options: {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  sourceId: string;
  reason: string;
  actorId?: string;
}): { registry: VoiceCorpusRegistry; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const registry = readVoiceCorpus(opened.projectDir);
  if (!registry) throw new Error('Voice corpus registry not found');
  const source = registry.sources.find((item) => item.source_id === options.sourceId);
  if (!source) throw new Error('Voice source not found');
  const now = new Date().toISOString();
  const next: VoiceCorpusRegistry = {
    ...registry,
    version: registry.version + 1,
    updated_at: now,
    sources: registry.sources.map((item) => item.source_id === options.sourceId
      ? { ...item, status: 'deleted' as const, revoked_at: now, revoke_reason: options.reason, updated_at: now }
      : item),
  };
  const written = writeVoiceCorpus({
    vaultDir: options.vaultDir,
    projectId: opened.project.project_id,
    value: next,
    actor: { kind: 'author', id: options.actorId ?? 'local-author' },
  });
  if (options.appDataRoot) {
    analyzeVoice({ vaultDir: options.vaultDir, projectId: opened.project.project_id, appDataRoot: options.appDataRoot });
  }
  return { registry: written.value, manifestRevision: written.manifestRevision };
}
export function isVoiceSourceCurrent(options: {
  vaultDir: string;
  projectId?: string | null;
  source: VoiceCorpusSource;
}): boolean {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  return loadSource(opened, options.source).valid;
}
function loadSource(opened: ReturnType<typeof openProject>, source: VoiceCorpusSource): LoadedSource {
  const chapters: { chapter_id: string; revision_id: string; content_hash: string }[] = [];
  const texts: string[] = [];
  const segments: { ref: { chapter_id: string; revision_id: string; content_hash: string }; text: string }[] = [];
  let staleReason: string | null = null;
  if (source.status !== 'active') staleReason = `来源状态：${source.status}${source.revoke_reason ? `（${source.revoke_reason}）` : ''}`;
  for (const ref of source.chapters) {
    const entry = opened.manifest.chapters[ref.chapter_id];
    if (!entry || entry.current_revision_id !== ref.revision_id || entry.content_hash !== ref.content_hash) {
      staleReason = `章节 ${ref.chapter_id} 的修订/哈希已变化或不存在`;
      continue;
    }
    const revision = readRevision(opened.projectDir, ref.chapter_id, ref.revision_id);
    if (revision.content_hash !== ref.content_hash) {
      staleReason = `章节 ${ref.chapter_id} 的内容哈希不匹配`;
      continue;
    }
    const bytes = readChapterBytes(opened.projectDir, ref.chapter_id);
    const chapterText = bytes.toString('utf8');
    texts.push(chapterText);
    segments.push({ ref, text: chapterText });
    chapters.push(ref);
  }
  return {
    source,
    text: texts.join('\n\n'),
    valid: !staleReason && chapters.length === source.chapters.length,
    staleReason,
    chapters,
    segments,
    evidenceAllowed: source.permissions.quote_display && source.permissions.sample_storage,
  };
}

function cjkCount(text: string): number {
  return [...text].filter((char) => /[\u3400-\u9fff]/.test(char)).length;
}

function ranges(text: string, pattern: RegExp): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  for (const match of text.matchAll(pattern)) {
    const start = match.index ?? 0;
    out.push({ start, end: start + match[0].length, text: match[0] });
  }
  return out;
}

function sentenceRanges(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let start = 0;
  for (const match of text.matchAll(/[。！？!?…]+/g)) {
    const end = (match.index ?? 0) + match[0].length;
    const value = text.slice(start, end).trim();
    if (value.length > 0) out.push({ start, end, text: value });
    start = end;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push({ start, end: text.length, text: tail });
  return out;
}

function paragraphRanges(text: string): { start: number; end: number; text: string }[] {
  const out: { start: number; end: number; text: string }[] = [];
  let start = 0;
  for (const match of text.matchAll(/\n\s*\n/g)) {
    const end = match.index ?? 0;
    const value = text.slice(start, end).trim();
    if (value.length > 0) out.push({ start, end, text: value });
    start = end + match[0].length;
  }
  const tail = text.slice(start).trim();
  if (tail.length > 0) out.push({ start, end: text.length, text: tail });
  return out;
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * p)))]!;
}

function confidenceFor(chars: number): VoiceConfidence {
  if (chars < 200) return 'insufficient';
  if (chars < 1500) return 'exploratory';
  return 'stable';
}

function evidenceForQuote(quote: string, loaded: LoadedSource[]): TextEvidence | null {
  if (quote.length === 0 || quote.length > 2000) return null;
  let found: { ref: { chapter_id: string; revision_id: string; content_hash: string }; text: string; at: number } | null = null;
  let occurrences = 0;
  for (const source of loaded) {
    if (!source.valid || !source.evidenceAllowed) continue;
    for (const segment of source.segments) {
      let from = 0;
      for (;;) {
        const at = segment.text.indexOf(quote, from);
        if (at < 0) break;
        occurrences += 1;
        if (!found) found = { ref: segment.ref, text: segment.text, at };
        from = at + Math.max(1, quote.length);
      }
    }
  }
  if (!found || occurrences !== 1) return null;
  if (found.text.slice(found.at, found.at + quote.length) !== quote) return null;
  return {
    quote,
    chapterId: found.ref.chapter_id,
    revisionId: found.ref.revision_id,
    contentHash: found.ref.content_hash,
    start: found.at,
    end: found.at + quote.length,
  };
}
function anchorFromEvidence(anchorId: string, evidence: TextEvidence): EvidenceAnchor {
  return {
    anchor_id: anchorId,
    chapter_id: evidence.chapterId,
    revision_id: evidence.revisionId,
    start_offset: evidence.start,
    end_offset: evidence.end,
    quote: evidence.quote,
    quote_hash: contentDigest(Buffer.from(evidence.quote, 'utf8')),
    chapter_content_hash: evidence.contentHash,
    status: 'current',
    note: null,
  };
}

function metric(
  metricId: string,
  label: string,
  value: number | string | Record<string, number>,
  unit: string,
  sampleSize: number,
  confidence: VoiceConfidence,
  method: string,
  caveat: string,
  anchorIds: string[] = [],
): VoiceMetric {
  return { metric_id: metricId, label, value, unit, sample_size: sampleSize, confidence, method, caveat, evidence_anchor_ids: anchorIds };
}

interface AnalyzeResult {
  metrics: VoiceMetric[];
  characters: VoiceCharacterProfile[];
  evidence: EvidenceAnchor[];
  dialogueSamples: number;
  unknownDialogueCount: number;
  charCount: number;
}

function analyzeText(text: string, loaded: LoadedSource[], knownNames: string[] = [], phraseDisplayAllowed = false): AnalyzeResult {
  const chars = cjkCount(text);
  const confidence = confidenceFor(chars);
  const sentences = sentenceRanges(text);
  const paragraphs = paragraphRanges(text);
  const sentenceLengths = sentences.map((entry) => cjkCount(entry.text)).filter((value) => value > 0);
  const paragraphLengths = paragraphs.map((entry) => cjkCount(entry.text)).filter((value) => value > 0);
  const dialogues = ranges(text, /[“「]([^”」]{1,1000})[”」]/g);
  const dialogueChars = dialogues.reduce((sum, entry) => sum + cjkCount(entry.text), 0);
  const punctuation = [...text].filter((char) => /[，。！？；：、—…,.!?;:]/.test(char)).length;
  const questions = sentences.filter((entry) => /[？?]\s*$/.test(entry.text)).length;
  const evidence: EvidenceAnchor[] = [];
  const addAnchor = (quote: string, prefix: string): string | null => {
    const found = evidenceForQuote(quote, loaded);
    if (!found) return null;
    const id = `anc_${prefix}_${contentDigest(Buffer.from(`${prefix}:${quote}`, 'utf8')).slice(7, 27)}`;
    evidence.push(anchorFromEvidence(id, found));
    return id;
  };
  const longest = [...sentences].sort((left, right) => cjkCount(right.text) - cjkCount(left.text))[0];
  const longestId = longest ? addAnchor(longest.text.slice(0, 500), 'voice_sentence') : null;
  const longestDialogue = [...dialogues].sort((left, right) => cjkCount(right.text) - cjkCount(left.text))[0];
  const dialogueId = longestDialogue ? addAnchor(longestDialogue.text.slice(0, 300), 'voice_dialogue') : null;
  const sentenceMean = sentenceLengths.length > 0 ? sentenceLengths.reduce((sum, value) => sum + value, 0) / sentenceLengths.length : 0;
  const paragraphMean = paragraphLengths.length > 0 ? paragraphLengths.reduce((sum, value) => sum + value, 0) / paragraphLengths.length : 0;
  const metrics: VoiceMetric[] = [
    metric('sentence_length', '汉字句长', {
      mean: Number(sentenceMean.toFixed(2)),
      median: percentile(sentenceLengths, 0.5),
      p90: percentile(sentenceLengths, 0.9),
    }, '汉字/句', sentenceLengths.length, confidence, '按中文句末标点切分，只统计汉字数；诗歌/无标点文本按末尾段处理', '短样本或特殊标点可能低估；不代表文学评价', longestId ? [longestId] : []),
    metric('paragraph_length', '段长', {
      mean: Number(paragraphMean.toFixed(2)),
      median: percentile(paragraphLengths, 0.5),
      p90: percentile(paragraphLengths, 0.9),
    }, '汉字/段', paragraphLengths.length, confidence, '按空行分段，统计每段汉字数', '单段/书信可能样本不足', []),
    metric('dialogue_ratio', '对白占比', {
      dialogue_chars: dialogueChars,
      total_chars: chars,
      ratio: chars > 0 ? Number((dialogueChars / chars).toFixed(4)) : 0,
    }, '比例', dialogues.length, confidence, '仅识别中文引号“”/「」内的字符；旁白式对白不计入', '引号缺失时会低估对白', dialogueId ? [dialogueId] : []),
    metric('dialogue_count', '对白条数', dialogues.length, '条', dialogues.length, confidence, '中文引号对计数', '未做说话人归属', []),
    metric('punctuation_density', '标点密度', chars > 0 ? Number(((punctuation / chars) * 1000).toFixed(2)) : 0, '每千汉字', chars, confidence, '统计中文/英文标点及省略号、破折号', '不同标点风格不可直接比较高低', []),
    metric('question_ratio', '疑问句占比', sentences.length > 0 ? Number((questions / sentences.length).toFixed(3)) : 0, '比例', sentences.length, confidence, '句末问号计数', '反问/间接问句可能漏计', []),
  ];

  // Repeated 3-character phrases are observable, not a literary judgment.
  const counts = new Map<string, { count: number; first: number }>();
  for (const match of text.matchAll(/[\u3400-\u9fff]{3,}/g)) {
    const run = [...match[0]];
    for (let index = 0; index + 3 <= run.length; index += 1) {
      const phrase = run.slice(index, index + 3).join('');
      const existing = counts.get(phrase);
      if (existing) existing.count += 1;
      else counts.set(phrase, { count: 1, first: (match.index ?? 0) + index });
    }
  }
  const top = [...counts.entries()].filter(([, value]) => value.count > 1).sort((left, right) => right[1].count - left[1].count).slice(0, 5);
  const phraseText = phraseDisplayAllowed
    ? (top.length > 0 ? top.map(([phrase, value]) => `${phrase}×${value.count}`).join('、') : '样本中无明显重复三字短语')
    : '部分素材未授权展示具体短语';
  metrics.push(metric('repeated_phrases', '重复三字短语', phraseText, '文本', top.length, confidence, '仅统计汉字三字窗口，不剔除全部虚词，不做语义判断', '高频不表示作者偏好，也不代表模仿价值', []));

  const escapedNames = knownNames
    .filter((name) => name.length >= 2 && name.length <= 8)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const speaker = escapedNames.length > 0
    ? `(${escapedNames.join('|')})`
    : '([\\u4e00-\\u9fff]{2,4})';
  const dialoguePattern = new RegExp(`${speaker}(?:[^。！？\\n“”「」]{0,10})?(?:说|问|答|道|喊|低声说|笑道|问道)[：:]\\s*[“「]([^”」]{1,500})[”」]`, 'g');
  const byCharacter = new Map<string, string[]>();
  let attributed = 0;
  for (const match of text.matchAll(dialoguePattern)) {
    const name = match[1]!;
    const dialogue = match[2]!;
    attributed += 1;
    const list = byCharacter.get(name) ?? [];
    list.push(dialogue);
    byCharacter.set(name, list);
  }
  const characters: VoiceCharacterProfile[] = [...byCharacter.entries()]
    .filter(([, samples]) => samples.length >= 2)
    .map(([name, samples]) => {
      const sampleText = samples.join('\n');
      const sampleChars = cjkCount(sampleText);
      const sampleLengths = samples.map((sample) => cjkCount(sample));
      return {
        character_id: `character:${name}`,
        character_name: name,
        dialogue_samples: samples.length,
        metrics: [
          metric('character_dialogue_length', '角色对白长度', {
            mean: Number((sampleLengths.reduce((sum, value) => sum + value, 0) / sampleLengths.length).toFixed(2)),
            median: percentile(sampleLengths, 0.5),
          }, '汉字/条', samples.length, confidenceFor(sampleChars), '只统计显式“X说/问：…”且至少 2 条对白', '短句、转述和无标签对白不纳入；不是完整人物声纹', []),
          metric('character_dialogue_share', '角色对白占比', Number((samples.length / Math.max(1, attributed)).toFixed(3)), '比例', attributed, confidenceFor(sampleChars), '按显式归因对白条数计算', '未知说话人的对白不会强行分配', []),
        ],
        unknown_attribution_count: Math.max(0, dialogues.length - attributed),
      };
    });
  return {
    metrics,
    characters,
    evidence,
    dialogueSamples: dialogues.length,
    unknownDialogueCount: Math.max(0, dialogues.length - attributed),
    charCount: chars,
  };
}

function dialogueTextFor(text: string, name: string): string {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`${escaped}(?:[^。！？\\n“”「」]{0,10})?(?:说|问|答|道|喊|低声说|笑道|问道)[：:]\\s*[“「]([^”」]{1,500})[”」]`, 'g');
  return [...text.matchAll(pattern)].map((match) => match[1]!).join('\n');
}
function sourceVersionMap(sources: VoiceCorpusSource[]): Record<string, string> {
  return Object.fromEntries(sources.map((source) => [source.source_id, source.updated_at]));
}

function profileFor(
  projectId: string,
  scope: VoiceScope,
  scopeRef: string | null,
  sources: VoiceCorpusSource[],
  loaded: LoadedSource[],
  result: AnalyzeResult,
  staleReason: string | null,
): VoiceProfile {
  const valid = loaded.filter((source) => source.valid);
  return {
    schema_version: SCHEMA_VERSION,
    profile_id: newVoiceId('vprof'),
    project_id: projectId,
    scope,
    scope_ref: scopeRef,
    algorithm_version: VOICE_ALGORITHM_VERSION,
    source_ids: sources.map((source) => source.source_id),
    source_versions: sourceVersionMap(sources),
    status: staleReason ? 'stale' : 'current',
    generated_at: new Date().toISOString(),
    source_char_count: result.charCount,
    chapter_count: valid.reduce((sum, source) => sum + source.chapters.length, 0),
    dialogue_samples: result.dialogueSamples,
    unknown_dialogue_count: result.unknownDialogueCount,
    metrics: result.metrics,
    characters: result.characters,
    evidence: result.evidence,
    stale_reason: staleReason,
  };
}

function proposalsFor(profile: VoiceProfile): VoiceProposal[] {
  const proposals: VoiceProposal[] = [];
  const ratio = profile.metrics.find((entry) => entry.metric_id === 'dialogue_ratio')?.value;
  const sentence = profile.metrics.find((entry) => entry.metric_id === 'sentence_length')?.value;
  const evidence = profile.metrics.flatMap((entry) => entry.evidence_anchor_ids).slice(0, 2);
  const make = (intent: VoiceProposal['intent'], text: string, conditions: string, metricIds: string[]) => {
    proposals.push({
      proposal_id: `prop_${contentDigest(Buffer.from(`${profile.profile_id}:${intent}:${text}`, 'utf8')).slice(7, 27)}`,
      project_id: profile.project_id,
      scope: profile.scope,
      scope_ref: profile.scope_ref,
      intent,
      text,
      conditions,
      source_ids: profile.source_ids,
      evidence_anchor_ids: evidence,
      metric_ids: metricIds,
      status: 'proposal',
      created_at: new Date().toISOString(),
    });
  };
  if (typeof ratio === 'object' && ratio !== null && 'ratio' in ratio) {
    const value = Number(ratio.ratio);
    if (value >= 0.28) make('retain', '保留较高的对白密度，让冲突主要发生在人物说话之间。', '仅适用于本作品的对白密集场景；不强制每个场景。', ['dialogue_ratio']);
    else if (value <= 0.06) make('retain', '保留克制、低对白的叙述留白，不为了热闹增加解释性对白。', '本作品的叙述型章节；纯对白章节除外。', ['dialogue_ratio']);
  }
  if (typeof sentence === 'object' && sentence !== null && 'mean' in sentence) {
    const mean = Number(sentence.mean);
    if (mean >= 28) make('retain', '保留较长、层叠的句子节奏，但避免一律拉长。', '历史/抒情叙述；动作高潮可例外。', ['sentence_length']);
    else if (mean <= 14) make('retain', '保留短句推进和较快的叙述步频。', '本作品的动作/悬疑段落；说明性段落可例外。', ['sentence_length']);
  }
  for (const character of profile.characters) {
    const lengthMetric = character.metrics.find((entry) => entry.metric_id === 'character_dialogue_length')?.value;
    if (typeof lengthMetric === 'object' && lengthMetric !== null && 'mean' in lengthMetric && Number(lengthMetric.mean) <= 12) {
      make('retain', `保留${character.character_name}的短促对白习惯，不要替其补写完整解释。`, `仅适用于${character.character_name}的对白；不同作品中的同名角色不共用。`, ['character_dialogue_length']);
    }
  }
  return proposals;
}

export function analyzeVoice(options: {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  now?: () => Date;
}): VoiceOverview {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const registry = readVoiceCorpus(opened.projectDir);
  const database = voiceDatabasePath(resolveAppDataRoot(options.appDataRoot ?? null), opened.project.project_id);
  const db = openDb(database);
  const generatedAt = (options.now ?? (() => new Date()))().toISOString();
  try {
    if (!registry) {
      db.exec('DELETE FROM voice_profiles; DELETE FROM voice_proposals;');
      metaSet(db, 'status', 'missing');
      return readVoiceOverview({ ...options, appDataRoot: options.appDataRoot });
    }
    const loaded = registry.sources.map((source) => loadSource(opened, source));
    const projectSources = registry.sources.filter((source) => source.scope === 'project');
    const projectLoaded = loaded.filter((entry) => entry.source.scope === 'project');
    const projectProfile = projectSources.length > 0
      ? (() => {
          const text = projectLoaded.filter((entry) => entry.valid).map((entry) => entry.text).join('\n\n');
          const knownNames = registry.sources.filter((source) => source.scope === 'character' && source.scope_ref).map((source) => source.scope_ref!);
          const phraseDisplayAllowed = projectSources.length > 0
            && projectSources.every((source) => source.status === 'active')
            && projectLoaded.every((entry) => entry.valid && entry.evidenceAllowed);
          const result = analyzeText(text, projectLoaded, knownNames, phraseDisplayAllowed);
          const revoked = projectSources.find((source) => source.status !== 'active');
          const broken = projectLoaded.find((entry) => !entry.valid);
          const staleReason = revoked
            ? `来源 ${revoked.name} 已撤销`
            : broken ? `来源 ${broken.source.name} 已失效` : null;
          return profileFor(
            opened.project.project_id, 'project', null, projectSources, projectLoaded, result, staleReason,
          );
        })()
      : null;
    const authorSources = registry.sources.filter((source) => source.scope === 'author');
    const authorLoaded = loaded.filter((entry) => entry.source.scope === 'author');
    const authorProfile = authorSources.length > 0
      ? (() => {
          const text = authorLoaded.filter((entry) => entry.valid).map((entry) => entry.text).join('\n\n');
          const phraseDisplayAllowed = authorSources.length > 0
            && authorSources.every((source) => source.status === 'active')
            && authorLoaded.every((entry) => entry.valid && entry.evidenceAllowed);
          const result = analyzeText(text, authorLoaded, [], phraseDisplayAllowed);
          const stale = authorSources.find((source) => source.status !== 'active') ?? authorLoaded.find((entry) => !entry.valid);
          return profileFor(opened.project.project_id, 'author', null, authorSources, authorLoaded, result, stale ? '作者基础来源失效' : null);
        })()
      : null;
    const characterProfiles: VoiceProfile[] = [];
    for (const source of registry.sources.filter((item) => item.scope === 'character')) {
      const sourceLoaded = loaded.find((entry) => entry.source.source_id === source.source_id);
      if (!sourceLoaded) continue;
      const characterText = source.scope_ref ? dialogueTextFor(sourceLoaded.text, source.scope_ref) : '';
      const characterPhraseDisplayAllowed = sourceLoaded.valid && sourceLoaded.evidenceAllowed;
      const result = analyzeText(characterText, sourceLoaded.valid ? [sourceLoaded] : [], source.scope_ref ? [source.scope_ref] : [], characterPhraseDisplayAllowed);
      const filtered = result.characters.filter((character) => character.character_name === source.scope_ref);
      if (filtered.length === 0 && source.scope_ref) {
        const samples = characterText.split('\n').map((line) => line.trim()).filter(Boolean);
        const lengths = samples.map((sample) => cjkCount(sample));
        if (samples.length > 0) {
          filtered.push({
            character_id: `character:${source.scope_ref}`,
            character_name: source.scope_ref,
            dialogue_samples: samples.length,
            metrics: [metric(
              'character_dialogue_length', '角色对白长度',
              {
                mean: Number((lengths.reduce((sum, value) => sum + value, 0) / lengths.length).toFixed(2)),
                median: percentile(lengths, 0.5),
              },
              '汉字/条', samples.length, confidenceFor(lengths.reduce((sum, value) => sum + value, 0)),
              '只统计显式归因对白；样本来自该角色来源',
              '短样本不构成完整人物声纹', [],
            )],
            unknown_attribution_count: 0,
          });
        }
      }
      characterProfiles.push(profileFor(
        opened.project.project_id, 'character', source.scope_ref, [source],
        [sourceLoaded], { ...result, characters: filtered, dialogueSamples: filtered.reduce((sum, item) => sum + item.dialogue_samples, 0) },
        sourceLoaded.valid ? null : sourceLoaded.staleReason,
      ));
    }
    const profiles = [projectProfile, authorProfile, ...characterProfiles].filter((item): item is VoiceProfile => Boolean(item));
    const proposals = projectProfile?.status === 'current' ? proposalsFor(projectProfile) : [];
    db.exec('BEGIN IMMEDIATE');
    db.exec('DELETE FROM voice_profiles; DELETE FROM voice_proposals;');
    const insertProfile = db.prepare('INSERT INTO voice_profiles(profile_id,project_id,scope,scope_ref,status,generated_at,json) VALUES (?,?,?,?,?,?,?)');
    for (const profile of profiles) insertProfile.run(profile.profile_id, profile.project_id, profile.scope, profile.scope_ref, profile.status, profile.generated_at, JSON.stringify(profile));
    const insertProposal = db.prepare('INSERT INTO voice_proposals(proposal_id,project_id,status,created_at,json) VALUES (?,?,?,?,?)');
    for (const proposal of proposals) insertProposal.run(proposal.proposal_id, proposal.project_id, proposal.status, proposal.created_at, JSON.stringify(proposal));
    metaSet(db, 'status', profiles.some((profile) => profile.status === 'stale') ? 'stale' : 'current');
    metaSet(db, 'generated_at', generatedAt);
    metaSet(db, 'source_versions', JSON.stringify(sourceVersionMap(registry.sources)));
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  return readVoiceOverview({ ...options, appDataRoot: options.appDataRoot });
}

function readProfiles(db: DatabaseSync): VoiceProfile[] {
  return (db.prepare('SELECT json FROM voice_profiles ORDER BY scope, scope_ref').all() as Array<{ json: string }>).map((row) => JSON.parse(row.json) as VoiceProfile);
}

function readProposals(db: DatabaseSync): VoiceProposal[] {
  return (db.prepare("SELECT json FROM voice_proposals WHERE status='proposal' ORDER BY created_at").all() as Array<{ json: string }>).map((row) => JSON.parse(row.json) as VoiceProposal);
}

function ruleViewsFor(constitution: ReturnType<typeof readStyleConstitution>, sourceViews: VoiceSourceView[]): VoiceRuleView[] {
  const activeIds = new Set(sourceViews.filter((source) => source.effective_status === 'active').map((source) => source.source_id));
  return (constitution?.rules ?? []).map((rule) => {
    const missing = rule.source_ids.filter((id) => !activeIds.has(id));
    const effective = rule.status === 'approved' && missing.length > 0 ? 'stale' : rule.status === 'approved' ? 'approved' : 'revoked';
    return {
      ...rule,
      effective_status: effective,
      stale_reason: missing.length > 0 ? `依赖来源已撤销/失效：${missing.join('、')}` : null,
    };
  });
}

function sanitizeProfileEvidence(profile: VoiceProfile, opened: ReturnType<typeof openProject>, sourceViews: VoiceSourceView[]): VoiceProfile {
  const allowedChapters = new Set<string>();
  for (const source of sourceViews) {
    if (source.effective_status !== 'active' || !source.permissions.quote_display || !source.permissions.sample_storage) continue;
    for (const ref of source.chapters) allowedChapters.add(ref.chapter_id);
  }
  const validAnchors = profile.evidence.filter((anchor) => {
    if (!allowedChapters.has(anchor.chapter_id)) return false;
    const entry = opened.manifest.chapters[anchor.chapter_id];
    if (!entry || entry.current_revision_id !== anchor.revision_id || entry.content_hash !== anchor.chapter_content_hash) return false;
    const bytes = readChapterBytes(opened.projectDir, anchor.chapter_id);
    const text = bytes.toString('utf8');
    if (text.slice(anchor.start_offset, anchor.end_offset) !== anchor.quote) return false;
    if (contentDigest(Buffer.from(anchor.quote, 'utf8')) !== anchor.quote_hash) return false;
    return true;
  });
  const phraseMask = '部分素材未授权展示具体短语';
  const phraseAllowed = profile.source_ids.length > 0 && profile.source_ids.every((id) => {
    const source = sourceViews.find((item) => item.source_id === id);
    return Boolean(source && source.effective_status === 'active' && source.permissions.quote_display && source.permissions.sample_storage);
  });
  let phraseChanged = false;
  const anchorsChanged = validAnchors.length !== profile.evidence.length;
  const validIds = new Set(validAnchors.map((anchor) => anchor.anchor_id));
  const metrics = profile.metrics.map((metric) => {
    const next = {
      ...metric,
      evidence_anchor_ids: metric.evidence_anchor_ids.filter((id) => validIds.has(id)),
    };
    if (!phraseAllowed && metric.metric_id === 'repeated_phrases' && metric.value !== phraseMask) {
      return { ...next, value: phraseMask };
    }
    return next;
  });
  if (!phraseAllowed) phraseChanged = profile.metrics.some((metric) => metric.metric_id === 'repeated_phrases' && metric.value !== phraseMask);
  if (!anchorsChanged && !phraseChanged) return profile;
  return {
    ...profile,
    evidence: validAnchors,
    status: 'stale',
    stale_reason: phraseChanged ? '来源引用展示许可混合或已变化，已遮蔽字面短语' : '证据引用失效或来源引用展示许可已变化，需重新分析',
    metrics,
  };
}
export function readVoiceOverview(options: { vaultDir: string; projectId?: string | null; appDataRoot?: string | null }): VoiceOverview {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const registry = readVoiceCorpus(opened.projectDir);
  const constitution = readStyleConstitution(opened.projectDir);
  const database = voiceDatabasePath(resolveAppDataRoot(options.appDataRoot ?? null), opened.project.project_id);
  const sourceViews: VoiceSourceView[] = (registry?.sources ?? []).map((source) => {
    const loaded = loadSource(opened, source);
    return {
      ...source,
      effective_status: source.status === 'active' ? (loaded.valid ? 'active' : 'stale') : source.status,
      stale_reason: source.status === 'active' ? loaded.staleReason : source.revoke_reason,
      chapter_count: loaded.chapters.length,
    };
  });
  if (!fs.existsSync(database)) {
    return {
      status: registry ? 'missing' : 'missing',
      project_id: opened.project.project_id,
      registry_version: registry?.version ?? 0,
      constitution_version: constitution?.version ?? 0,
      sources: sourceViews,
      profiles: [],
      proposals: [],
      rules: ruleViewsFor(constitution, sourceViews),
      generated_at: null,
      stale_reason: '尚未分析',
    };
  }
  const db = openDb(database);
  try {
    const snapshot = metaGet(db, 'source_versions');
    const currentVersions = JSON.stringify(sourceVersionMap(registry?.sources ?? []));
    const versionsDiffer = snapshot !== null && snapshot !== currentVersions;
    const sourceInvalid = sourceViews.some((source) => source.effective_status !== 'active');
    const storedProfiles = readProfiles(db);
    const rawProfiles = storedProfiles.map((profile) => sanitizeProfileEvidence(profile, opened, sourceViews));
    const persist = db.prepare('UPDATE voice_profiles SET status=?, json=? WHERE profile_id=?');
    for (let index = 0; index < storedProfiles.length; index += 1) {
      const stored = storedProfiles[index]!;
      const sanitized = rawProfiles[index]!;
      if (JSON.stringify(stored) !== JSON.stringify(sanitized)) {
        persist.run(sanitized.status, JSON.stringify(sanitized), sanitized.profile_id);
      }
    }
    const profiles = versionsDiffer
      ? rawProfiles.map((profile) => ({ ...profile, status: 'stale' as const, stale_reason: '来源登记已变化，需重新分析' }))
      : rawProfiles;
    const approvedTexts = new Set((constitution?.rules ?? []).filter((rule) => rule.status === 'approved').map((rule) => rule.text));
    const proposals = readProposals(db).filter((proposal) => !approvedTexts.has(proposal.text));
    const rules = ruleViewsFor(constitution, sourceViews);
    const profileStale = profiles.find((profile) => profile.status === 'stale');
    const status = metaGet(db, 'status') === 'missing' ? 'missing' : profileStale || sourceInvalid || versionsDiffer ? 'stale' : 'current';
    return {
      status,
      project_id: opened.project.project_id,
      registry_version: registry?.version ?? 0,
      constitution_version: constitution?.version ?? 0,
      sources: sourceViews,
      profiles,
      proposals: status === 'current' ? proposals : [],
      rules,
      generated_at: metaGet(db, 'generated_at'),
      stale_reason: profileStale?.stale_reason ?? (sourceViews.some((source) => source.effective_status !== 'active') ? '存在失效/撤销来源' : null),
    };
  } finally {
    db.close();
  }
}

function defaultRule(id: string, input: {
  scope: VoiceScope;
  scopeRef: string | null;
  intent: StyleRule['intent'];
  text: string;
  conditions: string;
  sourceIds: string[];
  evidenceAnchorIds: string[];
  now: string;
}): StyleRule {
  return {
    rule_id: id,
    scope: input.scope,
    scope_ref: input.scopeRef,
    intent: input.intent,
    text: input.text,
    conditions: input.conditions,
    source_ids: input.sourceIds,
    evidence_anchor_ids: input.evidenceAnchorIds,
    status: 'approved',
    version: 1,
    created_at: input.now,
    updated_at: input.now,
    approved_at: input.now,
    approved_by: 'local-author',
    supersedes: null,
    previous: null,
    note: null,
  };
}

export function approveVoiceProposal(options: {
  vaultDir: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  proposalId: string;
  note?: string;
  actorId?: string;
}): { rule: StyleRule; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const database = voiceDatabasePath(resolveAppDataRoot(options.appDataRoot ?? null), opened.project.project_id);
  const db = openDb(database);
  let proposal: VoiceProposal | null = null;
  try {
    const row = db.prepare("SELECT json FROM voice_proposals WHERE proposal_id=? AND status='proposal'").get(options.proposalId) as { json?: string } | undefined;
    proposal = row?.json ? JSON.parse(row.json) as VoiceProposal : null;
  } finally {
    db.close();
  }
  if (!proposal) throw new Error('STALE_PROPOSAL: voice proposal was not found or was already decided; reanalyse current sources');
  const registry = readVoiceCorpus(opened.projectDir);
  if (!registry) throw new Error('STALE_PROPOSAL: authoritative voice corpus is missing');
  const sourceMap = new Map(registry.sources.map((source) => [source.source_id, source]));
  const currentVersions = JSON.stringify(sourceVersionMap(registry.sources));
  const validationDb = openDb(database);
  let validationProfile: VoiceProfile | null = null;
  let snapshot: string | null = null;
  try {
    snapshot = metaGet(validationDb, 'source_versions');
    const row = validationDb.prepare("SELECT json FROM voice_profiles WHERE project_id=? AND scope='project' LIMIT 1").get(opened.project.project_id) as { json?: string } | undefined;
    validationProfile = row?.json ? JSON.parse(row.json) as VoiceProfile : null;
  } finally {
    validationDb.close();
  }
  if (!validationProfile || validationProfile.status !== 'current') {
    throw new Error('STALE_PROPOSAL: current voice profile is missing, stale or not analysed');
  }
  if (snapshot !== currentVersions) {
    throw new Error('STALE_PROPOSAL: source registry changed after this proposal was generated');
  }
  for (const sourceId of proposal.source_ids) {
    const source = sourceMap.get(sourceId);
    if (!source) throw new Error(`STALE_PROPOSAL: source ${sourceId} no longer exists`);
    if (source.status !== 'active') throw new Error(`STALE_PROPOSAL: source ${sourceId} is ${source.status}`);
    if (!source.permissions.local_analysis) throw new Error(`STALE_PROPOSAL: source ${sourceId} no longer permits local analysis`);
    const loaded = loadSource(opened, source);
    if (!loaded.valid) throw new Error(`STALE_PROPOSAL: source ${sourceId} revision/hash is stale (${loaded.staleReason ?? 'invalid'})`);
    if (proposal.evidence_anchor_ids.length > 0 && (!source.permissions.quote_display || !source.permissions.sample_storage)) {
      throw new Error(`STALE_PROPOSAL: source ${sourceId} no longer permits quote display/sample storage`);
    }
  }
  const validAnchorIds = new Set(validationProfile.evidence.map((anchor) => anchor.anchor_id));
  for (const anchorId of proposal.evidence_anchor_ids) {
    if (!validAnchorIds.has(anchorId)) throw new Error(`STALE_PROPOSAL: evidence ${anchorId} is no longer valid`);
  }
  const constitution = readStyleConstitution(opened.projectDir) ?? {
    schema_version: SCHEMA_VERSION as 1,
    project_id: opened.project.project_id,
    version: 0,
    updated_at: new Date().toISOString(),
    rules: [] as StyleRule[],
  };
  const duplicate = constitution.rules.find((item) =>
    item.status === 'approved' && item.text === proposal.text && item.scope === proposal.scope && item.scope_ref === proposal.scope_ref);
  if (duplicate) {
    const duplicateDb = openDb(database);
    duplicateDb.prepare("UPDATE voice_proposals SET status='approved' WHERE proposal_id=?").run(options.proposalId);
    duplicateDb.close();
    analyzeVoice({ vaultDir: options.vaultDir, projectId: opened.project.project_id, appDataRoot: options.appDataRoot });
    return { rule: duplicate, manifestRevision: readManifest(opened.projectDir).revision };
  }  const now = new Date().toISOString();
  const rule = defaultRule(newVoiceId('srule'), {
    scope: proposal.scope,
    scopeRef: proposal.scope_ref,
    intent: proposal.intent,
    text: proposal.text,
    conditions: proposal.conditions,
    sourceIds: proposal.source_ids,
    evidenceAnchorIds: proposal.evidence_anchor_ids,
    now,
  });
  rule.note = options.note ?? null;
  const written = writeStyleConstitution({
    vaultDir: options.vaultDir,
    projectId: opened.project.project_id,
    value: { ...constitution, version: constitution.version + 1, updated_at: now, rules: [...constitution.rules, rule] },
    actor: { kind: 'author', id: options.actorId ?? 'local-author' },
  });
  const cleanDb = openDb(database);
  cleanDb.prepare("UPDATE voice_proposals SET status='approved' WHERE proposal_id=?").run(options.proposalId);
  cleanDb.close();
  analyzeVoice({ vaultDir: options.vaultDir, projectId: opened.project.project_id, appDataRoot: options.appDataRoot });
  return { rule, manifestRevision: written.manifestRevision };
}

export function revokeStyleRule(options: {
  vaultDir: string;
  projectId?: string | null;
  ruleId: string;
  reason: string;
  actorId?: string;
}): { rule: StyleRule; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const constitution = readStyleConstitution(opened.projectDir);
  if (!constitution) throw new Error('Style Constitution not found');
  const prior = constitution.rules.find((rule) => rule.rule_id === options.ruleId);
  if (!prior) throw new Error('Style rule not found');
  const now = new Date().toISOString();
  const rule: StyleRule = {
    ...prior,
    status: 'revoked',
    version: prior.version + 1,
    updated_at: now,
    previous: { version: prior.version, text: prior.text, intent: prior.intent, status: prior.status },
    note: options.reason,
  };
  const written = writeStyleConstitution({
    vaultDir: options.vaultDir, projectId: opened.project.project_id,
    value: { ...constitution, version: constitution.version + 1, updated_at: now, rules: constitution.rules.map((item) => item.rule_id === rule.rule_id ? rule : item) },
    actor: { kind: 'author', id: options.actorId ?? 'local-author' },
  });
  return { rule, manifestRevision: written.manifestRevision };
}

export function rollbackStyleRule(options: {
  vaultDir: string;
  projectId?: string | null;
  ruleId: string;
  actorId?: string;
}): { rule: StyleRule; manifestRevision: string } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const constitution = readStyleConstitution(opened.projectDir);
  if (!constitution) throw new Error('Style Constitution not found');
  const prior = constitution.rules.find((rule) => rule.rule_id === options.ruleId);
  if (!prior?.previous) throw new Error('No previous approved version to roll back to');
  const now = new Date().toISOString();
  const rule: StyleRule = {
    ...prior,
    status: 'approved',
    text: prior.previous.text,
    intent: prior.previous.intent,
    version: prior.version + 1,
    updated_at: now,
    approved_at: now,
    approved_by: options.actorId ?? 'local-author',
    previous: { version: prior.version, text: prior.text, intent: prior.intent, status: prior.status },
    note: '回退到上一批准版本（生成新版本，不覆盖历史）',
  };
  const written = writeStyleConstitution({
    vaultDir: options.vaultDir, projectId: opened.project.project_id,
    value: { ...constitution, version: constitution.version + 1, updated_at: now, rules: constitution.rules.map((item) => item.rule_id === rule.rule_id ? rule : item) },
    actor: { kind: 'author', id: options.actorId ?? 'local-author' },
  });
  return { rule, manifestRevision: written.manifestRevision };
}

export function compareVoiceSamples(a: string, b: string): {
  a: Record<string, number>;
  b: Record<string, number>;
} {
  const summary = (text: string): Record<string, number> => {
    const chars = cjkCount(text);
    const sentences = sentenceRanges(text);
    const dialogues = ranges(text, /[“「]([^”」]{1,1000})[”」]/g);
    const dialogueChars = dialogues.reduce((sum, entry) => sum + cjkCount(entry.text), 0);
    const lengths = sentences.map((entry) => cjkCount(entry.text)).filter((value) => value > 0);
    return {
      cjk_chars: chars,
      sentences: sentences.length,
      mean_sentence_length: lengths.length > 0 ? Number((lengths.reduce((sum, value) => sum + value, 0) / lengths.length).toFixed(2)) : 0,
      dialogue_ratio: chars > 0 ? Number((dialogueChars / chars).toFixed(4)) : 0,
      question_ratio: sentences.length > 0 ? Number((sentences.filter((entry) => /[？?]\s*$/.test(entry.text)).length / sentences.length).toFixed(3)) : 0,
    };
  };
  return { a: summary(a), b: summary(b) };
}

export function voiceDatabaseExists(appDataRoot: string, projectId: string): boolean {
  return fs.existsSync(voiceDatabasePath(appDataRoot, projectId));
}
