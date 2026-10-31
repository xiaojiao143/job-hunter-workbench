/* ==========================================================================
   company-check.js · 公司背调（能力模块，挂在「公司背调」页 + 岗位卡片上）
   --------------------------------------------------------------------------
   目的：在**投出沟通次数之前**把公司查一遍，先排掉坑
        （皮包公司、欠薪、劳动纠纷多、被执行/失信、实缴为 0）。

   ⚠️ 两条路线，本模块只负责第一条 + 第二条的"存/算"部分：

     ① **路线 A：一键跳转（本模块的核心）**
        岗位库 / 背调页点公司名 → 打开 天眼查 / 爱企查 的搜索页，人工看一眼。
        0 成本、0 开发、信息全。缺点是人肉看、不结构化。

     ② **路线 B：开放平台 API（自动汇总）**
        需要自己在 open.tianyancha.com / openapi.qcc.com 申请 Key。
        ⛔ 本模块**不内置 Key、不代申请、不伪造数据**。
        拿不到 API 时的替代是「人工录入」：把在网上看到的那几项填进来，
        分级 / 组合预警的算法照跑 —— 价值一样，只是录入是你动手。

   ⛔ 一条硬边界（和「拿不到就说没有」同一条）：
      **没有数据就是没有数据**。工商/风险字段全空时分级返回 'unknown'（未评定），
      绝不默认判成"绿灯"。把"没查"显示成"没问题"是最危险的一种错。

   ⛔ 数据说明（§5）：
      第三方平台数据仅供参考、**不构成法律意见**；API 有更新延迟；
      签约 / 入职等重大决策前以国家企业信用信息公示系统（gsxt.gov.cn）为准。
   ========================================================================== */
(function (global) {
  'use strict';

  function trim(s) { return String(s === null || s === undefined ? '' : s).trim(); }
  function num(v) {
    var n = typeof v === 'number' ? v : parseFloat(String(v === null || v === undefined ? '' : v));
    return isNaN(n) ? 0 : n;
  }
  /** 是不是"填过"（null / '' / undefined 都算没填，0 算填过 —— 实缴 0 是有意义的信号） */
  function has(v) { return v !== null && v !== undefined && v !== ''; }

  /* ==================== 一、路线 A：一键跳转 ==================== */

  /**
   * 三个目标站。按「先免费全的、再官方权威的」排。
   * ⛔ gsxt 不支持把公司名拼进 URL（它是 POST 检索），所以只能复制名字 + 打开首页。
   *    这一点必须如实写在 note 里 —— 假装能深链、用户点进去看到空白搜索框会觉得工具坏了。
   */
  var SITES = [
    {
      k: 'tianyancha', name: '天眼查', ico: '🔎', primary: true,
      url: function (c) { return 'https://www.tianyancha.com/search?key=' + encodeURIComponent(c); },
      note: '信息最全（工商 + 司法 + 经营 + 股权），网页免费；部分详情要登录。',
    },
    {
      k: 'aiqicha', name: '爱企查', ico: '🅱️', primary: true,
      url: function (c) { return 'https://aiqicha.baidu.com/s?q=' + encodeURIComponent(c); },
      note: '百度旗下，基础工商信息免费、一般不用登录。',
    },
    {
      k: 'gsxt', name: '国家企业信用信息公示系统', ico: '🏛️', manual: true,
      url: function () { return 'https://www.gsxt.gov.cn/index.html'; },
      note: '官方、免费、权威。它不支持"带公司名"的链接，所以这里会顺手把公司名复制好，进去粘贴即可。' +
        '签约 / 入职等重大决策以它为准。',
    },
  ];

  function site(k) { return SITES.filter(function (s) { return s.k === k; })[0] || null; }

  /**
   * 打开某个站的搜索页。
   * @returns {ok, site} —— 站点不存在时 ok=false，调用方要给出提示（不要静默无反应）。
   */
  function openSite(k, company) {
    var s = site(k), c = trim(company);
    if (!s) return { ok: false, reason: 'unknown-site' };
    if (!c) return { ok: false, reason: 'no-company' };
    var url = s.url(c);
    // gsxt 只能深链到首页 → 先把公司名复制到剪贴板，用户进去直接粘
    if (s.manual) { try { U.copyText(c); } catch (e) { /* 复制失败也不影响打开 */ } }
    try {
      var w = global.open(url, '_blank', 'noopener');
      if (w) w.opener = null;
    } catch (e) {
      return { ok: false, reason: 'blocked', url: url };
    }
    return { ok: true, site: s, url: url };
  }

  /** 一次开两个（天眼查 + 爱企查）—— 两边信息互补，顺手对一眼 */
  function openBoth(company) {
    var c = trim(company);
    if (!c) return false;
    ['tianyancha', 'aiqicha'].forEach(function (k) { openSite(k, c); });
    return true;
  }

  /* ==================== 二、公司名归并 ==================== */

  /**
   * 归一化公司名（只做「去噪」，不做「推断」）：
   *   ① 去掉「（杭州）」这类括号里的地名注释 —— 那是 BOSS 列表上的显示习惯，不是公司名的一部分
   *   ② 去掉空白 / 分隔符
   *
   * ⛔ 刻意**不**做「去掉『有限公司』后缀再合并」：
   *    「杭州云栖数字科技有限公司」和「杭州云栖数字科技」看起来是一家，
   *    但「…科技有限公司」和「…科技发展有限公司」是两家完全不同的主体。
   *    猜错会把你**两家公司的背调结果合成一份** —— 这比多建一条档案危险得多。
   *    宁可多几条、让你自己合并，也不要静默合并错。
   */
  function normName(s) {
    return trim(s)
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s\u3000·・]+/g, '')
      .trim();
  }
  function companyKey(s) { return normName(s).toLowerCase(); }

  /** 展示用短名（卡片上太长会挤）—— 直接复用 U.shortCompany */
  function shortName(s) { return global.U ? U.shortCompany(s) : trim(s); }

  /**
   * 从岗位列表里归并出公司清单（背调页的主列表）。
   * @param jobs 岗位数组
   * @param checks 已有的背调档案数组（用来标「已录 / 未录」）
   */
  function companiesFromJobs(jobs, checks) {
    var byKey = {}, out = [];
    (jobs || []).forEach(function (j) {
      var name = trim(j && j.company);
      if (!name) return;
      var k = companyKey(name);
      if (!k) return;
      if (!byKey[k]) {
        byKey[k] = {
          key: k, company: name, names: [], jobs: [], jobIds: [],
          industries: [], titles: [], cities: [],
        };
        out.push(byKey[k]);
      }
      var g = byKey[k];
      if (g.names.indexOf(name) < 0) g.names.push(name);
      g.jobs.push(j);
      if (j.id && g.jobIds.indexOf(j.id) < 0) g.jobIds.push(j.id);
      if (j.industry && g.industries.indexOf(j.industry) < 0) g.industries.push(j.industry);
      if (j.title && g.titles.indexOf(j.title) < 0) g.titles.push(j.title);
      if (j.location && g.cities.indexOf(j.location) < 0) g.cities.push(j.location);
    });

    var byCheck = {};
    (checks || []).forEach(function (c) { if (c.key) byCheck[c.key] = c; });

    out.forEach(function (g) {
      g.count = g.jobs.length;
      g.check = byCheck[g.key] || null;
      g.names.forEach(function (n) {
        var hit = byCheck[companyKey(n)];
        if (hit) g.check = hit;
      });
      g.hasCheck = !!(g.check && (g.check.queriedAt || hasData(g.check)));
    });

    // 排序：岗位多的优先（一个岗位的公司不值得先花时间背调），再看有没有已录
    return out.sort(function (a, b) {
      if (a.hasCheck !== b.hasCheck) return a.hasCheck ? 1 : -1;
      return b.count - a.count;
    });
  }

  /* ==================== 三、工商摘要 ==================== */

  var RISK_ITEMS = [
    { k: 'zhixing', label: '被执行人', ico: '⚖️', hint: '有被执行记录 —— 判了没还钱' },
    { k: 'shixin', label: '失信被执行', ico: '🚫', hint: '俗称「老赖」名单，最重的一个信号' },
    { k: 'court', label: '开庭公告', ico: '📅', hint: '有案子在审（含劳动争议）' },
    { k: 'abnormal', label: '经营异常', ico: '⚠️', hint: '未年报 / 失联 / 地址异常' },
    { k: 'penalty', label: '行政处罚', ico: '📋', hint: '被市场监管等部门处罚过' },
    { k: 'labor', label: '劳动纠纷', ico: '👥', hint: '劳动争议案件数量 —— 求职最该看的一项' },
  ];

  /** 工商经营状态里出现这些词 → 直接红灯（公司都不在了，别的不用看） */
  var DEAD_RE = /注销|吊销|清算|停业|撤销|迁出/;

  /** 成立至今多少年（小数）。没有成立时间返回 null —— ⛔ 不是 0，0 会被拿去做「不足 1 年」的判断 */
  function ageYears(establishedAt, at) {
    if (!has(establishedAt)) return null;
    var t0 = typeof establishedAt === 'number' ? establishedAt : Date.parse(establishedAt);
    if (isNaN(t0) || t0 <= 0) return null;
    var days = ((at || (global.U ? U.now() : Date.now())) - t0) / 86400000;
    if (days < 0) return null;      // 成立时间填成了未来 → 当没填
    return days / 365.25;
  }

  /** 一条档案里有没有任何"查过"的痕迹 */
  function hasData(rec) {
    if (!rec) return false;
    var reg = rec.reg || {}, r = rec.risk || {};
    if (has(reg.establishedAt) || has(reg.capital) || has(reg.paidIn) || trim(reg.status) || trim(reg.creditCode)) return true;
    return RISK_ITEMS.some(function (it) { return num(r[it.k]) > 0; });
  }

  /**
   * 背调分级（§4）。
   *
   * ⚠️ 三处**刻意的取舍**，都写在注释里免得以后被"优化"掉：
   *   1. **没数据 → 'unknown'（未评定），不是绿灯。** 把"没查"显示成"没问题"是最危险的错。
   *   2. **经营状态为注销/吊销 → 直接红灯**，不再看别的。公司都不在了，
   *      讨论"劳动纠纷多不多"没有意义。
   *   3. **经营异常 ≥3 条 → 红灯。** 文档只写了「少量经营异常 → 黄灯」，
   *      没说多量怎么办。「多次被列入经营异常」已经不是"人工确认一下"能解决的，
   *      所以按红灯处理 —— 这是对文档的**外推**，明写在这里。
   *
   * @returns {level:'red'|'yellow'|'green'|'unknown', reasons:[html], label, ico, cls}
   */
  function verdict(rec, at) {
    var reg = (rec && rec.reg) || {}, r = (rec && rec.risk) || {};

    var st = trim(reg.status);
    if (st && DEAD_RE.test(st)) {
      return mk('red', ['工商经营状态：<b>' + esc(st) + '</b> —— 公司主体已经不在正常经营状态']);
    }

    var red = [];
    if (num(r.shixin) > 0) red.push('有<b>失信被执行</b>记录 ' + num(r.shixin) + ' 条');
    else if (num(r.zhixing) > 0) red.push('有<b>被执行人</b>记录 ' + num(r.zhixing) + ' 条');
    if (num(r.penalty) >= 3) red.push('行政处罚 <b>' + num(r.penalty) + '</b> 次 —— 频繁');
    if (num(r.labor) >= 3) red.push('劳动争议 <b>' + num(r.labor) + '</b> 起 —— 大量');
    if (num(r.abnormal) >= 3) red.push('经营异常 <b>' + num(r.abnormal) + '</b> 条 —— 多次被列入');
    if (red.length) return mk('red', red);

    var years = ageYears(reg.establishedAt, at);
    var yellow = [];
    if (years !== null && years < 1) yellow.push('成立不足 <b>1</b> 年');
    else if (years !== null && years < 2) yellow.push('成立不到 <b>2</b> 年（' + years.toFixed(1) + ' 年）');
    if (has(reg.paidIn) && num(reg.paidIn) === 0 && num(reg.capital) > 0) {
      yellow.push('实缴资本为 <b>0</b>（认缴 ' + fmtMoney(reg.capital) + '）');
    }
    if (num(r.abnormal) > 0 && num(r.abnormal) < 3) yellow.push('经营异常 ' + num(r.abnormal) + ' 条');
    /* ⛔ 开庭公告只要有，就必须在黄灯里体现（评审核实 2026-10-30，P0）。
       以前写成 `num(r.court) > 0 && num(r.labor) === 0` —— 一旦劳动纠纷 > 0，
       开庭公告这条就被吞掉，而绿灯分支又只看 labor<3 不看 court，
       于是 `court=3, labor=1` 这种「有 3 条开庭公告 + 劳动纠纷」的公司被判成绿灯。
       有信号就不能算干净：任何非 0 的 court 都要进黄灯理由。 */
    if (num(r.court) > 0) yellow.push('有开庭公告 ' + num(r.court) + ' 条（案由自己看一眼）');
    if (yellow.length) return mk('yellow', yellow);

    // ⛔ 绿灯的前提是**风险项真的查过**（评审核实 2026-10-12，P1-2）。
    //   `num(null)` 也是 0 —— 只写 `=== 0` 的话，「没查」会被当成「查了没问题」：
    //   一份只填了成立日期 2 年的档案就会亮绿灯。所以要求 6 项风险**每一项都有值**，
    //   0 也算有值（0 = 查过且为 0），null 才算「没查」。
    var riskKnown = RISK_ITEMS.every(function (it) { return has(r[it.k]); });
    if (years !== null && years >= 2 && riskKnown &&
        num(r.shixin) === 0 && num(r.zhixing) === 0 && num(r.labor) < 3 &&
        /* 与黄灯同一口径：开庭公告、行政处罚、经营异常只要非 0，就不能亮绿灯 */
        num(r.court) === 0 && num(r.penalty) === 0 && num(r.abnormal) === 0) {
      return mk('green', ['成立 <b>' + years.toFixed(1) + '</b> 年 · 无被执行 / 失信 · 劳动纠纷少']);
    }

    // 成立时间够了、但风险项没查全 → 明说「别拿没查当没问题」，不给绿灯
    if (years !== null && years >= 2 && !riskKnown) {
      var miss = RISK_ITEMS.filter(function (it) { return !has(r[it.k]); })
        .map(function (it) { return it.label; }).slice(0, 3).join(' / ');
      return mk('unknown', ['工商照面够了，但风险项还没查全（' + miss + ' 等）—— ' +
        '补齐再判，别把「没查」当成「没问题」']);
    }

    return mk('unknown', hasData(rec)
      ? ['数据不全（缺成立时间 / 实缴）—— 先把工商照面补齐再判']
      : ['还没查过这家 —— 点上面的按钮去查，或手工录入结果']);
  }

  function mk(level, reasons) {
    var META = {
      red:     { label: '红灯', ico: '🔴', cls: 'bad',  advice: '建议放弃，或极度谨慎' },
      yellow:  { label: '黄灯', ico: '🟡', cls: 'warn', advice: '人工确认后再投' },
      green:   { label: '绿灯', ico: '🟢', cls: 'ok',   advice: '可正常跟进' },
      unknown: { label: '未评定', ico: '⚪', cls: '',   advice: '还没查 / 数据不全' },
    };
    var m = META[level] || META.unknown;
    return { level: level, reasons: reasons, label: m.label, ico: m.ico, cls: m.cls, advice: m.advice };
  }

  /* ==================== 四、组合预警（§4 最后一条） ==================== */

  /**
   * 招聘话术里的高危词。
   * ⚠️ 判**全文子串**，不做语义 —— 它只是组合预警的一个配料，
   *    单命中不构成任何结论（很多正常销售岗也这么写）。
   */
  var TALK_RE = /底薪加提成|底薪\+提成|无责底薪|高提成|提成上不封顶|上不封顶|多劳多得|看业绩|纯提成/;

  function suspiciousTalk(text) { return TALK_RE.test(String(text || '')); }

  /**
   * 组合预测警：实缴 0 + 成立不足 1 年 + 「底薪加提成」话术 + 大量仲裁。
   *
   * ⚠️ 文档写的是「任一命中即慎入」，这里**故意收紧成「命中 ≥3 项才算组合预警」**：
   *    实缴为 0 在初创公司里极其常见（认缴制下很多正常公司也这样），
   *    单凭它一条就喊"慎入"，等于把所有创业公司都劝退 —— 用户会很快学会无视这个提示，
   *    那真正危险的组合也一起被无视了。命中 1~2 项照样列出来，只是不喊"慎入"。
   *
   * @param texts 招聘话术的来源文本（岗位名 + JD + 标签…），数组或字符串
   */
  function comboRisk(rec, texts) {
    var reg = (rec && rec.reg) || {}, r = (rec && rec.risk) || {};
    var all = Array.isArray(texts) ? texts.filter(Boolean).join('\n') : String(texts || '');
    var hits = [];
    var years = ageYears(reg.establishedAt);

    if (has(reg.paidIn) && num(reg.paidIn) === 0) hits.push('实缴资本为 0');
    if (years !== null && years < 1) hits.push('成立不足 1 年');
    if (suspiciousTalk(all)) {
      var w = all.match(TALK_RE);
      hits.push('招聘话术里有「' + trim(w && w[0]) + '」这类高提成表述');
    }
    if (num(r.labor) >= 3) hits.push('劳动争议 ' + num(r.labor) + ' 起（大量）');

    return { n: hits.length, hits: hits, danger: hits.length >= 3 };
  }

  /* ==================== 五、展示小工具 ==================== */

  function fmtMoney(v) {
    if (!has(v)) return '';
    var n = num(v);
    // 万以下带小数、万以上取整 —— 「0.5 万」是真的有人填
    return (n >= 10000 ? (n / 10000) + ' 亿' : n + ' 万');
  }

  /** 工商摘要一行（卡片 / 列表上用） */
  function regLine(rec, at) {
    var reg = (rec && rec.reg) || {};
    var parts = [];
    var years = ageYears(reg.establishedAt, at);
    if (years !== null) parts.push('成立 ' + (years >= 1 ? years.toFixed(1) + ' 年' : '<1 年'));
    if (trim(reg.establishedAt)) parts.push(U.d2(reg.establishedAt));
    if (has(reg.capital)) parts.push('注册资本 ' + fmtMoney(reg.capital));
    if (has(reg.paidIn)) parts.push('实缴 ' + (num(reg.paidIn) === 0 ? '0' : fmtMoney(reg.paidIn)));
    if (trim(reg.status)) parts.push(trim(reg.status));
    return parts.join(' · ');
  }

  /** 风险计数一行 */
  function riskLine(rec) {
    var r = (rec && rec.risk) || {};
    var parts = [];
    RISK_ITEMS.forEach(function (it) { if (num(r[it.k]) > 0) parts.push(it.label + ' ' + num(r[it.k])); });
    if (parts.length) return parts.join(' · ');
    // ⛔ 「一项都没填」不能说成「都是 0」—— 那是「查了没问题」的口径（评审核实 P1-2）。
    var known = RISK_ITEMS.every(function (it) { return has(r[it.k]); });
    return known ? '风险项都是 0' : '风险项还没查（或没查全）';
  }

  /** 「该查什么」清单 —— 30 秒内看到要重点看哪几项（对应里程碑 B3 的验收） */
  function checklist(rec, job) {
    var out = [];
    var reg = (rec && rec.reg) || {}, r = (rec && rec.risk) || {};
    var texts = job ? [job.title, job.rawJD, (job.tags || []).join(' ')].join('\n') : '';

    out.push({ k: 'established', label: '成立时间 / 注册资本 / 实缴',
      got: has(reg.establishedAt) || has(reg.capital) || has(reg.paidIn),
      why: '实缴为 0 + 成立不足 1 年 → 公司很可能没有实际资金实力' });
    out.push({ k: 'zhixing', label: '被执行 / 失信',
      // ⛔ 返回**布尔**（评审 P1-2 修）：以前是 `num>0 || trim(status)`，后者是个字符串。
      //    口径同时改成「有值就算查过」（has）：填了 0 = 查过且为 0，不该再列进「还没查」。
      got: has(r.zhixing) || has(r.shixin) || trim(reg.status) !== '',
      why: '有的话基本可以先放一边 —— 判决都不执行的，工资也悬' });
    out.push({ k: 'labor', label: '劳动争议（仲裁 / 诉讼）',
      got: has(r.labor) || has(r.court),
      why: '数量多 = 这家公司长期在跟员工打官司' });
    out.push({ k: 'abnormal', label: '经营异常 / 行政处罚',
      got: has(r.abnormal) || has(r.penalty),
      why: '未年报 / 地址失联 / 被处罚，都是管理不规范的硬证据' });
    if (texts && suspiciousTalk(texts)) {
      out.push({ k: 'talk', label: '招聘话术里的高提成表述',
        got: true, why: '「底薪加提成 / 上不封顶」常和低底薪、强淘汰配套' });
    }
    return out;
  }

  function esc(s) { return String(s === null || s === undefined ? '' : s).replace(/[&<>"]/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
  }); }

  /* ==================== 六、档案归并（同一家公司的多个写法） ==================== */

  /** 把一条"待录入"的默认值造出来（新档案） */
  function blankCheck(company) {
    return {
      company: trim(company),
      reg: { name: trim(company), creditCode: '', establishedAt: null, capital: null, paidIn: null,
        status: '', industry: '', address: '' },
      // ⛔ 全 null = 「还没查」，不是「查了都是 0」（与 store.normCheck 同口径）。
      //   以前这里写 0，于是「一份空档案 + 只填成立日期」就会算出绿灯（评审核实 P1-2）。
      risk: { zhixing: null, shixin: null, court: null, abnormal: null, penalty: null, labor: null },
      talk: '',        // 招聘话术原文（可选，用于组合预警）
      note: '',        // 人工备注
      source: 'manual',
    };
  }

  global.CompanyCheck = {
    SITES: SITES, site: site, openSite: openSite, openBoth: openBoth,
    normName: normName, companyKey: companyKey, shortName: shortName,
    companiesFromJobs: companiesFromJobs,
    RISK_ITEMS: RISK_ITEMS, TALK_RE: TALK_RE,
    ageYears: ageYears, hasData: hasData, verdict: verdict,
    suspiciousTalk: suspiciousTalk, comboRisk: comboRisk,
    fmtMoney: fmtMoney, regLine: regLine, riskLine: riskLine, checklist: checklist,
    blankCheck: blankCheck,
  };
})(window);
