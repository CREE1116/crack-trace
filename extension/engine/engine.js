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

  // "[14 크리·서린]": the turn and who was there. Memories sharing it share one line.
  function memoryMark(turn, who = []) {
    const names = (Array.isArray(who) ? who : []).map(cleanLine).filter(Boolean).join('·');
    const number = Number.isInteger(Number(turn)) && Number(turn) > 0 ? String(Number(turn)) : '';
    return number || names ? `[${[number, names].filter(Boolean).join(' ')}]` : '';
  }

  function memoryBody(title, content) {
    const body = cleanLine(content);
    const label = cleanLine(title);
    // The fact already names its subject, so repeating the label only wastes budget.
    return label && !body.includes(label) ? `${label}｜${body}` : body;
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

  function index(units) {
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
    const lsa = computeLSA(docs, df, 8);
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
  function matchLore(loreList, query, options = {}) {
    if (!Array.isArray(loreList) || !loreList.length) return [];
    const budget = options.budget ?? 650;
    const outgoing = String(query || '').normalize('NFKC').toLowerCase();
    const queryTermList = terms(outgoing);
    const queryTermSet = new Set(queryTermList);
    const selected = [];
    let used = 0;

    const scored = [];
    for (const item of loreList) {
      if (!item || !item.content || item.enabled === false) continue;
      const title = String(item.title || '로어').trim();
      const rawKeywords = Array.isArray(item.keywords)
        ? item.keywords
        : String(item.keywords || '').split(',').map(s => s.trim()).filter(Boolean);

      let matched = false;
      const matchedKeywords = [];
      let matchScore = 0;

      if (item.alwaysInclude) {
        matched = true;
        matchScore += 100;
        matchedKeywords.push('(상시)');
      } else {
        // 1. Keyword Check
        for (const kw of rawKeywords) {
          const normKw = kw.normalize('NFKC').toLowerCase();
          if (!normKw) continue;
          if (outgoing.includes(normKw) || queryTermSet.has(normKw)) {
            matched = true;
            matchedKeywords.push(kw);
            matchScore += 12;
          }
        }

        // 2. Semantic Vector Similarity Check
        const triggerType = item.triggerType || 'both';
        if ((triggerType === 'semantic' || triggerType === 'both') && !matched) {
          const loreCorpus = `${title} ${rawKeywords.join(' ')} ${item.content}`;
          const loreTerms = terms(loreCorpus);
          const loreTermSet = new Set(loreTerms);
          let commonCount = 0;
          for (const qt of queryTermList) {
            if (loreTermSet.has(qt)) commonCount++;
          }
          if (commonCount >= 2 || (queryTermList.length <= 4 && commonCount >= 1 && title.toLowerCase().includes(query.trim().toLowerCase()))) {
            matched = true;
            matchedKeywords.push('(시맨틱)');
            matchScore += commonCount * 2.5;
          }
        }
      }

      if (matched) {
        scored.push({ item, title, content: String(item.content).trim(), matchedKeywords, matchScore });
      }
    }

    scored.sort((a, b) => b.matchScore - a.matchScore);

    for (const { item, title, content, matchedKeywords } of scored) {
      const line = cacheLine('설정', title, content);
      const separator = selected.length ? 1 : 0;
      if (used + line.length + separator > budget) continue;

      selected.push({
        ...item,
        type: 'lore',
        title,
        matchedKeywords,
        line,
        text: `${title}: ${content}`
      });
      used += line.length + separator;
    }
    return selected;
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
    loreList = [],
    summaryCards = [],
    budget = 2000,
    contextQuery = query,
    injectUserNoteToPrompt = false,
    passageIndex = null,
    passageQuery = query,
    passageContext = '',
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

    // 2. Long-term Summary Cards
    const selectedSummaries = [];
    const byMark = new Map();
    for (const s of summaryCards) {
      if (!s || !s.content || s.enabled === false) continue;
      const mark = s.turn ? memoryMark(s.turn, s.who) : '';
      const host = mark && byMark.get(mark);
      if (host) {
        // Same turn and same people: append to that line instead of repeating the mark.
        const piece = ` / ${memoryBody(s.title || '사건 요약', s.content)}`;
        if (piece.length > remaining) continue;
        host.line += piece;
        const card = { ...s, type: 'summary', line: '', text: `${s.title}: ${s.content}` };
        selectedSummaries.push(card);
        finalSelected.push(card);
        remaining -= piece.length;
        continue;
      }
      const line = cacheLine('기억', s.title || '사건 요약', s.content, s.turn, s.who);
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

    // 3. Lorebook Items (Hybrid Keyword + Semantic Vector)
    const selectedLore = matchLore(loreList, contextQuery, { budget: Math.min(600, Math.floor(remaining * 0.55)) });
    for (const l of selectedLore) {
      const sep = finalSelected.length ? 1 : 0;
      if (l.line.length + sep <= remaining) {
        finalSelected.push(l);
        remaining -= (l.line.length + sep);
      }
    }

    // 4. Original passages (no-LLM mode) or legacy chunks
    const memoryResult = passageIndex
      ? { selected: passageSearch(passageIndex, passageQuery, { contextQuery: passageContext, budget: remaining, maxTurn }) }
      : ix ? contextFor(ix, messages, contextQuery, { budget: remaining }) : { selected: [] };
    const selectedMemory = memoryResult.selected || [];
    for (const m of selectedMemory) {
      finalSelected.push(m);
    }

    return {
      selected: finalSelected,
      userNote: cleanUserNote,
      selectedUserNote,
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
      // "▍크리 「 대사 」" dialogue markers become "크리: 대사".
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
    // "크리｜Lv.1" is a status header; the name is the part before the bar.
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
    const INFO_BLOCK_REGEX = /(?:```(?:INFO|STATUS|STAT|SYSTEM)[\s\S]*?```|\[\s*#[\s\S]*?(?:\]|$)|└?\[\s*(?:호감도|성향|체력|마력|능력치|스탯|스킬|레벨|경험치|아이템|소지품|골드|골|퀘스트|위치|현재\s*상태|버프|디버프|HP|MP|EXP|Lv)[\s\S]*?(?:\]|$)|(?:\(|\[)\s*ooc[\s\S]*?(?:\)|\]|$)|⚠\s*SYSTEM[\s\S]*?(?:\n|$)|#\s*\(크리의[\s\S]*?(?:\)|\]|$))/gi;

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
  const STATUS_LINE = /^(?:[⌛⏳📍🕒⏰🗓📅💼🤝📝📊🎒❤️💰]|\s*(?:물자|호감도|상태창|스탯|획득|소모|인벤토리|소지품)(?=\s|$|[:：]))|\d+\s*일차|\d{1,2}\/\d{1,2}\s*\[/u;

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
    const body = [];
    for (const raw of lines) {
      // "INFO[크리｜男｜21…]", "[관계｜레오😠｜…]", "└[일정…]": status blocks, also when they
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
      body.push(line.replace(/!\[[^\]]*\]\([^)]+\)/g, '').replace(/[*_]{1,3}/g, '').replace(/^[▍▌]\s*([^\s「『"“]{1,10})\s*[「『"“]\s*/u, '$1: '));
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
          const speakers = [...new Set([...text.matchAll(SPEAKER_LABEL)].map(match => match[1]))];
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
    const names = new Set([...speakerCounts].filter(([name, count]) => count >= 2 && !STOPWORDS_SET.has(name)).map(([name]) => name));
    return { units, ix: index(units), names };
  }

  // The draft decides what is relevant; the latest reply only supports. Passages from the
  // live window (turn >= maxTurn) are skipped: Crack already shows them to the model.
  function passageSearch(pix, query, { contextQuery = '', budget = 1200, maxTurn = Infinity, perTurn = 2 } = {}) {
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
    const names = pix.names || new Set();
    // Names in the draft: passages about that person, and above all their own lines, come first.
    const draftNames = [...names].filter(name => query.includes(name));
    if (draftNames.length) {
      for (const [id, score] of scores) {
        const unit = byId.get(id);
        const factor = unit.speakers?.some(name => draftNames.includes(name)) ? 1.5
          : draftNames.some(name => unit.text.includes(name)) ? 1.3 : 1;
        scores.set(id, score * factor);
      }
    }
    // Query expansion by people: the best draft matches name others who belong to the same
    // thread; pull their passages in at a low weight. Only names, so the search cannot drift.
    const seedBest = Math.max(0, ...scores.values());
    const seeds = [...scores].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([id]) => byId.get(id));
    const related = [...new Set(seeds.flatMap(unit => [...names].filter(name => unit.text.includes(name))))]
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
    const newestFor = name => pix.units.filter(unit => unit.turn < maxTurn && unit.text.includes(name)).at(-1);
    for (const unit of [...picked]) {
      if (lastTurn - unit.turn < 20) continue;
      for (const name of [...names].filter(name => unit.text.includes(name)).slice(0, 2)) {
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
    matchLore,
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
