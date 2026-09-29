# 喜娃剧本粉丝编辑器（桌面版）

给粉丝使用的独立剧本编辑器：**可新建剧本**（空白创建，或粘贴正文 / 上传 TXT / DOCX 自动解析成
台词段落），也可导入主播导出的单篇剧本 ZIP 进行编辑（台词、插图、音视频配本），再导出新 ZIP 还给主播，
主播在其工作台「内容管理 → 剧本资料 → 导入单篇剧本」中导入即可。

与主播工作台完全隔离：只编辑剧本，不碰主播后台；所有资料只保存在本机，不联网。

## 文件结构

```
喜娃剧本粉丝编辑器/
├── fan_app.py             # 本地服务（新建/导入/编辑/导出/媒体/时间点/退出 API）
├── fan_entry.py           # exe 入口（释放桌面组件、启动 Electron 桌面窗口、安全退出）
├── import_parser.py       # 与主播端同一套 TXT/DOCX/粘贴文本解析（复制自主项目）
├── script_package.py      # 与主播端同一套 v1 包校验/打包逻辑（复制自主项目）
├── storage.py             # 与主播端同一套数据校验逻辑（复制自主项目）
├── templates/editor.html  # 编辑页面（含新建剧本弹窗）
├── static/editor.js       # 页面逻辑（新建 + 正文 + 音视频配本编辑）
├── static/editor.css      # 页面样式
├── desktop/
│   ├── main.cjs           # Electron 桌面窗口（单窗口 + 服务健康监控自动退出）
│   ├── package.json
│   └── runtime/           # 开发模式从主播端 desktop/runtime 复制的 Electron 运行时
├── build/
│   ├── create_flow_test.py        # 新建流程测试：解析→创建→编辑→导出→主播端校验
│   ├── closed_loop_test.py        # 闭环测试：导入→编辑→导出→主播端校验
│   ├── desktop_smoke_test.py      # 桌面冒烟测试：入口执行+窗口渲染+关停联动
│   ├── 喜娃剧本粉丝编辑器.spec      # 打包配方（含 add-binary 的 Electron 运行时）
│   └── dist/喜娃剧本粉丝编辑器.exe   # 打包产物（约 170 MB，含 Electron 运行时）
└── fan-data/              # 运行时生成：工作区资料（exe 同级目录）
```

## 使用方式（外行人）

1. 双击 `喜娃剧本粉丝编辑器.exe`，首次启动自动释放桌面组件（约 1 分钟，仅第一次），
   然后打开「喜娃剧本粉丝编辑器 · 桌面版」窗口（不用浏览器）。
2. 新建剧本：点右上角「＋ 新建剧本」——直接「创建空白剧本」，或粘贴正文 / 上传 TXT / DOCX
   后点「解析预览」，确认识别结果（剧名、作者、角色、段落数）后点「创建剧本并开始编辑」。
3. 编辑：剧名/作者/简介/配音备注/标签/显示状态；正文段落可改词、改角色名和颜色、增删段、排序；
   插图可上传、替换、删除；音视频配本可上传/解除关联本地音视频、播放器取真实时长、
   标记/编辑时间点（时间、名称、勾选关联段落）、保存全部时间点。
   重新打开剧本时会自动恢复已关联的音视频与时间点，无需解除再重传。
4. 点「保存修改」→「导出剧本包（ZIP）」→ 把下载的 ZIP 发给主播。
5. 用完点「安全退出」或直接关闭窗口，工具自动停止。

## 界面布局

- 编辑页顶部操作栏（剧名 + 保存修改 + 导出剧本包）固定置顶，滚动正文时始终可见。
- 右侧「音视频配本」面板完全固定，不随上下滚动移动；时间点列表较长时在面板内部滚动，
  「保存全部时间点」条吸附在面板底部。
- 只有中部「基本信息 + 正文段落」区域受上下拖动影响（独立滚动条）。
- 欢迎页右侧同样固定显示配本说明；点顶部「剧本列表」按钮可随时隐藏/显示最左侧剧本列表。

## 开发者：构建与测试

```bat
rem 构建 exe（内置 Electron 运行时；runtime 来自主播端 desktop\runtime）
python -m PyInstaller --onefile --windowed --name 喜娃剧本粉丝编辑器 ^
  --specpath build --workpath build\work --distpath build\dist ^
  --add-data "templates;templates" --add-data "static;static" ^
  --add-data "desktop\main.cjs;desktop" --add-data "desktop\package.json;desktop" ^
  --add-binary "..\desktop\runtime;desktop\runtime" fan_entry.py

rem 开发模式跑服务 + 桌面窗口（控制台可见日志）
python fan_entry.py --port 8766 --data-dir fan-data-dev

rem 闭环测试（脚本模式）
python build\closed_loop_test.py

rem 闭环测试（针对 exe 本体）
set FAN_EXE=build\dist\喜娃剧本粉丝编辑器.exe
python build\closed_loop_test.py

rem 桌面冒烟测试（针对 exe 本体；建议把 exe 复制到临时目录再跑，避免在 build\dist 释放桌面组件）
set FAN_EXE=C:\path\to\copy\喜娃剧本粉丝编辑器.exe
python build\desktop_smoke_test.py
```

## 兼容性保障

- 新建剧本与导入/导出均走主播端同款 `xiwa-script-package` v1 校验（`script_package._validated`），
  格式逐字节兼容，主播工作台可直接导入。
- 文本导入与主播端同款（`import_parser`）：粘贴文本或 TXT/DOCX → 识别剧名/作者/「角色名：台词」段落，
  边界一致（30 万字符、10000 行、TXT 2 MB / DOCX 10 MB、安全 ZIP 校验）。
- 编辑能力与管理系统的正文/配本编辑对齐：音视频上传校验（容器签名 + 200 MB 上限）、
  时间点（at 唯一、须勾选存在的段落、≤5000 个）、删除被时间点引用的段落在保存时报错
  （"删除正文前请先调整相关时间点"，与主播端一致，不会自动剪枝）。
- 媒体文件以 SHA-256 命名存入工作区 files/，导出时重新哈希校验；图片经
  `decode_background`（12 MB 内 PNG/JPEG/WebP，剔除 EXIF，限静态图）。
- 打开剧本即自动创建播放器并加载已关联媒体（早期版本只在重新上传后创建播放器，
  导致重启工具后旧媒体看似无法加载，已修复）。
- 改词会自动丢弃失效的 PPT 颜色片段（runs），避免主播端渲染错位。
- 桌面窗口为 Electron 单窗口（1280×840，可缩放），页面安全退出时服务停止、窗口自动关闭；
  直接关窗口则入口检测到 Electron 退出后关停服务，不留后台进程。

## 数据与安全

- 工作区保存在 exe 同级 `fan-data/workspaces/`，删除工作区只删本地，不影响主播端任何资料。
- 仅监听 127.0.0.1，页面带 CSRF 校验 + CSP；主播端同款包格式校验拒绝坏包/超限包。
- 同名剧本导入主播端时仍会新增副本，不会覆盖。
- 桌面组件（Electron 运行时约 367 MB）只在首次运行时释放到 exe 同级 `desktop/`，
  之后启动直接复用；删除该目录会重新释放。
