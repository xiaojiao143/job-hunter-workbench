#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
常量定义、筛选参数映射、Chrome 配置、Sleep 配置
"""

import os
import random
import sys
import time

from DrissionPage import ChromiumOptions

# 尝试导入Windows键盘检测模块
try:
    import msvcrt
    IS_WINDOWS = True
except ImportError:
    IS_WINDOWS = False

# ==================== 常量 ====================

PER_PAGE = 15  # 每页数据条数
PER_PAGE_TIME = 3  # 每页耗时（秒）
PER_DETAIL_TIME = 5  # 每条详情耗时（秒）
WAIT_TIMEOUT = 300  # 等待用户操作超时（秒）
ENCODING = 'utf-8-sig'  # CSV编码

# 同义关键词的提前退出阈值。
#
# 由来：2026-08-14 复盘一次太原的实跑 —— 5 个关键词爬出 117 行，只有 53 个唯一
# link，54% 是重复。小城市的岗位池就那么大，「AI应用开发」和「大模型应用开发」
# 命中的基本是同一批岗，第 4、5 个关键词几乎整页都是本轮已经采过的。
#
# 判据只数「本轮其他关键词已见过」的那部分（run_dups），不数「旧文件里已有」的。
# 否则续爬会被打断：某文件已有 200 行时，同一关键词的第 1 页 100% 命中旧数据，
# 按总重复率就会立刻 break，再也翻不到后面的新岗位。
DUP_PAGE_RATIO = 0.8  # 单页重复率达到这个比例就跳到下一个关键词
DUP_PAGE_MIN_LINKS = 5  # 少于这么多条的尾页不参与判定，避免误导性的跳过日志

# ==================== 翻页滚动失败封顶（防死循环刷屏） ====================
#
# 血教训（2026-10-06 现场）：浏览器页面被关掉 / 连接断开后，dp.scroll.to_bottom()
# 会**一直**抛异常。而 _crawl_paginated 原先在 except 里直接 `continue` 回 while
# 顶部 —— 页号不变、无重试上限、无退避 sleep → 变成**极速空转**：实测 1 分钟把
# 落盘日志刷到 424MB、内存 task.lines 同步爆掉、前端 poll 也被拖死。
# 所以滚动失败必须封顶：连续失败 SCROLL_FAIL_LIMIT 次就停止本轮爬取（不是无限重试）。
# 取 3：短暂抖动（网络毛刺）通常 1~2 次内自愈；连续 3 次基本都是页面真的没了。
SCROLL_FAIL_LIMIT = 3

# ==================== 详情抓取封顶 ====================
#
# BOSS 直聘大约 200 个详情就触发风控（见下面 SleepConfig 的注释）。而一轮采集
# 可能采到几百个岗位 —— 实测曾有单轮 456 个岗位、**每一个都走过一次详情接口**，
# 是风控阈值的 2.3 倍。所以详情抓取必须封顶，把有限的额度花在最值得看的岗位上，
# 其余只保留列表页字段（列表页字段足够做初筛）。
#
# 选谁：crawler.detail_priority() 按列表页客观信号（薪资是否明确、福利条数、
# 信息完整度）排序，取前 DETAIL_TOP_N 个。设为 None 或 0 表示不封顶（旧行为）。
DETAIL_TOP_N = 50

# ==================== 筛选参数映射 ====================

# 工作类型
JOB_TYPE_MAP = {
    '全职': '1901', '1901': '1901',
    '实习': '1902', '1902': '1902',
    '兼职': '1903', '1903': '1903',
}

# 薪资范围
SALARY_MAP = {
    '3K以下': '402', '402': '402',
    '3-5K': '403', '403': '403',
    '5-10K': '404', '404': '404',
    '10-20K': '405', '405': '405',
    '20-50K': '406', '406': '406',
    '50K以上': '407', '407': '407',
}

# 经验要求
EXPERIENCE_MAP = {
    '在校生': '108', '108': '108',
    '应届生': '102', '102': '102',
    '经验不限': '101', '101': '101',
    '1年以内': '103', '103': '103',
    '1-3年': '104', '104': '104',
    '3-5年': '105', '105': '105',
    '5-10年': '106', '106': '106',
    '10年以上': '107', '107': '107',
}

# 学历要求
DEGREE_MAP = {
    '初中及以下': '209', '209': '209',
    '中专/中技': '208', '208': '208',
    '高中': '206', '206': '206',
    '大专': '202', '202': '202',
    '本科': '203', '203': '203',
    '硕士': '204', '204': '204',
    '博士': '205', '205': '205',
}

# 公司规模
SCALE_MAP = {
    '0-20人': '301', '301': '301',
    '20-99人': '302', '302': '302',
    '100-499人': '303', '303': '303',
    '500-999人': '304', '304': '304',
    '1000-9999人': '305', '305': '305',
    '10000人以上': '306', '306': '306',
}

# 融资阶段（2026-09-30 从 condition.json 实测）
STAGE_MAP = {
    '未融资': '801', '801': '801',
    '天使轮': '802', '802': '802',
    'A轮': '803', '803': '803',
    'B轮': '804', '804': '804',
    'C轮': '805', '805': '805',
    'D轮及以上': '806', '806': '806',
    '已上市': '807', '807': '807',
    '不需要融资': '808', '808': '808',
}

# 聚合映射: filter_key -> 选项 map
FILTER_MAPS = {
    'jobType': JOB_TYPE_MAP,
    'salary': SALARY_MAP,
    'experience': EXPERIENCE_MAP,
    'degree': DEGREE_MAP,
    'scale': SCALE_MAP,
    'stage': STAGE_MAP,
}

# 筛选参数中文名
FILTER_PARAM_NAMES = {
    'jobType': '工作类型',
    'salary': '薪资范围',
    'experience': '经验要求',
    'degree': '学历要求',
    'scale': '公司规模',
    'stage': '融资阶段',
    'district': '行政区',
    'businessDistrict': '商圈',
    'subway': '地铁',
}

# 仅供展示用: filter_key -> {code: label}
FILTER_LABELS = {
    'jobType': {'1901': '全职', '1902': '实习', '1903': '兼职'},
    'salary': {'402': '3K以下', '403': '3-5K', '404': '5-10K', '405': '10-20K', '406': '20-50K', '407': '50K以上'},
    'experience': {'108': '在校生', '102': '应届生', '101': '经验不限', '103': '1年以内', '104': '1-3年', '105': '3-5年', '106': '5-10年', '107': '10年以上'},
    'degree': {'209': '初中及以下', '208': '中专/中技', '206': '高中', '202': '大专', '203': '本科', '204': '硕士', '205': '博士'},
    'scale': {'301': '0-20人', '302': '20-99人', '303': '100-499人', '304': '500-999人', '305': '1000-9999人', '306': '10000人以上'},
    'stage': {'801': '未融资', '802': '天使轮', '803': 'A轮', '804': 'B轮', '805': 'C轮', '806': 'D轮及以上', '807': '已上市', '808': '不需要融资'},
}

# CSV字段
# 末尾 5 列均来自详情 API（无 -d 时为空）。新增列只能追加在末尾：
# init_csv_file 会按此顺序迁移旧文件的表头。
CSV_FIELDS = [
    'link', '职位', '城市', '区域', '商圈', '地址', '公司', '薪资', '经验', '学历',
    '领域', '性质', '规模', '技能标签', '福利标签', '位置', '岗位要求和职责', '公司信息',
    '已失效', '代招',
    'HR活跃度', 'HR在线', 'HR职位', 'HR姓名', 'HR公司'
]

# ==================== 路径配置 ====================

# 技能根目录: scripts/boss_crawler/config.py → 上溯 3 层到 boss-crawler/
_SKILL_ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
ASSETS_DIR = os.path.join(os.environ.get('JH_BOSS_ASSETS') or os.path.join(_SKILL_ROOT, 'assets'))

# 公司定向采集的输出目录。放 post_data/ 下而不是别处，关键是为了让 match 阶段
# （resume_matcher/data_loader.list_available_job_files 用 os.walk 递归扫 post_data/）
# 能像读 custom/ 一样把公司采集结果无缝扫进匹配池 —— 这是「公司定向 → 路径 B
# match/deliver」整条链路能走通的落点。
COMPANY_OUTPUT_DIR = os.path.join(ASSETS_DIR, 'post_data', 'company')

# ==================== Chrome 配置 ====================

co = ChromiumOptions()

# DrissionPage 自带的浏览器探测只认 chrome.exe（注册表 App Paths\chrome.exe），
# 机器上只装了 Edge 时会直接抛 BROWSER_EXE_NOT_FOUND，爬虫一行都跑不起来。
# 这里复用本 skill 的 browser_finder（env CHROME_PATH/BROWSER_PATH → PATH → 注册表
# → 常见安装目录，覆盖 Edge），找到就显式指定路径；找不到则保持原行为不设置，
# 让 DrissionPage 再自己试一次（找不到时它自己会报错，错误信息不变）。
# 做法与 resume_matcher/auto_apply.py、showcv/_browser.py 一致。
_SCRIPTS_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _SCRIPTS_DIR not in sys.path:
    sys.path.insert(0, _SCRIPTS_DIR)
try:
    from browser_finder import find_chrome_browser as _find_chrome_browser
except ImportError:                                          # pragma: no cover
    _find_chrome_browser = None

_BROWSER_EXE = _find_chrome_browser() if _find_chrome_browser else None
if _BROWSER_EXE:
    co.set_browser_path(_BROWSER_EXE)

# 显式启用图片加载
co.no_imgs(False)

# 持久化 Chrome 用户数据目录，使登录状态跨脚本运行保留
USER_DATA_DIR = os.path.join(ASSETS_DIR, 'chrome_user_data')
os.makedirs(USER_DATA_DIR, exist_ok=True)
co.set_argument('--user-data-dir', USER_DATA_DIR)

# 隐藏自动化标识，避免网站限制
co.set_argument('--disable-blink-features=AutomationControlled')

# ── 基础反自动化指纹（2026-09-26 针对 BOSS code:37 风控）──
# 这些只是「让浏览器看起来像真人」的常规手段：真实 UA、语言、窗口尺寸、
# 关掉自动化相关实验开关。
# ⚠️ 如实说明：本技能**确实会调用 BOSS 页面的数据接口**读取列表与详情
# （见 crawler.py 的 joblist.json / job/detail.json），并非纯 DOM 解析。
# 因此上面的伪装属于「降低被识别概率」的措施，不改变「接口级采集」这一事实。
# 边界口径以本注释为准，勿在别处再写「不逆向接口」。
# 注意：机器只装了 Edge，UA 要写 Edge 而不是 Chrome，否则和真实浏览器
# 特征对不上反而更可疑。
co.set_argument('--lang=zh-CN')                    # 语言指纹：中文环境
co.set_argument('--window-size=1920,1080')         # 真实桌面窗口尺寸
co.set_argument('--disable-features=OptimizationHints')  # 关掉可能暴露自动化的提示
co.set_user_agent(
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) '
    'AppleWebKit/537.36 (KHTML, like Gecko) '
    'Chrome/126.0.0.0 Safari/537.36 Edg/126.0.0.0'
)


def apply_stealth(page):
    """在浏览器创建后注入 JS，补上 CDP 层遮不住的那几个指纹。

    要遮的点：
      · navigator.webdriver  —— DrissionPage 走 CDP，默认是 true，网站一查一个准
      · navigator.plugins    —— 无头/自动化浏览器常是空数组，真人至少有 PDF/Chrome PDF
      · navigator.languages  —— 兜底成 zh-CN，和 --lang 对齐

    都用 Object.defineProperty 直接改，简单可靠。失败静默（不影响爬取主流程），
    因为这一步只是降低风控概率，不是爬取的硬依赖。
    """
    try:
        page.run_js("""
        (function () {
            try {
                Object.defineProperty(navigator, 'webdriver', { get: function () { return false; } });
            } catch (e) {}
            try {
                Object.defineProperty(navigator, 'languages', { get: function () { return ['zh-CN', 'zh', 'en']; } });
            } catch (e) {}
            try {
                Object.defineProperty(navigator, 'plugins', {
                    get: function () {
                        return [1, 2, 3, 4, 5];
                    }
                });
            } catch (e) {}
            return true;
        })();
        """)
    except Exception:
        pass

# ==================== Sleep 配置 ====================


class SleepConfig:
    """Sleep时间配置管理

    风控对抗的核心是**随机抖动**：固定间隔（哪怕隔得久）是机器指纹，BOSS 直聘大约
    200 个详情就触发风控。这里的真实等待 = base + uniform(0, jitter)，节奏不可预测
    才像人。详情页串行爬，base 不能太低——0.5s 是当初 API 直调时代的残留，现在走
    浏览器必须让出来。
    """
    def __init__(self):
        self.enabled = True  # 是否开启sleep等待
        self.page_interval = 1.4  # 列表页之间的基础等待（秒）——真实 = 1.4 + uniform(0,0.6) ≤2s
        self.detail_interval = 3  # 详情页之间的基础等待（秒）——走浏览器，0.5s 会触发风控
        self.scroll_wait = 2  # 滚动后的等待时间（秒）
        self.login_wait = 2  # 登录检测后的等待时间（秒）
        self.retry_wait = 1.0  # 重试等待时间（秒）——真实 = 1.0 + uniform(0,0.6) ≤2s
        self.api_wait = 5  # API响应等待时间（秒）
        self.jitter = 0.6  # 随机抖动上限（秒）：真实等待 = base + uniform(0, jitter)；0.6s 既保随机性又让 page/retry 落在 ≤2s
        self.detail_batch = 30  # 每 N 个详情请求后进入一次分批冷却
        self.batch_cooldown = 30  # 分批冷却时长（秒）

    def sleep(self, sleep_type='page'):
        """
        根据配置执行sleep（带随机抖动）
        sleep_type: 'page', 'detail', 'scroll', 'login', 'retry', 'api', 'batch'
        """
        if not self.enabled:
            return

        intervals = {
            'page': self.page_interval,
            'detail': self.detail_interval,
            'scroll': self.scroll_wait,
            'login': self.login_wait,
            'retry': self.retry_wait,
            'api': self.api_wait,
            'batch': self.batch_cooldown,
        }

        base = intervals.get(sleep_type, 2)
        time.sleep(base + random.uniform(0, self.jitter))

    def set_enabled(self, enabled):
        """设置是否开启sleep"""
        self.enabled = enabled

    def set_intervals(self, page=None, detail=None, scroll=None, login=None, retry=None, api=None):
        """设置各类型等待时间"""
        if page is not None:
            self.page_interval = page
        if detail is not None:
            self.detail_interval = detail
        if scroll is not None:
            self.scroll_wait = scroll
        if login is not None:
            self.login_wait = login
        if retry is not None:
            self.retry_wait = retry
        if api is not None:
            self.api_wait = api


# 全局Sleep配置
sleep_config = SleepConfig()
