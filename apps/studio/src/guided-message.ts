/** Display the author's guided choices without leaking the prompt scaffold into chat. Storage and model context stay intact. */
export function guidedMessage(text:string,role:string,source?:string):{text:string;brief?:string}{
 const marker='作者的构思草稿（空白表示尚未决定，请勿当成已确认设定）：';
 if(!text.includes(marker))return {text};
 if(role!=='user'){
  const at=text.indexOf('方案一：');return source==='mock'&&at>=0?{text:text.slice(at)}:{text};
 }
 const card=/当前只聊：([^\n。]+)。/.exec(text)?.[1],stage=/这轮只讨论“([^”]+)”/.exec(text)?.[1];
 const brief=text.slice(text.indexOf(marker)+marker.length).split(/\n\n(?:请基于这些选择|这轮只讨论)/)[0]!.trim();
 return {text:card?`聊聊这件事：${card}`:stage?`一起想想「${stage}」。`:'把这些念头整理成故事方案。',brief};
}
