import { useEffect, useMemo, useState } from 'react';
import { ApiError, api, type EditorialCompileView, type EditorialProposalView } from './api';

interface Props {
  open: boolean;
  onClose: () => void;
  chapterId: string;
  chapterTitle: string;
  chapterText: string;
  baseRevision: string;
  baseHash: string;
  getSelection: () => { start: number; end: number };
  mode?: 'focus' | 'collaborate' | 'study';
}

export default function EditorialDrawer({ open, onClose, chapterId, chapterTitle, chapterText, baseRevision, baseHash, getSelection, mode = 'collaborate' }: Props) {
  const [task, setTask] = useState('保意精修：保留人物声口，减少赘述');
  const [level, setLevel] = useState<'L0' | 'L1' | 'L2' | 'L3'>('L1');
  const [pov, setPov] = useState('');
  const [forbidden, setForbidden] = useState('不改变人物关系；不新增未获作者确认的事件');
  const [budget, setBudget] = useState(1800);
  const [compiled, setCompiled] = useState<EditorialCompileView | null>(null);
  const [proposal, setProposal] = useState<EditorialProposalView | null>(null);
  const [importText, setImportText] = useState('');
  const [exported, setExported] = useState('');
  const [feedbackNotice, setFeedbackNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [range, setRange] = useState<{ start: number; end: number } | null>(null);

  useEffect(() => {
    if (!open) return;
    const selected = getSelection();
    setRange(selected.end > selected.start ? selected : { start: 0, end: Math.min(chapterText.length, 600) });
    setCompiled(null);
    setProposal(null);
    setExported('');
    setError('');
  }, [open, chapterId, chapterText, getSelection]);

  const effectiveRange = range ?? { start: 0, end: Math.min(chapterText.length, 600) };
  const forbiddenList = useMemo(() => forbidden.split(/\n|；|;/).map((item) => item.trim()).filter(Boolean), [forbidden]);
  const act = async <T,>(run: () => Promise<T>, finish: (value: T) => void) => {
    setBusy(true); setError('');
    try { finish(await run()); } catch (caught) { setError(caught instanceof ApiError ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const recordFeedback = async () => {
    const hunk = proposal?.hunks.find((item) => item.decision !== 'pending');
    if (!proposal || !hunk) return;
    setBusy(true); setError('');
    try {
      await api.coevolutionFeedback({
        chapterId, revisionId: proposal.base_revision, contentHash: proposal.base_hash,
        proposalId: proposal.proposal_id, hunkId: hunk.hunk_id,
        decision: hunk.decision === 'accept' ? 'accepted_intent' : 'rejected',
        reasonCode: hunk.decision === 'accept' ? 'author-accepted' : 'author-rejected',
        scope: pov ? 'character' : 'project', scopeRef: pov || null,
      });
      setFeedbackNotice('反馈已记录；是否学习由成长工作台中的同意开关和作者批准决定。');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally { setBusy(false); }
  };

  if (!open) return null;

  return (
    <div className="narrative-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="narrative-panel editorial-panel" role="dialog" aria-modal="true" aria-label="文学编辑工作台">
        <header className="narrative-head">
          <div>
            <p className="eyebrow">GATE 3B · PROMPT COMPILER / CONTROLLED REVIEW</p>
            <h2>文学编辑工作台</h2>
            <p className="muted small">{chapterTitle} · 选区 {effectiveRange.start}–{effectiveRange.end} · 正式稿只读</p>
          </div>
          <div className="narrative-head-actions">
            <button type="button" className="ghost" onClick={onClose} autoFocus>关闭</button>
          </div>
        </header>
        {error && <p className="narrative-error" role="alert">{error}</p>}
        <div className="narrative-body editorial-body">
          <section className="narrative-card">
            <h3>1. 编译上下文</h3>
            <div className="editorial-form">
              <label className="narrative-field"><span>任务</span><input value={task} onChange={(event) => setTask(event.target.value)} /></label>
              <label className="narrative-field"><span>等级</span><select value={level} onChange={(event) => setLevel(event.target.value as typeof level)}><option>L0</option><option>L1</option><option>L2</option><option>L3</option></select></label>
              <label className="narrative-field"><span>POV 角色 ID（可空）</span><input value={pov} onChange={(event) => setPov(event.target.value)} placeholder="ent_..." /></label>
              <label className="narrative-field"><span>预算 tokens</span><input type="number" min={300} max={12000} value={budget} onChange={(event) => setBudget(Number(event.target.value))} /></label>
            </div>
            <label className="narrative-field"><span>禁改项（换行/分号分隔）</span><textarea rows={2} value={forbidden} onChange={(event) => setForbidden(event.target.value)} /></label>
            <div className="editorial-actions">
              <button type="button" className="primary" disabled={busy || effectiveRange.end <= effectiveRange.start} onClick={() => void act(() => api.editorialCompile({ chapterId, start: effectiveRange.start, end: effectiveRange.end, task, level, povEntityId: pov || null, forbidden: forbiddenList, budgetTokens: budget }), (result) => { setCompiled(result); setProposal(null); setExported(''); })}>编译 Context Pack</button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => api.editorialFixture({ chapterId, start: effectiveRange.start, end: effectiveRange.end, task, forbidden: forbiddenList, povEntityId: pov || null }), (result) => { setProposal(result.proposal); setCompiled(null); setExported(''); })}>生成离线演示候选</button>
            </div>
            <p className="muted small">离线演示候选是确定性 fixture，不是模型生成；真实 Provider 默认 disabled，外部发送次数 0。</p>
          </section>

          {compiled && (
            <section className="narrative-card">
              <h3>2. 上下文与预算</h3>
              <div className="editorial-stats">
                <span>状态 {compiled.context.status}</span>
                <span>硬槽位 {compiled.context.hard_tokens} tokens</span>
                <span>总计 {compiled.context.estimated_tokens}/{compiled.context.budget_tokens}</span>
                <span>外部发送 {compiled.manifest.external_send ? '允许' : '否'}</span>
                <span>Provider {compiled.manifest.provider ?? 'offline-fixture'}</span>
              </div>
              {compiled.context.rejection_reason && <p className="narrative-error">{compiled.context.rejection_reason}</p>}
              {compiled.context.injection_warnings.map((warning) => <p key={warning} className="narrative-warning">{warning}</p>)}
              <div className="editorial-context">
                {[...compiled.context.hard, ...compiled.context.soft].map((item) => (
                  <article key={item.snippet_id} className={`editorial-snippet editorial-${item.kind}`}>
                    <header><span className={`narrative-badge ${item.kind === 'hard' ? 'is-author' : 'is-inferred'}`}>{item.kind}</span><strong>{item.role}</strong></header>
                    <p>{item.text.length > 320 ? `${item.text.slice(0, 320)}…` : item.text}</p>
                    <p className="muted small">{item.reason}</p>
                  </article>
                ))}
              </div>
              <details><summary>PromptManifest / 可重建输入</summary><pre className="editorial-prompt">{compiled.prompt}</pre></details>
            </section>
          )}

          <section className="narrative-card">
            <h3>3. 候选审阅</h3>
            <p className="muted small">手动导入/离线候选都只生成审阅提案；不会写正式稿。候选必须匹配当前章节 base revision/hash。</p>
            <label className="narrative-field"><span>手动导入 hunks JSON</span><textarea rows={5} value={importText} onChange={(event) => setImportText(event.target.value)} placeholder='[{"start":0,"end":4,"old_text":"...","old_hash":"sha256:...","replacement":"...","reason":"..."}]' /></label>
            <button type="button" className="ghost" disabled={busy || !importText.trim()} onClick={() => void act(async () => {
              const parsed = JSON.parse(importText) as Array<Record<string, unknown>>;
              return api.editorialCandidate({ chapterId, start: effectiveRange.start, end: effectiveRange.end, baseRevision, baseHash, source: 'manual-import', hunks: parsed, forbidden: forbiddenList, povEntityId: pov || null });
            }, (result) => setProposal(result.proposal))}>校验并导入候选</button>
            {proposal && (
              <div className="editorial-proposal">
                <div className="editorial-stats">
                  <span className={`narrative-badge ${proposal.source === 'deterministic-fixture' ? 'is-inferred' : 'is-source'}`}>{proposal.source_label}</span>
                  <span>状态 {proposal.status}</span>
                  <span>风险 {proposal.risks.length}</span>
                </div>
                {proposal.risks.map((risk) => <p key={risk.risk_id} className={risk.severity === 'blocking' ? 'narrative-error' : 'narrative-warning'}>{risk.severity} · {risk.kind} · {risk.message}</p>)}
                {proposal.hunks.map((hunk) => (
                  <article key={hunk.hunk_id} className="editorial-hunk">
                    <header><strong>{hunk.hunk_id}</strong><span className="muted small">UTF-16 {hunk.start}–{hunk.end}</span></header>
                    <div className="editorial-diff">
                      <div><span className="muted small">原文</span><pre>{hunk.old_text}</pre></div>
                      <div><span className="muted small">候选</span><pre>{hunk.replacement}</pre></div>
                    </div>
                    <p className="muted small">{hunk.reason}</p>
                    <div className="editorial-actions">
                      <button type="button" className="ghost" disabled={busy || proposal.status === 'rejected' || proposal.risks.some((risk) => risk.severity === 'blocking')} onClick={() => void act(() => api.editorialDecision(proposal.proposal_id, hunk.hunk_id, 'accept'), (result) => setProposal(result.proposal))}>采纳意向</button>
                      <button type="button" className="ghost danger" disabled={busy} onClick={() => void act(() => api.editorialDecision(proposal.proposal_id, hunk.hunk_id, 'reject'), (result) => setProposal(result.proposal))}>拒绝</button>
                    </div>
                  </article>
                ))}
                <button type="button" className="primary" disabled={busy || proposal.status === 'rejected' || proposal.risks.some((risk) => risk.severity === 'blocking')} onClick={() => void act(() => api.editorialExport(proposal.proposal_id), (result) => setExported(result.text))}>导出审阅文本（不落稿）</button>
                {mode !== 'focus' && <button type="button" className="ghost" disabled={busy || proposal.hunks.every((hunk) => hunk.decision === 'pending')} onClick={() => void recordFeedback()}>记录本地学习反馈（可选）</button>}
                {feedbackNotice && <p className="muted small">{feedbackNotice}</p>}
                {exported && <pre className="editorial-export">{exported}</pre>}
              </div>
            )}
          </section>
        </div>
      </aside>
    </div>
  );
}
