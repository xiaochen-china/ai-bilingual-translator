/**
 * 内容脚本公共层（经典脚本，非 ES Module）。
 *
 * 由于内容脚本不能用 import，这里只放「与后台通信 + DOM 基础设施 + 文本工具」，
 * 所有对外能力挂到 window.__ABT__ 命名空间，供 page-translator / selection / subtitles / main 复用。
 *
 * 协议常量必须与 src/common/constants.js 保持一致（见该文件头部说明）。
 */

(function installCore() {
  'use strict';

  const NS = (window.__ABT__ = window.__ABT__ || {});
  if (NS.__coreInstalled) return;
  NS.__coreInstalled = true;

  NS.PROTOCOL_VERSION = 1;

  NS.MESSAGE = Object.freeze({
    TRANSLATE: 'translate',
    SETTINGS_GET: 'settings.get',
    WORD_LOOKUP: 'word.lookup',
    WORDBOOK_ADD: 'wordbook.add',
    SITE_RULE_SET: 'site.rule.set',
    SUBTITLE_TRACKS: 'subtitle.tracks',
    SUBTITLE_CUES: 'subtitle.cues',
    PAGE_TRANSLATE: 'page.translate',
    PAGE_RESTORE: 'page.restore',
    PAGE_SET_MODE: 'page.setMode',
    PAGE_STATE: 'page.state',
  });

  NS.MODES = Object.freeze({
    BILINGUAL: 'bilingual',
    ZH_ONLY: 'zh',
    HOVER: 'hover',
    OFF: 'off',
  });

  NS.DOM = Object.freeze({
    ROOT_ID: 'abt-root',
    STYLE_ID: 'abt-page-style',
    ATTR_BLOCK: 'data-abt-block',
    ATTR_TRANS: 'data-abt-trans',
    ATTR_ORIG: 'data-abt-orig',
    ATTR_UI: 'data-abt-ui',
    ATTR_SKIP: 'data-abt-skip',
    CLASS_TRANS: 'abt-trans',
    CLASS_INLINE_CODE: 'abt-inline-code',
  });

  NS.debug = false;
  NS.log = (...args) => {
    if (NS.debug) console.log('[ABT]', ...args);
  };

  NS.settings = null;

  /* ---------------------------------------------------------------- */
  /* 与后台通信                                                        */
  /* ---------------------------------------------------------------- */

  NS.send = function send(type, payload = {}, { timeoutMs = 45000 } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        reject(Object.assign(new Error('扩展后台响应超时'), { code: 'TIMEOUT' }));
      }, timeoutMs);

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn(value);
      };

      try {
        chrome.runtime.sendMessage(
          {
            v: NS.PROTOCOL_VERSION,
            type,
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            payload,
          },
          (response) => {
            const lastError = chrome.runtime.lastError;
            if (lastError) {
              finish(reject, Object.assign(new Error(lastError.message || '扩展后台不可用'), { code: 'CONTEXT_LOST' }));
              return;
            }
            if (!response) {
              finish(reject, Object.assign(new Error('扩展后台没有响应'), { code: 'NO_RESPONSE' }));
              return;
            }
            if (response.ok) {
              finish(resolve, response.payload || {});
            } else {
              const error = new Error(response.error?.message || '请求失败');
              error.code = response.error?.code || 'UNKNOWN';
              error.details = response.error?.details || {};
              finish(reject, error);
            }
          },
        );
      } catch (error) {
        finish(
          reject,
          Object.assign(new Error('扩展上下文已失效，请刷新页面后重试'), { code: 'CONTEXT_LOST', cause: error }),
        );
      }
    });
  };

  /** 拉取设置（带本地缓存） */
  NS.fetchSettings = async function fetchSettings(force = false) {
    if (NS.settings && !force) return NS.settings;
    const result = await NS.send(NS.MESSAGE.SETTINGS_GET, {}, { timeoutMs: 8000 });
    NS.settings = result.settings;
    NS.keyStatus = result.keyStatus || {};
    return NS.settings;
  };

  /* ---------------------------------------------------------------- */
  /* Shadow DOM 宿主：所有自绘 UI 都放在这里，避免被站点样式污染        */
  /* ---------------------------------------------------------------- */

  NS.shadowHost = function shadowHost() {
    let host = document.getElementById(NS.DOM.ROOT_ID);
    if (host && host.shadowRoot) return host;
    host = document.createElement('div');
    host.id = NS.DOM.ROOT_ID;
    host.setAttribute(NS.DOM.ATTR_UI, '');
    host.style.setProperty('all', 'initial');
    host.style.setProperty('position', 'fixed');
    host.style.setProperty('left', '0');
    host.style.setProperty('top', '0');
    host.style.setProperty('width', '0');
    host.style.setProperty('height', '0');
    host.style.setProperty('z-index', '2147483647');
    host.style.setProperty('pointer-events', 'none');
    const shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `<style>
      :host { all: initial; }
      * { box-sizing: border-box; }
      .abt-btn { font: 500 12px/1.2 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
    </style>`;
    (document.body || document.documentElement).appendChild(host);
    return host;
  };

  NS.shadowRoot = function shadowRoot() {
    return NS.shadowHost().shadowRoot;
  };

  /* ---------------------------------------------------------------- */
  /* 页面级样式（译文、模式切换）                                       */
  /* ---------------------------------------------------------------- */

  NS.injectPageStyles = function injectPageStyles(settings) {
    const style = settings || NS.settings || {};
    const st = style.style || {};
    const dark = NS.prefersDark();
    const color = dark ? st.darkColor || '#8ab4f8' : st.color || '#1a73e8';
    const css = `
:root { --abt-color: ${color}; --abt-scale: ${Number(st.fontScale) || 1}; --abt-weight: ${Number(st.fontWeight) || 400}; --abt-lh: ${Number(st.lineHeight) || 1.5}; --abt-gap: ${Number(st.paragraphGap ?? 4)}px; --abt-margin: ${Number(st.marginBottom ?? 6)}px; }
html[data-abt-mode="zh"] [data-abt-orig] { display: none !important; }
html[data-abt-mode="hover"] span.${NS.DOM.CLASS_TRANS} { display: none !important; }
html[data-abt-mode="hover"] [${NS.DOM.ATTR_BLOCK}]:hover span.${NS.DOM.CLASS_TRANS} { display: block !important; }
span.${NS.DOM.CLASS_TRANS} {
  display: block !important;
  margin: var(--abt-gap) 0 var(--abt-margin) 0 !important;
  padding: 0 !important;
  color: var(--abt-color) !important;
  font-size: calc(1em * var(--abt-scale)) !important;
  font-weight: var(--abt-weight) !important;
  line-height: var(--abt-lh) !important;
  letter-spacing: normal !important;
  text-align: inherit !important;
  font-family: inherit !important;
  white-space: normal !important;
  word-break: break-word !important;
  border: 0 !important;
  background: none !important;
  text-indent: 0 !important;
  direction: inherit !important;
}
span.${NS.DOM.CLASS_TRANS}[data-abt-pending] { opacity: 0.45 !important; }
span.${NS.DOM.CLASS_TRANS}[data-abt-error] { color: #d93025 !important; font-style: italic !important; }
span.${NS.DOM.CLASS_TRANS} .${NS.DOM.CLASS_INLINE_CODE} {
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace !important;
  font-size: 0.92em !important;
  background: rgba(127, 127, 127, 0.16) !important;
  border-radius: 3px !important;
  padding: 0 3px !important;
}
${st.showDivider ? `span.${NS.DOM.CLASS_TRANS} { border-left: 2px solid var(--abt-color) !important; padding-left: 8px !important; }` : ''}
`;
    let el = document.getElementById(NS.DOM.STYLE_ID);
    if (!el) {
      el = document.createElement('style');
      el.id = NS.DOM.STYLE_ID;
      el.setAttribute(NS.DOM.ATTR_UI, '');
      (document.head || document.documentElement).appendChild(el);
    }
    el.textContent = css;
    document.documentElement.setAttribute('data-abt-theme', NS.prefersDark() ? 'dark' : 'light');
  };

  NS.applyMode = function applyMode(mode) {
    document.documentElement.setAttribute('data-abt-mode', mode || NS.MODES.BILINGUAL);
  };

  NS.removePageStyles = function removePageStyles() {
    document.getElementById(NS.DOM.STYLE_ID)?.remove();
    document.documentElement.removeAttribute('data-abt-mode');
    document.documentElement.removeAttribute('data-abt-theme');
  };

  /* ---------------------------------------------------------------- */
  /* 提示条                                                            */
  /* ---------------------------------------------------------------- */

  let toastTimer = null;

  NS.toast = function toast(message, { type = 'info', duration = 2800 } = {}) {
    try {
      const root = NS.shadowRoot();
      let box = root.getElementById?.('abt-toast') || root.querySelector('#abt-toast');
      if (!box) {
        box = document.createElement('div');
        box.id = 'abt-toast';
        box.style.cssText = [
          'position: fixed',
          'left: 50%',
          'bottom: 36px',
          'transform: translateX(-50%)',
          'max-width: 460px',
          'padding: 10px 16px',
          'border-radius: 8px',
          'background: rgba(32,33,36,.94)',
          'color: #fff',
          'font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          'box-shadow: 0 6px 24px rgba(0,0,0,.28)',
          'pointer-events: none',
          'opacity: 0',
          'transition: opacity .18s ease',
          'z-index: 2147483647',
          'white-space: pre-wrap',
        ].join(';');
        root.appendChild(box);
      }
      box.textContent = message;
      box.style.background =
        type === 'error' ? 'rgba(176,32,32,.96)' : type === 'success' ? 'rgba(24,110,60,.96)' : 'rgba(32,33,36,.94)';
      box.style.opacity = '1';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => {
        box.style.opacity = '0';
      }, duration);
    } catch {
      // 极端情况下（document 不可用）放弃提示
    }
  };

  /* ---------------------------------------------------------------- */
  /* 文本与页面工具                                                    */
  /* ---------------------------------------------------------------- */

  NS.normalizeText = function normalizeText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[\s\u3000]+/g, ' ')
      .trim();
  };

  NS.CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;

  NS.containsCJK = (text) => NS.CJK_RE.test(String(text || ''));

  /** 判断文本是否「基本就是中文」，避免重复翻译 */
  NS.isMostlyCJK = function isMostlyCJK(text) {
    const value = String(text || '');
    if (!value) return false;
    const cjk = (value.match(/[\u3400-\u4dbf\u4e00-\u9fff]/g) || []).length;
    const latin = (value.match(/[A-Za-z]/g) || []).length;
    return cjk > 0 && cjk >= latin * 2;
  };

  /** 是否包含可翻译的字母（纯数字、纯符号不送翻译） */
  NS.hasLetters = (text) => /[A-Za-z\u00c0-\u024f]/.test(String(text || ''));

  NS.isEditable = function isEditable(node) {
    const el = node?.nodeType === 1 ? node : node?.parentElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || tag === 'OPTION';
  };

  NS.isVisible = function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    if (el.getClientRects().length === 0) return false;
    return true;
  };

  NS.prefersDark = function prefersDark() {
    try {
      return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    } catch {
      return false;
    }
  };

  NS.debounce = function debounce(fn, wait = 120) {
    let timer = null;
    const wrapped = (...args) => {
      clearTimeout(timer);
      timer = setTimeout(() => fn(...args), wait);
    };
    wrapped.cancel = () => clearTimeout(timer);
    return wrapped;
  };

  /** 把译文中的代码片段、URL 用等宽字体标出来（只用 DOM API，杜绝 innerHTML 注入） */
  NS.buildTranslationFragment = function buildTranslationFragment(text, { inlineCode = true } = {}) {
    const fragment = document.createDocumentFragment();
    const source = String(text || '');
    if (!inlineCode) {
      fragment.appendChild(document.createTextNode(source));
      return fragment;
    }
    const re = /(`[^`]{1,80}`)|(https?:\/\/[^\s"'<>）)]+)|(\b[\w.-]+\/[\w./-]{1,120}\b)/g;
    let lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      if (match.index > lastIndex) {
        fragment.appendChild(document.createTextNode(source.slice(lastIndex, match.index)));
      }
      const code = document.createElement('span');
      code.className = NS.DOM.CLASS_INLINE_CODE;
      code.textContent = match[0].replace(/^`|`$/g, '');
      fragment.appendChild(code);
      lastIndex = re.lastIndex;
    }
    if (lastIndex < source.length) fragment.appendChild(document.createTextNode(source.slice(lastIndex)));
    return fragment;
  };

  /** 判断站点规则是否允许自动翻译 */
  NS.resolveAutoAction = function resolveAutoAction(settings, hostname) {
    const rule = settings?.siteRules?.[hostname];
    if (rule === 'never') return 'never';
    if (rule === 'auto') return 'auto';
    if (rule === 'ask') return 'ask';
    return settings?.autoTranslate ? 'auto' : 'manual';
  };

  /** 当前页面是否是我们应当跳过的特殊页面 */
  NS.isSkippedPage = function isSkippedPage() {
    const url = location.href;
    if (!/^https?:/i.test(url)) return true;
    if (/\.(pdf|xml|json|txt|zip|rar|7z|mp4|mp3|jpg|jpeg|png|gif|webp|svg)(\?|#|$)/i.test(url)) return true;
    if (document.contentType && !/^text\/html/i.test(document.contentType)) return true;
    return false;
  };
})();