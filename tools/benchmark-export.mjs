import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const [chatPath, casesPath] = process.argv.slice(2);
if (!chatPath || !casesPath) {
  process.stderr.write('사용법: node tools/benchmark-export.mjs /path/to/chat.txt /path/to/private-cases.json\n');
  process.exit(2);
}

const engineCode = readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
const parserCode = readFileSync(new URL('../src/export.js', import.meta.url), 'utf8');
const { engine, parser } = vm.runInNewContext(`${engineCode}\n${parserCode}\n({engine:CrackMemoryEngine,parser:CrackChatExport})`);
const messages = parser.parse(readFileSync(chatPath, 'utf8'));
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
if (!Array.isArray(cases) || !cases.length) throw Error('평가 사례가 비어 있습니다.');
const ix = engine.index(engine.unitsFromMessages(messages, 'export'));
const maxOrder = Math.max(0, messages.length - 20);

const rows = cases.map(item => {
  if (!item.id || !item.query || !Array.isArray(item.evidence) || !item.evidence.length) throw Error('평가 사례 형식이 잘못되었습니다.');
  const result = engine.choose(ix, item.query, { maxOrder, anchorText: item.query });
  const isEvidence = hit => item.evidence.some(ref => hit.messageId === `export-${String(ref.message).padStart(4, '0')}` && hit.text.includes(ref.contains));
  const index = result.ranked.findIndex(isEvidence);
  return { id: item.id, evidenceRank: index + 1, top5: index >= 0 && index < 5, autoSelected: result.selected.length > 0, autoCorrect: result.selected.some(isEvidence) };
});
process.stdout.write(JSON.stringify({
  cases: rows.length,
  answerInTop5: rows.filter(row => row.top5).length,
  autoSelected: rows.filter(row => row.autoSelected).length,
  autoCorrect: rows.filter(row => row.autoCorrect).length,
  rows,
}, null, 2) + '\n');
