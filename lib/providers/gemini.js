// Google Gemini（Google AI Studio）——Gemini 原生 REST 接口（非 OpenAI 兼容）
// 基地址：https://generativelanguage.googleapis.com/v1beta
// 认证：x-goog-api-key 请求头（官方 API 参考要求；原生端点不支持 Bearer，
// 用 Authorization: Bearer 会返回 401，所以这里不用 lib/probe.js 的 bearer 辅助）。
// 模型来自 lib/models.json（对话 gemini-3.8-flash / gemini-3.5-flash-lite、
// 识图 gemini-3.8-flash）。免费档以 Google 官方定价页为准：
// https://ai.google.dev/gemini-api/docs/pricing
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

const { probe } = require('../probe');
const models = require('../models');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

// 模型列表与默认值来自 lib/models.json（单一来源），改模型只改配置。
const CHAT_MODELS = models.getModels('chat', 'gemini').map((m) => m.id);
const VISION_MODEL = models.getDefaultModel('vision', 'gemini');

// 从上游错误响应里提取可读消息（Gemini 错误形如 {error:{code, message, status}}）
function extractErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (data?.error?.message) return data.error.message;
    if (typeof data?.message === 'string') return data.message;
  } catch { /* 不是 JSON，直接用原文 */ }
  return bodyText.slice(0, 300);
}

// 从 generateContent 响应里取文本：candidates[0].content.parts[*].text 拼接。
// 没有文本 part 时返回 null。
function extractText(data) {
  const parts = data?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) return null;
  const text = parts
    .filter((p) => typeof p?.text === 'string')
    .map((p) => p.text)
    .join('');
  return text || null;
}

// OpenAI 格式 messages → Gemini contents 格式。
// user → user，assistant → model，system → systemInstruction；
// 连续同 role 的消息合并成一个 content（Gemini 要求 user/model 交替），
// 开头的 model 回合丢掉（Gemini 要求 contents 以 user 开头）。
function toGeminiContents(messages) {
  const contents = [];
  const systemParts = [];
  for (const m of messages || []) {
    if (!m || typeof m.content !== 'string' || !m.content) continue;
    if (m.role === 'system') {
      systemParts.push(m.content);
      continue;
    }
    const role = m.role === 'assistant' ? 'model' : 'user';
    const last = contents[contents.length - 1];
    if (last && last.role === role) {
      last.parts.push({ text: m.content });
    } else {
      contents.push({ role, parts: [{ text: m.content }] });
    }
  }
  while (contents.length && contents[0].role !== 'user') contents.shift();
  return { contents, systemParts };
}

async function postGenerateContent(apiKey, model, body) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/models/${model}:generateContent`, {
      method: 'POST',
      headers: {
        'x-goog-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 Gemini 超时（120 秒无响应）');
    throw new Error(`请求 Gemini 失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Gemini 返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Gemini 返回了无法解析的响应');
  }
  const content = extractText(data);
  if (content === null) {
    throw new Error('Gemini 返回的响应中没有文本内容');
  }
  return content;
}

// 对话
// chat({apiKey, model, messages}) → {text, model}
// messages: [{role:'user'|'assistant'|'system', content}]（OpenAI 格式，内部转 contents）
async function chat({ apiKey, model, messages }) {
  const useModel = model || models.getDefaultModel('chat', 'gemini');
  if (!CHAT_MODELS.includes(useModel)) {
    throw new Error(`Gemini 不支持模型 ${useModel}，可用：${CHAT_MODELS.join('、')}`);
  }
  const { contents, systemParts } = toGeminiContents(messages);
  if (!contents.length) {
    throw new Error('Gemini 对话消息不能为空');
  }
  const body = { contents };
  if (systemParts.length) {
    body.systemInstruction = { parts: systemParts.map((text) => ({ text })) };
  }
  const text = await postGenerateContent(apiKey, useModel, body);
  return { text, model: useModel };
}

// 识图问答
// visionQA({apiKey, imageBase64, mimeType, question}) → {text, model}
// 图片以 inlineData part 随提问一起发给 generateContent，不经过任何存储。
async function visionQA({ apiKey, imageBase64, mimeType, question }) {
  const q = (question || '').trim() || '请详细描述这张图片。';
  const mime = mimeType || 'image/jpeg';
  const text = await postGenerateContent(apiKey, VISION_MODEL, {
    contents: [{
      role: 'user',
      parts: [
        { text: q },
        { inlineData: { mimeType: mime, data: imageBase64 } },
      ],
    }],
  });
  return { text, model: VISION_MODEL };
}

// ── 插件接口（供 lib/provider-registry.js 发现）────────────────────────

const meta = {
  name: 'gemini',
  label: 'Google Gemini',
  quotaNote: '免费档：Flash / Flash-Lite 模型输入输出 tokens 免费，有速率限制（免费档内容会被用于改进 Google 产品）',
  applyUrl: 'https://aistudio.google.com/apikey',
  order: 90,
  capabilities: ['chat', 'vision'],
  credentials: [
    { key: 'apiKey', label: 'API Key', type: 'password', env: 'GEMINI_API_KEY', required: true },
  ],
};

// 只读连接探测：GET /v1beta/models，2xx 即通过；内部 catch 转中文，不抛错。
async function test(creds = {}) {
  try {
    return await probe(`${BASE_URL}/models`, {
      headers: { 'x-goog-api-key': creds.apiKey || '' },
    });
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

module.exports = { meta, test, chat, visionQA, CHAT_MODELS, VISION_MODEL };
