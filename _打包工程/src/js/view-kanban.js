/* ==========================================================================
   view-kanban.js · 模块 2：投递看板（泳道 + 拖拽）
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  var F = { kw: '', onlyBoss: false, compact: false };
  var draggingId = null;
  /* render() 内部那两个函数（卡片 / 卡片上的去-BOSS 操作条）的引用。
     它们要用 render 作用域里的东西（repaint、F.compact），所以留在里面；
     这里留个引用是为了让测试能**直接渲染真节点查结构**，而不是自己复刻一份
     （复刻出来的那份永远不会跟着产品改）。render 跑过一次后就有值。 */
  var _cardElRef = null;
  var _bossRowRef = null;

  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    App.topActions([
      el('button', { class: 'btn pri', html: '＋ 新增投递记录', onclick: addFlow }),
      el('button', { class: 'btn', html: '⤓ 导出投递记录', onclick: function () { Exporter.exportAppsCSV(); } }),
      // 只在设置页开了「同步回复」开关后才出现 —— 这个按钮会让采集器去读 BOSS 聊天列表
      (global.ApplyBoss && global.ApplyBoss.syncReplyOn())
        ? el('button', { class: 'btn', html: '🔄 同步回复/邀约',
            title: '读一次 BOSS 聊天列表，把回复和邀约捞回来（读到的都要你逐条确认才入库）',
            onclick: openSyncDialog })
        : null,
    ].filter(Boolean));

    var note = Comp.aiReadyNote();
    if (note) wrap.appendChild(note);

    // 概览
    var st = Store.stats();
    var bar = el('div', { class: 'card' }, [el('div', { class: 'body tight row' }, [
      el('span', { class: 'fs13' }, [el('b', { text: '投递 ' + st.appliedTotal }), el('span', { class: 'muted', text: ' 个岗位' })]),
      el('span', { class: 'muted', text: '·' }),
      el('span', { class: 'fs13' }, [el('span', { class: 'muted', text: '被查看 ' }), el('b', { class: 'brand-c', text: st.funnel[1].n })]),
      el('span', { class: 'muted', text: '·' }),
      el('span', { class: 'fs13' }, [el('span', { class: 'muted', text: '邀约 ' }), el('b', { class: 'brand-c', text: st.funnel[2].n })]),
      el('span', { class: 'muted', text: '·' }),
      el('span', { class: 'fs13' }, [el('span', { class: 'muted', text: 'Offer ' }), el('b', { class: 'ok-c', text: st.offerTotal })]),
      el('span', { class: 'sp' }),
      el('span', { class: 'hint tiny', text: '拖动卡片即可切换状态；点卡片看详情' }),
    ])]);
    wrap.appendChild(bar);

    // 筛选
    var kw = el('input', { type: 'text', placeholder: '搜索岗位 / 公司…', style: 'max-width:260px' });
    kw.value = F.kw;
    kw.addEventListener('input', U.debounce(function () { F.kw = kw.value.trim(); paint(); }, 180));
    var cbBoss = el('input', { type: 'checkbox' });
    cbBoss.checked = F.onlyBoss;
    cbBoss.addEventListener('change', function () { F.onlyBoss = cbBoss.checked; paint(); });
    var cbCompact = el('input', { type: 'checkbox' });
    cbCompact.checked = F.compact;
    cbCompact.addEventListener('change', function () { F.compact = cbCompact.checked; paint(); });

    wrap.appendChild(el('div', { class: 'card' }, [el('div', { class: 'body tight row' }, [
      kw,
      el('label', { class: 'chk' }, [cbBoss, el('span', { text: '只看 BOSS 来源' })]),
      el('label', { class: 'chk' }, [cbCompact, el('span', { text: '紧凑模式' })]),
      el('span', { class: 'sp' }),
      el('button', { class: 'btn sm ghost', text: '刷新', onclick: function () { paint(); } }),
    ])]));

    var boardBox = el('div');
    wrap.appendChild(boardBox);

    function appsList() {
      var arr = Store.applications();
      if (F.onlyBoss) {
        arr = arr.filter(function (a) { var j = Store.job(a.jobId); return j && j.source === 'boss'; });
      }
      if (F.kw) {
        var k = F.kw.toLowerCase();
        arr = arr.filter(function (a) {
          var j = Store.job(a.jobId) || {};
          return ((j.title || '') + ' ' + (j.company || '') + ' ' + (a.note || '')).toLowerCase().indexOf(k) >= 0;
        });
      }
      return arr;
    }

    function paint() {
      boardBox.innerHTML = '';
      var apps = appsList();
      if (!apps.length) {
        boardBox.appendChild(Comp.empty('📋', '投递看板还是空的',
          '从岗位库里挑一个岗位加入看板，或者直接在下面新建一条记录。',
          '＋ 新增投递记录', addFlow));
        return;
      }

      var board = el('div', { class: 'board' });
      Store.STATUSES.forEach(function (s) {
        var laneApps = apps.filter(function (a) { return a.status === s.id; });
        board.appendChild(laneEl(s, laneApps, paint));
      });
      boardBox.appendChild(board);

      // 已归档/结束的折叠提示
      var rej = apps.filter(function (a) { return a.status === 'rejected'; });
      if (rej.length) {
        var row = el('div', { class: 'row fs12 muted mt8' });
        row.appendChild(el('span', { text: '已结束 ' + rej.length + ' 条：' }));
        rej.slice(0, 6).forEach(function (a) {
          var j = Store.job(a.jobId) || {};
          row.appendChild(el('span', { class: 'tag', text: (j.title || '?') + (a.outcome === 'self' ? '（我拒）' : a.outcome === 'company' ? '（公司拒）' : '') }));
        });
        boardBox.appendChild(row);
      }
    }

    function laneEl(status, apps, repaint) {
      var lane = el('div', { class: 'lane', 'data-lane': status.id });
      var head = el('header', {}, [
        el('span', { class: 'dt', style: 'width:7px;height:7px;border-radius:50%;background:' + status.color }),
        el('span', { text: status.name }),
        el('span', { class: 'n', text: apps.length }),
      ]);
      lane.appendChild(head);

      var zone = el('div', { class: 'drop-zone' });
      zone.addEventListener('dragover', function (e) {
        e.preventDefault();
        lane.classList.add('over');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      });
      zone.addEventListener('dragleave', function () { lane.classList.remove('over'); });
      zone.addEventListener('drop', function (e) {
        e.preventDefault();
        lane.classList.remove('over');
        var id = draggingId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        if (!id) return;
        var a = Store.application(id);
        if (!a) return;
        if (a.status === status.id) return;
        Store.moveApplication(id, status.id);
        U.toast('已移到「' + status.name + '」', 'ok');
        App.updateNavCounts();
        repaint();
      });

      if (!apps.length) {
        zone.appendChild(el('div', { class: 'muted fs12', style: 'text-align:center;padding:14px 0', text: '拖到这里' }));
      }
      apps.forEach(function (a) { zone.appendChild(cardEl(a, repaint)); });
      lane.appendChild(zone);
      return lane;
    }

    /**
     * 投递卡上的「去 BOSS」操作条。
     *
     * 为什么投递面板也要这一条：这里是**每天真正干活的那一屏** ——
     * 用户看着「邀约面试」这一列决定现在该联系谁。要从这里回 BOSS，
     * 以前得先切到岗位库、再找到同一个岗位、再点链接，三条路变成一条路。
     * 所以和岗位库共用同一套逻辑（js/apply-boss.js），行为完全一致。
     *
     * ⚠️ 卡片本身是 draggable=true（拖拽改状态）且整卡绑了 click（开详情），
     *    所以这里的按钮必须：
     *      ① stopPropagation，别让点按钮变成"开详情"；
     *      ② 按住时临时把 drag 关掉 —— 否则手指（或鼠标）抖两像素就从"点按钮"
     *         变成"把卡片拖到别的列"，那是个很恼人的误操作。
     */
    function bossRow(a, j, repaint, getCard) {
      if (!global.ApplyBoss) return null;
      // 没投递记录就不画：Store.hasApplied(null) 会去读 a.status 直接抛。
      // （正常路径 cardEl 一定传得进来一条投递记录；这条是防"别处调用"时炸掉整屏渲染。）
      if (!a) return null;
      var AB = global.ApplyBoss;
      var can = AB.canOpen(j);

      function guard(node) {
        node.addEventListener('mousedown', function (e) {
          e.stopPropagation();
          var card = getCard && getCard();       // 触发时才取 —— 建卡片时它还没赋值
          if (card) card.draggable = false;
          // 抬手（哪怕在按钮外面）就把拖拽还回去。
          // 用一次性监听 + 兜底超时：鼠标在按钮上按下、移出窗口再松开时
          // mouseup 可能收不到，那样卡片会**永远不能拖** —— 比误拖更糟。
          var restore = function () {
            if (card) card.draggable = true;
            global.removeEventListener('mouseup', restore);
            clearTimeout(t);
          };
          var t = setTimeout(restore, 1500);
          global.addEventListener('mouseup', restore);
        });
        node.addEventListener('dragstart', function (e) { e.stopPropagation(); });
        node.addEventListener('click', function (e) { e.stopPropagation(); });
        return node;
      }

      var kids = [];
      var applied = Store.hasApplied(a);

      var openBtn = el('button', {
        class: 'btn xs' + (can.ok ? ' pri' : ''), type: 'button',
        html: applied ? '🚀 去 BOSS 看进度' : '🚀 去 BOSS 投递',
        title: can.ok
          ? '在新标签页打开这个岗位的 BOSS 页面（投递 / 看聊天都在这儿）'
          : can.reason + ' —— 所以没法跳过去',
        onclick: function () {
          if (!can.ok) { U.toast(can.reason, 'warn', 3200); return; }
          AB.openOnBoss(j, repaint);
        },
      });
      if (!can.ok) { openBtn.disabled = true; openBtn.classList.add('ghost'); }
      kids.push(guard(openBtn));

      if (!applied) {
        kids.push(guard(el('button', {
          class: 'btn xs', type: 'button', html: '✓ 我已投了',
          title: '投完回来点这个 —— 记上投递时间，之后没动静会自动出现在「待跟进」里',
          onclick: function () { AB.confirmApplied(j, repaint); },
        })));
      }

      if (AB.autoGreetOn()) {
        kids.push(guard(el('button', {
          class: 'btn xs danger', type: 'button', html: '⚡ 一键打招呼',
          title: '让采集器替你点「立即沟通」并发送招呼语。⚠️ 不可逆，发送前会再确认一次',
          onclick: function () { Views.jobs._openGreetDialog(j, repaint); },
        })));
      }

      return el('div', { class: 'row kcard-act', style: 'gap:5px;flex-wrap:wrap' }, kids);
    }
    _bossRowRef = bossRow;

    function cardEl(a, repaint) {
      var j = Store.job(a.jobId) || {};
      var ivs = Store.interviews({ jobId: a.jobId }).filter(function (v) { return v.status === 'scheduled' && v.at > U.now(); });
      var nextIv = ivs.sort(function (x, y) { return x.at - y.at; })[0];

      var card = el('div', { class: 'kcard', draggable: 'true' }, [
        el('h5', { text: j.title || '(岗位已删除)' }),
        el('div', { class: 'co', text: j.company || '' }),
        el('div', { class: 'row', style: 'gap:5px' }, [
          j.salaryText ? el('span', { class: 'tag', text: j.salaryText }) : null,
          a.channel && a.channel !== 'BOSS 直聘' ? el('span', { class: 'tag', text: a.channel }) : null,
          (j.tags || []).slice(0, 1).map(function (t) { return el('span', { class: 'tag', text: t }); })[0],
        ].filter(Boolean)),
        !F.compact && a.status === 'rejected' && a.outcome
          ? el('div', { class: 'fs11 bad-c', text: a.outcome === 'self' ? '我主动放弃' : '公司拒绝' })
          : null,
        !F.compact && nextIv
          ? el('div', { class: 'fs11 brand-c', text: '📅 ' + U.d2t(nextIv.at) + ' ' + nextIv.round })
          : null,
        /* 触达 BOSS 的操作条。
           getCard 是**闭包取值**：这里 el() 还在求值、card 尚未赋值，
           但按钮要等到用户真的按下才需要它，那时 card 早就有值了。
           （紧凑模式就不显示了 —— 那个模式的卖点就是一行一张、尽量少占地方。） */
        F.compact ? null : bossRow(a, j, repaint, function () { return card; }),
        el('div', { class: 'ft' }, [
          a.appliedAt ? el('span', { class: 'muted fs11', text: '投递 ' + U.d2(j.appliedAt || 0).slice(5) }) : null,
          el('span', { class: 'sp' }),
          el('span', { class: 'muted fs11', text: U.rel(a.updatedAt) }),
        ].filter(Boolean)),
      ].filter(Boolean));

      card.addEventListener('dragstart', function (e) {
        draggingId = a.id;
        card.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', a.id); e.dataTransfer.effectAllowed = 'move'; } catch (err) { /* noop */ }
      });
      card.addEventListener('dragend', function () {
        draggingId = null;
        card.classList.remove('dragging');
        U.$$('.lane').forEach(function (l) { l.classList.remove('over'); });
      });
      card.addEventListener('click', function () { openAppDetail(a.id, repaint); });

      // 触屏 / 不想拖时：右键或长按也能改状态
      card.addEventListener('contextmenu', function (e) {
        e.preventDefault();
        quickMoveMenu(a, repaint, e);
      });

      return card;
    }
    _cardElRef = cardEl;

    function quickMoveMenu(a, repaint, ev) {
      var other = Store.STATUSES.filter(function (s) { return s.id !== a.status; });
      var menu = el('div', {
        class: 'card', style: 'position:fixed;z-index:1500;width:180px;max-height:320px;overflow-y:auto;left:' +
          Math.min(ev.clientX, window.innerWidth - 200) + 'px;top:' + Math.min(ev.clientY, window.innerHeight - 340) + 'px',
      });
      other.forEach(function (s) {
        menu.appendChild(el('div', {
          class: 'li pointer', style: 'cursor:pointer;padding:7px 11px',
          onclick: function () {
            Store.moveApplication(a.id, s.id);
            if (s.id === 'rejected') askRejectBy(a.id, repaint); else { U.toast('已移到「' + s.name + '」', 'ok'); repaint(); }
            App.updateNavCounts();
            if (menu.parentNode) menu.parentNode.removeChild(menu);
          },
        }, [Comp.statusPill(s.id)]));
      });
      document.body.appendChild(menu);
      setTimeout(function () {
        document.addEventListener('mousedown', function close(ev2) {
          if (!menu.contains(ev2.target)) {
            if (menu.parentNode) menu.parentNode.removeChild(menu);
            document.removeEventListener('mousedown', close);
          }
        });
      }, 30);
    }

    paint();
  }

  function askRejectBy(appId, after) {
    U.openModal({
      title: '这条投递为什么结束？',
      size: 'sm',
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'row' }, [
          el('button', { class: 'btn blk', html: '🙋 我拒了公司', onclick: function () {
            Store.updateApplication(appId, { outcome: 'self' });
            U.toast('已记录：你主动放弃', 'ok'); c(); if (after) after();
          } }),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn blk', html: '🏢 公司拒了我', onclick: function () {
            Store.updateApplication(appId, { outcome: 'company' });
            U.toast('已记录：公司拒绝', 'ok');
            // 关窗即可：这个弹窗的 onClose 里已经会调 after()，再调一次会重复整页刷新
            c();
          } }),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn blk ghost', html: '不记录原因', onclick: function () { c(); } }),
        ]),
      ]),
      footer: [],
      onClose: function () { if (after) after(); },
    });
    function c() { U.closeAllModals(); }
  }

  /* ---------------- 新增投递 ---------------- */
  function addFlow() {
    Comp.jobPicker({ title: '选择要投递的岗位', only: 'boss' }).then(function (jobId) {
      if (!jobId) return;
      var exist = Store.appOfJob(jobId);
      if (exist) {
        U.toast('这个岗位已经在看板里了，帮你打开它', 'info');
        openAppDetail(exist.id, function () { App.refresh(); });
        return;
      }
      openAppForm(null, { jobId: jobId }, function () { App.updateNavCounts(); App.refresh(); });
    });
  }

  /* ---------------- 投递详情 / 编辑 ---------------- */
  function openAppDetail(appId, after) {
    var a = Store.application(appId);
    if (!a) return;
    var j = Store.job(a.jobId) || {};
    var m = U.openModal({
      title: '投递详情',
      size: 'wide',
      body: el('div', { id: '' }),
      footer: [],
    });
    function paint() {
      m.body.innerHTML = '';
      var cur = Store.application(appId);
      m.body.appendChild(detailBody(cur, j, paint, m.close));
    }
    paint();

    m.modal.querySelector('.mfoot').appendChild(el('button', {
      class: 'btn danger', text: '删除这条记录',
      onclick: function () {
        // 直接删 + 给撤销窗口，不再弹确认框（岗位本身不受影响）
        var snap = Store.takeOut({ applications: [appId] });
        App.updateNavCounts(); m.close(); if (after) after();
        Comp.trashToast('已删除这条投递记录（岗位本身还在）', snap, after);
      },
    }));
    m.modal.querySelector('.mfoot').appendChild(el('span', { class: 'sp' }));
    m.modal.querySelector('.mfoot').appendChild(el('button', {
      class: 'btn', text: '关闭', onclick: function () { m.close(); },
    }));
  }

  function detailBody(a, j, repaint, close) {
    var wrap = el('div', { class: 'stack' });

    wrap.appendChild(el('div', {}, [
      el('div', { class: 'row' }, [
        el('h3', { class: 'fs15', text: j.title || '(岗位已删除)' }),
        Comp.statusPill(a.status),
        el('span', { class: 'sp' }),
        el('button', { class: 'btn sm', text: '⚖️ 打开岗位详情', onclick: function () { close(); Views.jobs.detail(a.jobId); } }),
      ]),
      el('div', { class: 'fs12 muted mt4', text: (j.company || '') + (j.salaryText ? ' · ' + j.salaryText : '') + (j.location ? ' · ' + j.location : '') }),
    ]));

    /* 编辑区 */
    var f = Comp.fields([
      { key: 'status', label: '当前状态', type: 'select', options: Store.STATUSES.map(function (s) { return { value: s.id, label: s.name }; }), value: a.status },
      { key: 'outcome', label: '结束原因（状态为「拒绝」时）', type: 'select', options: [{ value: '', label: '不记录' }, { value: 'self', label: '我拒了公司' }, { value: 'company', label: '公司拒了我' }], value: a.outcome },
      { key: 'channel', label: '投递渠道', type: 'select', options: Store.CHANNELS, value: a.channel },
      { key: 'appliedAt', label: '投递时间', type: 'date', value: a.appliedAt ? U.d2(a.appliedAt) : '' },
      { key: 'salaryAsk', label: '沟通薪资', placeholder: '如：期望 13K', value: a.salaryAsk },
      { key: 'contact', label: '联系人 / HR', placeholder: '如：王女士（HR）', value: a.contact },
    ], 3);

    var resumeRow = el('div', { class: 'row mt12' }, [
      el('span', { class: 'fs12 muted', text: '投递用的简历：' }),
      el('b', { class: 'fs12', text: a.resumeId ? ((Store.resume(a.resumeId) || {}).name || '已删除') : '未绑定' }),
      el('button', {
        class: 'btn xs', text: '更改', onclick: function () {
          Comp.resumePicker({ title: '绑定简历版本' }).then(function (rid) {
            if (rid) { Store.updateApplication(a.id, { resumeId: rid }); repaint(); }
          });
        },
      }),
    ]);

    var noteTa = el('textarea', { rows: 2, placeholder: '投递备注' }); noteTa.value = a.note || '';
    var hrTa = el('textarea', { rows: 3, placeholder: 'HR 聊天摘要：聊了什么、承诺了什么、约了什么时间' }); hrTa.value = a.hrSummary || '';

    wrap.appendChild(el('div', { class: 'box' }, [
      f.node, resumeRow,
      el('div', { class: 'fld mt12' }, [el('label', { class: 'lb', text: '投递备注' }), noteTa]),
      el('div', { class: 'fld mt12' }, [el('label', { class: 'lb', text: 'HR 沟通摘要' }), hrTa]),
      el('div', { class: 'row mt12' }, [
        el('button', {
          class: 'btn pri', text: '保存',
          onclick: function () {
            var v = f.values();
            Store.updateApplication(a.id, {
              status: v.status, outcome: v.outcome, channel: v.channel,
              appliedAt: v.appliedAt ? U.fromLocalInput(v.appliedAt + 'T09:00') : null,
              salaryAsk: v.salaryAsk, contact: v.contact,
              note: noteTa.value, hrSummary: hrTa.value,
            });
            U.toast('已保存 ✅', 'ok');
            App.updateNavCounts(); repaint();
          },
        }),
        el('button', {
          class: 'btn', html: '👋 生成打招呼话术',
          onclick: function () { close(); Views.jobs.aiGreeting(a.jobId); },
        }),
        el('button', {
          class: 'btn', html: '🎙️ 安排面试',
          onclick: function () { close(); AIInterview.openForm(null, { jobId: a.jobId, appId: a.id }); },
        }),
      ]),
    ]));

    /* 时间线 */
    var tlCard = el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '进展轨迹' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '共 ' + a.timeline.length + ' 条' })]),
    ]);
    var tl = el('div', { class: 'body' });
    var line = el('div', { class: 'tl' });
    a.timeline.slice().reverse().forEach(function (t, i) {
      line.appendChild(el('div', { class: 'it' + (i === 0 ? ' on' : '') }, [
        el('div', { class: 'tt', text: Store.statusName(t.status) }),
        el('div', { class: 'tm', text: U.d2t(t.at) + (t.note ? ' · ' + t.note : '') }),
      ]));
    });
    tl.appendChild(line);
    tlCard.appendChild(tl);
    wrap.appendChild(tlCard);

    /* 相关面试 */
    var ivs = Store.interviews({ jobId: a.jobId });
    if (ivs.length) {
      var c2 = el('div', { class: 'card' }, [el('header', {}, [el('h3', { text: '这个岗位的面试' })])]);
      ivs.forEach(function (v) {
        c2.appendChild(el('div', { class: 'li' }, [
          el('div', { class: 'li-main' }, [
            el('div', { class: 'li-t', text: v.round + ' · ' + (v.at ? U.d2t(v.at) : '未定') }),
            el('div', { class: 'li-s' }, [el('span', { text: v.status === 'done' ? '已完成' : '待进行' })]),
          ]),
          el('div', { class: 'li-act' }, [
            el('button', { class: 'btn xs', text: '查看', onclick: function () { close(); App.go('interview', { interviewId: v.id }); } }),
          ]),
        ]));
      });
      wrap.appendChild(c2);
    }

    return wrap;
  }

  /** 通用投递表单（新建 / 编辑） */
  function openAppForm(appId, preset, after) {
    var a = appId ? Store.application(appId) : null;
    var pre = preset || {};
    var job = a ? Store.job(a.jobId) : Store.job(pre.jobId);
    if (!job) { U.toast('请先选一个岗位', 'warn'); return; }

    var f = Comp.fields([
      { key: 'status', label: '状态', type: 'select', options: Store.STATUSES.map(function (s) { return { value: s.id, label: s.name }; }),
        value: a ? a.status : (pre.status || 'todo') },
      { key: 'channel', label: '投递渠道', type: 'select', options: Store.CHANNELS, value: a ? a.channel : 'BOSS 直聘' },
      { key: 'appliedAt', label: '投递时间', type: 'date', value: a && a.appliedAt ? U.d2(a.appliedAt) : (pre.status === 'applied' ? U.d2(U.now()) : '') },
      { key: 'salaryAsk', label: '沟通薪资', placeholder: '选填', value: a ? a.salaryAsk : '' },
    ], 2);
    var noteTa = el('textarea', { rows: 2, placeholder: '备注（选填）' });
    noteTa.value = a ? a.note : '';
    var guard = U.dirtyGuard(function () { return [f.values(), noteTa.value]; });

    U.openModal({
      title: appId ? '编辑投递记录' : '新增投递记录',
      size: 'wide',
      beforeClose: guard.check,
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'box' }, [
          el('div', { class: 'row' }, [
            el('b', { text: job.title }), el('span', { class: 'muted fs12', text: job.company || '' }),
            el('span', { class: 'sp' }),
            Comp.statusPill(a ? a.status : (pre.status || 'todo')),
          ]),
        ]),
        f.node,
        el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '备注' }), noteTa]),
      ]),
      footer: [
        { text: '保存', cls: 'pri', onClick: function (c) {
          var v = f.values();
          var appliedAt = v.appliedAt ? U.fromLocalInput(v.appliedAt + 'T09:00') : null;
          if (a) {
            Store.updateApplication(a.id, { status: v.status, channel: v.channel, appliedAt: appliedAt, salaryAsk: v.salaryAsk, note: noteTa.value });
            U.toast('已保存 ✅', 'ok');
          } else {
            Store.addApplication({ jobId: job.id, status: v.status, channel: v.channel, appliedAt: appliedAt, salaryAsk: v.salaryAsk, note: noteTa.value });
            U.toast('已加入看板 ✅', 'ok');
          }
          c(); if (after) after();
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
    guard.mark();     // 基线在弹窗建好之后取，详见 U.dirtyGuard 注释
  }

  /* ==================== 同步回复 / 邀约（保守模式） ==================== */

  /**
   * 读一次 BOSS 聊天列表 → 逐条确认 → 才写入。
   *
   * ⚠️ 三条设计红线（用户明确要求"保守一点"）：
   *   ① 每行的动作**默认是「忽略」**。不是帮你猜好再让你取消 —— 而是默认什么都不做。
   *   ② 匹配不到本地岗位的行**置灰不可选**（宁可漏，不可错配）。
   *   ③ 写入前会把你勾了什么再汇总一遍，确认后才落库。
   */
  function openSyncDialog() {
    var AB = global.ApplyBoss;
    if (!AB) { U.toast('apply-boss 模块没加载', 'bad'); return; }

    /* 说清"用哪个浏览器"（第 28 轮）：这一屏的「去投递」走的是系统默认浏览器，
       而这个动作原来另起窗口要单独扫码。现在两者都能用日常 Edge，但 daily 模式
       有个硬前提（先彻底退出 Edge），所以**提前**把话说明白，别等失败才讲。 */
    var isDaily = AB.browserMode() === 'daily';
    var body = el('div', { class: 'stack' }, [
      el('div', { class: 'row' }, [el('span', { class: 'spin' }),
        el('span', { text: '正在用「' + AB.browserModeLabel() + '」读 BOSS 聊天列表…请稍等' })]),
      isDaily ? el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '⚠' }),
        el('div', { html: '用的是<b>你平时的 Edge</b>。它如果在运行就会失败 —— ' +
          '请先<b>彻底退出 Edge</b>（到托盘图标上右键退出，不只是关窗口），再点一次。' }),
      ]) : null,
    ].filter(Boolean));
    var m = U.openModal({ title: '🔄 同步回复 / 邀约', size: 'wide', body: body, maskClose: false, footer: [] });

    var foot = m.modal.querySelector('.mfoot');
    var bClose = el('button', { class: 'btn', text: '关闭', onclick: function () { m.close(); } });
    foot.appendChild(el('span', { class: 'sp' }));
    foot.appendChild(bClose);

    AB.fetchReplyCandidates().then(function (res) {
      if (!res || !res.ok) {
        body.innerHTML = '';
        body.appendChild(el('div', { class: 'note bad' }, [
          el('span', { class: 'ico', text: '⛔' }),
          el('div', { html: '没读到：' + U.esc((res && res.error) || '未知原因') +
            '<br><span class="muted fs12">常见原因：采集器没在跑 / BOSS 登录态过期了（去采集页扫一次码）。</span>' }),
        ]));
        return;
      }
      var rows = AB.planSyncActions(res.items || [], Store.jobs());
      renderSyncRows(m, body, rows);
    }, function (e) {
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'note bad' }, [
        el('span', { class: 'ico', text: '⛔' }),
        el('div', { text: '同步失败：' + ((e && e.message) || '未知原因') }),
      ]));
    });
    return m;
  }

  function renderSyncRows(m, body, rows) {
    body.innerHTML = '';

    if (!rows.length) {
      body.appendChild(el('div', { class: 'note ok' }, [
        el('span', { class: 'ico', text: '✅' }),
        el('div', { text: '聊天列表里没有新动静 —— 没有需要你处理的回复或邀约。' }),
      ]));
      return;
    }

    var decisions = {};                 // { idx: 'ignore'|'viewed'|'invited' }
    var makeIv = {};                    // { idx: true }

    body.appendChild(el('div', { class: 'note warn' }, [
      el('span', { class: 'ico', text: '⚠️' }),
      el('div', { html: '读到 <b>' + rows.length + '</b> 条会话。下面每一行<b>默认是「忽略」</b>，' +
        '你要它做什么就点什么 —— 匹配不准的行会被置灰（宁可漏一条，也不错写一条）。' }),
    ]));

    var box = el('div', { class: 'stack', style: 'gap:8px;max-height:52vh;overflow:auto' });
    rows.forEach(function (r) {
      var row = el('div', { class: 'box' });
      row.appendChild(el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
        el('b', { text: r.company || '(未知公司)' }),
        r.hr ? el('span', { class: 'muted fs12', text: 'HR ' + r.hr }) : null,
        r.unread ? el('span', { class: 'tag bad', text: '未读' }) : null,
        r.invited ? el('span', { class: 'tag warn', text: '疑似邀约' }) : null,
        el('span', { class: 'sp' }),
        r.at ? el('span', { class: 'muted fs11', text: U.rel(r.at) }) : null,
      ].filter(Boolean)));
      if (r.lastText) {
        row.appendChild(el('div', { class: 'fs12 muted mt4', style: 'white-space:pre-wrap', text: r.lastText.slice(0, 160) }));
      }
      row.appendChild(el('div', { class: 'fs12 mt4' }, [
        el('span', { class: 'muted', text: '匹配到：' }),
        r.matched
          ? el('b', { text: (r.jobTitle || '') + '　' })
          : el('b', { class: 'warn-c', text: '没匹配上本地岗位 ' }),
        r.curStatus ? el('span', { class: 'muted', text: '（当前：' + Store.statusName(r.curStatus) + '）' }) : null,
      ].filter(Boolean)));

      var sel = el('select', { style: 'max-width:220px' });
      [['ignore', '忽略（什么都不做）'], ['viewed', '标记为「已回复」'], ['invited', '标记为「收到邀约」']]
        .forEach(function (o) {
          var op = el('option', { value: o[0], text: o[1] });
          sel.appendChild(op);
        });
      sel.value = 'ignore';
      if (!r.matched) sel.disabled = true;             // 匹配不到就不许写
      sel.addEventListener('change', function () { decisions[r.idx] = sel.value; syncIvVisible(); });

      var cbIv = el('input', { type: 'checkbox' });
      cbIv.addEventListener('change', function () { makeIv[r.idx] = cbIv.checked; });
      var ivWrap = el('label', { class: 'chk', style: 'display:none' }, [
        cbIv, el('span', { class: 'fs12', text: '同时在「面试管理」建一条待安排的面试' }),
      ]);

      function syncIvVisible() { ivWrap.style.display = sel.value === 'invited' ? 'flex' : 'none'; }

      row.appendChild(el('div', { class: 'row mt8', style: 'gap:10px;flex-wrap:wrap' }, [sel, ivWrap]));
      box.appendChild(row);
    });
    body.appendChild(box);

    var bApply = el('button', {
      class: 'btn pri', text: '确认写入',
      onclick: function () {
        var plan = {};
        rows.forEach(function (r) { plan[r.idx] = decisions[r.idx] || 'ignore'; });
        // 「建面试」只对确实选了 invited 的行生效
        rows.forEach(function (r) { r.makeInterview = !!(plan[r.idx] === 'invited' && makeIv[r.idx]); });

        var touched = Object.keys(plan).filter(function (k) { return plan[k] !== 'ignore'; });
        if (!touched.length) { U.toast('你一条都没选，什么都没改 👌', 'info', 2600); return; }

        var out = AB.applySyncPlan(rows, plan);
        var msg = '更新 ' + out.updated + ' 条投递';
        if (out.interviewed) msg += '，新建 ' + out.interviewed + ' 条面试';
        if (out.skipped) msg += '，跳过 ' + out.skipped + ' 条';
        U.toast(msg, out.updated || out.interviewed ? 'ok' : 'warn', 5200);
        m.close();
        App.refresh();
      },
    });
    var foot = m.modal.querySelector('.mfoot');
    foot.insertBefore(bApply, foot.firstChild);
  }

  global.Views.kanban = {
    title: '投递看板',
    render: render,
    add: addFlow,
    openDetail: openAppDetail,
    openForm: openAppForm,
    filters: F,
    // 同步回复/邀约（测试直接开这个弹窗查结构）
    _openSyncDialog: openSyncDialog,
    _renderSyncRows: renderSyncRows,
    // 投递卡上的「去 BOSS」操作条（测试直接渲染真节点查结构）
    // ⚠️ 包一层取值函数：真正的实现在 render() 里（要用它作用域的 repaint / F.compact），
    //    render 跑过一次后 _bossRowRef 才有值。
    _bossRow: function (a, j, repaint, getCard) {
      return _bossRowRef ? _bossRowRef(a, j, repaint, getCard) : null;
    },
    _cardEl: function (a, repaint) {
      return _cardElRef ? _cardElRef(a, repaint) : null;
    },
  };
})(window);
