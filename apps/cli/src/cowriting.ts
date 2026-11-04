import { reviewChineseProse, refineMockProse } from './prose-review.js';
import {writingContext} from './writing-context.js';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { approveProposal, createProposal, openProject, readChapterBytes, readProposal, writeFileAtomic, readRevision, revisionRelPaths, resolveInside, commitChapter } from '@narrative-studio/core';
import { NarrativeStudioError } from '@narrative-studio/contracts';
import { compileContinuation, createCandidate } from '@narrative-studio/continuation';
import { readVoiceOverview } from '@narrative-studio/voice';
import { generateContinuation, generateDiscussion } from './ai.js';
export const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
export interface CoMessage {
    role: 'user' | 'assistant';
    text: string;
    at: string;
    source?: string;
    kind?: 'discussion'|'candidate'|'refinement';
}
export interface CoCandidate {
    note?: string;
    refinedFrom?: {id:string;text:string};
    applied?: string;
    id: string;
    chapterId: string;
    projectId: string;
    baseRevision: string;
    baseText: string;
    start: number;
    end: number;
    text: string;
    previewHash: string;
    source: string;
    model: string;
    reviews: Array<{
        dimension: string;
        severity: string;
        reason: string;
    }>;
    blocking: boolean;
    style: string;
}
export interface CoSession {
    frameworkDraft?: unknown;
    frameworkBaseRevision?: string;
    executionNote?:string;
    messages: CoMessage[];
    candidate: CoCandidate | null;
}
export interface CoOptions {
    vaultDir: string;
    projectId: string;
    appDataRoot: string;
}
function fail(message: string): never { throw new NarrativeStudioError('INVALID_ARGUMENT', message); }
function sessionPath(o: CoOptions, chapterId: string): string {
    if (!/^[a-zA-Z0-9_]+$/.test(chapterId))
        fail('无效章节');
    return path.join(o.appDataRoot, 'projects', o.projectId, 'cowriting', `${chapterId}.json`);
}
export function readSession(o: CoOptions, chapterId: string): CoSession {
    const file = sessionPath(o, chapterId);
    return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as CoSession : { messages: [], candidate: null };
}
export function saveSession(o: CoOptions, chapterId: string, session: CoSession): void {
    const file = sessionPath(o, chapterId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    writeFileAtomic(file, Buffer.from(JSON.stringify(session)));
}
export function clearSession(o: CoOptions, chapterId: string): void { saveSession(o, chapterId, { messages: [], candidate: null }); }
export async function generateCoCandidate(o: CoOptions, input: Record<string, unknown>, signal?: AbortSignal, onToken?: (text: string) => void): Promise<CoSession> {
    const chapterId = String(input.chapterId);
    const opened = openProject(o.vaultDir, o.projectId);
    if (!opened.manifest.chapters[chapterId])
        fail('章节不属于当前作品');
    const baseText = readChapterBytes(opened.projectDir, chapterId).toString('utf8');
    if (input.baseRevision !== opened.manifest.revision || input.baseHash !== digest(baseText))
        fail('STALE_BASE：正文已变化，请保存后重新生成');
    const start = Number(input.start), end = Number(input.end);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || end > baseText.length)
        fail('无效授权范围');
    const instruction = String(input.instruction ?? '').trim().slice(0, 3000);
    if (!instruction)
        fail('请输入意图');
    if (signal?.aborted)
        fail('已取消');
    const session = readSession(o, chapterId);
    const compiled = compileContinuation({ vaultDir: o.vaultDir, projectId: o.projectId, chapterId, start, end, task: instruction, budgetTokens: 2400 });
    if (compiled.compiled.context.status !== 'compiled') fail('本次范围超出上下文预算，请缩小选区后重试；正文未改动。');
    const voice = readVoiceOverview({ vaultDir: o.vaultDir, projectId: o.projectId, appDataRoot: o.appDataRoot });
    const styles = voice.rules.filter(r => r.effective_status === 'approved' && (r.scope === 'project' || r.scope === 'author') && r.source_ids.every(id => voice.sources.some(s => s.source_id === id && s.effective_status === 'active' && (input.mock === true || s.permissions.external_send === true))));
    const style = styles.length ? styles.map(r => `${r.rule_id} v${r.version}：${r.text}`).join('\n') : '尚无风格样本，本次未执行风格匹配';
    const recent = session.messages.filter(m=>m.kind==='discussion').slice(-6).map(m => `${m.role}: ${m.text.slice(0, 500)}`).join('\n');
    const refining=input.refine===true;
    const prior=refining||input.revise===true?session.candidate:null;
    if((refining||input.revise===true)&&(!prior||prior.applied||prior.id!==input.candidateId||prior.start!==start||prior.end!==end||prior.baseRevision!==input.baseRevision))fail('润色候选已过期或范围不匹配');
    const previous = session.candidate?.text ?? '';
    if(previous.length>6000&&input.revise===true)fail('当前候选过长，请缩小修订范围；原候选保留。');
    const generated = await generateContinuation({ compiledPrompt: writingContext(baseText,start)+'\n'+[...compiled.compiled.context.hard, ...compiled.compiled.context.soft].filter(s => s.role !== 'voice').map(s => `${s.role}: ${s.text}`).join('\n'),
        instruction: `本次作者指令（最高优先）：${instruction}\n${refining||input.revise===true?'修改下面的上一候选，保留未要求改变的内容，只返回完整修改后候选；不要接着候选续写。':'先写候选并在本次响应内自检重写，只返回最终稿。'}\n模式：${start === end ? '插入/续写' : '仅改写选区'}。\n近三轮讨论：${recent}\n${refining||input.revise===true?'上一候选：'+previous:''}\n有效风格：${style}\n自动文学审阅：输出前检查POV和既定事实；可以按作者意图推进新动作，避免机械重复和空泛修辞，保留刻意留白。只返回当前范围的新正文。`,
        consent: input.consent === true, mock: input.mock === true, structured:input.outputFormat==='draft', signal, onToken });
    if (signal?.aborted)
        fail('已取消');
    // Mock is deterministic engineering data, never presented as a literary model result.
    const mockText = start !== end ? `${baseText.slice(start, end).trim()}\n她没有解释，只把灯往桌沿挪了一点。` : Array.from({ length: 12 }, (_, i) => `潮水退到第${i + 1}级石阶，旧码头露出一道深色的痕迹。林砚停住脚步，把手里的票折好。沈舟站在灯下，等她先开口。风从仓库后面绕过来，带着潮湿的木头气味。`).join('\n\n');
    const rawText = input.mock === true && input.outputFormat!=='draft' ? (prior ? refineMockProse(prior.text) : input.revise===true&&session.candidate ? refineMockProse(session.candidate.text)+'\n（离线修改流程演示）' : mockText) : generated.text;
    const text = start === end && start === baseText.length && baseText.length > 0 ? '\n\n' + rawText.trimStart() : rawText;
    const reviewed = createCandidate({ appDataRoot: o.appDataRoot, vaultDir: o.vaultDir, projectId: o.projectId, chapterId, text, task: instruction, source: input.mock === true ? 'deepseek-mock' : 'deepseek', start, end });
    const reviews = [...reviewed.reviews];
    reviews.push(...reviewChineseProse(text));
    const after = baseText.slice(0, start) + text + baseText.slice(end);
    // No await between rechecking base and creating the immutable Story Core proposal.
    if (openProject(o.vaultDir, o.projectId).manifest.revision !== input.baseRevision)
        fail('STALE_BASE：生成期间作品发生变化');
    const meta = { source: generated.source, model: generated.model, start, end, baseHash: digest(baseText), textHash: digest(text), at: new Date().toISOString() };
    const proposal = createProposal({ vaultDir: o.vaultDir, projectId: o.projectId, chapterId, content: Buffer.from(after), origin: 'model', note: JSON.stringify(meta) });
    const candidate: CoCandidate = { note:generated.note,...(prior?{refinedFrom:{id:prior.id,text:prior.text}}:{}), id: proposal.proposal_id, chapterId, projectId: o.projectId, baseRevision: proposal.base_revision, baseText, start, end, text, previewHash: digest(after), source: generated.source, model: generated.model, reviews, blocking: reviewed.blocking, style };
    const next: CoSession = { executionNote: String(input.executionNote??instruction).slice(0,3000), messages: [...session.messages, { role: 'user' as const, text: instruction, kind: refining?'refinement' as const:'candidate' as const, at: new Date().toISOString() }, { role: 'assistant' as const, kind: refining?'refinement' as const:'candidate' as const, text, source: generated.source, at: new Date().toISOString() }].slice(-100), candidate };
    saveSession(o, chapterId, next);
    return next;
}
export function applyCoCandidate(o: CoOptions, input: Record<string, unknown>) {
    if (input.confirm !== true)
        fail('AUTHOR_CONFIRMATION_REQUIRED');
    const chapterId = String(input.chapterId), c = readSession(o, chapterId).candidate;
    if (!c || c.id !== input.id || c.projectId !== o.projectId || c.previewHash !== input.previewHash)
        fail('候选或预览不匹配');
    if (c.blocking)
        fail('阻断检查未通过，不能应用');
    const opened = openProject(o.vaultDir, o.projectId), current = readChapterBytes(opened.projectDir, chapterId).toString('utf8');
    if (opened.manifest.revision !== c.baseRevision || digest(current) !== digest(c.baseText))
        throw new NarrativeStudioError('CAS_MISMATCH', '正文或设定已变化，请重新生成；原文未修改', { base: c.baseText, current, candidate: c.text });
    const proposal = readProposal(o.vaultDir, c.id, o.projectId);
    if (digest(proposal.body.toString('utf8')) !== c.previewHash)
        fail('预览哈希不匹配');
    if (proposal.proposal.chapter_id !== chapterId || digest(c.baseText.slice(0, c.start) + c.text + c.baseText.slice(c.end)) !== c.previewHash)
        fail('候选范围不匹配');
    const entry = opened.manifest.chapters[chapterId]!;
    const revision = readRevision(opened.projectDir, chapterId, entry.current_revision_id);
    let prior: Array<{
        start: number;
        end: number;
        proposalId?: string;
        source?: string;
        model?: string;
    }> = [];
    try {
        const metadata = JSON.parse(revision.message ?? '{}');
        prior = metadata.ranges ?? (metadata.kind === 'ai-adopted' ? [metadata] : []);
    }
    catch { /* author revision without provenance */ }
    const delta = c.text.length - (c.end - c.start);
    const ranges = prior.flatMap(r => r.end <= c.start ? [r] : r.start >= c.end ? [{ ...r, start: r.start + delta, end: r.end + delta }] : [...(r.start < c.start ? [{ ...r, end: c.start }] : []), ...(r.end > c.end ? [{ ...r, start: c.start + c.text.length, end: r.end + delta }] : [])]);
    ranges.push({ start: c.start, end: c.start + c.text.length, proposalId: c.id, source: c.source, model: c.model });
    const note = JSON.stringify({ ranges, kind: 'ai-adopted', proposalId: c.id, source: c.source, model: c.model, start: c.start, end: c.start + c.text.length, baseRevision: c.baseRevision, previewHash: c.previewHash, at: new Date().toISOString() });
    const result = approveProposal({ vaultDir: o.vaultDir, projectId: o.projectId, proposalId: c.id, note });
    const session = readSession(o, chapterId);
    saveSession(o, chapterId, { ...session, candidate: { ...c, applied: result.write.revision.revision_id } });
    return { revision: result.write.revision, manifest_revision: result.write.manifest.revision };
}
export function undoCoCandidate(o: CoOptions, input: Record<string, unknown>) {
    if (input.confirm !== true)
        fail('AUTHOR_CONFIRMATION_REQUIRED');
    const chapterId = String(input.chapterId), opened = openProject(o.vaultDir, o.projectId), entry = opened.manifest.chapters[chapterId];
    if (!entry)
        fail('章节不存在');
    const rev = readRevision(opened.projectDir, chapterId, entry.current_revision_id);
    if (!rev.message?.includes('"kind":"ai-adopted"') || !rev.parent_revision_id)
        fail('本章已有后续手改；请通过版本历史对比恢复');
    const parent = revisionRelPaths(chapterId, rev.parent_revision_id);
    const result = commitChapter({ vaultDir: o.vaultDir, projectId: o.projectId, chapterId, baseRevision: String(input.baseRevision), content: fs.readFileSync(resolveInside(opened.projectDir, parent.body, 'undo')), message: `撤销 AI 应用 ${rev.revision_id}`, actor: { kind: 'author', id: 'local-author' }, origin: 'author' });
    return { revision: result.revision, manifest_revision: result.manifest.revision };
}

export async function discussCoWriting(o:CoOptions,input:Record<string,unknown>,signal?:AbortSignal,onToken?:(text:string)=>void):Promise<CoSession>{
 const chapterId=String(input.chapterId),opened=openProject(o.vaultDir,o.projectId);
 if(!opened.manifest.chapters[chapterId])fail('章节不属于当前作品');
 const message=String(input.message??'').trim().slice(0,3000);if(!message)fail('请输入讨论问题');
 const text=readChapterBytes(opened.projectDir,chapterId).toString('utf8');
 const session=readSession(o,chapterId);
 const start=Number(input.rangeStart),end=Number(input.rangeEnd);
 const selected=Number.isSafeInteger(start)&&Number.isSafeInteger(end)&&start>=0&&end>start&&end<=text.length?'作者当前选区（最多1600字符节选，仅讨论）：\n'+text.slice(start,end).slice(0,1600)+'\n':'';
 const pending=session.candidate&&!session.candidate.applied?'待审候选（最多1200字符节选，仅讨论，不应用）：\n'+session.candidate.text.slice(0,1200)+'\n':'';
 const context=selected+pending+writingContext(text,Number(input.position??text.length),selected||pending?1800:3600);
 const result=await generateDiscussion({context,message,history:session.messages.slice(-6).map(m=>m.role+': '+m.text.slice(0,500)).join('\n'),mock:input.mock===true,consent:input.consent===true,signal,onToken});
 if(signal?.aborted)fail('已取消');
 const next:CoSession={...session,executionNote:String(input.executionNote??session.executionNote??message).slice(0,3000),messages:[...session.messages,{role:'user' as const,text:message,kind:'discussion' as const,at:new Date().toISOString()},{role:'assistant' as const,text:result.text,kind:'discussion' as const,source:result.source,at:new Date().toISOString()}].slice(-100)};
 saveSession(o,chapterId,next);return next;
}
