// test/helpers.js — 测试公共辅助：临时目录、环境变量、模块缓存刷新
//
// 注意：storage.js / usage.js 在加载时读环境变量（DATA_DIR、STORAGE_BACKEND），
// 所以每个测试都要删 require.cache 后重新 require，才能拿到全新的模块实例。
// 本文件不含测试用例，只提供辅助函数；测试一律用临时 DATA_DIR，
// 绝不碰项目 data/ 目录，跑完自动清理。

const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT_ROOT = path.join(__dirname, '..');
const LIB_DIR = path.join(PROJECT_ROOT, 'lib');

function makeTempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-station-test-'));
  if (t) t.after(() => rmDir(dir));
  return dir;
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

/** 临时设置环境变量，测试结束自动恢复。value 为 undefined 表示删除该变量。 */
function withEnv(t, vars) {
  const saved = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  if (t) {
    t.after(() => {
      for (const key of Object.keys(saved)) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
    });
  }
}

/** 删掉 lib/ 下指定模块的 require 缓存（未加载过则忽略）。 */
function bustLibCache(...names) {
  for (const name of names) {
    try {
      delete require.cache[require.resolve(path.join(LIB_DIR, name))];
    } catch (_) { /* 未加载过，忽略 */ }
  }
}

/**
 * 全新临时 DATA_DIR + 全新 storage 实例。返回 { storage, dir }。
 * @param {object} t - node:test 的 TestContext（用于注册清理）
 * @param {object} [opts] - { backend }，backend 为 undefined 时删除 STORAGE_BACKEND（测默认值）
 */
function freshStorage(t, { backend = 'local' } = {}) {
  const dir = makeTempDir(t);
  withEnv(t, { DATA_DIR: dir, STORAGE_BACKEND: backend });
  bustLibCache('storage');
  const storage = require(path.join(LIB_DIR, 'storage'));
  return { storage, dir };
}

/** 全新临时 DATA_DIR + 全新 usage 实例（同时刷新它依赖的 storage/config）。 */
function freshUsage(t) {
  const dir = makeTempDir(t);
  withEnv(t, { DATA_DIR: dir, STORAGE_BACKEND: 'local' });
  bustLibCache('storage', 'config', 'usage');
  const usage = require(path.join(LIB_DIR, 'usage'));
  return { usage, dir };
}

// ---- UTC 日期辅助（与 lib/usage.js 的清零逻辑同一口径） ----

function utcDateString(date) {
  return date.toISOString().slice(0, 10);
}

function todayUTC() {
  return utcDateString(new Date());
}

function yesterdayUTC() {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return utcDateString(d);
}

/** 本周一的 UTC 日期；weeksAgo=1 为上周一。 */
function mondayUTC(weeksAgo = 0) {
  const now = new Date();
  const day = now.getUTCDay(); // 0=周日 … 6=周六
  const diffToMonday = (day + 6) % 7 + weeksAgo * 7;
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diffToMonday,
  ));
  return utcDateString(monday);
}

module.exports = {
  PROJECT_ROOT,
  LIB_DIR,
  makeTempDir,
  rmDir,
  withEnv,
  bustLibCache,
  freshStorage,
  freshUsage,
  utcDateString,
  todayUTC,
  yesterdayUTC,
  mondayUTC,
};
