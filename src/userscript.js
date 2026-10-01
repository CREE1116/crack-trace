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
