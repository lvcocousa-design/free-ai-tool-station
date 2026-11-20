// NVIDIA NIM（build.nvidia.com 免费推理 API）——OpenAI 兼容接口
// 基地址：https://integrate.api.nvidia.com/v1
// 认证：Authorization: Bearer <nvapi- 开头的 Key>
// 免费档：免绑卡，约 40 请求/分钟；条款仅限试用评估，不可用于生产。
// 注意：GET /v1/models 不需要 Key（公开接口），验不出 Key 是否有效，
// 所以 test() 不探它，改用一次最小对话（max_tokens=1）探 Key 真伪。
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

const { probe, bearer } = require('../probe');
const models = require('../models');

// =====================================================================
// 对话（文本代理）
// =====================================================================

const BASE_URL = 'https://integrate.api.nvidia.com/v1';

// 模型列表与默认值来自 lib/models.json（单一来源），改模型只改配置。
const CHAT_MODELS = models.getModels('chat', 'nvidia').map((m) => m.id);

function extractErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (data?.error?.message) return data.error.message;
    if (typeof data?.message === 'string') return data.message;
  } catch { /* 不是 JSON，直接用原文 */ }
  return bodyText.slice(0, 300);
}

// 对话
// chat({apiKey, model, messages}) → {text, model}
// messages: [{role:'user'|'assistant'|'system', content}]（OpenAI 格式）
async function chat({ apiKey, model, messages }) {
  const useModel = model || models.getDefaultModel('chat', 'nvidia');
  if (!CHAT_MODELS.includes(useModel)) {
    throw new Error(`NVIDIA NIM 不支持模型 ${useModel}，可用：${CHAT_MODELS.join('、')}`);
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: useModel, messages }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 NVIDIA NIM 超时（120 秒无响应）');
    throw new Error(`请求 NVIDIA NIM 失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`NVIDIA NIM 返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('NVIDIA NIM 返回了无法解析的响应');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('NVIDIA NIM 返回的响应中没有文本内容');
  }
  return { text: content, model: useModel };
}

// ── 插件接口（供 lib/provider-registry.js 发现）────────────────────────

const meta = {
  name: 'nvidia',
  label: 'NVIDIA NIM',
  quotaNote: '免费试用：免绑卡，约 40 请求/分钟，仅限试用评估、不可用于生产；连接测试为真实对话探测，首次可能需要几十秒',
  applyUrl: 'https://build.nvidia.com',
  order: 95,
  capabilities: ['chat'],
  credentials: [
    { key: 'apiKey', label: 'API Key', type: 'password', env: 'NVIDIA_API_KEY', required: true },
  ],
};

// 只读连接探测：一次最小对话（max_tokens=1），2xx 即通过；内部 catch 转中文，不抛错。
// 不用 GET /v1/models 做探测：该接口公开、无需 Key，假 Key 也能返回 200，验不出 Key 真伪。
// 探测用 90 秒超时（probe 默认 15 秒不够：NVIDIA 免费端点首次推理常需几十秒，
// 15 秒会误报超时；真实对话 chat() 用 120 秒）。
async function test(creds = {}) {
  try {
    return await probe(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        ...bearer(creds.apiKey),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: models.getDefaultModel('chat', 'nvidia'),
        messages: [{ role: 'user', content: 'hi' }],
        max_tokens: 1,
      }),
    }, 90000);
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

module.exports = { meta, test, chat, CHAT_MODELS };
