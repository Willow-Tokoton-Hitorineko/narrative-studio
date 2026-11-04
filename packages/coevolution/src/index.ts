/**
 * Gate 3C Co-Evolution Loop.
 * Author-owned observations/policies/goals live in the Vault. Derived hypotheses
 * and aggregates live in a disposable SQLite projection. No model weights, no
 * manuscript writes, and no automatic policy promotion.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  SCHEMA_VERSION,
  contentDigest,
  type CoevolutionConsent,
  type CoevolutionPolicyStatus,
  type CoevolutionState,
  type GrowthExerciseAttempt,
  type GrowthGoal,
  type GrowthReflection,
  type PreferenceObservation,
  type PreferencePolicyVersion,
  type VoiceScope,
} from '@narrative-studio/contracts';
import {
  openProject,
  readCoevolutionState,
  resolveAppDataRoot,
  writeCoevolutionState,
} from '@narrative-studio/core';

export type FeedbackDecision = 'accepted_intent' | 'rejected' | 'skipped' | 'modified' | 'applied_verified';

const DEFAULT_CONSENT: CoevolutionConsent = {
  store_feedback: false,
  local_strategy_learning: false,
  show_coaching: false,
  cross_project_reuse: false,
  external_send: false,
};

function id(prefix: string, text: string): string {
  return `${prefix}_${contentDigest(Buffer.from(text, 'utf8')).slice(7, 27)}`;
}

function defaultState(projectId: string): CoevolutionState {
  return {
    schema_version: SCHEMA_VERSION,
    project_id: projectId,
    version: 0,
    updated_at: new Date().toISOString(),
    consent: { ...DEFAULT_CONSENT },
    observations: [],
    policies: [],
    goals: [],
    reflections: [],
    exercises: [],
  };
}

function stateFor(projectDir: string, projectId: string): CoevolutionState {
  return readCoevolutionState(projectDir) ?? defaultState(projectId);
}

function writeState(vaultDir: string, projectId: string, state: CoevolutionState): CoevolutionState {
  return writeCoevolutionState({
    vaultDir,
    projectId,
    value: { ...state, version: state.version + 1 },
    actor: { kind: 'author', id: 'local-author' },
  }).value;
}

export function readConsent(vaultDir: string, projectId?: string | null): CoevolutionConsent {
  const opened = openProject(vaultDir, projectId ?? undefined);
  return stateFor(opened.projectDir, opened.project.project_id).consent;
}

export function setConsent(options: {
  vaultDir: string;
  projectId?: string | null;
  consent: Partial<CoevolutionConsent>;
}): CoevolutionState {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  return writeState(options.vaultDir, opened.project.project_id, {
    ...state,
    consent: {
      ...state.consent,
      ...options.consent,
      external_send: false,
      cross_project_reuse: options.consent.cross_project_reuse === true,
    },
  });
}

export interface TrustedProposal {
  proposal_id: string;
  project_id: string;
  chapter_id: string;
  base_revision: string;
  base_hash: string;
  status: string;
  source: string;
  source_label: string;
  risks: Array<{ severity: string }>;
  hunks: Array<{ hunk_id: string; decision: 'pending' | 'accept' | 'reject'; replacement: string; old_text: string; start: number; end: number }>;
}

export function recordFeedback(options: {
  vaultDir: string;
  projectId?: string | null;
  proposal: TrustedProposal;
  hunkId: string;
  modifiedText?: string | null;
  reasonCode?: string;
}): PreferenceObservation {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  if (!state.consent.store_feedback || !state.consent.local_strategy_learning) {
    throw new Error('CONSENT_REQUIRED: explicit store_feedback and local_strategy_learning consent are required');
  }
  const proposal = options.proposal;
  if (proposal.project_id !== opened.project.project_id) throw new Error('CROSS_PROJECT_PROPOSAL');
  if (proposal.chapter_id !== proposal.chapter_id) throw new Error('INVALID_PROPOSAL');
  const entry = opened.manifest.chapters[proposal.chapter_id];
  if (!entry) throw new Error('PROPOSAL_CHAPTER_NOT_FOUND');
  if (entry.current_revision_id !== proposal.base_revision || entry.content_hash !== proposal.base_hash) {
    throw new Error('STALE_FEEDBACK: current chapter no longer matches proposal base revision/hash');
  }
  const hunk = proposal.hunks.find((item) => item.hunk_id === options.hunkId);
  if (!hunk) throw new Error('HUNK_NOT_IN_PROPOSAL');
  if (hunk.decision === 'pending') throw new Error('PENDING_HUNK: pending hunks are not author feedback');
  if (hunk.decision === 'accept' && proposal.risks.some((risk) => risk.severity === 'blocking')) {
    throw new Error('BLOCKING_PROPOSAL: blocking hunks cannot be recorded as accepted');
  }
  const modified = hunk.decision === 'accept' && typeof options.modifiedText === 'string' && options.modifiedText.trim().length > 0 && options.modifiedText !== hunk.replacement;
  const decision: FeedbackDecision = modified ? 'modified' : hunk.decision === 'accept' ? 'accepted_intent' : 'rejected';
  const feedbackKey = id('fbk', `${proposal.proposal_id}:${hunk.hunk_id}:${decision}:${proposal.chapter_id}`);
  if (state.observations.some((item) => item.feedback_key === feedbackKey && !item.revoked)) {
    throw new Error('DUPLICATE_FEEDBACK: this hunk decision was already recorded');
  }
  const observation: PreferenceObservation = {
    observation_id: id('obs', `${feedbackKey}:${Date.now()}`),
    project_id: opened.project.project_id,
    chapter_id: proposal.chapter_id,
    revision_id: proposal.base_revision,
    content_hash: proposal.base_hash,
    proposal_id: proposal.proposal_id,
    hunk_id: hunk.hunk_id,
    scope: 'project',
    scope_ref: null,
    decision,
    proposal_source: proposal.source,
    proposal_status: proposal.status,
    hunk_decision: hunk.decision,
    modified_evidence: modified,
    reason_code: (options.reasonCode ?? 'unspecified').slice(0, 100),
    feedback_key: feedbackKey,
    source_consent_version: state.version,
    created_at: new Date().toISOString(),
    revoked: false,
    revoked_at: null,
    revoke_reason: null,
  };
  writeState(options.vaultDir, opened.project.project_id, { ...state, observations: [...state.observations, observation] });
  return observation;
}

export function revokeObservation(options: {
  vaultDir: string;
  projectId?: string | null;
  observationId: string;
  reason: string;
}): CoevolutionState {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const now = new Date().toISOString();
  return writeState(options.vaultDir, opened.project.project_id, {
    ...state,
    observations: state.observations.map((item) => item.observation_id === options.observationId
      ? { ...item, revoked: true, revoked_at: now, revoke_reason: options.reason } : item),
  });
}

export interface PreferenceHypothesis {
  hypothesis_id: string;
  project_id: string;
  scope: VoiceScope;
  scope_ref: string | null;
  text: string;
  scope_label: string;
  sample_ids: string[];
  positive: number;
  negative: number;
  effective_samples: number;
  algorithm_version: string;
  uncertainty: string;
  status: 'proposed' | 'approved' | 'rejected' | 'stale';
}

export function deriveHypotheses(
  state: CoevolutionState,
  currentRevisions: Map<string, { revisionId: string; contentHash: string }> = new Map(),
): PreferenceHypothesis[] {
  if (!state.consent.local_strategy_learning) return [];
  const active = state.observations.filter((item) => !item.revoked
    && item.decision !== 'skipped'
    && item.decision !== 'applied_verified'
    && (!currentRevisions.size || (() => {
      const current = currentRevisions.get(item.chapter_id);
      return Boolean(current && current.revisionId === item.revision_id && current.contentHash === item.content_hash);
    })()));
  const groups = new Map<string, Map<string, PreferenceObservation>>();
  for (const item of active) {
    const key = `${item.scope}:${item.scope_ref ?? ''}`;
    const byProposal = groups.get(key) ?? new Map<string, PreferenceObservation>();
    if (!byProposal.has(item.proposal_id)) byProposal.set(item.proposal_id, item);
    groups.set(key, byProposal);
  }
  const out: PreferenceHypothesis[] = [];
  for (const [key, byProposal] of groups) {
    const samples = [...byProposal.values()];
    const positive = samples.filter((item) => item.decision === 'accepted_intent' || item.decision === 'modified').length;
    const negative = samples.filter((item) => item.decision === 'rejected').length;
    const effectiveSamples = positive + negative;
    if (effectiveSamples < 3 || positive <= negative) continue;
    const first = samples[0]!;
    const scopeLabel = first.scope_ref ? `${first.scope}:${first.scope_ref}` : first.scope;
    out.push({
      hypothesis_id: id('hyp', `${key}:${samples.map((item) => item.proposal_id).sort().join(':')}`),
      project_id: first.project_id,
      scope: first.scope,
      scope_ref: first.scope_ref,
      text: `在 ${scopeLabel} 范围，当前有效反馈更常接受该方向的编辑；仍需作者确认边界。`,
      scope_label: scopeLabel,
      sample_ids: samples.map((item) => item.observation_id),
      positive,
      negative,
      effective_samples: effectiveSamples,
      algorithm_version: 'coevolution.hypothesis.v2',
      uncertainty: '规则性观察，不是统计显著性结论；同一提案多 hunk 只计一次，样本量小，不能推广到其他作品或角色。',
      status: 'proposed',
    });
  }
  return out;
}
function policyDeps(state: CoevolutionState, observationIds: string[]): PreferencePolicyVersion['dependencies'] {
  return state.observations
    .filter((item) => observationIds.includes(item.observation_id) && !item.revoked)
    .map((item) => ({ chapter_id: item.chapter_id, revision_id: item.revision_id, content_hash: item.content_hash }));
}

export function activatePolicy(options: {
  vaultDir: string;
  projectId?: string | null;
  hypothesisId: string;
  text?: string;
}): PreferencePolicyVersion {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  if (!state.consent.local_strategy_learning) throw new Error('CONSENT_REQUIRED: local strategy learning is off');
  const currentRevisions = new Map(Object.entries(opened.manifest.chapters).map(([chapterId, entry]) => [chapterId, { revisionId: entry.current_revision_id, contentHash: entry.content_hash }]));
  const hypothesis = deriveHypotheses(state, currentRevisions).find((item) => item.hypothesis_id === options.hypothesisId);
  if (!hypothesis) throw new Error('HYPOTHESIS_NOT_FOUND_OR_STALE');
  const now = new Date().toISOString();
  const policy: PreferencePolicyVersion = {
    policy_id: id('policy', `${hypothesis.hypothesis_id}:${now}`),
    project_id: opened.project.project_id,
    scope: hypothesis.scope,
    scope_ref: hypothesis.scope_ref,
    text: (options.text ?? hypothesis.text).slice(0, 1000),
    status: 'active',
    version: 1,
    parent_version: null,
    source_observation_ids: hypothesis.sample_ids,
    source_hypothesis_id: hypothesis.hypothesis_id,
    consent_snapshot: state.consent,
    dependencies: policyDeps(state, hypothesis.sample_ids),
    created_at: now,
    updated_at: now,
    approved_at: now,
    approved_by: 'local-author',
    freeze_reason: null,
  };
  writeState(options.vaultDir, opened.project.project_id, { ...state, policies: [...state.policies, policy] });
  return policy;
}

function transitionPolicy(options: {
  vaultDir: string;
  projectId?: string | null;
  policyId: string;
  status: CoevolutionPolicyStatus;
  reason?: string;
}): PreferencePolicyVersion {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const prior = state.policies.find((item) => item.policy_id === options.policyId);
  if (!prior) throw new Error('POLICY_NOT_FOUND');
  const now = new Date().toISOString();
  const updated: PreferencePolicyVersion = {
    ...prior,
    status: options.status,
    version: prior.version + 1,
    updated_at: now,
    approved_at: options.status === 'active' ? now : prior.approved_at,
    freeze_reason: options.reason ?? prior.freeze_reason,
  };
  writeState(options.vaultDir, opened.project.project_id, {
    ...state,
    policies: state.policies.map((item) => item.policy_id === options.policyId ? updated : item),
  });
  return updated;
}

export function freezePolicy(options: { vaultDir: string; projectId?: string | null; policyId: string; reason: string }): PreferencePolicyVersion {
  return transitionPolicy({ ...options, status: 'frozen' });
}

export function revokePolicy(options: { vaultDir: string; projectId?: string | null; policyId: string; reason: string }): PreferencePolicyVersion {
  return transitionPolicy({ ...options, status: 'revoked' });
}

export function rollbackPolicy(options: { vaultDir: string; projectId?: string | null; policyId: string }): PreferencePolicyVersion {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const prior = state.policies.find((item) => item.policy_id === options.policyId);
  if (!prior) throw new Error('POLICY_NOT_FOUND');
  if (prior.status === 'revoked') throw new Error('REVOKED_POLICY_CANNOT_ROLLBACK: explicit new approval is required');
  return transitionPolicy({ ...options, status: 'active', reason: 'rollback/reactivate' });
}

export function addGoal(options: { vaultDir: string; projectId?: string | null; skill: string; note?: string }): GrowthGoal {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const goal: GrowthGoal = {
    goal_id: id('goal', `${options.skill}:${Date.now()}`), project_id: opened.project.project_id,
    skill: options.skill.slice(0, 100), note: (options.note ?? '').slice(0, 1000), status: 'active', created_at: new Date().toISOString(),
  };
  writeState(options.vaultDir, opened.project.project_id, { ...state, goals: [...state.goals, goal] });
  return goal;
}

export function addReflection(options: { vaultDir: string; projectId?: string | null; goalId?: string | null; prompt: string; note: string }): GrowthReflection {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const reflection: GrowthReflection = {
    reflection_id: id('reflection', `${options.prompt}:${Date.now()}`), project_id: opened.project.project_id,
    goal_id: options.goalId ?? null, prompt: options.prompt.slice(0, 200), note: options.note.slice(0, 2000), created_at: new Date().toISOString(),
  };
  writeState(options.vaultDir, opened.project.project_id, { ...state, reflections: [...state.reflections, reflection] });
  return reflection;
}

export function addExerciseAttempt(options: { vaultDir: string; projectId?: string | null; exerciseId: string; status: GrowthExerciseAttempt['status']; note?: string }): GrowthExerciseAttempt {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const attempt: GrowthExerciseAttempt = {
    attempt_id: id('exercise', `${options.exerciseId}:${Date.now()}`), project_id: opened.project.project_id,
    exercise_id: options.exerciseId.slice(0, 100), status: options.status, note: (options.note ?? '').slice(0, 1000), created_at: new Date().toISOString(),
  };
  writeState(options.vaultDir, opened.project.project_id, { ...state, exercises: [...state.exercises, attempt] });
  return attempt;
}

export interface PolicyContextItem {
  policy_id: string;
  version: number;
  scope: VoiceScope;
  scope_ref: string | null;
  text: string;
  status: 'active' | 'stale';
  reason: string | null;
}

export function coEvolutionPoliciesFor(options: {
  vaultDir: string;
  projectId?: string | null;
  chapterId: string;
  povEntityId?: string | null;
  sceneRef?: string | null;
}): { active: PolicyContextItem[]; excluded: PolicyContextItem[] } {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const entry = opened.manifest.chapters[options.chapterId];
  if (!entry) throw new Error('CHAPTER_NOT_FOUND');
  const active: PolicyContextItem[] = [];
  const excluded: PolicyContextItem[] = [];
  for (const policy of state.policies) {
    let reason: string | null = null;
    if (!state.consent.local_strategy_learning) reason = 'local strategy learning consent is off';
    else if (policy.status !== 'active') reason = `policy status ${policy.status}`;
    else if (policy.scope === 'character' && policy.scope_ref !== (options.povEntityId ?? null)) reason = 'character scope does not match POV';
    else if (policy.scope === 'scene' && policy.scope_ref !== (options.sceneRef ?? null)) reason = 'scene scope requires a matching trusted scene';
    else if (policy.dependencies.some((dep) => {
      const current = opened.manifest.chapters[dep.chapter_id];
      return !current || current.current_revision_id !== dep.revision_id || current.content_hash !== dep.content_hash;
    })) reason = 'dependency chapter revision/hash is stale';
    else if (policy.source_observation_ids.some((id) => {
      const observation = state.observations.find((item) => item.observation_id === id);
      return !observation || observation.revoked;
    })) reason = 'source observation revoked or missing';
    const item: PolicyContextItem = {
      policy_id: policy.policy_id, version: policy.version, scope: policy.scope, scope_ref: policy.scope_ref,
      text: policy.text, status: reason ? 'stale' : 'active', reason,
    };
    if (reason) excluded.push(item); else active.push(item);
  }
  return { active, excluded };
}

function dbPath(appDataRoot: string, projectId: string): string {
  return path.join(resolveAppDataRoot(appDataRoot), 'indexes', projectId, 'coevolution.sqlite');
}

export interface CoevolutionOverview {
  state: CoevolutionState;
  hypotheses: PreferenceHypothesis[];
  policies: Array<PreferencePolicyVersion & { effective_status: CoevolutionPolicyStatus; stale_reason: string | null }>;
  projection: { status: 'current' | 'stale'; path: string; hypotheses: number };
}

export function readCoevolutionOverview(options: { vaultDir: string; projectId?: string | null; appDataRoot?: string | null }): CoevolutionOverview {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  const state = stateFor(opened.projectDir, opened.project.project_id);
  const currentRevisions = new Map(Object.entries(opened.manifest.chapters).map(([chapterId, entry]) => [chapterId, { revisionId: entry.current_revision_id, contentHash: entry.content_hash }]));
  const hypotheses = deriveHypotheses(state, currentRevisions);
  const policies = state.policies.map((policy) => {
    let reason: string | null = null;
    if (policy.status !== 'active') reason = `policy status ${policy.status}`;
    else if (policy.dependencies.some((dep) => {
      const current = opened.manifest.chapters[dep.chapter_id];
      return !current || current.current_revision_id !== dep.revision_id || current.content_hash !== dep.content_hash;
    })) reason = 'dependency chapter revision/hash is stale';
    else if (policy.source_observation_ids.some((id) => !state.observations.find((item) => item.observation_id === id && !item.revoked))) reason = 'source observation revoked';
    return { ...policy, effective_status: reason ? 'stale' as const : policy.status, stale_reason: reason };
  });
  const database = dbPath(options.appDataRoot ?? '', opened.project.project_id);
  fs.mkdirSync(path.dirname(database), { recursive: true });
  const db = new DatabaseSync(database);
  try {
    db.exec('CREATE TABLE IF NOT EXISTS hypotheses (hypothesis_id TEXT PRIMARY KEY, json TEXT NOT NULL)');
    db.exec('DELETE FROM hypotheses');
    const insert = db.prepare('INSERT INTO hypotheses(hypothesis_id,json) VALUES (?,?)');
    for (const hypothesis of hypotheses) insert.run(hypothesis.hypothesis_id, JSON.stringify(hypothesis));
  } finally { db.close(); }
  return { state, hypotheses, policies, projection: { status: 'current', path: database, hypotheses: hypotheses.length } };
}

export function rebuildCoevolutionProjection(options: { vaultDir: string; projectId?: string | null; appDataRoot?: string | null }): CoevolutionOverview {
  const opened = openProject(options.vaultDir, options.projectId ?? undefined);
  fs.rmSync(dbPath(options.appDataRoot ?? '', opened.project.project_id), { force: true });
  return readCoevolutionOverview(options);
}
