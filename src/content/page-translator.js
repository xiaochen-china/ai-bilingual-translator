/**
 * 网页双语翻译（内容脚本）。
 *
 * 设计要点：
 *  - 只翻译「叶子块级元素」（p / li / h1-h6 / td / 仅含内联内容的 div…），避免重复翻译。
 *  - 原文被包进 <span data-abt-orig style="display:contents">，布局不受影响；
 *    「仅中文」模式只是把该 span 隐藏，不需要重新排版。
 *  - 按视口懒加载 + 批量请求 + 有限并发，避免一次性打爆接口。
 *  - 失败绝不静默：失败的段落显示「未翻译」标记，并用 toast 说明原因。
 */

(function installPageTranslator() {
  'use strict';

  const NS = window.__ABT__;
  if (!NS || NS.__pageTranslatorInstalled) return;
  NS.__pageTranslatorInstalled = true;

  const { MODES, DOM } = NS;

  const SKIP_TAGS = new Set([
    'SCRIPT',
    'STYLE',
    'NOSCRIPT',
    'TEMPLATE',
    'CODE',
    'PRE',
    'KBD',
    'SAMP',
    'VAR',
    'TEXTAREA',
    'INPUT',
    'SELECT',
    'OPTION',
    'BUTTON',
    'IFRAME',
    'SVG',
    'MATH',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'OBJECT',
    'EMBED',
    'HEAD',
    'META',
    'LINK',
    'TITLE',
  ]);

  /** 这些标签一旦成为「子元素」就说明父级不是叶子块 */
  const BLOCKISH_TAGS = new Set([
    'P',
    'DIV',
    'SECTION',
    'ARTICLE',
    'ASIDE',
    'HEADER',
    'FOOTER',
    'NAV',
    'MAIN',
    'UL',
    'OL',
    'LI',
    'DL',
    'DT',
    'DD',
    'TABLE',
    'THEAD',
    'TBODY',
    'TR',
    'TD',
    'TH',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BLOCKQUOTE',
    'FIGURE',
    'FIGCAPTION',
    'FORM',
    'FIELDSET',
    'DETAILS',
    'SUMMARY',
    'ADDRESS',
    'PRE',
    'HR',
    'CANVAS',
    'VIDEO',
    'AUDIO',
    'IFRAME',
    'NOSCRIPT',
    'TEMPLATE',
    'BUTTON',
    'SELECT',
    'TEXTAREA',
  ]);

  const BLOCK_TAGS = new Set([
    'P',
    'LI',
    'H1',
    'H2',
    'H3',
    'H4',
    'H5',
    'H6',
    'BLOCKQUOTE',
    'FIGCAPTION',
    'DT',
    'DD',
    'TD',
    'TH',
    'CAPTION',
    'SUMMARY',
    'ADDRESS',
    'DIV',
    'SECTION',
    'ARTICLE',
    'ASIDE',
    'MAIN',
    'HEADER',
    'FOOTER',
    'NAV',
    'FIGURE',
    'FIELDSET',
    'LEGEND',
  ]);

  const state = {
    active: false,
    mode: MODES.BILINGUAL,
    generation: 0,
    blocks: new Map(), // Element -> record
    queue: [],
    flushing: false,
    fatal: false,
    intersection: null,
    mutation: null,
    mutationTimer: null,
    titleOriginal: null,
    titleDone: false,
    stats: { total: 0, done: 0, failed: 0, skipped: 0 },
    settings: null,
    maxBlocks: 800,
    batchSize: 8,
    concurrency: 2,
    _idSeq: 0,
  };

  function nextId() {
    state._idSeq += 1;
    return `b${state._idSeq}`;
  }

  /* ------------------------------------------------------------------ */
  /* 候选块收集                                                          */
  /* ------------------------------------------------------------------ */

  function isBlockLevel(el) {
    if (BLOCK_TAGS.has(el.tagName)) return true;
    try {
      const display = window.getComputedStyle(el).display;
      return /^(block|list-item|table-cell|table|flex|grid|flow-root)$/.test(display);
    } catch {
      return false;
    }
  }

  function hasBlockishChild(el) {
    for (const child of el.children) {
      if (BLOCKISH_TAGS.has(child.tagName)) return true;
      if (child.hasAttribute(DOM.ATTR_BLOCK)) return true;
    }
    return false;
  }

  function shouldSkipElement(el) {
    if (!el || el.nodeType !== 1) return true;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (el.hasAttribute(DOM.ATTR_UI) || el.closest(`[${DOM.ATTR_UI}]`)) return true;
    if (el.hasAttribute(DOM.ATTR_SKIP)) return true;
    if (el.isContentEditable) return true;
    if (el.closest('svg, math, canvas, video, audio, iframe, object, embed')) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    try {
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden') return true;
      if (style.userSelect === 'none' && /^(NAV|FOOTER|HEADER)$/.test(el.tagName)) return true;
    } catch {
      return true;
    }
    return false;
  }

  function elementText(el) {
    let text = '';
    try {
      text = el.innerText || '';
    } catch {
      text = '';
    }
    if (!text.trim()) text = el.textContent || '';
    return NS.normalizeText(text);
  }

  /**
   * 深度优先收集「叶子块」。命中一个块就不再往里走，保证不重复。
   * @param {Element} root
   * @param {Element[]} out
   */
  function walk(root, out) {
    if (!root || !root.children) return;
    const stack = [root];
    let guard = 0;
    while (stack.length && guard < 40000) {
      guard += 1;
      const el = stack.pop();
      if (!el || el.nodeType !== 1) continue;
      if (shouldSkipElement(el)) continue;
      if (el.hasAttribute(DOM.ATTR_BLOCK)) continue; // 已处理过 / 正在处理

      const isLeaf = isBlockLevel(el) && !hasBlockishChild(el);
      if (isLeaf) {
        const text = elementText(el);
        if (text.length >= 2) out.push({ el, text });
        continue;
      }
      // 不是叶子块：继续向下（倒序入栈保证文档顺序）
      for (let index = el.children.length - 1; index >= 0; index -= 1) {
        stack.push(el.children[index]);
      }
    }
  }

  function isTranslatableText(text) {
    if (!text) return false;
    if (text.length < (state.settings?.page?.minBlockLength ?? 4)) return false;
    if (text.length > 6000) return false;
    if (!NS.hasLetters(text)) return false;
    if (NS.isMostlyCJK(text)) return false;
    // 纯 URL / 纯符号
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
    return true;
  }

  /* 正文优先：正文区排最前，页头/侧栏/页脚等界面区域排最后。
     块数有上限（默认 800）时，先翻正文才不会把预算耗在「登录 / 搜索」这类
     界面文字上。 */
  const MAIN_REGION_SELECTOR = [
    'main',
    'article',
    '[role="main"]',
    '.mw-parser-output',
    '.s-prose',
    '.markdown-body',
    '.post-text',
    '.article-body',
    '.entry-content',
    '#readme',
    '#content',
  ].join(', ');
  const CHROME_REGION_SELECTOR = [
    'header',
    'footer',
    'aside',
    'nav',
    '[role="navigation"]',
    '[role="banner"]',
    '[role="contentinfo"]',
    '[role="complementary"]',
    '[role="search"]',
  ].join(', ');

  function regionPriority(el) {
    try {
      if (el.closest(MAIN_REGION_SELECTOR)) return 0;
      if (el.closest(CHROME_REGION_SELECTOR)) return 2;
    } catch {
      return 1;
    }
    return 1;
  }

  /* ------------------------------------------------------------------ */
  /* 记录与渲染                                                          */
  /* ------------------------------------------------------------------ */

  function createRecord(el, text) {
    el.setAttribute(DOM.ATTR_BLOCK, '');
    const wrapper = document.createElement('span');
    wrapper.setAttribute(DOM.ATTR_ORIG, '');
    wrapper.setAttribute(DOM.ATTR_UI, '');
    wrapper.style.display = 'contents';

    while (el.firstChild) wrapper.appendChild(el.firstChild);
    el.appendChild(wrapper);

    const trans = document.createElement('span');
    trans.className = DOM.CLASS_TRANS;
    trans.setAttribute(DOM.ATTR_TRANS, '');
    trans.setAttribute(DOM.ATTR_UI, '');
    trans.setAttribute('data-abt-pending', '');
    trans.textContent = '翻译中…';
    el.appendChild(trans);

    const record = {
      id: nextId(),
      el,
      wrapper,
      trans,
      text,
      status: 'pending',
    };
    state.blocks.set(el, record);
    state.stats.total += 1;
    return record;
  }

  function renderTranslation(record, translated) {
    const inlineCode = state.settings?.style?.inlineCode !== false;
    record.trans.removeAttribute('data-abt-pending');
    record.trans.removeAttribute('data-abt-error');
    record.trans.textContent = '';
    record.trans.appendChild(NS.buildTranslationFragment(translated, { inlineCode }));
    record.status = 'done';
    state.stats.done += 1;
  }

  function renderFailure(record, message) {
    record.trans.removeAttribute('data-abt-pending');
    record.trans.setAttribute('data-abt-error', '');
    record.trans.textContent = '⟦未翻译⟧';
    record.trans.title = message || '翻译失败';
    record.status = 'failed';
    state.stats.failed += 1;
  }

  function removeRecord(record) {
    try {
      if (record.trans?.parentNode) record.trans.remove();
      if (record.wrapper?.parentNode) {
        const parent = record.wrapper.parentNode;
        while (record.wrapper.firstChild) parent.insertBefore(record.wrapper.firstChild, record.wrapper);
        record.wrapper.remove();
      }
      record.el.removeAttribute(DOM.ATTR_BLOCK);
    } catch {
      // 页面结构发生变化时忽略
    }
    state.blocks.delete(record.el);
  }

  /* ------------------------------------------------------------------ */
  /* 请求调度                                                            */
  /* ------------------------------------------------------------------ */

  function enqueue(record) {
    if (!state.active || state.fatal) return;
    if (record.status !== 'pending') return;
    if (state.queue.includes(record)) return;
    state.queue.push(record);
    scheduleFlush();
  }

  let flushTimer = null;
  function scheduleFlush() {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      flushQueue();
    }, 60);
  }

  async function flushQueue() {
    if (state.flushing || !state.active) return;
    state.flushing = true;
    const generation = state.generation;
    try {
      const workerCount = Math.max(1, Math.min(4, Number(state.concurrency) || 1));
      const workers = Array.from({ length: workerCount }, async () => {
        while (state.active && !state.fatal && state.queue.length && generation === state.generation) {
          const batch = state.queue.splice(0, Math.max(1, state.batchSize));
          if (!batch.length) break;
          await translateBatch(batch, generation);
        }
      });
      await Promise.all(workers);
    } finally {
      state.flushing = false;
      // 等待期间可能又有新任务进来
      if (state.active && !state.fatal && state.queue.length) scheduleFlush();
    }
  }

  async function translateBatch(batch, generation) {
    const items = batch.map((record) => ({ id: record.id, text: record.text }));
    let response;
    try {
      response = await NS.send(NS.MESSAGE.TRANSLATE, { items, requestId: `page-${generation}-${batch[0].id}` });
    } catch (error) {
      if (generation !== state.generation) return;
      if (['NO_API_KEY', 'AUTH_ERROR', 'ENGINE_DISABLED', 'CONTEXT_LOST'].includes(error.code)) {
        handleFatal(error);
        return;
      }
      for (const record of batch) {
        if (state.blocks.has(record.el)) renderFailure(record, error.message);
      }
      NS.toast(`翻译失败：${error.message}`, { type: 'error' });
      return;
    }
    if (generation !== state.generation || !state.active) return;

    const byId = new Map((response.results || []).map((item) => [item.id, item]));
    for (const record of batch) {
      if (!state.blocks.has(record.el)) continue;
      const result = byId.get(record.id);
      if (result && result.translated) renderTranslation(record, result.translated);
      else renderFailure(record, '引擎返回了空译文');
    }
  }

  function handleFatal(error) {
    state.fatal = true;
    state.queue.length = 0;
    const message =
      error.code === 'NO_API_KEY'
        ? '尚未配置 API Key：请点击扩展图标，在设置里填写翻译引擎的密钥。'
        : error.code === 'CONTEXT_LOST'
          ? '扩展已更新或重新加载，请刷新页面后再翻译。'
          : error.message || '翻译服务不可用。';
    NS.toast(message, { type: 'error', duration: 6000 });
    for (const record of state.blocks.values()) {
      if (record.status === 'pending') renderFailure(record, message);
    }
  }

  /* ------------------------------------------------------------------ */
  /* 懒加载与动态内容                                                    */
  /* ------------------------------------------------------------------ */

  function observeRecords(records, { lazy }) {
    if (!lazy || typeof IntersectionObserver !== 'function') {
      records.forEach(enqueue);
      return;
    }
    if (!state.intersection) {
      state.intersection = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            state.intersection.unobserve(entry.target);
            const record = state.blocks.get(entry.target);
            if (record) enqueue(record);
          }
        },
        { rootMargin: '400px 0px', threshold: 0.01 },
      );
    }
    for (const record of records) state.intersection.observe(record.el);
  }

  function startMutationObserver() {
    if (state.mutation) return;
    state.mutation = new MutationObserver((mutations) => {
      let hasNewContent = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.hasAttribute?.(DOM.ATTR_UI)) continue;
          hasNewContent = true;
          break;
        }
        if (hasNewContent) break;
      }
      if (!hasNewContent) return;
      // 新增内容需要节流：SPA 页面可能连续插入大量节点
      clearTimeout(state.mutationTimer);
      state.mutationTimer = setTimeout(() => {
        if (state.active) scan(document.body, { lazy: true });
      }, 700);
    });
    state.mutation.observe(document.body, { childList: true, subtree: true });
  }

  function scan(root, { lazy }) {
    if (!state.active || state.fatal) return;
    const budget = Math.max(0, state.maxBlocks - state.blocks.size);
    if (budget <= 0) return;
    const candidates = [];
    walk(root, candidates);
    // 按「正文 → 其它 → 界面区域」稳定排序，保证预算优先花在正文上
    const scored = candidates
      .map((candidate, index) => ({ candidate, index, priority: regionPriority(candidate.el) }))
      .sort((a, b) => a.priority - b.priority || a.index - b.index);
    // 页面里确实有正文时，直接不翻页头/页脚/侧栏那类界面文字（多数情况下它们只是
    // 「登录 / 搜索 / 导航菜单」这类噪音，翻了反而干扰阅读）。
    const hasMainRegion = scored.some((item) => item.priority === 0);
    const ordered = scored.filter((item) => !(hasMainRegion && item.priority === 2)).map((item) => item.candidate);
    const chosen = [];
    for (const candidate of ordered) {
      if (chosen.length >= budget) break;
      if (state.blocks.has(candidate.el)) continue;
      if (!isTranslatableText(candidate.text)) {
        state.stats.skipped += 1;
        candidate.el.setAttribute(DOM.ATTR_SKIP, '');
        continue;
      }
      chosen.push(createRecord(candidate.el, candidate.text));
    }
    if (chosen.length) observeRecords(chosen, { lazy });
  }

  /* ------------------------------------------------------------------ */
  /* 标题                                                                */
  /* ------------------------------------------------------------------ */

  async function translateTitle(generation) {
    if (state.titleDone) return;
    const page = state.settings?.page || {};
    if (page.translateTitle === false) return;
    const title = NS.normalizeText(document.title);
    if (!title || !NS.hasLetters(title) || NS.isMostlyCJK(title)) return;
    state.titleOriginal = document.title;
    state.titleDone = true;
    try {
      const response = await NS.send(NS.MESSAGE.TRANSLATE, {
        items: [{ id: 'title', text: title }],
        requestId: `title-${generation}`,
      });
      if (generation !== state.generation || !state.active) return;
      const translated = response.results?.[0]?.translated;
      if (translated) document.title = `${translated} | ${title}`;
    } catch {
      // 标题翻译失败不影响正文
    }
  }

  /* ------------------------------------------------------------------ */
  /* 对外接口                                                            */
  /* ------------------------------------------------------------------ */

  async function start({ mode } = {}) {
    if (NS.isSkippedPage()) return { ok: false, reason: 'SKIPPED_PAGE' };
    if (state.active) {
      if (mode && mode !== state.mode) setMode(mode);
      return { ok: true, alreadyActive: true, stats: { ...state.stats } };
    }

    const settings = await NS.fetchSettings();
    state.settings = settings;
    state.maxBlocks = Number(settings.page?.maxBlocks) || 800;
    state.batchSize = Math.max(1, Math.min(20, Number(settings.page?.batchSize) || 8));
    state.concurrency = Math.max(1, Math.min(4, Number(settings.page?.concurrency) || 2));
    state.mode = mode || settings.mode || MODES.BILINGUAL;
    if (state.mode === MODES.OFF) return { ok: false, reason: 'MODE_OFF' };

    state.active = true;
    state.fatal = false;
    state.generation += 1;
    state.stats = { total: 0, done: 0, failed: 0, skipped: 0 };
    NS.injectPageStyles(settings);
    NS.applyMode(state.mode);

    const generation = state.generation;
    scan(document.body, { lazy: settings.page?.lazyLoad !== false });
    if (state.stats.total === 0) {
      NS.toast('没有找到可翻译的英文正文。', { duration: 2400 });
      return { ok: false, reason: 'NOTHING_TO_TRANSLATE' };
    }
    if (settings.page?.observeDynamic !== false) startMutationObserver();
    translateTitle(generation);

    return { ok: true, stats: { ...state.stats } };
  }

  function stopObservers() {
    state.intersection?.disconnect();
    state.intersection = null;
    state.mutation?.disconnect();
    state.mutation = null;
    clearTimeout(state.mutationTimer);
    clearTimeout(flushTimer);
    flushTimer = null;
  }

  function restore() {
    state.generation += 1;
    state.active = false;
    stopObservers();
    state.queue.length = 0;
    for (const record of [...state.blocks.values()]) removeRecord(record);
    state.blocks.clear();
    if (state.titleOriginal && state.titleDone) {
      document.title = state.titleOriginal;
    }
    state.titleOriginal = null;
    state.titleDone = false;
    state.fatal = false;
    state.stats = { total: 0, done: 0, failed: 0, skipped: 0 };
    NS.removePageStyles();
    return { ok: true };
  }

  function setMode(mode) {
    if (!Object.values(MODES).includes(mode)) return { ok: false, reason: 'BAD_MODE' };
    if (mode === MODES.OFF) return restore();
    state.mode = mode;
    NS.applyMode(mode);
    if (!state.active) return start({ mode });
    return { ok: true, mode };
  }

  function nextMode() {
    const order = [MODES.BILINGUAL, MODES.ZH_ONLY, MODES.HOVER, MODES.OFF];
    const index = order.indexOf(state.mode);
    return order[(index + 1) % order.length];
  }

  function getState() {
    return {
      active: state.active,
      mode: state.mode,
      fatal: state.fatal,
      stats: { ...state.stats },
    };
  }

  NS.PageTranslator = { start, restore, setMode, nextMode, getState };
})();