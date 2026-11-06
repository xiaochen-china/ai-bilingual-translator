/**
 * Service Worker 消息路由：扩展内所有模块的唯一后台入口。
 * 每个处理函数都返回可直接放入响应信封的 payload；
 * 抛出的错误会由 handleMessage 统一转换成 { ok: false, error }。
 */

import { ENGINE_IDS, MESSAGE } from '../common/constants.js';
import { AppError, ERROR_CODES, makeErrorResponse, makeResponse, toAppError, validateEnvelope } from '../common/protocol.js';
import { cacheClear, cacheStats } from './cache.js';
import { engineRequiresKey, listEngines } from './engines/engine-registry.js';
import { lookupText } from './lookup-service.js';
import {
  clearApiKey,
  describeApiKey,
  getSettings,
  patchSettings,
  resetSettings,
  saveSettings,
  setApiKey,
  setSiteRule,
} from './settings-service.js';
import { fetchCues, loadSubtitles, readCaptionTracks } from './subtitle-bridge.js';
import { TranslationService } from './translation-service.js';

const translationService = new TranslationService();

/** 去掉可能被误写进设置的密钥字段，设置同步给内容脚本前必须过滤 */
function sanitizeSettings(settings) {
  const copy = JSON.parse(JSON.stringify(settings));
  if (copy.engines && typeof copy.engines === 'object') {
    for (const engine of Object.values(copy.engines)) {
      if (engine && typeof engine === 'object') {
        delete engine.apiKey;
        delete engine.key;
      }
    }
  }
  return copy;
}

function requireText(text, field = 'text') {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) throw new AppError(ERROR_CODES.INVALID_REQUEST, `缺少 ${field}。`);
  return value;
}

function nowId() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ------------------------------------------------------------------ */
/* 各消息处理                                                          */
/* ------------------------------------------------------------------ */

const handlers = {
  [MESSAGE.PING]: async () => ({
    pong: Date.now(),
    version: chrome.runtime.getManifest().version,
    engines: listEngines().length,
  }),

  /** 批量翻译：items 为 [{id, text}]，返回同 id 的译文 */
  [MESSAGE.TRANSLATE]: async (payload) => {
    const items = Array.isArray(payload?.items) ? payload.items : null;
    if (!items?.length) throw new AppError(ERROR_CODES.INVALID_REQUEST, '没有需要翻译的文本。');
    const texts = items.map((item) => (typeof item?.text === 'string' ? item.text : ''));
    const settings = await getSettings();
    const requestId = payload?.requestId || null;
    const controller = translationService.createAbortController(requestId);
    try {
      const result = await translationService.translateTexts({
        texts,
        engineId: payload?.engineId,
        profile: payload?.profile || settings.profile || undefined,
        requestId,
        signal: controller.signal,
      });
      return {
        results: items.map((item, index) => ({
          id: item?.id ?? String(index),
          translated: result.items[index]?.translated || '',
          cached: Boolean(result.items[index]?.cached),
        })),
        engineId: result.engineId,
        engineName: result.engineName || '',
        profile: result.profile,
      };
    } finally {
      translationService.release(requestId);
    }
  },

  [MESSAGE.TRANSLATE_CANCEL]: async (payload) => ({
    cancelled: translationService.cancel(payload?.requestId),
  }),

  [MESSAGE.SETTINGS_GET]: async () => {
    const settings = await getSettings();
    const keyStatus = {};
    for (const engine of listEngines()) {
      if (engine.requiresKey) keyStatus[engine.id] = await describeApiKey(engine.id);
    }
    return {
      settings: sanitizeSettings(settings),
      engines: listEngines(),
      keyStatus,
    };
  },

  [MESSAGE.SETTINGS_PATCH]: async (payload) => {
    const patch = payload?.patch;
    if (!patch || typeof patch !== 'object') throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少 patch。');
    // 密钥通过专用字段提交，绝不写入 settings
    if (payload?.apiKey !== undefined) {
      const engineId = payload?.engineId;
      if (!engineId || !Object.values(ENGINE_IDS).includes(engineId)) {
        throw new AppError(ERROR_CODES.INVALID_REQUEST, '未知的引擎 ID。');
      }
      await setApiKey(engineId, String(payload.apiKey || ''), { persist: Boolean(payload.persistKey) });
    }
    const next = await patchSettings(patch);
    return { settings: sanitizeSettings(next) };
  },

  [MESSAGE.SETTINGS_RESET]: async () => ({ settings: sanitizeSettings(await resetSettings()) }),

  [MESSAGE.ENGINE_LIST]: async () => ({ engines: listEngines() }),

  [MESSAGE.ENGINE_TEST]: async (payload) => {
    const engineId = payload?.engineId;
    if (!engineId) throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少 engineId。');
    return translationService.testEngine(engineId, payload?.overrides || {});
  },

  [MESSAGE.CACHE_STATS]: async () => cacheStats(),
  [MESSAGE.CACHE_CLEAR]: async () => ({ cleared: await cacheClear() }),

  [MESSAGE.SITE_RULE_GET]: async (payload) => {
    const hostname = requireText(payload?.hostname, 'hostname');
    const settings = await getSettings();
    return { hostname, rule: settings.siteRules?.[hostname] ?? null };
  },

  [MESSAGE.SITE_RULE_SET]: async (payload) => {
    const hostname = requireText(payload?.hostname, 'hostname');
    const rule = payload?.rule ?? null;
    if (rule !== null && !['auto', 'never', 'ask'].includes(rule)) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '未知的站点规则。');
    }
    const siteRules = await setSiteRule(hostname, rule);
    return { hostname, rule, siteRules };
  },

  /* ----------------------------- 视频字幕 ----------------------------- */

  [MESSAGE.SUBTITLE_TRACKS]: async (payload, sender) => {
    const tabId = payload?.tabId ?? sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少 tabId。');
    return readCaptionTracks(tabId);
  },

  [MESSAGE.SUBTITLE_CUES]: async (payload, sender) => {
    const tabId = payload?.tabId ?? sender?.tab?.id;
    if (!Number.isInteger(tabId)) throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少 tabId。');
    if (payload?.baseUrl) {
      const cuesResult = await fetchCues(payload.baseUrl);
      if (!cuesResult.ok) {
        return {
          ok: false,
          stage: 'cues',
          reason: cuesResult.reason || 'EMPTY',
          status: cuesResult.status,
          tracks: [],
        };
      }
      return { ok: true, cues: cuesResult.cues, tracks: [], track: null, videoId: payload.videoId || '' };
    }
    return loadSubtitles(tabId, { preferLanguage: 'en' });
  },

  /* ------------------------------ 划词 ------------------------------ */

  [MESSAGE.WORD_LOOKUP]: async (payload) => {
    const text = requireText(payload?.text, 'text');
    const result = await lookupText(text, { engineId: payload?.engineId || undefined });

    const settings = await getSettings();
    if (settings.history?.enabled !== false) {
      const entry = {
        id: nowId(),
        text: result.text,
        translation: result.translation,
        engineId: result.engineId,
        engineName: result.engineName,
        url: payload?.url || '',
        title: payload?.title || '',
        createdAt: Date.now(),
      };
      const items = [entry, ...(settings.history.items || [])].slice(0, settings.history.maxEntries || 200);
      await saveSettings({ ...settings, history: { ...settings.history, items } });
    }
    return result;
  },

  /* ------------------------------ 生词本 ------------------------------ */

  [MESSAGE.WORDBOOK_LIST]: async () => {
    const settings = await getSettings();
    return { items: settings.wordbook || [] };
  },

  [MESSAGE.WORDBOOK_ADD]: async (payload) => {
    const text = requireText(payload?.text, 'text');
    const settings = await getSettings();
    const items = settings.wordbook || [];
    if (items.some((item) => item.text.toLowerCase() === text.toLowerCase())) {
      return { items, duplicate: true };
    }
    const entry = {
      id: nowId(),
      text,
      translation: String(payload?.translation || ''),
      pos: String(payload?.pos || ''),
      note: String(payload?.note || ''),
      url: String(payload?.url || ''),
      createdAt: Date.now(),
    };
    const next = [entry, ...items];
    await saveSettings({ ...settings, wordbook: next });
    return { items: next, duplicate: false, entry };
  },

  [MESSAGE.WORDBOOK_REMOVE]: async (payload) => {
    const id = requireText(payload?.id, 'id');
    const settings = await getSettings();
    const items = (settings.wordbook || []).filter((item) => item.id !== id);
    await saveSettings({ ...settings, wordbook: items });
    return { items };
  },

  /* ------------------------------ 历史 ------------------------------ */

  [MESSAGE.HISTORY_LIST]: async () => {
    const settings = await getSettings();
    return { items: settings.history?.items || [] };
  },

  [MESSAGE.HISTORY_CLEAR]: async () => {
    const settings = await getSettings();
    await saveSettings({ ...settings, history: { ...settings.history, items: [] } });
    return { items: [] };
  },
};

/* ------------------------------------------------------------------ */
/* 分发                                                                */
/* ------------------------------------------------------------------ */

/**
 * 处理一条消息，返回响应信封。
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 */
export async function handleMessage(message, sender) {
  const validation = validateEnvelope(message);
  if (!validation.ok) {
    return {
      v: message?.v ?? null,
      type: `${message?.type || 'unknown'}:result`,
      id: message?.id ?? null,
      ok: false,
      error: { code: ERROR_CODES.INVALID_REQUEST, message: '消息格式不正确。', details: validation },
    };
  }
  const handler = handlers[message.type];
  if (!handler) {
    return makeErrorResponse(message, new AppError(ERROR_CODES.INVALID_REQUEST, `未知的消息类型：${message.type}`));
  }
  try {
    const payload = await handler(message.payload || {}, sender);
    return makeResponse(message, payload);
  } catch (error) {
    const appError = toAppError(error);
    return makeErrorResponse(message, appError);
  }
}

/**
 * 向内容脚本推送设置变化（内容脚本据此即时更新样式与模式）。
 * @param {chrome.tabs.Tab} tab
 * @param {any} settings
 */
export async function pushSettingsToTab(tab, settings) {
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      v: 1,
      type: 'settings.changed',
      id: `push-${Date.now()}`,
      payload: { settings: sanitizeSettings(settings) },
    });
  } catch {
    // 目标标签页没有内容脚本（例如 chrome:// 页面）时静默忽略
  }
}

export { handlers };