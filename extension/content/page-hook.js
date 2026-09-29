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
        userNote: e.data.userNote || '',
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
          const staged = window.__CRACK_MATRIX_STAGED_CONTEXT;
          const uNote = staged.userNote;

          // Native User Note injection into WebSocket payload
          if (uNote) {
            if ('userNote' in payload) payload.userNote = uNote;
            else if ('user_note' in payload) payload.user_note = uNote;
            else payload.userNote = uNote;
          }

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
          } else if (uNote) {
            const rewritten = `42${match[1] || ''}${match[2]}${JSON.stringify(events)}`;
            const sent = nativeSend.call(this, rewritten);
            window.postMessage({ type: 'CRACK_MATRIX_SEND_RECORDED', chatId: roomFromPath(), injectedCount: 0 }, '*');
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
