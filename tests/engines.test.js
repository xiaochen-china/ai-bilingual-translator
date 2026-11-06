/**
 * 引擎与解析相关测试：分包、Google 免费接口响应解析、LLM 输出解析、
 * 提示词构造、缓存键、词典 JSON 解析。
 * 全部为纯函数，不需要网络与 chrome API。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { packTexts, flattenBatches } from '../src/background/engines/pack.js';
import { parseGooglePayload } from '../src/background/engines/google-free.js';
import { parseModelOutput } from '../src/background/engines/openai-compatible.js';
import { buildMessages } from '../src/background/engines/llm-prompt.js';
import { buildCacheKey } from '../src/background/cache.js';
import { parseDictionaryJson } from '../src/background/lookup-service.js';
import { PROTECT_TOKEN_SAMPLE } from './helpers.js';

test('packTexts 按条数与字符上限分包，且保持顺序', () => {
  assert.deepEqual(packTexts(['a', 'b', 'c'], 2, 100), [['a', 'b'], ['c']]);
  assert.deepEqual(packTexts(['aaaa', 'bbbb'], 10, 6), [['aaaa'], ['bbbb']]);
  // 单条超限也允许独占一批（避免无限切分）
  assert.deepEqual(packTexts(['x'.repeat(50)], 10, 10), [['x'.repeat(50)]]);
  assert.deepEqual(packTexts([], 10, 10), []);
});

test('flattenBatches 按原顺序拍平', () => {
  assert.deepEqual(flattenBatches([['a', 'b'], ['c']]), ['a', 'b', 'c']);
  assert.deepEqual(flattenBatches([]), []);
});

test('parseGooglePayload 解析单条结果', () => {
  const payload = [[['内核负责管理内存。', 'Kernel manages memory.'], ['设备驱动。', 'Device drivers.']], null, 'en'];
  assert.deepEqual(parseGooglePayload(payload), ['内核负责管理内存。设备驱动。']);
});

test('parseGooglePayload 解析多条结果', () => {
  const payload = [[['第一句', 'First']], [['第二句', 'Second']]];
  assert.deepEqual(parseGooglePayload(payload), ['第一句', '第二句']);
});

test('parseGooglePayload 对异常输入返回空数组', () => {
  assert.deepEqual(parseGooglePayload(null), []);
  assert.deepEqual(parseGooglePayload('oops'), []);
});

test('parseModelOutput 解析纯 JSON 数组', () => {
  assert.deepEqual(parseModelOutput('["甲","乙"]', 2), ['甲', '乙']);
});

test('parseModelOutput 解析 ```json 包裹与 translations 字段', () => {
  const fenced = '```json\n{"translations":["甲","乙"]}\n```';
  assert.deepEqual(parseModelOutput(fenced, 2), ['甲', '乙']);
});

test('parseModelOutput 在条数不匹配时返回 null（不猜测对齐）', () => {
  assert.equal(parseModelOutput('["甲"]', 2), null);
});

test('parseModelOutput 兜底按行解析编号列表', () => {
  assert.deepEqual(parseModelOutput('1. 甲\n2. 乙', 2), ['甲', '乙']);
});

test('parseModelOutput 对非字符串返回 null', () => {
  assert.equal(parseModelOutput(null, 1), null);
  assert.equal(parseModelOutput({}, 1), null);
});

test('buildMessages 输出 system + user 两条消息并注入术语', () => {
  const messages = buildMessages({
    texts: ['The kernel manages memory.'],
    targetLang: 'zh-CN',
    profile: 'technical',
    glossary: [{ en: 'Kernel', zh: '内核' }],
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.deepEqual(JSON.parse(messages[1].content), ['The kernel manages memory.']);
  assert.ok(messages[0].content.includes('Kernel => 内核'));
  assert.ok(/JSON/i.test(messages[0].content));
  // 保护令牌必须被要求原样保留
  assert.ok(messages[0].content.includes(PROTECT_TOKEN_SAMPLE));
});

test('buildCacheKey 稳定且能区分引擎/模式/文本', async () => {
  const base = { engineId: 'google-free', profile: 'general', sourceLang: 'auto', targetLang: 'zh-CN', text: 'hello' };
  const a = await buildCacheKey(base);
  const b = await buildCacheKey({ ...base });
  const c = await buildCacheKey({ ...base, text: 'hello!' });
  const d = await buildCacheKey({ ...base, engineId: 'deepl' });
  const e = await buildCacheKey({ ...base, profile: 'technical' });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.notEqual(a, e);
  assert.ok(a.includes('google-free'));
});

test('parseDictionaryJson 解析带代码围栏的词典结果', () => {
  const content = '```json\n{"translation":"寄存器","pos":"名词","definitions":["a","b","c","d","e"],"examples":[{"en":"x","zh":"y"},{"en":"1","zh":"2"},{"en":"3","zh":"4"}]}\n```';
  const parsed = parseDictionaryJson(content);
  assert.equal(parsed.translation, '寄存器');
  assert.equal(parsed.pos, '名词');
  assert.equal(parsed.definitions.length, 4);
  assert.equal(parsed.examples.length, 2);
  assert.deepEqual(parsed.examples[0], { en: 'x', zh: 'y' });
});

test('parseDictionaryJson 对无法解析的内容返回 null', () => {
  assert.equal(parseDictionaryJson('not json at all'), null);
  assert.equal(parseDictionaryJson(''), null);
  assert.equal(parseDictionaryJson(null), null);
});