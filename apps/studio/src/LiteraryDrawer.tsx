import { useEffect, useState } from 'react';
import { ApiError, api, type LiteraryView } from './api';

export default function LiteraryDrawer({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [data, setData] = useState<LiteraryView | null>(null);
  const [pair, setPair] = useState<{ pair_id: string; a: { text: string }; b: { text: string }; task_id: string } | null>(null);
  const [taskId, setTaskId] = useState('g7_01');
  const [b0, setB0] = useState('潮声压低，她把旧票收进袖中，没有解释。');
  const [b1, setB1] = useState('潮声压低。她把旧票收进袖中，指尖停了一瞬，像在确认那层被盐磨薄的纸仍然存在。');
  const [choice, setChoice] = useState<'A'|'B'|'tie'|'neither'>('tie');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = async () => { try { setData(await api.literary()); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } };
  useEffect(() => { if (open) void load(); }, [open]);
  const act = async (run: () => Promise<unknown>) => { setBusy(true); setError(''); try { await run(); await load(); } catch (e) { setError(e instanceof ApiError ? e.message : String(e)); } finally { setBusy(false); } };
  if (!open) return null;
  return (
    <div className="narrative-overlay" role="presentation" onMouseDown={(e)=>{if(e.target===e.currentTarget)onClose();}}>
      <aside className="narrative-panel planning-panel" role="dialog" aria-modal="true" aria-label="文学证据实验室">
        <header className="narrative-head"><div><p className="eyebrow">GATE 7 · LITERARY EVIDENCE LAB</p><h2>文学证据实验室</h2><p className="muted small">候选不会写入正文/Canon；真实模型未授权时仅 fixture/manual 工程验证。</p></div><button className="ghost" onClick={onClose}>关闭</button></header>
        {error && <p className="narrative-error">{error}</p>}
        <div className="narrative-body">
          <section className="narrative-card"><h3>模型许可</h3><p className="muted small">{data?.provider.status} · {data?.provider.reason}</p><p className="muted small">网络：{data?.provider.network} · authorized={String(data?.provider.authorized)}</p></section>
          <section className="narrative-card"><h3>同一任务 B0/B1 盲评</h3><label className="narrative-field"><span>任务 ID</span><input value={taskId} onChange={(e)=>setTaskId(e.target.value)} /></label><label className="narrative-field"><span>B0 普通提示候选（内部对照，盲评前不显示）</span><textarea rows={3} value={b0} onChange={(e)=>setB0(e.target.value)} /></label><label className="narrative-field"><span>B1 Studio 证据编译候选（内部对照，盲评前不显示）</span><textarea rows={3} value={b1} onChange={(e)=>setB1(e.target.value)} /></label><button className="primary" disabled={busy || !data?.provider.authorized && false} onClick={()=>void act(async()=>{const r=await api.literaryPair({taskId,b0,b1,contextHash:'synthetic-demo'});setPair(r.pair);setChoice('tie');})}>生成匿名 A/B 对</button><p className="muted small">B0/B1 真实模型未授权；此处为工程 fixture，不计入文学提升。</p></section>
          {pair && <section className="narrative-card"><h3>匿名盲评 · {pair.task_id}</h3><div className="editorial-diff"><div><p className="muted small">A</p><pre className="editorial-export">{pair.a.text}</pre></div><div><p className="muted small">B</p><pre className="editorial-export">{pair.b.text}</pre></div></div><label className="narrative-field"><span>选择</span><select value={choice} onChange={(e)=>setChoice(e.target.value as typeof choice)}><option value="A">A 更好</option><option value="B">B 更好</option><option value="tie">平手</option><option value="neither">都不行</option></select></label><button className="primary" disabled={busy} onClick={()=>void act(()=>api.literaryReview({pairId:pair.pair_id,choice,scores:{naturalness:3,voice:3,fact_pov:3,rhythm:3,appeal:3},note:'internal synthetic review'}))}>提交盲评</button></section>}
          <section className="narrative-card"><h3>实验汇总</h3><p className="muted small">pairs {data?.summary.pairs ?? 0} · reviews {data?.summary.reviews ?? 0} · B0 {data?.summary.b0_wins ?? 0} / B1 {data?.summary.b1_wins ?? 0} / tie {data?.summary.ties ?? 0} / neither {data?.summary.neither ?? 0}</p><p className="muted small">{data?.summary.status}</p><button className="ghost danger" onClick={()=>void act(()=>api.literaryClear())}>清除实验数据（不影响 Vault）</button></section>
        </div>
      </aside>
    </div>
  );
}
