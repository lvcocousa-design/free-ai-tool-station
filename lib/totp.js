// lib/totp.js — TOTP 二次验证（RFC 6238，零新依赖，只用 node:crypto）
//
// - 算法：HMAC-SHA1，30 秒一步，6 位动态码；校验时容忍前后各一步（±1，
//   覆盖手机与服务端时钟几十秒的偏差）。
// - 密钥：20 随机字节，Base32（RFC 4648，大写无填充）存放与展示；
//   otpauth:// 链接可直接粘进验证器 App 手动添加（本站不生成二维码，
//   避免把密钥发给第三方二维码服务）。
// - 备用码：开启时一次生成 8 个，一次性使用；服务端只存 SHA-256 哈希，
//   明文只在开启成功那一刻展示一次，丢了只能重新开启生成新的。
// - 比对一律常量时间（timingSafeEqual），不泄露哪一位对、哪一位错。

const crypto = require('crypto');

const STEP_SECONDS = 30;
const DIGITS = 6;
const WINDOW_STEPS = 1;
const SECRET_BYTES = 20;
const BACKUP_CODE_COUNT = 8;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
// 备用码字符集：去掉易混的 0/O、1/I/L。
const BACKUP_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Buffer → Base32（大写，无填充）。 */
function base32Encode(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

/** Base32 → Buffer（接受大小写与填充 =，非法字符抛错）。 */
function base32Decode(str) {
  if (typeof str !== 'string') throw new Error('密钥必须是字符串');
  const clean = str.trim().replace(/=+$/, '').toUpperCase();
  if (clean.length === 0) throw new Error('密钥为空');
  let bits = 0;
  let value = 0;
  const bytes = [];
  for (const ch of clean) {
    const idx = BASE32_ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('密钥含有非法字符');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** 生成一个随机密钥（Base32 字符串）。 */
function generateSecret(bytes = SECRET_BYTES) {
  return base32Encode(crypto.randomBytes(bytes));
}

/** 某一步（计数器值）的 6 位动态码。 */
function codeForStep(secretKey, step) {
  const key = base32Decode(secretKey);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 当前时刻的动态码（nowMs 可注入，便于测试）。 */
function generateCode(secret, nowMs = Date.now()) {
  const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
  return codeForStep(secret, step);
}

/** 校验动态码：当前步 ±1 步内任一匹配即通过；非 6 位数字直接拒绝。 */
function verifyCode(secret, code, nowMs = Date.now(), window = WINDOW_STEPS) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return false;
  let key;
  try {
    key = base32Decode(secret);
  } catch (_) {
    return false;
  }
  const step = Math.floor(nowMs / 1000 / STEP_SECONDS);
  const candidate = Buffer.from(code, 'utf8');
  for (let d = -window; d <= window; d++) {
    const expected = codeForStepWithKey(key, step + d);
    if (crypto.timingSafeEqual(candidate, Buffer.from(expected, 'utf8'))) return true;
  }
  return false;
}

/** codeForStep 的已解码密钥版（避免校验窗口内重复解码）。 */
function codeForStepWithKey(key, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', key).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = ((hmac[offset] & 0x7f) << 24)
    | ((hmac[offset + 1] & 0xff) << 16)
    | ((hmac[offset + 2] & 0xff) << 8)
    | (hmac[offset + 3] & 0xff);
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

/** 拼 otpauth:// 链接（验证器 App 手动添加时可直接粘贴）。 */
function buildOtpAuthUrl({ secret, account = 'free-ai-tool-station', issuer = '免费AI工具站' }) {
  const label = `${issuer}:${account}`;
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(label)}?${params.toString()}`;
}

/** 生成 count 个备用码（格式 XXXX-XXXX），明文只应展示一次。 */
function generateBackupCodes(count = BACKUP_CODE_COUNT) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    let raw = '';
    for (let j = 0; j < 8; j++) {
      raw += BACKUP_ALPHABET[crypto.randomInt(BACKUP_ALPHABET.length)];
    }
    codes.push(`${raw.slice(0, 4)}-${raw.slice(4)}`);
  }
  return codes;
}

/** 备用码归一化：去连字符/空格，转大写。 */
function normalizeBackupCode(code) {
  return typeof code === 'string' ? code.replace(/[-\s]/g, '').toUpperCase() : '';
}

/** 备用码的存储哈希（SHA-256 十六进制）。 */
function hashBackupCode(code) {
  return crypto.createHash('sha256').update(normalizeBackupCode(code), 'utf8').digest('hex');
}

/**
 * 在哈希列表里找与输入备用码匹配的一项，返回该哈希（供调用方消费删除），
 * 无匹配返回 null。逐项常量时间比对。
 */
function findBackupCodeHash(hashes, code) {
  if (!Array.isArray(hashes)) return null;
  const normalized = normalizeBackupCode(code);
  if (!/^[A-Z0-9]{8}$/.test(normalized)) return null;
  const candidate = Buffer.from(hashBackupCode(code), 'utf8');
  for (const hash of hashes) {
    if (typeof hash !== 'string' || hash.length !== candidate.length) continue;
    if (crypto.timingSafeEqual(candidate, Buffer.from(hash, 'utf8'))) return hash;
  }
  return null;
}

/**
 * 恢复口子是否打开：环境变量 TOTP_DISABLE=1 时登录跳过二次验证，
 * 供“验证器与备用码全丢”时恢复用；用完应立即删掉该变量并重新开启。
 */
function isTotpBypassed() {
  return process.env.TOTP_DISABLE === '1';
}

module.exports = {
  STEP_SECONDS,
  DIGITS,
  WINDOW_STEPS,
  SECRET_BYTES,
  BACKUP_CODE_COUNT,
  base32Encode,
  base32Decode,
  generateSecret,
  codeForStep,
  generateCode,
  verifyCode,
  buildOtpAuthUrl,
  generateBackupCodes,
  normalizeBackupCode,
  hashBackupCode,
  findBackupCodeHash,
  isTotpBypassed,
};
