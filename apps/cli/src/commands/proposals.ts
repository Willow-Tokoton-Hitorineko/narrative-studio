import { InvalidArgumentError, type Actor } from '@narrative-studio/contracts';
import {
  approveProposal,
  createProposal,
  listProposals,
  rejectProposal,
} from '@narrative-studio/core';
import { rebuildProjection } from '@narrative-studio/projection';
import type { CliContext } from '../context.js';
import { readContent } from '../content.js';
import { flagString, requireFlag, type ParsedArgs } from '../flags.js';
import type { CommandResult } from './types.js';

export function commandProposal(args: ParsedArgs, context: CliContext): CommandResult {
  const subcommand = args.subcommand;
  const vaultDir = requireFlag(args, 'vault');

  if (subcommand === 'add') {
    const chapterId = requireFlag(args, 'chapter', 'chapter id');
    const proposal = createProposal({
      vaultDir,
      projectId: context.projectId,
      chapterId,
      content: readContent(args),
      origin: 'model',
      note: flagString(args, 'note'),
      actor: { kind: 'agent', id: flagString(args, 'actor') ?? 'local-agent' },
      logger: context.logger,
      now: context.now,
    });
    return {
      data: { ...proposal },
      human: [
        `Proposal ${proposal.proposal_id} recorded for ${chapterId} at ${proposal.base_revision}.`,
        'It is NOT authoritative until you run: ns proposal approve --id <id>',
      ],
    };
  }

  if (subcommand === 'list') {
    const proposals = listProposals(vaultDir, context.projectId);
    return {
      data: { proposals },
      human:
        proposals.length === 0
          ? ['No proposals.']
          : proposals.map(
              (proposal) =>
                `${proposal.proposal_id}  ${proposal.status.padEnd(9)}  ${proposal.chapter_id}  base ${proposal.base_revision}`,
            ),
    };
  }

  if (subcommand === 'approve') {
    const proposalId = requireFlag(args, 'id', 'proposal id');
    const actor: Actor = { kind: 'author', id: flagString(args, 'actor') ?? 'local-author' };
    const result = approveProposal({
      vaultDir,
      projectId: context.projectId,
      proposalId,
      actor,
      note: flagString(args, 'note'),
      logger: context.logger,
      now: context.now,
    });
    let projection: { ok: boolean; error?: string } = { ok: false };
    try {
      rebuildProjection({
        vaultDir,
        projectId: result.write.manifest.project_id,
        appDataRoot: context.appDataRoot,
        logger: context.logger,
        now: context.now,
      });
      projection = { ok: true };
    } catch (error) {
      projection = { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
    return {
      data: {
        proposal_id: result.proposal.proposal_id,
        status: result.proposal.status,
        approval_id: result.approval.approval_id,
        revision_id: result.write.revision.revision_id,
        manifest_revision: result.write.manifest.revision,
        projection,
      },
      human: [
        `Approved proposal ${result.proposal.proposal_id}.`,
        `Recorded approval ${result.approval.approval_id} and committed ${result.write.revision.revision_id}.`,
        `Manifest is now ${result.write.manifest.revision}.`,
      ],
    };
  }

  if (subcommand === 'reject') {
    const proposalId = requireFlag(args, 'id', 'proposal id');
    const proposal = rejectProposal({
      vaultDir,
      projectId: context.projectId,
      proposalId,
      actor: { kind: 'author', id: flagString(args, 'actor') ?? 'local-author' },
      reason: flagString(args, 'reason'),
      now: context.now,
    });
    return {
      data: { ...proposal },
      human: [`Rejected proposal ${proposal.proposal_id}. The manuscript was not changed.`],
    };
  }

  throw new InvalidArgumentError('Usage: ns proposal add|list|approve|reject …');
}
