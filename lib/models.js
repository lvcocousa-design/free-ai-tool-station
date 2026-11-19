// lib/models.js — 模型配置单一来源（读 lib/models.json）
//
// 结构按能力分：chat / vision / image / translate / tts / stt / embed，
// 每项能力下按供应商分，每家供应商一项 { default, models: [{id, label}] }；
// ElevenLabs TTS 没有模型、只有音色，用 { default, voices: [{id, label}] }。
//
// 未进本配置的模型：
// - DeepL 翻译没有模型参数（接口不接受模型名），不需要配置；
// - Kaggle / InstaBox 出图模型在 kernel / 机器侧（FLUX.1 schnell FP8 /
//   Realistic Vision V6.0 B1），不在本服务里选型，也不需要配置。
//
// 配置文件缺失或非法时，加载即抛清晰中文错误（require 本模块时就能发现，
// 服务启动时由路由加载失败日志可见，不会静默用错模型）。
// 供应商文件与路由里的模型常量均由此派生（require 本模块），改模型只改
// models.json；test/models.test.js 断言配置值与已知正确的模型 id 一致。
'use strict';

const fs = require('fs');
const path = require('path');

const CONFIG_PATH = path.join(__dirname, 'models.json');

/**
 * 校验已解析的配置对象；非法时抛清晰中文错误。
 * @param {object} config - 解析后的配置对象
 * @param {string} [where] - 报错里标注的来源（文件路径）
 */
function validateConfig(config, where) {
  const src = where || '模型配置';
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`模型配置错误：${src} 顶层必须是对象（能力 → 供应商 → 配置）`);
  }
  for (const [capability, providers] of Object.entries(config)) {
    if (!providers || typeof providers !== 'object' || Array.isArray(providers)) {
      throw new Error(`模型配置错误：${capability} 必须是对象（供应商 → 配置）`);
    }
    for (const [provider, entry] of Object.entries(providers)) {
      const loc = `${capability}.${provider}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`模型配置错误：${loc} 必须是对象（{ default, models/voices }）`);
      }
      if (typeof entry.default !== 'string' || !entry.default) {
        throw new Error(`模型配置错误：${loc} 缺少 default（默认模型/音色 id）`);
      }
      const list = entry.models || entry.voices;
      const listName = entry.models ? 'models' : 'voices';
      if (!Array.isArray(list) || list.length === 0) {
        throw new Error(`模型配置错误：${loc} 缺少非空的 models 或 voices 列表`);
      }
      for (const item of list) {
        if (!item || typeof item.id !== 'string' || !item.id
          || typeof item.label !== 'string' || !item.label) {
          throw new Error(`模型配置错误：${loc}.${listName} 中的每一项都必须有非空的 id 和 label`);
        }
      }
      if (!list.some((item) => item.id === entry.default)) {
        throw new Error(`模型配置错误：${loc} 的 default "${entry.default}" 不在 ${listName} 列表中`);
      }
    }
  }
}

/**
 * 从指定路径读取并校验模型配置；文件缺失、JSON 非法或结构非法时抛中文错误。
 * @param {string} filePath - 配置文件路径
 * @returns {object} 校验通过的配置对象
 */
function loadConfig(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`模型配置文件缺失：${filePath} 不存在或不可读（${err.message}）`);
  }
  let config;
  try {
    config = JSON.parse(raw);
  } catch (err) {
    throw new Error(`模型配置文件格式错误：${filePath} 不是合法 JSON（${err.message}）`);
  }
  validateConfig(config, filePath);
  return config;
}

// 启动时加载并校验：配置有问题在这里就抛错，不会等到第一次请求才暴露。
const config = loadConfig(CONFIG_PATH);

function getEntry(capability, provider) {
  const cap = config[capability];
  if (!cap || typeof cap !== 'object') return undefined;
  return cap[provider];
}

/**
 * 取某能力某供应商的模型列表（[{id, label}] 的副本）。
 * 能力或供应商不存在时返回 []（TTS 音色请用 getVoices）。
 */
function getModels(capability, provider) {
  const entry = getEntry(capability, provider);
  if (!entry || !Array.isArray(entry.models)) return [];
  return entry.models.map((m) => ({ id: m.id, label: m.label }));
}

/**
 * 取某能力某供应商的默认模型 id（TTS 为默认音色 id）。
 * 能力或供应商不存在时返回 undefined。
 */
function getDefaultModel(capability, provider) {
  const entry = getEntry(capability, provider);
  return entry ? entry.default : undefined;
}

/**
 * 取某供应商的 TTS 音色列表（[{id, label}] 的副本）。
 * 该供应商没有音色配置时返回 []。
 */
function getVoices(provider) {
  const entry = getEntry('tts', provider);
  if (!entry || !Array.isArray(entry.voices)) return [];
  return entry.voices.map((v) => ({ id: v.id, label: v.label }));
}

/**
 * 判断某模型 id 是否在某能力某供应商的支持列表中
 * （TTS 同时查 models 和 voices，音色 id 也算支持）。
 */
function isSupported(capability, provider, modelId) {
  const entry = getEntry(capability, provider);
  if (!entry) return false;
  const list = entry.models || entry.voices || [];
  return list.some((item) => item.id === modelId);
}

/** 返回整份配置的深拷贝（调用方改动不影响内部配置）。 */
function getAll() {
  return JSON.parse(JSON.stringify(config));
}

module.exports = {
  getModels,
  getDefaultModel,
  getVoices,
  isSupported,
  getAll,
  // 供测试用：直接测文件加载与校验逻辑
  loadConfig,
  validateConfig,
};
