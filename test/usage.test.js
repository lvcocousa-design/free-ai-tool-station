// test/usage.test.js — 用量累计逻辑（lib/usage.js）
//
// 按存储接口契约写：addCloudflareNeurons / addKaggleSeconds / getUsage
// 都用 await 调用，同步/异步实现都能跑。
// Cloudflare 按 UTC 自然日累计（上限 10000 Neurons/天，日期变了清零）；
// Kaggle 按自然周累计（上限 108000 秒，每周一 00:00 UTC 清零）。
// 测试一律用临时 DATA_DIR + 全新模块实例，不碰项目 data/ 目录。
// Groq 按 UTC 自然日、按模型累计 tokens/请求数；请求数按自然月累计。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshUsage, todayUTC, yesterdayUTC, mondayUTC } = require('./helpers');

function currentMonthUTC() {
  return new Date().toISOString().slice(0, 7);
}

function previousMonthUTC() {
  const d = new Date();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString().slice(0, 7);
}

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
  assert.deepEqual(Object.keys(result).sort(),
    ['cloudflare', 'deepl', 'elevenlabs', 'groq', 'kaggle', 'requests']);
  assert.equal(result.cloudflare.usedNeurons, 0);
  assert.equal(result.cloudflare.limit, 10000);
  assert.equal(result.cloudflare.date, todayUTC());
  assert.equal(result.kaggle.usedSeconds, 0);
  assert.equal(result.kaggle.jobs, 0);
  assert.equal(result.kaggle.limitSeconds, 108000);
  assert.equal(result.elevenlabs, null);
  assert.equal(result.deepl, null);
  assert.equal(result.groq.date, todayUTC());
  assert.deepEqual(result.groq.byModel, {});
  assert.equal(result.requests.month, currentMonthUTC());
  assert.equal(result.requests.count, 0);
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

test('addGroqUsage 累计：按模型分账，tokens 与请求数分别累加', async (t) => {
  const { usage, dir } = freshUsage(t);
  await usage.addGroqUsage('fake-model-a', 1000);
  await usage.addGroqUsage('fake-model-a', 500, 1);
  await usage.addGroqUsage('fake-model-b', 200, 3);
  const result = await usage.getUsage();
  assert.deepEqual(result.groq.byModel['fake-model-a'], { tokens: 1500, requests: 2 });
  assert.deepEqual(result.groq.byModel['fake-model-b'], { tokens: 200, requests: 3 });
  assert.equal(result.groq.date, todayUTC());
  // 持久化形状一致
  const stored = readUsageFile(dir);
  assert.deepEqual(stored.groq.byModel['fake-model-a'], { tokens: 1500, requests: 2 });
});

test('addGroqUsage tokens 为 0 时也计请求（STT 转写只计请求）', async (t) => {
  const { usage } = freshUsage(t);
  await usage.addGroqUsage('whisper-large-v3-turbo', 0, 1);
  await usage.addGroqUsage('whisper-large-v3-turbo', 0, 1);
  const result = await usage.getUsage();
  assert.deepEqual(result.groq.byModel['whisper-large-v3-turbo'], { tokens: 0, requests: 2 });
});

test('addRequests 累计：多次调用累加，getUsage 返回本月计数', async (t) => {
  const { usage, dir } = freshUsage(t);
  await usage.addRequests(100);
  await usage.addRequests(5);
  const result = await usage.getUsage();
  assert.equal(result.requests.count, 105);
  assert.equal(result.requests.month, currentMonthUTC());
  assert.equal(readUsageFile(dir).requests.count, 105);
});

test('Groq 跨日清零：昨天写的用量，今天 getUsage 时归零（其他字段不受影响）', async (t) => {
  const { usage, dir } = freshUsage(t);
  writeUsageFile(dir, {
    cloudflare: { date: todayUTC(), usedNeurons: 100, byModel: { 'fake-model-a': 100 } },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 3600, jobs: 1 },
    groq: {
      date: yesterdayUTC(),
      byModel: { 'fake-model-a': { tokens: 5000, requests: 9 } },
    },
    requests: { month: currentMonthUTC(), count: 42 },
    elevenlabs: null,
    deepl: null,
  });
  const result = await usage.getUsage();
  assert.deepEqual(result.groq.byModel, {});
  assert.equal(result.groq.date, todayUTC());
  // 其他字段保留
  assert.equal(result.cloudflare.usedNeurons, 100);
  assert.equal(result.kaggle.usedSeconds, 3600);
  assert.equal(result.requests.count, 42);
  // 清零写回了文件
  const stored = readUsageFile(dir);
  assert.deepEqual(stored.groq.byModel, {});
  assert.equal(stored.groq.date, todayUTC());
});

test('请求数跨月清零：上月写的计数，本月 getUsage 时归零（Groq 不受影响）', async (t) => {
  const { usage, dir } = freshUsage(t);
  writeUsageFile(dir, {
    cloudflare: { date: todayUTC(), usedNeurons: 100, byModel: { 'fake-model-a': 100 } },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 3600, jobs: 1 },
    groq: {
      date: todayUTC(),
      byModel: { 'fake-model-a': { tokens: 5000, requests: 9 } },
    },
    requests: { month: previousMonthUTC(), count: 12345 },
    elevenlabs: null,
    deepl: null,
  });
  const result = await usage.getUsage();
  assert.equal(result.requests.count, 0);
  assert.equal(result.requests.month, currentMonthUTC());
  // Groq 当日用量保留
  assert.deepEqual(result.groq.byModel['fake-model-a'], { tokens: 5000, requests: 9 });
  // 清零写回了文件
  const stored = readUsageFile(dir);
  assert.equal(stored.requests.count, 0);
  assert.equal(stored.requests.month, currentMonthUTC());
});

test('旧 usage.json 缺少 groq/requests 字段时补默认值，不影响现有用量', async (t) => {
  const { usage, dir } = freshUsage(t);
  // 模拟升级前的 usage.json：只有旧字段
  writeUsageFile(dir, {
    cloudflare: { date: todayUTC(), usedNeurons: 100, byModel: { 'fake-model-a': 100 } },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 3600, jobs: 1 },
    elevenlabs: null,
    deepl: null,
  });
  const result = await usage.getUsage();
  assert.equal(result.cloudflare.usedNeurons, 100);
  assert.deepEqual(result.groq.byModel, {});
  assert.equal(result.requests.count, 0);
});
