import { describe, expect, it } from 'vitest';
import {
  layoutRelationshipGraph,
  overlaps,
  wrapGraphText,
  type GraphPerson,
  type GraphRelationship,
} from '../../apps/studio/src/graphLayout.js';

const people: GraphPerson[] = [
  { entity_id: 'ent_atang01', name: '阿棠', aliases: ['棠儿'] },
  { entity_id: 'ent_gu01', name: '顾先生', aliases: ['顾某'] },
  { entity_id: 'ent_linyan01', name: '林砚', aliases: ['阿砚', '小砚'] },
  { entity_id: 'ent_luopo01', name: '罗婆婆', aliases: ['罗婆'] },
  { entity_id: 'ent_shenzhou01', name: '沈舟', aliases: ['舟哥', '阿舟'] },
  { entity_id: 'ent_xiaoman01', name: '小满（女孩）', aliases: ['小满'] },
  { entity_id: 'ent_xiaoman02', name: '小满（老船工）', aliases: ['小满', '老小满', '小满叔'] },
];

const relationships: GraphRelationship[] = [
  { relationship_id: 'rel_a', from_entity_id: 'ent_linyan01', to_entity_id: 'ent_luopo01', kind: '祖母与孙女', status: 'author-confirmed', evidence_anchor_ids: ['anc_a'] },
  { relationship_id: 'rel_b', from_entity_id: 'ent_linyan01', to_entity_id: 'ent_shenzhou01', kind: '旧友', status: 'author-confirmed', evidence_anchor_ids: ['anc_b'] },
  { relationship_id: 'rel_c', from_entity_id: 'ent_xiaoman01', to_entity_id: 'ent_linyan01', kind: '邻居', status: 'author-confirmed', evidence_anchor_ids: ['anc_c'] },
  { relationship_id: 'rel_d', from_entity_id: 'ent_xiaoman02', to_entity_id: 'ent_shenzhou01', kind: '师徒', status: 'author-confirmed', evidence_anchor_ids: ['anc_d'] },
  { relationship_id: 'rel_e', from_entity_id: 'ent_gu01', to_entity_id: 'ent_linyan01', kind: '临时雇佣（北堤夜班）', status: 'author-confirmed', evidence_anchor_ids: ['anc_e'] },
];

function expectSafe(layout: ReturnType<typeof layoutRelationshipGraph>): void {
  const { width, height } = layout;
  for (const node of layout.nodes) {
    expect(node.rect.x).toBeGreaterThanOrEqual(0);
    expect(node.rect.y).toBeGreaterThanOrEqual(0);
    expect(node.rect.x + node.rect.width).toBeLessThanOrEqual(width);
    expect(node.rect.y + node.rect.height).toBeLessThanOrEqual(height);
  }
  for (let left = 0; left < layout.nodes.length; left += 1) {
    for (let right = left + 1; right < layout.nodes.length; right += 1) {
      expect(overlaps(layout.nodes[left]!.rect, layout.nodes[right]!.rect, 4)).toBe(false);
    }
  }
  for (let left = 0; left < layout.edges.length; left += 1) {
    const edge = layout.edges[left]!;
    expect(edge.labelRect.x).toBeGreaterThanOrEqual(0);
    expect(edge.labelRect.y).toBeGreaterThanOrEqual(0);
    expect(edge.labelRect.x + edge.labelRect.width).toBeLessThanOrEqual(width);
    expect(edge.labelRect.y + edge.labelRect.height).toBeLessThanOrEqual(height);
    expect(edge.anchor.x).toBeGreaterThanOrEqual(0);
    expect(edge.anchor.x).toBeLessThanOrEqual(width);
    expect(edge.anchor.y).toBeGreaterThanOrEqual(0);
    expect(edge.anchor.y).toBeLessThanOrEqual(height);
    for (const node of layout.nodes) {
      expect(overlaps(edge.labelRect, node.rect, 2)).toBe(false);
    }
    for (let right = left + 1; right < layout.edges.length; right += 1) {
      expect(overlaps(edge.labelRect, layout.edges[right]!.labelRect, 3)).toBe(false);
    }
  }
}

describe('Gate 2 relationship graph geometry', () => {
  it('fits the current sample without node or label clipping', () => {
    const layout = layoutRelationshipGraph(people, relationships);
    expectSafe(layout);
    expect(layout.nodes).toHaveLength(7);
    expect(layout.edges).toHaveLength(5);
    const oldXiaoman = layout.nodes.find((node) => node.id === 'ent_xiaoman02')!;
    expect(oldXiaoman.nameLines.join('')).toBe('小满（老船工）');
    const tempLabel = layout.edges.find((edge) => edge.id === 'rel_e')!;
    expect(tempLabel.label.lines.join('')).toContain('北堤夜班');
  });

  it('keeps a denser synthetic scene bounded and collision-free', () => {
    const densePeople: GraphPerson[] = [
      ...people,
      { entity_id: 'ent_linyan02', name: '林砚（少年时期）', aliases: ['少年阿砚', '小砚'] },
      { entity_id: 'ent_unknown03', name: '北堤守灯人', aliases: ['守灯人'] },
    ];
    const denseRelationships: GraphRelationship[] = [
      ...relationships,
      { relationship_id: 'rel_f', from_entity_id: 'ent_linyan02', to_entity_id: 'ent_luopo01', kind: '祖孙（少年时期）', status: 'author-confirmed', evidence_anchor_ids: [] },
      { relationship_id: 'rel_g', from_entity_id: 'ent_unknown03', to_entity_id: 'ent_shenzhou01', kind: '旧识 / 灯塔看守', status: 'disputed', evidence_anchor_ids: [] },
      { relationship_id: 'rel_h', from_entity_id: 'ent_unknown03', to_entity_id: 'ent_gu01', kind: '买卖关系', status: 'author-confirmed', evidence_anchor_ids: [] },
      { relationship_id: 'rel_i', from_entity_id: 'ent_linyan02', to_entity_id: 'ent_atang01', kind: '同乡', status: 'author-confirmed', evidence_anchor_ids: [] },
    ];
    const layout = layoutRelationshipGraph(densePeople, denseRelationships);
    expectSafe(layout);
    expect(layout.nodes).toHaveLength(9);
    expect(layout.edges).toHaveLength(9);
    expect(new Set(layout.edges.map((edge) => edge.kind)).size).toBe(9);
  });

  it('is deterministic and wraps long labels without losing the full node name', () => {
    const first = layoutRelationshipGraph(people, relationships);
    const second = layoutRelationshipGraph(people, relationships);
    expect(second).toEqual(first);
    expect(wrapGraphText('一个很长的人物名称用于布局验证', 120, 13, 3).join('')).toBe('一个很长的人物名称用于布局验证');
  });
});
