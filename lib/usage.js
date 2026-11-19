// lib/usage.js — 用量累计与查询（存 data/usage.json）
//
// Cloudflare Neurons 按自然日累计（日期变了自动清零重计，UTC 日期）。
// Kaggle GPU 秒数按自然周累计（每周一 00:00 UTC 清零重计，
// 30 小时 = 108000 秒上限）。
// ElevenLabs / DeepL 用量由 refreshRemoteUsage() 调官方接口读取，
// 任一失败不抛错，保留旧值。

const store = require('./storage');
const config = require('./config');

const CLOUDFLARE_DAILY_LIMIT = 10000; // Neurons / 天
const KAGGLE_WEEKLY_LIMIT_SECONDS = 108000; // 30 小时 / 周

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/** 本周一的 UTC 日期（YYYY-MM-DD）。 */
function mondayUTC() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=周日 … 6=周六
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diffToMonday,
  ));
  return monday.toISOString().slice(0, 10);
}

function defaultUsage() {
  return {
    cloudflare: { date: todayUTC(), usedNeurons: 0, byModel: {} },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 0, jobs: 0 },
    elevenlabs: null,
    deepl: null,
  };
}

/**
 * 读用量并做清零检查：日期/周次变了就清零重计（写回文件）。
 * 存储损坏时按字段回落到默认值，不抛错。
 */
function load() {
  const stored = store.readJSON('usage', null);
  const usage = defaultUsage();
  let changed = false;

  if (stored && typeof stored === 'object') {
    if (stored.cloudflare && typeof stored.cloudflare === 'object') {
      usage.cloudflare = {
        date: typeof stored.cloudflare.date === 'string' ? stored.cloudflare.date : usage.cloudflare.date,
        usedNeurons: Number(stored.cloudflare.usedNeurons) || 0,
        byModel: (stored.cloudflare.byModel && typeof stored.cloudflare.byModel === 'object')
          ? stored.cloudflare.byModel : {},
      };
    }
    if (stored.kaggle && typeof stored.kaggle === 'object') {
      usage.kaggle = {
        weekStart: typeof stored.kaggle.weekStart === 'string' ? stored.kaggle.weekStart : usage.kaggle.weekStart,
        usedSeconds: Number(stored.kaggle.usedSeconds) || 0,
        jobs: Number(stored.kaggle.jobs) || 0,
      };
    }
    if (stored.elevenlabs && typeof stored.elevenlabs === 'object') usage.elevenlabs = stored.elevenlabs;
    if (stored.deepl && typeof stored.deepl === 'object') usage.deepl = stored.deepl;
  } else if (stored !== null) {
    changed = true; // 存的是非法结构，重建
  }

  // 日期变了：Cloudflare 当日用量清零
  if (usage.cloudflare.date !== todayUTC()) {
    usage.cloudflare = { date: todayUTC(), usedNeurons: 0, byModel: {} };
    changed = true;
  }
  // 周次变了：Kaggle 本周用量清零
  if (usage.kaggle.weekStart !== mondayUTC()) {
    usage.kaggle = { weekStart: mondayUTC(), usedSeconds: 0, jobs: 0 };
    changed = true;
  }

  if (changed || stored === null) {
    store.writeJSON('usage', usage);
  }
  return usage;
}

/** 按模型名累计当日 Cloudflare Neurons。 */
function addCloudflareNeurons(model, neurons) {
  const amount = Number(neurons) || 0;
  if (amount <= 0) return;
  const usage = load();
  usage.cloudflare.usedNeurons += amount;
  const key = String(model || 'unknown');
  usage.cloudflare.byModel[key] = (Number(usage.cloudflare.byModel[key]) || 0) + amount;
  store.writeJSON('usage', usage);
}

/** 累计本周 Kaggle GPU 秒数（每次调用对应一个已完成任务，jobs 计 1）。 */
function addKaggleSeconds(seconds) {
  const amount = Number(seconds) || 0;
  if (amount <= 0) return;
  const usage = load();
  usage.kaggle.usedSeconds += amount;
  usage.kaggle.jobs += 1;
  store.writeJSON('usage', usage);
}

function getUsage() {
  const usage = load();
  return {
    cloudflare: {
      usedNeurons: usage.cloudflare.usedNeurons,
      limit: CLOUDFLARE_DAILY_LIMIT,
      date: usage.cloudflare.date,
    },
    kaggle: {
      usedSeconds: usage.kaggle.usedSeconds,
      limitSeconds: KAGGLE_WEEKLY_LIMIT_SECONDS,
      jobs: usage.kaggle.jobs,
    },
    elevenlabs: usage.elevenlabs,
    deepl: usage.deepl,
  };
}

/** 带超时的 fetch，超时抛错（由调用方 catch）。 */
async function fetchWithTimeout(url, options, ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 从官方接口刷新 ElevenLabs / DeepL 用量并写回。
 * 任一失败不抛错，保留旧值（或 null），不阻塞调用方。
 */
async function refreshRemoteUsage() {
  const usage = load();
  let changed = false;

  // ElevenLabs：GET /v1/user → subscription.character_count / character_limit
  try {
    if (config.isConfigured('elevenlabs')) {
      const { apiKey } = config.getProvider('elevenlabs');
      const res = await fetchWithTimeout('https://api.elevenlabs.io/v1/user', {
        headers: { 'xi-api-key': apiKey },
      }, 10000);
      if (res.ok) {
        const data = await res.json();
        const sub = data && data.subscription;
        if (sub && typeof sub.character_count === 'number') {
          usage.elevenlabs = {
            characterCount: sub.character_count,
            characterLimit: sub.character_limit,
            updatedAt: new Date().toISOString(),
          };
          changed = true;
        }
      }
    }
  } catch (err) {
    console.warn('[usage] ElevenLabs 用量刷新失败（保留旧值）:', err.message);
  }

  // DeepL：GET /v2/usage → character_count / character_limit
  // 注意：必须用 Authorization: DeepL-Auth-Key 请求头，?auth_key= 会被拒绝。
  try {
    if (config.isConfigured('deepl')) {
      const { apiKey } = config.getProvider('deepl');
      const res = await fetchWithTimeout('https://api-free.deepl.com/v2/usage', {
        headers: { Authorization: `DeepL-Auth-Key ${apiKey}` },
      }, 10000);
      if (res.ok) {
        const data = await res.json();
        if (data && typeof data.character_count === 'number') {
          usage.deepl = {
            characterCount: data.character_count,
            characterLimit: data.character_limit,
            updatedAt: new Date().toISOString(),
          };
          changed = true;
        }
      }
    }
  } catch (err) {
    console.warn('[usage] DeepL 用量刷新失败（保留旧值）:', err.message);
  }

  if (changed) {
    store.writeJSON('usage', usage);
  }
}

module.exports = {
  addCloudflareNeurons,
  addKaggleSeconds,
  getUsage,
  refreshRemoteUsage,
  CLOUDFLARE_DAILY_LIMIT,
  KAGGLE_WEEKLY_LIMIT_SECONDS,
};
