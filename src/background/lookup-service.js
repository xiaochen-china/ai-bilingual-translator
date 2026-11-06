/**
 * 划词查询服务：返回译文，并在使用 LLM 引擎时返回词性 / 释义 / 例句等结构化信息。
 * 非 LLM 引擎只能给出译文，此时明确告知用户哪些字段不可用，不伪造内容。
 */

import { AppError, ERROR_CODES, toAppError } from '../common/protocol.js';
import { normalizeWhitespace } from '../common/text.js';
import { getEngine, isLlmEngine } from './engines/engine-registry.js';
import { resolveEngineConfig } from './settings-service.js';
import { TranslationService } from './translation-service.js';

const DICTIONARY_PROMPT = `你是一个英汉词典。用户会给你一个英文单词或短句，请只输出一个 JSON 对象，不要输出任何解释文字：
{"translation":"中文翻译","pos":"词性（如 n./v./adj.，句子则留空）","definitions":["常用释义1","常用释义2"],"examples":[{"en":"英文例句","zh":"例句翻译"}]}
要求：definitions 最多 4 条，examples 最多 2 条；没有把握时对应字段留空数组或空字符串，不要编造。`;

const TRANSLATION_SERVICE = new TranslationService();

/**
 * @param {string} rawText
 * @param {{engineId?: string, requestId?: string}} options
 */
export async function lookupText(rawText, { engineId } = {}) {
  const text = normalizeWhitespace(rawText).slice(0, 600);
  if (!text) throw new AppError(ERROR_CODES.INVALID_REQUEST, '没有获取到需要查询的文本。');

  // 划词可以单独指定引擎，未指定时跟随默认引擎
  const settings = await resolveEngineConfig(engineId || undefined);
  const activeEngineId = settings.id;
  const engine = getEngine(activeEngineId);

  const baseResult = {
    text,
    translation: '',
    pos: '',
    definitions: [],
    examples: [],
    structured: false,
    engineId: activeEngineId,
    engineName: engine.name,
    notice: '',
  };

  if (isLlmEngine(activeEngineId) && typeof engine.impl?.chat === 'function') {
    try {
      const content = await engine.impl.chat({
        messages: [
          { role: 'system', content: DICTIONARY_PROMPT },
          { role: 'user', content: text },
        ],
        config: settings,
        timeoutMs: 30000,
      });
      const parsed = parseDictionaryJson(content);
      if (parsed) {
        return {
          ...baseResult,
          translation: parsed.translation || '',
          pos: parsed.pos || '',
          definitions: parsed.definitions || [],
          examples: parsed.examples || [],
          structured: true,
        };
      }
      // 返回体不是预期结构时退回普通翻译，并如实提示
      baseResult.notice = 'AI 返回的内容不是预期的词典格式，已改为普通翻译。';
    } catch (error) {
      baseResult.notice = `AI 词典查询失败（${toAppError(error).message}），已改为普通翻译。`;
    }
  }

  const translated = await TRANSLATION_SERVICE.translateOne(text, { engineId: activeEngineId });
  return {
    ...baseResult,
    translation: translated,
    notice:
      baseResult.notice ||
      (isLlmEngine(activeEngineId) ? '' : '当前引擎只提供译文；如需词性、释义和例句，请在设置中切换为 AI 引擎。'),
  };
}

export function parseDictionaryJson(content) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      translation: String(parsed.translation || ''),
      pos: String(parsed.pos || ''),
      definitions: Array.isArray(parsed.definitions) ? parsed.definitions.map(String).slice(0, 4) : [],
      examples: Array.isArray(parsed.examples)
        ? parsed.examples
            .filter((item) => item && typeof item === 'object')
            .map((item) => ({ en: String(item.en || ''), zh: String(item.zh || '') }))
            .slice(0, 2)
        : [],
    };
  } catch {
    return null;
  }
}