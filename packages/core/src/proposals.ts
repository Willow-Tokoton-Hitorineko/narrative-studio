/**
 * Non-authoritative AI/agent proposals and the human approval gate.
 *
 * A proposal is a suggested chapter text plus its base revision. It lives in
 * `.story/proposals/` and never enters the manifest until an author approves
 * it. Approving records a durable `Approval` receipt (its own operation) and
 * then commits the chapter through the same Story Core transaction engine used
 * by human edits. No model or plugin can self-approve (ADR-044-03).
 */

import path from 'node:path';
import {
  CasMismatchError,
  CorruptionError,
  InvalidArgumentError,
  NotFoundError,
  SCHEMA_VERSION,
  UnauthorizedError,
  approvalIdFor,
  assertContract,
  contentDigest,
  decodeUtf8Strict,
  encodeUtf8,
  newProposalId,
  operationIdFor,
  type Actor,
  type Approval,
  type Operation,
  type Proposal,
  type RevisionOrigin,
} from '@narrative-studio/contracts';
import { APPROVALS_REL_PATH, PROPOSALS_DIR } from './constants.js';
import {
  ensureDir,
  listDirectory,
  pathExists,
  readFileBytes,
  writeFileAtomic,
} from './fsx.js';
import { jsonBytes } from './json.js';
import { withProjectLock } from './lock.js';
import type { SanitizedLogger } from './logging.js';
import { readManifest } from './manifest.js';
import { assertSafeSegment, resolveInside, toNativePath } from './paths.js';
import { runTransaction } from './transaction.js';
import {
  commitChapter,
  openProject,
  type ChapterWriteResult,
  type OpenedProject,
} from './vault.js';

export interface CreateProposalOptions {
  vaultDir: string;
  projectId?: string | null;
  chapterId: string;
  content: Buffer;
  origin?: RevisionOrigin;
  note?: string | null;
  actor?: Actor;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface ProposalWithBody {
  proposal: Proposal;
  body: Buffer;
  projectDir: string;
}

function proposalMetaRel(proposalId: string): string {
  assertSafeSegment(proposalId, 'proposal id');
  return `${PROPOSALS_DIR}/${proposalId}.json`;
}

function proposalBodyRel(proposalId: string): string {
  assertSafeSegment(proposalId, 'proposal id');
  return `${PROPOSALS_DIR}/${proposalId}.md`;
}

function readProposalFile(projectDir: string, proposalId: string): Proposal {
  const target = resolveInside(projectDir, proposalMetaRel(proposalId), 'proposal metadata');
  const bytes = readFileBytes(target);
  if (bytes === null) throw new NotFoundError(`Proposal ${proposalId}`);
  return assertContract<Proposal>('proposal', JSON.parse(bytes.toString('utf8')) as unknown);
}

function writeProposalFile(projectDir: string, proposal: Proposal): void {
  assertContract<Proposal>('proposal', proposal);
  writeFileAtomic(resolveInside(projectDir, proposalMetaRel(proposal.proposal_id), 'proposal metadata'), jsonBytes(proposal));
}

export function createProposal(options: CreateProposalOptions): Proposal {
  const now = options.now ?? (() => new Date());
  const opened = openProjectForProposal(options.vaultDir, options.projectId);
  const manifest = opened.manifest;
  const chapter = manifest.chapters[options.chapterId];
  if (!chapter) throw new NotFoundError(`Chapter ${options.chapterId}`);
  if (!options.content || options.content.length === 0) {
    throw new InvalidArgumentError('A proposal needs non-empty content');
  }
  const decoded = decodeUtf8Strict(options.content);
  const stored = encodeUtf8(decoded.text);
  const proposalId = newProposalId();
  const bodyRel = proposalBodyRel(proposalId);
  const createdAt = now().toISOString();
  const actor = options.actor ?? { kind: 'agent', id: 'local-agent' };

  // Write the body first; the metadata file is the commit marker of the proposal.
  ensureDir(toNativePath(opened.projectDir, PROPOSALS_DIR));
  writeFileAtomic(resolveInside(opened.projectDir, bodyRel, 'proposal body'), stored);

  const proposal: Proposal = assertContract<Proposal>('proposal', {
    schema_version: SCHEMA_VERSION,
    proposal_id: proposalId,
    project_id: manifest.project_id,
    chapter_id: options.chapterId,
    base_revision: manifest.revision,
    content_hash: contentDigest(stored),
    body_path: bodyRel,
    created_at: createdAt,
    origin: options.origin ?? 'model',
    status: 'proposed',
    note: options.note ?? null,
    provenance: {
      source: options.origin === 'author' ? 'author' : 'model',
      actor_id: actor.id,
      tool: 'ns-cli',
    },
    decided_at: null,
    decided_by: null,
  });
  writeProposalFile(opened.projectDir, proposal);
  options.logger?.info('proposal.created', {
    proposal_id: proposalId,
    chapter_id: options.chapterId,
    base_revision: proposal.base_revision,
  });
  return proposal;
}

function openProjectForProposal(
  vaultDir: string,
  projectId: string | null | undefined,
): OpenedProject {
  return openProject(vaultDir, projectId);
}

export function listProposals(vaultDir: string, projectId?: string | null): Proposal[] {
  const opened = openProjectForProposal(vaultDir, projectId);
  return readProposalsFromProject(opened.projectDir);
}

export function readProposalsFromProject(projectDir: string): Proposal[] {
  const directory = resolveInside(projectDir, PROPOSALS_DIR, 'proposals directory');
  const proposals: Proposal[] = [];
  for (const entry of listDirectory(directory)) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const target = path.join(directory, entry.name);
    proposals.push(
      assertContract<Proposal>(
        'proposal',
        JSON.parse(readFileBytes(target)?.toString('utf8') ?? '{}') as unknown,
      ),
    );
  }
  proposals.sort((a, b) => (a.created_at < b.created_at ? -1 : 1));
  return proposals;
}

export function readProposal(vaultDir: string, proposalId: string, projectId?: string | null): ProposalWithBody {
  const opened = openProjectForProposal(vaultDir, projectId);
  const proposal = readProposalFile(opened.projectDir, proposalId);
  const body = readFileBytes(resolveInside(opened.projectDir, proposal.body_path, 'proposal body'));
  if (body === null) throw new CorruptionError('Proposal body is missing', { proposalId });
  return { proposal, body, projectDir: opened.projectDir };
}

function markProposalStatus(
  projectDir: string,
  proposal: Proposal,
  status: Proposal['status'],
  actor: Actor | null,
  now: () => Date,
): Proposal {
  const updated: Proposal = {
    ...proposal,
    status,
    decided_at: now().toISOString(),
    decided_by: actor,
  };
  writeProposalFile(projectDir, updated);
  return updated;
}

export interface ApproveProposalOptions {
  vaultDir: string;
  projectId?: string | null;
  proposalId: string;
  actor?: Actor;
  note?: string | null;
  logger?: SanitizedLogger | null;
  now?: () => Date;
}

export interface ApproveProposalResult {
  proposal: Proposal;
  approval: Approval;
  write: ChapterWriteResult;
}

/**
 * Author approval: records a receipt in its own durable operation, then applies
 * the proposal against the exact revision that receipt was scoped to. Two
 * transactions are used so a crash between them leaves an unused receipt (safe)
 * rather than an applied edit without an audit trail.
 */
export function approveProposal(options: ApproveProposalOptions): ApproveProposalResult {
  const now = options.now ?? (() => new Date());
  const actor: Actor = options.actor ?? { kind: 'author', id: 'local-author' };
  if (actor.kind !== 'author') {
    throw new UnauthorizedError('Only the author can approve a proposal', { actor });
  }
  const opened = openProjectForProposal(options.vaultDir, options.projectId);

  return withProjectLock(opened.projectDir, (): ApproveProposalResult => {
    const manifest = readManifest(opened.projectDir);
    const proposal = readProposalFile(opened.projectDir, options.proposalId);
    if (proposal.status !== 'proposed') {
      throw new InvalidArgumentError(`Proposal is ${proposal.status}, not proposed`, {
        proposalId: proposal.proposal_id,
      });
    }
    if (proposal.base_revision !== manifest.revision) {
      markProposalStatus(opened.projectDir, proposal, 'stale', actor, now);
      throw new CasMismatchError(proposal.base_revision, manifest.revision, {
        proposalId: proposal.proposal_id,
        hint: 'The chapter changed since this proposal was created; ask for a new proposal',
      });
    }
    const body = readFileBytes(resolveInside(opened.projectDir, proposal.body_path, 'proposal body'));
    if (body === null) throw new CorruptionError('Proposal body is missing', { proposalId: proposal.proposal_id });
    if (contentDigest(body) !== proposal.content_hash) {
      throw new CorruptionError('Proposal body no longer matches its recorded hash', {
        proposalId: proposal.proposal_id,
      });
    }

    const approvalSeq = manifest.seq + 1;
    const approvalId = approvalIdFor(approvalSeq, proposal.content_hash);
    const approval: Approval = assertContract<Approval>('approval', {
      schema_version: SCHEMA_VERSION,
      approval_id: approvalId,
      project_id: manifest.project_id,
      created_at: now().toISOString(),
      actor,
      action: 'commit_chapter',
      scope: {
        chapter_id: proposal.chapter_id,
        content_hash: proposal.content_hash,
        proposal_id: proposal.proposal_id,
      },
      decision: 'approved',
      note: options.note ?? null,
      provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
      status: 'active',
    });

    const approvalsTarget = resolveInside(opened.projectDir, APPROVALS_REL_PATH, 'approvals log');
    const existingApprovals = readFileBytes(approvalsTarget);
    const approvalLine = Buffer.from(`${JSON.stringify(approval)}\n`, 'utf8');
    const nextApprovals = Buffer.concat([existingApprovals ?? Buffer.alloc(0), approvalLine]);
    const createdAt = now().toISOString();

    const approvalTxn = runTransaction({
      projectDir: opened.projectDir,
      projectId: manifest.project_id,
      baseRevision: manifest.revision,
      files: [
        {
          relPath: APPROVALS_REL_PATH,
          bytes: nextApprovals,
          mode: existingApprovals === null ? 'create' : 'replace',
        },
      ],
      chapters: manifest.chapters,
      headRevision: manifest.head_revision,
      title: opened.project.title,
      logger: options.logger ?? null,
      now,
      buildOperation: (resultRevision): Operation => ({
        schema_version: SCHEMA_VERSION,
        operation_id: operationIdFor(approvalSeq, resultRevision),
        seq: approvalSeq,
        project_id: manifest.project_id,
        type: 'approval.record',
        created_at: createdAt,
        actor,
        base_revision: manifest.revision,
        result_revision: resultRevision,
        payload: {
          approval_id: approvalId,
          proposal_id: proposal.proposal_id,
          chapter_id: proposal.chapter_id,
          content_hash: proposal.content_hash,
        },
        approval_id: approvalId,
        provenance: { source: 'author', actor_id: actor.id, tool: 'ns-cli' },
        status: 'committed',
      }),
    });

    const write = commitChapter({
      vaultDir: options.vaultDir,
      projectId: manifest.project_id,
      chapterId: proposal.chapter_id,
      content: body,
      message: options.note ?? `Approved proposal ${proposal.proposal_id}`,
      actor,
      origin: 'author',
      approvalId,
      baseRevision: approvalTxn.manifest.revision,
      logger: options.logger ?? null,
      now,
    });

    const updated = markProposalStatus(opened.projectDir, proposal, 'approved', actor, now);
    return { proposal: updated, approval, write };
  });
}

export interface RejectProposalOptions {
  vaultDir: string;
  projectId?: string | null;
  proposalId: string;
  actor?: Actor;
  reason?: string | null;
  now?: () => Date;
}

export function rejectProposal(options: RejectProposalOptions): Proposal {
  const now = options.now ?? (() => new Date());
  const actor: Actor = options.actor ?? { kind: 'author', id: 'local-author' };
  if (actor.kind !== 'author') {
    throw new UnauthorizedError('Only the author can reject a proposal', { actor });
  }
  const opened = openProjectForProposal(options.vaultDir, options.projectId);
  return withProjectLock(opened.projectDir, () => {
    const proposal = readProposalFile(opened.projectDir, options.proposalId);
    if (proposal.status !== 'proposed') {
      throw new InvalidArgumentError(`Proposal is ${proposal.status}, not proposed`);
    }
    return markProposalStatus(opened.projectDir, proposal, 'rejected', actor, now);
  });
}

export function proposalsDirectoryExists(projectDir: string): boolean {
  return pathExists(toNativePath(projectDir, PROPOSALS_DIR));
}
