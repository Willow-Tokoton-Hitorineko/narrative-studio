import fs from 'node:fs';
import path from 'node:path';
import { contentDigest } from '@narrative-studio/contracts';
import { openProject, readChapterBytes, resolveAppDataRoot } from '@narrative-studio/core';
import { compileEditorialJob, futureSecretValuesFor, type CompileResult } from '@narrative-studio/editorial';
import { authoritativeForbidden, compilePlanContext, readPlanning } from '@narrative-studio/planning';

export type CandidateSource = 'offline-fixture' | 'manual-import' | 'deepseek' | 'deepseek-mock';
export type ReviewSeverity = 'blocking' | 'warning' | 'insufficient';
export interface CandidateReview { dimension: 'facts' | 'pov' | 'voice' | 'rhythm'; severity: ReviewSeverity; reason: string; automatic: boolean; }
export interface CandidateSnapshot {
  manifest_id: string; chapter_revision: string; chapter_hash: string;
  plan_ids: string[]; branch_ids: string[]; genre_ids: string[]; policy_ids: string[]; pov_entity_id: string | null; planning_version: number; forbidden_rule_ids: string[]; snapshot_hash: string;
}
export interface ContinuationCandidate {
  candidate_id: string; project_id: string; chapter_id: string; base_revision: string; base_hash: string;
  task: string; start: number; end: number; pov_entity_id: string | null; plan_id: string | null; branch_id: string | null;
  source: CandidateSource; source_label: string; text: string; snapshot: CandidateSnapshot;
  status: 'pending' | 'selected' | 'rejected' | 'stale'; reviews: CandidateReview[]; blocking: boolean; created_at: string;
}

function storePath(appDataRoot: string, projectId: string): string { return path.join(resolveAppDataRoot(appDataRoot), 'continuation', `${projectId}.json`); }
function load(appDataRoot: string, projectId: string): ContinuationCandidate[] { const p = storePath(appDataRoot, projectId); return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) as ContinuationCandidate[] : []; }
function saveAll(appDataRoot: string, projectId: string, items: ContinuationCandidate[]): void { const p = storePath(appDataRoot, projectId); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, JSON.stringify(items, null, 2), 'utf8'); }

export function compileContinuation(options: {
  vaultDir: string; projectId?: string | null; chapterId: string; start: number; end: number; task: string;
  povEntityId?: string | null; budgetTokens?: number;
}): { compiled: CompileResult; plans: ReturnType<typeof compilePlanContext> } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const entry = opened.manifest.chapters[options.chapterId];
  if (!entry) throw new Error('CHAPTER_NOT_FOUND');
  const plans = compilePlanContext({ vaultDir: options.vaultDir, projectId: opened.project.project_id, chapter: entry.ordinal, chapterId: options.chapterId, povEntityId: options.povEntityId ?? null });
  const compiled = compileEditorialJob({
    allowEmpty: true,
    vaultDir: options.vaultDir, projectId: opened.project.project_id, chapterId: options.chapterId,
    start: options.start, end: options.end, task: options.task, level: 'L2',
    povEntityId: options.povEntityId ?? null, budgetTokens: options.budgetTokens ?? 1800,
  });
  return { compiled, plans };
}

function snapshotOf(compiled: CompileResult, planningVersion: number, branchIds: string[], forbiddenRuleIds: string[]): CandidateSnapshot {
  const entry = compiled.job;
  return {
    manifest_id: compiled.manifest.manifest_id ?? '', chapter_revision: entry.base_revision, chapter_hash: entry.base_hash,
    plan_ids: [...(compiled.manifest.plan_ids ?? [])], genre_ids: [...(compiled.manifest.genre_ids ?? [])],
    policy_ids: [...(compiled.manifest.coevolution_policy_ids ?? [])], pov_entity_id: entry.pov_entity_id ?? null,
    branch_ids: branchIds, planning_version: planningVersion, forbidden_rule_ids: forbiddenRuleIds,
    snapshot_hash: contentDigest(Buffer.from(JSON.stringify({ manifest: compiled.manifest.manifest_id, chapter: entry.base_revision, hash: entry.base_hash, plans: compiled.manifest.plan_ids ?? [], branches: branchIds, genres: compiled.manifest.genre_ids ?? [], policies: compiled.manifest.coevolution_policy_ids ?? [], planningVersion, forbiddenRuleIds }), 'utf8')),
  };
}

function reviewCandidate(options: { vaultDir: string; projectId?: string | null; chapterId: string; povEntityId: string | null; text: string; genreIds: string[]; forbidden: string[] }): { reviews: CandidateReview[]; blocking: boolean } {
  const futureSecrets = futureSecretValuesFor({ vaultDir: options.vaultDir, projectId: options.projectId, chapterId: options.chapterId, povEntityId: options.povEntityId });
  const reviews: CandidateReview[] = [];
  const futureHit = futureSecrets.find((secret) => secret.length >= 2 && options.text.includes(secret));
  reviews.push({ dimension: 'pov', severity: futureHit ? 'blocking' : 'insufficient', reason: futureHit ? `候选包含当前 POV 尚未得知的未来秘密：${futureHit.slice(0, 20)}` : '未检测到当前 canon 中的未来秘密字面值；不等于完整知情审查。', automatic: true });
  const forbiddenHit = options.forbidden.find((item) => item.length > 0 && options.text.includes(item));
  reviews.push({ dimension: 'facts', severity: forbiddenHit ? 'blocking' : 'insufficient', reason: forbiddenHit ? `候选包含作者禁改/事实冲突项：${forbiddenHit}` : '未检测到明示禁改项；事实与人物动机需作者复核。', automatic: true });
  const guFeng = options.genreIds.some((id) => id.includes('gufeng'));
  const modern = ['手机', '咖啡', '电梯', '警察'].find((word) => options.text.includes(word));
  reviews.push({ dimension: 'voice', severity: guFeng && modern ? 'warning' : 'insufficient', reason: guFeng && modern ? `古风题材候选出现现代词“${modern}”；可能是声线冲突。` : '未做模型级声线判断；人物用词需作者确认。', automatic: false });
  const length = options.text.length;
  const rhythm = length < 40 ? 'warning' : length > 1200 ? 'warning' : 'insufficient';
  reviews.push({ dimension: 'rhythm', severity: rhythm, reason: rhythm === 'warning' ? `候选长度 ${length} 字符，可能不足以形成场景节拍或过长失焦。` : '仅做长度启发式；节奏与冲突推进需作者判断。', automatic: false });
  return { reviews, blocking: reviews.some((review) => review.severity === 'blocking') };
}

export function createCandidate(options: {
  vaultDir: string; projectId?: string | null; appDataRoot: string; chapterId: string; text: string;
  task: string; source: CandidateSource; start?: number; end?: number; povEntityId?: string | null;
  planId?: string | null; branchId?: string | null; forbidden?: string[]; genreIds?: string[];
}): ContinuationCandidate {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const entry = opened.manifest.chapters[options.chapterId];
  if (!entry) throw new Error('CHAPTER_NOT_FOUND');
  if (!options.text.trim() || options.text.length > 20000) throw new Error('INVALID_CANDIDATE_TEXT');
  if (/<script|javascript:|on\w+\s*=/i.test(options.text)) throw new Error('UNSAFE_CANDIDATE_MARKUP');
  const start = options.start ?? 0;
  const end = options.end ?? Math.min(entry.content_hash ? 200 : 200, 200);
  const { compiled, plans } = compileContinuation({ vaultDir: options.vaultDir, projectId: opened.project.project_id, chapterId: options.chapterId, start, end, task: options.task, povEntityId: options.povEntityId ?? null });
  const branchId = options.branchId ?? null;
  const planId = options.planId ?? (branchId ? plans.branches.find((branch) => branch.branch_id === branchId)?.plan_id ?? null : null);
  if (options.source !== 'deepseek' && options.source !== 'deepseek-mock') {
    if (!planId) throw new Error('PLAN_REQUIRED_FOR_CANDIDATE');
    if (!plans.plans.some((plan) => plan.plan_id === planId)) throw new Error('PLAN_NOT_CURRENT_OR_NOT_APPROVED');
  }
  if (branchId) {
    const branch = plans.branches.find((item) => item.branch_id === branchId);
    if (!branch) throw new Error('BRANCH_NOT_CURRENT_OR_NOT_SELECTED');
    if (branch.plan_id !== planId) throw new Error('BRANCH_PLAN_MISMATCH');
  }
  if (options.source === 'offline-fixture') {
    const expected = fixtureCandidateText({ chapterText: readChapterBytes(opened.projectDir, options.chapterId).toString('utf8'), selectionEnd: end });
    if (!expected || options.text !== expected) throw new Error('FIXTURE_SOURCE_MUST_BE_SERVER_GENERATED');
  }
  const planning = readPlanning({ vaultDir: options.vaultDir, projectId: opened.project.project_id });
  const authoritative = authoritativeForbidden({ vaultDir: options.vaultDir, projectId: opened.project.project_id, chapterId: options.chapterId, planId });
  const forbidden = [...new Set([...authoritative.rules.map((rule) => rule.text), ...(options.forbidden ?? [])])];
  const authoritativeGenres = plans.genres.map((genre) => genre.genre_id);
  const { reviews, blocking } = reviewCandidate({ vaultDir: options.vaultDir, projectId: opened.project.project_id, chapterId: options.chapterId, povEntityId: options.povEntityId ?? null, text: options.text, genreIds: authoritativeGenres.length ? authoritativeGenres : (options.genreIds ?? []), forbidden });
  const branchIds = branchId ? [branchId] : [];
  const snapshot = snapshotOf(compiled, planning.state.version, branchIds, authoritative.rules.map((rule) => rule.rule_id));
  const candidate: ContinuationCandidate = {
    candidate_id: `cand_${contentDigest(Buffer.from(`${options.chapterId}:${options.text}:${Date.now()}`, 'utf8')).slice(7, 27)}`,
    project_id: opened.project.project_id, chapter_id: options.chapterId, base_revision: snapshot.chapter_revision, base_hash: snapshot.chapter_hash,
    task: options.task.slice(0, 500), start, end, pov_entity_id: options.povEntityId ?? null, plan_id: planId, branch_id: branchId,
    source: options.source, source_label: options.source === 'offline-fixture' ? '离线确定性续写演示（非模型输出）' : options.source === 'deepseek' ? 'DeepSeek 模型候选（需作者审阅，未写入正式稿）' : options.source === 'deepseek-mock' ? 'DeepSeek Mock 演示（非模型，仅界面测试）' : '作者手动导入候选（外部来源未验证）',
    text: options.text, snapshot, status: 'pending', reviews, blocking, created_at: new Date().toISOString(),
  };
  const items = load(options.appDataRoot, opened.project.project_id);
  saveAll(options.appDataRoot, opened.project.project_id, [...items, candidate]);
  return candidate;
}

export function fixtureCandidateText(options: { chapterText: string; selectionEnd: number }): string {
  const anchor = options.chapterText.slice(Math.max(0, options.selectionEnd - 40), options.selectionEnd).trim();
  return `${anchor ? `（承接：${anchor.slice(-12)}）\n\n` : ''}她把旧票收回袖中，没有立刻离开。港口的灯在水面上碎成几片，像一封没有写完的信。\n\n“船期是假的。”她说。\n\n账房没有抬头，只把算盘往旁边推了半寸。那半寸，比任何回答都更像承认。\n\n（离线确定性续写演示，非模型生成；仅供流程审阅。）`;
}

function currentStale(options: { vaultDir: string; projectId?: string | null; candidate: ContinuationCandidate }): boolean {
  try {
    const candidate = options.candidate;
    const next = compileContinuation({ vaultDir: options.vaultDir, projectId: options.projectId, chapterId: candidate.chapter_id, start: candidate.start, end: candidate.end, task: candidate.task, povEntityId: candidate.pov_entity_id });
    if (candidate.plan_id && !next.plans.plans.some((plan) => plan.plan_id === candidate.plan_id)) return true;
    if (candidate.branch_id) {
      const branch = next.plans.branches.find((item) => item.branch_id === candidate.branch_id);
      if (!branch || branch.status !== 'selected' || branch.plan_id !== candidate.plan_id) return true;
    }
    const planning = readPlanning({ vaultDir: options.vaultDir, projectId: options.projectId });
    const authoritative = authoritativeForbidden({ vaultDir: options.vaultDir, projectId: options.projectId, chapterId: candidate.chapter_id, planId: candidate.plan_id });
    const expected = snapshotOf(next.compiled, planning.state.version, candidate.branch_id ? [candidate.branch_id] : [], authoritative.rules.map((rule) => rule.rule_id));
    return expected.snapshot_hash !== candidate.snapshot.snapshot_hash;
  } catch { return true; }
}
export function listCandidates(options: { appDataRoot: string; vaultDir: string; projectId?: string | null }): ContinuationCandidate[] {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  return load(options.appDataRoot, opened.project.project_id).map((item) => currentStale({ vaultDir: options.vaultDir, projectId: opened.project.project_id, candidate: item })
    ? { ...item, status: 'stale' as const } : item);
}

export function decideCandidate(options: { appDataRoot: string; vaultDir: string; projectId?: string | null; candidateId: string; decision: 'selected' | 'rejected' }): ContinuationCandidate {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const items = listCandidates(options);
  const candidate = items.find((item) => item.candidate_id === options.candidateId);
  if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
  if (candidate.status === 'stale') throw new Error('STALE_CANDIDATE');
  if (options.decision === 'selected' && candidate.blocking) throw new Error('BLOCKING_CANDIDATE_CANNOT_BE_SELECTED');
  const updated = { ...candidate, status: options.decision };
  saveAll(options.appDataRoot, opened.project.project_id, items.map((item) => item.candidate_id === candidate.candidate_id ? updated : item));
  return updated;
}

export function exportCandidate(options: { appDataRoot: string; vaultDir: string; projectId?: string | null; candidateId: string }): { text: string; manuscript_written: false } {
  const candidate = listCandidates(options).find((item) => item.candidate_id === options.candidateId);
  if (!candidate) throw new Error('CANDIDATE_NOT_FOUND');
  if (candidate.status === 'stale') throw new Error('STALE_CANDIDATE');
  return { text: candidate.text, manuscript_written: false };
}
