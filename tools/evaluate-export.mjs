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
const stats = { messages: messages.length, userTurns: 0, evaluated: 0, withCandidates: 0, previousStrictSelected: 0, previousStrictUnits: 0, queriesExpanded: 0, contextApplied: 0, contextSources: 0, contextChars: 0 };
const examples = [];
for (let i = 0; i < messages.length; i++) {
  if (messages[i].role !== 'user') continue;
  stats.userTurns++;
  if (i < 8) continue;
  const past = messages.slice(0, i);
  const units = engine.unitsFromMessages(past, 'export');
  const ix = engine.index(units);
  const query = engine.contextQuery(ix, past, messages[i].text);
  if (query !== engine.searchText(messages[i].text).slice(-4000)) stats.queriesExpanded++;
  const result = engine.choose(ix, query, { maxOrder: i - 20, anchorText: engine.searchText(messages[i].text) });
  const context = engine.contextFor(ix, past, query, { maxOrder: i - 20, budget: engine.userContextBudget(messages[i].text) });
  const composed = engine.composeUser(messages[i].text, context.selected);
  stats.evaluated++;
  if (result.ranked.length) stats.withCandidates++;
  if (result.selected.length) stats.previousStrictSelected++;
  if (composed !== messages[i].text) stats.contextApplied++;
  stats.contextSources += context.selected.length;
  stats.contextChars += composed.length - messages[i].text.length;
  stats.previousStrictUnits += result.selected.length;
  if (examples.length < 20 && result.selected.length) {
    examples.push({ turn: i + 1, selected: result.selected.map(x => ({ source: x.messageId, ageMessages: i - x.order, score: Number(x.score.toFixed(2)), matched: x.matched.slice(0, 5) })), topCandidate: result.ranked[0] ? { source: result.ranked[0].messageId, score: Number(result.ranked[0].score.toFixed(2)) } : null, reason: result.reason });
  }
}
process.stdout.write(JSON.stringify(process.argv.includes('--details') ? { ...stats, examples } : stats, null, 2) + '\n');
