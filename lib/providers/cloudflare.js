// lib/providers/cloudflare.js — Cloudflare Workers AI 客户端
//
// 基地址：https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/run/{model}
// 认证：Authorization: Bearer <Workers AI API Token>
//
// 多代理共写文件（见契约）：生成代理先创建骨架（出图部分），文本代理追加
// 对话/翻译/向量函数，语音代理追加 Whisper/MeloTTS 函数。追加时只在下方
// 对应注释分区里加新函数，并在文末 module.exports 里加导出，绝不修改
// 已有函数。函数名不要冲突。
//
// ── Neuron 费率表 RATES ──────────────────────────────────────────────
// 来源：Cloudflare 官方定价页
//   https://developers.cloudflare.com/workers-ai/platform/pricing/
//   （页面标注 Updated: 2026-11-18；本表于 2026-11-19 核实，以下费率
//   全部取自该页原文，无约数。）
// 免费额度：每天 10,000 Neurons，每日 00:00 UTC 重置；超出后按
// $0.011 / 1,000 Neurons 计费（Workers Paid 计划）。
//
// FLUX schnell 的计费是两项相加：每张 512x512 tile 4.80 Neurons +
// 每步 9.60 Neurons。1024x1024 = 4 个 tile，默认 4 步，即
// 4×4.80 + 4×9.60 = 57.6 Neurons/张（estimateImageNeurons 按此算，向上取整）。
// LLM / 翻译 / 向量按 token 计费；Whisper / MeloTTS 按音频分钟计费。
// ─────────────────────────────────────────────────────────────────────

const RATES = {
  // 出图：按 tile + 步数计费
  '@cf/black-forest-labs/flux-1-schnell': {
    perTile512: 4.8, // Neurons / 512x512 tile
    perStep: 9.6, // Neurons / step
  },
  // 对话：按 token 计费（每百万 token 的 Neurons）
  '@cf/meta/llama-3.1-8b-instruct-fp8': {
    perMillionInputTokens: 13778,
    perMillionOutputTokens: 26128,
  },
  // 翻译：按 token 计费
  '@cf/meta/m2m100-1.2b': {
    perMillionInputTokens: 31050,
    perMillionOutputTokens: 31050,
  },
  // 语音转文字：按音频分钟计费
  '@cf/openai/whisper-large-v3-turbo': {
    perAudioMinute: 46.63,
  },
  // 语音合成：按音频分钟计费
  '@cf/myshell-ai/melotts': {
    perAudioMinute: 18.63,
  },
  // 向量：按输入 token 计费
  '@cf/baai/bge-m3': {
    perMillionInputTokens: 1075,
  },
};

const FLUX_MODEL = '@cf/black-forest-labs/flux-1-schnell';
const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const TRANSLATE_MODEL = '@cf/meta/m2m100-1.2b';
const WHISPER_MODEL = '@cf/openai/whisper-large-v3-turbo';
const TTS_MODEL = '@cf/myshell-ai/melotts';
const EMBED_MODEL = '@cf/baai/bge-m3';

function runUrl(accountId, model) {
  return `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
}

/** 从上游 JSON 错误体里抽一句可读的消息。 */
function extractErrorMessage(data, fallback) {
  if (!data || typeof data !== 'object') return fallback;
  if (Array.isArray(data.errors) && data.errors.length > 0) {
    const first = data.errors[0];
    if (typeof first === 'string') return first;
    if (first && first.message) return first.message;
  }
  if (typeof data.message === 'string' && data.message) return data.message;
  return fallback;
}

// ═══════════════════════════════════════════════════════════════════
// 出图（生成代理）
// ═══════════════════════════════════════════════════════════════════

/**
 * 估算一次 FLUX 出图消耗的 Neurons（向上取整）。
 * 官方计费：4.80 Neurons / 512x512 tile + 9.60 Neurons / step。
 * @param {object} [opts]
 * @param {number} [opts.width=1024]
 * @param {number} [opts.height=1024]
 * @param {number} [opts.steps=4]
 * @returns {number} Neurons（整数）
 */
function estimateImageNeurons({ width = 1024, height = 1024, steps = 4 } = {}) {
  const rate = RATES[FLUX_MODEL];
  const tiles = Math.ceil(width / 512) * Math.ceil(height / 512);
  return Math.ceil(tiles * rate.perTile512 + steps * rate.perStep);
}

/**
 * FLUX.1 schnell 出图。
 * @param {object} opts
 * @param {string} opts.accountId - Cloudflare 账号 ID
 * @param {string} opts.apiKey - Workers AI API Token
 * @param {string} opts.prompt
 * @param {number} [opts.numSteps=4]
 * @returns {Promise<Buffer>} 图片字节
 * @throws 上游返回 JSON 错误时抛带状态码的 Error，如
 *         "Cloudflare 出图返回 HTTP 400：..."
 */
async function generateImage({ accountId, apiKey, prompt, numSteps = 4 }) {
  if (!accountId || !apiKey) {
    throw new Error('Cloudflare 未配置：缺少 accountId 或 API Token');
  }
  const res = await fetch(runUrl(accountId, FLUX_MODEL), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ prompt, num_steps: numSteps }),
    signal: AbortSignal.timeout(180000),
  });

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.success === false)) {
      const message = extractErrorMessage(data, res.statusText || '未知错误');
      throw new Error(`Cloudflare 出图返回 HTTP ${res.status}：${message}`);
    }
    // 防御：某些情况下上游以 JSON 包 base64 图片返回
    const b64 = data && data.result && (data.result.image || data.result);
    if (typeof b64 === 'string' && b64.length > 0) {
      return Buffer.from(b64, 'base64');
    }
    throw new Error('Cloudflare 出图返回了意料之外的 JSON，未含图片数据');
  }

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(
      `Cloudflare 出图返回 HTTP ${res.status}${text ? `：${text.slice(0, 300)}` : ''}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

// ═══════════════════════════════════════════════════════════════════
// 对话（文本代理追加区：llama-3.1-8b-instruct-fp8）
// 在此分区内添加函数，不要改动上方已有函数。
// ═══════════════════════════════════════════════════════════════════

// 粗略估算文本的 token 数（用于 Neuron 记账；上游未返回 usage 时的 fallback）：
// 中日韩字符约 1.5 字符/token，其余约 4 字符/token。
function estimateTokens(text) {
  let tokens = 0;
  for (const ch of String(text || '')) {
    tokens += /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(ch) ? 1 / 1.5 : 1 / 4;
  }
  return Math.max(1, Math.ceil(tokens));
}

// 按 RATES 表估算一次调用的 Neurons（向上取整，最少 1）。
// usage 优先用上游返回的 {prompt_tokens, completion_tokens}（若有）。
function estimateNeurons(model, inputText, outputText, usage) {
  const rate = RATES[model];
  if (!rate || !rate.perMillionInputTokens) return null;
  const inputTokens = usage?.prompt_tokens ?? estimateTokens(inputText);
  const outputTokens = usage?.completion_tokens ?? estimateTokens(outputText);
  const inputNeurons = (inputTokens * rate.perMillionInputTokens) / 1e6;
  const outputNeurons = rate.perMillionOutputTokens
    ? (outputTokens * rate.perMillionOutputTokens) / 1e6
    : 0;
  return Math.max(1, Math.ceil(inputNeurons + outputNeurons));
}

// 通用文本模型调用：POST 后解析 JSON，返回 result 字段。
// label 用于错误信息（如“对话”）。
async function runTextModel(accountId, apiKey, model, body, label) {
  if (!accountId || !apiKey) {
    throw new Error('Cloudflare 未配置：缺少 accountId 或 API Token');
  }
  let res;
  try {
    res = await fetch(runUrl(accountId, model), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    throw new Error(`请求 Cloudflare ${label}失败：${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.success === false)) {
    const message = extractErrorMessage(data, res.statusText || '未知错误');
    throw new Error(`Cloudflare ${label}返回 HTTP ${res.status}：${message}`);
  }
  if (!data || data.result === undefined) {
    throw new Error(`Cloudflare ${label}返回了无法解析的响应`);
  }
  return data.result;
}

// 对话（llama-3.1-8b-instruct-fp8，返回 result.response）
// chat({accountId, apiKey, model, messages}) → {text, model, neurons}
// neurons 按 RATES 表估算，路由层用它调 usage.addCloudflareNeurons 记账。
async function chat({ accountId, apiKey, model, messages }) {
  const useModel = model || CHAT_MODEL;
  if (useModel !== CHAT_MODEL) {
    throw new Error(`Cloudflare 对话只支持模型 ${CHAT_MODEL}`);
  }
  const result = await runTextModel(accountId, apiKey, useModel, { messages }, '对话');
  const text = typeof result === 'string' ? result : result?.response;
  if (typeof text !== 'string') {
    throw new Error('Cloudflare 对话返回的响应中没有文本内容');
  }
  const inputText = (messages || []).map((m) => m.content || '').join('\n');
  const usage = typeof result === 'object' ? result.usage : undefined;
  return { text, model: useModel, neurons: estimateNeurons(useModel, inputText, text, usage) };
}

// ═══════════════════════════════════════════════════════════════════
// 翻译（文本代理追加区：m2m100-1.2b）
// 在此分区内添加函数，不要改动上方已有函数。
// ═══════════════════════════════════════════════════════════════════

// m2m100 语言代码归一化：只要主代码（en-US→en、zh-CN→zh）。
// 源语言为空/auto 时 m2m100 不支持自动检测，按内容启发式判断：
// 含 CJK 字符默认中文，否则默认英语。
function normalizeM2mLang(code, fallbackText) {
  const c = String(code || '').trim().toLowerCase();
  if (!c || c === 'auto') {
    return /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/.test(fallbackText || '') ? 'zh' : 'en';
  }
  return c.split('-')[0];
}

// 翻译（m2m100-1.2b）
// translate({accountId, apiKey, text, sourceLang, targetLang}) → {text, model, neurons}
async function translate({ accountId, apiKey, text, sourceLang, targetLang }) {
  const target = normalizeM2mLang(targetLang);
  const source = normalizeM2mLang(sourceLang, text);
  const result = await runTextModel(
    accountId,
    apiKey,
    TRANSLATE_MODEL,
    { text, source_lang: source, target_lang: target },
    '翻译'
  );
  const translated = typeof result === 'string' ? result : result?.translated_text;
  if (typeof translated !== 'string') {
    throw new Error('Cloudflare 翻译返回的响应中没有译文');
  }
  return { text: translated, model: TRANSLATE_MODEL, neurons: estimateNeurons(TRANSLATE_MODEL, text, translated) };
}

// ═══════════════════════════════════════════════════════════════════
// 语音（语音代理：Whisper / MeloTTS）
// ═══════════════════════════════════════════════════════════════════

/**
 * 语音转文字（Whisper large v3 turbo）。
 * 按 Cloudflare 官方文档，Whisper 的 body 为音频字节数组（JSON 数组）。
 * @param {object} opts
 * @param {string} opts.accountId - Cloudflare 账号 ID
 * @param {string} opts.apiKey - Workers AI API Token
 * @param {Buffer} opts.audioBuffer - 音频字节
 * @returns {Promise<string>} 识别出的文本
 * @throws 上游错误时抛 Error，如 "Cloudflare Whisper 返回 HTTP 400：..."
 */
async function transcribe({ accountId, apiKey, audioBuffer }) {
  if (!accountId || !apiKey) {
    throw new Error('Cloudflare 未配置：缺少 accountId 或 API Token');
  }
  let res;
  try {
    res = await fetch(runUrl(accountId, WHISPER_MODEL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([...audioBuffer]),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    throw new Error(`请求 Cloudflare 失败：${err.message}`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok || (data && data.success === false)) {
    const message = extractErrorMessage(data, res.statusText || '未知错误');
    throw new Error(`Cloudflare Whisper 返回 HTTP ${res.status}：${message}`);
  }
  const result = data && data.result;
  if (typeof result === 'string') return result;
  return typeof result?.text === 'string' ? result.text : '';
}

/**
 * 文本转语音（MeloTTS）。
 * @param {object} opts
 * @param {string} opts.accountId - Cloudflare 账号 ID
 * @param {string} opts.apiKey - Workers AI API Token
 * @param {string} opts.text - 要朗读的文本
 * @param {string} [opts.lang='zh'] - 语言（en / es / fr / zh / jp / kr）
 * @returns {Promise<Buffer>} 音频字节（REST 接口返回二进制音频；若返回 JSON
 *   则从 result.audio 的 base64 解码；MeloTTS 输出一般为 WAV 44.1kHz 单声道，
 *   调用方请按音频魔数判断实际格式）
 * @throws 上游错误时抛 Error，如 "Cloudflare MeloTTS 返回 HTTP 500：..."
 */
async function tts({ accountId, apiKey, text, lang = 'zh' }) {
  if (!accountId || !apiKey) {
    throw new Error('Cloudflare 未配置：缺少 accountId 或 API Token');
  }
  if (!text || !String(text).trim()) {
    throw new Error('文本为空');
  }
  let res;
  try {
    res = await fetch(runUrl(accountId, TTS_MODEL), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: String(text), lang }),
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    throw new Error(`请求 Cloudflare 失败：${err.message}`);
  }

  const contentType = res.headers.get('content-type') || '';
  if (contentType.includes('application/json')) {
    const data = await res.json().catch(() => null);
    if (!res.ok || (data && data.success === false)) {
      const message = extractErrorMessage(data, res.statusText || '未知错误');
      throw new Error(`Cloudflare MeloTTS 返回 HTTP ${res.status}：${message}`);
    }
    // 防御：某些情况下上游以 JSON 包 base64 音频返回
    const audio = data && data.result && (data.result.audio || data.result);
    if (typeof audio === 'string' && audio.length > 0) {
      return Buffer.from(audio, 'base64');
    }
    throw new Error('Cloudflare MeloTTS 返回了意料之外的 JSON，未含音频数据');
  }

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Cloudflare MeloTTS 返回 HTTP ${res.status}${errText ? `：${errText.slice(0, 300)}` : ''}`
    );
  }
  return Buffer.from(await res.arrayBuffer());
}

// ═══════════════════════════════════════════════════════════════════
// 向量（文本代理追加区：bge-m3）
// 注意：bge-m3 返回 result = {shape, data:[[..],[..]]}，按 data 数组解析
// 并用 shape 校验，不要按 OpenAI 式 {embedding} 解析。
// 在此分区内添加函数，不要改动上方已有函数。
// ═══════════════════════════════════════════════════════════════════

// 向量（bge-m3）
// embed({accountId, apiKey, texts}) → {embeddings: [[...], ...], dimension, model, neurons}
async function embed({ accountId, apiKey, texts }) {
  const input = Array.isArray(texts) ? texts : [texts];
  const result = await runTextModel(accountId, apiKey, EMBED_MODEL, { text: input }, '向量');
  const { shape, data } = result || {};
  if (!Array.isArray(data) || data.length !== input.length) {
    throw new Error('Cloudflare 向量返回的向量数量与输入不符');
  }
  if (Array.isArray(shape) && (shape[0] !== data.length || shape[1] !== data[0]?.length)) {
    throw new Error('Cloudflare 向量返回的 shape 与 data 不一致');
  }
  for (const v of data) {
    if (!Array.isArray(v)) throw new Error('Cloudflare 向量返回的格式不正确');
  }
  return {
    embeddings: data,
    dimension: data[0].length,
    model: EMBED_MODEL,
    neurons: estimateNeurons(EMBED_MODEL, input.join('\n'), ''),
  };
}

module.exports = {
  RATES,
  FLUX_MODEL,
  CHAT_MODEL,
  TRANSLATE_MODEL,
  WHISPER_MODEL,
  TTS_MODEL,
  EMBED_MODEL,
  // 出图
  generateImage,
  estimateImageNeurons,
  // 语音
  transcribe,
  tts,
  // 对话 / 翻译 / 向量（文本代理）
  chat,
  translate,
  embed,
  // 追加函数时在此处添加导出（按分区注释分组），不要删除已有导出。
};
