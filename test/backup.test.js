// test/backup.test.js — 数据导出 / 导入（备份）接口
//
// server.js 在 require 时就会 listen，所以这里用 child_process 把 server.js
// 作为子进程跑在临时端口 + 临时 DATA_DIR 上，用 fetch 发真实 HTTP 请求。
// 种子数据直接写进临时 DATA_DIR 的 JSON 文件（服务端每次请求都重新读盘）。
// 测试里只用假 Key（如 test-key-123），仓库里绝不出现真实 Key。
// 测试结束杀掉子进程并清理临时目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { PROJECT_ROOT, makeTempDir, rmDir } = require('./helpers');

const SERVER_JS = path.join(PROJECT_ROOT, 'server.js');
const START_TIMEOUT_MS = 20000;

// 假 Key（仅供测试断言“导出不含凭据”用，不是真实凭据）。
const FAKE_GROQ_KEY = 'test-key-123';
const FAKE_CF_TOKEN = 'test-cf-token-456';
const FAKE_CF_ACCOUNT = 'test-account-789';

const SEED_HISTORY = [
  { id: 'gen-aaa', type: 'image', backend: 'cloudflare', prompt: '一只兔子', status: 'done', file: 'gen-1.png', createdAt: '2026-11-19T10:00:00.000Z' },
  { id: 'gen-bbb', type: 'video', backend: 'kaggle', prompt: '兔子跳舞', status: 'done', file: 'gen-2.mp4', createdAt: '2026-11-19T11:00:00.000Z' },
];
const SEED_CHATS = [
  { id: 'chat-1', provider: 'groq', model: 'gpt-oss-120b', title: '你好', messages: [{ role: 'user', content: '你好', ts: 1 }], createdAt: 1, updatedAt: 2 },
];
const SEED_USAGE = {
  cloudflare: { date: '2026-11-19', usedNeurons: 120, byModel: { 'flux-1-schnell': 120 } },
  kaggle: { weekStart: '2026-11-16', usedSeconds: 3600, jobs: 2 },
  elevenlabs: { characterCount: 100, characterLimit: 10000, updatedAt: '2026-11-19T00:00:00.000Z' },
  deepl: null,
};
const SEED_SETTINGS = {
  providers: {
    groq: { apiKey: FAKE_GROQ_KEY },
    cloudflare: { apiKey: FAKE_CF_TOKEN, accountId: FAKE_CF_ACCOUNT },
  },
};

/** 找一个空闲的本地端口（先占 0 号端口再释放，竞态概率极低）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

let child = null;
let baseUrl = '';
let dataDir = '';
let childOutput = '';

async function waitForHealth(url, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (child && child.exitCode !== null) {
      throw new Error(`服务器子进程提前退出（exitCode=${child.exitCode}），输出：\n${childOutput.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return;
    } catch (_) { /* 还没起来，继续等 */ }
    if (Date.now() > deadline) {
      throw new Error(`服务器 ${timeoutMs}ms 内未就绪，输出：\n${childOutput.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

test.before(async () => {
  dataDir = makeTempDir(null); // 手动清理（after 里删）
  const port = await freePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [SERVER_JS], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });
  await waitForHealth(baseUrl, START_TIMEOUT_MS);
});

test.after(async () => {
  if (child && child.exitCode === null) {
    child.kill('SIGTERM');
    const exited = await Promise.race([
      new Promise((resolve) => child.once('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
    ]);
    if (!exited) child.kill('SIGKILL');
  }
  child = null;
  if (dataDir) rmDir(dataDir);
  dataDir = '';
});

function writeDataFile(name, value) {
  fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify(value, null, 2), 'utf8');
}

function readDataFile(name) {
  return JSON.parse(fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8'));
}

function readDataFileRaw(name) {
  try {
    return fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8');
  } catch (_) {
    return null; // 文件不存在
  }
}

function seedAll() {
  writeDataFile('history', SEED_HISTORY);
  writeDataFile('chats', SEED_CHATS);
  writeDataFile('usage', SEED_USAGE);
  writeDataFile('settings', SEED_SETTINGS);
}

function clearData() {
  writeDataFile('history', []);
  writeDataFile('chats', []);
  fs.rmSync(path.join(dataDir, 'usage.json'), { force: true });
}

async function getExport() {
  const res = await fetch(`${baseUrl}/api/backup/export`);
  assert.equal(res.status, 200);
  return res.json();
}

async function postImport(body) {
  const res = await fetch(`${baseUrl}/api/backup/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  assert.equal(res.status, 200);
  return res.json();
}

test('导出结构正确，且导出内容里不含任何凭据值', async () => {
  seedAll();
  const data = await getExport();

  assert.equal(data.version, 1);
  assert.equal(typeof data.exportedAt, 'string');
  assert.deepEqual(data.history, SEED_HISTORY);
  assert.deepEqual(data.chats, SEED_CHATS);
  assert.deepEqual(data.usage, SEED_USAGE);
  assert.equal(data.blobsIncluded, false);
  assert.equal(typeof data.notes, 'string');

  // settings 只含 configured 布尔值，不含任何凭据字段。
  assert.deepEqual(data.settings.providers.groq, { configured: true });
  assert.deepEqual(data.settings.providers.cloudflare, { configured: true });

  // 全文 grep 不到任何假 Key。
  const text = JSON.stringify(data);
  assert.ok(!text.includes(FAKE_GROQ_KEY), '导出含 Groq 假 Key');
  assert.ok(!text.includes(FAKE_CF_TOKEN), '导出含 Cloudflare 假 Token');
  assert.ok(!text.includes(FAKE_CF_ACCOUNT), '导出含 Cloudflare 假 Account ID');
  assert.ok(!text.includes('apiKey'), '导出含 apiKey 字段名');
  assert.ok(!text.includes('accountId'), '导出含 accountId 字段名');
});

test('导入往返正常：导出→清空→导入→数据回来', async () => {
  seedAll();
  const backup = await getExport();

  clearData();
  assert.deepEqual(readDataFile('history'), []);
  assert.deepEqual(readDataFile('chats'), []);

  const result = await postImport(backup);
  assert.equal(result.ok, true);
  assert.deepEqual(result.imported, { history: 2, chats: 1 });

  assert.deepEqual(readDataFile('history'), SEED_HISTORY);
  assert.deepEqual(readDataFile('chats'), SEED_CHATS);
  assert.deepEqual(readDataFile('usage'), SEED_USAGE);
});

test('非法导入被拒且不写盘', async () => {
  seedAll();
  const before = {
    history: readDataFileRaw('history'),
    chats: readDataFileRaw('chats'),
    usage: readDataFileRaw('usage'),
    settings: readDataFileRaw('settings'),
  };

  // 坏 JSON（服务端 JSON 解析中间件直接拒掉，同样不写盘）。
  const badRes = await fetch(`${baseUrl}/api/backup/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.equal(badRes.status, 400);
  assert.equal((await badRes.json()).ok, false);

  // 缺 version。
  const noVersion = await postImport({ history: [], chats: [], usage: {} });
  assert.equal(noVersion.ok, false);
  assert.match(noVersion.message, /版本/);

  // version 不支持。
  const badVersion = await postImport({ version: 99, history: [], chats: [], usage: {} });
  assert.equal(badVersion.ok, false);

  // history 不是数组。
  const badHistory = await postImport({ version: 1, history: 'nope', chats: [], usage: {} });
  assert.equal(badHistory.ok, false);
  assert.match(badHistory.message, /history/);

  // history 条目不是对象。
  const badEntry = await postImport({ version: 1, history: ['nope'], chats: [], usage: {} });
  assert.equal(badEntry.ok, false);

  // chats 不是数组。
  const badChats = await postImport({ version: 1, history: [], chats: {}, usage: {} });
  assert.equal(badChats.ok, false);

  // usage 不是对象。
  const badUsage = await postImport({ version: 1, history: [], chats: [], usage: [] });
  assert.equal(badUsage.ok, false);
  assert.match(badUsage.message, /usage/);

  // settings 不是对象。
  const badSettings = await postImport({ version: 1, history: [], chats: [], usage: {}, settings: 'x' });
  assert.equal(badSettings.ok, false);

  // 顶层不是对象。
  const notObject = await postImport([1, 2, 3]);
  assert.equal(notObject.ok, false);

  // 以上全部失败后，磁盘上的四个文件一个字节都没变。
  assert.equal(readDataFileRaw('history'), before.history);
  assert.equal(readDataFileRaw('chats'), before.chats);
  assert.equal(readDataFileRaw('usage'), before.usage);
  assert.equal(readDataFileRaw('settings'), before.settings);
});

test('合并去重：同 id 不重复，settings 不被恢复', async () => {
  seedAll();
  const backup = await getExport();

  // 导入一份已存在的数据：新增 0 条。
  const again = await postImport(backup);
  assert.equal(again.ok, true);
  assert.deepEqual(again.imported, { history: 0, chats: 0 });
  assert.equal(readDataFile('history').length, 2);
  assert.equal(readDataFile('chats').length, 1);

  // 混合导入：一条已存在（保留原条目），一条新增。
  const mixed = {
    version: 1,
    exportedAt: new Date().toISOString(),
    history: [
      { id: 'gen-aaa', type: 'image', prompt: '被篡改的提示词', status: 'failed' },
      { id: 'gen-ccc', type: 'image', prompt: '新图', status: 'done' },
    ],
    chats: [],
    settings: { providers: { groq: { apiKey: 'evil-key-should-not-restore' } } },
    usage: SEED_USAGE,
  };
  const result = await postImport(mixed);
  assert.equal(result.ok, true);
  assert.deepEqual(result.imported, { history: 1, chats: 0 });

  const history = readDataFile('history');
  assert.equal(history.length, 3);
  // 已有 id 保留原条目（提示词未被覆盖）。
  assert.equal(history.find((e) => e.id === 'gen-aaa').prompt, '一只兔子');
  assert.ok(history.find((e) => e.id === 'gen-ccc'));

  // settings 完全忽略：磁盘上的 settings 没变，假 Key 没被写进去。
  const settings = readDataFile('settings');
  assert.equal(settings.providers.groq.apiKey, FAKE_GROQ_KEY);
  assert.ok(!JSON.stringify(settings).includes('evil-key-should-not-restore'));
});

test('usage 非法数值被清洗，未知键被丢弃', async () => {
  seedAll();
  const backup = {
    version: 1,
    exportedAt: new Date().toISOString(),
    history: [],
    chats: [],
    usage: {
      cloudflare: { date: '2026-11-19', usedNeurons: 'abc', byModel: { 'flux-1-schnell': 'xx', good: 50 } },
      kaggle: { weekStart: '2026-11-16', usedSeconds: null, jobs: 'nope' },
      elevenlabs: { characterCount: 'bad', characterLimit: 10000, updatedAt: '2026-11-19T00:00:00.000Z' },
      deepl: 'not-an-object',
      unknownKey: { x: 1 },
    },
  };
  const result = await postImport(backup);
  assert.equal(result.ok, true);

  const usage = readDataFile('usage');
  assert.equal(usage.cloudflare.usedNeurons, 0);
  assert.equal(usage.cloudflare.byModel['flux-1-schnell'], 0);
  assert.equal(usage.cloudflare.byModel.good, 50);
  assert.equal(usage.kaggle.usedSeconds, 0);
  assert.equal(usage.kaggle.jobs, 0);
  assert.equal(usage.elevenlabs.characterCount, 0);
  assert.equal(usage.elevenlabs.characterLimit, 10000);
  assert.equal(usage.deepl, null);
  assert.ok(!('unknownKey' in usage));
  assert.deepEqual(Object.keys(usage).sort(), ['cloudflare', 'deepl', 'elevenlabs', 'kaggle']);
});
