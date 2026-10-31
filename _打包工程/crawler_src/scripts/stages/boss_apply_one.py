#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""单岗位「一键打招呼」—— 只发**一个**岗位，永不批量、永不重试。

为什么它必须是独立命令、而不是复用 deliver/apply.py：
    deliver/apply.py 是流水线的终点，面对的是"一批已批准岗位"，有演练模式、有附件体检、
    有 run_dir 上下文。而这里面对的是"用户在岗位库里随手点的一个岗位"，
    没有 run_dir、没有批准清单、招呼语是用户当场敲的。

    两者的**安全模型完全不同**，所以宁可多一个薄入口，也不要把两种语义塞进一个脚本 ——
    多塞进去的那次，一定会在某个分支上把"演练"当成"真投"。

不可逆性（写在这里是为了一次也不用去想它）：
    · 消息发出去撤不回，HR 已读撤不回
    · BOSS 每天有沟通条数上限，发废一条就少一条
    → 所以本脚本：失败**绝不重试**、一次只处理一个岗位、任何前置检查不过就直接退出不动作。

用法：
    python scripts/stages/boss_apply_one.py --url <BOSS职位页> --greeting "……"
    python scripts/stages/boss_apply_one.py --url <...> --greeting "..." --dry-run   # 只打计划

退出码：
    0 = 招呼语确认已发出
    2 = 前置闸门没过（**什么都没发，不要重试**）
    3 = 打开了页面但发送失败（auto_apply 侧判定失败）
"""

import argparse
import os
import re
import sys

_SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SCRIPTS)

# 只认 BOSS 职位详情页。别的链接（官网/猎聘/随便什么）在这里一律拒绝 ——
# auto_apply 的整套点击逻辑都是照着 BOSS 的 DOM 写的，喂别的站只会白开一次浏览器。
BOSS_JOB_RE = re.compile(r'^https?://(?:www\.)?zhipin\.com/job_detail/[A-Za-z0-9_~-]+')

MAX_GREETING = 500

# 打招呼话术如果开口就是客套，"HR 在消息列表里只看得到前 15 个字"这个事实
# 会让这条消息等于白发。只告警不拦截 —— 文案质量不该挡住用户明确要做的动作
# （口径与 skills 的 deliver/apply.py 保持一致）。
SMALL_TALK_OPENERS = ('您好', '你好', 'hi', 'hello', '在吗', '打扰了', '麻烦问一下')


def log(msg=''):
    print(msg, flush=True)


def gate(url, greeting, title, company):
    """前置闸门。返回 (ok, why)。不通过时调用方必须**什么都不做**直接退出。"""
    if not BOSS_JOB_RE.match(url or ''):
        return False, ('链接不是 BOSS 职位详情页（要求形如 '
                       'https://www.zhipin.com/job_detail/xxxx.html）。')
    if not greeting:
        return False, '招呼语是空的。拿一次沟通额度去发一句空话，不如不发。'
    if len(greeting) > MAX_GREETING:
        return False, '招呼语 %d 字，超过 BOSS 聊天框能容纳的长度（%d 字）。' % (
            len(greeting), MAX_GREETING)
    if not (title or company):
        return False, '既没有岗位名也没有公司名 —— 这多半不是从岗位库点过来的，拒绝执行。'
    return True, ''


def main():
    ap = argparse.ArgumentParser(description='单岗位「一键打招呼」（不可逆，一次只发一个）')
    ap.add_argument('--url', required=True, help='BOSS 职位详情页链接')
    ap.add_argument('--greeting', required=True, help='要发送的招呼语（用户已确认）')
    ap.add_argument('--title', default='', help='岗位名（只用于日志）')
    ap.add_argument('--company', default='', help='公司名（只用于日志）')
    ap.add_argument('--resume-file', default=None,
                    help='可选：同时在聊天里发一份简历附件（默认不发）')
    ap.add_argument('--dry-run', action='store_true', help='只打印计划，不打开浏览器')
    args = ap.parse_args()

    url = (args.url or '').strip()
    greeting = (args.greeting or '').strip()
    title = (args.title or '').strip()
    company = (args.company or '').strip()

    ok, why = gate(url, greeting, title, company)
    if not ok:
        log('⛔ 前置检查不通过：' + why)
        log('   没有做任何动作（没有打开浏览器、没有发送）。')
        return 2

    log('=' * 60)
    log('  ⚡ 一键打招呼（单岗位）')
    log('  岗位：%s' % (title or '未知岗位'))
    log('  公司：%s' % (company or '未知公司'))
    log('  链接：%s' % url)
    log('  招呼语（%d 字）：' % len(greeting))
    log('  ' + greeting.replace('\n', '\n  '))
    log('=' * 60)

    if greeting[:2] in SMALL_TALK_OPENERS or greeting[:5].lower() in SMALL_TALK_OPENERS:
        log('  ⚠️ 招呼语开头是客套话。BOSS 消息列表只显示前 15 个字，')
        log('     这会让 HR 在没有点开之前就先划过去 —— 建议把"你和他哪里对口"放开头。')

    if args.dry_run:
        log('  （演练模式：到这里就结束，没有打开浏览器、没有发送）')
        return 0

    # 导入失败要给出**能照着做**的话，而不是 ImportError 堆栈
    try:
        from resume_matcher import auto_apply_jobs
        from resume_matcher.config import ResumeProfile
    except Exception as exc:                                    # noqa: BLE001
        log('❌ 导入投递模块失败：%s' % exc)
        log('   这套流程需要 DrissionPage：'
            'python -m pip install DrissionPage')
        return 2

    job = {
        'link': url,
        '职位': title or '未知岗位',
        '公司': company or '未知公司',
    }

    # ⚠️ output_dir 必须显式传一个**独立**目录：
    #   传 None 时 auto_apply 会去 create_run_dir()（在没有历史 run 的情况下），
    #   而那个函数会推进 LATEST.txt 指针 → 把用户正在用的采集轮次指到一个空目录上，
    #   表现为「采集结果看不见了」。这种副作用不该由一次打招呼引发。
    skill_dir = os.path.dirname(os.path.dirname(_SCRIPTS))       # → skills/boss-crawler
    out_dir = os.path.join(skill_dir, 'assets', 'results', '_apply-one')
    try:
        os.makedirs(out_dir, exist_ok=True)
    except OSError as exc:
        log('❌ 建不了日志目录 %s：%s' % (out_dir, exc))
        return 2

    log('')
    log('  正在启动浏览器（复用它自己的登录态；需要登录时会等你扫码）…')
    log('')

    results = auto_apply_jobs(
        [job],
        ResumeProfile(),                    # 只作占位：招呼语是用户给的，不会走模板生成
        max_applications=1,                 # 铁律：一次只发一个
        headless=False,
        greetings={url: greeting},
        resume_file_path=args.resume_file,
        output_dir=out_dir,
    )

    if not results:
        log('❌ 一个结果都没返回（多半是登录没过 / 浏览器都没起来）。')
        return 2

    r = results[0]
    status = (r or {}).get('status')
    err = (r or {}).get('error') or ''

    # auto_apply 的 status 语义：applied（招呼语已校验发出）/ partial（附件没成功但不影响招呼语）
    # 其余（error / no_chat / no_button / skipped）都算没发出去
    if status in ('applied', 'partial'):
        log('')
        log('✅ 已发出（状态：%s）。HR 回复后会出现在 BOSS 聊天里。' % status)
        if status == 'partial':
            log('   ⚠️ 附件那一步没成功，但招呼语本身已经发出。')
        return 0

    log('')
    log('❌ 没发出去（状态：%s）%s' % (status, ('：' + err) if err else ''))
    log('   ⛔ 这里**不会重试** —— 重试等于再烧一次沟通额度。')
    log('      请到 BOSS 页面上确认那个岗位的真实状态（可能本来就已经沟通过）。')
    return 3


if __name__ == '__main__':
    for _s in (sys.stdout, sys.stderr):
        try:
            _s.reconfigure(encoding='utf-8', errors='replace')
        except (AttributeError, ValueError, OSError):
            pass
    sys.exit(main())
