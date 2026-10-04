# AI 多媒体生成中心（实验功能）

> 状态：实验分支 `feature/ai-video`，mock 平台全流程已验收；接入真实平台需 API Key。
> 回退基线：`git checkout main`（main 分支未包含本功能），或删除 `ai_generator/` 包与 `instance/ai_generator.sqlite3`。

## 功能

- **段落级 AI 生成视频**：在“音视频配本”页（`/script/<id>/media`）点“AI 生成视频”，选择目标段落、参考角色、平台、比例、时长，可自定义剧情描述（留空用段落原文）。生成完成**自动挂载**到本剧本媒体位，并写入 0 秒时间点指向目标段落——与原手动上传视频走同一套落库、校验、去重与历史记录。
- **全局角色形象卡片库**：在“内容管理”页“角色形象库”中新建角色、AI 生成形象图（文生图）或上传形象图；每条记录“已在哪些剧本应用 + 对应名字（别名）”。生成视频时选用角色，会自动用其形象图作为参考（图生视频），保持同一角色跨段落、跨剧本的长相一致。
- **多平台适配层**：`mock`（无密钥联调）/ `byte`（字节 · 豆包 seedance，火山方舟）/ `ali`（阿里 · 通义万相）。每个平台一个适配器，统一接口 `generate_image / generate_video`；新增平台只需增加一个适配器文件。
- **横竖屏与时长**：9:16 / 16:9 / 1:1 / 3:4 / 4:3；5–30 秒，默认值可在“AI 生成设置”修改。
- **手动触发 + 批量排队**：段落逐个提交；任务在右下角“AI 生成队列”浮层实时显示（排队/生成中/成功/失败），支持取消与失败重试。

## 目录与数据

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 平台适配与任务管理 | `ai_generator/`（包） | base/mock/byte/ali/tasks/routes |
| 独立数据 | `instance/ai_generator.sqlite3` | 角色库、任务队列、平台配置；不触碰主库 schema |
| 生成产物 | `instance/ai_output/` | mock/真实平台下载的中间文件；挂载后进入 `instance/media/`（sha256 命名） |
| 服务注册 | `app.py` | `create_ai_blueprint(store, instance_path)` 一行注册 |

生成的任务、角色、密钥全部保存在本机。角色形象图与 AI 生成的视频挂载后均以 sha256 命名存入 `instance/media/`，与手动上传的资源同库管理。

## 使用

1. 启动工作台 → “内容管理”页出现 **AI 生成设置** 与 **角色形象库** 两个入口。
2. “AI 生成设置”：勾选启用；填写字节/阿里 API Key（无 key 时选“模拟平台”跑流程）；设置默认比例与时长。
3. “角色形象库”：新建角色 → 填形象描述 → “AI 生成形象图”（或上传）。同一角色在剧本中出现时，可在生成视频弹层中选用。
4. 打开剧本的“音视频配本”页 → “AI 生成视频” → 选段落、角色、平台与参数 → “开始生成并排队”。完成后自动挂入媒体位并刷新页面。

## 接口（`/api/ai/...`）

- `GET/POST /api/ai/config`、`GET /api/ai/status` — 配置与可用参数
- `GET/POST/PUT/DELETE /api/ai/characters[...]` — 角色库（含 `uses` 应用记录、`image` 上传、`generate-image` 生图任务）
- `POST /api/ai/video/generate` — 提交视频生成任务（异步）
- `GET /api/ai/tasks`、`GET /api/ai/tasks/<id>`、`POST .../cancel`、`POST .../retry` — 任务队列

所有接口与既有页面共用本机守卫、CSRF、CSP 与上传限制（生成挂载复用 `Store.upload_script_media` / `save_media_cues`）。

## 接入真实平台

- 字节：火山方舟控制台创建 API Key，填 `ark-...`；模型默认 `seedance-1.0-pro`（`ai_generator/byte.py` 按所选模型调整请求体）。
- 阿里：百炼/DashScope 创建 API Key，填 `sk-...`；模型默认 `wanx2.1-t2v-turbo`（`ai_generator/ali.py`）。
- 真实生成走 HTTP 轮询（提交 → 轮询 → 下载），失败会写明原因；未配置密钥时任务直接失败并提示配置路径。
- 注意：生成服务需要联网；CSP 保持 `connect-src 'self'`，浏览器不直连外网，外呼由服务端代理。

## 测试与回退

- `tests/test_ai_generator.py`：mock 全流程（配置/角色库/生图/生视频自动挂载/开关/取消重试）。
- `tests/browser_ai.cjs`：浏览器级验收（设置/角色库/弹层/队列/自动挂载），截图在 `.qa/browser-ai/`。
- 回归：`tests/test_backend.py` 等主流程测试全部通过（AI 功能独立库、零侵入主 schema）。
- 回退：`git checkout main` 即回到稳定版；或删除 `ai_generator/` 与 `instance/ai_generator.sqlite3`、移除 `app.py` 中的注册行。
