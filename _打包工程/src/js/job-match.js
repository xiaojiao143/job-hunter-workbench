/* ==========================================================================
   job-match.js · 筛选增强 + 批量匹配评分（岗位库与采集页共用的能力模块）
   --------------------------------------------------------------------------
   四块能力：
     1. 求职偏好 → 筛选规则（城市 / 薪资底线 / 不能接受的点）
     2. 自然语言搜索解析（本地规则，不调 AI）
     3. 快捷筛选 chip 的判定规则
     4. 批量 AI 匹配评分（串行、可取消、失败重试、连续失败会暂停询问）

   为什么单独成模块：岗位库（view-jobs.js）和采集页（view-collect.js）都要用，
   而 view-jobs.js 本身已经很长了。这里只放"纯逻辑 + 可复用的弹窗"，
   不碰任何页面的渲染细节。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ⚠️ 本项目的静态检查要求：文件里用到 el() 就必须建这个别名，
     否则运行时直接 ReferenceError（resume-doc.js 踩过一次）。 */
  var el = Comp.el;

  /* ==================== 0. 小工具 ==================== */
  function trim(s) { return String(s === null || s === undefined ? '' : s).trim(); }

  function wait(ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  }

  /** 「有没有评过分」。注意不能用 truthy 判断 —— 0 分也是分。 */
  function hasScore(j) {
    return !!(j && j.aiVerdict && typeof j.aiVerdict.score === 'number');
  }

  function unscored(jobs) {
    return (jobs || []).filter(function (j) { return !hasScore(j); });
  }

  /* ==================== 1. 求职偏好 → 筛选规则 ==================== */

  /**
   * 读偏好。空值一律归一成空数组 / null，调用方不用再判 undefined。
   * 存偏好的字段是 DB.settings.prefs（见 store.js 的 DEFAULT_SETTINGS）。
   */
  function prefs() {
    var p = (Store.settings() || {}).prefs || {};
    var min = U.asNum(p.salaryMin);
    if (min !== null && min <= 0) min = null;
    var max = U.asNum(p.salaryMax);
    if (max !== null && max <= 0) max = null;
    return {
      cities: U.asArray(p.cities),
      salaryMin: min,
      salaryMax: max,
      dealBreakers: U.asArray(p.dealBreakers),
      expectJobs: U.asArray(p.expectJobs),   // 期望岗位（来自 BOSS 岗位分类树）
      // —— 福利待遇（多选）——
      welfare: U.asArray(p.welfare),                                       // 选项 key，见 WELFARE_OPTIONS
      welfareMode: p.welfareMode === 'any' ? 'any' : 'all',                // 全部满足 / 任一满足
      // —— 地理下钻（城市 > 区 > 商圈 / 地标）——
      districts: U.asArray(p.districts),     // 期望区（「杭州 > 滨江区」的第二级）
      bizAreas: U.asArray(p.bizAreas),       // 期望商圈（第三级；只有真实采到的才有）
      landmark: String(p.landmark || '').trim(),   // 地标 / 地铁关键词
      geoStrict: !!p.geoStrict,              // 严格模式：没采到区/商圈的也筛掉
      // —— 下面两组是本地「合适度」打分（js/job-score.js）的口径，不参与硬过滤 ——
      focusKeywords: U.asArray(p.focusKeywords),   // 求职方向关键词
      industries: U.asArray(p.industries),         // 对口行业（加分用）
      myYears: U.asNum(p.myYears),
      myDegree: String(p.myDegree || '').trim(),
    };
  }

  /** 偏好里有没有填出「能用来筛」的东西 */
  function hasPref(p) {
    p = p || prefs();
    return !!(p.cities.length || p.salaryMin !== null || p.dealBreakers.length ||
      (p.expectJobs || []).length ||
      // 本轮新增的两组：福利 + 地理下钻，也是能单独用来筛的
      (p.welfare || []).length || (p.districts || []).length ||
      (p.bizAreas || []).length || trim(p.landmark));   // 传进来的 p 可能是自己拼的，容错
  }

  /**
   * 城市匹配：岗位地点**包含**任一目标城市即算命中。
   * 「杭州」能命中「杭州」「杭州·西湖区」「杭州西湖区」。
   * 大小写不敏感是为了兼容「Hangzhou」「SHANGHAI」这类写法。
   */
  function cityHit(job, cities) {
    if (!cities || !cities.length) return true;
    var loc = trim(job && job.location).toLowerCase();
    if (!loc) return false;               // 地点是空的，不能算命中目标城市
    return cities.some(function (c) {
      var cc = trim(c).toLowerCase();
      return cc && loc.indexOf(cc) >= 0;
    });
  }

  /* ==================== 1b. 福利待遇（多选）====================

     ⛔ 选项**不是凭印象列的**，全部来自真实采集数据里出现过的福利标签
        （boss-crawler 的 CSV「福利标签」列）。列一个采不到的选项，
        用户勾了就等于白勾 —— 而且他会以为是工具坏了。
     ⛔ 同一个意思在 BOSS 上有多种写法（「带薪年假」/「年假」/「带薪休假」），
        所以每个选项给一组正则，而不是精确相等。 */

  var WELFARE_OPTIONS = [
    { k: '五险一金', g: '保障', re: /五险一金/ },
    { k: '公积金', g: '保障', re: /公积金/ },
    { k: '双休', g: '作息', re: /双休|周末双休|做五休二|上五休二/ },
    { k: '不加班', g: '作息', re: /不加班|加班少|无加班/ },
    { k: '弹性工作', g: '作息', re: /弹性工作|弹性上班|弹性考勤/ },
    { k: '年终奖', g: '薪酬', re: /年终奖|年底双薪|十三薪|1[3-9]薪/ },
    { k: '绩效奖金', g: '薪酬', re: /绩效奖金|绩效奖|全勤奖|工龄奖/ },
    { k: '股票期权', g: '薪酬', re: /股票期权|期权|股权激励|员工持股/ },
    { k: '带薪年假', g: '假期', re: /带薪年假|带薪休假|年假/ },
    { k: '法定节假日三薪', g: '假期', re: /法定节假日三薪|节假日三薪|三倍工资/ },
    { k: '节日福利', g: '福利', re: /节日福利|生日福利|员工福利/ },
    { k: '定期体检', g: '福利', re: /定期体检|年度体检|免费体检/ },
    { k: '餐补', g: '补贴', re: /餐补|餐饮补贴|包吃|免费三餐|食堂/ },
    { k: '交通补助', g: '补贴', re: /交通补助|交通补贴|住房补贴|房补/ },
    { k: '加班补助', g: '补贴', re: /加班补助|加班费|加班补贴/ },
    { k: '包住', g: '补贴', re: /包住|提供住宿|宿舍/ },
    { k: '团建旅游', g: '软福利', re: /团建|员工旅游|团队旅游/ },
    { k: '零食下午茶', g: '软福利', re: /下午茶|零食|水果|茶歇/ },
  ];

  function welfareOpt(k) {
    return WELFARE_OPTIONS.filter(function (o) { return o.k === k; })[0] || null;
  }

  /** 福利原文。优先用 job-score.js 的 welfareText（那边已有拆解口径），没有就自己拼。 */
  function welfareText(job) {
    if (global.JobScorer && global.JobScorer.welfareText) return global.JobScorer.welfareText(job);
    var b = (job && job.benefits) || [];
    return (Array.isArray(b) ? b.join(' ') : String(b)).toLowerCase();
  }

  /**
   * 福利命中判定。
   * mode='all' 全部勾的都要有；mode='any' 有任一即可。
   *
   * ⛔ **福利没采到的岗位一律保留** —— 和「薪资为空的岗位一律保留」同一个道理：
   *    列表页的福利标签本来就常有缺失，按"没写就是没有"筛，用户会以为岗位丢了。
   *    真要看区别，卡片上会写「福利未采集」，不该靠静默筛掉来表达。
   */
  function welfareHit(job, wanted, mode) {
    if (!wanted || !wanted.length) return true;
    var w = welfareText(job);
    if (!w) return true;                       // 没采到 → 保留
    var hit = wanted.filter(function (k) {
      var o = welfareOpt(k);
      return o && o.re.test(w);
    });
    return mode === 'any' ? hit.length > 0 : hit.length === wanted.length;
  }

  /** 这条岗位**命中了几项**期望福利（卡片上写「福利 2/3 命中」用） */
  function welfareHitN(job, wanted) {
    if (!wanted || !wanted.length) return 0;
    var w = welfareText(job);
    if (!w) return 0;
    return wanted.filter(function (k) {
      var o = welfareOpt(k);
      return o && o.re.test(w);
    }).length;
  }

  /* ==================== 1c. 地理下钻（区 / 商圈 / 地标）====================

     ⚠️ 城市由 cityHit 单独判（口径不变，历史测试都盯着它）；
        这里只管比城市更细的一层。 */

  function areaNeed(p) {
    return (p.districts || []).length || (p.bizAreas || []).length || trim(p.landmark);
  }

  function areaHit(job, p) {
    // geo.js 没加载 → **不拦**。宁可放过几条，也不要因为一个脚本没引上就把列表筛空。
    if (!global.GEO) return true;
    p = p || prefs();
    if (!areaNeed(p)) return true;
    return global.GEO.geoHit(job, {
      cities: [],                     // 城市不在这里判，避免和 cityHit 双份口径
      districts: p.districts,
      bizAreas: p.bizAreas,
      landmark: p.landmark,
      strict: p.geoStrict,
    });
  }

  /** 组装 geo.js 需要的条件对象（前端画「📍 区未知」标记时也要用） */
  function geoOf(p) {
    p = p || prefs();
    return {
      cities: p.cities,
      districts: p.districts,
      bizAreas: p.bizAreas,
      landmark: p.landmark,
      strict: p.geoStrict,
    };
  }

  /** 这条岗位是不是"因为没采到区/商圈才被放行"的（卡片上要标出来） */
  function areaUnknown(job, p) {
    if (!global.GEO) return false;
    p = p || prefs();
    if (!areaNeed(p)) return false;
    return global.GEO.unknownArea(job, geoOf(p));
  }

  /**
   * 薪资匹配：保留 salaryMax >= 底线 或 salaryMin >= 底线 的岗位。
   * ⚠️ **薪资为空的岗位一律保留** —— 采集回来的岗位常常没有薪资，
   * 因为「没写薪资」就把岗位筛掉，用户会以为岗位丢了。
   */
  function salaryHit(job, salaryMin) {
    if (salaryMin === null || salaryMin === undefined) return true;
    var lo = job ? job.salaryMin : null;
    var hi = job ? job.salaryMax : null;
    if (lo === null && hi === null) return true;   // 没写薪资 → 保留
    if (hi !== null && hi >= salaryMin) return true;
    if (lo !== null && lo >= salaryMin) return true;
    return false;
  }

  /**
   * 「不能接受的点」命中判定。
   *
   * 需求文档写的是「排除 tags 命中任一 dealBreaker 的岗位」，这里**有意放宽**到
   * 标签 + 岗位名 + 公司名：
   *   - 采集回来的岗位基本没有标签，只看 tags 的话这个筛选项等于没生效；
   *   - 但也不能扫整段 JD —— 「外包」「驻场」在 JD 正文里常出现在
   *     「本岗位非外包」这种反向表述中，扫 JD 会误杀。
   * 所以只取「够强、又不会反向表述」的三个字段。要收窄回只认 tags 的话改这一处即可。
   */
  function dealHit(job, breakers) {
    if (!breakers || !breakers.length) return false;
    if (!job) return false;
    var hay = [
      (job.tags || []).join(' '),
      trim(job.title),
      trim(job.company),
      // BOSS 权威字段「代招」：用户写「排除外包」时精准命中，不必再去 JD 里猜
      // （JD 里「本岗位非外包」这类反向表述，靠扫正文会误杀）
      job.proxyHire ? '代招 外包 派遣 劳务 中介' : '',
    ].join(' ').toLowerCase();
    return breakers.some(function (b) {
      var bb = trim(b).toLowerCase();
      return bb && hay.indexOf(bb) >= 0;
    });
  }

  /**
   * 期望岗位命中：岗位名里含任一期望岗位名即算命中。
   * 反向也认（期望「新媒体运营专员」，标题写「新媒体运营」时也算），
   * 但反向只在标题不短于 2 字时做，免得一个字的标题把什么都匹配上。
   * ⚠️ 岗位名为空时**保留**（同薪资为空的处理）—— 信息不全就筛掉，用户会以为岗位丢了。
   */
  function jobHit(job, expectJobs) {
    if (!expectJobs || !expectJobs.length) return true;
    var t = trim(job && job.title).toLowerCase().replace(/\s+/g, '');
    if (!t) return true;
    return expectJobs.some(function (n) {
      var k = trim(n).toLowerCase().replace(/\s+/g, '');
      if (!k) return false;
      if (t.indexOf(k) >= 0) return true;
      return t.length >= 2 && k.indexOf(t) >= 0;
    });
  }

  /** 一次判定「是否通过全部偏好」—— 方便测试与复用 */
  function passPref(job, p) {
    p = p || prefs();
    if (!cityHit(job, p.cities)) return false;
    if (!areaHit(job, p)) return false;                            // 区 / 商圈 / 地标（比城市更细的一层）
    if (!salaryHit(job, p.salaryMin)) return false;
    if (dealHit(job, p.dealBreakers)) return false;
    if (!jobHit(job, p.expectJobs)) return false;
    if (!welfareHit(job, p.welfare, p.welfareMode)) return false;   // 期望福利（多选 / AND·OR）
    return true;
  }

  /** 把偏好写成给人看的一行，用在 toast 和空态里（「杭州 · 10K 以上 · 排除 外包/派遣」） */
  function describePref(p) {
    p = p || prefs();
    var parts = [];
    if ((p.expectJobs || []).length) parts.push('岗位 ' + p.expectJobs.join('/'));
    if (p.cities.length) parts.push(p.cities.join('/'));
    // 地理下钻：区和商圈合在一起展示，用「📍」跟城市区分开
    var area = (p.districts || []).concat(p.bizAreas || []);
    if (area.length) parts.push('📍' + area.join('/'));
    if (trim(p.landmark)) parts.push('地标“' + trim(p.landmark) + '”');
    if (p.salaryMin !== null) parts.push(p.salaryMin + 'K 以上');
    if (p.dealBreakers.length) parts.push('排除 ' + p.dealBreakers.join('/'));
    if ((p.welfare || []).length) {
      parts.push('福利' + (p.welfareMode === 'any' ? '任一' : '全含') + ' ' + p.welfare.join('/'));
    }
    return parts.length ? parts.join(' · ') : '（偏好是空的）';
  }

  /* ==================== 2. 自然语言搜索解析 ==================== */

  var CITY_WORDS = [
    '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州',
    '长沙', '重庆', '天津', '郑州', '青岛', '合肥', '福州', '厦门', '济南', '宁波',
    '无锡', '东莞', '佛山', '珠海', '南昌', '昆明', '贵阳', '南宁', '石家庄', '太原',
    '沈阳', '大连', '哈尔滨', '长春', '兰州', '乌鲁木齐', '海口', '三亚',
  ];

  /* 「不要外包」「排除外包」「不接受劳务派遣」…… 后面跟的词一直取到空格或标点 */
  var EXCLUDE_RE = /(?:不要|不想看|不想投|别给|排除|剔除|去掉|不接受|不能接受|避开|拒绝)\s*([^\s，,。.、；;！!？?\/|]+)/g;

  /** 15k-20k / 15K~20K / 15k到20k / **15-20k（单位只写在后面，前面继承）** */
  var SAL_RANGE_RE = /(\d+(?:\.\d+)?)\s*[kK]?\s*[-~～到至]\s*(\d+(?:\.\d+)?)\s*([kK])/;
  /** 15k以上 / 15k+ / 15k 起 */
  var SAL_ABOVE_RE = /(\d+(?:\.\d+)?)\s*[kK]\s*(?:以上|及以上|\+|\+|起)/;
  /** 1.5w / 1.5万 / 2W以上 */
  var SAL_WAN_RE = /(\d+(?:\.\d+)?)\s*[wW万]/;
  /** 裸的 15k */
  var SAL_K_RE = /(\d+(?:\.\d+)?)\s*[kK]/;

  /**
   * 把「杭州 运营 15k 不要外包」拆成结构化条件。
   *
   * 返回 { raw, cities[], salaryMin, salaryMax, exclude[], kwTokens[], matched }
   * - `matched` = 这一串**值得按自然语言模式处理**：解析出了城市 / 薪资 / 排除词，
   *   或者关键词被切成了 2 个以上（多词按 AND 逐词匹配，见 passQuery）。
   *   为 false 时调用方应**退回原来的纯关键词子串搜索**（行为完全不变）。
   * - 只认本地规则，不调 AI —— 搜索框每次按键都要跑，不能有网络往返。
   */
  function parseQuery(text) {
    var raw = trim(text);
    var out = {
      raw: raw, cities: [], salaryMin: null, salaryMax: null,
      exclude: [], kwTokens: [], matched: false,
    };
    if (!raw) return out;

    var rest = raw;

    /* --- 排除词 --- */
    rest = rest.replace(EXCLUDE_RE, function (m, word) {
      var w = trim(word);
      if (w) out.exclude.push(w);
      return ' ';
    });

    /* --- 薪资：顺序要紧，先长后短，避免 "15k-20k" 被裸 k 规则先咬走 --- */
    var m;
    if ((m = SAL_RANGE_RE.exec(rest))) {
      out.salaryMin = parseFloat(m[1]);
      out.salaryMax = parseFloat(m[2]);
      rest = rest.replace(m[0], ' ');
    } else if ((m = SAL_ABOVE_RE.exec(rest))) {
      out.salaryMin = parseFloat(m[1]);
      rest = rest.replace(m[0], ' ');
    } else if ((m = SAL_WAN_RE.exec(rest))) {
      out.salaryMin = parseFloat(m[1]) * 10;      // 1.5万 = 15K
      rest = rest.replace(m[0], ' ');
    } else if ((m = SAL_K_RE.exec(rest))) {
      out.salaryMin = parseFloat(m[1]);
      rest = rest.replace(m[0], ' ');
    }
    if (out.salaryMin !== null && isNaN(out.salaryMin)) out.salaryMin = null;
    if (out.salaryMax !== null && isNaN(out.salaryMax)) out.salaryMax = null;

    /* --- 城市：命中预置词表就算，顺便把「杭州市」「杭州西湖区」这种残留切掉 ---
       ⚠️ 这里是用 new RegExp 拼字符串，所以 \s 必须写成 \\s。
       写成 '\s' 的话 JS 会把反斜杠吃掉、正则退化成 [^s…]，
       于是「杭州 运营」会被一路吃到行尾 —— 城市没了，关键词也没了。
       顺带也别写「吃掉城市后面所有非空白字符」，那会把紧邻的岗位名一起吞掉；
       只认「省 / 市」后缀，以及「XX区 / XX县 / XX市 / XX镇」这种行政区尾巴。 */
    CITY_WORDS.forEach(function (c) {
      var re = new RegExp(c + '(?:市|省)?(?:[\\u4e00-\\u9fa5]{1,4}(?:区|县|市|镇))?');
      if (!re.test(rest)) return;
      out.cities.push(c);
      rest = rest.replace(re, ' ');
      rest = rest.replace(new RegExp(c, 'g'), ' ');
    });

    /* --- 剩下的按关键词处理（按空格 / 标点切） --- */
    out.kwTokens = rest.split(/[\s，,。.、；;！!？?\/|+]+/)
      .map(trim)
      .filter(function (t) { return t.length > 0; });

    out.matched = !!(out.cities.length || out.salaryMin !== null || out.exclude.length ||
      out.kwTokens.length > 1);
    return out;
  }

  /** 把解析结果写成给人看的一行小字（搜索框下方那行灰字） */
  function describeQuery(q) {
    if (!q || !q.matched) return '';
    var parts = [];
    if (q.cities.length) parts.push('城市=' + q.cities.join('/'));
    if (q.salaryMin !== null) {
      parts.push('薪资≥' + q.salaryMin + 'K' + (q.salaryMax !== null ? '（- ' + q.salaryMax + 'K）' : ''));
    }
    if (q.exclude.length) parts.push('排除=' + q.exclude.join('/'));
    if (q.kwTokens.length) parts.push('关键词=' + q.kwTokens.join(' + '));
    return parts.join(' · ');
  }

  /** 自然语言条件下的岗位判定 */
  function passQuery(job, q) {
    if (!q || !q.matched) return true;
    if (q.cities.length && !cityHit(job, q.cities)) return false;
    if (q.salaryMin !== null && !salaryHit(job, q.salaryMin)) return false;
    if (q.exclude.length && dealHit(job, q.exclude)) return false;
    if (q.kwTokens.length) {
      var hay = keywordHay(job);
      // 多个词是「都要命中」（AND）。整串去匹配的话「运营 短视频」几乎永远匹配不上。
      var all = q.kwTokens.every(function (t) { return hay.indexOf(t.toLowerCase()) >= 0; });
      if (!all) return false;
    }
    return true;
  }

  /** 关键词检索的统一取词范围（与 view-jobs 原来的口径保持一致） */
  function keywordHay(job) {
    return [
      job.title, job.company, job.industry, job.location, job.rawJD,
      (job.reqSkills || []).join(' '), (job.tags || []).join(' '), (job.duties || []).join(' '),
    ].join(' ').toLowerCase();
  }

  /* ==================== 3. 快捷筛选 chips ==================== */

  var QUICK = [
    {
      k: 'high', icon: '🏆', label: '高匹配',
      title: '只显示匹配分 ≥ 80 的岗位（先跑一次「🤖 按简历推荐」）',
      test: function (j) { return hasScore(j) && j.aiVerdict.score >= 80; },
    },
    {
      k: 'fresh', icon: '🆕', label: '本周新',
      title: '7 天内录入的岗位',
      test: function (j) { return !!j.createdAt && (U.now() - j.createdAt) <= 7 * 86400000; },
    },
    {
      k: 'salary', icon: '💰', label: '薪资达标',
      title: '薪资达到设置里的底线（没写薪资的岗位也会保留）',
      needsPref: 'salary',
      test: function (j, p) { return salaryHit(j, p.salaryMin); },
    },
    {
      k: 'noapp', icon: '📨', label: '未投',
      title: '还没有投递记录的岗位',
      test: function (j) { return !Store.appOfJob(j.id); },
    },
    {
      k: 'nodeal', icon: '🚫', label: '排除不能接受的点',
      title: '排除命中设置里「不能接受的点」的岗位',
      needsPref: 'deal',
      test: function (j, p) { return !dealHit(j, p.dealBreakers); },
    },
    {
      k: 'welfare', icon: '🎁', label: '福利达标',
      title: '命中你在偏好里勾的期望福利（福利没采到的岗位也会保留）',
      needsPref: 'welfare',
      test: function (j, p) { return welfareHit(j, p.welfare, p.welfareMode); },
    },
    {
      k: 'geo', icon: '📍', label: '我的区域',
      title: '区 / 商圈 / 地标命中（没采到区或商圈的岗位也会保留）',
      needsPref: 'geo',
      test: function (j, p) { return areaHit(j, p); },
    },
  ];

  function quickDef(k) {
    return QUICK.filter(function (x) { return x.k === k; })[0] || null;
  }

  /** 某个 chip 需要的偏好在「⚙ 我的求职偏好」面板里填了没 —— 没填就别让它假装生效 */
  function quickReady(k, p) {
    var d = quickDef(k);
    if (!d || !d.needsPref) return true;
    p = p || prefs();
    if (d.needsPref === 'salary') return p.salaryMin !== null;
    if (d.needsPref === 'deal') return p.dealBreakers.length > 0;
    if (d.needsPref === 'welfare') return (p.welfare || []).length > 0;
    /* 「我的区域」只要区 / 商圈 / 地标任填了一项就算就绪 ——
       区是第二级、商圈是第三级，没必要逼着用户一级一级全填。 */
    if (d.needsPref === 'geo') return !!areaNeed(p);
    return true;
  }

  /** 判定一个岗位是否通过全部选中的 chip（AND 叠加） */
  function passQuick(job, on, p) {
    p = p || prefs();
    for (var i = 0; i < QUICK.length; i++) {
      var d = QUICK[i];
      if (!on || !on[d.k]) continue;
      if (!quickReady(d.k, p)) continue;      // 偏好没填 → 该 chip 视为不生效
      if (!d.test(job, p)) return false;
    }
    return true;
  }

  /* ==================== 4. 批量 AI 匹配评分 ==================== */

  var SEC_PER_JOB = 4;      // 每岗位大致耗时（秒），只用来给用户一个心理预期
  var BATCH_SIZE = 10;      // 每批几个，批间喘口气，别把服务商惹毛
  var BATCH_GAP = 700;      // 批间停顿（毫秒）
  var FAIL_PAUSE_AT = 3;    // 连续失败几个就停下来问一句

  function estimateText(n) {
    if (!n) return '';
    var sec = n * SEC_PER_JOB;
    if (sec < 60) return '约 ' + sec + ' 秒';
    return '约 ' + Math.ceil(sec / 60) + ' 分钟';
  }

  /* ---------------- 成本预估（为什么之前没有：弹窗只报了时间，钱成了盲盒） ---------------- */

  /** token 数 → 人话（9673 → 9673，96734 → 9.7 万） */
  function fmtTok(n) {
    return n >= 10000 ? (n / 10000).toFixed(1) + ' 万' : String(Math.round(n));
  }

  /** 钱 → 人话：分位以下也要显示出来（0.3 元显示成 ¥0.30，0.0004 显示成 ¥0.0004） */
  function fmtCost(v) {
    if (v >= 0.01) return '¥' + v.toFixed(2);
    return '¥' + v.toFixed(4);
  }

  /** 一批岗位评分的总成本预估（按真实提示词拼装逐条估，不是拍脑袋的单价×条数） */
  function costEstimate(jobs, resume) {
    var inT = 0, outT = 0;
    (jobs || []).forEach(function (j) {
      var e = AI.estimateMatchCall(j, resume);
      inT += e.inT;
      outT += e.outT;
    });
    return AI.costOf(inT, outT);
  }

  /** 确认弹窗里那行成本预估。估不出（AI 模块缺失）就返回空串，别挡着评分。 */
  function costText(jobs, resume) {
    if (!jobs || !jobs.length || !global.AI || !AI.estimateMatchCall) return '';
    var c = costEstimate(jobs, resume);
    return '预计消耗 ' + fmtTok(c.inT + c.outT) + ' token' +
      '（输入 ' + fmtTok(c.inT) + ' / 输出 ' + fmtTok(c.outT) + '）、约 ' + fmtCost(c.cost) +
      ' —— ' + c.priceFrom + '。';
  }

  /** 单岗位调用 —— 与简历页「拿它去匹配岗位」用的是同一个模板，不新造。
      onUsage：接住服务商返回的真实 token 用量（费用实时累计用；拿不到也不影响评分）。 */
  function callMatch(job, resume, signal, onUsage) {
    return AI.runTemplate('match', {
      resume: AI.resumeToText(resume),
      job: AI.jobToText(job, true),
    }, { signal: signal, onUsage: onUsage }).then(function (r) {
      if (!r || !r.data || typeof r.data !== 'object') {
        var e = new Error('模型没有返回可解析的匹配结果');
        e.code = 'BAD_DATA';
        throw e;
      }
      return r.data;
    });
  }

  /** 把一次评分写进岗位（字段口径与简历页完全一致，别再各写一套） */
  function applyVerdict(jobId, data, resumeId) {
    return Store.updateJob(jobId, {
      aiVerdict: {
        score: U.asNum(data.score),
        verdict: String(data.verdict || ''),
        category: String(data.category || ''),
        matched: U.asArray(data.matched),
        missing: U.asArray(data.missing),
        risks: U.asArray(data.risks),
        suggestions: U.asArray(data.suggestions),
        keywordsToAdd: U.asArray(data.keywordsToAdd, true),
        greetingHint: String(data.greetingHint || ''),
        resumeId: resumeId,
      },
      aiVerdictAt: U.now(),
    });
  }

  /**
   * 串行跑一批岗位的匹配评分。
   *
   * opt = {
   *   ids: [岗位 id],
   *   resume: 简历对象,
   *   ui: {
   *     tick(done, total, job),        // 每开始一个就调一次
   *     fail(list),                    // 失败清单变化
   *     askContinue(n) → Promise<bool>,// 连续失败 n 个时问要不要继续
   *     onUsage(usage),                // 服务商返回的真实 token 用量（费用实时累计）
   *     isCanceled() → bool,
   *     signal: AbortSignal | null,
   *   }
   * }
   * 返回 Promise<{ ok, fails:[{job,err}], canceled }>
   *
   * 设计要点：
   * - **串行**，不并发 —— 并发会撞服务商限流。
   * - 单个失败**不中断**整体，失败项记下来，最后给「重试失败的」。
   * - 取消时**已评的保留**（写盘发生在每个成功的当下，不是攒到最后）。
   */
  function runBatch(opt) {
    var ids = opt.ids || [];
    var resume = opt.resume;
    var ui = opt.ui || {};
    var noop = function () { };
    var tick = ui.tick || noop;
    var failCb = ui.fail || noop;
    var okCb = ui.ok || noop;
    var isCanceled = ui.isCanceled || function () { return false; };
    var askContinue = ui.askContinue || function () { return Promise.resolve(true); };

    var total = ids.length;
    var idx = 0, okN = 0, consec = 0;
    var fails = [];
    var ended = false;
    var usageCb = ui.onUsage || noop;

    function attempt(job, round) {
      return callMatch(job, resume, ui.signal, usageCb).catch(function (err) {
        // 主动取消导致的 abort 不算「失败」，直接往上抛，由 next 判断
        if (isCanceled()) throw err;
        if (round === 0) return attempt(job, 1);   // 失败重试 1 次
        throw err;
      });
    }

    function finish(canceled) {
      if (ended) return { ok: okN, fails: fails, canceled: !!canceled };
      ended = true;
      return { ok: okN, fails: fails, canceled: !!canceled };
    }

    function next() {
      if (isCanceled()) return finish(true);
      if (idx >= total) return finish(false);

      var job = Store.job(ids[idx]);
      if (!job) { idx++; return next(); }        // 岗位被删了，跳过

      var done = ++idx;
      tick(done, total, job);

      // 每跑满一批，停一下再继续（>30 个时才有意义，但小批量停 700ms 也无感）
      var gap = (done % BATCH_SIZE === 0 && done < total) ? wait(BATCH_GAP) : Promise.resolve();

      return gap.then(function () {
        if (isCanceled()) return finish(true);
        return attempt(job, 0).then(function (data) {
          if (!isCanceled()) {
            applyVerdict(job.id, data, resume && resume.id);
            okN++;
            okCb(job, data);
          }
          consec = 0;
          return next();
        }).catch(function (err) {
          if (isCanceled()) return finish(true);
          fails.push({ job: job, err: err });
          consec++;
          failCb(fails.slice());
          if (consec >= FAIL_PAUSE_AT) {
            return askContinue(consec).then(function (go) {
              if (!go) return finish(true);
              consec = 0;
              return next();
            });
          }
          return next();
        });
      });
    }

    return Promise.resolve().then(function () {
      if (!total) return finish(false);
      return next();
    });
  }

  /* -------- 批量入口的交互外壳 -------- */

  /**
   * 打开批量评分的入口流程：挑简历 → 确认范围 → 跑。
   *
   * opt = {
   *   scopes: [{ label, jobs }],   // 可选范围，默认取第一个
   *   presetName: '岗位库' | '采集结果',
   *   afterRun: fn(okN, fails)     // 跑完的回调（用于切排序 / 刷新页面）
   * }
   */
  function openBatch(opt) {
    opt = opt || {};

    if (!AI.ready()) {
      U.toast('还没配置模型接口。到「设置 → ① 大模型接口」填好 API Key 再来。', 'warn', 6000);
      App.go('settings');
      return;
    }

    var scopes = (opt.scopes || []).filter(function (s) { return s && s.jobs && s.jobs.length; });
    if (!scopes.length) {
      U.toast('没有可评分的岗位。先导入或采集一批岗位吧。', 'warn', 5000);
      return;
    }

    /* --- 挑简历 --- */
    var all = Store.resumes();
    if (!all.length) {
      U.toast('还没有简历 —— 先到「简历素材库」加一份，评分才有依据。', 'warn', 6000);
      App.go('resume');
      return;
    }
    var def = all.filter(function (r) { return r.isDefault; })[0];
    if (def) {
      openSetup(def, scopes, opt);
    } else {
      // 没有勾选"默认"的版本时，让用户自己挑一个（不替他猜）
      Comp.resumePicker({ title: '用哪份简历来评分？' }).then(function (rid) {
        if (!rid) return;
        var r = all.filter(function (x) { return x.id === rid; })[0];
        if (r) openSetup(r, scopes, opt);
      });
    }
  }

  function openSetup(resume, scopes, opt) {
    var scope = scopes[0];
    var redo = { on: false };

    var countBox = el('div', { class: 'fs12 muted' });
    var selScope = null;

    if (scopes.length > 1) {
      selScope = el('select', { style: 'width:auto;min-width:190px' });
      scopes.forEach(function (s, i) {
        selScope.appendChild(el('option', { value: String(i), text: s.label + '（' + s.jobs.length + ' 个）' }));
      });
      selScope.value = '0';
      selScope.addEventListener('change', function () {
        scope = scopes[Number(selScope.value)] || scopes[0];
        paintCount();
      });
    }

    function targets() {
      return redo.on ? scope.jobs : unscored(scope.jobs);
    }

    function paintCount() {
      var t = targets();
      countBox.innerHTML = '';
      var n = t.length;
      if (!n) {
        countBox.appendChild(el('div', { class: 'note warn' }, [
          el('span', { class: 'ico', text: 'ℹ️' }),
          el('div', { html: redo.on
            ? '这个范围里没有岗位。'
            : '这个范围里的岗位<b>都已经评过分了</b>。想重来一遍就勾上「重新评分」。' }),
        ]));
      } else {
        countBox.appendChild(el('div', { class: 'note info' }, [
          el('span', { class: 'ico', text: '🤖' }),
          el('div', { html:
            '将用「<b>' + U.esc(resume.name) + '</b>」给 <b>' + n + '</b> 个岗位逐个打分，' +
            '预计 ' + estimateText(n) + '。<br>' +
            '<span class="muted">💰 ' + (costText(t, resume) || '费用估不了（AI 模块没加载）') + '<br>' +
            '逐个串行调用，避免触发服务商限流；中途可以随时停止，已评的会保留。</span>' }),
        ]));
      }
      return n;
    }

    var cbRedo = el('input', { type: 'checkbox' });
    cbRedo.addEventListener('change', function () { redo.on = cbRedo.checked; paintCount(); });

    var body = el('div', { class: 'stack', style: 'gap:10px' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'fs12 muted fw6', text: '用哪份简历' }),
        el('span', { class: 'sp' }),
        el('b', { class: 'fs13', text: resume.name }),
      ].filter(Boolean)),
      scopes.length > 1 ? el('div', { class: 'row' }, [
        el('span', { class: 'fs12 muted fw6', text: '评分范围' }),
        el('span', { class: 'sp' }),
        selScope,
      ]) : el('div', { class: 'row' }, [
        el('span', { class: 'fs12 muted fw6', text: '评分范围' }),
        el('span', { class: 'sp' }),
        el('b', { class: 'fs13', text: scope.label + '（' + scope.jobs.length + ' 个）' }),
      ]),
      el('label', { class: 'chk' }, [cbRedo, el('span', { text: '重新评分（已评过分的也重跑一遍）' })]),
      countBox,
    ].filter(Boolean));

    paintCount();

    U.openModal({
      title: '🤖 按简历推荐',
      size: 'wide',
      body: body,
      footer: [
        {
          text: '开始评分', cls: 'pri',
          onClick: function (c) {
            var t = targets();
            if (!t.length) { U.toast('这个范围里没有要评分的岗位', 'warn'); return; }
            c();
            startRun(t.map(function (j) { return j.id; }), resume, opt);
          },
        },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  /** 进度弹窗 + 跑批。取消 = 停止，已评的保留；结束后给「重试失败的」。 */
  function startRun(ids, resume, opt) {
    var ui = { canceled: false, done: false };
    var ctl = null;
    var state = { okN: 0, failN: 0, total: ids.length, inT: 0, outT: 0, cost: 0 };

    function newCtl() {
      ctl = (typeof global.AbortController === 'function') ? new global.AbortController() : null;
    }
    newCtl();

    /* ---------------- 界面 ---------------- */
    var pctNum = el('b', { class: 'fs13', text: '0%' });
    var barIn = el('div', { class: 'pfill' });
    var curName = el('div', { class: 'fs12 muted mt8', text: '准备中…' });
    var statLine = el('div', { class: 'fs12 mt8' });
    var failBox = el('div', { class: 'stack', style: 'margin-top:10px;display:none' });

    var body = el('div', {}, [
      el('div', { class: 'row', style: 'gap:10px' }, [
        el('div', { class: 'pbar' }, [barIn]),
        pctNum,
      ]),
      curName,
      statLine,
      el('div', { class: 'hint tiny mt8', html:
        '正在逐个调用模型打分。<b>每评好一个就立刻保存</b>，中途停止也不会白跑。' }),
      failBox,
    ]);

    var bClose = el('button', { class: 'btn icon', text: '✕', title: '收起窗口（评分会停）', onclick: function () { m.close(); } });
    var bStop = el('button', { class: 'btn', text: '停止', onclick: function () { stop(false); } });
    var bRetry = el('button', { class: 'btn', text: '重试失败的', style: 'display:none' });
    var bGo = el('button', { class: 'btn pri', text: '按匹配分看结果', style: 'display:none' });

    var m = U.openModal({
      title: '🤖 按简历推荐 · 正在评分',
      size: 'wide',
      body: body,
      maskClose: false,
      footer: [],
      // 关窗就是停 —— 不这么做的话，用户以为关掉就不跑了，后台还在猛调模型
      onClose: function () { stop(true); },
    });

    // openModal 不返回 footer 节点，自己从这张弹窗里取（别用全局选择器，可能选到别的弹窗）
    var foot = m.modal.querySelector('.mfoot');
    if (foot) {
      foot.innerHTML = '';
      [bClose, bStop, bRetry, bGo].forEach(function (b) { foot.appendChild(b); });
    }

    function stop(silent) {
      if (ui.done || ui.canceled) return;
      ui.canceled = true;
      if (ctl) { try { ctl.abort(); } catch (e) { /* noop */ } }
      bStop.style.display = 'none';
      if (!silent) U.toast('已停止评分 —— 已经评好的岗位都保留着。', 'info', 5000);
    }

    function paintProgress(done, job) {
      var pct = Math.min(100, Math.round(done / (state.total || 1) * 100));
      barIn.style.width = pct + '%';
      pctNum.textContent = pct + '%';
      curName.textContent = '正在评分 ' + Math.min(done, state.total) + '/' + state.total + ' · ' +
        (trim(job && job.title) || '（无岗位名）');
    }

    function paintStat() {
      statLine.innerHTML = '';
      var s = el('span', { class: 'muted', html:
        '已完成 <b>' + (state.okN + state.failN) + '</b> / ' + state.total +
        '　成功 <b class="ok-c">' + state.okN + '</b>' +
        (state.failN ? '　失败 <b class="warn-c">' + state.failN + '</b>' : '') });
      statLine.appendChild(s);
      /* 真实花费（服务商返回的 usage 折算）—— 之前只报进度不报钱，成本就成了盲盒 */
      if (state.inT || state.outT) {
        statLine.appendChild(el('div', { class: 'muted fs12', html:
          '已消耗 ≈ <b>' + (global.AI && AI.costOf ? fmtCost(state.cost) : '?') +
          '</b>（输入 ' + fmtTok(state.inT) + ' / 输出 ' + fmtTok(state.outT) + ' token）' }));
      }
    }

    /** 接住单次调用的真实 usage，累进 state（usage 拿不到时这里不触发，评分不受影响） */
    function onUsage(u) {
      if (!u || !global.AI || !AI.costOf) return;
      var c = AI.costOf(Number(u.prompt_tokens) || 0, Number(u.completion_tokens) || 0);
      state.inT += c.inT;
      state.outT += c.outT;
      state.cost += c.cost;
      paintStat();
    }

    function paintFails(fails) {
      if (!fails || !fails.length) { failBox.style.display = 'none'; return; }
      failBox.style.display = '';
      failBox.innerHTML = '';
      failBox.appendChild(el('div', { class: 'fs12 fw6 warn-c mb4', text: '失败 ' + fails.length + ' 个：' }));
      var tbody = el('tbody');
      fails.slice(0, 20).forEach(function (x) {
        tbody.appendChild(el('tr', {}, [
          el('td', { text: trim(x.job && x.job.title) || '（无岗位名）' }),
          el('td', { class: 'muted fs12', text: (x.err && (x.err.message || String(x.err))) || '未知错误' }),
        ]));
      });
      var tb = el('table', { class: 'tb' }, [tbody]);
      failBox.appendChild(el('div', { class: 'tb-wrap', style: 'max-height:26vh' }, [tb]));
      if (fails.length > 20) {
        failBox.appendChild(el('div', { class: 'fs12 muted', text: '…还有 ' + (fails.length - 20) + ' 个' }));
      }
    }

    /** 把页面切到「匹配分由高到低」—— 跑完评分后不这么做，用户还得自己去找排序 */
    function applyScoreSort() {
      var f = (global.Views && global.Views.jobs) ? global.Views.jobs.filters : null;
      if (f) { f.sort = 'score'; f.status = ''; }
    }

    function finish(r) {
      ui.done = true;
      state.okN = r.ok;
      state.failN = r.fails.length;
      barIn.style.width = '100%';
      pctNum.textContent = '100%';
      curName.textContent = r.canceled ? '已停止。' : '全部跑完。';
      paintStat();
      paintFails(r.fails);
      bStop.style.display = 'none';
      bClose.style.display = 'none';

      if (r.ok > 0) {
        bGo.style.display = '';
        bGo.onclick = function () { m.close(); App.go('jobs'); };
      }
      if (r.fails.length) {
        bRetry.style.display = '';
        bRetry.onclick = function () {
          launch(r.fails.map(function (x) { return x.job.id; }));
        };
      }

      U.toastHtml(r.ok > 0
        ? '已为 <b>' + r.ok + '</b> 个岗位评分' + (r.fails.length ? '，' + r.fails.length + ' 个失败' : '') +
          '，列表已按匹配分排序。' +
          ((state.inT || state.outT) ? '实际消耗 ≈ <b>' + fmtCost(state.cost) + '</b>' +
            '（' + fmtTok(state.inT + state.outT) + ' token）。' : '')
        : '一个都没评成功' + (r.canceled ? '（已停止）' : '') + '，可以点「重试失败的」再试一次。',
        r.ok > 0 ? 'ok' : 'warn', 8000);

      if (r.ok > 0) {
        applyScoreSort();
        if (opt.afterRun) opt.afterRun(r.ok, r.fails);
      }
    }

    /**
     * 跑一批。同一个弹窗可重复调用（「重试失败的」就走这条路），
     * 所以每次都要把状态和界面复位 —— 不然第二次跑时进度条停在 100%、
     * 成功率还带着上一次的数字。
     */
    function launch(list) {
      state.total = list.length;
      state.okN = 0;
      state.failN = 0;
      state.inT = 0;
      state.outT = 0;
      state.cost = 0;
      ui.canceled = false;
      ui.done = false;
      newCtl();

      barIn.style.width = '0%';
      pctNum.textContent = '0%';
      curName.textContent = '准备中…';
      statLine.innerHTML = '';
      failBox.style.display = 'none';
      failBox.innerHTML = '';
      bStop.style.display = '';
      bClose.style.display = '';
      bRetry.style.display = 'none';
      bGo.style.display = 'none';
      bGo.onclick = null;
      paintStat();

      if (!state.total) { finish({ ok: 0, fails: [], canceled: false }); return Promise.resolve(); }

      return runBatch({
        ids: list,
        resume: resume,
        ui: {
          signal: ctl ? ctl.signal : null,
          isCanceled: function () { return ui.canceled; },
          tick: function (done, tot, job) { paintProgress(done, job); },
          onUsage: onUsage,
          ok: function () { state.okN++; paintStat(); },
          fail: function (fails) { state.failN = fails.length; paintStat(); paintFails(fails); },
          askContinue: function (n) {
            return U.confirm(
              '连续 <b>' + n + '</b> 个岗位评分失败，可能是网络不稳，也可能是模型服务商在限流。<br>' +
              '<span class="muted fs12">已经评好的岗位都保存了，不会丢。</span><br><br>要继续往下跑吗？',
              { okText: '继续跑', title: '连续失败', danger: true });
          },
        },
      }).then(finish);
    }

    launch(ids);
  }

  /* ==================== 导出 ==================== */
  global.JobMatch = {
    // 偏好
    prefs: prefs, hasPref: hasPref,
    cityHit: cityHit, salaryHit: salaryHit, dealHit: dealHit, jobHit: jobHit, passPref: passPref,
    describePref: describePref,
    // 福利待遇（多选）
    welfareHit: welfareHit, welfareHitN: welfareHitN, welfareOpt: welfareOpt,
    welfareText: welfareText, WELFARE_OPTIONS: WELFARE_OPTIONS,
    // 地理下钻（区 / 商圈 / 地标）
    areaHit: areaHit, areaUnknown: areaUnknown, areaNeed: areaNeed, geoOf: geoOf,
    // 自然语言
    parseQuery: parseQuery, describeQuery: describeQuery, passQuery: passQuery,
    keywordHay: keywordHay, CITY_WORDS: CITY_WORDS,
    // 快捷 chips
    QUICK: QUICK, quickDef: quickDef, quickReady: quickReady, passQuick: passQuick,
    // 批量评分
    hasScore: hasScore, unscored: unscored, estimateText: estimateText,
    costEstimate: costEstimate, costText: costText, fmtCost: fmtCost, fmtTok: fmtTok,
    callMatch: callMatch, applyVerdict: applyVerdict, runBatch: runBatch,
    openBatch: openBatch,
    // 常量（测试要用，也方便调参）
    SEC_PER_JOB: SEC_PER_JOB, BATCH_SIZE: BATCH_SIZE, FAIL_PAUSE_AT: FAIL_PAUSE_AT,
  };
})(window);
