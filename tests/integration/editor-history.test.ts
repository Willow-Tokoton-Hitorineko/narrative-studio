import {describe,it,expect} from 'vitest';
import {EditorState,type Transaction} from '../../apps/studio/node_modules/@codemirror/state/dist/index.js';
import {history,undo,redo,undoDepth,isolateHistory} from '../../apps/studio/node_modules/@codemirror/commands/dist/index.js';
import {revisionTransaction,createAiRangeField,aiRangeHistory} from '../../apps/studio/src/editor-history.js';
import {atelierQuotes,createQuoteCycle} from '../../apps/studio/src/atelier-quotes.js';
describe('Manuscript editing history and illustration dialogue',()=>{
 it('keeps manual edits and approved AI replacement as separate reversible steps, including provenance',()=>{
  const marks=createAiRangeField([{start:0,end:2}]);let state=EditorState.create({doc:'原文保留',extensions:[history(),marks,aiRangeHistory(marks)]});
  const dispatch=(transaction:Transaction)=>{state=transaction.state;};
  state=state.update({changes:{from:4,insert:'手写'},annotations:isolateHistory.of('full')}).state;
  state=state.update(revisionTransaction(state,'原文保留手写候选',[{start:0,end:2},{start:6,end:8}])).state;
  expect(undoDepth(state)).toBe(2);expect(undo({state,dispatch})).toBe(true);expect(state.doc.toString()).toBe('原文保留手写');expect(state.field(marks)).toEqual([{start:0,end:2}]);
  expect(undo({state,dispatch})).toBe(true);expect(state.doc.toString()).toBe('原文保留');
  expect(redo({state,dispatch})).toBe(true);expect(redo({state,dispatch})).toBe(true);expect(state.doc.toString()).toBe('原文保留手写候选');expect(state.field(marks)).toEqual([{start:0,end:2},{start:6,end:8}]);
 });
 it('restores AI attribution when an author edits then undoes text inside an adopted passage',()=>{
  const marks=createAiRangeField([{start:1,end:5}]);let state=EditorState.create({doc:'甲乙丙丁戊己',extensions:[history(),marks,aiRangeHistory(marks)]});
  state=state.update({changes:{from:2,to:4,insert:'改'}}).state;
  expect(state.field(marks)).not.toEqual([{start:1,end:5}]);
  undo({state,dispatch:tr=>{state=tr.state;}});expect(state.doc.toString()).toBe('甲乙丙丁戊己');expect(state.field(marks)).toEqual([{start:1,end:5}]);
 });
 it('normalizes returned CRLF revisions without creating an artificial document change',()=>{
  const state=EditorState.create({doc:'甲\n乙',extensions:[history()]});const update=state.update(revisionTransaction(state,'甲\r\n乙'));expect(update.docChanged).toBe(false);expect(undoDepth(update.state)).toBe(0);
 });
 it('never repeats adjacent dialogue, and each shuffled cycle includes every short excerpt',()=>{
  const next=createQuoteCycle(()=>0.3),seen=Array.from({length:24},()=>next());for(let i=1;i<seen.length;i++)expect(seen[i]).not.toBe(seen[i-1]);for(let i=0;i<seen.length;i+=atelierQuotes.length)expect(new Set(seen.slice(i,i+atelierQuotes.length)).size).toBe(atelierQuotes.length);
 });
});
