# 更新日志（Changelog）

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- NVIDIA NIM 供应商（对话）：build.nvidia.com 免费推理 API（OpenAI 兼容接口），默认模型 GLM-5.3-Flash，另有 Kimi K3.1 Pro、Nemotron 3.5 Lightning 30B、MiniMax M3.1 Flash、Nemotron 3 Nano Omni 30B Reasoning、Mistral Large 4、Step-5 Preview、Gemma 4 31B、Muse Glimmer 30B 共 9 个模型；免费试用免绑卡，约 40 请求/分钟，仅限试用评估、不可用于生产。
- 登录防猜测：登录失败限流（同一 IP 15 分钟内最多 5 次失败，超了返回 429；成功登录清零），失败尝试记 warn 日志（只记 IP）；会话 Cookie 加 `Secure` 标记。
- TOTP 二次验证：设置页可开启（验证器 App 手动填密钥，动态码确认），登录需密码 + 6 位动态码；开启时一次给出 8 个一次性备用码；验证器与备用码全丢时可用环境变量 `TOTP_DISABLE=1` 恢复（部署后跳过二次验证，进站关闭再重开）。

### Fixed

- NVIDIA NIM 连接测试一直超时：探测是真实对话请求，而 probe 默认超时只有 15 秒，NVIDIA 免费端点首次推理常需几十秒；现探测改用 90 秒超时（probe 支持按需传超时），设置页提示测试首次可能需要几十秒。

## [0.1.0] - 2026-11-19

### Added

- **初始版**：8 个功能页签——创作（出图三后端：InstaBox CPU / Kaggle GPU / Cloudflare，Kaggle 生视频 Wan 2.2 图生视频）、对话/代码、识图、翻译、语音、音乐（仅提示，不提供生成）、向量、设置（含剩余用量查询）。
- **第二轮**：一键部署——Cloud Run 一键部署按钮 + Docker Compose；首次启动配置向导；MIT 开源协议；中英文文档（README.md / README_EN.md）。
- **第三轮**：可插拔存储后端（local 本地 JSON 文件 / S3 兼容对象存储）；测试套件（Node 内置 `node:test`，不联网）。
- **第四轮**：供应商插件化注册表（`lib/providers/` 下新增文件即自动发现）；模型配置化（`lib/models.json`）；扩展文档（docs/EXTENDING.md / EXTENDING_EN.md）。
- **第五轮**：访问密码保护（`ACCESS_PASSWORD`，未登录时 API 与生成文件均返回 401）；GitHub Actions CI（`.github/workflows/test.yml`，推送与 PR 时跑 `npm test`）；Google Gemini 供应商（对话/识图）。
- **第六轮**：数据导出/导入（JSON 备份，历史/会话/用量可导出导入，Key 永不导出）；生成参数可调（出图步数 1–50、CFG 1–20、新增横图 768×512）；开源规范模板（Issue 与 Pull Request 模板）。
- **第七轮**：英文文档同步（README_EN.md 与 docs/EXTENDING_EN.md 补齐）；基础限流（按 IP 滑动窗口，生成类 60 次/分钟、查询类 300 次/分钟，可配可关闭）；全量一致性复查。

<!-- 注意：下面两个链接需要 GitHub 仓库里存在 v0.1.0 标签与 Release 才能打开；
发版时请先打标签（git tag v0.1.0）并在 GitHub 创建对应 Release。 -->
[Unreleased]: https://github.com/lvcocousa-design/free-ai-tool-station/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lvcocousa-design/free-ai-tool-station/releases/tag/v0.1.0
