# Free AI Tool Station (Self-Hosted Edition)

中文版本：[README.md](README.md)

[![Run on Google Cloud](https://deploy.cloud.run/button.svg)](https://deploy.cloud.run/?git_repo=https://github.com/lvcocousa-design/free-ai-tool-station)
[![Tests](https://github.com/lvcocousa-design/free-ai-tool-station/actions/workflows/test.yml/badge.svg)](https://github.com/lvcocousa-design/free-ai-tool-station/actions/workflows/test.yml)

A self-hosted replica of the Free AI Tool Station, matching the features of the Muse Space version: image generation, video generation, text chat, image understanding, translation, speech, and embeddings — all running entirely on each provider's free tier, at no cost.

Tech stack: Node.js + Express (the backend only depends on `express`), a vanilla HTML/JS/CSS single-page app. Data is stored locally in JSON files and files under `data/` by default — no database required; when deploying to a stateless platform like Cloud Run, you can switch to S3-compatible object storage instead (see "Storage persistence" below).

## Features

| Tab | Feature | Backend |
| --- | --- | --- |
| Create | Image generation: prompt + square/portrait/landscape size + adjustable steps (1–50) and CFG (1–20), three backends to choose from | InstaBox CPU (Realistic Vision, size/steps/CFG all apply) / Kaggle GPU (FLUX.1 schnell FP8, fixed 1024×1024, 4 steps, cfg 1.0) / Cloudflare (FLUX.1 schnell, fixed 1024×1024, max 8 steps, cfg fixed at 1.0) |
| Create | Video generation: pick an image from history as the first frame + a motion description, generates a 5-second video | Kaggle GPU (Wan 2.2 TI2V-5B image-to-video, 720p) |
| Chat / Code | Multi-turn text chat and code Q&A, sessions can be saved/deleted | Zhipu z.ai (GLM-4.7-Flash / GLM-4.5-Flash) / Groq (gpt-oss-120b / gpt-oss-20b / qwen3.8-27b) / Cloudflare (Llama-3.1-8b) / Google Gemini (Gemini 3.8 Flash / Gemini 3.5 Flash-Lite) / NVIDIA NIM (GLM-5.3-Flash / Kimi K3.1 Pro / Mistral Large 4 and 6 more models) |
| Image | Upload an image and ask questions about it; OCR to extract text from images | Zhipu z.ai (GLM-4.6V-Flash) / Google Gemini (Gemini 3.8 Flash) for Q&A / SiliconFlow (PaddleOCR-VL) for OCR |
| Translate | Text translation, with automatic source-language detection | DeepL / Cloudflare (m2m100) / SiliconFlow (Hunyuan-MT-7B) |
| Voice | Text-to-speech (TTS); speech-to-text (STT, record or upload audio) | TTS: ElevenLabs (free premade voices, default Sarah) / Cloudflare (MeloTTS); STT: Groq Whisper / Cloudflare Whisper / SiliconFlow SenseVoice |
| Vector | Semantic similarity between two texts (cosine similarity) | Cloudflare (bge-m3) / SiliconFlow (bge-m3) |
| Settings | Provider API key entry, free-tier notes for each provider, remaining-usage lookup, data export/import (backups contain no keys or generated files) | — |

The Music tab only shows a notice and does not offer generation (see [Notes](#notes)).

## Free Tiers by Provider

| Provider | Free tier | Notes |
| --- | --- | --- |
| InstaBox | Free machine (4 vCPU / 8 GB RAM) | Per-run time limit, auto-pauses when idle; you deploy ComfyUI + proxy yourself |
| Kaggle | 30 GPU hours per week | Hard cap on the free tier, no paid option; images take a few minutes, videos about 1 hour; waiting in the GPU queue is normal |
| Cloudflare Workers AI | 10,000 Neurons per day | No card required; Neurons are charged per model rate |
| Groq | 200,000 tokens and 1,000 requests per model per day | No card required |
| Zhipu z.ai | GLM Flash series models are free | International edition, no real-name verification required |
| Google Gemini | Free input & output tokens on Flash / Flash-Lite models | Rate limits apply; free-tier content is used to improve Google's products |
| NVIDIA NIM | Free trial | No card required, about 40 requests per minute; trial and evaluation only, not for production; the connection test is a real chat probe and may take tens of seconds the first time |
| DeepL API Free | 1,000,000 characters | Per the usage period shown on your account page |
| ElevenLabs | 10,000 credits per month | Free accounts can only use premade voices for TTS; Music API is not available |
| SiliconFlow | Some models are free | See the model page on the SiliconFlow website for the free models |

Quotas are subject to each provider's latest official terms.

## How to Get Each Provider's API Key

| Provider | Sign-up page | Notes |
| --- | --- | --- |
| InstaBox | https://instabox.tech | Create a free account and a free machine, then deploy ComfyUI + proxy to get your proxy URL |
| Kaggle | https://www.kaggle.com | After registering, go to Settings → API → Create New Token to get your key |
| Cloudflare | https://dash.cloudflare.com | Find the Account ID in the right sidebar of the dashboard; create a Workers AI Token under My Profile → API Tokens |
| Groq | https://console.groq.com | After registering, create a key on the API Keys page |
| Zhipu z.ai | https://z.ai | After registering, create a key on the API Key management page in the console |
| DeepL | https://www.deepl.com | After registering, choose the API Free (Developer) plan and get your key on the account page (keys end with `:fx`) |
| ElevenLabs | https://elevenlabs.io | After registering, create a key under Profile → API Keys |
| SiliconFlow | https://cloud.siliconflow.cn | After registering, create a key on the API Keys page in the console |
| Google Gemini | https://aistudio.google.com | Log in to Google AI Studio and create a key on the API Keys page |
| NVIDIA NIM | https://build.nvidia.com | After registering for an NVIDIA Developer account, create a key on the API Keys page (keys start with `nvapi-`) |

Keys can be set in `.env`, or entered on the in-app **Settings** page (Settings-page keys take precedence).

## Environment Variables

See [.env.example](.env.example) for the full list (copy it to `.env` and fill in real values):

| Variable | Description |
| --- | --- |
| `PORT` | Server port, default `8080` |
| `ACCESS_PASSWORD` | Access password (optional); when set, the app requires login before use — see "Access protection" below; when unset, the app is public |
| `DATA_DIR` | Data directory, default `./data` (local storage backend only) |
| `STORAGE_BACKEND` | Storage backend: `local` (default, stores in local `data/`) or `s3` (S3-compatible object storage; required on Cloud Run) |
| `S3_ENDPOINT` / `S3_BUCKET` / `S3_ACCESS_KEY` / `S3_SECRET_KEY` / `S3_REGION` | S3 backend settings (the first four are required when `STORAGE_BACKEND=s3`; `S3_REGION` defaults to `auto`, which is what R2 uses) |
| `S3_FORCE_PATH_STYLE` | Set to `true` to force S3 path-style addressing (usually unnecessary; localhost / IP endpoints use path-style automatically) |
| `RATE_LIMIT_PER_MINUTE` / `RATE_LIMIT_QUERY_PER_MINUTE` | Rate limits: heavy / query requests per IP per minute, defaults `60` / `300`, `0` disables the corresponding level |
| `LOGIN_MAX_ATTEMPTS` / `LOGIN_WINDOW_MINUTES` | Login rate limit: max failed attempts per IP within the window / window length in minutes, defaults `5` / `15`, `0` attempts disables login rate limiting |
| `INSTABOX_PROXY_URL` | InstaBox proxy URL |
| `KAGGLE_USERNAME` / `KAGGLE_KEY` | Kaggle username / API key |
| `KAGGLE_FLUX_SLUG` / `KAGGLE_VIDEO_SLUG` | Slugs of the Kaggle image / video kernels (have defaults, usually no need to change) |
| `CLOUDFLARE_ACCOUNT_ID` / `CLOUDFLARE_API_TOKEN` | Cloudflare account ID / Workers AI token |
| `GROQ_API_KEY` | Groq API key |
| `ZHIPU_API_KEY` | Zhipu z.ai API key |
| `DEEPL_API_KEY` | DeepL API key |
| `ELEVENLABS_API_KEY` | ElevenLabs API key |
| `SILICONFLOW_API_KEY` | SiliconFlow API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `NVIDIA_API_KEY` | NVIDIA NIM API key |

Providers you don't use can be left empty — the corresponding features will show a "not configured" notice and other features keep working.

## Run Locally

Requirements: Node.js >= 18.

```bash
# 1. Install dependencies
npm install

# 2. Configure environment variables (fill in only what you need;
#    providers you don't use can be left empty)
cp .env.example .env
# Open .env in an editor and fill in your API keys

# 3. Start the server
npm start
```

Open http://localhost:8080 to use the app. The `data/` directory is created automatically on first start.

## Run with Docker

```bash
# 1. Build the image
docker build -t free-ai-tool-station .

# 2. Prepare the environment file
cp .env.example .env
# Fill in your API keys

# 3. Run the container (persist the data/ directory with a volume,
#    otherwise history and settings are lost when the container is removed)
docker run -d \
  --name tool-station \
  -p 8080:8080 \
  --env-file .env \
  -v tool-station-data:/app/data \
  free-ai-tool-station
```

Open http://localhost:8080 to use the app.

Stop and remove:

```bash
docker stop tool-station
docker rm tool-station
# The tool-station-data volume is not removed with the container;
# only run this once you are sure you no longer need the data:
# docker volume rm tool-station-data
```

## Run with Docker Compose

An easier one-command alternative to `docker run` (works locally or on a VPS). The repo includes a `docker-compose.yml` that builds the image from the `Dockerfile`, loads variables from the `.env` file, and mounts `./data` to `/app/data`:

```bash
# 1. Prepare the environment file
cp .env.example .env
# Fill in your API keys; providers you don't use can be left empty

# 2. Start the service (in the background)
docker compose up -d
```

Open http://localhost:8080 to use the app. The `./data` directory is mounted to `/app/data` inside the container, so history and settings persist in the project's `data/` directory and survive container removal and rebuilds.

Stop and remove:

```bash
docker compose down
# The data/ directory lives in the project and is untouched when
# the container is removed
```

## Deploy to Cloud Run

You can deploy this app to Google Cloud Run to serve it publicly: the fastest way is the **Run on Google Cloud** one-click deploy button at the top of this page; for the full steps (including manual `gcloud` deployment), see [docs/CLOUDRUN.md](docs/CLOUDRUN.md).

### Storage persistence

Cloud Run is stateless — the local `data/` directory is lost when instances are recreated or scaled to zero. When deploying to Cloud Run, configure the S3 storage backend: set `STORAGE_BACKEND=s3` and fill in `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY`, and `S3_SECRET_KEY` (`S3_REGION` defaults to `auto`), and history, sessions, settings, and generated files will persist in your object storage bucket. Cloudflare R2 is recommended (its free tier includes 10 GB of storage with zero egress fees); see the "Data persistence" section in [docs/CLOUDRUN.md](docs/CLOUDRUN.md) for bucket and API token setup. Local, Docker, and VPS deployments can keep the default local backend (remember to mount a volume for Docker, as above).

Note: if `STORAGE_BACKEND=s3` is set but a required variable is missing, the service fails to start (it never silently falls back to local storage); without an S3 backend, data on Cloud Run is still lost when instances are recreated.

## Access protection

By default the station is public: anyone who opens it can use it. If you deploy it on the public internet and want to restrict access, set an access password:

```bash
ACCESS_PASSWORD=your-password
```

Once set, the app shows a login page first; only the correct password lets you in. Unauthenticated requests to `/api/*` endpoints return 401 (except the login, health-check, and auth-status endpoints), and generated files under `/blobs/*` also require login. The login session is a random token kept in server memory, so it expires when the process restarts and you will need to log in again. The session cookie is `HttpOnly` + `Secure` + `SameSite=Lax`, so page JavaScript cannot read it.

Against password guessing, failed logins are rate-limited: at most 5 failures per IP within 15 minutes, after which the API returns 429 (with a `Retry-After` header); a successful login clears that IP's failure count. Failed attempts are logged as warnings (IP only, never the password) and show up in Cloud Run logs. Tune with `LOGIN_MAX_ATTEMPTS` (default `5`, `0` disables) and `LOGIN_WINDOW_MINUTES` (default `15`).

Exceptions: `GET /api/health` (so platforms like Cloud Run can health-check the service), `POST /api/login` and `GET /api/auth/status` (required for the login flow) are intentionally left unprotected.

## Rate limiting

To keep a single IP from overwhelming the service or burning through free quotas, `/api/*` endpoints are rate-limited per IP (in-memory sliding window, one-minute window; counters reset when the process restarts):

- **Heavy generation operations**: 60 requests per minute per IP. Covers image generation, video generation, chat, image analysis, translation, text-to-speech, speech-to-text, embeddings, provider connectivity tests, and backup import (`POST /api/generate`, `/api/video`, `/api/chat`, `/api/analyze`, `/api/translate`, `/api/tts`, `/api/stt`, `/api/embed`, `/api/providers/:name/test`, `/api/backup/import`).
- **Query endpoints**: 300 requests per minute per IP. Covers all `GET` endpoints, deleting a chat (`DELETE /api/chats/:id`), and saving provider credentials (`POST /api/providers/:name`).
- **Login**: rate-limited separately (see "Access protection" above), at most 5 failures per IP within 15 minutes, after which the API returns 429.
- **Exempt**: health check `GET /api/health`.
- When the limit is exceeded, the API returns `429` (`{ok:false, message:'请求过于频繁，请稍后再试'}`) with a `Retry-After` header (in seconds).

Tune with environment variables (see [.env.example](.env.example)): `RATE_LIMIT_PER_MINUTE` (heavy operations, default `60`, `0` disables heavy rate limiting) and `RATE_LIMIT_QUERY_PER_MINUTE` (query endpoints, default `300`, `0` disables query rate limiting). Non-integer or negative values are ignored (falls back to the default and logs a warning); the service still starts normally.

## Notes

- **No music generation**: the ElevenLabs Music API requires a paid plan; free accounts get a 402 error, so this app does not offer music generation and the Music tab only shows a notice.
- **Data lives in the local `data/` directory**: with the default storage backend, history, sessions, settings, keys entered on the Settings page, and generated files are all stored in `data/`. `data/` is ignored by `.gitignore` and never enters the repository; to back up or migrate, just copy the whole directory. You can also export/import a JSON backup from the Settings page ("Data backup"): it contains only history, sessions, usage, and configuration status — no keys or generated files; importing merges record by record, existing data is kept, and keys are never restored. With the S3 backend configured, data lives in the object storage bucket instead (JSON files at the bucket root, generated files under the `blobs/` prefix), and the local `data/` directory is not used.
- **Never commit `.env` to the repository**: `.env` contains real API keys and is ignored by `.gitignore`; only share `.env.example` when sharing code.
- **The InstaBox address only goes in environment variables**: never hard-code the proxy URL into code or docs.
- **Kaggle image/video generation is slow**: images take a few minutes, videos about 1 hour, and waiting in the GPU queue for ten-plus minutes is normal — please be patient.
- **Free tiers are subject to each provider's official terms**: free policies may change; check the official website and your account page for current quotas.

## Testing

Tests use Node's built-in `node:test` with no extra dependencies and no network access (provider errors are simulated with a stubbed `fetch`; the wizard endpoints are verified against a local server subprocess):

```bash
npm test
```

Coverage: local storage read/write (JSON and blobs, extension sanitizing, path-traversal protection), S3 signing (SigV4 pure function), provider error formatting (Groq / z.ai / DeepL), wizard endpoint parameter validation, usage accounting (Cloudflare daily, Kaggle weekly, cross-day/cross-week reset, corrupt-file fallback), the provider plugin registry (auto-discovery, meta validation, broken-module tolerance), model configuration (load validation, defaults, support checks), access password protection (open access when unset, 401 when set, login and token validation), backup export/import (merge dedup, no credentials exported), generation parameter normalization (steps/CFG clamping, size presets, backend overrides), and per-IP rate limiting (sliding window, classification, exemptions, and 429). All tests use temporary directories (`DATA_DIR` pointing under `os.tmpdir()`) and clean up afterwards, so they never touch the project's `data/` directory.

## Extending

To add a new provider, a new feature tab, or change models, see [docs/EXTENDING_EN.md](docs/EXTENDING_EN.md) (Chinese version: [docs/EXTENDING.md](docs/EXTENDING.md)): providers are plugins (drop one file into `lib/providers/` and it is auto-discovered), feature tabs are registered, and the model list lives in `lib/models.json`.

## License

This project is licensed under the MIT License — see [LICENSE](LICENSE).

See [CHANGELOG.md](CHANGELOG.md) for the changelog.
