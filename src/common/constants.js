/**
 * 全局常量与默认设置。
 * 该文件被 Service Worker、弹窗、设置页共享（ES Module）。
 * 内容脚本无法使用 ES Module，因此 src/content/core.js 中保留了一份最小化的常量副本，
 * 修改这里的协议版本或消息类型时必须同步修改 core.js。
 */

export const PROTOCOL_VERSION = 1;

/** 显示模式 */
export const MODES = Object.freeze({
  BILINGUAL: 'bilingual', // 模式 A：原文 + 译文
  ZH_ONLY: 'zh', // 模式 B：仅中文
  HOVER: 'hover', // 模式 D：悬停显示
  OFF: 'off', // 模式 C：不翻译（还原原文）
});

export const MODE_LABELS = Object.freeze({
  [MODES.BILINGUAL]: '双语对照',
  [MODES.ZH_ONLY]: '仅中文',
  [MODES.HOVER]: '悬停显示',
  [MODES.OFF]: '仅英文',
});

/** 引擎 ID */
export const ENGINE_IDS = Object.freeze({
  GOOGLE_FREE: 'google-free',
  DEEPL: 'deepl',
  OPENAI: 'openai-compatible',
  BAILIAN: 'bailian',
});

/** 引擎类型：普通翻译 API 与 LLM API 分开配置参数 */
export const ENGINE_TYPES = Object.freeze({
  TRANSLATE: 'translate',
  LLM: 'llm',
});

/** 翻译模式（措辞风格） */
export const PROFILES = Object.freeze({
  GENERAL: 'general',
  TECHNICAL: 'technical',
  ACADEMIC: 'academic',
  CUSTOM: 'custom',
});

export const PROFILE_LABELS = Object.freeze({
  [PROFILES.GENERAL]: '通用翻译',
  [PROFILES.TECHNICAL]: '技术翻译',
  [PROFILES.ACADEMIC]: '学术翻译',
  [PROFILES.CUSTOM]: '自定义规则',
});

/** 站点翻译偏好 */
export const SITE_RULES = Object.freeze({
  AUTO: 'auto',
  NEVER: 'never',
  ASK: 'ask',
});

export const STORAGE_KEYS = Object.freeze({
  SETTINGS: 'abt:settings',
  SESSION_KEYS: 'abt:sessionKeys',
  PERSISTED_KEYS: 'abt:persistedKeys',
});

/** 消息类型（内容脚本 <-> Service Worker） */
export const MESSAGE = Object.freeze({
  PING: 'ping',
  TRANSLATE: 'translate',
  TRANSLATE_CANCEL: 'translate.cancel',
  SETTINGS_GET: 'settings.get',
  SETTINGS_PATCH: 'settings.patch',
  SETTINGS_RESET: 'settings.reset',
  ENGINE_LIST: 'engine.list',
  ENGINE_TEST: 'engine.test',
  CACHE_STATS: 'cache.stats',
  CACHE_CLEAR: 'cache.clear',
  SITE_RULE_GET: 'site.rule.get',
  SITE_RULE_SET: 'site.rule.set',
  SUBTITLE_TRACKS: 'subtitle.tracks',
  SUBTITLE_CUES: 'subtitle.cues',
  WORD_LOOKUP: 'word.lookup',
  WORDBOOK_LIST: 'wordbook.list',
  WORDBOOK_ADD: 'wordbook.add',
  WORDBOOK_REMOVE: 'wordbook.remove',
  HISTORY_LIST: 'history.list',
  HISTORY_CLEAR: 'history.clear',
  // 弹窗 -> 内容脚本
  PAGE_STATE: 'page.state',
  PAGE_TRANSLATE: 'page.translate',
  PAGE_RESTORE: 'page.restore',
  PAGE_SET_MODE: 'page.setMode',
  PAGE_SET_OPTIONS: 'page.setOptions',
  PAGE_SUBTITLE_TOGGLE: 'page.subtitle.toggle',
  PAGE_LOOKUP_SELECTION: 'page.lookupSelection',
  PAGE_TOAST: 'page.toast',
});

/** 内容脚本注入的 DOM 类名前缀，避免与页面样式冲突 */
export const DOM = Object.freeze({
  ATTR_SRC: 'data-abt-src',
  ATTR_DONE: 'data-abt-done',
  ATTR_MODE: 'data-abt-mode',
  ATTR_WRAP: 'data-abt-wrap',
  ATTR_UI: 'data-abt-ui',
  CLASS_TRANS: 'abt-trans',
  CLASS_TRANS_INNER: 'abt-trans-inner',
  CLASS_INLINE_CODE: 'abt-inline-code',
  CLASS_UI: 'abt-ui',
  CLASS_TOAST: 'abt-toast',
  CLASS_SUBTITLE: 'abt-subtitle-layer',
  CLASS_LOOKUP: 'abt-lookup',
});

/** 引擎能力与限制 */
export const ENGINE_LIMITS = Object.freeze({
  maxTextsPerRequest: 20,
  googleMaxTexts: 40,
  googleMaxChars: 3200,
  llmMaxChars: 6000,
  maxSegmentChars: 2000,
});

export const DEFAULT_SETTINGS = Object.freeze({
  /** 总开关 */
  enabled: true,
  /** 打开页面时自动翻译（受站点规则约束） */
  autoTranslate: false,
  /** 显示模式 */
  mode: MODES.BILINGUAL,
  /** 语言 */
  sourceLang: 'auto',
  targetLang: 'zh-CN',
  /** 默认引擎 */
  engineId: ENGINE_IDS.GOOGLE_FREE,
  /** 翻译措辞模式 */
  profile: PROFILES.GENERAL,

  /** 排版样式 */
  style: {
    fontScale: 1, // 译文字号相对原文字号的倍数
    fontWeight: 400,
    lineHeight: 1.5, // 译文行高
    paragraphGap: 4, // 译文与原文间距（px）
    marginBottom: 6, // 译文与下一段间距（px）
    color: '#1a73e8', // 译文颜色（浅色主题）
    darkColor: '#8ab4f8', // 译文颜色（深色主题）
    showDivider: false, // 是否显示左侧竖线
    inlineCode: true, // 译文中的内联代码是否用等宽字体标注
  },

  /** 网页翻译 */
  page: {
    maxBlocks: 800, // 单页最多翻译多少个文本块
    minBlockLength: 4, // 少于该字符数的块不翻译
    lazyLoad: true, // 使用 IntersectionObserver 按视口懒加载
    observeDynamic: true, // 监听动态加载内容
    translateTitle: true, // 翻译 document.title
    batchSize: 8, // 每次向 Service Worker 发送的文本条数
    concurrency: 2, // 并发请求数
  },

  /** 翻译缓存 */
  cache: {
    enabled: true,
    maxEntries: 5000,
  },

  /** 各引擎配置（不含密钥） */
  engines: {
    [ENGINE_IDS.GOOGLE_FREE]: {
      enabled: true,
      endpoint: 'https://translate.googleapis.com/translate_a/single',
    },
    [ENGINE_IDS.DEEPL]: {
      enabled: true,
      endpoint: 'free', // free | pro
      formality: 'default', // default | more | less
    },
    [ENGINE_IDS.OPENAI]: {
      enabled: true,
      baseUrl: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      temperature: 0.2,
      maxTokens: 2048,
    },
    [ENGINE_IDS.BAILIAN]: {
      enabled: true,
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      model: 'qwen-plus',
      temperature: 0.2,
      maxTokens: 2048,
    },
  },

  /** 站点规则：{ "example.com": "auto" | "never" | "ask" } */
  siteRules: {},

  /** 自定义术语词典 */
  glossary: [
    { en: 'Register', zh: '寄存器', note: 'CPU 寄存器' },
    { en: 'Memory Management', zh: '内存管理', note: '' },
    { en: 'Kernel', zh: '内核', note: '' },
    { en: 'Pointer', zh: '指针', note: '' },
    { en: 'Assembly Language', zh: '汇编语言', note: '' },
    { en: 'System Call', zh: '系统调用', note: '' },
  ],

  /** 自定义翻译规则（配合 profile = custom 使用） */
  customPrompt: '',

  /** 快捷键（仅用于界面展示；实际快捷键在 manifest 的 commands 中定义） */
  shortcuts: {
    translatePage: 'Alt+Shift+T',
    toggleMode: 'Alt+Shift+M',
    lookupSelection: 'Alt+Shift+D',
  },

  /** 划词查询 */
  lookup: {
    enabled: true,
    autoPopup: true, // 选中后自动弹窗
    engineId: '', // 空表示跟随默认引擎
    maxLength: 600,
  },

  /** 视频字幕 */
  subtitles: {
    enabled: true,
    hideNative: true, // 隐藏站点原生字幕，避免与译文重复
    showSource: true,
    fontScale: 1,
    position: 12, // 距离底部百分比
    gap: 6, // 上下字幕间距 px
    color: '#ffffff',
    translatedColor: '#ffd54f',
    background: 'rgba(0,0,0,0.62)',
    maxWidth: 80, // 百分比
  },

  /** 生词本 */
  wordbook: [],

  /** 翻译历史（划词/句子） */
  history: {
    enabled: true,
    maxEntries: 200,
    items: [],
  },

  /** 外观 */
  theme: 'auto', // auto | light | dark

  /** 隐私：是否在发送前提示第三方 */
  privacy: {
    acknowledged: false,
  },
});

/** 支持的源语言 */
export const SOURCE_LANGS = Object.freeze([
  { code: 'auto', label: '自动检测' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
  { code: 'de', label: '德语' },
  { code: 'fr', label: '法语' },
  { code: 'ru', label: '俄语' },
]);

/** 支持的目标语言 */
export const TARGET_LANGS = Object.freeze([
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁体中文' },
  { code: 'en', label: '英语' },
  { code: 'ja', label: '日语' },
  { code: 'ko', label: '韩语' },
]);