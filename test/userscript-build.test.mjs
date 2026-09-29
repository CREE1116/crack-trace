import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import engine from '../extension/engine/engine.js';

const built = readFileSync(new URL('../dist/trace-lite.user.js', import.meta.url), 'utf8');
const sharedEngine = readFileSync(new URL('../extension/engine/engine.js', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('../src/userscript.js', import.meta.url), 'utf8');

test('Trace Lite ships the shared engine and current userscript', () => {
  assert.match(built, /\/\/ @version\s+0\.8\.0/);
  assert.ok(built.includes(sharedEngine));
  assert.ok(built.endsWith(runtime));
  assert.ok(!runtime.includes('contextWithLore'));
  assert.ok(runtime.includes('E.buildPassageIndex'));
  assert.ok(runtime.includes('E.MARKERS'));
});

test('shared engine retrieves an old passage and hides both generations of markers', () => {
  const messages = Array.from({ length: 16 }, (_, index) => ({
    id: `m${index}`,
    role: index % 2 ? 'assistant' : 'user',
    text: index === 3
      ? '서린｜"은빛 열쇠는 오래된 시계탑 지하 서랍에 보관해 두었어요."'
      : `서린은 ${index}번째 복도를 지나갔다. 창밖에는 비가 내리고 있었다.`
  }));
  const index = engine.buildPassageIndex(messages);
  const found = engine.passageSearch(index, '서린의 은빛 열쇠는 어디에 있지?', {
    budget: 1200,
    maxTurn: messages.length - 1
  });
  assert.ok(found.some(item => item.turn === 4 && item.content.includes('시계탑 지하 서랍')));
  const outgoing = engine.composeUser('은빛 열쇠를 찾는다', found, 2000, 17);
  assert.match(outgoing, /<!--TRACE-->/);
  assert.equal(engine.stripOwnBlock(outgoing), '은빛 열쇠를 찾는다');
  assert.equal(engine.stripOwnBlock('<!--CRACK_UBIS_CONTEXT_START-->옛 캐시<!--CRACK_UBIS_CONTEXT_END-->\n안녕'), '안녕');
});
