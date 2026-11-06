/**
 * 字幕解析测试：轨道选择、json3 / XML 解析、格式自动识别。
 * 注意：这里只测解析，不发起任何网络请求。
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { parseJson3, parseTimedTextBody, parseTimedTextXml, pickTrack } from '../src/background/subtitle-bridge.js';

test('pickTrack 优先人工英文字幕', () => {
  const tracks = [
    { languageCode: 'zh-Hans', kind: 'asr', name: '自动' },
    { languageCode: 'en', kind: '', name: 'English' },
    { languageCode: 'en', kind: 'asr', name: 'English (auto)' },
  ];
  assert.deepEqual(pickTrack(tracks), tracks[1]);
});

test('pickTrack 在没有人工轨道时退回 ASR 英文，再退回第一条', () => {
  assert.equal(pickTrack([{ languageCode: 'ja', kind: 'asr' }, { languageCode: 'en', kind: 'asr' }]).languageCode, 'en');
  assert.equal(pickTrack([{ languageCode: 'ja', kind: 'asr' }]).languageCode, 'ja');
  assert.equal(pickTrack([]), null);
  assert.equal(pickTrack(undefined), null);
});

test('parseJson3 解析 YouTube json3 字幕', () => {
  const payload = {
    events: [
      { tStartMs: 0, dDurationMs: 1500, segs: [{ utf8: 'Hello ' }, { utf8: 'world' }] },
      { tStartMs: 1500, dDurationMs: 0, segs: [] },
      { tStartMs: 2000, dDurationMs: 1000, segs: [{ utf8: 'Second line\nwith break' }] },
    ],
  };
  const cues = parseJson3(payload);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0, duration: 1.5, end: 1.5, text: 'Hello world' });
  assert.equal(cues[1].start, 2);
  assert.equal(cues[1].text, 'Second line with break');
});

test('parseJson3 对空输入返回空数组', () => {
  assert.deepEqual(parseJson3(null), []);
  assert.deepEqual(parseJson3({}), []);
});

test('parseTimedTextXml 解析 XML 字幕并解码实体', () => {
  const xml = [
    '<?xml version="1.0" encoding="utf-8"?>',
    '<transcript>',
    '<text start="0.5" dur="2">Tom &amp; Jerry &lt;3</text>',
    '<text start="3" dur="1.5">Second &quot;quote&quot;</text>',
    '</transcript>',
  ].join('');
  const cues = parseTimedTextXml(xml);
  assert.equal(cues.length, 2);
  assert.deepEqual(cues[0], { start: 0.5, duration: 2, end: 2.5, text: 'Tom & Jerry <3' });
  assert.equal(cues[1].text, 'Second "quote"');
});

test('parseTimedTextBody 自动识别 JSON 与 XML', () => {
  const json = JSON.stringify({ events: [{ tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'A' }] }] });
  assert.equal(parseTimedTextBody(json)[0].text, 'A');
  const xml = '<transcript><text start="1" dur="1">B</text></transcript>';
  assert.equal(parseTimedTextBody(xml)[0].text, 'B');
  // 伪装成 JSON 的坏数据不应抛错
  assert.deepEqual(parseTimedTextBody('{ not json'), []);
  assert.deepEqual(parseTimedTextBody(''), []);
});