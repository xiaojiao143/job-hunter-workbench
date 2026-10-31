#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""求职猎手工作台 · 采集组件（打包入口）

它是 boss-crawler 采集链路的一个「免安装外壳」—— 朋友那边不用装 Python、
不用建虚拟环境，双击主程序就能用采集功能。

为什么要做成「分发器」而不是直接打包 pipeline.py
----------------------------------------------
boss-crawler 内部大量使用 `subprocess.run([sys.executable, script('x.py'), ...])`
来自我调用（pipeline.py:310 起，十余处）。打包成 exe 后 `sys.executable`
指向这个 exe 自己，于是子调用会变成：

    采集组件.exe  <某个脚本的路径>  <参数…>

所以本入口**必须同时认识两种调用形式**，否则链路在第一次子调用时就断：

    采集组件.exe pipeline  --from infer --to crawl      ← 主程序这么调
    采集组件.exe C:\\…\\scripts\\stages\\infer_params.py  <参数…>   ← pipeline 自己这么调

统一用 runpy.run_path(..., run_name='__main__') 执行目标脚本 —— 这样
脚本里 `if __name__ == '__main__':` 的分支、sys.argv 的语义都和直接
`python x.py` 完全一致，不需要为打包改上游任何一行代码。

数据落在哪
----------
上游用 `__file__` 上溯定位 assets/。打包后那是临时解包目录，一关就没 ——
登录态每次都要重扫码、采集结果直接丢。所以这里设 JH_BOSS_ROOT 指向
**exe 旁边的 data 目录**，上游 config.py 已被改成认这个环境变量。
（改动只发生在打包副本里，使用者本机的技能目录一个字节都没动。）
"""

import os
import runpy
import sys

APP = '采集组件'
IS_FROZEN = getattr(sys, 'frozen', False)

# 控制台编码：Windows 默认 GBK，爬虫的中文/emoji 进度会 UnicodeEncodeError
if os.name == 'nt':
    try:
        import ctypes
        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
        ctypes.windll.kernel32.SetConsoleCP(65001)
    except Exception:                                          # noqa: BLE001
        pass
for _s in (sys.stdout, sys.stderr):
    try:
        # line_buffering=True：父进程（工作台）是**逐行读管道**的，要实时把进度
        # 显示到界面上。Python 发现 stdout 是管道时会默认切块缓冲（攒 4~8KB 才吐），
        # 采集早期输出稀疏，界面上会长时间一片空白、看着像卡死。
        # 这里强制按行刷新，配合父进程给的 PYTHONUNBUFFERED=1 双保险。
        _s.reconfigure(encoding='utf-8', errors='replace', line_buffering=True)
    except Exception:                                          # noqa: BLE001
        pass


def bundle_root():
    """打包资源根（含 scripts/ 与 assets/ 骨架）。"""
    if IS_FROZEN:
        return getattr(sys, '_MEIPASS', os.path.dirname(sys.executable))
    return os.path.dirname(os.path.abspath(__file__))


def data_root():
    """用户数据根 —— 登录态、采集结果、模型配置都落这儿。

    放 exe 旁边而不是 AppData：这是给别人用的工具，出问题时
    「就在那个文件夹里」比什么都好找。不可写时退回用户目录。
    """
    if IS_FROZEN:
        base = os.path.dirname(sys.executable)
    else:
        base = os.path.dirname(os.path.abspath(__file__))
    probe = os.path.join(base, '_w.tmp')
    try:
        with open(probe, 'w', encoding='utf-8') as f:
            f.write('x')
        os.remove(probe)
        return base
    except Exception:                                          # noqa: BLE001
        d = os.path.join(os.path.expanduser('~'), '求职猎手工作台')
        os.makedirs(d, exist_ok=True)
        return d


# 主程序用的短名 → 实际脚本相对路径（与 采集器/server.py 的 build_cmd_* 对应）
ROUTES = {
    'pipeline':        'pipeline.py',
    'post':            'stages/boss_post_interactive.py',
    'boss_post':       'stages/boss_post_interactive.py',
    'apply_one':       'stages/boss_apply_one.py',
    'boss_apply_one':  'stages/boss_apply_one.py',
    'chat_sync':       'stages/boss_chat_sync.py',
    'boss_chat_sync':  'stages/boss_chat_sync.py',
    'infer':           'stages/infer_params.py',
    'parse':           'stages/parse_resume.py',
    'matcher':         'stages/run_matcher.py',
    # 只抽文字、不发给大模型（简历素材库「上传 PDF / Word」用）
    'extract_text':    'stages/extract_resume_text.py',
    'extract-text':    'stages/extract_resume_text.py',
}


def die(msg):
    print('\n' + '=' * 56, flush=True)
    print('  采集组件 · 启动失败', flush=True)
    print('=' * 56, flush=True)
    print('  ' + str(msg).replace('\n', '\n  '), flush=True)
    print('\n  请把这个窗口截图发给给你这个文件的人。', flush=True)
    if IS_FROZEN:
        try:
            input('  按回车键关闭…')
        except Exception:                                      # noqa: BLE001
            pass
    return 1


def show_help():
    print('求职猎手工作台 · 采集组件', flush=True)
    print('', flush=True)
    print('这个程序由「求职猎手工作台」自动调起，一般不需要手动打开。', flush=True)
    print('如果你想确认它是否正常，可以运行：', flush=True)
    print('    %s where' % os.path.basename(sys.executable or '采集组件.exe'), flush=True)
    print('', flush=True)
    print('可用子命令：', flush=True)
    for k in ('pipeline', 'post', 'apply_one', 'chat_sync', 'infer', 'parse', 'matcher',
              'extract_text'):
        print('    %-12s → %s' % (k, ROUTES[k]), flush=True)
    return 0


def cmd_where(deep=False):
    """自检：报告打包环境是否正常。给排查用，也给主程序探测用。

    deep=True 时额外做一次「真起浏览器」测试 —— 这是采集链路里最容易在
    别人机器上出问题的一环（浏览器没装、装在被裁剪过的系统上、被安全软件拦），
    所以单独给朋友一个能自己跑、能截图发回来的诊断命令。
    """
    root = bundle_root()
    d = data_root()
    scripts = os.path.join(root, 'scripts')
    checks = [
        ('打包资源根', root),
        ('脚本目录', scripts),
        ('数据目录', d),
        ('pipeline.py', os.path.join(scripts, 'pipeline.py')),
        ('字典 post_data.json', os.path.join(d, 'assets', 'post_data.json')),
        ('字典 weizhi.json', os.path.join(d, 'assets', 'weizhi.json')),
    ]
    print('=== 采集组件自检 ===', flush=True)
    print('frozen      : %s' % IS_FROZEN, flush=True)
    print('版本        : %s' % VERSION, flush=True)
    bad = 0
    for label, p in checks:
        ok = os.path.exists(p)
        if not ok:
            bad += 1
        print('%-20s %s  %s' % (label, '✓' if ok else '✗', p), flush=True)

    # 依赖自检
    try:
        import DrissionPage
        print('%-20s ✓  %s' % ('DrissionPage', getattr(DrissionPage, '__version__', '?')))
    except Exception as e:                                     # noqa: BLE001
        bad += 1
        print('%-20s ✗  %s' % ('DrissionPage', e))

    exe = None
    try:
        sys.path.insert(0, scripts)
        from browser_finder import find_chrome_browser
        exe = find_chrome_browser()
        print('%-20s %s  %s' % ('浏览器', '✓' if exe else '✗', exe or '没找到 Edge/Chrome'))
        if not exe:
            bad += 1
    except Exception as e:                                     # noqa: BLE001
        print('%-20s ✗  %s' % ('浏览器探测', e))
        bad += 1

    if deep:
        print('', flush=True)
        print('=== 深度测试：真起一次浏览器 ===', flush=True)
        try:
            import tempfile
            from DrissionPage import ChromiumOptions, Chromium
            co = ChromiumOptions()
            if exe:
                co.set_browser_path(exe)
            co.set_argument('--user-data-dir', os.path.join(tempfile.gettempdir(), 'jh_selftest_profile'))
            co.headless(True)
            print('  正在启动…', flush=True)
            b = Chromium(co)
            tab = b.latest_tab
            tab.get('about:blank')
            print('  启动成功 ✓  url=%s' % tab.url, flush=True)
            b.quit()
            print('  关闭成功 ✓', flush=True)
        except Exception as e:                                 # noqa: BLE001
            bad += 1
            print('  ✗ 启动失败: %s: %s' % (type(e).__name__, e), flush=True)
            import traceback
            traceback.print_exc()

    print('', flush=True)
    print('结论：%s' % ('一切正常，采集功能可用。' if bad == 0
                      else '有 %d 项异常，采集功能可能不可用。' % bad), flush=True)
    return 0 if bad == 0 else 3


VERSION = '1.0.0'


def seed_assets(quiet=True):
    """把打包内自带的字典补种到用户数据目录（首次运行时）。

    为什么必须做：post_data.json / weizhi.json 是采集的必需字典，
    缺了会退化成「开浏览器去抓」—— 而那条路会被风控挡下，采集一步都走不了。
    （上游 server.py 的「静态词典预检与自愈」一节讲的是同一个坑。）

    补种而不是直接读打包内那份：采集过程中上游会回写、更新这两个文件，
    必须落在可写且能持久的位置。
    """
    root = bundle_root()
    d = data_root()
    seeded = []
    for name in ('post_data.json', 'weizhi.json', 'llm_config.example.json'):
        src = os.path.join(root, 'assets', name)
        dst = os.path.join(d, 'assets', name)
        if os.path.exists(dst):
            continue
        if not os.path.exists(src):
            continue
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            with open(src, 'rb') as fi, open(dst, 'wb') as fo:
                fo.write(fi.read())
            seeded.append(name)
        except OSError:
            pass
    try:
        os.makedirs(os.path.join(d, 'assets'), exist_ok=True)
    except OSError:
        pass
    if seeded and not quiet:
        print('  已补种运行字典: %s' % ', '.join(seeded), flush=True)
    return seeded


def main():
    argv = sys.argv[1:]

    # 先补种字典 —— where 自检也要看得到，否则会误报「2 项异常」
    seed_assets()

    if not argv:
        return show_help()
    if argv[0] in ('where', '--where', 'selfcheck', '--selfcheck'):
        return cmd_where(deep=('--deep' in argv))
    if argv[0] in ('where-deep', '--where-deep'):
        return cmd_where(deep=True)
    if argv[0] in ('-h', '--help', 'help'):
        return show_help()

    root = bundle_root()
    scripts = os.path.join(root, 'scripts')
    d = data_root()

    # ── 把路径喂给上游（config.py / llm/config.py 已改成认这两个变量）──
    os.environ['JH_BOSS_ROOT'] = d
    os.environ['JH_BOSS_ASSETS'] = os.path.join(d, 'assets')
    os.environ.setdefault('PYTHONIOENCODING', 'utf-8')
    os.environ.setdefault('PYTHONUTF8', '1')

    sys.path.insert(0, scripts)

    # ── 解析目标脚本：两种调用形式 ──
    head = argv[0]
    if head.lower().endswith('.py'):
        # pipeline 内部用 sys.executable 自我调用时走这条
        target = os.path.abspath(head)
        rest = argv[1:]
        if not os.path.exists(target):
            return die('找不到要执行的脚本：\n%s' % target)
    else:
        rel = ROUTES.get(head)
        if not rel:
            print('未知子命令：%s' % head, flush=True)
            return show_help()
        target = os.path.join(scripts, rel)
        rest = argv[1:]
        if not os.path.exists(target):
            return die('找不到采集脚本 %s（应为 %s）' % (rel, target))

    # cwd 对齐上游做法（上游跑在 scripts/ 下）
    try:
        os.chdir(scripts)
    except OSError:
        pass

    # ⚠️ 关键：模拟 `python x.py` 的 sys.path 行为。
    # 直接 `python scripts/stages/parse_resume.py` 时，Python 会把**脚本所在目录**
    # （scripts/stages）放到 sys.path[0]，所以脚本里那些裸导入（如
    # `from validate_profile import run_validation`）才能命中同级文件。
    # 而 runpy.run_path **不做这件事** —— 不加这一步，parse 阶段第一步就 ModuleNotFoundError。
    script_dir = os.path.dirname(target)
    if script_dir and script_dir not in sys.path:
        sys.path.insert(0, script_dir)

    # ── 执行 ──
    saved = sys.argv
    sys.argv = [target] + rest
    try:
        runpy.run_path(target, run_name='__main__')
        return 0
    except SystemExit as e:
        code = e.code
        if code is None:
            return 0
        return code if isinstance(code, int) else 1
    except KeyboardInterrupt:
        print('\n  已中断。', flush=True)
        return 130
    except Exception:                                          # noqa: BLE001
        import traceback
        print('\n采集组件执行出错：\n', flush=True)
        traceback.print_exc()
        return 1
    finally:
        sys.argv = saved


if __name__ == '__main__':
    sys.exit(main())
