// test/wizard.test.js — 向导接口参数校验（POST /api/providers/:name/test）
//
// server.js 在 require 时就会 listen，所以这里用 child_process 把 server.js
// 作为子进程跑在临时端口 + 临时 DATA_DIR 上，用 fetch 发真实 HTTP 请求。
// 只测校验分支（未知供应商 / 缺必填字段 → 400），不测真实探测（不联网）。
// 测试结束杀掉子进程并清理临时目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { PROJECT_ROOT, makeTempDir, rmDir } = require('./helpers');

const SERVER_JS = path.join(PROJECT_ROOT, 'server.js');
const START_TIMEOUT_MS = 20000;

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

async function postTest(provider, body) {
  const res = await fetch(`${baseUrl}/api/providers/${encodeURIComponent(provider)}/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('未知供应商 → 400', async () => {
  const { status, json } = await postTest('not-a-provider', { apiKey: 'fake-key-xxx' });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /未知的供应商/);
});

test('groq 缺 apiKey → 400，且消息中文“请先填写…”', async () => {
  const { status, json } = await postTest('groq', {});
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /^请先填写/);
  assert.match(json.message, /API Key/);
});

test('groq 的 apiKey 只有空白字符 → 400（空白视为未填）', async () => {
  const { status, json } = await postTest('groq', { apiKey: '   ' });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /^请先填写/);
});

test('cloudflare 缺 accountId（只填 apiKey）→ 400', async () => {
  const { status, json } = await postTest('cloudflare', { apiKey: 'fake-key-xxx' });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /^请先填写/);
  assert.match(json.message, /Account ID/);
});

test('cloudflare 两个字段都缺 → 400，消息列出两项', async () => {
  const { status, json } = await postTest('cloudflare', {});
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /API Token/);
  assert.match(json.message, /Account ID/);
});

test('kaggle 缺用户名（只填 apiKey）→ 400', async () => {
  const { status, json } = await postTest('kaggle', { apiKey: 'fake-key-xxx' });
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /^请先填写/);
  assert.match(json.message, /用户名/);
});

test('deepl 缺 apiKey → 400', async () => {
  const { status, json } = await postTest('deepl', {});
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /^请先填写/);
});

test('zhipu 缺 apiKey → 400（改名后 zhipu 仍可被向导识别）', async () => {
  const { status, json } = await postTest('zhipu', {});
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /^请先填写/);
  assert.match(json.message, /API Key/);
});

test('instabox 缺 proxyUrl → 400，消息用“代理地址”', async () => {
  const { status, json } = await postTest('instabox', {});
  assert.equal(status, 400);
  assert.equal(json.ok, false);
  assert.match(json.message, /^请先填写/);
  assert.match(json.message, /代理地址/);
});

async function postSave(provider, body) {
  const res = await fetch(`${baseUrl}/api/providers/${encodeURIComponent(provider)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  return { status: res.status, json };
}

test('已保存凭据后：空输入测试不再 400，改用已保存的凭据测', async () => {
  // 先保存一个连不上的本地地址（connection refused，探测立即失败，不等超时）。
  const saved = await postSave('instabox', { proxyUrl: 'http://127.0.0.1:1' });
  assert.equal(saved.status, 200);
  assert.equal(saved.json.saved, true);
  // 空输入测试：不再 400，而是用已保存的地址做探测，返回 200 + ok:false。
  const { status, json } = await postTest('instabox', {});
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.equal(typeof json.message, 'string');
});

test('测试时请求体里的值优先于已保存的凭据', async () => {
  // 传一个格式错误的地址：如果用了已保存的 127.0.0.1:1，会是连接失败；
  // 用请求体的值则报格式错误——以此区分。
  const { status, json } = await postTest('instabox', { proxyUrl: 'not-a-url' });
  assert.equal(status, 200);
  assert.equal(json.ok, false);
  assert.match(json.message, /格式不正确/);
});
