/**
 * LLM 引擎的提示词构造。
 * 目标：稳定输出与输入等长的 JSON 字符串数组，术语可控，代码/变量名不被翻译。
 */

import { PROFILES, PROFILE_LABELS } from '../../common/constants.js';
import { glossaryToPrompt } from '../../common/text.js';

const TARGET_NAMES = {
  'zh-CN': '简体中文',
  'zh-TW': '繁体中文',
  en: '英语',
  ja: '日语',
  ko: '韩语',
};

const SOURCE_NAMES = {
  auto: '自动检测',
  en: '英语',
  ja: '日语',
  ko: '韩语',
  de: '德语',
  fr: '法语',
  ru: '俄语',
};

const PROFILE_RULES = {
  [PROFILES.GENERAL]: '译文要符合中文表达习惯，通顺自然，不要逐字硬译，也不要过度意译。',
  [PROFILES.TECHNICAL]:
    '这是技术文档。必须使用业界通用的中文技术术语（例如 Register→寄存器、Kernel→内核、Pointer→指针、System Call→系统调用）。' +
    '变量名、函数名、API 名称、命令行、文件路径、URL、代码关键字一律保留英文原样，不要翻译，也不要添加解释。',
  [PROFILES.ACADEMIC]: '这是学术文本。译文要严谨、书面化，保持论证逻辑与专业术语的准确性，不使用口语化表达。',
  [PROFILES.CUSTOM]: '',
};

/**
 * 构造 chat/completions 的 messages。
 * @param {{texts: string[], sourceLang: string, targetLang: string, profile: string, glossary: Array, customPrompt?: string}} params
 */
export function buildMessages({ texts, sourceLang = 'auto', targetLang = 'zh-CN', profile = PROFILES.GENERAL, glossary = [], customPrompt = '' }) {
  const targetName = TARGET_NAMES[targetLang] || '简体中文';
  const sourceName = SOURCE_NAMES[sourceLang] || '自动检测';

  const rules = [];
  rules.push(`把用户提供的每一段${sourceName === '自动检测' ? '' : sourceName}文本翻译成${targetName}。`);
  rules.push('输入是 JSON 字符串数组，输出必须是等长、同顺序的 JSON 字符串数组，不要输出任何解释、编号或 Markdown 代码块。');
  rules.push('保留原文中的 ⟦n⟧ 占位符，原样放在译文中，不要改写、不要翻译、不要删除。');
  rules.push('保留原文中的段落换行数量，不要合并段落。');

  const profileRule = profile === PROFILES.CUSTOM ? String(customPrompt || '').trim() : PROFILE_RULES[profile];
  if (profileRule) rules.push(profileRule);

  const glossaryRule = glossaryToPrompt(glossary);
  if (glossaryRule) rules.push(glossaryRule);

  const system = ['你是一个高质量的机器翻译引擎，只做翻译，不做内容审查，不添加任何评论。', ...rules.map((line, index) => `${index + 1}. ${line}`)].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: JSON.stringify(texts, null, 0) },
  ];
}

/** 用于「测试连接」的固定短文本 */
export function buildProbeMessages(targetLang = 'zh-CN') {
  return buildMessages({ texts: ['Kernel manages memory and devices.'], targetLang, profile: PROFILES.TECHNICAL });
}

export { PROFILE_LABELS };