import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ApiError,
  api,
  type VoiceMetricView,
  type VoiceOverviewView,
  type VoiceProfileView,
  type VoiceScopeView,
} from './api';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'profile' | 'sources' | 'constitution' | 'compare';

const EMPTY_SOURCE = {
  name: '本作品 · 作者合成样稿',
  description: '原创合成文本，用于本地文风观察。',
  scope: 'project' as VoiceScopeView,
  scopeRef: '',
  category: 'synthetic',
  rightsStatement: '作者本人创作并授权本地分析、引用展示；不授权公开传播或外部发送。',
  local: true,
  quote: true,
  sample: false,
};

function confidenceLabel(value: string): string {
  if (value === 'stable') return '较稳定';
  if (value === 'exploratory') return '探索性';
  return '不足以判断';
}

function valueText(metric: VoiceMetricView): string {
  const value = metric.value;
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : value.toFixed(2);
  if (typeof value === 'string') return value;
  const labels: Record<string, string> = {
    mean: '平均',
    median: '中位',
    p90: '90分位',
    ratio: '比例',
    dialogue_chars: '对白字',
    total_chars: '总字',
  };
  return Object.entries(value).map(([key, entry]) => `${labels[key] ?? key} ${Number(entry).toFixed(2)}`).join(' · ');
}

function profileLabel(profile: VoiceProfileView): string {
  if (profile.scope === 'project') return '本作品声线';
  if (profile.scope === 'author') return '作者基础声线';
  if (profile.scope === 'character') return `角色 · ${profile.scope_ref ?? '未命名'}`;
  return `场景 · ${profile.scope_ref ?? '未命名'}`;
}

export default function VoiceAtelier({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('profile');
  const [voice, setVoice] = useState<VoiceOverviewView | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selectedProfile, setSelectedProfile] = useState('');
  const [source, setSource] = useState(EMPTY_SOURCE);
  const [revokeReason, setRevokeReason] = useState('作者在 Voice Atelier 撤回该来源的本地分析许可');
  const [compareA, setCompareA] = useState('林砚把斗笠压低，问道：“今夜还过河？”\n老船工说：“不过。水太急。”\n“我等。”');
  const [compareB, setCompareB] = useState('雨停之后，整座城像被人从水底慢慢提起来，屋檐仍在滴水，街角的铁皮棚却已经干了，只有风经过时还带着一股潮湿的铁锈味。');
  const [comparison, setComparison] = useState<{ a: Record<string, number>; b: Record<string, number> } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await api.voice();
      setVoice(result.voice);
      const first = result.voice.profiles.find((profile) => profile.scope === 'project') ?? result.voice.profiles[0];
      setSelectedProfile((current) => current || first?.profile_id || '');
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  const profile = useMemo(
    () => voice?.profiles.find((entry) => entry.profile_id === selectedProfile) ?? voice?.profiles[0] ?? null,
    [voice, selectedProfile],
  );

  const act = async (run: () => Promise<{ voice: VoiceOverviewView }>, message: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await run();
      setVoice(result.voice);
      setNotice(message);
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div className="narrative-overlay voice-overlay" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <aside className="narrative-panel voice-panel" role="dialog" aria-modal="true" aria-label="文风工坊">
        <header className="narrative-head">
          <div>
            <p className="eyebrow">GATE 3A · VOICE FORGE</p>
            <h2>文风工坊</h2>
            <p className="muted small">从可解释的观察开始；只有作者批准的文字才会成为风格宪章。</p>
          </div>
          <div className="narrative-head-actions">
            <button type="button" className="ghost" onClick={() => void load()} disabled={loading}>
              {loading ? '读取中…' : '刷新'}
            </button>
            <button type="button" className="ghost" onClick={() => void act(() => api.voiceAnalyze(), '已重新分析当前来源；统计只写入本地投影。')} disabled={busy}>
              {busy ? '处理中…' : '重新分析'}
            </button>
            <button type="button" className="icon-button" aria-label="关闭文风工坊" onClick={onClose}>×</button>
          </div>
        </header>

        {error && <p className="narrative-error" role="alert">{error}</p>}
        {notice && <p className="voice-notice" role="status">{notice}</p>}

        <div className="narrative-tabs" role="tablist" aria-label="文风工坊视图">
          {([
            ['profile', '风格画像'],
            ['sources', '来源许可'],
            ['constitution', '风格宪章'],
            ['compare', '文本对照'],
          ] as const).map(([key, label]) => (
            <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? 'active' : ''} onClick={() => setTab(key)}>
              {label}
            </button>
          ))}
        </div>

        {!voice ? (
          <p className="muted">尚未加载文风数据。</p>
        ) : (
          <div className="narrative-body voice-body">
            <div className="voice-status-strip">
              <span className={`voice-state voice-state-${voice.status}`}>{voice.status === 'current' ? '投影当前' : voice.status === 'stale' ? '依赖已失效 / 需复核' : voice.status === 'missing' ? '尚未分析' : '错误'}</span>
              <span>来源 {voice.sources.length}</span>
              <span>画像 {voice.profiles.length}</span>
              <span>待批建议 {voice.proposals.length}</span>
              <span>批准规则 {voice.rules.filter((rule) => rule.effective_status === 'approved').length}</span>
              {voice.generated_at && <span className="mono">生成 {new Date(voice.generated_at).toLocaleString('zh-CN')}</span>}
            </div>
            {voice.stale_reason && <p className="narrative-warning">{voice.stale_reason}。统计不会被静默标为 current。</p>}

            {tab === 'profile' && (
              <div className="voice-grid">
                <section className="narrative-card voice-profile-card">
                  <div className="voice-section-head">
                    <h3>分层画像</h3>
                    <label className="narrative-field">
                      <span>查看</span>
                      <select value={profile?.profile_id ?? ''} onChange={(event) => setSelectedProfile(event.target.value)}>
                        {voice.profiles.map((entry) => <option key={entry.profile_id} value={entry.profile_id}>{profileLabel(entry)}</option>)}
                      </select>
                    </label>
                  </div>
                  {!profile ? <p className="muted">还没有画像。先登记来源并分析。</p> : (
                    <>
                      <p className="voice-profile-meta">
                        {profileLabel(profile)} · {profile.source_char_count.toLocaleString('zh-CN')} 汉字 · {profile.chapter_count} 章节 · 对白 {profile.dialogue_samples} 条 · 语句未归属 {profile.unknown_dialogue_count} 条
                      </p>
                      <p className={profile.status === 'current' ? 'muted small' : 'narrative-warning small'}>
                        算法版本 voice.metrics.v1；{profile.status === 'current' ? '当前可用' : profile.stale_reason ?? '依赖已变化，需重新分析'}
                      </p>
                      <div className="voice-metric-grid">
                        {profile.metrics.map((metric) => (
                          <article className={`voice-metric voice-confidence-${metric.confidence}`} key={metric.metric_id}>
                            <header><h4>{metric.label}</h4><span className="voice-confidence">{confidenceLabel(metric.confidence)}</span></header>
                            <strong>{valueText(metric)}</strong>
                            <p className="muted small">{metric.unit} · 样本 {metric.sample_size}</p>
                            <p className="small">{metric.method}</p>
                            <p className="muted small">{metric.caveat}</p>
                          </article>
                        ))}
                      </div>
                      {profile.characters.length > 0 && (
                        <div className="voice-characters">
                          <h4>显式归因的人物对白</h4>
                          {profile.characters.map((character) => (
                            <article key={character.character_id} className="voice-character">
                              <strong>{character.character_name}</strong>
                              <span className="muted small">{character.dialogue_samples} 条显式对白 · 未归属 {character.unknown_attribution_count}</span>
                              {character.metrics.map((metric) => <span key={metric.metric_id} className="small">{metric.label}：{valueText(metric)}</span>)}
                            </article>
                          ))}
                          <p className="muted small">同名角色若出现在另一作品，不会自动合并；当前仅显示本作品可归属对白。</p>
                        </div>
                      )}
                    </>
                  )}
                </section>

                <section className="narrative-card">
                  <h3>原文证据</h3>
                  {profile?.evidence.length ? (
                    <ul className="voice-evidence-list">
                      {profile.evidence.slice(0, 8).map((anchor) => (
                        <li key={anchor.anchor_id}>
                          <span className={`narrative-badge ${anchor.status === 'current' ? 'is-author' : 'is-disputed'}`}>{anchor.status}</span>
                          <blockquote>{anchor.quote.length > 160 ? `${anchor.quote.slice(0, 160)}…` : anchor.quote}</blockquote>
                          <span className="mono small">{anchor.chapter_id}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <p className="muted">当前画像没有可展示的原文证据。</p>}
                  <p className="muted small">引用只在作者允许 <code>quote_display</code> 的来源中出现；统计不是文学评价。</p>
                </section>
              </div>
            )}

            {tab === 'sources' && (
              <div className="voice-grid">
                <section className="narrative-card">
                  <h3>已登记来源</h3>
                  <p className="muted small">仅“本地分析”权限是登记的硬前提。跨作品、外部发送、公开传播默认关闭。</p>
                  <div className="voice-source-list">
                    {voice.sources.map((item) => (
                      <article key={item.source_id} className={`voice-source voice-source-${item.effective_status}`}>
                        <div className="voice-source-head">
                          <div><strong>{item.name}</strong><span className={`voice-state voice-state-${item.effective_status}`}>{item.effective_status}</span></div>
                          <span className="muted small">{item.scope}{item.scope_ref ? ` · ${item.scope_ref}` : ''} · {item.category} · {item.chapter_count} 章节</span>
                        </div>
                        <p>{item.description || '未填写说明'}</p>
                        <p className="small">许可声明：{item.rights_statement}</p>
                        <div className="voice-permission-row">
                          {Object.entries(item.permissions).map(([key, allowed]) => (
                            <span key={key} className={allowed ? 'voice-permission allowed' : 'voice-permission'}>{key}: {allowed ? '允许' : '不允许'}</span>
                          ))}
                        </div>
                        {item.effective_status === 'active' ? (
                          <button type="button" className="ghost danger" disabled={busy} onClick={() => void act(() => api.voiceRevokeSource(item.source_id, revokeReason), `已撤销 ${item.name}；依赖画像将显示失效。`)}>撤销此来源</button>
                        ) : (
                          <p className="narrative-warning small">{item.stale_reason ?? item.revoke_reason ?? '来源已失效'}。历史记录仍保留；不会静默重新启用。</p>
                        )}
                      </article>
                    ))}
                  </div>
                  <label className="narrative-field voice-revoke-reason"><span>撤销原因</span><input value={revokeReason} onChange={(event) => setRevokeReason(event.target.value)} /></label>
                </section>

                <section className="narrative-card">
                  <h3>登记合成来源</h3>
                  <p className="muted small">只引用 Vault 章节，不复制整本私稿；此处不会上传到任何模型或云服务。</p>
                  <label className="narrative-field"><span>名称</span><input value={source.name} onChange={(event) => setSource({ ...source, name: event.target.value })} /></label>
                  <label className="narrative-field"><span>说明</span><input value={source.description} onChange={(event) => setSource({ ...source, description: event.target.value })} /></label>
                  <label className="narrative-field"><span>作用域</span>
                    <select value={source.scope} onChange={(event) => setSource({ ...source, scope: event.target.value as VoiceScopeView })}>
                      <option value="project">本作品</option>
                      <option value="author">作者基础（仅显式选择）</option>
                      <option value="character">特定角色</option>
                    </select>
                  </label>
                  {(source.scope === 'character' || source.scope === 'scene') && (
                    <label className="narrative-field"><span>角色/场景名</span><input value={source.scopeRef} onChange={(event) => setSource({ ...source, scopeRef: event.target.value })} /></label>
                  )}
                  <label className="narrative-field"><span>权利声明</span><textarea rows={3} value={source.rightsStatement} onChange={(event) => setSource({ ...source, rightsStatement: event.target.value })} /></label>
                  <div className="voice-permission-form">
                    <label><input type="checkbox" checked={source.local} onChange={(event) => setSource({ ...source, local: event.target.checked })} /> 本地分析</label>
                    <label><input type="checkbox" checked={source.quote} onChange={(event) => setSource({ ...source, quote: event.target.checked })} /> 展示引用</label>
                    <label><input type="checkbox" checked={source.sample} onChange={(event) => setSource({ ...source, sample: event.target.checked })} /> 保存样本副本</label>
                  </div>
                  <p className="muted small">默认不授予跨作品复用、外部发送、公开发布；如需第三方参考，须由作者另行确认许可范围。</p>
                  <button type="button" className="primary" disabled={busy || !source.name.trim() || !source.rightsStatement.trim() || !source.local} onClick={() => void act(async () => {
                    const result = await api.voiceAddSource({
                      name: source.name,
                      description: source.description,
                      scope: source.scope,
                      scopeRef: source.scopeRef || null,
                      category: source.category,
                      rightsStatement: source.rightsStatement,
                      permissions: { local_analysis: source.local, quote_display: source.quote, sample_storage: source.sample },
                    });
                    return { voice: result.voice };
                  }, '来源已登记；只使用 Vault 章节引用，未复制私稿。')}>登记并分析</button>
                </section>
              </div>
            )}

            {tab === 'constitution' && (
              <div className="voice-grid">
                <section className="narrative-card">
                  <h3>待审建议 {voice.proposals.length > 0 && <span className="voice-count">{voice.proposals.length}</span>}</h3>
                  <p className="muted small">这些只是统计观察，不是写作规则；批准后才写入 Vault 的 Style Constitution。</p>
                  {voice.proposals.length === 0 ? <p className="muted">没有待审建议。</p> : (
                    <div className="voice-rule-list">
                      {voice.proposals.map((proposal) => (
                        <article key={proposal.proposal_id} className="voice-rule voice-rule-proposal">
                          <span className="narrative-badge is-inferred">观察 · {proposal.intent}</span>
                          <p>{proposal.text}</p>
                          <p className="muted small">{proposal.conditions}</p>
                          <p className="mono small">证据 {proposal.evidence_anchor_ids.length} · 来源 {proposal.source_ids.length}</p>
                          <button type="button" className="primary" disabled={busy} onClick={() => void act(() => api.voiceApprove(proposal.proposal_id), '已批准为风格规则；版本化写入 Vault。')}>批准为写作原则</button>
                        </article>
                      ))}
                    </div>
                  )}
                </section>

                <section className="narrative-card">
                  <h3>已批准宪章</h3>
                  <p className="muted small">规则属于作者；撤销或回退都会生成新版本，不覆盖历史。</p>
                  {voice.rules.length === 0 ? <p className="muted">尚无批准规则。</p> : (
                    <div className="voice-rule-list">
                      {voice.rules.map((rule) => (
                        <article key={rule.rule_id} className={`voice-rule voice-rule-${rule.effective_status}`}>
                          <div className="voice-rule-head">
                            <span className={`narrative-badge ${rule.effective_status === 'approved' ? 'is-author' : rule.effective_status === 'stale' ? 'is-disputed' : 'is-source'}`}>{rule.effective_status}</span>
                            <span className="mono small">v{rule.version} · {rule.scope}</span>
                          </div>
                          <p>{rule.text}</p>
                          <p className="muted small">{rule.conditions}</p>
                          {rule.stale_reason && <p className="narrative-warning small">{rule.stale_reason}；规则不可静默继续使用。</p>}
                          <div className="voice-rule-actions">
                            {rule.effective_status !== 'revoked' && <button type="button" className="ghost danger" disabled={busy} onClick={() => void act(() => api.voiceRevokeRule(rule.rule_id, '作者在 Voice Atelier 暂停此规则'), '规则已撤销并保留历史。')}>撤销</button>}
                            {rule.previous && <button type="button" className="ghost" disabled={busy} onClick={() => void act(() => api.voiceRollbackRule(rule.rule_id), '已回退到上一批准版本（新版本）。')}>回退上一版</button>}
                          </div>
                        </article>
                      ))}
                    </div>
                  )}
                </section>
              </div>
            )}

            {tab === 'compare' && (
              <div className="voice-grid">
                <section className="narrative-card">
                  <h3>两段文本的确定性对照</h3>
                  <p className="muted small">只比较可测量统计，不评判文学优劣，也不调用模型。</p>
                  <div className="voice-compare-columns">
                    <label className="narrative-field"><span>文本 A</span><textarea rows={8} value={compareA} onChange={(event) => setCompareA(event.target.value)} /></label>
                    <label className="narrative-field"><span>文本 B</span><textarea rows={8} value={compareB} onChange={(event) => setCompareB(event.target.value)} /></label>
                  </div>
                  <button type="button" className="primary" disabled={busy || !compareA.trim() || !compareB.trim()} onClick={() => void (async () => {
                    setBusy(true); setError('');
                    try { setComparison((await api.voiceCompare(compareA, compareB)).comparison); }
                    catch (caught) { setError(caught instanceof ApiError ? caught.message : String(caught)); }
                    finally { setBusy(false); }
                  })()}>比较统计</button>
                  {comparison && (
                    <table className="voice-compare-table">
                      <thead><tr><th>指标</th><th>A</th><th>B</th></tr></thead>
                      <tbody>
                        {Object.keys(comparison.a).map((key) => (
                          <tr key={key}><td>{key}</td><td>{Number(comparison.a[key]).toFixed(2)}</td><td>{Number(comparison.b[key]).toFixed(2)}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
                <section className="narrative-card">
                  <h3>如何阅读</h3>
                  <ul className="voice-reading-list">
                    <li>“对白占比”只认引号内字符；旁白式对白会低估。</li>
                    <li>“人物对白”只统计显式“某人说/问：…”；未知归属不会被强行分配。</li>
                    <li>短样本（少于 200 汉字）只标为“不足以判断”；不生成风格定律。</li>
                    <li>画像不是 canon，也不是风格宪章；批准规则需要作者动作。</li>
                  </ul>
                </section>
              </div>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}
