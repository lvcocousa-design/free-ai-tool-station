// test/quota-routes.test.js — 用量上限的路由级拦截（spawn 真服务器）
//
// 每个用例启动一个独立服务器（临时端口 + 临时 DATA_DIR，预置
// settings.json / usage.json，凭据均为假值——拦截发生在调上游之前，
// 所以用例不联网）。测试结束杀掉子进程并清理临时目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const {
  PROJECT_ROOT, makeTempDir, rmDir, todayUTC, mondayUTC,
} = require('./helpers');

const SERVER_JS = path.join(PROJECT_ROOT, 'server.js');
const START_TIMEOUT_MS = 20000;

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

function currentMonthUTC() {
  return new Date().toISOString().slice(0, 7);
}

function baseUsage(patch = {}) {
  return {
    cloudflare: { date: todayUTC(), usedNeurons: 0, byModel: {} },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 0, jobs: 0 },
    groq: { date: todayUTC(), byModel: {} },
    requests: { month: currentMonthUTC(), count: 0 },
    elevenlabs: null,
    deepl: null,
    ...patch,
  };
}

/**
 * 启动一个带预置状态的服务器。返回 { baseUrl, stop }。
 * @param {object} t - TestContext（自动注册清理）
 * @param {object} opts - { env, settings, usage }
 */
async function startServer(t, { env = {}, settings = {}, usage = null } = {}) {
  const dir = makeTempDir(t);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings), 'utf8');
  if (usage) {
    fs.writeFileSync(path.join(dir, 'usage.json'), JSON.stringify(usage), 'utf8');
  }
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let childOutput = '';
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PORT: String(port), DATA_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });
  const stop = async () => {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!exited) child.kill('SIGKILL');
    }
  };
  t.after(stop);

  // 等服务器就绪（只轮询 /api/health，该路径不计入每月请求数）。
  const deadline = Date.now() + START_TIMEOUT_MS;
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`服务器子进程提前退出（exitCode=${child.exitCode}），输出：\n${childOutput.slice(-2000)}`);
    }
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) break;
    } catch (_) { /* 还没起来，继续等 */ }
    if (Date.now() > deadline) {
      throw new Error(`服务器 ${START_TIMEOUT_MS}ms 内未就绪，输出：\n${childOutput.slice(-2000)}`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return { baseUrl, stop };
}

async function postJson(baseUrl, urlPath, body) {
  const res = await fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

test('Kaggle 用量耗尽时 /api/generate（kaggle 后端）返回 429 且 quotaExceeded 为 true', async (t) => {
  const { baseUrl } = await startServer(t, {
    settings: { providers: { kaggle: { username: 'fake-user', apiKey: 'fake-key' } } },
    usage: baseUsage({
      kaggle: { weekStart: mondayUTC(), usedSeconds: 108000, jobs: 5 },
    }),
  });
  const { status, body } = await postJson(baseUrl, '/api/generate', {
    backend: 'kaggle',
    prompt: '一只兔子',
  });
  assert.equal(status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.quotaExceeded, true);
  assert.match(body.message, /Kaggle/);
});

test('请求数到上限时 /api/status 返回 429，但 /api/health 仍 200', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { QUOTA_MONTHLY_REQUESTS: '10' },
    usage: baseUsage({
      requests: { month: currentMonthUTC(), count: 10 },
    }),
  });
  const statusRes = await fetch(`${baseUrl}/api/status`);
  assert.equal(statusRes.status, 429);
  const statusBody = await statusRes.json();
  assert.equal(statusBody.ok, false);
  assert.equal(statusBody.quotaExceeded, true);
  assert.match(statusBody.message, /本月请求数已达上限/);
  // 豁免路径不受影响
  const healthRes = await fetch(`${baseUrl}/api/health`);
  assert.equal(healthRes.status, 200);
  const usageRes = await fetch(`${baseUrl}/api/usage`);
  assert.equal(usageRes.status, 200);
});

test('Groq 某模型 tokens 耗尽时 /api/chat（该模型）返回 429', async (t) => {
  const model = 'openai/gpt-oss-120b';
  const { baseUrl } = await startServer(t, {
    settings: { providers: { groq: { apiKey: 'fake-groq-key' } } },
    usage: baseUsage({
      groq: { date: todayUTC(), byModel: { [model]: { tokens: 200000, requests: 1 } } },
    }),
  });
  const { status, body } = await postJson(baseUrl, '/api/chat', {
    provider: 'groq',
    model,
    content: '你好',
  });
  assert.equal(status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.quotaExceeded, true);
  assert.match(body.message, /Groq/);
  assert.match(body.message, /tokens/);
});

test('存储用量超限时 /api/generate 返回 429（QUOTA_STORAGE_BYTES 设得很小）', async (t) => {
  const { baseUrl } = await startServer(t, {
    env: { QUOTA_STORAGE_BYTES: '100' }, // 预置的 settings/usage 文件本身就超 100 字节
    settings: { providers: { kaggle: { username: 'fake-user', apiKey: 'fake-key' } } },
    usage: baseUsage(),
  });
  const { status, body } = await postJson(baseUrl, '/api/generate', {
    backend: 'kaggle',
    prompt: '一只兔子',
  });
  assert.equal(status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.quotaExceeded, true);
  assert.match(body.message, /存储空间已达上限/);
});

test('Cloudflare 当日 Neurons 到顶时 /api/embed 返回 429', async (t) => {
  const { baseUrl } = await startServer(t, {
    settings: { providers: { cloudflare: { accountId: 'fake-account', apiKey: 'fake-token' } } },
    usage: baseUsage({
      cloudflare: { date: todayUTC(), usedNeurons: 9000, byModel: {} },
    }),
  });
  const { status, body } = await postJson(baseUrl, '/api/embed', {
    provider: 'cloudflare',
    text1: '你好',
    text2: '您好',
  });
  assert.equal(status, 429);
  assert.equal(body.ok, false);
  assert.equal(body.quotaExceeded, true);
  assert.match(body.message, /Cloudflare/);
});

test('/api/usage 返回 groq、requests 与 storage 字段', async (t) => {
  const { baseUrl } = await startServer(t, {
    usage: baseUsage({
      groq: { date: todayUTC(), byModel: { 'fake-model': { tokens: 123, requests: 2 } } },
      requests: { month: currentMonthUTC(), count: 7 },
    }),
  });
  const res = await fetch(`${baseUrl}/api/usage`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.deepEqual(body.groq.byModel['fake-model'], { tokens: 123, requests: 2 });
  assert.equal(body.requests.count, 7);
  assert.equal(body.requests.limit, 1500000);
  assert.equal(typeof body.storage.bytes, 'number');
  assert.equal(body.storage.limit, 8 * 1024 * 1024 * 1024);
});
