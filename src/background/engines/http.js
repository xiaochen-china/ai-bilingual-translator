/**
 * 外部请求的薄封装：统一超时、取消、错误归一化。
 * 所有外部 API 调用都必须经过这里，且只在 Service Worker 中执行。
 */

import { AppError, ERROR_CODES } from '../../common/protocol.js';

export const DEFAULT_TIMEOUT_MS = 20000;

/**
 * 带超时与外部取消的 fetch。
 * @param {string} url
 * @param {RequestInit} options
 * @param {{timeoutMs?: number, signal?: AbortSignal}} context
 */
export async function httpFetch(url, options = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, signal } = {}) {
  const controller = new AbortController();
  let timedOut = false;
  let aborted = false;

  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1000, timeoutMs));

  const onAbort = () => {
    aborted = true;
    controller.abort();
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (timedOut) {
      throw new AppError(ERROR_CODES.TIMEOUT, `请求超时（${Math.round(timeoutMs / 1000)} 秒）`);
    }
    if (aborted || error?.name === 'AbortError') {
      throw new AppError(ERROR_CODES.ABORTED, '翻译任务已取消');
    }
    throw new AppError(ERROR_CODES.HTTP_ERROR, `网络请求失败：${error?.message || error}`);
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** 校验响应状态，把 4xx/5xx 归一化成可读的中文错误 */
export async function ensureOk(response, label) {
  if (response.ok) return response;
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  if (response.status === 401 || response.status === 403) {
    throw new AppError(ERROR_CODES.AUTH_ERROR, `${label} 鉴权失败（HTTP ${response.status}），请检查 API Key、余额与区域设置。`, {
      status: response.status,
      detail,
    });
  }
  if (response.status === 429) {
    throw new AppError(ERROR_CODES.RATE_LIMIT, `${label} 请求过于频繁或额度不足（HTTP 429），请稍后重试。`, {
      status: response.status,
      detail,
    });
  }
  throw new AppError(ERROR_CODES.HTTP_ERROR, `${label} 请求失败（HTTP ${response.status}）。`, {
    status: response.status,
    detail,
  });
}

/** 读取 JSON，失败时抛出统一错误而不是原始 SyntaxError */
export async function readJson(response, label) {
  try {
    return await response.json();
  } catch {
    throw new AppError(ERROR_CODES.INVALID_RESPONSE, `${label} 返回了无法解析的内容。`);
  }
}

/**
 * 判断错误是否值得重试：网络错误、超时、429、5xx 重试；
 * 鉴权失败与参数错误不重试，避免无意义消耗。
 */
export function isRetryable(error) {
  if (!(error instanceof AppError)) return false;
  if (error.code === ERROR_CODES.TIMEOUT) return true;
  if (error.code === ERROR_CODES.RATE_LIMIT) return true;
  if (error.code === ERROR_CODES.HTTP_ERROR) {
    const status = error.details?.status;
    if (typeof status === 'number') return status >= 500;
    return true; // 网络层失败（没有 status）
  }
  return false;
}

/** 简单的串行节流器：保证同一引擎的请求间隔不小于 intervalMs */
export function createThrottle(intervalMs = 120) {
  let last = 0;
  let chain = Promise.resolve();
  return function throttle() {
    chain = chain.then(async () => {
      const wait = Math.max(0, last + intervalMs - Date.now());
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      last = Date.now();
    });
    return chain;
  };
}