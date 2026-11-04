import { useEffect, useState } from 'react';
import { ApiError, api, type CoevolutionView } from './api';

interface Props { open: boolean; onClose: () => void; mode?: 'focus' | 'collaborate' | 'study'; }

export default function GrowthDrawer({ open, onClose, mode = 'collaborate' }: Props) {
  const [data, setData] = useState<CoevolutionView | null>(null);
  const [tab, setTab] = useState<'consent' | 'insights' | 'policies' | 'growth'>(mode === 'study' ? 'growth' : 'consent');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [skill, setSkill] = useState('对白节奏');
  const [reflection, setReflection] = useState('这一章我最想保留的是什么？');
  const [note, setNote] = useState('');

  const load = async () => {
    setBusy(true); setError('');
    try { setData((await api.coevolution()).coevolution); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  useEffect(() => { if (open) void load(); }, [open]);

  const act = async (run: () => Promise<{ coevolution: CoevolutionView }>) => {
    setBusy(true); setError('');
    try { setData((await run()).coevolution); }
    catch (caught) { setError(caught instanceof ApiError ? caught.message : String(caught)); }
    finally { setBusy(false); }
  };
  const tabs: Array<[typeof tab, string]> = mode === 'focus'
    ? [['consent', '同意与边界'], ['growth', '成长角落']]
    : mode === 'collaborate'
      ? [['consent', '同意与边界'], ['insights', '偏好观察'], ['policies', '策略版本']]
      : [['consent', '同意与边界'], ['insights', '偏好观察'], ['policies', '策略版本'], ['growth', '成长角落']];
  if (!open) return null;
  const consent = data?.state.consent ?? {};

  return (
    <div className="narrative-overlay" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <aside className="narrative-panel coevolution-panel" role="dialog" aria-modal="true" aria-label="成长工作台">
        <header className="narrative-head">
          <div><p className="eyebrow">GATE 3C · CO-EVOLUTION</p><h2>成长工作台</h2><p className="muted small">当前模式：{mode === 'focus' ? 'Focus 专注（不展示教学提示）' : mode === 'study' ? 'Study 学习（主动练习/复盘）' : 'Collaborate 协作（折叠解释）'}。偏好适应与作者成长是两条独立、可关闭、可撤销的循环。</p></div>
          <div className="narrative-head-actions"><button className="ghost" onClick={onClose} autoFocus>关闭</button></div>
        </header>
        {error && <p className="narrative-error" role="alert">{error}</p>}
        <div className="narrative-tabs" role="tablist">
          {tabs.map(([key,label]) => <button key={key} role="tab" aria-selected={tab===key} className={tab===key?'active':''} onClick={() => setTab(key)}>{label}</button>)}
        </div>
        {!data ? <p className="muted">读取中…</p> : (
          <div className="narrative-body coevolution-body">
            {tab === 'consent' && <section className="narrative-card">
              <h3>独立同意</h3>
              <p className="muted small">关闭任一开关都不会影响 Writer/Atlas/Voice/Editorial 的基本使用。采纳意向不等于同意学习，更不等于正式落稿。</p>
              {([['store_feedback','保存反馈元数据'],['local_strategy_learning','允许本地策略学习'],['show_coaching','显示成长提示']] as const).map(([key,label]) => (
                <label className="coevolution-consent" key={key}><input type="checkbox" checked={consent[key] === true} onChange={(event) => void act(() => api.coevolutionConsent({ ...consent, [key]: event.target.checked }))} />{label}</label>
              ))}
              <p className="muted small">跨作品复用固定关闭；外部发送固定关闭；0 网络模型调用。</p>
              <p className="muted small">观察样本 {data.state.observations.length} · 待审假设 {data.hypotheses.length} · 策略 {data.policies.length}</p>
            </section>}

            {tab === 'insights' && <section className="narrative-card">
              <h3>有证据的偏好假设 <span className="muted small">（待审，不自动生效）</span></h3>
              {data.hypotheses.length === 0 ? <p className="muted">还没有达到最小有效样本的假设；不做单样本推断。</p> : data.hypotheses.map((hypothesis) => (
                <article key={hypothesis.hypothesis_id} className="coevolution-item">
                  <strong>{hypothesis.text}</strong>
                  <p className="muted small">{hypothesis.scope_label} · 正例 {hypothesis.positive} / 反例 {hypothesis.negative} / 样本 {hypothesis.effective_samples}</p>
                  <p className="muted small">{hypothesis.uncertainty}</p>
                  <button className="primary" disabled={busy || !consent.local_strategy_learning} onClick={() => void act(() => api.coevolutionActivate(hypothesis.hypothesis_id))}>作者批准并启用策略</button>
                </article>
              ))}
              <p className="muted small">策略是编译器偏好，不是 Style Constitution，也不是模型训练。</p>
            </section>}

            {tab === 'policies' && <section className="narrative-card">
              <h3>策略版本</h3>
              {data.policies.length === 0 ? <p className="muted">尚无已批准策略。</p> : data.policies.map((policy) => (
                <article key={policy.policy_id} className={`coevolution-item coevolution-${policy.effective_status}`}>
                  <div className="coevolution-head"><span className={`narrative-badge ${policy.effective_status === 'active' ? 'is-author' : 'is-disputed'}`}>{policy.effective_status}</span><span className="mono small">{policy.policy_id} · v{policy.version}</span></div>
                  <p>{policy.text}</p>
                  <p className="muted small">{policy.scope}{policy.scope_ref ? ` · ${policy.scope_ref}` : ''} {policy.stale_reason ? `· ${policy.stale_reason}` : ''}</p>
                  <div className="coevolution-actions">
                    {policy.effective_status === 'active' && <button className="ghost" disabled={busy} onClick={() => void act(() => api.coevolutionPolicyTransition(policy.policy_id, 'freeze'))}>冻结</button>}
                    {policy.status !== 'revoked' && <button className="ghost danger" disabled={busy} onClick={() => void act(() => api.coevolutionPolicyTransition(policy.policy_id, 'revoke'))}>撤销</button>}
                    <button className="ghost" disabled={busy} onClick={() => void act(() => api.coevolutionPolicyTransition(policy.policy_id, 'rollback'))}>恢复/回滚</button>
                  </div>
                </article>
              ))}
            </section>}

            {tab === 'growth' && <section className="narrative-card">
              <h3>作者成长角落</h3>
              <p className="muted small">完全自愿；没有能力分、没有打卡惩罚。Focus/Collaborate/Study 只影响提示呈现。</p>
              <label className="narrative-field"><span>当前练习目标</span><input value={skill} onChange={(event) => setSkill(event.target.value)} /></label>
              <button className="primary" disabled={busy} onClick={() => void act(() => api.coevolutionGoal(skill, ''))}>添加目标</button>
              <ul className="coevolution-list">{data.state.goals.map((goal) => <li key={goal.goal_id}><strong>{goal.skill}</strong> <span className="muted small">{goal.status}</span></li>)}</ul>
              <label className="narrative-field"><span>1 分钟复盘问题</span><input value={reflection} onChange={(event) => setReflection(event.target.value)} /></label>
              <label className="narrative-field"><span>复盘内容</span><textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              <button className="ghost" disabled={busy || !note.trim()} onClick={() => void act(() => api.coevolutionReflection(reflection, note))}>保存复盘</button>
              <div className="coevolution-actions">
                <button className="ghost" disabled={busy} onClick={() => void act(() => api.coevolutionExercise('dialogue-rhythm-1', 'started'))}>开始练习卡</button>
                <button className="ghost" disabled={busy} onClick={() => void act(() => api.coevolutionExercise('dialogue-rhythm-1', 'deferred'))}>稍后</button>
              </div>
              <p className="muted small">历史轨迹 {data.state.reflections.length} 次复盘 · {data.state.exercises.length} 次练习</p>
            </section>}
          </div>
        )}
      </aside>
    </div>
  );
}
