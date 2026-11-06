/**
 * Service Worker 入口（MV3）。
 * 只做三件事：接收消息并分发、处理快捷键、把设置变更广播给内容脚本。
 */

import { MESSAGE, STORAGE_KEYS } from '../common/constants.js';
import { handleMessage } from './router.js';
import { getSettings } from './settings-service.js';

/* ------------------------------------------------------------------ */
/* 消息                                                                */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 内容脚本的可等待响应：返回 true 表示异步回复
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      sendResponse({
        v: message?.v ?? null,
        type: `${message?.type || 'unknown'}:result`,
        id: message?.id ?? null,
        ok: false,
        error: { code: 'UNKNOWN', message: String(error?.message || error), details: {} },
      });
    });
  return true;
});

/* ------------------------------------------------------------------ */
/* 快捷键                                                              */
/* ------------------------------------------------------------------ */

const SHORTCUT_ACTIONS = {
  'translate-page': MESSAGE.PAGE_TRANSLATE,
  'toggle-mode': MESSAGE.PAGE_SET_MODE,
  'lookup-selection': MESSAGE.PAGE_LOOKUP_SELECTION,
};

chrome.commands?.onCommand.addListener(async (command) => {
  const type = SHORTCUT_ACTIONS[command];
  if (!type) return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await chrome.tabs.sendMessage(tab.id, {
      v: 1,
      type,
      id: `cmd-${Date.now()}`,
      payload: command === 'toggle-mode' ? { cycle: true } : {},
    });
  } catch {
    // 页面没有内容脚本（chrome://、PDF 预览等）时忽略
  }
});

/* ------------------------------------------------------------------ */
/* 右键菜单：查询选中的文字                                            */
/* ------------------------------------------------------------------ */

const CONTEXT_MENU_ID = 'abt-lookup-selection';

function createContextMenus() {
  if (!chrome.contextMenus?.create) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: CONTEXT_MENU_ID,
        title: '用 AI 双语翻译查询“%s”',
        contexts: ['selection'],
      },
      () => chrome.runtime.lastError && undefined,
    );
  });
}

chrome.contextMenus?.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== CONTEXT_MENU_ID) return;
  const text = String(info.selectionText || '').trim();
  if (!tab?.id || !text) return;
  const message = { v: 1, type: MESSAGE.PAGE_LOOKUP_SELECTION, id: `ctx-${Date.now()}`, payload: { text } };
  try {
    await chrome.tabs.sendMessage(tab.id, message);
  } catch {
    // 内容脚本尚未注入（例如安装后没有刷新页面）：注入一次再重试
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: [
          'src/content/core.js',
          'src/content/page-translator.js',
          'src/content/selection.js',
          'src/content/subtitles.js',
          'src/content/main.js',
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 120));
      await chrome.tabs.sendMessage(tab.id, message);
    } catch {
      // chrome:// 等受限页面，忽略
    }
  }
});

/* ------------------------------------------------------------------ */
/* 设置变更广播                                                        */
/* ------------------------------------------------------------------ */

chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local' || !(STORAGE_KEYS.SETTINGS in changes)) return;
  try {
    const settings = await getSettings();
    const tabs = await chrome.tabs.query({});
    await Promise.all(
      tabs
        .filter((tab) => Number.isInteger(tab.id))
        .map(async (tab) => {
          try {
            await chrome.tabs.sendMessage(tab.id, {
              v: 1,
              type: 'settings.changed',
              id: `push-${Date.now()}-${tab.id}`,
              payload: { settings },
            });
          } catch {
            // 没有内容脚本的标签页会抛错，忽略
          }
        }),
    );
  } catch {
    // 广播失败不影响主流程
  }
});

/* ------------------------------------------------------------------ */
/* 安装与启动                                                          */
/* ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  createContextMenus();
  if (details.reason === 'install') {
    // 首次安装直接打开设置页，引导用户选择引擎、填写密钥
    chrome.runtime.openOptionsPage?.();
  }
});

chrome.runtime.onStartup?.addListener(() => {
  // 会话级密钥在浏览器重启后自然失效；这里不做任何持久化动作，避免误存密钥
  createContextMenus();
});

// Service Worker 被回收后重新启动时也保证菜单存在
createContextMenus();