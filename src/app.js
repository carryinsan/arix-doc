import { processDocument, createSearchablePdf, exportCsvBundle, getSupportedLanguages, releaseOcrMemory } from './engine.js';

const $ = (id) => document.getElementById(id);
const queuedFiles = [];
const processed = new Map();
let activeResult = null;
let activeFile = null;
let abortController = null;
let authMode = 'login';
let dashboardUser = null;
let latestKey = '';
let toastTimer;

function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => node.classList.remove('show'), 3200);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

function setNav(view) {
  const workspace = view === 'workspace';
  $('workspace-view').style.display = workspace ? 'block' : 'none';
  $('developer-view').style.display = workspace ? 'none' : 'block';
  $('nav-workspace').classList.toggle('active', workspace);
  $('nav-developers').classList.toggle('active', !workspace);
  if (!workspace) loadDashboard();
}

function addFiles(fileList) {
  for (const file of Array.from(fileList || [])) {
    const key = `${file.name}:${file.size}:${file.lastModified}`;
    if (queuedFiles.some((item) => item.key === key)) continue;
    queuedFiles.push({ key, file, status: 'Queued' });
  }
  renderQueue();
}

function renderQueue() {
  const host = $('file-queue');
  host.replaceChildren();
  for (const item of queuedFiles) {
    const row = document.createElement('div');
    row.className = 'fileitem';
    const meta = document.createElement('div'); meta.className = 'filemeta';
    const name = document.createElement('div'); name.className = 'filename'; name.textContent = item.file.name;
    const size = document.createElement('div'); size.className = 'filesize'; size.textContent = `${formatBytes(item.file.size)} · ${item.status}`;
    meta.append(name, size);
    const remove = document.createElement('button'); remove.className = 'remove-file'; remove.type = 'button'; remove.textContent = '×'; remove.setAttribute('aria-label', `Remove ${item.file.name}`);
    remove.disabled = Boolean(abortController);
    remove.addEventListener('click', () => { const index = queuedFiles.findIndex((f) => f.key === item.key); if (index >= 0) queuedFiles.splice(index, 1); renderQueue(); });
    row.append(meta, remove); host.append(row);
  }
  $('process-btn').disabled = queuedFiles.filter((f) => f.status === 'Queued' || f.status === 'Failed').length === 0 || Boolean(abortController);
}

function updateProgress(detail) {
  const percent = Number.isFinite(detail?.percent) ? detail.percent : null;
  if (percent !== null) $('progress-bar').style.width = `${Math.max(0, Math.min(100, percent))}%`;
  let message = detail?.message || '';
  if (detail?.phase === 'pages') message = `Page ${detail.page} of ${detail.total} · ${detail.nativePages} native · ${detail.ocrPages} OCR`;
  if (detail?.phase === 'sheets' || detail?.phase === 'slides') message = `${detail.phase === 'sheets' ? 'Sheet' : 'Slide'} ${detail.page} of ${detail.total}`;
  if (detail?.phase === 'complete') message = 'Extraction complete.';
  $('status-line').textContent = message || 'Working locally…';
}

function renderResult(file, result) {
  activeFile = file;
  activeResult = result;
  $('empty-state').classList.add('hidden');
  $('result-content').classList.remove('hidden');
  $('result-count').textContent = `${result.processing.pageCount} units processed`;
  $('result-filename').textContent = result.filename;
  $('result-summary').textContent = `${formatBytes(file.size)} · ${result.processing.format} · ${result.processing.method}`;
  $('stat-pages').textContent = result.processing.pageCount;
  $('stat-native').textContent = result.processing.nativePages ?? 0;
  $('stat-ocr').textContent = result.processing.ocrPages ?? 0;
  $('stat-time').textContent = `${(result.processing.elapsedMs / 1000).toFixed(1)}s`;
  $('extracted-text').value = result.text;
  $('progress-bar').style.width = '100%';
  $('status-line').textContent = `Finished · ${result.processing.method} · ${result.pages.length} page/sheet records`;
  $('result-method').textContent = `Method: ${result.processing.method}${result.processing.engine ? ` · ${result.processing.engine}` : ''}`;
  $('result-block-count').textContent = `${result.blocks.length.toLocaleString()} extracted blocks`;
  $('download-searchable').disabled = !file.name.toLowerCase().endsWith('.pdf') || !result.pages.some((p) => p.source === 'ocr');
  $('download-searchable').textContent = 'Searchable PDF';
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

async function exportText(type) {
  if (!activeResult) return;
  const base = activeResult.filename.replace(/\.[^.]+$/, '');
  let blob; let filename;
  if (type === 'txt') { blob = new Blob([activeResult.text], { type: 'text/plain;charset=utf-8' }); filename = `${base}.txt`; }
  else if (type === 'md') { blob = new Blob([`# ${activeResult.filename}\n\n${activeResult.text}`], { type: 'text/markdown;charset=utf-8' }); filename = `${base}.md`; }
  else if (type === 'json') { blob = new Blob([JSON.stringify(activeResult, null, 2)], { type: 'application/json;charset=utf-8' }); filename = `${base}.json`; }
  else if (type === 'csv') { const exported = await exportCsvBundle(activeResult); blob = exported.blob; filename = `${base}.${exported.extension}`; }
  else {
    const escaped = activeResult.text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>${activeResult.filename.replace(/[&<>]/g, '')}</title><body><pre style="white-space:pre-wrap;font:14px/1.6 system-ui">${escaped}</pre></body></html>`;
    blob = new Blob([html], { type: 'text/html;charset=utf-8' }); filename = `${base}.html`;
  }
  downloadBlob(blob, filename);
}

async function processQueue() {
  const pending = queuedFiles.filter((item) => item.status === 'Queued' || item.status === 'Failed');
  if (!pending.length) return;
  abortController = new AbortController();
  $('cancel-btn').disabled = false;
  $('process-btn').disabled = true;
  renderQueue();
  const options = { lang: $('language').value, engine: $('ocr-engine').value, enhance: $('enhance').checked, signal: abortController.signal, onProgress: updateProgress };
  try {
    for (const item of pending) {
      if (abortController.signal.aborted) break;
      item.status = 'Processing'; renderQueue();
      $('progress-bar').style.width = '0%';
      $('status-line').textContent = `Inspecting ${item.file.name}…`;
      try {
        const result = await processDocument(item.file, options);
        processed.set(item.key, { file: item.file, result });
        item.status = 'Complete';
        renderResult(item.file, result);
      } catch (error) {
        item.status = error.name === 'AbortError' ? 'Cancelled' : 'Failed';
        $('status-line').textContent = `${item.file.name}: ${error.message}`;
        if (error.name !== 'AbortError') toast(error.message);
        if (error.name === 'AbortError') break;
      }
      renderQueue();
    }
  } finally {
    abortController = null;
    $('cancel-btn').disabled = true;
    renderQueue();
  }
}

async function exportSearchablePdf() {
  if (!activeFile || !activeResult) return;
  $('download-searchable').disabled = true;
  $('download-searchable').textContent = 'Building…';
  try {
    const blob = await createSearchablePdf(activeFile, activeResult);
    downloadBlob(blob, `${activeFile.name.replace(/\.pdf$/i, '')}.searchable.pdf`);
    toast('Searchable PDF created locally.');
  } catch (error) { toast(error.message); }
  finally { $('download-searchable').disabled = false; $('download-searchable').textContent = 'Searchable PDF'; }
}

function populateLanguages() {
  const select = $('language');
  for (const lang of getSupportedLanguages()) {
    const option = document.createElement('option'); option.value = lang.code; option.textContent = lang.label;
    select.append(option);
  }
}

async function apiPost(action, payload = {}) {
  const response = await fetch('/api/developer', {
    method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, ...payload })
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
  return data;
}

function showAuthError(message) {
  const node = $('auth-error'); node.textContent = message; node.classList.remove('hidden');
}

function setAuthMode(mode) {
  authMode = mode;
  $('auth-error').classList.add('hidden');
  $('mode-login').classList.toggle('active', mode === 'login');
  $('mode-signup').classList.toggle('active', mode === 'signup');
  $('auth-title').textContent = mode === 'login' ? 'Developer sign in' : 'Create developer account';
  $('auth-submit').textContent = mode === 'login' ? 'Sign in' : 'Create account';
  $('auth-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
}

async function submitAuth(event) {
  event.preventDefault();
  $('auth-submit').disabled = true;
  $('auth-error').classList.add('hidden');
  try {
    const data = await apiPost(authMode === 'login' ? 'login' : 'signup', { email: $('auth-email').value, password: $('auth-password').value });
    dashboardUser = data.user;
    $('auth-card').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    $('auth-password').value = '';
    await loadDashboard();
    toast(authMode === 'login' ? 'Signed in.' : 'Developer account created.');
  } catch (error) { showAuthError(error.message); }
  finally { $('auth-submit').disabled = false; }
}

function renderKeyList(keys) {
  const host = $('key-list'); host.replaceChildren();
  if (!keys.length) {
    const note = document.createElement('div'); note.className = 'subtle'; note.textContent = 'No API keys yet. Create one above.'; host.append(note); return;
  }
  for (const key of keys) {
    const card = document.createElement('div'); card.className = 'key-card';
    const main = document.createElement('div'); main.className = 'key-card-main';
    const title = document.createElement('strong'); title.textContent = key.name;
    const info = document.createElement('div'); info.className = 'key-info';
    info.textContent = `ID ${key.id} · ${key.usage.toLocaleString()} this month · ${key.active ? 'Active' : 'Revoked'} · ${key.allowedOrigins.join(', ')}`;
    main.append(title, info);
    const actions = document.createElement('div'); actions.className = 'key-actions';
    const edit = document.createElement('button'); edit.className = 'btn ghost'; edit.type = 'button'; edit.textContent = 'Edit origins';
    edit.addEventListener('click', async () => {
      const value = window.prompt('Allowed origins, comma-separated. Example: https://app.example.com', key.allowedOrigins.join(', '));
      if (value === null) return;
      try { await apiPost('update_key', { keyId: key.id, allowedOrigins: value }); toast('Allowed origins updated.'); await loadDashboard(); }
      catch (error) { toast(error.message); }
    });
    const revoke = document.createElement('button'); revoke.className = 'btn danger'; revoke.type = 'button'; revoke.textContent = 'Revoke';
    revoke.addEventListener('click', async () => {
      if (!window.confirm(`Revoke API key “${key.name}”? This cannot be undone.`)) return;
      try { await apiPost('revoke_key', { keyId: key.id }); toast('API key revoked.'); await loadDashboard(); }
      catch (error) { toast(error.message); }
    });
    actions.append(edit, revoke); card.append(main, actions); host.append(card);
  }
}

async function loadDashboard() {
  try {
    const data = await apiPost('me');
    dashboardUser = data.user;
    $('auth-card').classList.add('hidden');
    $('dashboard').classList.remove('hidden');
    $('usage-value').textContent = Number(data.usage.authorizations).toLocaleString();
    $('usage-limit').textContent = Number(data.plan.monthlyAuthorizations).toLocaleString();
    $('key-count').textContent = `${data.keys.length} / ${data.plan.maxKeys}`;
    $('usage-month').textContent = `Usage period: ${data.usage.month}`;
    const percent = Math.min(100, Number(data.usage.authorizations) / Number(data.plan.monthlyAuthorizations) * 100);
    $('usage-fill').style.width = `${percent}%`;
    $('usage-caption').textContent = `${data.plan.monthlyAuthorizations.toLocaleString()} authorizations/month · ${data.plan.requestsPerMinutePerKey}/minute/key · ${data.plan.requestsPerMinutePerAccount}/minute/account.`;
    renderKeyList(data.keys);
    const host = window.location.origin;
    $('sdk-snippet').textContent = `import { processDocument } from '${host}/src/engine.js';\n\nconst result = await processDocument(file, {\n  lang: 'eng',\n  engine: 'auto',\n  apiKey: 'YOUR_PUBLISHABLE_KEY',\n  apiBase: '${host}'\n});\n\nconsole.log(result.pages, result.text);`;
  } catch (error) {
    if (/sign in|session/i.test(error.message)) {
      dashboardUser = null;
      $('dashboard').classList.add('hidden');
      $('auth-card').classList.remove('hidden');
    } else {
      showAuthError(error.message);
      $('auth-card').classList.remove('hidden');
    }
  }
}

async function createKey(event) {
  event.preventDefault();
  $('create-key').disabled = true;
  $('key-error').classList.add('hidden');
  try {
    const origins = $('key-origins').value.trim() || window.location.origin;
    const data = await apiPost('create_key', { name: $('key-name').value, allowedOrigins: origins });
    latestKey = data.key;
    $('new-key').textContent = latestKey;
    $('key-modal').classList.add('show');
    $('key-name').value = 'My application';
    await loadDashboard();
  } catch (error) {
    $('key-error').textContent = error.message; $('key-error').classList.remove('hidden');
  } finally { $('create-key').disabled = false; }
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); toast('Copied to clipboard.'); }
  catch { toast('Clipboard access is unavailable in this browser. Select and copy the text manually.'); }
}

function wireEvents() {
  $('nav-workspace').addEventListener('click', () => setNav('workspace'));
  $('nav-developers').addEventListener('click', () => setNav('developers'));
  $('choose-files').addEventListener('click', (event) => { event.stopPropagation(); $('file-input').click(); });
  $('dropzone').addEventListener('click', (event) => { if (event.target.id !== 'choose-files') $('file-input').click(); });
  $('dropzone').addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); $('file-input').click(); } });
  $('file-input').addEventListener('change', (event) => { addFiles(event.target.files); event.target.value = ''; });
  $('dropzone').addEventListener('dragover', (event) => { event.preventDefault(); $('dropzone').classList.add('drag'); });
  $('dropzone').addEventListener('dragleave', () => $('dropzone').classList.remove('drag'));
  $('dropzone').addEventListener('drop', (event) => { event.preventDefault(); $('dropzone').classList.remove('drag'); addFiles(event.dataTransfer.files); });
  $('process-btn').addEventListener('click', processQueue);
  $('cancel-btn').addEventListener('click', () => abortController?.abort());
  $('copy-text').addEventListener('click', () => copyText(activeResult?.text || ''));
  for (const type of ['txt', 'md', 'json', 'csv', 'html']) $(`download-${type}`).addEventListener('click', () => exportText(type));
  $('download-searchable').addEventListener('click', exportSearchablePdf);
  $('mode-login').addEventListener('click', () => setAuthMode('login'));
  $('mode-signup').addEventListener('click', () => setAuthMode('signup'));
  $('auth-form').addEventListener('submit', submitAuth);
  $('key-form').addEventListener('submit', createKey);
  $('signout').addEventListener('click', async () => { try { await apiPost('logout'); } catch { /* local UI still signs out */ } dashboardUser = null; $('dashboard').classList.add('hidden'); $('auth-card').classList.remove('hidden'); toast('Signed out.'); });
  $('copy-sdk').addEventListener('click', () => copyText($('sdk-snippet').textContent));
  $('copy-new-key').addEventListener('click', () => copyText(latestKey));
  $('close-key-modal').addEventListener('click', () => { $('key-modal').classList.remove('show'); latestKey = ''; $('new-key').textContent = ''; });
  $('key-modal').addEventListener('click', (event) => { if (event.target === $('key-modal')) $('key-modal').classList.remove('show'); });
  window.addEventListener('beforeunload', () => { abortController?.abort(); releaseOcrMemory(); });
}

populateLanguages();
wireEvents();
window.ArixDoc = Object.freeze({ process: processDocument, createSearchablePdf, exportCsvBundle, getSupportedLanguages, releaseOcrMemory });
$('key-origins').value = window.location.origin;
