#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""采集桥接服务 —— 求职猎手工作台的「本地采集」通道。

为什么需要它
------------
工作台本体是纯前端（file:// 双击即用），而浏览器**不能**自己启动进程、也不能
直接抓 zhipin.com（跨域 + 风控）。所以采集这一步交给这个本地小服务：
它只监听 127.0.0.1，负责按需调起 boss-crawler 的采集脚本，把进度和结果回吐给网页。

它的职责边界（刻意收得很窄）
--------------------------
  ✅ 起一个**真实 Edge 窗口**，让用户自己扫码登录（不代填账号密码）
  ✅ 打开岗位列表页与详情页，**调用页面自身的数据接口**读取列表与详情
     （即浏览器加载页面时本来就会请求的那两个接口，见 boss_crawler/crawler.py）
  ✅ 把采集结果交给工作台，由工作台自己做 AI 解析 / 匹配 / 跟踪
  ⚠️ **风险如实披露**：本工具读取的是页面的数据接口，比手动翻页更密集、
     更容易触发 BOSS 风控（风控特征里，请求密度是敏感项）。工具已做限速、
     随机抖动与分批冷却来降低强度，但**不能保证不触发**。请自行判断是否使用。
  ❌ 不自动发消息、不自动投递（投递永远是用户自己在 BOSS 里点）

接口一览
--------
  GET  /                    工作台本体（同源模式，避开所有跨域问题；会把访问 token 注入进去）
  GET  /api/alive           存活探测（**无需 token、不含任何敏感信息**，给启动脚本判断「是否已在运行」用）
  GET  /api/ping            服务是否在线 + 运行目录/简历/采集参数/登录态
  GET  /api/task?since=N    增量拉取任务输出（只要自第 N 行之后的新行）
  GET  /api/jobs            把采集结果读成岗位数组（三级回退，见 load_jobs）
  POST /api/resume          上传简历（原始字节）→ 解析成 profile.json
  POST /api/extract-text    上传 PDF / Word / txt → **只抽文字**返回（简历素材库用，不起任务、不发给模型）
  POST /api/login           登录检测（会弹出浏览器窗口）
  POST /api/crawl           采集岗位（**开跑前先预检登录态**，过期直接拒绝，不白跑）
  POST /api/match           简历匹配（--from match：quick=纯规则初筛零 token / deep=逐岗 LLM 二筛，产出打分+原因）
  POST /api/match/estimate  简历匹配的成本预估（候选数 / 分钟 / token）
  POST /api/stop            停掉当前任务
  POST /api/results/clear   清空采集结果（归档到 results-archive/，不是删除）

  ⚠️ 除 /api/alive 外，所有 /api/* 都要求 X-JH-Token（见下面「安全」一节）。

为什么用「逐行增量拉」而不是 SSE/WebSocket
------------------------------------------
采集动辄十几分钟，但只要给个行号就能增量拿日志，本地环回上轮询便宜到可以忽略，
而且断线、刷新、重连都天然正确 —— 不需要任何状态恢复逻辑。

关于 stdin 的那个坑（重要，别改）
--------------------------------
子进程的 stdin 必须给「**已关闭的管道**」，不能给 DEVNULL。Windows 上 DEVNULL
打开的是 NUL，而 NUL 是字符设备，`sys.stdin.isatty()` 对它返回 True —— 采集脚本
会因此以为自己正坐在终端前，走进交互分支去 `input()` 等一个永远等不到的回车。
给「已关闭的管道」则 isatty() 为 False，脚本走正确的非交互分支。
（实测：DEVNULL → True，PIPE(closed) → False）
"""

import csv
import glob
import hmac
import json
import math
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import threading
import time
import traceback
import webbrowser
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs, unquote

# ==================== 路径与常量 ====================

HERE = os.path.dirname(os.path.abspath(__file__))            # .../求职猎手工作台/采集器
ROOT = os.path.dirname(HERE)                                 # .../求职猎手工作台（静态根）

DATA_DIR = os.path.join(HERE, 'data')
RESUME_DIR = os.path.join(DATA_DIR, 'resume')
META_PATH = os.path.join(DATA_DIR, 'meta.json')
LOG_PATH = os.path.join(DATA_DIR, 'server.log')

# 运行可视化 / 精确停止用的落盘文件（见 P0-2：启动脚本要给出「成功·失败·端口」可见反馈）
TOKEN_PATH = os.path.join(DATA_DIR, 'token.txt')       # 访问令牌（前端带 X-JH-Token）
PORT_PATH = os.path.join(DATA_DIR, 'collector.port')   # 实际监听端口
PID_PATH = os.path.join(DATA_DIR, 'collector.pid')     # 进程号（停止脚本精确停）
STATUS_PATH = os.path.join(DATA_DIR, 'status.json')    # 启动结果状态文件

# ---- 运行文件的「归属」（评审核实 2026-10-12，P1-3）------------------------
# 以前 port/pid/status 是**最后写入者获胜**：谁启动谁写、谁退出谁删，都不校验归属。
# 两层后果：
#   ① 硬杀（任务管理器 / taskkill）不走 cleanup ⇒ 死进程的 pid/status 留在盘上，
#      启动/停止脚本读到的是一份与现实无关的旧快照（实测 collector.pid 指向的 pid
#      早就不存在，而端口实际由另一个进程监听）；
#   ② 更糟的是**短命实例退出会删掉仍在运行实例的运行文件**（第二个实例起不来就退出，
#      却把正在跑那个实例的 collector.pid / collector.port 一并抹掉）。
# 修法：每个实例带一个随机 ID 写进 status.json；删除前先确认这些文件还是自己写的。
INSTANCE_ID = secrets.token_hex(8)

# ---- 「一键打招呼」的服务端配置与台账（评审核实 2026-10-12，P1-5）-----------
# 为什么服务端要自己存一份：那套开关/间隔/冷却本来只活在浏览器 localStorage 里，
# 服务端**读不到** ⇒ _greet_gate 的 docstring 承诺「必须自己再查一次开关」是空话，
# 服务端从来没查过（autoGreet 等字段在 server.py 全文件 0 命中）。
# 现在由前端在启动 / 改设置时把配置同步过来落盘，服务端据此强制限流。
GREET_CONF_PATH = os.path.join(DATA_DIR, 'greet_conf.json')
GREET_LOG_PATH = os.path.join(DATA_DIR, 'greet_log.json')   # 服务端自己记的打招呼台账
STOP_GRACE_SEC = 8.0        # stop 之后最多等这么久，超时就强制把任务落地（见 _stop_watchdog）

# boss-crawler 技能 —— 采集逻辑全在它那儿，这边一行都不重复实现
#
# ⛔ 路径不能写死本机绝对路径（会泄漏作者 Windows 用户名，别人 clone 也跑不了）。
#   解析顺序：① 环境变量 JH_SKILL_DIR  ② 便携版 exe 旁边
#            ③ 仓库内 _打包工程/crawler_src  ④ 用户家目录下的 skill 目录
def _find_skill_dir():
    env = os.environ.get('JH_SKILL_DIR')
    if env and os.path.isdir(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(here)
    cands = [
        os.path.join(parent, '采集组件', 'crawler_src'),      # 便携版布局
        os.path.join(parent, 'crawler_src'),
        os.path.join(os.path.dirname(parent), '_打包工程', 'crawler_src'),  # 源码模式
        os.path.join(parent, '..', '_打包工程', 'crawler_src'),
    ]
    home = os.environ.get('USERPROFILE') or os.environ.get('HOME') or ''
    if home:
        cands.append(os.path.join(home, '.workbuddy', 'skills', 'boss-crawler'))
    for c in cands:
        c = os.path.normpath(c)
        if os.path.isdir(os.path.join(c, 'scripts')):
            return c
    return ''


SKILL_DIR = _find_skill_dir()
# ⚠️ 找不到时下面这些会是空串 —— 采集接口会明确报「采集组件未安装」，
#    而不是拿一个错路径去执行（那样报错信息很难懂）。
ASSETS_DIR = os.path.join(SKILL_DIR, 'assets') if SKILL_DIR else ''
SCRIPTS = os.path.join(SKILL_DIR, 'scripts') if SKILL_DIR else ''
PIPELINE = os.path.join(SCRIPTS, 'pipeline.py') if SCRIPTS else ''

# 专用 venv。**别换成系统 Python** —— boss-crawler 要 requests 2.34 / lxml 6，
# 和默认环境里 2020 年那套（requests 2.25）冲突。
#
# ⛔ 同样不写死。解析顺序：① JH_PYTHON  ② 用户家目录下的 boss-crawler venv
#                        ③ 仓库内 .venv  ④ 交给 PATH 的 python
def _find_python():
    env = os.environ.get('JH_PYTHON')
    if env and os.path.exists(env):
        return env
    here = os.path.dirname(os.path.abspath(__file__))
    parent = os.path.dirname(here)
    home = os.environ.get('USERPROFILE') or os.environ.get('HOME') or ''
    cands = []
    if home:
        base = os.path.join(home, '.workbuddy', 'binaries', 'python', 'envs', 'boss-crawler')
        cands.append(os.path.join(base, 'Scripts', 'python.exe'))
        cands.append(os.path.join(base, 'bin', 'python'))
    cands.append(os.path.join(os.path.dirname(parent), '_打包工程', '.venv', 'Scripts', 'python.exe'))
    cands.append(os.path.join(parent, '.venv', 'Scripts', 'python.exe'))
    for c in cands:
        if c and os.path.exists(c):
            return c
    return 'python'      # 兜底：交给 PATH


PY = _find_python()

# —— 去 BOSS 投递链路（第 19 轮）——
# 这两个脚本是**真实对外动作**（一个会发消息、一个会读用户的私人消息），
# 所以都放在 skill 的 stages/ 下，跟采集用同一套登录态与浏览器。
APPLY_ONE_SCRIPT = os.path.join(SCRIPTS, 'stages', 'boss_apply_one.py')
CHAT_SYNC_SCRIPT = os.path.join(SCRIPTS, 'stages', 'boss_chat_sync.py')
# 打招呼最长等多久（秒）。auto_apply 内部等扫码最多 300 秒，这里必须比它大，
# 否则用户正在扫码、我们却先把请求超时了 —— 表现成"点了没反应但浏览器在动"。
APPLY_WAIT_SEC = 420

EDGE_CANDIDATES = [
    r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe',
    r'C:\Program Files\Microsoft\Edge\Application\msedge.exe',
]

# 旧工作台（求职/工作台）占了 8737，这边从 8738 起，冲突了自动往后挪。
PORT_CANDIDATES = [8738, 8739, 8740]

VERSION = '1.0.0'

# ---------------------------------------------------------------------------
# 安全：访问令牌 + Origin 白名单（P0-1）
# ---------------------------------------------------------------------------
# 为什么不能只靠「只监听 127.0.0.1」
#   服务确实只绑 127.0.0.1，本机之外的人够不着；但**攻击面不是网络，是浏览器**——
#   用户浏览器里随便打开的任意网页，都能对 http://127.0.0.1:8738 发请求。
#   原来的 CORS 是 `Access-Control-Allow-Origin: *`，等于把这些接口向任意网页敞开：
#   读 /api/ping（姓名/学历/期望薪资）、读 /api/jobs（全部岗位含 HR）、
#   触发 /api/crawl、往磁盘写 /api/resume。
#
# 两道闸：
#   ① Origin 白名单 —— 请求带了 Origin 头（跨源请求浏览器必带）时，必须命中白名单，
#      否则直接 403。同源请求 / curl 这类非浏览器调用不带 Origin，放行。
#   ② 随机 token —— 进程启动时生成，落到 data/token.txt，并**注入到本服务 serve 的
#      index.html**；所有 /api/* 都要带 X-JH-Token。攻击者能构造 Origin，但拿不到 token。
#      所以采集功能必须从「采集器打开的页面」用（file:// 打开的页面拿不到 token，
#      前端会给出明确引导，而不是静默失败）。
TOKEN = secrets.token_urlsafe(32)
START_TIME = time.time()
CURRENT_PORT = None                      # main() 里赋值；token 提示文案要用它
ROOT_PID = None                          # main() 里赋值：所在 python 进程树的根（见 root_pid）

# ⛔ 白名单里**绝不能**出现 'null'（评审核实 2026-10-12，P0，已实测复现）。
#   `Origin: null` 是所有「不透明来源」文档的统称 —— 沙箱 iframe
#   （`<iframe sandbox="allow-scripts" srcdoc="…">`）、`file://` 页面、`data:` 文档全发这个。
#   把它放进白名单，等于任何网页都能**读到**本服务 serve 的 HTML，
#   而那份 HTML 里正带着令牌（见 inject_token）⇒ 令牌被掏走，
#   随后可带 X-JH-Token 调**全部** /api/*（含 /api/apply-one —— 会真实给 BOSS 发消息）。
#   设计前提本来就是「file:// 拿不到令牌，前端给明确引导」（见上面 ②），
#   所以删掉 'null' 是**关闭攻击面**，不是砍功能。
ALLOWED_ORIGINS = set(['http://127.0.0.1:%d' % p for p in PORT_CANDIDATES])

# 登录态多久算「新鲜」。超过这个时间就认为可能已失效，采集前要求重测一次，
# 免得白跑十几分钟才发现扫码过期（server.log 实证：10 次采集 3 次手动中断）。
#
# 为什么是 6 小时（原为 45 分钟）：BOSS 的登录 cookie 实际有效期以「天」计，
# 45 分钟远短于真实有效期，导致用户每 45 分钟就被拦一次去重新扫码 ——
# 而「扫码」正是整条链上摩擦最高的一步（10 次采集 5 次扫码）。
# 另一个更可靠的信号见 note_crawl_success()：采集**成功**本身就是登录有效的证明，
# 比任何探测都硬。这里放宽 TTL 只是减少无谓拦截，不是放松校验。
LOGIN_TTL = 6 * 60 * 60

# 静态文件白名单 —— 只伺服工作台自己的东西，不做通用文件服务器。
STATIC_EXT = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.ico': 'image/x-icon',
}

# 请求体上限。简历上传单独用 20MB（见 _upload_resume），其余接口 8MB 足够。
MAX_BODY_BYTES = 8 * 1024 * 1024

# ⛔ 静态服务**只放行工作台本体**，不放行数据与文档（评审核实 2026-10-30，P0）。
#   以前 STATIC_EXT 含 .json / .md，而 _guard() 只保护 /api/*，静态路径完全不鉴权
#   ⇒ 任何网页（乃至 curl）都能匿名 GET 走：
#       采集结果_2026-09-25.json（32KB 全量岗位，含公司/薪资/JD）
#       采集器/data/meta.json（登录态）
#       使用说明.md / 体检报告修复清单.md / .impeccable.md
#   现在改为「根目录只放行这些文件」+「js/css 这些目录」的双重白名单：
#   数据目录(mutbak/__pycache__/data)与所有 *.md/*.json 一律不伺服。
STATIC_FILES = {'index.html', 'favicon.ico'}
STATIC_DIRS = {'js', 'css'}

for _d in (DATA_DIR, RESUME_DIR):
    os.makedirs(_d, exist_ok=True)


# ==================== 小工具 ====================

def read_json(path, default=None):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def write_json(path, data):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def log(msg):
    """服务端自己的日志，写到 data/server.log，别混进任务输出里。"""
    try:
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write('[%s] %s\n' % (time.strftime('%Y-%m-%d %H:%M:%S'), msg))
    except OSError:
        pass


def run_dir():
    """assets/LATEST.txt 指向的那个运行目录（绝对路径）；没有就 None。"""
    try:
        with open(os.path.join(ASSETS_DIR, 'LATEST.txt'), 'r', encoding='utf-8') as f:
            name = f.read().strip()
    except OSError:
        return None
    if not name:
        return None
    path = os.path.join(ASSETS_DIR, name)
    return path if os.path.isdir(path) else None


def new_run_dir():
    """新建一个带时间戳的运行目录，并把它写成 LATEST.txt。

    为什么在这里自己建、而不是靠 pipeline 的 create_run_dir：
    采集走的是 `--from infer --to crawl`，不经过 parse 阶段，pipeline 永远
    不会触发 create_run_dir（它只在 parse 阶段新建）；而采集器若不主动建，
    pipeline 就会顺着 LATEST.txt 复用上一轮的旧目录，导致每次采集都覆盖到
    同一处、结果不更新。这里复刻 create_run_dir 的目录结构与 LATEST 指针，
    让每次「开始采集」都落到一个全新目录（用户选的是「每次全新开始」）。

    ⛔ 失败必须**抛出来**（评审复核时补的）：
       以前 `makedirs` 没有 try（磁盘满/无权限直接抛，还好），但写 LATEST.txt 是
       `except OSError: pass` —— **指针写不进去也不吭声**。
       而调用方 `_crawl` 从来不检查返回值。两者的后果叠加起来是：
       新目录没建成 / 指针没更新 → 采集**静默退化成往上一轮的旧目录里写**，
       表现就是「这轮跑完了，但结果看不见」。用户 C 盘本来就紧（可用 3.7GB），
       磁盘压力 + 静默失败 + 无校验，这三样凑一起是会真出事的。

       所以：建目录失败 → 抛；LATEST 指针写失败 → 抛。
       让 _crawl 拿到一个明确的失败，而不是一个「看起来成功了」的空壳。
    """
    name = time.strftime('%Y-%m-%d_%H-%M-%S')
    rd = os.path.join(ASSETS_DIR, name)

    # 先记住上一轮目录（更新 LATEST 之前取，否则会取到新目录自己）
    prev = run_dir()

    for sub in ('state', 'materials', 'deliver', 'intermediate'):
        os.makedirs(os.path.join(rd, sub), exist_ok=True)   # 失败就抛，别吞

    with open(os.path.join(ASSETS_DIR, 'LATEST.txt'), 'w', encoding='utf-8') as f:
        f.write(name)                                        # 失败就抛，别吞

    # 简历画像是「采集的输入」，不是「采集结果」——把它从上一轮复制过来，
    # 否则 infer 阶段在新目录里找不到 profile.json 会直接失败。
    # 这三个文件是 parse 阶段产出的、跨采集轮次复用是合理的。
    # 复制失败**不抛**：它只是「更好」，缺失时 infer 会用自己的兜底路径报错，
    # 不至于把整轮采集挡在门外。
    if prev and os.path.abspath(prev) != os.path.abspath(rd):
        for fn in ('profile.json', 'profile_validation.json', 'resume_text.txt'):
            src = os.path.join(prev, 'state', fn)
            dst = os.path.join(rd, 'state', fn)
            if os.path.isfile(src):
                try:
                    shutil.copyfile(src, dst)
                except OSError:
                    pass
    return rd


def state_path(rd, *parts):
    """运行目录里的四个桶之一。与 skill 的 resume_matcher/paths.py 保持一致。"""
    return os.path.join(rd, 'state', *parts)


def subprocess_env(extra=None):
    env = dict(os.environ)
    # 少了这两个，子进程里的中文进度会把管道带崩（GBK 编码错误）
    env['PYTHONIOENCODING'] = 'utf-8'
    env['PYTHONUTF8'] = '1'
    # 本机只有 Edge 没有 Chrome，显式指路，省得 DrissionPage 自己找不到浏览器
    if not env.get('CHROME_PATH'):
        for cand in EDGE_CANDIDATES:
            if os.path.exists(cand):
                env['CHROME_PATH'] = cand
                break
    # 调用方要额外注入的（目前只有「投递看板用哪个浏览器」）
    if extra:
        env.update(extra)
    return env


# 「投递看板用哪个浏览器」—— 设置存在前端的 localStorage 里，服务端读不到，
# 所以由前端在请求体里带上，这里再注入给子进程。
# 值不合法就**不注入**（子进程按自己默认的 own 走），不猜、不硬塞。
BROWSER_MODES = ('own', 'daily')


def browser_mode_env(payload):
    v = (payload or {}).get('browserMode')
    return {'JH_BOSS_BROWSER_MODE': v} if v in BROWSER_MODES else None


def skill_ready():
    return os.path.exists(PY) and os.path.exists(PIPELINE)


# ==================== 静态词典预检与自愈 ====================
#
# boss-crawler 每次跑都会先读两份 BOSS 公开词典：
#
#   assets/post_data.json   岗位分类树 —— custom 模式其实不读它的内容，
#                           只在开头做一次「非空」校验（positions 是直接合成的）
#   assets/weizhi.json      城市名 → BOSS 城市 code —— **这个是真要用的**
#                           （杭州 = 101210100）
#
# 两份都缺时，boss-crawler 会自己开浏览器去抓，但那条路径会被风控挡下
# （返回的不是 JSON），于是打印「岗位数据加载失败，请先运行 --update-data」，
# 采集一步都走不了。而这两个 wapi 直连 HTTP 是好的（343KB / 64KB），
# 所以在这里做预检：缺了就直接补齐。
#
# 注意：这不是「绕过接口」—— 拉的是 BOSS 自己的公开数据字典（岗位分类 / 城市列表），
# 不含任何账号态、不取岗位数据。工具本身也是这么设计的，只是它的抓取路径不稳。

DICT_SOURCES = (
    # (文件名, 接口地址, 用来确认结构对不对的 zpData 键)
    ('post_data.json',
     'https://www.zhipin.com/wapi/zpCommon/data/getCityShowPosition', 'position'),
    ('weizhi.json',
     'https://www.zhipin.com/wapi/zpgeek/common/data/city/site.json', 'siteGroup'),
)

_UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
       '(KHTML, like Gecko) Chrome/120.0 Safari/537.36')

_DICT_CACHE = {'states': None}


def dict_state(refresh=False):
    """两份词典各自的状态：'ok' / 'missing' / 'broken'。

    结果缓存 —— ping 是高频接口，而这两份合起来 400KB，没必要每次重解析。
    文件出问题只可能发生在采集启动前（ensure_dicts 会 refresh），所以缓存是安全的。
    """
    if _DICT_CACHE['states'] is not None and not refresh:
        return _DICT_CACHE['states']
    out = {}
    for name, _url, key in DICT_SOURCES:
        data = read_json(os.path.join(ASSETS_DIR, name))
        if not isinstance(data, dict):
            out[name] = 'missing'
        elif not isinstance((data.get('zpData') or {}).get(key), list) \
                or not (data.get('zpData') or {}).get(key):
            out[name] = 'broken'
        else:
            out[name] = 'ok'
    _DICT_CACHE['states'] = out
    return out


def dict_ready():
    return all(v == 'ok' for v in dict_state().values())


def fetch_dict(name, url, key):
    """直连拉一份词典并原子落盘。返回 (ok, 说明)。"""
    req = urllib.request.Request(url, headers={
        'User-Agent': _UA,
        'Referer': 'https://www.zhipin.com/',
        'Accept': 'application/json,text/plain,*/*',
    })
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read()
    data = json.loads(raw.decode('utf-8'))
    if not isinstance((data.get('zpData') or {}).get(key), list) \
            or not (data.get('zpData') or {}).get(key):
        return False, '返回结构和预期不符（缺 zpData.%s）' % key
    path = os.path.join(ASSETS_DIR, name)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return True, '%d 字节' % len(raw)


def ensure_dicts(force=False):
    """缺哪份补哪份。返回 (是否可用, 明细列表)。"""
    states = dict_state(refresh=True)
    detail = []
    for name, url, key in DICT_SOURCES:
        if not force and states.get(name) == 'ok':
            continue
        try:
            ok, msg = fetch_dict(name, url, key)
        except Exception as exc:                               # noqa: BLE001
            ok, msg = False, '%s: %s' % (type(exc).__name__, exc)
        detail.append('%s %s（%s）' % (name, '已补齐' if ok else '补齐失败', msg))
        log('dict %s -> %s' % (name, 'ok' if ok else 'fail: %s' % msg))
    return dict_ready(), detail


# ==================== 任务运行器 ====================

class Task(object):
    """一个正在跑（或刚跑完）的采集阶段。

    输出按行累积，前端用 since=<已读行数> 增量拉。
    """

    def __init__(self, key, title, cmd):
        self.key = key
        self.title = title
        self.cmd = cmd
        self.lines = []
        self.running = True
        self.paused = False              # 是否已被挂起（「一键冻结」，见 pause_task）
        self.exit_code = None
        self.started_at = time.time()
        self.ended_at = None
        self.proc = None
        self._lock = threading.Lock()

    def append(self, text):
        with self._lock:
            self.lines.append(text)

    def snapshot(self, since=0):
        with self._lock:
            total = len(self.lines)
            chunk = self.lines[max(0, since):]
        return {
            'key': self.key,
            'title': self.title,
            'running': self.running,
            'paused': self.paused,
            'exit_code': self.exit_code,
            'started_at': self.started_at,
            'ended_at': self.ended_at,
            'total': total,
            'lines': chunk,
        }

    def cmdline(self):
        return ' '.join('"%s"' % c if ' ' in c else c for c in self.cmd)


CURRENT = None
CURRENT_LOCK = threading.Lock()

# 登录态缓存：省得每步都开一次浏览器。持久化到 data/meta.json。
LOGIN_STATE = {'value': None, 'checked_at': None}


def meta_load():
    m = read_json(META_PATH, {}) or {}
    LOGIN_STATE['value'] = m.get('login_state')
    LOGIN_STATE['checked_at'] = m.get('login_checked_at')
    return m


def meta_save(patch):
    m = read_json(META_PATH, {}) or {}
    m.update(patch)
    write_json(META_PATH, m)


def _close_stdin(proc):
    """见文件头「关于 stdin 的那个坑」。别改成 DEVNULL。"""
    try:
        if proc.stdin:
            proc.stdin.close()
    except OSError:
        pass


def _pump(task, proc):
    """把子进程 stdout 逐行搬到 task.lines，直到进程结束。

    同时把完整输出**落盘**到 data/task-<key>-<时间戳>.log（评审 P1-3.6）：以前
    输出只存在内存 task.lines 里，服务一重启、或采集跑完想复盘「为什么跑了 52 分钟 /
    详情爬了多少 / 失败在哪」，唯一需要的 stdout（第 N 页、写入 X 条、详情爬取完成）
    全丢了。落盘后能事后复盘，也支撑「最近 24 小时跑了几轮」这类频次统计。
    """
    log_path = os.path.join(DATA_DIR, 'task-%s-%s.log' % (
        task.key, time.strftime('%Y%m%d_%H%M%S', time.localtime(task.started_at))))
    log_file = None
    # ⛔ 输出熔断：异常刷屏（浏览器断开后 crawler 空转等）会**同时**撑爆内存里的
    # task.lines 和磁盘上的落盘日志，还会把前端 poll 拖死 —— 实测 1 分钟刷到 424MB。
    # 所以窗口内行数超阈值就自动挂起任务（等同于用户点「暂停」），把灾难堵在源头。
    # 正常采集一秒最多几行，阈值取 20000 行/20 秒 = 1000 行/秒，远高于正常。
    RATE_WINDOW = 20.0
    RATE_MAX_LINES = 20000
    win_start = time.time()
    win_lines = 0
    try:
        log_file = open(log_path, 'w', encoding='utf-8')
        for raw in proc.stdout:
            line = raw.rstrip('\r\n')
            task.append(line)
            if log_file is not None:
                try:
                    log_file.write(line + '\n')
                except OSError:
                    pass
            win_lines += 1
            now = time.time()
            if now - win_start > RATE_WINDOW:
                win_start, win_lines = now, 1          # 窗口滚动，重新计数
            elif win_lines >= RATE_MAX_LINES and not task.paused:
                # 触发熔断。先记下真实行数再重置窗口 —— 否则用户点「继续」后
                # 计数还停在阈值上，会立刻又被熔断一次。
                n_lines = win_lines
                win_start, win_lines = now, 0
                okn, tot = _suspend_tree(proc.pid, True)
                task.paused = True
                task.append('[采集器] ⚠️ 采集输出异常暴涨（%d 行 / %.0f 秒），疑似已失控刷屏。'
                            % (n_lines, RATE_WINDOW))
                task.append('[采集器] ⚠️ 已自动暂停以保护内存与磁盘 —— 请检查浏览器是否被关闭、'
                            '或页面是否已失效；确认后点「继续」，或点「停止」结束。')
                log('auto-pause task %s: runaway output %d lines, %d/%d suspended'
                    % (task.key, n_lines, okn, tot))
            # ⛔ 熔断后**不能 break**：一 break 就会走到 proc.wait()/finally，
            # 把任务标记成「已结束」，而进程其实只被挂起、还活着。保持阻塞读取
            # （进程已冻结，不会再有输出，不消耗 CPU），等用户「继续」或「停止」。
        proc.wait()
    except Exception:                                          # noqa: BLE001
        task.append('[采集器] 读取输出出错: %s' % traceback.format_exc(limit=1))
    finally:
        if log_file is not None:
            try:
                log_file.flush()
                log_file.close()
            except OSError:
                pass
        with CURRENT_LOCK:
            task.running = False
            task.exit_code = proc.returncode
            task.ended_at = time.time()
            task.proc = None
        # 登录任务的结论解析成可查询状态，前端据此点亮「已登录」灯
        if task.key == 'login':
            joined = '\n'.join(task.lines)
            if '[LOGIN_OK]' in joined:
                LOGIN_STATE['value'] = 'ok'
            elif '[LOGIN_NEEDED]' in joined or '[LOGIN_FAIL]' in joined:
                LOGIN_STATE['value'] = 'needed'
            LOGIN_STATE['checked_at'] = time.time()
            meta_save({'login_state': LOGIN_STATE['value'],
                       'login_checked_at': LOGIN_STATE['checked_at']})
        elif task.key == 'crawl':
            # 采集**成功结束**（exit 0）= 登录态确实有效 —— 这是比任何探测都硬的
            # 证据（它真的翻完了页面）。据此刷新登录态时间戳，用户不必因为 TTL
            # 到点就重新扫码。失败结束（非 0）不动，避免把失效的登录态刷成新鲜。
            if task.exit_code == 0 and LOGIN_STATE.get('value') != 'needed':
                LOGIN_STATE['value'] = 'ok'
                LOGIN_STATE['checked_at'] = time.time()
                meta_save({'login_state': LOGIN_STATE['value'],
                           'login_checked_at': LOGIN_STATE['checked_at']})


def start_task(key, title, cmd, env_extra=None):
    """起一个后台任务。已有任务在跑就返回说明（不抛异常）。

    env_extra：额外注入的环境变量（见 browser_mode_env）。默认 None = 什么都不加。
    """
    global CURRENT
    with CURRENT_LOCK:
        if CURRENT is not None and CURRENT.running:
            return {'ok': False,
                    'error': '已有任务在跑（%s），等它结束或先点「停止」。' % CURRENT.title}
        try:
            proc = subprocess.Popen(
                cmd, cwd=SCRIPTS, env=subprocess_env(env_extra),
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                text=True, encoding='utf-8', errors='replace', bufsize=1,
            )
        except OSError as exc:
            return {'ok': False, 'error': '起不了进程：%s' % exc}
        _close_stdin(proc)
        task = Task(key, title, cmd)
        task.proc = proc
        CURRENT = task
    task.append('$ %s' % task.cmdline())
    task.append('')
    threading.Thread(target=_pump, args=(task, proc), daemon=True).start()
    log('start task %s: %s' % (key, task.cmdline()))
    return {'ok': True, 'key': key}


def _stop_watchdog(task, proc):
    """stop 之后的兜底：把「没杀掉」和「杀掉了但管道没关」两种情况都收干净。

    ⛔ 为什么必须有这个（评审核实 2026-10-12，P1-4）：
      `_pump` 靠 `for raw in proc.stdout` 读到 **EOF** 才置 `running = False`。
      只要**任一子孙进程**（Edge 的子进程、被 reparent 的孤儿 python）还握着管道写端，
      这个循环就永不返回 ⇒ 任务永远「在跑」⇒ /api/crawl、/api/resume、/api/apply-one
      全部以「已有任务在跑」拒绝，而 CURRENT 是模块级单例 ⇒ 用户只能重启采集器。
      而原来的 stop_task 只 `subprocess.run(taskkill …)`，**连返回码都不看**。
    """
    deadline = time.time() + STOP_GRACE_SEC
    while time.time() < deadline:
        if not task.running:
            return
        time.sleep(0.3)
    # 还没落地 → 再补一刀（进程可能已是孤儿），然后从**我们这端**关掉读管道，
    # 让卡在 readline 的 _pump 立刻抛错退出，而不是永远等一个不会来的 EOF。
    try:
        if proc.poll() is None:
            proc.kill()
    except Exception:                                          # noqa: BLE001
        pass
    try:
        if proc.stdout:
            proc.stdout.close()
    except Exception:                                          # noqa: BLE001
        pass
    forced = False
    with CURRENT_LOCK:
        if task.running:
            task.running = False
            if task.exit_code is None:
                task.exit_code = -1        # ⛔ 用 -1 而不是 0：0 会被读成「采集成功」
            task.ended_at = time.time()
            task.proc = None
            forced = True
    if forced:
        task.append('[采集器] ⚠️ 已停止，但它的输出管道一直没关闭（多半有孤儿子进程还握着它）。'
                    '已强制把任务标记为结束 —— 现在可以重新开始采集了。')
        log('stop watchdog forced finish: %s' % task.key)


def stop_task():
    with CURRENT_LOCK:
        task = CURRENT
        if task is None or not task.running or task.proc is None:
            return {'ok': False, 'error': '当前没有在跑的任务。'}
        proc = task.proc
        was_paused = task.paused
    if was_paused:
        # 挂起态的进程 taskkill /F 也能杀，但先解冻更干净 —— 否则可能留下一堆
        # 冻住的孤儿 Edge 进程占着内存/端口，用户以为「停了」却还挂着一片。
        _suspend_tree(proc.pid, False)
        task.paused = False
    # ⛔ 必须看返回码（评审 P1-4）：以前 `capture_output=True` 把结果整个丢掉，
    #    于是杀失败也照样报「已请求停止」，任务则永远停在 running。
    rc = None
    try:
        r = subprocess.run(['taskkill', '/F', '/T', '/PID', str(proc.pid)],
                           capture_output=True, text=True,
                           encoding='utf-8', errors='replace')
        rc = r.returncode
        log('taskkill pid=%d rc=%s out=%s'
            % (proc.pid, rc, ((r.stdout or '') + (r.stderr or '')).strip()[:200]))
    except Exception as exc:                                   # noqa: BLE001
        log('taskkill 起不来（%s），退回 proc.kill()' % exc)
        try:
            proc.kill()
        except Exception:                                      # noqa: BLE001
            pass
    task.append('[采集器] 已请求停止…' if rc in (None, 0)
                else '[采集器] 已请求停止…（taskkill 返回码 %s，正在兜底处理）' % rc)
    log('stop task %s' % task.key)
    # 不管 taskkill 成不成，都挂看门狗 —— 由它保证「任务状态一定落地」，
    # 而不是把状态托付给一个可能永远不来的 EOF。
    threading.Thread(target=_stop_watchdog, args=(task, proc), daemon=True).start()
    return {'ok': True}


# ==================== 各阶段命令 ====================

def build_cmd_parse(resume_path, force=False):
    cmd = [PY, PIPELINE, resume_path, '--to', 'parse']
    if force:
        cmd.append('--force')
    return cmd


def build_cmd_login():
    return [PY, os.path.join(SCRIPTS, 'stages', 'boss_post_interactive.py'),
            '--ensure-login']


# ==================== 「只抽文字」的简历上传（简历素材库用） ====================

# 允许抽取的扩展名。⛔ 与 stages/extract_resume_text.py 的 OK_EXTS 保持一致 ——
# 这里是**落盘前的白名单**，防止把任意字节写成任意扩展名（比如 .exe）落在数据目录里。
EXTRACT_EXTS = ('.pdf', '.docx', '.doc', '.txt', '.md', '.markdown')


def build_cmd_extract(path):
    """抽取简历文字的命令（只抽文字，不发给大模型）。"""
    return [PY, os.path.join(SCRIPTS, 'stages', 'extract_resume_text.py'), path]


def extract_text(raw, name):
    """把上传的字节抽成纯文本。

    **不起任务、不落库、不发给大模型** —— 素材库只是想要这段文字，
    既不烧模型额度，也不该要求用户先配好 API Key。
    （和「上传简历并解析」是两件事：那个会产出 profile.json 画像，必须联网调模型。）
    """
    ext = os.path.splitext(name or '')[1].lower()
    if ext not in EXTRACT_EXTS:
        return {'ok': False, 'error': '不支持的文件格式 %s（支持 PDF / Word(.docx) / txt / md）'
                                      % (ext or '（无扩展名）')}

    tmpdir = os.path.join(DATA_DIR, 'text-tmp')
    try:
        os.makedirs(tmpdir, exist_ok=True)
    except OSError as e:                                       # noqa: BLE001
        return {'ok': False, 'error': '建不了临时目录：%s' % e}

    tmp = os.path.join(tmpdir, '%s%s' % (secrets.token_hex(6), ext))
    try:
        with open(tmp, 'wb') as f:
            f.write(raw)
    except OSError as e:                                       # noqa: BLE001
        return {'ok': False, 'error': '写临时文件失败：%s' % e}

    try:
        proc = subprocess.run(build_cmd_extract(tmp), cwd=SCRIPTS,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=90)
        out = (proc.stdout or b'').decode('utf-8', 'replace')
        err = (proc.stderr or b'').decode('utf-8', 'replace')
        # 只认带前缀的那一行 —— 抽取脚本前面会打正常的解析日志（「正在解析…」）
        payload = None
        for line in out.splitlines():
            if line.startswith('__JH_TEXT__'):
                try:
                    payload = json.loads(line[len('__JH_TEXT__'):])
                except ValueError:
                    payload = None
        if payload is None:
            tail = (out[-300:] + '\n' + err[-300:]).strip()
            return {'ok': False,
                    'error': '抽取没返回结果（退出码 %s）。%s' % (proc.returncode, tail)}
        return payload
    except subprocess.TimeoutExpired:
        return {'ok': False, 'error': '抽取超时（文件太大或卡住了）。'}
    except Exception as e:                                     # noqa: BLE001
        return {'ok': False, 'error': '抽取失败：%s' % e}
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


# ==================== task-*.log 保留策略 ====================
# 事故背景（评审 3.1）：一次「浏览器断连 + 翻页无限重试」把
# data/task-crawl-*.log 刷到了 **404.7 MB / 1962 万行**，而当时**没有任何代码负责清理它**
# —— clear_results() 只搬岗位数据、list_history() 也不扫这些日志，
# 只能靠用户自己去 data/ 里手删。根因（滚动失败封顶）已修，但日志本身不能无限涨：
# 用户的 C 盘本来就紧（可用 3.7GB），一份日志就能吃掉 400MB。
TASK_LOG_KEEP = 8                 # 最多保留最近几份任务日志
TASK_LOG_MAX_BYTES = 8 * 1024 * 1024   # 单份超过 8MB 就认为「这轮失控过」，直接截尾


def _trim_task_log(path, max_bytes=TASK_LOG_MAX_BYTES):
    """单份日志超过上限 → 只留**尾部**（尾部才是失败现场），头部丢掉并留一行说明。

    为什么留尾不留头：这类日志的价值全在「最后发生了什么」，
    开头的启动横幅和参数回显在别处也有（server.log、run 目录）。
    """
    try:
        size = os.path.getsize(path)
    except OSError:
        return False
    if size <= max_bytes:
        return False
    keep = max_bytes // 2                     # 尾部保留一半，给头部留出说明行
    try:
        with open(path, 'rb') as f:
            f.seek(-keep, os.SEEK_END)
            f.readline()                      # 丢掉可能被截断的那半行
            tail = f.read()
        with open(path, 'wb') as f:
            f.write(('[采集器] 这份日志超过 %dMB，已自动截断，只保留最后 %dKB —— '
                     '完整现场请直接看它被截断前的副本或 server.log。\n\n'
                     % (max_bytes // 1024 // 1024, keep // 1024)).encode('utf-8'))
            f.write(tail)
        log('task log trimmed: %s (%d -> %d bytes)' % (path, size, os.path.getsize(path)))
        return True
    except OSError as exc:
        log('task log trim failed: %s (%s)' % (path, exc))
        return False


def prune_task_logs():
    """启动时清一遍任务日志：先截超大份，再只留最近 TASK_LOG_KEEP 份。

    ⚠️ 删除**批量日志**这件事只在 `data/` 这个明确目录里做，而且只认
    `task-*.log` 这个自己写出来的命名 —— 不做递归、不做通配扩展。
    """
    try:
        names = [n for n in os.listdir(DATA_DIR)
                 if n.startswith('task-') and n.endswith('.log')]
    except OSError:
        return {'trimmed': 0, 'removed': 0}
    paths = []
    for n in names:
        p = os.path.join(DATA_DIR, n)
        if os.path.isfile(p):
            paths.append(p)
    trimmed = sum(1 for p in paths if _trim_task_log(p))

    # 按修改时间排序，留最近的 N 份，其余删掉（这些是我们自己的运行产物，不是用户数据）
    paths.sort(key=lambda p: os.path.getmtime(p), reverse=True)
    removed = 0
    for p in paths[TASK_LOG_KEEP:]:
        try:
            os.remove(p)
            removed += 1
        except OSError:
            pass
    if trimmed or removed:
        log('task logs pruned: trimmed=%d removed=%d' % (trimmed, removed))
    return {'trimmed': trimmed, 'removed': removed}


# ==================== 去 BOSS 投递：命令 + 闸门 ====================

BOSS_JOB_URL_RE = re.compile(r'^https?://(?:www\.)?zhipin\.com/job_detail/[A-Za-z0-9_~-]+')


def _num_or(v, default):
    """只要「真数字」，不要 bool / 字符串 —— 别让 '0' 或 True 混进限流参数。"""
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return default
    return v


def greet_conf():
    """读服务端这份「一键打招呼」配置。没同步过返回 None（≠ 关着）。"""
    c = read_json(GREET_CONF_PATH, None)
    return c if isinstance(c, dict) else None


def greet_log():
    """服务端自己记的打招呼台账：[{at, jobId, url}, …]（最近 500 条）。"""
    e = read_json(GREET_LOG_PATH, None)
    return e if isinstance(e, list) else []


def greet_record(job_id, url):
    """记一笔**真的发出去了**的招呼。

    ⛔ 为什么台账必须由服务端记（评审 P1-5）：前端那些计时器（boss.lastGreetAt /
       岗位 greetAt）都在 localStorage 里，一个伪造请求就能把它们全绕过去。
       限流要算数，计数就必须长在服务端。
    """
    entries = greet_log()
    entries.append({'at': time.time(), 'jobId': job_id or '', 'url': url or ''})
    entries = entries[-500:]          # 单日上限顶多几十条，500 条足够覆盖冷却窗口
    try:
        write_json(GREET_LOG_PATH, entries)
    except OSError as exc:
        log('写打招呼台账失败: %s' % exc)
    return entries[-1]['at']


def _greet_rate_gate(payload):
    """限流闸门：最小间隔 / 同岗位冷却 / 单日上限。返回 (ok, why)。

    参数全部取自**服务端落盘的配置**（greet_conf.json），缺项用保守默认值。
    """
    conf = greet_conf() or {}
    interval = _num_or(conf.get('intervalSec'), 20)
    cooldown_h = _num_or(conf.get('cooldownH'), 24)
    daily_cap = int(_num_or(conf.get('dailyCap'), 20))

    now = time.time()
    entries = greet_log()
    if entries:
        last_at = max(_num_or(e.get('at'), 0) for e in entries)
        left = interval - (now - last_at)
        if left > 0:
            return False, ('两次自动打招呼至少间隔 %g 秒，还差 %d 秒（服务端限流）。'
                           % (interval, math.ceil(left)))

    job_key = (payload.get('jobId') or '').strip()
    url_key = (payload.get('url') or '').strip()
    for e in entries:
        same = (job_key and (e.get('jobId') or '').strip() == job_key) or \
               (url_key and (e.get('url') or '').strip() == url_key)
        if not same:
            continue
        left_h = cooldown_h - (now - _num_or(e.get('at'), 0)) / 3600.0
        if left_h > 0:
            return False, ('这个岗位 %g 小时内已经自动打过招呼了（还有约 %.1f 小时）。'
                           '同一岗位重复发既费沟通额度、又容易被判成骚扰。'
                           % (cooldown_h, left_h))

    today = time.strftime('%Y-%m-%d', time.localtime(now))
    n_today = sum(1 for e in entries
                  if time.strftime('%Y-%m-%d', time.localtime(_num_or(e.get('at'), 0))) == today)
    if n_today >= daily_cap:
        return False, ('今天自动打招呼已经用了 %d 次（服务端单日上限 %d 次）。'
                       '留点额度给真正想聊的岗位，明天再来。' % (n_today, daily_cap))
    return True, ''


def build_cmd_apply_one(payload):
    """单岗位打招呼命令。**一次只处理一个岗位，参数里没有"列表"这个概念。**"""
    cmd = [PY, APPLY_ONE_SCRIPT,
           '--url', payload.get('url', ''),
           '--greeting', payload.get('greeting', ''),
           '--title', payload.get('title', ''),
           '--company', payload.get('company', '')]
    return cmd


def build_cmd_chat_sync(payload):
    cmd = [PY, CHAT_SYNC_SCRIPT, '--read']
    limit = payload.get('limit')
    if isinstance(limit, int) and limit > 0:
        cmd += ['--limit', str(limit)]
    return cmd


def _greet_gate(payload):
    """「一键打招呼」的闸门（服务端这道才是真闸门 —— 前端那遍只是省一次开浏览器）。

    返回 (ok, why)。任何一条不过就**什么都不做**。逐条对应前端设置页里承诺过的事：
      · 开关必须是开的 —— ⛔ 以前这句是**空话**（评审 P1-5）：函数体里 7 项检查
        没有一项读设置，而 autoGreet/greetIntervalSec/greetCooldownH 那时
        在 server.py 全文件 **0 命中**（它们只活在浏览器 localStorage 里，服务端读不到）。
        现在开关/间隔/冷却/单日上限都由前端同步到 greet_conf.json，服务端据此强制拦。
      · 一次只能一个岗位（不接受数组）
      · 必须有合法 BOSS 链接
      · 招呼语必须非空且不过长（空招呼语 = 白烧一次沟通额度）
    """
    conf = greet_conf()
    if conf is None:
        # 没同步过 → 服务端**不知道**开关是开是关 ⇒ 宁可不发（不可逆动作，默认拒绝）。
        # 正常不会出现：前端启动时就会同步一次；同步失败也能靠这句话自救。
        return False, ('服务端还没收到「一键打招呼」的开关状态，为安全起见先不发。'
                       '请回工作台刷新一次页面（前端会自动同步配置），或在设置里'
                       '重新点一下那个开关。')
    if not conf.get('autoGreet'):
        return False, '「一键打招呼」开关是关的（服务端读的是同步过来的配置）。'
    rate_ok, rate_why = _greet_rate_gate(payload)
    if not rate_ok:
        return False, rate_why
    if not skill_ready():
        return False, '找不到 boss-crawler 或它的虚拟环境，投递链路不可用。'
    if not login_fresh():
        return False, ('BOSS 登录态不新鲜（或没检测过）—— 先点「登录检测」扫码，'
                       '否则会白开一次浏览器。')
    url = (payload.get('url') or '').strip()
    if not BOSS_JOB_URL_RE.match(url):
        return False, '链接不是 BOSS 职位详情页，拒绝自动操作（可能是手动新增的岗位）。'
    greeting = (payload.get('greeting') or '').strip()
    if not greeting:
        return False, '招呼语是空的 —— 拿一次沟通额度去发一句空话，不如不发。'
    if len(greeting) > 500:
        return False, '招呼语 %d 字，超过聊天框能容纳的长度，先压到 500 字以内。' % len(greeting)
    if not (payload.get('title') or payload.get('company')):
        return False, '既没有岗位名也没有公司名，来源可疑，拒绝执行。'
    if not os.path.isfile(APPLY_ONE_SCRIPT):
        return False, '投递脚本缺失（%s）—— 多半是 skill 被重装或挪走了。' % APPLY_ONE_SCRIPT
    return True, ''


def _wait_task(task, timeout):
    """等一个任务跑完，返回它是否在超时前结束。用于把「起任务」变成「起并等结果」。"""
    deadline = time.time() + timeout
    while time.time() < deadline:
        if not task.running:
            return True
        time.sleep(0.4)
    return False


def build_cmd_crawl(p, rd=None):
    """把采集页表单翻成 pipeline 参数。

    只透传用户真给了的值 —— 空值必须丢掉，否则会拼出 `--salary ""`
    这种「筛了一个空值」的怪参数，BOSS 那边会当成没筛或者直接报错。

    rd：本次采集要写入的运行目录。调用方会先 new_run_dir() 拿到一个
    全新目录再传进来，避免复用旧目录导致结果覆盖、看不到新岗位。

    筛选维度说明（2026-09-30 扩展，对齐 BOSS 搜索接口的真实参数）：
      · 有 BOSS 接口参数的（透传给 pipeline）：city / keywords / salary /
        degree / experience / scale / stage(融资) / jobType(工作类型)
      · 无 BOSS 接口参数的（福利/活跃度）：不在这里传，由采集页结果区
        在本地二次过滤（见 view-collect.js 的 CF 状态）。
    """
    cmd = [PY, PIPELINE, '--from', 'infer', '--to', 'crawl']
    if rd is None:
        rd = run_dir()
    if rd:
        cmd += ['--run-dir', rd]

    def put(flag, value):
        if value not in (None, '', [], ()):
            cmd.extend([flag, str(value)])

    def put_list(flag, value):
        """列表值 → 逗号串（只有非空才透传）。"""
        if isinstance(value, (list, tuple)):
            value = ','.join([str(v).strip() for v in value if str(v).strip()])
        put(flag, value)

    def put_or_blank(flag, value):
        """模型能推断的字段：用户留空时必须**显式传空串**，不能省略。

        为什么（P2-4，体检报告 §1.4）：
          infer 阶段「命令行给了的用命令行的，没给的由模型从简历推断」
          （infer_params.py:492 的 manual_core 只认 keywords+city，其余字段一律
          走 apply_overrides；那里 `传空串 = params.pop(field) = 不筛这一项`，
          而「不传」= 保留模型推断值）。
          所以：用户故意把薪资留空（= 不限）时，若我们只是不传 `--salary`，
          模型会从简历推一个薪资档写进 crawl_params.json，BOSS 再按它硬筛 ——
          用户的「不限」被悄悄换成了「某个区间」。
          显式传 `--salary ""` 才等于「我确认不限，别替我决定」。

        ⚠️ 只对 str 型 flag 用（city/keywords/salary/degree/experience/scale/stage/job-type）。
          `--count` / `--top-n` / `--min-count` 是 type=int，传空串会让 argparse 直接报错，
          那几个字段继续用 put()（省略 = 用默认值）。
        """
        if isinstance(value, (list, tuple)):
            value = ','.join([str(v).strip() for v in value if str(v).strip()])
        if value in (None, [], ()):
            value = ''
        cmd.extend([flag, str(value)])

    # 城市 / 关键词是硬性必填（前端 doCrawl 已拦），这里照常传。
    put('--city', p.get('city'))
    keywords = p.get('keywords')
    if isinstance(keywords, (list, tuple)):
        keywords = ','.join([str(k).strip() for k in keywords if str(k).strip()])
    put('--keywords', keywords)
    put('--count', p.get('count'))
    put('--crawl-mode', p.get('crawlMode'))
    # 这 6 个「模型能推断」的字段一律显式传（留空就传空串 = 明确不筛）——
    # 见 put_or_blank 的 docstring。
    put_or_blank('--salary', p.get('salary'))
    put_or_blank('--degree', p.get('degree'))
    put_or_blank('--experience', p.get('experience'))
    put_or_blank('--job-type', p.get('jobType'))
    # scale / stage 模型推不出来（crawl_params.st:63 明令不要输出 scale），
    # 但同样显式传：语义一致（空 = 不筛），复盘命令行时也不用猜。
    put_or_blank('--scale', p.get('scale'))
    put_or_blank('--stage', p.get('stage'))

    # 详情**优先方向**：直接用采集参数里的「岗位期望」（expectJobs），**不做任何转换**。
    #
    # 为什么需要它：详情抓取是**封顶**的（本轮上限 _EST_DETAIL_TOP_N 条），额度给谁
    # 决定了 JD 覆盖率有没有用。crawler 原来的 detail_priority() 只按「信息完整度」
    # 排序（薪资能否解析 / 福利条数 / 有无学历经验 / 公司名是否截断），
    # 它**不知道你在找什么方向** —— 于是额度被「亚马逊运营（信息齐全）」这类岗位吃掉。
    # 实测：50 条额度里只有 33 条落在方向相关的岗位上，而「内容运营」那 46 条
    # 相关岗位**一条 JD 都没有**。
    #
    # ⛔ 它只影响**详情额度给谁**，不影响采集范围 —— 范围的权威来源仍然是 --keywords。
    # ⛔ 不传（expectJobs 为空）时，crawler 侧的排序口径与加这个参数之前逐字一致。
    put_list('--detail-prefer', p.get('expectJobs'))

    # 重新采集历史已采岗位：前端勾选「采集已采过岗位」时才透传（store_true 布尔，不带值）。
    # 不传 = 保持去重（跳过 known_links 里已有 JD 的历史岗位）。pipeline 在 crawl 阶段
    # 把它拼进 boss_post_interactive.py 的命令行，crawler 据此不加载全局已知集。
    if p.get('includeKnown'):
        cmd += ['--include-known']
    return cmd


# 与 boss-crawler 的 crawler 常量对齐（scripts/boss_crawler/config.py）。
# ⚠️ 这里**故意复刻**而不是 import：采集器是独立进程、且 skill 可能不在同一台机器上
#    （pipeline 的绝对路径是配置出来的）。复刻的代价是「改一边忘一边」，所以参数值
#    一律从下面这几个常量取，绝不散落在公式里；并且有断言守着值是否漂移。
_EST_PER_PAGE = 15          # 列表页每页条数（config.PER_PAGE）
_EST_PER_PAGE_SEC = 3       # 每翻一页的等待（config.PER_PAGE_TIME，boss-crawler 自己的估值、偏乐观，真实 5~8s）
_EST_PER_DETAIL_SEC = 5     # 每个详情的等待（config.detail_interval=3 再摊入分批冷却）
_EST_DETAIL_TOP_N = 50      # 详情抓取上限（config.DETAIL_TOP_N，**整轮共享**、轮级预算）
# 「BOSS 大约多少个详情会触发风控」——这是 **skill 侧注释里的估计值**
# （boss_crawler/config.py 的 SleepConfig 文档串写「大约 200 个详情就触发风控」），
# 不是官方公布的阈值。放在这里是为了**只有一个来源**：以前这个数在前端
# view-collect.js 里被硬编码成 `freq.detailThreshold || 200`，和 config 里的
# DETAIL_TOP_N(=50) 并列显示却没人解释两者关系，用户读到「风控阈值约 200」
# 会以为能拿到 200 条详情（实际 50）。
# ⛔ 改的时候请和 skill 注释一起改；不要单独动这里。
_EST_DETAIL_THRESHOLD = 200

# ---- 简历匹配（--from match）的成本预估常量 ----
# deep 模式 = 逐岗调一次 LLM：每次请求 = 简历摘要 + JD（截断 2500 字）+ 一段 40 字以内
# 的 highlight/risk 附言，输入约 2.5k~4k token、输出约 0.5k token。取一个偏保守的
# 每岗总令牌数（输入+输出），免得把用户往"很便宜"的方向低估。
# ⚠️ 这是**估值**，不是计费：真实 token 由 llm 模块的 llm_usage.jsonl 记录，
# 这里只在开跑前给人一个量级（见 estimate_match 的 docstring）。
_EST_MATCH_TOKENS_PER_JOB = 4000
_EST_MATCH_SEC_PER_JOB = 8.0       # 每岗一次 LLM 往返的保守耗时（排队 + 生成）
_EST_MATCH_DEFAULT_TOP = 15        # 与 pipeline 的 ctx['top_n'] 兜底值一致


def estimate_crawl(p):
    """预估一次采集要等多久（P2-2）。

    体检报告 §3.1：「用户开跑前不知道要等 30 分钟还是 3 分钟」。
    以前这个数只在 CLI 里算（crawler.py:1048），工作台看不到。

    **算法必须与 crawler 的「整轮共享封顶」同源**（2026-10-05 评审 P0-1.1）：
    详情按 `min(整轮条数, DETAIL_TOP_N)` 算。⚠️ 这里绝不能按「每个关键词各自封顶
    DETAIL_TOP_N」来算 —— 那会让 13 个关键词估出 650 条详情、把用户劝退；也不能
    反过来（crawler 每关键词封顶、预估却按整轮），那会估出 6.4 分钟、实际 52 分钟
    （8.2 倍差，正是本次评审抓到的 bug）。两处口径必须都是「整轮共享 DETAIL_TOP_N」。

    返回 {items, minutes, listMinutes, detailMinutes, detailCapped, capped}：
      · items     列表页预计读到多少条（count × 位置数 × 城市数）
      · minutes   总预估分钟（已含详情封顶）
      · capped    True = 详情被 Top N 截断（前端可据此说明「只抓最合适的 50 个详情」）
    """
    pos = p.get('keywords')
    if isinstance(pos, str):
        pos = [x for x in pos.split(',') if x.strip()]
    pos = [x for x in (pos or []) if str(x).strip()]
    cities = p.get('city')
    if isinstance(cities, str):
        cities = [x for x in cities.split(',') if x.strip()]
    cities = [x for x in (cities or []) if str(x).strip()]

    # 关键词/城市缺一时没法估 —— 返回 None，前端显示「填完城市和期望后再估」。
    if not pos or not cities:
        return None

    try:
        count = int(p.get('count') or 0)
    except (TypeError, ValueError):
        count = 0
    # count=0 在 BOSS 里是「不限」；CLI 的 estimate_time 对「不限」按每位置每城市 300 条估，
    # 沿用同一口径，免得两处算出两个数。
    per_pos_city = count if count > 0 else 300

    items = per_pos_city * len(pos) * len(cities)
    list_pages = int(math.ceil(items / float(_EST_PER_PAGE)))
    list_sec = list_pages * _EST_PER_PAGE_SEC

    detail_n = items
    capped = False
    if _EST_DETAIL_TOP_N and items > _EST_DETAIL_TOP_N:
        detail_n = _EST_DETAIL_TOP_N
        capped = True
    detail_sec = detail_n * _EST_PER_DETAIL_SEC

    total_sec = list_sec + detail_sec
    return {
        'items': items,
        'minutes': round(total_sec / 60.0, 1),
        'listMinutes': round(list_sec / 60.0, 1),
        'detailMinutes': round(detail_sec / 60.0, 1),
        'detailCapped': capped,
        'detailCount': detail_n,
        'detailCapN': _EST_DETAIL_TOP_N,
        'positions': len(pos),
        'cities': len(cities),
        'perPosCity': per_pos_city,
        'unlimited': count <= 0,
    }


def estimate_match(payload):
    """预估一次「简历匹配」（--from match）的成本与耗时。

    quick 模式零 token、秒级：run_matcher 纯规则 6 维评分，不调模型。
    deep 模式 = 逐岗调一次 LLM，成本随候选数线性涨，所以必须开跑前就讲清楚。

    返回 {mode, pool, candidates, minutes, tokens, costText}：
      · pool        岗位池 CSV 行数（去重前的候选上限，与 pipeline 同口径）
      · candidates  deep 模式下实际会送 LLM 的候选数 = min(topN, pool)
      · minutes     预估分钟（候选 ÷ 并发 × 每岗耗时）
      · tokens      预估总 token（候选 × 每岗令牌，输入+输出）
    并发默认按 deep_analyze 的配置 concurrency 取 4（真实值在 llm_config.json 里，
    这里不联网读，取一个常见量级，前端明说是「约」）。
    """
    mode = (payload or {}).get('matchMode') or 'deep'
    if mode not in ('quick', 'deep'):
        mode = 'deep'

    pool = _job_pool_rows()

    if mode == 'quick':
        return {'mode': 'quick', 'pool': pool, 'candidates': pool,
                'minutes': 0.0, 'tokens': 0,
                'costText': '零 token · 秒级完成（纯规则评分）'}

    top = payload.get('topN')
    try:
        top = int(top)
    except (TypeError, ValueError):
        top = _EST_MATCH_DEFAULT_TOP
    if top <= 0:
        top = _EST_MATCH_DEFAULT_TOP
    candidates = max(1, min(top, pool)) if pool else top

    workers = payload.get('workers')
    try:
        workers = int(workers)
    except (TypeError, ValueError):
        workers = 4
    if workers <= 0:
        workers = 4

    minutes = round(candidates / float(workers) * _EST_MATCH_SEC_PER_JOB / 60.0, 1)
    tokens = candidates * _EST_MATCH_TOKENS_PER_JOB
    return {'mode': 'deep', 'pool': pool, 'candidates': candidates,
            'workers': workers,
            'minutes': minutes, 'tokens': tokens,
            'costText': '约 %d 条 × %d token ≈ %s token · 约 %s'
                        % (candidates, _EST_MATCH_TOKENS_PER_JOB,
                           _fmt_tokens(tokens), _fmt_minutes(minutes))}


def _fmt_tokens(n):
    """token 数 → 人话（2.4k / 15k / 1.2M）。"""
    n = int(n or 0)
    if n >= 1000000:
        return '%.1fM' % (n / 1000000.0)
    if n >= 1000:
        return '%.1fk' % (n / 1000.0)
    return str(n)


def _fmt_minutes(m):
    """分钟 → 人话（"<1 分钟" / "3.2 分钟"）。"""
    m = float(m or 0)
    if m <= 0:
        return '<1 分钟'
    if m < 1:
        return '<1 分钟'
    return '%.1f 分钟' % m


def build_cmd_match(payload, rd):
    """把「简历匹配」请求翻成 pipeline 参数。

    `--from match --to merge`：
      · quick：跑 match（纯规则）→ deep/merge 在快速模式下自动跳过，
               pipeline 内部会用 qualified_from_scored 补写 qualified_jobs.json。
      · deep ：跑 match（预筛）→ deep（逐岗 LLM）→ merge（混合分 + 原因落盘）。

    rd：匹配的是**当前运行目录**里已爬好的岗位（post_data CSV），不新建目录 ——
    简历匹配是"对已采集岗位再加工"，不是一次新采集，复用 LATEST 指着的目录。
    """
    mode = (payload or {}).get('matchMode') or 'deep'
    if mode not in ('quick', 'deep'):
        mode = 'deep'

    cmd = [PY, PIPELINE, '--from', 'match', '--to', 'merge', '--match-mode', mode]

    if mode == 'deep':
        top = payload.get('topN')
        try:
            top = int(top)
        except (TypeError, ValueError):
            top = None
        if top and top > 0:
            cmd += ['--top-n', str(top)]
        workers = payload.get('workers')
        try:
            workers = int(workers)
        except (TypeError, ValueError):
            workers = None
        if workers and workers > 0:
            cmd += ['--workers', str(workers)]

    if rd:
        cmd += ['--run-dir', rd]
    return cmd


# ==================== 采集参数 / 简历 读取 ====================

def current_params():
    """当前生效的采集参数。优先运行目录里的 crawl_params.json，退回偏好文件。

    除了城市/关键词/薪资/条数，还回吐 degree/experience/scale/stage/jobType 五个
    筛选维度（评审 P1-3.1）：这些值 boss-crawler 早已写进 crawl_params.json，以前
    current_params 不读、前端就硬编码空数组，用户 F5 一下全丢，得重新手点 14 次。
    回吐后前端用它们当 chips 初值。welfare/activeTime/expectJobs 是纯工作台侧的
    字段，这里没有，由前端另做 localStorage 兜底。

    ⛔ districts / bizAreas 这里**故意不回吐**（第 21 轮）：这两个键从来就不在
    crawl_params.json 里，而 view-collect.js 曾经写「区/商圈默认继承求职偏好」
    却去读 out['districts'] —— 恒得到 undefined → []，那条「继承」从来没生效过，
    而且静默（区选好、采集页永远空、结果页精筛也空，全程不报错）。
    现在改由前端 `geoSeedFor()` 从 JobMatch.prefs() 取，并带城市一致性校验。
    下游要读这两个键，请直接读偏好，不要在这里加回吐 —— 加了会重新变成两套真源。
    """
    out = {'city': '', 'keywords': [], 'salary': '', 'count': 30, 'crawlMode': 'custom',
           'degree': [], 'experience': [], 'scale': [], 'stage': [], 'jobType': [],
           'source': None}

    def as_list(v):
        """list/tuple → 去空列表；str → 按逗号拆；其它 → []。"""
        if isinstance(v, (list, tuple)):
            return [str(x).strip() for x in v if str(x).strip()]
        if isinstance(v, str) and v.strip():
            return [x.strip() for x in v.split(',') if x.strip()]
        return []

    rd = run_dir()
    if rd:
        cp = read_json(state_path(rd, 'crawl_params.json'))
        if isinstance(cp, dict):
            out['city'] = ','.join(cp.get('cities') or []) if isinstance(cp.get('cities'), list) else (cp.get('city') or '')
            kw = cp.get('keywords')
            out['keywords'] = kw if isinstance(kw, list) else ([kw] if kw else [])
            sal = cp.get('salary')
            out['salary'] = ','.join(sal) if isinstance(sal, list) else (sal or '')
            out['count'] = cp.get('count') or out['count']
            out['crawlMode'] = cp.get('mode') or out['crawlMode']
            # 筛选维度（评审 P1-3.1）。crawl_params 里 job_type 是下划线，前端用 jobType 驼峰。
            out['degree'] = as_list(cp.get('degree'))
            out['experience'] = as_list(cp.get('experience'))
            out['scale'] = as_list(cp.get('scale'))
            out['stage'] = as_list(cp.get('stage'))
            out['jobType'] = as_list(cp.get('job_type'))
            out['source'] = 'crawl_params.json（本运行目录）'
    if not out['keywords']:
        pref = read_json(os.path.join(ASSETS_DIR, 'preferences.json'))
        if isinstance(pref, dict):
            out['city'] = out['city'] or ','.join(pref.get('cities') or []) if isinstance(pref.get('cities'), list) else out['city']
            kw = pref.get('keywords')
            if isinstance(kw, list) and kw:
                out['keywords'] = kw
            sal = pref.get('salary')
            if isinstance(sal, list) and sal:
                out['salary'] = out['salary'] or ','.join(sal)
            out['count'] = pref.get('count') or out['count']
            # 筛选维度兜底（评审 P1-3.1）
            out['degree'] = out['degree'] or as_list(pref.get('degree'))
            out['experience'] = out['experience'] or as_list(pref.get('experience'))
            out['scale'] = out['scale'] or as_list(pref.get('scale'))
            out['stage'] = out['stage'] or as_list(pref.get('stage'))
            out['jobType'] = out['jobType'] or as_list(pref.get('job_type'))
            out['source'] = out['source'] or 'preferences.json'
    return out


def profile_summary():
    """从 profile.json 里摘一点能显示的东西。

    字段名以 parse_resume.py 写出的真实结构为准：
    basic_info.name / education.degree / experience.total_years /
    basic_info.expected_city / basic_info.expected_position / keywords。

    **刻意不返回 phone / email** —— 前端一处都用不上，
    没必要把个人联系方式多复制一份到浏览器里。
    """
    rd = run_dir()
    if not rd:
        return None
    path = state_path(rd, 'profile.json')
    prof = read_json(path)
    if not isinstance(prof, dict):
        return None

    basic = prof.get('basic_info') if isinstance(prof.get('basic_info'), dict) else {}
    edu = prof.get('education') if isinstance(prof.get('education'), dict) else {}
    exp = prof.get('experience') if isinstance(prof.get('experience'), dict) else {}
    kw = prof.get('keywords') if isinstance(prof.get('keywords'), list) else []
    sal = prof.get('salary_expectation') if isinstance(prof.get('salary_expectation'), dict) else {}

    def s(v):
        return '' if v in (None, '') else str(v)

    return {
        'name': s(basic.get('name')),
        'degree': s(edu.get('degree')),
        'years': s(exp.get('total_years')),
        'city': s(basic.get('expected_city')),
        'position': s(basic.get('expected_position')),
        'salaryMin': sal.get('min'),
        'salaryMax': sal.get('max'),
        'keywordCount': len(kw),
        'keywords': [str(x) for x in kw[:20]],
        'updatedAt': os.path.getmtime(path),
    }


def llm_ready():
    cfg = read_json(os.path.join(ASSETS_DIR, 'llm_config.json'), {}) or {}
    key = str(cfg.get('api_key') or '')
    return bool(key) and key.lower() not in ('your-api-key', 'sk-xxx', 'placeholder')


# ==================== 简历文件管理 ====================

RESUME_ARCHIVE_DIR = os.path.join(DATA_DIR, 'resume-archive')


def list_resumes():
    """列出 data/resume/ 下的简历文件（只读，供前端「删除入口」列出）。

    ⚠️ 不返回文件内容，只返回文件名 / 大小 / 时间 —— 简历是个人隐私原件，
    没必要把它读到浏览器里。
    """
    if not os.path.isdir(RESUME_DIR):
        return []
    out = []
    try:
        names = os.listdir(RESUME_DIR)
    except OSError:
        return []
    for name in names:
        path = os.path.join(RESUME_DIR, name)
        if not os.path.isfile(path):
            continue
        try:
            st = os.stat(path)
        except OSError:
            continue
        out.append({
            'name': name,
            'size': st.st_size,
            'mtime': st.st_mtime,
        })
    out.sort(key=lambda x: x['mtime'], reverse=True)
    return out


def delete_resume(name):
    """删除（归档）data/resume/ 下的一个简历文件（评审 P2-6）。

    以前简历上传后长期留盘、没有删除入口。这里归档到 data/resume-archive/<时间戳>/，
    而不是硬删 —— 简历是个人原件，点错还能找回，与「清空采集结果」同一套哲学。
    文件名做净化 + 必须落在 RESUME_DIR 内（防目录穿越）。
    """
    name = os.path.basename(name or '')
    if not name:
        return {'ok': False, 'error': '没指定要删的文件。'}
    src = os.path.join(RESUME_DIR, name)
    # 目录穿越防护：解析后必须仍在 RESUME_DIR 之内
    if os.path.normpath(src) != src or not src.startswith(os.path.normpath(RESUME_DIR) + os.sep):
        return {'ok': False, 'error': '非法文件名。'}
    if not os.path.isfile(src):
        return {'ok': False, 'error': '文件不存在：%s' % name}
    stamp = time.strftime('%Y-%m-%d_%H-%M-%S')
    dest = os.path.join(RESUME_ARCHIVE_DIR, stamp, name)
    try:
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(src, dest)
    except OSError as exc:
        return {'ok': False, 'error': '归档失败：%s' % exc}
    log('resume archived: %s -> %s' % (src, dest))
    return {'ok': True, 'name': name, 'dest': dest}


# ==================== 采集结果读取 ====================

def _job_pool_rows():
    """assets/post_data 下所有 CSV 的行数之和（match 会读到的岗位量，去重前）。

    复刻 pipeline.py 的 job_pool_rows()：match 阶段由 run_matcher.py 的
    list_available_job_files() 读的就是这个目录，跨关键词会重复，所以是「行数」
    不是「唯一岗位数」—— 估候选量时按它当上限，别按去重后算。
    """
    total = 0
    base = os.path.join(ASSETS_DIR, 'post_data')
    for path in glob.glob(os.path.join(base, '**', '*.csv'), recursive=True):
        if '_details' in os.path.basename(path):
            continue
        try:
            with open(path, 'r', encoding='utf-8-sig', newline='') as f:
                total += sum(1 for _ in csv.DictReader(f))
        except OSError:
            continue
    return total


def match_map(rd):
    """按 link 汇总「简历匹配」结论 → {link: {match_score, application_category, ...}}。

    两个来源、按存在性二选一（不是合并）：
      · 深度模式：state/match_analysis.json —— merge 阶段按 link 写的裁定结论
        （混合分 60% LLM + 40% 规则、原因、缺项），是最权威的一份。
      · 快速模式：state/scored_jobs.json —— tier 项里直接带 match_score 与
        application_category_reason（tier1/tier2/tier3；tier4 是"分太低丢弃"，
        本来就不在 load_jobs 的可见范围里）。

    键用 strip 后的 link（与 merge 端 link_key、load_jobs 的去重键同一口径），
    让两边按 link 连得上。
    """
    if not rd:
        return {}

    deep = read_json(state_path(rd, 'match_analysis.json'))
    if isinstance(deep, dict) and deep:
        return deep

    out = {}
    scored = read_json(state_path(rd, 'scored_jobs.json'))
    if isinstance(scored, dict):
        for tier in ('tier1', 'tier2', 'tier3'):
            for job in (scored.get(tier) or []):
                if not isinstance(job, dict):
                    continue
                link = str(job.get('link') or job.get('url') or '').strip()
                if not link:
                    continue
                out[link] = {
                    'match_score': job.get('match_score'),
                    'application_category': job.get('application_category') or '',
                    'application_category_reason': (job.get('application_category_reason')
                                                    or job.get('classification_reason') or ''),
                    'missing_items': job.get('missing_skills') or [],
                }
    return out


def load_jobs(rd):
    """按「匹配结果 → 评分结果 → 原始 CSV」三级回退读岗位。

    回退是必要的：刚爬完还没匹配时，用户就想看看爬到了什么，
    这时 qualified_jobs.json 根本还不存在。

    返回的是**原始记录**（boss-crawler 的中文列名），不做字段翻译 ——
    工作台那边的导入器（Exporter.fromCrawlerRecord）已经认得这些列名，
    在这里再翻一遍只会多出一份需要同步维护的映射表。
    """
    if not rd:
        return {'source': None, 'jobs': [], 'total': 0}

    raw = []
    source = None

    qualified = read_json(state_path(rd, 'qualified_jobs.json'))
    if isinstance(qualified, list) and qualified:
        raw, source = qualified, 'qualified_jobs.json（已匹配）'

    if not raw:
        scored = read_json(state_path(rd, 'scored_jobs.json'))
        if isinstance(scored, dict):
            raw = (scored.get('tier1') or []) + (scored.get('tier2') or [])
            if raw:
                source = 'scored_jobs.json（已初步评分）'

    if not raw:
        csvs = []
        for base in (os.path.join(ASSETS_DIR, 'post_data'),
                     os.path.join(rd, 'post_data')):
            csvs.extend(glob.glob(os.path.join(base, '**', '*.csv'), recursive=True))
        for path in csvs:
            if '_details' in os.path.basename(path):
                continue        # 详情页原文单独一份，别混进列表
            try:
                with open(path, 'r', encoding='utf-8-sig', newline='') as f:
                    raw.extend(list(csv.DictReader(f)))
            except OSError:
                continue
        if raw:
            source = 'post_data/*.csv（刚爬完，未匹配）'

    # 同一岗位会被多个关键词各写一份 → 按 link 去重（没有 link 就用 公司+岗位）
    seen, jobs = set(), []
    for item in raw:
        if not isinstance(item, dict):
            continue
        link = str(item.get('link') or item.get('url') or '').strip()
        key = link or ('%s||%s' % (item.get('公司') or item.get('company') or '',
                                   item.get('职位') or item.get('title') or ''))
        if not key.strip() or key in seen:
            continue
        seen.add(key)
        jobs.append(item)

    # 标记「本轮新增」：读爬虫写的 state/round_links.json（本轮的 link 集合）。
    # 为什么不是「文件比 started_at 新」——CSV 按关键词跨轮累积，同一文件会被
    # 多轮追加，mtime 分不出哪一行是本轮的。round_links.json 才是精确答案。
    # 读不到就全部算「历史」（新增数 0），前端会退回「看全部」，不会瞎标。
    round_links = _read_round_links(rd)
    new_count = 0
    for item in jobs:
        link = str(item.get('link') or item.get('url') or '').strip()
        is_new = bool(round_links and link and link in round_links)
        item['_isNew'] = is_new
        if is_new:
            new_count += 1

    # 详情失败统计（P1-3）：让「数据不全」是可见的
    detail_failures = collect_detail_failures(rd)

    # 权威岗位要求（P1-5）：assets/job_requirements.json 是按 link 索引的
    # 「从 JD 抽出的结构化要求」（学历/经验/薪资/技能），由爬虫侧增量刷新。
    # 挂到每条记录上，前端在合适度打分时用它兜底 —— BOSS 列表页的学历/经验
    # 常为空或写得很粗，而这里是从 JD 正文抽出来的、更准。
    # ⚠️ 键名必须带下划线 `_reqAuthoritative`：前端 export.js 的 fromCrawlerRecord
    # 读的就是 `o._reqAuthoritative`（和 `_isNew` 同款内部字段命名）。曾写成
    # `reqAuthoritative`（无下划线）→ 前端白名单读不到 → 权威要求整条链断开
    # （2026-10-05 评审 P0-2.1）。
    reqs = load_job_requirements()
    req_hit = 0
    if reqs:
        for item in jobs:
            link = str(item.get('link') or item.get('url') or '').strip()
            r = reqs.get(link)
            if isinstance(r, dict):
                item['_reqAuthoritative'] = r
                req_hit += 1

    # 简历匹配结论（P2）：match_map 按 link 汇总打分+原因（深度=混合分，快速=规则分），
    # 挂到每条记录上。qualified_jobs.json 只存原始爬取字段、不带分 —— 分在
    # match_analysis.json / scored_jobs.json 里，这里按 link 连回来。
    # ⚠️ 键名带下划线 `_matchScore` 等：与 `_isNew` / `_reqAuthoritative` 同款内部
    # 字段命名，前端 resultJobs() 会按这些键显式接走（不进共用 fromCrawlerRecord，
    # 免得影响岗位库那条链路的字段白名单）。
    mm = match_map(rd)
    matched_count = 0
    if mm:
        for item in jobs:
            link = str(item.get('link') or item.get('url') or '').strip()
            r = mm.get(link)
            if not isinstance(r, dict):
                continue
            score = r.get('match_score')
            if score is not None:
                try:
                    item['_matchScore'] = int(round(float(score)))
                except (TypeError, ValueError):
                    item['_matchScore'] = None
            item['_matchCategory'] = r.get('application_category') or ''
            item['_matchReason'] = r.get('application_category_reason') or ''
            item['_matchMissing'] = r.get('missing_items') or []
            if item.get('_matchScore') is not None:
                matched_count += 1

    return {'source': source, 'jobs': jobs, 'total': len(jobs),
            'newCount': new_count, 'hasRoundInfo': bool(round_links),
            'detailFailures': detail_failures,
            'reqHits': req_hit, 'reqTotal': len(reqs),
            'matchedCount': matched_count, 'hasMatch': bool(mm)}


# 岗位权威要求缓存（assets/job_requirements.json 较大，读一次记着；
# 文件 mtime 变了才重读 —— 爬虫每轮会增量刷新它）
_JOB_REQ_CACHE = {'mtime': None, 'data': None}


def load_job_requirements():
    """读 assets/job_requirements.json：{link: {学历要求,经验要求,薪资范围,技能要求[]}}。

    ⚠️ 文件是 **UTF-8 BOM** 编码（制作者用 utf-8-sig 写的），用 'utf-8' 读会
    json 解析失败（Unexpected UTF-8 BOM）。必须 utf-8-sig。
    读不到就返回空 dict —— 这是加分项，不该影响采集结果本身。
    """
    path = os.path.join(ASSETS_DIR, 'job_requirements.json')
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return {}
    if _JOB_REQ_CACHE['mtime'] == mtime and _JOB_REQ_CACHE['data'] is not None:
        return _JOB_REQ_CACHE['data']
    try:
        with open(path, 'r', encoding='utf-8-sig') as f:
            data = json.load(f)
        if not isinstance(data, dict):
            data = {}
    except (OSError, ValueError):
        data = {}
    _JOB_REQ_CACHE['mtime'] = mtime
    _JOB_REQ_CACHE['data'] = data
    return data


def collect_detail_failures(rd):
    """汇总各 CSV 旁的 *_detail_failures.json（详情抓取失败清单）。

    爬虫侧 crawl_job_details 结束时会把失败清单写成 `<csv>_detail_failures.json`
    （P1-3）。这里读出来给前端明示 —— 以前失败只打一行日志，用户以为数据是全的。

    返回 {'count': N, 'reasons': {原因: 条数}}；没有失败文件时 count=0。
    """
    out = {'count': 0, 'reasons': {}}
    if not rd:
        return out

    bases = [os.path.join(ASSETS_DIR, 'post_data'), os.path.join(rd, 'post_data')]
    for base in bases:
        for path in glob.glob(os.path.join(base, '**', '*_detail_failures.json'),
                              recursive=True):
            try:
                with open(path, 'r', encoding='utf-8') as f:
                    data = json.load(f)
            except (OSError, ValueError):
                continue
            if not isinstance(data, dict):
                continue
            items = data.get('failures')
            if not isinstance(items, list):
                continue
            for it in items:
                reason = '未知'
                if isinstance(it, dict):
                    reason = str(it.get('reason') or '未知')
                out['reasons'][reason] = out['reasons'].get(reason, 0) + 1
                out['count'] += 1
    return out


def list_history():
    """列出采集历史（活跃 run-dir + 归档的旧 run-dir）。

    为什么需要它：界面以前只显示 LATEST 指向的那一个目录路径，用户想找回
    9-25 那批数据得自己去翻文件系统（体检报告 §3.1）。这里把资产目录下的
    运行目录、以及 results-archive/ 里的历史都列出来，标明时间、是否当前、
    有没有采集产物（CSV / 结果 JSON），用户至少知道「东西在哪、还在不在」。

    ⚠️ 只读 —— 不做「载入历史轮次」这类会改 LATEST 指针的动作：
    跨轮去重逻辑下，指针一改语义会变复杂，容易让用户误以为「切过去这批就是我的」。
    """
    items = []
    current = None
    try:
        with open(os.path.join(ASSETS_DIR, 'LATEST.txt'), 'r', encoding='utf-8') as f:
            current = f.read().strip()
    except OSError:
        pass

    def scan(base, kind):
        if not os.path.isdir(base):
            return
        for name in os.listdir(base):
            path = os.path.join(base, name)
            if not os.path.isdir(path):
                continue
            # 只认「长得像运行目录」的（名字以 20xx- 开头），跳过 chrome_user_data 等
            if not re.match(r'^\d{4}-\d{2}-\d{2}', name):
                continue
            csvs = glob.glob(os.path.join(path, '**', '*.csv'), recursive=True)
            csvs = [c for c in csvs if '_details' not in os.path.basename(c)]
            has_result = any(
                os.path.exists(state_path(path, f))
                for f in ('qualified_jobs.json', 'scored_jobs.json')
            )
            mt = 0
            try:
                mt = os.path.getmtime(path)
            except OSError:
                pass
            items.append({
                'name': name,
                'kind': kind,               # active | archived
                'current': bool(current and name == current and kind == 'active'),
                'csvCount': len(csvs),
                'hasResult': has_result,
                'mtime': mt,
                'path': path,
            })

    scan(ASSETS_DIR, 'active')
    scan(os.path.join(ASSETS_DIR, 'results-archive'), 'archived')
    # 归档里可能有 old-runs-xxx 中间层，再扫一层
    oldruns = os.path.join(ASSETS_DIR, 'results-archive', 'old-runs-2026-09')
    scan(oldruns, 'archived')
    # 归档目录下可能还套一层（results-archive/<时间戳>/）
    arch = os.path.join(ASSETS_DIR, 'results-archive')
    if os.path.isdir(arch):
        for d in os.listdir(arch):
            sub = os.path.join(arch, d)
            if os.path.isdir(sub) and re.match(r'^\d{4}-\d{2}-\d{2}', d):
                scan(sub, 'archived')

    # 去重（同一个 name 可能被多条路径扫到），按时间倒序
    seen, out = set(), []
    for it in sorted(items, key=lambda x: x['mtime'], reverse=True):
        key = (it['name'], it['kind'])
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


def _read_round_links(rd):
    """读 run-dir/state/round_links.json 的 links 集合；读不到返回 None。

    返回 None（而不是空集）是有意的：前端据此区分「本轮确实新增 0 个」和
    「压根没有本轮信息，别显示新增筛选」——两者不能混。
    """
    if not rd:
        return None
    path = state_path(rd, 'round_links.json')
    try:
        with open(path, 'r', encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError):
        return None
    links = data.get('links') if isinstance(data, dict) else None
    if not isinstance(links, list):
        return None
    return set(str(x) for x in links if x)


def clear_results():
    """把「这批采集结果」归档到 assets/results-archive/<时间戳>/（**移动，不是删除**）。

    为什么是归档不是删除：这是用户点一个按钮就触发的批量破坏性操作，
    万一点错（还没导入岗位库就清了），移动到归档目录还能整批找回来；
    真删了就只能重爬。归档目录会越攒越大，用户想清理时手动删即可。

    覆盖 load_jobs 三级回退会读到的**全部来源**：
      · 运行目录 state/qualified_jobs.json（已匹配）
      · 运行目录 state/scored_jobs.json（已评分）
      · assets/post_data/（全局 CSV，含 custom/ 子目录与详情原文）
      · 运行目录 post_data/
    LATEST.txt 与运行目录骨架不动 —— 下一轮采集管线还要用。
    post_data 移走后立刻建回空目录，采集脚本直接往里写不报错。

    岗位库完全不受影响：已导入的数据在浏览器的 localStorage 里，
    从来没有经过这些文件。
    """
    with CURRENT_LOCK:
        if CURRENT is not None and CURRENT.running:
            return {'ok': False,
                    'error': '采集正在进行中（%s），等它跑完或先停止再清。' % CURRENT.title}

    rd = run_dir()
    stamp = time.strftime('%Y-%m-%d_%H-%M-%S')
    dest_root = os.path.join(ASSETS_DIR, 'results-archive', stamp)
    moved = []

    def mv(src, rel):
        if not src or not os.path.exists(src):
            return
        dst = os.path.join(dest_root, rel)
        try:
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.move(src, dst)
            moved.append(rel)
        except OSError:
            pass    # 单个移不动（被占用等）就跳过，别让整个清空中断

    if rd:
        mv(state_path(rd, 'qualified_jobs.json'), os.path.join('state', 'qualified_jobs.json'))
        mv(state_path(rd, 'scored_jobs.json'), os.path.join('state', 'scored_jobs.json'))
        mv(os.path.join(rd, 'post_data'), 'run_post_data')
        # 运行目录的 post_data 建回空壳，管线接着用不报错
        try:
            os.makedirs(os.path.join(rd, 'post_data'), exist_ok=True)
        except OSError:
            pass
    mv(os.path.join(ASSETS_DIR, 'post_data'), 'post_data')
    # 全局 post_data 同样建回空壳
    try:
        os.makedirs(os.path.join(ASSETS_DIR, 'post_data'), exist_ok=True)
    except OSError:
        pass

    return {'ok': True, 'archived': moved, 'n': len(moved),
            'dest': dest_root if moved else None}


def build_alive():
    """轻量存活探测：**故意不含任何敏感信息**，所以不需要 token。
    启动脚本靠它判断「采集器是不是已经在跑」——在跑就别再起一个（治标签页爆炸）。"""
    return {
        'ok': True,
        'service': 'jobhunter-collector',
        'version': VERSION,
        'port': CURRENT_PORT,
        'pid': os.getpid(),
        'startedAt': START_TIME,
        'skillReady': skill_ready(),
    }


def write_status(ok, **extra):
    """把本次启动结果写到 data/status.json —— 启动脚本失败时读它给用户看原因。

    ⛔ `instance` 是「这份 status 是谁写的」的凭据（评审 P1-3）。退出时靠它判断
       这些运行文件还是不是自己的，是就别删 —— 否则短命实例会把还在跑的实例
       的痕迹一起抹掉。
    """
    data = {
        'ok': bool(ok),
        'service': 'jobhunter-collector',
        'version': VERSION,
        'pid': os.getpid(),
        'pidRoot': ROOT_PID or os.getpid(),   # 停止脚本用这个（venv shim 的根）
        'port': CURRENT_PORT,
        'startedAt': START_TIME,
        'instance': INSTANCE_ID,
        'updatedAt': time.time(),
        'skillReady': skill_ready(),
    }
    data.update(extra)
    try:
        write_json(STATUS_PATH, data)
    except OSError:
        pass
    return data


def login_fresh():
    """登录态是否「已知且新鲜」。采集前用它预检，避免白跑。"""
    val = LOGIN_STATE.get('value')
    at = LOGIN_STATE.get('checked_at') or 0
    return val == 'ok' and (time.time() - at) < LOGIN_TTL


def collect_frequency():
    """采集频次统计（评审 §五-2 / 3.6）：本日 / 本周跑了几轮、上次采集时间。

    数据源是 assets 下的运行目录（每次「开始采集」新建一个，名字是时间戳 20xx-…），
    以及 data/ 下任务落盘日志 task-crawl-*.log（每次采集任务的真实 stdout）。
    两者互为印证：目录数 = 起过多少轮，日志数 = 真正跑起来的采集任务数。

    ⚠️ 只读、只统计，不联网、不动任何文件。返回 None 表示「还没有采集历史」。
    """
    now = time.time()
    today_start = now - (now % 86400)              # 本地时区的今日 0 点（近似）
    week_start = now - 7 * 86400

    def mtime_of(p):
        try:
            return os.path.getmtime(p)
        except OSError:
            return None

    # 运行目录（活跃 + 归档里的一起算，历史归档也代表「跑过」）
    dirs = set()
    latest = None
    for base in (ASSETS_DIR, os.path.join(ASSETS_DIR, 'results-archive')):
        if not os.path.isdir(base):
            continue
        try:
            names = os.listdir(base)
        except OSError:
            continue
        for name in names:
            if not re.match(r'^\d{4}-\d{2}-\d{2}', name):
                continue
            path = os.path.join(base, name)
            if not os.path.isdir(path):
                continue
            dirs.add(path)
    # 归档可能套层（results-archive/<时间戳>/、old-runs-xxx/），再扫一层
    arch = os.path.join(ASSETS_DIR, 'results-archive')
    if os.path.isdir(arch):
        try:
            for sub in os.listdir(arch):
                subpath = os.path.join(arch, sub)
                if not os.path.isdir(subpath):
                    continue
                for name in os.listdir(subpath):
                    if not re.match(r'^\d{4}-\d{2}-\d{2}', name):
                        continue
                    p = os.path.join(subpath, name)
                    if os.path.isdir(p):
                        dirs.add(p)
        except OSError:
            pass

    mtimes = [mtime_of(p) for p in dirs]
    mtimes = [m for m in mtimes if m]
    if not mtimes:
        return None
    last = max(mtimes)

    # 任务落盘日志：真正跑起来的采集任务（含中途停止的）
    crawl_logs = glob.glob(os.path.join(DATA_DIR, 'task-crawl-*.log'))
    log_mtimes = [mtime_of(p) for p in crawl_logs]
    log_mtimes = [m for m in log_mtimes if m]

    return {
        'todayRuns': sum(1 for m in mtimes if m >= today_start),
        'weekRuns': sum(1 for m in mtimes if m >= week_start),
        'totalRuns': len(mtimes),
        'lastCrawlAt': last,
        # 两个数一起给前端，好让它把关系讲清楚（见 _EST_DETAIL_THRESHOLD 的注释）。
        # ⛔ 不要再在前端硬编码 200 —— 那样两处会各自漂移。
        'detailThreshold': _EST_DETAIL_THRESHOLD,   # BOSS 风控线（约数，来自 skill 注释）
        'detailCap': _EST_DETAIL_TOP_N,             # 本轮实际上限（config.DETAIL_TOP_N）
    }


def detect_interrupted():
    """检测「上一次采集是否可能中断了」（评审 §五-5 断点续采的探针）。

    判据：当前 run-dir 里**没有 crawl_summary.json**，但存在 round_links.json。
    crawl_summary.json 是 crawler 在**整轮正常跑完**时才写的（crawler.py 末尾），
    round_links.json 是整轮结束前写的（execute_crawl_iteration 末尾）—— 所以
    「有 round_links、无 summary」≈ 采到一半被中断了。

    ⚠️ 不把 data/ 下的历史 task-crawl-*.log 当判据：那是全局累积的，包含更早
    正常跑完的轮次，会误判「上次中断」。只看当前 run-dir 自己的 round_links。

    返回 None = 没有中断迹象；否则返回 {'runDir': ..., 'roundLinks': N} 供前端提示。
    只读、不联网、不改任何文件。
    """
    rd = run_dir()
    if not rd:
        return None
    # crawl_summary.json 存在 = 上次正常跑完，不算中断
    if os.path.exists(state_path(rd, 'crawl_summary.json')):
        return None
    # 有 round_links（采到了一部分）= 采集启动过但没正常收尾 → 疑似中断
    round_links = _read_round_links(rd)
    if round_links:
        return {
            'runDir': rd,
            'roundLinks': len(round_links),
        }
    return None


def build_ping():
    rd = run_dir()
    prof = profile_summary()
    return {
        'ok': True,
        'version': VERSION,
        'port': CURRENT_PORT,
        'pid': os.getpid(),
        'pidRoot': ROOT_PID or os.getpid(),
        'startedAt': START_TIME,
        'skillReady': skill_ready(),
        'skillDir': SKILL_DIR if skill_ready() else None,
        'dictState': dict_state(),
        'dictReady': dict_ready(),
        'llmReady': llm_ready(),
        'runDir': rd,
        'hasProfile': bool(prof),
        'profile': prof,
        'params': current_params(),
        'login': {'value': LOGIN_STATE['value'],
                  'checkedAt': LOGIN_STATE['checked_at'],
                  'ttlSec': LOGIN_TTL,          # 前端据此判新鲜，别在前端写死
                  'fresh': login_fresh()},
        'frequency': collect_frequency(),      # 采集频次（本日/本周轮数、上次时间）
        'interrupted': detect_interrupted(),   # 上次采集是否疑似中断（断点续采探针）
        'busy': bool(CURRENT is not None and CURRENT.running),
        'paused': bool(CURRENT is not None and CURRENT.running and CURRENT.paused),
        'chromePath': subprocess_env().get('CHROME_PATH'),
    }


def inject_token(raw):
    """把访问 token 注进要 serve 的 HTML（见文件头「安全」一节）。

    只在**本服务 serve 的页面**里有这个全局变量 —— 它是前端调 /api/* 的通行证。
    file:// 打开的同一份 index.html 拿不到（文件是磁盘上的原样），
    前端据此给出明确的引导提示，而不是静默地每个请求都 403。
    """
    html = raw.decode('utf-8', 'replace')
    if '__JH_TOKEN__' in html:                                 # 已经注过就别插第二次
        return raw
    tag = '<script>window.__JH_TOKEN__=%s;</script>' % json.dumps(TOKEN)
    if '</head>' in html:
        html = html.replace('</head>', tag + '</head>', 1)
    else:
        html = tag + html
    return html.encode('utf-8')


# ==================== HTTP ====================

def cors_headers_for(origin):
    """按请求的 Origin 决定回哪些 CORS 头。

    · 没带 Origin（同源请求 / curl 等非浏览器调用）→ 不需要 CORS 头，回空。
    · Origin 命中白名单 → 回显**那一个** Origin（绝不回 `*`），浏览器才允许读取响应。
    · Origin 不在白名单 → 回 None。调用方据此拒绝，且**不发** Access-Control-Allow-Origin，
      这样即使请求发出去了，恶意页面也读不到任何响应内容。
    """
    if not origin:
        return []
    if origin in ALLOWED_ORIGINS:
        return [
            ('Access-Control-Allow-Origin', origin),
            ('Vary', 'Origin'),
            ('Access-Control-Allow-Methods', 'GET, POST, OPTIONS'),
            ('Access-Control-Allow-Headers', 'Content-Type, X-Filename, X-JH-Token'),
            # file:// 页面访问 127.0.0.1 属于「本地网络请求」，Chrome 会做一次 PNA 预检
            ('Access-Control-Allow-Private-Network', 'true'),
            ('Access-Control-Max-Age', '600'),
        ]
    return None


def token_hint():
    port = CURRENT_PORT or PORT_CANDIDATES[0]
    return ('缺少访问令牌：采集接口只能用「采集器自己打开的页面」调用。'
            '请双击「启动采集器」，在自动打开的页面（http://127.0.0.1:%d/）里操作。'
            '如果你是从本地文件（file://）或别的网页点进来的，那边拿不到令牌。' % port)


class Handler(BaseHTTPRequestHandler):
    server_version = 'JobHunterCollector/' + VERSION
    protocol_version = 'HTTP/1.1'

    def log_message(self, fmt, *args):                         # 静音访问日志（太吵）
        pass

    # ---- 响应助手 ----
    def _send(self, code, body, ctype='application/json; charset=utf-8', cors=True):
        # body 允许三种形态：str / bytes / 任意可 JSON 化的对象（dict/list/...）。
        # ⚠️ 曾经这里只对 str 编码，_guard() 传的是 dict → 直接落到 wfile.write(dict)
        #    抛 TypeError，而 Content-Length 又写成 len(dict)=2（键的个数）→
        #    403 响应体被截断成 2 字节（"HT"），前端永远拿不到 needToken 字段。
        #    所以这里必须和 _json() 走同一个入口，别再让人直接传 dict。
        if not isinstance(body, (str, bytes, bytearray)):
            body = json.dumps(body, ensure_ascii=False)
        if isinstance(body, str):
            body = body.encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', ctype)
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-store')
        if cors:
            hdrs = cors_headers_for(self.headers.get('Origin'))
            if hdrs:                                           # None = 不在白名单，不回 CORS 头
                for k, v in hdrs:
                    self.send_header(k, v)
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionAbortedError, ConnectionResetError):
            pass

    def _guard(self):
        """Origin 白名单 + 访问令牌。放行返回 True，已拒绝返回 False。"""
        origin = self.headers.get('Origin')
        if origin and origin not in ALLOWED_ORIGINS:
            self._send(403, {'ok': False, 'error':
                             '拒绝访问：请求来源 %s 不在白名单内（只允许本机采集器页面）。' % origin})
            return False
        tok = self.headers.get('X-JH-Token')
        if not tok:
            tok = (parse_qs(urlparse(self.path).query).get('k') or [''])[0]
        if not hmac.compare_digest((tok or '').encode('utf-8'), TOKEN.encode('utf-8')):
            self._send(403, {'ok': False, 'error': token_hint(), 'needToken': True})
            return False
        return True

    def _is_same_origin(self):
        """这个请求是不是「本服务自己」发起的？

        不带 Origin（浏览器直接导航 / curl）→ 是；Origin 命中白名单 → 是；
        其余（`Origin: null`、别的站）→ 不是。静态页据此决定要不要注入令牌。
        """
        origin = self.headers.get('Origin')
        return (not origin) or (origin in ALLOWED_ORIGINS)

    def _json(self, data, code=200):
        self._send(code, json.dumps(data, ensure_ascii=False))

    def _read_body(self, limit=None):
        """读请求体。**先校验长度，再读** —— 顺序不能反。

        ⛔ 曾经是「先 rfile.read(length) 再在上层判 20MB」，等于没判：
           ① Content-Length 可以伪造任意大（不校验就按它分配内存 / 阻塞读）；
           ② 负数会让 rfile.read(-1) 变成「读到 EOF」，keep-alive 连接下永不返回，
              线程被永久挂住（客户端只要发一个 Content-Length: -1 就能拖垮服务）。
        所以这里把长度校验前置，非法一律 4xx 拒绝并返回空，让上层走「没数据」分支。

        limit 默认 MAX_BODY_BYTES；简历上传传 20MB（见 _upload_resume）。
        """
        if limit is None:
            limit = MAX_BODY_BYTES
        raw = self.headers.get('Content-Length')
        try:
            length = int(raw or 0)
        except (TypeError, ValueError):
            self._send(400, {'ok': False, 'error': 'Content-Length 不是合法整数。'})
            return b''
        if length <= 0:
            return b''
        if length > limit:
            self._send(413, {'ok': False, 'error':
                             '请求体太大（%d 字节，上限 %d 字节）。' % (length, limit)})
            return b''
        return self.rfile.read(length)

    def _read_json_body(self):
        try:
            return json.loads(self._read_body() or b'{}')
        except ValueError:
            return {}

    # ---- 预检 ----
    def do_OPTIONS(self):
        origin = self.headers.get('Origin')
        hdrs = cors_headers_for(origin)
        if hdrs is None:                                       # 不在白名单 → 预检直接失败
            return self._send(403, {'ok': False, 'error': '预检被拒绝：来源不在白名单。'})
        self.send_response(204)
        for k, v in hdrs:
            self.send_header(k, v)
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ---- GET ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path
        query = parse_qs(parsed.query)
        try:
            # 存活探测：无需 token、不含敏感信息。给启动脚本判断「是否已在运行」用。
            if path == '/api/alive':
                return self._json(build_alive())

            if path.startswith('/api/'):
                if not self._guard():
                    return
            if path == '/api/ping':
                return self._json(build_ping())

            if path == '/api/task':
                since = int((query.get('since') or ['0'])[0] or 0)
                with CURRENT_LOCK:
                    task = CURRENT
                if task is None:
                    return self._json({'ok': True, 'task': None})
                snap = task.snapshot(since)
                snap['ok'] = True
                return self._json({'ok': True, 'task': snap})

            if path == '/api/jobs':
                return self._json(dict(ok=True, **load_jobs(run_dir())))

            if path == '/api/history':
                return self._json({'ok': True, 'items': list_history()})

            if path == '/api/resumes':
                return self._json({'ok': True, 'files': list_resumes()})

            # 静态：工作台本体（同源模式）
            return self._serve_static(path)
        except Exception:                                      # noqa: BLE001
            log('GET %s 出错\n%s' % (path, traceback.format_exc()))
            self._json({'ok': False, 'error': traceback.format_exc()}, 500)

    # ---- POST ----
    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path
        try:
            if path.startswith('/api/') and not self._guard():
                return
            if path == '/api/resume':
                return self._upload_resume()
            if path == '/api/extract-text':
                return self._extract_text()
            if path == '/api/login':
                return self._login()
            if path == '/api/crawl':
                return self._crawl(self._read_json_body())
            if path == '/api/estimate':
                return self._json({'ok': True,
                                   'estimate': estimate_crawl(self._read_json_body())})
            if path == '/api/match':
                return self._match(self._read_json_body() or {})
            if path == '/api/match/estimate':
                return self._json({'ok': True,
                                   'estimate': estimate_match(self._read_json_body() or {})})
            if path == '/api/stop':
                return self._json(stop_task())
            if path == '/api/greet-conf':
                return self._set_greet_conf(self._read_json_body() or {})
            if path == '/api/apply-one':
                return self._apply_one(self._read_json_body() or {})
            if path == '/api/sync-reply':
                return self._sync_reply(self._read_json_body() or {})
            if path == '/api/pause':
                return self._json(pause_task())
            if path == '/api/continue':
                return self._json(resume_task())
            if path == '/api/results/clear':
                return self._json(clear_results())
            if path == '/api/resume/delete':
                return self._json(delete_resume((self._read_json_body() or {}).get('name')))
            return self._send(404, '未找到', 'text/plain; charset=utf-8')
        except Exception:                                      # noqa: BLE001
            log('POST %s 出错\n%s' % (path, traceback.format_exc()))
            self._json({'ok': False, 'error': traceback.format_exc()}, 500)

    # ---- 静态文件 ----
    def _serve_static(self, path):
        # urlparse 给的是**未解码**的路径 —— 中文文件名（如 /使用说明.md）
        # 到这里还是一串 %E4%BD%BF… ，不 unquote 就一定 404。
        path = unquote(path)
        if path in ('/', ''):
            rel = 'index.html'
        else:
            rel = path.lstrip('/')
        # 目录穿越防护：解析后必须仍在 ROOT 之内
        target = os.path.normpath(os.path.join(ROOT, rel))
        root = os.path.normpath(ROOT)
        if target != root and not target.startswith(root + os.sep):
            return self._send(403, '越界了', 'text/plain; charset=utf-8')
        if os.path.isdir(target):
            target = os.path.join(target, 'index.html')
        ext = os.path.splitext(target)[1].lower()
        if ext not in STATIC_EXT:
            return self._send(404, '不提供这类文件', 'text/plain; charset=utf-8')
        # 拒绝伺服「下划线开头」的开发产物（评审 P2-8）：项目根目录混着 _测试_核心.js、
        # _回退自证.js、_扫描_缺失样式.js 这类测试/工具脚本，它们因为 .js 后缀本会被
        # STATIC_EXT 放行、成为可直读的静态资源（暴露测试实现细节、还可能被当入口）。
        # ⚠️ 这条只挡 `_xxx`，挡不住 `.impeccable.md` 这类点开头的文件 —— 真正的兜底是
        #    下面的 STATIC_FILES / STATIC_DIRS 白名单（评审核实 2026-10-30，P0）。
        basename = os.path.basename(target)
        if basename.startswith(('_', '.')):
            return self._send(404, '文件不存在', 'text/plain; charset=utf-8')
        # ⛔ 只伺服工作台本体：根目录白名单文件 + js/ css/ 两个目录。
        #   这条**必须**在读取文件之前 —— 之前 .json/.md 都在 STATIC_EXT 里，
        #   而静态路径不过 _guard()，等于把「全量岗位数据 + 登录态 + 内部文档」匿名公开。
        rel_inside = os.path.relpath(target, root).replace('\\', '/')
        top = rel_inside.split('/')[0]
        if rel_inside not in STATIC_FILES and top not in STATIC_DIRS:
            return self._send(404, '文件不存在: %s' % rel, 'text/plain; charset=utf-8')
        if not os.path.exists(target):
            return self._send(404, '文件不存在: %s' % rel, 'text/plain; charset=utf-8')
        with open(target, 'rb') as f:
            data = f.read()
        # ⛔ 令牌**只注入给同源页面**（评审核实 2026-10-12，P0 的第二道闸）。
        #   跨源请求即使拿到了 HTML 也读不到内容（没 ACAO 头，浏览器不给读），
        #   但那时 HTML 里的令牌**已经先泄出去**了 —— 所以干脆不发。
        #   只有「不带 Origin」（用户直接开 http://127.0.0.1:端口/）或 Origin 命中白名单时才注入。
        if ext in ('.html', '.htm') and self._is_same_origin():
            data = inject_token(data)
        self._send(200, data, STATIC_EXT[ext])

    # ---- 上传简历 ----
    def _upload_resume(self):
        """简历以**原始字节**收，文件名放在 X-Filename 头里（base64）。

        为什么不用 multipart：Python 3.13 已经把 cgi 模块删了，为了一个上传
        去手写 multipart 解析不划算。前端 FileReader 读成 ArrayBuffer 直接 POST
        body 就行，头部带个文件名，够用。
        """
        import base64
        # 简历/文档可能是 PDF/Word，放宽到 20MB；上限在 _read_body 里**前置**校验，
        # 不再事后判（事后判等于没判：长度非法时 rfile.read 已经先把线程挂住了）。
        raw = self._read_body(limit=20 * 1024 * 1024)
        if not raw:
            return self._json({'ok': False, 'error': '文件是空的（或超过 20MB 上限）。'})

        try:
            name = base64.b64decode(self.headers.get('X-Filename') or '').decode('utf-8')
        except Exception:                                      # noqa: BLE001
            name = ''
        name = os.path.basename(name or 'resume.pdf')
        name = re.sub(r'[<>:"/\\|?*]', '_', name)              # Windows 文件名净化
        if not name:
            name = 'resume.pdf'

        # 先查并发（评审 P2-5）：以前文件先落盘、再起解析任务，若已有任务在跑
        # start_task 返回 ok:False、前端提示「上传失败」，但文件已经写进 data/resume/ 了。
        # 先拦并发，别让「任务没起来、简历原件却已落盘」。
        with CURRENT_LOCK:
            if CURRENT is not None and CURRENT.running:
                return self._json({'ok': False,
                                   'error': '已有任务在跑（%s），等它结束再上传简历。' % CURRENT.title})

        dest = os.path.join(RESUME_DIR, name)
        with open(dest, 'wb') as f:
            f.write(raw)
        log('resume uploaded: %s (%d bytes)' % (dest, len(raw)))

        return self._json(dict(start_task('parse', '解析简历', build_cmd_parse(dest)),
                               file=dest, size=len(raw)))

    # ---- 只抽文字（简历素材库「上传 PDF / Word」）----
    def _extract_text(self):
        """收原始字节 + X-Filename 头（和 _upload_resume 同一套约定），
        **只返回文字**，不落 resume 目录、不起任务、不碰采集链路的状态。

        素材库是纯前端（数据在 localStorage），它只需要这段文字；
        走 /api/resume 会把简历塞进采集链路并起一个解析任务，那是另一件事。
        """
        import base64
        # 简历/文档可能是 PDF/Word，放宽到 20MB；上限在 _read_body 里**前置**校验，
        # 不再事后判（事后判等于没判：长度非法时 rfile.read 已经先把线程挂住了）。
        raw = self._read_body(limit=20 * 1024 * 1024)
        if not raw:
            return self._json({'ok': False, 'error': '文件是空的（或超过 20MB 上限）。'})

        try:
            name = base64.b64decode(self.headers.get('X-Filename') or '').decode('utf-8')
        except Exception:                                      # noqa: BLE001
            name = ''
        name = os.path.basename(name or 'resume.txt')
        name = re.sub(r'[<>:"/\\|?*]', '_', name)              # Windows 文件名净化
        if not name:
            name = 'resume.txt'

        return self._json(extract_text(raw, name))

    # ---- 登录 ----
    def _login(self):
        return self._json(start_task('login', '登录检测', build_cmd_login()))

    # ---- 采集 ----
    def _set_greet_conf(self, payload):
        """前端把「一键打招呼」的开关/间隔/冷却/单日上限同步到服务端落盘。

        为什么要走服务端存一份（评审 P1-5）：闸门要能自己读到开关，否则
        「服务端独立再查一遍」只是注释里的空话 —— 那套配置本来只活在
        localStorage 里，服务端读不到。⚠️ 只收白名单字段，别把整包 settings 存进来
        （里面还有模型 Key，落盘到 data/ 是多余的暴露面）。
        """
        p = payload or {}
        try:
            daily = int(_num_or(p.get('dailyCap'), 20))
        except (TypeError, ValueError):
            daily = 20
        conf = {
            'autoGreet': bool(p.get('autoGreet')),
            'intervalSec': _num_or(p.get('intervalSec'), 20),
            'cooldownH': _num_or(p.get('cooldownH'), 24),
            'dailyCap': daily if daily > 0 else 20,
            'syncedAt': time.time(),
        }
        try:
            write_json(GREET_CONF_PATH, conf)
        except OSError as exc:
            return self._json({'ok': False, 'error': '写配置失败：%s' % exc})
        return self._json({'ok': True, 'conf': conf})

    def _apply_one(self, payload):
        """单岗位「一键打招呼」。

        ⚠️ 这是**全项目唯一会代替用户对外发出动作**的接口，所以：
          · 闸门在服务端**独立再查一遍**（前端那遍只是省一次开浏览器，挡不住伪造请求）
          · 起一个真实任务（复用任务卡/暂停/停止那条链），然后**等它跑完**再返回，
            这样调用方能拿到确定的结果去写时间线，而不是"起了个任务，结果自己去猜"
          · 超时不会杀进程 —— 它还在任务卡里跑着，用户可以自己暂停/停止，
            我们只是如实告诉调用方"还在跑"
        """
        ok, why = _greet_gate(payload)
        if not ok:
            return self._json({'ok': False, 'error': why})

        with CURRENT_LOCK:
            if CURRENT is not None and CURRENT.running:
                return self._json({'ok': False,
                                   'error': '已有任务在跑（%s），等它结束或先点「停止」。' % CURRENT.title})

        title = payload.get('company') or payload.get('title') or '岗位'
        res = start_task('apply-one', '一键打招呼 · %s' % title,
                         build_cmd_apply_one(payload),
                         env_extra=browser_mode_env(payload))
        if not res.get('ok'):
            return self._json(res)

        with CURRENT_LOCK:
            task = CURRENT
        if task is None:                                     # 理论上不会发生
            return self._json({'ok': False, 'error': '任务没能建立。'})

        finished = _wait_task(task, APPLY_WAIT_SEC)
        if not finished:
            return self._json({
                'ok': False, 'running': True,
                'error': '还在跑（超过 %d 秒没结束）—— 到采集页的任务卡里看进度，'
                         '要停就点「停止」。' % APPLY_WAIT_SEC,
            })

        code = task.exit_code
        # 退出码语义由 boss_apply_one.py 定义：0 发出 / 2 闸门没过(什么都没发) / 3 发了但失败
        if code == 0:
            # ⛔ 只有真发出去了才进台账（评审 P1-5）—— 限流计数必须长在服务端，
            #    否则一个伪造请求就能把前端的计时器全部绕过去。
            at = greet_record(payload.get('jobId'), payload.get('url'))
            return self._json({'ok': True, 'exitCode': code, 'greetAt': at})
        if code == 2:
            return self._json({'ok': False, 'exitCode': code, 'sentNothing': True,
                               'error': '前置检查没过，**什么都没发**（别重试，先看日志）。'})
        return self._json({'ok': False, 'exitCode': code,
                           'error': '没发出去（退出码 %s）—— 请到任务卡看日志里的具体原因。' % code})

    def _sync_reply(self, payload):
        """读一次 BOSS 聊天列表，把会话候选返回给前端**由用户逐条确认**。

        ⚠️ 这个接口**只读、只回候选、不写任何数据**。写进投递/面试是前端在用户
           点「确认写入」之后、由 apply-boss.js 的 applySyncPlan 完成的。
           这样设计的原因：会话和岗位的对应关系靠名字匹配、一定会有认错的时候，
           而认错的结果是污染投递统计和面试安排 —— 那是用户复盘求职的全部依据。
        """
        if not skill_ready():
            return self._json({'ok': False, 'error': '找不到 boss-crawler 或它的虚拟环境。'})
        if not login_fresh():
            return self._json({'ok': False, 'needLogin': True,
                               'error': 'BOSS 登录态不新鲜（或没检测过）—— 先点「登录检测」扫码。'})
        if not os.path.isfile(CHAT_SYNC_SCRIPT):
            return self._json({'ok': False, 'error': '读聊天脚本缺失（%s）。' % CHAT_SYNC_SCRIPT})

        with CURRENT_LOCK:
            if CURRENT is not None and CURRENT.running:
                return self._json({'ok': False,
                                   'error': '已有任务在跑（%s），等它结束再同步。' % CURRENT.title})

        res = start_task('sync-reply', '同步 BOSS 回复', build_cmd_chat_sync(payload),
                         env_extra=browser_mode_env(payload))
        if not res.get('ok'):
            return self._json(res)

        with CURRENT_LOCK:
            task = CURRENT
        if task is None:
            return self._json({'ok': False, 'error': '任务没能建立。'})

        if not _wait_task(task, APPLY_WAIT_SEC):
            return self._json({'ok': False, 'running': True,
                               'error': '同步还没跑完（超过 %d 秒）。' % APPLY_WAIT_SEC})

        lines = list(getattr(task, 'lines', []) or [])
        # 脚本把结果打成 `__CHAT_JSON__ {json}` 单独一行；从**后往前**找，取最后一次
        payload_out = None
        for ln in reversed(lines):
            idx = ln.find('__CHAT_JSON__')
            if idx >= 0:
                try:
                    payload_out = json.loads(ln[idx + len('__CHAT_JSON__'):].strip())
                except ValueError:
                    payload_out = None
                break

        if payload_out is None:
            return self._json({
                'ok': False,
                'error': '同步脚本没吐结果（退出码 %s）—— 到采集页任务卡看日志。'
                         % (task.exit_code,),
            })
        if not payload_out.get('ok'):
            # 脚本自己判定的失败（最常见：页面结构没匹配上，需要 --dump 校准）
            return self._json(payload_out)

        payload_out['exitCode'] = task.exit_code
        return self._json(payload_out)

    def _crawl(self, payload):
        if not skill_ready():
            return self._json({'ok': False, 'error':
                               '找不到 boss-crawler 或它的虚拟环境，采集链路不可用。'})
        if not run_dir() or not profile_summary():
            return self._json({'ok': False, 'error':
                               '还没有简历画像（profile.json）。请先上传简历，'
                               '或在「求职/工作台」里跑一次简历识别。'})
        if not (payload.get('keywords')):
            return self._json({'ok': False, 'error': '至少给一个搜索关键词。'})
        # 登录态预检（P0-3）：server.log 实证「10 次采集 3 次手动中断」，
        # 很大一部分是扫的码过期了，任务照样起，跑十几分钟才在翻页时炸。
        # 这里放在 ensure_dicts() 之前 —— 那个会联网拉词典，先拦住就不用白联网。
        if not login_fresh():
            val = LOGIN_STATE.get('value')
            if val == 'needed':
                why = 'BOSS 登录已过期'
            elif not val:
                why = '还没检测过 BOSS 登录态'
            else:
                why = '上次登录检测已超过 %d 分钟，多半已失效' % (LOGIN_TTL // 60)
            return self._json({
                'ok': False, 'needLogin': True,
                'error': why + ' —— 先点「登录检测」，在弹出的 Edge 里扫码，'
                               '再开始采集（否则会白跑十几分钟）。',
            })
        # 两份静态词典缺了的话，boss-crawler 一启动就报「岗位数据加载失败」，
        # 而它自己的抓取路径会被风控挡下。这里先补齐再开跑，别让任务白启动。
        ok, detail = ensure_dicts()
        if not ok:
            return self._json({'ok': False, 'error':
                               '采集所需的 BOSS 词典缺了，且自动补齐失败：'
                               + '；'.join(detail)
                               + '。检查一下网络后重试。'})
        # 先查并发（评审 P1-3.2）：new_run_dir() 会推进 LATEST.txt 指针 + 建目录，
        # 若先建目录再发现「已有任务在跑」，指针已经指到一个空目录 → 正在跑的那轮
        # round_links 落到别处、「只看本次新增」消失、运行目录错位。所以必须先确认
        # 没任务在跑，再动指针。start_task 内部仍有一道同锁的检查兜底。
        with CURRENT_LOCK:
            if CURRENT is not None and CURRENT.running:
                return self._json({'ok': False,
                                   'error': '已有任务在跑（%s），等它结束或先点「停止」。' % CURRENT.title})
        # 每次采集都落到一个全新目录（用户选「每次全新开始」），
        # 不再复用 LATEST.txt 指向的旧目录 —— 否则结果会被旧数据挡住。
        # ⛔ 必须校验返回值：new_run_dir 拿不到目录时（磁盘满 / 无权限 / 指针写不进去）
        #    会抛异常。这里包一层是为了把它变成**一句人话**，而不是让用户
        #    在采集页看到一段 Python 堆栈 —— 更要紧的是：绝不能让它退化成
        #    「用旧目录接着跑」，那会让这轮结果静默落在上一轮里（评审复核发现）。
        try:
            rd = new_run_dir()
        except OSError as exc:
            return self._json({'ok': False, 'error':
                               '建不了本轮运行目录（%s）。多半是磁盘空间不足或目录无写权限；'
                               '采集没有启动。' % exc})
        if not rd or not os.path.isdir(os.path.join(rd, 'state')):
            return self._json({'ok': False, 'error':
                               '本轮运行目录没建成功（%s），采集没有启动 —— '
                               '否则结果会写进上一轮的目录里、让你看不见。' % (rd or '空路径')})
        res = start_task('crawl', '采集岗位', build_cmd_crawl(payload, rd))
        # 顺手把预估带上（P2-2）：前端不用多发一次请求就能把「大概要等多久」写进任务卡。
        if isinstance(res, dict):
            res['estimate'] = estimate_crawl(payload)
        return self._json(res)

    def _match(self, payload):
        """简历匹配（--from match）—— 对当前运行目录里已爬好的岗位做初筛/二筛。

        不新建运行目录：匹配的是「已采集的岗位」，复用 LATEST.txt 指着的目录，
        否则会对着空目录匹配、什么分都拿不到。
        """
        if not skill_ready():
            return self._json({'ok': False, 'error':
                               '找不到 boss-crawler 或它的虚拟环境，匹配链路不可用。'})
        rd = run_dir()
        if not rd or not profile_summary():
            return self._json({'ok': False, 'error':
                               '还没有简历画像（profile.json）。请先上传简历。'})
        if _job_pool_rows() == 0:
            return self._json({'ok': False, 'error':
                               '还没有可匹配的岗位（post_data 里没有 CSV）。先跑一次采集。'})

        mode = (payload or {}).get('matchMode') or 'deep'
        if mode not in ('quick', 'deep'):
            return self._json({'ok': False, 'error': 'matchMode 只能是 quick 或 deep。'})
        if mode == 'deep' and not llm_ready():
            return self._json({'ok': False, 'needLLM': True, 'error':
                               '还没配好模型 API（llm_config.json 缺 key）。'
                               '二筛要逐岗调模型，先去「设置 → AI」配好；'
                               '只想先做零成本的规则初筛，切到「初筛（规则）」再跑。'})

        # 先查并发再起任务（与 _crawl 同一套锁）。匹配不写 LATEST 指针、不动运行目录，
        # 所以没有「先建目录才发现有任务在跑」的错位风险，但仍要独占任务卡。
        with CURRENT_LOCK:
            if CURRENT is not None and CURRENT.running:
                return self._json({'ok': False,
                                   'error': '已有任务在跑（%s），等它结束或先点「停止」。' % CURRENT.title})

        title = '简历匹配 · 二筛 AI' if mode == 'deep' else '简历匹配 · 初筛规则'
        res = start_task('match', title, build_cmd_match(payload, rd))
        if isinstance(res, dict) and res.get('ok'):
            res['estimate'] = estimate_match(payload)
        return self._json(res)


# ==================== 端口与启动 ====================

def port_busy(port):
    """端口是否已被占用 —— 用 connect() 试连判断。

    ⚠️ 不能像以前那样「bind + SO_REUSEADDR 成功就算空闲」：
      Windows 上 SO_REUSEADDR 的语义不是「复用 TIME_WAIT」，而是
      **允许抢占一个正在被监听的端口**。于是 bind 永远成功，pick_port
      根本挪不动 → 两个服务挤在同一端口，后起的那个是**沉默僵尸**
      （进程活着、端口占着、页面打不开、用户完全看不见）。
    换成 connect 试连：连得上 = 真有人监听 = 这个端口不能用。
    """
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.settimeout(0.3)
        return s.connect_ex(('127.0.0.1', port)) == 0


def pick_port():
    for port in PORT_CANDIDATES:
        if not port_busy(port):
            return port
    return None


class CollectorHTTPServer(ThreadingHTTPServer):
    """allow_reuse_address 默认是 1（http.server 的祖传默认）。

    在 Windows 上那等于「端口被占也能绑上」→ 会悄悄变成第二个僵尸监听。
    这里关掉：端口真被占就 bind 失败，我们换下一个端口，
    让 main() 里「端口都被占用」那条分支真正能被走到（以前它等于死代码）。
    """
    allow_reuse_address = False
    daemon_threads = True


def make_server():
    """在 PORT_CANDIDATES 里找第一个能**真正绑上**的端口，返回 (httpd, port)。

    先 connect 探一次（拿到好一点的错误现场），再真 bind；两者都可能失败，
    失败就试下一个。全部失败返回 (None, None)。
    """
    for port in PORT_CANDIDATES:
        if port_busy(port):
            continue
        try:
            return CollectorHTTPServer(('127.0.0.1', port), Handler), port
        except OSError:
            continue
    return None, None


BANNER = r"""
  ┌──────────────────────────────────────────────────────────┐
  │   求职猎手工作台 · 本地采集器                             │
  └──────────────────────────────────────────────────────────┘

  浏览器地址： http://127.0.0.1:{port}/

  · 采集时会弹出一个真实的 Edge 窗口，请在里面扫码登录 BOSS。
  · 登录后采集脚本会打开岗位列表页与详情页，**调用页面自身的数据接口**
    读取岗位信息。这比手动翻页更密集、更容易触发风控（工具已限速+冷却，
    但不保证不触发）。不发消息、不投递。
  · 关闭这个黑窗口 = 停止服务（采集也会中断）。

"""


def _runtime_files_are_mine():
    """盘上那几个运行文件还是**本实例**写的吗？（评审 P1-3）

    判据按可靠性排序：
      ① status.json 里的 `instance` == INSTANCE_ID → 一定是自己写的；
      ② 否则看 collector.pid 的内容是不是自己的进程号 —— 老版本写的 status
         没有 instance 字段，但 pid 文件是同一次启动写的，能兜住；
      ③ 两个都对不上 → 不是自己的，**一律不动**。

    ⛔ 为什么默认「不动」：删错方向的代价不对称。不删最多留一个陈旧文件
       （启动脚本本来就要用 /api/alive 实探），删错却会把**正在运行**实例的
       pid/port 抹掉，停止脚本随即失效（这正是评审实测到的现场）。
    """
    try:
        st = read_json(STATUS_PATH, None)
    except Exception:                                          # noqa: BLE001
        st = None
    if isinstance(st, dict) and st.get('instance') == INSTANCE_ID:
        return True
    try:
        with open(PID_PATH, 'r', encoding='utf-8') as f:
            return (f.read() or '').strip() == str(ROOT_PID or os.getpid())
    except Exception:                                          # noqa: BLE001
        return False


def cleanup_runtime_files():
    """正常退出时抹掉「我正在跑」的痕迹。硬杀（任务管理器）不会走到这里，
    所以启动脚本不能只信文件，还要用 /api/alive 实探一次。

    ⛔ 必须先验归属（评审 P1-3）：这三个文件是多个实例共用的固定路径，
       无条件删 = 短命实例退出时把正在运行实例的痕迹一起删掉。
    """
    if not _runtime_files_are_mine():
        log('cleanup skipped: runtime files belong to another instance (not %s)' % INSTANCE_ID)
        return
    for p in (PORT_PATH, PID_PATH):
        try:
            if os.path.exists(p):
                os.remove(p)
        except OSError:
            pass
    # status.json 不删（启动脚本/用户要读它看「上次为什么没起来」），
    # 但改成 ok=False 并在日志里留痕，避免下次启动前它一直显示"成功"。
    try:
        prev = read_json(STATUS_PATH, None) or {}
        prev['ok'] = False
        prev['stoppedAt'] = time.time()
        prev.pop('instance', None)          # 摘掉归属标记 = 这份快照已作废
        write_json(STATUS_PATH, prev)
    except Exception:                                          # noqa: BLE001
        pass


def _windows_process_table():
    """用 Toolhelp 快照取 {pid: (ppid, 小写 exe 名)}。仅 Windows 可用。"""
    import ctypes
    from ctypes import wintypes

    TH32CS_SNAPPROCESS = 0x00000002
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ('dwSize', wintypes.DWORD),
            ('cntUsage', wintypes.DWORD),
            ('th32ProcessID', wintypes.DWORD),
            ('th32DefaultHeapID', ctypes.c_void_p),
            ('th32ModuleID', wintypes.DWORD),
            ('cntThreads', wintypes.DWORD),
            ('th32ParentProcessID', wintypes.DWORD),
            ('pcPriClassBase', ctypes.c_long),
            ('dwFlags', wintypes.DWORD),
            ('szExeFile', ctypes.c_char * 260),
        ]

    k32 = ctypes.windll.kernel32
    snap = k32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if not snap or snap == INVALID_HANDLE_VALUE:
        raise OSError('CreateToolhelp32Snapshot 失败')
    table = {}
    try:
        entry = PROCESSENTRY32()
        entry.dwSize = ctypes.sizeof(PROCESSENTRY32)
        ok = k32.Process32First(snap, ctypes.byref(entry))
        while ok:
            table[int(entry.th32ProcessID)] = (
                int(entry.th32ParentProcessID),
                entry.szExeFile.decode('mbcs', 'replace').lower(),
            )
            ok = k32.Process32Next(snap, ctypes.byref(entry))
    finally:
        k32.CloseHandle(snap)
    return table


def _windows_process_tree(root):
    """root 及其所有子孙进程号（含 root 自己）。用 Toolhelp 表按父子关系 BFS。

    采集任务的进程树形如：pipeline.py(根) → Edge 主进程 → Edge 的 gpu/renderer/…
    暂停要连 Edge 一起冻住（否则页面还在跑定时器、连接还开着），所以必须整棵树。
    任何异常都退回 [root] —— 至少把任务主进程挂上，绝不因探测失败而不暂停。
    """
    try:
        table = _windows_process_table()
    except Exception:                                          # noqa: BLE001
        return [int(root)]
    children = {}
    for pid, (ppid, _exe) in table.items():
        children.setdefault(ppid, []).append(pid)
    out, stack, seen = [], [int(root)], set()
    while stack:
        p = stack.pop()
        if p in seen:
            continue
        seen.add(p)
        out.append(p)
        stack.extend(children.get(p, []))
    return out


# NtSuspendProcess / NtResumeProcess 需要的进程访问权限位。
_PROCESS_SUSPEND_RESUME = 0x0800


def _nt_suspend_resume(pid, suspend):
    """挂起（suspend=True）/ 恢复一个进程。Windows：ntdll.NtSuspendProcess / NtResumeProcess。

    为什么不用 taskkill / Stop-Process：那俩只能「杀」，**没有「暂停」**。
    NtSuspendProcess 会挂起目标进程的**全部线程** —— CPU 归零、内存 / 连接 / 页面
    状态原地保留，NtResumeProcess 再原样放回去。这正是「一键冻结」要的语义，
    而且**零侵入**采集内核（不必在 crawler 里插暂停钩子）。

    返回 True/False；进程已退出、权限不足、非 Windows 等一律返回 False（不抛异常）。
    """
    if os.name != 'nt':
        return False
    import ctypes
    from ctypes import wintypes
    k32 = ctypes.windll.kernel32
    ntdll = ctypes.WinDLL('ntdll')
    k32.OpenProcess.restype = wintypes.HANDLE
    k32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    k32.CloseHandle.argtypes = [wintypes.HANDLE]
    h = k32.OpenProcess(_PROCESS_SUSPEND_RESUME, False, int(pid))
    if not h:
        return False
    try:
        fn = ntdll.NtSuspendProcess if suspend else ntdll.NtResumeProcess
        fn.argtypes = [wintypes.HANDLE]
        fn.restype = ctypes.c_long
        return fn(h) == 0                                      # 0 = STATUS_SUCCESS
    except Exception:                                          # noqa: BLE001
        return False
    finally:
        k32.CloseHandle(h)


def _suspend_tree(root, suspend):
    """对整棵进程树做挂起/恢复，返回 (成功数, 总进程数)。"""
    pids = _windows_process_tree(root)
    if not suspend:
        pids = list(reversed(pids))        # 恢复时先放根、再放子孙，减少半挂状态
    ok = sum(1 for p in pids if _nt_suspend_resume(p, suspend))
    return ok, len(pids)


def pause_task():
    """一键冻结当前采集任务：把整棵进程树（含浏览器）挂起，CPU 归零、状态原地保留。

    这是「暂停」而不是「停止」—— 进程还在，点「继续」就原样接着跑；已采到的东西
    一行不丢（进程内状态都还在）。若不是任务进程在跑则返回说明，不抛异常。
    """
    with CURRENT_LOCK:
        task = CURRENT
        if task is None or not task.running or task.proc is None:
            return {'ok': False, 'error': '当前没有在跑的任务。'}
        if task.paused:
            return {'ok': True, 'paused': True, 'already': True}
        root = task.proc.pid
    ok, total = _suspend_tree(root, True)
    with CURRENT_LOCK:
        if CURRENT is task:
            task.paused = True
    task.append('[采集器] ⏸ 已暂停：%d/%d 个进程已挂起（CPU 归零，点「继续」原样恢复）。'
                % (ok, total))
    log('pause task %s: %d/%d suspended' % (task.key, ok, total))
    return {'ok': True, 'paused': True, 'suspended': ok, 'total': total}


def resume_task():
    """恢复被 pause_task() 挂起的任务：整棵进程树解冻，从原处继续。"""
    with CURRENT_LOCK:
        task = CURRENT
        if task is None or task.proc is None:
            return {'ok': False, 'error': '当前没有任务。'}
        if not task.paused:
            return {'ok': True, 'paused': False, 'already': True}
        root = task.proc.pid
    ok, total = _suspend_tree(root, False)
    with CURRENT_LOCK:
        if CURRENT is task:
            task.paused = False
    task.append('[采集器] ▶ 已继续：%d/%d 个进程已恢复。' % (ok, total))
    log('resume task %s: %d/%d resumed' % (task.key, ok, total))
    return {'ok': True, 'paused': False, 'resumed': ok, 'total': total}


def root_pid():
    """本服务所在「python 进程树」的最上层进程号。

    为什么必须写根、不能写 os.getpid()：
      Windows 上 venv 的 `Scripts\\python.exe` 是个**转发器 shim**，它会再起一个
      真实解释器 → 「一个服务 = 两个 python 进程」：
           shim(父) ──▶ 真解释器(子，真正 listen 端口的那个)
      os.getpid() 拿到的是**子**。停止脚本若只 `Stop-Process -Id <子>`（不带 /T），
      父 shim 永远留下；而且子死后 shim 变孤儿，下一轮探活/清理都被它干扰
      （现场实测：collector.pid 只等于子，父 5972 一直挂着）。
      写**根**，停止时 `taskkill /F /T /PID <根>` 才能把整棵子树一起收掉。

    做法：取进程表，从自己往上爬，只要直接父进程还是 python* 就继续。
    任何异常都退回 os.getpid()，绝不因为探测失败而写不出 PID 文件。
    """
    me = os.getpid()
    try:
        table = _windows_process_table()
    except Exception:                                          # noqa: BLE001
        return me
    cur = me
    for _ in range(16):                                        # 防御：链异常时不死循环
        ppid = table.get(cur, (0, ''))[0]
        if not ppid or ppid == cur:
            break
        parent = table.get(ppid)
        if not parent or not parent[1].startswith('python'):
            break
        cur = ppid
    return cur


def main():
    global CURRENT_PORT, ROOT_PID

    meta_load()

    # 启动时清一遍任务日志（评审 3.1）：一份失控日志曾经涨到 404.7MB，
    # 而当时没有任何代码负责清理。放在这里而不是「每次采集前」——
    # 采集前做磁盘 IO 会拖慢开跑，启动时做一次就够了。
    try:
        pruned = prune_task_logs()
        if pruned.get('trimmed') or pruned.get('removed'):
            print('  已清理历史任务日志：截断 %d 份、删除 %d 份'
                  % (pruned['trimmed'], pruned['removed']), flush=True)
    except Exception:                                          # noqa: BLE001
        log('prune_task_logs failed:\n%s' % traceback.format_exc())

    httpd, port = make_server()
    if httpd is None:
        print('\n  [错误] 端口 %s 都被占用了。' % PORT_CANDIDATES, flush=True)
        print('  先关掉其它正在跑的采集器 / 工作台，再试一次。\n', flush=True)
        write_status(False, error='端口 %s 都被占用了' % PORT_CANDIDATES)
        return 1
    CURRENT_PORT = port
    ROOT_PID = root_pid()

    # 端口和上次不一样 → 明确说一句。
    # 端口是「上次用过优先、被占才换下一个」（启动采集器.cmd 会读 collector.port
    # 放进候选列表首位），所以换端口只会发生在"上次那个被别的实例占了"的时候。
    # 用户收藏的是 http://127.0.0.1:<旧端口>/#xxx，换了端口那条书签就是"无法访问"，
    # 而页面上没有任何东西会告诉他新端口在哪（评审 A9）。
    # ⛔ 必须在**覆盖 PORT_PATH 之前**读旧值，否则读到的是刚写的自己。
    _prev_port = None
    try:
        with open(PORT_PATH, 'r', encoding='utf-8') as f:
            _prev_port = int((f.read() or '').strip())
    except Exception:                                          # noqa: BLE001
        _prev_port = None

    # 全程 flush=True：重定向到文件时 stdout 是块缓冲的，
    # 不刷的话启动横幅半天不出现，看着像卡死了。
    print(BANNER.format(port=port), flush=True)
    if _prev_port and _prev_port != port:
        print('  [注意] 上次的端口是 %d，这次换成了 %d。' % (_prev_port, port), flush=True)
        print('         如果你收藏过 http://127.0.0.1:%d/ ，那个书签已经打不开了，'
              '请更新成 http://127.0.0.1:%d/ 。' % (_prev_port, port), flush=True)
        print('         （换端口是因为上次那个端口被别的采集器实例占着。）\n', flush=True)
    if not skill_ready():
        print('  [警告] 没找到采集链路：', flush=True)
        if not os.path.exists(PY):
            print('         虚拟环境缺失 → %s' % PY, flush=True)
        if not os.path.exists(PIPELINE):
            print('         采集脚本缺失 → %s' % PIPELINE, flush=True)
        print('         网页仍可打开，但「采集岗位」会不可用。\n', flush=True)
    else:
        print('  采集链路： %s' % SKILL_DIR, flush=True)
    print('  日志文件： %s\n' % LOG_PATH, flush=True)
    print('  正在启动服务…（这个窗口别关）\n', flush=True)
    log('collector start on port %d, skill_ready=%s' % (port, skill_ready()))

    # 落盘「运行中的证据」：token / 端口 / PID / 状态文件。
    #   · token.txt  —— 让**同机**的测试脚本（_测试_真机.py）能带对令牌；
    #                   恶意网页读不到本机文件，所以不构成新的攻击面。
    #   · port/pid   —— 停止脚本据此精确停，不再靠命令行字符串匹配（改文件夹名就失效）。
    #   · status     —— 启动脚本 / 用户据此看到「成功·失败·端口」。
    try:
        with open(TOKEN_PATH, 'w', encoding='utf-8') as f:
            f.write(TOKEN)
        with open(PORT_PATH, 'w', encoding='utf-8') as f:
            f.write(str(port))
        with open(PID_PATH, 'w', encoding='utf-8') as f:
            # 写**根进程**：Windows 上 venv 的 python.exe 是 shim，会再起真解释器，
            # 一个服务两个进程（详见 root_pid()）。停止脚本按这个 PID
            # `taskkill /F /T` 才能连子树一次收掉，不留孤儿 shim。
            f.write(str(ROOT_PID or os.getpid()))
    except OSError as exc:
        log('写运行文件失败: %s' % exc)
    write_status(True)

    url = 'http://127.0.0.1:%d/' % port
    # --no-open：不自动开浏览器。自测时用，正常运行别加。
    if '--no-open' not in sys.argv:
        threading.Timer(0.8, lambda: webbrowser.open(url)).start()
    else:
        print('  （--no-open：没有自动打开浏览器）\n', flush=True)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print('\n  已停止。\n', flush=True)
    finally:
        httpd.server_close()
        cleanup_runtime_files()
    return 0


if __name__ == '__main__':
    sys.exit(main())
