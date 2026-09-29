// Trace - sentence embeddings for "의미 검색" (runs in the offscreen document).
// Vectors are computed in the background as memories and passages appear, and kept in
// IndexedDB; sending a message only embeds the draft (a few milliseconds) and compares.
import { pipeline, env } from '../vendor/transformers.min.js';

const MODEL = 'Xenova/multilingual-e5-small';
const ORT_VERSION = '1.31.0-dev.20260914-8d85527a0';

env.allowLocalModels = false;
env.useBrowserCache = true;
// The loader ships with the extension; the 27 MB binary is fetched once when the option is on.
env.backends.onnx.wasm.wasmPaths = {
  mjs: chrome.runtime.getURL('vendor/ort-wasm-simd-threaded.asyncify.mjs'),
  wasm: `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort-wasm-simd-threaded.asyncify.wasm`
};
// Extension pages are not cross-origin isolated, so no threads.
env.backends.onnx.wasm.numThreads = 1;

const status = { state: 'idle', loaded: 0, total: 0, error: '' };
let extractor = null;
let loading = null;

function load() {
  loading ??= pipeline('feature-extraction', MODEL, {
    dtype: 'q8',
    progress_callback: event => {
      if (event.status !== 'progress' || !event.total) return;
      status.files ??= {};
      status.files[event.file] = [event.loaded, event.total];
      const parts = Object.values(status.files);
      status.loaded = parts.reduce((sum, [loaded]) => sum + loaded, 0);
      status.total = parts.reduce((sum, [, total]) => sum + total, 0);
    }
  }).then(model => {
    extractor = model;
    status.state = 'ready';
    return model;
  }).catch(error => {
    status.state = 'error';
    status.error = String(error.message || error);
    loading = null;
    throw error;
  });
  if (status.state !== 'ready') status.state = 'loading';
  return loading;
}

async function embed(kind, text) {
  const output = await extractor(`${kind}: ${text}`, { pooling: 'mean', normalize: true });
  return new Float32Array(output.data);
}

// --- vector cache: one entry per distinct text ---
function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return `${(h >>> 0).toString(36)}:${text.length}`;
}

let dbPromise = null;
function db() {
  dbPromise ??= new Promise((resolve, reject) => {
    const request = indexedDB.open('trace-embeddings', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('vectors');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}
const idb = async (mode, fn) => {
  const store = (await db()).transaction('vectors', mode).objectStore('vectors');
  return new Promise((resolve, reject) => {
    const request = fn(store);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
};

// chatId -> Map(item id -> vector) for what the service worker asked to be searchable.
const chats = new Map();
const indexing = new Map();

async function index(chatId, items) {
  await load();
  const vectors = chats.get(chatId) || new Map();
  chats.set(chatId, vectors);
  for (const { id, text } of items) {
    if (!text || vectors.has(id)) continue;
    const key = hash(text);
    let vector = await idb('readonly', store => store.get(key)).catch(() => null);
    if (!vector) {
      vector = await embed('passage', text);
      await idb('readwrite', store => store.put(vector, key)).catch(() => {});
    }
    vectors.set(id, vector);
  }
  // Items that no longer exist (deleted memories) stop being candidates.
  const alive = new Set(items.map(item => item.id));
  for (const id of vectors.keys()) if (!alive.has(id)) vectors.delete(id);
  return vectors.size;
}

async function rank(chatId, query, limit) {
  const vectors = chats.get(chatId);
  if (!extractor || !vectors?.size) return { results: [], indexed: vectors?.size || 0 };
  const q = await embed('query', query);
  const results = [];
  for (const [id, v] of vectors) {
    let score = 0;
    for (let i = 0; i < v.length; i++) score += v[i] * q[i];
    results.push({ id, score });
  }
  results.sort((a, b) => b.score - a.score);
  return { results: results.slice(0, limit), indexed: vectors.size };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== 'offscreen' || !String(message.type || '').startsWith('EMBED_')) return;
  if (message.type === 'EMBED_STATUS') {
    sendResponse({ success: true, ...status, chats: Object.fromEntries([...chats].map(([id, v]) => [id, v.size])) });
    return;
  }
  if (message.type === 'EMBED_PREPARE') {
    load().then(() => sendResponse({ success: true, state: status.state }),
      error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
  if (message.type === 'EMBED_INDEX') {
    // One indexing run per chat at a time; a newer request waits for it and fills the rest.
    const chatId = String(message.chatId || '');
    const run = (indexing.get(chatId) || Promise.resolve()).then(() => index(chatId, message.items || []));
    indexing.set(chatId, run.catch(() => {}));
    run.then(count => sendResponse({ success: true, count }), error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
  if (message.type === 'EMBED_RANK') {
    rank(String(message.chatId || ''), String(message.query || ''), Number(message.limit) || 40)
      .then(result => sendResponse({ success: true, ...result }), error => sendResponse({ success: false, error: String(error.message || error) }));
    return true;
  }
});
