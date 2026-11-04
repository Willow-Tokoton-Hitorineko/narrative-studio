export const atelierQuotes = [
  '把灯留给下一页。',
  '没想好结局也可以先写。',
  '一句好对白，常常留着半句没说。',
  '今天的纸页可以薄一点。',
] as const;

export function createQuoteCycle(random: () => number = Math.random): () => string {
  let queue: string[] = [];
  let previous: string | undefined;
  return () => {
    if (queue.length === 0) {
      queue = [...atelierQuotes];
      for (let i = queue.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [queue[i], queue[j]] = [queue[j]!, queue[i]!];
      }
      if (queue.at(-1) === previous) {
        [queue[0], queue[queue.length - 1]] = [queue.at(-1)!, queue[0]!];
      }
    }
    previous = queue.pop()!;
    return previous;
  };
}

export const nextAtelierQuote = createQuoteCycle();