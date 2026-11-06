/**
 * 视频双语字幕（V2.0）。
 *
 * 支持 YouTube：优先走 timedtext（背景脚本读轨道 + 拉取 json3），
 * 失败时回退到「监听站点原生字幕 DOM」的低可靠路径，并如实告诉用户当前处于回退模式。
 *
 * 字幕译文按需批量翻译（当前句 + 后续 2 句优先），并用 Map 缓存，避免重复请求。
 */

(function installSubtitles() {
  'use strict';

  const NS = window.__ABT__;
  if (!NS || NS.__subtitlesInstalled) return;
  NS.__subtitlesInstalled = true;

  const LAYER_ID = 'abt-subtitle-layer';
  const HIDE_NATIVE_ID = 'abt-hide-native';

  const state = {
    running: false,
    mode: 'timedtext', // timedtext | dom | none
    cues: [],
    track: null,
    tracks: [],
    lastIndex: -1,
    video: null,
    rafId: null,
    domTimer: null,
    domLastText: '',
    translations: new Map(),
    pending: new Set(),
    queue: [],
    pumping: false,
    layer: null,
    sourceEl: null,
    transEl: null,
    statusEl: null,
    currentText: '',
    lastVideoId: '',
    warmup: false,
  };

  function settings() {
    return NS.settings || {};
  }

  function subtitleOptions() {
    const options = settings().subtitles || {};
    return {
      enabled: options.enabled !== false,
      hideNative: options.hideNative !== false,
      showSource: options.showSource !== false,
      fontScale: Number(options.fontScale) || 1,
      position: Number.isFinite(options.position) ? options.position : 12,
      gap: Number(options.gap) || 6,
      color: options.color || '#ffffff',
      translatedColor: options.translatedColor || '#ffd54f',
      background: options.background || 'rgba(0,0,0,0.62)',
      maxWidth: Number(options.maxWidth) || 80,
    };
  }

  const isYouTube = () => /(^|\.)youtube\.com$/i.test(location.hostname);
  const isBilibili = () => /(^|\.)bilibili\.com$/i.test(location.hostname);
  const supportedSite = () => isYouTube() || isBilibili();

  function currentVideoId() {
    try {
      const url = new URL(location.href);
      if (isYouTube()) return url.searchParams.get('v') || '';
      if (isBilibili()) return url.pathname.split('/').filter(Boolean).pop() || '';
    } catch {
      // ignore
    }
    return '';
  }

  /* ------------------------------------------------------------------ */
  /* 字幕层                                                              */
  /* ------------------------------------------------------------------ */

  function ensureLayer() {
    if (state.layer && state.layer.isConnected) return state.layer;
    const root = NS.shadowRoot();
    root.querySelector?.('#' + LAYER_ID)?.remove();
    const options = subtitleOptions();

    const layer = document.createElement('div');
    layer.id = LAYER_ID;
    layer.setAttribute(NS.DOM.ATTR_UI, '');
    layer.style.cssText = [
      'position: fixed',
      'left: 50%',
      `bottom: ${options.position}%`,
      'transform: translateX(-50%)',
      `max-width: ${options.maxWidth}%`,
      'min-width: 220px',
      'padding: 8px 14px',
      'border-radius: 8px',
      `background: ${options.background}`,
      'text-align: center',
      'pointer-events: none',
      'display: none',
      'backdrop-filter: blur(2px)',
      'font: 600 ' + (18 * options.fontScale) + 'px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      'z-index: 2147483646',
    ].join(';');

    const source = document.createElement('div');
    source.style.cssText = `color:${options.color};opacity:.92;white-space:pre-wrap;margin-bottom:${options.gap}px;`;
    const translated = document.createElement('div');
    translated.style.cssText = `color:${options.translatedColor};white-space:pre-wrap;`;
    translated.textContent = '';
    const status = document.createElement('div');
    status.style.cssText = 'color:#ffd54f;font-size:12px;opacity:.9;margin-top:4px;white-space:pre-wrap;';
    status.textContent = '';

    if (!options.showSource) source.style.display = 'none';
    layer.append(source, translated, status);
    root.appendChild(layer);

    state.layer = layer;
    state.sourceEl = source;
    state.transEl = translated;
    state.statusEl = status;
    return layer;
  }

  function setStatus(message) {
    if (!state.statusEl) return;
    if (message) state.statusEl.textContent = message;
    else state.statusEl.textContent = '';
  }

  function showLayer(show) {
    if (state.layer) state.layer.style.display = show ? 'block' : 'none';
  }

  function applyNativeVisibility() {
    const options = subtitleOptions();
    const existing = document.getElementById(HIDE_NATIVE_ID);
    if (!state.running || !options.hideNative) {
      existing?.remove();
      return;
    }
    if (existing) return;
    const style = document.createElement('style');
    style.id = HIDE_NATIVE_ID;
    style.setAttribute(NS.DOM.ATTR_UI, '');
    style.textContent = [
      '.ytp-caption-window-container { display: none !important; }',
      '.ytp-caption-segment { display: none !important; }',
      '.bpx-player-subtitle-panel-text, .bilibili-player-video-subtitle { display: none !important; }',
    ].join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  /* ------------------------------------------------------------------ */
  /* 翻译队列                                                            */
  /* ------------------------------------------------------------------ */

  function enqueueTranslation(text) {
    if (!text) return;
    if (state.translations.has(text) || state.pending.has(text)) return;
    if (!state.queue.includes(text)) state.queue.push(text);
    pumpTranslations();
  }

  async function pumpTranslations() {
    if (state.pumping || !state.running) return;
    state.pumping = true;
    try {
      while (state.queue.length && state.running) {
        const batch = state.queue.splice(0, 10);
        for (const text of batch) state.pending.add(text);
        try {
          const response = await NS.send(NS.MESSAGE.TRANSLATE, {
            items: batch.map((text, index) => ({ id: String(index), text })),
            requestId: `subtitle-${Date.now()}`,
          });
          const byId = new Map((response.results || []).map((item) => [item.id, item.translated]));
          batch.forEach((text, index) => {
            const translated = byId.get(String(index)) || '';
            if (translated) state.translations.set(text, translated);
          });
        } catch (error) {
          NS.log('字幕翻译失败', error);
          if (['NO_API_KEY', 'AUTH_ERROR', 'ENGINE_DISABLED'].includes(error.code)) {
            setStatus('翻译不可用：请在扩展设置中配置引擎');
            state.queue.length = 0;
            break;
          }
        } finally {
          for (const text of batch) state.pending.delete(text);
        }
      }
    } finally {
      state.pumping = false;
    }
  }

  /* ------------------------------------------------------------------ */
  /* 时间轴同步                                                          */
  /* ------------------------------------------------------------------ */

  function findCueIndex(time) {
    const cues = state.cues;
    if (!cues.length) return -1;
    let low = 0;
    let high = cues.length - 1;
    let found = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const cue = cues[mid];
      if (time < cue.start) high = mid - 1;
      else if (time > cue.end) low = mid + 1;
      else {
        found = mid;
        break;
      }
    }
    return found;
  }

  function renderCue(cue) {
    ensureLayer();
    if (!cue) {
      showLayer(false);
      return;
    }
    showLayer(true);
    if (state.sourceEl) state.sourceEl.textContent = cue.text;
    const translated = state.translations.get(cue.text);
    if (translated) {
      if (state.transEl) state.transEl.textContent = translated;
    } else {
      if (state.transEl) state.transEl.textContent = '…';
      enqueueTranslation(cue.text);
    }
  }

  function tick() {
    if (!state.running || !state.video) return;
    const video = state.video;
    if (!video.paused && !video.ended) {
      const index = findCueIndex(video.currentTime);
      if (index !== state.lastIndex) {
        state.lastIndex = index;
        renderCue(index >= 0 ? state.cues[index] : null);
        // 预取后续 3 句
        for (let offset = 0; offset < 3; offset += 1) {
          const next = state.cues[index + offset];
          if (next) enqueueTranslation(next.text);
        }
      }
      state.rafId = requestAnimationFrame(tick);
    } else {
      // 暂停时降低轮询频率
      state.rafId = setTimeout(() => {
        state.rafId = null;
        tick();
      }, 320);
    }
  }

  function stopTick() {
    if (state.rafId !== null && state.rafId !== undefined) {
      if (typeof state.rafId === 'number') cancelAnimationFrame(state.rafId);
      clearTimeout(state.rafId);
    }
    state.rafId = null;
  }

  /* ------------------------------------------------------------------ */
  /* 数据获取                                                            */
  /* ------------------------------------------------------------------ */

  async function loadTimedtextCues() {
    const response = await NS.send(NS.MESSAGE.SUBTITLE_CUES, {
      videoId: currentVideoId(),
    });
    if (response?.ok) {
      state.cues = response.cues || [];
      state.track = response.track || null;
      state.tracks = response.tracks || [];
      state.mode = 'timedtext';
      return state.cues.length > 0;
    }
    state.mode = 'none';
    state.lastFailure = response?.reason || 'UNKNOWN';
    NS.log('timedtext 字幕获取失败', response);
    return false;
  }

  /* ------------------------------------------------------------------ */
  /* DOM 回退：监听站点原生字幕                                          */
  /* ------------------------------------------------------------------ */

  const NATIVE_SELECTORS = [
    '.ytp-caption-segment',
    '.bpx-player-subtitle-panel-text',
    '.bilibili-player-video-subtitle',
    '.caption-window .captions-text',
  ];

  function readNativeSubtitle() {
    for (const selector of NATIVE_SELECTORS) {
      const nodes = document.querySelectorAll(selector);
      if (!nodes.length) continue;
      const text = NS.normalizeText(Array.from(nodes).map((node) => node.textContent || '').join(' '));
      if (text) return text;
    }
    return '';
  }

  function startDomFallback() {
    state.mode = 'dom';
    ensureLayer();
    setStatus('已回退到站点原生字幕识别（可靠性低于字幕 API）');
    state.domTimer = setInterval(async () => {
      if (!state.running) return;
      const text = readNativeSubtitle();
      if (!text || text === state.domLastText) return;
      state.domLastText = text;
      state.currentText = text;
      showLayer(true);
      if (state.sourceEl) state.sourceEl.textContent = text;
      if (state.translations.has(text)) {
        if (state.transEl) state.transEl.textContent = state.translations.get(text);
        return;
      }
      if (state.transEl) state.transEl.textContent = '…';
      enqueueTranslation(text);
      // 翻译完成后刷新
      const check = setInterval(() => {
        clearInterval(check);
        if (state.running && state.translations.has(text) && state.transEl) {
          state.transEl.textContent = state.translations.get(text);
        }
      }, 400);
    }, 400);
  }

  /* ------------------------------------------------------------------ */
  /* 生命周期                                                            */
  /* ------------------------------------------------------------------ */

  function findVideo() {
    const video = document.querySelector('video');
    return video && video.readyState >= 0 ? video : null;
  }

  async function waitForVideo(timeoutMs = 12000) {
    const existing = findVideo();
    if (existing) return existing;
    return new Promise((resolve) => {
      const started = Date.now();
      const timer = setInterval(() => {
        const video = findVideo();
        if (video) {
          clearInterval(timer);
          resolve(video);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer);
          resolve(null);
        }
      }, 400);
    });
  }

  async function start({ silent = false } = {}) {
    if (!subtitleOptions().enabled) {
      if (!silent) NS.toast('字幕功能已在设置中关闭。', { type: 'error' });
      return { ok: false, reason: 'DISABLED' };
    }
    if (!supportedSite()) {
      if (!silent) NS.toast('当前站点暂不支持字幕（目前支持 YouTube / Bilibili）。', { type: 'error' });
      return { ok: false, reason: 'UNSUPPORTED_SITE' };
    }
    if (state.running) return { ok: true, alreadyRunning: true, mode: state.mode };

    const video = await waitForVideo();
    if (!video) {
      if (!silent) NS.toast('没有找到视频元素。', { type: 'error' });
      return { ok: false, reason: 'NO_VIDEO' };
    }

    await NS.fetchSettings();
    state.video = video;
    state.running = true;
    state.translations.clear();
    state.queue.length = 0;
    state.lastIndex = -1;
    state.lastVideoId = currentVideoId();

    ensureLayer();
    applyNativeVisibility();
    setStatus('');

    const ok = await loadTimedtextCues();
    if (!ok) {
      if (!silent) {
        NS.toast('未能通过字幕接口获取字幕，正在尝试识别站点原生字幕。', { duration: 3200 });
      }
      startDomFallback();
    } else {
      setStatus('');
      // 预热前 20 句，减少开始时的等待
      state.cues.slice(0, 20).forEach((cue) => enqueueTranslation(cue.text));
    }

    stopTick();
    tick();

    video.addEventListener('loadedmetadata', onVideoChanged);
    document.addEventListener('loadedmetadata', onVideoChanged, true);
    return { ok: true, mode: state.mode, cueCount: state.cues.length };
  }

  function onVideoChanged() {
    if (!state.running) return;
    const id = currentVideoId();
    if (id && id !== state.lastVideoId) {
      state.lastVideoId = id;
      refresh();
    }
  }

  async function refresh() {
    if (!state.running) return;
    state.cues = [];
    state.translations.clear();
    state.queue.length = 0;
    state.lastIndex = -1;
    state.domLastText = '';
    clearInterval(state.domTimer);
    state.domTimer = null;
    const ok = await loadTimedtextCues();
    if (!ok) startDomFallback();
    else state.cues.slice(0, 20).forEach((cue) => enqueueTranslation(cue.text));
  }

  function stop() {
    state.running = false;
    stopTick();
    clearInterval(state.domTimer);
    state.domTimer = null;
    state.queue.length = 0;
    showLayer(false);
    state.layer?.remove();
    state.layer = null;
    state.sourceEl = null;
    state.transEl = null;
    state.statusEl = null;
    document.getElementById(HIDE_NATIVE_ID)?.remove();
    document.removeEventListener('loadedmetadata', onVideoChanged, true);
    state.mode = 'none';
    state.cues = [];
    state.lastIndex = -1;
    return { ok: true };
  }

  async function toggle() {
    if (state.running) return { ...stop(), running: false };
    const result = await start();
    return { ...result, running: state.running };
  }

  NS.Subtitles = {
    start,
    stop,
    toggle,
    refresh,
    isRunning: () => state.running,
    getState: () => ({
      running: state.running,
      mode: state.mode,
      cueCount: state.cues.length,
      translated: state.translations.size,
      track: state.track,
    }),
    supportedSite,
  };
})();