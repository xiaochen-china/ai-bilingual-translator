/**
 * 内容脚本装配入口。
 *
 * 负责：读取设置 → 初始化划词 → 按站点规则决定是否自动翻译 → 响应弹窗/快捷键指令。
 * 所有功能都通过 window.__ABT__ 暴露的子模块完成，这里只做编排与容错。
 */

(function bootstrap() {
  'use strict';

  const NS = window.__ABT__;
  if (!NS) return;
  if (window.top !== window) return; // 只在顶层文档运行，避免 iframe 重复弹窗
  if (NS.__bootstrapped) return; // 内容脚本被重复注入时（弹窗补注入）只装配一次
  NS.__bootstrapped = true;

  const { MODES } = NS;
  let bootstrapped = false;

  /* ------------------------------------------------------------------ */
  /* 询问条（站点规则为 ask 时显示）                                      */
  /* ------------------------------------------------------------------ */

  function showAskBar(hostname) {
    const root = NS.shadowRoot();
    root.querySelector?.('#abt-ask')?.remove();
    const bar = document.createElement('div');
    bar.id = 'abt-ask';
    bar.setAttribute(NS.DOM.ATTR_UI, '');
    bar.style.cssText = [
      'position: fixed',
      'top: 16px',
      'left: 50%',
      'transform: translateX(-50%)',
      'display: flex',
      'align-items: center',
      'gap: 10px',
      'padding: 10px 14px',
      'border-radius: 10px',
      'background: #1f2328',
      'color: #fff',
      'font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      'box-shadow: 0 8px 28px rgba(0,0,0,.28)',
      'pointer-events: auto',
      'z-index: 2147483647',
    ].join(';');

    const text = document.createElement('span');
    text.textContent = `要翻译 ${hostname} 上的英文内容吗？`;

    const makeButton = (label, primary, onClick) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.style.cssText = [
        'appearance: none',
        'border: 1px solid ' + (primary ? '#8ab4f8' : 'rgba(255,255,255,.28)'),
        'background: ' + (primary ? '#8ab4f8' : 'transparent'),
        'color: ' + (primary ? '#062e6f' : '#fff'),
        'border-radius: 6px',
        'padding: 4px 10px',
        'font: 500 12px/1.4 inherit',
        'cursor: pointer',
      ].join(';');
      button.addEventListener('click', async () => {
        bar.remove();
        await onClick();
      });
      return button;
    };

    bar.append(
      text,
      makeButton('翻译本页', true, () => NS.PageTranslator.start()),
      makeButton('本网站不再询问', false, () => {
        NS.send(NS.MESSAGE.SITE_RULE_SET, { hostname, rule: 'never' }).catch(() => {});
      }),
      makeButton('暂不', false, async () => {
        // 本次会话内不再询问：用 sessionStorage 记录，刷新后仍会询问
        try {
          sessionStorage.setItem('abt:ask-dismissed', hostname);
        } catch {
          // ignore
        }
      }),
    );
    root.appendChild(bar);
    setTimeout(() => bar.remove(), 20000);
  }

  /* ------------------------------------------------------------------ */
  /* 消息处理                                                            */
  /* ------------------------------------------------------------------ */

  async function handleContentMessage(message) {
    const type = message?.type;
    const payload = message?.payload || {};
    switch (type) {
      case NS.MESSAGE.PAGE_TRANSLATE:
        return NS.PageTranslator.start({ mode: payload.mode });
      case NS.MESSAGE.PAGE_RESTORE:
        return NS.PageTranslator.restore();
      case NS.MESSAGE.PAGE_SET_MODE: {
        const mode = payload.cycle ? NS.PageTranslator.nextMode() : payload.mode;
        return NS.PageTranslator.setMode(mode);
      }
      case 'page.subtitle.toggle':
        return NS.Subtitles.toggle();
      case NS.MESSAGE.PAGE_LOOKUP_SELECTION:
        NS.onLookupShortcut?.(payload.text);
        return { ok: true };
      case NS.MESSAGE.PAGE_STATE:
        return {
          page: NS.PageTranslator.getState(),
          subtitles: NS.Subtitles.getState(),
          hostname: location.hostname,
          supportedSite: NS.Subtitles.supportedSite(),
        };
      case 'settings.changed': {
        NS.settings = payload.settings || NS.settings;
        const page = NS.PageTranslator.getState();
        if (page.active) {
          NS.injectPageStyles(NS.settings);
          if (NS.settings.mode && NS.settings.mode !== page.mode) {
            NS.PageTranslator.setMode(NS.settings.mode);
          }
        }
        return { ok: true };
      }
      default:
        return { ok: false, reason: 'UNKNOWN_TYPE' };
    }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    // 只处理内容脚本相关的指令
    if (!message || typeof message.type !== 'string') return false;
    if (!/^page\./.test(message.type) && message.type !== 'settings.changed') return false;
    handleContentMessage(message)
      .then((result) => sendResponse({ v: 1, ok: true, payload: result }))
      .catch((error) => sendResponse({ v: 1, ok: false, error: { code: error.code || 'UNKNOWN', message: error.message } }));
    return true;
  });

  /* ------------------------------------------------------------------ */
  /* 初始化                                                              */
  /* ------------------------------------------------------------------ */

  async function init() {
    if (bootstrapped) return;
    bootstrapped = true;
    if (NS.isSkippedPage()) return;

    let settings;
    try {
      settings = await NS.fetchSettings();
    } catch (error) {
      NS.log('读取设置失败', error);
      return;
    }

    NS.injectPageStyles(settings);
    NS.applyMode(settings.mode || MODES.BILINGUAL);
    NS.Selection.init();

    const hostname = location.hostname;
    const action = NS.resolveAutoAction(settings, hostname);
    if (!settings.enabled) return;

    if (action === 'auto') {
      NS.PageTranslator.start({ mode: settings.mode }).catch((error) => {
        NS.log('自动翻译失败', error);
      });
    } else if (action === 'ask') {
      let dismissed = null;
      try {
        dismissed = sessionStorage.getItem('abt:ask-dismissed');
      } catch {
        dismissed = null;
      }
      if (dismissed !== hostname) showAskBar(hostname);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();