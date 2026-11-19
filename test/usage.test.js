// test/usage.test.js — 用量累计逻辑（lib/usage.js）
//
// 按存储接口契约写：addCloudflareNeurons / addKaggleSeconds / getUsage
// 都用 await 调用，同步/异步实现都能跑。
// Cloudflare 按 UTC 自然日累计（上限 10000 Neurons/天，日期变了清零）；
// Kaggle 按自然周累计（上限 108000 秒，每周一 00:00 UTC 清零）。
// 测试一律用临时 DATA_DIR + 全新模块实例，不碰项目 data/ 目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshUsage, todayUTC, yesterdayUTC, mondayUTC } = require('./helpers');

function readUsageFile(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'usage.json'), 'utf8'));
}

function writeUsageFile(dir, usage) {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(usage, null, 2), 'utf8');
}

test('addCloudflareNeurons 累计：多次调用累加，getUsage 返回当日用量与上限', async (t) => {
  const { usage } = freshUsage(t);
  await usage.addCloudflareNeurons('fake-model-a', 100);
  await usage.addCloudflareNeurons('fake-model-a', 50);
  const result = await usage.getUsage();
  assert.equal(result.cloudflare.usedNeurons, 150);
  assert.equal(result.cloudflare.limit, 10000);
  assert.equal(result.cloudflare.date, todayUTC());
});

test('addCloudflareNeurons 按模型分账：byModel 在 usage.json 里分模型累计', async (t) => {
  const { usage, dir } = freshUsage(t);
  await usage.addCloudflareNeurons('fake-model-a', 100);
  await usage.addCloudflareNeurons('fake-model-b', 50);
  await usage.addCloudflareNeurons('fake-model-a', 25);
  const stored = readUsageFile(dir);
  assert.equal(stored.cloudflare.usedNeurons, 175);
  assert.equal(stored.cloudflare.byModel['fake-model-a'], 125);
  assert.equal(stored.cloudflare.byModel['fake-model-b'], 50);
});

test('addKaggleSeconds 累计：秒数累加，每次调用 jobs 计 1', async (t) => {
  const { usage } = freshUsage(t);
  await usage.addKaggleSeconds(3600);
  await usage.addKaggleSeconds(1800);
  const result = await usage.getUsage();
  assert.equal(result.kaggle.usedSeconds, 5400);
  assert.equal(result.kaggle.jobs, 2);
  assert.equal(result.kaggle.limitSeconds, 108000);
});

test('getUsage 返回结构：全新实例用量为 0、上限正确、远端用量为 null', async (t) => {
  const { usage } = freshUsage(t);
  const result = await usage.getUsage();
  assert.deepEqual(Object.keys(result).sort(), ['cloudflare', 'deepl', 'elevenlabs', 'kaggle']);
  assert.equal(result.cloudflare.usedNeurons, 0);
  assert.equal(result.cloudflare.limit, 10000);
  assert.equal(result.cloudflare.date, todayUTC());
  assert.equal(result.kaggle.usedSeconds, 0);
  assert.equal(result.kaggle.jobs, 0);
  assert.equal(result.kaggle.limitSeconds, 108000);
  assert.equal(result.elevenlabs, null);
  assert.equal(result.deepl, null);
});

test('Cloudflare 跨日清零：昨天写的用量，今天 getUsage 时归零（Kaggle 不受影响）', async (t) => {
  const { usage, dir } = freshUsage(t);
  writeUsageFile(dir, {
    cloudflare: { date: yesterdayUTC(), usedNeurons: 5000, byModel: { 'fake-model-a': 5000 } },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 3600, jobs: 1 },
    elevenlabs: null,
    deepl: null,
  });
  const result = await usage.getUsage();
  assert.equal(result.cloudflare.usedNeurons, 0);
  assert.equal(result.cloudflare.date, todayUTC());
  // Kaggle 本周用量保留
  assert.equal(result.kaggle.usedSeconds, 3600);
  assert.equal(result.kaggle.jobs, 1);
  // 清零写回了文件
  assert.equal(readUsageFile(dir).cloudflare.usedNeurons, 0);
  assert.deepEqual(readUsageFile(dir).cloudflare.byModel, {});
});

test('Kaggle 跨周清零：上周写的用量，本周 getUsage 时归零（Cloudflare 不受影响）', async (t) => {
  const { usage, dir } = freshUsage(t);
  writeUsageFile(dir, {
    cloudflare: { date: todayUTC(), usedNeurons: 100, byModel: { 'fake-model-a': 100 } },
    kaggle: { weekStart: mondayUTC(1), usedSeconds: 7200, jobs: 3 },
    elevenlabs: null,
    deepl: null,
  });
  const result = await usage.getUsage();
  assert.equal(result.kaggle.usedSeconds, 0);
  assert.equal(result.kaggle.jobs, 0);
  // Cloudflare 当日用量保留
  assert.equal(result.cloudflare.usedNeurons, 100);
  // 清零写回了文件
  const stored = readUsageFile(dir);
  assert.equal(stored.kaggle.usedSeconds, 0);
  assert.equal(stored.kaggle.jobs, 0);
  assert.equal(stored.kaggle.weekStart, mondayUTC());
});

test('usage.json 损坏时回落默认值，不抛错', async (t) => {
  const { usage, dir } = freshUsage(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'usage.json'), '{ this is not json', 'utf8');
  const result = await usage.getUsage();
  assert.equal(result.cloudflare.usedNeurons, 0);
  assert.equal(result.cloudflare.date, todayUTC());
  assert.equal(result.kaggle.usedSeconds, 0);
  assert.equal(result.kaggle.jobs, 0);
  assert.equal(result.elevenlabs, null);
  assert.equal(result.deepl, null);
});

test('usage.json 结构非法（如存了字符串）时回落默认值，不抛错', async (t) => {
  const { usage, dir } = freshUsage(t);
  writeUsageFile(dir, 'not-an-object');
  const result = await usage.getUsage();
  assert.equal(result.cloudflare.usedNeurons, 0);
  assert.equal(result.kaggle.usedSeconds, 0);
});
