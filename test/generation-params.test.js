// test/generation-params.test.js — 出图参数归一化（lib/generation-params.js）
// 与 jobs.createJob 的 cfg 落盘。只测纯函数 + 临时 DATA_DIR 的 jobs，
// 不碰项目 data/ 目录，不发真实请求。

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const { normalizeGenerationParams } = require('../lib/generation-params');
const { freshStorage } = require('./helpers');
const { createJobs } = require('../lib/jobs');

// ── 默认值 ───────────────────────────────────────────────────────────

test('默认值：空 body → 竖图 512x768、20 步、cfg 7', () => {
  assert.deepEqual(normalizeGenerationParams({}, 'instabox'), {
    width: 512, height: 768, steps: 20, cfg: 7,
  });
});

test('默认值：缺失 body / 缺失 backend 时也用默认值', () => {
  assert.deepEqual(normalizeGenerationParams(undefined), {
    width: 512, height: 768, steps: 20, cfg: 7,
  });
  assert.deepEqual(normalizeGenerationParams(null, undefined), {
    width: 512, height: 768, steps: 20, cfg: 7,
  });
});

test('三档预设尺寸都认：方形 / 竖图 / 横图', () => {
  assert.equal(normalizeGenerationParams({ width: 1024, height: 1024 }, 'instabox').width, 1024);
  assert.equal(normalizeGenerationParams({ width: 512, height: 768 }, 'instabox').height, 768);
  const landscape = normalizeGenerationParams({ width: 768, height: 512 }, 'instabox');
  assert.deepEqual({ width: landscape.width, height: landscape.height }, { width: 768, height: 512 });
});

test('字符串形式的数值也能解析', () => {
  const out = normalizeGenerationParams({ width: '768', height: '512', steps: '30', cfg: '8.5' }, 'instabox');
  assert.deepEqual(out, { width: 768, height: 512, steps: 30, cfg: 8.5 });
});

// ── 越界夹取（静默，不报错） ─────────────────────────────────────────

test('steps 越界夹取到 1–50', () => {
  assert.equal(normalizeGenerationParams({ steps: 0 }, 'instabox').steps, 1);
  assert.equal(normalizeGenerationParams({ steps: -5 }, 'instabox').steps, 1);
  assert.equal(normalizeGenerationParams({ steps: 51 }, 'instabox').steps, 50);
  assert.equal(normalizeGenerationParams({ steps: 999 }, 'instabox').steps, 50);
  assert.equal(normalizeGenerationParams({ steps: 1 }, 'instabox').steps, 1);
  assert.equal(normalizeGenerationParams({ steps: 50 }, 'instabox').steps, 50);
});

test('steps 小数取整，非数值用默认 20', () => {
  assert.equal(normalizeGenerationParams({ steps: 20.7 }, 'instabox').steps, 20);
  assert.equal(normalizeGenerationParams({ steps: 'abc' }, 'instabox').steps, 20);
  // 空字符串 Number() 为 0，属越界，按夹取规则到 1
  assert.equal(normalizeGenerationParams({ steps: '' }, 'instabox').steps, 1);
});

test('cfg 越界夹取到 1–20，允许小数', () => {
  assert.equal(normalizeGenerationParams({ cfg: 0 }, 'instabox').cfg, 1);
  assert.equal(normalizeGenerationParams({ cfg: 0.5 }, 'instabox').cfg, 1);
  assert.equal(normalizeGenerationParams({ cfg: 21 }, 'instabox').cfg, 20);
  assert.equal(normalizeGenerationParams({ cfg: 7.5 }, 'instabox').cfg, 7.5);
  assert.equal(normalizeGenerationParams({ cfg: 1 }, 'instabox').cfg, 1);
  assert.equal(normalizeGenerationParams({ cfg: 20 }, 'instabox').cfg, 20);
});

test('cfg 非数值用默认 7', () => {
  assert.equal(normalizeGenerationParams({ cfg: 'xyz' }, 'instabox').cfg, 7);
  assert.equal(normalizeGenerationParams({ cfg: NaN }, 'instabox').cfg, 7);
});

// ── 非法尺寸回落 ─────────────────────────────────────────────────────

test('非法尺寸回落默认竖图 512x768', () => {
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(
      normalizeGenerationParams({ width: 800, height: 600 }, 'instabox')
    ),
    { width: 512, height: 768 }
  );
  // 只有一半匹配预设也算非法
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(
      normalizeGenerationParams({ width: 1024, height: 768 }, 'instabox')
    ),
    { width: 512, height: 768 }
  );
  // 缺失 / 非数值同样回落
  assert.deepEqual(
    (({ width, height }) => ({ width, height }))(
      normalizeGenerationParams({ width: 'abc' }, 'instabox')
    ),
    { width: 512, height: 768 }
  );
});

// ── 后端忽略行为 ─────────────────────────────────────────────────────

test('InstaBox：三项设置全部按原样生效', () => {
  assert.deepEqual(
    normalizeGenerationParams({ width: 768, height: 512, steps: 30, cfg: 9 }, 'instabox'),
    { width: 768, height: 512, steps: 30, cfg: 9 }
  );
});

test('Cloudflare：固定 1024x1024，steps 最多 8 步，cfg 固定 1.0', () => {
  assert.deepEqual(
    normalizeGenerationParams({ width: 768, height: 512, steps: 30, cfg: 9 }, 'cloudflare'),
    { width: 1024, height: 1024, steps: 8, cfg: 1 }
  );
  // 8 步以内按设置走
  assert.equal(
    normalizeGenerationParams({ steps: 6, cfg: 7 }, 'cloudflare').steps, 6
  );
  assert.equal(
    normalizeGenerationParams({ steps: 8, cfg: 7 }, 'cloudflare').steps, 8
  );
});

test('Kaggle：固定 1024x1024、4 步、cfg 1.0，忽略全部设置', () => {
  assert.deepEqual(
    normalizeGenerationParams({ width: 768, height: 512, steps: 30, cfg: 9 }, 'kaggle'),
    { width: 1024, height: 1024, steps: 4, cfg: 1 }
  );
});

// ── jobs：cfg 落入历史记录 ───────────────────────────────────────────

test('createJob 记 cfg，getJob 能读回（与 steps 同款）', async (t) => {
  const { storage } = freshStorage(t);
  const jobs = createJobs(storage);
  const job = await jobs.createJob({
    type: 'image', backend: 'instabox', prompt: 'test',
    width: 768, height: 512, steps: 30, cfg: 9,
  });
  assert.equal(job.steps, 30);
  assert.equal(job.cfg, 9);
  const found = await jobs.getJob(job.id);
  assert.equal(found.cfg, 9);
  assert.equal(found.steps, 30);
});

test('createJob 不传 cfg 时 history 条目不含 cfg 字段', async (t) => {
  const { storage } = freshStorage(t);
  const jobs = createJobs(storage);
  const job = await jobs.createJob({ type: 'image', backend: 'kaggle', prompt: 'test' });
  assert.equal(job.cfg, undefined);
  assert.equal('cfg' in job, false);
});
