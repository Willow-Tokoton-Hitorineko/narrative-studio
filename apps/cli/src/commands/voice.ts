import {
  analyzeVoice,
  approveVoiceProposal,
  deleteVoiceSource,
  readVoiceOverview,
  registerVoiceSource,
  revokeStyleRule,
  revokeVoiceSource,
  rollbackStyleRule,
  type RegisterVoiceSourceInput,
} from '@narrative-studio/voice';
import { requireVault } from '../context.js';
import type { CommandResult } from './types.js';
import type { CliContext } from '../context.js';
import type { ParsedArgs } from '../flags.js';

function permissions(value: string | undefined): RegisterVoiceSourceInput['permissions'] {
  const selected = new Set((value ?? 'local_analysis,quote_display').split(',').map((item) => item.trim()));
  return {
    local_analysis: selected.has('local_analysis'),
    quote_display: selected.has('quote_display'),
    sample_storage: selected.has('sample_storage'),
    cross_project_reuse: selected.has('cross_project_reuse'),
    external_send: selected.has('external_send'),
    public_release: selected.has('public_release'),
  };
}

export function commandVoice(args: ParsedArgs, context: CliContext): CommandResult {
  const vaultDir = requireVault(context);
  const appDataRoot = context.appDataRoot;
  const action = args.positionals[1] ?? 'status';
  const projectId = context.projectId;

  if (action === 'status') {
    const voice = readVoiceOverview({ vaultDir, projectId, appDataRoot });
    return {
      data: { voice },
      human: [
        `Voice Forge status: ${voice.status}; sources ${voice.sources.length}; profiles ${voice.profiles.length}; proposals ${voice.proposals.length}; approved rules ${voice.rules.filter((rule) => rule.status === 'approved').length}.`,
        voice.generated_at ? `Last analysis: ${voice.generated_at}` : 'Not analyzed yet.',
      ],
    };
  }

  if (action === 'analyze') {
    const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
    return {
      data: { voice },
      human: [
        `Analyzed ${voice.sources.length} source(s); status ${voice.status}.`,
        `Profiles ${voice.profiles.length}, proposals ${voice.proposals.length}.`,
      ],
    };
  }

  if (action === 'source-add') {
    const name = String(args.flags.name ?? '').trim();
    const rights = String(args.flags.rights ?? '').trim();
    if (!name || !rights) throw new Error('voice source-add requires --name and --rights');
    const scope = String(args.flags.scope ?? 'project') as RegisterVoiceSourceInput['scope'];
    const created = registerVoiceSource({
      vaultDir,
      projectId,
      input: {
        name,
        description: String(args.flags.description ?? ''),
        scope,
        scopeRef: args.flags['scope-ref'] ? String(args.flags['scope-ref']) : null,
        category: String(args.flags.category ?? 'synthetic') as RegisterVoiceSourceInput['category'],
        rightsStatement: rights,
        permissions: permissions(args.flags.permissions ? String(args.flags.permissions) : undefined),
        chapterIds: args.flags.chapter ? [String(args.flags.chapter)] : undefined,
      },
    });
    const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
    return {
      data: { source: created.source, voice },
      human: [`Registered ${created.source.name} (${created.source.source_id}); ${created.source.chapters.length} chapter reference(s).`, `Voice status: ${voice.status}.`],
    };
  }

  if (action === 'source-revoke') {
    const sourceId = String(args.flags.id ?? '');
    const reason = String(args.flags.reason ?? '');
    if (!sourceId || !reason) throw new Error('voice source-revoke requires --id and --reason');
    revokeVoiceSource({ vaultDir, projectId, appDataRoot, sourceId, reason });
    const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
    return { data: { voice }, human: [`Revoked ${sourceId}; dependent profile status is ${voice.status}.`] };
  }

  if (action === 'source-delete') {
    const sourceId = String(args.flags.id ?? '');
    const reason = String(args.flags.reason ?? '');
    if (!sourceId || !reason) throw new Error('voice source-delete requires --id and --reason');
    deleteVoiceSource({ vaultDir, projectId, appDataRoot, sourceId, reason });
    const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
    return { data: { voice }, human: [`Marked ${sourceId} deleted (audit tombstone retained; Vault chapters untouched).`] };
  }
  if (action === 'approve') {
    const proposalId = String(args.flags.id ?? '');
    if (!proposalId) throw new Error('voice approve requires --id');
    const approved = approveVoiceProposal({ vaultDir, projectId, appDataRoot, proposalId, note: args.flags.note ? String(args.flags.note) : undefined });
    return { data: { rule: approved.rule }, human: [`Approved rule ${approved.rule.rule_id} version ${approved.rule.version}.`] };
  }

  if (action === 'rule-revoke') {
    const ruleId = String(args.flags.id ?? '');
    const reason = String(args.flags.reason ?? '');
    if (!ruleId || !reason) throw new Error('voice rule-revoke requires --id and --reason');
    const revoked = revokeStyleRule({ vaultDir, projectId, ruleId, reason });
    return { data: { rule: revoked.rule }, human: [`Revoked rule ${ruleId} at version ${revoked.rule.version}.`] };
  }

  if (action === 'rule-rollback') {
    const ruleId = String(args.flags.id ?? '');
    if (!ruleId) throw new Error('voice rule-rollback requires --id');
    const rolled = rollbackStyleRule({ vaultDir, projectId, ruleId });
    return { data: { rule: rolled.rule }, human: [`Rolled back rule ${ruleId} to version ${rolled.rule.version}.`] };
  }

  throw new Error(`unknown voice action: ${action}`);
}
