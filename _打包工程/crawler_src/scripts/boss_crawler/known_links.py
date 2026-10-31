#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""全局「已知岗位 link」集合 —— 跨关键词、跨轮次、跨「清空采集结果」。

===== 为什么需要这个模块 =====

采集器原本只有两个去重集合，**都看不见历史**：

  · `existing_links` —— `load_existing_links(file_path)`，**只读当前这一个 CSV 文件**
  · `run_seen`       —— 每轮运行 `run_seen = set()` **从零新建，不落盘**

于是这些岗位会被反复采集：

  ① 换了一个新关键词 → 落到**另一个同名规则的文件**（`post_data/custom/{关键词}_{城市}.csv`）
     → 新文件的 `existing_links` 是空的 → 上一轮采过的岗位被重新采一遍
  ② 点了「清空采集结果」→ `server.clear_results()` 把 `post_data/` 整个
     `shutil.move` 进 `results-archive/<时间戳>/` 并重建空目录
     → `existing_links` 变空 → **连详情一起重采**

而用户的**岗位库里明明有这些岗位**，却帮不上忙 —— 因为岗位库在浏览器的
localStorage 里，采集器完全读不到。`server.py` 的注释自己写着：
「岗位库完全不受影响：已导入的数据在浏览器的 localStorage 里，**从来没有经过这些文件**」。

后果不是"数据错"，而是**纯浪费** + 更糟的**隐性伤害**：

  · 翻页要重跑（每个关键词 × 每个城市）
  · 详情要重抓 —— `PER_DETAIL_TIME = 5` 秒/条，而且**详情请求同样消耗 BOSS 风控额度**
    （`config` 注释：约 200 个详情就触发风控）。**已知岗位正在吃掉本该给新岗位的额度。**
  · 用户会以为「重采一遍能把新信息更新进来」，但 `store.mergeJobInto()` 是「先写的赢」，
    重采回来的新值会被**静默丢弃** → 白采。

===== 这个模块补的那一层 =====

一个**全局已知集**，来源三处，任一命中即算已知：

  1. `assets/post_data/**/*.csv`        ← 当前累积的采集结果
  2. `assets/results-archive/**/*.csv`  ← 点过「清空采集结果」被归档走的那批
  3. `assets/known_links.jsonl`         ← 本模块维护的持久索引

第 3 条是关键：`clear_results()` 只移动 `post_data`（以及运行目录里的
`qualified_jobs.json` / `scored_jobs.json` / `run_post_data`），**不会碰这个文件**。
所以即使归档被手动删掉，已采过的 link 也不会丢 —— 这才是「清空采集结果」之后
仍然不重复采集的保证。

===== ⛔ 两条不能碰的红线 =====

1. **不改 `run_dups` 的口径。** `should_skip_remaining_pages()` 用
   `run_dups / page_size >= DUP_PAGE_RATIO(0.8)` 决定「这个关键词该不该跳过」。
   它**只看本轮 `run_seen`**，理由写在 `config.DUP_PAGE_RATIO` 注释里：
   用总重复数会让「文件里已有 200 行时第 1 页 100% 命中旧数据」立刻 break，
   再也翻不到后面的新岗位。
   ⇒ 本模块的命中**单独计数**（`known_dups`），**绝不**并进 `run_dups`。

2. **「已知」和「已有详情」是两个集合，用错哪个都会出事。**
   `known.all` 含**每一个**写进过 CSV 的 link（包括当前这个文件里的行）；
   `known.detailed` 只含**JD 非空**的那些。

   · **详情阶段**必须用 `detailed`。若用 `all`，会把「本文件里 JD 还空着的行」
     全判成"已有详情" → **一条详情都不会再抓**。
   · **写盘阶段**也必须用 `detailed`（不是 `all`）—— 这条更隐蔽：
     下游详情阶段的门槛是「本轮这个文件写了新行才去抓细节」。把「见过但还没 JD」
     的岗位拦在写盘之外，它就再也不会出现在任何文件里 → 永远进不了详情候选
     → **JD 永远补不上**。

   ⇒ 一句话：**只有「已经拿到 JD」才算真的没东西可补。**
     判断标准统一成 `has_detail()`。
"""

import json
import os
import time

from .config import ENCODING

INDEX_NAME = 'known_links.jsonl'

# 归档目录最多读多少行就停。正常场景（十几个关键词 × 几十条 × 十几轮）远达不到，
# 这个上限是给「归档攒了很多年」的极端情况兜底 —— 宁可少扫一点，也不要让
# 「开始采集」卡在一个几十万行的扫描上。索引文件已经兜住了绝大部分场景。
ARCHIVE_ROW_CAP = 200000


class Known(object):
    """全局已知集。`all` = 见过；`detailed` = 已有 JD 正文。"""

    __slots__ = ('all', 'detailed', '_overflow')

    def __init__(self, all_links=None, detailed=None):
        self.all = all_links if all_links is not None else set()
        self.detailed = detailed if detailed is not None else set()
        # 归档扫描是否因为超过 ARCHIVE_ROW_CAP 而提前中断（给上层打印提示用）
        self._overflow = False

    def has(self, link):
        return link in self.all

    def has_detail(self, link):
        return link in self.detailed

    def __len__(self):
        return len(self.all)


def _link_of(row):
    """从 CSV 一行里取 link（没有/空白返回空串）。"""
    v = row.get('link')
    return (v or '').strip() if isinstance(v, str) else ''


def _scan_csv(path, budget, sink_all, sink_detailed):
    """读一个 CSV，把 link 收进两个集合。返回本次读了多少行。

    budget: 剩余可读行数（None = 不限）。<= 0 时直接返回 0（不再打开文件）。
    """
    if budget is not None and budget <= 0:
        return 0
    n = 0
    try:
        import csv as _csv
        with open(path, 'r', encoding=ENCODING, newline='') as f:
            for row in _csv.DictReader(f):
                n += 1
                link = _link_of(row)
                if link:
                    sink_all.add(link)
                    # 「岗位要求和职责」非空 = 这条已经有 JD 正文
                    if (row.get('岗位要求和职责') or '').strip():
                        sink_detailed.add(link)
                if budget is not None and n >= budget:
                    break
    except Exception:
        # 单个文件读不动（被占用 / 编码怪 / 半截文件）就跳过，绝不因此中断采集
        return n
    return n


def _iter_csvs(root):
    """把 root 下所有 .csv 递归列出来（不保证顺序）。"""
    if not os.path.isdir(root):
        return
    for dirpath, _dirnames, filenames in os.walk(root):
        for fn in filenames:
            if fn.lower().endswith('.csv'):
                yield os.path.join(dirpath, fn)


def _read_index(path):
    """读持久索引。返回 {link: has_detail}。坏行跳过（append-only 文件可能半截）。"""
    out = {}
    if not os.path.exists(path):
        return out
    try:
        with open(path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except ValueError:
                    continue                       # 半截行 / 脏行 → 跳过，不中断
                lk = rec.get('link')
                if not isinstance(lk, str) or not lk:
                    continue
                # 同一条可以出现多次（先 false 后 true）→ **后面赢**（取或）
                out[lk] = bool(out.get(lk)) or bool(rec.get('detail'))
    except Exception:
        return out
    return out


def _write_index(path, all_links, detailed):
    """整份写出索引（自举用）。返回写了多少条。失败不致命（下次再自举）。"""
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        now = int(time.time())
        with open(path, 'w', encoding='utf-8', newline='\n') as f:
            for link in sorted(all_links):
                f.write(json.dumps({'link': link, 'detail': link in detailed, 'at': now},
                                   ensure_ascii=False) + '\n')
    except Exception as e:
        print('[known] ⚠️ 索引自举写入失败（不影响本次采集）：%s' % e)
        return 0
    return len(all_links)


def load(assets_dir, verbose=True, bootstrap=True):
    """汇总全局已知集。

    读取顺序（先便宜的、后权威的，最终取并集）：
      1. known_links.jsonl          ← 持久索引，跨轮 + 熬过「清空采集结果」
      2. post_data/**/*.csv         ← 当前结果（权威：行里有没有 JD 一目了然）
      3. results-archive/**/*.csv   ← 归档（只在索引缺失时扫，且有行数上限）

    bootstrap：索引文件不存在时**就地建一份**。⛔ 这不是可有可无的优化 ——
      `remember()` 是幂等的（已经知道的 link 不再追加），所以当所有 link 都来自
      本轮 CSV 扫描时，索引**永远不会被创建**，它就没法在「清空采集结果」之后
      充当唯一凭据（那时只剩归档可查，而归档目录是用户可以随手删掉的）。
      自举保证从第一次运行起索引就是全量的。

    Returns:
        Known 实例（永远返回对象，不返回 None —— 调用方不必到处判空）
    """
    k = Known()

    if not assets_dir or not os.path.isdir(assets_dir):
        return k

    # ---- 1. 持久索引 ----
    idx_path = os.path.join(assets_dir, INDEX_NAME)
    index_existed = os.path.exists(idx_path)
    idx = _read_index(idx_path)
    for link, has_detail in idx.items():
        k.all.add(link)
        if has_detail:
            k.detailed.add(link)

    # ---- 2. 当前结果（总是扫：便宜，且是「有没有 JD」的权威来源）----
    for fp in _iter_csvs(os.path.join(assets_dir, 'post_data')):
        _scan_csv(fp, None, k.all, k.detailed)

    # ---- 3. 归档 ----
    # 索引已经兜住了「已采过的 link」，所以归档扫描只是**重建兜底**：
    # 只在索引还没建立起来时全扫一遍，建立之后就跳过 —— 避免归档越攒越多、
    # 每次开始采集都要扫几十万个文件。极端情况下还有 ROW_CAP 兜底。
    archive_root = os.path.join(assets_dir, 'results-archive')
    if not index_existed and os.path.isdir(archive_root):
        left = ARCHIVE_ROW_CAP
        for fp in _iter_csvs(archive_root):
            used = _scan_csv(fp, left, k.all, k.detailed)
            left -= used
            if left <= 0:
                k._overflow = True
                break

    # ---- 4. 索引自举（见 docstring：这不是优化，是正确性的一部分）----
    if bootstrap and not index_existed and k.all:
        n = _write_index(idx_path, k.all, k.detailed)
        if verbose and n:
            print('[known] 首次建立去重索引：%d 条（以后「清空采集结果」也不会重复采集）' % n)

    if verbose:
        print('[known] 全局已知岗位 %d 条（其中已有 JD %d 条）'
              % (len(k.all), len(k.detailed)))
        if k._overflow:
            print('[known] ⚠️ 归档扫描达到上限 %d 行后停止；'
                  '强烈建议保留 %s（它不受「清空采集结果」影响）'
                  % (ARCHIVE_ROW_CAP, INDEX_NAME))
    return k


def remember(assets_dir, links, detailed_links=None, already=None, verbose=True):
    """把本轮的 link 追加进持久索引（append-only）。

    ⛔ 为什么是追加而不是重写：重写要读全量再写回，一旦中途失败（磁盘满 / 被 kill）
       会把索引整份弄坏；追加最坏只丢最后一行，而坏行在 `_read_index` 里会被跳过。

    Args:
        links:          本轮见到/写出的 link（iterable）
        detailed_links: 其中**已经有 JD 正文**的那些（iterable，可为 None）
        already:        已知集（Known）。传了就不重复追加已知项，避免文件无限膨胀。

    Returns:
        实际追加的条数
    """
    if not assets_dir or not os.path.isdir(assets_dir):
        return 0
    det = set(detailed_links or ())
    known_all = getattr(already, 'all', None) if already is not None else None
    known_det = getattr(already, 'detailed', None) if already is not None else None

    rows = []
    seen_now = set()
    now = int(time.time())
    for link in (links or ()):
        if not isinstance(link, str) or not link:
            continue
        if link in seen_now:
            continue
        seen_now.add(link)
        has_detail = link in det
        # 已经记过同样的状态 → 不再追加（防膨胀）
        if known_all is not None and link in known_all:
            if not has_detail or (known_det is not None and link in known_det):
                continue
        rows.append({'link': link, 'detail': bool(has_detail), 'at': now})

    if not rows:
        return 0

    path = os.path.join(assets_dir, INDEX_NAME)
    try:
        with open(path, 'a', encoding='utf-8', newline='\n') as f:
            for r in rows:
                f.write(json.dumps(r, ensure_ascii=False) + '\n')
    except Exception as e:
        # 索引写不进去不该让采集失败 —— 下次靠 CSV 重扫也能恢复
        if verbose:
            print('[known] ⚠️ 索引写入失败（不影响本次采集）：%s' % e)
        return 0

    # 顺手更新内存里的集合，避免同一轮内重复追加
    if known_all is not None:
        known_all.update(seen_now)
    if known_det is not None:
        known_det.update(l for l in seen_now if l in det)
    return len(rows)


def collect_detailed_from_csvs(assets_dir):
    """扫一遍当前结果，返回「已有 JD 正文」的 link 集合。

    给「一轮跑完之后，把本轮真正拿到详情的 link 记进索引」用。
    比在详情循环里逐条追踪更可靠 —— CSV 是最终落盘的事实。
    """
    out = set()
    if not assets_dir or not os.path.isdir(assets_dir):
        return out
    for fp in _iter_csvs(os.path.join(assets_dir, 'post_data')):
        _scan_csv(fp, None, set(), out)
    return out
