/* ==========================================================================
   view-jobs.js · 模块 1：岗位库
   导入（粘贴 BOSS 文本 / AI 解析）→ 列表筛选 → 详情 → 绑定投递与简历
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  /* ---------------- 筛选状态（页面级） ---------------- */
  var F = {
    kw: '', source: '', tag: '', salary: '', status: '',
    fav: false, archived: false, sort: 'new',
    view: 'card',        // card | table | company
    pref: false,         // 「⚙ 按我的偏好筛选」开关
    quick: {},           // 快捷 chips 的开关：{ high:true, noapp:true, ... }
    nlOff: false,        // 主动关掉自然语言解析（「当普通关键词搜」）
    fit: '',             // 本地「合适度」分级：'' | A | B | C | D（见 js/job-score.js）
    hideDrop: false,     // 隐藏被硬性过滤剔除的岗位（省下沟通次数）
    prefsOpen: false,    // 「⚙ 我的求职偏好」面板是否展开（偏好没填时自动展开）
    district: '',        // 区（城市下钻，见 js/geo.js）
    bizArea: '',         // 商圈（比区更细，数据来自采集结果）
    moreOpen: false,     // 「更多筛选」折叠面板是否展开（默认收起，页面太长）
  };

  /** 用户是否手动动过「按偏好筛选」—— 动过之后就不再被设置里的默认值覆盖 */
  var prefTouched = false;

  var SALARY_RANGES = [
    { v: '', l: '薪资不限' },
    { v: '0-10', l: '10K 以下' },
    { v: '10-20', l: '10-20K' },
    { v: '20-30', l: '20-30K' },
    { v: '30-999', l: '30K 以上' },
    { v: 'none', l: '未标薪资' },
  ];

  var SORTS = [
    { v: 'new', l: '最新录入' }, { v: 'old', l: '最早录入' },
    { v: 'salary', l: '薪资由高到低' }, { v: 'score', l: 'AI 匹配分由高到低' },
    { v: 'fit', l: '合适度由高到低（本地规则）' },
    { v: 'company', l: '按公司名' }, { v: 'follow', l: '最该跟进的在前' },
  ];

  /* 本地「合适度」的分级下拉项。空值 = 不按分级筛。 */
  var FIT_LEVELS = [
    { v: '', l: '合适度不限' },
    { v: 'A', l: 'A 强推（≥80）' },
    { v: 'B', l: 'B 可投（60-79）' },
    { v: 'C', l: 'C 观望（40-59）' },
    { v: 'D', l: 'D 跳过（<40）' },
  ];

  var VIEWS = [
    { v: 'card', l: '卡片', icon: '▦' },
    { v: 'table', l: '紧凑列表', icon: '☰' },
    { v: 'company', l: '按公司', icon: '🏢' },
  ];

  /* 「排序方式」和「视图」属于偏好而不是筛选条件，所以单独记住；
     筛选条件（关键词/来源/薪资…）刻意**不**持久化 —— 下次打开看到一个
     空空如也的列表、却不知道为什么空，是最劝退的体验。 */
  var PREF_KEY = 'jh.jobs.pref';
  (function restorePref() {
    try {
      var s = JSON.parse(global.localStorage.getItem(PREF_KEY) || '{}');
      if (SORTS.some(function (x) { return x.v === s.sort; })) F.sort = s.sort;
      if (VIEWS.some(function (x) { return x.v === s.view; })) F.view = s.view;
      if (typeof s.moreOpen === 'boolean') F.moreOpen = s.moreOpen;
    } catch (e) { /* 首次使用或存储不可用，用默认值 */ }
  })();
  function savePref() {
    try { global.localStorage.setItem(PREF_KEY, JSON.stringify({ sort: F.sort, view: F.view, moreOpen: F.moreOpen })); }
    catch (e) { /* noop */ }
  }

  /** 由 render() 注入：就地重画岗位页（列表 + 顶部统计），供详情弹窗等外部调用 */
  var _pageRepaint = null;
  /** 由 render() 注入：连筛选栏一起重建（排序 / 视图变了之后必须走这个） */
  var _pageRebuild = null;
  /** 当前渲染出来的偏好面板节点（就地展开用，省一次整页重建） */
  var _prefsBox = null;

  /* chipsRow 已提升到 components.js —— 采集参数卡和公司背调都要用同一个，
     三份副本早晚会飘。这里留个短别名，下面的调用点写法不变。 */
  var chipsRow = Comp.chipsRow;

  /* ---------------- 批量选择状态 ---------------- */
  var SEL = { on: false, ids: [] };
  function selHas(id) { return SEL.ids.indexOf(id) >= 0; }
  function selToggle(id) {
    var i = SEL.ids.indexOf(id);
    if (i >= 0) SEL.ids.splice(i, 1); else SEL.ids.push(id);
  }
  function selExit() { SEL.on = false; SEL.ids = []; }

  /* ==================== 渲染 ==================== */
  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    App.topActions([
      el('button', { class: 'btn pri', html: '＋ 导入 BOSS 岗位', onclick: openImport }),
      el('button', { class: 'btn', html: '🤖 按简历推荐',
        title: '用简历给一批岗位批量打匹配分，然后按分排序',
        onclick: openBatchScore }),
      el('button', { class: 'btn', html: '📥 从爬虫结果导入', title: '导入 boss-crawler 跑出来的 qualified_jobs.json / csv', onclick: doImportCrawler }),
      el('button', { class: 'btn', html: '✎ 手动新增', onclick: function () { openJobForm(null); } }),
      el('button', { class: 'btn icon', html: '⤓', title: '导出岗位库 CSV', onclick: function () { Exporter.exportJobsCSV(); } }),
    ]);

    // 设置里勾了「进入岗位库默认应用偏好」就自动带上。
    // ⚠️ 只在用户没手动动过那个开关时生效 —— 否则用户刚关掉、一切页再回来又被打开，
    //    会以为"这个开关根本关不掉"。
    if (!prefTouched) F.pref = !!((Store.settings().prefs || {}).autoApply);

    var note = Comp.aiReadyNote();
    if (note) wrap.appendChild(note);

    // 顶部统计条
    var statBox = buildStatStrip();
    wrap.appendChild(statBox);

    // 筛选卡
    wrap.appendChild(buildFilterBar());

    // 当前生效的筛选条件汇总（逐个可移除）
    var chipsBox = el('div');
    wrap.appendChild(chipsBox);

    // 列表
    var listBox = el('div');
    wrap.appendChild(listBox);

    // 批量操作条（只在批量模式出现）
    var barBox = el('div');
    wrap.appendChild(barBox);

    function paintStats() {
      // 就地替换统计条。之前这块只在 render 时建一次，
      // 所以在详情弹窗里收藏/归档后，顶部数字要等切页才更新。
      var fresh = buildStatStrip();
      wrap.replaceChild(fresh, statBox);
      statBox = fresh;
    }

    function paintChips() {
      chipsBox.innerHTML = '';
      var box = buildFilterChips(rebuild);
      if (box) chipsBox.appendChild(box);
    }

    function paintBar() {
      barBox.innerHTML = '';
      if (!SEL.on) return;
      barBox.appendChild(buildBatchBar(paint, rebuild));
    }

    function paintList() {
      var jobs = filterJobs();
      listBox.innerHTML = '';
      var st = Store.stats();
      var onlySort = F.sort !== 'new';       // 只调排序、没筛条件时不算"已筛选"
      var hasFilter = !!(F.kw || F.source || F.tag || F.salary || F.status || F.fav || F.archived ||
        onlySort || F.pref || hasQuickOn());
      var archNote = F.archived ? '，其中已归档 ' + st.jobArchived + ' 个' : '';

      // 以前的文案是「共 N 个岗位（已筛选，总共 M 个）」，
      // 实际会出现「共 1 个岗位（已筛选，总共 0 个）」这种自相矛盾的组合
      // （归档把岗位从 active 里拿掉了）。现在统一成一眼能对上的说法。
      var headText = hasFilter
        ? '显示 ' + jobs.length + ' 个 · 在库共 ' + st.jobTotal + ' 个' + archNote
        : '共 ' + jobs.length + ' 个岗位' + archNote;

      var head = el('div', { class: 'row', style: 'margin-bottom:10px' }, [
        el('b', { class: 'fs13', text: headText }),
        hasFilter ? el('button', {
          class: 'btn xs', text: '清空筛选',
          onclick: function () { resetFilters(); rebuild(); },
        }) : null,
        el('span', { class: 'sp' }),
        st.jobTotal > 0 ? el('button', {
          class: 'btn xs danger', html: '🗑 一键清空',
          title: '把整个岗位库（含归档）一次删空，删除后可撤销',
          onclick: function () { clearAllJobs(function () { repaintAll(); }); },
        }) : null,
        el('button', {
          class: 'btn xs' + (SEL.on ? ' pri' : ''), html: SEL.on ? '☑ 退出批量' : '☑ 批量操作',
          title: '勾选多个岗位，批量收藏 / 归档 / 打标签 / 删除',
          onclick: function () {
            if (SEL.on) { selExit(); } else { SEL.on = true; SEL.ids = []; }
            repaintAll();
          },
        }),
        F.view === 'card' ? el('span', { class: 'muted fs12', text: '点击卡片查看详情' }) : null,
      ].filter(Boolean));
      listBox.appendChild(head);

      if (!jobs.length) {
        if (Store.stats().jobTotal === 0) {
          listBox.appendChild(Comp.empty('🗂️', '岗位库还是空的',
            '把 BOSS 上的岗位文本粘进来，AI 会自动拆成结构化字段。<br>也可以在设置页一键载入示例数据先试玩。',
            '＋ 导入第一个岗位', openImport));
        } else if (F.pref) {
          // 偏好筛选最容易被误解成"岗位丢了"—— 这里必须说清是偏好筛的，并给两个出口
          var P = prefsOf();
          listBox.appendChild(el('div', { class: 'empty' }, [
            el('div', { class: 'big', text: '🎯' }),
            el('b', { text: '没有符合你偏好的岗位' }),
            el('p', { html: '当前偏好：<b>' + U.esc(global.JobMatch.describePref(P)) + '</b><br>' +
              '<span class="fs12">在库共 ' + Store.stats().jobTotal + ' 个岗位，是这些条件把它们全筛掉了。</span>' }),
            el('div', { class: 'row', style: 'justify-content:center;gap:8px' }, [
              el('button', { class: 'btn pri', text: '⚙ 去调整偏好',
                onclick: function () { F.prefsOpen = true; rebuild(); } }),
              el('button', { class: 'btn', text: '取消偏好筛选',
                onclick: function () { F.pref = false; prefTouched = true; rebuild(); } }),
              el('button', { class: 'btn ghost', text: '清空全部筛选',
                onclick: function () { resetFilters(); rebuild(); } }),
            ]),
          ]));
        } else {
          listBox.appendChild(Comp.empty('🔍', '没有符合条件的岗位', '试着放宽筛选条件，或清空关键词。',
            '清空筛选', function () { resetFilters(); rebuild(); }));
        }
        return;
      }

      if (F.view === 'table') listBox.appendChild(jobTable(jobs, repaintAll));
      else if (F.view === 'company') listBox.appendChild(companyGroups(jobs, repaintAll, rebuild));
      else {
        var grid = el('div', { class: 'job-list' });
        jobs.forEach(function (j) { grid.appendChild(jobCard(j, repaintAll)); });
        listBox.appendChild(grid);
      }
    }

    function paint() {
      paintList();
      paintChips();
      paintBar();
    }

    /** 列表 + 顶部统计条一起就地重画（不改路由、不整页重绘，避免无限渲染循环） */
    function repaintAll() {
      // 页面已经切走时 wrap 会被摘下来。这时再画就是往幽灵节点上写，
      // 白费功夫还可能被误当成"刷新成功"。parentNode 为空 = 我不在页面上，直接让位。
      if (!wrap.parentNode) return;
      paint();
      paintStats();
    }

    function rebuild() {
      // 重建筛选卡（保持状态）
      var old = wrap.querySelector('[data-filterbar]');
      var fresh = buildFilterBar();
      wrap.replaceChild(fresh, old);
      repaintAll();
    }

    // 详情弹窗等外部入口（Views.jobs.detail）拿不到 render 作用域里的 repaintAll，
    // 挂到模块级，让 openDetail 里也能就地刷新这一页。
    _pageRepaint = repaintAll;
    _pageRebuild = rebuild;

    repaintAll();
  }

  function resetFilters() {
    F.kw = ''; F.source = ''; F.tag = ''; F.salary = ''; F.status = '';
    F.fav = false; F.archived = false; F.sort = 'new';
    F.fit = ''; F.hideDrop = false;
    F.district = ''; F.bizArea = '';      // 地理筛选也要被「重置」清掉
    // 「重置」要连偏好开关和快捷 chips 一起清掉 —— 否则用户以为重置了，
    // 列表却还是被偏好悄悄筛过的那批，只会更迷惑。
    F.pref = false;
    prefTouched = true;
    F.quick = {};
    F.nlOff = false;
    // view 是展示偏好，不是筛选条件 —— 重置筛选时不该把视图也弹回卡片
    savePref();
    selExit();
  }

  /* ---------------- 一键清空岗位库 ---------------- */
  /**
   * 把整个岗位库（含归档）一次性删空。
   * 与「批量删除」的区别：不用先勾选，一个按钮清到底；但因为是高危操作，
   * ① 先弹危险确认框并列出会删多少岗位、连带多少投递/面试；
   * ② 走 Store.takeOut 拿快照 + trashToast 的「撤销」按钮 —— 误删也能一键救回。
   * 删完自动重置筛选、退出批量、就地重画，不用手动再点「清空筛选」。
   */
  function clearAllJobs(onAfter) {
    var st = Store.stats();
    var jobs = Store.jobs({ includeArchived: true });
    if (!jobs.length) { U.toast('岗位库已经是空的', 'info'); return; }

    // 连带统计：删岗位会把它的投递、面试一起带走（takeOut 的副作用）
    var appCount = 0, ivCount = 0;
    jobs.forEach(function (j) {
      if (Store.appOfJob(j.id)) appCount++;
      ivCount += Store.interviews({ jobId: j.id }).length;
    });

    var detail = '将删除 ' + jobs.length + ' 个岗位（含已归档 ' + st.jobArchived + ' 个）';
    if (appCount || ivCount) detail += '，并连带 ' + (appCount ? appCount + ' 条投递' : '') +
      (appCount && ivCount ? '、' : '') + (ivCount ? ivCount + ' 场面试' : '');
    detail += '。';

    U.confirm(
      '确定要清空整个岗位库吗？<br><span class="muted fs12">' + U.esc(detail) +
      '</span><br><span class="muted fs12">删除后可用「撤销」一键救回；也可先到设置页导出备份。</span>',
      { title: '清空岗位库', danger: true, okText: '全部删除' }
    ).then(function (ok) {
      if (!ok) return;
      var ids = jobs.map(function (j) { return j.id; });
      var snap = Store.takeOut({ jobs: ids });
      // 清空后筛选条件、批量选中态都没意义了，一起复位
      resetFilters();
      App.updateNavCounts();
      if (onAfter) { try { onAfter(); } catch (e) { /* noop */ } }
      Comp.trashToast('已清空 ' + jobs.length + ' 个岗位' +
        (appCount || ivCount ? '（连带 ' + appCount + ' 条投递、' + ivCount + ' 场面试）' : ''),
        snap, function () { if (onAfter) { try { onAfter(); } catch (e) { /* noop */ } } });
    });
  }

  /* ---------------- 筛选来源：偏好 / 快捷 chips / 自然语言 ---------------- */

  function prefsOf() { return global.JobMatch.prefs(); }

  function hasQuickOn() {
    return global.JobMatch.QUICK.some(function (d) { return !!F.quick[d.k]; });
  }

  /**
   * 当前搜索框里的自然语言解析结果。
   * ⚠️ 不做缓存、每次现算：F.kw 是唯一事实来源，缓存一份 F.nl 很容易
   * 出现「清了关键词但 nl 还留着」这种幽灵筛选。
   */
  function currentQuery() {
    if (F.nlOff || !F.kw) return null;
    return global.JobMatch.parseQuery(F.kw);
  }

  /** 「⚙ 按我的偏好筛选」开关 */
  function togglePrefFilter() {
    if (!F.pref) {
      var p = prefsOf();
      if (!global.JobMatch.hasPref(p)) {
        /* ⚠️ 就地展开偏好面板，**不跳设置页** —— 跳页等于让用户自己去另一个页面
           找刚才想填的那个字段。面板就在按钮下面，展开是最短的路径。 */
        F.prefsOpen = true;
        F.moreOpen = true;   // 偏好面板在折叠面板里，展开偏好的同时展开折叠面板
        U.toast('还没填求职偏好 —— 面板已经展开，填上目标城市 / 薪资底线 / 不能接受的点就能一键筛了。', 'warn', 8000);
        App.refresh();
        return;
      }
      F.pref = true;
      prefTouched = true;
      U.toast('已按你的偏好筛选：' + global.JobMatch.describePref(p), 'ok', 7000);
    } else {
      F.pref = false;
      prefTouched = true;
    }
    App.refresh();
  }

  /** 快捷 chip 的开关。偏好没填就先就地展开面板，别让它假装生效。 */
  function toggleQuick(k) {
    var d = global.JobMatch.quickDef(k);
    if (!d) return;
    if (!F.quick[k] && !global.JobMatch.quickReady(k)) {
      F.prefsOpen = true;
      F.moreOpen = true;   // 偏好面板在折叠面板里，展开偏好的同时展开折叠面板
      U.toast('这个快捷筛选要先填求职偏好 —— 面板已经展开，' +
        (k === 'salary' ? '填上「薪资底线」。' : '填上「不能接受的点」。'), 'warn', 8000);
      App.refresh();
      return;
    }
    F.quick[k] = !F.quick[k];
    App.refresh();
  }

  /**
   * 某个 chip 单独生效时能剩下几个岗位 —— 显示在 chip 上。
   * 算的时候把其它条件都算进去、只切换这一个 chip，
   * 所以数字就是「点下去会剩几个」，跟当前结果数是一套口径。
   */
  function quickCount(k) {
    var saved = F.quick[k];
    F.quick[k] = true;
    // ⚠️ try/finally：万一 filterJobs 抛了，也不能把 F.quick 留在"被改过"的状态，
    // 否则这个 chip 会莫名其妙一直是开的。
    try { return filterJobs().length; }
    finally { F.quick[k] = saved; }
  }

  /**
   * 「🤖 按简历推荐」—— 给一批岗位批量打匹配分，跑完自动按分排序。
   * 采集回来的 30 个岗位，不该让用户手点 30 次。
   */
  function openBatchScore() {
    var all = Store.jobs({ includeArchived: false });
    if (!all.length) {
      U.toast('岗位库还是空的。先导入或采集一批岗位，再让简历来筛。', 'warn', 5000);
      return;
    }
    var scopes = [{ label: '全库（不含归档）', jobs: all }];
    // 只有真的筛过、且结果跟全库不一样时才给第二个范围 ——
    // 否则两个选项是同一批岗位，只会让用户犹豫。
    var cur = filterJobs();
    if (cur.length && cur.length !== all.length) {
      scopes.unshift({ label: '当前筛选结果', jobs: cur });
    }
    global.JobMatch.openBatch({
      scopes: scopes,
      afterRun: function () { if (_pageRebuild) _pageRebuild(); },
    });
  }

  /* ---------------- 筛选条件汇总条 ---------------- */
  function salaryLabel(v) {
    var hit = SALARY_RANGES.filter(function (x) { return x.v === v; })[0];
    return hit ? hit.l : v;
  }
  function sortLabel(v) {
    var hit = SORTS.filter(function (x) { return x.v === v; })[0];
    return hit ? hit.l : v;
  }

  /** 当前生效的条件 → [{k, label, soft}]，soft 表示"不算筛选、只是排序" */
  function activeFilters() {
    var out = [];
    if (F.kw) out.push({ k: 'kw', label: '关键词：' + F.kw });
    if (F.source) out.push({ k: 'source', label: '来源：' + (F.source === 'boss' ? 'BOSS 导入' : '手动新增') });
    if (F.status) out.push({ k: 'status', label: '状态：' + (F.status === 'none' ? '未投递' : Store.statusName(F.status)) });
    if (F.salary) out.push({ k: 'salary', label: '薪资：' + salaryLabel(F.salary) });
    if (F.tag) out.push({ k: 'tag', label: '标签：' + F.tag });
    /* 区 / 商圈：没采到区或商圈的岗位**不会被这两条筛掉**（见 filterJobs 里的说明），
       所以文案写清「未采到的也保留」—— 否则用户会以为筛干净了。 */
    if (F.district) out.push({ k: 'district', label: '📍 区：' + F.district });
    if (F.bizArea) out.push({ k: 'bizArea', label: '📍 商圈：' + F.bizArea });
    if (F.fav) out.push({ k: 'fav', label: '只看收藏' });
    if (F.archived) out.push({ k: 'archived', label: '含已归档' });
    if (F.fit) out.push({ k: 'fit', label: '🎯 合适度 ' + F.fit + ' 级' });
    if (F.hideDrop) out.push({ k: 'hideDrop', label: '已隐藏被剔除的岗位' });
    // 偏好与快捷 chip 也是筛选条件，必须出现在汇总条里 ——
    // 不然用户会看到"列表少了一半，但汇总条上一个字都没写"。
    if (F.pref) out.push({ k: 'pref', label: '⚙ 按我的偏好' });
    global.JobMatch.QUICK.forEach(function (d) {
      if (F.quick[d.k]) out.push({ k: 'q:' + d.k, label: d.icon + ' ' + d.label });
    });
    if (F.sort !== 'new') out.push({ k: 'sort', label: '排序：' + sortLabel(F.sort), soft: true });
    return out;
  }

  function clearOne(k) {
    if (k === 'pref') { F.pref = false; prefTouched = true; return; }
    if (k.indexOf('q:') === 0) { F.quick[k.slice(2)] = false; return; }
    if (k === 'fav' || k === 'archived' || k === 'hideDrop') F[k] = false;
    else if (k === 'sort') { F.sort = 'new'; savePref(); }
    else F[k] = '';
  }

  /**
   * 「已筛选：BOSS · 10-20K · 只看收藏 ✕」汇总条。
   * 之前选完四五个下拉框之后，页面上没有任何地方能看出"现在到底筛了什么"，
   * 只能挨个把下拉框翻一遍 —— 列表空了会以为是数据没了。
   */
  function buildFilterChips(onChange) {
    var list = activeFilters();
    if (!list.length) return null;
    var hard = list.filter(function (x) { return !x.soft; });

    var bar = el('div', { class: 'fbar' }, [
      el('span', { class: 'lb', text: hard.length ? '已筛选' : '排序' }),
      el('div', { class: 'chips' }, list.map(function (x) {
        return el('span', {
          class: 'tag ' + (x.soft ? 'line' : 'brand'),
          html: U.esc(x.label) + ' <span class="x" title="移除这个条件">✕</span>',
          onclick: function () { clearOne(x.k); onChange(); },
        });
      })),
      el('span', { class: 'sp' }),
      el('button', {
        class: 'btn xs ghost', text: '✕ 清除全部',
        onclick: function () { resetFilters(); onChange(); },
      }),
    ]);
    return bar;
  }

  /* ---------------- 统计条 ---------------- */
  function buildStatStrip() {
    var st = Store.stats();
    var box = el('div', { class: 'grid g4' });
    [
      // 这个数其实是「在库（未归档）岗位数」，归档后变成 0 会让人以为岗位丢了。
      // 所以标签写清楚，归档数单独一项展示（下面第三张卡）。
      { k: '在库岗位', v: st.jobTotal, d: 'BOSS ' + st.jobBoss + ' · 手动 ' + st.jobManual + '（不含归档）', c: 'c-brand', icon: '🗂️' },
      { k: '收藏', v: st.jobFavorite, d: '准备重点跟进（不含已归档）', c: 'c-warn', icon: '⭐' },
      { k: '还没投的', v: st.jobNoApp, d: '岗位池里的存货', c: 'c-info', icon: '📥' },
      { k: '已归档', v: st.jobArchived, d: '不参与筛选与统计', c: 'c-purple', icon: '📦' },
    ].forEach(function (s) {
      box.appendChild(el('div', { class: 'stat ' + s.c }, [
        el('div', { class: 'k', html: s.icon + ' ' + s.k }),
        el('div', { class: 'v', text: s.v }),
        el('div', { class: 'd', text: s.d }),
      ]));
    });
    return box;
  }

  /**
   * S1-B · 筛选栏里的「⚖ 冲突 N」入口。
   * 没有待处理冲突时返回 null（调用方直接 append 也不会有空壳）。
   *
   * ⛔ 为什么是函数而不是常量节点：
   *    冲突数会随「采纳 / 忽略」变化。写成常量的话，采纳完一条
   *    徽章上的数字还停在旧值，用户会以为没生效。
   */
  function conflictEntry() {
    if (!global.Views.conflicts) return null;
    /* rebuild 会整张筛选卡换新 → 顺便把冲突面板的刷新也接上 */
    return global.Views.conflicts.entryChip(function () {
      global.Views.conflicts.open(function () { if (_pageRebuild) _pageRebuild(); });
    });
  }

  /* ---------------- 筛选栏 ---------------- */
  function buildFilterBar() {
    var tags = Store.allTags();
    var card = el('div', { class: 'card', 'data-filterbar': '1' });
    var body = el('div', { class: 'body tight' });

    var kw = el('input', { type: 'text',
      // data-focus-key：整页重画后靠它把焦点还回来（评审 4.1）
      'data-focus-key': 'job-kw',
      placeholder: '搜索岗位 / 公司 / JD，也可以写「杭州 运营 15k 不要外包」', style: 'max-width:340px' });
    kw.value = F.kw;
    kw.addEventListener('input', U.debounce(function () {
      F.kw = kw.value.trim();
      F.nlOff = false;      // 重新输入 = 重新按自然语言解析
      repaint();
    }, 180));

    var selSource = mkSelect([{ v: '', l: '全部来源' }, { v: 'boss', l: 'BOSS 导入' }, { v: 'manual', l: '手动新增' }], F.source, function (v) { F.source = v; repaint(); });
    var selStatus = mkSelect(
      [{ v: '', l: '全部状态' }, { v: 'none', l: '未投递' }].concat(
        Store.STATUSES.map(function (s) { return { v: s.id, l: s.name }; })),
      F.status, function (v) { F.status = v; repaint(); });
    var selSalary = mkSelect(SALARY_RANGES.map(function (x) { return { v: x.v, l: x.l }; }), F.salary, function (v) { F.salary = v; repaint(); });
    var selSort = mkSelect(SORTS.map(function (x) { return { v: x.v, l: x.l }; }), F.sort, function (v) { F.sort = v; savePref(); repaint(); });
    var selFit = mkSelect(FIT_LEVELS.map(function (x) { return { v: x.v, l: x.l }; }), F.fit, function (v) { F.fit = v; repaint(); });

    /* --- 区 / 商圈：比城市更细的一层（数据来自采集结果，见 js/geo.js）---
       选项**只列真实采到过的**，不内置猜的清单（凭印象列商圈名 = 编造，
       用户照着假清单筛会静默漏岗位）。区还额外合并了公开行政区划作候选。
       一个都没有时至少还有「全部区 / 全部商圈」这一项，不会出现空下拉。 */
    var allJobsGeo = Store.jobs({ includeArchived: false }) || [];
    var selDistrict = mkSelect(
      [{ v: '', l: '全部区' }].concat(global.GEO.districtsOf('', allJobsGeo)
        .map(function (d) { return { v: d, l: d }; })),
      F.district, function (v) { F.district = v; repaint(); });
    var selBiz = mkSelect(
      [{ v: '', l: '全部商圈' }].concat(global.GEO.bizAreasOf([], allJobsGeo)
        .map(function (d) { return { v: d, l: d }; })),
      F.bizArea, function (v) { F.bizArea = v; repaint(); });

    var P = prefsOf();
    var prefReady = global.JobMatch.hasPref(P);

    /* --- 核心行：最常用的几个条件留明面，其余收进「更多筛选」折叠面板。
       折叠是为了「筛选页面太长」—— 一屏先看到关键词和常用下拉，
       细筛（区/商圈/合适度/偏好/快捷/标签）默认藏起来，点一下展开。 --- */
    var moreBadge = '';
    var moreCount = 0;
    // 数一下「更多筛选」里当前激活了多少条件，好在按钮上给个角标提示
    ['district', 'bizArea', 'fit'].forEach(function (k) { if (F[k]) moreCount++; });
    if (F.fav) moreCount++; if (F.archived) moreCount++;
    if (F.pref) moreCount++;
    if (Object.keys(F.quick || {}).some(function (k) { return F.quick[k]; })) moreCount++;
    if (F.tag) moreCount++;
    if (moreCount) moreBadge = ' <b class="more-badge">' + moreCount + '</b>';

    body.appendChild(el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
      kw, selSource, selStatus, selSalary, selSort,
      el('button', {
        class: 'btn sm ghost', 'data-more-toggle': '1',
        html: (F.moreOpen ? '▲ 收起筛选' : '▼ 更多筛选') + moreBadge,
        title: F.moreOpen ? '收起高级筛选' : '展开高级筛选（区/商圈/合适度/偏好/快捷/标签）',
        onclick: function () { F.moreOpen = !F.moreOpen; savePref(); App.refresh(); },
      }),
      el('span', { class: 'sp' }),
      // S1-B · 冲突待处理面板入口（有冲突才出现，N=0 时返回 null 不占位）
      conflictEntry(),
      el('button', { class: 'btn sm ghost', text: '重置', onclick: function () { resetFilters(); App.refresh(); } }),
    ]));

    /* --- 高级筛选折叠面板 --- */
    var more = el('div', { class: 'more-panel' + (F.moreOpen ? '' : ' hide'), 'data-more': '1' });

    // 第一行：区 / 商圈 / 合适度 + 收藏/归档
    more.appendChild(el('div', { class: 'row', style: 'gap:8px;margin-top:9px;flex-wrap:wrap' }, [
      selDistrict, selBiz, selFit,
      el('label', { class: 'chk' }, [
        mkCheck(F.fav, function (v) { F.fav = v; repaint(); }), el('span', { text: '只看收藏' }),
      ]),
      el('label', { class: 'chk' }, [
        mkCheck(F.archived, function (v) { F.archived = v; repaint(); }), el('span', { text: '含归档' }),
      ]),
    ]));

    /* --- 一键按偏好筛选 + 偏好面板 ---
       做成开关而不是一次性动作：用户得能看出"现在是开着还是关着"，
       也得能再点一次退回来。偏好没填时不禁用，点了会**就地展开下面的面板**
       （早先是跳去设置页 —— 跳页 = 用户得自己在另一个页面里找刚才那个字段）。 --- */
    more.appendChild(el('div', { class: 'row', style: 'margin-top:9px;gap:8px' }, [
      el('button', {
        class: 'btn sm' + (F.pref ? ' pri' : ''),
        html: '⚙ 按我的偏好筛选' + (F.pref ? '（已开启）' : ''),
        title: prefReady
          ? '偏好：' + global.JobMatch.describePref(P) + '　（再点一次取消）'
          : '还没填过求职偏好，点了会就地展开下面的面板',
        onclick: togglePrefFilter,
      }),
      el('span', { class: 'fs12 muted', text: prefReady
        ? '偏好就是这个筛子；要改就展开右边面板（改完即时生效）'
        : '还没设置偏好 —— 点左边的按钮，面板会就地展开' }),
    ]));

    /* 面板直接挂在筛选卡里：改完立刻能看到列表变化，不用来回跳页 */
    more.appendChild(prefsPanel(repaintKeepFocus));

    /* --- 自然语言解析小字 ---
       用户敲了「杭州 运营 15k」，得知道系统理解成什么了；
       理解错了要能一键退回普通关键词搜索。 --- */
    var q = currentQuery();
    if (q && q.matched) {
      more.appendChild(el('div', { class: 'nlhint' }, [
        el('span', { text: '理解为：' }),
        el('span', { class: 'nk', text: global.JobMatch.describeQuery(q) }),
        el('span', { class: 'nl-clear', text: '当普通关键词搜', title: '不做解析，整串当关键词去匹配',
          onclick: function () { F.nlOff = true; App.refresh(); } }),
      ]));
    }

    /* --- 快捷筛选 chips ---
       一行"一点就筛、再点取消"的开关。多个可叠加（AND）。
       每个 chip 上的数字 = 单独点下它会剩下几个岗位，省得点进去才发现是空的。 --- */
    var qrow = el('div', { class: 'qchips' });
    qrow.appendChild(el('span', { class: 'lb', text: '快捷筛选' }));
    global.JobMatch.QUICK.forEach(function (d) {
      var on = !!F.quick[d.k];
      var ok = global.JobMatch.quickReady(d.k, P);
      var n = quickCount(d.k);
      qrow.appendChild(el('span', {
        class: 'qchip' + (on ? ' on' : '') + (ok ? '' : ' need'),
        title: ok ? d.title : d.title + '（需要先在「⚙ 我的求职偏好」里填）',
        onclick: function () { toggleQuick(d.k); },
      }, [
        el('span', { text: d.icon + ' ' + d.label }),
        el('span', { class: 'qchip-n', text: ' ' + n }),
      ]));
    });
    qrow.appendChild(el('span', { class: 'sp' }));
    if (hasQuickOn()) {
      qrow.appendChild(el('button', {
        class: 'btn xs ghost', text: '✕ 取消快捷筛选',
        onclick: function () { F.quick = {}; App.refresh(); },
      }));
    }
    more.appendChild(qrow);

    /* --- 合适度分级条 ---
       本地规则打分（零 token）。放这儿的理由：用户看一眼就知道
       "手上这批货成色怎么样"，而不是逐个点进去判断。 */
    var fs = fitSummary();
    var fitRow = el('div', { class: 'fitbar' });
    fitRow.appendChild(el('span', { class: 'lb', text: '🎯 合适度' }));
    global.JobScorer.levels().forEach(function (lv) {
      var n = fs[lv.key] || 0;
      var on = F.fit === lv.key;
      fitRow.appendChild(el('span', {
        class: 'fchip ' + lv.cls + (on ? ' on' : '') + (n ? '' : ' zero'),
        title: lv.label + '：' + lv.advice + '（点一下只看这一级，再点取消）',
        onclick: function () { F.fit = on ? '' : lv.key; repaint(); },
      }, [
        el('span', { text: lv.key + ' ' + lv.label }),
        el('span', { class: 'fchip-n', text: ' ' + n }),
      ]));
    });
    if (fs.drop) {
      fitRow.appendChild(el('span', {
        class: 'fchip bad' + (F.hideDrop ? ' on' : ''),
        title: '硬性过滤判定为「不值得投」的岗位（城市不符 / 岗位实质不符 / 命中不能接受的点）。点一下隐藏它们。',
        onclick: function () { F.hideDrop = !F.hideDrop; repaint(); },
      }, [el('span', { text: (F.hideDrop ? '已隐藏 ' : '剔除 ') + fs.drop })]));
    }
    fitRow.appendChild(el('span', { class: 'sp' }));
    fitRow.appendChild(el('span', {
      class: 'fs11 muted',
      text: '本地规则打分 · 零成本可解释' + (fs.blind ? '（其中 ' + fs.blind + ' 个 JD 没采到，只看了标题）' : ''),
    }));
    fitRow.appendChild(el('button', {
      class: 'btn xs ghost', text: '怎么算的',
      onclick: function () { global.JobScorer.openHelp(); },
    }));
    more.appendChild(fitRow);

    // 标签 chips 也放进折叠面板（它们占一整行，且只在有标签时才出现）
    if (tags.length) {
      var chipRow = el('div', { class: 'chips', style: 'margin-top:9px' });
      chipRow.appendChild(el('span', { class: 'muted fs12', text: '标签：' }));
      if (F.tag) {
        chipRow.appendChild(el('span', { class: 'tag brand', html: U.esc(F.tag) + ' <span class="x">✕</span>',
          onclick: function () { F.tag = ''; App.refresh(); } }));
        chipRow.appendChild(el('span', { class: 'muted fs12', text: '（已选中）' }));
      } else {
        tags.slice(0, 14).forEach(function (t) {
          chipRow.appendChild(el('span', {
            class: 'tag pointer', style: 'cursor:pointer', html: U.esc(t.tag) + ' <span class="muted">' + t.n + '</span>',
            onclick: function () { F.tag = t.tag; App.refresh(); },
          }));
        });
      }
      chipRow.appendChild(el('button', {
        class: 'btn xs ghost', text: '⚙ 管理标签',
        title: '重命名 / 删除标签，看每个标签用了多少次',
        onclick: openTagManager,
      }));
      more.appendChild(chipRow);
    }

    body.appendChild(more);

    // 视图切换：卡片扫读 / 表格对比 / 按公司聚合
    var seg = el('div', { class: 'seg' });
    VIEWS.forEach(function (x) {
      seg.appendChild(el('button', {
        class: F.view === x.v ? 'on' : '', html: x.icon + ' ' + x.l,
        title: x.v === 'card' ? '卡片：信息最全，适合逐个看'
          : x.v === 'table' ? '紧凑列表：一屏看更多，适合批量扫'
            : '按公司：同一家公司的岗位归到一起，看清投了几家',
        onclick: function () { F.view = x.v; savePref(); App.refresh(); },
      }));
    });

    body.appendChild(el('div', { class: 'row', style: 'margin-top:9px' }, [
      seg,
      el('span', { class: 'sp' }),
      el('span', { class: 'hint tiny', html: F.view === 'table' ? '紧凑模式：点行进详情'
        : F.view === 'company' ? '按公司分组，点公司名展开'
          : '排序与视图会自动记住，下次打开还是这个样子' }),
    ]));

    card.appendChild(body);
    return card;
  }

  /* ==================== ⚙ 我的求职偏好（搬进岗位库） ====================
     为什么放这儿而不是设置页：这份偏好恰好决定本页面的两件事 ——
     「⚙ 按我的偏好筛选」和「合适度」。放设置页 = 每改一次都要跳两次页才看得到效果。

     ⚠️ **即时生效，没有「保存偏好」按钮**。上一版是"改完记得点保存"，
        结果就踩了本项目的经典坑：「改了没生效」和「生效了但用户以为没生效」
        在界面上长得一模一样。改成即时落盘后，这一类问题整体消失。 */

  /** 用户刚在 JobPicker 里选的期望岗位草稿（已落盘，这里只是渲染源） */
  var prefDraftExpect = null;

  function prefsPanel(afterChange) {
    var prefs = Store.settings().prefs || {};
    var box = el('div', { class: 'prefsbox' + (F.prefsOpen ? ' open' : ''), 'data-prefsp': '1' });
    _prefsBox = box;

    var sumEl = el('span', { class: 'prefs-sum fs12',
      text: global.JobMatch.describePref(global.JobMatch.prefs()) });
    var chev = el('span', { class: 'prefs-chev', text: F.prefsOpen ? '收起 ▴' : '展开 ▾' });

    /* 展开 / 收起只切 class，**不重建筛选卡** —— 重建会打断正在输入的框、
       也会把刚选好还没落盘的控件状态清掉。 */
    var head = el('div', { class: 'prefshead', title: '展开 / 收起我的求职偏好',
      onclick: function (e) {
        if (e.target.closest('button')) return;
        var willOpen = !box.classList.contains('open');
        // 偏好面板挂在「更多筛选」折叠面板里 —— 展开偏好时若折叠面板还收着，
        // 用户点完会看不到（面板被 hide 藏住）。这里走整页重建把折叠面板一起展开。
        if (willOpen && !F.moreOpen) { F.moreOpen = true; App.refresh(); return; }
        box.classList.toggle('open', willOpen);
        F.prefsOpen = willOpen;
        chev.textContent = willOpen ? '收起 ▴' : '展开 ▾';
      } }, [
      el('b', { class: 'fs13', text: '⚙ 我的求职偏好' }),
      el('span', { class: 'fs11 muted', text: '决定「按偏好筛选」和「合适度」的口径 · 改完即时生效' }),
      el('span', { class: 'sp' }),
      sumEl,
      chev,
    ]);
    box.appendChild(head);

    var body = el('div', { class: 'prefsbody' });
    box.appendChild(body);

    /* 一次落盘 → 同步摘要 + 重画列表。重画只走「列表 + 顶部统计 + 筛选条件条」，
       **不碰筛选卡**，所以在输入框里打字不会掉焦点。 */
    function commit(key, val) {
      Store.setSetting('prefs.' + key, val);
      sumEl.textContent = global.JobMatch.describePref(global.JobMatch.prefs());
      if (afterChange) afterChange();
    }

    /* 文本框输入：**落盘立刻做，重画才防抖**。两件事的代价差得很远 ——
       落盘是一次几 KB 的 localStorage 写，而重画要把岗位库几百张卡片重新建一遍。
       早先两件事一起防抖，结果是「刚敲完字，库里还是旧值」这种"没生效"的错觉。 */
    var paintSoon = U.debounce(function () { if (afterChange) afterChange(); }, 420);
    function commitSoon(key, val) {
      Store.setSetting('prefs.' + key, val);
      sumEl.textContent = global.JobMatch.describePref(global.JobMatch.prefs());
      paintSoon();
    }

    /* --- ⤒ 反方向：把「采集岗位」页当前的条件存成这里的偏好 ---
       ⛔ 只写 prefs.*（绝不回头动采集页的 jh.collectForm）——
          两边是两套数据，"互不影响"是硬要求。 */
    function pullFromCollect() {
      if (!global.CollectPrefs || !global.Views || !global.Views.collect) {
        U.toast('采集模块没加载（js/collect-prefs.js 或 js/view-collect.js）', 'bad');
        return;
      }
      var plan = global.Views.collect._prefsPushPlan();
      if (!plan) {
        U.toast('还没有「当前采集条件」可搬 —— 先去「📡 采集岗位」页把要搜的条件填一次，再回来点这个按钮。', 'warn', 9000);
        return;
      }
      Comp.planDialog({
        title: '⤒ 把采集条件存为我的求职偏好',
        subtitle: '把「📡 采集岗位」页<b>当前填着</b>的条件搬到这里。<b>不会动采集页</b> —— ' +
          '两边是两套独立数据。',
        steps: plan.steps,
        emptyText: '采集页那几项要么是空的、要么和偏好已经一样，<b>没有要改的</b>。',
        confirmText: '写入这 ' + plan.steps.length + ' 项',
        patch: plan.patch,
        onConfirm: function (patch) {
          if (!patch) return;
          var keys = Object.keys(patch);
          keys.forEach(function (k) { Store.setSetting('prefs.' + k, patch[k]); });
          U.toastHtml('已把采集页的 <b>' + keys.length + '</b> 项存成偏好（采集页没动）', 'ok', 5000);
          setTimeout(function () { App.refresh(); }, 0);
        },
      });
    }
    body.appendChild(el('div', { class: 'syncbar' }, [
      el('span', { class: 'fs11 muted', text: '📡 采集页' }),
      el('button', {
        class: 'btn xs', type: 'button', html: '⤒ 用采集页的条件',
        title: '把「📡 采集岗位」页当前填着的城市 / 岗位期望 / 薪资 / 福利 / 区 / 商圈存成这里的偏好；只改这几项，不动采集页',
        onclick: pullFromCollect,
      }),
      el('span', { class: 'fs11 muted', text: '反方向搬运。两边不会自动同步 —— 免得临时换一套条件搜一下就把长期设置冲了。' }),
    ]));

    /* --- 期望岗位：官方分类树 + 真实在招岗位名 --- */
    var expectJobs = (prefDraftExpect || prefs.expectJobs || []).slice();
    var expectBox = el('div', { class: 'chips jp-expect' });
    function paintExpect() {
      expectBox.innerHTML = '';
      if (!expectJobs.length) {
        expectBox.appendChild(el('span', { class: 'fs11 muted jp-none',
          text: '还没选 —— 点「🎯 长期期望岗位」：官方分类 28 大类 / 1098 个岗位 + 真实在招岗位名 176 个' }));
        return;
      }
      expectJobs.forEach(function (n) {
        expectBox.appendChild(el('span', {
          class: 'chip on jp-cpick', text: n + ' ✕', title: '点击移除「' + n + '」',
          onclick: function () {
            expectJobs = expectJobs.filter(function (x) { return x !== n; });
            prefDraftExpect = expectJobs.slice();
            paintExpect();
            commit('expectJobs', expectJobs.slice());
          },
        }));
      });
    }
    paintExpect();

    /* ⛔ 标题 / 按钮文案刻意和采集页**长得不一样**（那边叫「🔍 本次要搜的岗位」）。
       以前两边都是「🎯 选择岗位」、标题也几乎一样 —— 用户点进去分不清在改哪一份，
       改完了不知道改到哪儿去了。这里这份是**长期硬过滤口径**，不是这次的搜索词。 */
    body.appendChild(el('div', { class: 'fld jp-expect-fld' }, [
      el('div', { class: 'row jp-expect-head' }, [
        el('label', { class: 'lb', text: '🎯 长期期望岗位' }),
        Comp.lvlBadge('prefs'),
        el('button', {
          class: 'btn xs pri', type: 'button', html: '🎯 长期期望岗位',
          title: '这里选的是「长期只接受这些岗位」的硬过滤口径 —— 和采集页「🔍 本次要搜的岗位」是两份数据，互不影响',
          onclick: function () {
            if (!global.JobPicker) { U.toast('岗位数据没加载（js/job-taxonomy.js）', 'bad'); return; }
            global.JobPicker.open({
              title: '🎯 长期期望岗位 · 官方分类 + 真实在招岗位',
              note: '确认后写入【我的求职偏好】—— 用来做「按我的偏好筛选」与「合适度」的硬过滤。' +
                '采集页的「本次要搜的岗位」不受影响。',
              selected: expectJobs.slice(),
              multiple: true,
              onConfirm: function (list) {
                expectJobs = list.slice();
                prefDraftExpect = list.slice();
                paintExpect();
                commit('expectJobs', list.slice());
              },
            });
          },
        }),
      ].filter(Boolean)),
      expectBox,
      el('div', { class: 'fs11 muted mt4', text: '只保留岗位名命中这些岗位的岗位（即时生效）。这是**长期口径**，不影响「📡 采集岗位」页这次要搜什么。' }),
    ]));

    /* ==================== 📍 期望地点：城市 > 区 > 商圈 / 地标 ====================
       三级下钻。数据来源见 js/geo.js 的注释：
         城市 = 常用内置 ∪ 库里出现过的（手输兜底）
         区   = **库里真实采到的** ∪ 内置行政区划（内置只作候选）
         商圈 = **只有库里真实采到的** —— 不内置。凭印象列一份商圈名就是编造，
                用户照着一份假清单去筛会**静默漏岗位**，而且不会知道是清单的问题。
       地标 / 地铁用关键词匹配：BOSS 的商圈名经常直接就是地铁站名（「长河」「龙翔桥」）。

       ⚠️ 三级联动只重建这一块（geoSrc 内部），**不重建整个筛选卡** ——
          重建会把上面的期望岗位 chips 和下面的输入框全换掉，正在敲的字就没了。 */
    var geoSrc = el('div', { class: 'geo-wrap' });
    body.appendChild(el('div', { class: 'geo-title' }, [
      el('span', { class: 'fs13 fw6', text: '📍 期望地点' }),
      el('span', { class: 'fs11 muted', text: '城市 > 区 > 商圈，越往下越准；都不选就是不限' }),
    ]));
    body.appendChild(geoSrc);

    /* 改一项 prefs[key]（有则删、无则加）→ 刷摘要 → 联动重画 → 重画列表 */
    function toggleIn(key, arr) {
      Store.setSetting('prefs.' + key, arr);
      sumEl.textContent = global.JobMatch.describePref(global.JobMatch.prefs());
      paintGeo();
      if (afterChange) afterChange();
    }

    function paintGeo() {
      var allJobs = Store.jobs({ includeArchived: false }) || [];
      var cur = global.JobMatch.prefs();
      geoSrc.innerHTML = '';

      /* ① 城市：常用内置 ∪ 库里真出现过的（已选的由 chipsRow 内部补进去）。
         ⛔ 候选来自 GEO.cityChoices() —— 采集页的城市也用这同一个函数。
            原来这里手拼了一份、采集页干脆用文本框，"选项不一致"就是这么来的。 */
      geoSrc.appendChild(chipsRow({
        label: '城市', hint: '点一下选中，再点取消',
        options: global.GEO.cityChoices(allJobs),
        selected: cur.cities,
        custom: '其他城市，回车添加',
        // 与采集页那个「城市」对照着看：那边是 🔎 透传 BOSS（真的少采），这边是 🏠 只过滤岗位库
        badge: Comp.lvlBadge('prefs'),
        selfPaint: false,
        onChange: function (v) { toggleIn('cities', v); },
      }));

      /* ② 区：候选跟着城市走；一个城市都没选就按全部岗位枚举 */
      geoSrc.appendChild(chipsRow({
        label: '区', hint: cur.cities.length ? '' : '先选城市更准',
        options: global.GEO.uniq(cur.cities.length
          ? cur.cities.reduce(function (a, c) { return a.concat(global.GEO.districtsOf(c, allJobs)); }, [])
          : global.GEO.districtsOf('', allJobs)),
        selected: cur.districts,
        custom: '其他区，回车添加',
        selfPaint: false,
        onChange: function (v) { toggleIn('districts', v); },
      }));

      /* ③ 商圈：只列真实采到的。一条都没有就如实说，不塞一份猜的清单给它。 */
      var bizOpts = global.GEO.bizAreasOf(cur.districts, allJobs);
      geoSrc.appendChild(chipsRow({
        label: '商圈 / 地标', hint: bizOpts.length ? '来自你这批采集结果' : '',
        options: bizOpts,
        selected: cur.bizAreas,
        empty: '还没采到商圈数据 —— 采集一次（或导入采集 CSV）后这里会自动列出真实商圈；也可以手输',
        custom: '商圈名，回车添加',
        selfPaint: false,
        onChange: function (v) { toggleIn('bizAreas', v); },
      }));

      /* ④ 地标 / 地铁关键词 */
      var fLm = Comp.field({ label: '地标 / 地铁（关键词）',
        value: cur.landmark, placeholder: '例如 龙翔桥、西溪、阿里',
        hint: '在<b>商圈 + 详细地址 + 城市</b>里按关键词匹配。不单独存一份地铁表 —— 那份表没法保证准，错了会静默漏岗位' });
      fLm.input.addEventListener('input', function () { commitSoon('landmark', fLm.get()); });
      geoSrc.appendChild(fLm.node);

      /* ⑤ 严格模式：默认「没采到区/商圈的也留着」，勾上才只看明确命中的 */
      var strictCb = el('input', { type: 'checkbox' });
      strictCb.checked = !!cur.geoStrict;
      strictCb.addEventListener('change', function () {
        Store.setSetting('prefs.geoStrict', strictCb.checked);
        if (afterChange) afterChange();
      });
      geoSrc.appendChild(el('label', { class: 'geo-strict',
        title: '默认保留「区/商圈没采到」的岗位，免得你以为岗位丢了' }, [
        strictCb,
        el('span', { class: 'fs12', text: '严格模式：区 / 商圈没采到的岗位也筛掉' }),
      ]));
    }
    paintGeo();

    /* --- 另外两条硬条件：薪资底线 / 不能接受的点 --- */
    var fSalary = Comp.field({
      label: '薪资底线（K）', type: 'number',
      value: (prefs.salaryMin === null || prefs.salaryMin === undefined) ? '' : prefs.salaryMin,
      placeholder: '未设置（例如 10）',
      hint: '单位是 K。<b>留空 = 不按薪资筛</b>。填了之后：岗位库的「💰 薪资达标」和偏好筛选都会用它；没写薪资的岗位不会被筛掉',
    });
    var fBreakers = Comp.field({ label: '不能接受的点（逗号分隔）',
      value: (prefs.dealBreakers || []).join(', '), placeholder: '外包, 派遣, 大小周',
      hint: 'AI 评估时会重点提示；「🚫 排除不能接受的点」会按它过滤（查标签 / 岗位名 / 公司名，不查 JD 正文，避免误杀）' });

    fSalary.input.addEventListener('input', function () { commitSoon('salaryMin', U.asNum(fSalary.get())); });
    fBreakers.input.addEventListener('input', function () { commitSoon('dealBreakers', U.asArray(fBreakers.get(), true)); });
    body.appendChild(el('div', { class: 'grid g2', style: 'gap:12px' }, [fSalary.node, fBreakers.node]));

    /* ==================== 🎁 期望福利（多选 + 满足方式单选） ====================
       选项全部来自**真实采集数据里出现过的福利标签**（job-match.js 的 WELFARE_OPTIONS）。
       分组只是让 18 个选项好找一点，不参与判定。 */
    var welBox = el('div', { class: 'welbox' });
    body.appendChild(el('div', { class: 'geo-title' }, [
      el('span', { class: 'fs13 fw6', text: '🎁 期望福利' }),
      el('span', { class: 'fs11 muted', text: '多选 · 福利没采到的岗位会保留（不因为「没写」就筛掉）' }),
    ]));
    body.appendChild(welBox);

    function paintWel() {
      var cur = global.JobMatch.prefs();
      welBox.innerHTML = '';
      var groups = {};
      global.JobMatch.WELFARE_OPTIONS.forEach(function (o) {
        (groups[o.g] = groups[o.g] || []).push(o.k);
      });
      Object.keys(groups).forEach(function (g) {
        welBox.appendChild(el('div', { class: 'welrow' }, [
          el('span', { class: 'wel-g', text: g }),
          el('span', { class: 'chips geo-chips' }, groups[g].map(function (k) {
            var on = cur.welfare.indexOf(k) >= 0;
            return el('span', {
              class: 'chip geo-chip' + (on ? ' on' : ''),
              text: on ? k + ' ✕' : k,
              title: on ? '点击取消「' + k + '」' : '点击选中「' + k + '」',
              onclick: function () { welToggle(k); },
            });
          })),
        ]));
      });
      var mode = cur.welfareMode === 'any' ? 'any' : 'all';
      welBox.appendChild(el('div', { class: 'welrow' }, [
        el('span', { class: 'wel-g', text: '满足方式' }),
        el('span', { class: 'chips geo-chips' }, [
          el('span', { class: 'chip geo-chip' + (mode === 'all' ? ' on' : ''), text: '全部满足',
            title: '勾的每一项都要命中才留下（更严）', onclick: function () { setMode('all'); } }),
          el('span', { class: 'chip geo-chip' + (mode === 'any' ? ' on' : ''), text: '任一满足',
            title: '命中任意一项就留下（更松）', onclick: function () { setMode('any'); } }),
        ]),
      ]));
      if (!cur.welfare.length) {
        welBox.appendChild(el('div', { class: 'fs11 muted', text: '一项都没勾 = 不按福利筛' }));
      }
    }
    function welToggle(k) {
      var arr = U.asArray(Store.settings().prefs.welfare).slice();
      var i = arr.indexOf(k);
      if (i >= 0) arr.splice(i, 1); else arr.push(k);
      Store.setSetting('prefs.welfare', arr);
      sumEl.textContent = global.JobMatch.describePref(global.JobMatch.prefs());
      paintWel();
      if (afterChange) afterChange();
    }
    function setMode(m) {
      Store.setSetting('prefs.welfareMode', m);
      sumEl.textContent = global.JobMatch.describePref(global.JobMatch.prefs());
      paintWel();
      if (afterChange) afterChange();
    }
    paintWel();

    /* ==================== 🎯 本地「合适度」打分口径 ====================
       这几个字段**不参与硬过滤**，只喂给 js/job-score.js 打分。
       和上面那份偏好的区别：上面决定「要不要这条」，这里决定「这条排多前」。 */
    var fSalaryMax = Comp.field({
      label: '期望薪资上限（K）', type: 'number',
      value: (prefs.salaryMax === null || prefs.salaryMax === undefined) ? '' : prefs.salaryMax,
      placeholder: '未设置（例如 10）',
      hint: '只用在合适度打分和显示上：岗位起点 <b>≥ 你的下限</b> 就是满分（给得比期望高不扣分）',
    });
    var fYears = Comp.field({
      label: '我的工作年限', type: 'number',
      value: (prefs.myYears === null || prefs.myYears === undefined) ? '' : prefs.myYears,
      placeholder: '例如 2',
      hint: '经验匹配维度（10 分）：你的年限落在岗位要求区间里 = 满分',
    });
    var fDegree = Comp.field({
      label: '我的最高学历', type: 'select',
      options: ['不限', '高中', '中专', '大专', '本科', '硕士', '博士'],
      value: prefs.myDegree || '大专',
      hint: '岗位要求高于你时：标黄「降级观望」并扣 3-6 分（不直接杀，留通融余地）',
    });
    fSalaryMax.input.addEventListener('input', function () { commitSoon('salaryMax', U.asNum(fSalaryMax.get())); });
    fYears.input.addEventListener('input', function () { commitSoon('myYears', U.asNum(fYears.get())); });
    fDegree.input.addEventListener('change', function () { commit('myDegree', fDegree.get()); });

    body.appendChild(el('div', { class: 'divider' }));
    body.appendChild(el('div', { class: 'row' }, [
      el('span', { class: 'fs13 fw6', text: '🎯 本地合适度打分口径' }),
      el('span', { class: 'fs11 muted', text: '零成本、可解释，不花 token' }),
      el('span', { class: 'sp' }),
      el('button', {
        class: 'btn xs ghost', text: '怎么算的',
        onclick: function () { if (global.JobScorer) global.JobScorer.openHelp(); },
      }),
    ]));
    body.appendChild(el('div', { class: 'grid g3 mt8', style: 'gap:12px' },
      [fSalaryMax.node, fYears.node, fDegree.node]));

    /* 求职方向关键词：合适度打分的「② 关键词命中 30 分」全靠它。
       留空就用 job-score.js 里的内置画像词 —— 但那是别人的画像，得让用户能改。 */
    var fFocus = Comp.field({
      label: '求职方向关键词（逗号 / 换行分隔）',
      type: 'textarea', rows: 3,
      value: (prefs.focusKeywords || []).join(', '),
      placeholder: '新媒体运营, 短视频, 视频号, 账号搭建, 脚本撰写, AI工作流 …',
      hint: '每命中一个 <b>+6 分</b>（上限 30）。留空则用内置画像词兜底；期望岗位会自动并进来，不用重复填',
    });
    var fIndustries = Comp.field({
      label: '对口行业（逗号分隔，选填）', type: 'text',
      value: (prefs.industries || []).join(', '),
      placeholder: 'MCN, 电商, 内容机构',
      hint: '岗位行业命中任一 → 动态加分 +3。留空用内置表（MCN/电商/互联网/传媒/广告…）',
    });
    fFocus.input.addEventListener('input', function () { commitSoon('focusKeywords', U.asArray(fFocus.get(), true)); });
    fIndustries.input.addEventListener('input', function () { commitSoon('industries', U.asArray(fIndustries.get(), true)); });

    body.appendChild(el('div', { class: 'mt8' }, [fFocus.node]));
    body.appendChild(el('div', { class: 'row', style: 'gap:10px;align-items:flex-end' }, [
      el('div', { class: 'flex1' }, [fIndustries.node]),
      el('button', {
        class: 'btn', text: '用内置画像词',
        title: '把关键词清空 —— 打分时自动用 job-score.js 里那 23 个画像词兜底',
        onclick: function () {
          fFocus.set('');
          commit('focusKeywords', []);
          U.toast('已清空 —— 打分时会用内置画像词兜底', 'info', 5000);
        },
      }),
    ]));

    /* 「进入岗位库默认应用偏好」——用户嫌每次都要点一下的话，可以一次性打开 */
    var cbAuto = el('input', { type: 'checkbox' });
    cbAuto.checked = !!(prefs.autoApply);
    cbAuto.addEventListener('change', function () {
      Store.setSetting('prefs.autoApply', cbAuto.checked);
      U.toast(cbAuto.checked
        ? '以后打开岗位库会自动按偏好筛（点按钮或「重置」都能取消）'
        : '已取消默认应用 — 岗位库打开时不再自动筛', 'info', 6000);
    });

    body.appendChild(el('div', { class: 'row mt12' }, [
      el('span', { class: 'fs11 muted', html: '✔ 改动<b>即时生效</b>，不用再点保存' }),
      el('span', { class: 'sp' }),
      el('label', { class: 'chk' }, [
        cbAuto,
        el('span', { text: '进入岗位库时默认应用这些偏好' }),
      ]),
    ]));

    return box;
  }

  /** 偏好面板改动后：只重画列表 / 统计 / 条件条，**不重建筛选卡**（否则输入框会掉焦点） */
  function repaintKeepFocus() { if (_pageRepaint) _pageRepaint(); }

  /** 外部入口：展开偏好面板（偏好没填时点了「按偏好筛选」会走这条） */
  function openPrefs() {
    F.prefsOpen = true;
    // 偏好面板挂在「更多筛选」折叠面板里 —— 展开偏好的同时必须把折叠面板也展开，
    // 否则面板被藏住、用户点完却看不到（「点了没反应」的错觉）。
    F.moreOpen = true;
    if (_pageRebuild) _pageRebuild(); else App.refresh();
  }

  /** 页面已经渲染着的时候就地展开：只切 class，不整页重建（省一次闪烁） */
  function expandPrefsInPlace() {
    if (_prefsBox && _prefsBox.classList) {
      _prefsBox.classList.add('open');
      F.prefsOpen = true;
      var ch = _prefsBox.querySelector ? _prefsBox.querySelector('.prefs-chev') : null;
      if (ch) ch.textContent = '收起 ▴';
      return;
    }
    openPrefs();
  }

  function mkSelect(options, value, onChange) {
    var s = el('select', { style: 'width:auto;min-width:118px' });
    options.forEach(function (o) { s.appendChild(el('option', { value: o.v, text: o.l })); });
    s.value = value || '';
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }
  function mkCheck(checked, onChange) {
    var i = el('input', { type: 'checkbox' });
    i.checked = !!checked;
    i.addEventListener('change', function () { onChange(i.checked); });
    return i;
  }

  /**
   * 模块级的「重画当前页」。
   *
   * ⛔ 包一层 withFocusKept 是**必须的**（评审 4.1，实测确认）：
   *   `App.refresh()` → app.js 里 `view.innerHTML = ''` 是**整页重建**，
   *   筛选栏里的搜索框会被换成新节点。搜索框的防抖回调走的就是这里，
   *   于是「每敲一个字就丢焦点」—— 打第二个字时焦点已经不在了。
   *
   *   我先试过「只重画列表、不碰筛选栏」，**不行**：自然语言解析小字
   *   （`buildFilterBar` 里的「被理解成 城市/薪资」那行）就渲染在筛选栏里，
   *   不重建它就不会更新 —— 核心测试当场抓到了（「输入后解析小字出现」变红）。
   *   所以正解是「照旧整页重建 + 重建后把焦点和光标还回去」。
   *
   * 下拉框（来源/状态/排序…）的 onChange 也走这里 —— 它们不需要焦点，
   * captureFocus 只认带 data-focus-key 的元素，所以不会误抢焦点。
   */
  var repaint = U.debounce(function () {
    U.withFocusKept(function () { App.refresh(); });
  }, 60);

  /* ---------------- 本地「合适度」（js/job-score.js） ----------------
     零 token、可解释、可重放。这里只做两件事：
       ① 每轮渲染前把候选岗位**一次算完**，塞进 FITMAP（避免卡片/排序/计数各算一遍）
       ② 暴露 fitOf(j) 给卡片、表格、详情、排序用
     ⚠️ 不做跨轮缓存 —— 改完偏好/简历后必须立刻反映，缓存是这类 bug 的温床。 */
  var FITMAP = {};
  var FITCFG = null;

  /** 算一批岗位的合适度，返回同一批（排序前调用） */
  function fitBatch(jobs) {
    FITCFG = global.JobScorer.config();
    FITMAP = {};
    jobs.forEach(function (j) { FITMAP[j.id] = global.JobScorer.score(j, FITCFG); });
    return jobs;
  }

  /** 取一个岗位的合适度结果；没预先算过就现算（详情弹窗、外部调用会走这条） */
  function fitOf(j) {
    if (j && FITMAP[j.id]) return FITMAP[j.id];
    return global.JobScorer.score(j);
  }

  /**
   * 分级条上的数字 = 「不带合适度筛选时，这批会剩多少」。
   * 所以临时把 F.fit / F.hideDrop 摘掉再跑一遍 filterJobs，
   * 跑完**必须还原**（用 finally，抛异常也不能把用户的筛选状态改掉）。
   */
  function fitSummary() {
    var sf = F.fit, sd = F.hideDrop;
    var jobs;
    try {
      F.fit = ''; F.hideDrop = false;
      jobs = filterJobs();
    } finally {
      F.fit = sf; F.hideDrop = sd;
    }
    var out = { A: 0, B: 0, C: 0, D: 0, drop: 0, blind: 0, total: jobs.length };
    jobs.forEach(function (j) {
      var r = FITMAP[j.id];
      if (!r) return;
      if (r.gate.drop) { out.drop++; return; }
      out[r.level.key]++;
      if (r.blind) out.blind++;
    });
    return out;
  }

  /* ---------------- 卡片上的地理 / 福利小标 ----------------
     为什么非要有这块：地理筛选和福利筛选都带一条「没数据也保留」的规则
     （区/商圈没采到 → 保留；福利没采到 → 保留）。规则本身是对的 ——
     按「没写就筛掉」处理，用户会以为岗位丢了。但它有个副作用：
     列表里混着"看起来不该匹配"的岗位时，用户会以为**筛选没生效**。
     所以把「这条为什么还在这儿」直接印在卡片上。 */
  function geoWelLine(j) {
    var P = prefsOf();
    var out = [];

    /* 地理筛选在生效就标：筛选栏的区/商圈，或偏好里的区/商圈/地标 */
    var geoOn = global.GEO && (!!(F.district || F.bizArea) ||
      (F.pref && global.JobMatch.areaNeed && global.JobMatch.areaNeed(P)));
    if (geoOn) {
      var d = global.GEO.extractDistrict(j);
      var b = global.GEO.extractBizArea(j);
      out.push(!d && !b
        ? el('span', { class: 'geotag warn', text: '📍 区/商圈未采到 —— 先留着（不是筛选失效）' })
        : el('span', { class: 'geotag', text: '📍 ' + [d, b].filter(Boolean).join(' · ') }));
    }

    /* 只要偏好里勾了期望福利，就显示命中几项 —— 勾了就是想看到 */
    var w = U.asArray(P.welfare);
    if (w.length) {
      var n = global.JobMatch.welfareHitN(j, w);
      out.push(el('span', {
        class: 'weln' + (n === w.length ? ' ok' : (n ? '' : ' no')),
        title: '命中你勾的期望福利中的 ' + n + ' 项（共 ' + w.length + ' 项）',
        text: '🎁 福利 ' + n + '/' + w.length,
      }));
    }

    return out.length ? el('div', { class: 'geowel' }, out) : null;
  }

  /**
   * 公司背调结果的小灯（卡片上紧挨着公司名）。
   * ⛔ 只在**真查过**（有数据）时才显示 —— 没查过就什么都不显示。
   *    如果没查过也挂一个「⚪ 未评定」，几百张卡片全挂着同一个灰点，纯噪音。
   *    页面（公司背调）那边才需要「未评定」，因为那里就是要你看到有多少家没查。
   */
  function companyLamp(company) {
    if (!company || !global.CompanyCheck || !global.CompanyView) return null;
    var rec = null;
    try { rec = Store.checkByCompany(company); } catch (e) { return null; }
    if (!rec || !global.CompanyCheck.hasData(rec)) return null;
    var v = global.CompanyCheck.verdict(rec);
    return el('span', {
      class: 'tag ' + (v.cls || 'line') + ' co-lamp',
      text: v.ico + ' ' + v.label,
      title: '公司背调：' + v.reasons.join('；').replace(/<\/?b>/g, '') + '（点公司名看详情）',
    });
  }

  /* ---------------- 过滤 + 排序 ---------------- */
  function filterJobs() {
    var arr = Store.jobs({ includeArchived: F.archived });
    var P = global.JobMatch.prefs();

    if (F.source) arr = arr.filter(function (j) { return j.source === F.source; });
    if (F.fav) arr = arr.filter(function (j) { return j.favorite; });
    if (F.tag) arr = arr.filter(function (j) { return (j.tags || []).indexOf(F.tag) >= 0; });

    if (F.status) {
      arr = arr.filter(function (j) {
        var a = Store.appOfJob(j.id);
        if (F.status === 'none') return !a;
        return a && a.status === F.status;
      });
    }

    if (F.salary) {
      arr = arr.filter(function (j) {
        if (F.salary === 'none') return j.salaryMin === null && j.salaryMax === null;
        var parts = F.salary.split('-');
        var lo = parseFloat(parts[0]), hi = parseFloat(parts[1]);
        var v = j.salaryMin !== null ? j.salaryMin : j.salaryMax;
        return v !== null && v >= lo && v < hi;
      });
    }

    /* 区 / 商圈（比城市更细的一层）。
       ⛔ 没采到区 / 商圈的岗位**不在这里筛掉** —— 交给 geoHit 保留，
          卡片上会标「📍 区未知」。理由同「薪资为空一律保留」：
          按「没写就筛掉」处理，用户会以为岗位丢了，而不是"这条没数据"。 */
    if (F.district || F.bizArea) {
      arr = arr.filter(function (j) {
        return global.JobMatch.areaHit(j, {
          districts: F.district ? [F.district] : [],
          bizAreas: F.bizArea ? [F.bizArea] : [],
          landmark: '', geoStrict: false,
        });
      });
    }

    // 快捷 chips（多个是 AND 叠加）
    if (hasQuickOn()) {
      arr = arr.filter(function (j) { return global.JobMatch.passQuick(j, F.quick, P); });
    }

    // 「按我的偏好筛选」
    if (F.pref) {
      arr = arr.filter(function (j) { return global.JobMatch.passPref(j, P); });
    }

    if (F.kw) {
      var q = currentQuery();
      if (q && q.matched) {
        // 解析出了结构（城市 / 薪资 / 排除词）→ 按结构筛
        arr = arr.filter(function (j) { return global.JobMatch.passQuery(j, q); });
      } else {
        // 什么都没解析出来 → 退回原来的纯关键词搜索，行为跟以前完全一样
        var k = F.kw.toLowerCase();
        arr = arr.filter(function (j) { return global.JobMatch.keywordHay(j).indexOf(k) >= 0; });
      }
    }

    /* --- 本地「合适度」---
       放在关键词之后：先按条件缩小范围，再算分，省掉无谓的计算。
       ⚠️「被剔除」是**硬性过滤**的结论，跟「分低」是两回事：剔除了就不给分
       （不是 0 分），所以列表上必须显式写原因，不能被误读成"只是分低"。 */
    fitBatch(arr);
    if (F.hideDrop) {
      arr = arr.filter(function (j) { return !FITMAP[j.id].gate.drop; });
    }
    if (F.fit) {
      arr = arr.filter(function (j) {
        var r = FITMAP[j.id];
        return !r.gate.drop && r.level.key === F.fit;
      });
    }

    var sorters = {
      new: function (a, b) { return b.createdAt - a.createdAt; },
      old: function (a, b) { return a.createdAt - b.createdAt; },
      salary: function (a, b) { return (b.salaryMax || b.salaryMin || 0) - (a.salaryMax || a.salaryMin || 0); },
      score: function (a, b) {
        var x = (a.aiVerdict && a.aiVerdict.score) || -1;
        var y = (b.aiVerdict && b.aiVerdict.score) || -1;
        return y - x;
      },
      // 本地合适度：被硬性剔除的一律沉底（不参与 A/B/C/D），再按分数降序
      fit: function (a, b) {
        var x = FITMAP[a.id] || {}, y = FITMAP[b.id] || {};
        var xd = x.gate && x.gate.drop ? 1 : 0, yd = y.gate && y.gate.drop ? 1 : 0;
        if (xd !== yd) return xd - yd;
        return (y.total || 0) - (x.total || 0);
      },
      company: function (a, b) { return String(a.company).localeCompare(String(b.company), 'zh'); },
      // 「最该跟进的在前」：复用待跟进页的优先级算法，分数高的先看
      follow: function (a, b) { return followScore(b) - followScore(a); },
    };
    return arr.sort(sorters[F.sort] || sorters.new);
  }

  /** 「最该跟进」打分（0 = 不用管）。与待跟进页同口径，避免两处排序打架。 */
  function followScore(j) {
    if (j.archived) return 0;
    return (global.FollowUp && global.FollowUp.scoreJob) ? global.FollowUp.scoreJob(j) : 0;
  }

  /* ---------------- 岗位卡片 ---------------- */
  /**
   * 卡片里的 JD 预览。
   * BOSS 抓回来的 rawJD 动辄上千字，直接铺在卡片上会让列表完全没法扫。
   * 所以：默认只显示一小段摘要（并在 CSS 里 clamp 成 2 行兜底），需要时点开看全。
   */
  var JD_PREVIEW = 120;

  function jdPreview(j) {
    var full = U.stripTags(j.rawJD || '').replace(/\s+/g, ' ').trim();
    if (!full) return null;
    var short = full.length > JD_PREVIEW ? full.slice(0, JD_PREVIEW) + '…' : full;
    var body = el('div', { class: 'jd clamp2', text: short });
    if (full.length <= JD_PREVIEW) return body;

    var expanded = false;
    // 用 <button> 而不是 <span>：卡片根节点的 onclick 会跳过 button，
    // 这样点「展开全文」不会顺带把详情弹窗也打开。
    var more = el('button', { class: 'jd-more', type: 'button', text: '展开全文 ▾' });
    more.addEventListener('click', function () {
      expanded = !expanded;
      body.textContent = expanded ? full : short;
      // 展开时去掉行数限制，否则 CSS 的 -webkit-line-clamp 会继续裁掉
      body.classList.toggle('clamp2', !expanded);
      more.textContent = expanded ? '收起 ▴' : '展开全文 ▾';
    });
    return el('div', {}, [body, more]);
  }

  /* ---------------- 触达 BOSS 的操作条 ---------------- */

  /**
   * 卡片上的「去 BOSS 投递 / 我已投了 / 一键打招呼」。
   *
   * 设计取舍：
   *   · 按钮**永远显示**，没有链接时置灰 + tooltip 说明原因 —— 比直接藏起来好，
   *     否则用户会以为是工具坏了（"为什么别人的卡片有这个按钮，我的没有？"）。
   *   · 「一键打招呼」只在设置页开关打开后才出现 —— 它会让真实浏览器去发消息，
   *     不可逆，不能是不小心就会点到的东西。
   *   · 「我已投了」在已经投递过（越过 applied）之后隐藏，避免重复确认。
   */
  function bossActBar(j, app, onChange) {
    if (!global.ApplyBoss) return null;                     // 模块没加载就不画
    var AB = global.ApplyBoss;
    var can = AB.canOpen(j);
    var applied = app && Store.hasApplied(app);

    var kids = [];

    var openBtn = el('button', {
      class: 'btn xs' + (can.ok ? ' pri' : ''),
      html: '🚀 去 BOSS 投递',
      title: can.ok
        ? '在新标签页打开这个岗位的 BOSS 页面（投递动作还是你自己做）'
        : can.reason + ' —— 所以没法跳过去',
      onclick: function (e) {
        e.stopPropagation();
        if (!can.ok) { U.toast(can.reason, 'warn', 3200); return; }
        AB.openOnBoss(j, onChange);
      },
    });
    if (!can.ok) { openBtn.disabled = true; openBtn.classList.add('ghost'); }
    kids.push(openBtn);

    // 「我已投了」：还没确认投递时才给
    if (!applied) {
      kids.push(el('button', {
        class: 'btn xs', html: '✓ 我已投了',
        title: '从 BOSS 投完回来点这个 —— 记上投递时间，之后没动静会自动出现在「待跟进」里',
        onclick: function (e) {
          e.stopPropagation();
          AB.confirmApplied(j, onChange);
        },
      }));
    }

    // 「一键打招呼」：开关开了才出现
    if (AB.autoGreetOn()) {
      kids.push(el('button', {
        class: 'btn xs danger', html: '⚡ 一键打招呼',
        title: '让采集器替你点「立即沟通」并发送招呼语。⚠️ 不可逆，发送前会再确认一次',
        onclick: function (e) {
          e.stopPropagation();
          openGreetDialog(j, onChange);
        },
      }));
    }

    return el('div', { class: 'row j-act', style: 'gap:6px;flex-wrap:wrap' }, kids);
  }

  /**
   * 一键打招呼的二次确认弹窗（含招呼语预览、可改）。
   * ⚠️ 不可逆动作 → 必须让用户看到**即将发出去的那句话**，而不是一个"确定吗？"。
   * 弹窗写法遵循项目既有约定：`U.openModal` + `footer: []` 后自己往 `.mfoot` 挂按钮。
   */
  function openGreetDialog(j, onChange) {
    var AB = global.ApplyBoss;
    var gate = AB.canAutoGreet(j, U.now());
    if (!gate.ok) { U.toast(gate.reason, 'warn', 3600); return null; }

    var ta = el('textarea', { rows: '6', placeholder: '第一句就要说到点上：你做什么、和这个岗位哪一点对口…' });
    ta.value = AB.greetingFor(j, '');                        // textarea 的初值必须走 .value

    var body = el('div', {}, [
      el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '⚠️' }),
        el('div', { html: '这一步会<b>真的把消息发出去</b>：撤不回，而且会消耗 BOSS 当天的沟通条数。' +
          '发送失败<b>不会自动重试</b> —— 重试等于白烧一次额度。' }),
      ]),
      el('div', { class: 'fs12 muted fw6 mt12 mb4', text: '发给：' + (j.company || '未知公司') + '　' + (j.title || '') }),
      el('div', { class: 'fs12 muted fw6 mb4', text: '招呼语（发出前最后确认一遍）' }),
      ta,
      el('div', { class: 'hint tiny mt8', html: '💡 BOSS 消息列表只显示<b>前 15 个字</b>，开头千万别是「您好，我是……」这种客套话。' }),
      /* 说清用哪个浏览器（第 28 轮）。daily 模式有硬前提（先彻底退出 Edge），
         提前讲清楚，别等失败了用户才知道。 */
      el('div', { class: 'hint tiny mt6', html:
        '🌐 会用「' + (AB.browserModeLabel ? AB.browserModeLabel() : '工作台自己的浏览器') + '」发送。' +
        (AB.browserMode && AB.browserMode() === 'daily'
          ? '　⛔ 它如果正在运行会失败 —— 请先<b>彻底退出 Edge</b>（托盘图标右键退出）。'
          : '') }),
    ]);

    var m = U.openModal({
      title: '⚡ 一键打招呼',
      size: 'sm',
      body: body,
      maskClose: false,
      footer: [],
    });

    var bCancel = el('button', { class: 'btn', text: '取消', onclick: function () { m.close(); } });
    var bSend = el('button', {
      class: 'btn pri', text: '确认发送',
      onclick: function () {
        var text = ta.value.trim();
        if (!text) { U.toast('招呼语是空的，发出去等于白发', 'bad', 3000); return; }
        m.close();                                           // 先关窗，请求在后台跑
        AB.doAutoGreet(j, text, { onDone: function () { onChange && onChange(); } });
      },
    });
    var foot = m.modal.querySelector('.mfoot');
    foot.appendChild(el('span', { class: 'sp' }));
    foot.appendChild(bCancel);
    foot.appendChild(bSend);
    return m;
  }

  function jobCard(j, onChange) {
    var app = Store.appOfJob(j.id);
    var v = j.aiVerdict || {};
    var ft = fitOf(j);
    var picked = SEL.on && selHas(j.id);

    var card = el('div', { class: 'job' + (picked ? ' picked' : ''), onclick: function (e) {
      if (e.target.closest('.fav') || e.target.closest('.q') || e.target.closest('button')) return;
      // 批量模式下点卡片 = 勾选 / 取消勾选，而不是开详情
      if (SEL.on) { selToggle(j.id); onChange && onChange(); return; }
      openDetail(j.id, onChange);
    } }, [
      // 批量模式的勾选框（CSS 里 .pick 早就有样式了，之前一直没用上）
      SEL.on ? el('span', { class: 'pick', text: '✓' }) : null,
      el('span', {
        class: 'fav' + (j.favorite ? ' on' : ''), title: j.favorite ? '取消收藏' : '收藏',
        text: j.favorite ? '⭐' : '☆',
        onclick: function (e) {
          e.stopPropagation();
          Store.toggleJobFlag(j.id, 'favorite');
          onChange && onChange();
        },
      }),
      el('div', { class: 'j-head' }, [
        el('h4', { text: j.title || '(未取到岗位名)' }),
        el('span', { class: 'sal', text: j.salaryText || '面议' }),
      ]),
      el('div', { class: 'co' }, [
        /* 公司名可点 → 打开背调小弹窗（路线 A 的入口就是这里）。
           ⚠️ 只有真有一个公司名才给点击 —— 没有公司名时点了只会得到一个空搜索页。 */
        j.company
          ? el('span', {
              class: 'co-name', text: j.company,
              title: '点一下背调这家（开天眼查 / 爱企查，并把查到的结果记下来）',
              onclick: function (e) {
                e.stopPropagation();
                if (!global.CompanyView) { U.toast('背调模块没加载（js/view-company.js）', 'bad'); return; }
                global.CompanyView.openFor(j.company, {
                  jobIds: [j.id],
                  texts: [j.title, j.rawJD, (j.tags || []).join(' ')].filter(Boolean).join('\n'),
                });
              },
            })
          : el('span', { text: '未知公司' }),
        companyLamp(j.company),
        j.industry ? el('span', { class: 'muted', text: '· ' + j.industry }) : null,
      ].filter(Boolean)),
      el('div', { class: 'meta' }, [
        j.location ? el('span', { class: 'tag', text: j.location + (j.remote ? ' · 远程' : '') }) : null,
        j.reqYears ? el('span', { class: 'tag', text: j.reqYears }) : null,
        j.reqDegree ? el('span', { class: 'tag', text: j.reqDegree }) : null,
        j.source === 'boss' ? el('span', { class: 'tag brand', text: 'BOSS' }) : el('span', { class: 'tag', text: '手动' }),
        j.proxyHire ? el('span', { class: 'tag warn', text: '代招', title: 'BOSS 标注为代招 —— 劳动合同多半不在这家公司' }) : null,
        j.invalid ? el('span', { class: 'tag bad', text: '已失效', title: 'BOSS 标注已下线，投了大概率没回应' }) : null,
        j.archived ? el('span', { class: 'tag', text: '已归档' }) : null,
      ].filter(Boolean)),
      (j.reqSkills && j.reqSkills.length)
        ? el('div', { class: 'meta' }, j.reqSkills.slice(0, 5).map(function (s) { return el('span', { class: 'tag', text: s }); }))
        : null,
      /* 合适度：**每一条都标明原因** —— 徽标（哪一级、多少分）+ 五维得分 + 一句话原因，
         全摆在卡片上，不用点进详情才知道为什么。被硬性过滤剔除的岗位不给分，直接说原因。 */
      /* 避坑徽章（第 31 轮）：和「合适度」**同一行**，但语义独立 ——
         合适度回答「我配不配」，避坑回答「这岗位本身有没有该先问清楚的」。
         两个问题不同，所以是两个徽章，不合成一个分。 */
      Comp.fitLine(ft, {
        extra: (global.Pitfall && !j.archived) ? Pitfall.badge(Pitfall.of(j)) : null,
      }),
      geoWelLine(j),
      (j.risks && j.risks.length)
        ? el('div', { class: 'fs12 warn-c clamp2', html: '⚠️ ' + j.risks.slice(0, 2).map(U.esc).join('；') })
        : null,
      jdPreview(j),
      /* 触达 BOSS 的操作条。放在卡片上而不是只藏在详情里 —— 投递这个动作一天要重复十几次，
         每次都「点开详情 → 找到链接 → 再点」是把最频繁的路径做成了最长的路径。 */
      bossActBar(j, app, onChange),
      el('div', { class: 'j-foot' }, [
        app ? Comp.statusPill(app.status) : el('span', { class: 'tag', text: '未投递' }),
        v.score ? el('span', { class: 'tag ' + (v.score >= 80 ? 'ok' : v.score >= 70 ? 'info' : 'warn'), text: '匹配 ' + v.score }) : null,
        el('span', { class: 'sp' }),
        (j.tags || []).slice(0, 3).map(function (t) { return el('span', { class: 'tag', text: t }); }),
        // 归档以前只能进详情才能做，多一步就少按一次
        el('button', {
          class: 'q', title: j.archived ? '取消归档' : '归档（不参与筛选统计）',
          text: j.archived ? '♻️' : '📦',
          onclick: function (e) {
            e.stopPropagation();
            Store.toggleJobFlag(j.id, 'archived');
            U.toast(j.archived ? '已取消归档' : '已归档，可在筛选里「含归档」找回', 'ok', 2600);
            onChange && onChange();
          },
        }),
        el('span', { class: 'muted fs11', text: U.rel(j.createdAt) }),
      ].filter(Boolean)),
    ].filter(Boolean));
    return card;
  }

  /* ---------------- 紧凑列表视图 ---------------- */
  function jobTable(jobs, onChange) {
    var box = el('div', { class: 'tb-wrap' });
    var tb = el('table', { class: 'tb' });
    tb.appendChild(el('thead', {}, [el('tr', {}, [
      SEL.on ? el('th', { style: 'width:30px', text: '' }) : null,
      el('th', { text: '岗位' }),
      el('th', { text: '公司' }),
      el('th', { text: '薪资' }),
      el('th', { text: '地点' }),
      el('th', { text: '状态' }),
      el('th', { style: 'min-width:196px', text: '合适度' }),
      el('th', { text: 'AI 匹配' }),
      el('th', { text: '标签' }),
      el('th', { text: '录入' }),
      el('th', { style: 'width:52px', text: '' }),
    ].filter(Boolean))]));
    var tbody = el('tbody');
    jobs.forEach(function (j) {
      var app = Store.appOfJob(j.id);
      var v = j.aiVerdict || {};
      var picked = SEL.on && selHas(j.id);
      tbody.appendChild(el('tr', { class: picked ? 'on' : '', style: 'cursor:pointer', onclick: function (e) {
        if (e.target.closest('button') || e.target.closest('input')) return;
        if (SEL.on) { selToggle(j.id); onChange(); return; }
        openDetail(j.id, onChange);
      } }, [
        SEL.on ? el('td', {}, [(function () {
          var cb = el('input', { type: 'checkbox' });
          cb.checked = picked;
          cb.addEventListener('change', function () { selToggle(j.id); onChange(); });
          return cb;
        })()]) : null,
        el('td', {}, [
          el('div', { class: 'fs13 fw6' , text: j.title || '(未命名)' }),
          j.archived ? el('span', { class: 'tag', text: '已归档' }) : null,
        ].filter(Boolean)),
        el('td', { class: 'fs12 t2', text: j.company || '—' }),
        el('td', { class: 'nl', text: j.salaryText || '面议' }),
        el('td', { class: 'fs12 muted', text: j.location || '—' }),
        el('td', {}, [app ? Comp.statusPill(app.status) : el('span', { class: 'tag', text: '未投递' })]),
        el('td', { class: 'fitcell' }, [(function () {
          var ft = fitOf(j);
          /* 紧凑视图不放五维分数（列太窄），但**原因一定要留** ——
             "只给个总分、想不通为什么"比不给分更让人不信 */
          return Comp.fitLine(ft, { compact: true });
        })()]),
        el('td', { text: v.score ? v.score : '—' }),
        el('td', { class: 'fs11 muted', text: (j.tags || []).slice(0, 3).join(' ') || '—' }),
        el('td', { class: 'fs11 muted', text: U.d2(j.createdAt) }),
        el('td', {}, [
          el('button', {
            class: 'btn xs', title: j.archived ? '取消归档' : '归档',
            text: j.archived ? '♻️' : '📦',
            onclick: function (e) { e.stopPropagation(); Store.toggleJobFlag(j.id, 'archived'); onChange(); },
          }),
        ]),
      ].filter(Boolean)));
    });
    tb.appendChild(tbody);
    box.appendChild(tb);
    return box;
  }

  /* ---------------- 按公司聚合视图 ---------------- */
  /**
   * 同一家公司的岗位归到一个折叠块里，summary 上直接给「几个岗位 / 投了几个 / 最远进展」。
   * 一个岗位库几十条、五六家公司来回投的时候，卡片视图根本看不出"这家我投到哪了"。
   */
  function companyGroups(jobs, onChange, rebuild) {
    var box = el('div', { class: 'stack', style: 'gap:9px' });
    var map = {};
    jobs.forEach(function (j) { (map[j.company || '（未填公司）'] = map[j.company || '（未填公司）'] || []).push(j); });

    var names = Object.keys(map).sort(function (a, b) { return map[b].length - map[a].length; });
    names.forEach(function (name) {
      var list = map[name];
      var apps = list.map(function (j) { return Store.appOfJob(j.id); }).filter(Boolean);
      var far = apps.slice().sort(function (a, b) { return Store.reachedIndex(b) - Store.reachedIndex(a); })[0];
      var noApp = list.length - apps.length;

      var grp = el('details', { class: 'fold grp-co' });
      if (names.length <= 6 || apps.length) grp.setAttribute('open', '');
      grp.appendChild(el('summary', {}, [
        el('b', { class: 'fs13', text: name }),
        el('span', { class: 'tag', text: list.length + ' 个岗位' }),
        noApp ? el('span', { class: 'tag warn', text: noApp + ' 个没投' }) : null,
        far ? el('span', { class: 'tag brand', text: '最远：' + Store.statusName(far.status) }) : null,
        list[0].industry ? el('span', { class: 'muted fs11', text: list[0].industry }) : null,
      ].filter(Boolean)));

      var inner = el('div', { class: 'co-body' });
      list.forEach(function (j) {
        var app = Store.appOfJob(j.id);
        var v = j.aiVerdict || {};
        inner.appendChild(el('div', { class: 'co-row', onclick: function () { openDetail(j.id, onChange); } }, [
          el('div', { class: 'flex1' }, [
            el('div', { class: 'fs13 fw6', text: j.title || '(未命名)' }),
            el('div', { class: 'fs11 muted', text: [j.salaryText || '面议', j.location].filter(Boolean).join(' · ') }),
          ]),
          v.score ? el('span', { class: 'tag ' + (v.score >= 80 ? 'ok' : v.score >= 70 ? 'info' : 'warn'), text: '匹配 ' + v.score }) : null,
          app ? Comp.statusPill(app.status) : el('span', { class: 'tag', text: '未投递' }),
          j.favorite ? el('span', { class: 'fs12', text: '⭐' }) : null,
          j.archived ? el('span', { class: 'tag', text: '已归档' }) : null,
        ].filter(Boolean)));
      });
      grp.appendChild(inner);

      grp.appendChild(el('div', { class: 'co-foot' }, [
        el('button', {
          class: 'btn xs', text: '只看这家公司',
          onclick: function (e) {
            e.preventDefault(); e.stopPropagation();
            F.kw = name; rebuild();
          },
        }),
        el('button', {
          class: 'btn xs', html: '批量操作这 ' + list.length + ' 个',
          onclick: function (e) {
            e.preventDefault(); e.stopPropagation();
            SEL.on = true; SEL.ids = list.map(function (x) { return x.id; });
            onChange();
          },
        }),
      ]));

      box.appendChild(grp);
    });
    return box;
  }

  /* ---------------- 批量操作条 ---------------- */
  /**
   * 勾选多个岗位后的浮动操作条。
   * 之前只有「单个操作」：想归档五个岗位就得点进五次详情 —— 这是体检报告里
   * 「现在只能单个操作」那条建议直接落地的部分。
   */
  function buildBatchBar(onChange, rebuild) {
    /* ids 只在"渲染这一刻"用来算按钮文案（全收藏了没、全归档了没）。
       ⚠️ 动作回调里必须重新读 SEL.ids，不能复用这个局部变量：
       外部只要把 SEL.ids 换成另一个数组（selExit / 全选 / 卡片勾选），
       局部变量还指着旧数组，按钮就会对着一批"已经不在选中集里"的岗位动手。 */
    var ids = SEL.ids;
    var allIds = filterJobs().map(function (j) { return j.id; });
    function need() {
      if (!SEL.ids.length) { U.toast('先在卡片上点一下选中岗位（点卡片就是勾选）', 'warn'); return false; }
      return true;
    }
    function after(msg) {
      U.toast(msg, 'ok');
      App.updateNavCounts();
      onChange();
    }

    var favAll = ids.length > 0 && ids.every(function (id) { var j = Store.job(id); return j && j.favorite; });
    var archAll = ids.length > 0 && ids.every(function (id) { var j = Store.job(id); return j && j.archived; });

    function flagBtn(field, allOn, onIcon, onText, offIcon, offText) {
      return el('button', {
        class: 'btn sm', html: (allOn ? onIcon + ' ' + onText : offIcon + ' ' + offText),
        onclick: function () {
          if (!need()) return;
          var p = {}; p[field] = !allOn;
          var n = Store.updateJobs(SEL.ids, p);
          after((!allOn ? onText : offText) + ' ' + n + ' 个');
        },
      });
    }

    var bar = el('div', { class: 'bbar' }, [
      el('b', { class: 'fs13', text: '已选 ' + ids.length + ' 个' }),
      el('button', { class: 'btn xs', text: '全选本页 ' + allIds.length,
        onclick: function () { SEL.ids = allIds.slice(); onChange(); } }),
      el('button', { class: 'btn xs', text: '反选', onclick: function () {
        var cur = SEL.ids;
        SEL.ids = allIds.filter(function (id) { return cur.indexOf(id) < 0; });
        onChange();
      } }),
      el('button', { class: 'btn xs', text: '清空', onclick: function () { SEL.ids = []; onChange(); } }),
      el('span', { class: 'sp' }),

      flagBtn('favorite', favAll, '⭐', '取消收藏', '☆', '收藏'),
      flagBtn('archived', archAll, '♻️', '取消归档', '📦', '归档'),
      el('button', { class: 'btn sm', html: '🏷 打标签', onclick: function () {
        if (!need()) return;
        var cur = SEL.ids.slice();
        U.prompt('给选中的 ' + cur.length + ' 个岗位打标签', '标签（逗号分隔可打多个）', '', { placeholder: '急招, 远程' })
          .then(function (v) {
            if (!v) return;
            var tags = U.asArray(v, true);
            cur.forEach(function (id) { tags.forEach(function (t) { Store.addJobTag(id, t); }); });
            after('已给 ' + cur.length + ' 个岗位加上 ' + tags.join(' / '));
          });
      } }),
      el('button', { class: 'btn sm', html: '📋 加入看板', onclick: function () { if (need()) batchToKanban(SEL.ids, function () { after('已加入投递看板'); }); } }),
      el('button', { class: 'btn sm danger', html: '🗑 删除', onclick: function () {
        if (!need()) return;
        var cur = SEL.ids.slice();
        var extra = cur.reduce(function (acc, id) {
          var a = Store.appOfJob(id); if (a) acc.a++;
          var v = Store.interviews({ jobId: id }).length; acc.v += v;
          return acc;
        }, { a: 0, v: 0 });
        var n = cur.length;
        var snap = Store.takeOut({ jobs: cur });
        SEL.ids = []; SEL.on = false;
        App.updateNavCounts();
        onChange();
        Comp.trashToast('已删除 ' + n + ' 个岗位' +
          (extra.a || extra.v ? '（连带 ' + extra.a + ' 条投递、' + extra.v + ' 场面试）' : ''),
          snap, function () { onChange(); rebuild && rebuild(); });
      } }),
      el('button', { class: 'btn xs ghost', text: '✕ 退出批量', onclick: function () { selExit(); onChange(); } }),
    ]);
    return bar;
  }

  /** 批量加入投递看板：已有投递的按状态推进，没有的按「待投递」建 */
  function batchToKanban(ids, done) {
    var picked = 'todo';
    var body = el('div', { class: 'stack', style: 'gap:7px' });
    var btns = [];
    Store.STATUSES.forEach(function (s) {
      var b = el('div', {
        class: 'box pointer', style: 'cursor:pointer;' + (s.id === picked ? 'border-color:var(--brand);background:var(--brand-soft)' : ''),
        onclick: function () {
          picked = s.id;
          btns.forEach(function (x) { x.style.borderColor = ''; x.style.background = ''; });
          b.style.borderColor = 'var(--brand)'; b.style.background = 'var(--brand-soft)';
        },
      }, [Comp.statusPill(s.id), el('span', { class: 'muted fs12', text: '　' + (s.hint || '') })]);
      btns.push(b);
      body.appendChild(b);
    });

    U.openModal({
      title: '批量加入投递看板（' + ids.length + ' 个）',
      body: el('div', {}, [
        el('div', { class: 'note line mb12 fs12', html: '已经有投递记录的岗位，只会在状态**更靠前**时才推进，不会把进度倒退。' }),
        el('div', { class: 'grid g2', style: 'gap:7px' }, btns),
      ]),
      footer: [
        { text: '确定', cls: 'pri', onClick: function (c) {
          var added = 0, moved = 0;
          ids.forEach(function (id) {
            var a = Store.appOfJob(id);
            if (!a) { Store.addApplication({ jobId: id, status: picked }); added++; }
            else if (Store.chainIndex(picked) > Store.chainIndex(a.status)) {
              Store.moveApplication(a.id, picked, '批量操作'); moved++;
            }
          });
          c();
          U.toast('新增 ' + added + ' 条，推进 ' + moved + ' 条', 'ok');
          App.updateNavCounts();
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  /* ---------------- 标签管理 ---------------- */
  /**
   * 以前标签只能"输入新增"，打错了就只能留着；也没有地方看每个标签用了多少次。
   */
  function openTagManager() {
    function paint(box) {
      box.innerHTML = '';
      var list = Store.allTags();
      if (!list.length) {
        box.appendChild(Comp.empty('🏷', '还没有任何标签', '在岗位详情里给岗位打标签，这里就能统一管理。'));
        return;
      }
      var card = el('div', { class: 'card' });
      card.appendChild(el('header', {}, [
        el('h3', { text: '全部标签（' + list.length + ' 个）' }),
        el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '改名会自动合并到同名标签，不会重复' }),
      ]));
      var body = el('div', {});
      list.forEach(function (t) {
        body.appendChild(el('div', { class: 'li' }, [
          el('div', { class: 'li-main' }, [
            el('div', { class: 'li-t' }, [el('span', { class: 'tag', text: t.tag })]),
            el('div', { class: 'li-s' }, [el('span', { text: t.n + ' 个岗位在用' })]),
          ]),
          el('div', { class: 'li-act' }, [
            el('button', { class: 'btn xs', text: '只看这些', onclick: function () { m.close(); F.tag = t.tag; App.go('jobs', {}); App.refresh(); } }),
            el('button', { class: 'btn xs', text: '改名', onclick: function () {
              U.prompt('重命名标签「' + t.tag + '」', '新名称', t.tag).then(function (v) {
                if (!v || v === t.tag) return;
                var n = Store.renameTag(t.tag, v.trim());
                U.toast('已把 ' + n + ' 个岗位的标签改成「' + v.trim() + '」', 'ok');
                if (F.tag === t.tag) F.tag = v.trim();
                paint(box); App.updateNavCounts();
              });
            } }),
            el('button', { class: 'btn xs danger', text: '删除', onclick: function () {
              U.confirm('从所有岗位上摘掉标签「' + U.esc(t.tag) + '」？<br><span class="muted fs12">' + t.n + ' 个岗位会失去这个标签，岗位本身不会被删。</span>',
                { title: '删除标签', danger: true, okText: '摘掉' }).then(function (ok) {
                if (!ok) return;
                Store.dropTag(t.tag);
                if (F.tag === t.tag) F.tag = '';
                U.toast('已摘掉这个标签', 'ok');
                paint(box); App.updateNavCounts();
              });
            } }),
          ]),
        ]));
      });
      card.appendChild(body);
      box.appendChild(card);
    }

    var holder = el('div', {});
    var m = U.openModal({
      title: '标签管理',
      size: 'wide',
      body: holder,
      footer: [{ text: '关闭', cls: 'pri', onClick: function (c) { c(); App.refresh(); } }],
    });
    paint(holder);
  }

  /* ==================== 详情 ==================== */
  /**
   * 岗位详情。
   *
   * 改版要点（体检报告 二.1「详情弹窗分组」）：
   *   · 高频操作（收藏 / 归档 / 改状态 / AI）**固定在最上面**，列表再长也不用找；
   *   · 结构化信息 / 原始 JD / AI 分析 / 标签 / 笔记 各自折叠，默认只展开要看的；
   *   · 删除、加入对比这类低频或危险操作收进底部固定栏的「⋯ 更多」菜单 ——
   *     以前它们排在弹窗最底部，删个岗位得滚很久，还容易顺手点到。
   */
  function openDetail(id, onChange) {
    var j = Store.job(id);
    if (!j) { U.toast('岗位不存在', 'warn'); return; }

    var m = U.openModal({
      title: '岗位详情',
      size: 'xl',
      body: el('div', { id: 'detailBody' }),
      footer: [],
      maskClose: true,
    });
    var box = m.body;

    /**
     * 弹窗里改了数据（收藏 / 归档 / AI 重解析…）后统一走这里。
     * 之前只重画弹窗自己，底下的列表星标和顶部统计要等切页才更新 —— 用户会以为没生效。
     * 注意：只做就地重画，**不要**调 App.refresh()，
     * 否则从回调里整页重绘会再次触发这条链路，造成无限渲染循环。
     */
    function notify() {
      box.innerHTML = '';
      box.appendChild(detailContent(Store.job(id), notify, m.close));
      try { App.updateNavCounts(); } catch (e) { /* noop */ }
      var host = onChange || _pageRepaint;
      if (host) { try { host(); } catch (e) { /* 宿主页可能已经切走了 */ } }
    }

    notify();

    var foot = m.modal.querySelector('.mfoot');

    // 「⋯ 更多」：低频 + 危险操作都收在这里。菜单项在**点开时**才算，
    // 所以 notify() 重画内容后这里不用跟着重建。
    foot.appendChild(el('button', {
      class: 'btn', html: '⋯ 更多',
      onclick: function (e) {
        var cur = Store.job(id) || {};
        U.menu(e.currentTarget || e.target, [
          { icon: '✎', text: '编辑字段', onClick: function () { openJobForm(id, function () { notify(); }); } },
          { icon: '📋', text: '复制岗位信息', onClick: function () {
            U.copyText(jobToText(cur)).then(function (ok) { U.toast(ok ? '已复制岗位信息' : '复制失败', ok ? 'ok' : 'warn'); });
          } },
          { icon: '⚖️', text: '加入对比', onClick: function () { Compare.add(id); } },
          { icon: '📊', text: '导出这条为 Markdown', onClick: function () { exportJobMarkdown(cur); } },
          { divider: true },
          { icon: '🗑', text: '删除这个岗位', danger: true, onClick: function () { deleteJobWithUndo(id, m.close, onChange); } },
        ], { align: 'left' });
      },
    }));
    foot.appendChild(el('span', { class: 'sp' }));
    foot.appendChild(el('button', {
      class: 'btn', text: '关闭', onclick: function () { m.close(); },
    }));
  }

  /** 删岗位 + 可撤销（连带投递与面试，撤销一起回来） */
  function deleteJobWithUndo(id, closeFn, onChange) {
    var j = Store.job(id) || {};
    var apps = Store.appOfJob(id);
    var ivs = Store.interviews({ jobId: id }).length;
    var snap = Store.takeOut({ jobs: [id] });

    App.updateNavCounts();
    if (closeFn) { try { closeFn(); } catch (e) { /* noop */ } }
    var host = onChange || _pageRepaint;
    if (host) { try { host(); } catch (e) { /* noop */ } }

    var extra = [];
    if (apps) extra.push('1 条投递');
    if (ivs) extra.push(ivs + ' 场面试');
    Comp.trashToast('已删除岗位「' + U.truncate(j.title || '', 16) + '」' +
      (extra.length ? '（连带 ' + extra.join('、') + '）' : ''), snap, function () {
      if (host) { try { host(); } catch (e) { /* noop */ } }
    });
  }

  /** 把一条岗位导成 Markdown（方便贴进笔记 / 发给别人） */
  function jobToText(j) {
    var L = ['# ' + (j.title || '') + '　' + (j.salaryText || '面议')];
    L.push('- 公司：' + (j.company || '—') + (j.industry ? '（' + j.industry + '）' : ''));
    L.push('- 地点：' + (j.location || '—') + (j.remote ? '（支持远程）' : ''));
    if (j.reqDegree || j.reqYears) L.push('- 要求：' + [j.reqDegree, j.reqYears].filter(Boolean).join(' / '));
    if ((j.reqSkills || []).length) L.push('- 招聘标签：' + j.reqSkills.join('、'));
    if ((j.benefits || []).length) L.push('- 福利：' + j.benefits.join('、'));
    if (j.url) L.push('- 链接：' + j.url);
    if ((j.pros || []).length) L.push('\n## 优势\n- ' + j.pros.join('\n- '));
    if ((j.risks || []).length) L.push('\n## 风险\n- ' + j.risks.join('\n- '));
    if (j.note) L.push('\n## 我的笔记\n' + j.note);
    if (j.rawJD) L.push('\n## 原始 JD\n' + j.rawJD);
    return L.join('\n');
  }

  function exportJobMarkdown(j) {
    U.download('岗位_' + String(j.title || 'job').replace(/[\\/:*?"<>|]/g, '_') + '.md', jobToText(j), 'text/markdown');
    Store.markExported();
    U.toast('已导出 Markdown', 'ok');
  }

  /** 折叠分组外壳：标题 + 右侧一行小字，内容点开才占版面 */
  /**
   * 合适度拆解面板（本地规则分）。五个维度各一根进度条 + 加减分 + 命中词 + 一句话依据。
   * 放在详情最上面：用户点进详情，第一个想知道的永远是「这岗位值不值得投」。
   */
  function fitPanel(ft) {
    var W = global.JobScorer.WEIGHTS;
    var box = el('div', { class: 'fitpanel' });

    if (ft.gate.drop) {
      box.appendChild(el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '🚫' }),
        el('div', { html: '<b>硬性过滤判定：不值得投</b><br>' + U.esc(ft.gate.reason) }),
      ]));
      return box;
    }

    var bars = [
      { k: '岗位方向', v: ft.dims.direction, max: W.direction },
      { k: '关键词命中', v: ft.dims.keywords, max: W.keywords },
      { k: '薪资匹配', v: ft.dims.salary, max: W.salary },
      { k: '经验匹配', v: ft.dims.experience, max: W.experience },
      { k: '福利稳定', v: ft.dims.welfare, max: W.welfare },
    ];

    box.appendChild(el('div', { class: 'fp-head' }, [
      el('div', { class: 'fp-score ' + ft.level.cls }, [
        el('b', { text: String(ft.total) }),
        el('span', { class: 'fs11', text: '分' }),
      ]),
      el('div', { class: 'fp-meta' }, [
        el('div', { class: 'row', style: 'gap:6px' }, [
          el('span', { class: 'tag ' + ft.level.cls, text: ft.level.key + ' ' + ft.level.label }),
          el('span', { class: 'fs11 muted', text: ft.level.advice }),
        ]),
        el('div', { class: 'fp-reason', text: '\u201c' + ft.reason + '\u201d' }),
      ]),
    ]));

    var grid = el('div', { class: 'fp-dims' });
    bars.forEach(function (b) {
      var pct = Math.round(b.v / b.max * 100);
      grid.appendChild(el('div', { class: 'fp-dim' }, [
        el('span', { class: 'fp-dim-k', text: b.k }),
        el('span', { class: 'fp-dim-bar' }, [el('i', { style: 'width:' + pct + '%' })]),
        el('span', { class: 'fp-dim-v', text: b.v + '/' + b.max }),
      ]));
    });
    box.appendChild(grid);

    box.appendChild(el('div', { class: 'stack', style: 'gap:4px' }, [
      el('div', { class: 'fs12' }, [
        el('span', { class: 'muted', text: '命中关键词：' }),
        ft.hits.length
          ? el('span', { class: 'fw6 brand-c', text: ft.hits.join(' / ') })
          : el('span', { class: 'muted', text: '一个都没命中（当前口径 ' + global.JobScorer.config().keywords.length + ' 个关键词）' }),
      ]),
      el('div', { class: 'fs12' }, [
        el('span', { class: 'muted', text: '薪资：' }), el('span', { text: ft.notes.salary }),
      ]),
      el('div', { class: 'fs12' }, [
        el('span', { class: 'muted', text: '经验：' }), el('span', { text: ft.notes.experience }),
      ]),
      el('div', { class: 'fs12' }, [
        el('span', { class: 'muted', text: '福利：' }), el('span', { text: ft.notes.welfare }),
      ]),
      ft.delta.why.length ? el('div', { class: 'fs12' }, [
        el('span', { class: 'muted', text: '加减分（' + (ft.delta.value >= 0 ? '+' : '') + ft.delta.value + '）：' }),
        el('span', { text: ft.delta.why.join(' · ') }),
      ]) : null,
      ft.gate.warn.length ? el('div', { class: 'fs12 warn-c' }, [
        el('span', { class: 'muted', text: '降级观望：' }),
        el('span', { text: ft.gate.warn.map(function (w) { return w.text; }).join('；') }),
      ]) : null,
      ft.blind ? el('div', { class: 'fs11 muted', text: '⚠️ 这个岗位的 JD / 职责没采到，分数只看了标题和标签，仅供参考。' }) : null,
    ].filter(Boolean)));

    return box;
  }

  function foldGroup(title, opt) {
    opt = opt || {};
    var d = el('details', { class: 'fold dgroup' });
    if (opt.open) d.setAttribute('open', '');
    d.appendChild(el('summary', {}, [
      el('b', { class: 'fs13', text: title }),
      el('span', { class: 'sp' }),
      opt.hint ? el('span', { class: 'muted fs11', text: opt.hint }) : null,
    ].filter(Boolean)));
    return d;
  }

  function detailContent(j, repaint, close) {
    var app = Store.appOfJob(j.id);
    var v = j.aiVerdict || {};
    var wrap = el('div', { class: 'stack dwrap' });

    /* --- 顶部：标题 + 高频操作（粘住不滚） --- */
    wrap.appendChild(el('div', { class: 'dbar' }, [
      el('div', { class: 'row', style: 'gap:10px' }, [
        el('h3', { class: 'fs18', text: j.title || '(未取到岗位名)' }),
        el('span', { class: 'sal fs15', style: 'color:var(--bad);font-weight:700', text: j.salaryText || '面议' }),
        j.archived ? el('span', { class: 'tag', text: '已归档' }) : null,
        j.proxyHire ? el('span', { class: 'tag warn', text: '代招', title: 'BOSS 标注为代招 —— 劳动合同多半不在这家公司' }) : null,
        j.invalid ? el('span', { class: 'tag bad', text: '已失效', title: 'BOSS 标注已下线，投了大概率没回应' }) : null,
        el('span', { class: 'sp' }),
        el('button', {
          class: 'btn sm' + (j.favorite ? ' pri' : ''), html: j.favorite ? '⭐ 已收藏' : '☆ 收藏',
          onclick: function () { Store.toggleJobFlag(j.id, 'favorite'); repaint(); App.updateNavCounts(); },
        }),
        el('button', {
          class: 'btn sm', html: j.archived ? '♻️ 取消归档' : '📦 归档',
          onclick: function () { Store.toggleJobFlag(j.id, 'archived'); repaint(); },
        }),
        app ? Comp.statusPill(app.status) : el('span', { class: 'tag', text: '未投递' }),
        app ? el('button', {
          class: 'btn sm', text: '改状态',
          onclick: function () { changeStatusDialog(app.id, repaint); },
        }) : el('button', {
          class: 'btn sm pri', html: '＋ 加入看板',
          onclick: function () {
            Store.addApplication({ jobId: j.id, status: 'todo' });
            U.toast('已加入投递看板（待投递）', 'ok');
            App.updateNavCounts(); repaint();
          },
        }),
      ].filter(Boolean)),
      el('div', { class: 'row fs12 t2', style: 'gap:9px' }, [
        el('span', { text: j.company || '未知公司' }),
        j.industry ? el('span', { class: 'muted', text: j.industry }) : null,
        el('span', { class: 'muted', text: '· ' + (j.source === 'boss' ? 'BOSS 导入' : '手动新增') }),
        el('span', { class: 'muted', text: '· 录入 ' + U.d2t(j.createdAt) }),
        j.url ? el('a', { class: 'fs12', href: j.url, target: '_blank', rel: 'noreferrer', html: '↗ 在 BOSS 打开' }) : null,
      ].filter(Boolean)),
      /* AI 动作也属于高频，一起置顶 */
      el('div', { class: 'row' }, [
        el('button', { class: 'btn pri sm', html: '🤖 AI 重新解析', onclick: function () { aiParseJob(j.id, repaint); } }),
        el('button', { class: 'btn sm', html: '🎯 简历匹配打分', onclick: function () { aiMatchJob(j.id, repaint); } }),
        el('button', { class: 'btn sm', html: '👋 打招呼话术', onclick: function () { aiGreeting(j.id, repaint); } }),
        el('button', { class: 'btn sm', html: '🎙️ 备面材料', onclick: function () {
          AIInterview.prepFor(j.id, { onSaved: function () { App.updateNavCounts(); } });
        } }),
        el('button', { class: 'btn sm', html: '🎤 模拟面试', title: 'AI 扮演面试官连环追问，答完出复盘', onclick: function () {
          global.InterviewSim.start(j.id, { onSaved: function () { repaint(); } });
        } }),
      ]),
    ]));

    /* --- 主体两栏 --- */
    var left = el('div', { class: 'stack' });
    var right = el('div', { class: 'stack' });

    /* 避坑（第 31 轮）。
       ⛔ 位置是**有条件的**，不是固定顺序：
          · 红灯/黄灯 → 放在最上面（比「合适度」还靠前）。有问题就得第一眼看到，
            配不配是第二步的事。
          · 绿灯/未扫描 → 放到「合适度」之后。绝大多数岗位都没问题，
            让它霸占首屏会把真正要看的挤下去。 */
    var pit = global.Pitfall ? Pitfall.of(j) : null;
    var pitFold = null;
    if (pit) {
      var hot = pit.level === 'red' || pit.level === 'yellow';
      pitFold = foldGroup(
        (pit.level === 'red' ? '🔴 需注意' : pit.level === 'yellow' ? '🟡 需注意' : '🛡 避坑检查'),
        { open: hot, hint: hot ? (pit.redCount + pit.yellowCount) + ' 项' : Pitfall.LEVELS[pit.level].label });
      pitFold.appendChild(el('div', { class: 'fd' }, [Pitfall.panel(pit)]));
      if (hot) left.appendChild(pitFold);
    }

    /* 左：合适度拆解（本地规则，它就是「为什么推这条」的答案） */
    left.appendChild(fitPanel(fitOf(j)));

    /* 左：结构化信息（默认展开 —— 这是看 JD 时最常看的） */
    var infoFold = foldGroup('① 结构化信息', { open: true });
    var body = el('div', { class: 'fd' });
    body.appendChild(el('dl', { class: 'kv' }, [
      el('dt', { text: '地点' }), el('dd', { text: (j.location || '—') + (j.remote ? '（支持远程）' : '') }),
      j.address ? el('dt', { text: '详细地址' }) : null,
      j.address ? el('dd', { text: j.address }) : null,
      el('dt', { text: '薪资' }), el('dd', { text: (j.salaryText || '面议') + (j.salaryMonths ? '（约 ' + j.salaryMonths + ' 薪）' : '') }),
      j.scale ? el('dt', { text: '公司规模' }) : null,
      j.scale ? el('dd', { text: j.scale }) : null,
      el('dt', { text: '学历要求' }), el('dd', { text: j.reqDegree || '未写明' }),
      el('dt', { text: '经验要求' }), el('dd', { text: j.reqYears || '未写明' }),
      el('dt', { text: '福利' }), el('dd', {}, [Comp.tagList(j.benefits)]),
      // ⚠️ BOSS 的「技能标签」列是招聘卖点（如「接受无经验牛人」），不是硬性技能要求 → 不再叫「硬性技能」
      el('dt', { text: '招聘标签' }), el('dd', {}, [Comp.tagList(j.reqSkills, 'info')]),
      (j.hr || j.hrTitle) ? el('dt', { text: 'HR' }) : null,
      (j.hr || j.hrTitle) ? el('dd', {
        text: [j.hrTitle, j.hr].filter(Boolean).join(' ') +
          (j.hrOnline ? '（在线）' : (j.active ? '（' + j.active + '）' : '')),
      }) : null,
      el('dt', { text: '关键词' }), el('dd', {}, [Comp.tagList(j.keywords)]),
    ]));
    if (j.duties && j.duties.length) {
      body.appendChild(el('div', { class: 'divider' }));
      body.appendChild(el('div', { class: 'fs12 muted fw6 mb4', text: '岗位职责' }));
      body.appendChild(el('div', { class: 'stack', style: 'gap:4px' },
        j.duties.map(function (d) {
          return el('div', { class: 'fs13 row', style: 'align-items:flex-start;gap:6px' }, [
            el('span', { class: 'brand-c', text: '•' }),
            el('span', { class: 'flex1', text: d }),
          ]);
        })));
    }
    if (j.companyInfo) {
      body.appendChild(el('div', { class: 'divider' }));
      body.appendChild(el('div', { class: 'fs12 muted fw6 mb4', text: '公司简介' }));
      body.appendChild(el('div', {
        class: 'fs13',
        style: 'white-space:pre-wrap;line-height:1.7',
        text: j.companyInfo,
      }));
    }
    infoFold.appendChild(body);
    left.appendChild(infoFold);

    /* 左：AI 分析结果（有内容才默认展开，空的收起来） */
    var hasAI = (j.pros || []).length || (j.cons || []).length || (j.risks || []).length;
    var aiFold = foldGroup('② AI 分析结果', {
      open: !!hasAI,
      hint: j.aiAt ? U.rel(j.aiAt) + ' · ' + (j.aiModel || '') : '还没跑过 AI 解析',
    });
    var aiBody = el('div', { class: 'fd' });
    if (!hasAI) {
      aiBody.appendChild(el('div', { class: 'muted fs13', text: '点上面的「AI 重新解析」，让模型分析这个岗位的优势、风险与核心技能。' }));
    } else {
      aiBody.appendChild(groupBlock('✨ 岗位优势', j.pros, 'ok'));
      aiBody.appendChild(groupBlock('⚠️ 潜在风险', j.risks, 'warn'));
      aiBody.appendChild(groupBlock('🤔 需要留意', j.cons, ''));
    }
    aiFold.appendChild(aiBody);
    left.appendChild(aiFold);

    /* 左：原始 JD（默认收起，几千字铺开会把弹窗撑爆） */
    if (j.rawJD) {
      var jdFold = foldGroup('③ 原始 JD', { hint: j.rawJD.length + ' 字' });
      jdFold.appendChild(el('div', { class: 'fd' }, [
        el('div', { class: 'pre-wrap', text: j.rawJD }),
        el('div', { class: 'row mt8' }, [Comp.copyBtn(j.rawJD, '复制 JD')]),
      ]));
      left.appendChild(jdFold);
    }

    /* 左：标签（有标签才默认展开） */
    var tagFold = foldGroup('④ 标签', { open: (j.tags || []).length > 0, hint: (j.tags || []).length ? j.tags.join(' / ') : '未打标签' });
    tagFold.appendChild(tagEditor(j, repaint));
    left.appendChild(tagFold);

    /* 左：笔记（写过就默认展开，没写过收起来） */
    var noteTa = el('textarea', { rows: 4, placeholder: '记点什么：和 HR 的对话、要确认的问题、自己的想法…' });
    noteTa.value = j.note || '';
    var noteFold = foldGroup('⑤ 我的笔记', { open: !!j.note, hint: j.note ? j.note.length + ' 字' : '' });
    noteFold.appendChild(el('div', { class: 'fd' }, [
      noteTa,
      el('div', { class: 'row mt8' }, [
        el('button', {
          class: 'btn pri sm', text: '保存笔记',
          onclick: function () {
            Store.updateJob(j.id, { note: noteTa.value });
            U.toast('笔记已保存 ✅', 'ok');
            repaint();
          },
        }),
        el('span', { class: 'hint tiny', text: '岗位卡片上不显示笔记内容，只在详情里' }),
      ]),
    ]));
    left.appendChild(noteFold);

    /* 左：AI 面试模拟记录 */
    if (j.interviewSim && (j.interviewSim.transcript || []).length) {
      var simFold = foldGroup('⑥ 模拟面试记录', { hint: U.d2t(j.interviewSim.at || 0) });
      simFold.appendChild(el('div', { class: 'fd' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'hint tiny', text: (j.interviewSim.transcript.length) + ' 题 · ' + (j.interviewSim.round || '') }),
          el('span', { class: 'sp' }),
          el('button', { class: 'btn xs', text: '查看复盘', onclick: function () { global.InterviewSim.openResult(j.id); } }),
        ]),
      ]));
      left.appendChild(simFold);
    }

    /* 避坑（非红灯/黄灯时）放**左栏最后**。
       ⛔ 不能紧跟 fitPanel 之后：fitPanel 不是 foldGroup，所以那样排会让
          「🛡 避坑检查」成为**第一个折叠组**，把「① 结构化信息」挤下去 ——
          真机测试的「第一个分组默认展开（最常看的结构化信息）」当场就红了。
          没问题的岗位不该抢首屏。 */
    if (pitFold && pit.level !== 'red' && pit.level !== 'yellow') left.appendChild(pitFold);

    /* 右：投递状态 */
    var appCard = el('div', { class: 'card' }, [el('header', {}, [el('h3', { text: '投递记录' })])]);
    var appBody = el('div', { class: 'body' });
    if (!app) {
      appBody.appendChild(el('div', { class: 'muted fs13 mb12', text: '这个岗位还没有投递记录。' }));
      appBody.appendChild(el('button', {
        class: 'btn pri blk', html: '＋ 加入投递看板',
        onclick: function () {
          Store.addApplication({ jobId: j.id, status: 'todo' });
          U.toast('已加入投递看板（状态：待投递）', 'ok');
          App.updateNavCounts(); repaint();
        },
      }));
    } else {
      appBody.appendChild(el('div', { class: 'row mb12' }, [
        Comp.statusPill(app.status),
        el('span', { class: 'sp' }),
        el('button', {
          class: 'btn xs', text: '改状态',
          onclick: function () { changeStatusDialog(app.id, repaint); },
        }),
      ]));
      appBody.appendChild(el('dl', { class: 'kv' }, [
        el('dt', { text: '渠道' }), el('dd', { text: app.channel }),
        el('dt', { text: '投递时间' }), el('dd', { text: app.appliedAt ? U.d2(app.appliedAt) : '未记录' }),
        el('dt', { text: '使用简历' }), el('dd', {}, [
          el('span', { text: app.resumeId ? ((Store.resume(app.resumeId) || {}).name || '已删除') : '未绑定' }),
          el('button', {
            class: 'btn xs ghost', text: '更改',
            onclick: function () {
              Comp.resumePicker({ title: '绑定投递用的简历版本' }).then(function (rid) {
                if (rid) { Store.updateApplication(app.id, { resumeId: rid }); repaint(); U.toast('已绑定', 'ok'); }
              });
            },
          }),
        ]),
        el('dt', { text: '沟通薪资' }), el('dd', {}, [el('span', { text: app.salaryAsk || '—' })]),
      ]));
      if (app.hrSummary) {
        appBody.appendChild(el('div', { class: 'divider' }));
        appBody.appendChild(el('div', { class: 'fs12 muted fw6 mb4', text: 'HR 沟通摘要' }));
        appBody.appendChild(el('div', { class: 'box pre-wrap fs12', text: app.hrSummary }));
      }
      appBody.appendChild(el('div', { class: 'divider' }));
      appBody.appendChild(el('div', { class: 'fs12 muted fw6 mb8', text: '进展轨迹' }));
      var tl = el('div', { class: 'tl' });
      app.timeline.slice().reverse().forEach(function (t, i) {
        tl.appendChild(el('div', { class: 'it' + (i === 0 ? ' on' : '') }, [
          el('div', { class: 'tt', text: Store.statusName(t.status) }),
          el('div', { class: 'tm', text: U.d2t(t.at) + (t.note ? ' · ' + t.note : '') }),
        ]));
      });
      appBody.appendChild(tl);
    }
    appCard.appendChild(appBody);
    right.appendChild(appCard);

    /* 右：AI 匹配结论 */
    var matchCard = el('div', { class: 'card' }, [
      el('header', {}, [
        el('h3', { text: '简历匹配结论' }),
        el('span', { class: 'sp' }),
        v.score ? el('span', { class: 'hint', text: U.rel(j.aiVerdictAt || 0) }) : null,
      ].filter(Boolean)),
    ]);
    var mBody = el('div', { class: 'body' });
    if (!v.score) {
      mBody.appendChild(el('div', { class: 'muted fs13 mb12', text: '还没做过匹配评估。' }));
      mBody.appendChild(el('button', {
        class: 'btn blk', html: '🎯 用简历做一次匹配评估',
        onclick: function () { aiMatchJob(j.id, repaint); },
      }));
    } else {
      var cls = v.category === 'qualified' ? 'ok' : v.category === 'need_optimization' ? 'warn' : 'bad';
      mBody.appendChild(el('div', { class: 'row mb12' }, [
        el('span', { class: 'stat v', style: 'font-size:30px;color:var(--' + (cls === 'ok' ? 'ok' : cls === 'warn' ? 'warn' : 'bad') + ')', text: v.score }),
        el('div', {}, [
          el('div', { class: 'fw6 fs13', text: v.verdict || '' }),
          el('div', { class: 'fs12 muted', text: categoryText(v.category) }),
        ]),
      ]));
      if (v.matched && v.matched.length) mBody.appendChild(groupBlock('✅ 匹配上的点', v.matched, 'ok', true));
      if (v.missing && v.missing.length) mBody.appendChild(groupBlock('❌ 缺失的要求', v.missing, 'bad', true));
      if (v.suggestions && v.suggestions.length) mBody.appendChild(groupBlock('🛠 简历修改建议', v.suggestions, 'info', true));
      if (v.greetingHint) {
        mBody.appendChild(el('div', { class: 'note brand mt8' }, [
          el('span', { class: 'ico', text: '💡' }),
          el('div', {}, [el('b', { text: '打招呼时强调：' }), el('span', { text: v.greetingHint })]),
        ]));
      }
      mBody.appendChild(el('button', {
        class: 'btn blk sm mt12', text: '重新评估',
        onclick: function () { aiMatchJob(j.id, repaint); },
      }));
    }
    matchCard.appendChild(mBody);
    right.appendChild(matchCard);

    /* 右：已生成的打招呼话术 */
    if (j.aiGreeting) {
      var gCard = el('div', { class: 'card' }, [
        el('header', {}, [
          el('h3', { text: '打招呼话术' }),
          el('span', { class: 'sp' }),
          Comp.copyBtn(j.aiGreeting, '复制'),
          el('button', { class: 'btn xs', text: '重生成', onclick: function () { aiGreeting(j.id, repaint); } }),
        ]),
      ]);
      gCard.appendChild(el('div', { class: 'body' }, [el('div', { class: 'box pre-wrap fs13', text: j.aiGreeting })]));
      right.appendChild(gCard);
    }

    /* 右：相关面试 */
    var ivs = Store.interviews({ jobId: j.id });
    if (ivs.length) {
      var ivCard = el('div', { class: 'card' }, [el('header', {}, [el('h3', { text: '相关面试' })])]);
      var ivBody = el('div', {});
      ivs.forEach(function (v2) {
        ivBody.appendChild(el('div', { class: 'li' }, [
          el('div', { class: 'li-main' }, [
            el('div', { class: 'li-t', text: v2.round + '　' + (v2.at ? U.d2t(v2.at) : '未定时间') }),
            el('div', { class: 'li-s' }, [
              el('span', { text: v2.mode === 'offline' ? '线下' : v2.mode === 'phone' ? '电话' : '线上' }),
              el('span', { text: v2.status === 'done' ? '已完成' : v2.status === 'canceled' ? '已取消' : '待进行' }),
            ]),
          ]),
          el('div', { class: 'li-act' }, [
            el('button', { class: 'btn xs', text: '打开', onclick: function () { close(); App.go('interview', { interviewId: v2.id }); } }),
          ]),
        ]));
      });
      ivCard.appendChild(ivBody);
      right.appendChild(ivCard);
    }

    /* 危险操作（删除 / 加入对比）已经挪到底部固定栏的「⋯ 更多」菜单里 ——
       以前它排在弹窗最底部，删个岗位得滚半天，还容易顺手点到。 */

    wrap.appendChild(el('div', { class: 'grid dgrid', style: 'grid-template-columns:minmax(0,1.25fr) minmax(0,1fr);gap:14px' }, [left, right]));
    return wrap;
  }

  function groupBlock(title, arr, cls, small) {
    if (!arr || !arr.length) return el('span');
    var box = el('div', { class: 'mb12' });
    box.appendChild(el('div', { class: 'fs12 fw6 mb4 ' + (cls === 'ok' ? 'ok-c' : cls === 'warn' ? 'warn-c' : cls === 'bad' ? 'bad-c' : cls === 'info' ? 'brand-c' : 't2'), text: title }));
    var list = el('div', { class: 'stack', style: 'gap:4px' });
    arr.forEach(function (x) {
      list.appendChild(el('div', { class: 'fs' + (small ? '12' : '13') + ' row', style: 'align-items:flex-start;gap:6px' }, [
        el('span', { class: 'muted', text: '·' }),
        el('span', { class: 'flex1 pre-wrap', text: String(x) }),
      ]));
    });
    box.appendChild(list);
    return box;
  }

  function categoryText(c) {
    return c === 'qualified' ? '✅ 符合，建议投递'
      : c === 'need_optimization' ? '⚠️ 优化简历后可投'
      : c === 'cannot_apply' ? '⛔ 暂不建议投递' : '';
  }

  function tagEditor(j) {
    var body = el('div', { class: 'fd' });
    var chips = el('div', { class: 'chips mb8' });
    function paintChips() {
      chips.innerHTML = '';
      var cur = (Store.job(j.id) || {}).tags || [];
      if (!cur.length) chips.appendChild(el('span', { class: 'muted fs12', text: '还没有标签' }));
      cur.forEach(function (t) {
        chips.appendChild(el('span', { class: 'tag', html: U.esc(t) + ' <span class="x">✕</span>',
          onclick: function () { Store.removeJobTag(j.id, t); paintChips(); syncFoldHint(); } }));
      });
      // 常用标签快捷加
      ['外包', '派遣', '远程', '急招', '国企', '大厂', '初创', '技术岗', '销售岗'].forEach(function (t) {
        if (cur.indexOf(t) >= 0) return;
        chips.appendChild(el('span', { class: 'tag line pointer', style: 'cursor:pointer;opacity:.7',
          html: '＋' + U.esc(t), onclick: function () { Store.addJobTag(j.id, t); paintChips(); syncFoldHint(); } }));
      });
    }
    // 改了标签，顺手把折叠标题右边那行小字也更新掉
    function syncFoldHint() {
      var h = body.parentNode && body.parentNode.querySelector('summary .muted');
      if (h) h.textContent = ((Store.job(j.id) || {}).tags || []).join(' / ') || '未打标签';
    }
    var inp = el('input', { type: 'text', placeholder: '输入自定义标签后回车', style: 'max-width:240px' });
    inp.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && inp.value.trim()) {
        Store.addJobTag(j.id, inp.value.trim()); inp.value = ''; paintChips(); syncFoldHint();
      }
    });
    paintChips();
    body.appendChild(chips);
    body.appendChild(el('div', { class: 'row' }, [
      inp,
      el('button', { class: 'btn xs ghost', text: '⚙ 标签管理', onclick: openTagManager }),
    ]));
    body.appendChild(el('div', { class: 'hint tiny mt4', text: '常用标签：外包 · 派遣 · 远程 · 急招 · 国企 · 大厂 · 初创（点一下即可加）' }));
    return body;
  }

  /* ==================== AI 动作 ==================== */

  /** 用原始 JD 重新跑一次结构化解析，写回岗位 */
  function aiParseJob(id, after) {
    var j = Store.job(id);
    if (!j) return;
    if (!j.rawJD && !j.title) { U.toast('这个岗位没有 JD 文本可解析', 'warn'); return; }
    Comp.runAI({
      title: 'AI 解析岗位 · ' + (j.title || ''),
      tpl: 'jobParse',
      input: { text: j.rawJD || j.title, url: j.url },
      applyLabel: '写入这个岗位',
      onApply: function (data, raw) {
        var patch = fromParsed(data);
        patch.aiAt = U.now();
        patch.aiModel = AI.cfg().model || '';
        Store.updateJob(id, patch);
        U.toast('已更新岗位字段 ✅', 'ok');
        if (after) after();
      },
    });
  }

  /**
   * 把模型解析结果转成岗位字段补丁。
   *
   * ⛔ 只放**模型真的返回值**的字段（评审 2.5）。
   *    以前是「每个字段都写进去，没返回的写 undefined」，而 `updateJob` 是
   *    `Object.assign({}, j, patch)` —— `undefined` 会**覆盖**旧值，`normJob` 再统一成 `''`。
   *    后果：用户手打的公司名 / 薪资 / 标签 / 福利，在点「AI 重新解析」之后**凭空消失**，
   *    而且没有任何提示 —— 用户只会觉得"我的东西怎么没了"。
   *    现在：没返回的字段**不进补丁** → Object.assign 不碰它们 → 手打的内容保住。
   *
   * ⚠️ 这也意味着「AI 解析不会清空旧字段」。这是**有意的取舍**：
   *    解析结果里"没有这个字段"和"这个字段应该是空的"在模型输出里无法区分，
   *    而猜错的代价（删掉用户手打的笔记）比留着一个旧值大得多。
   */
  function fromParsed(d) {
    if (!d) return {};
    var out = {};
    function put(k, v) {                       // 字符串类：非空才写
      if (v === null || v === undefined) return;
      var s = String(v).trim();
      if (s) out[k] = s;
    }
    function putNum(k) {                       // 数字类：解析不出来（null）就不写
      var n = U.asNum(d[k]);
      if (n !== null) out[k] = n;
    }
    function putArr(k, split) {                // 数组类：非空才写
      var a = U.asArray(d[k], split);
      if (a.length) out[k] = a;
    }

    put('title', d.title);
    put('company', d.company);
    put('industry', d.industry);
    put('location', d.location);
    /* remote 是布尔，**照写** —— 它跟字符串不一样：模型要么说远程要么不说，
       这里 `!!` 得到的是"明确答案"，不存在"没返回"这种中间态需要保护的旧值。 */
    out.remote = !!d.remote;
    put('salaryText', d.salaryText);
    putNum('salaryMin'); putNum('salaryMax'); putNum('salaryMonths');
    putArr('benefits', true);
    putArr('duties');
    put('reqDegree', d.reqDegree);
    put('reqYears', d.reqYears);
    putArr('reqSkills', true);
    putArr('keywords', true);
    putArr('tags', true);
    putArr('risks');
    putArr('pros');
    putArr('cons');
    return out;
  }

  function aiMatchJob(id, after) {
    var j = Store.job(id);
    Comp.resumePicker({ title: '用哪份简历做匹配评估？' }).then(function (rid) {
      if (!rid) return;
      var r = Store.resume(rid);
      Comp.runAI({
        title: 'AI 简历匹配评估',
        tpl: 'match',
        input: { resume: AI.resumeToText(r), job: AI.jobToText(j, true) },
        applyLabel: '保存评估结论',
        onApply: function (data) {
          Store.updateJob(id, {
            aiVerdict: {
              score: U.asNum(data.score),
              verdict: String(data.verdict || ''),
              category: String(data.category || ''),
              matched: U.asArray(data.matched),
              missing: U.asArray(data.missing),
              risks: U.asArray(data.risks),
              suggestions: U.asArray(data.suggestions),
              keywordsToAdd: U.asArray(data.keywordsToAdd, true),
              greetingHint: String(data.greetingHint || ''),
              resumeId: rid,
            },
            aiVerdictAt: U.now(),
          });
          U.toast('评估已保存 ✅', 'ok');
          if (after) after();
        },
      });
    });
  }

  function aiGreeting(id, after) {
    var j = Store.job(id);
    Comp.resumePicker({ title: '用哪份简历生成打招呼话术？' }).then(function (rid) {
      if (!rid && !Store.defaultResume()) return;
      var r = rid ? Store.resume(rid) : Store.defaultResume();
      Comp.runAI({
        title: '生成 BOSS 打招呼话术',
        tpl: 'greeting',
        input: { job: AI.jobToText(j), resume: AI.resumeToText(r, 1600) },
        applyLabel: '保存到岗位',
        onApply: function (data, raw) {
          var text = raw || data;
          Store.updateJob(id, { aiGreeting: String(text).trim() });
          U.copyText(String(text).trim());
          U.toast('已保存并复制到剪贴板，可以直接粘到 BOSS 聊天框 ✅', 'ok');
          if (after) after();
        },
      });
    });
  }

  /* ==================== 导入 ==================== */

  function openImport() {
    var wrap = el('div', { class: 'stack' });

    wrap.appendChild(el('div', { class: 'note info' }, [
      el('span', { class: 'ico', text: '🛡️' }),
      el('div', { html:
        '<b>最省事的做法</b>：像平时一样在 BOSS 岗位页选中文字 <kbd>Ctrl+C</kbd>，粘到这里，AI 帮你拆字段。<br>' +
        '岗位多的话，可以到 <b>📡 采集岗位</b> 让本地采集器一次捞一批回来 —— ' +
        '它只读你已经能看到的列表内容，<b>不自动发消息、不自动投递</b>。' }),
    ]));

    /* 方式选择 */
    var mode = 'paste';
    var seg = el('div', { class: 'seg' });
    var modes = [
      { id: 'paste', label: '粘贴岗位文字（推荐）' },
      { id: 'manual', label: '手动填写' },
    ];
    var segBtns = {};
    modes.forEach(function (x) {
      var b = el('button', { class: mode === x.id ? 'on' : '', text: x.label, onclick: function () {
        mode = x.id;
        Object.keys(segBtns).forEach(function (k) { segBtns[k].classList.toggle('on', k === x.id); });
        paint();
      } });
      segBtns[x.id] = b;
      seg.appendChild(b);
    });

    var area = el('div', {}, []);
    // 注意：合规说明要先 add 进 wrap，再把 wrap 当 body 交给弹窗 —— 否则这段提示不会显示
    wrap.appendChild(el('div', { class: 'mt12' }, [seg]));
    wrap.appendChild(area);
    var m = U.openModal({
      title: '导入 BOSS 岗位',
      size: 'wide',
      body: wrap,
      footer: [{ text: '取消', onClick: function (c) { c(); } }],
      maskClose: true,
    });

    function paint() {
      area.innerHTML = '';
      if (mode === 'paste') paintPaste();
      else paintManual();
    }

    /* ---- 粘贴 + AI 解析 ---- */
    function paintPaste() {
      var urlInp = el('input', { type: 'text', placeholder: '岗位链接（选填，但建议填：方便以后一键回 BOSS 打开）' });
      var ta = el('textarea', { rows: 11, placeholder:
        '把 BOSS 岗位页面的文字整段粘贴到这里。\n\n' +
        '怎么复制最快：在 BOSS 岗位详情页按 Ctrl+A 全选 → Ctrl+C，直接粘进来就行，' +
        '乱七八糟的导航文字 AI 会自己忽略。' });

      var tips = el('details', { class: 'fold' }, [
        el('summary', { text: '不知道复制什么？点这里看要点' }),
        el('div', { class: 'fd', text:
          '最省事的做法：在 BOSS 岗位详情页 Ctrl+A 全选整个页面 → Ctrl+C → 粘到上面输入框。\n\n' +
          '如果你只想复制重点，确保包含这几块：\n' +
          '· 岗位名称 / 薪资（一般在标题区域）\n' +
          '· 公司名称与行业\n' +
          '· 工作地点\n' +
          '· 职位描述（岗位职责）\n' +
          '· 任职要求（学历、经验、技能）\n\n' +
          'AI 会自动忽略无关的导航、推荐位文字。' }),
      ]);

      var status = el('div', { class: 'row fs12 muted' });

      area.appendChild(el('div', { class: 'stack' }, [
        el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '岗位链接（选填）' }), urlInp]),
        el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '岗位文字（必填）' }), ta]),
        tips,
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn pri', html: '🤖 AI 解析岗位',
            onclick: function () {
              var text = ta.value.trim();
              if (text.length < 20) { U.toast('太短了，至少把岗位名称和任职要求粘进来', 'warn'); return; }
              parseAndSave(text, urlInp.value.trim(), m, function () { ta.value = ''; urlInp.value = ''; });
            },
          }),
          el('button', {
            class: 'btn', html: '不用 AI，直接存原文',
            onclick: function () {
              var text = ta.value.trim();
              if (!text) { U.toast('请先粘贴内容', 'warn'); return; }
              var guess = guessFromText(text);
              Store.addJob({
                source: 'boss', rawJD: text, url: urlInp.value.trim(),
                title: guess.title, company: guess.company, salaryText: guess.salary,
                location: guess.location,
              });
              U.toast('已存下原文（未做 AI 解析，可稍后在详情页补跑）', 'ok');
              App.updateNavCounts(); App.refresh(); m.close();
            },
          }),
          el('span', { class: 'sp' }),
          status,
        ]),
      ]));
    }

    /* ---- 手动填写 ---- */
    function paintManual() {
      var f = manualForm();
      area.appendChild(el('div', { class: 'stack' }, [
        f.node,
        el('div', { class: 'row' }, [
          el('button', {
            class: 'btn pri', text: '保存岗位',
            onclick: function () {
              var v = f.values();
              if (!v.title) { U.toast('岗位名称必填', 'warn'); return; }
              var r = Store.addJob(Object.assign({ source: 'manual' }, v, {
                salaryMin: U.asNum(v.salaryMin), salaryMax: U.asNum(v.salaryMax),
                benefits: U.asArray(v.benefits, true), reqSkills: U.asArray(v.reqSkills, true),
                tags: U.asArray(v.tags, true), duties: U.asArray(v.duties),
                url: v.url || '',
              }));
              U.toast(r.dup ? '已合并到已有岗位（同一个链接/公司+岗位）' : '已新增岗位 ✅', 'ok');
              App.updateNavCounts(); App.refresh(); m.close();
            },
          }),
          el('button', { class: 'btn', text: '取消', onclick: function () { m.close(); } }),
        ]),
      ]));
    }

    paint();
  }

  function parseAndSave(text, url, modal, onSuccess) {
    Comp.runAI({
      title: 'AI 解析岗位',
      tpl: 'jobParse',
      input: { text: text, url: url },
      applyLabel: '保存到岗位库',
      onApply: function (data, raw) {
        var patch = fromParsed(data);
        patch.source = 'boss';
        patch.rawJD = text;
        patch.url = url || '';
        patch.aiAt = U.now();
        patch.aiModel = AI.cfg().model || '';
        var r = Store.addJob(patch);
        U.toast(r.dup ? '已合并到已有岗位（识别到重复）' : '已存入岗位库 ✅', 'ok');
        App.updateNavCounts(); App.refresh();
        if (onSuccess) onSuccess();
        if (modal) modal.close();
      },
    });
  }

  /** 无 AI 时从纯文本粗略抓几个字段（保底，不保证准） */
  function guessFromText(t) {
    var ls = U.lines(t);
    var title = '', company = '', salary = '', location = '';
    var sm = t.match(/\d+(?:\.\d+)?\s*[-~]\s*\d+(?:\.\d+)?\s*[kK](?:\s*[·x×]\s*\d+薪)?/);
    if (sm) salary = sm[0].replace(/\s/g, '');
    for (var i = 0; i < Math.min(ls.length, 14); i++) {
      if (!title && ls[i].length <= 26 && /[\u4e00-\u9fa5]/.test(ls[i]) &&
          !/^(职位描述|岗位职责|任职要求|公司|招聘)/.test(ls[i])) title = ls[i];
      if (!company && /(有限公司|股份|集团|科技|网络|信息|传媒|文化|工作室|中心)/.test(ls[i]) && ls[i].length <= 30) company = ls[i];
    }
    var lm = t.match(/(北京|上海|广州|深圳|杭州|成都|武汉|南京|西安|苏州|长沙|重庆|天津|合肥|郑州|青岛|厦门|福州|济南|宁波|无锡|珠海|东莞|佛山|石家庄|昆明|大连|沈阳)/);
    if (lm) location = lm[1];
    return { title: title, company: company, salary: salary, location: location };
  }

  /* ---------------- 手动新增 / 编辑表单 ---------------- */
  function manualForm(j) {
    j = j || {};
    var f = Comp.fields([
      { key: 'title', label: '岗位名称 *', placeholder: '如：短视频运营' },
      { key: 'company', label: '公司名称', placeholder: '如：某某科技有限公司' },
      { key: 'industry', label: '所属行业', placeholder: '如：互联网 / 人工智能' },
      { key: 'location', label: '工作地点', placeholder: '如：杭州 · 西湖区' },
      { key: 'salaryText', label: '薪资（原始文本）', placeholder: '如：10-15K·13薪' },
      { key: 'salaryMin', label: '薪资下限（K）', type: 'number', placeholder: '10' },
      { key: 'salaryMax', label: '薪资上限（K）', type: 'number', placeholder: '15' },
      { key: 'salaryMonths', label: '年终奖月数', type: 'number', placeholder: '13' },
      { key: 'reqDegree', label: '学历要求', placeholder: '大专 / 本科 / 不限' },
      { key: 'reqYears', label: '经验要求', placeholder: '1-3年 / 经验不限' },
      { key: 'url', label: '岗位链接', placeholder: 'https://www.zhipin.com/job_detail/...' },
      { key: 'tags', label: '标签（逗号分隔）', placeholder: '急招, 远程' },
      { key: 'reqSkills', label: '招聘标签（逗号分隔）', placeholder: '抖音, 剪映, 数据分析' },
      { key: 'benefits', label: '福利（逗号分隔）', placeholder: '五险一金, 双休' },
    ], 2);

    if (j.title) f.map.title.set(j.title);
    if (j.company) f.map.company.set(j.company);
    if (j.industry) f.map.industry.set(j.industry);
    if (j.location) f.map.location.set(j.location);
    if (j.salaryText) f.map.salaryText.set(j.salaryText);
    if (j.salaryMin !== null && j.salaryMin !== undefined) f.map.salaryMin.set(j.salaryMin);
    if (j.salaryMax !== null && j.salaryMax !== undefined) f.map.salaryMax.set(j.salaryMax);
    if (j.salaryMonths) f.map.salaryMonths.set(j.salaryMonths);
    if (j.reqDegree) f.map.reqDegree.set(j.reqDegree);
    if (j.reqYears) f.map.reqYears.set(j.reqYears);
    if (j.url) f.map.url.set(j.url);
    if (j.tags && j.tags.length) f.map.tags.set(j.tags.join(', '));
    if (j.reqSkills && j.reqSkills.length) f.map.reqSkills.set(j.reqSkills.join(', '));
    if (j.benefits && j.benefits.length) f.map.benefits.set(j.benefits.join(', '));

    f.map.title.node.style.gridColumn = 'span 1';
    f.map.url.node.style.gridColumn = 'span 2';

    var kv = el('div', {}, [
      f.node,
      el('div', { class: 'fld mt12' }, [
        el('label', { class: 'lb', text: '岗位职责（每行一条）' }),
        (function () {
          var ta = el('textarea', { rows: 4, placeholder: '负责抖音账号内容策划与运营\n独立完成选题、脚本与剪辑' });
          ta.value = (j.duties || []).join('\n');
          f.map.__duties = { get: function () { return ta.value; } };
          return ta;
        })(),
      ]),
      el('div', { class: 'fld mt12' }, [
        el('label', { class: 'lb', text: '原始 JD 文本（选填，AI 分析会用）' }),
        (function () {
          var ta = el('textarea', { rows: 6, placeholder: '把 BOSS 上的完整 JD 粘在这里，之后可以让 AI 分析风险点' });
          ta.value = j.rawJD || '';
          f.map.__raw = { get: function () { return ta.value; } };
          return ta;
        })(),
      ]),
    ]);

    return {
      node: kv,
      values: function () {
        var v = f.values();
        v.duties = f.map.__duties.get();
        v.rawJD = f.map.__raw.get();
        delete v.__duties; delete v.__raw;
        return v;
      },
    };
  }

  /** 编辑岗位（弹窗） */
  function openJobForm(id, after) {
    var j = id ? Store.job(id) : null;
    var f = manualForm(j || {});
    // 字段挺多，敲一半点 ✕ 就全没了，关窗前拦一次
    var guard = U.dirtyGuard(function () { return f.values(); });
    U.openModal({
      title: id ? '编辑岗位字段' : '手动新增岗位',
      size: 'wide',
      beforeClose: guard.check,
      body: f.node,
      footer: [
        { text: id ? '保存修改' : '新增岗位', cls: 'pri', onClick: function (c) {
          var v = f.values();
          if (!v.title) { U.toast('岗位名称必填', 'warn'); return; }
          var patch = Object.assign({}, v, {
            salaryMin: U.asNum(v.salaryMin), salaryMax: U.asNum(v.salaryMax),
            salaryMonths: U.asNum(v.salaryMonths),
            benefits: U.asArray(v.benefits, true), reqSkills: U.asArray(v.reqSkills, true),
            tags: U.asArray(v.tags, true), duties: U.asArray(v.duties),
          });
          if (id) { Store.updateJob(id, patch); U.toast('已保存 ✅', 'ok'); }
          else { Store.addJob(Object.assign({ source: 'manual' }, patch)); U.toast('已新增 ✅', 'ok'); }
          App.updateNavCounts();
          c();
          if (after) after(); else App.refresh();
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
    guard.mark();     // 基线在弹窗建好之后取，详见 U.dirtyGuard 注释
  }

  /* ---------------- 改状态对话框 ---------------- */
  function changeStatusDialog(appId, after) {
    var a = Store.application(appId); if (!a) return;
    var body = el('div', { class: 'stack', style: 'gap:7px' });
    var picked = a.status;
    var btns = [];
    Store.STATUSES.forEach(function (s) {
      var b = el('div', {
        class: 'box pointer', style: 'cursor:pointer;' + (s.id === a.status ? 'border-color:var(--brand);background:var(--brand-soft)' : ''),
        onclick: function () {
          picked = s.id;
          btns.forEach(function (x) { x.style.borderColor = ''; x.style.background = ''; });
          b.style.borderColor = 'var(--brand)'; b.style.background = 'var(--brand-soft)';
        },
      }, [Comp.statusPill(s.id)]);
      btns.push(b);
      body.appendChild(b);
    });
    var noteInp = el('input', { type: 'text', placeholder: '备注（选填，会记进时间线）' });
    U.openModal({
      title: '切换投递状态',
      body: el('div', {}, [el('div', { class: 'grid g2', style: 'gap:7px' }, btns), el('div', { class: 'fld mt12' }, [noteInp])]),
      footer: [
        { text: '确定', cls: 'pri', onClick: function (c) {
          Store.updateApplication(appId, { status: picked, statusNote: noteInp.value.trim() || undefined });
          U.toast('状态已更新为「' + Store.statusName(picked) + '」', 'ok');
          c(); App.updateNavCounts(); if (after) after(); else App.refresh();
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  /* ---------------- 从 boss-crawler 导入 ---------------- */
  function doImportCrawler() {
    U.openModal({
      title: '从 boss-crawler 爬取结果导入',
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'note info' }, [
          el('span', { class: 'ico', text: 'ℹ️' }),
          el('div', { html:
            '如果你之前跑过本地技能 <code class="mono">boss-crawler</code>，它的产物在：<br>' +
            '<code class="mono fs12">~/.workbuddy/skills/boss-crawler/assets/&lt;时间戳&gt;/</code><br><br>' +
            '选其中的 <b>qualified_jobs.json</b>、<b>scored_jobs.json</b> 或 <b>postdata/*.csv</b>（可多选）。' }),
        ]),
        el('div', { class: 'hint', text: '导入后会按「链接 / 公司+岗位」自动去重，重复的只补空字段，不会覆盖你改过的内容。' }),
      ]),
      footer: [
        { text: '选择文件导入', cls: 'pri', onClick: function (c) {
          c();
          Exporter.importBossCrawler().then(function (r) {
            if (!r) return;
            U.toast('导入完成：新增 ' + r.added + ' 个，合并 ' + r.dup + ' 个（共读到 ' + r.total + ' 条）', 'ok', 6000);
            App.updateNavCounts(); App.refresh();
          }).catch(function (e) { U.toast('导入失败：' + e.message, 'bad', 7000); });
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  /* ==================== 对外 ==================== */
  global.Views.jobs = {
    title: '岗位库',
    render: render,
    importDialog: openImport,
    detail: openDetail,
    deleteWithUndo: deleteJobWithUndo,
    aiParse: aiParseJob,
    aiMatch: aiMatchJob,
    aiGreeting: aiGreeting,
    jobForm: openJobForm,
    changeStatus: changeStatusDialog,
    tagManager: openTagManager,
    jobToText: jobToText,
    followScore: followScore,
    batchScore: openBatchScore,
    // 批量评分跑完后由 JobMatch 回调进来：连筛选栏一起重建，
    // 让「排序」下拉也跟着跳到"匹配分由高到低"，而不是只换了列表
    refresh: function () { if (_pageRebuild) _pageRebuild(); },
    filters: F,
    selection: SEL,
    // 求职偏好面板（原来在设置页，已搬到这里）
    openPrefs: openPrefs,
    prefsPanel: prefsPanel,
    // 一键清空岗位库（测试直接调真函数，别自己复刻）
    clearAllJobs: clearAllJobs,
    // S1-B · 冲突待处理面板（测试直接调真函数，别自己复刻）
    openConflicts: function () {
      if (!global.Views.conflicts) return null;
      return global.Views.conflicts.open(function () { if (_pageRebuild) _pageRebuild(); });
    },
    conflictChip: conflictEntry,
    // 本地「合适度」的测试钩子（测试直接调真函数，别自己复刻一遍）
    fitOf: fitOf, fitBatch: fitBatch, fitSummary: fitSummary, fitLevels: FIT_LEVELS,
    // 触达 BOSS 的卡片操作条（测试直接渲染真节点查结构，别自己复刻）
    _bossActBar: bossActBar,
    _openGreetDialog: openGreetDialog,
    _jobCard: jobCard,
    // AI 解析结果 → 岗位字段补丁（测试要验「没返回的字段不能被写进补丁」）
    _fromParsed: fromParsed,
  };
})(window);
