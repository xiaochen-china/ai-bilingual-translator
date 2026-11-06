/**
 * 设置页逻辑。
 *
 * 绑定约定：
 *  - 普通设置项用 `data-setting="a.b.c"` 声明，读写 settings 的深路径；
 *    修改后 350ms 防抖合并成一次 settings.patch。
 *  - 引擎参数用 `data-engine-setting="<engineId>.<field>"`，
 *    只在点击「保存引擎配置」时提交，避免每敲一个字符就写一次。
 *  - API Key 永远不写入 settings，只通过 settings.patch 的 apiKey/engineId/persistKey 字段转交后台。
 */

import { PROFILES, PROFILE_LABELS, SOURCE_LANGS, TARGET_LANGS } from '../common/constants.js';
import { formatTime, send, toast } from '../ui/common.js';

const $ = (id) => document.getElementById(id);

const state = {
  settings: null,
  engines: [],
  keyStatus: {},
  wordbook: [],
  pendingPatch: null,
  patchTimer: null,
};

/* ------------------------------------------------------------------ */
/* 深路径工具                                                          */
/* ------------------------------------------------------------------ */

function getPath(object, path) {
  return String(path)
    .split('.')
    .reduce((acc, key) => (acc == null ? undefined : acc[key]), object);
}

function setPath(object, path, value) {
  const keys = String(path).split('.');
  const last = keys.pop();
  let cursor = object;
  for (const key of keys) {
    if (typeof cursor[key] !== 'object' || cursor[key] === null) cursor[key] = {};
    cursor = cursor[key];
  }
  cursor[last] = value;
  return object;
}

/* ------------------------------------------------------------------ */
/* 设置读取与控件绑定                                                  */
/* ------------------------------------------------------------------ */

function isNumericString(value) {
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

/** 读取控件当前值，并按控件类型转换 */
function readControl(element) {
  if (element.type === 'checkbox') return element.checked;
  if (element.tagName === 'SELECT') {
    const value = element.value;
    // 像字重 400/500/600 这种数值选项要存成数字，而不是字符串
    const numeric = [...element.options].every((option) => option.value === '' || isNumericString(option.value));
    return numeric && isNumericString(value) ? Number(value) : value;
  }
  if (element.type === 'number' || element.type === 'range') {
    const value = Number(element.value);
    return Number.isFinite(value) ? value : 0;
  }
  return element.value;
}

/** 把设置值写回控件 */
function writeControl(element, value) {
  if (element.type === 'checkbox') {
    element.checked = Boolean(value);
    return;
  }
  element.value = value == null ? '' : String(value);
}

function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof target[key] !== 'object' || target[key] === null) target[key] = {};
      mergeInto(target[key], value);
    } else {
      target[key] = value;
    }
  }
}

/** 把一次修改并入待提交的 patch（350ms 内多次修改只发一次请求） */
function queuePatch(path, value) {
  if (!state.pendingPatch) state.pendingPatch = {};
  const temp = {};
  setPath(temp, path, value);
  mergeInto(state.pendingPatch, temp);
  clearTimeout(state.patchTimer);
  state.patchTimer = setTimeout(() => {
    flushPatch().catch((error) => toast(error.message || '保存失败', 'error'));
  }, 350);
}

async function flushPatch() {
  if (!state.pendingPatch) return;
  const patch = state.pendingPatch;
  state.pendingPatch = null;
  try {
    const res = await send('settings.patch', { patch });
    state.settings = res.settings;
    renderPreview();
  } catch (error) {
    toast(error.message || '保存失败', 'error');
  }
}

/** 绑定所有 [data-setting] 控件 */
function bindGenericSettings() {
  for (const element of document.querySelectorAll('[data-setting]')) {
    const path = element.dataset.setting;
    writeControl(element, getPath(state.settings, path));
    const eventName = element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input';
    element.addEventListener(eventName, () => {
      const value = readControl(element);
      queuePatch(path, value);
      if (path.startsWith('style.')) renderPreview();
    });
  }
}

/* ------------------------------------------------------------------ */
/* 引擎                                                                */
/* ------------------------------------------------------------------ */

function engineById(engineId) {
  return state.engines.find((engine) => engine.id === engineId) || null;
}

function fillSelect(select, items, { placeholder = '' } = {}) {
  select.textContent = '';
  if (placeholder) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = placeholder;
    select.append(option);
  }
  for (const item of items) {
    const option = document.createElement('option');
    option.value = item.value ?? item.code ?? item.id;
    option.textContent = item.label ?? item.name ?? option.value;
    select.append(option);
  }
}

function renderEnginePicker() {
  const picker = $('engine-picker');
  fillSelect(
    picker,
    state.engines.map((engine) => ({
      value: engine.id,
      label: `${engine.name}${engine.requiresKey ? '（需 API Key）' : '（免费）'}`,
    })),
  );
  picker.value = state.settings.engineId;
  showEnginePanel(picker.value);
}

function showEnginePanel(engineId) {
  for (const panel of document.querySelectorAll('[data-engine-panel]')) {
    panel.hidden = panel.dataset.enginePanel !== engineId;
  }
  loadEngineFields(engineId);
  renderKeyStatus(engineId);
}

function loadEngineFields(engineId) {
  for (const element of document.querySelectorAll('[data-engine-setting]')) {
    const [id, field] = element.dataset.engineSetting.split('.');
    if (id !== engineId) continue;
    writeControl(element, getPath(state.settings.engines || {}, `${id}.${field}`));
  }
  $('api-key').value = '';
  $('persist-key').checked = false;
}

function renderKeyStatus(engineId) {
  const badge = $('key-status');
  const source = $('key-source');
  const engine = engineById(engineId);
  const status = state.keyStatus?.[engineId] || { hasKey: false, source: 'none' };

  if (!engine?.requiresKey) {
    badge.textContent = '不需要密钥';
    badge.className = 'badge ok';
    source.textContent = '该引擎使用公共免费接口';
    return;
  }
  if (!status.hasKey) {
    badge.textContent = '未设置';
    badge.className = 'badge err';
    source.textContent = '需要 API Key 才能使用';
    return;
  }
  badge.textContent = status.source === 'persisted' ? '已保存（持久化）' : '已保存（本会话）';
  badge.className = 'badge ok';
  source.textContent =
    status.source === 'persisted'
      ? '密钥已写入本地存储，关闭浏览器后仍有效'
      : '仅本次浏览器会话有效，关闭浏览器后自动清除';
}

/** 收集当前引擎面板里的参数 */
function collectEngineFields(engineId) {
  const fields = {};
  for (const element of document.querySelectorAll('[data-engine-setting]')) {
    const [id, field] = element.dataset.engineSetting.split('.');
    if (id !== engineId) continue;
    const value = readControl(element);
    if (element.tagName === 'SELECT' && value === '') continue;
    fields[field] = value;
  }
  return fields;
}

async function saveEngine({ silent = false } = {}) {
  const engineId = $('engine-picker').value;
  const fields = collectEngineFields(engineId);
  const apiKey = $('api-key').value.trim();
  const persistKey = $('persist-key').checked;

  const payload = { patch: { engines: { [engineId]: fields } }, engineId, persistKey };
  if (apiKey) payload.apiKey = apiKey;

  const res = await send('settings.patch', payload);
  state.settings = res.settings;
  state.keyStatus = await refreshKeyStatus();
  $('api-key').value = '';
  renderKeyStatus(engineId);
  if (!silent) toast(apiKey ? '引擎已保存，密钥已更新' : '引擎配置已保存', 'success');
}

async function refreshKeyStatus() {
  try {
    const res = await send('settings.get');
    return res.keyStatus || {};
  } catch {
    return state.keyStatus || {};
  }
}

async function testEngine() {
  const result = $('engine-test-result');
  const engineId = $('engine-picker').value;
  result.textContent = '测试中…';
  try {
    // 先保存参数，避免「测试的配置」和「保存的配置」不一致
    await saveEngine({ silent: true });
    const res = await send('engine.test', { engineId }, { timeoutMs: 60000 });
    result.textContent = `连接成功 · ${res.latencyMs}ms · 返回“${res.sample}”`;
    toast('连接成功', 'success');
  } catch (error) {
    result.textContent = `失败：${error.message || error.code}`;
    toast(error.message || '连接失败', 'error');
  }
}

async function clearEngineKey() {
  const engineId = $('engine-picker').value;
  const name = engineById(engineId)?.name || engineId;
  if (!window.confirm(`确定清除「${name}」的 API Key 吗？`)) return;
  try {
    const res = await send('settings.patch', { patch: {}, engineId, apiKey: '' });
    state.settings = res.settings;
    state.keyStatus = await refreshKeyStatus();
    renderKeyStatus(engineId);
    toast('密钥已清除', 'success');
  } catch (error) {
    toast(error.message || '清除失败', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 术语表与站点规则                                                    */
/* ------------------------------------------------------------------ */

function makeRemoveButton(onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn small ghost';
  button.textContent = '删';
  button.title = '删除该行';
  button.addEventListener('click', onClick);
  return button;
}

function createCell(...children) {
  const cell = document.createElement('td');
  for (const child of children) cell.append(child);
  return cell;
}

function createInput(field, placeholder, value = '') {
  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.placeholder = placeholder;
  input.dataset.field = field;
  return input;
}

function renderGlossary() {
  const body = $('glossary-body');
  body.textContent = '';
  const glossary = state.settings.glossary || [];

  if (!glossary.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 4;
    cell.className = 'hint';
    cell.textContent = '暂无术语。点击下方「＋ 添加术语」新增。';
    row.append(cell);
    body.append(row);
    return;
  }

  for (const entry of glossary) {
    const row = document.createElement('tr');
    row.dataset.en = entry.en;
    row.append(
      createCell(createInput('en', 'Register', entry.en)),
      createCell(createInput('zh', '寄存器', entry.zh)),
      createCell(createInput('note', '可选说明', entry.note)),
      createCell(makeRemoveButton(() => row.remove())),
    );
    body.append(row);
  }
}

function collectGlossary() {
  const rows = [...$('glossary-body').querySelectorAll('tr[data-en]')];
  const glossary = [];
  for (const row of rows) {
    const en = row.querySelector('[data-field="en"]').value.trim();
    const zh = row.querySelector('[data-field="zh"]').value.trim();
    const note = row.querySelector('[data-field="note"]').value.trim();
    if (!en && !zh) continue; // 整行留空视为删除
    if (!en || !zh) {
      toast('术语的英文和中文都不能为空', 'error');
      return null;
    }
    glossary.push(note ? { en, zh, note } : { en, zh });
  }
  return glossary;
}

async function saveGlossary() {
  const glossary = collectGlossary();
  if (!glossary) return;
  try {
    const res = await send('settings.patch', { patch: { glossary } });
    state.settings = res.settings;
    renderGlossary();
    toast(`已保存 ${glossary.length} 条术语`, 'success');
  } catch (error) {
    toast(error.message || '保存失败', 'error');
  }
}

function addGlossaryRow() {
  const body = $('glossary-body');
  // 占位行要先清掉，否则新行会插在提示文字后面
  if (body.querySelector('td[colspan]')) body.textContent = '';
  const row = document.createElement('tr');
  row.dataset.en = '';
  row.append(
    createCell(createInput('en', 'Register')),
    createCell(createInput('zh', '寄存器')),
    createCell(createInput('note', '可选说明')),
    createCell(makeRemoveButton(() => row.remove())),
  );
  body.append(row);
  row.querySelector('[data-field="en"]').focus();
}

const RULE_LABELS = { auto: '自动翻译', ask: '每次询问', never: '永不翻译' };

function renderSiteRules() {
  const body = $('site-body');
  body.textContent = '';
  const rules = state.settings.siteRules || {};
  const entries = Object.entries(rules);

  if (!entries.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 3;
    cell.className = 'hint';
    cell.textContent = '暂无站点规则，所有站点都按「翻译行为」里的默认设置执行。';
    row.append(cell);
    body.append(row);
    return;
  }

  for (const [hostname, rule] of entries) {
    const row = document.createElement('tr');

    const hostCell = document.createElement('td');
    hostCell.textContent = hostname;
    hostCell.className = 'mono';

    const select = document.createElement('select');
    for (const [value, label] of Object.entries(RULE_LABELS)) {
      const option = document.createElement('option');
      option.value = value;
      option.textContent = label;
      select.append(option);
    }
    select.value = rule;
    select.addEventListener('change', async () => {
      try {
        await send('site.rule.set', { hostname, rule: select.value });
        state.settings.siteRules[hostname] = select.value;
        toast('站点规则已更新', 'success');
      } catch (error) {
        toast(error.message || '更新失败', 'error');
        renderSiteRules();
      }
    });

    const actionCell = document.createElement('td');
    actionCell.append(
      makeRemoveButton(async () => {
        try {
          await send('site.rule.set', { hostname, rule: null });
          delete state.settings.siteRules[hostname];
          renderSiteRules();
          toast('已删除站点规则', 'success');
        } catch (error) {
          toast(error.message || '删除失败', 'error');
        }
      }),
    );

    row.append(hostCell, createCell(select), actionCell);
    body.append(row);
  }
}

async function addSiteRule() {
  const input = $('site-host');
  const hostname = input.value
    .trim()
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  if (!hostname) {
    toast('请输入域名', 'error');
    return;
  }
  try {
    const rule = $('site-rule').value;
    await send('site.rule.set', { hostname, rule });
    if (!state.settings.siteRules) state.settings.siteRules = {};
    state.settings.siteRules[hostname] = rule;
    input.value = '';
    renderSiteRules();
    toast('已添加站点规则', 'success');
  } catch (error) {
    toast(error.message || '添加失败', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 样式预览                                                            */
/* ------------------------------------------------------------------ */

function renderPreview() {
  const style = state.settings.style || {};
  const preview = $('preview-trans');
  if (!preview) return;

  const dark = window.matchMedia('(prefers-color-scheme: dark)').matches;
  const accent = (dark && style.darkColor) || style.color || '#1a73e8';
  preview.style.color = accent;
  preview.style.fontSize = `${(Number(style.fontScale) || 1) * 15}px`;
  preview.style.fontWeight = String(style.fontWeight || 400);
  preview.style.lineHeight = String(style.lineHeight || 1.5);
  preview.style.marginTop = `${Number(style.paragraphGap) || 0}px`;
  preview.style.paddingLeft = style.showDivider ? '8px' : '0';
  preview.style.borderLeft = style.showDivider ? `3px solid ${accent}` : 'none';
  preview.style.wordBreak = 'break-word';

  const label = $('font-scale-label');
  if (label) label.textContent = `${(Number(style.fontScale) || 1).toFixed(2)}×`;
}

/* ------------------------------------------------------------------ */
/* 生词本                                                              */
/* ------------------------------------------------------------------ */

async function refreshWordbook() {
  try {
    const res = await send('wordbook.list');
    state.wordbook = res.items || [];
    renderWordbook();
  } catch (error) {
    toast(error.message || '读取生词本失败', 'error');
  }
}

function renderWordbook() {
  const filter = $('wordbook-filter').value.trim().toLowerCase();
  const body = $('wordbook-body');
  body.textContent = '';

  const items = filter
    ? state.wordbook.filter(
        (item) =>
          String(item.text || '').toLowerCase().includes(filter) ||
          String(item.translation || '').toLowerCase().includes(filter),
      )
    : state.wordbook;

  $('wordbook-count').textContent = `${items.length} 条`;

  if (!items.length) {
    const row = document.createElement('tr');
    const cell = document.createElement('td');
    cell.colSpan = 5;
    cell.className = 'hint';
    cell.textContent = filter ? '没有匹配的生词。' : '生词本还是空的，去网页上选中英文试试划词查询吧。';
    row.append(cell);
    body.append(row);
    return;
  }

  for (const item of items) {
    const row = document.createElement('tr');

    const textCell = document.createElement('td');
    textCell.textContent = item.text || '';
    textCell.title = item.text || '';

    const translationCell = document.createElement('td');
    translationCell.textContent = item.translation || '';

    const posCell = document.createElement('td');
    posCell.textContent = item.pos || '-';

    const timeCell = document.createElement('td');
    timeCell.className = 'hint';
    timeCell.textContent = item.createdAt ? formatTime(item.createdAt) : '-';

    const actionCell = document.createElement('td');
    actionCell.append(
      makeRemoveButton(async () => {
        try {
          const res = await send('wordbook.remove', { id: item.id });
          state.wordbook = res.items || [];
          renderWordbook();
          toast('已移除', 'success');
        } catch (error) {
          toast(error.message || '移除失败', 'error');
        }
      }),
    );

    row.append(textCell, translationCell, posCell, timeCell, actionCell);
    body.append(row);
  }
}

async function clearWordbook() {
  if (!window.confirm('确定清空整个生词本吗？该操作不可恢复。')) return;
  try {
    for (const item of [...state.wordbook]) {
      await send('wordbook.remove', { id: item.id });
    }
    await refreshWordbook();
    toast('生词本已清空', 'success');
  } catch (error) {
    toast(error.message || '清空失败', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 导入导出                                                            */
/* ------------------------------------------------------------------ */

function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickJson(callback) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener('load', () => {
      try {
        callback(JSON.parse(String(reader.result || '[]')));
      } catch {
        toast('文件不是合法 JSON', 'error');
      }
    });
    reader.readAsText(file);
  });
  input.click();
}

function exportGlossary() {
  downloadJson('abt-glossary.json', state.settings.glossary || []);
  toast('术语表已导出', 'success');
}

function importGlossary() {
  pickJson((data) => {
    const list = Array.isArray(data) ? data : data?.glossary;
    if (!Array.isArray(list)) {
      toast('JSON 中缺少术语数组', 'error');
      return;
    }
    const merged = [...(state.settings.glossary || [])];
    const seen = new Set(merged.map((entry) => String(entry.en).toLowerCase()));
    let added = 0;
    for (const item of list) {
      if (!item || typeof item.en !== 'string' || typeof item.zh !== 'string') continue;
      const key = item.en.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push({ en: item.en, zh: item.zh, note: item.note ? String(item.note) : undefined });
      added += 1;
    }
    state.settings.glossary = merged;
    renderGlossary();
    saveGlossary().then(() => toast(`已导入 ${added} 条术语`, 'success'));
  });
}

function exportWordbook() {
  downloadJson('abt-wordbook.json', state.wordbook);
  toast('生词本已导出', 'success');
}

function importWordbook() {
  pickJson(async (data) => {
    const list = Array.isArray(data) ? data : data?.items;
    if (!Array.isArray(list)) {
      toast('JSON 中缺少生词数组', 'error');
      return;
    }
    let added = 0;
    for (const item of list) {
      if (!item || typeof item.text !== 'string' || !item.text.trim()) continue;
      try {
        const res = await send('wordbook.add', {
          text: item.text,
          translation: item.translation || '',
          pos: item.pos || '',
          note: item.note || '',
          url: item.url || '',
        });
        if (!res.duplicate) added += 1;
      } catch {
        // 单条失败不影响其余导入
      }
    }
    await refreshWordbook();
    toast(`导入完成，新增 ${added} 条`, 'success');
  });
}

/* ------------------------------------------------------------------ */
/* 缓存与数据                                                          */
/* ------------------------------------------------------------------ */

async function refreshCacheStats() {
  const badge = $('cache-badge');
  badge.textContent = '统计中…';
  try {
    const res = await send('cache.stats');
    const driver = res.driver === 'indexeddb' ? 'IndexedDB' : '内存';
    badge.textContent = `已缓存 ${res.count} 条翻译（${driver}）`;
    badge.className = 'badge';
  } catch (error) {
    badge.textContent = '缓存不可用';
    badge.className = 'badge err';
    console.warn('[ABT] cache.stats 失败', error);
  }
}

async function clearCache() {
  try {
    await send('cache.clear');
    await refreshCacheStats();
    toast('翻译缓存已清空', 'success');
  } catch (error) {
    toast(error.message || '清空失败', 'error');
  }
}

async function clearAllData() {
  if (!window.confirm('确定清除全部本地数据吗？（设置、密钥、生词本、历史记录）')) return;
  try {
    await send('settings.reset');
    await send('cache.clear');
    await send('history.clear');
    for (const item of [...state.wordbook]) {
      try {
        await send('wordbook.remove', { id: item.id });
      } catch {
        // 忽略单条失败
      }
    }
    await reloadSettings();
    await refreshWordbook();
    toast('已清除全部本地数据', 'success');
  } catch (error) {
    toast(error.message || '清除失败', 'error');
  }
}

/* ------------------------------------------------------------------ */
/* 侧边栏                                                              */
/* ------------------------------------------------------------------ */

async function openSidepanel() {
  try {
    const win = await chrome.windows.getCurrent();
    await chrome.sidePanel.setOptions({ path: 'src/sidepanel/sidepanel.html', enabled: true });
    await chrome.sidePanel.open({ windowId: win.id });
  } catch (error) {
    // 部分 Edge 版本不支持 sidePanel.open，降级为新标签页
    console.warn('[ABT] 侧边栏打开失败，降级为标签页', error);
    chrome.tabs.create({ url: chrome.runtime.getURL('src/sidepanel/sidepanel.html') });
  }
}

/* ------------------------------------------------------------------ */
/* 加载与事件绑定                                                      */
/* ------------------------------------------------------------------ */

function fillLangSelects() {
  fillSelect(
    $('default-engine'),
    state.engines.map((engine) => ({ value: engine.id, label: engine.name })),
  );
  $('default-engine').value = state.settings.engineId;

  fillSelect(
    $('source-lang'),
    SOURCE_LANGS.map((lang) => ({ value: lang.code, label: lang.label })),
  );
  $('source-lang').value = state.settings.sourceLang;

  fillSelect(
    $('target-lang'),
    TARGET_LANGS.map((lang) => ({ value: lang.code, label: lang.label })),
  );
  $('target-lang').value = state.settings.targetLang;

  fillSelect(
    $('profile-select'),
    Object.values(PROFILES).map((profile) => ({ value: profile, label: PROFILE_LABELS[profile] })),
  );
  $('profile-select').value = state.settings.profile;

  fillSelect(
    $('lookup-engine'),
    state.engines.map((engine) => ({ value: engine.id, label: engine.name })),
    { placeholder: '跟随默认引擎' },
  );
  $('lookup-engine').value = state.settings.lookup?.engineId || '';
}

async function reloadSettings() {
  const res = await send('settings.get');
  state.settings = res.settings;
  state.engines = res.engines || [];
  state.keyStatus = res.keyStatus || {};

  $('version-badge').textContent = `v${chrome.runtime.getManifest().version}`;

  fillLangSelects();
  $('auto-translate').checked = Boolean(state.settings.autoTranslate);
  $('custom-prompt').value = state.settings.customPrompt || '';

  bindGenericSettings();
  renderEnginePicker();
  renderGlossary();
  renderSiteRules();
  renderPreview();
}

function bindFixedControls() {
  $('default-engine').addEventListener('change', (event) => {
    const engineId = event.target.value;
    queuePatch('engineId', engineId);
    $('engine-picker').value = engineId;
    showEnginePanel(engineId);
  });

  $('source-lang').addEventListener('change', (event) => queuePatch('sourceLang', event.target.value));
  $('target-lang').addEventListener('change', (event) => queuePatch('targetLang', event.target.value));
  $('profile-select').addEventListener('change', (event) => queuePatch('profile', event.target.value));
  $('auto-translate').addEventListener('change', (event) => queuePatch('autoTranslate', event.target.checked));
  $('custom-prompt').addEventListener('input', (event) => queuePatch('customPrompt', event.target.value));
  $('lookup-engine').addEventListener('change', (event) => queuePatch('lookup.engineId', event.target.value));

  $('engine-picker').addEventListener('change', (event) => showEnginePanel(event.target.value));
  $('btn-save-engine').addEventListener('click', () => {
    saveEngine().catch((error) => toast(error.message || '保存失败', 'error'));
  });
  $('btn-test-engine').addEventListener('click', () => {
    testEngine().catch((error) => toast(error.message || '测试失败', 'error'));
  });
  $('btn-clear-key').addEventListener('click', () => clearEngineKey());
  $('btn-toggle-key').addEventListener('click', () => {
    const input = $('api-key');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('btn-toggle-key').textContent = show ? '隐藏' : '显示';
  });

  $('btn-add-glossary').addEventListener('click', addGlossaryRow);
  $('btn-save-glossary').addEventListener('click', () => saveGlossary());
  $('btn-export-glossary').addEventListener('click', exportGlossary);
  $('btn-import-glossary').addEventListener('click', importGlossary);
  $('btn-add-site').addEventListener('click', addSiteRule);
  $('site-host').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addSiteRule();
  });

  $('wordbook-filter').addEventListener('input', renderWordbook);
  $('btn-wordbook-refresh').addEventListener('click', () => refreshWordbook());
  $('btn-wordbook-export').addEventListener('click', exportWordbook);
  $('btn-wordbook-import').addEventListener('click', importWordbook);
  $('btn-wordbook-clear').addEventListener('click', () => clearWordbook());
  $('btn-open-sidepanel').addEventListener('click', () => openSidepanel());

  $('btn-refresh-cache').addEventListener('click', () => refreshCacheStats());
  $('btn-clear-cache').addEventListener('click', () => clearCache());
  $('btn-clear-all').addEventListener('click', () => clearAllData());
}

async function init() {
  try {
    await reloadSettings();
    bindFixedControls();
    await refreshWordbook();
    await refreshCacheStats();
  } catch (error) {
    console.error('[ABT] 设置页初始化失败', error);
    toast(error.message || '设置页加载失败，请重新打开', 'error');
  }
}

init();