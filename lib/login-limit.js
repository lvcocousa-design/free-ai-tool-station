// lib/login-limit.js — 登录失败限流（防密码猜测）
//
// POST /api/login 不走通用限流（见 lib/rate-limit.js 的 EXEMPT），因为登录
// 需要“只计失败、成功清零、窗口更长”的语义：
// - 只计失败次数：成功登录不占名额，且清掉该 IP 的失败记录；
// - 默认同一 IP 15 分钟内最多 5 次失败，超了返回 429（带 Retry-After）；
// - 计数在内存里，进程重启即清零；窗口与次数可配，次数设 0 关闭。
// IP 取法与通用限流一致（lib/rate-limit.js 的 getClientIp，不读
// X-Forwarded-For，避免伪造绕过）；Cloud Run 下同一出口 IP 的用户共享
// 名额，但只计失败，正常使用不会触发。

const { SlidingWindowCounter } = require('./rate-limit');

const DEFAULT_MAX_ATTEMPTS = 5;
const DEFAULT_WINDOW_MINUTES = 15;

let cachedRaw = { max: undefined, window: undefined };
let cachedConfig = null;
const counter = new SlidingWindowCounter({ windowMs: DEFAULT_WINDOW_MINUTES * 60 * 1000 });

function parseNonNegativeInt(raw, defaultValue, envName) {
  if (raw === undefined || raw === '') return defaultValue;
  const trimmed = String(raw).trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  console.warn(
    `[login-limit] ${envName} 无效（${JSON.stringify(raw)}），已回落到默认值 ${defaultValue}（应为非负整数）`,
  );
  return defaultValue;
}

/** 当前配置 { maxAttempts, windowMinutes }（maxAttempts 为 0 表示关闭）。 */
function getLoginLimitConfig() {
  const rawMax = process.env.LOGIN_MAX_ATTEMPTS;
  const rawWindow = process.env.LOGIN_WINDOW_MINUTES;
  if (cachedConfig && cachedRaw.max === rawMax && cachedRaw.window === rawWindow) {
    return cachedConfig;
  }
  cachedRaw = { max: rawMax, window: rawWindow };
  cachedConfig = {
    maxAttempts: parseNonNegativeInt(rawMax, DEFAULT_MAX_ATTEMPTS, 'LOGIN_MAX_ATTEMPTS'),
    windowMinutes: parseNonNegativeInt(rawWindow, DEFAULT_WINDOW_MINUTES, 'LOGIN_WINDOW_MINUTES'),
  };
  // 窗口可配：计数器窗口跟随配置。
  counter.windowMs = cachedConfig.windowMinutes * 60 * 1000;
  return cachedConfig;
}

/** 该 IP 现在是否还能尝试登录；被拦时返回剩余等待秒数。 */
function checkLoginAllowed(ip, now = Date.now()) {
  const { maxAttempts } = getLoginLimitConfig();
  if (maxAttempts === 0) return { allowed: true, retryAfterSeconds: 0 };
  if (counter.count(ip, now) >= maxAttempts) {
    return { allowed: false, retryAfterSeconds: counter.retryAfterSeconds(ip, now) };
  }
  return { allowed: true, retryAfterSeconds: 0 };
}

/** 记一次登录失败（只在密码错误时调）。 */
function recordLoginFailure(ip, now = Date.now()) {
  const { maxAttempts } = getLoginLimitConfig();
  if (maxAttempts === 0) return;
  counter.record(ip, now);
}

/** 登录成功后清掉该 IP 的失败记录。 */
function clearLoginFailures(ip) {
  counter.delete(ip);
}

/** 供 server.js 启动日志用的状态描述。 */
function describeLoginLimit() {
  const { maxAttempts, windowMinutes } = getLoginLimitConfig();
  if (maxAttempts === 0) return '已关闭';
  return `已启用（同一 IP ${windowMinutes} 分钟内最多 ${maxAttempts} 次失败）`;
}

/** 清空计数与配置缓存（测试用；生产代码不要调）。 */
function resetLoginLimiter() {
  counter.reset();
  cachedConfig = null;
  cachedRaw = { max: undefined, window: undefined };
  counter.windowMs = DEFAULT_WINDOW_MINUTES * 60 * 1000;
}

module.exports = {
  DEFAULT_MAX_ATTEMPTS,
  DEFAULT_WINDOW_MINUTES,
  getLoginLimitConfig,
  checkLoginAllowed,
  recordLoginFailure,
  clearLoginFailures,
  describeLoginLimit,
  resetLoginLimiter,
};
