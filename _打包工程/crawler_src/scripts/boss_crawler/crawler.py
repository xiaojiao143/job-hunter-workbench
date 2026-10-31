#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
爬取引擎：列表翻页、详情采集、流程编排
"""

import csv
import json
import math
import os
import re
import time
import urllib.parse

from DrissionPage import WebPage

from .auth import (check_login_elements, check_login_status, check_page_status,
                   wait_for_user_action, _latest_run_dir)
from .config import (
    CSV_FIELDS, ENCODING, ASSETS_DIR, DUP_PAGE_MIN_LINKS, DUP_PAGE_RATIO,
    DETAIL_TOP_N, SCROLL_FAIL_LIMIT, co, sleep_config, apply_stealth,
)
from .data_loader import load_existing_links, init_csv_file
from . import known_links
from resume_matcher.paths import crawl_summary_path
from .menu import print_header, estimate_time
from .state import time_stats


# ==================== 文件名安全化 ====================

# Windows 文件名非法字符。关键词里带 "/"（如「运营助理/专员」）时 os.path.join 会把它
# 当目录分隔符：文件被写进 自定义关键词/运营助理/专员_杭州.csv 这样的子目录，不递归
# 扫 *.csv 的读取侧就漏数，「关键词 → 文件名」也不再一一对应（公司定向那侧已有同样处理）。
_FILENAME_BAD_CHARS = re.compile(r'[/\\:*?"<>|]')


def safe_filename(text):
    """关键词/城市名 → 可用作文件名的字符串（非法字符换 _）。"""
    return _FILENAME_BAD_CHARS.sub('_', (text or '').strip())


# ==================== 列表数据处理 ====================

def process_job_list(job_list, file_path, existing_links, csv_writer, run_seen=None,
                     known=None, stats=None):
    """处理岗位列表数据（去重写入 CSV）

    三个去重集合语义不同，不要合并：
      existing_links —— 本文件已有的行 + 本文件本次新写入的，决定是否写盘。
      run_seen       —— 本轮运行（所有关键词 × 城市）遇到过的全部 link。
                        既参与写盘决策，也是「这一页全是同义关键词的重复」的判据。
      known          —— **全局**已知集（跨关键词文件、跨轮次、跨「清空采集结果」）。
                        见 known_links 模块。只参与**写盘决策**，且判据是
                        `has_detail()`（已拿到 JD）而不是 `has()`（见过）——
                        理由见下面循环里的注释（用 has() 会让 JD 永远补不上）。

    known / stats 为 None 时行为与之前完全一致（本函数是 __init__ 导出的公开 API）。

    ⛔ `run_dups` 的口径**刻意不动**：它只数「本轮 run_seen 命中」，因为
       should_skip_remaining_pages 用它做提前退出（见 config.DUP_PAGE_RATIO 注释）。
       把「历史上采过」也算进 run_dups 会让「续爬同一关键词更深的页」被立刻打断。
       全局命中的部分单独记进 `stats['known_dups']`。

    Returns:
        (written, skipped, run_dups)
        run_dups 只数「本轮其他地方已见过」的，是 skipped 的子集。
    """
    written = 0
    skipped = 0
    run_dups = 0

    for job in job_list:
        job_link = f"https://www.zhipin.com/job_detail/{job['encryptJobId']}.html"

        seen_this_run = run_seen is not None and job_link in run_seen
        if seen_this_run:
            run_dups += 1

        # 全局已知（上一轮 / 别的关键词文件 / 清空前的归档）。见 known_links。
        # ⛔ 判据用的是 has_detail()，**不是** has() —— 这一点很容易写错，后果是功能退化：
        #    下游详情阶段的门槛是「本轮这个文件写了新行才去抓详情」。如果把
        #    「见过但还没 JD」的岗位也拦在写盘之外，它就再也不会出现在任何文件里，
        #    → 永远进不了详情候选 → **JD 永远补不上**（实测数据：609 条里 559 条没 JD）。
        #    所以只有「**已经拿到 JD**」才算真的没东西可补、才跳过。
        # ⚠️ 同时在前两者都没命中时才单独计数，否则同一份重复会被算两次。
        known_before = (known is not None
                        and not seen_this_run
                        and job_link not in existing_links
                        and known.has_detail(job_link))
        if known_before and stats is not None:
            stats['known_dups'] = stats.get('known_dups', 0) + 1

        if job_link in existing_links or seen_this_run or known_before:
            skipped += 1
            if run_seen is not None:
                run_seen.add(job_link)
            continue

        dit = {
            'link': job_link,
            '职位': job.get('jobName', ''),
            '城市': job.get('cityName', ''),
            '区域': job.get('areaDistrict', ''),
            '商圈': job.get('businessDistrict', ''),
            '公司': job.get('brandName', ''),
            '薪资': job.get('salaryDesc', ''),
            '经验': job.get('jobExperience', ''),
            '学历': job.get('jobDegree', ''),
            '领域': job.get('brandIndustry', ''),
            '性质': job.get('brandStageName', ''),
            '规模': job.get('brandScaleName', ''),
            '技能标签': ' '.join(job.get('skills', [])),
            '福利标签': ' '.join(job.get('welfareList', [])),
            '位置': str(job.get('gps', '')),
            '岗位要求和职责': '',
            '公司信息': '',
            # 以下字段只存在于详情 API，列表阶段一律留空，由 crawl_job_details 回填。
            # 空串 = 未采集，不要写成 '否'
            '地址': '',
            '已失效': '',
            '代招': '',
            'HR活跃度': '',
            'HR在线': '',
            'HR职位': '',
            'HR姓名': '',
            'HR公司': ''
        }

        csv_writer.writerow(dit)
        existing_links.add(job_link)
        if run_seen is not None:
            run_seen.add(job_link)
        written += 1

    return written, skipped, run_dups


# ==================== 单页爬取循环（共用） ====================

def should_skip_remaining_pages(page_size, run_dups):
    """本页是否已经基本全是本轮其他关键词采过的岗位 → 跳到下一个关键词。

    只看 run_dups（本轮其他关键词已采），不看总重复数 —— 理由见
    config.DUP_PAGE_RATIO 的注释：用总重复数会打断「同一关键词续爬更深的页」。
    """
    if page_size < DUP_PAGE_MIN_LINKS:
        return False
    return run_dups / page_size >= DUP_PAGE_RATIO


def _crawl_paginated(dp, url, file_path, count_limit, existing_links, run_seen=None,
                     job_filter=None, known=None, stats=None):
    """
    通用的翻页爬取循环。
    三个爬取函数（by_position / by_query / company_mode）共用此翻页逻辑。

    job_filter: 可选，接收单个 job dict，返回 True 才写入。公司定向用它把搜索结果
               里不属于目标公司（brandName 精确匹配）的岗位滤掉 —— link 去重、到底
               判定都在过滤之后算，避免被其他公司的岗位撑混。

    Returns:
        (total_processed, total_written, total_skipped, total_run_dups)
    """
    dp.get(url)
    dp.listen.start('zpgeek/search/joblist.json')
    time_stats.end_request(True, url)

    total_written = 0
    total_skipped = 0
    total_run_dups = 0
    page_num = 1
    consecutive_no_data = 0
    scroll_fail = 0

    with open(file_path, 'a', encoding=ENCODING, newline='') as f:
        csv_writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)

        while True:
            if count_limit and total_written >= count_limit:
                print(f"\n已达到数量限制 {count_limit} 条")
                break

            print(f"\n[第{page_num}页] 爬取中...")

            try:
                time_stats.start_request('scroll')
                dp.scroll.to_bottom()
                time_stats.end_request(True)
                scroll_fail = 0
            except Exception as e:
                time_stats.end_request(False, str(e))
                print(f"滚动失败: {e}")
                # ⛔ 这里**绝不能裸 continue**：浏览器页面被关掉 / 连接断开后
                # to_bottom() 会一直抛异常，裸 continue 回到 while 顶部就是
                # 「页号不变 + 无上限 + 无退避」的极速空转 —— 实测 1 分钟刷出
                # 424MB 日志、内存与前端一起被拖死（见 config.SCROLL_FAIL_LIMIT）。
                # 连续失败到上限就停本轮，中间退避一下再试。
                scroll_fail += 1
                if scroll_fail >= SCROLL_FAIL_LIMIT:
                    print(f"[第{page_num}页] 连续 {scroll_fail} 次滚动失败"
                          f"（页面可能已关闭 / 连接已断开），停止本轮爬取")
                    break
                try:
                    sleep_config.sleep('retry')
                except Exception:                              # noqa: BLE001
                    time.sleep(2)
                continue

            time_stats.start_request('api', 'zpgeek/search/joblist.json')
            r = dp.listen.wait(timeout=3)
            status = check_page_status(dp, r)

            if status == 'need_login':
                time_stats.end_request(False, '需要登录')
                print(f"[第{page_num}页] [!] 检测到需要登录，请手动登录...")
                if not wait_for_user_action(dp):
                    print("等待超时，停止爬取")
                    break
                continue

            if status == 'no_data':
                time_stats.end_request(False, '无数据')
                consecutive_no_data += 1
                if consecutive_no_data >= 2:
                    print(f"\n连续 {consecutive_no_data} 次无数据（已重试一次），爬取结束")
                    break
                print(f"[第{page_num}页] 无数据，等待重试...")
                sleep_config.sleep('retry')
                continue

            consecutive_no_data = 0

            try:
                job_list = r.response.body.get('zpData', {}).get('jobList', [])
                if job_filter is not None:
                    job_list = [j for j in job_list if job_filter(j)]
                written, skipped, run_dups = process_job_list(
                    job_list, file_path, existing_links, csv_writer, run_seen,
                    known=known, stats=stats
                )
                total_written += written
                total_skipped += skipped
                total_run_dups += run_dups

                time_stats.end_request(True, f"获取{len(job_list)}条,写入{written}条")
                print(f"[第{page_num}页] 获取到 {len(job_list)} 条数据，已写入 {written} 条（跳过 {skipped} 条重复）")

                if should_skip_remaining_pages(len(job_list), run_dups):
                    pct = round(run_dups / len(job_list) * 100)
                    print(f"[第{page_num}页] 本页 {len(job_list)} 条中 {run_dups} 条"
                          f"已由本轮其他关键词采过（{pct}%），跳过剩余分页")
                    break
            except Exception as e:
                time_stats.end_request(False, str(e))
                print(f"[第{page_num}页] 处理数据失败: {e}")

            page_num += 1
            sleep_config.sleep('page')

    dp.listen.stop()
    return total_written + total_skipped, total_written, total_skipped, total_run_dups


# ==================== 按岗位 code 爬取 ====================

def crawl_jobs_by_position(dp, position_code, city_code, file_path, count_limit,
                           existing_links, filter_query='', run_seen=None,
                           known=None, stats=None):
    """按岗位code爬取"""
    init_csv_file(file_path)

    url = f'https://www.zhipin.com/web/geek/job?position={position_code}&city={city_code}{filter_query}'
    print(f"\n访问: {url}")
    time_stats.start_request('page', url)

    return _crawl_paginated(dp, url, file_path, count_limit, existing_links, run_seen,
                            known=known, stats=stats)


# ==================== 按关键词爬取 ====================

def crawl_jobs_by_query(dp, query, city_code, file_path, count_limit,
                        existing_links, filter_query='', run_seen=None,
                        known=None, stats=None):
    """按关键词爬取"""
    init_csv_file(file_path)

    encoded_query = urllib.parse.quote(query)
    url = f'https://www.zhipin.com/web/geek/jobs?city={city_code}&query={encoded_query}{filter_query}'
    print(f"\n访问: {url}")
    time_stats.start_request('page', url)

    return _crawl_paginated(dp, url, file_path, count_limit, existing_links, run_seen,
                            known=known, stats=stats)


# ==================== 详情爬取 ====================

def get_single_job_detail(dp, url):
    """
    获取单个岗位详情（优先API直调，兜底DOM解析）

    Returns:
        dict: {'jd', 'company_info', 'hr_active', 'hr_online', 'hr_title'}
              HR 三项仅 API 直调分支可得，DOM 兜底时为空串。
        None: 获取失败或需要登录
    """
    import re
    try:
        time_stats.start_request('detail', url)

        # Step 1: 快速加载详情页 HTML（不等 JS 渲染，~0.8s）
        dp.get(url)
        html = dp.html

        # Step 2: 从 HTML 中提取 securityId 和 jobId
        m_sid = re.search(r"securityId:\s*'([^']+)'", html)
        m_jid = re.search(r"job_id:\s*'([^']+)'", html)

        if not m_sid or not m_jid:
            # securityId 提取失败，回退到 DOM 解析
            if check_login_elements(dp):
                time_stats.end_request(False, '需要登录')
                return None
            return _extract_detail_from_dom(dp)

        security_id = m_sid.group(1)
        job_id = m_jid.group(1)

        # Step 3: 直接调用详情 API（~0.1s）
        api_url = (
            f'https://www.zhipin.com/wapi/zpgeek/job/detail.json'
            f'?securityId={security_id}&jobId={job_id}'
        )
        dp.listen.start('job/detail.json')
        dp.get(api_url)
        r = dp.listen.wait(timeout=8)
        dp.listen.stop()

        if not r:
            # API 超时，回退 DOM
            dp.get(url)
            return _extract_detail_from_dom(dp)

        body = r.response.body
        zp = body.get('zpData', {})

        # 提取岗位描述
        job_info = zp.get('jobInfo', {})
        post_desc = job_info.get('postDescription', '')
        if not post_desc:
            # 备用：某些岗位可能用不同字段名
            post_desc = job_info.get('postDesc', '')

        # 拼装完整描述：岗位职责 + 任职要求等
        for key in ('job_description', 'job_require', 'jobRequire', 'jobDescription'):
            val = job_info.get(key, '')
            if val:
                post_desc += '\n' + val

        # 提取公司信息。
        #
        # 真实键名是 `introduce`（2026-08-13 对 job_detail.json 实测确认）。
        # 这里原先只试了 content / companyInfo / introduction —— 差两个字母，
        # 于是 15/15 的岗位公司简介全是空的，而同批 HR 活跃度全部正常，
        # 看起来像「BOSS 没提供简介」而不是「键名取错了」。所以 introduce 放第一位，
        # 其余保留作兜底（不同版本的接口可能换名）。
        brand_info = zp.get('brandComInfo', {})
        comp_info = ''
        if isinstance(brand_info, dict):
            for key in ('introduce', 'content', 'companyInfo', 'introduction'):
                value = brand_info.get(key, '')
                if value and str(value).strip():
                    comp_info = str(value).strip()
                    break
        elif isinstance(brand_info, str):
            comp_info = brand_info

        if post_desc:
            time_stats.end_request(True, 'API直调')
            return {
                'jd': post_desc,
                'company_info': comp_info if comp_info else '',
                **_extract_job_extras(job_info),
                **_extract_brand_extras(brand_info),
                **_extract_hr_info(zp),
            }

        # API 没有描述内容，回退 DOM
        dp.get(url)
        return _extract_detail_from_dom(dp)

    except Exception as e:
        time_stats.end_request(False, str(e))
        print(f"获取详情失败: {e}")
        return None


def _tri_state(value):
    """布尔字段 → '是'/'否'/''。

    取不到时留空串而非 '否' —— 「未采集」不能被读成「不是」。
    整个技能里 hr_online、已失效、代招 都用这一个语义。
    """
    return '' if value is None else ('是' if value else '否')


def _looks_truncated(name):
    """公司名是否疑似被 BOSS 列表接口截断。

    实测截断形态以「...」或「…」结尾（如「杭州市拱墅区一述...」）。
    只认这两种明确信号 —— 不用「长度短于 X」这类猜测性判据，
    免得把合法的短公司名误判成截断而触发无谓覆盖。
    """
    s = (name or '').strip()
    return s.endswith('...') or s.endswith('…')


# 详情缺失时的空值集。DOM 兜底路径和 API 路径必须返回同一套键，
# 否则 crawl_job_details 回填时会 KeyError。
EMPTY_DETAIL_EXTRAS = {
    'address': '', 'invalid': '', 'proxy': '', 'welfare': '',
    'hr_active': '', 'hr_online': '', 'hr_title': '', 'hr_name': '', 'hr_company': '',
    'brand_name': '',
}


def _extract_job_extras(job_info):
    """从 zpData.jobInfo 提取列表页拿不到的岗位事实。

    - invalidStatus：岗位是否已失效。失效岗位投了也是白投，值得单独一列。
    - proxyJob：代招标记。为 1 时跟你聊的是猎头/外包，不是用人公司自己的 HR。
    - address：具体上班地址（列表页只有经纬度）。
    """
    if not isinstance(job_info, dict):
        return {'address': '', 'invalid': '', 'proxy': ''}

    return {
        'address': (job_info.get('address') or '').strip(),
        'invalid': _tri_state(job_info.get('invalidStatus')),
        'proxy': _tri_state(job_info.get('proxyJob')),
    }


def _extract_brand_extras(brand_info):
    """从 zpData.brandComInfo 提取完整福利标签 + 完整公司名。

    详情里的 labels 通常比列表页的 welfareList 全得多（实测 20 条 vs 几条），
    所以单独取出来，由调用方在列表页值为空时回填。

    brand_name：BOSS **列表接口**的 brandName 会被截断（实测 456 条里 15 条形如
    「杭州市拱墅区一述...」），而详情接口的 brandComInfo.brandName 是完整名。
    公司背调页按公司名检索，截断名永远查不到 —— 所以详情回填时要把完整名带回去。
    """
    if not isinstance(brand_info, dict):
        return {'welfare': '', 'brand_name': ''}

    labels = brand_info.get('labels')
    welfare = ''
    if isinstance(labels, list):
        welfare = ' '.join(str(x).strip() for x in labels if str(x).strip())

    brand_name = brand_info.get('brandName') or ''

    return {'welfare': welfare, 'brand_name': str(brand_name).strip()}


def _extract_hr_info(zp):
    """
    从详情 API 的 zpData.bossInfo 提取招聘者信息。

    快照语义：活跃度是爬取瞬间的状态。bossOnline 波动极快，
    投递时基本已过期；activeTimeDesc 粒度粗但相对稳定，是排序的主要依据。

    hr_company 是 HR **自己**所属的公司，和岗位挂的公司可能不是一家 ——
    实测见过岗位公司「深圳某大型ICT…」而 HR 是「途聚人力」的猎头。
    两者不一致就是代招的旁证，所以单独存一列。
    """
    boss = zp.get('bossInfo') or {}
    if not isinstance(boss, dict):
        return {'hr_active': '', 'hr_online': '', 'hr_title': '',
                'hr_name': '', 'hr_company': ''}

    return {
        'hr_active': boss.get('activeTimeDesc') or '',
        'hr_online': _tri_state(boss.get('bossOnline')),
        'hr_title': boss.get('title') or '',
        'hr_name': boss.get('name') or '',
        'hr_company': boss.get('brandName') or '',
    }


def _extract_detail_from_dom(dp):
    """兜底方案：从 DOM 中提取详情（需要等 JS 渲染完成）

    DOM 里只有 JD 和公司简介两段文本，其余字段一律留空 ——
    空串的语义是「未采集」，下游据此显示，不会被误读成「否」。
    """
    if dp.wait.ele_displayed('css:.job-sec-text', timeout=15):
        pass  # 元素已出现

    if check_login_elements(dp):
        time_stats.end_request(False, '需要登录')
        return None

    res = dp.eles('css:.job-sec-text')

    if len(res) == 1:
        time_stats.end_request(True, 'DOM解析')
        return {'jd': res[0].text, 'company_info': '', **EMPTY_DETAIL_EXTRAS}
    elif len(res) == 2:
        time_stats.end_request(True, 'DOM解析')
        return {'jd': res[0].text, 'company_info': res[1].text, **EMPTY_DETAIL_EXTRAS}
    else:
        time_stats.end_request(False, '未找到详情元素')
        return None


def detail_priority(row, prefer=None):
    """列表页字段 → 详情抓取优先级（分高的先抓）。

    ⚠️ 前五个信号**不是**「合适度」—— 它们只衡量「这条岗位信息全不全」，
    不是「和你有没有关系」。所以单靠它们会把额度花在「亚马逊运营（信息齐全）」
    这类岗位上，而「抖音短视频运营」一条 JD 都拿不到（实测：50 条额度里
    只有 33 条落在求职方向相关的岗位上）。

    信号（都可解释、都来自列表页）：
      · 命中求职方向词                 +10 （见 prefer 参数；压过下面满分 9）
      · 薪资能解析出具体数字           +3  （「面议」多半信息不全或挂羊头）
      · 福利标签条数（越多越像正式岗）    +1/条，上限 +3
      · 有学历/经验要求（信息完整）      +1 各
      · 公司名没被截断                 +1  （截断的往往是长尾小公司）
    同分时保持原顺序（Python 稳定排序），不引入随机性。

    Args:
        prefer: 求职方向词列表（**直接来自采集参数里的「岗位期望」，不做任何转换**）。
            命中岗位标题里任一方向词 → +10。
            为什么是 +10：下面五个信号满分是 9，+10 能保证「方向相关」的岗位
            永远排在「方向无关但信息最全」的前面 —— 这就是「额度给对的人」的实现方式。
            多个方向词同时命中**只加一次**（不累加），免得标题里堆词就能刷分。
            None 或空列表 = 行为与加这个参数之前**完全一致**（不做任何相关性加权）。
    """
    score = 0
    if prefer:
        title = str(row.get('职位') or '')
        for _p in prefer:
            _kw = str(_p or '').strip()
            if _kw and _kw in title:
                score += 10
                break
    sal = str(row.get('薪资') or '')
    # 含数字 + K/元/万 的薪资才算「能解析出具体数字」
    if re.search(r'\d', sal) and not re.search(r'面议', sal):
        score += 3
    welfare = str(row.get('福利标签') or '').strip()
    if welfare:
        score += min(len(welfare.split()), 3)
    if str(row.get('学历') or '').strip():
        score += 1
    if str(row.get('经验') or '').strip():
        score += 1
    if not _looks_truncated(str(row.get('公司') or '')):
        score += 1
    return score


def collect_detail_candidates(file_path, existing_links, known=None, prefer=None):
    """只读地收集一个 CSV 里「还缺详情」的候选：[(link, priority, order)]。

    ⛔ 这是给**全局优先级分配**用的（见 select_detail_targets）。它只读不写 ——
    真正的回填仍然由 crawl_job_details 负责，避免两处各写一遍文件。

    known：全局已知集（known_links.Known）。判据用的是 `known.has_detail(link)`
    —— **不是** `known.has(link)`。区别很关键：
      · has()        含每一个进过 CSV 的 link，**包括本文件里 JD 还空着的行**
      · has_detail() 只含 JD 正文非空的
    用 has() 会把本文件所有待抓的行都判成"已有详情"→ 一条详情都抓不到。
    用 has_detail() 才是本意：**这条岗位的 JD 已经在别的关键词文件/上一轮/归档里拿到了**，
    不必再花 5 秒和一次风控额度重抓一遍。

    prefer：求职方向词，透传给 detail_priority 做相关性加权（见那里的说明）。
        ⛔ 这里**必须**一起传 —— 否则会出现「全局挑选时按方向排好序、
        但收集 pending 时用的是没加权的分数」→ 排序被后一步覆盖，**静默失效**。
    """
    if not os.path.exists(file_path):
        return []
    pending = []
    order = 0
    with open(file_path, 'r', encoding=ENCODING) as f:
        for row in csv.DictReader(f):
            link = (row.get('link') or '').strip()
            if not link:
                continue
            if (not row.get('岗位要求和职责') and link not in existing_links
                    and not (known is not None and known.has_detail(link))):
                pending.append((link, detail_priority(row, prefer), order))
                order += 1
    return pending


def select_detail_targets(file_paths, existing_links, budget, known=None, prefer=None):
    """在所有关键词文件之间**全局**挑选要抓详情的岗位（按 detail_priority 降序）。

    为什么需要它（这是详情（JD）覆盖率只有 9% 的根因）：
      原来 execute_crawl_iteration 是**按关键词顺序**逐个文件调用 crawl_job_details，
      每个文件消耗掉整轮共享预算。于是排在第一个的关键词（如"运营"，文件最大）
      把 50 条额度一次吃光，后面 12 个关键词一条 JD 都拿不到。
      实测：运营_杭州.csv 60 行有 50 条 JD，其余 12 个文件**全部 0**，整轮 9%。
    而 config.DETAIL_TOP_N 的注释写的是「把有限的额度花在**最值得看的岗位**上」，
    detail_priority() 也确实在排序 —— 但它只在**单个文件内部**排，缺的正是跨文件这一步。

    预算语义不变：仍然只挑 budget 个 → 详情请求次数不变 → 风控暴露不变。
    ⚠️ 但**候选池变小了**（known 里已有 JD 的剔除掉）→ 同样预算能覆盖到**更多真正缺
       JD 的岗位** —— 这正是这个改动带来的实际收益，而且它**降低**风控暴露而不是提高。

    prefer：求职方向词（**直接来自采集参数里的「岗位期望」，不做任何转换**）。
        有了它，同一个 budget 会优先落在方向相关的岗位上，而不是"信息最全但跟你无关"的岗位。
        None / 空 = 排序口径与加这个参数之前完全一致。

    Returns:
        (chosen, total_pending, kept)
        chosen = {file_path: [link, ...]}，只含非空项
    """
    all_cands = []
    for fp in file_paths:
        for link, pri, order in collect_detail_candidates(fp, existing_links,
                                                          known=known, prefer=prefer):
            all_cands.append((link, pri, order, fp))

    total_pending = len(all_cands)
    if budget is None or budget <= 0:
        kept_c = all_cands
    else:
        # 排序键 (-priority, order)：优先级降序、同分保持**发现顺序**（稳定），不引入随机。
        all_cands.sort(key=lambda t: (-t[1], t[2]))
        kept_c = all_cands[:budget]

    chosen = {}
    for link, _pri, _order, fp in kept_c:
        chosen.setdefault(fp, []).append(link)
    return chosen, total_pending, len(kept_c)


def crawl_job_details(dp, file_path, existing_links, max_details=None, links_filter=None,
                      known=None, prefer=None):
    """
    爬取岗位详情
    使用传入的dp实例，不创建新浏览器

    Args:
        max_details: 详情抓取**上限**。None = 不限制（保持旧行为）。
            为什么要封顶：BOSS 直聘大约 200 个详情就触发风控（config.SleepConfig
            注释），而一轮可能采到几百个岗位 —— 实测曾有单轮 456 个岗位、每一个
            都走过一次详情接口，是阈值的 2.3 倍。封顶后按 detail_priority 排序，
            把额度花在最值得看的岗位上，其余只保留列表页字段。
        links_filter: 只处理这个集合里的 link（None = 不筛）。
            用于**全局优先级分配**：上层先用 select_detail_targets 在所有关键词之间
            排好序、挑出该抓的那批，再按文件分组，把每组的 link 传进来。
            ⛔ 有这个参数之后，max_details 通常传 None —— 挑选已经在全局那一步做完了，
               再叠一层"每文件上限"会把刚排好的全局顺序又切碎（回到老 bug）。
        prefer: 求职方向词，透传给 detail_priority 做相关性加权。见那里的说明。

    Returns:
        (success_count, attempted_count)。attempted_count 是本轮**实际发起详情请求**
        的数量（= len(links_to_update)，含失败的 —— 失败的请求同样占风控额度）。
        上层用 attempted_count 递减「整轮共享的详情预算」，而不是 success_count：
        封顶的本意是控制风控暴露（请求次数），不是控制「成功数」。
    """
    if not os.path.exists(file_path):
        print(f"文件不存在: {file_path}")
        return (0, 0)

    rows = []
    pending = []      # [(link, priority, 原始顺序)]
    order = 0

    with open(file_path, 'r', encoding=ENCODING) as f:
        reader = csv.DictReader(f)
        for row in reader:
            rows.append(row)
            link = (row.get('link') or '').strip()
            # links_filter：只挑全局分配点名要抓的那些
            if links_filter is not None and link not in links_filter:
                continue
            # ⛔ 用 known.has_detail() 而不是 known.has()：前者才表示「JD 已有正文」。
            #    用 has() 会把本文件里 JD 还空着的行全判成"已有详情" → 一条都抓不到。
            if (not row.get('岗位要求和职责') and row['link'] not in existing_links
                    and not (known is not None and known.has_detail(row['link']))):
                # prefer 也要传！否则这里的 pending 顺序与全局挑选用的分数不一致。
                pending.append((row['link'], detail_priority(row, prefer), order))
                order += 1

    if not pending:
        print("所有岗位详情已存在，无需爬取")
        return (0, 0)

    total_pending = len(pending)

    # 封顶：按优先级降序取前 max_details 个；同分保持原顺序（稳定）。
    # ⚠️ 排序键用 (-priority, order) —— 只给 priority 取负，order 保持升序。
    if max_details is not None and max_details > 0 and total_pending > max_details:
        pending.sort(key=lambda t: (-t[1], t[2]))
        kept = pending[:max_details]
        skipped_detail = total_pending - max_details
        print(f"\n详情抓取封顶：{total_pending} 个待抓 → 按优先级取前 {max_details} 个"
              f"（其余 {skipped_detail} 个只保留列表页字段，避免触发风控）")
        links_to_update = [t[0] for t in kept]
    else:
        links_to_update = [t[0] for t in pending]

    print(f"\n正在爬取 {len(links_to_update)} 个岗位详情...")

    success_count = 0
    failures = []      # [(link, 原因)] —— 详情失败不再静默，结束后落盘给前端

    for i, link in enumerate(links_to_update, 1):
        print(f"\n[{i}/{len(links_to_update)}] {link}")

        detail = get_single_job_detail(dp, link)

        if detail is None:
            print(f"  [!] 可能需要登录或遇到验证码，自动等待检测...")
            # 等待用户恢复登录（比如去弹出的窗口里扫码）。
            #
            # ⚠️ 这里原来是「120 秒忙等」：循环体里没有 sleep，dp.get 一返回就
            # 立刻再请求一次 —— 在已经触发风控、正需要降温的场景下，等于对着
            # 风控系统猛捶（120 秒能捶几十上百次）。改成带间隔的轮询：
            #   · 每轮之间 sleep(RETRY_POLL_SEC)，给风控和页面都留出时间；
            #   · 总时长有硬上限，不会无限等；
            #   · 每次轮询只做一次轻量登录检查，不做无用请求。
            RETRY_POLL_SEC = 8      # 轮询间隔下限（秒）
            RETRY_TOTAL_SEC = 96    # 总等待上限（秒）——给用户留出扫码时间
            retry_start = time.time()
            retry_success = False

            while time.time() - retry_start < RETRY_TOTAL_SEC:
                elapsed = int(time.time() - retry_start)
                try:
                    # 必须重新加载列表页：check_login_status 是纯 DOM 检查
                    # （查头像 / 登录按钮），不 reload 的话用户扫码后页面还是
                    # 旧的失败页，永远检测不到「已登录」。
                    dp.get('https://www.zhipin.com/web/geek/jobs')
                    if check_login_status(dp):
                        print(f"  [恢复] 登录状态已恢复，重试获取详情...")
                        detail = get_single_job_detail(dp, link)
                        retry_success = True
                        break
                except Exception:
                    pass
                # 无论 dp.get 返回多快，都强制等一个下限 —— 否则页面加载在
                # 本地缓存命中时可能极快，循环又会退化成忙等。
                time.sleep(RETRY_POLL_SEC)
                if elapsed % (RETRY_POLL_SEC * 2) < RETRY_POLL_SEC:
                    print(f"  [等待恢复] {elapsed}s / {RETRY_TOTAL_SEC}s ...")

            if not retry_success:
                print(f"  [跳过] 等待超时，跳过此岗位详情")
                # 不再静默 —— 记下失败，结束后落盘给前端（P1-3）。
                failures.append((link, '等待登录恢复超时'))
                continue

        if detail:
            for row in rows:
                if row['link'] == link:
                    row['岗位要求和职责'] = detail['jd']
                    row['公司信息'] = detail['company_info']
                    row['地址'] = detail.get('address', '')
                    row['已失效'] = detail.get('invalid', '')
                    row['代招'] = detail.get('proxy', '')
                    row['HR活跃度'] = detail.get('hr_active', '')
                    row['HR在线'] = detail.get('hr_online', '')
                    row['HR职位'] = detail.get('hr_title', '')
                    row['HR姓名'] = detail.get('hr_name', '')
                    row['HR公司'] = detail.get('hr_company', '')
                    # 详情的福利列表比列表页全得多，但只在列表页没采到时才覆盖，
                    # 避免用一份可能为空的详情数据抹掉已有值
                    welfare = detail.get('welfare', '')
                    if welfare and not (row.get('福利标签') or '').strip():
                        row['福利标签'] = welfare
                    # 公司名：列表接口的 brandName 可能被截断（形如「xxx…」），
                    # 详情接口的 brandComInfo.brandName 是完整名。只在「原值疑似
                    # 截断」或「详情名更长」时覆盖 —— 不无脑覆盖，免得把列表页
                    # 已有的好数据换成别的写法。
                    full_name = (detail.get('brand_name') or '').strip()
                    cur_name = (row.get('公司') or '').strip()
                    if full_name and (
                        _looks_truncated(cur_name) or len(full_name) > len(cur_name)
                    ):
                        row['公司'] = full_name
                    break
            success_count += 1
            existing_links.add(link)
        else:
            print(f"  [FAIL] 获取失败")
            failures.append((link, '获取失败（可能被风控或页面异常）'))

        # 增量保存：每获取 5 个详情或最后一条时写入文件
        if success_count % 5 == 0 or i == len(links_to_update):
            try:
                with open(file_path, 'w', encoding=ENCODING, newline='') as f:
                    writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction='ignore')
                    writer.writeheader()
                    writer.writerows(rows)
            except Exception as save_err:
                print(f"  [警告] 增量保存失败: {save_err}")

        # 分批冷却：每 detail_batch 个详情请求暂停一次（模拟人类阅读节奏、给风控降温）。
        # 用序号 i 而非成功数，因为失败的请求也占风控额度。
        if i % sleep_config.detail_batch == 0 and i > 0:
            print(f"  [冷却] 已请求 {i}/{len(links_to_update)}，暂停 {sleep_config.batch_cooldown}s ...")
            sleep_config.sleep('batch')
        sleep_config.sleep('detail')  # 请求间隔（带随机抖动，见 SleepConfig）

    # 最终保存
    try:
        with open(file_path, 'w', encoding=ENCODING, newline='') as f:
            writer = csv.DictWriter(f, fieldnames=CSV_FIELDS, extrasaction='ignore')
            writer.writeheader()
            writer.writerows(rows)
    except Exception as final_save_err:
        print(f"  [警告] 最终保存失败: {final_save_err}")

    # 失败清单落盘 —— 让「数据不全」是可见的而不是猜的（P1-3）。
    # 以前失败只打一行日志，前端只在自己的结果里标个小字，用户以为数据是全的。
    _write_detail_failures(file_path, failures, success_count, len(links_to_update))

    print(f"\n详情爬取完成！成功 {success_count} 条")
    if failures:
        print(f"  ⚠️ 有 {len(failures)} 个岗位详情没抓到（已记录，可在工作台单独重试）")
    return success_count, len(links_to_update)


def _write_detail_failures(file_path, failures, success_count, attempted):
    """把详情失败清单写到与 CSV 同目录的 <名>_detail_failures.json。

    失败清单是辅助信息，写不进去不影响采集 —— 但**不写就等于静默失败**，
    所以这里尽力而为且明确打印结果。
    """
    if not failures and success_count == attempted:
        return
    try:
        out = file_path + '_detail_failures.json'
        tmp = out + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({
                'savedAt': time.strftime('%Y-%m-%d %H:%M:%S'),
                'attempted': attempted,
                'succeeded': success_count,
                'failed': len(failures),
                'failures': [{'link': l, 'reason': r} for l, r in failures],
            }, f, ensure_ascii=False, indent=2)
        os.replace(tmp, out)
    except Exception as e:
        print(f"  [提示] 失败清单写入失败（不影响采集）: {e}")


# ==================== 共享编排函数（消除重复） ====================

def execute_crawl_iteration(dp, positions, cities, is_custom, count_limit,
                            with_detail, filter_query='', is_company=False,
                            detail_prefer=None, include_known=False):
    """
    执行爬取迭代（被 run_crawl_process 和 run_crawl_cli 共用）。

    Args:
        dp: WebPage 实例
        positions: [(pos_path, pos_code, pos_name), ...]；company 模式下即为
                   [(None, None, 公司名), ...]
        cities: [(city_name, city_code), ...]
        is_custom: True=关键词搜索, False=列表模式
        count_limit: int or None
        with_detail: bool
        filter_query: URL 筛选参数字符串
        is_company: True=公司定向模式。company 模式下本函数复用 crawl_company，
                    它内部已做完 搜索过滤翻页 + 详情回填，不再走下面的统一详情步。
        detail_prefer: 求职方向词列表（**直接来自采集参数里的「岗位期望」，不做任何转换**）。
                    详情额度会优先给标题命中这些词的岗位 —— 见 detail_priority 的说明。
                    None / 空 = 只按信息完整度排（与加这个参数之前完全一致）。
        include_known: True = 重新采集历史已采岗位（不加载全局已知集 → 不跳过去重）。
                    默认 False = 保持去重（跳过 known_links 里已有 JD 的岗位）。

    Returns:
        {'total': int, 'written': int, 'skipped': int, 'run_dups': int}
    """
    total_stats = {'total': 0, 'written': 0, 'skipped': 0, 'run_dups': 0, 'known_dups': 0}
    detail_existing_links = set()

    # 全局已知集（跨关键词文件 / 跨轮次 / 跨「清空采集结果」）。见 known_links 模块。
    # ⛔ 必须在循环**之前**建好：它要在每个关键词开始前就生效，而不是等第一个文件跑完。
    # include_known（采集已采过岗位）时置 None：所有 `known is not None and ...` 判据
    # 自动短路 → 历史岗位不再被跳过、重新采集（详情候选同理）。
    known = None if include_known else known_links.load(ASSETS_DIR)
    # 本轮爬过的关键词 CSV 清单 —— 循环结束后用它做详情的**全局**优先级分配
    # （见循环后面那一段）。company 模式不走这里（crawl_company 内部自带详情回填）。
    detail_files = []

    # 整轮共享的「详情请求预算」（风控保护，2026-10-05 评审 P0-1.1）。
    # DETAIL_TOP_N 是**整轮**上限，不是「每个关键词文件」的上限 —— 后者的话
    # 13 个关键词 = 650 条详情请求，是 BOSS 风控阈值(≈200)的 3 倍多，实测曾
    # 一轮发 446 次详情。所以这里维护一个整轮共享的剩余额度，每抓一批就消耗掉
    # 「实际发出的请求数」（含失败，失败的请求同样占风控额度），额度用完后面的
    # 关键词只保留列表页字段。None 或 0 = 不封顶（旧行为）。
    detail_budget = DETAIL_TOP_N

    # 整轮运行共享一个 link 集合。没有它时，每个关键词只认自己那个 CSV 里的 link，
    # 于是同义关键词把同一批岗位重复爬、重复写、下游再重复解析一遍
    # （实测太原 5 个关键词写出 117 行，只有 53 个唯一 link）。
    # 它同时是 should_skip_remaining_pages 的判据来源。
    run_seen = set()

    for pos_path, pos_code, pos_name in positions:
        for city_name, city_code in cities:
            print(f"\n{'='*50}")
            print(f"正在爬取: {pos_name} - {city_name}")
            print(f"{'='*50}")

            if is_company:
                from .company import crawl_company, company_output_path
                file_path = company_output_path(pos_name, city_name)
                existing_links = load_existing_links(file_path)
                more = crawl_company(dp, pos_name, city_name, city_code,
                                     count_limit, with_detail, detail_existing_links,
                                     detail_budget)
                for key in ('total', 'written', 'skipped', 'run_dups'):
                    total_stats[key] += more[key]
                if detail_budget is not None:
                    detail_budget = max(0, detail_budget - more.get('detail_attempted', 0))
                if with_detail and more['written'] > 0:
                    # crawl_company 内部已跑详情回填（written > 0 时），这里只报一次。
                    print(f"\n详情爬取完成: 成功 {more['written']} 条(过滤后)")
                continue

            if is_custom:
                # 关键词/城市名里的 / \ : * ? " < > | 一律换 _，否则会被当成路径分隔符
                file_path = os.path.join(ASSETS_DIR, 'post_data', 'custom',
                                         '%s_%s.csv' % (safe_filename(pos_name),
                                                        safe_filename(city_name)))
            else:
                file_path = f"{pos_path}_{city_name}.csv"

            existing_links = load_existing_links(file_path)

            if is_custom:
                stats = crawl_jobs_by_query(dp, pos_name, city_code, file_path,
                                            count_limit, existing_links, filter_query,
                                            run_seen, known=known, stats=total_stats)
            else:
                stats = crawl_jobs_by_position(dp, pos_code, city_code, file_path,
                                               count_limit, existing_links, filter_query,
                                               run_seen, known=known, stats=total_stats)

            total_stats['total'] += stats[0]
            total_stats['written'] += stats[1]
            total_stats['skipped'] += stats[2]
            total_stats['run_dups'] += stats[3]

            # 详情**不在这里**抓了，只记下这个文件 —— 理由见循环后面「详情：全局优先级分配」。
            if with_detail:
                detail_files.append(file_path)

    # ==================== 详情：全局优先级分配 ====================
    # ⛔ 这一段是修「详情覆盖率只有 9%」的核心。
    #    原来的写法是在上面那个循环里**按关键词顺序**逐个文件抓详情，每个文件消耗
    #    整轮共享预算 —— 于是排在第一个的关键词（文件最大）把 50 条额度一次吃光，
    #    后面 12 个关键词一条 JD 都拿不到（实测：运营_杭州.csv 60 行有 50 条，
    #    其余 12 个文件全是 0）。而 DETAIL_TOP_N 的注释明说"把有限的额度花在最值得
    #    看的岗位上"，detail_priority() 也的确在排序 —— 缺的只是**跨文件**这一步。
    #    现在改成两阶段：先收齐所有文件的待抓候选 → 全局按优先级排序取前 N
    #    → 再按文件回填。
    #    预算语义**完全不变**：仍然只挑 detail_budget 个 → 详情请求次数不变
    #    → 风控暴露不变（这也是为什么不需要动 DETAIL_TOP_N 的取值）。
    if with_detail and detail_files:
        if detail_budget is None or detail_budget > 0:
            chosen, total_pending, kept_n = select_detail_targets(
                detail_files, detail_existing_links, detail_budget, known=known,
                prefer=detail_prefer)
            print(f"\n{'='*50}")
            print(f"详情抓取：全轮共 {total_pending} 个岗位缺详情 → "
                  f"按全局优先级取前 {kept_n} 个（涉及 {len(chosen)} 个关键词文件）")
            if total_pending > kept_n:
                print(f"  其余 {total_pending - kept_n} 个本轮只保留列表页字段 —— "
                      f"下次采集会接着补（详情是逐轮累积的，不是丢了）")
            print(f"{'='*50}")

            succ_total = 0
            att_total = 0
            for fp, links in chosen.items():
                if not links:
                    continue
                # max_details=None：挑选已在全局那步做完，再叠一层"每文件上限"
                # 会把刚排好的全局顺序切碎（就退回老 bug 了）。
                s, a = crawl_job_details(dp, fp, detail_existing_links,
                                         max_details=None, links_filter=set(links),
                                         known=known, prefer=detail_prefer)
                detail_existing_links.update(links)
                succ_total += s
                att_total += a
                if detail_budget is not None:
                    detail_budget = max(0, detail_budget - a)
            print(f"\n详情爬取完成: 成功 {succ_total} 条 / 实际请求 {att_total} 次")
            if detail_budget is not None and detail_budget <= 0:
                print("  本轮详情额度已用完，其余岗位只保留列表页字段（避免触发风控）")
        else:
            print("\n详情额度已用完，本轮其余岗位只保留列表页字段（避免触发风控）")

    # 把「本轮真正采到的 link 清单」落到 run-dir，供工作台区分
    # 「本轮新增」与「历史累积」。
    #
    # 为什么需要它：CSV 是按关键词**跨轮累积**的（同一个 运营_杭州.csv 会被多轮
    # 追加），所以「文件 mtime」判断不了某一行是不是本轮写的 —— 采集页因此把
    # 跨轮累积的全量池说成「本批」，用户会以为那是刚采的。run_seen 是整轮共享的
    # 本轮 link 集合，正是「本轮新增」的精确定义。
    _write_round_links(run_seen)

    # 把本轮采到的 link 记进持久索引（跨轮 + 熬过「清空采集结果」）。
    # ⛔ detailed 的依据是「**扫一遍 CSV** 看哪些行 JD 非空」，而不是在详情循环里
    #    逐条记账 —— CSV 是最终落盘的事实，比中途记账可靠（失败的请求、被跳过的
    #    文件都不会污染它）。代价是一次本地小文件扫描（十几个文件 × 几十行）。
    try:
        detailed_now = known_links.collect_detailed_from_csvs(ASSETS_DIR)
        n_saved = known_links.remember(ASSETS_DIR, run_seen,
                                       detailed_links=detailed_now, already=known)
        if n_saved:
            print('[known] 已把本轮 %d 条岗位写进去重索引（下次采集不再重复抓）' % n_saved)
    except Exception as e:
        # 索引维护失败不该让采集失败 —— 下次 load() 会靠扫 CSV 恢复
        print('[known] ⚠️ 索引维护失败（不影响本次采集结果）：%s' % e)

    if total_stats.get('known_dups'):
        # 措辞要准：这些岗位被挡在**写盘**之外，同时也不再进入详情候选池 ——
        # 详情额度是全局共享且按优先级截断的，所以省下的不是"N 次请求"，
        # 而是"额度可以花在 N 条真正缺 JD 的新岗位上"。
        print('[known] 本轮 %d 条岗位以前采过且已有 JD（不再重复写盘；'
              '没有 JD 的那些仍会照常补详情）' % total_stats['known_dups'])

    return total_stats


def _write_round_links(run_seen):
    """把本轮采到的 link 写进 run-dir/state/round_links.json。

    失败不致命 —— 这只是给工作台做「本轮新增」标记用的辅助信息，
    写不进去时前端会退回「看全部」，不影响采集本身。
    """
    try:
        run_dir = _latest_run_dir()
        if not run_dir or not run_seen:
            return
        state_dir = os.path.join(run_dir, 'state')
        os.makedirs(state_dir, exist_ok=True)
        out = os.path.join(state_dir, 'round_links.json')
        tmp = out + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({
                'crawledAt': time.strftime('%Y-%m-%d %H:%M:%S'),
                'links': sorted(run_seen),
            }, f, ensure_ascii=False)
        os.replace(tmp, out)
        print(f"\n本轮新增 {len(run_seen)} 个岗位（已记录，供工作台区分新增/历史）")
    except Exception as e:
        print(f"  [提示] 本轮 link 清单写入失败（不影响采集）: {e}")


def print_crawl_summary(total_stats):
    """打印爬取完成统计（被 run_crawl_process 和 run_crawl_cli 共用）"""
    print_header("爬取完成")
    print(f"\n数据统计:")
    print(f"  获取数据: {total_stats['total']} 条")
    print(f"  写入数据: {total_stats['written']} 条")
    print(f"  跳过重复: {total_stats['skipped']} 条")

    # 把「关键词之间撞了多少」当场摆出来。这个数字高就说明关键词选成同义词了，
    # 下次该减关键词而不是加 —— 不打出来就得等事后翻 CSV 才发现。
    run_dups = total_stats.get('run_dups', 0)
    if run_dups:
        print(f"    其中跨关键词重复: {run_dups} 条"
              f"（关键词命中同一批岗位，可考虑减少关键词数量）")

    # 跨轮次 / 跨「清空采集结果」的重复。和上面那个是**两回事**：
    #   · run_dups   = 本轮自己的两个关键词撞了 → 该减少关键词
    #   · known_dups = 撞上了**历史**采过的岗位 → 说明这批关键词/城市已经采过，
    #                  下轮该换关键词或换城市，而不是重复跑一遍
    known_dups = total_stats.get('known_dups', 0)
    if known_dups:
        print(f"    其中历史采过且已有 JD: {known_dups} 条"
              f"（该拿的都拿到了，这次不再碰；换关键词/城市能拿到更多新岗位）")

    time_stats.print_summary()


def auto_refresh_requirements(with_detail):
    """爬取结束后增量刷新岗位权威要求缓存（assets/job_requirements.json）。

    只在本轮爬了详情时跑 —— 没 JD（岗位要求和职责）的话无从抽。增量逻辑见
    perform_extraction：已缓存 link 跳过，仅把「新采到 JD 且没抽过」的补进缓存。

    LLM 阶段是独立、可缺失的：配置没配、请求失败都只打印告警，绝不向上抛、
    绝不拖垮本轮爬取本身。退出码非 0 时提示未刷新岗位评分将回退卡片标签。
    """
    if not with_detail:
        print('\n[要求] 本轮未爬详情（无 JD 可抽），跳过权威要求增量刷新')
        return
    print('\n[要求] 爬取结束，增量刷新岗位权威要求…')
    try:
        from stages.run_requirements import perform_extraction
        rc = perform_extraction()
        if rc != 0:
            print(f'  ⚠️ 权威要求增量刷新未完全成功（退出码 {rc}），'
                  f'未刷新的岗位评分将回退卡片标签')
    except Exception as exc:
        # 配置缺失 / 网络 / 依赖任何一处出错都不该让爬取结果丢失。
        print(f'  ⚠️ 权威要求增量刷新失败（不影响本次爬取）：{exc}')


# ==================== 交互式爬取流程 ====================


def run_crawl_process():
    """执行完整的交互式爬取流程（支持返回上一步）"""
    from .config import sleep_config as sc
    from .data_loader import load_position_data, load_city_data
    from .menu import (
        show_position_mode_menu, input_custom_position, input_company_names,
        show_position_menu, show_city_menu, ask_crawl_count, ask_detail_option,
        ask_sleep_option, ask_filter_options, show_summary_and_confirm,
    )
    from .state import step_manager
    from .utils import build_filter_query_string

    # 重置状态
    step_manager.reset()
    time_stats.reset()
    step_manager.next_step()  # 进入步骤1

    # 1. 加载数据
    position_data = load_position_data()
    city_data = load_city_data()

    if not position_data:
        print("岗位数据加载失败，请先更新数据")
        return

    if not city_data['hot'] and not city_data['other']:
        print("城市数据加载失败，请先更新数据")
        return

    # 2-7. 交互式选择流程
    while True:
        mode = show_position_mode_menu()
        if mode == 'back':
            return

        if mode == 'custom':
            keywords = input_custom_position()
            if keywords == 'back':
                step_manager.go_back()
                continue
        elif mode == 'company':
            companies = input_company_names()
            if companies == 'back':
                step_manager.go_back()
                continue
        else:
            positions = show_position_menu(position_data)
            if positions == 'back':
                step_manager.go_back()
                continue

        cities = show_city_menu(city_data)
        if cities == 'back':
            step_manager.go_back()
            continue

        count_limit = ask_crawl_count()
        if count_limit == 'back':
            step_manager.go_back()
            continue

        with_detail = ask_detail_option()
        if with_detail == 'back':
            step_manager.go_back()
            continue

        sleep_enabled = ask_sleep_option()
        if sleep_enabled == 'back':
            step_manager.go_back()
            continue

        filter_result = ask_filter_options()
        if filter_result == 'back':
            step_manager.go_back()
            continue

        result = show_summary_and_confirm()
        if result == 'back':
            step_manager.go_back()
            continue
        elif result == 'cancel':
            print("已取消爬取")
            return
        elif result == 'confirm':
            break

    # 获取最终选择
    selections = step_manager.selections
    positions = selections['positions']
    cities = selections['cities']
    count_limit = selections['count_limit']
    with_detail = selections['with_detail']
    sleep_enabled = selections['sleep_enabled']
    is_custom = selections['mode'] == 'custom'
    is_company = selections['mode'] == 'company'
    filter_params = selections.get('filter_params', {})
    filter_query = build_filter_query_string(filter_params)

    sc.set_enabled(sleep_enabled)

    # 8. 开始爬取
    print_header("开始爬取")
    time_stats.start()

    dp = WebPage(chromium_options=co)
    apply_stealth(dp)

    total_stats = execute_crawl_iteration(
        dp, positions, cities, is_custom, count_limit, with_detail, filter_query,
        is_company=is_company
    )

    dp.quit()
    time_stats.stop()
    print_crawl_summary(total_stats)
    auto_refresh_requirements(selections['with_detail'])


# ==================== CLI 模式爬取 ====================

def run_crawl_cli(args):
    """CLI模式：使用命令行参数直接爬取，无需交互"""
    from .config import sleep_config as sc
    from .data_loader import load_position_data, load_city_data, find_positions_by_name, find_cities_by_name
    from .utils import _expand_arg, build_filter_query_string, format_filter_display, resolve_filter_values, entry_cmd

    time_stats.reset()

    # 1. 加载数据
    position_data = load_position_data()
    city_data = load_city_data()

    if not position_data:
        print("岗位数据加载失败，请先运行 --update-data 更新数据")
        return

    if not city_data['hot'] and not city_data['other']:
        print("城市数据加载失败，请先运行 --update-data 更新数据")
        return

    # 2. 展开参数
    pos_names = _expand_arg(args.positions)
    city_names = _expand_arg(args.cities)

    if not pos_names:
        print("错误: 请通过 --position/-p 指定至少一个岗位名称或搜索关键词")
        return

    if not city_names:
        print("错误: 请通过 --city/-c 指定至少一个城市")
        return

    # 3. 解析位置
    is_custom = args.mode == 'custom'
    is_company = args.mode == 'company'

    if is_custom or is_company:
        positions = [(None, None, name) for name in pos_names]
    else:
        positions = find_positions_by_name(position_data, pos_names)

    if not positions:
        print("错误: 未匹配到任何岗位，请检查名称")
        return

    # 4. 解析城市
    cities = find_cities_by_name(city_data, city_names)
    if not cities:
        print("错误: 未匹配到任何城市，请检查名称")
        return

    # 5. 解析其他设置
    count_limit = args.count if args.count > 0 else None
    with_detail = args.detail
    sleep_enabled = not args.no_sleep

    sc.set_enabled(sleep_enabled)

    # 5.5. 解析筛选条件
    filter_params = {
        'jobType': resolve_filter_values(_expand_arg(args.job_types), 'jobType'),
        'salary': resolve_filter_values(_expand_arg(args.salaries), 'salary'),
        'experience': resolve_filter_values(_expand_arg(args.experiences), 'experience'),
        'degree': resolve_filter_values(_expand_arg(args.degrees), 'degree'),
        'scale': resolve_filter_values(_expand_arg(args.scales), 'scale'),
        'stage': resolve_filter_values(_expand_arg(args.stages), 'stage'),
    }
    filter_query = build_filter_query_string(filter_params)

    # 6. 显示摘要
    total_items, total_time = estimate_time(positions, cities, count_limit, with_detail)

    print_header("爬取信息摘要")
    mode_text = '公司定向' if is_company else ('关键词搜索' if is_custom else '列表选择')
    print(f"\n  模式: {mode_text}")
    label = '公司名' if is_company else ('关键词' if is_custom else '岗位')
    print(f"  {label}: {', '.join(p[2] for p in positions)}")
    print(f"  城市: {', '.join(c[0] for c in cities)}")
    print(f"  数量限制: {count_limit if count_limit else '全部'}")
    print(f"  爬取详情: {'是' if with_detail else '否'}")
    print(f"  请求等待: {'开启' if sleep_enabled else '关闭'}")
    filter_display = format_filter_display(filter_params)
    if filter_display != '不限':
        print(f"  筛选条件: {filter_display}")
    print(f"  预计数据量: 约 {total_items} 条")
    print(f"  预计耗时: 约 {max(1, math.ceil(total_time))} 分钟")

    if not args.yes:
        try:
            confirm = input("\n确认开始爬取? (y/n): ").strip().lower()
        except EOFError:
            print("\n无法读取输入，使用 -y 跳过确认")
            return
        if confirm != 'y':
            print("已取消爬取")
            return

    # 7. 打开浏览器并检测登录（单次检测，不轮询）
    print_header("打开浏览器")

    dp = WebPage(chromium_options=co)
    apply_stealth(dp)

    print("\n[登录检测] 正在打开 BOSS 直聘首页...")
    dp.get('https://www.zhipin.com/web/geek/jobs')

    if not check_login_status(dp):
        print("\n" + "=" * 50)
        print("  [LOGIN_NEEDED] 未检测到登录状态")
        print("=" * 50)
        print()
        print("  请先运行 %s 完成登录。" % entry_cmd('--ensure-login'))
        print("  登录完成后，再次运行爬取命令即可。")
        print()
        print("=" * 50)
        dp.quit()
        return

    print("\n[OK] 登录状态已确认，开始爬取...")

    # 8. 开始爬取
    print_header("开始爬取")
    time_stats.start()

    total_stats = execute_crawl_iteration(
        dp, positions, cities, is_custom, count_limit, with_detail, filter_query,
        is_company=is_company,
        # 详情优先方向词：**直接透传**用户填的「期望岗位」，不做任何转换/推导。
        # 不传（None）时 execute_crawl_iteration 里的排序口径与加这个参数之前逐字一致。
        detail_prefer=_expand_arg(getattr(args, 'detail_prefer', None)),
        # 是否重新采集历史已采岗位（勾选「采集已采过岗位」时置 True → known=None）。
        include_known=bool(getattr(args, 'include_known', False)),
    )

    dp.quit()
    time_stats.stop()
    print_crawl_summary(total_stats)
    auto_refresh_requirements(with_detail)

    # 把爬取统计落到 run-dir，供 Claude 主代理在爬取后读取，判断是否达到最低岗位数量。
    # 主代理读不到 stdout（后台任务），所以这里显式写盘；crawl_summary.json 是约定的文件名。
    run_dir = getattr(args, 'run_dir', None)
    if run_dir:
        try:
            os.makedirs(os.path.dirname(crawl_summary_path(run_dir)), exist_ok=True)
            with open(crawl_summary_path(run_dir), 'w', encoding='utf-8') as f:
                json.dump({
                    'written': total_stats.get('written', 0),
                    'total': total_stats.get('total', 0),
                    'skipped': total_stats.get('skipped', 0),
                    'run_dups': total_stats.get('run_dups', 0),
                    # 跨关键词文件 / 跨轮次 / 跨「清空采集结果」的重复（见 known_links）。
                    # 单独一个键，不并进 run_dups —— 那个口径用于提前退出，不能动。
                    'known_dups': total_stats.get('known_dups', 0),
                }, f, ensure_ascii=False, indent=2)
        except OSError as e:
            print(f"[警告] 写入爬取统计失败: {e}")
