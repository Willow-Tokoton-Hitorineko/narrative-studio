export const IMPORT_LIMIT=8*1024*1024;
export function decodeImport(bytes:Uint8Array):string{
 if(bytes.byteLength>IMPORT_LIMIT)throw new Error('文件需小于 8 MB。');
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('文件不是有效 UTF-8。请在原编辑器另存为 UTF-8 TXT / Markdown 后导入。');}
 if(!text.trim())throw new Error('文件没有正文。');
 // eslint-disable-next-line no-control-regex -- reject binary input before author import
 if(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text))throw new Error('文件包含非文本控制字符，请选择 TXT / Markdown。');
 return text;
}
export function exportFilename(title:string){
// eslint-disable-next-line no-control-regex -- Windows download filename sanitization
return (title.replace(/[<>:"/\\|?*\u0000-\u001f]/g,'_').replace(/[. ]+$/g,'').trim().slice(0,120)||'正文')+'.md';}
