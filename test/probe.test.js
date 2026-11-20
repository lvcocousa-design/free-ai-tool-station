// test/probe.test.js — 连接探测公共辅助（lib/probe.js）
//
// 只 stub global.fetch，不调真实上游。每个测试结束恢复 global.fetch。

const test = require('node:test');
const assert = require('node:assert/strict');
const { probe, probeErrorMessage, TIMEOUT_MS } = require('../lib/probe');

function fakeResponse({ status, body = '' }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
  };
}

function stubFetch(t, impl) {
  const original = global.fetch;
  global.fetch = async (...args) => impl(...args);
  t.after(() => { global.fetch = original; });
}

function timeoutError() {
  const err = new Error('The operation timed out');
  err.name = 'TimeoutError';
  return err;
}

test('probe：默认超时 15 秒', () => {
  assert.equal(TIMEOUT_MS, 15000);
});

test('probe：上游 2xx 返回 {ok:true}', async (t) => {
  stubFetch(t, async () => fakeResponse({ status: 200 }));
  assert.deepEqual(await probe('https://example.com/ping', {}), { ok: true });
});

test('probe：上游 401 返回中文“Key 无效或未授权”', async (t) => {
  stubFetch(t, async () => fakeResponse({ status: 401 }));
  const result = await probe('https://example.com/ping', {});
  assert.equal(result.ok, false);
  assert.match(result.message, /Key 无效或未授权/);
});

test('probe：默认超时文案含“15 秒”', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  const result = await probe('https://example.com/ping', {});
  assert.equal(result.ok, false);
  assert.match(result.message, /15 秒/);
});

test('probe：传入自定义超时，超时文案用该秒数', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  const result = await probe('https://example.com/ping', {}, 90000);
  assert.equal(result.ok, false);
  assert.match(result.message, /90 秒/);
});

test('probeErrorMessage：超时文案用传入的超时值', () => {
  assert.match(probeErrorMessage(timeoutError(), null, 60000), /60 秒/);
  assert.match(probeErrorMessage(timeoutError(), null), /15 秒/);
});
