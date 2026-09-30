import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import vm from 'node:vm';

const fixture = JSON.parse(readFileSync(new URL('../test/fixtures/lore-benchmark.json', import.meta.url)));
const engineCode = readFileSync(new URL('../extension/engine/engine.js', import.meta.url), 'utf8');
const engine = vm.runInNewContext(`${engineCode}\nCrackMatrixEngine`);
const lores = fixture.lores.map(lore => ({ ...lore, enabled: true, triggerType: 'both' }));
const cases = fixture.cases;
const loreText = lore => `${lore.title} ${(lore.keywords || []).join(' ')} ${lore.content}`;
const norm = value => String(value || '').normalize('NFKC').toLowerCase();

const units = lores.map((lore, order) => ({
  unitId: lore.id,
  messageId: lore.id,
  role: 'lore',
  pos: 0,
  order,
  text: loreText(lore),
  len: loreText(lore).length
}));
const index = engine.index(units);
const bm25Index = { ...index, lsa: null };

const df = new Map();
const tf = lores.map(lore => {
  const counts = new Map();
  for (const term of engine.terms(loreText(lore))) counts.set(term, (counts.get(term) || 0) + 1);
  for (const term of counts.keys()) df.set(term, (df.get(term) || 0) + 1);
  return counts;
});
const idf = term => Math.log((lores.length + 1) / ((df.get(term) || 0) + 1)) + 1;
const vector = counts => {
  const out = new Map();
  for (const [term, count] of counts) out.set(term, (1 + Math.log(count)) * idf(term));
  const length = Math.hypot(...out.values()) || 1;
  for (const [term, value] of out) out.set(term, value / length);
  return out;
};
const docVectors = tf.map(vector);
const cosine = (a, b) => {
  let dot = 0;
  for (const [key, value] of a) dot += value * (b.get(key) || 0);
  return dot;
};

const predicatePatterns = {
  sibling: /언니|누나|동생|형제|자매/,
  wield: /무기|검은|검을|창은|쓰는|사용|휘두/,
  entrust: /맡겼|맡긴|맡겼던|맡기/,
  receive: /받은|받았|얻은|얻었/,
  store: /보관|맡아둔|맡아 둔/,
  hide: /숨긴|숨겨|숨겼|감춘/,
  open: /열 수|열어|여는|봉인 해제/,
  signal: /신호|봉화|연기/,
  heal: /치료|회복|출혈|상처/,
  poison: /독|마비/,
  prove: /증명|진위|허가/,
  allow: /통행|건너|넘으/,
  trade: /거래|교환/
};
const predicates = text => new Set(Object.entries(predicatePatterns)
  .filter(([, pattern]) => pattern.test(text)).map(([predicate]) => predicate));
const allTriples = [
  ...lores.flatMap(lore => (lore.relations || []).map(([subject, predicate, object]) => ({
    subject, predicate, object, turn: 0, source: 'lore'
  }))),
  ...fixture.events.map(event => ({ ...event, source: 'event' }))
];
const entities = [...new Set(allTriples.flatMap(edge => [edge.subject, edge.object])
  .concat(lores.map(lore => lore.title)))].filter(entity => entity.length >= 2);
const mentions = text => new Set(entities.filter(entity => norm(text).includes(norm(entity))));
const activeTriples = item => allTriples.filter(edge => edge.turn <= item.turn);
const targetName = lore => norm(lore.title);

function inferredTargets(item, direct, verbs) {
  const target = new Map();
  for (const edge of activeTriples(item)) {
    if (!direct.has(edge.subject) || !verbs.has(edge.predicate)) continue;
    const weight = edge.source === 'event' ? Math.exp(-(item.turn - edge.turn) / 50) : 1;
    target.set(norm(edge.object), Math.max(target.get(norm(edge.object)) || 0, weight));
  }
  return target;
}

function add(map, key, amount) {
  map.set(key, (map.get(key) || 0) + amount);
}
const graphVectors = lores.map(lore => {
  const vec = new Map();
  add(vec, `e:${norm(lore.title)}`, 2);
  for (const [subject, predicate, object] of lore.relations || []) {
    add(vec, `e:${norm(subject)}`, 0.5);
    add(vec, `e:${norm(object)}`, 0.5);
    add(vec, `p:${predicate}`, 0.5);
    add(vec, `sp:${norm(subject)}:${predicate}`, 1.5);
  }
  const length = Math.hypot(...vec.values()) || 1;
  for (const [key, value] of vec) vec.set(key, value / length);
  return vec;
});

const queryFor = item => item.recent ? `${item.query} ${item.recent}` : item.query;
const sortScores = scores => scores
  .filter(hit => hit.score > 0)
  .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));

// Baselines are computed here; "live_selectLore" is what the extension ships.
const engines = {
  bm25(item) {
    return engine.search(bm25Index, queryFor(item))
      .map(hit => ({ id: hit.messageId, score: hit.score }));
  },
  bm25_lsa(item) {
    return engine.search(index, queryFor(item))
      .map(hit => ({ id: hit.messageId, score: hit.score }));
  },
  tfidf_cosine(item) {
    const counts = new Map();
    for (const term of engine.terms(queryFor(item))) counts.set(term, (counts.get(term) || 0) + 1);
    const q = vector(counts);
    return sortScores(lores.map((lore, index) => ({ id: lore.id, score: cosine(q, docVectors[index]) })));
  },
  spo_ast(item) {
    const direct = mentions(item.query);
    const verbs = predicates(item.query);
    const targets = inferredTargets(item, direct, verbs);
    return sortScores(lores.map(lore => ({
      id: lore.id,
      score: (targets.get(targetName(lore)) || 0) + (direct.has(lore.title) ? 0.4 : 0)
    })));
  },
  relation_vector(item) {
    const direct = mentions(item.query);
    const recent = mentions(item.recent || '');
    const verbs = predicates(item.query);
    const targets = inferredTargets(item, direct, verbs);
    const vec = new Map();
    for (const entity of direct) add(vec, `e:${norm(entity)}`, 1);
    for (const entity of recent) add(vec, `e:${norm(entity)}`, 0.45);
    for (const verb of verbs) add(vec, `p:${verb}`, 0.6);
    for (const entity of direct) for (const verb of verbs) add(vec, `sp:${norm(entity)}:${verb}`, 1.2);
    for (const [entity, weight] of targets) add(vec, `e:${entity}`, 1.8 * weight);
    const length = Math.hypot(...vec.values()) || 1;
    for (const [key, value] of vec) vec.set(key, value / length);
    return sortScores(lores.map((lore, index) => ({ id: lore.id, score: cosine(vec, graphVectors[index]) })));
  }
};

const eventVerb = { entrust: '맡겼다', receive: '받았다', store: '보관했다', hide: '숨겼다', give: '건넸다' };
const memoryFacts = fixture.events.map(event => ({
  keyword: event.subject,
  fact: `${event.subject}은 ${event.object}를 ${eventVerb[event.predicate] || event.predicate}.`,
  turn: event.turn
}));
// What the extension ships: keyword/always first, then BM25 and relation fused by rank.
engines.live_selectLore = item => engine.selectLore(lores, queryFor(item), {
  userQuery: item.query, recentContext: item.recent || '',
  facts: memoryFacts, turn: item.turn, budget: 600
}).map((lore, index) => ({ id: lore.id, score: 1 - index * 0.001 }));

// The same, with every hand-written relation removed: what text-derived relations recover.
const withoutRelations = lores.map(({ relations, ...lore }) => lore);
engines.live_selectLore_no_relations = item => engine.selectLore(withoutRelations, queryFor(item), {
  userQuery: item.query, recentContext: item.recent || '',
  facts: memoryFacts, turn: item.turn, budget: 600
}).map((lore, index) => ({ id: lore.id, score: 1 - index * 0.001 }));

const densePath = process.argv[2];
if (densePath) {
  const dense = JSON.parse(readFileSync(densePath, 'utf8'));
  if (dense.model !== 'sentence-transformers/paraphrase-multilingual-mpnet-base-v2') throw Error('Unknown dense score source');
  engines.dense_cosine = item => sortScores(lores.map(lore => ({
    id: lore.id,
    score: dense.scores[item.id]?.[lore.id] || 0
  })));
}

function chooseThreshold(devRows) {
  const scores = [...new Set(devRows.flatMap(row => row.ranked.map(hit => hit.score)))].sort((a, b) => a - b);
  const candidates = [-Infinity, 0, ...scores, ...scores.map(score => score + 1e-8)];
  let best = { threshold: 0, correct: -1 };
  for (const threshold of candidates) {
    const correct = devRows.filter(row => (row.ranked[0]?.score > threshold ? row.ranked[0].id : null) === row.item.gold).length;
    if (correct > best.correct || (correct === best.correct && threshold > best.threshold)) best = { threshold, correct };
  }
  return best.threshold;
}

function metrics(rows, threshold) {
  const positive = rows.filter(row => row.item.gold);
  const negative = rows.filter(row => !row.item.gold);
  const pick = row => row.ranked[0]?.score > threshold ? row.ranked[0].id : null;
  return {
    cases: rows.length,
    positive: positive.length,
    negative: negative.length,
    top1_positive: positive.filter(row => pick(row) === row.item.gold).length,
    top3_positive: positive.filter(row => row.ranked.slice(0, 3).some(hit => hit.id === row.item.gold)).length,
    abstain_negative: negative.filter(row => pick(row) === null).length,
    accuracy: rows.filter(row => pick(row) === row.item.gold).length
  };
}

const output = { fixture: fixture.description, lores: lores.length, cases: cases.length, engines: {} };
for (const [name, run] of Object.entries(engines)) {
  const rows = cases.map(item => ({ item, ranked: run(item) }));
  const threshold = name === 'current' || name.startsWith('live_') ? 0
    : chooseThreshold(rows.filter(row => row.item.split === 'dev'));
  const iterations = name === 'dense_cosine' ? 0 : 200;
  const start = performance.now();
  for (let i = 0; i < iterations; i++) for (const item of cases) run(item);
  const msPerQuery = iterations ? (performance.now() - start) / (iterations * cases.length) : null;
  output.engines[name] = {
    threshold: Number.isFinite(threshold) ? threshold : null,
    msPerQuery,
    dev: metrics(rows.filter(row => row.item.split === 'dev'), threshold),
    test: metrics(rows.filter(row => row.item.split === 'test'), threshold),
    rows: rows.filter(row => row.item.split === 'test').map(row => ({
      id: row.item.id,
      type: row.item.type,
      gold: row.item.gold,
      picked: row.ranked[0]?.score > threshold ? row.ranked[0].id : null,
      score: row.ranked[0]?.score || 0,
      top3: row.ranked.slice(0, 3).map(hit => hit.id)
    }))
  };
}
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
