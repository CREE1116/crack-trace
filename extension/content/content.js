// Trace - Comprehensive Client Controller (Manifest V3)
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
    // The branch notice lives on the memory chip (and the memory tab), which the memory job's
    // progress does not overwrite.
    if (msg?.type === 'BRANCH_CARRIED' && msg.chatId === chatId()) {
      refreshDockLabels();
      return;
    }
    if (msg?.type === 'GET_EDITOR_DRAFT') {
      sendResponse({ chatId: chatId(), draft: attachedEditor?.innerText?.trim() || '' });
      return;
    }
    if (!['ANALYSIS_PROGRESS', 'ANALYSIS_DONE'].includes(msg?.type) || msg.chatId !== chatId()) return;
    if (msg.type === 'ANALYSIS_DONE') {
      if (analysisTasks.get(msg.key)?.id === msg.progressId) finishAnalysis(msg.key, !msg.pending && !msg.error);
      if (msg.key === 'nano') {
        nanoError = String(msg.error || '');
        if (nanoError) setMemoryButton('error', '기억 멈춤', `${nanoError}\n누르면 다시 시도합니다.`);
        else if (msg.stopped) setMemoryButton('idle', `기억 ${msg.done}/${msg.total} · 중지됨`, '누르면 이어서 읽습니다.');
        else if (msg.pending) setMemoryButton('idle', `기억 ${msg.done}/${msg.total} · 대기`, '다음 묶음이 차면 이어서 읽습니다. 누르면 바로 처리합니다.');
        else setMemoryButton('idle', '기억 갱신', '모든 대화를 읽었습니다.');
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
      setMemoryButton('running', `기억 ${msg.done}/${msg.total}`, '읽는 중입니다. 누르면 중지합니다.');
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
  // Reading fonts are loaded as web fonts; a family name alone only works when installed locally.
  const googleFont = family => `https://fonts.googleapis.com/css2?family=${family}&display=swap`;
  const READING_FONTS = {
    default: { label: '크랙 기본 글꼴', family: '' },
    pretendard: { label: 'Pretendard (고딕)', family: '"Pretendard", system-ui, sans-serif', css: 'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css' },
    notosans: { label: '본고딕 · Noto Sans KR', family: '"Noto Sans KR", sans-serif', css: googleFont('Noto+Sans+KR:wght@400;500;700') },
    ibmplex: { label: 'IBM Plex Sans KR (고딕)', family: '"IBM Plex Sans KR", sans-serif', css: googleFont('IBM+Plex+Sans+KR:wght@400;500;700') },
    gowundodum: { label: '고운돋움', family: '"Gowun Dodum", sans-serif', css: googleFont('Gowun+Dodum') },
    maruburi: { label: '마루부리 (소설 추천)', family: '"MaruBuri", serif', css: 'https://hangeul.pstatic.net/hangeul_static/css/maru-buri.css' },
    notoserif: { label: '본명조 · Noto Serif KR', family: '"Noto Serif KR", serif', css: googleFont('Noto+Serif+KR:wght@400;500;700') },
    myeongjo: { label: '나눔명조', family: '"Nanum Myeongjo", "NanumMyeongjo", serif', css: googleFont('Nanum+Myeongjo:wght@400;700') },
    gowunbatang: { label: '고운바탕', family: '"Gowun Batang", serif', css: googleFont('Gowun+Batang:wght@400;700') },
    hahmlet: { label: '함렛', family: '"Hahmlet", serif', css: googleFont('Hahmlet:wght@400;500;700') },
    kopub: { label: 'KoPub바탕 (PC에 설치된 경우)', family: '"KoPubWorldBatang", "KoPubBatang", serif' },
    pen: { label: '나눔손글씨 펜', family: '"Nanum Pen Script", cursive', css: googleFont('Nanum+Pen+Script') },
    custom: { label: '직접 입력…', family: '' }
  };
  const DEFAULT_VIEW = { width: 'normal', customWidth: 980, font: 'default', fontSize: '15', lineHeight: '1.65',
    fontWeight: '', letterSpacing: '0', paragraphGap: '', customFont: '', customFontCss: '', perfOpt: true, imagePreload: true };

  function loadFontCss(url) {
    if (!/^https:\/\//.test(url || '')) return;
    if ([...document.querySelectorAll('link[data-cm-font-css]')].some(link => link.href === url)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = url;
    link.dataset.cmFontCss = '1';
    link.onerror = () => console.warn('[Trace] 글꼴을 불러오지 못했습니다:', url);
    document.head.append(link);
  }

  function applyViewSettings(saved) {
    const s = { ...DEFAULT_VIEW, ...(saved || {}) };
    const body = document.body;
    // Only the "custom" preset uses the slider width; the other presets have their own CSS widths.
    if (s.width === 'custom') {
      body.dataset.cmCustomWidth = 'true';
      body.removeAttribute('data-cm-width');
      body.style.setProperty('--cm-chat-width', `${s.customWidth || 980}px`);
    } else {
      body.removeAttribute('data-cm-custom-width');
      body.dataset.cmWidth = s.width || 'normal';
    }

    const font = READING_FONTS[s.font] || READING_FONTS.default;
    const family = s.font === 'custom'
      ? (s.customFont ? `"${String(s.customFont).replace(/["\\]/g, '')}", sans-serif` : '')
      : font.family;
    loadFontCss(s.font === 'custom' ? s.customFontCss : font.css);
    body.dataset.cmFont = family ? 'on' : 'default';
    body.style.setProperty('--cm-reading-font', family || 'inherit');
    body.dataset.cmFontWeight = s.fontWeight ? 'on' : '';
    body.style.setProperty('--cm-font-weight', s.fontWeight || 'inherit');
    body.style.setProperty('--cm-letter-spacing', Number(s.letterSpacing) ? `${s.letterSpacing}em` : 'normal');
    body.dataset.cmParagraphGap = s.paragraphGap ? 'on' : '';
    body.style.setProperty('--cm-paragraph-gap', s.paragraphGap ? `${s.paragraphGap}em` : '0');
    body.dataset.cmPerf = s.perfOpt ? 'true' : 'false';
    body.style.setProperty('--cm-font-size', `${s.fontSize || 15}px`);
    body.style.setProperty('--cm-line-height', s.lineHeight || '1.65');
    if (s.imagePreload) preloadImages();
  }

  function updateFontPreview(modal) {
    const preview = modal.querySelector('#cm-font-preview');
    if (!preview) return;
    const style = getComputedStyle(document.body);
    preview.style.fontFamily = style.getPropertyValue('--cm-reading-font').trim() || 'inherit';
    preview.style.fontSize = style.getPropertyValue('--cm-font-size').trim();
    preview.style.lineHeight = style.getPropertyValue('--cm-line-height').trim();
    preview.style.letterSpacing = style.getPropertyValue('--cm-letter-spacing').trim();
    preview.style.fontWeight = style.getPropertyValue('--cm-font-weight').trim();
  }

  function applyClientViewSettings() {
    chrome.storage.local.get(['clientViewSettings'], res => applyViewSettings(res.clientViewSettings));
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
          <button type="button" class="cm-dock-chip" id="cm-dock-memory" title="장기기억 진화 덱">
            <span>🌿</span><span id="cm-dock-memory-count">기억덱</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-usernote" title="유저노트 서술 지침 (순정 분리 전송)">
            <span>📝</span><span id="cm-dock-usernote-name">유저노트</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-lore" title="로어북 키워드·설정 관리">
            <span>📜</span><span id="cm-dock-lore-name">로어북</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-find" aria-expanded="false" aria-controls="cm-find-panel" title="지난 대화에서 찾고 그 대화로 이동">
            <span>🔎</span><span>찾기</span>
          </button>
          <button type="button" class="cm-dock-chip" id="cm-dock-memo" aria-expanded="false" aria-controls="cm-memo-panel" title="자주 쓰는 문구를 눌러 입력창에 넣기">
            <span>🗒️</span><span>메모</span>
          </button>
        </div>
        <div class="cm-dock-actions">
          <span id="cm-dock-counter" class="cm-dock-counter" hidden title="크랙 입력 한도 2,000자 중 내 입력과 붙는 기억의 글자수"></span>
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
      preview.innerHTML = '<div class="cm-composer-preview-header"><strong>이번 전송</strong><span>현재 입력 · 직전 AI 응답 기준</span></div><div class="cm-preview-tabs" role="tablist" aria-label="전송 미리보기"><button type="button" id="cm-preview-selected-tab" role="tab" aria-controls="cm-preview-selected" aria-selected="true">선택 내역</button><button type="button" id="cm-preview-raw-tab" role="tab" aria-controls="cm-preview-raw" aria-selected="false">전송 원문</button></div><div id="cm-preview-selected" role="tabpanel" aria-labelledby="cm-preview-selected-tab"><div id="cm-preview-items" class="cm-preview-items"></div></div><div id="cm-preview-raw" role="tabpanel" aria-labelledby="cm-preview-raw-tab" hidden><textarea id="cm-composer-preview-text" readonly aria-label="실제 전송 프롬프트"></textarea><div class="cm-composer-preview-footer"><span>유저노트는 별도로 전송됩니다.</span><button type="button" id="cm-composer-preview-copy">복사</button></div></div><div id="cm-composer-preview-status" role="status"></div>';
      progress.insertAdjacentElement('afterend', preview);
      preview.insertAdjacentElement('afterend', createMemoPanel());
      preview.insertAdjacentElement('afterend', createFindPanel());
      updateAnalysisProgress();

      dock.querySelector('#cm-dock-memory').onclick = () => openMasterModal('deck');
      dock.querySelector('#cm-dock-usernote').onclick = () => openMasterModal('usernote');
      dock.querySelector('#cm-dock-lore').onclick = () => openMasterModal('lore');
      dock.querySelector('#cm-dock-btn-preview').onclick = () => {
        if (toggleDockPanel('cm-composer-preview')) handleTyping(attachedEditor?.innerText || '');
      };
      dock.querySelector('#cm-dock-find').onclick = () => {
        if (toggleDockPanel('cm-find-panel')) document.getElementById('cm-find-input')?.select();
      };
      dock.querySelector('#cm-dock-memo').onclick = () => {
        if (toggleDockPanel('cm-memo-panel')) renderMemos();
      };
      dock.querySelector('#cm-dock-btn-summarize').onclick = triggerSummarization;
      preview.querySelector('#cm-composer-preview-copy').onclick = () => {
        navigator.clipboard.writeText(preview.querySelector('textarea').value);
      };
      for (const [tabId, panelId] of [['cm-preview-selected-tab', 'cm-preview-selected'], ['cm-preview-raw-tab', 'cm-preview-raw']]) {
        preview.querySelector(`#${tabId}`).onclick = () => {
          for (const [otherTabId, otherPanelId] of [['cm-preview-selected-tab', 'cm-preview-selected'], ['cm-preview-raw-tab', 'cm-preview-raw']]) {
            const active = otherTabId === tabId;
            preview.querySelector(`#${otherTabId}`).setAttribute('aria-selected', String(active));
            preview.querySelector(`#${otherPanelId}`).hidden = !active;
          }
        };
      }

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
        scheduleDeckRender(id, modal);
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
      `usernote:${id}`,
      'usernote:global',
      `usernoteEnabled:${id}`,
      `branchOf:${id}`,
      `summary:${id}`,
      `lore:${id}`,
      `nanoMemory:${id}`,
      'llmIntervention'
    ], res => {
      if (chatId() !== id) return;


      const un = res[`usernoteEnabled:${id}`] !== false && (res[`usernote:${id}`] || res['usernote:global']);
      const unEl = document.getElementById('cm-dock-usernote-name');
      if (unEl) unEl.textContent = un ? '유저노트 On' : '유저노트';

      const sumEl = document.getElementById('cm-dock-memory-count');
      if (sumEl) {
        const branch = res[`branchOf:${id}`];
        chrome.runtime.sendMessage({ type: 'GET_NANO_FACTS', chatId: id }, reply => {
          if (chatId() !== id || !sumEl.isConnected) return;
          const count = reply?.facts?.length || 0;
          sumEl.textContent = `${count ? `기억 ${count}건` : (nanoError ? '기억 확인 필요' : '기억 대기')}${branch ? ' · 분기' : ''}`;
        });
        sumEl.parentElement.title = nanoError || (branch
          ? `분기된 대화예요. 원본 대화의 ${branch.turns}번째 턴까지 같아서, 그때까지의 기억 ${branch.facts}건과 고정·로어·유저노트를 가져왔어요.`
          : '이 대화방의 장기 기억');
      }

      const lores = res[`lore:${id}`] || [];
      const loreEl = document.getElementById('cm-dock-lore-name');
      if (loreEl) loreEl.textContent = lores.length ? `로어 ${lores.length}건` : '로어북';

      scheduleNativeBadges();
    });
  }

  // idle: ready · running: reading (click stops) · stopping · error
  function setMemoryButton(state, label, title = '') {
    const btn = document.getElementById('cm-dock-btn-summarize');
    const text = document.getElementById('cm-dock-sum-text');
    if (!btn || !text) return;
    btn.dataset.state = state;
    btn.classList.toggle('running', state === 'running' || state === 'stopping');
    btn.classList.toggle('error', state === 'error');
    text.textContent = state === 'running' ? `${label} · 중지` : label;
    btn.title = title;
  }

  function triggerSummarization() {
    const id = chatId();
    if (!id) { alert('대화방 ID를 찾을 수 없습니다.'); return; }

    const btn = document.getElementById('cm-dock-btn-summarize');
    if (!btn || btn.classList.contains('loading')) return;

    // One memory job for both modes (LLM or rules); pressing again while it runs stops it.
    {
      if (btn.dataset.state === 'stopping') return;
      if (btn.dataset.state === 'running') {
        setMemoryButton('stopping', '중지하는 중…', '지금 읽는 묶음까지 저장하고 멈춥니다.');
        chrome.runtime.sendMessage({ type: 'STOP_NANO_MEMORY', chatId: id }, result => {
          if (!result?.running) setMemoryButton('idle', '기억 갱신');
        });
        return;
      }
      setMemoryButton('running', '기억 갱신 시작', '읽는 중입니다. 누르면 중지합니다.');
      chrome.runtime.sendMessage({ type: 'START_NANO_MEMORY', chatId: id, force: true }, result => {
        if (!result?.success) setMemoryButton('error', '기억 멈춤', result?.error || '기억 갱신을 시작하지 못했습니다.');
      });
      return;
    }
  }

  // --- 3. Typing & Pre-Staging for 0ms WebSocket Injection ---
  let previewResult = null;
  const excludedPreviewLines = new Set();
  const previewKey = item => `${item.type || ''}\u0000${item.line || ''}`;

  function selectedForSend(res, draft) {
    if (!res?.success) return { selected: [], content: draft };
    if (res.content === draft) return { selected: [], content: draft };
    // The same draft even when Crack sends its line breaks or spaces differently.
    const same = value => String(value || '').replace(/\s+/g, ' ').trim();
    const excluded = same(stagedPrompt) === same(draft) ? excludedPreviewLines : new Set();
    if (!excluded.size) return { selected: res.selected || [], content: res.content || draft };
    const selected = (res.selected || []).filter(item => !excluded.has(previewKey(item)));
    const content = CrackMatrixEngine.composeUser(draft, selected, 2000, res.currentTurn);
    return content === draft ? { selected: [], content } : { selected, content };
  }

  function renderPreviewItems(res, draft) {
    const list = document.getElementById('cm-preview-items');
    if (!list) return;
    list.replaceChildren();
    const items = res?.success && res.content !== draft ? res.selected || [] : [];
    if (!items.length) {
      list.textContent = draft ? '이번 입력에 추가할 기억이나 로어가 없습니다.' : '입력창에 메시지를 쓰면 선택 내역이 표시됩니다.';
      return;
    }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'cm-preview-item';
      const label = document.createElement('label');
      label.className = 'cm-preview-item-label';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = !excludedPreviewLines.has(previewKey(item));
      checkbox.setAttribute('aria-label', `${item.title || '기억'} 이번 전송에 포함`);
      checkbox.onchange = () => {
        if (checkbox.checked) excludedPreviewLines.delete(previewKey(item));
        else excludedPreviewLines.add(previewKey(item));
        if (previewResult && stagedPrompt === draft) renderPreparedPreview(previewResult, draft);
      };
      const heading = document.createElement('span');
      heading.textContent = `${item.type === 'lore' ? '로어' : item.type === 'passage' ? '원문' : '기억'} · ${item.title || '과거 대화'}`;
      label.append(checkbox, heading);
      const reason = document.createElement('span');
      reason.className = 'cm-preview-item-reason';
      reason.textContent = item.why || '';
      row.append(label, reason);
      const body = document.createElement('p');
      body.textContent = item.content || item.text || item.line || '';
      row.append(body);
      if (Number(item.turn) > 0) {
        const source = document.createElement('button');
        source.type = 'button';
        source.className = 'cm-preview-source';
        source.textContent = `대화 ${item.turn} 보기`;
        source.onclick = () => jumpToTurn(item.turn);
        row.append(source);
      }
      list.append(row);
    }
  }

  function renderPreparedPreview(res, draft) {
    const prepared = selectedForSend(res, draft);
    updateCounter(draft.length, prepared.content.length);
    updateStatusUI({ userNoteCount: res.userNote ? 1 : 0,
      memoryCount: prepared.selected.filter(item => item.type === 'passage').length,
      summaryCount: prepared.selected.filter(item => item.type !== 'passage' && item.type !== 'lore').length });
    renderPreviewItems(res, draft);
    const preview = document.getElementById('cm-composer-preview-text');
    if (preview) preview.value = prepared.content;
    const status = document.getElementById('cm-composer-preview-status');
    if (status) status.textContent = prepared.selected.length
      ? `주입 ${prepared.selected.length}건 · ${res.mode === 'nano' ? 'LLM 기억' : '원문 검색'}${res.semantic ? ' · 의미 검색' : ''}`
      : `주입 없음 · ${excludedPreviewLines.size ? '이번 전송에서 제외됨' : res.reason || '관련 기억 없음'}`;
    chrome.runtime.sendMessage({ type: 'LIVE_PROMPT_PREVIEW', target: 'sidepanel', chatId: chatId(),
      draft, items: prepared.selected }).catch(() => {});
    window.postMessage({ type: 'CRACK_MATRIX_STAGE_PAYLOAD', originalPrompt: draft, chatId: chatId(),
      injectedContent: prepared.content, injectedCount: prepared.selected.length }, '*');
  }

  function handleTyping(text) {
    const id = chatId();
    const cleanPrompt = text.trim();
    if (!id) return;

    if (stagedPrompt !== cleanPrompt) {
      excludedPreviewLines.clear();
      previewResult = null;
    }
    stagedPrompt = cleanPrompt;
    updateCounter(cleanPrompt.length, cleanPrompt.length);
    const preview = document.getElementById('cm-composer-preview-text');
    const previewStatus = document.getElementById('cm-composer-preview-status');
    if (preview && !cleanPrompt) preview.value = '입력창에 메시지를 쓰면 전송할 프롬프트가 표시됩니다.';
    if (previewStatus && !cleanPrompt) previewStatus.textContent = '';
    if (!cleanPrompt) {
      renderPreviewItems(null, '');
      window.postMessage({ type: 'CRACK_MATRIX_CLEAR_STAGE' }, '*');
      chrome.runtime.sendMessage({ type: 'LIVE_PROMPT_PREVIEW', target: 'sidepanel', chatId: id,
        draft: '', items: [] }).catch(() => {});
      updateStatusUI({ userNoteCount: 0, memoryCount: 0, summaryCount: 0 });
    }

    if (cleanPrompt) {
      chrome.runtime.sendMessage({ type: 'GET_PREPARED_CONTEXT', chatId: id, outgoing: cleanPrompt }, res => {
        if (stagedPrompt !== cleanPrompt || chatId() !== id) return;
        if (res?.success && !res.intentReady) scheduleIntent(id, cleanPrompt);
        if (res?.success) {
          previewResult = res;
          renderPreparedPreview(res, cleanPrompt);
        } else {
          previewResult = null;
          renderPreviewItems(null, cleanPrompt);
          if (preview) preview.value = '프롬프트를 준비하지 못했습니다.';
          if (previewStatus) previewStatus.textContent = '프롬프트 준비 오류';
          window.postMessage({ type: 'CRACK_MATRIX_CLEAR_STAGE' }, '*');
        }
      });
    }
  }

  // With an LLM, once typing pauses, ask which remembered subjects the draft refers to; when the
  // answer arrives the prompt is prepared again with it. Sending earlier just uses word matching.
  let intentTimer = 0;
  function scheduleIntent(id, draft) {
    clearTimeout(intentTimer);
    if (draft.length < 4) return;
    intentTimer = setTimeout(() => {
      chrome.runtime.sendMessage({ type: 'LLM_INTENT', chatId: id, draft }, reply => {
        if (chrome.runtime.lastError || !reply?.success || reply.cached) return;
        if (chatId() === id && stagedPrompt === draft) handleTyping(draft);
      });
    }, 1200);
  }

  // Crack rejects messages over 2,000 characters; the memory block shares that limit.
  function updateCounter(inputLength, totalLength) {
    const el = document.getElementById('cm-dock-counter');
    if (!el) return;
    el.hidden = !inputLength;
    if (!inputLength) return;
    const memory = Math.max(0, totalLength - inputLength);
    el.textContent = `입력 ${inputLength.toLocaleString('ko-KR')}${memory ? ` · 기억 ${memory.toLocaleString('ko-KR')}` : ''} / 2,000`;
    el.dataset.level = inputLength > 2000 ? 'over' : inputLength >= 1900 ? 'hot' : inputLength >= 1400 ? 'warn' : 'ok';
    el.title = inputLength > 2000 ? '크랙 입력 한도(2,000자)를 넘었습니다.'
      : inputLength >= 1400 ? '입력이 길수록 붙일 수 있는 기억이 줄어듭니다.'
        : '크랙 입력 한도 2,000자 중 내 입력과 붙는 기억의 글자수';
  }

  function updateStatusUI(res) {
    refreshDockLabels();

    const uChip = document.getElementById('cm-dock-usernote');
    const mChip = document.getElementById('cm-dock-memory');

    if (uChip) uChip.classList.toggle('active', (res.userNoteCount || 0) > 0);
    if (mChip) mChip.classList.toggle('active', (res.memoryCount || 0) > 0 || (res.summaryCount || 0) > 0);
  }

  // --- 4. Chat Bubble 100% Zero-Trace Masking ---
  // Current and legacy markers of the injected memory block.
  const OWN_MARKERS = CrackMatrixEngine.MARKERS;
  const OWN_BLOCK_RE = /<!--(?:TRACE|CRACK_UBIS_CONTEXT_START)-->[\s\S]*?<!--(?:\/TRACE|CRACK_UBIS_CONTEXT_END)-->/g;

  function maskInjectedMessages() {
    for (const [startTag, endTag] of OWN_MARKERS) maskInjectedBlocks(startTag, endTag);
  }

  function maskInjectedBlocks(startTag, endTag) {

    // Only bubbles that still show the marker are searched; scanning every div on
    // each DOM mutation made long chats stutter while replies streamed in.
    const bubbles = [...document.querySelectorAll('.wrtn-markdown')].filter(md =>
      !md.parentElement?.closest('.wrtn-markdown') && (md.textContent || '').includes(startTag));
    const candidates = bubbles.length
      ? bubbles.flatMap(md => [md, ...md.querySelectorAll('p, div')])
      : (document.querySelector('.wrtn-markdown') ? [] : document.querySelectorAll('[data-message-group-id], p, div'));
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
    // The message went out differently from what was prepared (sent right after typing, or
    // Crack wrote it out differently): prepare that exact text now; the page waits briefly.
    if (e.source === window && e.data?.type === 'CRACK_MATRIX_PREPARE_NOW') {
      const { requestId, chatId: room, text } = e.data;
      const reply = result => window.postMessage({ type: 'CRACK_MATRIX_PREPARED', requestId, ...result }, '*');
      if (!room || room !== chatId()) { reply({ ok: false }); return; }
      chrome.runtime.sendMessage({ type: 'GET_PREPARED_CONTEXT', chatId: room, outgoing: String(text || '') })
        .then(res => {
          if (!res?.success) { reply({ ok: false }); return; }
          const prepared = selectedForSend(res, String(text || ''));
          reply({ ok: true, content: prepared.content, injectedCount: prepared.selected.length });
        })
        .catch(() => reply({ ok: false }));
    }
    if (e.source === window && e.data?.type === 'CRACK_MATRIX_SENT_WITHOUT_MEMORY') showSendNotice();
  });

  // Shown when a message had to go out before its memory was ready.
  function showSendNotice() {
    const dock = document.getElementById('cm-composer-dock');
    if (!dock) return;
    let notice = document.getElementById('cm-send-notice');
    if (!notice) {
      notice = document.createElement('div');
      notice.id = 'cm-send-notice';
      notice.className = 'cm-send-notice';
      notice.setAttribute('role', 'status');
      dock.insertAdjacentElement('afterend', notice);
    }
    notice.textContent = '이번 메시지는 기억 준비가 늦어 기억 없이 보냈어요.';
    notice.hidden = false;
    clearTimeout(showSendNotice.timer);
    showSendNotice.timer = setTimeout(() => { notice.hidden = true; }, 6000);
  }

  // --- Bubble tools: turn number + pin ---
  // Each chat bubble gets "#턴" and a 📌 button. The service worker maps a bubble
  // to its turn by matching the bubble text against the synced history.
  const bubbleTurns = new Map();
  let bubbleToolsTimer = 0;
  let bubbleToolsBusy = false;

  function scheduleBubbleTools() {
    clearTimeout(bubbleToolsTimer);
    bubbleToolsTimer = setTimeout(mountBubbleTools, 400);
  }

  function bubbleGroups() {
    const seen = new Set();
    return [...document.querySelectorAll('[data-message-group-id]')].filter(group => {
      const gid = group.getAttribute('data-message-group-id');
      if (!gid || seen.has(gid) || group.parentElement?.closest('[data-message-group-id]')) return false;
      seen.add(gid);
      return true;
    });
  }

  function bubbleText(group) {
    return [...group.querySelectorAll('.wrtn-markdown')].filter(md => !md.parentElement.closest('.wrtn-markdown'))
      .map(md => md.innerText || md.textContent || '').join('\n')
      .replace(OWN_BLOCK_RE, '').trim();
  }

  async function mountBubbleTools() {
    const id = chatId();
    if (!id || bubbleToolsBusy) return;
    const pending = bubbleGroups().filter(group => !group.querySelector(':scope .cm-bubble-tools'));
    const items = pending.map(group => ({ group, gid: group.getAttribute('data-message-group-id') || '', text: bubbleText(group) }))
      .filter(item => item.text);
    if (!items.length) return;
    bubbleToolsBusy = true;
    try {
      // data-message-group-id is the message id; text is the fallback while a reroll comparison is shown.
      const res = await chrome.runtime.sendMessage({ type: 'LOCATE_TURNS', chatId: id,
        items: items.map(item => ({ id: item.gid, text: item.text.slice(0, 200) })) });
      if (chatId() !== id || !res?.success) return;
      const pinned = new Set(((await chrome.storage.local.get(`pins:${id}`))[`pins:${id}`] || []).map(pin => pin.messageId));
      items.forEach((item, index) => {
        const hit = res.turns[index];
        if (!hit || item.group.querySelector(':scope .cm-bubble-tools')) return;
        bubbleTurns.set(hit.turn, item.group);
        const tools = document.createElement('div');
        tools.className = 'cm-bubble-tools';
        tools.dataset.messageId = hit.messageId;
        const turn = document.createElement('span');
        turn.textContent = `#${hit.turn}`;
        const pin = document.createElement('button');
        pin.type = 'button';
        pin.className = 'cm-bubble-pin';
        pin.classList.toggle('active', pinned.has(hit.messageId));
        pin.textContent = '📌';
        pin.title = pinned.has(hit.messageId) ? '고정 해제' : '이 대화를 기억에 고정 (항상 먼저 주입)';
        pin.onclick = async event => {
          event.stopPropagation();
          const result = await chrome.runtime.sendMessage({ type: 'TOGGLE_PIN', chatId: id, messageId: hit.messageId });
          if (!result?.success) { pin.title = result?.error || '고정하지 못했습니다.'; return; }
          pin.classList.toggle('active', result.pinned);
          pin.title = result.pinned ? '고정 해제' : '이 대화를 기억에 고정 (항상 먼저 주입)';
        };
        tools.append(turn, pin);
        // Sit left of Crack's own "메시지 옵션" button when it exists, like the native toolbar items.
        const option = item.group.querySelector('button[aria-label="메시지 옵션"]');
        const anchor = option?.closest('.dropdown-button') || option;
        if (anchor?.parentElement) {
          tools.classList.add('in-toolbar');
          anchor.parentElement.insertBefore(tools, anchor);
        } else {
          const mds = [...item.group.querySelectorAll('.wrtn-markdown')].filter(md => !md.parentElement.closest('.wrtn-markdown'));
          (mds.at(-1)?.parentElement || item.group).append(tools);
        }
      });
    } catch {
      // The service worker may be restarting; the next DOM change retries.
    } finally {
      bubbleToolsBusy = false;
    }
  }

  function findGroupById(messageId) {
    return messageId ? document.querySelector(`[data-message-group-id="${CSS.escape(messageId)}"]`) : null;
  }

  function chatScroller() {
    let el = document.querySelector('[data-message-group-id]')?.parentElement;
    while (el && el !== document.body) {
      const style = getComputedStyle(el);
      if (/(auto|scroll)/.test(style.overflowY) && el.scrollHeight > el.clientHeight) return el;
      el = el.parentElement;
    }
    return document.scrollingElement;
  }

  function flashGroup(group) {
    document.getElementById('cm-master-modal')?.classList.remove('open');
    group.scrollIntoView({ behavior: 'smooth', block: 'center' });
    group.classList.add('cm-bubble-flash');
    setTimeout(() => group.classList.remove('cm-bubble-flash'), 1600);
  }

  function showTurnText(turn, text) {
    document.getElementById('cm-turn-peek')?.remove();
    const box = document.createElement('div');
    box.id = 'cm-turn-peek';
    box.className = 'cm-turn-peek';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-label', `대화 ${turn} 원문`);
    const head = document.createElement('div');
    head.className = 'cm-turn-peek-head';
    const title = document.createElement('strong');
    title.textContent = `대화 ${turn} 원문`;
    const close = document.createElement('button');
    close.type = 'button';
    close.textContent = '닫기';
    close.onclick = () => box.remove();
    head.append(title, close);
    const body = document.createElement('div');
    body.className = 'cm-turn-peek-body';
    body.textContent = text;
    box.append(head, body);
    box.onkeydown = event => { if (event.key === 'Escape') box.remove(); };
    document.body.append(box);
    close.focus();
  }

  // --- Panels above the input: prompt preview, 찾기, 메모. One is open at a time. ---
  const DOCK_PANELS = { 'cm-composer-preview': 'cm-dock-btn-preview', 'cm-find-panel': 'cm-dock-find', 'cm-memo-panel': 'cm-dock-memo' };
  function toggleDockPanel(panelId) {
    const open = document.getElementById(panelId)?.hidden;
    for (const [id, buttonId] of Object.entries(DOCK_PANELS)) {
      const panel = document.getElementById(id);
      if (!panel) continue;
      panel.hidden = !(open && id === panelId);
      document.getElementById(buttonId)?.setAttribute('aria-expanded', String(!panel.hidden));
    }
    return Boolean(open);
  }
  function closeDockPanelOnEscape(panel) {
    panel.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      toggleDockPanel(panel.id);
      attachedEditor?.focus();
    });
  }

  // 찾기: the service worker searches the whole chat history (not just what Crack has loaded).
  function createFindPanel() {
    const panel = document.createElement('div');
    panel.id = 'cm-find-panel';
    panel.className = 'cm-composer-preview cm-dock-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="cm-composer-preview-header">
        <input type="search" id="cm-find-input" class="cm-find-input" placeholder="지난 대화에서 찾기 (예: 월광검, 8일차)" aria-label="지난 대화에서 찾기" autocomplete="off">
        <span id="cm-find-count" role="status"></span>
      </div>
      <ol id="cm-find-results" class="cm-find-results"></ol>`;
    const input = panel.querySelector('#cm-find-input');
    const count = panel.querySelector('#cm-find-count');
    const list = panel.querySelector('#cm-find-results');
    let timer = 0;
    let serial = 0;
    const run = async () => {
      const query = input.value.trim();
      const mine = ++serial;
      list.replaceChildren();
      if (!query) { count.textContent = ''; return; }
      count.textContent = '찾는 중…';
      const res = await chrome.runtime.sendMessage({ type: 'SEARCH_TURNS', chatId: chatId(), query }).catch(error => ({ success: false, error: String(error.message || error) }));
      if (mine !== serial) return;
      if (!res?.success) { count.textContent = res?.error || '찾지 못했어요'; return; }
      const close = res.results.filter(hit => !hit.exact).length;
      count.textContent = res.total ? `${res.total}곳${res.total > res.results.length - close ? ` 중 ${res.results.length - close}곳 표시` : ''}${close ? ` · 비슷한 곳 ${close}` : ''}`
        : close ? `그대로는 없음 · 비슷한 곳 ${close}` : '없음';
      for (const hit of res.results) {
        const item = document.createElement('li');
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `cm-find-hit${hit.exact ? '' : ' close'}`;
        const turn = document.createElement('span');
        turn.className = 'cm-find-turn';
        turn.textContent = `${hit.turn} ${hit.role === 'user' ? '나' : 'AI'}`;
        const text = document.createElement('span');
        text.className = 'cm-find-text';
        const mark = document.createElement('mark');
        mark.textContent = hit.match;
        text.append(hit.before, ...(hit.match ? [mark] : []), hit.after);
        button.append(turn, text);
        button.title = `대화 ${hit.turn}(으)로 이동`;
        button.onclick = () => jumpToTurn(hit.turn);
        item.append(button);
        list.append(item);
      }
    };
    input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(run, 250); });
    input.addEventListener('keydown', event => { if (event.key === 'Enter') { clearTimeout(timer); run(); } });
    closeDockPanelOnEscape(panel);
    return panel;
  }

  // 메모: saved snippets for Crack's input. Shared by all chats unless marked for this chat.
  // Three ways in: click, Alt+1…Alt+0 for the first ten, or a 대체어 typed and followed by a
  // space (like iPhone text replacement). The text goes in exactly as written.
  const MEMO_KEY = 'memos';
  const MEMO_SLOTS = 10;
  let memoCache = [];
  let editorRange = null;
  const crackEditor = () => attachedEditor?.isConnected ? attachedEditor : document.querySelector('div.__chat_input_textarea[contenteditable="true"]');
  const memosHere = () => memoCache.filter(memo => !memo.chatId || memo.chatId === chatId());
  const slotLabel = index => `Alt+${(index + 1) % 10}`;

  async function readMemos() {
    const list = (await chrome.storage.local.get(MEMO_KEY))[MEMO_KEY];
    memoCache = Array.isArray(list) ? list : [];
    return memoCache;
  }
  async function writeMemos(list) {
    memoCache = list;
    await chrome.storage.local.set({ [MEMO_KEY]: list });
  }
  readMemos();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[MEMO_KEY]) return;
    memoCache = Array.isArray(changes[MEMO_KEY].newValue) ? changes[MEMO_KEY].newValue : [];
    if (!document.getElementById('cm-memo-panel')?.hidden) renderMemos();
  });

  document.addEventListener('selectionchange', () => {
    const selection = window.getSelection();
    if (selection?.rangeCount && attachedEditor?.contains(selection.anchorNode)) editorRange = selection.getRangeAt(0).cloneRange();
  });
  // Replace the current selection in the editor the way typing does: the browser edits its own
  // selection and the page sees ordinary input events. Crack's paste handler inserts at the
  // caret it tracked itself (it ignored a selected 대체어), so a paste is only the fallback.
  function replaceSelection(editor, text) {
    if (document.execCommand('insertText', false, text)) return;
    const data = new DataTransfer();
    data.setData('text/plain', text);
    editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  }
  function insertIntoEditor(text) {
    const editor = crackEditor();
    if (!editor) return false;
    editor.focus();
    const selection = window.getSelection();
    let range = editorRange && editor.contains(editorRange.startContainer) ? editorRange : null;
    if (!range) { range = document.createRange(); range.selectNodeContents(editor); range.collapse(false); }
    selection.removeAllRanges();
    selection.addRange(range);
    replaceSelection(editor, text);
    return true;
  }

  // Alt+1 … Alt+0 (⌥ on Mac) put the first ten memos of this chat at the caret.
  document.addEventListener('keydown', event => {
    if (!event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || event.isComposing) return;
    const digit = /^Digit(\d)$/.exec(event.code)?.[1];
    if (digit === undefined) return;
    const editor = crackEditor();
    const target = event.target;
    // Other text fields (Trace's own editors, Crack's search) keep their keys.
    if (!editor || (target !== editor && !editor.contains(target) && target?.closest?.('input, textarea, [contenteditable="true"]'))) return;
    const memo = memosHere()[(Number(digit) + 9) % 10];
    if (!memo) return;
    event.preventDefault();
    event.stopPropagation();
    insertIntoEditor(memo.text);
  }, true);

  // 대체어: "ㅈㅌ" + space becomes the memo, as long as the word stands on its own.
  // With a Korean IME the space that ends "ㅌ" arrives as part of the composition, so the input
  // event's type cannot be trusted: after a space key or an inserted space, look at the text.
  document.addEventListener('keyup', event => {
    if (event.code === 'Space' || event.key === ' ') scheduleTrigger(event.target);
  }, true);
  document.addEventListener('input', event => {
    if (/^insert/.test(event.inputType || '') && /[\s ]$/.test(event.data || '')) scheduleTrigger(event.target);
  }, true);
  function scheduleTrigger(target) {
    const editor = crackEditor();
    if (!editor || !editor.contains(target) || !memosHere().some(memo => memo.trigger)) return;
    // After the editor has applied the space (and finished the composition) itself.
    setTimeout(() => expandTrigger(editor), 0);
  }
  function expandTrigger(editor) {
    const selection = window.getSelection();
    if (!selection?.rangeCount || !selection.isCollapsed || !editor.contains(selection.anchorNode)) return;
    const triggers = new Map(memosHere().filter(memo => memo.trigger).map(memo => [memo.trigger, memo]));
    // The text of the current line up to the caret, whatever pieces the editor split it into.
    const caret = selection.getRangeAt(0);
    const line = document.createRange();
    const anchor = selection.anchorNode.nodeType === Node.TEXT_NODE ? selection.anchorNode.parentElement : selection.anchorNode;
    const block = anchor?.closest('p, div, li');
    line.setStart(block && editor.contains(block) ? block : editor, 0);
    line.setEnd(caret.startContainer, caret.startOffset);
    const word = /(?:^|[\s ])(\S+)[\s ]$/.exec(line.toString())?.[1];
    const memo = word && triggers.get(word);
    if (!memo) return;
    // Select the word and its space backwards from the caret, across text nodes if needed.
    for (let i = 0; i < word.length + 1; i++) selection.modify('extend', 'backward', 'character');
    if (selection.toString().replace(/ /g, ' ').trimEnd() !== word) { selection.collapseToEnd(); return; }
    replaceSelection(editor, /\s$/.test(memo.text) ? memo.text : `${memo.text} `);
  }

  function createMemoPanel() {
    const panel = document.createElement('div');
    panel.id = 'cm-memo-panel';
    panel.className = 'cm-composer-preview cm-dock-panel';
    panel.hidden = true;
    panel.innerHTML = `
      <div class="cm-composer-preview-header">
        <span><strong>메모</strong> · 누르기 · Alt(⌥)+숫자 · 대체어 뒤 스페이스</span>
        <button type="button" id="cm-memo-add" class="cm-memo-add">＋ 새 메모</button>
      </div>
      <ul id="cm-memo-list" class="cm-memo-list"></ul>
      <div id="cm-memo-form" class="cm-memo-form" hidden>
        <div class="cm-memo-new-title">새 메모</div>
        <textarea id="cm-memo-text" class="cm-memo-text" placeholder="넣을 내용: 자주 쓰는 지시문, 행동 묘사 틀, 잊기 싫은 설정…" aria-label="메모 내용"></textarea>
        <label class="cm-memo-trigger-row">
          <span>대체어</span>
          <input type="text" id="cm-memo-trigger" class="cm-memo-trigger" placeholder="예: ;전투 (선택)" autocomplete="off" spellcheck="false">
          <small>입력창에 치고 스페이스를 누르면 위 내용으로 바뀌어요</small>
        </label>
        <div class="cm-composer-preview-footer">
          <label class="cm-memo-scope"><input type="checkbox" id="cm-memo-here"> 이 대화방에서만</label>
          <span>
            <button type="button" id="cm-memo-cancel">취소</button>
            <button type="button" id="cm-memo-save">저장</button>
          </span>
        </div>
      </div>`;
    const form = panel.querySelector('#cm-memo-form');
    const text = panel.querySelector('#cm-memo-text');
    const trigger = panel.querySelector('#cm-memo-trigger');
    const here = panel.querySelector('#cm-memo-here');
    const save = panel.querySelector('#cm-memo-save');
    const cancel = panel.querySelector('#cm-memo-cancel');
    const add = panel.querySelector('#cm-memo-add');
    const reset = () => {
      panel.dataset.editing = ''; text.value = ''; trigger.value = ''; here.checked = false;
      form.hidden = true; add.hidden = false; panel.querySelector('.cm-memo-new-title').textContent = '새 메모';
    };
    add.onclick = () => {
      reset();
      form.hidden = false;
      add.hidden = true;
      text.focus();
    };
    // Ctrl/⌘+Enter saves from anywhere in the form.
    form.addEventListener('keydown', event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save.click(); }
    });
    save.onclick = async () => {
      const body = text.value.replace(/\s+$/, '');
      if (!body.trim()) { text.focus(); return; }
      const word = trigger.value.trim();
      if (/\s/.test(word)) { alert('대체어에는 띄어쓰기를 넣을 수 없어요.'); trigger.focus(); return; }
      const list = await readMemos();
      const scope = here.checked ? chatId() || null : null;
      const clash = word && list.find(memo => memo.id !== panel.dataset.editing && memo.trigger === word
        && (!memo.chatId || !scope || memo.chatId === scope));
      if (clash) { alert(`'${word}'은(는) 다른 메모의 대체어예요.`); trigger.focus(); return; }
      const at = list.findIndex(memo => memo.id === panel.dataset.editing);
      const fields = { text: body, trigger: word, chatId: scope, at: Date.now() };
      if (at >= 0) list[at] = { ...list[at], ...fields };
      else list.push({ id: `memo-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, ...fields });
      await writeMemos(list);
      reset();
      renderMemos();
    };
    cancel.onclick = reset;
    closeDockPanelOnEscape(panel);
    return panel;
  }
  async function renderMemos() {
    const panel = document.getElementById('cm-memo-panel');
    const list = panel?.querySelector('#cm-memo-list');
    if (!list) return;
    await readMemos();
    const memos = memosHere();
    list.replaceChildren();
    if (!memos.length) {
      const empty = document.createElement('li');
      empty.className = 'cm-memo-empty';
      empty.textContent = '아직 메모가 없어요. ＋ 새 메모로 추가하세요. 앞의 10개는 Alt+1…Alt+0으로 넣을 수 있어요.';
      list.append(empty);
    }
    const button = (label, title, onclick) => {
      const el = document.createElement('button');
      el.type = 'button';
      el.textContent = label;
      el.title = title;
      el.onclick = onclick;
      return el;
    };
    memos.forEach((memo, index) => {
      const item = document.createElement('li');
      const key = document.createElement('span');
      key.className = 'cm-memo-key';
      key.textContent = index < MEMO_SLOTS ? slotLabel(index) : '';
      const use = button(memo.text, '입력창에 넣기', () => {
        if (!insertIntoEditor(memo.text)) alert('크랙 입력창을 찾지 못했어요.');
      });
      use.className = 'cm-memo-use';
      const tag = document.createElement('span');
      tag.className = 'cm-memo-tag';
      tag.textContent = [memo.trigger, memo.chatId && '이 방'].filter(Boolean).join(' · ');
      // Moving up changes which Alt+number a memo gets.
      const up = button('↑', '위로 (단축키 번호 앞당기기)', async () => {
        const all = await readMemos();
        const from = all.findIndex(entry => entry.id === memo.id);
        const to = all.findIndex(entry => entry.id === memos[index - 1].id);
        [all[from], all[to]] = [all[to], all[from]];
        await writeMemos(all);
        renderMemos();
      });
      up.disabled = index === 0;
      const edit = button('✏️', '수정', () => {
        panel.dataset.editing = memo.id;
        panel.querySelector('#cm-memo-text').value = memo.text;
        panel.querySelector('#cm-memo-trigger').value = memo.trigger || '';
        panel.querySelector('#cm-memo-here').checked = Boolean(memo.chatId);
        panel.querySelector('.cm-memo-new-title').textContent = '메모 수정';
        panel.querySelector('#cm-memo-form').hidden = false;
        panel.querySelector('#cm-memo-add').hidden = true;
        panel.querySelector('#cm-memo-text').focus();
      });
      const remove = button('🗑️', '삭제', async () => {
        if (!confirm('이 메모를 삭제할까요?')) return;
        await writeMemos((await readMemos()).filter(entry => entry.id !== memo.id));
        renderMemos();
      });
      item.append(key, use, tag, up, edit, remove);
      list.append(item);
    });
  }

  let jumpSerial = 0;
  // Crack loads older messages as the list scrolls up. Keep scrolling until the
  // target bubble appears; if it never does, show that turn's text instead.
  async function jumpToTurn(turn) {
    const id = chatId();
    const serial = ++jumpSerial;
    const info = await chrome.runtime.sendMessage({ type: 'TURN_INFO', chatId: id, turn: Number(turn) }).catch(() => null);
    if (!info?.success) { alert(info?.error || `대화 ${turn}을(를) 찾지 못했습니다.`); return; }
    let group = findGroupById(info.messageId) || bubbleTurns.get(Number(turn));
    if (group?.isConnected) { flashGroup(group); return; }

    document.getElementById('cm-master-modal')?.classList.remove('open');
    const scroller = chatScroller();
    const reversed = Boolean(document.querySelector('[data-message-group-id]')?.closest('.flex-col-reverse'));
    let lastCount = -1;
    let stalls = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline && stalls < 4 && serial === jumpSerial && chatId() === id) {
      scroller.scrollTo({ top: reversed ? -scroller.scrollHeight : 0 });
      await new Promise(resolve => setTimeout(resolve, 600));
      group = findGroupById(info.messageId);
      if (group) { flashGroup(group); return; }
      const count = document.querySelectorAll('[data-message-group-id]').length;
      stalls = count === lastCount ? stalls + 1 : 0;
      lastCount = count;
    }
    if (serial === jumpSerial) showTurnText(turn, info.text);
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    const id = chatId();
    if (area !== 'local' || !id || !changes[`pins:${id}`]) return;
    const pinned = new Set((changes[`pins:${id}`].newValue || []).map(pin => pin.messageId));
    for (const tools of document.querySelectorAll('.cm-bubble-tools')) {
      tools.querySelector('.cm-bubble-pin')?.classList.toggle('active', pinned.has(tools.dataset.messageId));
    }
    const modal = document.getElementById('cm-master-modal');
    if (modal?.classList.contains('open')) renderPinnedMemories(id, modal);
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

  // --- 6. Unified Master Modal Controller (Trace Console) ---
  let currentDeckFilter = 'all';
  let deckSearch = '';
  const deckMatches = (...texts) => !deckSearch || texts.some(t => String(t || '').toLowerCase().includes(deckSearch));

  function openMasterModal(activeTab = 'deck', extraOpts = null) {
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
              <img class="cm-modal-logo" src="${chrome.runtime.getURL('icons/trace.svg')}" alt="" width="28" height="28">
              <span class="cm-modal-title">Trace</span>
              <span class="cm-modal-room-badge" id="cm-master-room-badge">대화방 연결됨</span>
            </div>
            <button class="cm-modal-close" type="button" title="닫기 (ESC)">×</button>
          </div>
          <div class="cm-modal-tabs" id="cm-master-tabs">
            <button class="cm-tab-btn" data-tab="deck"><span>🌿</span> 기억</button>
            <button class="cm-tab-btn" data-tab="usernote"><span>📝</span> 유저노트</button>
            <button class="cm-tab-btn" data-tab="lore"><span>📜</span> 로어북</button>
            <button class="cm-tab-btn" data-tab="settings"><span>⚙️</span> 설정</button>
            <button class="cm-tab-btn" data-tab="export"><span>📥</span> 내보내기</button>
          </div>
          <div class="cm-modal-body cm-master-body">
            <!-- TAB 2: Evolution Deck -->
            <div id="cm-master-tab-deck" class="cm-tab-pane">
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
                  <input id="cm-deck-search" class="cm-input" type="search" placeholder="기억 검색" aria-label="기억 검색" style="width: 150px;height: 28px;font-size: 12px;padding: 2px 8px">
                  <button id="cm-btn-mem-rebuild" class="cm-btn-secondary small" type="button" title="현재 대화를 다시 분석해 기억을 교체">⚡ 전체 다시 읽기</button>
                  <button id="cm-btn-mem-sum-now" class="cm-btn-primary small" type="button">✨ 지금 갱신</button>
                </div>
              </div>

              <!-- Evolution Cards List -->
              <div id="cm-deck-pins"></div>
              <div id="cm-deck-cards-list" class="cm-memory-list"></div>
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
                <details id="cm-legacy-notes" class="cm-legacy-notes" hidden>
                  <summary>예전 메모장 내용 (메모장은 유저노트로 합쳐졌습니다)</summary>
                  <textarea id="cm-legacy-notes-text" class="cm-textarea" readonly style="min-height: 80px"></textarea>
                  <div style="display: flex;justify-content: flex-end;gap: 6px;margin-top: 6px">
                    <button id="cm-btn-legacy-notes-append" class="cm-btn-secondary small" type="button">유저노트 뒤에 붙이기</button>
                    <button id="cm-btn-legacy-notes-delete" class="cm-btn-secondary small" type="button" style="color: var(--cm-danger)">예전 메모 삭제</button>
                  </div>
                </details>
                <textarea id="cm-usernote-text" class="cm-textarea" style="min-height: 90px" placeholder="예: 서술은 3인칭 소설체로 길고 밀도 있게 전개하고, 인물의 복합적인 내면 심리와 시각적 디테일을 풍부하게 묘사하세요."></textarea>

                <div style="display: flex;justify-content: space-between;align-items: center;margin-top: 8px;flex-wrap: wrap;gap: 6px">
                  <button id="cm-btn-copy-usernote-text" class="cm-btn-secondary small" type="button" title="텍스트 복사">📋 텍스트 복사</button>
                  <div style="display: flex;gap: 8px;align-items: center">
                    <span id="cm-usernote-status" style="font-size: 11px;color: var(--cm-text-3)"></span>
                    <button id="cm-btn-save-usernote-global" class="cm-btn-secondary small" type="button" title="유저노트가 없는 모든 대화방에 기본으로 쓰입니다">🌐 공통 기본값으로 지정</button>
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
                    <option value="both">키워드 + 내용 검색 (권장)</option>
                    <option value="keyword">키워드가 나올 때만</option>
                  </select>
                </div>
                <input id="cm-lore-kw" class="cm-input" placeholder="트리거 키워드 (쉼표 구분: 성검, 아르테미스, 신성무기)">
                <textarea id="cm-lore-content" class="cm-textarea" placeholder="주입할 설정 및 행동 지침 내용"></textarea>
                <details class="cm-lore-advanced">
                  <summary>고급: 관계 직접 적기 (보통은 필요 없음)</summary>
                  <p style="font-size: 11px;color: var(--cm-text-3);margin: 4px 0">본문에 같이 나온 이름과 동사("아린이 쓰는 검")에서 관계를 자동으로 읽습니다. 본문에 없는 관계만 한 줄에 하나씩 적으세요.</p>
                  <textarea id="cm-lore-relations" class="cm-textarea" placeholder="주체 > 관계 > 대상&#10;예: 서령 > 맡김 > 은빛 열쇠" style="min-height: 70px"></textarea>
                </details>
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

            <!-- TAB 8: Settings & Storage -->
            <div id="cm-master-tab-settings" class="cm-tab-pane">
              <!-- Memory -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>🧠 기억</span>
                  <span id="cm-memory-settings-status" style="font-size: 11px;color: var(--cm-ok)"></span>
                </div>
                <label class="cm-switch-label full">
                  <input id="cm-opt-auto" type="checkbox" checked>
                  <span>전송할 때 기억·로어 자동 주입 (이 대화방)</span>
                </label>
                <label class="cm-switch-label full">
                  <input id="cm-opt-llm-intervention" type="checkbox" checked>
                  <span>LLM으로 기억 만들기 (끄면 대화 원문에서 찾아 넣기)</span>
                </label>
                <label class="cm-switch-label full">
                  <input id="cm-opt-semantic" type="checkbox">
                  <span>의미 검색 (문장 임베딩 · 처음 켤 때 약 145MB 다운로드)</span>
                </label>
                <p style="font-size: 11px;color: var(--cm-text-3);margin: 2px 0 8px">로어·기억·대화 원문을 단어뿐 아니라 뜻으로도 찾습니다. 보낼 때 느리면 단어 검색만 씁니다. <span id="cm-semantic-status"></span></p>
                <div class="cm-form-row">
                  <label>LLM 모델</label>
                  <span id="cm-llm-status" style="font-size: 12px;color: var(--cm-text-2)">확인 중…</span>
                  <button id="cm-btn-llm-download" class="cm-btn-secondary small" type="button" hidden>모델 받기</button>
                </div>
              </div>

              <!-- View settings -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>🖥️ 화면 · 글꼴</span>
                </div>
                <div class="cm-form-row">
                  <label>가로 너비 실시간 조절: <b id="cm-val-width" style="color: var(--cm-text)">980px</b></label>
                  <input id="cm-opt-width-slider" type="range" min="720" max="1600" step="10" value="980" style="flex: 1;max-width: 240px">
                </div>
                <div class="cm-form-row">
                  <label>너비 프리셋</label>
                  <select id="cm-opt-width" class="cm-input" style="max-width: 240px">
                    <option value="normal" selected>크랙 기본</option>
                    <option value="wide">와이드 (980px)</option>
                    <option value="ultra">울트라와이드 (1180px)</option>
                    <option value="full">전체화면 (94vw)</option>
                    <option value="custom">사용자 지정 (슬라이더)</option>
                  </select>
                </div>
                <div class="cm-form-row">
                  <label for="cm-opt-font">본문 글꼴</label>
                  <select id="cm-opt-font" class="cm-input" style="max-width: 240px"></select>
                </div>
                <div class="cm-form-row" id="cm-custom-font-row" hidden>
                  <label>직접 입력</label>
                  <input id="cm-opt-custom-font" class="cm-input" placeholder="글꼴 이름 (예: Gaegu)" style="max-width: 150px">
                  <input id="cm-opt-custom-font-css" class="cm-input" placeholder="웹폰트 CSS 주소 (선택)" style="max-width: 240px">
                </div>
                <div class="cm-form-row">
                  <label>글자 크기: <span id="cm-val-fontsize">15px</span></label>
                  <input id="cm-opt-fontsize" type="range" min="12" max="22" value="15" step="1" style="max-width: 240px">
                </div>
                <div class="cm-form-row">
                  <label>줄 간격: <span id="cm-val-lineheight">1.65</span></label>
                  <input id="cm-opt-lineheight" type="range" min="1.3" max="2.3" value="1.65" step="0.05" style="max-width: 240px">
                </div>
                <div class="cm-form-row">
                  <label>자간: <span id="cm-val-letterspacing">기본</span></label>
                  <input id="cm-opt-letterspacing" type="range" min="-0.05" max="0.1" value="0" step="0.01" style="max-width: 240px">
                </div>
                <div class="cm-form-row">
                  <label for="cm-opt-fontweight">굵기</label>
                  <select id="cm-opt-fontweight" class="cm-input" style="max-width: 240px">
                    <option value="">기본</option><option value="300">가늘게</option><option value="400">보통</option><option value="500">약간 굵게</option><option value="600">굵게</option>
                  </select>
                </div>
                <div class="cm-form-row">
                  <label for="cm-opt-paragraphgap">문단 간격</label>
                  <select id="cm-opt-paragraphgap" class="cm-input" style="max-width: 240px">
                    <option value="">기본</option><option value="0.4">좁게</option><option value="0.9">보통</option><option value="1.4">넓게</option><option value="2">아주 넓게</option>
                  </select>
                </div>
                <p id="cm-font-preview" class="cm-font-preview">크리는 은빛 열쇠를 루시아의 손에 쥐여 주었다. “이번엔 꼭 돌아올게.”</p>
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
                <div style="display: flex;justify-content: flex-end;margin-top: 6px">
                  <span id="cm-view-settings-status" style="font-size: 11px;color: var(--cm-ok)"></span>
                </div>
              </div>


              <!-- Storage Hygiene & GC -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>💾 저장소</span>
                  <span id="cm-storage-usage-tag" style="font-size: 11px;color: var(--cm-text);font-weight: 600">계산 중…</span>
                </div>
                <div style="display: flex;gap: 8px;flex-wrap: wrap;margin-top: 10px">
                  <button id="cm-btn-manual-gc" class="cm-btn-primary small" type="button">🧹 정리하기</button>
                  <button id="cm-btn-backup-export" class="cm-btn-secondary small" type="button" title="기억·로어·유저노트·설정을 파일 하나로 저장">💾 백업 내보내기</button>
                  <button id="cm-btn-backup-import" class="cm-btn-secondary small" type="button" title="백업 파일의 내용을 합쳐 넣기">📂 백업 가져오기</button>
                  <button id="cm-btn-reset-chat-storage" class="cm-btn-secondary small" type="button" style="color: var(--cm-danger)">🗑️ 이 대화방 기억 초기화</button>
                </div>
              </div>

              <!-- Analytics -->
              <div class="cm-card">
                <div class="cm-card-header">
                  <span>📊 이 대화방</span>
                </div>
                <div id="cm-client-analytics" style="font-size: 12px;color: var(--cm-text-2)"></div>
              </div>
            </div>

            <!-- TAB 9: Export Conversation -->
            <div id="cm-master-tab-export" class="cm-tab-pane">
              <div class="cm-card highlight">
                <div class="cm-card-header">
                  <span>📥 대화 내보내기</span>
                  <span style="font-size: 11px;color: var(--cm-text);font-weight: 600" id="cm-export-status">대기 중</span>
                </div>
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
      // Closing the window sends a user note still waiting to go to Crack.
      modal.querySelector('.cm-modal-close').onclick = () => { flushUserNote(); modal.classList.remove('open'); };
      modal.onclick = (e) => { if (e.target === modal) { flushUserNote(); modal.classList.remove('open'); } };
      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.classList.contains('open')) {
          flushUserNote();
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

    modal.classList.add('open');
  }

  function dispatchTabLoad(tab, id, modal, extraOpts = null) {
    if (!id) id = chatId();
    if (tab === 'deck') renderMemoryDeckTab(id, modal, extraOpts);
    else if (tab === 'usernote') loadUserNoteTab(id, modal);
    else if (tab === 'lore') loadLoreTab(id, modal);
    else if (tab === 'settings') loadSettingsTab(id, modal);
    else if (tab === 'export') loadExportTab(id, modal);
  }

  // --- Tab 2: Memory Evolution Deck Loader ---
  function renderBranchNotice(id, modal) {
    let box = modal.querySelector('#cm-deck-branch');
    if (!box) {
      box = document.createElement('div');
      box.id = 'cm-deck-branch';
      box.className = 'cm-notice';
      modal.querySelector('#cm-deck-pins')?.before(box);
    }
    chrome.storage.local.get(`branchOf:${id}`, res => {
      const branch = res[`branchOf:${id}`];
      box.hidden = !branch || chatId() !== id;
      if (branch) box.textContent = `🌱 분기된 대화예요. 원본 대화의 ${branch.turns}번째 턴까지 같아서, 그때까지의 기억 ${branch.facts}건과 고정·로어·유저노트를 가져왔어요. 이후 기억은 이 대화에서 따로 쌓여요.`;
    });
  }

  function renderPinnedMemories(id, modal) {
    const box = modal.querySelector('#cm-deck-pins');
    if (!box) return;
    chrome.storage.local.get(`pins:${id}`, res => {
      if (chatId() !== id) return;
      const pins = (res[`pins:${id}`] || []).filter(pin => deckMatches(pin.text));
      box.replaceChildren();
      if (!pins.length) return;
      const card = document.createElement('div');
      card.className = 'cm-card highlight';
      const title = document.createElement('strong');
      title.textContent = `📌 고정한 기억 ${pins.length}건 · 항상 먼저 들어갑니다`;
      card.append(title);
      for (const pin of pins) {
        const row = document.createElement('div');
        row.className = 'cm-evolution-step cm-nano-fact';
        const head = document.createElement('div');
        head.className = 'cm-nano-fact-head';
        const turn = document.createElement('button');
        turn.type = 'button';
        turn.className = 'cm-turn-link';
        turn.textContent = `대화 ${pin.turn}`;
        turn.onclick = () => jumpToTurn(pin.turn);
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'cm-btn-secondary small';
        remove.textContent = '고정 해제';
        remove.onclick = () => chrome.runtime.sendMessage({ type: 'TOGGLE_PIN', chatId: id, messageId: pin.messageId });
        head.append(turn, remove);
        // Edits save when the box loses focus; the text is what gets injected.
        const text = document.createElement('textarea');
        text.className = 'cm-textarea';
        text.value = pin.text;
        text.maxLength = 300;
        text.rows = 2;
        text.setAttribute('aria-label', '고정한 기억 내용');
        text.onchange = () => chrome.runtime.sendMessage({ type: 'UPDATE_PIN', chatId: id, messageId: pin.messageId, text: text.value });
        row.append(head, text);
        card.append(row);
      }
      box.append(card);
    });
  }

  // Memory writes arrive every LLM batch. Re-rendering mid-edit threw away the edit box,
  // so wait until nothing in the list is being edited, and coalesce bursts.
  let deckRenderTimer = 0;
  function scheduleDeckRender(id, modal) {
    clearTimeout(deckRenderTimer);
    deckRenderTimer = setTimeout(() => {
      const list = modal.querySelector('#cm-master-tab-deck');
      const editing = list?.querySelector('.cm-nano-fact-edit, .cm-btn-edit-deck.editing') || list?.contains(document.activeElement) && document.activeElement.matches('textarea, input:not([type="search"]), select');
      if (editing) { scheduleDeckRender(id, modal); return; }
      if (chatId() === id && modal.classList.contains('open')) renderMemoryDeckTab(id, modal);
    }, 600);
  }

  function renderMemoryDeckTab(id, modal, extraOpts = null) {
    const container = modal.querySelector('#cm-deck-cards-list');
    if (!container) return;
    const renderSerial = ++deckRenderSerial;
    container.innerHTML = '<div style="color: var(--cm-text-3);padding: 24px;text-align: center">진화 기억 덱 로딩 중…</div>';

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

    const search = modal.querySelector('#cm-deck-search');
    if (search && !search.dataset.bound) {
      search.dataset.bound = '1';
      let searchTimer = 0;
      search.oninput = () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(() => { deckSearch = search.value.trim().toLowerCase(); renderMemoryDeckTab(chatId(), modal); }, 200);
      };
    }
    renderPinnedMemories(id, modal);
    renderBranchNotice(id, modal);

    chrome.storage.local.get([`graph:${id}`, `summary:${id}`, `nanoMemory:${id}`, 'llmIntervention'], async res => {
      if (chatId() !== id || renderSerial !== deckRenderSerial) return;
      try {
        // Both modes produce keyword cards: current notes (injected) and history (kept, not injected).
        const reply = await chrome.runtime.sendMessage({ type: 'GET_MEMORY_CARDS', chatId: id });
        if (chatId() !== id || renderSerial !== deckRenderSerial) return;
        if (reply?.success && reply.cards?.length) {
          container.replaceChildren();
          const REASON = { updated: '갱신됨 · 주입 안 함', restated: '다시 언급됨', overflow: '휴면 · 직접 물으면 꺼냄' };
          for (const entry of reply.cards) {
            if (currentDeckFilter !== 'all' && entry.domain !== currentDeckFilter) continue;
            if (!deckMatches(entry.keyword, ...entry.current.map(note => `${note.fact} ${note.kind || ''} ${(note.who || []).join(' ')}`),
              ...entry.history.map(note => note.fact))) continue;
            const chain = entry.current;
            const card = document.createElement('div');
            card.className = 'cm-card keyword-card';
            const title = document.createElement('strong');
            title.textContent = entry.keyword;
            card.append(title);
            const domain = document.createElement('span');
            domain.className = 'cm-badge';
            domain.textContent = entry.domain || '미분류';
            card.append(domain);
            const exclude = document.createElement('button');
            exclude.className = 'cm-btn-secondary small';
            exclude.type = 'button';
            exclude.textContent = '키워드 제외';
            exclude.title = '이 키워드의 모든 기억을 숨기고 앞으로도 추출하지 않습니다';
            exclude.onclick = async () => {
              const keyword = entry.keyword;
              if (!confirm(`‘${keyword}’ 키워드의 모든 기억을 제외할까요?`)) return;
              const result = await chrome.runtime.sendMessage({ type: 'DROP_KEYWORD', chatId: id, keyword });
              if (!result?.success) alert(result?.error || '키워드를 제외하지 못했습니다.');
            };
            // Pinning a keyword injects its current notes on every send, whatever the draft.
            const pinKeyword = document.createElement('button');
            pinKeyword.className = `cm-btn-secondary small cm-pin-toggle${entry.pinned ? ' active' : ''}`;
            pinKeyword.type = 'button';
            pinKeyword.textContent = entry.pinned ? '📌 고정됨' : '📌 키워드 고정';
            pinKeyword.setAttribute('aria-pressed', String(Boolean(entry.pinned)));
            pinKeyword.title = '이 키워드의 현재 기억을 매번 주입합니다 (고정 예산 700자 안에서 최신 순)';
            pinKeyword.onclick = async () => {
              const result = await chrome.runtime.sendMessage({ type: 'TOGGLE_KEYWORD_PIN', chatId: id, keyword: entry.keyword });
              if (!result?.success) { alert(result?.error || '고정하지 못했습니다.'); return; }
              renderMemoryDeckTab(id, modal);
            };
            card.append(pinKeyword, exclude);
            for (const fact of entry.current) {
              const step = document.createElement('div');
              step.className = 'cm-evolution-step cm-nano-fact';
              if (fact.enabled === false) step.style.opacity = '0.55';
              const head = document.createElement('div');
              head.className = 'cm-nano-fact-head';
              const turn = document.createElement('button');
              turn.type = 'button';
              turn.className = 'cm-turn-link';
              turn.textContent = `${fact.kind ? `${fact.kind} · ` : ''}대화 ${fact.turn}${fact.who?.length ? ` · ${fact.who.join('·')}` : ''}`;
              turn.title = '이 대화로 이동';
              turn.onclick = () => jumpToTurn(fact.turn);
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
              const pin = document.createElement('button');
              pin.className = `cm-btn-secondary small cm-pin-toggle${fact.pinned ? ' active' : ''}`;
              pin.type = 'button';
              pin.textContent = fact.pinned ? '📌 고정됨' : '📌 고정';
              pin.setAttribute('aria-pressed', String(Boolean(fact.pinned)));
              pin.title = '이 기억을 매번 주입합니다';
              pin.onclick = async () => {
                const result = await chrome.runtime.sendMessage({ type: 'UPDATE_NANO_FACT', chatId: id, factId: fact.id, patch: { pinned: !fact.pinned } });
                if (!result?.success) { alert(result?.error || '고정하지 못했습니다.'); return; }
                renderMemoryDeckTab(id, modal);
              };
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
              controls.append(toggleLabel, pin, edit, remove);
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
            if (entry.history.length) {
              const history = document.createElement('details');
              history.className = 'cm-card-history';
              const summary = document.createElement('summary');
              summary.textContent = `이력 ${entry.history.length}건`;
              history.append(summary);
              for (const note of [...entry.history].sort((a, b) => Number(b.turn) - Number(a.turn))) {
                const row = document.createElement('div');
                row.className = 'cm-card-history-row';
                const link = document.createElement('button');
                link.type = 'button';
                link.className = 'cm-turn-link';
                link.textContent = `대화 ${note.turn}`;
                link.onclick = () => jumpToTurn(note.turn);
                const text = document.createElement('span');
                text.textContent = ` ${note.fact} · ${REASON[note.reason] || '이력'}`;
                row.append(link, text);
                history.append(row);
              }
              card.append(history);
            }
            container.append(card);
          }
          if (!container.childElementCount) container.textContent = deckSearch ? '검색 결과가 없습니다.' : '이 분류에 해당하는 기억이 없습니다.';
          return;
        }
        if (res.llmIntervention === false) {
          container.textContent = 'LLM이 꺼져 있어 기억 카드를 만들지 않습니다. 보낼 때마다 대화 원문에서 지금 필요한 구간을 찾아 넣습니다. 들어가는 내용은 “👁️ 프롬프트”에서 볼 수 있고, 꼭 넣을 대화는 말풍선의 📌로 고정하세요.';
          return;
        }
        if (reply?.success && !reply.cards?.length) {
          container.textContent = '아직 쌓인 기억이 없습니다.';
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
          if (!deckMatches(c.keyword, c.title, c.content)) return false;
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

  // --- Tab 3: User Note Loader ---
  function loadLegacyNotes(id, modal) {
    const box = modal.querySelector('#cm-legacy-notes');
    if (!box) return;
    chrome.storage.local.get(`notes:${id}`, res => {
      const text = String(res[`notes:${id}`] || '');
      box.hidden = !text.trim();
      modal.querySelector('#cm-legacy-notes-text').value = text;
      modal.querySelector('#cm-btn-legacy-notes-append').onclick = () => {
        const note = modal.querySelector('#cm-usernote-text');
        note.value = note.value.trim() ? `${note.value.trim()}\n${text.trim()}` : text.trim();
        note.dispatchEvent(new Event('input', { bubbles: true }));
        note.focus();
      };
      modal.querySelector('#cm-btn-legacy-notes-delete').onclick = () => {
        if (!confirm('예전 메모장 내용을 삭제할까요?')) return;
        chrome.storage.local.remove(`notes:${id}`, () => { box.hidden = true; });
      };
    });
  }

  // Last user note sent to (or read from) Crack per chat, so an unchanged note is not sent again.
  const sentUserNotes = new Map();
  let flushUserNote = () => {};

  function setUserNoteStatus(modal, text) {
    const el = modal.querySelector('#cm-usernote-status');
    if (el) el.textContent = text;
  }

  function loadUserNoteTab(id, modal) {
    loadLegacyNotes(id, modal);
    const textEl = modal.querySelector('#cm-usernote-text');
    const enableEl = modal.querySelector('#cm-usernote-enable');
    chrome.storage.local.get([`usernote:${id}`, 'usernote:auto_enabled', 'usernote:global', `usernoteEnabled:${id}`, 'usernote:paid_mode'], async res => {
      const localUn = res[`usernote:${id}`];
      const globalUn = res['usernote:global'] || '';
      const autoGlobal = res['usernote:auto_enabled'] !== false;
      const enabled = res[`usernoteEnabled:${id}`] !== false;
      // Crack's own note is the truth; Trace's copy only remembers a note that is switched off.
      const native = await chrome.runtime.sendMessage({ type: 'GET_NATIVE_USERNOTE', chatId: id }).catch(() => null);
      if (chatId() !== id) return;
      let text = localUn || '';
      let status = '';
      if (native?.success && native.found) sentUserNotes.set(id, JSON.stringify([native.content, native.isExtend]));
      if (native?.success && native.found && native.content) {
        text = native.content;
        status = '크랙 유저노트와 연결됨';
        const paid = modal.querySelector('#cm-usernote-paid-mode');
        if (paid && paid.checked !== native.isExtend) { paid.checked = native.isExtend; paid.dispatchEvent(new Event('change')); }
      } else if (!enabled && localUn) {
        status = '꺼져 있음 · 크랙에는 보내지 않아요';
      } else if (!localUn && autoGlobal && globalUn) {
        text = globalUn;
        status = '공통 기본값 표시 중 · 고치면 이 대화방 크랙 유저노트로 저장돼요';
      } else if (!native?.success) {
        status = '크랙 유저노트를 읽지 못했어요';
      }
      if (textEl) {
        textEl.value = text;
        // A freshly loaded note has nothing pending, and belongs to this room.
        delete textEl.dataset.dirty;
        textEl.dataset.chat = id;
        // Loading is not an edit: update the counter without triggering the auto-save.
        textEl.dataset.loading = '1';
        textEl.dispatchEvent(new Event('input', { bubbles: true }));
        delete textEl.dataset.loading;
      }
      if (enableEl) enableEl.checked = enabled;
      setUserNoteStatus(modal, status);
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
            트리거: ${item.alwaysInclude ? '상시 주입' : [(item.keywords || []).join(', '), item.triggerType === 'keyword' ? '' : '내용 검색'].filter(Boolean).join(' + ')}
          </div>
          ${(item.relations || []).length ? `<div style="font-size: 11px;color: var(--cm-text-3)">관계 ${(item.relations || []).length}건</div>` : ''}
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

  // --- Tab 8: Settings & Storage Loader ---
  function loadSettingsTab(id, modal) {
    chrome.storage.local.get([
      'clientViewSettings',
      `auto:${id}`,
      'llmIntervention',
      'semanticSearch'
    ], res => {
      const v = { ...DEFAULT_VIEW, ...(res.clientViewSettings || {}) };
      const q = selector => modal.querySelector(selector);
      const fontSelect = q('#cm-opt-font');
      if (fontSelect && !fontSelect.options.length) {
        for (const [value, font] of Object.entries(READING_FONTS)) fontSelect.add(new Option(font.label, value));
      }
      q('#cm-opt-width').value = v.width;
      q('#cm-opt-width-slider').value = v.customWidth;
      q('#cm-val-width').textContent = `${v.customWidth}px`;
      fontSelect.value = READING_FONTS[v.font] ? v.font : 'default';
      q('#cm-opt-custom-font').value = v.customFont || '';
      q('#cm-opt-custom-font-css').value = v.customFontCss || '';
      q('#cm-custom-font-row').hidden = v.font !== 'custom';
      q('#cm-opt-fontsize').value = v.fontSize;
      q('#cm-val-fontsize').textContent = `${v.fontSize}px`;
      q('#cm-opt-lineheight').value = v.lineHeight;
      q('#cm-val-lineheight').textContent = v.lineHeight;
      q('#cm-opt-letterspacing').value = v.letterSpacing || 0;
      q('#cm-val-letterspacing').textContent = Number(v.letterSpacing) ? `${v.letterSpacing}em` : '기본';
      q('#cm-opt-fontweight').value = v.fontWeight || '';
      q('#cm-opt-paragraphgap').value = v.paragraphGap || '';
      q('#cm-opt-perf').checked = v.perfOpt !== false;
      q('#cm-opt-imgpreload').checked = v.imagePreload !== false;
      updateFontPreview(modal);

      const autoEl = modal.querySelector('#cm-opt-auto');
      const llmEl = modal.querySelector('#cm-opt-llm-intervention');

      if (autoEl) autoEl.checked = res[`auto:${id}`] !== false;
      if (llmEl) llmEl.checked = res.llmIntervention !== false; // default true
      const semanticEl = q('#cm-opt-semantic');
      if (semanticEl) semanticEl.checked = res.semanticSearch === true;
      if (res.semanticSearch) watchSemanticStatus(modal);
    });

    refreshLLMStatus(modal);

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
        ? `LLM 처리 <b>${s.processedTurns}/${s.totalTurns}턴</b> · 대기 ${s.pendingTurns}턴 · 기억 사실 ${s.factCount}건<br>이 대화 오늘 전송 <b>${s.roomToday.sends}회</b> · 주입 ${s.roomToday.injected}건`
        : `추출식 대화 <b>${s.totalTurns}턴</b> · 기억 노드 ${s.graphNodes}개<br>이 대화 오늘 전송 <b>${s.roomToday.sends}회</b> · 주입 ${s.roomToday.injected}건`;
    });
  }

  // While the embedding model downloads, show progress; stop once it is ready or failed.
  let semanticTimer = 0;
  function watchSemanticStatus(modal) {
    clearTimeout(semanticTimer);
    const el = modal.querySelector('#cm-semantic-status');
    if (!el) return;
    chrome.runtime.sendMessage({ type: 'SEMANTIC_STATUS' }, res => {
      if (chrome.runtime.lastError || !res) { el.textContent = '· 상태를 확인하지 못했어요'; return; }
      if (res.state === 'ready') { el.textContent = '· 준비됨'; return; }
      if (res.state === 'error') { el.textContent = `· 준비 실패: ${res.error || ''}`; return; }
      el.textContent = res.total ? `· 받는 중 ${Math.round(100 * res.loaded / res.total)}%` : '· 준비 중…';
      if (modal.classList.contains('open')) semanticTimer = setTimeout(() => watchSemanticStatus(modal), 1000);
    });
  }

  function refreshLLMStatus(modal) {
    const statusEl = modal.querySelector('#cm-llm-status');
    const downloadBtn = modal.querySelector('#cm-btn-llm-download');
    if (!statusEl) return;
    statusEl.textContent = '확인 중…';
    chrome.runtime.sendMessage({ type: 'GET_LLM_STATUS' }, res => {
      const state = res?.state || 'unknown';
      statusEl.textContent = {
        available: `준비됨${res.host === 'sidepanel' ? ' (사이드패널에서 실행)' : ''}`,
        downloadable: '모델을 받아야 합니다',
        downloading: '모델 받는 중…',
        unavailable: '이 기기에서는 쓸 수 없습니다',
        unsupported: '이 Chrome에서는 쓸 수 없습니다',
        nohost: '실행 준비 안 됨'
      }[state] || '상태를 확인하지 못했습니다';
      if (downloadBtn) downloadBtn.hidden = !['downloadable', 'downloading', 'nohost'].includes(state);
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

    // 2. Evolution Deck Controls (Full Rebuild)
    modal.querySelector('#cm-btn-mem-rebuild').onclick = () => {
      const currentId = id();
      if (!confirm('현재 대화의 기억을 처음부터 다시 만들까요? 새 분석이 모두 끝나면 기존 기억을 교체합니다.')) return;
      chrome.runtime.sendMessage({ type: 'START_NANO_MEMORY', chatId: currentId, force: true, rebuild: true }, result => {
        if (!result?.success) alert(result?.error || '다시 읽기를 시작하지 못했습니다.');
      });
    };

    modal.querySelector('#cm-btn-mem-sum-now').onclick = () => {
      triggerSummarization();
    };

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

    // The user note is kept in Trace as you type, but sent to Crack once: when you leave the
    // box, close the Trace window, or stop typing for a few seconds, and only if it changed.
    let userNoteSaveTimer = 0;
    let userNoteSendTimer = 0;
    const userNotePayload = () => {
      const enabled = modal.querySelector('#cm-usernote-enable').checked;
      return { enabled, content: enabled ? userNoteText.value.trim() : '', isExtend: Boolean(modal.querySelector('#cm-usernote-paid-mode')?.checked) };
    };
    const sendUserNote = async () => {
      clearTimeout(userNoteSendTimer);
      // The room the note was written in, even if the page has moved to another chat since.
      const currentId = userNoteText.dataset.chat;
      if (!currentId || userNoteText.dataset.dirty !== '1') return;
      const { enabled, content, isExtend } = userNotePayload();
      const key = JSON.stringify([content, isExtend]);
      if (sentUserNotes.get(currentId) === key) { delete userNoteText.dataset.dirty; setUserNoteStatus(modal, '크랙에 반영됨'); return; }
      setUserNoteStatus(modal, '크랙에 보내는 중…');
      const result = await chrome.runtime.sendMessage({ type: 'SET_NATIVE_USERNOTE', chatId: currentId, content, isExtend })
        .catch(error => ({ error: String(error) }));
      if (result?.success) { sentUserNotes.set(currentId, key); delete userNoteText.dataset.dirty; }
      setUserNoteStatus(modal, !result?.success ? `크랙에 반영 실패: ${result?.error || '알 수 없음'}`
        : enabled ? '크랙에 반영됨' : '꺼짐 · 크랙 유저노트를 비웠어요 (내용은 여기 남아 있어요)');
    };
    flushUserNote = sendUserNote;
    const saveUserNote = ({ now = false } = {}) => {
      const currentId = id();
      if (!currentId) return;
      userNoteText.dataset.dirty = '1';
      userNoteText.dataset.chat = currentId;
      clearTimeout(userNoteSaveTimer);
      clearTimeout(userNoteSendTimer);
      setUserNoteStatus(modal, '입력 중… 다 쓰고 나면 크랙에 보내요');
      userNoteSaveTimer = setTimeout(() => {
        const { enabled } = userNotePayload();
        chrome.storage.local.set({ [`usernote:${currentId}`]: userNoteText.value.trim(), [`usernoteEnabled:${currentId}`]: enabled }, refreshDockLabels);
      }, 300);
      if (now) sendUserNote();
      else userNoteSendTimer = setTimeout(sendUserNote, 3000);
    };
    userNoteText.addEventListener('input', () => { if (!userNoteText.dataset.loading) saveUserNote(); });
    userNoteText.addEventListener('blur', () => sendUserNote());
    // The paid 2,000-character mode is part of Crack's note (isExtend); only a user's click saves it.
    modal.querySelector('#cm-usernote-paid-mode')?.addEventListener('change', event => { if (event.isTrusted) saveUserNote({ now: true }); });
    modal.querySelector('#cm-usernote-enable').addEventListener('change', () => saveUserNote({ now: true }));

    // Save globally for all rooms
    modal.querySelector('#cm-btn-save-usernote-global').onclick = () => {
      const text = userNoteText.value.trim();
      if (!confirm('현재 작성된 유저노트를 모든 대화방의 공통 기본값으로 저장하시겠습니까?')) return;
      chrome.storage.local.set({
        'usernote:global': text,
        'usernote:auto_enabled': true
      }, () => {
        setUserNoteStatus(modal, '공통 기본값으로 지정했어요');
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
      const relationText = modal.querySelector('#cm-lore-relations').value.trim();
      const alwaysInclude = modal.querySelector('#cm-lore-always').checked;
      if (!content) { alert('설정 내용을 입력하세요.'); return; }
      const relations = relationText ? relationText.split('\n').filter(Boolean).map(line => line.split('>').map(part => part.trim())) : [];
      if (relations.some(parts => parts.length !== 3 || parts.some(part => !part))) {
        alert('관계는 한 줄에 주체 > 관계 > 대상 형식으로 입력하세요.');
        return;
      }

      const keyName = `lore:${currentId}`;
      chrome.storage.local.get([keyName], res => {
        const list = res[keyName] || [];
        list.unshift({
          id: `lore_${Date.now()}`,
          title: title || '로어',
          triggerType,
          keywords: kw.split(',').map(s => s.trim()).filter(Boolean),
          content,
          relations,
          alwaysInclude,
          enabled: true
        });
        chrome.storage.local.set({ [keyName]: list }, () => {
          modal.querySelector('#cm-lore-title').value = '';
          modal.querySelector('#cm-lore-kw').value = '';
          modal.querySelector('#cm-lore-content').value = '';
          modal.querySelector('#cm-lore-relations').value = '';
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

    // 7. Settings & Storage Events
    // View settings apply and save as they change.
    const readView = () => {
      const q = selector => modal.querySelector(selector);
      return {
        width: q('#cm-opt-width').value,
        customWidth: q('#cm-opt-width-slider').value,
        font: q('#cm-opt-font').value,
        customFont: q('#cm-opt-custom-font').value.trim(),
        customFontCss: q('#cm-opt-custom-font-css').value.trim(),
        fontSize: q('#cm-opt-fontsize').value,
        lineHeight: q('#cm-opt-lineheight').value,
        letterSpacing: q('#cm-opt-letterspacing').value,
        fontWeight: q('#cm-opt-fontweight').value,
        paragraphGap: q('#cm-opt-paragraphgap').value,
        perfOpt: q('#cm-opt-perf').checked,
        imagePreload: q('#cm-opt-imgpreload').checked
      };
    };
    let viewSaveTimer = 0;
    const onViewChange = event => {
      const q = selector => modal.querySelector(selector);
      if (event?.target?.id === 'cm-opt-width-slider') q('#cm-opt-width').value = 'custom';
      const view = readView();
      q('#cm-val-width').textContent = `${view.customWidth}px`;
      q('#cm-val-fontsize').textContent = `${view.fontSize}px`;
      q('#cm-val-lineheight').textContent = view.lineHeight;
      q('#cm-val-letterspacing').textContent = Number(view.letterSpacing) ? `${view.letterSpacing}em` : '기본';
      q('#cm-custom-font-row').hidden = view.font !== 'custom';
      applyViewSettings(view);
      updateFontPreview(modal);
      clearTimeout(viewSaveTimer);
      viewSaveTimer = setTimeout(() => chrome.storage.local.set({ clientViewSettings: view }, () => {
        const status = q('#cm-view-settings-status');
        if (status) { status.textContent = '저장됨'; setTimeout(() => { status.textContent = ''; }, 1200); }
      }), 300);
    };
    for (const selector of ['#cm-opt-width', '#cm-opt-width-slider', '#cm-opt-font', '#cm-opt-custom-font', '#cm-opt-custom-font-css',
      '#cm-opt-fontsize', '#cm-opt-lineheight', '#cm-opt-letterspacing', '#cm-opt-fontweight', '#cm-opt-paragraphgap',
      '#cm-opt-perf', '#cm-opt-imgpreload']) {
      const el = modal.querySelector(selector);
      el.addEventListener(el.type === 'range' || el.tagName === 'INPUT' && el.type !== 'checkbox' ? 'input' : 'change', onViewChange);
    }

    // Memory settings save on change.
    const saveMemorySettings = () => {
      const currentId = id();
      const llmIntervention = modal.querySelector('#cm-opt-llm-intervention').checked;
      chrome.storage.local.set({
        [`auto:${currentId}`]: modal.querySelector('#cm-opt-auto').checked,
        llmIntervention
      }, () => {
        const status = modal.querySelector('#cm-memory-settings-status');
        if (status) { status.textContent = '저장됨'; setTimeout(() => { status.textContent = ''; }, 1500); }
        refreshDockLabels();
        handleTyping(attachedEditor?.innerText || '');
        if (llmIntervention && currentId) chrome.runtime.sendMessage({ type: 'START_NANO_MEMORY', chatId: currentId }).catch(() => {});
      });
    };
    for (const selector of ['#cm-opt-auto', '#cm-opt-llm-intervention']) {
      modal.querySelector(selector).onchange = saveMemorySettings;
    }
    modal.querySelector('#cm-opt-semantic').onchange = event => {
      const on = event.target.checked;
      chrome.storage.local.set({ semanticSearch: on }, () => {
        if (on) chrome.runtime.sendMessage({ type: 'SEMANTIC_PREPARE' }, () => watchSemanticStatus(modal));
        else modal.querySelector('#cm-semantic-status').textContent = '';
        handleTyping(attachedEditor?.innerText || '');
      });
    };
    modal.querySelector('#cm-btn-llm-download').onclick = () => {
      // Model download needs a click inside an extension page, so hand off to the side panel.
      chrome.runtime.sendMessage({ type: 'OPEN_NANO_PANEL', chatId: id() }, result => {
        if (!result?.success) modal.querySelector('#cm-llm-status').textContent = result?.error || '사이드패널을 열지 못했습니다.';
      });
    };

    // Backup: everything Trace stores except chat snapshots (re-fetched from Crack) and model scores.
    const BACKUP_SKIP = /^(?:snap:|modelScores|modelNames|nanoMemoryDraft:)/;
    modal.querySelector('#cm-btn-backup-export').onclick = async () => {
      const all = await chrome.storage.local.get(null);
      const data = Object.fromEntries(Object.entries(all).filter(([key]) => !BACKUP_SKIP.test(key)));
      const d = new Date();
      const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
      downloadTextFile(`trace-backup-${stamp}.json`, JSON.stringify({ app: 'Trace', version: 1, savedAt: d.toISOString(), data }));
    };
    modal.querySelector('#cm-btn-backup-import').onclick = () => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = 'application/json,.json';
      input.onchange = async () => {
        try {
          const backup = JSON.parse(await input.files[0].text());
          if (backup?.app !== 'Trace' || !backup.data || typeof backup.data !== 'object') throw Error('Trace 백업 파일이 아닙니다.');
          const entries = Object.entries(backup.data).filter(([key]) => !BACKUP_SKIP.test(key));
          if (!confirm(`${entries.length}개 항목을 가져옵니다. 같은 이름의 기존 데이터는 백업 내용으로 바뀝니다. 계속할까요?`)) return;
          await chrome.storage.local.set(Object.fromEntries(entries));
          alert('백업을 가져왔습니다.');
          refreshDockLabels();
          loadSettingsTab(id(), modal);
        } catch (error) {
          alert(`가져오지 못했습니다: ${error.message || error}`);
        }
      };
      input.click();
    };

    const manualGcBtn = modal.querySelector('#cm-btn-manual-gc');
    if (manualGcBtn) {
      manualGcBtn.onclick = () => {
        manualGcBtn.textContent = '⏳ 최적화 정리 중…';
        manualGcBtn.disabled = true;
        chrome.runtime.sendMessage({ type: 'RUN_STORAGE_CLEANUP' }, res => {
          manualGcBtn.textContent = '🧹 정리하기';
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
      text = text.replace(OWN_BLOCK_RE, '').trim();
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

      // Say plainly when this is not the whole chat.
      const warning = res.source === 'dom'
        ? `화면에 불러온 ${res.count}개만 추출했어요${res.reason ? ` (전체 추출 실패: ${res.reason})` : ''}`
        : res.incomplete ? `일부만 추출했어요: ${res.incomplete}` : '';
      statusEl.textContent = warning || `전체 ${res.count}개 메시지 추출 완료`;
      if (warning) alert(warning);
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
      handleResult({ ...res, source: 'dom' });
    } else {
      chrome.runtime.sendMessage({
        type: 'EXPORT_CHAT_FULL',
        chatId: id,
        opts
      }, res => {
        if (!res || !res.success) {
          const domRes = domExtractChat(opts);
          if (domRes && domRes.count) {
            handleResult({ ...domRes, source: 'dom', reason: res?.error || chrome.runtime.lastError?.message || '응답 없음' });
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
      flushUserNote();
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
      bubbleTurns.clear();
      nanoError = '';
      updateAnalysisProgress();
      refreshDockLabels();
      const progressId = startAnalysis('sync', '대화 기록 불러오는 중');
      chrome.runtime.sendMessage({ type: 'SYNC_CHAT', chatId: id, progressId }, () => {
        if (chatId() !== id) return;
        finishAnalysis('sync');
        chrome.runtime.sendMessage({ type: 'PREWARM_CONTEXT', chatId: id }).catch(() => {});
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
  }

  // After the extension is reloaded or updated, this tab keeps running the old
  // script with a dead chrome.* bridge until the page is refreshed. Stop quietly
  // and tell the user instead of throwing "Extension context invalidated".
  let loopTimer = 0;
  let domObserver = null;
  let retired = false;

  function extensionAlive() {
    try { return Boolean(chrome.runtime?.id); } catch { return false; }
  }

  function retireIfOrphaned() {
    if (retired) return true;
    if (extensionAlive()) return false;
    retired = true;
    clearInterval(loopTimer);
    domObserver?.disconnect();
    // A payload staged by this old script would inject stale memory; drop it.
    window.postMessage({ type: 'CRACK_MATRIX_CLEAR_STAGE' }, '*');
    const bar = document.createElement('div');
    bar.className = 'cm-orphan-bar';
    bar.setAttribute('role', 'status');
    bar.textContent = 'Trace가 업데이트되었습니다. 페이지를 새로고침하면 다시 동작합니다. ';
    const reload = document.createElement('button');
    reload.type = 'button';
    reload.textContent = '새로고침';
    reload.onclick = () => location.reload();
    bar.append(reload);
    document.body.append(bar);
    return true;
  }

  for (const type of ['error', 'unhandledrejection']) {
    window.addEventListener(type, event => {
      const message = String(event.message || event.reason?.message || '');
      if (message.includes('Extension context invalidated') && retireIfOrphaned()) event.preventDefault();
    });
  }

  function init() {
    applyClientViewSettings();
    loop();

    loopTimer = setInterval(() => { if (!retireIfOrphaned()) loop(); }, 1200);

    // Streaming replies mutate the DOM many times a second; coalesce the work.
    let domWorkTimer = 0;
    domObserver = new MutationObserver(() => {
      if (domWorkTimer) return;
      domWorkTimer = setTimeout(() => {
        domWorkTimer = 0;
        if (retireIfOrphaned()) return;
        mountComposerUI();
        maskInjectedMessages();
        scheduleNativeBadges();
        scheduleBubbleTools();
      }, 150);
    });
    domObserver.observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
