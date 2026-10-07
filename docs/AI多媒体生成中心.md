# AI 多媒体生成中心（实验功能）

> 状态：实验分支 `feature/ai-video`，四通道（视频/图片/音乐/配音）mock 全流程已验收；**阿里真实生成已闭环验证**（qwen-image 图片、qwen3-tts 配音、wanx 视频均实际生成成功并落盘归档），字节需按下方密钥说明开通模型。
> 回退基线：`git checkout main`（main 分支未包含本功能），或删除 `ai_generator/` 包与 `instance/ai_generator.sqlite3`。

## 功能

- **四类型段落级 AI 生成**：在“音视频配本”页（`/script/<id>/media`）点“AI 生成”，弹出生成弹窗并切换类型：
  - **视频**：选目标段落、参考角色、平台、比例、时长，可自定义剧情描述（留空用段落原文）。
  - **图片**：生成剧情配图（可选参考角色），自动插入目标段落后方。
  - **音乐**：生成背景音乐/音效（如“雨夜忧伤的钢琴背景音乐”），自动插入目标段落后方。
  - **配音**：文本转语音（旁白/台词，可选手色），自动插入目标段落后方。
  生成完成**自动挂载**到本剧本媒体位，并写入 0 秒时间点指向目标段落——与原手动上传音视频走同一套落库、校验、去重与历史记录。
- **全局角色形象卡片库**：在“内容管理”页“角色形象库”中新建角色、AI 生成形象图（文生图）或上传形象图；每条记录“已在哪些剧本应用 + 对应名字（别名）”。生成视频/图片时选用角色，会自动用其形象图作为参考，保持同一角色跨段落、跨剧本的长相一致。
- **多平台适配层**：`mock`（无密钥联调）/ `byte`（字节）/ `ali`（阿里）。每个平台一个适配器，统一接口 `generate_image / generate_video / generate_audio / generate_voice`；新增平台只需增加一个适配器文件。
- **横竖屏与时长**：9:16 / 16:9 / 1:1 / 3:4 / 4:3；5–30 秒，默认值可在“AI 生成设置”修改。
- **手动触发 + 批量排队**：段落逐个提交；任务在右下角“AI 生成队列”浮层实时显示（排队/生成中/成功/失败），支持取消与失败重试。
- **已生成产物浏览与插入**：“插入已生成音视频”弹窗按 全部/视频/音乐/配音/图片 分类浏览本机已生成产物，可预览后插入任意段落后方。

## 目录与数据

| 内容 | 位置 | 说明 |
| --- | --- | --- |
| 平台适配与任务管理 | `ai_generator/`（包） | base/mock/byte/ali/tasks/routes |
| 独立数据 | `instance/ai_generator.sqlite3` | 角色库、任务队列、平台配置；不触碰主库 schema |
| 生成产物 | `instance/ai_output/` | 按类型归档：`video/ image/ audio/ voice/`，每个产物一个文件夹（产物文件 + `meta.json` 提示词/平台/模型/参数） |
| 服务注册 | `app.py` | `create_ai_blueprint(store, instance_path)` 一行注册 |

生成的任务、角色、密钥全部保存在本机。角色形象图与 AI 生成产物挂载后均以 sha256 命名存入 `instance/media/`，与手动上传的资源同库管理。**配音产物独立归档在 `ai_output/voice/`**，与背景音乐 `audio/` 严格分开。

## 使用

1. 启动工作台 → “内容管理”页出现 **AI 生成设置** 与 **角色形象库** 两个入口。
2. “AI 生成设置”：勾选启用；填写平台密钥（见下节）；设置默认比例与时长；保存后点“刷新模型”/“测试连接”确认可用模型。
3. “角色形象库”：新建角色 → 填形象描述 → “AI 生成形象图”（或上传）。同一角色在剧本中出现时，可在生成弹层中选用。
4. 打开剧本的“音视频配本”页 → “AI 生成” → 切换类型（视频/图片/音乐/配音）→ 选段落、平台与参数 → “开始生成并排队”。完成后自动挂入媒体位并刷新页面。

## 接口（`/api/ai/...`）

- `GET/POST /api/ai/config`、`GET /api/ai/status` — 配置与可用参数（含四类模型桶：models/image_models/audio_models/voice_models）
- `GET/POST/PUT/DELETE /api/ai/characters[...]` — 角色库（含 `uses` 应用记录、`image` 上传、`generate-image` 生图任务）
- `POST /api/ai/video/generate` — 提交视频生成任务（异步）
- `POST /api/ai/image/generate` — 提交图片生成任务（异步，通用文生图）
- `POST /api/ai/audio/generate` — 提交背景音乐/音效生成任务（异步）
- `POST /api/ai/voice/generate` — 提交配音（TTS）任务（异步，`text` + 可选 `voice_type`）
- `GET /api/ai/outputs` — 已生成产物列表（按目录分类 video/audio/voice/image，附 meta.json）
- `GET /ai-output/<path>` — 预览产物
- `POST /api/ai/outputs/<path>/insert` — 把已生成产物插入指定正文段落后方
- `GET /api/ai/tasks`、`GET /api/ai/tasks/<id>`、`POST .../cancel`、`POST .../retry` — 任务队列

所有接口与既有页面共用本机守卫、CSRF、CSP 与上传限制（生成挂载复用 `Store.upload_script_media` / `save_media_cues`）。

## 接入真实平台

- **字节（byte）**：
  - 视频/图片：火山方舟控制台创建 API Key（`AKLT…`），填到“API Key”输入框；模型默认 seedance（视频）/ seedream（图片）。
  - 配音：豆包语音独立服务，控制台获取**豆包语音 API Key**（与方舟 Key 不通用），填到“豆包语音 API Key”；模型 `seed-audio-1.0`。
  - 可选：填 AccessKey/SecretKey 后点“测试开通状态”，自动只显示已开通模型（避免 404）。
- **阿里（ali）**：
  - 视频/图片/配音：百炼/DashScope 创建 API Key（`sk-…`），填到“API Key”，**同一 Key 直连**（视频 `wanx` 系列、图片 `qwen-image`/`wan2.7-image` 系列、配音 `qwen3-tts` 系列均已实测可用）。
  - “开通状态”按钮：一键查百炼已开通模型（免费）。图片/配音可静态确认（已开通模型直接列出）；视频与音乐百炼未开放列表查询，只能实际生成验证。
  - 音乐：另需百炼控制台“工作空间”的**业务空间 ID**（WorkspaceId），模型 `fun-music-v1`（limited preview 需在模型广场申请）。
  - 兼容性说明：qwen-image 走多模态生成端点、qwen3-tts 走多模态 TTS（均无需业务空间 ID）；视频/万相图片走 DashScope 异步任务（`X-DashScope-Async`）并按比例自动换算像素尺寸。
- **模拟平台（mock）**：无需密钥，用于无 key 联调；音乐/配音的 mock 通道需要 `instance/media/` 中已有音频模板文件。
- 真实生成走 HTTP 轮询（提交 → 轮询 → 下载），失败会写明原因（前端自动翻译为通俗中文）；未配置密钥时任务直接失败并提示配置路径。
- 注意：生成服务需要联网；CSP 保持 `connect-src 'self'`，浏览器不直连外网，外呼由服务端代理。

## 测试与回退

- `tests/test_ai_generator.py`：mock 全流程（配置/角色库/生图/生视频自动挂载/开关/取消重试）。
- `tests/_verify_audio_voice.py`：音乐 + 配音 mock 全流程（生成 → 归档 `ai_output/audio|voice/` + meta.json）。
- `tests/_verify_main_compat.py` / `tests/_verify_main_real_export.py`：单篇包与 main 分支导出格式的兼容验证。
- 回归：`tests/test_backend.py` 等主流程测试全部通过（AI 功能独立库、零侵入主 schema）。
- 回退：`git checkout main` 即回到稳定版；或删除 `ai_generator/` 与 `instance/ai_generator.sqlite3`、移除 `app.py` 中的注册行。
