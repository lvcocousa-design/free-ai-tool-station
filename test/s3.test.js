// test/s3.test.js — S3 SigV4 签名单元测试（lib/s3.js，纯函数，不联网）
//
// 按存储接口契约写：signV4 给定 datetime 结果确定；createS3Client 只测
// 返回对象的形状（getObject/putObject/headObject 均为函数），绝不发真实请求。
// lib/s3.js 尚未实现时全部用例 skip（存储代理重构落地后自动生效）。

const test = require('node:test');
const assert = require('node:assert/strict');

let s3 = null;
try {
  s3 = require('../lib/s3');
} catch (_) {
  s3 = null; // 文件尚未实现，见 skip 说明
}

const SKIP_NOT_IMPLEMENTED = 'lib/s3.js 尚未实现（存储代理重构未落地），待实现后自动生效';
const skipIfMissing = s3 ? false : SKIP_NOT_IMPLEMENTED;

// 固定输入：假凭据 + 假地址，不联网
const FIXED_DATE = new Date('2024-01-15T12:00:00.000Z');
const BASE_INPUT = {
  method: 'PUT',
  url: 'https://fake-s3.example.com/fake-bucket/test-object.json',
  headers: { 'Content-Type': 'application/json' },
  body: '{"hello":"world"}',
  accessKey: 'fake-access-key-id',
  secretKey: 'fake-secret-key-xxx',
  region: 'us-east-1',
  datetime: FIXED_DATE,
};

test('signV4：同输入同输出（固定 datetime 结果确定）', { skip: skipIfMissing }, () => {
  const first = s3.signV4({ ...BASE_INPUT });
  const second = s3.signV4({ ...BASE_INPUT });
  assert.deepEqual(first, second);
  assert.equal(typeof first, 'object');
});

test('signV4：Authorization 头格式为 AWS4-HMAC-SHA256，含 Credential 作用域、SignedHeaders、64 位十六进制 Signature', { skip: skipIfMissing }, () => {
  const headers = s3.signV4({ ...BASE_INPUT });
  const auth = headers.Authorization || headers.authorization;
  assert.equal(typeof auth, 'string');
  assert.ok(auth.startsWith('AWS4-HMAC-SHA256 '), `Authorization 应以 AWS4-HMAC-SHA256 开头，实际：${auth}`);
  assert.match(auth, /Credential=fake-access-key-id\/20240115\/us-east-1\/s3\/aws4_request/);
  assert.match(auth, /SignedHeaders=[a-z0-9;-]+/);
  const sigMatch = auth.match(/Signature=([0-9a-f]+)/);
  assert.ok(sigMatch, `Authorization 应含 Signature，实际：${auth}`);
  assert.equal(sigMatch[1].length, 64, 'Signature 应为 64 位十六进制');
  // SignedHeaders 至少包含 host
  const signedHeaders = auth.match(/SignedHeaders=([^,]+)/)[1].split(';');
  assert.ok(signedHeaders.includes('host'), `SignedHeaders 应包含 host，实际：${signedHeaders.join(';')}`);
});

test('signV4：body 不同，签名不同', { skip: skipIfMissing }, () => {
  const a = s3.signV4({ ...BASE_INPUT, body: '{"hello":"world"}' });
  const b = s3.signV4({ ...BASE_INPUT, body: '{"hello":"different"}' });
  assert.notEqual(a.Authorization, b.Authorization);
});

test('signV4：datetime 不同，签名不同', { skip: skipIfMissing }, () => {
  const a = s3.signV4({ ...BASE_INPUT, datetime: new Date('2024-01-15T12:00:00.000Z') });
  const b = s3.signV4({ ...BASE_INPUT, datetime: new Date('2024-01-16T12:00:00.000Z') });
  assert.notEqual(a.Authorization, b.Authorization);
});

test('signV4：X-Amz-Date 格式为 YYYYMMDDTHHMMSSZ，与给定 datetime 一致', { skip: skipIfMissing }, () => {
  const headers = s3.signV4({ ...BASE_INPUT });
  const amzDate = headers['X-Amz-Date'] || headers['x-amz-date'];
  assert.equal(amzDate, '20240115T120000Z');
  assert.match(amzDate, /^\d{8}T\d{6}Z$/);
});

test('signV4：不修改调用方传入的 headers 对象', { skip: skipIfMissing }, () => {
  const headers = { 'Content-Type': 'application/json' };
  s3.signV4({ ...BASE_INPUT, headers });
  assert.deepEqual(headers, { 'Content-Type': 'application/json' });
});

test('createS3Client：返回 {getObject, putObject, headObject} 三个函数（只测形状，不联网）', { skip: skipIfMissing }, () => {
  assert.equal(typeof s3.createS3Client, 'function');
  const client = s3.createS3Client({
    endpoint: 'https://fake-s3.example.com',
    bucket: 'fake-bucket',
    accessKey: 'fake-access-key-id',
    secretKey: 'fake-secret-key-xxx',
    region: 'us-east-1',
  });
  assert.equal(typeof client.getObject, 'function');
  assert.equal(typeof client.putObject, 'function');
  assert.equal(typeof client.headObject, 'function');
});
