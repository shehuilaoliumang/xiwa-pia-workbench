# -*- mode: python ; coding: utf-8 -*-
# Build from any checkout location; no user-specific absolute paths.
from pathlib import Path

fan_root = Path(SPECPATH).resolve().parent
runtime_root = fan_root.parent / 'desktop' / 'runtime'
if not (runtime_root / 'electron.exe').is_file():
    raise FileNotFoundError('缺少主项目 desktop/runtime/electron.exe；请先准备完整 Electron 运行时。')

a = Analysis(
    [str(fan_root / 'fan_entry.py')],
    pathex=[str(fan_root)],
    binaries=[(str(runtime_root), 'desktop/runtime')],
    datas=[(str(fan_root / 'templates'), 'templates'), (str(fan_root / 'static'), 'static'),
           (str(fan_root / 'desktop' / 'main.cjs'), 'desktop'),
           (str(fan_root / 'desktop' / 'package.json'), 'desktop')],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.datas,
    [],
    name='喜娃剧本粉丝编辑器',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
