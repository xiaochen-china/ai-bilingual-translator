/**
 * 视频字幕面板（独立标签页）。
 *
 * 作用：
 *  1. 展示当前视频可用的字幕轨道，并允许手动切换；
 *  2. 批量翻译整条字幕轨道，方便对照阅读；
 *  3. 无法获取字幕时给出明确原因，绝不伪造字幕、绝不无限重试。
 */

import { copyText, send, toast } from '../ui/common.js';

const $ = (id) => document.getElementById(id);

const state = {
  tabId: null,
  videoId: '',
  tracks: [],
  track: null,
  cues: [],
  translations: new Map(),
  busy: false,
};

const REASON_TEXT = {
  NO_TRACKS: '该视频没有可用的人工字幕轨道（也可能只有自动生成字幕，而当前站点未开放接口）。',
  NO_URL: '字幕轨道缺少可用地址，可能被站点限制。',
  BAD_URL: '字幕地址不合法，已停止请求以避免无效重试。',
  NETWORK: '无法连接字幕服务，请检查网络或站点登录状态。',
  HTTP: '字幕服务返回了错误状态，可能该视频的字幕需要登录或已受限。',
  EMPTY: '字幕接口返回了空内容。YouTube 目前要求字幕请求携带 PoToken，未携带的第三方请求会拿到 200 + 空响应，因此这条链路暂时不可用；页面内的扩展会自动回退到「读取站点原生字幕」。',
  NOT_SUPPORTED: '当前页面不是受支持的视频站点（目前支持 YouTube 与 Bilibili）。',
};

const STATUS = {
  idle: '未检测',
  ok: '字幕可用',
  error: '字幕不可用',
};

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function formatClock(ms) {
  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatSrtTime(ms) {
  const value = Math.max(0, Math.round(Number(ms) || 0));
  const hours = Math.floor(value / 3600000);
  const minutes = Math.floor((value % 3600000) / 60000);
  const seconds = Math.floor((value % 60000) / 1000);
  const millis = value % 1000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')},${String(millis).padStart(3, '0')}`;
}

function setStatus(kind, text) {
  const badge = $('status-badge');
  badge.className = kind === 'ok' ? 'badge ok' : kind === 'error' ? 'badge err' : 'badge';
  badge.textContent = text;
}

function showNote(message, isError = true) {
  const note = $('note');
  if (!message) {
    note.hidden = true;
    note.textContent = '';
    return;
  }
  note.className = isError ? 'sub-note error' : 'sub-note';
  note.textContent = message;
  note.hidden = false;
}

function updateButtons() {
  const hasCues = state.cues.length > 0;
  $('btn-translate').disabled = !hasCues || state.busy;
  $('btn-copy').disabled = !hasCues;
  $('btn-export').disabled = !hasCues;
}

/* ------------------------------------------------------------------ */
/* 渲染                                                                */
/* ------------------------------------------------------------------ */

function renderTracks() {
  const select = $('track-select');
  select.textContent = '';
  for (const track of state.tracks) {
    const option = document.createElement('option');
    option.value = track.baseUrl || track.vssId || track.languageCode;
    option.textContent = `${track.name || track.languageCode}${track.kind === 'asr' ? '（自动生成）' : ''}`;
    if (state.track && (state.track.baseUrl === track.baseUrl || state.track.vssId === track.vssId)) {
      option.selected = true;
    }
    select.append(option);
  }
  select.disabled = state.tracks.length <= 1;
}

function renderCues() {
  const body = $('cue-body');
  body.textContent = '';
  if (!state.cues.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'hint';
    cell.textContent = '没有可显示的字幕。';
    row.append(cell);
    body.append(row);
    updateButtons();
    return;
  }

  for (const [index, cue] of state.cues.entries()) {
    const row = document.createElement('tr');

    const timeCell = document.createElement('td');
    timeCell.className = 'cue-time';
    timeCell.textContent = formatClock(cue.start);

    const srcCell = document.createElement('td');
    srcCell.className = 'cue-src';
    srcCell.textContent = cue.text;

    const transCell = document.createElement('td');
    transCell.className = 'cue-trans';
    const translated = state.translations.get(index);
    if (translated) {
      transCell.textContent = translated;
    } else {
      transCell.classList.add('pending');
      transCell.textContent = '—';
    }

    row.append(timeCell, srcCell, transCell);
    body.append(row);
  }
  updateButtons();
}

/* ------------------------------------------------------------------ */
/* 数据加载                                                            */
/* ------------------------------------------------------------------ */

async function loadTracks() {
  setStatus('idle', '读取字幕轨道…');
  $('video-info').textContent = '';
  try {
    const res = await send('subtitle.tracks', { tabId: state.tabId });
    if (!res?.ok) {
      const reason = res?.reason || 'NO_TRACKS';
      setStatus('error', STATUS.error);
      showNote(REASON_TEXT[reason] || `无法读取字幕轨道（${reason}）。`);
      $('track-select').disabled = true;
      return;
    }
    state.videoId = res.videoId || '';
    state.tracks = Array.isArray(res.tracks) ? res.tracks : [];
    state.track = state.tracks[0] || null;
    $('video-info').textContent = state.videoId ? `视频 ID：${state.videoId}` : '';
    renderTracks();
    showNote('');
    if (state.track) await loadCues(state.track);
    else {
      setStatus('error', STATUS.error);
      showNote(REASON_TEXT.NO_TRACKS);
    }
  } catch (error) {
    setStatus('error', STATUS.error);
    showNote(`读取失败：${error.message || '未知错误'}`);
  }
}

async function loadCues(track) {
  state.track = track;
  state.cues = [];
  state.translations.clear();
  renderCues();
  setStatus('idle', '下载字幕内容…');
  try {
    const res = await send('subtitle.cues', { tabId: state.tabId, baseUrl: track.baseUrl, videoId: state.videoId });
    if (!res?.ok) {
      const reason = res?.reason || 'EMPTY';
      setStatus('error', STATUS.error);
      showNote(REASON_TEXT[reason] || `无法获取字幕内容（${reason}）。`);
      return;
    }
    state.cues = Array.isArray(res.cues) ? res.cues : [];
    setStatus('ok', `${STATUS.ok} · ${state.cues.length} 条`);
    showNote('');
    renderCues();
  } catch (error) {
    setStatus('error', STATUS.error);
    showNote(`下载失败：${error.message || '未知错误'}`);
  }
}

/* ------------------------------------------------------------------ */
/* 批量翻译                                                            */
/* ------------------------------------------------------------------ */

async function translateAll() {
  if (!state.cues.length || state.busy) return;
  state.busy = true;
  updateButtons();
  const button = $('btn-translate');
  const total = state.cues.length;
  const batchSize = 10;

  try {
    for (let offset = 0; offset < total; offset += batchSize) {
      const slice = state.cues.slice(offset, offset + batchSize);
      const items = slice.map((cue, indexInSlice) => ({ id: String(offset + indexInSlice), text: cue.text }));
      button.textContent = `翻译中 ${Math.min(offset + batchSize, total)}/${total}…`;
      let results;
      try {
        const res = await send('translate', { items, requestId: `subtitle-${Date.now()}-${offset}` });
        results = res.results || [];
      } catch (error) {
        toast(`字幕翻译中断：${error.message || '请求失败'}`, 'error', 4000);
        break;
      }
      for (const result of results) {
        const index = Number(result.id);
        if (Number.isInteger(index)) state.translations.set(index, result.translated);
      }
      renderCues();
    }
  } finally {
    state.busy = false;
    button.textContent = '翻译全部字幕';
    updateButtons();
  }
}

/* ------------------------------------------------------------------ */
/* 复制 / 导出                                                         */
/* ------------------------------------------------------------------ */

function buildBilingualText() {
  return state.cues
    .map((cue, index) => {
      const translated = state.translations.get(index);
      return translated ? `${cue.text}\n${translated}` : cue.text;
    })
    .join('\n\n');
}

function buildSrt() {
  return state.cues
    .map((cue, index) => {
      const parts = [
        String(index + 1),
        `${formatSrtTime(cue.start)} --> ${formatSrtTime(cue.end || cue.start + (cue.duration || 0))}`,
        cue.text,
      ];
      const translated = state.translations.get(index);
      if (translated) parts.push(translated);
      return parts.join('\n');
    })
    .join('\n\n');
}

function download(filename, text) {
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ------------------------------------------------------------------ */
/* 事件                                                                */
/* ------------------------------------------------------------------ */

function parseTabId() {
  const params = new URLSearchParams(location.search);
  const raw = Number(params.get('tabId'));
  return Number.isInteger(raw) && raw > 0 ? raw : null;
}

async function fallbackTabId() {
  // 未传 tabId 时（例如手动打开该页面）无法可靠定位视频标签页：
  // 扩展没有申请 "tabs" 权限，不做全量标签页枚举，改为提示用户从弹窗进入。
  return null;
}

$('track-select').addEventListener('change', (event) => {
  const track = state.tracks.find(
    (item) => (item.baseUrl || item.vssId || item.languageCode) === event.target.value,
  );
  if (track) loadCues(track);
});

$('btn-translate').addEventListener('click', translateAll);
$('btn-copy').addEventListener('click', async () => {
  const ok = await copyText(buildBilingualText());
  toast(ok ? '已复制双语字幕' : '复制失败', ok ? 'success' : 'error');
});
$('btn-export').addEventListener('click', () => {
  download(`subtitle-${state.videoId || 'video'}.srt`, buildSrt());
  toast('已导出 SRT');
});
$('btn-toggle-page').addEventListener('click', async () => {
  if (!state.tabId) {
    toast('未关联视频标签页，请从插件弹窗打开本面板。', 'error');
    return;
  }
  try {
    const res = await chrome.tabs.sendMessage(state.tabId, {
      v: 1,
      type: 'page.subtitle.toggle',
      id: `panel-${Date.now()}`,
      payload: {},
    });
    if (res?.ok) toast('已切换页面字幕');
    else toast('页面没有响应，请刷新视频页面后重试', 'error');
  } catch {
    toast('无法与视频页面通信，请刷新页面后重试', 'error');
  }
});
$('btn-settings').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});

async function init() {
  state.tabId = parseTabId() || (await fallbackTabId());
  if (!state.tabId) {
    setStatus('error', STATUS.error);
    showNote('未找到可用的视频标签页。请先在 YouTube 或 Bilibili 打开视频，再从插件弹窗点击「字幕面板」。');
    renderCues();
    return;
  }
  await loadTracks();
}

init();