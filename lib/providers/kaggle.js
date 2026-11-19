'use strict';
/**
 * lib/providers/kaggle.js — Kaggle API 客户端（Basic Auth，username:apiKey）。
 *
 * 按 /tmp/tool-station-contract.md 实现。不用 kaggle CLI，直接调 REST API。
 *
 * ── push 请求格式（2026-11-19 核实，非猜测）────────────────────────────
 * POST https://www.kaggle.com/api/v1/kernels/push
 *   Content-Type: application/json；body 是 JSON，不是 multipart，也没有代码包。
 *   kernel 源码以字符串形式放在 `text` 字段内联提交（CLI 也只发 code_file 的
 *   文本内容，推送目录里的其他文件不会上传）。
 *   字段（REST JSON 用驼峰命名；proto 定义里是下划线命名）：
 *     必填：text（源码）、language（"python"）、kernelType（"script"），
 *           以及 id / slug 二选一（slug 格式为 "USERNAME/KERNEL-SLUG"）。
 *     本模块用的可选字段：newTitle（标题；Kaggle 会按标题派生规范 slug，
 *           所以标题必须与 slug 对应，否则后续 status/output 调用可能 403/409）、
 *           isPrivate、enableGpu、enableInternet、dockerImagePinningType。
 *   成功返回 ApiSaveKernelResponse：{ref, url, versionNumber, error, ...}；
 *   error 非空即表示保存失败。push 成功后 kernel 立即进入运行队列。
 * 来源：
 *   - Kaggle 官方文档（kagglesdk 类型定义 ApiSaveKernelRequest/Response、
 *     ApiGetKernelSessionStatusRequest/Response、ApiListKernelSessionOutputRequest/
 *     Response）：https://www.kaggle.com/docs/mcp
 *   - REST 端点字段表（驼峰命名、application/json）：
 *     https://www.withone.ai/knowledge/kaggle/conn_mod_def::GMKVaIWk5to::R58KSms_Reas_W44mkN3sQ
 *   - Kaggle 官方 CLI 文档（push 即上传并运行；--accelerator 列表）：
 *     https://github.com/Kaggle/kaggle-cli/blob/main/docs/kernels.md
 *     （注：Kaggle/kaggle-api 仓库已改名 Kaggle/kaggle-cli；kagglesdk 是独立包）
 *   - 第三方佐证 push 为 application/json：
 *     https://pypi.org/project/kaggle-free-gpu/
 * 注意：官方文档把 enableGpu 标为 DEPRECATED（建议用 machine_shape 代替），但
 * REST /kernels/push 的请求体里没有 machineShape 字段，enableGpu 仍是该端点
 * 开 GPU 的方式；契约也要求 push 里设置 enableGpu，故保留。
 *
 * ── 状态与输出 ─────────────────────────────────────────────────────────
 * 状态查询必须用查询参数形式：
 *   GET /kernels/status?userName=<user>&kernelSlug=<slug>
 * /kernels/status/<ref> 路径形式不存在，会 404（2026-11-18 实测教训）。
 * 状态值是 KernelWorkerStatus：QUEUED / RUNNING / COMPLETE / ERROR /
 * CANCEL_REQUESTED / CANCEL_ACKNOWLEDGED / NEW_SCRIPT，本模块归一化为
 * queued / running / done / failed / unknown。
 * 输出列表：
 *   GET /kernels/output/list?userName=<user>&kernelSlug=<slug>&pageSize=100
 * 返回 {files: [{url, fileName}], log, nextPageToken}；url 是可直接下载的链接。
 *
 * 错误策略：上游 4xx 直接 fail fast，错误里带上 Kaggle 返回的消息
 * （err.retryable=false）；429 / 5xx 和网络瞬时错误抛可重试的 Error
 * （err.retryable=true）。调用方（routes/generation.js）据此决定是否重试。
 */

const { buildFluxKernelCode, buildWanKernelCode } = require('../kaggle-kernels');

const BASE_URL = 'https://www.kaggle.com/api/v1';
const PUSH_TIMEOUT_MS = 120000;
const GET_TIMEOUT_MS = 30000;
const DOWNLOAD_TIMEOUT_MS = 300000;
const MAX_OUTPUT_PAGES = 10;

class KaggleError extends Error {
  /**
   * @param {string} message
   * @param {object} [opts]
   * @param {number|null} [opts.status] - 上游 HTTP 状态码（网络错误时为 null）
   * @param {boolean} [opts.retryable] - 是否值得重试（429/5xx/网络错误为 true）
   */
  constructor(message, { status = null, retryable = false } = {}) {
    super(message);
    this.name = 'KaggleError';
    this.status = status;
    this.retryable = retryable;
  }
}

function authHeader(username, apiKey) {
  return 'Basic ' + Buffer.from(`${username}:${apiKey}`, 'utf8').toString('base64');
}

function requireCreds(username, apiKey) {
  if (!username || !apiKey) {
    throw new KaggleError('Kaggle 未配置：缺少用户名或 API Key', { retryable: false });
  }
}

/** slug 可能是裸 slug（如 free-ai-tool-station-flux）或完整引用（user/slug）。 */
function splitSlug(username, slug) {
  const raw = String(slug || '');
  const bare = raw.includes('/') ? raw.split('/').pop() : raw;
  if (!bare) throw new KaggleError('缺少 kernel slug', { retryable: false });
  return { bare, full: `${username}/${bare}` };
}

/** 把 slug 转成标题（free-ai-tool-station-flux → "Free Ai Tool Station Flux"），
 *  保证 Kaggle 按标题派生的 slug 与我们用的 slug 一致。 */
function titleFromSlug(slug) {
  return slug
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** 从上游错误响应里抠出可读消息（Kaggle 错误体常见 {code, message} 或 {error}）。 */
function extractErrorMessage(data, text) {
  if (data && typeof data === 'object') {
    if (typeof data.message === 'string' && data.message) return data.message;
    if (typeof data.error === 'string' && data.error) return data.error;
    if (data.error && typeof data.error === 'object') {
      return JSON.stringify(data.error).slice(0, 500);
    }
  }
  if (typeof data === 'string' && data) return data.slice(0, 500);
  return (text || '').slice(0, 500) || '未知错误';
}

async function requestJson({ username, apiKey, method, path, body, timeoutMs }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: authHeader(username, apiKey),
        Accept: 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    throw new KaggleError(`Kaggle 请求失败（网络错误，可重试）：${err.message}`, {
      retryable: true,
    });
  }
  const text = await res.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch (_) {
      // 非 JSON 响应（如 HTML 错误页），下面按文本处理
    }
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new KaggleError(
      `Kaggle 返回 HTTP ${res.status}：${extractErrorMessage(data, text)}`,
      { status: res.status, retryable },
    );
  }
  return data;
}

/**
 * push 一个 kernel 版本（新建或更新），push 成功后 kernel 立即运行。
 * @param {object} params
 * @param {string} params.username - Kaggle 用户名
 * @param {string} params.apiKey - Kaggle API Key（Legacy API Key）
 * @param {string} params.slug - kernel slug（裸 slug 或 user/slug）
 * @param {string} params.code - kernel Python 源码（以 text 字段内联提交）
 * @returns {Promise<{kernelSlug: string, ref: string, url: string|null, versionNumber: number|null}>}
 */
async function pushKernel({ username, apiKey, slug, code }) {
  const { bare, full } = splitSlug(username, slug);
  const body = {
    slug: full,
    newTitle: titleFromSlug(bare),
    text: code,
    language: 'python',
    kernelType: 'script',
    isPrivate: true,
    enableGpu: true,
    enableInternet: true, // kernel 内要从 GitHub/HuggingFace 下载 ComfyUI 与模型
    dockerImagePinningType: 'latest',
  };
  const data = await requestJson({
    username,
    apiKey,
    method: 'POST',
    path: '/kernels/push',
    body,
    timeoutMs: PUSH_TIMEOUT_MS,
  });
  if (data && data.error) {
    throw new KaggleError(`Kaggle 保存 kernel 失败：${data.error}`, { retryable: false });
  }
  return {
    kernelSlug: bare,
    ref: (data && data.ref) || full,
    url: (data && data.url) || null,
    versionNumber:
      (data && (data.versionNumber ?? data.version_number)) ?? null,
  };
}

/**
 * 提交 FLUX 出图任务（Kaggle GPU，FLUX.1 schnell FP8，1024x1024）。
 * @param {object} params
 * @param {string} params.username
 * @param {string} params.apiKey
 * @param {string} params.prompt
 * @param {string} params.slug - 出图 kernel slug（默认 free-ai-tool-station-flux）
 * @returns {Promise<{kernelSlug: string, ref: string, url: string|null, versionNumber: number|null}>}
 */
async function submitImageJob({ username, apiKey, prompt, slug }) {
  requireCreds(username, apiKey);
  const code = buildFluxKernelCode({ prompt });
  return pushKernel({ username, apiKey, slug, code });
}

/**
 * 提交 Wan 图生视频任务（Kaggle GPU，Wan 2.2 TI2V-5B，720p，5 秒）。
 * @param {object} params
 * @param {string} params.username
 * @param {string} params.apiKey
 * @param {string} params.firstFrameBase64 - 首帧图片 base64
 * @param {string} params.prompt - 动作描述
 * @param {string} params.slug - 视频 kernel slug（默认 free-ai-tool-station-wan-video）
 * @returns {Promise<{kernelSlug: string, ref: string, url: string|null, versionNumber: number|null}>}
 */
async function submitVideoJob({ username, apiKey, firstFrameBase64, prompt, slug }) {
  requireCreds(username, apiKey);
  const code = buildWanKernelCode({ firstFrameBase64, prompt });
  return pushKernel({ username, apiKey, slug, code });
}

const STATUS_MAP = {
  QUEUED: 'queued',
  RUNNING: 'running',
  COMPLETE: 'done',
  ERROR: 'failed',
  CANCEL_REQUESTED: 'failed',
  CANCEL_ACKNOWLEDGED: 'failed',
  NEW_SCRIPT: 'queued', // 版本已保存、尚未开始运行
};

/** KernelWorkerStatus → queued/running/done/failed/unknown（容忍大小写与前缀）。 */
function normalizeStatus(raw) {
  if (!raw || typeof raw !== 'string') return 'unknown';
  const key = raw.replace(/^KernelWorkerStatus\./, '').trim().toUpperCase();
  return STATUS_MAP[key] || 'unknown';
}

/**
 * 查询 kernel 最新一次运行的状态（查询参数形式，路径形式不存在会 404）。
 * @param {object} params
 * @param {string} params.username
 * @param {string} params.apiKey
 * @param {string} params.slug
 * @returns {Promise<{status: 'queued'|'running'|'done'|'failed'|'unknown', rawStatus: string|null, failureMessage: string|null}>}
 */
async function getStatus({ username, apiKey, slug }) {
  requireCreds(username, apiKey);
  const { bare } = splitSlug(username, slug);
  const qs = new URLSearchParams({ userName: username, kernelSlug: bare });
  const data = await requestJson({
    username,
    apiKey,
    method: 'GET',
    path: `/kernels/status?${qs}`,
    timeoutMs: GET_TIMEOUT_MS,
  });
  const rawStatus = (data && data.status) || null;
  return {
    status: normalizeStatus(rawStatus),
    rawStatus,
    failureMessage:
      (data && (data.failureMessage ?? data.failure_message)) || null,
  };
}

/**
 * 列出 kernel 最新一次运行的输出文件（含下载链接；自动翻页）。
 * @param {object} params
 * @param {string} params.username
 * @param {string} params.apiKey
 * @param {string} params.slug
 * @returns {Promise<Array<{fileName: string|null, url: string|null}>>}
 */
async function getOutputFiles({ username, apiKey, slug }) {
  requireCreds(username, apiKey);
  const { bare } = splitSlug(username, slug);
  const files = [];
  let pageToken = null;
  for (let page = 0; page < MAX_OUTPUT_PAGES; page++) {
    const params = new URLSearchParams({
      userName: username,
      kernelSlug: bare,
      pageSize: '100',
    });
    if (pageToken) params.set('pageToken', pageToken);
    const data = await requestJson({
      username,
      apiKey,
      method: 'GET',
      path: `/kernels/output/list?${params}`,
      timeoutMs: GET_TIMEOUT_MS,
    });
    const items = data && Array.isArray(data.files) ? data.files : [];
    for (const f of items) {
      files.push({
        fileName: f.fileName ?? f.file_name ?? null,
        url: f.url ?? f.downloadUrl ?? f.download_url ?? null,
      });
    }
    pageToken = (data && (data.nextPageToken ?? data.next_page_token)) || null;
    if (!pageToken) break;
  }
  return files;
}

/**
 * 下载一个成品文件（output 列表里的 url 是可直接下载的链接，不带鉴权头）。
 * @param {string} url - 下载链接
 * @returns {Promise<Buffer>} 文件字节
 */
async function downloadFile(url) {
  let res;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  } catch (err) {
    throw new KaggleError(`下载 Kaggle 成品失败（网络错误，可重试）：${err.message}`, {
      retryable: true,
    });
  }
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new KaggleError(`下载 Kaggle 成品失败：HTTP ${res.status}`, {
      status: res.status,
      retryable,
    });
  }
  return Buffer.from(await res.arrayBuffer());
}

module.exports = {
  BASE_URL,
  KaggleError,
  submitImageJob,
  submitVideoJob,
  getStatus,
  getOutputFiles,
  downloadFile,
};
