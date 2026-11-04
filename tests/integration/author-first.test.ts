import {describe,it,expect,vi} from 'vitest';
import {createWorkspace,initVault,addChapter} from '../helpers/cli.js';
import {openProject,readChapterBytes,listProposals,readNarrativeCanon} from '@narrative-studio/core';
import {writingContext} from '../../apps/cli/src/writing-context.js';
import {generateCoCandidate,discussCoWriting,digest,readSession} from '../../apps/cli/src/cowriting.js';
import {draftFramework,readFramework,saveFramework} from '../../apps/cli/src/framework.js';
import {generateContinuation} from '../../apps/cli/src/ai.js';

function setup(text='灯塔下，林见没有说话。\n\n沈舟把船票递过去。'){
 const w=createWorkspace({label:'ns-author-first'});initVault(w);addChapter(w,{text});const p=openProject(w.vault);
 return {vaultDir:w.vault,appDataRoot:w.appdata,projectId:p.project.project_id,chapterId:Object.keys(p.manifest.chapters)[0]!};
}
describe('Author-first writing paths: offline transport and isolated synthetic files',()=>{
 it('uses the actual long-chapter tail in discussion, not just its opening, without authority writes',async()=>{
  const text='开头旧场景。'.repeat(600)+'\n尾声标记：她决定烧掉船票。';const o=setup(text),base=openProject(o.vaultDir).manifest.revision;
  const fake=vi.fn(async(_url:unknown,options:RequestInit)=>{const body=JSON.parse(String(options.body));expect(body.messages[1].content).toContain('尾声标记：她决定烧掉船票');expect(body.messages[1].content.length).toBeLessThan(10000);return new Response('data: '+JSON.stringify({choices:[{delta:{content:'先讨论这个选择的代价。'}}]})+'\n\ndata: [DONE]\n\n');});
  vi.stubGlobal('fetch',fake);vi.stubEnv('DEEPSEEK_API_KEY','synthetic-test-key');
  try{await discussCoWriting(o,{chapterId:o.chapterId,message:'她接下来怎么办？',mock:false,consent:true},undefined,()=>{});expect(fake).toHaveBeenCalledTimes(1);expect(listProposals(o.vaultDir)).toHaveLength(0);expect(openProject(o.vaultDir).manifest.revision).toBe(base);}finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
  expect(writingContext(text)).toContain('尾声标记');
 });
 it('revises an identified pending candidate on the same locked range, preserves the original, and rejects a stale candidate id',async()=>{
  const o=setup(),p=openProject(o.vaultDir),text=readChapterBytes(p.projectDir,o.chapterId).toString('utf8');
  const input={chapterId:o.chapterId,baseRevision:p.manifest.revision,baseHash:digest(text),start:text.length,end:text.length,instruction:'续写',mock:true};
  const first=(await generateCoCandidate(o,input)).candidate!;
  await expect(generateCoCandidate(o,{...input,revise:true,candidateId:'wrong',instruction:'改对白'})).rejects.toThrow('范围不匹配');
  const revised=(await generateCoCandidate(o,{...input,revise:true,candidateId:first.id,instruction:'删重复，不要追加剧情'})).candidate!;
  expect(revised.refinedFrom).toEqual({id:first.id,text:first.text});expect(revised.text).not.toBe(first.text);expect(revised.start).toBe(first.start);expect(revised.end).toBe(first.end);
  expect(readSession(o,o.chapterId).executionNote).toBe('删重复，不要追加剧情');expect(readChapterBytes(p.projectDir,o.chapterId).toString('utf8')).toBe(text);
 });
 it('retains a proposal across reloads and changes only the explicitly selected planning field',async()=>{
  const o=setup(),first=await draftFramework({idea:'原创灯塔调查',mock:true,volumes:1,chaptersPerVolume:2,characterCount:4},o);
  expect(first.outline.volumes).toHaveLength(1);expect(first.outline.volumes[0]!.chapters).toHaveLength(2);expect(readFramework(o).proposal).toEqual(first.outline);expect(readFramework(o).outline).toBeNull();
  saveFramework(o,{outline:first.outline,baseRevision:openProject(o.vaultDir).manifest.revision,confirm:true});
  expect(readFramework(o).proposal).toBeNull();
  const next=await draftFramework({idea:'仅将冲突调整为家族与港口的利益矛盾',mock:true,outline:first.outline,target:'world'},o);
  expect(next.outline.world).not.toBe(first.outline.world);expect(next.outline.characters).toEqual(first.outline.characters);expect(next.outline.volumes).toEqual(first.outline.volumes);expect(next.outline.main_conflict).toBe(first.outline.main_conflict);
  expect(readFramework(o).outline).toEqual(first.outline);expect(readNarrativeCanon(openProject(o.vaultDir).projectDir)).toBeNull();
  const staleBase=readFramework(o).proposalBaseRevision;
  saveFramework(o,{outline:{...first.outline,title:'作者后续保存的新标题'},baseRevision:openProject(o.vaultDir).manifest.revision,confirm:true});
  expect(()=>saveFramework(o,{outline:next.outline,baseRevision:staleBase,confirm:true})).toThrow();
  expect(readFramework(o).outline?.title).toBe('作者后续保存的新标题');
 });
 it('refuses excessive real-model input without network or silent truncation',async()=>{
  const fake=vi.fn();vi.stubGlobal('fetch',fake);
  try{await expect(generateContinuation({compiledPrompt:'文'.repeat(25000),instruction:'续写',mock:false,consent:true})).rejects.toThrow('CONTEXT_BUDGET_EXCEEDED');expect(fake).not.toHaveBeenCalled();}finally{vi.unstubAllGlobals();}
 });
});
