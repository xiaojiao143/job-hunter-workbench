# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置 —— 求职猎手工作台 便携版

关键取舍
--------
· onefile：单文件 exe，长辈只需要「一个东西」，不用理解文件夹结构
· console：保留黑窗口。这是**故意的** —— 长辈需要一个能看懂、
  能截图给你看的窗口来确认「它启动了」，而不是双击后不知道成没成功。
· 只收静态资源（index.html / css / js / favicon），不收采集器。
  采集链路要requests/lxml/DrissionPage 三十个包，frozen 后最容易出
  玄学问题（找不到浏览器、CDP 连不上）。主功能绝不能被它拖垮。
· 不带任何第三方 Python 包 —— server_core 只用标准库，
  打包出来的小、稳、快。
"""

block_cipher = None

a = Analysis(
    ['src/launcher.py'],
    pathex=['src'],
    binaries=[],
    datas=[
        ('src/index.html',      '.'),
        ('src/favicon.ico',     '.'),
        ('src/css',             'css'),
        ('src/js',              'js'),
    ],
    # server_core 是 launcher 运行时动态 import 的，PyInstaller 的静态分析
    # 扫不到这个名字 → 必须在这里显式声明。
    # 漏了这一步的典型症状：exe 双击无反应，或报 No module named server_core。
    hiddenimports=['server_core'],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # 只排真正用不上的第三方重物。
        #
        # ⚠️ 不要动标准库：曾经把 'email' 当「看起来没用」排掉，
        # 结果 urllib.request 内部要它，exe 双击即崩
        # （ModuleNotFoundError: No module named 'email'）。
        # 标准库之间的依赖关系比表面看起来密得多，砍不起。
        'tkinter', 'unittest', 'pydoc', 'doctest', 'xmlrpc',
        'numpy', 'PIL', 'pytest', 'setuptools', 'pip',
        # 这些只是 webbrowser 的可选后端，排掉不影响（web.browser 部分仍在）
        'webbrowser.mac',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='求职猎手工作台',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,                # UPX 会被杀软误报，不开
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='src/favicon.ico',
)
