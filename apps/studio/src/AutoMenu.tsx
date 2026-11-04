import {useEffect,useRef,useState,type ReactNode} from 'react';

/** Pointer dismissal is delayed so crossing the trigger/panel never closes a menu. */
export default function AutoMenu({label,children,className=''}:{label:string;children:ReactNode;className?:string}){
 const host=useRef<HTMLDetailsElement>(null),delay=useRef<ReturnType<typeof setTimeout>|undefined>(undefined),finish=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 const [closing,setClosing]=useState(false);
 const cancel=()=>{clearTimeout(delay.current);clearTimeout(finish.current);setClosing(false);};
 const close=()=>{cancel();setClosing(true);finish.current=setTimeout(()=>{if(host.current)host.current.open=false;setClosing(false);},160);};
 useEffect(()=>{const outside=(e:PointerEvent)=>{if(host.current?.open&&!host.current.contains(e.target as Node)){clearTimeout(delay.current);clearTimeout(finish.current);host.current.open=false;setClosing(false);}};document.addEventListener('pointerdown',outside);return()=>{clearTimeout(delay.current);clearTimeout(finish.current);document.removeEventListener('pointerdown',outside);};},[]);
 return <details ref={host} className={`aux-tools auto-menu ${className} ${closing?'is-closing':''}`} onPointerEnter={cancel} onPointerLeave={e=>{if(e.pointerType!=='mouse'||!e.relatedTarget)return;delay.current=setTimeout(close,360);}} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();cancel();if(host.current){host.current.open=false;host.current.querySelector('summary')?.focus();}}}}><summary>{label}</summary><div>{children}</div></details>;
}
