(function () {
  'use strict';
  const E = CrackMemoryEngine;
  const API = 'https://crack-api.wrtn.ai/crack-gen/v3/chats';
  const CONTENTS = 'https://contents-api.wrtn.ai/character-chat/v3/chats';
  const active = new Map();
  const page = typeof unsafeWindow === 'undefined' ? window : unsafeWindow;
  let busy = false;
  let lastReport = null;
  let serverRoute = null;

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
    return serverRoute.storyId === storyId ? serverRoute.chatId : '';
  }
  function key(id, suffix) { return `crack-ubis-memory:${id}:${suffix}`; }
  function enabled(id) { return !!GM_getValue(key(id, 'input-auto'), false); }
  function savedSnapshot(id) {
    try {
      const data = JSON.parse(GM_getValue(key(id, 'snapshot-v1'), '') || 'null');
      return data?.version === 1 && data.chatId === id && Array.isArray(data.messages) && data.messages.length <= 2000 ? data : null;
    } catch { return null; }
  }
  function updateMemoryLabel(id) {
    const node = document.getElementById('cum-memory');
    if (!node) return;
    const snapshot = id && savedSnapshot(id);
    node.textContent = snapshot ? `이 방에 대화 ${snapshot.messages.length}개 로컬 기록됨` : '이 방의 로컬 대화 기록 없음';
  }
  function appliedHistory(id) {
    try {
      const entries = JSON.parse(GM_getValue(key(id, 'applied-v1'), '[]'));
      return Array.isArray(entries) ? entries.filter(entry => entry && typeof entry === 'object' && Array.isArray(entry.sources)).slice(0, 20) : [];
    } catch { return []; }
  }
  function renderApplied(id) {
    const node = document.getElementById('cum-applied');
    if (!node) return;
    node.replaceChildren();
    const entries = id ? appliedHistory(id) : [];
    if (!entries.length) { node.textContent = '이 방의 적용 기록이 없습니다.'; return; }
    for (const entry of entries.slice(0, 5)) {
      const item = document.createElement('p');
      const when = Number.isFinite(entry.at) ? new Date(entry.at).toLocaleString() : '시간 미상';
      item.textContent = `${when} · ${entry.sources?.length || 0}개 조각 · ${entry.sources?.map(x => x.messageId).join(', ') || ''}`;
      node.append(item);
    }
  }
  function recordApplied(id, selected) {
    if (!selected.length) return;
    const entry = { at: Date.now(), sources: selected.map(x => ({ messageId: x.messageId, kind: x.kind })) };
    GM_setValue(key(id, 'applied-v1'), JSON.stringify([entry, ...appliedHistory(id)].slice(0, 20)));
    renderApplied(id);
  }
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
  async function remember(id) {
    const head = await history(id);
    const marker = JSON.stringify(head.slice(-6).map(m => [m.id, E.stripOwnBlock(m.text)]));
    const cached = active.get(id);
    if (cached?.marker === marker && Date.now() - cached.loadedAt < 60000) return { ...cached, head };
    const saved = savedSnapshot(id);
    const fromDisk = saved?.marker === marker && Date.now() - saved.savedAt < 600000;
    const all = fromDisk ? saved.messages : (await history(id, true)).map(m => ({ ...m, text: E.stripOwnBlock(m.text) }));
    const units = E.unitsFromMessages(all, id);
    let saveError = false;
    if (!fromDisk) {
      try { GM_setValue(key(id, 'snapshot-v1'), JSON.stringify({ version: 1, chatId: id, marker, savedAt: Date.now(), messages: all })); }
      catch { saveError = true; }
    }
    const value = { marker, all, units, ix: E.index(units), head, loadedAt: Date.now(), saveError };
    active.set(id, value);
    updateMemoryLabel(id);
    return value;
  }
  function reportStatus(value) {
    const node = document.getElementById('cum-status');
    if (node) node.textContent = value;
  }
  function updateDraftLength() {
    const draft = document.getElementById('cum-draft');
    const length = document.getElementById('cum-length');
    if (draft && length) length.textContent = draft.value.length > 2000
      ? `${draft.value.length}자 · 입력이 2,000자를 넘어 기억은 추가되지 않습니다`
      : `${draft.value.length}자 입력 · 기억 캐시 포함 최대 2,000자`;
  }
  function refreshUnsent() {
    const copy = document.getElementById('cum-copy');
    if (copy) copy.disabled = !GM_getValue(key(chatId(), 'unsent'), '');
  }
  function renderReport(report) {
    lastReport = report;
    const node = document.getElementById('cum-results');
    if (!node) return;
    node.replaceChildren();
    const intro = document.createElement('p');
    const composed = E.composeUser(report.prompt, report.selected);
    intro.textContent = `검색 대상 ${report.units}개 · 추가할 기억 ${report.selected.length}개 · 전송 문장 ${composed.length}/2,000자${report.reason ? ` · ${report.reason}` : ''}${report.saveError ? ' · 로컬 기록 저장 실패' : ''}`;
    node.append(intro);
    if (report.selected.length) {
      const prepared = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = '전송될 문맥과 원래 입력 보기';
      const text = document.createElement('pre'); text.textContent = composed;
      prepared.append(summary, text); node.append(prepared);
    }
    const byId = new Map((report.messages || []).map(message => [String(message.id), message]));
    for (const hit of E.groupByMessage(report.ranked).slice(0, 5)) {
      const item = document.createElement('article');
      const label = document.createElement('b');
      label.textContent = `${hit.role === 'user' ? '사용자' : 'AI'}의 과거 메시지 · ${hit.messageId}${report.selected.some(x => x.messageId === hit.messageId) ? ' · 입력 예정' : ''}`;
      const reason = document.createElement('small');
      reason.textContent = `일치 단어: ${hit.matched.join(', ')} / 드문 단어: ${hit.strong.join(', ') || '없음'}`;
      const body = document.createElement('p'); body.textContent = hit.text;
      const full = E.searchText(byId.get(String(hit.messageId))?.text || '');
      const details = document.createElement('details');
      const summary = document.createElement('summary'); summary.textContent = '이 메시지 전체 보기';
      const fullBody = document.createElement('p'); fullBody.textContent = full;
      details.append(summary, fullBody);
      item.append(label, reason, body, details); node.append(item);
    }
  }
  async function preview(outgoing = '') {
    const id = chatId(); if (!id) throw Error('크랙 채팅방에서만 사용할 수 있습니다.');
    const draft = document.getElementById('cum-draft');
    if (outgoing && draft && draft.value !== outgoing) { draft.value = outgoing; updateDraftLength(); }
    const memory = await remember(id);
    if (id !== chatId()) throw Error('검색 중 채팅방이 바뀌었습니다.');
    const prompt = E.stripOwnBlock(outgoing || memory.all.filter(m => m.role === 'user').at(-1)?.text || '');
    const result = E.contextFor(memory.ix, memory.all, E.contextQuery(memory.ix, memory.all, outgoing || prompt), {
      maxOrder: Math.max(0, memory.all.length - 20),
      budget: E.userContextBudget(prompt),
    });
    renderReport({ ...result, units: memory.units.length, messages: memory.all, prompt, saveError: memory.saveError });
    return { id, memory, result };
  }
  async function prepareOutgoing(id, outgoing, raw) {
    if (GM_getValue(key(id, 'carrier'), '') || GM_getValue(key(id, 'cleanup'), '')) await clearCarrier(id);
    const { result } = await preview(outgoing);
    const content = E.composeUser(outgoing, result.selected);
    if (content === outgoing) {
      reportStatus('이번 입력에는 과거 대화 후보를 넣지 않았습니다.');
      return { frame: raw, selected: [] };
    }
    const rewritten = E.replaceFrameMessage(raw, content);
    if (!rewritten) throw Error('전송 형식이 달라 입력을 안전하게 수정할 수 없습니다.');
    reportStatus(`${result.selected.length}개 기억 조각을 입력 앞에 추가했습니다.`);
    return { frame: rewritten, selected: result.selected };
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
    if (!frame || frame.kind !== 'send' || !id || String(frame.payload.chatId || '') !== id || !enabled(id)) return nativeSend.call(this, raw);
    if (busy) { reportStatus('이전 전송을 준비 중입니다.'); return; }
    busy = true;
    const socket = this;
    const outgoing = String(frame.payload.message ?? frame.payload.content ?? frame.payload.text ?? '');
    GM_setValue(key(id, 'unsent'), outgoing);
    refreshUnsent();
    void prepareOutgoing(id, outgoing, raw).then(prepared => {
      if (id !== chatId() || socket.readyState !== page.WebSocket.OPEN) throw Error('방 또는 연결이 바뀌었습니다.');
      nativeSend.call(socket, prepared.frame);
      try {
        GM_setValue(key(id, 'unsent'), '');
        refreshUnsent();
        recordApplied(id, prepared.selected);
      } catch { reportStatus('전송했지만 로컬 기록이나 보류 상태를 갱신하지 못했습니다.'); }
    }).catch(error => {
      reportStatus(`전송 보류: ${error.message} · 아래 복구 버튼으로 입력 복사 가능`);
      const panel = document.getElementById('cum-panel'); if (panel) panel.hidden = false;
      refreshUnsent();
    }).finally(() => { busy = false; });
  };

  function installUi() {
    if (document.getElementById('cum-open')) return;
    const style = document.createElement('style');
    style.textContent = `
      #cum-open{position:fixed;right:16px;bottom:16px;z-index:2147483644;border:0;border-radius:999px;padding:11px 17px;background:#294c85;color:#fff;font:600 14px system-ui;box-shadow:0 4px 18px #0005;cursor:pointer}
      #cum-slot{display:flex;justify-content:flex-end;align-items:center;width:100%;min-height:30px}
      #cum-slot #cum-open{position:static;box-shadow:none;padding:6px 11px;font-size:12px}
      #cum-open[hidden]{display:none}
      #cum-panel{position:fixed;right:16px;bottom:68px;z-index:2147483644;box-sizing:border-box;width:min(480px,calc(100vw - 32px));max-height:min(78vh,740px);overflow:auto;background:#172132;color:#f5f7fa;padding:18px;border:1px solid #61738f;border-radius:14px;box-shadow:0 12px 32px #0008;font:14px/1.5 system-ui}
      #cum-panel[hidden]{display:none}
      #cum-panel .cum-header{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
      #cum-panel h2{font:700 18px/1.3 system-ui;margin:0}
      #cum-panel .cum-muted,#cum-panel small{display:block;color:#bdcadb;font-size:12px}
      #cum-panel .cum-muted{margin:4px 0 12px}
      #cum-panel .cum-switch{display:flex;align-items:flex-start;gap:9px;padding:11px;background:#25354e;border-radius:9px;margin:12px 0}
      #cum-panel .cum-switch input{margin-top:4px;accent-color:#7fb0ff}
      #cum-panel label[for=cum-draft]{display:block;font-weight:600;margin:12px 0 5px}
      #cum-panel textarea{box-sizing:border-box;width:100%;min-height:92px;resize:vertical;border:1px solid #7588a3;border-radius:8px;background:#111a29;color:#fff;padding:10px;font:13px/1.5 system-ui}
      #cum-panel .cum-actions{display:flex;flex-wrap:wrap;gap:7px;margin:12px 0}
      #cum-panel button{border:1px solid #8195b2;border-radius:7px;background:#345782;color:#fff;padding:7px 10px;cursor:pointer;font:600 12px system-ui}
      #cum-panel button:disabled{opacity:.45;cursor:default}
      #cum-panel #cum-preview{background:#326cae}
      #cum-panel #cum-close{background:transparent;border:0;font-size:20px;line-height:1;padding:0 2px}
      #cum-panel output{display:block;min-height:21px;color:#d6e8ff;margin:8px 0}
      #cum-panel #cum-results{border-top:1px solid #52627b;margin-top:10px;padding-top:6px}
      #cum-panel article{border-top:1px solid #52627b;padding:10px 0}
      #cum-panel article p,#cum-panel pre{white-space:pre-wrap;overflow-wrap:anywhere}
      #cum-panel pre{font:12px/1.45 monospace;max-height:280px;overflow:auto;background:#0d1522;padding:10px;border-radius:7px}
      #cum-panel summary{cursor:pointer;color:#d6e8ff}
    `;
    const open = document.createElement('button'); open.id = 'cum-open'; open.type = 'button'; open.textContent = '기억 캐시'; open.setAttribute('aria-controls', 'cum-panel');
    const panel = document.createElement('aside'); panel.id = 'cum-panel'; panel.hidden = true;
    panel.innerHTML = `
      <div class="cum-header"><div><h2>기억 캐시</h2><small id="cum-room">채팅방 확인 중</small></div><button id="cum-close" type="button" aria-label="닫기">×</button></div>
      <p class="cum-muted">과거 대화에서 찾은 원문을 다음 입력 앞에 붙입니다. 추가된 문장은 크랙 대화에도 저장됩니다.</p>
      <small id="cum-memory">이 방의 로컬 대화 기록 없음</small>
      <label class="cum-switch"><input id="cum-auto" type="checkbox"><span><b>이 방에서 자동 적용</b><small>켜면 다음 전송부터 적용 · 재생성에는 적용 안 함</small></span></label>
      <label for="cum-draft">보낼 문장 미리보기</label>
      <textarea id="cum-draft" placeholder="보낼 문장을 여기에 붙여넣고 기억 검색을 확인하세요. 실제 크랙 입력창으로 전송되지는 않습니다."></textarea>
      <small id="cum-length">0자 입력 · 기억 캐시 포함 최대 2,000자</small>
      <div class="cum-actions"><button id="cum-preview" type="button">이 문장으로 기억 찾기</button><button id="cum-copy" type="button" disabled>보류된 입력 복사</button></div>
      <output id="cum-status" role="status"></output>
      <details><summary>이 방의 최근 적용 시도</summary><div id="cum-applied"></div></details>
      <div id="cum-results"></div>
    `;
    open.onclick = () => {
      panel.hidden = !panel.hidden;
      mountControl();
      const id = chatId();
      panel.querySelector('#cum-auto').checked = id ? enabled(id) : false;
      updateMemoryLabel(id);
      renderApplied(id);
      refreshUnsent();
    };
    panel.querySelector('#cum-close').onclick = () => { panel.hidden = true; };
    panel.querySelector('#cum-auto').onchange = async event => {
      const id = chatId(); if (!id) { event.target.checked = false; reportStatus('채팅방에서만 켤 수 있습니다.'); return; }
      event.target.disabled = true;
      try {
        if (!event.target.checked) await clearCarrier(id);
        GM_setValue(key(id, 'input-auto'), event.target.checked);
        reportStatus(event.target.checked ? '이 방의 자동 적용을 켰습니다.' : '이 방의 자동 적용과 이전 주입을 해제했습니다.');
      } catch (error) {
        event.target.checked = enabled(id);
        reportStatus(`설정 변경 실패: ${error.message}`);
      } finally { event.target.disabled = false; }
    };
    panel.querySelector('#cum-draft').oninput = updateDraftLength;
    panel.querySelector('#cum-preview').onclick = () => {
      const draft = panel.querySelector('#cum-draft').value;
      if (!draft.trim()) { reportStatus('미리 볼 문장을 입력해 주세요.'); return; }
      reportStatus('과거 대화를 검색 중입니다…');
      void preview(draft).then(() => reportStatus('이 문장에 적용될 기억을 표시했습니다.')).catch(e => reportStatus(e.message));
    };
    panel.querySelector('#cum-copy').onclick = async () => {
      const unsent = GM_getValue(key(chatId(), 'unsent'), '');
      if (!unsent) { reportStatus('보류된 입력이 없습니다.'); return; }
      await navigator.clipboard.writeText(unsent); reportStatus('보류된 입력을 복사했습니다.');
    };
    document.head.append(style); document.body.append(open, panel);
    let mountedRoom = null;
    function mountControl() {
      const editor = document.querySelector('div.__chat_input_textarea[contenteditable="true"]');
      const inputBox = editor?.parentElement?.parentElement;
      const composer = inputBox?.parentElement;
      let slot = document.getElementById('cum-slot');
      if (editor && composer && inputBox && composer.contains(editor)) {
        if (!slot) { slot = document.createElement('div'); slot.id = 'cum-slot'; }
        if (slot.parentElement !== composer || slot.nextElementSibling !== inputBox) composer.insertBefore(slot, inputBox);
        if (open.parentElement !== slot) slot.append(open);
        open.hidden = false;
      } else {
        if (open.parentElement !== document.body) document.body.append(open);
        if (slot) slot.remove();
        open.hidden = !chatId();
        if (open.hidden) panel.hidden = true;
      }
      const id = chatId();
      const roomLabel = id
        ? (editor ? '설정은 현재 채팅방에만 적용됩니다' : '입력창을 찾지 못해 떠 있는 버튼으로 표시합니다')
        : '채팅방을 열면 사용할 수 있습니다';
      if (panel.querySelector('#cum-room').textContent !== roomLabel) panel.querySelector('#cum-room').textContent = roomLabel;
      if (id !== mountedRoom) {
        mountedRoom = id;
        panel.querySelector('#cum-auto').checked = id ? enabled(id) : false;
        updateMemoryLabel(id);
        renderApplied(id);
        panel.querySelector('#cum-draft').value = '';
        panel.querySelector('#cum-results').replaceChildren();
        updateDraftLength();
        refreshUnsent();
      }
    }
    mountControl();
    let scheduled = false;
    new MutationObserver(() => {
      if (scheduled) return;
      scheduled = true;
      requestAnimationFrame(() => { scheduled = false; mountControl(); });
    }).observe(document.body, { childList: true, subtree: true });
    if (lastReport) renderReport(lastReport);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', installUi, { once: true });
  else installUi();
})();
