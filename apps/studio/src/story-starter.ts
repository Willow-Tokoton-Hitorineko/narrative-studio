export const STORY_STEPS=[
 {title:'灵感',question:'先说一个让你想写下去的念头。',fields:[['premise','一句话灵感','例如：一座灯塔开始收到未来寄来的信。'],['tone','类型与氛围','例如：悬疑、温暖、慢节奏；不知道也可以空着。']]},
 {title:'主角',question:'故事跟着谁走？',fields:[['hero','谁是主角？','名字或身份都可以。'],['desire','主角最想得到什么？','一个具体的愿望。'],['urgency','为什么现在必须行动？','是什么打破了原来的生活？']]},
 {title:'阻力与关系',question:'有了阻力，故事才会往前走。',fields:[['obstacle','谁或什么挡住主角？','一个人、一条规则，或主角自己的弱点。'],['stakes','如果失败，会失去什么？','让这个愿望变得重要。'],['bond','最重要的两个人是什么关系？','例如：互不信任，却必须同行。']]},
 {title:'世界',question:'给故事一个落脚的地方。',fields:[['setting','故事在哪里、什么时候？','一座小城、未来、当代校园……'],['rule','这里有什么特别的规则？','现实故事也可以写家庭、行业或社会的约束。']]},
 {title:'剧情',question:'只需三个路标，不用一次想完。',fields:[['opening','开篇发生什么？','让主角不得不行动的一件事。'],['turn','中途怎样变糟？','一次失败、一个秘密，或一次关系变化。'],['ending','结尾想留下什么？','一个结果、一种情绪，没想好就留空。']]},
] as const;
export type StoryAnswers=Record<string,string>;
export function storyPrompt(answers:StoryAnswers,step?:number):string{
 const groups=STORY_STEPS.map((s,i)=>{const filled=s.fields.filter(([key])=>answers[key]?.trim()).map(([key,label])=>`${label}：${answers[key]!.trim()}`);return filled.length?`【${i+1}. ${s.title}】\n${filled.join('\n')}`:'';}).filter(Boolean);
 if(!groups.length)throw new Error('先填一个念头，其他都可以慢慢补。');
 const prompt=`${answers.premise?.trim()||'新故事构思'}\n\n作者的构思草稿（空白表示尚未决定，请勿当成已确认设定）：\n${groups.join('\n\n')}\n\n${step===undefined?'请基于这些选择整理世界、人物、关系及卷章剧情的待确认方案。未确定的内容用建议表达，不要擅自改变作者已经填写的要点。':`这轮只讨论“${STORY_STEPS[step]!.title}”。先回应已有选择，再提出两三个可选方向，最后问一个容易回答的问题。暂不生成正式正文或写入设定。`}`;
 const limit=step===undefined?4000:3000;if(prompt.length>limit)throw new Error(`本轮构思超过 ${limit} 字符，请精简后再发送；填写内容仍保留，不会截断发送。`);return prompt;
}

export function stageProgress(answers:StoryAnswers,stage:typeof STORY_STEPS[number]){return stage.fields.filter(([key])=>answers[key]?.trim()).length;}
export function storySnapshot(answers:StoryAnswers){const value=(key:string,fallback:string)=>answers[key]?.trim()||fallback;return `在${value('setting','尚待勾勒的地方')}，${value('hero','一位还未命名的主角')}为了${value('desire','尚未说出口的愿望')}，必须面对${value('obstacle','未露面的阻力')}。${answers.stakes?.trim()?'如果失败，'+answers.stakes.trim()+'。':''}`;}

export function storyCardPrompt(answers:StoryAnswers,step:number,label:string,directions:boolean){
 const any=Object.values(answers).some(value=>value.trim());
 if(!any&&directions)return `我正在构思一个新故事，想先解决“${label}”。请给几个具体而不同的起点，让我自己选择，不生成正式方案。`;
 const prompt=storyPrompt(answers,step)+`\n当前只聊：${label}。${directions?'我还没有答案，请给几个具体而不同的起点，让我自己选择。':'请围绕这个问题帮我推敲，不必重复整份设定。'}`;
 if(prompt.length>3000)throw new Error('本轮讨论超过 3000 字符，请先精简；填写内容保留，不截断发送。');return prompt;
}
