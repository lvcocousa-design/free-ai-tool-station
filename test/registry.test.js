// test/registry.test.js — 供应商注册表（lib/provider-registry.js）
//
// 覆盖：自动发现 10 个供应商、meta 校验、forCapability、缺 meta 模块被跳过
// 不崩启动、test/getUsage 接口形状。
// test/getUsage 用 stubbed fetch，不联网；只用假 Key（fake-key-xxx）。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const registry = require('../lib/provider-registry');
const { createRegistry } = require('../lib/provider-registry');
const { makeTempDir } = require('./helpers');

const FAKE_KEY = 'fake-key-xxx';
const FAKE_ACCOUNT = 'fake-account-id';

const EXPECTED_ORDER = [
  'zhipu', 'groq', 'cloudflare', 'deepl',
  'elevenlabs', 'siliconflow', 'kaggle', 'instabox', 'gemini', 'nvidia',
];

const EXPECTED_ENVS = {
  zhipu: { apiKey: 'ZHIPU_API_KEY' },
  groq: { apiKey: 'GROQ_API_KEY' },
  cloudflare: { apiKey: 'CLOUDFLARE_API_TOKEN', accountId: 'CLOUDFLARE_ACCOUNT_ID' },
  deepl: { apiKey: 'DEEPL_API_KEY' },
  elevenlabs: { apiKey: 'ELEVENLABS_API_KEY' },
  siliconflow: { apiKey: 'SILICONFLOW_API_KEY' },
  kaggle: { username: 'KAGGLE_USERNAME', apiKey: 'KAGGLE_KEY' },
  instabox: { proxyUrl: 'INSTABOX_PROXY_URL' },
  gemini: { apiKey: 'GEMINI_API_KEY' },
  nvidia: { apiKey: 'NVIDIA_API_KEY' },
};

const ALLOWED_CAPABILITIES = new Set([
  'chat', 'vision', 'image', 'video', 'translate', 'tts', 'stt', 'embed',
]);

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

// ---------------- 自动发现与 meta ----------------

test('自动发现 10 个供应商，按 order 排序，无跳过', () => {
  assert.deepEqual(registry.names(), EXPECTED_ORDER);
  assert.deepEqual(registry.skippedNames(), []);
  assert.equal(registry.list().length, 10);
});

test('get(name)：已加载的返回模块，未知的返回 null', () => {
  assert.equal(registry.get('groq').meta.name, 'groq');
  assert.equal(registry.get('not-a-provider'), null);
});

test('每个供应商的 meta 完整：name 与文件名一致，label/quotaNote/applyUrl/order 齐全', () => {
  for (const mod of registry.list()) {
    const { meta } = mod;
    assert.equal(typeof meta.label, 'string');
    assert.ok(meta.label.length > 0, `${meta.name} 应有 label`);
    assert.equal(typeof meta.quotaNote, 'string');
    assert.ok(meta.quotaNote.length > 0, `${meta.name} 应有 quotaNote`);
    assert.equal(typeof meta.applyUrl, 'string');
    assert.ok(meta.applyUrl.startsWith('https://'), `${meta.name} 的 applyUrl 应为 https 链接`);
    assert.equal(typeof meta.order, 'number', `${meta.name} 应有 order`);
    assert.ok(Array.isArray(meta.capabilities) && meta.capabilities.length > 0,
      `${meta.name} 应至少声明一个能力`);
    for (const cap of meta.capabilities) {
      assert.ok(ALLOWED_CAPABILITIES.has(cap), `${meta.name} 的能力 ${cap} 不在取值范围内`);
    }
  }
});

test('每个供应商的凭据字段与 env 映射和旧版 config.js 一致', () => {
  for (const mod of registry.list()) {
    const { name, credentials } = mod.meta;
    const expected = EXPECTED_ENVS[name];
    assert.ok(Array.isArray(credentials), `${name} 应声明 credentials`);
    assert.deepEqual(
      credentials.map((f) => f.key),
      Object.keys(expected),
      `${name} 的凭据字段应与旧版一致`,
    );
    for (const field of credentials) {
      assert.equal(field.env, expected[field.key], `${name}.${field.key} 的 env 变量名应一致`);
      assert.equal(typeof field.label, 'string');
      assert.ok(field.label.length > 0, `${name}.${field.key} 应有 label`);
      assert.ok(field.type === 'password' || field.type === 'text',
        `${name}.${field.key} 的 type 应为 password 或 text`);
      assert.equal(field.required, true, `${name}.${field.key} 应为必填`);
    }
  }
});

test('每个供应商都导出 test 函数；只有 elevenlabs/deepl 导出 getUsage', () => {
  for (const mod of registry.list()) {
    assert.equal(typeof mod.test, 'function', `${mod.meta.name} 应导出 test`);
  }
  assert.equal(typeof registry.get('elevenlabs').getUsage, 'function');
  assert.equal(typeof registry.get('deepl').getUsage, 'function');
  for (const name of ['zhipu', 'groq', 'cloudflare', 'siliconflow', 'kaggle', 'instabox', 'gemini', 'nvidia']) {
    assert.equal(registry.get(name).getUsage, undefined, `${name} 不应导出 getUsage`);
  }
});

// ---------------- forCapability ----------------

test('forCapability：各能力返回对应供应商，按 order 排序', () => {
  const names = (cap) => registry.forCapability(cap).map((m) => m.meta.name);
  assert.deepEqual(names('chat'), ['zhipu', 'groq', 'cloudflare', 'gemini', 'nvidia']);
  assert.deepEqual(names('vision'), ['zhipu', 'siliconflow', 'gemini']);
  assert.deepEqual(names('image'), ['cloudflare', 'kaggle', 'instabox']);
  assert.deepEqual(names('video'), ['kaggle']);
  assert.deepEqual(names('translate'), ['cloudflare', 'deepl', 'siliconflow']);
  assert.deepEqual(names('tts'), ['cloudflare', 'elevenlabs']);
  assert.deepEqual(names('stt'), ['groq', 'cloudflare', 'siliconflow']);
  assert.deepEqual(names('embed'), ['cloudflare', 'siliconflow']);
  assert.deepEqual(names('no-such-capability'), []);
});

// ---------------- 校验与容错 ----------------

test('缺 meta / meta.name 与文件名不符 / 加载报错的模块被跳过，不崩启动', (t) => {
  const dir = makeTempDir(t);
  fs.writeFileSync(path.join(dir, 'good.js'), `
    module.exports = {
      meta: {
        name: 'good', label: 'Good', quotaNote: '', applyUrl: 'https://example.com',
        order: 1, capabilities: ['chat'],
        credentials: [{ key: 'apiKey', label: 'API Key', type: 'password', env: 'GOOD_API_KEY', required: true }],
      },
      test: async () => ({ ok: true }),
    };
  `);
  fs.writeFileSync(path.join(dir, 'nometa.js'), 'module.exports = { chat: async () => ({}) };');
  fs.writeFileSync(path.join(dir, 'wrongname.js'), `
    module.exports = {
      meta: { name: 'something-else', label: 'X', order: 2, capabilities: [], credentials: [] },
      test: async () => ({ ok: true }),
    };
  `);
  fs.writeFileSync(path.join(dir, 'broken.js'), 'throw new Error("boom");');

  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let reg;
  try {
    reg = createRegistry(dir);
  } finally {
    console.warn = originalWarn;
  }

  assert.deepEqual(reg.names(), ['good']);
  assert.deepEqual(reg.skippedNames().sort(), ['broken', 'nometa', 'wrongname']);
  assert.equal(reg.get('good').meta.label, 'Good');
  assert.equal(reg.get('nometa'), null);
  // 每个被跳过的模块都应记一条 warn
  for (const name of ['broken', 'nometa', 'wrongname']) {
    assert.ok(warnings.some((w) => w.includes(name)), `应为 ${name} 记 warn`);
  }
});

test('不存在的目录：createRegistry 不抛错，返回空注册表', () => {
  const warnings = [];
  const originalWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  let reg;
  try {
    reg = createRegistry(path.join(os.tmpdir(), 'tool-station-no-such-dir-xyz'));
  } finally {
    console.warn = originalWarn;
  }
  assert.deepEqual(reg.names(), []);
  assert.equal(reg.get('groq'), null);
});

// ---------------- test() 接口形状 ----------------

test('test：上游 200 时返回 {ok:true}（groq / zhipu / siliconflow / cloudflare）', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({ status: 200, body: '{}' }));
  assert.deepEqual(await registry.get('groq').test({ apiKey: FAKE_KEY }), { ok: true });
  assert.deepEqual(await registry.get('zhipu').test({ apiKey: FAKE_KEY }), { ok: true });
  assert.deepEqual(await registry.get('siliconflow').test({ apiKey: FAKE_KEY }), { ok: true });
  assert.deepEqual(
    await registry.get('cloudflare').test({ apiKey: FAKE_KEY, accountId: FAKE_ACCOUNT }),
    { ok: true },
  );
  assert.equal(calls.length, 4);
  assert.ok(String(calls[0][0]).includes('api.groq.com/openai/v1/models'));
  assert.ok(String(calls[1][0]).includes('api.z.ai/api/paas/v4/models'));
  assert.ok(String(calls[2][0]).includes('api.siliconflow.cn/v1/models'));
  assert.ok(String(calls[3][0]).includes(`/accounts/${FAKE_ACCOUNT}/ai/models/search`),
    'cloudflare 探测 URL 应含 accountId');
});

test('test：上游 401 时返回 {ok:false} 且 message 为中文“Key 无效或未授权”，不抛错', async (t) => {
  stubFetch(t, async () => fakeResponse({ status: 401, body: 'Unauthorized' }));
  for (const name of ['groq', 'zhipu', 'deepl', 'elevenlabs', 'siliconflow']) {
    const result = await registry.get(name).test({ apiKey: FAKE_KEY, accountId: FAKE_ACCOUNT });
    assert.equal(result.ok, false, `${name} 401 时 ok 应为 false`);
    assert.match(result.message, /Key 无效或未授权/);
  }
});

test('test：网络错误时返回 {ok:false}，不抛错', async (t) => {
  stubFetch(t, async () => { throw new Error('fetch failed'); });
  const result = await registry.get('groq').test({ apiKey: FAKE_KEY });
  assert.equal(result.ok, false);
  assert.equal(typeof result.message, 'string');
  assert.ok(result.message.length > 0);
});

test('test：kaggle 用 Basic Auth 探 datasets/list，200 即通过', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({ status: 200, body: '[]' }));
  const result = await registry.get('kaggle').test({ username: 'fake-user', apiKey: FAKE_KEY });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('kaggle.com/api/v1/datasets/list'));
  const auth = calls[0][1].headers.Authorization;
  assert.ok(auth.startsWith('Basic '), 'kaggle 探测应用 Basic Auth');
  assert.equal(
    Buffer.from(auth.slice('Basic '.length), 'base64').toString('utf8'),
    `fake-user:${FAKE_KEY}`,
  );
});

test('test：instabox 代理地址格式不对时返回中文原因，不发起请求', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({ status: 200, body: '{}' }));
  const result = await registry.get('instabox').test({ proxyUrl: 'not-a-url' });
  assert.equal(result.ok, false);
  assert.match(result.message, /代理地址格式不正确/);
  assert.equal(calls.length, 0, '地址格式不对时不应发起请求');
});

test('test：instabox 探 /progress?id=ping，200 即通过', async (t) => {
  const { calls } = stubFetch(t, async () => fakeResponse({ status: 200, body: '{}' }));
  const result = await registry.get('instabox').test({ proxyUrl: 'https://3001-fake.instabox.tech/' });
  assert.deepEqual(result, { ok: true });
  assert.equal(calls.length, 1);
  assert.ok(String(calls[0][0]).includes('/progress?id=ping'));
});

// ---------------- getUsage() 接口形状 ----------------

test('getUsage：elevenlabs 成功返回 {used, limit, unit:"characters"}', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 200,
    body: JSON.stringify({
      subscription: { character_count: 1234, character_limit: 10000 },
    }),
  }));
  const result = await registry.get('elevenlabs').getUsage({ apiKey: FAKE_KEY });
  assert.deepEqual(result, { used: 1234, limit: 10000, unit: 'characters' });
});

test('getUsage：deepl 成功返回 {used, limit, unit:"characters"}', async (t) => {
  stubFetch(t, async () => fakeResponse({
    status: 200,
    body: JSON.stringify({ character_count: 5678, character_limit: 1000000 }),
  }));
  const result = await registry.get('deepl').getUsage({ apiKey: FAKE_KEY });
  assert.deepEqual(result, { used: 5678, limit: 1000000, unit: 'characters' });
});

test('getUsage：上游 401 或网络错误时返回 null，不抛错', async (t) => {
  stubFetch(t, async () => fakeResponse({ status: 401, body: 'Unauthorized' }));
  assert.equal(await registry.get('elevenlabs').getUsage({ apiKey: FAKE_KEY }), null);
  assert.equal(await registry.get('deepl').getUsage({ apiKey: FAKE_KEY }), null);
});

test('getUsage：网络错误时返回 null，不抛错', async (t) => {
  stubFetch(t, async () => { throw new Error('fetch failed'); });
  assert.equal(await registry.get('elevenlabs').getUsage({ apiKey: FAKE_KEY }), null);
  assert.equal(await registry.get('deepl').getUsage({ apiKey: FAKE_KEY }), null);
});
