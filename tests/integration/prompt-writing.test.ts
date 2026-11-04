import {describe,it,expect,vi} from 'vitest';
import {createWorkspace,initVault,addChapter} from '../helpers/cli.js';
import {openProject,readChapterBytes,listProposals} from '@narrative-studio/core';
import {generateContinuation} from '../../apps/cli/src/ai.js';
import {generateCoCandidate,applyCoCandidate,discussCoWriting,digest} from '../../apps/cli/src/cowriting.js';
import {parseDraftOutput,draftTextProgress} from '../../apps/cli/src/draft-output.js';
import {resolveWritingTarget} from '../../apps/studio/src/writing-target.js';

function setup(){const w=createWorkspace({label:'ns-prompt-writing'});initVault(w);addChapter(w,{text:'门外下着雨。\n\n她把那封信放在桌上。\n\n灯没有熄。'});const p=openProject(w.vault);return {vaultDir:w.vault,appDataRoot:w.appdata,projectId:p.project.project_id,chapterId:Object.keys(p.manifest.chapters)[0]!};}
function streamReply(text:string){const content=JSON.stringify({text,note:'保留原有动作，用停顿增加张力。'});return new Response(content.match(/.{1,9}/gs)!.map(part=>'data: '+JSON.stringify({choices:[{delta:{content:part}}]})+'\n').join('')+'data: [DONE]\n');}
describe('Prompt writing with explicit author adoption (synthetic and stubbed model transport)',()=>{
 it('resolves selected replacement, a chosen cursor insertion, and a default chapter-tail continuation',()=>{
  expect(resolveWritingTarget(100,{start:12,end:28},'auto',true)).toEqual({start:12,end:28});
  expect(resolveWritingTarget(100,{start:17,end:17},'auto',true)).toEqual({start:17,end:17});
  expect(resolveWritingTarget(100,{start:0,end:0},'auto',false)).toEqual({start:100,end:100});
  expect(resolveWritingTarget(100,{start:12,end:28},'append',true)).toEqual({start:100,end:100});
  expect(()=>resolveWritingTarget(5,{start:6,end:6},'auto',true)).toThrow('重新选择');
 });
 it('streams only draft prose and returns a separate short note, with JSON required in the provider request',async()=>{
  const prose='她说：“先等等。”\n\n那封信仍留在桌上。';const seen:string[]=[];
  const fake=vi.fn(async(_url:unknown,options:RequestInit)=>{expect(JSON.parse(String(options.body)).response_format).toEqual({type:'json_object'});return streamReply(prose);});
  vi.stubGlobal('fetch',fake);vi.stubEnv('DEEPSEEK_API_KEY','synthetic-prompt-test-key');
  try{const r=await generateContinuation({compiledPrompt:'原创合成场景',instruction:'只写对话与动作',consent:true,mock:false,structured:true,onToken:t=>seen.push(t)});expect(r.text).toBe(prose);expect(r.note).toBe('保留原有动作，用停顿增加张力。');expect(seen.at(-1)).toBe(prose);expect(seen.some(t=>t.includes('"note"')||t.includes('创作说明'))).toBe(false);}finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
 });
 for(const scope of ['replace','insert'] as const)it(`requires one explicit approval for ${scope} and writes only prose within its bound range`,async()=>{
  const o=setup(),p=openProject(o.vaultDir),before=readChapterBytes(p.projectDir,o.chapterId).toString('utf8'),selection={start:7,end:scope==='replace'?19:7};
  const fake=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:JSON.stringify({text:'她把信翻了过来。',note:'保留原有动作，用停顿增加张力。'})}}]})));
  vi.stubGlobal('fetch',fake);vi.stubEnv('DEEPSEEK_API_KEY','synthetic-prompt-test-key');
  try{const c=(await generateCoCandidate(o,{chapterId:o.chapterId,baseRevision:p.manifest.revision,baseHash:digest(before),...selection,instruction:'只写一个动作，不解释',outputFormat:'draft',consent:true,mock:false})).candidate!;
   expect(c.note).toContain('原有动作');expect(readChapterBytes(p.projectDir,o.chapterId).toString('utf8')).toBe(before);
   expect(()=>applyCoCandidate(o,{chapterId:o.chapterId,id:c.id,previewHash:c.previewHash})).toThrow('AUTHOR_CONFIRMATION_REQUIRED');
   applyCoCandidate(o,{chapterId:o.chapterId,id:c.id,previewHash:c.previewHash,confirm:true});
   const after=readChapterBytes(p.projectDir,o.chapterId).toString('utf8');expect(after).toBe(before.slice(0,c.start)+c.text+before.slice(c.end));expect(after).not.toContain(c.note!);expect(after).not.toContain('"text"');
  }finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
 });
 it('rejects malformed model output before creating an adoptable proposal and does not retry or fall back',async()=>{
  const o=setup(),p=openProject(o.vaultDir),text=readChapterBytes(p.projectDir,o.chapterId).toString('utf8'),fake=vi.fn(async()=>new Response(JSON.stringify({choices:[{message:{content:'这是未结构化的正文和解释'}}]})));
  vi.stubGlobal('fetch',fake);vi.stubEnv('DEEPSEEK_API_KEY','synthetic-prompt-test-key');
  try{await expect(generateCoCandidate(o,{chapterId:o.chapterId,baseRevision:p.manifest.revision,baseHash:digest(text),start:0,end:0,instruction:'写一段',outputFormat:'draft',consent:true,mock:false})).rejects.toThrow('MODEL_INVALID_DRAFT');expect(fake).toHaveBeenCalledTimes(1);expect(listProposals(o.vaultDir)).toHaveLength(0);expect(readChapterBytes(p.projectDir,o.chapterId).toString('utf8')).toBe(text);}finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
 });
 it('does not treat malformed JSON or a partial explanation as adoptable prose',()=>{
  expect(()=>parseDraftOutput('{"text":"未完成')).toThrow('MODEL_INVALID_DRAFT');
  expect(draftTextProgress('{"note":"不应流入正文","text":"新段落')).toBe('新段落');
  expect(draftTextProgress('{"text":"她说：\\"等一等\\"。')).toBe('她说：“等一等”。'.replace('“','"').replace('”','"'));
 });
 it('identifies the selected paragraph in a discussion request without creating a write proposal',async()=>{
  const o=setup(),p=openProject(o.vaultDir),before=readChapterBytes(p.projectDir,o.chapterId).toString('utf8');
  const fake=vi.fn(async(_url:unknown,options:RequestInit)=>{const request=JSON.parse(String(options.body));expect(request.messages[1].content).toContain('作者当前选区');expect(request.messages[1].content).toContain(before.slice(7,19));return new Response(JSON.stringify({choices:[{message:{content:'可以从动作与停顿入手。'}}]}));});
  vi.stubGlobal('fetch',fake);vi.stubEnv('DEEPSEEK_API_KEY','synthetic-prompt-test-key');
  try{await discussCoWriting(o,{chapterId:o.chapterId,position:19,rangeStart:7,rangeEnd:19,message:'讨论选区写法',mock:false,consent:true});expect(listProposals(o.vaultDir)).toHaveLength(0);expect(readChapterBytes(p.projectDir,o.chapterId).toString('utf8')).toBe(before);}finally{vi.unstubAllGlobals();vi.unstubAllEnvs();}
 });
});
