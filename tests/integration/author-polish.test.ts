import {describe,it,expect} from 'vitest';
import {decodeImport,exportFilename,IMPORT_LIMIT} from '../../apps/studio/src/file-transfer.js';
import {storyPrompt} from '../../apps/studio/src/story-starter.js';
import {editorText,sourceRange,editorOffset,sourceOffset,editorAiRanges} from '../../apps/studio/src/source-coordinates.js';
import {createWorkspace,initVault,addChapter} from '../helpers/cli.js';
import {openProject,readChapterBytes} from '@narrative-studio/core';
import {generateCoCandidate,applyCoCandidate,digest} from '../../apps/cli/src/cowriting.js';
describe('Author import validation and guided story prompts',()=>{
 it('preserves Chinese, emoji and CRLF while accepting a UTF-8 BOM',()=>{
  const text='第一章\r\n她说：“等一等。”🌊\r\n\r\n结尾。';
  expect(decodeImport(new TextEncoder().encode('\ufeff'+text))).toBe(text);
 });
 it('refuses invalid UTF-8, binary, blank and oversized input before writing',()=>{
  expect(()=>decodeImport(new Uint8Array([0xc4,0xe3]))).toThrow('UTF-8');
  for(const text of ['\0abc','\u000b正文',' \r\n'])expect(()=>decodeImport(new TextEncoder().encode(text))).toThrow();
  expect(()=>decodeImport(new Uint8Array(IMPORT_LIMIT+1))).toThrow('8 MB');
 });
 it('produces portable nonempty export filenames',()=>{
  expect(exportFilename('灯塔：第一章/雨?')).toBe('灯塔：第一章_雨_.md');
  expect(exportFilename('... ')).toBe('正文.md');
 });
 it('carries every filled step and marks blanks undecided without inventing facts',()=>{
  const prompt=storyPrompt({premise:'未来的来信',hero:'守塔人',stakes:'失去家人',rule:'不能改变潮汐',turn:'来信出自自己'});
  for(const value of ['未来的来信','守塔人','失去家人','不能改变潮汐','来信出自自己'])expect(prompt).toContain(value);
  expect(prompt).toContain('空白表示尚未决定');expect(prompt).toContain('待确认方案');
 });
 it('discusses only the selected step without granting a manuscript or Canon write',()=>{
  const prompt=storyPrompt({hero:'守塔人'},1);expect(prompt).toContain('这轮只讨论“主角”');expect(prompt).toContain('暂不生成正式正文或写入设定');
  expect(()=>storyPrompt({})).toThrow('先填一个念头');
 });
 it('refuses a brief over the existing request budget instead of silently dropping later steps',()=>{
  expect(()=>storyPrompt({premise:'雨'.repeat(4100)})).toThrow('不会截断发送');
  expect(()=>storyPrompt({hero:'人'.repeat(3100)},1)).toThrow('3000');
 });
 it('maps a multiline editor selection to exact Windows source offsets and back',()=>{
  const raw='开头🌊\r\n第一行\r\n第二行\r\n尾声',normal=editorText(raw),start=normal.indexOf('第一行'),end=normal.indexOf('尾声');
  const range=sourceRange(raw,{start,end});expect(raw.slice(range.start,range.end)).toBe('第一行\r\n第二行\r\n');
  const adopted=editorAiRanges(raw,JSON.stringify({kind:'ai-adopted',ranges:[range]}));expect(adopted).toEqual([{start,end}]);expect(editorText(raw).slice(adopted[0]!.start,adopted[0]!.end)).toBe('第一行\n第二行\n');
  expect(editorAiRanges(raw,JSON.stringify({kind:'author-with-ai',coordinateSpace:'source',ranges:[range]}))).toEqual(adopted);
  expect(editorOffset(raw,range.start)).toBe(start);expect(editorOffset(raw,range.end)).toBe(end);
  const mixed='首🌊\r\n中\r尾\n末';for(let i=0;i<=editorText(mixed).length;i++)expect(editorOffset(mixed,sourceOffset(mixed,i))).toBe(i);
 });
 it('replaces only a selected CRLF range through the actual proposal and approval path',async()=>{
  const w=createWorkspace({label:'ns-crlf-author-import'});try{
   initVault(w);const text='前文🌊\r\n需要改写的第一行。\r\n需要改写的第二行。\r\n后文保留。';addChapter(w,{text});
   const p=openProject(w.vault),chapterId=Object.keys(p.manifest.chapters)[0]!,raw=readChapterBytes(p.projectDir,chapterId).toString('utf8'),normal=editorText(raw);
   const range=sourceRange(raw,{start:normal.indexOf('需要'),end:normal.indexOf('后文')});
   const o={vaultDir:w.vault,appDataRoot:w.appdata,projectId:p.project.project_id};
   const candidate=(await generateCoCandidate(o,{chapterId,baseRevision:p.manifest.revision,baseHash:digest(raw),...range,instruction:'只改写选区',outputFormat:'draft',mock:true})).candidate!;
   expect(readChapterBytes(p.projectDir,chapterId).toString('utf8')).toBe(raw);
   applyCoCandidate(o,{chapterId,id:candidate.id,previewHash:candidate.previewHash,confirm:true});
   expect(readChapterBytes(p.projectDir,chapterId).toString('utf8')).toBe(raw.slice(0,range.start)+candidate.text+raw.slice(range.end));
  }finally{w.cleanup();}
 });
});
