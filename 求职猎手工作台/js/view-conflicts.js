/* ==========================================================================
   view-conflicts.js · 模块：采集冲突待处理面板

   背景（S1 的收尾）：
     S1 落盘后，每次「同 url 二次采集」都会往 DB.conflicts 记一条差异
     （旧值 vs 新值，上限 500）。但**没有任何视图读它** ——
     数据一直在涨，用户打开工作台却看不到任何提示。
     等于把「静默丢弃」换成了「静默记录」，从用户视角问题依然没解决。

   本模块只做三件事：
     ① 给岗位库筛选栏提供一个入口徽章（有冲突才出现，N=0 时彻底隐藏）
     ② 打开面板，逐条列 岗位 / 字段 / 旧值 → 新值
     ③ 「采纳新值」「整条忽略」「全部忽略」三个出口

   ⛔ 三条本项目铁律（务必保留）：
     1. 弹窗回调先落值再关窗 + settled 守卫
     2. close() 的 onClose 用 setTimeout(fn, 0)
     3. 弹窗内只就地重画，**禁** App.refresh()
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  /* ------------------------------------------------------------------ *
   * 一、数据侧：把原始冲突记录整理成「可渲染」的形状
   * ------------------------------------------------------------------ */

  /**
   * 只保留「岗位还在库」的冲突。
   *
   * ⛔ 为什么必须过滤：用户删了岗位，冲突记录不会自动跟着走
   *    （conflicts 里只存了 jobId 字符串）。不过滤的话点「采纳」会
   *    updateJob 一个不存在的 id → 返回 null 静默失败，用户看到的是
   *    「点了没反应」，比不显示还糟。
   */
  function aliveConflicts() {
    var alive = {};
    (Store.jobs({ includeArchived: true }) || []).forEach(function (j) { alive[j.id] = 1; });
    return (Store.conflicts() || []).filter(function (c) { return alive[c.jobId]; });
  }

  /** 岗位 id → 岗位对象（一次性建表，避免每条冲突都线性扫一遍 jobs） */
  function jobMap() {
    var m = {};
    (Store.jobs({ includeArchived: true }) || []).forEach(function (j) { m[j.id] = j; });
    return m;
  }

  /** 界面上显示的条目数（= 有冲突且岗位还活着的条数） */
  function pendingCount() { return aliveConflicts().length; }

  /* ------------------------------------------------------------------ *
   * 二、入口徽章：挂在岗位库筛选栏
   * ------------------------------------------------------------------ */

  /**
   * 返回一个 chip 节点；没有待处理冲突时返回 null（调用方负责不 append）。
   *
   * 为什么做成 null 而不是「显示 0」：这个徽章是"待办"性质，
   * 常态下应该消失。挂一个「⚖ 冲突 0」在那儿只会变成噪音。
   */
  function entryChip(onOpen) {
    var n = pendingCount();
    if (!n) return null;
    return el('span', {
      class: 'tag warn', 'data-cf-entry': '1',
      style: 'cursor:pointer',
      title: '同 URL 二次采集时，有 ' + n + ' 个岗位出现了字段差异（旧值已保留，新值被记录）。点开逐条处理。',
      html: '⚖ 冲突 ' + n,
      onclick: function () { (onOpen || open)(); },
    });
  }

  /* ------------------------------------------------------------------ *
   * 三、字段值的人话化
   * ------------------------------------------------------------------ */

  /**
   * 把字段值渲染成短字符串。
   *
   * ⛔ rawJD 这一项的旧值/新值在 recordConflicts 里被写成了
   *    「（420 字）」这种人话（有意为之：不做全文比对，只给长度信号），
   *    所以这里不能再按数字去格式化 —— 统一 String() 即可。
   *    数字类字段（salaryMin/Max）补个 K 单位让它可读。
   */
  function fmtVal(key, v) {
    if (v === null || v === undefined || v === '') return '（空）';
    if ((key === 'salaryMin' || key === 'salaryMax') && typeof v === 'number') return v + 'K';
    return String(v);
  }

  /* ------------------------------------------------------------------ *
   * 四、采纳：本功能**唯一会改数据**的动作
   * ------------------------------------------------------------------ */

  /**
   * 把某条冲突里的某个字段「采纳为新值」。
   *
   * ⛔⛔ 三个坑，每一条都是踩过的：
   *
   * 坑 A：必须走 Store.updateJob，不能 `job[key] = new`。
   *       updateJob 内部会过 normJob 做字段规范化；直接赋值绕过它。
   *
   * 坑 B：薪资字段必须**联动** salaryMin/salaryMax/salaryMonths。
   *       实测 normJob（js/store.js）对 salaryMin/Max 是 U.asNum(j.salaryMin)
   *       —— **不从 salaryText 反推**。所以只 patch salaryText 会得到
   *       「显示按 salaryText / 筛选按 salaryMin」两边打架的状态。
   *       正解：复用 Export.parseSalary（已处理日结/13薪/单位只写在后端点）。
   *
   * 坑 C：采纳动作本身**不能**再产生新冲突。
   *       updateJob 不经过 recordConflicts，所以走它天然安全；
   *       如果误用 addJob/addJobs，会「新值 vs 旧值」再比一次 → 死循环。
   *
   * 采纳完把该字段从冲突记录里摘掉（其余字段继续留着）。
   * 摘完一条不剩 → 整条冲突删掉。
   *
   * @return {Boolean} 是否真的改动了
   */
  function adoptField(jobId, fieldKey) {
    var cs = Store.conflicts() || [];
    var ci = -1;
    for (var i = 0; i < cs.length; i++) { if (cs[i].jobId === jobId) { ci = i; break; } }
    if (ci < 0) return false;
    var cf = cs[ci];

    var fi = -1;
    for (var k = 0; k < cf.fields.length; k++) { if (cf.fields[k].key === fieldKey) { fi = k; break; } }
    if (fi < 0) return false;
    var f = cf.fields[fi];

    /* ---- 组装补丁 ---- */
    var patch = {};

    if (fieldKey === 'rawJD') {
      // JD 文本的冲突记录里 old/new 只是「（N 字）」这种摘要，
      // **不含正文** —— 我们拿不到新 JD 的全文（recordConflicts 有意没存）。
      // 所以这里不能瞎 patch。返回 false 让调用方提示用户。
      return false;
    }

    if (fieldKey === 'salaryText') {
      // ⛔⛔ 薪资必须先算出来再落盘，绝不能"先改文本、解析失败就算了"。
      //      normJob 对 salaryMin/Max 是 U.asNum(j.salaryMin)，不从 salaryText 反推
      //      → 只改 salaryText 会留下「显示按文本、筛选按 min/max」的打架状态。
      //      解析不出来就整个拒绝（返回 false），而不是半采纳。
      // 全局名是 **Exporter**（不是 Export）—— 踩过一次：名字写错被 try/catch
      // 静默吞掉，测试才发现「min/max 是 null」。
      var r = null;
      try {
        if (global.Exporter && typeof global.Exporter.parseSalary === 'function') {
          r = global.Exporter.parseSalary(f.new);
        }
      } catch (e) { r = null; }
      if (!r || r.min === null || r.max === null) {
        // 解析不出端点（如日结 / 纯文字）→ 不允许采纳薪资，
        // 否则会出现「有薪资文本、没有 min/max」的半截状态。
        return false;
      }
      patch.salaryText = f.new;
      patch.salaryMin = r.min;
      patch.salaryMax = r.max;
      if (r.months !== null && r.months !== undefined) patch.salaryMonths = r.months;
    } else {
      patch[fieldKey] = f.new;
    }

    /* ---- 落盘（坑 A / 坑 C） ---- */
    var updated = Store.updateJob(jobId, patch);
    if (!updated) return false;

    /* ---- 摘字段 ---- */
    var cur = Store.conflicts() || [];
    var curIdx = -1;
    for (var m = 0; m < cur.length; m++) { if (cur[m].jobId === jobId) { curIdx = m; break; } }
    if (curIdx >= 0) {
      var cc = cur[curIdx];
      cc.fields = cc.fields.filter(function (x) { return x.key !== fieldKey; });
      if (!cc.fields.length) {
        // 最后一个字段也采纳完了 → 整条冲突没意义了，删掉
        Store.dismissConflict(cc.id);
      } else {
        // 还有别的字段待处理：就地改内存再落盘。
        // ⛔ 不能图省事去调 dismissConflict —— 那会把整条冲突删掉，
        //    剩下未处理的字段就跟着没了（用户以为处理完了，其实丢了几条）。
        Store.save();
      }
    }
    return true;
  }

  /* ------------------------------------------------------------------ *
   * 五、面板
   * ------------------------------------------------------------------ */

  /**
   * 打开「采集冲突」面板。
   *
   * ⛔ 弹窗三条铁律全在这一个函数里体现：
   *    · 只就地重画（paintBody），绝不出 App.refresh()
   *    · 关窗后的刷新走 onClose 的 setTimeout(..., 0)
   *    · footer 按钮的 onClick 是规格对象，不是 el() 的孩子
   */
  function open(afterChange) {
    var handle = U.openModal({
      title: '⚖ 采集冲突',
      size: 'wide',
      body: el('div'),   // 占位，下面 paintBody 会填
      footer: [],
      onClose: function () {
        // ⛔ 异步刷新：此刻弹窗刚被摘掉，同步调 refresh 会把还在关闭流程里的
        //    节点再动一次。放下一宏任务。
        setTimeout(function () { if (afterChange) afterChange(); }, 0);
      },
    });

    var body = handle.body;

    /** 就地重画面板内容（不碰外层弹窗、不碰页面） */
    function paintBody() {
      body.innerHTML = '';
      var list = aliveConflicts();
      var jm = jobMap();

      if (!list.length) {
        body.appendChild(Comp.empty('✅', '没有待处理的冲突',
          '采集到的字段与岗位库里已有的完全一致，或者你都已经处理完了。'));
        return;
      }

      var totalFields = 0;
      list.forEach(function (c) { totalFields += c.fields.length; });

      body.appendChild(el('div', { class: 'hint', style: 'margin-bottom:10px' }, [
        el('div', { html: '共 <b>' + list.length + '</b> 个岗位存在数据差异，合计 <b>' +
          totalFields + '</b> 处字段。' }),
        el('div', { class: 'fs12 muted', style: 'margin-top:4px',
          text: '这些差异出现在「同一个 URL 被再次采集」时。为避免静默覆盖，' +
            '库里仍然保留旧值，新值只是被记录下来 —— 你在这里决定采纳哪一个。' }),
      ]));

      list.forEach(function (c) {
        body.appendChild(conflictCard(c, jm[c.jobId], paintBody));
      });
    }

    /* --- footer 用 [] 建出 .mfoot 容器，再自己塞按钮（要拿到 close） --- */
    var mfoot = handle.modal.querySelector('.mfoot');
    if (mfoot) {
      var btnAll = el('button', {
        class: 'btn ghost danger', text: '🗑 全部忽略',
        title: '把所有待处理冲突一次性丢弃（不可撤销）',
        onclick: function () {
          var n = pendingCount();
          if (!n) { U.toast('已经没有待处理的冲突了'); return; }
          U.confirm('确定要忽略全部 <b>' + n + '</b> 个岗位的冲突记录吗？<br>' +
            '<span class="fs12 muted">岗位数据不会变，只是不再提示这些差异。此操作不可撤销。</span>',
            { title: '全部忽略冲突', okText: '全部忽略', danger: true }
          ).then(function (yes) {
            if (!yes) return;
            var k = Store.clearConflicts();
            U.toast('已忽略 ' + k + ' 条冲突记录');
            paintBody();
            if (afterChange) setTimeout(afterChange, 0);
          });
        },
      });
      var btnClose = el('button', {
        class: 'btn pri', text: '关闭',
        onclick: function () { handle.close(); },
      });
      mfoot.appendChild(btnAll);
      mfoot.appendChild(btnClose);
    }

    paintBody();
    return handle;
  }

  /**
   * 单个岗位的冲突卡：标题 + 逐字段行 + 「整条忽略」。
   */
  function conflictCard(c, job, repaint) {
    var title = job ? (job.title || '(无岗位名)') : '(岗位已删除)';
    var company = job ? (job.company || '') : '';

    var card = el('div', { class: 'card', 'data-cf-job': c.jobId, style: 'margin-bottom:10px' }, [
      el('div', { class: 'body tight' }, [
        el('div', { class: 'row' }, [
          el('b', { class: 'fs13', text: title }),
          company ? el('span', { class: 'muted fs12', text: ' · ' + company }) : null,
          el('span', { class: 'sp' }),
          el('span', { class: 'fs11 muted', text: '来源：' + (c.source || '未知') }),
          el('button', {
            class: 'btn xs ghost', text: '整条忽略',
            title: '丢弃这个岗位的全部冲突记录（岗位数据不变）',
            onclick: function () {
              Store.dismissConflict(c.id);
              U.toast('已忽略该岗位的冲突');
              repaint();
            },
          }),
        ].filter(Boolean)),
        el('div', { style: 'margin-top:8px' }, c.fields.map(function (f) {
          return fieldRow(c, f, repaint);
        })),
      ]),
    ]);
    return card;
  }

  /** 一行字段：名称 + 旧值 → 新值 + [采纳] */
  function fieldRow(c, f, repaint) {
    // JD 文本拿不到全文（记录里只有字数摘要）→ 不给「采纳」，只做提示
    var isJd = (f.key === 'rawJD');
    var canAdopt = !isJd;

    var row = el('div', { class: 'row', 'data-cf-field': f.key,
      style: 'gap:8px;padding:5px 0;border-top:1px solid rgba(128,128,128,.15);flex-wrap:wrap' }, [
      el('span', { class: 'fs12 muted', style: 'min-width:64px', text: f.label || f.key }),
      el('span', { class: 'fs12', style: 'opacity:.65;text-decoration:line-through', text: fmtVal(f.key, f.old) }),
      el('span', { class: 'fs12 muted', text: '→' }),
      el('span', { class: 'fs12', style: 'color:#e0b050;font-weight:600', text: fmtVal(f.key, f.new) }),
      el('span', { class: 'sp' }),
    ]);

    if (canAdopt) {
      row.appendChild(el('button', {
        class: 'btn xs pri', text: '采纳',
        title: '把岗位的这个字段更新为新值',
        onclick: function (ev) {
          var okDone = adoptField(c.jobId, f.key);
          if (!okDone) { U.toast('这条冲突已失效（岗位可能已被删除）'); repaint(); return; }
          U.toast('已采纳：' + (f.label || f.key));
          repaint();
        },
      }));
    } else {
      row.appendChild(el('span', {
        class: 'fs11 muted', style: 'max-width:220px',
        text: 'JD 只记录了字数变化，正文未留存 —— 需重新采集该岗位',
      }));
    }

    return row;
  }

  /* ==================== 对外 ==================== */
  global.Views.conflicts = {
    open: open,
    entryChip: entryChip,
    pendingCount: pendingCount,
    aliveConflicts: aliveConflicts,
    adoptField: adoptField,
    // 测试钩子：直接渲染真节点查结构，不要自己复刻
    _conflictCard: conflictCard,
    _fieldRow: fieldRow,
    _fmtVal: fmtVal,
  };
})(window);
