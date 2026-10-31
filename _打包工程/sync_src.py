# -*- coding: utf-8 -*-
"""_打包工程/sync_src.py —— 前端副本同步 + 一致性闸门

背景（血泪）
============
`_打包工程/src/` 是**手工 cp 副本**，打包 spec 打的是它、不是 `求职猎手工作台/` 源码。
历史上漏过整个 `js/store.js` —— 打包版连 S1 台账一起缺，而且**明文 grep exe 查不到**
（归档压缩），只有用户装完才发现功能没了。

本脚本做两件事
--------------
1. **--apply**：把源码前端**白名单**同步到 `src/`（只增改、不删；落盘前备份）。
2. **--check**：只校验、不写盘；不一致 **exit 1** —— 用来做出包前的**闸门**。

为什么不是裸 `cp -r`
--------------------
`src/` 里还住着**手工维护的孪生文件**：
  · `server_core.py` = `采集器/server.py` + 便携版补丁（**必须手工改，绝不能覆盖**）
  · `launcher.py` / `browser_finder.py` / `probe_drission.py`（打包专用，源码里没有）
  · `data/`（打包用数据目录，与源码 `data/` 语义不同）
⇒ 全量 cp 会把这些一起污染。**只同步 spec 里 datas 声明的那几项**。

用法
----
    python sync_src.py            # dry-run，只报告
    python sync_src.py --apply    # 真同步（先备份 src/）
    python sync_src.py --check    # 闸门模式：不一致 exit 1（出包前跑这个）
"""

import argparse
import hashlib
import os
import re
import shutil
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_DIR = os.path.join(HERE, 'src')                       # 打包副本
ROOT_DIR = os.path.abspath(os.path.join(HERE, '..', '求职猎手工作台'))  # 源码

# ---- 白名单：与 求职猎手工作台.spec 的 datas 一一对应 -------------------
# 只同步这些。**不要**把 server_core.py / launcher.py / data/ 加进来。
WHITELIST = [
    'index.html',
    'favicon.ico',
    'css',
    'js',
]

# ---- 过滤：这些名字出现在任一侧都视为"杂项"，同步时跳过 ----------------
JUNK_PATTERNS = [
    re.compile(r'\.pre_[^/\\]*$'),     # store.js.pre_s1_20261007_230355
    re.compile(r'\.prebak$'),
    re.compile(r'\.bak$'),
    re.compile(r'\.旧'),
    re.compile(r'^__pycache__$'),
    re.compile(r'^node_modules$'),
    re.compile(r'~$'),
]


def is_junk(name):
    return any(p.search(name) for p in JUNK_PATTERNS)


def sha256_of(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 16), b''):
            h.update(chunk)
    return h.hexdigest()


def collect(base, rel_items):
    """把白名单条目展开成 {相对路径: 绝对路径}，跳过杂项。"""
    out = {}
    for item in rel_items:
        full = os.path.join(base, item)
        if os.path.isfile(full):
            if not is_junk(os.path.basename(full)):
                out[item.replace('\\', '/')] = full
        elif os.path.isdir(full):
            for dirpath, dirnames, filenames in os.walk(full):
                dirnames[:] = [d for d in dirnames if not is_junk(d)]
                for fn in filenames:
                    if is_junk(fn):
                        continue
                    fp = os.path.join(dirpath, fn)
                    rel = os.path.relpath(fp, base).replace('\\', '/')
                    out[rel] = fp
        # 不存在：由调用方按"新增"处理
    return out


def main():
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group()
    g.add_argument('--apply', action='store_true', help='真的写盘（默认 dry-run）')
    g.add_argument('--check', action='store_true', help='闸门模式：不一致则 exit 1')
    args = ap.parse_args()

    if not os.path.isdir(ROOT_DIR):
        print(f'✗ 源码目录不存在：{ROOT_DIR}')
        return 2
    if not os.path.isdir(SRC_DIR):
        print(f'✗ 副本目录不存在：{SRC_DIR}')
        return 2

    src_files = collect(ROOT_DIR, WHITELIST)   # 源
    dst_files = collect(SRC_DIR, WHITELIST)    # 副本

    added, updated, same, orphan, junk_in_dst = [], [], [], [], []

    for rel, sfull in sorted(src_files.items()):
        dfull = os.path.join(SRC_DIR, rel)
        if not os.path.exists(dfull):
            added.append(rel)
        elif sha256_of(sfull) != sha256_of(dfull):
            updated.append(rel)
        else:
            same.append(rel)

    for rel in sorted(dst_files):
        if rel not in src_files:
            orphan.append(rel)

    # 反向污染检查：副本里有没有杂项文件（历史上的 .pre_ / .bak）
    for item in WHITELIST:
        full = os.path.join(SRC_DIR, item)
        if os.path.isdir(full):
            for dirpath, dirnames, filenames in os.walk(full):
                for fn in filenames:
                    if is_junk(fn):
                        junk_in_dst.append(
                            os.path.relpath(os.path.join(dirpath, fn), SRC_DIR)
                            .replace('\\', '/'))
        elif os.path.isfile(full) and is_junk(os.path.basename(full)):
            junk_in_dst.append(item)

    print(f'源码目录：{ROOT_DIR}')
    print(f'副本目录：{SRC_DIR}')
    print(f'白名单  ：{WHITELIST}')
    print()
    print(f'  新增 {len(added):3d}  | 更新 {len(updated):3d}  | 一致 {len(same):3d} '
          f'| 孤儿 {len(orphan):3d} | 副本杂项 {len(junk_in_dst):3d}')
    for rel in added:
        print(f'    [新增] {rel}')
    for rel in updated:
        print(f'    [更新] {rel}')
    for rel in orphan:
        print(f'    [孤儿] {rel}   ← 副本有、源码无（不自动删，需人工确认）')
    for rel in junk_in_dst:
        print(f'    [杂项] {rel}   ← 副本里的备份/临时文件，建议手工清理')

    # ---- 闸门 ----
    if args.check:
        bad = bool(added or updated or junk_in_dst)
        if bad:
            print('\n✗ 副本与源码不一致（或含杂项）→ 出包前必须先 `--apply` 并清理。')
            return 1
        print('\n✓ 副本与源码一致，可安全出包。')
        return 0

    if not args.apply:
        if added or updated:
            print('\n(dry-run) 有差异。确认无误后加 --apply 落盘。')
        else:
            print('\n(dry-run) 无差异。')
        return 0

    # ---- 落盘 ----
    if not (added or updated):
        print('\n无差异，无需写盘。')
        return 0

    stamp = time.strftime('%Y%m%d_%H%M%S')
    backup = os.path.join(HERE, f'_backup_src_presync_{stamp}')
    shutil.copytree(SRC_DIR, backup,
                    ignore=shutil.ignore_patterns('__pycache__'))
    print(f'\n已备份 src/ → {backup}')

    for rel in added + updated:
        s = src_files[rel]
        d = os.path.join(SRC_DIR, rel)
        os.makedirs(os.path.dirname(d), exist_ok=True)
        shutil.copy2(s, d)
    print(f'已同步 {len(added) + len(updated)} 个文件（只增改，未删除任何文件）。')

    # 落盘后复检
    again_added, again_updated = [], []
    for rel, sfull in src_files.items():
        dfull = os.path.join(SRC_DIR, rel)
        if not os.path.exists(dfull):
            again_added.append(rel)
        elif sha256_of(sfull) != sha256_of(dfull):
            again_updated.append(rel)
    if again_added or again_updated:
        print(f'✗ 同步后仍不一致：新增 {again_added} / 更新 {again_updated}')
        return 1
    print('✓ 同步完成并复检通过。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
