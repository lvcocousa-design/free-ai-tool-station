// lib/storage.js — 可插拔存储层：JSON + blob 文件
//
// 后端由环境变量 STORAGE_BACKEND 选择：
//   - 'local'（默认）：存在本地 DATA_DIR 目录（默认 ./data），
//     布局与原来完全一致：data/<name>.json、data/blobs/gen-<时间戳>-<随机>.ext，
//     现有 data/ 数据可直接继续用。
//   - 's3'：存在 S3 兼容对象存储（Cloudflare R2 / AWS S3 / GCS 互通 / MinIO），
//     JSON 存桶根目录 <name>.json（如 history.json），blob 存 blobs/<文件名>。
//     需要 S3_ENDPOINT、S3_BUCKET、S3_ACCESS_KEY、S3_SECRET_KEY，
//     S3_REGION 默认 'auto'（R2 用 auto）。
//
// STORAGE_BACKEND=s3 但缺必要配置时，本模块加载即抛错，服务启动失败，
// 并打印清晰中文错误——不要静默回落到本地，那样会造成“以为数据已持久化”
// 的错觉。STORAGE_BACKEND 填了 local/s3 以外的值时同样启动失败。
//
// 全部 API 都是异步的（返回 Promise），调用方必须 await：
//   readJSON(name, fallback) — 读不到（不存在 / 解析失败）返回 fallback，不抛错；
//     S3 下 404（NoSuchKey）同样返回 fallback；其他 S3 错误（桶不存在、
//     无网络、权限错）会抛中文 Error，由调用方走 {ok:false, message} 错误路径。
//   writeJSON(name, data) — 写 JSON（本地：缩进 2 空格；S3：PUT application/json）
//   saveBlob(buffer, ext) — 存成品字节，返回文件名（不含目录）
//   readBlob(filename) — 读 blob 内容，返回 Buffer；不存在抛错（S3 下挂 .status=404）
//   blobExists(filename) — blob 是否存在，返回 boolean（其他错误抛错）
//   blobPath(filename) — 仅本地后端可用（返回绝对路径）；S3 下抛错
//   getStorageBytes() — 已用存储字节数（本地：递归遍历 dataDir；
//     S3：列出全部对象求和）。成功结果内存缓存 10 分钟；失败时返回缓存值，
//     没有缓存则返回 null 并记 warn 日志（调用方应 fail open）。
//   getBackendName() — 'local' | 's3'（同步）
//   contentTypeForExt(ext) — 按扩展名取 Content-Type（同步，供 server.js 的
//     /blobs 路由与 S3 上传共用）
// dataDir、blobsDir 继续导出（仅本地后端有意义；S3 下仍为本地默认路径，
// 不要用它们拼 S3 的 key）。

const fs = require('fs');
const fsp = require('node:fs/promises');
const path = require('path');
const crypto = require('crypto');
const { createS3Client } = require('./s3');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const blobsDir = path.join(dataDir, 'blobs');

const BACKEND = (process.env.STORAGE_BACKEND || 'local').trim().toLowerCase();

if (BACKEND !== 'local' && BACKEND !== 's3') {
  throw new Error(
    `存储后端配置错误：STORAGE_BACKEND 的值 "${process.env.STORAGE_BACKEND}" 无效，` +
    '只能是 local 或 s3（local 为默认，存本地 data/ 目录；s3 存 S3 兼容对象存储）。',
  );
}

let s3 = null;
if (BACKEND === 's3') {
  const missing = [];
  if (!process.env.S3_ENDPOINT) missing.push('S3_ENDPOINT');
  if (!process.env.S3_BUCKET) missing.push('S3_BUCKET');
  if (!process.env.S3_ACCESS_KEY) missing.push('S3_ACCESS_KEY');
  if (!process.env.S3_SECRET_KEY) missing.push('S3_SECRET_KEY');
  if (missing.length) {
    throw new Error(
      `存储后端配置错误：STORAGE_BACKEND=s3 但缺少必要环境变量：${missing.join('、')}。` +
      '请在 .env 中补齐（见 .env.example 的“存储后端”一节），或改回 STORAGE_BACKEND=local。',
    );
  }
  s3 = createS3Client({
    endpoint: process.env.S3_ENDPOINT,
    bucket: process.env.S3_BUCKET,
    accessKey: process.env.S3_ACCESS_KEY,
    secretKey: process.env.S3_SECRET_KEY,
    region: process.env.S3_REGION || 'auto',
  });
}

// ── 本地后端 ─────────────────────────────────────────────────────────

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 本地后端：启动时确保数据目录存在，避免首次写盘或静态托管时报错。
// S3 后端不创建本地目录（data/ 与它无关）。
if (BACKEND === 'local') {
  ensureDir(dataDir);
  ensureDir(blobsDir);
}

async function localReadJSON(name, fallback) {
  try {
    const raw = await fsp.readFile(path.join(dataDir, `${name}.json`), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

async function localWriteJSON(name, data) {
  ensureDir(dataDir);
  await fsp.writeFile(path.join(dataDir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

async function localReadBlob(filename) {
  return fsp.readFile(localBlobPath(filename));
}

async function localBlobExists(filename) {
  // 空文件名（basename 为空）不是有效 blob，直接返回 false：
  // 否则 path.join(blobsDir, '') 等于 blobsDir 本身，access 会误报存在。
  if (!path.basename(String(filename || ''))) return false;
  try {
    await fsp.access(localBlobPath(filename), fs.constants.F_OK);
    return true;
  } catch (_) {
    return false;
  }
}

/** 返回 blob 文件的绝对路径。文件名先取 basename，防止 ../ 穿透出 blobs 目录。 */
function localBlobPath(filename) {
  return path.join(blobsDir, path.basename(String(filename || '')));
}

// ── S3 后端 ──────────────────────────────────────────────────────────

async function s3ReadJSON(name, fallback) {
  try {
    const buf = await s3.getObject(`${name}.json`);
    try {
      return JSON.parse(buf.toString('utf8'));
    } catch (_) {
      return fallback; // 解析失败与本地行为一致：返回 fallback
    }
  } catch (err) {
    // 404（对象不存在）返回 fallback；但桶不存在（NoSuchBucket）是配置错误，要抛出来。
    if (err && err.status === 404 && err.code !== 'NoSuchBucket') return fallback;
    throw err;
  }
}

async function s3WriteJSON(name, data) {
  await s3.putObject(
    `${name}.json`,
    Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
    'application/json',
  );
}

async function s3ReadBlob(filename) {
  return s3.getObject(`blobs/${path.basename(String(filename || ''))}`);
}

async function s3BlobExists(filename) {
  // 空文件名不是有效 blob，直接返回 false（不发 HEAD 请求）。
  if (!path.basename(String(filename || ''))) return false;
  return s3.headObject(`blobs/${path.basename(String(filename || ''))}`);
}

// ── 两后端共用 ───────────────────────────────────────────────────────

/** blob 文件名规则（两后端一致）：gen-<时间戳>-<随机>.ext，避免并发冲突。 */
function makeBlobFilename(ext) {
  const cleanExt = String(ext || '')
    .replace(/^\./, '')
    .replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  return `gen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${cleanExt}`;
}

const CONTENT_TYPES = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  aac: 'audio/aac',
  json: 'application/json',
  txt: 'text/plain',
  pdf: 'application/pdf',
};

/** 按扩展名取 Content-Type（扩展名可带点、大小写不限），未知返回 application/octet-stream。 */
function contentTypeForExt(ext) {
  const clean = String(ext || '').replace(/^\./, '').toLowerCase();
  return CONTENT_TYPES[clean] || 'application/octet-stream';
}

/**
 * 把成品字节存起来，返回文件名（如 gen-1732...-ab12cd34.png）。
 * @param {Buffer} buffer
 * @param {string} ext - 扩展名，如 'png' | 'mp4'（可带点，会被清洗）
 * @returns {Promise<string>} 文件名（不含目录）
 */
async function saveBlob(buffer, ext) {
  const filename = makeBlobFilename(ext);
  if (BACKEND === 's3') {
    await s3.putObject(`blobs/${filename}`, buffer, contentTypeForExt(ext));
    return filename;
  }
  ensureDir(blobsDir);
  await fsp.writeFile(path.join(blobsDir, filename), buffer);
  return filename;
}

// ── 导出（按后端分发） ───────────────────────────────────────────────

function getBackendName() {
  return BACKEND;
}

async function readJSON(name, fallback) {
  return BACKEND === 's3' ? s3ReadJSON(name, fallback) : localReadJSON(name, fallback);
}

async function writeJSON(name, data) {
  return BACKEND === 's3' ? s3WriteJSON(name, data) : localWriteJSON(name, data);
}

async function readBlob(filename) {
  return BACKEND === 's3' ? s3ReadBlob(filename) : localReadBlob(filename);
}

async function blobExists(filename) {
  return BACKEND === 's3' ? s3BlobExists(filename) : localBlobExists(filename);
}

/**
 * 仅本地后端可用：返回 blob 文件的绝对路径。
 * S3 后端下抛错（S3 的对象没有本地路径，请用 readBlob 读取内容）。
 */
function blobPath(filename) {
  if (BACKEND !== 'local') {
    throw new Error('blobPath 仅本地后端可用；S3 后端请用 readBlob(filename) 读取文件内容');
  }
  return localBlobPath(filename);
}

// ── 存储用量 ─────────────────────────────────────────────────────────

const STORAGE_BYTES_CACHE_MS = 10 * 60 * 1000; // 10 分钟
let storageBytesCache = null; // { bytes, at }

/** 递归遍历目录求文件大小总和（符号链接不跟进，单个文件读失败时跳过）。 */
async function sumDirBytes(dir) {
  let total = 0;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (_) {
    return 0; // 目录不存在按 0 计
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    try {
      if (entry.isDirectory()) {
        total += await sumDirBytes(full);
      } else if (entry.isFile()) {
        total += (await fsp.stat(full)).size;
      }
    } catch (_) { /* 单个文件读失败时跳过，不让整个统计失败 */ }
  }
  return total;
}

/**
 * 已用存储字节数（本地：递归遍历 dataDir；S3：列出全部对象求和）。
 * 成功结果内存缓存 10 分钟（S3 的 ListObjects 是 Class A 计费操作，
 * 不能每个请求都列一遍）。失败时返回缓存值（哪怕过期），没有缓存则
 * 返回 null 并记 warn 日志——调用方应 fail open，不要因此锁死服务。
 */
async function getStorageBytes() {
  const now = Date.now();
  if (storageBytesCache && now - storageBytesCache.at < STORAGE_BYTES_CACHE_MS) {
    return storageBytesCache.bytes;
  }
  try {
    let bytes;
    if (BACKEND === 's3') {
      const objects = await s3.listObjects('');
      bytes = objects.reduce((sum, obj) => sum + (Number(obj.size) || 0), 0);
    } else {
      bytes = await sumDirBytes(dataDir);
    }
    storageBytesCache = { bytes, at: now };
    return bytes;
  } catch (err) {
    console.warn('[storage] 统计存储用量失败:', err.message);
    if (storageBytesCache) return storageBytesCache.bytes;
    return null;
  }
}

module.exports = {
  dataDir,
  blobsDir,
  getBackendName,
  contentTypeForExt,
  readJSON,
  writeJSON,
  saveBlob,
  readBlob,
  blobExists,
  blobPath,
  getStorageBytes,
};
