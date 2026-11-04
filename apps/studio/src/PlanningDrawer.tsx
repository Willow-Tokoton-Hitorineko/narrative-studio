import { useEffect, useState } from 'react';
import { ApiError, api, type PlanningView, type StoryOutlineView } from './api';
import AiOutlineView from './AiOutlineView';

export default function PlanningDrawer({ open, onClose, chapterId, revisionId, contentHash, initialTab = 'idea' }: { open: boolean; onClose: () => void; chapterId: string; revisionId: string; contentHash: string; initialTab?: 'idea'|'ai'|'plan'|'branch' }) {
  const [data, setData] = useState<PlanningView | null>(null);
  const [tab, setTab] = useState<'idea'|'ai'|'plan'|'branch'>('idea');
  const [aiConsent, setAiConsent] = useState(false);
  const [aiStatus, setAiStatus] = useState<{configured:boolean;model:string}|null>(null);
  const [aiOutline, setAiOutline] = useState<StoryOutlineView|null>(null);
  const [aiSource, setAiSource] = useState('');
  const [aiError, setAiError] = useState('');
  const [aiBusy, setAiBusy] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [selectedGenres, setSelectedGenres] = useState<string[]>([]);
  const [title, setTitle] = useState('雾港旧案');
  const [premise, setPremise] = useState('一名账房在旧港发现被抹去的船期。');
  const [planTitle, setPlanTitle] = useState('旧港夜查');
  const [planGoal, setPlanGoal] = useState('发现船期被改');
  const [planChapter, setPlanChapter] = useState(1);
  const [planScene, setPlanScene] = useState(1);
  const [planPov, setPlanPov] = useState('');
  const [approve, setApprove] = useState(false);
  const [branchTitle, setBranchTitle] = useState('追查船期');
  const [branchPremise, setBranchPremise] = useState('她决定夜入旧仓，代价是暴露行踪。');
  const [branchCost, setBranchCost] = useState('失去账房身份');
  const [branchMotivation, setBranchMotivation] = useState('她想知道父亲为何改船期');
  const [branchIrreversible, setBranchIrreversible] = useState('旧港的人会知道她来过');
  const [branchRisk, setBranchRisk] = useState('可能提前暴露未来秘密');

  const load = async () => { setBusy(true); setError(''); try { const next = (await api.gate4()).planning; setData(next); setSelectedGenres(next.selectedGenreIds); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } };
  useEffect(() => { if (open) { setTab(initialTab); void load(); void api.aiStatus().then((r)=>setAiStatus(r.status)).catch(()=>setAiStatus(null)); } }, [open, initialTab]);
  const generateOutline = async (mock: boolean) => { setAiBusy(true); setAiError(''); try { const r = await api.aiOutline({ idea: `${title}：${premise}`, genre: '悬疑', volumes: 1, chaptersPerVolume: 10, consent: aiConsent, mock }); setAiOutline(r.outline); setAiSource(`${r.source} · ${r.model}`); } catch (e) { setAiError(e instanceof ApiError ? e.message : String(e)); } finally { setAiBusy(false); } };
  const saveOutlineDrafts = async (draftText: string) => { setAiBusy(true); setAiError(''); try { const outline = JSON.parse(draftText) as StoryOutlineView; setAiOutline(outline); for (const vol of outline.volumes) for (const ch of vol.chapters) { await api.gate4Plan({ volume: vol.volume, chapter: ch.chapter, scene: 1, title: ch.title, goal: ch.goal, pov_entity_id: null, location: '待定', cast: [], genre_ids: selectedGenres, approve: false, base_chapter_revision: null, base_chapter_hash: null }); } await load(); setTab('plan'); } catch (e) { setAiError(e instanceof ApiError ? e.message : String(e)); } finally { setAiBusy(false); } };
  const act = async (run: () => Promise<{ planning: PlanningView }>) => { setBusy(true); setError(''); try { const next = (await run()).planning; setData(next); setSelectedGenres(next.selectedGenreIds); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } };
  if (!open) return null;
  return (
    <div className="narrative-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="narrative-panel planning-panel" role="dialog" aria-modal="true" aria-label="构思与规划工作台">
        <header className="narrative-head"><div><p className="eyebrow">GATE 4 · D1 PLANNING</p><h2>构思与规划</h2><p className="muted small">计划已确认 ≠ Canon/正文已发生；候选不会自动落稿。</p></div><button className="ghost" onClick={onClose} autoFocus>关闭</button></header>
        {error && <p className="narrative-error">{error}</p>}
        <div className="narrative-tabs">{(['idea','ai','plan','branch'] as const).map((key) => <button key={key} className={tab===key?'active':''} onClick={() => setTab(key)}>{key==='idea'?'新书灵感':key==='ai'?'AI 新书骨架':key==='plan'?'卷章场景':'剧情分支'}</button>)}</div>
        {!data ? <p className="muted">读取中…</p> : <div className="narrative-body">
          {tab==='idea' && <section className="narrative-card"><h3>新书灵感卡</h3><label className="narrative-field"><span>标题</span><input value={title} onChange={(e)=>setTitle(e.target.value)} /></label><label className="narrative-field"><span>核心前提</span><textarea rows={3} value={premise} onChange={(e)=>setPremise(e.target.value)} /></label><button className="primary" disabled={busy} onClick={()=>void act(()=>api.gate4Idea({title,premise,theme:'记忆与责任',protagonist_goal:'查清船期',conflict:'真相与安全',genre_ids:selectedGenres}))}>保存灵感</button><h4>题材（可多选/撤选）</h4><div className="coevolution-actions">{data.genres.map((g)=><button key={g.genre_id} className={selectedGenres.includes(g.genre_id)?'primary':'ghost'} onClick={()=>{const next=selectedGenres.includes(g.genre_id)?selectedGenres.filter((id)=>id!==g.genre_id):[...selectedGenres,g.genre_id];void act(()=>api.gate4Genre(next));}}>{g.name}</button>)}</div><p className="muted small">已选 {selectedGenres.length} 项；混合题材让位于 Canon/POV/已批准 Voice。</p></section>}
          {tab==='ai' && <section className="narrative-card"><h3>AI 生成新书脉络与骨架</h3><p className="muted small">输入原创灵感；生成的是规划草稿，不会写入正文或 Canon。真实调用需服务端配置 DEEPSEEK_API_KEY 且勾选本次数据发送同意。</p><label className="narrative-field"><span>灵感 / 一句话故事</span><textarea rows={4} value={premise} onChange={(e)=>setPremise(e.target.value)} /></label><p className="muted small">模型状态：{aiStatus ? `${aiStatus.configured ? '已配置' : '未配置'} · ${aiStatus.model}` : '读取中'}；Key 只在本地服务端环境变量，前端不可见。</p><label className="coevolution-consent"><input type="checkbox" checked={aiConsent} onChange={(e)=>setAiConsent(e.target.checked)} />我同意将这段原创合成灵感发送给已配置的 DeepSeek 服务（仅本次）</label><div className="coevolution-actions"><button className="ghost" disabled={aiBusy || !premise.trim()} onClick={()=>void generateOutline(true)}>生成演示骨架（Mock，不联网）</button><button className="primary" disabled={aiBusy || !premise.trim() || !aiConsent} onClick={()=>void generateOutline(false)}>调用 DeepSeek 生成骨架</button></div>{aiError && <p className="narrative-error">{aiError}</p>}{aiOutline && <AiOutlineView outline={aiOutline} source={aiSource} busy={aiBusy} onSave={(draft)=>void saveOutlineDrafts(draft)} onDiscard={()=>setAiOutline(null)} />}</section>}          {tab==='plan' && <section className="narrative-card"><h3>可编辑场景计划</h3><div className="editorial-form"><label className="narrative-field"><span>标题</span><input value={planTitle} onChange={(e)=>setPlanTitle(e.target.value)} /></label><label className="narrative-field"><span>章</span><input type="number" value={planChapter} onChange={(e)=>setPlanChapter(Number(e.target.value))} /></label><label className="narrative-field"><span>场</span><input type="number" value={planScene} onChange={(e)=>setPlanScene(Number(e.target.value))} /></label><label className="narrative-field"><span>POV</span><input value={planPov} onChange={(e)=>setPlanPov(e.target.value)} placeholder="可空" /></label></div><label className="narrative-field"><span>目标</span><textarea rows={3} value={planGoal} onChange={(e)=>setPlanGoal(e.target.value)} /></label><label className="coevolution-consent"><input type="checkbox" checked={approve} onChange={(e)=>setApprove(e.target.checked)} />我明确批准此计划（不等于正文事实）</label><button className="primary" disabled={busy} onClick={()=>void act(()=>api.gate4Plan({volume:1,chapter:planChapter,scene:planScene,title:planTitle,goal:planGoal,pov_entity_id:planPov||null,location:'旧港',cast:[],genre_ids:selectedGenres,approve,base_chapter_revision:chapterId?revisionId:null,base_chapter_hash:chapterId?contentHash:null}))}>保存计划</button><ul className="coevolution-list">{data.state.plans.map((p)=><li key={p.plan_id}><strong>{p.title}</strong> <span className="muted small">{p.approval_state} · 第{p.chapter}章</span></li>)}</ul></section>}
          {tab==='branch' && <section className="narrative-card"><h3>分支比较</h3><div className="editorial-form"><label className="narrative-field"><span>标题</span><input value={branchTitle} onChange={(e)=>setBranchTitle(e.target.value)} /></label><label className="narrative-field"><span>短期成本</span><input value={branchCost} onChange={(e)=>setBranchCost(e.target.value)} /></label><label className="narrative-field"><span>人物动机</span><input value={branchMotivation} onChange={(e)=>setBranchMotivation(e.target.value)} /></label><label className="narrative-field"><span>不可逆代价</span><input value={branchIrreversible} onChange={(e)=>setBranchIrreversible(e.target.value)} /></label></div><label className="narrative-field"><span>前提</span><textarea rows={2} value={branchPremise} onChange={(e)=>setBranchPremise(e.target.value)} /></label><label className="narrative-field"><span>主要风险</span><input value={branchRisk} onChange={(e)=>setBranchRisk(e.target.value)} /></label><button className="primary" disabled={busy} onClick={()=>void act(()=>api.gate4Branch({title:branchTitle,premise:branchPremise,short_term_cost:branchCost,motivation:branchMotivation,irreversible_cost:branchIrreversible,risk:branchRisk,plan_id:data.state.plans[0]?.plan_id ?? null}))}>添加分支</button><div className="editorial-context">{data.state.branches.map((b)=><article key={b.branch_id} className="coevolution-item"><strong>{b.title}</strong> <span className="muted small">{b.status}</span><p>{b.premise}</p><p className="muted small">成本 {b.short_term_cost} · 动机 {b.motivation} · 不可逆 {b.irreversible_cost} · 风险 {b.risk}</p><button className="ghost" onClick={()=>void act(()=>api.gate4SelectBranch(b.branch_id))}>选为规划偏好</button></article>)}</div></section>}
        </div>}
      </aside>
    </div>
  );
}
