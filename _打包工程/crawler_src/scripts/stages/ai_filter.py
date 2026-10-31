#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""采中 AI 筛选（P2）：把采回来的岗位按「求职方向」逐批判定相关度。

**默认关闭，且只打标、不删数据。** 这两条是刻意的：

为什么只打标不删
----------------
采中过滤掉就**不落盘**，而误判无法回滚 —— 用户不会知道自己丢了什么岗位。
所以这里产出的是 `intermediate/ai_filter.json`（link → 判定），下游
（`run_matcher.py`）读它来**降权/剔除**，原始 CSV 一个字节都不动。
想撤销：删掉那份 json 再跑，行为立刻回到"没有这一步"。

为什么默认关闭
--------------
本步骤按批调模型：真实采集动辄上百条，一开就跑会：
  ① 花钱且用户看不见（采集是后台任务）；
  ② 拉长单轮采集时长 → 提高风控暴露面（采集本身已被限速）。
所以它必须由用户显式 `--to filter` / `--ai-filter` 打开。

批量而不是逐条
--------------
一次请求判 N 条（默认 20）。逐条调用在 100+ 岗位时是十几元级开销，且请求数
翻百倍 —— 与「降低风控暴露」的目标直接冲突。

失败策略：**任何一批失败都不阻断流水线**
----------------------------------------
本步骤的退出码只表达"我有没有把结果写出来"：
  0 = 跑完了（可能有若干批失败，细节在输出里）
  1 = 前置条件不满足（没岗位数据 / 没简历画像 / 模型配置缺失）
⛔ 绝不因为某一批模型调用失败就让整轮采集白跑 —— 那是最贵的失败方式。

用法：
    python scripts/stages/ai_filter.py <run_dir>
    python scripts/stages/ai_filter.py <run_dir> --batch 20 --dry-run
    python scripts/stages/ai_filter.py <run_dir> --top 60
"""

import os
import sys
import json
import argparse
from datetime import date

_SCRIPTS = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, _SCRIPTS)

from llm import (ConfigError, LLMError, chat_json, resolve,
                 format_usage, reconfigure_stdout)
from resume_matcher.paths import intermediate_dir, profile_path
from resume_matcher.data_loader import list_available_job_files, load_job_data

# 每批送多少条。20 是「上下文够长」与「一次别吐太多 JSON」的折中；
# 太大容易触发模型的输出长度上限，太小则请求数翻倍（成本和风控都翻倍）。
DEFAULT_BATCH = 20

# 单条 JD 截断：给模型看开头足够判相关度，长 JD 会把上下文吃满。
JD_SLICE = 400

# 判定取值。与前端 js/ai-collect.js 保持同一套词汇（两处跑的是同一个判断逻辑）。
VERDICTS = ('relevant', 'irrelevant', 'uncertain')

# ⛔ 这是一份**新**提示词，与前端 ai-collect.js 的 SYS 刻意保持语义一致，
#    但**不共用文件**：前端跑在浏览器（file:// 直开也能用），后端跑在 Python，
#    强行共用需要一起打包/一起部署，反而让两边都更脆。
#    修改判定口径时**两边都要改** —— 这是本条注释存在的唯一理由。
SYSTEM_PROMPT = (
    '你是求职岗位筛选助手。用户会给你一批岗位摘要和求职者方向，逐条判断。\n\n'
    '1. 只依据给到的信息判断。信息不足（JD 为空或太短）就填 uncertain，**不要猜**。\n'
    '2. verdict 只有三个值：relevant（方向对口）/ irrelevant（明显不对口）'
    '/ uncertain（信息不足或边界情况）。\n'
    '3. tags 从这些里选（可多选，没有就空数组）：外包嫌疑 / 派遣 / 急招 / 大厂 / 初创'
    '/ 远程 / 销售岗 / 技术岗 / 国企 / 驻场。只有原文有依据才打标。\n'
    '4. mustHave 是**硬性门槛**（学历/年限/必备技能），从 JD 原文抄，不要自己编。\n'
    '5. reason 控制在 20 字内，写清判断依据。\n'
    '6. 严格只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。\n'
    '7. 全部输出用简体中文。'
)


def build_user_prompt(profile, jobs):
    """拼一条批量判定请求。jobs 是 [(idx, 岗位 dict)]。"""
    direction = _direction_of(profile)
    cities = '、'.join(_as_text_list(profile.get('basic_info', {}).get('expected_city')
                                    or profile.get('basic_info', {}).get('city')))
    salary = _salary_of(profile)
    compact = []
    for idx, job in jobs:
        compact.append({
            'idx': idx,
            'title': str(job.get('职位') or '').strip(),
            'company': str(job.get('公司') or '').strip(),
            'jd': str(job.get('岗位要求和职责') or '')[:JD_SLICE],
        })
    return (
        '求职者方向：%s\n'
        '期望城市：%s\n'
        '期望薪资：%s\n\n'
        '岗位列表（JSON 数组，每条有 idx / title / company / jd）：\n'
        '%s\n\n'
        '请按下面格式输出（results 必须与输入条数一致，idx 一一对应）：\n'
        '{"results":[{"idx":0,"verdict":"relevant|irrelevant|uncertain",'
        '"tags":["外包嫌疑"],"mustHave":["3年经验","Python"],'
        '"reason":"20字内依据"}]}'
    ) % (direction or '未提供', cities or '未提供', salary or '未提供',
         json.dumps(compact, ensure_ascii=False))


def _as_text_list(value):
    if isinstance(value, (list, tuple)):
        return [str(v).strip() for v in value if str(v).strip()]
    if isinstance(value, str) and value.strip():
        return [value.strip()]
    return []


def _direction_of(profile):
    """求职方向：优先 expected_position，退回 keywords。"""
    basic = profile.get('basic_info') or {}
    pos = _as_text_list(basic.get('expected_position'))
    if pos:
        return '、'.join(pos)
    return '、'.join(_as_text_list(profile.get('keywords')))


def _salary_of(profile):
    exp = profile.get('salary_expectation') or {}
    low = exp.get('min') or exp.get('salary_min')
    high = exp.get('max') or exp.get('salary_max')
    if low and high:
        return '%sK-%sK' % (low, high)
    if low:
        return '%sK以上' % low
    return ''


def _job_key(job):
    """岗位的唯一键。与 server.py 的 load_jobs 去重口径一致：link 优先，退回 公司+岗位。

    ⛔ 不用 idx：idx 只在单批内有意义，换个批次顺序就错位。
      link 是爬虫落盘的稳定标识，重跑同一批数据时也能对上。
    """
    link = str(job.get('link') or job.get('url') or '').strip()
    if link:
        return link
    return '%s||%s' % (str(job.get('公司') or '').strip(),
                       str(job.get('职位') or '').strip())


def judge_batch(profile, batch, cfg, run_dir):
    """判一批。返回 (results_by_idx, usage_text) ；失败抛 LLMError（由调用方记失败）。"""
    prompt = build_user_prompt(profile, batch)
    data = chat_json(prompt, system=SYSTEM_PROMPT, stage='filter',
                     run_dir=run_dir, cfg=cfg)
    if not isinstance(data, dict):
        raise LLMError('返回的不是 JSON 对象')
    results = data.get('results')
    if not isinstance(results, list):
        raise LLMError('返回的 JSON 里没有 results 数组')

    by_idx = {}
    for item in results:
        if not isinstance(item, dict):
            continue
        idx = item.get('idx')
        if not isinstance(idx, int):
            continue
        verdict = str(item.get('verdict') or '').strip().lower()
        if verdict not in VERDICTS:
            verdict = 'uncertain'        # 认不出的判定按「待定」，不当成淘汰
        tags = [str(t).strip() for t in (item.get('tags') or []) if str(t).strip()]
        must = [str(t).strip() for t in (item.get('mustHave') or []) if str(t).strip()]
        by_idx[idx] = {
            'verdict': verdict,
            'tags': tags,
            'mustHave': must,
            'reason': str(item.get('reason') or '').strip()[:60],
        }
    return by_idx


def summarize(marks):
    """统计判定分布。marks 是 {key: {verdict,...}}。"""
    counts = {v: 0 for v in VERDICTS}
    tagged = 0
    for item in marks.values():
        counts[item.get('verdict', 'uncertain')] = \
            counts.get(item.get('verdict', 'uncertain'), 0) + 1
        if item.get('tags'):
            tagged += 1
    return {'total': len(marks), 'tagged': tagged, **counts}


def main(argv=None):
    reconfigure_stdout()
    ap = argparse.ArgumentParser(
        prog='ai_filter.py',
        description='采中 AI 筛选：按求职方向逐批判定岗位相关度。'
                    '**只打标不删数据** —— 原始 CSV 不动，判定单独落一份 json。',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='退出码：0 = 跑完（可能有若干批失败），1 = 前置条件不满足。\n'
               '本步骤默认不跑，需要显式 --to filter 或 --ai-filter 才会执行。\n')
    ap.add_argument('run_dir', help='运行目录（含 state/profile.json 与 assets/post_data）')
    ap.add_argument('--batch', type=int, default=DEFAULT_BATCH,
                    help='每批判多少条（默认 %d）' % DEFAULT_BATCH)
    ap.add_argument('--top', type=int, default=0,
                    help='只判前 N 条（0 = 全部）。想省钱又只想看最相关的就用它')
    ap.add_argument('--dry-run', action='store_true',
                    help='只打印会判多少条、怎么分批，不请求模型')
    ap.add_argument('--force', action='store_true',
                    help='已有 ai_filter.json 也重跑（默认跳过，避免重复花钱）')
    ap.add_argument('--model')
    ap.add_argument('--base-url')
    ap.add_argument('--api-key')
    args = ap.parse_args(argv)

    run_dir = os.path.abspath(args.run_dir)

    # ── 前置：简历画像 ──
    ppath = profile_path(run_dir)
    if not os.path.exists(ppath):
        print('❌ 找不到简历画像：%s' % ppath)
        print('  采中筛选要知道「求职方向」才能判。先跑 parse 阶段。')
        return 1
    try:
        with open(ppath, encoding='utf-8') as f:
            profile = json.load(f)
    except (OSError, ValueError) as exc:
        print('❌ profile.json 读不动：%s' % exc)
        return 1

    # ── 前置：岗位数据 ──
    job_files = list_available_job_files()
    if not job_files:
        print('❌ 还没有采集结果（assets/post_data/ 下没有 CSV）')
        print('  先跑采集：python scripts/pipeline.py --from crawl')
        return 1

    csv_paths = [jf['path'] for jf in job_files]
    jobs = load_job_data(csv_paths)
    if not jobs:
        print('❌ 岗位数据为空（CSV 都在，但没读出任何岗位）')
        return 1

    # 去重：同一岗位会命中多个关键词、各写一份 CSV
    seen, unique = set(), []
    for job in jobs:
        key = _job_key(job)
        if not key or key in seen:
            continue
        seen.add(key)
        unique.append(job)

    if args.top and args.top > 0:
        unique = unique[:args.top]

    batch_size = max(1, args.batch)
    batches = [unique[i:i + batch_size] for i in range(0, len(unique), batch_size)]

    out_path = os.path.join(intermediate_dir(run_dir), 'ai_filter.json')
    if os.path.exists(out_path) and not args.force and not args.dry_run:
        print('○ 已经有 %s' % out_path)
        print('  跳过（不重复花钱）。要重跑：--force')
        return 0

    print('=' * 60)
    print('采中 AI 筛选（只打标，不删数据）')
    print('=' * 60)
    print('岗位总数：%d（去重后 %d）' % (len(jobs), len(unique)))
    print('分批    ：%d 批 × 最多 %d 条' % (len(batches), batch_size))
    print('求职方向：%s' % (_direction_of(profile) or '（没读到，判断会偏保守）'))

    if args.dry_run:
        for i, batch in enumerate(batches, 1):
            print('  批 %d：%d 条（首个：%s）'
                  % (i, len(batch), str(batch[0].get('职位') or '')[:24]))
        print('\n--dry-run：未请求模型。')
        return 0

    # ── 模型配置 ──
    overrides = {k: v for k, v in
                 (('model', args.model), ('base_url', args.base_url),
                  ('api_key', args.api_key)) if v}
    try:
        cfg = resolve(stage='filter', **overrides)
    except ConfigError as exc:
        print('❌ 模型配置错误：\n%s' % exc)
        return 1

    marks = {}
    failed = 0
    for bi, batch in enumerate(batches, 1):
        print('\n▶ 批 %d / %d（%d 条）…' % (bi, len(batches), len(batch)))
        try:
            by_idx = judge_batch(profile, list(enumerate(batch)), cfg, run_dir)
        except LLMError as exc:
            # ⛔ 单批失败**不中断**：这一批的岗位就是「没有判定」，
            #    下游按 uncertain 处理，与「没跑过这一步」等价。
            failed += 1
            print('  ⚠ 这一批失败：%s' % exc)
            print('    这些岗位保持「无判定」，其余批次照常。')
            continue

        got = 0
        for idx, job in enumerate(batch):
            result = by_idx.get(idx)
            if not result:
                continue        # 模型漏回某条 → 该条算「无判定」，不编造
            key = _job_key(job)
            if not key:
                continue
            result['title'] = str(job.get('职位') or '')[:40]
            result['company'] = str(job.get('公司') or '')[:40]
            marks[key] = result
            got += 1
        print('  ✓ %d / %d 条有判定' % (got, len(batch)))

    if not marks:
        print('\n❌ 一条判定都没拿到（%d 批全失败）。没有写文件。' % failed)
        print('  排查：python scripts/utils/llm_check.py --call  看模型端点通不通。')
        return 1

    payload = {
        'generated_at': date.today().isoformat(),
        'source_jobs': len(jobs),
        'unique_jobs': len(unique),
        'judged': len(marks),
        'failed_batches': failed,
        'batches': len(batches),
        'summary': summarize(marks),
        'marks': marks,
    }
    os.makedirs(os.path.dirname(out_path), exist_ok=True)
    # 原子写：写一半断电会留下半份 json，下游读它就是「判定全丢了」。
    tmp = out_path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, out_path)

    s = payload['summary']
    print('\n' + '=' * 60)
    print('采中筛选完成：%d 条有判定' % len(marks))
    print('  对口 %d / 不对口 %d / 待定 %d（带标签 %d）'
          % (s['relevant'], s['irrelevant'], s['uncertain'], s['tagged']))
    if failed:
        print('  ⚠ %d / %d 批失败（那些岗位无判定，可 --force 重跑）'
              % (failed, len(batches)))
    print('  落盘：%s' % out_path)
    print('\n⚠ 判定**只打标、没删任何数据**。原始 CSV 原样保留。')
    print('  下游（run_matcher）会读它做降权；想撤销就删掉上面那个 json。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
