# 扩展指南

English version: [EXTENDING_EN.md](EXTENDING_EN.md)

本文讲怎么扩展免费AI工具站（自部署版）：加一个新供应商、加一个新功能页签、改模型配置。照着做，不用猜。

前置条件：先按 [README.md](../README.md) 的「本地运行」把项目跑起来（要求 Node.js >= 18），确认 `npm start` 后能打开 http://localhost:8080。

涉及的主要文件：

| 文件 | 作用 |
| --- | --- |
| `lib/providers/<name>.js` | 一个供应商一个文件，导出 `meta` + 能力方法 |
| `lib/provider-registry.js` | 启动时扫描 `lib/providers/*.js` 自动发现供应商 |
| `lib/config.js` | 按 `meta.credentials` 自动处理凭据（设置页 > 环境变量） |
| `lib/models.json` | 模型配置（按能力分，见第 3 节） |
| `lib/models.js` | 读 `lib/models.json` 的后端接口 |
| `lib/routes/*.js` | 一个功能一组路由，导出 `registerRoutes(app, ctx)` |
| `server.js` | 入口，启动时自动加载 `lib/routes/*.js` |
| `public/index.html` | 前端页面，每个页签一个 `<section>` |
| `public/app.js` | 前端逻辑，顶部 `FEATURES` 注册表定义页签 |
| `.env.example` | 环境变量示例，新供应商要在这里补上自己的变量 |

## 1. 加一个新供应商

以一个虚构的供应商 "Example AI" 为例（OpenAI 兼容接口，只提供对话能力），从零走完整个流程。

### 1.1 供应商接口

新建文件 `lib/providers/<name>.js`，导出一个对象。`meta.name` 必须与文件名一致（文件叫 `example.js`，`name` 就必须是 `'example'`），否则注册表会记一条 `warn` 并跳过该模块。

```js
module.exports = {
  meta: {
    name: 'example',           // 必须与文件名一致
    label: 'Example AI',       // 设置页和向导里显示的名字
    quotaNote: '免费档说明文字', // 设置页显示的免费额度说明
    applyUrl: 'https://example.com/keys',  // 向导里的“去申请”链接
    order: 100,                // 展示顺序，见下方顺序表
    capabilities: ['chat'],    // 该供应商提供的能力，见下方能力表
    credentials: [
      { key: 'apiKey', label: 'API Key', type: 'password', env: 'EXAMPLE_API_KEY', required: true },
    ],
  },
  test: async (creds) => ({ ok: true }),       // 必填：连接测试
  getUsage: async (creds) => ({ used, limit, unit }),  // 可选：用量查询，没有用量接口就返回 null
  // 能力方法：按 capabilities 实现对应函数
  chat: async ({ apiKey, model, messages }) => ({ text, model }),
};
```

`meta` 各字段：

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `name` | 是 | 供应商名，必须与文件名一致，全小写字母 |
| `label` | 是 | 显示名，如 `Example AI` |
| `quotaNote` | 是 | 免费额度说明，显示在设置页，照实写，以官网为准 |
| `applyUrl` | 是 | 申请 Key 的地址，向导里“去申请”按钮跳这里 |
| `order` | 是 | 在设置页和向导里的展示顺序，数字越小越靠前 |
| `capabilities` | 是 | 能力列表，取值见下方能力表 |
| `credentials` | 是 | 凭据字段定义，见 1.4 节 |

现有供应商的 `order`：zhipu 10、groq 20、cloudflare 30、deepl 40、elevenlabs 50、siliconflow 60、kaggle 70、instabox 80、gemini 90、nvidia 95。新供应商从 100 起往后排（100、110、120……），不要插进现有序号中间。

`capabilities` 取值与对应函数：

| 能力 | 函数 | 签名（现有约定） |
| --- | --- | --- |
| `chat` | `chat` | `chat({ apiKey, model, messages })` → `{ text, model }`，`messages` 是 OpenAI 格式的 `[{ role, content }]` |
| `vision` | `visionQA` / `ocr` | 提问用 `visionQA({ apiKey, imageBase64, mimeType, question })` → `{ text, model }`；OCR 提取文字用 `ocr({ apiKey, imageBase64, mimeType })` → `{ text, model }` |
| `translate` | `translate` | `translate({ apiKey, text, sourceLang, targetLang })` → `{ text }`，`sourceLang` 可为空（自动检测） |
| `tts` | `tts` | `tts({ apiKey, text, voiceId?, lang? })` → `Buffer`（音频字节） |
| `stt` | `transcribe` | `transcribe({ apiKey, audioBuffer, filename? })` → `string`（转写文本） |
| `embed` | `embed` | `embed({ apiKey, texts })` → `{ embeddings, model }`，`texts` 是字符串数组 |
| `image` | — | 暂无统一函数签名，见下方说明 |
| `video` | — | 暂无统一函数签名，见下方说明 |

说明：

- 能力方法的第一个参数对象里既有凭据字段（如 `apiKey`），也有调用参数（如 `model`、`messages`）。凭据由路由经 `ctx.config.getProvider(name)` 取出后传入，供应商模块自己不要读环境变量、不要读 `settings.json`。
- 需要两个凭据字段的供应商（如 Cloudflare 需要 `accountId` + `apiKey`），能力方法里就多一个对应参数，例如 `chat({ accountId, apiKey, model, messages })`。
- `image` / `video` 目前没有统一的函数签名：现有三家后端各用各的函数（InstaBox 用 `generate` / `getProgress` / `fetchImage`，Kaggle 用 `submitImageJob` / `submitVideoJob` / `getStatus`，Cloudflare 用 `generateImage`），路由 `lib/routes/generation.js` 直接调用这些专有函数。新供应商如果提供出图或生视频能力，需要同时在 `lib/routes/generation.js` 里按现有后端模式接线，只写供应商文件是不够的。
- 所有能力方法：上游报错时抛中文 `Error`，格式照现有供应商（`Groq 返回 HTTP 401：……`、`请求 Groq 超时（120 秒无响应）`）；请求要加超时（`AbortSignal.timeout(60000)` 起步，对话类 120 秒）。

`test(creds)`：必填。`creds` 是该供应商的凭据对象。做一次轻量探活（例如请求一次 `/v1/models` 列表），Key 有效返回 `{ ok: true }`，无效返回 `{ ok: false, message: '中文原因' }`。注意返回对象，不要抛错——向导经 `POST /api/providers/:name/test` 调用它，靠返回值判断。不要用耗额度的生成接口做探活。现有供应商的 `test()` 都用 `lib/probe.js` 提供的 `probe` / `bearer` 辅助函数（一行调用，不抛错，自动把 401、超时、网络错误翻译成中文原因），新供应商照着用即可（见 1.2 节示例）。

`getUsage(creds)`：可选。供应商有用量接口就实现，返回 `{ used, limit, unit }`（例如 `{ used: 1200, limit: 1000000, unit: 'characters' }`，现有 DeepL / ElevenLabs 的 `unit` 都是 `'characters'`）；查询失败（未授权、网络错、响应格式不对）时返回 `null`，不抛错，调用方保留旧值；没有用量接口就返回 `null`，或者不导出这个函数。

### 1.2 最小示例：`lib/providers/example.js`

下面是完整可复制的最小示例。Example AI 是虚构的供应商，对接一个 OpenAI 兼容的对话接口，只演示 `chat` + `test` + `getUsage`。把它保存为 `lib/providers/example.js`，启动后就会被自动发现（接口地址是虚构的，真实调用会失败，这是正常的——示例的重点是文件结构）。注意：示例的模型先在 `lib/models.json` 的 `chat.example` 里注册（见第 3 节），再经 `lib/models.js` 读取——不要在供应商文件里硬编码模型列表。

```js
// lib/providers/example.js — 示例供应商（虚构，仅作扩展文档的最小示例）
// 对接虚构的 Example AI，OpenAI 兼容接口，演示 chat 能力 + test + getUsage。
// 密钥由调用方传入（来自 config），本文件不保存任何真实密钥。

const { probe, bearer } = require('../probe');
const models = require('../models');

const BASE_URL = 'https://api.example.com/v1';

// 模型来自 lib/models.json 的 chat.example（见第 3 节），不要硬编码。
const CHAT_MODELS = models.getModels('chat', 'example').map((m) => m.id);

function extractErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (data?.error?.message) return data.error.message;
    if (typeof data?.message === 'string') return data.message;
  } catch { /* 不是 JSON，直接用原文 */ }
  return bodyText.slice(0, 300);
}

// 对话
// chat({apiKey, model, messages}) → {text, model}
// messages: [{role:'user'|'assistant'|'system', content}]（OpenAI 格式）
async function chat({ apiKey, model, messages }) {
  const useModel = model || models.getDefaultModel('chat', 'example');
  if (!CHAT_MODELS.includes(useModel)) {
    throw new Error(`Example AI 不支持模型 ${useModel}，可用：${CHAT_MODELS.join('、')}`);
  }
  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: useModel, messages }),
      signal: AbortSignal.timeout(120000),
    });
  } catch (err) {
    if (err.name === 'TimeoutError') throw new Error('请求 Example AI 超时（120 秒无响应）');
    throw new Error(`请求 Example AI 失败：${err.message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Example AI 返回 HTTP ${res.status}：${extractErrorMessage(text)}`);
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Example AI 返回了无法解析的响应');
  }
  const content = data?.choices?.[0]?.message?.content;
  if (typeof content !== 'string') {
    throw new Error('Example AI 返回的响应中没有文本内容');
  }
  return { text: content, model: useModel };
}

// 连接测试：GET /v1/models 探活，2xx 即 Key 有效。
// test(creds) → {ok:true} 或 {ok:false, message}（不要抛错）
// probe() 本身不抛错：2xx 返回 {ok:true}，否则返回带中文原因的 {ok:false}。
async function test(creds = {}) {
  try {
    return await probe(`${BASE_URL}/models`, { headers: bearer(creds.apiKey) });
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

// 用量查询：GET /v1/usage → {used, limit, unit}；查询失败返回 null，不抛错；
// 没有用量接口的供应商直接返回 null（或不导出 getUsage）。
async function getUsage({ apiKey }) {
  let res;
  try {
    res = await fetch(`${BASE_URL}/usage`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(30000),
    });
  } catch (_) {
    return null;
  }
  if (!res.ok) return null;
  let data;
  try {
    data = JSON.parse(await res.text());
  } catch {
    return null;
  }
  if (typeof data.used !== 'number' || typeof data.limit !== 'number') return null;
  return {
    used: data.used,
    limit: data.limit,
    unit: data.unit || '次',
  };
}

module.exports = {
  meta: {
    name: 'example',
    label: 'Example AI',
    quotaNote: '免费档：每天 100 次对话请求（示例文字，真实供应商请按官网政策填写）',
    applyUrl: 'https://example.com/keys',
    order: 100,
    capabilities: ['chat'],
    credentials: [
      { key: 'apiKey', label: 'API Key', type: 'password', env: 'EXAMPLE_API_KEY', required: true },
    ],
  },
  test,
  getUsage,
  chat,
};
```

写完对照检查一遍：`meta.name` 与文件名一致；`test` 返回对象不抛错；错误信息是中文；没有写任何真实 Key（示例里只有占位符 `YOUR_API_KEY_HERE`，见 1.5 节）。

### 1.3 自动发现机制

不用在任何地方手动注册新供应商。启动时 `lib/provider-registry.js` 扫描 `lib/providers/*.js`，逐个 `require`，读取 `meta` 后完成发现。发现后自动生效的有：

- 设置页出现该供应商的配置表单（字段按 `meta.credentials` 生成，见 1.4 节）；
- 首次启动向导出现该供应商的配置步骤（“去申请”按钮跳 `meta.applyUrl`）；
- `GET /api/providers` 返回该供应商的配置状态；
- 凭据自动可用：`lib/config.js` 按 `meta.credentials` 处理该供应商的凭据，不用改 `config.js`。

发现失败时不会阻断启动：`meta` 缺失、或 `meta.name` 与文件名不符的模块会被跳过，并在启动日志里记一条 `warn`；文件本身加载失败（损坏、依赖缺失）同样记 `warn` 并跳过。启动后先看日志，确认没有关于新供应商的 `warn`，再往下验证（见 1.7 节）。

凭据来源优先级：设置页录入的（存在 `data/settings.json`）> 环境变量。同一供应商的两个来源按字段合并：设置页里非空的字段覆盖环境变量，缺失的字段仍可用环境变量补齐。路由里统一用 `ctx.config.getProvider(name)` 取凭据，不用关心它来自哪里。

### 1.4 凭据字段怎么定义

`meta.credentials` 是一个数组，每个元素定义一个凭据字段：

| 字段 | 说明 |
| --- | --- |
| `key` | 字段名，凭据对象里的键。现有约定：`apiKey`（密钥）、`accountId`（账号 ID）、`username`（用户名）、`proxyUrl`（代理地址）。新字段用驼峰命名 |
| `label` | 表单里显示的中文名，如 `API Key`、`账号 ID` |
| `type` | `password`（密钥类，掩码输入）或 `text`（普通文本，如 URL、用户名） |
| `env` | 对应的环境变量名，全大写下划线，如 `EXAMPLE_API_KEY` |
| `required` | 是否必填。必填字段为空时，该供应商显示为“未配置” |
| `placeholder` | 可选：输入框提示文字，不影响凭据逻辑；目前只有 InstaBox 的代理地址在用（`形如 https://3001-xxx.instabox.tech`） |

单字段供应商（只有一个 API Key）照 1.2 节示例写一行即可。需要多个字段的供应商写多行，例如 Cloudflare 需要两个字段：

```js
credentials: [
  { key: 'apiKey', label: 'API Token', type: 'password', env: 'CLOUDFLARE_API_TOKEN', required: true },
  { key: 'accountId', label: 'Account ID', type: 'text', env: 'CLOUDFLARE_ACCOUNT_ID', required: true },
],
```

Kaggle 也是两字段（`username` + `apiKey`），InstaBox 是一个 `text` 类型字段（`proxyUrl`，代理地址）。凭据字段定义好后，`config.js` 会自动处理该供应商的读取、合并与保存，不用改 `config.js`。

### 1.5 在 `.env.example` 里补环境变量

在 `.env.example` 末尾按现有分组格式追加：注释写清申请方式和官网地址，值用 `YOUR_<NAME>_HERE` 占位符，不要写真实 Key。以 Example AI 为例：

```bash
# ---- Example AI（对话，示例供应商）----
# Example AI API Key
# 申请：注册 Example AI 账号后，在控制台 API Keys 页创建。
# 官网：https://example.com
EXAMPLE_API_KEY=YOUR_EXAMPLE_API_KEY_HERE
```

本地验证时把值填进自己的 `.env`（`cp .env.example .env` 后编辑），也可以直接在站内设置页录入。`.env` 已被 `.gitignore` 忽略，绝不要提交。

### 1.6 接线到功能

注册表只负责发现、凭据与设置页展示。要让新供应商真正能在一个功能里被选中，还需要在该功能的路由和前端里接线。以对话为例，需要改三处：

1. 后端路由 `lib/routes/chat.js`：在供应商表里加新供应商（名字、显示名、默认模型），并在 `POST /api/chat` 的分发里加一个分支，调用 `ctx.providers.example.chat(...)`。
2. 前端下拉框 `public/index.html`：在对话页的 `<select id="chatProvider">` 里加一个 `<option>`，例如 `<option value="example">Example AI</option>`。
3. 模型配置 `lib/models.json`：在 `chat` 能力下给新供应商加一项（见第 3 节），否则前端没有模型可选。

其他能力同理：翻译接 `lib/routes/translate.js`，语音接 `lib/routes/voice.js`，向量接 `lib/routes/embed.js`，识图接 `lib/routes/analyze.js`。出图/生视频接 `lib/routes/generation.js`（见 1.1 节末尾的说明）。

### 1.7 测试验证

1. 跑全量测试，确认没有回归：

   ```bash
   npm test
   ```

2. 给新供应商加测试。在 `test/providers.test.js` 里按现有模式加：把 `global.fetch` 换成 stub，只用假 Key（`fake-key-xxx`），绝不调真实上游。至少覆盖“上游报错时抛中文错误”和“上游 200 时正常返回”两种情况：

   ```js
   test('example.chat：上游 401 时抛出中文错误，含 HTTP 401', async (t) => {
     stubFetch(t, async () => fakeResponse({
       status: 401,
       body: JSON.stringify({ error: { message: 'Incorrect API key provided' } }),
     }));
     await assert.rejects(
       () => example.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] }),
       /Example AI 返回 HTTP 401/,
     );
   });

   test('example.chat：上游 200 时正常返回文本（stub 冒烟）', async (t) => {
     stubFetch(t, async () => fakeResponse({
       status: 200,
       body: JSON.stringify({ choices: [{ message: { content: '你好，我是测试回复' } }] }),
     }));
     const result = await example.chat({ apiKey: FAKE_KEY, messages: [{ role: 'user', content: '你好' }] });
     assert.equal(result.text, '你好，我是测试回复');
   });
   ```

   其中 `stubFetch`、`fakeResponse`、`FAKE_KEY` 是 `test/providers.test.js` 里已有的辅助函数和常量，直接复用；文件顶部记得 `require` 新供应商模块（`const example = require('../lib/providers/example');`）。加完再跑一次 `npm test`。

3. 手动验证发现与配置：

   ```bash
   npm start
   ```

   - 启动日志里没有关于新供应商的 `warn`；
   - 打开 http://localhost:8080/api/providers ，能看到新供应商的名字和 `configured` 状态；
   - 打开站内设置页，能看到新供应商的表单，填入 Key 保存后显示“已配置”；
   - （接线后）在对应功能页选新供应商，实际跑一次确认能出结果。

4. 顺带验证失败保护：临时把 `meta.name` 改成与文件名不一致，重启后应看到一条 `warn` 且服务照常启动，其他功能不受影响；验证完改回来。

## 2. 加一个新功能页签

以一个“摘要”功能为例：输入一段文字，调用 Groq 对话能力生成一句话摘要。需要改三处：后端路由、前端 `<section>`、`FEATURES` 注册表。

### 2.1 后端：在 `lib/routes/` 新建路由文件

新建 `lib/routes/summarize.js`，导出 `registerRoutes(app, ctx)`。`server.js` 启动时自动加载 `lib/routes/*.js`，不用手动注册。`ctx` 的内容：

| 字段 | 说明 |
| --- | --- |
| `ctx.config` | 凭据：`getProvider(name)` / `isConfigured(name)` / `setProvider(name, creds)` |
| `ctx.store` | 存储：`readJSON(name, fallback)` / `writeJSON(name, data)` / `writeBlob` / `readBlob` |
| `ctx.usage` | 用量累计（Cloudflare Neurons、Kaggle 小时数） |
| `ctx.jobs` | 生成任务队列（出图/视频用，其他功能一般不用） |
| `ctx.providers` | 已发现的供应商模块，按名取，如 `ctx.providers.groq` |

完整最小示例：

```js
// lib/routes/summarize.js — 一句话摘要：POST /api/summarize
// body {text} → {ok:true, summary} 或 {ok:false, message}
// 用 Groq 对话能力生成摘要；Groq 未配置时返回 notConfigured。

function registerRoutes(app, ctx) {
  app.post('/api/summarize', async (req, res) => {
    try {
      const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
      if (!text) {
        return res.json({ ok: false, message: '要摘要的文字不能为空' });
      }
      if (text.length > 5000) {
        return res.json({ ok: false, message: '文字太长（最多 5000 字）' });
      }
      if (!await ctx.config.isConfigured('groq')) {
        return res.json({
          ok: false,
          notConfigured: true,
          message: 'Groq 未配置，请先在设置页填写 API Key',
        });
      }
      const creds = await ctx.config.getProvider('groq');
      const result = await ctx.providers.groq.chat({
        apiKey: creds.apiKey,
        model: 'openai/gpt-oss-120b',
        messages: [
          { role: 'system', content: '你是一个摘要助手。请把用户给出的文字浓缩成一句话摘要，只输出摘要本身，不要加解释。' },
          { role: 'user', content: text },
        ],
      });
      return res.json({ ok: true, summary: result.text });
    } catch (err) {
      return res.json({ ok: false, message: err.message || '生成摘要失败，请稍后重试' });
    }
  });
}

module.exports = { registerRoutes };
```

写路由时遵守现有约定：

- 成功返回 `{ ok: true, ... }`，失败返回 `{ ok: false, message: '中文原因' }`；供应商未配置时多加 `notConfigured: true`，前端会据此显示“去设置页配置”的提示。
- 先校验输入（空值、长度），再查配置，最后调供应商；任何一步失败都返回 `{ ok: false }`，不要裸奔 500。
- `async` 处理函数里用 `try/catch` 包住，`catch` 里返回统一的失败格式。
- JSON body 上限是 15MB（`server.js` 里定的，要传 base64 图片/音频才需要这么大；纯文本接口不用关心）。
- 路由文件加载失败时 `server.js` 只记日志、不阻断启动——所以新路由写完后要看启动日志确认它被加载了（启动日志会打印“已加载路由”列表）。

### 2.2 前端：在 `public/index.html` 加 `<section>`

在 `<main>` 里、其他 `<section>` 之后，加一个 `<section>`。`id` 必须是 `panel-<id>`，`<id>` 与 2.3 节 `FEATURES` 里的 `id` 一致。样式类照现有页签用（`card` / `field-label` / `btn primary btn-block` / `error hidden` / `result-box hidden`），不用写新 CSS。

```html
<!-- ============ 摘要 ============ -->
<section class="tab-panel" id="panel-summarize">
  <div class="card">
    <label class="field-label" for="summarizeInput">原文</label>
    <textarea id="summarizeInput" rows="5" placeholder="输入要摘要的文字（最多 5000 字）"></textarea>
    <div id="summarizeNotConfigured" class="notice hidden"></div>
    <button class="btn primary btn-block" id="summarizeBtn">生成摘要</button>
    <p class="error hidden" id="summarizeError"></p>
    <label class="field-label" for="summarizeResult">摘要</label>
    <div id="summarizeResult" class="result-box hidden"></div>
  </div>
</section>
```

注意：不要在 `index.html` 里手写页签按钮。页签按钮由 `FEATURES` 注册表自动生成（见 2.3 节），只加 `<section>` 就够了。

### 2.3 前端：在 `public/app.js` 的 `FEATURES` 注册表里加一项

`public/app.js` 顶部的 `FEATURES` 注册表定义了所有页签，启动时按它动态生成 tab 按钮。加一项：

```js
{ id: 'summarize', label: '摘要', onShow: initSummarize },
```

注册表项的字段：

| 字段 | 说明 |
| --- | --- |
| `id` | 页签 id，与 `<section id="panel-<id>">` 对应 |
| `label` | tab 按钮上显示的文字 |
| `onShow` | 切换到该页签时调用的函数；没有首次加载需求可以不写 |

再在文件里补上处理函数（放在其他页签的处理函数附近）。`onShow` 每次切换到该页签都会调用，事件绑定要加守卫防止重复绑定：

```js
let summarizeBound = false;

function initSummarize() {
  if (summarizeBound) return;
  summarizeBound = true;
  $('summarizeBtn').addEventListener('click', async () => {
    hideError($('summarizeError'));
    $('summarizeResult').classList.add('hidden');
    const text = $('summarizeInput').value.trim();
    if (!text) {
      showError($('summarizeError'), '请输入要摘要的文字');
      return;
    }
    try {
      const data = await postJSON('/api/summarize', { text });
      $('summarizeResult').textContent = data.summary;
      $('summarizeResult').classList.remove('hidden');
    } catch (e) {
      showError($('summarizeError'), e.message);
    }
  });
}
```

其中 `$`、`hideError`、`showError`、`postJSON` 都是 `app.js` 里已有的辅助函数，直接复用：`postJSON(path, body)` 发 POST 请求，返回解析后的 JSON；后端返回 `{ ok: false }` 时它会抛 `Error`（`message` 即后端的中文原因，`notConfigured` 标记会挂在错误对象上）。未配置提示可以用现成的 `setNotConfigured(el, providerName)` 显示（用法见对话页的 `refreshChatNotConfigured`）。

### 2.4 验证

```bash
npm test   # 后端测试全部通过
npm start  # 启动，确认日志里“已加载路由”包含 summarize.js
```

打开 http://localhost:8080，点“摘要”页签：未配 Groq 时应显示未配置提示；配好后输入一段文字，应能生成摘要并显示在结果框里。

## 3. 改模型配置

模型配置在 `lib/models.json`，后端 `lib/models.js` 提供读取接口，前端调 `GET /api/models` 读取。改模型只改 `lib/models.json`，不用改代码。

### 3.1 `lib/models.json` 的结构

顶层按能力分 7 个键：`chat`（对话）、`vision`（识图）、`image`（出图）、`translate`（翻译）、`tts`（语音合成）、`stt`（语音转文字）、`embed`（向量）。每个能力下按供应商分，每项是 `{ default, models: [{ id, label }] }`：

- `default`：默认模型的 `id`，必须是 `models` 里已有的 `id`；
- `models`：可用模型列表，每项 `{ id, label }`，`id` 是调用供应商接口时用的模型名，`label` 是前端下拉框里显示的名字；
- 例外：`tts` 下的 `elevenlabs` 不用 `models`，用 `voices` 数组（每项也是 `{ id, label }`，`id` 是 ElevenLabs 音色 ID，`default` 是默认音色的 `id`）。

以 `chat` 和 `tts` 为例（完整内容，其他能力结构相同）：

```json
{
  "chat": {
    "zhipu": {
      "default": "glm-4.7-flash",
      "models": [
        { "id": "glm-4.7-flash", "label": "GLM-4.7-Flash" },
        { "id": "glm-4.5-flash", "label": "GLM-4.5-Flash" }
      ]
    },
    "groq": {
      "default": "openai/gpt-oss-120b",
      "models": [
        { "id": "openai/gpt-oss-120b", "label": "gpt-oss-120b" },
        { "id": "openai/gpt-oss-20b", "label": "gpt-oss-20b" },
        { "id": "qwen/qwen3.8-27b", "label": "Qwen3 8-27b" }
      ]
    },
    "cloudflare": {
      "default": "@cf/meta/llama-3.1-8b-instruct-fp8",
      "models": [
        { "id": "@cf/meta/llama-3.1-8b-instruct-fp8", "label": "Llama-3.1-8B-Instruct" }
      ]
    },
    "gemini": {
      "default": "gemini-3.8-flash",
      "models": [
        { "id": "gemini-3.8-flash", "label": "Gemini 3.8 Flash" },
        { "id": "gemini-3.5-flash-lite", "label": "Gemini 3.5 Flash-Lite" }
      ]
    }
  },
  "tts": {
    "cloudflare": {
      "default": "@cf/myshell-ai/melotts",
      "models": [
        { "id": "@cf/myshell-ai/melotts", "label": "MeloTTS" }
      ]
    },
    "elevenlabs": {
      "default": "EXAVITQu4vr4xnSDxMaL",
      "voices": [
        { "id": "EXAVITQu4vr4xnSDxMaL", "label": "Sarah" },
        { "id": "Xb7hH8MSUJpSbSDYk0k2", "label": "Alice" },
        { "id": "pNInz6obpgDQGcFmaJgB", "label": "Adam" },
        { "id": "hpp4J3VqNfWAUOO0d1Us", "label": "Bella" },
        { "id": "JBFqnCBsd6RMkjVDRZzb", "label": "George" }
      ]
    }
  }
}
```

其他能力现有的模型（以 `lib/models.json` 为准）：

| 能力 | 供应商 | 现有模型 |
| --- | --- | --- |
| `vision` | zhipu | `glm-4.6v-flash` |
| `vision` | siliconflow | `PaddlePaddle/PaddleOCR-VL-1.5`（OCR） |
| `vision` | gemini | `gemini-3.8-flash` |
| `image` | cloudflare | `@cf/black-forest-labs/flux-1-schnell` |
| `translate` | cloudflare | `@cf/meta/m2m100-1.2b` |
| `translate` | siliconflow | `tencent/Hunyuan-MT-7B` |
| `stt` | groq | `whisper-large-v3-turbo` |
| `stt` | cloudflare | `@cf/openai/whisper-large-v3-turbo` |
| `stt` | siliconflow | `FunAudioLLM/SenseVoiceSmall` |
| `embed` | cloudflare | `@cf/baai/bge-m3` |
| `embed` | siliconflow | `BAAI/bge-m3` |

说明：DeepL 翻译没有模型概念，InstaBox / Kaggle 出图和视频走本地模型或 kernel，不在 `models.json` 里。只有一个固定模型的供应商也按 `{ default, models }` 结构写（`models` 里只有一项）。

后端 `lib/models.js` 提供的接口：

```js
const models = require('../models');

models.getModels('chat', 'groq');               // [{id, label}, ...]
models.getDefaultModel('chat', 'groq');         // 'openai/gpt-oss-120b'
models.isSupported('chat', 'groq', 'openai/gpt-oss-20b');  // true
models.getVoices('elevenlabs');                 // [{id, label}, ...]
models.getAll();                                // 整份 models.json 内容
```

路由用 `isSupported` 校验请求里的模型是否可用，用 `getDefaultModel` 取默认模型；前端通过 `GET /api/models` 读到整份配置后渲染模型下拉框。

### 3.2 换默认模型

改对应项的 `default`，值必须是 `models` 里已有的 `id`。例如把 Groq 对话默认模型从 `openai/gpt-oss-120b` 换成 `openai/gpt-oss-20b`：

```json
"groq": {
  "default": "openai/gpt-oss-20b",
  "models": [
    { "id": "openai/gpt-oss-120b", "label": "gpt-oss-120b" },
    { "id": "openai/gpt-oss-20b", "label": "gpt-oss-20b" },
    { "id": "qwen/qwen3.8-27b", "label": "Qwen3 8-27b" }
  ]
}
```

只改 `default` 这一行，其他不动。

### 3.3 加一个模型

在对应供应商的 `models` 数组里加一项 `{ id, label }`。例如给 Groq 加一个模型：

```json
{ "id": "openai/gpt-oss-120b", "label": "gpt-oss-120b" },
{ "id": "openai/gpt-oss-20b", "label": "gpt-oss-20b" },
{ "id": "qwen/qwen3.8-27b", "label": "Qwen3 8-27b" },
{ "id": "openai/gpt-oss-safeguard-20b", "label": "gpt-oss-safeguard-20b" }
```

加模型前确认两件事：该模型在供应商的免费档里可用（不要加付费模型）；`id` 与供应商接口文档里的模型名完全一致（大小写、斜杠都要对）。如果想让新模型成为默认，同步改 `default`。改完后跑 `npm test`，再实际发一次请求确认新模型可用——如果供应商返回“不支持模型”，说明供应商模块里还有模型白名单校验，需要同步修改。

### 3.4 加一个音色

在 `tts.elevenlabs.voices` 里加一项 `{ id, label }`，`id` 是 ElevenLabs 音色 ID：

```json
{ "id": "EXAVITQu4vr4xnSDxMaL", "label": "Sarah" },
{ "id": "Xb7hH8MSUJpSbSDYk0k2", "label": "Alice" },
{ "id": "PREMADE_VOICE_ID_HERE", "label": "新音色" }
```

注意：免费账号只能用 premade 音色（library 音色调 API 会返回 402），所以只加 premade 音色——音色 ID 从 ElevenLabs 音色库里筛选 premade 类别获取，不要加 Rachel（`21m00Tcm4TlvDq8ikWAM`）这类 library 音色。想让新音色成为默认，同步改 `tts.elevenlabs.default`。

### 3.5 改完要重启吗

要重启。`lib/models.js` 在加载时读入并校验 `lib/models.json`，之后一直用内存里的配置，改完后必须重启服务才生效：

```bash
# Ctrl+C 停掉，再启动
npm start
```

配置写错时启动即失败并打印清晰的中文错误：JSON 格式错、`default` 不在 `models` / `voices` 列表里、某一项缺少 `id` 或 `label` 都属于非法，按报错信息修正即可。也可以先跑 `npm test`——`test/models.test.js` 断言配置值与已知正确的模型 id 一致，改完先跑测试能提前发现改错。

只改前端文件（`public/` 下的 HTML/JS/CSS）不用重启，刷新浏览器即可。改 `lib/` 下的任何文件（供应商、路由、`models.json`、`models.js`）都要重启。

## 4. 注意事项

- **不要提交真实 Key。** 文档、示例、测试里只用 `YOUR_API_KEY_HERE` 这类占位符和 `fake-key-xxx` 这类假 Key；`.env` 和 `data/` 已被 `.gitignore` 忽略，绝不要强行提交。
- **只用免费额度。** 新供应商、新模型、新功能必须能在免费档里跑通，不要加任何需要付费计划或绑卡的功能；额度说明以各家官网为准。
- **跑 `npm test`。** 改完代码或配置后跑全量测试；加了供应商或路由要补对应的测试（stub `fetch`，不联网，不调真实上游）。
- **行为保持一致。** 新接口沿用现有约定：成功 `{ ok: true, ... }`、失败 `{ ok: false, message: '中文原因' }`、未配置加 `notConfigured: true`；报错信息用中文并带上游 HTTP 状态；请求加超时；日志里不要打印 Key；InstaBox 代理地址只走环境变量，不要硬编码到代码或文档里。
- **先讨论再做大改动。** 加新功能前请先开 issue 描述想加什么、怎么接现有结构，达成一致后再写代码（见 [CONTRIBUTING.md](../CONTRIBUTING.md)）。

相关文档：[README.md](../README.md)（功能清单、环境变量、本地运行）、[CONTRIBUTING.md](../CONTRIBUTING.md)（提 PR 的流程）、[CLOUDRUN.md](CLOUDRUN.md)（部署到 Cloud Run）。
