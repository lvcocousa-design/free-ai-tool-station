// lib/jobs.js — 生成任务管理 + 历史记录
//
// 本模块不直接读写文件：history 经传入的 store 读写（store.readJSON /
// store.writeJSON / store.saveBlob，见 lib/storage.js）。
// 导出工厂函数 createJobs(store)，由 lib/context.js 调用后挂到 ctx.jobs 上。
//
// 全部 API 都是异步的（存储层是异步的），调用方必须 await：
//   createJob / getJob / updateJob / listHistory / completeJobWithBuffer / failJob。
// 存储出错（如 S3 不可用）时抛错，由调用方（路由层）走 {ok:false, message}
// 错误路径；后台轮询里的调用失败只记日志，不让服务崩溃。

const crypto = require('crypto');

const HISTORY_NAME = 'history';

/** 生成一个任务 id：时间戳 + 随机串，方便按时间排序且不冲突。 */
function newId() {
  return `gen-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
}

/** 读整条 history 数组（读不到返回 []，不抛错；存储层错误会抛给调用方）。 */
async function readHistory(store) {
  const data = await store.readJSON(HISTORY_NAME, []);
  return Array.isArray(data) ? data : [];
}

async function writeHistory(store, history) {
  await store.writeJSON(HISTORY_NAME, history);
}

/**
 * 创建 jobs 对象。
 * @param {object} store - storage.js 的 store（readJSON/writeJSON/saveBlob）
 * @returns {{createJob, getJob, updateJob, listHistory, completeJobWithBuffer, failJob}}
 */
function createJobs(store) {
  if (!store || typeof store.readJSON !== 'function' || typeof store.writeJSON !== 'function') {
    throw new Error('createJobs 需要一个带 readJSON/writeJSON 的 store');
  }

  /**
   * 创建任务并写入 history（status 为 queued）。
   * @param {object} opts
   * @param {'image'|'video'} opts.type
   * @param {string} opts.backend - 'instabox' | 'kaggle' | 'cloudflare'
   * @param {string} opts.prompt
   * @param {number} [opts.width]
   * @param {number} [opts.height]
   * @param {number} [opts.steps]
   * @param {number} [opts.cfg]
   * @param {string} [opts.sourceGenerationId] - 视频任务的首帧来源条目 id
   * @returns {Promise<object>} job
   */
  async function createJob({ type, backend, prompt, width, height, steps, cfg, sourceGenerationId }) {
    const job = {
      id: newId(),
      type,
      backend,
      prompt,
      status: 'queued',
      file: null,
      createdAt: new Date().toISOString(),
    };
    if (width !== undefined) job.width = width;
    if (height !== undefined) job.height = height;
    if (steps !== undefined) job.steps = steps;
    if (cfg !== undefined) job.cfg = cfg;
    if (sourceGenerationId) job.sourceGenerationId = sourceGenerationId;

    const history = await readHistory(store);
    history.push(job);
    await writeHistory(store, history);
    return { ...job };
  }

  /** 按 id 取任务（即 history 条目），找不到返回 null。 */
  async function getJob(id) {
    const history = await readHistory(store);
    const found = history.find((entry) => entry.id === id);
    return found ? { ...found } : null;
  }

  /**
   * 更新任务字段，同步写回 history。找不到返回 null。
   * @param {string} id
   * @param {object} patch - 要合并的字段
   */
  async function updateJob(id, patch) {
    const history = await readHistory(store);
    const index = history.findIndex((entry) => entry.id === id);
    if (index === -1) return null;
    history[index] = { ...history[index], ...patch };
    await writeHistory(store, history);
    return { ...history[index] };
  }

  /** history 按 createdAt 倒序（新到旧），图片视频一起列。 */
  async function listHistory() {
    const history = await readHistory(store);
    return history
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => {
        const byTime = b.entry.createdAt.localeCompare(a.entry.createdAt);
        if (byTime !== 0) return byTime;
        // 同一毫秒创建的条目：后写入的排前面
        return b.index - a.index;
      })
      .map(({ entry }) => ({ ...entry }));
  }

  /**
   * 任务成功完成：把成品 buffer 存成 blob，job 置 done，history 条目补 file。
   * @param {string} id
   * @param {Buffer} buffer - 成品字节（图片或 mp4）
   * @param {string} ext - 文件扩展名，如 'png' | 'mp4'（不带点）
   * @param {object} [extra] - 附加字段，如 {duration}（秒）
   */
  async function completeJobWithBuffer(id, buffer, ext, extra) {
    const filename = await store.saveBlob(buffer, ext);
    const patch = { status: 'done', file: filename };
    if (extra && typeof extra === 'object') Object.assign(patch, extra);
    return updateJob(id, patch);
  }

  /** 任务失败：status 置 failed，记 error 文本。 */
  async function failJob(id, message) {
    return updateJob(id, { status: 'failed', error: message || '生成失败' });
  }

  return { createJob, getJob, updateJob, listHistory, completeJobWithBuffer, failJob };
}

module.exports = { createJobs };
