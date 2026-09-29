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
      sendMessage: async message => {
        // Count memory extraction prompts only; merge judgments are a separate, optional call.
        if (message?.type === 'LLM_PROMPT' && /^각 번호마다/.test(message.prompt)) return { success: true, text: '[]' };
        prompts++;
        return { success: true, text: JSON.stringify([{ keyword: '엘레노어', fact: prompts === 1
          ? '엘레노어가 은빛 열쇠를 맡았다.' : '엘레노어가 은빛 열쇠를 돌려주었다.' }]) };
      }
    },
    storage: { local: storage },
    tabs: { query(_options, callback) { callback([]); } },
    alarms: { create() {}, onAlarm: { addListener() {} } }
  };
  const context = vm.createContext({ chrome, CrackMatrixEngine: engine, importScripts() {}, setTimeout, clearTimeout, console, crypto: globalThis.crypto });
  vm.runInContext(code, context);
  const dispatch = message => new Promise(resolve => messageListener(message, {}, resolve));
  return { data, context, dispatch, promptCount: () => prompts };
}

test('Nano reads completed assistant turns once and retrieves distinct microfacts', async () => {
  const { data, context, promptCount } = workerHarness();
  data.set('memoryMaxTurns', 1);
  const messages = [
    { id: 'u1', role: 'user', text: '엘레노어에게 열쇠를 맡긴다.' },
    { id: 'a1', role: 'assistant', text: '엘레노어가 은빛 열쇠를 맡았다.' },
    { id: 'u2', role: 'user', text: '열쇠를 돌려달라고 한다.' },
    { id: 'a2', role: 'assistant', text: '엘레노어가 은빛 열쇠를 돌려주었다.' }
  ];
  const progress = [];
  const process = vm.runInContext('processNanoMemory', context);
  const result = await process('room', messages, (_stage, done, total) => progress.push([done, total]), { force: true });
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
  const source = [
    { turn: 3, text: '서린은 크리와 내일 작전을 논의하자고 했다.' },
    { turn: 8, text: '크리는 창고로 향했다.' }
  ];
  const facts = parse(JSON.stringify([
    { turn: 8, keyword: '서린', domain: '인물', fact: '서린은 크리와 내일 작전을 논의하기로 했다.' },
    { turn: 999, keyword: '거점', domain: '가짜', fact: '거점으로 돌아왔다.' }
  ]), 8, 'batch', 16, [3, 8], new Map([['거점', '장소']]), source);
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
  data.set('memoryMaxTurns', 1);
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

test('a one-syllable subject retrieves its memories without unrelated recent-topic spillover', () => {
  const { context } = workerHarness();
  const facts = [
    { id: 'a1', keyword: '봉', fact: '주인공은 봉을 창고에 보관했다.', turn: 2 },
    { id: 'a2', keyword: '티타늄 봉', fact: '티타늄 봉은 질량을 바꿀 수 있다.', turn: 4 },
    { id: 'a3', keyword: 'B구역', fact: '수색대가 B구역에 들어갔다.', turn: 6 },
    { id: 'a4', keyword: '봉사', fact: '수색대는 봉사 활동을 했다.', turn: 8 },
    { id: 'a5', keyword: '식량', fact: '식량을 확보했다.', turn: 10 }
  ];
  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const cards = retrieve('short-subject', facts, '봉', Infinity, '수색대가 B구역에서 식량을 확보했다.');
  assert.equal(cards.length, 2);
  assert.ok(cards.every(card => /봉/.test(card.content)));
  assert.deepEqual(Array.from(cards, card => card.title).sort(), ['봉', '티타늄 봉'].sort());
  assert.ok(cards.every(card => Number.isInteger(card.turn)));
  assert.equal(retrieve('short-subject', facts, '응', Infinity, '수색대가 B구역에서 식량을 확보했다.').length, 0);
});

test('Nano source gate rejects misspelled names and analysis text; the system assigns turns', () => {
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
  assert.deepEqual(Array.from(facts, fact => fact.fact),
    ['하나가 준영에게 물을 건넸다.', '준영이 물을 마셨다.', '준영은 발목을 살폈다.']);
  assert.deepEqual(Array.from(facts, fact => fact.turn), [2, 3, 3]);
  assert.equal(facts[2].domain, '인물');
});

test('Nano gate drops facts about unnamed actors and retrieval skips restatements', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const source = [{ turn: 2, text: '크리가 사용자 몰래 상대방에게 봉을 던졌다. 서린은 B구역 수색에 합류했다.' }];
  const facts = parse(JSON.stringify([
    { turn: 2, keyword: '상대방', fact: '상대방이 봉에 맞았다.' },
    { turn: 2, keyword: '크리', fact: '상대방이 크리의 봉에 맞았다.' },
    { turn: 2, keyword: '크리', fact: '크리가 봉을 던졌다.' }
  ]), 2, 'batch', 16, [2], new Map(), source);
  assert.deepEqual(Array.from(facts, fact => fact.fact), ['크리가 봉을 던졌다.']);

  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const cards = retrieve('dupes', [
    { id: 'd1', keyword: '서린', fact: '서린은 B구역 실종자 수색 작전에 참여했다.', turn: 3 },
    { id: 'd2', keyword: '서린', fact: '서린은 B구역 실종자 수색 작전에 참여하기로 했다.', turn: 4 },
    { id: 'd3', keyword: '서린', fact: '서린은 크림슨 리퍼 경고를 받았다.', turn: 5 }
  ], '서린 B구역 수색', Infinity, '');
  assert.equal(cards.filter(card => /수색 작전/.test(card.content)).length, 1);
});

test('user turns are memory sources and witnesses must appear in the source turn', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const source = [
    { turn: 5, text: '크리는 서린에게 동생 지안이 7년 전 레드애쉬에서 실종됐다고 털어놓는다.' },
    { turn: 6, text: '서린은 크리의 말을 듣고 지안의 몽타주를 떠올렸다.' }
  ];
  const facts = parse(JSON.stringify([
    { turn: 5, keyword: '지안', domain: '인물', who: ['크리', '서린', '유빈'], fact: '크리는 동생 지안이 7년 전 레드애쉬에서 실종됐다고 서린에게 말했다.' },
    { turn: 6, keyword: '서린', domain: '인물', who: [], fact: '서린은 지안의 몽타주를 떠올렸다.' },
    { turn: 6, keyword: '서린', domain: '인물', who: ['서린'], fact: '서린은 지안에 대해 이야기를 나눴다.' }
  ]), 6, 'batch', 16, [5, 6], new Map([['크리', '인물'], ['서린', '인물'], ['유빈', '인물']]), source);
  assert.equal(facts.length, 2);
  assert.equal(facts[0].turn, 5);
  assert.deepEqual(Array.from(facts[0].who), ['크리', '서린']);
  assert.deepEqual(Array.from(facts[1].who).sort(), ['서린', '지안', '크리'].sort());

  const line = engine.contextWithAll(null, [], '지안', { summaryCards: [
    { id: 'x', title: '지안', content: facts[0].fact, turn: 5, who: facts[0].who }
  ], budget: 2000 }).selected[0].line;
  assert.equal(line, `[5 크리·서린] ${facts[0].fact}`);
});

test('hearsay, guesses, clipped dialogue and empty facts are not kept', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const source = [{ turn: 3, text: '레오는 발데르크가 대련장에서 소동을 벌였다더라고 했다. 시르드는 걱정해서... 아버지가... 라며 말을 흐렸다. 세리엔은 크리의 친구다.' }];
  const facts = parse(JSON.stringify([
    { keyword: '발데르크', fact: '발데르크가 대련장에서 소동을 벌였다더라.' },
    { keyword: '레오', fact: '레오는 그게 그렇게 분했나 보다.' },
    { keyword: '시르드', fact: '시르드는 걱정해서... 아버지가... 아니' },
    { keyword: '레오', fact: '레오😠' },
    { keyword: '세리엔', fact: '세리엔은 크리의 친구다.' }
  ]), 3, 'batch', 16, [3], new Map(), source);
  assert.deepEqual(Array.from(facts, fact => fact.fact), ['세리엔은 크리의 친구다.']);
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

test('extension prompt renders readable cache lines and keeps only clearly related facts', () => {
  // Distinct events and keywords, so neither duplicate suppression nor the per-keyword cap drops them.
  const facts = [
    '엘레노어는 항구에서 크리에게 지도를 넘겼다.',
    '엘레노어는 시장에서 상인과 다퉜다.',
    '엘레노어는 약국에서 해독제를 샀다.',
    '엘레노어는 성당 지하에 편지를 숨겼다.',
    '엘레노어는 광장에서 크리와 재회를 약속했다.',
    '엘레노어는 창고 열쇠를 잃어버렸다.',
    '엘레노어는 다리 위에서 추격자를 따돌렸다.',
    '엘레노어는 숲길에서 왼팔을 다쳤다.',
    '엘레노어는 기차역에서 크리를 배웅했다.',
    '엘레노어는 병원에 동생을 맡겼다.',
    '엘레노어는 학교 옥상에서 신호탄을 쐈다.',
    '엘레노어는 서고의 금서를 훔쳤다.',
    '엘레노어는 정원사에게 반지를 팔았다.',
    '엘레노어는 탑 꼭대기에서 크리를 기다렸다.'
  ].map((fact, index) => ({ id: `a${index}:0`, keyword: `엘레노어${index}`, turn: index + 1, fact }));
  const { context } = workerHarness();
  const cards = vm.runInContext('nanoMemoryCards', context)('room', facts, '엘레노어 크리');
  const selected = engine.contextWithAll(null, [], '엘레노어에 대해 말해줘.', { summaryCards: cards, budget: 2000 }).selected;
  const prompt = engine.composeUser('엘레노어에 대해 말해줘.', selected, 2000);
  // Every fact naming both 엘레노어 and 크리 is in; facts sharing only the common name are not padding.
  assert.deepEqual(Array.from(cards, card => card.turn).sort((a, b) => a - b), [1, 5, 9, 14]);
  assert.equal(selected.length, 4);
  assert.match(prompt, /<!--TRACE-->\n\[이전 대화에서 확인된 기억[^\n]*\]\n\[\d+\] /);
  const turns = Array.from(prompt.matchAll(/^\[(\d+)\]/gm), match => Number(match[1]));
  assert.deepEqual(turns, [...turns].sort((a, b) => a - b));
  assert.doesNotMatch(prompt, /• 기억·/);
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
  data.set('memoryMaxTurns', 4);
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
  data.set('memoryMaxTurns', 1);
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
  data.set('memoryMaxTurns', 1);
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
  data.set('nanoMemory:room-a', { lastId: 'a1', facts: [{ id: 'fact', keyword: '크리', fact: '크리는 은빛 열쇠를 받았다.' }], updatedAt: 123 });
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

test('rule-based memory skips status labels and never writes placeholder summaries', () => {
  const graph = engine.stepSlidingWindowGraph(engine.createEvolutionGraph(), [
    { role: 'assistant', text: '크리｜Lv.1 | HP 100\n속보: 던전 붕괴\n목표: 훈련 완료\n▍루시아 「 크리, 어디 가요?\n*루시아는 크리의 소매를 붙잡았다.' },
    { role: 'user', text: '크리는 루시아에게 금방 돌아오겠다고 약속했다.' }
  ], 1, 2);
  const speakers = graph.nodes.filter(node => node.role === 'speaker').map(node => node.keyword);
  assert.ok(!speakers.some(name => /속보|목표|Lv/.test(name)));
  assert.ok(speakers.includes('루시아'));
  assert.ok(graph.nodes.every(node => !/관련 상호작용 및 정황 전개/.test(node.summary)));
  assert.ok(graph.nodes.every(node => !/^\*|▍/.test(node.summary)));
});

test('a stop request ends LLM memory at once; the interrupted batch is read again later', async () => {
  const { data, context, dispatch } = workerHarness();
  data.set('memoryMaxTurns', 1);
  const messages = [
    { id: 'u1', role: 'user', text: '엘레노어에게 열쇠를 맡긴다.' },
    { id: 'a1', role: 'assistant', text: '엘레노어가 은빛 열쇠를 맡았다.' },
    { id: 'u2', role: 'user', text: '열쇠를 돌려달라고 한다.' },
    { id: 'a2', role: 'assistant', text: '엘레노어가 은빛 열쇠를 돌려주었다.' }
  ];
  let calls = 0;
  let abortModel = () => {};
  context.chrome.runtime.sendMessage = async message => {
    if (message.type === 'LLM_ABORT') { abortModel(); return undefined; }
    if (message.type !== 'LLM_PROMPT') return undefined;
    calls++;
    // A slow model: it only answers when aborted, as the real host does.
    const answer = new Promise(resolve => { abortModel = () => resolve({ success: false, error: 'aborted' }); });
    await dispatch({ type: 'STOP_NANO_MEMORY', chatId: 'room' });
    return answer;
  };
  const result = await vm.runInContext('processNanoMemory', context)('room', messages, () => {}, { force: true });
  assert.equal(result.stopped, true);
  assert.equal(result.done, 0);
  assert.equal(calls, 1);
  assert.equal(data.has('nanoMemory:room'), false);
});

test('bubbles map to turns by text and pinned turns are injected first', async () => {
  const { data, context, dispatch } = workerHarness();
  data.set('llmIntervention', false);
  const messages = [
    { id: 'u1', role: 'user', text: '나는 **은빛 열쇠**를 엘레노어에게 맡긴다.' },
    { id: 'a1', role: 'assistant', text: '엘레노어가 열쇠를 품에 넣었다.' }
  ];
  vm.runInContext('activeMemory', context).set('room', { chatId: 'room', all: messages, units: [], ix: null });
  const located = await dispatch({ type: 'LOCATE_TURNS', chatId: 'room', items: [
    { id: 'reroll-variant', text: '나는 은빛 열쇠를 엘레노어에게 맡긴다.' },
    { id: 'a1', text: '화면 텍스트가 달라도 id가 우선' },
    { id: '', text: '없는 문장입니다 없는 문장' }
  ] });
  assert.deepEqual(JSON.parse(JSON.stringify(located.turns)), [{ turn: 1, messageId: 'u1' }, { turn: 2, messageId: 'a1' }, null]);

  const pinned = await dispatch({ type: 'TOGGLE_PIN', chatId: 'room', messageId: 'u1' });
  assert.equal(pinned.pinned, true);
  assert.equal(data.get('pins:room')[0].turn, 1);
  const prepared = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: '다음 행동' });
  assert.match(prepared.content, /^\[1\] 📌｜나는 은빛 열쇠를 엘레노어에게 맡긴다\./m);

  const unpinned = await dispatch({ type: 'TOGGLE_PIN', chatId: 'room', messageId: 'u1' });
  assert.equal(unpinned.pinned, false);
  assert.equal(data.get('pins:room').length, 0);
});

test('budget: skip what the live context restates, favor people in the scene, keep newest restatement', () => {
  const { context } = workerHarness();
  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const facts = [
    { id: 'f1', keyword: '루시아', domain: '인물', fact: '루시아는 크리에게 성수를 건네며 치료를 약속했다.', turn: 3, who: ['루시아', '크리'] },
    { id: 'f2', keyword: '루시아', domain: '인물', fact: '루시아는 크리에게 성수를 건네며 치료를 약속했다.', turn: 9, who: ['루시아', '크리'] },
    { id: 'f3', keyword: '로완', domain: '인물', fact: '로완은 결투에서 왼팔을 다쳐 붕대를 감았다.', turn: 5, who: ['로완'] },
    { id: 'f4', keyword: '성검', domain: '개념', fact: '성검 아르테미스는 황실 지하 보물고에 봉인되어 있다.', turn: 7, who: [] }
  ];
  const recent = '로완은 결투에서 왼팔을 다쳐 붕대를 감았다. 루시아가 조용히 다가왔다.';
  const cards = retrieve('budget', facts, '다음 날 아침이 밝았다.', 20, '루시아가 창밖을 보았다.', recent);
  const ids = Array.from(cards, card => card.id);
  assert.ok(ids.includes('nano:f2'), 'scene person is recalled without being named in the draft');
  assert.ok(!ids.includes('nano:f1'), 'older restatement is replaced by the newer one');
  assert.ok(!ids.includes('nano:f3'), 'fact already restated in the live window is skipped');
});

test('memories sharing a turn and people share one line; legacy markers still strip', () => {
  const cards = [
    { id: 'a', title: '크리', content: '크리는 은빛 열쇠를 받았다.', turn: 12, who: ['크리', '서린'] },
    { id: 'b', title: '서린', content: '서린은 B구역 지도를 펼쳤다.', turn: 12, who: ['크리', '서린'] }
  ];
  const selected = engine.contextWithAll(null, [], '간다', { summaryCards: cards, budget: 2000 }).selected;
  const prompt = engine.composeUser('간다', selected, 2000);
  assert.match(prompt, /^\[12 크리·서린\] 크리는 은빛 열쇠를 받았다\. \/ 서린은 B구역 지도를 펼쳤다\.$/m);
  assert.equal((prompt.match(/\[12 /g) || []).length, 1);
  assert.equal(engine.stripOwnBlock('<!--CRACK_UBIS_CONTEXT_START-->\n옛 기억\n<!--CRACK_UBIS_CONTEXT_END-->\n본문'), '본문');
  assert.equal(engine.stripOwnBlock(prompt), '간다');
});

test('resetting a room while memory is being built does not bring the old memory back', async () => {
  const { data, context, dispatch } = workerHarness();
  data.set('memoryMaxTurns', 1);
  const messages = [
    { id: 'u1', role: 'user', text: '엘레노어에게 열쇠를 맡긴다.' },
    { id: 'a1', role: 'assistant', text: '엘레노어가 은빛 열쇠를 맡았다.' }
  ];
  let release;
  context.chrome.runtime.sendMessage = async message => {
    if (message.type !== 'LLM_PROMPT') return undefined;
    await new Promise(resolve => { release = resolve; });
    return { success: true, text: '[{"keyword":"엘레노어","fact":"엘레노어가 은빛 열쇠를 맡았다."}]' };
  };
  const job = vm.runInContext('processNanoMemory', context)('room', messages, () => {}, { force: true });
  await new Promise(resolve => setTimeout(resolve, 0));
  await dispatch({ type: 'RESET_CHAT_MEMORY', chatId: 'room' });
  release?.();
  await job;
  assert.equal(data.has('nanoMemory:room'), false);
});

test('memory kinds are kept and lasting kinds outrank passing ones', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const facts = parse(JSON.stringify([
    { keyword: '서린', kind: '약속', fact: '서린은 해 뜨기 전 B구역 입구에서 크리를 기다리기로 했다.' },
    { keyword: '서린', kind: '아무거나', fact: '서린은 B구역 입구 쪽 창문을 열었다.' }
  ]), 2, 'batch', 16, [2], new Map(), [{ turn: 2, text: '서린은 B구역 입구 쪽 창문을 열고, 해 뜨기 전 입구에서 크리를 기다리겠다고 했다.' }]);
  assert.deepEqual(Array.from(facts, fact => fact.kind), ['약속', '']);
  const cards = vm.runInContext('nanoMemoryCards', context)('kinds', facts.map(fact => ({ ...fact, turn: 2 })), '서린 B구역 입구', 10);
  assert.equal(cards[0].content, '서린은 해 뜨기 전 B구역 입구에서 크리를 기다리기로 했다.');
});

test('glances, copied system lines, "no information" and adjective stems are not kept', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const source = [{ turn: 3, text: '「세계 최초의 히든 직업이 확인되었어요!」 차세린은 크리를 평가하는 듯한 시선을 던졌다. 백은하가 말했다. "크리 씨는 유일한 배틀메이지예요. 정말 유일해요." 크리의 직업 배틀메이지는 기록에 없는 히든 직업이다.' }];
  const facts = parse(JSON.stringify([
    { keyword: '히든 직업', kind: '설정', fact: '세계 최초의 히든 직업이 확인되었어요!' },
    { keyword: '차세린', kind: '관계', fact: '차세린은 크리를 평가하는 듯한 시선을 던졌다.' },
    { keyword: '차세린', kind: '비밀', fact: '차세린은 크리에 대한 정보가 없음.' },
    { keyword: '유일', domain: '인물', kind: '설정', who: ['유일', '백은하'], fact: '크리는 유일한 배틀메이지다.' },
    { keyword: '배틀메이지', kind: '설정', who: ['백은하', '유일'], fact: '배틀메이지는 기록에 없는 히든 직업이다.' }
  ]), 3, 'batch', 16, [3], new Map([['백은하', '인물']]), source);
  assert.deepEqual(Array.from(facts, fact => fact.fact), ['크리는 유일한 배틀메이지다.', '배틀메이지는 기록에 없는 히든 직업이다.']);
  assert.equal(facts[0].domain, '개념');
  assert.deepEqual(Array.from(facts[1].who), ['백은하']);
});

test('copied prompt templates are stripped and name variants of one person merge', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const source = [{ turn: 25, text: '로완 리드가 웃었다. 로완은 자신의 마력이 받은 피해를 열로 바꿔 방출한다고 크리에게 말했다. 그녀의 마력은 용광로 그 자체였다.' }];
  const facts = parse(JSON.stringify([
    { keyword: '로완', kind: '설정', who: ['크리', '로완', '로완 리드'], fact: '누가 ~라고 말했다: 로완은 자신의 마력이 피해를 열로 바꿔 방출한다고 말했다.' },
    { keyword: '로완', kind: '설정', who: ['크리'], fact: '누가 ~라고 말했다: 그녀의 마력은 용광로 그 자체였다.' },
    { keyword: '로완', kind: '설정', who: [], fact: '로완은 누가 ~라고 했다.' }
  ]), 25, 'batch', 16, [25], new Map([['로완', '인물'], ['크리', '인물']]), source);
  assert.deepEqual(Array.from(facts, fact => fact.fact), ['로완은 자신의 마력이 피해를 열로 바꿔 방출한다고 말했다.']);
  assert.deepEqual(Array.from(facts[0].who), ['크리', '로완']);
});

test('a one-word query brings its match, not every memory about people in the scene', () => {
  const { context } = workerHarness();
  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const people = ['차세린', '로완', '루시아', '아델하이트'];
  const facts = people.flatMap((name, p) => [0, 1, 2, 3].map(i => ({
    id: `${name}${i}`, keyword: name, domain: '인물', turn: p * 10 + i + 1,
    fact: i === 0 ? `${name}은 크리를 보고 헛웃음을 터뜨렸다.` : `${name}은 ${['검술', '마력', '가문', '약속'][i]}에 대해 크리와 이야기했다 ${i}.`
  })));
  facts.push({ id: 'neuro', keyword: '크리', domain: '인물', turn: 42, fact: '크리의 마력화된 신경은 새로운 능력이다.' });
  const cards = retrieve('scene', facts, '신경마도화', 100, '차세린과 로완, 루시아, 아델하이트가 크리를 둘러쌌다.');
  assert.equal(cards[0]?.id, 'nano:neuro');
  assert.ok(cards.length <= 7, `${cards.length} cards`);
  assert.ok(cards.every(card => !/헛웃음/.test(card.content)));
});

test('keyword cards: updates and restatements move older notes to history; overflow is kept, not deleted', () => {
  const { context } = workerHarness();
  const fold = vm.runInContext('foldMemory', context);
  const facts = [
    { id: 'r1', keyword: '로완', kind: '관계', turn: 10, fact: '로완은 크리를 믿지 못하고 경계했다.' },
    { id: 'r2', keyword: '로완', kind: '관계', turn: 30, fact: '로완은 크리를 믿고 등을 맡겼다.' },
    { id: 'r3', keyword: '로완', kind: '설정', turn: 12, fact: '로완의 마력은 피해를 열로 바꾼다.' },
    ...[1, 2, 3, 4].map(i => ({ id: `e${i}`, keyword: '로완', kind: '경험', turn: 40 + i, fact: `로완은 ${['항구', '광장', '탑', '숲'][i - 1]}에서 크리와 ${['낚시', '축제', '야경', '사냥'][i - 1]}를 즐겼다.` }))
  ];
  const card = fold(facts, { r2: { action: 'update', target: 'r1' } }).get('로완');
  const current = Array.from(card.current, note => note.id);
  assert.ok(current.includes('r2') && !current.includes('r1'), 'the newer relationship replaces the older');
  assert.ok(current.includes('r3'), 'lasting settings stay current');
  assert.equal(card.current.length, 5);
  assert.ok(card.history.some(note => note.id === 'r1' && note.reason === 'updated'));
  assert.ok(card.history.some(note => note.reason === 'overflow'), 'overflow is moved to history');
  assert.equal(card.current.length + card.history.length, facts.length, 'nothing is lost');
});

test('without an LLM, the original passages that match the draft are injected with their scene', async () => {
  const { data, context, dispatch, promptCount } = workerHarness();
  data.set('llmIntervention', false);
  const all = [];
  for (let i = 0; i < 20; i++) {
    all.push({ id: `u${i}`, role: 'user', text: `크리는 ${i}번째로 주변을 살핀다.` });
    all.push({ id: `a${i}`, role: 'assistant', text: i === 4
      ? '⌛42｜7/21[월] 8일차 낮 13:10☁️ 🏢관리국 - 총장실\n지크의 사무실은 관리국 지하 3층 끝에 있었다. 지크는 크리에게 측정실 열쇠를 건넸다.\n물자 획득 탄약 5.56mm x90'
      : `크리는 ${i}번째 복도를 지나갔다. 창밖에는 비가 내렸다.` });
  }
  vm.runInContext('activeMemory', context).set('room', { chatId: 'room', all, units: [], ix: null });
  const job = await vm.runInContext('processNanoMemory', context)('room', all, () => {}, { force: true });
  assert.equal(job.complete, true);
  assert.equal(promptCount(), 0);
  assert.equal(data.has('nanoMemory:room'), false, 'no memory log is written without an LLM');
  const prepared = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: '지크의 측정실 열쇠를 쓴다' });
  assert.match(prepared.content, /^\[10 8일차 관리국 - 총장실\] 지크의 사무실은 관리국 지하 3층 끝에 있었다\. 지크는 크리에게 측정실 열쇠를 건넸다\.$/m);
  assert.doesNotMatch(prepared.content, /⌛|물자 획득/);
});

test('turning the LLM on after a rule-written log reads the chat again instead of doing nothing', async () => {
  const { data, context, promptCount } = workerHarness();
  data.set('memoryMaxTurns', 1);
  data.set('nanoMemory:room', { lastId: 'a1', facts: [{ id: 'x:r:1', keyword: '크리', fact: '크리는 층을 올랐다.', turn: 2, source: 'rule' }] });
  const messages = [
    { id: 'u1', role: 'user', text: '엘레노어에게 열쇠를 맡긴다.' },
    { id: 'a1', role: 'assistant', text: '엘레노어가 은빛 열쇠를 맡았다.' }
  ];
  const result = await vm.runInContext('processNanoMemory', context)('room', messages, () => {}, { force: true });
  assert.equal(result.done, 1);
  assert.equal(promptCount(), 1);
  assert.ok(data.get('nanoMemory:room').facts.every(fact => fact.source !== 'rule'));
});

test('passages keep a speaker with the whole quote and drop tiny fragments', () => {
  const lines = ['⌛5｜1일차 🏠레드애쉬 거점', '서린은 분대원들을 둘러보았다.', '서린｜"계급은... 동급이니까요. 누가 명령하는 구조는 아닙니다."', '지안｜"오 민주주의다!"'];
  const long = `크리｜"${'이건 아주 긴 대사입니다. '.repeat(20)}"`;
  const pix = engine.buildPassageIndex([{ text: lines.join('\n') }, { text: '뭐라도 해야했으니까요..' }, { text: long }]);
  const texts = Array.from(pix.units, unit => unit.text);
  assert.ok(texts.some(text => text.includes('서린｜"계급은... 동급이니까요. 누가 명령하는 구조는 아닙니다."')));
  assert.ok(texts.every(text => !/^[^｜]*"\s*$/.test(text)), 'no passage starts inside a quote');
  assert.ok(!texts.includes('뭐라도 해야했으니까요..'));
  assert.equal(pix.units[0].scene, '1일차 레드애쉬 거점');
  assert.ok(texts.filter(text => text.startsWith('크리｜')).length >= 1);
});

test('who keeps only words the chat uses as names', () => {
  const { context } = workerHarness();
  const parse = vm.runInContext('parseNanoFacts', context);
  const source = [{ turn: 1, text: '서린이 정신을 차렸다. 지안은 허리춤에 칼을 찼다. 특무를 받은 크리에게 서린은 지도를 건넸다.' }];
  const facts = parse(JSON.stringify([
    { keyword: '서린', kind: '약속', who: ['서린', '정신', '허리춤', '특무', '[]', '크리'], fact: '서린은 크리에게 B구역 지도를 건넸다.' }
  ]), 1, 'batch', 16, [1], new Map(), source);
  assert.deepEqual(Array.from(facts[0].who), ['서린', '크리']);
});

test('passage search puts the named person first, their own lines above mentions', () => {
  const msgs = [
    { text: '유빈｜"독버섯은 제가 구분하니까 건드리지 마세요." 유빈은 채집 바구니를 들었다.' },
    { text: '서린｜"유빈은 원래 말이 없어요." 서린이 크리에게 속삭였다.' },
    { text: '유빈｜"...괜찮은 사람이에요." 유빈이 크리를 보며 짧게 말했다.' },
    { text: '서린｜"오늘은 여기서 쉬죠." 서린은 지도를 접었다. 모두 거실에 모였다.' },
    ...Array.from({ length: 12 }, (_, i) => ({ text: `창밖에는 ${i}번째 비가 내렸다. 거리는 조용했고 멀리서 개가 짖었다.` }))
  ];
  const pix = engine.buildPassageIndex(msgs);
  assert.ok(pix.names.has('유빈') && pix.names.has('서린'));
  const picked = engine.passageSearch(pix, '유빈은 나를 어떻게 생각해?', { budget: 1200 });
  assert.ok(picked.length >= 2);
  assert.ok(picked.some(unit => unit.speakers.includes('유빈')), JSON.stringify(picked.map(p => p.text)));
  assert.ok(picked.every(unit => !/개가 짖었다/.test(unit.text)));
});

test('a room can switch its user note off without losing the text', async () => {
  const { data, context, dispatch } = workerHarness();
  data.set('llmIntervention', false);
  vm.runInContext('activeMemory', context).set('room', { chatId: 'room', all: [{ id: 'a1', role: 'assistant', text: '안녕' }], units: [], ix: null });
  data.set('usernote:room', '3인칭 소설체로 써 주세요.');
  let prepared = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: '간다' });
  assert.equal(prepared.userNote, '3인칭 소설체로 써 주세요.');
  data.set('usernoteEnabled:room', false);
  prepared = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: '간다' });
  assert.equal(prepared.userNote, '');
  assert.equal(data.get('usernote:room'), '3인칭 소설체로 써 주세요.');
});

test("the user note is written to Crack's own per-chat note, and never smuggled into messages", async () => {
  const { context, dispatch } = workerHarness();
  const calls = [];
  context.chrome.cookies = { get: async () => ({ value: 'token' }) };
  context.fetch = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body && JSON.parse(options.body) });
    return { ok: true, json: async () => ({ data: { userNote: { content: '성좌 진명: 칼', isExtend: true } } }) };
  };
  const read = await dispatch({ type: 'GET_NATIVE_USERNOTE', chatId: 'room1' });
  assert.equal(read.content, '성좌 진명: 칼');
  assert.equal(read.isExtend, true);
  const written = await dispatch({ type: 'SET_NATIVE_USERNOTE', chatId: 'room1', content: '말투: 건조한 단문', isExtend: false });
  assert.equal(written.success, true);
  assert.equal(calls[1].method, 'PATCH');
  assert.equal(calls[1].url, 'https://crack-api.wrtn.ai/crack-gen/v3/chats/room1');
  assert.deepEqual(calls[1].body, { userNote: { content: '말투: 건조한 단문', isExtend: false } });
  const tooLong = await dispatch({ type: 'SET_NATIVE_USERNOTE', chatId: 'room1', content: 'x'.repeat(501), isExtend: false });
  assert.equal(tooLong.success, false);
  assert.doesNotMatch(readFileSync(new URL('../extension/content/page-hook.js', import.meta.url), 'utf8'), /payload\.userNote\s*=/);
});

test('reading a long chat retries a failed page and reports when it could not finish', async () => {
  const { context, dispatch } = workerHarness();
  context.chrome.cookies = { get: async () => ({ value: 'token' }) };
  const page = (from, next) => ({ ok: true, json: async () => ({ data: {
    messages: Array.from({ length: 50 }, (_, i) => ({ _id: `m${from + i}`, role: (from + i) % 2 ? 'assistant' : 'user', content: `대화 ${from + i}` })),
    nextCursor: next } }) });
  let calls = 0;
  context.fetch = async url => {
    calls++;
    if (calls === 2) throw Error('network');           // one transient failure
    return /cursor=c2/.test(url) ? page(100, null) : /cursor=c1/.test(url) ? page(50, 'c2') : page(0, 'c1');
  };
  const full = await dispatch({ type: 'EXPORT_CHAT_FULL', chatId: 'long', opts: {} });
  assert.equal(full.count, 150);
  assert.equal(full.incomplete, '');

  context.fetch = async url => { if (/cursor=/.test(url)) return { ok: false, status: 503 }; return page(0, 'c1'); };
  const partial = await dispatch({ type: 'EXPORT_CHAT_FULL', chatId: 'long2', opts: {} });
  assert.equal(partial.count, 50);
  assert.match(partial.incomplete, /50개를 받은 뒤/);
});

test('an old memory pushed out of the current five is recalled when the draft asks for it', () => {
  const { context } = workerHarness();
  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const facts = [
    { id: 'old', keyword: '세리엔', kind: '경험', turn: 5, fact: '세리엔은 크리에게 어린 시절 은방울꽃 정원에서 검을 처음 가르쳐 주었다.' },
    ...[1, 2, 3, 4, 5].map(i => ({ id: `n${i}`, keyword: '세리엔', kind: '설정', turn: 50 + i,
      fact: `세리엔은 ${['금빛 눈', '정검 교정', '관람석', '복도', '가문 규율'][i - 1]}에 관한 ${i}번째 설정을 가졌다.` })),
    { id: 'stale', keyword: '세리엔', kind: '관계', turn: 8, fact: '세리엔은 크리를 가문의 수치로 경멸했다.' },
    { id: 'fresh', keyword: '세리엔', kind: '관계', turn: 60, fact: '세리엔은 크리를 가문의 수치로 보지 않게 되었다.' }
  ];
  const fold = vm.runInContext('foldMemory', context)(facts, { fresh: { action: 'update', target: 'stale' } });
  assert.ok(fold.get('세리엔').history.some(note => note.id === 'old' && note.reason === 'overflow'));
  const asked = retrieve('old', facts, '누나가 어릴 때 은방울꽃 정원에서 검을 가르쳐 줬잖아', 100, '', '', { fresh: { action: 'update', target: 'stale' } });
  assert.ok(asked.some(card => card.id === 'nano:old'), 'dormant memory returns when asked');
  const unrelated = retrieve('old', facts, '오늘 저녁 메뉴는 뭐야', 100, '세리엔이 복도를 걸었다.', '', { fresh: { action: 'update', target: 'stale' } });
  assert.ok(!unrelated.some(card => card.id === 'nano:old'), 'dormant memory is not used as filler');
  const stale = retrieve('old', facts, '세리엔은 크리를 가문의 수치로 경멸했다', 100, '', '', { fresh: { action: 'update', target: 'stale' } });
  assert.ok(!stale.some(card => card.id === 'nano:stale'), 'a replaced state never comes back');
});

test('the subject of the conversation brings its linked memories, even when the draft only points at it', async () => {
  const { data, context, dispatch } = workerHarness();
  const facts = [
    { id: 'c1', keyword: '대행 계약', kind: '약속', turn: 3, who: ['크리', '지평선을 그은자'], fact: '크리는 지평선을 그은자와 대행 계약을 맺고 봉에 질량 조작 권능을 받았다.' },
    { id: 'c2', keyword: '지평선을 그은자', kind: '설정', turn: 3, who: ['크리'], fact: '지평선을 그은자는 대행 계약의 대가로 크리의 싸움을 생중계로 지켜본다.' },
    { id: 'c3', keyword: '김도윤', kind: '관계', turn: 10, who: ['김도윤', '크리'], fact: '김도윤은 크리를 미등록 대행자로 판단했다.' },
    { id: 'c4', keyword: '편의점', kind: '설정', turn: 12, who: [], fact: '편의점 창고에는 건전지 네 개가 남아 있었다.' }
  ];
  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const topicsOf = vm.runInContext('conversationTopics', context);
  const messages = [{ role: 'assistant', text: '김도윤이 물었다. "그 대행 계약, 누구랑 한 거야?"' }];

  // Inferred by the LLM: the draft says "그거", the model says it is the contract.
  const topics = topicsOf(facts, '근데 그거 왜 한 거예요? 나한테 무슨 이득이 있다고', messages, ['대행 계약']);
  const cards = retrieve('topic', facts, '근데 그거 왜 한 거예요? 나한테 무슨 이득이 있다고', 100, '', '', {}, topics);
  const byId = Object.fromEntries(cards.map(card => [card.id, card.why]));
  assert.equal(byId['nano:c1'], '의도');
  assert.equal(byId['nano:c2'], '연결', 'a memory mentioning the subject comes along');
  assert.equal(byId['nano:c3'], '최근 화제', 'the last turn named 김도윤');
  assert.ok(!byId['nano:c4'], 'unrelated memory stays out');

  // The intent request is made once per draft and cached, even when the model fails.
  let asked = 0;
  context.chrome.runtime.sendMessage = async message => { if (message.type === 'LLM_PROMPT') asked++; return { success: false, error: 'no model' }; };
  data.set('nanoMemory:room', { facts });
  vm.runInContext('activeMemory', context).set('room', { chatId: 'room', all: messages, units: [], ix: null });
  await dispatch({ type: 'LLM_INTENT', chatId: 'room', draft: '그거 왜 한 거예요' });
  await dispatch({ type: 'LLM_INTENT', chatId: 'room', draft: '그거 왜 한 거예요' });
  assert.ok(asked <= 2, `asked ${asked} times`);
  const again = await dispatch({ type: 'LLM_INTENT', chatId: 'room', draft: '그거 왜 한 거예요' });
  assert.equal(again.cached, true);
});

test('turns are read when the next one would overflow the model input, the rest waits', async () => {
  const { data, context } = workerHarness();
  const prompts = [];
  context.chrome.runtime.sendMessage = async message => {
    if (message.type !== 'LLM_PROMPT') return undefined;
    if (!/^각 번호마다/.test(message.prompt)) prompts.push(message.prompt);
    return { success: true, text: '[]', quota: 0 };
  };
  const turn = (i, size) => [
    { id: `u${i}`, role: 'user', text: `크리가 ${i}번째로 말한다.` },
    { id: `a${i}`, role: 'assistant', text: `${i}번째 답: ${'가'.repeat(size)}` }
  ];
  // 1, 2, 3 fit in 1,000 characters; 4 would overflow.
  const messages = [...turn(1, 250), ...turn(2, 250), ...turn(3, 250), ...turn(4, 400)];
  const run = vm.runInContext('processNanoMemory', context);
  const first = await run('room', messages, () => {}, { charBudget: 1000 });
  assert.equal(prompts.length, 1);
  assert.equal(first.done, 3);
  assert.equal(first.pending, 1);
  assert.match(prompts[0], /3번째 답/);
  assert.doesNotMatch(prompts[0], /4번째 답/);
  assert.equal(data.get('nanoMemory:room').lastId, 'a3');
  // Turn 4 alone does not fill a call and is still in Crack's live window: no model call.
  const second = await run('room', messages, () => {}, { charBudget: 1000 });
  assert.equal(prompts.length, 1);
  assert.equal(second.pending, 1);
});

test('with equal relevance, the older memory ranks first: it is the likelier one to be forgotten', () => {
  const { context } = workerHarness();
  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const facts = [
    { id: 'recent', keyword: '루시아', kind: '설정', turn: 95, fact: '루시아는 성당 종탑의 열쇠를 가지고 있다.' },
    { id: 'old', keyword: '아델하이트', kind: '설정', turn: 5, fact: '아델하이트는 성당 지하 서고의 열쇠를 가지고 있다.' },
    { id: 'filler', keyword: '크리', kind: '경험', turn: 100, fact: '크리는 광장에서 빵을 샀다.' }
  ];
  const cards = retrieve('age', facts, '성당 열쇠를 가진 사람', 200);
  assert.deepEqual(Array.from(cards.slice(0, 2), card => card.id), ['nano:old', 'nano:recent']);
});

test('an old memory comes with the newest lasting note about the same subject', () => {
  const { context } = workerHarness();
  const retrieve = vm.runInContext('nanoMemoryCards', context);
  const facts = [
    { id: 'then', keyword: '로완', kind: '경험', turn: 10, fact: '로완은 대련장에서 크리의 목검을 부러뜨렸다.' },
    { id: 'now', keyword: '로완', kind: '관계', turn: 80, fact: '로완은 크리를 동료로 인정하고 등을 맡겼다.' },
    { id: 'other', keyword: '서린', kind: '설정', turn: 50, fact: '서린은 약국 위치를 알고 있다.' }
  ];
  const cards = retrieve('bridge', facts, '대련장에서 목검 부러뜨렸던 거 기억나?', 200);
  const byId = Object.fromEntries(cards.map(card => [card.id, card.why]));
  assert.equal(byId['nano:then'], '입력 일치');
  assert.ok(['최신 상태', '연결'].includes(byId['nano:now']), 'the newer state comes along');
  assert.ok(!byId['nano:other']);
});

test('when an older turn changes, memory from surviving turns is kept and only the new branch is read', async () => {
  const { data, context, promptCount } = workerHarness();
  data.set('memoryMaxTurns', 1);
  const base = [
    { id: 'u1', role: 'user', text: '엘레노어에게 열쇠를 맡긴다.' }, { id: 'a1', role: 'assistant', text: '엘레노어가 은빛 열쇠를 맡았다.' },
    { id: 'u2', role: 'user', text: '열쇠를 돌려달라고 한다.' }, { id: 'a2', role: 'assistant', text: '엘레노어가 은빛 열쇠를 돌려주었다.' }
  ];
  data.set('nanoMemory:room', { lastId: 'a2', facts: [
    { id: 'f1', keyword: '엘레노어', fact: '엘레노어가 은빛 열쇠를 맡았다.', turn: 2, sourceId: 'a1' },
    { id: 'f2', keyword: '엘레노어', fact: '엘레노어가 은빛 열쇠를 돌려주었다.', turn: 4, sourceId: 'a2' }
  ] });
  // The second reply was rerolled into a different answer with a new id.
  const changed = [...base.slice(0, 3), { id: 'a2b', role: 'assistant', text: '엘레노어는 열쇠를 돌려주지 않았다.' }];
  await vm.runInContext('processNanoMemory', context)('room', changed, () => {}, { force: true });
  const facts = data.get('nanoMemory:room').facts;
  assert.equal(promptCount(), 1, 'only the changed turn is read');
  assert.ok(facts.some(fact => fact.id === 'f1'), 'memory from the surviving turn stays');
  assert.ok(!facts.some(fact => fact.id === 'f2'), 'memory from the abandoned branch is gone');
  assert.equal(data.get('nanoMemory:room').lastId, 'a2b');
});

test('a chat branched from another starts with the original memory up to the branch point', async () => {
  const { data, context } = workerHarness();
  const shared = Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, role: i % 2 ? 'assistant' : 'user', text: `공통 대화 ${i}` }));
  data.set('snap:origin', { messages: [...shared, { id: 'o6', role: 'user', text: '원본에서만 한 말' }] });
  data.set('nanoMemory:origin', { lastId: 'o5', facts: [
    { id: 'k1', keyword: '크리', fact: '크리는 은빛 열쇠를 받았다.', turn: 2 },
    { id: 'k2', keyword: '크리', fact: '크리는 원본에서만 성당에 갔다.', turn: 7 }
  ] });
  data.set('pins:origin', [{ messageId: 'o3', turn: 4, text: '고정한 대화' }]);
  data.set('lore:origin', [{ title: '성검', content: '성검은 황실 보물고에 있다.' }]);
  const branch = [...shared.map((message, i) => ({ ...message, id: `b${i}` })), { id: 'b6', role: 'user', text: '분기에서 한 다른 말' }];
  const carried = await vm.runInContext('carryBranchMemory', context)('branch', branch);
  assert.equal(carried.chatId, 'origin');
  assert.equal(carried.turns, 6);
  assert.deepEqual(Array.from(data.get('nanoMemory:branch').facts, fact => fact.id), ['k1']);
  assert.equal(data.get('nanoMemory:branch').lastId, 'b5');
  assert.equal(data.get('pins:branch')[0].messageId, 'b3');
  assert.equal(data.get('lore:branch').length, 1);
  assert.equal(await vm.runInContext('carryBranchMemory', context)('branch', branch), null, 'checked only once');
});

test('the header tells the model the current turn, and names in brackets are clean', async () => {
  const prompt = engine.composeUser('간다', [{ line: '[24 김도윤] 김도윤은 경례했다.' }], 2000, 245);
  assert.match(prompt, /\[번호\]=대화 순번\(지금은 245번\)/);
  assert.ok(prompt.length <= 2000);
  const { context } = workerHarness();
  const merge = vm.runInContext('mergeNameVariants', context);
  assert.deepEqual(Array.from(merge(['🌟「지평선을 그은자」😐', '박하린😐', '도윤', '김도윤', '로완', '로완 리드'])),
    ['지평선을 그은자', '박하린', '김도윤', '로완']);
});

test('meaning search: embedding ranks join word search, and a slow answer does not hold the message', async () => {
  const { data, context, dispatch } = workerHarness();
  data.set('llmIntervention', false);
  data.set('semanticSearch', true);
  const all = [];
  for (let i = 0; i < 20; i++) {
    all.push({ id: `u${i}`, role: 'user', text: `크리는 ${i}번째로 복도를 걷는다.` });
    all.push({ id: `a${i}`, role: 'assistant', text: i === 3
      ? '글레이드 가문의 메이드는 주인에게 애정을 품지 않는 것이 규율이었다. 샤일은 그 규율을 지켜 왔다.'
      : `크리는 ${i}번째 복도를 지나갔다. 창밖에는 비가 내렸다.` });
  }
  vm.runInContext('activeMemory', context).set('room', { chatId: 'room', all, units: [], ix: null });
  context.chrome.offscreen = { createDocument: async () => {} };
  let delay = 0;
  context.chrome.runtime.sendMessage = async message => {
    if (message.type === 'EMBED_INDEX') return { success: true, count: message.items.length };
    if (message.type !== 'EMBED_RANK') return undefined;
    if (!message.chatId.startsWith('passages:')) return { success: true, results: [], indexed: 0 };
    const pix = vm.runInContext('activeMemory', context).get('room').pix;
    const target = pix.units.find(unit => unit.text.includes('글레이드 가문'));
    await new Promise(resolve => setTimeout(resolve, delay));
    return { success: true, indexed: pix.units.length, results: [{ id: target.unitId, score: 0.9 },
      ...pix.units.filter(unit => unit !== target).slice(0, 20).map(unit => ({ id: unit.unitId, score: 0.7 }))] };
  };
  const draft = '샤일은 왜 나한테 마음을 안 보여줄까';
  const fast = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: draft });
  assert.equal(fast.semantic, true);
  assert.match(fast.content, /글레이드 가문의 메이드/);
  delay = 800;
  const slow = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: draft });
  assert.equal(slow.semantic, false, 'went out with word search alone');
});

test('찾기 lists every turn with the words as typed, oldest first, then close matches', () => {
  const { context } = workerHarness();
  const messages = [
    { id: 'm1', role: 'assistant', text: '```INFO\n⌛ 8일차 낮 13:10 🏢관리국\n```\n아린이 **월광검**을 뽑았다.' },
    { id: 'm2', role: 'user', text: '<!--TRACE-->\n[1] 월광검은 아린의 검이다.\n<!--/TRACE-->\n그 검 다시 보여줘' },
    { id: 'm3', role: 'assistant', text: '아린은 월광 검집을 풀었다. 은빛 열쇠는 서고에 있다.' },
    { id: 'm4', role: 'assistant', text: '월광검이 다시 빛났다.' }
  ];
  const found = context.searchTurns(messages, '월광검');
  assert.deepEqual(Array.from(found.results, hit => [hit.turn, hit.exact]), [[1, true], [4, true], [3, false]],
    'exact hits first; "월광 검집" is a close match; the injected block in turn 2 is not what the player saw');
  assert.equal(found.total, 2);
  assert.equal(found.results[0].match, '월광검');
  assert.equal(found.results[1].before, '');
  assert.equal(context.searchTurns(messages, '8일차').results[0]?.turn, 1, 'status windows are searchable');
  const close = context.searchTurns(messages, '월광 검집 서고');
  assert.equal(close.results[0]?.turn, 3);
  assert.deepEqual(Array.from(context.searchTurns(messages, '오늘 저녁 메뉴').results), []);
});

test('in LLM mode a pinned memory and a pinned keyword are injected even when the draft is unrelated', async () => {
  const { data, context, dispatch } = workerHarness();
  const all = [];
  for (let i = 0; i < 12; i++) all.push({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `${i}번째 대화` });
  vm.runInContext('activeMemory', context).set('room', { chatId: 'room', all, units: [], ix: null });
  data.set('nanoMemory:room', { facts: [
    { id: 'f1', keyword: '월광검', fact: '월광검은 달빛으로 환영을 벤다.', turn: 3, who: ['아린'], domain: '개념', kind: '설정' },
    { id: 'f2', keyword: '세린', fact: '세린은 아린의 언니다.', turn: 4, who: ['세린'], domain: '인물', kind: '관계' },
    { id: 'f3', keyword: '세린', fact: '세린은 서고 열쇠를 숨겼다.', turn: 6, who: ['세린'], domain: '인물', kind: '비밀' },
    { id: 'f4', keyword: '도윤', fact: '도윤은 경비대장이다.', turn: 5, who: ['도윤'], domain: '인물', kind: '설정' }
  ] });
  const draft = '오늘 저녁은 뭘 먹을까';
  let prepared = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: draft });
  assert.ok(!/월광검|세린/.test(prepared.content), 'nothing relevant before pinning');

  assert.equal((await dispatch({ type: 'UPDATE_NANO_FACT', chatId: 'room', factId: 'f1', patch: { pinned: true } })).success, true);
  assert.equal((await dispatch({ type: 'TOGGLE_KEYWORD_PIN', chatId: 'room', keyword: '세린' })).pinned, true);
  prepared = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: draft });
  assert.match(prepared.content, /월광검은 달빛으로 환영을 벤다/);
  assert.match(prepared.content, /세린은 아린의 언니다/);
  assert.match(prepared.content, /세린은 서고 열쇠를 숨겼다/);
  assert.doesNotMatch(prepared.content, /도윤은 경비대장/);
  const cards = (await dispatch({ type: 'GET_MEMORY_CARDS', chatId: 'room' })).cards;
  assert.equal(cards.find(card => card.keyword === '세린').pinned, true);
  assert.equal(cards.find(card => card.keyword === '월광검').current[0].pinned, true);

  assert.equal((await dispatch({ type: 'TOGGLE_KEYWORD_PIN', chatId: 'room', keyword: '세린' })).pinned, false);
  prepared = await dispatch({ type: 'GET_PREPARED_CONTEXT', chatId: 'room', outgoing: draft });
  assert.doesNotMatch(prepared.content, /세린은/);
});
