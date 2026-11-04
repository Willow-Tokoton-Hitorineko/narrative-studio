import { useCallback, useEffect, useMemo, useState } from 'react';
import { layoutRelationshipGraph } from './graphLayout';
import {
  api,
  type ChapterSummary,
  type EvidenceAnchor,
  type NarrativeOverview,
  type NarrativeSearchHit,
} from './api';

type Tab = 'overview' | 'graph' | 'timeline' | 'clues' | 'candidates' | 'evidence';

interface NarrativePanelProps {
  open: boolean;
  projectTitle: string;
  chapters: ChapterSummary[];
  currentChapterId: string | null;
  onClose: () => void;
  onJump: (chapterId: string, quote: string) => void;
}

const TAB_LABELS: Record<Tab, string> = {
  overview: '概览',
  graph: '人物关系',
  timeline: '双时间线',
  clues: '伏笔',
  candidates: '候选',
  evidence: '原文证据',
};

function statusLabel(status: string): string {
  if (status === 'author-confirmed') return '作者确认';
  if (status === 'inferred') return '推断';
  if (status === 'source-extracted') return '原文抽取';
  if (status === 'disputed') return '存在争议';
  return status;
}

function statusClass(status: string): string {
  if (status === 'author-confirmed') return 'is-confirmed';
  if (status === 'disputed') return 'is-disputed';
  return 'is-candidate';
}

function exportGraphSvg(context: { chapterId: string | null; sourceRevision: string; entityId: string | null }): void {
  const svg = document.querySelector<SVGSVGElement>('.relationship-graph');
  if (!svg) return;
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const originals = [svg, ...Array.from(svg.querySelectorAll<SVGElement>('*'))];
  const clones = [clone, ...Array.from(clone.querySelectorAll<SVGElement>('*'))];
  for (let index = 0; index < originals.length; index++) {
    const original = originals[index]!;
    const target = clones[index]!;
    if (!(original instanceof Element) || !(target instanceof Element)) continue;
    const style = window.getComputedStyle(original);
    for (const prop of ['fill', 'stroke', 'stroke-width', 'stroke-dasharray', 'opacity', 'font-family', 'font-size', 'font-weight', 'text-anchor']) {
      const value = style.getPropertyValue(prop);
      if (value && value !== 'none') target.setAttribute(prop, value);
    }
  }
  const rootStyle = window.getComputedStyle(document.documentElement);
  const paper = rootStyle.getPropertyValue('--paper').trim() || '#fffefc';
  const ink = rootStyle.getPropertyValue('--ink').trim() || '#252933';
  const muted = rootStyle.getPropertyValue('--muted').trim() || '#666f7b';
  const accent = rootStyle.getPropertyValue('--accent').trim() || '#566690';
  const danger = rootStyle.getPropertyValue('--danger').trim() || '#a7463f';
  const meta = document.createElementNS('http://www.w3.org/2000/svg', 'metadata');
  meta.textContent = `Narrative Studio Atlas export; generated=${new Date().toISOString()}; chapter=${context.chapterId ?? 'unknown'}; source_revision=${context.sourceRevision || 'unknown'}; selected_entity=${context.entityId ?? 'none'}; filter=current-chapter-visible-relationships; status_legend=solid author-confirmed, dashed disputed/stale`;
  clone.prepend(meta);
  const legend = document.createElementNS('http://www.w3.org/2000/svg', 'g');
  legend.setAttribute('transform', 'translate(16, 16)');
  legend.innerHTML = `<rect x="0" y="0" width="300" height="62" rx="6" fill="${paper}" stroke="${muted}" opacity="0.96"/><text x="10" y="22" fill="${ink}" font-family="Microsoft YaHei, sans-serif" font-size="13">图例 · 当前章筛选 ${context.chapterId ?? 'unknown'}</text><line x1="12" y1="40" x2="54" y2="40" stroke="${accent}" stroke-width="2"/><text x="62" y="44" fill="${ink}" font-family="Microsoft YaHei, sans-serif" font-size="12">作者确认</text><line x1="150" y1="40" x2="192" y2="40" stroke="${danger}" stroke-width="2" stroke-dasharray="5 4"/><text x="200" y="44" fill="${ink}" font-family="Microsoft YaHei, sans-serif" font-size="12">争议/失效</text>`;
  clone.append(legend);
  const blob = new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `narrative-atlas-${Date.now()}.svg`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export default function NarrativePanel(props: NarrativePanelProps) {
  const { open, projectTitle, chapters, currentChapterId, onClose, onJump } = props;
  const [overview, setOverview] = useState<NarrativeOverview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('overview');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<NarrativeSearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceAnchor[]>([]);
  const [selectedCharacter, setSelectedCharacter] = useState('ent_linyan01');
  const [selectedEntity, setSelectedEntity] = useState<string | null>(null);

  const currentOrder = useMemo(
    () => chapters.find((chapter) => chapter.chapter_id === currentChapterId)?.ordinal ?? null,
    [chapters, currentChapterId],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api.narrative();
      setOverview(data);
      if (currentChapterId) {
        const chapter = await api.narrativeChapter(currentChapterId);
        setEvidence(chapter.evidence);
      } else {
        setEvidence([]);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  }, [currentChapterId]);

  useEffect(() => {
    if (!open) return;
    void load();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, load, onClose]);

  useEffect(() => {
    if (!open || !currentChapterId) return;
    void api.narrativeChapter(currentChapterId).then((data) => setEvidence(data.evidence)).catch(() => setEvidence([]));
  }, [open, currentChapterId]);

  if (!open) return null;

  const anchorById = new Map((overview?.evidence ?? []).map((anchor) => [anchor.anchor_id, anchor]));
  const entityById = new Map((overview?.entities ?? []).map((entity) => [entity.entity_id, entity]));
  const currentEvidence = currentChapterId
    ? evidence.length > 0
      ? evidence
      : (overview?.evidence ?? []).filter((anchor) => anchor.chapter_id === currentChapterId)
    : [];
  const knownAssertions = new Set(
    (overview?.knowledge ?? [])
      .filter((entry) => entry.character_id === selectedCharacter && currentOrder !== null && entry.learns_at_order <= currentOrder)
      .map((entry) => entry.assertion_id),
  );
  const visibleAssertions = (overview?.assertions ?? []).filter(
    (assertion) => currentOrder === null || assertion.reveal_order <= currentOrder,
  );
  const hiddenAssertionCount = (overview?.assertions ?? []).length - visibleAssertions.length;
  const visibleEvents = (overview?.events ?? []).filter(
    (event) => currentOrder === null || event.chapter_order <= currentOrder,
  );
  // Inclusive interval: from <= order <= to; null end means still active.
  const visibleRelationships = (overview?.relationships ?? []).filter(
    (relationship) => currentOrder === null
      || (relationship.valid_from_order <= currentOrder
        && (relationship.valid_to_order === null || currentOrder <= relationship.valid_to_order)),
  );
  const visibleClues = (overview?.foreshadowing ?? []).filter(
    (clue) => currentOrder === null || clue.setup_order <= currentOrder,
  );
  const visibleCandidates = (overview?.candidates ?? []).filter(
    (candidate) => currentOrder === null || candidate.chapter_order <= currentOrder,
  );

  const jumpToAnchor = (anchorId: string | undefined) => {
    if (!anchorId) return;
    const anchor = anchorById.get(anchorId);
    if (anchor) onJump(anchor.chapter_id, anchor.quote);
  };

  const search = async () => {
    const text = query.trim();
    if (!text) {
      setResults(null);
      return;
    }
    setSearching(true);
    try {
      const data = await api.narrativeSearch(text, currentOrder);
      setResults(data.results);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSearching(false);
    }
  };

  const confirmCandidate = async (candidateId: string) => {
    if (!window.confirm('确认把这条候选写入作者 canon？候选不会自动升级；这次操作会生成新的作者确认事实。')) return;
    setLoading(true);
    try {
      await api.confirmNarrativeCandidate(candidateId);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  const reindex = async () => {
    setLoading(true);
    try {
      await api.reindexNarrative(currentChapterId, false);
      await load();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="narrative-overlay" role="dialog" aria-modal="true" aria-label="叙事图谱与原文证据">
      <section className="narrative-panel">
        <header className="narrative-head">
          <div>
            <p className="eyebrow">Gate 2 · 叙事记忆与证据</p>
            <h2>{projectTitle} · 证据地图</h2>
            <p className="muted small">
              {overview
                ? `索引 ${overview.status === 'current' ? '已同步' : overview.status} · ${overview.counts.chapters ?? 0} 章 · ${overview.counts.evidence ?? 0} 条证据 · 过期 ${overview.stale_evidence}${overview.pending_chapters > 0 ? ` · ${overview.pending_chapters} 章待更新` : ''}`
                : loading
                  ? '正在读取本地索引…'
                  : '尚未建立索引'}
            </p>
          </div>
          <div className="narrative-head-actions">
            <button type="button" className="ghost" onClick={() => void reindex()} disabled={loading}>
              只更新本章
            </button>
            <button type="button" className="ghost" onClick={onClose} autoFocus>关闭</button>
          </div>
        </header>

        <div className="narrative-tools">
          <div className="narrative-tabs" role="tablist" aria-label="叙事视图">
            {(Object.keys(TAB_LABELS) as Tab[]).map((key) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={tab === key}
                className={tab === key ? 'active' : ''}
                onClick={() => setTab(key)}
              >
                {TAB_LABELS[key]}
              </button>
            ))}
          </div>
          <form
            className="narrative-search"
            onSubmit={(event) => {
              event.preventDefault();
              void search();
            }}
          >
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="检索人物、短别名、原文片段…"
              aria-label="检索叙事记忆"
            />
            <button type="submit" className="ghost" disabled={searching}>{searching ? '检索中' : '检索'}</button>
          </form>
        </div>

        {error && <p className="narrative-error" role="alert">{error}</p>}
        {overview && overview.pending_chapters > 0 && (
          <p className="narrative-warning" role="status">
            索引落后于 Vault：{overview.pending_chapters} 章尚未按当前修订更新；请先重建/补齐后再把结果视为已同步。
          </p>
        )}
        {overview && overview.canon_stale && (
          <p className="narrative-warning" role="status">
            作者 canon 已更新，索引尚未刷新别名/事实；请重建索引后再信任当前图谱。
          </p>
        )}
        {overview && overview.stale_evidence > 0 && (
          <p className="narrative-warning" role="status">
            有 {overview.stale_evidence} 条证据在正文修改后失效或待重定位；未确认旧位置不会被当作最新证据。
          </p>
        )}

        {results !== null && (
          <section className="narrative-search-results" aria-label="检索结果">
            <div className="narrative-section-head">
              <h3>检索结果 · {results.length}</h3>
              <button type="button" className="link" onClick={() => setResults(null)}>清除</button>
            </div>
            {results.length === 0 && <p className="muted">没有匹配；检索只在本机索引中执行。</p>}
            {results.map((hit) => (
              <button
                key={`${hit.chapter_id}:${hit.score}`}
                type="button"
                className="search-hit"
                onClick={() => {
                  const match = hit.matches.find((entry) => entry.kind === 'exact' || entry.kind === 'alias');
                  if (match) onJump(hit.chapter_id, match.exact);
                }}
              >
                <span className="search-hit-head">
                  <strong>{hit.chapter_order}. {hit.title}</strong>
                  <span className="muted mono">
                    {hit.matches.some((match) => match.kind === 'exact' || match.kind === 'alias')
                      ? '精确/别名'
                      : '相关章节 · 无精确原文定位'} · 匹配 {hit.score}
                  </span>
                </span>
                <span className="search-hit-quote">
                  {hit.matches[0]?.quote ?? 'n-gram 相关召回；未发现可验证的原文 span。'}
                </span>
              </button>
            ))}
          </section>
        )}

        <div className="narrative-body">
          {tab === 'overview' && (
            <div className="narrative-grid">
              <section className="narrative-card">
                <h3>索引状态</h3>
                <dl className="narrative-stats">
                  <div><dt>章节</dt><dd>{overview?.counts.chapters ?? 0}</dd></div>
                  <div><dt>人物/实体</dt><dd>{overview?.counts.entities ?? 0}</dd></div>
                  <div><dt>事实断言</dt><dd>{overview?.counts.assertions ?? 0}</dd></div>
                  <div><dt>证据</dt><dd>{overview?.counts.evidence ?? 0}</dd></div>
                  <div><dt>候选</dt><dd>{overview?.counts.candidates ?? 0}</dd></div>
                  <div><dt>过期证据</dt><dd>{overview?.stale_evidence ?? 0}</dd></div>
                </dl>
                <p className="muted small">
                  来源版本 <span className="mono">{overview?.source_revision?.slice(0, 22) ?? '—'}</span>
                </p>
              </section>

              <section className="narrative-card">
                <h3>本章视角知情</h3>
                <label className="narrative-field">
                  <span>人物</span>
                  <select value={selectedCharacter} onChange={(event) => setSelectedCharacter(event.target.value)}>
                    {(overview?.entities ?? []).filter((entity) => entity.kind === 'person').map((entity) => (
                      <option key={entity.entity_id} value={entity.entity_id}>{entity.name}</option>
                    ))}
                  </select>
                </label>
                {currentOrder === null ? (
                  <p className="muted">先选择章节，才能按叙事顺序过滤知情范围。</p>
                ) : (
                  <ul className="narrative-list">
                    {(overview?.assertions ?? [])
                      .filter((assertion) => assertion.reveal_order <= currentOrder)
                      .map((assertion) => {
                        const known = knownAssertions.has(assertion.assertion_id);
                        const subject = entityById.get(assertion.subject_id)?.name ?? assertion.subject_id;
                        return (
                          <li key={assertion.assertion_id} className={known ? '' : 'is-unknown'}>
                            <span className={`narrative-badge ${statusClass(assertion.status)}`}>{statusLabel(assertion.status)}</span>
                            <span>{subject} · {assertion.predicate} · {assertion.value ?? entityById.get(assertion.object_id ?? '')?.name ?? '—'}</span>
                            <span className="muted small">{known ? '此人已知' : '此人未知/未确认'}</span>
                          </li>
                        );
                      })}
                  </ul>
                )}
                <p className="muted small">未知不等于“没有发生”；界面不把未知情内容写成权威事实。</p>
              </section>

              <section className="narrative-card">
                <h3>事实状态</h3>
                <ul className="narrative-list">
                  {visibleAssertions.slice(0, 12).map((assertion) => (
                    <li key={assertion.assertion_id}>
                      <span className={`narrative-badge ${statusClass(assertion.status)}`}>{statusLabel(assertion.status)}</span>
                      <span>{entityById.get(assertion.subject_id)?.name ?? assertion.subject_id} · {assertion.predicate} · {assertion.value ?? entityById.get(assertion.object_id ?? '')?.name ?? '—'}</span>
                      <button type="button" className="link" onClick={() => jumpToAnchor(assertion.evidence_anchor_ids[0])}>原文</button>
                    </li>
                  ))}
                </ul>
                {hiddenAssertionCount > 0 && (
                  <p className="muted small">另有 {hiddenAssertionCount} 条事实将在后续章节揭示，当前时点不展示内容。</p>
                )}
              </section>
            </div>
          )}

          {tab === 'graph' && (
            <div className="narrative-grid narrative-grid-wide">
              <section className="narrative-card">
                <div className="narrative-section-head">
                  <h3>人物关系</h3>
                  <span className="muted small">实线=作者确认；虚线/红=争议；仅显示当前章时点仍有效的关系（终止关系不冒充当前）。</span>
                  <button type="button" className="ghost" onClick={() => exportGraphSvg({ chapterId: currentChapterId, sourceRevision: overview?.source_revision ?? "unknown", entityId: selectedEntity })}>导出当前图谱 SVG</button>
                </div>
                <RelationshipGraph
                  overview={overview}
                  selectedEntity={selectedEntity}
                  onSelectEntity={setSelectedEntity}
                  onJumpAnchor={jumpToAnchor}
                  relationships={visibleRelationships}
                />
              </section>
              <section className="narrative-card">
                <h3>实体</h3>
                <ul className="narrative-list">
                  {(overview?.entities ?? []).map((entity) => (
                    <li key={entity.entity_id} className={selectedEntity === entity.entity_id ? 'selected' : ''}>
                      <button type="button" className="link entity-name" onClick={() => setSelectedEntity(entity.entity_id)}>{entity.name}</button>
                      <span className="muted small">{entity.kind} · {entity.aliases.join('、') || '无别名'}</span>
                      <span className="muted small">{entity.description}</span>
                    </li>
                  ))}
                </ul>
              </section>
            </div>
          )}

          {tab === 'timeline' && (
            <div className="narrative-card">
              <h3>故事时间 / 叙述顺序</h3>
              <div className="timeline-head">
                <span>故事时间（发生顺序）</span>
                <span>叙述顺序（读者读到）</span>
              </div>
              <div className="timeline-columns">
                <div>
                  {[...visibleEvents].sort((left, right) => (left.story_time.sort_key ?? 0) - (right.story_time.sort_key ?? 0)).map((event) => (
                    <button key={`story-${event.event_id}`} type="button" className={`timeline-event kind-${event.kind}`} onClick={() => jumpToAnchor(event.evidence_anchor_ids[0])}>
                      <span className="timeline-time">{event.story_time.label}</span>
                      <strong>{event.description}</strong>
                      <span className="muted small">叙述第 {event.chapter_order} 章 · {event.kind === 'flashback' ? '倒叙' : event.kind === 'reveal' ? '揭示' : '顺叙'}</span>
                    </button>
                  ))}
                </div>
                <div>
                  {[...visibleEvents].sort((left, right) => left.chapter_order - right.chapter_order).map((event) => (
                    <button key={`narr-${event.event_id}`} type="button" className={`timeline-event kind-${event.kind}`} onClick={() => jumpToAnchor(event.evidence_anchor_ids[0])}>
                      <span className="timeline-time">第 {event.chapter_order} 章</span>
                      <strong>{event.description}</strong>
                      <span className="muted small">故事时间 {event.story_time.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'clues' && (
            <div className="narrative-grid">
              {visibleClues.map((clue) => (
                <section className="narrative-card" key={clue.clue_id}>
                  <div className="narrative-section-head">
                    <h3>{clue.label}</h3>
                    <span className={`narrative-badge ${clue.status === 'paid-off' ? 'is-confirmed' : 'is-candidate'}`}>
                      {clue.status === 'paid-off' ? '已回收' : clue.status === 'open' ? '未回收' : clue.status}
                    </span>
                  </div>
                  <p className="muted">埋设：第 {clue.setup_order} 章 · 回收：{clue.payoff_order ?? '—'} 章</p>
                  <div className="narrative-link-row">
                    <button type="button" className="link" onClick={() => jumpToAnchor(clue.setup_evidence_anchor_ids[0])}>看埋设原文</button>
                    <button type="button" className="link" onClick={() => jumpToAnchor(clue.payoff_evidence_anchor_ids[0])}>看回收原文</button>
                  </div>
                </section>
              ))}
              {visibleClues.length === 0 && <p className="muted">当前章节之前还没有作者确认的伏笔。</p>}
            </div>
          )}

          {tab === 'candidates' && (
            <div className="narrative-card">
              <div className="narrative-section-head">
                <h3>候选事实队列</h3>
                <span className="narrative-badge is-candidate">未确认 · 不得当作权威</span>
              </div>
              <p className="muted small">这些是从正文规则推断的候选。它们只存在于本机投影，不会自动写入 canon，也不会改变正文。</p>
              <ul className="narrative-list">
                {visibleCandidates.map((candidate) => (
                  <li key={candidate.candidate_id}>
                    <span className="narrative-badge is-candidate">{statusLabel(candidate.status)}</span>
                    <span>
                      {candidate.text}
                      <span className="muted small candidate-meta">第 {candidate.chapter_order} 章 · 规则 {candidate.rule}</span>
                    </span>
                    <span className="narrative-actions">
                      <button type="button" className="link" onClick={() => onJump(candidate.chapter_id, candidate.quote)}>原文</button>
                      <button type="button" className="link" disabled={loading} onClick={() => void confirmCandidate(candidate.candidate_id)}>作者确认</button>
                    </span>
                  </li>
                ))}
                {visibleCandidates.length === 0 && <li className="muted">当前章节没有候选。</li>}
              </ul>
            </div>
          )}

          {tab === 'evidence' && (
            <div className="narrative-card">
              <div className="narrative-section-head">
                <h3>本章原文证据</h3>
                <span className="muted small">{currentChapterId ?? '未选择章节'} · {currentEvidence.length} 条</span>
              </div>
              <p className="muted small">证据锚点绑定章节、修订、字符范围与 SHA-256；正文修改后旧位置会自动标为 stale/missing。</p>
              <ul className="evidence-list">
                {currentEvidence.map((anchor) => (
                  <li key={anchor.anchor_id} className={`evidence-anchor status-${anchor.status}`}>
                    <div className="evidence-meta">
                      <span className={`narrative-badge ${anchor.status === 'current' ? 'is-confirmed' : 'is-disputed'}`}>{anchor.status}</span>
                      <span className="mono small">{anchor.revision_id} · {anchor.start_offset}–{anchor.end_offset}</span>
                    </div>
                    <blockquote>{anchor.quote}</blockquote>
                    <div className="evidence-meta">
                      <span className="mono small">{anchor.quote_hash.slice(0, 22)}…</span>
                      <button type="button" className="link" onClick={() => onJump(anchor.chapter_id, anchor.quote)}>定位正文</button>
                    </div>
                    {anchor.note && <p className="muted small">{anchor.note}</p>}
                  </li>
                ))}
                {currentEvidence.length === 0 && <li className="muted">本章没有关联证据。</li>}
              </ul>
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function RelationshipGraph(props: {
  overview: NarrativeOverview | null;
  selectedEntity: string | null;
  onSelectEntity: (id: string) => void;
  onJumpAnchor: (id: string | undefined) => void;
  relationships: NarrativeOverview['relationships'];
}) {
  const { overview, selectedEntity, onSelectEntity, onJumpAnchor, relationships } = props;
  const people = (overview?.entities ?? []).filter((entity) => entity.kind === 'person');
  const layout = layoutRelationshipGraph(
    people.map((entity) => ({ entity_id: entity.entity_id, name: entity.name, aliases: entity.aliases })),
    relationships.map((relationship) => ({
      relationship_id: relationship.relationship_id,
      from_entity_id: relationship.from_entity_id,
      to_entity_id: relationship.to_entity_id,
      kind: relationship.kind,
      status: relationship.status,
      evidence_anchor_ids: relationship.evidence_anchor_ids,
    })),
  );
  if (layout.nodes.length === 0) {
    return <p className="muted">当前章时点没有可绘制的人物关系。</p>;
  }
  return (
    <svg
      className="relationship-graph"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      role="img"
      aria-label="人物关系图"
      data-graph-width={layout.width}
      data-graph-height={layout.height}
    >
      <defs>
        <marker id="arrow-confirmed" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--accent)" />
        </marker>
        <marker id="arrow-disputed" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" fill="var(--danger)" />
        </marker>
      </defs>
      <rect className="relationship-canvas" x="0" y="0" width={layout.width} height={layout.height} rx="8" />
      {layout.edges.map((edge) => {
        const lineOpacity = selectedEntity && edge.from !== selectedEntity && edge.to !== selectedEntity ? 0.22 : 0.82;
        const firstLineY = edge.label.y - (edge.label.lines.length - 1) * 7.5;
        return (
          <g key={edge.id} className="relationship-edge" data-edge-id={edge.id} data-relationship-id={edge.id} data-edge-label={edge.label.lines.join(' ')}>
            <line
              x1={edge.start.x}
              y1={edge.start.y}
              x2={edge.end.x}
              y2={edge.end.y}
              stroke={edge.disputed ? 'var(--danger)' : 'var(--accent)'}
              strokeWidth={edge.disputed ? 1.5 : 2}
              strokeDasharray={edge.disputed ? '6 5' : undefined}
              markerEnd={`url(#arrow-${edge.disputed ? 'disputed' : 'confirmed'})`}
              opacity={lineOpacity}
            />
            <g
              className="relationship-label-group"
              data-label-id={edge.id}
              data-label-x={edge.label.x}
              data-label-y={edge.label.y}
              data-label-width={edge.label.width}
              data-label-height={edge.label.height}
            >
              <rect
                className="relationship-label-bg"
                x={edge.label.x - edge.label.width / 2}
                y={edge.label.y - edge.label.height / 2}
                width={edge.label.width}
                height={edge.label.height}
                rx="4"
              />
              <text x={edge.label.x} y={firstLineY} textAnchor="middle" className="relationship-label">
                {edge.label.lines.map((line, index) => (
                  <tspan key={`${edge.id}-${line}-${index}`} x={edge.label.x} dy={index === 0 ? 0 : 15}>{line}</tspan>
                ))}
              </text>
            </g>
            <circle
              cx={edge.anchor.x}
              cy={edge.anchor.y}
              r={6}
              className="relationship-anchor"
              data-anchor-for={edge.id}
              data-anchor-x={edge.anchor.x}
              data-anchor-y={edge.anchor.y}
              tabIndex={0}
              role="button"
              aria-label={`查看${edge.kind}的原文证据`}
              onClick={() => onJumpAnchor(edge.anchorId)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') onJumpAnchor(edge.anchorId);
              }}
            >
              <title>查看{edge.kind}的原文证据</title>
            </circle>
          </g>
        );
      })}
      {layout.nodes.map((node) => {
        const nameStartY = -(node.height / 2) + 23;
        const aliasStartY = nameStartY + node.nameLines.length * 19 + 4;
        const entity = people.find((item) => item.entity_id === node.id);
        return (
          <g
            key={node.id}
            className={`relationship-node ${selectedEntity === node.id ? 'selected' : ''}`}
            transform={`translate(${node.center.x},${node.center.y})`}
            data-node-id={node.id}
            data-node-name={node.name}
            data-node-x={node.center.x}
            data-node-y={node.center.y}
            data-node-width={node.width}
            data-node-height={node.height}
            tabIndex={0}
            role="button"
            aria-label={`选择 ${node.name}${node.aliases.length > 0 ? `，别名 ${node.aliases.join('、')}` : ''}`}
            onClick={() => onSelectEntity(node.id)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' || event.key === ' ') onSelectEntity(node.id);
            }}
          >
            <title>
              {node.name}
              {node.aliases.length > 0 ? `（别名：${node.aliases.join('、')}）` : ''}
              {entity?.description ? ` — ${entity.description}` : ''}
            </title>
            <rect
              className="relationship-node-box"
              x={-node.width / 2}
              y={-node.height / 2}
              width={node.width}
              height={node.height}
              rx="10"
            />
            <text textAnchor="middle" className="relationship-node-name">
              {node.nameLines.map((line, index) => (
                <tspan key={`${node.id}-name-${index}`} x="0" y={nameStartY + index * 19}>{line}</tspan>
              ))}
            </text>
            {node.aliasLines.length > 0 && (
              <text textAnchor="middle" className="relationship-alias">
                {node.aliasLines.map((line, index) => (
                  <tspan key={`${node.id}-alias-${index}`} x="0" y={aliasStartY + index * 13}>{line}</tspan>
                ))}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
}