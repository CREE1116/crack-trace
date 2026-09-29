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
    dispatch(message) { listeners.get('message')?.({ data: message }); }
  };
  class WebSocket {
    send(frame) { sent.push(frame); }
  }
  const location = { pathname: '/stories/story/episodes/room-a' };
  const context = vm.createContext({ window, WebSocket, location });
  vm.runInContext(code, context);
  return { window, location, sent, posted, socket: new WebSocket() };
}

test('a staged memory from the previous room cannot be sent in the next room', () => {
  const h = hookHarness();
  h.window.dispatch({ type: 'CRACK_MATRIX_STAGE_PAYLOAD', chatId: 'room-a',
    originalPrompt: '안녕', injectedContent: '이전 채팅의 비밀\n안녕', injectedCount: 1 });
  h.location.pathname = '/stories/story/episodes/room-b';
  const frame = '42["send",{"message":"안녕"}]';
  h.socket.send(frame);
  assert.equal(h.sent[0], frame);
  assert.equal(h.window.__CRACK_MATRIX_STAGED_CONTEXT, null);
  assert.equal(h.posted.at(-1).injectedCount, 0);
});

test('matching room uses its staged context and records the actual send', () => {
  const h = hookHarness();
  h.window.dispatch({ type: 'CRACK_MATRIX_STAGE_PAYLOAD', chatId: 'room-a',
    originalPrompt: '안녕', injectedContent: '관련 기억\n안녕', injectedCount: 1 });
  h.socket.send('42["send",{"message":"안녕"}]');
  assert.match(h.sent[0], /관련 기억/);
  assert.equal(h.posted.at(-1).injectedCount, 1);
});
