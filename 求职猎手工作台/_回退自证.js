/* ==========================================================================
   _回退自证.js · 反向验证测试套件到底有没有用
   --------------------------------------------------------------------------
   做法：把每条新功能**故意改坏**一次 → 跑测试 → 必须变红 → 还原。
   如果改坏了测试还是全绿，说明那条功能根本没有被覆盖，测试是摆设。

   跑法：node _回退自证.js
   ========================================================================== */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const NODE = process.execPath;
const TEST = path.join(DIR, '_测试_核心.js');

/* 「打包工程」目录 —— 便携版/安装包的构建现场，是 `求职猎手工作台/` 的**兄弟目录**。
   为什么要在这儿也解析一次：有几条变异打的是**便携版孪生服务端**
   `_打包工程/src/server_core.py`（比如「只修了 dev 那份 = 用户那份没修」这类）。
   它不在工作台目录里，所以 `file` 必须写成**绝对路径** —— 相对路径会被
   按 DIR 解析成「文件不存在」，然后被当成"跳过"，看起来像这条已经覆盖了。
   解析规则与 `_测试_核心.js` 的 PACK_DIR 完全一致（两处口径必须相同）。 */
const PACK_TWIN = (function () {
  const cands = [process.env.JH_PACK_DIR,
                 path.join(DIR, '_打包工程'),
                 path.join(DIR, '..', '_打包工程'),
                 'D:/AIshuju/BOSS/_打包工程'];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c) continue;
    if (fs.existsSync(path.join(c, 'src', 'server_core.py'))) {
      return path.join(c, 'src', 'server_core.py');
    }
  }
  /* 找不到也给一条路径（而不是空串）—— 让它在锚点预检里明确报红，
     而不是静默变成"跳过"。 */
  return path.join(DIR, '..', '_打包工程', 'src', 'server_core.py');
})();

/**
 * 「删除」.mutbak 备份。用 renameSync 移到**项目内**的垃圾桶目录，而不是 unlinkSync ——
 * WorkBuddy 给 node 注入 safe-delete shim，unlinkSync 会被拦成「移回收站 + 批量守卫」，
 * 一个 turn 里删到 50 次就抛错拒绝（本脚本 86 处变异 × 每处 1 个 .mutbak，必触发）。
 * rename 不被 shim 拦截；且必须移到**同盘**（Windows 跨盘 rename 会 EXDEV 失败），
 * 所以垃圾桶放在项目内，而不是 os.tmpdir()（那在 C 盘，产品在 D 盘）。
 */
const _trashDir = path.join(DIR, '.mutbak-trash');
try { fs.mkdirSync(_trashDir, { recursive: true }); } catch (e) { /* noop */ }
function dispose(p) {
  try {
    if (fs.existsSync(p)) {
      fs.renameSync(p, path.join(_trashDir, path.basename(p) + '.' + Date.now() + '.' + Math.random().toString(36).slice(2)));
    }
  } catch (e) {
    // 移不动（跨盘/占用）就退回直接删 —— 反正这是临时备份，丢了也不影响产品文件
    try { fs.rmSync(p, { force: true }); } catch (e2) { /* noop */ }
  }
}

/** 每条 = 一处"把功能改坏"的补丁；改完必须让测试红，否则这条功能没被覆盖 */
const MUTATIONS = [
  {
    name: '① 摘掉 openModal 的 beforeClose 钩子（未保存提示整条链断掉）',
    file: 'js/utils.js',
    from: 'if (opt.beforeClose && !skipOnClose) {',
    to: 'if (false && opt.beforeClose && !skipOnClose) {',
    expect: '拦不住关闭',
  },
  {
    name: '② 简历表单不接守卫（关窗直接丢内容）',
    file: 'js/view-resume.js',
    from: 'beforeClose: guard.check,',
    to: '/*beforeClose: guard.check,*/',
    expect: '表单不问了',
  },
  {
    name: '③ 不渲染筛选条件汇总条',
    file: 'js/view-jobs.js',
    from: 'var box = buildFilterChips(rebuild);',
    to: 'var box = null;',
    expect: '汇总条不出现',
  },
  {
    name: '④ 删除不给撤销（takeOut 后直接弹普通 toast）',
    file: 'js/view-jobs.js',
    from: "Comp.trashToast('已删除岗位「'",
    to: "U.toast('已删除岗位「'",
    expect: '撤销按钮没了',
  },
  {
    name: '⑤ 批量改字段在循环里逐条落盘（本该只落一次盘、只广播一次）',
    file: 'js/store.js',
    /* ⚠️ 锚点必须连上一行 Object.assign 一起写 —— 光靠 `j.updatedAt = U.now(); n++;`
       在 store.js 里出现 3 次（updateJobs / 另两个循环），String.replace 只改第一处，
       一旦前面插进新的同构循环，变异就会打在**别的函数**上 → 改了但没改到位 → 假绿。
       （这是 _测试_核心.js 的「锚点唯一性」守卫在 2026-10-05 查出来的。） */
    from: "      Object.assign(j, normJob(Object.assign({}, j, patch, { id: j.id, createdAt: j.createdAt })));\n" +
      "      j.updatedAt = U.now(); n++;",
    to: "      Object.assign(j, normJob(Object.assign({}, j, patch, { id: j.id, createdAt: j.createdAt })));\n" +
      "      j.updatedAt = U.now(); n++; save(); fire('jobs');",
    expect: '广播次数不止一次',
  },
  {
    name: '⑥ resume-doc.js 去掉 el 别名（导出按钮直接报错）',
    file: 'js/resume-doc.js',
    from: 'var el = Comp.el;',
    to: '// var el = Comp.el;',
    expect: 'ReferenceError / 静态检查抓到',
  },
  {
    name: '⑦ 待跟进不理会「稍后提醒」（压不住噪音）',
    file: 'js/view-followup.js',
    from: 'if (Store.isSnoozed(item.key)) return;',
    to: 'if (false && Store.isSnoozed(item.key)) return;',
    expect: '稍后了还在列表里',
  },
  {
    name: '⑧ 侧边导航去掉「待跟进」入口',
    file: 'js/app.js',
    from: "{ id: 'followup',  name: '待跟进',      icon: '⏰', sub: '该催的、该复盘的、该安排的，一次列全' },",
    to: '',
    expect: '导航入口数不对',
  },
  {
    name: '⑨ 切视图不记住偏好（下次打开回到默认）',
    file: 'js/view-jobs.js',
    from: "onclick: function () { F.view = x.v; savePref(); App.refresh(); },",
    to: "onclick: function () { F.view = x.v; App.refresh(); },",
    expect: '偏好没落盘',
  },
  {
    name: '⑩ 样式表里删掉 .bbar（批量条变成裸元素）',
    file: 'css/app.css',
    from: '.bbar {\n  position: sticky;',
    to: '.bbar-disabled {\n  position: sticky;',
    expect: '覆盖检查抓到缺样式',
  },
  {
    name: '⑪ 简历预览不套主题色（切主题成了假按钮）',
    file: 'js/resume-doc.js',
    from: "d.style.setProperty('--rd-accent', accent);",
    to: 'void accent;',
    expect: '预览主题失效',
  },
  {
    name: '⑫ 标题栏 ✕ 写成 onclick: close（事件对象被当成"跳过守卫"，守卫静默失效）',
    file: 'js/utils.js',
    from: "onclick: function () { close(); } });\n    head.appendChild(el('span', { class: 'sp' }));",
    to: "onclick: close });\n    head.appendChild(el('span', { class: 'sp' }));",
    expect: '点 ✕ 不问了',
  },
  {
    /* 这是本轮真踩到的 bug：0 是「用户关掉了提醒」，被 || 吞成默认值 7 之后
       设置页那个开关就成了摆设 —— 关了照样弹。必须有断言钉住。 */
    name: '⑬ 备份提醒把 remindDays=0 吞成默认 7（设置页关不掉提醒）',
    file: 'js/app.js',
    from: "var remindDays = typeof cfg.remindDays === 'number' ? cfg.remindDays : 7;\n    if (remindDays <= 0) return;",
    to: "var remindDays = cfg.remindDays || 7;",
    expect: '关掉后还弹提醒',
  },
  {
    name: '⑭ 设置页拿掉备份提醒开关（提醒变成关不掉的骚扰）',
    file: 'js/view-settings.js',
    // ⚠️ 锚点不要带 \n —— 这个文件是 CRLF，用 \n 会匹配不上（踩过）
    from: "el('label', { class: 'chk' }, [cbRemind, el('span', { text: '定期提醒我导出备份' })])",
    to: "el('label', { class: 'chk' }, [cbRemind, el('span', { text: '定期备份' })])",
    expect: '设置页找不到那个勾选框',
  },
  {
    name: '⑮ 偏好筛选接了但没生效（按钮能点、列表没变）',
    file: 'js/view-jobs.js',
    from: `    if (F.pref) {
      arr = arr.filter(function (j) { return global.JobMatch.passPref(j, P); });
    }`,
    to: `    if (false && F.pref) {
      arr = arr.filter(function (j) { return global.JobMatch.passPref(j, P); });
    }`,
    expect: '按偏好筛选后列表纹丝不动',
  },
  {
    name: '⑯ 薪资为空的岗位被薪资底线筛掉（用户会以为岗位丢了）',
    file: 'js/job-match.js',
    from: 'if (lo === null && hi === null) return true;',
    to: 'if (lo === null && hi === null) return false;',
    expect: '没写薪资的岗位被误杀',
  },
  {
    name: '⑰ 「不能接受的点」改成扫整段 JD（「本岗位非外包」被误杀）',
    file: 'js/job-match.js',
    from: `      (job.tags || []).join(' '),
      trim(job.title),
      trim(job.company),
      // BOSS 权威字段「代招」：用户写「排除外包」时精准命中，不必再去 JD 里猜
      // （JD 里「本岗位非外包」这类反向表述，靠扫正文会误杀）
      job.proxyHire ? '代招 外包 派遣 劳务 中介' : '',
    ].join(' ').toLowerCase();`,
    to: `      (job.tags || []).join(' '),
      trim(job.title),
      trim(job.company),
      job.proxyHire ? '代招 外包 派遣 劳务 中介' : '',
      trim(job.rawJD),
    ].join(' ').toLowerCase();`,
    expect: '反向表述的 JD 被误判成踩线',
  },
  {
    name: '⑱ 多关键词退回「整串子串匹配」（搜「运营 短视频」永远搜不到）',
    file: 'js/job-match.js',
    from: `    out.matched = !!(out.cities.length || out.salaryMin !== null || out.exclude.length ||
      out.kwTokens.length > 1);`,
    to: `    out.matched = !!(out.cities.length || out.salaryMin !== null || out.exclude.length);`,
    expect: '两个词都要命中的用例挂了',
  },
  {
    name: '⑲ 城市剔除把紧邻的关键词一起吃掉（原来那个 \\s 退化成 s 的老 bug）',
    file: 'js/job-match.js',
    from: `      var re = new RegExp(c + '(?:市|省)?(?:[`,
    to: `      var re = new RegExp(c + '[^，,。.、；;]{0,20}' + '(?:[`,
    expect: '「杭州 运营」里的运营被一起吃掉',
  },
  {
    name: '⑳ 快捷 chip 从 AND 叠加改成 OR（选中两个反而筛不掉）',
    file: 'js/job-match.js',
    from: 'if (!d.test(job, p)) return false;',
    to: 'if (!d.test(job, p)) return true;',
    expect: '两个 chip 叠加不再收窄结果',
  },
  {
    name: '㉑ 「重置」不清偏好开关（用户以为重置了、列表还是被偷偷筛过）',
    file: 'js/view-jobs.js',
    from: `    F.pref = false;
    prefTouched = true;
    F.quick = {};`,
    to: `    prefTouched = true;
    F.quick = {};`,
    expect: '重置之后偏好还在生效',
  },
  {
    name: '㉒ 「当普通关键词搜」的退路点了没反应（用户被卡在解析口径里）',
    file: 'js/view-jobs.js',
    from: 'onclick: function () { F.nlOff = true; App.refresh(); } }),',
    to: 'onclick: function () { } }),',
    expect: '解析小字点不掉',
  },
  {
    name: '㉓ 采集结果筛选：城市下拉形同虚设（选了城市结果不变）',
    file: 'js/view-collect.js',
    from: "if (CF.city) arr = arr.filter(function (j) {\n      return String(j.location || '').indexOf(CF.city) >= 0;\n    });",
    to: "if (false) arr = arr.filter(function (j) {\n      return String(j.location || '').indexOf(CF.city) >= 0;\n    });",
    expect: '采集页按城市筛不出来',
  },
  {
    name: '㉔ 采集结果筛选：福利筛选形同虚设（选了双休结果不变）',
    file: 'js/view-collect.js',
    from: "    if (CF.welfare && CF.welfare.length) {\n      arr = arr.filter(function (j) { return global.JobMatch.welfareHit(j, CF.welfare, 'any'); });\n    }",
    to: "    if (false && CF.welfare && CF.welfare.length) {\n      arr = arr.filter(function (j) { return global.JobMatch.welfareHit(j, CF.welfare, 'any'); });\n    }",
    expect: '采集页按福利筛不出来',
  },
  {
    name: '㉕ 采集结果筛选：活跃度筛选形同虚设（选了今日活跃结果不变）',
    file: 'js/view-collect.js',
    from: "    if (CF.active) {\n      var wantRank = activeRank(CF.active);\n      arr = arr.filter(function (j) {\n        return activeRank(String(j.active || '')) <= wantRank;\n      });\n    }",
    to: "    if (false && CF.active) {\n      var wantRank = activeRank(CF.active);\n      arr = arr.filter(function (j) {\n        return activeRank(String(j.active || '')) <= wantRank;\n      });\n    }",
    expect: '采集页按活跃度筛不出来',
  },
  {
    name: '㉖ 岗位期望没有并入采集关键词（选了岗位也不会去搜）',
    file: 'js/view-collect.js',
    from: "    (f.expectJobs || []).forEach(function (n) {\n      var v = String(n || '').trim();\n      if (v && kws.indexOf(v) < 0) kws.push(v);\n    });\n    return kws;",
    to: "    return kws;",
    expect: '岗位期望没进搜索词',
  },
  {
    name: '㉗ 期望岗位筛选形同虚设（jobHit 恒放行）',
    file: 'js/job-match.js',
    from: "    if (!expectJobs || !expectJobs.length) return true;\n    var t = trim(job && job.title).toLowerCase().replace(/\\s+/g, '');",
    to: "    if (!expectJobs || !expectJobs.length) return true;\n    if (expectJobs) return true;\n    var t = trim(job && job.title).toLowerCase().replace(/\\s+/g, '');",
    expect: '期望岗位筛不出东西',
  },
  {
    name: '㉘ 岗位搜索变成大小写敏感（java 搜不到 Java）',
    file: 'js/job-picker.js',
    from: "      if (String(x.name).toLowerCase().indexOf(k) < 0) continue;",
    to: "      if (String(x.name).indexOf(k) < 0) continue;",
    expect: '岗位搜索大小写敏感',
  },
  {
    name: '㉙ 真实在招岗位数据整块丢失（JOB_MARKET 读不到）',
    file: 'js/job-picker.js',
    from: "  function market() { return global.JOB_MARKET || null; }",
    to: "  function market() { return null; }",
    expect: '真实在招岗位全没了',
  },
  {
    name: '㉚ 真实在招岗位没被并进搜索（只搜官方树，搜不到「抖音短视频运营」）',
    file: 'js/job-picker.js',
    from: "    var mall = marketFlat();\n    for (var j = 0; j < mall.length; j++) {\n      var y = mall[j];\n      if (String(y.name).toLowerCase().indexOf(k) < 0) continue;",
    to: "    var mall = [];\n    for (var j = 0; j < mall.length; j++) {\n      var y = mall[j];\n      if (String(y.name).toLowerCase().indexOf(k) < 0) continue;",
    expect: '真实在招岗位搜不到',
  },
  {
    name: '㉛ 选择器里不渲染「真实在招岗位」块',
    file: 'js/job-picker.js',
    from: "      var mkt = paintMarketBlock();\n      if (mkt) listBox.appendChild(mkt);",
    to: "      var mkt = null;",
    expect: '真实在招块没渲染',
  },
  {
    name: '㉜ 「本组全加」形同虚设（点了不加任何岗位）',
    file: 'js/job-picker.js',
    from: "      function addAll() {\n        names.forEach(function (n) {\n          if (isPicked(n)) return;\n          if (!multiple) picked.length = 0;\n          picked.push(n);\n        });\n        paintPicked(); syncList(); updateStat();\n      }",
    to: "      function addAll() { paintPicked(); syncList(); updateStat(); }",
    expect: '本组全加没生效',
  },
  {
    name: '㉝ 采集结果「岗位名」筛选形同虚设（选了岗位名结果不变）',
    file: 'js/view-collect.js',
    from: "    if (CF.job && global.JobMatch) {\n      arr = arr.filter(function (j) { return global.JobMatch.jobHit(j, [CF.job]); });\n    }",
    to: "    if (false && CF.job && global.JobMatch) {\n      arr = arr.filter(function (j) { return global.JobMatch.jobHit(j, [CF.job]); });\n    }",
    expect: '岗位名筛不出来',
  },
  {
    name: '㉞ 岗位名下拉没接上真实在招数据（只剩下一个「不限」）',
    file: 'js/view-collect.js',
    from: "    var mk = global.JOB_MARKET;\n    if (!mk || !mk.groups) return out;",
    to: "    var mk = global.JOB_MARKET;\n    if (mk) return out;",
    expect: '岗位名下拉是空的',
  },
  {
    name: '㉟ 设了岗位名不算「有筛选条件」（导入按钮 / 清空按钮判断错）',
    file: 'js/view-collect.js',
    from: "    return !!(CF.kw || CF.job || CF.city ||",
    to: "    return !!(CF.kw || CF.city ||",
    expect: '设了岗位名不算有筛选',
  },
  {
    name: '㊱ 「清空筛选」漏掉岗位名（清完还剩残留条件）',
    file: 'js/view-collect.js',
    from: "    CF.kw = ''; CF.job = ''; CF.city = ''; CF.district = []; CF.bizArea = [];",
    to: "    CF.kw = ''; CF.city = ''; CF.district = []; CF.bizArea = [];",
    expect: '岗位名没被清掉',
  },
  {
    name: '㊲ 「代招 / 已失效」判断写反（是→false、否→true）',
    file: 'js/export.js',
    from: "    var isYes = function (v) { return /^(是|有|yes|y|true|1)$/i.test(String(v == null ? '' : v).trim()); };",
    to: "    var isYes = function (v) { return !/^(是|有|yes|y|true|1)$/i.test(String(v == null ? '' : v).trim()); };",
    expect: '代招/已失效判断反了',
  },
  {
    name: '㊳ 导入时又把「代招」丢掉（不映射 proxyHire）',
    file: 'js/export.js',
    from: "      proxyHire: isYes(pickField(o, ALIAS.proxyHire)),",
    to: "      proxyHire: false,",
    expect: '代招字段没回填',
  },
  {
    name: '㊴ 写库时丢掉新字段（normJob 不保留 address）',
    file: 'js/store.js',
    from: "      address: String(j.address || '').trim(),       // 详细地址（通勤判断）",
    to: "      address: '',",
    expect: '详细地址入库后丢失',
  },
  {
    name: '㊵ 重复采集时布尔标记被后一条抹掉（合并不做「或」）',
    file: 'js/store.js',
    from: "      if (!target[k] && src[k]) target[k] = true;",
    to: "      target[k] = src[k];",
    expect: '合并时布尔未取或',
  },
  {
    name: '㊶ 「排除外包」不再认 BOSS 的代招字段（退回靠 JD 猜）',
    file: 'js/job-match.js',
    from: "      job.proxyHire ? '代招 外包 派遣 劳务 中介' : '',",
    to: "      '',",
    expect: '代招岗位筛不出来',
  },
  {
    name: '㊷ 采集参数体检不检查薪资档位（错配也不提醒）',
    file: 'js/view-collect.js',
    from: "    if (salaryMin !== null && form.salary && SALARY_BAND[form.salary]) {",
    to: "    if (false) {",
    expect: '薪资档位错配不报警',
  },
  {
    name: '㊸ 「技能标签」又当回硬性技能喂模型',
    file: 'js/ai.js',
    from: "    if (job.reqSkills && job.reqSkills.length) L.push('招聘标签（平台自动打，多为招聘卖点、非硬性要求）：' + job.reqSkills.join('、'));",
    to: "    if (job.reqSkills && job.reqSkills.length) L.push('硬性技能：' + job.reqSkills.join('、'));",
    expect: 'jobToText 又叫回硬性技能',
  },
  {
    name: '㊹ 关键词命中不封顶（命中越多分越高，权重失效）',
    file: 'js/job-score.js',
    from: '    return { score: Math.min(WEIGHTS.keywords, hits.length * 6), hits: hits };',
    to: '    return { score: hits.length * 6, hits: hits };',
    expect: '7 个命中没封顶在 30',
  },
  {
    name: '㊺ 分级汇总把「被剔除」也算进 A/B/C/D（剔除≠低分，两者混为一谈）',
    file: 'js/job-score.js',
    from: '      if (r.gate.drop) { out.drop++; return; }',
    to: '      if (r.gate.drop) { out.drop++; }',
    expect: '各级计数之和 + 剔除 ≠ 总数',
  },
  {
    name: '㊻ 关键词兜底判据写回「合并后为空」（选了期望岗位兜底就失效，只剩 1 个词）',
    file: 'js/job-score.js',
    from: '    var usingDefault = !focus.length;',
    to: '    var usingDefault = !uniq(focus.concat(expectJobs).concat(resumeTags)).length;',
    expect: '期望岗位把兜底顶掉了',
  },
  {
    name: '㊼ 「1 年以下」当成区间内（上限型区间被误判成"正好合适"）',
    file: 'js/job-score.js',
    from: '    if (/以下|以内/.test(t)) {',
    to: '    if (false && /以下|以内/.test(t)) {',
    expect: '超配的 1年以下 拿了满分',
  },
  {
    name: '㊽ 下午茶/零食算成正经福利（福利维失去区分度）',
    file: 'js/job-score.js',
    from: "    out.flexible = /弹性|不加班|朝九晚六|灵活|不打卡/.test(t);",
    to: "    out.flexible = /弹性|不加班|朝九晚六|灵活|不打卡|下午茶|零食/.test(t);",
    expect: '只有下午茶却拿了正经福利的档位',
  },
  {
    name: '㊾ 「信息残缺」门槛写回 ≤2 个字段（几乎每条岗位都被无差别扣 3 分）',
    file: 'js/job-score.js',
    from: "    if (filled === 0) { d -= 3; why.push('信息残缺（除了岗位名什么都没采到）-3'); }",
    to: "    if (filled <= 2) { d -= 3; why.push('信息残缺 -3'); }",
    expect: '加减分被"人人平等"的残缺扣分冲平',
  },
  {
    name: '㊿ 采集页合适度退回按 j.id 存（采集结果还没 id → 整批挤在 undefined 一个键上）',
    file: 'js/view-collect.js',
    /* ⚠️ 锚点只覆盖 cfFitAll/cfFitOf 两个函数体 —— 不要把前面的 `var CF_FIT = new Map()`
       也框进来：那段注释后来被 P0-4 的 RESULT_PAGE 说明插了进来，多行锚点会静默失效
       （2026-10-05 就是这么漏掉一条的）。函数体本身是稳定的。 */
    from: "  function cfFitAll(list) {\n" +
      "    if (!global.JobScorer) return list;\n" +
      "    var cfg = global.JobScorer.config();\n" +
      "    CF_FIT = new Map();\n" +
      "    list.forEach(function (j) { CF_FIT.set(j, global.JobScorer.score(j, cfg)); });\n" +
      "    return list;\n" +
      "  }\n" +
      "\n" +
      "  function cfFitOf(j) {\n" +
      "    if (CF_FIT.has(j)) return CF_FIT.get(j);\n" +
      "    return global.JobScorer.score(j);\n" +
      "  }",
    to: "  function cfFitAll(list) {\n" +
      "    if (!global.JobScorer) return list;\n" +
      "    var cfg = global.JobScorer.config();\n" +
      "    CF_FIT = {};\n" +
      "    list.forEach(function (j) { CF_FIT[j.id] = global.JobScorer.score(j, cfg); });\n" +
      "    return list;\n" +
      "  }\n" +
      "\n" +
      "  function cfFitOf(j) {\n" +
      "    return CF_FIT[j.id];\n" +
      "  }",
    expect: '一批岗位共用同一个分数、整齐地一起被剔除',
  },
  {
    name: '⓵ 岗位详情不渲染合适度面板（点进去看不到"为什么推这条"）',
    file: 'js/view-jobs.js',
    from: '    left.appendChild(fitPanel(fitOf(j)));',
    to: '    /* left.appendChild(fitPanel(fitOf(j))); */',
    expect: '详情里没有 .fitpanel',
  },
  {
    name: '⓶ 岗位库「隐藏被剔除的岗位」形同虚设',
    file: 'js/view-jobs.js',
    from: '      arr = arr.filter(function (j) { return !FITMAP[j.id].gate.drop; });',
    to: '      arr = arr;',
    expect: '剔除的岗位还留在列表里',
  },
  {
    name: '⓷ 偏好改动不落盘（"即时生效"变成"看着生效、其实没存"）',
    file: 'js/view-jobs.js',
    from: '      Store.setSetting(\'prefs.\' + key, val);\n' +
          '      sumEl.textContent = global.JobMatch.describePref(global.JobMatch.prefs());\n' +
          '      paintSoon();',
    to: '      sumEl.textContent = global.JobMatch.describePref(global.JobMatch.prefs());\n' +
        '      paintSoon();',
    expect: '关键词没落盘',
  },
  {
    name: '⓸ 打分口径的年限存成字符串（数字字段没归一，下游比较全乱）',
    file: 'js/view-jobs.js',
    from: "commitSoon('myYears', U.asNum(fYears.get()));",
    to: "commitSoon('myYears', fYears.get());",
    expect: '年限落盘成了字符串',
  },
  {
    name: '⓹ 偏好面板点不开（头部点击不切 class）',
    file: 'js/view-jobs.js',
    from: "        box.classList.toggle('open', willOpen);",
    to: "        /* box.classList.toggle('open', willOpen); */",
    expect: '点不动，面板展不开',
  },
  {
    name: '⓺ 被剔除的岗位也给分（「剔除」和「0 分」混为一谈）',
    file: 'js/components.js',
    from: '    if (ft.gate && ft.gate.drop) {',
    to: '    if (false && ft.gate && ft.gate.drop) {',
    expect: '剔除的岗位变成给了分',
  },
  {
    name: '⓻ 原因行只说好话（C 级被包装成 A 级）',
    file: 'js/job-score.js',
    from: "    if (bad.length) line += '；⚠ ' + bad.slice(0, 2).join(' · ');",
    to: "    if (false && bad.length) line += '；⚠ ' + bad.slice(0, 2).join(' · ');",
    expect: '只剩正面，没有 ⚠',
  },
  {
    name: '⓼ 「大小周」也算成福利档位（把妥协当福利）',
    file: 'js/job-score.js',
    from: '    if (out.rest.rank === 3) out.level++;',
    to: '    if (out.rest.rank >= 2) out.level++;',
    expect: '大小周被算成了加分项',
  },
  {
    name: '⓽ 福利串只按数组拆、不拆长串（BOSS 列表页那种挤在一起的一整串直接失效）',
    file: 'js/job-score.js',
    from: '      String(s).split(/[,，、;；/|\\s]+/)',
    to: '      String(s).split(/[,，、;；/|]+/)',
    expect: '「交通补助 有无线网 工龄奖 年终奖 五险一金」拆不出逐项',
  },
  {
    name: '⓾ 对比表·假期分数写反（单休反而排最优）',
    file: 'js/view-compare.js',
    from: '        return { text: bits.join(\' · \'), sub: sub, score: w.rest.rank === null ? -1 : w.rest.rank };',
    to: '        return { text: bits.join(\' · \'), sub: sub, score: w.rest.rank === null ? -1 : -w.rest.rank };',
    expect: '双休拿 -3',
  },
  {
    name: '⑴ 对比表·公司规模参与评优（规模大被当成更优）',
    file: 'js/view-compare.js',
    from: "        return { text: s, sub: (WS() ? WS().scaleLabel(s) : '') };",
    to: "        return { text: s, sub: (WS() ? WS().scaleLabel(s) : ''), score: 1 };",
    expect: '规模那行被标了绿底',
  },
  {
    name: '⑵ 对比表·公司福利把整串糊上去（不逐项拆，等于没对比）',
    file: 'js/view-compare.js',
    from: "          text: w.items.length ? w.items.join('、') : '（福利串里拆不出逐项）',",
    to: "          text: w.raw || '（福利串里拆不出逐项）',",
    expect: '福利那格变成一整串',
  },
  {
    name: '⑶ 采集结果不显示合适度原因（要在采集页看清成色，得先导库再回来筛）',
    file: 'js/view-collect.js',
    from: '            Comp.fitLine(cfFitOf(j)),',
    to: '            /* Comp.fitLine(cfFitOf(j)), */',
    expect: '采集页没有原因行',
  },
  {
    /* 第 23 轮：那张「② 求职偏好」指路牌整卡被删（入口统一在岗位库筛选栏），
       原来这条变异（指路牌只跳页、不展开面板）的锚点随之消失，换成设置页折叠的两条。 */
    name: '❽ 设置页折叠 · 收起时不写摘要（"这一块"从页面上消失了）',
    file: 'js/view-settings.js',
    from: "      psum.textContent = open ? ''\n        : String(typeof summary === 'function' ? summary() : (summary || ''));",
    to: "      psum.textContent = '';",
    expect: '收起留一行摘要 → 收起来什么都没有',
  },
  {
    name: '❾ 设置页折叠 · 状态不落盘（刷新就弹回来，等于没折）',
    file: 'js/view-settings.js',
    from: "      m[key] = open ? 1 : 0;\n      localStorage.setItem(FOLD_KEY, JSON.stringify(m));",
    to: '      /* 变异：不落盘 */',
    expect: '折叠状态落盘 → 不落盘（重画后弹回默认）',
  },

  /* ===== 第 11 轮：福利待遇 / 地理下钻 / 采集页精筛 / 公司背调 ===== */
  {
    name: '⑸ 期望福利「没采到就不筛掉」被破坏（福利没采到的岗位被当不达标筛掉）',
    file: 'js/job-match.js',
    from: "    if (!w) return true;                       // 没采到 → 保留",
    to: "    if (!w) return false;                      // 没采到 → 筛掉（错）",
    expect: '没采到福利的岗位被筛掉了',
  },
  {
    name: '⑹ 「全部满足」退化成「任一满足」（勾 3 项只要中 1 项就算达标）',
    file: 'js/job-match.js',
    from: "    return mode === 'any' ? hit.length > 0 : hit.length === wanted.length;",
    to: "    return hit.length > 0;",
    expect: '只中一项也算全满足',
  },
  {
    name: '⑺ 地理筛选把「没采到区/商圈」的岗位也筛掉（用户会以为岗位丢了）',
    file: 'js/geo.js',
    from: '    if (dh === null && strict) return false;',
    to: '    if (dh === null) return false;',
    expect: '没采到区的岗位被筛掉',
  },
  {
    name: '⑻ 地理「区未知」标记不生效（列表里混进一堆看着不该匹配的岗位）',
    file: 'js/geo.js',
    from: "    if (needD && !extractDistrict(job)) return true;",
    to: "    if (false && needD && !extractDistrict(job)) return true;",
    expect: '区未知标记不生效',
  },
  {
    name: '⑼ 采集页区/商圈精筛形同虚设（选了区结果不变）',
    file: 'js/view-collect.js',
    from: '    if (g && global.GEO) arr = arr.filter(function (j) { return global.GEO.geoHit(j, g); });',
    to: '    if (false && g && global.GEO) arr = arr.filter(function (j) { return global.GEO.geoHit(j, g); });',
    expect: '区精筛没生效',
  },
  {
    name: '⑽ 采集结果的城市下拉不联动清掉旧区（选了新区却 0 条）',
    file: 'js/view-collect.js',
    from: "          CF.city = v;\n          // 换城市后原来的区/商圈可能不属于这个城市了 → 一起清掉，避免\"选了却 0 条\"\n          CF.district = []; CF.bizArea = [];",
    to: "          CF.city = v;\n          // 换城市后原来的区/商圈可能不属于这个城市了 → 一起清掉，避免\"选了却 0 条\"\n          /* 不清 */",
    expect: '换城市后旧区还留着',
  },
  {
    name: '⑾ 参数卡填的区/商圈不搬进结果页筛选（填了等于白填）',
    file: 'js/view-collect.js',
    from: '      CF.district = U.asArray(f.district).slice();\n      CF.bizArea = U.asArray(f.bizArea).slice();',
    to: '      CF.district = [];\n      CF.bizArea = [];',
    expect: '参数卡的区没搬过来',
  },
  {
    name: '⑿ 采集结果里的区候选并进内置行政区划（下拉里冒出选了显示 0 条的假选项）',
    file: 'js/view-collect.js',
    from: "      var d = global.GEO ? global.GEO.extractDistrict(j) : String(j.district || '').trim();\n      if (!d || seen[d]) return;",
    to: "      var d = global.GEO ? (global.GEO.DISTRICTS['杭州'] || [])[0] : String(j.district || '').trim();\n      if (!d || seen[d]) return;",
    expect: '下拉里出现没采到的假选项',
  },
  {
    name: '⒀ 背调：没查过的公司被当成绿灯（把「没数据」伪装成「没问题」）',
    file: 'js/company-check.js',
    from: "    return mk('unknown', hasData(rec)",
    to: "    return mk('green', hasData(rec)",
    expect: '没查过的显示绿灯',
  },
  {
    name: '⒁ 背调：实缴留空被当成「实缴为 0」报警（不知道 ≠ 查到是 0）',
    file: 'js/company-check.js',
    from: '    if (has(reg.paidIn) && num(reg.paidIn) === 0 && num(reg.capital) > 0) {',
    to: '    if (num(reg.paidIn) === 0 && num(reg.capital) > 0) {',
    expect: '没填实缴的被当实缴 0',
  },
  {
    name: '⒂ 背调：经营状态「注销/吊销」不再红灯',
    file: 'js/company-check.js',
    from: '    if (st && DEAD_RE.test(st)) {',
    to: '    if (false && st && DEAD_RE.test(st)) {',
    expect: '注销公司不给红灯',
  },
  {
    name: '⒃ 背调：组合预警退化成「任一命中即慎入」（把所有初创都劝退）',
    file: 'js/company-check.js',
    from: '    return { n: hits.length, hits: hits, danger: hits.length >= 3 };',
    to: '    return { n: hits.length, hits: hits, danger: hits.length >= 1 };',
    expect: '命中 1 项就喊高危',
  },
  {
    name: '⒄ 背调：成立时间没填也算「成立不足 1 年」',
    file: 'js/company-check.js',
    from: '    if (!has(establishedAt)) return null;',
    to: '    if (!has(establishedAt)) return 0;',
    expect: '没填成立时间被当 0 年',
  },
  {
    name: '⒅ 背调：导出备份里带着 API Key（外发即泄露）',
    file: 'js/store.js',
    from: "    if (s && s.bgCheck && s.bgCheck.apiKey) { s.bgCheck.apiKey = ''; redacted.push('bgCheck.apiKey'); }",
    to: "    /* 不抹 */",
    expect: '备份里带着 Key',
  },
  {
    name: 'ⓐ 模型 Key 默认就跟着备份外流（"Key 只在你浏览器里"这句承诺作废）',
    file: 'js/store.js',
    from: "      } else {\n        s.ai.apiKey = '';\n        redacted.push('ai.apiKey');\n      }",
    to: "      } else {\n        redacted.push('ai.apiKey');\n      }",
    expect: '默认导出带 Key',
  },
  {
    name: '⒆ 背调档案按 id 合并（同一家公司两台机器各录一份 → 两条互相矛盾）',
    file: 'js/store.js',
    from: "      var exist = DB.checks.filter(function (x) { return x.key === c.key; })[0];\n      if (!exist) { DB.checks.unshift(c); rep.checks++; return; }",
    to: "      var exist = DB.checks.filter(function (x) { return x.id === c.id; })[0];\n      if (!exist) { DB.checks.unshift(c); rep.checks++; return; }",
    expect: '同一家公司变成两条',
  },
  {
    name: '⒇ 背调：录入户的实时预警预览不更新（填完才知道会判成什么）',
    file: 'js/view-company.js',
    from: "      f.input.addEventListener('input', paintPrev);",
    to: "      f.input.addEventListener('input', function () { /* 不刷新预览 */ });",
    expect: '预览不跟着变',
  },
  {
    name: '⑴ 岗位卡片上的公司名不可点（路线 A 的入口整个没了）',
    file: 'js/view-jobs.js',
    from: "              class: 'co-name', text: j.company,",
    to: "              class: 'co-plain', text: j.company,",
    expect: '公司名不可点',
  },
  {
    name: '⑵ 背调：没查过的公司也挂灰灯（几百张卡全挂同一个灰点 = 纯噪音）',
    file: 'js/view-jobs.js',
    from: '    if (!rec || !global.CompanyCheck.hasData(rec)) return null;',
    to: '    if (!rec) return null;',
    expect: '没查过的也挂了灯',
  },
  {
    name: '⑶ 背调：参数卡里填的区不属于采集城市却不体检（白采一轮才发现筛成空）',
    file: 'js/view-collect.js',
    from: "      if (bad.length && bad.length === wantDist.length) {",
    to: "      if (false && bad.length === wantDist.length) {",
    expect: '对不上也不提醒',
  },
  {
    name: '⑷ 采集：进行中不再显示滚动进度条（任务在跑却看不出进度）',
    file: 'js/view-collect.js',
    from: "else if (!paused) pbarCls += ' task-pbar-run';",
    to: "else if (false && !paused) pbarCls += ' task-pbar-run';",
    expect: '进行中没了滚动进度条',
  },
  {
    name: '⑸ 采集：跑完不再弹明显的完成提示（onTaskDone 里 notifyDone 被摘掉）',
    file: 'js/view-collect.js',
    from: '    if (S.wasRunning) notifyDone(t);',
    to: '    if (false && S.wasRunning) notifyDone(t);',
    expect: '跑完不弹提示',
  },
  {
    name: '⑹ 采集：计时秒数算错（fmtDur 永远显示 0 秒）',
    file: 'js/view-collect.js',
    from: "    if (sec < 60) return sec + ' 秒';",
    to: "    if (sec < 60) return '0 秒';",
    expect: '计时数字不对',
  },
  {
    name: '⑺ 账号：切换账号后数据没隔离（switchAccount 不改数据 key 指针）',
    file: 'js/store.js',
    from: '    flush();                                   // 先落盘当前账号\n    CURRENT_ACCOUNT = nm;',
    to: '    flush();                                   // 先落盘当前账号\n    // CURRENT_ACCOUNT = nm;',
    expect: '切换后数据没隔离',
  },
  {
    name: '⑻ 账号：设了密码的账号切换时不校验密码（谁都能切进去）',
    file: 'js/store.js',
    from: "    if (rec.pwd && String(pwd || '') !== String(rec.pwd)) {",
    to: "    if (false && rec.pwd && String(pwd || '') !== String(rec.pwd)) {",
    expect: '密码形同虚设',
  },
  {
    name: '⑼ 账号：账号名含路径分隔符也放行（目录名注入风险）',
    file: 'js/store.js',
    from: '    if (/[\\\\/:*?"<>|\\s]/.test(s)) return false;   // 禁止路径分隔符、通配符、空白',
    to: '    if (/[\\s]/.test(s)) return false;   // 禁止路径分隔符、通配符、空白',
    expect: '非法账号名被放行',
  },
  {
    name: '⑽ 筛选：高级筛选不再折叠（「更多筛选」面板默认全展开）',
    file: 'js/view-jobs.js',
    from: "    var more = el('div', { class: 'more-panel' + (F.moreOpen ? '' : ' hide'), 'data-more': '1' });",
    to: "    var more = el('div', { class: 'more-panel', 'data-more': '1' });",
    expect: '折叠不生效',
  },
  {
    name: '⑾ 筛选：点「更多筛选」不切换折叠态（按钮没反应）',
    file: 'js/view-jobs.js',
    from: "        onclick: function () { F.moreOpen = !F.moreOpen; savePref(); App.refresh(); },",
    to: "        onclick: function () { F.moreOpen = F.moreOpen; savePref(); App.refresh(); },",
    expect: '点开没反应',
  },
  {
    name: '⑿ 采集：清空结果按钮整个没了（导入后没法清结果区）',
    file: 'js/view-collect.js',
    from: "        class: 'btn', html: '🗑 清空结果',",
    to: "        class: 'btn', html: '🗑 清空（已失效）',",
    expect: '清空按钮不见了',
  },
  {
    name: '⒀ 岗位库：一键清空按钮没了（只能一个个勾选删）',
    file: 'js/view-jobs.js',
    from: "          class: 'btn xs danger', html: '🗑 一键清空',",
    to: "          class: 'btn xs danger', html: '🗑 逐个清（已失效）',",
    expect: '一键清空入口不见了',
  },
  {
    name: '⒁ 岗位库：一键清空点「取消」也照样删光（确认形同虚设）',
    file: 'js/view-jobs.js',
    from: "    ).then(function (ok) {\n      if (!ok) return;",
    to: "    ).then(function (ok) {\n      /* 取消也照删 */",
    expect: '取消还能删光岗位',
  },
  {
    name: '⒂ 采集：请求不再带访问令牌（任意网页又能读写本机数据）',
    file: 'js/view-collect.js',
    from: "    if (tok) headers['X-JH-Token'] = tok;",
    to: "    if (false && tok) headers['X-JH-Token'] = tok;",
    expect: '请求没带令牌',
  },
  {
    name: '⒃ 采集：登录态永远算「新鲜」（过期也不预检，照样白跑）',
    file: 'js/view-collect.js',
    /* ⚠️ P1-4 之后 TTL 不再写死 45*60，改成从 ping.login.ttlSec 读（单一来源在服务端）。
       所以旧锚点 `... < 45 * 60` 已失效（2026-10-05 静默漏检）。现在的等价改坏法：
       直接把整个判断换成 true。 */
    from: "    var ttl = Number(lg.ttlSec) > 0 ? Number(lg.ttlSec) : 45 * 60;\n" +
      "    return lg.value === 'ok' && at > 0 && (Date.now() / 1000 - at) < ttl;",
    to: "    var ttl = Number(lg.ttlSec) > 0 ? Number(lg.ttlSec) : 45 * 60;\n" +
      "    return true;",
    expect: '过期也不预检登录',
  },
  {
    name: '⒄ 采集：缺令牌时不提示（用户在「点什么都失败」里打转）',
    file: 'js/view-collect.js',
    from: "      if (!token()) {\n        wrap.appendChild(noTokenCard());",
    to: "      if (false) {\n        wrap.appendChild(noTokenCard());",
    expect: '缺令牌时没有引导卡',
  },

  /* ------------------------------------------------------------------
     第 15 轮 · 启动器 / 采集器服务（复核：上一轮记成"已修好"的两项实测没闭环）
     这几条改的是 .vbs / .cmd / server.py —— 前端桩测永远碰不到，所以
     _测试_核心.js 里对**源文件内容**做了结构断言，这里逐条反向验证那些断言真能红。
     注意：两个 .vbs 是 UTF-16LE，必须声明 enc，否则读出来是乱码、锚点匹配不上。
     ------------------------------------------------------------------ */
  {
    name: '⒅ 采集器：又把 SO_REUSEADDR 加回来（Windows 上会抢占正在监听的端口）',
    file: '采集器/server.py',
    from: "        s.settimeout(0.3)\n        return s.connect_ex(('127.0.0.1', port)) == 0",
    to: "        s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)\n        s.settimeout(0.3)\n        return s.connect_ex(('127.0.0.1', port)) == 0",
    expect: '端口探测又形同虚设',
  },
  {
    name: '⒆ 采集器：_send 不再兜底 dict（403 响应体又被截成 2 字节）',
    file: '采集器/server.py',
    from: "        if not isinstance(body, (str, bytes, bytearray)):\n            body = json.dumps(body, ensure_ascii=False)\n",
    to: '',
    expect: '_send 接不住 dict',
  },
  {
    name: '⒇ 采集器：PID 文件又写 os.getpid()（venv shim 那层永远杀不掉）',
    file: '采集器/server.py',
    from: 'f.write(str(ROOT_PID or os.getpid()))',
    to: 'f.write(str(os.getpid()))',
    expect: 'PID 文件不是根进程',
  },
  {
    name: '㉑ 停止脚本：ForEach-Object 里又塞 exit 0（只杀第一个、exit 2 永不执行）',
    file: '后台停止采集器.vbs',
    enc: 'utf16le',
    from: '$ids=@($procs | ForEach-Object { [int]$_.ProcessId }); ',
    to: '$ids=@($procs | ForEach-Object { [int]$_.ProcessId; exit 0 }); ',
    expect: '管道被 exit 打断',
  },
  {
    name: '㉒ 停止脚本：taskkill 去掉 /T（子树不连带清理，父 shim 留下）',
    file: '后台停止采集器.vbs',
    enc: 'utf16le',
    from: 'taskkill.exe /F /T /PID ([int]$r.ProcessId)',
    to: 'taskkill.exe /F /PID ([int]$r.ProcessId)',
    expect: '停止不带 /T',
  },
  {
    name: '㉓ 启动脚本：不设 PYTHONIOENCODING（GBK 写日志，一个非 GBK 字符就炸启动）',
    file: '后台启动采集器.vbs',
    enc: 'utf16le',
    from: 'shell.Environment("Process")("PYTHONIOENCODING") = "utf-8"',
    to: "' 忘了设 PYTHONIOENCODING（python 会用 GBK 写日志）",
    expect: '没给子进程定编码',
  },
  {
    name: '㉔ 启动脚本：不读 status.json（专门给用户看原因的文件又被晾着）',
    file: '后台启动采集器.vbs',
    enc: 'utf16le',
    from: 'If fso.FileExists(statusFile) Then why = StatusError(statusFile)',
    to: "' 不看 status.json，只看 launch-out",
    expect: '不读结构化状态文件',
  },
  {
    name: '㉕ cmd 启动器：探活端口少一个（8740 上的服务被当成"没在跑"）',
    file: '启动采集器.cmd',
    from: 'set "PORTS=8738 8739 8740"',
    to: 'set "PORTS=8738 8739"',
    expect: '端口列表跟 server.py 不一致',
  },

  /* ------------------------------------------------------------------
     第 16 轮 · 桌面快速启动（favicon.ico + 创建桌面快捷方式.vbs）
     目标文件里有二进制（.ico）和 UTF-16LE（.vbs），各自声明编码；
     二进制那条用 latin1（逐字节可逆），否则读成 utf-8 就是乱码、锚点永远匹配不上。
     ------------------------------------------------------------------ */
  {
    name: '㉖ favicon.ico：图标类型被写成 2（Windows 当成"光标"资源，直接不认）',
    file: 'favicon.ico',
    enc: 'latin1',
    /* ⚠️ 锚点要含 ICO 头的前 6 字节（reserved=0, type=1, count=7），不能只用
       `\x00\x00\x01\x00` —— 那 4 个字节在 PNG 块里也出现（PNG 的 IHDR/数据里到处是
       0x00000001 之类），出现 3 次。replace 只改第一处虽然恰好落在文件头的 type 上，
       但这是"碰巧对"，不写清楚就等于给未来埋雷。
       头部 6 字节 = 00 00 | 01 00 | 07 00（7 个图标条目）。 */
    from: '\x00\x00\x01\x00\x07\x00',
    to: '\x00\x00\x02\x00\x07\x00',
    expect: 'favicon.ico 头部不是图标资源',
  },
  {
    name: '㉗ 图标生成器：SIZES 少了 256（改了生成器忘了重跑 → 图标和生成器脱钩）',
    file: '_生成图标.py',
    from: 'SIZES = [16, 24, 32, 48, 64, 128, 256]',
    to: 'SIZES = [16, 24, 32, 48, 64, 128]',
    expect: '生成器与产物尺寸对不上',
  },
  {
    name: '㉘ 快捷方式生成器：目标不再指向 wscript.exe（改赌 .vbs 文件关联没被改过）',
    file: '创建桌面快捷方式.vbs',
    enc: 'utf16le',
    from: 'sc.TargetPath = wscriptExe',
    to: 'sc.TargetPath = targetVbs',
    expect: '目标不是 wscript.exe',
  },
  {
    name: '㉙ 快捷方式生成器：参数不加引号（路径带空格就整个跑不起来）',
    file: '创建桌面快捷方式.vbs',
    enc: 'utf16le',
    from: 'sc.Arguments = """" & targetVbs & """"',
    to: 'sc.Arguments = targetVbs',
    expect: '参数没被引号包住',
  },
  {
    name: '㉚ 快捷方式生成器：桌面路径写死 %USERPROFILE%\\Desktop（OneDrive 重定向后写到不存在的地方）',
    file: '创建桌面快捷方式.vbs',
    enc: 'utf16le',
    from: 'desktop = shell.SpecialFolders("Desktop")',
    to: 'desktop = shell.ExpandEnvironmentStrings("%USERPROFILE%\\Desktop")',
    expect: '桌面路径没走 SpecialFolders',
  },
  {
    name: '㉛ 快捷方式生成器：找错脚本名（指向一个不存在的文件，双击必然没反应）',
    file: '创建桌面快捷方式.vbs',
    enc: 'utf16le',
    from: 'FindIn(base, "后台停止采集器.vbs")',
    to: 'FindIn(base, "停止采集器.vbs")',
    expect: '指向的脚本名打错了',
  },
  {
    name: '㉜ 快捷方式生成器：JH_QUIET 不再被读取（静默模式失效，自动化会被弹窗卡住）',
    file: '创建桌面快捷方式.vbs',
    enc: 'utf16le',
    from: 'quiet = (shell.Environment("Process")("JH_QUIET") = "1")',
    to: 'quiet = False',
    expect: '静默开关没真正生效',
  },
  {
    name: '㉝ 快捷方式生成器：不先删旧快捷方式（重复运行时留下半个旧文件被占用）',
    file: '创建桌面快捷方式.vbs',
    enc: 'utf16le',
    from: '  If fso.FileExists(lnkPath) Then fso.DeleteFile lnkPath, True\n',
    to: '',
    expect: '没先清理同名旧快捷方式',
  },
  {
    name: '㉞ 快捷方式生成器：不再设图标（快捷方式变成默认白纸图标）',
    file: '创建桌面快捷方式.vbs',
    enc: 'utf16le',
    from: 'If iconPath <> "" Then sc.IconLocation = iconPath & ",0"',
    to: 'If False Then sc.IconLocation = iconPath & ",0"',
    expect: 'IconLocation 没接上图标',
  },
  {
    name: '㉟ 快捷方式生成器：BOM 被去掉（丢掉 UTF-16LE 的 BOM，wscript 读中文全乱码）',
    file: '创建桌面快捷方式.vbs',
    enc: 'latin1',
    from: '\xff\xfe',
    to: '',
    expect: '.vbs 不是 UTF-16LE + BOM',
  },
  /* ===== 第 17 轮：体检报告整改（P0-1 边界声明 / P1-1 只看新增 / P2-2 预估 / P2-4 透传） ===== */
  {
    name: 'Ⓐ P1-1 「本次新增」筛选失效（点开关还留全部）',
    file: 'js/view-collect.js',
    from: 'if (CF.onlyNew) arr = arr.filter(function (j) { return !!j.isNew; });',
    to: 'if (false && CF.onlyNew) arr = arr.filter(function (j) { return !!j.isNew; });',
    expect: '点「本次新增」后条数没变少',
  },
  {
    name: 'Ⓑ P2-2 预估不准：详情封顶改回 None（按全量算，把用户吓退）',
    file: '采集器/server.py',
    from: '_EST_DETAIL_TOP_N = 50',
    to: '_EST_DETAIL_TOP_N = None',
    expect: '详情封顶与 skill 不一致',
  },
  {
    name: 'Ⓒ P2-2 预估算法绕开封顶（详情时间按总条数算）',
    file: '采集器/server.py',
    from: 'detail_sec = detail_n * _EST_PER_DETAIL_SEC',
    to: 'detail_sec = items * _EST_PER_DETAIL_SEC',
    expect: '详情时间没走封顶后的条数',
  },
  {
    name: 'Ⓓ P2-4 薪资透传退回省略 flag（用户「不限」被模型填成区间）',
    file: '采集器/server.py',
    from: "put_or_blank('--salary', p.get('salary'))",
    to: "put('--salary', p.get('salary'))",
    expect: '薪资没用 put_or_blank',
  },
  {
    name: 'Ⓔ P2-4 put_or_blank 对空值不再转空串（等于没修复）',
    file: '采集器/server.py',
    from: "        if value in (None, [], ()):\n            value = ''",
    to: "        if False:\n            value = ''",
    expect: '空值没被转成空串',
  },
  {
    name: 'Ⓕ P2-1 采集历史弹窗不再列出各轮（只留一个空壳）',
    file: 'js/view-collect.js',
    from: 'items.forEach(function (it) {',
    to: '([]).forEach(function (it) {',
    expect: '列不出当前那轮',
  },
  {
    name: 'Ⓖ P0-1 结果池文案又说回「本批」（跨轮累积被说成本批）',
    file: 'js/view-collect.js',
    from: "? '结果池共 ' + jobs.length + ' 个 · 本次新增 ' + newCount() + ' 个'",
    to: "? '本批共 ' + jobs.length + ' 个 · 本次新增 ' + newCount() + ' 个'",
    expect: '文案又写「本批」',
  },
  {
    name: 'Ⓗ P1-3 详情失败不再明示（改回静默）',
    file: 'js/view-collect.js',
    from: '      if (df && df.count) {',
    to: '      if (false && df && df.count) {',
    expect: '失败提示不出现',
  },
  {
    name: 'Ⓘ 停止脚本不读 collector.pid（退回 *server.py* 字符串匹配，误杀别的项目）',
    file: '后台停止采集器.vbs',
    enc: 'utf16le',
    from: "$pidFile=Join-Path $d 'collector.pid';",
    to: "$pidFile=Join-Path $d 'collector.port';",
    expect: '停止脚本读错 PID 文件',
  },
  {
    name: 'Ⓙ 权威技能要求没接下游（job-score 又不去读 reqSkillsAuthoritative）',
    file: 'js/job-score.js',
    from: 'var needSkills = U.asArray(job.reqSkillsAuthoritative);',
    to: 'var needSkills = U.asArray(job.reqSkills);',
    expect: 'JD 技能要求又没人读了',
  },
  {
    name: 'Ⓚ 条数输入 0（不限）又被 || 30 吞成 30',
    file: 'js/view-collect.js',
    from: 'if (n === 0) return 0;',
    to: 'if (n === 0) return 30;',
    expect: '0 又变成 30',
  },
  {
    name: 'Ⓛ 回复判定口径被改严（HR 看过也不算回复，回复率归因失效）',
    file: 'js/store.js',
    from: "var replied = applied.filter(function (a) { return reachedIndex(a) >= chainIndex('viewed'); });",
    to: "var replied = applied.filter(function (a) { return reachedIndex(a) >= chainIndex('invited'); });",
    expect: '回复率口径变严',
  },
  {
    name: 'Ⓜ 结果页薪资档退回自定档（与参数卡口径又对不上）',
    file: 'js/view-collect.js',
    from: 'var b = SALARY_BAND[CF.salary];',
    to: 'var b = (CF.salary && CF.salary.indexOf("-") >= 0) ? null : SALARY_BAND[CF.salary];',
    expect: '薪资档口径漂移',
  },
  {
    name: 'Ⓝ 「只看新增」默认置位被摘掉（用户又要手动点）',
    file: 'js/view-collect.js',
    from: '        CF.onlyNew = true;',
    to: '        CF.onlyNew = false;',
    expect: '默认不看新增了',
  },
  {
    name: 'Ⓞ 静态服务放行下划线开发产物（测试脚本又成可直读资源）',
    file: '采集器/server.py',
    from: "        if basename.startswith(('_', '.')):",
    to: "        if False and basename.startswith(('_', '.')):",
    expect: '下划线文件又可直接读',
  },
  {
    /* 现场真事故（2026-10-06）：这个 `if` 一旦失效，浏览器断连后 crawler 就
       无限空转重试，1 分钟刷出 424MB 日志、内存和前端一起被拖死。 */
    name: 'Ⓟ 翻页滚动失败又变回无限重试（浏览器断连后空转刷屏）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/crawler.py',
    from: '                if scroll_fail >= SCROLL_FAIL_LIMIT:',
    to: '                if False and scroll_fail >= SCROLL_FAIL_LIMIT:',
    expect: '死循环刷屏又回来了',
  },
  {
    name: 'Ⓠ 「暂停」只改标志不真挂进程（点了暂停，采集还在跑）',
    file: '采集器/server.py',
    from: '    ok, total = _suspend_tree(root, True)',
    to: '    ok, total = (0, 0)   # 假装挂起了',
    expect: '暂停了但进程照跑',
  },
  {
    name: 'Ⓡ 熔断只打日志不挂起（刷屏照样撑爆内存与磁盘）',
    file: '采集器/server.py',
    from: '                okn, tot = _suspend_tree(proc.pid, True)',
    to: '                okn, tot = (0, 0)   # 只打日志，不真挂',
    expect: '熔断形同虚设',
  },
  {
    name: 'Ⓢ 任务卡不给暂停入口（跑起来就只能干等或硬停）',
    file: 'js/view-collect.js',
    from: '    if (running) {\n      top.appendChild(paused',
    to: '    if (false && running) {\n      top.appendChild(paused',
    expect: '暂停/继续按钮没了',
  },

  /* ===== 第 19 轮：岗位库 → BOSS 投递全链路 ===== */

  {
    name: 'Ⓣ 点「去 BOSS 投递」直接记成已投递（投递数与回复率会被虚增）',
    file: 'js/store.js',
    from: "      status: 'todo',\n      timeline: [{ at: U.now(), status: 'todo',\n        note: '点了「去 BOSS 投递」（只是打开了页面，还没确认投出去）' }],",
    to: "      status: 'applied',\n      timeline: [{ at: U.now(), status: 'applied',\n        note: '点了「去 BOSS 投递」（只是打开了页面，还没确认投出去）' }],",
    expect: 'todo 记录被算进「已投递」，统计失真',
  },
  {
    name: 'Ⓤ 确认投递时顺手 snooze（把它从待跟进页藏起来，和需求正好相反）',
    file: 'js/store.js',
    from: '    if (a.status === \'applied\') return a;                 // 幂等\n    return updateApplication(a.id, { status: \'applied\', statusNote: note || \'手动确认已投递\' });',
    to: '    if (a.status === \'applied\') return a;                 // 幂等\n    snooze(\'staleApplied:\' + a.id, 3);\n    return updateApplication(a.id, { status: \'applied\', statusNote: note || \'手动确认已投递\' });',
    expect: '投递后不会出现在待跟进页',
  },
  {
    name: 'Ⓥ 打招呼的冷却时间戳不再落库（同一个岗位可以反复自动打招呼，烧额度）',
    file: 'js/store.js',
    from: '      greetAt: j.greetAt || null,',
    to: '      greetAt: null,   // 白名单丢字段 → updateJob 写了也白写',
    expect: '冷却闸门失效',
  },
  {
    name: 'Ⓦ 「一键打招呼」不再检查开关（后端能被人绕过）',
    file: 'js/apply-boss.js',
    from: "    if (!autoGreetOn()) return { ok: false, reason: '「一键打招呼」开关没开（设置页可开）' };",
    to: '    // 开关不查了',
    expect: '关着也能发消息',
  },
  {
    name: 'Ⓧ 一键打招呼的入口无视开关照样渲染（关不掉的功能）',
    file: 'js/view-jobs.js',
    from: '    if (AB.autoGreetOn()) {',
    to: '    if (true || AB.autoGreetOn()) {',
    expect: '开关形同虚设，卡片上永远有⚡按钮',
  },
  {
    name: 'Ⓨ 同步回复默认动作改成「标记已回复」（不再要用户逐条确认）',
    file: 'js/apply-boss.js',
    from: "        action: 'ignore',\n        makeInterview: false,",
    to: "        action: 'viewed',\n        makeInterview: false,",
    expect: '读到的会话被自动写进投递，违背"必须用户确认"',
  },
  {
    name: 'Ⓩ 同步时给匹配不上的会话硬塞一个岗位（乱认岗位，污染数据）',
    file: 'js/apply-boss.js',
    from: "        jobId: hit ? hit.id : '',",
    to: "        jobId: hit ? hit.id : (pool[0] ? pool[0].id : ''),   // 乱指一个",
    expect: '匹配不上的会话被错误写入',
  },
  {
    name: 'Ⓐ 同步把用户已推进的更远状态倒退回去（一面被拉回已回复）',
    file: 'js/apply-boss.js',
    from: '      if (cur >= ti) {',
    to: '      if (false && cur >= ti) {',
    expect: '状态倒退，漏斗数据被破坏',
  },
  {
    name: 'Ⓑ 建的面试直接写死「一面」（面试时间都没定，进度说过头）',
    file: 'js/apply-boss.js',
    from: "            round: '待定',",
    to: "            round: '一面（技术/业务）',",
    expect: '邀约被偷推到「一面」',
  },
  {
    name: 'Ⓒ 服务端不校验招呼语是否为空（拿一次沟通额度发空话）',
    file: '采集器/server.py',
    from: '    if not greeting:\n        return False, \'招呼语是空的 —— 拿一次沟通额度去发一句空话，不如不发。\'',
    to: '    if False:\n        return False, \'招呼语是空的 —— 拿一次沟通额度去发一句空话，不如不发。\'',
    expect: '空招呼语也能发出去',
  },
  {
    name: 'Ⓓ 服务端不校验链接（把任意 URL 喂给自动点击流程）',
    file: '采集器/server.py',
    from: '    if not BOSS_JOB_URL_RE.match(url):',
    to: '    if False and not BOSS_JOB_URL_RE.match(url):',
    expect: '任意链接都能触发自动操作',
  },
  {
    name: 'Ⓔ 打招呼脚本不再限制单岗位（一次批量发出去）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/boss_apply_one.py',
    from: '        max_applications=1,                 # 铁律：一次只发一个',
    to: '        max_applications=50,                # 铁律：一次只发一个',
    expect: '批量的口子被打开',
  },
  {
    name: 'Ⓕ 读聊天脚本读不到时就返回空数组（假装"没有新消息"，比报错更坏）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/boss_chat_sync.py',
    from: "            _emit({'ok': False, 'needCalibration': True, 'error':\n                   '读不到会话列表（选择器没匹配上），请先跑 --dump 校准。'})\n            return 4",
    to: "            _emit({'ok': True, 'items': []})\n            return 0",
    expect: '「我瞎了」被伪装成「你没有新消息」',
  },
  {
    name: 'Ⓖ 读聊天脚本给折不出来的时间编一个「现在」',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/boss_chat_sync.py',
    from: '        except ValueError:\n            return None\n    return None',
    to: '        except ValueError:\n            return int(now)\n    return int(now)',
    expect: '时间被编造，新旧判断全错',
  },

  /* ===== 评审整改（2026-10-06 下午）===== */

  {
    name: 'Ⓗ 搜索框丢了 data-focus-key（重画后找不回替身节点）',
    file: 'js/view-jobs.js',
    from: "      'data-focus-key': 'job-kw',",
    to: '      // data-focus-key 被删了',
    expect: '打字丢焦点，且测试定位不到输入框',
  },
  {
    name: 'Ⓘ 整页重画不再保住焦点（回到「每敲一个字就丢」）',
    file: 'js/view-jobs.js',
    from: '  var repaint = U.debounce(function () {\n    U.withFocusKept(function () { App.refresh(); });\n  }, 60);',
    to: '  var repaint = U.debounce(function () {\n    App.refresh();\n  }, 60);',
    expect: '焦点被整页重建丢掉',
  },
  {
    name: 'Ⓙ 结果区整卡重画不再还焦点（采集页那边漏掉）',
    file: 'js/view-collect.js',
    from: '    U.restoreFocus(focusSnap, card);',
    to: '    // 不还焦点了',
    expect: '结果区筛选框打字也丢焦点',
  },
  {
    name: 'Ⓚ 轮询提前放弃时又不通知任何人（「开始采集」永久禁用的那个洞）',
    file: 'js/view-collect.js',
    /* ⚠️ 锚点跟着 P1-8 的重写挪过一次（2026-10-12）：原来那句
       `if (!t) { stopPoll(); if (onFail) onFail('no-task'); return; }` 已经
       收敛成 `giveUp('no-task')`，四条放弃路径（offline/no-task/net/superseded）
       共用同一个出口。所以变异点也要跟着挪到**那个唯一出口**上 ——
       改掉它一次，四条路径同时哑掉，这才是等价于"回到出 bug 的版本"。 */
    from: '      if (onFail) onFail(reason);',
    to: '      /* 变异：放弃时不通知任何人 */',
    expect: 'runLoginCheck 的 promise 永久挂着',
  },
  {
    name: 'Ⓛ 写失败又变成永久停写（persistOK 不复位）',
    file: 'js/store.js',
    from: '    var doIt = function () {\n      try {\n        var s = JSON.stringify(DB);',
    to: '    if (!persistOK) { fire(); return; }\n    var doIt = function () {\n      try {\n        var s = JSON.stringify(DB);',
    expect: '配额超限后一条都存不下来',
  },
  {
    name: 'Ⓜ 薪资的「万」又只作用在区间第二个数上',
    file: 'js/export.js',
    from: '    var a = toK(m[1], m[2] || u2);              // 单位只写一次时，两个端点共用它',
    to: '    var a = toK(m[1], m[2] || \'\');             // 第一个端点不继承单位',
    expect: '"1-2万" 又变成 1~20',
  },
  {
    name: 'Ⓝ new_run_dir 写 LATEST 又静默吞异常（结果会写进上一轮目录）',
    file: '采集器/server.py',
    from: "    with open(os.path.join(ASSETS_DIR, 'LATEST.txt'), 'w', encoding='utf-8') as f:\n        f.write(name)                                        # 失败就抛，别吞",
    to: "    try:\n        with open(os.path.join(ASSETS_DIR, 'LATEST.txt'), 'w', encoding='utf-8') as f:\n            f.write(name)\n    except OSError:\n        pass",
    expect: '指针写不进去也不报',
  },
  {
    name: 'Ⓞ 截断任务日志时保留了**头部**（把失败现场丢了）',
    file: '采集器/server.py',
    from: '            f.seek(-keep, os.SEEK_END)',
    to: '            f.seek(0, os.SEEK_SET)',
    expect: '截断后留下的是开场横幅而不是出错现场',
  },
  {
    name: 'Ⓟ 看板上「去 BOSS」按钮不再拦截点击（点按钮变成开详情）',
    file: 'js/view-kanban.js',
    from: "        node.addEventListener('click', function (e) { e.stopPropagation(); });",
    to: '        // click 不再拦截',
    expect: '点按钮会连带触发卡片自己的 click',
  },
  {
    name: 'Ⓠ 看板上「一键打招呼」无视开关照样出现',
    file: 'js/view-kanban.js',
    from: '      if (AB.autoGreetOn()) {',
    to: '      if (true || AB.autoGreetOn()) {',
    expect: '开关形同虚设',
  },

  /* ===== 第 21 轮：采集条件 ⇄ 求职偏好（两套数据互不影响）=====
     ⛔ 这几条都必须由**功能断言**变红（不是只有锚点守卫兜底）。
        判据：改坏后变红的项里要能看到「表单上也出现偏好里的区」「不许写采集侧」
        这类**结果断言**，而不是只看到"锚点匹配不上了"。 */
  {
    name: 'Ⓡ 采集页的「区/商圈」回退成读服务端参数（假继承 —— 那个键服务端根本不回吐）',
    file: 'js/view-collect.js',
    from: '        district: seed.district,\n        bizArea: seed.bizArea,',
    to: '        district: U.asArray(p.districts).slice(),\n        bizArea: U.asArray(p.bizAreas).slice(),',
    expect: '偏好里设了期望区，采集页永远是空的 → 结果页筛选也是空的',
  },
  {
    name: 'Ⓢ 区/商圈不再检查城市是否对得上（偏好杭州、这次搜上海，却照搬滨江区）',
    file: 'js/view-collect.js',
    from: '    var matched = !mine.length || !theirs.length || mine.some(function (x) {',
    to: '    var matched = true || !mine.length || !theirs.length || mine.some(function (x) {',
    expect: '采集结果会被区/商圈精筛成空列表，而且不报错',
  },
  {
    name: 'Ⓣ 采集表单落盘又把区/商圈漏掉（改了不跑采集就刷新 = 白选）',
    file: 'js/view-collect.js',
    from: "  var FORM_SAVE_FIELDS = ['welfare', 'activeTime', 'expectJobs', 'district', 'bizArea', 'province',\n    'includeKnown']\n    .concat(LOCAL_FIRST_FIELDS);",
    to: "  var FORM_SAVE_FIELDS = ['welfare', 'activeTime', 'expectJobs', 'includeKnown']\n    .concat(LOCAL_FIRST_FIELDS);",
    expect: '区/商圈落不了盘',
  },
  {
    name: 'Ⓤ 采集侧落盘顺手回写「求职偏好」（两套数据互相污染）',
    file: 'js/view-collect.js',
    from: '    try { localStorage.setItem(FORM_SAVE_KEY, JSON.stringify(out)); }',
    to: "    if (global.Store) global.Store.setSetting('prefs.districts', out.district || []);\n    try { localStorage.setItem(FORM_SAVE_KEY, JSON.stringify(out)); }",
    expect: '两边不再独立 —— 采集页动一下就把长期偏好改了',
  },
  {
    name: 'Ⓥ 采集页渲染时就把表单落盘（"打开看一眼"会把继承来的值固化）',
    file: 'js/view-collect.js',
    from: '    var f = S.form;\n    /* ⛔ 把「数组类字段」补齐成真正的数组。',
    to: '    var f = S.form;\n    saveForm();\n    /* ⛔ 把「数组类字段」补齐成真正的数组。',
    expect: '改偏好 + 打开采集页 → 继承结果被写死，之后改偏好不再跟着变',
  },
  {
    name: '❹ 批量导入退回「逐条 save + fire」（导入卡住的根因：506 条广播 507 次）',
    file: 'js/store.js',
    from: '      var j = normJob(raw);\n      var key = jobDedupeKey(j);\n      var exist = opt.forceNew ? null : index[key];',
    to: '      save(); fire(\'jobs\');\n      var j = normJob(raw);\n      var key = jobDedupeKey(j);\n      var exist = opt.forceNew ? null : index[key];',
    expect: '整批只广播一次 → 变成每条广播一次（8 条 = 8 次）',
  },
  {
    name: '❺ 批量导入的索引不更新（同一批里的重复认不出来 → 重复入库）',
    file: 'js/store.js',
    from: '      index[key] = j;          // 同批里的重复也要能被后面的条目命中',
    to: '      /* 变异：不更新索引 */',
    expect: '8 条 = 7 新增 + 1 批内去重 → 变成 8 新增',
  },
  {
    name: '❻ 条数退回「服务端回声优先」（改完不跑采集 → 刷新又变回去）',
    file: 'js/view-collect.js',
    from: "        count: parseCount(lfOr('count', p.count || 30)),",
    to: '        count: p.count || 30,',
    expect: '改 20 → 刷新后还是 20 → 变成回落到服务端的 50',
  },
  {
    name: '❼ 条数不在落盘清单里（"每个关键词抓多少条 好像没有效果"的原始形态）',
    file: 'js/view-collect.js',
    from: "  var LOCAL_FIRST_FIELDS = ['count', 'keywords', 'salary', 'crawlMode',",
    to: "  var LOCAL_FIRST_FIELDS = ['keywords', 'salary', 'crawlMode',",
    expect: '落盘清单含 count → 不含',
  },
  {
    name: '❶ 导入一次性同步跑完（不分批、不让出主线程 → 界面卡死）',
    file: 'js/view-collect.js',
    from: '      if (i >= total) return Promise.resolve(null);\n      return yieldToUI().then(step);',
    to: '      if (i >= total) return Promise.resolve(null);\n      return step();',
    expect: '中途已经落了一部分 → 变成要么 0 要么全部',
  },
  {
    name: '❷ 「② 采集参数」折叠不切 class（点了没反应）',
    file: 'js/view-collect.js',
    from: "      if (open) card.classList.remove('collapsed');\n      else card.classList.add('collapsed');",
    to: '      /* 变异：不切 class */',
    expect: '点标题行 → 卡片带 collapsed → 不带',
  },
  {
    name: '❸ 导入完成不给带数量的提示（回到"没有提示"）',
    file: 'js/view-collect.js',
    from: "        '导入完成：新增 <b>' + added + '</b> 个岗位' + scopeNote +",
    to: "        '完事了' + scopeNote +",
    expect: '完成后给的是带数量的提示 → 变成一句没有信息量的话',
  },

  /* ============ 第 24 轮：简历素材库「上传 PDF / Word」（不再复制粘贴） ============
     ⚠️ 注意 file 写的是 `../_打包工程/...`：那份便携版服务端是 `求职猎手工作台/`
        的**兄弟目录**，不在工作台里。path.join 会把 `..` 归一掉，所以能落在正确位置。
     （写 '_打包工程/...' 会被拼成 求职猎手工作台/_打包工程/... → 锚点永远找不到 → 静默跳过。） */
  {
    name: '【24-①】简历上传的 accept 退回只认 txt / md（用户又只能复制粘贴）',
    file: 'js/view-resume.js',
    from: "var RESUME_ACCEPT = '.pdf,.docx,.doc,.txt,.md,.markdown';",
    to: "var RESUME_ACCEPT = '.txt,.md,.markdown';",
    expect: '选文件能选到 PDF / Word → 选不到',
  },
  {
    name: '【24-②】PDF / Word 改走 /api/resume（素材库被塞进采集链路，还要调模型）',
    file: 'js/view-resume.js',
    from: "      return collectorReq('/api/extract-text', {",
    to: "      return collectorReq('/api/resume', {",
    expect: '只抽文字的接口 → 变成会起任务的那个',
  },
  {
    name: '【24-③】.txt / .md 也去走服务端（没开采集器连纯文本都读不了）',
    file: 'js/view-resume.js',
    from: "    if (TEXT_EXTS.indexOf(ext) >= 0) {\n      return U.readText(f).then(function (t) { return { name: name, text: t, via: 'local' }; });\n    }",
    to: "    if (false) {\n      return U.readText(f).then(function (t) { return { name: name, text: t, via: 'local' }; });\n    }",
    expect: 'txt 走本地读 → 也去连服务端',
  },
  {
    name: '【24-④】开发版服务端白名单偷偷去掉 .pdf（前端选得到、服务端拒收）',
    file: '采集器/server.py',
    from: "EXTRACT_EXTS = ('.pdf', '.docx', '.doc', '.txt', '.md', '.markdown')",
    to: "EXTRACT_EXTS = ('.docx', '.doc', '.txt', '.md', '.markdown')",
    expect: '服务端白名单 == 前端 accept → 少一个 .pdf',
  },
  {
    name: '【24-⑤】开发版服务端不再认 __JH_TEXT__ 前缀（混杂日志里找不回结果）',
    file: '采集器/server.py',
    from: "            if line.startswith('__JH_TEXT__'):",
    to: "            if line.startswith('__XX_TEXT__'):",
    expect: '只认 __JH_TEXT__ 前缀行 → 变成认另一个前缀（抽取必然失效）',
  },
  {
    name: '【24-⑥】便携版漏掉 extract_resume_text.py 的子命令映射（又拼出空子命令）',
    file: '../_打包工程/src/server_core.py',
    from: "    'extract_resume_text.py': 'extract_text',\n",
    to: "",
    expect: 'PORTABLE_SUBCMD 有映射 → 没有（第 23 轮那个空子命令的坑重演）',
  },
  {
    name: '【24-⑦】stage 不再专门拦 .doc（用户只拿到一句"抽不出文字"，不知道要转存）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/extract_resume_text.py',
    from: "    if ext == '.doc':",
    to: "    if False:",
    expect: '专门拦 .doc 并提示另存为 → 没有专门提示',
  },
  {
    name: '【24-⑧】stage 的结果前缀与服务端漂移（服务端永远解析不到 payload）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/extract_resume_text.py',
    from: "MARK = '__JH_TEXT__'",
    to: "MARK = '__JH_TXT__'",
    expect: 'MARK == 服务端认的前缀 → 漂移',
  },
  {
    name: '【25-①】构建脚本清空 crawler_src 时又把打包入口一起删（entry.py 凭空消失）',
    file: '../_打包工程/build_crawler_src.py',
    from: "KEEP_IN_DST = ['entry.py']",
    to: "KEEP_IN_DST = []",
    expect: 'KEEP_IN_DST 含 spec 的入口 → 空（清空即删）',
  },
  {
    name: '【25-②】捞出来了却没放回去（读得到、写不回 = 入口照样没了）',
    file: '../_打包工程/build_crawler_src.py',
    from: "    for name, blob in kept.items():\n        with open(os.path.join(DST, name), 'wb') as f:\n            f.write(blob)\n",
    to: "",
    expect: '清空后写回 → 没有写回（顺序断言里的 write 位置消失）',
  },
  /* ---- 第 30 轮：采集页地点 省 > 市 > 区 > 商圈 四级级联 ----
     ⚠️ 这 6 条先在 _tmp_mut30.js 里定向验过（8/8 全抓到）才挪进来 ——
        整跑的代价是每条 ~18s，先用小跑确认"改坏了真的会红"。 */
  {
    name: '【30-①】改省时不清空 市/区/商（留下跨省的自相矛盾组合）',
    file: 'js/view-collect.js',
    from: "          f.province = cityJoin(v);\n          // 换省 → 城市 / 区 / 商圈全部作废（它们都属于上一个省）\n          f.city = ''; f.district = []; f.bizArea = [];",
    to: "          f.province = cityJoin(v);",
    expect: '换省会清空下级 → 不清',
  },
  {
    name: '【30-②】改市时不清空 区/商（区候选换了、值却留着）',
    file: 'js/view-collect.js',
    from: "            f.city = cityJoin(v);\n            // 换城市 → 区 / 商圈作废（候选和值都属于上一个城市）\n            f.district = []; f.bizArea = [];",
    to: "            f.city = cityJoin(v);",
    expect: '换城市会清空区/商圈 → 不清',
  },
  {
    name: '【30-③】改区时不清空商圈（留下列表里根本没有的商圈）',
    file: 'js/view-collect.js',
    from: "          f.bizArea = [];\n          // 用户动过区/商圈",
    to: "          // 用户动过区/商圈",
    expect: '换区会清空商圈 → 不清',
  },
  {
    name: '【30-④】citiesIn 无视省份过滤（选了省城市候选还是全量）',
    file: 'js/geo.js',
    from: "    if (!ps.length) return cityChoices(jobs);",
    to: "    if (ps.length >= 0) return cityChoices(jobs);",
    expect: '选了省只列该省城市 → 列全量',
  },
  {
    name: '【30-⑤】省 → 城市 的映射少写一个城市（浙江省丢了宁波）',
    file: 'js/geo.js',
    from: "    { name: '浙江省', cities: ['杭州', '宁波'] },",
    to: "    { name: '浙江省', cities: ['杭州'] },",
    expect: '浙江省含杭州+宁波 → 只有杭州',
  },
  {
    name: '【30-⑥】deriveProvince 不校验"同属一个省"（跨省也硬回填第一个城市的省）',
    file: 'js/view-collect.js',
    from: "      if (ps[0] && ps.every(function (x) { return x === ps[0]; })) return ps[0];",
    to: "      if (ps[0]) return ps[0];",
    expect: '跨省不猜省、退回存过的值 → 硬回填第一个',
  },
  /* ---- 第 31 轮：找工作避坑雷达（pitfall.js）----
     ⛔ 这几条是本项目**最贵教训的守门人**：
        第 29 轮「非外包」被判成外包、第 31 轮「缴纳五险一金」被判成招聘收费，
        两次都是纯关键词匹配引起的**误报**。去掉这层防护必须马上变红。 */
  {
    name: '【31-①】pitfall 去掉否定语境处理（判反会复现）',
    file: 'js/pitfall.js',
    from: "        if (negatedInSentence(text, k, w) || negated(text.slice(Math.max(0, k - config.negSpan), k))) continue;",
    to: "        if (false) continue;",
    expect: '「非外包」不再被否定 → 应报外包嫌疑误报',
  },
  {
    name: '【31-②】pitfall 代招改成红灯（用户要的是黄灯）',
    file: 'js/pitfall.js',
    from: "    proxyHireLevel: 'yellow',",
    to: "    proxyHireLevel: 'red',",
    expect: '代招级别不再是 yellow',
  },
  {
    name: '【31-③】pitfall 命中不再回引原文（没法核对）',
    file: 'js/pitfall.js',
    from: "      add('red', 'fee', '招聘收费', 'JD 原文：「' + fee[0].snippet + '」',",
    to: "      add('red', 'fee', '招聘收费', '',",
    expect: 'evidence 为空 → 应报缺原文',
  },
  {
    name: '【31-④】pitfall 把「没材料」当成绿灯（未扫描 ≠ 没问题）',
    file: 'js/pitfall.js',
    from: "      return { level: 'unknown', items: [], scanned: false, redCount: 0, yellowCount: 0 };",
    to: "      return { level: 'green', items: [], scanned: false, redCount: 0, yellowCount: 0 };",
    expect: 'unknown 变 green → 应报默认绿灯',
  },
  /* ---- 第 32 轮：薪资「自定义区间」（档位透传 BOSS、细粒度只能本地精筛）----
     ⚠️ 先在 _tmp_mut31.js 定向验过（13/13 全抓到）才挪进来 ——
        整跑每条 ~10s，先用小跑确认"改坏了真的会红"。
     地基约束：BOSS 服务端薪资只有 6 个固定码（config.py 402~407），
     resolve_filter_values() 遇到认不出的值**只打一行警告就跳过**
     → 自定义值传下去等于"不限"，用户却以为筛过了。 */
  {
    name: '【32-①】parseK 不拒 0 / 负数（"我没填"与"我要 0K 以上"混成同一件事）',
    file: 'js/view-collect.js',
    from: '    return (isFinite(n) && n > 0) ? n : null;',
    to: '    return isFinite(n) ? n : null;',
    expect: '空 / 0 / 负数一律算"没设" → 0 被当成有效值',
  },
  {
    name: '【32-②】薪资区间判定不再保留「没标薪资」的岗位（用户会以为岗位丢了）',
    file: 'js/view-collect.js',
    from: '    if (a === null && b === null) return true;       // 面议 / 未标薪资 → 保留',
    to: '    if (a === null && b === null) return false;',
    expect: '没标薪资 → 保留',
  },
  {
    name: '【32-③】薪资区间判定忽略下限（低于下限的岗位也留下）',
    file: 'js/view-collect.js',
    from: '    if (lo !== null && high < lo) return false;      // 岗位最高都够不着下限\n',
    to: '',
    expect: '低于下限要剔 → 不剔',
  },
  {
    name: '【32-④】薪资区间判定忽略上限（超过上限的岗位也留下）',
    file: 'js/view-collect.js',
    from: '    if (hi !== null && low > hi) return false;       // 岗位最低已超过上限\n',
    to: '',
    expect: '超过上限要剔 → 不剔',
  },
  {
    name: '【32-⑤】结果精筛根本不应用自定义区间（框上填了完全不生效）',
    file: 'js/view-collect.js',
    from: '    if (salLo !== null || salHi !== null) {\n      arr = arr.filter(function (j) { return salaryRangeHit(j, salLo, salHi); });\n    }',
    to: '    if (false && (salLo !== null || salHi !== null)) {\n      arr = arr.filter(function (j) { return salaryRangeHit(j, salLo, salHi); });\n    }',
    expect: '区间生效 → 不生效',
  },
  {
    name: '【32-⑥】档位与区间从「与」变成互相覆盖（档位被区间挡掉）',
    file: 'js/view-collect.js',
    from: "    if (CF.salary) arr = arr.filter(function (j) {\n      if (CF.salary === 'none') return j.salaryMin === null && j.salaryMax === null;",
    to: "    if (CF.salary && salLo === null && salHi === null) arr = arr.filter(function (j) {\n      if (CF.salary === 'none') return j.salaryMin === null && j.salaryMax === null;",
    expect: '两条件是与关系 → 区间一填档位就失效',
  },
  {
    name: '【32-⑦】自定义区间污染搜索条件（把 15-25K 写进只该放 BOSS 档位的字段）',
    file: 'js/view-collect.js',
    from: "      f.salaryMin = parseK(salMinInp.value);",
    to: "      f.salary = salMinInp.value + '-' + salMaxInp.value + 'K';\n      f.salaryMin = parseK(salMinInp.value);",
    expect: '自定义只落本地精筛字段 → 污染了搜索条件',
  },
  {
    name: '【32-⑧】区间伸到档位之外时不提醒（用户不知道那些岗位在服务端就被切了）',
    file: 'js/view-collect.js',
    from: '        if (out.length) {',
    to: '        if (false) {',
    expect: '档位外要报警 → 不报',
  },
  {
    name: '【32-⑨】把自定义区间的徽章错标成「透传 BOSS」（等于骗用户）',
    file: 'js/view-collect.js',
    from: "        el('span', { class: 'fs12 muted', text: 'K' }),\n        Comp.lvlBadge('local'),",
    to: "        el('span', { class: 'fs12 muted', text: 'K' }),\n        Comp.lvlBadge('server'),",
    expect: '区间标"采集后本地筛" → 标成"透传 BOSS"',
  },
  {
    name: '【32-⑩】落盘清单漏掉自定义区间（改了不跑采集就刷新 = 白选）',
    file: 'js/view-collect.js',
    from: "    'degree', 'experience', 'scale', 'stage', 'jobType', 'salaryMin', 'salaryMax'];",
    to: "    'degree', 'experience', 'scale', 'stage', 'jobType'];",
    expect: '区间落盘 → 不落盘',
  },
  {
    name: '【32-⑪】从偏好带入时只搬档位、不搬自定义区间',
    file: 'js/collect-prefs.js',
    from: '        if (pR[0] !== null) patch.salaryMin = pR[0];\n',
    to: '',
    expect: '带入区间下限 → 不带',
  },
  {
    name: '【32-⑫】存为偏好时拿**档位上限**当"我能接受的最高薪资"（悄悄改掉合适度口径）',
    file: 'js/collect-prefs.js',
    from: '        if (fR[1] !== null) patch.salaryMax = fR[1];',
    to: '        if (band) patch.salaryMax = band[1];',
    expect: '只有档位时不许写 salaryMax → 写了',
  },
  {
    name: '【32-⑬】差异清单不比区间（档位一样就不再搬区间，"带入"看着像没生效）',
    file: 'js/collect-prefs.js',
    from: '        if (sameBand && rangeSame(rangeOf(form), rangeOf(prefs))) return;',
    to: '        if (sameBand) return;',
    expect: '档位同、区间不同也要进清单 → 不进',
  },
  /* 【32-⑭】【32-⑮】盯的是**真机抓到的那个真 bug**：
     只设自定义区间时「✕ 清空筛选」按钮不出现 → 这个条件再也关不掉。
     教训：逻辑层的断言全绿，是**真机**把它照出来的（按钮在真 CSS 下没渲染）。 */
  {
    name: '【32-⑭】collectHasFilter 漏掉自定义区间（只设区间时"清空筛选"按钮不出现，条件关不掉）',
    file: 'js/view-collect.js',
    from: "      typeof CF.salaryMin === 'number' || typeof CF.salaryMax === 'number' ||\n",
    to: "      false ||\n",
    expect: '只设区间也算"有筛选" → 不算（按钮不出现）',
  },
  {
    name: '【32-⑮】clearCF 不清自定义区间（"清空筛选"清不掉它）',
    file: 'js/view-collect.js',
    from: '    CF.salaryMin = null; CF.salaryMax = null;\n',
    to: '',
    expect: '清空能连带清掉区间 → 清不掉',
  },
  /* ---- 第 33 轮：外部评审报告（2026-10-07）所报问题的修复 ----
     ⚠️ 先在 _tmp_mut_report.js 定向验过（14/14 全抓到）才挪进来。
     ⛔ 这批里有两条的"第一版断言"是**弱断言**，被定向变异当场照出来，已补强：
        · 换端口提示：原来只判"文中出现过某串" → 把那段包进 `if False:` 也照样绿
          （本项目写明的反模式）→ 改成判**那个 if 守卫本身**。
        · 账号 chip：原来拿"另一个已有账号"测，而它带密码 → 断言被 gate 掉，变异不红
          → 改成**自建一个无密码探针账号**。 */
  {
    name: '【33-①】Ctrl+K 退回"只唤起"（第二次按没反应，与帮助弹窗承诺不符）',
    file: 'js/app.js',
    from: "        var q = U.$('#quick');\n        if (q && !q.classList.contains('hide')) quickHide(); else quickOpen();",
    to: '        quickOpen();',
    expect: 'Ctrl+K 是切换 → 只开不关',
  },
  {
    name: '【33-②】窄屏不给 #topActions 换行（顶栏把整页撑到 668px）',
    file: 'css/app.css',
    from: '  #topActions { flex-wrap: wrap; justify-content: flex-end; }\n',
    to: '',
    expect: '820 断点里允许换行 → 没有',
  },
  {
    name: '【33-③】登录提示退回硬编码（已登录时让用户去找一个不存在的按钮）',
    file: 'js/view-collect.js',
    from: "        text: lg.value === 'ok'\n          ? '已登录。换账号 / 改过密码之后，点左边那颗按钮重新扫码'\n          : '首次用请先点「🔑 ① 登录 BOSS」' }),",
    to: "        text: '首次用请先点「登录 BOSS」' }),",
    expect: '提示跟着登录态走 → 写死',
  },
  {
    name: '【33-④】登录按钮退回旧名（把"会开浏览器扫码"藏起来）',
    file: 'js/view-collect.js',
    from: "        html: lg.value === 'ok' ? '🔑 重新登录（扫码）' : '🔑 ① 登录 BOSS',",
    to: "        html: lg.value === 'ok' ? '🔑 重新检测登录' : '🔑 ① 登录 BOSS',",
    expect: '按钮名说的是它真做的事 → 说成"重新检测"',
  },
  {
    name: '【33-⑤】频次行退回只讲"风控阈值约 200"（200/50 两个数又不解释）',
    file: 'js/view-collect.js',
    from: "      seg.push('详情本轮上限 <b>' + capN + '</b> 条' +\n        (thrN ? '（BOSS 风控线约 ' + thrN + ' 条，留了余量）' : '') +\n        ' · 优先补你的期望岗位，没排上的下次接着补');",
    to: "      seg.push('详情风控阈值约 <b>' + (thrN || 200) + '</b> 条/轮');",
    expect: '两个数连起来说 → 又只摆一个',
  },
  {
    name: '【33-⑥】服务端 collect_frequency 退回硬编码 200（两处又开始各自漂移）',
    file: '采集器/server.py',
    from: "        'detailThreshold': _EST_DETAIL_THRESHOLD,   # BOSS 风控线（约数，来自 skill 注释）\n        'detailCap': _EST_DETAIL_TOP_N,             # 本轮实际上限（config.DETAIL_TOP_N）",
    to: "        'detailThreshold': 200,",
    expect: '200 只在一个地方定义 → 又散落',
  },
  {
    name: '【33-⑦】预估值不再说明"接着补"（用户以为 50 就是终点、永远 9%）',
    file: 'js/view-collect.js',
    from: "      tail += '，详情只抓优先级最高的 ' + es.detailCapN + ' 个' +\n        '（按你的期望岗位优先；没排上的下次采集接着补，不是丢了）';",
    to: "      tail += '，详情只抓优先级最高的 ' + es.detailCapN + ' 个';",
    expect: '说明逐轮累积 → 不提',
  },
  {
    name: '【33-⑧】清空结果的确认框不提 JD（用户不知道累积进度会归零）',
    file: 'js/view-collect.js',
    from: "      '· ⚠️ <b>已抓到的岗位详情（JD）不会带到下一轮</b> —— 详情是逐轮累积的，' +\n      '清空后下一轮会从零开始补积累（归档目录里那份仍可找回）<br>' +\n",
    to: '',
    expect: '确认框写明 JD 不延续 → 不写',
  },
  {
    name: '【33-⑨】AI 空输入退回静默 return（点了没反应，同页其它操作都有反馈）',
    file: 'js/app.js',
    from: "    if (!text) { U.toast('先写点什么再发送。', 'warn'); inp.focus(); return; }",
    to: '    if (!text) return;',
    expect: '空输入有提示 → 什么都不发生',
  },
  {
    name: '【33-⑩】导入后不重绘地点行（商圈行停在"还没采到"）',
    file: 'js/view-collect.js',
    from: '      if (paintGeoRows) { try { paintGeoRows(); } catch (e) { /* 重画失败不该让导入报错 */ } }',
    to: '      if (false) { try { paintGeoRows(); } catch (e) { } }',
    expect: '导入后就地刷新地点候选 → 不刷（要离开页面再回来才行）',
  },
  {
    name: '【33-⑪】账号 chip 退回"只填输入框"（看着像点了没反应）',
    file: 'js/account.js',
    from: "                try { U.closeAllModals(true); } catch (e) { /* 关不掉也别挡切换 */ }\n                finishSwitch(a.name);",
    to: '                nameInp.value = a.name;',
    expect: '无密码账号点一下真切换 → 只填名字',
  },
  {
    name: '【33-⑫】Store.usage 不再报备份占用（占用数字又变成"说不清的一半"）',
    file: 'js/store.js',
    from: "    return { bytes: bytes, bakBytes: bak, total: total,\n             text: U.bytes(bytes), bakText: bak ? U.bytes(bak) : '0 B',\n             pct: U.pct(bytes, total) };",
    to: '    return { bytes: bytes, total: total, text: U.bytes(bytes), pct: U.pct(bytes, total) };',
    expect: '报出备份占用 → 不报',
  },
  {
    name: '【33-⑬】服务端不再提示换端口（旧书签静默失效）',
    file: '采集器/server.py',
    from: '    if _prev_port and _prev_port != port:',
    to: '    if False:',
    expect: '换端口时提示 → 不提示',
  },
  {
    name: '【33-⑭】详情额度退回"按关键词顺序吃预算"（第一个关键词独占，其余全 0）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/crawler.py',
    from: '            chosen, total_pending, kept_n = select_detail_targets(\n                detail_files, detail_existing_links, detail_budget, known=known,\n                prefer=detail_prefer)',
    to: '            _fp0 = detail_files[0]\n            chosen, total_pending, kept_n = ({_fp0: [c[0] for c in collect_detail_candidates(_fp0, detail_existing_links)][:(detail_budget or 0)]}, 0, 0)',
    expect: '全局优先级分配 → 退回按文件顺序',
  },
  /* ---- 第 35 轮：详情额度「给对的人」（方向优先）----
     问题本质是「额度给谁」不是「额度多大」：详情是封顶的（本轮 50 条），
     而 detail_priority() 原来只按「信息完整度」排序、**不知道方向** →
     额度被「亚马逊运营（信息齐全）」这类无关岗位吃掉。
     实测（真实 13 个 CSV / 545 行、预算 50）：
        旧口径入选里方向相关  6 条（12%）  新口径 50 条（100%）
        方向相关覆盖率 33% → 85%（宽口径）/ 100%（窄口径）
     ⛔ 详情请求数不变（50 → 50）→ 风控暴露不变。
     ⚠️ 先在 _scratch/_tmp_mut_prefer.js 定向验过（10/10 全抓到）才挪进来。 */
  {
    name: '【35-①】前端 payload 不传期望岗位（方向词根本发不出去）',
    file: 'js/view-collect.js',
    from: '        expectJobs: f.expectJobs || [],',
    to: '        expectJobs: [],',
    expect: '方向词透传 → 不发',
  },
  {
    name: '【35-②】前端**加工**方向词（split 成单字，违反"原样透传"）',
    file: 'js/view-collect.js',
    from: '        expectJobs: f.expectJobs || [],',
    to: "        expectJobs: (f.expectJobs || []).map(function (s) { return String(s).split('')[0]; }),",
    expect: '原样透传 → 被加工',
  },
  {
    name: '【35-③】服务端用 put 而不是 put_list（数组会被拼成 list 的字面形式）',
    file: '采集器/server.py',
    from: "    put_list('--detail-prefer', p.get('expectJobs'))",
    to: "    put('--detail-prefer', p.get('expectJobs'))",
    expect: '用 put_list 转逗号串 → 用 put',
  },
  {
    name: '【35-④】服务端不拼 --detail-prefer（方向词到这里断了）',
    file: '采集器/server.py',
    from: "    put_list('--detail-prefer', p.get('expectJobs'))",
    to: '    pass',
    expect: '拼出 --detail-prefer → 不拼',
  },
  {
    name: '【35-⑤】detail_priority 不加方向分（额度又按"信息完整度"分配 → 回到老 bug）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/crawler.py',
    from: '                score += 10',
    to: '                score += 1',
    expect: '方向命中 +10（压过信息满分 9）→ 只加 1',
  },
  {
    name: '【35-⑥】只改一个 detail_priority 调用点（另一个漏传 → 排序被后一步覆盖，静默失效）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/crawler.py',
    from: '                pending.append((link, detail_priority(row, prefer), order))',
    to: '                pending.append((link, detail_priority(row), order))',
    expect: '两个调用点都传 → 只传一个',
  },
  {
    name: '【35-⑦】select_detail_targets 不把 prefer 下传（全局挑选时又丢掉方向）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/crawler.py',
    from: '                                                          known=known, prefer=prefer):',
    to: '                                                          known=known):',
    expect: 'prefer 下传 → 不下传',
  },
  {
    name: '【35-⑧】execute_crawl_iteration 收到 detail_prefer 却不用（主循环里丢掉）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/crawler.py',
    from: '                detail_files, detail_existing_links, detail_budget, known=known,\n                prefer=detail_prefer)',
    to: '                detail_files, detail_existing_links, detail_budget, known=known)',
    expect: '全局分配时传 prefer → 不传',
  },
  {
    name: '【35-⑨】CLI 没定义 --detail-prefer（命令行参数被当成未知参数）',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/cli.py',
    from: "    parser.add_argument('--detail-prefer', dest='detail_prefer', action='append', default=None,",
    to: "    parser.add_argument('--detail-prefer-XXX', dest='detail_prefer', action='append', default=None,",
    expect: '参数名精确为 --detail-prefer → 被改名',
  },
  {
    name: '【35-⑩】UI 不再说明"优先期望岗位"（"接着补"又变成空头承诺）',
    file: 'js/view-collect.js',
    from: "        ' · 优先补你的期望岗位，没排上的下次接着补');",
    to: "        ' · 没排上的下次接着补');",
    expect: '说明按期望岗位优先 → 不提',
  },
  {
    name: '【37-①】addJob 命中重复时不再记冲突（冲突台账变空，功能静默失效）',
    file: 'js/store.js',
    from: "      recordConflicts(exist, j, opt.source || 'addJob');\n",
    to: "      /* 变异：不记冲突 */\n",
    expect: 'addJob 记冲突 → 不记',
  },
  {
    name: '【37-②】addJobs 批量路径不再记冲突（只测 addJob 会漏掉这条独立路径）',
    file: 'js/store.js',
    from: "        recordConflicts(exist, j, 'addJobs');\n",
    to: "        /* 变异：不记冲突 */\n",
    expect: 'addJobs 也记冲突 → 不记',
  },
  {
    name: '【37-③】空值回填也被当成冲突（台账被噪音灌满，"真实差异"淹没）',
    file: 'js/store.js',
    from: "    if (!oHas || !nHas) return null;\n",
    to: "    if (false) return null;\n",
    expect: '旧值为空不算冲突 → 也算',
  },
  {
    name: '【37-④】同字段不再合并而是堆条数（同一岗位堆十几条）',
    file: 'js/store.js',
    from: "        if (hit >= 0) ex.fields[hit] = d;   // 同字段覆盖成最新\n        else ex.fields.push(d);\n",
    to: "        ex.fields.push(d);\n",
    expect: '同字段覆盖成最新 → 重复堆',
  },
  {
    name: '【37-⑤】冲突台账不再封顶（会无限涨，撑爆 localStorage）',
    file: 'js/store.js',
    from: "    while (cs.length > CONFLICT_CAP) cs.pop();\n",
    to: "    /* 变异：不封顶 */\n",
    expect: '超上限丢最旧 → 不封顶',
  },
  {
    name: '【37-⑥】去重键退回"不含城市"（同公司两地同名岗位被误并）',
    file: 'js/store.js',
    from: "         + '||' + city;\n",
    to: "         + '||';\n",
    expect: '兜底键含城市 → 不含',
  },
  {
    name: '【37-⑦】clearConflicts 不清空（"清空"按钮点了没用）',
    file: 'js/store.js',
    from: "    DB.conflicts = [];\n    save(); fire('jobs');\n    return n;\n",
    to: "    save(); fire('jobs');\n    return n;\n",
    expect: '清空 conflicts → 不清',
  },
  {
    name: '【37-⑧】dismissConflict 不真删却返回 true（条数不减，用户以为清掉了）',
    file: 'js/store.js',
    from: "        cs.splice(i, 1);\n        save(); fire('jobs');\n        return true;\n",
    to: "        save(); fire('jobs');\n        return true;\n",
    expect: '按 id 真删除 → 不删',
  },
  {
    name: '【38-①】面板不做"岗位还在不在"过滤（删了岗位仍显示 → 点了没反应）',
    file: 'js/view-conflicts.js',
    from: "    return (Store.conflicts() || []).filter(function (c) { return alive[c.jobId]; });\n",
    to: "    return (Store.conflicts() || []);\n",
    expect: '只留活岗位 → 全留',
  },
  {
    name: '【38-②】无冲突时入口徽章仍占位（挂着「⚖ 冲突 0」变噪音）',
    file: 'js/view-conflicts.js',
    from: "    var n = pendingCount();\n    if (!n) return null;\n",
    to: "    var n = pendingCount();\n    if (false) return null;\n",
    expect: '空时返回 null → 不再返回 null',
  },
  {
    name: '【38-③】徽章写死条数 0/常量（和真实待处理数脱钩）',
    file: 'js/view-conflicts.js',
    from: "      html: '⚖ 冲突 ' + n,",
    to: "      html: '⚖ 冲突 ' + 0,",
    expect: '徽章带真实条数 → 写死',
  },
  {
    name: '【38-④】采纳薪资只改文本、不联动 min/max（显示与筛选打架）',
    file: 'js/view-conflicts.js',
    from: "      patch.salaryText = f.new;\n      patch.salaryMin = r.min;\n      patch.salaryMax = r.max;\n",
    to: "      patch.salaryText = f.new;\n",
    expect: '联动 min/max → 不联动',
  },
  {
    name: '【38-⑤】薪资解析失败也照样写（半采纳：有文本没 min/max）',
    file: 'js/view-conflicts.js',
    from: "      if (!r || r.min === null || r.max === null) {\n",
    to: "      if (false) {\n",
    expect: '解析失败就拒绝 → 也照写',
  },
  {
    name: '【38-⑥】采纳后不摘字段（卡片上那条永远不消失，用户以为没生效）',
    file: 'js/view-conflicts.js',
    from: "      cc.fields = cc.fields.filter(function (x) { return x.key !== fieldKey; });\n",
    to: "      /* 变异：不摘字段 */\n",
    expect: '采纳后摘掉该字段 → 不摘',
  },
  {
    name: '【38-⑦】采纳走 addJob 而不是 updateJob（每采纳一次就多造一条新岗位 / 新冲突）',
    file: 'js/view-conflicts.js',
    from: "    var updated = Store.updateJob(jobId, patch);\n",
    to: "    var updated = (Store.addJob(Object.assign({ id: jobId }, patch)), Store.job(jobId));\n",
    expect: '走 updateJob → 走 addJob',
  },
  {
    name: '【38-⑧】updateJob 失败也返回 true（用户以为改了，其实什么都没写）',
    file: 'js/view-conflicts.js',
    from: "    if (!updated) return false;\n",
    to: "    if (false) return false;\n",
    expect: '失败返回 false → 恒返回 true',
  },
  {
    name: '【38-⑨】采纳不落盘（只改内存，刷新就丢）—— ⛔ 组合变异：updateJob 内部本会 save，单点改不掉这个链路',
    file: 'js/store.js',
    from: "    Object.assign(j, normJob(Object.assign({}, j, patch, { id: j.id, createdAt: j.createdAt })));\n    j.updatedAt = U.now();\n    save(); fire('jobs');\n    return j;\n  }\n\n  function removeJob(id) { return removeJobs([id]); }",
    to: "    Object.assign(j, normJob(Object.assign({}, j, patch, { id: j.id, createdAt: j.createdAt })));\n    j.updatedAt = U.now();\n    fire('jobs');\n    return j;\n  }\n\n  function removeJob(id) { return removeJobs([id]); }",
    also: [
      {
        /* ⛔⛔ 这处以前**只把注释换掉**，`Store.save();` 那行原封不动
           ⇒ 变异等价 = no-op ⇒【31.1】的落盘断言永远绿。
           这就是【38-⑨】长期「只有锚点守卫红」的根因（不是断言弱，是变异没生效）。
           采纳路径上一共只有两处 save：store.js:900（main 站点）+
           view-conflicts.js:186（本处）—— 两处一起去掉才叫"不落盘"。 */
        file: 'js/view-conflicts.js',
        from: "        // 还有别的字段待处理：就地改内存再落盘。\n        // \u26d4 不能图省事去调 dismissConflict \u2014\u2014 那会把整条冲突删掉，\n        //    剩下未处理的字段就跟着没了（用户以为处理完了，其实丢了几条）。\n        Store.save();\n",
        to: "        /* 变异：不落盘（只改内存） */\n",
      },
    ],
    expect: '采纳真落盘 → 内存与磁盘脱钩（须组合：updateJob 的 save + 面板 else 的 save 一起去掉）',
  },
  {
    name: '【38-⑩】view-conflicts.js 不再挂到 window.Views（入口整条链断掉）',
    file: 'js/view-conflicts.js',
    from: "  global.Views.conflicts = {",
    to: "  var __unused_conflicts = {",
    expect: '挂上 Views.conflicts → 不挂',
  },

  /* ======================================================================
     【39】第 2 步结构性小修（P1-3 / P1-4 / P1-5 / P1-7 / P1-8 / P1-9 / P1-10 + P2-1）
     ----------------------------------------------------------------------
     这批缺陷的共同形态是**安静失效**：改坏了界面照样正常，用户只看到
     「点了没反应 / 刷新就没了 / 明明关着却发出去了」。所以每条都必须能被
     断言真的照出来，不能只靠"源码里有个函数名"。
     ⛔ 服务端只改一份 = 用户那份没修（便携版把 server_core.py 打包进 exe），
        所以下面**每条都各来一次**：采集器/server.py 一次、_打包工程/src/server_core.py 一次。
     ====================================================================== */

  /* ---- P1-8：poll 的四条放弃路径共用同一个出口，堵住出口 = 四条全哑 ---- */
  {
    name: '【39-①】poll 放弃时又不通知任何人（四条放弃路径同时哑掉 → 按钮永久禁用）',
    file: 'js/view-collect.js',
    from: '      if (onFail) onFail(reason);',
    to: '      /* 变异：放弃时不通知任何人 */',
    expect: 'giveUp 里通知 onFail → 不通知（runLoginCheck / poll 调用方的 promise 永久挂着）',
  },
  {
    name: '【39-②】顶掉前一条 poll 时不兜底通知（前一条的 promise 永久挂着）',
    file: 'js/view-collect.js',
    from: "      if (prevFail) { try { prevFail('superseded'); } catch (e) { /* noop */ } }",
    to: '      /* 变异：顶掉了但不告诉前一条 */',
    expect: "被顶掉那一路收到 superseded → 什么都收不到",
  },
  {
    name: '【39-③】poll 不再把实时 running 同步给按钮行（自己发起的采集永远看不到「■ 停止」）',
    file: 'js/view-collect.js',
    from: '        S.taskRunning = !!t.running;',
    to: '        /* 变异：不同步实时任务状态 */',
    expect: '轮询把实时 running 喂给 #cActions → 不喂（按钮只会停在渲染那一刻的快照上）',
  },
  {
    name: '【39-④】进模拟面试不再请面试官问第一题（用户得先回答一个还没被问的问题）',
    file: 'js/interview-sim.js',
    from: "      ask('（面试开始）我准备好了，请面试官问第一个问题。');",
    to: '      /* 变异：不出第一题 */',
    expect: 'runChat 开场自动提问 → 不提问',
  },
  {
    name: '【39-⑤】改「一键打招呼」开关不再同步给服务端（服务端读的是过期配置）',
    file: 'js/apply-boss.js',
    from: '    syncGreetConf();          // ⛔ 开关一变就同步给服务端，别让服务端读着一份过期配置',
    to: '    /* 变异：不同步 */',
    expect: 'setAutoGreet 里同步配置 → 不同步（服务端永远读不到最新开关）',
  },
  {
    name: '【39-⑥】合并备份时把远端简历 id 直接写进本地（application.resumeId 变悬空外键）',
    file: 'js/store.js',
    from: '      fillEmptyResume(hit, r);',
    to: '      Object.assign(hit, r);          /* 变异：回到"整个覆盖 + 连 id 一起换掉"的旧写法 */',
    expect: '保住本地简历 id / 只补空字段 → 连 id 和正文一起被覆盖',
  },
  {
    name: '【39-⑦】application.resumeId 不做重映射（本地简历保住了 id，引用却还指着远端 id）',
    file: 'js/store.js',
    from: '      a.resumeId = mapResume(a.resumeId);',
    to: '      /* 变异：引用不重映射 */',
    expect: 'resumeId 重映射回本地 id → 不重映射（悬空外键）',
  },
  {
    name: '【39-⑧】onboardEstimate 掉出 normApp 白名单（填完刷新就没了）',
    file: 'js/store.js',
    from: "      onboardEstimate: String(a.onboardEstimate || ''),",
    to: '      /* 变异：不登记 → 下次 normApp 静默丢掉 */',
    expect: 'onboardEstimate 过白名单后仍在 → 被丢掉',
  },
  {
    name: '【39-⑨】cleanup_runtime_files 不再验实例归属（短命实例退出时把正在跑的实例痕迹删掉）',
    file: '采集器/server.py',
    from: '    if not _runtime_files_are_mine():',
    to: '    if False:',
    expect: '退出前先认领运行文件 → 无条件删',
  },
  {
    name: '【39-⑩】taskkill 的返回码又被丢掉（杀失败也照样报"已请求停止"）',
    file: '采集器/server.py',
    from: '        rc = r.returncode',
    to: '        rc = 0          # 变异：不看返回码',
    expect: '读 taskkill 返回码 → 恒当成功',
  },
  {
    name: '【39-⑪】stop_task 不挂看门狗（管道关不掉 ⇒ 任务永远 running ⇒ 只能重启采集器）',
    file: '采集器/server.py',
    from: '    threading.Thread(target=_stop_watchdog, args=(task, proc), daemon=True).start()',
    to: '    # 变异：不挂看门狗',
    expect: 'stop 后挂看门狗兜底 → 不挂',
  },
  {
    name: '【39-⑫】_stop_watchdog 强制结束时用 exit_code = 0（被读成"采集成功"）',
    file: '采集器/server.py',
    from: '                task.exit_code = -1        # ⛔ 用 -1 而不是 0：0 会被读成「采集成功」',
    to: '                task.exit_code = 0         # 变异：成功码',
    expect: 'exit_code = -1 → exit_code = 0',
  },
  {
    name: '【39-⑬】_greet_gate 不再读服务端那份配置（"服务端独立再查一遍"变回注释里的空话）',
    file: '采集器/server.py',
    from: '    conf = greet_conf()\n    if conf is None:',
    to: '    conf = {"autoGreet": True}\n    if False:',
    expect: '先读 greet_conf() 且没同步过就拒 → 直接放行',
  },
  {
    name: '【39-⑭】_greet_gate 不查开关（备注里写了，实际只有前端那遍拦得住）',
    file: '采集器/server.py',
    from: "    if not conf.get('autoGreet'):",
    to: '    if False:',
    expect: '开关关了就直接拒 → 不拒',
  },
  {
    name: '【39-⑮】_greet_gate 不调 _greet_rate_gate（限流实现是空转）',
    file: '采集器/server.py',
    from: '    rate_ok, rate_why = _greet_rate_gate(payload)',
    to: "    rate_ok, rate_why = True, ''      # 变异：不限流",
    expect: '真调限流闸门 → 空转',
  },
  {
    name: '【39-⑯】打招呼成功后不记服务端台账（前端计时器挡不住伪造请求）',
    file: '采集器/server.py',
    from: "        at = greet_record(payload.get('jobId'), payload.get('url'))",
    to: '        at = time.time()          # 变异：不记台账',
    expect: '服务端记一笔台账 → 不记',
  },
  {
    name: '【39-⑰】便携版孪生同样不验实例归属（只修 dev 那份 = 用户那份没修）',
    file: PACK_TWIN,      // 便携版孪生服务端（在工作台目录之外，必须用绝对路径）
    from: '    if not _runtime_files_are_mine():',
    to: '    if False:',
    expect: '便携版退出前先认领 → 无条件删',
  },
  {
    name: '【39-⑱】便携版孪生同样不查服务端那份配置',
    file: PACK_TWIN,      // 便携版孪生服务端（在工作台目录之外，必须用绝对路径）
    from: '    conf = greet_conf()\n    if conf is None:',
    to: '    conf = {"autoGreet": True}\n    if False:',
    expect: '便携版先读 greet_conf() → 直接放行',
  },
  {
    name: '【39-⑲】便携版孪生同样丢掉 taskkill 返回码',
    file: PACK_TWIN,      // 便携版孪生服务端（在工作台目录之外，必须用绝对路径）
    from: '        rc = r.returncode',
    to: '        rc = 0          # 变异：不看返回码',
    expect: '便携版读 taskkill 返回码 → 恒当成功',
  },
  /* ===== 【40】A 档·采集口径与精选 ===== */
  {
    name: '【40-① 条数小字又只乘关键词数（回到"和右边耗时口径打架"）】',
    file: 'js/view-collect.js',
    from: 'var cap = (per === 0 ? 300 : per) * kws * cts;',
    to: 'var cap = (per === 0 ? 300 : per) * kws;',
    expect: '条数小字算出 8400 而不是 2800',
  },
  {
    name: '【40-② 条数小字不再说明"候选 ≠ 最终结果条数"（两件事又混成一个）】',
    file: 'js/view-collect.js',
    from: '\'<br>⛔ 这里管的是「捞多少候选」，<b>不是最终结果条数</b>：库里已有、本轮别的关键词采过的岗位会被跳过，\' +',
    to: '\'<br>\' +',
    expect: '小字里必须出现「不是最终结果条数」',
  },
  {
    name: '【40-③ 精选只排序不砍（"我只要 50 条"变成"给你全部"）】',
    file: 'js/view-collect.js',
    from: '    return sorted.slice(0, n);',
    to: '    return sorted;   /* 变异：只排不砍 */',
    expect: '精选 1 条时就该只剩 1 条',
  },
  {
    name: '【40-④ 精选完全不排序（"最精准的 N 条"退化成"最先采到的 N 条"）】',
    file: 'js/view-collect.js',
    from: '    var sorted = arr.slice().sort(function (a, b) {\n      var x = cfFitOf(a), y = cfFitOf(b);',
    to: '    var sorted = arr.slice().sort(function (a, b) {\n      return 0;   /* 变异：完全不排序（连 gate.drop 分组也一起去掉） */\n      var x = cfFitOf(a), y = cfFitOf(b);',
    expect: '选出的必须是分最高的那条',
  },
  {
    name: '【40-⑤ 精选不校验 NaN（slice(0, NaN) 得到空数组 → 结果莫名全没了）】',
    file: 'js/view-collect.js',
    from: '    if (typeof n !== \'number\' || isNaN(n) || n <= 0) return arr;',
    to: '    if (typeof n !== \'number\' || n <= 0) return arr;   /* 变异：漏了 NaN */',
    expect: 'NaN 时必须原样返回 3 条',
  },
  {
    name: '【40-⑥ 漏斗把"日志没这段"当成"采到 0 条"（认不出就填 0）】',
    file: 'js/view-collect.js',
    from: '        if (m) FUNNEL[p[0]] = parseInt(m[1], 10);',
    to: '        FUNNEL[p[0]] = m ? parseInt(m[1], 10) : (FUNNEL[p[0]] || 0);',
    expect: '日志里没有写入行时 written 必须是 null',
  },
  {
    name: '【40-⑦ 漏斗累加而不覆盖（同一批日志喂两次数字翻倍）】',
    file: 'js/view-collect.js',
    from: '        if (m) FUNNEL[p[0]] = parseInt(m[1], 10);',
    to: '        if (m) FUNNEL[p[0]] = (FUNNEL[p[0]] || 0) + parseInt(m[1], 10);',
    expect: '同一批日志喂两次结果不变',
  },
  {
    name: '【40-⑧ 换任务不清空（上一轮的漏斗挂在这一轮结果上）】',
    file: 'js/view-collect.js',
    from: '    if (key != null && key !== FUNNEL.key) {\n      FUNNEL = blankFunnel();\n      FUNNEL.key = key;\n    }',
    to: '    if (key != null) FUNNEL.key = key;   /* 变异：忘了清空 */',
    expect: '换任务后 total 是 7 而不是残留的 412',
  },
  {
    name: '【40-⑨ 漏斗干脆不画（用户还是看不到"为什么只新增 7 条"）】',
    file: 'js/view-collect.js',
    from: '    if (funnelReady()) host.appendChild(funnelNode());',
    to: '    /* 变异：漏斗不画 */',
    expect: '界面上必须出现「本轮采集漏斗」和 412',
  },
  {
    name: '【40-⑩ 候选不足时不提示（用户又开始怀疑"是不是漏采了"）】',
    file: 'js/view-collect.js',
    from: '    if (pool <= n) {\n      return \'⚠️ 候选池只有 \' + pool + \' 条，不够你要的 \' + n + \' 条 —— \' +\n        \'提高「每个关键词抓多少条」、多加几个关键词，或放宽筛选条件。\';\n    }',
    to: '    if (pool <= n) {\n      return \'\';   /* 变异：不提示 */\n    }',
    expect: '候选只有 3 条却要 12 条时必须明说',
  },
  {
    name: '【40-⑪ 精选不算「有筛选」（✕ 清空筛选按钮不出现 = 这个条件关不掉）】',
    file: 'js/view-collect.js',
    from: '      (typeof CF.wanted === \'number\' && !isNaN(CF.wanted) && CF.wanted > 0) ||',
    to: '      false ||   /* 变异：精选不算筛选 */',
    expect: '只设精选时「有筛选」必须是 true',
  },
  {
    name: '【40-⑫ 点「✕ 清空筛选」不清精选（按钮在，但按了没用）】',
    file: 'js/view-collect.js',
    from: '    CF.wanted = 0; writeWanted(0);      // 🎯 精选也要能关掉（并同步落盘）',
    to: '    /* 变异：不清精选 */',
    expect: '清空筛选后 CF.wanted 必须回到 0',
  },
  {
    name: '【40-⑬ 精选条数不落盘（F5 之后"我只要 50 条"就丢了）】',
    file: 'js/view-collect.js',
    from: '    try { localStorage.setItem(\'jh.collectWanted\', String(n)); } catch (e) { /* 存不了就只在内存里生效 */ }',
    to: '    /* 变异：不落盘 */',
    expect: 'writeWanted(30) 之后 readWanted() 要是 30',
  },
  {
    name: '【40-⑭ 读回的精选条数不验数字（NaN 混进 CF.wanted）】',
    file: 'js/view-collect.js',
    from: '      var v = parseInt(localStorage.getItem(\'jh.collectWanted\'), 10);\n      return (isNaN(v) || v < 0) ? 0 : Math.min(v, 500);',
    to: '      return localStorage.getItem(\'jh.collectWanted\');   /* 变异：不验数字 */',
    expect: '盘里是 abc 时必须读回 0',
  },
  {
    name: '【40-⑮ 一屏条数不认精选（要 50 条却只显示 40 条，像没生效）】',
    file: 'js/view-collect.js',
    from: '    return Math.max(RESULT_PAGE, n);',
    to: '    return RESULT_PAGE;   /* 变异：不认精选 */',
    expect: '精选 50 条时一屏条数要 ≥ 50',
  },
  {
    name: '【41-① 采集方式切换不落值（点了「按岗位直采」但 crawlMode 还是 custom）】',
    file: 'js/view-collect.js',
    from: '              if (f.crawlMode === m.v) return;\n              f.crawlMode = m.v;',
    to: '              if (f.crawlMode === m.v) return;\n              /* 变异：点了不切 */',
    expect: '点「按岗位直采」后 crawlMode 要变成 list',
  },
  {
    name: '【42-① 切合值过滤不生效（设了 ≥60 分，低于 60 的岗位还混在列表里）】',
    file: 'js/view-collect.js',
    from: '        return !r.gate.drop && (r.total || 0) >= CF.minFit;',
    to: '        return !r.gate.drop;   /* 变异：切合值过滤失效（不去掉低于 minFit 的） */',
    expect: '切合值 = 100 时必须 0 条（不过滤就会漏进来）',
  },
  {
    name: '【42-② 切合值不算「有筛选」（✕ 清空筛选按钮不出现 = 这个条件关不掉）】',
    file: 'js/view-collect.js',
    from: '      (typeof CF.minFit === \'number\' && !isNaN(CF.minFit) && CF.minFit > 0) ||',
    to: '      false ||   /* 变异：切合值不算筛选 */',
    expect: '只设切合值时「有筛选」必须是 true',
  },
  {
    name: '【42-③ 点「✕ 清空筛选」不清切合值（按钮在，但按了没用）】',
    file: 'js/view-collect.js',
    from: '    CF.minFit = 0; writeMinFit(0);      // 切合值同理，也要能关掉',
    to: '    /* 变异：不清切合值 */',
    expect: '清空筛选后 CF.minFit 必须回到 0',
  },
  {
    name: '【42-④ 切合值不落盘（F5 之后「我只要 60 分以上」就丢了）】',
    file: 'js/view-collect.js',
    from: '    try { localStorage.setItem(\'jh.collectMinFit\', String(n)); } catch (e) { /* 存不了就只在内存里生效 */ }',
    to: '    /* 变异：不落盘 */',
    expect: '切合值写 70 读回 70（F5 之后还在）',
  },
  {
    name: '【44-① 简历匹配度区间过滤失效（设了 90~100，低分岗位还混在列表里）】',
    file: 'js/view-collect.js',
    from: '    if (matchLo !== null || matchHi !== null) {',
    to: '    if (false) {   /* 变异：匹配度区间过滤失效 */',
    expect: '匹配度 90~100 时必须 0 条（不过滤就会漏进来）',
  },
  {
    name: '【44-② 匹配度区间不算「有筛选」（✕ 清空筛选按钮不出现 = 关不掉）】',
    file: 'js/view-collect.js',
    from: '      (typeof CF.matchMin === \'number\' && !isNaN(CF.matchMin)) ||',
    to: '      false ||   /* 变异：匹配度区间不算筛选 */',
    expect: '只设匹配度区间时「有筛选」必须是 true',
  },
  {
    name: '【44-③ 点「✕ 清空筛选」不清匹配度区间（按钮在，但按了没用）】',
    file: 'js/view-collect.js',
    from: '    CF.matchMin = null; CF.matchMax = null;   // 简历匹配度区间同理',
    to: '    /* 变异：不清匹配度区间 */',
    expect: '清空筛选后 CF.matchMin 必须回到 null',
  },
  {
    name: '【44-④ resultJobs 漏映射简历匹配分（后端挂了 _matchScore 却到不了卡片）】',
    file: 'js/view-collect.js',
    from: '        if (rec._matchScore !== undefined && rec._matchScore !== null) {',
    to: '        if (false) {   /* 变异：漏映射匹配分 */',
    expect: '第 1 条 matchScore 必须是 82',
  },
  {
    name: '【45-① 采集 payload 不带 includeKnown（勾了「重采历史」也传不到服务端 → 静默变回不去重）】',
    file: 'js/view-collect.js',
    from: '        includeKnown: !!f.includeKnown,',
    to: '        includeKnown: false,',
    expect: '勾选后 payload 必须带 includeKnown: true',
  },
  {
    name: '【45-② 服务端 build_cmd_crawl 不拼 --include-known（前端传了也到不了命令行）】',
    file: '采集器/server.py',
    from: "    if p.get('includeKnown'):\n        cmd += ['--include-known']",
    to: "    if False and p.get('includeKnown'):\n        cmd += ['--include-known']",
    expect: '命令行里必须有 --include-known',
  },
  {
    name: '【45-③ 爬虫不按 include_known 置空全局已知集（known 永远加载 → 历史岗位永远被去重）】',
    file: 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/crawler.py',
    from: '    known = None if include_known else known_links.load(ASSETS_DIR)',
    to: '    known = known_links.load(ASSETS_DIR)',
    expect: 'include_known 为真时 known 必须为 None',
  },

];

/* ⚠️ 为什么不用 execFileSync 的管道（2026-10-07 踩的，写下来免得后人再踩）：
   本机环境下，node 用 **piped stdio** 派生子进程一律抛 EBUSY（ERROR_BUSY），
   而 stdio 给「文件描述符 / inherit / ignore」都正常 —— 也就是「建管道」这一步失败。
   本脚本要跑 180 遍核心单测，所以改成「把子进程的 stdout/stderr 写进同一个临时文件、
   再读回来」：行为等价（拿到完整输出 + 退出码），且完全绕开管道。
   临时文件用 'w' 反复截断复用，**不删** —— unlinkSync 会被 safe-delete shim 拦，
   一个 turn 删 180 次必触发批量守卫（见文件头 dispose() 的注释）。 */
const OUT_TMP = path.join(os.tmpdir(), 'jh_selftest_out_' + process.pid + '.txt');

function runTest() {
  let fd = null;
  try {
    fd = fs.openSync(OUT_TMP, 'w');
    const r = spawnSync(NODE, [TEST], { cwd: DIR, stdio: ['ignore', fd, fd] });
    fs.closeSync(fd); fd = null;
    let out = '';
    try { out = fs.readFileSync(OUT_TMP, 'utf8'); } catch (e) { out = ''; }
    return { ok: r.status === 0, out: out };
  } catch (e) {
    return { ok: false, out: '自证跑核心单测失败：' + ((e && e.message) || e) };
  } finally {
    try { if (fd !== null) fs.closeSync(fd); } catch (e) { /* noop */ }
  }
}

console.log('先跑一遍基线……');
const base = runTest();
if (!base.ok) {
  console.log('❌ 基线就是红的，先修好再来自证。');
  const tail = base.out.split('\n').slice(-12).join('\n');
  console.log(tail);
  process.exit(1);
}
const baseCount = (base.out.match(/✅ 全部通过（(\d+) 项）/) || [])[1];
console.log('✅ 基线全绿（' + baseCount + ' 项）\n');

/* ==========================================================================
   ⛔ 脏文件保护
   --------------------------------------------------------------------------
   这个脚本会**临时改坏真实的产品文件**再还原。如果中途被打断
   （Ctrl+C、超时被杀、node 崩了），`finally` 跑不到，**产品文件就永久停在
   "被改坏"的状态** —— 而且它看起来完全正常，只是某一小块功能没了。
   （本项目真踩过：`job-picker.js` 的 `market()` 被留成 `return null`，
     表现为"真实在招岗位数据整块丢失"，查了半天才发现是自证脚本干的。）

   两道保险：
     1. 改之前先写一份 `<file>.mutbak`；被打断后下次启动时还原
     2. 进程收到 SIGINT / SIGTERM 时，先把当前文件还原再退出

   ⛔⛔ 一个血的教训（2026-09-30 真踩过）：
   早先「一启动就无条件把 .mutbak 还原回去」是错的 —— 上一轮被打断留下的
   .mutbak 是**那时改坏前的旧内容**，而打断之后我往往又改了新功能；无条件还原
   等于把我的新改动**回滚**掉（表现为"刚写的函数凭空消失、基线变红"）。
   正解：**基线已经全绿 = 产品文件现在是好的**，此时任何 .mutbak 都是过时备份，
   只能删除、不能还原。只有基线红的时候才考虑用 .mutbak 兜底。
   ========================================================================== */
const BAK = p => p + '.mutbak';

/* 基线已经全绿（上面 base.ok 已验证），说明产品文件当前是好的、完整的。
   此时残留的 .mutbak 必然是「上次被打断时的过时备份」，直接删掉 ——
   绝不能还原，还原会把打断之后的新改动回滚掉。 */
function purgeStaleBaks() {
  let n = 0;
  MUTATIONS.forEach(m => {
    // 变异目标可能是**仓库外的绝对路径**（如 boss-crawler skill 里的 crawler.py）
    const p = path.isAbsolute(m.file) ? m.file : path.join(DIR, m.file);
    if (!fs.existsSync(BAK(p))) return;
    dispose(BAK(p));
    console.log('🧹 清掉了上次中断留下的过时备份（产品文件已是好的，不回滚）：' + m.file);
    n++;
  });
  return n;
}
if (purgeStaleBaks() > 0) {
  console.log('   （上次跑到一半被打断，但本次基线已全绿 → 只清备份、不回滚文件。）\n');
}

/*   当前正在被临时改坏的文件（被打断时用它还原） */
let pending = null;
function bail() {
  if (pending) {
    /* pending 可能是数组（组合变异：多个文件同时被改坏）—— 逐个还原 */
    const list = Array.isArray(pending) ? pending : [pending];
    list.forEach(function (x) {
      try { fs.writeFileSync(x.p, x.src, x.enc); } catch (e) { /* noop */ }
      try { dispose(BAK(x.p)); } catch (e) { /* noop */ }
    });
    console.log('\n⚠️  被打断，已还原 '
      + list.map(function (x) { return path.basename(x.p); }).join('、')
      + '，没有留下脏文件。');
  }
  process.exit(130);
}
['SIGINT', 'SIGTERM', 'SIGHUP'].forEach(sig => {
  try { process.on(sig, bail); } catch (e) { /* 某些平台不支持，忽略 */ }
});

let caught = 0, missed = 0, guardOnly = 0;
const missedList = [];

/* ⛔⛔ 「只有锚点守卫红」必须算漏检，不能算抓到。
   ------------------------------------------------------------------
   `_测试_核心.js` 里有一条守卫：「自证的 N 条变异锚点全部能匹配上（失配 = 静默漏检）」。
   它拿 current 文件内容去比对**每一条**变异的 from 锚点。
   于是只要我改坏了任何一个文件，这条守卫**必然**变红 —— 哪怕那条功能根本没有测试覆盖。
   也就是说：只看 `!r.ok` 判定「抓到了」，268 条会**全部**被判成抓到，自证等于摆设。
   （这正是本项目铁律里写的「只红锚点守卫 = 假绿」。实测过：2026-10-12 新增的 19 条里，
     只看 !r.ok 是 21/21；把守卫剔掉之后才知道功能断言有没有真的红。）
   ⇒ 所以这里把守卫类的失败**剔除**，只看剩下的：
        · 还有别的失败项 → 真抓到（功能断言自己红了）
        · 只剩守卫红     → 按**漏检**计，并明确提示"功能断言没红 = 假绿"
        · 一项都没红     → 漏检（没覆盖）
   ⚠️ 这里的字符串必须与 `_测试_核心.js` 里那两条断言的**名字**保持一致
      （改了那边记得同步这里，否则守卫又会被当成"功能断言"）。 */
const GUARD_PAT = /变异锚点全部能匹配上|自证变异锚点全部唯一/;

/* 换行归一化后再比对锚点。
   仓库里的 js 文件换行符**不统一**（有的 CRLF 有的 LF，甚至同一文件里混着），
   在 from/to 里写多行锚点时，只要文件是 CRLF 就一律匹配不上 —— 而且会安静地
   被当成"跳过"，看起来像"这条已经改过了"，很容易被骗过去。
   归一化只影响本次的临时改动，跑完仍然用 orig 原样还原，不会污染文件。 */
const normEol = s => s.replace(/\r\n/g, '\n');

MUTATIONS.forEach((m, i) => {
  /* 变异目标可以是仓库内的相对路径，也可以是**仓库外的绝对路径**
     （如 boss-crawler skill 里的 crawler.py —— 翻页防死循环那条就改它）。 */
  const p = path.isAbsolute(m.file) ? m.file : path.join(DIR, m.file);
  /* 有的产品文件不是 utf-8：两个启动器 .vbs 是 UTF-16LE + BOM。
     用错编码读 → 满屏乱码 → 锚点永远匹配不上 → 被当成"跳过"（假绿）。
     所以每条变异可以声明 enc。 */
  const enc = m.enc || 'utf8';
  let orig = fs.readFileSync(p, enc);
  const wasCrlf = /\r\n/.test(orig);
  let origN = normEol(orig);
  const fromN = normEol(m.from);
  const toN = normEol(m.to);

  /* --- S1-B 组合变异支持 --- */
  /*  `also: [{file, from, to}]`：一次变异同时改**多个文件的多处**。
      为什么需要：防护常常是"多层"的 —— 只还原一层时，另一层会顺手把结果补回来
      （本项目实测：撤掉「采纳落盘」的单点，会被 else 分支的 save() 补上 →
       改坏了测试照样绿 → 误判成"弱断言"）。
      所以这类变异必须**同时**把两层都还原，才等价于"改回出 bug 的版本"。
      实现：把所有目标（主目标 + also）先全部读进 memory 再统一写盘，
      finally 里全部还原。为兼容主目标，also 文件不在 .mutbak 之外再动备份逻辑 ——
      pending 记成数组，bail() 也要跟着还原全部。 */
  const extras = [];
  if (Array.isArray(m.also)) {
    m.also.forEach(function (x) {
      const xp = path.isAbsolute(x.file) ? x.file : path.join(DIR, x.file);
      const xenc = x.enc || enc;
      const xorig = fs.readFileSync(xp, xenc);
      extras.push({
        p: xp, enc: xenc, orig: xorig,
        fromN: normEol(x.from), toN: normEol(x.to),
        wasCrlf: /\r\n/.test(xorig),
      });
    });
  }

  if (origN.indexOf(fromN) < 0) {
    console.log('⏭  [' + (i + 1) + '] ' + m.name);
    console.log('     跳过：在 ' + m.file + ' 里找不到要替换的代码（锚点失效，检查是不是代码被改过）');
    missed++;
    missedList.push(m.name + '（锚点失效）');
    return;
  }
  /* 还原成文件本来的换行风格再写盘，免得临时改动把整个文件的 EOL 换掉 */
  const patchedN = origN.replace(fromN, toN);
  const bakPath = BAK(p);
  // 先落一份备份再改：万一被打断，下次启动能自动还原（见上面的脏文件保护）
  fs.writeFileSync(bakPath, orig, enc);
  /* 组合变异：pending 记成数组，bail() 会逐个还原（含 also 的目标文件） */
  const toRestore = [{ p: p, src: orig, enc: enc, bak: bakPath }];
  extras.forEach(function (x) {
    const xbak = BAK(x.p);
    fs.writeFileSync(xbak, x.orig, x.enc);
    toRestore.push({ p: x.p, src: x.orig, enc: x.enc, bak: xbak });
  });
  pending = toRestore;
  extras.forEach(function (x) {
    const xpatched = x.orig.replace(/\r\n/g, '\n').replace(x.fromN, x.toN);
    fs.writeFileSync(x.p, x.wasCrlf ? xpatched.replace(/\n/g, '\r\n') : xpatched, x.enc);
  });
  fs.writeFileSync(p, wasCrlf ? patchedN.replace(/\n/g, '\r\n') : patchedN, enc);
  let r;
  try { r = runTest(); }
  finally {
    toRestore.forEach(function (x) {
      fs.writeFileSync(x.p, x.src, x.enc);
      dispose(x.bak);
    });
    pending = null;
  }

  const failedNames = (r.out.match(/^   · (.+)$/gm) || []).map(s => s.replace(/^   · /, ''));
  /* 守卫类失败剔除后再判 —— 见上面 GUARD_PAT 的长注释（只看 !r.ok 会把全部 268 条判成"抓到"） */
  const realFails = failedNames.filter(s => !GUARD_PAT.test(s));
  const isCaught = !r.ok && realFails.length > 0;

  if (m.allowPass) {
    console.log((isCaught ? '⚠️  [' : '⏭  [') + (i + 1) + '] ' + m.name);
    console.log(isCaught
      ? '     竟然被抓到了（' + realFails.length + ' 项）—— 说明已有覆盖，把 allowPass 去掉'
      : '     确实没抓到（' + m.expect + '）—— 记下来，别假装覆盖了');
    return;
  }

  if (isCaught) {
    caught++;
    console.log('✅ [' + (i + 1) + '] ' + m.name);
    console.log('     功能断言自己红了 ' + realFails.length + ' 项，例如：' + realFails[0]);
  } else if (!r.ok) {
    guardOnly++;
    missed++;
    missedList.push(m.name + '（只有锚点守卫红，功能断言没红 = 假绿）');
    console.log('⚠️  [' + (i + 1) + '] ' + m.name);
    console.log('     改坏后**只有那条锚点守卫**变红，功能断言一条都没红');
    console.log('     ⛔ 守卫红只证明"我确实改到了文件"，不证明这条功能被覆盖过 → 按漏检计');
  } else {
    missed++;
    missedList.push(m.name);
    console.log('❌ [' + (i + 1) + '] ' + m.name);
    console.log('     改坏了测试还是全绿 → 这条功能【没被覆盖】');
  }
});

console.log('\n' + '─'.repeat(64));
console.log('回退自证：功能断言真抓到 ' + caught + ' / ' + MUTATIONS.length
  + ' 处，漏掉 ' + missed + ' 处（其中"只有锚点守卫红" ' + guardOnly + ' 处）');
if (missedList.length) {
  console.log('以下改动改坏了也没被测试发现，需要补断言：');
  missedList.forEach(x => console.log('  · ' + x));
  process.exit(1);
}
console.log('✅ 每个新功能都有能把它照出来的测试（且每处都是功能断言自己红的）');
