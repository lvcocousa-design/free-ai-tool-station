// 语音路由：POST /api/tts、POST /api/stt
//
// POST /api/tts body {provider:'elevenlabs'|'cloudflare', text, voiceId?, lang?}
// → 成功返回音频字节（Content-Type: audio/mpeg 或 audio/wav），同时在
//   data/blobs/ 存一份（文件名放 X-Blob-File 响应头）；
//   失败返回 JSON {ok:false, message}。
// POST /api/stt body {provider:'groq'|'cloudflare'|'siliconflow', audioBase64,
//   mimeType?, durationSeconds?}
// → {ok:true, text} 或 {ok:false, message}。
//   durationSeconds 为可选字段（前端录音时已知时长），仅用于估算 Cloudflare
//   Whisper 的 Neurons 用量；不传则跳过该次用量累计。
//
// 注意：音乐生成功能不在此实现——ElevenLabs 音乐 API 免费账号不可用
// （实测 402 paid_plan_required），前端音乐页签只显示付费提示。
//
// 用量上限（lib/quota.js）：TTS 的 elevenlabs 查缓存的官方用量
// （缓存超 10 分钟先刷新），cloudflare 查当日 Neurons；STT 的 groq 查
// Whisper 模型当日请求数（语音转文字不产生 tokens，只计请求），
// cloudflare 查当日 Neurons。到顶时在调上游之前返回 429 + {quotaExceeded:true}。
// siliconflow 不拦截：其免费额度没有可强制的公开硬上限，上游自己会拒绝超量请求。

const quota = require('../quota');

const TTS_PROVIDERS = {
  elevenlabs: { label: 'ElevenLabs' },
  cloudflare: { label: 'Cloudflare' },
};

const STT_PROVIDERS = {
  groq: { label: 'Groq' },
  cloudflare: { label: 'Cloudflare' },
  siliconflow: { label: '硅基流动' },
};

// mimeType → 上传文件名（Groq / 硅基流动靠扩展名判断音频格式）。
// 浏览器 MediaRecorder 默认产出 webm/opus，因此默认 audio.webm。
const MIME_TO_FILENAME = {
  'audio/webm': 'audio.webm',
  'audio/mpeg': 'audio.mp3',
  'audio/mp3': 'audio.mp3',
  'audio/wav': 'audio.wav',
  'audio/x-wav': 'audio.wav',
  'audio/wave': 'audio.wav',
  'audio/ogg': 'audio.ogg',
  'audio/mp4': 'audio.m4a',
  'audio/m4a': 'audio.m4a',
  'audio/x-m4a': 'audio.m4a',
  'audio/flac': 'audio.flac',
  'audio/aac': 'audio.aac',
};

function mimeToFilename(mimeType) {
  if (typeof mimeType === 'string') {
    // mimeType 可能带参数，如 audio/webm;codecs=opus
    const base = mimeType.split(';')[0].trim().toLowerCase();
    if (MIME_TO_FILENAME[base]) return MIME_TO_FILENAME[base];
  }
  return 'audio.webm';
}

// 按音频魔数判断格式（MeloTTS 输出格式在不同调用方式下有 WAV/MP3 两种说法，
// 以实际字节为准，不硬编码）。返回 {ext, contentType} 或 null。
function detectAudioFormat(buffer) {
  if (!buffer || buffer.length < 12) return null;
  // WAV: "RIFF"...."WAVE"
  if (
    buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buffer.subarray(8, 12).toString('ascii') === 'WAVE'
  ) {
    return { ext: 'wav', contentType: 'audio/wav' };
  }
  // MP3: ID3 标签或帧同步头 0xFF 0xFB/0xF3/0xF2
  if (
    buffer.subarray(0, 3).toString('ascii') === 'ID3' ||
    (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)
  ) {
    return { ext: 'mp3', contentType: 'audio/mpeg' };
  }
  // Ogg: "OggS"
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
    return { ext: 'ogg', contentType: 'audio/ogg' };
  }
  // M4A/MP4: 第 4~8 字节为 "ftyp"
  if (buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { ext: 'm4a', contentType: 'audio/mp4' };
  }
  return null;
}

// Cloudflare 语音模型按音频分钟计费（RATES 表 perAudioMinute）。
// 用量累计失败绝不阻塞主流程。
async function recordCloudflareAudioUsage(ctx, model, seconds) {
  try {
    if (!seconds || seconds <= 0) return;
    const rate = ctx.providers.cloudflare.RATES?.[model];
    const perMinute = rate && rate.perAudioMinute;
    if (typeof perMinute !== 'number' || perMinute <= 0) return;
    const neurons = Math.ceil((seconds / 60) * perMinute);
    if (neurons > 0) await ctx.usage.addCloudflareNeurons(model, neurons);
  } catch { /* 用量记录失败不阻塞主流程 */ }
}

// 估算 MeloTTS 输出 WAV 的时长（秒）：44.1kHz 单声道 16-bit PCM，
// 每秒 44100 采样 × 2 字节 = 88200 字节。非 WAV 返回 null。
function estimateWavSeconds(buffer) {
  const fmt = detectAudioFormat(buffer);
  if (!fmt || fmt.ext !== 'wav') return null;
  return Math.max(0, (buffer.length - 44) / 88200);
}

function registerRoutes(app, ctx) {
  // POST /api/tts body {provider, text, voiceId?, lang?}
  // → 音频字节（成功）或 {ok:false, message} / {ok:false, notConfigured:true, message}
  app.post('/api/tts', async (req, res) => {
    try {
      const { provider, text, voiceId, lang } = req.body || {};
      if (!text || typeof text !== 'string' || !text.trim()) {
        return res.json({ ok: false, message: '要朗读的文本不能为空' });
      }
      const meta = TTS_PROVIDERS[provider];
      if (!meta) {
        return res.json({ ok: false, message: `不支持的语音供应商：${provider || '（空）'}` });
      }
      if (!await ctx.config.isConfigured(provider)) {
        return res.json({
          ok: false,
          notConfigured: true,
          message:
            provider === 'cloudflare'
              ? 'Cloudflare 未配置，请先在设置页填写 API Token 和 Account ID'
              : `${meta.label} 未配置，请先在设置页填写 API Key`,
        });
      }

      let buffer;
      let fallbackFormat;
      if (provider === 'elevenlabs') {
        // 用量上限：先刷新缓存的官方用量（超 10 分钟才刷新），再检查。
        const usage = await quota.refreshIfStale(ctx);
        const check = quota.checkElevenLabs(usage);
        if (!check.allowed) {
          return res.status(429).json({ ok: false, quotaExceeded: true, message: check.message });
        }
        const creds = await ctx.config.getProvider('elevenlabs');
        // 默认音色 Sarah（PREMADE_VOICES 首位）；只接受 premade 音色，
        // library 音色免费账号调 API 会报 402。
        const useVoiceId = voiceId || ctx.providers.elevenlabs.DEFAULT_VOICE_ID;
        buffer = await ctx.providers.elevenlabs.tts({
          apiKey: creds.apiKey,
          voiceId: useVoiceId,
          text: text.trim(),
        });
        fallbackFormat = { ext: 'mp3', contentType: 'audio/mpeg' };
      } else {
        const cfCheck = quota.checkCloudflare(await ctx.usage.load());
        if (!cfCheck.allowed) {
          return res.status(429).json({ ok: false, quotaExceeded: true, message: cfCheck.message });
        }
        const creds = await ctx.config.getProvider('cloudflare');
        const useLang =
          typeof lang === 'string' && lang.trim() ? lang.trim() : 'zh';
        buffer = await ctx.providers.cloudflare.tts({
          accountId: creds.accountId,
          apiKey: creds.apiKey,
          text: text.trim(),
          lang: useLang,
        });
        fallbackFormat = { ext: 'wav', contentType: 'audio/wav' };
        // MeloTTS 按音频分钟计费；WAV 可从字节数估算时长后累计用量。
        const seconds = estimateWavSeconds(buffer);
        if (seconds !== null) {
          await recordCloudflareAudioUsage(ctx, ctx.providers.cloudflare.TTS_MODEL, seconds);
        }
      }

      const format = detectAudioFormat(buffer) || fallbackFormat;
      // 在 data/blobs/ 存一份；存盘失败不阻塞音频返回。
      let file = null;
      try {
        file = await ctx.store.saveBlob(buffer, format.ext);
      } catch { /* 存盘失败时只返回音频，不报错 */ }
      res.set('Content-Type', format.contentType);
      if (file) res.set('X-Blob-File', file);
      return res.send(buffer);
    } catch (err) {
      return res.json({ ok: false, message: err.message || '语音合成失败，请稍后重试' });
    }
  });

  // POST /api/stt body {provider, audioBase64, mimeType?, durationSeconds?}
  // → {ok:true, text} 或 {ok:false, message} / {ok:false, notConfigured:true, message}
  app.post('/api/stt', async (req, res) => {
    try {
      const { provider, audioBase64, mimeType, durationSeconds } = req.body || {};
      if (!audioBase64 || typeof audioBase64 !== 'string') {
        return res.json({ ok: false, message: '请提供音频数据' });
      }
      const meta = STT_PROVIDERS[provider];
      if (!meta) {
        return res.json({ ok: false, message: `不支持的语音供应商：${provider || '（空）'}` });
      }
      if (!await ctx.config.isConfigured(provider)) {
        return res.json({
          ok: false,
          notConfigured: true,
          message:
            provider === 'cloudflare'
              ? 'Cloudflare 未配置，请先在设置页填写 API Token 和 Account ID'
              : `${meta.label} 未配置，请先在设置页填写 API Key`,
        });
      }
      const audioBuffer = Buffer.from(audioBase64, 'base64');
      if (audioBuffer.length === 0) {
        return res.json({ ok: false, message: '音频数据为空或格式不正确' });
      }

      let text;
      if (provider === 'groq') {
        // 用量上限：查 Whisper 模型当日请求数（转写不产生 tokens，只计请求）。
        const sttModel = (ctx.providers.groq && ctx.providers.groq.STT_MODEL)
          || 'whisper-large-v3-turbo';
        const groqCheck = quota.checkGroq(await ctx.usage.load(), sttModel);
        if (!groqCheck.allowed) {
          return res.status(429).json({ ok: false, quotaExceeded: true, message: groqCheck.message });
        }
        const creds = await ctx.config.getProvider('groq');
        text = await ctx.providers.groq.transcribe({
          apiKey: creds.apiKey,
          audioBuffer,
          filename: mimeToFilename(mimeType),
        });
        // 成功后累计本次请求（tokens 为 0，只计 1 次请求）。
        await ctx.usage.addGroqUsage(sttModel, 0, 1);
      } else if (provider === 'cloudflare') {
        const cfCheck = quota.checkCloudflare(await ctx.usage.load());
        if (!cfCheck.allowed) {
          return res.status(429).json({ ok: false, quotaExceeded: true, message: cfCheck.message });
        }
        const creds = await ctx.config.getProvider('cloudflare');
        text = await ctx.providers.cloudflare.transcribe({
          accountId: creds.accountId,
          apiKey: creds.apiKey,
          audioBuffer,
        });
        // Whisper 按音频分钟计费；只有前端传了时长时才能累计用量。
        const seconds = Number(durationSeconds);
        if (Number.isFinite(seconds) && seconds > 0) {
          await recordCloudflareAudioUsage(ctx, ctx.providers.cloudflare.WHISPER_MODEL, seconds);
        }
      } else {
        const creds = await ctx.config.getProvider('siliconflow');
        text = await ctx.providers.siliconflow.transcribe({
          apiKey: creds.apiKey,
          audioBuffer,
          filename: mimeToFilename(mimeType),
        });
      }
      return res.json({ ok: true, text: typeof text === 'string' ? text : '' });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '语音识别失败，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes };
