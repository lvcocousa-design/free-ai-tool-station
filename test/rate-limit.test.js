// test/rate-limit.test.js — 按 IP 限流（lib/rate-limit.js）
//
// 分三层：
// 1. SlidingWindowCounter 纯逻辑单元测试（注入时间，不用等真实时间）。
// 2. 分级 / 配置解析 / 中间件单元测试（mock req/res，不起服务器；
//    每个用例先调 resetRateLimiter() 清计数器与配置缓存）。
// 3. 真实服务器集成测试（沿用 auth.test.js 的子进程模式，临时 DATA_DIR
//    + 小阈值环境变量，用 fetch 发真实 HTTP 请求；POST /api/chat 用空
//    body，只走到“消息内容不能为空”校验，不调上游，不联网）。
// 测试密码为假值 'test-password-123'，绝不用真实密码。

const test = require('node:test');
const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { PROJECT_ROOT, makeTempDir, rmDir, withEnv } = require('./helpers');
const rateLimitMod = require(path.join(PROJECT_ROOT, 'lib', 'rate-limit'));

const {
  SlidingWindowCounter,
  classifyRequest,
  getRateLimitConfig,
  describeRateLimit,
  getClientIp,
  rateLimit,
  resetRateLimiter,
} = rateLimitMod;

const FAKE_PASSWORD = 'test-password-123';
const SERVER_JS = path.join(PROJECT_ROOT, 'server.js');
const START_TIMEOUT_MS = 20000;

// ---------- 1. SlidingWindowCounter 纯逻辑 ----------

test('窗口计数：上限内放行，超限拒绝并给出 Retry-After 秒数', () => {
  const counter = new SlidingWindowCounter({ windowMs: 60000 });
  assert.deepEqual(counter.check('1.2.3.4', 2, 1000), { allowed: true, retryAfterSeconds: 0 });
  assert.deepEqual(counter.check('1.2.3.4', 2, 1500), { allowed: true, retryAfterSeconds: 0 });
  // 第三次超限：最早一条在 t=1000，到 t=2000 时还需等 (1000+60000-2000)/1000=59 秒。
  assert.deepEqual(counter.check('1.2.3.4', 2, 2000), { allowed: false, retryAfterSeconds: 59 });
  // 被拒绝的请求不占计数：窗口滑过后仍能放行。
  assert.deepEqual(counter.check('1.2.3.4', 2, 61000), { allowed: true, retryAfterSeconds: 0 });
});

test('窗口计数：滑动过期——旧时间戳滑出窗口后配额恢复', () => {
  const counter = new SlidingWindowCounter({ windowMs: 60000 });
  assert.equal(counter.check('ip-a', 1, 0).allowed, true);
  assert.equal(counter.check('ip-a', 1, 59999).allowed, false);
  // t=60000 时 t=0 的记录恰好满一分钟，已过期，可再放行。
  assert.equal(counter.check('ip-a', 1, 60000).allowed, true);
});

test('窗口计数：不同 key 的配额互不影响', () => {
  const counter = new SlidingWindowCounter({ windowMs: 60000 });
  assert.equal(counter.check('ip-a', 1, 1000).allowed, true);
  assert.equal(counter.check('ip-a', 1, 1000).allowed, false);
  assert.equal(counter.check('ip-b', 1, 1000).allowed, true);
});

test('窗口计数：reset() 清空全部计数', () => {
  const counter = new SlidingWindowCounter({ windowMs: 60000 });
  assert.equal(counter.check('ip-a', 1, 1000).allowed, true);
  assert.equal(counter.check('ip-a', 1, 1000).allowed, false);
  assert.equal(counter.size, 1);
  counter.reset();
  assert.equal(counter.size, 0);
  assert.equal(counter.check('ip-a', 1, 1000).allowed, true);
});

test('窗口计数：count/record/delete/retryAfterSeconds（登录失败计数用）', () => {
  const counter = new SlidingWindowCounter({ windowMs: 60000 });
  assert.equal(counter.count('ip-a', 1000), 0);
  assert.equal(counter.retryAfterSeconds('ip-a', 1000), 0);
  counter.record('ip-a', 1000);
  counter.record('ip-a', 2000);
  assert.equal(counter.count('ip-a', 3000), 2);
  // 窗口内最早一条在 t=1000，到 t=3000 时还需等 (1000+60000-3000)/1000=58 秒。
  assert.equal(counter.retryAfterSeconds('ip-a', 3000), 58);
  // 旧记录滑出窗口后计数归零。
  assert.equal(counter.count('ip-a', 62000), 0);
  assert.equal(counter.retryAfterSeconds('ip-a', 62000), 0);
  counter.record('ip-a', 62000);
  assert.equal(counter.count('ip-a', 62000), 1);
  counter.delete('ip-a');
  assert.equal(counter.count('ip-a', 62000), 0);
});

// ---------- 2a. 分级 ----------

test('分级：10 个重操作 POST + 供应商连通性测试都算 heavy', () => {
  const heavyPaths = [
    '/api/generate', '/api/video', '/api/chat', '/api/analyze',
    '/api/translate', '/api/tts', '/api/stt', '/api/embed', '/api/backup/import',
    '/api/totp/confirm',
  ];
  for (const p of heavyPaths) {
    assert.equal(classifyRequest('POST', p), 'heavy', p);
  }
  assert.equal(classifyRequest('POST', '/api/providers/groq/test'), 'heavy');
  assert.equal(classifyRequest('POST', '/api/providers/cloudflare/test'), 'heavy');
});

test('分级：GET 接口、删除会话、保存凭据都算 query', () => {
  for (const p of ['/api/providers', '/api/history', '/api/models', '/api/usage',
    '/api/status', '/api/chats', '/api/chats/abc', '/api/generations/abc',
    '/api/backup/export', '/api/auth/status']) {
    assert.equal(classifyRequest('GET', p), 'query', p);
  }
  assert.equal(classifyRequest('DELETE', '/api/chats/abc'), 'query');
  // 只存凭据不调上游：POST /api/providers/:name 是 query，不是 heavy。
  assert.equal(classifyRequest('POST', '/api/providers/groq'), 'query');
  // 未知 /api/* 路径也按 query 计（防 404 扫描）。
  assert.equal(classifyRequest('GET', '/api/does-not-exist'), 'query');
  assert.equal(classifyRequest('POST', '/api/does-not-exist'), 'query');
});

test('分级：只有 GET /api/health 与 POST /api/login 豁免', () => {
  assert.equal(classifyRequest('GET', '/api/health'), 'exempt');
  assert.equal(classifyRequest('POST', '/api/login'), 'exempt');
  // 方法不对不豁免。
  assert.equal(classifyRequest('POST', '/api/health'), 'query');
  assert.equal(classifyRequest('GET', '/api/login'), 'query');
});

test('分级：非 /api/* 路径返回 null（不限流）', () => {
  assert.equal(classifyRequest('GET', '/'), null);
  assert.equal(classifyRequest('GET', '/index.html'), null);
  assert.equal(classifyRequest('GET', '/blobs/abc.png'), null);
  assert.equal(classifyRequest('GET', '/api'), null);
});

test('getClientIp：优先 req.ip，其次 socket.remoteAddress，最后 unknown', () => {
  assert.equal(getClientIp({ ip: '1.2.3.4' }), '1.2.3.4');
  assert.equal(getClientIp({ socket: { remoteAddress: '5.6.7.8' } }), '5.6.7.8');
  assert.equal(getClientIp({}), 'unknown');
  assert.equal(getClientIp(null), 'unknown');
});

// ---------- 2b. 配置解析 ----------

/** 捕获 console.warn 的输出，测试结束自动恢复；返回收集到的消息数组。 */
function captureWarn(t) {
  const messages = [];
  const original = console.warn;
  console.warn = (...args) => { messages.push(args.join(' ')); };
  t.after(() => { console.warn = original; });
  return messages;
}

test('配置：默认阈值 heavy 60、query 300', (t) => {
  withEnv(t, { RATE_LIMIT_PER_MINUTE: undefined, RATE_LIMIT_QUERY_PER_MINUTE: undefined });
  resetRateLimiter();
  assert.deepEqual(getRateLimitConfig(), { heavyPerMinute: 60, queryPerMinute: 300 });
  assert.match(describeRateLimit(), /已启用/);
  assert.match(describeRateLimit(), /生成类 60 次\/分钟\/IP/);
  assert.match(describeRateLimit(), /查询类 300 次\/分钟\/IP/);
});

test('配置：环境变量可调阈值', (t) => {
  withEnv(t, { RATE_LIMIT_PER_MINUTE: '5', RATE_LIMIT_QUERY_PER_MINUTE: '7' });
  resetRateLimiter();
  assert.deepEqual(getRateLimitConfig(), { heavyPerMinute: 5, queryPerMinute: 7 });
});

test('配置：设为 0 关闭对应一级限流，两级都为 0 则整体关闭', (t) => {
  withEnv(t, { RATE_LIMIT_PER_MINUTE: '0', RATE_LIMIT_QUERY_PER_MINUTE: '0' });
  resetRateLimiter();
  assert.deepEqual(getRateLimitConfig(), { heavyPerMinute: 0, queryPerMinute: 0 });
  assert.equal(describeRateLimit(), '已关闭');

  withEnv(t, { RATE_LIMIT_PER_MINUTE: '0', RATE_LIMIT_QUERY_PER_MINUTE: '300' });
  resetRateLimiter();
  assert.match(describeRateLimit(), /生成类不限流/);
  assert.match(describeRateLimit(), /查询类 300 次\/分钟\/IP/);
});

test('配置：非法值回落到默认值并记一条 warn 日志', (t) => {
  const warnings = captureWarn(t);
  withEnv(t, { RATE_LIMIT_PER_MINUTE: 'abc', RATE_LIMIT_QUERY_PER_MINUTE: '-5' });
  resetRateLimiter();
  assert.deepEqual(getRateLimitConfig(), { heavyPerMinute: 60, queryPerMinute: 300 });
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /RATE_LIMIT_PER_MINUTE/);
  assert.match(warnings[1], /RATE_LIMIT_QUERY_PER_MINUTE/);
});

test('配置：小数、带空格的非法值同样回落；纯数字前后空格可接受', (t) => {
  const warnings = captureWarn(t);
  withEnv(t, { RATE_LIMIT_PER_MINUTE: '60.5', RATE_LIMIT_QUERY_PER_MINUTE: ' 42 ' });
  resetRateLimiter();
  assert.deepEqual(getRateLimitConfig(), { heavyPerMinute: 60, queryPerMinute: 42 });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /RATE_LIMIT_PER_MINUTE/);
});

test('配置：非法值只在首次出现时 warn 一次，不在每个请求重复刷日志', (t) => {
  const warnings = captureWarn(t);
  withEnv(t, { RATE_LIMIT_PER_MINUTE: 'not-a-number', RATE_LIMIT_QUERY_PER_MINUTE: undefined });
  resetRateLimiter();
  getRateLimitConfig();
  getRateLimitConfig();
  getRateLimitConfig();
  assert.equal(warnings.length, 1);
});

// ---------- 2c. 中间件（mock req/res） ----------

/** 最小 mock res：实现 rateLimit 用到的 set() / status().json()。 */
function mockRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.set = (name, value) => { res.headers[name] = value; return res; };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

function mockReq(method, path, ip = '10.0.0.1') {
  return { method, path, ip };
}

/** 调一次中间件，返回 { nextCalled, res }。 */
function runMiddleware(method, path, ip) {
  const res = mockRes();
  let nextCalled = false;
  rateLimit(mockReq(method, path, ip), res, () => { nextCalled = true; });
  return { nextCalled, res };
}

test('中间件：豁免接口（health、login）与非 /api 路径不限流', (t) => {
  withEnv(t, { RATE_LIMIT_PER_MINUTE: '1', RATE_LIMIT_QUERY_PER_MINUTE: '1' });
  resetRateLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(runMiddleware('GET', '/api/health').nextCalled, true);
    assert.equal(runMiddleware('POST', '/api/login').nextCalled, true);
    assert.equal(runMiddleware('GET', '/').nextCalled, true);
    assert.equal(runMiddleware('GET', '/blobs/abc.png').nextCalled, true);
  }
});

test('中间件：重操作超限返回 429，响应体为统一格式并带 Retry-After 头', (t) => {
  withEnv(t, { RATE_LIMIT_PER_MINUTE: '2', RATE_LIMIT_QUERY_PER_MINUTE: '300' });
  resetRateLimiter();
  assert.equal(runMiddleware('POST', '/api/chat').nextCalled, true);
  assert.equal(runMiddleware('POST', '/api/generate').nextCalled, true);
  // 同一 IP 的重操作共用配额：第三次（换个重操作接口也一样）被拒。
  const { nextCalled, res } = runMiddleware('POST', '/api/video');
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 429);
  assert.deepEqual(res.body, { ok: false, message: '请求过于频繁，请稍后再试' });
  assert.ok(res.headers['Retry-After']);
  assert.ok(Number(res.headers['Retry-After']) >= 1);
});

test('中间件：两级配额互不占用；不同 IP 互不影响', (t) => {
  withEnv(t, { RATE_LIMIT_PER_MINUTE: '1', RATE_LIMIT_QUERY_PER_MINUTE: '1' });
  resetRateLimiter();
  // IP-A 的重操作用满后，查询类仍可通过。
  assert.equal(runMiddleware('POST', '/api/chat', '10.0.0.1').nextCalled, true);
  assert.equal(runMiddleware('POST', '/api/chat', '10.0.0.1').nextCalled, false);
  assert.equal(runMiddleware('GET', '/api/providers', '10.0.0.1').nextCalled, true);
  assert.equal(runMiddleware('GET', '/api/providers', '10.0.0.1').nextCalled, false);
  // 另一 IP 不受影响。
  assert.equal(runMiddleware('POST', '/api/chat', '10.0.0.2').nextCalled, true);
  assert.equal(runMiddleware('GET', '/api/providers', '10.0.0.2').nextCalled, true);
});

test('中间件：阈值为 0 时对应级别不限流', (t) => {
  withEnv(t, { RATE_LIMIT_PER_MINUTE: '0', RATE_LIMIT_QUERY_PER_MINUTE: '1' });
  resetRateLimiter();
  for (let i = 0; i < 5; i++) {
    assert.equal(runMiddleware('POST', '/api/chat').nextCalled, true);
  }
  // 查询类仍受限。
  assert.equal(runMiddleware('GET', '/api/providers').nextCalled, true);
  assert.equal(runMiddleware('GET', '/api/providers').nextCalled, false);
});

// ---------- 3. 真实服务器集成测试 ----------

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

/** 起一台子进程服务器；返回 { baseUrl, output(), stop }。 */
async function startServer(extraEnv) {
  const dataDir = makeTempDir(null);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let childOutput = '';
  const env = { ...process.env, PORT: String(port), DATA_DIR: dataDir };
  for (const [key, value] of Object.entries(extraEnv)) {
    if (value === undefined) delete env[key];
    else env[key] = value;
  }
  const child = spawn(process.execPath, [SERVER_JS], {
    cwd: PROJECT_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => { childOutput += chunk.toString(); });
  child.stderr.on('data', (chunk) => { childOutput += chunk.toString(); });

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

  async function stop() {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      const exited = await Promise.race([
        new Promise((resolve) => child.once('exit', () => resolve(true))),
        new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!exited) child.kill('SIGKILL');
    }
    rmDir(dataDir);
  }
  return { baseUrl, output: () => childOutput, stop };
}

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

describe('小阈值服务器（heavy 3 / query 5，无密码）', () => {
  let server;
  before(async () => {
    server = await startServer({
      ACCESS_PASSWORD: undefined,
      RATE_LIMIT_PER_MINUTE: '3',
      RATE_LIMIT_QUERY_PER_MINUTE: '5',
    });
  });
  after(async () => { await server.stop(); });

  test('启动日志打印限流状态（含两级阈值）', () => {
    assert.match(server.output(), /\[server\] 限流：已启用（生成类 3 次\/分钟\/IP，查询类 5 次\/分钟\/IP）/);
  });

  test('GET /api/health 不限流：连续 10 次都 200', async () => {
    for (let i = 0; i < 10; i++) {
      const res = await fetch(`${server.baseUrl}/api/health`);
      assert.equal(res.status, 200, `第 ${i + 1} 次健康检查应 200`);
    }
  });

  test('POST /api/login 不限流：连续 8 次都 200（超过两级阈值）', async () => {
    for (let i = 0; i < 8; i++) {
      const res = await fetch(`${server.baseUrl}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200, `第 ${i + 1} 次登录应 200`);
    }
  });

  test('重操作超限：第 4 次 POST /api/chat 返回 429 并带 Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      // 空 body 只走到“消息内容不能为空”校验，不调上游。
      assert.equal(res.status, 200, `第 ${i + 1} 次应放行`);
      assert.equal((await res.json()).message, '消息内容不能为空');
    }
    const res = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { ok: false, message: '请求过于频繁，请稍后再试' });
    const retryAfter = Number(res.headers.get('retry-after'));
    assert.ok(Number.isInteger(retryAfter) && retryAfter >= 1, '应带 Retry-After 头（>=1 秒）');
  });

  // 注意：本用例放在最后——它会用满查询类配额。
  test('查询类超限：第 6 次 GET /api/providers 返回 429', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${server.baseUrl}/api/providers`);
      assert.equal(res.status, 200, `第 ${i + 1} 次应放行`);
    }
    const res = await fetch(`${server.baseUrl}/api/providers`);
    assert.equal(res.status, 429);
    assert.deepEqual(await res.json(), { ok: false, message: '请求过于频繁，请稍后再试' });
  });
});

describe('设密码的服务器：未登录的 401 不占用限流配额', () => {
  let server;
  before(async () => {
    server = await startServer({
      ACCESS_PASSWORD: FAKE_PASSWORD,
      RATE_LIMIT_PER_MINUTE: '2',
      RATE_LIMIT_QUERY_PER_MINUTE: '300',
    });
  });
  after(async () => { await server.stop(); });

  test('5 次未登录请求都 401，登录后仍有完整配额（2 次放行，第 3 次 429）', async () => {
    for (let i = 0; i < 5; i++) {
      const res = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 401, `第 ${i + 1} 次未登录请求应 401 而非 429`);
    }

    const loginRes = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: FAKE_PASSWORD }),
    });
    assert.equal(loginRes.status, 200);
    const cookie = getSetCookies(loginRes).find((c) => c.startsWith('auth_token='));
    assert.ok(cookie, '登录成功应下发 auth_token cookie');
    const cookieHeader = cookie.split(';')[0];

    for (let i = 0; i < 2; i++) {
      const res = await fetch(`${server.baseUrl}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200, `登录后第 ${i + 1} 次应放行（401 未占配额）`);
    }
    const limited = await fetch(`${server.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({}),
    });
    assert.equal(limited.status, 429);
  });
});
