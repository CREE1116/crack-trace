import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../extension/content/page-hook.js', import.meta.url), 'utf8');

function hookHarness() {
  const listeners = new Map();
  const sent = [];
  const posted = [];
  const window = {
    addEventListener(type, fn) { listeners.set(type, fn); },
    postMessage(message) { posted.push(message); },
    dispatch(message) { listeners.get('message')?.({ source: window, data: message }); }
  };
  const timers = [];
  const setTimeout = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const clearTimeout = id => { if (timers[id - 1]) timers[id - 1].fn = null; };
  class WebSocket {
    send(frame) { sent.push(frame); }
  }
  const location = { pathname: '/stories/story/episodes/room-a' };
  const context = vm.createContext({ window, WebSocket, location, setTimeout, clearTimeout });
  vm.runInContext(code, context);
  const runTimers = () => timers.splice(0).forEach(timer => timer.fn?.());
  return { window, location, sent, posted, runTimers, socket: new WebSocket() };
}

test('a staged memory from the previous room cannot be sent in the next room', () => {
  const h = hookHarness();
  h.window.dispatch({ type: 'CRACK_MATRIX_STAGE_PAYLOAD', chatId: 'room-a',
    originalPrompt: '안녕', injectedContent: '이전 채팅의 비밀\n안녕', injectedCount: 1 });
  h.location.pathname = '/stories/story/episodes/room-b';
  const frame = '42["send",{"message":"안녕"}]';
  h.socket.send(frame);
  assert.equal(h.window.__CRACK_MATRIX_STAGED_CONTEXT, null);
  const request = h.posted.find(message => message.type === 'CRACK_MATRIX_PREPARE_NOW');
  assert.equal(request.chatId, 'room-b', 'the next room prepares its own memory');
  h.window.dispatch({ type: 'CRACK_MATRIX_PREPARED', requestId: request.requestId, ok: true, content: '안녕', injectedCount: 0 });
  assert.equal(h.sent[0], frame);
  assert.doesNotMatch(h.sent.join(''), /이전 채팅의 비밀/);
  assert.equal(h.posted.at(-1).injectedCount, 0);
});

test('a message sent before its prompt was ready waits for it, or goes out plainly and says so', () => {
  const h = hookHarness();
  h.window.dispatch({ type: 'CRACK_MATRIX_STAGE_PAYLOAD', chatId: 'room-a',
    originalPrompt: '안녕하', injectedContent: '기억\n안녕하', injectedCount: 1 });
  h.socket.send('42["send",{"message":"안녕하세요"}]');
  assert.equal(h.sent.length, 0, 'held while the exact text is prepared');
  const request = h.posted.find(message => message.type === 'CRACK_MATRIX_PREPARE_NOW');
  assert.equal(request.text, '안녕하세요');
  h.window.dispatch({ type: 'CRACK_MATRIX_PREPARED', requestId: request.requestId, ok: true, content: '새 기억\n안녕하세요', injectedCount: 1 });
  assert.match(h.sent[0], /새 기억/);
  h.runTimers();
  assert.equal(h.sent.length, 1, 'the timeout after an answer sends nothing twice');

  h.socket.send('42["send",{"message":"또 보낸다"}]');
  h.runTimers();
  assert.equal(h.sent[1], '42["send",{"message":"또 보낸다"}]');
  assert.ok(h.posted.some(message => message.type === 'CRACK_MATRIX_SENT_WITHOUT_MEMORY'));
  const late = h.posted.filter(message => message.type === 'CRACK_MATRIX_PREPARE_NOW').at(-1);
  h.window.dispatch({ type: 'CRACK_MATRIX_PREPARED', requestId: late.requestId, ok: true, content: '늦은 기억\n또 보낸다' });
  assert.equal(h.sent.length, 2, 'a late answer is ignored');
});

test('matching room uses its staged context and records the actual send', () => {
  const h = hookHarness();
  h.window.dispatch({ type: 'CRACK_MATRIX_STAGE_PAYLOAD', chatId: 'room-a',
    originalPrompt: '안녕', injectedContent: '관련 기억\n안녕', injectedCount: 1 });
  h.socket.send('42["send",{"message":"안녕"}]');
  assert.match(h.sent[0], /관련 기억/);
  assert.equal(h.posted.at(-1).injectedCount, 1);
});
