# -*- mode: python ; coding: utf-8 -*-


a = Analysis(
    ['C:/Users/Lu/Documents/ChatGPT/选本网页/喜娃剧本粉丝编辑器/fan_entry.py'],
    pathex=[],
    binaries=[('C:/Users/Lu/Documents/ChatGPT/选本网页/desktop/runtime', 'desktop/runtime')],
    datas=[('C:/Users/Lu/Documents/ChatGPT/选本网页/喜娃剧本粉丝编辑器/templates', 'templates'), ('C:/Users/Lu/Documents/ChatGPT/选本网页/喜娃剧本粉丝编辑器/static', 'static'), ('C:/Users/Lu/Documents/ChatGPT/选本网页/喜娃剧本粉丝编辑器/desktop/main.cjs', 'desktop'), ('C:/Users/Lu/Documents/ChatGPT/选本网页/喜娃剧本粉丝编辑器/desktop/package.json', 'desktop')],
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
