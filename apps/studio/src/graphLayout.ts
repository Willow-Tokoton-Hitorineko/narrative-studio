/**
 * Deterministic, dependency-free SVG geometry for the small Gate 2 Atlas
 * relationship graph. This is intentionally not a force-directed engine:
 * stable positions, measured text estimates and bounded label placement are
 * easier to audit and keep a literary, quiet visual rhythm.
 */

export interface GraphPerson {
  entity_id: string;
  name: string;
  aliases: string[];
}

export interface GraphRelationship {
  relationship_id: string;
  from_entity_id: string;
  to_entity_id: string;
  kind: string;
  status: string;
  evidence_anchor_ids: string[];
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface NodeLayout {
  id: string;
  name: string;
  aliases: string[];
  center: { x: number; y: number };
  width: number;
  height: number;
  nameLines: string[];
  aliasLines: string[];
  rect: Rect;
}

export interface EdgeLayout {
  id: string;
  from: string;
  to: string;
  kind: string;
  disputed: boolean;
  anchorId: string | undefined;
  start: { x: number; y: number };
  end: { x: number; y: number };
  label: { x: number; y: number; width: number; height: number; lines: string[] };
  labelRect: Rect;
  anchor: { x: number; y: number };
}

export interface GraphLayout {
  width: number;
  height: number;
  padding: number;
  nodes: NodeLayout[];
  edges: EdgeLayout[];
}

const CJK = /[\u3400-\u9fff]/;

export function estimateTextWidth(text: string, fontSize: number): number {
  let width = 0;
  for (const char of text) {
    if (CJK.test(char)) width += fontSize;
    else if (char === ' ') width += fontSize * 0.34;
    else if (/[A-Z]/.test(char)) width += fontSize * 0.72;
    else if (/[a-z0-9]/.test(char)) width += fontSize * 0.56;
    else width += fontSize * 0.48;
  }
  return width;
}

function tokensForWrap(text: string): string[] {
  const tokens: string[] = [];
  let latin = '';
  const flush = () => {
    if (latin) {
      tokens.push(latin);
      latin = '';
    }
  };
  for (const char of text) {
    if (CJK.test(char) || /[，。；：、！？（）()·“”‘’《》]/.test(char)) {
      flush();
      tokens.push(char);
    } else if (char === ' ') {
      flush();
      tokens.push(' ');
    } else {
      latin += char;
    }
  }
  flush();
  return tokens;
}

export function wrapGraphText(text: string, maxWidth: number, fontSize: number, maxLines = 3): string[] {
  const lines: string[] = [];
  let current = '';
  const tokens = tokensForWrap(text);
  for (const token of tokens) {
    const candidate = current + token;
    if (current && estimateTextWidth(candidate, fontSize) > maxWidth) {
      lines.push(current.trimEnd());
      current = token === ' ' ? '' : token;
    } else {
      current = candidate;
    }
  }
  if (current) lines.push(current.trimEnd());
  if (lines.length === 0) return [text];
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, maxLines);
  let last = kept[maxLines - 1]!;
  while (last.length > 1 && estimateTextWidth(`${last}…`, fontSize) > maxWidth) last = last.slice(0, -1);
  kept[maxLines - 1] = `${last}…`;
  return kept;
}

function rectFor(center: { x: number; y: number }, width: number, height: number): Rect {
  return { x: center.x - width / 2, y: center.y - height / 2, width, height };
}

export function overlaps(
  left: Rect,
  right: Rect,
  gap = 0,
): boolean {
  return !(
    left.x + left.width + gap <= right.x ||
    right.x + right.width + gap <= left.x ||
    left.y + left.height + gap <= right.y ||
    right.y + right.height + gap <= left.y
  );
}

function clipToNodeBoundary(
  from: NodeLayout,
  to: NodeLayout,
): { start: { x: number; y: number }; end: { x: number; y: number }; normal: { x: number; y: number } } {
  const dx = to.center.x - from.center.x;
  const dy = to.center.y - from.center.y;
  const length = Math.hypot(dx, dy) || 1;
  const nx = dx / length;
  const ny = dy / length;
  const startT = Math.min(
    Math.abs(nx) < 1e-6 ? Number.POSITIVE_INFINITY : (from.width / 2 + 10) / Math.abs(nx),
    Math.abs(ny) < 1e-6 ? Number.POSITIVE_INFINITY : (from.height / 2 + 10) / Math.abs(ny),
  );
  const endT = Math.min(
    Math.abs(nx) < 1e-6 ? Number.POSITIVE_INFINITY : (to.width / 2 + 12) / Math.abs(nx),
    Math.abs(ny) < 1e-6 ? Number.POSITIVE_INFINITY : (to.height / 2 + 12) / Math.abs(ny),
  );
  return {
    start: { x: from.center.x + nx * startT, y: from.center.y + ny * startT },
    end: { x: to.center.x - nx * endT, y: to.center.y - ny * endT },
    normal: { x: -ny, y: nx },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export function layoutRelationshipGraph(
  people: GraphPerson[],
  relationships: GraphRelationship[],
  options: { width?: number; height?: number; padding?: number } = {},
): GraphLayout {
  const width = options.width ?? 860;
  const height = options.height ?? 580;
  const padding = options.padding ?? 36;
  const ordered = [...people].sort((left, right) => left.entity_id.localeCompare(right.entity_id));
  const nodes: NodeLayout[] = ordered.map((person) => {
    const nameLines = wrapGraphText(person.name, 160, 15, 3);
    const aliasLines = person.aliases.length > 0
      ? wrapGraphText(person.aliases.join(' / '), 155, 10.5, 2)
      : [];
    const nameWidth = Math.max(...nameLines.map((line) => estimateTextWidth(line, 15)), 36);
    const aliasWidth = aliasLines.length > 0 ? Math.max(...aliasLines.map((line) => estimateTextWidth(line, 10.5))) : 0;
    const nodeWidth = Math.min(210, Math.max(100, Math.max(nameWidth, aliasWidth) + 30));
    const nodeHeight = 22 + nameLines.length * 19 + (aliasLines.length > 0 ? 6 + aliasLines.length * 13 : 0);
    return {
      id: person.entity_id,
      name: person.name,
      aliases: person.aliases,
      center: { x: width / 2, y: height / 2 },
      width: nodeWidth,
      height: nodeHeight,
      nameLines,
      aliasLines,
      rect: rectFor({ x: width / 2, y: height / 2 }, nodeWidth, nodeHeight),
    };
  });

  const maxNodeWidth = Math.max(...nodes.map((node) => node.width), 96);
  const maxNodeHeight = Math.max(...nodes.map((node) => node.height), 50);
  const center = { x: width / 2, y: height / 2 + 2 };
  let radiusX = Math.max(100, Math.min(width / 2 - maxNodeWidth / 2 - padding, 310));
  let radiusY = Math.max(78, Math.min(height / 2 - maxNodeHeight / 2 - padding, 174));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    nodes.forEach((node, index) => {
      const angle = (Math.PI * 2 * index) / Math.max(1, nodes.length) - Math.PI / 2;
      node.center = {
        x: center.x + Math.cos(angle) * radiusX,
        y: center.y + Math.sin(angle) * radiusY,
      };
      node.rect = rectFor(node.center, node.width, node.height);
    });
    let collision = false;
    for (let left = 0; left < nodes.length; left += 1) {
      for (let right = left + 1; right < nodes.length; right += 1) {
        if (overlaps(nodes[left]!.rect, nodes[right]!.rect, 8)) collision = true;
      }
    }
    if (!collision) break;
    radiusX = Math.min(radiusX + 10, width / 2 - maxNodeWidth / 2 - padding);
    radiusY = Math.min(radiusY + 6, height / 2 - maxNodeHeight / 2 - padding);
  }

  const byId = new Map(nodes.map((node) => [node.id, node]));
  const labels: Rect[] = [];
  const edges: EdgeLayout[] = [];
  for (const relationship of relationships) {
    const from = byId.get(relationship.from_entity_id);
    const to = byId.get(relationship.to_entity_id);
    if (!from || !to) continue;
    const line = clipToNodeBoundary(from, to);
    const labelLines = wrapGraphText(relationship.kind, 158, 12, 2);
    const labelWidth = Math.min(190, Math.max(...labelLines.map((line) => estimateTextWidth(line, 12)), 44) + 20);
    const labelHeight = labelLines.length * 15 + 12;
    const normal = line.normal;
    const dx = to.center.x - from.center.x;
    const dy = to.center.y - from.center.y;
    const candidates: { x: number; y: number; rect: Rect }[] = [];
    for (const t of [0.5, 0.38, 0.62, 0.28, 0.72]) {
      for (const side of [1, -1]) {
        const base = { x: from.center.x + dx * t, y: from.center.y + dy * t };
        const offset = labelHeight / 2 + 13;
        const x = clamp(base.x + normal.x * side * offset, padding + labelWidth / 2, width - padding - labelWidth / 2);
        const y = clamp(base.y + normal.y * side * offset, padding + labelHeight / 2, height - padding - labelHeight / 2);
        candidates.push({ x, y, rect: rectFor({ x, y }, labelWidth, labelHeight) });
      }
    }
    let chosen = candidates[0]!;
    let chosenScore = Number.POSITIVE_INFINITY;
    for (const candidate of candidates) {
      let score = 0;
      for (const node of nodes) if (overlaps(candidate.rect, node.rect, 5)) score += 100;
      for (const previous of labels) if (overlaps(candidate.rect, previous, 6)) score += 30;
      score += Math.abs(candidate.y - (from.center.y + dy * 0.5)) * 0.05;
      if (score < chosenScore) {
        chosen = candidate;
        chosenScore = score;
      }
    }
    labels.push(chosen.rect);
    const anchorOffsets = [
      { x: labelWidth / 2 + 10, y: 0 },
      { x: -labelWidth / 2 - 10, y: 0 },
      { x: 0, y: labelHeight / 2 + 10 },
      { x: 0, y: -labelHeight / 2 - 10 },
    ];
    const anchorCandidates = anchorOffsets.map((offset) => ({
      x: clamp(chosen.x + offset.x, padding + 7, width - padding - 7),
      y: clamp(chosen.y + offset.y, padding + 7, height - padding - 7),
    }));
    let anchor = anchorCandidates[0]!;
    for (const candidate of anchorCandidates) {
      const anchorRect = { x: candidate.x - 7, y: candidate.y - 7, width: 14, height: 14 };
      const collides = labels.some((label) => overlaps(anchorRect, label, 2))
        || nodes.some((node) => overlaps(anchorRect, node.rect, 2));
      if (!collides) {
        anchor = candidate;
        break;
      }
    }
    edges.push({
      id: relationship.relationship_id,
      from: relationship.from_entity_id,
      to: relationship.to_entity_id,
      kind: relationship.kind,
      disputed: relationship.status !== 'author-confirmed',
      anchorId: relationship.evidence_anchor_ids[0],
      start: line.start,
      end: line.end,
      label: { x: chosen.x, y: chosen.y, width: labelWidth, height: labelHeight, lines: labelLines },
      labelRect: chosen.rect,
      anchor,
    });
  }
  return { width, height, padding, nodes, edges };
}
