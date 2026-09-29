// Trace - Background Service Worker (Manifest V3)
importScripts('../engine/engine.js');

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});

const CONTENTS = 'https://contents-api.wrtn.ai/character-chat/v3/chats';
const API = 'https://crack-api.wrtn.ai/crack-gen/v3/chats';
const PROMPT_LIMIT = 2000;
const activeMemory = new Map();
const nanoJobs = new Map();
const nanoIndexes = new Map();

const MEMORY_DOMAINS = new Set(['인물', '장소', '기술', '사건/약조', '개념']);

function factFingerprint(keyword, fact) {
  let hash = 2166136261;
  for (const char of `${normalizedKeyword(keyword)}\u0000${String(fact).trim()}`) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function reconcileNanoFactIds(previous, fresh) {
  const used = new Set();
  return fresh.map(fact => {
    const nextTerms = new Set(CrackMatrixEngine.terms(fact.fact));
    let best = null;
    let bestScore = 0.3;
    for (const old of previous || []) {
      if (used.has(old.id) || old.sourceId !== fact.sourceId || normalizedKeyword(old.keyword) !== normalizedKeyword(fact.keyword)) continue;
      const oldTerms = new Set(CrackMatrixEngine.terms(old.fact));
      let common = 0;
      for (const term of nextTerms) if (oldTerms.has(term)) common++;
      const union = nextTerms.size + oldTerms.size - common;
      const score = union ? common / union : 0;
      if (score > bestScore) { best = old; bestScore = score; }
    }
    if (best) { used.add(best.id); return { ...fact, id: best.id }; }
    return fact;
  });
}

function normalizedKeyword(value) {
  return String(value || '').normalize('NFKC').trim().toLowerCase();
}

function compactEvidence(value) {
  return String(value || '').normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

function effectiveNanoFacts(facts, overrides = {}, droppedKeywords = []) {
  const dropped = new Set(droppedKeywords.map(normalizedKeyword));
  return (facts || []).flatMap(fact => {
    const override = overrides[fact.id];
    if (override?.deleted) return [];
    const effective = override ? { ...fact, ...override } : fact;
    return dropped.has(normalizedKeyword(effective.keyword)) ? [] : [effective];
  });
}

async function loadNanoFacts(chatId) {
  const data = await chrome.storage.local.get([`nanoMemory:${chatId}`, `nanoOverrides:${chatId}`, `dropKw:${chatId}`]);
  return effectiveNanoFacts(data[`nanoMemory:${chatId}`]?.facts,
    data[`nanoOverrides:${chatId}`] || {}, data[`dropKw:${chatId}`] || []);
}

function parseNanoFacts(raw, turn, sourceId, limit = 16, allowedTurns = [], candidateDomains = new Map(), sourceMessages = []) {
  const cleaned = String(raw || '').trim().replace(/^```(?:json)?\s*|\s*```$/gi, '');
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed)) throw Error('Nano memory response is not an array');
  const allowed = new Set(allowedTurns);
  const sourceByTurn = new Map(sourceMessages.map(row => [row.turn, compactEvidence(row.text)]));
  const allSource = [...sourceByTurn.values()].join('|');
  const seen = new Set();
  return parsed.slice(0, limit).flatMap((item, index) => {
    const keyword = String(item?.keyword || '').trim().slice(0, 40);
    const fact = String(item?.fact || '').trim().slice(0, 300);
    if (!keyword || !fact || !/[가-힣]/.test(fact)) return [];
    const claimedTurn = Number(item?.turn);
    const sourceTurn = allowed.has(claimedTurn) ? claimedTurn : allowedTurns.length === 1 ? allowedTurns[0] : null;
    if (sourceTurn === null) return [];
    const anchor = compactEvidence(keyword);
    if (sourceMessages.length && (!anchor || !allSource.includes(anchor))) return [];
    const technical = /(?:lsa|nlp|bm25|gemini|프롬프트|인젝션|키워드|로컬분석)/i;
    if (sourceMessages.length && technical.test(fact) && !technical.test(sourceMessages.map(row => row.text).join(' '))) return [];
    const fingerprint = `${anchor}:${compactEvidence(fact)}`;
    if (seen.has(fingerprint)) return [];
    seen.add(fingerprint);
    const claimedDomain = String(item?.domain || '').trim();
    const domain = candidateDomains.get(keyword) || (MEMORY_DOMAINS.has(claimedDomain) ? claimedDomain : '개념');
    return [{ id: `${sourceId}:${factFingerprint(keyword, fact)}:${index}`, keyword, fact, domain, turn: sourceTurn, sourceId }];
  });
}

function clipNanoMessage(value, limit) {
  const text = CrackMatrixEngine.stripOwnBlock(String(value || ''));
  if (text.length <= limit) return text;
  const tailSize = Math.floor(limit * 0.3);
  return `${text.slice(0, limit - tailSize - 8)}\n[중간 생략]\n${text.slice(-tailSize)}`;
}

function buildNanoWindow(messages, startIndex) {
  const weight = messages.reduce((sum, message) => sum + (message.role === 'assistant' ? 2 : 1), 0);
  const unit = Math.floor(5400 / Math.max(1, weight));
  return messages.map((message, offset) => {
    const assistant = message.role === 'assistant';
    const limit = Math.min(assistant ? 1200 : 900, Math.max(180, unit * (assistant ? 2 : 1)));
    return `대화 ${startIndex + offset + 1} ${assistant ? '상대' : '사용자'}: ${clipNanoMessage(message.text, limit)}`;
  }).join('\n');
}

function analyzeNanoWindow(messages) {
  const graph = CrackMatrixEngine.stepSlidingWindowGraph(
    CrackMatrixEngine.createEvolutionGraph(), messages, 1, messages.length
  );
  const units = CrackMatrixEngine.unitsFromMessages(messages.map((message, index) => ({
    ...message, id: message.id || `window-${index}`
  })), 'nano-hints', 30, 180);
  const ix = CrackMatrixEngine.index(units);
  const cards = CrackMatrixEngine.generateKeywordEvolutionCards(graph);
  const ranked = cards.map(card => ({
    keyword: card.keyword,
    domain: card.domain,
    score: (CrackMatrixEngine.search(ix, card.keyword)[0]?.score || 0) + (card.importance || 0)
  })).sort((a, b) => b.score - a.score).slice(0, 12);
  return {
    hints: ranked.map(card => `${card.keyword}(${card.domain})`).join(', '),
    domains: new Map(ranked.map(card => [card.keyword, card.domain]))
  };
}

function recentMemoryCutoff(messages, turns = 4) {
  const assistantTurns = (messages || []).map((message, index) => message.role === 'assistant' ? index + 1 : null).filter(Boolean);
  return assistantTurns.at(-turns) || assistantTurns[0] || Infinity;
}

function nanoMemoryCards(chatId, facts, query, recentCutoff = Infinity, recentContext = '') {
  if (!Array.isArray(facts) || !facts.length || !(query + recentContext).trim()) return [];
  const eligible = facts.filter(fact => fact.enabled !== false && Number(fact.turn) < recentCutoff);
  if (!eligible.length) return [];
  const byId = new Map();
  for (const fact of eligible) byId.set(fact.id, fact);
  const fingerprint = `${eligible.length}:${eligible.at(-1)?.id || ''}`;
  const cached = nanoIndexes.get(chatId);
  let ix = cached?.fingerprint === fingerprint ? cached.ix : null;
  if (!ix) {
    const messages = eligible.map(fact => ({ id: fact.id, role: 'assistant', text: `${fact.keyword} ${fact.fact}` }));
    ix = CrackMatrixEngine.index(CrackMatrixEngine.unitsFromMessages(messages, 'nano', 5));
    nanoIndexes.set(chatId, { fingerprint, ix });
  }
  const scoreById = new Map();
  for (const [text, weight] of [[query, 1], [recentContext, 0.45]]) {
    if (!text.trim()) continue;
    for (const hit of CrackMatrixEngine.search(ix, text).slice(0, 100)) {
      if (!byId.has(hit.messageId)) continue;
      scoreById.set(hit.messageId, (scoreById.get(hit.messageId) || 0) + hit.score * weight);
    }
  }
  const best = Math.max(0, ...scoreById.values());
  const latestTurn = Math.max(1, ...eligible.map(fact => Number(fact.turn) || 1));
  const normalizedQuery = normalizedKeyword(query);
  const candidates = [...scoreById].map(([id, score]) => {
    const fact = byId.get(id);
    const turn = Number(fact.turn) || 1;
    const exact = normalizedQuery.includes(normalizedKeyword(fact.keyword)) ? 0.3 : 0;
    const temporal = 0.1 * Math.exp(-(latestTurn - turn) / 40) + 0.06 * Math.exp(-(turn - 1) / 40);
    return { fact, score, relevance: score / (best || 1) + exact + temporal,
      terms: new Set(CrackMatrixEngine.terms(`${fact.keyword} ${fact.fact}`)) };
  }).filter(candidate => candidate.score >= Math.max(0.05, best * 0.12) || normalizedQuery.includes(normalizedKeyword(candidate.fact.keyword)));
  const selected = [];
  const perKeyword = new Map();
  while (candidates.length && selected.length < 32) {
    let winner = -1;
    let winnerScore = -Infinity;
    for (let index = 0; index < candidates.length; index++) {
      const candidate = candidates[index];
      const keyword = normalizedKeyword(candidate.fact.keyword);
      if ((perKeyword.get(keyword) || 0) >= 4) continue;
      let similarity = 0;
      for (const prior of selected) {
        let common = 0;
        for (const term of candidate.terms) if (prior.terms.has(term)) common++;
        const union = candidate.terms.size + prior.terms.size - common;
        similarity = Math.max(similarity, union ? common / union : 0);
      }
      const rank = 0.8 * candidate.relevance - 0.2 * similarity;
      if (rank > winnerScore) { winner = index; winnerScore = rank; }
    }
    if (winner < 0) break;
    const picked = candidates.splice(winner, 1)[0];
    const keyword = normalizedKeyword(picked.fact.keyword);
    perKeyword.set(keyword, (perKeyword.get(keyword) || 0) + 1);
    selected.push(picked);
  }
  return selected.map(({ fact }) => ({
    id: `nano:${fact.id}`, title: fact.keyword,
    content: fact.fact, enabled: true
  }));
}

async function processNanoMemory(chatId, messages, report = () => {}, options = {}) {
  if (nanoJobs.has(chatId)) return nanoJobs.get(chatId);
  const job = (async () => {
    const { llmIntervention, nanoBatchSize: savedBatchSize } = await chrome.storage.local.get(['llmIntervention', 'nanoBatchSize']);
    if (llmIntervention === false) return { error: 'Nano 개입이 꺼져 있습니다.' };
    const assistants = messages.map((message, index) => ({ message, index }))
      .filter(row => row.message.role === 'assistant');
    if (!assistants.length) return { complete: true, done: 0, total: 0 };
    const key = `nanoMemory:${chatId}`;
    const rebuild = Boolean(options.rebuild);
    const draftKey = `nanoMemoryDraft:${chatId}`;
    const saved = rebuild ? {} : (await chrome.storage.local.get(key))[key] || {};
    const anchor = assistants.findIndex(row => row.message.id === saved.lastId);
    let done = anchor >= 0 ? anchor + 1 : 0;
    const facts = done ? [...(saved.facts || [])] : [];
    if (done === assistants.length) return { complete: true, done, total: assistants.length };
    const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
    if (!panels.length) return { complete: false, done, total: assistants.length,
      pending: assistants.length - done };
    const batchSize = Math.max(1, Math.min(10, Number(savedBatchSize) || 4));
    const force = Boolean(options.force);
    report('Nano 기억 축적', done, assistants.length);
    let errorMessage = '';
    while (done < assistants.length) {
      const count = Math.min(batchSize, assistants.length - done);
      if (count < batchSize && !force) break;
      const end = assistants[done + count - 1];
      const first = assistants[done];
      const windowMessages = messages.slice(Math.max(0, first.index - 1), end.index + 1);
      const startIndex = Math.max(0, first.index - 1);
      const window = buildNanoWindow(windowMessages, startIndex);
      const analysis = analyzeNanoWindow(windowMessages);
      const turns = windowMessages.map((message, offset) => message.role === 'assistant' ? startIndex + offset + 1 : null).filter(Boolean);
      let timer;
      let result;
      try {
        result = await Promise.race([
          chrome.runtime.sendMessage({ type: 'NANO_MEMORY_WINDOW', target: 'sidepanel', window, hints: analysis.hints }),
          new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Nano timeout')), 60000); })
        ]);
        if (!result?.success) {
          errorMessage = String(result?.error || 'Nano 응답 실패');
          break;
        }
        const dropped = (await chrome.storage.local.get(`dropKw:${chatId}`))[`dropKw:${chatId}`] || [];
        const excluded = new Set(dropped.map(normalizedKeyword));
        const sourceMessages = windowMessages.map((message, offset) => ({ turn: startIndex + offset + 1,
          text: CrackMatrixEngine.stripOwnBlock(String(message.text || '')) }));
        const next = parseNanoFacts(result.text, end.index + 1, end.message.id, Math.min(16, count * 4), turns, analysis.domains, sourceMessages)
          .filter(fact => !excluded.has(normalizedKeyword(fact.keyword)));
        facts.push(...next);
      } catch (error) {
        errorMessage = String(error.message || error);
        console.warn('[CrackMatrix] Nano memory paused:', error);
        break;
      } finally {
        clearTimeout(timer);
      }
      done += count;
      await chrome.storage.local.set({ [rebuild ? draftKey : key]: { lastId: end.message.id, facts, updatedAt: Date.now() } });
      if (!rebuild) nanoIndexes.delete(chatId);
      report('Nano 기억 축적', done, assistants.length);
    }
    if (rebuild) {
      if (done === assistants.length && !errorMessage) {
        const previous = (await chrome.storage.local.get(key))[key]?.facts || [];
        await chrome.storage.local.set({ [key]: { lastId: assistants.at(-1).message.id,
          facts: reconcileNanoFactIds(previous, facts), updatedAt: Date.now() } });
        nanoIndexes.delete(chatId);
      }
      await chrome.storage.local.remove(draftKey);
    }
    return { complete: done === assistants.length, done, total: assistants.length,
      pending: assistants.length - done, error: errorMessage };
  })().finally(() => nanoJobs.delete(chatId));
  nanoJobs.set(chatId, job);
  return job;
}

function startNanoMemory(chatId, messages, force = false, rebuild = false) {
  if (nanoJobs.has(chatId)) {
    if (force || rebuild) nanoJobs.get(chatId).then(
      () => startNanoMemory(chatId, messages, force, rebuild),
      () => startNanoMemory(chatId, messages, force, rebuild)
    );
    return;
  }
  const progressId = crypto.randomUUID();
  const report = (stage, done, total) => {
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'ANALYSIS_PROGRESS', chatId, key: 'nano', progressId, stage, done, total
        }).catch(() => {});
      }
    });
  };
  processNanoMemory(chatId, messages, report, { force, rebuild }).catch(error => ({ error: String(error.message || error) })).then(result => {
    chrome.tabs.query({}, tabs => {
      for (const tab of tabs) if (tab.id) {
        chrome.tabs.sendMessage(tab.id, {
          type: 'ANALYSIS_DONE', chatId, key: 'nano', progressId,
          error: result?.error || '', done: result?.done || 0,
          total: result?.total || 0, pending: result?.pending || 0
        }).catch(() => {});
      }
    });
  });
}

function progressReporter(sender, msg, key) {
  const tabId = sender.tab?.id;
  if (!tabId || !msg.progressId) return () => {};
  return (stage, done, total) => {
    chrome.tabs.sendMessage(tabId, {
      type: 'ANALYSIS_PROGRESS', chatId: msg.chatId, key,
      progressId: msg.progressId, stage, done, total
    }).catch(() => {});
  };
}

// Yield between groups of real four-message windows so the UI can paint
// each completed count while the graph is being rebuilt.
async function buildGraphWithProgress(messages, report = () => {}, options = {}) {
  const graph = CrackMatrixEngine.createEvolutionGraph();
  const total = messages.length;
  for (let i = 0; i < total; i += 4) {
    const done = Math.min(total, i + 4);
    CrackMatrixEngine.stepSlidingWindowGraph(graph, messages.slice(i, done), i + 1, done, options);
    if (done === total || (i / 4 + 1) % 8 === 0) {
      report('기억 분석', done, total);
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return CrackMatrixEngine.compactEvolutionGraph(graph);
}

// --- Secure Token Acquisition via Chrome Cookies API ---
async function getAuthToken() {
  try {
    const cookie = await chrome.cookies.get({ url: 'https://crack.wrtn.ai', name: 'access_token' });
    if (cookie?.value) return decodeURIComponent(cookie.value);
  } catch {}
  return '';
}

async function crackFetch(method, path, body) {
  const token = await getAuthToken();
  const res = await fetch(path, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// --- Fetch Full Chat History & Build SVD Index in Background ---
async function syncChat(chatId, report = () => {}) {
  if (!chatId) return null;
  const encoded = encodeURIComponent(chatId);
  const all = [], seen = new Set();
  let cursor = '', host = CONTENTS;

  do {
    const url = `${host}/${encoded}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    let data;
    try {
      const payload = await crackFetch('GET', url);
      data = payload?.data || payload;
    } catch (e) {
      if (host === CONTENTS && !all.length) {
        host = API;
        const payload = await crackFetch('GET', `${host}/${encoded}/messages?limit=50${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
        data = payload?.data || payload;
      } else break;
    }

    if (!Array.isArray(data?.messages)) break;
    for (const raw of data.messages) {
      const id = String(raw._id || raw.id || '');
      const text = String(raw.content ?? raw.message ?? '');
      const role = String(raw.role || raw.senderRole || '').toLowerCase();
      if (id && text && ['user', 'assistant'].includes(role) && !seen.has(id)) {
        seen.add(id);
        all.push({ id, text: CrackMatrixEngine.stripOwnBlock(text), role });
      }
    }
    cursor = data.nextCursor == null ? '' : String(data.nextCursor);
    if (!cursor || all.length > 2500) break;
  } while (cursor);

  const cleanAll = all.reverse();
  report('대화 기록 불러옴', 0, cleanAll.length);
  const { llmIntervention } = await chrome.storage.local.get('llmIntervention');
  const useNano = llmIntervention !== false;
  const units = useNano ? [] : CrackMatrixEngine.unitsFromMessages(cleanAll, chatId);
  const ix = useNano ? null : CrackMatrixEngine.index(units);

  const mem = {
    chatId,
    all: cleanAll,
    units,
    ix,
    loadedAt: Date.now()
  };
  activeMemory.set(chatId, mem);

  chrome.storage.local.set({ [`snap:${chatId}`]: { messages: cleanAll, savedAt: Date.now() } });
  if (useNano) {
    startNanoMemory(chatId, cleanAll);
  } else {
    try {
      await checkAndTriggerAutoSlidingGraph(chatId, cleanAll, report);
    } catch (error) {
      console.warn('[CrackMatrix] Automatic memory analysis failed:', error);
    }
    updateSituation(chatId).catch(() => {});
  }
  return { messageCount: cleanAll.length, unitCount: units.length };
}

// --- Crack Official Supported Models & Live Latency / Radiosonde dataset ---
// --- Keep the newest turns current without re-reading the whole chat ---
// syncChat() runs when a room is opened; while chatting, only the latest page
// is fetched and merged (at most once per REFRESH_MS per room).
const REFRESH_MS = 5000;
const lastRefresh = new Map();

async function refreshRecent(chatId) {
  if (!chatId) return null;
  let mem = activeMemory.get(chatId);
  if (!mem) {
    await syncChat(chatId);
    return activeMemory.get(chatId) || null;
  }
  const now = Date.now();
  if (now - (lastRefresh.get(chatId) || 0) < REFRESH_MS) return mem;
  lastRefresh.set(chatId, now);

  const encoded = encodeURIComponent(chatId);
  let data;
  try {
    const payload = await crackFetch('GET', `${CONTENTS}/${encoded}/messages?limit=20`);
    data = payload?.data || payload;
  } catch {
    const payload = await crackFetch('GET', `${API}/${encoded}/messages?limit=20`);
    data = payload?.data || payload;
  }
  if (!Array.isArray(data?.messages)) return mem;

  const known = new Set(mem.all.map(m => m.id));
  const fresh = [];
  for (const raw of data.messages) {                      // newest first
    const id = String(raw._id || raw.id || '');
    const text = String(raw.content ?? raw.message ?? '');
    const role = String(raw.role || raw.senderRole || '').toLowerCase();
    if (id && text && ['user', 'assistant'].includes(role) && !known.has(id)) {
      fresh.push({ id, text: CrackMatrixEngine.stripOwnBlock(text), role });
    }
  }
  if (!fresh.length) return mem;

  const all = mem.all.concat(fresh.reverse());
  const { llmIntervention } = await chrome.storage.local.get('llmIntervention');
  const useNano = llmIntervention !== false;
  const units = useNano ? [] : CrackMatrixEngine.unitsFromMessages(all, chatId);
  mem = { chatId, all, units, ix: useNano ? null : CrackMatrixEngine.index(units), loadedAt: now };
  activeMemory.set(chatId, mem);
  chrome.storage.local.set({ [`snap:${chatId}`]: { messages: all, savedAt: now } });
  if (useNano) startNanoMemory(chatId, all);
  else {
    checkAndTriggerAutoSlidingGraph(chatId, all).catch(() => {});
    updateSituation(chatId).catch(() => {});
  }
  return mem;
}

// --- "직전 상황": a short memo of the latest scene, rebuilt when turns arrive ---
const SITUATION_CHARS = 360;

async function nanoSituation(messages) {
  const { llmIntervention } = await chrome.storage.local.get('llmIntervention');
  if (llmIntervention === false) return '';
  const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
  if (!panels.length) return '';
  const recent = messages.slice(-4).map(m =>
    `${m.role === 'user' ? '사용자' : '상대'}: ${CrackMatrixEngine.stripOwnBlock(m.text || '').slice(0, 500)}`
  ).join('\n');
  if (!recent.trim()) return '';
  // The Prompt API needs an extension document. A closed side panel has no
  // listener; Chrome then rejects the message and extraction remains usable.
  try {
    let timer;
    const result = await Promise.race([
      chrome.runtime.sendMessage({ type: 'NANO_SITUATION_REQUEST', target: 'sidepanel', recent }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(Error('Nano timeout')), 25000); })
    ]).finally(() => clearTimeout(timer));
    const value = String(result?.text || '').trim().slice(0, SITUATION_CHARS);
    return result?.success && /[가-힣]/.test(value) ? value : '';
  } catch {
    return '';
  }
}

async function updateSituation(chatId, force = false) {
  const mem = activeMemory.get(chatId);
  if (!mem || !mem.all.length) return null;
  const key = `situation:${chatId}`;
  const turn = mem.all.length;
  const prev = (await chrome.storage.local.get(key))[key];
  if (!force && prev && prev.turn === turn) return prev;
  const generated = await nanoSituation(mem.all);
  const text = generated || CrackMatrixEngine.recentSituationExtract(mem.all, mem.ix, SITUATION_CHARS);
  const out = { turn, text, source: generated ? 'nano' : 'extract', at: Date.now() };
  await chrome.storage.local.set({ [key]: out });
  return out;
}

// --- Model monitoring (IGX Radiosonde, https://rs.igx.kr) ---
// Real measurements only: nothing is shown for a model the service does not
// report, and no default numbers exist. Scores are for the underlying models
// Radiosonde monitors (Claude / Gemini / ChatGPT ...), matched to Crack's
// options by name in the content script.
const RADIOSONDE = 'https://rs.igx.kr/api/v2';
const NAMES_TTL_MS = 24 * 60 * 60 * 1000;
let scoreRefresh = null;

async function radiosonde(path) {
  const res = await fetch(`${RADIOSONDE}${path}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Radiosonde HTTP ${res.status}`);
  const body = await res.json();
  if (!body?.success) throw new Error('Radiosonde error');
  return body.data;
}

async function modelDisplayNames() {
  const { modelNames, modelNamesAt } = await chrome.storage.local.get(['modelNames', 'modelNamesAt']);
  if (modelNames && Date.now() - (modelNamesAt || 0) < NAMES_TTL_MS) return modelNames;
  const names = {};
  for (const provider of await radiosonde('/statistics')) {
    for (const m of provider.models || []) names[m.model] = { display: m.display, provider: provider.provider };
  }
  await chrome.storage.local.set({ modelNames: names, modelNamesAt: Date.now() });
  return names;
}

// Radiosonde rate-limits bursts (429/428 when all models are asked at once),
// so models are fetched one at a time with a short gap, a rate-limited
// request is retried after the server's Retry-After (or a backoff), and a
// model that still fails keeps its previous real measurement.
const RS_GAP_MS = 200;
const RS_RETRIES = 3;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function radiosondeSimple(id) {
  for (let attempt = 0; attempt <= RS_RETRIES; attempt++) {
    const res = await fetch(`${RADIOSONDE}/simple/${encodeURIComponent(id)}`, { cache: 'no-store' });
    if (res.ok) {
      const body = await res.json();
      if (body?.success) return body.data;
      throw new Error('Radiosonde error');
    }
    if (res.status !== 429 && res.status !== 428) throw new Error(`Radiosonde HTTP ${res.status}`);
    const wait = Number(res.headers.get('retry-after')) * 1000 || 1500 * (attempt + 1);
    await sleep(wait);
  }
  throw new Error('Radiosonde rate limit');
}

function updateModelScores() {
  if (scoreRefresh) return scoreRefresh;
  scoreRefresh = (async () => {
  try {
    const ids = await radiosonde('/models');
    const names = await modelDisplayNames().catch(() => ({}));
    const { modelScores: previous = {} } = await chrome.storage.local.get('modelScores');
    const scores = {};
    let fresh = 0;
    for (const id of ids) {
      try {
        const s = await radiosondeSimple(id);
        scores[id] = {
          id,
          display: names[id]?.display || id,
          provider: names[id]?.provider || '',
          status: s.status,
          latencyMs: s.latency,
          tps: s.tps,
          score: s.score,
          failureCount: s.failureCount,
          measuredAt: s.measuredAt
        };
        fresh++;
      } catch {
        if (previous[id]) scores[id] = previous[id];      // keep the last real value
      }
      await sleep(RS_GAP_MS);
    }
    if (Object.keys(scores).length) {
      await chrome.storage.local.set({ modelScores: scores, modelScoresUpdatedAt: Date.now(),
        modelScoresError: fresh < ids.length ? `${ids.length - fresh}개 모델은 이전 측정값 유지` : '' });
    }
  } catch (e) {
    await chrome.storage.local.set({ modelScoresError: String(e?.message || e) });
  }
  return chrome.storage.local.get(['modelScores', 'modelScoresUpdatedAt', 'modelScoresError']);
  })().finally(() => { scoreRefresh = null; });
  return scoreRefresh;
}

updateModelScores();
chrome.alarms.create('updateScores', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'updateScores') updateModelScores();
});

// --- Automated Sliding-Window Evolving Graph Trigger ---
async function checkAndTriggerAutoSlidingGraph(chatId, messages, report = () => {}) {
  if (!chatId || !messages || messages.length < 4) return;
  const keyAuto = `auto:${chatId}`;
  const keySummary = `summary:${chatId}`;
  const keyGraph = `graph:${chatId}`;
  const keyLastTurn = `summary:lastAutoTurn:${chatId}`;
  const keyDrop = `dropKw:${chatId}`;
  const configKeys = [keyAuto, keySummary, keyGraph, keyLastTurn, keyDrop, 'autoSummaryEnabled', 'autoSummaryInterval'];

  const data = await chrome.storage.local.get(configKeys);
      const enabled = data.autoSummaryEnabled !== false && data[keyAuto] !== false;
      if (!enabled) return;

      const currentTurns = messages.length;
      let graph = data[keyGraph];

      if (!graph || !graph.nodes || !graph.nodes.length) {
        // Initial full graph construction over history
        graph = await buildGraphWithProgress(messages, report, { dropKeywords: data[keyDrop] || [] });
      } else if (currentTurns > (graph.lastTurn || 0)) {
        // Run on EVERY SINGLE TURN (보폭 1턴), using the recent 4 messages as the sliding context window (맥락 파악)
        const windowContext = messages.slice(Math.max(0, currentTurns - 4), currentTurns);
        graph = CrackMatrixEngine.stepSlidingWindowGraph(graph, windowContext, currentTurns, currentTurns, { dropKeywords: data[keyDrop] || [] });
        report('새 대화 분석', currentTurns, currentTurns);
        if (graph && graph.nodes && graph.nodes.length > 50) {
          graph = CrackMatrixEngine.compactEvolutionGraph(graph, 40);
        }
      } else {
        return;
      }

      // Generate pristine formatted evolution summary and individual keyword cards
      const evolutionText = CrackMatrixEngine.queryEvolutionGraph(graph, '', 600);
      const fullMemoryDoc = CrackMatrixEngine.processAllWithSlidingWindow(messages).formattedText;
      report('기억 정리', messages.length, messages.length);
      const keywordCards = CrackMatrixEngine.generateKeywordEvolutionCards(graph);

      let existingList = data[keySummary] || [];
      const userCustomCards = existingList.filter(c => !c.isKeywordCard && c.id !== 'sum_evolving_graph');

      const primaryCard = {
        id: `sum_evolving_graph`,
        title: `기억 진화 연대기 (누적 ${currentTurns}턴)`,
        content: fullMemoryDoc || evolutionText,
        turnRange: `1~${currentTurns}`,
        enabled: true,
        isHypergraph: true,
        isEvolutionGraph: true,
        updatedAt: Date.now()
      };

      // Combine: Primary Chronicle + Distinct Individual Keyword Cards + User Custom Cards
      const mergedCards = [primaryCard, ...keywordCards.slice(0, 12), ...userCustomCards];

      await chrome.storage.local.set({
        [keyGraph]: graph,
        [keySummary]: mergedCards.slice(0, 15),
        [keyLastTurn]: currentTurns
      });

      // Broadcast notification to all active tabs
      chrome.tabs.query({ active: true }, tabs => {
        for (const t of tabs) {
          if (t.id) {
            chrome.tabs.sendMessage(t.id, {
              type: 'AUTO_SUMMARY_UPDATED',
              chatId,
              totalTurns: currentTurns,
              card: primaryCard,
              cards: mergedCards,
              graphNodeCount: graph.nodes.length
            }).catch(() => {});
          }
        }
      });
}

function extractSummaryDraft(messages) {
  const result = CrackMatrixEngine.processAllWithSlidingWindow(messages);
  return result?.formattedText || '';
}

// --- Communication Dispatcher ---
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'OPEN_NANO_PANEL') {
    if (!sender.tab?.id) { sendResponse({ success: false, error: '현재 크랙 탭을 찾지 못했습니다.' }); return; }
    chrome.sidePanel.open({ tabId: sender.tab.id })
      .then(async () => {
        if (msg.chatId) await chrome.storage.local.set({ nanoManualRequest: { chatId: String(msg.chatId), at: Date.now(), rebuild: Boolean(msg.rebuild) } });
        sendResponse({ success: true });
      })
      .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
  if (msg.type === 'START_NANO_MEMORY') {
    const chatId = String(msg.chatId || '');
    if (!chatId) { sendResponse({ success: false, error: '대화방 ID 필요' }); return; }
    (async () => {
      let mem = activeMemory.get(chatId);
      if (!mem) {
        await syncChat(chatId);
        mem = activeMemory.get(chatId);
      }
      if (!mem) throw Error('대화 기록을 불러오지 못했습니다.');
      startNanoMemory(chatId, mem.all, Boolean(msg.force), Boolean(msg.rebuild));
      sendResponse({ success: true });
    })().catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }
  if (msg.type === 'REFRESH_SITUATION') {
    const chatId = String(msg.chatId || '');
    if (!chatId) { sendResponse({ success: false, error: '채팅방이 필요합니다.' }); return; }
    (async () => {
      if (!activeMemory.has(chatId)) await syncChat(chatId);
      const situation = await updateSituation(chatId, true);
      sendResponse({ success: !!situation, situation });
    })().catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
  if (msg.type === 'GET_KEYWORD_REVIEW') {
    const chatId = String(msg.chatId || '');
    if (!chatId) { sendResponse({ success: false, error: '채팅방이 필요합니다.' }); return; }
    (async () => {
      const data = await chrome.storage.local.get([`graph:${chatId}`, `dropKw:${chatId}`]);
      const dropped = new Set((data[`dropKw:${chatId}`] || []).map(normalizedKeyword));
      const local = CrackMatrixEngine.generateKeywordEvolutionCards(data[`graph:${chatId}`]).map(card => card.keyword);
      const nano = (await loadNanoFacts(chatId)).map(fact => fact.keyword);
      const seen = new Set();
      const keywords = [...nano, ...local].filter(keyword => {
        const key = normalizedKeyword(keyword);
        if (!key || dropped.has(key) || seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 50);
      sendResponse({ success: true, keywords });
    })().catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
  if (msg.type === 'GET_NANO_FACTS') {
    const chatId = String(msg.chatId || '');
    if (!chatId) { sendResponse({ success: false, error: '채팅방이 필요합니다.' }); return; }
    loadNanoFacts(chatId).then(facts => sendResponse({ success: true, facts }))
      .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
  if (msg.type === 'UPDATE_NANO_FACT') {
    const chatId = String(msg.chatId || '');
    const factId = String(msg.factId || '');
    if (!chatId || !factId) { sendResponse({ success: false, error: '기억을 찾지 못했습니다.' }); return; }
    (async () => {
      const key = `nanoOverrides:${chatId}`;
      const data = await chrome.storage.local.get([`nanoMemory:${chatId}`, key]);
      if (!data[`nanoMemory:${chatId}`]?.facts?.some(fact => fact.id === factId)) throw Error('기억을 찾지 못했습니다.');
      const overrides = { ...(data[key] || {}) };
      const previous = { ...(overrides[factId] || {}) };
      if (msg.delete) {
        overrides[factId] = { ...previous, deleted: true };
      } else {
        const patch = msg.patch || {};
        if ('keyword' in patch) {
          const keyword = String(patch.keyword || '').trim();
          if (!keyword || keyword.length > 40) throw Error('키워드는 1~40자로 입력하세요.');
          previous.keyword = keyword;
        }
        if ('fact' in patch) {
          const fact = String(patch.fact || '').trim();
          if (!fact || fact.length > 300) throw Error('기억 내용은 1~300자로 입력하세요.');
          previous.fact = fact;
        }
        if ('domain' in patch) {
          if (!MEMORY_DOMAINS.has(patch.domain)) throw Error('기억 분류가 올바르지 않습니다.');
          previous.domain = patch.domain;
        }
        if ('enabled' in patch) previous.enabled = Boolean(patch.enabled);
        overrides[factId] = previous;
      }
      await chrome.storage.local.set({ [key]: overrides });
      nanoIndexes.delete(chatId);
      sendResponse({ success: true });
    })().catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
  if (msg.type === 'SYNC_CHAT') {
    syncChat(msg.chatId, progressReporter(sender, msg, 'sync'))
      .then(info => sendResponse({ success: true, info }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'GET_PREPARED_CONTEXT') {
    const { chatId, outgoing } = msg;
    (async () => {
    await refreshRecent(chatId).catch(() => null);
    const mem = activeMemory.get(chatId);

    const keys = [
      `usernote:${chatId}`, 'usernote:global',
      `lore:${chatId}`, 'lore:global',
      `summary:${chatId}`,
      `graph:${chatId}`,
      `currentState:${chatId}`,
      `auto:${chatId}`,
      `situation:${chatId}`,
      `nanoMemory:${chatId}`,
      `nanoOverrides:${chatId}`,
      `dropKw:${chatId}`,
      'llmIntervention'
    ];

    chrome.storage.local.get(keys, data => {
      const isAuto = data[`auto:${chatId}`] !== false;
      if (!isAuto) {
        sendResponse({ success: true, selected: [], content: outgoing, userNote: '', reason: '자동 주입이 꺼져 있습니다.' });
        return;
      }

      const userNote = data[`usernote:${chatId}`] || data['usernote:global'] || '';

      const roomLores = data[`lore:${chatId}`] || [];
      const globalLores = data['lore:global'] || [];
      const lores = [...globalLores, ...roomLores];
      const useNano = data.llmIntervention !== false;
      const summaries = useNano
        ? (data[`summary:${chatId}`] || []).filter(card => !card.isHypergraph && !card.isKeywordCard)
        : [...(data[`summary:${chatId}`] || [])];
      const budget = PROMPT_LIMIT;

      // 1. Current State (WISH RP Manager style: Location, Immediate Goal, Ongoing Conditions)
      const currState = data[`currentState:${chatId}`];
      if (currState?.enabled !== false && currState && (currState.location || currState.objective || currState.conditions)) {
        const parts = [];
        if (currState.location) parts.push(`위치: ${currState.location}`);
        if (currState.objective) parts.push(`목표: ${currState.objective}`);
        if (currState.conditions) parts.push(`상태: ${currState.conditions}`);
        summaries.unshift({
          id: 'sum_curr_state',
          title: '📌 현재 상태',
          content: parts.join(' | '),
          enabled: true
        });
      }

      // 1b. Latest scene memo (직전 상황) — always first, it is what the next reply continues from
      const situation = data[`situation:${chatId}`];
      const sitText = !useNano && situation?.turn === (mem?.all?.length || 0) && situation.text
        ? situation.text
        : (!useNano && mem ? CrackMatrixEngine.recentSituationExtract(mem.all, mem.ix, SITUATION_CHARS) : '');

      // Use the latest assistant reply with the user's draft to retrieve relevant context.
      const lastAssistant = (mem?.all || []).filter(m => m.role === 'assistant' || m.role === 'model').slice(-1)[0];
      const recentContext = lastAssistant?.text?.slice(0, 300) || '';
      const combinedQuery = recentContext ? `${outgoing} ${recentContext}` : outgoing;
      const nanoFacts = effectiveNanoFacts(data[`nanoMemory:${chatId}`]?.facts,
        data[`nanoOverrides:${chatId}`] || {}, data[`dropKw:${chatId}`] || []);
      if (useNano) summaries.unshift(...nanoMemoryCards(chatId, nanoFacts, outgoing, recentMemoryCutoff(mem?.all), recentContext));
      const graph = data[`graph:${chatId}`];
      if (!useNano && graph && graph.nodes && graph.nodes.length) {
        const dynamicEvolutionText = CrackMatrixEngine.queryEvolutionGraph(graph, combinedQuery, Math.min(480, Math.floor(budget * 0.32)));
        if (dynamicEvolutionText) {
          summaries.unshift({
            id: 'sum_dyn_evolution',
            title: '관련 기억의 진화 과정',
            content: dynamicEvolutionText,
            enabled: true
          });
        }
      }

      if (sitText) {
        summaries.unshift({ id: 'sum_recent_situation', title: '직전 상황', content: sitText, enabled: true });
      }

      const res = CrackMatrixEngine.contextWithAll(useNano ? null : mem?.ix, mem?.all || [], outgoing, {
        userNote,
        loreList: lores,
        summaryCards: summaries,
        budget,
        contextQuery: combinedQuery,
        injectUserNoteToPrompt: false // Keep user prompt clean; user note goes to native userNote
      });

      const content = CrackMatrixEngine.composeUser(outgoing, res.selected, budget);
      sendResponse({
        success: true,
        selected: res.selected,
        content,
        userNote: res.userNote || userNote,
        reason: res.selected.length ? '' : (useNano
          ? (nanoFacts.length ? 'Nano 기억에서 관련 항목을 찾지 못했습니다.' : 'Nano 기억 분석을 기다리는 중입니다. 기억 갱신을 눌러 모델 상태를 확인하세요.')
          : res.reason),
        mode: useNano ? 'nano' : 'local',
        res
      });

    });
    })().catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // --- Draft Summary for Preview & Confirm Modal ---
  if (msg.type === 'GENERATE_SUMMARY_DRAFT') {
    const { chatId } = msg;
    const report = progressReporter(sender, msg, 'summary');
    (async () => {
      let mem = activeMemory.get(chatId);
      if (!mem || !mem.all || mem.all.length === 0) {
        try {
          await syncChat(chatId);
          mem = activeMemory.get(chatId);
        } catch (e) {
          console.warn('[CrackMatrix] Sync failed in GENERATE_SUMMARY_DRAFT:', e);
        }
      }

      const totalTurns = mem?.all?.length || 0;
      if (totalTurns === 0) {
        sendResponse({ success: false, error: '대화방 기록이 비어있습니다. 대화를 나눈 후 다시 시도해주세요.' });
        return;
      }

      const { llmIntervention } = await chrome.storage.local.get('llmIntervention');
      if (llmIntervention !== false) {
        const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
        if (!panels.length) {
          sendResponse({ success: false, error: '기억 갱신을 눌러 Nano 모델을 준비하세요.' });
          return;
        }
        startNanoMemory(chatId, mem.all);
        sendResponse({ success: true, nanoStarted: true });
        return;
      }

      // Full re-analysis and rebuild of evolution graph from all turns
      let graph = await buildGraphWithProgress(mem.all, report);
      if (graph.nodes.length > 50) {
        graph = CrackMatrixEngine.compactEvolutionGraph(graph, 40);
      }
      await chrome.storage.local.set({ [`graph:${chatId}`]: graph });

      const draftText = extractSummaryDraft(mem.all);
      report('요약 초안 정리', mem.all.length, mem.all.length);
      const keyName = `summary:${chatId}`;
      chrome.storage.local.get([keyName], res => {
        const existing = res[keyName] || [];
        sendResponse({
          success: true,
          draftText,
          totalTurns,
          nodeCount: graph.nodes.length,
          existingSummary: existing[0] || null
        });
      });
    })().catch(error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // --- Save / Update Summary Card ---
  if (msg.type === 'SAVE_SUMMARY_CARD') {
    const { chatId, action, card } = msg;
    const keyName = `summary:${chatId}`;
    chrome.storage.local.get([keyName], res => {
      let list = res[keyName] || [];
      if (action === 'update' && list.length > 0) {
        list[0] = { ...list[0], ...card, updatedAt: Date.now() };
      } else {
        list.unshift({
          id: `sum_${Date.now()}`,
          title: card.title || `대화 요약 (${card.turnRange || '최근'}턴)`,
          content: card.content,
          enabled: true,
          createdAt: Date.now()
        });
      }
      chrome.storage.local.set({ [keyName]: list.slice(0, 10) }, () => {
        sendResponse({ success: true, list });
      });
    });
    return true;
  }

  // --- Rebuild Evolution Graph on demand (Sliding 4-msg window over full history) ---
  if (msg.type === 'REBUILD_EVOLUTION_GRAPH') {
    const { chatId } = msg;
    const report = progressReporter(sender, msg, 'rebuild');
    if (!chatId) {
      sendResponse({ success: false, error: '대화방 ID를 찾을 수 없습니다.' });
      return true;
    }

    (async () => {
      let mem = activeMemory.get(chatId);
      if (!mem || !mem.all.length) {
        try {
          await syncChat(chatId);
          mem = activeMemory.get(chatId);
        } catch (e) {
          console.warn('[CrackMatrix SW] syncChat in rebuild failed:', e);
        }
      }

      if (!mem || !mem.all.length) {
        const snapData = await chrome.storage.local.get([`snap:${chatId}`]);
        const snap = snapData[`snap:${chatId}`];
        if (snap && snap.messages && snap.messages.length) {
          const cleanAll = snap.messages;
          const units = CrackMatrixEngine.unitsFromMessages(cleanAll, chatId);
          const ix = CrackMatrixEngine.index(units);
          mem = { chatId, all: cleanAll, units, ix, loadedAt: Date.now() };
          activeMemory.set(chatId, mem);
        }
      }

      if (!mem || !mem.all.length) {
        sendResponse({ success: false, error: '대화 기록을 불러오지 못했습니다. 잠시 후 다시 시도해주세요.' });
        return;
      }

      const { llmIntervention } = await chrome.storage.local.get('llmIntervention');
      if (llmIntervention !== false) {
        const panels = await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] }).catch(() => []);
        if (!panels.length) {
          sendResponse({ success: false, error: '기억 갱신을 눌러 Nano 모델을 준비하세요.' });
          return;
        }
        startNanoMemory(chatId, mem.all);
        sendResponse({ success: true, nanoStarted: true });
        return;
      }

      const graph = await buildGraphWithProgress(mem.all, report);
      const fullMemoryDoc = CrackMatrixEngine.processAllWithSlidingWindow(mem.all).formattedText;
      report('기억 정리', mem.all.length, mem.all.length);
      const evolutionText = CrackMatrixEngine.queryEvolutionGraph(graph, '', 600);

    const keywordCards = CrackMatrixEngine.generateKeywordEvolutionCards(graph);

    const primaryCard = {
      id: 'sum_evolving_graph',
      title: `기억 진화 연대기 (누적 ${mem.all.length}턴)`,
      content: fullMemoryDoc || evolutionText,
      turnRange: `1~${mem.all.length}`,
      enabled: true,
      isHypergraph: true,
      isEvolutionGraph: true,
      updatedAt: Date.now()
    };

      const keyName = `summary:${chatId}`;
      const keyGraph = `graph:${chatId}`;
      chrome.storage.local.get([keyName], res => {
        let existingList = res[keyName] || [];
        const userCustomCards = existingList.filter(c => !c.isKeywordCard && c.id !== 'sum_evolving_graph');
        const mergedCards = [primaryCard, ...keywordCards.slice(0, 16), ...userCustomCards];

        chrome.storage.local.set({
          [keyGraph]: graph,
          [keyName]: mergedCards.slice(0, 20),
          [`summary:lastAutoTurn:${chatId}`]: mem.all.length
        }, () => {
          sendResponse({
            success: true,
            nodeCount: graph.nodes.length,
            edgeCount: graph.edges.length,
            card: primaryCard,
            keywordCardCount: keywordCards.length
          });
        });
      });
    })().catch(err => {
      sendResponse({ success: false, error: err.message });
    });
    return true;
  }

  // --- Switch Model on Crack Server ---
  // --- Exclude a keyword from this room's memory, now and in future windows ---
  if (msg.type === 'DROP_KEYWORD') {
    const { chatId, keyword } = msg;
    if (!chatId || !String(keyword || '').trim()) { sendResponse({ success: false, error: '키워드를 입력하세요.' }); return; }
    const keys = [`dropKw:${chatId}`, `graph:${chatId}`, `summary:${chatId}`];
    chrome.storage.local.get(keys, data => {
      const drop = Array.from(new Set([...(data[keys[0]] || []), String(keyword).trim()]));
      const graph = CrackMatrixEngine.dropKeywords(data[keys[1]], [keyword]);
      const cards = (data[keys[2]] || []).filter(c => c.keyword !== keyword && c.title !== keyword);
      chrome.storage.local.set({ [keys[0]]: drop, [keys[1]]: graph, [keys[2]]: cards },
        () => { nanoIndexes.delete(chatId); sendResponse({ success: true, dropped: drop }); });
    });
    return true;
  }

  if (msg.type === 'SWITCH_MODEL') {
    const { chatId, model, crackerModel } = msg;
    const url = `${API}/${encodeURIComponent(chatId)}`;
    crackFetch('PATCH', url, { model, crackerModel })
      .then(result => sendResponse({ success: true, result }))
      .catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  // --- Export Full Conversation (Fast API-based & Lossless) ---
  if (msg.type === 'EXPORT_CHAT_FULL') {
    const { chatId, opts = {} } = msg;
    syncChat(chatId).then(() => {
      const mem = activeMemory.get(chatId);
      if (!mem || !mem.all.length) {
        sendResponse({ success: false, error: '추출할 대화가 없습니다.' });
        return;
      }

      const userName = opts.userName || '유저';
      const aiName = opts.aiName || 'AI';
      const roleLabels = opts.roleLabels !== false;
      const includeInfo = opts.includeInfo !== false;
      const title = opts.title || '크랙 대화';

      const turns = [];
      for (const m of mem.all) {
        let text = m.text || '';
        if (!includeInfo) {
          text = text.replace(/```(?:INFO)?[^`]*```/g, '').replace(/\[(?:💼|🤝|📝)[^\]\n]*\][^\n]*/g, '').trim();
        }
        if (!text) continue;
        turns.push({
          role: m.role,
          name: m.role === 'user' ? userName : aiName,
          text
        });
      }

      const now = new Date();
      const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const header = `# ${title}\n# 추출 일시: ${stamp} · 총 ${turns.length}개 메시지\n`;

      const txtBody = turns.map(t => (roleLabels ? `[${t.name}]\n` : '') + t.text).join('\n\n────────────────\n\n');
      const mdBody = turns.map(t => (roleLabels ? `### ${t.name}\n` : '') + t.text).join('\n\n---\n\n');

      sendResponse({
        success: true,
        title,
        count: turns.length,
        txt: `${header}\n${txtBody}\n`,
        md: `${header}\n${mdBody}\n`,
        json: JSON.stringify(turns, null, 2)
      });
    }).catch(err => sendResponse({ success: false, error: err.message }));
    return true;
  }

  if (msg.type === 'REFRESH_SCORES') {
    updateModelScores().then(data => sendResponse({ success: true, scores: data.modelScores || {},
      updatedAt: data.modelScoresUpdatedAt || 0, error: data.modelScoresError || '' }))
      .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }

  if (msg.type === 'RECORD_SEND') {
    if (!sender.tab?.url?.startsWith('https://crack.wrtn.ai/')) {
      sendResponse({ success: false });
      return;
    }
    trackAnalytics(String(msg.chatId || ''), Math.max(0, Number(msg.injectedCount) || 0))
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }

  if (msg.type === 'GET_CHAT_STATS') {
    chatStats(String(msg.chatId || ''))
      .then(stats => sendResponse({ success: true, stats }))
      .catch(error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }

  // --- Automated Storage Garbage Collection & Hygiene Listeners ---
  if (msg.type === 'RUN_STORAGE_CLEANUP') {
    runStorageGarbageCollection().then(res => sendResponse(res));
    return true;
  }

  if (msg.type === 'GET_STORAGE_USAGE') {
    chrome.storage.local.getBytesInUse(null, bytes => {
      const kb = (bytes / 1024).toFixed(1);
      const mb = (bytes / (1024 * 1024)).toFixed(2);
      sendResponse({ success: true, bytes, kb: `${kb} KB`, mb: `${mb} MB` });
    });
    return true;
  }

  if (msg.type === 'RESET_CHAT_MEMORY') {
    const { chatId } = msg;
    if (!chatId) { sendResponse({ success: false, error: '대화방 ID 필요' }); return true; }
    const keysToRemove = [
      `graph:${chatId}`,
      `summary:${chatId}`,
      `nanoMemory:${chatId}`,
      `nanoOverrides:${chatId}`,
      `dropKw:${chatId}`,
      `currentState:${chatId}`,
      `lore:${chatId}`,
      `ooc:${chatId}`,
      `persona:${chatId}`,
      `usernote:${chatId}`,
      `budget:${chatId}`,
      `auto:${chatId}`,
      `summary:lastAutoTurn:${chatId}`
    ];
    activeMemory.delete(chatId);
    chrome.storage.local.remove(keysToRemove, () => {
      sendResponse({ success: true });
    });
    return true;
  }
});

// --- Automated Storage Garbage Collection & Hygiene Engine ---
async function runStorageGarbageCollection() {
  return new Promise(resolve => {
    chrome.storage.local.get(null, async allData => {
      const keys = Object.keys(allData);
      const keysToRemove = [];
      const keysToUpdate = {};
      const chatRoomUsage = new Map(); // chatId -> { lastActive, keys }

      for (const k of keys) {
        const match = k.match(/^(?:graph|summary|nanoMemory|nanoOverrides|dropKw|snap|currentState|lore|persona|usernote|ooc|budget|auto):([a-zA-Z0-9_-]+)$/);
        if (match) {
          const cId = match[1];
          if (!chatRoomUsage.has(cId)) {
            chatRoomUsage.set(cId, { lastActive: 0, keys: [] });
          }
          chatRoomUsage.get(cId).keys.push(k);

          const val = allData[k];
          if (k.startsWith('nanoMemory:') || k.startsWith('snap:')) {
            chatRoomUsage.get(cId).lastActive = Math.max(chatRoomUsage.get(cId).lastActive,
              Number(val?.updatedAt || val?.savedAt) || 0);
          }
          // 1. Remove corrupted / empty / orphan residues
          if (val === null || val === undefined) {
            keysToRemove.push(k);
            continue;
          }

          // 2. Compact oversized evolution graphs
          if (k.startsWith('graph:') && val && val.nodes) {
            const updated = val.updatedAt || Date.now();
            chatRoomUsage.get(cId).lastActive = Math.max(chatRoomUsage.get(cId).lastActive, updated);

            if (val.nodes.length > 50) {
              const compacted = CrackMatrixEngine.compactEvolutionGraph(val, 40);
              keysToUpdate[k] = compacted;
            }
          }
        }
      }

      if (Object.keys(keysToUpdate).length > 0) {
        await new Promise(r => chrome.storage.local.set(keysToUpdate, r));
      }
      if (keysToRemove.length > 0) {
        await new Promise(r => chrome.storage.local.remove(keysToRemove, r));
      }

      let bytesInUse = 0;
      try {
        bytesInUse = await new Promise(r => chrome.storage.local.getBytesInUse(null, r));
      } catch {}

      resolve({
        success: true,
        removedKeysCount: keysToRemove.length,
        compactedCount: Object.keys(keysToUpdate).length,
        prunedRoomsCount: 0,
        bytesInUse,
        kb: `${(bytesInUse / 1024).toFixed(1)} KB`
      });
    });
  });
}

chrome.alarms.create('storageGC', { periodInMinutes: 60 });
chrome.alarms.onAlarm.addListener(a => {
  if (a.name === 'storageGC') runStorageGarbageCollection();
});
runStorageGarbageCollection();

let analyticsWrite = Promise.resolve();
function trackAnalytics(chatId, injectedCount) {
  if (!chatId) return Promise.resolve();
  const write = analyticsWrite.then(async () => {
    const today = new Date().toISOString().slice(0, 10);
    const keys = [`analyticsV2:${today}`, `analyticsRoomV2:${chatId}:${today}`];
    const stored = await chrome.storage.local.get(keys);
    const updates = {};
    for (const key of keys) {
      const data = stored[key] || { sends: 0, injected: 0 };
      updates[key] = { sends: data.sends + 1, injected: data.injected + injectedCount };
    }
    await chrome.storage.local.set(updates);
  });
  analyticsWrite = write.catch(() => {});
  return write;
}

async function chatStats(chatId) {
  const today = new Date().toISOString().slice(0, 10);
  const keys = [`snap:${chatId}`, `nanoMemory:${chatId}`, `nanoOverrides:${chatId}`, `dropKw:${chatId}`, `graph:${chatId}`,
    `analyticsV2:${today}`, `analyticsRoomV2:${chatId}:${today}`, 'llmIntervention', 'nanoBatchSize'];
  const data = await chrome.storage.local.get(keys);
  const messages = data[`snap:${chatId}`]?.messages || activeMemory.get(chatId)?.all || [];
  const assistants = messages.filter(message => message.role === 'assistant');
  const nano = data[`nanoMemory:${chatId}`] || {};
  const last = assistants.findIndex(message => message.id === nano.lastId);
  const processed = last < 0 ? 0 : last + 1;
  return {
    chatId,
    mode: data.llmIntervention === false ? 'local' : 'nano',
    totalTurns: assistants.length,
    processedTurns: processed,
    pendingTurns: Math.max(0, assistants.length - processed),
    batchSize: Math.max(1, Math.min(10, Number(data.nanoBatchSize) || 4)),
    factCount: effectiveNanoFacts(nano.facts, data[`nanoOverrides:${chatId}`] || {}, data[`dropKw:${chatId}`] || []).length,
    graphNodes: data[`graph:${chatId}`]?.nodes?.length || 0,
    updatedAt: nano.updatedAt || 0,
    today: data[`analyticsV2:${today}`] || { sends: 0, injected: 0 },
    roomToday: data[`analyticsRoomV2:${chatId}:${today}`] || { sends: 0, injected: 0 }
  };
}
