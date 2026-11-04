#!/usr/bin/env node
/**
 * Narrative Studio — reproducible Synthetic Novel Test Corpus generator.
 *
 * The corpus is original synthetic Chinese prose, not a real novel and not a
 * "repeat one paragraph 1000 times" benchmark. It is generated from a small
 * deterministic story world (characters, locations, objects, arcs, scene
 * templates) so that a long novel has recurring people, events, dialogue,
 * foreshadowing and variation while every run is byte-for-byte reproducible.
 *
 * Usage:
 *   node tools/synthetic-corpus/generate.mjs --out corpus/generated
 *   node tools/synthetic-corpus/generate.mjs --out <dir> --seed 20261020 --profile all
 *
 * Outputs text + a corpus-manifest.json with hashes, encodings and expected
 * structural coverage. The generated directory is git-ignored; commit the
 * generator, not the 450k-character artifact.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import iconv from 'iconv-lite';

const TOOL_VERSION = '1.0.0';
const DEFAULT_SEED = 20261020;
const FIXED_TIME = '2026-10-20T00:00:00.000Z';

const characters = [
  { name: '林知远', role: '潮汐档案员', goal: '找回父亲缺失的航海日志', secret: '他曾替父亲隐瞒一次沉船', voice: '克制、先问证据', lines: ['“先看记录，再下判断。”', '“这本日志缺了七页，不是潮气咬掉的。”', '“我不怕答案，我怕答案只对我有利。”', '“父亲欠港口的，不该由你来还。”', '“如果真相会伤人，至少让它伤得准确。”'] },
  { name: '戴岚', role: '旧灯塔守塔人', goal: '弄清第九级台阶上的刻痕', secret: '她认得那个歪斜的“岚”字', voice: '短句、带刺、回避过去', lines: ['“台阶不会说谎，人才会。”', '“你来晚了，潮水可不等你。”', '“别用那种眼神看我，我不是证物。”', '“灯塔照得到海，照不到人心。”', '“有些名字刻下去，是为了被忘记。”'] },
  { name: '沈砚', role: '港务署长', goal: '维持港口秩序与自己的体面', secret: '他签过一份不该签的放行单', voice: '公文腔、笑里藏刀', lines: ['“港口要的是秩序，不是故事。”', '“手续齐全，我就当没看见。”', '“你要查？可以，先写申请。”', '“沉船那年，谁都不干净。”', '“别把私人的账，算到港口头上。”'] },
  { name: '苏禾', role: '港口医生', goal: '查清多年前的疫病记录', secret: '她保存着一份被改过的死亡名单', voice: '温和、精确、偶尔锋利', lines: ['“先坐下，你的手在抖。”', '“死亡名单上，有人死了两次。”', '“我不是善良，我只是记得。”', '“药能治伤，治不了沉默。”', '“你要是信我，就别瞒我。”'] },
  { name: '顾行舟', role: '三号船坞船长', goal: '把最后一船货送出港', secret: '货舱里藏着一箱旧信', voice: '玩笑、江湖气、重承诺', lines: ['“船不挑客人，海挑。”', '“我欠你一次，记在潮位上。”', '“别问货，问就是咸鱼。”', '“风浪大才好，没人看得清。”', '“我这条船，不载背叛。”'] },
  { name: '阿棠', role: '码头跑腿', goal: '攒钱离开暮光港', secret: '她看见过放火的人', voice: '快、直、少年气', lines: ['“我跑得快，不是因为我心虚。”', '“那晚我看见了，可我不想死。”', '“给我一条船，我就敢走。”', '“你们大人说话，总爱漏掉最要紧的。”', '“别摸我的口袋，里面是别人的命。”'] },
  { name: '陆砚秋', role: '《暮光日报》编辑', goal: '发一篇能改变港口的报道', secret: '她的报纸收过港务署的钱', voice: '冷静、审慎、职业性怀疑', lines: ['“消息要两个来源，悲伤不用。”', '“你给我的，是证据还是希望？”', '“报纸能救人，也能杀人。”', '“我不登没有署名的真相。”', '“先证明它，再让我感动。”'] },
  { name: '罗婆婆', role: '补网人', goal: '把旧事说给愿意听的人', secret: '她替人藏过一封信', voice: '慢、旧词、像潮声', lines: ['“那年潮大，人的心也大。”', '“网破了能补，话断了难接。”', '“你父亲来补过网，手很稳。”', '“别急着问，先听水。”', '“我老了，可我记得谁撒过谎。”'] },
  { name: '陈铎', role: '港警', goal: '抓住纵火案的真凶', secret: '他妹妹在失踪名单上', voice: '硬、守法、内心裂缝', lines: ['“规矩不是给好人定的。”', '“你再往前走，我就得抓你。”', '“我妹妹也在这张名单上。”', '“别让我在程序和良心之间选。”', '“证据不够，我就再等一夜。”'] },
  { name: '白鹭', role: '雨巷歌女', goal: '摆脱替人传话的差事', secret: '她唱歌的调子来自一份密码', voice: '轻、绕、句句留门', lines: ['“歌听懂了，就不用问词。”', '“我卖唱，不卖耳朵。”', '“你听，第三句才是真话。”', '“有人让我唱给死人听。”', '“别记住我，记住调子。”'] },
  { name: '周先生', role: '钟表匠', goal: '修好钟楼停摆的钟', secret: '钟停的那刻他在场', voice: '精确、比喻、时间执念', lines: ['“钟不是坏了，是不肯走。”', '“时间会偏，人也会。”', '“你迟了四分十七秒。”', '“我修表，不修命。”', '“停摆那晚，我听见两声钟。”'] },
  { name: '小满', role: '收留所孩子', goal: '守住捡来的铜哨', secret: '铜哨不是他捡的', voice: '短、警惕、突然柔软', lines: ['“哨子会响，但我不会吹。”', '“大人一弯腰，我就跑。”', '“这个不能给你，它认人。”', '“我梦见海里有灯。”', '“你要是好人，明天还来。”'] },
];

const locations = [
  { name: '旧灯塔', detail: '第九级台阶有一道新划痕，铁门被盐雾咬出红锈', sound: '潮水撞上礁石，像有人在门外数数' },
  { name: '潮汐档案室', detail: '木柜贴着年份标签，最里面一格永远锁着', sound: '纸张翻动时，有细小的沙粒落下' },
  { name: '咸鱼市场', detail: '凌晨的鱼鳞在灯下反光，地上积着黑水', sound: '叫卖声、刀背敲砧板、拖网摩擦石阶' },
  { name: '三号船坞', detail: '半沉的旧船搁在木架上，船头漆着褪色的蓝线', sound: '木槌敲铁钉，一下比一下沉' },
  { name: '钟楼', detail: '铜钟停在七点，指针被谁用细线缠住', sound: '风穿过钟室，像一口很长的叹息' },
  { name: '雨巷茶馆', detail: '窗纸泛黄，桌上留着上一桌客人的茶渍', sound: '雨脚落在瓦上，壶盖轻轻跳' },
  { name: '北堤墓园', detail: '石阶被海风磨圆，几块碑上刻着相同的日期', sound: '海鸟低飞，翅膀擦过风' },
  { name: '废弃盐仓', detail: '墙根结着蓝白色盐晶，地上有拖拽的痕迹', sound: '盐粒在鞋底碎裂，回声很空' },
  { name: '雾中码头', detail: '缆绳绷紧，船灯只照出三丈远', sound: '雾笛低鸣，水面有人轻轻划桨' },
  { name: '老戏台', detail: '幕布褪成灰粉，台板上留着水袖拖过的亮痕', sound: '胡琴只拉半句，余音悬在梁上' },
];

const objects = [
  '黄铜哨', '缺页的航海日志', '蓝色盐晶', '未寄出的信', '停摆的怀表', '九级台阶上的刻痕',
  '一截烧焦的缆绳', '写着密码的戏本', '半张放行单', '父亲的旧罗盘', '带盐的纸鹤', '一盒没有标签的药',
  '船坞的备用钥匙', '记满潮位的黑板', '一张重复出现的死亡名单', '缺角的港图',
];

const weathers = [
  '潮雾压低屋檐，远处的灯像被水泡过', '细雨斜着落，石阶泛出冷光', '风从北堤来，带着铁锈和盐',
  '天色像一张旧纸，迟迟不肯亮', '闷雷滚过海面，鱼摊的灯忽明忽暗', '退潮后的滩涂冒着白气',
  '月光落在湿瓦上，像一层薄盐', '港口的钟声被雾吞掉一半', '空气里有雨，也有煤烟',
  '太阳只露了一线，海面却亮得刺眼',
];

const sceneTypes = [
  'arrival', 'conflict', 'discovery', 'chase', 'reflection', 'negotiation',
  'memory', 'journey', 'letter', 'interrogation', 'storm', 'betrayal',
];

const events = [
  '一只无人认领的木箱被潮水推上台阶', '档案室最里面的柜门开了一条缝', '有人在钟楼底下烧了一封信',
  '三号船坞的旧船在夜里自己响了一声', '市场上所有鱼摊同时收了灯', '墓园里多出一块没有名字的碑',
  '盐仓墙上的盐晶长成了一个人的侧影', '戏台后找到半句被涂掉的唱词', '港务署的放行单少了一联',
  '一只纸鹤落在灯塔的窗台', '有人把第九级台阶擦得异常干净', '退潮露出一截刻字的船骨',
  '茶馆的常客连续三晚没有出现', '旧报纸上登出一则提前写好的讣告', '雾笛在无船的夜里响了两次',
];

const openings = [
  '天还没亮透，{place}先醒了。{weather}。{sound}。',
  '{pov}到{place}的时候，{weather}。他/她在门口停了一瞬，才推门。',
  '海风把{place}的{detail}吹得更旧了。{weather}。',
  '那一夜的{place}没有客人。{sound}，像谁在暗处反复试音。',
  '{place}的灯只亮了一半。{weather}；{detail}。',
  '{pov}沿着湿石阶往上走，鞋底带起细碎的盐。{sound}。',
  '雾从海面漫上来，把{place}切成几块。{detail}。',
  '{place}里有一股旧木头和冷灰的味道。{pov}站了一会儿，才听见自己的呼吸。',
];

const turns = [
  '这句话之后，屋里安静得能听见灯芯爆开的声音。',
  '没有人接话。远处传来一声钝响，像有什么东西落进水里。',
  '雨忽然大了，窗纸鼓了一下，桌上的纸角翻起来。',
  '他/她把手伸进口袋，摸到的却不是想找的东西。',
  '门外有人走过，脚步在门口停住，又慢慢远了。',
  '那一刻，{pov}忽然明白，自己一直问错了问题。',
  '潮水退了一寸，露出一件本不该出现在这里的东西。',
  '远处钟楼的指针动了一下，又停住。',
];

const closings = [
  '“明天潮退之前，我们只有一次机会。”',
  '没有人知道，这句话会在三天后成为证词。',
  '灯灭了。黑暗里，有人轻轻吹了一声口哨。',
  '海面很平，平得像什么都没有发生过。',
  '那张纸被折好，塞进了最贴身的口袋。',
  '钟声没有响。整座港口都在等它响。',
  '“别告诉第三个人。”',
  '潮水开始涨了，台阶一级一级地消失。',
];

const cnDigits = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
function chineseNumber(value) {
  if (value <= 10) return value === 10 ? '十' : cnDigits[value];
  if (value < 20) return `十${cnDigits[value - 10]}`;
  if (value < 100) {
    const tens = Math.floor(value / 10);
    const ones = value % 10;
    return `${cnDigits[tens]}十${ones === 0 ? '' : cnDigits[ones]}`;
  }
  const hundreds = Math.floor(value / 100);
  const rest = value % 100;
  return `${cnDigits[hundreds]}百${rest === 0 ? '' : chineseNumber(rest)}`;
}

function xorShift(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x100000000;
  };
}

function createRng(seed) {
  const random = xorShift(seed);
  return {
    next: random,
    pick: (list) => list[Math.floor(random() * list.length)],
    chance: (probability) => random() < probability,
    int: (min, max) => min + Math.floor(random() * (max - min + 1)),
  };
}

function fill(template, context) {
  return template
    .replaceAll('{place}', context.place.name)
    .replaceAll('{detail}', context.place.detail)
    .replaceAll('{sound}', context.place.sound)
    .replaceAll('{weather}', context.weather)
    .replaceAll('{pov}', context.pov.name)
    .replaceAll('{other}', context.other.name)
    .replaceAll('{object}', context.object);
}

const times = [
  '天刚亮', '午后', '入夜前', '退潮时', '涨潮前', '雨停后', '钟响过一遍', '雾散了一半',
  '月亮升到檐口', '渔火亮起', '潮线退到第三级', '风转向北', '街灯刚换过', '海鸟回巢时',
  '下半夜', '清晨最冷的时候',
];
const features = [
  '石阶', '窗纸', '缆绳', '船骨', '盐晶', '灯罩', '木门', '铁锁', '水面', '钟摆',
  '鱼鳞', '瓦楞', '栏杆', '门槛', '桅杆', '铜环', '纸角', '水痕',
];
const states = [
  '泛着冷光', '结着白霜', '留着新痕', '蒙着一层细盐', '轻轻发颤', '比昨天更旧', '被人擦过',
  '浸出深色', '映着半盏灯', '落满细灰', '绷得很紧', '湿得发亮', '有一道缺口', '颜色发暗',
  '被风吹得翻起', '安静得反常',
];
const verbs = [
  '按住', '收起', '推开', '绕过', '擦去', '翻开', '放下', '踩住', '系紧', '挑起',
  '折断', '数着', '贴上', '藏进', '递出', '扣住', '抚平', '拎起',
];
const consequences = [
  '没有发出声音', '指尖沾了盐', '木屑落在鞋面', '灯影晃了一下', '袖口湿了一截',
  '掌心留下红痕', '纸页发出轻响', '潮气顺着缝钻进来', '对方的呼吸停了一拍',
  '远处有人关了窗', '盐粒在脚边碎开', '铜锈蹭到了手背', '空气里多了一点铁味',
  '门外的雨声近了一寸', '水面上的光断成两截', '钟楼那边没有回应',
];
const sensory = [
  '风里有铁锈和冷灰的味道', '潮气贴着皮肤，像一层薄盐', '远处传来拖网的摩擦声',
  '灯芯爆了一下，影子往墙上缩', '雨脚落在瓦上，密得听不出间隙', '船底擦过浅滩，声音很闷',
  '有人在后巷敲了三下铁皮', '海鸟低飞，翅膀擦过风', '茶壶盖轻轻跳动', '盐粒在鞋底碎裂',
  '木梁深处发出一声轻响', '雾笛低鸣，水面有人划桨', '纸张翻动时落下细沙', '铜钟的余音悬在梁上',
  '鱼摊的冰化了一半，滴答作响', '风把门缝吹出一声细哨',
];
const thoughts = [
  '这个念头一冒出来，就很难按回去',
  '他/她知道，自己已经错过了最该开口的时候',
  '有些答案不是找不到，是不敢认',
  '港口的规矩在这一刻显得很轻',
  '那句没说完的话，比说出口的更重',
  '如果潮水再退一寸，秘密就会露出来',
  '他/她忽然想起父亲也这样站过',
  '事情从来不是从今晚才坏的',
  '她/他分不清这是预感还是记忆',
  '最坏的结果，往往先以好消息的样子出现',
  '所有人都说没事，所以一定有事',
  '这一次，沉默不再是保护',
];
const genericDialogue = [
  '{object}在你手里，话就不在我这里。',
  '{place}那晚的灯，是谁点的？',
  '你要查的不是账，是人。',
  '别把{object}给第二个人看。',
  '我听见了，但我不能替你作证。',
  '{place}的规矩，你比我清楚。',
  '潮水会替我们藏东西，也会替我们翻出来。',
  '你父亲的账，不该你来还。',
  '如果名单是假的，死人就会回来。',
  '我不想知道真相，我只想知道谁安全。',
  '你问得太快了，快得像已经知道答案。',
  '那天晚上，钟只响了一声。',
  '把{object}放下，我们还能谈。',
  '你看见的第九级，不是最高的一级。',
  '别相信最早到的人。',
  '有些信寄不出去，是因为收信人已经死了。',
  '我可以闭嘴，但你要记住欠我的。',
  '你手里的东西，能救一个人，也能毁一个港。',
  '再等一夜，潮位会告诉我们。',
  '这不是第一次，也不会是最后一次。',
  '{place}的门槛，跨过去就回不了头。',
  '你要的是证据，我要的是人。',
  '别让{object}替你说话。',
  '有人希望这件事永远沉在水底。',
  '我认识那个笔迹。',
];
const dialogueVerbs = ['说', '低声说', '问', '答', '补了一句', '没有抬头', '把声音压得很低', '顿了顿才说'];
const eventDetails = [
  '没有人承认见过', '值夜的人却换了班', '地上的水痕指向后门', '灯油少了一截',
  '门闩上有新的划痕', '盐粒被扫成一堆', '有人提前收了摊', '钟楼的影子偏了半寸',
  '港图上多了一个墨点', '一只鞋印停在台阶中段', '账本被翻到同一页', '风把纸吹进了水沟',
  '巡夜的人说没有听见', '狗叫了三声就停了', '雨把脚印冲掉一半', '有人把灯芯剪短了',
  '铜哨上多了一道新擦痕', '名单的顺序变了', '放行单的存根被撕走', '船坞的锁换过了',
];
const closingTails = [
  '潮声没有停。', '港口的灯还亮着。', '谁也没有先走。', '雨又下起来了。',
  '台阶上多了一行湿脚印。', '远处有人关上了窗。', '钟楼没有回应。', '雾比刚才更低了。',
  '海面恢复了平静。', '那张纸被风吹动了一下。', '有人在后巷轻轻咳了一声。', '灯影往墙上缩了缩。',
];

function eventSentence(rng) {
  const suffix = rng.chance(0.55) ? `，${rng.pick(eventDetails)}` : '';
  return `${rng.pick(events)}${suffix}。`;
}

function closingSentence(rng) {
  const closing = rng.pick(closings);
  return rng.chance(0.5) ? `${closing}${rng.pick(closingTails)}` : closing;
}

const foundTexts = [
  '潮退之前，不要相信钟声。',
  '第九级不是最高的一级。',
  '把哨子交给愿意听潮的人。',
  '名单上少的人，才是关键。',
  '若我没有回来，去盐仓看第三堵墙。',
  '不要让他们把信烧掉。',
  '灯亮两次，就是有人来了。',
  '欠港口的，用真名还。',
];

events.push(
  '档案室的窗缝里塞进一片蓝盐', '有人在船坞木架上刻了新的潮位线', '市场尽头的鱼摊整夜没有收冰',
  '钟楼的铜摆被人用细线缠住', '北堤的碑前多了一束干花', '盐仓的门从里面被反锁',
  '戏台的幕布上多了一个手掌印', '港务署的灯亮到后半夜', '一只旧木箱在雾里漂了一夜',
  '有人把一页航海日志钉在公告栏上', '茶馆的常客留下一枚没有年份的硬币', '码头的缆绳被割断又接好',
  '退潮后露出一只生锈的铁盒', '放行单的存根少了一张', '有人在墓园里念了一个不该出现的名字',
  '雨巷的歌声停了半拍', '船坞的狗整夜朝着盐仓叫', '一张港图被重新描过',
  '有人在灯塔下等了三夜', '报馆的铅字少了一枚', '收留所的孩子集体沉默了一天',
  '一封信从门缝塞进来，没有署名', '钟楼的门锁被换成新的', '海面上出现一盏不该有的灯',
  '有人在旧船里点了一根蜡烛', '潮位黑板上多出一行陌生笔迹', '港务署后门的脚印被冲掉了',
  '一只纸鹤停在放行单上', '有人在夜里听见第二声钟', '盐仓的墙皮剥落出一行字',
  '菜市场的秤砣被人动过', '一只空船自己靠了岸', '有个陌生人向三个人打听同一个名字',
  '灯塔的灯芯被换成更短的', '一份旧名单被重新抄写', '有人在雨里站到天亮',
  '船坞的账本被翻到最后一页', '码头的雾笛响了一声就停了', '一只铜哨在抽屉里自己滚了一圈',
  '港口的猫全都躲进了仓房', '有人在北堤烧了一双鞋',
);

turns.push(
  '“你听见了吗？”{pov}问。没有人回答。',
  '{other}把门轻轻带上，屋里立刻暗了一层。',
  '远处有人吹了一声口哨，调子很短，像在确认什么。',
  '那张纸在两人之间停了很久，谁也没有伸手。',
  '“现在不是时候。”{other}说，可谁都知道已经没有别的时候。',
  '潮水忽然漫过一级台阶，把脚印抹掉了。',
  '灯芯烧到最后，只剩一点蓝。',
  '门外传来脚步声，走到一半又折回去。',
  '“你早就知道。”{pov}说。{other}没有否认。',
  '一只湿手按在窗玻璃上，又慢慢滑下去。',
  '风把门吹开，带来一股很淡的焦味。',
  '钟楼的影子移到桌面上，正好压住那行字。',
  '“把它收好。”{other}说，“别让第三个人看见。”',
  '海面亮了一下，像有人在远处点了火。',
  '所有人同时安静下来，连雨声都显得刺耳。',
  '那枚铜哨从口袋里滑出来，滚到桌脚。',
  '“我们只有到退潮之前。”{pov}说。',
  '有人在楼下喊了一个名字，喊错了姓。',
);

closings.push(
  '“天亮之前，别开门。”',
  '那张名单被重新折好，塞回盐仓的墙缝。',
  '港口的灯一盏一盏灭了，只剩灯塔还亮着。',
  '没有人再提那封信，但所有人都记得它放在哪里。',
  '潮声盖住了后半句话。',
  '第二天的报纸上，没有出现那个名字。',
  '“这次，换我来还。”',
  '他把铜哨放进孩子手里，什么也没说。',
  '钟楼的门开了，里面空无一人。',
  '海面恢复平静时，少了一艘船。',
  '“记住潮位，不要记我。”',
  '她/他把灯举高了一点，照见台阶上新的刻痕。',
  '雨停了，港口却比夜里更冷。',
  '那一页纸被风吹进水里，字迹很快散开。',
  '“故事到这里，还没有完。”',
);

genericDialogue.push(
  '你父亲当年也站在这级台阶上。',
  '名单上的人，有一半还活着。',
  '别把钟声当成时间。',
  '盐仓的墙里藏着东西。',
  '你要是今晚走，我就不拦。',
  '谁最先发现尸体，谁就最可疑。',
  '那艘船回来过，只是没人看见。',
  '放行单上的日期，比沉船早一天。',
  '我不信鬼神，我信潮位。',
  '有人把灯芯剪短，是想让灯塔早点灭。',
  '你问的这个人，三年前就死了。',
  '北堤的碑之所以空着，是因为名字被买走了。',
  '报馆的铅字可以换，人的嘴不行。',
  '孩子们知道的不比大人少。',
  '那封信要是寄出去，港口会翻过来。',
  '你听见第二声钟了吗？',
  '码头没有意外，只有没办完的手续。',
  '把账本给我，我替你烧。',
  '你欠我的不是钱。',
  '退潮时别去盐仓，墙会塌。',
  '唱歌的人只是在传话。',
  '我知道谁改了死亡名单。',
  '你要抓的人，今晚会去灯塔。',
  '别让{object}沾水。',
  '{place}的钥匙只有两把。',
  '如果你改变主意，去老戏台找我。',
  '这不是你第一次问，也不会是最后一次。',
  '有人希望你相信那场火是意外。',
  '我只卖鱼，不卖人名。',
  '钟停的那晚，我在场。',
);

function fillLines(template, context) {
  return fill(template, context);
}

function observation(context, rng) {
  if (rng.chance(0.3)) return fill(rng.pick(openings), context);
  return `${rng.pick(times)}，${context.place.name}的${rng.pick(features)}${rng.pick(states)}。`;
}

function actionSentence(context, rng) {
  return `${context.pov.name}${rng.pick(verbs)}${context.object}，${rng.pick(consequences)}。`;
}

function sensorySentence(rng) {
  return `${rng.pick(sensory)}。`;
}

function thoughtSentence(context, rng) {
  return `${rng.pick(thoughts)}。`;
}

function turnSentence(context, rng) {
  return fill(rng.pick(turns), context);
}

function lineFor(speaker, context, rng) {
  const own = speaker.lines.map((line) => line.replace(/^“|”$/g, ''));
  const template = rng.chance(0.6) ? rng.pick(own) : rng.pick(genericDialogue);
  return `${speaker.name}${rng.pick(dialogueVerbs)}：“${fillLines(template, context)}”`;
}

function dialogue(context, rng, turnsCount = 3) {
  const speakers = [context.pov, context.other];
  const lines = [];
  for (let index = 0; index < turnsCount; index += 1) {
    lines.push(lineFor(speakers[index % 2], context, rng));
  }
  return lines.join('\n');
}

function sceneText(type, context, rng) {
  const opening = `${observation(context, rng)}${sensorySentence(rng)}`;
  const event = eventSentence(rng);
  const beat = `${actionSentence(context, rng)}${thoughtSentence(context, rng)}`;
  const closing = closingSentence(rng);
  const turn = turnSentence(context, rng);

  if (type === 'conflict' || type === 'betrayal' || type === 'interrogation') {
    return `${opening}\n\n${event}${beat}\n\n${dialogue(context, rng, 4)}\n\n${turn}\n\n${closing}`;
  }
  if (type === 'discovery' || type === 'letter' || type === 'memory') {
    return `${opening}\n\n${event}${beat}\n\n${context.pov.name}翻开${context.object}，里面夹着一行被水浸开的字：“${rng.pick(foundTexts)}”\n\n${turn}\n\n${closing}`;
  }
  if (type === 'chase' || type === 'storm') {
    return `${opening}\n\n${event}${context.pov.name}沿着${context.place.name}外侧的窄道跑，${context.other.name}在后面喊了一声，声音被风撕碎。${sensorySentence(rng)}\n\n${beat}\n\n${turn}\n\n${closing}`;
  }
  if (type === 'journey') {
    return `${opening}\n\n船离岸时，${context.place.name}的灯还亮着。${event}${actionSentence(context, rng)}\n\n${dialogue(context, rng, 3)}\n\n${turn}\n\n${closing}`;
  }
  if (type === 'reflection') {
    return `${opening}\n\n${context.pov.name}一个人坐了很久。${event}${thoughtSentence(context, rng)}${actionSentence(context, rng)}\n\n${turn}\n\n${closing}`;
  }
  return `${opening}\n\n${event}${beat}\n\n${dialogue(context, rng, 3)}\n\n${turn}\n\n${closing}`;
}

const volumePlans = [
  { title: '潮声之约', goal: '回到暮光港，确认父亲留下的铜哨', motif: '黄铜哨' },
  { title: '灯塔第九级', goal: '读懂台阶上的刻痕与旧航海日志', motif: '第九级台阶上的刻痕' },
  { title: '未寄出的信', goal: '找到写信的人，弄清名单的来历', motif: '未寄出的信' },
  { title: '盐雾下的名字', goal: '在港务署的放行单与死亡名单之间取舍', motif: '半张放行单' },
  { title: '逆潮之夜', goal: '阻止有人在退潮前烧掉盐仓证据', motif: '蓝色盐晶' },
  { title: '归港', goal: '公开真相，决定谁留下、谁离开', motif: '父亲的旧罗盘' },
];

function chapterTitle(rng, volume, _index) {
  const a = rng.pick(['潮声', '灯影', '盐雾', '旧信', '钟停', '船骨', '雨巷', '北堤', '雾笛', '归帆', '暗流', '空阶']);
  const b = rng.pick(['之前', '之后', '不语', '有痕', '未寄', '回声', '缺口', '第七夜', '第九级', '无人', '又起', '将息']);
  const c = rng.pick(['', '（上）', '（下）', '·其一', '·其二', '外一章']);
  return `${a}${b}${c}` || `第${volume}章`;
}

function makeChapter({ rng, volumeIndex, chapterNumber, chapterTitleText, sceneCount, minChars, empty = false }) {
  const volume = volumePlans[volumeIndex % volumePlans.length];
  const lines = [`第${chineseNumber(chapterNumber)}章 ${chapterTitleText}`];
  if (empty) return `${lines.join('\n')}\n`;
  const bodyParts = [];
  let chars = 0;
  let attempts = 0;
  while ((chars < minChars || bodyParts.length < sceneCount) && attempts < 40) {
    attempts += 1;
    const type = sceneTypes[(chapterNumber + attempts * 3 + volumeIndex) % sceneTypes.length];
    const pov = characters[(chapterNumber + attempts + volumeIndex) % characters.length];
    const other = characters[(chapterNumber + attempts * 2 + 3 + volumeIndex) % characters.length];
    const context = {
      pov,
      other: other.name === pov.name ? characters[(characters.indexOf(other) + 1) % characters.length] : other,
      place: locations[(chapterNumber + attempts + volumeIndex * 2) % locations.length],
      weather: rng.pick(weathers),
      object: rng.chance(0.55) ? volume.motif : rng.pick(objects),
    };
    const text = sceneText(type, context, rng);
    bodyParts.push(text);
    chars += text.length;
  }
  return `${lines.join('\n')}\n\n${bodyParts.join('\n\n◇\n\n')}\n`;
}

function buildNovel({ rng, volumes, chaptersPerVolume, minChars, sceneCount, profile }) {
  const parts = [];
  for (let volumeIndex = 0; volumeIndex < volumes; volumeIndex += 1) {
    parts.push(`第${chineseNumber(volumeIndex + 1)}卷 ${volumePlans[volumeIndex % volumePlans.length].title}\n`);
    for (let local = 1; local <= chaptersPerVolume; local += 1) {
      let title = chapterTitle(rng, volumeIndex, local);
      let empty = false;
      if (profile === 'complex' && volumeIndex === 1 && local === 4) { title = '空阶'; empty = true; }
      if (profile === 'complex' && volumeIndex === 2 && local === 2) title = '潮声之前';
      if (profile === 'complex' && volumeIndex === 2 && local === 3) title = '潮声之前';
      if (profile === 'complex' && volumeIndex === 3 && local === 1) title = '灯';
      if (profile === 'complex' && volumeIndex === 3 && local === 2) title = '一'.repeat(0) + '长'.repeat(200);
      const body = makeChapter({ rng, volumeIndex, chapterNumber: local, chapterTitleText: title, sceneCount, minChars, empty });
      parts.push(body);
      if (profile === 'complex' && volumeIndex === 1 && local === 5) {
        parts.push(makeExtremeChapter(rng, volumeIndex + 1, 25_000));
      }
    }
  }
  return parts.join('\n');
}

function makeExtremeChapter(rng, chapterNumber, minChars) {
  const volume = volumePlans[0];
  const lines = [`第${chineseNumber(chapterNumber)}章 长夜`];
  const parts = [];
  let chars = 0;
  let attempts = 0;
  while (chars < minChars && attempts < 300) {
    attempts += 1;
    const pov = characters[(attempts * 2) % characters.length];
    const other = characters[(attempts * 3 + 1) % characters.length];
    const text = sceneText('reflection', {
      pov,
      other: other.name === pov.name ? characters[0] : other,
      place: locations[attempts % locations.length],
      weather: rng.pick(weathers),
      object: volume.motif,
    }, rng);
    parts.push(text);
    chars += text.length;
  }
  return `${lines.join('\n')}\n\n${parts.join('\n\n')}\n`;
}

function buildSmall(rng) {
  const parts = [`第一卷 ${volumePlans[0].title}\n`];
  for (let index = 1; index <= 3; index += 1) {
    parts.push(makeChapter({
      rng,
      volumeIndex: 0,
      chapterNumber: index,
      chapterTitleText: ['潮声', '第九级', '未寄出的信'][index - 1],
      sceneCount: 2,
      minChars: 900,
    }));
  }
  return parts.join('\n');
}

function buildExtreme(rng) {
  const parts = [];
  parts.push(`第一卷 极短与极长\n`);
  parts.push(makeChapter({ rng, volumeIndex: 0, chapterNumber: 1, chapterTitleText: '灯', sceneCount: 1, minChars: 120 }));
  parts.push(makeChapter({ rng, volumeIndex: 0, chapterNumber: 2, chapterTitleText: '长'.repeat(200), sceneCount: 1, minChars: 400 }));
  parts.push(makeExtremeChapter(rng, 3, 25_000));
  const longParagraph = Array.from({ length: 42 }, () => sceneText('reflection', {
    pov: characters[rng.int(0, characters.length - 1)],
    other: characters[rng.int(0, characters.length - 1)],
    place: locations[rng.int(0, locations.length - 1)],
    weather: rng.pick(weathers),
    object: rng.pick(objects),
  }, rng)).join('');
  parts.push(`第三章 单段\n\n${longParagraph}\n`);
  parts.push(`第四章 空章\n`);
  parts.push(`第五章 潮声之前\n\n${sceneText('discovery', {
    pov: characters[0], other: characters[1], place: locations[1], weather: weathers[0], object: objects[0],
  }, rng)}\n`);
  parts.push(`第六章 潮声之前\n\n${sceneText('conflict', {
    pov: characters[2], other: characters[3], place: locations[2], weather: weathers[1], object: objects[1],
  }, rng)}\n`);
  return parts.join('\n');
}

function buildLong(rng) {
  return buildNovel({ rng, volumes: 6, chaptersPerVolume: 50, minChars: 1500, sceneCount: 2, profile: 'long' });
}

function buildComplex(rng) {
  return buildNovel({ rng, volumes: 5, chaptersPerVolume: 8, minChars: 1100, sceneCount: 2, profile: 'complex' });
}

function countChapters(text) {
  return (text.match(/^第[0-9〇零一二三四五六七八九十百千万两]+章/gm) ?? []).length;
}

function countVolumes(text) {
  return (text.match(/^第[0-9〇零一二三四五六七八九十百千万两]+卷/gm) ?? []).length;
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function decodeForMetrics(file) {
  try {
    if (file.encoding === 'utf-8') return file.bytes.toString('utf8');
    if (file.encoding === 'utf-8-bom') return file.bytes.subarray(3).toString('utf8');
    if (file.encoding === 'gb18030') return iconv.decode(file.bytes, 'gb18030');
    if (file.encoding === 'utf-16le') return file.bytes.subarray(2).toString('utf16le');
    if (file.encoding === 'utf-16be') {
      const swapped = Buffer.from(file.bytes.subarray(2));
      swapped.swap16();
      return swapped.toString('utf16le');
    }
    return null;
  } catch {
    return null;
  }
}

function normalizeNewlines(text) {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function detectLineEndingOf(text) {
  if (!text) return 'none';
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const lf = (text.match(/\n/g) ?? []).length - crlf;
  const cr = (text.match(/\r/g) ?? []).length - crlf;
  const kinds = [crlf > 0, lf > 0, cr > 0].filter(Boolean).length;
  if (kinds > 1) return 'mixed';
  if (crlf > 0) return 'crlf';
  if (lf > 0) return 'lf';
  return 'none';
}

function writeProfile(outDir, profileName, files) {
  const profileDir = path.join(outDir, profileName);
  fs.mkdirSync(profileDir, { recursive: true });
  const entries = [];
  for (const file of files) {
    const target = path.join(profileDir, file.name);
    fs.writeFileSync(target, file.bytes);
    const decoded = decodeForMetrics(file);
    const normalized = decoded === null ? null : normalizeNewlines(decoded);
    const lineEnding = decoded === null ? (file.lineEnding ?? 'none') : detectLineEndingOf(decoded);
    const chapters = file.chapters ?? (normalized ? countChapters(normalized) : null);
    const volumes = file.volumes ?? (normalized ? countVolumes(normalized) : null);
    entries.push({
      path: `${profileName}/${file.name}`,
      encoding: file.encoding,
      line_ending: lineEnding,
      raw_bytes: file.bytes.length,
      bytes: file.bytes.length,
      sha256: sha256(file.bytes),
      decoded_chars: decoded === null ? null : [...decoded].length,
      normalized_text_chars: normalized === null ? null : [...normalized].length,
      // `chars` is the encoding/line-ending independent text measure.
      chars: normalized === null ? null : [...normalized].length,
      chapter_count: chapters,
      volume_count: volumes,
      chapters,
      volumes,
      note: file.note ?? null,
    });
  }
  return entries;
}

function parseArgs(argv) {
  const options = { out: path.resolve('corpus/generated'), seed: DEFAULT_SEED, profile: 'all' };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--out') options.out = path.resolve(argv[++index]);
    else if (token === '--seed') options.seed = Number(argv[++index]);
    else if (token === '--profile') options.profile = argv[++index];
    else { console.error(`unknown argument: ${token}`); process.exit(2); }
  }
  return options;
}

const options = parseArgs(process.argv.slice(2));
const rng = createRng(options.seed);
fs.mkdirSync(options.out, { recursive: true });

const smallText = buildSmall(rng);
const complexText = buildComplex(rng);
const longText = buildLong(rng);
const extremeText = buildExtreme(rng);

const smallFiles = [
  { name: 'small-novel.md', bytes: Buffer.from(smallText, 'utf8'), encoding: 'utf-8', lineEnding: 'lf' },
];
const complexFiles = [
  { name: 'complex-volumes.md', bytes: Buffer.from(complexText, 'utf8'), encoding: 'utf-8', lineEnding: 'lf' },
];
const longFiles = [
  { name: 'long-novel.md', bytes: Buffer.from(longText, 'utf8'), encoding: 'utf-8', lineEnding: 'lf' },
];
const extremeFiles = [
  { name: 'extreme.md', bytes: Buffer.from(extremeText, 'utf8'), encoding: 'utf-8', lineEnding: 'lf' },
];
const encodingFiles = [
  { name: 'small-utf8-lf.md', bytes: Buffer.from(smallText, 'utf8'), encoding: 'utf-8', lineEnding: 'lf' },
  { name: 'small-utf8-bom-crlf.md', bytes: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(smallText.replaceAll('\n', '\r\n'), 'utf8')]), encoding: 'utf-8-bom', lineEnding: 'crlf' },
  { name: 'small-gb18030.txt', bytes: iconv.encode(smallText, 'gb18030'), encoding: 'gb18030', lineEnding: 'lf' },
  { name: 'small-utf16le.txt', bytes: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(smallText, 'utf16le')]), encoding: 'utf-16le', lineEnding: 'lf' },
  { name: 'small-utf16be-crlf.txt', bytes: (() => { const body = Buffer.from(smallText.replaceAll('\n', '\r\n'), 'utf16le'); body.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), body]); })(), encoding: 'utf-16be', lineEnding: 'crlf' },
];
const malformedFiles = [
  { name: 'invalid-utf8.bin', bytes: Buffer.from([0x80, 0x81, 0xff, 0xfe, 0x00, 0x41]), encoding: 'invalid', note: 'not a valid UTF-8 or GB18030 stream' },
  { name: 'nul-bytes.txt', bytes: Buffer.from('第一章 空\n正文\u0000里夹着空字节。\n', 'utf8'), encoding: 'utf-8', note: 'contains NUL' },
  { name: 'empty.txt', bytes: Buffer.alloc(0), encoding: 'utf-8', note: 'zero-byte file' },
  { name: 'mixed-endings.md', bytes: Buffer.from('第一章 混合\n第一行\n第二行\r\n第三行\r第四行\n', 'utf8'), encoding: 'utf-8', lineEnding: 'mixed', note: 'LF/CRLF/CR mixed' },
  { name: 'truncated-heading.md', bytes: Buffer.from('第一章 开头\n正文。\n第二卷', 'utf8'), encoding: 'utf-8', note: 'volume heading at EOF' },
  { name: 'huge-line.txt', bytes: Buffer.from(`${'潮'.repeat(200_000)}`, 'utf8'), encoding: 'utf-8', note: 'one 200k-character line, no newline' },
];

const profiles = {};
if (options.profile === 'all' || options.profile === 'small') profiles.small = writeProfile(options.out, 'small', smallFiles);
if (options.profile === 'all' || options.profile === 'complex') profiles.complex = writeProfile(options.out, 'complex', complexFiles);
if (options.profile === 'all' || options.profile === 'long') profiles.long = writeProfile(options.out, 'long', longFiles);
if (options.profile === 'all' || options.profile === 'encodings') profiles.encodings = writeProfile(options.out, 'encodings', encodingFiles);
if (options.profile === 'all' || options.profile === 'malformed') profiles.malformed = writeProfile(options.out, 'malformed', malformedFiles);
if (options.profile === 'all' || options.profile === 'extreme') profiles.extreme = writeProfile(options.out, 'extreme', extremeFiles);

const longEntry = (profiles.long ?? []).find((entry) => entry.path.endsWith('long-novel.md'));
const manifest = {
  schema_version: 1,
  generator: 'narrative-studio-synthetic-corpus',
  generator_version: TOOL_VERSION,
  generated_at: FIXED_TIME,
  seed: options.seed,
  profiles,
  coverage: {
    small_work: Boolean(profiles.small),
    complex_volumes: Boolean(profiles.complex),
    long_450k: Boolean(longEntry && (longEntry.chars ?? 0) >= 450_000),
    encodings: (profiles.encodings ?? []).map((entry) => entry.encoding),
    chapter_order: Boolean(profiles.complex),
    extreme_lengths: Boolean(profiles.extreme),
    duplicate_titles: Boolean(profiles.complex),
    empty_chapters: Boolean(profiles.complex),
    malformed_files: (profiles.malformed ?? []).map((entry) => entry.path),
  },
  note: 'Original synthetic Chinese prose generated from a deterministic story world. Not a real novel, not authorization to reproduce any existing work. Private manuscripts must never be added to this corpus.',
};
fs.writeFileSync(path.join(options.out, 'corpus-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(JSON.stringify({
  out: options.out,
  seed: options.seed,
  profiles: Object.fromEntries(Object.entries(profiles).map(([key, value]) => [key, value.length])),
  long_chars: longEntry?.chars ?? null,
  coverage: manifest.coverage,
}, null, 2));
