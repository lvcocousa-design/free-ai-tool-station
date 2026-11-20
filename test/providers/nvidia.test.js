// test/providers/nvidia.test.js — NVIDIA NIM 供应商（lib/providers/nvidia.js）
//
// 把 global.fetch 换成 stub，模拟上游返回 401/429/500、抛网络错、超时，
// 断言抛出的 Error 是中文格式化文本（含 HTTP 状态）。只 mock 网络层
// （global.fetch），不 mock 供应商模块内部逻辑。绝不调真实上游。
// 每个测试结束恢复 global.fetch。只用假 Key（fake-key-xxx）。

const test = require('node:test');
const assert = require('node:assert/strict');
const nvidia = require('../../lib/providers/nvidia');

const FAKE_KEY = 'fake-key-xxx';

/** 构造一个最小的 fetch Response stub。 */
function fakeResponse({ status, body }) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => body,
    json: async () => JSON.parse(body),
  };
}

/** 用 stub 替换 global.fetch，测试结束自动恢复。返回 { calls } 记录调用。 */
function stubFetch(t, impl) {
  const original = global.fetch;
  const calls = [];
  global.fetch = async (...args) => {
    calls.push(args);
    return impl(...args);
  };
  t.after(() => { global.fetch = original; });
  return { calls };
}

function timeoutError() {
  const err = new Error('The operation timed out');
  err.name = 'TimeoutError';
  return err;
}

// ---------------- nvidia.chat() ----------------

test('nvidia.chat：上游 401 时抛出中文错误，含 HTTP 401', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 401,
    body: JSON.stringify({ error: { message: 'Unauthenticated' } }),
  }));
  await assert.rejects(
    () => nvidia.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /NVIDIA NIM 返回 HTTP 401/,
  );
});

test('nvidia.chat：上游 429（限流）时抛出中文错误，含 HTTP 429', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 429,
    body: JSON.stringify({ error: { message: 'Rate limit reached' } }),
  }));
  await assert.rejects(
    () => nvidia.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /NVIDIA NIM 返回 HTTP 429/,
  );
});

test('nvidia.chat：上游 500 时抛出中文错误，含 HTTP 500', async (t) => {
  stubFetch(t, async () => fakeResponse({ status: 500, body: 'Internal Server Error' }));
  await assert.rejects(
    () => nvidia.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /NVIDIA NIM 返回 HTTP 500/,
  );
});

test('nvidia.chat：网络错误时抛出“请求 NVIDIA NIM 失败”', async (t) => {
  stubFetch(t, async () => { throw new Error('fetch failed'); });
  await assert.rejects(
    () => nvidia.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /请求 NVIDIA NIM 失败/,
  );
});

test('nvidia.chat：超时时抛出中文超时错误', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  await assert.rejects(
    () => nvidia.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /请求 NVIDIA NIM 超时/,
  );
});

test('nvidia.chat：上游 200 时正常返回文本，默认模型为 z-ai/glm-5.3-flash', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: '你好，我是测试回复' } }] }),
  }));
  const result = await nvidia.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] });
  assert.equal(result.text, '你好，我是测试回复');
  assert.equal(result.model, 'z-ai/glm-5.3-flash');
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('integrate.api.nvidia.com/v1/chat/completions'),
    '应请求 NVIDIA NIM 对话接口');
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${FAKE_KEY}`, 'Key 应放 Bearer 请求头');
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.model, 'z-ai/glm-5.3-flash');
  assert.deepEqual(body.messages, [{ role: 'user', content: '你好' }]);
});

test('nvidia.chat：不支持的模型直接抛中文错误，不发起请求', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({ status: 200, body: '{}' }));
  await assert.rejects(
    () => nvidia.chat({ apiKey: FAKE_KEY, model: 'not-a-model', messages: [{ role: 'user', content: '你好' }] }),
    /NVIDIA NIM 不支持模型 not-a-model/,
  );
  assert.equal(calls.length, 0, '模型不在支持列表时不应发起请求');
});

// ---------------- nvidia.test() ----------------

// 注意：NVIDIA 的 GET /v1/models 是公开接口（无需 Key），验不出 Key 真伪，
// 所以 test() 改用一次最小对话（max_tokens=1）做探测。以下断言即锁死这一点。

test('nvidia.test：假 Key（上游 401）时返回 {ok:false} 且 message 中文，不抛错', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({ status: 401, body: 'Unauthorized' }));
  const result = await nvidia.test({ apiKey: FAKE_KEY });
  assert.equal(result.ok, false);
  assert.match(result.message, /Key 无效或未授权/);
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('integrate.api.nvidia.com/v1/chat/completions'),
    '探测应用最小对话请求，不应 GET 公开的 /v1/models 列表');
  assert.equal(calls[0][1].method, 'POST');
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${FAKE_KEY}`);
  const body = JSON.parse(calls[0][1].body);
  assert.equal(body.model, 'z-ai/glm-5.3-flash');
  assert.equal(body.max_tokens, 1);
});

test('nvidia.test：上游 200 时返回 {ok:true}', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: 'hi' } }] }),
  }));
  assert.deepEqual(await nvidia.test({ apiKey: FAKE_KEY }), { ok: true });
});

// NVIDIA 免费端点首次推理常需几十秒，15 秒默认超时会误报；探测改用 90 秒，
// 超时文案里的秒数即锁死这一点（probeErrorMessage 用传入的超时值生成文案）。
test('nvidia.test：超时时 message 含“90 秒”（探测用 90 秒超时，不是默认 15 秒）', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  const result = await nvidia.test({ apiKey: FAKE_KEY });
  assert.equal(result.ok, false);
  assert.match(result.message, /90 秒/);
});
