import type { NarrativeCanonBundle, NarrativeEntity } from '@narrative-studio/contracts';

export interface CandidateForConfirmation {
  candidate_id: string;
  text: string;
  subject_name: string;
  revision_id: string;
  chapter_content_hash: string;
  start_offset: number;
  end_offset: number;
  quote: string;
  chapter_order: number;
  kind: string;
  rule: string;
}

export type CandidateCheck =
  | { ok: true; entity: NarrativeEntity }
  | {
      ok: false;
      code: 'STALE' | 'RANGE' | 'AMBIGUOUS' | 'NO_SUBJECT';
      message: string;
      subjectCandidates?: string[];
    };

/**
 * Re-validates a candidate against the current chapter before an author
 * confirmation is allowed to write canon. There is deliberately no
 * "first entity wins" fallback: ambiguous short aliases must be resolved by a
 * human choice instead of being silently attached to an arbitrary character.
 */
export function checkCandidateForAuthor(input: {
  candidate: CandidateForConfirmation;
  canon: NarrativeCanonBundle;
  chapter: { revision_id: string; content_hash: string; content: string };
}): CandidateCheck {
  const { candidate, canon, chapter } = input;
  if (
    !candidate.revision_id ||
    !candidate.chapter_content_hash ||
    candidate.revision_id !== chapter.revision_id ||
    candidate.chapter_content_hash !== chapter.content_hash
  ) {
    return {
      ok: false,
      code: 'STALE',
      message: '候选来源章节已修改；请先刷新索引并重新确认候选',
    };
  }
  if (
    candidate.start_offset < 0 ||
    candidate.end_offset < candidate.start_offset ||
    chapter.content.slice(candidate.start_offset, candidate.end_offset) !== candidate.quote
  ) {
    return {
      ok: false,
      code: 'RANGE',
      message: '候选原文位置已失效；请先刷新索引并重新确认候选',
    };
  }
  if (candidate.quote.length === 0) {
    return { ok: false, code: 'RANGE', message: '候选缺少可定位的原文片段' };
  }
  const subjectName = candidate.subject_name.trim();
  if (!subjectName) {
    return { ok: false, code: 'NO_SUBJECT', message: '候选缺少可确认的主体；请人工指定人物后再确认', subjectCandidates: [] };
  }
  const subjectMatches = canon.entities.filter((entity) =>
    [entity.name, ...entity.aliases].includes(subjectName),
  );
  if (subjectMatches.length === 0) {
    return {
      ok: false,
      code: 'NO_SUBJECT',
      message: '无法从候选唯一确定主体；请人工指定人物后再确认',
      subjectCandidates: [],
    };
  }
  if (subjectMatches.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS',
      message: '候选主体存在同名/多义（例如“小满”两个人物）；请人工选人后再确认',
      subjectCandidates: subjectMatches.map((entity) => entity.entity_id),
    };
  }
  return { ok: true, entity: subjectMatches[0]! };
}
