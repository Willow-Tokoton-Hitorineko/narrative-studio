/** CodeMirror uses one UTF-16 unit per line break; source files may use CRLF. */
export function editorText(source:string){return source.replace(/\r\n|\r/g,'\n');}
export function sourceOffset(source:string,offset:number){
 let extra=0,cursor=0;for(;;){const at=source.indexOf('\r',cursor);if(at<0||at-extra>=offset)break;if(source[at+1]==='\n')extra++;cursor=at+1;}return Math.min(source.length,offset+extra);
}
export function editorOffset(source:string,offset:number){return editorText(source.slice(0,offset)).length;}
export function sourceRange(source:string,range:{start:number;end:number}){return {start:sourceOffset(source,range.start),end:sourceOffset(source,range.end)};}

export function editorAiRanges(source:string,message:string|null){
 try{const meta=JSON.parse(message??'{}');const ranges:Array<{start:number;end:number}>=meta.ranges??(meta.kind==='ai-adopted'?[{start:meta.start,end:meta.end}]:[]);return ranges.map(r=>meta.kind==='ai-adopted'||meta.coordinateSpace==='source'?{...r,start:editorOffset(source,r.start),end:editorOffset(source,r.end)}:r);}catch{return [];}
}
