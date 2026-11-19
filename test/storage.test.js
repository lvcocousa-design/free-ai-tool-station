// test/storage.test.js — 本地存储后端读写（lib/storage.js）
//
// 按存储接口契约写：所有调用都用 await，同步/异步实现都能跑。
// 契约新增但当前实现尚未提供的接口（readBlob、blobExists、getBackendName）
// 对应用例在接口缺失时自动 skip（重构落地后自动生效），见文件末尾说明。
// 测试一律用临时 DATA_DIR，不碰项目 data/ 目录。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { freshStorage } = require('./helpers');

// 契约接口是否已实现（存储代理重构进行中，未落地时相关用例 skip）。
// 探测时先把 DATA_DIR 指到临时目录再 require，避免顶层加载触碰项目 data/。
const os = require('os');
const _probeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tool-station-test-probe-'));
const _savedDataDir = process.env.DATA_DIR;
process.env.DATA_DIR = _probeDir;
const _probe = require('../lib/storage');
const HAS_READ_BLOB = typeof _probe.readBlob === 'function';
const HAS_BLOB_EXISTS = typeof _probe.blobExists === 'function';
const HAS_BACKEND_NAME = typeof _probe.getBackendName === 'function';
delete require.cache[require.resolve('../lib/storage')];
if (_savedDataDir === undefined) delete process.env.DATA_DIR;
else process.env.DATA_DIR = _savedDataDir;
fs.rmSync(_probeDir, { recursive: true, force: true });
const SKIP_NOT_IMPLEMENTED = '契约接口尚未实现（存储代理重构未落地），待实现后自动生效';

test('readJSON：文件不存在时返回 fallback，不抛错', async (t) => {
  const { storage } = freshStorage(t);
  const fallback = { empty: true };
  assert.deepEqual(await storage.readJSON('does-not-exist', fallback), fallback);
  assert.equal(await storage.readJSON('also-missing', null), null);
  assert.equal(await storage.readJSON('also-missing', 42), 42);
});

test('readJSON：文件损坏（非法 JSON）时返回 fallback，不抛错', async (t) => {
  const { storage, dir } = freshStorage(t);
  fs.writeFileSync(path.join(dir, 'broken.json'), '{ this is not json', 'utf8');
  assert.deepEqual(await storage.readJSON('broken', { fallback: true }), { fallback: true });
});

test('writeJSON / readJSON 往返：对象、数组、嵌套结构', async (t) => {
  const { storage } = freshStorage(t);
  const data = {
    history: [{ id: 1, prompt: '一只兔子', nested: { a: [1, 2, 3] } }],
    count: 7,
    flag: false,
    nothing: null,
  };
  await storage.writeJSON('history', data);
  assert.deepEqual(await storage.readJSON('history', null), data);
  await storage.writeJSON('list', [1, 'two', { three: 3 }]);
  assert.deepEqual(await storage.readJSON('list', null), [1, 'two', { three: 3 }]);
});

test('writeJSON 落盘位置：DATA_DIR 下的 <name>.json', async (t) => {
  const { storage, dir } = freshStorage(t);
  await storage.writeJSON('settings', { providers: {} });
  const file = path.join(dir, 'settings.json');
  assert.equal(fs.existsSync(file), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { providers: {} });
  // 覆盖写入：旧内容被替换
  await storage.writeJSON('settings', { providers: { groq: {} } });
  assert.deepEqual(await storage.readJSON('settings', null), { providers: { groq: {} } });
});

test('dataDir / blobsDir 导出指向临时 DATA_DIR', async (t) => {
  const { storage, dir } = freshStorage(t);
  assert.equal(storage.dataDir, dir);
  assert.equal(storage.blobsDir, path.join(dir, 'blobs'));
});

test('saveBlob：文件名格式 gen-<时间戳>-<随机>.ext，文件落盘且字节一致', async (t) => {
  const { storage } = freshStorage(t);
  const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]); // 假 PNG 头
  const filename = await storage.saveBlob(bytes, 'png');
  assert.match(filename, /^gen-\d+-[0-9a-f]+\.png$/);
  assert.equal(filename.includes('/'), false);
  assert.equal(filename.includes('\\'), false);
  const onDisk = fs.readFileSync(path.join(storage.blobsDir, filename));
  assert.deepEqual(onDisk, bytes);
  // 两次保存文件名不冲突
  const second = await storage.saveBlob(bytes, 'png');
  assert.notEqual(second, filename);
});

test('saveBlob：扩展名清洗（去前导点、去非法字符、空扩展名 fallback 为 bin）', async (t) => {
  const { storage } = freshStorage(t);
  const bytes = Buffer.from('fake-bytes');
  assert.match(await storage.saveBlob(bytes, '.png'), /\.png$/);
  assert.match(await storage.saveBlob(bytes, 'mp4'), /\.mp4$/);
  assert.match(await storage.saveBlob(bytes, 'p!n@g'), /\.png$/);
  assert.match(await storage.saveBlob(bytes, ''), /\.bin$/);
  assert.match(await storage.saveBlob(bytes, '../../etc'), /\.etc$/);
  const tricky = await storage.saveBlob(bytes, 'a/b\\c');
  assert.equal(tricky.includes('/'), false);
  assert.equal(tricky.includes('\\'), false);
});

test('saveBlob + readBlob 往返', { skip: HAS_READ_BLOB ? false : SKIP_NOT_IMPLEMENTED }, async (t) => {
  const { storage } = freshStorage(t);
  const bytes = Buffer.from('fake-image-bytes-12345');
  const filename = await storage.saveBlob(bytes, 'png');
  const back = await storage.readBlob(filename);
  assert.deepEqual(Buffer.from(back), bytes);
});

test('blobExists：已保存的返回 true，不存在的返回 false', { skip: HAS_BLOB_EXISTS ? false : SKIP_NOT_IMPLEMENTED }, async (t) => {
  const { storage } = freshStorage(t);
  const filename = await storage.saveBlob(Buffer.from('x'), 'png');
  assert.equal(await storage.blobExists(filename), true);
  assert.equal(await storage.blobExists('gen-0000000000000-deadbeef.png'), false);
  assert.equal(await storage.blobExists(''), false);
});

test('readBlob 路径穿越防护：../ 不得读到 blobs 目录外的文件', { skip: HAS_READ_BLOB ? false : SKIP_NOT_IMPLEMENTED }, async (t) => {
  const { storage, dir } = freshStorage(t);
  // 在 blobs 外（DATA_DIR 根目录）放一个“机密”文件
  const secret = Buffer.from('top-secret-not-a-blob');
  fs.writeFileSync(path.join(dir, 'secret.txt'), secret);
  for (const evil of ['../secret.txt', '../../secret.txt', path.join(dir, 'secret.txt')]) {
    let result = null;
    let threw = false;
    try {
      result = await storage.readBlob(evil);
    } catch (_) {
      threw = true; // 抛错也是正确的防护方式
    }
    if (!threw && result != null) {
      assert.notDeepEqual(Buffer.from(result), secret, `readBlob(${evil}) 读到了 blobs 外的文件`);
    }
  }
});

test('getBackendName：默认 local，STORAGE_BACKEND=local 时也是 local', { skip: HAS_BACKEND_NAME ? false : SKIP_NOT_IMPLEMENTED }, async (t) => {
  const { storage } = freshStorage(t, { backend: undefined }); // 不设 STORAGE_BACKEND，测默认值
  assert.equal(await storage.getBackendName(), 'local');
  const second = freshStorage(t, { backend: 'local' });
  assert.equal(await second.storage.getBackendName(), 'local');
});
