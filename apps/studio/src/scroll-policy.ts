export function shouldAutoFollow(input:{docLength:number;end:number;scrollTop:number;scrollHeight:number;clientHeight:number;rangeBottom?:number;viewportTop:number;viewportBottom:number}):boolean{
 if(input.end>=input.docLength)return input.scrollHeight-input.scrollTop-input.clientHeight<=64;
 return input.rangeBottom!==undefined&&input.rangeBottom>=input.viewportTop&&input.rangeBottom<=input.viewportBottom;
}
