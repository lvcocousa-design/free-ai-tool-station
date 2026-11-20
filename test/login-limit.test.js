// test/login-limit.test.js — 登录失败限流（lib/login-limit.js）
//
// 纯逻辑测试：时间用注入的 now，不等真实时间；环境变量用 withEnv 隔离。
// 计数只存在模块内存里，每个测试前后调 resetLoginLimiter() 清理。

const test = require('node:test');
const assert = require('node:assert/strict');
const loginLimit = require('../lib/login-limit');
const { withEnv } = require('./helpers');

const IP = '203.0.113.7';
const NOW = 1795140000000;

function reset(t) {
  loginLimit.resetLoginLimiter();
  t.after(() => loginLimit.resetLoginLimiter());
}

test('默认配置：同一 IP 15 分钟内最多 5 次失败', (t) => {
  reset(t);
  withEnv(t, { LOGIN_MAX_ATTEMPTS: undefined, LOGIN_WINDOW_MINUTES: undefined });
  assert.deepEqual(loginLimit.getLoginLimitConfig(), { maxAttempts: 5, windowMinutes: 15 });
  assert.equal(loginLimit.DEFAULT_MAX_ATTEMPTS, 5);
  assert.equal(loginLimit.DEFAULT_WINDOW_MINUTES, 15);
});

test('未达上限时允许登录尝试', (t) => {
  reset(t);
  for (let i = 0; i < 4; i++) loginLimit.recordLoginFailure(IP, NOW);
  assert.deepEqual(loginLimit.checkLoginAllowed(IP, NOW), { allowed: true, retryAfterSeconds: 0 });
});

test('5 次失败后第 6 次被拦，返回剩余等待秒数', (t) => {
  reset(t);
  for (let i = 0; i < 5; i++) loginLimit.recordLoginFailure(IP, NOW + i * 1000);
  const result = loginLimit.checkLoginAllowed(IP, NOW + 5000);
  assert.equal(result.allowed, false);
  // 窗口 15 分钟，最早一条在 NOW，NOW+5s 时还剩约 895 秒
  assert.ok(result.retryAfterSeconds > 880 && result.retryAfterSeconds <= 900);
});

test('窗口过期后自动解封', (t) => {
  reset(t);
  for (let i = 0; i < 5; i++) loginLimit.recordLoginFailure(IP, NOW);
  assert.equal(loginLimit.checkLoginAllowed(IP, NOW).allowed, false);
  // 15 分钟 + 1 秒后，旧记录全部过期
  assert.deepEqual(
    loginLimit.checkLoginAllowed(IP, NOW + 15 * 60 * 1000 + 1000),
    { allowed: true, retryAfterSeconds: 0 },
  );
});

test('成功登录清掉该 IP 的失败记录', (t) => {
  reset(t);
  for (let i = 0; i < 4; i++) loginLimit.recordLoginFailure(IP, NOW);
  loginLimit.clearLoginFailures(IP);
  for (let i = 0; i < 4; i++) loginLimit.recordLoginFailure(IP, NOW);
  assert.deepEqual(loginLimit.checkLoginAllowed(IP, NOW), { allowed: true, retryAfterSeconds: 0 });
});

test('不同 IP 互不影响', (t) => {
  reset(t);
  for (let i = 0; i < 5; i++) loginLimit.recordLoginFailure(IP, NOW);
  assert.equal(loginLimit.checkLoginAllowed(IP, NOW).allowed, false);
  assert.deepEqual(
    loginLimit.checkLoginAllowed('198.51.100.9', NOW),
    { allowed: true, retryAfterSeconds: 0 },
  );
});

test('LOGIN_MAX_ATTEMPTS=0 关闭限流', (t) => {
  reset(t);
  withEnv(t, { LOGIN_MAX_ATTEMPTS: '0' });
  for (let i = 0; i < 20; i++) loginLimit.recordLoginFailure(IP, NOW);
  assert.deepEqual(loginLimit.checkLoginAllowed(IP, NOW), { allowed: true, retryAfterSeconds: 0 });
  assert.equal(loginLimit.describeLoginLimit(), '已关闭');
});

test('环境变量可配次数与窗口', (t) => {
  reset(t);
  withEnv(t, { LOGIN_MAX_ATTEMPTS: '3', LOGIN_WINDOW_MINUTES: '1' });
  assert.deepEqual(loginLimit.getLoginLimitConfig(), { maxAttempts: 3, windowMinutes: 1 });
  for (let i = 0; i < 3; i++) loginLimit.recordLoginFailure(IP, NOW);
  assert.equal(loginLimit.checkLoginAllowed(IP, NOW).allowed, false);
  // 1 分钟窗口过期后解封
  assert.equal(loginLimit.checkLoginAllowed(IP, NOW + 61 * 1000).allowed, true);
  assert.match(loginLimit.describeLoginLimit(), /3 次失败/);
});
