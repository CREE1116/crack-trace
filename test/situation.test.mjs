// Extractive recent-scene memo ("직전 상황").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../extension/engine/engine.js', import.meta.url), 'utf8');
const engine = vm.runInNewContext(`${code}\nCrackMatrixEngine`);

const history = [
  { id: '1', role: 'assistant', text: '마을 광장은 조용했다. 사람들은 평소처럼 장을 보고 있었다.' },
  { id: '2', role: 'user', text: '광장을 둘러본다.' },
  { id: '3', role: 'assistant', text: '사람들은 평소처럼 장을 보고 있었다. 그때 은빛열쇠를 쥔 세린이 북쪽 탑으로 달려갔다.' },
  { id: '4', role: 'user', text: '세린을 따라 북쪽 탑으로 간다.' }
];
const units = engine.unitsFromMessages(
  history.concat(Array.from({ length: 20 }, (_, i) => ({ id: `f${i}`, role: 'assistant', text: '사람들은 평소처럼 장을 보고 있었다. 마을은 평소처럼 조용했고 사람들은 장을 보고 있었다.' }))),
  'c', 10, 220);
const ix = engine.index(units);

test('keeps the informative sentence and drops routine ones', () => {
  const memo = engine.recentSituationExtract(history, ix, 60);
  assert.ok(memo.includes('은빛열쇠'), memo);
  assert.ok(!memo.includes('장을 보고'), memo);
});

test('respects the character budget and original order', () => {
  const memo = engine.recentSituationExtract(history, ix, 200);
  assert.ok(memo.length <= 200);
  const a = memo.indexOf('은빛열쇠'), b = memo.indexOf('세린을 따라');
  assert.ok(a !== -1 && b !== -1 && a < b, memo);
});

test('empty input gives an empty memo', () => {
  assert.equal(engine.recentSituationExtract([], ix, 200), '');
});
