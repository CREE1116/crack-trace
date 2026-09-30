import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const engineSource = readFileSync(new URL('../extension/engine/engine.js', import.meta.url), 'utf8');
const engine = vm.runInNewContext(`${engineSource}\nCrackMatrixEngine`);
const contentSource = readFileSync(new URL('../extension/content/content.js', import.meta.url), 'utf8');
const start = contentSource.indexOf('  let previewResult = null;');
const end = contentSource.indexOf('  function renderPreviewItems(', start);
assert.ok(start >= 0 && end > start);
const selection = vm.runInNewContext(`let stagedPrompt = '';
  ${contentSource.slice(start, end)}
  ({ selectedForSend, excludedPreviewLines, setDraft: value => { stagedPrompt = value; }, previewKey })`,
{ CrackMatrixEngine: engine });

test('excluding a preview item changes the exact outgoing text only for the current draft', () => {
  const draft = '은빛 열쇠를 찾는다';
  const items = [
    { type: 'summary', title: '열쇠', line: '[12] 은빛 열쇠는 탑에 있다.' },
    { type: 'lore', title: '탑', line: '설정·탑｜북쪽 문은 잠겨 있다.' }
  ];
  const res = { success: true, selected: items, currentTurn: 31,
    content: engine.composeUser(draft, items, 2000, 31) };
  selection.setDraft(draft);
  assert.equal(selection.selectedForSend(res, draft).content, res.content);

  selection.excludedPreviewLines.add(selection.previewKey(items[0]));
  const one = selection.selectedForSend(res, draft);
  assert.equal(one.selected.length, 1);
  assert.equal(one.content, engine.composeUser(draft, [items[1]], 2000, 31));
  assert.ok(!one.content.includes(items[0].line));

  selection.excludedPreviewLines.add(selection.previewKey(items[1]));
  assert.equal(selection.selectedForSend(res, draft).content, draft);
  const otherDraft = '다른 입력';
  const other = { ...res, content: engine.composeUser(otherDraft, items, 2000, 31) };
  assert.equal(selection.selectedForSend(other, otherDraft).content, other.content);
});
