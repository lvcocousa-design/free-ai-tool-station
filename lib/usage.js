// lib/usage.js — 用量累计与查询（存 usage.json，经存储层）
//
// Cloudflare Neurons 按自然日累计（日期变了自动清零重计，UTC 日期）。
// Kaggle GPU 秒数按自然周累计（每周一 00:00 UTC 清零重计，
// 30 小时 = 108000 秒上限）。
// Groq tokens/请求数按模型、按自然日累计（UTC 日期）。
// 全站请求数按自然月累计（YYYY-MM 变了自动清零重计）。
// ElevenLabs / DeepL 用量由 refreshRemoteUsage() 调官方接口读取，
// 任一失败不抛错，保留旧值。
//
// 全部 API 都是异步的（存储层是异步的），调用方必须 await；
// load() / addCloudflareNeurons() / addKaggleSeconds() / addGroqUsage() /
// addRequests() / refreshRemoteUsage() 本身不抛错：存储读失败时回落默认值
// 并记 warn 日志，写失败时记 warn 日志，不阻塞主流程。

const store = require('./storage');
const config = require('./config');
const registry = require('./provider-registry');

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

/** 本月键 'YYYY-MM'（UTC）。 */
function currentMonthUTC() {
  return new Date().toISOString().slice(0, 7);
}

function defaultUsage() {
  return {
    cloudflare: { date: todayUTC(), usedNeurons: 0, byModel: {} },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 0, jobs: 0 },
    groq: { date: todayUTC(), byModel: {} },
    requests: { month: currentMonthUTC(), count: 0 },
    elevenlabs: null,
    deepl: null,
  };
}

/**
 * 读用量并做清零检查：日期/周次变了就清零重计（写回文件）。
 * 存储损坏或读取失败时按字段回落到默认值，不抛错。
 */
async function load() {
  let stored = null;
  try {
    stored = await store.readJSON('usage', null);
  } catch (err) {
    // S3 不可用等存储错误：回落默认值并记日志，不抛错。
    console.warn('[usage] 读取用量失败，使用默认值:', err.message);
    stored = null;
  }
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
    if (stored.groq && typeof stored.groq === 'object') {
      const byModel = {};
      const rawByModel = stored.groq.byModel;
      if (rawByModel && typeof rawByModel === 'object') {
        for (const [model, entry] of Object.entries(rawByModel)) {
          if (entry && typeof entry === 'object') {
            byModel[model] = {
              tokens: Number(entry.tokens) || 0,
              requests: Number(entry.requests) || 0,
            };
          }
        }
      }
      usage.groq = {
        date: typeof stored.groq.date === 'string' ? stored.groq.date : usage.groq.date,
        byModel,
      };
    }
    if (stored.requests && typeof stored.requests === 'object') {
      usage.requests = {
        month: typeof stored.requests.month === 'string' ? stored.requests.month : usage.requests.month,
        count: Number(stored.requests.count) || 0,
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
  // 日期变了：Groq 当日用量清零
  if (usage.groq.date !== todayUTC()) {
    usage.groq = { date: todayUTC(), byModel: {} };
    changed = true;
  }
  // 月份变了：全站请求数清零
  if (usage.requests.month !== currentMonthUTC()) {
    usage.requests = { month: currentMonthUTC(), count: 0 };
    changed = true;
  }

  if (changed || stored === null) {
    try {
      await store.writeJSON('usage', usage);
    } catch (err) {
      console.warn('[usage] 写入用量失败:', err.message);
    }
  }
  return usage;
}

/** 按模型名累计当日 Cloudflare Neurons；失败只记日志，不抛错。 */
async function addCloudflareNeurons(model, neurons) {
  try {
    const amount = Number(neurons) || 0;
    if (amount <= 0) return;
    const usage = await load();
    usage.cloudflare.usedNeurons += amount;
    const key = String(model || 'unknown');
    usage.cloudflare.byModel[key] = (Number(usage.cloudflare.byModel[key]) || 0) + amount;
    await store.writeJSON('usage', usage);
  } catch (err) {
    console.warn('[usage] 累计 Cloudflare 用量失败:', err.message);
  }
}

/** 累计本周 Kaggle GPU 秒数（每次调用对应一个已完成任务，jobs 计 1）；失败只记日志，不抛错。 */
async function addKaggleSeconds(seconds) {
  try {
    const amount = Number(seconds) || 0;
    if (amount <= 0) return;
    const usage = await load();
    usage.kaggle.usedSeconds += amount;
    usage.kaggle.jobs += 1;
    await store.writeJSON('usage', usage);
  } catch (err) {
    console.warn('[usage] 累计 Kaggle 用量失败:', err.message);
  }
}

/**
 * 按模型累计当日 Groq 用量（tokens 与请求数分开计；语音转文字不产生
 * tokens，只计请求数，所以 tokens 为 0 时也不提前返回）。失败只记日志，不抛错。
 */
async function addGroqUsage(model, tokens, requests = 1) {
  try {
    const key = String(model || 'unknown');
    const tokenAmount = Number(tokens) || 0;
    const requestAmount = Number(requests) || 0;
    if (tokenAmount <= 0 && requestAmount <= 0) return;
    const usage = await load();
    const entry = usage.groq.byModel[key] || { tokens: 0, requests: 0 };
    entry.tokens += tokenAmount;
    entry.requests += requestAmount;
    usage.groq.byModel[key] = entry;
    await store.writeJSON('usage', usage);
  } catch (err) {
    console.warn('[usage] 累计 Groq 用量失败:', err.message);
  }
}

/** 累计本月全站请求数；失败只记日志，不抛错。 */
async function addRequests(count) {
  try {
    const amount = Number(count) || 0;
    if (amount <= 0) return;
    const usage = await load();
    usage.requests.count += amount;
    await store.writeJSON('usage', usage);
  } catch (err) {
    console.warn('[usage] 累计请求数失败:', err.message);
  }
}

async function getUsage() {
  const usage = await load();
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
    groq: {
      date: usage.groq.date,
      byModel: usage.groq.byModel,
    },
    requests: {
      month: usage.requests.month,
      count: usage.requests.count,
    },
    elevenlabs: usage.elevenlabs,
    deepl: usage.deepl,
  };
}

/**
 * 从官方接口刷新远端用量并写回（遍历注册表里实现了 getUsage 的供应商，
 * 目前是 elevenlabs / deepl；getUsage 返回 {used, limit, unit:'characters'} 或 null）。
 * 任一失败不抛错，保留旧值（或 null），不阻塞调用方。
 * 存回 usage.json 的键名不变（elevenlabs/deepl），值仍为
 * {characterCount, characterLimit, updatedAt}，getUsage() 返回给前端的形状不变。
 */
async function refreshRemoteUsage() {
  const usage = await load();
  let changed = false;

  for (const mod of registry.list()) {
    if (typeof mod.getUsage !== 'function') continue;
    const name = mod.meta.name;
    try {
      if (!await config.isConfigured(name)) continue;
      const creds = await config.getProvider(name);
      if (!creds) continue;
      const result = await mod.getUsage(creds);
      if (!result || typeof result.used !== 'number' || typeof result.limit !== 'number') {
        continue; // getUsage 返回 null（失败）时保留旧值
      }
      usage[name] = {
        characterCount: result.used,
        characterLimit: result.limit,
        updatedAt: new Date().toISOString(),
      };
      changed = true;
    } catch (err) {
      console.warn(`[usage] ${name} 用量刷新失败（保留旧值）:`, err.message);
    }
  }

  if (changed) {
    try {
      await store.writeJSON('usage', usage);
    } catch (err) {
      console.warn('[usage] 写入用量失败:', err.message);
    }
  }
}

module.exports = {
  load,
  addCloudflareNeurons,
  addKaggleSeconds,
  addGroqUsage,
  addRequests,
  getUsage,
  refreshRemoteUsage,
  CLOUDFLARE_DAILY_LIMIT,
  KAGGLE_WEEKLY_LIMIT_SECONDS,
};
