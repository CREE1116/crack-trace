// Trace - MAIN World WebSocket Interceptor
(() => {
  'use strict';

  const nativeSend = WebSocket.prototype.send;
  window.__CRACK_MATRIX_STAGED_CONTEXT = null;
  const roomFromPath = () => (location.pathname.match(/\/(?:stories\/[^/]+\/episodes|characters\/[^/]+\/chats|u\/[^/]+\/c)\/([^/?#]+)/) || [])[1] || '';
  // How long a message may wait for its memory when it was sent before the prepared prompt
  // matched it. Preparing takes tens of milliseconds; meaning search can add up to 400 ms.
  const PREPARE_WAIT_MS = 800;
  const waiting = new Map();
  let requestSerial = 0;

  window.addEventListener('message', e => {
    if (e.source !== window) return;
    if (e.data?.type === 'CRACK_MATRIX_CLEAR_STAGE') {
      window.__CRACK_MATRIX_STAGED_CONTEXT = null;
      return;
    }
    if (e.data?.type === 'CRACK_MATRIX_STAGE_PAYLOAD') {
      window.__CRACK_MATRIX_STAGED_CONTEXT = {
        originalPrompt: (e.data.originalPrompt || '').trim(),
        chatId: String(e.data.chatId || ''),
        injectedContent: e.data.injectedContent,
        injectedCount: Math.max(0, Number(e.data.injectedCount) || 0)
      };
      return;
    }
    if (e.data?.type === 'CRACK_MATRIX_PREPARED') waiting.get(e.data.requestId)?.(e.data);
  });

  function sendRewritten(socket, match, events, field, content, injectedCount) {
    events[1][field] = content;
    const sent = nativeSend.call(socket, `42${match[1] || ''}${match[2]}${JSON.stringify(events)}`);
    window.postMessage({ type: 'CRACK_MATRIX_INJECTED_SENT' }, '*');
    window.postMessage({ type: 'CRACK_MATRIX_SEND_RECORDED', chatId: roomFromPath(), injectedCount }, '*');
    return sent;
  }

  function sendPlain(socket, raw, withoutMemory) {
    const sent = nativeSend.call(socket, raw);
    window.postMessage({ type: 'CRACK_MATRIX_SEND_RECORDED', chatId: roomFromPath(), injectedCount: 0 }, '*');
    if (withoutMemory) window.postMessage({ type: 'CRACK_MATRIX_SENT_WITHOUT_MEMORY' }, '*');
    return sent;
  }

  WebSocket.prototype.send = function (raw) {
    if (typeof raw !== 'string') return nativeSend.call(this, raw);

    const match = /^42(\/[^,]+,)?(\d*)(\[.*)$/s.exec(raw);
    if (!match || (match[1] && match[1] !== '/v3/chats,')) return nativeSend.call(this, raw);

    try {
      const events = JSON.parse(match[3]);
      if (Array.isArray(events) && events[0] === 'send' && events[1] && typeof events[1] === 'object') {
        const payload = events[1];
        const outgoing = String(payload.message ?? payload.content ?? payload.text ?? '').trim();
        const field = ['message', 'content', 'text'].find(k => typeof payload[k] === 'string') || 'message';
        const room = roomFromPath();
        const staged = window.__CRACK_MATRIX_STAGED_CONTEXT;
        window.__CRACK_MATRIX_STAGED_CONTEXT = null;

        // The prompt prepared while typing is for exactly this text: send it at once.
        // The user note is not sent with messages: Crack keeps it per chat (see SET_NATIVE_USERNOTE).
        if (staged && staged.chatId === room && staged.originalPrompt === outgoing) {
          return sendRewritten(this, match, events, field, staged.injectedContent, staged.injectedCount);
        }
        if (!room || !outgoing) return sendPlain(this, raw, false);

        // Otherwise ask Trace for this text now and hold the message until the answer, or
        // send it without memory (and say so) if the answer is late.
        const socket = this;
        const requestId = `${Date.now()}-${++requestSerial}`;
        let done = false;
        const finish = result => {
          if (done) return;
          done = true;
          waiting.delete(requestId);
          clearTimeout(timer);
          try {
            if (result?.ok && result.content && result.content !== outgoing) {
              sendRewritten(socket, match, events, field, result.content, result.injectedCount || 0);
            } else {
              sendPlain(socket, raw, !result?.ok);
            }
          } catch {}
        };
        const timer = setTimeout(() => finish(null), PREPARE_WAIT_MS);
        waiting.set(requestId, finish);
        window.postMessage({ type: 'CRACK_MATRIX_PREPARE_NOW', requestId, chatId: room, text: outgoing }, '*');
        return undefined;
      }
    } catch {}

    return nativeSend.call(this, raw);
  };

})();
