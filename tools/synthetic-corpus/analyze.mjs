#!/usr/bin/env node
/**
 * Quality/structure metrics for a generated synthetic novel.
 * Used by tests to prove the long corpus is not padded with one repeated block.
 */
import fs from 'node:fs';

const DIALOGUE_MARKS = ['\u201c', '\u300c', '\u300e']; // “ 「 『
const SENTENCE_SPLIT = /[。！？\n]/;

export function analyzeText(text, characterNames = []) {
  const chars = [...text];
  const grams = new Map();
  for (let index = 0; index + 20 <= chars.length; index += 1) {
    const gram = chars.slice(index, index + 20).join('');
    grams.set(gram, (grams.get(gram) ?? 0) + 1);
  }
  const totalGrams = Math.max(0, chars.length - 19);
  const uniqueGrams = grams.size;
  const sentences = text
    .split(SENTENCE_SPLIT)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 5);
  const distinctSentences = new Set(sentences).size;
  const dialogue = DIALOGUE_MARKS.reduce(
    (count, mark) => count + (text.split(mark).length - 1),
    0,
  );
  const renamed = characterNames.filter((name) => text.includes(name)).length;
  const maxRepeatedGram = [...grams.values()].reduce((max, value) => Math.max(max, value), 0);
  return {
    chars: chars.length,
    unique20: uniqueGrams,
    total20: totalGrams,
    unique20Ratio: totalGrams === 0 ? 0 : Number((uniqueGrams / totalGrams).toFixed(4)),
    sentences: sentences.length,
    distinctSentences,
    distinctSentenceRatio: sentences.length === 0 ? 0 : Number((distinctSentences / sentences.length).toFixed(4)),
    dialogue,
    characterNames: renamed,
    maxRepeated20gram: maxRepeatedGram,
  };
}

if (process.argv[1]?.replace(/\\/g, '/').endsWith('/tools/synthetic-corpus/analyze.mjs')) {
  const file = process.argv[2];
  if (!file) {
    console.error('usage: node analyze.mjs <novel.md> [character names...]');
    process.exit(2);
  }
  const text = fs.readFileSync(file, 'utf8');
  const names = process.argv.slice(3);
  console.log(JSON.stringify(analyzeText(text, names), null, 2));
}
