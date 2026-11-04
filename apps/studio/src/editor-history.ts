import {StateEffect,StateField,type EditorState} from '@codemirror/state';
import {isolateHistory,invertedEffects} from '@codemirror/commands';
import {editorText} from './source-coordinates';
export type AiRange={start:number;end:number};
export const replaceAiRanges=StateEffect.define<AiRange[]>();
export function createAiRangeField(initial:AiRange[]=[]){return StateField.define<AiRange[]>({
 create:()=>initial,
 update:(ranges,tr)=>{
  const replacement=tr.effects.find(effect=>effect.is(replaceAiRanges));if(replacement)return replacement.value;
  if(!tr.docChanged)return ranges;
  let remaining=ranges;
  tr.changes.iterChangedRanges((from,to)=>{remaining=remaining.flatMap(r=>{if(from>=r.end||to<=r.start)return [r];return [...(r.start<from?[{start:r.start,end:from}]:[]),...(r.end>to?[{start:to,end:r.end}]:[])];});});
  return remaining.map(r=>({start:tr.changes.mapPos(r.start,1),end:tr.changes.mapPos(r.end,-1)})).filter(r=>r.end>r.start);
 }
});}
export function aiRangeHistory(field:StateField<AiRange[]>){return invertedEffects.of(tr=>tr.docChanged||tr.effects.some(effect=>effect.is(replaceAiRanges))?[replaceAiRanges.of(tr.startState.field(field))]:[]);}
/** One isolated, reversible change when an author-approved server revision returns. */
export function revisionTransaction(state:EditorState,source:string,ranges?:AiRange[]){
 const before=state.doc.toString(),after=editorText(source);
 let from=0;while(from<before.length&&from<after.length&&before[from]===after[from])from++;
 let to=before.length,end=after.length;while(to>from&&end>from&&before[to-1]===after[end-1]){to--;end--;}
 return {changes:before===after?undefined:{from,to,insert:after.slice(from,end)},effects:ranges?replaceAiRanges.of(ranges):undefined,annotations:isolateHistory.of('full')};
}
