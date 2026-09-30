// Radiosonde model-name matching used for badges in Crack's model dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const src = fs.readFileSync(new URL('../extension/content/content.js', import.meta.url), 'utf8');
const code = src.slice(src.indexOf('  let modelScores = {};'), src.indexOf('  function badgeFor(m)'));
const { setModelScores, modelForText } = new Function(code + '; return { setModelScores, modelForText };')();

const ids = ['claude-opus-5', 'claude-opus-4.8', 'claude-sonnet-5', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview', 'gpt-5.6-sol'];
setModelScores(Object.fromEntries(ids.map(id => [id, { id }])));
const idOf = t => modelForText(t)?.id ?? null;

test('matches monitored models by visible name', () => {
  assert.equal(idOf('Claude Opus 5'), 'claude-opus-5');
  assert.equal(idOf('ChatGPT 5.6 Sol'), 'gpt-5.6-sol');
  assert.equal(idOf('Gemini 3.1 Pro (Preview)'), 'gemini-3.1-pro-preview');
});

test('prefers the longest id and respects version boundaries', () => {
  assert.equal(idOf('Gemini 3.5 Flash Lite'), 'gemini-3.5-flash-lite');
  assert.equal(idOf('Gemini 3.5 Flash'), 'gemini-3.5-flash');
  assert.equal(idOf('Claude Opus 5.5'), null);
});

test("matches Crack's descriptions that omit the vendor", () => {
  assert.equal(idOf('Opus 5를 활용한 문학적인 서사로 매 순간이 명장면인 스토리'), 'claude-opus-5');
  assert.equal(idOf('Opus 5.5를 활용한 살아숨쉬는 캐릭터'), null);
  assert.equal(idOf('Opus 4.8을 활용한 깊은 감정선'), 'claude-opus-4.8');
  assert.equal(idOf('Sonnet-5를 활용한 맞춤 전개'), 'claude-sonnet-5');
  assert.equal(idOf('Gemini 2.5 Pro를 활용한 상황 묘사'), null);   // not in this test's id list
  assert.equal(idOf('Gemini 3.1 Pro을 활용한 한층 깊어진 몰입감'), 'gemini-3.1-pro-preview');  // release tag
  assert.equal(idOf('Gemini 3.5 Flash'), 'gemini-3.5-flash');      // no bare "3.5 flash" alias
});

test('never guesses for Crack-only model names', () => {
  assert.equal(idOf('프로챗 1.0'), null);
  assert.equal(idOf('하이퍼챗 3.0'), null);
});

test('snapshot dates and release tags on an id still name the same model', () => {
  setModelScores(Object.fromEntries(['claude-sonnet-4-5-20250929', 'claude-sonnet-4.6-latest', 'claude-opus-5'].map(id => [id, { id }])));
  assert.equal(idOf('Sonnet-4.5를 활용한 생동감 넘치고 재미있는 스토리'), 'claude-sonnet-4-5-20250929');
  assert.equal(idOf('Sonnet-4.6을 활용한 다채로운 인물 묘사'), 'claude-sonnet-4.6-latest');
  assert.equal(idOf('Sonnet-4를 활용한'), null, 'the date is not a version');
  setModelScores(Object.fromEntries(ids.map(id => [id, { id }])));
});
