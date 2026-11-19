// lib/routes/models.js — GET /api/models：返回模型配置（lib/models.json 的内容）
//
// server.js 自动加载 lib/routes/*.js，本文件无需在别处注册。
// 前端下拉（对话模型、TTS 音色）从这里读配置；模型默认值也以这里为准。

const { getAll } = require('../models');

function registerRoutes(app, ctx) {
  app.get('/api/models', (req, res) => {
    res.json({ ok: true, models: getAll() });
  });
}

module.exports = { registerRoutes };
