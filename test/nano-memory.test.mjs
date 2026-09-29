import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const engine = require('../extension/engine/engine.js');
const code = readFileSync(new URL('../extension/background/service-worker.js', import.meta.url), 'utf8');

function workerHarness() {
  const data = new Map([['llmIntervention', true]]);
  let prompts = 0;
  let messageListener;
  const storage = {
    get(keys, callback) {
      const names = keys === null ? [...data.keys()] : Array.isArray(keys) ? keys : [keys];
      const result = Object.fromEntries(names.filter(key => data.has(key)).map(key => [key, data.get(key)]));
      if (callback) callback(result);
      return Promise.resolve(result);
    },
    set(values, callback) {
      for (const [key, value] of Object.entries(values)) data.set(key, value);
      callback?.();
      return Promise.resolve();
    },
    remove(keys, callback) {
      for (const key of Array.isArray(keys) ? keys : [keys]) data.delete(key);
      callback?.();
      return Promise.resolve();
    },
    getBytesInUse(_keys, callback) { callback(0); }
  };
  const chrome = {
    sidePanel: { setPanelBehavior: () => Promise.resolve() },
    runtime: {
      onMessage: { addListener(listener) { messageListener = listener; } },
      getContexts: async () => [{ contextType: 'SIDE_PANEL' }],
      sendMessage: async () => {
        prompts++;
        return { success: true, text: JSON.stringify([{ keyword: '엘레노어', fact: prompts === 1
          ? '엘레노어가 은빛 열쇠를 맡았다.' : '엘레노어가 은빛 열쇠를 돌려주었다.' }]) };
      }
    },
    storage: { local: storage },
    tabs: { query(_options, callback) { callback([]); } },
    alarms: { create() {}, onAlarm: { addListener() {} } }
  };
  const context = vm.createContext({ chrome, CrackMatrixEngine: engine, importScripts() {}, setTimeout, clearTimeout, console });
  vm.runInContext(code, context);
  const dispatch = message => new Promise(resolve => messageListener(message, {}, resolve));
  return { data, context, dispatch, promptCount: () => prompts };
}

test('Nano reads completed assistant turns once and retrieves distinct microfacts', async () => {
  const { data, context, promptCount } = workerHarness();
  data.set('nanoBatchSize', 1);
  const messages = [
    { id: 'u1', role: 'user', text: '엘레노어에게 열쇠를 맡긴다.' },
    { id: 'a1', role: 'assistant', text: '엘레노어가 은빛 열쇠를 맡았다.' },
    { id: 'u2', role: 'user', text: '열쇠를 돌려달라고 한다.' },
    { id: 'a2', role: 'assistant', text: '엘레노어가 은빛 열쇠를 돌려주었다.' }
  ];
  const progress = [];
  const process = vm.runInContext('processNanoMemory', context);
  const result = await process('room', messages, (_stage, done, total) => progress.push([done, total]));
  assert.equal(result.complete, true);
  assert.equal(promptCount(), 2);
  assert.equal(data.get('nanoMemory:room').lastId, 'a2');
  assert.deepEqual(progress, [[0, 2], [1, 2], [2, 2]]);
  await process('room', messages, () => {});
  assert.equal(promptCount(), 2);
  const cards = vm.runInContext('nanoMemoryCards', context)('room', data.get('nanoMemory:room').facts, '엘레노어');
  assert.equal(cards.length, 2);
  assert.ok(cards.some(card => /맡았다/.test(card.content)));
  assert.ok(cards.some(card => /돌려주었다/.test(card.content)));
});

test('Nano facts keep only valid source turns; recent turns stay out of injection', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const facts = parse(JSON.stringify([
    { turn: 3, keyword: '서린', domain: '인물', fact: '서린은 크리와 내일 작전을 논의하기로 했다.' },
    { turn: 999, keyword: '거점', domain: '가짜', fact: '거점으로 돌아왔다.' }
  ]), 8, 'batch', 16, [3, 8], new Map([['거점', '장소']]));
  assert.equal(facts[0].turn, 3);
  assert.equal(facts[0].domain, '인물');
  assert.equal(facts.length, 1);
  const cutoff = vm.runInContext('recentMemoryCutoff', context)([
    { role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' },
    { role: 'user' }, { role: 'assistant' }, { role: 'user' }, { role: 'assistant' },
    { role: 'user' }, { role: 'assistant' }
  ]);
  assert.equal(cutoff, 4);
  const cards = vm.runInContext('nanoMemoryCards', context)('room', facts, '서린 거점', cutoff);
  assert.equal(cards.length, 1);
  assert.match(cards[0].content, /내일 작전/);
});

test('one assistant reply can retain several independently retrievable facts', async () => {
  const { data, context } = workerHarness();
  data.set('nanoBatchSize', 1);
  context.chrome.runtime.sendMessage = async () => ({ success: true, text: JSON.stringify([
    { turn: 2, keyword: '크리', domain: '인물', fact: '크리가 S급으로 승진했다.' },
    { turn: 2, keyword: '특무 임무', domain: '사건/약조', fact: '크리가 C구역에서 하운드를 격파해 특무 임무를 완수했다.' },
    { turn: 2, keyword: '준영', domain: '인물', fact: '준영은 발목 부상으로 이동이 어렵다.' }
  ]) });
  const messages = [
    { id: 'u1', role: 'user', text: '크리의 임무와 준영의 상태를 묻는다.' },
    { id: 'a1', role: 'assistant', text: '크리가 C구역 하운드를 격파해 특무 임무를 완수하고 S급으로 승진했다. 준영은 발목을 다쳐 걷기 어렵다.' }
  ];
  const result = await vm.runInContext('processNanoMemory', context)('room', messages, () => {}, { force: true });
  assert.equal(result.complete, true);
  const facts = data.get('nanoMemory:room').facts;
  assert.equal(facts.length, 3);
  assert.ok(facts.every(fact => fact.turn === 2));
  const cards = vm.runInContext('nanoMemoryCards', context)('room', facts, '크리 특무 임무');
  assert.ok(cards.some(card => card.title.includes('크리')));
  assert.ok(cards.some(card => card.title.includes('특무 임무')));
});

test('Nano source gate rejects misspelled names, invented turn numbers and analysis text', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const source = [
    { turn: 1, text: '크리가 준영을 도왔다.' },
    { turn: 2, text: '하나가 준영에게 물을 건넸다.' },
    { turn: 3, text: '준영은 물을 마시고 발목을 살폈다.' }
  ];
  const facts = parse(JSON.stringify([
    { turn: 2, keyword: '하나', domain: '인물', fact: '하나가 준영에게 물을 건넸다.' },
    { turn: 2, keyword: '하하나', domain: '인물', fact: '하나가 물을 건넸다.' },
    { turn: 2, keyword: '존영', domain: '인물', fact: '준영이 물을 받았다.' },
    { turn: 99, keyword: '준영', domain: '인물', fact: '준영이 물을 마셨다.' },
    { turn: 3, keyword: '준영', domain: '인물', fact: '로컬 NLP/LSA 분석으로 상황을 파악했다.' },
    { turn: 3, keyword: '준영', domain: '가짜', fact: '준영은 발목을 살폈다.' },
    { turn: 3, keyword: '준영', domain: '가짜', fact: '준영은 발목을 살폈다.' }
  ]), 3, 'batch', 16, [2, 3], new Map([['준영', '인물']]), source);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].keyword, '하나');
  assert.equal(facts[1].domain, '인물');
});

test('edited, disabled, deleted and excluded Nano facts affect retrieval without rewriting generated history', async () => {
  const { data, context, dispatch } = workerHarness();
  const facts = [
    { id: 'a1:0', keyword: '크리', fact: '크리는 S급으로 승진했다.', turn: 2 },
    { id: 'a1:1', keyword: '준영', fact: '준영은 다친 발목 때문에 걷기 어렵다.', turn: 2 },
    { id: 'a1:2', keyword: 'PX', fact: 'PX에서 컵라면을 팔았다.', turn: 2 }
  ];
  data.set('nanoMemory:room', { lastId: 'a1', facts });
  assert.equal((await dispatch({ type: 'GET_KEYWORD_REVIEW', chatId: 'room' })).keywords.length, 3);
  assert.equal((await dispatch({ type: 'UPDATE_NANO_FACT', chatId: 'room', factId: 'a1:0', patch: {
    keyword: '승진', domain: '사건/약조', fact: '크리의 S급 승진은 대위급 이상에 해당한다.'
  } })).success, true);
  assert.equal((await dispatch({ type: 'UPDATE_NANO_FACT', chatId: 'room', factId: 'a1:1', patch: { enabled: false } })).success, true);
  assert.equal((await dispatch({ type: 'UPDATE_NANO_FACT', chatId: 'room', factId: 'a1:2', delete: true })).success, true);
  const visible = (await dispatch({ type: 'GET_NANO_FACTS', chatId: 'room' })).facts;
  assert.equal(visible.length, 2);
  assert.equal(visible[0].keyword, '승진');
  assert.equal(visible[0].domain, '사건/약조');
  assert.equal(visible[1].enabled, false);
  const cards = vm.runInContext('nanoMemoryCards', context)('room', visible, '크리 준영');
  assert.equal(cards.some(card => card.title === '준영'), false);
  assert.equal((await dispatch({ type: 'DROP_KEYWORD', chatId: 'room', keyword: '승진' })).success, true);
  assert.equal((await dispatch({ type: 'GET_NANO_FACTS', chatId: 'room' })).facts.length, 1);
  assert.equal(data.get('nanoMemory:room').facts.length, 3);
});

test('extension prompt renders readable cache lines and uses spare space for related facts', () => {
  const facts = Array.from({ length: 14 }, (_, index) => ({
    id: `a${index}:0`, keyword: `엘레노어${index}`, turn: index + 1,
    fact: `엘레노어${index}는 크리와 관련된 ${index}번째 중요한 약속을 기억한다.`
  }));
  const { context } = workerHarness();
  const cards = vm.runInContext('nanoMemoryCards', context)('room', facts, '엘레노어 크리');
  const selected = engine.contextWithAll(null, [], '엘레노어에 대해 말해줘.', { summaryCards: cards, budget: 2000 }).selected;
  const prompt = engine.composeUser('엘레노어에 대해 말해줘.', selected, 2000);
  assert.ok(cards.length > 8);
  assert.ok(selected.length > 8);
  assert.match(prompt, /```memory-cache\n• 기억/);
  assert.ok(prompt.length <= 2000);
  assert.equal(engine.stripOwnBlock(prompt), '엘레노어에 대해 말해줘.');
});

test('local analysis supplies classified candidates before Nano writes facts', () => {
  const { context } = workerHarness();
  const analyze = vm.runInContext('analyzeNanoWindow', context);
  const result = analyze([
    { id: 'u1', role: 'user', text: '서린에게 내일 작전을 묻는다.' },
    { id: 'a1', role: 'assistant', text: '서린｜"내일 아침에 작전 회의를 하죠." 서린은 크리에게 레드애쉬 거점에서 만나기로 약속했다.' }
  ]);
  assert.match(result.hints, /서린\(인물\)/);
  assert.equal(result.domains.get('서린'), '인물');
});

test('Nano waits for a full batch, then manual refresh processes the remainder', async () => {
  const { data, context, promptCount } = workerHarness();
  data.set('nanoBatchSize', 4);
  const messages = Array.from({ length: 5 }, (_, i) => [
    { id: `u${i}`, role: 'user', text: `엘레노어에게 ${i}번째로 묻는다.` },
    { id: `a${i}`, role: 'assistant', text: `엘레노어가 ${i}번째로 답한다.` }
  ]).flat();
  const process = vm.runInContext('processNanoMemory', context);
  const progress = [];
  const first = await process('room', messages, (_stage, done, total) => progress.push([done, total]));
  assert.equal(first.pending, 1);
  assert.equal(first.done, 4);
  assert.equal(promptCount(), 1);
  assert.equal(data.get('nanoMemory:room').lastId, 'a3');
  assert.deepEqual(progress, [[0, 5], [4, 5]]);
  const manual = await process('room', messages, () => {}, { force: true });
  assert.equal(manual.complete, true);
  assert.equal(promptCount(), 2);
  assert.equal(data.get('nanoMemory:room').lastId, 'a4');
});

test('full Nano rebuild keeps old memory until a complete replacement succeeds', async () => {
  const { data, context } = workerHarness();
  data.set('nanoBatchSize', 1);
  const old = { lastId: 'old', facts: [{ id: 'old:0', keyword: '서린', fact: '기존 기억', turn: 1 }] };
  data.set('nanoMemory:room', old);
  const messages = [{ id: 'u1', role: 'user', text: '열쇠를 맡긴다.' },
    { id: 'a1', role: 'assistant', text: '엘레노어가 열쇠를 맡았다.' }];
  const process = vm.runInContext('processNanoMemory', context);
  context.chrome.runtime.sendMessage = async () => ({ success: false, error: '모델 실패' });
  const failed = await process('room', messages, () => {}, { force: true, rebuild: true });
  assert.equal(failed.error, '모델 실패');
  assert.equal(data.get('nanoMemory:room'), old);
  assert.equal(data.has('nanoMemoryDraft:room'), false);
  context.chrome.runtime.sendMessage = async () => ({ success: true, text: '[{"keyword":"엘레노어","fact":"열쇠를 맡았다."}]' });
  const rebuilt = await process('room', messages, () => {}, { force: true, rebuild: true });
  assert.equal(rebuilt.complete, true);
  assert.equal(data.get('nanoMemory:room').lastId, 'a1');
  assert.equal(data.get('nanoMemory:room').facts.length, 1);
});

test('full rebuild keeps a manual correction attached to the same source fact', async () => {
  const { data, context } = workerHarness();
  data.set('nanoBatchSize', 1);
  data.set('nanoMemory:room', { lastId: 'a1', facts: [{ id: 'a1:0', sourceId: 'a1', keyword: '크리',
    fact: '크리가 S급으로 승진했다.', turn: 2 }] });
  data.set('nanoOverrides:room', { 'a1:0': { fact: '크리의 S급 승진은 대위급 이상에 해당한다.' } });
  context.chrome.runtime.sendMessage = async () => ({ success: true,
    text: '[{"keyword":"크리","fact":"크리는 S급으로 승진했다.","turn":2}]' });
  const messages = [{ id: 'u1', role: 'user', text: '승진했어?' },
    { id: 'a1', role: 'assistant', text: '크리는 S급으로 승진했다.' }];
  await vm.runInContext('processNanoMemory', context)('room', messages, () => {}, { force: true, rebuild: true });
  const visible = vm.runInContext('effectiveNanoFacts', context)(data.get('nanoMemory:room').facts,
    data.get('nanoOverrides:room'));
  assert.equal(visible[0].id, 'a1:0');
  assert.equal(visible[0].fact, '크리의 S급 승진은 대위급 이상에 해당한다.');
});

test('context assembly never exceeds the fixed 2000-character send limit', () => {
  const query = '가'.repeat(1950);
  const selected = engine.contextWithAll(null, [], query, {
    summaryCards: [{ title: '기억', content: '엘레노어가 열쇠를 보관했다.' }], budget: 2000
  }).selected;
  assert.ok(engine.composeUser(query, selected, 2000).length <= 2000);
});

test('native Crack persona is never duplicated in outgoing context', () => {
  const query = '안녕';
  const selected = engine.contextWithAll(null, [], query, {
    persona: { name: '아서', description: '성기사', speechStyle: '존댓말', enabled: true },
    summaryCards: [{ title: '기억', content: '은빛 열쇠를 보관했다.' }], budget: 2000
  });
  assert.equal(selected.selected.some(item => item.type === 'persona'), false);
  assert.equal(engine.composeUser(query, selected.selected, 2000).includes('아서'), false);
  assert.equal(selected.selectedSummaries.length, 1);
});

test('room statistics read only that room checkpoint and actual-send counters', async () => {
  const { data, context } = workerHarness();
  data.set('snap:room-a', { messages: [
    { id: 'a1', role: 'assistant' }, { id: 'a2', role: 'assistant' }
  ] });
  data.set('nanoMemory:room-a', { lastId: 'a1', facts: [{ id: 'fact' }], updatedAt: 123 });
  data.set('snap:room-b', { messages: [{ id: 'b1', role: 'assistant' }] });
  const today = new Date().toISOString().slice(0, 10);
  data.set(`analyticsRoomV2:room-a:${today}`, { sends: 2, injected: 3 });
  const stats = vm.runInContext('chatStats', context);
  const a = await stats('room-a');
  const b = await stats('room-b');
  assert.equal(a.processedTurns, 1);
  assert.equal(a.pendingTurns, 1);
  assert.equal(a.factCount, 1);
  assert.equal(a.roomToday.sends, 2);
  assert.equal(b.factCount, 0);
  assert.equal(b.roomToday.sends, 0);
});

test('storage cleanup preserves memory across more than thirty chat rooms', async () => {
  const { data, context } = workerHarness();
  for (let index = 0; index < 35; index++) {
    data.set(`nanoMemory:room-${index}`, { updatedAt: index + 1, facts: [{ id: `f-${index}` }] });
  }
  const result = await vm.runInContext('runStorageGarbageCollection', context)();
  assert.equal(result.prunedRoomsCount, 0);
  assert.equal([...data.keys()].filter(key => key.startsWith('nanoMemory:')).length, 35);
});
