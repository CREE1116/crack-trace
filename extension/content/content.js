// LoreCache - Comprehensive Client Controller (Manifest V3)
(() => {
  'use strict';

  let currentChatId = '';
  let attachedEditor = null;
  let stagedPrompt = '';
  let typingTimer = null;
  const analysisTasks = new Map();
  let analysisHideTimer = null;
  let nanoError = '';
  let nanoModeEnabled = true;
  let deckRenderSerial = 0;
  const imageMemoryCache = new Set();

  function updateAnalysisProgress() {
    const bar = document.getElementById('cm-analysis-progress');
    if (!bar) return;
    clearTimeout(analysisHideTimer);
    if (analysisTasks.size) {
      const task = [...analysisTasks.values()].at(-1);
      const ratio = task.total > 0 ? Math.min(1, task.done / task.total) : 0;
      bar.classList.remove('complete');
      bar.hidden = false;
      bar.style.setProperty('--cm-progress', String(ratio));
      bar.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
      bar.title = task.total > 0 ? `${task.stage}: ${task.done}/${task.total}턴` : `${task.stage}…`;
    } else if (!bar.hidden) {
      bar.classList.add('complete');
      bar.style.setProperty('--cm-progress', '1');
      bar.setAttribute('aria-valuenow', '100');
      analysisHideTimer = setTimeout(() => {
        if (!analysisTasks.size) bar.hidden = true;
      }, 350);
    }
  }

  function startAnalysis(key, stage = '대화 기록 불러오는 중') {
    const progressId = crypto.randomUUID();
    analysisTasks.set(key, { id: progressId, stage, done: 0, total: 0 });
    updateAnalysisProgress();
    return progressId;
  }

  function finishAnalysis(key, completed = true) {
    analysisTasks.delete(key);
    if (!completed) {
      const bar = document.getElementById('cm-analysis-progress');
      if (bar) bar.hidden = true;
    } else updateAnalysisProgress();
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'GET_EDITOR_DRAFT') {
      sendResponse({ chatId: chatId(), draft: attachedEditor?.innerText?.trim() || '' });
      return;
    }
    if (!['ANALYSIS_PROGRESS', 'ANALYSIS_DONE'].includes(msg?.type) || msg.chatId !== chatId()) return;
    if (msg.type === 'ANALYSIS_DONE') {
      if (analysisTasks.get(msg.key)?.id === msg.progressId) finishAnalysis(msg.key, !msg.pending && !msg.error);
      if (msg.key === 'nano') {
        nanoError = String(msg.error || '');
        const label = document.getElementById('cm-dock-sum-text');
        if (label) label.textContent = nanoError ? '모델 준비 필요' : msg.pending ? `기억 ${msg.done}/${msg.total} · 대기` : '기억 갱신';
      }
      refreshDockLabels();
      handleTyping(attachedEditor?.innerText || '');
      return;
    }
    if (msg.key === 'nano' && analysisTasks.get('nano')?.id !== msg.progressId) {
      nanoError = '';
      analysisTasks.set('nano', { id: msg.progressId, stage: msg.stage, done: 0, total: msg.total });
    }
    const task = analysisTasks.get(msg.key);
    if (!task || task.id !== msg.progressId) return;
    analysisTasks.set(msg.key, {
      ...task,
      stage: String(msg.stage || task.stage),
      done: Math.max(0, Number(msg.done) || 0),
      total: Math.max(0, Number(msg.total) || 0)
    });
    if (msg.key === 'nano') {
      const label = document.getElementById('cm-dock-sum-text');
      if (label) label.textContent = `기억 ${msg.done}/${msg.total}`;
      refreshDockLabels();
    }
    updateAnalysisProgress();
  });

  function chatId() {
    const pathId = (location.pathname.match(/\/(?:stories\/[^/]+\/episodes|characters\/[^/]+\/chats|u\/[^/]+\/c)\/([^/?#]+)/) || [])[1];
    if (pathId) return pathId;
    return '';
  }

  // --- 1. Client View & Performance Tuning Engine ---
  function applyClientViewSettings() {
    chrome.storage.local.get(['clientViewSettings'], res => {
      const s = res.clientViewSettings || {
        width: 'wide',
        customWidth: 980,
        font: 'maruburi',
        fontSize: '15',
        lineHeight: '1.65',
        perfOpt: true,
        imagePreload: true
      };

      if (s.customWidth) {
        document.body.dataset.cmCustomWidth = 'true';
        document.body.style.setProperty('--cm-chat-width', `${s.customWidth}px`);
      } else {
        document.body.removeAttribute('data-cm-custom-width');
        document.body.dataset.cmWidth = s.width || 'wide';
      }

      document.body.dataset.cmFont = s.font || 'maruburi';
      document.body.dataset.cmPerf = s.perfOpt ? 'true' : 'false';
      document.body.style.setProperty('--cm-font-size', `${s.fontSize || 15}px`);
      document.body.style.setProperty('--cm-line-height', s.lineHeight || '1.65');

      if (s.imagePreload) preloadImages();
    });
  }

  function preloadImages() {
    const imgs = document.querySelectorAll('img[src*="cloudfront.net"], img[src*="wrtn.ai"]');
    for (const img of imgs) {
      const src = img.src;
      if (src && !imageMemoryCache.has(src)) {
        imageMemoryCache.add(src);
        const pre = new Image();
        pre.src = src;
      }
    }
  }

  // --- 2. Composer UI Integration ---
  function mountComposerUI() {
    // 1. Clean up legacy buttons if any
    document.getElementById('cm-native-btn')?.remove();
    document.getElementById('cm-top-pill-bar')?.remove();

    // 2. Single Header Settings Button in Crack's top nav bar
    const headerRow = document.querySelector('header .flex.items-center.gap-2, header .flex.items-center.space-x-2, header .flex.items-center') ||
      document.querySelector('button[aria-haspopup="dialog"]')?.parentElement;
    if (headerRow && !document.getElementById('cm-header-btn')) {
      const hBtn = document.createElement('button');
      hBtn.id = 'cm-header-btn';
      hBtn.type = 'button';
      hBtn.className = 'cm-header-btn';
      hBtn.title = 'Crack 확장 설정';
      hBtn.innerHTML = `⚙️`;
      hBtn.onclick = (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMasterModal('settings');
      };
      headerRow.appendChild(hBtn);
    }

    // 3. Integrated Composer Ribbon (Dock) above input area
    const editor = document.querySelector('div.__chat_input_textarea[contenteditable="true"]');
    if (!editor) return;

    const card = editor.closest('.rounded-lg') || editor.parentElement?.parentElement;
    if (!card) return;

    if (!document.getElementById('cm-composer-dock')) {
      const dock = document.createElement('div');
      dock.id = 'cm-composer-dock';
      dock.className = 'cm-composer-dock';
      dock.innerHTML = `
        <div class="cm-dock-chips">
          <button type="button" class="cm-dock-chip" id="cm-dock-state" title="현재 씬 상태 (위치·목표·지속상태)">
            <span>📌</span><span id="cm-dock-state-text">현재상태</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-memory" title="장기기억 진화 덱">
            <span>🌿</span><span id="cm-dock-memory-count">기억덱</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-usernote" title="유저노트 서술 지침 (순정 분리 전송)">
            <span>📝</span><span id="cm-dock-usernote-name">유저노트</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-lore" title="로어북 키워드·설정 관리">
            <span>📜</span><span id="cm-dock-lore-name">로어북</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-notes" title="현재 대화방 메모장">
            <span>📋</span><span>메모</span>
          </button>
        </div>
        <div class="cm-dock-actions">
          <button type="button" class="cm-dock-action-btn secondary" id="cm-dock-btn-preview" aria-expanded="false" aria-controls="cm-composer-preview" title="현재 입력과 직전 AI 응답을 반영한 전송 프롬프트 보기">👁️ 프롬프트</button>
          <button type="button" class="cm-dock-action-btn" id="cm-dock-btn-summarize" title="최근 대화 분석 및 기억 진화 요약">
            <span>📡</span><span id="cm-dock-sum-icon">✨</span><span id="cm-dock-sum-text">기억 갱신</span>
          </button>
        </div>
      `;
      card.insertBefore(dock, card.firstChild);
      const progress = document.createElement('div');
      progress.id = 'cm-analysis-progress';
      progress.className = 'cm-analysis-progress';
      progress.hidden = true;
      progress.setAttribute('role', 'progressbar');
      progress.setAttribute('aria-label', '대화 분석 진행 중');
      progress.setAttribute('aria-valuemin', '0');
      progress.setAttribute('aria-valuemax', '100');
      progress.innerHTML = '<span class="cm-analysis-progress-fill"></span>';
      dock.insertAdjacentElement('afterend', progress);
      const preview = document.createElement('div');
      preview.id = 'cm-composer-preview';
      preview.className = 'cm-composer-preview';
      preview.hidden = true;
      preview.innerHTML = '<div class="cm-composer-preview-header"><strong>전송 프롬프트 미리보기</strong><span>현재 입력 · 직전 AI 응답 기준</span></div><textarea id="cm-composer-preview-text" readonly aria-label="실제 전송 프롬프트"></textarea><div id="cm-composer-preview-status" role="status"></div><div class="cm-composer-preview-footer"><span>유저노트는 별도로 전송됩니다.</span><button type="button" id="cm-composer-preview-copy">복사</button></div>';
      progress.insertAdjacentElement('afterend', preview);
      updateAnalysisProgress();

      dock.querySelector('#cm-dock-state').onclick = () => openMasterModal('state');
      dock.querySelector('#cm-dock-memory').onclick = () => openMasterModal('deck');
      dock.querySelector('#cm-dock-usernote').onclick = () => openMasterModal('usernote');
      dock.querySelector('#cm-dock-lore').onclick = () => openMasterModal('lore');
      dock.querySelector('#cm-dock-notes').onclick = () => openMasterModal('notes');
      dock.querySelector('#cm-dock-btn-preview').onclick = () => {
        preview.hidden = !preview.hidden;
        dock.querySelector('#cm-dock-btn-preview').setAttribute('aria-expanded', String(!preview.hidden));
        if (!preview.hidden) handleTyping(attachedEditor?.innerText || '');
      };
      dock.querySelector('#cm-dock-btn-summarize').onclick = triggerSummarization;
      preview.querySelector('#cm-composer-preview-copy').onclick = () => {
        navigator.clipboard.writeText(preview.querySelector('textarea').value);
      };

      refreshDockLabels();
    }

    // Editor Typing Listeners
    if (editor !== attachedEditor) {
      attachedEditor = editor;
      const handler = () => {
        clearTimeout(typingTimer);
        typingTimer = setTimeout(() => {
          handleTyping(editor.innerText || editor.textContent || '');
        }, 100);
      };
      editor.addEventListener('input', handler);
      editor.addEventListener('keyup', handler);
      editor.addEventListener('paste', handler);
    }
  }

  // --- Model monitoring badges in Crack's own model dialog ---
  // Scores come from IGX Radiosonde (real measurements of the underlying
  // models). An option gets a badge only when its visible name matches a
  // monitored model; nothing is guessed for Crack-only model names.
  let modelScores = {};
  let modelIndex = [];            // [{ key, id }] longest key first
  const STATUS_LABEL = {
    OPERATIONAL: '정상', DEGRADED: '저하', IMPACTED: '지연', CRITICAL: '장애', UNSTABLE: '불안정', INACTIVE: '중지'
  };

  const normName = t => String(t || '').toLowerCase().replace(/[^a-z0-9가-힣]/g, '');

  // Names a model may appear under. Crack's option descriptions name the
  // underlying model without the vendor ("Opus 5를 활용한…" for
  // claude-opus-5), so when the id's second part is a word (opus, sonnet,
  // fable) the vendor-less form is an alias too. A bare version ("2.5-pro")
  // is too generic to stand alone, so ids like gemini-2.5-pro get no alias.
  function aliasesFor(id) {
    // Release-stage tags name the same model ("gemini-3.1-pro-preview" is Gemini 3.1 Pro).
    const bases = [String(id), String(id).replace(/-(?:preview|latest)$/i, '')];
    const out = [];
    for (const base of new Set(bases)) {
      const parts = base.split('-');
      out.push(normName(base));
      if (parts.length >= 3 && /[a-z]/i.test(parts[1])) out.push(normName(parts.slice(1).join('-')));
    }
    return [...new Set(out.filter(Boolean))];
  }

  function setModelScores(scores) {
    modelScores = scores || {};
    modelIndex = Object.keys(modelScores)
      .flatMap(id => aliasesFor(id).map(key => ({ key, id })))
      .sort((a, b) => b.key.length - a.key.length || a.id.localeCompare(b.id));
  }

  // The monitored model named by `text`: its normalized id must appear, and
  // not be followed by another digit ("claude-opus-5" must not match "Opus 5.5").
  function modelForText(text) {
    const t = normName(text);
    if (!t) return null;
    for (const { key, id } of modelIndex) {
      let from = 0, at;
      while ((at = t.indexOf(key, from)) !== -1) {
        if (!/[0-9]/.test(t.charAt(at + key.length))) return modelScores[id];
        from = at + 1;
      }
    }
    return null;
  }

  function badgeFor(m) {
    const b = document.createElement('span');
    b.className = 'cm-rs-badge';
    fillBadge(b, m);
    return b;
  }

  function fillBadge(b, m) {
    const status = String(m.status || '').toUpperCase();
    const secs = Number.isFinite(m.latencyMs) ? (m.latencyMs / 1000).toFixed(1) + '초' : '';
    const text = `${Math.round(m.score)}점${secs ? ' · ' + secs : ''}`;
    // Write only on change: every DOM write wakes the MutationObserver again.
    if (b.dataset.status === status.toLowerCase() && b.textContent === text && b.title) return;
    b.dataset.status = status.toLowerCase();
    b.textContent = text;
    const when = m.measuredAt ? new Date(m.measuredAt.replace(' ', 'T').replace(/\+00$/, 'Z')) : null;
    b.title = [
      `${m.display} · ${STATUS_LABEL[status] || status}`,
      secs ? `첫 응답 ${secs}` : '',
      Number.isFinite(m.tps) ? `출력 ${m.tps.toFixed(1)} tok/s` : '',
      m.failureCount ? `실패 ${m.failureCount}회` : '',
      when && !isNaN(when) ? `측정 ${when.toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}` : '',
      '출처: IGX Radiosonde (rs.igx.kr)'
    ].filter(Boolean).join('\n');
  }

  // Badges are attached next to the text that names a monitored model,
  // wherever it sits: Crack's option rows may be divs, buttons or list items,
  // so the scan walks text nodes instead of assuming an element type.
  const MODEL_ROOTS = '[role="dialog"], [role="listbox"], [role="menu"], [data-radix-popper-content-wrapper], button[aria-haspopup="dialog"]';

  function textLeaves(root) {
    const out = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: n => {
        const el = n.parentElement;
        if (!el || !n.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        if (el.closest('.cm-rs-badge, [id^="cm-"], script, style')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    while (walker.nextNode()) out.push(walker.currentNode);
    return out;
  }

  // Crack names its options ("하이퍼챗 3.0") and says which model each uses in
  // the option's description ("Opus 5를 활용한…"). Pairs read from the dialog
  // are remembered, so the currently selected model (whose button shows only
  // the Crack name) can carry its score too.
  let crackModelMap = {};           // normalized Crack name -> monitored model id
  let mapSaveTimer = null;
  chrome.storage.local.get(['crackModelMap'], r => { crackModelMap = r.crackModelMap || {}; scheduleNativeBadges(); });

  function rememberCrackModel(title, id) {
    const key = normName(title);
    if (!key || crackModelMap[key] === id) return;
    crackModelMap[key] = id;
    clearTimeout(mapSaveTimer);
    mapSaveTimer = setTimeout(() => chrome.storage.local.set({ crackModelMap }), 300);
  }

  function modelForCrackName(text) {
    const t = normName(text);
    let best = null;
    for (const [key, id] of Object.entries(crackModelMap)) {
      if (t.includes(key) && modelScores[id] && (!best || key.length > best.key.length)) best = { key, id };
    }
    return best ? modelScores[best.id] : null;
  }

  // The selected model's button (outside any dialog): badge on its left, so
  // the buttons to its right do not shift when the badge appears or changes.
  function badgeSelectedModel(button) {
    const m = modelForCrackName(button.textContent);
    const prev = button.previousElementSibling;
    const existing = prev && prev.classList.contains('cm-rs-badge') && prev.dataset.for === 'selected' ? prev : null;
    if (!m) { existing?.remove(); return; }
    if (existing) { fillBadge(existing, m); return; }
    const b = badgeFor(m);
    b.dataset.for = 'selected';
    button.insertAdjacentElement('beforebegin', b);
  }

  function injectNativeModelBadges() {
    const roots = document.querySelectorAll(MODEL_ROOTS);
    for (const root of roots) {
      if (root.closest('[id^="cm-"], .cm-modal-overlay')) continue;
      if (root.matches('button')) {
        if (!root.closest('[role="dialog"]') && modelIndex.length) badgeSelectedModel(root);
        continue;
      }
      const leaves = textLeaves(root);
      reportDialog(root, leaves);
      if (!modelIndex.length) continue;
      for (const node of leaves) {
        const m = modelForText(node.nodeValue);
        if (!m) continue;
        // The badge goes next to the option's title: the first text of the
        // smallest element that holds this text and at least one other.
        let row = node.parentElement;
        while (row && row !== root && textLeaves(row).length < 2) row = row.parentElement;
        const titleNode = row ? textLeaves(row)[0] : node;
        const title = titleNode.parentElement;
        if (titleNode !== node) rememberCrackModel(titleNode.nodeValue, m.id);
        const existing = row?.querySelector('.cm-rs-badge');
        if (existing) fillBadge(existing, m);
        else title.insertAdjacentElement('afterend', badgeFor(m));
      }
    }
  }

  // Diagnostics: each time a dialog/menu opens, print its visible texts and
  // which of them matched a monitored model (once per dialog element).
  const reportedDialogs = new WeakSet();
  function reportDialog(root, leaves) {
    if (reportedDialogs.has(root)) return;
    const texts = [...new Set(leaves.map(n => n.nodeValue.trim().replace(/\s+/g, ' ').slice(0, 40)))];
    if (texts.length < 2) return;
    reportedDialogs.add(root);
    const matched = texts.filter(t => modelForText(t));
    console.info('[CrackMatrix] Radiosonde | 측정 모델', Object.keys(modelScores).length + '개',
      '| 이 창에서 매칭', matched.length ? matched : '없음', '| 창의 글자', texts.slice(0, 30));
  }

  let badgeTimer = null;
  function scheduleNativeBadges() {
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(injectNativeModelBadges, 120);
  }

  chrome.storage.local.get(['modelScores'], r => { setModelScores(r.modelScores); scheduleNativeBadges(); });
  chrome.storage.local.get('llmIntervention', r => { nanoModeEnabled = r.llmIntervention !== false; });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.modelScores) {
      setModelScores(changes.modelScores.newValue);
      scheduleNativeBadges();
    }
    if (area === 'local' && changes.llmIntervention) nanoModeEnabled = changes.llmIntervention.newValue !== false;
    if (area === 'local') {
      const id = chatId();
      const modal = document.getElementById('cm-master-modal');
      if (id && modal?.classList.contains('open') && modal.querySelector('#cm-master-tab-deck.active') &&
          (changes[`nanoMemory:${id}`] || changes[`nanoOverrides:${id}`] || changes[`dropKw:${id}`] || changes[`graph:${id}`])) {
        renderMemoryDeckTab(id, modal);
      }
      if (id && (changes[`nanoMemory:${id}`] || changes[`nanoOverrides:${id}`] || changes[`dropKw:${id}`])) {
        refreshDockLabels();
        handleTyping(attachedEditor?.innerText || '');
      }
    }
  });

  function refreshDockLabels() {
    const id = chatId();
    if (!id) return;

    chrome.storage.local.get([
      `currentState:${id}`,
      `usernote:${id}`,
      'usernote:global',
      `summary:${id}`,
      `lore:${id}`,
      `nanoMemory:${id}`,
      'llmIntervention'
    ], res => {
      if (chatId() !== id) return;
      const cs = res[`currentState:${id}`];
      const stateEl = document.getElementById('cm-dock-state-text');
      if (stateEl) stateEl.textContent = cs?.enabled !== false && cs?.location ? `상태: ${cs.location.slice(0, 6)}…` : '현재상태';


      const un = res[`usernote:${id}`] || res['usernote:global'];
      const unEl = document.getElementById('cm-dock-usernote-name');
      if (unEl) unEl.textContent = un ? '유저노트 On' : '유저노트';

      const sum = res[`summary:${id}`] || [];
      const sumEl = document.getElementById('cm-dock-memory-count');
      if (sumEl) {
        if (res.llmIntervention !== false) {
          chrome.runtime.sendMessage({ type: 'GET_NANO_FACTS', chatId: id }, reply => {
            if (chatId() !== id || !sumEl.isConnected) return;
            const count = reply?.facts?.length || 0;
            sumEl.textContent = count ? `기억 ${count}건` : (nanoError ? '기억 확인 필요' : '기억 대기');
          });
          sumEl.parentElement.title = nanoError || 'Gemini Nano가 기록한 장기 기억';
        } else {
          sumEl.textContent = sum.length ? `기억 ${sum.length}건` : '기억덱';
        }
      }

      const lores = res[`lore:${id}`] || [];
      const loreEl = document.getElementById('cm-dock-lore-name');
      if (loreEl) loreEl.textContent = lores.length ? `로어 ${lores.length}건` : '로어북';

      scheduleNativeBadges();
    });
  }

  function triggerSummarization() {
    const id = chatId();
    if (!id) { alert('대화방 ID를 찾을 수 없습니다.'); return; }

    const btn = document.getElementById('cm-dock-btn-summarize');
    const icon = document.getElementById('cm-dock-sum-icon');
    const text = document.getElementById('cm-dock-sum-text');
    if (!btn || btn.classList.contains('loading')) return;

    if (nanoModeEnabled) {
      btn.classList.add('loading');
      text.textContent = '모델 화면 열기…';
      chrome.runtime.sendMessage({ type: 'OPEN_NANO_PANEL', chatId: id }, result => {
        btn.classList.remove('loading');
        const nanoTask = analysisTasks.get('nano');
        text.textContent = result?.success
          ? (nanoTask ? `기억 ${nanoTask.done}/${nanoTask.total}` : '모델 준비 / 분석')
          : '기억 갱신';
        if (!result?.success) btn.title = result?.error || '모델 화면을 열지 못했습니다.';
      });
      return;
    }
    triggerLocalSummarization(id, btn, icon, text);
  }

  function triggerLocalSummarization(id, btn, icon, text) {
    btn.classList.add('loading');
    icon.innerHTML = '<span class="cm-spinner"></span>';
    text.textContent = '⏳ 분석 중…';
    const progressId = startAnalysis('summary', '기억 갱신');

    chrome.runtime.sendMessage({ type: 'GENERATE_SUMMARY_DRAFT', chatId: id, progressId }, res => {
      finishAnalysis('summary');
      btn.classList.remove('loading');
      icon.textContent = '🌿';
      text.textContent = '기억 갱신';

      if (!res || !res.success) {
        alert(res?.error || '기억 요약 분석 실패');
        return;
      }

      if (res.nanoStarted) return;

      openMasterModal('deck', { summaryDraft: res });
    });
  }

  // --- 3. Typing & Pre-Staging for 0ms WebSocket Injection ---
  function handleTyping(text) {
    const id = chatId();
    const cleanPrompt = text.trim();
    if (!id) return;

    stagedPrompt = cleanPrompt;
    const preview = document.getElementById('cm-composer-preview-text');
    const previewStatus = document.getElementById('cm-composer-preview-status');
    if (preview && !cleanPrompt) preview.value = '입력창에 메시지를 쓰면 전송할 프롬프트가 표시됩니다.';
    if (previewStatus && !cleanPrompt) previewStatus.textContent = '';
    if (!cleanPrompt) {
      chrome.runtime.sendMessage({ type: 'LIVE_PROMPT_PREVIEW', target: 'sidepanel', chatId: id,
        draft: '', items: [] }).catch(() => {});
      updateStatusUI({ userNoteCount: 0, memoryCount: 0, summaryCount: 0 });
    }

    if (cleanPrompt) {
      chrome.runtime.sendMessage({ type: 'GET_PREPARED_CONTEXT', chatId: id, outgoing: cleanPrompt }, res => {
        if (stagedPrompt !== cleanPrompt || chatId() !== id) return;
        if (res?.success) updateStatusUI({
          userNoteCount: res.userNote ? 1 : 0,
          memoryCount: res.res?.selectedMemory?.length || 0,
          summaryCount: res.res?.selectedSummaries?.length || 0
        });
        if (preview) preview.value = res?.success ? (res.content || cleanPrompt) : '프롬프트를 준비하지 못했습니다.';
        if (previewStatus) previewStatus.textContent = res?.success
          ? (res.selected?.length ? `주입 ${res.selected.length}건 · ${res.mode === 'nano' ? 'Nano 기억' : '규칙식 기억'}` : `주입 없음 · ${res.reason || '관련 기억 없음'}`)
          : '프롬프트 준비 오류';
        if (res && res.success && res.content) {
          chrome.runtime.sendMessage({ type: 'LIVE_PROMPT_PREVIEW', target: 'sidepanel', chatId: id,
            draft: cleanPrompt, items: res.selected || [] }).catch(() => {});
          window.postMessage({
            type: 'CRACK_MATRIX_STAGE_PAYLOAD',
            originalPrompt: cleanPrompt,
            chatId: id,
            injectedContent: res.content,
            userNote: res.userNote || '',
            injectedCount: res.selected?.length || 0
          }, '*');
        }
      });
    }
  }

  function updateStatusUI(res) {
    refreshDockLabels();

    const uChip = document.getElementById('cm-dock-usernote');
    const mChip = document.getElementById('cm-dock-memory');

    if (uChip) uChip.classList.toggle('active', (res.userNoteCount || 0) > 0);
    if (mChip) mChip.classList.toggle('active', (res.memoryCount || 0) > 0 || (res.summaryCount || 0) > 0);
  }

  // --- 4. Chat Bubble 100% Zero-Trace Masking ---
  function maskInjectedMessages() {
    const startTag = '<!--CRACK_UBIS_CONTEXT_START-->';
    const endTag = '<!--CRACK_UBIS_CONTEXT_END-->';

    const candidates = document.querySelectorAll('.wrtn-markdown, [data-message-group-id], p, div');
    for (const el of candidates) {
      if (el.closest('#cm-client-modal, #cm-summary-modal, #cm-model-modal, #cm-top-pill-bar, script, style')) continue;
      if (el.dataset.cmMasked) continue;

      const txt = el.textContent || '';
      if (!txt.includes(startTag)) continue;

      if (txt.includes(endTag)) {
        const hasChildWithBoth = Array.from(el.children).some(c => c.textContent?.includes(startTag) && c.textContent?.includes(endTag));
        if (hasChildWithBoth) continue;

        el.dataset.cmMasked = 'true';
        const sIdx = txt.indexOf(startTag);
        const eIdx = txt.indexOf(endTag) + endTag.length;
        const cleanText = (txt.substring(0, sIdx) + txt.substring(eIdx)).replace(/^\n+/, '');

        if (el.children.length === 0) {
          el.textContent = cleanText;
          continue;
        }
      }

      const container = el.parentElement;
      if (!container || container.dataset.cmContainerMasked) continue;

      const cText = container.textContent || '';
      if (cText.includes(startTag) && cText.includes(endTag)) {
        container.dataset.cmContainerMasked = 'true';
        let inBlock = false;
        for (const child of Array.from(container.childNodes)) {
          const t = child.textContent || '';
          if (!inBlock && t.includes(startTag)) {
            inBlock = true;
            if (t.includes(endTag)) {
              inBlock = false;
              const s = t.indexOf(startTag);
              const e = t.indexOf(endTag) + endTag.length;
              const rem = (t.substring(0, s) + t.substring(e)).replace(/^\n+/, '');
              if (child.nodeType === Node.TEXT_NODE) child.nodeValue = rem;
              else { child.textContent = rem; if (!rem.trim()) child.style.display = 'none'; }
            } else {
              const s = t.indexOf(startTag);
              const rem = t.substring(0, s);
              if (child.nodeType === Node.TEXT_NODE) child.nodeValue = rem;
              else { child.textContent = rem; if (!rem.trim()) child.style.display = 'none'; }
            }
          } else if (inBlock) {
            if (t.includes(endTag)) {
              inBlock = false;
              const e = t.indexOf(endTag) + endTag.length;
              const rem = t.substring(e).replace(/^\n+/, '');
              if (child.nodeType === Node.TEXT_NODE) child.nodeValue = rem;
              else { child.textContent = rem; if (!rem.trim()) child.style.display = 'none'; }
            } else {
              if (child.nodeType === Node.ELEMENT_NODE) child.style.display = 'none';
              else if (child.nodeType === Node.TEXT_NODE) child.nodeValue = '';
            }
          }
        }
      }
    }
  }

  window.addEventListener('message', e => {
    if (e.source === window && e.data?.type === 'CRACK_MATRIX_SEND_RECORDED') {
      const id = String(e.data.chatId || '');
      if (id) chrome.runtime.sendMessage({ type: 'RECORD_SEND', chatId: id,
        injectedCount: Math.max(0, Number(e.data.injectedCount) || 0) }).catch(() => {});
    }
    if (e.data?.type === 'CRACK_MATRIX_INJECTED_SENT') {
      [10, 40, 120, 300, 800].forEach(delay => setTimeout(maskInjectedMessages, delay));
    }
  });

  // --- 5. Brand-New Dedicated Model Selector Modal ---
  // --- Format & Auto-Bracket Completion Helpers ---
  const FMT_MAP = {
    'bracket-round': ['(', ')'],
    'bracket-square': ['[', ']'],
    'bracket-curly': ['{', '}'],
    'quote-double': ['"', '"'],
    'quote-corner': ['「', '」'],
    'quote-white-corner': ['『', '』'],
    'bold': ['**', '**'],
    'italic': ['*', '*'],
    'pipe': ['｜', ''],
    'bullet': ['• ', ''],
    'json-note': ['{\n  "서술지침": "', '"\n}'],
    'style-novel': ['[서술 스타일: 3인칭 소설체로 배경과 상황을 풍부하게 전개]\n', ''],
    'style-mind': ['[심리 묘사: 인물의 복합적인 내면 심리와 표정을 섬세하게 서술]\n', '']
  };

  function handleFormatClick(textarea, fmtType, counterEl) {
    if (!textarea) return;
    const pair = FMT_MAP[fmtType] || ['', ''];
    insertFormat(textarea, pair[0], pair[1], counterEl);
  }

  function insertFormat(textarea, prefix, suffix, counterEl) {
    if (!textarea) return;
    const start = textarea.selectionStart || 0;
    const end = textarea.selectionEnd || 0;
    const val = textarea.value;
    const selected = val.substring(start, end);
    const rep = prefix + selected + suffix;
    textarea.value = val.substring(0, start) + rep + val.substring(end);
    const newPos = selected ? start + rep.length : start + prefix.length;
    textarea.selectionStart = textarea.selectionEnd = newPos;
    textarea.focus();
    textarea.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function setupAutoBrackets(textarea, toggleCb, counterEl, maxLen = 500) {
    if (!textarea) return;
    const pairs = { '(': ')', '[': ']', '{': '}', '"': '"', "'": "'", '`': '`', '*': '*', '「': '」', '『': '』' };
    const closers = new Set([')', ']', '}', '"', "'", '`', '*', '」', '』']);

    textarea.addEventListener('keydown', e => {
      if (toggleCb && !toggleCb.checked) return;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const val = textarea.value;

      if (pairs[e.key]) {
        e.preventDefault();
        const open = e.key;
        const close = pairs[open];
        if (start !== end) {
          const sel = val.substring(start, end);
          textarea.value = val.substring(0, start) + open + sel + close + val.substring(end);
          textarea.selectionStart = start + 1;
          textarea.selectionEnd = end + 1;
        } else {
          if (closers.has(open) && val[start] === open) {
            textarea.selectionStart = textarea.selectionEnd = start + 1;
          } else {
            textarea.value = val.substring(0, start) + open + close + val.substring(start);
            textarea.selectionStart = textarea.selectionEnd = start + 1;
          }
        }
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        return;
      }

      if (closers.has(e.key) && val[start] === e.key && start === end) {
        e.preventDefault();
        textarea.selectionStart = textarea.selectionEnd = start + 1;
        return;
      }

      if (e.key === 'Backspace' && start === end && start > 0) {
        const prev = val[start - 1];
        const next = val[start];
        if (pairs[prev] && pairs[prev] === next) {
          e.preventDefault();
          textarea.value = val.substring(0, start - 1) + val.substring(start + 1);
          textarea.selectionStart = textarea.selectionEnd = start - 1;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }
    });

    if (counterEl) {
      const updateCounter = () => {
        const len = textarea.value.length;
        counterEl.textContent = `${len}/${maxLen}자`;
        counterEl.classList.toggle('warning', len > maxLen);
      };
      textarea.addEventListener('input', updateCounter);
      updateCounter();
    }
  }

  const DEFAULT_USERNOTE_PRESETS = {
    'novel_deep': {
      title: '3인칭 소설체 & 심리 묘사',
      text: '서술은 3인칭 전지적 소설체로 전개하고, 인물의 미세한 표정 변화와 복합적인 내면 심리, 주변 풍경의 시각적 디테일을 풍부하게 묘사하세요.'
    },
    'combat_fast': {
      title: '긴박한 전투 & 공방일체 액션',
      text: '전투 장면은 한 합 한 합의 공방을 속도감 있고 처절하게 묘사하고, 무기의 궤적, 충격음, 뼈와 살이 떨리는 타격감을 생생한 텍스트로 연출하세요.'
    },
    'dialogue_pingpong': {
      title: '감정선 심화 & 티키타카 핑퐁',
      text: '대화는 짧고 날카로운 티키타카를 유지하며, 말과 말 사이의 침묵, 숨소리, 눈빛의 흔들림 등 비언어적 텐션을 극대화하세요.'
    },
    'hardboiled_noir': {
      title: '하드보일드 느와르 & 건조한 서사',
      text: '불필요한 미사여구를 배제하고 담백하고 거친 하드보일드 문체로 서술하세요. 비정하고 서늘한 분위기를 유지하세요.'
    }
  };

  // --- 6. Unified Master Modal Controller (LoreCache Console) ---
  let currentDeckFilter = 'all';

  function openMasterModal(activeTab = 'state', extraOpts = null) {
    const id = chatId();
    let modal = document.getElementById('cm-master-modal');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'cm-master-modal';
      modal.className = 'cm-modal-overlay';
      modal.innerHTML = `
        <div class="cm-modal-box master-modal">
          <div class="cm-modal-header">
            <div class="cm-modal-title-group">
              <img class="cm-modal-logo" src="${chrome.runtime.getURL('icons/lorecache.svg')}" alt="" width="28" height="28">
              <span class="cm-modal-title">LoreCache</span>
              <span class="cm-modal-room-badge" id="cm-master-room-badge">대화방 연결됨</span>
            </div>
            <button class="cm-modal-close" type="button" title="닫기 (ESC)">×</button>
          </div>
          <div class="cm-modal-tabs" id="cm-master-tabs">
            <button class="cm-tab-btn" data-tab="state"><span>📌</span> 현재 상태</button>
            <button class="cm-tab-btn" data-tab="deck"><span>🌿</span> 진화 기억덱</button>
            <button class="cm-tab-btn" data-tab="usernote"><span>📝</span> 유저노트</button>
            <button class="cm-tab-btn" data-tab="lore"><span>📜</span> 로어북</button>
            <button class="cm-tab-btn" data-tab="notes"><span>📋</span> 메모장</button>
            <button class="cm-tab-btn" data-tab="settings"><span>⚙️</span> 뷰 & 저장소</button>
            <button class="cm-tab-btn" data-tab="export"><span>📥</span> 내보내기</button>
          </div>
          <div class="cm-modal-body cm-master-body">
            <!-- TAB 1: Current State -->
            <div id="cm-master-tab-state" class="cm-tab-pane">
              <div class="cm-card highlight">
                <div class="cm-card-header">
                  <span>📌 놓치면 안 되는 현재 상태</span>
                  <label class="cm-switch-label"><input id="cm-curstate-enable" type="checkbox" checked> 주입 활성화</label>
                </div>
                <p style="font-size: 11.5px;color: var(--cm-text-3);margin: 0 0 8px">
                  자동 기억이 놓친 중요한 상태만 고정해 두세요. 대화가 바뀌면 직접 수정하거나 주입을 끌 수 있습니다.
                </p>
                <div style="display: grid;grid-template-columns: 1fr 1fr;gap: 8px;margin-bottom: 8px">
                  <div>
                    <label style="font-size: 11px;color: var(--cm-text-3);display: block;margin-bottom: 3px">📍 현재 위치/장소</label>
                    <input id="cm-curstate-loc" class="cm-input" placeholder="예: 동부 숲속 버려진 방앗간 지하 2층">
                  </div>
                  <div>
                    <label style="font-size: 11px;color: var(--cm-text-3);display: block;margin-bottom: 3px">🎯 당면 목표 / 전개 집중점</label>
                    <input id="cm-curstate-obj" class="cm-input" placeholder="예: 오른팔 자상을 지혈하고 에다와 함께 탈출구 확보">
                  </div>
                </div>
                <div>
                  <label style="font-size: 11px;color: var(--cm-text-3);display: block;margin-bottom: 3px">🩹 지속 신체 상태 / 부상 / 디테일한 관계 변화</label>
                  <textarea id="cm-curstate-cond" class="cm-textarea" style="min-height: 75px" placeholder="예: 오른팔 자상 출혈 진행 중, 마력 소진으로 인한 현기증, 에다에 대한 경계심이 안도로 완화됨"></textarea>
                </div>
                <div style="display: flex;justify-content: space-between;align-items: center;margin-top: 8px">
                  <span id="cm-curstate-status" style="font-size: 11.5px;color: var(--cm-text)"></span>
                  <button id="cm-btn-save-curstate" class="cm-btn-primary small" type="button">💾 현재 상태 저장 & 즉시 반영</button>
                </div>
              </div>
            </div>

            <!-- TAB 2: Evolution Deck -->
            <div id="cm-master-tab-deck" class="cm-tab-pane">
              <!-- Inline Summary Draft Review Box -->
              <div id="cm-deck-draft-box" class="cm-card highlight" style="display: none;border-color: var(--cm-line);margin-bottom: 12px">
                <div class="cm-card-header">
                  <span>🌿 4턴 슬라이딩 윈도우 & 시계열 진화 분석 초안</span>
                  <span id="cm-deck-draft-turn-tag" style="font-size: 11px;color: var(--cm-text)"></span>
                </div>
                <input id="cm-deck-draft-title" class="cm-input" placeholder="기억 카드 제목">
                <textarea id="cm-deck-draft-content" class="cm-textarea" style="min-height: 130px;font-family: monospace;font-size: 12px;line-height: 1.5" placeholder="기억 연대기 내용"></textarea>
                <div id="cm-deck-draft-notice" class="cm-notice" style="display: none">
                  💡 기존 기억 카드가 존재합니다. [기존 연대기 갱신]을 누르면 최신 진화 상태로 갱신되며, [새 카드로 추가]를 누르면 별도 카드가 보존됩니다.
                </div>
                <div style="display: flex;justify-content: flex-end;gap: 8px;margin-top: 8px">
                  <button id="cm-btn-deck-draft-update" class="cm-btn-primary small" type="button">기존 연대기 갱신</button>
                  <button id="cm-btn-deck-draft-new" class="cm-btn-secondary small" type="button">새 기억 카드로 추가</button>
                  <button id="cm-btn-deck-draft-close" class="cm-btn-secondary small" type="button">닫기</button>
                </div>
              </div>

              <!-- Filter and Actions Row -->
              <div style="display: flex;justify-content: space-between;align-items: center;margin-bottom: 10px;flex-wrap: wrap;gap: 8px">
                <div class="cm-filter-pills" id="cm-deck-filter-pills">
                  <button class="cm-filter-pill active" data-filter="all">전체</button>
                  <button class="cm-filter-pill" data-filter="인물">👤 인물</button>
                  <button class="cm-filter-pill" data-filter="장소">📍 장소</button>
                  <button class="cm-filter-pill" data-filter="기술">⚔️ 기술</button>
                  <button class="cm-filter-pill" data-filter="사건/약조">🤝 사건/약조</button>
                  <button class="cm-filter-pill" data-filter="개념">🏷️ 개념</button>
                </div>
                <div style="display: flex;gap: 6px;align-items: center">
                  <label class="cm-switch-label" style="font-size: 11px" title="Chrome 내장 Gemini Nano 자연어 정제 (기본 활성화)">
                    <input id="cm-mem-llm-toggle" type="checkbox" checked> 🤖 Gemini Nano 개입
                  </label>
                  <button id="cm-btn-mem-rebuild" class="cm-btn-secondary small" type="button" title="현재 대화를 다시 분석해 기억을 교체">⚡ 전체 다시 읽기</button>
                  <button id="cm-btn-mem-sum-now" class="cm-btn-primary small" type="button">✨ 새 요약 실행</button>
                </div>
              </div>

              <!-- Evolution Cards List -->
              <div id="cm-deck-cards-list" class="cm-memory-list"></div>

              <!-- Deck Sub-Views Toggle -->
              <div style="border-top: 1px solid var(--cm-line);margin-top: 16px;padding-top: 12px">
                <div style="display: flex;gap: 8px;margin-bottom: 10px">
                  <button id="cm-btn-toggle-logs" class="cm-btn-secondary small" type="button">📅 턴별 원본 슬라이딩 로그 보기</button>
                </div>
                <div id="cm-deck-subview-logs" style="display: none;margin-bottom: 12px">
                  <div style="display: flex;justify-content: space-between;align-items: center;margin-bottom: 6px">
                    <span style="font-size: 11.5px;color: var(--cm-text-3)">4턴 슬라이딩 윈도우 단위로 축적된 시계열 원본 로그</span>
                    <span id="cm-logs-count" style="font-size: 11px;color: var(--cm-text)"></span>
                  </div>
                  <div id="cm-logs-list" class="cm-memory-list" style="max-height: 260px;overflow-y: auto"></div>
                </div>
              </div>
            </div>

            <!-- TAB 3: User Note -->
            <div id="cm-master-tab-usernote" class="cm-tab-pane">
              <div class="cm-card highlight">
                <div class="cm-card-header">
                  <span>📝 상시 유저노트 (서술 지침 / Author's Note)</span>
                  <div style="display: flex;align-items: center;gap: 8px">
                    <label class="cm-switch-label" style="color: var(--cm-text)"><input id="cm-usernote-paid-mode" type="checkbox"> 💎 유료 플랜 (2,000자)</label>
                    <label class="cm-switch-label"><input id="cm-usernote-enable" type="checkbox" checked> 활성화</label>
                  </div>
                </div>

                <div class="cm-preset-row" style="flex-wrap: wrap;gap: 6px">
                  <span class="cm-preset-label">프리셋:</span>
                  <select id="cm-usernote-preset-select" class="cm-preset-select" style="min-width: 130px"></select>
                  <input id="cm-usernote-preset-name-input" class="cm-input" placeholder="새 프리셋 이름" style="width: 130px;height: 28px;font-size: 11.5px;padding: 2px 8px">
                  <div class="cm-preset-actions" style="display: flex;gap: 4px">
                    <button id="cm-btn-usernote-preset-new" class="cm-btn-primary small" type="button" title="입력한 이름으로 새 프리셋 저장">➕ 저장</button>
                    <button id="cm-btn-usernote-preset-rename" class="cm-btn-secondary small" type="button" title="선택된 프리셋 이름 변경">✏️ 이름변경</button>
                    <button id="cm-btn-usernote-preset-overwrite" class="cm-btn-secondary small" type="button" title="선택된 프리셋에 덮어쓰기">💾 덮어쓰기</button>
                    <button id="cm-btn-usernote-preset-del" class="cm-btn-secondary small" type="button" title="선택된 프리셋 삭제" style="color: var(--cm-danger)">🗑️</button>
                  </div>
                </div>

                <div class="cm-notice" style="margin: 8px 0;background: var(--cm-bg-2);border-color: var(--cm-line)">
                  ⚡ <b>100% 자동 분리 전송</b>: 크랙 모달을 따로 열거나 붙여넣을 필요 없이, 메시지 전송 시 순정 웹소켓 속성으로 자동 주입되어 말풍선을 오염시키지 않습니다 (기본 500자 / 💎 유료 플랜 2,000자 지원).
                </div>

                <div class="cm-editor-toolbar">
                  <div class="cm-format-chips">
                    <button type="button" class="cm-fmt-btn" data-fmt="bracket-round">()</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="bracket-square">[]</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="bracket-curly">{}</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="quote-double">""</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="bold">**강조**</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="json-note">JSON</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="style-novel">소설체</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="style-mind">심리묘사</button>
                  </div>
                  <div style="display: flex;align-items: center;gap: 10px">
                    <label class="cm-switch-label" style="font-size: 10.5px">
                      <input id="cm-usernote-autobracket" type="checkbox" checked> 괄호 자동 완성
                    </label>
                    <span id="cm-usernote-counter" class="cm-char-counter">0/500자</span>
                  </div>
                </div>
                <textarea id="cm-usernote-text" class="cm-textarea" style="min-height: 90px" placeholder="예: 서술은 3인칭 소설체로 길고 밀도 있게 전개하고, 인물의 복합적인 내면 심리와 시각적 디테일을 풍부하게 묘사하세요."></textarea>

                <div style="display: flex;justify-content: space-between;align-items: center;margin-top: 8px;flex-wrap: wrap;gap: 6px">
                  <button id="cm-btn-copy-usernote-text" class="cm-btn-secondary small" type="button" title="텍스트 복사">📋 텍스트 복사</button>
                  <div style="display: flex;gap: 6px">
                    <button id="cm-btn-save-usernote" class="cm-btn-primary small" type="button">💾 이 대화방에만 저장</button>
                    <button id="cm-btn-save-usernote-global" class="cm-btn-secondary small" type="button">🌐 모든 대화방 공통으로 저장</button>
                  </div>
                </div>
              </div>

            </div>

            <!-- TAB 5: Lorebook -->
            <div id="cm-master-tab-lore" class="cm-tab-pane">
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>📜 새 로어(설정) 등록</span>
                  <label class="cm-switch-label"><input id="cm-lore-always" type="checkbox"> 상시 주입</label>
                </div>
                <div style="display: grid;grid-template-columns: 1fr 1fr;gap: 8px;margin-bottom: 8px">
                  <input id="cm-lore-title" class="cm-input" placeholder="명칭 (예: 성검 아르테미스)">
                  <select id="cm-lore-triggertype" class="cm-input">
                    <option value="both">키워드 + 시맨틱 벡터 매칭 (권장)</option>
                    <option value="keyword">엄격한 키워드 매칭만</option>
                    <option value="semantic">시맨틱 벡터 매칭만</option>
                  </select>
                </div>
                <input id="cm-lore-kw" class="cm-input" placeholder="트리거 키워드 (쉼표 구분: 성검, 아르테미스, 신성무기)">
                <textarea id="cm-lore-content" class="cm-textarea" placeholder="주입할 설정 및 행동 지침 내용"></textarea>
                <div style="display: flex;justify-content: flex-end">
                  <button id="cm-btn-add-lore" class="cm-btn-primary small" type="button">로어 등록</button>
                </div>
              </div>

              <div style="display: flex;justify-content: space-between;align-items: center;margin: 14px 0 8px">
                <b style="color: var(--cm-text);font-size: 13px">등록된 로어 및 기억 요약 카드</b>
                <div style="display: flex;gap: 6px">
                  <button id="cm-btn-export-lore" class="cm-btn-secondary small" type="button">내보내기</button>
                  <button id="cm-btn-import-lore" class="cm-btn-secondary small" type="button">가져오기</button>
                </div>
              </div>
              <div id="cm-lore-card-container" class="cm-list"></div>
            </div>

            <!-- TAB 6: Notes Memo -->
            <div id="cm-master-tab-notes" class="cm-tab-pane">
              <div class="cm-card highlight">
                <div class="cm-card-header">
                  <span>📋 대화방 전용 메모장 (자동 저장)</span>
                  <span id="cm-notes-save-status" style="font-size: 11px;color: var(--cm-ok);font-weight: 600">자동 저장됨</span>
                </div>
                <div class="cm-editor-toolbar">
                  <div class="cm-format-chips">
                    <button type="button" class="cm-fmt-btn" data-fmt="bracket-round">()</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="bracket-square">[]</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="bracket-curly">{}</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="quote-double">""</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="quote-corner">「」</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="quote-white-corner">『』</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="bold">**</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="italic">*</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="pipe">｜</button>
                    <button type="button" class="cm-fmt-btn" data-fmt="bullet">•</button>
                  </div>
                  <span id="cm-notes-char-info" style="font-size: 11px;color: var(--cm-text-3)">0자</span>
                </div>
                <textarea id="cm-notes-editor-textarea" class="cm-notes-editor" style="min-height: 220px" placeholder="이 대화방에만 유지되는 자유 메모입니다.
복선, NPC 성격, 아이템 정보, 개인 플롯 구상 등을 자유롭게 적어두세요.
(작성 즉시 자동 저장됩니다)"></textarea>
                <div style="display: flex;justify-content: flex-end;margin-top: 8px">
                  <button class="cm-btn-secondary small" id="cm-btn-notes-copy" type="button">📋 메모 복사</button>
                </div>
              </div>
            </div>

            <!-- TAB 8: Settings & Storage -->
            <div id="cm-master-tab-settings" class="cm-tab-pane">
              <!-- View settings -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>🖥️ 화면 가독성 & 가로 너비 조절</span>
                </div>
                <div class="cm-form-row">
                  <label>가로 너비 실시간 조절: <b id="cm-val-width" style="color: var(--cm-text)">980px</b></label>
                  <input id="cm-opt-width-slider" type="range" min="720" max="1600" step="10" value="980" style="flex: 1;max-width: 240px">
                </div>
                <div class="cm-form-row">
                  <label>너비 프리셋</label>
                  <select id="cm-opt-width" class="cm-input" style="max-width: 240px">
                    <option value="normal">기본 (768px)</option>
                    <option value="wide" selected>와이드 (980px - 추천)</option>
                    <option value="ultra">울트라와이드 (1180px)</option>
                    <option value="full">전체화면 (94vw)</option>
                    <option value="custom">사용자 지정 (슬라이더)</option>
                  </select>
                </div>
                <div class="cm-form-row">
                  <label>소설 본문 글꼴</label>
                  <select id="cm-opt-font" class="cm-input" style="max-width: 240px">
                    <option value="maruburi" selected>마루부리 (한국어 소설 최적화)</option>
                    <option value="kopub">KoPub바탕</option>
                    <option value="myeongjo">나눔명조</option>
                    <option value="pretendard">Pretendard (기본 고딕)</option>
                  </select>
                </div>
                <div class="cm-form-row">
                  <label>글자 크기: <span id="cm-val-fontsize">15px</span></label>
                  <input id="cm-opt-fontsize" type="range" min="13" max="19" value="15" step="1" style="max-width: 240px">
                </div>
                <div class="cm-form-row">
                  <label>줄 간격: <span id="cm-val-lineheight">1.65</span></label>
                  <input id="cm-opt-lineheight" type="range" min="1.4" max="2.1" value="1.65" step="0.05" style="max-width: 240px">
                </div>
                <div style="border-top: 1px solid var(--cm-line);padding-top: 10px;margin-top: 10px">
                  <label class="cm-switch-label full">
                    <input id="cm-opt-perf" type="checkbox" checked>
                    <span>대화방 렌더링 최적화 (100턴 이상 대화 시 스크롤 버벅임 방지)</span>
                  </label>
                  <label class="cm-switch-label full">
                    <input id="cm-opt-imgpreload" type="checkbox" checked>
                    <span>초상화/썸네일 이미지 메모리 상시 캐싱 (깜빡임 및 로딩 지연 제거)</span>
                  </label>
                </div>
                <div style="display: flex;justify-content: flex-end;margin-top: 10px">
                  <button id="cm-btn-save-view" class="cm-btn-primary" type="button">뷰 설정 즉시 적용</button>
                </div>
              </div>

              <!-- Memory & Prompt Budget -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>⚙️ 클라이언트 주입 예산 & 기억 모드</span>
                </div>
                <label class="cm-switch-label full">
                  <input id="cm-opt-auto" type="checkbox" checked>
                  <span>메시지 전송 시 자동 기억/로어 주입 활성화</span>
                </label>
                <p class="cm-notice">전송 프롬프트는 사용자 입력을 포함해 2,000자로 고정됩니다. 남은 공간에 관련 기억을 넣습니다.</p>
                <div class="cm-form-row">
                  <label>Nano 기억 생성 주기 (AI 응답 몇 턴을 한 번에 읽을지)</label>
                  <select id="cm-opt-nano-batch" class="cm-input" style="max-width: 240px">
                    <option value="1">1턴씩</option><option value="2">2턴씩</option><option value="4" selected>4턴씩</option><option value="6">6턴씩</option><option value="10">10턴씩</option>
                  </select>
                </div>
                <div style="border-top: 1px solid var(--cm-line);margin: 10px 0;padding-top: 10px">
                  <label class="cm-switch-label full">
                    <input id="cm-opt-auto-summary" type="checkbox" checked>
                    <span>대화 진행 시 기억 진화 그래프 자동 갱신 (권장)</span>
                  </label>
                  <div class="cm-form-row" style="margin-top: 6px">
                    <label>진화 그래프 자동 갱신 주기 (턴 단위, 기본: 20턴)</label>
                    <input id="cm-opt-auto-summary-interval" type="number" class="cm-input" value="20" min="5" max="100" step="5">
                  </div>
                </div>
                <div style="border-top: 1px solid var(--cm-line);margin: 10px 0;padding-top: 10px">
                  <label class="cm-switch-label full">
                    <input id="cm-opt-llm-intervention" type="checkbox" checked>
                    <span>🤖 Gemini Nano로 기억 만들기</span>
                  </label>
                </div>
                <button id="cm-btn-save-client-settings" class="cm-btn-primary" type="button">설정 저장</button>
              </div>

              <!-- Storage Hygiene & GC -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>💾 브라우저 저장소 관리 & 데이터 자동 최적화</span>
                  <span id="cm-storage-usage-tag" style="font-size: 11px;color: var(--cm-text);font-weight: 600">계산 중…</span>
                </div>
                <p style="font-size: 11.5px;color: var(--cm-text-3);margin: 0 0 8px">
                  • <b>자동 가비지 컬렉션(GC)</b>: 매 시간마다 비정상 종료된 임시 데이터, 손상된 키, 30일 이상 미사용된 방의 찌꺼기를 백그라운드에서 자동 소거합니다.<br>
                  • <b>시계열 노드 자동 압축</b>: 50개 노드를 초과한 대화방은 발단과 주요 분기점, 최신 상태만 남기고 자동 압축하여 브라우저 용량 팽창을 원천 차단합니다.
                </p>
                <div style="display: flex;gap: 8px;flex-wrap: wrap;margin-top: 10px">
                  <button id="cm-btn-manual-gc" class="cm-btn-primary small" type="button">🧹 지금 즉시 데이터 청소 & 압축</button>
                  <button id="cm-btn-reset-chat-storage" class="cm-btn-secondary small" type="button" style="color: var(--cm-danger)">🗑️ 현재 대화방 기억 완전 초기화</button>
                </div>
              </div>

              <!-- Analytics -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>📊 오늘 통계</span>
                </div>
                <div id="cm-client-analytics" style="font-size: 12px;color: var(--cm-text-2)"></div>
              </div>
            </div>

            <!-- TAB 9: Export Conversation -->
            <div id="cm-master-tab-export" class="cm-tab-pane">
              <div class="cm-card highlight">
                <div class="cm-card-header">
                  <span>📥 초고속 대화 내보내기 (Export)</span>
                  <span style="font-size: 11px;color: var(--cm-text);font-weight: 600" id="cm-export-status">대기 중</span>
                </div>
                <p style="font-size: 11.5px;color: var(--cm-text-3);margin: 0 0 10px">
                  수백 턴의 대화 전체를 1초 만에 손실 없이 고속 추출하여 텍스트(.txt), 마크다운(.md) 파일로 저장하거나 클립보드에 복사합니다.
                </p>
                <div style="display: grid;grid-template-columns: 1fr 1fr;gap: 8px;margin-bottom: 8px">
                  <div>
                    <label style="font-size: 11px;color: var(--cm-text-3);display: block;margin-bottom: 4px">사용자 발화자명</label>
                    <input id="cm-export-username" class="cm-input" value="유저" placeholder="예: 유저 또는 내 캐릭터명">
                  </div>
                  <div>
                    <label style="font-size: 11px;color: var(--cm-text-3);display: block;margin-bottom: 4px">AI 발화자명</label>
                    <input id="cm-export-ainame" class="cm-input" value="AI" placeholder="예: AI 또는 상대 캐릭터명">
                  </div>
                </div>
                <div style="display: flex;flex-direction: column;gap: 6px;margin: 10px 0 14px">
                  <label class="cm-switch-label">
                    <input id="cm-export-rolelabels" type="checkbox" checked>
                    <span>발화자 라벨 표기 ([유저] / [AI])</span>
                  </label>
                  <label class="cm-switch-label">
                    <input id="cm-export-includeinfo" type="checkbox" checked>
                    <span>INFO 상태창 및 시스템 코드블록 포함</span>
                  </label>
                  <label class="cm-switch-label">
                    <input id="cm-export-use-dom" type="checkbox">
                    <span>현재 브라우저 화면(DOM) 기준으로 직접 추출 (대체 모드)</span>
                  </label>
                </div>
                <div style="display: flex;gap: 8px;flex-wrap: wrap">
                  <button id="cm-btn-export-txt" class="cm-btn-primary" type="button" style="flex: 1">📄 .txt 다운로드</button>
                  <button id="cm-btn-export-md" class="cm-btn-primary" type="button" style="flex: 1">📑 .md 다운로드</button>
                  <button id="cm-btn-export-copy" class="cm-btn-secondary" type="button" style="flex: 1">📋 클립보드 복사</button>
                </div>
              </div>

              <!-- Live Export Preview -->
              <div class="cm-card" style="background: var(--cm-bg);border-color: var(--cm-line)">
                <div style="display: flex;justify-content: space-between;align-items: center;margin-bottom: 6px">
                  <span style="font-weight: 700;color: var(--cm-text);font-size: 12px">👁️ 추출 미리보기</span>
                  <span id="cm-export-preview-info" style="font-size: 11px;color: var(--cm-text-4)">미리보기 대기 중</span>
                </div>
                <pre id="cm-export-preview" style="font-size: 11px;color: var(--cm-text-2);max-height: 130px;overflow-y: auto;white-space: pre-wrap;margin: 0;font-family: inherit;background: var(--cm-bg);padding: 8px;border-radius:var(--cm-r-tag);border: 1px solid var(--cm-line)"></pre>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      // Close handlers
      modal.querySelector('.cm-modal-close').onclick = () => modal.classList.remove('open');
      modal.onclick = (e) => { if (e.target === modal) modal.classList.remove('open'); };
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) {
          modal.classList.remove('open');
        }
      });

      // Tabs click handling
      const tabBtns = modal.querySelectorAll('#cm-master-tabs .cm-tab-btn');
      tabBtns.forEach(btn => {
        btn.onclick = () => {
          tabBtns.forEach(b => b.classList.remove('active'));
          modal.querySelectorAll('.cm-master-body .cm-tab-pane').forEach(p => p.classList.remove('active'));
          btn.classList.add('active');
          const pane = modal.querySelector(`#cm-master-tab-${btn.dataset.tab}`);
          if (pane) pane.classList.add('active');
          dispatchTabLoad(btn.dataset.tab, chatId(), modal);
        };
      });

      bindMasterModalEvents(modal);
    }

    // Room badge update
    const badge = modal.querySelector('#cm-master-room-badge');
    if (badge) {
      const title = document.title.replace(/\s*\|\s*크랙\s*$/, '').trim();
      badge.textContent = title ? `방: ${title.slice(0, 12)}…` : (id ? `방: ${id.slice(0, 8)}` : '대화방 연결 대기');
    }

    // Activate requested tab
    const targetTabBtn = modal.querySelector(`#cm-master-tabs .cm-tab-btn[data-tab="${activeTab}"]`);
    if (targetTabBtn) {
      targetTabBtn.click();
    } else {
      dispatchTabLoad(activeTab, id, modal, extraOpts);
    }

    if (extraOpts?.summaryDraft && activeTab === 'deck') {
      setupDeckDraftBanner(id, modal, extraOpts.summaryDraft);
    }

    modal.classList.add('open');
  }

  function dispatchTabLoad(tab, id, modal, extraOpts = null) {
    if (!id) id = chatId();
    if (tab === 'state') loadCurrentStateTab(id, modal);
    else if (tab === 'deck') renderMemoryDeckTab(id, modal, extraOpts);
    else if (tab === 'usernote') loadUserNoteTab(id, modal);
    else if (tab === 'lore') loadLoreTab(id, modal);
    else if (tab === 'notes') loadNotesTab(id, modal);
    else if (tab === 'settings') loadSettingsTab(id, modal);
    else if (tab === 'export') loadExportTab(id, modal);
  }

  // --- Tab 1: Current State Loader ---
  function loadCurrentStateTab(id, modal) {
    if (!id) return;
    chrome.storage.local.get([`currentState:${id}`], res => {
      const s = res[`currentState:${id}`] || {};
      const locEl = modal.querySelector('#cm-curstate-loc');
      const objEl = modal.querySelector('#cm-curstate-obj');
      const condEl = modal.querySelector('#cm-curstate-cond');
      const enEl = modal.querySelector('#cm-curstate-enable');
      if (locEl) locEl.value = s.location || '';
      if (objEl) objEl.value = s.objective || '';
      if (condEl) condEl.value = s.conditions || '';
      if (enEl) enEl.checked = s.enabled !== false;
    });
  }

  // --- Tab 2: Memory Evolution Deck Loader ---
  function setupDeckDraftBanner(id, modal, res) {
    const draftBox = modal.querySelector('#cm-deck-draft-box');
    if (!draftBox || !res) return;

    draftBox.style.display = 'block';
    const tag = modal.querySelector('#cm-deck-draft-turn-tag');
    const titleInput = modal.querySelector('#cm-deck-draft-title');
    const contentInput = modal.querySelector('#cm-deck-draft-content');
    const notice = modal.querySelector('#cm-deck-draft-notice');
    const updateBtn = modal.querySelector('#cm-btn-deck-draft-update');
    const newBtn = modal.querySelector('#cm-btn-deck-draft-new');
    const closeBtn = modal.querySelector('#cm-btn-deck-draft-close');

    if (tag) tag.textContent = `총 ${res.totalTurns || 0}턴 시계열 분석 완료`;
    if (titleInput) titleInput.value = `기억 진화 연대기 (턴 1~${res.totalTurns || '최신'})`;
    if (contentInput) contentInput.value = res.draftText || '';

    if (notice && updateBtn) {
      if (res.existingSummary) {
        notice.style.display = 'block';
        updateBtn.style.display = 'inline-flex';
      } else {
        notice.style.display = 'none';
        updateBtn.style.display = 'none';
      }
    }

    const saveAction = (action) => {
      const t = titleInput.value.trim();
      const c = contentInput.value.trim();
      if (!c) { alert('요약 내용을 입력해주세요.'); return; }
      chrome.runtime.sendMessage({
        type: 'SAVE_SUMMARY_CARD',
        chatId: id,
        action,
        card: { title: t, content: c }
      }, r => {
        if (r && r.success) {
          draftBox.style.display = 'none';
          alert('기억 카드가 성공적으로 저장되었습니다!');
          refreshDockLabels();
          renderMemoryDeckTab(id, modal);
        }
      });
    };

    if (updateBtn) updateBtn.onclick = () => saveAction('update');
    if (newBtn) newBtn.onclick = () => saveAction('new');
    if (closeBtn) closeBtn.onclick = () => { draftBox.style.display = 'none'; };
  }

  function renderMemoryDeckTab(id, modal, extraOpts = null) {
    const container = modal.querySelector('#cm-deck-cards-list');
    if (!container) return;
    const renderSerial = ++deckRenderSerial;
    container.innerHTML = '<div style="color: var(--cm-text-3);padding: 24px;text-align: center">진화 기억 덱 로딩 중…</div>';

    if (extraOpts?.summaryDraft) {
      setupDeckDraftBanner(id, modal, extraOpts.summaryDraft);
    }

    // Filter pills click
    const pills = modal.querySelectorAll('#cm-deck-filter-pills .cm-filter-pill');
    pills.forEach(p => {
      p.onclick = () => {
        if (chatId() !== id) return;
        pills.forEach(x => x.classList.remove('active'));
        p.classList.add('active');
        currentDeckFilter = p.dataset.filter;
        renderMemoryDeckTab(id, modal);
      };
    });

    // LLM toggle (default true)
    chrome.storage.local.get(['llmIntervention'], res => {
      if (chatId() !== id) return;
      const llmToggle = modal.querySelector('#cm-mem-llm-toggle');
      if (llmToggle) {
        llmToggle.checked = res.llmIntervention !== false;
        llmToggle.onchange = () => {
          if (llmToggle.checked) chrome.runtime.sendMessage({ type: 'OPEN_NANO_PANEL', chatId: id }, () => {});
          chrome.storage.local.set({ llmIntervention: llmToggle.checked }, () => {
            refreshDockLabels();
            renderMemoryDeckTab(id, modal);
            handleTyping(attachedEditor?.innerText || '');
            if (llmToggle.checked) chrome.runtime.sendMessage({ type: 'START_NANO_MEMORY', chatId: id, force: true }).catch(() => {});
          });
        };
      }
    });

    chrome.storage.local.get([`graph:${id}`, `summary:${id}`, `nanoMemory:${id}`, 'llmIntervention'], async res => {
      if (chatId() !== id || renderSerial !== deckRenderSerial) return;
      try {
        if (res.llmIntervention !== false) {
          const reply = await chrome.runtime.sendMessage({ type: 'GET_NANO_FACTS', chatId: id });
          if (chatId() !== id || renderSerial !== deckRenderSerial) return;
          if (!reply?.success) throw Error(reply?.error || '기억을 불러오지 못했습니다.');
          const facts = reply.facts || [];
          container.replaceChildren();
          if (!facts.length) {
            container.textContent = '아직 쌓인 기억이 없습니다.';
            return;
          }
          const groups = new Map();
          for (const fact of facts) {
            if (currentDeckFilter !== 'all' && fact.domain !== currentDeckFilter) continue;
            const keyword = String(fact.keyword || '').toLowerCase();
            if (!keyword) continue;
            if (!groups.has(keyword)) groups.set(keyword, []);
            groups.get(keyword).push(fact);
          }
          for (const chain of [...groups.values()].reverse()) {
            const card = document.createElement('div');
            card.className = 'cm-card keyword-card';
            const title = document.createElement('strong');
            title.textContent = chain.at(-1).keyword;
            card.append(title);
            const domain = document.createElement('span');
            domain.className = 'cm-badge';
            domain.textContent = chain.at(-1).domain || '미분류';
            card.append(domain);
            const exclude = document.createElement('button');
            exclude.className = 'cm-btn-secondary small';
            exclude.type = 'button';
            exclude.textContent = '키워드 제외';
            exclude.title = '이 키워드의 모든 기억을 숨기고 앞으로도 추출하지 않습니다';
            exclude.onclick = async () => {
              const keyword = chain.at(-1).keyword;
              if (!confirm(`‘${keyword}’ 키워드의 모든 기억을 제외할까요?`)) return;
              const result = await chrome.runtime.sendMessage({ type: 'DROP_KEYWORD', chatId: id, keyword });
              if (!result?.success) alert(result?.error || '키워드를 제외하지 못했습니다.');
            };
            card.append(exclude);
            for (const fact of chain) {
              const step = document.createElement('div');
              step.className = 'cm-evolution-step cm-nano-fact';
              if (fact.enabled === false) step.style.opacity = '0.55';
              const head = document.createElement('div');
              head.className = 'cm-nano-fact-head';
              const turn = document.createElement('span');
              turn.textContent = `대화 ${fact.turn}`;
              const controls = document.createElement('span');
              const toggleLabel = document.createElement('label');
              toggleLabel.className = 'cm-switch-label';
              const toggle = document.createElement('input');
              toggle.type = 'checkbox';
              toggle.checked = fact.enabled !== false;
              toggle.setAttribute('aria-label', `${fact.keyword} 기억 주입`);
              toggle.onchange = async () => {
                const result = await chrome.runtime.sendMessage({ type: 'UPDATE_NANO_FACT', chatId: id, factId: fact.id, patch: { enabled: toggle.checked } });
                if (!result?.success) { toggle.checked = !toggle.checked; alert(result?.error || '변경하지 못했습니다.'); }
              };
              toggleLabel.append(toggle, document.createTextNode(' 주입'));
              const edit = document.createElement('button');
              edit.className = 'cm-btn-secondary small';
              edit.type = 'button';
              edit.textContent = '수정';
              const remove = document.createElement('button');
              remove.className = 'cm-btn-secondary small';
              remove.type = 'button';
              remove.textContent = '삭제';
              remove.onclick = async () => {
                if (!confirm('이 기억 한 건을 삭제할까요?')) return;
                const result = await chrome.runtime.sendMessage({ type: 'UPDATE_NANO_FACT', chatId: id, factId: fact.id, delete: true });
                if (!result?.success) alert(result?.error || '삭제하지 못했습니다.');
              };
              controls.append(toggleLabel, edit, remove);
              head.append(turn, controls);
              const body = document.createElement('div');
              body.textContent = fact.fact;
              edit.onclick = () => {
                const form = document.createElement('div');
                form.className = 'cm-nano-fact-edit';
                const keyword = document.createElement('input');
                keyword.className = 'cm-input';
                keyword.value = fact.keyword;
                keyword.maxLength = 40;
                keyword.setAttribute('aria-label', '기억 키워드');
                const category = document.createElement('select');
                category.className = 'cm-input';
                category.setAttribute('aria-label', '기억 분류');
                for (const name of ['인물', '장소', '기술', '사건/약조', '개념']) {
                  const option = document.createElement('option');
                  option.value = name;
                  option.textContent = name;
                  category.append(option);
                }
                category.value = fact.domain || '개념';
                const text = document.createElement('textarea');
                text.className = 'cm-textarea';
                text.value = fact.fact;
                text.maxLength = 300;
                text.setAttribute('aria-label', '기억 내용');
                const save = document.createElement('button');
                save.className = 'cm-btn-primary small';
                save.type = 'button';
                save.textContent = '저장';
                const cancel = document.createElement('button');
                cancel.className = 'cm-btn-secondary small';
                cancel.type = 'button';
                cancel.textContent = '취소';
                cancel.onclick = () => form.replaceWith(body);
                save.onclick = async () => {
                  const result = await chrome.runtime.sendMessage({ type: 'UPDATE_NANO_FACT', chatId: id, factId: fact.id,
                    patch: { keyword: keyword.value, domain: category.value, fact: text.value } });
                  if (!result?.success) alert(result?.error || '수정하지 못했습니다.');
                };
                form.append(keyword, category, text, save, cancel);
                body.replaceWith(form);
                text.focus();
              };
              step.append(head, body);
              card.append(step);
            }
            container.append(card);
          }
          if (!container.childElementCount) container.textContent = '이 분류에 해당하는 기억이 없습니다.';
          return;
        }
        const graph = res[`graph:${id}`];
        let cards = [];
        if (graph && graph.nodes && graph.nodes.length) {
          if (typeof CrackMatrixEngine !== 'undefined' && CrackMatrixEngine.generateKeywordEvolutionCards) {
            cards = CrackMatrixEngine.generateKeywordEvolutionCards(graph);
          } else {
            const byKw = {};
            for (const n of graph.nodes) {
              const kw = n.keyword;
              if (!byKw[kw]) byKw[kw] = { keyword: kw, title: kw, role: n.role, domain: n.domain || '개념', nodes: [], content: '' };
              byKw[kw].nodes.push(n);
              byKw[kw].content = n.summary;
              byKw[kw].status = n.status || 'dormant';
            }
            cards = Object.values(byKw);
          }
        }
        if (!cards.length) {
          cards = res[`summary:${id}`] || [];
        }

        if (!cards.length) {
          container.innerHTML = `
            <div style="text-align: center;padding: 36px 16px;color: var(--cm-text-4);font-size: 12.5px;background: var(--cm-bg);border-radius:var(--cm-r-inner);border: 1px dashed var(--cm-line)">
              <div style="font-size: 24px;margin-bottom: 8px">🌿</div>
              축적된 진화 기억 카드가 없습니다.<br>
              대화가 진행되면 매 턴 4턴 슬라이딩 윈도우로 엔티티 진화 궤적이 자동 누적됩니다.<br><br>
              <button class="cm-btn-primary" id="cm-btn-first-deck-sum" type="button">✨ 대화 분석 및 기억 덱 생성</button>
            </div>
          `;
          const fBtn = container.querySelector('#cm-btn-first-deck-sum');
          if (fBtn) {
            fBtn.onclick = () => {
              triggerSummarization();
            };
          }
          return;
        }

        const filtered = cards.filter(c => {
          if (currentDeckFilter === 'all') return true;
          return (c.domain || '').includes(currentDeckFilter);
        });

        if (!filtered.length) {
          container.innerHTML = `<div style="text-align: center;padding: 24px;color: var(--cm-text-4);font-size: 12px">'${currentDeckFilter}' 카테고리에 해당하는 진화 카드가 없습니다.</div>`;
          return;
        }

        container.innerHTML = filtered.map(card => {
          const isActive = card.status === 'active';
          const statusBadge = isActive
            ? '<span class="cm-state-tag active">🟢 현재 씬 활성</span>'
            : '<span class="cm-state-tag dormant">💤 대기 중</span>';

          let stepsHtml = '';
          if (card.nodes && card.nodes.length > 0) {
            if (card.nodes.length === 1) {
              stepsHtml = `
                <div class="cm-evolution-step latest">
                  <span class="cm-step-tag latest">[턴 ${card.nodes[0].turnRange}]</span>
                  <span>${card.nodes[0].summary}</span>
                </div>
              `;
            } else {
              const root = card.nodes[0];
              const latest = card.nodes[card.nodes.length - 1];
              stepsHtml += `
                <div class="cm-evolution-step root">
                  <span class="cm-step-tag">[발단: 턴 ${root.turnRange}]</span>
                  <span>${root.summary}</span>
                </div>
              `;
              if (card.nodes.length > 2) {
                const mid = card.nodes[Math.floor(card.nodes.length / 2)];
                stepsHtml += `
                  <div class="cm-evolution-step">
                    <span class="cm-step-tag">[전개: 턴 ${mid.turnRange}]</span>
                    <span>${mid.summary}</span>
                  </div>
                `;
              }
              stepsHtml += `
                <div class="cm-evolution-step latest">
                  <span class="cm-step-tag latest">[최신: 턴 ${latest.turnRange}]</span>
                  <span>${latest.summary}</span>
                </div>
              `;
            }
          }

          return `
            <div class="cm-card keyword-card" data-kw="${card.keyword || card.title}">
              <div class="cm-card-header">
                <div style="display: flex;align-items: center;gap: 6px">
                  <span class="cm-memory-icon">${card.role === 'speaker' ? '👤' : '🏷️'}</span>
                  <b style="color: var(--cm-text);font-size: 13px">${card.title || card.keyword}</b>
                  <span class="cm-badge">${card.domain || '개념🏷️'}</span>
                  ${statusBadge}
                </div>
                <div style="display: flex;align-items: center;gap: 6px">
                  <label class="cm-switch-label" style="font-size: 11px">
                    <input type="checkbox" class="cm-deck-card-toggle" data-kw="${card.keyword || card.title}" ${card.enabled !== false ? 'checked' : ''}> 주입
                  </label>
                  <button class="cm-btn-secondary small cm-btn-edit-deck" type="button" data-kw="${card.keyword || card.title}">✏️ 수정</button>
                  <button class="cm-btn-secondary small cm-btn-del-deck" type="button" data-kw="${card.keyword || card.title}" title="이 키워드를 기억에서 빼고, 앞으로도 추출하지 않습니다">🚫 제외</button>
                </div>
              </div>

              ${stepsHtml ? `<div class="cm-evolution-trajectory" style="margin: 6px 0 8px">${stepsHtml}</div>` : ''}

              <div class="cm-card-body cm-deck-card-text" style="font-size: 12px;color: var(--cm-text-2);line-height: 1.5;white-space: pre-wrap;margin-top: 4px">${card.content}</div>
            </div>
          `;
        }).join('');

        // Card Edit / Delete / Toggle
        container.querySelectorAll('.cm-btn-edit-deck').forEach(btn => {
          btn.onclick = () => {
            const kw = btn.dataset.kw;
            const cardEl = btn.closest('.cm-card');
            const bodyEl = cardEl.querySelector('.cm-deck-card-text');
            if (btn.classList.contains('editing')) {
              const newText = bodyEl.querySelector('textarea')?.value.trim() || '';
              btn.textContent = '✏️ 수정';
              btn.classList.remove('editing');
              bodyEl.innerHTML = newText;

              chrome.storage.local.get([`summary:${id}`, `graph:${id}`], r => {
                const list = (r[`summary:${id}`] || []).map(x => (x.keyword === kw || x.title === kw) ? { ...x, content: newText } : x);
                const g = r[`graph:${id}`];
                if (g && g.nodes) {
                  g.nodes.forEach(n => {
                    if (n.keyword === kw) n.summary = newText;
                  });
                }
                chrome.storage.local.set({ [`summary:${id}`]: list, [`graph:${id}`]: g }, () => {
                  handleTyping(attachedEditor?.innerText || '');
                });
              });
            } else {
              btn.classList.add('editing');
              btn.textContent = '💾 저장';
              const currText = bodyEl.innerText.trim();
              bodyEl.innerHTML = `<textarea class="cm-textarea" style="min-height: 90px">${currText}</textarea>`;
              bodyEl.querySelector('textarea')?.focus();
            }
          };
        });

        container.querySelectorAll('.cm-btn-del-deck').forEach(btn => {
          btn.onclick = () => {
            const kw = btn.dataset.kw;
            if (!confirm(`'${kw}'을(를) 기억에서 제외할까요? 앞으로도 이 키워드는 추출하지 않습니다.`)) return;
            chrome.runtime.sendMessage({ type: 'DROP_KEYWORD', chatId: id, keyword: kw }, () => {
              renderMemoryDeckTab(id, modal);
              refreshDockLabels();
            });
          };
        });

        container.querySelectorAll('.cm-deck-card-toggle').forEach(chk => {
          chk.onchange = () => {
            const kw = chk.dataset.kw;
            chrome.storage.local.get([`summary:${id}`], r => {
              const list = (r[`summary:${id}`] || []).map(x => (x.keyword === kw || x.title === kw) ? { ...x, enabled: chk.checked } : x);
              chrome.storage.local.set({ [`summary:${id}`]: list }, () => {
                handleTyping(attachedEditor?.innerText || '');
              });
            });
          };
        });
      } catch (err) {
        console.error('[CrackMatrix] Error rendering evolution deck:', err);
        container.innerHTML = `<div style="text-align: center;padding: 24px;color: var(--cm-danger)">진화 기억 덱 렌더링 중 오류가 발생했습니다: ${err.message}</div>`;
      }
    });
  }

  // --- Subviews inside Tab 2 ---
  function renderMemoryLogs(id, modal) {
    const container = modal.querySelector('#cm-logs-list');
    const countEl = modal.querySelector('#cm-logs-count');
    if (!container) return;
    container.innerHTML = '<div style="color: var(--cm-text-3);padding: 12px;text-align: center">턴별 로그 로딩 중…</div>';

    chrome.storage.local.get([`graph:${id}`], res => {
      const graph = res[`graph:${id}`];
      if (!graph || !graph.nodes || !graph.nodes.length) {
        container.innerHTML = '<div style="text-align: center;padding: 16px;color: var(--cm-text-4)">기록된 턴별 로그가 없습니다.</div>';
        if (countEl) countEl.textContent = '0개 노드';
        return;
      }
      if (countEl) countEl.textContent = `총 ${graph.nodes.length}개 노드`;
      container.innerHTML = graph.nodes.map((node, idx) => `
        <div class="cm-memory-item" style="padding: 6px 8px;margin-bottom: 6px;background: var(--cm-bg-hover);border-radius:var(--cm-r-tag);border: 1px solid var(--cm-line)">
          <div style="display: flex;justify-content: space-between;margin-bottom: 2px">
            <span style="font-size: 11px;font-weight: 700;color: var(--cm-text)">#${idx + 1}. [턴 ${node.turnRange}] ${node.keyword}</span>
            <span style="font-size: 10px;color: var(--cm-text-3)">${node.role === 'speaker' ? '👤 화자' : '🏷️ 개념'}</span>
          </div>
          <div style="font-size: 11.5px;color: var(--cm-text-2)">${node.summary}</div>
        </div>
      `).reverse().join('');
    });
  }

  // --- Tab 3: User Note Loader ---
  function loadUserNoteTab(id, modal) {
    const textEl = modal.querySelector('#cm-usernote-text');
    const enableEl = modal.querySelector('#cm-usernote-enable');
    chrome.storage.local.get([`usernote:${id}`, 'usernote:auto_enabled', 'usernote:global'], res => {
      const localUn = res[`usernote:${id}`];
      const globalUn = res['usernote:global'] || '';
      const autoGlobal = res['usernote:auto_enabled'] !== false;

      if (textEl) {
        textEl.value = (localUn !== undefined && localUn !== '') ? localUn : (autoGlobal ? globalUn : '');
        textEl.dispatchEvent(new Event('input', { bubbles: true }));
      }
      if (enableEl) {
        enableEl.checked = !!(localUn || (autoGlobal && globalUn));
      }

    });
  }

  // --- Tab 5: Lorebook Loader ---
  function loadLoreTab(id, modal) {
    const container = modal.querySelector('#cm-lore-card-container');
    if (!container) return;

    chrome.storage.local.get([`lore:${id}`], res => {
      const lores = res[`lore:${id}`] || [];
      if (!lores.length) {
        container.innerHTML = '<div style="color: var(--cm-text-4);font-size: 12px;padding: 16px;text-align: center">등록된 로어가 없습니다. 위 양식에서 새 로어를 등록하세요.</div>';
        return;
      }

      container.innerHTML = lores.map(item => `
        <div class="cm-card">
          <div class="cm-card-header">
            <span>📜 <b>${item.title || '로어'}</b></span>
            <div style="display: flex;align-items: center;gap: 6px">
              <label class="cm-switch-label"><input type="checkbox" class="cm-card-toggle" data-id="${item.id}" ${item.enabled !== false ? 'checked' : ''}> 활성</label>
              <button class="cm-btn-secondary small cm-card-delete" data-id="${item.id}" type="button">삭제</button>
            </div>
          </div>
          <div style="font-size: 11px;color: var(--cm-text);margin-bottom: 4px">
            트리거: ${item.alwaysInclude ? '상시 주입' : (item.keywords || []).join(', ') || '시맨틱 매칭'} · ${item.triggerType || 'both'}
          </div>
          <p style="font-size: 12px;color: var(--cm-text-2);white-space: pre-wrap;line-height: 1.5;margin: 4px 0">${item.content}</p>
        </div>
      `).join('');

      container.querySelectorAll('.cm-card-delete').forEach(btn => {
        btn.onclick = () => {
          const cardId = btn.dataset.id;
          chrome.storage.local.get([`lore:${id}`], r => {
            const list = (r[`lore:${id}`] || []).filter(x => x.id !== cardId);
            chrome.storage.local.set({ [`lore:${id}`]: list }, () => loadLoreTab(id, modal));
          });
        };
      });

      container.querySelectorAll('.cm-card-toggle').forEach(chk => {
        chk.onchange = () => {
          const cardId = chk.dataset.id;
          chrome.storage.local.get([`lore:${id}`], r => {
            const list = (r[`lore:${id}`] || []).map(x => x.id === cardId ? { ...x, enabled: chk.checked } : x);
            chrome.storage.local.set({ [`lore:${id}`]: list }, () => handleTyping(attachedEditor?.innerText || ''));
          });
        };
      });
    });
  }

  // --- Tab 6: Notes Loader ---
  function loadNotesTab(id, modal) {
    const txt = modal.querySelector('#cm-notes-editor-textarea');
    const charInfo = modal.querySelector('#cm-notes-char-info');
    if (!txt) return;

    chrome.storage.local.get([`notes:${id}`], res => {
      txt.value = res[`notes:${id}`] || '';
      if (charInfo) charInfo.textContent = `${txt.value.length}자`;
    });
  }

  // --- Tab 8: Settings & Storage Loader ---
  function loadSettingsTab(id, modal) {
    chrome.storage.local.get([
      'clientViewSettings',
      `auto:${id}`,
      'autoSummaryEnabled',
      'autoSummaryInterval',
      'nanoBatchSize',
      'llmIntervention'
    ], res => {
      const v = res.clientViewSettings || {};
      const widthSelect = modal.querySelector('#cm-opt-width');
      const widthSlider = modal.querySelector('#cm-opt-width-slider');
      const widthVal = modal.querySelector('#cm-val-width');
      const fontSelect = modal.querySelector('#cm-opt-font');
      const fontSlider = modal.querySelector('#cm-opt-fontsize');
      const fontVal = modal.querySelector('#cm-val-fontsize');
      const lineSlider = modal.querySelector('#cm-opt-lineheight');
      const lineVal = modal.querySelector('#cm-val-lineheight');
      const perfEl = modal.querySelector('#cm-opt-perf');
      const imgEl = modal.querySelector('#cm-opt-imgpreload');

      if (widthSelect) widthSelect.value = v.width || 'wide';
      if (widthSlider) widthSlider.value = v.customWidth || 980;
      if (widthVal) widthVal.textContent = `${v.customWidth || 980}px`;
      if (fontSelect) fontSelect.value = v.font || 'maruburi';
      if (fontSlider) fontSlider.value = v.fontSize || 15;
      if (fontVal) fontVal.textContent = `${v.fontSize || 15}px`;
      if (lineSlider) lineSlider.value = v.lineHeight || 1.65;
      if (lineVal) lineVal.textContent = v.lineHeight || '1.65';
      if (perfEl) perfEl.checked = v.perfOpt !== false;
      if (imgEl) imgEl.checked = v.imagePreload !== false;

      const autoEl = modal.querySelector('#cm-opt-auto');
      const sumEl = modal.querySelector('#cm-opt-auto-summary');
      const intEl = modal.querySelector('#cm-opt-auto-summary-interval');
      const llmEl = modal.querySelector('#cm-opt-llm-intervention');

      if (autoEl) autoEl.checked = res[`auto:${id}`] !== false;
      if (sumEl) sumEl.checked = res.autoSummaryEnabled !== false;
      if (intEl) intEl.value = res.autoSummaryInterval || 20;
      const nanoBatchEl = modal.querySelector('#cm-opt-nano-batch');
      if (nanoBatchEl) nanoBatchEl.value = String(res.nanoBatchSize || 4);
      if (llmEl) llmEl.checked = res.llmIntervention !== false; // default true
    });

    // Refresh storage usage
    const storageTag = modal.querySelector('#cm-storage-usage-tag');
    if (storageTag) {
      chrome.runtime.sendMessage({ type: 'GET_STORAGE_USAGE' }, res => {
        if (res && res.success) {
          storageTag.textContent = `현재 사용량: ${res.kb} (${res.mb})`;
        }
      });
    }

    // Statistics are assembled from the same room snapshot and send counters as the extension panel.
    chrome.runtime.sendMessage({ type: 'GET_CHAT_STATS', chatId: id }, result => {
      if (!result?.success || result.stats?.chatId !== chatId()) return;
      const s = result.stats;
      const el = modal.querySelector('#cm-client-analytics');
      if (!el) return;
      el.innerHTML = s.mode === 'nano'
        ? `Nano 처리 <b>${s.processedTurns}/${s.totalTurns}턴</b> · 대기 ${s.pendingTurns}턴 · 기억 사실 ${s.factCount}건<br>이 대화 오늘 전송 <b>${s.roomToday.sends}회</b> · 주입 ${s.roomToday.injected}건`
        : `추출식 대화 <b>${s.totalTurns}턴</b> · 기억 노드 ${s.graphNodes}개<br>이 대화 오늘 전송 <b>${s.roomToday.sends}회</b> · 주입 ${s.roomToday.injected}건`;
    });
  }

  // --- Tab 9: Export Loader ---
  function loadExportTab(id, modal) {
    const aiEl = modal.querySelector('#cm-export-ainame');
    if (aiEl && (!aiEl.value || aiEl.value === 'AI')) {
      const title = document.title.replace(/\s*\|\s*크랙\s*$/, '').trim();
      if (title) aiEl.value = title;
    }
  }

  // --- Master Modal Events Binder ---
  function bindMasterModalEvents(modal) {
    const id = () => chatId();

    // 1. Current State Save
    modal.querySelector('#cm-btn-save-curstate').onclick = () => {
      const currentId = id();
      const loc = modal.querySelector('#cm-curstate-loc').value.trim();
      const obj = modal.querySelector('#cm-curstate-obj').value.trim();
      const cond = modal.querySelector('#cm-curstate-cond').value.trim();
      const enabled = modal.querySelector('#cm-curstate-enable').checked;
      const statusEl = modal.querySelector('#cm-curstate-status');

      chrome.storage.local.set({
        [`currentState:${currentId}`]: { location: loc, objective: obj, conditions: cond, enabled }
      }, () => {
        if (statusEl) {
          statusEl.textContent = '저장 완료!';
          setTimeout(() => { statusEl.textContent = ''; }, 2000);
        }
        refreshDockLabels();
        handleTyping(attachedEditor?.innerText || '');
      });
    };

    // 2. Evolution Deck Controls (Full Rebuild)
    modal.querySelector('#cm-btn-mem-rebuild').onclick = () => {
      if (nanoModeEnabled) {
        const currentId = id();
        if (!confirm('현재 대화의 기억을 처음부터 다시 만들까요? 새 분석이 모두 끝나면 기존 기억을 교체합니다.')) return;
        chrome.runtime.sendMessage({ type: 'OPEN_NANO_PANEL', chatId: currentId, rebuild: true }, panel => {
          if (!panel?.success) alert(panel?.error || '모델 화면을 열지 못했습니다.');
        });
        return;
      }
      const currentId = id();
      const btn = modal.querySelector('#cm-btn-mem-rebuild');
      btn.textContent = '⏳ 전체 재분석 중...';
      btn.disabled = true;
      const progressId = startAnalysis('rebuild', '전체 재분석');
      chrome.runtime.sendMessage({ type: 'REBUILD_EVOLUTION_GRAPH', chatId: currentId, progressId }, r => {
        finishAnalysis('rebuild');
        btn.textContent = '⚡ 전체 다시 읽기';
        btn.disabled = false;
        if (r && r.success) {
          if (r.nanoStarted) return;
          alert(`전체 대화 시계열 진화 그래프가 성공적으로 재분석되었습니다!\n(노드: ${r.nodeCount}개, 진화 링크: ${r.edgeCount}개)`);
          renderMemoryDeckTab(currentId, modal);
          refreshDockLabels();
        } else {
          alert(r?.error || '재구축 실패');
        }
      });
    };

    modal.querySelector('#cm-btn-mem-sum-now').onclick = () => {
      triggerSummarization();
    };

    // Sub-views toggles
    const logsBtn = modal.querySelector('#cm-btn-toggle-logs');
    const logsBox = modal.querySelector('#cm-deck-subview-logs');
    if (logsBtn && logsBox) {
      logsBtn.onclick = () => {
        const isHidden = logsBox.style.display === 'none';
        logsBox.style.display = isHidden ? 'block' : 'none';
        logsBtn.textContent = isHidden ? '📅 턴별 원본 슬라이딩 로그 접기' : '📅 턴별 원본 슬라이딩 로그 보기';
        if (isHidden) renderMemoryLogs(id(), modal);
      };
    }

    // 3. User Note Autobrackets & Limit Switching
    const userNoteText = modal.querySelector('#cm-usernote-text');
    const userNoteCounter = modal.querySelector('#cm-usernote-counter');
    const userNoteBracketToggle = modal.querySelector('#cm-usernote-autobracket');
    const userNotePaidMode = modal.querySelector('#cm-usernote-paid-mode');

    function updateUserNoteLimit(isPaid) {
      const limit = isPaid ? 2000 : 500;
      setupAutoBrackets(userNoteText, userNoteBracketToggle, userNoteCounter, limit);
      userNoteText.setAttribute('maxlength', String(limit));
      userNoteText.dispatchEvent(new Event('input', { bubbles: true }));
    }

    chrome.storage.local.get(['usernote_paid_mode'], r => {
      const isPaid = !!r.usernote_paid_mode;
      if (userNotePaidMode) userNotePaidMode.checked = isPaid;
      updateUserNoteLimit(isPaid);
    });

    if (userNotePaidMode) {
      userNotePaidMode.onchange = () => {
        const isPaid = userNotePaidMode.checked;
        chrome.storage.local.set({ usernote_paid_mode: isPaid });
        updateUserNoteLimit(isPaid);
      };
    }

    // User note format chips
    modal.querySelectorAll('#cm-master-tab-usernote .cm-fmt-btn').forEach(btn => {
      btn.onclick = () => {
        handleFormatClick(userNoteText, btn.dataset.fmt, userNoteCounter);
      };
    });

    // User note presets
    setupPresetManager({
      storageKey: 'usernote_presets',
      selectEl: modal.querySelector('#cm-usernote-preset-select'),
      nameInputEl: modal.querySelector('#cm-usernote-preset-name-input'),
      newBtn: modal.querySelector('#cm-btn-usernote-preset-new'),
      renameBtn: modal.querySelector('#cm-btn-usernote-preset-rename'),
      overwriteBtn: modal.querySelector('#cm-btn-usernote-preset-overwrite'),
      delBtn: modal.querySelector('#cm-btn-usernote-preset-del'),
      defaultName: '소설 서술 지침',
      getFields: () => ({
        text: modal.querySelector('#cm-usernote-text').value.trim()
      }),
      setFields: (p) => {
        modal.querySelector('#cm-usernote-text').value = p.text || '';
        userNoteText.dispatchEvent(new Event('input', { bubbles: true }));
      }
    });

    modal.querySelector('#cm-btn-copy-usernote-text').onclick = () => {
      const text = userNoteText.value.trim();
      navigator.clipboard.writeText(text).then(() => alert('유저노트 텍스트가 클립보드에 복사되었습니다!'));
    };

    // Save strictly to this room
    modal.querySelector('#cm-btn-save-usernote').onclick = () => {
      const currentId = id();
      const text = userNoteText.value.trim();
      const enabled = modal.querySelector('#cm-usernote-enable').checked;

      chrome.storage.local.set({
        [`usernote:${currentId}`]: enabled ? text : ''
      }, () => {
        alert('현재 대화방 전용 유저노트가 저장되었습니다.\n(메시지 전송 시 순정 웹소켓 속성으로 100% 자동 분리 주입됩니다)');
        refreshDockLabels();
        handleTyping(attachedEditor?.innerText || '');
      });
    };

    // Save globally for all rooms
    modal.querySelector('#cm-btn-save-usernote-global').onclick = () => {
      const text = userNoteText.value.trim();
      if (!confirm('현재 작성된 유저노트를 모든 대화방의 공통 기본값으로 저장하시겠습니까?')) return;
      chrome.storage.local.set({
        'usernote:global': text,
        'usernote:auto_enabled': true
      }, () => {
        alert('모든 대화방에 기본 적용되는 공통 유저노트로 저장되었습니다.');
        refreshDockLabels();
        handleTyping(attachedEditor?.innerText || '');
      });
    };

    // 5. Lore Events
    modal.querySelector('#cm-btn-add-lore').onclick = () => {
      const currentId = id();
      const title = modal.querySelector('#cm-lore-title').value.trim();
      const triggerType = modal.querySelector('#cm-lore-triggertype').value;
      const kw = modal.querySelector('#cm-lore-kw').value.trim();
      const content = modal.querySelector('#cm-lore-content').value.trim();
      const alwaysInclude = modal.querySelector('#cm-lore-always').checked;
      if (!content) { alert('설정 내용을 입력하세요.'); return; }

      const keyName = `lore:${currentId}`;
      chrome.storage.local.get([keyName], res => {
        const list = res[keyName] || [];
        list.unshift({
          id: `lore_${Date.now()}`,
          title: title || '로어',
          triggerType,
          keywords: kw.split(',').map(s => s.trim()).filter(Boolean),
          content,
          alwaysInclude,
          enabled: true
        });
        chrome.storage.local.set({ [keyName]: list }, () => {
          modal.querySelector('#cm-lore-title').value = '';
          modal.querySelector('#cm-lore-kw').value = '';
          modal.querySelector('#cm-lore-content').value = '';
          modal.querySelector('#cm-lore-always').checked = false;
          loadLoreTab(currentId, modal);
          refreshDockLabels();
        });
      });
    };

    modal.querySelector('#cm-btn-export-lore').onclick = () => {
      chrome.storage.local.get([`lore:${id()}`], async res => {
        const list = res[`lore:${id()}`] || [];
        await navigator.clipboard.writeText(JSON.stringify(list, null, 2));
        alert('로어북 JSON이 클립보드에 복사되었습니다.');
      });
    };

    modal.querySelector('#cm-btn-import-lore').onclick = () => {
      const raw = prompt('로어북 JSON을 붙여넣으세요:');
      if (!raw) return;
      try {
        const arr = JSON.parse(raw);
        if (!Array.isArray(arr)) throw new Error('올바른 배열 형식이 아닙니다.');
        const currentId = id();
        chrome.storage.local.get([`lore:${currentId}`], res => {
          const list = res[`lore:${currentId}`] || [];
          chrome.storage.local.set({ [`lore:${currentId}`]: [...list, ...arr] }, () => {
            loadLoreTab(currentId, modal);
            refreshDockLabels();
            alert(`${arr.length}개 로어를 가져왔습니다.`);
          });
        });
      } catch (e) { alert(e.message); }
    };

    // 6. Notes Debounced Auto-Save
    const notesEditor = modal.querySelector('#cm-notes-editor-textarea');
    const notesStatus = modal.querySelector('#cm-notes-save-status');
    const notesCharInfo = modal.querySelector('#cm-notes-char-info');
    let noteDebounce = null;

    setupAutoBrackets(notesEditor, null, notesCharInfo, 10000);

    notesEditor.addEventListener('input', () => {
      notesStatus.textContent = '저장 중…';
      notesStatus.style.color = 'var(--cm-warn)';
      notesCharInfo.textContent = `${notesEditor.value.length}자`;

      clearTimeout(noteDebounce);
      noteDebounce = setTimeout(() => {
        chrome.storage.local.set({ [`notes:${id()}`]: notesEditor.value }, () => {
          notesStatus.textContent = '자동 저장됨';
          notesStatus.style.color = 'var(--cm-ok)';
        });
      }, 300);
    });

    modal.querySelectorAll('#cm-master-tab-notes .cm-fmt-btn').forEach(btn => {
      btn.onclick = () => {
        handleFormatClick(notesEditor, btn.dataset.fmt, notesCharInfo);
      };
    });

    modal.querySelector('#cm-btn-notes-copy').onclick = () => {
      navigator.clipboard.writeText(notesEditor.value).then(() => alert('메모 내용이 클립보드에 복사되었습니다!'));
    };

    // 7. Settings & Storage Events
    const widthSlider = modal.querySelector('#cm-opt-width-slider');
    const widthVal = modal.querySelector('#cm-val-width');
    const widthSelect = modal.querySelector('#cm-opt-width');
    if (widthSlider) {
      widthSlider.oninput = (e) => {
        const px = `${e.target.value}px`;
        if (widthVal) widthVal.textContent = px;
        if (widthSelect) widthSelect.value = 'custom';
        document.body.setAttribute('data-cm-custom-width', 'true');
        document.documentElement.style.setProperty('--cm-chat-width', px);
      };
    }

    modal.querySelector('#cm-opt-fontsize').oninput = (e) => {
      modal.querySelector('#cm-val-fontsize').textContent = `${e.target.value}px`;
    };
    modal.querySelector('#cm-opt-lineheight').oninput = (e) => {
      modal.querySelector('#cm-val-lineheight').textContent = e.target.value;
    };

    modal.querySelector('#cm-btn-save-view').onclick = () => {
      const settings = {
        width: modal.querySelector('#cm-opt-width').value,
        customWidth: modal.querySelector('#cm-opt-width-slider')?.value || '980',
        font: modal.querySelector('#cm-opt-font').value,
        fontSize: modal.querySelector('#cm-opt-fontsize').value,
        lineHeight: modal.querySelector('#cm-opt-lineheight').value,
        perfOpt: modal.querySelector('#cm-opt-perf').checked,
        imagePreload: modal.querySelector('#cm-opt-imgpreload').checked
      };
      chrome.storage.local.set({ clientViewSettings: settings }, () => {
        applyClientViewSettings();
        alert('뷰 및 성능 설정이 즉시 적용되었습니다.');
      });
    };

    modal.querySelector('#cm-btn-save-client-settings').onclick = () => {
      const currentId = id();
      const isAuto = modal.querySelector('#cm-opt-auto').checked;
      const autoSummary = modal.querySelector('#cm-opt-auto-summary').checked;
      const autoSummaryInterval = Number(modal.querySelector('#cm-opt-auto-summary-interval').value) || 20;
      const llmIntervention = modal.querySelector('#cm-opt-llm-intervention')?.checked ?? true;
      const nanoBatchSize = Number(modal.querySelector('#cm-opt-nano-batch').value) || 4;
      if (llmIntervention) chrome.runtime.sendMessage({ type: 'OPEN_NANO_PANEL' }, () => {});

      chrome.storage.local.set({
        [`auto:${currentId}`]: isAuto,
        autoSummaryEnabled: autoSummary,
        autoSummaryInterval: autoSummaryInterval,
        nanoBatchSize,
        llmIntervention: llmIntervention
      }, () => {
        alert('설정이 저장되었습니다.');
      });
    };

    const manualGcBtn = modal.querySelector('#cm-btn-manual-gc');
    if (manualGcBtn) {
      manualGcBtn.onclick = () => {
        manualGcBtn.textContent = '⏳ 최적화 정리 중…';
        manualGcBtn.disabled = true;
        chrome.runtime.sendMessage({ type: 'RUN_STORAGE_CLEANUP' }, res => {
          manualGcBtn.textContent = '🧹 지금 즉시 데이터 청소 & 압축';
          manualGcBtn.disabled = false;
          if (res && res.success) {
            loadSettingsTab(id(), modal);
            alert(`저장소 최적화 완료!\n• 정리된 불량/임시 키: ${res.removedKeysCount}개\n• 자동 압축된 그래프: ${res.compactedCount}개\n• 현재 사용량: ${res.kb}`);
          }
        });
      };
    }

    const resetStorageBtn = modal.querySelector('#cm-btn-reset-chat-storage');
    if (resetStorageBtn) {
      resetStorageBtn.onclick = () => {
        const currentId = id();
        if (!confirm('현재 대화방의 모든 기억 그래프, 요약 카드, 현재 상태를 완전히 초기화하시겠습니까? (이 작업은 되돌릴 수 없습니다)')) return;
        chrome.runtime.sendMessage({ type: 'RESET_CHAT_MEMORY', chatId: currentId }, res => {
          if (res && res.success) {
            loadSettingsTab(currentId, modal);
            refreshDockLabels();
            alert('현재 대화방의 기억 데이터가 완전히 초기화되었습니다.');
          }
        });
      };
    }

    // 8. Export Actions
    modal.querySelector('#cm-btn-export-txt').onclick = () => performExport('txt', modal);
    modal.querySelector('#cm-btn-export-md').onclick = () => performExport('md', modal);
    modal.querySelector('#cm-btn-export-copy').onclick = () => performExport('copy', modal);
  }

  // --- Preset Manager Helper ---
  function setupPresetManager(opts) {
    const { storageKey, selectEl, nameInputEl, newBtn, renameBtn, overwriteBtn, delBtn, defaultName, getFields, setFields } = opts;
    if (!selectEl || !newBtn || !overwriteBtn || !delBtn) return;

    function refresh() {
      chrome.storage.local.get([storageKey], res => {
        const presets = res[storageKey] || [];
        selectEl.innerHTML = '<option value="">-- 프리셋 선택 --</option>';
        presets.forEach((p, idx) => {
          const opt = document.createElement('option');
          opt.value = String(idx);
          opt.textContent = p.name || `프리셋 ${idx + 1}`;
          selectEl.appendChild(opt);
        });
      });
    }

    selectEl.onchange = () => {
      const idx = selectEl.value;
      if (!idx) {
        if (nameInputEl) nameInputEl.value = '';
        return;
      }
      chrome.storage.local.get([storageKey], res => {
        const presets = res[storageKey] || [];
        const p = presets[Number(idx)];
        if (p) {
          if (nameInputEl) nameInputEl.value = p.name || '';
          setFields(p);
        }
      });
    };

    newBtn.onclick = () => {
      let name = (nameInputEl ? nameInputEl.value.trim() : '');
      if (!name) {
        name = prompt('새 프리셋 이름을 입력하세요:', defaultName || '새 프리셋');
      }
      if (!name) {
        alert('프리셋 이름을 입력해주세요.');
        return;
      }
      const data = getFields();
      chrome.storage.local.get([storageKey], res => {
        const presets = res[storageKey] || [];
        presets.push({ name, ...data });
        chrome.storage.local.set({ [storageKey]: presets }, () => {
          refresh();
          if (nameInputEl) nameInputEl.value = name;
          alert(`'${name}' 프리셋이 저장되었습니다.`);
        });
      });
    };

    if (renameBtn) {
      renameBtn.onclick = () => {
        const idx = selectEl.value;
        if (!idx) { alert('이름을 변경할 프리셋을 먼저 목록에서 선택하세요.'); return; }
        const newName = (nameInputEl ? nameInputEl.value.trim() : '') || prompt('새 프리셋 이름을 입력하세요:');
        if (!newName) { alert('프리셋 이름을 입력해주세요.'); return; }
        chrome.storage.local.get([storageKey], res => {
          const presets = res[storageKey] || [];
          const i = Number(idx);
          if (presets[i]) {
            presets[i].name = newName;
            chrome.storage.local.set({ [storageKey]: presets }, () => {
              refresh();
              alert(`프리셋 이름이 '${newName}'(으)로 변경되었습니다.`);
            });
          }
        });
      };
    }

    overwriteBtn.onclick = () => {
      const idx = selectEl.value;
      if (!idx) { alert('덮어쓸 프리셋을 먼저 선택하세요.'); return; }
      if (!confirm('선택된 프리셋 내용을 현재 입력한 내용으로 덮어쓰시겠습니까?')) return;
      const data = getFields();
      chrome.storage.local.get([storageKey], res => {
        const presets = res[storageKey] || [];
        const i = Number(idx);
        if (presets[i]) {
          const customName = nameInputEl ? nameInputEl.value.trim() : '';
          presets[i] = { name: customName || presets[i].name, ...data };
          chrome.storage.local.set({ [storageKey]: presets }, () => {
            refresh();
            alert('프리셋에 덮어쓰기 완료되었습니다.');
          });
        }
      });
    };

    delBtn.onclick = () => {
      const idx = selectEl.value;
      if (!idx) { alert('삭제할 프리셋을 먼저 선택하세요.'); return; }
      if (!confirm('정말 선택된 프리셋을 삭제하시겠습니까?')) return;
      chrome.storage.local.get([storageKey], res => {
        let presets = res[storageKey] || [];
        presets.splice(Number(idx), 1);
        chrome.storage.local.set({ [storageKey]: presets }, () => {
          refresh();
          if (nameInputEl) nameInputEl.value = '';
          alert('프리셋이 삭제되었습니다.');
        });
      });
    };

    refresh();
  }

  // --- Export Chat Logic ---
  function downloadTextFile(filename, content) {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 250);
  }

  function domExtractChat(opts = {}) {
    const o = Object.assign(
      { roleLabels: true, includeInfo: true, userName: '유저', aiName: 'AI' },
      opts
    );
    const groupsSel = '[data-message-group-id]';
    const seen = new Set();
    const groups = [...document.querySelectorAll(groupsSel)].filter(g => {
      const gid = g.getAttribute('data-message-group-id');
      if (seen.has(gid)) return false;
      seen.add(gid);
      return true;
    });

    const reversed = !!(groups[0] && groups[0].closest('.flex-col-reverse'));
    if (reversed) groups.reverse();

    const turns = [];
    for (const g of groups) {
      const mds = [...g.querySelectorAll('.wrtn-markdown')].filter(m => !m.parentElement.closest('.wrtn-markdown'));
      if (!mds.length) continue;
      const auto = mds[0].closest('.w-auto');
      const isUser = !!auto && g.contains(auto);

      let text = mds.map(m => m.innerText || m.textContent || '').join('\n\n');
      text = text.replace(/<!--CRACK_UBIS_CONTEXT_START[\s\S]*?CRACK_UBIS_CONTEXT_END-->/g, '').trim();
      if (!o.includeInfo) {
        text = text.replace(/```(?:INFO)?[^`]*```/g, '').replace(/\[(?:💼|🤝|📝)[^\]\n]*\][^\n]*/g, '').trim();
      }
      if (!text) continue;
      turns.push({
        role: isUser ? 'user' : 'ai',
        name: isUser ? o.userName : o.aiName,
        text
      });
    }

    const title = document.title.replace(/\s*\|\s*크랙\s*$/, '').trim() || '크랙 대화';
    const now = new Date();
    const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const header = `# ${title}\n# DOM 추출 일시: ${stamp} · 총 ${turns.length}개 메시지\n`;

    const txtBody = turns.map(t => (o.roleLabels ? `[${t.name}]\n` : '') + t.text).join('\n\n────────────────\n\n');
    const mdBody = turns.map(t => (o.roleLabels ? `### ${t.name}\n` : '') + t.text).join('\n\n---\n\n');

    return {
      success: true,
      title,
      count: turns.length,
      txt: `${header}\n${txtBody}\n`,
      md: `${header}\n${mdBody}\n`
    };
  }

  function performExport(format, modal) {
    const statusEl = modal.querySelector('#cm-export-status');
    const previewEl = modal.querySelector('#cm-export-preview');
    const previewInfo = modal.querySelector('#cm-export-preview-info');
    statusEl.textContent = '추출 진행 중…';

    const id = chatId();
    const title = document.title.replace(/\s*\|\s*크랙\s*$/, '').trim() || '크랙 대화';
    const userName = modal.querySelector('#cm-export-username').value.trim() || '유저';
    const aiName = modal.querySelector('#cm-export-ainame').value.trim() || 'AI';
    const roleLabels = modal.querySelector('#cm-export-rolelabels').checked;
    const includeInfo = modal.querySelector('#cm-export-includeinfo').checked;
    const useDom = modal.querySelector('#cm-export-use-dom').checked;

    const opts = { userName, aiName, roleLabels, includeInfo, title };

    const handleResult = (res) => {
      if (!res || !res.success || !res.count) {
        statusEl.textContent = '추출 실패';
        alert('대화를 추출하지 못했습니다.');
        return;
      }

      statusEl.textContent = `추출 완료 (${res.count}개 메시지)`;
      previewInfo.textContent = `${res.count}개 턴`;
      const content = format === 'md' ? res.md : res.txt;
      previewEl.textContent = content.slice(0, 1500) + (content.length > 1500 ? '\n\n... (이하 생략)' : '');

      const d = new Date();
      const safeTitle = (res.title || title).replace(/[\\/:*?"<>|]/g, '_').slice(0, 60);
      const timeStr = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}_${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}`;

      if (format === 'copy') {
        navigator.clipboard.writeText(content).then(() => {
          alert(`총 ${res.count}개 메시지가 클립보드에 복사되었습니다!`);
        });
      } else {
        const ext = format === 'md' ? 'md' : 'txt';
        const filename = `${safeTitle}_${timeStr}.${ext}`;
        downloadTextFile(filename, content);
      }
    };

    if (useDom) {
      const res = domExtractChat(opts);
      handleResult(res);
    } else {
      chrome.runtime.sendMessage({
        type: 'EXPORT_CHAT_FULL',
        chatId: id,
        opts
      }, res => {
        if (!res || !res.success) {
          const domRes = domExtractChat(opts);
          if (domRes && domRes.count) {
            handleResult(domRes);
          } else {
            statusEl.textContent = '추출 실패';
            alert(res?.error || '대화 추출에 실패했습니다.');
          }
        } else {
          handleResult(res);
        }
      });
    }
  }

  // --- Initializer & Observers ---
  function loop() {
    const id = chatId();
    if (id && id !== currentChatId) {
      currentChatId = id;
      currentDeckFilter = 'all';
      document.getElementById('cm-master-modal')?.classList.remove('open');
      stagedPrompt = '';
      clearTimeout(typingTimer);
      window.postMessage({ type: 'CRACK_MATRIX_CLEAR_STAGE' }, '*');
      const preview = document.getElementById('cm-composer-preview-text');
      const previewStatus = document.getElementById('cm-composer-preview-status');
      if (preview) preview.value = '새 대화의 입력을 기다리는 중입니다.';
      if (previewStatus) previewStatus.textContent = '';
      analysisTasks.clear();
      nanoError = '';
      updateAnalysisProgress();
      refreshDockLabels();
      const progressId = startAnalysis('sync', '대화 기록 불러오는 중');
      chrome.runtime.sendMessage({ type: 'SYNC_CHAT', chatId: id, progressId }, () => {
        if (chatId() !== id) return;
        finishAnalysis('sync');
      });
    } else if (!id && currentChatId) {
      currentChatId = '';
      document.getElementById('cm-master-modal')?.classList.remove('open');
      stagedPrompt = '';
      window.postMessage({ type: 'CRACK_MATRIX_CLEAR_STAGE' }, '*');
      analysisTasks.clear();
      updateAnalysisProgress();
      const preview = document.getElementById('cm-composer-preview-text');
      if (preview) preview.value = '대화방을 선택하면 전송 프롬프트가 표시됩니다.';
    }

    mountComposerUI();
    maskInjectedMessages();
    preloadImages();
  }

  function init() {
    applyClientViewSettings();
    loop();

    setInterval(loop, 1200);

    new MutationObserver(() => {
      mountComposerUI();
      maskInjectedMessages();
      scheduleNativeBadges();
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
