// 向量路由：POST /api/embed
// body {provider:'cloudflare'|'siliconflow', text1, text2}
// → {ok:true, similarity, dimension} 或 {ok:false, message}
// similarity 是两段文本向量的余弦相似度，保留 4 位小数，范围 0~1。

const PROVIDERS = {
  cloudflare: { label: 'Cloudflare' },
  siliconflow: { label: '硅基流动' },
};

// 余弦相似度，钳制到 [0, 1] 后保留 4 位小数
function cosineSimilarity(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;
  const sim = dot / denom;
  const clamped = Math.min(1, Math.max(0, sim));
  return Math.round(clamped * 10000) / 10000;
}

// Cloudflare 调用后记用量（neurons 由 provider 函数按 RATES 表附带返回）
async function recordCloudflareUsage(ctx, result) {
  if (result && result.model && typeof result.neurons === 'number' && result.neurons > 0) {
    try {
      await ctx.usage.addCloudflareNeurons(result.model, result.neurons);
    } catch { /* 用量记录失败不阻塞主流程 */ }
  }
}

function registerRoutes(app, ctx) {
  app.post('/api/embed', async (req, res) => {
    try {
      const { provider, text1, text2 } = req.body || {};
      if (!text1 || typeof text1 !== 'string' || !text1.trim()) {
        return res.json({ ok: false, message: '文本 1 不能为空' });
      }
      if (!text2 || typeof text2 !== 'string' || !text2.trim()) {
        return res.json({ ok: false, message: '文本 2 不能为空' });
      }
      const meta = PROVIDERS[provider];
      if (!meta) {
        return res.json({ ok: false, message: `不支持的向量供应商：${provider || '（空）'}` });
      }
      if (!await ctx.config.isConfigured(provider)) {
        return res.json({
          ok: false,
          notConfigured: true,
          message: `${meta.label}未配置，请先在设置页填写 API Key`,
        });
      }

      let result;
      if (provider === 'cloudflare') {
        const creds = await ctx.config.getProvider('cloudflare');
        result = await ctx.providers.cloudflare.embed({
          accountId: creds.accountId,
          apiKey: creds.apiKey,
          texts: [text1, text2],
        });
        await recordCloudflareUsage(ctx, result);
      } else {
        const creds = await ctx.config.getProvider('siliconflow');
        result = await ctx.providers.siliconflow.embed({
          apiKey: creds.apiKey,
          texts: [text1, text2],
        });
      }

      const [v1, v2] = result.embeddings;
      if (!v1 || !v2 || v1.length !== v2.length) {
        return res.json({ ok: false, message: '上游返回的向量数量或维度不一致' });
      }
      return res.json({
        ok: true,
        similarity: cosineSimilarity(v1, v2),
        dimension: v1.length,
      });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '计算相似度失败，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes };
