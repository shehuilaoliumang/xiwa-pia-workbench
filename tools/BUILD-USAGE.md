# 一键封装交付包（build_package.py）

`tools/build_package.py` 把当前项目打成一个**免安装交付包**：整包解压、双击 `启动工作台.cmd`
（或直接运行包内 EXE）即可使用，不需要用户安装 Python、Node.js 或任何依赖。

它只做本机产出：**不发布、不推送、不 `git commit`，也不修改 `.gitignore`**。

---

## 1. 怎么运行

| 方式 | 命令 |
| --- | --- |
| 双击（推荐给非开发者） | 双击项目根目录的 `build.cmd` |
| 命令行（等价） | `runtime\python.exe -X utf8 tools\build_package.py` |
| 用系统 Python（只要 ≥3.10） | `python tools\build_package.py` |

Windows 控制台建议保持 `chcp 65001`；`build.cmd` 已经自动做了这件事，源码文件本身是**无 BOM 的 UTF-8**，
配合 `-X utf8` 可以避免中文输出乱码。

---

## 2. 前置依赖

| 依赖 | 检查方式 | 缺失时怎么办 |
| --- | --- | --- |
| 便携运行环境 `runtime/python.exe` | 工具启动即检查 | 先运行 `python tools/prepare_runtime.py` |
| 依赖包 `runtime/Lib/site-packages` 里的 Flask / waitress / jinja2 / PIL | 目录检查 + 让运行时自证可导入 | 同上（依赖缺失时工具**直接中止**，不会打出半成品） |
| Electron 桌面壳 `desktop/runtime/electron.exe` | 存在则整体收进交付包 | 可选；先运行 `python tools/prepare_desktop_runtime.py`。缺失时只提示，交付包退化为浏览器模式 |
| PyInstaller（仅 EXE 用） | 用 `runtime/python.exe -c "import PyInstaller"` 探测 | 可选；默认**不联网安装**，只是打印提示并跳过 EXE 构建。要自动装就加 `--install-pyinstaller` |
| 编辑器子项目配方 `内容编辑器/build/*.spec` | 仅 `--with-editor` 时检查 | 没有配方就打印说明并跳过编辑器 EXE |

> `prepare_runtime.py` 与 `prepare_desktop_runtime.py` 都需要**已安装的 Python 3.10+**，
> 并且要在工作台停止的状态下运行。交付包本身不需要它们。

---

## 3. 常用命令

```bat
:: 1) 默认打包：尝试打主工作台 EXE（没装 PyInstaller 就跳过），再打 ZIP + 清单
runtime\python.exe -X utf8 tools\build_package.py

:: 2) 连同「内容编辑器」EXE 一起打包（复用子项目 build\*.spec）
runtime\python.exe -X utf8 tools\build_package.py --with-editor

:: 3) 只打源码 + 运行时（跳过 EXE，速度最快），输出到指定目录
runtime\python.exe -X utf8 tools\build_package.py --skip-exe --output-dir D:\交付

:: 4) 允许联网安装 PyInstaller，并强制重建已存在的 EXE
runtime\python.exe -X utf8 tools\build_package.py --install-pyinstaller --rebuild

:: 5) 只校验打包流程，不启动服务冒烟（例如 EXE 在受限环境里起不来时）
runtime\python.exe -X utf8 tools\build_package.py --skip-exe --skip-smoke

:: 6) 保留临时目录排查问题（项目根下 .build-tmp-<pid>\）
runtime\python.exe -X utf8 tools\build_package.py --keep-staging
```

---

## 4. 参数表

### 基本参数

| 参数 | 作用 |
| --- | --- |
| `--version` | 打印工具与配置中心里的应用版本后退出（不构建、不联网） |
| `--output-dir DIR` | ZIP 与清单的输出目录，默认项目根下的 `dist/` |
| `--skip-exe` | 跳过主工作台 EXE 的构建与复用（交付包仍带 `run.py` + `启动工作台.cmd`） |
| `--with-editor` | 额外构建「内容编辑器」子项目 EXE，放到交付包的 `内容编辑器/` 目录 |
| `--rebuild` | 覆盖已存在的 EXE / ZIP；不加时检测到已有产物就询问（非交互环境自动跳过） |
| `--install-pyinstaller` | 允许联网把 PyInstaller 装进便携运行环境（默认绝不联网） |
| `--keep-staging` | 保留项目根下的 `.build-tmp-<pid>/` 临时目录，便于排查 |
| `--skip-smoke` | 跳过启动服务/EXE 的冒烟测试（ZIP 结构校验仍会执行） |

### 进阶参数

| 参数 | 作用 |
| --- | --- |
| `--app-version VERSION` | 覆盖配置中心里的版本号（只影响本次 ZIP 文件名与清单） |
| `--editor-dir DIR` | 指定编辑器子项目目录，默认取配置中心 `editor.directory` |
| `--exe-console` | 把 EXE 构建成带控制台窗口的版本（排查启动问题用） |
| `--exe-embed-desktop-runtime` | 把 `desktop/runtime` 整个 Electron 运行时打进 EXE（体积很大，约 +370 MB） |
| `--with-vendor-archives` | 把 `vendor/` 下的大型离线归档（`*.zip`）也收进交付包 |
| `--smoke-timeout SECONDS` | 单次冒烟测试等待服务就绪的秒数，默认 120（EXE 至少按 180 秒） |

---

## 5. 构建流程

1. **读配置中心**：优先 `template_config.py`，其次 `config/template.json`，都不可用时回退到内置
   默认值（应用名「内容管理工作台」、短名 `content-workbench`、版本 `0.1.0`），并把回退原因写进
   控制台输出与清单。短名/版本会被规范成文件名安全的形式。
2. **检查运行时与依赖**：`runtime/python.exe`、`runtime/Lib/site-packages`、
   四个必需依赖的**实际导入**探测；并交叉核对 `requirements.txt` 与 `tools/runtime-lock.json`
   （不一致只提示，不阻断）。失败即中止。
3. **检查桌面壳**：`desktop/runtime/electron.exe` 存在则整体收进包，并记录 Electron 版本与可执行文件哈希。
4. **主工作台 EXE（默认尝试）**：用 `runtime/python.exe -m PyInstaller` 打包 `tools/exe_entry.py`
   成单文件 EXE；配方由本工具即时生成（`templates/`、`static/`、`data/seed.json`、`desktop/*.cjs` 打进 EXE）。
   产物会留档到 `tools/exe-build/dist/`（该目录已在 `.gitignore` 中），下次可复用。
5. **编辑器 EXE（`--with-editor`）**：复用子项目 `build/*.spec` 配方（`SPECPATH` 相对路径，换机器可用），
   产物放到交付包的 `内容编辑器/` 目录。
6. **收集资源**到 `.build-tmp-<pid>/stage/`（见第 8 节清单）。
7. **冒烟测试**（见第 7 节）。
8. **打 ZIP + 校验 + 写清单 + 打印摘要**。

---

## 6. 产物位置

```
dist/
├─ content-workbench-portable-0.1.0-20261004.zip             ← 交付包（整包解压即用）
└─ content-workbench-portable-0.1.0-20261004.zip.manifest.json ← 交付清单
```

* ZIP 命名：`<短名>-portable-<版本>-<yyyymmdd>.zip`；ZIP 内只有**一个**同名顶层目录，
  解压后不会散落一地文件。
* ZIP 先写成 `.partial`，校验通过才改名，所以 `dist/` 里不会留下半成品。
* `tools/exe-build/dist/` 会留档一份刚构建的 EXE，供下次复用（不加 `--rebuild` 不会覆盖）。
* 失败时不会写清单，而是写 `dist/<同名>.failed.json`，退出码非 0（可预期的失败为 2）。

> ⚠️ **`dist/` 目前不在 `.gitignore` 里**，本工具**不会**去改 `.gitignore`。
> 提交前请自行确认不要把 `dist/` 以及里面的交付包提交进版本库。

### 清单文件格式（`*.manifest.json`）

```jsonc
{
  "format": "content-package",          // 包格式名（来自配置中心）
  "tool": "tools/build_package.py",
  "built_at": "2026-10-04T14:08:37+08:00",
  "build_seconds": 214.6,
  "host": { "platform": "win32", "python": "3.12.14", "executable": "…", "cwd": "…" },
  "application": { "name": "内容管理工作台", "slug": "content-workbench", "version": "0.1.0",
                   "package_format": "content-package", "backup_filename_prefix": "content-backup-",
                   "editor_directory": "内容编辑器", "editor_app_id": "content-editor" },
  "config_center": { "sources": ["template_config.py", "config/template.json"],
                     "reader": "template_config.py", "json": "config/template.json",
                     "notes": ["…回退/覆盖说明…"] },
  "runtime": { "python": "3.14.7", "versions": { "flask": "3.1.3", "waitress": "3.0.2", … },
               "requirements_pins": 9, "locked_wheels": 9 },
  "desktop": { "path": "desktop/runtime", "present": true, "version": "44.4.2", "executable_sha256": "…" },
  "archive": { "file": "content-workbench-portable-0.1.0-20261004.zip", "path": "…",
               "size": 214748364, "size_human": "204.8 MB", "sha256": "…",
               "root_prefix": "content-workbench-portable-0.1.0-20261004",
               "members": 712, "unpacked_bytes": …, "unpacked_human": "…",
               "compression": "deflate", "crc_verified": true },
  "files": [ { "path": "run.py", "size": 4821, "sha256": "…", "compressed_size": 1740 }, … ],
  "excluded": [ { "pattern": "instance/", "reason": "用户资料（数据库、媒体、content-backup-*.zip 内容备份），绝不进交付包",
                  "count": 3, "examples": ["instance/workbench.sqlite3"] }, … ],
  "skipped_steps": [ { "step": "主工作台 EXE", "reason": "便携运行环境没有 PyInstaller（未指定 --install-pyinstaller）" } ],
  "steps": [ { "name": "读取配置中心", "status": "done", "detail": "…", "elapsed_seconds": 0.01 }, … ],
  "exe": { "status": "built", "name": "内容管理工作台.exe", "size": …, "sha256": "…", "smoke": "passed" },
  "editor_exe": null,
  "smoke_tests": [ { "label": "run.py（交付包源码，浏览器模式）", "command": [...], "port": 51234,
                     "health": { "ok": true, "app": "…", "data_dir": "…" },
                     "pages": [ { "path": "/", "status": 200 }, … ], "status": "passed" } ],
  "notes": ["…"],
  "boundaries": ["本工具不发布、不推送、不 git commit。", …]
}
```

`files[]` 里的 sha256 是**从 ZIP 里逐成员解压后重新计算**的（同时校验 CRC 与解压大小），
所以清单既能核对完整性，也能当成交付验收证据。

---

## 7. 冒烟测试（必做，除非 `--skip-smoke`）

打包完成后工具会真正把服务跑起来验证，全部使用**临时数据目录**（`.build-tmp-<pid>/smoke/`），
不会碰 `instance/`：

1. **交付包源码**：用 `runtime\python.exe -X utf8 run.py --no-browser --port <空闲端口> --data-dir <临时目录>`；
2. **主工作台 EXE**（本次构建或复用了 EXE 时）：在临时目录里复制一份 EXE 再运行，参数同上；
3. **编辑器 EXE**（`--with-editor` 时）：同样跑一次健康检查；编辑器只有编辑页，
   所以只断言 `GET /` 为 200。

每次断言：

* `GET /api/health` 返回 `ok: true`，且 `data_dir` 就是传入的临时目录；
* 主工作台：`GET /`、`GET /control`、`GET /manage` 都是 HTTP 200（同时验证模板与静态资源真的在包里）；
* 结束后先带 CSRF 凭据 `POST /api/shutdown` 优雅停止（主工作台凭据取自 `/api/library`，
  编辑器从首页 `csrf` 元标记读取），超时再 `taskkill /T /F` 兜底。

ZIP 结构校验不可跳过：可正常打开、CRC 正确、`run.py` / `启动工作台.cmd` / `templates/*.html` /
`data/seed.json` / `static/` / `runtime/` 都在，且 `instance/`、`.git/`、`evidence/`、`.qa/`、
`__pycache__`、`*.pyc`、`tests/` 等排除项**没有**混进去。

---

## 8. 交付包里有什么

**包含**（存在才收）：

* 代码：`run.py`、`app.py`、`storage.py`、`import_parser.py`、`script_package.py`、
  `script_merge.py`、`template_config.py` 等根目录 `*.py`、`requirements.txt`、`README.md`
* 资源：`templates/`、`static/`、`data/`、`docs/`、`config/`（配置中心）
* 运行环境：`runtime/`（便携 Python + 依赖）、`desktop/`（含 `desktop/runtime/` Electron 壳）
* 启动脚本：`启动工作台.cmd`、`停止工作台.cmd`、`浏览器模式.cmd`
* 维护脚本：`tools/`（含 `停止工作台.cmd` 依赖的 `tools/stop.py`）
* `vendor/wheels/`（离线重建运行环境用；大型 `*.zip` 归档默认不收，加 `--with-vendor-archives` 才收）
* 本次构建出的 EXE（放在包根或 `内容编辑器/` 目录）

**永远排除**：

| 排除项 | 原因 |
| --- | --- |
| `instance/` | **用户资料**：数据库、媒体、`content-backup-*.zip` 内容备份，绝不进交付包 |
| `.git/`、`.backup/`、`.local-archive/` | 版本库与本地归档 |
| `evidence/`、`.qa/` | 验收证据与质量检查过程产物 |
| `tests/`、`__pycache__/`、`*.pyc`/`*.pyo` | 测试代码与字节码缓存 |
| `.tmp-*`、`.build-tmp-*`、`.runtime-*` | 构建过程临时目录 |
| `tools/exe-build/` | 本机构建配方与产物（含机器相关绝对路径） |
| `dist/` | 输出目录自身 |

> 交付包体积主要由 `desktop/runtime`（Electron，约 370 MB 未压缩）与 `runtime/`（便携 Python，约 44 MB）
> 决定，ZIP 通常在 150～250 MB。

---

## 9. 失败排查

| 现象 | 原因与处理 |
| --- | --- |
| `未找到便携运行环境 runtime/python.exe` | 先跑 `python tools/prepare_runtime.py` |
| `便携运行环境缺少依赖：Flask、waitress…` | 运行环境不完整，重跑 `prepare_runtime.py`（会校验 wheel 的 SHA-256） |
| `当前便携运行环境没有 PyInstaller。…本次跳过 EXE 构建` | 正常行为。要 EXE 就加 `--install-pyinstaller`（需联网），或用已安装的 Python 手工 `pip install pyinstaller` |
| `已有 EXE … 非交互环境：默认不覆盖` | 想重建就加 `--rebuild` |
| `目标 ZIP 已存在，未覆盖` | 换 `--output-dir`，或加 `--rebuild` 覆盖 |
| 冒烟测试 `等待 N 秒仍未就绪` | 看提示里的“日志尾部”，或加 `--keep-staging` 后检查 `.build-tmp-<pid>/smoke/*.log` |
| EXE 冒烟失败、日志为空 | EXE 是无控制台模式，请看临时数据目录下的 `launcher.log`；也可用 `--exe-console` 重建一个带控制台的版本 |
| `跳过不可读路径` | 项目里有 ACL 拒绝的目录（例如残留的临时目录）。工具会跳过并记进清单，不影响其余内容；可自行清理该目录 |
| ZIP 校验失败 | 磁盘空间不足或文件被占用；关闭正在运行的工作台/编辑器后重试 |
| 中文乱码 | 用 `build.cmd` 运行（它会 `chcp 65001`），或手动 `chcp 65001` 并加 `-X utf8` |

环境限制提示：本机受限沙箱下 `tempfile.mkdtemp()` 建出的目录可能不可写，所以工具**不使用**它，
所有临时文件都在项目根下的 `.build-tmp-<pid>/`（用完即删，`--keep-staging` 可保留）；
子进程输出一律继承控制台或重定向到文件，不使用管道。

---

## 10. 边界说明

* 不发布、不上传、不推送、不执行任何 `git` 写操作（不 commit、不 tag、不改 `.gitignore`）。
* 不修改 `app.py` / `run.py` / `storage.py` / `templates/` / `static/` / `tests/` / `docs/` / `data/` /
  `README.md` / `config/` 等任何项目文件，只产出 `dist/` 下的交付包与清单，
  以及 `tools/exe-build/dist/` 下的 EXE 留档。
* 不联网，除非显式传入 `--install-pyinstaller`（仅用于安装 PyInstaller）。
* 不负责业务数据：`instance/` 与内容备份永远是用户自己的资料，打包过程只读取代码与资源。
* 交付包内不含浏览器里的本机操作偏好；首次启动会按 `data/seed.json` 初始化空库。
