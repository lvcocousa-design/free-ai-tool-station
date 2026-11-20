// server.js — Express 入口
//
// - JSON body 上限 15MB（要传 base64 图片/音频）
// - 静态托管 public/（前端单页应用）
// - /blobs 映射到 data/blobs/（只允许该目录内的文件）
// - 自动加载 lib/routes/*.js（每个模块导出 registerRoutes(app, ctx)）
// - 可选访问密码保护：设置 ACCESS_PASSWORD 后 /api/* 与 /blobs/* 需登录
//   （lib/auth.js 中间件；/api/login、/api/health、/api/auth/status 不设防）
// - 按 IP 限流（lib/rate-limit.js 中间件，挂在 requireAuth 之后）：
//   生成类重操作默认每 IP 每分钟 60 次，查询类默认 300 次；
//   GET /api/health 与 POST /api/login 不限流；超限返回 429
// - 全站每月请求数上限（lib/quota.js 中间件，挂在 requireAuth 之后、
//   限流之前）：/api/* 每月默认 1,500,000 次，到顶返回 429；
//   健康检查、登录、状态查询、用量查询、二次验证接口不计数也不拦截
// - 监听 PORT 环境变量（默认 8080）

const fs = require('fs');
const path = require('path');
const express = require('express');

// 存储层先加载：STORAGE_BACKEND=s3 但缺配置时在这里抛错，
// 打印清晰中文错误后退出，不静默回落到本地（那样会造成数据已持久化的错觉）。
let store;
try {
  store = require('./lib/storage');
} catch (err) {
  console.error(`[server] 启动失败：${err.message}`);
  process.exit(1);
}
const { createContext } = require('./lib/context');
const auth = require('./lib/auth');
const rateLimiter = require('./lib/rate-limit');
const loginLimiter = require('./lib/login-limit');
const quota = require('./lib/quota');

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

// 访问密码保护（可选）：挂在静态托管与路由加载之前，确保 /blobs 也被保护。
// 未设置 ACCESS_PASSWORD 时中间件直接放行；静态前端本身不设防，由前端
// 查 /api/auth/status 决定是否显示登录页。
app.use(auth.requireAuth);

// 全站每月请求数上限（lib/quota.js）：挂在 requireAuth 之后、限流之前，
// 未登录请求先返回 401，不计入每月请求数；到顶返回 429。
app.use(quota.createRequestCounter());

// 按 IP 限流（lib/rate-limit.js）：挂在 requireAuth 之后，未登录请求先
// 返回 401，不占用限流配额；非 /api/* 路径与健康检查、登录接口不限流。
app.use(rateLimiter.rateLimit);

// 前端静态文件（public/ 由前端代理实现；目录不存在时 express.static 只会 404，不报错）。
app.use(express.static(path.join(__dirname, 'public')));

// 生成的成品文件：
// - 本地后端：只映射 data/blobs/ 目录，express.static 本身会阻止 ../ 穿透。
// - S3 后端：经存储层 readBlob 从桶里取回并按扩展名设 Content-Type 返回，
//   不存在返回 404（readBlob 内部已做 basename 清洗，防止 ../ 穿透）。
if (store.getBackendName() === 's3') {
  app.get('/blobs/:filename', async (req, res) => {
    try {
      const buffer = await store.readBlob(req.params.filename);
      res.set('Content-Type', store.contentTypeForExt(path.extname(req.params.filename)));
      res.send(buffer);
    } catch (err) {
      if (err && err.status === 404) {
        return res.status(404).json({ ok: false, message: '文件不存在' });
      }
      console.error('[server] 读取 blob 失败:', err.message);
      res.status(500).json({ ok: false, message: '读取文件失败，请稍后重试' });
    }
  });
} else {
  app.use('/blobs', express.static(store.blobsDir));
}

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
  console.log(`[server] 存储后端：${store.getBackendName()}`);
  console.log(`[server] 访问保护：${auth.isAuthEnabled() ? '已启用' : '未启用（公开访问）'}`);
  if (process.env.TOTP_DISABLE === '1') {
    console.log('[server] 警告：TOTP_DISABLE=1，二次验证已被跳过（恢复口子，用完请删掉该变量）');
  }
  if (quota.isDisabled()) {
    console.log('[server] 警告：QUOTA_DISABLED=1，全部用量上限拦截已关闭，超量不再拦');
  }
  console.log(`[server] ${quota.describeQuotas()}`);
  console.log(`[server] 限流：${rateLimiter.describeRateLimit()}`);
  console.log(`[server] 登录限流：${loginLimiter.describeLoginLimit()}`);
  if (store.getBackendName() === 'local') {
    console.log(`[server] 数据目录：${store.dataDir}`);
  }
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
