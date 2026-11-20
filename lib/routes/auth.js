// lib/routes/auth.js — 访问密码登录与登录状态查询
//
// POST /api/login：body {password, totpCode?}，正确返回 {ok:true} 并 Set-Cookie
//   下发会话 token；错误返回 401 {ok:false, message:'密码不正确'}（不透露
//   密码是否已设置以外的信息）。未启用保护时直接返回 {ok:true}。
//   开启 TOTP 后还需验动态码（或一次性备用码）：动态码不对记一次登录失败；
//   TOTP 配置读失败时 fail closed 返回 500；环境变量 TOTP_DISABLE=1 时跳过
//   二次验证（恢复口子，见 lib/totp.js）。
// GET /api/auth/status：返回 {authRequired, authenticated, totpEnabled}，供前端
//   决定是否显示登录页与动态码输入框。两个接口都不受 requireAuth 中间件拦截。

const auth = require('../auth');
const { getClientIp } = require('../rate-limit');
const loginLimit = require('../login-limit');
const totp = require('../totp');
const { isTotpBypassed } = totp;

function registerRoutes(app, ctx) {
  app.get('/api/auth/status', async (req, res) => {
    const required = auth.isAuthEnabled();
    let totpEnabled = false;
    if (required && !isTotpBypassed()) {
      try {
        totpEnabled = (await ctx.config.getTotp()) !== null;
      } catch (_) {
        // 状态读失败时按未开启报告；登录接口本身会 fail closed 返回 500，
        // 不会静默放行。
        totpEnabled = false;
      }
    }
    res.json({ authRequired: required, authenticated: !required || auth.isAuthenticated(req), totpEnabled });
  });

  app.post('/api/login', async (req, res) => {
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
    // 二次验证（已开启且未被 TOTP_DISABLE=1 恢复口子跳过时）。
    if (!isTotpBypassed()) {
      let cfg = null;
      try {
        cfg = await ctx.config.getTotp();
      } catch (err) {
        // 读不到 TOTP 配置时 fail closed：绝不跳过二次验证。
        console.warn('[auth] 登录时读取 TOTP 配置失败:', err.message);
        return res.status(500).json({ ok: false, message: '二次验证状态读取失败，请稍后重试' });
      }
      if (cfg) {
        const code = req.body && req.body.totpCode;
        if (typeof code !== 'string' || !code.trim()) {
          return res.status(401).json({ ok: false, message: '请输入动态码' });
        }
        const trimmed = code.trim();
        if (!totp.verifyCode(cfg.secret, trimmed)) {
          // 动态码不对时再试备用码（一次性，用掉即删）。
          const matchedHash = totp.findBackupCodeHash(cfg.backupCodes, trimmed);
          if (!matchedHash) {
            loginLimit.recordLoginFailure(ip);
            console.warn(`[auth] 登录失败（动态码不正确），IP：${ip}`);
            return res.status(401).json({ ok: false, message: '动态码不正确' });
          }
          try {
            await ctx.config.setTotp({
              ...cfg,
              backupCodes: cfg.backupCodes.filter((h) => h !== matchedHash),
            });
          } catch (err) {
            console.warn('[auth] 消费备用码失败:', err.message);
            return res.status(500).json({ ok: false, message: '备用码验证失败，请稍后重试' });
          }
        }
      }
    }
    loginLimit.clearLoginFailures(ip);
    const token = auth.issueToken();
    res.set('Set-Cookie', auth.buildAuthCookie(token));
    res.json({ ok: true });
  });
}

module.exports = { registerRoutes };
