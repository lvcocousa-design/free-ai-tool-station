// test/quota.test.js — 应用层用量上限（lib/quota.js）
//
// 检查函数都是纯函数：入参为 usage 对象（lib/usage.js 的 load() 形状），
// 返回 {allowed, message}。环境变量每次检查时实时读取，withEnv 可直接覆盖。
// 额度数值不要自行改动，改额度请同步更新 README 与 CHANGELOG。

const test = require('node:test');
const assert = require('node:assert/strict');
const quota = require('../lib/quota');
const { withEnv } = require('./helpers');

function usageWith(patch) {
  return {
    cloudflare: { date: '2026-11-20', usedNeurons: 0, byModel: {} },
    kaggle: { weekStart: '2026-11-16', usedSeconds: 0, jobs: 0 },
    groq: { date: '2026-11-20', byModel: {} },
    requests: { month: '2026-11', count: 0 },
    elevenlabs: null,
    deepl: null,
    ...patch,
  };
}

test('额度常量：与设计一致', () => {
  assert.equal(quota.CLOUDFLARE_DAILY_LIMIT, 10000);
  assert.equal(quota.DEFAULT_CLOUDFLARE_FRACTION, 0.9);
  assert.equal(quota.GROQ_DAILY_TOKEN_LIMIT, 200000);
  assert.equal(quota.GROQ_DAILY_REQUEST_LIMIT, 1000);
  assert.equal(quota.KAGGLE_WEEKLY_LIMIT_SECONDS, 108000);
  assert.equal(quota.KAGGLE_RESERVE_IMAGE_SECONDS, 600);
  assert.equal(quota.KAGGLE_RESERVE_VIDEO_SECONDS, 3600);
  assert.equal(quota.DEFAULT_STORAGE_LIMIT_BYTES, 8 * 1024 * 1024 * 1024);
  assert.equal(quota.DEFAULT_MONTHLY_REQUEST_LIMIT, 1500000);
});

test('currentMonthKey：返回 YYYY-MM（UTC）', () => {
  assert.equal(quota.currentMonthKey(new Date('2026-11-20T12:00:00Z')), '2026-11');
  assert.equal(quota.currentMonthKey(new Date('2026-01-01T00:00:00Z')), '2026-01');
  assert.match(quota.currentMonthKey(), /^\d{4}-\d{2}$/);
});

test('环境变量覆盖：QUOTA_CLOUDFLARE_FRACTION 改变拦截线', (t) => {
  withEnv(t, { QUOTA_CLOUDFLARE_FRACTION: undefined, QUOTA_DISABLED: undefined });
  assert.equal(quota.cloudflareEffectiveLimit(), 9000);
  withEnv(t, { QUOTA_CLOUDFLARE_FRACTION: '0.5' });
  assert.equal(quota.cloudflareEffectiveLimit(), 5000);
  withEnv(t, { QUOTA_CLOUDFLARE_FRACTION: '1' });
  assert.equal(quota.cloudflareEffectiveLimit(), 10000);
  withEnv(t, { QUOTA_CLOUDFLARE_FRACTION: '2' }); // 超出 0~1 回落默认
  assert.equal(quota.cloudflareEffectiveLimit(), 9000);
  withEnv(t, { QUOTA_CLOUDFLARE_FRACTION: 'abc' }); // 非法回落默认
  assert.equal(quota.cloudflareEffectiveLimit(), 9000);
});

test('环境变量覆盖：QUOTA_STORAGE_BYTES / QUOTA_MONTHLY_REQUESTS', (t) => {
  withEnv(t, {
    QUOTA_STORAGE_BYTES: undefined,
    QUOTA_MONTHLY_REQUESTS: undefined,
    QUOTA_DISABLED: undefined,
  });
  assert.equal(quota.getStorageLimitBytes(), 8 * 1024 * 1024 * 1024);
  assert.equal(quota.getMonthlyRequestLimit(), 1500000);
  withEnv(t, { QUOTA_STORAGE_BYTES: '1073741824' });
  assert.equal(quota.getStorageLimitBytes(), 1073741824);
  withEnv(t, { QUOTA_STORAGE_BYTES: '-5' }); // 非法回落默认
  assert.equal(quota.getStorageLimitBytes(), 8 * 1024 * 1024 * 1024);
  withEnv(t, { QUOTA_MONTHLY_REQUESTS: '100' });
  assert.equal(quota.getMonthlyRequestLimit(), 100);
  withEnv(t, { QUOTA_MONTHLY_REQUESTS: '0' }); // 0 表示关闭
  assert.equal(quota.getMonthlyRequestLimit(), 0);
  withEnv(t, { QUOTA_MONTHLY_REQUESTS: 'abc' }); // 非法回落默认
  assert.equal(quota.getMonthlyRequestLimit(), 1500000);
});

test('QUOTA_DISABLED=1 时全部检查放行', (t) => {
  withEnv(t, { QUOTA_DISABLED: '1' });
  const exhausted = usageWith({
    cloudflare: { date: '2026-11-20', usedNeurons: 99999, byModel: {} },
    kaggle: { weekStart: '2026-11-16', usedSeconds: 108000, jobs: 9 },
    groq: { date: '2026-11-20', byModel: { m: { tokens: 999999, requests: 9999 } } },
    requests: { month: '2026-11', count: 9999999 },
    elevenlabs: { characterCount: 10000, characterLimit: 10000, updatedAt: new Date().toISOString() },
    deepl: { characterCount: 1000000, characterLimit: 1000000, updatedAt: new Date().toISOString() },
  });
  assert.equal(quota.checkCloudflare(exhausted).allowed, true);
  assert.equal(quota.checkGroq(exhausted, 'm').allowed, true);
  assert.equal(quota.checkElevenLabs(exhausted).allowed, true);
  assert.equal(quota.checkDeepL(exhausted).allowed, true);
  assert.equal(quota.checkKaggle(exhausted, 600).allowed, true);
  assert.equal(quota.checkStorage(999 * 1024 * 1024 * 1024).allowed, true);
  assert.equal(quota.checkMonthlyRequests(exhausted).allowed, true);
  assert.equal(quota.isDisabled(), true);
});

test('checkCloudflare：8999 放行，9000 拦截，消息含恢复时间', (t) => {
  withEnv(t, { QUOTA_DISABLED: undefined, QUOTA_CLOUDFLARE_FRACTION: undefined });
  const ok = quota.checkCloudflare(usageWith({
    cloudflare: { date: '2026-11-20', usedNeurons: 8999, byModel: {} },
  }));
  assert.equal(ok.allowed, true);
  const blocked = quota.checkCloudflare(usageWith({
    cloudflare: { date: '2026-11-20', usedNeurons: 9000, byModel: {} },
  }));
  assert.equal(blocked.allowed, false);
  assert.match(blocked.message, /Cloudflare/);
  assert.match(blocked.message, /9,000/);
  assert.match(blocked.message, /明天 08:00（北京时间）恢复/);
});

test('checkGroq：tokens/请求数任一到顶即拦，无记录放行', (t) => {
  withEnv(t, { QUOTA_DISABLED: undefined });
  const model = 'openai/gpt-oss-120b';
  assert.equal(quota.checkGroq(usageWith(), model).allowed, true);
  const ok = quota.checkGroq(usageWith({
    groq: { date: '2026-11-20', byModel: { [model]: { tokens: 199999, requests: 999 } } },
  }), model);
  assert.equal(ok.allowed, true);
  const tokensOut = quota.checkGroq(usageWith({
    groq: { date: '2026-11-20', byModel: { [model]: { tokens: 200000, requests: 1 } } },
  }), model);
  assert.equal(tokensOut.allowed, false);
  assert.match(tokensOut.message, /tokens/);
  assert.match(tokensOut.message, /明天 08:00（北京时间）恢复/);
  const reqOut = quota.checkGroq(usageWith({
    groq: { date: '2026-11-20', byModel: { [model]: { tokens: 100, requests: 1000 } } },
  }), model);
  assert.equal(reqOut.allowed, false);
  assert.match(reqOut.message, /请求数/);
  // 其他模型的用量不影响本模型
  const other = quota.checkGroq(usageWith({
    groq: { date: '2026-11-20', byModel: { 'other-model': { tokens: 200000, requests: 1000 } } },
  }), model);
  assert.equal(other.allowed, true);
});

test('checkElevenLabs / checkDeepL：used >= limit 拦，无数据放行', (t) => {
  withEnv(t, { QUOTA_DISABLED: undefined });
  assert.equal(quota.checkElevenLabs(usageWith()).allowed, true);
  assert.equal(quota.checkDeepL(usageWith()).allowed, true);
  const ok = quota.checkElevenLabs(usageWith({
    elevenlabs: { characterCount: 9999, characterLimit: 10000, updatedAt: '2026-11-20T00:00:00.000Z' },
  }));
  assert.equal(ok.allowed, true);
  const blocked = quota.checkElevenLabs(usageWith({
    elevenlabs: { characterCount: 10000, characterLimit: 10000, updatedAt: '2026-11-20T00:00:00.000Z' },
  }));
  assert.equal(blocked.allowed, false);
  assert.match(blocked.message, /ElevenLabs/);
  const deeplBlocked = quota.checkDeepL(usageWith({
    deepl: { characterCount: 1000000, characterLimit: 1000000, updatedAt: '2026-11-20T00:00:00.000Z' },
  }));
  assert.equal(deeplBlocked.allowed, false);
  assert.match(deeplBlocked.message, /DeepL/);
  // 兼容旧 snake_case 形状
  const snake = quota.checkDeepL(usageWith({
    deepl: { character_count: 1000000, character_limit: 1000000 },
  }));
  assert.equal(snake.allowed, false);
});

test('checkKaggle：used + 预留 <= 上限放行，超出拦截', (t) => {
  withEnv(t, { QUOTA_DISABLED: undefined });
  const ok = quota.checkKaggle(usageWith({
    kaggle: { weekStart: '2026-11-16', usedSeconds: 107400, jobs: 3 },
  }), 600);
  assert.equal(ok.allowed, true);
  const blocked = quota.checkKaggle(usageWith({
    kaggle: { weekStart: '2026-11-16', usedSeconds: 107401, jobs: 3 },
  }), 600);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.message, /Kaggle/);
  assert.match(blocked.message, /下周一 08:00（北京时间）恢复/);
  // 生视频预留 3600 秒：剩余 3599 秒也不够
  const videoBlocked = quota.checkKaggle(usageWith({
    kaggle: { weekStart: '2026-11-16', usedSeconds: 104401, jobs: 3 },
  }), 3600);
  assert.equal(videoBlocked.allowed, false);
});

test('checkStorage：未达上限放行，达到拦截，null 放行（fail open）', (t) => {
  withEnv(t, { QUOTA_DISABLED: undefined, QUOTA_STORAGE_BYTES: undefined });
  const limit = 8 * 1024 * 1024 * 1024;
  assert.equal(quota.checkStorage(limit - 1).allowed, true);
  const blocked = quota.checkStorage(limit);
  assert.equal(blocked.allowed, false);
  assert.match(blocked.message, /存储空间已达上限/);
  assert.match(blocked.message, /R2 控制台/);
  assert.match(blocked.message, /QUOTA_STORAGE_BYTES/);
  assert.equal(quota.checkStorage(null).allowed, true);
  assert.equal(quota.checkStorage(undefined).allowed, true);
});

test('checkMonthlyRequests：未达上限放行，达到拦截；QUOTA_MONTHLY_REQUESTS=0 关闭', (t) => {
  withEnv(t, { QUOTA_DISABLED: undefined, QUOTA_MONTHLY_REQUESTS: undefined });
  assert.equal(quota.checkMonthlyRequests(usageWith({
    requests: { month: '2026-11', count: 1499999 },
  })).allowed, true);
  const blocked = quota.checkMonthlyRequests(usageWith({
    requests: { month: '2026-11', count: 1500000 },
  }));
  assert.equal(blocked.allowed, false);
  assert.match(blocked.message, /本月请求数已达上限/);
  assert.match(blocked.message, /下月 1 日恢复/);
  withEnv(t, { QUOTA_MONTHLY_REQUESTS: '0' });
  assert.equal(quota.checkMonthlyRequests(usageWith({
    requests: { month: '2026-11', count: 99999999 },
  })).allowed, true);
});

test('fmtBytes：GiB / MiB / 字节', () => {
  assert.equal(quota.fmtBytes(8 * 1024 * 1024 * 1024), '8.00 GiB');
  assert.equal(quota.fmtBytes(1536 * 1024 * 1024), '1.50 GiB');
  assert.equal(quota.fmtBytes(1572864), '1.50 MiB');
  assert.equal(quota.fmtBytes(524288), '524,288 字节'); // 小于 1 MiB 按字节显示
});

test('refreshIfStale：缓存新鲜时不刷新；过期时刷新；刷新失败放行', async (t) => {
  withEnv(t, { QUOTA_DISABLED: undefined });
  const fresh = new Date().toISOString();
  const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  let refreshCalls = 0;
  let stored = usageWith({
    elevenlabs: { characterCount: 10, characterLimit: 10000, updatedAt: fresh },
    deepl: { characterCount: 20, characterLimit: 1000000, updatedAt: fresh },
  });
  const ctx = {
    usage: {
      load: async () => stored,
      refreshRemoteUsage: async () => { refreshCalls += 1; },
    },
  };
  await quota.refreshIfStale(ctx);
  assert.equal(refreshCalls, 0); // 都新鲜，不刷新

  stored = usageWith({
    elevenlabs: { characterCount: 10, characterLimit: 10000, updatedAt: old },
    deepl: { characterCount: 20, characterLimit: 1000000, updatedAt: fresh },
  });
  await quota.refreshIfStale(ctx);
  assert.equal(refreshCalls, 1); // 有一个过期，刷新一次

  // 刷新抛错时不抛，放行（返回旧 usage）
  const failingCtx = {
    usage: {
      load: async () => stored,
      refreshRemoteUsage: async () => { throw new Error('网络不通'); },
    },
  };
  const result = await quota.refreshIfStale(failingCtx);
  assert.equal(result, stored);
});
