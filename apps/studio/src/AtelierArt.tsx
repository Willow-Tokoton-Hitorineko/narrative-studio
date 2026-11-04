import {useState,useSyncExternalStore} from 'react';
import {nextAtelierQuote} from './atelier-quotes';
const preferenceKey='ns.atelier-art.v1',preferenceEvent='ns-atelier-art';
let fallback=true;
function snapshot(){try{return localStorage.getItem(preferenceKey)!=='off';}catch{return fallback;}}
function subscribe(listener:()=>void){window.addEventListener('storage',listener);window.addEventListener(preferenceEvent,listener);return()=>{window.removeEventListener('storage',listener);window.removeEventListener(preferenceEvent,listener);};}
function change(shown:boolean){fallback=shown;try{localStorage.setItem(preferenceKey,shown?'on':'off');}catch{/* An unavailable preference store must not block writing. */}window.dispatchEvent(new Event(preferenceEvent));}
export function useAtelierArt(){return useSyncExternalStore(subscribe,snapshot,()=>true);}
export function AtelierToggle(){const shown=useAtelierArt();return <button type="button" className="ghost" aria-pressed={shown} onClick={()=>change(!shown)}>{shown?'隐藏剧场装饰':'显示剧场装饰'}</button>;}
function useQuote(){const [quote,setQuote]=useState(''),[speaking,setSpeaking]=useState(false);return {quote,speaking,enter:()=>{setQuote(nextAtelierQuote());setSpeaking(true);},leave:()=>setSpeaking(false)};}
export function AtelierPortrait(){const shown=useAtelierArt(),line=useQuote();return shown?<span className="atelier-portrait-wrap" onMouseEnter={line.enter} onMouseLeave={line.leave}><span className="atelier-portrait" aria-hidden="true"><img src="/atelier-stage.svg" alt=""/></span><span className={`atelier-line ${line.speaking?'is-speaking':''}`} role="tooltip">{line.quote}</span></span>:null;}
export default function AtelierArt({variant='scene'}:{variant?:'scene'|'companion'}){
 const shown=useAtelierArt();
 const line=useQuote();
 return shown?<aside className={`atelier-art atelier-${variant}`} aria-label={variant==='companion'?'写作陪伴插画':'装饰插画'} onMouseEnter={line.enter} onMouseLeave={line.leave}><button type="button" className="link" onClick={()=>change(false)} aria-label="隐藏剧场装饰">×</button><img src="/atelier-stage.svg" alt="靛蓝拱窗下的月亮、羽笔与书页" loading="lazy" tabIndex={0} onFocus={line.enter} onBlur={line.leave}/><span className={`atelier-line ${line.speaking?'is-speaking':''}`} role="tooltip">{line.quote}</span>{variant==='companion'&&<span className="atelier-caption">写作间</span>}</aside>:variant==='scene'?<button type="button" className="link art-reveal" onClick={()=>change(true)}>显示插画</button>:null;
}
