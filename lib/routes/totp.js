// lib/routes/totp.js — TOTP 二次验证的开启 / 确认 / 关闭 / 状态
//
// GET  /api/totp/status   { totpEnabled, authEnabled, backupCodesRemaining }
// POST /api/totp/setup    生成密钥（无服务端状态），返回 {secret, otpauthUrl}
// POST /api/totp/confirm  {secret, code}：验动态码，通过后保存配置并返回
//                         8 个备用码（明文只返回这一次）
// POST /api/totp/disable  {password}：验访问密码后清除配置
//
// 全部接口都在 requireAuth 之后（需登录）；未设 ACCESS_PASSWORD 时拒绝
// 开启（没有登录，二次验证无意义）。setup/confirm 是无状态的：密钥由
// 客户端持有并在 confirm 时传回，避免多实例下内存待确认状态不一致。
// 恢复口子：环境变量 TOTP_DISABLE=1 时登录跳过二次验证（见 auth.js），
// 供“验证器与备用码全丢”时恢复用；用完应立即删掉该变量并重新开启。

const auth = require('../auth');
const totp = require('../totp');
const { isTotpBypassed } = totp;

function registerRoutes(app, ctx) {
  app.get('/api/totp/status', async (req, res) => {
    try {
      const cfg = await ctx.config.getTotp();
      res.json({
        totpEnabled: !isTotpBypassed() && cfg !== null,
        authEnabled: auth.isAuthEnabled(),
        backupCodesRemaining: cfg ? cfg.backupCodes.length : 0,
      });
    } catch (err) {
      res.json({ ok: false, message: err.message || '读取二次验证状态失败' });
    }
  });

  // 生成密钥：纯生成，不存任何状态；客户端在 confirm 时把 secret 传回。
  app.post('/api/totp/setup', async (req, res) => {
    try {
      if (!auth.isAuthEnabled()) {
        return res.status(400).json({ ok: false, message: '需先设置访问密码再开启二次验证' });
      }
      if (isTotpBypassed()) {
        return res.status(400).json({ ok: false, message: 'TOTP_DISABLE=1 时无法开启二次验证，请先删掉该变量并重新部署' });
      }
      const cfg = await ctx.config.getTotp();
      if (cfg) {
        return res.status(400).json({ ok: false, message: '已开启二次验证，请先关闭再重新设置' });
      }
      const secret = totp.generateSecret();
      res.json({
        ok: true,
        secret,
        otpauthUrl: totp.buildOtpAuthUrl({ secret, account: 'free-ai-tool-station' }),
      });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message || '生成密钥失败，请稍后重试' });
    }
  });

  // 确认开启：验动态码，通过后保存配置并返回备用码（明文只返回这一次）。
  app.post('/api/totp/confirm', async (req, res) => {
    try {
      if (!auth.isAuthEnabled()) {
        return res.status(400).json({ ok: false, message: '需先设置访问密码再开启二次验证' });
      }
      if (isTotpBypassed()) {
        return res.status(400).json({ ok: false, message: 'TOTP_DISABLE=1 时无法开启二次验证，请先删掉该变量并重新部署' });
      }
      const secret = req.body && req.body.secret;
      const code = req.body && req.body.code;
      if (typeof secret !== 'string' || !secret) {
        return res.status(400).json({ ok: false, message: '缺少密钥，请重新生成' });
      }
      if (!totp.verifyCode(secret, code)) {
        return res.status(401).json({ ok: false, message: '动态码不正确，请核对验证器里的 6 位码' });
      }
      const cfg = await ctx.config.getTotp();
      if (cfg) {
        return res.status(400).json({ ok: false, message: '已开启二次验证，请先关闭再重新设置' });
      }
      const backupCodes = totp.generateBackupCodes();
      await ctx.config.setTotp({
        secret,
        backupCodes: backupCodes.map((c) => totp.hashBackupCode(c)),
        enabledAt: new Date().toISOString(),
      });
      res.json({ ok: true, backupCodes });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message || '开启失败，请稍后重试' });
    }
  });

  // 关闭：需提供访问密码（防止已登录会话被顺手关掉二次验证）。
  app.post('/api/totp/disable', async (req, res) => {
    try {
      const password = req.body && req.body.password;
      if (!auth.verifyPassword(password)) {
        return res.status(401).json({ ok: false, message: '密码不正确' });
      }
      await ctx.config.setTotp(null);
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ ok: false, message: err.message || '关闭失败，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes };
