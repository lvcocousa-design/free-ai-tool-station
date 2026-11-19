// lib/routes/auth.js — 访问密码登录与登录状态查询
//
// POST /api/login：body {password}，正确返回 {ok:true} 并 Set-Cookie 下发
//   会话 token；错误返回 401 {ok:false, message:'密码不正确'}（不透露
//   密码是否已设置以外的信息）。未启用保护时直接返回 {ok:true}。
// GET /api/auth/status：返回 {authRequired, authenticated}，供前端决定
//   是否显示登录页。两个接口都不受 requireAuth 中间件拦截。

const auth = require('../auth');

function registerRoutes(app, ctx) {
  app.get('/api/auth/status', (req, res) => {
    const required = auth.isAuthEnabled();
    res.json({ authRequired: required, authenticated: !required || auth.isAuthenticated(req) });
  });

  app.post('/api/login', (req, res) => {
    if (!auth.isAuthEnabled()) {
      return res.json({ ok: true });
    }
    const password = req.body && req.body.password;
    if (!auth.verifyPassword(password)) {
      return res.status(401).json({ ok: false, message: '密码不正确' });
    }
    const token = auth.issueToken();
    res.set('Set-Cookie', auth.buildAuthCookie(token));
    res.json({ ok: true });
  });
}

module.exports = { registerRoutes };
