/**
 * Google 翻译（免费端点，无需 Key）。
 *
 * 说明：这里使用的是 translate.googleapis.com 的公开端点（client=gtx），
 * 它不是 Google 官方文档承诺的正式 API，可能限流或随时变动。
 * 如需生产级稳定性，请改用 DeepL 或 OpenAI 兼容接口。
 */

import { AppError, ERROR_CODES } from '../../common/protocol.js';
import { ensureOk, httpFetch, readJson, DEFAULT_TIMEOUT_MS } from './http.js';
import { packTexts } from './pack.js';

export const meta = {
  id: 'google-free',
  name: 'Google 翻译（免费端点）',
  type: 'translate',
  requiresKey: false,
  hosts: ['https://translate.googleapis.com/*'],
  description: '无需 API Key，开箱即用；非官方正式 API，可能被限流，长文翻译质量一般。',
};

const MAX_TEXTS_PER_REQUEST = 6;
const MAX_CHARS_PER_REQUEST = 1200;
const DEFAULT_ENDPOINT = 'https://translate.googleapis.com/translate_a/single';

/**
 * 解析 Google 返回体。兼容单条与多条两种结构：
 * 单条：[[[译文片段, 原文片段, ...], ...], null, "en", ...]
 * 多条：[ 单条结构, 单条结构, ... ]
 */
export function parseGooglePayload(json) {
  const joinSegments = (result) => {
    if (!Array.isArray(result)) return '';
    return result
      .map((segment) => (Array.isArray(segment) ? String(segment[0] ?? '') : ''))
      .join('')
      .trim();
  };

  if (!Array.isArray(json)) return [];
  // 多 q：顶层每个元素都是一条结果（其第一个元素仍是数组）
  if (Array.isArray(json[1]) && Array.isArray(json[0])) {
    return json.map(joinSegments);
  }
  return [joinSegments(json[0])];
}

function buildUrl(endpoint, text, sourceLang, targetLang) {
  const params = new URLSearchParams();
  params.set('client', 'gtx');
  params.set('sl', sourceLang && sourceLang !== 'auto' ? sourceLang : 'auto');
  params.set('tl', targetLang || 'zh-CN');
  params.set('dt', 't');
  params.set('q', text);
  return `${endpoint}?${params.toString()}`;
}

/**
 * 统一引擎接口。
 * @param {{texts: string[], sourceLang: string, targetLang: string, config: object, signal?: AbortSignal, timeoutMs?: number}} params
 * @returns {Promise<string[]>} 与输入等长的译文数组
 */
export async function translate({ texts, sourceLang = 'auto', targetLang = 'zh-CN', config = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const endpoint = config.endpoint || DEFAULT_ENDPOINT;
  const output = [];

  for (const batch of packTexts(texts, MAX_TEXTS_PER_REQUEST, MAX_CHARS_PER_REQUEST)) {
    let batchOutput = [];

    if (batch.length === 1) {
      const response = await httpFetch(buildUrl(endpoint, batch[0], sourceLang, targetLang), { method: 'GET', credentials: 'omit' }, { timeoutMs, signal });
      await ensureOk(response, 'Google 翻译');
      const json = await readJson(response, 'Google 翻译');
      batchOutput = parseGooglePayload(json);
    } else {
      // 多条 q 时逐条发送，避免不同版本的接口对多 q 返回结构理解不一致导致译文错位
      batchOutput = [];
      for (const text of batch) {
        const response = await httpFetch(buildUrl(endpoint, text, sourceLang, targetLang), { method: 'GET', credentials: 'omit' }, { timeoutMs, signal });
        await ensureOk(response, 'Google 翻译');
        const json = await readJson(response, 'Google 翻译');
        batchOutput.push(...parseGooglePayload(json));
      }
    }

    if (batchOutput.length !== batch.length) {
      throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'Google 翻译返回的条数与请求不一致。', {
        expected: batch.length,
        actual: batchOutput.length,
      });
    }
    output.push(...batchOutput);
  }

  return output;
}

/** 「测试连接」使用：翻译一句固定文本 */
export async function testConnection(config = {}) {
  const started = Date.now();
  const [sample] = await translate({
    texts: ['Kernel manages memory and devices.'],
    sourceLang: 'en',
    targetLang: 'zh-CN',
    config,
  });
  return { ok: true, sample, latencyMs: Date.now() - started };
}