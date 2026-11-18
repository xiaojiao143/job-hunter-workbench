#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""采集组件 · 源码裁剪脚本（可重跑）

从本机已装的 boss-crawler 技能里，挑出「采集链路真正需要的东西」，
复制到 _打包工程/crawler_src/，供 PyInstaller 打包。

为什么必须走白名单
------------------
技能目录 232MB，其中 **162MB 是 BOSS 登录态 cookie、1KB 是明文模型密钥、
79MB 是历史采集结果**。用「排除法」打包，只要漏一条，这些就跟着发出去了：
  · 登录态泄露 → 对方等于拿到你的 BOSS 账号
  · 密钥泄露   → 对方直接烧你的模型额度
所以这里**只列要什么，不列不要什么**。

路径改造
--------
boss-crawler 用 `__file__` 上溯定位 assets/（config.py:172 等 4 处）。
打包后 `__file__` 指向临时解包目录，落盘数据一关就没、登录态每次都丢。
故在副本里加环境变量旁路 —— **原件一个字节都不动**。
"""
import os
import re
import shutil
import sys

# ⛔ 采集组件源码的位置不能写死本机绝对路径（会泄漏作者 Windows 用户名，
#   别人 clone 下来也跑不了）。解析顺序：
#     ① 环境变量 JH_SKILL_DIR（显式指定）
#     ② 用户家目录下的 skill 目录（本机老环境）
_HOME = os.environ.get('USERPROFILE') or os.environ.get('HOME') or ''
SRC_SKILL = (os.environ.get('JH_SKILL_DIR')
             or os.path.join(_HOME, '.workbuddy', 'skills', 'boss-crawler'))
HERE = os.path.dirname(os.path.abspath(__file__))
DST = os.path.join(HERE, 'crawler_src')

# 采集链路需要的入口脚本 —— 与 采集器/server.py 里 build_cmd_* 一一对应
NEEDED_SCRIPTS = ['pipeline.py']
NEEDED_STAGES = ['boss_post_interactive.py', 'boss_apply_one.py', 'boss_chat_sync.py']

# ⛔ 住在 DST 里、但**不是从技能拷来的**文件 —— 本脚本清空 DST 前要先把它们捞出来。
#    `entry.py` 是本工程手写的打包入口（采集组件.spec 的 Analysis 入口就是它），
#    它恰好躺在 crawler_src/ 下。下面 `shutil.rmtree(DST)` 会把它一起删掉，
#    于是「按文档跑第 1 步构建」→ PyInstaller 报找不到入口文件。
#    （2026-10-07 真踩过：清空后才发现 采集组件.spec 的入口没了，好在回收站里还在。）
#    ⇒ 新增这类"非技能产物"时，**必须**加进这个列表。
KEEP_IN_DST = ['entry.py']

# 运行时字典：不含个人信息，但少了采集一步都走不了
NEEDED_ASSETS = ['post_data.json', 'weizhi.json', 'llm_config.example.json']

# 明确拒收（出现在源里就直接中断，防止将来上游改结构后静默带上隐私）
FORBIDDEN = ['chrome_user_data', 'llm_config.json']

# 开发期杂项（备份/临时件）。不是隐私，但**没道理跟着发出去** ——
# 一个 preferences.py.bak-20261007 进包后，下一个人得先花时间搞清"哪份才算数"。
# ⛔ 与 sync_src.py 的 JUNK_PATTERNS 同一套口径；那边 `\.bak$` 只认结尾，
#    而本仓库的备份习惯是 `xxx.py.bak-20261007`（结尾是日期）⇒ 这里必须写成 `\.bak(-|$)`。
JUNK_PATTERNS = [
    re.compile(r'\.pre_[^/\\]*$'),      # preferences.py.pre_s1_20261008
    re.compile(r'\.prebak$'),
    re.compile(r'\.bak(-|$)'),          # x.py.bak / x.py.bak-20261007
    re.compile(r'\.旧'),
    re.compile(r'~$'),
]


def is_junk(name):
    return any(p.search(name) for p in JUNK_PATTERNS)


def log(s):
    print(s, flush=True)


def copy_tree_filtered(src, dst, skip_names=(), skip_pycache=True):
    """复制目录，跳过指定名字与 __pycache__。返回 (文件数, 字节数)。"""
    n = sz = 0
    for root, dirs, files in os.walk(src):
        rel = os.path.relpath(root, src)
        dirs[:] = [d for d in dirs
                   if d not in skip_names and not (skip_pycache and d == '__pycache__')
                   and not is_junk(d)]
        for d in list(dirs):
            if d in FORBIDDEN:
                log('  ⛔ 拒收隐私目录: %s' % os.path.join(rel, d))
                dirs.remove(d)
        target = os.path.join(dst, rel) if rel != '.' else dst
        os.makedirs(target, exist_ok=True)
        for f in files:
            if skip_pycache and f.endswith('.pyc'):
                continue
            if f in FORBIDDEN:
                log('  ⛔ 拒收隐私文件: %s' % os.path.join(rel, f))
                continue
            if is_junk(f):
                log('  ✂ 跳过杂项: %s' % os.path.join(rel, f))
                continue
            s = os.path.join(root, f)
            try:
                shutil.copy2(s, os.path.join(target, f))
                n += 1
                sz += os.path.getsize(s)
            except OSError as e:
                log('  ! 复制失败 %s: %s' % (s, e))
    return n, sz


def patch_paths():
    """给副本里**所有**「拼 assets 路径」的地方加 JH_BOSS_ASSETS 旁路。

    ⛔ 血教训之一（2026-10-07，用户实测踩到，代价是「上传简历并解析」全程无效）：
       这里原来是一份**硬编码的 4 个文件**清单 ——
           boss_crawler/config.py · llm/config.py
           deliver/render_images.py · deliver/write_application_md.py
       漏了 `resume_matcher/config.py`（运行目录的真源，OUTPUT_DIR）
       和 `preferences.py`（采集参数预设）。后果不是"少一个功能"，而是：
         · pipeline 把运行目录写进 PyInstaller 的 _internal/assets/
         · 采集器服务端读的是 exe 旁边的 assets/
         → LATEST.txt 永远读不到 → runDir 恒为 None → hasProfile 恒为 false
         → 界面永远显示「还缺简历画像」，**连 profile.json 已经生成都看不出来**。
       而且这类 bug 在开发目录里跑（两者恰好是同一处）**永远复现不了**。

    ⛔ 血教训之二（同一天，改这个函数时差点自己犯）：
       **只包 assets，绝不动 `_SKILL_ROOT` 本身。**
       `_SKILL_ROOT` 在包里有两层含义 ——
         · join(root, 'assets')   → 该指向**用户数据目录**（exe 旁，JH_BOSS_ASSETS）
         · join(root, 'scripts')  → 该指向**包内的 scripts/**（_internal/scripts）
       早先的写法把 `_SKILL_ROOT` 整个换成 JH_BOSS_ROOT，于是
       `deliver/render_images.py` 的 `join(_SKILL_ROOT, 'scripts', 'showcv')`
       被指到一个根本不存在的 `采集组件/scripts/showcv`。
       包 assets 这一个动作就能同时满足两种用途。

    ⛔ 血教训之三：**清单式补丁本身就是 bug 源** —— 它要求"下次改代码的人记得同步清单"。
       所以改成**自动扫描**：遍历副本里每个 .py，凡是 `join(<根变量>, 'assets')` 的写法
       一律包一层。并且最后**自检**有没有漏网的（漏了就把构建判失败）。
    """
    changed = []
    missed = []

    # 主规则：把 `os.path.join(<根变量>, 'assets' ...)` 整个**前缀**换成
    # 「JH_BOSS_ASSETS 优先，否则退回原来的 join(根变量, 'assets')」。
    #
    # ⛔ 这里有两个坑，都真踩过：
    #   ① 不能写成 `join\(X, 'assets'\)`（要求右括号紧跟）——
    #      `join(_SKILL_ROOT, 'assets', 'llm_config.json')` 这种多实参写法就漏了。
    #   ② ⛔ **不能只把第一个实参换成 JH_BOSS_ASSETS**：
    #      `JH_BOSS_ASSETS` 本身就是 assets 目录（不是根），
    #      那样会得到 `...\assets\assets\llm_config.json`（双重 assets）。
    #      正确做法是把 `join(X,'assets')` 这一段整体替换成
    #      `join(JH_BOSS_ASSETS or join(X,'assets')` —— 多出来的那个右括号
    #      正好补上内层 join，外层原有的右括号继续闭合外层。
    #      两种实参数量都能覆盖：
    #        join(X,'assets')                  → join(JH or join(X,'assets'))      = JH or join(X,'assets')
    #        join(X,'assets','a.json')         → join(JH or join(X,'assets'),'a.json')
    AJOIN = re.compile(r"\bos\.path\.join\(\s*([A-Za-z_][\w\.]*)\s*,\s*'assets'")

    # ⛔ 不能包的文件（每个都必须写清理由 —— 没理由的白名单会变成掩盖问题的地方）
    SKIP_WRAP = {
        'scripts/stages/boss_apply_one.py':
            "skill_dir = dirname(dirname(_SCRIPTS)) 在便携版**正好就是数据根**"
            "（_internal/scripts → _internal → 采集组件），"
            "再包一层会变成 采集组件/assets/assets/... —— 反而弄坏",
    }

    def _wrap(raw):
        """逐行处理：已经认 JH_BOSS_ASSETS 的行不再重复包（否则会套娃）。"""
        out = []
        for line in raw.split('\n'):
            if 'JH_BOSS_ASSETS' in line:
                out.append(line)
                continue
            out.append(AJOIN.sub(
                lambda m: "os.path.join(os.environ.get('JH_BOSS_ASSETS') or "
                          "os.path.join(%s, 'assets')" % m.group(1), line))
        return '\n'.join(out)

    scripts_root = os.path.join(DST, 'scripts')
    for dirpath, _dirs, files in os.walk(scripts_root):
        for fn in files:
            if not fn.endswith('.py'):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, DST).replace('\\', '/')
            if rel in SKIP_WRAP:
                continue
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    raw = f.read()
            except (OSError, UnicodeDecodeError) as e:
                log('  ! 读不了 %s: %s' % (fn, e))
                continue
            orig = raw
            raw = _wrap(raw)
            if raw != orig:
                with open(path, 'w', encoding='utf-8') as f:
                    f.write(raw)
                changed.append(rel)
                log('  ✓ 已加 assets 旁路: %s' % rel)

    # ── 自检：还有没有"拼 assets 但不认 JH_BOSS_*"的漏网文件 ──
    # 判据收窄到「真的在拼 assets」：只看出现 'assets' / "assets" 字面量的文件。
    # （早先拿 `os.path.dirname(os.path.dirname(` 当判据，把 `_SCRIPTS = ...` 的定义
    #   也算了进去，一口气误报 19 个文件 —— 那种守卫没人会当真，等于没有。）
    # ⛔ 判之前必须剥掉注释与 docstring：注释里写着 "JH_BOSS_ASSETS" 会把检查骗过去
    #   （2026-10-07 真踩：把 OUTPUT_DIR 的环境变量摘掉后，断言依然绿，
    #    因为说明注释里就有这串字）。
    # 已知「看着像、其实是对的」走白名单，且**必须写明理由**；
    # 无理由的白名单会慢慢变成掩盖问题的地方。
    KNOWN_SAFE = {
        'scripts/stages/boss_apply_one.py':
            "dirname(dirname(_SCRIPTS)) 在便携版正好落到 采集组件/，实测路径是对的",
        'scripts/showcv/_browser.py': "工作台前端不调用 showcv（纯 skill 侧的简历编辑器）",
        'scripts/showcv/delete_resumes.py': "同上",
        'scripts/showcv/export_images.py': "同上",
        'scripts/showcv/storage.py': "同上",
        'scripts/showcv/serve.py': "同上",
        'scripts/showcv/sync_app.py': "同上",
    }
    HAS_ASSETS = re.compile(r"""['"]assets['"]""")
    DOCSTR = re.compile(r'"""[\s\S]*?"""|\'\'\'[\s\S]*?\'\'\'')

    def _strip_py(text):
        text = DOCSTR.sub('""', text)
        return '\n'.join(re.sub(r'#.*$', '', ln) for ln in text.split('\n'))

    for dirpath, _dirs, files in os.walk(scripts_root):
        for fn in files:
            if not fn.endswith('.py'):
                continue
            path = os.path.join(dirpath, fn)
            rel = os.path.relpath(path, DST).replace('\\', '/')
            if rel in KNOWN_SAFE:
                continue
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    code = _strip_py(f.read())
            except (OSError, UnicodeDecodeError):
                continue
            # 认 JH_BOSS_ASSETS 或 JH_BOSS_ROOT 都算合格 ——
            # `_SKILL_ROOT = JH_BOSS_ROOT or (...)` + `join(_SKILL_ROOT,'assets')`
            # 这条链在便携版同样是对的。这里防的是**一个都不认**。
            if (HAS_ASSETS.search(code)
                    and 'JH_BOSS_ASSETS' not in code
                    and 'JH_BOSS_ROOT' not in code):
                missed.append(rel)

    if missed:
        log('')
        log('  ✗ 以下模块仍在拼 assets 但不认 JH_BOSS_ASSETS —— 便携版下会读写错目录：')
        for rel in missed:
            log('      %s' % rel)
        log('    （让模块自己认 JH_BOSS_ASSETS，或加进 KNOWN_SAFE 并写清理由）')

    return changed, missed


def main():
    if not os.path.isdir(SRC_SKILL):
        log('✗ 找不到源技能目录: %s' % SRC_SKILL)
        return 1

    log('=== 采集组件源码裁剪 ===')
    log('源: %s' % SRC_SKILL)
    log('目标: %s' % DST)

    # ⛔ 先捞出「非技能产物」（见 KEEP_IN_DST 的注释）。不清这一步，
    #    rmtree 会把打包入口 entry.py 一起带走 —— 构建当场断在这里。
    kept = {}
    for name in KEEP_IN_DST:
        p = os.path.join(DST, name)
        if os.path.isfile(p):
            with open(p, 'rb') as f:
                kept[name] = f.read()

    if os.path.exists(DST):
        log('清空旧目标…')
        shutil.rmtree(DST)
    os.makedirs(DST, exist_ok=True)

    for name, blob in kept.items():
        with open(os.path.join(DST, name), 'wb') as f:
            f.write(blob)
        log('  ↺ 已放回 %s（%d 字节，非技能文件）' % (name, len(blob)))

    # ---- 非技能产物必须在场，否则采 集组件.spec 的入口是空的 ----
    log('')
    for name in KEEP_IN_DST:
        p = os.path.join(DST, name)
        if not os.path.exists(p):
            log('  ✗ %s 缺失 —— 采集组件.spec 的打包入口就是它，构建必然失败！' % name)
            log('     （从备份/回收站恢复后重跑本脚本；或把它加进 KEEP_IN_DST 之外的保管位置。）')
            return 4
        log('  ✓ %s（打包入口）' % name)

    # ---- scripts/ 全量收（985KB，纯代码，无隐私）----
    log('\n[1/4] scripts/')
    n, sz = copy_tree_filtered(os.path.join(SRC_SKILL, 'scripts'),
                               os.path.join(DST, 'scripts'))
    log('  %d 个文件, %.1f KB' % (n, sz / 1024))

    # 确认四个入口都在
    log('\n[2/4] 校验采集入口')
    for s in NEEDED_SCRIPTS:
        p = os.path.join(DST, 'scripts', s)
        log('  %s pipeline/%s' % ('✓' if os.path.exists(p) else '✗ 缺失', s))
    for s in NEEDED_STAGES:
        p = os.path.join(DST, 'scripts', 'stages', s)
        log('  %s stages/%s' % ('✓' if os.path.exists(p) else '✗ 缺失', s))

    # ---- assets/ 只挑三个文件 ----
    log('\n[3/4] assets/（白名单）')
    adst = os.path.join(DST, 'assets')
    os.makedirs(adst, exist_ok=True)
    for name in NEEDED_ASSETS:
        s = os.path.join(SRC_SKILL, 'assets', name)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(adst, name))
            log('  ✓ %s (%.1f KB)' % (name, os.path.getsize(s) / 1024))
        else:
            log('  ! %s 不存在（跳过）' % name)

    # ---- 路径旁路 ----
    log('\n[4/4] 路径旁路改造')
    changed, missed = patch_paths()
    log('  共改 %d 个文件' % len(changed))
    if missed:
        # ⛔ 必须**构建失败**，不能只打一句警告往下跑 ——
        #    漏一个模块 = 便携版读写错目录，而开发目录里跑永远复现不了，
        #    最后是用户在用的时候才发现（2026-10-07 就是这么出的事）。
        log('')
        log('✗ 有模块仍在推导路径但不认 JH_BOSS_* —— 构建中止')
        log('  这些模块在便携版下会写到 PyInstaller 的 _internal 里，界面读不到。')
        return 5

    # ---- 终检：确认没有隐私东西混进来 ----
    log('\n=== 终检：隐私扫描 ===')
    bad = []
    for root, dirs, files in os.walk(DST):
        for name in list(dirs) + files:
            if name in FORBIDDEN:
                bad.append(os.path.join(root, name))
    if bad:
        log('✗ 发现隐私残留，构建中止：')
        for b in bad:
            log('   %s' % b)
        return 2
    log('✓ 无 chrome_user_data / llm_config.json 残留')

    # 杂项扫描：开发期的备份/临时件不该进包（2026-10-08 真踩：crawler_src 里混进
    # 3 个 `*.bak-20261007`，PyInstaller 照单全收进了 _internal/scripts/）。
    junk = []
    for root, _dirs, files in os.walk(DST):
        for name in files:
            if is_junk(name):
                junk.append(os.path.relpath(os.path.join(root, name), DST))
    if junk:
        log('✗ 发现开发期杂项（备份/临时件），构建中止 —— 它们不该跟着发出去：')
        for j in junk:
            log('   %s' % j)
        log('   （把源文件删掉/改名，或补进 JUNK_PATTERNS —— 但要写清理由）')
        return 6
    log('✓ 无 .bak / .pre_* / .旧 等开发期杂项')

    total = sum(os.path.getsize(os.path.join(r, f))
                for r, _, fs in os.walk(DST) for f in fs)
    cnt = sum(len(fs) for _, _, fs in os.walk(DST))
    log('\n产出: %s' % DST)
    log('  %d 个文件, %.1f KB' % (cnt, total / 1024))
    return 0


if __name__ == '__main__':
    sys.exit(main())
