# 免费AI工具站（自部署版）

English version: [README_EN.md](README_EN.md)

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/lvcocousa-design/free-ai-tool-station)
[![Tests](https://github.com/lvcocousa-design/free-ai-tool-station/actions/workflows/test.yml/badge.svg)](https://github.com/lvcocousa-design/free-ai-tool-station/actions/workflows/test.yml)

免费 AI 工具站的自部署复刻版，对齐 Muse Space「免费AI工具站」的功能：出图、生视频、文字对话、识图、翻译、语音、向量，全部只用各家免费额度，不花钱。

技术栈：Node.js + Express（后端只依赖 `express`），原生 HTML/JS/CSS 单页应用。数据默认存在本地 `data/` 目录的 JSON 文件和文件里，不用数据库；部署在 Cloud Run 等无状态平台时可改用 S3 兼容对象存储（见下方「存储持久化」）。

## 功能清单

| 页签 | 功能 | 后端 |
| --- | --- | --- |
| 创作 | 出图：提示词 + 方形/竖图/横图选择 + 步数（1–50）与 CFG（1–20）可调，后端三选一 | InstaBox CPU（Realistic Vision 模型，尺寸/步数/CFG 全部生效）/ Kaggle GPU（FLUX.1 schnell FP8，固定 1024×1024、4 步、cfg 1.0）/ Cloudflare（FLUX.1 schnell，固定 1024×1024，步数最多 8 步、cfg 固定 1.0） |
| 创作 | 生视频：从历史里选一张图做首帧 + 动作描述，生成 5 秒视频 | Kaggle GPU（Wan 2.2 TI2V-5B 图生视频，720p） |
| 对话/代码 | 多轮文字对话、代码问答，会话可保存/删除 | 智谱 z.ai（GLM-4.7-Flash / GLM-4.5-Flash）/ Groq（gpt-oss-120b / gpt-oss-20b / qwen3.8-27b）/ Cloudflare（Llama-3.1-8b）/ Google Gemini（Gemini 3.8 Flash / Gemini 3.5 Flash-Lite）/ NVIDIA NIM（GLM-5.3-Flash / Kimi K3.1 Pro / Mistral Large 4 等 9 个模型） |
| 识图 | 上传图片提问；OCR 提取图片文字 | 智谱 z.ai（GLM-4.6V-Flash）/ Google Gemini（Gemini 3.8 Flash）提问 / 硅基流动（PaddleOCR-VL）OCR |
| 翻译 | 文本翻译，支持自动检测源语言 | DeepL / Cloudflare（m2m100）/ 硅基流动（Hunyuan-MT-7B） |
| 语音 | 文字转语音（TTS）；语音转文字（STT，录音或上传音频） | TTS：ElevenLabs（免费 premade 音色，默认 Sarah）/ Cloudflare（MeloTTS）；STT：Groq Whisper / Cloudflare Whisper / 硅基流动 SenseVoice |
| 向量 | 两段文本的语义相似度（余弦相似度） | Cloudflare（bge-m3）/ 硅基流动（bge-m3） |
| 设置 | 各供应商 Key 录入、各家免费额度说明、剩余用量查询、数据导出/导入（备份不含 Key 与生成文件） | — |

音乐页签只显示提示，不提供生成功能（见下方「注意事项」）。

## 各供应商免费额度

| 供应商 | 免费额度 | 备注 |
| --- | --- | --- |
| InstaBox | 免费机（4 vCPU / 8GB 内存） | 单次运行有时长上限，空闲自动暂停；需自行部署 ComfyUI + 代理 |
| Kaggle | 每周 30 GPU 小时 | 免费档硬上限，无付费选项；出图约几分钟，视频约 1 小时；排队等 GPU 属正常 |
| Cloudflare Workers AI | 每天 10,000 Neurons | 免绑卡；按模型费率扣 Neurons |
| Groq | 每模型每天 20 万 tokens、1000 次请求 | 免绑卡 |
| 智谱 z.ai | GLM Flash 系列模型免费 | 国际版，免实名 |
| Google Gemini | Flash / Flash-Lite 模型输入输出 tokens 免费 | 有速率限制；免费档内容会被用于改进 Google 产品 |
| NVIDIA NIM | 免费试用 | 免绑卡，约 40 请求/分钟；仅限试用评估，不可用于生产；连接测试为真实对话探测，首次可能需要几十秒 |
| DeepL API Free | 100 万字符 | 以账号页显示的用量周期为准 |
| ElevenLabs | 每月 10,000 credits | 免费账号 TTS 只能用 premade 音色；音乐 API 不可用 |
| 硅基流动 | 部分模型免费 | 免费模型见硅基流动官网模型页 |

额度以各家官网最新说明为准。

## 如何申请各家 Key

| 供应商 | 申请地址 | 说明 |
| --- | --- | --- |
| InstaBox | https://instabox.tech | 注册免费账号，创建一台免费机器，部署 ComfyUI + 代理后得到代理地址 |
| Kaggle | https://www.kaggle.com | 注册后在 Settings → API → Create New Token 获取 Key |
| Cloudflare | https://dash.cloudflare.com | 控制台右侧栏取 Account ID；My Profile → API Tokens 创建 Workers AI Token |
| Groq | https://console.groq.com | 注册后在 API Keys 页创建 |
| 智谱 z.ai | https://z.ai | 注册后在控制台 API Key 管理页创建 |
| DeepL | https://www.deepl.com | 注册后选择 API Free（Developer）计划，在账号页获取 Key（以 `:fx` 结尾） |
| ElevenLabs | https://elevenlabs.io | 注册后在 Profile → API Keys 页创建 |
| 硅基流动 | https://cloud.siliconflow.cn | 注册后在控制台 API 密钥页创建 |
| Google Gemini | https://aistudio.google.com | 登录 Google AI Studio，在 API Keys 页创建 |
| NVIDIA NIM | https://build.nvidia.com | 注册 NVIDIA 开发者账号后，在 API Keys 页创建（Key 以 `nvapi-` 开头） |

Key 可以填在 `.env` 里，也可以在站内「设置」页录入（设置页的优先级更高）。设置页每个供应商都有「测试连接」按钮：只测不存，空输入时用已保存的 Key 测，填了新值则用新值测。

## 环境变量

完整清单见 [.env.example](.env.example)（复制为 `.env` 后填入真实值）：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `8080` |
| `ACCESS_PASSWORD` | 访问密码（可选）；设置后打开应用需先登录，见下方「访问保护」；不设置则公开访问 |
| `DATA_DIR` | 数据目录，默认 `./data`（仅本地存储后端使用） |
| `STORAGE_BACKEND` | 存储后端：`local`（默认，存本地 `data/`）或 `s3`（存 S3 兼容对象存储，Cloud Run 必配） |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_REGION` | S3 后端配置（`STORAGE_BACKEND=s3` 时必填前 4 项；`S3_REGION` 默认 `auto`，R2 用 `auto`） |
| `S3_FORCE_PATH_STYLE` | 设为 `true` 时强制 S3 path-style 寻址（一般不用改；localhost / IP 端点会自动用 path-style） |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_QUERY_PER_MINUTE` | 限流：生成类 / 查询类每 IP 每分钟上限，默认 `60` / `300`，设为 `0` 关闭对应一级限流 |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | 登录限流：同一 IP 在窗口内最多失败次数 / 窗口分钟数，默认 `5` / `15`，次数设为 `0` 关闭登录限流 |
| `INSTABOX_PROXY_URL` | InstaBox 代理地址 |
| `KAGGLE_USERNAME` / `KAGGLE_KEY` | Kaggle 用户名 / API Key |
| `KAGGLE_FLUX_SLUG` / `KAGGLE_VIDEO_SLUG` | Kaggle 出图 / 生视频 kernel 的 slug（有默认值，一般不用改） |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Cloudflare 账号 ID / Workers AI Token |
| `GROQ_API_KEY` | Groq API Key |
| `ZHIPU_API_KEY` | 智谱 z.ai API Key |
| `DEEPL_API_KEY` | DeepL API Key |
| `ELEVENLABS_API_KEY` | ElevenLabs API Key |
| `SILICONFLOW_API_KEY` | 硅基流动 API Key |
| `GEMINI_API_KEY` | Google Gemini API Key |
| `NVIDIA_API_KEY` | NVIDIA NIM API Key |

不用的供应商可以留空，对应功能会显示「未配置」提示，不影响其他功能使用。

## 本地运行

要求：Node.js >= 18。

```bash
# 1. 安装依赖
npm install

# 2. 配置环境变量（按需填写，不用的供应商可留空）
cp .env.example .env
# 用编辑器打开 .env 填入各家 Key

# 3. 启动服务
npm start
```

打开 http://localhost:8080 即可使用。首次启动会自动创建 `data/` 目录。

## Docker 运行

```bash
# 1. 构建镜像
docker build -t free-ai-tool-station .

# 2. 准备环境变量文件
cp .env.example .env
# 填入各家 Key

# 3. 运行容器（用 volume 持久化 data/ 目录，否则容器删除后历史和设置会丢失）
docker run -d \
  --name tool-station \
  -p 8080:8080 \
  --env-file .env \
  -v tool-station-data:/app/data \
  free-ai-tool-station
```

打开 http://localhost:8080 即可使用。

停止与删除：

```bash
docker stop tool-station
docker rm tool-station
# 数据卷 tool-station-data 不会随容器删除而消失；确认不要数据了再执行：
# docker volume rm tool-station-data
```

## Docker Compose 运行

比 `docker run` 更省事的一键方式（本地或 VPS 均可）：

```bash
# 1. 准备环境变量文件
cp .env.example .env
# 填入各家 Key，不用的供应商可留空

# 2. 启动服务（后台运行）
docker compose up -d
```

打开 http://localhost:8080 即可使用。`./data` 目录已挂载到容器内 `/app/data`，历史记录和设置会持久保存在项目目录的 `data/` 里，容器删除重建也不会丢。

停止与删除：

```bash
docker compose down
# data/ 目录在项目里，不会随容器删除而消失
```

## 部署到 Cloud Run

可以把本站部署到 Google Cloud Run 上对外提供服务：最快的方式是点本页顶部的「Run on Google Cloud」一键部署按钮；完整步骤（含手动 gcloud 部署）见 [docs/CLOUDRUN.md](docs/CLOUDRUN.md)。

### 存储持久化

Cloud Run 是无状态的，实例重建或缩到 0 后本地 `data/` 目录会丢失。部署在 Cloud Run 上时请配置 S3 存储后端：设 `STORAGE_BACKEND=s3` 并填入 `S3_ENDPOINT`、`S3_BUCKET`、`S3_ACCESS_KEY`、`S3_SECRET_KEY`（`S3_REGION` 默认 `auto`），历史记录、会话、设置和生成文件就会持久存在对象存储桶里。推荐用 Cloudflare R2（免费档含 10GB 存储且零出口费），建桶与 API Token 步骤见 [docs/CLOUDRUN.md](docs/CLOUDRUN.md) 的「数据持久化」一节。本地、Docker、VPS 部署用默认本地后端即可（Docker 记得挂 volume，见上方）。

注意：`STORAGE_BACKEND=s3` 但缺必填配置时，服务启动即失败（不会静默回落到本地）；不配 S3 后端时，Cloud Run 上的数据仍会在实例重建后丢失。

## 访问保护

默认情况下本站公开访问，任何人打开就能用。如果部署在公网又不想公开，可以设置访问密码：

```bash
ACCESS_PASSWORD=你的密码
```

设置后，打开应用会先显示登录页，输对密码才能进入；未登录时 `/api/*` 接口返回 401（登录、健康检查与登录状态接口除外），生成的成品文件（`/blobs/*`）同样需要登录才能打开。登录会话是服务端内存里的随机 token，进程重启后失效，需重新登录。会话 Cookie 为 `HttpOnly` + `Secure` + `SameSite=Lax`，页面里的 JS 读不到。

防密码猜测：登录失败会计入限流，同一 IP 15 分钟内最多 5 次失败，超了返回 429（带 `Retry-After` 头）；成功登录会清掉该 IP 的失败记录。失败尝试会记一条 warn 日志（只记 IP，不记密码），可在 Cloud Run 日志里看到。次数与窗口可用 `LOGIN_MAX_ATTEMPTS`（默认 `5`，设为 `0` 关闭）与 `LOGIN_WINDOW_MINUTES`（默认 `15`）调整。

二次验证（TOTP）：设置了访问密码后，可在设置页开启。开启时把显示的密钥手动填进验证器 App（Google Authenticator、微软 Authenticator、苹果密码等），输一次动态码确认即可；之后登录除密码外还要输 6 位动态码。开启成功时会一次给出 8 个备用码（验证器丢失时用，每个只能用一次，请抄下来妥善保存，离开页面就不再显示；备用码不含在数据备份里）。验证器与备用码全丢时：把环境变量 `TOTP_DISABLE=1` 加进部署并重新部署，登录会跳过二次验证；进站后在设置页关闭二次验证，删掉该变量再重新部署并重新开启。

例外：`GET /api/health`（供 Cloud Run 等平台健康检查用）、`POST /api/login` 与 `GET /api/auth/status`（登录流程必需）不设防。

## 限流

为防止单 IP 频繁调用拖垮服务或耗尽免费额度，`/api/*` 接口按 IP 限流（内存滑动窗口，每分钟窗口，进程重启后计数清零）：

- **生成类重操作**：每 IP 每分钟 60 次。包括出图、生视频、对话、识图、翻译、语音合成、语音转文字、向量、供应商连通性测试、备份导入与二次验证确认（`POST /api/generate`、`/api/video`、`/api/chat`、`/api/analyze`、`/api/translate`、`/api/tts`、`/api/stt`、`/api/embed`、`/api/providers/:name/test`、`/api/backup/import`、`/api/totp/confirm`）。
- **查询类接口**：每 IP 每分钟 300 次。包括所有 `GET` 接口、删除会话（`DELETE /api/chats/:id`）与保存供应商凭据（`POST /api/providers/:name`）。
- **登录**：单独限流（见上方「访问保护」），同一 IP 15 分钟内最多 5 次失败，超了返回 429。
- **不限流**：健康检查 `GET /api/health`。
- 超限返回 `429`（`{ok:false, message:'请求过于频繁，请稍后再试'}`），并带 `Retry-After` 头（秒数）。

可用环境变量调整（见 [.env.example](.env.example)）：`RATE_LIMIT_PER_MINUTE`（生成类，默认 `60`，设为 `0` 关闭生成类限流）、`RATE_LIMIT_QUERY_PER_MINUTE`（查询类，默认 `300`，设为 `0` 关闭查询类限流）。非整数或负数会被忽略（回落到默认值并记一条 warn 日志），服务照常启动。

## 用量上限

为防止免费额度用超导致扣费（主要是 Cloud Run 与 R2 绑了卡、没有硬截止），本站在应用层做用量上限：各供应商免费额度到顶时，调用在调上游之前被拦截，返回 `429`（`{ok:false, quotaExceeded:true, message:'…'}`），拦截提示里会说清额度与恢复时间。设置页「剩余用量」可查看当前各额度使用情况。

| 上限 | 额度 | 恢复时间 |
| --- | --- | --- |
| Cloudflare Workers AI | 每天 10,000 Neurons，**按 90%（9,000）拦截**（真顶满会触发 Cloudflare 24 小时封禁，所以留余量） | 每天 08:00（北京时间） |
| Groq | 每模型每天 200,000 tokens + 1,000 次请求 | 每天 08:00（北京时间） |
| ElevenLabs / DeepL | 以官方用量接口为准，用完即拦（缓存 10 分钟，过期先刷新） | 下个计费/额度周期 |
| Kaggle | 每周 108,000 GPU 秒（30 小时）；拦截时按任务预留（出图 600 秒、生视频 3,600 秒），剩余不够预留即拦 | 每周一 08:00（北京时间） |
| 存储（R2 / 本地） | 8 GiB（R2 免费 10 GB，留余量）；出图/生视频前检查 | 清理旧文件后恢复（站内无删除功能，请去 R2 控制台清理） |
| 全站每月请求数 | 1,500,000 次（Cloud Run 免费 2M 请求的 75%） | 下月 1 日 |

说明：

- 拦截发生在输入校验与配置检查之后、调上游之前，不会留下半截会话或任务；被拦的请求不会消耗任何额度。
- 健康检查、登录、状态查询、用量查询、二次验证接口不计入每月请求数，也不受每月请求数上限拦截。
- 识图（`/api/analyze`）与供应商连接测试（`/api/providers/:name/test`）不做用量拦截：前者的供应商没有可强制的公开额度，后者是单次手动探测，不可能造成超量。
- 用量查不到时 fail open（放行）：例如存储用量统计失败、ElevenLabs/DeepL 官方用量刷新失败时，不会因此锁死服务，只记一条 warn 日志。
- 可用环境变量调整（见 [.env.example](.env.example)）：`QUOTA_STORAGE_BYTES`（存储上限字节数，默认 8 GiB）、`QUOTA_MONTHLY_REQUESTS`（每月请求数上限，默认 `1500000`，设为 `0` 关闭）、`QUOTA_CLOUDFLARE_FRACTION`（Cloudflare 拦截线比例，默认 `0.9`）、`QUOTA_DISABLED=1`（关闭全部用量上限拦截，启动时记 warn 日志，平时不要设置）。

## 注意事项

- **音乐功能不提供**：ElevenLabs 音乐 API 需要付费计划，免费账号调用会返回 402，因此本站不提供音乐生成功能，音乐页签只显示明确提示。
- **数据存在本地 `data/` 目录**：默认存储后端下，历史记录、会话、设置、各家 Key（设置页录入的）和生成文件都在 `data/` 里。`data/` 已被 `.gitignore` 忽略，不会进仓库；备份、迁移时直接复制整个目录即可。也可以在设置页用「数据备份」导出/导入 JSON 备份（只含历史、会话、用量与配置状态，不含任何 Key 与生成文件；导入时按记录合并，现有数据保留，Key 不会被恢复）。配了 S3 后端时，数据存在对象存储桶里（JSON 在桶根目录，生成文件在 `blobs/` 前缀下），本地 `data/` 不再使用。
- **不要把 `.env` 提交到仓库**：`.env` 包含真实 API Key，已被 `.gitignore` 忽略；分享代码时只分享 `.env.example`。
- **InstaBox 地址只走环境变量**：不要把代理地址硬编码到代码或文档里。
- **Kaggle 出图/视频较慢**：出图约几分钟，生视频约 1 小时，排队等 GPU 十几分钟属正常现象，请耐心等待。
- **免费额度以各家官网为准**：各家免费政策可能调整，额度变化请以官网和账号页显示为准。

## 测试

测试用 Node 内置 `node:test`，不引新依赖，不联网（供应商错误用 stubbed `fetch` 模拟，向导接口用本地子进程服务器验证）：

```bash
npm test
```

覆盖范围：本地存储读写（JSON 与 blob、扩展名清洗、路径穿越防护）、S3 签名（SigV4 纯函数）、供应商错误格式化（Groq / 智谱 / DeepL）、向导接口参数校验、用量累计逻辑（Cloudflare 按日、Kaggle 按周、跨日/跨周清零、损坏文件回落）、供应商插件注册表（自动发现、meta 校验、缺失模块容错）、模型配置（加载校验、默认值与支持判断）、访问密码保护（未设密码放行、设密码后 401、登录与 token 校验）、数据备份导出/导入（合并去重、凭据不导出）、生成参数归一化（步数/CFG 夹取、尺寸预设、后端覆盖）、按 IP 限流（滑动窗口、分级、豁免与 429）、用量上限（额度检查边界、环境变量覆盖、路由级 429 拦截、存储用量统计）。测试全部使用临时目录（`DATA_DIR` 指向 `os.tmpdir()` 下的临时目录），跑完自动清理，不会污染项目 `data/` 目录。

## 扩展

想加新供应商、新功能页签或换模型，见 [docs/EXTENDING.md](docs/EXTENDING.md)（英文版：[docs/EXTENDING_EN.md](docs/EXTENDING_EN.md)）：供应商是插件式（`lib/providers/` 下新增一个文件即被自动发现），功能页签是注册式，模型列表在 `lib/models.json` 里配置。

## 开源协议

本项目采用 MIT 协议，见 [LICENSE](LICENSE)。

更新日志见 [CHANGELOG.md](CHANGELOG.md)。
