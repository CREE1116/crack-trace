import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
const engine = vm.runInNewContext(`${code}\nCrackMemoryEngine`);

test('Korean inflections share character bigrams', () => {
  assert.ok(engine.terms('은빛열쇠를').includes('은빛'));
  assert.ok(engine.terms('은빛열쇠').includes('은빛'));
});

test('repeated INFO panel and image URLs do not become memories', () => {
  const text = '서재에서 열쇠를 찾았다.\n```INFO\n희귀한상태표 낡은관계표\n```\n![](https://example.invalid/image.png)';
  const clean = engine.searchText(text);
  assert.ok(clean.includes('서재에서 열쇠를 찾았다'));
  assert.ok(!clean.includes('희귀한상태표'));
  assert.ok(!clean.includes('example.invalid'));
  assert.equal(engine.searchText('[💼] 장비\n[🤝 주요 관계 인물]\n[📝 기록]'), '');
});

test('search display groups repeated passages from one message', () => {
  const hits = [{ messageId: '1' }, { messageId: '1' }, { messageId: '2' }];
  assert.deepEqual(Array.from(engine.groupByMessage(hits), hit => hit.messageId), ['1', '2']);
});

test('broad source context fits before unchanged user input and can be stripped for reindexing', () => {
  const messages = [
    { id: 'old', role: 'assistant', text: '💬 미나 | 은빛열쇠를 서재 상자에 숨겼어.' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: 'user', text: `다른 장면 ${i}` })),
  ];
  const ix = engine.index(engine.unitsFromMessages(messages, 'room'));
  const input = '미나가 전에 은빛열쇠를 어디에 숨겼어?';
  const picked = engine.contextFor(ix, messages, input, { maxOrder: 10, budget: engine.userContextBudget(input) });
  assert.equal(picked.selected[0]?.messageId, 'old');
  const composed = engine.composeUser(input, picked.selected);
  assert.ok(composed.length <= 2000);
  assert.ok(composed.endsWith(input));
  assert.ok(composed.includes('은빛열쇠'));
  const cache = JSON.parse(composed.match(/\{"memory_cache":\[[^\n]*\]\}/)?.[0] || '{}');
  assert.equal(cache.memory_cache[0].message_id, 'old');
  assert.equal(cache.memory_cache[0].kind, 'message_start');
  assert.ok(composed.includes('RP 장면·대사·행동이 아니며'));
  assert.equal(engine.stripOwnBlock(composed), input);
  assert.equal(engine.composeUser(input, picked.selected, input.length + 1), input);
});

test('spare input budget adds matched units from beyond a long message opening', () => {
  const messages = [{ id: 'old', role: 'assistant', text: `${'무관한 서론. '.repeat(100)}은빛열쇠는 "서재"에 있다.` }];
  const ix = engine.index(engine.unitsFromMessages(messages, 'room'));
  const input = '은빛열쇠는 어디 있어?';
  const result = engine.contextFor(ix, messages, input, { budget: engine.userContextBudget(input) });
  const composed = engine.composeUser(input, result.selected);
  const cache = JSON.parse(composed.match(/\{"memory_cache":\[[^\n]*\]\}/)?.[0] || '{}');
  assert.equal(cache.memory_cache[0].kind, 'message_start');
  assert.ok(cache.memory_cache.some(unit => unit.kind === 'matched_unit' && unit.excerpt.includes('은빛열쇠는 "서재"')));
  assert.ok(composed.length <= 2000);
});

test('short follow-up borrows only shared rare topic words from the latest exchange', () => {
  const messages = [
    { id: 'old', role: 'assistant', text: '은빛열쇠를 서재 상자에 숨겼다.' },
    ...Array.from({ length: 30 }, (_, i) => ({ id: String(i), role: 'user', text: `다른 장면 ${i}` })),
    { id: 'recent-user', role: 'user', text: '은빛열쇠가 아직 있어?' },
    { id: 'recent-ai', role: 'assistant', text: '은빛열쇠는 아직 있어.' },
  ];
  const ix = engine.index(engine.unitsFromMessages(messages, 'room'));
  const query = engine.contextQuery(ix, messages, '그건 어디 있어?');
  assert.ok(query.includes('은빛열쇠'));
  const result = engine.contextFor(ix, messages, query, { maxOrder: messages.length - 20, budget: engine.userContextBudget('그건 어디 있어?') });
  assert.equal(result.selected[0]?.messageId, 'old');
  assert.equal(engine.contextQuery(ix, messages, '은빛열쇠를 누가 서재 상자에 숨겼어?'), '은빛열쇠를 누가 서재 상자에 숨겼어?');
  assert.equal(engine.contextQuery(ix, messages, '그건 어디 있어?'.repeat(10)), '그건 어디 있어?'.repeat(10));
});

test('send frame rewrite changes only the outgoing message and preserves socket framing', () => {
  const original = '42/v3/chats,12["send",{"chatId":"r","message":"원문","model":"x"}]';
  const changed = engine.replaceFrameMessage(original, '문맥\n원문');
  assert.equal(changed, '42/v3/chats,12["send",{"chatId":"r","message":"문맥\\n원문","model":"x"}]');
  assert.equal(engine.replaceFrameMessage('42["reroll",{"chatId":"r"}]', 'x'), null);
});

test('old messages are retrievable with source and recent messages excluded', () => {
  const messages = [
    { id: '1', role: 'user', text: '은빛열쇠를 서재의 상자에 숨겼다.' },
    { id: '2', role: 'assistant', text: '상자는 잠겼다.' },
    { id: '3', role: 'user', text: '오늘은 다른 이야기를 하자.' },
    { id: '4', role: 'assistant', text: '좋아.' },
    { id: '5', role: 'user', text: '이제 서재에서 은빛열쇠를 찾자.' },
    { id: '6', role: 'assistant', text: '서재로 향한다.' },
  ];
  const ix = engine.index(engine.unitsFromMessages(messages, 'room'));
  const ranked = engine.search(ix, '서재 은빛열쇠', { maxOrder: 4 });
  assert.equal(ranked[0].messageId, '1');
  assert.equal(ranked[0].role, 'user');
  assert.equal(ranked.some(x => x.messageId === '5'), false);
  assert.equal(engine.choose(ix, '서재 은빛열쇠', { maxOrder: 4 }).selected.length, 0); // Too little history for automatic injection.
});

test('explicit recall with named speaker and two event anchors selects old evidence', () => {
  const messages = [{ id: '1', role: 'assistant', text: '💬 미나 | 은빛열쇠를 서재 상자에 숨겼어.' }];
  for (let i = 2; i <= 32; i++) messages.push({ id: String(i), role: i % 2 ? 'assistant' : 'user', text: `다른 장소의 일상 장면 ${i}` });
  const ix = engine.index(engine.unitsFromMessages(messages, 'room'));
  const query = '미나가 전에 은빛열쇠를 어디에 숨겼어?';
  const result = engine.choose(ix, query, { maxOrder: 10, anchorText: query });
  assert.equal(result.selected[0]?.messageId, '1');
});

test('weak generic query does not inject and own block is removed on rerun', () => {
  const ix = engine.index(engine.unitsFromMessages([{ id: '1', role: 'user', text: '문을 열었다.' }], 'room'));
  assert.equal(engine.choose(ix, '문').selected.length, 0);
  assert.equal(engine.contextFor(ix, [{ id: '1', role: 'user', text: '문을 열었다.' }], '문', { budget: 1000 }).selected.length, 0);
  const selected = [{ line: '[과거 사용자 대화]\n은빛 열쇠\n' }];
  const once = engine.compose('기존 대사', selected);
  const twice = engine.compose(once, selected);
  assert.equal(once, twice);
  assert.equal(engine.compose(once, []), '기존 대사');
});

test('search and selection order is stable', () => {
  const units = [
    { id: 'b', messageId: 'b', chatId: 'r', role: 'user', order: 0, text: '은빛열쇠 서재' },
    { id: 'a', messageId: 'a', chatId: 'r', role: 'user', order: 0, text: '은빛열쇠 서재' },
  ];
  const result = engine.search(engine.index(units), '은빛열쇠 서재');
  assert.deepEqual(Array.from(result, x => x.id), ['a', 'b']);
});

test('long reply is indexed through its end', () => {
  const units = engine.unitsFromMessages([{ id: 'long', role: 'assistant', text: `${'가'.repeat(1500)} 은빛열쇠 서재` }], 'room');
  assert.ok(units.length > 1);
  assert.ok(units.at(-1).text.includes('은빛열쇠 서재'));
});

test('carrier crosses the newest user boundary and skips reroll versions', () => {
  const messages = [
    { id: 'a1', role: 'assistant', status: 'end' },
    { id: 'u1', role: 'user' },
    { id: 'a2', role: 'assistant', status: 'end' },
    { id: 'a2-reroll', role: 'assistant', status: 'end' },
  ];
  assert.equal(engine.carrier(messages).id, 'a1');
  assert.throws(() => engine.carrier([...messages, { id: 'u2', role: 'user' }]));
});

test('only expected Socket.IO send events are intercepted', () => {
  assert.equal(engine.parseFrame('42["send",{"chatId":"r","message":"hi"}]').kind, 'send');
  assert.equal(engine.parseFrame('42/v3/chats,["reroll",{"chatId":"r"}]').kind, 'reroll');
  assert.equal(engine.parseFrame('42["typing",{}]'), null);
  assert.equal(engine.parseFrame('not socket.io'), null);
});
