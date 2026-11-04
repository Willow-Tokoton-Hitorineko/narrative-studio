import {guidedMessage} from '../../apps/studio/src/guided-message.js';
import {describe,it,expect} from 'vitest';
import {authorConfirmation,confirmationProblem,reviewBrief} from '../../apps/studio/src/author-interaction.js';
import {resolvePromptTarget,promptScope} from '../../apps/studio/src/prompt-scope.js';
import {storyCardPrompt,stageProgress,storySnapshot,STORY_STEPS} from '../../apps/studio/src/story-starter.js';
describe('Author atelier interaction boundaries',()=>{
 it('keeps guided chat readable while preserving supplied story details in an expandable brief',()=>{const prompt=storyCardPrompt({premise:'明天的信'},1,'谁是主角？',false),shown=guidedMessage(prompt,'user');expect(shown.text).toBe('聊聊这件事：谁是主角？');expect(shown.brief).toContain('明天的信');expect(shown.brief).not.toContain('请围绕');expect(guidedMessage('普通问题','user')).toEqual({text:'普通问题'});});
 it('accepts only explicit author confirmations, never discussion or negated phrases',()=>{
  expect(authorConfirmation('采用这稿。')).toBe('apply');expect(authorConfirmation('确认插入')).toBe('insert');expect(authorConfirmation('确认替换')).toBe('replace');
  for(const text of ['不要采用这稿','讨论一下是否采用这稿','AI说：采用这稿','把“采用这稿”写进对白','采用这稿并扩写全章'])expect(authorConfirmation(text)).toBeNull();
 });
 it('refuses mismatched, stale-position, blocked and already-applied local confirmations',()=>{
  const c={start:2,end:5,blocking:false};expect(confirmationProblem('insert',c,false)).toContain('替换范围');expect(confirmationProblem('replace',{...c,end:2},false)).toContain('插入位置');expect(confirmationProblem('apply',c,true)).toContain('位置变了');expect(confirmationProblem('apply',{...c,blocking:true},false)).toContain('冲突');expect(confirmationProblem('apply',{...c,applied:'rev_1'},false)).toContain('没有待采用');expect(confirmationProblem('apply',c,false)).toBe('');
 });
 it('resolves explicit paragraph edits from a live caret without changing surrounding text',()=>{
  const text='第一段保留。\n\n第二段。\n同一段的下一行。\n\n第三段保留。',caret=text.indexOf('同一段');
  const current=resolvePromptTarget(text,{start:caret,end:caret},'auto',true,'把光标所在段改写得克制一些');expect(text.slice(current.start,current.end)).toBe('第二段。\n同一段的下一行。');
  const previous=resolvePromptTarget(text,{start:caret,end:caret},'auto',true,'改写上一段');expect(text.slice(previous.start,previous.end)).toBe('第一段保留。');
  expect(resolvePromptTarget(text,{start:caret,end:caret},'auto',true,'继续写')).toEqual({start:caret,end:caret});expect(promptScope('不要修改上一段，只续写')).toBeNull();
  expect(promptScope('把这一段改成上一段的语气')).toBe('current');expect(promptScope('不要动上一段，把这一段改得克制一点')).toBe('current');
  for(const instruction of ['把上一段与这一段改写','改写上一段，以及这一段'])expect(()=>resolvePromptTarget(text,{start:caret,end:caret},'auto',true,instruction)).toThrow('多个');
 });
 it('keeps precise selections and rejects missing paragraph anchors',()=>{
  expect(resolvePromptTarget('甲乙\n\n丙丁',{start:1,end:2},'auto',true,'改写上一段')).toEqual({start:1,end:2});
  expect(()=>resolvePromptTarget('甲乙',{start:0,end:0},'auto',false,'修改当前段落')).toThrow('点一下');
  expect(()=>resolvePromptTarget('甲乙',{start:1,end:1},'auto',true,'改写上一段')).toThrow('前面没有');
 });
 it('shows actionable review hints rather than a wall of insufficient-check explanations',()=>{
  const c={blocking:false,style:'尚无风格样本，本次未执行风格匹配',reviews:[{severity:'insufficient',reason:'工程细节'},{severity:'warning',reason:'重复句需要看一下'}]};const brief=reviewBrief(c);expect(brief.warnings.map(r=>r.reason)).toEqual(['重复句需要看一下']);expect(brief.style).toBe('未提供文风样本');expect(brief.summary).toContain('1');
 });
 it('reports partial card progress honestly and preserves uncertainty in the story summary',()=>{
  expect(stageProgress({hero:'顾遥'},STORY_STEPS[1])).toBe(1);expect(storySnapshot({hero:'顾遥'})).toContain('尚未说出口的愿望');expect(storyCardPrompt({},1,'谁是主角？',true)).toContain('让我自己选择');
  expect(()=>storyCardPrompt({hero:'人'.repeat(3200)},1,'谁是主角？',true)).toThrow('保留');
 });
});
