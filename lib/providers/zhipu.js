// 智谱 z.ai（国际版）——OpenAI 兼容接口
// 基地址：https://api.z.ai/api/paas/v4
// 模型来自 lib/models.json（对话 glm-4.x-flash、识图 glm-4.6v-flash）
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

const { probe, bearer } = require('../probe');
const models = require('../models');

const BASE_URL = 'https://api.z.ai/api/paas/v4';

// 模型列表与默认值来自 lib/models.json（单一来源），改模型只改配置。
const CHAT_MODELS = models.getModels('chat', 'zhipu').map((m) => m.id);
const VISION_MODEL = models.getDefaultModel('vision', 'zhipu');

// 从上游错误响应里提取可读消息
function extractErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (data?.error?.message) return data.error.message;
    if (typeof data?.message === 'string') return data.message;
  } catch { /* 不是 JSON，直接用原文 */ }
  return bodyText.slice(0, 300);
}

async function postChatCompletions(apiKey, body) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求智谱超时（120 秒无响应）');
    throw new Error(`请求智谱失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`智谱返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('智谱返回了无法解析的响应');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('智谱返回的响应中没有文本内容');
  }
  return content;
}

// 对话
// chat({apiKey, model, messages}) → {text, model}
// messages: [{role:'user'|'assistant'|'system', content}]（OpenAI 格式）
async function chat({ apiKey, model, messages }) {
  const useModel = model || models.getDefaultModel('chat', 'zhipu');
  if (!CHAT_MODELS.includes(useModel)) {
    throw new Error(`智谱不支持模型 ${useModel}，可用：${CHAT_MODELS.join('、')}`);
  }
  const text = await postChatCompletions(apiKey, {
    model: useModel,
    messages,
  });
  return { text, model: useModel };
}

// 识图问答
// visionQA({apiKey, imageBase64, mimeType, question}) → {text, model}
// 图片以 data URL 形式放在 image_url 里，不经过任何存储。
async function visionQA({ apiKey, imageBase64, mimeType, question }) {
  const q = (question || '').trim() || '请详细描述这张图片。';
  const mime = mimeType || 'image/jpeg';
  const text = await postChatCompletions(apiKey, {
    model: VISION_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: q },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${imageBase64}` },
          },
        ],
      },
    ],
  });
  return { text, model: VISION_MODEL };
}

// ── 插件接口（供 lib/provider-registry.js 发现）────────────────────────

const meta = {
  name: 'zhipu',
  label: '智谱 z.ai',
  quotaNote: 'GLM-4.x-Flash 永久免费，对话与识图可用',
  applyUrl: 'https://z.ai',
  order: 10,
  capabilities: ['chat', 'vision'],
  credentials: [
    { key: 'apiKey', label: 'API Key', type: 'password', env: 'ZHIPU_API_KEY', required: true },
  ],
};

// 只读连接探测：GET /models，2xx 即通过；内部 catch 转中文，不抛错。
async function test(creds = {}) {
  try {
    return await probe(`${BASE_URL}/models`, { headers: bearer(creds.apiKey) });
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

module.exports = { meta, test, chat, visionQA, CHAT_MODELS, VISION_MODEL };
