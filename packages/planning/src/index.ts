import {
  SCHEMA_VERSION,
  contentDigest,
  type GenrePack,
  type PlanningState,
  type StoryBranch,
  type StoryIdea,
  type StoryScenePlan,
} from '@narrative-studio/contracts';
import { openProject, readPlanningState, writePlanningState } from '@narrative-studio/core';

export const GENRE_PACKS: GenrePack[] = [
  { genre_id: 'genre_gufeng', name: '古风/历史', version: 1, kind: 'builtin', reader_expectations: ['时代秩序与礼法压力', '克制的情绪表达'], beat_suggestions: ['以日常秩序显露阶层', '以物件承载承诺'], conflict_engines: ['礼法与私情', '家族与个人'], taboos: ['现代网络语', '无代价的等级跨越'], exceptions: ['作者明确采用戏谑叙述时可破例'], dialogue_preferences: ['称谓有礼法层级', '少用解释性独白'], pacing_preferences: ['场景留白', '转折靠行动'], source: 'synthetic-abstract' },
  { genre_id: 'genre_mystery', name: '现代悬疑', version: 1, kind: 'builtin', reader_expectations: ['线索可回溯', '答案延迟但公平'], beat_suggestions: ['以异常细节打开问题', '让证据改变人物关系'], conflict_engines: ['真相与自我保护', '时间压力'], taboos: ['无铺垫的全知解释', '靠巧合破案'], exceptions: ['不可靠叙述需提前给出信号'], dialogue_preferences: ['问答带试探', '信息分层释放'], pacing_preferences: ['短场景推进', '章末保留问题'], source: 'synthetic-abstract' },
  { genre_id: 'genre_urban', name: '都市/情感', version: 1, kind: 'builtin', reader_expectations: ['关系变化可感', '选择有现实代价'], beat_suggestions: ['以生活细节暴露关系', '让一次沉默改变距离'], conflict_engines: ['依恋与边界', '工作与亲密'], taboos: ['用疾病强行和解', '无边界的情感索取'], exceptions: ['作者明确写黑色幽默时可反讽'], dialogue_preferences: ['口语自然', '潜台词多于宣言'], pacing_preferences: ['关系节拍细密', '冲突落在具体行动'], source: 'synthetic-abstract' },
  { genre_id: 'genre_gufeng_mystery', name: '古风悬疑（混合）', version: 1, kind: 'builtin', reader_expectations: ['礼法社会中的证据链', '克制而危险的调查'], beat_suggestions: ['以礼法阻挠调查', '让旧案牵动当下关系'], conflict_engines: ['官法与人情', '秘密与家族名誉'], taboos: ['现代刑侦术语直搬', '无视时代权力结构'], exceptions: ['作者明确架空制度时按架空规则'], dialogue_preferences: ['问询含蓄', '称谓即权力'], pacing_preferences: ['慢铺陈、快收束'], source: 'synthetic-abstract' },
];

function id(prefix: string, seed: string): string { return `${prefix}_${contentDigest(Buffer.from(seed, 'utf8')).slice(7, 27)}`; }
function stateFor(projectDir: string, projectId: string): PlanningState {
  return readPlanningState(projectDir) ?? { schema_version: SCHEMA_VERSION, project_id: projectId, version: 0, ideas: [], plans: [], branches: [], genre_selections: [], forbidden_rules: [] };
}
function save(vaultDir: string, projectId: string, state: PlanningState): PlanningState {
  return writePlanningState({ vaultDir, projectId, value: { ...state, version: state.version + 1 }, actor: { kind: 'author', id: 'local-author' } }).value;
}

export function addIdea(options: { vaultDir: string; projectId?: string | null; idea: Omit<StoryIdea, 'idea_id'|'project_id'|'status'|'created_at'> }): StoryIdea {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  const idea: StoryIdea = { ...options.idea, idea_id: id('idea', `${options.idea.title}:${Date.now()}`), project_id: opened.project.project_id, status: 'saved', created_at: new Date().toISOString() };
  save(options.vaultDir, opened.project.project_id, { ...state, ideas: [...state.ideas, idea] });
  return idea;
}

export function addPlan(options: { vaultDir: string; projectId?: string | null; plan: Omit<StoryScenePlan, 'plan_id'|'project_id'|'approval_state'|'created_at'>, approve?: boolean }): StoryScenePlan {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  if (options.plan.base_chapter_revision) {
    const chapter = opened.manifest.chapters[`${options.plan.volume}:${options.plan.chapter}`] ?? Object.values(opened.manifest.chapters).find((item) => item.ordinal === options.plan.chapter);
    if (!chapter || chapter.current_revision_id !== options.plan.base_chapter_revision || chapter.content_hash !== options.plan.base_chapter_hash) throw new Error('STALE_PLAN_BASE');
  }
  const plan: StoryScenePlan = { ...options.plan, plan_id: id('plan', `${options.plan.title}:${Date.now()}`), project_id: opened.project.project_id, approval_state: options.approve ? 'author-approved' : 'draft', created_at: new Date().toISOString() };
  save(options.vaultDir, opened.project.project_id, { ...state, plans: [...state.plans, plan] });
  return plan;
}

export function addBranch(options: { vaultDir: string; projectId?: string | null; branch: Omit<StoryBranch, 'branch_id'|'project_id'|'status'|'created_at'> }): StoryBranch {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  const branch: StoryBranch = { ...options.branch, branch_id: id('branch', `${options.branch.title}:${Date.now()}`), project_id: opened.project.project_id, status: 'proposed', created_at: new Date().toISOString() };
  save(options.vaultDir, opened.project.project_id, { ...state, branches: [...state.branches, branch] });
  return branch;
}

export function selectBranch(options: { vaultDir: string; projectId?: string | null; branchId: string }): PlanningState {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  const target = state.branches.find((branch) => branch.branch_id === options.branchId);
  if (!target) throw new Error('BRANCH_NOT_FOUND');
  if (!target.plan_id || !state.plans.some((plan) => plan.plan_id === target.plan_id && plan.approval_state === 'author-approved')) throw new Error('BRANCH_SCOPE_NOT_APPROVED');
  return save(options.vaultDir, opened.project.project_id, { ...state, branches: state.branches.map((branch) => branch.branch_id === options.branchId ? { ...branch, status: 'selected' } : branch.status === 'selected' ? { ...branch, status: 'rejected' } : branch) });
}

export function setGenres(options: { vaultDir: string; projectId?: string | null; genreIds: string[] }): PlanningState {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  for (const genreId of options.genreIds) if (!GENRE_PACKS.some((pack) => pack.genre_id === genreId)) throw new Error('UNKNOWN_GENRE');
  return save(options.vaultDir, opened.project.project_id, { ...state, genre_selections: [{ selection_id: id('genre', options.genreIds.join(':')), project_id: opened.project.project_id, genre_ids: options.genreIds, source: 'author', created_at: new Date().toISOString() }] });
}

export function revokePlan(options: { vaultDir: string; projectId?: string | null; planId: string }): PlanningState {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  if (!state.plans.some((plan) => plan.plan_id === options.planId)) throw new Error('PLAN_NOT_FOUND');
  return save(options.vaultDir, opened.project.project_id, { ...state, plans: state.plans.map((plan) => plan.plan_id === options.planId ? { ...plan, approval_state: 'stale' } : plan), branches: state.branches.map((branch) => branch.plan_id === options.planId ? { ...branch, status: 'stale' } : branch) });
}
export function addForbiddenRule(options: { vaultDir: string; projectId?: string | null; text: string; scope: 'project' | 'chapter' | 'plan'; chapterId?: string | null; planId?: string | null }): PlanningState {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  if (!options.text.trim()) throw new Error('EMPTY_FORBIDDEN_RULE');
  const rule = { rule_id: id('forbid', options.text + ':' + Date.now()), project_id: opened.project.project_id, text: options.text.trim().slice(0, 500), scope: options.scope, chapter_id: options.chapterId ?? null, plan_id: options.planId ?? null, source: 'author-explicit' as const, approved: true, created_at: new Date().toISOString() };
  return save(options.vaultDir, opened.project.project_id, { ...state, forbidden_rules: [...state.forbidden_rules, rule] });
}

export function revokeForbiddenRule(options: { vaultDir: string; projectId?: string | null; ruleId: string }): PlanningState {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  return save(options.vaultDir, opened.project.project_id, { ...state, forbidden_rules: state.forbidden_rules.map((rule) => rule.rule_id === options.ruleId ? { ...rule, approved: false } : rule) });
}

export function authoritativeForbidden(options: { vaultDir: string; projectId?: string | null; chapterId: string | null; planId: string | null }): { rules: Array<{ rule_id: string; text: string }>; unbound: boolean } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  const rules = state.forbidden_rules.filter((rule) => rule.approved && (rule.scope === 'project' || (rule.scope === 'chapter' && rule.chapter_id === options.chapterId) || (rule.scope === 'plan' && rule.plan_id === options.planId)));
  return { rules: rules.map((rule) => ({ rule_id: rule.rule_id, text: rule.text })), unbound: rules.length === 0 };
}

export function readPlanning(options: { vaultDir: string; projectId?: string | null }): { state: PlanningState; genres: GenrePack[]; selectedGenreIds: string[] } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  const selectedGenreIds = state.genre_selections.at(-1)?.genre_ids ?? [];
  return { state, genres: GENRE_PACKS, selectedGenreIds };
}
export function compilePlanContext(options: {
  vaultDir: string; projectId?: string | null; chapter: number; chapterId?: string | null; povEntityId?: string | null;
}): { genres: GenrePack[]; plans: StoryScenePlan[]; branches: StoryBranch[]; excluded: Array<{ id: string; reason: string }>; compositionConflict: string | null } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined); const state = stateFor(opened.projectDir, opened.project.project_id);
  const selected = state.genre_selections.at(-1)?.genre_ids ?? [];
  const genres = GENRE_PACKS.filter((pack) => selected.includes(pack.genre_id));
  const excluded: Array<{ id: string; reason: string }> = [];
  const plans = state.plans.filter((plan) => {
    if (plan.chapter !== options.chapter) { excluded.push({ id: plan.plan_id, reason: 'different chapter' }); return false; }
    if (plan.approval_state !== 'author-approved') { excluded.push({ id: plan.plan_id, reason: 'not author-approved' }); return false; }
    if (plan.pov_entity_id && plan.pov_entity_id !== (options.povEntityId ?? null)) { excluded.push({ id: plan.plan_id, reason: 'POV scope mismatch' }); return false; }
    const entry = options.chapterId ? opened.manifest.chapters[options.chapterId] : Object.values(opened.manifest.chapters).find((item) => item.ordinal === options.chapter);
    if (plan.base_chapter_revision && (!entry || entry.current_revision_id !== plan.base_chapter_revision || entry.content_hash !== plan.base_chapter_hash)) {
      excluded.push({ id: plan.plan_id, reason: 'stale chapter revision/hash' }); return false;
    }
    return true;
  });
  const planIds = new Set(plans.map((plan) => plan.plan_id));
  const branches = state.branches.filter((branch) => {
    if (branch.status !== 'selected') { excluded.push({ id: branch.branch_id, reason: `branch status ${branch.status}` }); return false; }
    if (!branch.plan_id || !planIds.has(branch.plan_id)) { excluded.push({ id: branch.branch_id, reason: 'branch has no current approved plan scope' }); return false; }
    return true;
  });
  const conflict = genres.length > 1 ? '混合题材同时启用；题材软规则必须让位于作者意图、Canon/POV 和已批准 Voice。' : null;
  return { genres, plans, branches, excluded, compositionConflict: conflict };
}