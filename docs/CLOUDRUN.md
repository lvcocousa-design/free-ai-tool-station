# 部署到 GCP Cloud Run

本文介绍如何把免费AI工具站（自部署版）部署到 Google Cloud Run，对外提供服务。

## 一键部署

最快的方式：点 [README 顶部的一键部署按钮](../README.md)即可直接从 GitHub 部署本站：

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/lvcocousa-design/free-ai-tool-station)

点击按钮后会在你的 Google Cloud 账号里打开 Cloud Shell，自动克隆本仓库，走 Cloud Build 用仓库里的 `Dockerfile` 构建镜像并部署到 Cloud Run，全程不用本地安装 gcloud。需要一个已启用计费的 Google Cloud 账号（见下方「前置条件」第 1–3 条），部署完成后按下方「传入各家 API Key」一节填入 Key 即可使用。

注意 Cloud Run 的无状态限制：本地 `data/` 目录在实例重建后会丢失，部署在 Cloud Run 上时请配置 S3 存储后端做持久化（见下方「数据持久化」一节），否则历史和设置随时可能丢失。

## 前置条件

一键部署只需要第 1–3 条；第 4–5 条（gcloud CLI、启用 API）只在走下方「手动部署步骤」时才需要。

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

## 手动部署步骤（进阶方式）

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
  --set-env-vars PORT=8080,KAGGLE_USERNAME=你的用户名,KAGGLE_KEY=你的Key,CLOUDFLARE_ACCOUNT_ID=你的账号ID,CLOUDFLARE_API_TOKEN=你的Token,GROQ_API_KEY=你的Key,ZHIPU_API_KEY=你的Key,GEMINI_API_KEY=你的Key,DEEPL_API_KEY=你的Key,ELEVENLABS_API_KEY=你的Key,SILICONFLOW_API_KEY=你的Key,INSTABOX_PROXY_URL=你的代理地址,ACCESS_PASSWORD=你的访问密码
```

只填需要用的供应商即可，不用的留空（不要写进 `--set-env-vars`）。`ACCESS_PASSWORD` 是访问密码（可选）：上面命令用了 `--allow-unauthenticated`，服务对公网公开，不想公开访问时建议设置，见 README「访问保护」一节。注意：命令行里的 Key 会留在 shell 历史记录中，用完可考虑清理历史。

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

**方式三：部署后在站内「设置」页录入**：部署时不传任何 Key，打开服务 URL 后在「设置」页逐个录入。设置页的 Key 存在 `settings.json`，优先级高于环境变量。配了 S3 存储后端时（见下方「数据持久化」），设置页录入的 Key 会持久存在桶里；不配 S3 后端时，实例重建后设置页录入的 Key 会丢失，需要重新录入。

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

## 数据持久化：请配置 S3 存储后端

**Cloud Run 是无状态的。** 本站的历史记录、会话、设置（包括设置页录入的 Key）和生成文件默认存在本地 `data/` 目录，而 Cloud Run 实例的文件系统是临时的：

- 实例因无流量缩到 0 后再启动，`data/` 里的内容会丢失。
- 部署新版本、扩容出多个实例时，各实例的 `data/` 互不共享、各自独立。

本站已内置 S3 兼容存储后端解决这个问题：设 `STORAGE_BACKEND=s3` 后，历史、会话、设置以 JSON 形式存在桶根目录（如 `history.json`、`settings.json`），生成文件存在 `blobs/` 前缀下，多实例共享同一份数据，实例重建也不丢。推荐用 **Cloudflare R2** 做存储（免费档含 10GB 存储且零出口费，个人使用足够）。

### 步骤一：在 R2 建桶

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com)，左侧找到 **R2 Object Storage**。
2. 点 **Create bucket**，桶名自定（如 `free-ai-tool-station-data`），位置选默认即可，点创建。
3. 打开刚建好的桶，在桶详情页找到 **S3 API** 一栏，记下端点地址，形如 `https://<账号ID>.r2.cloudflarestorage.com`——这就是 `S3_ENDPOINT`。

### 步骤二：创建 R2 API Token

1. 在 R2 页面点 **Manage R2 API Tokens** → **Create API Token**。
2. 权限选 **Object Read & Write**（限定在上一步建的桶上即可），TTL 不用改。
3. 创建后会显示 **Access Key ID** 和 **Secret Access Key**，只显示一次，请立即记下来——分别对应 `S3_ACCESS_KEY` 与 `S3_SECRET_KEY`。`S3_REGION` 填 `auto`（R2 专用）。

### 步骤三：部署时传入存储配置

部署命令里加上存储后端环境变量（`STORAGE_BACKEND`、`S3_ENDPOINT`、`S3_BUCKET`、`S3_REGION` 可走 `--set-env-vars`；`S3_ACCESS_KEY`、`S3_SECRET_KEY` 是密钥，建议走 `--set-secrets`，先按上方「传入各家 API Key」方式二存成 Secret）：

```bash
gcloud run deploy free-ai-tool-station \
  --source . \
  --region asia-east1 \
  --allow-unauthenticated \
  --port 8080 \
  --set-env-vars PORT=8080,STORAGE_BACKEND=s3,S3_ENDPOINT=https://你的账号ID.r2.cloudflarestorage.com,S3_BUCKET=你的桶名,S3_REGION=auto \
  --set-secrets S3_ACCESS_KEY=r2-access-key:latest,S3_SECRET_KEY=r2-secret-key:latest
```

快速上手时也可以把 6 个变量全放 `--set-env-vars`（注意命令行里的密钥会留在 shell 历史记录中）；已有服务只更新存储配置时用 `gcloud run services update ... --update-env-vars ...` / `--update-secrets ...`。

部署成功后打开服务 URL，启动日志里应有 `存储后端：s3`。在设置页录入一个 Key、生成一张图，再重新部署一次验证：历史和设置还在，就说明持久化已生效。

### 注意事项

- **`STORAGE_BACKEND=s3` 但缺必填配置时，服务启动即失败**（日志里会明确指出缺哪个变量），不会静默回落到本地——这是有意设计，避免“以为数据已持久化、实际存在临时目录里”的错觉。
- **不配 S3 后端时，Cloud Run 上的数据仍会在实例重建后丢失**，请把服务当作「用完即走」的临时服务，或接受数据可能丢失；重要的生成文件及时下载到本地保存。
- **已有本地数据想迁移到 S3**：把本地 `data/` 里的 `history.json`、`chats.json`、`settings.json`、`usage.json` 上传到桶根目录（同名），把 `data/blobs/` 里的文件上传到桶的 `blobs/` 前缀下即可，文件名与格式两后端完全一致。
- 其他 S3 兼容存储（AWS S3、GCS 互通、本地 MinIO 等）同样适用：`S3_ENDPOINT` 填对应端点，`S3_REGION` 填桶所在区域（如 AWS S3 的 `us-east-1`）；endpoint 是 localhost 或 IP 地址时自动用 path-style 寻址。

## 常用命令

```bash
# 查看服务状态与 URL
gcloud run services describe free-ai-tool-station --region asia-east1

# 查看日志
gcloud run services logs read free-ai-tool-station --region asia-east1

# 删除服务（停止计费）
gcloud run services delete free-ai-tool-station --region asia-east1
```
