/**
 * 消息协议：内容脚本与 Service Worker 之间的统一信封格式。
 * 协议带版本号，便于后续扩展而不破坏旧版内容脚本。
 */

import { PROTOCOL_VERSION } from './constants.js';

export const ERROR_CODES = Object.freeze({
  NO_API_KEY: 'NO_API_KEY',
  HTTP_ERROR: 'HTTP_ERROR',
  AUTH_ERROR: 'AUTH_ERROR',
  RATE_LIMIT: 'RATE_LIMIT',
  TIMEOUT: 'TIMEOUT',
  ABORTED: 'ABORTED',
  INVALID_RESPONSE: 'INVALID_RESPONSE',
  ENGINE_DISABLED: 'ENGINE_DISABLED',
  PERMISSION_DENIED: 'PERMISSION_DENIED',
  INVALID_REQUEST: 'INVALID_REQUEST',
  UNKNOWN: 'UNKNOWN',
});

/** 统一的业务错误对象，便于内容脚本区分「需要用户配置」与「临时失败」 */
export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details };
  }
}

export function toAppError(error) {
  if (error instanceof AppError) return error;
  if (error?.name === 'AbortError') {
    return new AppError(ERROR_CODES.ABORTED, '请求已取消');
  }
  if (error instanceof TypeError) {
    // fetch 网络失败通常抛出 TypeError
    return new AppError(ERROR_CODES.HTTP_ERROR, `网络请求失败：${error.message}`);
  }
  return new AppError(ERROR_CODES.UNKNOWN, error?.message || String(error));
}

export function makeMessage(type, payload = {}, id = null) {
  return {
    v: PROTOCOL_VERSION,
    type,
    id: id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    payload,
  };
}

export function makeResponse(request, payload = {}) {
  return {
    v: PROTOCOL_VERSION,
    type: `${request.type}:result`,
    id: request.id,
    ok: true,
    payload,
  };
}

export function makeErrorResponse(request, error) {
  const appError = toAppError(error);
  return {
    v: PROTOCOL_VERSION,
    type: `${request.type}:result`,
    id: request?.id ?? null,
    ok: false,
    error: appError.toJSON(),
  };
}

/**
 * 校验消息信封。返回 { ok, reason }。
 * 版本不一致时明确拒绝，避免新旧版本混跑导致难以排查的问题。
 */
export function validateEnvelope(message) {
  if (!message || typeof message !== 'object') {
    return { ok: false, reason: 'INVALID_MESSAGE' };
  }
  if (typeof message.type !== 'string' || message.type.length === 0) {
    return { ok: false, reason: 'MISSING_TYPE' };
  }
  if (message.v !== PROTOCOL_VERSION) {
    return { ok: false, reason: 'VERSION_MISMATCH', expected: PROTOCOL_VERSION, actual: message.v };
  }
  if (message.payload !== undefined && (typeof message.payload !== 'object' || message.payload === null)) {
    return { ok: false, reason: 'INVALID_PAYLOAD' };
  }
  return { ok: true };
}