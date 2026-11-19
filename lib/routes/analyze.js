// 识图路由：POST /api/analyze
// body {provider:'zhipu'|'gemini'|'siliconflow', mode:'ask'|'ocr', imageBase64, mimeType, question?}
// → {ok:true, text} 或 {ok:false, message}
// zhipu/gemini + ask：识图问答；siliconflow + ocr：硅基流动 OCR。
// 图片只随请求转发给上游，不存储。

function registerRoutes(app, ctx) {
  app.post('/api/analyze', async (req, res) => {
    try {
      const { provider, mode, imageBase64, mimeType, question } = req.body || {};
      if (!imageBase64 || typeof imageBase64 !== 'string') {
        return res.json({ ok: false, message: '请先上传图片' });
      }

      if (provider === 'zhipu' && mode === 'ask') {
        if (!await ctx.config.isConfigured('zhipu')) {
          return res.json({ ok: false, notConfigured: true, message: '智谱未配置，请先在设置页填写 API Key' });
        }
        const creds = await ctx.config.getProvider('zhipu');
        const result = await ctx.providers.zhipu.visionQA({
          apiKey: creds.apiKey,
          imageBase64,
          mimeType,
          question,
        });
        return res.json({ ok: true, text: result.text });
      }

      if (provider === 'gemini' && mode === 'ask') {
        if (!await ctx.config.isConfigured('gemini')) {
          return res.json({ ok: false, notConfigured: true, message: 'Gemini 未配置，请先在设置页填写 API Key' });
        }
        const creds = await ctx.config.getProvider('gemini');
        const result = await ctx.providers.gemini.visionQA({
          apiKey: creds.apiKey,
          imageBase64,
          mimeType,
          question,
        });
        return res.json({ ok: true, text: result.text });
      }

      if (provider === 'siliconflow' && mode === 'ocr') {
        if (!await ctx.config.isConfigured('siliconflow')) {
          return res.json({ ok: false, notConfigured: true, message: '硅基流动未配置，请先在设置页填写 API Key' });
        }
        const creds = await ctx.config.getProvider('siliconflow');
        const result = await ctx.providers.siliconflow.ocr({
          apiKey: creds.apiKey,
          imageBase64,
          mimeType,
        });
        return res.json({ ok: true, text: result.text });
      }

      return res.json({
        ok: false,
        message: `不支持的组合：供应商 ${provider || '（空）'} + 模式 ${mode || '（空）'}，识图提问请用智谱或 Gemini，OCR 请用硅基流动`,
      });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '识图失败，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes };
