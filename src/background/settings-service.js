/**
 * 设置读写：非敏感配置存 chrome.storage.local，API Key 默认存 chrome.storage.session。
 * 只有 Service Worker 与扩展页面（弹窗 / 设置页）能拿到密钥，内容脚本永远拿不到。
 */

import { DEFAULT_SETTINGS, ENGINE_IDS, SITE_RULES, STORAGE_KEYS } from '../common/constants.js';
import { deepMerge } from '../common/text.js';

const clone = (value) => JSON.parse(JSON.stringify(value));

function storageLocal() {
  return chrome.storage.local;
}

function storageSession() {
  return chrome.storage.session || chrome.storage.local;
}

/** 读取合并后的完整设置（默认值 + 用户配置） */
export async function getSettings() {
  const stored = await storageLocal().get(STORAGE_KEYS.SETTINGS);
  const saved = stored?.[STORAGE_KEYS.SETTINGS] || {};
  return deepMerge(clone(DEFAULT_SETTINGS), saved);
}

/** 整体写入设置 */
export async function saveSettings(settings) {
  await storageLocal().set({ [STORAGE_KEYS.SETTINGS]: settings });
  return settings;
}

/** 局部更新设置（深合并） */
export async function patchSettings(patch) {
  const current = await getSettings();
  const next = deepMerge(current, patch);
  await saveSettings(next);
  return next;
}

/** 恢复默认设置（保留站点规则以外的全部内容都重置） */
export async function resetSettings() {
  const defaults = clone(DEFAULT_SETTINGS);
  await saveSettings(defaults);
  return defaults;
}

/* ------------------------------------------------------------------ */
/* API Key                                                             */
/* ------------------------------------------------------------------ */

async function readKeyBucket(area, key) {
  try {
    const result = await area.get(key);
    return result?.[key] || {};
  } catch {
    return {};
  }
}

/** 会话级密钥（浏览器关闭后清除） */
export async function getSessionKeys() {
  return readKeyBucket(storageSession(), STORAGE_KEYS.SESSION_KEYS);
}

/** 用户显式开启「持久化」后才存在的密钥 */
export async function getPersistedKeys() {
  return readKeyBucket(storageLocal(), STORAGE_KEYS.PERSISTED_KEYS);
}

/**
 * 获取某个引擎的 API Key。会话级优先（用户最近一次输入），其次才是持久化。
 */
export async function getApiKey(engineId) {
  const session = await getSessionKeys();
  if (session[engineId]) return session[engineId];
  const persisted = await getPersistedKeys();
  return persisted[engineId] || '';
}

/**
 * 写入 API Key。
 * @param {string} engineId
 * @param {string} key
 * @param {{persist?: boolean}} options persist=true 时同时写入 local（需用户明确开启并确认风险）
 */
export async function setApiKey(engineId, key, { persist = false } = {}) {
  const trimmed = String(key || '').trim();
  if (!trimmed) {
    await clearApiKey(engineId);
    return;
  }
  const session = await getSessionKeys();
  session[engineId] = trimmed;
  await storageSession().set({ [STORAGE_KEYS.SESSION_KEYS]: session });

  if (persist) {
    const persisted = await getPersistedKeys();
    persisted[engineId] = trimmed;
    await storageLocal().set({ [STORAGE_KEYS.PERSISTED_KEYS]: persisted });
  }
}

/** 删除某个引擎的密钥（会话与持久化都删） */
export async function clearApiKey(engineId) {
  const session = await getSessionKeys();
  delete session[engineId];
  await storageSession().set({ [STORAGE_KEYS.SESSION_KEYS]: session });

  const persisted = await getPersistedKeys();
  if (engineId in persisted) {
    delete persisted[engineId];
    await storageLocal().set({ [STORAGE_KEYS.PERSISTED_KEYS]: persisted });
  }
}

/** 只清空会话密钥（模拟浏览器重启后的状态，用于设置页的开关切换） */
export async function clearPersistedKeys() {
  await storageLocal().set({ [STORAGE_KEYS.PERSISTED_KEYS]: {} });
}

/** 是否保存了某个引擎的密钥，以及存储位置 */
export async function describeApiKey(engineId) {
  const session = await getSessionKeys();
  const persisted = await getPersistedKeys();
  if (session[engineId]) return { hasKey: true, source: 'session' };
  if (persisted[engineId]) return { hasKey: true, source: 'persisted' };
  return { hasKey: false, source: 'none' };
}

/* ------------------------------------------------------------------ */
/* 站点规则                                                            */
/* ------------------------------------------------------------------ */

/** 获取某个 hostname 的翻译偏好；没有规则时返回 null */
export async function getSiteRule(hostname) {
  const settings = await getSettings();
  const rule = settings.siteRules?.[hostname];
  return Object.values(SITE_RULES).includes(rule) ? rule : null;
}

/** 写入站点规则；rule 传 null 表示删除该规则 */
export async function setSiteRule(hostname, rule) {
  if (!hostname) return null;
  const settings = await getSettings();
  const siteRules = { ...(settings.siteRules || {}) };
  if (rule === null || rule === undefined) delete siteRules[hostname];
  else siteRules[hostname] = rule;
  await saveSettings({ ...settings, siteRules });
  return siteRules;
}

/* ------------------------------------------------------------------ */
/* 引擎配置                                                            */
/* ------------------------------------------------------------------ */

/** 组织出某个引擎的完整配置（含密钥），只允许在后台使用 */
export async function resolveEngineConfig(engineId) {
  const settings = await getSettings();
  const id = engineId || settings.engineId || ENGINE_IDS.GOOGLE_FREE;
  const engineSettings = settings.engines?.[id] || {};
  return {
    id,
    apiKey: await getApiKey(id),
    ...engineSettings,
    profile: settings.profile,
    customPrompt: settings.customPrompt,
    glossary: settings.glossary || [],
    cacheEnabled: settings.cache?.enabled !== false,
    targetLang: settings.targetLang,
    sourceLang: settings.sourceLang,
  };
}

/** 订阅设置变化（Service Worker 内使用） */
export function onSettingsChanged(callback) {
  const listener = (changes, areaName) => {
    if (areaName !== 'local') return;
    if (!(STORAGE_KEYS.SETTINGS in changes)) return;
    callback(changes[STORAGE_KEYS.SETTINGS].newValue || null);
  };
  chrome.storage.onChanged.addListener(listener);
  return () => chrome.storage.onChanged.removeListener(listener);
}

export { STORAGE_KEYS, ENGINE_IDS };