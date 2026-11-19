# 部署到 GCP Cloud Run

本文介绍如何把免费AI工具站（自部署版）部署到 Google Cloud Run，对外提供服务。

## 前置条件

1. **Google Cloud 账号**：注册一个 Google Cloud 账号（https://cloud.google.com）。
2. **已创建 GCP 项目**：在 [Google Cloud 控制台](https://console.cloud.google.com)创建一个项目，记下项目 ID。
3. **已启用计费账号**：GCP 要求项目关联一个计费账号（需要绑定一张银行卡/信用卡）才能使用 Cloud Run，即使只用免费额度也一样。绑定卡片本身不扣费，只有超出免费额度的用量才会产生费用。
4. **gcloud CLI**：本地安装并初始化 [Google Cloud CLI](https://cloud.google.com/sdk/docs/install)，然后登录并选定项目：

   ```bash
   gcloud auth login
   gcloud config set project YOUR_PROJECT_ID
   ```

5. **启用 Cloud Run 相关 API**：

   ```bash
   gcloud services enable run.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
   ```

## 部署步骤

在项目根目录（`free-ai-tool-station/`）执行：

```bash
gcloud run deploy free-ai-tool-station \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars PORT=8080
```

说明：

- `--source .`：直接用当前目录源码部署，Cloud Build 会按项目里的 `Dockerfile` 构建镜像，不用自己先 build/push。
- `--region`：选择离使用者近的区域，如 `asia-east1`（台湾）、`asia-northeast1`（东京）、`us-central1`（美国中部）。区域选定后不可更改，如需换区域要重新部署一个新服务。
- `--allow-unauthenticated`：允许任何人无需登录即可访问本站。不加这个参数时访问需要 Google 身份验证，一般个人使用要加上。
- `--port 8080`：本站监听 8080 端口（与 `Dockerfile` 的 `EXPOSE 8080` 一致）。
- 首次部署会提示确认，部署完成后输出服务 URL（如 `https://free-ai-tool-station-xxxxxx-ae.a.run.app`），打开即可使用。

### 传入各家 API Key

有两种方式，任选其一（也可混用，设置页录入的 Key 优先级最高）：

**方式一：部署时用 `--set-env-vars` 传入**（简单，适合快速上手）：

```bash
gcloud run deploy free-ai-tool-station \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars PORT=8080,KAGGLE_USERNAME=你的用户名,KAGGLE_KEY=你的Key,CLOUDFLARE_ACCOUNT_ID=你的账号ID,CLOUDFLARE_API_TOKEN=你的Token,GROQ_API_KEY=你的Key,ZHIPU_API_KEY=你的Key,DEEPL_API_KEY=你的Key,ELEVENLABS_API_KEY=你的Key,SILICONFLOW_API_KEY=你的Key,INSTABOX_PROXY_URL=你的代理地址
```

只填需要用的供应商即可，不用的留空（不要写进 `--set-env-vars`）。注意：命令行里的 Key 会留在 shell 历史记录中，用完可考虑清理历史。

之后只更新环境变量而不重新部署代码时，用：

```bash
gcloud run services update free-ai-tool-station \
  --region asia-east1 \
  --update-env-vars GROQ_API_KEY=新的Key
```

**方式二：用 Secret Manager 管理密钥**（推荐，适合长期运行）：

1. 把每个 Key 存为一个 Secret：

   ```bash
   echo -n "你的Groq Key" | gcloud secrets create groq-api-key --data-file=-
   ```

2. 部署时引用 Secret（Secret 名对应环境变量名）：

   ```bash
   gcloud run deploy free-ai-tool-station \
     --source . \
     --region asia-east1 \
     --allow-unauthenticated \
     --port 8080 \
     --set-secrets GROQ_API_KEY=groq-api-key:latest,ZHIPU_API_KEY=zhipu-api-key:latest
   ```

   需要先给 Cloud Run 服务账号授予 `secretmanager.secretAccessor` 角色，gcloud 会在缺少权限时给出提示，按提示授权即可。

**方式三：部署后在站内「设置」页录入**：部署时不传任何 Key，打开服务 URL 后在「设置」页逐个录入。设置页的 Key 存在 `data/settings.json`，优先级高于环境变量。但注意 Cloud Run 的无状态限制（见下文），实例重建后设置页录入的 Key 会丢失，需要重新录入。

## Cloud Run 免费额度

Cloud Run 每月免费额度（以 [Google Cloud 官方定价页](https://cloud.google.com/run/pricing)为准）：

| 项目 | 每月免费额度 |
| --- | --- |
| 请求数 | 200 万次 |
| vCPU 时间 | 180,000 vCPU-秒 |
| 内存 | 360,000 GB-秒 |
| 出站流量（到北美） | 1 GB |

本站是轻量应用，个人使用一般不会超出免费额度。超出部分按官方定价按量计费。可在 GCP 控制台设置预算提醒，避免意外账单。

另外注意：Cloud Run 默认「无请求时实例缩到 0」，长时间无人访问后首次打开会有几秒冷启动延迟，这是正常现象。

## 重要限制：数据不会持久保存

**Cloud Run 是无状态的。** 本站的历史记录、会话、设置（包括设置页录入的 Key）和生成文件都存在本地 `data/` 目录，而 Cloud Run 实例的文件系统是临时的：

- 实例因无流量缩到 0 后再启动，`data/` 里的内容会丢失。
- 部署新版本、扩容出多个实例时，各实例的 `data/` 互不共享、各自独立。
- 也就是说，**部署在 Cloud Run 上时，历史和设置随时可能丢失**，请把 Cloud Run 部署当作「用完即走」的临时服务，或接受数据可能丢失。

如果需要持久保存数据，可以自行接持久存储，思路如下（本项目不实现，需自行开发）：

- **历史/会话/设置**：把 `data/*.json` 的读写改到 Cloud Firestore 或 Cloud SQL 等托管数据库。
- **生成文件（图片/视频）**：把 `data/blobs/` 改存到 Cloud Storage，文件 URL 改为 Storage 签名 URL 或公开 URL。
- **最简单折中**：只把各家 Key 用环境变量或 Secret Manager 传入（不依赖 `data/settings.json`），历史记录接受丢失；重要的生成文件及时下载到本地保存。

## 常用命令

```bash
# 查看服务状态与 URL
gcloud run services describe free-ai-tool-station --region asia-east1

# 查看日志
gcloud run services logs read free-ai-tool-station --region asia-east1

# 删除服务（停止计费）
gcloud run services delete free-ai-tool-station --region asia-east1
```
