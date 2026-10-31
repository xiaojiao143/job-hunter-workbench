/* ==========================================================================
   view-interview.js · 模块 3：面试管理
   面试录入 / AI 备面材料 / 浏览器提醒 / 现场笔记 / 复盘
   同时对外暴露 AIInterview（岗位库、看板都会调）
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;
  var F = { show: 'upcoming' };   // upcoming | past | all

  /* ==================== 主页面 ==================== */
  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    /* ⛔ 备面材料的入口原来**只在每一行末尾**（`btn xs`，11px 字，贴在密集行尾），
       整页顶部工具栏只有「＋ 新建面试」和提醒开关 —— 扫视时根本看不见。
       现在把「最近一场的备面材料」提到页面顶部工具栏，做成主按钮：
         · 已有材料 → 直接打开查看（顶部条的「✏️ 编辑面试记录」就在那里）
         · 还没有   → 直接生成（生成完在 AI 弹窗**顶部**点「💾 保存到这场面试」）
       ⚠️ 这一条只做「跳转」，保存动作与数据结构一个字没改。 */
    var nextIv = Store.upcomingInterviews(1)[0] || Store.interviews().slice()
      .sort(function (a, b) { return (b.at || 0) - (a.at || 0); })[0] || null;

    App.topActions([
      el('button', {
        class: 'btn pri', html: '💾 备面材料',
        title: nextIv
          ? (nextIv.prep ? '打开最近这场已生成的备面材料' : '给最近这场生成一份备面材料（面试官备注 / 高频题 / 评价要点…）')
          : '还没有面试记录 —— 先点「＋ 新建面试」，或去岗位详情里点「备面材料」',
        onclick: function () {
          if (!nextIv) {
            U.toastHtml('还没有面试记录。先点「<b>＋ 新建面试</b>」，或回岗位库点某个岗位的「备面材料」。', 'warn', 5200);
            return;
          }
          if (nextIv.prep) openPrep(nextIv.id);
          else prepFor(nextIv.jobId, { interviewId: nextIv.id, onSaved: App.refresh });
        },
      }),
      el('button', { class: 'btn', html: '＋ 新建面试', onclick: function () { openForm(null); } }),
      el('button', {
        class: 'btn', html: Store.settings().notify ? '🔔 提醒已开' : '🔕 开启面试提醒',
        title: Store.settings().notify ? '面试提醒已开启；要关掉去「设置 → ③ 面试提醒」' : '需要浏览器通知权限',
        onclick: function () {
          // 已经开着的时候再点一次，要说清楚状态和关闭入口，别让用户以为按钮坏了
          if (Store.settings().notify) {
            U.toastHtml('面试提醒已经在工作了。要关掉的话去「<b>设置 → ③ 面试提醒</b>」取消勾选。', 'info', 6000);
            return;
          }
          App.askNotifyPermission();
        },
      }),
    ]);

    var note = Comp.aiReadyNote();
    if (note) wrap.appendChild(note);

    wrap.appendChild(buildReminderCard());

    // 分段
    var seg = el('div', { class: 'seg' });
    [['upcoming', '待进行'], ['past', '已结束'], ['all', '全部']].forEach(function (x) {
      seg.appendChild(el('button', {
        class: F.show === x[0] ? 'on' : '', text: x[1],
        onclick: function () { F.show = x[0]; App.refresh(); },
      }));
    });

    var listBox = el('div', {});
    wrap.appendChild(el('div', { class: 'row' }, [seg, el('span', { class: 'sp' }),
      el('span', { class: 'hint tiny', text: '提前 1 天 / 2 小时 / 30 分钟提醒（需保持本页打开）' })]));
    wrap.appendChild(listBox);

    function paint() {
      listBox.innerHTML = '';
      var all = Store.interviews().slice().sort(function (a, b) { return (b.at || 0) - (a.at || 0); });
      var now = U.now();
      var list = F.show === 'upcoming' ? all.filter(function (v) { return v.status === 'scheduled' && (!v.at || v.at > now); })
        : F.show === 'past' ? all.filter(function (v) { return v.status !== 'scheduled' || (v.at && v.at <= now); })
          : all;

      if (!list.length) {
        listBox.appendChild(Comp.empty('🎙️', F.show === 'upcoming' ? '没有待进行的面试' : '还没有面试记录',
          '收到面试邀约就记在这里，AI 帮你准备自我介绍、高频题和反问清单。',
          '＋ 新建面试', function () { openForm(null); }));
        return;
      }

      // 按日期分组
      var groups = {};
      list.forEach(function (v) {
        var k = v.at ? U.d2(v.at) : '未定时间';
        (groups[k] = groups[k] || []).push(v);
      });
      Object.keys(groups).sort(function (a, b) {
        if (a === '未定时间') return 1;
        if (b === '未定时间') return -1;
        return a < b ? 1 : -1;
      }).forEach(function (k) {
        var items = groups[k];
        var card = el('div', { class: 'card' });
        card.appendChild(el('header', {}, [
          el('h3', { text: k === '未定时间' ? k : k + '　' + U.weekLabel(U.fromLocalInput(k + 'T12:00')) }),
          el('span', { class: 'sp' }),
          el('span', { class: 'hint', text: items.length + ' 场' }),
        ]));
        var body = el('div', {});
        items.forEach(function (v) { body.appendChild(interviewRow(v, paint)); });
        card.appendChild(body);
        listBox.appendChild(card);
      });
    }
    paint();
  }

  /* ---------------- 提醒卡 ---------------- */
  function buildReminderCard() {
    var st = Store.stats();
    var up = Store.upcomingInterviews(3);
    var card = el('div', { class: 'card' });

    var head = el('header', {}, [
      el('h3', { text: '⏰ 最近的面试' }),
      el('span', { class: 'sp' }),
      Store.settings().notify
        ? el('span', { class: 'pill on' }, [el('span', { class: 'dt' }), '提醒已开启'])
        : el('span', { class: 'pill off' }, [el('span', { class: 'dt' }), '提醒未开启']),
    ]);
    card.appendChild(head);

    var body = el('div', { class: 'body tight' });
    if (!up.length) {
      body.appendChild(el('div', { class: 'muted fs13', text: '近期没有安排面试。' }));
    } else {
      var next = up[0];
      var j = Store.job(next.jobId) || {};
      var isToday = U.isSameDay(next.at, U.now());
      body.appendChild(el('div', { class: 'row', style: 'gap:12px;align-items:flex-start' }, [
        el('div', { class: 'stat', style: 'min-width:130px;padding:10px 13px' }, [
          el('div', { class: 'k', text: isToday ? '今天' : U.weekLabel(next.at) }),
          el('div', { class: 'v', style: 'font-size:20px', text: U.hm(next.at) }),
          el('div', { class: 'd', text: U.untilText(next.at) }),
        ]),
        el('div', { class: 'flex1' }, [
          el('div', { class: 'row' }, [
            el('b', { class: 'fs14', text: j.title || '(岗位)' }),
            el('span', { class: 'muted fs12', text: j.company || '' }),
          ]),
          el('div', { class: 'row fs12 muted mt4', style: 'gap:9px' }, [
            el('span', { text: next.round }),
            el('span', { text: next.mode === 'offline' ? '线下' : next.mode === 'phone' ? '电话' : '线上' }),
            next.interviewers ? el('span', { text: '面试官：' + next.interviewers }) : null,
          ].filter(Boolean)),
          next.mode === 'offline' && next.place ? el('div', { class: 'fs12 mt4', text: '📍 ' + next.place }) : null,
          next.mode !== 'offline' && next.link ? el('div', { class: 'fs12 mt4' }, [
            el('a', { href: next.link, target: '_blank', rel: 'noreferrer', text: '🔗 ' + next.link }),
          ]) : null,
          !next.prep ? el('div', { class: 'row mt8' }, [
            el('button', { class: 'btn pri sm', html: '🤖 生成备面材料', onclick: function () { prepFor(next.jobId, { interviewId: next.id, onSaved: App.refresh }); } }),
          ]) : el('div', { class: 'row mt8' }, [
            el('button', { class: 'btn sm', text: '查看备面材料', onclick: function () { openPrep(next.id); } }),
          ]),
        ]),
      ]));
      if (up.length > 1) {
        body.appendChild(el('div', { class: 'divider' }));
        body.appendChild(el('div', { class: 'fs12 muted', text: '接下来还有 ' + (up.length - 1) + ' 场：' +
          up.slice(1).map(function (v) { return U.d2t(v.at) + ' ' + ((Store.job(v.jobId) || {}).title || ''); }).join('；') }));
      }
    }
    return card;
  }

  /* ---------------- 面试行 ---------------- */
  function interviewRow(v, repaint) {
    var j = Store.job(v.jobId) || {};
    var stText = v.status === 'done' ? '已完成' : v.status === 'canceled' ? '已取消' : '待进行';
    var stCls = v.status === 'done' ? 'ok' : v.status === 'canceled' ? '' : 'brand';

    return el('div', { class: 'li' }, [
      el('div', { class: 'li-main' }, [
        el('div', { class: 'li-t' }, [
          el('span', { text: v.at ? U.hm(v.at) : '--:--' }),
          el('span', { class: 'tag ' + stCls, text: stText }),
          el('span', { class: 'tag', text: v.round }),
          el('span', { text: j.title || '(岗位已删除)' }),
          v.prep ? el('span', { class: 'tag ok', text: '已备面' }) : null,
          v.review ? el('span', { class: 'tag purple', text: '已复盘' }) : null,
        ].filter(Boolean)),
        el('div', { class: 'li-s' }, [
          el('span', { text: j.company || '' }),
          el('span', { text: v.mode === 'offline' ? '线下 · ' + (v.place || '未填地点') : v.mode === 'phone' ? '电话' : '线上' }),
          v.interviewers ? el('span', { text: '面试官：' + v.interviewers }) : null,
          v.result ? el('span', { class: v.result === 'pass' ? 'ok-c' : v.result === 'fail' ? 'bad-c' : '', text: '结果：' + resultText(v.result) }) : null,
        ].filter(Boolean)),
      ]),
      el('div', { class: 'li-act' }, [
        el('button', { class: 'btn xs', html: v.prep ? '备面' : '🤖 备面', onclick: function () { prepFor(v.jobId, { interviewId: v.id, onSaved: repaint }); } }),
        el('button', { class: 'btn xs', text: '编辑', onclick: function () { openForm(v.id, null, repaint); } }),
        /* 删除（第 30 轮补）——
           ⛔ 之前这里**没有任何删除入口**：面试记录建了就删不掉，
             而 Store.removeInterview / takeOut({interviews}) 其实早就支持了
             （数据层有、界面没接，典型的"漏了一半"）。
           交互按用户要求：**先确认、再给撤销**（双保险）。
           ⚠️ 项目其他删除位是「只给撤销不弹确认」（见 Comp.trashToast 的注释），
              这里是有意不一致 —— 面试记录是人工一场场填的，误删最恼人。 */
        el('button', {
          class: 'btn xs danger', text: '🗑 删除',
          title: '删除这条面试记录（先确认一次；删错了还能撤销）',
          onclick: function () {
            var what = [j.company, j.title].filter(Boolean).join(' · ') || '这条面试记录';
            var when = v.at ? U.d2(v.at) + ' ' + U.hm(v.at) : '未定时间';
            U.confirm(
              '删除 <b>' + U.esc(what) + '</b> 的这场面试？<br>' +
              '<span class="muted fs12">' + U.esc(when + ' · ' + v.round) + '</span><br>' +
              '<span class="muted fs12">岗位本身不受影响；删完还会给一次「撤销」机会。</span>',
              { title: '删除面试记录', danger: true, okText: '删除' }
            ).then(function (go) {
              if (!go) return;
              var snap = Store.takeOut({ interviews: [v.id] });
              App.updateNavCounts();
              if (repaint) repaint();                    // 就地重画：弹窗还开着，这条是允许的
              Comp.trashToast('已删除这场面试记录（' + when + '）', snap, function () { App.refresh(); });
              /* ⛔ 不能在确认框回调里**直接** App.refresh()：
                 U.confirm 是「先 resolve、再关窗」（见 utils.js confirmBox），
                 这时弹窗还挂在 DOM 上，整页重建会把它换掉 → 关闭流程踩空。
                 等这一帧过去（弹窗已关）再整页重画。 */
              setTimeout(function () { App.refresh(); }, 0);
            });
          },
        }),
      ]),
    ]);
  }

  function resultText(r) {
    return { pass: '通过', fail: '未通过', pending: '等结果', unknown: '未知' }[r] || r;
  }

  /* ==================== 面试表单 ==================== */
  function openForm(id, preset, after) {
    var v = id ? Store.interview(id) : null;
    preset = preset || {};
    var jobId = v ? v.jobId : preset.jobId;

    function build(jid) {
      var j = Store.job(jid) || {};
      var f = Comp.fields([
        { key: 'at', label: '面试时间', type: 'datetime-local', value: v && v.at ? U.toLocalInput(v.at) : (preset.at || '') },
        { key: 'round', label: '轮次', type: 'select', options: Store.ROUNDS, value: v ? v.round : '一面（技术/业务）' },
        { key: 'mode', label: '形式', type: 'select', options: Store.INTERVIEW_MODES.map(function (m) { return { value: m.id, label: m.name }; }), value: v ? v.mode : 'online' },
        { key: 'status', label: '状态', type: 'select', options: [{ value: 'scheduled', label: '待进行' }, { value: 'done', label: '已完成' }, { value: 'canceled', label: '已取消' }], value: v ? v.status : 'scheduled' },
        { key: 'link', label: '会议链接（线上）', placeholder: '腾讯会议 / 飞书链接', value: v ? v.link : '' },
        { key: 'place', label: '面试地点（线下）', placeholder: '详细地址', value: v ? v.place : '' },
        { key: 'interviewers', label: '面试官', placeholder: '如：运营负责人 + HR', value: v ? v.interviewers : '' },
        { key: 'result', label: '面试结果', type: 'select', options: [{ value: '', label: '未定' }, { value: 'pass', label: '通过' }, { value: 'fail', label: '未通过' }, { value: 'pending', label: '等结果' }], value: v ? v.result : '' },
      ], 2);
      var notesTa = el('textarea', { rows: 5, placeholder: '面试现场笔记：问了什么、你怎么答的、面试官的反应、你观察到什么…\n（写得越碎越好，之后 AI 能帮你整理成复盘）' });
      notesTa.value = v ? v.notes : '';
      var reviewTa = el('textarea', { rows: 4, placeholder: '复盘总结（也可以点下面按钮让 AI 帮你写）' });
      reviewTa.value = v ? v.review : '';

      return {
        node: el('div', { class: 'stack' }, [
          el('div', { class: 'box row' }, [
            el('b', { text: j.title || '(未选岗位)' }),
            el('span', { class: 'muted fs12', text: j.company || '' }),
            el('span', { class: 'sp' }),
            el('button', { class: 'btn xs', text: '换岗位', onclick: function () { pickJobAgain(); } }),
          ]),
          f.node,
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '面试记录 / 现场笔记' }), notesTa]),
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '复盘' }), reviewTa]),
          el('div', { class: 'row' }, [
            el('button', {
              class: 'btn sm', html: '🤖 让 AI 帮我写复盘',
              onclick: function () {
                aiReview({ jobId: jid, round: f.map.round.get(), notes: notesTa.value }, function (text) {
                  reviewTa.value = text;
                  U.toast('复盘已生成，记得点保存', 'ok');
                });
              },
            }),
            el('span', { class: 'hint tiny', text: '先写点笔记，AI 才能整理' }),
          ]),
        ]),
        values: function () { return f.values(); },
        notesTa: notesTa, reviewTa: reviewTa,
      };
    }

    var form = build(jobId);
    var modal = U.openModal({
      title: id ? '编辑面试' : '新建面试',
      size: 'wide',
      // 用闭包而不是直接传 guard.check：guard 在下面才赋值，
      // 直接传会在 openModal 构造期就求值（undefined.check）。
      beforeClose: function () { return guard.check(); },
      body: form.node,
      footer: [
        { text: '保存', cls: 'pri', onClick: function (c) { save(c); } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });

    // 面试笔记 / 复盘是长文本，误关一次损失最大
    var guard = U.dirtyGuard(function () {
      return [form.values(), form.notesTa.value, form.reviewTa.value];
    });
    guard.mark();     // 基线取「弹窗建好之后」，详见 U.dirtyGuard 注释

    function save(c) {
      var vals = form.values();
      var data = {
        jobId: currentJobId,
        at: vals.at ? U.fromLocalInput(vals.at) : null,
        round: vals.round, mode: vals.mode, status: vals.status,
        link: vals.link, place: vals.place, interviewers: vals.interviewers,
        result: vals.result,
        notes: form.notesTa.value, review: form.reviewTa.value,
      };
      if (id) { Store.updateInterview(id, data); U.toast('已保存 ✅', 'ok'); }
      else {
        var created = Store.addInterview(data);
        U.toast('面试已创建 ' + (data.at ? '（' + U.d2t(data.at) + '）' : '') + ' ✅', 'ok');
        void created;
      }
      App.updateNavCounts();
      if (c) c();
      if (after) after(); else App.refresh();
    }

    var currentJobId = jobId;

    function pickJobAgain() {
      Comp.jobPicker({ title: '选择面试对应的岗位' }).then(function (jid) {
        if (!jid) return;
        currentJobId = jid;
        var fresh = build(jid);
        form = fresh;
        modal.body.innerHTML = '';
        modal.body.appendChild(fresh.node);
        guard.mark();     // 换岗位 = 整张表单重建，基线得跟着重取，否则旧值会被当成「脏」
      });
    }

    if (!jobId) {
      // 没带岗位就先让用户选
      modal.body.innerHTML = '';
      modal.body.appendChild(el('div', { class: 'muted fs13', text: '请先选择这场面试对应的岗位…' }));
      Comp.jobPicker({ title: '选择面试对应的岗位' }).then(function (jid) {
        if (!jid) { modal.close(); return; }
        currentJobId = jid;
        var fresh = build(jid);
        form = fresh;
        modal.body.innerHTML = '';
        modal.body.appendChild(fresh.node);
        guard.mark();     // 换岗位 = 整张表单重建，基线得跟着重取，否则旧值会被当成「脏」
      });
    }
  }

  /* ==================== AI 备面材料 ==================== */
  function prepFor(jobId, opt) {
    opt = opt || {};
    var j = Store.job(jobId);
    if (!j) { U.toast('岗位不存在', 'warn'); return; }

    // 找一条面试记录挂载；没有就建一条（时间待定）
    var iv = opt.interviewId ? Store.interview(opt.interviewId) : null;
    if (!iv) {
      var cands = Store.interviews({ jobId: jobId });
      iv = cands.sort(function (a, b) { return (a.at || 9e15) - (b.at || 9e15); })[0] || null;
    }
    if (!iv) iv = Store.addInterview({ jobId: jobId, at: null, status: 'scheduled', round: '一面（技术/业务）' });

    var resume = Store.defaultResume();
    function go(rid) {
      var r = rid ? Store.resume(rid) : resume;
      Comp.runAI({
        title: 'AI 生成面试准备材料',
        tpl: 'interviewPrep',
        size: 'wide',
        input: {
          job: AI.jobToText(j, true),
          resume: AI.resumeToText(r),
          round: iv.round,
          extra: iv.interviewers ? '面试官：' + iv.interviewers : '',
        },
        applyLabel: '保存到这场面试',
        saveHint: '这场面试',
        onApply: function (data) {
          /* ⛔ 数据结构一个字没改：还是 updateInterview + {prep:{…}, prepAt}。
             保存条上的「✅ 已保存 13:42」由 runAI 自己打（它知道保存的时刻）。 */
          Store.updateInterview(iv.id, {
            prep: {
              selfIntro: String(data.selfIntro || ''),
              questions: Array.isArray(data.questions) ? data.questions.map(function (q) {
                return { q: String(q.q || q.question || ''), why: String(q.why || ''), a: String(q.a || q.answer || '') };
              }) : [],
              askHr: U.asArray(data.askHr),
              points: U.asArray(data.points),
              avoid: U.asArray(data.avoid),
              questionsToCompany: U.asArray(data.questionsToCompany),
              resumeId: r ? r.id : '',
            },
            prepAt: U.now(),
          });
          U.toast('备面材料已保存 ✅ 面试时打开这一条就能看', 'ok');
          App.updateNavCounts();
          if (opt.onSaved) opt.onSaved();
          openPrep(iv.id);
        },
      });
    }

    if (Store.resumes().length > 1) Comp.resumePicker({ title: '用哪份简历准备这场面试？' }).then(function (rid) { go(rid); });
    else go(null);
  }

  /** 展示已生成的备面材料 */
  function openPrep(interviewId) {
    var v = Store.interview(interviewId);
    if (!v || !v.prep) { U.toast('这场面试还没生成备面材料', 'warn'); return; }
    var j = Store.job(v.jobId) || {};
    var p = v.prep;

    var wrap = el('div', { class: 'stack' });

    /* ⛔ 这条顶栏原来只有一个 `btn xs` 的「↻ 重新生成」（11px 字，贴右边缘），
       而且**整个弹窗是只读的** —— 想改面试官备注、现场笔记、复盘，
       得关掉弹窗、回到列表点「编辑」，等于「保存入口找不到」。
       现在顶栏固定在顶部（滚动长材料时也看得见），并直接给出编辑入口：
         · ✏️ 编辑面试记录 → 表单弹窗，那里保存 面试官备注 / 现场笔记 / 复盘
         · ↻ 重新生成       → 重新调用 AI，在 AI 弹窗**顶部**点「💾 保存到这场面试」覆盖
       ⚠️ 两个按钮都只做「跳转/调起」，保存逻辑与数据结构没动。 */
    wrap.appendChild(el('div', { class: 'row ai-prepbar' }, [
      el('b', { class: 'fs14', text: j.title || '' }),
      el('span', { class: 'muted fs12', text: j.company || '' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'hint tiny', text: '生成于 ' + U.d2t(v.prepAt || 0) }),
      el('button', {
        class: 'btn pri sm', html: '✏️ 编辑面试记录',
        title: '改面试时间 / 面试官 / 现场笔记 / 复盘 —— 改完点弹窗里的「保存」',
        onclick: function () { m.close(); openForm(v.id, null, App.refresh); },
      }),
      el('button', {
        class: 'btn sm', html: '↻ 重新生成',
        title: '重新调用 AI 生成一份；在新弹窗顶部点「💾 保存到这场面试」就会覆盖现在这份',
        onclick: function () { m.close(); prepFor(v.jobId, { interviewId: v.id, onSaved: App.refresh }); },
      }),
    ]));

    if (p.selfIntro) {
      wrap.appendChild(el('div', { class: 'card' }, [
        el('header', {}, [el('h3', { text: '① 自我介绍（60-90 秒）' }), el('span', { class: 'sp' }), Comp.copyBtn(p.selfIntro)]),
        el('div', { class: 'body' }, [el('div', { class: 'box pre-wrap fs13', text: p.selfIntro })]),
      ]));
    }

    if (p.questions && p.questions.length) {
      var qCard = el('div', { class: 'card' }, [
        el('header', {}, [el('h3', { text: '② 高频面试题 + 参考答案（' + p.questions.length + ' 题）' }),
          el('span', { class: 'sp' }),
          el('span', { class: 'hint tiny', text: '点标题展开答案' })]),
      ]);
      var qBody = el('div', { class: 'body' });
      p.questions.forEach(function (q, i) {
        qBody.appendChild(el('details', { class: 'fold', style: 'margin-bottom:7px' }, [
          el('summary', { html: '<b>' + (i + 1) + '. ' + U.esc(q.q) + '</b>' }),
          el('div', { class: 'fd' }, [
            q.why ? el('div', { class: 'note info mb8' }, [el('span', { class: 'ico', text: '🎯' }),
              el('div', { html: '<b>他在考什么：</b>' + U.esc(q.why) })]) : null,
            el('div', { class: 'box pre-wrap', text: q.a }),
            el('div', { class: 'row mt8' }, [Comp.copyBtn(q.a, '复制这题答案')]),
          ].filter(Boolean)),
        ]));
      });
      qCard.appendChild(qBody);
      wrap.appendChild(qCard);
    }

    if (p.askHr && p.askHr.length) {
      wrap.appendChild(listCard('③ 反问 HR 的问题（' + p.askHr.length + ' 条）', p.askHr, 'good'));
    }
    if (p.questionsToCompany && p.questionsToCompany.length) {
      wrap.appendChild(listCard('④ 必须确认清楚的事（避坑）', p.questionsToCompany, 'warn'));
    }
    if (p.points && p.points.length) {
      wrap.appendChild(listCard('⑤ 这场面试必须讲到的加分点', p.points, 'ok'));
    }
    if (p.avoid && p.avoid.length) {
      wrap.appendChild(listCard('⑥ 千万别说的', p.avoid, 'bad'));
    }

    var m = U.openModal({
      title: '面试准备材料',
      size: 'xl',
      body: wrap,
      footer: [
        { text: '全部复制', onClick: function (c) {
          var txt = prepToText(j, v);
          U.copyText(txt).then(function (ok) { U.toast(ok ? '全部备面材料已复制' : '复制失败', ok ? 'ok' : 'warn'); });
          void c;
        } },
        { text: '关闭', cls: 'pri', onClick: function (c) { c(); } },
      ],
    });
    void m;
  }

  function listCard(title, arr, cls) {
    return el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: title })]),
      el('div', { class: 'body' }, [
        el('div', { class: 'stack', style: 'gap:5px' }, arr.map(function (x) {
          return el('div', { class: 'fs13 row', style: 'align-items:flex-start;gap:6px' }, [
            el('span', { class: cls === 'bad' ? 'bad-c' : cls === 'warn' ? 'warn-c' : 'brand-c', text: cls === 'bad' ? '✕' : '•' }),
            el('span', { class: 'flex1 pre-wrap', text: String(x) }),
          ]);
        })),
      ]),
    ]);
  }

  function prepToText(j, v) {
    var p = v.prep || {};
    var L = ['【' + (j.title || '') + ' · ' + (j.company || '') + '】面试准备',
      '面试时间：' + (v.at ? U.d2t(v.at) : '待定') + '　轮次：' + v.round, ''];
    if (p.selfIntro) L.push('■ 自我介绍', p.selfIntro, '');
    if (p.questions && p.questions.length) {
      L.push('■ 高频面试题');
      p.questions.forEach(function (q, i) {
        L.push((i + 1) + '. ' + q.q);
        if (q.why) L.push('   考点：' + q.why);
        if (q.a) L.push('   参考回答：' + q.a);
      });
      L.push('');
    }
    [['askHr', '■ 反问 HR'], ['questionsToCompany', '■ 必须确认的事'], ['points', '■ 加分点'], ['avoid', '■ 千万别说的']]
      .forEach(function (x) {
        if (p[x[0]] && p[x[0]].length) { L.push(x[1]); p[x[0]].forEach(function (t) { L.push('- ' + t); }); L.push(''); }
      });
    return L.join('\n');
  }

  /* ==================== AI 复盘 ==================== */
  function aiReview(input, cb) {
    var j = Store.job(input.jobId) || {};
    if (!input.notes || input.notes.trim().length < 8) {
      U.toast('先在「面试记录」里写点内容，AI 才能整理（哪怕是很碎的几行）', 'warn');
      return;
    }
    Comp.runAI({
      title: 'AI 面试复盘',
      tpl: 'review',
      size: 'wide',
      input: { job: AI.jobToText(j), round: input.round, notes: input.notes },
      applyLabel: '写入复盘框',
      onApply: function (data, raw) {
        cb(raw || data);
      },
    });
  }

  global.AIInterview = {
    prepFor: prepFor, openPrep: openPrep, openForm: openForm, aiReview: aiReview,
    prepToText: prepToText,
  };

  global.Views.interview = {
    title: '面试管理',
    render: render,
    openForm: openForm,
    openPrep: openPrep,
    prepFor: prepFor,
    filters: F,
  };
})(window);
