import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const input = process.argv[2];
if (!input) {
  process.stderr.write('사용법: node tools/evaluate-export.mjs /path/to/chat.txt [--details]\n');
  process.exit(2);
}
const engineCode = readFileSync(new URL('../src/engine.js', import.meta.url), 'utf8');
const parserCode = readFileSync(new URL('../src/export.js', import.meta.url), 'utf8');
const { engine, parser } = vm.runInNewContext(`${engineCode}\n${parserCode}\n({engine:CrackMemoryEngine,parser:CrackChatExport})`);
const messages = parser.parse(readFileSync(input, 'utf8'));
const stats = { messages: messages.length, userTurns: 0, evaluated: 0, withCandidates: 0, autoSelected: 0, selectedUnits: 0, selectedFromUser: 0, selectedFromAssistant: 0, selectedChars: 0, olderThanTenTurns: 0 };
const examples = [];
for (let i = 0; i < messages.length; i++) {
  if (messages[i].role !== 'user') continue;
  stats.userTurns++;
  if (i < 8) continue;
  const past = messages.slice(0, i);
  const units = engine.unitsFromMessages(past, 'export');
  const query = engine.searchText(messages[i].text).slice(-4000);
  const result = engine.choose(engine.index(units), query, { maxOrder: i - 20, anchorText: engine.searchText(messages[i].text) });
  stats.evaluated++;
  if (result.ranked.length) stats.withCandidates++;
  if (result.selected.length) stats.autoSelected++;
  stats.selectedUnits += result.selected.length;
  for (const hit of result.selected) {
    if (hit.role === 'user') stats.selectedFromUser++; else stats.selectedFromAssistant++;
    stats.selectedChars += hit.line.length;
    if (i - hit.order >= 20) stats.olderThanTenTurns++;
  }
  if (examples.length < 20 && result.selected.length) {
    examples.push({ turn: i + 1, selected: result.selected.map(x => ({ source: x.messageId, ageMessages: i - x.order, score: Number(x.score.toFixed(2)), matched: x.matched.slice(0, 5) })), topCandidate: result.ranked[0] ? { source: result.ranked[0].messageId, score: Number(result.ranked[0].score.toFixed(2)) } : null, reason: result.reason });
  }
}
process.stdout.write(JSON.stringify(process.argv.includes('--details') ? { ...stats, examples } : stats, null, 2) + '\n');
