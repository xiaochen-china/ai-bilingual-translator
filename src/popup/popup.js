/**
 * 工具栏弹窗：当前页面状态、翻译/还原、模式切换、引擎切换、字幕开关、入口按钮。
 */

import {
  activeTab,
  ensureContentScript,
  isRestrictedUrl,
  openOptions,
  openSidePanel,
  send,
  sendToPage,
  toast,
} from '../ui/common.js';

const MODES = [
  { id: 'bilingual', label: '双语' },
  { id: 'zh', label: '仅中文' },
  { id: 'hover', label: '悬停' },
  { id: 'off', label: '英文' },
];

const state = {
  tab: null,
  settings: null,
  engines: [],
  modes: new Map(),
  page: { active: false, mode: 'bilingual', stats: { total: 0, done: 0, failed: 0 } },
  subtitles: { running: false, mode: 'none', cueCount: 0 },
  pollTimer: null,
  pageReady: false,
};

const $ = (selector) => document.querySelector(selector);

function engineLabel(engine) {
  const badge = engine.requiresKey ? '需密钥' : '免费';
  return `${engine.name}（${badge}）`;
}

function setPageState(text, kind = '') {
  const el = $('#page-state');
  el.textContent = text;
  el.className = kind ? `badge ${kind}` : '';
}

function renderModes() {
  const box = $('#modes');
  box.textContent = '';
  for (const mode of MODES) {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = mode.label;
    button.setAttribute('aria-pressed', String(state.page.mode === mode.id));
    button.addEventListener('click', async () => {
      try {
        if (mode.id === 'off') {
          await sendToPage(state.tab.id, { type: 'page.restore', payload: {} });
        } else {
          await sendToPage(state.tab.id, { type: 'page.setMode', payload: { mode: mode.id } });
        }
        await send('settings.patch', { patch: { mode: mode.id } });
        await refreshState();
      } catch (error) {
        toast(error.message, 'error');
      }
    });
    box.appendChild(button);
  }
}

function renderEngines() {
  const select = $('#engine');
  select.textContent = '';
  for (const engine of state.engines) {
    const option = document.createElement('option');
    option.value = engine.id;
    option.textContent = engineLabel(engine);
    select.appendChild(option);
  }
  select.value = state.settings.engineId;
  select.addEventListener('change', async () => {
    await send('settings.patch', { patch: { engineId: select.value } });
    state.settings.engineId = select.value;
    updateEngineHint();
    toast('已切换引擎，已翻译的页面需要重新翻译才能生效。', 'info', 3000);
  });
}

function updateEngineHint() {
  const engine = state.engines.find((item) => item.id === state.settings.engineId);
  const hint = $('#engine-hint');
  if (!engine) {
    hint.textContent = '';
    return;
  }
  const keyStatus = state.keyStatus?.[engine.id];
  if (engine.requiresKey && keyStatus && !keyStatus.hasKey) {
    hint.textContent = '该引擎需要 API Key：请到「设置 → 翻译引擎」填写。';
    hint.style.color = 'var(--danger)';
  } else {
    hint.textContent = engine.description || '';
    hint.style.color = '';
  }
}

function updateTranslateButton() {
  const button = $('#btn-translate');
  const { active, stats } = state.page;
  button.textContent = active ? '还原原文' : '翻译本页';
  button.classList.toggle('danger', active);

  const progressWrap = $('#progress-wrap');
  const progress = $('#progress');
  if (active && stats.total > 0) {
    const ratio = Math.min(1, (stats.done + stats.failed) / stats.total);
    progressWrap.hidden = false;
    progress.style.width = `${Math.round(ratio * 100)}%`;
    $('#stat-count').textContent = `${stats.done}/${stats.total}`;
  } else {
    progressWrap.hidden = true;
    $('#stat-count').textContent = '';
  }
}

function updateSubtitleRow() {
  const isVideoSite = /(^|\.)(youtube\.com|bilibili\.com)$/i.test(state.tab?.url ? new URL(state.tab.url).hostname : '');
  const row = $('#row-subtitle');
  const panelButton = $('#btn-subtitle-panel');
  row.hidden = !isVideoSite;
  panelButton.hidden = !isVideoSite;
  if (!isVideoSite) return;
  const button = $('#btn-subtitle');
  button.textContent = state.subtitles.running ? '关闭字幕' : '开启字幕';
  button.classList.toggle('primary', !state.subtitles.running);
}

async function refreshState() {
  if (!state.tab?.id || state.restricted) return;
  try {
    const response = await sendToPage(state.tab.id, { type: 'page.state', payload: {} }, { injectIfMissing: false });
    const payload = response?.payload || {};
    if (payload.page) state.page = payload.page;
    if (payload.subtitles) state.subtitles = payload.subtitles;
    state.pageReady = true;
    renderModes();
    updateTranslateButton();
    updateSubtitleRow();
    setPageState(
      state.page.active ? '正在双语显示' : '未翻译',
      state.page.active ? 'ok' : '',
    );
    if (state.page.fatal) setPageState('翻译失败', 'err');
  } catch {
    state.pageReady = false;
    setPageState('需要刷新页面', 'warn');
    updateTranslateButton();
  }
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(() => {
    if (!state.page.active) return;
    refreshState().catch(() => {});
  }, 800);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function onTranslateClick() {
  const button = $('#btn-translate');
  button.disabled = true;
  try {
    if (state.page.active) {
      await sendToPage(state.tab.id, { type: 'page.restore', payload: {} });
      await refreshState();
      toast('已还原原文', 'success');
    } else {
      const result = await sendToPage(state.tab.id, {
        type: 'page.translate',
        payload: { mode: state.settings.mode === 'off' ? 'bilingual' : state.settings.mode },
      });
      const payload = result?.payload || {};
      if (payload.ok === false) {
        const reasons = {
          SKIPPED_PAGE: '当前页面不支持翻译。',
          MODE_OFF: '当前是「仅英文」模式，请先切换模式。',
          NOTHING_TO_TRANSLATE: '没有找到可翻译的英文正文。',
        };
        toast(reasons[payload.reason] || '翻译未能开始。', 'error');
      }
      await refreshState();
      startPolling();
    }
  } catch (error) {
    toast(error.message, 'error', 4000);
  } finally {
    button.disabled = false;
  }
}

async function onSubtitleClick() {
  const button = $('#btn-subtitle');
  button.disabled = true;
  try {
    const response = await sendToPage(state.tab.id, { type: 'page.subtitle.toggle', payload: {} });
    const payload = response?.payload || {};
    if (payload.ok === false) {
      const reasons = {
        UNSUPPORTED_SITE: '当前站点暂不支持字幕（支持 YouTube / Bilibili）。',
        NO_VIDEO: '没有找到视频元素。',
        DISABLED: '字幕功能已在设置中关闭。',
      };
      toast(reasons[payload.reason] || '字幕开启失败。', 'error', 4000);
    }
    await refreshState();
  } catch (error) {
    toast(error.message, 'error', 4000);
  } finally {
    button.disabled = false;
  }
}

async function init() {
  $('#version').textContent = `v${chrome.runtime.getManifest().version}`;

  const { settings, engines, keyStatus } = await send('settings.get');
  state.settings = settings;
  state.engines = engines;
  state.keyStatus = keyStatus;
  renderEngines();
  updateEngineHint();

  $('#lookup-toggle').checked = settings.lookup?.enabled !== false;
  $('#lookup-toggle').addEventListener('change', async (event) => {
    await send('settings.patch', { patch: { lookup: { enabled: event.target.checked } } });
  });

  state.tab = await activeTab();
  state.restricted = isRestrictedUrl(state.tab?.url);

  if (state.restricted) {
    setPageState('当前页面不可翻译', 'warn');
    $('#btn-translate').disabled = true;
    $('#footer-hint').textContent = '浏览器内部页面、扩展商店等页面不允许注入脚本。';
    renderModes();
    return;
  }

  // 旧标签页可能还没注入内容脚本：先探测，失败再补注入一次（避免重复注入）
  try {
    await sendToPage(state.tab.id, { type: 'page.state', payload: {} }, { injectIfMissing: false });
  } catch {
    try {
      await ensureContentScript(state.tab.id);
    } catch {
      // 注入失败时保留提示，不阻塞弹窗
    }
  }

  renderModes();
  await refreshState();
  updateSubtitleRow();

  $('#btn-translate').addEventListener('click', onTranslateClick);
  $('#btn-subtitle').addEventListener('click', onSubtitleClick);
  $('#btn-subtitle-panel').addEventListener('click', () => {
    const url = `${chrome.runtime.getURL('src/subtitle/subtitle.html')}?tabId=${state.tab?.id ?? ''}`;
    chrome.tabs.create({ url });
  });
  $('#btn-options').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });
  $('#btn-wordbook').addEventListener('click', () => openSidePanel('wordbook'));
  $('#btn-history').addEventListener('click', () => openSidePanel('history'));

  startPolling();
  window.addEventListener('unload', stopPolling);
}

init().catch((error) => {
  setPageState('初始化失败', 'err');
  $('#footer-hint').textContent = error.message;
  console.error(error);
});