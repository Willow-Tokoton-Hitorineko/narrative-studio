/**
 * Narrative Studio V4.4 — Gate 0 minimal versionable domain contracts.
 *
 * Every authoritative object carries: id, project_id, schema_version,
 * created_at/updated_at (where mutable), provenance, status and — where
 * relevant — source/ancestor revision. New domain objects (CanonAssertion,
 * Entity, EditorialJob, PreferenceObservation, ...) extend this envelope
 * instead of inventing a second storage path.
 */

export const SCHEMA_VERSION = 1 as const;
export const VAULT_SCHEMA_VERSION = 1 as const;

export type IsoDateTime = string;
export type Sha256ContentHash = string;

export type ProvenanceSource = 'author' | 'import' | 'model' | 'system' | 'migration';

export interface Provenance {
  source: ProvenanceSource;
  actor_id: string;
  tool?: string | null;
  note?: string | null;
}

export type ActorKind = 'author' | 'agent' | 'system';

export interface Actor {
  kind: ActorKind;
  id: string;
}

export type EntityStatus = 'active' | 'archived';
export type RevisionStatus = 'committed' | 'superseded';
export type OperationStatus = 'committed' | 'recovered' | 'rolled_back';
export type ApprovalDecision = 'approved' | 'rejected';
export type ApprovalState = 'active' | 'revoked';
export type ProjectionLifecycleStatus = 'current' | 'stale' | 'pending' | 'failed';
export type JournalState =
  | 'PREPARED'
  | 'FILES_APPLIED'
  | 'PORTABLE_COMMITTED'
  | 'ROLLED_BACK'
  | 'ROLLBACK_FAILED';

export type OperationType =
  | 'project.init'
  | 'chapter.create'
  | 'chapter.commit'
  | 'import.apply'
  | 'narrative.canon'
  | 'voice.corpus'
  | 'voice.constitution'
  | 'coevolution.state'
  | 'planning.state'
  | 'approval.record';

export type ApprovalAction =
  | 'commit_chapter'
  | 'commit_canon'
  | 'approve_style_constitution'
  | 'restore_backup';

export type RevisionOrigin = 'author' | 'import' | 'model' | 'system';
export type LineEnding = 'lf' | 'crlf' | 'mixed' | 'none';
export type TextEncoding = 'utf-8' | 'utf-8-bom';

// ---------------------------------------------------------------------------
// Project / Chapter / Revision
// ---------------------------------------------------------------------------

export interface Project {
  schema_version: typeof SCHEMA_VERSION;
  project_id: string;
  title: string;
  description: string | null;
  language: string;
  default_volume_id: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  status: EntityStatus;
  provenance: Provenance;
}

export interface Chapter {
  schema_version: typeof SCHEMA_VERSION;
  chapter_id: string;
  project_id: string;
  volume_id: string;
  title: string;
  ordinal: number;
  current_revision_id: string;
  content_hash: Sha256ContentHash;
  word_count: number;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  provenance: Provenance;
  status: 'draft' | 'committed';
}

export interface Revision {
  schema_version: typeof SCHEMA_VERSION;
  revision_id: string;
  project_id: string;
  chapter_id: string;
  seq: number;
  parent_revision_id: string | null;
  content_hash: Sha256ContentHash;
  byte_length: number;
  encoding: TextEncoding;
  line_ending: LineEnding;
  created_at: IsoDateTime;
  actor: Actor;
  origin: RevisionOrigin;
  message: string | null;
  approval_id: string | null;
  provenance: Provenance;
  status: RevisionStatus;
}

// ---------------------------------------------------------------------------
// Operation / Approval / ProjectionStatus
// ---------------------------------------------------------------------------

export interface Operation {
  schema_version: typeof SCHEMA_VERSION;
  operation_id: string;
  seq: number;
  project_id: string;
  type: OperationType;
  created_at: IsoDateTime;
  actor: Actor;
  base_revision: string | null;
  result_revision: string;
  payload: Record<string, unknown>;
  approval_id: string | null;
  provenance: Provenance;
  status: OperationStatus;
}

export interface ApprovalScope {
  chapter_id?: string;
  content_hash?: Sha256ContentHash;
  revision_id?: string;
  proposal_id?: string;
}

export interface Approval {
  schema_version: typeof SCHEMA_VERSION;
  approval_id: string;
  project_id: string;
  created_at: IsoDateTime;
  actor: Actor;
  action: ApprovalAction;
  scope: ApprovalScope;
  decision: ApprovalDecision;
  note: string | null;
  provenance: Provenance;
  status: ApprovalState;
}

export interface ProjectionStatus {
  schema_version: typeof SCHEMA_VERSION;
  project_id: string;
  source_revision: string;
  projection_revision: string;
  status: ProjectionLifecycleStatus;
  computed_at: IsoDateTime | null;
  evidence_refs: string[];
  details?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Manifest (authoritative head + file hash map)
// ---------------------------------------------------------------------------

export interface ManifestFileEntry {
  sha256: string;
  size: number;
}

export interface ManifestChapterEntry {
  chapter_id: string;
  volume_id: string;
  title: string;
  ordinal: number;
  current_revision_id: string;
  content_hash: Sha256ContentHash;
  word_count: number;
  revision_seq: number;
  path: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
}

export interface ManifestGenerator {
  name: string;
  version: string;
  node: string;
}

export interface Manifest {
  schema_version: typeof SCHEMA_VERSION;
  vault_schema_version: typeof VAULT_SCHEMA_VERSION;
  project_id: string;
  title: string;
  seq: number;
  revision: string;
  head_revision: string | null;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  generator: ManifestGenerator;
  chapters: Record<string, ManifestChapterEntry>;
  files: Record<string, ManifestFileEntry>;
}

// ---------------------------------------------------------------------------
// Journal (crash-recovery transaction record)
// ---------------------------------------------------------------------------

export type JournalFileMode = 'create' | 'replace';

export interface JournalFileEntry {
  rel_path: string;
  mode: JournalFileMode;
  before_hash: string | null;
  after_hash: string;
  staged_path: string;
  backup_path: string | null;
  size: number;
}

export interface JournalTransaction {
  schema_version: typeof SCHEMA_VERSION;
  txn_id: string;
  project_id: string;
  state: JournalState;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  pid: number;
  host: string;
  base_revision: string | null;
  target_revision: string;
  operation: Operation;
  files: JournalFileEntry[];
  manifest_after_hash: string;
  last_error: string | null;
  recovered_at: IsoDateTime | null;
  recovery_action: 'none' | 'redo' | 'rollback' | 'finalize' | 'preserve';
}

// ---------------------------------------------------------------------------
// Proposals (non-authoritative AI/agent suggestions; require approval to apply)
// ---------------------------------------------------------------------------

export type ProposalStatus = 'proposed' | 'approved' | 'rejected' | 'stale';

export interface Proposal {
  schema_version: typeof SCHEMA_VERSION;
  proposal_id: string;
  project_id: string;
  chapter_id: string;
  base_revision: string;
  content_hash: Sha256ContentHash;
  body_path: string;
  created_at: IsoDateTime;
  origin: RevisionOrigin;
  status: ProposalStatus;
  note: string | null;
  provenance: Provenance;
  decided_at: IsoDateTime | null;
  decided_by: Actor | null;
}

// ---------------------------------------------------------------------------
// Vault descriptor / backup manifest
// ---------------------------------------------------------------------------

export interface VaultDescriptor {
  schema_version: typeof SCHEMA_VERSION;
  vault_id: string;
  kind: 'narrative-studio-vault';
  created_at: IsoDateTime;
  app_version: string;
}

export interface SnapshotFileEntry {
  rel_path: string;
  sha256: string;
  size: number;
}

export type SnapshotKind = 'backup' | 'export';

/**
 * A verified file set (backup or read-only export) with per-file hashes.
 * `digest` is the SHA-256 of the canonical file list, so a restore can prove
 * it reproduced exactly the snapshot it read.
 */
export interface SnapshotManifest {
  schema_version: typeof SCHEMA_VERSION;
  snapshot_id: string;
  kind: SnapshotKind;
  project_id: string;
  created_at: IsoDateTime;
  source_revision: string;
  app_version: string;
  file_count: number;
  digest: string;
  files: SnapshotFileEntry[];
}

export interface ProjectTextStats {
  characters: number;
  cjk_characters: number;
  latin_words: number;
  paragraph_count: number;
}

// ---------------------------------------------------------------------------
// Import provenance (Gate 1)
// ---------------------------------------------------------------------------

export type ImportEncoding = 'utf-8' | 'utf-8-bom' | 'gb18030' | 'utf-16le' | 'utf-16be';

export interface ImportMetadata {
  schema_version: typeof SCHEMA_VERSION;
  import_id: string;
  project_id: string;
  created_at: IsoDateTime;
  source_filename: string;
  source_sha256: string;
  source_bytes: number;
  source_encoding: ImportEncoding;
  line_ending: LineEnding;
  chapter_count: number;
  volume_count: number;
  empty_chapter_count: number;
  raw_path: string;
  provenance: Provenance;
  status: 'committed';
}

// ---------------------------------------------------------------------------
// Gate 2 narrative knowledge (author-confirmed canon bundle)
// ---------------------------------------------------------------------------

export type NarrativeStatus = 'source-extracted' | 'inferred' | 'author-confirmed' | 'disputed';
export type EvidenceStatus = 'current' | 'stale' | 'missing';
export type EntityKind = 'person' | 'place' | 'object' | 'organization' | 'other';

export interface EvidenceAnchor {
  anchor_id: string;
  chapter_id: string;
  revision_id: string;
  start_offset: number;
  end_offset: number;
  quote: string;
  quote_hash: string;
  chapter_content_hash: string;
  status: EvidenceStatus;
  note: string | null;
}

export interface NarrativeEntity {
  entity_id: string;
  name: string;
  kind: EntityKind;
  aliases: string[];
  description: string | null;
  status: NarrativeStatus;
  evidence_anchor_ids: string[];
}

export interface StoryTime {
  kind: 'absolute' | 'relative' | 'unknown';
  label: string;
  sort_key: number | null;
}

export interface NarrativeAssertion {
  assertion_id: string;
  subject_id: string;
  predicate: string;
  object_id: string | null;
  value: string | null;
  status: NarrativeStatus;
  story_time: StoryTime;
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
  story_time: StoryTime;
  participant_ids: string[];
  status: NarrativeStatus;
  evidence_anchor_ids: string[];
}

export interface CharacterKnowledge {
  knowledge_id: string;
  character_id: string;
  assertion_id: string;
  learns_at_order: number;
  source: 'witnessed' | 'told' | 'inferred' | 'rumor' | 'false-belief';
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

export interface Foreshadow {
  clue_id: string;
  label: string;
  setup_order: number;
  payoff_order: number | null;
  status: 'open' | 'paid-off' | 'abandoned' | 'disputed';
  setup_evidence_anchor_ids: string[];
  payoff_evidence_anchor_ids: string[];
}

export interface NarrativeCanonBundle {
  schema_version: typeof SCHEMA_VERSION;
  bundle_id: string;
  project_id: string;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  entities: NarrativeEntity[];
  evidence: EvidenceAnchor[];
  assertions: NarrativeAssertion[];
  events: NarrativeEvent[];
  knowledge: CharacterKnowledge[];
  relationships: NarrativeRelationship[];
  foreshadowing: Foreshadow[];
}

// ---------------------------------------------------------------------------
// Gate 3A voice corpus, profiles and Style Constitution
// ---------------------------------------------------------------------------

export type VoiceScope = 'author' | 'project' | 'character' | 'scene';
export type VoiceSourceCategory = 'author-owned' | 'licensed-reference' | 'synthetic';
export type VoiceSourceStatus = 'active' | 'revoked' | 'deleted';
export type VoiceRuleStatus = 'observation' | 'proposal' | 'approved' | 'revoked' | 'stale';
export type VoiceIntent = 'retain' | 'prefer' | 'avoid' | 'explore';
export type VoiceConfidence = 'insufficient' | 'exploratory' | 'stable';

export interface VoicePermissions {
  local_analysis: boolean;
  quote_display: boolean;
  sample_storage: boolean;
  cross_project_reuse: boolean;
  external_send: boolean;
  public_release: boolean;
}

export interface VoiceSourceChapterRef {
  chapter_id: string;
  revision_id: string;
  content_hash: string;
}

export interface VoiceCorpusSource {
  source_id: string;
  project_id: string;
  scope: VoiceScope;
  scope_ref: string | null;
  category: VoiceSourceCategory;
  name: string;
  description: string;
  rights_statement: string;
  permissions: VoicePermissions;
  chapters: VoiceSourceChapterRef[];
  encoding: string;
  registered_at: IsoDateTime;
  updated_at: IsoDateTime;
  status: VoiceSourceStatus;
  revoked_at: IsoDateTime | null;
  revoke_reason: string | null;
}

export interface VoiceCorpusRegistry {
  schema_version: typeof SCHEMA_VERSION;
  project_id: string;
  version: number;
  updated_at: IsoDateTime;
  sources: VoiceCorpusSource[];
}

export interface VoiceMetric {
  metric_id: string;
  label: string;
  method: string;
  unit: string;
  value: number | string | Record<string, number>;
  sample_size: number;
  confidence: VoiceConfidence;
  caveat: string;
  evidence_anchor_ids: string[];
}

export interface VoiceCharacterProfile {
  character_id: string;
  character_name: string;
  dialogue_samples: number;
  metrics: VoiceMetric[];
  unknown_attribution_count: number;
}

export interface VoiceProfile {
  schema_version: typeof SCHEMA_VERSION;
  profile_id: string;
  project_id: string;
  scope: VoiceScope;
  scope_ref: string | null;
  algorithm_version: string;
  source_ids: string[];
  source_versions: Record<string, string>;
  status: ProjectionLifecycleStatus;
  generated_at: IsoDateTime;
  source_char_count: number;
  chapter_count: number;
  dialogue_samples: number;
  unknown_dialogue_count: number;
  metrics: VoiceMetric[];
  characters: VoiceCharacterProfile[];
  evidence: EvidenceAnchor[];
  stale_reason: string | null;
}

export interface StyleRulePrevious {
  version: number;
  text: string;
  intent: VoiceIntent;
  status: VoiceRuleStatus;
}

export interface StyleRule {
  rule_id: string;
  scope: VoiceScope;
  scope_ref: string | null;
  intent: VoiceIntent;
  text: string;
  conditions: string;
  source_ids: string[];
  evidence_anchor_ids: string[];
  status: VoiceRuleStatus;
  version: number;
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  approved_at: IsoDateTime | null;
  approved_by: string | null;
  supersedes: string | null;
  previous: StyleRulePrevious | null;
  note: string | null;
}

export interface StyleConstitution {
  schema_version: typeof SCHEMA_VERSION;
  project_id: string;
  version: number;
  updated_at: IsoDateTime;
  rules: StyleRule[];
}

// ---------------------------------------------------------------------------
// Gate 3C Co-Evolution (author-controlled preference learning and growth)
// ---------------------------------------------------------------------------

export interface CoevolutionConsent {
  store_feedback: boolean;
  local_strategy_learning: boolean;
  show_coaching: boolean;
  cross_project_reuse: boolean;
  external_send: false;
}

export type CoevolutionDecision = 'accepted_intent' | 'rejected' | 'skipped' | 'modified' | 'applied_verified';
export type CoevolutionPolicyStatus = 'draft' | 'evaluated' | 'active' | 'frozen' | 'revoked' | 'stale';

export interface PreferenceObservation {
  observation_id: string;
  project_id: string;
  chapter_id: string;
  revision_id: string;
  content_hash: string;
  proposal_id: string;
  hunk_id: string;
  scope: VoiceScope;
  scope_ref: string | null;
  decision: CoevolutionDecision;
  proposal_source: string;
  proposal_status: string;
  hunk_decision: string;
  modified_evidence: boolean;
  reason_code: string;
  feedback_key: string;
  source_consent_version: number;
  created_at: IsoDateTime;
  revoked: boolean;
  revoked_at: IsoDateTime | null;
  revoke_reason: string | null;
}

export interface CoevolutionPolicyDependency {
  chapter_id: string;
  revision_id: string;
  content_hash: string;
}

export interface PreferencePolicyVersion {
  policy_id: string;
  project_id: string;
  scope: VoiceScope;
  scope_ref: string | null;
  text: string;
  status: CoevolutionPolicyStatus;
  version: number;
  parent_version: number | null;
  source_observation_ids: string[];
  source_hypothesis_id: string | null;
  consent_snapshot: CoevolutionConsent;
  dependencies: CoevolutionPolicyDependency[];
  created_at: IsoDateTime;
  updated_at: IsoDateTime;
  approved_at: IsoDateTime | null;
  approved_by: string | null;
  freeze_reason: string | null;
}

export interface GrowthGoal {
  goal_id: string;
  project_id: string;
  skill: string;
  note: string;
  status: 'active' | 'paused' | 'achieved' | 'archived';
  created_at: IsoDateTime;
}

export interface GrowthReflection {
  reflection_id: string;
  project_id: string;
  goal_id: string | null;
  prompt: string;
  note: string;
  created_at: IsoDateTime;
}

export interface GrowthExerciseAttempt {
  attempt_id: string;
  project_id: string;
  exercise_id: string;
  status: 'started' | 'completed' | 'deferred';
  note: string;
  created_at: IsoDateTime;
}

export interface CoevolutionState {
  schema_version: typeof SCHEMA_VERSION;
  project_id: string;
  version: number;
  updated_at: IsoDateTime;
  consent: CoevolutionConsent;
  observations: PreferenceObservation[];
  policies: PreferencePolicyVersion[];
  goals: GrowthGoal[];
  reflections: GrowthReflection[];
  exercises: GrowthExerciseAttempt[];
}

// Gate 4 planning and genre objects. Author-owned; plans do not write canon.
export interface StoryIdea {
  idea_id: string;
  project_id: string;
  title: string;
  premise: string;
  theme: string;
  protagonist_goal: string;
  conflict: string;
  genre_ids: string[];
  forbidden: string[];
  reader_expectation: string;
  status: 'draft' | 'saved';
  created_at: IsoDateTime;
}

export interface StoryScenePlan {
  plan_id: string;
  project_id: string;
  volume: number;
  chapter: number;
  scene: number;
  title: string;
  goal: string;
  pov_entity_id: string | null;
  location: string;
  cast: string[];
  cause: string;
  action: string;
  result: string;
  suspense: string;
  risk: string;
  approval_state: 'draft' | 'proposed' | 'author-approved' | 'stale';
  base_chapter_revision: string | null;
  base_chapter_hash: string | null;
  genre_ids: string[];
  created_at: IsoDateTime;
}

export interface StoryBranch {
  branch_id: string;
  project_id: string;
  plan_id: string | null;
  title: string;
  premise: string;
  short_term_cost: string;
  motivation: string;
  conflict: string;
  irreversible_cost: string;
  evidence_refs: string[];
  risk: string;
  status: 'proposed' | 'selected' | 'rejected' | 'stale';
  created_at: IsoDateTime;
}

export interface GenrePack {
  genre_id: string;
  name: string;
  version: number;
  kind: 'builtin';
  reader_expectations: string[];
  beat_suggestions: string[];
  conflict_engines: string[];
  taboos: string[];
  exceptions: string[];
  dialogue_preferences: string[];
  pacing_preferences: string[];
  source: 'synthetic-abstract';
}

export interface GenreSelection {
  selection_id: string;
  project_id: string;
  genre_ids: string[];
  source: 'author';
  created_at: IsoDateTime;
}

export interface AuthorForbiddenRule {
  rule_id: string;
  project_id: string;
  text: string;
  scope: 'project' | 'chapter' | 'plan';
  chapter_id: string | null;
  plan_id: string | null;
  source: 'author-explicit';
  approved: boolean;
  created_at: IsoDateTime;
}
export interface PlanningState {
  schema_version: typeof SCHEMA_VERSION;
  project_id: string;
  version: number;
  ideas: StoryIdea[];
  plans: StoryScenePlan[];
  branches: StoryBranch[];
  genre_selections: GenreSelection[];
  forbidden_rules: AuthorForbiddenRule[];
}
