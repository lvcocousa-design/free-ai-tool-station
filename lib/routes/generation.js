// lib/routes/generation.js — 出图 / 生视频 / 历史接口
//
//   POST /api/generate          出图（instabox / kaggle / cloudflare 三后端）
//   GET  /api/generations/:id   查单个任务状态
//   GET  /api/history           历史列表（新到旧，图片视频一起列）
//   POST /api/video             Kaggle Wan 图生视频（首帧取历史条目）
//
// 所有后台轮询都用 setTimeout 链实现，不阻塞请求；任务状态变化经
// jobs.updateJob / completeJobWithBuffer / failJob 写回 history。
// jobs / config / usage / store 的调用都是异步的，全部 await。
// 存储出错（如 S3 不可用）时：请求路径走 {ok:false, message} 返回，
// 后台轮询只记日志，不让服务崩溃。

// 轮询参数（契约规定）
const { normalizeGenerationParams } = require('../generation-params');
const quota = require('../quota');
const INSTABOX_POLL_MS = 5000; // InstaBox 每 5 秒轮询
const INSTABOX_TIMEOUT_MS = 30 * 60 * 1000; // 最长 30 分钟
const KAGGLE_POLL_MS = 60 * 1000; // Kaggle 每 60 秒轮询
const KAGGLE_TIMEOUT_MS = 3 * 60 * 60 * 1000; // 最长 3 小时
const MAX_CONSECUTIVE_POLL_ERRORS = 10; // 连续轮询失败达到此数则判失败

const KAGGLE_FLUX_SLUG = process.env.KAGGLE_FLUX_SLUG || 'free-ai-tool-station-flux';
const KAGGLE_VIDEO_SLUG = process.env.KAGGLE_VIDEO_SLUG || 'free-ai-tool-station-wan-video';

const INSTABOX_DONE = new Set(['done', 'completed', 'complete', 'success', 'succeeded']);
const INSTABOX_FAILED = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);
const KAGGLE_DONE = new Set(['complete', 'completed', 'done', 'success', 'succeeded']);
const KAGGLE_FAILED = new Set(['failed', 'error', 'errored', 'cancelled', 'canceled']);

function errMessage(err) {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** 统一失败返回：HTTP 200 + {ok:false, message}（契约规定不裸奔 500）。 */
function fail(res, message, extra) {
  return res.json({ ok: false, message, ...(extra || {}) });
}

function notConfigured(res, message) {
  return fail(res, message, { notConfigured: true });
}

/** 用量上限拦截返回：HTTP 429 + {ok:false, quotaExceeded:true, message}。 */
function quotaBlocked(res, message) {
  return res.status(429).json({ ok: false, quotaExceeded: true, message });
}

/**
 * 存储用量检查（全部后端都写 blob，所以出图/生视频共用）。
 * 查不到用量时 fail open（checkStorage 内部处理）。
 */
async function checkStorageQuota(store) {
  return quota.checkStorage(await store.getStorageBytes());
}

/** 任务完成耗时（秒，取整）。 */
function elapsedSeconds(startedAt) {
  return Math.max(0, Math.round((Date.now() - startedAt) / 1000));
}

/**
 * 标记任务失败；存储本身失败时只记日志、不抛错，
 * 不覆盖主流程的错误返回，也不在后台轮询里造成未处理拒绝。
 */
async function markFailed(jobs, jobId, message) {
  try {
    await jobs.failJob(jobId, message);
  } catch (err) {
    console.error('[generation] 标记任务失败时存储出错:', errMessage(err));
  }
}

// ── InstaBox 后台轮询 ────────────────────────────────────────────────

/**
 * 提交后每 5 秒查一次 progress，最长 30 分钟；done 后下载 images[0] 存 blob。
 * @param {object} ctx
 * @param {string} jobId
 * @param {string} baseUrl
 * @param {string} promptId
 * @param {number} startedAt - Date.now()
 */
function pollInstabox(ctx, jobId, baseUrl, promptId, startedAt) {
  const { jobs, providers } = ctx;
  let consecutiveErrors = 0;

  const tick = async () => {
    try {
      // 超时检查
      if (Date.now() - startedAt > INSTABOX_TIMEOUT_MS) {
        await markFailed(jobs, jobId, '生成超时（30 分钟未完成）');
        return;
      }
      let progress;
      try {
        progress = await providers.instabox.getProgress(baseUrl, promptId);
        consecutiveErrors = 0;
      } catch (err) {
        consecutiveErrors += 1;
        console.error(`[generation] InstaBox 轮询失败（${consecutiveErrors} 次）：`, errMessage(err));
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          await markFailed(jobs, jobId, `InstaBox 轮询多次失败：${errMessage(err)}`);
          return;
        }
        setTimeout(tick, INSTABOX_POLL_MS);
        return;
      }

      const status = String(progress && progress.status ? progress.status : '').toLowerCase();
      if (INSTABOX_FAILED.has(status)) {
        await markFailed(jobs, jobId, progress.error || progress.message || 'InstaBox 生成失败');
        return;
      }
      if (INSTABOX_DONE.has(status)) {
        const images = (progress && progress.images) || [];
        if (!images.length) {
          await markFailed(jobs, jobId, 'InstaBox 生成完成但未返回图片');
          return;
        }
        try {
          const buffer = await providers.instabox.fetchImage(baseUrl, images[0]);
          await jobs.completeJobWithBuffer(jobId, buffer, 'png', {
            duration: elapsedSeconds(startedAt),
          });
        } catch (err) {
          await markFailed(jobs, jobId, `下载成品失败：${errMessage(err)}`);
        }
        return;
      }
      // 仍在排队/生成中：继续轮询
      setTimeout(tick, INSTABOX_POLL_MS);
    } catch (err) {
      // 存储写入失败等意外：记日志，不让轮询链崩掉（下一轮不再继续）。
      console.error('[generation] InstaBox 轮询处理异常:', errMessage(err));
    }
  };

  setTimeout(tick, INSTABOX_POLL_MS);
}

// ── Kaggle 后台轮询（出图 / 视频共用） ───────────────────────────────

/**
 * 从 output list 里挑成品文件。Kaggle 输出列表项可能是对象（含下载链接）
 * 也可能是字符串；优先匹配期望的文件名/扩展名。
 * @param {Array} files - kaggle.getOutputFiles 的返回
 * @param {string} kind - 'image' | 'video'
 * @returns {{name: string, url: string} | null}
 */
function pickOutputFile(files, kind) {
  if (!Array.isArray(files) || !files.length) return null;
  const wantExt = kind === 'video' ? '.mp4' : '.png';
  const wantName = kind === 'video' ? 'output.mp4' : 'output.png';
  const normalize = (f) => {
    if (typeof f === 'string') return { name: f.split('/').pop(), url: f };
    if (!f || typeof f !== 'object') return null;
    const name = f.name || f.fileName || f.path || '';
    const url = f.url || f.downloadUrl || f.href || f.download_url || '';
    return { name: String(name).split('/').pop(), url: String(url) };
  };
  const normalized = files.map(normalize).filter(Boolean);
  return (
    normalized.find((f) => f.name === wantName && f.url) ||
    normalized.find((f) => f.name.toLowerCase().endsWith(wantExt) && f.url) ||
    normalized.find((f) => f.url) ||
    null
  );
}

/**
 * Kaggle 提交后每 60 秒查一次状态，最长 3 小时；done 后下载成品存 blob，
 * 并把耗时记入 usage.addKaggleSeconds。
 * @param {object} ctx
 * @param {string} jobId
 * @param {object} creds - {username, apiKey}
 * @param {string} slug - kernel slug
 * @param {'image'|'video'} kind
 * @param {number} startedAt - Date.now()
 */
function pollKaggle(ctx, jobId, creds, slug, kind, startedAt) {
  const { jobs, usage, providers } = ctx;
  const ext = kind === 'video' ? 'mp4' : 'png';
  let consecutiveErrors = 0;

  const tick = async () => {
    try {
      if (Date.now() - startedAt > KAGGLE_TIMEOUT_MS) {
        await markFailed(jobs, jobId, '生成超时（3 小时未完成）');
        return;
      }
      let statusResult;
      try {
        statusResult = await providers.kaggle.getStatus({
          username: creds.username,
          apiKey: creds.apiKey,
          slug,
        });
        consecutiveErrors = 0;
      } catch (err) {
        // 刚 push 完立刻查状态时 Kaggle 可能尚未建立 session，status 接口返回 404：
        // 这表示任务“尚未开始”，不是失败——不计入连续错误，继续等下一轮。
        if (err && err.status === 404) {
          console.error('[generation] Kaggle 状态查询 404（任务尚未开始），继续等待');
          setTimeout(tick, KAGGLE_POLL_MS);
          return;
        }
        consecutiveErrors += 1;
        if (consecutiveErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
          await markFailed(jobs, jobId, `Kaggle 状态查询多次失败：${errMessage(err)}`);
          return;
        }
        setTimeout(tick, KAGGLE_POLL_MS);
        return;
      }

      const status = String(
        (statusResult && (statusResult.status || statusResult.state)) || ''
      ).toLowerCase();
      if (KAGGLE_FAILED.has(status)) {
        await markFailed(
          jobs,
          jobId,
          (statusResult && (statusResult.error || statusResult.message)) || 'Kaggle 任务失败'
        );
        return;
      }
      if (KAGGLE_DONE.has(status)) {
        const seconds = elapsedSeconds(startedAt);
        try {
          const files = await providers.kaggle.getOutputFiles({
            username: creds.username,
            apiKey: creds.apiKey,
            slug,
          });
          const output = pickOutputFile(files, kind);
          if (!output) {
            await markFailed(jobs, jobId, 'Kaggle 任务完成但未找到成品文件');
            return;
          }
          const buffer = await providers.kaggle.downloadFile(output.url);
          await jobs.completeJobWithBuffer(jobId, buffer, ext, { duration: seconds });
          if (usage && typeof usage.addKaggleSeconds === 'function') {
            await usage.addKaggleSeconds(seconds);
          }
        } catch (err) {
          await markFailed(jobs, jobId, `下载成品失败：${errMessage(err)}`);
        }
        return;
      }
      // 排队等 GPU / 运行中是正常现象，保持 running，继续轮询
      setTimeout(tick, KAGGLE_POLL_MS);
    } catch (err) {
      // 存储写入失败等意外：记日志，不让轮询链崩掉（下一轮不再继续）。
      console.error('[generation] Kaggle 轮询处理异常:', errMessage(err));
    }
  };

  setTimeout(tick, KAGGLE_POLL_MS);
}

// ── 路由 ─────────────────────────────────────────────────────────────

function registerRoutes(app, ctx) {
  const { config, jobs, usage, providers, store } = ctx;

  // POST /api/generate — 出图
  app.post('/api/generate', async (req, res) => {
    try {
      const { backend, prompt } = req.body || {};

      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return fail(res, '请输入提示词');
      }
      if (!['instabox', 'kaggle', 'cloudflare'].includes(backend)) {
        return fail(res, '未知的出图后端，请选择 InstaBox / Kaggle / Cloudflare');
      }

      // 参数归一化（纯函数，见 lib/generation-params.js）：steps/cfg 越界静默
      // 夹取，非法尺寸回落默认竖图；Kaggle/Cloudflare 返回各后端实际生效值。
      const { width, height, steps, cfg } = normalizeGenerationParams(req.body, backend);

      // 存储用量检查（全部后端都写 blob，先于各后端分支检查）。
      const storageCheck = await checkStorageQuota(store);
      if (!storageCheck.allowed) {
        return quotaBlocked(res, storageCheck.message);
      }

      // ── InstaBox CPU 后端 ──
      if (backend === 'instabox') {
        const creds = await config.getProvider('instabox');
        const baseUrl = creds && creds.proxyUrl;
        if (!baseUrl) {
          return notConfigured(res, 'InstaBox 未配置：请在设置页填写代理地址');
        }
        const online = await providers.instabox.checkOnline(baseUrl);
        if (!online) {
          return fail(res, 'InstaBox 不在线', { offline: true });
        }
        const job = await jobs.createJob({ type: 'image', backend, prompt, width, height, steps, cfg });
        const startedAt = Date.now();
        let submitted;
        try {
          submitted = await providers.instabox.generate(baseUrl, {
            prompt,
            width,
            height,
            steps,
            cfg,
          });
        } catch (err) {
          await markFailed(jobs, job.id, errMessage(err));
          return fail(res, errMessage(err));
        }
        await jobs.updateJob(job.id, { status: 'running' });
        pollInstabox(ctx, job.id, baseUrl, submitted.prompt_id, startedAt);
        return res.json({ generationId: job.id, status: 'queued' });
      }

      // ── Cloudflare Workers AI 后端（同步调用，后台执行不阻塞请求） ──
      if (backend === 'cloudflare') {
        const creds = await config.getProvider('cloudflare');
        if (!creds || !creds.apiKey || !creds.accountId) {
          return notConfigured(res, 'Cloudflare 未配置：请在设置页填写 Account ID 和 API Token');
        }
        // 用量上限：当日 Neurons 到顶时拦在建任务之前。
        const cfCheck = quota.checkCloudflare(await usage.load());
        if (!cfCheck.allowed) {
          return quotaBlocked(res, cfCheck.message);
        }
        // Cloudflare 固定 1024x1024；steps 已按 min(steps,8) 归一化，
        // cfg 忽略（FLUX 固定 1.0，归一化后 cfg 即 1.0，仅记入历史）。
        const job = await jobs.createJob({ type: 'image', backend, prompt, width, height, steps, cfg });
        const startedAt = Date.now();
        await jobs.updateJob(job.id, { status: 'running' });
        // 后台执行：单次调用可能几十秒，不阻塞响应
        (async () => {
          try {
            const buffer = await providers.cloudflare.generateImage({
              accountId: creds.accountId,
              apiKey: creds.apiKey,
              prompt,
              numSteps: steps,
            });
            await jobs.completeJobWithBuffer(job.id, buffer, 'png', {
              duration: elapsedSeconds(startedAt),
            });
            if (usage && typeof usage.addCloudflareNeurons === 'function') {
              const neurons = providers.cloudflare.estimateImageNeurons({
                width,
                height,
                steps,
              });
              await usage.addCloudflareNeurons(providers.cloudflare.FLUX_MODEL, neurons);
            }
          } catch (err) {
            await markFailed(jobs, job.id, errMessage(err));
          }
        })();
        return res.json({ generationId: job.id, status: 'queued' });
      }

      // ── Kaggle GPU 后端 ──
      const kaggleCreds = await config.getProvider('kaggle');
      if (!providers.kaggle || !kaggleCreds || !kaggleCreds.username || !kaggleCreds.apiKey) {
        return notConfigured(res, 'Kaggle 未配置：请在设置页填写用户名和 API Key');
      }
      // 用量上限：本周剩余 GPU 秒数不够本次任务预留（600 秒）时拦在建任务之前。
      const kaggleCheck = quota.checkKaggle(
        await usage.load(),
        quota.KAGGLE_RESERVE_IMAGE_SECONDS,
      );
      if (!kaggleCheck.allowed) {
        return quotaBlocked(res, kaggleCheck.message);
      }
      // Kaggle kernel 配方固定（1024x1024、4 步、cfg 1.0），steps 与 cfg
      // 设置一律忽略；归一化后 width/height/steps/cfg 即配方值，记入历史。
      const job = await jobs.createJob({ type: 'image', backend, prompt, width, height, steps, cfg });
      const startedAt = Date.now();
      let submitted;
      try {
        submitted = await providers.kaggle.submitImageJob({
          username: kaggleCreds.username,
          apiKey: kaggleCreds.apiKey,
          prompt,
          slug: KAGGLE_FLUX_SLUG,
        });
      } catch (err) {
        await markFailed(jobs, job.id, errMessage(err));
        return fail(res, errMessage(err));
      }
      const kernelSlug = (submitted && submitted.kernelSlug) || KAGGLE_FLUX_SLUG;
      await jobs.updateJob(job.id, { status: 'running' });
      pollKaggle(ctx, job.id, kaggleCreds, kernelSlug, 'image', startedAt);
      return res.json({ generationId: job.id, status: 'queued' });
    } catch (err) {
      // 存储出错（如 S3 不可用）等意外：走统一错误路径，不裸奔 500。
      return fail(res, errMessage(err) || '出图请求失败，请稍后重试');
    }
  });

  // GET /api/generations/:id — 查单个任务
  app.get('/api/generations/:id', async (req, res) => {
    try {
      const job = await jobs.getJob(req.params.id);
      if (!job) {
        return res.json({ id: req.params.id, status: 'unknown' });
      }
      const out = {
        id: job.id,
        type: job.type,
        backend: job.backend,
        prompt: job.prompt,
        status: job.status,
        createdAt: job.createdAt,
      };
      if (job.width !== undefined) out.width = job.width;
      if (job.height !== undefined) out.height = job.height;
      if (job.steps !== undefined) out.steps = job.steps;
      if (job.cfg !== undefined) out.cfg = job.cfg;
      if (job.duration !== undefined) out.duration = job.duration;
      if (job.error) out.error = job.error;
      if (job.file) {
        const url = `/blobs/${job.file}`;
        if (job.type === 'video') out.videoUrl = url;
        else out.imageUrl = url;
      }
      return res.json(out);
    } catch (err) {
      return res.json({ ok: false, message: errMessage(err) || '查询任务失败，请稍后重试' });
    }
  });

  // GET /api/history — 历史列表
  app.get('/api/history', async (req, res) => {
    try {
      return res.json({ history: await jobs.listHistory() });
    } catch (err) {
      return res.json({ ok: false, message: errMessage(err) || '读取历史失败，请稍后重试' });
    }
  });

  // POST /api/video — Kaggle Wan 图生视频
  app.post('/api/video', async (req, res) => {
    try {
      const { sourceGenerationId, prompt } = req.body || {};
      if (!sourceGenerationId) {
        return fail(res, '请选择一张历史图片作为首帧');
      }
      if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
        return fail(res, '请输入动作描述');
      }
      const kaggleCreds = await config.getProvider('kaggle');
      if (!providers.kaggle || !kaggleCreds || !kaggleCreds.username || !kaggleCreds.apiKey) {
        return notConfigured(res, 'Kaggle 未配置：请在设置页填写用户名和 API Key');
      }
      const source = await jobs.getJob(sourceGenerationId);
      if (!source || !source.file) {
        return fail(res, '首帧图片不存在或尚未生成完成');
      }
      let firstFrameBase64;
      try {
        // 经存储层读首帧（本地后端读 data/blobs/，S3 后端从桶里取回）。
        firstFrameBase64 = (await store.readBlob(source.file)).toString('base64');
      } catch (err) {
        return fail(res, `读取首帧图片失败：${errMessage(err)}`);
      }

      // 用量上限：先查存储（视频文件较大），再查 Kaggle 本周剩余额度
      // （生视频预留 3600 秒），都在建任务与提交之前拦截。
      const videoStorageCheck = await checkStorageQuota(store);
      if (!videoStorageCheck.allowed) {
        return quotaBlocked(res, videoStorageCheck.message);
      }
      const videoKaggleCheck = quota.checkKaggle(
        await usage.load(),
        quota.KAGGLE_RESERVE_VIDEO_SECONDS,
      );
      if (!videoKaggleCheck.allowed) {
        return quotaBlocked(res, videoKaggleCheck.message);
      }

      const job = await jobs.createJob({
        type: 'video',
        backend: 'kaggle',
        prompt,
        sourceGenerationId,
      });
      const startedAt = Date.now();
      let submitted;
      try {
        submitted = await providers.kaggle.submitVideoJob({
          username: kaggleCreds.username,
          apiKey: kaggleCreds.apiKey,
          firstFrameBase64,
          prompt,
          slug: KAGGLE_VIDEO_SLUG,
        });
      } catch (err) {
        await markFailed(jobs, job.id, errMessage(err));
        return fail(res, errMessage(err));
      }
      const kernelSlug = (submitted && submitted.kernelSlug) || KAGGLE_VIDEO_SLUG;
      await jobs.updateJob(job.id, { status: 'running' });
      pollKaggle(ctx, job.id, kaggleCreds, kernelSlug, 'video', startedAt);
      return res.json({ generationId: job.id, status: 'queued' });
    } catch (err) {
      return fail(res, errMessage(err) || '生视频请求失败，请稍后重试');
    }
  });
}

module.exports = { registerRoutes };
