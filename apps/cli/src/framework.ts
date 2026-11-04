import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openProject, readNarrativeCanon, writeNarrativeCanon, writePlanningState, writeFileAtomic, jsonBytes } from '@narrative-studio/core';
import { readPlanning } from '@narrative-studio/planning';
import { NarrativeStudioError, type NarrativeCanonBundle } from '@narrative-studio/contracts';
import { generateOutline, generateDiscussion, type StoryOutline } from './ai.js';
import { digest, readSession, saveSession } from './cowriting.js';
import type { CoOptions } from './cowriting.js';
export interface BookFramework extends StoryOutline {
    relationships?: Array<{
        from: string;
        to: string;
        kind: string;
        time: string;
    }>;
    timeline?: string[];
    foreshadowing?: string[];
}
const marker = 'cowriting-framework-v1';
export function readFramework(o: CoOptions) {
    const opened = openProject(o.vaultDir, o.projectId), planning = readPlanning(o);
    const idea = planning.state.ideas.find(i => i.theme === marker);
    return { proposalBaseRevision:readSession(o,'framework').frameworkBaseRevision,proposal:readSession(o,'framework').frameworkDraft??null,executionNote:readSession(o,'framework').executionNote,messages: readSession(o, 'framework').messages, outline: idea ? JSON.parse(idea.premise) as BookFramework : null, baseRevision: opened.manifest.revision, canon: readNarrativeCanon(opened.projectDir) };
}
export async function draftFramework(input: Record<string, unknown>, o?: CoOptions,signal?:AbortSignal) {
    const base=o?openProject(o.vaultDir,o.projectId).manifest.revision:undefined;
    if(input.baseRevision&&base!==input.baseRevision)throw new NarrativeStudioError('CAS_MISMATCH','规划已变化，请重新打开后整理；现稿未改变。');
    const idea = String(input.idea ?? '').slice(0, 4000), discussion=o?readSession(o,'framework').messages.filter(m=>m.kind==='discussion').slice(-6).map(m=>m.text.slice(0,400)).join('\n'):'', previous = input.outline ? JSON.stringify(input.outline).slice(0, 12000) : '';
    const result = await generateOutline({ idea: input.mock===true?idea:`${idea}\n近期讨论（仅供参考）：${discussion}\n已有草案（保留未要求修改的内容）：${previous}`, genre: '原创小说', volumes: Math.max(1,Math.min(6,Number(input.volumes)||1)), chaptersPerVolume: Math.max(1,Math.min(12,Number(input.chaptersPerVolume)||3)), consent: input.consent === true, mock: input.mock === true,signal });
    if(signal?.aborted)throw new NarrativeStudioError('INVALID_ARGUMENT','已停止，规划未改变');
    let outline: BookFramework = result.outline;
    if (input.mock === true && input.outline) {
        outline = structuredClone(input.outline as BookFramework);
        outline.main_conflict = idea;
        if(input.target==='world')outline.world=idea;
        if(input.target==='volumes'&&outline.volumes[0]?.chapters[0])outline.volumes[0].chapters[0].goal=idea;
        if(input.target==='characters'&&outline.characters[0])outline.characters[0].goal=idea;
        if(input.target==='relationships'&&outline.relationships?.[0])outline.relationships[0].kind=idea;
        if (/第三卷/.test(idea) && outline.volumes[2])
            outline.volumes[2].title = `第三卷 · ${idea.slice(0, 40)}`;
    }
    if(input.mock===true && [4,8,12].includes(Number(input.characterCount))){
      const count=Number(input.characterCount),oldCount=outline.characters.length;
      outline.characters=Array.from({length:count},(_,i)=>outline.characters[i]??{name:'江潮'+(i+1),role:i===2?'老船工':'调查同伴',goal:'守住第'+(i+1)+'份航路记录',secret:'只知道自己见过的片段'});
      if(count!==oldCount)outline.relationships=outline.characters.map((p,i)=>({from:p.name,to:outline.characters[(i+1)%count]!.name,kind:i%2?'共同调查':'互相试探',time:'第一卷'}));
    }
    outline.relationships ??= outline.characters.length >= 2 ? [{ from: outline.characters[0]!.name, to: outline.characters[1]!.name, kind: '互相试探', time: '开篇（待确认）' }] : [];
    outline.timeline ??= ['开篇：打破原有秩序', '中段：线索改变关系', '结局：选择与代价'];
    outline.foreshadowing ??= ['待作者补充伏笔与回收位置'];
    if(input.outline&&typeof input.target==='string'&&['characters','world','volumes','relationships','timeline','foreshadowing'].includes(input.target)){
      const key=input.target as keyof BookFramework;
      const existing=input.outline as BookFramework;
      outline={...structuredClone(existing),[key]:outline[key]};
      if(key==='characters'&&outline.relationships?.some(r=>!outline.characters.some(c=>c.name===r.from)||!outline.characters.some(c=>c.name===r.to)))throw new NarrativeStudioError('INVALID_ARGUMENT','人物变化涉及已有关系。请保留姓名，或选择整体方案一并预览；原规划未改动。');
    }
    if (o) {
        if(openProject(o.vaultDir,o.projectId).manifest.revision!==base)throw new NarrativeStudioError('CAS_MISMATCH','生成期间作品已变化，请重新整理。');
        const session = readSession(o, 'framework');
        saveSession(o, 'framework', { frameworkBaseRevision:base,frameworkDraft:outline,executionNote:String(input.idea??session.executionNote??''), candidate: null, messages: [...session.messages, { role: 'user' as const, text: idea, at: new Date().toISOString() }, { role: 'assistant' as const, text: `${result.source === 'mock' ? 'Mock 模拟' : 'DeepSeek'} · 提议：${outline.title} / ${outline.main_conflict}`, at: new Date().toISOString(), source: result.source }].slice(-100) });
    }
    return { ...result, outline };
}
export function saveFramework(o: CoOptions, input: Record<string, unknown>) {
    if (input.confirm !== true)
        throw new NarrativeStudioError('UNAUTHORIZED', 'AUTHOR_CONFIRMATION_REQUIRED');
    const outline = input.outline as BookFramework;
    if (!outline?.title || !Array.isArray(outline.characters) || !Array.isArray(outline.volumes))
        throw new NarrativeStudioError('INVALID_ARGUMENT', '无效新书框架');
    const names=outline.characters.map(p=>p.name.trim());if(names.some(n=>!n)||new Set(names).size!==names.length)throw new NarrativeStudioError('INVALID_ARGUMENT','人物姓名须非空且不重复');
    if(outline.relationships?.some(r=>!names.includes(r.from)||!names.includes(r.to)))throw new NarrativeStudioError('INVALID_ARGUMENT','关系引用了不存在的人物，请先修正姓名');
    const planning = readPlanning(o).state, now = new Date().toISOString(), prior = planning.ideas.find(i => i.theme === marker);
    const idea = { idea_id: prior?.idea_id ?? `idea_${randomUUID().replaceAll('-', '')}`, project_id: o.projectId, title: outline.title, premise: JSON.stringify(outline), theme: marker, protagonist_goal: outline.protagonist, conflict: outline.main_conflict, genre_ids: [], forbidden: [], reader_expectation: outline.logline, status: 'saved' as const, created_at: now };
    const prefix = 'coframework_';
    const plans = outline.volumes.flatMap(v => v.chapters.map(c => ({ plan_id: `${prefix}${v.volume}_${c.chapter}`, project_id: o.projectId, volume: v.volume, chapter: c.chapter, scene: 1, title: c.title, goal: c.goal, pov_entity_id: null, location: outline.world, cast: outline.characters.map(p => p.name), cause: '', action: '', result: '', suspense: '', risk: c.conflict, approval_state: 'author-approved' as const, base_chapter_revision: null, base_chapter_hash: null, genre_ids: [], created_at: now })));
    const result=writePlanningState({ ...o, baseRevision: String(input.baseRevision), value: { ...planning, ideas: [...planning.ideas.filter(i => i.theme !== marker), idea], plans: [...planning.plans.filter(p => !p.plan_id.startsWith(prefix)), ...plans] } });
    const session=readSession(o,'framework');saveSession(o,'framework',{...session,frameworkDraft:undefined});return result;
}
export function confirmFrameworkRelations(o: CoOptions, input: Record<string, unknown>) {
    if (input.confirm !== true)
        throw new NarrativeStudioError('UNAUTHORIZED', 'AUTHOR_CONFIRMATION_REQUIRED');
    const opened = openProject(o.vaultDir, o.projectId), now = new Date().toISOString();
    const old = readNarrativeCanon(opened.projectDir);
    const bundle: NarrativeCanonBundle = old ?? { schema_version: 1, bundle_id: `ncan_${randomUUID().replaceAll('-', '')}`, project_id: o.projectId, created_at: now, updated_at: now, entities: [], evidence: [], assertions: [], events: [], knowledge: [], relationships: [], foreshadowing: [] };
    const undoFile = path.join(o.appDataRoot, 'projects', o.projectId, 'framework-relations-undo.json');
    if (input.undo === true) {
        if (!fs.existsSync(undoFile))
            throw new NarrativeStudioError('INVALID_ARGUMENT', '没有可撤销的关系批次');
        const undo = JSON.parse(fs.readFileSync(undoFile, 'utf8')) as {
            previous: NarrativeCanonBundle;
            afterHash: string;
            used: boolean;
        };
        if (undo.used || digest(jsonBytes(bundle).toString()) !== undo.afterHash)
            throw new NarrativeStudioError('CAS_MISMATCH', '关系已发生后续变化，不能覆盖；请对比版本后处理');
        const result = writeNarrativeCanon({ ...o, baseRevision: String(input.baseRevision), bundle: undo.previous });
        writeFileAtomic(undoFile, Buffer.from(JSON.stringify({ ...undo, used: true })));
        return result;
    }
    const framework = readFramework(o).outline;
    if (!framework)
        throw new NarrativeStudioError('INVALID_ARGUMENT', '请先确认保存框架');
    const entities = [...bundle.entities];
    for (const p of framework.characters)
        if (!entities.some(e => e.name === p.name))
            entities.push({ entity_id: `ent_${randomUUID().replaceAll('-', '')}`, name: p.name, kind: 'person', aliases: [], description: p.goal, status: 'author-confirmed', evidence_anchor_ids: [] });
    const relations = (framework.relationships ?? []).map((r, i) => {
        const from = entities.find(e => e.name === r.from), to = entities.find(e => e.name === r.to);
        if (!from || !to)
            throw new NarrativeStudioError('INVALID_ARGUMENT', '关系人物不存在');
        return { relationship_id: `rel_coframework_${i}`, from_entity_id: from.entity_id, to_entity_id: to.entity_id, kind: `${r.kind} · ${r.time} · 作者设定`, status: 'author-confirmed' as const, valid_from_order: 1, valid_to_order: null, evidence_anchor_ids: [] };
    });
    const previous = structuredClone(bundle);
    const nextBundle = { ...bundle, updated_at: now, entities, relationships: [...bundle.relationships.filter(r => !r.relationship_id.startsWith('rel_coframework_')), ...relations] };
    fs.mkdirSync(path.dirname(undoFile), { recursive: true });
    writeFileAtomic(undoFile, Buffer.from(JSON.stringify({ previous, afterHash: digest(jsonBytes(nextBundle).toString()), used: false })));
    const result = writeNarrativeCanon({ ...o, baseRevision: String(input.baseRevision), bundle: nextBundle, now: () => new Date(now) });
    return result;
}

export async function discussFramework(o:CoOptions,input:Record<string,unknown>,signal?:AbortSignal,onToken?:(text:string)=>void){
 const message=String(input.message??'').trim().slice(0,3000);if(!message)throw new NarrativeStudioError('INVALID_ARGUMENT','请输入讨论问题');
 const session=readSession(o,'framework');const result=await generateDiscussion({context:JSON.stringify(input.outline??readFramework(o).outline??{}).slice(0,6000),message,history:session.messages.slice(-6).map(m=>m.role+': '+m.text.slice(0,400)).join('\n'),mock:input.mock===true,consent:input.consent===true,signal,onToken});
 if(signal?.aborted)throw new NarrativeStudioError('INVALID_ARGUMENT','已停止，规划未改变');
 const next={...session,executionNote:String(input.executionNote||session.executionNote||message).slice(0,3000),messages:[...session.messages,{role:'user' as const,text:message,kind:'discussion' as const,at:new Date().toISOString()},{role:'assistant' as const,text:result.text,source:result.source,kind:'discussion' as const,at:new Date().toISOString()}].slice(-100)};saveSession(o,'framework',next);return next;
}
