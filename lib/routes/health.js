// lib/routes/health.js — 健康检查

function registerRoutes(app, ctx) {
  app.get('/api/health', (req, res) => {
    res.json({ ok: true });
  });
}

module.exports = { registerRoutes };
