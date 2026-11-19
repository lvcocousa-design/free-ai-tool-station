'use strict';
// ElevenLabs provider：TTS + 用量查询（语音代理负责）。
//
// 注意：
// - 只提供免费账号可用的 premade 音色；Rachel 等 library 音色免费账号调 API 会报 402，不要提供。
// - 音乐 API 免费账号不可用（实测 402 paid_plan_required），不要实现任何音乐生成功能。

const BASE_URL = 'https://api.elevenlabs.io/v1';

// 免费账号可用的 premade 音色（默认 Sarah，排第一位）。
const PREMADE_VOICES = [
  { id: 'EXAVITQu4vr4xnSDxMaL', name: 'Sarah' },
  { id: 'Xb7hH8MSUJpSbSDYk0k2', name: 'Alice' },
  { id: 'pNInz6obpgDQGcFmaJgB', name: 'Adam' },
  { id: 'hpp4J3VqNfWAUOO0d1Us', name: 'Bella' },
  { id: 'JBFqnCBsd6RMkjVDRZzb', name: 'George' },
];

const DEFAULT_VOICE_ID = PREMADE_VOICES[0].id;

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
 * 查询用量。
 * @param {object} opts
 * @param {string} opts.apiKey - ElevenLabs API Key
 * @returns {Promise<{characterCount: number, characterLimit: number}>}
 * @throws 上游错误时抛 Error，如 "ElevenLabs 返回 HTTP 401：..."
 */
async function getUsage({ apiKey }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/user`, {
      method: 'GET',
      headers: { 'xi-api-key': apiKey },
      signal: AbortSignal.timeout(30000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 ElevenLabs 超时（30 秒无响应）');
    throw new Error(`请求 ElevenLabs 失败：${err.message}`);
  }
  if (!res.ok) {
    throw new Error(`ElevenLabs 返回 HTTP ${res.status}：${await upstreamErrorText(res)}`);
  }
  const data = await res.json();
  const sub = data.subscription || {};
  return {
    characterCount: typeof sub.character_count === 'number' ? sub.character_count : 0,
    characterLimit: typeof sub.character_limit === 'number' ? sub.character_limit : 0,
  };
}

module.exports = { tts, getUsage, PREMADE_VOICES, DEFAULT_VOICE_ID };
