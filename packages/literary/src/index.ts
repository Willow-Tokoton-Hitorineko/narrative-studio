import fs from 'node:fs';
import path from 'node:path';
import { contentDigest } from '@narrative-studio/contracts';
import { resolveAppDataRoot } from '@narrative-studio/core';

export type CandidateSource = 'fixture' | 'manual_import' | 'local_model';
export type ModelStatus = 'DISABLED' | 'AVAILABLE_NOT_AUTHORIZED' | 'AUTHORIZED_LOCAL' | 'RUNNING' | 'FAILED' | 'UNAVAILABLE';
export interface ProviderStatus { status: ModelStatus; model_id: string | null; reason: string; network: 'disabled'; authorized: boolean; }
export interface LiteraryCandidate { candidate_id: string; source: CandidateSource; text: string; output_hash: string; task_id: string; provenance: Record<string, unknown>; created_at: string; }
export interface BlindPair { pair_id: string; task_id: string; a: LiteraryCandidate; b: LiteraryCandidate; mapping: { a: 'B0' | 'B1'; b: 'B0' | 'B1' }; order_randomized: boolean; }
export interface ReviewRecord { pair_id: string; choice: 'A' | 'B' | 'tie' | 'neither'; scores: Record<string, number>; note: string; created_at: string; }

function dataDir(appDataRoot: string): string { const dir = path.join(resolveAppDataRoot(appDataRoot), 'literary'); fs.mkdirSync(dir, { recursive: true }); return dir; }
function readJson<T>(file: string, fallback: T): T { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) as T : fallback; }
function writeJson(file: string, value: unknown): void { fs.writeFileSync(file, JSON.stringify(value, null, 2), 'utf8'); }

export function providerStatus(): ProviderStatus {
  return { status: 'DISABLED', model_id: null, reason: 'LOCAL_MODEL_NOT_AUTHORIZED: no model download, cloud API or inference is authorized', network: 'disabled', authorized: false };
}

export function createFixtureCandidate(options: { taskId: string; text: string; contextHash: string }): LiteraryCandidate {
  if (!options.text.trim()) throw new Error('EMPTY_CANDIDATE');
  return { candidate_id: `cand_${contentDigest(Buffer.from(`${options.taskId}:${options.text}:${Date.now()}`, 'utf8')).slice(7, 27)}`, source: 'fixture', text: options.text, output_hash: contentDigest(Buffer.from(options.text, 'utf8')), task_id: options.taskId, provenance: { source: 'fixture', context_hash: options.contextHash, provider: 'offline-fixture', external_send: false }, created_at: new Date().toISOString() };
}
export function importManualCandidate(options: { taskId: string; text: string; contextHash: string }): LiteraryCandidate {
  if (!options.text.trim()) throw new Error('EMPTY_CANDIDATE');
  return { candidate_id: `cand_${contentDigest(Buffer.from(`${options.taskId}:${options.text}:${Date.now()}`, 'utf8')).slice(7, 27)}`, source: 'manual_import', text: options.text, output_hash: contentDigest(Buffer.from(options.text, 'utf8')), task_id: options.taskId, provenance: { source: 'manual_import', context_hash: options.contextHash, external_send: false, verified_model: false }, created_at: new Date().toISOString() };
}
export function requestLocalModel(): never { throw new Error('MODEL_RUN=BLOCKED: no authorized local model'); }

export function createBlindPair(options: { taskId: string; b0: LiteraryCandidate; b1: LiteraryCandidate }): BlindPair {
  if (options.b0.source === 'local_model' || options.b1.source === 'local_model') throw new Error('MODEL_SOURCE_NOT_AUTHORIZED');
  const flip = Number.parseInt(contentDigest(Buffer.from(options.taskId, 'utf8')).slice(7, 9), 16) % 2 === 1;
  const a = flip ? options.b1 : options.b0;
  const b = flip ? options.b0 : options.b1;
  return { pair_id: `pair_${contentDigest(Buffer.from(`${options.taskId}:${options.b0.output_hash}:${options.b1.output_hash}`, 'utf8')).slice(7, 27)}`, task_id: options.taskId, a, b, mapping: { a: flip ? 'B1' : 'B0', b: flip ? 'B0' : 'B1' }, order_randomized: flip };
}

export function savePair(appDataRoot: string, pair: BlindPair): void { writeJson(path.join(dataDir(appDataRoot), `${pair.pair_id}.json`), pair); }
export function loadPair(appDataRoot: string, pairId: string): BlindPair | null { const p = path.join(dataDir(appDataRoot), `${pairId}.json`); return fs.existsSync(p) ? readJson<BlindPair>(p, null as never) : null; }

export function submitReview(appDataRoot: string, review: ReviewRecord): void {
  if (!['A', 'B', 'tie', 'neither'].includes(review.choice)) throw new Error('INVALID_CHOICE');
  const file = path.join(dataDir(appDataRoot), 'reviews.json');
  const rows = readJson<ReviewRecord[]>(file, []);
  writeJson(file, [...rows, review]);
}
export function experimentSummary(appDataRoot: string): { pairs: number; reviews: number; b0_wins: number; b1_wins: number; ties: number; neither: number; status: string } {
  const reviews = readJson<ReviewRecord[]>(path.join(dataDir(appDataRoot), 'reviews.json'), []);
  const pairs = fs.readdirSync(dataDir(appDataRoot)).filter((f) => f.startsWith('pair_') && f.endsWith('.json'));
  let b0 = 0; let b1 = 0; let tie = 0; let neither = 0;
  for (const review of reviews) {
    const pair = loadPair(appDataRoot, review.pair_id);
    if (!pair) continue;
    const winner = review.choice === 'A' ? pair.mapping.a : review.choice === 'B' ? pair.mapping.b : review.choice;
    if (winner === 'B0') b0++; else if (winner === 'B1') b1++; else if (winner === 'tie') tie++; else neither++;
  }
  return { pairs: pairs.length, reviews: reviews.length, b0_wins: b0, b1_wins: b1, ties: tie, neither, status: 'G7_LITERARY_RESULT=NOT_MEASURED (no authorized model + human blind study)' };
}
export function clearEvidence(appDataRoot: string): void { fs.rmSync(path.join(dataDir(appDataRoot), 'reviews.json'), { force: true }); for (const f of fs.readdirSync(dataDir(appDataRoot))) if (f.startsWith('pair_')) fs.rmSync(path.join(dataDir(appDataRoot), f), { force: true }); }
