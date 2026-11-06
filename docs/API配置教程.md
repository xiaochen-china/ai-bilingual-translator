# API 配置教程

扩展把引擎分成两大类：

- **翻译 API**：Google 免费接口、DeepL。输入文本 → 输出译文，不解释、不改写。
- **LLM API**：OpenAI 兼容接口、阿里云百炼。按提示词生成译文，能遵守术语和风格约束，划词时还能返回词性/释义/例句。

所有请求都由后台 Service Worker 发出，内容脚本不直接访问这些域名，API Key 也不会出现在网页里。

---

## 一、Google 免费翻译（无需配置）

- 接口：`https://translate.googleapis.com/translate_a/single`
- 无需 Key，安装即可用。
- 这是浏览器端公共接口，**不是** Google 官方对外开放并承诺 SLA 的 API。它没有配额说明，可能限流、可能变更，随时可能失效。
- 出现「HTTP 429」「请求过于频繁」时：把「并发请求数」调到 1，或改用其它引擎。

---

## 二、DeepL

### 2.1 申请密钥

1. 打开 <https://www.deepl.com/pro-api>，注册账号。
2. 选择 **DeepL API Free**（每月 50 万字符免费额度，够个人阅读使用）。
3. 在账号页 → 「Authentication Key for DeepL API」复制密钥。Free 版密钥**以 `:fx` 结尾**。
4. 填入设置页：引擎选 **DeepL** → 接口类型选 **DeepL Free** → 粘贴密钥 → 保存 → 测试连接。

### 2.2 免费版与专业版的区别

| 项目 | Free | Pro |
| --- | --- | --- |
| 接口域名 | `api-free.deepl.com` | `api.deepl.com` |
| 密钥后缀 | `:fx` | 无 |
| 额度 | 50 万字符/月 | 按套餐 |

选错接口类型会返回 `403 Forbidden`，这是最常见的配置错误。扩展会自动识别以 `:fx` 结尾的密钥并纠正到 Free 域名，但请仍按下拉框正确选择。

### 2.3 直接验证密钥（可选）

```bash
curl -X POST https://api-free.deepl.com/v2/translate \
  -H "Authorization: DeepL-Auth-Key <你的密钥>" \
  -d "text=Kernel manages memory." \
  -d "target_lang=ZH-HANS"
```

返回 JSON 里出现 `"text": "内核管理内存。"` 之类内容即密钥有效。

---

## 三、OpenAI 兼容接口

### 3.1 官方 OpenAI

1. <https://platform.openai.com/api-keys> → 创建密钥（`sk-` 开头）。
2. 设置页：引擎选 **OpenAI 兼容接口**，Base URL 填 `https://api.openai.com/v1`，模型填 `gpt-4o-mini`（便宜、够用），温度 `0.2`。
3. 粘贴密钥 → 保存 → 测试连接。

> 账户需要有可用余额，否则返回 `429 insufficient_quota`。

### 3.2 任意兼容服务

只要满足 `POST {BaseURL}/chat/completions`、请求体含 `model` + `messages`、返回 `choices[0].message.content`，就能直接用：

| 服务 | Base URL 示例 | 模型示例 |
| --- | --- | --- |
| DeepSeek | `https://api.deepseek.com/v1` | `deepseek-chat` |
| 月之暗面 Kimi | `https://api.moonshot.cn/v1` | `moonshot-v1-8k` |
| 智谱 GLM | `https://open.bigmodel.cn/api/paas/v4` | `glm-4-flash` |
| OpenRouter | `https://openrouter.ai/api/v1` | `openai/gpt-4o-mini` |
| 本地 Ollama | `http://localhost:11434/v1` | `qwen2.5:7b` |
| 本地 LM Studio | `http://localhost:1234/v1` | 取决于已加载模型 |

用自定义域名/本地地址时，保存后浏览器会弹出**主机权限申请**（`https://*/*` 或 `http://localhost/*`），必须点「允许」，否则请求会被扩展拦下。权限只为这些自定义端点申请，不是所有站点默认放开。

本地模型注意：

- 扩展默认只申请 `http://localhost/*`，用 `127.0.0.1` 也可以（同属本机）。
- 小模型（7B 级别）在长段落上容易出现漏译、合并段落、输出格式错误。扩展对输出做了容错（去代码围栏、取 `translations` 数组、按行兜底），但**质量仍取决于模型**。
- 温度建议 `0`–`0.3`；过高会改写内容。

### 3.3 提示词约束（了解即可）

LLM 引擎的提示词要求：

- 输出**等长的 JSON 字符串数组**，与输入句子一一对应；
- 保留 `⟦0⟧` 这类占位符（URL、路径、代码标识符在发送前被替换成占位符，返回后原样还原）；
- 保留段落分隔；
- 按所选「翻译措辞」遵守风格规则，并强制使用术语表。

如果模型不遵守格式，扩展会按行兜底；兜底也失败时该批次会标记为未翻译并显示原因，不会把错误的句子硬塞进页面。

---

## 四、阿里云百炼（DashScope 兼容模式）

1. 登录 <https://bailian.console.aliyun.com/>，开通「百炼大模型服务」。
2. 在「API-KEY 管理」创建密钥（`sk-` 开头）。
3. 设置页：引擎选 **阿里云百炼**，Base URL 保持 `https://dashscope.aliyuncs.com/compatible-mode/v1`，模型填 `qwen-plus`（性价比）或 `qwen-turbo`（更快）。
4. 粘贴密钥 → 保存 → 测试连接。

新用户通常有免费额度，具体额度与计费以官网为准。返回 `401` 多为密钥未开通对应模型权限；返回 `400 model not found` 说明模型名写错。

---

## 五、测试连接做了什么

点「测试连接」时，扩展会：

1. 先把你当前面板里的参数**静默保存**（避免「测的」和「存的」不一致）；
2. 用固定英文句子 `Kernel manages memory and devices.` 走一次真实请求（与正式翻译同一套代码路径）；
3. 成功时显示耗时与返回片段；失败时显示错误码与可读原因。

因此「测试连接成功」等价于「这个引擎现在能真的翻译」。

---

## 六、密钥安全规则

扩展内实现（可在 `src/background/settings-service.js` 核对）：

- 密钥**不进入** `settings` 对象，不随 `settings.get` 返回，只返回 `{ hasKey, source }` 状态；
- 默认写入 `chrome.storage.session`，**关闭浏览器即清除**；
- 勾选「持久化保存密钥」并确认风险后，才写入 `chrome.storage.local`；读取顺序为 session → local；
- 清除密钥会同时删除两处；
- 日志里只出现掩码（如 `sk-…abcd`），不打印完整密钥。

请自行遵守：

- 不要把密钥写进代码、截图、Issues、录屏；
- 公共电脑上不要勾选持久化；
- 怀疑泄漏就立刻去服务商后台吊销重建。

---

## 七、错误码对照

| 显示 | 含义 | 处理 |
| --- | --- | --- |
| `NO_API_KEY` / 未配置 API Key | 当前引擎需要密钥但没有 | 配置并保存密钥 |
| `AUTH_ERROR` / 401、403 | 密钥无效、过期、无权限、接口类型选错 | 重新粘贴；DeepL 核对 Free/Pro |
| `RATE_LIMIT` / 429 | 触发限流或余额不足 | 降低并发、稍后重试、检查账户余额 |
| `TIMEOUT` | 超过 20–40 秒未返回 | 检查网络/代理，换更快的引擎 |
| `HTTP_ERROR` + 状态码 | 其它 HTTP 错误 | 按状态码判断（404 多为 Base URL 或模型名错误） |
| `INVALID_RESPONSE` | 返回内容不是预期格式 | 多为代理改写了响应；核对接口是否兼容 |
| `PERMISSION_DENIED` | 自定义域名未授权 | 保存后同意浏览器弹出的主机权限申请 |
| `ABORTED` | 请求被取消（切换页面/手动停止） | 正常现象，重新翻译即可 |