#!/usr/bin/env node
/**
 * 端到端冒烟测试（零依赖，使用 Node 内置 WebSocket + Chrome DevTools Protocol）。
 *
 * 流程：
 *  1. 起一个本地 HTTP 页面（含标题、正文、列表、表格、代码块、导航、按钮）；
 *  2. 用真实 Chrome / Edge 通过 --load-extension 加载本扩展；
 *  3. 打开本地页面 → 内容脚本自动注入 → 页面发消息唤醒后台 Service Worker；
 *  4. 在目标列表里按路径 `src/background/service-worker.js` 认出**本扩展**的 SW，拿到扩展 ID；
 *  5. 打开设置页，检查 9 个分区、4 个引擎面板、版本号、页面零报错；
 *  6. 通过真实页面发 settings.get / cache.stats / wordbook.list 消息，验证后台链路；
 *  7. 向内容脚本发 page.state，验证页面↔后台双向通道；
 *  8. 加 --google 时再触发一次真实网页翻译，检查译文节点与代码块是否被正确跳过。
 *
 * 用法：
 *   node tools/e2e-smoke.mjs
 *   node tools/e2e-smoke.mjs --google
 *
 * 退出码：0 = 全部通过；1 = 结构性失败（--google 的网络失败会单独标注，不算脚本错误）。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = 9333;
const RUN_GOOGLE = process.argv.includes('--google');

// 优先 Edge：本机实测 Chrome 156 已忽略 --load-extension（扩展不会被加载），
// Edge 156 仍支持，且 Edge 是本扩展的第一目标浏览器。
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];

const FIXTURE_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8" /><title>E2E Fixture</title></head>
  <body>
    <nav><a href="#a">Home</a> <a href="#b">Docs</a></nav>
    <h1>The kernel and its responsibilities</h1>
    <p>The kernel is the core of an operating system. It manages memory, schedules processes, and talks to hardware through drivers.</p>
    <p>A pointer simply stores a memory address. Reading from an invalid pointer usually crashes the program.</p>
    <ul><li>Registers are the fastest storage inside a CPU.</li><li>System calls cross the boundary between user space and kernel space.</li></ul>
    <table><tr><th>Term</th><th>Meaning</th></tr><tr><td>Kernel</td><td>The privileged core of the system.</td></tr></table>
    <pre><code>int main(void) { return 0; }</code></pre>
    <button type="button">Do not translate me</button>
  </body>
</html>`;

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    this.ws = null;
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
      if (msg.method && this.listeners.has(msg.method)) {
        for (const handler of this.listeners.get(msg.method)) {
          try {
            handler(msg.params, msg.sessionId);
          } catch {
            /* 监听器异常不影响主流程 */
          }
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
      }, 30000);
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function evaluate(cdp, sessionId, expression, contextId) {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true, ...(contextId ? { contextId } : {}) },
    sessionId,
  );
  if (exceptionDetails) {
    const detail =
      exceptionDetails.exception?.description || exceptionDetails.exception?.value || exceptionDetails.text || '';
    throw new Error(`页面脚本异常：${String(detail).split('\n').slice(0, 3).join(' | ')}`);
  }
  return result.value;
}

async function waitForDebugger() {
  const deadline = Date.now() + 25000;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* 尚未就绪 */
    }
    await sleep(300);
  }
  throw new Error('浏览器调试端口未就绪');
}

function pickBrowser() {
  for (const candidate of CANDIDATES) if (existsSync(candidate)) return candidate;
  throw new Error('未找到 Chrome / Edge 可执行文件');
}

/** 按路径认出本扩展的 Service Worker（会跳过浏览器自带的组件扩展） */
async function waitForOwnServiceWorker(cdp) {
  const deadline = Date.now() + 25000;
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
  throw new Error(`未等到扩展的 Service Worker，现有目标：${last.map((t) => `${t.type}:${t.url}`).join(', ')}`);
}

/* ------------------------------------------------------------------ */
/* 主流程                                                              */
/* ------------------------------------------------------------------ */

async function main() {
  const browser = pickBrowser();
  const profile = await mkdtemp(path.join(tmpdir(), 'abt-e2e-'));

  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(FIXTURE_HTML);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;

  const child = spawn(
    browser,
    [
      '--headless=new',
      '--disable-gpu',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
      `--user-data-dir=${profile}`,
      `--remote-debugging-port=${PORT}`,
      `--load-extension=${ROOT}`,
      `--disable-extensions-except=${ROOT}`,
      fixtureUrl,
    ],
    { stdio: 'ignore' },
  );

  const report = { browser: path.basename(browser), fixture: fixtureUrl, steps: [], ok: false };

  try {
    const cdp = new CDP(await waitForDebugger());
    await cdp.connect();

    // 1. Service Worker（证明清单合法、后台脚本可启动）
    const worker = await waitForOwnServiceWorker(cdp);
    const extensionId = new URL(worker.url).host;
    report.extensionId = extensionId;
    report.steps.push({ name: '扩展加载 / Service Worker', ok: true, detail: worker.url });

    // 附加到 Service Worker，收集后台异常（后台崩溃会让页面一直停在「翻译中…」）
    const workerLogs = [];
    const workerTarget = (await cdp.send('Target.getTargets')).targetInfos.find(
      (t) => t.type === 'service_worker' && String(t.url) === worker.url,
    );
    if (workerTarget) {
      const attached = await cdp.send('Target.attachToTarget', { targetId: workerTarget.targetId, flatten: true });
      const workerSession = attached.sessionId;
      await cdp.send('Runtime.enable', {}, workerSession).catch(() => {});
      cdp.on('Runtime.exceptionThrown', (params, sid) => {
        if (sid !== workerSession) return;
        workerLogs.push(`异常：${String(params.exceptionDetails.exception?.description || params.exceptionDetails.text).split('\n')[0]}`);
      });
      cdp.on('Runtime.consoleAPICalled', (params, sid) => {
        if (sid !== workerSession) return;
        if (params.type !== 'error' && params.type !== 'warning') return;
        workerLogs.push(`${params.type}：${params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
      });
    }

    // 2. 设置页
    const { targetId } = await cdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/src/options/options.html`,
    });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Log.enable', {}, sessionId).catch(() => {});

    const pageErrors = [];
    cdp.on('Runtime.exceptionThrown', (params, sid) => {
      if (sid !== sessionId) return;
      pageErrors.push(String(params.exceptionDetails.exception?.description || params.exceptionDetails.text).split('\n')[0]);
    });
    cdp.on('Log.entryAdded', (params, sid) => {
      if (sid && sid !== sessionId) return;
      if (params.entry.level === 'error') pageErrors.push(`${params.entry.text} ${params.entry.url || ''}`.trim());
    });

    await sleep(1500);

    const pageInfo = await evaluate(
      cdp,
      sessionId,
      `(() => ({
        title: document.title,
        sections: [...document.querySelectorAll('.card h2')].map((h) => h.textContent.trim()),
        panels: document.querySelectorAll('[data-engine-panel]').length,
        engineOptions: document.querySelectorAll('#engine-picker option').length,
        glossaryRows: document.querySelectorAll('#glossary-body tr').length,
        version: document.getElementById('version-badge')?.textContent || '',
        styleControls: document.querySelectorAll('[data-setting]').length,
      }))()`,
    );
    report.page = pageInfo;
    report.pageErrors = pageErrors;
    const pageOk =
      pageInfo.sections.length >= 8 &&
      pageInfo.engineOptions === 4 &&
      pageInfo.panels === 4 &&
      pageInfo.styleControls >= 20 &&
      pageErrors.length === 0;
    report.steps.push({
      name: '设置页渲染',
      ok: pageOk,
      detail: `${pageInfo.sections.length} 分区 / ${pageInfo.engineOptions} 引擎 / ${pageInfo.styleControls} 自动保存控件 / ${pageInfo.version}${
        pageErrors.length ? ` / 报错：${pageErrors[0]}` : ''
      }`,
    });

    // 3. 后台消息链路
    const messages = await evaluate(
      cdp,
      sessionId,
      `(async () => {
        const call = (type, payload) => chrome.runtime.sendMessage({ v: 1, type, id: 'e2e-' + type, payload });
        const out = {};
        try {
          const res = await call('settings.get', {});
          out.settingsOk = Boolean(res?.ok);
          out.engines = res?.payload?.engines?.length ?? 0;
          out.mode = res?.payload?.settings?.mode;
          out.hasGlossary = (res?.payload?.settings?.glossary || []).length;
        } catch (error) { out.settingsError = String(error?.message || error); }
        try {
          const res = await call('cache.stats', {});
          out.cacheDriver = res?.payload?.driver;
          out.cacheCount = res?.payload?.count;
        } catch (error) { out.cacheError = String(error?.message || error); }
        try {
          const res = await call('wordbook.list', {});
          out.wordbookIsArray = Array.isArray(res?.payload?.items);
        } catch (error) { out.wordbookError = String(error?.message || error); }
        try {
          const res = await call('subtitle.tracks', {});
          out.subtitleHonest = res?.ok === false ? res.payload?.reason || res.error?.code : 'returned';
        } catch (error) { out.subtitleError = String(error?.message || error); }
        return out;
      })()`,
    );
    report.messages = messages;
    report.workerLogs = workerLogs;
    const messagesOk =
      messages.settingsOk === true &&
      messages.engines === 4 &&
      messages.wordbookIsArray === true &&
      messages.hasGlossary >= 6;
    report.steps.push({
      name: '后台消息链路',
      ok: messagesOk,
      detail: `引擎 ${messages.engines} · 术语 ${messages.hasGlossary} 条 · 缓存驱动 ${messages.cacheDriver} · 字幕给出明确结果 ${messages.subtitleHonest}`,
    });

    // 3. 其它三个界面（弹窗 / 侧边栏 / 字幕面板）能否正常渲染且无 JS 异常
    const uiPages = [
      { name: '弹窗界面', path: 'src/popup/popup.html', ids: ['btn-translate', 'modes', 'engine', 'btn-options'] },
      { name: '侧边栏界面', path: 'src/sidepanel/sidepanel.html', ids: ['tab-wordbook', 'tab-history', 'filter', 'list'] },
      { name: '字幕面板界面', path: 'src/subtitle/subtitle.html', ids: ['status-badge', 'track-select', 'btn-translate', 'cue-body'] },
    ];
    const uiResults = [];
    for (const ui of uiPages) {
      try {
      const uiUrl = `chrome-extension://${extensionId}/${ui.path}`;
      // 用扩展自己的 tabs API 打开，避免 CDP 直接创建 chrome-extension:// 目标被拒绝
      await evaluate(
        cdp,
        sessionId,
        `new Promise((resolve) => chrome.tabs.create({ url: ${JSON.stringify(uiUrl)} }, () => resolve(true)))`,
      );
      let uiTargetId = null;
      for (let i = 0; i < 40 && !uiTargetId; i += 1) {
        const infos = (await cdp.send('Target.getTargets')).targetInfos;
        uiTargetId = infos.find((t) => String(t.url) === uiUrl)?.targetId || null;
        if (!uiTargetId) await sleep(250);
      }
      if (!uiTargetId) {
        const all = (await cdp.send('Target.getTargets')).targetInfos.map((t) => `${t.type}:${t.url}`);
        report.steps.push({ name: ui.name, ok: false, detail: `标签页未能打开：${uiUrl}｜现有目标 ${all.filter((t) => t.includes(extensionId)).join(' , ') || '无'}` });
        continue;
      }
      if (process.env.ABT_E2E_DEBUG) console.log('attach ui', ui.name, uiTargetId);
      const attachedUi = await cdp.send('Target.attachToTarget', { targetId: uiTargetId, flatten: true });
      if (process.env.ABT_E2E_DEBUG) console.log('attach ui result', JSON.stringify(attachedUi));
      const uiSession = attachedUi?.sessionId || attachedUi?.result?.sessionId;
      if (!uiSession) {
        report.steps.push({ name: ui.name, ok: false, detail: `附加调试会话失败：${JSON.stringify(attachedUi.error || attachedUi)}` });
        continue;
      }
      const uiErrors = [];
      cdp.on('Runtime.exceptionThrown', (params, sid) => {
        if (sid !== uiSession) return;
        uiErrors.push(String(params.exceptionDetails.exception?.description || params.exceptionDetails.text).split('\n')[0]);
      });
      await cdp.send('Runtime.enable', {}, uiSession);
      await sleep(1200);
      const rendered = await evaluate(
        cdp,
        uiSession,
        `(() => ({
          title: document.title,
          missing: ${JSON.stringify(ui.ids)}.filter((id) => !document.getElementById(id)),
          textLength: (document.body.innerText || '').length,
        }))()`,
      );
      await cdp.send('Target.closeTarget', { targetId: uiTargetId }).catch(() => {});
      uiResults.push({ ...ui, ...rendered, errors: uiErrors });
      report.steps.push({
        name: ui.name,
        ok: Boolean(rendered && rendered.missing.length === 0 && uiErrors.length === 0 && rendered.textLength > 0),
        detail: `${rendered?.title} · 缺失元素 ${rendered?.missing.length || 0} · JS 异常 ${uiErrors.length} · 文本 ${rendered?.textLength} 字符`,
      });
      } catch (error) {
        report.steps.push({ name: ui.name, ok: false, detail: `渲染检查失败：${error.message}` });
      }
    }
    report.uiPages = uiResults;

    // 4. 直接后台翻译（隔离变量：这一条不需要内容脚本，只测引擎链路）
    const directTranslate = await evaluate(
      cdp,
      sessionId,
      `(() => {
        const call = chrome.runtime.sendMessage({ v: 1, type: 'translate', id: 'e2e-direct', payload: { items: [{ id: 'a', text: 'The kernel manages memory and devices.' }], engineId: 'google-free' } });
        const timeout = new Promise((resolve) => setTimeout(() => resolve({ timedOut: true }), 90000));
        return Promise.race([
          call.then((res) => res?.ok
            ? { ok: true, translated: res.payload?.results?.[0]?.translated, engine: res.payload?.engineName }
            : { ok: false, code: res?.error?.code, message: res?.error?.message })
            .catch((error) => ({ ok: false, code: 'EXCEPTION', message: String(error?.message || error) })),
          timeout,
        ]);
      })()`,
    );
    report.directTranslate = directTranslate;
    report.steps.push({
      name: '后台引擎直连翻译',
      ok: directTranslate?.ok === true,
      detail: directTranslate?.ok
        ? `${directTranslate.engine} → 「${directTranslate.translated}」`
        : `失败 ${directTranslate?.code || 'TIMEOUT'}：${directTranslate?.message || '超过 90 秒无响应'}`,
    });

    // 5. 页面 ↔ 内容脚本 ↔ 后台 双向通道
    const contentProbe = await evaluate(
      cdp,
      sessionId,
      `(async () => {
        const tabs = await chrome.tabs.query({});
        for (const tab of tabs) {
          if (!tab.id || String(tab.url || '').startsWith('chrome-extension://')) continue;
          try {
            const state = await chrome.tabs.sendMessage(tab.id, { v: 1, type: 'page.state', id: 'e2e-state', payload: {} });
            if (state?.ok) return { tabId: tab.id, mode: state.payload?.page?.mode, host: state.payload?.hostname, active: state.payload?.page?.active };
          } catch { /* 该标签页没有内容脚本，继续 */ }
        }
        return { error: '没有任何标签页响应 page.state' };
      })()`,
    );
    report.contentScript = contentProbe;
    const contentOk = Boolean(contentProbe && contentProbe.tabId);
    report.steps.push({
      name: '内容脚本通道',
      ok: contentOk,
      detail: contentOk ? `tab ${contentProbe.tabId} · 主机 ${contentProbe.host} · 模式 ${contentProbe.mode}` : contentProbe.error,
    });

    // 5. 可选：真实翻译（需要网络；网络失败如实记录，不伪造成功）
    if (RUN_GOOGLE && contentOk) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      const pageTarget = targetInfos.find((t) => String(t.url).startsWith(fixtureUrl));
      if (!pageTarget) {
        report.steps.push({ name: '网页真实翻译', ok: false, detail: '未找到被翻译的标签页' });
      } else {
        const attached = await cdp.send('Target.attachToTarget', { targetId: pageTarget.targetId, flatten: true });
        const pageSession = attached.sessionId;
        const contexts = [];
        cdp.on('Runtime.executionContextCreated', (params, sid) => {
          if (sid === pageSession) contexts.push(params.context);
        });
        await cdp.send('Runtime.enable', {}, pageSession);
        await sleep(500);

        // 找到内容脚本所在的隔离世界：逐个上下文探测 window.__ABT__
        let abtContextId = null;
        for (const context of contexts) {
          const probe = await evaluate(
            cdp,
            pageSession,
            'typeof window.__ABT__',
            context.id,
          ).catch(() => 'undefined');
          if (probe === 'object') {
            abtContextId = context.id;
            break;
          }
        }
        report.isolatedWorld = Boolean(abtContextId);

        // 内容脚本 → 后台：直接调用内容脚本自己的 send，隔离排程逻辑
        if (abtContextId) {
          const direct = await evaluate(
            cdp,
            pageSession,
            `window.__ABT__.send('translate', { items: [{ id: 'z1', text: 'The kernel manages memory and devices.' }] }, { timeoutMs: 30000 })
              .then((r) => 'OK:' + JSON.stringify(r).slice(0, 200))
              .catch((e) => 'ERR:' + (e.code || 'CODE?') + ':' + e.message)`,
            abtContextId,
          ).catch((error) => `EVAL_FAIL:${error.message}`);
          report.contentScriptDirect = direct;
          report.steps.push({
            name: '内容脚本→后台翻译',
            ok: String(direct).startsWith('OK:'),
            detail: String(direct).slice(0, 180),
          });
        }

        // 无头浏览器里标签页默认「不可见」，IntersectionObserver 不会回调，
        // 懒加载队列因此不会入队。这里把页面切到前台并开启焦点模拟，模拟真实使用。
        await cdp.send('Page.enable', {}, pageSession).catch(() => {});
        await cdp.send('Page.bringToFront', {}, pageSession).catch(() => {});
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, pageSession).catch(() => {});
        await sleep(300);

        // 触发整页翻译
        await evaluate(
          cdp,
          sessionId,
          `chrome.tabs.sendMessage(${JSON.stringify(contentProbe.tabId)}, { v: 1, type: 'page.translate', id: 'e2e-translate', payload: { mode: 'bilingual' } })`,
        );

        let domStats = null;
        const deadline = Date.now() + 90000;
        while (Date.now() < deadline) {
          domStats = await evaluate(
            cdp,
            pageSession,
            `(() => {
              const nodes = [...document.querySelectorAll('[data-abt-block]')];
              const trans = [...document.querySelectorAll('.abt-trans')].map((n) => n.textContent.trim());
              const first = document.querySelector('.abt-trans');
              return {
                blocks: nodes.length,
                done: trans.filter((t) => t && t !== '翻译中…').length,
                pending: trans.filter((t) => t === '翻译中…').length,
                failed: trans.filter((t) => t.includes('未翻译')).length,
                reason: first?.title || '',
                sample: trans.find((t) => t && t !== '翻译中…') || '',
                codeTouched: document.querySelectorAll('pre [data-abt-block], code [data-abt-block]').length,
                buttonTouched: document.querySelectorAll('button [data-abt-block]').length,
                navTouched: document.querySelectorAll('nav [data-abt-block]').length,
                mode: document.documentElement.getAttribute('data-abt-mode'),
              };
            })()`,
          );
          if (domStats.pending === 0 && domStats.blocks > 0) break;
          await sleep(1000);
        }
        report.translationDom = domStats;
        const translationOk = Boolean(
          domStats && domStats.done > 0 && domStats.codeTouched === 0 && domStats.buttonTouched === 0,
        );
        report.steps.push({
          name: '网页真实翻译',
          ok: translationOk,
          detail: domStats
            ? `文本块 ${domStats.blocks} · 已译 ${domStats.done} · 失败 ${domStats.failed} · 悬挂 ${domStats.pending} · 代码块误译 ${domStats.codeTouched} · 按钮误译 ${domStats.buttonTouched} · 示例「${String(domStats.sample).slice(0, 40)}」${domStats.reason ? ` · 失败原因「${domStats.reason.slice(0, 60)}」` : ''}`
            : '未能读取页面状态',
        });

        // 模式切换：仅中文应隐藏原文，原文 wrapper 用 display:none
        await evaluate(
          cdp,
          sessionId,
          `chrome.tabs.sendMessage(${JSON.stringify(contentProbe.tabId)}, { v: 1, type: 'page.setMode', id: 'e2e-mode', payload: { mode: 'zh' } })`,
        );
        await sleep(600);
        const zhMode = await evaluate(
          cdp,
          pageSession,
          `(() => {
            const orig = document.querySelector('[data-abt-orig]');
            const trans = document.querySelector('.abt-trans');
            return {
              mode: document.documentElement.getAttribute('data-abt-mode'),
              origDisplay: orig ? getComputedStyle(orig).display : 'missing',
              transVisible: Boolean(trans && getComputedStyle(trans).display !== 'none'),
            };
          })()`,
        );
        report.zhMode = zhMode;
        report.steps.push({
          name: '仅中文模式',
          ok: zhMode?.mode === 'zh' && zhMode?.origDisplay === 'none' && zhMode?.transVisible === true,
          detail: `模式 ${zhMode?.mode} · 原文 display=${zhMode?.origDisplay} · 译文可见 ${zhMode?.transVisible}`,
        });

        // 还原页面：译文与包装节点应全部清除
        await evaluate(
          cdp,
          sessionId,
          `chrome.tabs.sendMessage(${JSON.stringify(contentProbe.tabId)}, { v: 1, type: 'page.restore', id: 'e2e-restore', payload: {} })`,
        );
        await sleep(800);
        const restored = await evaluate(
          cdp,
          pageSession,
          `(() => ({
            blocks: document.querySelectorAll('[data-abt-block]').length,
            trans: document.querySelectorAll('.abt-trans').length,
            orig: document.querySelectorAll('[data-abt-orig]').length,
            bodyText: (document.body.innerText || '').slice(0, 60),
          }))()`,
        );
        report.restored = restored;
        report.steps.push({
          name: '还原页面',
          ok: restored?.blocks === 0 && restored?.trans === 0 && restored?.orig === 0,
          detail: `残留块 ${restored?.blocks} · 残留译文节点 ${restored?.trans} · 正文「${restored?.bodyText}」`,
        });
      }
    }

    report.ok = report.steps.every((step) => step.ok);
    cdp.close();
  } catch (error) {
    report.error = error.message;
  } finally {
    child.kill();
    server.close();
    await sleep(600);
    await rm(profile, { recursive: true, force: true }).catch(() => {});
  }

  console.log(JSON.stringify(report, null, 2));
  return report.ok ? 0 : 1;
}

process.exitCode = await main();