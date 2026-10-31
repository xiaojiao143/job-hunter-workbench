/* ==========================================================================
   job-score.js · 本地「岗位合适度」打分引擎（零 token、可解释、可复现）
   --------------------------------------------------------------------------
   落地《采集器优化修改思路》第 7 节的筛选机制：
     硬性过滤（剔除 / 降级观望） → 5 维加权打分 → 动态加减分 → A/B/C/D 分级
   并产出「匹配依据」一行字，回答用户那句「为什么推这条」。

   为什么另做一套，而不是直接用 job-match.js 的 AI 批量评分：
     · AI 分要花钱、要联网、每次跑结果还不一样，而且**说不出为什么**；
     · 这套分是纯字符串函数，能重放、能逐条核对、能当排序键；
     · 分工：本地分负责「排序 + 解释 + 分级」，AI 分负责「读 JD 语义」。
       UI 上分开叫「合适度」（本地）与「匹配」（AI），不混为一谈。

   依赖：U（utils.js）、JobMatch（job-match.js，复用 cityHit / salaryHit / dealHit）。
   本文件是**纯逻辑**：不碰 DOM，所以不建 el 别名（本项目的静态检查会反向查
   「建了别名却没用」，两头都不许有多余代码）。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ⚠️ 本项目的静态检查要求：文件里用到 el() 就必须建这个别名，否则运行时 ReferenceError。
     本文件 99% 是纯逻辑，只有最后那个「怎么算的」说明弹窗要用 DOM —— 所以这就一个文件名下的两副面孔。 */
  var el = Comp.el;

  function trim(s) { return String(s === null || s === undefined ? '' : s).trim(); }
  function low(s) { return trim(s).toLowerCase(); }
  function num(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    return isNaN(n) ? null : n;
  }
  function uniq(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (x) {
      var v = trim(x);
      if (!v) return;
      var k = v.toLowerCase();
      if (seen[k]) return;
      seen[k] = 1;
      out.push(v);
    });
    return out;
  }
  function hasAny(hay, words) {
    for (var i = 0; i < words.length; i++) {
      if (hay.indexOf(low(words[i])) >= 0) return words[i];
    }
    return '';
  }

  /* ==================== 默认口径 ==================== */

  /* 画像关键词。只有用户「既没在设置里填方向词、也没选期望岗位」时才用它 ——
     这不是猜，是把简历画像固化下来的**可编辑默认值**（设置页能改，也能一键恢复）。 */
  var DEFAULT_FOCUS = [
    '新媒体运营', '内容运营', '短视频运营', '直播运营', '抖音', '视频号', '小红书',
    '公众号', '账号搭建', '内容矩阵', 'IP孵化', '脚本撰写', '数据复盘', '私域转化',
    '引流获客', 'AI工作流', 'AI数字人', 'AIGC', '起号', '涨粉', '图文', '剪辑', '直播',
  ];

  /* ① 岗位方向（30 分）认的「方向词」。
     ⚠️ 刻意**不含裸的「运营」** —— 含了它，任何带"运营"两个字的标题都会拿满 30 分，
     粒度就没了（「销售运营」和「短视频运营」同分）。裸「运营」在 dirScore 里降一档算 14 分。
     这张表同时是硬性过滤的判据：标题命中这里 = 确实是运营方向，不会被当「蹭词」剔除。 */
  var DEFAULT_DIRECTIONS = [
    '内容运营', '新媒体运营', '短视频运营', '直播运营', '账号运营', '自媒体运营',
    '用户运营', '社群运营', '电商运营', '活动运营', '产品运营', '数据运营', '平台运营',
    '短视频', '新媒体', '内容策划', '直播',
  ];

  /* ④ 动态加分认的「对口行业」 */
  var DEFAULT_INDUSTRIES = [
    'MCN', '电商', '互联网', '传媒', '文化', '广告', '内容', '新媒体', '影视',
    '直播', '教育', '品牌', '营销', '娱乐', '社交',
  ];

  /* 「蹭运营词」的岗位：标题命中这些、又完全不含方向词 → 判定为实质岗位不符。
     ⚠️ 只在**标题**上判，不扫 JD —— JD 里「配合销售」「对接客服」这种表述太常见，
     扫正文会大面积误杀（这正是「不能接受的点」当初刻意不扫 JD 的同一个理由）。 */
  var OFF_DIRECTION = [
    '销售', '客服', '行政', '文员', '人事', '财务', '会计', '出纳', '前台', '导购',
    '店长', '招商', '渠道', '地推', '催收', '信贷', '电销', '话务', '录入', '招生',
    '教务', '保险代理', '房产经纪', '置业顾问', '电话客服',
  ];

  /* 休息制度（假期）。只有「双休」算正经福利，大小周 / 单休是妥协不是加分项 ——
     所以 rank 用来排序和展示，但**只有 rank 3 才计入福利档位**。
     这几条既喂给 ⑤ 福利稳定，也喂给「岗位对比」的假期维度，一份口径两处用。 */
  var REST_KINDS = [
    { key: '双休', rank: 3, re: /双休|周末双休|做五休二/ },
    { key: '大小周', rank: 2, re: /大小周/ },
    { key: '单休', rank: 1, re: /单休|做六休一/ },
    { key: '轮休', rank: 1, re: /轮休|轮班|排休|倒班/ },
  ];

  /* 学历硬门槛：数值越大越高。取「先匹配到的第一个」——所以「本科及以上」要排在「本科」前面。 */
  var DEGREES = [
    ['不限', 0], ['中专', 1], ['中技', 1], ['高中', 1], ['初中', 1],
    ['大专', 2], ['专科', 2], ['高职', 2],
    ['本科', 3], ['学士', 3],
    ['硕士', 4], ['研究生', 4], ['MBA', 4], ['EMBA', 4],
    ['博士', 5],
  ];

  var LEVELS = [
    { key: 'A', min: 80, label: '强推', cls: 'ok', advice: '方向对口、关键词命中多，优先投' },
    { key: 'B', min: 60, label: '可投', cls: 'info', advice: '部分匹配，扫一眼 JD 再定' },
    { key: 'C', min: 40, label: '观望', cls: 'warn', advice: '有硬伤但可谈，竞争少时反而回复快' },
    { key: 'D', min: -1, label: '跳过', cls: 'bad', advice: '实质不符或硬伤明显，省下沟通次数' },
  ];

  /* 权重（合计 100）。文档说得很清楚：跑 1-2 轮后按实际回复率再调，
     所以放成常量导出，测试和 UI 都能直接读，不散落在各个函数里。 */
  var WEIGHTS = { direction: 30, keywords: 30, salary: 20, experience: 10, welfare: 10 };

  /* ==================== 配置 ==================== */

  /** 从偏好 + 简历拼出打分口径。opt 里给了就用给的，没给就现取。 */
  function config(opt) {
    opt = opt || {};
    var p = opt.prefs || (global.JobMatch ? global.JobMatch.prefs() : {});
    var resume = opt.resume || null;

    var expectJobs = (p.expectJobs || []).slice();
    var focus = (p.focusKeywords || []).slice();

    /* 关键词来源（合并去重）：
       ① 设置里填了「求职方向关键词」→ 用填的，再并上 ② 期望岗位 ③ 简历标签
       ④ 没填 → 内置画像词兜底，**期望岗位和简历标签照样并进来**

       ⚠️ 兜底判据只能是 focusKeywords 空不空，**不能**写成「合并后为空」——
          那样用户只要选了「期望岗位」，兜底就被顺手关掉，手里只剩 1 个词，
          关键词维度（占 30 分）等于直接废掉，而且一点提示都不会有。 */
    var resumeTags = resume ? (resume.tags || []) : [];
    var usingDefault = !focus.length;
    var keywords = uniq((usingDefault ? DEFAULT_FOCUS : focus).concat(expectJobs).concat(resumeTags));

    return {
      keywords: keywords,
      usingDefaultKeywords: usingDefault,
      keywordsFrom: {
        focus: focus.length, expectJobs: expectJobs.length,
        resumeTags: resumeTags.length,
      },
      directions: uniq(DEFAULT_DIRECTIONS.concat(expectJobs)),
      industries: uniq(DEFAULT_INDUSTRIES.concat(p.industries || [])),
      cities: (p.cities || []).slice(),
      exclude: (p.dealBreakers || []).slice(),
      salaryMin: num(p.salaryMin),
      salaryMax: num(p.salaryMax),
      myYears: num(p.myYears),
      myDegree: trim(p.myDegree) || '大专',
    };
  }

  /* ==================== 硬性过滤（文档 §7.2） ==================== */

  function degRank(s) {
    var t = trim(s);
    if (!t) return null;
    for (var i = 0; i < DEGREES.length; i++) {
      if (t.indexOf(DEGREES[i][0]) >= 0) return DEGREES[i][1];
    }
    return null;
  }

  /**
   * 硬性过滤。返回 { drop, reason, warn[] }。
   * drop = 直接剔除（不进打分）；warn = 降级观望（标黄，仍参与打分但被扣分）。
   */
  function gate(job, cfg) {
    var out = { drop: false, reason: '', warn: [] };
    if (!job) { out.drop = true; out.reason = '没有岗位数据'; return out; }

    /* --- 剔除 ① 工作地不在目标城市 --- */
    if (cfg.cities.length && global.JobMatch && !global.JobMatch.cityHit(job, cfg.cities)) {
      var loc = trim(job.location);
      /* 地点为空**不剔** —— 信息不全就砍掉，用户会以为岗位丢了（同「薪资为空一律保留」） */
      if (loc) {
        out.drop = true;
        out.reason = '工作地在「' + loc + '」，不在目标城市（' + cfg.cities.join('/') + '）';
        return out;
      }
      out.warn.push({ code: 'locEmpty', text: '没写工作地点，城市是否合适要自己确认' });
    }

    /* --- 剔除 ② 实质岗位不符（「销售/客服/行政」蹭「运营」） --- */
    var title = low(job.title);
    if (title) {
      var off = hasAny(title, OFF_DIRECTION);
      var hasDirWord = !!hasAny(title, cfg.directions);
      if (off && !hasDirWord) {
        out.drop = true;
        out.reason = '岗位名「' + trim(job.title) + '」属于「' + off + '」，不是运营方向';
        return out;
      }
    }

    /* --- 剔除 ③ 「不能接受的点」里的外包：只在用户明确写了「外包」时才拿它剔 --- */
    if (job.proxyHire && cfg.exclude.some(function (b) { return /外包|代招|派遣|劳务|中介/.test(trim(b)); })) {
      out.drop = true;
      out.reason = 'BOSS 标注为「代招」（用工主体不是这家公司），命中你写的「不能接受的点」';
      return out;
    }

    /* --- 降级观望（标黄，不杀） --- */
    var need = degRank(job.reqDegree);
    var mine = degRank(cfg.myDegree);
    if (need !== null && mine !== null && need > mine) {
      out.warn.push({
        code: 'degree',
        text: '要求「' + trim(job.reqDegree) + '」，你填的是「' + cfg.myDegree + '」' +
          (need - mine >= 2 ? ' —— 差距大，简历大概率过不了筛' : ' —— 可能通融，值得一问'),
      });
    }
    var hi = num(job.salaryMax) === null ? num(job.salaryMin) : num(job.salaryMax);
    if (hi !== null && cfg.salaryMin !== null && hi < cfg.salaryMin - 2) {
      out.warn.push({ code: 'salaryLow', text: '薪资上限 ' + hi + 'K，比你的期望 ' + cfg.salaryMin + 'K 低不少' });
    }
    var yn = trim(job.reqYears);
    var ym = yn.match(/\d+/g);
    if (ym && cfg.myYears !== null && /年以上|年经验以上/.test(yn) && Number(ym[0]) - cfg.myYears >= 3) {
      out.warn.push({ code: 'years', text: '要求「' + yn + '」，你填的是 ' + cfg.myYears + ' 年 —— 差距大' });
    }
    if (job.invalid) {
      out.warn.push({ code: 'invalid', text: 'BOSS 已标注这个岗位失效，投了大概率没回应' });
    }
    return out;
  }

  /* ==================== 5 维打分（文档 §7.3） ==================== */

  /** ① 岗位方向 30：标题对口 > 职责对口 > 泛运营 > 无 */
  function dirScore(job, cfg) {
    var t = low(job.title);
    var body = low(trim(job.title) + ' ' + (job.duties || []).join(' '));
    if (t && hasAny(t, cfg.directions)) return WEIGHTS.direction;
    if (hasAny(body, cfg.directions)) return 20;
    if (t.indexOf('运营') >= 0) return 14;
    if (body.indexOf('运营') >= 0) return 10;
    return 0;
  }

  /** ② 关键词命中 30：每命中 1 个 6 分，5 个封顶（文档：5+ = 高分） */
  function keyScore(job, cfg) {
    var hay = (global.JobMatch ? global.JobMatch.keywordHay(job) : low(
      [job.title, job.company, job.rawJD, (job.duties || []).join(' ')].join(' ')));
    var hits = [];
    cfg.keywords.forEach(function (w) {
      if (hay.indexOf(low(w)) >= 0) hits.push(w);
    });
    return { score: Math.min(WEIGHTS.keywords, hits.length * 6), hits: hits };
  }

  /**
   * ③ 薪资匹配 20。
   * ⚠️ 判的是「岗位给不给得起我要的」，不是「区间重不重合」——
   * 期望 9K 的人看到 12-20K 的岗位不该被扣分（那是好事）。
   * 「面议」按中性算，不误杀（与 job-match 的 salaryHit 同一态度）。
   */
  function salScore(job, cfg) {
    var lo = num(job.salaryMin), hi = num(job.salaryMax);
    if (lo === null && hi === null) return { score: 10, note: '薪资面议（按中性算）' };
    var want = cfg.salaryMin;
    if (want === null) {
      var band0 = (lo !== null && hi !== null) ? (lo + '-' + hi + 'K')
        : (lo !== null ? lo + 'K' : hi + 'K（只写了上限）');
      return { score: 10, note: band0 + '（你没填期望薪资，按中性算）' };
    }
    /* ⛔ 只有上限、没写起点时，不能把上限当起点（评审核实 2026-10-30，P0）。
       以前 `var jobLo = lo !== null ? lo : hi` 会把「只写 20K 上限」当成「起点 20K」，
       期望 10K 的人直接拿满分 20 分、note 还写「20K 起点就 ≥ 你的 10K」——
       而岗位根本没写起点。起点未知就只做「上限够不够得着期望」的重叠判断。 */
    if (lo === null) {
      if (hi >= want) return { score: 14, note: hi + 'K（只写了上限）与你的 ' + want + 'K 有重叠' };
      return { score: hi >= want - 3 ? 6 : 0, note: '只写了上限 ' + hi + 'K，够不着你的 ' + want + 'K' };
    }
    // 有下限（可能有上限）
    var band = (hi !== null) ? (lo + '-' + hi + 'K') : (lo + 'K');
    if (lo >= want) return { score: WEIGHTS.salary, note: band + ' 起点就 ≥ 你的 ' + want + 'K' };
    if (hi !== null && hi >= want) return { score: 14, note: band + ' 与你的 ' + want + 'K 有重叠' };
    var effectiveHi = hi !== null ? hi : lo;
    return { score: effectiveHi >= want - 3 ? 6 : 0, note: band + ' 够不着你的 ' + want + 'K' };
  }

  /** ④ 经验匹配 10：1-3 年最佳 · 不限中等 · 超出越多越低 */
  function expScore(job, cfg) {
    var t = trim(job.reqYears);
    var mine = cfg.myYears;
    if (!t) return { score: 5, note: '经验未写明（按中性算）' };
    if (/不限|无经验|应届/.test(t)) return { score: 6, note: '经验不限' };
    var m = t.match(/\d+/g);
    if (!m) return { score: 5, note: '经验「' + t + '」看不懂（按中性算）' };
    var a = Number(m[0]);
    var b = m.length > 1 ? Number(m[1]) : null;
    if (mine === null) return { score: 5, note: '经验要求 ' + t + '（你没填年限，按中性算）' };

    /* 「1 年以下 / 1 年以内」是**上限型**区间 [0, a]。
       ⚠️ 必须先于下面那条「a <= mine && b 为空」判 —— 否则它的 b 恰好也是空，
          mine=2 会被判成「正好在区间里」拿满分，而它其实只想要 1 年以内（我超配了）。 */
    if (/以下|以内/.test(t)) {
      return mine <= a
        ? { score: 10, note: '经验要求 ' + t + '，你正好在区间里' }
        : { score: 8, note: '经验要求 ' + t + '，你略超配' };
    }
    if (a <= mine && (b === null || b >= mine)) return { score: 10, note: '经验要求 ' + t + '，你正好在区间里' };
    if (/年以上/.test(t)) {
      var gap = a - mine;
      return { score: gap <= 1 ? 6 : gap <= 2 ? 3 : 0, note: '经验要求 ' + t + '，你 ' + mine + ' 年' };
    }
    if (b !== null && b < mine) return { score: 8, note: '经验要求 ' + t + '，你略超配' };
    if (a > mine) return { score: 4, note: '经验要求 ' + t + '，你 ' + mine + ' 年略欠' };
    return { score: 5, note: '经验要求 ' + t + '（按中性算）' };
  }

  /* ---------------- 福利拆解（打分 + 岗位对比共用一份口径） ----------------
     ⚠️ 采集回来的 benefits 有两种形态，两种都得认，否则真实数据上会集体空白：
        · 手动录入 / CSV：数组、按逗号分隔   ['五险一金', '双休']
        · boss-crawler 列表页：**一个挤在一起的长串**
          ['交通补助 有无线网 工龄奖 全勤奖 年终奖 法定节假日三薪 加班补助 团建聚餐 五险一金'] */
  function welfareText(job) {
    return low((job && job.benefits ? job.benefits : []).join(' '));
  }

  /** 把福利串拆成逐项（保留原始写法，供对比表逐条列出来） */
  function welfareItems(job) {
    var out = [];
    (job && job.benefits ? job.benefits : []).forEach(function (s) {
      String(s).split(/[,，、;；/|\s]+/).forEach(function (x) {
        var v = trim(x);
        /* 太长的多半是被切碎的一句话，当不成"一项福利"，丢掉比列出来好 */
        if (v && v.length <= 12 && out.indexOf(v) < 0) out.push(v);
      });
    });
    return out;
  }

  /** 休息制度。rank 3 双休 / 2 大小周 / 1 单休轮休 / 0 有福利数据但没提 / null 福利压根没采到 */
  function restOf(job) {
    var t = welfareText(job);
    if (!t) return { key: '', rank: null, text: '福利没采到' };
    for (var i = 0; i < REST_KINDS.length; i++) {
      if (REST_KINDS[i].re.test(t)) {
        return { key: REST_KINDS[i].key, rank: REST_KINDS[i].rank, text: REST_KINDS[i].key };
      }
    }
    return { key: '', rank: 0, text: '没写休息制度' };
  }

  /** 五险一金 / 公积金 / 只有五险 */
  function insuranceOf(job) {
    var t = welfareText(job);
    if (!t) return { key: '', text: '福利没采到' };
    if (/五险一金|六险一金/.test(t)) return { key: '五险一金', text: '五险一金' };
    if (/公积金/.test(t)) return { key: '公积金', text: '有公积金' };
    if (/五险|六险|社保/.test(t)) return { key: '五险', text: '五险（没提公积金）' };
    return { key: '', text: '没提' };
  }

  /**
   * 福利全景。返回 { has, raw, items, rest, insurance, legal, annual, bonus,
   *                subsidy, flexible, softs, level }
   * `level` = 计入 ⑤ 福利稳定 的档位数（0-4）：双休 / 五险一金 / 年终奖补贴年假 / 弹性
   */
  function welfareOf(job) {
    var t = welfareText(job);
    var out = {
      has: !!t, raw: t, items: welfareItems(job),
      rest: restOf(job), insurance: insuranceOf(job),
      legal: false, annual: false, bonus: false, subsidy: false, flexible: false,
      softs: [], level: 0,
    };
    if (!t) return out;

    out.legal = /法定节假日|法定假日|节假日三薪|三薪/.test(t);
    out.annual = /年假|带薪假|带薪休假/.test(t);
    out.bonus = /年终奖|十三薪|14薪|十五薪|季度奖|项目奖|分红/.test(t);
    out.subsidy = /补助|补贴|餐补|房补|话补|车补|节日|体检|补充医疗|商业保险/.test(t);
    out.flexible = /弹性|不加班|朝九晚六|灵活|不打卡/.test(t);

    /* ⚠️ 下午茶 / 零食 / 团建这类是**软福利**：有它不代表岗位稳定，没它也不该扣分。
       所以**不计档**，只在说明里如实写出来。
       否则「只有下午茶」会和「只有双休」拿同一个 5 分，这一维就没有区分度了。 */
    if (/下午茶|零食|团建|聚餐|生日|旅游|outing/.test(t)) out.softs.push('下午茶/团建');

    /* ⚠️ 休息制度里**只认双休**。大小周 / 单休是求职者要妥协的东西，不是福利 ——
       把它算成加分项，等于告诉用户「大小周也是好岗位」。 */
    if (out.rest.rank === 3) out.level++;
    if (out.insurance.key) out.level++;
    if (out.bonus || out.subsidy || out.annual) out.level++;
    if (out.flexible) out.level++;
    return out;
  }

  /** ⑤ 福利稳定 10：双休 / 五险一金 / 年终奖补贴年假 / 弹性，各算一档 */
  function welScore(job) {
    var w = welfareOf(job);
    if (!w.has) return { score: 5, note: '福利没采到（按中性算）' };

    var got = [];
    if (w.rest.rank === 3) got.push('双休');
    else if (w.rest.rank > 0) got.push(w.rest.key + '（不算福利）');
    if (w.insurance.key) got.push(w.insurance.text);
    if (w.bonus) got.push('年终奖');
    if (w.annual) got.push('年假');
    if (w.legal) got.push('法定节假日');
    if (w.subsidy) got.push('补贴');
    if (w.flexible) got.push('弹性/不加班');

    var note = (got.length ? got.join(' + ') : '只有软福利') +
      (w.softs.length ? '（另有' + w.softs.join('/') + '这类软福利，不计分）' : '');
    return { score: w.level >= 3 ? 10 : w.level === 2 ? 8 : w.level === 1 ? 5 : 2, note: note };
  }

  /* ---------------- 公司规模 ---------------- */

  /**
   * 公司规模。BOSS 给的是区间文本（"1000-9999人" / "20-99人" / "10000人以上"），
   * 取上界当排序键；解析不出来就返回 null（不猜）。
   */
  function scaleRank(s) {
    var t = trim(s);
    if (!t) return null;
    var ns = t.match(/\d+/g);
    if (!ns) return null;
    return Math.max.apply(null, ns.map(Number));
  }

  /** 规模说人话。用于对比表的副标题（"1000-9999人" → "千人级中大型"）。 */
  function scaleLabel(s) {
    var n = scaleRank(s);
    if (n === null) return '';
    if (n >= 10000) return '万人级大厂';
    if (n >= 1000) return '千人级中大型';
    if (n >= 500) return '五百人级';
    if (n >= 100) return '百人级';
    if (n >= 20) return '小型团队';
    return '微型团队';
  }

  /* ==================== 动态加减分（文档 §7.4） ==================== */

  function delta(job, cfg) {
    var d = 0, why = [];
    var act = trim(job.active);
    if (/刚刚|今日|在线/.test(act)) { d += 4; why.push('HR ' + act + ' +4'); }
    else if (/3日|本周/.test(act)) { d += 2; why.push('HR ' + act + ' +2'); }
    else if (/月内|月活跃|半年前|年内/.test(act)) { d -= 3; why.push('HR ' + act + ' -3'); }

    var hay = low([job.title, (job.tags || []).join(' '), (job.benefits || []).join(' ')].join(' '));
    if (/急招|急聘|急招人|急需/.test(hay)) { d += 3; why.push('标注「急招」+3'); }

    var ind = trim(job.industry);
    if (ind && hasAny(low(ind), cfg.industries)) { d += 3; why.push('行业对口（' + ind + '）+3'); }

    /* 权威技能要求命中（评审 P2-2.2）：job.reqSkillsAuthoritative 是从 JD 正文抽出的
       「硬技能要求」（如抖音/剪映/数据分析），以前 export.js 算出来挂上岗位对象、却
       全库没人读 —— 两端都断。这里拿它和用户画像关键词（含简历标签）做交集：重合
       越多，技能越对口。只加分、不扣分 —— 技能要求是加分项不是硬门槛，用户没写全
       画像不等于不匹配。 */
    var needSkills = U.asArray(job.reqSkillsAuthoritative);
    if (needSkills.length) {
      var hitSkills = 0;
      needSkills.forEach(function (sk) {
        var skl = low(sk);
        if (skl && cfg.keywords.some(function (k) { return skl.indexOf(low(k)) >= 0; })) {
          hitSkills++;
        }
      });
      if (hitSkills >= 2) { d += 3; why.push('JD 技能要求命中 ' + hitSkills + ' 项 +3'); }
      else if (hitSkills === 1) { d += 1; why.push('JD 技能要求命中 1 项 +1'); }
    }

    /* 信息残缺：**除岗位名外一个字段都没采到**才扣。
       ⚠️ 早先写成「6 个字段里只填了 ≤2 个」—— 可 company / location 在采集结果里
          几乎总是有的，于是几乎每条岗位都被无差别扣 3 分。扣分一旦全员平等，
          它就只剩「把其它信号的区分度冲平」这一个作用了。 */
    var filled = ['company', 'location', 'salaryText', 'industry', 'reqYears', 'reqDegree']
      .filter(function (k) { return trim(job[k]); }).length;
    if (filled === 0) { d -= 3; why.push('信息残缺（除了岗位名什么都没采到）-3'); }

    /* ⚠️ 有意的偏离：文档 §7.4 还写了「面议无信号 −」，这里**刻意不做**。三条理由：
       ① 薪资维度已经写明「面议按中性 10 分」，同一个事实一边当中性一边扣分是自相矛盾；
       ② 它和「信息残缺」罚的是同一件事（这条记录太薄），叠加就是重复扣分；
       ③ 从列表页抓回来的岗位本来就没有 JD 和福利，「面议 + 无福利」极常见 ——
          照抄这条等于给所有面议岗位系统性降权，而「面议」在 BOSS 上完全合法。 */

    var need = degRank(job.reqDegree), mine = degRank(cfg.myDegree);
    if (need !== null && mine !== null && need > mine) {
      d -= (need - mine) >= 2 ? 6 : 3;
      why.push('学历门槛高 ' + (need - mine >= 2 ? '-6' : '-3'));
    }
    if (job.proxyHire) { d -= 3; why.push('代招（用工主体存疑）-3'); }
    return { value: d, why: why };
  }

  /* ==================== 分级 + 依据 ==================== */

  function levelOf(total) {
    for (var i = 0; i < LEVELS.length; i++) {
      if (total >= LEVELS[i].min) return LEVELS[i];
    }
    return LEVELS[LEVELS.length - 1];
  }

  /**
   * 一句话依据 —— **优势必须说，硬伤也必须说**。
   *
   * ⚠️ 早先只写优势。于是一个「方向对口、但学历差两档、薪资还够不着」的岗位，
   *    卡片上看起来跟 A 级一模一样，用户点进详情才发现不是 —— 原因行等于在撒谎。
   *    现在：正面信号、负面信号都列出来，正反面各截断，保证一行放得下。
   */
  function reasonOf(r) {
    var good = [], bad = [];

    /* --- 正面 --- */
    if (r.dims.direction >= WEIGHTS.direction) good.push('岗位名就是运营方向');
    else if (r.dims.direction >= 20) good.push('职责属于运营方向');
    else if (r.dims.direction >= 10) good.push('沾运营边（岗位名里没有方向词）');

    if (r.hits.length >= 5) good.push('关键词命中 ' + r.hits.length + ' 个（' + r.hits.slice(0, 3).join('/') + ' 等）');
    else if (r.hits.length) good.push('关键词命中 ' + r.hits.join('/'));

    if (r.dims.salary >= WEIGHTS.salary) good.push('薪资起点就达到期望');
    else if (r.dims.salary >= 14) good.push('薪资与期望有重叠');

    if (r.dims.experience >= WEIGHTS.experience && r.dims.experience > 0) good.push('经验要求正好对上');
    if (r.dims.welfare >= 8) good.push('福利扎实');

    r.delta.why.forEach(function (w) {
      if (w.indexOf('-') >= 0) { bad.push(w); return; }
      good.push(w);
    });

    /* --- 负面：方向 / 关键词 / 薪资 的短板 --- */
    if (r.dims.direction < 10) bad.push('看不出是运营方向');
    if (!r.hits.length) bad.push('画像关键词一个都没中');
    if (r.dims.salary < 14) bad.push(r.dims.salary >= 6 ? '薪资上限比期望低一点' : '薪资明显够不着期望');
    if (r.dims.experience <= 3 && r.dims.experience > 0) bad.push('经验要求差得比较多');
    if (r.dims.welfare <= 2) bad.push('福利只看到软福利，没写双休/五险一金');

    /* 降级观望（标黄）也属于"要如实说出来"的硬伤。
       但 degree / salaryLow / years 三条已经在维度分和加减分里说过了 ——
       再说一遍就是同一句话说三次，所以按 code 去重。 */
    r.gate.warn.forEach(function (w) {
      if (w.code === 'degree' || w.code === 'salaryLow') return;
      if (w.code === 'years' && r.dims.experience <= 6) return;
      bad.push(w.text);
    });

    var line = good.length ? good.slice(0, 4).join(' · ') : '没看到明显优势';
    if (bad.length) line += '；⚠ ' + bad.slice(0, 2).join(' · ');
    return line + '。';
  }

  /** 各维度得分 → 短标签（卡片上「标明原因」用，别让人只能点进详情才看得到） */
  function parts(r) {
    return [
      { k: '方向', v: r.dims.direction, max: WEIGHTS.direction },
      { k: '关键词', v: r.dims.keywords, max: WEIGHTS.keywords },
      { k: '薪资', v: r.dims.salary, max: WEIGHTS.salary },
      { k: '经验', v: r.dims.experience, max: WEIGHTS.experience },
      { k: '福利', v: r.dims.welfare, max: WEIGHTS.welfare },
    ].map(function (x) {
      x.full = x.v >= x.max;
      x.zero = x.v === 0;
      x.pct = Math.round(x.v / x.max * 100);
      return x;
    });
  }

  /* ==================== 主入口 ==================== */

  /**
   * 给一个岗位打分。
   * 返回 { total, dims, delta, hits, level, gate, blind, basis, lines }
   * - `blind` = 既没 JD 也没职责 → 分数只能看标题，属"半瞎"，UI 要如实标出来
   * - `basis` = 一行「88 分｜命中 a/b/c｜8-12K 覆盖 9K｜学历不限」
   */
  function score(job, opt) {
    var cfg = (opt && opt.keywords && opt.cities) ? opt : config(opt);
    var g = gate(job, cfg);

    var dr = dirScore(job, cfg);
    var ks = keyScore(job, cfg);
    var ss = salScore(job, cfg);
    var es = expScore(job, cfg);
    var ws = welScore(job);
    var dl = delta(job, cfg);

    var base = dr + ks.score + ss.score + es.score + ws.score;
    var total = Math.max(0, Math.min(100, Math.round(base + dl.value)));

    var jdLen = trim(job.rawJD).length;
    var hasDuty = (job.duties || []).length > 0;
    var blind = jdLen < 40 && !hasDuty;

    var r = {
      total: total,
      base: base,
      dims: { direction: dr, keywords: ks.score, salary: ss.score, experience: es.score, welfare: ws.score },
      delta: dl,
      hits: ks.hits,
      notes: { salary: ss.note, experience: es.note, welfare: ws.note },
      level: levelOf(total),
      gate: g,
      blind: blind,
      reasons: [],
    };
    r.reason = reasonOf(r);
    r.basis = basisLines(r, job, cfg);
    return r;
  }

  function basisLines(r, job, cfg) {
    var salTxt = trim(job.salaryText) || (num(job.salaryMin) !== null ? job.salaryMin + 'K' : '面议');
    return {
      score: r.total + ' 分',
      hits: r.hits.length ? r.hits.join(' / ') : '没命中画像关键词',
      salary: salTxt + '　' + r.notes.salary,
      degree: trim(job.reqDegree) || '学历未写明',
      welfare: r.notes.welfare,
      reason: r.reason,
    };
  }

  /** 一行完整依据（给卡片、导出、复制用） */
  function line(r) {
    var b = r.basis;
    return b.score + '｜命中 ' + b.hits + '｜' + b.salary + '｜' + b.degree + '｜福利 ' + b.welfare;
  }

  /** 批量：算一遍并按合适度排序，返回 [{ job, fit }] */
  function rank(jobs, opt) {
    var cfg = config(opt);
    return (jobs || []).map(function (j) {
      return { job: j, fit: score(j, cfg) };
    }).sort(function (a, b) { return b.fit.total - a.fit.total; });
  }

  /** 分级汇总：{ A:{n,label}, ... , drop:{n} , blind:n } */
  function summary(jobs, opt) {
    var cfg = config(opt);
    var out = { A: 0, B: 0, C: 0, D: 0, drop: 0, blind: 0, total: (jobs || []).length };
    (jobs || []).forEach(function (j) {
      var r = score(j, cfg);
      if (r.gate.drop) { out.drop++; return; }
      out[r.level.key]++;
      if (r.blind) out.blind++;
    });
    return out;
  }

  /** 所有用到的分级（UI 遍历用，避免各处再抄一份） */
  function levels() { return LEVELS.slice(); }

  /* ==================== 「怎么算的」说明弹窗 ==================== */

  function kvRow(k, v) {
    return [el('dt', { text: k }), el('dd', { text: v })];
  }

  /**
   * 把口径、权重、当前关键词全摆出来 —— 分数才不是黑箱。
   * 岗位库、采集页、岗位详情三处共用这一份，别各写一套（写两套必然有一处先过期）。
   */
  function openHelp() {
    var cfg = config();
    var W = WEIGHTS;
    var body = el('div', { class: 'stack', style: 'gap:12px' }, [
      el('div', { class: 'note info' }, [
        el('span', { class: 'ico', text: '🎯' }),
        el('div', { html:
          '这是<b>本地规则</b>打分：不联网、不花 token、结果可复现，还能告诉你「为什么是这个分」。<br>' +
          '<span class="muted fs12">它和「🤖 按简历推荐」的 AI 匹配分是两回事 —— ' +
          '那个负责读 JD 语义（要花 token），这个负责排序和解释。两者在界面上分开显示。</span>' }),
      ]),
      el('div', { class: 'fs12 muted fw6', text: '五维加权（合计 100）' }),
      el('dl', { class: 'kv' }, [].concat(
        kvRow('① 岗位方向 ' + W.direction, '职位名命中方向词 = 满分；只在职责里命中 = 20；只有泛「运营」= 14'),
        kvRow('② 关键词命中 ' + W.keywords, '每命中一个 6 分，5 个封顶'),
        kvRow('③ 薪资匹配 ' + W.salary, '岗位起点 ≥ 你的期望 = 满分；有重叠 = 14；够不着 = 6 或 0；面议按中性 10'),
        kvRow('④ 经验匹配 ' + W.experience, '你的年限落在要求区间 = 满分；不限 = 6；差得越多越低'),
        kvRow('⑤ 福利稳定 ' + W.welfare, '双休 / 五险一金 / 年终奖补贴年假 / 弹性，按命中档位给分；下午茶零食这类软福利不计分；大小周和单休也不算（那是妥协不是福利）；采不到 = 中性 5'),
      )),
      el('div', { class: 'fs12 muted fw6', text: '动态加减分' }),
      el('ul', { class: 'fs12', style: 'margin:0;padding-left:18px' }, [
        el('li', { text: 'HR 今日活跃 +4 / 3 日内 +2 / 长期不活跃 -3' }),
        el('li', { text: '标注「急招」+3 · 行业对口 +3' }),
        el('li', { text: '学历门槛高于你填的 -3 或 -6 · 代招 -3 · 信息残缺（除了岗位名什么都没采到）-3' }),
      ]),
      el('div', { class: 'fs12 muted fw6', text: '硬性过滤（不进打分，直接剔除）' }),
      el('ul', { class: 'fs12', style: 'margin:0;padding-left:18px' }, [
        el('li', { text: '工作地不在目标城市（地点为空的**不剔**，信息不全就砍掉容易让人以为岗位丢了）' }),
        el('li', { text: '岗位名是销售 / 客服 / 行政这类蹭「运营」词、且完全不含方向词' }),
        el('li', { text: 'BOSS 标注「代招」，且你的「不能接受的点」里写了外包 / 派遣' }),
      ]),
      el('div', { class: 'fs12 muted fw6', text: '分级' }),
      el('ul', { class: 'fs12', style: 'margin:0;padding-left:18px' }, LEVELS.map(function (lv) {
        return el('li', { text: lv.key + '（' + lv.min + ' 分以上，' + lv.label + '）：' + lv.advice });
      })),
      el('div', { class: 'fs12 muted fw6', text: '卡片上那行「为什么」' }),
      el('ul', { class: 'fs12', style: 'margin:0;padding-left:18px' }, [
        el('li', { text: '正面：岗位名就是运营方向 / 职责对口 / 关键词命中几个 / 薪资覆盖期望 / 经验正好 / 福利扎实 / HR 活跃 / 急招 / 行业对口' }),
        el('li', { text: '反面：看不出运营方向 / 关键词没中 / 薪资够不着 / 经验差得多 / 福利只有软福利 / 学历门槛 / 代招 / 已失效' }),
        el('li', { text: '正反面都写 —— 只说好话的原因行，会让人把 C 级看成 A 级' }),
      ]),
      el('div', { class: 'divider' }),
      el('div', { class: 'fs12 muted fw6', text: '当前用的关键词（' + cfg.keywords.length + ' 个）' }),
      el('div', { class: 'chips' }, cfg.keywords.slice(0, 40).map(function (w) {
        return el('span', { class: 'tag info', text: w });
      })),
      el('div', { class: 'fs11 muted', html: cfg.usingDefaultKeywords
        ? '⚠️ 这用的是<b>内置画像词</b>（你没填「求职方向关键词」）。到「岗位库 → ⚙ 我的求职偏好」填上你自己的，分数会更准。'
        : '来源：求职方向关键词 ' + cfg.keywordsFrom.focus + ' 个 · 期望岗位 ' + cfg.keywordsFrom.expectJobs +
          ' 个 · 简历标签 ' + cfg.keywordsFrom.resumeTags + ' 个。可到「岗位库 → ⚙ 我的求职偏好」改。' }),
      el('div', { class: 'row', style: 'gap:8px' }, [
        el('button', { class: 'btn sm', text: '去岗位库改关键词',
          onclick: function () {
            U.closeAllModals();
            App.go('jobs');
            if (global.Views && global.Views.jobs && global.Views.jobs.openPrefs) global.Views.jobs.openPrefs();
          } }),
      ]),
    ]);
    U.openModal({
      title: '🎯 合适度是怎么算出来的',
      size: 'wide', body: body,
      footer: [{ text: '知道了', cls: 'pri', onClick: function (c) { c(); } }],
    });
  }

  global.JobScorer = {
    // 口径
    config: config, WEIGHTS: WEIGHTS, LEVELS: LEVELS,
    DEFAULT_FOCUS: DEFAULT_FOCUS, DEFAULT_DIRECTIONS: DEFAULT_DIRECTIONS,
    DEFAULT_INDUSTRIES: DEFAULT_INDUSTRIES, OFF_DIRECTION: OFF_DIRECTION,
    REST_KINDS: REST_KINDS,
    // 分步（测试要能单独验每一维）
    gate: gate, degRank: degRank,
    dirScore: dirScore, keyScore: keyScore, salScore: salScore,
    expScore: expScore, welScore: welScore, delta: delta,
    levelOf: levelOf, reasonOf: reasonOf, parts: parts,
    // 福利拆解 / 公司规模（「岗位对比」也用这一份，避免两处口径各写一套）
    welfareOf: welfareOf, welfareText: welfareText, welfareItems: welfareItems,
    restOf: restOf, insuranceOf: insuranceOf,
    scaleRank: scaleRank, scaleLabel: scaleLabel,
    // 主入口
    score: score, line: line, basisLines: basisLines,
    rank: rank, summary: summary, levels: levels,
    openHelp: openHelp,
    uniq: uniq,
  };
})(window);
