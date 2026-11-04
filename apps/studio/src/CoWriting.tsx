import {AtelierPortrait} from './AtelierArt';
import {authorConfirmation,confirmationProblem,positionLabel,reviewBrief} from './author-interaction';
import {promptScope} from './prompt-scope';
import {shouldPresentCandidate} from './candidate-presentation';
import MessageText from './MessageText';
import {useEffect,useRef,useState} from 'react';
import {diffLines} from 'diff';
import {api} from './api';
import type {WritingAnchor} from './writing-target';
export interface CoTarget {chapterId:string;baseRevision:string;baseHash:string;start:number;end:number;text:string}
interface Candidate {note?:string;applied?:string;refinedFrom?:{id:string;text:string};id:string;chapterId:string;projectId:string;baseRevision:string;baseText:string;start:number;end:number;text:string;previewHash:string;source:string;model:string;reviews:Array<{dimension:string;severity:string;reason:string}>;blocking:boolean;style:string}
interface Session {executionNote?:string;messages:Array<{role:string;text:string;at:string;source?:string;kind?:string}>;candidate:Candidate|null}
export async function coRequest<T>(path:string,body?:unknown):Promise<T>{const r=await fetch(path,{method:body===undefined?'GET':'POST',headers:body===undefined?{}:{'content-type':'application/json','x-ns-request':'studio'},body:body===undefined?undefined:JSON.stringify(body)});const data=await r.json();if(!r.ok||data.ok===false)throw new Error(data.error?.message??'操作失败');return data as T;}
export async function textHash(text:string){return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))).map(b=>b.toString(16).padStart(2,'0')).join('');}
interface Props {active:boolean;chapterId:string;anchor:WritingAnchor|null;workspace:'focus'|'split';layoutSerial:number;onWorkspace:(mode:'focus'|'split',manual?:boolean)=>void;onReveal:(start:number,end:number)=>void;shouldFollow:(start:number,end:number)=>boolean;onApplying:(v:boolean)=>void;getTarget:(mode:string,instruction?:string)=>Promise<CoTarget>;onApplied:(range?:{start:number;end:number},follow?:boolean)=>Promise<void>}
function rangeLabel(start:number,end:number){return start===end?`在第 ${start+1} 字前插入`:`替换已选 ${end-start} 字`;}

export default function CoWriting({active,chapterId,anchor,getTarget,onApplied,onApplying,onReveal,shouldFollow,workspace,layoutSerial,onWorkspace}:Props){
 const [session,setSession]=useState<Session>({messages:[],candidate:null}),[instruction,setInstruction]=useState(''),[mode,setMode]=useState('auto'),[intent,setIntent]=useState<'write'|'discuss'>('write'),[mock,setMock]=useState(true),[consent,setConsent]=useState(false),[refineConsent,setRefineConsent]=useState(false),[busy,setBusy]=useState(false),[applying,setApplying]=useState(false),[error,setError]=useState(''),[settings,setSettings]=useState(false),[candidateMode,setCandidateMode]=useState(false),[follow,setFollow]=useState<'auto'|'always'|'never'>('auto'),[connection,setConnection]=useState<{configured:boolean;model:string}|null>(null),[progress,setProgress]=useState(''),[latest,setLatest]=useState<{start:number;end:number}|null>(null);
 const [presentedCandidate,setPresentedCandidate]=useState('');
 const [pane,setPane]=useState<'conversation'|'candidate'>('conversation'),[composerOpen,setComposerOpen]=useState(true),[unreadCandidate,setUnreadCandidate]=useState(false);
 const programmaticScroll=useRef<number|null>(null);
 const reviewRef=useRef<HTMLDivElement|null>(null),navigationRef=useRef(0),browsingRef=useRef(false),layoutRef=useRef(layoutSerial),seenCandidate=useRef('');
 layoutRef.current=layoutSerial;
 const messagesRef=useRef<HTMLDivElement|null>(null),candidateRef=useRef<HTMLElement|null>(null),stick=useRef(true),requestId=useRef(''),epoch=useRef(0),anchorRef=useRef(anchor);
 anchorRef.current=anchor;
 const refreshConnection=()=>api.aiStatus().then(r=>setConnection(r.status)).catch(()=>setError('无法读取本地连接状态，请检查服务。'));
 useEffect(()=>{void refreshConnection();},[]);
 useEffect(()=>{if(active&&pane==='conversation'&&stick.current&&messagesRef.current){const el=messagesRef.current;programmaticScroll.current=Math.max(0,el.scrollHeight-el.clientHeight);el.scrollTop=el.scrollHeight;}},[session.messages,progress,active,pane]);
 useEffect(()=>{if(active&&pane==='candidate'&&session.candidate&&reviewRef.current&&presentedCandidate===session.candidate.id&&seenCandidate.current!==session.candidate.id){reviewRef.current.scrollTop=0;seenCandidate.current=session.candidate.id;}},[presentedCandidate,active,pane]);
 useEffect(()=>{if(anchor){setCandidateMode(false);setMode('auto');setConsent(false);}},[anchor?.serial]);
 useEffect(()=>{
  const e=++epoch.current;setSession({messages:[],candidate:null});let savedPrompt='';try{savedPrompt=sessionStorage.getItem(`ns.prompt-draft.${chapterId}`)??'';}catch{/* optional local draft */}setInstruction(savedPrompt);setLatest(null);setProgress('');setError('');setConsent(false);setCandidateMode(false);setMode('auto');setPane('conversation');setComposerOpen(true);setUnreadCandidate(false);setPresentedCandidate('');seenCandidate.current='';
  void coRequest<Session>(`/api/cowriting/session?chapterId=${encodeURIComponent(chapterId)}`).then(s=>{if(epoch.current!==e)return;setSession(s);setCandidateMode(!!s.candidate&&!s.candidate.applied&&!anchorRef.current);if(s.candidate&&!s.candidate.applied&&!savedPrompt){setPresentedCandidate(s.candidate.id);setPane('candidate');setComposerOpen(false);}const initial=sessionStorage.getItem(`ns.task.${chapterId}`);if(initial){setInstruction(initial);sessionStorage.setItem(`ns.prompt-draft.${chapterId}`,initial);sessionStorage.removeItem(`ns.task.${chapterId}`);}}).catch(e=>setError(String(e)));
  return()=>{epoch.current++;if(requestId.current)void coRequest('/api/cowriting/cancel',{requestId:requestId.current});};
 },[chapterId]);
 const c=session.candidate,pending=!!c&&!c.applied,usingCandidate=pending&&candidateMode;
 const targetLabel=!usingCandidate&&mode!=='append'&&promptScope(instruction)?`按要求改写${promptScope(instruction)==='previous'?'上一段':promptScope(instruction)==='next'?'下一段':'光标所在段'}`:usingCandidate?'修改这份草稿 · 位置不变':mode==='append'||!anchor?'写在章末':`光标已记住 · ${anchor.start===anchor.end?'插入':'替换选区'}`;
 const primaryLabel=intent==='discuss'?'发送讨论':usingCandidate?'修改候选':mode==='append'||!anchor?'生成续写':anchor.start!==anchor.end?'生成替换稿':'在此生成';
 const changedTarget=!!anchor&&!candidateMode&&!!c&&(c.start!==anchor.start||c.end!==anchor.end);
 const command=authorConfirmation(instruction);
 const canRequest=!!command||mock||(connection?.configured&&consent);
 const brief=c?reviewBrief(c):null;
 const run=async(action:'discuss'|'generate'|'refine')=>{
  if(busy)return;
  const prompt=instruction.trim()||(action==='refine'?'精修当前候选，保留事实与有意留白，改善重复、对白和节奏。':'');
  if(!prompt){setError('先说说你想怎样写。');return;}
  const e=epoch.current,id=crypto.randomUUID(),serial=anchorRef.current?.serial,navigationAtStart=navigationRef.current+layoutRef.current;
  browsingRef.current=false;setPane('conversation');setComposerOpen(true);setSettings(false);onWorkspace('focus');requestId.current=id;stick.current=true;setBusy(true);setError('');setProgress('');let poll:number|undefined;
  try{
   let body:Record<string,unknown>={chapterId,message:prompt,instruction:prompt,executionNote:prompt,position:mode==='append'?Number.MAX_SAFE_INTEGER:anchor?.end??Number.MAX_SAFE_INTEGER,rangeStart:mode==='append'?undefined:anchor?.start,rangeEnd:mode==='append'?undefined:anchor?.end,mock,consent:action==='refine'?refineConsent:consent,requestId:id,outputFormat:'draft'};
   if(action!=='discuss'){
    const revise=action==='refine'||usingCandidate;
    let target=await getTarget(revise?'check':mode,revise?undefined:prompt);
    if(revise){if(!c||c.applied||c.baseRevision!==target.baseRevision||c.baseText!==target.text)throw new Error('正文或设定已变化，请按当前正文位置重新生成。');target={...target,start:c.start,end:c.end};body={...body,candidateId:c.id,revise:action!=='refine'};}
    body={...body,...target};
   }
   if(e!==epoch.current)return;
   poll=window.setInterval(()=>{void coRequest<{text:string}>(`/api/cowriting/progress?id=${id}`).then(p=>{if(e===epoch.current)setProgress(p.text);}).catch(()=>{});},250);
   const s=await coRequest<Session>(`/api/cowriting/${action}`,body);
   if(e!==epoch.current)return;
   setSession(s);setInstruction(value=>value===instruction?'':value);try{if(sessionStorage.getItem(`ns.prompt-draft.${chapterId}`)===instruction)sessionStorage.removeItem(`ns.prompt-draft.${chapterId}`);}catch{/* optional local draft */}
   if(action!=='discuss'){
    setCandidateMode(anchorRef.current?.serial===serial);
    if(shouldPresentCandidate({action,requestNavigation:navigationAtStart,currentNavigation:navigationRef.current+layoutRef.current,authorBrowsing:browsingRef.current})){setPresentedCandidate(s.candidate?.id??'');setPane('candidate');setComposerOpen(false);setUnreadCandidate(false);}else setUnreadCandidate(true);
   }
  }catch(caught){if(e===epoch.current)setError(String(caught));}
  finally{if(poll!==undefined)clearInterval(poll);if(requestId.current===id){requestId.current='';setBusy(false);setProgress('');setConsent(false);setRefineConsent(false);}}
 };
 const stop=()=>{epoch.current++;void coRequest('/api/cowriting/cancel',{requestId:requestId.current});setBusy(false);setProgress('');setConsent(false);setError('已停止，原稿未改动。');};
 const discard=()=>void coRequest<Session>('/api/cowriting/discard',{chapterId}).then(s=>{setSession(s);setCandidateMode(false);setPane('conversation');setComposerOpen(true);setUnreadCandidate(false);}).catch(e=>setError(String(e)));
 const apply=async()=>{
  if(!c||c.applied||busy||c.blocking||changedTarget)return false;setBusy(true);setApplying(true);onApplying(true);setError('');
  try{const t=await getTarget('check');if(t.chapterId!==c.chapterId||t.baseRevision!==c.baseRevision||await textHash(t.text)!==await textHash(c.baseText))throw new Error('原文已变化，不能覆盖。请重新生成。');
   const autoFollow=follow==='always'||(follow==='auto'&&shouldFollow(c.start,c.end));
   await coRequest('/api/cowriting/apply',{chapterId,id:c.id,previewHash:c.previewHash,confirm:true});setLatest({start:c.start,end:c.start+c.text.length});await onApplied({start:c.start,end:c.start+c.text.length},autoFollow);setSession(await coRequest<Session>(`/api/cowriting/session?chapterId=${chapterId}`));setCandidateMode(false);setError('已写入，原稿已保留。');return true;
  }catch(caught){setError(String(caught));return false;}finally{setBusy(false);setApplying(false);onApplying(false);}
 };
 const undo=async()=>{if(busy||applying)return;setBusy(true);setApplying(true);onApplying(true);try{const target=await getTarget('check');await coRequest('/api/cowriting/undo',{chapterId,baseRevision:target.baseRevision,confirm:true});await onApplied();setLatest(null);setError('已恢复原稿，并保留为新版本。');setSession(await coRequest<Session>(`/api/cowriting/session?chapterId=${chapterId}`));}catch(error){setError(String(error));}finally{setBusy(false);setApplying(false);onApplying(false);}};
 const submit=async()=>{const action=authorConfirmation(instruction);if(!action){await run(intent==='discuss'?'discuss':'generate');return;}const issue=confirmationProblem(action,c,changedTarget);if(issue){setError(issue);return;}const submitted=instruction;if(await apply()){setInstruction(value=>value===submitted?'':value);try{if(sessionStorage.getItem(`ns.prompt-draft.${chapterId}`)===submitted)sessionStorage.removeItem(`ns.prompt-draft.${chapterId}`);}catch{/* optional draft */}}};
 const openPane=(next:'conversation'|'candidate')=>{if(next==='candidate'&&!c)return;navigationRef.current++;setPane(next);if(next==='candidate'){setPresentedCandidate(c!.id);setComposerOpen(false);setUnreadCandidate(false);}else setComposerOpen(true);};
 return <section hidden={!active} className={`co-chat prompt-workspace ${pane==='candidate'?'candidate-reading':''}`}  aria-label="AI 创作对话">
  <header><AtelierPortrait/><strong>写作对话</strong><span className={`model-state ${mock?'is-demo':''}`}>{mock?'交互演示 · 固定示例':connection?.configured?connection.model:'真实模型未连接'}</span><div className="chat-header-actions">{workspace==='focus'&&<button className="link" onClick={()=>onWorkspace('split',true)}>对照原文</button>}<button className="link" aria-expanded={settings} onClick={()=>setSettings(!settings)}>连接与设置</button></div></header>
  <nav className="ai-view-tabs" aria-label="AI 工作视图"><button aria-pressed={pane==='conversation'} onClick={()=>openPane('conversation')}>对话</button><button disabled={!c} aria-pressed={pane==='candidate'} onClick={()=>openPane('candidate')}>候选正文{c?` · ${c.text.length} 字`:''}{unreadCandidate?' · 新':''}</button></nav>
  {settings&&<div className="prompt-settings"><label>生成模式<select aria-label="AI 生成模式" value={mock?'demo':'real'} onChange={e=>{setMock(e.target.value==='demo');setConsent(false);setRefineConsent(false);}}><option value="demo">交互演示（固定内容）</option><option value="real">真实 DeepSeek</option></select></label><span>{connection?.configured?`本地服务已配置 ${connection.model}`:'本地服务未配置 DeepSeek Key'}</span><button className="link" onClick={()=>void refreshConnection()}>刷新状态</button>{!connection?.configured&&<p>真实写作需要在启动服务的终端设置 DEEPSEEK_API_KEY，再重启服务。Key 仅由本地服务读取，请勿粘贴到聊天中。</p>}<label>应用后跟随<select value={follow} onChange={e=>setFollow(e.target.value as typeof follow)}><option value="auto">智能跟随</option><option value="always">始终跟随</option><option value="never">保持阅读位置</option></select></label><button className="link" disabled={busy} onClick={()=>void coRequest('/api/cowriting/clear',{chapterId}).then(()=>{setSession({messages:[],candidate:null});setCandidateMode(false);setPane('conversation');setComposerOpen(true);})}>清空会话</button></div>}
  <div className="co-messages ai-conversation-scroll" hidden={pane!=='conversation'} tabIndex={0} aria-label="对话记录" ref={messagesRef} onPointerDown={()=>{if(busy)browsingRef.current=true;}} onTouchStart={()=>{if(busy)browsingRef.current=true;}} onWheel={()=>{if(busy)browsingRef.current=true;}} onKeyDown={e=>{if(busy&&['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(e.key))browsingRef.current=true;}} onScroll={()=>{const el=messagesRef.current;if(el){if(busy&&Math.abs(el.scrollTop-(programmaticScroll.current??-1))>1)browsingRef.current=true;stick.current=el.scrollHeight-el.scrollTop-el.clientHeight<70;}}} aria-live="polite"><div className="conversation-thread">
   {!session.messages.length&&<div className="prompt-welcome"><span className="eyebrow">先有一个念头，再落成文字。</span><p>在正文点一下留下光标，再来聊怎么写。要精确改一段时再选中文字。</p>{mock&&<p className="demo-explainer">当前仅演示选区、生成和写入流程。按提示词创作请连接真实 DeepSeek。</p>}</div>}
   {session.messages.map((m,i)=>m.role==='user'?<article className="user" key={i}><MessageText text={m.text}/></article>:m.kind==='discussion'?<article className="assistant" key={i}><small className="speaker">{m.source==='deepseek'?'共创伙伴':'离线演示'}</small><MessageText text={m.text}/></article>:i===session.messages.length-1&&c?<article className="candidate-ready" key={i}><small className="speaker">{c.applied?'已写入正文':c.source==='mock'?'演示草稿':'新草稿'}</small><MessageText text={c.text.length>800?c.text.slice(0,800)+'…':c.text}/><div className="inline-draft-actions"><button className="link" onClick={()=>{openPane('candidate');onWorkspace('focus',true);}}>{c.text.length>800?'阅读全文':'查看 / 对比'}</button>{!c.applied&&<button disabled={busy||c.blocking||changedTarget} onClick={()=>void apply()}>采用这稿</button>}</div></article>:<details className="past-draft" key={i}><summary>早先的草稿</summary><pre>{m.text}</pre></details>)}
   {busy&&!applying&&<article className="assistant responding"><strong>{intent==='discuss'?'正在回复…':'正在写作…'}</strong>{progress?<MessageText text={progress}/>:<p className="muted">可以继续阅读正文，也可以停止。</p>}</article>}
  </div></div>
  <div className="review-view" tabIndex={0} aria-label="候选正文阅读区" hidden={pane!=='candidate'} ref={reviewRef} onPointerDown={()=>{if(busy)browsingRef.current=true;}} onTouchStart={()=>{if(busy)browsingRef.current=true;}} onKeyDown={e=>{if(busy&&['PageUp','PageDown','Home','End','ArrowUp','ArrowDown'].includes(e.key))browsingRef.current=true;}} onWheel={()=>{if(busy)browsingRef.current=true;}}>
   {c&&<section ref={candidateRef} className="draft-result" aria-label="待采用正文"><div className="draft-result-head"><strong>{c.applied?'已保存正文':c.source==='mock'?'演示候选':'候选正文'}</strong><span>{positionLabel(c.baseText,c.start,c.end)} · {c.text.length} 字</span></div>{!c.applied&&changedTarget&&<p className="target-changed-note">正文位置已改变。请按新位置生成，或点“继续改这稿”保留原范围。</p>}{c.blocking&&<p className="target-changed-note">发现设定冲突，请展开检查并修改候选后再采用。</p>}{!c.applied&&<div className="draft-actions"><span className="sticky-target">{rangeLabel(c.start,c.end)}</span><button className="primary" disabled={busy||c.blocking||changedTarget} onClick={()=>void apply()}>{applying?'正在保存…':c.start===c.end?'确认插入并保存':'确认替换并保存'}</button><button disabled={busy} onClick={()=>{setCandidateMode(true);setIntent('write');setComposerOpen(true);}} >继续改这稿</button><button className="link" disabled={busy} onClick={discard}>不采用</button></div>}
    {c.applied&&<div className="draft-actions"><span>原文与 AI 来源已保留。</span><button className="link" disabled={busy} onClick={undo}>撤销本次写入</button>{latest&&<button className="link" onClick={()=>onReveal(latest.start,latest.end)}>查看写入处</button>}</div>}<pre className="draft-prose">{c.text.replace(/^\n+/, '')}</pre>{c.note&&<details className="draft-note"><summary>写法说明</summary><MessageText text={c.note}/></details>}
    {brief&&<div className="review-brief"><span>{brief.summary}</span><small>{brief.style}</small></div>}
    <details className="draft-inspect"><summary>看改动</summary>{c.start!==c.end&&<><strong>原来的文字</strong><pre>{c.baseText.slice(c.start,c.end)}</pre></>}{c.refinedFrom&&<><strong>这次修改</strong><div className="candidate-diff">{diffLines(c.refinedFrom.text,c.text).map((p,i)=>p.removed?<del key={i}>{p.value}</del>:p.added?<ins key={i}>{p.value}</ins>:<span key={i}>{p.value}</span>)}</div></>}{brief?.warnings.map((r,i)=><p key={i}>{r.reason}</p>)}{!c.applied&&<details className="refine-options"><summary>再润色一次</summary>{!mock&&<label className="co-consent"><input type="checkbox" checked={refineConsent} onChange={e=>setRefineConsent(e.target.checked)}/>授权额外一次模型请求；发送本稿与批准上下文，最多4096 tokens。</label>}<button disabled={busy||(!mock&&(!refineConsent||!connection?.configured))} onClick={()=>void run('refine')}>{mock?'演示润色':'确认润色一次'}</button></details>}</details>

   </section>}
  </div>
  {error&&pane==='candidate'&&!composerOpen&&<p className="review-status" role="status">{error}</p>}
  {pane==='candidate'&&!composerOpen?<div className="review-compose-closed"><button onClick={()=>{setComposerOpen(true);setCandidateMode(pending);setIntent('write');}}>继续提修改要求…</button><button className="link" onClick={()=>openPane('conversation')}>返回对话</button></div>:<div className="co-compose">{error&&<p role="status">{error}</p>}<div className="target-row"><span className="writing-target-badge" title={targetLabel}>{targetLabel}</span>{usingCandidate?<button className="link" onClick={()=>{setCandidateMode(false);setMode('auto');}}>换到正文光标</button>:<button className="link" disabled={busy} onClick={()=>{navigationRef.current++;setMode(mode==='append'?'auto':'append');setConsent(false);}}>{mode==='append'?'跟随光标':'改在章末'}</button>}<div className="prompt-intent"><button aria-pressed={intent==='write'} onClick={()=>setIntent('write')}>写作</button><button aria-pressed={intent==='discuss'} onClick={()=>setIntent('discuss')}>讨论</button></div></div>
   {!mock&&<label className="co-consent"><input type="checkbox" checked={consent} onChange={e=>setConsent(e.target.checked)}/>同意本次发送位置附近正文、近期讨论、候选及批准设定/文风；1次请求，输入最多24000字符、输出4096 tokens，无自动重试。</label>}
   <div className="co-input"><textarea aria-label="创作指令" title="Enter 发送，Shift+Enter 换行" placeholder={intent==='discuss'?'聊人物、剧情或这一稿的写法……':usingCandidate?'继续提修改要求；满意后说“采用这稿”。':'直接说想怎么写；满意后说“采用这稿”。'} rows={2} value={instruction} onChange={e=>{if(busy)browsingRef.current=true;setInstruction(e.target.value);try{sessionStorage.setItem(`ns.prompt-draft.${chapterId}`,e.target.value);}catch{/* optional local draft */}}} onKeyDown={e=>{if(e.key==='Enter'&&!e.shiftKey&&!e.nativeEvent.isComposing){e.preventDefault();if(!busy&&instruction.trim()&&canRequest)void submit();}}}/>{busy?<button disabled={applying} onClick={stop}>{applying?'保存中…':'停止'}</button>:<button className="primary" disabled={!instruction.trim()||!canRequest} onClick={()=>void submit()}>{command?'确认写入':primaryLabel}</button>}</div>
  </div>}
 </section>;
}
