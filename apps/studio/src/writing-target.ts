export interface WritingAnchor {start:number;end:number;serial:number}
export function resolveWritingTarget(length:number,selection:{start:number;end:number},mode:string,hasChosenPosition:boolean){
 if(!Number.isSafeInteger(selection.start)||!Number.isSafeInteger(selection.end)||selection.start<0||selection.end<selection.start||selection.end>length)throw new Error('正文位置已变化，请重新选择。');
 if(mode==='append'||(mode==='auto'&&!hasChosenPosition))return {start:length,end:length};
 if(mode==='replace'&&selection.start===selection.end)throw new Error('请先选中要替换的原文。');
 return {start:selection.start,end:mode==='insert'?selection.start:selection.end};
}
