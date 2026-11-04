import {useEffect,useRef,useState} from 'react';
import {api} from './api';
import AutoMenu from './AutoMenu';
import {decodeImport,exportFilename} from './file-transfer';
export default function FileActions({chapterId,onImported,beforeExport}:{chapterId:string|null;beforeExport:()=>Promise<void>;onImported:(id:string)=>Promise<void>}){
 const input=useRef<HTMLInputElement>(null),dialog=useRef<HTMLDialogElement>(null),imported=useRef<string|null>(null);
 const importId=useRef(crypto.randomUUID());
 const [preview,setPreview]=useState<{name:string;text:string}|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const close=()=>{if(busy)return;setPreview(null);setError('');imported.current=null;};
 useEffect(()=>{if(preview||error){if(!dialog.current?.open)dialog.current?.showModal();}else dialog.current?.close();},[preview,error]);
 const exportText=async(all:boolean)=>{setBusy(true);setError('');try{
  await beforeExport();const boot=await api.bootstrap(),chapters=all?boot.chapters:boot.chapters.filter(c=>c.chapter_id===chapterId);
  if(!chapters.length)throw new Error('没有可导出的章节，请先打开正文。');
  const texts=await Promise.all(chapters.map(async c=>{const p=await api.chapter(c.chapter_id);return all?`# ${c.title}\n\n${p.content}`:p.content;}));
  const url=URL.createObjectURL(new Blob([texts.join('\n\n')],{type:'text/markdown;charset=utf-8'})),a=document.createElement('a');a.href=url;a.download=exportFilename(all?boot.project.title:chapters[0]!.title);document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),10_000);
 }catch(e){setError(String(e));}finally{setBusy(false);}};
 const commitImport=async()=>{if(!preview||busy)return;setBusy(true);setError('');try{
  await beforeExport();
  if(!imported.current){const boot=await api.bootstrap();const c=await api.importChapter(preview.name.replace(/\.(md|txt)$/i,''),preview.text,boot.manifest.revision,importId.current);imported.current=c.chapter.chapter_id;}
  await onImported(imported.current);setPreview(null);imported.current=null;
 }catch(e){setError(`${String(e)}${imported.current?' 正文已经导入，点击“打开已导入章节”重试打开，不会重复建章。':''}`);}finally{setBusy(false);}};
 return <><button className="ghost" disabled={busy} onClick={()=>input.current?.click()}>导入</button><AutoMenu label="导出" className="export-menu"><button disabled={busy||!chapterId} onClick={()=>void exportText(false)}>导出当前章 · MD</button><button disabled={busy} onClick={()=>void exportText(true)}>导出全书 · MD</button></AutoMenu><input ref={input} type="file" accept=".md,.txt,text/plain,text/markdown" hidden onChange={e=>{const f=e.target.files?.[0];e.target.value='';if(!f)return;importId.current=crypto.randomUUID();imported.current=null;setError('');setBusy(true);void (async()=>{try{if(f.size>8*1024*1024)throw new Error('文件需小于 8 MB。');const text=decodeImport(new Uint8Array(await f.arrayBuffer()));setPreview({name:f.name,text});}catch(err){setError(String(err));}finally{setBusy(false);}})();}}/>
 <dialog ref={dialog} className="file-panel" aria-label="导入导出" onCancel={e=>{e.preventDefault();close();}}><header><h2>{preview?'导入文章':'文件操作未完成'}</h2><button className="link" disabled={busy} onClick={close}>关闭</button></header>{error&&<p role="alert">{error}</p>}{preview&&<><p>作为新章节保存，已有文章保留。共 {preview.text.length} 字符。</p><label>章节标题<input aria-label="导入章节标题" disabled={busy||!!imported.current} maxLength={300} value={preview.name} onChange={e=>setPreview({...preview,name:e.target.value})}/></label><pre>{preview.text.slice(0,3000)}</pre><button className="primary" disabled={busy||!preview.name.replace(/\.(md|txt)$/i,'').trim()} onClick={()=>void commitImport()}>{busy?'正在导入…':imported.current?'打开已导入章节':'确认导入为新章'}</button></>}</dialog></>;
}
