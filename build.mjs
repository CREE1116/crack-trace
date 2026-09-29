// Builds Trace Lite (Tampermonkey) from the extension's shared engine and src/userscript.js.
//   node build.mjs          write dist/trace-lite.user.js
//   node build.mjs --check  exit 1 if dist/ is not the current build (used by CI)
import { readFileSync, writeFileSync } from 'node:fs';

// One version for both products: the extension manifest's.
const { version } = JSON.parse(readFileSync(new URL('./extension/manifest.json', import.meta.url), 'utf8'));
// Tampermonkey checks this URL and updates the script itself when @version goes up.
const RAW = 'https://raw.githubusercontent.com/CREE1116/crack-trace/main/dist/trace-lite.user.js';

const header = `// ==UserScript==
// @name         Trace Lite
// @namespace    local.crack.ubis-memory
// @version      ${version}
// @description  Deterministic local retrieval of old Crack messages. No AI API.
// @homepageURL  https://github.com/CREE1116/crack-trace
// @supportURL   https://github.com/CREE1116/crack-trace/issues
// @updateURL    ${RAW}
// @downloadURL  ${RAW}
// @match        https://crack.wrtn.ai/*
// @run-at       document-start
// @connect      crack-api.wrtn.ai
// @connect      contents-api.wrtn.ai
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// ==/UserScript==
`;
const engine = readFileSync(new URL('./extension/engine/engine.js', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('./src/userscript.js', import.meta.url), 'utf8');
const output = `${header}\n${engine}\n${runtime}`;
const target = new URL('./dist/trace-lite.user.js', import.meta.url);

if (process.argv.includes('--check')) {
  let current = '';
  try { current = readFileSync(target, 'utf8'); } catch {}
  if (current !== output) {
    console.error('dist/trace-lite.user.js is out of date: run `node build.mjs` and commit it.');
    process.exit(1);
  }
} else {
  writeFileSync(target, output);
}
