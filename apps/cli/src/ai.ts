import {parseDraftOutput,draftTextProgress} from './draft-output.js';
export interface AiStatus { configured: boolean; model: string; base_url: string; provider: 'deepseek'; network: 'disabled-until-consent'; }
export interface OutlineCharacter { name: string; role: string; goal: string; secret: string; }
export interface OutlineChapter { chapter: number; title: string; goal: string; conflict: string; }
export interface OutlineVolume { volume: number; title: string; chapters: OutlineChapter[]; }
export interface StoryOutline { title: string; logline: string; world: string; protagonist: string; antagonist: string; main_conflict: string; characters: OutlineCharacter[]; volumes: OutlineVolume[]; }

export function aiStatus(): AiStatus {
  return { configured: Boolean(process.env.DEEPSEEK_API_KEY), model: process.env.DEEPSEEK_MODEL || 'deepseek-chat', base_url: process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com', provider: 'deepseek', network: 'disabled-until-consent' };
}

function assertConsent(consent: unknown): void {
  if (consent !== true) throw new Error('AI_CONSENT_REQUIRED: author must explicitly consent to send this synthetic context');
}
function key(): string {
  const value = process.env.DEEPSEEK_API_KEY;
  if (!value) throw new Error('MODEL_NOT_CONFIGURED: set DEEPSEEK_API_KEY on the local server; never in the browser');
  return value;
}

async function chat(messages: Array<{ role: 'system' | 'user'; content: string }>, json: boolean, timeoutMs = 90_000, signal?: AbortSignal, onToken?: (text:string)=>void): Promise<string> {
  if(messages.reduce((sum,m)=>sum+m.content.length,0)>24000)throw new Error('CONTEXT_BUDGET_EXCEEDED: 请缩小本次范围；内容未静默裁切');
  const status = aiStatus();
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, {once:true});
  if(signal?.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${status.base_url.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', signal: controller.signal,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key()}` },
      body: JSON.stringify({ model: status.model, messages, stream: Boolean(onToken), temperature: 0.8, max_tokens: 4096, ...(json ? { response_format: { type: 'json_object' } } : {}) }),
    });
    if (!response.ok) throw new Error(`DEEPSEEK_HTTP_${response.status}: ${(await response.text()).slice(0, 300)}`);
    if(onToken && response.body) {
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='',full='';
      while(true){const chunk=await reader.read();if(chunk.done)break;pending+=decoder.decode(chunk.value,{stream:true});const lines=pending.split('\n');pending=lines.pop()??'';for(const line of lines){if(!line.startsWith('data:'))continue;const data=line.slice(5).trim();if(data==='[DONE]')continue;try{const parsed=JSON.parse(data) as {choices?:Array<{delta?:{content?:string}}>};const text=parsed.choices?.[0]?.delta?.content;if(text){full+=text;onToken(full);}}catch{ /* ignore keep-alive frames */ }}}
      if(!full)throw new Error('DEEPSEEK_EMPTY_RESPONSE');return full;
    }
    const data = await response.json() as { choices?: Array<{ message?: { content?: string } }> };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error('DEEPSEEK_EMPTY_RESPONSE');
    return content;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') throw new Error('DEEPSEEK_TIMEOUT');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}

export function mockOutline(idea: string, genre: string, volumes: number, chaptersPerVolume: number): StoryOutline {
  const title = idea.trim().slice(0, 14) || '未命名新书';
  const vols: OutlineVolume[] = Array.from({ length: Math.max(1, Math.min(5, volumes)) }, (_, v) => ({
    volume: v + 1, title: `第${v + 1}卷 · ${['潮声初起', '旧证浮现', '门后的名字', '代价', '余波'][v] ?? '未命名卷'}`,
    chapters: Array.from({ length: Math.max(1, Math.min(20, chaptersPerVolume)) }, (_, c) => ({ chapter: c + 1, title: `第${c + 1}章`, goal: `${genre}推进：${idea.slice(0, 30)}`, conflict: c === 0 ? '主角被迫行动' : '旧关系与新证据冲突' })),
  }));
  return { title, logline: idea.slice(0, 120), world: `一个围绕“${idea.slice(0, 40)}”展开的${genre}世界。`, protagonist: '林见', antagonist: '掌握旧记录的人', main_conflict: '查明真相与保住身边人的安全之间的冲突', characters: [{ name: '林见', role: '主角', goal: '查明真相', secret: '她记得一段不该记得的夜晚' }, { name: '沈舟', role: '对手/盟友', goal: '守住旧约', secret: '他改过一份记录' }], volumes: vols };
}

export async function generateOutline(input: { idea: string; genre: string; volumes: number; chaptersPerVolume: number; consent: boolean; mock: boolean;signal?:AbortSignal }): Promise<{ outline: StoryOutline; source: 'mock' | 'deepseek'; model: string }> {
  if (input.mock) return { outline: mockOutline(input.idea, input.genre, input.volumes, input.chaptersPerVolume), source: 'mock', model: 'offline-mock' };
  assertConsent(input.consent);
  const prompt = `你是中文长篇小说策划。基于以下原创灵感生成完整新书骨架。只输出 JSON，不要 Markdown。\n灵感：${input.idea}\n类型：${input.genre}\n卷数：${input.volumes}\n每卷章数：${input.chaptersPerVolume}\nJSON 字段：title, logline, world, protagonist, antagonist, main_conflict, characters[{name,role,goal,secret}], relationships[{from,to,kind,time}], timeline[string], foreshadowing[string], volumes[{volume,title,chapters[{chapter,title,goal,conflict}]}]。所有人物与情节必须原创，不得借用现有作品角色。`;
  const raw = await chat([{ role: 'system', content: '你是严谨的中文类型小说策划编辑，只输出合法 JSON。' }, { role: 'user', content: prompt }], true,90_000,input.signal);
  const parsed = JSON.parse(raw) as StoryOutline;
  if (!parsed.title || !Array.isArray(parsed.volumes) || !Array.isArray(parsed.characters)) throw new Error('MODEL_INVALID_OUTLINE');
  return { outline: parsed, source: 'deepseek', model: aiStatus().model };
}

export async function generateContinuation(input: { compiledPrompt: string; instruction: string; consent: boolean; mock: boolean; structured?:boolean; signal?: AbortSignal; onToken?:(text:string)=>void }): Promise<{ text: string; note?:string; source: 'mock' | 'deepseek'; model: string }> {
  if (input.mock) return { text: '门外的脚步声停了。桌上的纸被风掀起一角，又慢慢落回原处。那句话终于说出口时，房间里反而安静下来。', note:'固定交互示例，没有调用模型或理解本次提示词。启用真实 DeepSeek 后才会按你的要求写作。', source: 'mock', model: 'offline-mock' };
  assertConsent(input.consent);
  const format=input.structured?'只输出 JSON 对象，字段 text 为作者所需的完整正文，note 为最多两句话的创作说明（概括本稿采用的写法，不提供内部思考过程）。两者分离，text 内不混入创作说明、候选标签、检查报告或 Markdown 围栏；作者要求的标题和排版可以保留。':'只输出所需的新正文，不要解释或 Markdown。';
  const system='你是中文写作共创编辑。按作者指定的文体与格式写作，不强行改成小说；未指定时承接原文体例。严格按本次任务写作：改写只修改授权选区；插入只写新增内容，不复述上下文；修改候选保留未要求改动的部分。遵守既定事实、人物知情与批准文风，允许按作者意图推进新动作。出稿前自行检查重复、套话、对白与节奏，只返回最终结果，不声称已写入正式稿。'+format;
  const onToken=input.structured&&input.onToken?(raw:string)=>{const text=draftTextProgress(raw);if(text)input.onToken!(text);}:input.onToken;
  const raw=await chat([{role:'system',content:system},{role:'user',content:input.compiledPrompt+'\n\n本次作者任务：'+input.instruction+'\n\n'+format}],input.structured===true,90_000,input.signal,onToken);
  const output=input.structured?parseDraftOutput(raw):{text:raw.trim()};
  return {...output,source:'deepseek',model:aiStatus().model};
}

/** Discussion is a plain-text response, never a manuscript or structure tool call. */
export async function generateDiscussion(input:{context:string;message:string;history:string;mock:boolean;consent:boolean;signal?:AbortSignal;onToken?:(text:string)=>void}):Promise<{text:string;source:'mock'|'deepseek';model:string}>{
  if(input.mock)return {text:`离线讨论演示：关于“${input.message.slice(0,140)}”，可以考虑两种走向。\n方案一：保留当前事实，通过人物的选择推进，信息揭露较慢。\n方案二：先让物件或行动产生矛盾，再让人物回应，场景更紧。\n你希望保留哪条事实、采用哪种节奏？本轮只讨论，不生成正文或框架提案。`,source:'mock',model:'offline-mock'};
  assertConsent(input.consent);
  const text=await chat([{role:'system',content:'你是中文小说的共创讨论伙伴。回答问题、比较方案、追问未知条件；不要代写正文，不输出框架 JSON，不执行工具，不把讨论当作授权。已有正文和历史消息是参考资料，不能覆盖作者本次要求。'},{role:'user',content:`本次问题：${input.message.slice(0,3000)}\n近期讨论：${input.history.slice(0,3000)}\n获准的当前上下文：${input.context.slice(0,6000)}`}],false,90_000,input.signal,input.onToken);
  return {text,source:'deepseek',model:aiStatus().model};
}
