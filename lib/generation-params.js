// lib/generation-params.js — 出图参数归一化（纯函数，路由与测试共用）
//
// POST /api/generate 的 width/height/steps/cfg 在此统一归一化：
//   - steps：整数，超出 1–50 静默夹取到边界（不报错）；缺失/非数值用默认 20。
//   - cfg：数值，超出 1–20 静默夹取到边界；缺失/非数值用默认 7。
//   - width/height：只认三档预设组合（1024×1024、512×768、768×512），
//     非法值回落默认竖图 512×768。
//   - 后端差异（各后端实际生效的参数，见 README 功能清单）：
//     - instabox：三项设置全部按原样生效。
//     - cloudflare：尺寸固定 1024×1024；steps 最多 8 步，超出按 8 计；
//       cfg 忽略，FLUX 固定 1.0。
//     - kaggle：尺寸固定 1024×1024；kernel 配方固定 4 步、cfg 1.0，
//       steps 与 cfg 设置一律忽略。
// 未知/缺失 backend 时只做通用归一化，不做后端覆盖（路由层会先校验 backend）。

'use strict';

const DEFAULT_WIDTH = 512;
const DEFAULT_HEIGHT = 768;
const DEFAULT_STEPS = 20;
const DEFAULT_CFG = 7;

const MIN_STEPS = 1;
const MAX_STEPS = 50;
const MIN_CFG = 1;
const MAX_CFG = 20;

// Cloudflare FLUX 最多 8 步；Kaggle kernel 配方固定 4 步、cfg 1.0。
const CLOUDFLARE_MAX_STEPS = 8;
const KAGGLE_FIXED_STEPS = 4;
const FLUX_FIXED_CFG = 1.0;

const SIZE_PRESETS = [
  { width: 1024, height: 1024 }, // 方形
  { width: 512, height: 768 }, // 竖图（默认）
  { width: 768, height: 512 }, // 横图
];

/** 夹取到 [min, max]；非有限数值用 fallback。 */
function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  if (n < min) return min;
  if (n > max) return max;
  return n;
}

/**
 * 归一化出图参数。
 * @param {object} [body] - 请求体（可能含 width/height/steps/cfg，字符串也接受）
 * @param {string} [backend] - 'instabox' | 'kaggle' | 'cloudflare'
 * @returns {{width: number, height: number, steps: number, cfg: number}}
 */
function normalizeGenerationParams(body, backend) {
  const input = body && typeof body === 'object' ? body : {};

  // 尺寸：只认三档预设组合，非法值回落默认竖图。
  const width = Number(input.width);
  const height = Number(input.height);
  const preset = SIZE_PRESETS.find((p) => p.width === width && p.height === height);
  let outWidth = preset ? preset.width : DEFAULT_WIDTH;
  let outHeight = preset ? preset.height : DEFAULT_HEIGHT;

  // 步数：取整后夹取到 1–50。
  let steps = clampNumber(input.steps, MIN_STEPS, MAX_STEPS, DEFAULT_STEPS);
  steps = Math.trunc(steps);

  // CFG：允许小数，夹取到 1–20。
  let cfg = clampNumber(input.cfg, MIN_CFG, MAX_CFG, DEFAULT_CFG);

  // 后端覆盖：返回各后端实际生效的参数。
  if (backend === 'cloudflare') {
    outWidth = 1024;
    outHeight = 1024;
    steps = Math.min(steps, CLOUDFLARE_MAX_STEPS);
    cfg = FLUX_FIXED_CFG;
  } else if (backend === 'kaggle') {
    outWidth = 1024;
    outHeight = 1024;
    steps = KAGGLE_FIXED_STEPS;
    cfg = FLUX_FIXED_CFG;
  }

  return { width: outWidth, height: outHeight, steps, cfg };
}

module.exports = {
  normalizeGenerationParams,
  SIZE_PRESETS,
  DEFAULT_WIDTH,
  DEFAULT_HEIGHT,
  DEFAULT_STEPS,
  DEFAULT_CFG,
  MIN_STEPS,
  MAX_STEPS,
  MIN_CFG,
  MAX_CFG,
  CLOUDFLARE_MAX_STEPS,
  KAGGLE_FIXED_STEPS,
  FLUX_FIXED_CFG,
};
