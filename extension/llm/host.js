// Trace - Built-in LLM host (Prompt API)
// The Prompt API exists only in extension documents, not in the service worker.
// This script runs in the offscreen document (so memory keeps building while the
// side panel is closed) and in the side panel (fallback, and model download,
// which needs a user click).
const TraceLLM = (() => {
  'use strict';

  // Korean is not in Chrome's supported output list yet. Declare it once Chrome accepts it;
  // until then leave languages unset rather than attest a language we do not produce.
  const KOREAN_TEXT = { expectedInputs: [{ type: 'text', languages: ['ko'] }], expectedOutputs: [{ type: 'text', languages: ['ko'] }] };
  let languageOptions = null;

  async function availability() {
    if (typeof LanguageModel === 'undefined') return 'unsupported';
    try { return await LanguageModel.availability(); } catch { return 'unavailable'; }
  }

  function sessionOptions() {
    languageOptions ??= LanguageModel.availability(KOREAN_TEXT)
      .then(state => state === 'unavailable' ? {} : KOREAN_TEXT)
      .catch(() => ({}));
    return languageOptions;
  }

  // Prompts mark the conversation with this line; only text after it may be shortened.
  const WINDOW_MARKER = '\n[대화]\n';

  // Korean costs many tokens, so a full batch can exceed the model's input quota.
  // Shorten the conversation part (keeping its start and end) until it fits.
  async function fitToQuota(session, text) {
    if (!session.inputQuota || !session.measureInputUsage) return text;
    let out = text;
    for (let attempt = 0; attempt < 4; attempt++) {
      const usage = await session.measureInputUsage(out);
      if (usage <= session.inputQuota * 0.9) return out;
      const at = out.indexOf(WINDOW_MARKER);
      if (at < 0) return out;
      const head = out.slice(0, at + WINDOW_MARKER.length);
      const body = out.slice(at + WINDOW_MARKER.length);
      const keep = Math.floor(body.length * (session.inputQuota * 0.85) / usage);
      out = `${head}${body.slice(0, Math.floor(keep * 0.6))}\n[중간 생략]\n${body.slice(body.length - Math.floor(keep * 0.4))}`;
    }
    return out;
  }

  // Running prompts; LLM_ABORT cancels them so a stop takes effect immediately.
  const running = new Set();

  async function prompt(text) {
    const state = await availability();
    if (state !== 'available') throw Object.assign(Error(`LLM 모델 사용 불가 (${state})`), { state });
    const controller = new AbortController();
    running.add(controller);
    let session = null;
    try {
      session = await LanguageModel.create({ ...(await sessionOptions()), signal: controller.signal });
      const answer = String(await session.prompt(await fitToQuota(session, text), { signal: controller.signal })).trim();
      return { text: answer, quota: Number(session.inputQuota) || 0 };
    } finally {
      running.delete(controller);
      session?.destroy();
    }
  }

  function abortAll() {
    for (const controller of running) controller.abort();
    running.clear();
  }

  // Answers LLM_STATUS / LLM_PROMPT addressed to this document.
  function listen(target) {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.target !== target) return;
      if (message.type === 'LLM_ABORT') {
        abortAll();
        return;
      }
      if (message.type === 'LLM_STATUS') {
        availability().then(state => sendResponse({ success: true, state }));
        return true;
      }
      if (message.type === 'LLM_PROMPT') {
        prompt(String(message.prompt || ''))
          .then(({ text, quota }) => sendResponse({ success: true, text, quota }))
          .catch(error => sendResponse({ success: false, state: error.state || '', error: String(error.message || error) }));
        return true;
      }
    });
  }

  return { availability, prompt, abortAll, listen };
})();
