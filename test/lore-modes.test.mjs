import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../extension/engine/engine.js', import.meta.url), 'utf8');
const engine = vm.runInNewContext(`${source}\nCrackMatrixEngine`);
const ids = list => Array.from(list, item => item.id);

test('always-on and keyword-triggered lore come first; keyword-only lore never enters by search', () => {
  const lores = [
    { id: 'always', title: '기본 규칙', content: '시간은 앞으로만 흐른다.', alwaysInclude: true },
    { id: 'key', title: '은빛 열쇠', keywords: ['은빛 열쇠'], content: '지하 서고 문을 연다.' },
    { id: 'strict', title: '창고', keywords: ['창고'], triggerType: 'keyword', content: '지하 서고 옆 식량 창고.' },
    { id: 'other', title: '북문', content: '성의 북쪽 관문.' }
  ];
  const picked = engine.selectLore(lores, '은빛 열쇠로 지하 서고를 연다');
  assert.deepEqual(ids(picked).slice(0, 2), ['always', 'key']);
  assert.ok(!ids(picked).includes('strict'));
  assert.equal(picked[1].why, '키워드: 은빛 열쇠');
});

test('lore is found through its content when no keyword matches', () => {
  const lores = [
    { id: 'heal', title: '푸른 잎', content: '상처의 출혈을 멎게 하고 회복을 돕는 약초. 출혈이 심한 상처에 짓이겨 바른다.' },
    { id: 'poison', title: '붉은 잎', content: '마비를 일으키는 독성 식물.' },
    { id: 'rope', title: '밧줄', content: '성벽을 오르는 데 쓰는 튼튼한 밧줄.' }
  ];
  assert.equal(engine.selectLore(lores, '출혈을 멎게 하는 약초가 필요해')[0]?.id, 'heal');
  assert.deepEqual(ids(engine.selectLore(lores, '오늘 저녁은 뭘 먹지')), [], 'nothing relevant, nothing added');
});

test('relations in lore and remembered facts bring the right lore, never from a future turn', () => {
  const lores = [
    { id: 'moonblade', title: '월광검', content: '달빛으로 환영을 벤다.', relations: [['아린', '사용', '월광검']] },
    { id: 'silver', title: '은빛 열쇠', content: '지하 서고의 문을 연다.' },
    { id: 'bronze', title: '청동 열쇠', content: '북문 창고의 문을 연다.' }
  ];
  assert.equal(engine.selectLore(lores, '아린이 쓰는 무기는?', { userQuery: '아린이 쓰는 무기는?', turn: 10 })[0]?.id, 'moonblade');
  const facts = [{ keyword: '서령', fact: '서령은 은빛 열쇠를 맡겼다.', turn: 7 }];
  const query = '서령이 맡긴 물건으로 무엇을 열지?';
  assert.equal(engine.selectLore(lores, query, { userQuery: query, turn: 10, facts })[0]?.id, 'silver');
  assert.ok(!ids(engine.selectLore(lores, query, { userQuery: query, turn: 6, facts })).includes('silver'),
    'a fact from a later turn cannot provide the relation');
});

test('meaning search admits the clearly closest lore and joins the ranking', () => {
  const lores = [
    { id: 'a', title: '가문 규율', content: '글레이드 가문의 메이드는 주인에게 감정을 품지 않는다.' },
    { id: 'b', title: '연무장', content: '쿼드리비움의 훈련장.' },
    { id: 'c', title: '성검', content: '황실 보물고에 잠든 검.' },
    { id: 'd', title: '북문', content: '성의 북쪽 관문.' },
    { id: 'e', title: '약초', content: '출혈을 멎게 한다.' }
  ];
  const query = '샤일은 왜 나한테 마음을 숨길까';
  assert.deepEqual(ids(engine.selectLore(lores, query)), [], 'no words in common');
  const clear = new Map([['a', 0.86], ['b', 0.80], ['c', 0.79], ['d', 0.79], ['e', 0.78]]);
  assert.deepEqual(ids(engine.selectLore(lores, query, { semantic: clear })), ['a']);
  const flat = new Map([['a', 0.81], ['b', 0.80], ['c', 0.80], ['d', 0.79], ['e', 0.79]]);
  assert.deepEqual(ids(engine.selectLore(lores, query, { semantic: flat })), [], 'no clear winner, nothing added');
});

test('selected lore reaches the outgoing context within budget', () => {
  const query = '아린이 쓰는 무기는?';
  const res = engine.contextWithAll(null, [], query, {
    loreList: [{ id: 'moonblade', title: '월광검', content: '환영을 벤다.', relations: [['아린', '사용', '월광검']] }],
    budget: 2000, currentTurn: 10
  });
  assert.equal(res.selectedLore[0]?.id, 'moonblade');
  assert.ok(engine.composeUser(query, res.selected, 2000).includes('설정·월광검'));
});

test('relations are read from the lore text when none are written', () => {
  const lores = [
    { id: 'moonblade', title: '월광검', content: '달빛을 모아 환영을 베는 검. 성소 기사 아린의 무기다.' },
    { id: 'arin', title: '아린', content: '성소의 기사. 늘 웃는다.' },
    { id: 'sunlance', title: '태양창', content: '햇빛을 모아 갑옷을 관통하는 창. 도윤이 사용한다.' },
    { id: 'doyun', title: '도윤', content: '북문 수비대장.' }
  ];
  const ask = query => ids(engine.selectLore(lores, query, { userQuery: query, turn: 10 }));
  assert.equal(ask('아린이 쓰는 무기는?')[0], 'moonblade');
  assert.equal(ask('도윤이 쓰는 무기는?')[0], 'sunlance');
});

test('a keyword triggers only as its own word, particles allowed', () => {
  const lores = [
    { id: 'ring', title: '약혼 반지', keywords: ['반지'], triggerType: 'keyword', content: '서령이 준 은반지.' },
    { id: 'car', title: '차', keywords: ['차'], triggerType: 'keyword', content: '아린의 검은 세단.' }
  ];
  assert.deepEqual(ids(engine.selectLore(lores, '반지갑을 열자 차갑게 웃었다')), []);
  assert.deepEqual(ids(engine.selectLore(lores, '반지를 끼고 차에 탔다')).sort(), ['car', 'ring']);
  assert.ok(engine.keywordAppears('그건 아린이었다', '아린'));
  assert.ok(engine.keywordAppears('은빛열쇠로', '은빛 열쇠'));
  assert.ok(!engine.keywordAppears('월광검술', '월광검'));
});
