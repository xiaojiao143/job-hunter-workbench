# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller 打包配置 —— 采集组件

设计要点
--------
1. **runpy 动态执行**：入口用 runpy.run_path 跑采集脚本，PyInstaller 静态
   分析扫不到脚本里的 import，所以第三方依赖必须靠 hiddenimports 显式喂进去
   （清单由 scan_deps.py 扫描产出，见下方 HIDDEN）。

2. **源码随包**：crawler_src/scripts/ 整个作为 datas 放进 exe，运行时由
   entry.py 加到 sys.path。这样 boss-crawler 内部几十处 subprocess 自我调用
   （`[sys.executable, script('x.py')]`）才能落到真实文件上 —— 入口认识
   `.py` 路径形式的参数，会再次以 __main__ 跑它。

3. **白名单**：只收 scripts/ 与 assets/ 里三个字典文件。绝不收
   chrome_user_data（162MB 登录态）与 llm_config.json（明文密钥）。
   build_crawler_src.py 已做终检扫描。

4. 用 onedir 而非 onefile：体积大（~40MB），onefile 每次启动都要解压到
   临时目录、还要跑一次完整 GC，启动明显变慢；而且 onefile 的自我调用
   （sys.executable 递归）会反复解压，采集跑十几分钟会很难受。
   onedir 启动快、自我调用走同一份解压结果。
"""

# 由 scan_deps.py 扫描 crawler_src/scripts 产出（真实第三方，非本地模块）
HIDDEN = [
    'DrissionPage',
    'PIL',
    'PyPDF2',
    'chardet',
    'docx',
    'requests',
    'openpyxl',
]

a = Analysis(
    ['crawler_src/entry.py'],
    pathex=['crawler_src', 'crawler_src/scripts'],
    binaries=[],
    datas=[
        ('crawler_src/scripts', 'scripts'),
        ('crawler_src/assets',  'assets'),
    ],
    hiddenimports=HIDDEN,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    # 只排真正用不上的重物。标准库一律不动 ——
    # 上一轮踩过：排掉 email 导致 urllib.request 崩掉，exe 双击即死。
    excludes=[
        'tkinter', 'unittest', 'pydoc', 'doctest', 'xmlrpc',
        'pytest', 'setuptools', 'pip', 'IPython',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='采集组件',
    debug=False,
    strip=False,
    upx=False,
    console=True,
    disable_windowed_traceback=False,
    icon='src/favicon.ico',
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='采集组件',
)
