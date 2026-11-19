// 翻译路由：POST /api/translate
// body {provider:'deepl'|'cloudflare'|'siliconflow', text, sourceLang?, targetLang}
// → {ok:true, text} 或 {ok:false, message}
// sourceLang 可为空（自动检测）；targetLang 如 EN-US、ZH。

const PROVIDERS = {
  deepl: { label: 'DeepL' },
  cloudflare: { label: 'Cloudflare' },
  siliconflow: { label: '硅基流动' },
};

// Cloudflare 调用后记用量（neurons 由 provider 函数按 RATES 表附带返回）
function recordCloudflareUsage(ctx, result) {
  if (result && result.model && typeof result.neurons === 'number' && result.neurons > 0) {
    try {
      ctx.usage.addCloudflareNeurons(result.model, result.neurons);
    } catch { /* 用量记录失败不阻塞主流程 */ }
  }
}

function registerRoutes(app, ctx) {
  app.post('/api/translate', async (req, res) => {
    try {
      const { provider, text, sourceLang, targetLang } = req.body || {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.json({ ok: false, message: '原文不能为空' });
      }
      if (!targetLang || typeof targetLang !== 'string' || !targetLang.trim()) {
        return res.json({ ok: false, message: '目标语言不能为空' });
      }
      const meta = PROVIDERS[provider];
      if (!meta) {
        return res.json({ ok: false, message: `不支持的翻译供应商：${provider || '（空）'}` });
      }
      if (!ctx.config.isConfigured(provider)) {
        return res.json({
          ok: false,
          notConfigured: true,
          message: `${meta.label}未配置，请先在设置页填写 API Key`,
        });
      }

      let result;
      if (provider === 'deepl') {
        const creds = ctx.config.getProvider('deepl');
        result = await ctx.providers.deepl.translate({
          apiKey: creds.apiKey,
          text,
          sourceLang,
          targetLang,
        });
      } else if (provider === 'cloudflare') {
        const creds = ctx.config.getProvider('cloudflare');
        result = await ctx.providers.cloudflare.translate({
          accountId: creds.accountId,
          apiKey: creds.apiKey,
          text,
          sourceLang,
          targetLang,
        });
        recordCloudflareUsage(ctx, result);
      } else {
        const creds = ctx.config.getProvider('siliconflow');
        result = await ctx.providers.siliconflow.translate({
          apiKey: creds.apiKey,
          text,
          sourceLang,
          targetLang,
        });
      }
      return res.json({ ok: true, text: result.text });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '翻译失败，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes };
