# -*- coding: utf-8 -*-
"""生成前端可用的 js/job-taxonomy.js —— 岗位库两份数据：

1) JOB_TAXONOMY：BOSS 官方岗位分类树（28 大类 / 161 子类组 / 1098 岗位）
   来源：boss-crawler 的 assets/post_data.json（BOSS 官方接口快照）
   结构：[ { name: 大类, subs: [ { name: 子类组, jobs: [岗位名...] } ] } ]
   只保留 name（BOSS 搜索用的是关键词 query，不是分类 code）。

2) JOB_MARKET：**市面上真实在招的岗位名**（杭州 · 运营方向 300 条采集样本）
   来源：数据源/BOSS岗位名称统计_YYYYMMDD.xlsx 的「岗位名称统计」sheet
   结构：{ meta: {...}, groups: [ { name: 分类, total: 条数, jobs: [ {name, count} ] } ] }
   这是「招聘方实际写出来的标题」，跟官方分类树互补 —— 官方树是标准名，
   这里是真名（含「抖音短视频运营」这种官方树里没有的写法）。

3) 顺带用表格里的「官方职位分类目录」补齐 post_data.json 里缺的 7 个岗位名
   （两份官方快照有微小漂移，合并后覆盖更全）。

重新生成：python _生成岗位数据.py
"""
import glob
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SRC_TREE = 'C:/Users/1/.workbuddy/skills/boss-crawler/assets/post_data.json'
SRC_XLSX_GLOB = os.path.join(HERE, '数据源', 'BOSS岗位名称统计_*.xlsx')
OUT = os.path.join(HERE, 'js', 'job-taxonomy.js')

# 官方两条快照的差集：post_data.json 里没有、但官方目录里有。
# 用 (大类, 子类组) -> [岗位名] 精确补，避免"补错地方"。
TAXONOMY_PATCH = {
    ('影视/传媒', '影视'): ['放映员'],
    ('影视/传媒', '广告'): ['广告策划经理'],
    ('市场/公关/广告', '推广/投放'): ['游戏推广', 'SEO/SEM'],
    ('金融', '银行'): ['柜员'],
    ('金融', '中后台'): ['风控合规', '稽查'],
}


# ---------------- 1. 官方分类树 ----------------
def build_tree():
    d = json.load(open(SRC_TREE, encoding='utf-8'))
    pos = d['zpData']['position']

    tree, total_l2, total_l3 = [], 0, 0
    for p in pos:
        ind_name = (p.get('name') or '').strip()
        if not ind_name:
            continue
        subs = []
        for s in (p.get('subLevelModelList') or []):
            sname = (s.get('name') or '').strip()
            if not sname:
                continue
            jobs, seen = [], set()
            for j in (s.get('subLevelModelList') or []):
                jname = (j.get('name') or '').strip()
                if not jname or jname in seen:
                    continue
                seen.add(jname)
                jobs.append(jname)
            subs.append({'name': sname, 'jobs': jobs})
            total_l2 += 1
            total_l3 += len(jobs)
        if subs:
            tree.append({'name': ind_name, 'subs': subs})

    # 重名大类去重合并
    merged, order = {}, []
    for node in tree:
        k = node['name']
        if k not in merged:
            merged[k] = node
            order.append(k)
        else:
            merged[k]['subs'].extend(node['subs'])
    tree = [merged[k] for k in order]

    # 打补丁：补官方目录里有、post_data.json 里没有的岗位名
    index = {}
    for node in tree:
        for sec in node['subs']:
            index[(node['name'], sec['name'])] = sec
    added = []
    for (ind, sec), names in TAXONOMY_PATCH.items():
        target = index.get((ind, sec))
        if target is None:
            continue
        for n in names:
            if n not in target['jobs']:
                target['jobs'].append(n)
                added.append(ind + '/' + sec + '/' + n)
    return tree, total_l2, total_l3, added


# ---------------- 2. 真实在招岗位（Excel） ----------------
def build_market():
    try:
        import openpyxl
    except ImportError:
        print('!! 没装 openpyxl，跳过 JOB_MARKET（pip install openpyxl）')
        return None

    files = sorted(glob.glob(SRC_XLSX_GLOB))
    if not files:
        print('!! 数据源里没有 BOSS岗位名称统计_*.xlsx，跳过 JOB_MARKET')
        return None
    path = files[-1]

    wb = openpyxl.load_workbook(path, data_only=True)
    if '岗位名称统计' not in wb.sheetnames:
        print('!! 表里没有「岗位名称统计」sheet，跳过 JOB_MARKET')
        return None

    meta = {'src': os.path.basename(path)}
    # 数据说明 sheet 里挖元信息（采集范围 / 样本量），挖不到就不写
    if '数据说明' in wb.sheetnames:
        for row in wb['数据说明'].iter_rows(values_only=True):
            t = str(row[0] or '')
            if t.startswith('采集时间：'):
                meta['date'] = t.split('：', 1)[1].strip()
            elif t.startswith('采集范围：'):
                scope = t.split('：', 1)[1].strip()
                meta['scope'] = scope
                # 「杭州（city=杭州），关键词覆盖 …」→ city = 杭州
                meta['city'] = re.split(r'[（(，,、\s]', scope)[0].strip()
            elif t.startswith('数据来源：'):
                meta['source'] = t.split('：', 1)[1].strip()

    # (分类, 岗位名) -> 出现次数
    rows, cats = [], set()
    for r in wb['岗位名称统计'].iter_rows(min_row=2, values_only=True):
        name = str(r[1] or '').strip()
        if not name:
            continue
        cat = str(r[4] or '').strip() or '其他'
        cats.add(cat)
        rows.append({'name': name, 'cat': cat, 'count': int(r[2] or 0)})

    groups = []
    for cat in cats:
        items = [x for x in rows if x['cat'] == cat]
        # 组内按出现次数降序，同次数按名字排（保证可复现）
        items.sort(key=lambda x: (-x['count'], x['name']))
        groups.append({
            'name': cat,
            'total': sum(x['count'] for x in items),
            'jobs': [{'name': x['name'], 'count': x['count']} for x in items],
        })
    groups.sort(key=lambda g: (-g['total'], g['name']))   # 组间按记录数降序

    meta['titles'] = len(rows)
    meta['sample'] = sum(x['count'] for x in rows)
    return {'meta': meta, 'groups': groups}


# ---------------- 3. 输出 ----------------
def main():
    tree, total_l2, total_l3, added = build_tree()
    market = build_market()

    header = (
        '/* js/job-taxonomy.js —— 自动生成，别手改（改数据请改 _生成岗位数据.py）\n'
        ' *\n'
        ' * JOB_TAXONOMY  BOSS 官方岗位分类树：28 大类 / %d 子类组 / %d 岗位\n'
        ' *               来源 boss-crawler assets/post_data.json（BOSS 官方接口快照）\n'
        ' *               结构 [ { name: 大类, subs: [ { name: 子类组, jobs: [岗位名] } ] } ]\n'
        ' *\n'
        ' * JOB_MARKET    市面上真实在招的岗位名（招聘方写的标题原样统计）\n'
        ' *               来源 数据源/BOSS岗位名称统计_*.xlsx\n'
        ' *               结构 { meta: {...}, groups: [ { name, total, jobs:[{name,count}] } ] }\n'
        ' *\n'
        ' * 用途：岗位期望选择器（js/job-picker.js）、采集关键词、结果筛选\n'
        ' * 重新生成：python _生成岗位数据.py\n'
        ' */\n'
    ) % (total_l2, total_l3)

    content = header
    content += 'var JOB_TAXONOMY = ' + json.dumps(tree, ensure_ascii=False, separators=(',', ':')) + ';\n'

    if market:
        content += 'var JOB_MARKET = ' + json.dumps(market, ensure_ascii=False, separators=(',', ':')) + ';\n'
    else:
        content += 'var JOB_MARKET = null;\n'

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='\n') as f:
        f.write(content)

    print('【JOB_TAXONOMY】')
    print('  大类(一级):', len(tree))
    print('  子类组(二级):', total_l2)
    print('  岗位(三级):', total_l3)
    print('  用官方目录补齐:', len(added), '个', added)
    if market:
        print('【JOB_MARKET】')
        print('  分类:', len(market['groups']))
        print('  岗位名:', market['meta']['titles'], '· 样本记录:', market['meta']['sample'])
        print('  采集:', market['meta'].get('city') or market['meta'].get('scope', '')[:40])
    else:
        print('【JOB_MARKET】 跳过')
    print('输出:', OUT)
    print('大小: %.1f KB' % (os.path.getsize(OUT) / 1024.0))


if __name__ == '__main__':
    main()
