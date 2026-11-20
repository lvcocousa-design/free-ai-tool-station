// lib/routes/auth.js — 访问密码登录与登录状态查询
//
// POST /api/login：body {password}，正确返回 {ok:true} 并 Set-Cookie 下发
//   会话 token；错误返回 401 {ok:false, message:'密码不正确'}（不透露
//   密码是否已设置以外的信息）。未启用保护时直接返回 {ok:true}。
//   登录失败计入限流（lib/login-limit.js）：同一 IP 15 分钟内最多 5 次
//   失败，超了返回 429；成功登录清掉该 IP 的失败记录。失败尝试记一条
//   warn 日志（只记 IP，不记密码），可在 Cloud Run 日志里看到。
// GET /api/auth/status：返回 {authRequired, authenticated}，供前端决定
//   是否显示登录页。两个接口都不受 requireAuth 中间件拦截。

const auth = require('../auth');
const { getClientIp } = require('../rate-limit');
const loginLimit = require('../login-limit');

function registerRoutes(app, ctx) {
  app.get('/api/auth/status', (req, res) => {
    const required = auth.isAuthEnabled();
    res.json({ authRequired: required, authenticated: !required || auth.isAuthenticated(req) });
  });

  app.post('/api/login', (req, res) => {
    if (!auth.isAuthEnabled()) {
      return res.json({ ok: true });
    }
    const ip = getClientIp(req);
    const check = loginLimit.checkLoginAllowed(ip);
    if (!check.allowed) {
      res.set('Retry-After', String(check.retryAfterSeconds));
      const waitText = check.retryAfterSeconds < 60
        ? `${check.retryAfterSeconds} 秒`
        : `${Math.ceil(check.retryAfterSeconds / 60)} 分钟`;
      return res.status(429).json({ ok: false, message: `登录尝试过于频繁，请 ${waitText}后再试` });
    }
    const password = req.body && req.body.password;
    if (!auth.verifyPassword(password)) {
      loginLimit.recordLoginFailure(ip);
      console.warn(`[auth] 登录失败，IP：${ip}`);
      return res.status(401).json({ ok: false, message: '密码不正确' });
    }
    loginLimit.clearLoginFailures(ip);
    const token = auth.issueToken();
    res.set('Set-Cookie', auth.buildAuthCookie(token));
    res.json({ ok: true });
  });
}

module.exports = { registerRoutes };
