/* js/job-picker.js
 * 岗位选择器 —— 从 js/job-taxonomy.js 的两份数据里挑岗位：
 *   ① JOB_TAXONOMY 官方分类树（28 大类 / 161 子类组 / 1098 岗位）—— 标准叫法
 *   ② JOB_MARKET   真实在招岗位（杭州 · 运营方向 300 条采集样本 / 176 个岗位名）
 *      —— 招聘方实际写出来的标题，含「抖音短视频运营」这类官方树里没有的写法
 * 采集页「岗位期望」、设置页「期望岗位」共用同一份数据与交互。
 * 搜索会同时命中两份数据，真实在招的会打「真实在招」标签。
 * 依赖：U（utils.js）、JOB_TAXONOMY / JOB_MARKET（job-taxonomy.js）。
 */
(function (global) {
  'use strict';

  var U = global.U;
  var el = U.el;   // 文件内统一用这个别名

  function taxonomy() { return global.JOB_TAXONOMY || []; }
  function market() { return global.JOB_MARKET || null; }

  /* ---------- 真实在招岗位索引（懒建） ---------- */
  var _mflat = null;
  function marketFlat() {
    if (_mflat) return _mflat;
    var mk = market(), out = [];
    if (mk && mk.groups) {
      mk.groups.forEach(function (g) {
        (g.jobs || []).forEach(function (j) {
          out.push({ name: j.name, category: g.name, count: j.count || 0, kind: 'market' });
        });
      });
    }
    _mflat = out;
    return _mflat;
  }

  /** 真实在招数据的元信息（城市 / 样本量 / 采集时间） */
  function marketStats() {
    var mk = market(), m = (mk && mk.meta) || {};
    return {
      titles: m.titles || marketFlat().length,
      sample: m.sample || 0,
      groups: (mk && mk.groups) ? mk.groups.length : 0,
      city: m.city || '', date: m.date || '', scope: m.scope || '', source: m.source || '',
    };
  }

  /* ---------- 扁平索引（懒建，搜索用） ---------- */
  var _flat = null;
  function flat() {
    if (_flat) return _flat;
    var out = [];
    taxonomy().forEach(function (ind) {
      (ind.subs || []).forEach(function (sec) {
        // 职能本身也是一个可选项（有些职能没有下级岗位）
        out.push({ name: sec.name, industry: ind.name, section: sec.name, kind: 'sec' });
        (sec.jobs || []).forEach(function (jn) {
          out.push({ name: jn, industry: ind.name, section: sec.name, kind: 'job' });
        });
      });
    });
    _flat = out;
    return _flat;
  }

  /** 数据规模：{ industries, sections, jobs, marketTitles, marketSample, marketCity } */
  function stats() {
    var t = taxonomy(), sec = 0, job = 0;
    t.forEach(function (ind) {
      (ind.subs || []).forEach(function (s) {
        sec++;
        job += (s.jobs || []).length;
      });
    });
    var ms = marketStats();
    return {
      industries: t.length, sections: sec, jobs: job,
      marketTitles: ms.titles, marketSample: ms.sample, marketCity: ms.city,
    };
  }

  /** 关键词搜索（同名只留一条：官方树优先，官方树没有的真实在招岗位补在后面） */
  function search(kw, limit) {
    var k = String(kw == null ? '' : kw).trim().toLowerCase();
    if (!k) return [];
    var res = [], seen = {};
    var all = flat();
    for (var i = 0; i < all.length; i++) {
      var x = all[i];
      if (String(x.name).toLowerCase().indexOf(k) < 0) continue;
      if (seen[x.name]) continue;
      seen[x.name] = 1;
      res.push(x);
    }
    var mall = marketFlat();
    for (var j = 0; j < mall.length; j++) {
      var y = mall[j];
      if (String(y.name).toLowerCase().indexOf(k) < 0) continue;
      if (seen[y.name]) continue;
      seen[y.name] = 1;
      res.push(y);
    }
    return limit > 0 ? res.slice(0, limit) : res;
  }

  /** 这个名字在不在岗位数据里（官方树或真实在招） */
  function isKnown(name) {
    var k = String(name == null ? '' : name).trim();
    if (!k) return false;
    var all = flat();
    for (var i = 0; i < all.length; i++) if (all[i].name === k) return true;
    var mall = marketFlat();
    for (var j = 0; j < mall.length; j++) if (mall[j].name === k) return true;
    return false;
  }

  /** 取路径文案（官方树 → 大类 / 子类组；真实在招 → 「真实在招 · 分类」） */
  function pathOf(name) {
    var all = flat();
    for (var i = 0; i < all.length; i++) {
      if (all[i].name !== name) continue;
      return all[i].kind === 'sec' ? (all[i].industry + ' · 职能') : (all[i].industry + ' / ' + all[i].section);
    }
    var mall = marketFlat();
    for (var j = 0; j < mall.length; j++) {
      if (mall[j].name === name) return '真实在招 · ' + mall[j].category;
    }
    return '';
  }

  /**
   * 这个名字归属哪一边 —— 'taxonomy' | 'market' | ''（都没有）。
   * 官方树里已有的名字一律算 taxonomy（哪怕真实在招里也出现过）。
   */
  function sourceOf(name) {
    var all = flat();
    for (var i = 0; i < all.length; i++) if (all[i].name === name) return 'taxonomy';
    var mall = marketFlat();
    for (var j = 0; j < mall.length; j++) if (mall[j].name === name) return 'market';
    return '';
  }

  /** 安全切 class（不依赖 classList，DOM 桩也能跑） */
  function setOn(node, on) {
    var cls = ' ' + String(node.className || '') + ' ';
    var has = cls.indexOf(' on ') >= 0;
    if (on && !has) { node.className = (String(node.className || '') + ' on').replace(/\s+/g, ' ').trim(); }
    else if (!on && has) { node.className = cls.replace(' on ', ' ').replace(/\s+/g, ' ').trim(); }
  }

  /* ---------- 弹窗式选择器 ---------- */
  /**
   * open({ title, note, selected: [], multiple: true, placeholder, onConfirm(list), onCancel() })
   *
   * `note` 会显示在弹窗顶部 —— 用来讲清「点确定之后这份选择**写进哪一份数据**」。
   * ⛔ 采集页的「本次要搜的岗位」和岗位库的「长期期望岗位」共用这一个选择器，
   *    以前两边标题几乎一样、都叫「选择岗位」，用户点进去分不清在改哪一份。
   */
  function open(opt) {
    opt = opt || {};
    var multiple = opt.multiple !== false;
    var picked = (opt.selected || []).slice();
    var q = '';
    var done = false;

    var searchInp = el('input', {
      class: 'inp jp-inp', type: 'text', value: '',
      placeholder: opt.placeholder || '搜索岗位名：运营 / 产品经理 / Java …',
    });
    var pickedBox = el('div', { class: 'chips jp-picked' });
    var listBox = el('div', { class: 'jp-list' });
    var footStat = el('span', { class: 'fs11 muted jp-stat' });

    var listChips = [];   // 列表里已渲染的 chip 引用，用于局部刷新选中态

    var head = [];
    if (opt.note) {
      head.push(el('div', { class: 'note info jp-note' }, [
        el('span', { class: 'ico', text: '📝' }),
        el('div', { html: opt.note }),
      ]));
    }
    var wrap = el('div', { class: 'jp-wrap' }, head.concat([
      el('div', { class: 'jp-search' }, [searchInp]),
      el('div', { class: 'jp-picked-row' }, [
        el('span', { class: 'fs11 muted jp-picked-lb', text: '已选' }),
        pickedBox,
      ]),
      listBox,
    ]));

    function isPicked(n) { return picked.indexOf(n) >= 0; }

    function toggle(n) {
      var i = picked.indexOf(n);
      if (i >= 0) picked.splice(i, 1);
      else {
        if (!multiple) picked.length = 0;
        picked.push(n);
      }
      paintPicked();
      syncList();
      updateStat();
    }

    /** 直接把搜索框里的词当自定义岗位加进来（树里没有的也能用） */
    function addCustom(raw) {
      var n = String(raw || '').trim();
      if (!n) return;
      if (!isPicked(n)) {
        if (!multiple) picked.length = 0;
        picked.push(n);
      }
      paintPicked();
      updateStat();
    }

    function paintPicked() {
      pickedBox.innerHTML = '';
      if (!picked.length) {
        pickedBox.appendChild(el('span', { class: 'fs11 muted jp-none', text: '（还没选，点下面的岗位加入）' }));
        return;
      }
      picked.forEach(function (n) {
        pickedBox.appendChild(el('span', {
          class: 'chip on jp-cpick', text: n + ' ✕', title: '点击移除「' + n + '」',
          onclick: function () { toggle(n); },
        }));
      });
      if (picked.length > 1) {
        pickedBox.appendChild(el('span', {
          class: 'chip jp-clear', text: '清空',
          onclick: function () { picked.length = 0; paintPicked(); syncList(); updateStat(); },
        }));
      }
    }

    function updateStat() {
      var s = stats();
      var txt = '共 ' + s.jobs + ' 个岗位 · ' + s.industries + ' 个大类';
      if (s.marketTitles) {
        txt += ' · 另有 ' + s.marketTitles + ' 个真实在招岗位名（' +
          (s.marketCity ? s.marketCity + ' · ' : '') + s.marketSample + ' 条采集样本）';
      }
      footStat.textContent = txt + '　已选 ' + picked.length + ' 个';
    }

    /** 只改列表里 chip 的选中态（不重画 —— 重画会把展开的折叠树收回去） */
    function syncList() {
      for (var i = 0; i < listChips.length; i++) setOn(listChips[i].node, isPicked(listChips[i].name));
    }

    function paintList() {
      listBox.innerHTML = '';
      listChips = [];
      if (q) { paintSearch(); return; }

      var t = taxonomy();
      if (!t.length) {
        listBox.appendChild(el('div', { class: 'jp-empty fs12 muted', text: '岗位数据没加载（js/job-taxonomy.js 缺失）' }));
        return;
      }

      var bar = el('div', { class: 'jp-tools' }, [
        el('button', {
          class: 'btn xs ghost', text: '展开全部行业',
          onclick: function () {
            var ds = listBox.getElementsByTagName('details');
            for (var i = 0; i < ds.length; i++) ds[i].open = true;
          },
        }),
        el('button', {
          class: 'btn xs ghost', text: '收起全部',
          onclick: function () {
            var ds = listBox.getElementsByTagName('details');
            for (var i = 0; i < ds.length; i++) ds[i].open = false;
          },
        }),
      ]);
      listBox.appendChild(bar);

      var mkt = paintMarketBlock();
      if (mkt) listBox.appendChild(mkt);

      t.forEach(function (ind) {
        var body = el('div', { class: 'jp-ind-body' });
        var painted = false;
        var d = el('details', { class: 'jp-ind' }, [
          el('summary', { class: 'jp-sum' }, [
            el('span', { class: 'jp-ind-name', text: ind.name }),
            el('span', { class: 'fs11 muted', text: (ind.subs || []).length + ' 个职能' }),
          ]),
          body,
        ]);
        // 折叠时才渲染内容：1098 个岗位全量铺开太慢，也没有可读性
        d.addEventListener('toggle', function () {
          if (d.open && !painted) {
            painted = true;
            paintIndustry(body, ind);
          }
        });
        listBox.appendChild(d);
      });
    }

    /**
     * 「🔥 真实在招岗位」块 —— 摆在浏览列表最上面。
     * 这是招聘方实际写出来的岗位标题（来自采集样本统计），比官方标准名更接地气，
     * 也是最能直接拿去当搜索关键词的。整组可以一键全加 / 全去。
     */
    function paintMarketBlock() {
      var mk = market();
      if (!mk || !mk.groups || !mk.groups.length) return null;
      var ms = marketStats();

      var box = el('div', { class: 'jp-mkt' });
      box.appendChild(el('div', { class: 'jp-mkt-head' }, [
        el('span', { class: 'jp-mkt-t', text: '🔥 真实在招岗位' }),
        el('span', { class: 'jp-mkt-sub fs11 muted', title: ms.source || '',
          text: [ms.city, ms.date, ms.sample + ' 条采集样本', ms.titles + ' 个岗位名'].filter(Boolean).join(' · ') }),
      ]));

      mk.groups.forEach(function (g) {
        var body = el('div', { class: 'jp-ind-body' });
        var painted = false;
        var d = el('details', { class: 'jp-mkt-g' }, [
          el('summary', { class: 'jp-sum' }, [
            el('span', { class: 'jp-ind-name', text: g.name }),
            el('span', { class: 'fs11 muted', text: (g.jobs || []).length + ' 个岗位 · ' + g.total + ' 条' }),
          ]),
          body,
        ]);
        // 跟官方树一样：展开才渲染，避免一上来铺 176 个 chip
        d.addEventListener('toggle', function () {
          if (d.open && !painted) {
            painted = true;
            paintMarketGroup(body, g);
          }
        });
        box.appendChild(d);
      });
      return box;
    }

    function paintMarketGroup(body, g) {
      body.innerHTML = '';
      var jobs = g.jobs || [];
      var names = jobs.map(function (j) { return j.name; });

      function addAll() {
        names.forEach(function (n) {
          if (isPicked(n)) return;
          if (!multiple) picked.length = 0;
          picked.push(n);
        });
        paintPicked(); syncList(); updateStat();
      }
      function dropAll() {
        for (var i = picked.length - 1; i >= 0; i--) {
          if (names.indexOf(picked[i]) >= 0) picked.splice(i, 1);
        }
        paintPicked(); syncList(); updateStat();
      }

      body.appendChild(el('div', { class: 'row jp-mkt-ops' }, [
        el('button', { class: 'btn xs ghost', text: '＋ 本组全加（' + names.length + '）', onclick: addAll }),
        el('button', { class: 'btn xs ghost', text: '－ 本组全去', onclick: dropAll }),
      ]));

      var chipsBox = el('div', { class: 'chips jp-jobs jp-mkt-jobs' });
      jobs.forEach(function (j) {
        var c = el('span', {
          class: 'chip jp-jc jp-mkt-c', title: g.name + ' · 采集样本里出现 ' + j.count + ' 次',
          onclick: function () { toggle(j.name); },
        }, [
          el('span', { class: 'jp-mkt-n', text: j.name }),
          el('i', { class: 'jp-cnt', text: String(j.count) }),
        ]);
        setOn(c, isPicked(j.name));
        listChips.push({ name: j.name, node: c });
        chipsBox.appendChild(c);
      });
      body.appendChild(chipsBox);
    }

    function paintIndustry(body, ind) {
      body.innerHTML = '';
      (ind.subs || []).forEach(function (sec) {
        var jobsBox = el('div', { class: 'chips jp-jobs' });
        (sec.jobs || []).forEach(function (jn) {
          var c = el('span', {
            class: 'chip jp-jc', text: jn, title: ind.name + ' / ' + sec.name,
            onclick: function () { toggle(jn); },
          });
          setOn(c, isPicked(jn));
          listChips.push({ name: jn, node: c });
          jobsBox.appendChild(c);
        });
        body.appendChild(el('div', { class: 'jp-sec' }, [
          el('span', { class: 'jp-sec-name', text: sec.name }),
          jobsBox,
        ]));
      });
    }

    function paintSearch() {
      var res = search(q, 300);
      if (!res.length) {
        listBox.appendChild(el('div', { class: 'jp-empty' }, [
          el('div', { class: 'fs12 muted', text: '岗位库（官方分类 + 真实在招）里没有「' + q + '」' }),
          el('button', {
            class: 'btn xs mt8', text: '就用「' + q + '」作为岗位',
            onclick: function () { addCustom(q); q = ''; searchInp.value = ''; paintList(); },
          }),
        ]));
        return;
      }
      var mktHits = res.filter(function (x) { return x.kind === 'market'; });
      var box = el('div', { class: 'jp-hits' });
      res.forEach(function (x) {
        var isMkt = x.kind === 'market';
        var node = el('div', {
          class: 'jp-hit' + (isMkt ? ' jp-hit-mkt' : ''), title: '点击选中 / 取消',
          onclick: function () { toggle(x.name); },
        }, [
          el('span', { class: 'jp-hit-name', text: x.name }),
          isMkt ? el('span', { class: 'jp-badge', text: '真实在招' + (x.count ? ' ' + x.count + '次' : '') }) : null,
          el('span', { class: 'jp-hit-path fs11 muted', text: pathOf(x.name) }),
        ].filter(Boolean));
        setOn(node, isPicked(x.name));
        listChips.push({ name: x.name, node: node });
        box.appendChild(node);
      });
      listBox.appendChild(box);
      if (mktHits.length) {
        listBox.appendChild(el('div', { class: 'fs11 muted jp-hits-tip', text:
          '带「真实在招」的 ' + mktHits.length + ' 个来自 ' +
          (marketStats().city || '采集') + ' ' + marketStats().sample + ' 条采集样本的岗位标题，' +
          '可直接当搜索关键词用。' }));
      }
    }

    searchInp.addEventListener('input', function () {
      q = String(searchInp.value || '').trim();
      paintList();
    });

    paintPicked();
    paintList();
    updateStat();

    var m = U.openModal({
      title: opt.title || '选择岗位',
      size: opt.size || 'wide',
      body: wrap,
      footer: [],
      onClose: function () {
        // 关窗但没点确定 = 取消（保持铁律：回调先落值，这里只做取消通知）
        if (!done && opt.onCancel) setTimeout(function () { opt.onCancel(); }, 0);
      },
    });

    // openModal 不返回 footer 节点，从这张弹窗里自己取
    var foot = m.modal.querySelector('.mfoot');
    if (foot) {
      foot.innerHTML = '';
      foot.appendChild(footStat);
      foot.appendChild(el('button', {
        class: 'btn', text: '取消',
        onclick: function () { m.close(); },
      }));
      foot.appendChild(el('button', {
        class: 'btn pri', text: '确定',
        onclick: function () {
          if (done) return;
          done = true;                        // 先落值再关窗（弹窗铁律）
          var list = picked.slice();
          if (opt.onConfirm) opt.onConfirm(list);
          m.close();
        },
      }));
    }

    return { close: m.close, picked: function () { return picked.slice(); } };
  }

  global.JobPicker = {
    open: open,
    search: search,
    stats: stats,
    isKnown: isKnown,
    pathOf: pathOf,
    sourceOf: sourceOf,
    all: flat,
    taxonomy: taxonomy,
    market: market,
    marketFlat: marketFlat,
    marketStats: marketStats,
  };
})(window);
