import { useEffect, useState } from 'react';
import { ApiError, api, type ContinuationView, type PlanningView } from './api';

export default function ContinuationDrawer({ open, onClose, chapterId, chapterTitle, chapterOrdinal }: { open: boolean; onClose: () => void; chapterId: string; chapterTitle: string; chapterOrdinal: number }) {
  const [list, setList] = useState<ContinuationView>({ candidates: [] });
  const [planning, setPlanning] = useState<PlanningView | null>(null);
  const [planId, setPlanId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const [compiledInfo, setCompiledInfo] = useState('');
  const [exported, setExported] = useState('');
  const [instruction, setInstruction] = useState('延续当前场景，保持 POV，只推进一个具体动作。');
  const [consent, setConsent] = useState(false);
  const [aiStatus, setAiStatus] = useState<{configured:boolean;model:string}|null>(null);
  const [aiError, setAiError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const plans = (planning?.state.plans ?? []).filter((plan) => plan.chapter === chapterOrdinal && plan.approval_state === 'author-approved');
  const branches = (planning?.state.branches ?? []).filter((branch) => branch.status === 'selected' && branch.plan_id === planId);
  const selectedPlan = plans.find((plan) => plan.plan_id === planId) ?? null;
  const load = async () => {
    try {
      const [nextList, nextPlanning] = await Promise.all([api.continuationList(), api.gate4()]);
      setList(nextList); setPlanning(nextPlanning.planning);
      const valid = nextPlanning.planning.state.plans.filter((plan) => plan.chapter === chapterOrdinal && plan.approval_state === 'author-approved');
      setPlanId((current) => current && valid.some((plan) => plan.plan_id === current) ? current : valid.length === 1 ? valid[0]!.plan_id : '');
      setBranchId((current) => current && nextPlanning.planning.state.branches.some((branch) => branch.branch_id === current && branch.status === 'selected') ? current : '');
    } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); }
  };
  useEffect(() => {
    if (open) {
      void load();
      void api.aiStatus().then((r) => setAiStatus(r.status)).catch(() => setAiStatus(null));
    }
  }, [open]);
  const aiContinue = async (mock: boolean) => {
    setAiBusy(true); setAiError('');
    try {
      await api.aiContinue({ chapterId, instruction, consent, mock, planId: planId || null, povEntityId: selectedPlan?.pov_entity_id ?? null });
      await load();
    } catch (e) { setAiError(e instanceof ApiError ? e.message : String(e)); }
    finally { setAiBusy(false); }
  };
  const act = async (run: () => Promise<unknown>) => { setBusy(true); setError(''); try { await run(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } };
  if (!open) return null;
  const request = { chapterId, planId, branchId: branchId || null, povEntityId: selectedPlan?.pov_entity_id ?? null, task: '续写下一场' };
  return (
    <div className="narrative-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="narrative-panel planning-panel" role="dialog" aria-modal="true" aria-label="续写与候选审阅">
        <header className="narrative-head"><div><p className="eyebrow">GATE 4 · D2 CONTINUATION</p><h2>续写与候选审阅</h2><p className="muted small">{chapterTitle || '当前章节'} · 候选只审阅/导出，不写入正文。</p></div><button className="ghost" onClick={onClose} autoFocus>关闭</button></header>
        {error && <p className="narrative-error">{error}</p>}
        <div className="narrative-body">
          <section className="narrative-card"><h3>绑定当前计划</h3>
            {plans.length === 0 ? <p className="narrative-warning">当前章节没有已批准的规划。请先在“构思 → 卷章场景”创建并明确批准计划，再生成候选。</p> : <>
              <label className="narrative-field"><span>已批准计划</span><select value={planId} onChange={(e)=>{setPlanId(e.target.value);setBranchId('');}}><option value="">请选择</option>{plans.map((plan)=><option key={plan.plan_id} value={plan.plan_id}>{plan.title} · POV {plan.pov_entity_id ?? '未限定'}</option>)}</select></label>
              <label className="narrative-field"><span>可选分支（当前计划）</span><select value={branchId} onChange={(e)=>setBranchId(e.target.value)}><option value="">不使用分支</option>{branches.map((branch)=><option key={branch.branch_id} value={branch.branch_id}>{branch.title}</option>)}</select></label>
            </>}
          </section>
          <section className="narrative-card"><h3>1. 编译受限 Prompt</h3><button className="primary" disabled={busy || !chapterId || !planId} onClick={()=>void act(async()=>{const r=await api.continuationCompile({...request,start:0,end:200,budgetTokens:1800});setCompiledInfo(JSON.stringify(r.compiled).slice(0,180));})}>编译 Context Pack</button>{compiledInfo && <p className="muted small">{compiledInfo}…</p>}</section>
          <section className="narrative-card"><h3>真实模型智能续写</h3><p className="muted small">自动编译当前章节 Context Pack 后发送。模型候选只进入审阅列表，不写正文；正式稿采用仍由作者在编辑器中决定。</p><p className="muted small">模型：{aiStatus ? `${aiStatus.configured ? '已配置' : '未配置'} · ${aiStatus.model}` : '读取中'} · Key 仅在本地服务端。</p><label className="narrative-field"><span>自然语言续写指令</span><textarea rows={3} value={instruction} onChange={(e)=>setInstruction(e.target.value)} /></label><label className="coevolution-consent"><input type="checkbox" checked={consent} onChange={(e)=>setConsent(e.target.checked)} />我同意将当前合成章节的编译上下文发送给已配置的 DeepSeek 服务（仅本次）</label><div className="coevolution-actions"><button className="ghost" disabled={aiBusy || !instruction.trim()} onClick={()=>void aiContinue(true)}>Mock 续写（不联网）</button><button className="primary" disabled={aiBusy || !instruction.trim() || !consent} onClick={()=>void aiContinue(false)}>DeepSeek 智能续写</button></div>{aiError && <p className="narrative-error">{aiError}</p>}</section>
          <section className="narrative-card"><h3>2. 候选</h3><div className="coevolution-actions"><button className="primary" disabled={busy || !planId} onClick={()=>void act(()=>api.continuationCandidate({...request,source:'offline-fixture',selectionEnd:200}))}>生成离线演示候选（非模型）</button></div><label className="narrative-field"><span>手动导入候选文本</span><textarea rows={4} value={text} onChange={(e)=>setText(e.target.value)} /></label><button className="ghost" disabled={busy || !text.trim() || !planId} onClick={()=>void act(async()=>{await api.continuationCandidate({...request,source:'manual-import',text});setText('');})}>导入候选</button></section>
          <section className="narrative-card"><h3>3. 四维审阅与选择</h3>{list.candidates.length===0?<p className="muted">尚无候选。</p>:list.candidates.map((c)=><article key={c.candidate_id} className="coevolution-item"><div className="coevolution-head"><strong>{c.source_label}</strong><span className={`narrative-badge ${c.blocking?'is-disputed':'is-author'}`}>{c.blocking?'BLOCKED':c.status}</span></div><pre className={c.source === 'deepseek' || c.source === 'deepseek-mock' ? 'ai-prose' : 'editorial-export'}>{c.text}</pre>{c.reviews.map((r)=><p className="muted small" key={r.dimension}><b>{r.dimension}</b> · {r.severity} · {r.reason}</p>)}<div className="coevolution-actions"><button className="ghost" disabled={busy||c.status==='stale'||c.blocking} onClick={()=>void act(()=>api.continuationDecision(c.candidate_id,'selected'))}>标记采用意向</button><button className="ghost" disabled={busy} onClick={()=>void navigator.clipboard.writeText(c.text)}>复制候选</button><button className="ghost danger" disabled={busy} onClick={()=>void act(()=>api.continuationDecision(c.candidate_id,'rejected'))}>拒绝</button><button className="ghost" disabled={busy||c.status==='stale'} onClick={()=>void act(async()=>{const r=await api.continuationExport(c.candidate_id);setExported(r.text);})}>导出预览</button></div></article>)}</section>
          {exported && <pre className="editorial-export">{exported}</pre>}
        </div>
      </aside>
    </div>
  );
}
