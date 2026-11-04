/** A bounded context centred on the actual writing position, never the book by default. */
export function writingContext(text: string, position = text.length, beforeLimit=3600): string {
  const end = Number.isSafeInteger(position) ? Math.max(0, Math.min(position, text.length)) : text.length;
  const before = text.slice(Math.max(0, end - beforeLimit), end);
  const after = text.slice(end, Math.min(text.length, end + 900));
  return `写作位置前文：\n${before}\n${after ? `写作位置后文（仅用于衔接，不得重复输出）：\n${after}` : '当前位置为章末。'}`;
}
