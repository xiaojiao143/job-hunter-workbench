/* ==========================================================================
   collect-prefs.js · 采集条件 ⇄ 求职偏好 的「唯一换算表」

   为什么单独一个文件：
     采集页（S.form）与岗位库偏好（DB.settings.prefs）本来就是**两套数据**，
     而且**不该合成一份** —— 采集页回答「这一次怎么搜」，偏好回答「我长期要什么」。
     合成一份的后果是：临时换个城市搜一下，长期偏好被污染了。

     但两边有 6 个概念是重叠的（城市 / 期望岗位 / 薪资 / 福利 / 区 / 商圈）。
     这 6 项的换算规则必须**只有一份** —— 否则两边一定飘。尤其薪资：
     采集页是 BOSS 的 6 个档位，偏好写的是数字 K，换算错了会**静默**采回一批
     根本不匹配的岗位（BOSS 在服务端就把对的筛掉了，你还以为按条件采的）。

   ⛔ 这个文件只做**纯计算**：不读 localStorage、不写任何数据、不碰 DOM。
     落盘一律由调用方决定，而且必须**用户点了确认**才写 —— 自动双向同步是被
     明确否掉的（见上面「不该合成一份」）。

   ⛔ 两个方向的语义都是「**只搬源里非空的项**」：
     源里空 = 「这一项我没设」，不等于「我要把对面清空」。
     否则点一次「从偏好带入」会把采集页辛苦填的城市 / 岗位全清光。
   ========================================================================== */
(function (global) {
  'use strict';

  /** 去空串 + 去重，保持出现顺序。 */
  function uniq(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (x) {
      var v = String(x == null ? '' : x).trim();
      if (!v || seen[v]) return;
      seen[v] = 1;
      out.push(v);
    });
    return out;
  }

  /* ---- 城市：采集页存「逗号分隔字符串」，偏好存数组。
     这一对换算是「两边值对不上」最常见的来源，所以只此一份。 ---- */
  function splitCity(s) {
    return uniq(String(s == null ? '' : s).split(/[,，、\/\s]+/));
  }
  function joinCity(arr) { return uniq(arr).join(', '); }

  /* ---- 重叠概念清单 ----
     kind: 'city' 采集页是字符串 / 偏好是数组
           'salary' 采集页是档位名 / 偏好是数字 K
           'list' 两边都是数组
     两个方向都从这份清单取，避免「加了字段只加一边」。 */
  var CONCEPTS = [
    { key: 'city', kind: 'city', formField: 'city', prefField: 'cities',
      label: '城市', hint: '会传给 BOSS 当搜索条件' },
    { key: 'expectJobs', kind: 'list', formField: 'expectJobs', prefField: 'expectJobs',
      label: '期望岗位', hint: '采集时当搜索词；偏好里是「只留这些岗位」的硬过滤' },
    { key: 'salary', kind: 'salary', formField: 'salary', prefField: 'salaryMin',
      label: '薪资',
      hint: '档位只是 BOSS 的搜索条件（只有 6 档）；自定义区间落在本地精筛' },
    { key: 'welfare', kind: 'list', formField: 'welfare', prefField: 'welfare',
      label: '福利', hint: '两边共用同一份选项（job-match.js 的 WELFARE_OPTIONS）' },
    { key: 'district', kind: 'list', formField: 'district', prefField: 'districts',
      label: '区', hint: '只在采集结果里本地筛' },
    { key: 'bizArea', kind: 'list', formField: 'bizArea', prefField: 'bizAreas',
      label: '商圈', hint: '只在采集结果里本地筛' },
  ];
  function conceptOf(key) {
    return CONCEPTS.filter(function (c) { return c.key === key; })[0];
  }

  /** 采集页侧 → 归一值。opt.bandCovering 由 view-collect.js 注入（SALARY_BAND 的主人在那）。 */
  function canonForm(form, opt) {
    form = form || {}; opt = opt || {};
    var out = {};
    CONCEPTS.forEach(function (c) {
      var v = form[c.formField];
      if (c.kind === 'city') out[c.key] = splitCity(v);
      else if (c.kind === 'salary') out[c.key] = String(v == null ? '' : v).trim();
      else out[c.key] = uniq(v);
    });
    return out;
  }

  /** 偏好侧 → 归一值。薪资统一折成「档位名」，这样两个方向能互相比较。 */
  function canonPrefs(prefs, opt) {
    prefs = prefs || {}; opt = opt || {};
    var out = {};
    CONCEPTS.forEach(function (c) {
      var v = prefs[c.prefField];
      if (c.kind === 'city') out[c.key] = uniq(v);
      else if (c.kind === 'salary') {
        var min = (typeof v === 'number' && v > 0) ? v : null;
        out[c.key] = (min !== null && opt.bandCovering) ? (opt.bandCovering(min) || '') : '';
      } else out[c.key] = uniq(v);
    });
    return out;
  }

  function sameVal(a, b) {
    if (Array.isArray(a) || Array.isArray(b)) {
      var x = uniq(a).slice().sort(), y = uniq(b).slice().sort();
      return x.join('\u0001') === y.join('\u0001');
    }
    return String(a || '') === String(b || '');
  }
  /** 源里这一项「有没有设」—— 决定要不要搬它。 */
  function nonEmpty(v) { return Array.isArray(v) ? v.length > 0 : !!v; }

  /** 列表值 → 人话（清单里显示用）。 */
  function showList(v) {
    var a = uniq(v);
    if (!a.length) return '（没填）';
    /* ⚠️ 原来是 a.join(' / ') + (a.length > 4 ? ' …' : '') —— 超过 4 项时
       **列全了却又补一个省略号**，读起来像「还有更多没列」，与事实相反。
       先 slice 再补「等 N 项」才是它本来想表达的。 */
    return a.slice(0, 4).join(' / ') + (a.length > 4 ? ' … 等 ' + a.length + ' 项' : '');
  }
  function showBand(band) { return String(band || '').trim() || '不限'; }
  function showMin(min) { return (typeof min === 'number' && min > 0) ? (min + 'K') : '（没填）'; }

  /* ---- 自定义薪资区间（单位 K）----
     ⛔ 它**只作用于本地精筛**。BOSS 服务端的薪资筛选只有 6 个固定档位码
        （boss-crawler/scripts/boss_crawler/config.py 的 FILTER_LABELS['salary'] = 402~407），
        而 utils.resolve_filter_values() 遇到认不出的值**只打一行警告就跳过** ——
        也就是说「15-25K」这种自定义值传下去等于**不带薪资条件**地采，
        用户会以为筛过了。所以档位仍然是唯一的搜索条件，自定义区间只在采回来后生效。
     这里只做**纯计算**（读值 / 比大小 / 出人话），落盘与判定都在调用方。 */

  /** 取出区间：返回 [下限, 上限]，没设的那头是 null。空串 / 0 / 负数 / 非数字一律算"没设"。 */
  function rangeOf(o) {
    function k(v) {
      // ⚠️ 同一口径，权威是 view-collect.js 的 parseK()（有 _parseK 测试锚点）
      if (v === null || v === undefined || String(v).trim() === '') return null;
      var n = Number(v);
      return (isFinite(n) && n > 0) ? n : null;
    }
    o = o || {};
    return [k(o.salaryMin), k(o.salaryMax)];
  }
  function rangeSame(a, b) {
    a = a || [null, null]; b = b || [null, null];
    return a[0] === b[0] && a[1] === b[1];
  }
  function showRange(r) {
    r = r || [null, null];
    if (r[0] === null && r[1] === null) return '（没设）';
    return (r[0] === null ? '不限' : r[0] + 'K') + ' ~ ' + (r[1] === null ? '不限' : r[1] + 'K');
  }

  /**
   * 偏好 → 采集页。返回 { steps, patch }：
   *   steps  差异清单 [{key,label,hint,from,to}]，给用户看「会改哪几项」
   *   patch  要写进 S.form 的字段（用 applyFormPatch 落）
   * opt: { bandCovering(fn), salaryBand(obj) }
   */
  function planFromPrefs(form, prefs, opt) {
    opt = opt || {};
    var src = canonPrefs(prefs, opt);
    var dst = canonForm(form, opt);
    var steps = [], patch = {};

    CONCEPTS.forEach(function (c) {
      var to = src[c.key];
      if (!nonEmpty(to)) return;                 // 偏好里没设这项 → 不动采集页
      /* 薪资要**连自定义区间一起比**：档位一样但区间不一样时也得进清单。
         否则「偏好写了 15~25K、采集页档位恰好已经是 20-50K」会被判成"没差异"，
         区间永远同步不过去（用户看到的就是"带入没生效"）。 */
      var sameBand = sameVal(dst[c.key], to);
      if (c.kind === 'salary') {
        if (sameBand && rangeSame(rangeOf(form), rangeOf(prefs))) return;
      } else if (sameBand) return;

      var fromTxt, toTxt;
      if (c.kind === 'salary') {
        var pR = rangeOf(prefs);
        fromTxt = showBand(dst[c.key]) + ' ｜ 自定义 ' + showRange(rangeOf(form));
        toTxt = showBand(to) + ' ｜ 自定义 ' + showRange(pR) +
          '（你的期望 ' + showMin(prefs.salaryMin) + '）';
        patch[c.formField] = to;                 // 档位名 = 透传 BOSS 的搜索条件
        /* 自定义区间只影响本地精筛。偏好里设过的两头都搬；没设的那头不动。 */
        if (pR[0] !== null) patch.salaryMin = pR[0];
        if (pR[1] !== null) patch.salaryMax = pR[1];
      } else if (c.kind === 'city') {
        fromTxt = dst[c.key].length ? showList(dst[c.key]) : '（没填）';
        toTxt = showList(to);
        patch[c.formField] = joinCity(to);       // 采集页城市是字符串
      } else {
        fromTxt = showList(dst[c.key]);
        toTxt = showList(to);
        patch[c.formField] = to.slice();
      }
      steps.push({ key: c.key, label: c.label, hint: c.hint, from: fromTxt, to: toTxt });
    });

    return { steps: steps, patch: patch };
  }

  /**
   * 采集页 → 偏好。返回同样结构（patch 的键是 prefs 的字段名）。
   * 薪资只写 salaryMin（档位下限）—— **不写 salaryMax**：
   * 采集档位的上限是「BOSS 这一档搜到哪」，不等于「我能接受的最高薪资」，
   * 顺手写进去会悄悄改变合适度打分的口径。
   */
  function planToPrefs(form, prefs, opt) {
    opt = opt || {};
    var src = canonForm(form, opt);
    var dst = canonPrefs(prefs, opt);
    var steps = [], patch = {};

    CONCEPTS.forEach(function (c) {
      var to = src[c.key];
      if (!nonEmpty(to)) return;                 // 采集页没填这项 → 不动偏好
      if (sameVal(dst[c.key], to)) return;

      var fromTxt, toTxt;
      if (c.kind === 'salary') {
        var band = (opt.salaryBand || {})[to];
        var fR = rangeOf(form);
        /* ⛔ 自定义下限优先于档位折算：区间是用户手填的，档位只是 BOSS 的一个搜索桶。
           档位下限只在**没填自定义下限**时才拿来顶（保持老行为，老断言也依赖它）。 */
        var min = (fR[0] !== null) ? fR[0] : (band ? band[0] : null);
        fromTxt = showMin(prefs.salaryMin) + ' ｜ 自定义 ' + showRange(rangeOf(prefs));
        toTxt = min === null ? (to + '（换算不出来，跳过）')
          : (min + 'K' + (min <= 0 ? '（等于不筛）' : '') + ' ← ' +
             (fR[0] !== null ? '采集页的自定义下限' : '档位「' + to + '」的下限'));
        if (min === null) return;
        patch[c.prefField] = min;
        /* ⛔ **只有用户真在采集页填了上限**才写 salaryMax。
           档位的上限（「20-50K」的 50K）绝不能当成"我能接受的最高薪资"写进去 ——
           那只是 BOSS 这个搜索桶到哪儿；顺手写会悄悄改掉合适度打分的口径。 */
        if (fR[1] !== null) patch.salaryMax = fR[1];
      } else if (c.kind === 'city') {
        fromTxt = dst[c.key].length ? showList(dst[c.key]) : '（没填）';
        toTxt = showList(to);
        patch[c.prefField] = to.slice();
      } else {
        fromTxt = showList(dst[c.key]);
        toTxt = showList(to);
        patch[c.prefField] = to.slice();
      }
      steps.push({ key: c.key, label: c.label, hint: c.hint, from: fromTxt, to: toTxt });
    });

    return { steps: steps, patch: patch };
  }

  /** 把 patch 落进采集页表单对象（数组深拷贝，不共享引用）。 */
  function applyFormPatch(form, patch) {
    if (!form || !patch) return form;
    Object.keys(patch).forEach(function (k) {
      var v = patch[k];
      form[k] = Array.isArray(v) ? v.slice() : v;
    });
    return form;
  }

  global.CollectPrefs = {
    CONCEPTS: CONCEPTS,
    conceptOf: conceptOf,
    splitCity: splitCity,
    joinCity: joinCity,
    uniq: uniq,
    rangeOf: rangeOf,
    rangeSame: rangeSame,
    showRange: showRange,
    canonForm: canonForm,
    canonPrefs: canonPrefs,
    planFromPrefs: planFromPrefs,
    planToPrefs: planToPrefs,
    applyFormPatch: applyFormPatch,
  };
})(window);
