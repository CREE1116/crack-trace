// Retrieval benchmark: compare no-LLM retrieval variants on an exported chat.
//
//   node tools/retrieval-bench.mjs <chat.txt> <queries.json> [--embed <dir with @huggingface/transformers>]
//
// chat.txt:     a Trace export (.txt)
// queries.json: [["query the player might type", ["phrase only the right passage contains", ...]], ...]
// Chats and queries are personal data: keep them out of the repository.
//
// Prints hit@1, hit@3, hit@10 (Trace injects up to ten passages) and MRR per variant.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const engine = require('../extension/engine/engine.js');

const [chatPath, queriesPath] = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const embedAt = process.argv.indexOf('--embed');
const embedDir = embedAt > 0 ? process.argv[embedAt + 1] : '';
if (!chatPath || !queriesPath) {
  console.error('usage: node tools/retrieval-bench.mjs <chat.txt> <queries.json> [--embed <dir>]');
  process.exit(1);
}

const messages = readFileSync(chatPath, 'utf8').replace(/^#.*\n/gm, '').split(/\n\s*────────────────\s*\n/).map(part => {
  const label = part.match(/^\s*\[([^\]\n]+)\]\n/);
  return { role: label && /유저|user/i.test(label[1]) ? 'user' : 'assistant', text: label ? part.slice(label[0].length) : part };
});
const cases = JSON.parse(readFileSync(queriesPath, 'utf8'));
const pix = engine.buildPassageIndex(messages);
const units = pix.units;
const goldOf = phrases => new Set(units.map((unit, i) => (phrases.some(p => unit.text.includes(p)) ? i : -1)).filter(i => i >= 0));
const valid = cases.filter(([, phrases]) => goldOf(phrases).size);
console.log(`messages ${messages.length} · passages ${units.length} · queries ${valid.length}/${cases.length}\n`);

const byUnit = new Map(units.map((unit, i) => [unit.unitId, i]));
const scoresFrom = hits => {
  const scores = new Float64Array(units.length);
  for (const hit of hits) scores[byUnit.get(hit.unitId)] += hit.score;
  return scores;
};
const order = scores => [...scores.keys()].sort((a, b) => scores[b] - scores[a]);
const normalize = scores => {
  const max = Math.max(...scores);
  return max > 0 ? scores.map(s => s / max) : scores;
};

// Variant: strip particles and endings before indexing, so "열쇠를"/"열쇠는" meet as "열쇠" and
// common pieces like "에서" or "했다" stop matching everything.
const ENDING = /(?:에게서|에서는|으로는|이라고|라고|에서|에게|한테|으로|로서|처럼|까지|부터|보다|하고|이랑|께서|은|는|이|가|을|를|의|와|과|에|로|도|만)$/u;
const stem = text => String(text).replace(/[가-힣]{2,}/g, word => {
  const cut = word.replace(ENDING, '');
  return cut.length >= 2 ? cut : word;
});
const stemIx = engine.index(units.map(unit => ({ ...unit, text: stem(unit.text) })));

// Variant: pseudo-relevance feedback. Words frequent in the top three passages and rare overall
// are searched again at a low weight.
function prf(query, ix, prep = text => text) {
  const first = engine.search(ix, prep(query));
  const base = scoresFrom(first);
  const top = order(base).slice(0, 3);
  const counts = new Map();
  for (const i of top) for (const word of prep(units[i].text).match(/[가-힣]{2,}/g) || []) counts.set(word, (counts.get(word) || 0) + 1);
  const queryWords = new Set(prep(query).match(/[가-힣]{2,}/g) || []);
  const expansion = [...counts].filter(([word, n]) => n >= 2 && !queryWords.has(word) && (ix.df.get(word) || 0) <= units.length * 0.05)
    .sort((a, b) => b[1] - a[1]).slice(0, 5).map(([word]) => word);
  if (!expansion.length) return base;
  const extra = normalize(scoresFrom(engine.search(ix, expansion.join(' '))));
  const max = Math.max(...base) || 1;
  return base.map((s, i) => s + 0.3 * max * extra[i]);
}

// Reciprocal rank fusion: combine rankings without comparing their score scales.
const rrf = (...rankings) => {
  const scores = new Float64Array(units.length);
  for (const ranking of rankings) ranking.forEach((i, rank) => { scores[i] += 1 / (60 + rank); });
  return order(scores);
};

function evaluate(name, rankFor) {
  let hit1 = 0, hit3 = 0, hit10 = 0, mrr = 0;
  for (const [query, phrases] of valid) {
    const gold = goldOf(phrases);
    const rank = rankFor(query).findIndex(i => gold.has(i)) + 1;
    if (rank === 1) hit1++;
    if (rank && rank <= 3) hit3++;
    if (rank && rank <= 10) hit10++;
    if (rank) mrr += 1 / rank;
  }
  const n = valid.length;
  console.log(`${name.padEnd(24)} hit@1 ${String(hit1).padStart(2)}  hit@3 ${String(hit3).padStart(2)}  hit@10 ${String(hit10).padStart(2)}  /${n}  MRR ${(mrr / n).toFixed(2)}`);
}

const lexical = query => order(scoresFrom(engine.search(pix.ix, query)));
const stemmed = query => order(scoresFrom(engine.search(stemIx, stem(query))));
const expanded = query => order(prf(query, stemIx, stem));

evaluate('lexical (current)', lexical);
evaluate('stemmed', stemmed);
evaluate('stemmed + PRF', expanded);
evaluate('RRF lexical+stemmed', query => rrf(lexical(query), stemmed(query)));

if (embedDir) {
  const { pipeline } = await import(pathToFileURL(require.resolve('@huggingface/transformers', { paths: [embedDir] })).href);
  const embed = await pipeline('feature-extraction', 'Xenova/multilingual-e5-small', { dtype: 'q8' });
  const started = Date.now();
  const vectors = [];
  for (const unit of units) vectors.push((await embed(`passage: ${unit.text}`, { pooling: 'mean', normalize: true })).data);
  console.log(`\nembedded ${units.length} passages in ${((Date.now() - started) / 1000).toFixed(0)}s`);
  const queryVectors = new Map();
  let queryMs = 0;
  for (const [query] of valid) {
    const t = Date.now();
    queryVectors.set(query, (await embed(`query: ${query}`, { pooling: 'mean', normalize: true })).data);
    queryMs += Date.now() - t;
  }
  console.log(`query embedding ${(queryMs / valid.length).toFixed(0)}ms each\n`);
  const cosine = query => {
    const q = queryVectors.get(query);
    return Float64Array.from(vectors.map(v => { let s = 0; for (let i = 0; i < v.length; i++) s += v[i] * q[i]; return s; }));
  };
  const semantic = query => order(cosine(query));
  const linear = (query, w) => {
    const lex = normalize(scoresFrom(engine.search(stemIx, stem(query))));
    const cos = cosine(query);
    const min = Math.min(...cos), max = Math.max(...cos);
    return order(lex.map((l, i) => (1 - w) * l + w * (max > min ? (cos[i] - min) / (max - min) : 0)));
  };
  evaluate('embedding', semantic);
  evaluate('linear 0.7 stemmed+emb', query => linear(query, 0.7));
  evaluate('RRF lexical+emb', query => rrf(lexical(query), semantic(query)));
  evaluate('RRF stemmed+emb', query => rrf(stemmed(query), semantic(query)));
  evaluate('RRF stemmed+PRF+emb', query => rrf(stemmed(query), expanded(query), semantic(query)));
}
