export interface ChapterSummary {
  chapter_id: string;
  title: string;
  volume_id: string;
  ordinal: number;
  word_count: number;
  current_revision_id: string;
  content_hash: string;
  updated_at: string;
}

export interface RevisionSummary {
  revision_id: string;
  seq: number;
  parent_revision_id: string | null;
  content_hash: string;
  byte_length: number;
  encoding: string;
  line_ending: string;
  created_at: string;
  origin: string;
  message: string | null;
  approval_id: string | null;
}

export interface Bootstrap {
  project: {
    project_id: string;
    title: string;
    language: string;
    default_volume_id: string;
  };
  manifest: { revision: string; seq: number; updated_at: string };
  status: {
    vault_root: string;
    project_dir: string;
    total_word_count: number;
    chapter_count: number;
    lock: { exists: boolean; heldByLiveProcess: boolean };
    pending_transactions: number;
  };
  projection: { status: string };
  chapters: ChapterSummary[];
}

export interface ChapterPayload {
  chapter: ChapterSummary;
  content: string;
  revision: RevisionSummary;
  manifest_revision: string;
}

export interface SaveResult {
  revision: RevisionSummary;
  manifest_revision: string;
  content_hash: string;
  saved_at: string;
  projection: { status: string };
}

export type NarrativeStatus = 'source-extracted' | 'inferred' | 'author-confirmed' | 'disputed';
export interface EvidenceAnchor {
  anchor_id: string;
  chapter_id: string;
  revision_id: string;
  start_offset: number;
  end_offset: number;
  quote: string;
  quote_hash: string;
  chapter_content_hash: string;
  status: 'current' | 'stale' | 'missing';
  note: string | null;
}
export interface NarrativeEntity {
  entity_id: string;
  name: string;
  kind: 'person' | 'place' | 'object' | 'organization' | 'other';
  aliases: string[];
  description: string | null;
  status: NarrativeStatus;
  evidence_anchor_ids: string[];
}
export interface NarrativeAssertion {
  assertion_id: string;
  subject_id: string;
  predicate: string;
  object_id: string | null;
  value: string | null;
  status: NarrativeStatus;
  story_time: { kind: string; label: string; sort_key: number | null };
  reveal_order: number;
  knowledge_scope: string;
  confidence: number;
  evidence_anchor_ids: string[];
  note: string | null;
}
export interface NarrativeEvent {
  event_id: string;
  kind: 'event' | 'flashback' | 'reveal';
  description: string;
  chapter_id: string;
  chapter_order: number;
  story_time: { kind: string; label: string; sort_key: number | null };
  participant_ids: string[];
  status: NarrativeStatus;
  evidence_anchor_ids: string[];
}
export interface NarrativeKnowledge {
  knowledge_id: string;
  character_id: string;
  assertion_id: string;
  learns_at_order: number;
  source: string;
  status: NarrativeStatus;
  evidence_anchor_ids: string[];
}
export interface NarrativeRelationship {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
  kind: string;
  status: NarrativeStatus;
  valid_from_order: number;
  valid_to_order: number | null;
  evidence_anchor_ids: string[];
}
export interface NarrativeForeshadow {
  clue_id: string;
  label: string;
  setup_order: number;
  payoff_order: number | null;
  status: 'open' | 'paid-off' | 'abandoned' | 'disputed';
  setup_evidence_anchor_ids: string[];
  payoff_evidence_anchor_ids: string[];
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
export interface NarrativeOverview {
  status: string;
  source_revision: string;
  indexed_at: string | null;
  counts: Record<string, number>;
  entities: NarrativeEntity[];
  assertions: NarrativeAssertion[];
  events: NarrativeEvent[];
  knowledge: NarrativeKnowledge[];
  relationships: NarrativeRelationship[];
  foreshadowing: NarrativeForeshadow[];
  candidates: NarrativeCandidate[];
  evidence: EvidenceAnchor[];
  stale_evidence: number;
  pending_chapters: number;
  canon_stale: boolean;
}
export interface NarrativeSearchHit {
  chapter_id: string;
  title: string;
  chapter_order: number;
  score: number;
  matches: { start: number; end: number; quote: string; exact: string; kind: 'exact' | 'partial' | 'alias' }[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers);
  if (options.body) headers.set('content-type', 'application/json');
  if (options.method && options.method !== 'GET') headers.set('x-ns-request', 'studio');
  const response = await fetch(path, { ...options, headers, credentials: 'same-origin' });
  const payload = (await response.json()) as { ok?: boolean; error?: { code: string; message: string } } & T;
  if (!response.ok || payload.ok === false) {
    throw new ApiError(
      response.status,
      payload.error?.code ?? 'INTERNAL',
      payload.error?.message ?? `Request failed (${response.status})`,
    );
  }
  return payload;
}

export type VoiceScopeView = 'author' | 'project' | 'character' | 'scene';
export interface VoiceSourceView {
  source_id: string;
  name: string;
  description: string;
  scope: VoiceScopeView;
  scope_ref: string | null;
  category: 'author-owned' | 'licensed-reference' | 'synthetic';
  status: 'active' | 'revoked' | 'deleted';
  effective_status: 'active' | 'stale' | 'revoked' | 'deleted';
  stale_reason: string | null;
  revoke_reason: string | null;
  rights_statement: string;
  permissions: Record<string, boolean>;
  chapter_count: number;
  updated_at: string;
}
export interface VoiceMetricView {
  metric_id: string;
  label: string;
  method: string;
  unit: string;
  value: number | string | Record<string, number>;
  sample_size: number;
  confidence: 'insufficient' | 'exploratory' | 'stable';
  caveat: string;
  evidence_anchor_ids: string[];
}
export interface VoiceCharacterView {
  character_id: string;
  character_name: string;
  dialogue_samples: number;
  metrics: VoiceMetricView[];
  unknown_attribution_count: number;
}
export interface VoiceProfileView {
  profile_id: string;
  scope: VoiceScopeView;
  scope_ref: string | null;
  status: string;
  generated_at: string;
  source_char_count: number;
  chapter_count: number;
  dialogue_samples: number;
  unknown_dialogue_count: number;
  metrics: VoiceMetricView[];
  characters: VoiceCharacterView[];
  evidence: Array<{ anchor_id: string; chapter_id: string; quote: string; status: string }>;
  stale_reason: string | null;
  source_ids: string[];
}
export interface VoiceProposalView {
  proposal_id: string;
  scope: VoiceScopeView;
  scope_ref: string | null;
  intent: string;
  text: string;
  conditions: string;
  source_ids: string[];
  evidence_anchor_ids: string[];
  metric_ids: string[];
}
export interface VoiceRuleView {
  rule_id: string;
  scope: VoiceScopeView;
  scope_ref: string | null;
  intent: string;
  text: string;
  conditions: string;
  status: string;
  effective_status: 'approved' | 'revoked' | 'stale';
  stale_reason: string | null;
  version: number;
  approved_at: string | null;
  source_ids: string[];
  previous: { version: number; text: string } | null;
}
export interface VoiceOverviewView {
  status: 'current' | 'stale' | 'missing' | 'error';
  project_id: string;
  registry_version: number;
  constitution_version: number;
  sources: VoiceSourceView[];
  profiles: VoiceProfileView[];
  proposals: VoiceProposalView[];
  rules: VoiceRuleView[];
  generated_at: string | null;
  stale_reason: string | null;
}
export interface EditorialContextSnippet { snippet_id:string; kind:'hard'|'soft'; role:string; text:string; reason:string; status:string }
export interface EditorialCompileView {
  job: { job_id:string; chapter_id:string; base_revision:string; base_hash:string; selection:{start:number;end:number}; task:string; level:string; budget_tokens:number; status:string };
  context: { hard:EditorialContextSnippet[]; soft:EditorialContextSnippet[]; excluded:EditorialContextSnippet[]; estimated_tokens:number; budget_tokens:number; hard_tokens:number; status:string; rejection_reason:string|null; injection_warnings:string[] };
  manifest: { manifest_id:string; provider:string; external_send:boolean; estimated_prompt_tokens:number; prompt_hash:string } | Record<string, never>;
  prompt: string;
  future_secret_values: string[];
}
export interface EditorialHunkView { hunk_id:string; start:number; end:number; old_text:string; replacement:string; reason:string; decision:'pending'|'accept'|'reject' }
export interface EditorialRiskView { risk_id:string; severity:'info'|'warning'|'blocking'; kind:string; message:string; hunk_id:string|null }
export interface EditorialProposalView { proposal_id:string; chapter_id:string; base_revision:string; base_hash:string; source:string; source_label:string; selection:{start:number;end:number}; hunks:EditorialHunkView[]; preview:string; original_text:string; risks:EditorialRiskView[]; status:string }export interface CoevolutionView {
  state: { consent: Record<string, boolean>; observations: Array<Record<string, unknown>>; goals: Array<{goal_id:string;skill:string;status:string;note:string}>; reflections: Array<Record<string, unknown>>; exercises: Array<Record<string, unknown>> };
  hypotheses: Array<{hypothesis_id:string;text:string;scope_label:string;positive:number;negative:number;effective_samples:number;uncertainty:string}>;
  policies: Array<{policy_id:string;text:string;scope:string;scope_ref:string|null;status:string;version:number;effective_status:string;stale_reason:string|null}>;
  projection: { status:string; hypotheses:number };
}export interface PlanningView { state: { ideas: Array<Record<string, unknown>>; plans: Array<{plan_id:string;title:string;approval_state:string;chapter:number;pov_entity_id:string|null}>; branches: Array<{branch_id:string;title:string;status:string;plan_id:string|null;premise:string;short_term_cost:string;motivation:string;irreversible_cost:string;risk:string}>; genre_selections: Array<Record<string, unknown>> }; genres: Array<{genre_id:string;name:string;version:number}>; selectedGenreIds: string[]; }export interface ContinuationView { candidates: Array<{candidate_id:string;text:string;source:string;source_label:string;status:string;blocking:boolean;reviews:Array<{dimension:string;severity:string;reason:string}>}>; }export interface AiStatusView { status:{configured:boolean;model:string;base_url:string;provider:string;network:string} }
export interface StoryOutlineView { title:string;logline:string;world:string;protagonist:string;antagonist:string;main_conflict:string;characters:Array<{name:string;role:string;goal:string;secret:string}>;volumes:Array<{volume:number;title:string;chapters:Array<{chapter:number;title:string;goal:string;conflict:string}>}> }export interface LiteraryView { provider:{status:string;model_id:string|null;reason:string;network:string;authorized:boolean}; summary:{pairs:number;reviews:number;b0_wins:number;b1_wins:number;ties:number;neither:number;status:string}; }export const api = {
  voice: () => request<{ voice: VoiceOverviewView }>('/api/voice'),
  voiceAnalyze: () =>
    request<{ voice: VoiceOverviewView }>('/api/voice/analyze', { method: 'POST', body: '{}' }),
  voiceAddSource: (input: Record<string, unknown>) =>
    request<{ source: VoiceSourceView; voice: VoiceOverviewView }>('/api/voice/sources', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  voiceRevokeSource: (sourceId: string, reason: string) =>
    request<{ voice: VoiceOverviewView }>('/api/voice/sources/revoke', {
      method: 'POST',
      body: JSON.stringify({ sourceId, reason }),
    }),
  voiceApprove: (proposalId: string, note?: string) =>
    request<{ voice: VoiceOverviewView }>('/api/voice/proposals/approve', {
      method: 'POST',
      body: JSON.stringify({ proposalId, note }),
    }),
  voiceRevokeRule: (ruleId: string, reason: string) =>
    request<{ voice: VoiceOverviewView }>('/api/voice/rules/revoke', {
      method: 'POST',
      body: JSON.stringify({ ruleId, reason }),
    }),
  voiceRollbackRule: (ruleId: string) =>
    request<{ voice: VoiceOverviewView }>('/api/voice/rules/rollback', {
      method: 'POST',
      body: JSON.stringify({ ruleId }),
    }),
  voiceCompare: (textA: string, textB: string) =>
    request<{ comparison: { a: Record<string, number>; b: Record<string, number> } }>('/api/voice/compare', {
      method: 'POST',
      body: JSON.stringify({ textA, textB }),
    }),  coevolution: () => request<{ coevolution: CoevolutionView }>('/api/coevolution'),
  coevolutionConsent: (consent: Record<string, boolean>) => request<{ coevolution: CoevolutionView }>('/api/coevolution/consent', { method:'POST', body:JSON.stringify(consent) }),
  coevolutionFeedback: (input: Record<string, unknown>) => request<{ coevolution: CoevolutionView }>('/api/coevolution/feedback', { method:'POST', body:JSON.stringify(input) }),
  coevolutionActivate: (hypothesisId:string, text?:string) => request<{ coevolution: CoevolutionView }>('/api/coevolution/policies/activate', { method:'POST', body:JSON.stringify({ hypothesisId, text }) }),
  coevolutionPolicyTransition: (policyId:string, action:'freeze'|'revoke'|'rollback') => request<{ coevolution: CoevolutionView }>('/api/coevolution/policies/transition', { method:'POST', body:JSON.stringify({ policyId, action, reason: action }) }),
  coevolutionGoal: (skill:string, note:string) => request<{ coevolution: CoevolutionView }>('/api/coevolution/goal', { method:'POST', body:JSON.stringify({ skill, note }) }),
  coevolutionReflection: (prompt:string, note:string) => request<{ coevolution: CoevolutionView }>('/api/coevolution/reflection', { method:'POST', body:JSON.stringify({ prompt, note }) }),
  coevolutionExercise: (exerciseId:string, status:'started'|'completed'|'deferred') => request<{ coevolution: CoevolutionView }>('/api/coevolution/exercise', { method:'POST', body:JSON.stringify({ exerciseId, status }) }),  gate4: () => request<{ planning: PlanningView }>('/api/gate4'),
  gate4Idea: (input: Record<string, unknown>) => request<{ planning: PlanningView }>('/api/gate4/idea', { method:'POST', body:JSON.stringify(input) }),
  gate4Plan: (input: Record<string, unknown>) => request<{ planning: PlanningView }>('/api/gate4/plan', { method:'POST', body:JSON.stringify(input) }),
  gate4Branch: (input: Record<string, unknown>) => request<{ planning: PlanningView }>('/api/gate4/branch', { method:'POST', body:JSON.stringify(input) }),
  gate4SelectBranch: (branchId:string) => request<{ planning: PlanningView }>('/api/gate4/branch/select', { method:'POST', body:JSON.stringify({ branchId }) }),
  gate4Genre: (genreIds:string[]) => request<{ planning: PlanningView }>('/api/gate4/genre', { method:'POST', body:JSON.stringify({ genreIds }) }),  continuationList: () => request<ContinuationView>('/api/gate4/continuation'),
  continuationCompile: (input: Record<string, unknown>) => request<{compiled: unknown; plans: unknown}>('/api/gate4/continuation/compile', { method:'POST', body:JSON.stringify(input) }),
  continuationCandidate: (input: Record<string, unknown>) => request<{candidate: unknown}>('/api/gate4/continuation/candidate', { method:'POST', body:JSON.stringify(input) }),
  continuationDecision: (candidateId:string, decision:'selected'|'rejected') => request<{candidate: unknown}>('/api/gate4/continuation/decision', { method:'POST', body:JSON.stringify({candidateId,decision}) }),
  continuationExport: (candidateId:string) => request<{text:string;manuscript_written:false}>('/api/gate4/continuation/export', { method:'POST', body:JSON.stringify({candidateId}) }),  aiStatus: () => request<AiStatusView>('/api/ai/status'),
  aiOutline: (input: Record<string, unknown>) => request<{outline:StoryOutlineView;source:string;model:string}>('/api/ai/outline', { method:'POST', body:JSON.stringify(input) }),
  aiContinue: (input: Record<string, unknown>) => request<{candidate:{candidate_id:string;text:string};source:string;model:string;external_send:boolean}>('/api/ai/continue', { method:'POST', body:JSON.stringify(input) }),  literary: () => request<LiteraryView>('/api/literary'),
  literaryPair: (input: Record<string, unknown>) => request<{pair:{pair_id:string;a:{text:string};b:{text:string};task_id:string}}>('/api/literary/pair', { method:'POST', body:JSON.stringify(input) }),
  literaryReview: (input: Record<string, unknown>) => request<{summary:LiteraryView['summary']}>('/api/literary/review', { method:'POST', body:JSON.stringify(input) }),
  literaryClear: () => request('/api/literary/clear', { method:'POST', body:'{}' }),  editorialCompile: (input: Record<string, unknown>) => request<EditorialCompileView & { ok: true }>('/api/editorial/compile', { method:'POST', body:JSON.stringify(input) }),
  editorialFixture: (input: Record<string, unknown>) => request<{ ok:true; proposal:EditorialProposalView }>('/api/editorial/fixture', { method:'POST', body:JSON.stringify(input) }),
  editorialCandidate: (input: Record<string, unknown>) => request<{ ok:true; proposal:EditorialProposalView }>('/api/editorial/candidate', { method:'POST', body:JSON.stringify(input) }),
  editorialDecision: (proposalId:string,hunkId:string,decision:'pending'|'accept'|'reject') => request<{ ok:true; proposal:EditorialProposalView; exported_preview:string }>('/api/editorial/decision', { method:'POST', body:JSON.stringify({ proposalId,hunkId,decision }) }),
  editorialExport: (proposalId:string) => request<{ ok:true; text:string; manuscript_written:false }>('/api/editorial/export', { method:'POST', body:JSON.stringify({ proposalId }) }),  bootstrap: () => request<Bootstrap>('/api/bootstrap'),
  chapter: (chapterId: string) => request<ChapterPayload>(`/api/chapter/${encodeURIComponent(chapterId)}`),
  history: (chapterId: string) =>
    request<{ revisions: RevisionSummary[] }>(`/api/chapter/${encodeURIComponent(chapterId)}/history`),
  revision: (chapterId: string, revisionId: string) =>
    request<{ revision: RevisionSummary; content: string }>(
      `/api/chapter/${encodeURIComponent(chapterId)}/revision/${encodeURIComponent(revisionId)}`,
    ),
  save: (chapterId: string, content: string, baseRevision: string, message?: string) =>
    request<SaveResult>(`/api/chapter/${encodeURIComponent(chapterId)}/save`, {
      method: 'POST',
      body: JSON.stringify({ content, baseRevision, message }),
    }),
  revert: (chapterId: string, revisionId: string, baseRevision: string) =>
    request<{ revision: RevisionSummary; manifest_revision: string }>(
      `/api/chapter/${encodeURIComponent(chapterId)}/revert`,
      { method: 'POST', body: JSON.stringify({ revisionId, baseRevision }) },
    ),
  narrative: () => request<NarrativeOverview>('/api/narrative'),
  narrativeSearch: (query: string, atOrder?: number | null) => {
    const suffix = atOrder === undefined || atOrder === null ? '' : `&atOrder=${atOrder}`;
    return request<{ query: string; results: NarrativeSearchHit[] }>(
      `/api/narrative/search?q=${encodeURIComponent(query)}${suffix}`,
    );
  },
  narrativeChapter: (chapterId: string) =>
    request<{ evidence: EvidenceAnchor[]; assertion_ids: string[]; event_ids: string[] }>(
      `/api/narrative/chapter/${encodeURIComponent(chapterId)}`,
    ),
  reindexNarrative: (chapterId?: string | null, full = false) =>
    request<{ result: Record<string, unknown> }>('/api/narrative/reindex', {
      method: 'POST',
      body: JSON.stringify({ chapterId: chapterId ?? null, full }),
    }),
  confirmNarrativeCandidate: (candidateId: string) =>
    request<{ assertionId: string; anchorId: string; manifest_revision: string }>('/api/narrative/confirm', {
      method: 'POST',
      body: JSON.stringify({ candidateId }),
    }),
  importChapter: (title:string,content:string,baseRevision:string,importId:string) =>
    request<{chapter:ChapterSummary;manifest_revision:string}>('/api/chapter',{method:'POST',body:JSON.stringify({title,content,baseRevision,importId})}),
  createChapter: (title: string) =>
    request<{ chapter: ChapterSummary; manifest_revision: string }>('/api/chapter', {
      method: 'POST',
      body: JSON.stringify({ title }),
    }),
};
