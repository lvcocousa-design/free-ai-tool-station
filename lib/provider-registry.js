// lib/provider-registry.js — 供应商插件注册表
//
// 扫描 lib/providers/*.js，自动发现供应商模块，不再硬编码供应商名单。
// 每个供应商模块必须导出：
//   meta: { name, label, quotaNote, applyUrl, order, capabilities, credentials }
//   test: async (creds) => {ok:true} | {ok:false, message}（只读探测，不抛错）
//   getUsage（可选）: async (creds) => {used, limit, unit} | null
//   以及各自的能力方法（chat / translate / tts / …，函数名与签名保持不变）。
//
// 校验：缺 meta、或 meta.name 与文件名不符的模块记 warn 并跳过，不阻断启动；
// require 失败（文件损坏、依赖缺失）的模块同样记 warn 并跳过。
// 注意：本文件不要放进 lib/providers/ 里，避免被自己发现。
//
// 导出：
//   get(name)         → 供应商模块，未加载返回 null
//   list()            → 全部供应商模块，按 meta.order 升序
//   forCapability(cap)→ 具备该能力的供应商模块（cap 如 'chat'/'image'），按 order 排序
//   names()           → 全部供应商名，按 order 排序
//   skippedNames()    → 被跳过的模块名（加载失败或 meta 不合格），供 context 置 null 用
//   createRegistry(dir) → 对指定目录建一个独立注册表（测试用；默认实例扫描 lib/providers）

const fs = require('fs');
const path = require('path');

const PROVIDERS_DIR = path.join(__dirname, 'providers');

function createRegistry(providersDir) {
  const dir = providersDir || PROVIDERS_DIR;
  const modules = new Map(); // name -> module
  const skipped = []; // 被跳过的模块名（按发现顺序）

  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.js')).sort();
  } catch (err) {
    console.warn(`[provider-registry] 读取 ${dir} 失败：${err.message}`);
  }

  for (const file of files) {
    const name = path.basename(file, '.js');
    let mod;
    try {
      mod = require(path.join(dir, file));
    } catch (err) {
      console.warn(`[provider-registry] 供应商 ${name} 加载失败，已跳过：${err.message}`);
      skipped.push(name);
      continue;
    }
    if (!mod || typeof mod !== 'object' || !mod.meta || typeof mod.meta !== 'object') {
      console.warn(`[provider-registry] 供应商 ${name} 缺少 meta，已跳过`);
      skipped.push(name);
      continue;
    }
    if (mod.meta.name !== name) {
      console.warn(
        `[provider-registry] 供应商 ${name} 的 meta.name 为 ${JSON.stringify(mod.meta.name)}，与文件名不符，已跳过`,
      );
      skipped.push(name);
      continue;
    }
    modules.set(name, mod);
  }

  const sorted = () => [...modules.values()].sort(
    (a, b) => (a.meta.order ?? 999) - (b.meta.order ?? 999)
      || String(a.meta.name).localeCompare(String(b.meta.name)),
  );

  return {
    get(name) {
      return modules.get(name) || null;
    },
    list() {
      return sorted();
    },
    forCapability(cap) {
      return sorted().filter(
        (mod) => Array.isArray(mod.meta.capabilities) && mod.meta.capabilities.includes(cap),
      );
    },
    names() {
      return sorted().map((mod) => mod.meta.name);
    },
    skippedNames() {
      return [...skipped];
    },
  };
}

// 默认实例：扫描 lib/providers/（加载时扫描一次）。
const registry = createRegistry(PROVIDERS_DIR);

module.exports = { ...registry, createRegistry };
