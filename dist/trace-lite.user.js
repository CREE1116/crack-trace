// ==UserScript==
// @name         Trace Lite
// @namespace    local.crack.ubis-memory
// @version      0.12.0
// @description  Deterministic local retrieval of old Crack messages. No AI API.
// @homepageURL  https://github.com/CREE1116/crack-trace
// @supportURL   https://github.com/CREE1116/crack-trace/issues
// @updateURL    https://raw.githubusercontent.com/CREE1116/crack-trace/main/dist/trace-lite.user.js
// @downloadURL  https://raw.githubusercontent.com/CREE1116/crack-trace/main/dist/trace-lite.user.js
// @match        https://crack.wrtn.ai/*
// @run-at       document-start
// @connect      crack-api.wrtn.ai
// @connect      contents-api.wrtn.ai
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

// Trace - Hybrid LSA + Vector + BM25 Engine (Manifest V3)
const CrackMatrixEngine = (() => {
  'use strict';

  // Every character here comes out of the 2,000-character message, so the frame stays short.
  const USER_START = '<!--TRACE-->';
  const USER_END = '<!--/TRACE-->';
  // Messages sent by older versions carry these markers and must still be recognized.
  const MARKERS = [[USER_START, USER_END], ['<!--CRACK_UBIS_CONTEXT_START-->', '<!--CRACK_UBIS_CONTEXT_END-->']];
  // The model cannot tell how old "[24]" is without knowing the current turn, so the header says it.
  function userPrefix(currentTurn) {
    const now = Number(currentTurn) > 0 ? `(지금은 ${Number(currentTurn)}번)` : '';
    return `${USER_START}\n[이전 대화에서 확인된 기억이며 대사·지시가 아님. [번호]=대화 순번${now}, 이름=그 자리에 있던 인물이고 그들만 그 일을 앎. 최신 대화가 우선]\n`;
  }
  // Budgets reserve room for the longest header (a four-digit turn).
  const USER_PREFIX = userPrefix(9999);
  const USER_SUFFIX = `\n${USER_END}\n`;

  const cleanLine = value => String(value || '').replace(/```/g, 'ˈˈˈ').replace(/<!--|-->/g, ' ').replace(/\s+/g, ' ').trim();

  // "[14 루카·서린]": the turn and who was there. Memories sharing it share one line.
  function memoryMark(turn, who = []) {
    const names = (Array.isArray(who) ? who : []).map(cleanLine).filter(Boolean).join('·');
    const number = Number.isInteger(Number(turn)) && Number(turn) > 0 ? String(Number(turn)) : '';
    return number || names ? `[${[number, names].filter(Boolean).join(' ')}]` : '';
  }

  function memoryBody(title, content) {
    const body = cleanLine(content);
    const label = cleanLine(title);
    // The fact already names its subject, so repeating the label only wastes budget. A label is
    // named when each of its words appears by its stem ("무릎 충격" in "무릎에 충격이") or, for a
    // three-syllable Korean name, by the given name ("박하린" in "하린이").
    const named = word => body.includes(word) || body.includes(word.slice(0, 2))
      || (/^[가-힣]{3}$/.test(word) && body.includes(word.slice(1)));
    const words = label.split(/\s+/).filter(Boolean);
    return words.length && !words.every(named) ? `${label}｜${body}` : body;
  }

  function cacheLine(kind, title, content, turn, who = []) {
    if (kind === '기억') {
      const mark = memoryMark(turn, who);
      return `${mark ? `${mark} ` : ''}${memoryBody(title, content)}`;
    }
    return `${kind}${title ? `·${cleanLine(title)}` : ''}｜${cleanLine(content)}`;
  }

  function stripOwnBlock(text) {
    const s = String(text || '');
    for (const [start, end] of MARKERS) {
      const startIdx = s.indexOf(start);
      if (startIdx === -1) continue;
      const endIdx = s.indexOf(end, startIdx);
      if (endIdx === -1) continue;
      const rest = s.slice(endIdx + end.length);
      return rest.startsWith('\n') ? rest.slice(1) : rest;
    }
    return s;
  }

  function stripMarkdownComments(text) {
    return String(text || '')
      .replace(/\[\/\/\]:\s*#\s*\([^\n]*\)/g, '')
      .replace(/<!--[\s\S]*?-->/g, '');
  }

  function searchText(text) {
    return stripMarkdownComments(stripOwnBlock(text))
      .replace(/```(?:INFO)?[^`]*```/g, ' ')
      .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
      .replace(/\[(?:💼|🤝|📝)[^\]\n]*\][^\n]*/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function terms(text) {
    const raw = searchText(text).normalize('NFKC').toLowerCase();
    const result = [];
    const hangul = raw.match(/[가-힣]{2,}/g) || [];
    for (const w of hangul) {
      result.push(w);
      for (let i = 0; i < w.length - 1; i++) result.push(w.slice(i, i + 2));
    }
    const alnum = raw.match(/[a-z0-9_]{2,}/g) || [];
    for (const w of alnum) result.push(w);
    return result;
  }

  // A lore keyword must appear as its own word: "반지" in "반지를"/"반지야" but not in "반지갑",
  // "차" not in "차갑다". Korean particles (and the 이 a consonant-final name takes before them)
  // may follow; anything else glued on means a different word. Latin keywords need word edges.
  // Particles and endings that may stack after a name: 크리에게로, 채연만이, 허민한테는,
  // 아델라인과의, 권도윤이라면, 펜리스님이에요. Up to three in a row; longest first.
  const KEYWORD_PARTICLES = ['으로부터', '에게서는', '한테서는', '이잖아', '이었다', '이에요', '이라면', '이라고', '이라는', '에게서', '한테서', '에서는', '으로는', '께서', '에게', '한테', '에서', '으로', '로서', '로써', '부터', '까지', '보다', '처럼', '만큼', '이랑', '하고', '이라', '이며', '이고', '이나', '이든', '이야', '이다', '였다', '라고', '라는', '라면', '인데', '인가', '인지', '잖아', '에요', '예요', '라도', '마저', '조차', '밖에', '대로', '뿐', '들', '은', '는', '이', '가', '을', '를', '의', '에', '께', '도', '만', '와', '과', '랑', '로', '아', '야', '여', '씨', '님', '요', '다', '인', '나'];
  const KEYWORD_TAIL = `(?:${KEYWORD_PARTICLES.join('|')}){0,3}`;
  const keywordPatterns = new Map();
  function keywordAppears(text, keyword) {
    const kw = String(keyword || '').normalize('NFKC').toLowerCase().trim();
    if (!kw) return false;
    let pattern = keywordPatterns.get(kw);
    if (!pattern) {
      const body = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s*');
      pattern = /[가-힣]$/.test(kw)
        ? new RegExp(`(?:^|[^가-힣a-z0-9_])${body}${KEYWORD_TAIL}(?![가-힣a-z0-9_])`, 'u')
        : new RegExp(`(?:^|[^a-z0-9_])${body}(?![a-z0-9_])`, 'u');
      if (keywordPatterns.size > 2000) keywordPatterns.clear();
      keywordPatterns.set(kw, pattern);
    }
    return pattern.test(String(text || '').normalize('NFKC').toLowerCase());
  }

  function unitsFromMessages(messages, chatId, minLen = 50, maxLen = 220) {
    const units = [];
    let order = 0;
    for (const message of messages) {
      const id = String(message.id ?? message._id ?? '');
      const role = String(message.role ?? 'assistant');
      const clean = searchText(message.text ?? message.content ?? '');
      if (!id || clean.length < minLen) continue;

      let pos = 0;
      while (pos < clean.length) {
        let end = pos + maxLen;
        if (end < clean.length) {
          const cut = clean.lastIndexOf(' ', end);
          if (cut > pos + Math.floor(maxLen * 0.6)) end = cut;
        } else end = clean.length;

        const slice = clean.slice(pos, end).trim();
        if (slice.length >= minLen) {
          units.push({
            unitId: `${chatId}:${id}:${pos}`,
            messageId: id,
            role,
            pos,
            order: order++,
            text: slice,
            len: slice.length
          });
        }
        if (end >= clean.length) break;
        pos += Math.max(1, maxLen - 40);
      }
    }
    return units;
  }

  function computeLSA(docs, df, K = 8) {
    const D = docs.length;
    if (D < K * 2) return null;

    const vocab = [];
    const vocabIndex = new Map();
    for (const [term, freq] of df.entries()) {
      if (freq >= 2 && freq <= D * 0.75 && /^[가-힣a-z0-9]{2,}$/.test(term)) {
        vocabIndex.set(term, vocab.length);
        vocab.push(term);
      }
    }
    const V = vocab.length;
    if (V < K * 2) return null;

    const A = new Array(D);
    for (let i = 0; i < D; i++) {
      const row = new Float32Array(V);
      const doc = docs[i];
      for (const [term, tf] of doc.tf.entries()) {
        const j = vocabIndex.get(term);
        if (j !== undefined) {
          const idf = Math.log(1 + (D - (df.get(term) || 0) + 0.5) / ((df.get(term) || 0) + 0.5));
          row[j] = Math.sqrt(tf) * Math.max(0.1, idf);
        }
      }
      const norm = Math.hypot(...row);
      if (norm > 1e-8) for (let j = 0; j < V; j++) row[j] /= norm;
      A[i] = row;
    }

    const residualA = A.map(row => new Float32Array(row));
    const Vt = [];

    for (let k = 0; k < K; k++) {
      const v = new Float32Array(V);
      for (let j = 0; j < V; j++) v[j] = Math.sin((k + 1) * (j + 1));
      let vNorm = Math.hypot(...v);
      for (let j = 0; j < V; j++) v[j] /= vNorm;

      for (let iter = 0; iter < 12; iter++) {
        const u = new Float32Array(D);
        for (let i = 0; i < D; i++) {
          let sum = 0;
          const row = residualA[i];
          for (let j = 0; j < V; j++) sum += row[j] * v[j];
          u[i] = sum;
        }
        const uNorm = Math.hypot(...u);
        if (uNorm < 1e-8) break;
        for (let i = 0; i < D; i++) u[i] /= uNorm;

        const nextV = new Float32Array(V);
        for (let i = 0; i < D; i++) {
          const ui = u[i];
          if (ui === 0) continue;
          const row = residualA[i];
          for (let j = 0; j < V; j++) nextV[j] += ui * row[j];
        }
        vNorm = Math.hypot(...nextV);
        if (vNorm < 1e-8) break;
        for (let j = 0; j < V; j++) v[j] = nextV[j] / vNorm;
      }

      const Av = new Float32Array(D);
      for (let i = 0; i < D; i++) {
        let sum = 0;
        const row = residualA[i];
        for (let j = 0; j < V; j++) sum += row[j] * v[j];
        Av[i] = sum;
      }
      const sigma = Math.hypot(...Av);
      if (sigma < 1e-6) break;
      Vt.push(v);
      for (let i = 0; i < D; i++) {
        const avi = Av[i];
        const row = residualA[i];
        for (let j = 0; j < V; j++) row[j] -= avi * v[j];
      }
    }

    if (!Vt.length) return null;

    const docVectors = new Array(D);
    for (let i = 0; i < D; i++) {
      const vec = new Float32Array(Vt.length);
      const row = A[i];
      for (let k = 0; k < Vt.length; k++) {
        const vk = Vt[k];
        let sum = 0;
        for (let j = 0; j < V; j++) sum += row[j] * vk[j];
        vec[k] = sum;
      }
      const norm = Math.hypot(...vec);
      if (norm > 1e-8) {
        for (let k = 0; k < Vt.length; k++) vec[k] /= norm;
      }
      docVectors[i] = vec;
    }

    return { vocab, vocabIndex, Vt, docVectors };
  }

  function queryTopicVector(lsa, queryTerms) {
    if (!lsa || !lsa.Vt.length) return null;
    const { vocabIndex, Vt } = lsa;
    const qRow = new Float32Array(lsa.vocab.length);
    let matched = 0;
    for (const term of queryTerms) {
      const idx = vocabIndex.get(term);
      if (idx !== undefined) {
        qRow[idx] += 1;
        matched++;
      }
    }
    if (!matched) return null;
    const vec = new Float32Array(Vt.length);
    for (let k = 0; k < Vt.length; k++) {
      const vk = Vt[k];
      let sum = 0;
      for (let j = 0; j < qRow.length; j++) sum += qRow[j] * vk[j];
      vec[k] = sum;
    }
    const norm = Math.hypot(...vec);
    if (norm < 1e-8) return null;
    for (let k = 0; k < Vt.length; k++) vec[k] /= norm;
    return vec;
  }

  function index(units, options = {}) {
    const docs = units.map(unit => {
      const tf = new Map();
      for (const term of terms(unit.text)) tf.set(term, (tf.get(term) || 0) + 1);
      const koreanWords = [...tf.keys()].filter(term => /^[가-힣]{3,}$/.test(term));
      return { unit, tf, koreanWords, length: [...tf.values()].reduce((a, b) => a + b, 0) };
    });
    const df = new Map();
    for (const doc of docs) for (const term of doc.tf.keys()) df.set(term, (df.get(term) || 0) + 1);
    const avg = docs.reduce((sum, doc) => sum + doc.length, 0) / (docs.length || 1);
    const entities = new Set();
    for (const doc of docs) {
      for (const match of doc.unit.text.matchAll(/💬\s*([가-힣]{2,8})\s*\|/g)) entities.add(match[1].toLowerCase());
    }
    const lsa = options.lsa === false ? null : computeLSA(docs, df, 8);
    return { docs, df, entities, avg: Math.max(1, avg), lsa };
  }

  function search(ix, query, options = {}) {
    const queryTerms = [...new Set(terms(query).slice(-120))];
    if (!queryTerms.length) return [];
    const n = ix.docs.length;
    const maxOrder = options.maxOrder ?? Infinity;
    const qTopic = ix.lsa ? queryTopicVector(ix.lsa, queryTerms) : null;
    const ranked = [];

    for (let docIdx = 0; docIdx < ix.docs.length; docIdx++) {
      const doc = ix.docs[docIdx];
      if (doc.unit.order >= maxOrder) continue;
      let score = 0;
      const matched = [];
      const strong = [];

      for (const term of queryTerms) {
        const tf = doc.tf.get(term) || 0;
        if (!tf) {
          if (/^[가-힣]{3,}$/.test(term) && doc.koreanWords.some(word => word.startsWith(term))) {
            score += 2.5;
            matched.push(term);
          }
          continue;
        }
        matched.push(term);
        const dfVal = ix.df.get(term) || 1;
        const idf = Math.log(1 + (n - dfVal + 0.5) / (dfVal + 0.5));
        const tfNorm = (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (doc.length / ix.avg)));
        const termScore = tfNorm * idf;
        score += termScore;
        if (term.length >= 3 && termScore >= 1.5) strong.push(term);
      }

      if (qTopic && ix.lsa.docVectors[docIdx]) {
        const dTopic = ix.lsa.docVectors[docIdx];
        let dot = 0;
        for (let k = 0; k < qTopic.length; k++) dot += qTopic[k] * dTopic[k];
        if (dot > 0.15) score += dot * 4.0;
      }

      if (score > 0) {
        ranked.push({
          unitId: doc.unit.unitId,
          messageId: doc.unit.messageId,
          role: doc.unit.role,
          pos: doc.unit.pos,
          order: doc.unit.order,
          text: doc.unit.text,
          score,
          matched: [...new Set(matched)],
          strong: [...new Set(strong)]
        });
      }
    }
    ranked.sort((a, b) => b.score - a.score || a.order - b.order);
    return ranked;
  }

  function groupByMessage(ranked) {
    const seen = new Set();
    const grouped = [];
    for (const hit of ranked) {
      if (!seen.has(hit.messageId)) {
        seen.add(hit.messageId);
        grouped.push(hit);
      }
    }
    return grouped;
  }

  // --- Hybrid Keyword + Semantic Vector Lore Matching ---
  const lorePredicatePatterns = {
    sibling: /언니|누나|동생|형제|자매|가족/,
    wield: /무기|검은|검을|창은|쓰는|사용|휘두/,
    entrust: /맡겼|맡긴|맡기|맡김/,
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
  const loreNorm = value => String(value || '').normalize('NFKC').toLowerCase().trim();
  const loreVerbs = value => new Set(Object.entries(lorePredicatePatterns)
    .filter(([, pattern]) => pattern.test(String(value || ''))).map(([name]) => name));
  const loreAdd = (map, key, weight) => map.set(key, (map.get(key) || 0) + weight);
  const loreCosine = (a, b) => {
    let dot = 0;
    for (const [key, weight] of a) dot += weight * (b.get(key) || 0);
    return dot;
  };
  const loreUnitVector = vector => {
    const length = Math.hypot(...vector.values()) || 1;
    for (const [key, weight] of vector) vector.set(key, weight / length);
    return vector;
  };
  let loreVectorCache = null;
  let loreGraphCache = null;
  function loreCorpus(lore) {
    return `${lore.title || ''} ${(Array.isArray(lore.keywords) ? lore.keywords : String(lore.keywords || '').split(',')).join(' ')} ${lore.content || ''}`;
  }
  function loreCache(items) {
    const signature = JSON.stringify(items.map(item => [item.id, item.title, item.keywords, item.content, item.relations]));
    if (loreVectorCache?.signature === signature) return loreVectorCache;
    const units = items.map((item, order) => ({
      unitId: `lore:${order}`, messageId: String(order), role: 'lore', pos: 0,
      order, text: loreCorpus(item), len: loreCorpus(item).length
    }));
    const ix = index(units, { lsa: false });
    loreVectorCache = { signature, ix };
    return loreVectorCache;
  }
  // Relations read from the lore text itself, so nobody has to write "주체 > 관계 > 대상":
  // a sentence that names another lore (or someone memory knows) and a verb ("쓰는", "맡긴",
  // "숨긴"…) relates the two. Which way it points is unknown, so both ways are kept.
  function textRelations(items, names = []) {
    const known = new Map();
    for (const item of items) {
      for (const name of [item.title, ...(Array.isArray(item.keywords) ? item.keywords : [])]) {
        const alias = loreNorm(name);
        if (alias.length >= 2 && !known.has(alias)) known.set(alias, String(item.title || '').trim());
      }
    }
    for (const name of names) {
      const alias = loreNorm(name);
      if (alias.length >= 2 && !known.has(alias)) known.set(alias, String(name).trim());
    }
    const triples = items.map(() => []);
    items.forEach((item, i) => {
      const own = loreNorm(item.title);
      for (const sentence of String(item.content || '').split(/(?<=[.!?。…])\s+|\n+/)) {
        // Without a known verb, being named in the same sentence still ties the two together
        // ("mention" never answers a question like "who wields it", it only brings them close).
        const found = loreVerbs(sentence);
        const verbs = found.size ? found : new Set(['mention']);
        const text = loreNorm(sentence);
        const others = new Set([...known].filter(([alias, name]) => text.includes(alias) && loreNorm(name) !== own).map(([, name]) => name));
        for (const other of others) for (const verb of verbs) {
          triples[i].push([other, verb, item.title], [item.title, verb, other]);
        }
      }
    });
    return triples;
  }
  function loreRelations(items, facts, turn, derived = textRelations(items)) {
    const edges = [];
    for (const [i, item] of items.entries()) for (const triple of [...(item.relations || []), ...(derived[i] || [])]) {
      if (!Array.isArray(triple) || triple.length !== 3) continue;
      const [subject, rawPredicate, object] = triple.map(value => String(value || '').trim());
      const predicate = loreVerbs(rawPredicate).values().next().value || rawPredicate;
      if (subject && predicate && object) edges.push({ subject, predicate, object, turn: 0 });
    }
    const byAlias = new Map();
    for (const item of items) {
      const names = [item.title, ...(Array.isArray(item.keywords) ? item.keywords : [])];
      for (const name of names) {
        const alias = loreNorm(name);
        if (alias.length < 2) continue;
        if (!byAlias.has(alias)) byAlias.set(alias, new Set());
        byAlias.get(alias).add(item.title);
      }
    }
    const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const aliases = [...byAlias.keys()].sort((a, b) => b.length - a.length);
    const aliasPattern = aliases.length ? new RegExp(aliases.map(escapeRegex).join('|'), 'g') : null;
    for (const fact of facts || []) {
      const factTurn = Number(fact.turn) || 0;
      if (Number.isFinite(turn) && factTurn > turn) continue;
      const subject = String(fact.keyword || '').trim();
      const verbs = loreVerbs(fact.fact);
      if (!subject || !verbs.size || !aliasPattern) continue;
      const targets = new Set();
      for (const match of loreNorm(fact.fact).matchAll(aliasPattern)) {
        for (const title of byAlias.get(match[0]) || []) targets.add(title);
      }
      for (const title of targets) {
        if (loreNorm(subject) === loreNorm(title)) continue;
        edges.push({ subject, predicate: verbs.values().next().value, object: title, turn: factTurn });
      }
    }
    return edges;
  }
  function loreGraph(items, facts, turn) {
    const signature = JSON.stringify([
      items.map(item => [item.id, item.title, item.keywords, item.relations, item.content]),
      (facts || []).map(fact => [fact.id, fact.keyword, fact.fact, fact.turn]), turn
    ]);
    if (loreGraphCache?.signature === signature) return loreGraphCache;
    const derived = textRelations(items, (facts || []).map(fact => fact.keyword));
    const edges = loreRelations(items, facts, turn, derived);
    const entities = [...new Set([...items.map(item => item.title), ...edges.flatMap(edge => [edge.subject, edge.object])])]
      .filter(name => String(name).length >= 2);
    const vectors = items.map((item, i) => {
      const doc = new Map();
      loreAdd(doc, `e:${loreNorm(item.title)}`, 2);
      for (const triple of [...(item.relations || []), ...derived[i]]) {
        if (!Array.isArray(triple) || triple.length !== 3) continue;
        const [subject, rawPredicate, object] = triple;
        const predicate = loreVerbs(rawPredicate).values().next().value || rawPredicate;
        loreAdd(doc, `e:${loreNorm(subject)}`, 0.5);
        loreAdd(doc, `e:${loreNorm(object)}`, 0.5);
        loreAdd(doc, `p:${predicate}`, 0.5);
        loreAdd(doc, `sp:${loreNorm(subject)}:${predicate}`, 1.5);
      }
      return loreUnitVector(doc);
    });
    loreGraphCache = { signature, edges, entities, vectors };
    return loreGraphCache;
  }
  // BM25 over the lore text, or the relation vector (lore relations plus remembered facts).
  function scoreLore(items, query, { mode, userQuery = query, recentContext = '', facts = [], turn = Infinity } = {}) {
    const scores = new Map();
    if (mode === 'bm25') {
      for (const hit of search(loreCache(items).ix, query)) scores.set(Number(hit.messageId), hit.score);
      return scores;
    }
    const { edges, entities, vectors } = loreGraph(items, facts, turn);
    const mentioned = text => new Set(entities.filter(name => keywordAppears(text, name)));
    const direct = mentioned(userQuery);
    const recent = mentioned(recentContext);
    const verbs = loreVerbs(userQuery);
    const targets = new Map();
    for (const edge of edges) {
      if (!direct.has(edge.subject) || !verbs.has(edge.predicate)) continue;
      const weight = edge.turn ? Math.exp(-(Math.max(0, turn - edge.turn)) / 50) : 1;
      targets.set(loreNorm(edge.object), Math.max(targets.get(loreNorm(edge.object)) || 0, weight));
    }
    const q = new Map();
    for (const entity of direct) loreAdd(q, `e:${loreNorm(entity)}`, 1);
    for (const entity of recent) loreAdd(q, `e:${loreNorm(entity)}`, 0.45);
    for (const verb of verbs) loreAdd(q, `p:${verb}`, 0.6);
    for (const entity of direct) for (const verb of verbs) loreAdd(q, `sp:${loreNorm(entity)}:${verb}`, 1.2);
    for (const [entity, weight] of targets) loreAdd(q, `e:${entity}`, 1.8 * weight);
    loreUnitVector(q);
    items.forEach((item, i) => scores.set(i, loreCosine(q, vectors[i])));
    return scores;
  }

  const loreKey = (item, index) => String(item.id || item.title || `#${index}`);

  // One lore selector (measured on test/fixtures/lore-benchmark.json):
  //  1. "always" lore, and lore whose trigger keyword is in the player's draft, is always included
  //     and gets the budget first;
  //  2. the rest must pass BM25 (> 5), the relation vector (> 0.15) or carry a keyword from the
  //     recent scene; everything admitted is ordered by reciprocal-rank fusion of those rankings,
  //     so "아린이 쓰는 무기" puts 월광검 before 아린 even though 아린 was named;
  //  3. with sentence embeddings (semantic: key -> cosine) that ranking joins the fusion, and the
  //     closest lore is admitted when it stands clearly above the rest (top − median > 0.04).
  function selectLore(loreList, query, { budget = 650, userQuery = query, recentContext = '', facts = [], turn = Infinity, semantic = null } = {}) {
    const items = (Array.isArray(loreList) ? loreList : []).filter(item => item && item.content && item.enabled !== false);
    if (!items.length) return [];
    const lower = value => String(value || '').normalize('NFKC').toLowerCase();
    const draft = lower(userQuery);
    const text = lower(query);
    const keywordsOf = item => (Array.isArray(item.keywords) ? item.keywords : String(item.keywords || '').split(','))
      .map(kw => lower(kw).trim()).filter(Boolean);
    const why = new Map();
    const forced = [];
    // A trigger keyword in the player's own draft is decisive. One that only appears in the
    // surrounding context (the last reply) is a candidate ranked with the other evidence.
    const contextHits = [];
    items.forEach((item, i) => {
      if (item.alwaysInclude) { forced.push(i); why.set(i, '상시'); return; }
      const inDraft = keywordsOf(item).filter(kw => keywordAppears(draft, kw));
      if (inDraft.length) { forced.push(i); why.set(i, `키워드: ${inDraft.join(', ')}`); return; }
      const inContext = keywordsOf(item).filter(kw => keywordAppears(text, kw));
      if (inContext.length && item.triggerType === 'keyword') { forced.push(i); why.set(i, `키워드: ${inContext.join(', ')}`); return; }
      if (inContext.length) { contextHits.push(i); why.set(i, `키워드(직전 장면): ${inContext.join(', ')}`); }
    });
    // "키워드로만" lore never enters by search.
    const searchable = items.map((item, i) => i).filter(i => !forced.includes(i) && items[i].triggerType !== 'keyword');
    const options = { userQuery, recentContext, facts, turn };
    const rankBy = (scores, floor) => searchable.filter(i => (scores.get(i) || 0) > floor).sort((a, b) => scores.get(b) - scores.get(a));
    const bm25Scores = scoreLore(items, query, { ...options, mode: 'bm25' });
    const relationScores = scoreLore(items, query, { ...options, mode: 'relation' });
    const bm25 = rankBy(bm25Scores, 5);
    const relation = rankBy(relationScores, 0.15);
    const admitted = new Set([...bm25, ...relation, ...contextHits]);
    // Keyword hits are ranked by the same evidence as everything else; the keyword itself only
    // decides that they are in, not where.
    const pool = [...new Set([...forced.filter(i => !items[i].alwaysInclude), ...admitted])];
    const rankIn = scores => pool.filter(i => (scores.get(i) || 0) > 0).sort((a, b) => scores.get(b) - scores.get(a));
    const rankings = [rankIn(bm25Scores), rankIn(relationScores)];
    if (semantic?.size && searchable.length) {
      const cosines = searchable.map(i => [i, semantic.get(loreKey(items[i], i)) ?? -1]).sort((a, b) => b[1] - a[1]);
      rankings.push(cosines.map(([i]) => i));
      const values = cosines.map(([, c]) => c);
      if (values[0] - values[Math.floor(values.length / 2)] > 0.04) admitted.add(cosines[0][0]);
    }
    const fused = new Map();
    for (const ranking of rankings) ranking.forEach((i, rank) => { if (admitted.has(i) || forced.includes(i)) fused.set(i, (fused.get(i) || 0) + 1 / (60 + rank)); });
    for (const i of admitted) if (!why.has(i)) why.set(i, [bm25.includes(i) && '내용', relation.includes(i) && '관계', semantic?.size && '의미'].filter(Boolean).join('·') || '의미');
    const byFusion = (a, b) => (items[b].alwaysInclude ? 1 : 0) - (items[a].alwaysInclude ? 1 : 0) || (fused.get(b) || 0) - (fused.get(a) || 0);
    const order = [...[...forced].sort(byFusion), ...[...admitted].filter(i => !forced.includes(i)).sort(byFusion)];
    const selected = [];
    let used = 0;
    for (const i of order) {
      const item = items[i];
      const title = String(item.title || '로어').trim();
      const content = String(item.content).trim();
      const line = cacheLine('설정', title, content);
      const cost = line.length + (selected.length ? 1 : 0);
      if (used + cost > budget) continue;
      selected.push({ ...item, type: 'lore', title, why: why.get(i), matchedKeywords: [why.get(i)], line, text: `${title}: ${content}`, _i: i });
      used += cost;
    }
    // Budget went to the guaranteed lore first; what is shown follows the fused ranking.
    return selected.sort((a, b) => byFusion(a._i, b._i)).map(({ _i, ...item }) => item);
  }

  function contextFor(ix, messages, query, options = {}) {
    const ranked = search(ix, query, options);
    const byId = new Map(messages.map(message => [String(message.id), message]));
    const selected = [];
    let remaining = options.budget ?? 1650;

    function add(hit, source, kind, maxChars) {
      const separator = selected.length ? 1 : 0;
      if (cacheLine('과거대화', '', '…').length + separator + 20 > remaining) return false;
      let low = 1, high = Math.min(maxChars, source.length), best = null;
      while (low <= high) {
        const length = Math.floor((low + high) / 2);
        const excerpt = length === source.length ? source : `${source.slice(0, length - 1)}…`;
        const line = cacheLine('과거대화', '', excerpt);
        if (line.length + separator <= remaining) {
          best = { excerpt, line };
          low = length + 1;
        } else high = length - 1;
      }
      if (!best) return false;
      if (selected.some(existing => existing.messageId === hit.messageId && existing.text.includes(best.excerpt.replace(/…$/, '')))) return false;
      selected.push({ ...hit, kind, line: best.line, text: best.excerpt });
      remaining -= best.line.length + separator;
      return true;
    }

    for (const hit of groupByMessage(ranked)) {
      if (selected.length >= 4 || remaining < 120) break;
      if (!hit.strong.length && hit.score < 1.8) continue;
      const source = byId.get(String(hit.messageId));
      const clean = source && searchText(source.text);
      if (!clean) continue;
      add(hit, clean, 'message_start', 220);
    }
    const floor = Math.max(0.6, (ranked[0]?.score || 0) * 0.2);
    for (const hit of ranked) {
      if (selected.length >= 12 || remaining < 80 || hit.score < floor) break;
      if (!byId.has(String(hit.messageId))) continue;
      if (!hit.strong.length && hit.score < 1.0 && !hit.matched.length) continue;
      add(hit, hit.text, 'matched_unit', 200);
    }
    return { ranked, selected, reason: selected.length ? '' : '관련 과거 대화가 없거나 입력 글자 예산 부족' };
  }

  // --- Comprehensive 5-Tier Client Context Assembler ---
  // User persona is handled by Crack's native persona setting.
  // Only memory, lore and optional user notes belong in this outgoing context.
  function contextWithAll(ix, messages, query, {
    userNote = '',
    overview = '',
    loreList = [],
    summaryCards = [],
    budget = 2000,
    contextQuery = query,
    loreFacts = [],
    loreSemantic = null,
    loreRecentContext = '',
    currentTurn = Infinity,
    injectUserNoteToPrompt = false,
    passageIndex = null,
    passageQuery = query,
    passageContext = '',
    passageSemantic = null,
    maxTurn = Infinity
  } = {}) {
    const totalBudget = Math.max(0, budget - USER_PREFIX.length - USER_SUFFIX.length - query.length);
    let remaining = totalBudget;
    const finalSelected = [];

    // 1. User Note
    let selectedUserNote = null;
    const cleanUserNote = String(userNote || '').trim();
    if (cleanUserNote && injectUserNoteToPrompt) {
      const line = cacheLine('유저노트', '', cleanUserNote);
      const sep = finalSelected.length ? 1 : 0;
      if (line.length + sep <= Math.min(300, remaining)) {
        selectedUserNote = { type: 'user_note', line, text: `[유저노트] ${cleanUserNote}` };
        finalSelected.push(selectedUserNote);
        remaining -= (line.length + sep);
      }
    }

    // 2. Overview: where the story stands. It goes in every time, ahead of picked memory, but
    // never takes more than a third of the room.
    const overviewText = String(overview || '').split('\n').map(cleanLine).filter(Boolean).join(' / ');
    let selectedOverview = null;
    if (overviewText) {
      const line = `[현재 상황] ${overviewText}`;
      const sep = finalSelected.length ? 1 : 0;
      if (line.length + sep <= Math.min(Math.floor(totalBudget / 3), remaining)) {
        selectedOverview = { type: 'overview', line, text: overviewText, title: '현재 상황', content: overviewText, why: '항상' };
        finalSelected.push(selectedOverview);
        remaining -= line.length + sep;
      }
    }

    // 3. Long-term Summary Cards
    const selectedSummaries = [];
    const byMark = new Map();
    for (const s of summaryCards) {
      if (!s || !s.content || s.enabled === false) continue;
      const mark = s.turn ? memoryMark(s.turn, s.who) : '';
      const host = mark && byMark.get(mark);
      if (host) {
        // Same turn and same people: append to that line instead of repeating the mark.
        const piece = ` / ${memoryBody(s.title ?? '사건 요약', s.content)}`;
        if (piece.length > remaining) continue;
        host.line += piece;
        const card = { ...s, type: 'summary', line: '', text: `${s.title}: ${s.content}` };
        selectedSummaries.push(card);
        finalSelected.push(card);
        remaining -= piece.length;
        continue;
      }
      const line = cacheLine('기억', s.title ?? '사건 요약', s.content, s.turn, s.who);
      const sep = finalSelected.length ? 1 : 0;
      if (line.length + sep > remaining) continue;
      const card = { ...s, type: 'summary', line, text: `${s.title}: ${s.content}` };
      if (mark) byMark.set(mark, card);
      selectedSummaries.push(card);
      finalSelected.push(card);
      remaining -= (line.length + sep);
    }
    // Relevance decides what fits; the model reads the survivors as a timeline.
    const turnOf = card => Number(card.turn) > 0 ? Number(card.turn) : Infinity;
    selectedSummaries.sort((a, b) => turnOf(a) - turnOf(b));
    finalSelected.splice(finalSelected.length - selectedSummaries.length, selectedSummaries.length, ...selectedSummaries);

    // 4. Lorebook Items (Hybrid Keyword + Semantic Vector)
    const selectedLore = selectLore(loreList, contextQuery, {
      budget: Math.min(600, Math.floor(remaining * 0.55)),
      userQuery: query, recentContext: loreRecentContext, facts: loreFacts, turn: currentTurn, semantic: loreSemantic
    });
    for (const l of selectedLore) {
      const sep = finalSelected.length ? 1 : 0;
      if (l.line.length + sep <= remaining) {
        finalSelected.push(l);
        remaining -= (l.line.length + sep);
      }
    }

    // 5. Original passages (no-LLM mode) or legacy chunks
    const memoryResult = passageIndex
      ? { selected: passageSearch(passageIndex, passageQuery, { contextQuery: passageContext, budget: remaining, maxTurn, semantic: passageSemantic }) }
      : ix ? contextFor(ix, messages, contextQuery, { budget: remaining }) : { selected: [] };
    const selectedMemory = memoryResult.selected || [];
    for (const m of selectedMemory) {
      finalSelected.push(m);
    }

    return {
      selected: finalSelected,
      userNote: cleanUserNote,
      selectedUserNote,
      selectedOverview,
      selectedSummaries,
      selectedLore,
      selectedMemory,
      ranked: memoryResult.ranked || [],
      reason: finalSelected.length ? '' : '매칭된 항목 없음'
    };
  }

  function userContextBudget(original, limit = 2000) {
    return Math.max(0, limit - String(original || '').length - USER_PREFIX.length - USER_SUFFIX.length);
  }

  function composeUser(original, selected, limit = 2000, currentTurn = 0) {
    if (!selected || !selected.length) return original;
    const lines = selected.map(hit => hit.line).filter(Boolean);
    if (!lines.length) return original;
    const block = `${userPrefix(currentTurn)}${lines.join('\n')}${USER_SUFFIX}`;
    return block.length + original.length <= limit ? block + original : original;
  }

  function replaceFrameMessage(raw, message) {
    const match = /^42(\/[^,]+,)?(\d*)(\[.*)$/s.exec(raw);
    if (!match || (match[1] && match[1] !== '/v3/chats,')) return null;
    try {
      const events = JSON.parse(match[3]);
      if (!Array.isArray(events) || events[0] !== 'send' || !events[1] || typeof events[1] !== 'object') return null;
      const field = ['message', 'content', 'text'].find(key => typeof events[1][key] === 'string');
      if (!field) return null;
      events[1] = { ...events[1], [field]: message };
      return `42${match[1] || ''}${match[2]}${JSON.stringify(events)}`;
    } catch { return null; }
  }

  function parseFrame(raw) {
    if (typeof raw !== 'string') return null;
    const match = /^42(\/[^,]+,)?(\d*)(\[.*)$/s.exec(raw);
    if (!match || (match[1] && match[1] !== '/v3/chats,')) return null;
    try {
      const arr = JSON.parse(match[3]);
      return Array.isArray(arr) && ['send', 'reroll'].includes(arr[0]) ? { kind: arr[0], payload: arr[1] || {} } : null;
    } catch { return null; }
  }

  // --- Incremental 2-Response Sliding-Window Memory Accumulator ---
  // Steps sequentially through interaction pairs, discarding mechanical INFO blocks
  // and capturing high-resolution narrative nuances, gestures, emotional undercurrents, and promises.
  const STOPWORDS_SET = new Set([
    // Prompt & system directives
    'SYSTEM', 'INFO', 'STATUS', 'OOC', '대사', '감정', '생각', '행동', '출력', '절대금', '절대금지',
    '프롬프트', '지침', '지시', '가이드', '규칙', '유저', '어시스턴트', '경험치', '스탯', '기존', '수정',
    '합계', '턴', '진행관', '교관', '학생', '안내', '명령', '설정', '기록', '매칭', '트리거', '인젝션',
    // Conjunctions & grammatical particles / adverbs
    '그리고', '하지만', '그러나', '그런데', '그래', '이상', '하지', '없었다', '있었다', '그저', '아니었다',
    '것이다', '아니', '이제', '있어', '그냥', '다음', '아마', '시간', '모두', '그렇게', '아무', '혼자',
    '죽고', '누워', '창밖', '상처', '결국', '어미', '향한', '세상', '어제', '흘렀다', '있던', '살아', '옷자락',
    '수치라', '더욱', '맘대', '돼요', '하얀', '입술', '고개', '칭호', '짊어져', '다음날', '대신', '다른',
    '근육통', '반복', '팔꿈치', '할지', '방문', '열두', '자세', '뭐야', '아니야', '부러진', '찌르기', '가주',
    '아들', '못했다', '냄새', '시트', '멈추지', '포션', '여기', '앉아', '어디', '건지', '봉합', '아니라',
    '부서져야', '이긴', '그건', '근데', '왼손', '수치라고', '부서진', '자격', '라고', '수프', '발소리',
    '멈추었다', '하늘', '그릇', '아침', '먹었다', '신뢰', '아닌', '보았다', '오늘', '구석', '실전', '편성',
    '매일', '맨몸운동', '서리', '녹색', '정면', '떨리고', '먼저', '준비', '사실', '아니다', '않는다',
    '뼈대', '누나', '그게', '수련', '메이드', '녀석', '수건', '저녁이야', '마음', '표정', '눈빛',
    '목소리', '어깨', '얼굴', '손목', '무릎', '팔목', '갈비뼈', '바닥', '침대', '벤치', '조각',
    // Generic nouns / pronouns
    '그것', '자신', '사람', '모습', '순간', '지금', '하나', '때문', '우리', '그녀', '그의', '이것', '저것',
    '어떤', '모든', '대한', '통해', '위해', '관한', '정도', '다시', '정말', '진짜', '약간', '조금', '가장',
    '매우', '너무', '아주', '함께', '서로', '서로의', '자신의', '그들의',
    // Verbs
    '말했다', '했다', '였다', '있다', '없다', '된다', '한다', '않았다', '보였다', '바라보았다', '바라보며',
    '웃었다', '들었다', '걸었다', '뛰었다', '잡았다', '놓았다', '올렸다', '내렸다', '닫혔다', '열렸다'
  ]);

  const RP_LOCATIONS = ['연무장', '정원', '저택', '훈련장', '의무실', '거리', '숲', '성', '연구실', '탑', '대련장', '수련장', '아카데미', '본관', '식당'];
  const RP_STATES = ['부상', '피로', '내상', '마력 고갈', '근육통', '치료', '휴식', '완쾌', '호전', '이상', '경계', '신뢰', '약속', '약조', '승리', '패배'];

  function cleanDetailSentence(s) {
    return String(s || '')
      // "▍루카 「 대사 」" dialogue markers become "루카: 대사".
      .replace(/^[▍▌│|]\s*([^\s「『"“]{1,10})\s*[「『"“]\s*/, '$1: ')
      .replace(/〔\s*〕|\*{1,2}/g, ' ')
      .replace(/^["\x27「『“\s─–—]+|["\x27」』”\s─–—]+$/g, '')
      .replace(/\s{2,}/g, ' ')
      .replace(/^(?:하지만|그런데|그리고|그러나|그렇지만)\s*/, '')
      .trim();
  }

  // Status-window field names ("목표: …", "보상: …") are labels, not speakers.
  const SYSTEM_LABEL = /^(?:속보|목표|보상|경고|알림|시스템|퀘스트|미션|튜토리얼|상태|정보|위치|장소|시간|날짜|현재|결과|조건|효과|설명|메시지|안내|공지|주의|획득|레벨|등급|칭호|업적|스탯|능력치|호감도|관계|진행|기록|로그|이름|나이|직업|소속|종족|성별|외형|성격|특징|체력|마력|골드|아이템|소지품|스킬|버프|디버프|판정|주사위)/;

  function cleanDetailSpeaker(raw) {
    if (!raw) return null;
    // Strip any leading/trailing symbols (⚠ ▶ ■ 👤 * [ " ...), not a fixed list.
    // "루카｜Lv.1" is a status header; the name is the part before the bar.
    const s = String(raw).split(/[｜|]/)[0].replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '').trim();
    if (s.length < 2 || s.length > 8) return null;
    if (/\d/.test(s)) return null;
    if (SYSTEM_LABEL.test(s)) return null;
    // Latin capitals without Hangul (SYSTEM, INFO, GM, NPC) label the system, not a character.
    if (!/[가-힣]/.test(s) && /^[A-Z0-9 _.\-]+$/.test(s)) return null;
    if (/^(?:T-\d+|Turn|턴|SYSTEM|INFO|STATUS|OOC|합계|계산|경험치)/i.test(s)) return null;
    if (STOPWORDS_SET.has(s)) return null;
    return s;
  }

  // Keywords the user (or a reviewer) excluded never come back.
  function dropKeywords(graph, keywords) {
    const drop = new Set((keywords || []).map(k => String(k).trim()).filter(Boolean));
    if (!graph || !graph.nodes || !drop.size) return graph;
    const gone = new Set(graph.nodes.filter(n => drop.has(n.keyword)).map(n => n.id));
    graph.nodes = graph.nodes.filter(n => !gone.has(n.id));
    graph.edges = (graph.edges || []).filter(e => !gone.has(e.from) && !gone.has(e.to));
    return graph;
  }

  function extractWindowDetail(windowMsgs, startTurn, endTurn) {
    // 1. Aggressively strip mechanical INFO blocks and prompt directives
    const INFO_BLOCK_REGEX = /(?:```(?:INFO|STATUS|STAT|SYSTEM)[\s\S]*?```|\[\s*#[\s\S]*?(?:\]|$)|└?\[\s*(?:호감도|성향|체력|마력|능력치|스탯|스킬|레벨|경험치|아이템|소지품|골드|골|퀘스트|위치|현재\s*상태|버프|디버프|HP|MP|EXP|Lv)[\s\S]*?(?:\]|$)|(?:\(|\[)\s*ooc[\s\S]*?(?:\)|\]|$)|⚠\s*SYSTEM[\s\S]*?(?:\n|$)|#\s*\(루카의[\s\S]*?(?:\)|\]|$))/gi;

    const windowSpeakers = new Set();
    const candidateSentences = [];
    let detectedLocation = null;
    const detectedStates = new Set();

    for (const m of windowMsgs) {
      const text = stripOwnBlock(m.text || m.content || '').replace(INFO_BLOCK_REGEX, ' ');
      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        const sm = l.match(/^\*{0,2}([^\*\|｜:\(\[\{]{2,15})\*{0,2}\s*[\|:｜]/)
          || l.match(/^[▍▌]\s*([^\s「『"“]{2,10})\s*[「『"“]/);
        if (sm) {
          const spk = cleanDetailSpeaker(sm[1]);
          if (spk) windowSpeakers.add(spk);
        }
      }

      for (const loc of RP_LOCATIONS) {
        if (text.includes(loc)) detectedLocation = loc;
      }
      for (const st of RP_STATES) {
        if (text.includes(st)) detectedStates.add(st);
      }

      // Clean narration and dialog lines
      const clean = text
        .replace(/!\[[^\]]*\]\([^\)]*\)/g, ' ')
        .replace(/>\s*T-\d+/gi, ' ')
        .replace(/\*{0,2}[^\*\|｜:\(\[\{\n]{2,15}\*{0,2}\s*[\|:｜]/g, ' ')
        .replace(/[👤💬⚔☀️🌤️🟡😊💡🕒📝💼🤝]/g, ' ')
        .replace(/(?:[\*\-─—=_]\s*){2,}/g, ' ');

      const sents = clean.split(/(?<=[.!?])\s+|\n+/).map(cleanDetailSentence).filter(s => s.length >= 8);
      for (const s of sents) {
        if (/(?:생각했다|느껴졌다|알 수 없었다|바람이|턴 \d+)/.test(s)) continue;
        let score = 0;
        // Physical distance & gestures
        if (/(?:걸음|가까워|다가서|물러서|거리감|거리를|시선|눈길|표정|손을|고개|어깨)/.test(s)) score += 4.5;
        // Emotional undercurrent & vocal nuance
        if (/(?:고집|걱정|단호|동요|의식한|담담|망설|어조|목소리|힘이 실려|제발|진심|안도)/.test(s)) score += 4.0;
        // Covenants, promises, turning points
        if (/(?:돌파|승리|결착|인정|비밀|치료|의무실|약속|약조|지금 바로|나중에가 아니라)/.test(s)) score += 3.5;
        if (s.length >= 18 && s.length <= 110) score += 2.0;

        if (score >= 3.0) {
          candidateSentences.push({ text: s, score, role: m.role });
        }
      }
    }

    candidateSentences.sort((a, b) => b.score - a.score);
    let bestFact = '';
    if (candidateSentences.length) {
      bestFact = candidateSentences[0].text;
      const second = candidateSentences.find(c => c.text !== bestFact && Math.abs(c.text.length - bestFact.length) > 5);
      if (second && second.score >= 5.0 && (bestFact.length + second.text.length) < 110) {
        bestFact = `${bestFact} ${second.text}`;
      }
    }

    if (!bestFact) {
      bestFact = '상황 전개 및 대화 교류 지속';
    }

    return {
      startTurn,
      endTurn,
      speakers: Array.from(windowSpeakers),
      location: detectedLocation,
      states: Array.from(detectedStates),
      fact: bestFact
    };
  }

  function compactMemoryTree(state) {
    while (state.recentDetails.length > 2) {
      const oldest = state.recentDetails.shift();
      state.archivedEvents.push(oldest);
    }

    const totalArchived = state.archivedEvents.length;
    if (totalArchived === 0) return;

    if (totalArchived <= 4) {
      state.timeline = state.archivedEvents.map(e => ({
        epoch: '전개',
        turnRange: e.turnRange,
        milestone: e.fact
      }));
    } else {
      const mid = Math.floor(totalArchived * 0.5);
      const ep1 = state.archivedEvents.slice(0, mid);
      const ep2 = state.archivedEvents.slice(mid);

      const ep1Range = `${ep1[0].turnRange.split('~')[0]}~${ep1[ep1.length - 1].turnRange.split('~')[1]}`;
      const ep2Range = `${ep2[0].turnRange.split('~')[0]}~${ep2[ep2.length - 1].turnRange.split('~')[1]}`;

      const ep1Fact = ep1.reduce((p, c) => (c.fact.length > p.fact.length ? c : p)).fact;
      const ep2Fact = ep2.reduce((p, c) => (c.fact.length > p.fact.length ? c : p)).fact;

      state.timeline = [
        { epoch: '발단', turnRange: ep1Range, milestone: ep1Fact },
        { epoch: '전개', turnRange: ep2Range, milestone: ep2Fact }
      ];
    }
  }

  function formatStructuredMemoryPrompt(state) {
    const chars = Object.keys(state.characters || {}).slice(0, 6);
    const lines = [
      `[기억 진화 연대기 (턴 1 ~ ${state.lastProcessedTurn})]`,
      chars.length ? `• 중심 인물: ${chars.join(', ')}` : null,
      state.currentLocation ? `• 현재 장소: ${state.currentLocation}` : null,
      state.activeStates && state.activeStates.length ? `• 지속 상태: ${state.activeStates.slice(0, 6).join(', ')}` : null,
      '',
      `[누적 서사 흐름]`
    ];

    if (state.timeline && state.timeline.length) {
      for (const t of state.timeline) {
        lines.push(`• [${t.epoch} (턴 ${t.turnRange})] ${t.milestone}`);
      }
    } else {
      lines.push('• [서사 발단] 사건 및 수련의 기초 단계 진행');
    }

    if (state.recentDetails && state.recentDetails.length) {
      lines.push('');
      lines.push(`[최근 세부 상호작용 (직전 2회 응답 디테일)]`);
      for (const r of state.recentDetails) {
        lines.push(`• [턴 ${r.turnRange}] ${r.fact}`);
      }
    }

    lines.push('');
    lines.push(`[당면 상황]`);
    const lastDetail = state.recentDetails && state.recentDetails.length ? state.recentDetails[state.recentDetails.length - 1].fact : '현재 대화 및 상황 전개 중';
    lines.push(`• ${lastDetail}`);

    return lines.filter(Boolean).join('\n');
  }

  // Incremental sliding window processor for a batch of new messages
  function buildSlidingWindowMemory(existingState, newMessages, options = {}) {
    const state = existingState ? {
      lastProcessedTurn: existingState.lastProcessedTurn || 0,
      characters: { ...(existingState.characters || {}) },
      currentLocation: existingState.currentLocation || '',
      activeStates: [...(existingState.activeStates || [])],
      recentDetails: [...(existingState.recentDetails || [])],
      archivedEvents: [...(existingState.archivedEvents || [])],
      timeline: [...(existingState.timeline || [])]
    } : {
      lastProcessedTurn: 0,
      characters: {},
      currentLocation: '',
      activeStates: [],
      recentDetails: [],
      archivedEvents: [],
      timeline: []
    };

    if (!newMessages || !newMessages.length) {
      return { state, formattedText: formatStructuredMemoryPrompt(state) };
    }

    // Partition incoming messages into 2 assistant responses per window
    const baseTurn = state.lastProcessedTurn;
    const windows = [];
    let cur = [];
    let asstCount = 0;

    for (let i = 0; i < newMessages.length; i++) {
      const turnNum = baseTurn + i + 1;
      const m = { ...newMessages[i], turn: turnNum };
      cur.push(m);
      if (m.role === 'assistant') {
        asstCount++;
        if (asstCount >= 2) {
          windows.push(cur);
          cur = [];
          asstCount = 0;
        }
      }
    }
    if (cur.length) windows.push(cur);

    const activeStateSet = new Set(state.activeStates);

    for (const win of windows) {
      const startTurn = win[0].turn;
      const endTurn = win[win.length - 1].turn;
      const detail = extractWindowDetail(win, startTurn, endTurn);

      if (detail.location) state.currentLocation = detail.location;
      for (const st of detail.states) activeStateSet.add(st);
      for (const spk of detail.speakers) {
        const prev = state.characters[spk] || { count: 0 };
        state.characters[spk] = { ...prev, count: prev.count + 1, lastTurn: endTurn };
      }

      state.recentDetails.push({
        turnRange: `${startTurn}~${endTurn}`,
        fact: detail.fact
      });

      state.lastProcessedTurn = endTurn;
      compactMemoryTree(state);
    }

    state.activeStates = Array.from(activeStateSet);
    return {
      state,
      formattedText: formatStructuredMemoryPrompt(state)
    };
  }

  // Full-history sliding window processor: runs through entire conversation history
  // in 2-response sliding increments, accumulating the memory state cleanly
  function processAllWithSlidingWindow(messages, options = {}) {
    return buildSlidingWindowMemory(null, messages, options);
  }

  // Backwards-compatible facade that delegates to the sliding window accumulator
  function extractTemporalHypergraph(messages, options = {}) {
    if (!messages || !messages.length) return { text: '', graph: null, totalTurns: 0 };
    const res = processAllWithSlidingWindow(messages, options);
    return {
      text: res.formattedText,
      state: res.state,
      totalTurns: messages.length,
      speakerList: Object.keys(res.state?.characters || {})
    };
  }

  // --- Passage index: the whole chat, structured, for retrieval without an LLM ---
  // Status windows ("⌛42｜7/21[월] 8일차 낮 13:10 🏢관리국 - 총장실", "물자 획득 …") are not
  // story text. Their place and day become a scene tag; the rest is split into short passages.
  // "🏢관리국 - 총장실": a place and an optional sub-place, not the sentence that follows it.
  const SCENE_PLACE = /[🏢🏠🌁📍🏛🏫🏥🌲🏙🏰⛪🏚🏕🏞🌆🌃🚪]\uFE0F?\s*([^\s|｜]{1,20}(?:\s+[^\s|｜]{1,12}){0,2}?(?:\s*-\s*[^\s|｜]{1,20})?)(?=\s|$)/u;
  // When the status window has its own line, everything after the place icon is the place.
  const SCENE_PLACE_LINE = /[🏢🏠🌁📍🏛🏫🏥🌲🏙🏰⛪🏚🏕🏞🌆🌃🚪]\uFE0F?\s*([^|｜\n]{1,40})$/u;
  const SCENE_DAY = /(\d+\s*일차)/u;
  // Also "〔👤〕 …" / "─ 〔인연〕 …" panels, "상태:[평온함]" / "능력: …" fields and
  // relationship rows "∙ 코코 | 😊 | 20 #…", "▸루시아｜💓·…｜Lv.87".
  const STATUS_LINE = /^(?:[⌛⏳📍🕒⏰🗓📅💼🤝📝📊🎒❤️💰]|\s*(?:물자|호감도|상태창|스탯|획득|소모|인벤토리|소지품)(?=\s|$|[:：])|\s*[─—-]*\s*〔[^〕\n]{0,8}〕|\s*(?:상태|능력|등급|스킬|직업|레벨)\s*[:：]|\s*[▸∙•]\s*[가-힣]{2,8}\s*[｜|])|\d+\s*일차|\d{1,2}\/\d{1,2}\s*\[/u;

  // Status headers written as fields separated by ｜, holding a clock time or a date.
  function pipeHeaderScene(line) {
    const fields = line.split(/[｜|]/).map(field => field.replace(/\p{Extended_Pictographic}|\uFE0F/gu, '').trim()).filter(Boolean);
    if (fields.length < 3 || !fields.some(field => /\d{1,2}:\d{2}|\d+\s*(?:년|월|일)|일차/.test(field))) return null;
    const date = fields.find(field => /\d+\s*(?:년|월|일)|일차/.test(field)) || '';
    const place = fields.find(field => /[：:]|\s-\s/.test(field) && !/\d{1,2}:\d{2}/.test(field))
      || fields.filter(field => !/\d/.test(field) && field.length >= 2 && !/^[월화수목금토일]요일$|^(?:아침|낮|저녁|밤|새벽|오전|오후)$/.test(field)).pop() || '';
    return [date, place.replace(/\s*[：:]\s*/, ' - ')].filter(Boolean).join(' ');
  }

  function structureMessage(text) {
    const lines = stripMarkdownComments(stripOwnBlock(text)).replace(/```[\s\S]*?```/g, '\n').split('\n');
    let scene = '';
    let speakerLine = '';
    const body = [];
    for (const raw of lines) {
      // "INFO[루카｜男｜21…]", "[관계｜레오😠｜…]", "└[일정…]": status blocks, also when they
      // follow story text on the same line.
      const line = raw.replace(/INFO\s*\[[\s\S]*$/u, '').replace(/(?:^|\s)[―—└-]*\s*\[[^\]\n]{1,20}[｜|：:][^\]\n]*\][\s\S]*$/u, '').trim();
      if (!line) continue;
      const pipeScene = line.length < 140 ? pipeHeaderScene(line) : null;
      if (pipeScene !== null) {
        if (pipeScene) scene = pipeScene;
        continue;
      }
      if (STATUS_LINE.test(line) || (line.length < 120 && (line.match(/\p{Extended_Pictographic}/gu) || []).length >= 2 && /\d/.test(line))) {
        // A status line may run straight into the story on the same line.
        const tail = line.replace(/^.*?(?:[☁☀🌧🌙⛅🌤🌥🌦🌨🌩❄]\uFE0F?\s*[🏢🏠🌁📍🏛🏫🏥🌲🏙🏰⛪🏚🏕🏞🌆🌃🚪]\uFE0F?[^\s]*(?:\s-\s\S+)?)\s+/u, '');
        const joined = tail !== line && tail.length >= 20 && !STATUS_LINE.test(tail);
        const place = (joined ? line.match(SCENE_PLACE) : line.match(SCENE_PLACE_LINE) || line.match(SCENE_PLACE))?.[1]?.trim();
        const day = line.match(SCENE_DAY)?.[1];
        if (place || day) scene = [day, place].filter(Boolean).join(' ');
        if (joined) body.push(tail);
        continue;
      }
      const plain = line.replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/[*_]{1,3}/g, '').trim();
      // "**▍백은하**" or "**『 서은채 』**" alone on a line names who speaks the quote lines
      // that follow: "「 어머… 」".
      const label = plain.match(/^(?:[▍▌]\s*([^\s「『"“]{1,10})|[『【]\s*([^\s』】]{1,10})\s*[』】])$/u);
      if (label) { speakerLine = label[1] || label[2]; continue; }
      const quoted = /^[「『"“]/u.test(plain);
      const said = speakerLine && quoted ? `${speakerLine}: ${plain.replace(/^[「『"“]\s*/u, '')}` : plain;
      if (!quoted) speakerLine = '';
      body.push(said.replace(/^[▍▌]\s*([^\s「『"“]{1,10})\s*[「『"“]\s*/u, '$1: '));
    }
    const kept = body.map(line => line.replace(/\s+/g, ' ').trim()).filter(Boolean);
    return { scene, lines: kept, body: kept.join(' ') };
  }

  // Split a long line where a sentence or a quote ends outside any quote, so dialogue stays
  // whole ("…다. 다음", "…」「다음…"). Nothing is dropped: a piece with no such break is cut
  // at the last space before the limit and the rest continues in the next piece.
  function splitOutsideQuotes(line, limit = 220) {
    if (line.length <= limit) return [line];
    const parts = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if ('"“「『'.includes(ch) && !(ch === '"' && depth)) depth++;
      else if ('"”」』'.includes(ch) && depth) depth--;
      const sentenceEnd = !depth && /[.!?。…]/.test(ch) && line[i + 1] === ' ';
      const quoteEnd = !depth && '"”」』'.includes(ch);
      if ((sentenceEnd || quoteEnd) && i - start >= 40) {
        parts.push(line.slice(start, i + 1).trim());
        start = i + 1;
      }
    }
    parts.push(line.slice(start).trim());
    return parts.flatMap(part => {
      const pieces = [];
      let rest = part;
      while (rest.length > limit * 1.5) {
        const cut = rest.lastIndexOf(' ', limit) > limit * 0.5 ? rest.lastIndexOf(' ', limit) : limit;
        pieces.push(rest.slice(0, cut).trim());
        rest = rest.slice(cut).trim();
      }
      if (rest) pieces.push(rest);
      return pieces;
    }).filter(Boolean);
  }

  // "서린｜…", "유빈💭｜…", "지크: …" — who is speaking or thinking.
  const SPEAKER_LABEL = /(?:^|\s)([가-힣]{2,8})(?:💭|\p{Extended_Pictographic})?\s*[｜|:：]\s*["“「『]?/gu;
  // Status windows use the same "label｜value" shape: "능력: 공상구현화", "상태:[평온함]",
  // "▸로완｜😏·이제 내꺼야｜Lv.86". Field names, and labels whose value is a level, a bracket or a
  // number, are not speakers, unless a person marker stands right before the label.
  const STATUS_FIELDS = new Set(['상태', '능력', '등급', '스킬', '호감도', '친밀도', '소지품', '인벤토리', '물자', '목표', '위치', '장소', '시간', '날짜', '일정', '직업', '레벨', '체력', '마력', '스탯', '관계', '인연', '속보', '답변', '퀘스트', '보상', '획득', '소모', '현재', '진행', '요약']);
  // "남자｜…", "무전｜…": an unnamed voice is not one person; as a name it would pull in every
  // passage that mentions a man. Titles ("심사관", "교수") usually stay one recurring person.
  const CROWD_SPEAKERS = new Set(['남자', '여자', '소년', '소녀', '노인', '아이', '사람', '사람들', '군인', '병사', '생존자', '무전', '목소리', '일동', '모두', '학생', '학생들', '주민', '행인', '군중', '누군가']);
  function speakersIn(text) {
    const names = [];
    for (const match of text.matchAll(SPEAKER_LABEL)) {
      const name = match[1];
      const after = text.slice(match.index + match[0].length, match.index + match[0].length + 4);
      if (STATUS_FIELDS.has(name)) continue;
      // "〔👤〕 크리｜Lv.1", "▸루시아｜…": a person marker before the label means it is a name.
      const marked = /[▸∙•〕👤]\s*$/u.test(text.slice(Math.max(0, match.index - 3), match.index + match[0].indexOf(name)));
      if (!marked && /^\s*(?:lv|[\[(\d])/i.test(after)) continue;
      names.push(name);
    }
    // Relationship lists: "▸루시아｜💓·…", "∙ 코코 | ❤️ | …".
    for (const match of text.matchAll(/[▸∙•]\s*([가-힣]{2,8})\s*[｜|]/gu)) if (!STATUS_FIELDS.has(match[1])) names.push(match[1]);
    return [...new Set(names)];
  }

  function buildPassageIndex(messages) {
    const units = [];
    const speakerCounts = new Map();
    let lastScene = '';
    (messages || []).forEach((message, index) => {
      const { scene, lines } = structureMessage(message.text || message.content || '');
      if (scene) lastScene = scene;
      // Keep the original lines: a "지안｜\"…\"" line is one unit, so a quote is never cut
      // from its speaker. Short neighbouring lines are joined up to about 200 characters.
      const pieces = lines.flatMap(line => splitOutsideQuotes(line));
      let buffer = '';
      let at = 0;
      const flush = () => {
        const text = buffer.trim();
        // A fragment this short ("뭐라도 해야했으니까요..") says nothing on its own.
        if (text.length >= 25) {
          const speakers = speakersIn(text);
          for (const name of speakers) speakerCounts.set(name, (speakerCounts.get(name) || 0) + 1);
          units.push({ unitId: `p:${index}:${at++}`, messageId: String(message.id ?? index), turn: index + 1,
            role: message.role, scene: lastScene, speakers, text, len: text.length });
        }
        buffer = '';
      };
      for (const piece of pieces) {
        if (buffer && buffer.length + piece.length + 1 > 200) flush();
        buffer = buffer ? `${buffer} ${piece}` : piece;
      }
      if (buffer) flush();
    });
    const names = new Set([...speakerCounts].filter(([name, count]) => count >= 2 && !STOPWORDS_SET.has(name) && !CROWD_SPEAKERS.has(name)).map(([name]) => name));
    return { units, ix: index(units), names };
  }

  // The draft decides what is relevant; the latest reply only supports. Passages from the
  // live window (turn >= maxTurn) are skipped: Crack already shows them to the model.
  function passageSearch(pix, query, { contextQuery = '', budget = 1200, maxTurn = Infinity, perTurn = 2, semantic = null } = {}) {
    if (!pix?.units?.length || budget < 60) return [];
    const scores = new Map();
    for (const hit of search(pix.ix, query).slice(0, 60)) {
      // Sharing only a common two-letter piece ("괜찮", "생각") is weak evidence; halve it
      // unless a rare word matched or several different words did.
      const words = new Set(hit.matched.filter(term => term.length >= 2));
      const weak = !hit.strong.length && words.size < 3;
      scores.set(hit.unitId, (scores.get(hit.unitId) || 0) + hit.score * (weak ? 0.5 : 1));
    }
    const best = Math.max(0, ...scores.values());
    if (contextQuery.trim()) {
      const context = search(pix.ix, contextQuery).slice(0, 40);
      const bestContext = Math.max(0, ...context.map(hit => hit.score));
      for (const hit of context) scores.set(hit.unitId, (scores.get(hit.unitId) || 0) + 0.3 * (best || bestContext) * hit.score / (bestContext || 1));
    }
    const byId = new Map(pix.units.map(unit => [unit.unitId, unit]));
    // With sentence embeddings (unitId -> cosine), fuse the word ranking and the meaning ranking
    // by reciprocal rank; measured on an exported chat: top-10 hits 17 -> 20 of 30.
    if (semantic?.size) {
      const lexical = [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
      const meaning = [...semantic].filter(([id]) => byId.has(id)).sort((a, b) => b[1] - a[1]).slice(0, 60).map(([id]) => id);
      const scale = Math.max(1, ...scores.values());
      const fused = new Map();
      for (const ranking of [lexical, meaning]) ranking.forEach((id, rank) => fused.set(id, (fused.get(id) || 0) + 1 / (60 + rank)));
      scores.clear();
      const top = Math.max(...fused.values());
      for (const [id, value] of fused) scores.set(id, scale * value / top);
    }
    const names = pix.names || new Set();
    // Names in the draft: passages about that person, and above all their own lines, come first.
    const draftNames = [...names].filter(name => keywordAppears(query, name));
    if (draftNames.length) {
      for (const [id, score] of scores) {
        const unit = byId.get(id);
        const factor = unit.speakers?.some(name => draftNames.includes(name)) ? 1.5
          : draftNames.some(name => keywordAppears(unit.text, name)) ? 1.3 : 1;
        scores.set(id, score * factor);
      }
    }
    // Query expansion by people: the best draft matches name others who belong to the same
    // thread; pull their passages in at a low weight. Only names, so the search cannot drift.
    const seedBest = Math.max(0, ...scores.values());
    const seeds = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => byId.get(id));
    const related = [...new Set(seeds.flatMap(unit => [...names].filter(name => keywordAppears(unit.text, name))))]
      .filter(name => !draftNames.includes(name)).slice(0, 3);
    for (const name of related) {
      const hits = search(pix.ix, name).slice(0, 8);
      const bestHit = Math.max(0, ...hits.map(hit => hit.score));
      for (const hit of hits) scores.set(hit.unitId, (scores.get(hit.unitId) || 0) + 0.2 * seedBest * hit.score / (bestHit || 1));
    }
    // The older a passage, the more likely the model has lost it: that is what gets filled in.
    const lastTurn = pix.units.at(-1)?.turn || 1;
    for (const [id, score] of scores) {
      const age = lastTurn - byId.get(id).turn;
      scores.set(id, score * (1 + 0.3 * (1 - Math.exp(-age / 30))));
    }
    const top = Math.max(0, ...scores.values());
    const ranked = [...scores].filter(([id, score]) => score >= top * 0.35 && byId.get(id).turn < maxTurn)
      .sort((a, b) => b[1] - a[1]).map(([id]) => byId.get(id));
    const picked = [];
    const perTurnCount = new Map();
    let remaining = budget;
    for (const unit of ranked) {
      if ((perTurnCount.get(unit.turn) || 0) >= perTurn) continue;
      if (picked.some(other => other.turn === unit.turn && (other.text.includes(unit.text.slice(0, 30)) || unit.text.includes(other.text.slice(0, 30))))) continue;
      const line = `[${unit.turn}${unit.scene ? ` ${cleanLine(unit.scene)}` : ''}] ${cleanLine(unit.text)}`;
      if (line.length + 1 > remaining) continue;
      picked.push({ ...unit, type: 'passage', line, title: `대화 ${unit.turn}`, content: unit.text });
      perTurnCount.set(unit.turn, (perTurnCount.get(unit.turn) || 0) + 1);
      remaining -= line.length + 1;
      if (picked.length >= 10) break;
    }
    // An old passage alone can mislead. For the people in an old pick, add their most recent
    // passage (still outside the live window), so the model sees where things stand now.
    const newestFor = name => pix.units.findLast(unit => unit.turn < maxTurn && keywordAppears(unit.text, name));
    for (const unit of [...picked]) {
      if (lastTurn - unit.turn < 20) continue;
      for (const name of [...names].filter(name => keywordAppears(unit.text, name)).slice(0, 2)) {
        const latest = newestFor(name);
        if (!latest || latest.turn - unit.turn < 10 || picked.some(other => other.unitId === latest.unitId)) continue;
        const line = `[${latest.turn}${latest.scene ? ` ${cleanLine(latest.scene)}` : ''}] ${cleanLine(latest.text)}`;
        if (line.length + 1 > remaining) continue;
        picked.push({ ...latest, type: 'passage', line, title: `대화 ${latest.turn}`, content: latest.text, why: '최신 상태' });
        remaining -= line.length + 1;
      }
    }
    // The model reads them as a timeline.
    return picked.sort((a, b) => a.turn - b.turn);
  }

  // --- Immutable Evolving Temporal Hypergraph (LSA + Sliding Window + Node Linking) ---
  // Pure append-only temporal knowledge graph: processes 4-message windows, extracts keywords via LSA,
  // creates snapshot nodes, and links them via similarity edges to previous nodes without destructive overwriting.
  function createEvolutionGraph() {
    return {
      nodes: [],
      edges: [],
      lastTurn: 0,
      createdAt: Date.now()
    };
  }

  function stepSlidingWindowGraph(graph, windowMsgs, startTurn, endTurn, options = {}) {
    if (!graph) graph = createEvolutionGraph();
    if (!windowMsgs || !windowMsgs.length) return graph;

    const INFO_BLOCK_REGEX = /(?:```(?:INFO|STATUS|STAT|SYSTEM)[\s\S]*?```|\[\s*#[\s\S]*?\]|└?\[\s*(?:호감도|성향|체력|마력|능력치|스탯|스킬|레벨|경험치|아이템|소지품|골드|골|퀘스트|위치|현재\s*상태|버프|디버프|HP|MP|EXP|Lv)[\s\S]*?\])/gi;

    let combinedText = '';
    const windowSpeakers = new Set();

    for (const m of windowMsgs) {
      const text = stripOwnBlock(m.text || m.content || '').replace(INFO_BLOCK_REGEX, ' ');
      combinedText += ' ' + text;

      const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
      for (const l of lines) {
        const sm = l.match(/^\*{0,2}([^\*\|｜:\(\[\{]{2,15})\*{0,2}\s*[\|:｜]/)
          || l.match(/^[▍▌]\s*([^\s「『"“]{2,10})\s*[「『"“]/);
        if (sm) {
          const spk = cleanDetailSpeaker(sm[1]);
          if (spk) windowSpeakers.add(spk);
        }
      }
    }

    // Clean narration and dialog lines
    const cleanCombined = combinedText
      .replace(/!\[[^\]]*\]\([^\)]*\)/g, ' ')
      .replace(/>\s*T-\d+/gi, ' ')
      .replace(/\*{0,2}[^\*\|｜:\(\[\{\n]{2,15}\*{0,2}\s*[\|:｜]/g, ' ')
      .replace(/[👤💬⚔☀️🌤️🟡😊💡🕒📝💼🤝]/g, ' ')
      .replace(/(?:[\*\-─—=_]\s*){2,}/g, ' ');

    // Extract salient keywords using clean whole words with postposition stripping
    const JOSA_REGEX = /(?:에서|으로|에게|에는|보다|처럼|까지|부터|하고|이며|이고|과|와|의|은|는|이|가|을|를|도|만|로|에)$/;
    const candidateTerms = new Map();
    const rawWords = cleanCombined.match(/[가-힣]{2,8}/g) || [];
    for (let w of rawWords) {
      w = w.replace(JOSA_REGEX, '').replace(JOSA_REGEX, '');
      if (w.length >= 2 && !STOPWORDS_SET.has(w) && !/^(?:턴|대화|상태|진행|이전|현재|유저|기억|했다|된다|있다|없다|한다|향하|입고|데려|보였|바라|마친|있었)/.test(w)) {
        candidateTerms.set(w, (candidateTerms.get(w) || 0) + 1);
      }
    }

    const detectedKeywords = new Set(windowSpeakers);
    const excluded = new Set(options.dropKeywords || []);
    for (const loc of RP_LOCATIONS) {
      if (cleanCombined.includes(loc)) detectedKeywords.add(loc);
    }
    for (const st of RP_STATES) {
      if (cleanCombined.includes(st) && st.length >= 2) detectedKeywords.add(st);
    }

    // Add top salient terms from frequency map (expanded for broader keyword coverage)
    const sortedTerms = Array.from(candidateTerms.entries())
      .filter(([k]) => !detectedKeywords.has(k) && k.length >= 2)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8);
    for (const [k] of sortedTerms) detectedKeywords.add(k);

    const sents = cleanCombined.split(/(?<=[.!?])\s+|\n+/).map(cleanDetailSentence).filter(s => s.length >= 8);
    const newNodesInThisWindow = [];

    for (const kw of detectedKeywords) {
      if (!kw || kw.length < 2 || excluded.has(kw)) continue;

      // Extract the most relevant sentence for this keyword in this window
      let bestSent = '';
      let bestScore = -1;
      for (const s of sents) {
        if (!s.includes(kw)) continue;
        if (/(?:생각했다|느껴졌다|알 수 없었다|바람이|턴 \d+)/.test(s)) continue;
        let score = 0;
        if (/(?:걸음|가까워|다가서|물러서|거리감|거리를|시선|눈길|표정|손을|고개)/.test(s)) score += 4.5;
        if (/(?:고집|걱정|단호|동요|의식한|담담|망설|어조|목소리|힘이 실려|제발|진심|안도)/.test(s)) score += 4.0;
        if (/(?:돌파|승리|결착|인정|비밀|치료|의무실|약속|약조|지금 바로|나중에가 아니라)/.test(s)) score += 3.5;
        if (s.length >= 18 && s.length <= 110) score += 2.0;
        if (score > bestScore) {
          bestScore = score;
          bestSent = s;
        }
      }

      if (!bestSent) bestSent = sents.find(s => s.includes(kw)) || '';
      // A keyword with no sentence of its own in this window adds no memory.
      if (!bestSent) continue;

      const nodeId = `node_${graph.nodes.length + 1}`;
      const node = {
        id: nodeId,
        keyword: kw,
        turnRange: `${startTurn}~${endTurn}`,
        turn: endTurn,
        summary: bestSent.slice(0, 95),
        role: windowSpeakers.has(kw) ? 'speaker' : 'concept'
      };

      graph.nodes.push(node);
      newNodesInThisWindow.push(node);

      // Link to previous ancestor node of the same keyword (Temporal Evolution Edge)
      const prevAncestors = graph.nodes.filter(n => n.id !== nodeId && n.keyword === kw);
      if (prevAncestors.length > 0) {
        const lastAncestor = prevAncestors[prevAncestors.length - 1];
        graph.edges.push({
          from: lastAncestor.id,
          to: nodeId,
          type: 'evolves_to'
        });
      }
    }

    // Link co-occurrence edges within this 4-message window
    for (let i = 0; i < newNodesInThisWindow.length; i++) {
      for (let j = i + 1; j < newNodesInThisWindow.length; j++) {
        graph.edges.push({
          from: newNodesInThisWindow[i].id,
          to: newNodesInThisWindow[j].id,
          type: 'co_occurs'
        });
      }
    }

    graph.lastTurn = endTurn;
    return graph;
  }

  // Query the Evolution Graph dynamically based on user input, returning formatted evolution paths
  function queryEvolutionGraph(graph, query, budget = 500) {
    if (!graph || !graph.nodes || !graph.nodes.length) return '';

    const queryKeywords = new Set();
    const queryTermList = terms(query);

    for (const node of graph.nodes) {
      if (query.includes(node.keyword) || queryTermList.some(t => t.includes(node.keyword) || node.keyword.includes(t))) {
        queryKeywords.add(node.keyword);
      }
    }

    // If no direct hit, select recent active keywords
    if (queryKeywords.size === 0) {
      const recent = graph.nodes.slice(-4);
      for (const r of recent) queryKeywords.add(r.keyword);
    }

    const lines = [];
    let usedChars = 0;

    for (const kw of queryKeywords) {
      const chainNodes = graph.nodes.filter(n => n.keyword === kw);
      if (!chainNodes.length) continue;

      let chainStr = '';
      if (chainNodes.length === 1) {
        chainStr = `• ${kw} (턴 ${chainNodes[0].turnRange}): ${chainNodes[0].summary}`;
      } else if (chainNodes.length === 2) {
        chainStr = `• ${kw}: [초기: 턴 ${chainNodes[0].turnRange}] ${chainNodes[0].summary} ──> [현재: 턴 ${chainNodes[1].turnRange}] ${chainNodes[1].summary}`;
      } else {
        // If chain has 3 or more nodes: Keep Root, Middle Pivotal, and Latest
        const root = chainNodes[0];
        const latest = chainNodes[chainNodes.length - 1];
        const midIdx = Math.floor(chainNodes.length / 2);
        const mid = chainNodes[midIdx];

        chainStr = `• ${kw}: [발단: 턴 ${root.turnRange}] ${root.summary} ──> [전개: 턴 ${mid.turnRange}] ${mid.summary} ──> [현재: 턴 ${latest.turnRange}] ${latest.summary}`;
      }

      if (usedChars + chainStr.length <= budget) {
        lines.push(chainStr);
        usedChars += chainStr.length + 1;
      }
    }

    return lines.join('\n');
  }

  function cleanKeywordString(raw) {
    if (!raw) return null;
    let s = String(raw).trim();
    s = s.replace(/(?:에서|으로|에게|에는|보다|처럼|까지|부터|하고|이며|이고|의|은|는|이|가|을|를)$/, '');
    if (s.length < 2 || STOPWORDS_SET.has(s)) return null;
    return s;
  }

  // Generates distinct, individual keyword evolution cards from the temporal graph
  // Each entity/concept (Character, Martial skill, Promise, Location) gets its own card with its evolution chain.
  function generateKeywordEvolutionCards(graph) {
    if (!graph || !graph.nodes || !graph.nodes.length) return [];
    const keywordMap = new Map();

    for (const node of graph.nodes) {
      const kw = cleanKeywordString(node.keyword);
      if (!kw) continue;
      if (/관련 상호작용 및 정황 전개$/.test(node.summary || '')) continue;
      if (!keywordMap.has(kw)) keywordMap.set(kw, []);
      keywordMap.get(kw).push(node);
    }

    const maxTurn = graph.lastTurn || 1;
    const cards = [];
    for (const [kw, nodes] of keywordMap.entries()) {
      if (nodes.length === 0) continue;
      let domainIcon = '🏷️';
      let domainLabel = '개념';
      if (nodes.some(n => n.role === 'speaker') && cleanDetailSpeaker(kw) === kw) {
        domainIcon = '👤';
        domainLabel = '인물';
      } else if (RP_LOCATIONS.includes(kw)) {
        domainIcon = '📍';
        domainLabel = '장소';
      } else if (kw.includes('검') || kw.includes('스킬') || kw.includes('마법') || kw.includes('법') || kw.includes('진격') || kw.includes('분진') || kw.includes('오러') || kw.includes('강신') || kw.includes('경화') || kw.includes('이능') || kw.includes('환도') || kw.includes('종참') || kw.includes('세이버') || kw.includes('롱소드') || kw.includes('검리') || kw.includes('검초')) {
        domainIcon = '⚔️';
        domainLabel = '기술';
      } else if (kw.includes('약속') || kw.includes('치료') || kw.includes('대련') || kw.includes('승리') || kw.includes('부상') || kw.includes('피로') || kw.includes('청무제') || kw.includes('결투') || kw.includes('약조')) {
        domainIcon = '🤝';
        domainLabel = '사건/약조';
      } else {
        // Discard generic concepts that are grammar remnants or lack sufficient narrative recurrence
        if (nodes.length < 3 || kw.length < 2 || STOPWORDS_SET.has(kw) || /(?:다|고|며|서|면|지|라|게|야|든)$/.test(kw)) {
          continue;
        }
      }

      // Current state + History schema (최신 상태는 갱신되고, 과거 사건은 이력으로 보존)
      const latestNode = nodes[nodes.length - 1];
      const historyList = [];
      if (nodes.length === 1) {
        historyList.push(`[턴 ${nodes[0].turnRange}] ${nodes[0].summary}`);
      } else if (nodes.length <= 3) {
        for (const n of nodes) {
          historyList.push(`[턴 ${n.turnRange}] ${n.summary}`);
        }
      } else {
        const root = nodes[0];
        const mid = nodes[Math.floor(nodes.length / 2)];
        historyList.push(`[발단: 턴 ${root.turnRange}] ${root.summary}`);
        historyList.push(`[전개: 턴 ${mid.turnRange}] ${mid.summary}`);
        historyList.push(`[최근: 턴 ${latestNode.turnRange}] ${latestNode.summary}`);
      }

      const evolutionContent = [
        `• 현재 상태: ${latestNode.summary}`,
        `• 사건 이력: ${historyList.join(' ──> ')}`
      ].join('\n');

      const startTurn = nodes[0].turnRange.split('~')[0];
      const endTurn = nodes[nodes.length - 1].turnRange.split('~')[1];
      const lastTurnNum = Number(endTurn) || 1;
      const isActiveInScene = (maxTurn - lastTurnNum) <= 4;
      const status = isActiveInScene ? 'active' : 'dormant';

      cards.push({
        id: `sum_kw_${kw}`,
        subject: kw,
        keyword: kw,
        title: `${domainIcon} ${kw} (${domainLabel})`,
        domain: domainLabel,
        domainIcon,
        current: latestNode.summary,
        history: historyList,
        nodes: nodes,
        content: evolutionContent,
        turnRange: `${startTurn}~${endTurn}`,
        nodeCount: nodes.length,
        importance: domainLabel === '인물' ? 1.0 : (domainLabel === '사건/약조' ? 0.85 : 0.7),
        lastTurn: lastTurnNum,
        status: status, // 'active' vs 'dormant'
        enabled: true,
        isKeywordCard: true,
        updatedAt: Date.now()
      });
    }

    // Sort by domain priority (Characters > Skills > Locations > Events > Concepts) and nodeCount
    const DOMAIN_WEIGHT = { '인물': 100, '기술': 80, '장소': 70, '사건/약조': 60, '개념': 30 };
    cards.sort((a, b) => {
      const wa = (DOMAIN_WEIGHT[a.domain] || 30) * 10 + Math.min(a.nodeCount, 20);
      const wb = (DOMAIN_WEIGHT[b.domain] || 30) * 10 + Math.min(b.nodeCount, 20);
      return wb - wa;
    });

    return cards.slice(0, 16);
  }

  // State-Aware Dynamic Retrieval & Scoping
  // - If entity is ACTIVE in the current scene: Only the latest state is injected (zero bloat)
  // - If entity is DORMANT and re-triggered by user query: Inject [Origin/Turning Point ──> Current State]
  // - If entity is DORMANT and unmentioned: Completely skipped (0 prompt waste)
  function queryEvolutionGraph(graph, query, budget = 500, options = {}) {
    if (!graph || !graph.nodes || !graph.nodes.length) return '';

    const cards = generateKeywordEvolutionCards(graph);
    if (!cards.length) return '';

    const qTerms = terms(query);
    const maxTurn = graph.lastTurn || 1;
    const candidates = [];

    for (const card of cards) {
      if (card.enabled === false) continue;
      const isDirectlyQueried = qTerms.some(t => card.keyword.includes(t) || (t.length >= 2 && card.keyword.startsWith(t)));
      const isActive = card.status === 'active';

      let textLine = '';
      let priority = 0;

      if (isActive) {
        // 1. ACTIVE in immediate scene: Current state is sufficient
        textLine = `• [${card.keyword}] 현재 상태: ${card.current}`;
        priority = 10.0 + (isDirectlyQueried ? 5.0 : 0) + (card.importance || 0.6) * 2.0;
      } else if (isDirectlyQueried) {
        // 2. DORMANT RE-TRIGGERED: User re-summoned this past entity. Bridge origin to current state.
        const root = card.nodes[0];
        const latest = card.nodes[card.nodes.length - 1];
        if (card.nodes.length > 1) {
          textLine = `• [${card.keyword}] (발단: 턴 ${root.turnRange}) ${root.summary} ──> (현재: 턴 ${latest.turnRange}) ${latest.summary}`;
        } else {
          textLine = `• [${card.keyword}] (턴 ${latest.turnRange}) ${latest.summary}`;
        }
        priority = 8.0 + (card.importance || 0.6) * 2.0;
      } else {
        // 3. DORMANT & UNMENTIONED: Do not inject!
        continue;
      }

      candidates.push({ card, textLine, priority });
    }

    candidates.sort((a, b) => b.priority - a.priority);

    const lines = [];
    let usedChars = 0;

    for (const item of candidates) {
      if (usedChars + item.textLine.length <= budget) {
        lines.push(item.textLine);
        usedChars += item.textLine.length + 1;
      }
    }

    return lines.join('\n');
  }

  // Graph Compaction: Prunes redundant intermediate nodes while strictly preserving Root, Pivotal Shift, and Latest states
  function compactEvolutionGraph(graph, maxNodes = 60) {
    if (!graph || !graph.nodes || graph.nodes.length <= maxNodes) return graph;

    const keywordMap = new Map();
    for (const node of graph.nodes) {
      if (!keywordMap.has(node.keyword)) keywordMap.set(node.keyword, []);
      keywordMap.get(node.keyword).push(node);
    }

    const preservedNodes = [];
    for (const [kw, chain] of keywordMap.entries()) {
      if (chain.length <= 4) {
        preservedNodes.push(...chain);
      } else {
        const root = chain[0];
        const latest = chain[chain.length - 1];
        const prevLatest = chain[chain.length - 2];
        const midIdx = Math.floor(chain.length / 2);
        const mid = chain[midIdx];

        // Deduplicate and keep key anchors
        const uniqueSet = new Set([root, mid, prevLatest, latest]);
        preservedNodes.push(...Array.from(uniqueSet));
      }
    }

    preservedNodes.sort((a, b) => (a.turn || 0) - (b.turn || 0));
    graph.nodes = preservedNodes;

    // Prune edges pointing to non-existent nodes
    const validNodeIds = new Set(preservedNodes.map(n => n.id));
    graph.edges = (graph.edges || []).filter(e => validNodeIds.has(e.from) && validNodeIds.has(e.to));

    return graph;
  }

  // Full-history graph builder: runs sliding windows of 4 messages over the entire message list
  function buildGraphFromMessages(messages, options = {}) {
    const graph = createEvolutionGraph();
    if (!messages || !messages.length) return graph;

    for (let i = 0; i < messages.length; i += 4) {
      const win = messages.slice(i, i + 4);
      const startTurn = i + 1;
      const endTurn = Math.min(messages.length, i + 4);
      stepSlidingWindowGraph(graph, win, startTurn, endTurn, options);
    }
    return compactEvolutionGraph(graph);
  }

  // --- Recent scene ("직전 상황"), extractive and parameter-light ---
  // The last few messages are split into sentences; each sentence is scored by
  // the information it carries relative to the whole chat (sum of idf of its
  // distinct terms, divided by sqrt of their count so long sentences do not
  // win by length alone). The best sentences that fit the character budget are
  // returned in their original order.
  function recentSituationExtract(messages, ix, maxChars = 360, lastN = 4) {
    const recent = (messages || []).slice(-lastN);
    const N = Math.max(1, ix?.docs?.length || 1);
    const df = ix?.df;
    const idf = t => Math.log((N + 1) / ((df?.get(t) || 0) + 1));
    const sents = [];
    recent.forEach((m, mi) => {
      const text = searchText(m.text ?? m.content ?? '');
      text.split(/(?<=[.!?。…"”])\s+|\n+/).forEach((raw, si) => {
        const s = raw.trim();
        if (s.length < 8) return;
        const ts = [...new Set(terms(s))];
        if (!ts.length) return;
        const info = ts.reduce((a, t) => a + idf(t), 0) / Math.sqrt(ts.length);
        sents.push({ s, info, mi, si });
      });
    });
    const ranked = [...sents].sort((a, b) => b.info - a.info || b.mi - a.mi || a.si - b.si);
    const out = [];
    let used = 0;
    for (const x of ranked) {
      const cost = x.s.length + 1;
      if (used + cost > maxChars) continue;
      out.push(x);
      used += cost;
    }
    out.sort((a, b) => a.mi - b.mi || a.si - b.si);
    return out.map(x => x.s).join(' ');
  }

  return {
    stripOwnBlock,
    dropKeywords,
    searchText,
    recentSituationExtract,
    terms,
    unitsFromMessages,
    index,
    search,
    groupByMessage,
    selectLore,
    contextFor,
    contextWithAll,
    contextWithSummaryAndLore: (ix, msgs, q, l, s, o) => contextWithAll(ix, msgs, q, { ...o, loreList: l, summaryCards: s }),
    userContextBudget,
    composeUser,
    replaceFrameMessage,
    parseFrame,
    extractTemporalHypergraph,
    buildSlidingWindowMemory,
    processAllWithSlidingWindow,
    formatStructuredMemoryPrompt,
    createEvolutionGraph,
    stepSlidingWindowGraph,
    queryEvolutionGraph,
    buildGraphFromMessages,
    compactEvolutionGraph,
    generateKeywordEvolutionCards,
    structureMessage,
    buildPassageIndex,
    passageSearch,
    keywordAppears,
    USER_START,
    USER_END,
    MARKERS
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = CrackMatrixEngine;
}
if (typeof globalThis !== 'undefined') {
  globalThis.CrackMatrixEngine = CrackMatrixEngine;
  globalThis.CrackMemoryEngine = CrackMatrixEngine;
}
var CrackMemoryEngine = CrackMatrixEngine;

(function () {
  'use strict';
  const E = CrackMemoryEngine;
  const API = 'https://crack-api.wrtn.ai/crack-gen/v3/chats';
  const CONTENTS = 'https://contents-api.wrtn.ai/character-chat/v3/chats';
  const active = new Map();
  const syncing = new Set();
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  let busy = false;
  let currentRoomId = '';
  let serverRoute = null;
  let liveMatch = { selected: [], selectedLore: [], selectedMemory: [], query: '' };

  // --- Utility & Storage Keys ---
  function key(id, suffix) { return `crack-ubis-memory:${id}:${suffix}`; }
  function globalKey(suffix) { return `crack-ubis-memory:global:${suffix}`; }

  function isEnabled(id) {
    // Default to true for zero-friction user experience
    return GM_getValue(key(id, 'auto-inject-v2'), true);
  }
  function setEnabled(id, val) {
    GM_setValue(key(id, 'auto-inject-v2'), !!val);
  }

  function getBudget(id) {
    return 2000;
  }

  // --- Robust Token Extraction ---
  function token() {
    // 1. Try document.cookie
    const cookiePart = document.cookie.split(';').map(x => x.trim()).find(x => /^(?:access_token|accessToken|token|wrtn_token)=/i.test(x));
    if (cookiePart) {
      const val = cookiePart.split('=')[1];
      if (val) return decodeURIComponent(val);
    }
    // 2. Try common localStorage keys
    const commonKeys = ['accessToken', 'access_token', 'wrtn_token', 'token', 'auth', 'auth_token', 'next-auth.session-token'];
    for (const k of commonKeys) {
      try {
        const val = localStorage.getItem(k);
        if (val) {
          if (val.startsWith('Bearer ')) return val.slice(7);
          if (val.startsWith('{')) {
            const parsed = JSON.parse(val);
            const candidate = parsed.accessToken || parsed.access_token || parsed.token || parsed.state?.token || parsed.state?.accessToken;
            if (candidate && typeof candidate === 'string') return candidate;
          }
          if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(val)) return val;
          if (val.length > 20) return val;
        }
      } catch {}
    }
    // 3. Scan all localStorage items for JWT or token structure
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        if (!k) continue;
        const val = localStorage.getItem(k);
        if (!val) continue;
        if (/^[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+$/.test(val)) return val;
        if (val.includes('access_token') || val.includes('accessToken')) {
          try {
            const parsed = JSON.parse(val);
            const candidate = parsed.accessToken || parsed.access_token || parsed.token || parsed.state?.token || parsed.state?.accessToken;
            if (candidate && typeof candidate === 'string') return candidate;
          } catch {}
        }
      }
    } catch {}
    throw Error('크랙 로그인 토큰을 찾지 못했습니다. 로그인 상태를 확인하세요.');
  }

  function request(method, url, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url, timeout: 15000,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      data: body === undefined ? undefined : JSON.stringify(body),
      onload: r => {
        if (r.status < 200 || r.status >= 300) { reject(Error(`크랙 ${method}: HTTP ${r.status}`)); return; }
        try { resolve(r.responseText ? JSON.parse(r.responseText) : {}); }
        catch { reject(Error('크랙 응답 형식 오류')); }
      },
      onerror: () => reject(Error('크랙 서버 연결 실패')),
      ontimeout: () => reject(Error('크랙 서버 응답 시간 초과')),
    }));
  }

  // --- Chat ID Detection ---
  function chatId() {
    const pathId = (location.pathname.match(/\/(?:stories\/[^/]+\/episodes|characters\/[^/]+\/chats|u\/[^/]+\/c)\/([^/?#]+)/) || [])[1];
    if (pathId) return pathId;
    const storyId = (location.pathname.match(/^\/stories\/([^/]+)\/episodes\/?$/) || [])[1];
    if (!storyId) return '';
    const route = page.next?.router?.query;
    const current = Array.isArray(route?.chatId) ? route.chatId[0] : route?.chatId;
    if (route?.storyId === storyId && /^[\w-]{8,}$/.test(String(current || ''))) return String(current);
    if (!serverRoute) {
      const node = document.getElementById('__NEXT_DATA__');
      if (!node) return '';
      try {
        const data = JSON.parse(node.textContent || '{}');
        const candidate = Array.isArray(data.query?.chatId) ? data.query.chatId[0] : data.query?.chatId;
        serverRoute = { storyId: data.query?.storyId, chatId: /^[\w-]{8,}$/.test(String(candidate || '')) ? String(candidate) : '' };
      } catch { serverRoute = {}; }
    }
    return serverRoute?.storyId === storyId ? serverRoute.chatId : '';
  }

  // --- Message Normalization ---
  function messageId(m) { return String(m?._id || m?.id || ''); }
  function role(m) { return String(m?.role || m?.senderRole || '').toLowerCase(); }
  function normal(raw) {
    const id = messageId(raw), text = raw?.content ?? raw?.message, r = role(raw);
    if (!id || typeof text !== 'string' || !['user', 'assistant', 'system'].includes(r)) throw Error('메시지 형식 불일치');
    return { id, text, role: r, status: raw.status || '' };
  }

  // --- Crack History Fetch ---
  async function fetchHistory(id, full = true) {
    const encoded = encodeURIComponent(id);
    const all = [], seen = new Set(), cursors = new Set();
    let cursor = '', host = CONTENTS;
    do {
      const path = `/${encoded}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      let payload;
      try { payload = await request('GET', host + path); }
      catch (error) {
        if (host !== CONTENTS || all.length || !/HTTP (404|405)/.test(error.message)) throw error;
        host = API; payload = await request('GET', host + path);
      }
      const data = payload?.data || payload;
      if (!Array.isArray(data?.messages)) break;
      for (const raw of data.messages) {
        try {
          const m = normal(raw);
          if (!seen.has(m.id)) { seen.add(m.id); all.push(m); }
        } catch {}
      }
      if (!full) break;
      cursor = data.nextCursor == null ? '' : String(data.nextCursor);
      if (!cursor || cursors.has(cursor)) break;
      cursors.add(cursor);
      if (all.length > 2500) break;
    } while (cursor);
    return all.reverse();
  }

  // --- Lorebook Management ---
  function getLores(id) {
    try {
      const globalList = JSON.parse(GM_getValue(globalKey('lore-v1'), '[]'));
      const roomList = id ? JSON.parse(GM_getValue(key(id, 'lore-v1'), '[]')) : [];
      return [...globalList, ...roomList];
    } catch { return []; }
  }
  function saveLores(id, lores, isGlobal = false) {
    const k = isGlobal ? globalKey('lore-v1') : key(id, 'lore-v1');
    GM_setValue(k, JSON.stringify(lores));
  }

  // --- Local Cache & Sync ---
  function savedSnapshot(id) {
    try {
      const data = JSON.parse(GM_getValue(key(id, 'snapshot-v1'), '') || 'null');
      return data?.version === 1 && data.chatId === id && Array.isArray(data.messages) ? data : null;
    } catch { return null; }
  }
  function saveSnapshot(id, marker, messages) {
    try {
      GM_setValue(key(id, 'snapshot-v1'), JSON.stringify({ version: 1, chatId: id, marker, savedAt: Date.now(), messages }));
    } catch {}
  }

  async function remember(id, forceSync = false) {
    if (!id) return null;
    const cached = active.get(id);
    if (!forceSync && cached && Date.now() - cached.loadedAt < 300000) return cached;

    // Check disk snapshot first for instantaneous loading
    const saved = savedSnapshot(id);
    if (saved && !cached && !forceSync) {
      const instant = {
        marker: saved.marker,
        all: saved.messages,
        pix: null,
        loadedAt: Date.now(),
        fromDisk: true
      };
      active.set(id, instant);
      updateBadge();
    }

    // Now fetch from server in background
    if (syncing.has(id)) return active.get(id) || null;
    syncing.add(id);
    updateBadge();

    try {
      const serverMsgs = await fetchHistory(id, true);
      const cleanMsgs = serverMsgs.map(m => ({ ...m, text: E.stripOwnBlock(m.text) }));
      const marker = JSON.stringify(cleanMsgs.slice(-6).map(m => [m.id, m.text]));
      saveSnapshot(id, marker, cleanMsgs);

      const mem = {
        marker,
        all: cleanMsgs,
        pix: null,
        loadedAt: Date.now(),
        fromDisk: false
      };
      active.set(id, mem);
      return mem;
    } finally {
      syncing.delete(id);
      updateBadge();
    }
  }

  function contextForSend(mem, outgoing, lores, budget) {
    mem.pix ||= E.buildPassageIndex(mem.all);
    const lastAssistant = mem.all.filter(m => m.role === 'assistant').at(-1);
    const recentContext = E.stripOwnBlock(lastAssistant?.text || '').slice(0, 600);
    return E.contextWithAll(null, mem.all, outgoing, {
      loreList: lores,
      budget,
      contextQuery: recentContext ? `${outgoing} ${recentContext}` : outgoing,
      passageIndex: mem.pix,
      passageQuery: outgoing,
      passageContext: recentContext,
      maxTurn: Math.max(1, mem.all.length - 1)
    });
  }

  // --- Live Typing Match ---
  function updateLiveMatch(editorText = '') {
    const id = chatId();
    if (!id) return;
    const mem = active.get(id);
    const lores = getLores(id);
    const query = editorText.trim();
    if (!mem) {
      liveMatch = { selected: [], selectedLore: E.selectLore(lores, query), selectedMemory: [], query };
      updateBadge();
      renderLiveCards();
      return;
    }
    const prompt = E.stripOwnBlock(query || mem.all.filter(m => m.role === 'user').at(-1)?.text || '');
    const budget = getBudget(id);
    const res = contextForSend(mem, prompt, lores, budget);
    liveMatch = { ...res, query: prompt };
    updateBadge();
    renderLiveCards();
  }

  const extensionPresent = () => page.__TRACE_SEND_HOOK__ === 'extension';

  // --- WebSocket Hook for Auto-Injection ---
  const nativeSend = page.WebSocket.prototype.send;
  page.WebSocket.prototype.send = function (raw) {
    const frame = E.parseFrame(raw);
    const id = chatId();
    if (!frame || frame.kind !== 'send' || !id || String(frame.payload.chatId || '') !== id || !isEnabled(id)) {
      return nativeSend.call(this, raw);
    }
    if (busy) {
      return nativeSend.call(this, raw);
    }

    const socket = this;
    const outgoing = String(frame.payload.message ?? frame.payload.content ?? frame.payload.text ?? '');
    // The Trace extension is installed too: it injects, Trace Lite stays out of the way.
    if (extensionPresent() || outgoing.includes(E.USER_START)) return nativeSend.call(this, raw);
    const mem = active.get(id);
    const lores = getLores(id);
    // Reuse the passage index after the first preview or send in this room.
    if (mem) {
      try {
        const budget = getBudget(id);
        const res = contextForSend(mem, outgoing, lores, budget);
        if (res.selected.length) {
          const content = E.composeUser(outgoing, res.selected, budget, mem.all.length + 1);
          if (content === outgoing) return nativeSend.call(socket, raw);
          const rewritten = E.replaceFrameMessage(raw, content);
          if (rewritten) {
            recordApplied(id, res.selected);
            // Immediate masking trigger to prevent screen flicker
            setTimeout(maskInjectedMessages, 10);
            setTimeout(maskInjectedMessages, 80);
            setTimeout(maskInjectedMessages, 250);
            scheduleSync(id, 8000);
            return nativeSend.call(socket, rewritten);
          }
        }
      } catch (err) {
        console.warn('[Trace Lite] Injection error, falling back to raw:', err);
      }
      return nativeSend.call(socket, raw);
    }

    // If not yet indexed, try fast fallback
    busy = true;
    void remember(id, false).then(loadedMem => {
      if (loadedMem) {
        const budget = getBudget(id);
        const res = contextForSend(loadedMem, outgoing, lores, budget);
        if (res.selected.length) {
          const content = E.composeUser(outgoing, res.selected, budget, loadedMem.all.length + 1);
          if (content === outgoing) {
            if (socket.readyState === page.WebSocket.OPEN) nativeSend.call(socket, raw);
            return;
          }
          const rewritten = E.replaceFrameMessage(raw, content);
          if (rewritten && socket.readyState === page.WebSocket.OPEN) {
            recordApplied(id, res.selected);
            setTimeout(maskInjectedMessages, 10);
            setTimeout(maskInjectedMessages, 80);
            setTimeout(maskInjectedMessages, 250);
            scheduleSync(id, 8000);
            nativeSend.call(socket, rewritten);
            return;
          }
        }
      }
      if (socket.readyState === page.WebSocket.OPEN) nativeSend.call(socket, raw);
    }).catch(() => {
      if (socket.readyState === page.WebSocket.OPEN) nativeSend.call(socket, raw);
    }).finally(() => { busy = false; });
  };

  let syncTimer = null;
  function scheduleSync(id, delayMs = 8000) {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => {
      if (chatId() === id) {
        void remember(id, true).then(() => {
          updateBadge();
          updateLiveMatch(getCurrentEditorText());
        });
      }
    }, delayMs);
  }

  // --- Applied History ---
  function appliedHistory(id) {
    try {
      const entries = JSON.parse(GM_getValue(key(id, 'applied-v2'), '[]'));
      return Array.isArray(entries) ? entries.slice(0, 15) : [];
    } catch { return []; }
  }
  function recordApplied(id, selected) {
    if (!selected.length) return;
    const entry = {
      at: Date.now(),
      lores: selected.filter(x => x.type === 'lore').map(x => x.title),
      memories: selected.filter(x => x.type === 'passage').map(x => x.messageId)
    };
    GM_setValue(key(id, 'applied-v2'), JSON.stringify([entry, ...appliedHistory(id)].slice(0, 15)));
    renderAppliedHistory();
  }

  // --- UI Components & Styles ---
  function installUi() {
    if (document.getElementById('cum-btn')) return;

    const style = document.createElement('style');
    style.textContent = `
      #cum-btn{position:fixed;right:18px;bottom:18px;z-index:2147483640;border:0;border-radius:24px;padding:8px 16px;background:linear-gradient(135deg,#244275,#1d3156);color:#f0f5ff;font:600 13px system-ui;box-shadow:0 4px 16px rgba(0,0,0,0.35);cursor:pointer;display:inline-flex;align-items:center;gap:6px;transition:all .18s ease}
      #cum-btn:hover{background:linear-gradient(135deg,#2d5292,#254070);box-shadow:0 6px 20px rgba(0,0,0,0.45);transform:translateY(-1px)}
      #cum-btn .cum-dot{width:8px;height:8px;border-radius:50%;background:#48c774;display:inline-block}
      #cum-btn.syncing .cum-dot{background:#ffb703;animation:cum-pulse 1s infinite alternate}
      #cum-btn.disabled .cum-dot{background:#8a99ad}
      @keyframes cum-pulse{0%{opacity:.4}100%{opacity:1}}

      #cum-slot{display:flex;justify-content:flex-end;align-items:center;width:100%;min-height:28px;padding:2px 4px}
      #cum-slot #cum-btn{position:static;box-shadow:none;padding:5px 12px;font-size:12px}

      #cum-panel{position:fixed;right:16px;bottom:64px;z-index:2147483641;box-sizing:border-box;width:min(520px,calc(100vw - 32px));max-height:min(82vh,760px);display:flex;flex-direction:column;background:#151c28;color:#e8edf5;padding:0;border:1px solid #334460;border-radius:14px;box-shadow:0 12px 36px rgba(0,0,0,0.6);font:13px/1.5 system-ui;overflow:hidden}
      #cum-panel[hidden]{display:none}
      @media(max-width:600px){
        #cum-btn{right:max(12px,env(safe-area-inset-right));bottom:calc(12px + env(safe-area-inset-bottom));min-height:40px}
        #cum-panel{right:0;bottom:0;width:100vw;max-height:calc(100dvh - env(safe-area-inset-top));border-radius:14px 14px 0 0;padding-bottom:env(safe-area-inset-bottom)}
        .cum-tab{min-height:44px}.cum-action-btn{min-height:40px}
      }

      .cum-p-header{display:flex;justify-content:space-between;align-items:center;padding:14px 18px;background:#1b2536;border-bottom:1px solid #2d3b52}
      .cum-p-header h3{margin:0;font:700 15px system-ui;display:flex;align-items:center;gap:8px;color:#fff}
      .cum-p-header button{background:transparent;border:0;color:#9eb0ca;font-size:18px;cursor:pointer;padding:0 4px}
      .cum-p-header button:hover{color:#fff}

      .cum-tabs{display:flex;background:#111722;border-bottom:1px solid #2d3b52}
      .cum-tab{flex:1;text-align:center;padding:9px 4px;font-weight:600;font-size:12px;color:#8d9db5;background:transparent;border:0;border-bottom:2px solid transparent;cursor:pointer;transition:all .15s}
      .cum-tab:hover{color:#d4e1f5}
      .cum-tab.active{color:#78a9ff;border-bottom-color:#78a9ff;background:#172030}

      .cum-tab-body{flex:1;overflow-y:auto;padding:16px;display:none}
      .cum-tab-body.active{display:block}

      .cum-card{background:#1d273a;border:1px solid #32435e;border-radius:8px;padding:11px 13px;margin-bottom:10px}
      .cum-card-title{font-weight:700;color:#b2d1ff;display:flex;justify-content:space-between;align-items:center;margin-bottom:4px}
      .cum-badge{font-size:10px;padding:2px 6px;border-radius:4px;font-weight:700}
      .cum-badge-lore{background:#2b4c7e;color:#b8dbff}
      .cum-badge-memory{background:#27553b;color:#a3e9c0}
      .cum-badge-kw{background:#3b2d54;color:#d8bdf9;margin-left:4px}
      .cum-card-body{font-size:12px;color:#cbd6e6;white-space:pre-wrap;overflow-wrap:anywhere}

      .cum-switch-row{display:flex;justify-content:space-between;align-items:center;background:#1d273a;padding:10px 14px;border-radius:8px;margin-bottom:12px}
      .cum-switch-row label{font-weight:600;cursor:pointer;display:flex;align-items:center;gap:8px}
      .cum-switch-row input[type=checkbox]{accent-color:#488aff;width:16px;height:16px;cursor:pointer}

      .cum-form-group{margin-bottom:10px}
      .cum-form-group label{display:block;font-size:11px;font-weight:600;color:#9cb0cf;margin-bottom:4px}
      .cum-form-group input,.cum-form-group textarea{box-sizing:border-box;width:100%;background:#0e141f;border:1px solid #2e3e57;border-radius:6px;color:#fff;padding:8px 10px;font:12px system-ui}
      .cum-form-group textarea{resize:vertical;min-height:64px}
      .cum-btn-row{display:flex;gap:8px;margin-top:10px}
      .cum-action-btn{background:#2a4975;color:#fff;border:0;border-radius:6px;padding:7px 12px;font:600 12px system-ui;cursor:pointer}
      .cum-action-btn:hover{background:#365b90}
      .cum-action-btn.secondary{background:#202a3a;color:#adc0dc;border:1px solid #374760}
      .cum-empty-state{text-align:center;color:#788aa3;padding:24px 10px;font-size:12px}

      /* Injected Block Masking in Chat View */
      .cum-injected-badge{display:block;font-size:11px;color:#7eb0ff;background:rgba(23,33,50,0.75);border:1px dashed rgba(120,169,255,0.45);border-radius:6px;padding:4px 8px;margin:4px 0 8px;user-select:none;cursor:pointer}
      .cum-injected-badge[open]{background:#121926;border-style:solid}
      .cum-injected-badge summary{cursor:pointer;outline:none;font-weight:600;display:inline-flex;align-items:center;gap:4px}
      .cum-injected-raw{max-height:220px;overflow:auto;font:11px/1.45 monospace;color:#c0d2eb;background:#090e16;padding:8px;border-radius:5px;margin-top:6px;white-space:pre-wrap;word-break:break-all}
      .cum-clean-text{white-space:pre-wrap;overflow-wrap:anywhere}
    `;
    document.head.append(style);

    const btn = document.createElement('button');
    btn.id = 'cum-btn';
    btn.type = 'button';
    btn.innerHTML = `<span class="cum-dot"></span><span id="cum-btn-text">기억 준비 중...</span>`;

    const panel = document.createElement('aside');
    panel.id = 'cum-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="cum-p-header">
        <h3>🧠 크랙 로어·기억 인젝터</h3>
        <button id="cum-p-close" type="button" aria-label="닫기">×</button>
      </div>
      <div class="cum-tabs">
        <button class="cum-tab active" data-tab="live">실시간 매칭</button>
        <button class="cum-tab" data-tab="lore">로어북 관리</button>
        <button class="cum-tab" data-tab="history">적용 이력</button>
        <button class="cum-tab" data-tab="settings">설정</button>
      </div>

      <!-- TAB 1: Live Matching -->
      <div id="cum-tab-live" class="cum-tab-body active">
        <div class="cum-switch-row">
          <label><input id="cum-auto-toggle" type="checkbox"><span>자동 주입 활성화 (전송 시 반영)</span></label>
          <button id="cum-resync-btn" class="cum-action-btn secondary" type="button">대화 다시 동기화</button>
        </div>
        <div id="cum-room-info" style="font-size:11px;color:#8ba0c0;margin-bottom:10px"></div>
        <div style="font-weight:600;font-size:12px;color:#9eb5d6;margin-bottom:8px">현재 입력 문장에 매칭된 청크:</div>
        <div id="cum-live-cards"></div>
      </div>

      <!-- TAB 2: Lorebook -->
      <div id="cum-tab-lore" class="cum-tab-body">
        <div class="cum-card" style="background:#152030">
          <div style="font-weight:700;margin-bottom:8px;color:#92bdff">새 로어(설정) 등록</div>
          <div class="cum-form-group">
            <label>제목 (명칭)</label>
            <input id="cum-lore-title" placeholder="예: 은빛열쇠, 성검, 황실 기사단">
          </div>
          <div class="cum-form-group">
            <label>트리거 키워드 (쉼표 구분)</label>
            <input id="cum-lore-keywords" placeholder="예: 은빛열쇠, 열쇠, 비밀상자">
          </div>
          <div class="cum-form-group">
            <label>설정 내용 (프롬프트 주입문)</label>
            <textarea id="cum-lore-content" placeholder="예: 선대 왕이 서재 비밀 서랍에 봉인해둔 고대 유물. 어둠의 결계를 풀 수 있다."></textarea>
          </div>
          <label style="font-size:11px;color:#adc0dc;display:flex;align-items:center;gap:6px;cursor:pointer">
            <input id="cum-lore-always" type="checkbox"> 키워드 상관없이 항상 주입
          </label>
          <div class="cum-btn-row">
            <button id="cum-lore-add-btn" class="cum-action-btn" type="button">현재 방에 로어 추가</button>
            <button id="cum-lore-add-global-btn" class="cum-action-btn secondary" type="button">모든 방 공통 로어로 추가</button>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;margin:14px 0 8px">
          <span style="font-weight:700;color:#d5e2f5">등록된 로어 목록:</span>
          <div style="display:flex;gap:6px">
            <button id="cum-lore-export-btn" class="cum-action-btn secondary" style="padding:3px 8px;font-size:11px" type="button">JSON 내보내기</button>
            <button id="cum-lore-import-btn" class="cum-action-btn secondary" style="padding:3px 8px;font-size:11px" type="button">JSON 가져오기</button>
          </div>
        </div>
        <div id="cum-lore-list"></div>
      </div>

      <!-- TAB 3: History -->
      <div id="cum-tab-history" class="cum-tab-body">
        <div style="font-size:11px;color:#8ea4c2;margin-bottom:10px">최근 전송에 자동 주입된 로어 및 기억 발췌 기록입니다.</div>
        <div id="cum-history-list"></div>
      </div>

      <!-- TAB 4: Settings -->
      <div id="cum-tab-settings" class="cum-tab-body">
        <div class="cum-card">전송 프롬프트는 사용자 입력을 포함해 2,000자 고정입니다. 남는 공간에 기억과 로어를 넣습니다.</div>
        <div class="cum-btn-row">
          <button id="cum-clear-carrier" class="cum-action-btn secondary" type="button">구버전 잔여 주입문 청소</button>
        </div>
      </div>
    `;

    document.body.append(btn, panel);

    // Event Bindings
    btn.onclick = () => {
      panel.hidden = !panel.hidden;
      if (!panel.hidden) refreshPanel();
    };
    panel.querySelector('#cum-p-close').onclick = () => { panel.hidden = true; };

    // Tabs
    const tabs = panel.querySelectorAll('.cum-tab');
    tabs.forEach(t => {
      t.onclick = () => {
        tabs.forEach(x => x.classList.remove('active'));
        panel.querySelectorAll('.cum-tab-body').forEach(b => b.classList.remove('active'));
        t.classList.add('active');
        const target = panel.querySelector(`#cum-tab-${t.dataset.tab}`);
        if (target) target.classList.add('active');
      };
    });

    // Auto inject switch
    const autoToggle = panel.querySelector('#cum-auto-toggle');
    autoToggle.onchange = () => {
      const id = chatId();
      if (id) {
        setEnabled(id, autoToggle.checked);
        updateBadge();
      }
    };

    // Resync button
    panel.querySelector('#cum-resync-btn').onclick = () => {
      const id = chatId();
      if (id) {
        void remember(id, true).then(() => {
          refreshPanel();
          updateLiveMatch(getCurrentEditorText());
        });
      }
    };

    // Lore Add
    panel.querySelector('#cum-lore-add-btn').onclick = () => addLore(false);
    panel.querySelector('#cum-lore-add-global-btn').onclick = () => addLore(true);

    function addLore(isGlobal) {
      const id = chatId();
      const title = panel.querySelector('#cum-lore-title').value.trim();
      const keywords = panel.querySelector('#cum-lore-keywords').value.trim();
      const content = panel.querySelector('#cum-lore-content').value.trim();
      const alwaysInclude = panel.querySelector('#cum-lore-always').checked;
      if (!content) { alert('설정 내용을 입력해주세요.'); return; }
      const newItem = {
        id: `lore_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        title: title || '로어',
        keywords: keywords.split(',').map(s => s.trim()).filter(Boolean),
        content,
        alwaysInclude,
        enabled: true,
        isGlobal
      };
      const existing = isGlobal ? JSON.parse(GM_getValue(globalKey('lore-v1'), '[]')) : (id ? JSON.parse(GM_getValue(key(id, 'lore-v1'), '[]')) : []);
      existing.unshift(newItem);
      saveLores(id, existing, isGlobal);

      panel.querySelector('#cum-lore-title').value = '';
      panel.querySelector('#cum-lore-keywords').value = '';
      panel.querySelector('#cum-lore-content').value = '';
      panel.querySelector('#cum-lore-always').checked = false;
      renderLoreList();
      updateLiveMatch(getCurrentEditorText());
    }

    panel.querySelector('#cum-lore-export-btn').onclick = async () => {
      const id = chatId();
      const all = getLores(id);
      if (!all.length) { alert('내보낼 로어가 없습니다.'); return; }
      const json = JSON.stringify(all, null, 2);
      await navigator.clipboard.writeText(json);
      alert('로어북 JSON이 클립보드에 복사되었습니다.');
    };

    panel.querySelector('#cum-lore-import-btn').onclick = () => {
      const id = chatId();
      const raw = prompt('가져올 로어북 JSON을 붙여넣으세요:');
      if (!raw) return;
      try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) throw Error('배열 형태가 아닙니다.');
        const isGlobal = confirm('모든 방 공통(전역) 로어로 가져올까요?\n[확인] = 전역 로어 / [취소] = 현재 방 로어');
        const existing = isGlobal ? JSON.parse(GM_getValue(globalKey('lore-v1'), '[]')) : (id ? JSON.parse(GM_getValue(key(id, 'lore-v1'), '[]')) : []);
        for (const item of parsed) {
          if (item && item.content) {
            existing.push({
              id: item.id || `lore_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
              title: item.title || '로어',
              keywords: Array.isArray(item.keywords) ? item.keywords : String(item.keywords || '').split(',').map(s => s.trim()).filter(Boolean),
              content: item.content,
              alwaysInclude: !!item.alwaysInclude,
              enabled: item.enabled !== false,
              isGlobal
            });
          }
        }
        saveLores(id, existing, isGlobal);
        renderLoreList();
        updateLiveMatch(getCurrentEditorText());
        alert(`로어 ${parsed.length}개를 가져왔습니다.`);
      } catch (err) {
        alert(`JSON 파싱 오류: ${err.message}`);
      }
    };

    panel.querySelector('#cum-clear-carrier').onclick = async () => {
      const id = chatId();
      if (id) {
        const mem = active.get(id);
        if (mem) {
          saveSnapshot(id, mem.marker, mem.all.map(m => ({ ...m, text: E.stripOwnBlock(m.text) })));
          alert('정리되었습니다.');
        }
      }
    };
  }

  function getCurrentEditorText() {
    const editor = document.querySelector('div.__chat_input_textarea[contenteditable="true"]');
    return editor ? (editor.innerText || editor.textContent || '') : '';
  }

  function updateBadge() {
    const btn = document.getElementById('cum-btn');
    const txt = document.getElementById('cum-btn-text');
    if (!btn || !txt) return;

    const id = chatId();
    if (!id) {
      btn.classList.add('disabled');
      btn.classList.remove('syncing');
      txt.textContent = '채팅방 대기 중';
      return;
    }

    if (syncing.has(id)) {
      btn.classList.add('syncing');
      btn.classList.remove('disabled');
      txt.textContent = '대화 동기화 중...';
      return;
    }

    btn.classList.remove('syncing');
    if (extensionPresent()) {
      btn.classList.add('disabled');
      txt.textContent = 'Trace 확장이 대신 주입 중';
      return;
    }
    if (!isEnabled(id)) {
      btn.classList.add('disabled');
      txt.textContent = '자동 기억 꺼짐';
      return;
    }

    btn.classList.remove('disabled');
    const mem = active.get(id);
    const totalMemories = mem?.all?.length || 0;
    const lCount = liveMatch.selectedLore?.length || 0;
    const mCount = liveMatch.selectedMemory?.length || 0;

    if (lCount > 0 || mCount > 0) {
      txt.textContent = `🧠 기억 ${mCount} · 📜 로어 ${lCount}`;
    } else {
      txt.textContent = totalMemories > 0 ? `🧠 기억 ${totalMemories}턴 준비됨` : `🧠 대화 준비 중`;
    }
  }

  function renderLiveCards() {
    const container = document.getElementById('cum-live-cards');
    if (!container) return;
    container.replaceChildren();

    const selected = liveMatch.selected || [];
    if (!selected.length) {
      const empty = document.createElement('div');
      empty.className = 'cum-empty-state';
      empty.textContent = liveMatch.query ? '현재 입력 문장에 직접 매칭된 로어 또는 관련 기억이 없습니다.' : '크랙 입력창에 타이핑하면 매칭된 로어와 기억이 여기에 실시간으로 표시됩니다.';
      container.append(empty);
      return;
    }

    for (const item of selected) {
      const card = document.createElement('div');
      card.className = 'cum-card';
      const titleRow = document.createElement('div');
      titleRow.className = 'cum-card-title';

      if (item.type === 'lore') {
        titleRow.innerHTML = `<span>📜 ${item.title}</span><span class="cum-badge cum-badge-lore">로어</span>`;
        if (item.matchedKeywords?.length) {
          const kwBadge = document.createElement('span');
          kwBadge.className = 'cum-badge cum-badge-kw';
          kwBadge.textContent = item.matchedKeywords.join(', ');
          titleRow.firstChild.after(kwBadge);
        }
      } else {
        titleRow.innerHTML = `<span>💬 ${item.role === 'user' ? '사용자' : 'AI'} 대화 ${item.turn}</span><span class="cum-badge cum-badge-memory">기억</span>`;
      }

      const body = document.createElement('div');
      body.className = 'cum-card-body';
      body.textContent = item.text || item.content || '';
      card.append(titleRow, body);
      container.append(card);
    }
  }

  function renderLoreList() {
    const container = document.getElementById('cum-lore-list');
    if (!container) return;
    container.replaceChildren();

    const id = chatId();
    const globalLores = JSON.parse(GM_getValue(globalKey('lore-v1'), '[]'));
    const roomLores = id ? JSON.parse(GM_getValue(key(id, 'lore-v1'), '[]')) : [];
    const all = [
      ...globalLores.map(x => ({ ...x, isGlobal: true })),
      ...roomLores.map(x => ({ ...x, isGlobal: false }))
    ];

    if (!all.length) {
      const empty = document.createElement('div');
      empty.className = 'cum-empty-state';
      empty.textContent = '등록된 로어가 없습니다. 상단에서 로어를 추가해보세요.';
      container.append(empty);
      return;
    }

    for (const item of all) {
      const card = document.createElement('div');
      card.className = 'cum-card';
      const titleRow = document.createElement('div');
      titleRow.className = 'cum-card-title';
      titleRow.innerHTML = `<span>${item.title || '로어'} <small style="color:#7f97b7;font-weight:normal">(${item.isGlobal ? '전역' : '현재방'})</small></span>`;

      const rightDiv = document.createElement('div');
      rightDiv.style.display = 'flex';
      rightDiv.style.gap = '6px';
      rightDiv.style.alignItems = 'center';

      const toggle = document.createElement('input');
      toggle.type = 'checkbox';
      toggle.checked = item.enabled !== false;
      toggle.title = '켜기/끄기';
      toggle.onchange = () => {
        item.enabled = toggle.checked;
        const targetList = item.isGlobal ? globalLores : roomLores;
        const target = targetList.find(x => x.id === item.id);
        if (target) target.enabled = item.enabled;
        saveLores(id, targetList, item.isGlobal);
        updateLiveMatch(getCurrentEditorText());
      };

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.textContent = '×';
      delBtn.style.cssText = 'background:transparent;border:0;color:#f87171;font-size:16px;cursor:pointer;line-height:1;padding:0 4px';
      delBtn.title = '삭제';
      delBtn.onclick = () => {
        if (!confirm(`'${item.title}' 로어를 삭제할까요?`)) return;
        const targetList = item.isGlobal ? globalLores : roomLores;
        const updated = targetList.filter(x => x.id !== item.id);
        saveLores(id, updated, item.isGlobal);
        renderLoreList();
        updateLiveMatch(getCurrentEditorText());
      };

      rightDiv.append(toggle, delBtn);
      titleRow.append(rightDiv);

      const kws = document.createElement('div');
      kws.style.cssText = 'font-size:11px;color:#8ea3c4;margin-bottom:4px';
      kws.textContent = `트리거: ${Array.isArray(item.keywords) ? item.keywords.join(', ') : item.keywords || '(키워드 없음)'}${item.alwaysInclude ? ' · 항상 주입' : ''}`;

      const body = document.createElement('div');
      body.className = 'cum-card-body';
      body.textContent = item.content;

      card.append(titleRow, kws, body);
      container.append(card);
    }
  }

  function renderAppliedHistory() {
    const container = document.getElementById('cum-history-list');
    if (!container) return;
    container.replaceChildren();

    const id = chatId();
    const history = id ? appliedHistory(id) : [];
    if (!history.length) {
      const empty = document.createElement('div');
      empty.className = 'cum-empty-state';
      empty.textContent = '아직 이 방에서 주입된 기억 이력이 없습니다.';
      container.append(empty);
      return;
    }

    for (const entry of history) {
      const card = document.createElement('div');
      card.className = 'cum-card';
      const timeStr = entry.at ? new Date(entry.at).toLocaleTimeString() : '';
      const summary = [];
      if (entry.lores?.length) summary.push(`로어: ${entry.lores.join(', ')}`);
      if (entry.memories?.length) summary.push(`기억: ${entry.memories.length}개 조각`);
      card.innerHTML = `<div style="font-weight:600;font-size:11px;color:#859bb8;margin-bottom:4px">${timeStr}</div><div style="font-size:12px;color:#e1e9f5">${summary.join(' · ') || '내용 없음'}</div>`;
      container.append(card);
    }
  }

  function refreshPanel() {
    const id = chatId();
    const autoToggle = document.getElementById('cum-auto-toggle');
    if (autoToggle) autoToggle.checked = id ? isEnabled(id) : false;

    const roomInfo = document.getElementById('cum-room-info');
    if (roomInfo) {
      const mem = id && active.get(id);
      roomInfo.textContent = id
        ? `방 ID: ${id} · 로컬 대화: ${mem?.all?.length || 0}개 색인됨`
        : '채팅방 외부입니다';
    }

    renderLiveCards();
    renderLoreList();
    renderAppliedHistory();
  }

  // --- Mounting & DOM Observation ---
  let attachedEditor = null;
  function mountControl() {
    const id = chatId();
    const btn = document.getElementById('cum-btn');
    if (!btn) return;

    // Detect chat room changes immediately
    if (id && id !== currentRoomId) {
      currentRoomId = id;
      void remember(id, false).then(() => {
        updateBadge();
        updateLiveMatch(getCurrentEditorText());
      });
    }

    // Attach to input composer if available
    const editor = document.querySelector('div.__chat_input_textarea[contenteditable="true"]');
    const inputBox = editor?.parentElement?.parentElement;
    const composer = inputBox?.parentElement;
    let slot = document.getElementById('cum-slot');

    if (editor && composer && inputBox && composer.contains(editor)) {
      if (!slot) { slot = document.createElement('div'); slot.id = 'cum-slot'; }
      if (slot.parentElement !== composer || slot.nextElementSibling !== inputBox) {
        composer.insertBefore(slot, inputBox);
      }
      if (btn.parentElement !== slot) slot.append(btn);
      btn.hidden = false;

      // Bind input events to editor
      if (editor !== attachedEditor) {
        attachedEditor = editor;
        let debounceTimer = null;
        const handler = () => {
          clearTimeout(debounceTimer);
          debounceTimer = setTimeout(() => {
            updateLiveMatch(editor.innerText || editor.textContent || '');
          }, 200);
        };
        editor.addEventListener('input', handler);
        editor.addEventListener('keyup', handler);
        editor.addEventListener('paste', handler);
      }
    } else {
      if (btn.parentElement !== document.body) document.body.append(btn);
      if (slot) slot.remove();
      btn.hidden = !id;
    }

    updateBadge();
  }

  // --- Masking injected block from Chat Bubble UI ---
  function maskInjectedMessages() {
    E.MARKERS.forEach(([startTag, endTag], index) => maskInjectedBlocks(startTag, endTag, index));
  }

  function maskInjectedBlocks(startTag, endTag, index) {
    const maskedKey = `cumMasked${index}`;
    const containerKey = `cumContainerMasked${index}`;
    // 1. Search for elements containing the start tag
    const allEls = document.querySelectorAll('p, div, span, li');
    for (const el of allEls) {
      if (el.closest('#cum-panel, #cum-btn, script, style')) continue;
      if (el.dataset[maskedKey]) continue;

      const txt = el.textContent || '';
      if (!txt.includes(startTag)) continue;

      // Case A: Both start and end tags inside a single element
      if (txt.includes(endTag)) {
        const hasChildWithBoth = Array.from(el.children).some(c => c.textContent && c.textContent.includes(startTag) && c.textContent.includes(endTag));
        if (hasChildWithBoth) continue;

        el.dataset[maskedKey] = 'true';
        const sIdx = txt.indexOf(startTag);
        const eIdx = txt.indexOf(endTag) + endTag.length;
        const cleanText = (txt.substring(0, sIdx) + txt.substring(eIdx)).replace(/^\n+/, '');

        if (el.children.length === 0) {
          el.textContent = cleanText;
          continue;
        }
      }

      // Case B: Spans across multiple sibling elements (e.g. multiple markdown <p> tags under a chat bubble)
      const container = el.parentElement;
      if (!container || container.dataset[containerKey]) continue;

      const containerText = container.textContent || '';
      if (containerText.includes(startTag) && containerText.includes(endTag)) {
        container.dataset[containerKey] = 'true';
        let inBlock = false;
        for (const child of Array.from(container.childNodes)) {
          const cText = child.textContent || '';
          if (!inBlock && cText.includes(startTag)) {
            inBlock = true;
            if (cText.includes(endTag)) {
              inBlock = false;
              const s = cText.indexOf(startTag);
              const e = cText.indexOf(endTag) + endTag.length;
              const remaining = (cText.substring(0, s) + cText.substring(e)).replace(/^\n+/, '');
              if (child.nodeType === Node.TEXT_NODE) {
                child.nodeValue = remaining;
              } else {
                child.textContent = remaining;
                if (!remaining.trim()) child.style.display = 'none';
              }
            } else {
              const s = cText.indexOf(startTag);
              const remaining = cText.substring(0, s);
              if (child.nodeType === Node.TEXT_NODE) {
                child.nodeValue = remaining;
              } else {
                child.textContent = remaining;
                if (!remaining.trim()) child.style.display = 'none';
              }
            }
          } else if (inBlock) {
            if (cText.includes(endTag)) {
              inBlock = false;
              const e = cText.indexOf(endTag) + endTag.length;
              const remaining = cText.substring(e).replace(/^\n+/, '');
              if (child.nodeType === Node.TEXT_NODE) {
                child.nodeValue = remaining;
              } else {
                child.textContent = remaining;
                if (!remaining.trim()) child.style.display = 'none';
              }
            } else {
              // Completely inside injection block: hide it!
              if (child.nodeType === Node.ELEMENT_NODE) {
                child.style.display = 'none';
              } else if (child.nodeType === Node.TEXT_NODE) {
                child.nodeValue = '';
              }
            }
          }
        }
      }
    }
  }

  // Observe page changes & URL transitions
  function init() {
    installUi();
    mountControl();
    maskInjectedMessages();

    // Hook SPA history state
    const pushState = history.pushState;
    history.pushState = function () {
      const res = pushState.apply(this, arguments);
      setTimeout(() => { mountControl(); maskInjectedMessages(); }, 50);
      return res;
    };
    const replaceState = history.replaceState;
    history.replaceState = function () {
      const res = replaceState.apply(this, arguments);
      setTimeout(() => { mountControl(); maskInjectedMessages(); }, 50);
      return res;
    };
    window.addEventListener('popstate', () => setTimeout(() => { mountControl(); maskInjectedMessages(); }, 50));
    window.addEventListener('hashchange', () => setTimeout(() => { mountControl(); maskInjectedMessages(); }, 50));

    // Continuous observation
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => {
        scheduled = false;
        mountControl();
        maskInjectedMessages();
      });
    }).observe(document.body, { childList: true, subtree: true });

    // Periodic room check & masking check
    setInterval(() => {
      mountControl();
      maskInjectedMessages();
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
