/**
 * 消息协议测试：信封校验、响应构造、错误归一化。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { PROTOCOL_VERSION } from '../src/common/constants.js';
import {
  AppError,
  ERROR_CODES,
  makeErrorResponse,
  makeMessage,
  makeResponse,
  toAppError,
  validateEnvelope,
} from '../src/common/protocol.js';

test('makeMessage 生成带版本号的请求信封', () => {
  const message = makeMessage('translate', { items: [] }, 'req-1');
  assert.equal(message.v, PROTOCOL_VERSION);
  assert.equal(message.type, 'translate');
  assert.equal(message.id, 'req-1');
  assert.deepEqual(message.payload, { items: [] });
  // 未指定 id 时自动生成
  assert.ok(makeMessage('ping').id.length > 0);
});

test('makeResponse 生成 <type>:result 成功响应', () => {
  const request = makeMessage('ping', {}, 'abc');
  const response = makeResponse(request, { pong: true });
  assert.deepEqual(response, { v: PROTOCOL_VERSION, type: 'ping:result', id: 'abc', ok: true, payload: { pong: true } });
});

test('makeErrorResponse 携带结构化错误', () => {
  const request = makeMessage('translate', {}, 'e1');
  const error = new AppError(ERROR_CODES.NO_API_KEY, '缺少密钥', { engineId: 'deepl' });
  const response = makeErrorResponse(request, error);
  assert.equal(response.ok, false);
  assert.equal(response.id, 'e1');
  assert.deepEqual(response.error, { code: 'NO_API_KEY', message: '缺少密钥', details: { engineId: 'deepl' } });
});

test('toAppError 归一化普通错误与 AbortError', () => {
  const appError = new AppError(ERROR_CODES.TIMEOUT, '超时');
  assert.equal(toAppError(appError), appError);

  const aborted = toAppError(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  assert.equal(aborted.code, ERROR_CODES.ABORTED);

  const network = toAppError(new TypeError('Failed to fetch'));
  assert.equal(network.code, ERROR_CODES.HTTP_ERROR);

  const unknown = toAppError(new Error('boom'));
  assert.equal(unknown.code, ERROR_CODES.UNKNOWN);
  assert.equal(unknown.message, 'boom');
});

test('validateEnvelope 拒绝非法信封', () => {
  assert.deepEqual(validateEnvelope(null), { ok: false, reason: 'INVALID_MESSAGE' });
  assert.deepEqual(validateEnvelope({ v: PROTOCOL_VERSION }), { ok: false, reason: 'MISSING_TYPE' });

  const mismatch = validateEnvelope({ v: PROTOCOL_VERSION + 1, type: 'ping' });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.reason, 'VERSION_MISMATCH');
  assert.equal(mismatch.expected, PROTOCOL_VERSION);

  assert.equal(validateEnvelope({ v: PROTOCOL_VERSION, type: 'ping', payload: 'string' }).reason, 'INVALID_PAYLOAD');
  assert.deepEqual(validateEnvelope({ v: PROTOCOL_VERSION, type: 'ping' }), { ok: true });
  assert.deepEqual(validateEnvelope({ v: PROTOCOL_VERSION, type: 'ping', payload: {} }), { ok: true });
});