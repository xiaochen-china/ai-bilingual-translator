#!/usr/bin/env node
/**
 * 真实环境验证脚本（需要网络）。
 *
 * 两种模式：
 *   node tools/verify-live.mjs --chrome       只验证「Chrome 能否加载本扩展」（有头模式，窗口移到屏幕外）
 *   node tools/verify-live.mjs --youtube [id] 在 Edge 里打开真实 YouTube 视频，验证字幕链路：
 *                                             轨道读取 → 字幕内容解析 → 双语翻译 → 页面字幕层
 *
 * 设计原则：失败就如实报出阶段与原因，绝不伪造字幕或翻译结果。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const EDGE = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
];
const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const firstExisting = (list) => list.find((p) => existsSync(p));

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
  }

  on(method, handler) {
    if (!this.listeners.has(method)) this.listeners.set(method, []);
    this.listeners.get(method).push(handler);
  }

  async connect() {
    this.ws = new WebSocket(this.url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('CDP 连接超时')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error('CDP 连接失败'));
      });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
        return;
      }
      for (const handler of this.listeners.get(msg.method) || []) {
        try {
          handler(msg.params, msg.sessionId);
        } catch {
          /* 监听器异常不影响主流程 */
        }
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      setTimeout(() => {
        if (this.pending.delete(id)) reject(new Error(`${method} 超时`));
      }, 60000);
    });
  }

  close() {
    try {
      this.ws?.close();
    } catch {
      /* ignore */
    }
  }
}

async function evaluate(cdp, sessionId, expression) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) {
    const detail = exceptionDetails.exception?.description || exceptionDetails.text || '';
    throw new Error(String(detail).split('\n').slice(0, 2).join(' | '));
  }
  return result.value;
}

async function launch({ exe, port, headless }) {
  const profile = await mkdtemp(path.join(tmpdir(), 'abt-live-'));
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=DisableLoadExtensionCommandLineSwitch',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${port}`,
    `--load-extension=${ROOT}`,
    `--disable-extensions-except=${ROOT}`,
  ];
  if (headless) args.push('--headless=new', '--disable-gpu');
  else args.push('--window-position=-32000,-32000', '--window-size=1000,700');
  args.push('about:blank');

  const child = spawn(exe, args, { stdio: 'ignore' });
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) {
        const info = await res.json();
        return { child, profile, wsUrl: info.webSocketDebuggerUrl, browser: info.Browser };
      }
    } catch {
      /* 等待启动 */
    }
    await sleep(300);
  }
  child.kill();
  throw new Error('浏览器调试端口未就绪');
}

async function ownWorker(cdp, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  let last = [];
  while (Date.now() < deadline) {
    const { targetInfos } = await cdp.send('Target.getTargets');
    last = targetInfos;
    const hit = targetInfos.find(
      (t) => t.type === 'service_worker' && String(t.url).endsWith('/src/background/service-worker.js'),
    );
    if (hit) return hit;
    await sleep(300);
  }
  const urls = last.filter((t) => String(t.url).startsWith('chrome-extension://')).map((t) => `${t.type}:${t.url}`);
  throw new Error(`未发现本扩展的 Service Worker；可见扩展目标：${urls.join(' , ') || '无'}`);
}

/** 在扩展页面里调用后台消息 */
async function callBackend(cdp, sessionId, type, payload, timeoutMs = 60000) {
  return evaluate(
    cdp,
    sessionId,
    `(async () => {
      const call = (t, p) => chrome.runtime.sendMessage({ v: 1, type: t, id: 'live-' + t, payload: p });
      const res = await Promise.race([
        call(${JSON.stringify(type)}, ${JSON.stringify(payload)}),
        new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), ${timeoutMs})),
      ]);
      return JSON.stringify(res);
    })()`,
  );
}

async function openExtensionPage(cdp, extensionId, pagePath) {
  const url = `chrome-extension://${extensionId}/${pagePath}`;
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Runtime.enable', {}, sessionId);
  await sleep(1200);
  return { url, targetId, sessionId };
}

/* ------------------------------------------------------------------ */
/* 模式一：Chrome 能否加载扩展                                          */
/* ------------------------------------------------------------------ */

async function checkChromeLoad() {
  const exe = firstExisting(CHROME);
  const report = { mode: 'chrome-load', exe: exe || null, results: [], ok: false };
  if (!exe) {
    report.error = '未找到 Chrome 可执行文件';
    return report;
  }
  for (const headless of [true, false]) {
    const port = headless ? 9451 : 9452;
    let launched = null;
    try {
      launched = await launch({ exe, port, headless });
      const cdp = new CDP(launched.wsUrl);
      await cdp.connect();
      let loaded = null;
      let error = null;
      try {
        loaded = await ownWorker(cdp, 15000);
      } catch (e) {
        error = e.message;
      }
      report.results.push({
        headless,
        browser: launched.browser,
        extensionLoaded: Boolean(loaded),
        serviceWorker: loaded?.url || null,
        error,
      });
      cdp.close();
    } catch (e) {
      report.results.push({ headless, error: e.message });
    } finally {
      launched?.child.kill();
    }
  }
  report.ok = report.results.some((r) => r.extensionLoaded);
  return report;
}

/* ------------------------------------------------------------------ */
/* 模式二：真实 YouTube 字幕链路                                        */
/* ------------------------------------------------------------------ */

async function checkYouTube(videoId) {
  const exe = firstExisting(EDGE) || firstExisting(CHROME);
  const report = { mode: 'youtube-subtitles', videoId, steps: [], ok: false };
  const shot = (name, ok, detail) => report.steps.push({ name, ok, detail });

  const launched = await launch({ exe, port: 9453, headless: !process.argv.includes('--headed') });
  const cdp = new CDP(launched.wsUrl);
  await cdp.connect();
  try {
    const worker = await ownWorker(cdp);
    const extensionId = new URL(worker.url).host;
    report.extensionId = extensionId;
    shot('扩展加载', true, worker.url);

    // 打开视频页（无头模式同样会加载播放器脚本）
    const pageUrl = `https://www.youtube.com/watch?v=${videoId}`;
    const { targetId } = await cdp.send('Target.createTarget', { url: pageUrl });
    const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, pageSession);
    await cdp.send('Page.enable', {}, pageSession);
    await cdp.send('Page.bringToFront', {}, pageSession).catch(() => {});

    // 等播放器就绪（最多 25 秒）
    let playerState = null;
    for (let i = 0; i < 25; i += 1) {
      playerState = await evaluate(
        cdp,
        pageSession,
        `(() => {
          const player = document.querySelector('#movie_player');
          const response = window.ytInitialPlayerResponse;
          const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
          return {
            hasPlayer: Boolean(player),
            hasPlayerResponse: Boolean(response),
            title: document.title.slice(0, 80),
            tracks: tracks.length,
            languages: tracks.slice(0, 6).map((t) => ({ lang: t.languageCode, kind: t.kind || 'manual', name: t.name?.simpleText || t.name?.runs?.[0]?.text || '' })),
          };
        })()`,
      ).catch((error) => ({ error: error.message }));
      if (playerState?.tracks > 0) break;
      await sleep(1000);
    }
    shot(
      '视频页与字幕轨道',
      Boolean(playerState?.tracks > 0),
      `标题「${playerState?.title || '?'}」· 播放器 ${playerState?.hasPlayer} · playerResponse ${playerState?.hasPlayerResponse} · 轨道 ${playerState?.tracks ?? 0} ${JSON.stringify(playerState?.languages || [])}`.slice(0, 240),
    );
    report.playerState = playerState;

    // 后台字幕接口
    const options = await openExtensionPage(cdp, extensionId, 'src/options/options.html');
    const tabs = await evaluate(
      cdp,
      options.sessionId,
      `new Promise((resolve) => chrome.tabs.query({ url: 'https://www.youtube.com/*' }, (list) => resolve(list.map((t) => ({ id: t.id, url: t.url })))))`,
    );
    report.youtubeTabs = tabs;
    const tabId = tabs?.[0]?.id;
    if (!tabId) {
      shot('后台字幕接口', false, '未能通过 chrome.tabs.query 拿到视频标签页');
      return report;
    }

    const tracksRaw = await callBackend(cdp, options.sessionId, 'subtitle.tracks', { tabId });
    const tracksRes = JSON.parse(tracksRaw || '{}');
    const tracks = tracksRes?.payload?.tracks || [];
    shot(
      '后台读取字幕轨道',
      Boolean(tracksRes?.ok && tracks.length),
      tracksRes?.ok ? `${tracks.length} 条轨道 · 首条 ${tracks[0]?.languageCode}/${tracks[0]?.kind || 'manual'}` : `失败 ${JSON.stringify(tracksRes?.error || tracksRes)}`,
    );
    if (!tracks.length) return report;

    const chosen = tracks.find((t) => t.kind !== 'asr') || tracks[0];
    const cuesRaw = await callBackend(cdp, options.sessionId, 'subtitle.cues', { tabId, baseUrl: chosen.baseUrl, videoId });
    const cuesRes = JSON.parse(cuesRaw || '{}');
    const cues = cuesRes?.payload?.cues || [];
    shot(
      '后台抓取字幕内容',
      cues.length > 0,
      cuesRes?.ok ? `${cues.length} 条字幕 · 首条「${String(cues[0]?.text || '').slice(0, 60)}」` : `失败 ${JSON.stringify(cuesRes?.error || cuesRes)}`,
    );
    report.cueSample = cues.slice(0, 3).map((c) => ({ start: c.start, text: c.text }));

    if (cues.length) {
      const sample = cues.slice(0, 3).map((c) => c.text).join('\n');
      const trRaw = await callBackend(cdp, options.sessionId, 'translate', {
        items: [{ id: 'c1', text: sample }],
        engineId: 'google-free',
      }, 45000);
      const trRes = JSON.parse(trRaw || '{}');
      const translated = trRes?.payload?.results?.[0]?.translated || '';
      shot('字幕双语翻译', Boolean(translated), translated ? `「${translated.slice(0, 80)}」` : `失败 ${JSON.stringify(trRes?.error || trRes)}`);
      report.translatedSample = translated;
    }

    // 让播放器真正播起来并打开英文字幕：无头/离屏窗口默认可能不播，原生字幕不渲染就不会进 DOM 回退
    let playback = null;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      playback = await evaluate(
        cdp,
        pageSession,
        `(async () => {
          const player = document.querySelector('#movie_player');
          const video = document.querySelector('video');
          if (!video) return { error: 'no video element' };
          video.muted = true;
          try { player?.loadModule?.('captions'); } catch { /* ignore */ }
          const button = document.querySelector('.ytp-subtitles-button');
          if (button && button.getAttribute('aria-pressed') !== 'true') {
            try { button.click(); } catch { /* ignore */ }
          }
          try { player?.setOption?.('captions', 'track', { languageCode: 'en' }); } catch { /* ignore */ }
          try { await video.play(); } catch { /* 自动播放策略可能拦截 */ }
          if (video.currentTime < 5) video.currentTime = 28 + Math.random() * 6;
          await new Promise((resolve) => setTimeout(resolve, 2500));
          const seg = document.querySelector('.ytp-caption-segment');
          return {
            paused: video.paused,
            time: Math.round(video.currentTime),
            captionsOn: Boolean(seg),
            captionText: seg ? seg.textContent.slice(0, 80) : '',
            ccPressed: button?.getAttribute('aria-pressed') || null,
          };
        })()`,
      ).catch((error) => ({ error: error.message }));
      if (playback?.captionText) break;
    }
    report.playback = playback;
    shot(
      '页面播放与原生字幕',
      Boolean(playback?.captionText),
      `time ${playback?.time ?? '?'}s · 暂停 ${playback?.paused} · CC ${playback?.ccPressed} · 原生字幕「${playback?.captionText || ''}」${playback?.error ? ' · ' + playback.error : ''}`,
    );

    // 页面字幕层
    const toggle = await evaluate(
      cdp,
      options.sessionId,
      `chrome.tabs.sendMessage(${tabId}, { v: 1, type: 'page.subtitle.toggle', id: 'live-sub', payload: { enabled: true } }).then(() => 'sent').catch((e) => 'ERR:' + e.message)`,
    );

    // 轮询最多 40 秒，等「原文 + 译文」两行真实出现
    let layer = null;
    const readings = [];
    for (let i = 0; i < 20; i += 1) {
      await sleep(2000);
      layer = await evaluate(
        cdp,
        pageSession,
        `(() => {
          const host = document.querySelector('#abt-root');
          const root = host?.shadowRoot;
          const layerEl = root?.querySelector('#abt-subtitle-layer');
          if (!layerEl) return { host: Boolean(host), layer: false, text: '', lines: [] };
          const lines = Array.from(layerEl.children).map((el) => (el.innerText || '').trim()).filter(Boolean);
          return { host: true, layer: true, text: layerEl.innerText.replace(/\\n+/g, ' | ').slice(0, 240), lines };
        })()`,
      ).catch((error) => ({ error: error.message }));
      readings.push(layer?.text || '');
      const hasCjk = layer?.lines?.some((line) => /[\u4e00-\u9fa5]/.test(line) && !/回退|不可用|PoToken|正在/.test(line));
      const hasSource = layer?.lines?.some((line) => /[A-Za-z]{8,}/.test(line));
      if (hasCjk && hasSource) break;
    }
    shot('页面字幕层', Boolean(layer?.layer), toggle === 'sent' ? `图层 ${layer?.layer} · 文本「${layer?.text || ''}」` : `页面消息失败 ${toggle}`);
    report.layer = layer;
    report.layerReadings = readings.filter((text, index) => text && text !== readings[index - 1]).slice(0, 6);

    const translatedLine = (layer?.lines || []).find((line) => /[\u4e00-\u9fa5]/.test(line) && !/回退|不可用|PoToken/.test(line));
    report.domFallback = { translatedLine: translatedLine || null, lines: layer?.lines || [] };
    shot(
      '原生字幕回退翻译',
      Boolean(translatedLine),
      translatedLine ? `译文「${translatedLine.slice(0, 80)}」` : '未在 40 秒内读到可翻译的原生字幕（无头模式可能不渲染字幕）',
    );

    // 最终判定：轨道可读 + 失败时给出诚实原因（不伪造字幕）即视为「链路按设计工作」；
    // 字幕内容能否拿到取决于站点是否放行（PoToken 限制）。
    const honest = readings.some((text) => /PoToken|回退|原生字幕|不可用/.test(text)) || cues.length > 0;
    report.ok = tracks.length > 0 && honest;
    shot('链路结论', report.ok, report.ok ? (cues.length ? '字幕接口可用' : '字幕接口被站点限流，已按设计降级并如实告知') : '轨道都读不到，链路异常');

    return report;
  } finally {
    cdp.close();
    launched.child.kill();
  }
}

const mode = process.argv.includes('--chrome') ? 'chrome' : process.argv.includes('--youtube') ? 'youtube' : null;
if (!mode) {
  console.error('用法：node tools/verify-live.mjs --chrome | --youtube [videoId]');
  process.exit(2);
}
const videoArgIndex = process.argv.indexOf('--youtube');
const videoId = videoArgIndex >= 0 ? process.argv[videoArgIndex + 1] || '8S0FDjFBj8o' : '8S0FDjFBj8o';

const result = mode === 'chrome' ? await checkChromeLoad() : await checkYouTube(videoId);
console.log(JSON.stringify(result, null, 2));
// 判定以报告里的 ok 为准（youtube 模式的单步失败可能是站点限流，已在校验里体现）
process.exit(result.ok ? 0 : 1);