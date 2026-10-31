/* ==========================================================================
   app.js · 应用外壳：路由 / 侧边导航 / 主题 / 面试提醒 / 全局 AI 唤起
   ========================================================================== */
(function (global) {
  'use strict';

  var NAV = [
    { grp: '求职工作' },
    { id: 'jobs',      name: '岗位库',      icon: '🗂️', sub: '导入 BOSS 岗位、AI 解析、筛选归档' },
    { id: 'collect',   name: '采集岗位',    icon: '📡', sub: '本地采集器：真实浏览器登录，把岗位批量捞回来' },
    { id: 'kanban',    name: '投递看板',    icon: '📋', sub: '拖拽卡片推进求职状态' },
    { id: 'interview', name: '面试管理',    icon: '🎙️', sub: '面试安排、AI 备面、复盘' },
    { id: 'followup',  name: '待跟进',      icon: '⏰', sub: '该催的、该复盘的、该安排的，一次列全' },
    { id: 'company',   name: '公司背调',    icon: '🔎', sub: '投之前先查一遍：工商 / 司法 / 劳动纠纷，绿黄红一眼可见' },
    { grp: '素材与工具' },
    { id: 'resume',    name: '简历素材库',  icon: '📄', sub: '多版本简历、AI 匹配打分、素材复用' },
    { id: 'assistant', name: 'AI 求职助手', icon: '🤖', sub: 'JD 解析、话术、面试题、沟通文案' },
    { id: 'compare',   name: '岗位对比',    icon: '⚖️', sub: '多岗位横向对比 + AI 推荐结论' },
    { grp: '分析' },
    { id: 'dashboard', name: '数据仪表盘',  icon: '📊', sub: '求职漏斗、状态分布、行业与薪资分布' },
    { grp: '系统' },
    { id: 'settings',  name: '设置',        icon: '⚙️', sub: '模型 API、提示词、数据备份、主题' },
  ];

  var current = 'jobs';
  var currentView = null;

  /* ==================== 侧边导航 ==================== */
  function buildNav() {
    var nav = U.$('#nav');
    nav.innerHTML = '';
    NAV.forEach(function (n) {
      if (n.grp) {
        nav.appendChild(U.el('div', { class: 'grp', text: n.grp }));
        return;
      }
      var item = U.el('div', {
        class: 'nav-i' + (n.id === current ? ' active' : ''),
        'data-nav': n.id,
        title: n.name + '　' + (n.sub || ''),
        onclick: function () { go(n.id); },
      }, [
        U.el('span', { class: 'ic', text: n.icon }),
        U.el('span', { class: 'lb', text: n.name }),
        U.el('span', { class: 'cnt', 'data-cnt': n.id, text: '' }),
      ]);
      nav.appendChild(item);
    });
    updateNavCounts();
  }

  function updateNavCounts() {
    var st = Store.stats();
    /* 背调徽标给的是**红灯家数**，不是档案总数 ——
       「已录 12 家」没有任何行动含义，而「3 家红灯」是立刻要处理的。
       ⚠️ 用 try 包住：这一段会在每次保存时被调，不能因为背调模块的一个异常
          把整个侧边栏的计数刷新打断（那就成了"保存后所有数字都不更新"）。 */
    var ck = { red: 0, unchecked: 0 };
    try { if (global.CompanyView) ck = global.CompanyView.counts(); } catch (e) { /* 背调模块算不动就算了 */ }
    var counts = {
      jobs: st.jobTotal,
      kanban: st.appTotal,
      interview: st.interviewUpcoming ? st.interviewUpcoming : st.interviewTotal,
      // 待跟进条数单独算：它跨岗位 / 投递 / 面试三张表，stats() 里没有
      followup: global.FollowUp ? global.FollowUp.count() : 0,
      company: ck.red || '',
      resume: st.resumeTotal,
      assistant: st.chatTotal,
      compare: '',
      dashboard: '',
      settings: '',
    };
    U.$$('[data-cnt]').forEach(function (n) {
      var k = n.getAttribute('data-cnt');
      var v = counts[k];
      n.textContent = (v === 0 || v === undefined || v === '') ? '' : String(v);
      // 有"待办"性质的数字用品牌色标出来，不是单纯的计数
      var hot = (k === 'interview' && st.interviewUpcoming > 0) ||
                (k === 'followup' && v > 0) ||
                (k === 'company' && ck.red > 0);   // 有红灯公司 = 有该处理的事
      if (hot) {
        n.style.background = 'var(--brand)'; n.style.color = '#fff';
      } else {
        n.style.background = ''; n.style.color = '';
      }
    });
    // 有即将到来的面试时给侧边栏打个红点
    var badge = U.$('[data-nav="interview"] .dot-badge');
    if (st.interviewUpcoming > 0 && !badge) {
      U.$('[data-nav="interview"]').appendChild(U.el('span', { class: 'dot-badge' }));
    } else if (!st.interviewUpcoming && badge) {
      badge.parentNode.removeChild(badge);
    }
  }

  /* ==================== 路由 ==================== */
  function go(id, params) {
    var def = NAV.filter(function (n) { return n.id === id; })[0];
    if (!def || !Views[id]) {
      U.toast('页面不存在：' + id, 'warn');
      return;
    }
    current = id;
    try { location.hash = '#' + id; } catch (e) { /* file:// 下 hash 也可用 */ }

    U.$$('.nav-i').forEach(function (n) {
      n.classList.toggle('active', n.getAttribute('data-nav') === id);
    });
    U.$('#pgTitle').textContent = def.name;
    U.$('#pgSub').textContent = def.sub || '';

    var view = U.$('#view');
    // 切页前先收掉所有还开着的弹窗。
    // 否则打开中的「岗位详情」之类会盖在新页面上，看着像页面错乱。
    // 传 true = 强制关：跳页是用户明确要离开，不该被"有没保存的修改"拦住
    // （而且 .mask 盖住了整屏，开着弹窗时点不到导航，所以这条路径只可能来自程序内部）。
    U.closeAllModals(true);
    view.innerHTML = '';
    view.scrollTop = 0;
    U.$('#topActions').innerHTML = '';

    currentView = Views[id];
    try {
      currentView.render(view, params || {});
    } catch (e) {
      console.error(e);
      view.appendChild(U.el('div', { class: 'note bad' }, [
        U.el('span', { class: 'ico', text: '⛔' }),
        U.el('div', {}, [
          U.el('b', { text: '这个页面渲染出错了：' }),
          U.el('div', { class: 'fs12 mt4', text: e.message }),
          U.el('div', { class: 'fs12 mt4 muted', text: '数据没丢。可以切到别的页面，或者到设置页导出备份。' }),
        ]),
      ]));
    }
    document.title = def.name + ' · 求职猎手工作台';
  }

  function refreshCurrent() {
    if (!currentView) return;
    var view = U.$('#view');
    var scroll = view.scrollTop;
    view.innerHTML = '';
    U.$('#topActions').innerHTML = '';
    try { currentView.render(view, {}); } catch (e) { console.error(e); }
    view.scrollTop = scroll;
  }

  /** 供子页面往顶栏塞按钮 */
  function topActions(nodes) {
    var box = U.$('#topActions');
    box.innerHTML = '';
    [].concat(nodes || []).forEach(function (n) { if (n) box.appendChild(n); });
  }

  /* ==================== 主题 ==================== */
  function applyTheme(t) {
    document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light');
    var b = U.$('#btnTheme');
    if (b) b.textContent = t === 'dark' ? '☀️ 主题' : '🌙 主题';
  }
  function toggleTheme() {
    var t = Store.settings().theme === 'dark' ? 'light' : 'dark';
    Store.setSetting('theme', t);
    applyTheme(t);
  }

  /* ==================== 侧边栏收起 ==================== */
  function toggleCollapse() {
    var s = U.$('#side');
    s.classList.toggle('collapsed');
    try { localStorage.setItem('jh.side.collapsed', s.classList.contains('collapsed') ? '1' : '0'); } catch (e) { /* noop */ }
  }

  /* ==================== 面试提醒 ==================== */
  var REMIND_BEFORE = [
    { key: 'day', ms: 24 * 3600 * 1000, label: '明天' },
    { key: 'hour', ms: 2 * 3600 * 1000, label: '2 小时后' },
    { key: 'min', ms: 30 * 60 * 1000, label: '30 分钟后' },
  ];

  function notify(title, body, tag) {
    U.toastHtml('<b>' + U.esc(title) + '</b><br>' + U.esc(body), 'warn', 12000);
    try {
      if (Store.settings().notify && global.Notification && Notification.permission === 'granted') {
        var n = new Notification(title, { body: body, tag: tag || 'jh', icon: '' });
        n.onclick = function () { global.focus(); go('interview'); n.close(); };
      }
    } catch (e) { /* 有些环境不让发通知，忽略 */ }
  }

  function checkReminders() {
    var cfgN = Store.settings();
    if (!cfgN.notify) return;
    var now = U.now();
    Store.upcomingInterviews().forEach(function (v) {
      REMIND_BEFORE.forEach(function (rb) {
        if (cfgN.notifyAhead && cfgN.notifyAhead[rb.key] === false) return;
        var diff = v.at - now;
        if (diff <= rb.ms && diff > 0 && !v.notified[rb.key]) {
          var j = Store.job(v.jobId) || {};
          notify('面试提醒 · ' + rb.label,
            (j.title || '岗位') + '（' + (j.company || '') + '）\n' +
            U.d2t(v.at) + ' · ' + v.round + (v.mode === 'offline' ? '\n地点：' + (v.place || '') : v.link ? '\n链接：' + v.link : ''),
            'itv-' + v.id + '-' + rb.key);
          v.notified[rb.key] = true;
          Store.save();
        }
      });
    });
  }

  /**
   * 申请通知权限。
   * ⚠️ 每条分支都必须给用户可见反馈并刷新界面 —— 之前只有部分分支有 toast，
   *    权限被拒时设置页的勾选框还停在"已勾上"，看着就像点了没反应。
   */
  function askNotifyPermission() {
    function finish(on, msg, type) {
      Store.setSetting('notify', !!on);
      U.toastHtml(msg, type);
      refreshCurrent();   // 让设置页勾选框 / 面试页按钮文案立刻对齐真实状态
    }

    if (!global.Notification) {
      // 没有系统通知能力也能用页面内提醒，所以照样算"开启"，只是降级
      finish(true, '这个浏览器不支持系统通知，已改为只用<b>页面内提醒</b>（面试前会在页面上弹提示）。', 'warn');
      return;
    }
    if (Notification.permission === 'granted') {
      finish(true, '通知权限已开启 ✅（浏览器通知 + 页面内提醒）', 'ok');
      return;
    }
    if (Notification.permission === 'denied') {
      finish(false, '浏览器已拒绝通知权限，需要在<b>浏览器设置里手动允许</b>。已改为只用页面内提醒。', 'warn');
      return;
    }
    try {
      Notification.requestPermission().then(function (p) {
        if (p === 'granted') finish(true, '通知权限已开启 ✅', 'ok');
        else finish(false, '没有拿到浏览器通知权限，已改为只用<b>页面内提醒</b>（面试前照样会弹提示）。', 'warn');
      }).catch(function (e) {
        finish(false, '申请通知权限失败：' + (e && e.message ? e.message : '未知原因') +
          '。已改为只用页面内提醒。', 'warn');
      });
    } catch (e) {
      finish(false, '申请通知权限失败，已改为只用页面内提醒。', 'warn');
    }
  }

  /* ==================== 备份提醒 ==================== */
  /**
   * 数据全在浏览器 localStorage 里：清缓存、换电脑、浏览器抽风都可能一次全没。
   * 所以隔一段时间提醒导一次 JSON。
   *
   * 三条口径（都写在这儿，免得以后改的时候只改一半）：
   *  1. 库是空的就别烦人 —— 空库导出也没意义。
   *  2. 从没导出过时 daysSinceExport() 返回 null，不能直接跟阈值比大小
   *     （null 参与比较恒为 false，会变成"永远不提醒"）。这种情况改用
   *     「库里最早一条记录到现在多久」当基准。
   *  3. 提醒频率本身也要记一笔 lastRemindedAt，否则每次开页面都弹，
   *     用户会先去关提醒而不是去备份。
   */
  function dataAgeDays() {
    var oldest = 0;
    [Store.jobs(), Store.applications(), Store.interviews(), Store.resumes()]
      .forEach(function (arr) {
        (arr || []).forEach(function (x) {
          if (x.createdAt && (!oldest || x.createdAt < oldest)) oldest = x.createdAt;
        });
      });
    return oldest ? Math.floor((U.now() - oldest) / 86400000) : 0;
  }

  function checkBackupReminder() {
    var cfg = Store.settings().backup || {};
    /* ⚠️ 不能写 `cfg.remindDays || 7`：0 是「用户关掉了」，会被 || 吞成 7 变成关不掉 */
    var remindDays = typeof cfg.remindDays === 'number' ? cfg.remindDays : 7;
    if (remindDays <= 0) return;
    var st = Store.stats();
    if (!(st.jobTotal + st.appTotal + st.interviewTotal + st.resumeTotal)) return;

    var since = Store.daysSinceExport();          // null = 从没导出过
    var never = since === null;
    var age = never ? dataAgeDays() : since;
    if (age < remindDays) return;

    // 最近提醒过就别再提
    if (cfg.lastRemindedAt && (U.now() - cfg.lastRemindedAt) < remindDays * 86400000) return;
    Store.setSetting('backup.lastRemindedAt', U.now());

    var t = U.toastHtml(
      '<b>' + (never ? '还没导出过备份' : '已经 ' + since + ' 天没备份了') + '</b><br>' +
      '数据只存在这个浏览器里，清缓存或换电脑就没了。花 10 秒导一份 JSON 吧。',
      'warn', 15000,
      [{
        text: '去导出', cls: 'pri',
        onClick: function () { go('settings'); },
      }]);
    void t;
  }

  /* ==================== 全局 AI 快速唤起 ==================== */
  var quickChatId = null;

  function quickOpen() {
    var q = U.$('#quick');
    q.classList.remove('hide');
    U.$('#quickInput').focus();
    renderQuick();
  }
  function quickHide() { U.$('#quick').classList.add('hide'); }

  function quickChat() {
    if (!quickChatId || !Store.chat(quickChatId)) {
      var c = Store.addChat({ kind: 'free', title: '快速问答' });
      quickChatId = c.id;
    }
    return Store.chat(quickChatId);
  }

  function renderQuick() {
    var box = U.$('#quickBody');
    var c = quickChat();
    box.innerHTML = '';
    if (!c.messages.length) {
      box.appendChild(U.el('div', { class: 'muted fs12', html:
        '随手问点求职问题。<br>比如：<br>· 面试被问「为什么离职」怎么答<br>· 谈薪时怎么开口' +
        '<br><br><span class="fs11">完整功能（绑定岗位、生成话术、面试题）请点右上角「↗ 完整」</span>' }));
      return;
    }
    var wrap = U.el('div', { class: 'bubbles' });
    c.messages.forEach(function (msg) {
      wrap.appendChild(U.el('div', { class: 'bub ' + (msg.role === 'user' ? 'me' : 'ai') }, [
        U.el('div', { class: 'av', text: msg.role === 'user' ? '我' : 'AI' }),
        U.el('div', { class: 'txt', html: mdLite(msg.content) }),
      ]));
    });
    box.appendChild(wrap);
    box.scrollTop = box.scrollHeight;
  }

  var quickBusy = false;
  function quickSend() {
    if (quickBusy) return;
    if (!AI.ready()) { U.toast('还没配置模型 API，请先到设置页填 Key。', 'warn'); quickHide(); go('settings'); return; }
    var inp = U.$('#quickInput');
    var text = inp.value.trim();
    /* 空输入原来直接 `return` —— 不弹提示、不抖动、不置灰，同页其它操作都有反馈，
       这里看着像坏了（评审 A12）。给一句可照做的提示。 */
    if (!text) { U.toast('先写点什么再发送。', 'warn'); inp.focus(); return; }
    inp.value = '';
    var c = quickChat();
    Store.pushMessage(c.id, 'user', text);
    renderQuick();

    var box = U.$('#quickBody');
    var holder = U.el('div', { class: 'bub ai' }, [
      U.el('div', { class: 'av', text: 'AI' }),
      U.el('div', { class: 'txt' }, [U.el('span', { class: 'spin' }), ' 思考中…']),
    ]);
    box.appendChild(holder);
    var txt = holder.querySelector('.txt');
    box.scrollTop = box.scrollHeight;

    quickBusy = true;
    var acc = '';
    AI.chat({
      messages: [{ role: 'system', content: AI.TPL.free.sys }]
        .concat(c.messages.slice(-8).map(function (m) { return { role: m.role, content: m.content }; })),
      onDelta: function (d, full) {
        acc = full;
        txt.innerHTML = mdLite(full) + '<span class="cur"></span>';
        box.scrollTop = box.scrollHeight;
      },
      timeout: 60,
    }).then(function (full) {
      quickBusy = false;
      txt.innerHTML = mdLite(full || acc);
      Store.pushMessage(c.id, 'assistant', full || acc);
    }).catch(function (e) {
      quickBusy = false;
      txt.innerHTML = '<span class="bad-c">出错了：' + U.esc(e.message) + '</span>';
    });
  }

  /* ==================== 轻量 Markdown 渲染 ==================== */
  function mdLite(text) {
    var s = U.esc(text || '');
    s = s.replace(/```([\s\S]*?)```/g, function (_, code) {
      return '<pre class="mono fs12 pre-wrap" style="background:var(--chip);padding:9px 11px;border-radius:7px;margin:7px 0">' + code.trim() + '</pre>';
    });
    s = s.replace(/^###\s*(.+)$/gm, '<b style="display:block;margin:9px 0 4px">$1</b>');
    s = s.replace(/^##\s*(.+)$/gm, '<b style="display:block;margin:11px 0 5px;font-size:13.5px">$1</b>');
    s = s.replace(/^#\s*(.+)$/gm, '<b style="display:block;margin:11px 0 5px">$1</b>');
    s = s.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
    s = s.replace(/`([^`\n]+)`/g, '<code class="mono" style="background:var(--chip);padding:1px 5px;border-radius:4px">$1</code>');
    s = s.replace(/^\s*[-*·•]\s+(.+)$/gm, '<span style="display:block;padding-left:11px;text-indent:-11px">• $1</span>');
    s = s.replace(/^\s*\d+[.、)]\s+(.+)$/gm, '<span style="display:block;padding-left:14px;text-indent:-14px">$1</span>');
    s = s.replace(/^---+$/gm, '<span style="display:block;height:1px;background:var(--line-2);margin:9px 0"></span>');
    return s;
  }

  /* ==================== 快捷键 / 帮助 ==================== */
  function openHelp() {
    function el() { return U.el.apply(null, arguments); }
    function kv(k, v) {
      return el('div', { class: 'row', style: 'gap:10px;align-items:baseline' }, [
        el('code', { class: 'mono fs12', style: 'min-width:104px;color:var(--brand)', text: k }),
        el('span', { class: 'fs12 flex1', text: v }),
      ]);
    }
    U.openModal({
      title: '快捷键 & 使用边界',
      size: 'sm',
      body: el('div', { class: 'stack', style: 'gap:14px' }, [
        el('div', {}, [
          el('div', { class: 'fs12 muted fw6 mb8', text: '快捷键' }),
          el('div', { class: 'stack', style: 'gap:7px' }, [
            kv('Ctrl + K', '唤起 / 收起 AI 快速问答（右下角 💬 同一个）'),
            kv('Enter', '在快速问答输入框里直接发送'),
            kv('Esc', '关闭最上层的弹窗，也会收起快速问答'),
          ]),
        ]),
        el('div', { class: 'note info' }, [
          el('span', { class: 'ico', text: '📌' }),
          el('div', { html:
            '<b>这个工作台只做 BOSS 直聘</b>，而且有几件事是刻意不做的：<br>' +
            '· 通过页面自身的数据接口读取岗位（浏览器加载页面时本来就会请求的接口），<b>比手动翻页更密集、更易触发风控</b><br>' +
            '· 不代填你的账号密码（采集器弹的是真实浏览器，由你自己扫码登录）<br>' +
            '· <b>不自动发消息、不自动投递</b> —— 投递永远是你自己在 BOSS 里手动点<br>' +
            'AI 生成的打招呼话术也只负责生成，复制和发送由你来。' }),
        ]),
        el('div', { class: 'note warn' }, [
          el('span', { class: 'ico', text: '💾' }),
          el('div', { html:
            '数据全部存在<b>你这个浏览器</b>的 localStorage 里，不上传。' +
            '换浏览器 / 清缓存会丢，所以定期到「设置 → ⑥ 数据与备份」导出 JSON。' }),
        ]),
      ]),
      footer: [{ text: '知道了', cls: 'pri', onClick: function (c) { c(); } }],
    });
  }

  /* ==================== 版本变更提示 ====================
     改前端 JS 之后，**已经开着的旧标签页还跑着旧代码** —— 用户会看到
     "新功能怎么没有"，其实是没刷新。这里记一个版本号，发现变了就提醒一次。

     ⚠️ 每次改了 js/ 或 css/ 就把它 +1（纯前端没法自动指纹化，
        因为要支持 file:// 双击打开、不能有构建步骤）。 */
  var APP_VERSION = '2026-10-06.1';

  function checkVersionChange() {
    try {
      var seen = global.localStorage.getItem('jh.appVersion');
      global.localStorage.setItem('jh.appVersion', APP_VERSION);
      if (seen && seen !== APP_VERSION) {
        U.toastHtml('<b>工作台已经更新过了</b><br>' +
          '你这个标签页跑的还是旧代码，新功能可能看不到。<br>' +
          '按 <b>Ctrl + F5</b>（Mac 是 <b>Cmd + Shift + R</b>）强制刷新即可。',
          'warn', 22000);
        return true;
      }
    } catch (e) { /* 本地存储不可用时不提醒，这不是关键路径 */ }
    return false;
  }

  /* ==================== 启动 ==================== */
  function boot() {
    Store.init();
    applyTheme(Store.settings().theme);

    // 侧边栏状态
    try {
      if (localStorage.getItem('jh.side.collapsed') === '1') U.$('#side').classList.add('collapsed');
    } catch (e) { /* noop */ }

    buildNav();

    /* 把「一键打招呼」的开关/间隔/冷却同步给服务端（评审 P1-5）。
       ⛔ 必须早于任何一次打招呼请求 —— 用户可能在任意页面点岗位卡上的 ⚡，
          而服务端闸门读的是它自己那份配置；不先同步，服务端会因「不知道开关状态」
          而拒发（宁可拒发也不误发）。失败静默：服务端会给出可操作的提示。 */
    try {
      if (global.ApplyBoss && global.ApplyBoss.syncGreetConf) global.ApplyBoss.syncGreetConf();
    } catch (e) { /* noop */ }

    // 事件绑定
    U.$('#btnTheme').onclick = toggleTheme;
    U.$('#btnHelp').onclick = openHelp;
    U.$('#btnCollapse').onclick = toggleCollapse;
    /* ⛔ 这里原来还绑着一个"移动端汉堡菜单"按钮的 onclick。但那个按钮在 index.html
       里是 `style="display:none"`，而 css/app.css **没有任何规则覆盖这个内联样式**
       （820px 断点只把 .side 收成 62px），所以它永远不会出现 —— 纯死代码。
       已连同 index.html 里那一行一起删掉。窄屏下侧边栏本来就会收成图标栏，
       底部 ⇤ 还能手动展开，功能没丢。
       （若以后要做真正的移动端汉堡菜单，得先给它写一套浮层 CSS，不能只去掉 inline 样式。） */
    U.$('#fab').onclick = function () { U.$('#quick').classList.contains('hide') ? quickOpen() : quickHide(); };
    U.$('#quickClose').onclick = quickHide;
    U.$('#quickSend').onclick = quickSend;
    U.$('#quickInput').addEventListener('keydown', function (e) { if (e.key === 'Enter') quickSend(); });
    U.$('#quickExpand').onclick = function () { quickHide(); go('assistant', { chatId: quickChatId }); };

    global.addEventListener('hashchange', function () {
      var id = (location.hash || '').replace(/^#/, '');
      if (id && id !== current && Views[id]) go(id);
    });

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        /* Ctrl+K 是**切换**，不是只唤起 —— 帮助弹窗里承诺的是
           「唤起 / 收起 AI 快速问答」，而这里原来只调 quickOpen()，
           所以按第二次毫无反应，与文案不符（评审实测确认）。
           与右下角 💬 按钮同一套语义（见上面 #fab 的 onclick）。 */
        var q = U.$('#quick');
        if (q && !q.classList.contains('hide')) quickHide(); else quickOpen();
      }
      if (e.key === 'Escape') quickHide();
    });

    // 数据变化 → 刷新徽标；跨页面同步（多标签页）
    Store.subscribe(function () { updateNavCounts(); });

    /* ==================== 跨标签页同步 ====================
       ⛔ 这一段被三个坑反复咬过（用户截图：同一条 toast 叠了三层、页面一直闪）。

       ① **不能用前缀匹配**。一次 save() 其实要写两个 key ——
          `jobhunter.db.v1.<账号>` 和它的 `.bak`（store.js 的 save() 先备份再写）。
          前缀匹配会把「同一次保存」算成两个事件 → 两条一模一样的 toast。
          `.bak` / `.premerge` 是**同一次写入的副产物**，不是「另一个标签页的修改」。

       ② **不能整页 reload**。reload 会触发 beforeunload / pagehide
          → store.js 的 flush() → 又是一次 setItem → 对端再收到事件、再 reload
          → **两个标签页无限对刷**，toast 一条接一条。
          改成「就地换内存 + 重画当前视图」，同步动作本身不再写盘，环就断了。
          （store.js 那边另加了「内容没变不写盘」当第二重保险。）

       ③ **账号切换仍然重载** —— 那条路要重建整个账号上下文。
          它不会对刷：flush() 因为内容没变而空转。 */
    function isDerivedDbKey(k) {
      // .bak（自动备份）/ .premerge（迁移留底）：同一次写入的副产物，不是「数据被改了」
      return /\.(bak|premerge)$/.test(k);
    }
    global.addEventListener('storage', function (ev) {
      if (!ev.key) return;
      if (ev.key === 'jobhunter.current.v1') {
        U.toast('账号已在别的标签页切换，正在重新载入…', 'info');
        setTimeout(function () { location.reload(); }, 700);
        return;
      }
      if (ev.key.indexOf('jobhunter.db.v1') !== 0) return;
      if (isDerivedDbKey(ev.key)) return;
      if (ev.newValue == null || ev.newValue === ev.oldValue) return;
      // ev.newValue 就是对端刚落盘的那一整份数据；applyExternal 会挡掉
      // 非当前账号 / 解析失败的情况，成功时**只换内存、不写盘**。
      if (!Store.applyExternal(ev.key, ev.newValue)) return;
      // 静默同步：旧文案「正在重新载入…」之所以存在，只是因为过去要整页重载。
      // 现在是就地换数据，没有需要用户知道、也没有需要用户做的事。
      updateNavCounts();
      // 弹窗开着时别动底下的视图（「弹窗内只就地重画」是铁律）
      if (!document.querySelector('.mask')) refreshCurrent();
    });

    // 路由
    var start = (location.hash || '').replace(/^#/, '');
    go(Views[start] ? start : 'jobs');

    // 面试提醒：启动即查一次，之后每 60 秒一次
    setTimeout(checkReminders, 1500);
    setInterval(checkReminders, 60000);

    // 备份提醒：晚一点弹，别跟面试提醒抢同一个位置
    setTimeout(checkBackupReminder, 4200);
    setTimeout(checkVersionChange, 1200);

    // localStorage 不可用时的醒目提示
    if (!Store.persistOK) {
      setTimeout(function () {
        U.toastHtml('<b>注意：浏览器本地存储不可用</b><br>' + U.esc(Store.persistError), 'bad', 20000);
      }, 600);
    }
  }

  global.App = {
    NAV: NAV,
    go: go, refresh: refreshCurrent, topActions: topActions,
    buildNav: buildNav, updateNavCounts: updateNavCounts,
    applyTheme: applyTheme, askNotifyPermission: askNotifyPermission,
    md: mdLite, quickOpen: quickOpen, openHelp: openHelp, REMIND_BEFORE: REMIND_BEFORE,
    checkBackupReminder: checkBackupReminder, dataAgeDays: dataAgeDays,
    checkVersionChange: checkVersionChange, APP_VERSION: APP_VERSION,
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
