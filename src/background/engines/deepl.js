/**
 * DeepL API（官方接口，需要 API Key）。
 * Free 版密钥以 ":fx" 结尾，必须走 api-free.deepl.com。
 */

import { AppError, ERROR_CODES } from '../../common/protocol.js';
import { DEFAULT_TIMEOUT_MS, ensureOk, httpFetch, readJson } from './http.js';
import { packTexts } from './pack.js';

export const meta = {
  id: 'deepl',
  name: 'DeepL API',
  type: 'translate',
  requiresKey: true,
  hosts: ['https://api-free.deepl.com/*', 'https://api.deepl.com/*'],
  description: '翻译质量高，需要 DeepL 官方 API Key；Free 版有每月字符额度限制。',
};

const ENDPOINTS = {
  free: 'https://api-free.deepl.com/v2/translate',
  pro: 'https://api.deepl.com/v2/translate',
};

const TARGET_LANG_MAP = {
  'zh-CN': 'ZH-HANS',
  'zh-TW': 'ZH-HANT',
  en: 'EN-US',
  ja: 'JA',
  ko: 'KO',
  de: 'DE',
  fr: 'FR',
  ru: 'RU',
};

const SOURCE_LANG_MAP = {
  auto: '',
  'zh-CN': 'ZH',
  'zh-TW': 'ZH',
  en: 'EN',
  ja: 'JA',
  ko: 'KO',
  de: 'DE',
  fr: 'FR',
  ru: 'RU',
};

const MAX_TEXTS_PER_REQUEST = 40; // DeepL 单次最多 50 段
const MAX_CHARS_PER_REQUEST = 8000;

/** Free 密钥以 :fx 结尾；如果用户在 pro 端点用了 free 密钥，自动纠正 */
export function resolveEndpoint(config = {}) {
  const apiKey = String(config.apiKey || '');
  const isFreeKey = apiKey.trim().endsWith(':fx');
  const preferred = config.endpoint === 'pro' ? 'pro' : 'free';
  if (isFreeKey) return ENDPOINTS.free;
  if (preferred === 'pro') return ENDPOINTS.pro;
  return ENDPOINTS.free;
}

export function mapTargetLang(targetLang) {
  return TARGET_LANG_MAP[targetLang] || 'ZH-HANS';
}

export function mapSourceLang(sourceLang) {
  if (!sourceLang || sourceLang === 'auto') return '';
  return SOURCE_LANG_MAP[sourceLang] || '';
}

export async function translate({ texts, sourceLang = 'auto', targetLang = 'zh-CN', config = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) {
    throw new AppError(ERROR_CODES.NO_API_KEY, '尚未配置 DeepL API Key，请到设置页「翻译引擎」中填写。');
  }

  const endpoint = resolveEndpoint({ ...config, apiKey });
  const output = [];

  for (const batch of packTexts(texts, MAX_TEXTS_PER_REQUEST, MAX_CHARS_PER_REQUEST)) {
    const body = new URLSearchParams();
    body.set('auth_key', apiKey);
    body.set('target_lang', mapTargetLang(targetLang));
    const source = mapSourceLang(sourceLang);
    if (source) body.set('source_lang', source);
    if (config.formality && config.formality !== 'default') body.set('formality', config.formality);
    body.set('preserve_formatting', '1');
    for (const text of batch) body.append('text', text);

    const response = await httpFetch(
      endpoint,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
        credentials: 'omit',
      },
      { timeoutMs, signal },
    );
    await ensureOk(response, 'DeepL');
    const json = await readJson(response, 'DeepL');
    const translations = json?.translations;
    if (!Array.isArray(translations) || translations.length !== batch.length) {
      throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'DeepL 返回的译文条数与请求不一致。', {
        expected: batch.length,
        actual: Array.isArray(translations) ? translations.length : 0,
      });
    }
    for (const item of translations) output.push(String(item?.text ?? '').trim());
  }

  return output;
}

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