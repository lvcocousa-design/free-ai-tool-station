// 硅基流动 SiliconFlow ——OpenAI 兼容接口
// 基地址：https://api.siliconflow.cn/v1
// 模型 ID 已按硅基流动官方定价页/模型广场核实（2026-11-19）：
//   OCR：PaddlePaddle/PaddleOCR-VL-1.5（免费模型，走 chat completions）
//   翻译：tencent/Hunyuan-MT-7B（免费模型，走 chat completions）
//   向量：BAAI/bge-m3（免费模型，/v1/embeddings，OpenAI 式返回）
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

// =====================================================================
// 文本：OCR / 翻译 / 向量（文本代理）
// =====================================================================

const BASE_URL = 'https://api.siliconflow.cn/v1';

const OCR_MODEL = 'PaddlePaddle/PaddleOCR-VL-1.5';
const TRANSLATE_MODEL = 'tencent/Hunyuan-MT-7B';
const EMBED_MODEL = 'BAAI/bge-m3';

// 语言代码 → 中文名（用于翻译提示词；未列出的直接用代码本身）
const LANG_NAMES = {
  ZH: '中文', 'ZH-CN': '中文', 'ZH-TW': '繁体中文',
  EN: '英语', 'EN-US': '英语', 'EN-GB': '英语',
  JA: '日语', JP: '日语', KO: '韩语', FR: '法语', DE: '德语',
  ES: '西班牙语', PT: '葡萄牙语', RU: '俄语', IT: '意大利语',
  NL: '荷兰语', AR: '阿拉伯语', TH: '泰语', VI: '越南语',
};

function langName(code) {
  const c = String(code || '').trim().toUpperCase();
  return LANG_NAMES[c] || c || '原文语言';
}

function extractErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (data?.error?.message) return data.error.message;
    if (typeof data?.message === 'string') return data.message;
  } catch { /* 不是 JSON，直接用原文 */ }
  return bodyText.slice(0, 300);
}

async function postJSON(apiKey, path, body) {
  let res;
  try {
    res = await fetch(`${BASE_URL}${path}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求硅基流动超时（120 秒无响应）');
    throw new Error(`请求硅基流动失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`硅基流动返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error('硅基流动返回了无法解析的响应');
  }
}

function chatCompletionText(data) {
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('硅基流动返回的响应中没有文本内容');
  }
  return content;
}

// OCR：识别图片中的文字，只输出识别结果
// ocr({apiKey, imageBase64, mimeType}) → {text, model}
async function ocr({ apiKey, imageBase64, mimeType }) {
  const mime = mimeType || 'image/jpeg';
  const data = await postJSON(apiKey, '/chat/completions', {
    model: OCR_MODEL,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: '请识别图片中的所有文字，只输出识别出的文字，不要添加任何解释、说明或额外内容。保持原文的换行和顺序。',
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mime};base64,${imageBase64}` },
          },
        ],
      },
    ],
  });
  return { text: chatCompletionText(data).trim(), model: OCR_MODEL };
}

// 翻译：只输出译文
// translate({apiKey, text, sourceLang, targetLang}) → {text, model}
// sourceLang 可为空（自动检测）；targetLang 如 EN-US、ZH。
async function translate({ apiKey, text, sourceLang, targetLang }) {
  const target = String(targetLang || '').trim();
  if (!target) throw new Error('翻译目标语言不能为空');
  const source = String(sourceLang || '').trim();
  const sourceDesc = (!source || source.toUpperCase() === 'AUTO')
    ? '原文'
    : langName(source);
  const data = await postJSON(apiKey, '/chat/completions', {
    model: TRANSLATE_MODEL,
    messages: [
      {
        role: 'user',
        content: `请将以下文本从${sourceDesc}翻译成${langName(target)}，只输出译文，不要添加任何解释、说明或额外内容。\n\n${text}`,
      },
    ],
  });
  return { text: chatCompletionText(data).trim(), model: TRANSLATE_MODEL };
}

// 向量：OpenAI 式返回 {data:[{embedding}]}
// embed({apiKey, texts}) → {embeddings: [[...], ...], dimension, model}
async function embed({ apiKey, texts }) {
  const input = Array.isArray(texts) ? texts : [texts];
  const data = await postJSON(apiKey, '/embeddings', {
    model: EMBED_MODEL,
    input,
  });
  const items = data?.data;
  if (!Array.isArray(items) || items.length !== input.length) {
    throw new Error('硅基流动返回的向量数量与输入不符');
  }
  const embeddings = items.map((item) => {
    if (!Array.isArray(item?.embedding)) {
      throw new Error('硅基流动返回的向量格式不正确');
    }
    return item.embedding;
  });
  return { embeddings, dimension: embeddings[0].length, model: EMBED_MODEL };
}

// =====================================================================
// 语音：SenseVoice（语音代理）
// ---------------------------------------------------------------------
// STT 接口按硅基流动官方文档实现（docs.siliconflow.com /
// api-docs.siliconflow.cn 的 Create Audio Transcriptions，2026-11-19 核实）：
// - 端点 POST https://api.siliconflow.cn/v1/audio/transcriptions（OpenAI 兼容，multipart）
// - 字段：file（音频文件）+ model=FunAudioLLM/SenseVoiceSmall
// - 注意：必须用国内域名 api.siliconflow.cn；旧英文文档示例里的
//   api.siliconflow.com 会把完全正确的 Key 打成 401 Token is invalid。
// - 限制：文件上限 50 MB，时长上限 1 小时。
// =====================================================================

const STT_MODEL = 'FunAudioLLM/SenseVoiceSmall';

// 语音转文字（SenseVoiceSmall）。
// transcribe({apiKey, audioBuffer, filename}) → 转写文本（string）
// filename 须带正确扩展名（上游靠它判断音频格式），默认 audio.webm。
async function transcribe({ apiKey, audioBuffer, filename = 'audio.webm' }) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer]), filename);
  form.append('model', STT_MODEL);
  let res;
  try {
    res = await fetch(`${BASE_URL}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: form,
      signal: AbortSignal.timeout(180000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求硅基流动超时（180 秒无响应）');
    throw new Error(`请求硅基流动失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`硅基流动返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('硅基流动返回了无法解析的响应');
  }
  return typeof data.text === 'string' ? data.text : '';
}

module.exports = { ocr, translate, embed, transcribe, OCR_MODEL, TRANSLATE_MODEL, EMBED_MODEL, STT_MODEL };
