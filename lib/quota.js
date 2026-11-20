// lib/quota.js — 应用层用量上限：免费额度到顶时拦截调用，防止超量扣费
//
// 各家免费额度大多是硬上限（没绑卡，超了上游直接拒绝），真正能扣费的是
// Cloud Run 与 R2（都绑了卡）；但为统一体验、避免把免费额度打满后触发
// 上游的长时间封禁（如 Cloudflare 顶满会锁 24 小时），应用层在调上游
// 之前先按本地累计用量拦截，返回 429 + {ok:false, quotaExceeded:true}。
//
// 额度表（不要自行改动数值，改额度请同步更新 README 与 CHANGELOG）：
//   Cloudflare Workers AI：10,000 Neurons/天，按 90%（9,000）拦截；
//     每天 00:00 UTC 恢复（即北京时间 08:00）。
//   Groq：每模型每天 200,000 tokens + 1,000 次请求；每天 00:00 UTC 恢复。
//   ElevenLabs / DeepL：官方用量缓存，used >= limit 即拦；恢复时间取决于
//     各家计费周期，不在此写死日期。
//   Kaggle：每周 108,000 GPU 秒（30 小时）；拦截时按任务预留（出图 600 秒、
//     生视频 3,600 秒），即 used + 预留 > 上限时拦；每周一 00:00 UTC 恢复。
//   存储：8 GiB（R2 免费 10GB，留余量）。
//   全站每月请求：1,500,000 次（Cloud Run 免费 2M 请求的 75%）。
//
// 环境变量覆盖（每次检查时实时读取，改了不用重启也生效——
// 但 Cloud Run 上改环境变量本来就要重新部署）：
//   QUOTA_STORAGE_BYTES（默认 8GiB）、QUOTA_MONTHLY_REQUESTS
//   （默认 1500000，0 关闭请求数拦截）、QUOTA_CLOUDFLARE_FRACTION
//   （默认 0.9）、QUOTA_DISABLED=1（关闭全部拦截，启动时打 warn 日志）。
//
// 检查函数都是纯函数：入参为 usage 对象（lib/usage.js 的 load() 形状）+
// 参数，返回 {allowed, message}；message 为中文，超量时说清额度与恢复时间。
// 没有用量数据时一律 fail open（放行）：用量读不到不该把服务锁死，
// 真正的硬上限还在上游与计费侧。

const usageModule = require('./usage');

const CLOUDFLARE_DAILY_LIMIT = 10000; // Neurons / 天
const DEFAULT_CLOUDFLARE_FRACTION = 0.9; // 拦截线：每日额度的 90%
const GROQ_DAILY_TOKEN_LIMIT = 200000; // 每模型每天 tokens
const GROQ_DAILY_REQUEST_LIMIT = 1000; // 每模型每天请求数
const KAGGLE_WEEKLY_LIMIT_SECONDS = 108000; // 30 小时 / 周
const KAGGLE_RESERVE_IMAGE_SECONDS = 600; // 出图预留
const KAGGLE_RESERVE_VIDEO_SECONDS = 3600; // 生视频预留
const DEFAULT_STORAGE_LIMIT_BYTES = 8 * 1024 * 1024 * 1024; // 8 GiB
const DEFAULT_MONTHLY_REQUEST_LIMIT = 1500000; // Cloud Run 免费 2M 的 75%

// refreshIfStale 默认认为缓存超过 10 分钟就过期。
const DEFAULT_STALE_MS = 10 * 60 * 1000;

/** 本月键 'YYYY-MM'（UTC，与 usage.json 的 requests.month 同一口径）。 */
function currentMonthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function fmtNum(n) {
  return Number(n || 0).toLocaleString('en-US');
}

/** 字节数 → 'x.xx GiB'（小于 1 GiB 时用 MiB）。 */
function fmtBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GiB`;
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
  return `${fmtNum(n)} 字节`;
}

/** 是否关闭全部拦截（QUOTA_DISABLED=1）。 */
function isDisabled() {
  return process.env.QUOTA_DISABLED === '1';
}

/** Cloudflare 拦截比例（0~1 之外的值回落默认 0.9）。 */
function cloudflareFraction() {
  const v = Number(process.env.QUOTA_CLOUDFLARE_FRACTION);
  if (Number.isFinite(v) && v > 0 && v <= 1) return v;
  return DEFAULT_CLOUDFLARE_FRACTION;
}

/** Cloudflare 当日拦截线（Neurons 数）。 */
function cloudflareEffectiveLimit() {
  return Math.floor(CLOUDFLARE_DAILY_LIMIT * cloudflareFraction());
}

/** 存储上限（字节；非法值回落默认 8GiB）。 */
function getStorageLimitBytes() {
  const v = Number(process.env.QUOTA_STORAGE_BYTES);
  if (Number.isFinite(v) && v > 0) return Math.floor(v);
  return DEFAULT_STORAGE_LIMIT_BYTES;
}

/** 全站每月请求上限（0 表示关闭；非法值回落默认）。 */
function getMonthlyRequestLimit() {
  const raw = process.env.QUOTA_MONTHLY_REQUESTS;
  if (raw === undefined || raw === '') return DEFAULT_MONTHLY_REQUEST_LIMIT;
  const v = Number(raw);
  if (!Number.isFinite(v) || v < 0) return DEFAULT_MONTHLY_REQUEST_LIMIT;
  return Math.floor(v);
}

// ── 纯检查函数 ───────────────────────────────────────────────────────

function allowed() {
  return { allowed: true, message: '' };
}

function blocked(message) {
  return { allowed: false, message };
}

/** Cloudflare：当日累计 Neurons 达到拦截线即拦。 */
function checkCloudflare(usage) {
  if (isDisabled()) return allowed();
  const used = Number(usage && usage.cloudflare && usage.cloudflare.usedNeurons) || 0;
  const limit = cloudflareEffectiveLimit();
  if (used >= limit) {
    return blocked(
      `Cloudflare 今日用量已达上限（已用 ${fmtNum(used)} / ${fmtNum(limit)} Neurons，` +
      `拦截线为每日额度的 ${Math.round(cloudflareFraction() * 100)}%），` +
      '明天 08:00（北京时间）恢复',
    );
  }
  return allowed();
}

/** Groq：指定模型当日 tokens 或请求数任一到顶即拦。 */
function checkGroq(usage, model) {
  if (isDisabled()) return allowed();
  const entry = usage && usage.groq && usage.groq.byModel
    ? usage.groq.byModel[String(model)] : null;
  if (!entry) return allowed(); // 该模型今日无用量，放行
  const tokens = Number(entry.tokens) || 0;
  const requests = Number(entry.requests) || 0;
  if (tokens >= GROQ_DAILY_TOKEN_LIMIT) {
    return blocked(
      `Groq 模型 ${model} 今日 tokens 已达上限（已用 ${fmtNum(tokens)} / ` +
      `${fmtNum(GROQ_DAILY_TOKEN_LIMIT)}），明天 08:00（北京时间）恢复`,
    );
  }
  if (requests >= GROQ_DAILY_REQUEST_LIMIT) {
    return blocked(
      `Groq 模型 ${model} 今日请求数已达上限（已用 ${fmtNum(requests)} / ` +
      `${fmtNum(GROQ_DAILY_REQUEST_LIMIT)} 次），明天 08:00（北京时间）恢复`,
    );
  }
  return allowed();
}

/** 远端用量缓存的通用检查：used >= limit 即拦；无数据时放行。 */
function checkRemoteUsage(entry, label, recoveryHint) {
  if (isDisabled()) return allowed();
  if (!entry || typeof entry !== 'object') return allowed();
  // 存储形状为 camelCase（characterCount/characterLimit），兼容旧 snake_case。
  const used = Number(entry.characterCount ?? entry.character_count);
  const limit = Number(entry.characterLimit ?? entry.character_limit);
  if (!Number.isFinite(used) || !Number.isFinite(limit) || limit <= 0) return allowed();
  if (used >= limit) {
    return blocked(
      `${label}免费额度已用完（已用 ${fmtNum(used)} / ${fmtNum(limit)} 字符），${recoveryHint}`,
    );
  }
  return allowed();
}

/** ElevenLabs：按缓存的官方用量检查（调用前请先 refreshIfStale）。 */
function checkElevenLabs(usage) {
  return checkRemoteUsage(
    usage && usage.elevenlabs,
    'ElevenLabs 本月',
    '请等待下个计费周期恢复',
  );
}

/** DeepL：按缓存的官方用量检查（调用前请先 refreshIfStale）。 */
function checkDeepL(usage) {
  return checkRemoteUsage(
    usage && usage.deepl,
    'DeepL',
    '请等待额度周期恢复',
  );
}

/** Kaggle：本周已用秒数 + 本次任务预留超过上限即拦。 */
function checkKaggle(usage, reserveSeconds) {
  if (isDisabled()) return allowed();
  const used = Number(usage && usage.kaggle && usage.kaggle.usedSeconds) || 0;
  const reserve = Number(reserveSeconds) || 0;
  if (used + reserve > KAGGLE_WEEKLY_LIMIT_SECONDS) {
    const remaining = Math.max(0, KAGGLE_WEEKLY_LIMIT_SECONDS - used);
    return blocked(
      `Kaggle 本周 GPU 额度不足（已用 ${fmtNum(used)} 秒，剩余 ${fmtNum(remaining)} 秒，` +
      `本次任务需预留 ${fmtNum(reserve)} 秒），下周一 08:00（北京时间）恢复`,
    );
  }
  return allowed();
}

/**
 * 存储：已用字节达到上限即拦。bytes 为 null 表示查不到用量（存储不可用），
 * fail open 放行。站内没有删除历史记录的功能，所以提示去 R2 控制台清理
 * 或调高 QUOTA_STORAGE_BYTES，不要承诺不存在的站内清理功能。
 */
function checkStorage(bytes) {
  if (isDisabled()) return allowed();
  if (bytes === null || bytes === undefined) return allowed();
  const limit = getStorageLimitBytes();
  if (Number(bytes) >= limit) {
    return blocked(
      `存储空间已达上限（已用 ${fmtBytes(bytes)} / ${fmtBytes(limit)}），` +
      '请到 R2 控制台删除旧文件清理，或调高 QUOTA_STORAGE_BYTES',
    );
  }
  return allowed();
}

/** 全站每月请求数：本月累计达到上限即拦。 */
function checkMonthlyRequests(usage) {
  if (isDisabled()) return allowed();
  const limit = getMonthlyRequestLimit();
  if (limit === 0) return allowed();
  const count = Number(usage && usage.requests && usage.requests.count) || 0;
  if (count >= limit) {
    return blocked(
      `本月请求数已达上限（已用 ${fmtNum(count)} / ${fmtNum(limit)} 次），下月 1 日恢复`,
    );
  }
  return allowed();
}

// ── 远端用量刷新 ─────────────────────────────────────────────────────

/**
 * ElevenLabs / DeepL 缓存的 updatedAt 超过 maxAgeMs（默认 10 分钟）时，
 * 调 ctx.usage.refreshRemoteUsage() 刷新，返回刷新后的 usage 对象。
 * 刷新失败时 fail open：记 warn 日志，返回旧 usage 放行本次请求。
 */
async function refreshIfStale(ctx, maxAgeMs = DEFAULT_STALE_MS) {
  let usage;
  try {
    usage = await ctx.usage.load();
  } catch (err) {
    console.warn('[quota] 读取用量失败，放行本次请求:', err.message);
    return null;
  }
  const now = Date.now();
  const isStale = (entry) => {
    if (!entry || typeof entry !== 'object' || !entry.updatedAt) return true;
    const updatedAt = new Date(entry.updatedAt).getTime();
    return !Number.isFinite(updatedAt) || (now - updatedAt > maxAgeMs);
  };
  if (isStale(usage.elevenlabs) || isStale(usage.deepl)) {
    try {
      await ctx.usage.refreshRemoteUsage();
      usage = await ctx.usage.load();
    } catch (err) {
      console.warn('[quota] 用量刷新失败，放行本次请求:', err.message);
    }
  }
  return usage;
}

// ── 全站请求计数中间件 ───────────────────────────────────────────────

/** 不计数也不拦截的路径（健康检查、登录、状态查询、用量查询、二次验证）。 */
const EXEMPT_PATHS = new Set([
  '/api/health',
  '/api/login',
  '/api/auth/status',
  '/api/usage',
]);

function isExemptPath(pathname) {
  if (EXEMPT_PATHS.has(pathname)) return true;
  return pathname === '/api/totp' || pathname.startsWith('/api/totp/');
}

/**
 * 全站每月请求数计数中间件（挂在 requireAuth 之后、rateLimit 之前）。
 * 只对 /api/* 计数：内存计数，每满 100 次调 addRequests(100) 刷盘；
 * 计数达到上限时返回 429 + {ok:false, quotaExceeded:true}，不进入后续处理。
 * 持久化用量最多 60 秒重新加载一次（兼顾月度清零与性能）。
 */
function createRequestCounter() {
  let cachedMonth = null;
  let cachedCount = 0;
  let pending = 0;
  let lastLoadAt = 0;
  const RELOAD_MS = 60 * 1000;
  const FLUSH_EVERY = 100;

  return async function requestCounter(req, res, next) {
    try {
      if (isDisabled()) return next();
      const limit = getMonthlyRequestLimit();
      if (limit === 0) return next();
      const pathname = req.path || '';
      if (!pathname.startsWith('/api/')) return next();
      if (isExemptPath(pathname)) return next();

      const now = Date.now();
      const month = currentMonthKey();
      if (cachedMonth !== month || now - lastLoadAt > RELOAD_MS) {
        // 先把内存里的计数刷盘，再重新加载持久化用量，避免丢计数。
        if (pending > 0) {
          await usageModule.addRequests(pending);
          pending = 0;
        }
        const usage = await usageModule.load();
        cachedMonth = usage.requests.month;
        cachedCount = usage.requests.count;
        lastLoadAt = now;
      }

      const effective = cachedCount + pending;
      if (effective >= limit) {
        return res.status(429).json({
          ok: false,
          quotaExceeded: true,
          message: `本月请求数已达上限（已用 ${fmtNum(effective)} / ${fmtNum(limit)} 次），下月 1 日恢复`,
        });
      }

      pending += 1;
      if (pending >= FLUSH_EVERY) {
        await usageModule.addRequests(FLUSH_EVERY);
        cachedCount += FLUSH_EVERY;
        pending -= FLUSH_EVERY;
      }
      return next();
    } catch (err) {
      // 计数本身出错时 fail open：记日志放行，不阻塞正常请求。
      console.warn('[quota] 请求计数失败，放行本次请求:', err.message);
      return next();
    }
  };
}

/** 启动日志用的一行额度摘要。 */
function describeQuotas() {
  if (isDisabled()) return '用量上限：已关闭（QUOTA_DISABLED=1）';
  const reqLimit = getMonthlyRequestLimit();
  return `用量上限：Cloudflare ${fmtNum(cloudflareEffectiveLimit())} Neurons/天，` +
    `存储 ${fmtBytes(getStorageLimitBytes())}，` +
    `每月请求 ${reqLimit === 0 ? '不限' : `${fmtNum(reqLimit)} 次`}`;
}

module.exports = {
  CLOUDFLARE_DAILY_LIMIT,
  DEFAULT_CLOUDFLARE_FRACTION,
  GROQ_DAILY_TOKEN_LIMIT,
  GROQ_DAILY_REQUEST_LIMIT,
  KAGGLE_WEEKLY_LIMIT_SECONDS,
  KAGGLE_RESERVE_IMAGE_SECONDS,
  KAGGLE_RESERVE_VIDEO_SECONDS,
  DEFAULT_STORAGE_LIMIT_BYTES,
  DEFAULT_MONTHLY_REQUEST_LIMIT,
  DEFAULT_STALE_MS,
  currentMonthKey,
  fmtBytes,
  isDisabled,
  cloudflareFraction,
  cloudflareEffectiveLimit,
  getStorageLimitBytes,
  getMonthlyRequestLimit,
  checkCloudflare,
  checkGroq,
  checkElevenLabs,
  checkDeepL,
  checkKaggle,
  checkStorage,
  checkMonthlyRequests,
  refreshIfStale,
  createRequestCounter,
  describeQuotas,
};
