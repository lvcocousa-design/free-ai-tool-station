/* 免费AI工具站前端 — 原生 JS，无框架无 CDN 依赖。
   所有接口按契约调用后端 /api/*；前端不保存任何真实 Key。 */
'use strict';

/* ---------- 通用工具 ---------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function $(id) { return document.getElementById(id); }

function showError(el, msg) {
  if (!el) return;
  el.textContent = msg || '请求失败，请稍后重试';
  el.classList.remove('hidden');
}
function hideError(el) { if (el) el.classList.add('hidden'); }

async function api(path, options) {
  let res;
  try {
    res = await fetch(path, options);
  } catch (e) {
    throw new Error('网络请求失败，请检查服务是否启动');
  }
  let data;
  try {
    data = await res.json();
  } catch (e) {
    // 401 且非 JSON（如代理层拦截）：同样跳回登录遮罩
    if (res.status === 401) {
      showLoginOverlay();
      throw new Error('登录已过期，请重新登录');
    }
    throw new Error('服务器返回异常（HTTP ' + res.status + '）');
  }
  // 未登录 / 会话失效：跳回登录遮罩（登录接口本身失败时遮罩已在显示，无影响）
  if (res.status === 401) {
    showLoginOverlay();
    const err = new Error((data && data.message) || '登录已过期，请重新登录');
    err.unauthorized = true;
    throw err;
  }
  if (data && data.ok === false) {
    const err = new Error(data.message || '请求失败');
    err.notConfigured = !!data.notConfigured;
    err.offline = !!data.offline;
    throw err;
  }
  return data;
}

function postJSON(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/* 文件转 base64（不含 data: 前缀），返回 {base64, mimeType} */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const comma = dataUrl.indexOf(',');
      resolve({ base64: dataUrl.slice(comma + 1), mimeType: file.type || 'application/octet-stream' });
    };
    reader.onerror = () => reject(new Error('读取文件失败'));
    reader.readAsDataURL(file);
  });
}

function fmtNum(n) { return Number(n || 0).toLocaleString('en-US'); }

/* ---------- 全局状态 ---------- */

const state = {
  providers: {},        // name -> {configured, label, quotaNote}
  status: null,         // GET /api/status 结果
  history: [],          // GET /api/history 结果
  currentJob: null,     // {id, startedAt}
  pollTimer: null,
  currentChatId: null,
  analyzeImage: null,   // {base64, mimeType}
  sttAudio: null,       // {base64, mimeType}
  selectedFrameId: null,
};

/* 供应商显示名来自 GET /api/providers（state.providers），未加载时回落为内部名 */
function providerLabel(name) {
  return (state.providers[name] && state.providers[name].label) || name;
}

const BACKEND_NOTES = {
  instabox: '免费 CPU 出图，约 4 分钟一张，适合日常出图。',
  kaggle: '免费 GPU（FLUX），画质更好，约 5–10 分钟加排队，耗每周 30 小时额度。',
  cloudflare: '免费极速出图（FLUX schnell），每天 10,000 Neurons，适合快速试效果。',
};

const BACKEND_LABELS = { instabox: 'InstaBox CPU', kaggle: 'Kaggle GPU', cloudflare: 'Cloudflare' };

/* 未配置提示：显示在对应功能区，带跳转设置页的链接 */
function notConfiguredHTML(providerName) {
  const label = providerLabel(providerName);
  return esc(label) + ' 未配置，请先去<a href="#" data-goto-settings>设置页</a>填写 Key。';
}
function setNotConfigured(el, providerName) {
  if (!el) return;
  if (providerName && !state.providers[providerName]?.configured) {
    el.innerHTML = notConfiguredHTML(providerName);
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

/* ---------- 页签切换 ----------
   功能页签注册表：加新功能时，在此注册一项 + 在 index.html 加一个
   id 为 panel-<id> 的 section；按钮由下方代码动态生成，无需改 HTML。
   onShow 为可选的切到该页签时执行的刷新函数。 */
/* icon 为页签的 inline SVG（描边风格，24×24 画布，currentColor 着色） */
const FEATURES = [
  { id: 'create', label: '创作', icon: '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>', onShow: loadHistory },
  { id: 'chat', label: '对话/代码', icon: '<path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>', onShow: loadChats },
  { id: 'analyze', label: '识图', icon: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>' },
  { id: 'translate', label: '翻译', icon: '<circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/>' },
  { id: 'voice', label: '语音', icon: '<path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/>' },
  { id: 'music', label: '音乐', icon: '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>' },
  { id: 'embed', label: '向量', icon: '<polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/>' },
  { id: 'settings', label: '设置', icon: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>', onShow: loadUsage },
];

function showTab(name) {
  const feature = FEATURES.find((f) => f.id === name);
  if (!feature) return; // 未知页签 id：忽略，不报错
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.id === 'panel-' + name));
  if (typeof feature.onShow === 'function') feature.onShow();
}

// 启动时按注册表动态生成页签按钮（第一个为默认激活态，与原 HTML 一致）。
(function renderTabBar() {
  const tabBar = $('tabBar');
  if (!tabBar) return;
  tabBar.innerHTML = FEATURES.map((f, i) =>
    '<button class="tab-btn' + (i === 0 ? ' active' : '') + '" data-tab="' + esc(f.id) + '">'
    + '<svg class="tab-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + f.icon + '</svg>'
    + '<span>' + esc(f.label) + '</span></button>'
  ).join('');
  tabBar.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => showTab(btn.dataset.tab));
  });
})();

/* 设置页跳转链接（事件委托，覆盖动态生成的提示） */
document.addEventListener('click', (e) => {
  const a = e.target.closest('[data-goto-settings]');
  if (a) { e.preventDefault(); showTab('settings'); }
});

/* ---------- 主题切换：浅色 / 深色 ----------
   默认跟随系统：index.html head 里的内联脚本已在首屏绘制前按
   localStorage 或 prefers-color-scheme 设好 <html data-theme>；
   手动切换后记入 localStorage，之后不再跟随系统变化。 */
const THEME_KEY = 'theme';

function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = $('themeToggleBtn');
  if (btn) btn.setAttribute('aria-label', theme === 'dark' ? '切换到浅色模式' : '切换到深色模式');
}

$('themeToggleBtn').addEventListener('click', () => {
  const next = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(THEME_KEY, next); } catch (_) { /* 隐私模式忽略 */ }
  applyTheme(next);
});

/* 未手动选过主题时，跟随系统偏好变化 */
if (window.matchMedia) {
  const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
  if (typeof mediaQuery.addEventListener === 'function') {
    mediaQuery.addEventListener('change', (e) => {
      let saved = null;
      try { saved = localStorage.getItem(THEME_KEY); } catch (_) { /* 隐私模式忽略 */ }
      if (saved !== 'dark' && saved !== 'light') applyTheme(e.matches ? 'dark' : 'light');
    });
  }
}

/* 与 head 内联脚本的初始选择同步一次（主要同步切换按钮的 aria-label） */
applyTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light');

/* ---------- 启动时加载：供应商配置 + 后端状态 ---------- */

async function loadProviders() {
  try {
    const data = await api('/api/providers');
    state.providers = {};
    state.providerList = data.providers || []; // 已按 order 排好序，供设置页与向导共用
    state.providerList.forEach(p => { state.providers[p.name] = p; });
    renderSettingsForms(data.providers || []);
    refreshNotConfiguredNotices();
    maybeShowWizard();
  } catch (e) {
    // 设置页显示加载失败，不白屏
    $('providerForms').innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

async function loadStatus() {
  const box = $('createStatus');
  try {
    const s = await api('/api/status');
    state.status = s;
    const instabox = s.instabox || {};
    const kaggle = s.kaggle || {};
    const cf = s.cloudflare || {};
    const parts = [];
    if (instabox.configured) {
      parts.push('InstaBox：' + (instabox.online
        ? '<span class="online">在线</span>'
        : '<span class="offline">不在线</span>'));
    } else {
      parts.push('InstaBox：<span class="offline">未配置</span>');
    }
    parts.push('Kaggle：' + (kaggle.configured ? '<span class="online">已配置</span>' : '<span class="offline">未配置</span>'));
    parts.push('Cloudflare：' + (cf.configured ? '<span class="online">已配置</span>' : '<span class="offline">未配置</span>'));
    box.innerHTML = parts.join('　·　');
    applyBackendAvailability();
  } catch (e) {
    box.innerHTML = '<span class="offline">状态检查失败：' + esc(e.message) + '</span>';
  }
}

/* 按配置/在线状态禁用后端选项 */
function applyBackendAvailability() {
  const s = state.status || {};
  const instaboxOk = !!(s.instabox && s.instabox.configured && s.instabox.online);
  const kaggleOk = !!(s.kaggle && s.kaggle.configured);
  const cfOk = !!(s.cloudflare && s.cloudflare.configured);
  const avail = { instabox: instaboxOk, kaggle: kaggleOk, cloudflare: cfOk };

  Object.keys(avail).forEach(name => {
    const radio = document.querySelector('input[name="genBackend"][value="' + name + '"]');
    const label = $('backendLabel-' + name);
    if (!radio || !label) return;
    radio.disabled = !avail[name];
    radio.closest('.radio').classList.toggle('disabled', !avail[name]);
    let suffix = '';
    if (name === 'instabox' && s.instabox && s.instabox.configured && !s.instabox.online) suffix = '（不在线）';
    else if (!avail[name]) suffix = '（未配置）';
    label.textContent = BACKEND_LABELS[name] + suffix;
  });

  // 当前选中项不可用时，自动切到第一个可用后端
  const checked = document.querySelector('input[name="genBackend"]:checked');
  if (checked && checked.disabled) {
    const firstOk = document.querySelector('input[name="genBackend"]:not(:disabled)');
    if (firstOk) firstOk.checked = true;
  }
  updateBackendNote();
  refreshCreateNotConfigured();
}

function selectedBackend() {
  const r = document.querySelector('input[name="genBackend"]:checked');
  return r ? r.value : 'cloudflare';
}

function updateBackendNote() {
  $('backendNote').textContent = BACKEND_NOTES[selectedBackend()] || '';
  updateGenParamHints();
}

/* 生成参数注明/禁用状态随后端切换：步数与 CFG 各后端行为不同 */
const STEPS_HINTS = {
  instabox: '步数：InstaBox 按设置生效，步数越多细节越丰富、耗时越长。',
  cloudflare: '步数：Cloudflare 按步数计 Neurons，最多 8 步，超出按 8 步计。',
  kaggle: '步数：Kaggle 固定 4 步，忽略此处设置。',
};

function updateGenParamHints() {
  const backend = selectedBackend();
  const stepsHint = $('stepsHint');
  if (stepsHint) stepsHint.textContent = STEPS_HINTS[backend] || '';
  const cfgInput = $('genCfg');
  const cfgHint = $('cfgHint');
  if (!cfgInput || !cfgHint) return;
  if (backend === 'instabox') {
    cfgInput.disabled = false;
    cfgHint.textContent = 'CFG：仅 InstaBox 生效，越高越贴合提示词，默认 7。';
  } else {
    cfgInput.disabled = true;
    cfgHint.textContent = 'CFG：FLUX 后端固定 cfg 1.0，此处设置不生效。';
  }
}

document.querySelectorAll('input[name="genBackend"]').forEach(r => {
  r.addEventListener('change', updateBackendNote);
});

/* 创作页未配置提示（按当前选中后端） */
function refreshCreateNotConfigured() {
  const backend = selectedBackend();
  const map = { instabox: 'instabox', kaggle: 'kaggle', cloudflare: 'cloudflare' };
  setNotConfigured($('genNotConfigured'), map[backend]);
  setNotConfigured($('videoNotConfigured'), 'kaggle');
}

function refreshNotConfiguredNotices() {
  refreshCreateNotConfigured();
  refreshChatNotConfigured();
  refreshAnalyzeNotConfigured();
  refreshTranslateNotConfigured();
  refreshTtsNotConfigured();
  refreshSttNotConfigured();
  refreshEmbedNotConfigured();
  applyBackendAvailability();
}

/* ---------- 创作：模式切换 ---------- */

$('modeImageBtn').addEventListener('click', () => setCreateMode('image'));
$('modeVideoBtn').addEventListener('click', () => setCreateMode('video'));

function setCreateMode(mode) {
  $('modeImageBtn').classList.toggle('active', mode === 'image');
  $('modeVideoBtn').classList.toggle('active', mode === 'video');
  $('imageMode').classList.toggle('hidden', mode !== 'image');
  $('videoMode').classList.toggle('hidden', mode !== 'video');
  if (mode === 'video') renderFramePicker();
}

/* ---------- 创作：生成 + 轮询 ---------- */

function elapsedSeconds() {
  if (!state.currentJob) return 0;
  return Math.floor((Date.now() - state.currentJob.startedAt) / 1000);
}

function stopPolling() {
  if (state.pollTimer) { clearInterval(state.pollTimer); state.pollTimer = null; }
}

function renderOutputJob(job, elapsed) {
  const statusEl = $('outputStatus');
  const mediaEl = $('outputMedia');
  const errEl = $('outputError');
  hideError(errEl);
  const typeText = job.type === 'video' ? '视频' : '图片';
  if (job.status === 'queued' || job.status === 'running' || job.status === 'unknown') {
    const text = job.status === 'queued' ? '排队中' : job.status === 'running' ? '生成中' : '状态查询中';
    statusEl.innerHTML = typeText + text + '… 已用 <b>' + elapsed + '</b> 秒';
    mediaEl.innerHTML = '<p class="muted">请耐心等待，出图约几分钟，视频约 1 小时。</p>';
  } else if (job.status === 'done') {
    statusEl.innerHTML = typeText + '已完成，用时 <b>' + elapsed + '</b> 秒';
    if (job.type === 'video' && job.videoUrl) {
      mediaEl.innerHTML = '<video src="' + esc(job.videoUrl) + '" controls autoplay playsinline></video>';
    } else if (job.imageUrl) {
      mediaEl.innerHTML = '<img src="' + esc(job.imageUrl) + '" alt="' + esc(job.prompt || '') + '">';
    } else {
      mediaEl.innerHTML = '<p class="muted">已完成，但没有返回文件。</p>';
    }
  } else if (job.status === 'failed') {
    statusEl.innerHTML = typeText + '生成失败，用时 <b>' + elapsed + '</b> 秒';
    mediaEl.innerHTML = '';
    showError(errEl, job.error || '生成失败，请稍后重试');
  }
}

async function pollJobOnce() {
  if (!state.currentJob) return;
  const id = state.currentJob.id;
  try {
    const job = await api('/api/generations/' + encodeURIComponent(id));
    renderOutputJob(job, elapsedSeconds());
    if (job.status === 'done' || job.status === 'failed') {
      stopPolling();
      state.currentJob = null;
      loadHistory();
    }
  } catch (e) {
    // 轮询单次失败不中断，继续等下一次；只更新已用秒数
    const statusEl = $('outputStatus');
    if (state.currentJob) {
      statusEl.innerHTML = '生成中… 已用 <b>' + elapsedSeconds() + '</b> 秒（状态查询失败，继续等待）';
    }
  }
}

function startJobPolling(generationId, type) {
  stopPolling();
  state.currentJob = { id: generationId, startedAt: Date.now() };
  renderOutputJob({ type, status: 'queued', prompt: '' }, 0);
  pollJobOnce();
  let ticks = 0;
  state.pollTimer = setInterval(() => {
    ticks += 1;
    if (state.currentJob) {
      // 每秒刷新已用秒数，每 5 秒查一次状态
      const statusEl = $('outputStatus');
      const b = statusEl.querySelector('b');
      if (b) b.textContent = String(elapsedSeconds());
    }
    if (ticks % 5 === 0) pollJobOnce();
  }, 1000);
}

$('genBtn').addEventListener('click', async () => {
  const prompt = $('genPrompt').value.trim();
  const errEl = $('genError');
  hideError(errEl);
  if (!prompt) { showError(errEl, '请先输入提示词'); return; }
  const backend = selectedBackend();
  const size = document.querySelector('input[name="genSize"]:checked').value;
  const sizes = {
    square: { width: 1024, height: 1024 },
    portrait: { width: 512, height: 768 },
    landscape: { width: 768, height: 512 },
  };
  const { width, height } = sizes[size] || sizes.portrait;
  // 步数/CFG 前端先夹取一次，后端还会再归一化（非法值不报错，只夹取）。
  const stepsRaw = parseInt($('genSteps').value, 10);
  const steps = Number.isFinite(stepsRaw) ? Math.min(50, Math.max(1, stepsRaw)) : 20;
  const cfgRaw = parseFloat($('genCfg').value);
  const cfg = Number.isFinite(cfgRaw) ? Math.min(20, Math.max(1, cfgRaw)) : 7;

  const btn = $('genBtn');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const data = await postJSON('/api/generate', { backend, prompt, width, height, steps, cfg });
    if (!data.generationId) throw new Error('服务器没有返回任务编号');
    startJobPolling(data.generationId, 'image');
  } catch (e) {
    showError(errEl, e.message);
    if (e.offline) loadStatus();
  } finally {
    btn.disabled = false;
    btn.textContent = '生成图片';
  }
});

$('videoBtn').addEventListener('click', async () => {
  const errEl = $('videoError');
  hideError(errEl);
  if (!state.selectedFrameId) { showError(errEl, '请先从历史图片里选一张做首帧'); return; }
  const prompt = $('videoPrompt').value.trim();
  if (!prompt) { showError(errEl, '请先输入动作描述'); return; }

  const btn = $('videoBtn');
  btn.disabled = true;
  btn.textContent = '提交中…';
  try {
    const data = await postJSON('/api/video', { sourceGenerationId: state.selectedFrameId, prompt });
    if (!data.generationId) throw new Error('服务器没有返回任务编号');
    startJobPolling(data.generationId, 'video');
  } catch (e) {
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成视频';
  }
});

/* ---------- 创作：历史 ---------- */

async function loadHistory() {
  const listEl = $('historyList');
  try {
    const data = await api('/api/history');
    state.history = data.history || [];
    renderHistory();
    renderFramePicker();
  } catch (e) {
    listEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

function historyFileUrl(item) {
  return item.file ? '/blobs/' + encodeURIComponent(item.file) : null;
}

function renderHistory() {
  const listEl = $('historyList');
  const items = state.history;
  if (!items.length) {
    listEl.innerHTML = '<p class="muted">暂无历史记录。</p>';
    return;
  }
  listEl.innerHTML = items.map(item => {
    const url = historyFileUrl(item);
    const isVideo = item.type === 'video';
    let thumb;
    if (url && isVideo) thumb = '<video src="' + esc(url) + '" preload="metadata" muted></video>';
    else if (url) thumb = '<img src="' + esc(url) + '" alt="" loading="lazy">';
    else thumb = '<div class="thumb-placeholder">' + (item.status === 'failed' ? '生成失败' : '生成中…') + '</div>';
    const tags = '<span class="tag">' + esc(BACKEND_LABELS[item.backend] || item.backend || '') + '</span>'
      + '<span class="tag' + (isVideo ? ' video' : '') + '">' + (isVideo ? '视频' : '图片') + '</span>'
      + (item.status === 'failed' ? '<span class="tag failed">失败</span>' : '');
    return '<button class="history-item" data-history-id="' + esc(item.id) + '">'
      + thumb
      + '<div class="meta"><p class="prompt">' + esc(item.prompt || '') + '</p>' + tags + '</div>'
      + '</button>';
  }).join('');
}

$('historyList').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-history-id]');
  if (!btn) return;
  const item = state.history.find(h => String(h.id) === btn.dataset.historyId);
  if (!item) return;
  loadHistoryItemToOutput(item);
});

function loadHistoryItemToOutput(item) {
  stopPolling();
  state.currentJob = null;
  const url = historyFileUrl(item);
  const job = {
    id: item.id, type: item.type, backend: item.backend, prompt: item.prompt,
    status: item.status === 'done' ? 'done' : item.status,
    imageUrl: item.type !== 'video' ? url : undefined,
    videoUrl: item.type === 'video' ? url : undefined,
    error: item.error,
  };
  renderOutputJob(job, 0);
  $('outputStatus').innerHTML = (item.type === 'video' ? '视频' : '图片')
    + ' · ' + esc(BACKEND_LABELS[item.backend] || item.backend || '')
    + (item.createdAt ? ' · ' + esc(new Date(item.createdAt).toLocaleString('zh-CN')) : '');
  $('outputCard').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

$('historyRefreshBtn').addEventListener('click', loadHistory);

/* 生视频首帧选择器：只列已完成的图片 */
function renderFramePicker() {
  const picker = $('framePicker');
  const images = state.history.filter(h => h.type !== 'video' && h.status === 'done' && h.file);
  if (!images.length) {
    picker.innerHTML = '<p class="muted">暂无历史图片，请先去出图。</p>';
    state.selectedFrameId = null;
    return;
  }
  if (!images.some(h => String(h.id) === String(state.selectedFrameId))) {
    state.selectedFrameId = null;
  }
  picker.innerHTML = images.map(h =>
    '<button class="frame-option' + (String(h.id) === String(state.selectedFrameId) ? ' selected' : '') + '" data-frame-id="' + esc(h.id) + '">'
    + '<img src="' + esc(historyFileUrl(h)) + '" alt="" loading="lazy">'
    + '<div class="cap">' + esc(h.prompt || '') + '</div></button>'
  ).join('');
}

$('framePicker').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-frame-id]');
  if (!btn) return;
  state.selectedFrameId = btn.dataset.frameId;
  renderFramePicker();
});

/* ---------- 对话/代码 ---------- */

/* 模型配置：单一来源是后端 lib/models.json，前端通过 GET /api/models 拉取。
   请求失败时回落到下面的最小内置默认值（与后端配置值一致），保证页面不崩。 */
const MODEL_FALLBACK = {
  chat: {
    zhipu: {
      default: 'glm-4.7-flash',
      models: [
        { id: 'glm-4.7-flash', label: 'GLM-4.7-Flash' },
        { id: 'glm-4.5-flash', label: 'GLM-4.5-Flash' },
      ],
    },
    groq: {
      default: 'openai/gpt-oss-120b',
      models: [
        { id: 'openai/gpt-oss-120b', label: 'gpt-oss-120b' },
        { id: 'openai/gpt-oss-20b', label: 'gpt-oss-20b' },
        { id: 'qwen/qwen3.8-27b', label: 'Qwen3 8-27b' },
      ],
    },
    cloudflare: {
      default: '@cf/meta/llama-3.1-8b-instruct-fp8',
      models: [
        { id: '@cf/meta/llama-3.1-8b-instruct-fp8', label: 'Llama-3.1-8B-Instruct' },
      ],
    },
    gemini: {
      default: 'gemini-3.8-flash',
      models: [
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash' },
        { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite' },
      ],
    },
    nvidia: {
      default: 'z-ai/glm-5.3-flash',
      models: [
        { id: 'z-ai/glm-5.3-flash', label: 'GLM-5.3-Flash' },
        { id: 'moonshotai/kimi-k3.1-pro', label: 'Kimi K3.1 Pro' },
        { id: 'nvidia/nemotron-3.5-lightning-30b-a3b', label: 'Nemotron 3.5 Lightning 30B' },
        { id: 'minimaxai/minimax-m3.1-flash', label: 'MiniMax M3.1 Flash' },
        { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning', label: 'Nemotron 3 Nano Omni 30B Reasoning' },
        { id: 'mistralai/mistral-large-4-1t-a52b', label: 'Mistral Large 4' },
        { id: 'stepfun-ai/step-5-preview', label: 'Step-5 Preview' },
        { id: 'google/gemma-4-31b-it', label: 'Gemma 4 31B' },
        { id: 'meta/muse-glimmer-30b', label: 'Muse Glimmer 30B' },
      ],
    },
  },
  tts: {
    elevenlabs: {
      default: 'EXAVITQu4vr4xnSDxMaL',
      voices: [
        { id: 'EXAVITQu4vr4xnSDxMaL', label: 'Sarah' },
        { id: 'Xb7hH8MSUJpSbSDYk0k2', label: 'Alice' },
        { id: 'pNInz6obpgDQGcFmaJgB', label: 'Adam' },
        { id: 'hpp4J3VqNfWAUOO0d1Us', label: 'Bella' },
        { id: 'JBFqnCBsd6RMkjVDRZzb', label: 'George' },
      ],
    },
  },
};

// 当前生效的模型配置：先用内置默认值同步渲染下拉，loadModels 拉到后端配置后再刷新。
let modelConfig = MODEL_FALLBACK;

async function loadModels() {
  try {
    const data = await api('/api/models');
    if (data && data.models && data.models.chat) {
      modelConfig = data.models;
      refreshChatModels();
      refreshTtsVoices();
    }
  } catch (e) {
    console.warn('[app] 加载 /api/models 失败，使用内置默认模型配置：', e.message);
  }
}

function chatModelsFor(provider) {
  const entry = modelConfig.chat && modelConfig.chat[provider];
  return (entry && entry.models) || [];
}

function refreshChatModels() {
  const provider = $('chatProvider').value;
  const entry = modelConfig.chat && modelConfig.chat[provider];
  const models = chatModelsFor(provider);
  $('chatModel').innerHTML = models.map(m =>
    '<option value="' + esc(m.id) + '"' + (entry && m.id === entry.default ? ' selected' : '') + '>' + esc(m.label) + '</option>').join('');
}

function refreshChatNotConfigured() {
  setNotConfigured($('chatNotConfigured'), $('chatProvider').value);
}

$('chatProvider').addEventListener('change', () => {
  refreshChatModels();
  refreshChatNotConfigured();
});

function renderChatMessages(messages) {
  const box = $('chatMessages');
  if (!messages || !messages.length) {
    box.innerHTML = '<p class="muted">还没有消息，在下方输入开始对话。</p>';
    return;
  }
  box.innerHTML = messages.map(m =>
    '<div class="msg ' + (m.role === 'user' ? 'user' : 'assistant') + '">' + esc(m.content) + '</div>'
  ).join('');
  box.scrollTop = box.scrollHeight;
}

async function loadChats() {
  const listEl = $('chatList');
  try {
    const data = await api('/api/chats');
    const chats = data.chats || [];
    if (!chats.length) {
      listEl.innerHTML = '<p class="muted">暂无会话。</p>';
      return;
    }
    listEl.innerHTML = chats.map(c =>
      '<div class="chat-item' + (String(c.id) === String(state.currentChatId) ? ' active' : '') + '" data-chat-id="' + esc(c.id) + '">'
      + '<span class="title">' + esc(c.title || '新会话') + '</span>'
      + '<button class="del" data-del-chat="' + esc(c.id) + '" title="删除会话">✕</button>'
      + '</div>'
    ).join('');
  } catch (e) {
    listEl.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

$('chatList').addEventListener('click', async (e) => {
  const delBtn = e.target.closest('[data-del-chat]');
  if (delBtn) {
    e.stopPropagation();
    if (!confirm('确定删除这个会话吗？')) return;
    const id = delBtn.dataset.delChat;
    try {
      await api('/api/chats/' + encodeURIComponent(id), { method: 'DELETE' });
      if (String(state.currentChatId) === String(id)) {
        state.currentChatId = null;
        renderChatMessages([]);
      }
      loadChats();
    } catch (err) {
      alert(err.message);
    }
    return;
  }
  const item = e.target.closest('[data-chat-id]');
  if (!item) return;
  const id = item.dataset.chatId;
  try {
    const data = await api('/api/chats/' + encodeURIComponent(id));
    state.currentChatId = id;
    const chat = data.chat || {};
    if (chat.provider && chatModelsFor(chat.provider).length) {
      $('chatProvider').value = chat.provider;
      refreshChatModels();
      if (chat.model) $('chatModel').value = chat.model;
      refreshChatNotConfigured();
    }
    renderChatMessages(chat.messages || []);
    loadChats();
  } catch (err) {
    showError($('chatError'), err.message);
  }
});

$('newChatBtn').addEventListener('click', () => {
  state.currentChatId = null;
  renderChatMessages([]);
  hideError($('chatError'));
  loadChats();
  $('chatInput').focus();
});

$('chatSendBtn').addEventListener('click', async () => {
  const content = $('chatInput').value.trim();
  const errEl = $('chatError');
  hideError(errEl);
  if (!content) { showError(errEl, '请先输入消息'); return; }
  const provider = $('chatProvider').value;
  const model = $('chatModel').value;

  // 先把用户消息显示出来
  const box = $('chatMessages');
  if (box.querySelector('.muted')) box.innerHTML = '';
  box.insertAdjacentHTML('beforeend', '<div class="msg user">' + esc(content) + '</div>');
  box.insertAdjacentHTML('beforeend', '<div class="msg assistant" id="chatPending">思考中…</div>');
  box.scrollTop = box.scrollHeight;

  $('chatInput').value = '';
  const btn = $('chatSendBtn');
  btn.disabled = true;
  try {
    const data = await postJSON('/api/chat', {
      provider, model,
      chatId: state.currentChatId || '',
      content,
    });
    state.currentChatId = data.chatId;
    const pending = $('chatPending');
    if (pending) pending.textContent = data.reply || '';
    loadChats();
  } catch (e) {
    const pending = $('chatPending');
    if (pending) pending.remove();
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
  }
});

/* ---------- 识图 ---------- */

function refreshAnalyzeNotConfigured() {
  const mode = document.querySelector('input[name="analyzeMode"]:checked').value;
  const provider = mode === 'ocr' ? 'siliconflow' : $('analyzeProvider').value;
  setNotConfigured($('analyzeNotConfigured'), provider);
  $('analyzeQuestionWrap').classList.toggle('hidden', mode === 'ocr');
  $('analyzeProviderWrap').classList.toggle('hidden', mode === 'ocr');
}

document.querySelectorAll('input[name="analyzeMode"]').forEach(r => {
  r.addEventListener('change', refreshAnalyzeNotConfigured);
});

$('analyzeProvider').addEventListener('change', refreshAnalyzeNotConfigured);

$('analyzeFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const errEl = $('analyzeError');
  hideError(errEl);
  state.analyzeImage = null;
  $('analyzePreview').innerHTML = '';
  if (!file) return;
  if (file.size > 10 * 1024 * 1024) {
    showError(errEl, '图片超过 10MB，请换一张小一点的图片');
    e.target.value = '';
    return;
  }
  try {
    state.analyzeImage = await fileToBase64(file);
    $('analyzePreview').innerHTML = '<img src="' + esc(URL.createObjectURL(file)) + '" alt="待识别图片">';
  } catch (err) {
    showError(errEl, err.message);
  }
});

$('analyzeBtn').addEventListener('click', async () => {
  const errEl = $('analyzeError');
  const resultEl = $('analyzeResult');
  hideError(errEl);
  resultEl.classList.add('hidden');
  if (!state.analyzeImage) { showError(errEl, '请先上传一张图片'); return; }
  const mode = document.querySelector('input[name="analyzeMode"]:checked').value;
  const question = $('analyzeQuestion').value.trim();
  if (mode === 'ask' && !question) { showError(errEl, '请先输入提问'); return; }

  const btn = $('analyzeBtn');
  btn.disabled = true;
  btn.textContent = '识别中…';
  try {
    const data = await postJSON('/api/analyze', {
      provider: mode === 'ocr' ? 'siliconflow' : $('analyzeProvider').value,
      mode,
      imageBase64: state.analyzeImage.base64,
      mimeType: state.analyzeImage.mimeType,
      question: mode === 'ask' ? question : undefined,
    });
    resultEl.textContent = data.text || '没有返回内容';
    resultEl.classList.remove('hidden');
  } catch (e) {
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '开始识别';
  }
});

/* ---------- 翻译 ---------- */

function refreshTranslateNotConfigured() {
  setNotConfigured($('translateNotConfigured'), $('translateProvider').value);
}

$('translateProvider').addEventListener('change', refreshTranslateNotConfigured);

$('translateBtn').addEventListener('click', async () => {
  const text = $('translateInput').value.trim();
  const errEl = $('translateError');
  hideError(errEl);
  if (!text) { showError(errEl, '请先输入原文'); return; }

  const btn = $('translateBtn');
  btn.disabled = true;
  btn.textContent = '翻译中…';
  try {
    const data = await postJSON('/api/translate', {
      provider: $('translateProvider').value,
      text,
      sourceLang: $('sourceLang').value || undefined,
      targetLang: $('targetLang').value,
    });
    $('translateResult').textContent = data.text || '没有返回译文';
  } catch (e) {
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '翻译';
  }
});

/* ---------- 语音：TTS ---------- */

function refreshTtsNotConfigured() {
  setNotConfigured($('ttsNotConfigured'), $('ttsProvider').value);
}

// TTS 音色下拉：从模型配置（/api/models，失败时用内置默认值）填充；
// 默认音色后带“（默认）”，与原 HTML 写死列表的显示一致。
function refreshTtsVoices() {
  const entry = modelConfig.tts && modelConfig.tts.elevenlabs;
  const voices = (entry && entry.voices) || [];
  $('ttsVoice').innerHTML = voices.map(v =>
    '<option value="' + esc(v.id) + '"' + (entry && v.id === entry.default ? ' selected' : '') + '>'
    + esc(v.label) + (entry && v.id === entry.default ? '（默认）' : '') + '</option>').join('');
}

$('ttsProvider').addEventListener('change', () => {
  const isEleven = $('ttsProvider').value === 'elevenlabs';
  $('ttsVoiceWrap').classList.toggle('hidden', !isEleven);
  $('ttsLangWrap').classList.toggle('hidden', isEleven);
  refreshTtsNotConfigured();
});

$('ttsBtn').addEventListener('click', async () => {
  const text = $('ttsText').value.trim();
  const errEl = $('ttsError');
  hideError(errEl);
  if (!text) { showError(errEl, '请先输入要朗读的文本'); return; }
  const provider = $('ttsProvider').value;

  const btn = $('ttsBtn');
  btn.disabled = true;
  btn.textContent = '生成中…';
  try {
    let res;
    try {
      res = await fetch('/api/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider, text,
          voiceId: provider === 'elevenlabs' ? $('ttsVoice').value : undefined,
          lang: provider === 'cloudflare' ? $('ttsLang').value : undefined,
        }),
      });
    } catch (e) {
      throw new Error('网络请求失败，请检查服务是否启动');
    }
    // TTS 直接用 fetch（要收音频流），401 时同样跳回登录遮罩
    if (res.status === 401) {
      showLoginOverlay();
      throw new Error('登录已过期，请重新登录');
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      throw new Error((data && data.message) || '语音生成失败');
    }
    const blob = await res.blob();
    if (!blob.size) throw new Error('语音生成失败：服务器返回了空音频');
    const audio = $('ttsAudio');
    audio.src = URL.createObjectURL(blob);
    audio.classList.remove('hidden');
    audio.play().catch(() => { /* 浏览器阻止自动播放时用户可手动点播放 */ });
  } catch (e) {
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '生成语音';
  }
});

/* ---------- 语音：STT ---------- */

function refreshSttNotConfigured() {
  setNotConfigured($('sttNotConfigured'), $('sttProvider').value);
}

$('sttProvider').addEventListener('change', refreshSttNotConfigured);

$('sttFile').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  const errEl = $('sttError');
  hideError(errEl);
  state.sttAudio = null;
  $('sttFileName').textContent = '';
  if (!file) return;
  try {
    state.sttAudio = await fileToBase64(file);
    $('sttFileName').textContent = '已选择：' + file.name;
  } catch (err) {
    showError(errEl, err.message);
  }
});

/* 录音（MediaRecorder，浏览器不支持时禁用按钮） */
let mediaRecorder = null;
let recordChunks = [];
const recordBtn = $('recordBtn');
if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia || typeof MediaRecorder === 'undefined') {
  recordBtn.disabled = true;
  $('recordStatus').textContent = '当前浏览器不支持录音，请改用上传音频文件。';
}

recordBtn.addEventListener('click', async () => {
  const statusEl = $('recordStatus');
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (ev) => { if (ev.data.size) recordChunks.push(ev.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      recordBtn.textContent = '开始录音';
      statusEl.textContent = '录音完成，正在处理…';
      try {
        const blob = new Blob(recordChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
        const file = new File([blob], 'recording.webm', { type: blob.type });
        state.sttAudio = await fileToBase64(file);
        $('sttFile').value = '';
        $('sttFileName').textContent = '已录制一段音频';
        statusEl.textContent = '录音完成，可点“识别语音”。';
      } catch (err) {
        statusEl.textContent = '';
        showError($('sttError'), err.message);
      }
    };
    mediaRecorder.start();
    recordBtn.textContent = '停止录音';
    statusEl.textContent = '正在录音…';
  } catch (e) {
    showError($('sttError'), '无法打开麦克风，请检查浏览器权限，或改用上传音频文件');
  }
});

$('sttBtn').addEventListener('click', async () => {
  const errEl = $('sttError');
  const resultEl = $('sttResult');
  hideError(errEl);
  resultEl.classList.add('hidden');
  if (!state.sttAudio) { showError(errEl, '请先上传音频文件或录一段音'); return; }

  const btn = $('sttBtn');
  btn.disabled = true;
  btn.textContent = '识别中…';
  try {
    const data = await postJSON('/api/stt', {
      provider: $('sttProvider').value,
      audioBase64: state.sttAudio.base64,
      mimeType: state.sttAudio.mimeType,
    });
    resultEl.textContent = data.text || '没有识别出文字';
    resultEl.classList.remove('hidden');
  } catch (e) {
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '识别语音';
  }
});

/* ---------- 向量 ---------- */

function refreshEmbedNotConfigured() {
  setNotConfigured($('embedNotConfigured'), $('embedProvider').value);
}

$('embedProvider').addEventListener('change', refreshEmbedNotConfigured);

$('embedBtn').addEventListener('click', async () => {
  const text1 = $('embedText1').value.trim();
  const text2 = $('embedText2').value.trim();
  const errEl = $('embedError');
  const resultEl = $('embedResult');
  hideError(errEl);
  resultEl.classList.add('hidden');
  if (!text1 || !text2) { showError(errEl, '请把两段文本都填上'); return; }

  const btn = $('embedBtn');
  btn.disabled = true;
  btn.textContent = '计算中…';
  try {
    const data = await postJSON('/api/embed', {
      provider: $('embedProvider').value,
      text1, text2,
    });
    const pct = (Number(data.similarity) * 100).toFixed(2);
    resultEl.innerHTML = '相似度：<b>' + esc(pct) + '%</b><br>向量维度：' + esc(data.dimension);
    resultEl.classList.remove('hidden');
  } catch (e) {
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '计算相似度';
  }
});

/* ---------- 设置：供应商配置 ---------- */

/* 各供应商需要填写的字段由 GET /api/providers 返回（p.fields），不再本地硬编码 */

function renderSettingsForms(providers) {
  const box = $('providerForms');
  if (!providers.length) {
    box.innerHTML = '<p class="muted">没有可配置的供应商。</p>';
    return;
  }
  box.innerHTML = providers.map(p => {
    const fields = p.fields || [{ key: 'apiKey', label: 'API Key', type: 'password' }];
    const inputs = fields.map(f =>
      '<label class="field-label" for="pf-' + esc(p.name) + '-' + esc(f.key) + '">' + esc(f.label) + '</label>'
      + '<input id="pf-' + esc(p.name) + '-' + esc(f.key) + '" type="' + esc(f.type) + '" data-provider="' + esc(p.name) + '" data-field="' + esc(f.key) + '" placeholder="' + esc(f.placeholder || '') + '" autocomplete="off">'
    ).join('');
    return '<div class="provider-form" data-provider-form="' + esc(p.name) + '">'
      + '<h3>' + esc(p.label || providerLabel(p.name)) + ' '
      + '<span class="' + (p.configured ? 'configured' : 'not-configured') + '">'
      + (p.configured ? '已配置' : '未配置') + '</span></h3>'
      + (p.quotaNote ? '<p class="quota">' + esc(p.quotaNote) + '</p>' : '')
      + inputs
      + '<button class="btn" data-save-provider="' + esc(p.name) + '">保存</button>'
      + ' <button class="btn" data-test-provider="' + esc(p.name) + '">测试连接</button>'
      + '<p class="error hidden" data-provider-error="' + esc(p.name) + '"></p>'
      + '<p class="hint hidden" data-provider-ok="' + esc(p.name) + '">已保存。</p>'
      + '</div>';
  }).join('');
}

$('providerForms').addEventListener('click', async (e) => {
  const saveBtn = e.target.closest('[data-save-provider]');
  const testBtn = e.target.closest('[data-test-provider]');
  if (!saveBtn && !testBtn) return;
  const btn = saveBtn || testBtn;
  const isTest = Boolean(testBtn);
  const name = isTest ? testBtn.dataset.testProvider : saveBtn.dataset.saveProvider;
  const errEl = document.querySelector('[data-provider-error="' + name + '"]');
  const okEl = document.querySelector('[data-provider-ok="' + name + '"]');
  hideError(errEl);
  if (okEl) okEl.classList.add('hidden');

  const body = {};
  document.querySelectorAll('input[data-provider="' + name + '"]').forEach(input => {
    const v = input.value.trim();
    if (v) body[input.dataset.field] = v;
  });
  if (!isTest && !Object.keys(body).length) {
    showError(errEl, '请至少填写一项再保存');
    return;
  }
  btn.disabled = true;
  btn.textContent = isTest ? '测试中…' : '保存中…';
  try {
    if (isTest) {
      // 只测不存：空输入时服务端用已保存的凭据测，填了新值则用新值测。
      await postJSON('/api/providers/' + encodeURIComponent(name) + '/test', body);
      if (okEl) {
        okEl.textContent = '连接成功。';
        okEl.classList.remove('hidden');
      }
    } else {
      await postJSON('/api/providers/' + encodeURIComponent(name), body);
      if (okEl) {
        okEl.textContent = '已保存。';
        okEl.classList.remove('hidden');
      }
      // 清空输入框，不回显密钥；刷新配置状态
      document.querySelectorAll('input[data-provider="' + name + '"]').forEach(input => { input.value = ''; });
      await loadProviders();
      await loadStatus();
    }
  } catch (err) {
    showError(errEl, err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = isTest ? '测试连接' : '保存';
  }
});

/* ---------- 首次启动配置向导 ---------- */

/* 向导顺序与申请链接来自 GET /api/providers（state.providerList 已按 order 排好序） */
function wizardOrder() {
  if (state.providerList && state.providerList.length) return state.providerList.map(p => p.name);
  return Object.keys(state.providers);
}

const WIZARD_DISMISSED_KEY = 'wizardDismissed';

const wizard = { step: 0 };
let wizardAutoChecked = false; // 自动弹出只在页面加载后判断一次

function wizardCreds(name) {
  const body = {};
  document.querySelectorAll('input[data-wizard-provider="' + name + '"]').forEach(input => {
    const v = input.value.trim();
    if (v) body[input.dataset.field] = v;
  });
  return body;
}

function renderWizardStep() {
  const order = wizardOrder();
  const name = order[wizard.step];
  const isLast = wizard.step === order.length - 1;
  const label = providerLabel(name);
  const meta = state.providers[name] || {};
  const quota = meta.quotaNote || '';
  const fields = meta.fields || [{ key: 'apiKey', label: 'API Key', type: 'password' }];
  const applyUrl = meta.applyUrl || '';

  $('wizardStep').textContent = '第 ' + (wizard.step + 1) + ' / ' + order.length + ' 步';
  $('wizardBody').innerHTML =
    '<h3>' + esc(label) + '</h3>'
    + (quota ? '<p class="hint">' + esc(quota) + '</p>' : '')
    + (applyUrl ? '<p><a href="' + esc(applyUrl) + '" target="_blank" rel="noopener noreferrer">去申请 →</a></p>' : '')
    + fields.map(f =>
      '<label class="field-label" for="wz-' + esc(name) + '-' + esc(f.key) + '">' + esc(f.label) + '</label>'
      + '<input id="wz-' + esc(name) + '-' + esc(f.key) + '" type="' + esc(f.type) + '" data-wizard-provider="' + esc(name) + '" data-field="' + esc(f.key) + '" placeholder="' + esc(f.placeholder || '') + '" autocomplete="off">'
    ).join('')
    + '<p class="error hidden" id="wizardError"></p>'
    + '<p class="hint hidden" id="wizardOk"></p>'
    + '<div class="wizard-actions">'
    + '<button class="btn" id="wizardTestBtn">测试连接</button>'
    + '<button class="btn primary" id="wizardNextBtn">' + (isLast ? '完成' : '保存并下一步') + '</button>'
    + '<button class="btn" id="wizardSkipBtn">跳过</button>'
    + '</div>';

  $('wizardTestBtn').addEventListener('click', async () => {
    const errEl = $('wizardError');
    const okEl = $('wizardOk');
    hideError(errEl);
    if (okEl) okEl.classList.add('hidden');
    const btn = $('wizardTestBtn');
    btn.disabled = true;
    btn.textContent = '测试中…';
    try {
      await postJSON('/api/providers/' + encodeURIComponent(name) + '/test', wizardCreds(name));
      if (okEl) {
        okEl.textContent = '连接成功，Key 可用。';
        okEl.classList.remove('hidden');
      }
    } catch (e) {
      showError(errEl, e.message);
    } finally {
      btn.disabled = false;
      btn.textContent = '测试连接';
    }
  });

  $('wizardNextBtn').addEventListener('click', async () => {
    const errEl = $('wizardError');
    hideError(errEl);
    const body = wizardCreds(name);
    if (!Object.keys(body).length) {
      showError(errEl, '请填写后保存，或点“跳过”直接下一步');
      return;
    }
    const btn = $('wizardNextBtn');
    btn.disabled = true;
    btn.textContent = '保存中…';
    try {
      await postJSON('/api/providers/' + encodeURIComponent(name), body);
      advanceWizard();
    } catch (e) {
      showError(errEl, e.message);
      btn.disabled = false;
      btn.textContent = isLast ? '完成' : '保存并下一步';
    }
  });

  $('wizardSkipBtn').addEventListener('click', advanceWizard);
}

function advanceWizard() {
  if (wizard.step >= wizardOrder().length - 1) {
    closeWizard();
  } else {
    wizard.step += 1;
    renderWizardStep();
  }
}

function openWizard() {
  wizard.step = 0;
  renderWizardStep();
  $('wizardOverlay').classList.remove('hidden');
  document.body.classList.add('wizard-open');
}

async function closeWizard() {
  $('wizardOverlay').classList.add('hidden');
  document.body.classList.remove('wizard-open');
  try { localStorage.setItem(WIZARD_DISMISSED_KEY, '1'); } catch (_) { /* 隐私模式忽略 */ }
  await loadProviders();
  await loadStatus();
}

/* 页面加载后判断一次：8 个供应商全部未配置且用户没跳过过，才自动弹出向导。 */
function maybeShowWizard() {
  if (wizardAutoChecked) return;
  wizardAutoChecked = true;
  let dismissed = false;
  try { dismissed = localStorage.getItem(WIZARD_DISMISSED_KEY) === '1'; } catch (_) { /* 隐私模式忽略 */ }
  if (dismissed) return;
  const providers = Object.values(state.providers);
  if (!providers.length) return;
  if (providers.every(p => !p.configured)) openWizard();
}

/* 设置页手动重新打开向导：清除跳过标记并显示向导。 */
$('reopenWizardBtn').addEventListener('click', () => {
  try { localStorage.removeItem(WIZARD_DISMISSED_KEY); } catch (_) { /* 隐私模式忽略 */ }
  openWizard();
});

/* ---------- 设置：剩余用量 ---------- */

function usageBar(used, limit) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return '<div class="bar"><div style="width:' + pct.toFixed(1) + '%"></div></div>';
}

async function loadUsage() {
  const box = $('usageBox');
  box.innerHTML = '<p class="muted">查询中…</p>';
  try {
    const u = await api('/api/usage');
    const rows = [];
    if (u.cloudflare) {
      const c = u.cloudflare;
      rows.push('<div class="usage-row">Cloudflare Workers AI（当日）<br>已用 <b>' + fmtNum(c.usedNeurons)
        + '</b> / ' + fmtNum(c.limit) + ' Neurons' + (c.date ? '（' + esc(c.date) + '）' : '')
        + usageBar(c.usedNeurons, c.limit) + '</div>');
    }
    if (u.kaggle) {
      const k = u.kaggle;
      const hours = (k.usedSeconds / 3600).toFixed(2);
      rows.push('<div class="usage-row">Kaggle GPU（本周）<br>已用 <b>' + fmtNum(k.usedSeconds)
        + '</b> / ' + fmtNum(k.limitSeconds) + ' 秒（约 ' + hours + ' 小时）'
        + (k.jobs != null ? '，共 ' + k.jobs + ' 个任务' : '')
        + usageBar(k.usedSeconds, k.limitSeconds) + '</div>');
    }
    if (u.elevenlabs) {
      const e = u.elevenlabs;
      rows.push('<div class="usage-row">ElevenLabs（本月）<br>已用 <b>' + fmtNum(e.character_count)
        + '</b> / ' + fmtNum(e.character_limit) + ' 字符'
        + usageBar(e.character_count, e.character_limit) + '</div>');
    } else {
      rows.push('<div class="usage-row">ElevenLabs：未配置或暂未查到用量</div>');
    }
    if (u.deepl) {
      const d = u.deepl;
      rows.push('<div class="usage-row">DeepL<br>已用 <b>' + fmtNum(d.character_count)
        + '</b> / ' + fmtNum(d.character_limit) + ' 字符'
        + usageBar(d.character_count, d.character_limit) + '</div>');
    } else {
      rows.push('<div class="usage-row">DeepL：未配置或暂未查到用量</div>');
    }
    box.innerHTML = rows.length ? rows.join('') : '<p class="muted">暂无用量数据。</p>';
  } catch (e) {
    box.innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

$('usageRefreshBtn').addEventListener('click', loadUsage);

/* ---------- 设置：数据备份 ---------- */

function backupOk(msg) {
  const okEl = $('backupOk');
  if (!okEl) return;
  okEl.textContent = msg;
  okEl.classList.remove('hidden');
}

function hideBackupMessages() {
  hideError($('backupError'));
  const okEl = $('backupOk');
  if (okEl) okEl.classList.add('hidden');
}

$('backupExportBtn').addEventListener('click', async () => {
  hideBackupMessages();
  const btn = $('backupExportBtn');
  btn.disabled = true;
  btn.textContent = '导出中…';
  try {
    const data = await api('/api/backup/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const d = new Date();
    const stamp = d.getFullYear()
      + String(d.getMonth() + 1).padStart(2, '0')
      + String(d.getDate()).padStart(2, '0');
    const a = document.createElement('a');
    a.href = url;
    a.download = 'free-ai-tool-station-backup-' + stamp + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    backupOk('已导出 ' + (data.history || []).length + ' 条历史、'
      + (data.chats || []).length + ' 个会话。备份不含 Key 与生成文件，请另行保存 Key。');
  } catch (e) {
    showError($('backupError'), e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '导出数据';
  }
});

$('backupImportBtn').addEventListener('click', () => {
  $('backupFileInput').click();
});

$('backupFileInput').addEventListener('change', async () => {
  const input = $('backupFileInput');
  const file = input.files && input.files[0];
  input.value = ''; // 清空，允许重复选同一文件
  if (!file) return;
  hideBackupMessages();
  let text;
  try {
    text = await file.text();
  } catch (e) {
    showError($('backupError'), '读取文件失败，请重试');
    return;
  }
  let backup;
  try {
    backup = JSON.parse(text);
  } catch (e) {
    showError($('backupError'), '文件不是有效的 JSON 备份');
    return;
  }
  if (!window.confirm('将合并导入备份：现有数据保留，重复记录不重复导入，Key 不会被恢复。确定导入吗？')) {
    return;
  }
  const btn = $('backupImportBtn');
  btn.disabled = true;
  btn.textContent = '导入中…';
  try {
    const result = await postJSON('/api/backup/import', backup);
    const imported = result.imported || {};
    backupOk('导入完成：新增 ' + (imported.history || 0) + ' 条历史、'
      + (imported.chats || 0) + ' 个会话，用量已更新。');
    loadUsage();
    loadHistory();
    loadChats();
  } catch (e) {
    showError($('backupError'), e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '导入数据';
  }
});

/* ---------- 访问密码保护 ---------- */

/* 本次登录是否需要动态码（由 initAuth 从 /api/auth/status 取回）。 */
let loginNeedsTotp = false;

function showLoginOverlay() {
  $('loginOverlay').classList.remove('hidden');
  document.body.classList.add('login-open');
  $('totpField').classList.toggle('hidden', !loginNeedsTotp);
  const input = $('loginPassword');
  if (input) input.focus();
}

function hideLoginOverlay() {
  $('loginOverlay').classList.add('hidden');
  document.body.classList.remove('login-open');
}

async function submitLogin() {
  const input = $('loginPassword');
  const totpInput = $('loginTotp');
  const errEl = $('loginError');
  const btn = $('loginBtn');
  hideError(errEl);
  const password = input.value;
  if (!password) { showError(errEl, '请输入访问密码'); return; }
  const body = { password };
  if (loginNeedsTotp) {
    const totpCode = totpInput.value.trim();
    if (!totpCode) { showError(errEl, '请输入动态码'); return; }
    body.totpCode = totpCode;
  }
  btn.disabled = true;
  btn.textContent = '登录中…';
  try {
    await postJSON('/api/login', body);
    input.value = '';
    totpInput.value = '';
    hideLoginOverlay();
    initApp();
  } catch (e) {
    showError(errEl, e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = '登录';
  }
}

$('loginBtn').addEventListener('click', submitLogin);
$('loginPassword').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitLogin();
});
$('loginTotp').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') submitLogin();
});

/* ---------- 二次验证（TOTP）设置 ---------- */

/* 发 POST 但不走 api() 的 401 跳登录逻辑：确认/关闭接口的 401 只是
   “动态码或密码不对”，不是会话过期；只有服务端说“未登录”时才跳登录。 */
async function postJSONPlain(path, body) {
  let res;
  try {
    res = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (e) {
    throw new Error('网络请求失败，请检查服务是否启动');
  }
  const data = await res.json().catch(() => null);
  if (res.status === 401 && data && data.message === '未登录，请先登录') {
    showLoginOverlay();
    throw new Error('登录已过期，请重新登录');
  }
  if (!res.ok || (data && data.ok === false)) {
    throw new Error((data && data.message) || ('请求失败（HTTP ' + res.status + '）'));
  }
  return data;
}

function showHint(el, msg) {
  if (!el) return;
  el.textContent = msg;
  el.classList.remove('hidden');
}
function hideHint(el) { if (el) el.classList.add('hidden'); }

/* 待确认的密钥（setup 返回后存在内存里，confirm 时传回服务端）。 */
let pendingTotpSecret = '';

async function loadTotpStatus() {
  const box = $('totpStatus');
  const errEl = $('totpError');
  const okEl = $('totpOk');
  hideError(errEl);
  hideHint(okEl);
  try {
    const s = await api('/api/totp/status');
    if (!s.authEnabled) {
      box.innerHTML = '<p class="muted">未设置访问密码，无法开启二次验证。请先在部署环境里设置 ACCESS_PASSWORD。</p>';
      return;
    }
    if (s.totpEnabled) {
      box.innerHTML = '<p>已开启（剩余备用码 ' + s.backupCodesRemaining + ' 个）</p>'
        + '<button class="btn" id="totpDisableBtn">关闭二次验证</button>';
      $('totpDisableBtn').addEventListener('click', () => {
        hideError(errEl);
        hideHint(okEl);
        $('totpDisable').classList.remove('hidden');
        $('totpDisablePassword').focus();
      });
    } else {
      box.innerHTML = '<p class="muted">未开启</p>'
        + '<button class="btn primary" id="totpEnableBtn">开启二次验证</button>';
      $('totpEnableBtn').addEventListener('click', startTotpSetup);
    }
  } catch (e) {
    box.innerHTML = '<p class="muted">状态加载失败</p>';
    showError(errEl, e.message);
  }
}

async function startTotpSetup() {
  const errEl = $('totpError');
  const okEl = $('totpOk');
  hideError(errEl);
  hideHint(okEl);
  try {
    const data = await api('/api/totp/setup', { method: 'POST' });
    pendingTotpSecret = data.secret;
    // 密钥按 4 位分组展示，好抄。
    $('totpSecretText').textContent = data.secret.replace(/(.{4})/g, '$1 ').trim();
    $('totpUrlText').textContent = data.otpauthUrl;
    $('totpSetup').classList.remove('hidden');
    $('totpConfirmCode').value = '';
    $('totpConfirmCode').focus();
  } catch (e) {
    showError(errEl, e.message);
  }
}

$('totpConfirmBtn').addEventListener('click', async () => {
  const errEl = $('totpSetupError');
  const okEl = $('totpOk');
  hideError(errEl);
  hideHint(okEl);
  const code = $('totpConfirmCode').value.trim();
  if (!code) { showError(errEl, '请输入动态码'); return; }
  try {
    const data = await postJSONPlain('/api/totp/confirm', { secret: pendingTotpSecret, code });
    pendingTotpSecret = '';
    $('totpSetup').classList.add('hidden');
    $('totpBackupCodesText').textContent = data.backupCodes.join('\n');
    $('totpBackupCodes').classList.remove('hidden');
    showHint(okEl, '二次验证已开启。下次登录需要输入动态码。');
    loadTotpStatus();
  } catch (e) {
    showError(errEl, e.message);
  }
});

$('totpDisableConfirmBtn').addEventListener('click', async () => {
  const errEl = $('totpError');
  const okEl = $('totpOk');
  hideError(errEl);
  hideHint(okEl);
  const password = $('totpDisablePassword').value;
  if (!password) { showError(errEl, '请输入访问密码'); return; }
  try {
    await postJSONPlain('/api/totp/disable', { password });
    $('totpDisablePassword').value = '';
    $('totpDisable').classList.add('hidden');
    $('totpBackupCodes').classList.add('hidden');
    showHint(okEl, '二次验证已关闭。');
    loadTotpStatus();
  } catch (e) {
    showError(errEl, e.message);
  }
});

/* ---------- 初始化 ---------- */

function initApp() {
  refreshChatModels();
  refreshTtsVoices();
  loadModels();
  updateBackendNote();
  loadProviders();
  loadStatus();
  loadHistory();
  loadUsage();
  loadTotpStatus();
}

/* 先查登录状态：需要登录且未登录时只显示登录遮罩，不发起数据请求；
   状态接口不通时按不设防处理（后续请求会按原有逻辑报网络错误）。 */
async function initAuth() {
  let s = { authRequired: false, authenticated: true };
  try {
    s = await api('/api/auth/status');
  } catch (e) { /* 状态接口不通，按不设防处理 */ }
  loginNeedsTotp = s.totpEnabled === true;
  if (s.authRequired && !s.authenticated) {
    showLoginOverlay();
    return;
  }
  initApp();
}

initAuth();
