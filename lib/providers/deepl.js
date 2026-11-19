// DeepL API Free ——翻译与用量查询
// 基地址：https://api-free.deepl.com/v2
// 注意：必须用 Authorization: DeepL-Auth-Key 请求头传密钥，
// ?auth_key= 查询参数会被拒绝。
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

const { probe } = require('../probe');

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

// 用量查询（插件接口，供 lib/usage.js 的 refreshRemoteUsage 调用）。
// getUsage({apiKey}) → {used, limit, unit:'characters'} | null
// 失败（未授权、网络错、响应格式不对）返回 null，不抛错；调用方保留旧值。
async function getUsage({ apiKey }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/usage`, {
      method: 'GET',
      headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  if (!data || typeof data.character_count !== 'number' || typeof data.character_limit !== 'number') {
    return null;
  }
  return {
    used: data.character_count,
    limit: data.character_limit,
    unit: 'characters',
  };
}

// ── 插件接口（供 lib/provider-registry.js 发现）────────────────────────

const meta = {
  name: 'deepl',
  label: 'DeepL',
  quotaNote: 'API Free 计划：100 万字符额度（以账号页为准）',
  applyUrl: 'https://www.deepl.com',
  order: 40,
  capabilities: ['translate'],
  credentials: [
    { key: 'apiKey', label: 'API Key', type: 'password', env: 'DEEPL_API_KEY', required: true },
  ],
};

// 只读连接探测：GET /usage，2xx 即通过；内部 catch 转中文，不抛错。
// 注意：DeepL 不接受 ?auth_key= 查询参数，必须用 DeepL-Auth-Key 请求头。
async function test(creds = {}) {
  try {
    return await probe(`${BASE_URL}/usage`, {
      headers: { Authorization: `DeepL-Auth-Key ${creds.apiKey}` },
    });
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

module.exports = { meta, test, translate, getUsage };
