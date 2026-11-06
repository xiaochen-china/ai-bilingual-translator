/**
 * 纯函数单元测试：语言判断、技术内容保护与还原、术语替换、分块、深合并。
 * 运行：npm test（或 node --test tests/）
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyGlossaryPre,
  chunkByChars,
  countCjk,
  countLatinLetters,
  deepMerge,
  detectLanguageHint,
  glossaryToPrompt,
  hashText,
  looksEnglishText,
  looksLikeCode,
  maskKey,
  normalizeWhitespace,
  protectText,
  restoreText,
  splitSentences,
  truncate,
} from '../src/common/text.js';

test('countCjk / countLatinLetters 统计中英文数量', () => {
  assert.equal(countCjk('内核 kernel'), 2);
  assert.equal(countLatinLetters('内核 kernel'), 6);
  assert.equal(countCjk(''), 0);
  assert.equal(countLatinLetters('12345'), 0);
});

test('looksEnglishText 只把「确实是英文段落」判为需要翻译', () => {
  assert.equal(looksEnglishText('The kernel manages memory and devices.'), true);
  assert.equal(looksEnglishText('Translation requires context and patience.'), true);
  // 中文为主
  assert.equal(looksEnglishText('这个页面的翻译质量还不错，但是加载速度有点慢。'), false);
  // 英文单词不足 3 个
  assert.equal(looksEnglishText('Install'), false);
  // 空字符串
  assert.equal(looksEnglishText('   '), false);
  // 中英混排但中文比例高
  assert.equal(looksEnglishText('使用 Memory Management 来管理系统里的内存分配'), false);
});

test('detectLanguageHint 给出粗粒度语言提示', () => {
  assert.equal(detectLanguageHint('hello world'), 'latin');
  assert.equal(detectLanguageHint('你好世界'), 'cjk');
  assert.equal(detectLanguageHint('hello 你好'), 'mixed');
  assert.equal(detectLanguageHint('1234'), 'unknown');
});

test('looksLikeCode 识别代码片段', () => {
  assert.equal(looksLikeCode('const x = foo(1);\nreturn x;'), true);
  assert.equal(looksLikeCode('#include <stdio.h>\nint main() {}'), true);
  assert.equal(looksLikeCode('The quick brown fox jumps over the lazy dog.'), false);
  assert.equal(looksLikeCode(''), false);
});

test('normalizeWhitespace 压缩空白但保留段落', () => {
  assert.equal(normalizeWhitespace('  a   b \t c  '), 'a b c');
  assert.equal(normalizeWhitespace('a\r\n\r\n\r\nb'), 'a\n\nb');
});

test('splitSentences 按句子切分', () => {
  assert.deepEqual(splitSentences('A. B! C?'), ['A.', 'B!', 'C?']);
  assert.deepEqual(splitSentences('中文一句。中文两句。'), ['中文一句。', '中文两句。']);
  assert.deepEqual(splitSentences(''), []);
});

test('chunkByChars 不会超过字符上限', () => {
  const chunks = chunkByChars(['aaaa', 'bbbb', 'cccc'], 8);
  assert.deepEqual(chunks, ['aaaabbbb', 'cccc']);
  const long = chunkByChars(['x'.repeat(25)], 10);
  for (const chunk of long) assert.ok(chunk.length <= 10, `chunk 超长: ${chunk.length}`);
  assert.equal(long.join(''), 'x'.repeat(25));
});

test('protectText 保护 URL / 路径 / 标识符，restoreText 完整还原', () => {
  const source =
    'Open https://example.com/docs and edit C:\\work\\main.py then call getUserName(id) with max_retry_count.';
  const { text, slots } = protectText(source);
  assert.ok(slots.length >= 3, `应保护至少 3 个片段，实际 ${slots.length}`);
  assert.ok(text.includes('⟦0⟧'));
  assert.ok(!text.includes('https://example.com/docs'));
  assert.equal(restoreText(text, slots), source);
});

test('restoreText 容忍模型把令牌写成 [0] / 【0】 等形态', () => {
  const slots = ['https://a.example.com', 'getUserName'];
  assert.equal(restoreText('见 [0] 与 【1】。', slots), '见 https://a.example.com 与 getUserName。');
  // 越界索引保持原样，不抛错
  assert.equal(restoreText('见 [9]', slots), '见 [9]');
});

test('protectText 关闭时原样返回', () => {
  const { text, slots } = protectText('https://example.com', { enabled: false });
  assert.equal(text, 'https://example.com');
  assert.deepEqual(slots, []);
});

test('applyGlossaryPre 长词优先、大小写不敏感、不切碎单词', () => {
  const glossary = [
    { en: 'Memory', zh: '内存' },
    { en: 'Memory Management', zh: '内存管理' },
    { en: 'Pointer', zh: '指针' },
  ];
  assert.equal(applyGlossaryPre('Memory Management is hard.', glossary), '内存管理 is hard.');
  assert.equal(applyGlossaryPre('pointers and POINTER', glossary), 'pointers and 指针');
  assert.equal(applyGlossaryPre('', glossary), '');
  assert.equal(applyGlossaryPre('Memory Management', []), 'Memory Management');
});

test('glossaryToPrompt 生成术语约束文本', () => {
  const prompt = glossaryToPrompt([{ en: 'Kernel', zh: '内核', note: '操作系统' }]);
  assert.ok(prompt.includes('Kernel => 内核'));
  assert.ok(prompt.includes('操作系统'));
  assert.equal(glossaryToPrompt([]), '');
});

test('hashText 是稳定的 40 位十六进制摘要', async () => {
  const a = await hashText('hello world');
  const b = await hashText('hello world');
  const c = await hashText('hello worlds');
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.match(a, /^[0-9a-f]{40}$/);
});

test('truncate / maskKey 不泄露完整密钥', () => {
  assert.equal(truncate('abcdef', 3), 'abc…');
  assert.equal(truncate('abc', 10), 'abc');
  assert.equal(maskKey(''), '');
  assert.equal(maskKey('short'), '****');
  const masked = maskKey('sk-1234567890abcdef');
  assert.ok(masked.endsWith('cdef'));
  assert.ok(!masked.includes('1234567890'));
});

test('deepMerge 只递归普通对象，数组整体替换', () => {
  const base = { a: { b: 1, c: 2 }, list: [1, 2], keep: true };
  const merged = deepMerge(base, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9], keep: true });
  // 不修改原始对象
  assert.equal(base.a.c, 2);
  assert.deepEqual(deepMerge(base, null), base);
});