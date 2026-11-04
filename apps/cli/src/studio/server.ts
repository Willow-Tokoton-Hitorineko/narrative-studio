import { readFramework, discussFramework, draftFramework, saveFramework, confirmFrameworkRelations } from '../framework.js';
import { readSession, saveSession, clearSession, discussCoWriting, generateCoCandidate, applyCoCandidate, undoCoCandidate } from '../cowriting.js';
/**
 * Local-only Gate 1 studio service.
 *
 * Security posture (V4.4): bind 127.0.0.1, random per-process token, HttpOnly
 * SameSite=Strict cookie, Origin + custom-header checks on mutations, path
 * containment for static files, CSP/no-sniff/no-frame. No cloud calls and no
 * model provider is present.
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import {
  initProject,
  commitChapter,
  createChapter,
  listRevisions,
  openProject,
  projectStatus,
  readChapterBytes,
  readManifest,
  readNarrativeCanon,
  readRevision,
  revisionRelPaths,
  resolveInside,
  writeNarrativeCanon,
  type OpenedProject,
} from '@narrative-studio/core';
import { readProjectionStatus, rebuildProjection } from '@narrative-studio/projection';
import { chapterEvidence, checkCandidateForAuthor, createEvidenceAnchor, indexNarrative, readNarrativeOverview, searchNarrative } from '@narrative-studio/narrative';
import { addBranch, addIdea, addPlan, readPlanning, selectBranch, setGenres } from '@narrative-studio/planning';
import { aiStatus, generateContinuation, generateOutline } from '../ai.js';
import { createBlindPair, createFixtureCandidate, experimentSummary, providerStatus, savePair, submitReview, clearEvidence } from '@narrative-studio/literary';
import { compileContinuation, createCandidate, decideCandidate, exportCandidate, fixtureCandidateText, listCandidates } from '@narrative-studio/continuation';
import { activatePolicy, addExerciseAttempt, addGoal, addReflection, freezePolicy, readCoevolutionOverview, rebuildCoevolutionProjection, recordFeedback, revokeObservation, revokePolicy, rollbackPolicy, setConsent } from '@narrative-studio/coevolution';
import { acceptedPreview, assertProposalCurrent, loadProposal, compileEditorialJob, fixtureCandidate, futureSecretValuesFor, saveProposal, setHunkDecision, validateEditProposal } from '@narrative-studio/editorial';
import { analyzeVoice, approveVoiceProposal, compareVoiceSamples, deleteVoiceSource, readVoiceOverview, registerVoiceSource, revokeStyleRule, revokeVoiceSource, rollbackStyleRule } from '@narrative-studio/voice';
import {
  NarrativeStudioError,
  newNarrativeId,
  type ManifestChapterEntry,
  type Revision,
} from '@narrative-studio/contracts';
import type { SanitizedLogger } from '@narrative-studio/core';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

export interface StudioServerOptions {
  vaultDir: string;
  libraryRoot?: string;
  projectId?: string | null;
  appDataRoot?: string | null;
  port?: number;
  host?: string;
  logger?: SanitizedLogger | null;
  distDir?: string | null;
}

export interface StudioServer {
  url: string;
  port: number;
  token: string;
  projectId: string;
  close: () => Promise<void>;
}

interface ApiError {
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function errorStatus(error: NarrativeStudioError): number {
  switch (error.code) {
    case 'CAS_MISMATCH':
      return 409;
    case 'WRITER_LOCKED':
      return 423;
    case 'UNAUTHORIZED':
      return 403;
    case 'NOT_FOUND':
      return 404;
    case 'INVALID_ARGUMENT':
    case 'CONTRACT_VIOLATION':
      return 400;
    default:
      return 500;
  }
}

function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    const key = part.slice(0, index).trim();
    const value = part.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }
  return cookies;
}

function readBody(req: http.IncomingMessage, limit = 12 * 1024 * 1024): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        reject(new NarrativeStudioError('INVALID_ARGUMENT', 'Request body is too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve(text.length === 0 ? {} : JSON.parse(text));
      } catch {
        reject(new NarrativeStudioError('INVALID_ARGUMENT', 'Request body is not valid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function asString(value: unknown, label: string, max = 8 * 1024 * 1024): string {
  if (typeof value !== 'string') {
    throw new NarrativeStudioError('INVALID_ARGUMENT', `${label} must be a string`);
  }
  if (value.length > max) {
    throw new NarrativeStudioError('INVALID_ARGUMENT', `${label} is too large`);
  }
  return value;
}

function chapterSummary(entry: ManifestChapterEntry) {
  return {
    chapter_id: entry.chapter_id,
    title: entry.title,
    volume_id: entry.volume_id,
    ordinal: entry.ordinal,
    word_count: entry.word_count,
    current_revision_id: entry.current_revision_id,
    content_hash: entry.content_hash,
    updated_at: entry.updated_at,
  };
}

function revisionSummary(revision: Revision) {
  return {
    revision_id: revision.revision_id,
    seq: revision.seq,
    parent_revision_id: revision.parent_revision_id,
    content_hash: revision.content_hash,
    byte_length: revision.byte_length,
    encoding: revision.encoding,
    line_ending: revision.line_ending,
    created_at: revision.created_at,
    origin: revision.origin,
    message: revision.message,
    approval_id: revision.approval_id,
  };
}

function readRevisionText(project: OpenedProject, chapterId: string, revisionId: string): {
  revision: Revision;
  text: string;
} {
  const revision = readRevision(project.projectDir, chapterId, revisionId);
  const paths = revisionRelPaths(chapterId, revisionId);
  const bytes = fs.readFileSync(resolveInside(project.projectDir, paths.body, 'revision body'));
  return { revision, text: bytes.toString('utf8') };
}

function preserveLineEndings(content: string, lineEnding: Revision['line_ending']): string {
  if (lineEnding === 'crlf') return content.replace(/\r?\n/g, '\r\n');
  if (lineEnding === 'lf') return content.replace(/\r\n?/g, '\n');
  return content;
}

export async function startStudioServer(options: StudioServerOptions): Promise<StudioServer> {
  const vaultDir = path.resolve(options.vaultDir);
  const appDataRoot = options.appDataRoot ?? null;
  const host = options.host ?? '127.0.0.1';
  const token = randomBytes(24).toString('base64url');
  const distDir = path.resolve(
    options.distDir ??
      process.env.NS_STUDIO_DIST ??
      path.join(process.cwd(), 'apps', 'studio', 'dist'),
  );
  if (!fs.existsSync(path.join(distDir, 'index.html'))) {
    throw new NarrativeStudioError('INVALID_ARGUMENT', `Studio build not found at ${distDir}. Run pnpm studio:build.`);
  }

  const current = openProject(vaultDir, options.projectId ?? undefined);
  const projectId = current.project.project_id;
  let actualPort = options.port ?? 0;

  const requireAuth = (req: http.IncomingMessage): boolean => {
    const cookies = parseCookies(req.headers.cookie);
    if (cookies.ns_studio === token) return true;
    return req.headers['x-ns-studio-token'] === token;
  };

  const guardMutation = (req: http.IncomingMessage): void => {
    const origin = req.headers.origin;
    const expected = `http://${host}:${actualPort}`;
    if (origin !== expected) {
      throw new NarrativeStudioError('UNAUTHORIZED', 'Origin check failed for a mutating request');
    }
    if (req.headers['x-ns-request'] !== 'studio') {
      throw new NarrativeStudioError('UNAUTHORIZED', 'Missing studio request header');
    }
  };

  const refreshProjection = (): Record<string, unknown> => {
    try {
      const built = rebuildProjection({ vaultDir, projectId, appDataRoot, logger: options.logger ?? null });
      return { status: 'current', digest: built.projection_digest };
    } catch (error) {
      return { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
  };

  const refreshNarrative = (chapterId?: string | null): Record<string, unknown> => {
    try {
      const built = indexNarrative({
        vaultDir,
        projectId,
        appDataRoot,
        chapters: chapterId ? [chapterId] : undefined,
      });
      return {
        status: built.status,
        source_revision: built.source_revision,
        indexed_chapters: built.indexed_chapters,
        stale_evidence: built.stale_evidence,
        duration_ms: built.duration_ms,
      };
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
  };
  const coOptions = {vaultDir,projectId,appDataRoot:appDataRoot!};
  const coRequests = new Map<string,AbortController>();
  const coProgress=new Map<string,string>();
  const bookServers:StudioServer[]=[];
  const libraryRoot=options.libraryRoot??path.join(path.dirname(path.resolve(appDataRoot!)),'CoWriting Books');
  const bootstrap = () => {
    const opened = openProject(vaultDir, projectId);
    const status = projectStatus({ vaultDir, projectId });
    let projection: Record<string, unknown> = { status: 'unknown' };
    try {
      projection = { ...readProjectionStatus({ vaultDir, projectId, appDataRoot }) };
    } catch (error) {
      projection = { status: 'failed', error: error instanceof Error ? error.message : String(error) };
    }
    const chapters = Object.values(opened.manifest.chapters)
      .sort((left, right) =>
        left.volume_id === right.volume_id
          ? left.ordinal - right.ordinal
          : left.volume_id.localeCompare(right.volume_id),
      )
      .map(chapterSummary);
    return {
      project: {
        project_id: opened.project.project_id,
        title: opened.project.title,
        language: opened.project.language,
        default_volume_id: opened.project.default_volume_id,
      },
      manifest: { revision: opened.manifest.revision, seq: opened.manifest.seq, updated_at: opened.manifest.updated_at },
      status: {
        vault_root: opened.vaultRoot,
        project_dir: opened.projectDir,
        total_word_count: status.total_word_count,
        chapter_count: status.chapter_count,
        lock: status.lock,
        pending_transactions: status.pending_transactions.length,
      },
      projection,
      chapters,
    };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', `http://${host}`);
    const sendError = (error: unknown): void => {
      const narrative = error instanceof NarrativeStudioError ? error : null;
      const status = narrative ? errorStatus(narrative) : 500;
      const payload: ApiError = {
        code: narrative?.code ?? 'INTERNAL',
        message: error instanceof Error ? error.message : String(error),
        details: narrative?.details,
      };
      json(res, status, { ok: false, error: payload });
    };

    void (async () => {
      try {
        if (url.pathname === '/' || url.pathname === '/studio' || url.pathname === '/studio/') {
          if (url.searchParams.get('token') === token) {
            res.writeHead(302, {
              'set-cookie': `ns_studio=${token}; HttpOnly; SameSite=Strict; Path=/`,
              location: '/studio/',
              'cache-control': 'no-store',
            });
            res.end();
            return;
          }
          if (!requireAuth(req)) {
            json(res, 403, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Open the URL printed by ns studio.' } });
            return;
          }
          const html = fs.readFileSync(path.join(distDir, 'index.html'));
          res.writeHead(200, {
            'content-type': 'text/html; charset=utf-8',
            'content-length': html.length,
            'cache-control': 'no-store',
            'content-security-policy':
              "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
            'x-content-type-options': 'nosniff',
            'x-frame-options': 'DENY',
            'referrer-policy': 'no-referrer',
          });
          res.end(html);
          return;
        }

        if (url.pathname.startsWith('/api/')) {
          if (!requireAuth(req)) {
            json(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'Missing studio session' } });
            return;
          }
          if (req.method !== 'GET' && req.method !== 'HEAD') guardMutation(req);

          if (req.method === 'GET' && url.pathname === '/api/bootstrap') {
            json(res, 200, { ok: true, ...bootstrap() });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/narrative') {
            const overview = readNarrativeOverview({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, ...overview });
            return;
          }

          if (req.method === 'DELETE' && url.pathname === '/api/narrative') {
            const { rebuildNarrativeIndex } = await import('@narrative-studio/narrative');
            const rebuilt = rebuildNarrativeIndex({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, rebuilt });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/narrative/search') {
            const query = url.searchParams.get('q') ?? '';
            const atOrderRaw = url.searchParams.get('atOrder');
            const results = searchNarrative({
              vaultDir,
              projectId,
              appDataRoot,
              query,
              limit: Number(url.searchParams.get('limit') ?? 20),
              atOrder: atOrderRaw === null ? null : Number(atOrderRaw),
            });
            json(res, 200, { ok: true, query, results });
            return;
          }

          const narrativeChapterMatch = /^\/api\/narrative\/chapter\/([A-Za-z0-9_]+)$/.exec(url.pathname);
          if (req.method === 'GET' && narrativeChapterMatch) {
            const evidence = chapterEvidence({ vaultDir, projectId, appDataRoot, chapterId: narrativeChapterMatch[1]! });
            json(res, 200, { ok: true, ...evidence });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/narrative/confirm') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const candidateId = asString(body.candidateId, 'candidateId', 200);
            const opened = openProject(vaultDir, projectId);
            const canon = readNarrativeCanon(opened.projectDir);
            const existing = canon?.assertions.find((item) => item.note?.includes(candidateId));
            if (canon && existing) {
              json(res, 200, { ok: true, assertionId: existing.assertion_id, anchorId: existing.evidence_anchor_ids[0] ?? null, manifest_revision: readManifest(opened.projectDir).revision, duplicate: true });
              return;
            }
            const overview = readNarrativeOverview({ vaultDir, projectId, appDataRoot });
            const candidate = overview.candidates.find((entry) => entry.candidate_id === candidateId);
            if (!candidate) throw new NarrativeStudioError('NOT_FOUND', `Narrative candidate ${candidateId} not found`);
            if (!canon) throw new NarrativeStudioError('NOT_FOUND', 'Narrative canon not found');
            const entry = opened.manifest.chapters[candidate.chapter_id];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', `Chapter ${candidate.chapter_id} not found`);
            const chapterBytes = readChapterBytes(opened.projectDir, candidate.chapter_id);
            const chapterText = chapterBytes.toString('utf8');
            const check = checkCandidateForAuthor({
              candidate,
              canon,
              chapter: {
                revision_id: entry.current_revision_id,
                content_hash: entry.content_hash,
                content: chapterText,
              },
            });
            if (!check.ok) {
              throw new NarrativeStudioError(
                check.code === 'STALE' || check.code === 'RANGE' ? 'CAS_MISMATCH' : 'INVALID_ARGUMENT',
                check.message,
                { candidateId, subjectCandidates: check.subjectCandidates },
              );
            }
            const entity = check.entity;
            const anchorId = newNarrativeId('anc');
            const anchor = createEvidenceAnchor({
              anchorId,
              chapter: {
                chapter_id: candidate.chapter_id,
                revision_id: entry.current_revision_id,
                content: chapterText,
                content_hash: entry.content_hash,
              },
              quote: candidate.quote,
              start_offset: candidate.start_offset,
            });
            const assertionId = newNarrativeId('asr');
            const nextCanon = {
              ...canon,
              entities: canon.entities.map((item) => item.entity_id === entity.entity_id
                ? { ...item, evidence_anchor_ids: [...item.evidence_anchor_ids, anchorId] }
                : item),
              evidence: [...canon.evidence, anchor],
              assertions: [...canon.assertions, {
                assertion_id: assertionId,
                subject_id: entity.entity_id,
                predicate: candidate.kind === 'relationship' ? '候选关系' : '候选事实',
                object_id: null,
                value: candidate.text,
                status: 'author-confirmed' as const,
                story_time: { kind: 'unknown' as const, label: '作者确认时未标注', sort_key: null },
                reveal_order: candidate.chapter_order,
                knowledge_scope: 'all',
                confidence: 1,
                evidence_anchor_ids: [anchorId],
                note: `作者从候选 ${candidate.candidate_id} 确认；规则 ${candidate.rule}`,
              }],
            };
            const written = writeNarrativeCanon({
              vaultDir,
              projectId,
              bundle: nextCanon,
              actor: { kind: 'author', id: 'local-author' },
            });
            indexNarrative({ vaultDir, projectId, appDataRoot, chapters: [candidate.chapter_id] });
            json(res, 200, { ok: true, assertionId, anchorId, manifest_revision: written.manifestRevision });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/narrative/reindex') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const chapterId = typeof body.chapterId === 'string' ? body.chapterId : null;
            const full = body.full === true;
            const { rebuildNarrativeIndex } = await import('@narrative-studio/narrative');
            const result = full
              ? rebuildNarrativeIndex({ vaultDir, projectId, appDataRoot })
              : indexNarrative({ vaultDir, projectId, appDataRoot, chapters: chapterId ? [chapterId] : undefined });
            json(res, 200, { ok: true, result });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/voice') {
            json(res, 200, { ok: true, voice: readVoiceOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/voice/analyze') {
            const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, voice });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/voice/sources') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const scope = asString(body.scope, 'scope', 30) as 'author' | 'project' | 'character' | 'scene';
            if (!['author', 'project', 'character', 'scene'].includes(scope)) {
              throw new NarrativeStudioError('INVALID_ARGUMENT', 'scope must be author/project/character/scene');
            }
            const category = asString(body.category, 'category', 40) as 'author-owned' | 'licensed-reference' | 'synthetic';
            if (!['author-owned', 'licensed-reference', 'synthetic'].includes(category)) {
              throw new NarrativeStudioError('INVALID_ARGUMENT', 'category must be author-owned/licensed-reference/synthetic');
            }
            const rawPermissions = (body.permissions ?? {}) as Record<string, unknown>;
            const permissions = {
              local_analysis: rawPermissions.local_analysis === true,
              quote_display: rawPermissions.quote_display === true,
              sample_storage: rawPermissions.sample_storage === true,
              cross_project_reuse: rawPermissions.cross_project_reuse === true,
              external_send: rawPermissions.external_send === true,
              public_release: rawPermissions.public_release === true,
            };
            const chapterIds = Array.isArray(body.chapterIds)
              ? body.chapterIds.filter((item): item is string => typeof item === 'string').slice(0, 2000)
              : undefined;
            let created;
            try {
              created = registerVoiceSource({
                vaultDir,
                projectId,
                input: {
                  name: asString(body.name, 'name', 200),
                  description: typeof body.description === 'string' ? body.description.slice(0, 2000) : '',
                  scope,
                  scopeRef: typeof body.scopeRef === 'string' ? body.scopeRef.slice(0, 200) : null,
                  category,
                  rightsStatement: asString(body.rightsStatement, 'rightsStatement', 4000),
                  permissions,
                  chapterIds,
                },
              });
            } catch (error) {
              if (error instanceof NarrativeStudioError) throw error;
              throw new NarrativeStudioError('INVALID_ARGUMENT', error instanceof Error ? error.message : String(error));
            }
            const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, source: created.source, voice });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/voice/sources/delete') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const sourceId = asString(body.sourceId, 'sourceId', 200);
            const reason = asString(body.reason, 'reason', 1000);
            deleteVoiceSource({ vaultDir, projectId, appDataRoot, sourceId, reason });
            const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, voice });
            return;
          }          if (req.method === 'POST' && url.pathname === '/api/voice/sources/revoke') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const sourceId = asString(body.sourceId, 'sourceId', 200);
            const reason = asString(body.reason, 'reason', 1000);
            revokeVoiceSource({ vaultDir, projectId, appDataRoot, sourceId, reason });
            const voice = analyzeVoice({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, voice });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/voice/proposals/approve') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const proposalId = asString(body.proposalId, 'proposalId', 200);
            const note = typeof body.note === 'string' ? body.note.slice(0, 2000) : undefined;
            const approved = approveVoiceProposal({ vaultDir, projectId, appDataRoot, proposalId, note });
            const voice = readVoiceOverview({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, rule: approved.rule, voice });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/voice/rules/revoke') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const ruleId = asString(body.ruleId, 'ruleId', 200);
            const reason = asString(body.reason, 'reason', 1000);
            const revoked = revokeStyleRule({ vaultDir, projectId, ruleId, reason });
            json(res, 200, { ok: true, rule: revoked.rule, voice: readVoiceOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/voice/rules/rollback') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const ruleId = asString(body.ruleId, 'ruleId', 200);
            const rolled = rollbackStyleRule({ vaultDir, projectId, ruleId });
            json(res, 200, { ok: true, rule: rolled.rule, voice: readVoiceOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/voice/compare') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const textA = asString(body.textA, 'textA', 40000);
            const textB = asString(body.textB, 'textB', 40000);
            json(res, 200, { ok: true, comparison: compareVoiceSamples(textA, textB) });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/editorial/compile') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const chapterId = asString(body.chapterId, 'chapterId', 200);
            const start = Number(body.start);
            const end = Number(body.end);
            const task = typeof body.task === 'string' ? body.task.slice(0, 500) : '保意精修';
            const level = String(body.level ?? 'L1');
            if (!['L0', 'L1', 'L2', 'L3'].includes(level)) throw new NarrativeStudioError('INVALID_ARGUMENT', 'level must be L0..L3');
            const compiled = compileEditorialJob({
              vaultDir, projectId, chapterId, start, end, task,
              level: level as 'L0' | 'L1' | 'L2' | 'L3',
              povEntityId: typeof body.povEntityId === 'string' ? body.povEntityId : null,
              forbidden: Array.isArray(body.forbidden) ? body.forbidden.filter((item): item is string => typeof item === 'string').slice(0, 30) : [],
              budgetTokens: Number(body.budgetTokens ?? 1800),
              appDataRoot,
            });
            json(res, 200, { ok: true, ...compiled });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/editorial/fixture') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const chapterId = asString(body.chapterId, 'chapterId', 200);
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[chapterId];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', 'chapter not found');
            const chapterText = readChapterBytes(opened.projectDir, chapterId).toString('utf8');
            const start = Math.max(0, Math.min(Number(body.start ?? 0), chapterText.length));
            const end = Math.max(start, Math.min(Number(body.end ?? Math.min(chapterText.length, start + 400)), chapterText.length));
            if (end <= start) throw new NarrativeStudioError('INVALID_ARGUMENT', 'selection is empty');
            const fixture = fixtureCandidate({ chapterText, selection: { start, end }, task: String(body.task ?? '离线演示') });
            const proposal = validateEditProposal({
              chapterText, chapterId, projectId: opened.project.project_id,
              baseRevision: entry.current_revision_id, currentRevision: entry.current_revision_id,
              baseHash: entry.content_hash, currentHash: entry.content_hash,
              selection: { start, end }, source: fixture.source,
              sourceLabel: '离线确定性演示候选（非模型输出）',
              hunks: fixture.hunks,
              forbidden: Array.isArray(body.forbidden) ? body.forbidden.filter((item): item is string => typeof item === 'string') : [],
              futureSecretValues: futureSecretValuesFor({ vaultDir, projectId, chapterId, povEntityId: typeof body.povEntityId === 'string' ? body.povEntityId : null }),
            });
            saveProposal(appDataRoot!, opened.project.project_id, proposal);
            json(res, 200, { ok: true, proposal });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/editorial/candidate') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const chapterId = asString(body.chapterId, 'chapterId', 200);
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[chapterId];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', 'chapter not found');
            const chapterText = readChapterBytes(opened.projectDir, chapterId).toString('utf8');
            const source = String(body.source ?? 'manual-import');
            if (!['manual-import', 'deterministic-fixture', 'offline-mock'].includes(source)) throw new NarrativeStudioError('INVALID_ARGUMENT', 'invalid candidate source');
            const selection = { start: Number(body.start), end: Number(body.end) };
            const proposal = validateEditProposal({
              chapterText, chapterId, projectId: opened.project.project_id,
              baseRevision: String(body.baseRevision ?? ''), currentRevision: entry.current_revision_id,
              baseHash: String(body.baseHash ?? ''), currentHash: entry.content_hash,
              selection, source: source as 'manual-import' | 'deterministic-fixture' | 'offline-mock',
              sourceLabel: source === 'manual-import' ? '作者手动导入候选（未经模型生成）' : source === 'offline-mock' ? '离线模拟候选（非真实模型）' : '确定性演示候选',
              hunks: Array.isArray(body.hunks) ? body.hunks as never[] : [],
              forbidden: Array.isArray(body.forbidden) ? body.forbidden.filter((item): item is string => typeof item === 'string') : [],
              futureSecretValues: futureSecretValuesFor({ vaultDir, projectId, chapterId, povEntityId: typeof body.povEntityId === 'string' ? body.povEntityId : null }),
            });
            saveProposal(appDataRoot!, opened.project.project_id, proposal);
            json(res, 200, { ok: true, proposal });
            return;
          }
          const proposalMatch = /^\/api\/editorial\/proposal\/([A-Za-z0-9_]+)$/.exec(url.pathname);
          if (req.method === 'GET' && proposalMatch) {
            const proposal = loadProposal(appDataRoot!, projectId!, proposalMatch[1]!);
            if (!proposal) throw new NarrativeStudioError('NOT_FOUND', 'proposal not found');
            json(res, 200, { ok: true, proposal });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/editorial/decision') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const proposalId = asString(body.proposalId, 'proposalId', 200);
            const hunkId = asString(body.hunkId, 'hunkId', 200);
            const decision = String(body.decision ?? 'pending');
            if (!['pending', 'accept', 'reject'].includes(decision)) throw new NarrativeStudioError('INVALID_ARGUMENT', 'invalid decision');
            const existing = loadProposal(appDataRoot!, projectId!, proposalId);
            if (!existing) throw new NarrativeStudioError('NOT_FOUND', 'proposal not found');
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[existing.chapter_id];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', 'chapter not found');
            assertProposalCurrent(existing, readChapterBytes(opened.projectDir, existing.chapter_id).toString('utf8'), entry.current_revision_id, entry.content_hash);
            const proposal = setHunkDecision(appDataRoot!, projectId!, proposalId, hunkId, decision as 'pending' | 'accept' | 'reject');
            json(res, 200, { ok: true, proposal, exported_preview: acceptedPreview(proposal) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/editorial/export') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const proposal = loadProposal(appDataRoot!, projectId!, asString(body.proposalId, 'proposalId', 200));
            if (!proposal) throw new NarrativeStudioError('NOT_FOUND', 'proposal not found');
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[proposal.chapter_id];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', 'chapter not found');
            assertProposalCurrent(proposal, readChapterBytes(opened.projectDir, proposal.chapter_id).toString('utf8'), entry.current_revision_id, entry.content_hash);
            json(res, 200, { ok: true, text: acceptedPreview(proposal), manuscript_written: false });
            return;
          }

          if (req.method === 'GET' && url.pathname === '/api/literary') {
            json(res, 200, { ok: true, provider: providerStatus(), summary: experimentSummary(appDataRoot!) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/literary/pair') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const taskId = asString(body.taskId, 'taskId', 200);
            if (body.source === 'local_model') throw new NarrativeStudioError('UNAUTHORIZED', 'MODEL_RUN=BLOCKED: no authorized local model');
            const b0 = createFixtureCandidate({ taskId, text: String(body.b0 ?? ''), contextHash: String(body.contextHash ?? 'unknown') });
            const b1 = createFixtureCandidate({ taskId, text: String(body.b1 ?? ''), contextHash: String(body.contextHash ?? 'unknown') });
            const pair = createBlindPair({ taskId, b0, b1 });
            savePair(appDataRoot!, pair); json(res, 200, { ok: true, pair }); return;
          }
          if (req.method === 'POST' && url.pathname === '/api/literary/review') {
            const body = (await readBody(req)) as Record<string, unknown>;
            submitReview(appDataRoot!, { pair_id: asString(body.pairId, 'pairId', 200), choice: String(body.choice ?? 'tie') as 'A' | 'B' | 'tie' | 'neither', scores: typeof body.scores === 'object' && body.scores ? body.scores as Record<string, number> : {}, note: String(body.note ?? '').slice(0, 2000), created_at: new Date().toISOString() });
            json(res, 200, { ok: true, summary: experimentSummary(appDataRoot!) }); return;
          }
          if (req.method === 'POST' && url.pathname === '/api/literary/clear') {
            clearEvidence(appDataRoot!); json(res, 200, { ok: true, summary: experimentSummary(appDataRoot!) }); return;
          }
          if(url.pathname==='/api/books' && req.method==='GET') {
            const books=fs.existsSync(libraryRoot)?fs.readdirSync(libraryRoot).filter(id=>/^[a-f0-9]{16}$/.test(id)).flatMap(id=>{try{const p=openProject(path.join(libraryRoot,id,'vault'));return [{id,title:p.project.title}];}catch{return [];}}):[];
            json(res,200,{ok:true,books});return;
          }
          if(url.pathname==='/api/books/open' && req.method==='POST') {
            const body=await readBody(req) as Record<string,unknown>;const id=String(body.id);
            if(!/^[a-f0-9]{16}$/.test(id))throw new NarrativeStudioError('INVALID_ARGUMENT','无效作品');
            const root=path.join(libraryRoot,id);const book=await startStudioServer({vaultDir:path.join(root,'vault'),appDataRoot:path.join(root,'runtime'),distDir,libraryRoot,port:0});bookServers.push(book);json(res,200,{ok:true,url:book.url});return;
          }
          if(url.pathname==='/api/books/create' && req.method==='POST') {
            const body=await readBody(req) as Record<string,unknown>;
            if(body.confirm!==true) throw new NarrativeStudioError('UNAUTHORIZED','AUTHOR_CONFIRMATION_REQUIRED');
            const root=path.join(libraryRoot,randomBytes(8).toString('hex'));
            const bookVault=path.join(root,'vault'),runtime=path.join(root,'runtime');
            initProject({vaultDir:bookVault,title:asString(body.title,'title',200),language:'zh-CN'});
            const book=await startStudioServer({vaultDir:bookVault,appDataRoot:runtime,distDir,libraryRoot,port:0});bookServers.push(book);
            json(res,200,{ok:true,url:book.url});return;
          }
          if(url.pathname==='/api/framework' && req.method==='GET') { json(res,200,{ok:true,...readFramework(coOptions)}); return; }
          if(url.pathname.startsWith('/api/framework/') && req.method==='POST') {
            const body=await readBody(req) as Record<string,unknown>;
            if(url.pathname.endsWith('/dismiss')){const s=readSession(coOptions,'framework');saveSession(coOptions,'framework',{...s,frameworkDraft:undefined});json(res,200,{ok:true});return;}
            if(url.pathname.endsWith('/discuss')||url.pathname.endsWith('/generate')){
              if(coRequests.size)throw new NarrativeStudioError('INVALID_ARGUMENT','已有生成任务，请先停止');
              const controller=new AbortController(),id=String(body.requestId);coRequests.set(id,controller);
              try{const result=url.pathname.endsWith('/discuss')?await discussFramework(coOptions,body,controller.signal,text=>coProgress.set(id,text)):await draftFramework(body,coOptions,controller.signal);json(res,200,{ok:true,...result});}
              finally{coRequests.delete(id);coProgress.delete(id);}return;
            }
            if(url.pathname.endsWith('/save')) { saveFramework(coOptions,body); json(res,200,{ok:true,...readFramework(coOptions)}); return; }
            if(url.pathname.endsWith('/relations')) { confirmFrameworkRelations(coOptions,body); json(res,200,{ok:true,...readFramework(coOptions),narrative:refreshNarrative()}); return; }
          }
          if(url.pathname==='/api/cowriting/progress' && req.method==='GET'){json(res,200,{ok:true,text:coProgress.get(url.searchParams.get('id')??'')??''});return;}
          if (url.pathname === '/api/cowriting/session' && req.method === 'GET') {
            json(res,200,{ok:true,...readSession(coOptions,url.searchParams.get('chapterId') ?? '')}); return;
          }
          if (url.pathname.startsWith('/api/cowriting/') && req.method === 'POST') {
            const body = await readBody(req) as Record<string,unknown>;
            const action = url.pathname.split('/').pop();
            if(action==='cancel') { coRequests.get(String(body.requestId))?.abort(); json(res,200,{ok:true}); return; }
            if(action==='discard'){const chapterId=String(body.chapterId),session=readSession(coOptions,chapterId);const next={...session,candidate:null};saveSession(coOptions,chapterId,next);json(res,200,{ok:true,...next});return;}
            if(action==='clear') { clearSession(coOptions,String(body.chapterId)); json(res,200,{ok:true}); return; }
            if(action==='generate' || action==='discuss' || action==='refine') {
              if(coRequests.size) throw new NarrativeStudioError('INVALID_ARGUMENT','已有生成任务，请先停止');
              const controller = new AbortController(); const id=String(body.requestId);
              coRequests.set(id,controller);
              try { const result=await (action==='discuss'?discussCoWriting:generateCoCandidate)(coOptions,{...body,refine:action==='refine'},controller.signal,text=>coProgress.set(id,text)); json(res,200,{ok:true,...result}); }
              finally { coRequests.delete(id); coProgress.delete(id); } return;
            }
            if(action==='apply' || action==='undo') {
              const result=action==='apply'?applyCoCandidate(coOptions,body):undoCoCandidate(coOptions,body);
              json(res,200,{ok:true,...result,projection:refreshProjection(),narrative:refreshNarrative(String(body.chapterId))}); return;
            }
          }
          if (req.method === 'GET' && url.pathname === '/api/ai/status') {
            json(res, 200, { ok: true, status: aiStatus() });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/ai/outline') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const result = await generateOutline({ idea: String(body.idea ?? '').slice(0, 4000), genre: String(body.genre ?? '悬疑').slice(0, 80), volumes: Math.max(1, Math.min(5, Number(body.volumes ?? 1))), chaptersPerVolume: Math.max(1, Math.min(20, Number(body.chaptersPerVolume ?? 10))), consent: body.consent === true, mock: body.mock === true });
            json(res, 200, { ok: true, ...result });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/ai/continue') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const chapterId = asString(body.chapterId, 'chapterId', 200);
            const instruction = String(body.instruction ?? '续写下一段').slice(0, 2000);
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[chapterId];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', 'Chapter not found');
            const chapterText = readChapterBytes(opened.projectDir, chapterId).toString('utf8');
            const compiled = compileContinuation({ vaultDir, projectId, chapterId, start: 0, end: chapterText.length, task: instruction, povEntityId: typeof body.povEntityId === 'string' ? body.povEntityId : null, budgetTokens: 2400 });
            const generated = await generateContinuation({ compiledPrompt: compiled.compiled.prompt, instruction, consent: body.consent === true, mock: body.mock === true });
            const forbidden = [...new Set([...(Array.isArray(body.forbidden) ? body.forbidden.filter((x): x is string => typeof x === 'string') : []), ...compiled.plans.plans.map((plan) => plan.risk).filter((risk) => risk.trim().length > 0)])];
            const candidate = createCandidate({ appDataRoot: appDataRoot!, vaultDir, projectId, chapterId, text: generated.text, task: instruction, source: generated.source === 'deepseek' ? 'deepseek' : 'deepseek-mock', start: 0, end: chapterText.length, povEntityId: typeof body.povEntityId === 'string' ? body.povEntityId : null, planId: typeof body.planId === 'string' ? body.planId : null, branchId: typeof body.branchId === 'string' ? body.branchId : null, forbidden, genreIds: compiled.plans.genres.map((g) => g.genre_id) });
            json(res, 200, { ok: true, candidate, model: generated.model, source: generated.source, external_send: generated.source === 'deepseek' });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/gate4') {
            json(res, 200, { ok: true, planning: readPlanning({ vaultDir, projectId }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/idea') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const idea = addIdea({ vaultDir, projectId, idea: {
              title: asString(body.title, 'title', 200), premise: String(body.premise ?? '').slice(0, 3000),
              theme: String(body.theme ?? '').slice(0, 500), protagonist_goal: String(body.protagonist_goal ?? '').slice(0, 1000),
              conflict: String(body.conflict ?? '').slice(0, 1000), genre_ids: Array.isArray(body.genre_ids) ? body.genre_ids.filter((x): x is string => typeof x === 'string') : [],
              forbidden: Array.isArray(body.forbidden) ? body.forbidden.filter((x): x is string => typeof x === 'string') : [], reader_expectation: String(body.reader_expectation ?? '').slice(0, 1000),
            } });
            json(res, 200, { ok: true, idea, planning: readPlanning({ vaultDir, projectId }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/plan') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const plan = addPlan({ vaultDir, projectId, approve: body.approve === true, plan: {
              volume: Number(body.volume ?? 1), chapter: Number(body.chapter ?? 1), scene: Number(body.scene ?? 1),
              title: asString(body.title, 'title', 200), goal: String(body.goal ?? '').slice(0, 2000),
              pov_entity_id: typeof body.pov_entity_id === 'string' ? body.pov_entity_id : null,
              location: String(body.location ?? '').slice(0, 300), cast: Array.isArray(body.cast) ? body.cast.filter((x): x is string => typeof x === 'string') : [],
              cause: '', action: '', result: '', suspense: '', risk: String(body.risk ?? '').slice(0, 1000),
              base_chapter_revision: typeof body.base_chapter_revision === 'string' ? body.base_chapter_revision : null,
              base_chapter_hash: typeof body.base_chapter_hash === 'string' ? body.base_chapter_hash : null,
              genre_ids: Array.isArray(body.genre_ids) ? body.genre_ids.filter((x): x is string => typeof x === 'string') : [],
            } });
            json(res, 200, { ok: true, plan, planning: readPlanning({ vaultDir, projectId }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/branch') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const branch = addBranch({ vaultDir, projectId, branch: {
              plan_id: typeof body.plan_id === 'string' ? body.plan_id : null, title: asString(body.title, 'title', 200),
              premise: String(body.premise ?? '').slice(0, 3000), short_term_cost: String(body.short_term_cost ?? '').slice(0, 1000), motivation: String(body.motivation ?? '').slice(0, 1000), conflict: '', irreversible_cost: String(body.irreversible_cost ?? '').slice(0, 1000), evidence_refs: [], risk: String(body.risk ?? '').slice(0, 1000),
            } });
            json(res, 200, { ok: true, branch, planning: readPlanning({ vaultDir, projectId }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/branch/select') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const state = selectBranch({ vaultDir, projectId, branchId: asString(body.branchId, 'branchId', 200) });
            json(res, 200, { ok: true, state, planning: readPlanning({ vaultDir, projectId }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/genre') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const state = setGenres({ vaultDir, projectId, genreIds: Array.isArray(body.genreIds) ? body.genreIds.filter((x): x is string => typeof x === 'string') : [] });
            json(res, 200, { ok: true, state, planning: readPlanning({ vaultDir, projectId }) });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/gate4/continuation') {
            json(res, 200, { ok: true, candidates: listCandidates({ appDataRoot: appDataRoot!, vaultDir, projectId }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/continuation/compile') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const result = compileContinuation({ vaultDir, projectId, chapterId: asString(body.chapterId, 'chapterId', 200), start: Number(body.start ?? 0), end: Number(body.end ?? 200), task: String(body.task ?? '续写下一场'), povEntityId: typeof body.povEntityId === 'string' ? body.povEntityId : null, budgetTokens: Number(body.budgetTokens ?? 1800) });
            json(res, 200, { ok: true, compiled: result.compiled, plans: result.plans });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/continuation/candidate') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const chapterId = asString(body.chapterId, 'chapterId', 200);
            const opened = openProject(vaultDir, projectId);
            const chapterText = readChapterBytes(opened.projectDir, chapterId).toString('utf8');
            const selectionEnd = Number(body.selectionEnd ?? Math.min(chapterText.length, 200));
            const task = String(body.task ?? '续写下一场');
            const compiled = compileContinuation({ vaultDir, projectId, chapterId, start: 0, end: Math.min(chapterText.length, selectionEnd), task, povEntityId: typeof body.povEntityId === 'string' ? body.povEntityId : null });
            const povEntityId = typeof body.povEntityId === 'string' ? body.povEntityId : compiled.plans.plans[0]?.pov_entity_id ?? null;
            const authoritativeForbidden = [...new Set([...(Array.isArray(body.forbidden) ? body.forbidden.filter((x): x is string => typeof x === 'string') : []), ...compiled.plans.plans.map((plan) => plan.risk).filter((risk) => risk.trim().length > 0)])];
            const generated = typeof body.text === 'string' ? body.text : fixtureCandidateText({ chapterText, selectionEnd: Math.min(chapterText.length, selectionEnd) });
            const candidate = createCandidate({
              appDataRoot: appDataRoot!, vaultDir, projectId, chapterId, text: generated, task,
              source: typeof body.text === 'string' ? 'manual-import' : 'offline-fixture',
              start: 0, end: Math.min(chapterText.length, selectionEnd), povEntityId,
              planId: typeof body.planId === 'string' ? body.planId : null,
              branchId: typeof body.branchId === 'string' ? body.branchId : null,
              forbidden: authoritativeForbidden,
              genreIds: compiled.plans.genres.map((genre) => genre.genre_id),
            });
            json(res, 200, { ok: true, candidate });
            return;
          }          if (req.method === 'POST' && url.pathname === '/api/gate4/continuation/decision') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const candidate = decideCandidate({ appDataRoot: appDataRoot!, vaultDir, projectId, candidateId: asString(body.candidateId, 'candidateId', 200), decision: String(body.decision) === 'rejected' ? 'rejected' : 'selected' });
            json(res, 200, { ok: true, candidate });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/gate4/continuation/export') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const exported = exportCandidate({ appDataRoot: appDataRoot!, vaultDir, projectId, candidateId: asString(body.candidateId, 'candidateId', 200) });
            json(res, 200, { ok: true, ...exported });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/coevolution') {
            json(res, 200, { ok: true, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/consent') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const state = setConsent({ vaultDir, projectId, consent: {
              store_feedback: body.store_feedback === true,
              local_strategy_learning: body.local_strategy_learning === true,
              show_coaching: body.show_coaching === true,
              cross_project_reuse: body.cross_project_reuse === true,
              external_send: false,
            } });
            json(res, 200, { ok: true, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }), state });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/feedback') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const proposal = loadProposal(appDataRoot!, projectId!, asString(body.proposalId, 'proposalId', 200));
            if (!proposal) throw new NarrativeStudioError('NOT_FOUND', 'proposal not found');
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[proposal.chapter_id];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', 'chapter not found');
            const observation = recordFeedback({
              vaultDir, projectId, proposal,
              hunkId: asString(body.hunkId, 'hunkId', 200),
              modifiedText: typeof body.modifiedText === 'string' ? body.modifiedText : null,
              reasonCode: typeof body.reasonCode === 'string' ? body.reasonCode : 'unspecified',
            });
            json(res, 200, { ok: true, observation, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }          if (req.method === 'POST' && url.pathname === '/api/coevolution/observation/revoke') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const state = revokeObservation({ vaultDir, projectId, observationId: asString(body.observationId, 'observationId', 200), reason: asString(body.reason, 'reason', 1000) });
            json(res, 200, { ok: true, state, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/policies/activate') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const policy = activatePolicy({ vaultDir, projectId, hypothesisId: asString(body.hypothesisId, 'hypothesisId', 200), text: typeof body.text === 'string' ? body.text : undefined });
            json(res, 200, { ok: true, policy, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/policies/transition') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const policyId = asString(body.policyId, 'policyId', 200);
            const action = String(body.action ?? '');
            const policy = action === 'freeze'
              ? freezePolicy({ vaultDir, projectId, policyId, reason: String(body.reason ?? 'author freeze') })
              : action === 'revoke'
                ? revokePolicy({ vaultDir, projectId, policyId, reason: String(body.reason ?? 'author revoke') })
                : action === 'rollback' ? rollbackPolicy({ vaultDir, projectId, policyId })
                  : (() => { throw new NarrativeStudioError('INVALID_ARGUMENT', 'action must be freeze/revoke/rollback'); })();
            json(res, 200, { ok: true, policy, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/goal') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const goal = addGoal({ vaultDir, projectId, skill: asString(body.skill, 'skill', 200), note: typeof body.note === 'string' ? body.note : '' });
            json(res, 200, { ok: true, goal, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/reflection') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const reflection = addReflection({ vaultDir, projectId, goalId: typeof body.goalId === 'string' ? body.goalId : null, prompt: asString(body.prompt, 'prompt', 300), note: asString(body.note, 'note', 2000) });
            json(res, 200, { ok: true, reflection, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/exercise') {
            const body = (await readBody(req)) as Record<string, unknown>;
            const attempt = addExerciseAttempt({ vaultDir, projectId, exerciseId: asString(body.exerciseId, 'exerciseId', 200), status: String(body.status ?? 'started') as 'started' | 'completed' | 'deferred', note: typeof body.note === 'string' ? body.note : '' });
            json(res, 200, { ok: true, attempt, coevolution: readCoevolutionOverview({ vaultDir, projectId, appDataRoot }) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/coevolution/rebuild') {
            const coevolution = rebuildCoevolutionProjection({ vaultDir, projectId, appDataRoot });
            json(res, 200, { ok: true, coevolution });
            return;
          }
          const chapterMatch = /^\/api\/chapter\/([A-Za-z0-9_]+)$/.exec(url.pathname);
          if (req.method === 'GET' && chapterMatch) {
            const chapterId = chapterMatch[1]!;
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[chapterId];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', `Chapter ${chapterId} not found`);
            const bytes = readChapterBytes(opened.projectDir, chapterId);
            const revision = readRevision(opened.projectDir, chapterId, entry.current_revision_id);
            json(res, 200, {
              ok: true,
              chapter: chapterSummary(entry),
              content: bytes.toString('utf8'),
              revision: revisionSummary(revision),
              manifest_revision: opened.manifest.revision,
            });
            return;
          }

          const historyMatch = /^\/api\/chapter\/([A-Za-z0-9_]+)\/history$/.exec(url.pathname);
          if (req.method === 'GET' && historyMatch) {
            const chapterId = historyMatch[1]!;
            const opened = openProject(vaultDir, projectId);
            if (!opened.manifest.chapters[chapterId]) {
              throw new NarrativeStudioError('NOT_FOUND', `Chapter ${chapterId} not found`);
            }
            const revisions = listRevisions(opened.projectDir, chapterId)
              .slice()
              .sort((left, right) => right.seq - left.seq)
              .map(revisionSummary);
            json(res, 200, { ok: true, revisions });
            return;
          }

          const revisionMatch = /^\/api\/chapter\/([A-Za-z0-9_]+)\/revision\/([A-Za-z0-9_]+)$/.exec(url.pathname);
          if (req.method === 'GET' && revisionMatch) {
            const opened = openProject(vaultDir, projectId);
            const [chapterId, revisionId] = [revisionMatch[1]!, revisionMatch[2]!];
            const body = readRevisionText(opened, chapterId, revisionId);
            json(res, 200, { ok: true, revision: revisionSummary(body.revision), content: body.text });
            return;
          }

          const saveMatch = /^\/api\/chapter\/([A-Za-z0-9_]+)\/save$/.exec(url.pathname);
          if (req.method === 'POST' && saveMatch) {
            const chapterId = saveMatch[1]!;
            const body = (await readBody(req)) as Record<string, unknown>;
            const content = asString(body.content, 'content');
            const baseRevision = asString(body.baseRevision, 'baseRevision', 200);
            const message = typeof body.message === 'string' ? body.message.slice(0, 2000) : null;
            const opened = openProject(vaultDir, projectId);
            const entry = opened.manifest.chapters[chapterId];
            if (!entry) throw new NarrativeStudioError('NOT_FOUND', `Chapter ${chapterId} not found`);
            const currentRevision = readRevision(opened.projectDir, chapterId, entry.current_revision_id);
            const preserved = preserveLineEndings(content, currentRevision.line_ending);
            const result = commitChapter({
              vaultDir,
              projectId,
              chapterId,
              content: Buffer.from(preserved, 'utf8'),
              baseRevision,
              message: message ?? 'workbench save',
              actor: { kind: 'author', id: 'local-author' },
              origin: 'author',
              logger: options.logger ?? null,
            });
            const projection = refreshProjection();
            json(res, 200, {
              ok: true,
              revision: result.revision,
              manifest_revision: result.manifest.revision,
              content_hash: result.revision.content_hash,
              saved_at: result.revision.created_at,
              projection,
              narrative: refreshNarrative(chapterId),
            });
            return;
          }

          const revertMatch = /^\/api\/chapter\/([A-Za-z0-9_]+)\/revert$/.exec(url.pathname);
          if (req.method === 'POST' && revertMatch) {
            const chapterId = revertMatch[1]!;
            const body = (await readBody(req)) as Record<string, unknown>;
            const revisionId = asString(body.revisionId, 'revisionId', 200);
            const baseRevision = asString(body.baseRevision, 'baseRevision', 200);
            const opened = openProject(vaultDir, projectId);
            if (!opened.manifest.chapters[chapterId]) {
              throw new NarrativeStudioError('NOT_FOUND', `Chapter ${chapterId} not found`);
            }
            const target = readRevisionText(opened, chapterId, revisionId);
            const result = commitChapter({
              vaultDir,
              projectId,
              chapterId,
              content: Buffer.from(target.text, 'utf8'),
              baseRevision,
              message: `恢复版本 ${revisionId.slice(0, 18)}`,
              actor: { kind: 'author', id: 'local-author' },
              origin: 'author',
              logger: options.logger ?? null,
            });
            json(res, 200, {
              ok: true,
              revision: result.revision,
              manifest_revision: result.manifest.revision,
              projection: refreshProjection(),
              narrative: refreshNarrative(),
            });
            return;
          }

          if (req.method === 'POST' && url.pathname === '/api/chapter') {
            const body = (await readBody(req, 18 * 1024 * 1024)) as Record<string, unknown>;
            const title = asString(body.title, 'title', 300).trim();
            if (!title) throw new NarrativeStudioError('INVALID_ARGUMENT', 'Chapter title is required');
            const importing = body.content !== undefined;
            const content = importing ? asString(body.content, 'content') : '';
            // eslint-disable-next-line no-control-regex -- reject non-text import bytes
            if (Buffer.byteLength(content, 'utf8') > 8 * 1024 * 1024 || (importing && (!content.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(content)))) throw new NarrativeStudioError('INVALID_ARGUMENT', '请选择有效 UTF-8 文本，大小不超过 8 MB');
            const baseRevision = importing ? asString(body.baseRevision, 'baseRevision', 200) : undefined;
            const opened = openProject(vaultDir, projectId);
            let importMessage: string | undefined;
            if (importing) {
              const importId = asString(body.importId, 'importId', 80);
              if (!/^[a-f0-9-]{36}$/.test(importId)) throw new NarrativeStudioError('INVALID_ARGUMENT', 'Invalid import request id');
              const prefix = 'author-import:' + importId + ':';
              importMessage = prefix + createHash('sha256').update(JSON.stringify({title,content})).digest('hex');
              for (const entry of Object.values(opened.manifest.chapters)) {
                const previous = listRevisions(opened.projectDir, entry.chapter_id).find(r => r.message?.startsWith(prefix));
                if (!previous) continue;
                if (previous.message !== importMessage) throw new NarrativeStudioError('INVALID_ARGUMENT', '这次导入已经完成，但重试内容不同。请重新选择文件。');
                json(res, 200, {ok:true, chapter:chapterSummary(entry), manifest_revision:opened.manifest.revision, reused:true});
                return;
              }
            }
            const result = createChapter({
              vaultDir,
              projectId,
              title,
              volumeId: opened.project.default_volume_id,
              content: Buffer.from(content, 'utf8'),
              baseRevision,
              message: importMessage ?? 'created in workbench',
              actor: { kind: 'author', id: 'local-author' },
              origin: 'author',
              logger: options.logger ?? null,
            });
            json(res, 200, {
              ok: true,
              chapter: chapterSummary(result.manifest.chapters[result.chapter.chapter_id]!),
              manifest_revision: result.manifest.revision,
              projection: refreshProjection(),
              narrative: refreshNarrative(result.chapter.chapter_id),
            });
            return;
          }

          json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Unknown API route' } });
          return;
        }

        // Static assets; only paths inside dist are served.
        const relative = decodeURIComponent(url.pathname).replace(/^\/+/, '');
        const candidate = path.resolve(distDir, relative);
        if (!candidate.startsWith(path.resolve(distDir) + path.sep) || !fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
          json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'Asset not found' } });
          return;
        }
        const data = fs.readFileSync(candidate);
        res.writeHead(200, {
          'content-type': MIME[path.extname(candidate).toLowerCase()] ?? 'application/octet-stream',
          'content-length': data.length,
          'cache-control': relative.startsWith('assets/') ? 'public, max-age=31536000, immutable' : 'no-store',
          'x-content-type-options': 'nosniff',
        });
        res.end(data);
      } catch (error) {
        sendError(error);
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, host, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  actualPort = port;
  const url = `http://${host}:${port}/?token=${token}`;
  options.logger?.info('studio.started', { project_id: projectId, port, local_only: true });

  const close = async (): Promise<void> => {
    for(const controller of coRequests.values()) controller.abort();
    await Promise.all(bookServers.map(book=>book.close()));
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { url, port, token, projectId, close };
}
