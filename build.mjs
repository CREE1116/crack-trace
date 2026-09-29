import { readFileSync, writeFileSync } from 'node:fs';

const header = `// ==UserScript==
// @name         LoreCache Lite
// @namespace    local.crack.ubis-memory
// @version      0.6.0
// @description  Deterministic local retrieval of old Crack messages. No AI API.
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
const engine = readFileSync(new URL('./src/engine.js', import.meta.url), 'utf8');
const runtime = readFileSync(new URL('./src/userscript.js', import.meta.url), 'utf8');
writeFileSync(new URL('./dist/lorecache-lite.user.js', import.meta.url), `${header}\n${engine}\n${runtime}`);
