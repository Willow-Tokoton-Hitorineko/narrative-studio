/** Bounded, explainable prose checks. Findings are suggestions, never quality scores. */
export function reviewChineseProse(text: string): Array<{
    dimension: 'voice' | 'rhythm';
    severity: 'warning' | 'insufficient';
    reason: string;
    automatic: boolean;
}> {
    const findings: Array<{
        dimension: 'voice' | 'rhythm';
        severity: 'warning' | 'insufficient';
        reason: string;
        automatic: boolean;
    }> = [];
    const templates = ['命运的齿轮', '故事才刚刚开始', '一切都将不再一样', '嘴角勾起一抹', '眼底闪过一丝', '空气仿佛凝固'];
    const hits = templates.filter(t => text.includes(t));
    if (hits.length)
        findings.push({ dimension: 'voice', severity: 'warning', reason: `可能的惯用表达：${hits.join('、')}。结合作者意图判断是否需要换成具体动作。`, automatic: true });
    const phrases = text.match(/仿佛|似乎|不禁/g)?.length ?? 0;
    if (phrases > 3)
        findings.push({ dimension: 'voice', severity: 'warning', reason: `“仿佛/似乎/不禁”出现 ${phrases} 次，建议检查是否有意重复。`, automatic: true });
    const paragraphs = text.split(/\n+/).map(p => p.trim()).filter(p => p.length > 15);
    const repeated = paragraphs.some((p, i) => paragraphs.indexOf(p) < i);
    const sentences = text.split(/[。！？]/).map(p => p.trim()).filter(p => p.length > 12);
    if (repeated || sentences.some((p, i) => sentences.indexOf(p) < i))
        findings.push({ dimension: 'rhythm', severity: 'warning', reason: '发现逐字重复的长句/段落；请区分有意复沓与重复生成。', automatic: true });
    if (!findings.length)
        findings.push({ dimension: 'voice', severity: 'insufficient', reason: '未命中本地模板表达与逐字重复规则；不代表文学质量或完整文风审查通过。', automatic: true });
    return findings;
}

/** Offline demonstration of an explicit refinement request, not a model quality claim. */
export function refineMockProse(text:string):string{
 const seen=new Set<string>();
 const refined=text.split(/(?<=[。！？])|\n+/).filter(sentence=>{const key=sentence.trim();if(!key)return false;if(seen.has(key))return false;seen.add(key);return true;}).join('');
 return refined===text?text.replace(/命运的齿轮开始转动[。！]?/g,'').replace(/故事才刚刚开始[。！]?/g,''):refined;
}
