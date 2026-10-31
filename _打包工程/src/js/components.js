/* ==========================================================================
   components.js · 共享 UI 组件
   最核心的是 Comp.aiPanel —— 所有 AI 功能的统一交互壳：
   流式打字机 → JSON 解析 → 结果面板 → 一键应用
   ========================================================================== */
(function (global) {
  'use strict';

  function el() { return U.el.apply(null, arguments); }

  /* ---------------- 空态 ---------------- */
  function empty(icon, title, desc, actionText, onAction) {
    var kids = [
      el('div', { class: 'big', text: icon || '📭' }),
      el('b', { text: title || '暂无数据' }),
    ];
    if (desc) kids.push(el('p', { html: desc }));
    if (actionText) kids.push(el('button', { class: 'btn pri', text: actionText, onclick: onAction }));
    return el('div', { class: 'empty' }, kids);
  }

  /* ---------------- 状态徽章 ---------------- */
  function statusPill(statusId, extra) {
    var s = Store.STATUS_MAP[statusId] || { name: statusId, color: '#8b95ad' };
    return el('span', {
      class: 'pill', style: 'color:' + s.color + ';border-color:' + s.color + '44;background:' + s.color + '14',
      html: '<span class="dt"></span>' + U.esc(s.name) + (extra ? ' · ' + U.esc(extra) : ''),
    });
  }

  function tagList(arr, cls) {
    if (!arr || !arr.length) return el('span', { class: 'muted fs12', text: '—' });
    return el('span', { class: 'chips' }, arr.map(function (t) {
      return el('span', { class: 'tag ' + (cls || ''), text: t });
    }));
  }

  /* ---------------- 合适度一行（徽标 + 五维分数 + 原因） ----------------
     岗位库卡片 / 紧凑列表 / 采集结果列表三处共用。
     ⚠️ 三处各写一份的话，必然有一处先过期 —— 而分数解释一旦自相矛盾，
        用户就再也不信这套分了。

     两条硬规则：
       ① **被硬性剔除的岗位不给分**，只写原因。「剔除」和「0 分」是两回事，
          给 0 分会让人以为「只是分低」，于是照样去投。
       ② **原因那行正反面都要写**（见 job-score.js 的 reasonOf）——
          只说好话的原因行会把 C 级包装成 A 级。 */
  /* ---------------- 多选 chips 行（城市 / 区 / 商圈 三级共用） ----------------
     偏好面板、采集参数卡、公司背调都要这个交互：候选里点一下选中、再点取消、
     还能手输加一个。三处各写一份必然飘 —— 而且 chips 的选中态、自绘时机
     这类细节最容易写歪，所以抽成一个。

     opt = {
       label, hint, options[], selected[], custom(占位文案), empty(空态文案),
       badge(生效层级徽章节点，见 lvlBadge —— 采集页与偏好面板都要标「这一项在哪生效」),
       selfPaint(默认 true；false = 由调用方重建整块，用于三级联动),
       onChange(sel)  — 每次选中态变化回调
     }
     返回一个 DOM 节点（含标题行 + chips + 可选手输框）。 */
  function chipsRow(o) {
    o = o || {};
    var box = el('div', { class: 'georow' });
    var sel = (o.selected || []).slice();
    var list = (o.options || []).slice();
    /* 已选但不在候选里的也要列出来 —— 否则用户看不到自己选过什么，
       会以为「选了但没生效」。手输的城市 / 区正是这种。 */
    sel.forEach(function (x) { if (list.indexOf(x) < 0) list.push(x); });

    var wrap = el('div', { class: 'chips geo-chips' });
    box.appendChild(el('div', { class: 'geo-head' }, [
      el('label', { class: 'lb geo-lb', text: o.label }),
      o.badge || null,
      o.hint ? el('span', { class: 'fs11 muted', text: o.hint }) : null,
    ].filter(Boolean)));
    box.appendChild(wrap);

    function paint() {
      wrap.innerHTML = '';
      if (!list.length) {
        wrap.appendChild(el('span', { class: 'fs11 muted', text: o.empty || '（暂时没有可选项）' }));
      }
      list.forEach(function (x) {
        var on = sel.indexOf(x) >= 0;
        wrap.appendChild(el('span', {
          class: 'chip geo-chip' + (on ? ' on' : ''),
          text: on ? x + ' ✕' : x,
          title: on ? '点击取消「' + x + '」' : '点击选中「' + x + '」',
          onclick: function () {
            var i = sel.indexOf(x);
            if (i >= 0) sel.splice(i, 1); else sel.push(x);
            if (o.selfPaint !== false) paint();
            if (o.onChange) o.onChange(sel.slice());
          },
        }));
      });
    }
    paint();

    if (o.custom) {
      var inp = el('input', { type: 'text', class: 'geo-add', placeholder: o.custom });
      inp.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;      // 回车才加，避免边打字边加出一堆烂选项
        e.preventDefault();
        var v = String(inp.value || '').trim();
        if (!v) return;
        inp.value = '';
        if (list.indexOf(v) < 0) list.push(v);
        if (sel.indexOf(v) < 0) sel.push(v);
        paint();
        if (o.onChange) o.onChange(sel.slice());
      });
      box.appendChild(inp);
    }
    return box;
  }

  function fitLine(ft, opt) {
    opt = opt || {};
    if (!ft) return el('span', { class: 'muted fs12', text: '合适度未算' });

    if (ft.gate && ft.gate.drop) {
      /* ⚠️ 剔除的岗位**不给分**，但原因照样写在同一个位置（.fitreason）——
         不然"每一条都标明原因"就漏掉了最该看的那几条。 */
      return el('div', { class: 'fitbox' }, [
        el('div', { class: 'fitline' }, [
          el('span', { class: 'fbadge bad', text: '剔除' }),
          el('span', { class: 'tag bad', text: '不值得投' }),
        ]),
        el('div', { class: 'fitreason fitreason-drop', html: '🚫 ' + U.esc(ft.gate.reason) }),
      ]);
    }

    var chips = [];
    if (!opt.compact && global.JobScorer) {
      global.JobScorer.parts(ft).forEach(function (p) {
        chips.push(el('span', {
          class: 'fpart' + (p.full ? ' full' : p.v === 0 ? ' zero' : ''),
          title: p.k + ' ' + p.v + ' / ' + p.max + ' 分',
          text: p.k + p.v,
        }));
      });
      if (ft.delta && ft.delta.value) {
        chips.push(el('span', {
          class: 'fpart ' + (ft.delta.value > 0 ? 'plus' : 'minus'),
          title: (ft.delta.value > 0 ? '加分' : '扣分') + '：' + (ft.delta.why || []).join(' · '),
          text: '加减' + (ft.delta.value > 0 ? '+' : '') + ft.delta.value,
        }));
      }
    }

    return el('div', { class: 'fitbox' }, [
      el('div', { class: 'fitline' }, [
        el('span', {
          class: 'fbadge ' + ft.level.cls,
          title: ft.level.label + '：' + ft.level.advice,
          text: ft.level.key + ' · ' + ft.total,
        }),
        chips.length ? el('span', { class: 'fitparts' }, chips) : null,
        ft.blind ? el('span', { class: 'tag',
          title: '这个岗位的 JD / 职责没采到，分数只看了标题和标签', text: 'JD 缺失' }) : null,
        /* opt.extra：调用方塞进来的徽章（目前是「避坑」）。
           走挂点而不是在 view 里 querySelector 再 append ——
           测试里的 DOM 桩不一定有完整 querySelector 链，挂点更稳。 */
        opt.extra || null,
      ].filter(Boolean)),
      el('div', { class: 'fitreason', text: ft.reason || '（没有可解释的信号）' }),
    ]);
  }

  /* ---------------- 表单构造 ---------------- */
  /**
   * field(spec) → 返回 {node, get(), set(v)}
   * spec: {key,label,type:'text|number|textarea|select|date',options,placeholder,rows,width,hint}
   */
  function field(spec) {
    var input;
    if (spec.type === 'textarea') {
      input = el('textarea', { rows: spec.rows || 4, placeholder: spec.placeholder || '', class: spec.mono ? 'mono' : '' });
    } else if (spec.type === 'select') {
      input = el('select');
      (spec.options || []).forEach(function (o) {
        var v = typeof o === 'object' ? o.value : o;
        var l = typeof o === 'object' ? o.label : o;
        input.appendChild(el('option', { value: v, text: l }));
      });
    } else {
      input = el('input', { type: spec.type || 'text', placeholder: spec.placeholder || '' });
    }
    if (spec.value !== undefined && spec.value !== null) input.value = spec.value;

    var label = el('label', { class: 'lb', html: U.esc(spec.label || '') + (spec.optional ? ' <span class="muted">(选填)</span>' : '') });
    var node = el('div', { class: 'fld', style: spec.width ? ('width:' + spec.width) : '' }, [label, input]);
    if (spec.hint) node.appendChild(el('div', { class: 'hint tiny mt4', html: spec.hint }));

    return {
      node: node, input: input, key: spec.key,
      get: function () { return input.value.trim ? input.value.trim() : input.value; },
      raw: function () { return input.value; },
      set: function (v) { input.value = v === null || v === undefined ? '' : v; },
    };
  }

  function fields(specs, cols) {
    var map = {};
    var grid = el('div', { class: 'grid', style: 'gap:12px;grid-template-columns:repeat(' + (cols || 2) + ',minmax(0,1fr))' });
    specs.forEach(function (s) {
      var f = field(s);
      if (s.key) map[s.key] = f;
      grid.appendChild(f.node);
    });
    return { node: grid, map: map, values: function () {
      var o = {};
      Object.keys(map).forEach(function (k) { o[k] = map[k].get(); });
      return o;
    } };
  }

  /* ---------------- AI 结果字段的中文标签 ----------------
     ⛔ 模型吐回来的是英文 JSON 键（score / verdict / matched …），
        defaultRender 直接拿它当小标题 -> 整个弹窗中英混排。
        这里集中做一层「英文键 -> 中文标题」映射；表里没有的键原样显示（至少不崩）。
        改提示词里新增了字段，记得同步往这里加一行，否则界面上又会冒英文。 */
  var AI_KEY_LABELS = {
    /* 简历-JD 匹配评估（match） */
    score: '综合评分', verdict: '一句话结论', category: '评估结论',
    matched: '匹配上的点', missing: '缺失的要求', suggestions: '简历修改建议',
    keywordsToAdd: '建议补充的关键词', greetingHint: '打招呼时该强调的',
    risks: '风险点',
    /* JD 解析（jobParse） */
    title: '岗位名称', company: '公司名称', industry: '所属行业',
    location: '工作地点', remote: '是否远程', salaryText: '原始薪资文本',
    salaryMin: '最低薪资(K)', salaryMax: '最高薪资(K)', salaryMonths: '年终奖月数',
    benefits: '福利待遇', duties: '岗位职责', reqDegree: '学历要求',
    reqYears: '经验要求', reqSkills: '平台技能标签', keywords: '检索关键词',
    pros: '岗位吸引力', cons: '需要注意的短板', tags: '建议标签',
    /* 面试准备（interviewPrep） */
    selfIntro: '自我介绍口语稿', questions: '高频面试题', askHr: '值得反问 HR 的问题',
    points: '必须讲到的加分点', avoid: '千万别说的内容',
    questionsToCompany: '要向公司确认清楚的问题',
    /* 模拟面试复盘（simReview） */
    highlights: '做得好的地方', problems: '最需要改的问题',
    perQuestion: '逐题点评', nextSteps: '接下来重点准备',
    /* 数组里「对象元素」的键（面试题 / 逐题点评） */
    q: '问题', why: '想考什么', a: '参考回答',
    comment: '点评', better: '更好的答法', tag: '评级',
  };

  /* 枚举值 -> 中文（键或值不在表里就原样返回，不硬塞） */
  var AI_VALUE_LABELS = {
    category: {
      qualified: '✅ 符合，建议投递',
      need_optimization: '⚠️ 优化简历后可投',
      cannot_apply: '⛔ 暂不建议投递',
    },
    remote: { 'true': '远程', 'false': '非远程' },
  };

  function aiKeyLabel(k) { return AI_KEY_LABELS[k] || k; }

  function aiValueLabel(k, v) {
    var map = AI_VALUE_LABELS[k];
    if (!map || v === null || v === undefined || typeof v === 'object') return v;
    var s = String(v);
    return Object.prototype.hasOwnProperty.call(map, s) ? map[s] : v;
  }

  /**
   * 把 AI 返回的 JSON 对象渲染成「中文小标题 + 值」的结果面板。
   *
   * ⛔ 弹窗（runAI）与 AI 助手页的气泡**共用这一个**。
   *    两处各写一套必然漂移；而模型给的是英文键（score / verdict / category …），
   *    漏掉一处界面就冒英文 —— 这正是「弹窗修好了、助手页还在冒英文」的成因。
   * 返回 null 表示「这个对象渲染不出东西」，调用方自己兜底。
   */
  function aiResultNode(data) {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
    var wrap = el('div', { class: 'stack', style: 'gap:9px' });
    Object.keys(data).forEach(function (k) {
      var v = data[k];
      if (v === null || v === undefined || v === '' || (Array.isArray(v) && !v.length)) return;
      var rowEl = el('div', { class: 'box plain' });
      rowEl.appendChild(el('div', { class: 'fs12 muted fw6 mb4', text: aiKeyLabel(k) }));
      if (Array.isArray(v)) {
        var ul = el('div', { class: 'stack', style: 'gap:5px' });
        v.forEach(function (item) {
          if (item && typeof item === 'object') {
            var sub = el('div', { class: 'box' });
            Object.keys(item).forEach(function (ik) {
              sub.appendChild(el('div', { class: 'fs12 mb4' }, [
                el('span', { class: 'muted', text: aiKeyLabel(ik) + '：' }),
                el('span', { text: String(item[ik] === null ? '—' : aiValueLabel(ik, item[ik])) }),
              ]));
            });
            ul.appendChild(sub);
          } else {
            ul.appendChild(el('div', { class: 'fs13 row', style: 'align-items:flex-start;gap:6px' }, [
              el('span', { class: 'brand-c', text: '•' }),
              el('span', { class: 'flex1 pre-wrap', text: String(item) }),
            ]));
          }
        });
        rowEl.appendChild(ul);
      } else if (typeof v === 'object') {
        rowEl.appendChild(el('pre', { class: 'mono fs12 pre-wrap', text: JSON.stringify(v, null, 2) }));
      } else {
        rowEl.appendChild(el('div', { class: 'fs13 pre-wrap', text: String(aiValueLabel(k, v)) }));
      }
      wrap.appendChild(rowEl);
    });
    return wrap.children.length ? wrap : null;
  }

  /* ---------------- AI 运行面板（核心） ---------------- */

  /**
   * runAI(opt)
   *   title        弹窗标题
   *   tpl          模板 key（ai.js TPL）
   *   input        模板输入对象
   *   promptPreview 是否允许用户临时改提示词（默认 false）
   *   onApply(data, rawText, close)   点「应用」时回调
   *   onApplied(data, rawText)   存完之后回调（**可选**，第 30 轮加）。
   *                                 用来把顶部保存条翻成「✅ 已保存」——
   *                                 不少 onApply 会自己关窗，toast 一闪就没了，
   *                                 界面上必须留下「已经存好了」的痕迹。
   *   applyLabel   应用按钮文案（顶部条与 footer 共用同一个）
   *   saveHint     存到哪里的人话，如 '这场面试' → 条上写「一键存进这场面试」
   *   renderResult(data, rawText) → Node   自定义结果展示（不传则智能默认）
   *   autoRun      是否打开即跑（默认 true）
   *   size         弹窗宽度
   *   extraFooter  额外的 footer 按钮
   *
   * ⚠️ 保存入口有**两个**（顶部固定条 + footer），但它们共用 `doApply` 和
   *    同一个状态机 `setSaveState`，不可能出现「上面说已保存、下面还能点」。
   */
  function runAI(opt) {
    opt = opt || {};
    var tplDef = AI.TPL[opt.tpl];
    var running = false;
    var ctrl = null;
    var rawText = '';
    var parsed = null;
    var settled = false;

    /* --- 界面 --- */
    var raw = el('div', { class: 'typer', style: 'display:none' });
    var statusLine = el('div', { class: 'row fs12 muted mb8' });
    var resultBox = el('div', { style: 'display:none' });
    var errBox = el('div', { style: 'display:none' });
    var spinner = el('span', { class: 'spin', style: 'display:none' });

    /* --- ⛔ 保存入口：结果区顶部的固定条（第 30 轮补）-------------------
       改之前的现状：唯一的保存入口是 **footer 里第 3 个同权重按钮**
       （`applyLabel`，备面材料就是「保存到这场面试」）。四个按钮
       `重新生成 / 复制输出 / 保存 / 关闭` 长得一模一样，保存既不显眼、也没有图标。

       更要命的是三条（都属于「生成了却没保存」的主要路径）：
         ① **视线不在那儿**。结果区往往好几屏（自我介绍 + N 道题 + 4 组清单），
            用户读完在底部随手点 ✕ close —— 保存键在最底部的 footer 里，
            极容易整段内容白生成。`.mfoot` 虽然因为 flex 布局一直可见，
            但它不在**用户正在读的内容**的视线起点上。
         ② **生成期间是灰的**，用户看到的是一条灰按钮，既不知道它是保存键、
            也不知道要等多久（模型调用经常 20s+）。
         ③ **保存后没有任何痕迹**。再次打开生成器，按钮还是「保存到这场面试」，
            看不出「这场已经有材料了，再点会覆盖」。

       做法：在结果区**顶部**加一条 `position:sticky` 的保存条 —— 视线起点，
       滚动时始终在；三态：`生成中 → 可保存 → 已保存`。
       ⛔ **保存逻辑与数据结构一个字没改**：仍然走 `opt.onApply`，
          这里只多了个可选的 `opt.onApplied` 钩子用来把状态翻成「已保存」。 */
    var barIco = el('span', { class: 'ai-savebar-ico', text: '💾', 'aria-hidden': 'true' });
    var barText = el('span', { class: 'ai-savebar-txt', text: '' });
    var barBtn = el('button', { class: 'btn pri ai-savebar-btn', text: '', type: 'button', disabled: true });
    var saveBar = el('div', { class: 'ai-savebar', style: 'display:none' }, [
      barIco, barText, el('span', { class: 'sp' }), barBtn,
    ]);

    /* ⛔⛔ `display:contents` 不是随手加的 —— **sticky 的包含块**问题。
       `.mbody` 是弹窗里唯一的滚动容器（overflow-y:auto）。sticky 会相对
       scrollport 定位，但同时被**自己的包含块**（最近的块容器祖先）夹住。
       以前这里有个普通 `<div>` 包着全部结果 ⇒ **bar 的包含块是那个 div**，
       而那个 div 跟结果一样高 ⇒ 用户滚到接近底部时，div 的底边也进入视口，
       bar 就被推出视口了（真机实测：滚动 60% 之前 bar 恒定吸在 top=13，
       之后一路掉到 -2071）。
       偏偏「快读完了、准备点保存」正是最需要它的时候。

       修法：让这个包裹 div 用 `display:contents` —— **它不生成盒子**，
       bar 的包含块因此上浮成 `.mbody`（= scrollport 本身），
       clamp 区间变成整个可视区，全程吸住。
       副作用检查：`.mbody` 不是 flex 容器（只有 `flex:1`，那是它作为
       `.modal` 子项的属性），所以 contents 之后其余子节点仍是普通块级流、
       堆叠顺序不变；`.ai-savebar` 的负 margin 依旧抵消 `.mbody` 的 padding。
       万一老浏览器不认 contents，退回原样也只是「吸到包含块末尾」，不更糟。 */
    var body = el('div', { style: 'display:contents' }, [
      saveBar,
      el('div', { class: 'row', style: 'margin-bottom:10px' }, [statusLine]),
      errBox,
      raw,
      resultBox,
    ]);

    var m = U.openModal({
      title: opt.title || (tplDef ? tplDef.label : 'AI 运行'),
      size: opt.size || 'wide',
      body: body,
      maskClose: false,
      footer: [],
      onClose: function () { if (ctrl) { try { ctrl.abort(); } catch (e) { /* noop */ } } },
    });

    function setStatus(html, cls) {
      statusLine.innerHTML = '';
      statusLine.appendChild(spinner);
      statusLine.appendChild(el('div', { class: cls || '', html: html }));
    }

    function btn(text, cls, fn, id) {
      var b = el('button', { class: 'btn ' + (cls || ''), text: text, onclick: fn });
      if (id) b.id = id;
      return b;
    }

    var bRun = btn('重新生成', '', function () { start(true); });
    var bCopy = btn('复制输出', '', function () {
      U.copyText(opt.copyText !== undefined ? opt.copyText : (rawText || (parsed ? JSON.stringify(parsed, null, 2) : '')))
        .then(function (ok) { U.toast(ok ? '已复制到剪贴板' : '复制失败，请手动选中复制', ok ? 'ok' : 'warn'); });
    });

    /* 保存状态机：顶部条与 footer 按钮**共用**它，两处不可能不一致。
       ⛔ 以前 `bApply.disabled` 在三个地方各写一遍（初始 / start / 成功回调），
          很容易出现「上面说已保存、下面还能点」的矛盾界面。 */
    var saveState = 'run';       // run | ready | done
    var applyLabel = opt.applyLabel || '应用';
    var where = opt.saveHint ? ('存进' + opt.saveHint) : '存下来';

    function setSaveState(s, detail) {
      saveState = s;
      var dis, txt, btnTxt;
      if (s === 'ready') {
        dis = false;
        txt = '👇 内容已生成，确认后一键' + where;
        btnTxt = '💾 ' + applyLabel;
      } else if (s === 'done') {
        dis = true;
        txt = '✅ 已保存' + (detail || '') + '　不用再点一次';
        btnTxt = '✅ 已保存';
      } else if (s === 'fail') {
        dis = true;
        txt = '❌ 生成失败，暂时没有可保存的内容（修好后点「重新生成」）';
        btnTxt = '💾 ' + applyLabel;
      } else {
        dis = true;
        txt = '⏳ 正在生成…好了之后这里会出现「' + applyLabel + '」';
        btnTxt = '💾 ' + applyLabel;
      }
      barText.textContent = txt;
      barBtn.textContent = btnTxt;
      barBtn.disabled = dis;
      bApply.textContent = (s === 'done') ? '✅ 已保存' : applyLabel;
      bApply.disabled = dis || !opt.onApply;
      saveBar.style.display = opt.onApply ? '' : 'none';
    }

    function doApply() {
      /* ⛔ 三道门：没有 onApply / 还没生成完 / 已经存过了。
         「已存过就不给再点」既是防重复写，也是给用户一个明确的完成信号。 */
      if (!opt.onApply || !settled || saveState === 'done') return;
      setSaveState('run');                 // 先锁按钮防连点，但**别**提前标 done
      var at = '';
      try {
        opt.onApply(parsed, rawText, m.close);
        at = '　' + U.hm(U.now());
        setSaveState('done', at);          // 真的写成功了才标「已保存」
      } catch (e) {
        /* ⛔ onApply 抛错绝不能还显示「✅ 已保存」（评审核实 2026-10-30，P0）。
           以前是 finally 里无条件 setSaveState('done') → 写库失败时界面撒谎，
           且按钮永久禁用无法重试。这里失败就复位，让用户能再点一次。 */
        setSaveState('ready');
        if (opt.onError) { try { opt.onError(e); } catch (e2) { /* noop */ } }
        else { U.toast('保存失败：' + (e && e.message ? e.message : e)); }
      } finally {
        if (opt.onApplied) { try { opt.onApplied(parsed, rawText); } catch (e) { /* noop */ } }
      }
    }

    var bApply = btn(applyLabel, 'pri', doApply);
    barBtn.onclick = doApply;
    var bClose = btn('关闭', '', function () { m.close(); });
    setSaveState('run');

    var foot = m.modal.querySelector('.mfoot');
    foot.appendChild(bRun); foot.appendChild(bCopy); foot.appendChild(bApply);
    (opt.extraFooter || []).forEach(function (x) { foot.appendChild(x); });
    foot.appendChild(el('span', { class: 'sp' }));
    foot.appendChild(bClose);

    /* --- 默认结果渲染 --- */
    function defaultRender(data, text) {
      if (data === null || data === undefined) {
        return el('div', {}, [el('pre', { class: 'typer', style: 'max-height:44vh', text: text || '' })]);
      }
      if (typeof data !== 'object') {
        return el('div', { class: 'box pre-wrap', text: String(data) });
      }
      // JSON 对象 → 键值对 + 数组列表，比裸 JSON 好读得多（与助手页气泡共用同一个渲染器）
      return aiResultNode(data) || el('div', { class: 'box pre-wrap', text: text || '' });
    }

    function showError(msg) {
      errBox.style.display = '';
      errBox.innerHTML = '';
      errBox.appendChild(el('div', { class: 'note bad mb12' }, [
        el('span', { class: 'ico', text: '⛔' }),
        el('div', { html: U.esc(msg).replace(/\n/g, '<br>') }),
      ]));
    }

    function start(isRerun) {
      if (running) return;
      running = true; settled = false;
      rawText = ''; parsed = null;
      errBox.style.display = 'none';
      resultBox.style.display = 'none';
      resultBox.innerHTML = '';
      raw.style.display = '';
      raw.textContent = '';
      setSaveState('run');
      bRun.disabled = true;
      setStatus((isRerun ? '重新生成中' : '正在调用 <b>' + U.esc(AI.cfg().model || '模型') + '</b>，结果会实时显示…'));

      ctrl = new AbortController();
      var t0 = U.now();

      // ⚠️ AI.runTemplate 内部会同步调用 assertReady()，没配 Key 时是**同步抛**，
      // 不是返回 rejected promise。不包起来的话异常会直接冲出 setTimeout，
      // 既不会进 .catch，弹窗也会永久停在"正在调用…"，用户在界面上看不到任何原因。
      var p;
      try {
        p = AI.runTemplate(opt.tpl, opt.input, {
          signal: ctrl.signal,
          onDelta: function (d, full) {
            raw.style.display = '';
            raw.innerHTML = U.esc(full) + '<span class="cur"></span>';
            raw.scrollTop = raw.scrollHeight;
          },
        });
        if (!p || typeof p.then !== 'function') p = Promise.reject(new Error('AI 调用没有返回 Promise（模板配置有问题）'));
      } catch (e) {
        p = Promise.reject(e);
      }

      p.then(function (res) {
        running = false; settled = true;
        bRun.disabled = false;
        setSaveState('ready');          // 结果出来了 → 顶部条亮起「可保存」
        rawText = res.text || '';
        parsed = res.data;

        if (parsed !== null && parsed !== undefined) {
          raw.style.display = 'none';
          resultBox.style.display = '';
          resultBox.innerHTML = '';
          resultBox.appendChild(
            (opt.renderResult ? opt.renderResult(parsed, rawText) : defaultRender(parsed, rawText))
          );
          setStatus('✅ 完成（' + ((U.now() - t0) / 1000).toFixed(1) + ' 秒）。' +
            (opt.onApply ? '确认无误后点上方「' + applyLabel + '」保存，或先「复制输出」。' : '可以先「复制输出」。'));
        } else {
          // 非 JSON 模板：直接把文本留在 raw 里展示
          raw.innerHTML = U.esc(rawText);
          setStatus('✅ 完成（' + ((U.now() - t0) / 1000).toFixed(1) + ' 秒）。');
        }
      }).catch(function (e) {
        running = false;
        bRun.disabled = false;
        setSaveState('fail');            // 别让顶部条停在「正在生成…」骗人
        setStatus('❌ 出错了，可以点「重新生成」再试一次');
        showError(e.message || String(e));
        if (e.raw) {
          raw.style.display = '';
          raw.innerHTML = U.esc(e.raw);
        }
        // 没配 Key 是最常见的失败原因，别只让用户自己猜 —— 直接给个跳转按钮
        if (e.code === 'NO_CONFIG') {
          errBox.appendChild(el('div', { class: 'row mt8' }, [
            btn('去设置页填 API Key', 'pri', function () { m.close(); App.go('settings'); }),
          ]));
        }
        U.toast('AI 调用失败：' + String(e.message || e).split('\n')[0], 'bad', 7000);
      });
    }

    if (opt.autoRun !== false) setTimeout(start, 120);
    else { setStatus('待运行。'); bRun.disabled = false; }

    return m;
  }

  /* ---------------- 岗位选择器 ---------------- */
  /**
   * jobPicker({multiple, only, title, exclude}) → Promise(jobId | jobId[] | null)
   */
  function jobPicker(opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      var picked = [];
      var kw = '';
      var listBox = el('div', { class: 'stack', style: 'gap:7px;max-height:52vh;overflow-y:auto' });

      function render() {
        var all = Store.jobs();
        if (opt.only === 'boss') all = all.filter(function (j) { return j.source === 'boss'; });
        if (opt.exclude) all = all.filter(function (j) { return opt.exclude.indexOf(j.id) < 0; });
        if (kw) {
          var k = kw.toLowerCase();
          all = all.filter(function (j) {
            return (j.title + ' ' + j.company + ' ' + (j.tags || []).join(' ')).toLowerCase().indexOf(k) >= 0;
          });
        }
        listBox.innerHTML = '';
        if (!all.length) {
          listBox.appendChild(empty('📭', '没有可选岗位', '先去岗位库导入岗位'));
          return;
        }
        all.forEach(function (j) {
          var on = picked.indexOf(j.id) >= 0;
          var row = el('div', {
            class: 'box pointer',
            style: 'cursor:pointer;' + (on ? 'border-color:var(--brand);background:var(--brand-soft)' : ''),
            onclick: function () {
              if (opt.multiple) {
                var i = picked.indexOf(j.id);
                if (i >= 0) picked.splice(i, 1); else picked.push(j.id);
              } else { picked = [j.id]; }
              render(); syncBtn();
            },
          }, [
            el('div', { class: 'row', style: 'gap:8px' }, [
              el('b', { class: 'fs13', text: j.title || '(未命名岗位)' }),
              el('span', { class: 'muted fs12', text: j.company || '' }),
              el('span', { class: 'sp' }),
              on ? el('span', { class: 'tag brand', text: '已选' }) : null,
            ]),
            el('div', { class: 'row fs12 muted mt4', style: 'gap:8px' }, [
              el('span', { text: j.salaryText || '面议' }),
              el('span', { text: j.location || '' }),
              j.source === 'boss' ? el('span', { class: 'tag', text: 'BOSS' }) : null,
            ].filter(Boolean)),
          ]);
          listBox.appendChild(row);
        });
      }

      var search = el('input', { type: 'text', placeholder: '搜索岗位名 / 公司 / 标签…' });
      search.addEventListener('input', U.debounce(function () { kw = search.value.trim(); render(); }, 160));

      var bOk = el('button', { class: 'btn pri', text: '确定', onclick: function () {
        if (!picked.length) { U.toast('请先选一个岗位', 'warn'); return; }
        done(opt.multiple ? picked : picked[0]); m.close();
      } });
      function syncBtn() { bOk.disabled = !picked.length; }
      syncBtn();

      var m = U.openModal({
        title: opt.title || (opt.multiple ? '选择岗位（可多选）' : '选择岗位'),
        size: 'wide',
        body: el('div', {}, [el('div', { class: 'mb12' }, [search]), listBox]),
        footer: [
          // 先落值，再关窗（关窗会触发 onClose → resolve(null)，顺序反了就等于点取消）
          { text: '确定', cls: 'pri', onClick: function (c) {
            if (!picked.length) { U.toast('请先选一个岗位', 'warn'); return; }
            done(opt.multiple ? picked : picked[0]); c();
          } },
          { text: '取消', onClick: function (c) { done(null); c(); } },
        ],
        onClose: function () { done(null); },
      });

      render();
    });
  }

  /* ---------------- 简历选择器 ---------------- */
  function resumePicker(opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      var list = Store.resumes();
      if (!list.length) {
        U.toast('还没有简历，先去「简历素材库」添加一份。', 'warn');
        done(null); return;
      }
      var body = el('div', { class: 'stack', style: 'gap:8px' });
      list.forEach(function (r) {
        body.appendChild(el('div', {
          class: 'box pointer', style: 'cursor:pointer',
          // 点一行直接选中：先落值再关窗，否则 onClose 会把它冲成 null
          onclick: function () { done(r.id); m.close(); },
        }, [
          el('div', { class: 'row' }, [
            el('b', { class: 'fs13', text: r.name }),
            r.isDefault ? el('span', { class: 'tag brand', text: '默认' }) : null,
            el('span', { class: 'sp' }),
            el('span', { class: 'muted fs12', text: (r.content || '').length + ' 字' }),
          ].filter(Boolean)),
          r.tags && r.tags.length ? tagList(r.tags) : null,
        ].filter(Boolean)));
      });
      var m = U.openModal({
        title: opt.title || '选择简历版本',
        body: body,
        footer: [{ text: '取消', onClick: function (c) { done(null); c(); } }],
        onClose: function () { done(null); },
      });
    });
  }

  /* ---------------- 确认删除 ---------------- */
  function confirmDelete(what, detail) {
    return U.confirm(
      '确定要删除' + U.esc(what) + '吗？' + (detail ? '<br><span class="muted fs12">' + U.esc(detail) + '</span>' : '') +
      '<br><span class="muted fs12">删除后无法恢复，建议先到设置页导出备份。</span>',
      { title: '删除确认', danger: true, okText: '删除' }
    );
  }

  /**
   * 可撤销删除的 toast。
   * 单个删除不再弹确认框 —— 确认框每次都要多点一次，而撤销按钮只在**真出事**时用得上，
   * 总体更省事也更安全（确认框点快了照样删错）。
   * snap 必须是 Store.takeOut() 返回的快照。
   */
  function trashToast(msg, snap, after) {
    return U.toast(msg, 'ok', 12000, [{
      text: '撤销', cls: 'pri',
      onClick: function () {
        var n = Store.putBack(snap);
        U.toast(n ? '已恢复 ✅' : '这些内容已经回来了', 'ok');
        App.updateNavCounts();
        try { if (after) after(); else App.refresh(); } catch (e) { /* noop */ }
      },
    }]);
  }

  /* ---------------- 复制按钮 ---------------- */
  function copyBtn(text, label) {
    return el('button', {
      class: 'btn sm', html: '📋 ' + (label || '复制'),
      onclick: function (e) {
        e.stopPropagation();
        U.copyText(text).then(function (ok) {
          U.toast(ok ? '已复制' : '复制失败，请手动选中', ok ? 'ok' : 'warn');
        });
      },
    });
  }

  /* ---------------- AI 未配置提醒条 ---------------- */
  /**
   * 这个条会出现在 8 个页面顶部，很占版面。
   * 所以：① 关掉之后本次会话内不再出现（存 sessionStorage，不污染长期设置）；
   *       ② 文案里点明「本工作台自己的 Key」，避免和采集器服务端的 Key 混淆。
   */
  var AI_NOTE_KEY = 'jh.aiNoteDismissed';

  function aiNoteDismissed() {
    try { return sessionStorage.getItem(AI_NOTE_KEY) === '1'; } catch (e) { return false; }
  }
  function dismissAiNote() {
    try { sessionStorage.setItem(AI_NOTE_KEY, '1'); } catch (e) { /* noop */ }
  }

  function aiReadyNote() {
    if (AI.ready() || aiNoteDismissed()) return null;
    var box = el('div', { class: 'note warn' }, [
      el('span', { class: 'ico', text: '⚠️' }),
      el('div', { class: 'flex1' }, [
        el('b', { text: '这个工作台的 AI 功能还没配模型接口。' }),
        el('br'),
        el('span', { class: 'fs12', html: '去 <a href="#settings">设置 → ① 大模型接口</a> 填 API Key 即可。' +
          '岗位文本导入、看板、统计这些不用 AI 也能用。' }),
        el('span', { class: 'fs11 muted', html: '<br>（「📡 采集岗位」页那个「已配 Key」说的是<b>本地采集器服务端</b>的配置，和这里的 Key 是两套，互不影响。）' }),
      ]),
      el('button', { class: 'btn xs note-x', title: '本页不再提示', text: '✕', onclick: function (e) {
        e.stopPropagation();
        dismissAiNote();
        var p = box.parentNode; if (p) p.removeChild(box);
      } }),
    ]);
    return box;
  }

  /* ---------------- 生效层级徽章 ----------------
     同一张卡上混着三种「筛在哪生效」的条件，用户分不清哪一项在服务端生效、
     哪一项只是采回来再过滤 —— 所以把层级写在每一项旁边（一处定义、两页复用）。

       server = 写进 BOSS 的搜索条件，服务端就筛了
       local  = BOSS 接口没这个参数，采回来再过滤（不会少采，只是多一层过滤）
       prefs  = 根本不影响采集，只喂岗位库的「按我的偏好筛选」与「合适度」 */
  var LEVELS = {
    server: { ico: '🔎', text: '透传 BOSS',
      title: '会写进 BOSS 的搜索条件 —— BOSS 在服务端就把不符合的筛掉了' },
    local: { ico: '💻', text: '采集后本地筛',
      title: 'BOSS 搜索接口没有这个参数 —— 采回来之后在结果里过滤（不少采，只是多一层过滤）' },
    prefs: { ico: '🏠', text: '只影响岗位库',
      title: '这个条件不影响采集，只用于岗位库的「按我的偏好筛选」与「合适度」' },
  };
  function lvlBadge(kind) {
    var L = LEVELS[kind];
    if (!L) return null;
    return el('span', { class: 'lvlb ' + kind, title: L.title }, [
      el('span', { class: 'lvlb-i', text: L.ico }),
      el('span', { text: L.text }),
    ]);
  }
  /** 三种层级的图例（放筛选区顶部，省得逐项解释）。 */
  function lvlLegend(prefix) {
    return el('div', { class: 'lvlegend' }, [
      el('span', { class: 'fs11 muted', text: prefix || '这些条件的「生效位置」不一样：' }),
      lvlBadge('server'), lvlBadge('local'), lvlBadge('prefs'),
    ]);
  }

  /* ---------------- 「这次会改哪几项」确认弹窗 ----------------
     采集条件 ⇄ 求职偏好 的双向带入共用这一个壳（两个方向各写一份必然飘）。

     ⛔ 本项目弹窗铁律第一条：**先落值再关窗**。所以确认按钮里先调 onConfirm
        （它负责写数据），再 close()。反过来写会出现「点了确认但值没落」。
     ⛔ 只列**会变的项**，并且明说「没列出来的项一律不动」——
        用户才敢点这个按钮。 */
  function planDialog(opt) {
    opt = opt || {};
    var steps = opt.steps || [];
    var body = el('div', { class: 'stack', style: 'gap:10px' });

    if (!steps.length) {
      body.appendChild(el('div', { class: 'note info' }, [
        el('span', { class: 'ico', text: '✅' }),
        el('div', { html: opt.emptyText || '两边已经完全一致，<b>不用改</b>。' }),
      ]));
    } else {
      body.appendChild(el('div', { class: 'fs12 muted',
        html: opt.subtitle || '下面是这次会改的项。' }));
      var tb = el('table', { class: 'diff-tb' });
      tb.appendChild(el('thead', {}, [el('tr', {}, [
        el('th', { text: '条件' }), el('th', { text: '现在' }), el('th', { text: '改成' }),
      ])]));
      var tbody = el('tbody');
      steps.forEach(function (s) {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, [
            el('b', { class: 'fs12', text: s.label }),
            s.hint ? el('div', { class: 'fs11 muted', text: s.hint }) : null,
          ].filter(Boolean)),
          el('td', { class: 'diff-from', text: s.from }),
          el('td', { class: 'diff-to', text: s.to }),
        ]));
      });
      tb.appendChild(tbody);
      body.appendChild(el('div', { class: 'diff-wrap' }, [tb]));
      body.appendChild(el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '⚠' }),
        el('div', { html: '只有上表这几项会变，<b>没列出来的一律不动</b>。' +
          '（这个操作是手动的 —— 两边<b>不会自动同步</b>，免得临时换一套条件搜一下就把长期设置冲了。）' }),
      ]));
    }

    var m = U.openModal({ title: opt.title || '确认改这几项', size: '', body: body, footer: [] });
    var foot = m.modal.querySelector('.mfoot');
    if (foot) {
      foot.innerHTML = '';
      foot.appendChild(el('button', { class: 'btn', text: '取消', onclick: function () { m.close(); } }));
      if (steps.length) {
        foot.appendChild(el('button', {
          class: 'btn pri', text: opt.confirmText || ('确认改这 ' + steps.length + ' 项'),
          onclick: function () {
            if (opt.onConfirm) opt.onConfirm(opt.patch);   // ① 先落值
            m.close();                                     // ② 再关窗
          },
        }));
      }
    }
    return m;
  }

  global.Comp = {
    empty: empty, statusPill: statusPill, tagList: tagList, fitLine: fitLine,
    chipsRow: chipsRow,
    field: field, fields: fields,
    runAI: runAI, aiResultNode: aiResultNode, jobPicker: jobPicker, resumePicker: resumePicker,
    confirmDelete: confirmDelete, trashToast: trashToast, copyBtn: copyBtn, aiReadyNote: aiReadyNote,
    lvlBadge: lvlBadge, lvlLegend: lvlLegend, planDialog: planDialog,
    el: el,
  };
})(window);
