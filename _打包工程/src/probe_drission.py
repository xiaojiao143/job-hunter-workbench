#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""DrissionPage frozen 环境可行性验证（一次性测试脚本，不进最终交付）

要回答的问题：把 DrissionPage 打包成 PyInstaller 单文件 exe 之后，
它还能不能在别人的机器上找到 Edge、起 CDP 连接、打开网页？

如果不能，整套「采集组件 exe」方案就不成立，必须先换方案。
"""
import os
import sys
import tempfile
import traceback


def main():
    log = []
    def w(s):
        log.append(str(s))
        print(s, flush=True)

    w('=== DrissionPage frozen 验证 ===')
    w('frozen      : %s' % getattr(sys, 'frozen', False))
    w('_MEIPASS    : %s' % getattr(sys, '_MEIPASS', '(无)'))

    # 1) 能否 import
    try:
        import DrissionPage
        w('import      : OK  version=%s' % getattr(DrissionPage, '__version__', '?'))
    except Exception as e:
        w('import      : 失败 %s: %s' % (type(e).__name__, e))
        w(traceback.format_exc())
        return 1

    # 2) 配置文件（configs.ini / suffixes.dat）能否读到
    try:
        from DrissionPage._configs.chromium_options import ChromiumOptions
        co = ChromiumOptions()
        w('ChromiumOptions 实例化: OK')
    except Exception as e:
        w('ChromiumOptions 实例化: 失败 %s: %s' % (type(e).__name__, e))
        return 1

    # 3) 能否找到浏览器（复用 skill 自己的探测逻辑）
    exe = None
    try:
        sys.path.insert(0, os.path.join(getattr(sys, '_MEIPASS', '.'), 'scripts'))
        from browser_finder import find_chrome_browser
        exe = find_chrome_browser()
        w('browser_finder: %s' % (exe or '没找到'))
    except Exception as e:
        w('browser_finder 不可用（%s），改用自带探测' % type(e).__name__)

    if exe and os.path.exists(exe):
        co.set_browser_path(exe)
        w('已显式指定浏览器路径')
    else:
        w('未指定路径，交给 DrissionPage 自己探测')

    # 4) 真正起浏览器
    ud = os.path.join(tempfile.gettempdir(), 'jh_frozen_test_profile')
    co.set_argument('--user-data-dir', ud)
    co.set_argument('--disable-blink-features=AutomationControlled')
    co.headless(True)          # 无头，避免弹窗干扰测试

    try:
        from DrissionPage import Chromium
        w('正在启动浏览器…')
        b = Chromium(co)
        w('浏览器启动: OK')
        # DrissionPage 4.x：Chromium 是浏览器对象，页面要经 latest_tab 拿
        tab = b.latest_tab
        w('取得标签页  : OK')
        tab.get('about:blank')
        w('打开页面    : OK  url=%s' % tab.url)
        title = tab.title
        w('读取标题    : OK  "%s"' % title)
        b.quit()
        w('关闭浏览器  : OK')
        w('')
        w('>>> 结论：DrissionPage 可用 <<<')
        return 0
    except Exception as e:
        w('启动浏览器失败: %s: %s' % (type(e).__name__, e))
        w(traceback.format_exc())
        w('')
        w('>>> 结论：DrissionPage 不可用 <<<')
        return 2


if __name__ == '__main__':
    code = main()
    try:
        input('\n按回车关闭…')
    except Exception:
        pass
    sys.exit(code)
