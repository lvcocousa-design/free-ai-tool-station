'use strict';
// ElevenLabs provider：TTS + 用量查询（语音代理负责）。
//
// 注意：
// - 只提供免费账号可用的 premade 音色；Rachel 等 library 音色免费账号调 API 会报 402，不要提供。
// - 音乐 API 免费账号不可用（实测 402 paid_plan_required），不要实现任何音乐生成功能。

const { probe } = require('../probe');
const models = require('../models');

const BASE_URL = 'https://api.elevenlabs.io/v1';

// 免费账号可用的 premade 音色来自 lib/models.json（默认 Sarah，排第一位）。
// 配置里只有 premade 音色；Rachel 等 library 音色免费账号调 API 会报 402，不要加。
const PREMADE_VOICES = models.getVoices('elevenlabs').map((v) => ({ id: v.id, name: v.label }));

const DEFAULT_VOICE_ID = models.getDefaultModel('tts', 'elevenlabs');

// 把上游错误体截成一小段，便于放进错误信息；不做 JSON 解析，避免解析失败掩盖原始信息。
async function upstreamErrorText(res) {
  try {
    const text = await res.text();
    return text ? text.slice(0, 300) : res.statusText;
  } catch {
    return res.statusText;
  }
}

/**
 * 文本转语音。
 * @param {object} opts
 * @param {string} opts.apiKey - ElevenLabs API Key
 * @param {string} opts.voiceId - 音色 ID（PREMADE_VOICES 中的 id）
 * @param {string} opts.text - 要朗读的文本
 * @returns {Promise<Buffer>} MP3 音频字节
 * @throws 上游错误时抛 Error，如 "ElevenLabs 返回 HTTP 429：..."
 */
async function tts({ apiKey, voiceId, text }) {
  if (!text || !String(text).trim()) {
    throw new Error('文本为空');
  }
  let res;
  try {
    res = await fetch(
      `${BASE_URL}/text-to-speech/${encodeURIComponent(voiceId)}`,
      {
        method: 'POST',
        headers: {
          'xi-api-key': apiKey,
          'Content-Type': 'application/json',
          Accept: 'audio/mpeg',
        },
        body: JSON.stringify({ text: String(text), model_id: 'eleven_multilingual_v2' }),
        signal: AbortSignal.timeout(120000),
      },
    );
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 ElevenLabs 超时（120 秒无响应）');
    throw new Error(`请求 ElevenLabs 失败：${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`ElevenLabs 返回 HTTP ${res.status}：${await upstreamErrorText(res)}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

/**
 * 查询用量（插件接口，供 lib/usage.js 的 refreshRemoteUsage 调用）。
 * @param {object} opts
 * @param {string} opts.apiKey - ElevenLabs API Key
 * @returns {Promise<{used: number, limit: number, unit: 'characters'} | null>}
 *   失败（未授权、网络错、响应格式不对）返回 null，不抛错；调用方保留旧值。
 */
async function getUsage({ apiKey }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/user`, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(10000),
    });
  } catch (_) {
    return null;
  }
  if (!res.ok) return null;
  const data = await res.json().catch(() => null);
  const sub = (data && data.subscription) || {};
  if (typeof sub.character_count !== 'number' || typeof sub.character_limit !== 'number') {
    return null;
  }
  return {
    used: sub.character_count,
    limit: sub.character_limit,
    unit: 'characters',
  };
}

// ── 插件接口（供 lib/provider-registry.js 发现）────────────────────────

const meta = {
  name: 'elevenlabs',
  label: 'ElevenLabs',
  quotaNote: 'Free 计划：每月 10,000 credits；音乐 API 需付费计划',
  applyUrl: 'https://elevenlabs.io',
  order: 50,
  capabilities: ['tts'],
  credentials: [
    { key: 'apiKey', label: 'API Key', type: 'password', env: 'ELEVENLABS_API_KEY', required: true },
  ],
};

// 只读连接探测：GET /user，2xx 即通过；内部 catch 转中文，不抛错。
async function test(creds = {}) {
  try {
    return await probe(`${BASE_URL}/user`, { headers: { 'xi-api-key': creds.apiKey } });
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

module.exports = { meta, test, tts, getUsage, PREMADE_VOICES, DEFAULT_VOICE_ID };
