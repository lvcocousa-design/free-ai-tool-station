// lib/s3.js — 最小 S3 兼容客户端（零新增依赖）
//
// 只用全局 fetch + node:crypto + node:net，实现 SigV4 签名与
// getObject / putObject / headObject / listObjects 四个操作，供 lib/storage.js 的
// S3 后端使用。兼容 Cloudflare R2、AWS S3、GCS 互通、MinIO 等。
//
// 寻址方式：
//   - 默认 virtual-hosted style：https://<bucket>.<host>/<key>
//     （R2、GCS 互通、AWS S3 都用这个）
//   - endpoint 主机是 localhost / *.localhost / IP 地址时自动用 path-style：
//     https://<host>/<bucket>/<key>（virtual-hosted 下 bucket.localhost
//     无法解析，IP 地址也无法做子域名）
//   - 环境变量 S3_FORCE_PATH_STYLE=true 可强制 path-style（或在
//     createS3Client 的 options 里传 forcePathStyle: true）。
//
// 错误：HTTP 错误抛中文 Error，并挂 .status（HTTP 状态码）与
// .code（S3 XML 错误码，如 NoSuchKey / NoSuchBucket，没有则为 undefined），
// 供调用方区分“对象不存在”（404）与其他错误。网络错误同样抛中文 Error。

const crypto = require('node:crypto');
const net = require('node:net');

const GET_TIMEOUT_MS = 30 * 1000;
const PUT_TIMEOUT_MS = 120 * 1000; // 生成文件（视频）可能较大，放宽上传超时

function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmac(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

/** Date → '20261119T123456Z'（UTC）。 */
function formatAmzDate(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
    `T${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
}

/** RFC 3986 编码：encodeURIComponent 之外再编码 !'()*（SigV4 规范要求）。 */
function encodeRfc3986(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** 规范 URI：逐段编码，'/' 保留。 */
function encodeUriPath(pathname) {
  return pathname.split('/').map((segment) => encodeRfc3986(segment)).join('/');
}

/** 规范查询串：按名再按值排序后编码；无参数返回空串。 */
function canonicalQueryString(searchParams) {
  const entries = [...searchParams.entries()];
  entries.sort((a, b) => {
    if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
    if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
    return 0;
  });
  return entries.map(([k, v]) => `${encodeRfc3986(k)}=${encodeRfc3986(v)}`).join('&');
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate = hmac(`AWS4${secretKey}`, dateStamp);
  const kRegion = hmac(kDate, region);
  const kService = hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/**
 * SigV4 签名（纯函数，不联网；给定 datetime 时结果确定）。
 *
 * @param {object} opts
 * @param {string} opts.method - HTTP 方法，如 'GET' | 'PUT' | 'HEAD'
 * @param {string} opts.url - 完整请求 URL（可带查询串）
 * @param {object} [opts.headers] - 需要一并签名的额外请求头
 *   （如 {'Content-Type': 'application/json'}；host、X-Amz-Date、
 *   X-Amz-Content-Sha256 由本函数自动计算并签名，不用传）
 * @param {Buffer|string} [opts.body] - 请求体（无请求体时按空字节算）
 * @param {string} opts.accessKey
 * @param {string} opts.secretKey
 * @param {string} opts.region - 如 'auto'（R2）或 'us-east-1'
 * @param {string} [opts.service='s3']
 * @param {Date} [opts.datetime=new Date()]
 * @returns {{Authorization: string, 'X-Amz-Date': string, 'X-Amz-Content-Sha256': string}}
 *   要设置的请求头（调用方再与 Content-Type 等其他头合并后发出请求）
 */
function signV4({
  method,
  url,
  headers = {},
  body,
  accessKey,
  secretKey,
  region,
  service = 's3',
  datetime = new Date(),
}) {
  const parsed = new URL(url);
  const amzDate = formatAmzDate(datetime);
  const dateStamp = amzDate.slice(0, 8);
  const payloadHash = sha256Hex(body ? Buffer.from(body) : Buffer.alloc(0));

  // 签名头集合：host、x-amz-content-sha256、x-amz-date + 调用方传入的额外头
  // （额外头里与自动头重名的会被自动头覆盖，不重复签名）。
  const signedMap = new Map();
  for (const [name, value] of Object.entries(headers)) {
    const lower = String(name).toLowerCase().trim();
    if (lower === 'host' || lower === 'x-amz-date' || lower === 'x-amz-content-sha256'
      || lower === 'authorization') continue;
    signedMap.set(lower, String(value).trim().replace(/\s+/g, ' '));
  }
  signedMap.set('host', parsed.host);
  signedMap.set('x-amz-content-sha256', payloadHash);
  signedMap.set('x-amz-date', amzDate);
  const sortedNames = [...signedMap.keys()].sort();
  const signedHeaders = sortedNames.join(';');
  const canonicalHeaders = sortedNames.map((n) => `${n}:${signedMap.get(n)}\n`).join('');

  const canonicalRequest = [
    String(method).toUpperCase(),
    encodeUriPath(parsed.pathname || '/'),
    canonicalQueryString(parsed.searchParams),
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    sha256Hex(canonicalRequest),
  ].join('\n');

  const signingKey = getSignatureKey(secretKey, dateStamp, region, service);
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  return {
    Authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Content-Sha256': payloadHash,
  };
}

/** 从 S3 错误响应体（XML）里提取 <Code>，提取不到返回 undefined。 */
function extractErrorCode(bodyText) {
  if (!bodyText) return undefined;
  const match = /<Code>([^<]+)<\/Code>/.exec(bodyText);
  return match ? match[1] : undefined;
}

function s3Error(message, status, code) {
  const err = new Error(message);
  if (status) err.status = status;
  if (code) err.code = code;
  return err;
}

function isLocalOrIpHost(hostname) {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || net.isIP(hostname) !== 0;
}

/** 从 ListObjectsV2 响应 XML 里解出对象列表与分页信息（正则解析，无 XML 库）。 */
function parseListObjectsXml(xml) {
  const decodeEntities = (s) => s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
  const objects = [];
  const contentRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentRe.exec(xml)) !== null) {
    const keyMatch = /<Key>([\s\S]*?)<\/Key>/.exec(match[1]);
    const sizeMatch = /<Size>(\d+)<\/Size>/.exec(match[1]);
    if (keyMatch && sizeMatch) {
      objects.push({ key: decodeEntities(keyMatch[1]), size: Number(sizeMatch[1]) });
    }
  }
  const truncatedMatch = /<IsTruncated>(true|false)<\/IsTruncated>/.exec(xml);
  const tokenMatch = /<NextContinuationToken>([\s\S]*?)<\/NextContinuationToken>/.exec(xml);
  return {
    objects,
    isTruncated: truncatedMatch ? truncatedMatch[1] === 'true' : false,
    nextContinuationToken: tokenMatch ? decodeEntities(tokenMatch[1]) : null,
  };
}

/**
 * 创建最小 S3 客户端。
 *
 * @param {object} opts
 * @param {string} opts.endpoint - S3 API 端点，须带协议，如
 *   'https://<账号ID>.r2.cloudflarestorage.com'（R2）、
 *   'https://s3.us-east-1.amazonaws.com'（AWS S3）、
 *   'http://127.0.0.1:9000'（本地 MinIO）；不带协议时默认补 https://。
 *   只取 origin 部分（协议 + 主机 + 端口），路径部分会被忽略。
 * @param {string} opts.bucket
 * @param {string} opts.accessKey
 * @param {string} opts.secretKey
 * @param {string} [opts.region='auto'] - R2 用 'auto'；AWS S3 填桶所在区域
 * @param {boolean} [opts.forcePathStyle] - 为 true 时强制 path-style；
 *   不传时按环境变量 S3_FORCE_PATH_STYLE 与 endpoint 主机自动判断
 * @returns {{getObject, putObject, headObject, listObjects}}
 */
function createS3Client({ endpoint, bucket, accessKey, secretKey, region = 'auto', forcePathStyle }) {
  const missing = [];
  if (!endpoint) missing.push('endpoint');
  if (!bucket) missing.push('bucket');
  if (!accessKey) missing.push('accessKey');
  if (!secretKey) missing.push('secretKey');
  if (missing.length) {
    throw new Error(`创建 S3 客户端缺少必要参数：${missing.join('、')}`);
  }

  let normalizedEndpoint = String(endpoint).trim().replace(/\/+$/, '');
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(normalizedEndpoint)) {
    normalizedEndpoint = `https://${normalizedEndpoint}`;
  }
  let parsed;
  try {
    parsed = new URL(normalizedEndpoint);
  } catch (_) {
    throw new Error(`S3 端点地址格式不正确：${endpoint}`);
  }
  const origin = parsed.origin;
  const hostname = parsed.hostname;

  const usePathStyle = forcePathStyle === true
    || (forcePathStyle !== false && process.env.S3_FORCE_PATH_STYLE === 'true')
    || isLocalOrIpHost(hostname);

  /** key → 完整请求 URL（key 按段编码，'/' 保留）。 */
  function buildUrl(key) {
    const encodedKey = String(key).split('/').map((s) => encodeRfc3986(s)).join('/');
    if (usePathStyle) {
      return `${origin}/${encodeRfc3986(bucket)}/${encodedKey}`;
    }
    return `${parsed.protocol}//${encodeRfc3986(bucket)}.${parsed.host}/${encodedKey}`;
  }

  /** 桶根 URL（不带 key），供 ListObjectsV2 用。 */
  function buildBucketUrl() {
    if (usePathStyle) {
      return `${origin}/${encodeRfc3986(bucket)}/`;
    }
    return `${parsed.protocol}//${encodeRfc3986(bucket)}.${parsed.host}/`;
  }

  /**
   * 发一次签名请求（完整 URL 版）。HTTP 错误抛中文 Error（挂 .status / .code）；
   * 网络错误（DNS、拒绝连接、超时）同样抛中文 Error。
   */
  async function requestUrl(method, url, { body, contentType, timeoutMs, label }) {
    const extraHeaders = contentType ? { 'Content-Type': contentType } : {};
    const signed = signV4({
      method,
      url,
      headers: extraHeaders,
      body,
      accessKey,
      secretKey,
      region,
    });
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { ...extraHeaders, ...signed },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw s3Error(`S3 请求超时（${method} ${label}，${timeoutMs / 1000} 秒无响应），请检查网络或端点是否正确`);
      }
      const detail = (err && err.cause && err.cause.code)
        ? `（${err.cause.code}）`
        : (err && err.message ? `：${err.message}` : '');
      throw s3Error(`无法连接 S3 端点 ${origin}${detail}，请检查 S3_ENDPOINT 是否正确、网络是否通畅`);
    }

    if (!res.ok) {
      let bodyText = '';
      try {
        bodyText = (await res.text()).slice(0, 500);
      } catch (_) { /* 读错误体失败时不影响主错误 */ }
      const code = extractErrorCode(bodyText);
      if (res.status === 404) {
        throw s3Error(`S3 对象不存在：${label}`, 404, code || 'NoSuchKey');
      }
      const codeNote = code ? `（${code}）` : '';
      const bodyNote = bodyText && !code ? `：${bodyText.slice(0, 200)}` : '';
      throw s3Error(`S3 请求失败（${method} ${label}）：HTTP ${res.status}${codeNote}${bodyNote}`, res.status, code);
    }
    return res;
  }

  /**
   * 发一次签名请求（对象 key 版）。HTTP 错误抛中文 Error（挂 .status / .code）；
   * 网络错误（DNS、拒绝连接、超时）同样抛中文 Error。
   */
  async function request(method, key, { body, contentType, timeoutMs }) {
    return requestUrl(method, buildUrl(key), { body, contentType, timeoutMs, label: key });
  }

  /** 读对象内容；不存在抛 status=404 的 Error。 */
  async function getObject(key) {
    const res = await request('GET', key, { timeoutMs: GET_TIMEOUT_MS });
    return Buffer.from(await res.arrayBuffer());
  }

  /** 写对象；contentType 为空时默认 application/octet-stream。 */
  async function putObject(key, buffer, contentType) {
    await request('PUT', key, {
      body: Buffer.from(buffer),
      contentType: contentType || 'application/octet-stream',
      timeoutMs: PUT_TIMEOUT_MS,
    });
  }

  /** 对象是否存在：存在 true，不存在 false，其他错误抛错。 */
  async function headObject(key) {
    try {
      await request('HEAD', key, { timeoutMs: GET_TIMEOUT_MS });
      return true;
    } catch (err) {
      if (err && err.status === 404) return false;
      throw err;
    }
  }

  /**
   * 列出指定前缀下的全部对象（ListObjectsV2，自动分页跟进
   * continuation-token）。返回 [{key, size}]，按 S3 返回顺序排列。
   * prefix 为空字符串时列出整个桶。注意：ListObjects 是 Class A 操作，
   * 调用方应缓存结果，不要每个请求都列一遍。
   */
  async function listObjects(prefix = '') {
    const all = [];
    let continuationToken = null;
    do {
      const params = new URLSearchParams();
      params.set('list-type', '2');
      params.set('prefix', String(prefix || ''));
      params.set('max-keys', '1000');
      if (continuationToken) params.set('continuation-token', continuationToken);
      const res = await requestUrl('GET', `${buildBucketUrl()}?${params.toString()}`, {
        timeoutMs: GET_TIMEOUT_MS,
        label: `列对象（前缀 ${prefix || '（全部）'}）`,
      });
      const xml = await res.text();
      const page = parseListObjectsXml(xml);
      all.push(...page.objects);
      continuationToken = page.isTruncated ? page.nextContinuationToken : null;
      // 防御：服务端声称还有下一页却没给 token 时停止，避免死循环。
      if (page.isTruncated && !continuationToken) break;
    } while (continuationToken);
    return all;
  }

  return { getObject, putObject, headObject, listObjects };
}

module.exports = { signV4, createS3Client };
