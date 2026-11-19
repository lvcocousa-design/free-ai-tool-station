// DeepL API Free ——翻译与用量查询
// 基地址：https://api-free.deepl.com/v2
// 注意：必须用 Authorization: DeepL-Auth-Key 请求头传密钥，
// ?auth_key= 查询参数会被拒绝。
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

const BASE_URL = 'https://api-free.deepl.com/v2';

function extractErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (typeof data?.message === 'string') return data.message;
  } catch { /* 不是 JSON，直接用原文 */ }
  return bodyText.slice(0, 300);
}

// DeepL target_lang 不接受裸 'EN'，必须写 EN-US / EN-GB；这里做归一化。
function normalizeTargetLang(targetLang) {
  const lang = String(targetLang || '').trim().toUpperCase();
  if (lang === 'EN') return 'EN-US';
  return lang;
}

function normalizeSourceLang(sourceLang) {
  const lang = String(sourceLang || '').trim().toUpperCase();
  // 空或 AUTO 表示自动检测，DeepL 接口里直接不传 source_lang
  if (!lang || lang === 'AUTO') return null;
  return lang;
}

// 翻译
// translate({apiKey, text, sourceLang, targetLang}) → {text}
// sourceLang 可为空（自动检测）；targetLang 如 EN-US、ZH、JA。
async function translate({ apiKey, text, sourceLang, targetLang }) {
  const target = normalizeTargetLang(targetLang);
  if (!target) throw new Error('翻译目标语言不能为空');
  const source = normalizeSourceLang(sourceLang);

  const params = new URLSearchParams();
  params.append('text', text);
  params.append('target_lang', target);
  if (source) params.append('source_lang', source);

  let res;
  try {
    res = await fetch(`${BASE_URL}/translate`, {
      method: 'POST',
      headers: {
        Authorization: `DeepL-Auth-Key ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
      signal: AbortSignal.timeout(60000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 DeepL 超时（60 秒无响应）');
    throw new Error(`请求 DeepL 失败：${err.message}`);
  }
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`DeepL 返回 HTTP ${res.status}：${extractErrorMessage(bodyText)}`);
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error('DeepL 返回了无法解析的响应');
  }
  const translated = data?.translations?.[0]?.text;
  if (typeof translated !== 'string') {
    throw new Error('DeepL 返回的响应中没有译文');
  }
  return { text: translated };
}

// 用量查询
// getUsage({apiKey}) → {character_count, character_limit}（与 DeepL 原始字段同名）
async function getUsage({ apiKey }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/usage`, {
      method: 'GET',
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 DeepL 用量接口超时（30 秒无响应）');
    throw new Error(`请求 DeepL 用量接口失败：${err.message}`);
  }
  const bodyText = await res.text();
  if (!res.ok) {
    throw new Error(`DeepL 用量接口返回 HTTP ${res.status}：${extractErrorMessage(bodyText)}`);
  }
  let data;
  try {
    data = JSON.parse(bodyText);
  } catch {
    throw new Error('DeepL 用量接口返回了无法解析的响应');
  }
  return {
    character_count: data.character_count,
    character_limit: data.character_limit,
  };
}

module.exports = { translate, getUsage };
