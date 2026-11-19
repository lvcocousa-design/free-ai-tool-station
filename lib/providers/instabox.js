// lib/providers/instabox.js — InstaBox 免费云电脑上的 ComfyUI 代理客户端
//
// 按 /tmp/tool-station-contract.md 实现。
// baseUrl 由调用方传入（来自 config：环境变量 INSTABOX_PROXY_URL 或
// settings 的 instabox.proxyUrl），本模块不读环境变量、不硬编码任何地址。
//
// 代理接口（/data/proxy/proxy.js）：
//   POST {baseUrl}/generate  body {prompt, width, height, steps} → {prompt_id}
//   GET  {baseUrl}/progress?id=<prompt_id> → {status, images?}
//   GET  {baseUrl}/image?name=<name> → 图片字节
//   GET  {baseUrl}/progress?id=ping → 200 即在线（checkOnline 用）

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
 * @returns {Promise<{prompt_id: string}>}
 */
async function generate(baseUrl, { prompt, width = 512, height = 768, steps = 20 } = {}) {
  const url = normalizeBaseUrl(baseUrl);
  const res = await fetch(`${url}/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt, width, height, steps }),
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

module.exports = { generate, getProgress, fetchImage, checkOnline, createInstaboxClient };
