import {useEffect,type RefObject} from 'react';
import type {EditorHandle} from './Editor';
type Action='undo'|'redo'|'cut'|'copy'|'paste'|'selectAll'|'save';
const tools:Array<{action:Action;label:string;key:string;path:string}>=[
 {action:'undo',label:'撤销正文修改',key:'Ctrl+Z',path:'M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12'},
 {action:'redo',label:'重做正文修改',key:'Ctrl+Y / Ctrl+Shift+Z',path:'m15 5 5 5-5 5m5-5H10a6 6 0 0 0 0 12'},
 {action:'cut',label:'剪切正文选区',key:'Ctrl+X',path:'m8 10 11 11M8 15 19 3M7 6a3 3 0 1 0 0 .1M7 16a3 3 0 1 0 0 .1'},
 {action:'copy',label:'复制正文选区',key:'Ctrl+C',path:'M8 7V3h12v15h-4M4 7h12v15H4zm4 5h4m-4 4h4'},
 {action:'paste',label:'粘贴到正文',key:'Ctrl+V',path:'M8 5H5v17h14V5h-3M9 3h6v4H9zm0 10h6m-6 4h6'},
 {action:'selectAll',label:'全选正文',key:'Ctrl+A',path:'M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5M8 9h8m-8 4h8m-8 4h5'},
 {action:'save',label:'保存正文',key:'Ctrl+S',path:'m4 18 1-5L16 2l5 5L10 18l-6 1zm9-13 5 5M4 22h16'},
];
export default function EditorToolbar({active,locked,status,editor,onSave,onReveal,onError}:{active:boolean;locked:boolean;status:{canUndo:boolean;canRedo:boolean;hasSelection:boolean};editor:RefObject<EditorHandle|null>;onSave:()=>void;onReveal:()=>void;onError:(message:string)=>void}){
 const run=async(action:Action)=>{if(locked)return;try{if(action==='save'){onSave();return;}onReveal();if(action==='undo'||action==='redo')editor.current?.[action]();else await editor.current?.edit(action);requestAnimationFrame(()=>editor.current?.focus());}catch(error){onError(error instanceof Error?error.message:'编辑失败，请使用对应快捷键重试。');}};
 useEffect(()=>{if(!active)return;const key=(event:KeyboardEvent)=>{if(locked||event.defaultPrevented||!(event.ctrlKey||event.metaKey)||event.altKey)return;const target=event.target;if(target instanceof Element&&target.closest('input,textarea,[contenteditable=true],[role=textbox],[role=dialog]'))return;const action=event.key.toLowerCase()==='z'?(event.shiftKey?'redo':'undo'):event.key.toLowerCase()==='y'?'redo':null;if(action&&status[action==='undo'?'canUndo':'canRedo']){event.preventDefault();void run(action);}};window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);});
 return <div className="editor-tools" role="toolbar" aria-label="正文编辑工具">{tools.map(tool=><button type="button" key={tool.action} className={`editor-tool tool-${tool.action}`} aria-label={tool.label} disabled={locked||(tool.action==='undo'&&!status.canUndo)||(tool.action==='redo'&&!status.canRedo)||(['cut','copy'].includes(tool.action)&&!status.hasSelection)} onPointerDown={event=>event.preventDefault()} onClick={()=>void run(tool.action)}><svg viewBox="0 0 24 26" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={tool.path}/></svg><span className="tool-tip" role="tooltip">{tool.label}<small>{tool.key}</small></span></button>)}<span className="edit-tools-status" aria-live="polite">{locked?'正在写入…':''}</span></div>;
}
