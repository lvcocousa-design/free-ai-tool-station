// test/auth.test.js — 访问密码保护（ACCESS_PASSWORD）
//
// 分两层：
// 1. lib/auth.js 直接单元测试（密码比对、token 签发/校验、中间件放行/拦截；
//    auth.js 每次调用都读环境变量，无需清 require 缓存）。
// 2. 真实服务器集成测试：沿用 wizard.test.js 的子进程模式，分别起一台
//    未设密码的服务和一台设了密码的服务，用 fetch 发真实 HTTP 请求。
// 测试密码均为假值 'test-password-123'，绝不用真实密码。

const test = require('node:test');
const { describe, before, after } = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { spawn } = require('child_process');
const path = require('path');
const { PROJECT_ROOT, makeTempDir, rmDir, withEnv } = require('./helpers');
const auth = require(path.join(PROJECT_ROOT, 'lib', 'auth'));
const totpLib = require(path.join(PROJECT_ROOT, 'lib', 'totp'));

const FAKE_PASSWORD = 'test-password-123';
const WRONG_PASSWORD = 'wrong-password-456';
const SERVER_JS = path.join(PROJECT_ROOT, 'server.js');
const START_TIMEOUT_MS = 20000;

// ---------- 1. lib/auth.js 直接单元测试 ----------

test('未设密码：isAuthEnabled() 为 false，requireAuth 直接放行', (t) => {
  withEnv(t, { ACCESS_PASSWORD: undefined });
  assert.equal(auth.isAuthEnabled(), false);
  let nextCalled = false;
  auth.requireAuth({ path: '/api/providers', headers: {} }, mockRes(), () => { nextCalled = true; });
  assert.equal(nextCalled, true);
});

test('密码为空字符串：同样视为未启用', (t) => {
  withEnv(t, { ACCESS_PASSWORD: '' });
  assert.equal(auth.isAuthEnabled(), false);
});

test('设密码后：verifyPassword 正确 true、错误 false、非字符串 false', (t) => {
  withEnv(t, { ACCESS_PASSWORD: FAKE_PASSWORD });
  assert.equal(auth.verifyPassword(FAKE_PASSWORD), true);
  assert.equal(auth.verifyPassword(WRONG_PASSWORD), false);
  assert.equal(auth.verifyPassword(''), false);
  assert.equal(auth.verifyPassword(undefined), false);
  assert.equal(auth.verifyPassword(123), false);
});

test('token：issueToken 签发的有效，伪造的被拒', () => {
  const token = auth.issueToken();
  assert.equal(typeof token, 'string');
  assert.ok(token.length >= 32);
  assert.equal(auth.isValidToken(token), true);
  assert.equal(auth.isValidToken('forged-token-xyz'), false);
  assert.equal(auth.isValidToken(''), false);
  assert.equal(auth.isValidToken(undefined), false);
});

test('getTokenFromRequest：从 Cookie 头解析 auth_token', () => {
  const token = auth.issueToken();
  assert.equal(
    auth.getTokenFromRequest({ headers: { cookie: `other=1; auth_token=${token}; x=2` } }),
    token,
  );
  assert.equal(auth.getTokenFromRequest({ headers: {} }), null);
  assert.equal(auth.getTokenFromRequest({ headers: { cookie: 'other=1' } }), null);
});

test('requireAuth：设密码后无 cookie 请求 /api/* 被 401，带有效 token 放行', (t) => {
  withEnv(t, { ACCESS_PASSWORD: FAKE_PASSWORD });
  const res = mockRes();
  let nextCalled = false;
  auth.requireAuth({ path: '/api/providers', headers: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
  assert.equal(res.body.ok, false);

  const token = auth.issueToken();
  nextCalled = false;
  auth.requireAuth(
    { path: '/api/providers', headers: { cookie: `auth_token=${token}` } },
    mockRes(),
    () => { nextCalled = true; },
  );
  assert.equal(nextCalled, true);
});

test('requireAuth：/api/login、/api/health、/api/auth/status 与静态路径不设防', (t) => {
  withEnv(t, { ACCESS_PASSWORD: FAKE_PASSWORD });
  for (const p of ['/api/login', '/api/health', '/api/auth/status', '/', '/index.html', '/app.js']) {
    let nextCalled = false;
    auth.requireAuth({ path: p, headers: {} }, mockRes(), () => { nextCalled = true; });
    assert.equal(nextCalled, true, `${p} 应直接放行`);
  }
  // /blobs 需要登录
  let nextCalled = false;
  const res = mockRes();
  auth.requireAuth({ path: '/blobs/abc.png', headers: {} }, res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 401);
});

test('buildAuthCookie：httpOnly + Secure，不含密码本身', () => {
  const cookie = auth.buildAuthCookie('some-token-value');
  assert.match(cookie, /^auth_token=some-token-value;/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Path=\//);
  assert.doesNotMatch(cookie, new RegExp(FAKE_PASSWORD));
});

/** 最小 mock res：只实现 requireAuth 用到的 status().json()。 */
function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
}

// ---------- 2. 真实服务器集成测试 ----------

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

/** 起一台子进程服务器；返回 { baseUrl, stop }。 */
async function startServer(extraEnv) {
  const dataDir = makeTempDir(null);
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let childOutput = '';
  // extraEnv 里值为 undefined 表示删除该变量（spawn 的 env 不接受 undefined 值）。
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
  return { baseUrl, stop };
}

function getSetCookies(res) {
  if (typeof res.headers.getSetCookie === 'function') return res.headers.getSetCookie();
  const single = res.headers.get('set-cookie');
  return single ? [single] : [];
}

describe('未设 ACCESS_PASSWORD（公开访问）', () => {
  let server;
  before(async () => {
    server = await startServer({ ACCESS_PASSWORD: undefined });
  });
  after(async () => { await server.stop(); });

  test('GET /api/providers 直接 200，不要求登录', async () => {
    const res = await fetch(`${server.baseUrl}/api/providers`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.ok(Array.isArray(json.providers));
  });

  test('GET /api/auth/status 返回 authRequired=false, authenticated=true', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authRequired: false, authenticated: true, totpEnabled: false });
  });

  test('GET /api/health 200', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);
  });
});

describe('设置 ACCESS_PASSWORD 后', () => {
  let server;
  before(async () => {
    server = await startServer({ ACCESS_PASSWORD: FAKE_PASSWORD });
  });
  after(async () => { await server.stop(); });

  async function login(password) {
    const res = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return { res, json: await res.json() };
  }

  /** 登录成功并返回可用的 Cookie 头值（如 'auth_token=...'）。 */
  async function loginCookie() {
    const { res, json } = await login(FAKE_PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    const cookies = getSetCookies(res);
    const authCookie = cookies.find((c) => c.startsWith('auth_token='));
    assert.ok(authCookie, '登录成功应下发 auth_token cookie');
    return authCookie.split(';')[0];
  }

  test('GET /api/health 不设防，仍 200', async () => {
    const res = await fetch(`${server.baseUrl}/api/health`);
    assert.equal(res.status, 200);
  });

  test('静态前端不设防：GET / 200（登录页由前端决定是否显示）', async () => {
    const res = await fetch(`${server.baseUrl}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /loginOverlay/);
  });

  test('未登录：GET /api/auth/status 返回 authRequired=true, authenticated=false', async () => {
    const res = await fetch(`${server.baseUrl}/api/auth/status`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { authRequired: true, authenticated: false, totpEnabled: false });
  });

  test('未登录：GET /api/providers 返回 401', async () => {
    const res = await fetch(`${server.baseUrl}/api/providers`);
    assert.equal(res.status, 401);
    const json = await res.json();
    assert.equal(json.ok, false);
  });

  test('未登录：GET /blobs/xxx 返回 401（先于 404）', async () => {
    const res = await fetch(`${server.baseUrl}/blobs/does-not-exist.png`);
    assert.equal(res.status, 401);
  });

  test('错误密码登录：401，消息为“密码不正确”，不下发 cookie', async () => {
    const { res, json } = await login(WRONG_PASSWORD);
    assert.equal(res.status, 401);
    assert.equal(json.ok, false);
    assert.equal(json.message, '密码不正确');
    assert.equal(getSetCookies(res).length, 0);
  });

  test('正确密码登录：200，下发 httpOnly 的 auth_token cookie', async () => {
    const { res, json } = await login(FAKE_PASSWORD);
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    const cookies = getSetCookies(res);
    const authCookie = cookies.find((c) => c.startsWith('auth_token='));
    assert.ok(authCookie);
    assert.match(authCookie, /HttpOnly/);
    assert.doesNotMatch(authCookie, new RegExp(FAKE_PASSWORD));
  });

  test('带有效 cookie：GET /api/providers 200，状态接口 authenticated=true', async () => {
    const cookie = await loginCookie();
    const res = await fetch(`${server.baseUrl}/api/providers`, {
      headers: { Cookie: cookie },
    });
    assert.equal(res.status, 200);
    const statusRes = await fetch(`${server.baseUrl}/api/auth/status`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual(await statusRes.json(), { authRequired: true, authenticated: true, totpEnabled: false });
  });

  test('伪造 token 的 cookie：GET /api/providers 仍 401', async () => {
    const res = await fetch(`${server.baseUrl}/api/providers`, {
      headers: { Cookie: 'auth_token=forged-token-xyz' },
    });
    assert.equal(res.status, 401);
  });
});

describe('登录限流（LOGIN_MAX_ATTEMPTS=3）', () => {
  let server;
  before(async () => {
    server = await startServer({ ACCESS_PASSWORD: FAKE_PASSWORD, LOGIN_MAX_ATTEMPTS: '3' });
  });
  after(async () => { await server.stop(); });

  async function login(password) {
    const res = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return { res, json: await res.json() };
  }

  test('3 次失败后第 4 次返回 429，带 Retry-After', async () => {
    for (let i = 0; i < 3; i++) {
      const { res, json } = await login(WRONG_PASSWORD);
      assert.equal(res.status, 401);
      assert.equal(json.message, '密码不正确');
    }
    const { res, json } = await login(WRONG_PASSWORD);
    assert.equal(res.status, 429);
    assert.equal(json.ok, false);
    assert.match(json.message, /过于频繁/);
    assert.ok(res.headers.get('Retry-After'), '429 应带 Retry-After 头');
  });
});

describe('登录成功清掉失败计数', () => {
  let server;
  before(async () => {
    server = await startServer({ ACCESS_PASSWORD: FAKE_PASSWORD, LOGIN_MAX_ATTEMPTS: '3' });
  });
  after(async () => { await server.stop(); });

  async function login(password) {
    const res = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    return { res, json: await res.json() };
  }

  test('2 次失败后登录成功，再错 3 次仍是 401（计数已清零）', async () => {
    for (let i = 0; i < 2; i++) {
      const { res } = await login(WRONG_PASSWORD);
      assert.equal(res.status, 401);
    }
    const ok = await login(FAKE_PASSWORD);
    assert.equal(ok.res.status, 200);
    for (let i = 0; i < 3; i++) {
      const { res } = await login(WRONG_PASSWORD);
      assert.equal(res.status, 401);
    }
    const { res } = await login(WRONG_PASSWORD);
    assert.equal(res.status, 429);
  });
});

describe('TOTP 二次验证（完整流程）', () => {
  let server;
  let secret = '';
  let backupCodes = [];
  before(async () => {
    server = await startServer({ ACCESS_PASSWORD: FAKE_PASSWORD });
  });
  after(async () => { await server.stop(); });

  async function login(password, totpCode) {
    const body = { password };
    if (totpCode !== undefined) body.totpCode = totpCode;
    const res = await fetch(`${server.baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { res, json: await res.json() };
  }

  async function loginCookie(totpCode) {
    const { res, json } = await login(FAKE_PASSWORD, totpCode);
    assert.equal(res.status, 200, `登录应成功，实际：${JSON.stringify(json)}`);
    const cookies = getSetCookies(res);
    const authCookie = cookies.find((c) => c.startsWith('auth_token='));
    assert.ok(authCookie, '登录成功应下发 auth_token cookie');
    return authCookie.split(';')[0];
  }

  async function totpApi(pathName, body, cookie) {
    const res = await fetch(`${server.baseUrl}${pathName}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { res, json: await res.json() };
  }

  test('未开启时状态 totpEnabled=false，登录无需动态码', async () => {
    const cookie = await loginCookie();
    const { res, json } = await totpApi('/api/totp/status', undefined, cookie);
    assert.equal(res.status, 200);
    assert.equal(json.totpEnabled, false);
    assert.equal(json.authEnabled, true);
    assert.equal(json.backupCodesRemaining, 0);
  });

  test('setup 返回密钥与 otpauth 链接；错误动态码确认失败', async () => {
    const cookie = await loginCookie();
    const { res, json } = await totpApi('/api/totp/setup', {}, cookie);
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.match(json.secret, /^[A-Z2-7]{32}$/);
    assert.ok(json.otpauthUrl.startsWith('otpauth://totp/'));
    secret = json.secret;
    const wrong = await totpApi('/api/totp/confirm', { secret, code: '000000' }, cookie);
    assert.equal(wrong.res.status, 401);
    assert.equal(wrong.json.message, '动态码不正确，请核对验证器里的 6 位码');
  });

  test('正确动态码确认成功，返回 8 个备用码；状态变为已开启', async () => {
    const cookie = await loginCookie();
    const code = totpLib.generateCode(secret);
    const { res, json } = await totpApi('/api/totp/confirm', { secret, code }, cookie);
    assert.equal(res.status, 200);
    assert.equal(json.ok, true);
    assert.equal(json.backupCodes.length, 8);
    backupCodes = json.backupCodes;
    const status = await totpApi('/api/totp/status', undefined, cookie);
    assert.equal(status.json.totpEnabled, true);
    assert.equal(status.json.backupCodesRemaining, 8);
  });

  test('开启后：不带动态码 401，错误动态码 401，正确动态码 200', async () => {
    const noCode = await login(FAKE_PASSWORD);
    assert.equal(noCode.res.status, 401);
    assert.equal(noCode.json.message, '请输入动态码');
    const wrongCode = await login(FAKE_PASSWORD, '000000');
    assert.equal(wrongCode.res.status, 401);
    assert.equal(wrongCode.json.message, '动态码不正确');
    const ok = await login(FAKE_PASSWORD, totpLib.generateCode(secret));
    assert.equal(ok.res.status, 200);
    assert.equal(ok.json.ok, true);
  });

  test('备用码可登录一次，用过即失效，剩余 7 个', async () => {
    const first = await login(FAKE_PASSWORD, backupCodes[0]);
    assert.equal(first.res.status, 200);
    const cookie = await loginCookie(totpLib.generateCode(secret));
    const status = await totpApi('/api/totp/status', undefined, cookie);
    assert.equal(status.json.backupCodesRemaining, 7);
    const reuse = await login(FAKE_PASSWORD, backupCodes[0]);
    assert.equal(reuse.res.status, 401);
    assert.equal(reuse.json.message, '动态码不正确');
  });

  test('关闭：错误密码 401，正确密码 200；关闭后登录无需动态码', async () => {
    const cookie = await loginCookie(totpLib.generateCode(secret));
    const wrong = await totpApi('/api/totp/disable', { password: WRONG_PASSWORD }, cookie);
    assert.equal(wrong.res.status, 401);
    const ok = await totpApi('/api/totp/disable', { password: FAKE_PASSWORD }, cookie);
    assert.equal(ok.res.status, 200);
    assert.equal(ok.json.ok, true);
    const status = await totpApi('/api/totp/status', undefined, cookie);
    assert.equal(status.json.totpEnabled, false);
    const plain = await login(FAKE_PASSWORD);
    assert.equal(plain.res.status, 200);
  });
});
