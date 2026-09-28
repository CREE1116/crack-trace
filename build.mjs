import { readFileSync, writeFileSync } from 'node:fs';

const header = `// ==UserScript==
// @name         Crack UBIS Memory (prototype)
// @namespace    local.crack.ubis-memory
// @version      0.2.0
// @description  Deterministic local retrieval of old Crack messages. No AI API.
// @match        https://crack.wrtn.ai/stories/*/episodes/*
// @match        https://crack.wrtn.ai/characters/*/chats/*
// @match        https://crack.wrtn.ai/u/*/c/*
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
writeFileSync(new URL('./dist/crack-ubis-memory.user.js', import.meta.url), `${header}\n${engine}\n${runtime}`);
