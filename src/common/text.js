/**
 * 纯函数文本工具：语言判断、分句、分块、技术内容保护、术语替换、哈希。
 * 不依赖任何 chrome.* API，可直接在 Node 中做单元测试。
 */

const CJK_RE = /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g;
const LATIN_LETTER_RE = /[A-Za-z]/g;

/** 统计中日韩字符数量 */
export function countCjk(text) {
  const m = String(text).match(CJK_RE);
  return m ? m.length : 0;
}

/** 统计拉丁字母数量 */
export function countLatinLetters(text) {
  const m = String(text).match(LATIN_LETTER_RE);
  return m ? m.length : 0;
}

/**
 * 判断一段文本是否「主要是英文」，用于决定是否需要翻译。
 * 规则：英文单词 >= 3 个，拉丁字母占比 >= 55%，中文字符占比 <= 25%。
 */
export function looksEnglishText(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  const letters = countLatinLetters(raw);
  if (letters < 8) return false;
  const cjk = countCjk(raw);
  const total = letters + cjk;
  if (total === 0) return false;
  if (letters / total < 0.55) return false;
  if (cjk / total > 0.25) return false;
  const words = raw.match(/[A-Za-z][A-Za-z'’-]{1,}/g);
  return Boolean(words && words.length >= 3);
}

/** 粗略的语言提示，用于日志与引擎参数 */
export function detectLanguageHint(text) {
  const raw = String(text || '');
  const letters = countLatinLetters(raw);
  const cjk = countCjk(raw);
  if (letters === 0 && cjk === 0) return 'unknown';
  if (cjk > letters) return 'cjk';
  if (letters > cjk * 3) return 'latin';
  return 'mixed';
}

/**
 * 判断文本是否像代码（用于避免翻译代码块）。
 * 只做启发式判断，误判时宁可「不翻译」。
 */
export function looksLikeCode(text) {
  const raw = String(text || '');
  if (!raw.trim()) return false;
  const signals = [
    /[{};]\s*$/m,
    /^\s*(?:function|class|const|let|var|import|export|def|return|if|for|while)\s/m,
    /[=!<>]==?[^=]/,
    /=>|->|::|\+\+|--/,
    /^\s*[\w$.]+\s*\([^)]*\)\s*;?\s*$/m,
    /<[a-zA-Z/][^>]*>/,
    /^(?:\s*#\s*(?:include|define|ifndef|pragma))/m,
  ];
  let hits = 0;
  for (const re of signals) if (re.test(raw)) hits += 1;
  return hits >= 2;
}

/** 归一化空白：把连续的空白（含换行）压成单个空格，保留首尾判断 */
export function normalizeWhitespace(text) {
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[\t\f\v ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * 按句子切分。用于把超长段落切成符合引擎限制的小块。
 * 不追求语言学精确，只要不切碎代码和缩写即可。
 */
export function splitSentences(text) {
  const raw = String(text || '').trim();
  if (!raw) return [];
  // 英文句末标点后通常有空格；中文句号/问号/感叹号后通常没有空格，因此分两类处理
  const parts = raw
    .split(/(?<=[。！？；;])|(?<=[.!?])\s+|\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [raw];
}

/**
 * 把若干片段按字符上限打包成若干块，尽量在句子边界切分。
 */
export function chunkByChars(segments, maxChars) {
  const limit = Math.max(1, Number(maxChars) || 1);
  const chunks = [];
  let current = [];
  let currentLen = 0;

  const pushCurrent = () => {
    if (current.length) {
      chunks.push(current.join(''));
      current = [];
      currentLen = 0;
    }
  };

  for (const segment of segments) {
    const text = String(segment);
    if (text.length <= limit) {
      if (currentLen + text.length > limit) pushCurrent();
      current.push(text);
      currentLen += text.length;
      continue;
    }
    // 单个片段超长：先按句子切，再硬切
    pushCurrent();
    let buffer = '';
    for (const sentence of splitSentences(text)) {
      if (buffer.length + sentence.length > limit) {
        if (buffer) chunks.push(buffer);
        buffer = '';
      }
      let rest = sentence;
      while (rest.length > limit) {
        chunks.push(rest.slice(0, limit));
        rest = rest.slice(limit);
      }
      buffer += rest;
    }
    if (buffer) chunks.push(buffer);
  }
  pushCurrent();
  return chunks;
}

/* ------------------------------------------------------------------ */
/* 技术内容保护                                                        */
/* ------------------------------------------------------------------ */

/**
 * 需要原样保留的片段（URL、路径、命令行参数、标识符、代码符号）。
 * 这些片段在送到翻译引擎前会被替换为 ⟦n⟧ 令牌，返回后还原。
 */
const PROTECT_PATTERNS = [
  // URL
  /\bhttps?:\/\/[^\s<>"'`）】，。；]+/g,
  // 文件路径（Windows / POSIX）
  /\b[A-Za-z]:\\[^\s"'`]+/g,
  /(?:^|[\s("'`])\/(?:[\w.@-]+\/)+[\w.@-]+/g,
  // 带参数的命令行
  /\b(?:sudo|apt|apt-get|yum|dnf|npm|pnpm|yarn|git|docker|kubectl|make|cmake|gcc|clang|g\+\+|python3?|pip3?|node|deno|curl|wget|ssh|scp|systemctl|chmod|chown|tar|grep|sed|awk)\b(?:[ \t]+[^\s,;]+){1,6}/g,
  // 含下划线的标识符 / 常量
  /\b[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_]+\b/g,
  // camelCase / PascalCase 标识符（长度 >= 5 且有大小写混合）
  /\b(?:[a-z]+[A-Z][A-Za-z0-9]{2,}|[A-Z][a-z0-9]+[A-Z][A-Za-z0-9]*)\b/g,
  // 函数调用样式
  /\b[A-Za-z_$][\w$.]*\([^()\s]{0,40}\)/g,
  // 十六进制、带单位的数值
  /\b0x[0-9a-fA-F]+\b/g,
  /\b\d+(?:\.\d+)?\s?(?:px|em|rem|ms|kb|mb|gb|hz|mhz|ghz|fps)\b/gi,
  // 预处理指令 / 泛型尖括号
  /#(?:include|define|ifdef|ifndef|endif|pragma)\b[^\n]*/g,
];

const TOKEN_CHARS = { open: '\u27E6', close: '\u27E7' }; // ⟦ ⟧

/**
 * 保护技术片段。返回 { text, slots }，slots 为被替换掉的原始片段。
 * 已经有 ⟦iN⟧ 形式的令牌（由内容脚本插入内联代码时生成）不会被再次保护。
 */
export function protectText(text, { enabled = true } = {}) {
  const source = String(text || '');
  if (!enabled || !source) return { text: source, slots: [] };

  const found = [];
  for (const pattern of PROTECT_PATTERNS) {
    const re = new RegExp(pattern.source, pattern.flags);
    let match;
    while ((match = re.exec(source)) !== null) {
      const value = match[0];
      if (!value) {
        re.lastIndex += 1;
        continue;
      }
      const start = match.index;
      const end = start + value.length;
      if (value.trim().length < 3) continue;
      if (found.some((item) => start < item.end && end > item.start)) continue;
      found.push({ start, end, value });
    }
  }

  if (!found.length) return { text: source, slots: [] };

  found.sort((a, b) => a.start - b.start);
  let result = '';
  let cursor = 0;
  const slots = [];
  for (const item of found) {
    result += source.slice(cursor, item.start);
    result += `${TOKEN_CHARS.open}${slots.length}${TOKEN_CHARS.close}`;
    slots.push(item.value);
    cursor = item.end;
  }
  result += source.slice(cursor);
  return { text: result, slots };
}

/** 宽容地还原令牌：兼容模型把 ⟦0⟧ 写成 [0]、【0】、<<0>> 等情况 */
export function restoreText(text, slots) {
  const source = String(text || '');
  if (!slots || !slots.length) return source;
  return source.replace(/[⟦\[【<《〔(]{1,2}\s*(?:p|g|s)?\s*(\d{1,3})\s*[⟧\]】>》〕)]{1,2}/g, (whole, digits) => {
    const index = Number(digits);
    if (Number.isInteger(index) && index >= 0 && index < slots.length) return slots[index];
    return whole;
  });
}

/**
 * 术语预替换：把英文术语替换成用户词典里的中文译法。
 * 用于非 LLM 引擎（LLM 引擎通过提示词约束术语）。
 * 长词优先匹配，避免 "Memory Management" 被 "Memory" 抢先替换。
 */
export function applyGlossaryPre(text, glossary) {
  const source = String(text || '');
  if (!Array.isArray(glossary) || glossary.length === 0) return source;

  const entries = glossary
    .filter((entry) => entry && typeof entry.en === 'string' && typeof entry.zh === 'string')
    .filter((entry) => entry.en.trim().length > 1 && entry.zh.trim().length > 0)
    .sort((a, b) => b.en.length - a.en.length);

  let result = source;
  for (const entry of entries) {
    const escaped = entry.en.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`, 'gi');
    result = result.replace(re, entry.zh.trim());
  }
  return result;
}

/** 生成术语表提示词片段（给 LLM 引擎使用） */
export function glossaryToPrompt(glossary, limit = 80) {
  if (!Array.isArray(glossary) || glossary.length === 0) return '';
  const lines = glossary
    .filter((entry) => entry && entry.en && entry.zh)
    .slice(0, limit)
    .map((entry) => `- ${entry.en} => ${entry.zh}${entry.note ? `（${entry.note}）` : ''}`);
  if (!lines.length) return '';
  return `必须严格使用以下术语译法：\n${lines.join('\n')}`;
}

/* ------------------------------------------------------------------ */
/* 其他工具                                                            */
/* ------------------------------------------------------------------ */

/** SHA-256（十六进制前 40 位），用于翻译缓存键。 */
export async function hashText(text) {
  const data = new TextEncoder().encode(String(text));
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('')
      .slice(0, 40);
  }
  // 极端降级：Node 环境没有 subtle 时使用 FNV-1a
  let hash = 0x811c9dc5;
  for (const byte of data) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** 截断文本用于日志（不打印完整密钥 / 全文） */
export function truncate(text, max = 60) {
  const raw = String(text || '');
  return raw.length <= max ? raw : `${raw.slice(0, max)}…`;
}

/** 掩码密钥，只保留尾 4 位 */
export function maskKey(key) {
  const raw = String(key || '');
  if (!raw) return '';
  if (raw.length <= 6) return '****';
  return `${'*'.repeat(Math.min(8, raw.length - 4))}${raw.slice(-4)}`;
}

/** 深合并：用于设置项 patch，只递归合并普通对象 */
export function deepMerge(base, patch) {
  if (!patch || typeof patch !== 'object') return base;
  const out = Array.isArray(base) ? [...base] : { ...(base || {}) };
  for (const [key, value] of Object.entries(patch)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && base && typeof base[key] === 'object' && !Array.isArray(base[key])) {
      out[key] = deepMerge(base[key], value);
    } else {
      out[key] = value;
    }
  }
  return out;
}