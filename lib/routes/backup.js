// lib/routes/backup.js — 数据导出 / 导入（备份）
//
// GET  /api/backup/export  返回 JSON 备份：{version, exportedAt, history, chats,
//                        settings（仅各供应商 configured 布尔值）, usage,
//                        blobsIncluded:false, notes}
// POST /api/backup/import  接收 JSON 备份：history/chats 按 id 合并去重，
//                        usage 整体替换（先清洗），settings 完全忽略。
//
// 安全要点：
// - 备份绝不含任何凭据值（settings 只导 configured 布尔值），
//   也不含成品图片/视频文件（只导元数据，blobsIncluded:false 注明）。
// - 导入先完整校验结构，校验失败返回中文错误且不写任何盘。
// - Key 永不从备份恢复：导入的 settings 字段直接丢弃。

const BACKUP_VERSION = 1;

const USAGE_KEYS = ['cloudflare', 'kaggle', 'elevenlabs', 'deepl'];

function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/** 本周一的 UTC 日期（YYYY-MM-DD），与 lib/usage.js 同一口径。 */
function mondayUTC() {
  const now = new Date();
  const day = now.getUTCDay(); // 0=周日 … 6=周六
  const diffToMonday = (day + 6) % 7;
  const monday = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() - diffToMonday,
  ));
  return monday.toISOString().slice(0, 10);
}

function defaultUsage() {
  return {
    cloudflare: { date: todayUTC(), usedNeurons: 0, byModel: {} },
    kaggle: { weekStart: mondayUTC(), usedSeconds: 0, jobs: 0 },
    elevenlabs: null,
    deepl: null,
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 数值清洗：有限数字才认，否则按 0 处理（负数也按 0 处理）。 */
function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function cleanString(value, fallback) {
  return typeof value === 'string' && value ? value : fallback;
}

/**
 * 用量结构清洗：只认 cloudflare/kaggle/elevenlabs/deepl 四个键，
 * 数值非法时按 0 处理；缺失的键补默认值。
 */
function sanitizeUsage(raw) {
  const usage = defaultUsage();
  if (isPlainObject(raw.cloudflare)) {
    const byModel = {};
    if (isPlainObject(raw.cloudflare.byModel)) {
      for (const [model, value] of Object.entries(raw.cloudflare.byModel)) {
        byModel[String(model)] = cleanNumber(value);
      }
    }
    usage.cloudflare = {
      date: cleanString(raw.cloudflare.date, todayUTC()),
      usedNeurons: cleanNumber(raw.cloudflare.usedNeurons),
      byModel,
    };
  }
  if (isPlainObject(raw.kaggle)) {
    usage.kaggle = {
      weekStart: cleanString(raw.kaggle.weekStart, mondayUTC()),
      usedSeconds: cleanNumber(raw.kaggle.usedSeconds),
      jobs: cleanNumber(raw.kaggle.jobs),
    };
  }
  for (const key of ['elevenlabs', 'deepl']) {
    if (raw[key] === null || raw[key] === undefined) {
      usage[key] = null;
    } else if (isPlainObject(raw[key])) {
      usage[key] = {
        characterCount: cleanNumber(raw[key].characterCount),
        characterLimit: cleanNumber(raw[key].characterLimit),
        updatedAt: cleanString(raw[key].updatedAt, ''),
      };
    } else {
      usage[key] = null;
    }
  }
  return usage;
}

/**
 * 完整校验备份结构，返回错误消息字符串；校验通过返回 null。
 * 校验失败时调用方不写任何盘。
 */
function validateBackup(body) {
  if (!isPlainObject(body)) return '备份文件无效：顶层应为一个 JSON 对象';
  if (body.version !== BACKUP_VERSION) {
    return `不支持的备份格式版本：${body.version === undefined ? '（缺失）' : body.version}，当前支持版本 ${BACKUP_VERSION}`;
  }
  if (!Array.isArray(body.history)) return '备份文件无效：history 应为数组';
  if (!Array.isArray(body.chats)) return '备份文件无效：chats 应为数组';
  for (const entry of body.history) {
    if (!isPlainObject(entry)) return '备份文件无效：history 里的条目应为对象';
  }
  for (const entry of body.chats) {
    if (!isPlainObject(entry)) return '备份文件无效：chats 里的条目应为对象';
  }
  if (!isPlainObject(body.usage)) return '备份文件无效：usage 应为对象';
  if (body.settings !== undefined && !isPlainObject(body.settings)) {
    return '备份文件无效：settings 应为对象';
  }
  return null;
}

function newImportId() {
  return `import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 按 id 合并去重：已有 id 保留原条目，新增 id 追加。
 * 无 id 的条目补一个新 id 后追加（不丢数据）。
 * @returns {{merged: Array, added: number}}
 */
function mergeById(existing, incoming) {
  const seen = new Set(existing.map((entry) => entry.id));
  const merged = existing.slice();
  let added = 0;
  for (const entry of incoming) {
    const item = { ...entry };
    if (typeof item.id !== 'string' || !item.id) item.id = newImportId();
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    merged.push(item);
    added += 1;
  }
  return { merged, added };
}

function registerRoutes(app, ctx) {
  // GET /api/backup/export → 备份 JSON（不含凭据值，不含成品文件）。
  app.get('/api/backup/export', async (req, res) => {
    try {
      const [history, chats, usage, configuredList] = await Promise.all([
        ctx.store.readJSON('history', []),
        ctx.store.readJSON('chats', []),
        ctx.store.readJSON('usage', null),
        ctx.config.listProviders(),
      ]);
      const settings = { providers: {} };
      for (const p of configuredList) {
        settings.providers[p.name] = { configured: p.configured === true };
      }
      res.json({
        version: BACKUP_VERSION,
        exportedAt: new Date().toISOString(),
        history: Array.isArray(history) ? history : [],
        chats: Array.isArray(chats) ? chats : [],
        settings,
        usage: isPlainObject(usage) ? usage : defaultUsage(),
        blobsIncluded: false,
        notes: '备份不含 API Key 等任何凭据，也不含生成的图片/视频文件（只含历史记录元数据）；导入时 Key 不会被恢复。',
      });
    } catch (err) {
      res.json({ ok: false, message: err.message || '导出失败，请稍后重试' });
    }
  });

  // POST /api/backup/import body 为备份 JSON
  // → {ok:true, imported:{history:新增数, chats:新增数}} 或 {ok:false, message}
  app.post('/api/backup/import', async (req, res) => {
    try {
      const error = validateBackup(req.body);
      if (error) {
        return res.json({ ok: false, message: error });
      }
      const body = req.body;

      // 校验全部通过后才写盘。settings 完全忽略（Key 永不从备份恢复）。
      const [existingHistory, existingChats] = await Promise.all([
        ctx.store.readJSON('history', []),
        ctx.store.readJSON('chats', []),
      ]);
      const historyResult = mergeById(
        Array.isArray(existingHistory) ? existingHistory : [],
        body.history,
      );
      const chatsResult = mergeById(
        Array.isArray(existingChats) ? existingChats : [],
        body.chats,
      );
      await ctx.store.writeJSON('history', historyResult.merged);
      await ctx.store.writeJSON('chats', chatsResult.merged);
      await ctx.store.writeJSON('usage', sanitizeUsage(body.usage));

      return res.json({
        ok: true,
        imported: { history: historyResult.added, chats: chatsResult.added },
      });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '导入失败，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes, BACKUP_VERSION, validateBackup, sanitizeUsage, mergeById };
