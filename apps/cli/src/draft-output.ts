/** Visible author-facing explanation, never a private chain of thought. */
export function parseDraftOutput(raw:string):{text:string;note:string}{
 let value:unknown;try{value=JSON.parse(raw);}catch{throw new Error('MODEL_INVALID_DRAFT: 返回格式不完整，未建立可写入候选，请重新请求。');}
 if(!value||typeof value!=='object'||!('text' in value)||typeof value.text!=='string'||!value.text.trim()||!('note' in value)||typeof value.note!=='string'||value.note.length>800)throw new Error('MODEL_INVALID_DRAFT: 正文或创作说明格式无效；原文未改动。');
 return {text:value.text.trim(),note:value.note.trim()};
}
export function draftTextProgress(raw:string):string{
 const match=/"text"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);if(!match)return '';
 const part=match[1]!.replace(/\\u[0-9a-fA-F]{0,3}$/,'');
 try{return JSON.parse('"'+part+'"') as string;}catch{return '';}
}
