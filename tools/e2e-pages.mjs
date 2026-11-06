#!/usr/bin/env node
/**
 * 真实网页抽样测试（需要网络）。
 *
 * 文档要求测试「普通英文网页 / 长篇技术文章 / GitHub 仓库页面 / Stack Overflow / 动态加载 / 含代码块」，
 * 这个脚本就是在真实站点上跑一遍：触发整页翻译，等译文落地，然后统计
 * 「译了多少块 / 失败几块 / 代码块有没有被误译 / 抽取一条译文样本」。
 *
 * 用法：
 *   node tools/e2e-pages.mjs                       # 跑默认的四个站点
 *   node tools/e2e-pages.mjs <url> [url...]        # 跑指定站点
 *   node tools/e2e-pages.mjs --headed              # 显示窗口（排查用）
 *
 * 说明：为了让测试在几分钟内结束，脚本会先把 page.maxBlocks 调成 12、关掉懒加载；
 * 测完恢复原设置。翻译走真实 Google 免费端点，不注入任何假数据。
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';

const ROOT = path.resolve(import.meta.dirname, '..');
const CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
];
const PORT = 9491;
const HEADED = process.argv.includes('--headed');

const DEFAULT_PAGES = [
  { name: '普通英文网页（维基百科条目：操作系统）', url: 'https://en.wikipedia.org/wiki/Operating_system', wait: 20000 },
  { name: '长篇技术文章（维基百科：内存管理）', url: 'https://en.wikipedia.org/wiki/Memory_management', wait: 20000 },
  { name: 'GitHub 仓库页面', url: 'https://github.com/microsoft/vscode', wait: 25000 },
  { name: 'Stack Overflow 问题页', url: 'https://stackoverflow.com/questions/927358/how-do-i-undo-the-most-recent-local-commits-in-git', wait: 25000 },
];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class CDP {
  constructor(url) {
    this.url = url;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
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
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      for (const handler of this.listeners.get(msg.method) || []) {
        try {
          handler(msg.params, msg.sessionId);
        } catch {
          /* ignore */
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
      }, 120000);
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

const evaluate = async (cdp, sessionId, expression) => {
  const { result, exceptionDetails } = await cdp.send(
    'Runtime.evaluate',
    { expression, awaitPromise: true, returnByValue: true },
    sessionId,
  );
  if (exceptionDetails) throw new Error(exceptionDetails.exception?.description || exceptionDetails.text || '脚本异常');
  return result.value;
};

async function main() {
  const exe = process.env.ABT_BROWSER || CANDIDATES.find((p) => existsSync(p));
  if (!exe) throw new Error('未找到浏览器');

  const urls = process.argv.slice(2).filter((arg) => /^https?:/.test(arg));
  const pages = urls.length ? urls.map((url) => ({ name: url, url, wait: 25000 })) : DEFAULT_PAGES;

  const profile = await mkdtemp(path.join(tmpdir(), 'abt-pages-'));
  const args = ['--no-first-run', '--no-default-browser-check', '--disable-features=DisableLoadExtensionCommandLineSwitch', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`, `--load-extension=${ROOT}`, '--disable-extensions-except=' + ROOT];
  if (!HEADED) args.push('--headless=new', '--disable-gpu');
  else args.push('--window-position=-32000,-32000', '--window-size=1200,800');
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: 'ignore' });

  let wsUrl = null;
  for (let i = 0; i < 60 && !wsUrl; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) wsUrl = (await res.json()).webSocketDebuggerUrl;
    } catch {
      /* 等待启动 */
    }
    if (!wsUrl) await sleep(300);
  }
  if (!wsUrl) throw new Error('浏览器调试端口未就绪');

  const cdp = new CDP(wsUrl);
  await cdp.connect();

  const report = { browser: path.basename(exe), pages: [], ok: true };
  try {
    // 找本扩展的 Service Worker
    let worker = null;
    for (let i = 0; i < 80 && !worker; i += 1) {
      const { targetInfos } = await cdp.send('Target.getTargets');
      worker = targetInfos.find((t) => t.type === 'service_worker' && String(t.url).endsWith('/src/background/service-worker.js'));
      if (!worker) await sleep(300);
    }
    if (!worker) throw new Error('扩展未加载（找不到 Service Worker）');
    const extensionId = new URL(worker.url).host;
    report.extensionId = extensionId;

    // 打开设置页（有扩展权限，可以调 chrome.tabs / chrome.runtime）
    const { targetId: optionsTarget } = await cdp.send('Target.createTarget', { url: `chrome-extension://${extensionId}/src/options/options.html` });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: optionsTarget, flatten: true });
    await cdp.send('Runtime.enable', {}, sessionId);
    await sleep(1500);

    // 缩小测试规模：每次只翻 12 块、关懒加载（否则维基百科那种页面要翻几分钟）
    const patched = await evaluate(
      cdp,
      sessionId,
      `(async () => {
        const s = await chrome.runtime.sendMessage({ v: 1, type: 'settings.get', id: 'p0', payload: {} });
        const before = { maxBlocks: s.payload.settings.page.maxBlocks, lazyLoad: s.payload.settings.page.lazyLoad };
        await chrome.runtime.sendMessage({ v: 1, type: 'settings.patch', id: 'p1', payload: { patch: { page: { maxBlocks: 12, lazyLoad: false } } } });
        return JSON.stringify(before);
      })()`,
    );
    report.patchedFrom = JSON.parse(patched);

    for (const page of pages) {
      const entry = { name: page.name, url: page.url };
      try {
        const tabInfo = await evaluate(
          cdp,
          sessionId,
          `(async () => {
            const tab = await chrome.tabs.create({ url: ${JSON.stringify(page.url)}, active: true });
            return JSON.stringify({ id: tab.id });
          })()`,
        );
        const tabId = JSON.parse(tabInfo).id;
        entry.tabId = tabId;

        // 等页面加载完
        for (let i = 0; i < 60; i += 1) {
          const status = await evaluate(cdp, sessionId, `chrome.tabs.get(${tabId}).then((t) => t.status).catch(() => 'unknown')`);
          if (status === 'complete') break;
          await sleep(1000);
        }
        await sleep(2500);

        // 触发整页翻译
        const callTranslate = () =>
          evaluate(
            cdp,
            sessionId,
            `chrome.tabs.sendMessage(${tabId}, { v: 1, type: 'page.translate', id: 'pt', payload: {} })
               .then((r) => JSON.stringify(r))
               .catch((e) => 'ERR:' + e.message)`,
          );
        let started = await callTranslate();
        // 有些站点（如 Stack Overflow）首屏是骨架/占位，正文晚到；没找到块就等一会儿再来一次
        if (String(started).includes('NOTHING_TO_TRANSLATE')) {
          await sleep(6000);
          started = await callTranslate();
        }
        entry.translateCall = String(started).slice(0, 120);

        // 轮询进度
        let state = null;
        const deadline = Date.now() + Math.max(page.wait, 45000);
        while (Date.now() < deadline) {
          await sleep(2000);
          state = await evaluate(
            cdp,
            sessionId,
            `chrome.tabs.sendMessage(${tabId}, { v: 1, type: 'page.state', id: 'ps', payload: {} })
               .then((r) => JSON.stringify(r.payload?.page || null))
               .catch(() => 'null')`,
          );
          const parsed = JSON.parse(state || 'null');
          if (parsed && parsed.stats && parsed.stats.done + parsed.stats.failed >= Math.min(parsed.stats.total, 12) && parsed.stats.total > 0) break;
        }
        entry.page = JSON.parse(state || 'null');

        // 读页面 DOM：译了多少块、代码块是否被误译、抽一条译文
        const { targetInfos } = await cdp.send('Target.getTargets');
        const target = targetInfos.find((t) => t.type === 'page' && String(t.url).startsWith(page.url.split('?')[0].slice(0, 60)));
        if (!target) {
          entry.domError = '找不到页面标签目标';
        } else {
          const { sessionId: pageSession } = await cdp.send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
          await cdp.send('Runtime.enable', {}, pageSession);
          entry.dom = await evaluate(
            cdp,
            pageSession,
            `(() => {
              const blocks = document.querySelectorAll('[data-abt-block]');
              const trans = document.querySelectorAll('.abt-trans');
              const codeTouched = document.querySelectorAll('pre [data-abt-block], code [data-abt-block], pre .abt-trans, code .abt-trans').length;
              const samples = Array.from(trans).map((el) => el.innerText.trim()).filter(Boolean).slice(0, 3);
              return { blocks: blocks.length, translations: trans.length, codeTouched, samples, title: document.title.slice(0, 80) };
            })()`,
          ).catch((error) => ({ error: error.message }));
          await cdp.send('Target.detachFromTarget', { sessionId: pageSession }).catch(() => {});
        }

        // 还原页面，保持环境干净
        await evaluate(cdp, sessionId, `chrome.tabs.sendMessage(${tabId}, { v: 1, type: 'page.restore', id: 'pr', payload: {} }).catch(() => null)`);
        entry.ok = Boolean(entry.page && entry.page.stats && entry.page.stats.done > 0);
      } catch (error) {
        entry.error = error.message;
        entry.ok = false;
      }
      if (!entry.ok) report.ok = false;
      report.pages.push(entry);
      process.stdout.write(`- ${entry.name}: ${entry.ok ? 'OK' : 'FAIL'} ${entry.error || ''}\n`);
    }

    // 恢复设置
    await evaluate(
      cdp,
      sessionId,
      `chrome.runtime.sendMessage({ v: 1, type: 'settings.patch', id: 'p2', payload: { patch: { page: ${JSON.stringify({ maxBlocks: report.patchedFrom.maxBlocks, lazyLoad: report.patchedFrom.lazyLoad })} } } })`,
    ).catch(() => {});
  } finally {
    cdp.close();
    child.kill();
  }

  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

await main();