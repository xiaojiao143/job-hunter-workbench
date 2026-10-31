# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置 —— 一体化安装程序

产出「一个 exe，双击装完」的安装包。

两个刻意的选择
--------------
1. **console=False（无黑窗口）**：安装程序双击后不该弹一个黑框，那对
   不懂技术的人是纯噪音。代价是出错时看不到堆栈，所以 installer.py 里
   所有异常都走 Windows 原生 MessageBoxW 弹窗 —— 至少能看到人话。

2. **payload/ 原样内嵌**：把「主程序 exe + 采集组件目录 + 使用说明」
   作为一个数据目录塞进来，安装时整目录复制到目标位置。
   不重新打包、不压缩改写，保证装出来的东西和验证过的一模一样。

3. **不打包卸载器**：卸载入口在主程序里（`求职猎手工作台.exe --uninstall`），
   注册表 UninstallString 指向它。否则要把这个几十 MB 的安装包再往
   安装目录塞一份，凭空多占一倍空间。
"""

a = Analysis(
    ['installer_src/installer.py'],
    pathex=['installer_src'],
    binaries=[],
    datas=[
        ('payload', 'payload'),
    ],
    hiddenimports=[],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 标准库一律不排 —— 上一轮踩过：排掉 email 让 urllib.request 崩掉。
    # tkinter 这里确实没有（本机 Python 就没装），排掉不会报错。
    excludes=[
        'tkinter', 'unittest', 'pydoc', 'doctest', 'xmlrpc',
        'pytest', 'setuptools', 'pip', 'numpy', 'PIL',
    ],
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
    name='求职猎手工作台-安装程序',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    runtime_tmpdir=None,
    console=False,              # 安装程序不要黑窗口
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='src/favicon.ico',
)
