#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""静态收集 crawler_src 需要打包的第三方依赖。

为什么需要这一步
----------------
入口用 runpy.run_path() 动态执行采集脚本 —— PyInstaller 的静态分析
**扫不到**这些脚本里的 import，第三方依赖会被整个漏掉，打出来的 exe
一跑就 ModuleNotFoundError。所以这里自己扫一遍源码，把第三方顶层模块名
交给 spec 的 hiddenimports。
"""
import ast
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'crawler_src', 'scripts')

STDLIB = set(sys.stdlib_module_names)


def local_tops():
    """crawler_src 里的本地包/模块名 —— 它们是源码，不需要 hiddenimports
    （运行时会从 _MEIPASS/scripts 直接 import）。"""
    tops = set()
    for name in os.listdir(SRC):
        p = os.path.join(SRC, name)
        if os.path.isdir(p) and os.path.exists(os.path.join(p, '__init__.py')):
            tops.add(name)
        elif name.endswith('.py'):
            tops.add(name[:-3])
    return tops


def scan():
    local = local_tops()
    found = {}

    for root, dirs, files in os.walk(SRC):
        dirs[:] = [d for d in dirs if d != '__pycache__']
        for f in files:
            if not f.endswith('.py'):
                continue
            path = os.path.join(root, f)
            try:
                tree = ast.parse(open(path, encoding='utf-8', errors='ignore').read())
            except SyntaxError:
                continue
            for node in ast.walk(tree):
                names = []
                if isinstance(node, ast.Import):
                    names = [a.name for a in node.names]
                elif isinstance(node, ast.ImportFrom):
                    if node.level:            # 相对导入 → 本地
                        continue
                    if node.module:
                        names = [node.module]
                for n in names:
                    top = n.split('.')[0]
                    if top in STDLIB or top in local or top.startswith('_'):
                        continue
                    found.setdefault(top, set()).add(os.path.relpath(path, SRC))

    return found


def main():
    found = scan()
    print('=== 第三方依赖（静态扫描）===')
    for name in sorted(found):
        users = sorted(found[name])
        print('  %-24s ← %s' % (name, ', '.join(users[:3]) + (' …' if len(users) > 3 else '')))
    print()
    print('共 %d 个' % len(found))
    print()
    # 输出可直接嵌进 spec 的 python 列表字面量
    print('HIDDEN =', sorted(found))


if __name__ == '__main__':
    main()
