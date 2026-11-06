/**
 * 翻译服务：所有翻译请求的唯一入口（只在 Service Worker 中运行）。
 *
 * 职责：
 *  - 读取设置与密钥（内容脚本永远拿不到密钥）
 *  - 技术内容保护（代码 / URL / 路径 / 标识符不送翻译）
 *  - 术语词典处理
 *  - 缓存命中判断（IndexedDB）
 *  - 批量、重试、超时、取消
 */

import { ENGINE_IDS } from '../common/constants.js';
import { AppError, ERROR_CODES, toAppError } from '../common/protocol.js';
import { applyGlossaryPre, normalizeWhitespace, protectText, restoreText } from '../common/text.js';
import { buildCacheKey, cacheGetMany, cacheSetMany } from './cache.js';
import { isRetryable } from './engines/http.js';
import { getEngine, isLlmEngine } from './engines/engine-registry.js';
import { packTexts } from './engines/pack.js';
import { resolveEngineConfig } from './settings-service.js';

const RETRY_ATTEMPTS = 3;
const RETRY_BASE_DELAY = 600;

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError(ERROR_CODES.ABORTED, '翻译任务已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new AppError(ERROR_CODES.ABORTED, '翻译任务已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function withRetry(task, { signal, attempts = RETRY_ATTEMPTS } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw new AppError(ERROR_CODES.ABORTED, '翻译任务已取消');
    try {
      return await task(attempt);
    } catch (error) {
      lastError = toAppError(error);
      if (!isRetryable(lastError) || attempt === attempts - 1) break;
      const backoff = RETRY_BASE_DELAY * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(backoff, signal);
    }
  }
  throw lastError;
}

export class TranslationService {
  constructor() {
    /** @type {Map<string, Promise<any>>} 相同文本的并发请求合并 */
    this.inflight = new Map();
    /** @type {Map<string, AbortController>} 按请求 ID 记录控制器用于取消 */
    this.controllers = new Map();
  }

  /** 注册一个可取消的请求 */
  createAbortController(requestId) {
    const controller = new AbortController();
    if (requestId) this.controllers.set(requestId, controller);
    return controller;
  }

  /** 取消某个请求 */
  cancel(requestId) {
    const controller = this.controllers.get(requestId);
    if (!controller) return false;
    controller.abort();
    this.controllers.delete(requestId);
    return true;
  }

  release(requestId) {
    this.controllers.delete(requestId);
  }

  /**
   * 翻译一组文本。
   * @param {{texts: string[], engineId?: string, sourceLang?: string, targetLang?: string, profile?: string, requestId?: string, signal?: AbortSignal, allowCache?: boolean, skipProtection?: boolean}} params
   * @returns {Promise<{items: Array<{text: string, translated: string, cached: boolean}>, engineId: string, profile: string}>}
   */
  async translateTexts({
    texts = [],
    engineId,
    sourceLang,
    targetLang,
    profile,
    requestId,
    signal,
    allowCache = true,
    skipProtection = false,
    timeoutMs = 25000,
  } = {}) {
    const prepared = texts.map((text) => normalizeWhitespace(text));
    if (!prepared.length) return { items: [], engineId, profile };

    const settings = await resolveEngineConfig(engineId);
    const activeEngineId = settings.id || ENGINE_IDS.GOOGLE_FREE;
    const engine = getEngine(activeEngineId);
    const effectiveProfile = profile || settings.profile;
    const effectiveSource = sourceLang || settings.sourceLang || 'auto';
    const effectiveTarget = targetLang || settings.targetLang || 'zh-CN';
    const useCache = allowCache && settings.cacheEnabled;
    const llm = isLlmEngine(activeEngineId);

    // 1. 计算缓存键（相同文本只算一次）
    const keyByText = new Map();
    const uniqueTexts = [...new Set(prepared.filter((text) => text.length > 0))];
    if (useCache) {
      for (const text of uniqueTexts) {
        const key = await buildCacheKey({
          engineId: activeEngineId,
          profile: effectiveProfile,
          sourceLang: effectiveSource,
          targetLang: effectiveTarget,
          text,
        });
        keyByText.set(text, key);
      }
    }

    // 2. 查缓存
    const cached = useCache ? await cacheGetMany([...keyByText.values()]) : new Map();
    const translationByText = new Map();
    for (const [text, key] of keyByText.entries()) {
      if (cached.has(key)) translationByText.set(text, cached.get(key));
    }

    // 3. 找出需要请求的文本
    const missing = uniqueTexts.filter((text) => !translationByText.has(text));

    if (missing.length) {
      if (!engine.impl) {
        throw new AppError(ERROR_CODES.ENGINE_DISABLED, `翻译引擎「${engine.name}」不可用。`);
      }
      // 合并相同文本的并发请求
      const dedupeKey = `${activeEngineId}|${effectiveProfile}|${effectiveSource}|${effectiveTarget}`;
      const shared = this.inflight.get(dedupeKey);
      if (shared) {
        await shared.catch(() => {});
        // 等待期间可能有新结果写入缓存，重新查一次
        if (useCache) {
          const recheck = await cacheGetMany(missing.map((text) => keyByText.get(text)).filter(Boolean));
          for (const text of missing) {
            const key = keyByText.get(text);
            if (key && recheck.has(key) && !translationByText.has(text)) translationByText.set(text, recheck.get(key));
          }
        }
      }

      const stillMissing = missing.filter((text) => !translationByText.has(text));
      if (stillMissing.length) {
        const job = this.runEngine(engine, {
          texts: stillMissing,
          sourceLang: effectiveSource,
          targetLang: effectiveTarget,
          profile: effectiveProfile,
          config: settings,
          signal,
          timeoutMs,
          skipProtection,
        });
        this.inflight.set(dedupeKey, job);
        try {
          const results = await job;
          const cacheEntries = [];
          for (let index = 0; index < stillMissing.length; index += 1) {
            const text = stillMissing[index];
            const translated = results[index] ?? '';
            translationByText.set(text, translated);
            const key = keyByText.get(text);
            if (useCache && key && translated) cacheEntries.push({ key, value: translated });
          }
          if (cacheEntries.length) await cacheSetMany(cacheEntries, 5000);
        } finally {
          this.inflight.delete(dedupeKey);
        }
      }
    }

    const items = prepared.map((text) => ({
      text,
      translated: text ? translationByText.get(text) || '' : '',
      cached: useCache ? cached.has(keyByText.get(text)) : false,
    }));

    return { items, engineId: activeEngineId, profile: effectiveProfile, engineName: engine.name };
  }

  /**
   * 真正调用引擎：保护技术片段 → 分批发请求 → 还原片段。
   * 单个批次失败不影响其他批次（失败批次用原文占位并记录错误）。
   */
  async runEngine(engine, { texts, sourceLang, targetLang, profile, config, signal, timeoutMs, skipProtection }) {
    const llm = engine.type === 'llm';
    const protectedTexts = [];
    const slotMap = [];

    for (const text of texts) {
      if (skipProtection) {
        protectedTexts.push(text);
        slotMap.push([]);
        continue;
      }
      const { text: protectedText, slots } = protectText(text);
      // 非 LLM 引擎用术语预替换，让免费引擎也能使用自定义词典
      const finalText = llm ? protectedText : applyGlossaryPre(protectedText, config.glossary);
      protectedTexts.push(finalText);
      slotMap.push(slots);
    }

    const maxTexts = llm ? 12 : engine.id === ENGINE_IDS.GOOGLE_FREE ? 6 : 30;
    const maxChars = llm ? 6000 : engine.id === ENGINE_IDS.GOOGLE_FREE ? 1200 : 8000;
    const batches = packTexts(protectedTexts, maxTexts, maxChars);

    const output = [];
    let offset = 0;

    for (const batch of batches) {
      const batchSignal = signal;
      const translatedBatch = await withRetry(
        async () =>
          engine.impl.translate({
            texts: batch,
            sourceLang,
            targetLang,
            config,
            signal: batchSignal,
            timeoutMs,
          }),
        { signal: batchSignal },
      );

      if (!Array.isArray(translatedBatch) || translatedBatch.length !== batch.length) {
        throw new AppError(ERROR_CODES.INVALID_RESPONSE, `「${engine.name}」返回的译文条数与请求不一致。`);
      }

      for (let index = 0; index < translatedBatch.length; index += 1) {
        const slots = slotMap[offset + index] || [];
        output.push(restoreText(translatedBatch[index], slots));
      }
      offset += batch.length;
    }

    return output;
  }

  /** 便捷方法：翻译单条文本（划词、字幕、标题） */
  async translateOne(text, options = {}) {
    const { items } = await this.translateTexts({ ...options, texts: [text] });
    return items[0]?.translated || '';
  }

  /** 测试引擎连通性（设置页使用） */
  async testEngine(engineId, overrides = {}) {
    const settings = await resolveEngineConfig(engineId);
    const engine = getEngine(settings.id);
    const config = { ...settings, ...overrides };
    if (!engine.impl?.testConnection) {
      throw new AppError(ERROR_CODES.INVALID_REQUEST, '该引擎不支持连接测试。');
    }
    const started = Date.now();
    try {
      const result = await engine.impl.testConnection(config);
      return { ok: true, engine: engine.name, sample: result.sample, latencyMs: result.latencyMs ?? Date.now() - started };
    } catch (error) {
      const appError = toAppError(error);
      return { ok: false, engine: engine.name, code: appError.code, message: appError.message };
    }
  }
}