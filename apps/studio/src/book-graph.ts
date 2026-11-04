export interface GraphPerson {name:string}
export interface GraphRelation {from:string;to:string;kind:string;time:string}
export interface GraphFramework {characters:GraphPerson[];relationships?:GraphRelation[]}
export function renameFrameworkCharacter<T extends GraphFramework>(framework:T,index:number,name:string):T{
 if(framework.characters.some((p,i)=>i!==index&&p.name===name&&name.trim()))throw new Error('人物姓名不能重复');
 const old=framework.characters[index]?.name;if(old===undefined)throw new Error('人物不存在');
 return {...framework,characters:framework.characters.map((p,i)=>i===index?{...p,name}:p),relationships:framework.relationships?.map(r=>({...r,from:r.from===old?name:r.from,to:r.to===old?name:r.to}))};
}
export function layoutBookGraph(people:GraphPerson[],relations:GraphRelation[]){
 const columns=Math.min(3,Math.max(1,Math.ceil(Math.sqrt(people.length)))),width=columns*180+(columns-1)*90+80;
 const nodes=people.map((p,i)=>({...p,index:i,x:40+(i%columns)*270,y:40+Math.floor(i/columns)*190,width:180,height:68}));
 let height=Math.max(240,Math.ceil(people.length/columns)*190+20);const labels:Array<{x:number;y:number}>=[];
 const edges=relations.flatMap((r,index)=>{const from=nodes.find(p=>p.name===r.from),to=nodes.find(p=>p.name===r.to);if(!from||!to)return [];
 const a={x:from.x+90,y:from.y+34},b={x:to.x+90,y:to.y+34},dx=b.x-a.x,dy=b.y-a.y;
 const bound=(cx:number,cy:number,vx:number,vy:number)=>{const factor=Math.min(vx===0?Infinity:90/Math.abs(vx),vy===0?Infinity:34/Math.abs(vy));return {x:cx+vx*factor,y:cy+vy*factor};};
 const start=from===to?{x:from.x+180,y:a.y}:bound(a.x,a.y,dx,dy),end=from===to?{x:from.x+90,y:from.y}:bound(b.x,b.y,-dx,-dy);
 const longEdge=Math.abs(from.index-to.index)>columns;
 const anchor=longEdge?{x:width-20,y:(from.y+98+to.y-30)/2}:{x:(start.x+end.x)/2,y:(start.y+end.y)/2};
 let label={...anchor};
 while(labels.some(p=>Math.abs(p.x-label.x)<30&&Math.abs(p.y-label.y)<30)||nodes.some(p=>label.x>p.x-16&&label.x<p.x+196&&label.y>p.y-16&&label.y<p.y+84))label={...label,y:label.y+30};
 labels.push(label);height=Math.max(height,label.y+40);
 return [{...r,index,start,end,label,anchor,path:longEdge?`M ${from.x+90} ${from.y+68} L ${from.x+90} ${from.y+98} L ${width-20} ${from.y+98} L ${width-20} ${to.y-30} L ${to.x+90} ${to.y-30} L ${to.x+90} ${to.y}`:from===to?`M ${start.x} ${start.y} C ${start.x+70} ${start.y-100}, ${end.x+60} ${end.y-80}, ${end.x} ${end.y}`:`M ${start.x} ${start.y} L ${end.x} ${end.y}`}];});
 return {width,height,nodes,edges};
}
