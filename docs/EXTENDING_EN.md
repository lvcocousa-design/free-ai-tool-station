# Extending Guide

中文版：[EXTENDING.md](EXTENDING.md)

This guide explains how to extend the Free AI Tool Station (self-hosted edition): add a new provider, add a new feature tab, and change model configuration. Follow it step by step — no guessing required.

Prerequisites: get the project running locally first, following "Run locally" in [README_EN.md](../README_EN.md) (requires Node.js >= 18), and confirm `npm start` serves http://localhost:8080.

Key files:

| File | Purpose |
| --- | --- |
| `lib/providers/<name>.js` | One file per provider, exporting `meta` + capability methods |
| `lib/provider-registry.js` | Discovers providers automatically by scanning `lib/providers/*.js` at startup |
| `lib/config.js` | Handles credentials automatically from `meta.credentials` (settings page > environment variables) |
| `lib/models.json` | Model configuration (grouped by capability, see Section 3) |
| `lib/models.js` | Backend API for reading `lib/models.json` |
| `lib/routes/*.js` | One route group per feature, exporting `registerRoutes(app, ctx)` |
| `server.js` | Entry point, auto-loads `lib/routes/*.js` at startup |
| `public/index.html` | Frontend page, one `<section>` per tab |
| `public/app.js` | Frontend logic, `FEATURES` registry at the top defines the tabs |
| `.env.example` | Environment variable examples; new providers add their variables here |

## 1. Add a new provider

We walk through the whole flow with a fictional provider, "Example AI" (an OpenAI-compatible API offering only chat).

### 1.1 The provider interface

Create `lib/providers/<name>.js` exporting an object. `meta.name` must match the file name (file `example.js` means `name` must be `'example'`), otherwise the registry logs a `warn` and skips the module.

```js
module.exports = {
  meta: {
    name: 'example',           // must match the file name
    label: 'Example AI',       // name shown on the settings page and in the wizard
    quotaNote: 'Free-tier note',  // free-tier description shown on the settings page
    applyUrl: 'https://example.com/keys',  // "Get a key" link in the wizard
    order: 100,                // display order, see the order table below
    capabilities: ['chat'],    // capabilities this provider offers, see the table below
    credentials: [
      { key: 'apiKey', label: 'API Key', type: 'password', env: 'EXAMPLE_API_KEY', required: true },
    ],
  },
  test: async (creds) => ({ ok: true }),       // required: connection test
  getUsage: async (creds) => ({ used, limit, unit }),  // optional: usage query; return null if there is no usage API
  // Capability methods: implement the functions matching capabilities
  chat: async ({ apiKey, model, messages }) => ({ text, model }),
};
```

`meta` fields:

| Field | Required | Description |
| --- | --- | --- |
| `name` | Yes | Provider name, must match the file name, lowercase letters |
| `label` | Yes | Display name, e.g. `Example AI` |
| `quotaNote` | Yes | Free-tier description shown on the settings page; write it truthfully per the official site |
| `applyUrl` | Yes | Where to get a key; the wizard's "Get a key" button links here |
| `order` | Yes | Display order on the settings page and in the wizard; smaller numbers come first |
| `capabilities` | Yes | Capability list; values are in the table below |
| `credentials` | Yes | Credential field definitions, see Section 1.4 |

Existing providers' `order`: zhipu 10, groq 20, cloudflare 30, deepl 40, elevenlabs 50, siliconflow 60, kaggle 70, instabox 80, gemini 90, nvidia 95. New providers start at 100 and count up (100, 110, 120, …); do not insert numbers between existing ones.

`capabilities` values and their functions:

| Capability | Function | Signature (current convention) |
| --- | --- | --- |
| `chat` | `chat` | `chat({ apiKey, model, messages })` → `{ text, model }`; `messages` is OpenAI-format `[{ role, content }]` |
| `vision` | `visionQA` / `ocr` | Asking questions uses `visionQA({ apiKey, imageBase64, mimeType, question })` → `{ text, model }`; OCR text extraction uses `ocr({ apiKey, imageBase64, mimeType })` → `{ text, model }` |
| `translate` | `translate` | `translate({ apiKey, text, sourceLang, targetLang })` → `{ text }`; `sourceLang` may be empty (auto-detect) |
| `tts` | `tts` | `tts({ apiKey, text, voiceId?, lang? })` → `Buffer` (audio bytes) |
| `stt` | `transcribe` | `transcribe({ apiKey, audioBuffer, filename? })` → `string` (transcribed text) |
| `embed` | `embed` | `embed({ apiKey, texts })` → `{ embeddings, model }`; `texts` is an array of strings |
| `image` | — | No unified function signature yet, see the note below |
| `video` | — | No unified function signature yet, see the note below |

Notes:

- A capability method's first argument object carries both credential fields (e.g. `apiKey`) and call parameters (e.g. `model`, `messages`). Routes fetch credentials with `ctx.config.getProvider(name)` and pass them in; provider modules must not read environment variables or `settings.json` themselves.
- Providers needing two credential fields (e.g. Cloudflare needs `accountId` + `apiKey`) take an extra parameter in capability methods, e.g. `chat({ accountId, apiKey, model, messages })`.
- `image` / `video` have no unified function signature yet: the three existing backends each use their own functions (InstaBox uses `generate` / `getProgress` / `fetchImage`, Kaggle uses `submitImageJob` / `submitVideoJob` / `getStatus`, Cloudflare uses `generateImage`), and `lib/routes/generation.js` calls those provider-specific functions directly. A new provider offering image or video generation also needs wiring in `lib/routes/generation.js` following the existing backend pattern — the provider file alone is not enough.
- All capability methods: on upstream errors, throw a Chinese `Error` following existing providers (`Groq 返回 HTTP 401：……`, `请求 Groq 超时（120 秒无响应）`); set a request timeout (`AbortSignal.timeout(60000)` at minimum, 120 seconds for chat).

`test(creds)`: required. `creds` is the provider's credential object. Do one lightweight probe (e.g. request the `/v1/models` list); return `{ ok: true }` if the key is valid, or `{ ok: false, message: '中文原因' }` if not. Return an object — do not throw — because the wizard calls it via `POST /api/providers/:name/test` and judges by the return value. Do not probe with a quota-consuming generation call. Every existing provider's `test()` uses the `probe` / `bearer` helpers from `lib/probe.js` (a one-line call that never throws and translates 401s, timeouts, and network errors into Chinese reasons); new providers should do the same (see the Section 1.2 example).

`getUsage(creds)`: optional. Implement it if the provider has a usage API, returning `{ used, limit, unit }` (e.g. `{ used: 1200, limit: 1000000, unit: 'characters' }` — both DeepL and ElevenLabs use `'characters'` as the `unit`); on query failure (unauthorized, network error, malformed response) return `null` instead of throwing, so the caller keeps the old value; return `null` — or omit the function — if there is no usage API.

### 1.2 Minimal example: `lib/providers/example.js`

Below is the complete, copyable minimal example. Example AI is a fictional provider with an OpenAI-compatible chat API, demonstrating `chat` + `test` + `getUsage`. Save it as `lib/providers/example.js` and it will be auto-discovered at startup (the API endpoint is fictional, so real calls will fail — that is expected; the point of the example is the file structure). Note: the example's models are first registered in `lib/models.json` under `chat.example` (see Section 3), then read via `lib/models.js` — do not hardcode model lists in provider files.

```js
// lib/providers/example.js — Example provider (fictional, minimal example for the extending guide)
// Talks to the fictional Example AI, an OpenAI-compatible API, demonstrating
// chat + test + getUsage.
// The key is passed in by the caller (from config); this file stores no real key.

const { probe, bearer } = require('../probe');
const models = require('../models');

const BASE_URL = 'https://api.example.com/v1';

// Models come from chat.example in lib/models.json (see Section 3); do not hardcode them.
const CHAT_MODELS = models.getModels('chat', 'example').map((m) => m.id);

function extractErrorMessage(bodyText) {
  try {
    const data = JSON.parse(bodyText);
    if (data?.error?.message) return data.error.message;
    if (typeof data?.message === 'string') return data.message;
  } catch { /* not JSON, use the raw text */ }
  return bodyText.slice(0, 300);
}

// Chat
// chat({apiKey, model, messages}) → {text, model}
// messages: [{role:'user'|'assistant'|'system', content}] (OpenAI format)
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

// Connection test: probe GET /v1/models; any 2xx status means the key is valid.
// test(creds) → {ok:true} or {ok:false, message} (do not throw)
// probe() itself never throws: 2xx returns {ok:true}, otherwise {ok:false} with a Chinese reason.
async function test(creds = {}) {
  try {
    return await probe(`${BASE_URL}/models`, { headers: bearer(creds.apiKey) });
  } catch (err) {
    return { ok: false, message: '连接测试异常，请稍后重试' };
  }
}

// Usage query: GET /v1/usage → {used, limit, unit}; return null on failure, never throw;
// providers without a usage API just return null (or omit getUsage).
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

Checklist after writing: `meta.name` matches the file name; `test` returns an object instead of throwing; error messages are in Chinese; no real key is written anywhere (the example only uses the `YOUR_API_KEY_HERE` placeholder, see Section 1.5).

### 1.3 Auto-discovery

No manual registration is needed anywhere. At startup, `lib/provider-registry.js` scans `lib/providers/*.js`, `require`s each file, and reads its `meta`. Once discovered, the following work automatically:

- the settings page shows a configuration form for the provider (fields generated from `meta.credentials`, see Section 1.4);
- the first-run wizard shows a setup step for the provider (the "Get a key" button links to `meta.applyUrl`);
- `GET /api/providers` returns the provider's configuration status;
- credentials work automatically: `lib/config.js` handles the provider's credentials from `meta.credentials` — no change to `config.js` is needed.

Discovery failure never blocks startup: a module with missing `meta`, or with `meta.name` not matching its file name, is skipped with a `warn` in the startup log; a file that fails to load at all (corrupted, missing dependency) is likewise skipped with a `warn`. After starting, check the log first for any `warn` about the new provider before moving on (see Section 1.7).

Credential precedence: settings page entries (stored in `data/settings.json`) > environment variables. The two sources merge per field: a non-empty settings value overrides the environment variable, while a missing field still falls back to the environment variable. Routes always use `ctx.config.getProvider(name)` to fetch credentials and do not care where they came from.

### 1.4 Defining credential fields

`meta.credentials` is an array; each element defines one credential field:

| Field | Description |
| --- | --- |
| `key` | Field name, the key in the credential object. Current conventions: `apiKey` (secret key), `accountId` (account ID), `username` (username), `proxyUrl` (proxy URL). New fields use camelCase |
| `label` | Label shown in the form, e.g. `API Key`, `账号 ID` |
| `type` | `password` (secret, masked input) or `text` (plain text, e.g. URLs, usernames) |
| `env` | The matching environment variable name, all-caps with underscores, e.g. `EXAMPLE_API_KEY` |
| `required` | Whether it is required. If a required field is empty, the provider shows as "not configured" |
| `placeholder` | Optional: input hint text; does not affect credential logic. Currently only InstaBox's proxy URL uses one (`形如 https://3001-xxx.instabox.tech`) |

A single-key provider needs just one line, as in the Section 1.2 example. A provider needing several fields lists several, e.g. Cloudflare needs two fields:

```js
credentials: [
  { key: 'apiKey', label: 'API Token', type: 'password', env: 'CLOUDFLARE_API_TOKEN', required: true },
  { key: 'accountId', label: 'Account ID', type: 'text', env: 'CLOUDFLARE_ACCOUNT_ID', required: true },
],
```

Kaggle also has two fields (`username` + `apiKey`); InstaBox has one `text` field (`proxyUrl`, the proxy URL). Once the credential fields are defined, `config.js` automatically handles reading, merging, and saving them — no change to `config.js` is needed.

### 1.5 Adding environment variables to `.env.example`

Append a block at the end of `.env.example` in the existing grouped format: comments explaining how to apply and the official site, with a `YOUR_<NAME>_HERE` placeholder as the value — never a real key. Example AI:

```bash
# ---- Example AI（对话，示例供应商）----
# Example AI API Key
# 申请：注册 Example AI 账号后，在控制台 API Keys 页创建。
# 官网：https://example.com
EXAMPLE_API_KEY=YOUR_EXAMPLE_API_KEY_HERE
```

For local verification, put the value in your own `.env` (`cp .env.example .env`, then edit), or enter it on the in-app settings page. `.env` is ignored by `.gitignore` — never commit it.

### 1.6 Wiring the provider into features

The registry only handles discovery, credentials, and settings-page display. To make a new provider actually selectable in a feature, wire it into that feature's route and frontend. For chat, three places need changes:

1. Backend route `lib/routes/chat.js`: add the new provider to the provider table (name, display name, default model) and add a branch in `POST /api/chat` dispatching to `ctx.providers.example.chat(...)`.
2. Frontend dropdown in `public/index.html`: add an `<option>` to the chat page's `<select id="chatProvider">`, e.g. `<option value="example">Example AI</option>`.
3. Model configuration `lib/models.json`: add an entry for the new provider under the `chat` capability (see Section 3), otherwise the frontend has no model to offer.

Other capabilities follow the same pattern: translation wires into `lib/routes/translate.js`, voice into `lib/routes/voice.js`, embedding into `lib/routes/embed.js`, image analysis into `lib/routes/analyze.js`. Image/video generation wires into `lib/routes/generation.js` (see the note at the end of Section 1.1).

### 1.7 Verifying with tests

1. Run the full test suite to confirm no regressions:

   ```bash
   npm test
   ```

2. Add tests for the new provider. Follow the existing pattern in `test/providers.test.js`: replace `global.fetch` with a stub and use only the fake key (`fake-key-xxx`) — never call the real upstream. Cover at least "upstream error throws a Chinese error" and "upstream 200 returns normally":

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

   `stubFetch`, `fakeResponse`, and `FAKE_KEY` are helpers and constants already defined in `test/providers.test.js` — reuse them; remember to `require` the new provider module at the top of the file (`const example = require('../lib/providers/example');`). Run `npm test` again after adding the tests.

3. Verify discovery and configuration by hand:

   ```bash
   npm start
   ```

   - No `warn` about the new provider in the startup log;
   - http://localhost:8080/api/providers shows the new provider's name and `configured` status;
   - the in-app settings page shows the new provider's form; entering a key and saving shows "已配置";
   - (after wiring) select the new provider on the corresponding feature tab and run it once to confirm it produces a result.

4. Also verify the failure guard: temporarily change `meta.name` so it no longer matches the file name; after restart there should be a `warn` and the service should still start normally with other features unaffected. Change it back afterwards.

## 2. Add a new feature tab

Take a "Summarize" feature as an example: enter a paragraph and get a one-sentence summary via Groq chat. Three places need changes: the backend route, the frontend `<section>`, and the `FEATURES` registry.

### 2.1 Backend: create a route file in `lib/routes/`

Create `lib/routes/summarize.js` exporting `registerRoutes(app, ctx)`. `server.js` auto-loads `lib/routes/*.js` at startup, so no manual registration is needed. `ctx` contains:

| Field | Description |
| --- | --- |
| `ctx.config` | Credentials: `getProvider(name)` / `isConfigured(name)` / `setProvider(name, creds)` |
| `ctx.store` | Storage: `readJSON(name, fallback)` / `writeJSON(name, data)` / `writeBlob` / `readBlob` |
| `ctx.usage` | Usage accumulation (Cloudflare Neurons, Kaggle GPU hours) |
| `ctx.jobs` | Generation job queue (image/video only; other features generally do not need it) |
| `ctx.providers` | Discovered provider modules, accessed by name, e.g. `ctx.providers.groq` |

Complete minimal example:

```js
// lib/routes/summarize.js — One-sentence summary: POST /api/summarize
// body {text} → {ok:true, summary} or {ok:false, message}
// Summarizes with Groq chat; returns notConfigured when Groq is not set up.

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

Follow the existing conventions when writing routes:

- Success returns `{ ok: true, ... }`, failure returns `{ ok: false, message: '中文原因' }`; when a provider is not configured, add `notConfigured: true` so the frontend shows a "go to the settings page" prompt.
- Validate input first (empty values, length), then check configuration, then call the provider; every failure returns `{ ok: false }` — never a bare 500.
- Wrap `async` handlers in `try/catch` and return the uniform failure format from `catch`.
- The JSON body limit is 15MB (set in `server.js`; only base64 image/audio uploads need that much — plain-text endpoints do not need to care).
- A route file that fails to load is only logged by `server.js` and does not block startup — so after adding a route, check the startup log to confirm it was loaded (the log prints the "已加载路由" list).

### 2.2 Frontend: add a `<section>` in `public/index.html`

Inside `<main>`, after the other `<section>` elements, add a `<section>`. Its `id` must be `panel-<id>`, where `<id>` matches the `id` in the `FEATURES` registry (Section 2.3). Reuse the existing tab style classes (`card` / `field-label` / `btn primary btn-block` / `error hidden` / `result-box hidden`) — no new CSS is needed.

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

Note: do not hand-write a tab button in `index.html`. Tab buttons are generated automatically from the `FEATURES` registry (see Section 2.3); adding the `<section>` is enough.

### 2.3 Frontend: add an entry to the `FEATURES` registry in `public/app.js`

The `FEATURES` registry at the top of `public/app.js` defines all tabs; tab buttons are generated from it at startup. Add one entry:

```js
{ id: 'summarize', label: '摘要', onShow: initSummarize },
```

Registry entry fields:

| Field | Description |
| --- | --- |
| `id` | Tab id, matching `<section id="panel-<id>">` |
| `label` | Text shown on the tab button |
| `onShow` | Function called when switching to this tab; omit it if there is nothing to load on first show |

Then add the handler function in the file (near the other tabs' handlers). `onShow` runs every time the tab is shown, so guard event binding against duplicate registration:

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

`$`, `hideError`, `showError`, and `postJSON` are helpers already defined in `app.js` — reuse them: `postJSON(path, body)` sends a POST request and returns the parsed JSON; when the backend returns `{ ok: false }` it throws an `Error` (with `message` set to the backend's Chinese reason and a `notConfigured` flag attached). Use the existing `setNotConfigured(el, providerName)` to show the not-configured prompt (see `refreshChatNotConfigured` on the chat tab for usage).

### 2.4 Verification

```bash
npm test   # all backend tests pass
npm start  # start up; confirm the log's "已加载路由" list includes summarize.js
```

Open http://localhost:8080 and click the "摘要" tab: with Groq unconfigured it should show the not-configured prompt; once configured, entering a paragraph should produce a summary in the result box.

## 3. Change model configuration

Model configuration lives in `lib/models.json`. The backend reads it through `lib/models.js`, and the frontend reads it via `GET /api/models`. Changing models only means editing `lib/models.json` — no code changes.

### 3.1 Structure of `lib/models.json`

The top level is grouped by capability into 7 keys: `chat`, `vision`, `image`, `translate`, `tts`, `stt`, `embed`. Each capability is grouped by provider, and each entry is `{ default, models: [{ id, label }] }`:

- `default`: the `id` of the default model; it must be one of the `id`s in `models`;
- `models`: the list of available models, each `{ id, label }` — `id` is the model name used when calling the provider's API, `label` is the name shown in the frontend dropdown;
- exception: `elevenlabs` under `tts` uses a `voices` array instead of `models` (each entry is also `{ id, label }`, where `id` is an ElevenLabs voice ID and `default` is the default voice's `id`).

`chat` and `tts` as examples (complete; other capabilities follow the same structure):

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

Existing models for the other capabilities (authoritative source: `lib/models.json`):

| Capability | Provider | Existing models |
| --- | --- | --- |
| `vision` | zhipu | `glm-4.6v-flash` |
| `vision` | siliconflow | `PaddlePaddle/PaddleOCR-VL-1.5` (OCR) |
| `vision` | gemini | `gemini-3.8-flash` |
| `image` | cloudflare | `@cf/black-forest-labs/flux-1-schnell` |
| `translate` | cloudflare | `@cf/meta/m2m100-1.2b` |
| `translate` | siliconflow | `tencent/Hunyuan-MT-7B` |
| `stt` | groq | `whisper-large-v3-turbo` |
| `stt` | cloudflare | `@cf/openai/whisper-large-v3-turbo` |
| `stt` | siliconflow | `FunAudioLLM/SenseVoiceSmall` |
| `embed` | cloudflare | `@cf/baai/bge-m3` |
| `embed` | siliconflow | `BAAI/bge-m3` |

Notes: DeepL translation has no model concept, and InstaBox / Kaggle image and video generation use local models or kernels — none of these live in `models.json`. A provider with a single fixed model still follows the `{ default, models }` structure (with one entry in `models`).

Backend API in `lib/models.js`:

```js
const models = require('../models');

models.getModels('chat', 'groq');               // [{id, label}, ...]
models.getDefaultModel('chat', 'groq');         // 'openai/gpt-oss-120b'
models.isSupported('chat', 'groq', 'openai/gpt-oss-20b');  // true
models.getVoices('elevenlabs');                 // [{id, label}, ...]
models.getAll();                                // the whole models.json content
```

Routes use `isSupported` to validate the model in a request and `getDefaultModel` to get the default model; the frontend fetches the whole configuration via `GET /api/models` and renders the model dropdowns from it.

### 3.2 Change the default model

Change the `default` of the corresponding entry; the value must be an `id` already in `models`. For example, to switch Groq's default chat model from `openai/gpt-oss-120b` to `openai/gpt-oss-20b`:

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

Only the `default` line changes; everything else stays.

### 3.3 Add a model

Add a `{ id, label }` entry to the provider's `models` array. For example, adding a model for Groq:

```json
{ "id": "openai/gpt-oss-120b", "label": "gpt-oss-120b" },
{ "id": "openai/gpt-oss-20b", "label": "gpt-oss-20b" },
{ "id": "qwen/qwen3.8-27b", "label": "Qwen3 8-27b" },
{ "id": "openai/gpt-oss-safeguard-20b", "label": "gpt-oss-safeguard-20b" }
```

Before adding a model, confirm two things: the model is available on the provider's free tier (never add a paid model), and the `id` matches the model name in the provider's API docs exactly (case and slashes included). To make the new model the default, update `default` as well. After editing, run `npm test` and send a real request to confirm the new model works — if the provider replies "unsupported model", its provider module still has a model allowlist that needs updating too.

### 3.4 Add a voice

Add a `{ id, label }` entry to `tts.elevenlabs.voices`, where `id` is the ElevenLabs voice ID:

```json
{ "id": "EXAVITQu4vr4xnSDxMaL", "label": "Sarah" },
{ "id": "Xb7hH8MSUJpSbSDYk0k2", "label": "Alice" },
{ "id": "PREMADE_VOICE_ID_HERE", "label": "New voice" }
```

Note: free accounts can only use premade voices (calling a library voice returns 402), so only add premade voices — get the voice ID from the ElevenLabs voice library filtered to the premade category, and do not add library voices such as Rachel (`21m00Tcm4TlvDq8ikWAM`). To make the new voice the default, update `tts.elevenlabs.default` as well.

### 3.5 Does it need a restart?

Yes. `lib/models.js` reads and validates `lib/models.json` when it loads, and keeps using the in-memory configuration afterwards, so the service must be restarted for changes to take effect:

```bash
# Stop with Ctrl+C, then start again
npm start
```

An invalid configuration fails startup with a clear Chinese error: malformed JSON, a `default` that is not in the `models` / `voices` list, or an entry missing `id` or `label` are all invalid — fix them per the error message. You can also run `npm test` first — `test/models.test.js` asserts the configured values match the known-correct model ids, so running tests after editing catches mistakes early.

Frontend-only changes (files under `public/`) do not need a restart — just refresh the browser. Any change under `lib/` (providers, routes, `models.json`, `models.js`) requires a restart.

## 4. Notes

- **Never commit real keys.** Use placeholders like `YOUR_API_KEY_HERE` in docs and examples and fake keys like `fake-key-xxx` in tests; `.env` and `data/` are ignored by `.gitignore` — never force-commit them.
- **Free tiers only.** New providers, models, and features must work within free quotas — do not add anything that requires a paid plan or a bound card; quota descriptions follow each provider's official site.
- **Run `npm test`.** Run the full test suite after changing code or configuration; new providers or routes need matching tests (stub `fetch`, no network, no real upstream calls).
- **Stay consistent.** New endpoints follow the existing conventions: success `{ ok: true, ... }`, failure `{ ok: false, message: '中文原因' }`, unconfigured providers add `notConfigured: true`; error messages in Chinese including the upstream HTTP status; requests carry a timeout; never log keys; the InstaBox proxy URL only comes from environment variables, never hardcoded in code or docs.
- **Discuss big changes first.** Before adding a feature, open an issue describing what you want to add and how it fits the existing structure, so the approach can be agreed before you write code (see [CONTRIBUTING.md](../CONTRIBUTING.md)).

Related docs: [README_EN.md](../README_EN.md) (feature list, environment variables, local run), [CONTRIBUTING.md](../CONTRIBUTING.md) (pull-request process), [CLOUDRUN.md](CLOUDRUN.md) (deploying to Cloud Run).
