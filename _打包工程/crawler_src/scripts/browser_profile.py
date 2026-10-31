#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""BOSS 相关操作用哪个浏览器 profile —— **单一真源**。

为什么需要它
------------
投递看板同一屏上有两类动作，原来走的是两个不同的浏览器：

    · 「去投递」   = 前端 window.open → 系统默认浏览器
                    （用户**平时用的 Edge**，本来就登录着 BOSS，零扫码）
    · 「一键打招呼」「同步回复」= 本工具另起窗口（assets/chrome_user_data）
                    （要单独扫码，且浏览器指纹与日常不同）

用户的原话：「采集功能的登陆boss和其他的boss登录非一致，需要重新打开减少风险」。

两种模式（服务端把设置读出来注入 `JH_BOSS_BROWSER_MODE` 子进程环境变量）：

    own   （默认）本工具自己的 assets/chrome_user_data —— 与日常浏览完全隔离
    daily        用户**日常 Edge** 的 profile —— 零扫码、指纹与日常一致

⛔ daily 模式的硬前提：那个 profile **不能正被 Edge 占用**
--------------------------------------------------------
Edge 在本机是**常驻后台**的（命令行带 `--no-startup-window --win-session-start`），
所以「没看见窗口」不等于「没在运行」。只要实例还在，新起的进程会把自己的命令行
转交给已有实例、然后**自己立刻退出** → DrissionPage 连不上调试端口 →
表现成「点了没反应」或超时。

所以这里**必须先检测、检测到就明确拒绝**，并把「怎么解决」写清楚 ——
绝不静默失败（静默失败正是第 25 轮那个 bug 让用户白白试了 8 次的原因）。
"""

from __future__ import annotations

import os

# 服务端读设置后注入子进程的环境变量名
MODE_ENV = 'JH_BOSS_BROWSER_MODE'

MODE_OWN = 'own'
MODE_DAILY = 'daily'
MODES = (MODE_OWN, MODE_DAILY)

MODE_LABEL = {
    MODE_OWN: '工作台自己的浏览器',
    MODE_DAILY: '你平时的 Edge',
}


def resolve_mode(raw=None):
    """把任意输入收敛成合法模式；不认识的一律当 own（安全默认）。"""
    v = raw if raw is not None else os.environ.get(MODE_ENV)
    v = (v or '').strip().lower()
    return v if v in MODES else MODE_OWN


def own_user_data_dir(assets_dir):
    """工具自己的 profile（与日常浏览隔离）。"""
    return os.path.join(assets_dir, 'chrome_user_data')


def daily_user_data_dir():
    """用户**日常 Edge** 的 profile 目录。

    用环境变量拼，不写死盘符/用户名。找不到返回空串 —— 调用方必须**明确报出来**，
    不能悄悄退回 own（那就成了"设置没生效但没人知道"）。
    """
    local = os.environ.get('LOCALAPPDATA')
    if not local:
        return ''
    for sub in (('Microsoft', 'Edge', 'User Data'),):
        p = os.path.join(local, *sub)
        if os.path.isdir(p):
            return p
    return ''


def profile_in_use(path):
    """这个 profile 是否正被某个浏览器实例占用。返回 (in_use, detail)。

    判据：Chrome/Edge 运行时会以**独占方式**打开 `<profile>/lockfile`，外部打不开。
    （`SingletonLock` / `SingletonCookie` 在 Windows 上不存在，只有 `lockfile` 可依赖。）

    实测四种情况全部判断正确，**不会误报**：
        日常 Edge profile（在跑）      → 被锁住   ✅
        技能侧 chrome_user_data（空闲）→ 没有锁文件 ✅
        安装目录 chrome_user_data（空闲）→ 没有锁文件 ✅
        不存在的目录（首次使用）        → 目录不存在 ✅

    ⚠️ 不误报是关键：误报的代价是把用户**一直拦在门外**，比不拦更糟。
    """
    if not path or not os.path.isdir(path):
        return False, '目录不存在（首次使用）'
    lock = os.path.join(path, 'lockfile')
    if not os.path.exists(lock):
        return False, '没有 lockfile'
    try:
        with open(lock, 'r+b'):
            pass
        return False, 'lockfile 可独占打开'
    except PermissionError:
        return True, 'lockfile 被锁住'
    except OSError:
        # 其它 IO 错误（只读介质等）→ 保守判为占用。宁可多拦一次，
        # 也不要放行后卡在启动超时上 —— 后者用户完全看不懂。
        return True, '读取 lockfile 失败（保守判为占用）'


def user_data_dir_for(mode, assets_dir):
    """该模式实际要用的 profile 路径。"""
    if mode == MODE_DAILY:
        return daily_user_data_dir()
    return own_user_data_dir(assets_dir)


def check_ready(mode, assets_dir):
    """这个模式现在能不能用。返回 (ok, why, hint)。

    ok=False 时调用方**必须什么都不做**（不开浏览器、不发请求），
    只把 why + hint 原样告诉用户。
    """
    if mode == MODE_OWN:
        # own 也可能被占：上一轮采集/打招呼的浏览器还没退干净，或者并发起了两次。
        # 同一个 profile 开不了两个窗口 —— 提前查一次，给一句能看懂的话，
        # 而不是让 DrissionPage 卡在启动超时上（那正是本轮要消灭的"静默失败"）。
        own = own_user_data_dir(assets_dir)
        in_use, detail = profile_in_use(own)
        if in_use:
            return (False,
                    '工作台自己的浏览器窗口还开着（%s）—— 同一个登录数据不能开两个窗口。' % detail,
                    '把那个 Edge 窗口关掉再试；如果找不到窗口，等几秒让上一轮收尾。')
        return True, '', ''

    daily = daily_user_data_dir()
    if not daily:
        return (False,
                '没找到你日常 Edge 的配置目录（%LOCALAPPDATA%\\Microsoft\\Edge\\User Data）。'
                '可能是这台机器还没用过 Edge，或者 Edge 装在别的地方。',
                '可以在设置里切回「' + MODE_LABEL[MODE_OWN] + '」，那条路不依赖日常 Edge。')

    in_use, detail = profile_in_use(daily)
    if in_use:
        return (False,
                '你平时的 Edge 正在运行（%s）—— 它占着登录数据，这时候另起窗口会失败。' % detail,
                '请**彻底退出 Edge** 再试：不只是关窗口，要到右下角托盘图标上右键退出'
                '（Edge 会常驻后台）。退出后重试即可，**不用重新扫码**。')
    return True, '', ''


def apply_to_options(co, mode, assets_dir, headless=False):
    """把 profile 配置进 ChromiumOptions。返回实际用的路径。

    ⛔ daily 模式**强制非 headless**：用户需要看到窗口（可能要处理验证码、
    也可能想确认"确实用的是我那个浏览器"）。headless 下这个诉求就落空了。
    """
    path = user_data_dir_for(mode, assets_dir)
    if not path:
        raise RuntimeError('拿不到 %s 模式的 profile 路径' % mode)
    os.makedirs(path, exist_ok=True)
    co.set_argument('--user-data-dir=%s' % path)
    if headless and mode != MODE_DAILY:
        co.headless(True)
    return path


def describe(mode):
    """给日志用的一句话说明。"""
    if mode == MODE_DAILY:
        return '你平时的 Edge（零扫码；前提是已彻底退出 Edge）'
    return '工作台自己的浏览器（与日常浏览隔离）'
