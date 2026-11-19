// lib/config.js — 供应商凭据：环境变量 + data/settings.json
//
// 凭据来源优先级：data/settings.json（设置页写入）> 环境变量。
// 同一供应商的两个来源按字段合并：settings 里非空的字段覆盖环境变量，
// settings 里缺失的字段仍可用环境变量补齐。
// 首次启动时如 data/settings.json 不存在则创建空结构 {providers:{}}。
//
// 环境变量映射（见契约文末）：
//   zhipu ← ZHIPU_API_KEY
//   groq ← GROQ_API_KEY
//   cloudflare ← CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
//   deepl ← DEEPL_API_KEY
//   elevenlabs ← ELEVENLABS_API_KEY
//   siliconflow ← SILICONFLOW_API_KEY
//   kaggle ← KAGGLE_USERNAME + KAGGLE_KEY
//   instabox ← INSTABOX_PROXY_URL

const fs = require('fs');
const path = require('path');
const store = require('./storage');

const PROVIDERS = ['zhipu', 'groq', 'cloudflare', 'deepl', 'elevenlabs', 'siliconflow', 'kaggle', 'instabox'];

// 各供应商的凭据字段（只认这些字段，多余字段不保存）。
const FIELDS = {
  zhipu: ['apiKey'],
  groq: ['apiKey'],
  cloudflare: ['apiKey', 'accountId'],
  deepl: ['apiKey'],
  elevenlabs: ['apiKey'],
  siliconflow: ['apiKey'],
  kaggle: ['username', 'apiKey'],
  instabox: ['proxyUrl'],
};

function envCreds(name) {
  switch (name) {
    case 'zhipu': return { apiKey: process.env.ZHIPU_API_KEY || '' };
    case 'groq': return { apiKey: process.env.GROQ_API_KEY || '' };
    case 'cloudflare': return {
      apiKey: process.env.CLOUDFLARE_API_TOKEN || '',
      accountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
    };
    case 'deepl': return { apiKey: process.env.DEEPL_API_KEY || '' };
    case 'elevenlabs': return { apiKey: process.env.ELEVENLABS_API_KEY || '' };
    case 'siliconflow': return { apiKey: process.env.SILICONFLOW_API_KEY || '' };
    case 'kaggle': return {
      username: process.env.KAGGLE_USERNAME || '',
      apiKey: process.env.KAGGLE_KEY || '',
    };
    case 'instabox': return { proxyUrl: process.env.INSTABOX_PROXY_URL || '' };
    default: return null;
  }
}

function readSettings() {
  const data = store.readJSON('settings', null);
  if (data && typeof data === 'object' && data.providers && typeof data.providers === 'object') {
    return data;
  }
  return { providers: {} };
}

// 首次启动且文件不存在时创建空结构；已存在但解析失败时不覆盖（避免抹掉凭据）。
(function ensureSettingsFile() {
  try {
    const settingsPath = path.join(store.dataDir, 'settings.json');
    if (!fs.existsSync(settingsPath)) {
      store.writeJSON('settings', { providers: {} });
    }
  } catch (err) {
    console.warn('[config] 创建 data/settings.json 失败:', err.message);
  }
})();

function cleanStr(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * 返回该供应商的凭据对象，完全没配置时返回 null。
 * zhipu/groq/deepl/elevenlabs/siliconflow → {apiKey}
 * cloudflare → {apiKey, accountId}
 * kaggle → {username, apiKey}
 * instabox → {proxyUrl}
 */
function getProvider(name) {
  if (!FIELDS[name]) return null;
  const fromEnv = envCreds(name) || {};
  const settings = readSettings();
  const stored = (settings.providers && settings.providers[name]) || {};

  const creds = {};
  let anyValue = false;
  for (const field of FIELDS[name]) {
    const value = cleanStr(stored[field]) || cleanStr(fromEnv[field]);
    creds[field] = value;
    if (value) anyValue = true;
  }
  return anyValue ? creds : null;
}

/** 是否已配置：全部必填字段都有非空值。 */
function isConfigured(name) {
  if (!FIELDS[name]) return false;
  const creds = getProvider(name);
  if (!creds) return false;
  return FIELDS[name].every((field) => Boolean(creds[field]));
}

/** 写 data/settings.json（与已有同供应商凭据按字段合并），成功返回 true。 */
function setProvider(name, creds) {
  if (!FIELDS[name]) return false;
  const settings = readSettings();
  const current = settings.providers[name] || {};
  const next = { ...current };
  for (const field of FIELDS[name]) {
    if (creds && typeof creds[field] === 'string') {
      next[field] = creds[field].trim();
    }
  }
  settings.providers[name] = next;
  store.writeJSON('settings', settings);
  return true;
}

/** 返回 [{name, configured}]，绝不返回密钥值。 */
function listProviders() {
  return PROVIDERS.map((name) => ({ name, configured: isConfigured(name) }));
}

module.exports = { PROVIDERS, getProvider, setProvider, isConfigured, listProviders };
