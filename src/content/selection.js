/**
 * 划词翻译（V1.1）。
 *
 * 选中英文单词 / 句子后，在选区附近弹出一个轻量面板：
 *  - 译文（默认引擎）
 *  - 词性 / 释义 / 例句（使用 AI 引擎时才有，其他引擎会明确提示）
 *  - 「加入生词本」「复制」「朗读」「关闭」
 *
 * 所有 UI 都在 Shadow DOM 内，样式与站点完全隔离。
 */

(function installSelection() {
  'use strict';

  const NS = window.__ABT__;
  if (!NS || NS.__selectionInstalled) return;
  NS.__selectionInstalled = true;

  const PANEL_ID = 'abt-lookup';

  let panel = null;
  let panelState = null;
  let hideTimer = null;
  let requestSeq = 0;
  let lastSelectionText = '';

  function settingsOf() {
    return NS.settings || {};
  }

  function lookupEnabled() {
    return settingsOf().lookup?.enabled !== false;
  }

  /* ------------------------------------------------------------------ */
  /* 面板                                                                */
  /* ------------------------------------------------------------------ */

  function ensurePanel() {
    if (panel && panel.isConnected) return panel;
    const root = NS.shadowRoot();
    root.querySelector?.('#' + PANEL_ID)?.remove();

    panel = document.createElement('div');
    panel.id = PANEL_ID;
    panel.style.cssText = [
      'position: fixed',
      'z-index: 2147483647',
      'width: 340px',
      'max-width: calc(100vw - 24px)',
      'max-height: 60vh',
      'overflow: auto',
      'padding: 12px 14px',
      'border-radius: 10px',
      'background: #ffffff',
      'color: #1f2328',
      'border: 1px solid rgba(0,0,0,.10)',
      'box-shadow: 0 10px 34px rgba(0,0,0,.20)',
      'font: 13px/1.6 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
      'pointer-events: auto',
      'visibility: hidden',
      'transition: opacity .12s ease',
      'opacity: 0',
    ].join(';');
    panel.setAttribute(NS.DOM.ATTR_UI, '');
    panel.addEventListener('mousedown', (event) => event.stopPropagation());
    root.appendChild(panel);
    return panel;
  }

  function el(tag, style, text) {
    const node = document.createElement(tag);
    if (style) node.style.cssText = style;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function clearPanel() {
    if (panel) panel.textContent = '';
  }

  function showMessage(message, { error = false } = {}) {
    const box = ensurePanel();
    clearPanel();
    box.appendChild(
      el(
        'div',
        `color:${error ? '#b3261e' : '#5f6368'};font-size:12.5px;white-space:pre-wrap;`,
        message,
      ),
    );
    positionPanel();
  }

  function row(label, value) {
    const line = el('div', 'display:flex;gap:8px;margin-top:4px;');
    const tag = el(
      'span',
      'flex:0 0 auto;color:#80868b;font-size:11px;line-height:20px;min-width:34px;',
      label,
    );
    const content = el('span', 'flex:1 1 auto;word-break:break-word;', value);
    line.append(tag, content);
    return line;
  }

  function renderResult(result) {
    const box = ensurePanel();
    clearPanel();

    const head = el('div', 'display:flex;align-items:baseline;gap:8px;margin-bottom:6px;');
    const term = el('div', 'font-size:16px;font-weight:600;word-break:break-word;', result.text);
    head.appendChild(term);
    if (result.pos) head.appendChild(el('span', 'color:#5f6368;font-size:12px;', result.pos));
    box.appendChild(head);

    box.appendChild(
      el('div', 'font-size:15px;color:#0b57d0;word-break:break-word;', result.translation || '（无译文）'),
    );

    if (Array.isArray(result.definitions) && result.definitions.length) {
      const list = el('div', 'margin-top:8px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08);');
      for (const item of result.definitions) list.appendChild(row('释义', item));
      box.appendChild(list);
    }

    if (Array.isArray(result.examples) && result.examples.length) {
      const list = el('div', 'margin-top:8px;');
      for (const example of result.examples) {
        const item = el('div', 'margin-top:4px;color:#3c4043;font-size:12.5px;');
        item.appendChild(el('div', '', example.en));
        item.appendChild(el('div', 'color:#80868b;', example.zh));
        list.appendChild(item);
      }
      box.appendChild(list);
    }

    if (result.notice) {
      box.appendChild(el('div', 'margin-top:8px;color:#80868b;font-size:11.5px;line-height:1.5;', result.notice));
    }

    box.appendChild(buildActions(result));
    positionPanel();
  }

  function buildActions(result) {
    const actions = el(
      'div',
      'display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid rgba(0,0,0,.08);',
    );

    const makeButton = (label, handler, { primary = false } = {}) => {
      const button = el(
        'button',
        [
          'appearance:none',
          'border:1px solid ' + (primary ? '#0b57d0' : 'rgba(0,0,0,.16)'),
          'background:' + (primary ? '#0b57d0' : '#fff'),
          'color:' + (primary ? '#fff' : '#1f2328'),
          'border-radius:6px',
          'padding:4px 10px',
          'font:500 12px/1.4 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif',
          'cursor:pointer',
        ].join(';'),
        label,
      );
      button.type = 'button';
      button.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        try {
          await handler(button);
        } catch (error) {
          NS.toast(error.message || '操作失败', { type: 'error' });
        }
      });
      return button;
    };

    actions.appendChild(
      makeButton(
        '＋ 生词本',
        async (button) => {
          const payload = {
            text: result.text,
            translation: result.translation,
            pos: result.pos,
            url: location.href,
          };
          const response = await NS.send(NS.MESSAGE.WORDBOOK_ADD, payload);
          button.textContent = response.duplicate ? '已在生词本' : '已加入 ✓';
          button.disabled = true;
          button.style.opacity = '0.75';
          if (!response.duplicate) NS.toast('已加入生词本', { type: 'success', duration: 1800 });
        },
        { primary: true },
      ),
    );

    actions.appendChild(
      makeButton('复制', async (button) => {
        const text = result.translation || result.text;
        try {
          await navigator.clipboard.writeText(text);
          button.textContent = '已复制 ✓';
        } catch {
          // 剪贴板不可用时降级为选中文本
          const area = document.createElement('textarea');
          area.value = text;
          area.style.cssText = 'position:fixed;opacity:0;';
          document.body.appendChild(area);
          area.select();
          document.execCommand('copy');
          area.remove();
          button.textContent = '已复制 ✓';
        }
      }),
    );

    if ('speechSynthesis' in window) {
      actions.appendChild(
        makeButton('朗读', () => {
          try {
            window.speechSynthesis.cancel();
            const utterance = new SpeechSynthesisUtterance(result.text);
            utterance.lang = 'en-US';
            utterance.rate = 0.95;
            window.speechSynthesis.speak(utterance);
          } catch {
            NS.toast('当前浏览器不支持朗读。', { type: 'error' });
          }
        }),
      );
    }

    actions.appendChild(makeButton('关闭', () => hidePanel()));
    return actions;
  }

  function positionPanel() {
    if (!panel) return;
    const selection = window.getSelection();
    let rect = null;
    if (selection && selection.rangeCount > 0 && String(selection).trim()) {
      const range = selection.getRangeAt(0).cloneRange();
      const rects = range.getClientRects();
      rect = rects.length ? rects[rects.length - 1] : range.getBoundingClientRect();
    }
    if (!rect || (!rect.width && !rect.height)) {
      rect = { left: window.innerWidth / 2, right: window.innerWidth / 2, top: 120, bottom: 140, width: 0, height: 20 };
    }

    panel.style.visibility = 'hidden';
    panel.style.opacity = '0';
    const width = panel.offsetWidth || 340;
    const height = panel.offsetHeight || 160;

    let left = rect.left + rect.width / 2 - width / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8));

    const spaceBelow = window.innerHeight - rect.bottom;
    let top;
    if (spaceBelow > height + 16) top = rect.bottom + 10;
    else top = Math.max(8, rect.top - height - 10);

    panel.style.left = `${Math.round(left)}px`;
    panel.style.top = `${Math.round(top)}px`;
    panel.style.visibility = 'visible';
    panel.style.opacity = '1';
  }

  function hidePanel() {
    if (!panel) return;
    panel.style.visibility = 'hidden';
    panel.style.opacity = '0';
    panelState = null;
  }

  function scheduleHide(delay = 180) {
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      const selection = window.getSelection();
      if (selection && String(selection).trim()) return; // 选区还在就保留
      hidePanel();
    }, delay);
  }

  /* ------------------------------------------------------------------ */
  /* 触发                                                                */
  /* ------------------------------------------------------------------ */

  async function lookup(text) {
    const settings = settingsOf();
    const maxLength = Number(settings.lookup?.maxLength) || 600;
    const trimmed = NS.normalizeText(text);
    if (!trimmed) return;
    if (trimmed.length > maxLength) {
      NS.toast(`选中文本过长（${trimmed.length} 字符），最多 ${maxLength} 字符。`, { type: 'error' });
      return;
    }
    if (!NS.hasLetters(trimmed)) return;
    if (NS.isMostlyCJK(trimmed) && !/^[A-Za-z]/.test(trimmed)) return;

    const seq = (requestSeq += 1);
    const box = ensurePanel();
    clearPanel();
    box.appendChild(el('div', 'color:#5f6368;font-size:12px;', '查询中…'));
    positionPanel();

    try {
      const result = await NS.send(NS.MESSAGE.WORD_LOOKUP, {
        text: trimmed,
        engineId: settings.lookup?.engineId || undefined,
        url: location.href,
        title: document.title,
      });
      if (seq !== requestSeq) return; // 已有更新的查询
      panelState = result;
      renderResult(result);
    } catch (error) {
      if (seq !== requestSeq) return;
      if (error.code === 'NO_API_KEY') {
        showMessage('尚未配置翻译引擎的 API Key。\n请点击扩展图标 → 打开设置 填写密钥后再试。', { error: true });
      } else {
        showMessage(`查询失败：${error.message}`, { error: true });
      }
    }
  }

  function currentSelectionText() {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return '';
    if (selection.isCollapsed) return '';
    const text = String(selection).trim();
    if (!text) return '';
    // 排除输入框内的文本（浏览器行为不一致，且容易与输入冲突）
    const anchor = selection.anchorNode;
    if (anchor && NS.isEditable(anchor)) return '';
    return text;
  }

  function onMouseUp(event) {
    if (!lookupEnabled()) return;
    if (panel && panel.contains(event.target)) return;
    if (event.target?.closest?.(`[${NS.DOM.ATTR_UI}]`)) return;
    const text = currentSelectionText();
    if (!text) {
      scheduleHide(120);
      return;
    }
    if (text === lastSelectionText && panel?.style.visibility === 'visible') return;
    lastSelectionText = text;
    if (settingsOf().lookup?.autoPopup === false) {
      // 关闭自动弹窗时，只有按下 Alt+Shift+D 才查询
      return;
    }
    lookup(text);
  }

  function onKeyUp(event) {
    if (!lookupEnabled()) return;
    // Shift + 方向键选择
    if (!event.shiftKey) return;
    const text = currentSelectionText();
    if (!text || text === lastSelectionText) return;
    lastSelectionText = text;
    if (settingsOf().lookup?.autoPopup === false) return;
    clearTimeout(hideTimer);
    hideTimer = setTimeout(() => lookup(text), 220);
  }

  function onDocumentMouseDown(event) {
    if (!panel || panel.style.visibility !== 'visible') return;
    if (panel.contains(event.target)) return;
    // 在面板外点击：如果形成了新选区，mouseup 会处理；否则关闭
    setTimeout(() => {
      const selection = window.getSelection();
      if (!selection || !String(selection).trim()) hidePanel();
    }, 0);
  }

  function onScroll() {
    if (!panel || panel.style.visibility !== 'visible') return;
    positionPanel();
  }

  function init() {
    document.addEventListener('mouseup', onMouseUp, true);
    document.addEventListener('keyup', onKeyUp, true);
    document.addEventListener('mousedown', onDocumentMouseDown, true);
    window.addEventListener('scroll', onScroll, { passive: true, capture: true });
    window.addEventListener('resize', onScroll, { passive: true });
    NS.onLookupShortcut = (explicitText) => {
      const text = String(explicitText || '').trim() || currentSelectionText();
      if (text) lookup(text);
      else NS.toast('请先选中需要查询的文字。', { duration: 2000 });
    };
  }

  NS.Selection = { init, lookup, hide: hidePanel, isPanelOpen: () => panel?.style.visibility === 'visible' };
})();