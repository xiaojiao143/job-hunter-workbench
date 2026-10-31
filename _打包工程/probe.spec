# -*- mode: python ; coding: utf-8 -*-
"""一次性测试包：验证 DrissionPage 在 frozen 环境能否驱动 Edge。

这个 spec 只用于验证，不产出最终交付物。
"""

a = Analysis(
    ['src/probe_drission.py'],
    pathex=['src'],
    binaries=[],
    datas=[
        ('src/browser_finder.py', 'scripts'),
        # DrissionPage 的两个运行时数据文件 —— 少了它们读配置就报错
        ('.venv/Lib/site-packages/DrissionPage/_configs/configs.ini',   'DrissionPage/_configs'),
        ('.venv/Lib/site-packages/DrissionPage/_functions/suffixes.dat', 'DrissionPage/_functions'),
    ],
    hiddenimports=[
        'DrissionPage',
        'DrissionPage._configs.chromium_options',
        'DrissionPage._pages.chromium_page',
        'DrissionPage._units.actions',
        'DrissionGet',
        'DrissionRecord',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=['tkinter', 'unittest', 'pydoc', 'doctest', 'xmlrpc'],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='探针_DrissionPage',
    debug=False,
    strip=False,
    upx=False,
    console=True,
    icon='src/favicon.ico',
)
