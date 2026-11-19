# 更新日志（Changelog）

本项目的所有重要变更都会记录在此文件中。

格式基于 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- 数据导出/导入：历史记录、会话、用量计数可导出为 JSON 文件并重新导入（导入时按记录合并，现有数据保留）；设置只导出各供应商的已配置状态（布尔值），导入时忽略设置字段，Key 永不从备份恢复。
- 生成参数可调：出图支持调整步数（1–50）、CFG（1–20，仅 InstaBox 后端生效）与尺寸预设（新增横图 768×512）；Kaggle/Cloudflare 后端按各自能力应用。
- 开源规范模板：补齐更新日志、Issue 模板与 Pull Request 模板，完善开源项目规范。
- 英文文档同步：README_EN.md 与 docs/EXTENDING_EN.md 补齐四、五轮功能说明（生成参数、导出/导入、Gemini 供应商等），与中文版保持一致。
- 基础限流：按 IP 滑动窗口限流，分生成类（默认 60 次/分钟，`RATE_LIMIT_PER_MINUTE` 可调）与查询类（默认 300 次/分钟，`RATE_LIMIT_QUERY_PER_MINUTE` 可调）两级，设为 `0` 关闭对应一级；健康检查（`GET /api/health`）与登录（`POST /api/login`）豁免。
- 全量一致性复查：核对全部文档与代码实际行为，修正版本号、链接与表述不一致。

## [0.1.0] - 2026-11-19

### Added

- **初始版**：8 个功能页签——创作（出图三后端：InstaBox CPU / Kaggle GPU / Cloudflare，Kaggle 生视频 Wan 2.2 图生视频）、对话/代码、识图、翻译、语音、音乐（仅提示，不提供生成）、向量、设置（含剩余用量查询）。
- **第二轮**：一键部署——Cloud Run 一键部署按钮 + Docker Compose；首次启动配置向导；MIT 开源协议；中英文文档（README.md / README_EN.md）。
- **第三轮**：可插拔存储后端（local 本地 JSON 文件 / S3 兼容对象存储）；测试套件（Node 内置 `node:test`，不联网）。
- **第四轮**：供应商插件化注册表（`lib/providers/` 下新增文件即自动发现）；模型配置化（`lib/models.json`）；扩展文档（docs/EXTENDING.md / EXTENDING_EN.md）。
- **第五轮**：访问密码保护（`ACCESS_PASSWORD`，未登录时 API 与生成文件均返回 401）；GitHub Actions CI（`.github/workflows/test.yml`，推送与 PR 时跑 `npm test`）；Google Gemini 供应商（对话/识图）。

<!-- 注意：下面两个链接需要 GitHub 仓库里存在 v0.1.0 标签与 Release 才能打开；
发版时请先打标签（git tag v0.1.0）并在 GitHub 创建对应 Release。 -->
[Unreleased]: https://github.com/lvcocousa-design/free-ai-tool-station/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/lvcocousa-design/free-ai-tool-station/releases/tag/v0.1.0
