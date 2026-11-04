import { describe, expect, it } from 'vitest';
import { aiStatus, generateContinuation, generateOutline } from '../../apps/cli/src/ai.js';

describe('Gate 7 DeepSeek adapter boundary', () => {
  it('reports configuration without ever exposing the key', () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    const status = aiStatus();
    expect(status.configured).toBe(false);
    expect(JSON.stringify(status)).not.toContain('sk-');
    if (previous) process.env.DEEPSEEK_API_KEY = previous;
  });

  it('requires explicit consent before a real call and does not fall back to fixture', async () => {
    const previous = process.env.DEEPSEEK_API_KEY;
    delete process.env.DEEPSEEK_API_KEY;
    await expect(generateOutline({ idea: '原创灵感', genre: '悬疑', volumes: 1, chaptersPerVolume: 1, consent: false, mock: false })).rejects.toThrow(/AI_CONSENT_REQUIRED/);
    await expect(generateOutline({ idea: '原创灵感', genre: '悬疑', volumes: 1, chaptersPerVolume: 1, consent: true, mock: false })).rejects.toThrow(/MODEL_NOT_CONFIGURED/);
    await expect(generateContinuation({ compiledPrompt: 'ctx', instruction: '续写', consent: false, mock: false })).rejects.toThrow(/AI_CONSENT_REQUIRED/);
    if (previous) process.env.DEEPSEEK_API_KEY = previous;
  });

  it('produces a mock outline/continuation only under explicit mock flag', async () => {
    const outline = await generateOutline({ idea: '潮汐档案', genre: '悬疑', volumes: 2, chaptersPerVolume: 3, consent: false, mock: true });
    expect(outline.source).toBe('mock');
    expect(outline.outline.volumes).toHaveLength(2);
    expect(outline.outline.volumes[0]!.chapters).toHaveLength(3);
    const continuation = await generateContinuation({ compiledPrompt: 'ctx', instruction: '续写', consent: false, mock: true });
    expect(continuation.source).toBe('mock');
    expect(continuation.text.length).toBeGreaterThan(20);
  });
});
