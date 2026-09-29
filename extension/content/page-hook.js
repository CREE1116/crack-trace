// Trace - MAIN World WebSocket Interceptor
(() => {
  'use strict';

  const nativeSend = WebSocket.prototype.send;
  window.__CRACK_MATRIX_STAGED_CONTEXT = null;
  const roomFromPath = () => (location.pathname.match(/\/(?:stories\/[^/]+\/episodes|characters\/[^/]+\/chats|u\/[^/]+\/c)\/([^/?#]+)/) || [])[1] || '';

  window.addEventListener('message', e => {
    if (e.data?.type === 'CRACK_MATRIX_CLEAR_STAGE') {
      window.__CRACK_MATRIX_STAGED_CONTEXT = null;
      return;
    }
    if (e.data && e.data.type === 'CRACK_MATRIX_STAGE_PAYLOAD') {
      window.__CRACK_MATRIX_STAGED_CONTEXT = {
        originalPrompt: (e.data.originalPrompt || '').trim(),
        chatId: String(e.data.chatId || ''),
        injectedContent: e.data.injectedContent,
        injectedCount: Math.max(0, Number(e.data.injectedCount) || 0)
      };
    }
  });

  WebSocket.prototype.send = function (raw) {
    if (typeof raw !== 'string') return nativeSend.call(this, raw);

    const match = /^42(\/[^,]+,)?(\d*)(\[.*)$/s.exec(raw);
    if (!match || (match[1] && match[1] !== '/v3/chats,')) return nativeSend.call(this, raw);

    try {
      const events = JSON.parse(match[3]);
      if (Array.isArray(events) && events[0] === 'send' && events[1] && typeof events[1] === 'object') {
        const payload = events[1];
        const outgoing = String(payload.message ?? payload.content ?? payload.text ?? '').trim();
        if (window.__CRACK_MATRIX_STAGED_CONTEXT?.chatId !== roomFromPath()) {
          window.__CRACK_MATRIX_STAGED_CONTEXT = null;
        }

        // If pre-staged injection is ready
        if (window.__CRACK_MATRIX_STAGED_CONTEXT) {
          // The user note is not sent with messages: Crack keeps it per chat (see SET_NATIVE_USERNOTE).
          const staged = window.__CRACK_MATRIX_STAGED_CONTEXT;
          if (staged.originalPrompt === outgoing) {
            const content = staged.injectedContent;
            const field = ['message', 'content', 'text'].find(k => typeof payload[k] === 'string') || 'message';
            events[1][field] = content;
            const rewritten = `42${match[1] || ''}${match[2]}${JSON.stringify(events)}`;

            window.__CRACK_MATRIX_STAGED_CONTEXT = null;
            const sent = nativeSend.call(this, rewritten);
            window.postMessage({ type: 'CRACK_MATRIX_INJECTED_SENT' }, '*');
            window.postMessage({ type: 'CRACK_MATRIX_SEND_RECORDED', chatId: roomFromPath(), injectedCount: staged.injectedCount }, '*');
            return sent;
          }
        }
        const sent = nativeSend.call(this, raw);
        window.postMessage({ type: 'CRACK_MATRIX_SEND_RECORDED', chatId: roomFromPath(), injectedCount: 0 }, '*');
        return sent;
      }
    } catch {}

    return nativeSend.call(this, raw);
  };

})();
