/** Local author commands only: model replies never call this parser. */
export function authorConfirmation(text:string):'apply'|'insert'|'replace'|null{
 const value=text.trim().replace(/[。！!]+$/u,'');
 if(['采用这稿','采用当前候选','确认写入','确认采用'].includes(value))return 'apply';
 if(['确认插入','插入这稿'].includes(value))return 'insert';
 if(['确认替换','用这稿替换选区'].includes(value))return 'replace';return null;
}
export function confirmationProblem(action:'apply'|'insert'|'replace',candidate:{start:number;end:number;applied?:string;blocking:boolean}|null,changed:boolean){
 if(!candidate||candidate.applied)return '目前没有待采用的草稿。先生成一稿，再确认采用。';
 if(changed)return '写入位置变了。请先确认这稿的位置，或按新光标重新生成。';
 if(candidate.blocking)return '这稿有设定冲突，请先处理提示的问题。';
 if(action==='insert'&&candidate.start!==candidate.end)return '这稿绑定的是替换范围。要替换请说“确认替换”；要插入请先按光标重新生成。';
 if(action==='replace'&&candidate.start===candidate.end)return '这稿绑定的是插入位置。要插入请说“确认插入”；要替换请先选中原文。';return '';
}
export function positionLabel(source:string,start:number,end:number){const line=source.slice(0,start).split(/\r\n|\r|\n/).length;return start===end?`第 ${line} 行光标处`:`选中 ${end-start} 字 · 第 ${line} 行起`;}
export function reviewBrief(candidate:{blocking:boolean;style:string;reviews:Array<{severity:string;reason:string}>}){
 const warnings=candidate.reviews.filter(r=>['warning','error','blocking'].includes(r.severity));
 return {warnings,summary:candidate.blocking?'有设定冲突，需要先修改':warnings.length?`有 ${warnings.length} 处建议再看一眼`:'基础检查：暂无提醒',style:candidate.style.startsWith('尚无风格样本')?'未提供文风样本': '已参考批准的文风样本'};
}
