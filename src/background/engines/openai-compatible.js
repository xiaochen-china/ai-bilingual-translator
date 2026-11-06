/**
 * 兼容 OpenAI Chat Completions 协议的 LLM 引擎。
 * 同一套实现同时服务：
 *  - OpenAI 官方 API
 *  - 阿里云百炼（DashScope 兼容模式）
 *  - DeepSeek、Moonshot、本地 Ollama / vLLM 等任何兼容服务
 */

import { AppError, ERROR_CODES } from '../../common/protocol.js';
import { DEFAULT_TIMEOUT_MS, ensureOk, httpFetch, readJson } from './http.js';
import { packTexts } from './pack.js';
import { buildMessages, buildProbeMessages } from './llm-prompt.js';

export const meta = {
  id: 'openai-compatible',
  name: 'OpenAI 兼容接口',
  type: 'llm',
  requiresKey: true,
  hosts: ['https://api.openai.com/*'],
  description: '支持 OpenAI 官方 API 以及任何兼容 /chat/completions 的服务，可自定义接口地址与模型。',
  supportsCustomEndpoint: true,
};

export const bailianMeta = {
  id: 'bailian',
  name: '阿里云百炼（DashScope 兼容模式）',
  type: 'llm',
  requiresKey: true,
  hosts: ['https://dashscope.aliyuncs.com/*'],
  description: '使用 DashScope 的 OpenAI 兼容接口，模型如 qwen-plus、qwen-max，需要在阿里云百炼控制台获取 API Key。',
  supportsCustomEndpoint: true,
};

const MAX_TEXTS_PER_REQUEST = 12;
const MAX_CHARS_PER_REQUEST = 6000;

/**
 * 从模型回复里解析出等长的字符串数组。
 * 模型偶尔会加上代码块或编号，这里做尽量宽容的解析。
 */
export function parseModelOutput(content, expected) {
  if (typeof content !== 'string') return null;
  let text = content.trim();
  // 去掉 ```json ... ``` 包裹
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) text = fence[1].trim();

  const tryParse = (candidate) => {
    try {
      const parsed = JSON.parse(candidate);
      if (Array.isArray(parsed)) return parsed.map((item) => (typeof item === 'string' ? item : String(item ?? '')));
      if (parsed && Array.isArray(parsed.translations)) return parsed.translations.map((item) => String(item ?? ''));
      return null;
    } catch {
      return null;
    }
  };

  let result = tryParse(text);
  if (!result) {
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start >= 0 && end > start) result = tryParse(text.slice(start, end + 1));
  }

  if (!result) {
    // 兜底：按行切分并去掉编号
    const lines = text
      .split('\n')
      .map((line) => line.replace(/^\s*(?:\d+[.、)]|[-*])\s*/, '').trim())
      .filter(Boolean);
    if (lines.length) result = lines;
  }

  if (!result) return null;
  if (result.length === expected) return result;
  // 条数不一致但模型返回了单段「整段译文」时，无法安全对齐，交给上层报错
  return null;
}

function endpointOf(config) {
  const baseUrl = String(config.baseUrl || '').trim().replace(/\/+$/, '');
  if (!baseUrl) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '尚未配置接口地址（baseUrl）。');
  }
  // 允许用户直接填完整地址
  if (/\/chat\/completions$/.test(baseUrl)) return baseUrl;
  return `${baseUrl}/chat/completions`;
}

export async function translate({ texts, sourceLang = 'auto', targetLang = 'zh-CN', config = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) {
    throw new AppError(ERROR_CODES.NO_API_KEY, '尚未配置该引擎的 API Key，请到设置页「翻译引擎」中填写。');
  }
  const url = endpointOf(config);
  const model = String(config.model || '').trim();
  if (!model) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '尚未配置模型名称（model）。');
  }

  const output = [];
  for (const batch of packTexts(texts, MAX_TEXTS_PER_REQUEST, MAX_CHARS_PER_REQUEST)) {
    const messages = buildMessages({
      texts: batch,
      sourceLang,
      targetLang,
      profile: config.profile,
      glossary: config.glossary,
      customPrompt: config.customPrompt,
    });

    const payload = {
      model,
      messages,
      temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
      stream: false,
    };
    if (config.maxTokens) payload.max_tokens = config.maxTokens;

    const response = await httpFetch(
      url,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
        credentials: 'omit',
      },
      { timeoutMs: timeoutMs + 15000, signal }, // LLM 首字延迟更高，放宽超时
    );
    await ensureOk(response, 'AI 翻译接口');
    const json = await readJson(response, 'AI 翻译接口');
    const content = json?.choices?.[0]?.message?.content;
    const parsed = parseModelOutput(content, batch.length);
    if (!parsed) {
      throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'AI 返回的内容无法解析为译文数组，请尝试更换模型或降低温度。', {
        truncated: String(content || '').slice(0, 200),
      });
    }
    output.push(...parsed);
  }
  return output;
}

/**
 * 通用对话调用，供划词词典等非「等长数组翻译」场景使用。
 * @param {{messages: Array, config: object, signal?: AbortSignal, timeoutMs?: number}} params
 * @returns {Promise<string>} 模型回复的纯文本
 */
export async function chat({ messages, config = {}, signal, timeoutMs = 40000 }) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new AppError(ERROR_CODES.NO_API_KEY, '尚未配置该引擎的 API Key。');
  const model = String(config.model || '').trim();
  if (!model) throw new AppError(ERROR_CODES.INVALID_REQUEST, '尚未配置模型名称（model）。');

  const response = await httpFetch(
    endpointOf(config),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        temperature: typeof config.temperature === 'number' ? config.temperature : 0.2,
        max_tokens: config.maxTokens || 1024,
        stream: false,
      }),
      credentials: 'omit',
    },
    { timeoutMs, signal },
  );
  await ensureOk(response, 'AI 翻译接口');
  const json = await readJson(response, 'AI 翻译接口');
  const content = json?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new AppError(ERROR_CODES.INVALID_RESPONSE, 'AI 返回内容为空。');
  }
  return content;
}

export async function testConnection(config = {}) {
  const apiKey = String(config.apiKey || '').trim();
  if (!apiKey) throw new AppError(ERROR_CODES.NO_API_KEY, '尚未配置 API Key。');
  const url = endpointOf(config);
  const started = Date.now();
  const response = await httpFetch(
    url,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: String(config.model || '').trim(),
        messages: buildProbeMessages(config.targetLang || 'zh-CN'),
        temperature: 0,
        stream: false,
      }),
      credentials: 'omit',
    },
    { timeoutMs: 30000 },
  );
  await ensureOk(response, 'AI 翻译接口');
  const json = await readJson(response, 'AI 翻译接口');
  const content = json?.choices?.[0]?.message?.content;
  return { ok: true, sample: String(content || '').slice(0, 200), latencyMs: Date.now() - started };
}