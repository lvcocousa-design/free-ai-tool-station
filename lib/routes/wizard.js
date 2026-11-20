// lib/routes/wizard.js — 首次启动配置向导的连接测试
//
// POST /api/providers/:name/test  用请求体里的凭据实时测一次上游连通性。
// 只测不存：绝不写 settings.json，凭据只在本次请求内存里使用。
// 必填字段与探测逻辑来自供应商注册表（lib/provider-registry.js）：
// 各供应商的 meta.credentials 定义必填字段，test(creds) 做轻量只读探测
// （默认 15 秒超时，见 lib/probe.js；做真实推理的探测可用更长超时，如 NVIDIA 用 90 秒）。
// 成功返回 {ok:true}；失败返回 {ok:false, message: 中文原因}，HTTP 200。
// 未知供应商或缺少必填字段返回 400。

const registry = require('../provider-registry');

function registerRoutes(app, _ctx) {
  app.post('/api/providers/:name/test', async (req, res) => {
    const { name } = req.params;
    const mod = registry.get(name);
    if (!mod) {
      return res.status(400).json({ ok: false, message: `未知的供应商：${name}` });
    }

    const credentials = Array.isArray(mod.meta.credentials) ? mod.meta.credentials : [];
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const creds = {};
    const missing = [];
    for (const field of credentials) {
      const value = typeof body[field.key] === 'string' ? body[field.key].trim() : '';
      creds[field.key] = value;
      if (field.required !== false && !value) missing.push(field.label || field.key);
    }
    if (missing.length) {
      return res.status(400).json({ ok: false, message: `请先填写${missing.join('、')}` });
    }

    if (typeof mod.test !== 'function') {
      return res.json({ ok: false, message: '该供应商暂不支持连接测试' });
    }

    try {
      const result = await mod.test(creds);
      // 探测失败也用 HTTP 200 返回，前端按 ok 字段区分；这里不写任何文件。
      if (result && typeof result === 'object' && typeof result.ok === 'boolean') {
        res.json(result);
      } else {
        res.json({ ok: false, message: '连接测试返回了意料之外的结果' });
      }
    } catch (err) {
      console.warn(`[wizard] 测试 ${name} 连接异常:`, err.message);
      res.json({ ok: false, message: '连接测试异常，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes };
