// lib/routes/settings.js — 供应商配置 + 用量 + 状态
//
// GET  /api/providers      各供应商 configured、label、quotaNote（绝不返回密钥值）
// POST /api/providers/:name 保存供应商凭据（白名单校验，存 settings.json）
// GET  /api/usage          先 refreshRemoteUsage 再返回用量
// GET  /api/status         instabox/kaggle/cloudflare 配置与在线状态

const PROVIDER_META = {
  zhipu: { label: '智谱 z.ai', quotaNote: 'GLM-4.x-Flash 永久免费，对话与识图可用' },
  groq: { label: 'Groq', quotaNote: '免费档：每模型每天 20 万 tokens、1000 次请求' },
  cloudflare: { label: 'Cloudflare Workers AI', quotaNote: '免费档：每天 10,000 Neurons' },
  deepl: { label: 'DeepL', quotaNote: 'API Free 计划：100 万字符额度（以账号页为准）' },
  elevenlabs: { label: 'ElevenLabs', quotaNote: 'Free 计划：每月 10,000 credits；音乐 API 需付费计划' },
  siliconflow: { label: '硅基流动', quotaNote: '部分模型免费（国内版需实名；国际版仅 1 美元体验金）' },
  kaggle: { label: 'Kaggle', quotaNote: '免费档：每周 30 GPU 小时' },
  instabox: { label: 'InstaBox', quotaNote: '免费云电脑：单次运行最长 2 小时，空闲自动暂停' },
};

const PROVIDER_ORDER = ['zhipu', 'groq', 'cloudflare', 'deepl', 'elevenlabs', 'siliconflow', 'kaggle', 'instabox'];

// POST 允许写入的凭据字段（多余字段直接丢弃）。
const ALLOWED_FIELDS = ['apiKey', 'accountId', 'username', 'proxyUrl'];

/**
 * InstaBox 在线判断：GET 代理 /progress?id=ping，200 即在线，5 秒超时。
 * 优先用 instabox 模块的 checkOnline(proxyUrl)；模块缺失时直接 fetch；
 * 模块和配置都缺失（无 proxyUrl）时 online=false。不抛错。
 */
async function checkInstaboxOnline(ctx) {
  const creds = ctx.config.getProvider('instabox');
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
  // 各供应商配置状态（只返回 configured，不返回密钥值）。
  app.get('/api/providers', (req, res) => {
    const providers = PROVIDER_ORDER.map((name) => ({
      name,
      configured: ctx.config.isConfigured(name),
      label: PROVIDER_META[name].label,
      quotaNote: PROVIDER_META[name].quotaNote,
    }));
    res.json({ providers });
  });

  // 保存供应商凭据（白名单校验）。
  app.post('/api/providers/:name', (req, res) => {
    const { name } = req.params;
    if (!PROVIDER_META[name]) {
      return res.status(400).json({ ok: false, message: `未知的供应商：${name}` });
    }
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const creds = {};
    for (const field of ALLOWED_FIELDS) {
      if (typeof body[field] === 'string') {
        creds[field] = body[field];
      }
    }
    const saved = ctx.config.setProvider(name, creds);
    if (!saved) {
      return res.status(400).json({ ok: false, message: '保存失败，未知的供应商' });
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
    res.json(ctx.usage.getUsage());
  });

  // 各后端配置与在线状态。
  app.get('/api/status', async (req, res) => {
    const online = await checkInstaboxOnline(ctx);
    res.json({
      instabox: {
        configured: ctx.config.isConfigured('instabox'),
        online,
      },
      kaggle: {
        configured: ctx.config.isConfigured('kaggle'),
      },
      cloudflare: {
        configured: ctx.config.isConfigured('cloudflare'),
      },
    });
  });
}

module.exports = { registerRoutes };
