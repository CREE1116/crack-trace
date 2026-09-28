import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const code = readFileSync(new URL('../src/export.js', import.meta.url), 'utf8');
const parser = vm.runInNewContext(`${code}\nCrackChatExport`);

test('Crack plain-text export preserves message order and roles', () => {
  const text = '# 제목\n# 추출 정보\n\n[AI]\n> N+1 | 장면\n\n첫 답변\n\n────────────────\n\n[유저]\n다음 행동\n\n────────────────\n\n[AI]\n후속 답변';
  const result = parser.parse(text);
  assert.deepEqual(Array.from(result, m => m.role), ['assistant', 'user', 'assistant']);
  assert.equal(result[1].text, '다음 행동');
  assert.equal(result[2].id, 'export-0003');
});
