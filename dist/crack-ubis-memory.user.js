// ==UserScript==
// @name         Crack UBIS Memory (prototype)
// @namespace    local.crack.ubis-memory
// @version      0.1.0
// @description  Deterministic local retrieval of old Crack messages. No AI API.
// @match        https://crack.wrtn.ai/stories/*/episodes/*
// @match        https://crack.wrtn.ai/characters/*/chats/*
// @match        https://crack.wrtn.ai/u/*/c/*
// @run-at       document-start
// @connect      crack-api.wrtn.ai
// @connect      contents-api.wrtn.ai
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==

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

(function () {
  'use strict';
  const E = CrackMemoryEngine;
  const API = 'https://crack-api.wrtn.ai/crack-gen/v3/chats';
  const CONTENTS = 'https://contents-api.wrtn.ai/character-chat/v3/chats';
  const active = new Map();
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  let busy = false;
  let lastReport = null;

  function chatId() {
    return (location.pathname.match(/\/(?:stories\/[^/]+\/episodes|characters\/[^/]+\/chats|u\/[^/]+\/c)\/([^/?#]+)/) || [])[1] || '';
  }
  function key(id, suffix) { return `crack-ubis-memory:${id}:${suffix}`; }
  function enabled(id) { return !!GM_getValue(key(id, 'auto'), false); }
  function messageId(m) { return String(m?._id || m?.id || ''); }
  function messageText(m) { return String(m?.content ?? m?.message ?? ''); }
  function role(m) { return String(m?.role || m?.senderRole || '').toLowerCase(); }
  function token() {
    const part = document.cookie.split(';').map(x => x.trim()).find(x => x.startsWith('access_token='));
    if (!part) throw Error('크랙 로그인 토큰을 읽지 못했습니다.');
    return decodeURIComponent(part.slice('access_token='.length));
  }
  function request(method, url, body) {
    return new Promise((resolve, reject) => GM_xmlhttpRequest({
      method, url, timeout: 12000,
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      data: body === undefined ? undefined : JSON.stringify(body),
      onload: r => {
        if (r.status < 200 || r.status >= 300) { reject(Error(`크랙 ${method}: HTTP ${r.status}`)); return; }
        try { resolve(r.responseText ? JSON.parse(r.responseText) : {}); }
        catch { reject(Error('크랙 응답 형식 오류')); }
      },
      onerror: () => reject(Error('크랙 연결 오류')),
      ontimeout: () => reject(Error('크랙 응답 시간 초과')),
    }));
  }
  function normal(raw) {
    const id = messageId(raw), text = raw?.content ?? raw?.message, r = role(raw);
    if (!id || typeof text !== 'string' || !['user', 'assistant', 'system'].includes(r)) throw Error('대화 메시지 형식이 달라 색인을 중지했습니다.');
    return { id, text, role: r, status: raw.status || '' };
  }
  async function history(id, full = false) {
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
      if (!Array.isArray(data?.messages)) throw Error('대화 페이지 형식이 달라 색인을 중지했습니다.');
      for (const raw of data.messages) {
        const m = normal(raw);
        if (seen.has(m.id)) throw Error('대화 페이지에 중복 메시지가 있습니다.');
        seen.add(m.id); all.push(m);
      }
      if (!full) break;
      if (data.messages.length && typeof data.hasNext !== 'boolean' && !Object.hasOwn(data, 'nextCursor')) {
        throw Error('대화 페이지 끝을 확인할 수 없습니다.');
      }
      cursor = data.nextCursor == null ? '' : String(data.nextCursor);
      if (!cursor && data.hasNext === true) throw Error('다음 대화 페이지를 찾지 못했습니다.');
      if (cursor && cursors.has(cursor)) throw Error('대화 페이지 cursor가 반복됩니다.');
      if (cursor) cursors.add(cursor);
      if (all.length > 2000) throw Error('프로토타입은 2,000개 메시지까지만 색인합니다.');
    } while (cursor);
    // Crack lists are newest first. Keep server order, not timestamps.
    return all.reverse();
  }
  async function getMessage(id, mid) {
    const result = await request('GET', `${API}/${encodeURIComponent(id)}/messages/${encodeURIComponent(mid)}`);
    return normal(result?.data || result);
  }
  async function patchVerified(id, mid, expected, replacement) {
    const before = await getMessage(id, mid);
    if (before.role !== 'assistant' || before.text !== expected) throw Error('주입 대상 원문이 바뀌어 중단했습니다.');
    for (const root of [CONTENTS, API]) {
      try {
        await request('PATCH', `${root}/${encodeURIComponent(id)}/messages/${encodeURIComponent(mid)}`, { message: replacement });
        const after = await getMessage(id, mid);
        if (after.text === replacement) return;
      } catch { /* Try the next known endpoint; readback decides success. */ }
    }
    throw Error('서버에서 주입 반영을 확인하지 못했습니다.');
  }
  function queryFor(messages, outgoing = '') {
    const recent = messages.slice(-4).map(m => E.stripOwnBlock(m.text)).join('\n');
    return `${recent.slice(-2500)}\n${outgoing}`.slice(-4000);
  }
  async function remember(id) {
    const head = await history(id);
    const marker = JSON.stringify(head.slice(-6).map(m => [m.id, E.stripOwnBlock(m.text)]));
    const cached = active.get(id);
    if (cached?.marker === marker && Date.now() - cached.loadedAt < 60000) return { ...cached, head };
    const all = await history(id, true);
    const units = E.unitsFromMessages(all, id);
    const value = { marker, all, units, ix: E.index(units), head, loadedAt: Date.now() };
    active.set(id, value);
    return value;
  }
  function reportStatus(value) {
    const node = document.getElementById('cum-status');
    if (node) node.textContent = value;
  }
  function renderReport(report) {
    lastReport = report;
    const node = document.getElementById('cum-results');
    if (!node) return;
    node.replaceChildren();
    const intro = document.createElement('p');
    intro.textContent = `${report.units}개 원문 구간 · 자동 기준 통과 ${report.selected.length}개${report.reason ? ` · ${report.reason}` : ''}`;
    node.append(intro);
    for (const hit of report.ranked.slice(0, 5)) {
      const item = document.createElement('article');
      const label = document.createElement('b');
      label.textContent = `${hit.role === 'user' ? '사용자' : 'AI'} · ${hit.messageId} · 점수 ${hit.score.toFixed(2)}${report.selected.some(x => x.id === hit.id) ? ' · 자동 후보' : ''}`;
      const reason = document.createElement('small');
      reason.textContent = `일치: ${hit.matched.join(', ')} / 강한 단서: ${hit.strong.join(', ') || '없음'}`;
      const body = document.createElement('p'); body.textContent = hit.text;
      item.append(label, reason, body); node.append(item);
    }
  }
  async function preview(outgoing = '') {
    const id = chatId(); if (!id) throw Error('크랙 채팅방에서만 사용할 수 있습니다.');
    const memory = await remember(id);
    const result = E.choose(memory.ix, queryFor(memory.all, outgoing), { maxOrder: Math.max(0, memory.all.length - 6) });
    renderReport({ ...result, units: memory.units.length });
    return { id, memory, result };
  }
  async function prepare(id, outgoing) {
    const { memory, result } = await preview(outgoing);
    let target;
    try { target = E.carrier(memory.head); }
    catch (error) {
      if (error.message !== '주입할 이전 AI 답변이 없습니다.') throw error;
      reportStatus('이전 AI 답변이 없어 이번 턴은 기억 없이 전송합니다.');
      return false;
    }
    const frontier = JSON.stringify(memory.head.slice(-3).map(m => [m.id, E.stripOwnBlock(m.text)]));
    const live = await getMessage(id, target.id);
    if (live.text.includes('RP_CONTEXT_MANAGER_START')) throw Error('위시 주입이 켜져 있어 자동 주입을 중단했습니다.');
    const next = E.compose(live.text, result.selected);
    if (next.length > 36000) throw Error('주입 대상 메시지가 너무 깁니다.');
    const previousId = GM_getValue(key(id, 'carrier'), '');
    const pendingCleanup = GM_getValue(key(id, 'cleanup'), '');
    if (pendingCleanup && pendingCleanup !== target.id) {
      const old = await getMessage(id, pendingCleanup);
      const clean = E.stripOwnBlock(old.text);
      if (clean !== old.text) await patchVerified(id, pendingCleanup, old.text, clean);
      GM_setValue(key(id, 'cleanup'), '');
    }
    if (next !== live.text) await patchVerified(id, target.id, live.text, next);
    if (result.selected.length) GM_setValue(key(id, 'carrier'), target.id);
    if (previousId && previousId !== target.id) {
      GM_setValue(key(id, 'cleanup'), previousId);
      const old = await getMessage(id, previousId);
      const clean = E.stripOwnBlock(old.text);
      if (clean !== old.text) await patchVerified(id, previousId, old.text, clean);
      GM_setValue(key(id, 'cleanup'), '');
    }
    GM_setValue(key(id, 'carrier'), result.selected.length ? target.id : '');
    const currentHead = await history(id);
    const currentFrontier = JSON.stringify(currentHead.slice(-3).map(m => [m.id, E.stripOwnBlock(m.text)]));
    if (currentFrontier !== frontier || E.carrier(currentHead).id !== target.id) {
      throw Error('전송 준비 중 대화가 바뀌었습니다.');
    }
    reportStatus(result.selected.length ? `${result.selected.length}개 과거 구간 적용 확인` : '이번 턴에 적용한 과거 구간 없음');
    return true;
  }
  async function clearCarrier(id) {
    const ids = [...new Set([GM_getValue(key(id, 'carrier'), ''), GM_getValue(key(id, 'cleanup'), '')].filter(Boolean))];
    for (const mid of ids) {
      const old = await getMessage(id, mid);
      const clean = E.stripOwnBlock(old.text);
      if (clean !== old.text) await patchVerified(id, mid, old.text, clean);
    }
    GM_setValue(key(id, 'carrier'), '');
    GM_setValue(key(id, 'cleanup'), '');
  }
  const nativeSend = page.WebSocket.prototype.send;
  page.WebSocket.prototype.send = function (raw) {
    const frame = E.parseFrame(raw), id = chatId();
    if (!frame || !id || String(frame.payload.chatId || '') !== id || !enabled(id)) return nativeSend.call(this, raw);
    if (busy) { reportStatus('이전 전송을 준비 중입니다.'); return; }
    busy = true;
    const socket = this;
    const outgoing = String(frame.payload.message ?? frame.payload.content ?? frame.payload.text ?? '');
    GM_setValue(key(id, 'unsent'), outgoing);
    void prepare(id, outgoing).then(() => {
      if (id !== chatId() || socket.readyState !== page.WebSocket.OPEN) throw Error('방 또는 연결이 바뀌었습니다.');
      nativeSend.call(socket, raw);
      GM_setValue(key(id, 'unsent'), '');
    }).catch(error => {
      reportStatus(`전송 보류: ${error.message} · 아래 복구 버튼으로 입력 복사 가능`);
      const panel = document.getElementById('cum-panel'); if (panel) panel.hidden = false;
    }).finally(() => { busy = false; });
  };

  function installUi() {
    if (document.getElementById('cum-open')) return;
    const style = document.createElement('style');
    style.textContent = '#cum-open{position:fixed;right:12px;bottom:12px;z-index:2147483644;padding:9px 12px;border-radius:8px;background:#243a5b;color:white;border:0}#cum-panel{position:fixed;right:12px;bottom:55px;z-index:2147483644;width:min(430px,calc(100vw - 24px));max-height:75vh;overflow:auto;background:#17202e;color:white;padding:13px;border:1px solid #70829b;border-radius:10px;font:13px/1.45 system-ui}#cum-panel[hidden]{display:none}#cum-panel button{margin:4px;padding:6px;color:white;background:#345273;border:1px solid #7189a0;border-radius:5px}#cum-panel article{border-top:1px solid #617187;padding:8px 0}#cum-panel article p{white-space:pre-wrap;overflow-wrap:anywhere}#cum-panel small{display:block;color:#bfd0df}';
    const open = document.createElement('button'); open.id = 'cum-open'; open.textContent = '기억 검색';
    const panel = document.createElement('aside'); panel.id = 'cum-panel'; panel.hidden = true;
    panel.innerHTML = '<b>Crack UBIS Memory · 프로토타입</b><p>외부 AI 없이 대화 원문을 검색합니다. 자동 적용은 이 방에서만 켜집니다.</p><label><input id="cum-auto" type="checkbox"> 다음 전송부터 자동 적용</label><p><button id="cum-preview">현재 장면 후보 보기</button><button id="cum-copy">보류된 입력 복사</button><button id="cum-close">닫기</button></p><output id="cum-status"></output><div id="cum-results"></div>';
    open.onclick = () => { panel.hidden = !panel.hidden; const id = chatId(); panel.querySelector('#cum-auto').checked = id ? enabled(id) : false; };
    panel.querySelector('#cum-close').onclick = () => { panel.hidden = true; };
    panel.querySelector('#cum-auto').onchange = async event => {
      const id = chatId(); if (!id) { event.target.checked = false; reportStatus('채팅방에서만 켤 수 있습니다.'); return; }
      event.target.disabled = true;
      try {
        if (!event.target.checked) await clearCarrier(id);
        GM_setValue(key(id, 'auto'), event.target.checked);
        reportStatus(event.target.checked ? '이 방의 자동 적용을 켰습니다.' : '이 방의 자동 적용과 이전 주입을 해제했습니다.');
      } catch (error) {
        event.target.checked = enabled(id);
        reportStatus(`설정 변경 실패: ${error.message}`);
      } finally { event.target.disabled = false; }
    };
    panel.querySelector('#cum-preview').onclick = () => { void preview().then(() => reportStatus('후보를 확인했습니다.')).catch(e => reportStatus(e.message)); };
    panel.querySelector('#cum-copy').onclick = async () => {
      const unsent = GM_getValue(key(chatId(), 'unsent'), '');
      if (!unsent) { reportStatus('보류된 입력이 없습니다.'); return; }
      await navigator.clipboard.writeText(unsent); reportStatus('보류된 입력을 복사했습니다.');
    };
    document.head.append(style); document.body.append(open, panel);
    if (lastReport) renderReport(lastReport);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUi, { once: true });
  else installUi();
})();
