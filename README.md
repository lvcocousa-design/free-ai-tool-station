# 免费AI工具站（自部署版）

免费 AI 工具站的自部署复刻版，对齐 Muse Space「免费AI工具站」的功能：出图、生视频、文字对话、识图、翻译、语音、向量，全部只用各家免费额度，不花钱。

技术栈：Node.js + Express（后端只依赖 `express`），原生 HTML/JS/CSS 单页应用。数据存在本地 `data/` 目录的 JSON 文件和文件里，不用数据库。

## 功能清单

| 页签 | 功能 | 后端 |
| --- | --- | --- |
| 创作 | 出图：提示词 + 方形/竖图选择，后端三选一 | InstaBox CPU（Realistic Vision 模型）/ Kaggle GPU（FLUX.1 schnell FP8）/ Cloudflare（FLUX.1 schnell） |
| 创作 | 生视频：从历史里选一张图做首帧 + 动作描述，生成 5 秒视频 | Kaggle GPU（Wan 2.2 TI2V-5B 图生视频，720p） |
| 对话/代码 | 多轮文字对话、代码问答，会话可保存/删除 | 智谱 z.ai（GLM-4.7-Flash / GLM-4.5-Flash）/ Groq（gpt-oss-120b / gpt-oss-20b / qwen3.8-27b）/ Cloudflare（Llama-3.1-8b） |
| 识图 | 上传图片提问；OCR 提取图片文字 | 智谱 z.ai（GLM-4.6V-Flash）提问 / 硅基流动（PaddleOCR-VL）OCR |
| 翻译 | 文本翻译，支持自动检测源语言 | DeepL / Cloudflare（m2m100）/ 硅基流动（Hunyuan-MT-7B） |
| 语音 | 文字转语音（TTS）；语音转文字（STT，录音或上传音频） | TTS：ElevenLabs（免费 premade 音色，默认 Sarah）/ Cloudflare（MeloTTS）；STT：Groq Whisper / Cloudflare Whisper / 硅基流动 SenseVoice |
| 向量 | 两段文本的语义相似度（余弦相似度） | Cloudflare（bge-m3）/ 硅基流动（bge-m3） |
| 设置 | 各供应商 Key 录入、各家免费额度说明、剩余用量查询 | — |

音乐页签只显示提示，不提供生成功能（见下方「注意事项」）。

## 各供应商免费额度

| 供应商 | 免费额度 | 备注 |
| --- | --- | --- |
| InstaBox | 免费机（4 vCPU / 8GB 内存） | 单次运行有时长上限，空闲自动暂停；需自行部署 ComfyUI + 代理 |
| Kaggle | 每周 30 GPU 小时 | 免费档硬上限，无付费选项；出图约几分钟，视频约 1 小时；排队等 GPU 属正常 |
| Cloudflare Workers AI | 每天 10,000 Neurons | 免绑卡；按模型费率扣 Neurons |
| Groq | 每模型每天 20 万 tokens、1000 次请求 | 免绑卡 |
| 智谱 z.ai | GLM Flash 系列模型免费 | 国际版，免实名 |
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

Key 可以填在 `.env` 里，也可以在站内「设置」页录入（设置页的优先级更高）。

## 环境变量

完整清单见 [.env.example](.env.example)（复制为 `.env` 后填入真实值）：

| 变量 | 说明 |
| --- | --- |
| `PORT` | 服务端口，默认 `8080` |
| `DATA_DIR` | 数据目录，默认 `./data` |
| `INSTABOX_PROXY_URL` | InstaBox 代理地址 |
| `KAGGLE_USERNAME` / `KAGGLE_KEY` | Kaggle 用户名 / API Key |
| `KAGGLE_FLUX_SLUG` / `KAGGLE_VIDEO_SLUG` | Kaggle 出图 / 生视频 kernel 的 slug（有默认值，一般不用改） |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Cloudflare 账号 ID / Workers AI Token |
| `GROQ_API_KEY` | Groq API Key |
| `ZHIPU_API_KEY` | 智谱 z.ai API Key |
| `DEEPL_API_KEY` | DeepL API Key |
| `ELEVENLABS_API_KEY` | ElevenLabs API Key |
| `SILICONFLOW_API_KEY` | 硅基流动 API Key |

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

## 部署到 Cloud Run

可以把本站部署到 Google Cloud Run 上对外提供服务，完整步骤见 [docs/CLOUDRUN.md](docs/CLOUDRUN.md)。

注意：Cloud Run 是无状态的，`data/` 目录（历史记录、会话、设置）在实例重建或扩缩容时不会持久保存，部署前请先读文档里的「重要限制」一节。

## 注意事项

- **音乐功能不提供**：ElevenLabs 音乐 API 需要付费计划，免费账号调用会返回 402，因此本站不提供音乐生成功能，音乐页签只显示明确提示。
- **数据存在本地 `data/` 目录**：历史记录、会话、设置、各家 Key（设置页录入的）和生成文件都在 `data/` 里。`data/` 已被 `.gitignore` 忽略，不会进仓库；备份、迁移时直接复制整个目录即可。
- **不要把 `.env` 提交到仓库**：`.env` 包含真实 API Key，已被 `.gitignore` 忽略；分享代码时只分享 `.env.example`。
- **InstaBox 地址只走环境变量**：不要把代理地址硬编码到代码或文档里。
- **Kaggle 出图/视频较慢**：出图约几分钟，生视频约 1 小时，排队等 GPU 十几分钟属正常现象，请耐心等待。
- **免费额度以各家官网为准**：各家免费政策可能调整，额度变化请以官网和账号页显示为准。
