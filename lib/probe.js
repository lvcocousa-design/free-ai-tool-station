// lib/probe.js — 供应商连接探测的公共辅助
//
// 原在 lib/routes/wizard.js；供应商插件化时下沉到这里，供各供应商模块的
// test() 使用（各 test 只需一行 probe 调用，不必各自复制错误翻译逻辑）。
// probe() 本身不抛错：fetch 成功且 2xx 返回 {ok:true}，否则返回
// {ok:false, message: 中文原因}。

const TIMEOUT_MS = 15000;

/**
 * 把 fetch 错误/HTTP 状态翻译成中文原因。
 * 401/403 → Key 无效或未授权；超时 → 请求超时；其他网络错 → 网络错误。
 * timeoutMs 只用于超时文案里的秒数（默认 15 秒）。
 */
function probeErrorMessage(err, status, timeoutMs = TIMEOUT_MS) {
  if (status === 401 || status === 403) return 'Key 无效或未授权，请检查 Key 是否正确';
  if (status) return `上游返回 HTTP ${status}，请稍后重试`;
  if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    const seconds = Math.max(1, Math.round(timeoutMs / 1000));
    return `连接超时（${seconds} 秒），请检查网络或稍后重试`;
  }
  if (err && err.cause && err.cause.code) {
    const code = err.cause.code;
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '无法解析上游域名，请检查网络或地址是否正确';
    if (code === 'ECONNREFUSED') return '上游拒绝连接，请检查地址是否正确或服务是否在线';
    return `网络错误（${code}），请检查网络或稍后重试`;
  }
  return '连接失败，请检查网络或稍后重试';
}

/** 统一走一遍探测：fetch 成功且 status 2xx 视为通过；默认 15 秒超时。
 *  timeoutMs 可选：做真实推理的探测（如 NVIDIA 的最小对话）可传更长的值。 */
async function probe(url, options, timeoutMs = TIMEOUT_MS) {
  try {
    const res = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    if (res.ok) return { ok: true };
    return { ok: false, message: probeErrorMessage(null, res.status, timeoutMs) };
  } catch (err) {
    return { ok: false, message: probeErrorMessage(err, null, timeoutMs) };
  }
}

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

module.exports = { probe, probeErrorMessage, bearer, TIMEOUT_MS };
