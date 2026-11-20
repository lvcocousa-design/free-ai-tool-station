// test/totp.test.js — TOTP 二次验证（lib/totp.js）
//
// RFC 6238 官方测试向量（SHA1，密钥 ASCII "12345678901234567890"，
// Base32 为 GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ；RFC 给的是 8 位码，
// 本站用 6 位，取后 6 位；以下值以 RFC 原文 Appendix B 为准）：
//   T=59 → 94287082 → 287082
//   T=1111111109 → 07081804 → 081804
//   T=1111111111 → 14050471 → 050471
//   T=1234567890 → 89005924 → 005924
//   T=2000000000 → 69279037 → 279037
//   T=20000000000 → 65353130 → 353130

const test = require('node:test');
const assert = require('node:assert/strict');
const totp = require('../lib/totp');
const { withEnv } = require('./helpers');

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('Base32：编解码往返 + 已知值', () => {
  const ascii = Buffer.from('12345678901234567890', 'ascii');
  assert.equal(totp.base32Encode(ascii), RFC_SECRET);
  assert.deepEqual(totp.base32Decode(RFC_SECRET), ascii);
  // 小写与填充 = 也接受
  assert.deepEqual(totp.base32Decode('gezdgnbvgy3tqojqgezdgnbvgy3tqojq===='), ascii);
  assert.throws(() => totp.base32Decode('ABC!DEF'), /非法字符/);
  assert.throws(() => totp.base32Decode(''), /为空/);
});

test('RFC 6238 测试向量（6 位码）', () => {
  const vectors = [
    [59, '287082'],
    [1111111109, '081804'],
    [1111111111, '050471'],
    [1234567890, '005924'],
    [2000000000, '279037'],
    [20000000000, '353130'],
  ];
  for (const [seconds, expected] of vectors) {
    assert.equal(totp.generateCode(RFC_SECRET, seconds * 1000), expected, `T=${seconds}`);
  }
});

test('verifyCode：当前步通过，前后各一步通过，两步外拒绝', () => {
  const now = 1234567890 * 1000;
  const current = totp.generateCode(RFC_SECRET, now);
  assert.equal(totp.verifyCode(RFC_SECRET, current, now), true);
  // 前一步 / 后一步的码也通过（±1 窗口）
  assert.equal(totp.verifyCode(RFC_SECRET, totp.generateCode(RFC_SECRET, now - 30000), now), true);
  assert.equal(totp.verifyCode(RFC_SECRET, totp.generateCode(RFC_SECRET, now + 30000), now), true);
  // 两步外的码拒绝
  assert.equal(totp.verifyCode(RFC_SECRET, totp.generateCode(RFC_SECRET, now - 60000), now), false);
  assert.equal(totp.verifyCode(RFC_SECRET, totp.generateCode(RFC_SECRET, now + 60000), now), false);
  // 错误码、非 6 位、非法密钥都拒绝
  assert.equal(totp.verifyCode(RFC_SECRET, '000000', now), false);
  assert.equal(totp.verifyCode(RFC_SECRET, '12345', now), false);
  assert.equal(totp.verifyCode(RFC_SECRET, '1234567', now), false);
  assert.equal(totp.verifyCode(RFC_SECRET, 'abcdef', now), false);
  assert.equal(totp.verifyCode('NOT!BASE32', current, now), false);
});

test('generateSecret：32 位 Base32，解码 20 字节，每次不同', () => {
  const a = totp.generateSecret();
  const b = totp.generateSecret();
  assert.match(a, /^[A-Z2-7]{32}$/);
  assert.equal(totp.base32Decode(a).length, 20);
  assert.notEqual(a, b);
});

test('buildOtpAuthUrl：otpauth 链接含密钥与参数', () => {
  const url = totp.buildOtpAuthUrl({ secret: RFC_SECRET, account: 'test' });
  assert.ok(url.startsWith('otpauth://totp/'));
  assert.ok(url.includes(`secret=${RFC_SECRET}`));
  assert.ok(url.includes('algorithm=SHA1'));
  assert.ok(url.includes('digits=6'));
  assert.ok(url.includes('period=30'));
});

test('备用码：8 个、格式 XXXX-XXXX、唯一；哈希查找与归一化', () => {
  const codes = totp.generateBackupCodes();
  assert.equal(codes.length, 8);
  for (const c of codes) assert.match(c, /^[A-Z0-9]{4}-[A-Z0-9]{4}$/);
  assert.equal(new Set(codes).size, 8);
  const hashes = codes.map((c) => totp.hashBackupCode(c));
  // 明文、去连字符、小写都能找回同一哈希
  assert.equal(totp.findBackupCodeHash(hashes, codes[0]), hashes[0]);
  assert.equal(totp.findBackupCodeHash(hashes, codes[0].replace('-', '')), hashes[0]);
  assert.equal(totp.findBackupCodeHash(hashes, codes[0].toLowerCase()), hashes[0]);
  // 错误码、格式不对都找不到
  assert.equal(totp.findBackupCodeHash(hashes, 'ZZZZ-ZZZZ'), null);
  assert.equal(totp.findBackupCodeHash(hashes, 'short'), null);
  assert.equal(totp.findBackupCodeHash(hashes, ''), null);
  // 哈希本身不是明文
  assert.ok(!hashes[0].includes(codes[0].slice(0, 4)));
});

test('isTotpBypassed：未设变量时 false', (t) => {
  withEnv(t, { TOTP_DISABLE: undefined });
  assert.equal(totp.isTotpBypassed(), false);
});

test('isTotpBypassed：TOTP_DISABLE=1 时 true，其他值 false', (t) => {
  withEnv(t, { TOTP_DISABLE: '1' });
  assert.equal(totp.isTotpBypassed(), true);
});

test('isTotpBypassed：TOTP_DISABLE=true 不认', (t) => {
  withEnv(t, { TOTP_DISABLE: 'true' });
  assert.equal(totp.isTotpBypassed(), false);
});
