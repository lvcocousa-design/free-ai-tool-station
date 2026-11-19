// lib/auth.js — 可选访问密码保护
//
// - 未设置 ACCESS_PASSWORD（或为空）时不设防，行为与公开访问完全一致。
// - 设置后：/api/*（除 /api/login、/api/health、/api/auth/status）与
//   /blobs/* 需要登录；静态前端不设防，由前端查 /api/auth/status 决定
//   是否显示登录页。
// - 会话是随机 token（crypto.randomBytes 生成），只保存在服务端内存里，
//   进程重启即失效；token 经 httpOnly cookie 下发，密码永不进 cookie 或日志。
// - 密码比对先 SHA-256 哈希再常量时间比对，不泄露长度与内容。

const crypto = require('crypto');

const COOKIE_NAME = 'auth_token';
const TOKEN_BYTES = 32;

// 内存 token 集合：进程重启即失效（有意为之，不做持久化）。
const validTokens = new Set();

/** 是否启用了访问密码保护（每次调用都读环境变量，便于测试）。 */
function isAuthEnabled() {
  const pw = process.env.ACCESS_PASSWORD;
  return typeof pw === 'string' && pw.length > 0;
}

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw, 'utf8').digest();
}

/** 常量时间比对密码；未启用保护或候选值不是字符串时一律返回 false。 */
function verifyPassword(candidate) {
  if (!isAuthEnabled()) return false;
  if (typeof candidate !== 'string') return false;
  return crypto.timingSafeEqual(hashPassword(candidate), hashPassword(process.env.ACCESS_PASSWORD));
}

/** 签发一个新会话 token 并记入内存集合。 */
function issueToken() {
  const token = crypto.randomBytes(TOKEN_BYTES).toString('hex');
  validTokens.add(token);
  return token;
}

/** 校验 token 是否为本进程签发且未失效。 */
function isValidToken(token) {
  return typeof token === 'string' && token.length > 0 && validTokens.has(token);
}

/** 从请求 Cookie 头里取 auth_token（无 cookie-parser 依赖，手动解析）。 */
function getTokenFromRequest(req) {
  const header = req && req.headers && req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === COOKIE_NAME) {
      const value = part.slice(eq + 1).trim();
      return value || null;
    }
  }
  return null;
}

/** 请求是否携带有效会话 token。 */
function isAuthenticated(req) {
  return isValidToken(getTokenFromRequest(req));
}

/** 登录成功时下发的 Set-Cookie 值：httpOnly，不带密码本身。 */
function buildAuthCookie(token) {
  return `${COOKIE_NAME}=${token}; HttpOnly; Path=/; SameSite=Lax`;
}

// 不设防的接口：登录、健康检查（供 Cloud Run 等平台用）、登录状态查询。
const PUBLIC_API_PATHS = new Set(['/api/login', '/api/health', '/api/auth/status']);

function needsAuth(req) {
  const urlPath = req.path || '';
  if (urlPath.startsWith('/api/')) return !PUBLIC_API_PATHS.has(urlPath);
  if (urlPath === '/blobs' || urlPath.startsWith('/blobs/')) return true;
  return false;
}

/**
 * Express 中间件：挂在静态托管与路由加载之前。
 * 未启用保护时直接放行；需要保护的路径无有效会话时返回 401。
 */
function requireAuth(req, res, next) {
  if (!isAuthEnabled()) return next();
  if (!needsAuth(req)) return next();
  if (isAuthenticated(req)) return next();
  res.status(401).json({ ok: false, message: '未登录，请先登录' });
}

module.exports = {
  COOKIE_NAME,
  isAuthEnabled,
  verifyPassword,
  issueToken,
  isValidToken,
  getTokenFromRequest,
  isAuthenticated,
  buildAuthCookie,
  requireAuth,
};
