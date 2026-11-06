/**
 * YouTube 字幕桥接（在 Service Worker 中运行）。
 *
 * 获取策略（与需求文档一致）：
 *  1. 通过 chrome.scripting 在页面主世界读取播放器字幕轨道列表（captionTracks）。
 *  2. 用轨道 baseUrl 拉取 timedtext（fmt=json3），解析出带时间戳的字幕。
 *  3. 任一环节失败（受限 / 无字幕 / PoToken 等）时返回明确的失败原因，
 *     由内容脚本回退到 DOM 字幕面板，或直接提示用户「字幕不可用」。
 *
 * 注意：这里不会绕过任何访问限制，也不会伪造字幕。
 */

import { AppError, ERROR_CODES } from '../common/protocol.js';
import { httpFetch } from './engines/http.js';

/** 在主世界中读取 ytInitialPlayerResponse 里的字幕轨道 */
const READ_TRACKS_SCRIPT = () => {
  try {
    const pick = (obj) => obj?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    let tracks = null;
    let videoId = '';
    const player = document.getElementById('movie_player');
    let response = null;
    if (player && typeof player.getPlayerResponse === 'function') {
      response = player.getPlayerResponse();
    }
    if (!response && typeof window.ytInitialPlayerResponse === 'object') {
      response = window.ytInitialPlayerResponse;
    }
    tracks = pick(response);
    videoId = response?.videoDetails?.videoId || '';
    if (!Array.isArray(tracks) || tracks.length === 0) {
      return { ok: false, reason: 'NO_TRACKS', videoId };
    }
    return {
      ok: true,
      videoId,
      tracks: tracks.map((track) => ({
        baseUrl: track.baseUrl || '',
        languageCode: track.languageCode || '',
        kind: track.kind || '',
        name: track.name?.simpleText || track.name?.runs?.[0]?.text || track.languageCode || '',
        isTranslatable: Boolean(track.isTranslatable),
        vssId: track.vssId || '',
      })),
    };
  } catch (error) {
    return { ok: false, reason: 'EXCEPTION', message: String(error?.message || error) };
  }
};

/**
 * 读取某个标签页的字幕轨道。
 * @param {number} tabId
 */
export async function readCaptionTracks(tabId) {
  if (!Number.isInteger(tabId)) {
    throw new AppError(ERROR_CODES.INVALID_REQUEST, '缺少标签页 ID。');
  }
  let injection;
  try {
    injection = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: READ_TRACKS_SCRIPT,
    });
  } catch (error) {
    return { ok: false, reason: 'INJECT_FAILED', message: String(error?.message || error) };
  }
  const result = injection?.[0]?.result;
  if (!result) return { ok: false, reason: 'NO_RESULT' };
  return result;
}

/**
 * 挑选最佳轨道：优先人工 CC（kind 为空或非 asr），其次英文，最后第一条。
 */
export function pickTrack(tracks) {
  if (!Array.isArray(tracks) || tracks.length === 0) return null;
  const manual = tracks.filter((track) => track.kind !== 'asr');
  const english = manual.filter((track) => /^en/i.test(track.languageCode));
  if (english.length) return english[0];
  if (manual.length) return manual[0];
  const asrEnglish = tracks.filter((track) => /^en/i.test(track.languageCode));
  if (asrEnglish.length) return asrEnglish[0];
  return tracks[0];
}

/** 解析 timedtext 的 json3 格式 */
export function parseJson3(payload) {
  const events = Array.isArray(payload?.events) ? payload.events : [];
  const cues = [];
  for (const event of events) {
    if (!Array.isArray(event?.segs)) continue;
    const text = event.segs
      .map((seg) => seg?.utf8 || '')
      .join('')
      .replace(/\n+/g, ' ')
      .trim();
    if (!text) continue;
    const start = Number(event.tStartMs || 0) / 1000;
    const duration = Number(event.dDurationMs || 0) / 1000;
    cues.push({ start, duration, end: start + duration, text });
  }
  return cues;
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/<[^>]+>/g, '');
}

/** 解析 timedtext 的 XML 格式（json3 不可用时的兜底） */
export function parseTimedTextXml(xml) {
  const cues = [];
  // 先抓 <text ...>内容</text>，再从属性串里分别取 start / dur，
  // 避免单个正则把 dur 当成可选组而漏匹配。
  const re = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  let match;
  while ((match = re.exec(String(xml))) !== null) {
    const attrs = match[1] || '';
    const start = Number((attrs.match(/\bstart="([\d.]+)"/i) || [])[1]) || 0;
    const duration = Number((attrs.match(/\bdur="([\d.]+)"/i) || [])[1]) || 0;
    const text = decodeEntities(match[2]).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    cues.push({ start, duration, end: start + duration, text });
  }
  return cues;
}

/** 自动识别响应体格式并解析 */
export function parseTimedTextBody(body) {
  const raw = String(body || '').trim();
  if (!raw) return [];
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try {
      return parseJson3(JSON.parse(raw));
    } catch {
      return [];
    }
  }
  return parseTimedTextXml(raw);
}

/**
 * 拉取字幕内容。
 * @param {string} baseUrl 轨道 baseUrl
 * @param {{signal?: AbortSignal, timeoutMs?: number}} options
 */
export async function fetchCues(baseUrl, { signal, timeoutMs = 15000 } = {}) {
  if (!baseUrl) return { ok: false, reason: 'NO_URL' };
  let url;
  try {
    url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) return { ok: false, reason: 'BAD_URL' };
    url.searchParams.set('fmt', 'json3');
  } catch {
    return { ok: false, reason: 'BAD_URL' };
  }

  let response;
  try {
    response = await httpFetch(url.toString(), { method: 'GET', credentials: 'include' }, { timeoutMs, signal });
  } catch (error) {
    return { ok: false, reason: 'NETWORK', message: error?.message || String(error) };
  }
  if (!response.ok) {
    return { ok: false, reason: 'HTTP', status: response.status };
  }
  const body = await response.text();
  const cues = parseTimedTextBody(body);
  if (!cues.length) return { ok: false, reason: 'EMPTY' };
  return { ok: true, cues };
}

/**
 * 一次完整的字幕获取尝试：读轨道 → 选轨道 → 拉取内容。
 * 限次调用，绝不无限重试。
 */
export async function loadSubtitles(tabId, { signal, preferLanguage = 'en' } = {}) {
  const tracksResult = await readCaptionTracks(tabId);
  if (!tracksResult?.ok) {
    return { ok: false, stage: 'tracks', reason: tracksResult?.reason || 'NO_TRACKS', message: tracksResult?.message, tracks: [] };
  }
  const tracks = tracksResult.tracks || [];
  const track = pickTrack(
    preferLanguage ? tracks.filter((item) => item.kind !== 'asr' || !tracks.some((t) => t.kind !== 'asr')) : tracks,
  );
  if (!track) return { ok: false, stage: 'tracks', reason: 'NO_TRACKS', tracks };

  const cuesResult = await fetchCues(track.baseUrl, { signal });
  if (!cuesResult.ok) {
    return {
      ok: false,
      stage: 'cues',
      reason: cuesResult.reason,
      status: cuesResult.status,
      tracks,
      track,
      videoId: tracksResult.videoId,
    };
  }
  return {
    ok: true,
    videoId: tracksResult.videoId,
    track,
    tracks,
    cues: cuesResult.cues,
  };
}