# -*- coding: utf-8 -*-
"""_打包工程/pack_main.py —— 主程序（求职猎手工作台）出包总入口

为什么要这个脚本
================
以前出包是**手工按四步敲命令**（见 细节档案.md §B），其中「把源码前端 cp 到 src/」
这一步**纯靠人记得**。历史代价：上一轮漏了整个 `js/store.js` —— 打包版连 S1 台账
一起缺，而且**明文 grep exe 查不到**（归档压缩），只有用户装完才发现。

本脚本把「同步闸门」做成**不可绕过**的第一步：
    sync_src.py --check 不通过 → 直接 exit，pyinstaller 根本不会启动。

用法
----
    python pack_main.py                # 默认：闸门 + 构建到自动命名的 dist_mainN
    python pack_main.py --dist dist_main14   # 指定输出目录
    python pack_main.py --skip-gate    # ⛔ 仅供调试；跳过闸门（会打印大警告）
    python pack_main.py --dry-run      # 只跑闸门 + 打印将要执行的命令，不构建

产物
----
    dist_mainN/求职猎手工作台.exe
（出包后仍需手工：cp 到 payload/、cp 到用户安装目录 —— 脚本会打印提醒。）
"""

import argparse
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SYNC = os.path.join(HERE, 'sync_src.py')
SPEC = os.path.join(HERE, '求职猎手工作台.spec')
PYI = os.path.join(HERE, '.venv', 'Scripts', 'pyinstaller.exe')
BUILD_SRC = os.path.join(HERE, 'src')

# 与 spec 的 datas 对应 —— 闸门通过后，再确认这些产物真的在 src/ 里
REQUIRED = ['index.html', 'favicon.ico', os.path.join('css', 'app.css')]


def log(s=''):
    print(s, flush=True)


def next_dist_name():
    """自动挑下一个可用的 dist_mainN，避免手写目录名把别人产物覆盖。"""
    n = 1
    existing = set()
    for name in os.listdir(HERE):
        if name.startswith('dist_main'):
            existing.add(name)
    while ('dist_main%d' % n) in existing:
        n += 1
    return 'dist_main%d' % n


def run_gate():
    """第一步闸门：前端副本必须与源码一致，否则中止。"""
    log('=' * 62)
    log('[闸门 1/2] 前端副本一致性（sync_src.py --check）')
    log('=' * 62)
    if not os.path.exists(SYNC):
        log('✗ 找不到 %s' % SYNC)
        return False
    r = subprocess.run([sys.executable, SYNC, '--check'])
    if r.returncode != 0:
        log('')
        log('✗ 前端副本与源码不一致 —— 出包中止。')
        log('  正解：先跑 `python sync_src.py --apply`，再重新执行本脚本。')
        return False
    log('✓ 闸门 1 通过')
    return True


def run_required_check():
    """第二步闸门：spec 声明要打进去的文件确实在 src/ 里（防漏件）。"""
    log('')
    log('=' * 62)
    log('[闸门 2/2] spec 声明文件存在性')
    log('=' * 62)
    missing = []
    for rel in REQUIRED:
        p = os.path.join(BUILD_SRC, rel)
        if os.path.exists(p):
            log('  ✓ %s' % rel)
        else:
            log('  ✗ %s 缺失' % rel)
            missing.append(rel)
    # js/ 里至少要有一批脚本，且不能只剩空目录
    js_dir = os.path.join(BUILD_SRC, 'js')
    js_files = [f for f in os.listdir(js_dir) if f.endswith('.js')] \
        if os.path.isdir(js_dir) else []
    log('  js/ 下 .js 文件 %d 个' % len(js_files))
    if len(js_files) < 5:
        log('  ✗ js/ 文件数异常偏少 —— 副本可能不完整')
        missing.append('js/(数量异常)')
    # 关键新模块必须在（防"闸门通过但关键件漏了"）
    for key in ['view-conflicts.js', 'store.js', 'view-jobs.js']:
        if key not in js_files:
            log('  ✗ 关键模块缺失：js/%s' % key)
            missing.append('js/' + key)
    if missing:
        log('✗ 缺少打包必需文件 → 中止（补进 src/ 再重跑）')
        return False
    log('✓ 闸门 2 通过')
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--dist', default=None, help='输出目录（默认自动挑 dist_mainN）')
    ap.add_argument('--skip-gate', action='store_true', help='跳过一致性闸门（仅调试用）')
    ap.add_argument('--dry-run', action='store_true', help='只跑闸门并打印命令，不构建')
    args = ap.parse_args()

    if not os.path.exists(PYI):
        log('✗ 找不到 pyinstaller：%s' % PYI)
        return 2
    if not os.path.exists(SPEC):
        log('✗ 找不到 spec：%s' % SPEC)
        return 2

    if args.skip_gate:
        log('⚠️⚠️ 已跳过一致性闸门（--skip-gate）—— 打包版可能含旧前端，仅调试用！')
        log('')
    else:
        if not run_gate():
            return 1
    if not run_required_check():
        return 1

    dist = args.dist or next_dist_name()
    cmd = [PYI, '--clean', '--noconfirm', '--distpath', dist, SPEC]
    log('')
    log('=' * 62)
    log('[构建] %s' % dist)
    log('=' * 62)
    log('  cwd : %s' % HERE)
    log('  cmd : %s' % ' '.join(cmd))
    if args.dry_run:
        log('(dry-run) 未执行构建。')
        return 0

    t0 = time.time()
    r = subprocess.run(cmd, cwd=HERE)
    if r.returncode != 0:
        log('✗ pyinstaller 失败（exit %d）' % r.returncode)
        return r.returncode

    exe = os.path.join(dist, '求职猎手工作台.exe')
    log('')
    log('✓ 构建完成，用时 %.0fs' % (time.time() - t0))
    if os.path.exists(exe):
        log('  产物: %s  (%.2f MB)' % (exe, os.path.getsize(exe) / 1048576))
        log('')
        log('【出包后仍需手工】')
        log('  1) 验证包内前端：pyi-archive_viewer -l -r -b "%s"' % exe)
        log('  2) 更新 payload/：cp 到 _打包工程/payload/求职猎手工作台.exe（旧版留 .旧_日期）')
        log('  3) 更新用户侧：cp 到 <工作台目录>/（先关掉在跑的程序）')
    else:
        log('  ! 未找到预期产物 %s，请检查 spec 的 name 字段' % exe)
    return 0


if __name__ == '__main__':
    sys.exit(main())
