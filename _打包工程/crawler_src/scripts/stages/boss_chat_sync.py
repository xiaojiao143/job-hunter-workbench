#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""读一次 BOSS 聊天列表 —— 把"有回复 / 有邀约"的会话捞出来，交给用户确认。

⚠️ 关于这份脚本最重要的一句话（请先读完再改它）：
    本仓库**没有** BOSS 聊天页的 DOM 契约。职位列表页的字段是采集链路实测出来的，
    而聊天页的会话卡片结构没有被验证过。所以这里**刻意不写死一堆猜测的选择器** ——
    猜出来的选择器会"跑得很正常、只是永远返回空"，那比直接报错还坏：
    用户会以为"我投了 50 个一个回复都没有"，而实际上是代码根本没读到东西。

    因此本脚本有两档工作模式：

    --dump   校准模式：打开聊天页，把**页面上真实存在**的结构信息落盘
             （每一层的 tag / class / 文本样本 / 元素计数）。这是一次性的，
             用真实页面告诉我"会话卡片长什么样"，然后照着它填 SELECTORS。

    --read   读取模式：按 SELECTORS（或选择器文件）去抓会话。**抓不到就退出码 4
             并明确说"没匹配上，请先跑 --dump 校准"，绝不返回空数组假装"没有新消息"。**
             这两种情况对上层的含义天差地别：一个是"真的没回复"，一个是"我瞎了"。

选择器不写死在代码里、而是可被 `--selectors <json>` 覆盖，
是为了让校准之后改选择器**不用改代码**（也不用怕 skill 重装覆盖）。

用法：
    python scripts/stages/boss_chat_sync.py --dump
    python scripts/stages/boss_chat_sync.py --read
    python scripts/stages/boss_chat_sync.py --read --selectors my_chat_selectors.json
    python scripts/stages/boss_chat_sync.py --read --limit 30

输出（--read 成功时）：stdout 最后一行打印 `__CHAT_JSON__ {json}`，内容形如
    {"ok": true, "items": [{"company": "...", "hr": "...", "lastText": "...",
                            "unread": true, "invited": false, "at": 1696500000000}],
     "raw_count": 12}

退出码：
    0 = 读成功（items 可能为空 —— 那才是真的"没有新消息"）
    2 = 前置不过（没登录 / 缺依赖）
    4 = 页面结构没匹配上（**需要先 --dump 校准**）

邀请判定的口径：本脚本只做**关键词提示**（"面试 / 面谈 / 到岗 / 电话沟通 / 简历通过"），
    标记成 invited=true 供用户参考；**绝不**据此自动建面试记录 —— 那要用户点确认。
"""

import argparse
import json
import os
import re
import sys
import time

_SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SCRIPTS)

CHAT_URL = 'https://www.zhipin.com/web/geek/chat'

# ⚠️ 下面是**候选**选择器，不是实测契约。它们的作用是"如果 BOSS 的类名没大改，大概率能命中"；
#    命中不了就靠 --dump 校准。列表按"越具体越好"排序，取第一个命中的。
SELECTORS = [
    {'item': '.chat-user-list li, .user-list li, [class*="user-list"] li',
     'name': '[class*="name"], .name, .title',
     'msg': '[class*="text"], [class*="msg"], .text',
     'time': '[class*="time"], .time',
     'unread': '[class*="unread"], .badge, [class*="count"]'},
]

# ⛔ 便携版必须认 JH_BOSS_ASSETS（采集组件启动器注入，指向 exe 旁边的 data 目录）。
#    原来写的是 `os.path.join(_SCRIPTS, '..', 'assets', ...)` / `dirname(_SCRIPTS)/assets`
#    —— 在便携版里 _SCRIPTS 是 PyInstaller 的 _internal/scripts，于是落点变成
#    _internal/assets/，而真正的登录态在 exe 旁的 assets/chrome_user_data。
#    后果：每次都以为没登录、弹扫码；dump 也写进临时解包目录、一关就没。
#    （与 resume_matcher/config.py 同一类问题，2026-10-07 一并修。）
_ASSETS_DIR = (os.environ.get('JH_BOSS_ASSETS')
               or os.path.join(os.path.dirname(_SCRIPTS), 'assets'))

DUMP_DIR = os.path.join(_ASSETS_DIR, 'results', '_chat-dump')

INVITE_WORDS = ('面试', '面谈', '到岗', '到面', '电话沟通', '简历通过', '初筛通过', '约个时间', '方便聊聊')


def log(msg=''):
    print(msg, flush=True)


def _emit(obj):
    """结构化输出：单独一行、带哨兵前缀，上层用前缀找它。"""
    log('__CHAT_JSON__ ' + json.dumps(obj, ensure_ascii=False))


def _to_ms(text):
    """把 BOSS 的相对时间（'刚刚' / '3分钟前' / '昨天' / '09-30'）折成毫秒时间戳。

    ⚠️ 折不出来就返回 None —— **不要编一个"现在"上去**。时间字段一旦假了，
       上层「这条回复是新的还是旧的」的判断就全错，而用户看到的是具体日期，
       根本不会怀疑。宁可留空让上层显示"—"。
    """
    s = (text or '').strip()
    if not s:
        return None
    now = time.time() * 1000
    m = re.match(r'^(\d+)\s*(秒|分钟|小时|天)前$', s)
    if m:
        n = int(m.group(1))
        unit = {'秒': 1000, '分钟': 60000, '小时': 3600000, '天': 86400000}[m.group(2)]
        return int(now - n * unit)
    if s in ('刚刚', '刚才'):
        return int(now)
    if s == '昨天':
        return int(now - 86400000)
    m = re.match(r'^(\d{1,2})-(\d{1,2})$', s)          # 09-30 → 今年
    if m:
        try:
            t = time.strptime('%d-%d' % (int(m.group(1)), int(m.group(2))), '%m-%d')
            y = time.localtime().tm_year
            return int(time.mktime((y, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1)) * 1000)
        except ValueError:
            return None
    return None


def _load_selectors(path):
    if not path:
        return SELECTORS
    with open(path, encoding='utf-8') as f:
        data = json.load(f)
    if isinstance(data, dict):
        data = [data]
    if not isinstance(data, list) or not data:
        raise ValueError('选择器文件要是一个对象、或一个非空数组')
    for s in data:
        if 'item' not in s:
            raise ValueError('每条选择器必须有 item 字段')
    return data


# ==================== --read ====================

READ_JS = r"""
(sel) => {
  const out = [];
  const items = document.querySelectorAll(sel.item);
  items.forEach(li => {
    const pick = (s) => {
      if (!s) return '';
      const e = li.querySelector(s);
      return e ? (e.innerText || '').trim() : '';
    };
    const name = pick(sel.name);
    const msg  = pick(sel.msg);
    const time = pick(sel.time);
    // 未读角标：元素存在且文本是数字（BOSS 用数字徽标；空元素不算未读）
    let unread = false;
    if (sel.unread) {
      const u = li.querySelector(sel.unread);
      const t = u ? (u.innerText || '').trim() : '';
      unread = !!t && /^\d+$/.test(t);
    }
    if (name || msg) out.push({ name, msg, time, unread });
  });
  return out;
}
"""

DUMP_JS = r"""
() => {
  // 只 dump「结构」不 dump「内容全文」：会话里可能有利害相关的话，不必整段落盘。
  function walk(node, depth, acc) {
    if (depth > 6 || acc.length > 400) return;
    const kids = node.children ? Array.from(node.children) : [];
    acc.push({
      depth: depth,
      tag: node.tagName ? node.tagName.toLowerCase() : '?',
      cls: (node.className && typeof node.className === 'string') ? node.className : '',
      childCount: kids.length,
      text: (node.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 60)
    });
    kids.slice(0, 30).forEach(k => walk(k, depth + 1, acc));
  }
  const acc = [];
  walk(document.body, 0, acc);
  const cnt = {};
  document.querySelectorAll('*').forEach(e => {
    const c = (e.className && typeof e.className === 'string') ? e.className : '';
    c.split(/\s+/).filter(Boolean).forEach(x => { cnt[x] = (cnt[x] || 0) + 1; });
  });
  const topClasses = Object.entries(cnt)
    .filter(([k, v]) => v >= 3 && v <= 200)
    .sort((a, b) => b[1] - a[1]).slice(0, 60);
  return { url: location.href, title: document.title, tree: acc.slice(0, 300),
           topClasses: topClasses };
}
"""


def _open_page(headless=False):
    """开一个浏览器页面。

    ⚠️ 用 `WebPage` 而不是 `ChromiumPage`：本技能所有已跑通的链路（auto_apply / crawler /
    boss_post_interactive）都用 WebPage，它对中文版 Edge 的探测与接管已经趟过坑。
    ChromiumPage 在 DrissionPage 4.1 里签名是 `(addr_or_opts, tab_id, timeout)`，
    没有 chromium_options 形参 —— 顺手写它就会直接 TypeError（本脚本第一版就栽在这）。
    """
    from DrissionPage import ChromiumOptions, WebPage
    co = ChromiumOptions()
    try:
        from browser_finder import find_chrome_browser
        p = find_chrome_browser()
        if p:
            co.set_browser_path(p)
    except Exception:                                           # noqa: BLE001
        pass
    # 用哪个 profile 由 browser_profile 一处决定（own=工具自己的 / daily=你平时的 Edge）。
    # ⛔ daily 模式下**必须先确认日常 Edge 已彻底退出** —— Edge 在本机常驻后台，
    #    只要实例还在，新进程会把命令行转交给它再自己退出，DrissionPage 连不上调试端口，
    #    表现成「点了没反应」。查到就明确拒绝，不去赌运气。
    from browser_profile import (apply_to_options, check_ready,  # noqa: E402
                                 describe, resolve_mode)
    mode = resolve_mode()
    ok, why, hint = check_ready(mode, _ASSETS_DIR)
    if not ok:
        log('❌ 浏览器用不了：%s' % why)
        if hint:
            log('   %s' % hint)
        # 退出码 3 = 浏览器不可用（2 是登录没过，4 是抓不到结构要校准，别混）
        raise SystemExit(3)
    log('  🌐 浏览器：%s' % describe(mode))
    user_data = apply_to_options(co, mode, _ASSETS_DIR, headless=headless)
    return WebPage(chromium_options=co)


def _ensure_login(dp, max_wait=300):
    """复用技能里那套登录判定（boss_crawler.auth），拿不到就退化为"能打开就算"。"""
    try:
        from boss_crawler.auth import ensure_login          # 不同版本可能叫别的名字
        return ensure_login(dp, max_wait=max_wait)
    except Exception:                                           # noqa: BLE001
        pass
    try:
        from resume_matcher.auto_apply import _ensure_login as _el
        return _el(dp, max_wait=max_wait)
    except Exception:                                           # noqa: BLE001
        pass
    log('  （没找到登录判定函数，跳过登录检查；页面上没登录会读不到东西）')
    return True


def cmd_dump(args):
    log('校准模式：把 BOSS 聊天页的真实结构落盘，用来确认会话卡片的选择器。')
    dp = _open_page(headless=args.headless)
    try:
        log('  打开 %s …' % CHAT_URL)
        dp.get(CHAT_URL)
        time.sleep(6)
        data = dp.run_js(DUMP_JS)
        os.makedirs(DUMP_DIR, exist_ok=True)
        path = os.path.abspath(os.path.join(DUMP_DIR, 'chat-dump.json'))
        with open(path, 'w', encoding='utf-8') as f:
            json.dump(data, f, ensure_ascii=False, indent=2)
        log('')
        log('✅ 结构已落盘：%s' % path)
        log('   页面 URL：%s' % (data or {}).get('url'))
        log('   页面标题：%s' % (data or {}).get('title'))
        log('')
        log('   下一步：把这个文件给助手看，或自己打开找会话卡片的父元素类名，')
        log('   然后写成一个 selectors json（{"item": "...", "name": "...", "msg": "..."}），')
        log('   用 --read --selectors 你的文件.json 就能读了。')
        return 0
    finally:
        try:
            dp.quit()
        except Exception:                                       # noqa: BLE001
            pass


def cmd_read(args):
    sels = _load_selectors(args.selectors)
    dp = _open_page(headless=args.headless)
    try:
        log('  打开聊天页 %s …' % CHAT_URL)
        dp.get(CHAT_URL)
        time.sleep(5)
        if not _ensure_login(dp):
            log('❌ 登录没过（BOSS 登录态过期了）—— 去采集页点「登录检测」扫一次码。')
            return 2

        raw = []
        used = None
        for s in sels:
            try:
                got = dp.run_js(READ_JS, s)
            except Exception as exc:                            # noqa: BLE001
                log('  （选择器 %s 执行失败：%s）' % (s.get('item'), exc))
                continue
            if got:
                raw = got
                used = s
                break

        if used is None or not raw:
            log('')
            log('❌ 页面结构没匹配上 —— **这不代表你没有新消息**，只代表我读不懂这个页面。')
            log('   请先跑一次校准：')
            log('     python scripts/stages/boss_chat_sync.py --dump')
            log('   把生成的 chat-dump.json 交给助手，让它据此定选择器。')
            _emit({'ok': False, 'needCalibration': True, 'error':
                   '读不到会话列表（选择器没匹配上），请先跑 --dump 校准。'})
            return 4

        items = []
        for r0 in raw[:max(1, args.limit)]:
            name = (r0.get('name') or '').strip()
            msg = (r0.get('msg') or '').strip()
            # BOSS 的会话卡片里，公司名和 HR 名常在同一块文本里（"张三 · 某某公司"）
            company, hr = name, ''
            if '·' in name:
                parts = [x.strip() for x in name.split('·') if x.strip()]
                if len(parts) >= 2:
                    hr, company = parts[0], parts[-1]
            invited = any(w in msg for w in INVITE_WORDS)
            items.append({
                'company': company,
                'hr': hr,
                'lastText': msg,
                'unread': bool(r0.get('unread')),
                'invited': invited,
                'at': _to_ms(r0.get('time')),
            })

        _emit({'ok': True, 'items': items, 'raw_count': len(raw), 'scannedAt': int(time.time() * 1000)})
        log('')
        log('✅ 读到 %d 条会话（其中未读 %d 条、疑似邀约 %d 条）。' % (
            len(items),
            sum(1 for x in items if x['unread']),
            sum(1 for x in items if x['invited'])))
        log('   注意：这些还**没有**写进你的工作台 —— 要你逐条确认。')
        return 0
    finally:
        try:
            dp.quit()
        except Exception:                                       # noqa: BLE001
            pass


def main():
    ap = argparse.ArgumentParser(description='读一次 BOSS 聊天列表（只读，不写任何数据）')
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--dump', action='store_true', help='校准模式：落盘页面结构')
    g.add_argument('--read', action='store_true', help='读取模式：抓会话列表')
    ap.add_argument('--selectors', default=None, help='选择器 JSON 文件（覆盖内置候选）')
    ap.add_argument('--limit', type=int, default=30, help='最多读多少条会话（默认 30）')
    ap.add_argument('--headless', action='store_true', help='无头模式（调试用，登录时别开）')
    args = ap.parse_args()

    try:
        import DrissionPage                                      # noqa: F401
    except ImportError:
        log('❌ 需要 DrissionPage：python -m pip install DrissionPage')
        return 2

    return cmd_dump(args) if args.dump else cmd_read(args)


if __name__ == '__main__':
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError, OSError):
            pass
    sys.exit(main())
