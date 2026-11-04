/** Small, safe prose renderer. Never interpret model output as HTML. */
export default function MessageText({text}:{text:string}) {
 const lines=text.split('\n');
 return <div className="message-prose">{lines.map((line,i)=>{
  if(!line.trim())return i>0&&lines[i-1]?.trim()?<span className="message-break" key={i} aria-hidden="true"/>:null;
  const parts=line.replace(/^#{1,4}\s+/,'').split(/(\*\*[^*]+\*\*)/g).map((part,j)=>part.startsWith('**')?<strong key={j}>{part.slice(2,-2)}</strong>:part);
  return /^#{1,4}\s/.test(line)?<h4 key={i}>{parts}</h4>:<p key={i}>{parts.length?parts:'\u00a0'}</p>;
 })}</div>;
}
