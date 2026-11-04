import { useState } from 'react';
import type { StoryOutlineView } from './api';

export default function AiOutlineView({ outline, source, busy, onSave, onDiscard }: { outline: StoryOutlineView; source: string; busy: boolean; onSave: (draft: string) => void; onDiscard: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(() => JSON.stringify(outline, null, 2));
  return (
    <div className="ai-outline">
      <div className="ai-outline-head">
        <div><p className="eyebrow">AI 骨架预览 · {source}</p><h3>{outline.title}</h3><p>{outline.logline}</p></div>
        <button className="ghost" onClick={() => setEditing((v) => !v)}>{editing ? '收起高级编辑' : '高级编辑'}</button>
      </div>
      <div className="ai-facts">
        <div><span>世界</span><p>{outline.world}</p></div>
        <div><span>主角</span><p>{outline.protagonist}</p></div>
        <div><span>对手</span><p>{outline.antagonist}</p></div>
        <div><span>主线冲突</span><p>{outline.main_conflict}</p></div>
      </div>
      <h4>人物</h4>
      <div className="ai-characters">{outline.characters.map((person) => <article key={`${person.name}-${person.role}`}><strong>{person.name}</strong><span>{person.role}</span><p>{person.goal}</p><p className="muted small">秘密：{person.secret}</p></article>)}</div>
      <h4>卷纲与章纲</h4>
      <div className="ai-volumes">{outline.volumes.map((vol) => <section key={vol.volume}><h5>{vol.title}</h5><ol>{vol.chapters.map((ch) => <li key={ch.chapter}><strong>{ch.title}</strong><span>{ch.goal}</span><small>{ch.conflict}</small></li>)}</ol></section>)}</div>
      {editing && <label className="narrative-field"><span>高级编辑（JSON，供需要时微调）</span><textarea className="ai-json" rows={12} value={draft} onChange={(e) => setDraft(e.target.value)} /></label>}
      <div className="coevolution-actions"><button className="primary" disabled={busy} onClick={() => onSave(editing ? draft : JSON.stringify(outline, null, 2))}>确认并保存为卷章规划草稿</button><button className="ghost" onClick={onDiscard}>放弃</button></div>
    </div>
  );
}
