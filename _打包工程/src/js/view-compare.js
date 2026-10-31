/* ==========================================================================
   view-compare.js · 模块 6：岗位对比（2-5 个岗位横向对比 + AI 结论）
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;
  var KEY = 'jh.compare.basket';

  var basket = (function () {
    try { return JSON.parse(localStorage.getItem(KEY) || '[]') || []; } catch (e) { return []; }
  })();

  function persist() {
    try { localStorage.setItem(KEY, JSON.stringify(basket)); } catch (e) { /* noop */ }
  }

  function add(jobId) {
    var j = Store.job(jobId);
    if (!j) return;
    if (basket.indexOf(jobId) >= 0) { U.toast('已经在对比篮里了', 'info'); App.go('compare'); return; }
    if (basket.length >= 5) { U.toast('最多同时对比 5 个岗位，请先移除一个', 'warn'); return; }
    basket.push(jobId); persist();
    U.toast('已加入对比（共 ' + basket.length + ' 个）', 'ok');
    App.go('compare');
  }

  function remove(jobId) {
    basket = basket.filter(function (x) { return x !== jobId; });
    persist();
  }

  /* ==================== 对比维度 ====================
     ⚠️ 福利相关的四项（规模 / 福利 / 假期 / 五险一金）**复用 job-score.js 的 welfareOf**，
        不在这里再写一套正则 —— 两套口径早晚会不一致，而"同一个岗位在打分页和对比页
        说法不同"是最伤信任的一种 bug。

     ⚠️ 没有采集到福利数据的岗位一律返回 **-1** 而不是缺失：这样"有数据 vs 没数据"
        在表里能被比出来（有双休的会亮绿底），不然整行都没法标最优。 */
  function WS() { return global.JobScorer; }
  function welfareOf(j) {
    if (!WS()) {
      return { has: false, raw: '', items: [], softs: [], level: 0,
        rest: { key: '', rank: null, text: '—' }, insurance: { key: '', text: '—' } };
    }
    return WS().welfareOf(j);
  }

  function dims() {
    return [
      { k: 'salary', label: '薪资', w: 1.2, get: function (j) {
        var t = j.salaryText || '面议';
        if (j.salaryMonths) t += '（' + j.salaryMonths + ' 薪）';
        var y = estYear(j);
        return { text: t, sub: y ? '≈ 年包 ' + y + ' 万' : '', score: (j.salaryMax || j.salaryMin || 0) };
      } },

      /* --- 公司规模 --- */
      { k: 'scale', label: '公司规模', get: function (j) {
        var s = (j.scale || '').trim();
        if (!s) {
          return { text: '未写明',
            sub: j.companyInfo ? U.truncate(j.companyInfo, 46) : '列表页多半不带，做详情补抓后才有' };
        }
        return { text: s, sub: (WS() ? WS().scaleLabel(s) : '') };
      } },

      /* --- 公司福利 --- */
      { k: 'welfare', label: '公司福利', get: function (j) {
        var w = welfareOf(j);
        if (!w.has) {
          return { text: '没采到福利标签',
            sub: 'BOSS 列表页通常不带福利，做详情补抓后才看得到', score: -1 };
        }
        return {
          text: w.items.length ? w.items.join('、') : '（福利串里拆不出逐项）',
          sub: '共 ' + w.items.length + ' 项' +
            (w.softs.length ? '（含' + w.softs.join('/') + '这类软福利，不算加分项）' : ''),
          score: w.items.length,
        };
      } },

      /* --- 假期 / 休息：用户最在意的"有没有双休"就在这儿 --- */
      { k: 'holiday', label: '假期 / 休息', get: function (j) {
        var w = welfareOf(j);
        var bits = [w.rest.text];
        if (w.legal) bits.push('法定节假日');
        if (w.annual) bits.push('带薪年假');
        var sub = '';
        if (w.rest.rank === null) sub = '福利没采到，休息制度无从判断';
        else if (w.rest.rank >= 3) sub = '双休，作息最稳';
        else if (w.rest.rank === 2) sub = '大小周（隔周单休），强度偏高';
        else if (w.rest.rank === 1) sub = '单休 / 轮休，强度偏高';
        else sub = '没写休息制度 —— 面试时一定要问';
        return { text: bits.join(' · '), sub: sub, score: w.rest.rank === null ? -1 : w.rest.rank };
      } },

      /* --- 五险一金 --- */
      { k: 'insurance', label: '五险一金', get: function (j) {
        var w = welfareOf(j);
        var rank = { '五险一金': 3, '公积金': 2, '五险': 1 }[w.insurance.key];
        return {
          text: w.insurance.text,
          sub: w.insurance.key === '五险' ? '少了公积金 —— 按城市自己确认是不是强制' : '',
          score: rank === undefined ? (w.has ? 0 : -1) : rank,
        };
      } },

      /* --- 作息 / 加班 --- */
      { k: 'hours', label: '作息 / 加班', get: function (j) {
        var w = welfareOf(j);
        if (!w.has) return { text: '没采到', score: -1 };
        var t = [];
        if (/弹性|灵活|不打卡/.test(w.raw)) t.push('弹性工作');
        if (/不加班/.test(w.raw)) t.push('明确写了不加班');
        if (/加班补助|加班费|加班补贴/.test(w.raw)) t.push('加班有补助');
        if (!t.length) return { text: '未提及', sub: '「没写」不等于「不加班」，面试时问清楚', score: 0 };
        return { text: t.join(' · '), score: 1 };
      } },

      { k: 'location', label: '地点 / 通勤', get: function (j) {
        var t = (j.location || '未填') + (j.district ? ' · ' + j.district : '') + (j.remote ? ' · 远程' : '');
        return { text: t, sub: j.address || '', score: j.remote ? 2 : 1 };
      } },
      { k: 'company', label: '公司与行业', get: function (j) {
        return { text: j.company || '未填', sub: j.industry || '', score: 0 };
      } },
      { k: 'req', label: '硬性要求', get: function (j) {
        return { text: [j.reqDegree, j.reqYears].filter(Boolean).join(' / ') || '未写明',
          sub: (j.reqSkills || []).slice(0, 6).join('、') };
      } },
      { k: 'pros', label: '岗位优势', get: function (j) {
        return { text: (j.pros || []).join('；') || '—', score: (j.pros || []).length };
      } },
      { k: 'risks', label: '风险点', get: function (j) {
        return { text: (j.risks || []).join('；') || '无已识别风险', score: -(j.risks || []).length };
      } },
      { k: 'match', label: '匹配度', get: function (j) {
        var v = j.aiVerdict || {};
        var s = v.score;
        return { text: s ? s + ' 分' : '未评估', sub: v.verdict || '', score: s || 0, raw: true };
      } },
      { k: 'progress', label: '面试进度', get: function (j) {
        var a = Store.appOfJob(j.id);
        if (!a) return { text: '未投递', score: -1 };
        var ivs = Store.interviews({ jobId: j.id });
        var done = ivs.filter(function (v) { return v.status === 'done'; }).length;
        return {
          text: Store.statusName(a.status) + (a.outcome === 'self' ? '（我拒）' : a.outcome === 'company' ? '（公司拒）' : ''),
          sub: ivs.length ? ('共 ' + ivs.length + ' 场面试，已完成 ' + done + ' 场') : '',
          score: Store.reachedIndex(a),
        };
      } },
      { k: 'onboard', label: '预计入职时间', edit: true, get: function (j) {
        var a = Store.appOfJob(j.id);
        var t = a && a.onboardEstimate;
        return { text: t || '未知', score: 0 };
      } },
      { k: 'tags', label: '标签', get: function (j) {
        return { text: (j.tags || []).join('、') || '—' };
      } },
      { k: 'source', label: '来源 / 录入', get: function (j) {
        return { text: (j.source === 'boss' ? 'BOSS 导入' : '手动新增'), sub: U.d2(j.createdAt) };
      } },
    ];
  }

  function estYear(j) {
    var hi = j.salaryMax, lo = j.salaryMin;
    if (hi === null && lo === null) return null;
    var base = hi !== null ? hi : lo;
    var m = j.salaryMonths || 12;
    return (Math.round(base * m / 10) / 10).toFixed(1);
  }

  /* 头部卡片的「合适度」徽标 —— 和岗位库同一份分（走 Views.jobs.fitOf，不重算）。 */
  function fitBadgeOf(j) {
    var ft = null;
    try {
      if (global.Views && global.Views.jobs && global.Views.jobs.fitOf) ft = global.Views.jobs.fitOf(j);
      else if (global.JobScorer) ft = global.JobScorer.score(j);
    } catch (e) { ft = null; }
    if (!ft) return null;
    if (ft.gate && ft.gate.drop) {
      return el('span', { class: 'tag bad', text: '合适度：剔除', title: ft.gate.reason });
    }
    return el('span', { class: 'fbadge ' + ft.level.cls,
      title: ft.reason, text: '合适度 ' + ft.level.key + ' · ' + ft.total });
  }

  /* ==================== 渲染 ==================== */
  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    App.topActions([
      el('button', { class: 'btn pri', html: '＋ 添加岗位到对比', onclick: pickAdd }),
      el('button', {
        class: 'btn', html: '🤖 AI 给对比结论',
        onclick: function () { aiCompare(); },
        title: '让模型横向看完给出推荐排序',
      }),
      el('button', {
        class: 'btn', html: '⤓ 导出对比表',
        onclick: function () { exportTable(); },
      }),
    ]);

    var note = Comp.aiReadyNote();
    if (note) wrap.appendChild(note);

    // 清理失效 id
    basket = basket.filter(function (id) { return !!Store.job(id); });
    persist();

    if (basket.length < 2) {
      wrap.appendChild(el('div', { class: 'note info' }, [
        el('span', { class: 'ico', text: '⚖️' }),
        el('div', { html: '选 <b>2-5 个</b>岗位就能横向对比薪资、风险、匹配度和面试进度。' +
          '你可以在岗位库里点「加入对比」，也可以直接点下面的按钮挑。' }),
      ]));
      wrap.appendChild(Comp.empty('⚖️', '对比篮里还不到 2 个岗位',
        '至少选两个才有对比的意义。', '＋ 挑岗位加入对比', pickAdd));
      return;
    }

    var jobs = basket.map(function (id) { return Store.job(id); }).filter(Boolean);
    var D = dims();

    /* --- 头部卡 --- */
    var headCard = el('div', { class: 'card' });
    var headBody = el('div', { class: 'body tight' });
    var headRow = el('div', { class: 'row', style: 'gap:9px;align-items:stretch' });
    // 左侧留白对齐行标签列
    headRow.appendChild(el('div', { style: 'width:118px;flex:none' }));
    jobs.forEach(function (j) {
      var v = j.aiVerdict || {};
      headRow.appendChild(el('div', { class: 'box', style: 'flex:1;min-width:170px;position:relative' }, [
        el('button', {
          class: 'btn xs ghost', text: '✕', title: '从对比中移除',
          style: 'position:absolute;top:6px;right:6px',
          onclick: function () { remove(j.id); App.refresh(); },
        }),
        el('div', { class: 'fw6 fs13', text: j.title || '(未命名)' }),
        el('div', { class: 'fs12 muted', text: j.company || '' }),
        el('div', { class: 'row mt8', style: 'gap:5px;flex-wrap:wrap' }, [
          fitBadgeOf(j),
          v.score ? el('span', { class: 'tag ' + (v.score >= 80 ? 'ok' : v.score >= 70 ? 'info' : 'warn'), text: '匹配 ' + v.score }) : null,
          j.favorite ? el('span', { class: 'tag', text: '⭐ 收藏' }) : null,
          el('span', { class: 'sp' }),
          el('button', { class: 'btn xs', text: '详情', onclick: function () { Views.jobs.detail(j.id); } }),
        ].filter(Boolean)),
      ]));
    });
    headBody.appendChild(headRow);
    headCard.appendChild(headBody);
    wrap.appendChild(headCard);

    /* --- 对比表 --- */
    var table = el('table', { class: 'tb' });
    var thead = el('thead', {}, [el('tr', {}, [el('th', { text: '对比维度', style: 'min-width:112px' })]
      .concat(jobs.map(function (j) { return el('th', { text: U.truncate(j.title || '', 14) }); })))]);

    var tbody = el('tbody');
    D.forEach(function (d) {
      var vals = jobs.map(function (j) { return d.get(j) || {}; });
      var best = null;
      if (vals.every(function (x) { return typeof x.score === 'number'; })) {
        var max = Math.max.apply(null, vals.map(function (x) { return x.score; }));
        var min = Math.min.apply(null, vals.map(function (x) { return x.score; }));
        best = (d.k === 'risks') ? min : max;
      }
      var tr = el('tr', {}, [el('td', { class: 'fw6 t2', text: d.label })]);
      vals.forEach(function (x) {
        var isBest = best !== null && typeof x.score === 'number' && x.score === best && vals.length > 1 &&
          vals.filter(function (y) { return y.score === best; }).length < vals.length;
        var td = el('td', { style: isBest ? 'background:var(--ok-soft)' : '' });
        if (d.edit) {
          var inp = el('input', { type: 'text', placeholder: '如：面试后 2 周 / 随时', style: 'font-size:12px' });
          inp.value = x.text === '未知' ? '' : (x.text || '');
          inp.addEventListener('blur', function () {
            var a = Store.appOfJob(jobs[vals.indexOf(x)].id) || Store.addApplication({ jobId: jobs[vals.indexOf(x)].id, status: 'todo' });
            if (a) { a.onboardEstimate = inp.value.trim(); Store.save(); }
          });
          td.appendChild(inp);
        } else {
          td.appendChild(el('div', { class: 'fs13', html: (isBest ? '🏆 ' : '') + U.esc(x.text) }));
          if (x.sub) td.appendChild(el('div', { class: 'fs12 muted mt4', text: x.sub }));
        }
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(thead);
    table.appendChild(tbody);
    wrap.appendChild(el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '横向对比表' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '绿底 = 该维度更优（只是参考，最终看你自己在意什么）。公司规模不标优 —— 规模大不等于更适合你' })]),
      el('div', { class: 'tb-wrap', style: 'max-height:60vh' }, [table]),
    ]));

    /* --- AI 结论 --- */
    var saved = Store.chats({ kind: 'compare' })[0];
    if (saved && saved.messages.length) {
      var last = saved.messages[saved.messages.length - 1];
      wrap.appendChild(el('div', { class: 'card' }, [
        el('header', {}, [
          el('h3', { text: '🤖 AI 对比结论' }),
          el('span', { class: 'sp' }),
          el('span', { class: 'hint tiny', text: U.d2t(last.at) }),
          Comp.copyBtn(last.content, '复制'),
          el('button', { class: 'btn xs', text: '重新生成', onclick: function () { aiCompare(true); } }),
        ]),
        el('div', { class: 'body' }, [el('div', { class: 'typer', html: App.md(last.content) })]),
      ]));
    }
  }

  function pickAdd() {
    Comp.jobPicker({
      title: '选择要对比的岗位（可多选，最多 5 个）',
      multiple: true,
      exclude: basket,
    }).then(function (ids) {
      if (!ids || !ids.length) return;
      ids.forEach(function (id) {
        if (basket.length < 5 && basket.indexOf(id) < 0) basket.push(id);
      });
      persist();
      App.refresh();
    });
  }

  function exportTable() {
    var jobs = basket.map(function (id) { return Store.job(id); }).filter(Boolean);
    if (jobs.length < 2) { U.toast('至少选 2 个岗位', 'warn'); return; }
    var D = dims();
    var headers = [{ key: 'dim', label: '对比维度', width: 130 }]
      .concat(jobs.map(function (j) { return { key: 'j_' + j.id, label: j.title || '岗位', width: 220 }; }));
    var rows = D.map(function (d) {
      var o = { dim: d.label };
      jobs.forEach(function (j) {
        var v = d.get(j);
        o['j_' + j.id] = v.text + (v.sub ? '（' + v.sub + '）' : '');
      });
      return o;
    });
    Exporter.downloadExcel('岗位对比_' + Exporter.stamp() + '.xls', [
      { name: '岗位对比', headers: headers, rows: rows },
    ]);
  }

  /* ==================== AI 对比 ==================== */
  function aiCompare(isRerun) {
    var jobs = basket.map(function (id) { return Store.job(id); }).filter(Boolean);
    if (jobs.length < 2) { U.toast('至少选 2 个岗位才能对比', 'warn'); return; }
    if (!AI.ready()) { U.toast('还没配置模型 API，请先到设置页填 Key。', 'warn'); App.go('settings'); return; }

    var text = jobs.map(function (j, i) {
      var a = Store.appOfJob(j.id);
      return '【岗位 ' + (i + 1) + '】\n' + AI.jobToText(j) +
        '\n当前投递状态：' + (a ? Store.statusName(a.status) : '未投递') +
        (j.aiVerdict && j.aiVerdict.score ? '\n简历匹配分：' + j.aiVerdict.score + '（' + (j.aiVerdict.verdict || '') + '）' : '');
    }).join('\n\n');

    var prefs = Store.settings().prefs || {};
    var prefText = [];
    if (prefs.cities && prefs.cities.length) prefText.push('倾向城市：' + prefs.cities.join('、'));
    if (prefs.salaryMin !== null && prefs.salaryMin !== undefined) prefText.push('薪资底线：' + prefs.salaryMin + 'K');
    if (prefs.dealBreakers && prefs.dealBreakers.length) prefText.push('不能接受：' + prefs.dealBreakers.join('、'));
    /* 口径字段也喂进去 —— 「我 2 年经验、大专、想看新媒体运营」会让"哪个更适合我"
       这一票投得准得多，之前只给了城市和薪资。 */
    if (prefs.myYears !== null && prefs.myYears !== undefined) prefText.push('我的工作年限：' + prefs.myYears + ' 年');
    if (prefs.myDegree) prefText.push('我的最高学历：' + prefs.myDegree);
    if (prefs.focusKeywords && prefs.focusKeywords.length) prefText.push('求职方向关键词：' + prefs.focusKeywords.join('、'));
    if (prefs.expectJobs && prefs.expectJobs.length) prefText.push('期望岗位：' + prefs.expectJobs.join('、'));

    Comp.runAI({
      title: 'AI 岗位对比结论',
      tpl: 'compare',
      size: 'wide',
      input: { jobs: text, pref: prefText.join('；') },
      applyLabel: '保存结论',
      onApply: function (data, raw) {
        var c = Store.chats({ kind: 'compare' })[0] || Store.addChat({ kind: 'compare', title: '岗位对比结论' });
        Store.pushMessage(c.id, 'user', '对比这几个岗位：' + jobs.map(function (j) { return j.title; }).join(' / '));
        Store.pushMessage(c.id, 'assistant', raw || data);
        U.toast('对比结论已保存 ✅', 'ok');
        App.refresh();
      },
    });
    void isRerun;
  }

  global.Compare = { add: add, remove: remove, basket: function () { return basket.slice(); } };

  global.Views.compare = {
    title: '岗位对比',
    render: render,
    pickAdd: pickAdd,
    aiCompare: aiCompare,
    dims: dims,
  };
})(window);
