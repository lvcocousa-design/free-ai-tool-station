// lib/context.js — 创建 ctx 对象，传给所有路由模块
//
// ctx = { config, store, usage, jobs, providers }
// providers 由 lib/provider-registry.js 自动发现（扫描 lib/providers/*.js），
// 不再硬编码名单；加载失败或 meta 不合格的模块置 null（warn 由注册表打印），
// 不让启动崩掉；jobs 同理（jobs.js 导出 createJobs 工厂函数）。

const config = require('./config');
const store = require('./storage');
const usage = require('./usage');
const registry = require('./provider-registry');

/** require 失败（文件不存在或加载报错）时返回 null 并打印警告，不抛错。 */
function tryRequire(modulePath, label) {
  try {
    return require(modulePath);
  } catch (err) {
    console.warn(`[context] ${label} 未加载（${err.code || err.message}），相关功能不可用`);
    return null;
  }
}

function loadJobs() {
  const jobsModule = tryRequire('./jobs', 'lib/jobs.js');
  if (!jobsModule) return null;
  try {
    // 生成代理的实现：导出 createJobs(store) 工厂函数
    if (typeof jobsModule.createJobs === 'function') {
      return jobsModule.createJobs(store);
    }
    // 兼容直接导出 jobs 对象的写法
    if (typeof jobsModule.createJob === 'function') {
      return jobsModule;
    }
    console.warn('[context] lib/jobs.js 导出格式无法识别，jobs 置 null');
    return null;
  } catch (err) {
    console.warn('[context] 初始化 jobs 失败:', err.message);
    return null;
  }
}

function createContext() {
  const providers = {};
  for (const mod of registry.list()) {
    providers[mod.meta.name] = mod;
  }
  // 加载失败 / meta 不合格的模块置 null（与旧版行为一致）。
  for (const name of registry.skippedNames()) {
    providers[name] = null;
  }
  return {
    config,
    store,
    usage,
    jobs: loadJobs(),
    providers,
  };
}

module.exports = { createContext };
