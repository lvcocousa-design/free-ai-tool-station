// lib/rate-limit.js — 按 IP 的简单限流（内存滑动窗口，零新依赖）
//
// - 只限 /api/* 路由；静态前端与 /blobs 不限流。
// - 分两级（每 IP、每分钟窗口）：
//     生成类重操作：默认 60 次/分钟（RATE_LIMIT_PER_MINUTE，0 关闭）；
//     查询类接口：默认 300 次/分钟（RATE_LIMIT_QUERY_PER_MINUTE，0 关闭）。
// - 豁免：GET /api/health（健康检查）不限流。POST /api/login 不走这里，
//   它有单独的登录失败限流（lib/login-limit.js：只计失败、成功清零、
//   窗口 15 分钟），因为登录需要不同的限流语义。
// - 超限返回 429 {ok:false, message:'请求过于频繁，请稍后再试'}，并带
//   Retry-After 头（秒数，到最早一条计数过期为止）。
// - 计数只保存在服务端内存里，进程重启即清零；窗口外的时间戳在每次
//   检查时清理，空键随即删除，另每 1000 次检查全量扫一次过期键，
//   避免长期不访问的 IP 占着内存。
// - 阈值每次请求都重读环境变量（便于测试；与 lib/auth.js 的做法一致），
//   但解析结果会缓存：只有原始值变化时才重新解析，非法值只在首次
//   出现时记一条 warn 日志，不会在每个请求都刷日志。
// - 挂载顺序（见 server.js）：挂在 auth.requireAuth 之后、路由加载之前，
//   这样未登录请求先返回 401，不占用限流配额。

const WINDOW_MS = 60 * 1000;
const DEFAULT_HEAVY_PER_MINUTE = 60;
const DEFAULT_QUERY_PER_MINUTE = 300;

// 生成类重操作（POST）：会调上游供应商或做重活的接口。
const HEAVY_POST_PATHS = new Set([
  '/api/generate',
  '/api/video',
  '/api/chat',
  '/api/analyze',
  '/api/translate',
  '/api/tts',
  '/api/stt',
  '/api/embed',
  '/api/backup/import',
]);

// POST /api/providers/:name/test 会调上游做连通性测试，同样算重操作。
const PROVIDER_TEST_RE = /^\/api\/providers\/[^/]+\/test$/;

// 不限流的接口。
const EXEMPT = new Set(['GET /api/health', 'POST /api/login']);

/**
 * 请求分级：'heavy'（生成类重操作）/ 'query'（其余查询类）/
 * 'exempt'（健康检查、登录）/ null（非 /api/* 路径，不限流）。
 * 未知 /api/* 路径也按查询类计（防 404 扫描刷接口）。
 */
function classifyRequest(method, urlPath) {
  if (typeof urlPath !== 'string' || !urlPath.startsWith('/api/')) return null;
  if (EXEMPT.has(`${method} ${urlPath}`)) return 'exempt';
  if (method === 'POST' && (HEAVY_POST_PATHS.has(urlPath) || PROVIDER_TEST_RE.test(urlPath))) {
    return 'heavy';
  }
  return 'query';
}

/** 解析单个阈值环境变量：未设/空串用默认值；0 表示关闭该级限流。 */
function parseLimit(raw, defaultValue, envName) {
  if (raw === undefined || raw === '') return defaultValue;
  const trimmed = String(raw).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  console.warn(
    `[rate-limit] ${envName} 无效（${JSON.stringify(raw)}），已回落到默认值 ${defaultValue}（应为非负整数，0 表示关闭）`,
  );
  return defaultValue;
}

// 解析结果缓存：只有原始值变化时才重新解析（非法值只 warn 一次）。
let cachedRaw = { heavy: undefined, query: undefined };
let cachedLimits = null;

/** 当前两级阈值 { heavyPerMinute, queryPerMinute }（0 表示该级已关闭）。 */
function getRateLimitConfig() {
  const rawHeavy = process.env.RATE_LIMIT_PER_MINUTE;
  const rawQuery = process.env.RATE_LIMIT_QUERY_PER_MINUTE;
  if (cachedLimits && cachedRaw.heavy === rawHeavy && cachedRaw.query === rawQuery) {
    return cachedLimits;
  }
  cachedRaw = { heavy: rawHeavy, query: rawQuery };
  cachedLimits = {
    heavyPerMinute: parseLimit(rawHeavy, DEFAULT_HEAVY_PER_MINUTE, 'RATE_LIMIT_PER_MINUTE'),
    queryPerMinute: parseLimit(rawQuery, DEFAULT_QUERY_PER_MINUTE, 'RATE_LIMIT_QUERY_PER_MINUTE'),
  };
  return cachedLimits;
}

/** 供 server.js 启动日志用的状态描述（不含 [server] 前缀）。 */
function describeRateLimit() {
  const { heavyPerMinute, queryPerMinute } = getRateLimitConfig();
  if (heavyPerMinute === 0 && queryPerMinute === 0) return '已关闭';
  const parts = [];
  parts.push(heavyPerMinute === 0 ? '生成类不限流' : `生成类 ${heavyPerMinute} 次/分钟/IP`);
  parts.push(queryPerMinute === 0 ? '查询类不限流' : `查询类 ${queryPerMinute} 次/分钟/IP`);
  return `已启用（${parts.join('，')}）`;
}

/**
 * 滑动窗口计数器（纯逻辑，时间可注入，便于单元测试不用等真实时间）。
 * 每个 key 存一串请求时间戳；检查时先丢掉窗口外（now - WINDOW_MS 之前）
 * 的旧时间戳，再看窗口内数量是否已达上限。
 */
class SlidingWindowCounter {
  constructor({ windowMs = WINDOW_MS } = {}) {
    this.windowMs = windowMs;
    this.entries = new Map(); // key → number[]（升序时间戳）
    this.checksSinceSweep = 0;
  }

  /**
   * 检查 key 在 now 时刻是否还能通过（limit 为当次检查的上限）。
   * 通过时记一条时间戳并返回 { allowed: true, retryAfterSeconds: 0 }；
   * 超限时不记，返回 { allowed: false, retryAfterSeconds }（到最早一条
   * 计数过期为止的秒数，向上取整，至少 1）。
   */
  check(key, limit, now = Date.now()) {
    const cutoff = now - this.windowMs;
    let stamps = this.entries.get(key);
    if (!stamps) {
      stamps = [];
      this.entries.set(key, stamps);
    }
    // 时间戳升序：从头部丢掉已过期的。
    let drop = 0;
    while (drop < stamps.length && stamps[drop] <= cutoff) drop++;
    if (drop > 0) stamps.splice(0, drop);

    let result;
    if (stamps.length < limit) {
      stamps.push(now);
      result = { allowed: true, retryAfterSeconds: 0 };
    } else {
      const waitMs = stamps[0] + this.windowMs - now;
      result = { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(waitMs / 1000)) };
    }

    if (stamps.length === 0) this.entries.delete(key);
    this.maybeSweep(now);
    return result;
  }

  /** key 在 now 时刻窗口内的计数（只数不记；登录失败计数用）。 */
  count(key, now = Date.now()) {
    const stamps = this.entries.get(key);
    if (!stamps) return 0;
    const cutoff = now - this.windowMs;
    let n = 0;
    for (let i = stamps.length - 1; i >= 0; i--) {
      if (stamps[i] > cutoff) n++;
      else break; // 时间戳升序，遇到过期即停
    }
    return n;
  }

  /** 只记一条时间戳，不做上限判断（登录失败计数用）。 */
  record(key, now = Date.now()) {
    let stamps = this.entries.get(key);
    if (!stamps) {
      stamps = [];
      this.entries.set(key, stamps);
    }
    const cutoff = now - this.windowMs;
    let drop = 0;
    while (drop < stamps.length && stamps[drop] <= cutoff) drop++;
    if (drop > 0) stamps.splice(0, drop);
    stamps.push(now);
    this.maybeSweep(now);
  }

  /** 删掉 key 的全部计数（登录成功后清掉该 IP 的失败记录）。 */
  delete(key) {
    this.entries.delete(key);
  }

  /** key 距下一次可通过的秒数（0 表示当前无记录或已无窗口内计数）。 */
  retryAfterSeconds(key, now = Date.now()) {
    const stamps = this.entries.get(key);
    if (!stamps || stamps.length === 0) return 0;
    const cutoff = now - this.windowMs;
    for (const t of stamps) {
      if (t > cutoff) return Math.max(1, Math.ceil((t + this.windowMs - now) / 1000));
    }
    return 0;
  }

  /** 每 1000 次检查全量扫一次：删掉全部时间戳都已过期的 key。 */
  maybeSweep(now) {
    this.checksSinceSweep += 1;
    if (this.checksSinceSweep < 1000) return;
    this.checksSinceSweep = 0;
    const cutoff = now - this.windowMs;
    for (const [key, stamps] of this.entries) {
      if (stamps.length === 0 || stamps[stamps.length - 1] <= cutoff) {
        this.entries.delete(key);
      }
    }
  }

  /** 清空全部计数（测试用）。 */
  reset() {
    this.entries.clear();
    this.checksSinceSweep = 0;
  }

  /** 当前跟踪的 key 数量（测试用）。 */
  get size() {
    return this.entries.size;
  }
}

// 两级各一个计数器（同 IP 的生成类与查询类配额互不占用）。
const heavyCounter = new SlidingWindowCounter();
const queryCounter = new SlidingWindowCounter();

/** 从请求取客户端 IP（不读 X-Forwarded-For，避免伪造绕过限流）。 */
function getClientIp(req) {
  if (req && typeof req.ip === 'string' && req.ip) return req.ip;
  if (req && req.socket && req.socket.remoteAddress) return req.socket.remoteAddress;
  return 'unknown';
}

/**
 * Express 中间件：挂在 auth.requireAuth 之后、路由加载之前。
 * 非 /api/* 路径与豁免接口直接放行；对应级别阈值为 0 时该级不限流。
 */
function rateLimit(req, res, next) {
  const level = classifyRequest(req.method, req.path);
  if (level === null || level === 'exempt') return next();
  const config = getRateLimitConfig();
  const limit = level === 'heavy' ? config.heavyPerMinute : config.queryPerMinute;
  if (limit === 0) return next();
  const counter = level === 'heavy' ? heavyCounter : queryCounter;
  const { allowed, retryAfterSeconds } = counter.check(getClientIp(req), limit);
  if (allowed) return next();
  res.set('Retry-After', String(retryAfterSeconds));
  res.status(429).json({ ok: false, message: '请求过于频繁，请稍后再试' });
}

/** 清空计数器与配置缓存（测试用；生产代码不要调）。 */
function resetRateLimiter() {
  heavyCounter.reset();
  queryCounter.reset();
  cachedLimits = null;
  cachedRaw = { heavy: undefined, query: undefined };
}

module.exports = {
  WINDOW_MS,
  DEFAULT_HEAVY_PER_MINUTE,
  DEFAULT_QUERY_PER_MINUTE,
  SlidingWindowCounter,
  classifyRequest,
  getRateLimitConfig,
  describeRateLimit,
  getClientIp,
  rateLimit,
  resetRateLimiter,
};
