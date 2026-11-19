// server.js — Express 入口
//
// - JSON body 上限 15MB（要传 base64 图片/音频）
// - 静态托管 public/（前端单页应用）
// - /blobs 映射到 data/blobs/（只允许该目录内的文件）
// - 自动加载 lib/routes/*.js（每个模块导出 registerRoutes(app, ctx)）
// - 监听 PORT 环境变量（默认 8080）

const fs = require('fs');
const path = require('path');
const express = require('express');
const { createContext } = require('./lib/context');
const store = require('./lib/storage');

const app = express();

// JSON 上限 15MB：base64 图片/音频较大，默认 100kb 不够用。
app.use(express.json({ limit: '15mb' }));

// JSON 解析失败时返回统一格式，不裸奔 500。
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, message: '请求 JSON 解析失败，请检查请求体格式' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ ok: false, message: '请求体过大（上限 15MB）' });
  }
  return next(err);
});

// 前端静态文件（public/ 由前端代理实现；目录不存在时 express.static 只会 404，不报错）。
app.use(express.static(path.join(__dirname, 'public')));

// 生成的成品文件：只映射 data/blobs/ 目录，express.static 本身会阻止 ../ 穿透。
app.use('/blobs', express.static(store.blobsDir));

const ctx = createContext();

// 自动加载路由：lib/routes/*.js，各导出 registerRoutes(app, ctx)。
// 单个路由加载失败只记日志、不阻断启动（其他代理的文件可能还在写），
// 但失败会明确打印出来，不会静默丢失接口。
const routesDir = path.join(__dirname, 'lib', 'routes');
let loadedRoutes = [];
try {
  const files = fs.readdirSync(routesDir).filter((f) => f.endsWith('.js')).sort();
  for (const file of files) {
    try {
      const mod = require(path.join(routesDir, file));
      if (typeof mod.registerRoutes === 'function') {
        mod.registerRoutes(app, ctx);
        loadedRoutes.push(file);
      } else {
        console.warn(`[server] 路由 ${file} 未导出 registerRoutes，已跳过`);
      }
    } catch (err) {
      console.error(`[server] 加载路由 ${file} 失败:`, err.message);
    }
  }
} catch (err) {
  console.error('[server] 读取 lib/routes/ 目录失败:', err.message);
}
console.log(`[server] 已加载路由: ${loadedRoutes.join(', ') || '(无)'}`);

// 未命中的 API 返回统一格式；非 API 请求落到前端 404。
app.use('/api', (req, res) => {
  res.status(404).json({ ok: false, message: '接口不存在' });
});

// 兜底错误处理：不裸奔 500。
app.use((err, req, res, next) => {
  console.error('[server] 请求处理出错:', err && err.stack ? err.stack : err);
  if (res.headersSent) return next(err);
  res.status(500).json({ ok: false, message: '服务器内部错误，请稍后重试' });
});

const port = Number(process.env.PORT || 8080);
if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`[server] 启动失败：PORT 环境变量无效（${process.env.PORT}），应为 1~65535 的整数`);
  process.exit(1);
}

const server = app.listen(port, () => {
  console.log(`[server] 免费AI工具站后端已启动：http://localhost:${port}`);
  console.log(`[server] 数据目录：${store.dataDir}`);
});

server.on('error', (err) => {
  if (err && err.code === 'EADDRINUSE') {
    console.error(`[server] 启动失败：端口 ${port} 已被占用，请换一个 PORT 再试`);
  } else if (err && err.code === 'EACCES') {
    console.error(`[server] 启动失败：没有权限监听端口 ${port}，请换用大于 1024 的端口`);
  } else {
    console.error('[server] 启动失败:', err && err.message ? err.message : err);
  }
  process.exit(1);
});
