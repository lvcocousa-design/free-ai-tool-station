// lib/config.js — 供应商凭据：环境变量 + settings.json（经存储层）
//
// 凭据来源优先级：settings（设置页写入）> 环境变量。
// 同一供应商的两个来源按字段合并：settings 里非空的字段覆盖环境变量，
// settings 里缺失的字段仍可用环境变量补齐。
// settings.json 不存在或损坏时，读操作按空结构处理，不写回——
// 这样损坏的文件不会被空结构覆盖（原实现用 existsSync 区分“不存在”与
// “损坏”；存储层契约无法区分两者，所以这里干脆不自动写；文件会在首次
// setProvider 保存凭据时创建）。
//
// 全部 API 都是异步的（存储层是异步的），调用方必须 await：
//   getProvider(name) / isConfigured(name) / setProvider(name, creds) /
//   listProviders()。
// 读取 settings 时存储出错（如 S3 不可用）不抛错：记一条 warn 日志，
// 只用环境变量凭据继续工作。setProvider 写存储失败时抛错，由调用方处理。
//
// 供应商列表、凭据字段、环境变量映射全部从供应商注册表派生
// （lib/providers/*/meta.credentials），不再硬编码：
//   zhipu ← ZHIPU_API_KEY
//   groq ← GROQ_API_KEY
//   cloudflare ← CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID
//   deepl ← DEEPL_API_KEY
//   elevenlabs ← ELEVENLABS_API_KEY
//   siliconflow ← SILICONFLOW_API_KEY
//   kaggle ← KAGGLE_USERNAME + KAGGLE_KEY
//   instabox ← INSTABOX_PROXY_URL

const store = require('./storage');
const registry = require('./provider-registry');

// 供应商名（按注册表 order 排序）。
const PROVIDERS = registry.names();

/** 该供应商的凭据字段 key 列表（只认这些字段，多余字段不保存）；未知供应商返回 null。 */
function fieldsFor(name) {
  const mod = registry.get(name);
  if (!mod || !Array.isArray(mod.meta.credentials)) return null;
  return mod.meta.credentials.map((field) => field.key);
}

/** 该供应商的必填字段 key 列表（required !== false 即必填）；未知供应商返回 null。 */
function requiredFieldsFor(name) {
  const mod = registry.get(name);
  if (!mod || !Array.isArray(mod.meta.credentials)) return null;
  return mod.meta.credentials
    .filter((field) => field.required !== false)
    .map((field) => field.key);
}

/** 从环境变量读该供应商的凭据（按 meta.credentials 的 env 映射）；未知供应商返回 null。 */
function envCreds(name) {
  const mod = registry.get(name);
  if (!mod || !Array.isArray(mod.meta.credentials)) return null;
  const creds = {};
  for (const field of mod.meta.credentials) {
    creds[field.key] = field.env ? (process.env[field.env] || '') : '';
  }
  return creds;
}

async function readSettings() {
  let data = null;
  try {
    data = await store.readJSON('settings', null);
  } catch (err) {
    // 存储不可用时不抛错：环境变量凭据仍可继续用，只记一条日志。
    console.warn('[config] 读取设置失败（仅使用环境变量凭据）:', err.message);
    return { providers: {} };
  }
  if (data && typeof data === 'object' && data.providers && typeof data.providers === 'object') {
    return data;
  }
  // data 为 null（不存在）或结构非法（损坏）：按空结构处理，不写回，
  // 避免把损坏的 settings.json 覆盖掉；文件在首次 setProvider 时创建。
  return { providers: {} };
}

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
async function getProvider(name) {
  const fields = fieldsFor(name);
  if (!fields) return null;
  const fromEnv = envCreds(name) || {};
  const settings = await readSettings();
  const stored = (settings.providers && settings.providers[name]) || {};

  const creds = {};
  let anyValue = false;
  for (const field of fields) {
    const value = cleanStr(stored[field]) || cleanStr(fromEnv[field]);
    creds[field] = value;
    if (value) anyValue = true;
  }
  return anyValue ? creds : null;
}

/** 是否已配置：全部必填字段都有非空值。 */
async function isConfigured(name) {
  const required = requiredFieldsFor(name);
  if (!required) return false;
  const creds = await getProvider(name);
  if (!creds) return false;
  return required.every((field) => Boolean(creds[field]));
}

/**
 * 写 settings（与已有同供应商凭据按字段合并），成功返回 true，
 * 未知供应商返回 false；存储写失败时抛错。
 */
async function setProvider(name, creds) {
  const fields = fieldsFor(name);
  if (!fields) return false;
  const settings = await readSettings();
  const current = settings.providers[name] || {};
  const next = { ...current };
  for (const field of fields) {
    if (creds && typeof creds[field] === 'string') {
      next[field] = creds[field].trim();
    }
  }
  settings.providers[name] = next;
  await store.writeJSON('settings', settings);
  return true;
}

/** 返回 [{name, configured}]，绝不返回密钥值。 */
async function listProviders() {
  const results = await Promise.all(
    PROVIDERS.map(async (name) => ({ name, configured: await isConfigured(name) })),
  );
  return results;
}

/**
 * TOTP 二次验证配置（与供应商凭据同存 settings.json 的 totp 字段，
 * 备份导出不含它——导出只写各供应商 configured 布尔值）。
 * 结构：{ secret, backupCodes: [sha256hex…], enabledAt }；未开启返回 null。
 * 与供应商凭据不同：存储读失败时抛错（调用方应 fail closed，拒绝登录），
 * 而不是按“未开启”处理——读不到密钥时绝不能跳过二次验证。
 */
async function getTotp() {
  let data = null;
  try {
    data = await store.readJSON('settings', null);
  } catch (err) {
    throw new Error(`读取 TOTP 配置失败：${err.message}`);
  }
  const totp = data && typeof data === 'object' ? data.totp : null;
  if (!totp || typeof totp !== 'object' || typeof totp.secret !== 'string' || !totp.secret) {
    return null;
  }
  return {
    secret: totp.secret,
    backupCodes: Array.isArray(totp.backupCodes) ? totp.backupCodes : [],
    enabledAt: totp.enabledAt || null,
  };
}

/** 写 TOTP 配置；传 null 表示清除（关闭二次验证）。存储写失败时抛错。 */
async function setTotp(totp) {
  const settings = await readSettings();
  if (totp === null) {
    delete settings.totp;
  } else {
    settings.totp = totp;
  }
  await store.writeJSON('settings', settings);
  return true;
}

module.exports = { PROVIDERS, getProvider, setProvider, isConfigured, listProviders, getTotp, setTotp };
