import {resolveWritingTarget} from './writing-target';
type Scope='current'|'previous'|'next';
function scopedRequest(instruction:string):{scope:Scope|null;ambiguous:boolean}{
 const object='(光标所在段(?:落)?|光标这一段|当前(?:这)?段(?:落)?|这一段|上一段|下一段)';
 const verb='(?:改写|重写|润色|修改|扩写|改得|改成|改为)';
 const prefix='^(?:请帮我|请|帮我|麻烦)?(?:只|仅)?';
 const before=new RegExp(prefix+'(?:把|将|给)?'+object+'[^，。；！？\\n]{0,8}?'+verb);
 const after=new RegExp(prefix+verb+'(?:一下|下)?'+object);
 const scopes:Scope[]=[];let ambiguous=false;
 for(const clause of instruction.split(/[，。；！？\n]/)){
  const text=clause.trim(),match=before.exec(text)??after.exec(text);if(!match)continue;
  const target=match[1]!;scopes.push(target==='上一段'?'previous':target==='下一段'?'next':'current');
  if(/(?:和|及|以及|、)(?:当前段|这一段|上一段|下一段)/.test(text))ambiguous=true;
 }
 if(scopes.length&&new RegExp(object+'\\s*(?:和|与|及|以及|、|，(?:以及|还有|同时))\\s*'+object).test(instruction))ambiguous=true;
 const unique=new Set(scopes);return {scope:unique.size===1?scopes[0]!:null,ambiguous:ambiguous||unique.size>1};
}
export function promptScope(instruction:string):Scope|null{const result=scopedRequest(instruction);return result.ambiguous?null:result.scope;}
export function resolvePromptTarget(text:string,selection:{start:number;end:number},mode:string,chosen:boolean,instruction=''){
 const base=resolveWritingTarget(text.length,selection,mode,chosen),parsed=scopedRequest(instruction),scope=parsed.scope;
 if(mode==='append'||selection.start!==selection.end)return base;
 if(parsed.ambiguous)throw new Error('提到了多个改写位置。请明确这次只改哪一段；原文未改。');
 if(!scope)return base;
 if(!chosen)throw new Error('先在正文要改写的段落点一下，光标会被记住。');
 const paragraphs=Array.from(text.matchAll(/[^\n]+(?:\n(?![ \t]*\n)[^\n]+)*/g),m=>({start:m.index,end:m.index+m[0].length})).filter(p=>text.slice(p.start,p.end).trim());
 const current=paragraphs.findIndex(p=>selection.start>=p.start&&selection.start<=p.end);
 if(current<0)throw new Error('光标在空白处。请点在要改写的段落里。');
 const index=current+(scope==='previous'?-1:scope==='next'?1:0),range=paragraphs[index];
 if(!range)throw new Error(scope==='previous'?'前面没有可改写的段落。':'后面没有可改写的段落。');return range;
}
