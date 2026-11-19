// lib/providers/instabox.js — InstaBox 免费云电脑上的 ComfyUI 代理客户端
//
// 按 /tmp/tool-station-contract.md 实现。
// baseUrl 由调用方传入（来自 config：环境变量 INSTABOX_PROXY_URL 或
// settings 的 instabox.proxyUrl），本模块不读环境变量、不硬编码任何地址。
//
// 代理接口（/data/proxy/proxy.js）：
//   POST {baseUrl}/generate  body {prompt, width, height, steps, cfg} → {prompt_id}
//   GET  {baseUrl}/progress?id=<prompt_id> → {status, images?}
//   GET  {baseUrl}/image?name=<name> → 图片字节
//   GET  {baseUrl}/progress?id=ping → 200 即在线（checkOnline 用）

const { probe } = require('../probe');

function normalizeBaseUrl(baseUrl) {
  if (!baseUrl || typeof baseUrl !== 'string') {
    throw new Error('InstaBox 未配置：缺少代理地址');
  }
  return baseUrl.replace(/\/+$/, '');
}

/** 把上游非 2xx 响应转成带状态码的 Error。 */
async function throwUpstream(res, action) {
  let detail = '';
  try {
    detail = (await res.text()).slice(0, 300);
  } catch (_) {
    // 读不到响应体也无妨
  }
  throw new Error(`InstaBox ${action}失败，返回 HTTP ${res.status}${detail ? `：${detail}` : ''}`);
}

/**
 * 提交出图任务。
 * @param {string} baseUrl - InstaBox 代理地址（调用方传入）
 * @param {object} params
 * @param {string} params.prompt
 * @param {number} [params.width=512]
 * @param {number} [params.height=768]
 * @param {number} [params.steps=20]
 * @param {number} [params.cfg=7]
 * @returns {Promise<{prompt_id: string}>}
 */
async function generate(baseUrl, { prompt, width = 512, height = 768, steps = 20, cfg = 7 } = {}) {
  const url = normalizeBaseUrl(baseUrl);
  // 代理若不支持 cfg 会忽略它，cfg 生效需代理配合转发到 ComfyUI 工作流。
  const res = await fetch(`${url}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width, height, steps, cfg }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) await throwUpstream(res, '提交生成任务');
  const data = await res.json();
  if (!data || !data.prompt_id) {
    throw new Error('InstaBox 提交生成任务失败：上游未返回 prompt_id');
  }
  return data;
}

/**
 * 查询任务进度。
 * @param {string} baseUrl
 * @param {string} promptId
 * @returns {Promise<{status: string, images?: string[]}>}
 */
async function getProgress(baseUrl, promptId) {
  const url = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${url}/progress?id=${encodeURIComponent(promptId)}`, {
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) await throwUpstream(res, '查询进度');
  return res.json();
}

/**
 * 下载一张已生成的图片。
 * @param {string} baseUrl
 * @param {string} name - progress 返回的 images[0] 里的文件名
 * @returns {Promise<Buffer>}
 */
async function fetchImage(baseUrl, name) {
  const url = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${url}/image?name=${encodeURIComponent(name)}`, {
    signal: AbortSignal.timeout(60000),
  });
  if (!res.ok) await throwUpstream(res, '下载图片');
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 探活：GET /progress?id=ping，5 秒超时，200 即在线。
 * 任何失败（超时、非 200、未配置）都返回 false，不抛错。
 * @param {string} baseUrl
 * @returns {Promise<boolean>}
 */
async function checkOnline(baseUrl) {
  if (!baseUrl) return false;
  try {
    const url = normalizeBaseUrl(baseUrl);
    const res = await fetch(`${url}/progress?id=ping`, {
      signal: AbortSignal.timeout(5000),
    });
    return res.ok;
  } catch (_) {
    return false;
  }
}

/**
 * 工厂：把 baseUrl 绑定成一个客户端，调用方不用每次传地址。
 * @param {string} baseUrl
 */
function createInstaboxClient(baseUrl) {
  return {
    generate: (params) => generate(baseUrl, params),
    getProgress: (promptId) => getProgress(baseUrl, promptId),
    fetchImage: (name) => fetchImage(baseUrl, name),
    checkOnline: () => checkOnline(baseUrl),
  };
}

// ── 插件接口（供 lib/provider-registry.js 发现）────────────────────────

const meta = {
  name: 'instabox',
  label: 'InstaBox',
  quotaNote: '免费云电脑：单次运行最长 2 小时，空闲自动暂停',
  applyUrl: 'https://instabox.tech',
  order: 80,
  capabilities: ['image'],
  credentials: [
    // placeholder 为可选扩展字段：设置页/向导用它做输入提示，不影响凭据逻辑。
    { key: 'proxyUrl', label: '代理地址', type: 'text', env: 'INSTABOX_PROXY_URL', required: true, placeholder: '形如 https://3001-xxx.instabox.tech' },
  ],
};

// 只读连接探测：探代理 /progress?id=ping，200 即通（与 checkOnline 同款）；
// 内部 catch 转中文，不抛错。
async function test(creds = {}) {
  let base;
  try {
    base = new URL(creds.proxyUrl).toString().replace(/\/+$/, '');
  } catch (_) {
    return { ok: false, message: '代理地址格式不正确，应为 https:// 开头的完整地址' };
  }
  try {
    return await probe(`${base}/progress?id=ping`);
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

module.exports = { meta, test, generate, getProgress, fetchImage, checkOnline, createInstaboxClient };
