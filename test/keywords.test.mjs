// Speaker detection and keyword exclusion in the evolution graph.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../extension/engine/engine.js', import.meta.url), 'utf8');
const E = vm.runInNewContext(`${code}\nCrackMatrixEngine`);

const win = [
  { id: '1', role: 'assistant', text: '⚠ SYSTEM : 결투가 시작됩니다.\n세린 : 준비됐어. 은빛열쇠는 내가 지킬게.' },
  { id: '2', role: 'user', text: '세린에게 은빛열쇠를 맡긴다.' },
  { id: '3', role: 'assistant', text: '▶ INFO | 체력 100\n세린 : 좋아, 북쪽 탑으로 가자.' },
  { id: '4', role: 'user', text: '북쪽 탑으로 향한다.' }
];

test('system labels are not characters', () => {
  const g = E.stepSlidingWindowGraph(E.createEvolutionGraph(), win, 1, 4);
  const speakers = g.nodes.filter(n => n.role === 'speaker').map(n => n.keyword);
  assert.ok(speakers.includes('세린'), JSON.stringify(speakers));
  assert.ok(!speakers.some(k => /SYSTEM|INFO/i.test(k)), JSON.stringify(speakers));
});

test('excluded keywords are not extracted again', () => {
  const g = E.stepSlidingWindowGraph(E.createEvolutionGraph(), win, 1, 4, { dropKeywords: ['세린'] });
  assert.ok(!g.nodes.some(n => n.keyword === '세린'));
});

test('dropping a keyword removes its nodes and their edges', () => {
  let g = E.stepSlidingWindowGraph(E.createEvolutionGraph(), win, 1, 4);
  g = E.stepSlidingWindowGraph(g, win, 5, 8);
  const ids = new Set(g.nodes.filter(n => n.keyword === '세린').map(n => n.id));
  assert.ok(ids.size >= 2);
  g = E.dropKeywords(g, ['세린']);
  assert.ok(!g.nodes.some(n => n.keyword === '세린'));
  assert.ok(!g.edges.some(e => ids.has(e.from) || ids.has(e.to)));
});
