// Groq ——OpenAI 兼容接口
// 基地址：https://api.groq.com/openai/v1
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

// =====================================================================
// 对话（文本代理）
// =====================================================================

const BASE_URL = 'https://api.groq.com/openai/v1';

const CHAT_MODELS = [
  'openai/gpt-oss-120b',
  'openai/gpt-oss-20b',
  'qwen/qwen3.8-27b',
];

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
  const useModel = model || 'openai/gpt-oss-120b';
  if (!CHAT_MODELS.includes(useModel)) {
    throw new Error(`Groq 不支持模型 ${useModel}，可用：${CHAT_MODELS.join('、')}`);
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
    if (err.name === 'TimeoutError') throw new Error('请求 Groq 超时（120 秒无响应）');
    throw new Error(`请求 Groq 失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Groq 返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Groq 返回了无法解析的响应');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Groq 返回的响应中没有文本内容');
  }
  return { text: content, model: useModel };
}

// =====================================================================
// 语音：Whisper（语音代理）
// =====================================================================

// 语音转文字（Whisper large v3 turbo）。
// transcribe({apiKey, audioBuffer, filename}) → 转写文本（string）
// filename 须带正确扩展名（Groq 靠它判断音频格式），默认 audio.webm。
async function transcribe({ apiKey, audioBuffer, filename = 'audio.webm' }) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', 'whisper-large-v3-turbo');
  let res;
  try {
    res = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 Groq 超时（180 秒无响应）');
    throw new Error(`请求 Groq 失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Groq 返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Groq 返回了无法解析的响应');
  }
  return typeof data.text === 'string' ? data.text : '';
}

module.exports = { chat, transcribe, CHAT_MODELS };
