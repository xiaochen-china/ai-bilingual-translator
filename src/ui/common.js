/**
 * 扩展页面共用的工具函数（ES Module）。
 * 只允许在扩展页面（弹窗 / 设置 / 侧边栏 / 字幕面板）中使用，内容脚本不可引用。
 */

export const PROTOCOL_VERSION = 1;

/** 发送后台消息，失败时抛出带 code 的 Error */
export function send(type, payload = {}, { timeoutMs = 45000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(Object.assign(new Error('后台响应超时'), { code: 'TIMEOUT' }));
    }, timeoutMs);

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn(value);
    };

    try {
      chrome.runtime.sendMessage({ v: PROTOCOL_VERSION, type, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, payload }, (response) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          finish(reject, Object.assign(new Error(lastError.message || '扩展后台不可用'), { code: 'CONTEXT_LOST' }));
          return;
        }
        if (!response) {
          finish(reject, Object.assign(new Error('没有收到后台响应'), { code: 'NO_RESPONSE' }));
          return;
        }
        if (response.ok) finish(resolve, response.payload || {});
        else {
          const error = new Error(response.error?.message || '请求失败');
          error.code = response.error?.code || 'UNKNOWN';
          error.details = response.error?.details || {};
          finish(reject, error);
        }
      });
    } catch (error) {
      finish(reject, Object.assign(new Error('扩展上下文已失效'), { code: 'CONTEXT_LOST', cause: error }));
    }
  });
}

/** 创建元素的小工具：h('div', {class:'x'}, 'child') */
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'style' && typeof value === 'object') Object.assign(el.style, value);
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key === 'html') el.innerHTML = value;
    else if (value === true) el.setAttribute(key, '');
    else el.setAttribute(key, String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return el;
}

/** 轻提示 */
let toastTimer = null;
export function toast(message, type = 'info', duration = 2400) {
  let box = document.getElementById('ui-toast');
  if (!box) {
    box = h('div', { id: 'ui-toast' });
    document.body.appendChild(box);
  }
  box.textContent = message;
  box.className = `show ${type === 'error' ? 'error' : type === 'success' ? 'success' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.className = '';
  }, duration);
}

export function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 相对时间，用于历史列表 */
export function timeAgo(timestamp) {
  if (!timestamp) return '';
  const diff = Date.now() - timestamp;
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatTime(timestamp).slice(0, 10);
}

/** 当前活动标签页 */
export async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

/** 向内容脚本发消息；若未注入则尝试注入后重试一次 */
export async function sendToPage(tabId, message, { injectIfMissing = true } = {}) {
  const envelope = { v: PROTOCOL_VERSION, type: message.type, id: `ui-${Date.now()}`, payload: message.payload || {} };
  try {
    return await chrome.tabs.sendMessage(tabId, envelope);
  } catch (error) {
    if (!injectIfMissing) throw error;
    await ensureContentScript(tabId);
    return chrome.tabs.sendMessage(tabId, envelope);
  }
}

/** 手动注入内容脚本（用于扩展安装后未刷新的旧标签页） */
export async function ensureContentScript(tabId) {
  const files = [
    'src/content/core.js',
    'src/content/page-translator.js',
    'src/content/selection.js',
    'src/content/subtitles.js',
    'src/content/main.js',
  ];
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files });
  } catch (error) {
    throw Object.assign(new Error('无法在当前页面运行扩展（浏览器内部页面或受限站点）。'), { code: 'INJECT_FAILED', cause: error });
  }
}

export function isRestrictedUrl(url) {
  if (!url) return true;
  return /^(chrome|edge|about|chrome-extension|edge-extension|devtools|view-source):/i.test(url) || /^https?:\/\/chromewebstore\.google\.com/i.test(url);
}

/** 打开设置页并定位到某个锚点 */
export function openOptions(hash = '') {
  const url = chrome.runtime.getURL(`src/options/options.html${hash ? `#${hash}` : ''}`);
  chrome.tabs.create({ url });
}

/** 打开侧边栏（不支持时降级为独立标签页） */
export async function openSidePanel(panel = 'wordbook') {
  const url = chrome.runtime.getURL(`src/sidepanel/sidepanel.html#${panel}`);
  try {
    if (chrome.sidePanel?.open) {
      const tab = await activeTab();
      if (tab?.id) {
        await chrome.sidePanel.setOptions({ tabId: tab.id, path: `src/sidepanel/sidepanel.html#${panel}`, enabled: true });
        await chrome.sidePanel.open({ tabId: tab.id });
        return 'sidepanel';
      }
    }
  } catch {
    // 某些环境（如 Edge 的旧版本）不支持，降级为标签页
  }
  chrome.tabs.create({ url });
  return 'tab';
}

/** 复制文本到剪贴板 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = document.createElement('textarea');
    area.value = text;
    area.style.cssText = 'position:fixed;opacity:0;';
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand('copy');
    area.remove();
    return ok;
  }
}

/** 表单值读取辅助 */
export function valueOf(root, selector) {
  const el = root.querySelector(selector);
  return el ? el.value : '';
}

export function numberValue(root, selector, fallback = 0) {
  const value = Number(valueOf(root, selector));
  return Number.isFinite(value) ? value : fallback;
}

export function checkedOf(root, selector) {
  const el = root.querySelector(selector);
  return Boolean(el?.checked);
}