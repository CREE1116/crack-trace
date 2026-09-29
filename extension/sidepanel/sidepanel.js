// Trace - Side panel: model status/download, live prompt preview, model radar.
// Memory, lorebook and settings live in the in-page Trace window.
(() => {
  'use strict';

  let activeChatId = '';
  const nanoStatus = document.getElementById('sp-nano-status');
  const nanoProgress = document.getElementById('sp-nano-progress');
  let nanoReady = false;
  let nanoStartedChatId = '';
  let refreshSerial = 0;

  TraceLLM.listen('sidepanel');

  function renderLivePromptPreview(roomId, draft, items) {
    if (roomId !== activeChatId) return;
    const box = document.getElementById('sp-matched-preview');
    box.replaceChildren();
    if (!draft) { box.textContent = '입력창에 메시지를 쓰면 이번 전송에 들어갈 기억이 표시됩니다.'; return; }
    if (!items?.length) { box.textContent = '이번 입력에 추가할 기억이 없습니다.'; return; }
    for (const item of items) {
      const row = document.createElement('div');
      row.className = 'sp-item';
      const title = document.createElement('div');
      title.className = 'sp-item-title';
      // Why it was picked: 입력 일치 (matches the draft), 장면 / 연결 (support), 휴면, 고정, or a passage.
      const why = item.why || (item.type === 'passage' ? '원문' : item.type === 'lore' ? '로어' : '');
      title.textContent = `${item.turn ? `대화 ${item.turn} · ` : ''}${item.title || item.name || '기억'}${why ? ` · ${why}` : ''}`;
      const body = document.createElement('p');
      body.className = 'sp-item-text';
      body.textContent = item.content || item.text || '';
      row.append(title, body);
      box.append(row);
    }
  }

  async function refreshLivePromptPreview() {
    const roomId = activeChatId;
    if (!roomId) return;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) return;
      const editor = await chrome.tabs.sendMessage(tab.id, { type: 'GET_EDITOR_DRAFT' });
      if (editor?.chatId !== roomId) return;
      if (!editor.draft) { renderLivePromptPreview(roomId, '', []); return; }
      const prepared = await chrome.runtime.sendMessage({ type: 'GET_PREPARED_CONTEXT', chatId: roomId, outgoing: editor.draft });
      if (prepared?.success) renderLivePromptPreview(roomId, editor.draft, prepared.selected);
    } catch {
      if (activeChatId === roomId) document.getElementById('sp-matched-preview').textContent = '입력창을 연결하는 중…';
    }
  }

  async function refreshNanoStatus() {
    const downloadButton = document.getElementById('sp-btn-nano-download');
    const availability = await TraceLLM.availability();
    nanoReady = availability === 'available';
    downloadButton.hidden = availability !== 'downloadable' && availability !== 'downloading';
    nanoStatus.textContent = nanoReady ? '준비됨 · 이 브라우저에서 실행'
      : availability === 'downloadable' || availability === 'downloading'
        ? '모델을 받아야 합니다. 모델 받기를 누르세요.'
        : availability === 'unsupported'
          ? '이 Chrome에서는 내장 LLM을 쓸 수 없습니다. Trace 설정에서 LLM을 끄세요.'
          : `모델을 쓸 수 없습니다 (${availability}). Trace 설정에서 LLM을 끌 수 있습니다.`;
    return nanoReady;
  }

  document.getElementById('sp-btn-nano-download').onclick = async () => {
    const button = document.getElementById('sp-btn-nano-download');
    if (typeof LanguageModel === 'undefined') { await refreshNanoStatus(); return; }
    button.disabled = true;
    nanoProgress.hidden = false;
    nanoStatus.textContent = '모델 준비 중…';
    try {
      // create() is called directly from the click handler for user activation.
      const session = await LanguageModel.create({
        monitor(monitor) {
          monitor.addEventListener('downloadprogress', event => {
            nanoProgress.value = Math.round(event.loaded * 100);
            nanoStatus.textContent = `모델 받는 중 ${nanoProgress.value}%`;
          });
        }
      });
      session.destroy();
      await refreshNanoStatus();
      if (nanoReady && activeChatId) {
        const { nanoManualRequest } = await chrome.storage.local.get('nanoManualRequest');
        nanoStartedChatId = activeChatId;
        await chrome.storage.local.remove('nanoManualRequest');
        chrome.runtime.sendMessage({ type: 'START_NANO_MEMORY', chatId: activeChatId, force: true, rebuild: Boolean(nanoManualRequest?.rebuild) }).catch(() => {});
      }
    } catch (error) {
      nanoReady = false;
      nanoStatus.textContent = `모델 준비 실패: ${String(error.message || error)}`;
    } finally {
      button.disabled = false;
      nanoProgress.hidden = true;
    }
  };

  chrome.runtime.onMessage.addListener(message => {
    if (message.target === 'sidepanel' && message.type === 'LIVE_PROMPT_PREVIEW') {
      renderLivePromptPreview(message.chatId, message.draft, message.items);
    }
  });

  async function resolveActiveChatId() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const match = tab?.url?.match(/\/(?:stories\/[^/]+\/episodes|characters\/[^/]+\/chats|u\/[^/]+\/c)\/([^/?#]+)/);
      return match ? match[1] : '';
    } catch {
      return '';
    }
  }

  function renderRadar(res) {
    const radarList = document.getElementById('sp-radar-list');
    const scores = res.modelScores || {};
    const label = { OPERATIONAL: '정상', DEGRADED: '저하', IMPACTED: '지연', CRITICAL: '장애', UNSTABLE: '불안정', INACTIVE: '중지' };
    const rows = Object.values(scores).sort((x, y) => (y.score || 0) - (x.score || 0));
    const updated = res.modelScoresUpdatedAt ? new Date(res.modelScoresUpdatedAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' }) : '시각 미상';
    radarList.replaceChildren();
    if (!rows.length) { radarList.textContent = '모델 상태를 아직 받아오지 못했습니다.'; return; }
    for (const v of rows) {
      const row = document.createElement('div');
      row.className = 'sp-item sp-model-row';
      row.dataset.status = String(v.status || '').toLowerCase();
      const name = document.createElement('b');
      name.textContent = v.display || v.id;
      const badge = document.createElement('span');
      badge.className = 'sp-badge';
      badge.textContent = `${Math.round(v.score)}점 · ${(v.latencyMs / 1000).toFixed(1)}초 · ${label[v.status] || v.status || ''}`;
      row.append(name, badge);
      radarList.append(row);
    }
    const note = document.createElement('div');
    note.className = 'sp-note';
    note.textContent = `출처: IGX Radiosonde (rs.igx.kr) · 마지막 갱신 ${updated}${res.modelScoresError ? ` · ${res.modelScoresError}` : ''}`;
    radarList.append(note);
  }

  async function refresh() {
    const serial = ++refreshSerial;
    const previousChatId = activeChatId;
    const nextChatId = await resolveActiveChatId();
    if (serial !== refreshSerial) return;
    activeChatId = nextChatId;
    const roomId = activeChatId;
    const statusText = document.getElementById('sp-status-text');
    if (roomId !== previousChatId) {
      document.getElementById('sp-matched-preview').textContent = '';
      refreshLivePromptPreview();
    }
    statusText.textContent = roomId ? `연결됨 (${roomId.slice(-6)})` : '크랙 대화방 미감지';

    if (roomId) {
      const { nanoManualRequest } = await chrome.storage.local.get('nanoManualRequest');
      if (serial !== refreshSerial || activeChatId !== roomId) return;
      const manual = nanoReady && nanoManualRequest?.chatId === roomId && Date.now() - nanoManualRequest.at < 10 * 60 * 1000;
      if (manual) await chrome.storage.local.remove('nanoManualRequest');
      if (nanoReady && (nanoStartedChatId !== roomId || manual)) {
        nanoStartedChatId = roomId;
        chrome.runtime.sendMessage({ type: 'START_NANO_MEMORY', chatId: roomId, force: manual, rebuild: Boolean(manual && nanoManualRequest?.rebuild) }).catch(() => {});
      }
    }
  }

  const loadRadar = async () => renderRadar(await chrome.storage.local.get(['modelScores', 'modelScoresUpdatedAt', 'modelScoresError']));
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && (changes.modelScores || changes.modelScoresError)) loadRadar();
  });

  document.getElementById('sp-btn-sync').onclick = refreshLivePromptPreview;

  document.getElementById('sp-btn-refresh-radar').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = '갱신 중…';
    try {
      const result = await chrome.runtime.sendMessage({ type: 'REFRESH_SCORES' });
      if (!result?.success) throw Error(result?.error || '갱신 실패');
      await loadRadar();
    } catch (error) {
      document.getElementById('sp-radar-list').textContent = `모델 상태 갱신 실패: ${String(error.message || error)}`;
    } finally {
      button.disabled = false;
      button.textContent = '새로고침';
    }
  };

  refreshNanoStatus().then(refresh);
  loadRadar();
  chrome.webNavigation.onHistoryStateUpdated.addListener(details => {
    if (details.frameId === 0 && details.url.startsWith('https://crack.wrtn.ai/')) refresh();
  });
  chrome.tabs.onActivated.addListener(() => refresh());
  setInterval(refresh, 2000);
})();
