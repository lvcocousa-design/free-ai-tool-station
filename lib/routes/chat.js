// 对话路由：POST /api/chat、GET /api/chats、GET /api/chats/:id、DELETE /api/chats/:id
// 会话存 data/chats.json（经 ctx.store），格式：
//   [{id, provider, model, title, messages:[{role, content, ts}], createdAt, updatedAt}]
// provider：zhipu | groq | cloudflare | gemini（与 config 供应商名一致）

const models = require('../models');

// 默认模型来自 lib/models.json（单一来源），改模型只改配置。
const PROVIDERS = {
  zhipu: { label: '智谱', defaultModel: models.getDefaultModel('chat', 'zhipu') },
  groq: { label: 'Groq', defaultModel: models.getDefaultModel('chat', 'groq') },
  cloudflare: { label: 'Cloudflare', defaultModel: models.getDefaultModel('chat', 'cloudflare') },
  gemini: { label: 'Gemini', defaultModel: models.getDefaultModel('chat', 'gemini') },
};

async function loadChats(ctx) {
  const data = await ctx.store.readJSON('chats', []);
  return Array.isArray(data) ? data : [];
}

async function saveChats(ctx, chats) {
  await ctx.store.writeJSON('chats', chats);
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
  // POST /api/chat body {provider, model, chatId?, content}
  // → {ok:true, chatId, reply} 或 {ok:false, notConfigured:true, message} / {ok:false, message}
  app.post('/api/chat', async (req, res) => {
    try {
      const { provider, model, chatId, content } = req.body || {};
      const text = typeof content === 'string' ? content.trim() : '';
      if (!text) {
        return res.json({ ok: false, message: '消息内容不能为空' });
      }
      const meta = PROVIDERS[provider];
      if (!meta) {
        return res.json({ ok: false, message: `不支持的对话供应商：${provider || '（空）'}` });
      }
      if (!await ctx.config.isConfigured(provider)) {
        return res.json({
          ok: false,
          notConfigured: true,
          message: `${meta.label} 未配置，请先在设置页填写 API Key`,
        });
      }

      const chats = await loadChats(ctx);
      let chat = null;
      if (chatId) {
        chat = chats.find((c) => c.id === chatId);
        if (!chat) {
          return res.json({ ok: false, message: '会话不存在' });
        }
      } else {
        chat = {
          id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`,
          provider,
          model: model || meta.defaultModel,
          title: text.slice(0, 20),
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        chats.push(chat);
      }

      const useModel = model || chat.model || meta.defaultModel;
      chat.model = useModel;
      chat.messages.push({ role: 'user', content: text, ts: Date.now() });

      const history = chat.messages.map((m) => ({ role: m.role, content: m.content }));
      let result;
      if (provider === 'zhipu') {
        const creds = await ctx.config.getProvider('zhipu');
        result = await ctx.providers.zhipu.chat({ apiKey: creds.apiKey, model: useModel, messages: history });
      } else if (provider === 'groq') {
        const creds = await ctx.config.getProvider('groq');
        result = await ctx.providers.groq.chat({ apiKey: creds.apiKey, model: useModel, messages: history });
      } else if (provider === 'gemini') {
        const creds = await ctx.config.getProvider('gemini');
        result = await ctx.providers.gemini.chat({ apiKey: creds.apiKey, model: useModel, messages: history });
      } else {
        const creds = await ctx.config.getProvider('cloudflare');
        result = await ctx.providers.cloudflare.chat({
          accountId: creds.accountId,
          apiKey: creds.apiKey,
          model: useModel,
          messages: history,
        });
        await recordCloudflareUsage(ctx, result);
      }

      chat.messages.push({ role: 'assistant', content: result.text, ts: Date.now() });
      chat.updatedAt = Date.now();
      await saveChats(ctx, chats);
      return res.json({ ok: true, chatId: chat.id, reply: result.text });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '对话失败，请稍后重试' });
    }
  });

  // GET /api/chats → {chats:[{id, title, provider, model, createdAt, updatedAt}]}（新到旧）
  app.get('/api/chats', async (req, res) => {
    try {
      const chats = (await loadChats(ctx))
        .slice()
        .sort((a, b) => (b.updatedAt || b.createdAt || 0) - (a.updatedAt || a.createdAt || 0))
        .map((c) => ({
          id: c.id,
          title: c.title,
          provider: c.provider,
          model: c.model,
          createdAt: c.createdAt,
          updatedAt: c.updatedAt,
        }));
      return res.json({ chats });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '读取会话列表失败' });
    }
  });

  // GET /api/chats/:id → {chat}
  app.get('/api/chats/:id', async (req, res) => {
    try {
      const chat = (await loadChats(ctx)).find((c) => c.id === req.params.id);
      if (!chat) {
        return res.json({ ok: false, message: '会话不存在' });
      }
      return res.json({ chat });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '读取会话失败' });
    }
  });

  // DELETE /api/chats/:id → {deleted:true}
  app.delete('/api/chats/:id', async (req, res) => {
    try {
      const chats = await loadChats(ctx);
      const idx = chats.findIndex((c) => c.id === req.params.id);
      if (idx === -1) {
        return res.json({ ok: false, message: '会话不存在' });
      }
      chats.splice(idx, 1);
      await saveChats(ctx, chats);
      return res.json({ deleted: true });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '删除会话失败' });
    }
  });
}

module.exports = { registerRoutes };
