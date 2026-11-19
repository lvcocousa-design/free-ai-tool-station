// test/providers.test.js — 供应商错误格式化（lib/providers/*）
//
// 把 global.fetch 换成 stub，模拟上游返回 401/429/500、抛网络错、超时，
// 断言抛出的 Error 是中文格式化文本（含 HTTP 状态）。绝不调真实上游。
// 每个测试结束恢复 global.fetch。只用假 Key（fake-key-xxx）。

const test = require('node:test');
const assert = require('node:assert/strict');
const groq = require('../lib/providers/groq');
const zhipu = require('../lib/providers/zhipu');
const deepl = require('../lib/providers/deepl');
const gemini = require('../lib/providers/gemini');

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

// ---------------- Groq chat() ----------------

test('groq.chat：上游 401 时抛出中文错误，含 HTTP 401', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 401,
    body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
  }));
  await assert.rejects(
    () => groq.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /Groq 返回 HTTP 401/,
  );
});

test('groq.chat：上游 429（限流）时抛出中文错误，含 HTTP 429', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 429,
    body: JSON.stringify({ error: { message: 'Rate limit reached' } }),
  }));
  await assert.rejects(
    () => groq.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /Groq 返回 HTTP 429/,
  );
});

test('groq.chat：上游 500 时抛出中文错误，含 HTTP 500', async (t) => {
  stubFetch(t, async () => fakeResponse({ status: 500, body: 'Internal Server Error' }));
  await assert.rejects(
    () => groq.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /Groq 返回 HTTP 500/,
  );
});

test('groq.chat：网络错误时抛出“请求 Groq 失败”', async (t) => {
  stubFetch(t, async () => { throw new Error('fetch failed'); });
  await assert.rejects(
    () => groq.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /请求 Groq 失败/,
  );
});

test('groq.chat：超时时抛出中文超时错误', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  await assert.rejects(
    () => groq.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /请求 Groq 超时/,
  );
});

test('groq.chat：上游 200 时正常返回文本（stub 冒烟，确认 stub 机制本身没错）', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({
    status: 200,
    body: JSON.stringify({ choices: [{ message: { content: '你好，我是测试回复' } }] }),
  }));
  const result = await groq.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] });
  assert.equal(result.text, '你好，我是测试回复');
  assert.equal(result.model, 'openai/gpt-oss-120b');
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('api.groq.com'), '应请求 Groq 接口地址');
});

// ---------------- 智谱 zhipu chat() ----------------

test('zhipu.chat：上游 429 时抛出中文错误，含 HTTP 429', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 429,
    body: JSON.stringify({ error: { message: 'The service may be temporarily overloaded' } }),
  }));
  await assert.rejects(
    () => zhipu.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /智谱返回 HTTP 429/,
  );
});

test('zhipu.chat：上游 401 时抛出中文错误，含 HTTP 401', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 401,
    body: JSON.stringify({ error: { message: 'Invalid API key' } }),
  }));
  await assert.rejects(
    () => zhipu.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /智谱返回 HTTP 401/,
  );
});

test('zhipu.chat：网络错误时抛出“请求智谱失败”', async (t) => {
  stubFetch(t, async () => { throw new Error('fetch failed'); });
  await assert.rejects(
    () => zhipu.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /请求智谱失败/,
  );
});

test('zhipu.chat：超时时抛出中文超时错误', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  await assert.rejects(
    () => zhipu.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /请求智谱超时/,
  );
});

// ---------------- DeepL translate() ----------------

test('deepl.translate：上游 401 时抛出中文错误，含 HTTP 401', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 401,
    body: JSON.stringify({ message: 'Wrong endpoint or auth key' }),
  }));
  await assert.rejects(
    () => deepl.translate({ apiKey: FAKE_KEY, text: '你好', targetLang: 'EN-US' }),
    /DeepL 返回 HTTP 401/,
  );
});

test('deepl.translate：上游 500 时抛出中文错误，含 HTTP 500', async (t) => {
  stubFetch(t, async () => fakeResponse({ status: 500, body: 'Internal Server Error' }));
  await assert.rejects(
    () => deepl.translate({ apiKey: FAKE_KEY, text: '你好', targetLang: 'EN-US' }),
    /DeepL 返回 HTTP 500/,
  );
});

test('deepl.translate：超时时抛出中文超时错误', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  await assert.rejects(
    () => deepl.translate({ apiKey: FAKE_KEY, text: '你好', targetLang: 'EN-US' }),
    /请求 DeepL 超时/,
  );
});

test('deepl.translate：上游 200 时正常返回译文（stub 冒烟）', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 200,
    body: JSON.stringify({ translations: [{ text: 'Hello' }] }),
  }));
  const result = await deepl.translate({ apiKey: FAKE_KEY, text: '你好', targetLang: 'EN-US' });
  assert.equal(result.text, 'Hello');
});

// ---------------- Google Gemini chat() / visionQA() / test() ----------------

// Gemini 成功响应形如 {candidates:[{content:{parts:[{text}]}}]}
function geminiOkResponse(text) {
  return fakeResponse({
    status: 200,
    body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] } }] }),
  });
}

test('gemini.chat：上游 401 时抛出中文错误，含 HTTP 401', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 401,
    body: JSON.stringify({ error: { code: 401, message: 'API key not valid. Please pass a valid API key.', status: 'UNAUTHENTICATED' } }),
  }));
  await assert.rejects(
    () => gemini.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /Gemini 返回 HTTP 401/,
  );
});

test('gemini.chat：上游 200 时正常返回文本，默认模型为 gemini-3.8-flash', async (t) => {
  const { calls } = stubFetch(t, async () => geminiOkResponse('你好，我是测试回复'));
  const result = await gemini.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] });
  assert.equal(result.text, '你好，我是测试回复');
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent'),
    '应请求 Gemini generateContent 接口');
  assert.equal(calls[0][1].headers['x-goog-api-key'], FAKE_KEY, 'Key 应放 x-goog-api-key 请求头');
  const body = JSON.parse(calls[0][1].body);
  assert.deepEqual(body.contents, [{ role: 'user', parts: [{ text: '你好' }] }]);
});

test('gemini.chat：OpenAI 格式消息转 contents（assistant→model，system→systemInstruction）', async (t) => {
  const { calls } = stubFetch(t, async () => geminiOkResponse('ok'));
  await gemini.chat({
    apiKey: FAKE_KEY,
    messages: [
      { role: 'system', content: '你是一个助手' },
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！' },
      { role: 'user', content: '再聊聊' },
    ],
  });
  const body = JSON.parse(calls[0][1].body);
  assert.deepEqual(body.systemInstruction, { parts: [{ text: '你是一个助手' }] });
  assert.deepEqual(body.contents, [
    { role: 'user', parts: [{ text: '你好' }] },
    { role: 'model', parts: [{ text: '你好！' }] },
    { role: 'user', parts: [{ text: '再聊聊' }] },
  ]);
});

test('gemini.chat：超时时抛出中文超时错误', async (t) => {
  stubFetch(t, async () => { throw timeoutError(); });
  await assert.rejects(
    () => gemini.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
    /请求 Gemini 超时/,
  );
});

test('gemini.visionQA：上游 200 时正常返回文本，图片走 inlineData', async (t) => {
  const { calls } = stubFetch(t, async () => geminiOkResponse('图里有一只兔子'));
  const result = await gemini.visionQA({
    apiKey: FAKE_KEY,
    imageBase64: 'aGVsbG8=',
    mimeType: 'image/png',
    question: '图里有什么？',
  });
  assert.equal(result.text, '图里有一只兔子');
  assert.equal(result.model, 'gemini-3.8-flash');
  assert.equal(calls.length, 1);
  const body = JSON.parse(calls[0][1].body);
  assert.deepEqual(body.contents, [{
    role: 'user',
    parts: [
      { text: '图里有什么？' },
      { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
    ],
  }]);
});

test('gemini.test：假 Key（上游 401）时返回 {ok:false} 且 message 中文，不抛错', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({ status: 401, body: 'Unauthorized' }));
  const result = await gemini.test({ apiKey: FAKE_KEY });
  assert.equal(result.ok, false);
  assert.match(result.message, /Key 无效或未授权/);
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('generativelanguage.googleapis.com/v1beta/models'),
    '探测应 GET /v1beta/models 列表');
  assert.equal(calls[0][1].headers['x-goog-api-key'], FAKE_KEY);
});
