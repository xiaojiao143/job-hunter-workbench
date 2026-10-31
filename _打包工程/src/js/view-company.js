/* ==========================================================================
   view-company.js · 模块 10：公司背调
   --------------------------------------------------------------------------
   在**投出沟通次数之前**把公司查一遍。

   两条路线（见 js/company-check.js 的说明）：
     ① 一键跳转：点公司名 → 打开天眼查 / 爱企查，人工看一眼（0 成本，默认可用）
     ② 人工录入 -> 自动分级：把在网上看到的那几项填进来，
        分级 + 组合预警 + 「该查什么」清单照跑（不需要任何 Key）

   ⛔ 三条口径（都在页面上写给用户看）：
     · 没查过的公司**显示「未评定」，不显示绿灯** —— 把"没查"当成"没问题"最危险
     · 第三方数据仅供参考、不构成法律意见；重大决策以 gsxt.gov.cn 为准
     · 本工具不代申请、不内置任何数据平台的 Key
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  /** 页面级筛选状态（切页再回来保留） */
  var F = { q: '', level: '', onlyTodo: false, scope: 'all' };

  function cfg() {
    return Object.assign(
      { provider: 'tianyancha', apiKey: '', maxCalls: 2, scope: 'all' },
      Store.settings().bgCheck || {});
  }
  function CC() { return global.CompanyCheck; }

  /* ==================== 数据：公司清单 ==================== */

  /**
   * 触发范围（§3）：不是所有岗位的公司都值得花时间查。
   *   all  → 岗位库里全部未归档岗位
   *   todo → 收藏 / 待投递的（用户已经明确"准备投"的那些）
   *   AB   → 本地合适度 A / B 级的岗位
   */
  function scopedJobs() {
    var jobs = Store.jobs({ includeArchived: false });
    var scope = cfg().scope;
    if (scope === 'todo') {
      var todoIds = {};
      Store.applications().forEach(function (a) { if (a.status === 'todo') todoIds[a.jobId] = 1; });
      return jobs.filter(function (j) { return j.favorite || todoIds[j.id]; });
    }
    if (scope === 'AB') {
      if (!global.JobScorer) return jobs;
      return jobs.filter(function (j) {
        var r = global.JobScorer.score(j);
        return r && !(r.gate && r.gate.drop) && r.level && (r.level.key === 'A' || r.level.key === 'B');
      });
    }
    return jobs;
  }

  /** 公司清单（含归并 + 档案挂载 + 当前筛选） */
  function rows() {
    var list = CC().companiesFromJobs(scopedJobs(), Store.checks());
    // 触发范围限定后，已录档案但这次不在范围里的公司不显示（页面只管"要投的那些"）
    // —— 但只在范围不是 all 时才这样，否则用户会以为档案丢了
    if (F.onlyTodo) list = list.filter(function (g) { return !g.hasCheck; });
    if (F.level) {
      list = list.filter(function (g) {
        var v = CC().verdict(g.check);
        return v.level === F.level;
      });
    }
    if (F.q) {
      var q = F.q.toLowerCase();
      list = list.filter(function (g) { return (g.company || '').toLowerCase().indexOf(q) >= 0; });
    }
    return list;
  }

  /** 全部公司（不受筛选影响）—— 统计卡用 */
  function allRows() { return CC().companiesFromJobs(scopedJobs(), Store.checks()); }

  function lampOf(g) { return CC().verdict(g.check); }

  /** 每盏灯各几家 */
  function counts() {
    var out = { red: 0, yellow: 0, green: 0, unknown: 0, unchecked: 0, total: 0 };
    allRows().forEach(function (g) {
      out.total++;
      var v = lampOf(g);
      out[v.level] = (out[v.level] || 0) + 1;
      if (!g.check || !CC().hasData(g.check)) out.unchecked++;
    });
    return out;
  }

  /* ==================== 页面 ==================== */

  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    /* --- 顶部按钮 --- */
    App.topActions([
      el('button', {
        class: 'btn', html: '📤 导出背调清单',
        title: '把已录入的背调档案导成 Excel / CSV，方便离线比对',
        onclick: function (e) { exportChecks(e.currentTarget || e.target); },
      }),
      el('button', {
        class: 'btn', html: '📋 该查什么？',
        onclick: function () { openGuide(); },
      }),
    ]);

    /* --- ① 免责与边界（§5）—— 放在最上面，不是最下面 --- */
    wrap.appendChild(el('div', { class: 'note warn' }, [
      el('span', { class: 'ico', text: '⚖️' }),
      el('div', { html:
        '数据来自第三方平台（天眼查 / 爱企查）与国家企业信用信息公示系统，' +
        '<b>仅供参考，不构成法律意见</b>。网页 / 接口数据都有更新延迟，' +
        '签约、入职等重大决策前请以 <b>gsxt.gov.cn</b> 官方公示为准。' +
        '<br><span class="fs11">这个页面只做三件事：帮你一键跳过去查、把你查到的结果记下来、按风险给出<b>分级提示</b>。' +
        '结论由你下。</span>' }),
    ]));

    /* --- ② 统计 --- */
    var c = counts();
    wrap.appendChild(el('div', { class: 'grid g4' }, [
      { k: '要背调的公司', v: c.total, d: scopeText(), c: '', icon: '🏢' },
      { k: '红灯', v: c.red, d: c.red ? '建议放弃或极度谨慎' : '暂时没有红灯公司', c: c.red ? 'c-bad' : '', icon: '🔴' },
      { k: '黄灯', v: c.yellow, d: c.yellow ? '人工确认后再投' : '没有需要人工确认的', c: c.yellow ? 'c-warn' : '', icon: '🟡' },
      { k: '还没查', v: c.unchecked, d: c.unchecked ? '先查这几家再投' : '范围内的都查过了', c: c.unchecked ? 'c-brand' : 'c-ok', icon: '⚪' },
    ].map(function (s) {
      return el('div', { class: 'stat ' + (s.c || '') }, [
        el('div', { class: 'k', html: s.icon + ' ' + s.k }),
        el('div', { class: 'v', text: s.v }),
        el('div', { class: 'd', text: s.d }),
      ]);
    })));

    /* --- ③ 触发范围 + 筛选 --- */
    wrap.appendChild(scopeBar());

    var list = rows();

    if (!list.length) {
      wrap.appendChild(Comp.empty('🔎', '这个范围内没有要背调的公司',
        '背调的对象是「<b>你准备投的那些公司</b>」——所以先去岗位库导入 / 采集一批岗位。<br>' +
        (cfg().scope === 'todo' ? '当前触发范围是「收藏 + 待投递」，这个范围还是空的。<br>' : '') +
        '<span class="fs12">也可以在下面「背调配置」里把触发范围放宽。</span>',
        '去岗位库', function () { App.go('jobs'); }));
      wrap.appendChild(configCard());
      return;
    }

    /* --- ④ 搜索 + 灯位筛选 --- */
    var bar = el('div', { class: 'row ck-bar', style: 'gap:8px;flex-wrap:wrap' });
    var q = el('input', { type: 'text', value: F.q, placeholder: '搜公司名', class: 'ck-q' });
    q.addEventListener('input', U.debounce(function () {
      F.q = q.value.trim(); App.refresh();
    }, 180));
    bar.appendChild(q);

    var LAMPS = [
      { v: '', l: '全部 ' + c.total },
      { v: 'red', l: '🔴 红灯 ' + c.red },
      { v: 'yellow', l: '🟡 黄灯 ' + c.yellow },
      { v: 'green', l: '🟢 绿灯 ' + c.green },
      { v: 'unknown', l: '⚪ 未评定 ' + c.unknown },
    ];
    LAMPS.forEach(function (o) {
      bar.appendChild(el('span', {
        class: 'tag ' + (F.level === o.v ? 'brand' : 'line'),
        style: 'cursor:pointer', text: o.l,
        onclick: function () { F.level = F.level === o.v ? '' : o.v; App.refresh(); },
      }));
    });
    bar.appendChild(el('span', { class: 'sp' }));
    bar.appendChild(el('span', {
      class: 'tag ' + (F.onlyTodo ? 'brand' : 'line'),
      style: 'cursor:pointer', text: '只看还没查的 ' + c.unchecked,
      title: '把已经录过结果的公司藏起来，先把没查的消化掉',
      onclick: function () { F.onlyTodo = !F.onlyTodo; App.refresh(); },
    }));
    wrap.appendChild(bar);

    /* --- ⑤ 公司清单 --- */
    var card = el('div', { class: 'card' });
    card.appendChild(el('header', {}, [
      el('h3', { text: '🔎 公司清单' }),
      el('span', { class: 'tag line', text: list.length + ' 家' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'hint tiny', text: '点公司名 → 打开天眼查；「✍️ 录入结果」把查到的情况记下来' }),
    ]));
    var body = el('div', { class: 'ck-list' });
    list.slice(0, 200).forEach(function (g) { body.appendChild(rowOf(g)); });
    card.appendChild(body);
    if (list.length > 200) {
      card.appendChild(el('div', { class: 'fs12 muted', style: 'padding:8px 14px', text: '…只列出前 200 家，用上面的搜索缩小范围。' }));
    }
    wrap.appendChild(card);

    wrap.appendChild(configCard());
  }

  function scopeText() {
    var s = cfg().scope;
    return s === 'todo' ? '范围：收藏 + 待投递' : s === 'AB' ? '范围：合适度 A / B 级' : '范围：岗位库全部';
  }

  function scopeBar() {
    var box = el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap;align-items:center' });
    box.appendChild(el('span', { class: 'fs12 muted', text: '触发范围：' }));
    var OPTS = [
      { v: 'all', l: '全部岗位', t: '岗位库里所有未归档岗位的公司' },
      { v: 'todo', l: '收藏 + 待投递', t: '你已经明确"准备投"的那些 —— 默认最省时间的范围' },
      { v: 'AB', l: '仅 A / B 级', t: '本地合适度算出 A 或 B 级的岗位所属公司' },
    ];
    var cur = cfg().scope;
    OPTS.forEach(function (o) {
      box.appendChild(el('span', {
        class: 'tag ' + (cur === o.v ? 'brand' : 'line'),
        style: 'cursor:pointer', text: o.l, title: o.t,
        onclick: function () {
          if (cur === o.v) return;
          Store.setSetting('bgCheck.scope', o.v);
          F.level = ''; F.onlyTodo = false;
          U.toast('触发范围已改成「' + o.l + '」', 'ok', 2600);
          App.updateNavCounts();
          App.refresh();
        },
      }));
    });
    box.appendChild(el('span', { class: 'sp' }));
    box.appendChild(el('span', { class: 'hint tiny', text: '先查"准备投的"，别一上来把岗位库几百家全查一遍' }));
    return box;
  }

  /* ==================== 单行 ==================== */

  function rowOf(g) {
    var v = lampOf(g);
    var rec = g.check;
    var row = el('div', { class: 'ckrow' });

    /* 头行：灯 + 公司名（可点）+ 岗位数 */
    var name = el('b', {
      class: 'ck-name', text: g.company,
      title: '点一下打开天眼查搜索这家公司',
      onclick: function () { doOpen('tianyancha', g); },
    });
    row.appendChild(el('div', { class: 'ck-head' }, [
      el('span', { class: 'ck-lamp', text: v.ico, title: v.label + '：' + v.advice }),
      name,
      el('span', { class: 'tag ' + (v.cls || 'line'), text: v.label, title: v.advice }),
      el('span', { class: 'sp' }),
      el('span', { class: 'fs11 muted', text: g.count + ' 个岗位' }),
    ]));

    /* 分级理由（有几条写几条 —— 只说"红灯"不说为什么等于没说） */
    if (v.reasons.length) {
      row.appendChild(el('div', { class: 'ck-meta fs12' }, v.reasons.map(function (r) {
        return el('div', { html: '· ' + r });
      })));
    }

    /* 工商摘要 + 风险计数 */
    if (rec && CC().hasData(rec)) {
      row.appendChild(el('div', { class: 'fs12 muted', text: '📄 ' + (CC().regLine(rec) || '（工商信息没填全）') }));
      row.appendChild(el('div', { class: 'fs12', text: '⚠️ ' + CC().riskLine(rec) }));
    } else {
      row.appendChild(el('div', { class: 'fs12 muted', text: '还没查过这家 —— 点公司名跳过去看一眼，回来把结果录进来（不录也影响不了别的）' }));
    }

    /* 组合预警（§4 最后一条）。
       ⚠️ 话术的来源有两个：这家公司下所有岗位的文本 + **录入时填的「招聘话术原文」**。
          以前只取前者 —— 那「招聘话术原文」这个字段填了等于白填。 */
    var combo = CC().comboRisk(rec, jobTexts(g).concat(rec && rec.talk ? [rec.talk] : []));
    if (combo.n) {
      row.appendChild(el('div', { class: 'ck-combo' + (combo.danger ? ' bad' : '') }, [
        el('b', { text: combo.danger ? '🚨 高危组合（' + combo.n + ' 项）：' : '⚠️ 有几个信号（' + combo.n + ' 项）：' }),
        el('span', { html: combo.hits.join(' ＋ ') }),
        combo.danger ? el('div', { class: 'fs11', text: '这几项叠在一起时，"底薪加提成 + 拖欠工资 + 大量仲裁"是同一种公司的常见画像。建议先别投。' }) : null,
      ].filter(Boolean)));
    }

    if (rec && rec.note) {
      row.appendChild(el('div', { class: 'fs12 ck-note', text: '📝 ' + rec.note }));
    }

    /* 操作 */
    var ops = el('div', { class: 'ck-ops row' });
    CC().SITES.forEach(function (s) {
      ops.appendChild(el('button', {
        class: 'btn xs' + (s.primary ? '' : ' ghost'), type: 'button',
        html: s.ico + ' ' + (s.manual ? '官方站' : s.name),
        title: s.note,
        onclick: function () { doOpen(s.k, g); },
      }));
    });
    ops.appendChild(el('button', {
      class: 'btn xs' + (g.hasCheck ? ' ghost' : ' pri'), type: 'button',
      html: rec && CC().hasData(rec) ? '✍️ 改结果' : '✍️ 录入结果',
      onclick: function () { openEdit(g.company, g.jobIds, function () { App.updateNavCounts(); App.refresh(); }); },
    }));
    if (rec) {
      ops.appendChild(el('button', {
        class: 'btn xs ghost', type: 'button', html: '🗑️ 删档案',
        title: '只删这条背调记录，不影响岗位（可撤销）',
        onclick: function () {
          /* 和其他删除一致：**可撤销**。
             这份档案是人工一项项填出来的，误删比误删一个岗位更让人恼火。 */
          var snap = Store.takeOut({ checks: [rec.id] });
          Comp.trashToast('已删掉「' + CC().shortName(g.company) + '」的背调记录（岗位没动）', snap, function () {
            App.updateNavCounts(); App.refresh();
          });
          App.updateNavCounts();
          App.refresh();
        },
      }));
    }
    row.appendChild(ops);

    return row;
  }

  /** 这家公司下所有岗位的文本（岗位名 + JD + 标签）—— 组合预警里判「底薪加提成」话术用 */
  function jobTexts(g) {
    return (g.jobs || []).map(function (j) {
      return [j.title, j.rawJD, (j.tags || []).join(' '), (j.benefits || []).join(' ')].filter(Boolean).join('\n');
    });
  }

  function doOpen(siteKey, g) {
    var r = CC().openSite(siteKey, g.company);
    if (!r.ok) {
      U.toast(r.reason === 'blocked'
        ? '浏览器拦了新窗口 —— 请允许本站弹出窗口后重试。'
        : '打不开这个站点：' + r.reason, 'warn', 6000);
      return;
    }
    // 记一笔「查过」（哪怕还没录结果）—— 下次来看就知道哪些点过了
    if (g.check) {
      if (!g.check.queriedAt) Store.updateCheck(g.check.id, { queriedAt: U.now() });
    } else {
      Store.addCheck(Object.assign(CC().blankCheck(g.company), {
        jobIds: g.jobIds, queriedAt: U.now(), source: 'site:' + siteKey,
      }));
    }
    if (siteKey === 'gsxt') {
      U.toast('公司名已复制，进去黏贴搜索即可。官方站最权威，签约前以它为准。', 'info', 6000);
    } else {
      U.toast('已打开' + CC().site(siteKey).name + '。看到「被执行 / 失信 / 劳动争议」回来点「✍️ 录入结果」记下来。', 'info', 7000);
    }
    App.updateNavCounts();
    App.refresh();
  }

  /* ==================== 录入 / 编辑弹窗 ==================== */

  /**
   * @param company 公司名
   * @param jobIds  关联岗位（方便以后从公司点回岗位）
   * @param after   保存后的回调
   */
  function openEdit(company, jobIds, after) {
    var rec = Store.checkByCompany(company) || CC().blankCheck(company);
    var reg = rec.reg || {}, risk = rec.risk || {};

    function numField(key, label, val, hint) {
      return Comp.field({ key: key, label: label, type: 'number', value: val, hint: hint });
    }

    var fCode = Comp.field({ key: 'creditCode', label: '统一社会信用代码', value: reg.creditCode || '',
      optional: true, hint: '18 位。填了以后同名公司也不会认错' });
    var fEst = Comp.field({ key: 'establishedAt', label: '成立日期', type: 'date',
      value: reg.establishedAt ? U.d2(reg.establishedAt) : '',
      hint: '⚠️ 这项决定「成立不足 1 年」的判定，最值得填' });
    var fCap = Comp.field({ key: 'capital', label: '注册资本（万元）', type: 'number', value: reg.capital,
      optional: true });
    var fPaid = Comp.field({ key: 'paidIn', label: '实缴资本（万元）', type: 'number', value: reg.paidIn,
      hint: '<b>填 0 = 查到了但实缴为 0</b>（这是预警信号）；<b>留空 = 没查到</b>。两者不一样，别混', });
    var fStatus = Comp.field({ key: 'status', label: '经营状态', value: reg.status || '',
      placeholder: '存续 / 在业 / 注销 / 吊销', optional: true,
      hint: '填「注销 / 吊销」会直接红灯 —— 公司主体都不在正常经营状态了' });

    /* 用 grid g2 手动排版（field 只负责单个字段，不负责分列） */
    function grid2(items) {
      return el('div', { class: 'grid g2', style: 'gap:12px' }, items.map(function (x) { return x.node; }));
    }

    var riskFields = CC().RISK_ITEMS.map(function (it) {
      // 传值不要 `|| 0`：null → Comp.field 不设 value → 输入框留空（= 没查），
      // 而不是显示一个「0」（那会被 collect() 当成「查过且为 0」）。
      return numField('r_' + it.k, it.ico + ' ' + it.label, risk[it.k], it.hint);
    });

    var fTalk = Comp.field({ key: 'talk', label: '招聘话术原文', type: 'textarea', rows: 2,
      value: rec.talk || '', optional: true,
      placeholder: '例：无责底薪 3000 + 高提成，上不封顶',
      hint: '（选填）把这家的招聘话术贴进来 —— 它和「实缴 0 / 成立不足 1 年 / 大量仲裁」叠在一起时才是高危组合' });
    var fNote = Comp.field({ key: 'note', label: '备注', type: 'textarea', rows: 2,
      value: rec.note || '', optional: true,
      placeholder: '例：面试时看到办公地点在居民楼；HR 说试用期不缴社保' });

    /* --- 实时预警预览：边填边看到结论，不用保存完再回列表看 --- */
    var prev = el('div', { class: 'ck-prev' });

    function collect() {
      var d = {
        reg: {
          name: company,
          creditCode: fCode.get(),
          establishedAt: fEst.get() ? Date.parse(fEst.get() + 'T00:00:00') : null,
          capital: fCap.get() === '' ? null : U.asNum(fCap.get()),
          paidIn: fPaid.get() === '' ? null : U.asNum(fPaid.get()),
          status: fStatus.get(),
          industry: reg.industry || '',
          address: reg.address || '',
        },
        risk: {},
        talk: fTalk.get(),
        note: fNote.get(),
        jobIds: jobIds || (rec.jobIds || []),
      };
      CC().RISK_ITEMS.forEach(function (it) {
        var f = riskFields.filter(function (x) { return x.key === 'r_' + it.k; })[0];
        // ⛔ 留空必须是 null，**不能** `|| 0`（评审核实 2026-10-12，P1-2）：
        //   以前空框写 0，于是「只填成立日期」也算「6 项风险都查过、都是 0」→ 假绿灯。
        //   0 只有用户**真的敲了 0** 才有意义（hint 里就是这么写的：填 0 = 查到了但为 0）。
        var n = f ? U.asNum(f.get()) : null;
        d.risk[it.k] = n;
      });
      return d;
    }

    function paintPrev() {
      var d = collect();
      var v = CC().verdict(d);
      var combo = CC().comboRisk(d, fTalk.get());
      prev.innerHTML = '';
      prev.appendChild(el('div', { class: 'row', style: 'gap:8px;align-items:baseline' }, [
        el('b', { text: '按现在填的内容：' }),
        el('span', { class: 'tag ' + (v.cls || 'line'), text: v.ico + ' ' + v.label }),
        el('span', { class: 'fs12 muted', text: v.advice }),
      ]));
      v.reasons.forEach(function (r) {
        prev.appendChild(el('div', { class: 'fs12', html: '· ' + r }));
      });
      if (combo.n) {
        prev.appendChild(el('div', { class: 'fs12' + (combo.danger ? ' bad-c' : ''), html:
          (combo.danger ? '🚨 高危组合（' + combo.n + ' 项）：' : '⚠️ 几个信号（' + combo.n + ' 项）：') +
          U.esc(combo.hits.join(' ＋ ')) }));
      }
    }

    var allFields = [fCode, fEst, fCap, fPaid, fStatus].concat(riskFields, [fTalk, fNote]);
    allFields.forEach(function (f) {
      f.input.addEventListener('input', paintPrev);
      f.input.addEventListener('change', paintPrev);
    });
    paintPrev();

    var settled = false;
    U.openModal({
      title: '✍️ 背调：' + U.esc(CC().shortName(company)),
      size: 'lg',
      body: el('div', { class: 'stack', style: 'gap:14px' }, [
        el('div', { class: 'note info fs12' }, [
          el('span', { class: 'ico', text: '📌' }),
          el('div', { html:
            '照着天眼查 / 爱企查上看到的内容填。<b>没查到就留空，别填 0</b> —— ' +
            '「实缴 0」和「不知道实缴多少」是两件事，前者是预警信号、后者是没数据。' }),
        ]),

        el('div', {}, [
          el('div', { class: 'fs12 muted fw6 mb8', text: '① 工商照面' }),
          grid2([fCode, fEst]),
          grid2([fCap, fPaid]),
          grid2([fStatus]),
        ]),

        el('div', {}, [
          el('div', { class: 'fs12 muted fw6 mb8', text: '② 风险计数（看到的条数，没有就留 0）' }),
          el('div', { class: 'grid g2', style: 'gap:12px' }, riskFields.map(function (x) { return x.node; })),
        ]),

        el('div', {}, [
          el('div', { class: 'fs12 muted fw6 mb8', text: '③ 话术与备注' }),
          fTalk.node, fNote.node,
        ]),

        el('div', {}, [
          el('div', { class: 'fs12 muted fw6 mb8', text: '④ 会判成什么' }),
          prev,
        ]),
      ]),
      footer: [
        { text: '保存', cls: 'pri', onClick: function (close) {
          /* ⛔ 顺序要紧：**先把值落盘，再关窗**。
             先 close() 再干活的话，openModal 的 onClose 会先 resolve(null)，
             「保存」就等于「取消」（这个坑本项目踩过一次，7 个功能一起失效）。 */
          if (settled) return;
          var d = collect();
          Store.upsertCheck(company, Object.assign(d, { source: 'manual', queriedAt: rec.queriedAt || U.now() }));
          settled = true;
          var v = CC().verdict(d);
          U.toast('已存下「' + CC().shortName(company) + '」的背调结果：' + v.ico + ' ' + v.label, 'ok', 5000);
          close();
          if (after) after();
        } },
        { text: '取消', onClick: function (close) { settled = true; close(); } },
      ],
    });
  }

  /* ==================== 从岗位库卡片点进来（弹窗版） ==================== */

  /** 给 view-jobs.js 用：点公司名 → 摘要 + 跳转 + 录入 */
  function openFor(company, opt) {
    opt = opt || {};
    var rec = Store.checkByCompany(company);
    var jobIds = opt.jobIds || [];
    var v = CC().verdict(rec);
    var combo = CC().comboRisk(rec, opt.texts || []);

    var body = el('div', { class: 'stack', style: 'gap:12px' });
    body.appendChild(el('div', { class: 'row', style: 'gap:8px;align-items:baseline' }, [
      el('span', { class: 'ck-lamp', text: v.ico }),
      el('b', { text: company }),
      el('span', { class: 'tag ' + (v.cls || 'line'), text: v.label, title: v.advice }),
    ]));
    body.appendChild(el('div', { class: 'fs12 muted', text: v.advice }));
    v.reasons.forEach(function (r) { body.appendChild(el('div', { class: 'fs12', html: '· ' + r })); });

    if (rec && CC().hasData(rec)) {
      body.appendChild(el('div', { class: 'fs12', text: '📄 ' + (CC().regLine(rec) || '——') }));
      body.appendChild(el('div', { class: 'fs12', text: '⚠️ ' + CC().riskLine(rec) }));
    }
    if (combo.n) {
      body.appendChild(el('div', { class: 'ck-combo' + (combo.danger ? ' bad' : '') }, [
        el('b', { text: (combo.danger ? '🚨 高危组合：' : '⚠️ 几个信号：') }),
        el('span', { html: combo.hits.join(' ＋ ') }),
      ]));
    }
    if (rec && rec.note) body.appendChild(el('div', { class: 'fs12', text: '📝 ' + rec.note }));

    /* 「该查什么」清单 —— 里程碑 B3 要的「30 秒内看到该查什么」 */
    var cl = CC().checklist(rec, null);
    var miss = cl.filter(function (x) { return !x.got; });
    if (miss.length) {
      body.appendChild(el('div', { class: 'note line fs12' }, [
        el('span', { class: 'ico', text: '📋' }),
        el('div', {}, [
          el('b', { text: '还没查这几项：' }),
          el('div', { html: miss.map(function (x) { return '· ' + x.label + ' —— <span class="muted">' + x.why + '</span>'; }).join('<br>') }),
        ]),
      ]));
    }

    body.appendChild(el('div', { class: 'note warn fs11' }, [
      el('span', { class: 'ico', text: '⚖️' }),
      el('div', { html: '仅供参考、不构成法律意见。签 / 入职前以 <b>gsxt.gov.cn</b> 官方公示为准。' }),
    ]));

    var ops = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
    CC().SITES.forEach(function (s) {
      ops.appendChild(el('button', {
        class: 'btn xs' + (s.primary ? '' : ' ghost'), type: 'button',
        html: s.ico + ' ' + (s.manual ? '官方站（会复制公司名）' : s.name),
        title: s.note,
        onclick: function () {
          var r = CC().openSite(s.k, company);
          if (!r.ok) { U.toast('打不开：' + r.reason, 'warn'); return; }
          if (rec) { if (!rec.queriedAt) Store.updateCheck(rec.id, { queriedAt: U.now() }); }
          else Store.addCheck(Object.assign(CC().blankCheck(company), { jobIds: jobIds, queriedAt: U.now(), source: 'site:' + s.k }));
          App.updateNavCounts();
          if (s.k === 'gsxt') U.toast('公司名已复制，进去黏贴搜索即可。', 'info', 6000);
        },
      }));
    });
    ops.appendChild(el('button', {
      class: 'btn xs pri', type: 'button', html: '✍️ 录入 / 改结果',
      /* ⛔ 这里的 onclick 首参是 MouseEvent，不是 close（评审核实 2026-10-30，P0）。
         body 里的按钮不会被注入 close，只有 footer 的 onClick(close) 才会。
         以前写成 function (close) { close(); ... } → 点下去抛 TypeError，
         弹窗关不掉、录入表单打不开。改为用 openModal 返回的 m.close()。 */
      onclick: function () {
        m.close();
        openEdit(company, jobIds, function () { App.updateNavCounts(); App.refresh(); });
      },
    }));
    body.appendChild(ops);

    var m = U.openModal({
      title: '🔎 背调：' + U.esc(CC().shortName(company)),
      size: 'md',
      body: body,
      footer: [
        { text: '去背调页看全部', onClick: function (close) { close(); App.go('company'); } },
        { text: '关闭', cls: 'pri', onClick: function (close) { close(); } },
      ],
    });
  }

  /* ==================== 「该查什么」说明 ==================== */

  function openGuide() {
    var items = CC().checklist(null, null);
    U.openModal({
      title: '📋 30 秒：该查哪几项',
      size: 'md',
      body: el('div', { class: 'stack', style: 'gap:12px' }, [
        el('div', { class: 'note info fs12', html:
          '一页页翻工商信息很容易看晕。按这个顺序看，前两项不对劲就可以直接跳过这家了。' }),
        el('div', { class: 'stack', style: 'gap:9px' }, items.map(function (x, i) {
          return el('div', { class: 'row', style: 'gap:9px;align-items:baseline' }, [
            el('b', { style: 'min-width:18px', text: String(i + 1) }),
            el('div', {}, [
              el('b', { text: x.label }),
              el('div', { class: 'fs12 muted', text: x.why }),
            ]),
          ]);
        })),
        el('div', {}, [
          el('div', { class: 'fs12 muted fw6 mb8', text: '看到结果怎么判' }),
          el('div', { class: 'stack', style: 'gap:6px' }, [
            { i: '🔴', t: '红灯', d: '被执行 / 失信 / 大量劳动仲裁 / 行政处罚频繁 / 经营状态注销或吊销 → 建议放弃或极度谨慎' },
            { i: '🟡', t: '黄灯', d: '成立 <1 年 / 实缴为 0 / 少量经营异常 → 人工确认后再投' },
            { i: '🟢', t: '绿灯', d: '成立 2 年以上 + 无被执行 / 失信 + 劳动纠纷少 → 可正常跟进' },
            { i: '⚪', t: '未评定', d: '还没查或数据不全 —— <b>不是绿灯</b>' },
          ].map(function (r) {
            return el('div', { class: 'fs12' }, [
              el('b', { text: r.i + ' ' + r.t + '：' }),
              el('span', { html: r.d }),
            ]);
          })),
        ]),
      ]),
      footer: [{ text: '知道了', cls: 'pri', onClick: function (close) { close(); } }],
    });
  }

  /* ==================== 导出 ==================== */

  function exportChecks(anchor) {
    var list = Store.checks();
    if (!list.length) {
      U.toast('还没录过任何背调结果。先点公司名去查一下，回来填几项。', 'info', 6000);
      return;
    }
    var headers = ['公司', '预警灯', '判定依据', '统一社会信用代码', '成立日期', '注册资本(万)', '实缴资本(万)',
      '经营状态', '被执行', '失信', '开庭公告', '经营异常', '行政处罚', '劳动纠纷',
      '高危组合', '备注', '查询时间'];
    var rows = list.map(function (c) {
      var v = CC().verdict(c);
      var combo = CC().comboRisk(c, c.talk);
      return [
        c.company, v.label, v.reasons.join('；').replace(/<\/?b>/g, ''),
        c.reg.creditCode || '', c.reg.establishedAt ? U.d2(c.reg.establishedAt) : '',
        c.reg.capital === null ? '' : c.reg.capital,
        c.reg.paidIn === null ? '' : c.reg.paidIn,
        c.reg.status || '',
        // 风险项可能是 null（= 没查）—— 与上面 capital/paidIn 同口径，导出成空单元格而不是 "null"
        c.risk.zhixing === null ? '' : c.risk.zhixing,
        c.risk.shixin === null ? '' : c.risk.shixin,
        c.risk.court === null ? '' : c.risk.court,
        c.risk.abnormal === null ? '' : c.risk.abnormal,
        c.risk.penalty === null ? '' : c.risk.penalty,
        c.risk.labor === null ? '' : c.risk.labor,
        combo.n ? (combo.danger ? '高危 ' + combo.n + ' 项：' : combo.n + ' 项：') + combo.hits.join(' / ') : '',
        c.note || '', c.queriedAt ? U.d2t(c.queriedAt) : '',
      ];
    });
    U.menu(anchor, [
      { icon: '📊', text: '导出 Excel（.xls）', onClick: function () {
        global.Exporter.downloadExcel('公司背调_' + global.Exporter.stamp() + '.xls',
          [{ name: '公司背调', headers: headers, rows: rows }]);
        U.toast('已导出 ' + rows.length + ' 家公司的背调清单', 'ok');
      } },
      { icon: '📄', text: '导出 CSV', onClick: function () {
        global.Exporter.downloadCSV('公司背调_' + global.Exporter.stamp() + '.csv', headers, rows);
        U.toast('已导出 ' + rows.length + ' 家公司的背调清单', 'ok');
      } },
    ]);
  }

  /* ==================== 背调配置（路线 B 的配置位） ==================== */

  function configCard() {
    var c = cfg();
    var card = el('div', { class: 'card' });
    card.appendChild(el('header', {}, [
      el('h3', { text: '⚙ 背调配置' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'tag ' + (c.apiKey ? 'ok' : 'line'), text: c.apiKey ? '已填 Key' : '未填 Key（走人工录入）' }),
    ]));

    var body = el('div', { class: 'body stack', style: 'gap:12px' });

    body.appendChild(el('div', { class: 'note info fs12' }, [
      el('span', { class: 'ico', text: '✅' }),
      el('div', { html:
        '<b>上面的功能不需要这项配置</b> —— 一键跳转 + 人工录入 + 自动分级，' +
        '一条 Key 都不用。这里只是给「以后想接开放平台自动拉」留的位置。' }),
    ]));

    var fProvider = Comp.field({
      key: 'provider', label: '数据源', type: 'select',
      value: c.provider,
      options: [
        { value: 'tianyancha', label: '天眼查开放平台（open.tianyancha.com）' },
        { value: 'qcc', label: '企查查开放平台（openapi.qcc.com）' },
      ],
      hint: '两家的接口覆盖差不多，谁先申请下来用谁',
    });
    var fKey = Comp.field({
      key: 'apiKey', label: 'API Key / Token', value: c.apiKey,
      placeholder: '申请下来后粘贴到这里',
      hint: '⛔ <b>只存在本机浏览器里，不会上传</b>；导出备份时会被自动抹掉（见设置页说明）',
    });
    var fMax = Comp.field({
      key: 'maxCalls', label: '每家最多调几次', type: 'number', value: c.maxCalls,
      hint: '按约 0.5~1.3 元/家估算，防止手抖烧钱。默认 2',
    });

    body.appendChild(el('div', { class: 'grid g2', style: 'gap:12px' }, [
      fProvider.node, fMax.node,
    ]));
    body.appendChild(fKey.node);

    body.appendChild(el('div', { class: 'note warn fs12' }, [
      el('span', { class: 'ico', text: '🔑' }),
      el('div', { html:
        '<b>Key 需要你自己去申请</b>（实名 / 开发者认证 → 申请接口权限 → 拿 token）。' +
        '本工具<b>不代申请、不内置、不共享</b>任何账号 —— 内置 Key = 所有人的调用都算一份额度，' +
        '被限流时连你自己也用不了。' }),
    ]));

    var hint = el('div', { class: 'fs12 muted' });
    function paintHint() {
      var cur = cfg();
      hint.innerHTML = cur.apiKey
        ? '⚡ 已填 Key：接上本地采集服务（<code class="mono">启动采集器.cmd</code>）后，' +
          '浏览器直连数据平台会被跨域拦掉，必须经本地服务转发。当前版本先走「一键跳转 + 人工录入」，' +
          '<b>自动拉取是下一步</b>。'
        : '⚡ 还没填 Key —— 自动拉取不可用（也不需要）。现在这一页的全部能力都能正常用。';
    }
    paintHint();

    body.appendChild(el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
      el('button', {
        class: 'btn pri', html: '保存配置',
        onclick: function () {
          var n = U.asNum(fMax.get());
          Store.setSetting('bgCheck', {
            provider: fProvider.get() || 'tianyancha',
            apiKey: fKey.get(),
            maxCalls: (n === null || n < 1) ? 2 : Math.round(n),
            scope: cfg().scope,      // 触发范围由上面的按钮管，这里别覆盖掉
          });
          U.toast(fKey.get()
            ? '配置已保存。⚠️ 自动拉取还需要本地采集服务在跑，且要等接口权限批下来。'
            : '配置已保存（没填 Key，继续走人工录入）', 'ok', 6000);
          App.refresh();
        },
      }),
      el('button', {
        class: 'btn ghost', html: '怎么申请 Key？',
        onclick: function () {
          U.openModal({
            title: '怎么拿到背调的 API Key',
            size: 'md',
            body: el('div', { class: 'stack', style: 'gap:11px' }, [
              el('div', { class: 'note warn fs12', html:
                '这一段只是把「去哪办」写清楚，<b>不是这个工具能替你完成的事</b>。' }),
              el('div', { class: 'stack', style: 'gap:8px' }, [
                { t: '天眼查开放平台', u: 'https://open.tianyancha.com', d: '基础接口约 0.1~1 元/次，预充值或包年；200+ 接口，覆盖工商 / 司法 / 经营 / 股权' },
                { t: '企查查开放平台', u: 'https://openapi.qcc.com', d: '企业模糊搜索约 0.1 元/次；多数接口有免费试用额度（如 20 次），套餐千元档起' },
              ].map(function (x) {
                return el('div', {}, [
                  el('b', { text: x.t }),
                  el('div', { class: 'fs12 muted', text: x.u }),
                  el('div', { class: 'fs12', text: x.d }),
                ]);
              })),
              el('div', { class: 'fs12', html:
                '<b>要接的接口按优先级：</b><br>' +
                '① 企业模糊搜索 + 工商照面（成立时间 / 注册资本 / 实缴 / 状态）<br>' +
                '② 司法风险：被执行 / 失信 / 开庭公告（<b>最该看的</b>）<br>' +
                '③ 经营异常 / 行政处罚<br>' +
                '④ 劳动纠纷（劳动争议案由数量）' }),
              el('div', { class: 'note line fs12', html:
                '成本估算：每家公司约 <b>0.5~1.3 元</b>（模糊搜索 0.1 + 工商照面 0.1~0.2 + 司法 2 次 0.2~1）。' +
                '每月查 50 家约 25~65 元。建议先吃免费额度验证有用，再决定要不要充值。' }),
            ]),
            footer: [{ text: '知道了', cls: 'pri', onClick: function (close) { close(); } }],
          });
        },
      }),
    ]));
    body.appendChild(hint);

    card.appendChild(body);
    return card;
  }

  global.CompanyView = {
    render: render, openFor: openFor, openEdit: openEdit, openGuide: openGuide,
    rows: rows, allRows: allRows, counts: counts, scopedJobs: scopedJobs,
    exportChecks: exportChecks,
    _filter: F,
  };

  global.Views.company = {
    title: '公司背调',
    render: render,
    rows: rows,
  };
})(window);
