/* ==========================================================================
   view-dashboard.js · 模块 7：数据仪表盘
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    App.topActions([
      el('button', { class: 'btn pri', html: '⤓ 导出全量 Excel', onclick: function () {
        Exporter.exportExcel();
        U.toast('已导出（含岗位库 / 投递 / 面试 / 各维度分布，多个工作表）', 'ok', 5500);
      } }),
      el('button', { class: 'btn', html: '⤓ 导出 JSON 备份', onclick: function () { Exporter.exportJSONFlow(); } }),
    ]);

    var st = Store.stats();

    if (st.jobTotal === 0 && st.appTotal === 0) {
      wrap.appendChild(Comp.empty('📊', '还没有数据可以统计',
        '先去岗位库导入几个岗位，或者到设置页一键载入示例数据看看效果。',
        '去岗位库导入', function () { App.go('jobs'); }));
      return;
    }

    /* ---------- 核心指标 ---------- */
    var kpi = el('div', { class: 'grid g4' });
    [
      // 这里曾经误用 st.jobTotal，导致「收藏岗位」显示的是岗位总数。
      // 口径说明也一并写进描述里（收藏不含已归档），免得用户收藏了却看到 0 一脸问号。
      { k: '收藏岗位', v: st.jobFavorite, c: 'c-brand', icon: '⭐',
        d: '收藏 ' + st.jobFavorite + ' / 在库 ' + st.jobTotal + ' 个（已归档 ' + st.jobArchived + ' 个不计入）',
        pctv: st.jobTotal ? U.pct(st.jobFavorite, st.jobTotal) : 0 },
      { k: '已投递', v: st.appliedTotal, d: '投递率 ' + U.pct(st.appliedTotal, st.jobTotal) + '%（投递 / 在库岗位）', c: 'c-info', icon: '📤',
        pctv: U.pct(st.appliedTotal, st.jobTotal) },
      { k: '面试场次', v: st.interviewTotal, d: '待进行 ' + st.interviewUpcoming + ' 场', c: 'c-purple', icon: '🎙️',
        pctv: U.pct(st.funnel[2].n, st.appliedTotal) },
      { k: 'Offer', v: st.offerTotal, d: 'Offer 转化率 ' + st.offerRate + '%', c: 'c-ok', icon: '🎉',
        pctv: st.offerRate },
    ].forEach(function (s) {
      kpi.appendChild(el('div', { class: 'stat ' + s.c }, [
        el('div', { class: 'k', html: s.icon + ' ' + s.k }),
        el('div', { class: 'v', text: s.v }),
        el('div', { class: 'd', text: s.d }),
        el('div', { class: 'bar' }, [el('i', { style: 'width:' + U.clamp(s.pctv, 0, 100) + '%' })]),
      ]));
    });
    wrap.appendChild(kpi);

    /* ---------- 转化率小结 ---------- */
    wrap.appendChild(el('div', { class: 'grid g4' }, [
      miniStat('简历被查看率', st.viewRate + '%', st.funnel[1].n + ' / ' + st.funnel[0].n + ' 次投递'),
      miniStat('面试邀约率', st.inviteRate + '%', st.funnel[2].n + ' / ' + st.funnel[0].n + ' 次投递'),
      miniStat('面试到场率', st.interviewRate + '%', st.funnel[3].n + ' / ' + st.funnel[2].n + ' 次邀约'),
      miniStat('Offer 转化率', st.offerRate + '%', st.funnel[4].n + ' / ' + st.funnel[0].n + ' 次投递'),
    ]));

    /* ---------- 投递归因（回复率 + 归因，§五-8）----------
       「HR 有没有回你」是求职最该盯的指标之一。这里把回复率按岗位属性切片，
       用户能直接看出「哪类岗位更愿意回我」，据此调整投递方向 —— 纯本地数据，零采集。 */
    if (st.appliedTotal > 0) {
      var rp = Store.replyStats();
      var repCard = el('div', { class: 'card' });
      repCard.appendChild(el('header', {}, [
        el('h3', { text: '💬 投递回复率 · 归因' }),
        el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '回复 = HR 查看过你（含邀约/面试）。样本不足的维度不显示。' }),
      ]));
      var repBody = el('div', { class: 'body stack' });

      // 回复率 KPI 一行
      repBody.appendChild(el('div', { class: 'grid g3' }, [
        miniStat('回复率', rp.replyRate + '%', rp.repliedTotal + ' / ' + rp.appliedTotal + ' 次投递被查看'),
        miniStat('深度回复率', rp.deepReplyRate + '%', rp.deepRepliedTotal + ' 次进入邀约/面试'),
        miniStat('石沉大海', rp.silentTotal + ' 条',
          rp.silentOver7d ? '其中 ' + rp.silentOver7d + ' 条超 7 天没动静，可考虑主动问或换方向' : '暂无超 7 天没动静的'),
      ]));

      // 各维度归因：每维一张「回复率对比」横条（n>=2 才显示）
      var dims = [
        { label: '按行业', data: rp.byIndustry },
        { label: '按薪资档', data: rp.bySalary },
        { label: '按公司规模', data: rp.byScale },
        { label: '按渠道', data: rp.byChannel },
        { label: '按 AI 匹配分', data: rp.byFit },
      ].filter(function (d) { return d.data && d.data.length >= 2; });

      if (dims.length) {
        var repGrid = el('div', { class: 'grid g2' });
        dims.forEach(function (dim) {
          // 横条宽度 = 回复率 %；name 里带上「回复率% · 回复/投递」，数值一眼看懂。
          var bars = dim.data.map(function (d) {
            return { name: d.name + '（' + d.rate + '% · ' + d.replied + '/' + d.n + '）', n: d.rate };
          });
          repGrid.appendChild(el('div', { class: 'card' }, [
            el('header', {}, [el('h4', { text: dim.label + ' 回复率' }), el('span', { class: 'sp' }),
              el('span', { class: 'hint tiny', text: '横条 = 回复率 %，括号 = 回复 / 投递数' })]),
            el('div', { class: 'body' }, [
              el('div', { html: Charts.bars(bars, { limit: 8 }) }),
            ]),
          ]));
        });
        repBody.appendChild(repGrid);
      } else {
        repBody.appendChild(el('div', { class: 'muted fs13', text:
          '再多投几份、更新一下投递状态，就能看出「哪类岗位更愿意回你」了。' }));
      }
      repCard.appendChild(repBody);
      wrap.appendChild(repCard);
    }

    /* ---------- 行 1：漏斗 + 状态分布 ---------- */
    var r1 = el('div', { class: 'grid', style: 'grid-template-columns:minmax(0,1.1fr) minmax(0,1fr);gap:14px' });

    r1.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '求职漏斗' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '每层数字 = 达到过这一步的投递数' })]),
      el('div', { class: 'body' }, [
        Charts.funnel(st.funnel, {
          footNote: st.appliedTotal ? '从投递到 Offer，你目前的整体转化率是 <b>' + st.offerRate + '%</b>。' +
            (st.viewRate < 30 && st.appliedTotal >= 5 ? ' 被查看率偏低，可以在打招呼话术和简历标题上再优化。' : '') : '',
        }),
      ]),
    ]));

    var statusData = Store.STATUSES.map(function (s, i) {
      return { name: s.name, n: st.byStatus[s.id] || 0, color: s.color || Charts.color(i) };
    }).filter(function (d) { return d.n > 0; });
    r1.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '投递状态分布' })]),
      el('div', { class: 'body' }, [
        statusData.length
          ? el('div', { class: 'row', style: 'gap:20px;align-items:center;justify-content:center' }, [
            el('div', { class: 'chart-wrap' }, [el('div', { html: Charts.donut(statusData, { centerSub: '条投递' }) })]),
            el('div', { class: 'flex1', style: 'max-width:260px' }, [el('div', { html: Charts.legend(statusData) })]),
          ])
          : el('div', { class: 'muted fs13', text: '还没有投递记录。' }),
      ]),
    ]));
    wrap.appendChild(r1);

    /* ---------- 行 2：行业 + 薪资 ---------- */
    var r2 = el('div', { class: 'grid g2' });
    r2.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '岗位行业分布' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: st.industryDist.length + ' 个行业' })]),
      el('div', { class: 'body' }, [
        st.industryDist.length ? el('div', { html: Charts.bars(st.industryDist, { limit: 8 }) })
          : el('div', { class: 'muted fs13', text: '岗位还没填行业。AI 解析岗位时会自动补上。' }),
      ]),
    ]));
    r2.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '薪资区间分布' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '按岗位薪资下限归档' })]),
      el('div', { class: 'body' }, [
        el('div', { html: Charts.bars(st.salaryDist.filter(function (d) { return d.n > 0; }), { limit: 8 }) }),
      ]),
    ]));
    wrap.appendChild(r2);

    /* ---------- 行 3：投递趋势 + 渠道 ---------- */
    var r3 = el('div', { class: 'grid g2' });

    // 近 8 周投递量
    var weeks = [], labels = [];
    var now = new Date();
    for (var w = 7; w >= 0; w--) {
      var end = new Date(now.getTime() - w * 7 * 86400000);
      var start = new Date(end.getTime() - 7 * 86400000);
      labels.push(U.d2(start).slice(5) + ' 周');
      weeks.push(Store.applications().filter(function (a) {
        var t = a.appliedAt || a.createdAt;
        return t > start.getTime() && t <= end.getTime() + 86400000;
      }).length);
    }
    r3.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '近 8 周投递量' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '共 ' + U.sum(weeks) + ' 次' })]),
      el('div', { class: 'body' }, [
        el('div', { html: Charts.sparkline(weeks, { labels: labels, height: 72 }) }),
        el('div', { class: 'row fs11 muted', style: 'justify-content:space-between;margin-top:4px' },
          labels.map(function (l) { return el('span', { text: l.replace(' 周', '') }); })),
      ]),
    ]));

    var chData = Object.keys(st.byChannel).map(function (k, i) {
      return { name: k, n: st.byChannel[k], color: Charts.color(i) };
    }).sort(function (a, b) { return b.n - a.n; });
    r3.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '投递渠道' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: chData.length + ' 个渠道' })]),
      el('div', { class: 'body' }, [
        chData.length ? el('div', { html: Charts.bars(chData, { limit: 8 }) })
          : el('div', { class: 'muted fs13', text: '暂无投递渠道数据。' }),
      ]),
    ]));
    wrap.appendChild(r3);

    /* ---------- 行 4：近期动态 ---------- */
    var acts = buildActivity();
    wrap.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '近期动态' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '最近 12 条' })]),
      el('div', {}, acts.length ? acts : [el('div', { class: 'body muted fs13', text: '暂无动态。' })]),
    ]));

    /* ---------- 行 5：待办 ---------- */
    var todos = buildTodos();
    if (todos.length) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('header', {}, [el('h3', { text: '⚡ 值得处理的事' }), el('span', { class: 'sp' }),
          el('span', { class: 'hint tiny', text: todos.length + ' 件' })]),
        el('div', {}, todos),
      ]));
    }
  }

  function miniStat(k, v, d) {
    return el('div', { class: 'stat' }, [
      el('div', { class: 'k', text: k }),
      el('div', { class: 'v', style: 'font-size:21px', text: v }),
      el('div', { class: 'd', text: d }),
    ]);
  }

  function buildActivity() {
    var items = [];
    Store.applications().forEach(function (a) {
      (a.timeline || []).forEach(function (t) {
        var j = Store.job(a.jobId) || {};
        items.push({ at: t.at, type: 'app', text: (j.title || '岗位') + ' → ' + Store.statusName(t.status) + (t.note ? '（' + t.note + '）' : ''), jobId: a.jobId });
      });
    });
    Store.interviews().forEach(function (v) {
      var j = Store.job(v.jobId) || {};
      items.push({ at: v.createdAt, type: 'itv', text: '新建面试：' + (j.title || '') + ' · ' + v.round, jobId: v.jobId });
    });
    Store.jobs().forEach(function (j) {
      items.push({ at: j.createdAt, type: 'job', text: '导入岗位：' + (j.title || '') + '（' + (j.company || '') + '）', jobId: j.id });
    });
    return items.sort(function (a, b) { return b.at - a.at; }).slice(0, 12).map(function (x) {
      var icons = { app: '📤', itv: '🎙️', job: '🗂️' };
      return el('div', {
        class: 'li pointer', style: 'cursor:pointer',
        onclick: function () { if (x.type === 'job') Views.jobs.detail(x.jobId); else App.go(x.type === 'itv' ? 'interview' : 'kanban'); },
      }, [
        el('span', { text: icons[x.type] }),
        el('div', { class: 'li-main' }, [
          el('div', { class: 'li-t', text: x.text }),
        ]),
        el('span', { class: 'muted fs11', text: U.rel(x.at) }),
      ]);
    });
  }

  function buildTodos() {
    var out = [];
    var st = Store.stats();

    // 高匹配但没投
    var highNoApp = Store.jobs().filter(function (j) {
      return j.aiVerdict && j.aiVerdict.score >= 75 && !Store.appOfJob(j.id);
    });
    if (highNoApp.length) {
      out.push(todoRow('🎯', '有 ' + highNoApp.length + ' 个高匹配岗位还没投',
        highNoApp.slice(0, 3).map(function (j) { return j.title + '（' + j.aiVerdict.score + ' 分）'; }).join('、'),
        '去投递', function () { Views.jobs.filters.sort = 'score'; App.go('jobs'); }));
    }

    // 待定时间的面试
    var noTime = Store.interviews().filter(function (v) { return v.status === 'scheduled' && !v.at; });
    if (noTime.length) {
      out.push(todoRow('🎙️', '有 ' + noTime.length + ' 场面试还没填时间',
        '填上时间才能收到提醒', '去填', function () { App.go('interview'); }));
    }

    // 面试完了没复盘
    var needReview = Store.interviews().filter(function (v) {
      return v.at && v.at < U.now() && v.status !== 'canceled' && !v.review;
    });
    if (needReview.length) {
      out.push(todoRow('📝', '有 ' + needReview.length + ' 场面试还没复盘',
        '趁记忆还新，让 AI 帮你整理一下', '去复盘', function () { App.go('interview'); }));
    }

    // 长期停在已投递
    var stale = Store.applications().filter(function (a) {
      return a.status === 'applied' && a.appliedAt && (U.now() - a.appliedAt) > 7 * 86400000;
    });
    if (stale.length) {
      out.push(todoRow('⏳', '有 ' + stale.length + ' 条投递超过 7 天没动静',
        '可以主动问一下 HR，或者把精力挪到别处', '看看是哪些', function () { App.go('kanban'); }));
    }

    // 没做匹配评估
    if (st.jobTotal >= 3 && st.resumeTotal && !Store.jobs().some(function (j) { return j.aiVerdict; })) {
      out.push(todoRow('🎯', '还没对任何岗位做过匹配评估',
        '评估一遍，投递顺序会清晰很多', '去做评估', function () { App.go('resume'); }));
    }

    return out;
  }

  function todoRow(icon, title, sub, action, fn) {
    return el('div', { class: 'li' }, [
      el('span', { class: 'fs15', text: icon }),
      el('div', { class: 'li-main' }, [
        el('div', { class: 'li-t', text: title }),
        el('div', { class: 'li-s' }, [el('span', { text: sub })]),
      ]),
      el('div', { class: 'li-act' }, [el('button', { class: 'btn sm', text: action, onclick: fn })]),
    ]);
  }

  global.Views.dashboard = {
    title: '数据仪表盘',
    render: render,
  };
})(window);
