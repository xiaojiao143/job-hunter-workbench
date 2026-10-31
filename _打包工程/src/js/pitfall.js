/* ==========================================================================
   pitfall.js · 找工作避坑雷达（本地规则引擎）
   --------------------------------------------------------------------------
   定位：**事实提示，不是结论**。它只做三件事 ——
     ① 从 JD 原文和已知字段里挑出「值得多问一句」的信号
     ② 每条都**回引原文**（你没发验证、也没法反驳的东西不许出现）
     ③ 给出「建议怎么问 HR」

   ⛔ 它不判「这是骗局」。规则一定会误报，措辞必须留余地 ——
      写「可能是…，建议问清楚」，不写「这是坑」。

   ⛔⛔ **绝对不能用 `indexOf` 直接判命中** —— 本模块最贵的一条教训：
      某条 JD 结尾写着「公司直招，**非外包**」，而朴素的 `'外包' in jd`
      命中了「非外包」这三个字 → 把一家**自称不是外包**的公司标成「外包嫌疑」，
      完全判反。中文否定在 JD 里极常见（非外包 / 不接受居家办公 / 无需经验 /
      拒绝中介），纯关键词匹配上量后误报会非常多。
      ⇒ 所有命中都必须过 `hits()`：**命中词 + 前文窗口 + 否定词表**。

   规则分四组（全部纯本地，不联网、不调模型）：
     ① 法定红线（🔴）—— 《劳动合同法》第 9 条明文禁止的事
     ② 用工主体（🟡）—— 你签的到底是不是这家公司
     ③ 话术红旗（🟡）—— **组合触发**，单个词不报警
     ④ 信息不足（⚪）—— 没材料就明说「未扫描」，**绝不默认绿灯**
   ========================================================================== */
(function (global) {
  'use strict';

  /* 与项目其他文件同一写法（本文件在 components.js 之后加载）。 */
  var el = Comp.el;

  /* ==================== 可调口径 ==================== */

  var config = {
    /* 「代招」判几级。默认黄灯 —— **代招不违法**，只是「你签的不是这家公司」，
       该提醒但不该吓人。想改成红灯把这里改成 'red' 即可（全项目只此一处）。 */
    proxyHireLevel: 'yellow',

    /* 否定语境往回看几个字。已废弃：改为整句判定（见 negatedInSentence）。
       保留字段只为兼容旧引用，实际不再使用。 */
    negSpan: 4,

    /* 回引原文时，命中的那句话最多显示多少字 */
    snippetMax: 46,
  };

  var LEVELS = {
    red: { label: '有红线', ico: '🔴', cls: 'bad', tip: '法定禁止事项，建议直接放弃或先问清楚' },
    yellow: { label: '需注意', ico: '🟡', cls: 'warn', tip: '不是违法，但值得问清楚再决定' },
    green: { label: '未发现问题', ico: '🟢', cls: 'ok', tip: '已扫过 JD 和已知字段，没触发任何规则' },
    unknown: { label: '未扫描', ico: '⚪', cls: '', tip: '没有 JD 原文可扫 —— 未扫描 ≠ 没问题' },
  };

  /* ==================== 词表 ==================== */

  /** 否定词（只认**紧挨着命中词前面**的那几个字，所以「非常轻松」不会误判成否定） */
  var NEG = ['非', '不', '无', '免', '零', '没有', '无需', '不是', '拒绝', '禁止', '杜绝', '杜绝'];

  /**
   * 候选人自己掏钱的动词。
   * ⛔ 这里**绝不能放「缴纳」** —— 实测踩过：
   *    「试用期**缴纳**五险一金　完善的新人**培训**及运营指导」
   *    两个词挨得近，于是把一条正常的 JD 判成了「招聘收费」红灯。
   *    而「缴纳五险一金」明明是**公司给你缴**，是好事。
   *    ⇒ 只留明确指向"候选人付"的动词。
   */
  var PAY_SELF = ['自理', '自付', '自行承担', '自费', '自己出', '自己承担', '垫付'];
  /** 光杆词要离付款动词多近才算（实测 18 字太宽、会跨句子误伤，收到 6 字） */
  var PAY_SPAN = 6;

  /* ① 法定红线 —— 《劳动合同法》第 9 条：不得扣押证件、不得收取财物
     ⛔ 强词表**必须是带「费/金/押」的明确收费词**。
        光杆的「培训」「体检」「服装」在正经 JD 里天天出现
        （"完善的新人培训""入职体检""统一服装"），单独判红灯必误报。 */
  var FEE_STRONG = ['押金', '保证金', '入职费', '建档费', '服装费', '培训费', '资料费',
    '设备押金', '工牌费', '体检费', '报名费', '手续费', '考证费', '风险金', '加盟费',
    '押证件', '扣留身份证', '提供担保'];
  /** 光杆词：**必须紧邻**「候选人掏钱」动词才算（如「体检自理」「培训费自付」） */
  var FEE_WEAK = ['体检', '服装', '工牌', '培训', '考证'];

  var BUY_FIRST = ['先购买', '自费采购', '指定供应商', '先垫付', '自己买设备', '统一采购'];
  var SECRET = ['银行卡正反面', '手持身份证', '短信验证码', '提供验证码', '银行卡密码',
    '支付密码', '身份证正反面', '人脸识别'];
  var PRIV_PAY = ['个人微信收款', '转账给', '指定老师', '内部渠道', 'usdt', '虚拟币', '扫码付款'];

  /* ② 用工主体 */
  var OUTSRC = ['派驻', '驻场', '甲方现场', '项目制', '人力外包', '劳务派遣', '外包', '代招', '中介'];

  /* ③ 话术红旗（组合用） */
  var HYPE_SALARY = ['上不封顶', '多劳多得', '月入过万', '日结', '综合收入', '高提成', '收入无上限'];
  var BASE_SALARY = ['底薪', '无责底薪', '基本工资', '固定薪资'];
  var URGENT = ['急招', '当天入职', '名额有限', '立即上岗', '马上到岗', '即刻上岗', '速来'];
  var TOO_GOOD = ['轻松', '简单上手', '无需经验', '接受小白', '无经验可', '门槛低', '不限经验', '小白可'];
  var HIGH_MONEY = ['月入', '过万', '高薪', '万元', '上万'];

  /* 「挂羊头」：标题像职能岗，正文全是销售动作 */
  var TITLE_SOFT = ['运营', '文员', '助理', '行政', '客服', '内勤', '数据'];
  var BODY_SALES = ['销售', '地推', '拓客', '电销', '陌拜', '客户开发', '拉新', '业绩', '提成'];

  /* ==================== 文本工具 ==================== */

  function txt(v) {
    if (!v) return '';
    if (Array.isArray(v)) return v.filter(Boolean).join(' ');
    if (typeof v === 'object') {
      return Object.keys(v).map(function (k) { return v[k]; }).filter(function (x) {
        return typeof x === 'string';
      }).join(' ');
    }
    return String(v);
  }

  /** 命中词前面紧挨着的那几字里有没有否定词（旧实现，保留给简单两字紧贴场景兜底） */
  function negated(before) {
    for (var i = 0; i < NEG.length; i++) {
      if (before.length >= NEG[i].length && before.slice(-NEG[i].length) === NEG[i]) return true;
    }
    // 「不」开头的双字否定：不接受 / 不需要 / 不用 —— 看最后一个字是不是「不」
    return /[不非无免]$/.test(before);
  }

  /* ⛔ 否定判定只看「命中词前 4 字 + 前缀恰好等于否定词」，中文里几乎永远失效
     （评审核实 2026-10-30，A-01）。实测「无需缴纳押金」「不收取任何押金」
     「不得以任何名义收取押金」「押金、培训费一律不收」全被判红灯 ——
     只要否定词与命中词之间隔了一个动词/宾语就接不住。
     正解：在**命中词所在的整句话**里，看「否定词 + 0~N 个非标点字符 + 命中词」
     这个正向模式是否出现；出现就说明这句是在**声明不收**，不算命中。
     分句用 。；！？\n，避免跨句误伤（「没问题。押金照收」不能算否定）。 */
  var NEG_WORD_RE = /不|非|无|免|没有|无需|不是|并非|拒绝|禁止|杜绝|不得|不予|不要|不需|不需/;

  function negatedInSentence(text, hitAt, hitWord) {
    // 取命中词所在的整句（到最近标点为止）
    var s = text.lastIndexOf('\n', hitAt);
    var sentStart = 0;
    var punct = /[。；！？!?；;，,\n]/g;
    var m;
    while ((m = punct.exec(text)) !== null) {
      if (m.index >= hitAt) break;
      sentStart = m.index + 1;
    }
    var sentEnd = text.length;
    punct.lastIndex = 0;
    while ((m = punct.exec(text)) !== null) {
      if (m.index > hitAt) { sentEnd = m.index; break; }
    }
    var sentence = text.slice(sentStart, sentEnd);
    var before = sentence.slice(0, hitAt - sentStart);

    // ① 否定词直接/近距离出现在命中词前（中间只隔非标点字符）
    //    ⚠️ 「不得以任何名义收取押金」：否定词「不得」与命中词「押金」之间隔着
    //       「以任何名义收取」共 6 字 + 语义动词。把「否定词 + 动词 + 名词」这类
    //       长跨距也覆盖进来：否定词后可跟 0~8 个非标点字符（覆盖「以任何名义收取」）。
    if (/(?:不|非|无|免|未|没有|无需|不是|并非|拒绝|禁止|杜绝|不得|不予|不要)[^。；！？!?，,\n]{0,8}$/.test(before)) {
      return true;
    }
    // ② 否定写在命中词**之后**（「押金、培训费一律不收」）—— 看整句在命中词后有没有「一律不收 / 不收 / 免收」这类收尾
    var after = sentence.slice(hitAt - sentStart + hitWord.length);
    if (/(?:一律|均|概|全部|都)?\s*(?:不收|不收取|免收|免|免费|无需缴|无需缴纳|不予收取|拒绝收取)/.test(after)) {
      return true;
    }
    return false;
  }

  /** 命中词所在的整句话（回引原文用），太长就围绕命中词截 */
  function lineAt(text, at) {
    var s = text.lastIndexOf('\n', at);
    s = s < 0 ? 0 : s + 1;
    var e = text.indexOf('\n', at);
    if (e < 0) e = text.length;
    var line = text.slice(s, e).replace(/\s+/g, ' ').trim();
    if (!line) line = text.slice(Math.max(0, at - 14), at + 20).trim();
    if (line.length > config.snippetMax) {
      var k = line.indexOf(text.substr(at, 2));
      var from = k > 12 ? k - 12 : 0;
      line = (from ? '…' : '') + line.slice(from, from + config.snippetMax) + '…';
    }
    return line;
  }

  /**
   * 在文本里找词表里的任何词，**过否定语境**。返回 [{w, snippet}]。
   * ⛔ 不用 indexOf 直接判命中 —— 见文件头那条教训。
   * expectPay=true 时光杆弱词还必须**紧邻**「候选人掏钱」动词（PAY_SPAN 字内）。
   */
  function hits(text, words, expectPay) {
    var out = [], seen = {};
    if (!text) return out;
    for (var wi = 0; wi < words.length; wi++) {
      var w = words[wi], i = 0;
      while (true) {
        var k = text.indexOf(w, i);
        if (k < 0) break;
        i = k + w.length;
        // ⛔ 否定语境：优先用整句判定（能覆盖「无需缴纳押金」「押金一律不收」），
        //    旧的前缀窗口只作兜底。
        if (negatedInSentence(text, k, w) || negated(text.slice(Math.max(0, k - config.negSpan), k))) continue;
        if (expectPay) {
          var near = text.slice(Math.max(0, k - PAY_SPAN), k + w.length + PAY_SPAN);
          var pay = false;
          for (var pi = 0; pi < PAY_SELF.length; pi++) {
            if (near.indexOf(PAY_SELF[pi]) >= 0) { pay = true; break; }
          }
          if (!pay) continue;
        }
        if (seen[w]) break;
        seen[w] = 1;
        out.push({ w: w, snippet: lineAt(text, k) });
        break;
      }
    }
    return out;
  }

  function anyHit(text, words) { return hits(text, words, false).length > 0; }

  function words(list) { return list.join('、'); }

  /* ==================== 规则 ==================== */

  /**
   * 扫一条岗位。返回 { level, items, scanned, counts }。
   * items: [{ id, level, title, evidence, why, ask }]
   */
  function verdict(job) {
    job = job || {};
    var jd = txt(job.rawJD) + ' ' + txt(job.duties) + ' ' + txt(job.requirements);
    var title = txt(job.title);
    var scanned = !!jd.trim();

    var items = [];
    function add(level, id, titleTxt, evidence, why, ask) {
      items.push({ level: level, id: id, title: titleTxt, evidence: evidence, why: why, ask: ask });
    }

    /* ---------- ① 法定红线 ---------- */
    var fee = hits(jd, FEE_STRONG).concat(hits(jd, FEE_WEAK, true));
    if (fee.length) {
      add('red', 'fee', '招聘收费', 'JD 原文：「' + fee[0].snippet + '」',
        '《劳动合同法》第 9 条：用人单位不得要求劳动者提供担保，或以其他名义向劳动者收取财物。出现词：' + words(fee.map(function (x) { return x.w; })),
        '可以直接问：「入职前需要我自己承担任何费用吗？培训、服装、体检这些怎么算？」');
    }
    var buy = hits(jd, BUY_FIRST);
    if (buy.length) {
      add('red', 'buyfirst', '先买后报', 'JD 原文：「' + buy[0].snippet + '」',
        '正规单位的设备/工具由公司采购走报销流程，不会让候选人先垫钱买。出现词：' + words(buy.map(function (x) { return x.w; })),
        '可以问：「这些设备是公司统一采购吗？有没有正式的采购或报销流程？」');
    }
    var secret = hits(jd, SECRET);
    if (secret.length) {
      add('red', 'secret', '索取敏感信息', 'JD 原文：「' + secret[0].snippet + '」',
        '入职前索要银行卡正反面、验证码、人脸或支付密码，是盗号/贷款的常见套路。出现词：' + words(secret.map(function (x) { return x.w; })),
        '⛔ 验证码和支付密码**任何人都不能给**。正式入职办银行卡也只在签约后、走公司系统。');
    }
    var priv = hits(jd, PRIV_PAY);
    if (priv.length) {
      add('red', 'privpay', '私人账户收款', 'JD 原文：「' + priv[0].snippet + '」',
        '公司收款走对公账户。让转个人微信/支付宝、或用虚拟币结算，基本可以直接放弃。出现词：' + words(priv.map(function (x) { return x.w; })),
        '不必问了，问也是「公司规定」。可以要求走对公账户，对方拒绝就等于答案。');
    }

    /* ---------- ② 用工主体 ---------- */
    if (job.proxyHire) {
      add(config.proxyHireLevel, 'proxy', '平台标注「代招」', 'BOSS 岗位页标注了「代招」',
        '代招本身不违法（猎头/人力资源公司代发很常见），但意味着**跟你聊的和签合同的可能不是同一家**。',
        '值得问清：「这个岗位是和贵公司直签，还是和第三方签？社保由谁缴纳？」');
    }
    var outs = hits(jd, OUTSRC);
    if (outs.length) {
      add('yellow', 'outsource', '用工主体可能是第三方', 'JD 原文：「' + outs[0].snippet + '」',
        '出现词：' + words(outs.map(function (x) { return x.w; })) + '。不代表有问题，但要弄清「劳动关系归谁」。',
        '可以问：「劳动合同的甲方是哪家公司？工作地点和汇报对象是哪个团队？」');
    }
    if (job.invalid) {
      add('yellow', 'invalid', '岗位已失效', 'BOSS 岗位页标注了「已失效」',
        '岗位已下线，投了大概率没有回应 —— 不是坑，是白费力气。',
        '直接跳过，或找同公司其他在招岗位。');
    }

    /* ---------- ③ 话术红旗（组合触发，单个词不报） ---------- */
    var hype = hits(jd, HYPE_SALARY);
    var hasBase = anyHit(jd, BASE_SALARY) || (typeof job.salaryMin === 'number' && job.salaryMin > 0);
    if (hype.length && !hasBase) {
      add('yellow', 'salaryVague', '薪资结构含糊', 'JD 原文：「' + hype[0].snippet + '」',
        '写了「' + words(hype.map(function (x) { return x.w; })) + '」但通篇没提底薪或固定薪资。',
        '可以问：「薪资里固定部分是多少？提成怎么算、按什么周期结算？」');
    }
    var urg = hits(jd, URGENT);
    if (urg.length && (anyHit(jd, HIGH_MONEY) || anyHit(jd, TOO_GOOD))) {
      add('yellow', 'urgent', '制造紧迫感', 'JD 原文：「' + urg[0].snippet + '」',
        '「' + words(urg.map(function (x) { return x.w; })) + '」配合高薪/低门槛，是让你来不及核实的常见组合。',
        '不用赶。正规岗位不会因为你多考虑两天就没了 —— 慢下来去核实。');
    }
    var good = hits(jd, TOO_GOOD);
    if (good.length && anyHit(jd, HIGH_MONEY)) {
      add('yellow', 'tooGood', '门槛与报酬不匹配', 'JD 原文：「' + good[0].snippet + '」',
        '「' + words(good.map(function (x) { return x.w; })) + '」同时出现收入类表述，值得确认收入是怎么构成的。',
        '可以问：「这个岗位的普通新人前三个月实际到手大概多少？」');
    }
    /* 「挂羊头」：标题像职能岗，正文却以销售动作和提成为主。
       ⛔ 两道防误报的闸（都是拿真实数据试出来的）：
          ① **标题自己就写了销售词 → 跳过**。例：「销售岗（房屋视频号拍摄运营）」
             标题明说了是销售，正文出现「销售/提成」完全一致，这叫**诚实告知**，不是挂羊头。
          ② **至少 3 个**销售词才报。2 个时会被「有销售、直播相关经验优先」这种
             *任职要求里的顺带提及* 骗到（实测：浙江无忧娱乐的「抖音运营」就是这么被误报的）。
       代价是会更漏一些 —— 但**宁可漏，不可冤**。 */
    var salesHits = hits(jd, BODY_SALES);
    if (anyHit(title, TITLE_SOFT) && !anyHit(title, BODY_SALES) && salesHits.length >= 3) {
      add('yellow', 'mismatch', '岗位名与正文对不上',
        '标题写「' + title + '」，JD 正文出现：' + words(salesHits.map(function (x) { return x.w; })),
        '标题是职能岗，正文却以销售动作和提成为主 —— 进面后多半是另一回事。',
        '可以问：「这个岗位有业绩指标或销售任务吗？考核怎么算？」');
    }

    /* ---------- 汇总 ---------- */
    if (!scanned && !items.length) {
      return { level: 'unknown', items: [], scanned: false, redCount: 0, yellowCount: 0 };
    }
    var reds = items.filter(function (x) { return x.level === 'red'; });
    var yels = items.filter(function (x) { return x.level === 'yellow'; });
    var level = reds.length ? 'red' : yels.length ? 'yellow' : 'green';
    return {
      level: level, items: items, scanned: scanned,
      redCount: reds.length, yellowCount: yels.length,
    };
  }

  /* ==================== 渲染 ==================== */

  function lv(level) { return LEVELS[level] || LEVELS.unknown; }

  /** 卡片上的徽章（和「合适度」徽章并列） */
  function badge(v) {
    if (!v || v.level === 'unknown') {
      return el('span', {
        class: 'fbadge', text: '⚪ 避坑未扫',
        title: LEVELS.unknown.tip,
      });
    }
    if (v.level === 'green') {
      return el('span', {
        class: 'fbadge ok', text: '🟢 未发现问题',
        title: LEVELS.green.tip + '（已扫 JD 和已知字段）',
      });
    }
    var n = v.redCount + v.yellowCount;
    var tip = [];
    (v.items || []).forEach(function (it) { tip.push((it.level === 'red' ? '🔴 ' : '🟡 ') + it.title); });
    return el('span', {
      class: 'fbadge ' + lv(v.level).cls,
      text: lv(v.level).ico + ' ' + n + ' 项需注意',
      title: tip.join('\n'),
    });
  }

  /** 详情抽屉里的「需注意」块：每条都带原文 + 为什么 + 怎么问 */
  function panel(v) {
    if (!v || v.level === 'unknown') {
      return el('div', { class: 'box' }, [
        el('div', { class: 'fs12 muted', text: '⚪ 这条岗位没有 JD 原文可扫 —— 未扫描不等于没问题。' }),
      ]);
    }
    if (v.level === 'green') {
      return el('div', { class: 'box' }, [
        el('div', { class: 'fs12 ok-c', text: '🟢 已扫过 JD 原文和已知字段，没触发任何避坑规则。' }),
        el('div', { class: 'fs11 muted mt4', text: '规则只看「原文里写了什么」，判断不了公司实际怎么样 —— 该核实的还是要核实。' }),
      ]);
    }
    var box = el('div', { class: 'box stack', style: 'gap:10px' });
    (v.items || []).forEach(function (it) {
      box.appendChild(el('div', { class: 'pit' }, [
        el('div', { class: 'row', style: 'gap:6px;align-items:center' }, [
          el('span', { class: 'fbadge ' + lv(it.level).cls, text: lv(it.level).ico + ' ' + it.title }),
        ]),
        el('div', { class: 'fs12 mt4', text: it.evidence }),
        el('div', { class: 'fs11 muted mt2', text: '为什么：' + it.why }),
        el('div', { class: 'fs11 brand-c mt4', text: '💬 ' + it.ask }),
      ]));
    });
    box.appendChild(el('div', { class: 'fs11 muted', text:
      '⚠️ 这些是**从 JD 原文挑出来的事实**，不是结论。规则会误报，决定权在你 —— 建议先按上面的问法问一句。' }));
    return box;
  }

  /* ==================== 缓存（卡片要按分数/筛选频繁重画，别每次全扫） ==================== */
  var _cache = {};
  function of(job) {
    if (!job || !job.id) return verdict(job);
    var key = job.id + '|' + (job.updatedAt || 0) + '|' + (job.rawJD || '').length;
    if (!_cache[key]) {
      _cache[key] = verdict(job);
      // 简单封顶，避免长会话里无限涨
      var ks = Object.keys(_cache);
      if (ks.length > 2000) { for (var i = 0; i < 1000; i++) delete _cache[ks[i]]; }
    }
    return _cache[key];
  }
  function clearCache() { _cache = {}; }

  global.Pitfall = {
    config: config, LEVELS: LEVELS,
    verdict: verdict, of: of, clearCache: clearCache,
    badge: badge, panel: panel,
    // 测试要能单独验「否定语境」这一条（本模块最贵的教训）
    hits: hits, negated: negated, lineAt: lineAt,
    // 词表也暴露出去，方便测试计数断言
    TABLES: {
      FEE_STRONG: FEE_STRONG, FEE_WEAK: FEE_WEAK, BUY_FIRST: BUY_FIRST,
      SECRET: SECRET, PRIV_PAY: PRIV_PAY, OUTSRC: OUTSRC,
      HYPE_SALARY: HYPE_SALARY, URGENT: URGENT, TOO_GOOD: TOO_GOOD,
      TITLE_SOFT: TITLE_SOFT, BODY_SALES: BODY_SALES, NEG: NEG,
    },
  };
})(window);
