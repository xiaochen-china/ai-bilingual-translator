/**
 * 引擎注册表：内容脚本与设置页只通过 engine.list 拿元信息，
 * 真正的请求实现只存在于 Service Worker 中。
 */

import * as googleFree from './google-free.js';
import * as deepl from './deepl.js';
import * as openaiCompatible from './openai-compatible.js';

const REGISTRY = [
  { ...googleFree.meta, impl: googleFree },
  { ...deepl.meta, impl: deepl },
  { ...openaiCompatible.meta, impl: openaiCompatible },
  { ...openaiCompatible.bailianMeta, impl: openaiCompatible },
];

/** 对外暴露的引擎元信息（不含实现，不含密钥） */
export function listEngines() {
  return REGISTRY.map(({ impl, ...meta }) => meta);
}

/** 取引擎定义；未知 ID 回退到第一个引擎，保证功能不中断 */
export function getEngine(engineId) {
  return REGISTRY.find((engine) => engine.id === engineId) || REGISTRY[0];
}

export function isLlmEngine(engineId) {
  return getEngine(engineId).type === 'llm';
}

export function engineRequiresKey(engineId) {
  return Boolean(getEngine(engineId).requiresKey);
}

/** 各引擎的 host 权限列表，用于设置页提示用户授权自定义地址 */
export function engineHosts(engineId) {
  return getEngine(engineId).hosts || [];
}

export const ENGINE_COUNT = REGISTRY.length;