/**
 * 侧边栏：生词本 + 查询历史。
 * 数据全部来自 Service Worker（settings.wordbook / settings.history.items）。
 */

import { copyText, formatTime, send, timeAgo, toast } from '../ui/common.js';

const $ = (id) => document.getElementById(id);

const state = {
  tab: 'wordbook',
  filter: '',
  wordbook: [],
  history: [],
};

const TAB_LABELS = { wordbook: '生词本', history: '查询历史' };

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function currentItems() {
  return state.tab === 'wordbook' ? state.wordbook : state.history;
}

function filteredItems() {
  const filter = state.filter.trim().toLowerCase();
  if (!filter) return currentItems();
  return currentItems().filter((item) =>
    `${item.text || ''} ${item.translation || ''}`.toLowerCase().includes(filter),
  );
}

function buildEmpty() {
  const box = document.createElement('div');
  box.className = 'sp-empty';
  if (state.filter) {
    box.textContent = '没有匹配的条目。';
  } else if (state.tab === 'wordbook') {
    box.innerHTML =
      '生词本还是空的。<br />在网页中选中英文，点击划词面板里的「＋ 生词本」即可收藏。';
  } else {
    box.innerHTML = '还没有查询记录。<br />选中英文后会自动出现查询结果，并记入历史。';
  }
  return box;
}

function buildItem(item) {
  const card = document.createElement('div');
  card.className = 'sp-item';

  const head = document.createElement('div');
  head.className = 'sp-item-head';
  const text = document.createElement('span');
  text.className = 'sp-item-text';
  text.textContent = item.text || '';
  head.append(text);
  if (item.pos) {
    const pos = document.createElement('span');
    pos.className = 'sp-item-pos';
    pos.textContent = item.pos;
    head.append(pos);
  }

  const trans = document.createElement('div');
  trans.className = 'sp-item-trans';
  trans.textContent = item.translation || '（暂无译文）';

  const meta = document.createElement('div');
  meta.className = 'sp-item-meta';

  const when = document.createElement('span');
  when.textContent = item.createdAt ? `${timeAgo(item.createdAt)} · ${formatTime(item.createdAt)}` : '';
  when.title = when.textContent;
  meta.append(when);

  const engine = document.createElement('span');
  engine.textContent = item.engineName || item.engineId || '';
  meta.append(engine);

  const spacer = document.createElement('span');
  spacer.className = 'spacer';
  meta.append(spacer);

  const copyButton = document.createElement('button');
  copyButton.type = 'button';
  copyButton.className = 'btn ghost small';
  copyButton.textContent = '复制';
  copyButton.addEventListener('click', async () => {
    const ok = await copyText(item.translation || item.text || '');
    toast(ok ? '已复制译文' : '复制失败', ok ? 'success' : 'error');
  });
  meta.append(copyButton);

  if (state.tab === 'wordbook') {
    const removeButton = document.createElement('button');
    removeButton.type = 'button';
    removeButton.className = 'btn ghost small';
    removeButton.textContent = '移除';
    removeButton.addEventListener('click', () => removeWordbook(item.id));
    meta.append(removeButton);
  } else if (item.url) {
    const openButton = document.createElement('button');
    openButton.type = 'button';
    openButton.className = 'btn ghost small';
    openButton.textContent = '来源';
    openButton.title = item.title || item.url;
    openButton.addEventListener('click', () => {
      chrome.tabs.create({ url: item.url }).catch(() => {});
    });
    meta.append(openButton);
  }

  card.append(head, trans, meta);
  return card;
}

function render() {
  const list = $('list');
  list.textContent = '';
  const items = filteredItems();
  if (!items.length) {
    list.append(buildEmpty());
  } else {
    for (const item of items) list.append(buildItem(item));
  }

  $('tab-wordbook').setAttribute('aria-selected', String(state.tab === 'wordbook'));
  $('tab-history').setAttribute('aria-selected', String(state.tab === 'history'));
  $('tab-wordbook').textContent = `生词本 ${state.wordbook.length}`;
  $('tab-history').textContent = `查询历史 ${state.history.length}`;
  $('btn-clear').textContent = `清空${TAB_LABELS[state.tab]}`;
}

/* ------------------------------------------------------------------ */
/* 数据操作                                                            */
/* ------------------------------------------------------------------ */

async function refresh() {
  try {
    const [wordbook, history] = await Promise.all([send('wordbook.list'), send('history.list')]);
    state.wordbook = Array.isArray(wordbook.items) ? wordbook.items : [];
    state.history = Array.isArray(history.items) ? history.items : [];
    render();
  } catch (error) {
    toast(error.message || '读取失败', 'error');
  }
}

async function removeWordbook(id) {
  try {
    const res = await send('wordbook.remove', { id });
    state.wordbook = Array.isArray(res.items) ? res.items : state.wordbook.filter((item) => item.id !== id);
    render();
    toast('已从生词本移除');
  } catch (error) {
    toast(error.message || '移除失败', 'error');
  }
}

async function clearCurrent() {
  if (state.tab === 'wordbook') {
    if (!state.wordbook.length) return;
    if (!window.confirm(`确定清空 ${state.wordbook.length} 条生词吗？该操作不可恢复。`)) return;
    for (const item of [...state.wordbook]) {
      try {
        await send('wordbook.remove', { id: item.id });
      } catch {
        // 忽略单条失败
      }
    }
    state.wordbook = [];
  } else {
    if (!state.history.length) return;
    if (!window.confirm(`确定清空 ${state.history.length} 条查询历史吗？`)) return;
    await send('history.clear');
    state.history = [];
  }
  render();
  toast('已清空');
}

function exportCurrent() {
  const items = currentItems();
  if (!items.length) {
    toast('列表为空，无需导出', 'info');
    return;
  }
  const blob = new Blob([JSON.stringify(items, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `${state.tab === 'wordbook' ? 'wordbook' : 'history'}-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 JSON');
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

function switchTab(tab) {
  state.tab = tab;
  state.filter = '';
  $('filter').value = '';
  render();
}

$('tab-wordbook').addEventListener('click', () => switchTab('wordbook'));
$('tab-history').addEventListener('click', () => switchTab('history'));
$('btn-refresh').addEventListener('click', refresh);
$('btn-export').addEventListener('click', exportCurrent);
$('btn-clear').addEventListener('click', clearCurrent);
$('btn-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('filter').addEventListener('input', (event) => {
  state.filter = event.target.value;
  render();
});

// 后台设置变化（例如在设置页清空生词本）时自动刷新
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes['abt:settings']) refresh();
});

refresh();