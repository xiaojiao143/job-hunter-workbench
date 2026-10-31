/* ==========================================================================
   view-followup.js · 模块 9：待跟进（跟进提醒 / 待办聚合）
   --------------------------------------------------------------------------
   求职最贵的成本不是"没投"，是"投完忘了、收藏了没投、面完没复盘"。
   这一页把散落在岗位库 / 看板 / 面试里的「该动一下」聚到一处：
     投递后 N 天没动静 · 收藏超 N 天没投 · 高匹配没投 · 面试快到了还没备面
     面完没复盘 · offer 拿到没决定 · 等结果太久 · 面试时间没填
   每条都给出「下一个动作」，并且可以「稍后提醒」把噪音压下去。
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  var DEFAULT_DAYS = { appliedDays: 5, invitedDays: 3, favoriteDays: 7, waitingDays: 7, offerDays: 5 };

  /** 类别定义（顺序 = 页面展示顺序 = 紧急程度） */
  var CATS = [
    { id: 'interviewSoon', icon: '🎙️', name: '面试快到了', cls: 'bad', tip: '先把备面材料过一遍，别裸考' },
    { id: 'interviewNoTime', icon: '🕐', name: '面试时间还没填', cls: 'warn', tip: '填了时间才会有提前提醒' },
    { id: 'staleApplied', icon: '⏳', name: '投递后没动静', cls: 'warn', tip: '主动问一句，或者把精力挪到别处' },
    { id: 'invitedNoInterview', icon: '📮', name: '邀约了还没约上面试', cls: 'warn', tip: '尽快回消息定时间，拖久了名额会变' },
    { id: 'waitingTooLong', icon: '⌛', name: '等结果太久', cls: 'warn', tip: '可以直接问 HR 大概什么时候有结果' },
    { id: 'interviewNoReview', icon: '📝', name: '面完还没复盘', cls: 'purple', tip: '趁记忆还新，让 AI 整理一下' },
    { id: 'highMatchNoApp', icon: '🎯', name: '高匹配还没投', cls: 'brand', tip: '匹配分高的先投，别让好岗位排队' },
    { id: 'favNotApplied', icon: '⭐', name: '收藏了还没投', cls: 'info', tip: '收藏超过一周还没投，多半就是不想投了' },
    { id: 'offerPending', icon: '🎉', name: '拿到 offer 还没决定', cls: 'ok', tip: '用「岗位对比」比一比，或者直接谈' },
  ];
  var CAT_MAP = {};
  CATS.forEach(function (c) { CAT_MAP[c.id] = c; });

  function days() {
    return Object.assign({}, DEFAULT_DAYS, Store.settings().followUp || {});
  }
  function dayDiff(ts) { return ts ? Math.floor((U.now() - ts) / 86400000) : 0; }

  /* ==================== 核心：把待跟进项算出来 ==================== */
  /**
   * 返回 [{cat, key, title, sub, meta, jobId, appId, interviewId, days, act}]
   * act 是「建议的下一步动作」的文字 + 处理函数名，页面据此渲染按钮。
   */
  function build() {
    var d = days();
    var now = U.now();
    var out = [];

    function add(item) {
      if (!item || !CAT_MAP[item.cat]) return;
      if (Store.isSnoozed(item.key)) return;
      out.push(item);
    }

    /* --- 投递侧 --- */
    Store.applications().forEach(function (a) {
      var j = Store.job(a.jobId);
      if (!j || j.archived) return;
      var base = a.appliedAt || a.createdAt || now;
      var since = dayDiff(base);
      var head = (j.title || '岗位') + '　' + (j.company || '');

      if (a.status === 'applied' && since >= d.appliedDays) {
        add({
          cat: 'staleApplied', key: 'staleApplied:' + a.id, jobId: j.id, appId: a.id,
          title: head, days: since,
          sub: '已投 ' + since + ' 天，状态还停在「已投递」，一直没被查看',
          act: '催一下进度',
        });
      } else if (a.status === 'viewed' && since >= d.invitedDays) {
        add({
          cat: 'staleApplied', key: 'staleApplied:' + a.id, jobId: j.id, appId: a.id,
          title: head, days: since,
          sub: '被查看后 ' + since + ' 天没有下文，可以主动问一句',
          act: '问一句',
        });
      } else if (a.status === 'invited') {
        // 邀约了，但没有一场未定/待进行的面试 = 还没约上
        var has = Store.interviews({ jobId: j.id }).some(function (v) { return v.status === 'scheduled'; });
        if (!has) {
          add({
            cat: 'invitedNoInterview', key: 'invited:' + a.id, jobId: j.id, appId: a.id,
            title: head, days: since,
            sub: '对方已发出面试邀约，但你还没安排具体时间',
            act: '安排面试',
          });
        }
      } else if (a.status === 'waiting' && since >= d.waitingDays) {
        add({
          cat: 'waitingTooLong', key: 'waiting:' + a.id, jobId: j.id, appId: a.id,
          title: head, days: since,
          sub: '面试结束 ' + since + ' 天还在等结果，可以礼貌地问一下',
          act: '问结果',
        });
      } else if (a.status === 'offer' && since >= d.offerDays) {
        add({
          cat: 'offerPending', key: 'offer:' + a.id, jobId: j.id, appId: a.id,
          title: head, days: since,
          sub: 'offer 到手 ' + since + ' 天了，该决定或该谈了',
          act: '做决定',
        });
      }
    });

    /* --- 岗位侧：没投的 --- */
    Store.jobs().forEach(function (j) {
      if (j.archived) return;
      if (Store.appOfJob(j.id)) return;

      // 这条岗位上有更急的事（面试），就别再催"该投了"
      var v = j.aiVerdict || {};
      if (v.score >= 75) {
        add({
          cat: 'highMatchNoApp', key: 'highMatch:' + j.id, jobId: j.id,
          title: (j.title || '岗位') + '　' + (j.company || ''), days: dayDiff(j.createdAt),
          sub: '匹配分 ' + v.score + '，是手上分数最高的一批，但还没投',
          act: '去投递',
        });
      } else if (j.favorite && dayDiff(j.createdAt) >= d.favoriteDays) {
        add({
          cat: 'favNotApplied', key: 'fav:' + j.id, jobId: j.id,
          title: (j.title || '岗位') + '　' + (j.company || ''), days: dayDiff(j.createdAt),
          sub: '收藏了 ' + dayDiff(j.createdAt) + ' 天还没投 —— 要么投，要么取消收藏放它走',
          act: '去投递',
        });
      }
    });

    /* --- 面试侧 --- */
    Store.interviews().forEach(function (v) {
      var j = Store.job(v.jobId);
      if (!j) return;
      var head = (j.title || '岗位') + '　' + (j.company || '');

      if (v.status === 'scheduled' && v.at && v.at > now && (v.at - now) <= 2 * 86400000) {
        add({
          cat: 'interviewSoon', key: 'soon:' + v.id, jobId: j.id, interviewId: v.id,
          title: head, days: 0,
          sub: U.d2t(v.at) + ' · ' + v.round + '（' + U.untilText(v.at) + '）' +
            (v.prep ? '' : '　⚠️ 还没生成备面材料'),
          act: v.prep ? '过一遍备面' : '生成备面材料',
        });
      } else if (v.status === 'scheduled' && !v.at) {
        add({
          cat: 'interviewNoTime', key: 'notime:' + v.id, jobId: j.id, interviewId: v.id,
          title: head, days: dayDiff(v.createdAt),
          sub: '这场「' + v.round + '」还没填时间，填了才能收到提前提醒',
          act: '填时间',
        });
      } else if (v.status !== 'canceled' && v.at && v.at < now && !v.review) {
        add({
          cat: 'interviewNoReview', key: 'noreview:' + v.id, jobId: j.id, interviewId: v.id,
          title: head, days: dayDiff(v.at),
          sub: '「' + v.round + '」结束 ' + dayDiff(v.at) + ' 天了还没复盘，趁记忆还新写点',
          act: '去复盘',
        });
      }
    });

    // 越久没处理越靠前，同级内按时间倒序
    out.sort(function (a, b) {
      var ca = CATS.findIndex(function (c) { return c.id === a.cat; });
      var cb = CATS.findIndex(function (c) { return c.id === b.cat; });
      if (ca !== cb) return ca - cb;
      return b.days - a.days;
    });
    return out;
  }

  function count() {
    try { return build().length; } catch (e) { return 0; }
  }

  /**
   * 岗位的「最该跟进」分数，给岗位库的排序用。
   * 与 build() 同口径，避免"待跟进页说该跟、岗位库排序却排最后"这种自相矛盾。
   */
  function scoreJob(j) {
    if (!j || j.archived) return 0;
    var d = days(), now = U.now();
    var a = Store.appOfJob(j.id);
    var s = 0;
    if (a) {
      var since = dayDiff(a.appliedAt || a.createdAt || now);
      if (a.status === 'applied' && since >= d.appliedDays) s = Math.max(s, 70 + Math.min(since, 30));
      else if (a.status === 'viewed' && since >= d.invitedDays) s = Math.max(s, 55);
      else if (a.status === 'invited') s = Math.max(s, 65);
      else if (a.status === 'waiting' && since >= d.waitingDays) s = Math.max(s, 60);
      else if (a.status === 'offer') s = Math.max(s, 75);
    } else {
      var v = j.aiVerdict || {};
      if (v.score >= 75) s = Math.max(s, 80);
      if (j.favorite && dayDiff(j.createdAt) >= d.favoriteDays) s = Math.max(s, 45);
    }
    return s;
  }

  /* ==================== 页面 ==================== */
  var VIEW = { only: '' };   // 只看某一类

  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    App.topActions([
      el('button', { class: 'btn pri', html: '🤖 生成跟进话术', title: '挑一个岗位，让 AI 写一条催进度的话', onclick: function () {
        Comp.jobPicker({ title: '给哪个岗位写跟进话术？' }).then(function (id) {
          if (id) runFollowAI(id, null, function () { App.refresh(); });
        });
      } }),
      el('button', { class: 'btn', html: '⚙ 提醒阈值', onclick: openThresholds }),
      el('button', { class: 'btn', html: '😴 全部稍后 3 天', title: '清空当前列表，3 天后再提醒（不会删数据）', onclick: function () {
        var list = build();
        if (!list.length) { U.toast('现在没有待跟进的事', 'info'); return; }
        list.forEach(function (x) { Store.snooze(x.key, 3); });
        U.toast('已把 ' + list.length + ' 件事推到 3 天后再提醒', 'ok');
        App.updateNavCounts();
        App.refresh();
      } }),
    ]);

    var items = build();

    /* --- 顶部摘要 --- */
    var soon = items.filter(function (x) { return x.cat === 'interviewSoon' || x.cat === 'interviewNoTime'; }).length;
    var stale = items.filter(function (x) { return x.cat === 'staleApplied' || x.cat === 'waitingTooLong' || x.cat === 'invitedNoInterview'; }).length;
    var notApplied = items.filter(function (x) { return x.cat === 'favNotApplied' || x.cat === 'highMatchNoApp'; }).length;

    wrap.appendChild(el('div', { class: 'grid g4' }, [
      { k: '待跟进', v: items.length, d: '要不要今天处理一下？', c: items.length ? 'c-brand' : 'c-ok', icon: '⏰' },
      { k: '面试相关', v: soon, d: soon ? '时间最近，先看这些' : '暂时没有急事', c: soon ? 'c-warn' : '', icon: '🎙️' },
      { k: '投递后没动静', v: stale, d: stale ? '主动问一句往往有用' : '都还在正常节奏里', c: stale ? 'c-info' : '', icon: '⏳' },
      { k: '该投还没投', v: notApplied, d: notApplied ? '匹配高的优先' : '手上的岗位都投了', c: notApplied ? 'c-purple' : '', icon: '🎯' },
    ].map(function (s) {
      return el('div', { class: 'stat ' + (s.c || '') }, [
        el('div', { class: 'k', html: s.icon + ' ' + s.k }),
        el('div', { class: 'v', text: s.v }),
        el('div', { class: 'd', text: s.d }),
      ]);
    })));

    if (!items.length) {
      wrap.appendChild(Comp.empty('🎉', '暂时没有需要跟进的事',
        '投递、收藏、面试的节奏都在正常范围内。<br>' +
        '想让它更严一点，可以点右上角「⚙ 提醒阈值」把天数调小。<br>' +
        '<span class="fs12">（被「稍后提醒」压下去的条目到点会自动回来）</span>',
        '去岗位库逛逛', function () { App.go('jobs'); }));
      return;
    }

    /* --- 分类快捷筛选 --- */
    var used = CATS.filter(function (c) { return items.some(function (x) { return x.cat === c.id; }); });
    var seg = el('div', { class: 'chips' });
    seg.appendChild(el('span', { class: 'muted fs12', text: '只看：' }));
    seg.appendChild(el('span', {
      class: 'tag ' + (VIEW.only ? 'line' : 'brand'), style: 'cursor:pointer', text: '全部 ' + items.length,
      onclick: function () { VIEW.only = ''; App.refresh(); },
    }));
    used.forEach(function (c) {
      var n = items.filter(function (x) { return x.cat === c.id; }).length;
      seg.appendChild(el('span', {
        class: 'tag ' + (VIEW.only === c.id ? 'brand' : 'line'), style: 'cursor:pointer',
        text: c.icon + ' ' + c.name + ' ' + n,
        onclick: function () { VIEW.only = VIEW.only === c.id ? '' : c.id; App.refresh(); },
      }));
    });
    wrap.appendChild(el('div', { class: 'row' }, [seg]));

    /* --- 分组列表 --- */
    var list = VIEW.only ? items.filter(function (x) { return x.cat === VIEW.only; }) : items;
    var shown = {};
    list.forEach(function (x) { (shown[x.cat] = shown[x.cat] || []).push(x); });

    CATS.forEach(function (c) {
      if (!shown[c.id]) return;
      var card = el('div', { class: 'card' });
      card.appendChild(el('header', {}, [
        el('h3', { html: c.icon + ' ' + c.name }),
        el('span', { class: 'tag ' + (c.cls || ''), text: String(shown[c.id].length) + ' 件' }),
        el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: c.tip }),
      ]));
      var body = el('div', {});
      shown[c.id].forEach(function (x) { body.appendChild(row(x)); });
      card.appendChild(body);
      wrap.appendChild(card);
    });
  }

  function row(x) {
    var c = CAT_MAP[x.cat];
    return el('div', { class: 'li' }, [
      el('span', { class: 'fs15', text: c.icon }),
      el('div', { class: 'li-main' }, [
        el('div', { class: 'li-t' }, [
          el('span', { text: x.title }),
          x.days ? el('span', { class: 'tag ' + (c.cls || ''), text: x.days + ' 天' }) : null,
        ].filter(Boolean)),
        el('div', { class: 'li-s' }, [el('span', { text: x.sub })]),
      ]),
      el('div', { class: 'li-act' }, actions(x)),
    ]);
  }

  /* ==================== 删除（第 30 轮补）====================
     ⛔ 之前这一页**没有任何删除入口** —— 提醒能看、能改状态、能稍后，
        但没法把已经不想管的那条彻底处理掉。
     ⛔ 但不能无脑给「删岗位」：提醒有 9 类，来源分三种 ——
        有的背后是**投递记录**、有的是**面试记录**、有的**只有岗位本身**
        （「高匹配还没投」「收藏了还没投」是从岗位推出来的，压根没有"记录"）。
        所以按来源分开处理，别让用户以为点一下能删掉岗位。
     ================================================================= */

  /** 这条提醒背后有没有「可删的记录」。没有（只有岗位）返回 null。 */
  function deletableOf(x) {
    if (x.interviewId) return { kind: 'interviews', id: x.interviewId, what: '这场面试记录' };
    if (x.appId) return { kind: 'applications', id: x.appId, what: '这条投递记录' };
    return null;
  }

  /** 删掉这条提醒背后的记录。**先确认、再给撤销**（双保险）。 */
  function removeUnderlying(x, d) {
    var j = Store.job(x.jobId) || {};
    var name = [j.company, j.title].filter(Boolean).join(' · ') || '这条记录';
    U.confirm(
      '删除 <b>' + U.esc(name) + '</b> 的' + d.what + '？<br>' +
      (x.sub ? '<span class="muted fs12">' + U.esc(x.sub) + '</span><br>' : '') +
      '<span class="muted fs12">岗位本身不受影响；删完还会给一次「撤销」机会。</span>',
      { title: '删除' + d.what, danger: true, okText: '删除' }
    ).then(function (go) {
      if (!go) return;
      var spec = {};
      spec[d.kind] = [d.id];
      var snap = Store.takeOut(spec);
      App.updateNavCounts();
      Comp.trashToast('已删除' + d.what, snap, function () { App.refresh(); });
      /* ⛔ 不能在确认框回调里**直接** App.refresh()：
         U.confirm 是「先 resolve、再关窗」（见 utils.js confirmBox），
         这时弹窗还挂在 DOM 上，整页重建会把它换掉 → 关闭流程踩空。
         等这一帧过去（弹窗已关）再整页重画。 */
      setTimeout(function () { App.refresh(); }, 0);
    });
  }

  /** 每条给的「下一个动作」——不给动作的提醒就是噪音 */
  function actions(x) {
    var out = [];

    if (x.cat === 'interviewSoon') {
      out.push(el('button', {
        class: 'btn xs pri', text: x.act,
        onclick: function () {
          var iv = Store.interview(x.interviewId);
          if (iv && iv.prep) AIInterview.openPrep(iv.id);
          else AIInterview.prepFor(x.jobId, { interviewId: x.interviewId, onSaved: function () { App.updateNavCounts(); App.refresh(); } });
        },
      }));
    } else if (x.cat === 'interviewNoTime') {
      out.push(el('button', {
        class: 'btn xs pri', text: '填时间',
        onclick: function () { AIInterview.openForm(x.interviewId, null, App.refresh); },
      }));
    } else if (x.cat === 'interviewNoReview') {
      out.push(el('button', {
        class: 'btn xs pri', text: '去复盘',
        onclick: function () { AIInterview.openForm(x.interviewId, null, App.refresh); },
      }));
    } else if (x.cat === 'invitedNoInterview') {
      out.push(el('button', {
        class: 'btn xs pri', text: '安排面试',
        onclick: function () { AIInterview.openForm(null, { jobId: x.jobId }, App.refresh); },
      }));
    } else if (x.cat === 'offerPending') {
      out.push(el('button', {
        class: 'btn xs pri', text: '去对比', onclick: function () { Compare.add(x.jobId); },
      }));
      out.push(el('button', { class: 'btn xs', text: '记录决定', onclick: function () { Views.jobs.changeStatus(x.appId, App.refresh); } }));
    } else if (x.cat === 'favNotApplied' || x.cat === 'highMatchNoApp') {
      out.push(el('button', {
        class: 'btn xs pri', text: '加入看板',
        onclick: function () {
          Store.addApplication({ jobId: x.jobId, status: 'todo' });
          U.toast('已加入投递看板（待投递）', 'ok');
          App.updateNavCounts(); App.refresh();
        },
      }));
    } else {
      // 投递/等结果类：改状态 + 问一句
      out.push(el('button', {
        class: 'btn xs pri', text: '生成跟进话术',
        onclick: function () { runFollowAI(x.jobId, x.appId, App.refresh); },
      }));
      out.push(el('button', { class: 'btn xs', text: '改状态', onclick: function () { Views.jobs.changeStatus(x.appId, App.refresh); } }));
    }

    out.push(el('button', { class: 'btn xs ghost', text: '详情', title: '打开岗位详情', onclick: function () { Views.jobs.detail(x.jobId); } }));
    out.push(el('button', {
      class: 'btn xs ghost', text: '😴', title: '稍后提醒（3 天）',
      onclick: function () {
        Store.snooze(x.key, 3);
        U.toast('好的，3 天后再提醒你', 'ok', 3000);
        App.updateNavCounts(); App.refresh();
      },
    }));
    /* 删除（见上面 deletableOf 的说明：按来源区别对待，不给"删岗位"这种误导选项） */
    var d = deletableOf(x);
    if (d) {
      out.push(el('button', {
        class: 'btn xs danger', text: '🗑 删除',
        title: '删除' + d.what + '（先确认；删错了还能撤销）',
        onclick: function () { removeUnderlying(x, d); },
      }));
    } else {
      out.push(el('button', {
        class: 'btn xs ghost', text: '🚫 不再提醒',
        title: '这条提醒是从岗位本身推出来的，没有单独的记录可删 —— 点了就不再提醒你',
        onclick: function () {
          Store.snooze(x.key, 36500);            // ≈永久：100 年
          U.toast('好，这条不再提醒你了（岗位还在）', 'ok', 3500);
          App.updateNavCounts(); App.refresh();
        },
      }));
    }
    return out;
  }

  /* ==================== AI 跟进话术 ==================== */
  /**
   * 「投了 3 天没回音」这个场景最需要的是**一句话**，不是一篇小作文。
   * 生成后直接给复制按钮，自己粘到 BOSS 聊天框 —— 本工作台不代发消息。
   */
  function runFollowAI(jobId, appId, after) {
    var j = Store.job(jobId);
    if (!j) { U.toast('岗位不存在', 'warn'); return; }
    var a = appId ? Store.application(appId) : Store.appOfJob(jobId);
    var since = a ? dayDiff(a.appliedAt || a.createdAt) : dayDiff(j.createdAt);
    var stage = a ? Store.statusName(a.status) : '还没投递';

    Comp.runAI({
      title: 'AI 跟进话术 · ' + (j.title || ''),
      tpl: 'followup',
      size: 'wide',
      applyLabel: '存到岗位笔记',
      input: {
        job: AI.jobToText(j),
        stage: stage,
        days: String(since),
        hr: (a && a.hrSummary) ? a.hrSummary : '',
        note: j.note || '',
      },
      onApply: function (data, raw) {
        var text = String(raw || data || '').trim();
        if (!text) return;
        var old = j.note || '';
        Store.updateJob(jobId, { note: (old ? old + '\n\n' : '') + '【' + U.d2(U.now()) + ' 跟进话术】\n' + text });
        U.copyText(text).then(function (ok) {
          U.toast(ok ? '已存到岗位笔记，并复制到剪贴板 ✅ 自己粘到 BOSS 聊天框发送' : '已存到岗位笔记', 'ok', 6000);
        });
        if (after) after();
      },
    });
  }

  /* ==================== 阈值设置 ==================== */
  function openThresholds() {
    var d = days();
    var f = Comp.fields([
      { key: 'appliedDays', label: '投递后多少天算「没动静」', type: 'number', value: d.appliedDays, hint: '默认 5 天。互联网岗位节奏快，可以调到 3' },
      { key: 'invitedDays', label: '被查看后多少天算「没下文」', type: 'number', value: d.invitedDays, hint: '默认 3 天' },
      { key: 'favoriteDays', label: '收藏多少天还没投就提醒', type: 'number', value: d.favoriteDays, hint: '默认 7 天' },
      { key: 'waitingDays', label: '面试后等结果多少天算久', type: 'number', value: d.waitingDays, hint: '默认 7 天' },
      { key: 'offerDays', label: 'offer 到手多少天还没决定就提醒', type: 'number', value: d.offerDays, hint: '默认 5 天' },
    ], 2);

    U.openModal({
      title: '待跟进提醒阈值',
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'note line fs12', html: '行业不同、"多久算凉了"差别很大，所以这里让你自己定。改完立刻生效。' }),
        f.node,
      ]),
      footer: [
        { text: '保存', cls: 'pri', onClick: function (c) {
          var v = f.values();
          var patch = {};
          Object.keys(DEFAULT_DAYS).forEach(function (k) {
            var n = U.asNum(v[k]);
            patch[k] = (n === null || n < 1) ? DEFAULT_DAYS[k] : Math.round(n);
          });
          Store.setSetting('followUp', patch);
          U.toast('阈值已更新', 'ok');
          c();
          App.updateNavCounts();
          App.refresh();
        } },
        { text: '恢复默认', onClick: function (c) {
          Store.setSetting('followUp', Object.assign({}, DEFAULT_DAYS));
          U.toast('已恢复默认（5 / 3 / 7 / 7 / 5 天）', 'ok');
          c(); App.refresh();
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  global.FollowUp = {
    build: build, count: count, scoreJob: scoreJob,
    runFollowAI: runFollowAI, openThresholds: openThresholds,
    DAYS: DEFAULT_DAYS, CATS: CATS,
  };

  global.Views.followup = {
    title: '待跟进',
    render: render,
    items: build,
    filters: VIEW,
  };
})(window);
