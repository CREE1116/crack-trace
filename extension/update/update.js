// Trace updater: replaces the files of this unpacked extension with the latest release.
// Chrome gives an extension no write access to its own folder, so the user picks that folder
// once (File System Access); the handle is kept and later updates only ask to confirm.
const REPO = 'CREE1116/crack-trace';
const $ = id => document.getElementById(id);
const status = (text, error = false) => { $('status').textContent = text; $('status').classList.toggle('error', error); };

// --- the picked folder, kept across updates ---
function handleStore(mode, fn) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('trace-updater', 1);
    open.onupgradeneeded = () => open.result.createObjectStore('handles');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const request = fn(open.result.transaction('handles', mode).objectStore('handles'));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    };
  });
}
const savedFolder = () => handleStore('readonly', store => store.get('extension')).catch(() => null);
const saveFolder = handle => handleStore('readwrite', store => store.put(handle, 'extension'));

async function readManifest(folder) {
  const file = await (await folder.getFileHandle('manifest.json')).getFile();
  return JSON.parse(await file.text());
}

// The folder must be the Trace that is running now, not another copy or another extension.
async function checkFolder(folder) {
  let manifest;
  try { manifest = await readManifest(folder); } catch { throw new Error('고른 폴더에 manifest.json이 없어요. manifest.json이 바로 들어 있는 extension 폴더를 골라 주세요.'); }
  const running = chrome.runtime.getManifest();
  if (manifest.name !== running.name) throw new Error('고른 폴더는 Trace가 아니에요.');
  if (manifest.version !== running.version) {
    throw new Error(`고른 폴더(${manifest.version})가 지금 켜진 Trace(${running.version})와 달라요. chrome://extensions에서 Trace가 불러온 폴더를 골라 주세요.`);
  }
}

async function folderWithPermission(forcePick) {
  let folder = forcePick ? null : await savedFolder();
  if (folder && await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') folder = null;
  if (!folder) {
    folder = await window.showDirectoryPicker({ id: 'trace-extension', mode: 'readwrite' });
    if (await folder.requestPermission({ mode: 'readwrite' }) !== 'granted') throw new Error('파일 수정이 허용되지 않았어요.');
  }
  await checkFolder(folder);
  await saveFolder(folder);
  return folder;
}

// --- the release's files ---
async function releaseFiles(tag) {
  const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/${encodeURIComponent(tag)}?recursive=1`,
    { headers: { Accept: 'application/vnd.github+json' }, cache: 'no-store' });
  if (!res.ok) throw new Error(`파일 목록을 받지 못했어요 (GitHub ${res.status}).`);
  const tree = await res.json();
  if (tree.truncated) throw new Error('파일 목록이 너무 커서 받지 못했어요.');
  return tree.tree.filter(entry => entry.type === 'blob' && entry.path.startsWith('extension/'))
    .map(entry => ({ path: entry.path.slice('extension/'.length), source: entry.path, size: entry.size }));
}

async function download(tag, files) {
  const out = new Map();
  let done = 0;
  $('progress').hidden = false;
  $('progress').max = files.length;
  const queue = [...files];
  const worker = async () => {
    for (let file; (file = queue.shift());) {
      const res = await fetch(`https://raw.githubusercontent.com/${REPO}/${encodeURIComponent(tag)}/${file.source.split('/').map(encodeURIComponent).join('/')}`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`${file.path}을(를) 받지 못했어요 (${res.status}).`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      if (bytes.length !== file.size) throw new Error(`${file.path}이(가) 끝까지 받아지지 않았어요.`);
      out.set(file.path, bytes);
      $('progress').value = ++done;
      status(`받는 중 ${done}/${files.length}`);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return out;
}

async function writeFile(folder, path, bytes) {
  const parts = path.split('/');
  let dir = folder;
  for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
  const writable = await (await dir.getFileHandle(parts.at(-1), { create: true })).createWritable();
  await writable.write(bytes);
  await writable.close();
}

async function update(info, forcePick = false) {
  $('update').disabled = true;
  $('pick').disabled = true;
  try {
    status('폴더 확인 중…');
    const folder = await folderWithPermission(forcePick);
    status('파일 목록 받는 중…');
    const files = await releaseFiles(info.tag);
    if (!files.some(file => file.path === 'manifest.json')) throw new Error('릴리즈에 manifest.json이 없어요.');
    const bytes = await download(info.tag, files);
    const manifest = JSON.parse(new TextDecoder().decode(bytes.get('manifest.json')));
    if (manifest.version !== info.latest) throw new Error('받은 파일의 버전이 릴리즈와 달라요.');
    // Everything is here; write it. manifest.json goes last so Chrome never sees a new
    // manifest over old files.
    status('파일 쓰는 중…');
    for (const [path, content] of bytes) if (path !== 'manifest.json') await writeFile(folder, path, content);
    await writeFile(folder, 'manifest.json', bytes.get('manifest.json'));
    status(`${info.latest}(으)로 업데이트했어요. Trace를 다시 켭니다. 열려 있는 크랙 탭은 새로고침하세요.`);
    setTimeout(() => chrome.runtime.reload(), 1500);
  } catch (error) {
    if (error?.name === 'AbortError') status('폴더 선택을 취소했어요.');
    else status(String(error?.message || error), true);
    $('update').disabled = false;
    $('pick').disabled = false;
  }
}

async function init() {
  const info = await chrome.runtime.sendMessage({ type: 'GET_UPDATE_INFO', force: true }).catch(() => null);
  if (!info?.success) { $('versions').textContent = `새 버전을 확인하지 못했어요. ${info?.error || ''}`; return; }
  $('versions').textContent = info.available
    ? `지금 ${info.current} → 새 버전 ${info.latest}`
    : `지금 ${info.current} · 최신 버전입니다.`;
  if (info.notes) { $('notes').textContent = info.notes; $('notes').hidden = false; }
  if (!('showDirectoryPicker' in window)) { status('이 브라우저는 폴더 쓰기를 지원하지 않아요. 릴리즈에서 zip을 받아 직접 교체해 주세요.', true); return; }
  $('update').disabled = !info.available;
  $('update').onclick = () => update(info);
  $('pick').onclick = () => update(info, true);
  $('pick').disabled = !info.available;
}
init();
