import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { approveProposal } from '@narrative-studio/core';
import {
  addChapter,
  createWorkspace,
  fixture,
  initVault,
  okJson,
  projectDirOf,
  readJsonFile,
  runCli,
  type Workspace,
} from '../helpers/cli.js';

interface ChapterResult {
  chapter_id: string;
}

interface ManifestLike {
  revision: string;
  chapters: Record<string, { path: string; content_hash: string; current_revision_id: string }>;
}

interface ApprovalRecord {
  approval_id: string;
  actor: { kind: string };
  action: string;
  decision: string;
  scope: { chapter_id?: string; content_hash?: string; proposal_id?: string };
}

describe('one command path: model/agent writes require an author approval receipt', () => {
  let workspace: Workspace;
  let projectId: string;
  let projectDir: string;
  let chapterId: string;
  let proposedText: string;

  beforeAll(() => {
    workspace = createWorkspace({ label: 'ns-approval' });
    projectId = String(initVault(workspace).project_id);
    projectDir = projectDirOf(workspace, projectId);
    chapterId = (addChapter(workspace, { title: '第一章 潮声', file: fixture('chapter-01.md') }) as unknown as ChapterResult)
      .chapter_id;
    proposedText = fs.readFileSync(fixture('chapter-02.md'), 'utf8');
  });

  afterAll(() => {
    workspace?.cleanup();
  });

  function manifest(): ManifestLike {
    return readJsonFile<ManifestLike>(path.join(projectDir, '.story', 'manifest.json'));
  }

  it('rejects a model-origin commit without an approval receipt', () => {
    const before = manifest().revision;
    const result = runCli([
      'commit',
      '--vault',
      workspace.vault,
      '--appdata',
      workspace.appdata,
      '--chapter',
      chapterId,
      '--file',
      fixture('chapter-02.md'),
      '--origin',
      'model',
      '--actor',
      'some-model',
      '--json',
    ]);
    expect(result.status).toBe(8);
    expect(result.errorCode).toBe('UNAUTHORIZED');
    expect(manifest().revision).toBe(before);
  });

  it('rejects a forged approval id', () => {
    const result = runCli([
      'commit',
      '--vault',
      workspace.vault,
      '--appdata',
      workspace.appdata,
      '--chapter',
      chapterId,
      '--file',
      fixture('chapter-02.md'),
      '--origin',
      'model',
      '--approval',
      'apr_00000009_aaaaaaaaaaaa',
      '--json',
    ]);
    expect(result.status).toBe(8);
    expect(result.errorCode).toBe('UNAUTHORIZED');
  });

  it('records an AI proposal without changing the manuscript', () => {
    const before = manifest().revision;
    const proposal = okJson(
      runCli([
        'proposal',
        'add',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--chapter',
        chapterId,
        '--file',
        fixture('chapter-02.md'),
        '--note',
        'AI 建议：收紧开头',
        '--json',
      ]),
    ) as { proposal_id: string; status: string; base_revision: string };
    expect(proposal.status).toBe('proposed');
    expect(manifest().revision).toBe(before);
    const list = okJson(
      runCli(['proposal', 'list', '--vault', workspace.vault, '--appdata', workspace.appdata, '--json']),
    ) as { proposals: { proposal_id: string; status: string }[] };
    expect(list.proposals.some((item) => item.proposal_id === proposal.proposal_id && item.status === 'proposed')).toBe(
      true,
    );
  });

  it('approves a proposal: writes a receipt and commits the exact content', () => {
    const proposals = okJson(
      runCli(['proposal', 'list', '--vault', workspace.vault, '--appdata', workspace.appdata, '--json']),
    ) as { proposals: { proposal_id: string; status: string }[] };
    const pending = proposals.proposals.find((item) => item.status === 'proposed');
    expect(pending).toBeDefined();
    const result = okJson(
      runCli([
        'proposal',
        'approve',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--id',
        pending!.proposal_id,
        '--json',
      ]),
    ) as { approval_id: string; revision_id: string; status: string; manifest_revision: string };
    expect(result.status).toBe('approved');
    expect(result.approval_id).toMatch(/^apr_/);

    const current = manifest();
    const entry = current.chapters[chapterId];
    expect(entry?.current_revision_id).toBe(result.revision_id);
    expect(fs.readFileSync(path.join(projectDir, entry!.path), 'utf8')).toBe(proposedText);

    const approvals = fs
      .readFileSync(path.join(projectDir, '.story', 'approvals', 'approvals.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ApprovalRecord);
    const receipt = approvals.find((record) => record.approval_id === result.approval_id);
    expect(receipt?.actor.kind).toBe('author');
    expect(receipt?.decision).toBe('approved');
    expect(receipt?.scope.chapter_id).toBe(chapterId);
    expect(receipt?.scope.content_hash).toBe(entry?.content_hash);

    const verify = okJson(runCli(['verify', '--vault', workspace.vault, '--appdata', workspace.appdata, '--json']));
    expect((verify as { ok: boolean }).ok).toBe(true);
  });

  it('refuses to reuse a consumed approval receipt', () => {
    const approvals = fs
      .readFileSync(path.join(projectDir, '.story', 'approvals', 'approvals.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as ApprovalRecord);
    const receipt = approvals[0];
    expect(receipt).toBeDefined();
    const result = runCli([
      'commit',
      '--vault',
      workspace.vault,
      '--appdata',
      workspace.appdata,
      '--chapter',
      chapterId,
      '--file',
      fixture('chapter-02.md'),
      '--origin',
      'model',
      '--approval',
      receipt!.approval_id,
      '--json',
    ]);
    expect(result.status).toBe(8);
    expect(result.errorCode).toBe('UNAUTHORIZED');
  });

  it('rejects a proposal and leaves the manuscript untouched', () => {
    const before = manifest();
    const proposal = okJson(
      runCli([
        'proposal',
        'add',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--chapter',
        chapterId,
        '--file',
        fixture('chapter-03.md'),
        '--json',
      ]),
    ) as { proposal_id: string };
    const rejected = okJson(
      runCli([
        'proposal',
        'reject',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--id',
        proposal.proposal_id,
        '--reason',
        '语气不符合角色',
        '--json',
      ]),
    ) as { status: string };
    expect(rejected.status).toBe('rejected');
    const after = manifest();
    expect(after.revision).toBe(before.revision);
    expect(after.chapters[chapterId]?.content_hash).toBe(before.chapters[chapterId]?.content_hash);
  });

  it('marks a proposal stale when the chapter changed after it was proposed', () => {
    const proposal = okJson(
      runCli([
        'proposal',
        'add',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--chapter',
        chapterId,
        '--file',
        fixture('chapter-03.md'),
        '--json',
      ]),
    ) as { proposal_id: string };

    okJson(
      runCli([
        'commit',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--chapter',
        chapterId,
        '--file',
        fixture('chapter-01.md'),
        '--json',
      ]),
    );

    const approve = runCli([
      'proposal',
      'approve',
      '--vault',
      workspace.vault,
      '--appdata',
      workspace.appdata,
      '--id',
      proposal.proposal_id,
      '--json',
    ]);
    expect(approve.status).toBe(3);
    expect(approve.errorCode).toBe('CAS_MISMATCH');

    const proposals = okJson(
      runCli(['proposal', 'list', '--vault', workspace.vault, '--appdata', workspace.appdata, '--json']),
    ) as { proposals: { proposal_id: string; status: string }[] };
    expect(proposals.proposals.find((item) => item.proposal_id === proposal.proposal_id)?.status).toBe('stale');
  });

  it('rejects an agent actor attempting to approve directly (domain check, not authentication)', () => {
    const proposal = okJson(
      runCli([
        'proposal',
        'add',
        '--vault',
        workspace.vault,
        '--appdata',
        workspace.appdata,
        '--chapter',
        chapterId,
        '--file',
        fixture('chapter-02.md'),
        '--json',
      ]),
    ) as { proposal_id: string };

    expect(() =>
      approveProposal({
        vaultDir: workspace.vault,
        projectId,
        proposalId: proposal.proposal_id,
        actor: { kind: 'agent', id: 'untrusted-agent' },
      }),
    ).toThrow(/Only the author can approve/);
  });
});
