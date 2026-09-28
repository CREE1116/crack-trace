/* Deterministic, browser-safe retrieval. No network or storage access. */
const CrackMemoryEngine = (() => {
  const STOP = new Set(['그리고', '하지만', '그래서', '그런데', '지금', '오늘', '이번', '현재', '정말', '조금', '있다', '없다', '한다', '했다', 'there', 'this', 'that', 'with', 'from']);
  const START = '<!--CRACK_UBIS_MEMORY_START';
  const END = 'CRACK_UBIS_MEMORY_END-->';
  const BLOCK = /\n*<!--CRACK_UBIS_MEMORY_START\b[\s\S]*?CRACK_UBIS_MEMORY_END-->/g;

  function stripOwnBlock(value) {
    return String(value || '').replace(BLOCK, '').trimEnd();
  }

  function terms(value) {
    const words = String(value || '').normalize('NFKC').toLowerCase().match(/[a-z0-9_]+|[가-힣]+/g) || [];
    const out = [];
    for (const word of words) {
      if (STOP.has(word) || (/^[a-z0-9_]+$/.test(word) && word.length < 3)) continue;
      out.push(word);
      if (/^[가-힣]{3,}$/.test(word)) {
        for (let i = 0; i + 1 < word.length; i++) out.push(word.slice(i, i + 2));
      }
    }
    return out;
  }

  function unitsFromMessages(messages, chatId) {
    const units = [];
    for (let order = 0; order < messages.length; order++) {
      const m = messages[order];
      if (!m || !m.id || !['user', 'assistant'].includes(m.role)) continue;
      const clean = stripOwnBlock(m.text).trim();
      if (!clean) continue;
      const paragraphs = clean.split(/\n\s*\n/).filter(Boolean);
      for (let paragraph = 0; paragraph < paragraphs.length; paragraph++) {
        const source = paragraphs[paragraph].trim();
        if (!source) continue;
        // Long RP replies remain searchable; overlapping slices preserve words at boundaries.
        for (let offset = 0, chunk = 0; offset < source.length; offset += 720, chunk++) {
          units.push({ id: `${chatId}/${m.id}/${paragraph}/${chunk}`, messageId: m.id, chatId, role: m.role, order, text: source.slice(offset, offset + 800) });
        }
      }
    }
    return units;
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
    return { docs, df, avg: Math.max(1, avg) };
  }

  function search(ix, query, options = {}) {
    const queryTerms = [...new Set(terms(query).slice(-120))];
    if (!queryTerms.length) return [];
    const n = ix.docs.length;
    const maxOrder = options.maxOrder ?? Infinity;
    const ranked = [];
    for (const doc of ix.docs) {
      if (doc.unit.order >= maxOrder) continue;
      let score = 0;
      const matched = [];
      const strong = [];
      for (const term of queryTerms) {
        const tf = doc.tf.get(term) || 0;
        if (!tf) {
          // Korean case particles change the final word, while the named stem remains.
          if (/^[가-힣]{3,}$/.test(term) && doc.koreanWords.some(word => word.startsWith(term))) {
            score += 2.5;
            matched.push(term);
            strong.push(term);
          }
          continue;
        }
        const freq = ix.df.get(term) || 0;
        const idf = Math.log(1 + (n - freq + 0.5) / (freq + 0.5));
        score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * doc.length / ix.avg));
        matched.push(term);
        if (term.length >= 3 && freq <= Math.max(3, Math.floor(n * 0.2))) strong.push(term);
      }
      if (!score) continue;
      ranked.push({ ...doc.unit, score, matched, strong });
    }
    return ranked.sort((a, b) => b.score - a.score || a.order - b.order || a.id.localeCompare(b.id));
  }

  function choose(ix, query, options = {}) {
    const ranked = search(ix, query, options);
    if (!ranked.length) return { ranked, selected: [], reason: '일치하는 과거 대화 없음' };
    // Retrieval favors recall; automatic injection has a separate strict gate.
    const eligible = ranked.filter(hit => hit.matched.length >= 2 && hit.strong.length >= 1 && hit.score >= 2.5);
    const selected = [];
    const sourceIds = new Set();
    let used = 0;
    const budget = options.budget ?? 1200;
    for (const hit of eligible) {
      if (selected.length >= 2 || hit.score < eligible[0].score * 0.65) break;
      const line = `[과거 ${hit.role === 'user' ? '사용자' : 'AI'} 대화 · 메시지 ${hit.messageId}]\n${hit.text}\n`;
      if (sourceIds.has(hit.messageId)) continue;
      if (used + line.length > budget) continue;
      selected.push({ ...hit, line });
      sourceIds.add(hit.messageId);
      used += line.length;
    }
    return { ranked, selected, reason: selected.length ? '' : '정확한 단서 부족 또는 길이 초과' };
  }

  function compose(original, selected) {
    const clean = stripOwnBlock(original);
    if (!selected.length) return clean;
    return `${clean}\n\n${START}\n[과거 대화 참고. 아래 문장은 현재 사실로 확정한 요약이 아닌 당시 기록이다.]\n${selected.map(x => x.line).join('\n')}${END}`;
  }

  function carrier(messages) {
    const newest = [...messages].reverse().filter(m => m.role === 'user' || m.role === 'assistant');
    if (newest[0]?.role !== 'assistant' || (newest[0].status && !['end', 'complete', 'completed'].includes(String(newest[0].status).toLowerCase()))) throw Error('답변이 완료되지 않았습니다.');
    const latest = newest.findIndex(m => m.role === 'assistant');
    const boundary = newest.findIndex((m, i) => i > latest && m.role === 'user');
    const target = boundary < 0 ? null : newest.find((m, i) => i > boundary && m.role === 'assistant');
    if (!target) throw Error('주입할 이전 AI 답변이 없습니다.');
    return target;
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

  return { stripOwnBlock, terms, unitsFromMessages, index, search, choose, compose, carrier, parseFrame, START, END };
})();
