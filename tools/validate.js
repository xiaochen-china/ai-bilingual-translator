/**
 * 静态自检：在不开浏览器的情况下尽可能提前发现问题。
 *
 * 检查项：
 *  1. manifest.json 引用的每个文件/图标都存在
 *  2. 每个 JS 文件都能通过语法解析（含 ESM 的导入解析）
 *  3. 没有把 API Key 硬编码进源码
 *  4. 内容脚本不接触 chrome.storage / API Key / fetch 第三方域名
 *  5. 关键约定（协议版本、消息类型、内容脚本顺序）仍然一致
 *
 * 用法：npm run validate
 */

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const failures = [];
const notes = [];

function fail(message) {
  failures.push(message);
}

function ok(message) {
  notes.push(message);
}

async function walk(dir, exts) {
  const out = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist') continue;
      out.push(...(await walk(full, exts)));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

/* ---------------- 1. manifest ---------------- */

const manifestPath = path.join(ROOT, 'manifest.json');
const manifestRaw = await readFile(manifestPath, 'utf8');
let manifest;
try {
  manifest = JSON.parse(manifestRaw);
} catch (error) {
  fail(`manifest.json 不是合法 JSON：${error.message}`);
}

if (manifest) {
  if (manifest.manifest_version !== 3) fail('manifest_version 必须是 3');
  if (!/^\d+\.\d+\.\d+$/.test(manifest.version || '')) fail(`version 格式不合法：${manifest.version}`);

  const referenced = new Set();
  if (manifest.background?.service_worker) referenced.add(manifest.background.service_worker);
  if (manifest.action?.default_popup) referenced.add(manifest.action.default_popup);
  if (manifest.options_ui?.page) referenced.add(manifest.options_ui.page);
  if (manifest.side_panel?.default_path) referenced.add(manifest.side_panel.default_path);
  for (const icon of Object.values(manifest.icons || {})) referenced.add(icon);
  for (const icon of Object.values(manifest.action?.default_icon || {})) referenced.add(icon);
  for (const script of manifest.content_scripts || []) {
    for (const file of script.js || []) referenced.add(file);
    for (const file of script.css || []) referenced.add(file);
  }
  for (const item of manifest.web_accessible_resources || []) {
    for (const file of item.resources || []) if (!file.includes('*')) referenced.add(file);
  }

  for (const file of referenced) {
    if (!existsSync(path.join(ROOT, file))) fail(`manifest 引用的文件不存在：${file}`);
  }
  ok(`manifest 引用的 ${referenced.size} 个文件全部存在`);

  const order = (manifest.content_scripts?.[0]?.js || []).map((file) => path.basename(file));
  const expected = ['core.js', 'page-translator.js', 'selection.js', 'subtitles.js', 'main.js'];
  if (order.join(',') !== expected.join(',')) fail(`内容脚本顺序异常：${order.join(' → ')}`);

  if (manifest.background?.type !== 'module') fail('后台 service worker 必须声明 type: "module"');
  if (!manifest.permissions?.includes('storage')) fail('缺少 storage 权限');
  if (!manifest.permissions?.includes('scripting')) fail('缺少 scripting 权限');
  if (manifest.host_permissions?.includes('<all_urls>')) fail('host_permissions 不应使用 <all_urls>（权限最小化）');
  ok(`权限：${(manifest.permissions || []).join(', ')}`);
}

/* ---------------- 2. 语法解析 ---------------- */

const files = await walk(ROOT, ['.js']);

// 用 `node --check` 做语法解析：它会根据 package.json 的 "type": "module"
// 选择模块目标，既能检查 ESM 也能检查传统脚本，且不会真的执行代码。
for (const file of files) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    const detail = (result.stderr || result.stdout || '').trim().split('\n').slice(0, 6).join('\n');
    fail(`${relative} 语法检查失败：\n${detail}`);
  }
}
ok(`已通过 ${files.length} 个 JS 文件的语法检查`);

/* ---------------- 3/4. 密钥与内容脚本隔离 ---------------- */

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{16,}/, // OpenAI 风格
  /\bAIza[0-9A-Za-z_-]{20,}/, // Google API Key
  /\bBearer\s+[A-Za-z0-9._-]{20,}/, // 写死的 Bearer Token
  /\bfx-[a-f0-9]{8}-[a-f0-9]{4}/i, // DeepL Pro Key
];

for (const file of files) {
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  if (relative.startsWith('tests/') || relative.startsWith('tools/')) continue;
  const code = await readFile(file, 'utf8');
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(code)) fail(`${relative} 疑似包含硬编码密钥（匹配 ${pattern}）`);
  }
  if (relative.startsWith('src/content/')) {
    if (/chrome\.storage/.test(code)) fail(`${relative} 不应直接访问 chrome.storage（应通过消息协议）`);
    if (/apiKey\s*[:=]\s*['"][^'"]+['"]/.test(code)) fail(`${relative} 不应包含 API Key 字面量`);
    if (/fetch\(\s*['"`]https?:\/\//.test(code)) fail(`${relative} 不应直接 fetch 第三方域名`);
  }
}
ok('未发现硬编码密钥或内容脚本越权访问');

/* ---------------- 5. 约定一致性 ---------------- */

const constants = await readFile(path.join(ROOT, 'src/common/constants.js'), 'utf8');
if (!/PROTOCOL_VERSION\s*=\s*1/.test(constants)) fail('PROTOCOL_VERSION 应为 1');
for (const key of ['translate', 'settings.get', 'page.translate', 'subtitle.cues', 'word.lookup']) {
  if (!constants.includes(`'${key}'`)) fail(`constants.js 缺少消息类型 ${key}`);
}

const sw = await readFile(path.join(ROOT, 'src/background/service-worker.js'), 'utf8');
if (!/sendResponse/.test(sw)) fail('service worker 必须通过 sendResponse 回包');
if (!/return true/.test(sw)) fail('service worker 的 onMessage 监听必须 return true 以支持异步响应');

const contentScripts = await walk(path.join(ROOT, 'src/content'), ['.js']);
for (const file of contentScripts) {
  const code = await readFile(file, 'utf8');
  const relative = path.relative(ROOT, file).replaceAll('\\', '/');
  if (/^\s*(?:import|export)\s/m.test(code)) fail(`${relative} 是内容脚本，不能使用 ESM 语法`);
}
ok(`内容脚本 ${contentScripts.length} 个，均为传统脚本`);

/* ---------------- 结果 ---------------- */

for (const note of notes) console.log(`  ✔ ${note}`);
if (failures.length) {
  console.error(`\n静态自检失败 ${failures.length} 项：`);
  for (const message of failures) console.error(`  ✖ ${message}`);
  process.exit(1);
}
console.log('\n静态自检通过。');