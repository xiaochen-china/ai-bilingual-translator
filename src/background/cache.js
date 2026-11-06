/**
 * 翻译缓存（IndexedDB）。
 * 缓存放在 Service Worker 侧，内容脚本无需关心缓存策略。
 * IndexedDB 不可用时降级到内存 Map（Service Worker 休眠后失效，但不影响功能）。
 */

import { hashText } from '../common/text.js';

const DB_NAME = 'abt-translation-cache';
const DB_VERSION = 1;
const STORE = 'translations';

let dbPromise = null;
const memoryFallback = new Map();
let usingFallback = false;

function openDatabase() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: 'k' });
          store.createIndex('t', 't', { unique: false });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => {
        usingFallback = true;
        resolve(null);
      };
      request.onblocked = () => {
        usingFallback = true;
        resolve(null);
      };
    } catch {
      usingFallback = true;
      resolve(null);
    }
  });
  return dbPromise;
}

function runTransaction(db, mode, executor) {
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(STORE, mode);
    } catch (error) {
      reject(error);
      return;
    }
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = executor(store, tx);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('transaction aborted'));
  });
}

/** 生成缓存键：引擎 + 模式 + 语言 + 文本 */
export async function buildCacheKey({ engineId, profile, sourceLang, targetLang, text }) {
  const hash = await hashText(text);
  return `${engineId}|${profile || 'general'}|${sourceLang || 'auto'}|${targetLang || 'zh-CN'}|${hash}`;
}

/**
 * 批量读取缓存。
 * @param {string[]} keys
 * @returns {Promise<Map<string, string>>}
 */
export async function cacheGetMany(keys) {
  const found = new Map();
  if (!keys.length) return found;
  if (usingFallback) {
    for (const key of keys) if (memoryFallback.has(key)) found.set(key, memoryFallback.get(key));
    return found;
  }
  const db = await openDatabase();
  if (!db) {
    for (const key of keys) if (memoryFallback.has(key)) found.set(key, memoryFallback.get(key));
    return found;
  }
  await Promise.all(
    keys.map(
      (key) =>
        new Promise((resolve) => {
          try {
            const tx = db.transaction(STORE, 'readonly');
            const request = tx.objectStore(STORE).get(key);
            request.onsuccess = () => {
              const record = request.result;
              if (record && typeof record.v === 'string') found.set(key, record.v);
              resolve();
            };
            request.onerror = () => resolve();
          } catch {
            resolve();
          }
        }),
    ),
  );
  return found;
}

/**
 * 批量写入缓存。
 * @param {Array<{key: string, value: string}>} entries
 * @param {number} maxEntries 超出上限时按时间淘汰最旧记录
 */
export async function cacheSetMany(entries, maxEntries = 5000) {
  if (!entries.length) return;
  if (usingFallback) {
    for (const { key, value } of entries) memoryFallback.set(key, value);
    return;
  }
  const db = await openDatabase();
  if (!db) {
    for (const { key, value } of entries) memoryFallback.set(key, value);
    return;
  }
  await runTransaction(db, 'readwrite', (store) => {
    const now = Date.now();
    for (const { key, value } of entries) {
      store.put({ k: key, v: value, t: now });
    }
  }).catch(() => {
    for (const { key, value } of entries) memoryFallback.set(key, value);
  });

  // 每 40 次写入触发一次清理，避免频繁 count()
  if (Math.random() < 0.025) await prune(maxEntries);
}

/** 按写入时间淘汰旧记录 */
export async function prune(maxEntries = 5000) {
  const db = await openDatabase();
  if (!db) {
    while (memoryFallback.size > maxEntries) {
      const oldest = memoryFallback.keys().next().value;
      memoryFallback.delete(oldest);
    }
    return;
  }
  const count = await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
  if (count <= maxEntries) return;
  const overflow = count - maxEntries;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      const index = tx.objectStore(STORE).index('t');
      let removed = 0;
      const cursorRequest = index.openCursor();
      cursorRequest.onsuccess = () => {
        const cursor = cursorRequest.result;
        if (!cursor || removed >= overflow) return;
        cursor.delete();
        removed += 1;
        cursor.continue();
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
}

/** 缓存统计 */
export async function cacheStats() {
  if (usingFallback) return { count: memoryFallback.size, driver: 'memory' };
  const db = await openDatabase();
  if (!db) return { count: memoryFallback.size, driver: 'memory' };
  const count = await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).count();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(0);
    } catch {
      resolve(0);
    }
  });
  return { count, driver: 'indexeddb' };
}

/** 清空缓存 */
export async function cacheClear() {
  memoryFallback.clear();
  const db = await openDatabase();
  if (!db) return true;
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    } catch {
      resolve();
    }
  });
  return true;
}