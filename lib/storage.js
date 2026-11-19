// lib/storage.js — JSON 文件存储 + blob 文件
//
// 数据目录取环境变量 DATA_DIR，默认 ./data（项目根目录下的 data/）。
// 读不到文件时返回 fallback，不抛错；写文件时先确保目录存在。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const dataDir = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
const blobsDir = path.join(dataDir, 'blobs');

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// 启动时确保数据目录存在，避免首次写盘或静态托管时报错。
ensureDir(dataDir);
ensureDir(blobsDir);

/**
 * 读 data/<name>.json，读不到（不存在 / 解析失败）返回 fallback，不抛错。
 * @param {string} name - 不带扩展名，如 'history'、'chats'、'usage'、'settings'
 * @param {*} fallback
 */
function readJSON(name, fallback) {
  try {
    const raw = fs.readFileSync(path.join(dataDir, `${name}.json`), 'utf8');
    return JSON.parse(raw);
  } catch (_) {
    return fallback;
  }
}

/** 写 data/<name>.json（先确保目录存在）。 */
function writeJSON(name, data) {
  ensureDir(dataDir);
  fs.writeFileSync(path.join(dataDir, `${name}.json`), JSON.stringify(data, null, 2), 'utf8');
}

/**
 * 把成品字节存到 data/blobs/，返回文件名（如 gen-1732...-ab12cd34.png）。
 * 文件名带时间戳 + 随机串，避免并发冲突。
 * @param {Buffer} buffer
 * @param {string} ext - 扩展名，如 'png' | 'mp4'（可带点，会被清洗）
 * @returns {string} 文件名（不含目录）
 */
function saveBlob(buffer, ext) {
  ensureDir(blobsDir);
  const cleanExt = String(ext || '')
    .replace(/^\./, '')
    .replace(/[^a-zA-Z0-9]/g, '') || 'bin';
  const filename = `gen-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${cleanExt}`;
  fs.writeFileSync(path.join(blobsDir, filename), buffer);
  return filename;
}

/**
 * 返回 blob 文件的绝对路径。文件名先取 basename，防止 ../ 穿透出 blobs 目录。
 * @param {string} filename
 */
function blobPath(filename) {
  return path.join(blobsDir, path.basename(String(filename || '')));
}

module.exports = { dataDir, blobsDir, readJSON, writeJSON, saveBlob, blobPath };
