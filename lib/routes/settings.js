// lib/routes/settings.js — 供应商配置 + 用量 + 状态
//
// GET  /api/providers      各供应商 configured、label、quotaNote（绝不返回密钥值）
// POST /api/providers/:name 保存供应商凭据（白名单校验，存 settings.json）
// GET  /api/usage          先 refreshRemoteUsage 再返回用量
// GET  /api/status         instabox/kaggle/cloudflare 配置与在线状态
//
// 供应商元信息（label、quotaNote、applyUrl、order、capabilities、凭据字段）
// 全部来自供应商注册表（lib/provider-registry.js），不再硬编码。

const registry = require('../provider-registry');

/**
 * InstaBox 在线判断：GET 代理 /progress?id=ping，200 即在线，5 秒超时。
 * 优先用 instabox 模块的 checkOnline(proxyUrl)；模块缺失时直接 fetch；
 * 模块和配置都缺失（无 proxyUrl）时 online=false。不抛错。
 */
async function checkInstaboxOnline(ctx) {
  const creds = await ctx.config.getProvider('instabox');
  const proxyUrl = creds && creds.proxyUrl;
  if (!proxyUrl) return false;

  const instabox = ctx.providers && ctx.providers.instabox;
  if (instabox && typeof instabox.checkOnline === 'function') {
    try {
      return Boolean(await instabox.checkOnline(proxyUrl));
    } catch (_) {
      return false;
    }
  }

  // 模块还没就位时的兜底：直接探活，5 秒超时。
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const res = await fetch(`${proxyUrl.replace(/\/+$/, '')}/progress?id=ping`, {
        signal: controller.signal,
      });
      return res.status === 200;
    } finally {
      clearTimeout(timer);
    }
  } catch (_) {
    return false;
  }
}

function registerRoutes(app, ctx) {
  // 各供应商配置状态（只返回 configured，不返回密钥值；fields 不含 env 名）。
  app.get('/api/providers', async (req, res) => {
    try {
      const configuredList = await ctx.config.listProviders();
      const configuredByName = Object.fromEntries(
        configuredList.map((p) => [p.name, p.configured]),
      );
      const providers = registry.list().map((mod) => ({
        name: mod.meta.name,
        configured: configuredByName[mod.meta.name] === true,
        label: mod.meta.label,
        quotaNote: mod.meta.quotaNote || '',
        order: mod.meta.order,
        applyUrl: mod.meta.applyUrl || '',
        capabilities: [...(mod.meta.capabilities || [])],
        fields: (mod.meta.credentials || []).map((field) => ({
          key: field.key,
          label: field.label,
          type: field.type || 'text',
          required: field.required !== false,
          // placeholder 为可选扩展字段（目前只有 instabox 的 proxyUrl 有），有才返回。
          ...(field.placeholder ? { placeholder: field.placeholder } : {}),
        })),
      }));
      res.json({ providers });
    } catch (err) {
      res.json({ ok: false, message: err.message || '读取供应商配置失败' });
    }
  });

  // 保存供应商凭据（白名单校验：只认该供应商 meta.credentials 里的字段）。
  app.post('/api/providers/:name', async (req, res) => {
    const { name } = req.params;
    const mod = registry.get(name);
    if (!mod) {
      return res.status(400).json({ ok: false, message: `未知的供应商：${name}` });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const creds = {};
    for (const field of mod.meta.credentials || []) {
      if (typeof body[field.key] === 'string') {
        creds[field.key] = body[field.key];
      }
    }
    try {
      const saved = await ctx.config.setProvider(name, creds);
      if (!saved) {
        return res.status(400).json({ ok: false, message: '保存失败，未知的供应商' });
      }
    } catch (err) {
      return res.json({ ok: false, message: err.message || '保存失败，请稍后重试' });
    }
    res.json({ saved: true });
  });

  // 用量：先从官方接口刷新 ElevenLabs / DeepL 再返回。
  app.get('/api/usage', async (req, res) => {
    try {
      await ctx.usage.refreshRemoteUsage();
    } catch (err) {
      // refreshRemoteUsage 本身不抛错，这里是最后一道防线。
      console.warn('[settings] refreshRemoteUsage 异常:', err.message);
    }
    res.json(await ctx.usage.getUsage());
  });

  // 各后端配置与在线状态。
  app.get('/api/status', async (req, res) => {
    const online = await checkInstaboxOnline(ctx);
    const [instaboxConfigured, kaggleConfigured, cloudflareConfigured] = await Promise.all([
      ctx.config.isConfigured('instabox'),
      ctx.config.isConfigured('kaggle'),
      ctx.config.isConfigured('cloudflare'),
    ]);
    res.json({
      instabox: {
        configured: instaboxConfigured,
        online,
      },
      kaggle: {
        configured: kaggleConfigured,
      },
      cloudflare: {
        configured: cloudflareConfigured,
      },
    });
  });
}

module.exports = { registerRoutes };
