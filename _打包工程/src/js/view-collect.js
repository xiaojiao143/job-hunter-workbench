/* ==========================================================================
   view-collect.js · 模块 9：采集岗位（本地采集器通道）

   职责边界（如实说明，别写成比实现更好听的话）：
     ✅ 起一个真实 Edge 窗口，用户自己扫码登录
     ✅ 打开列表页与详情页，调用页面自身的数据接口读取岗位信息
        （即浏览器加载页面时本来就会请求的那两个接口）
     ✅ 结果交回岗位库，后续解析/匹配/跟踪全在工作台里做
     ⚠️ 接口级读取比手动翻页更密集，更容易触发 BOSS 风控 —— 请如实告知用户
     ❌ 不自动发消息、不自动投递

   它本身不发请求给 zhipin.com —— 那是本地 Python 采集器干的活。
   这一页只是那个采集器的遥控器 + 日志窗 + 结果入口。
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  /* 采集器监听的端口。它从 8738 起试，占了就往后挪，
     所以这儿也按同样顺序探一遍。 */
  var PORTS = [8738, 8739, 8740];

  var SALARY_OPTIONS = ['3K以下', '3-5K', '5-10K', '10-20K', '20-50K', '50K以上'];

  /* 薪资档位 → [下限, 上限]（单位 K）。用于采集参数体检：判断填的期望薪资下限
     有没有落在采集档位里 —— 落不进去就说明 BOSS 会在服务端把匹配的岗位筛掉。 */
  var SALARY_BAND = {
    '3K以下': [0, 3], '3-5K': [3, 5], '5-10K': [5, 10],
    '10-20K': [10, 20], '20-50K': [20, 50], '50K以上': [50, 9999],
  };
  /** 找出能覆盖某个薪资值的档位（体检里「一键修正」用） */
  function bandCovering(k) {
    for (var i = 0; i < SALARY_OPTIONS.length; i++) {
      var b = SALARY_BAND[SALARY_OPTIONS[i]];
      if (b && k >= b[0] && k <= b[1]) return SALARY_OPTIONS[i];
    }
    return '';
  }

  /**
   * 采集参数 vs 求职偏好的一致性体检（纯函数 —— 单测直接测它，不测渲染壳）。
   * 只报「明确会漏岗位」的冲突，返回 [{ code, ico, html, fix }]：
   *   code='salary' → fix = 能覆盖期望薪资的档位名（可能为空）
   *   code='city'   → fix = 偏好里的目标城市（逗号分隔）
   *   code='jobs'   → fix = 偏好里一个都没被带上的期望岗位数组
   */
  function paramIssues(form, P) {
    form = form || {};
    P = P || {};
    var cities = U.asArray(P.cities);
    var expectJobs = U.asArray(P.expectJobs);
    var salaryMin = (typeof P.salaryMin === 'number' && P.salaryMin > 0) ? P.salaryMin : null;
    var out = [];

    // ① 期望薪资落不进采集档位 → BOSS 在服务端就把匹配的岗位筛掉了
    if (salaryMin !== null && form.salary && SALARY_BAND[form.salary]) {
      var b = SALARY_BAND[form.salary];
      if (salaryMin < b[0] || salaryMin > b[1]) {
        out.push({
          code: 'salary', ico: '💰',
          html: '偏好里写的期望薪资下限是 <b>' + salaryMin + 'K</b>，' +
            '但采集档位「<b>' + form.salary + '</b>」不含它 —— BOSS 会在<b>服务端</b>先把匹配的岗位筛掉，' +
            '采回来的多半是「薪资更高、要求也更高」的那批。',
          fix: bandCovering(salaryMin),
        });
      }
    }

    // ② 采集城市与目标城市毫无交集
    if (cities.length && form.city) {
      var picked = String(form.city).split(/[,，、\/\s]+/).filter(Boolean);
      var hit = cities.filter(function (c) {
        return picked.some(function (x) { return x.indexOf(c) >= 0 || c.indexOf(x) >= 0; });
      });
      if (!hit.length) {
        out.push({
          code: 'city', ico: '📍',
          html: '偏好里的目标城市是 <b>' + cities.join(' / ') + '</b>，' +
            '采集填的却是 <b>' + form.city + '</b> —— 两边对不上，采回来的城市基本不是你要的。',
          fix: cities.join(', '),
        });
      }
    }

    // ③ 偏好里设了期望岗位，这次采集一个都没带上
    if (expectJobs.length) {
      var hay = String(form.keywords || '') + ' ' + U.asArray(form.expectJobs).join(' ');
      var miss = expectJobs.filter(function (n) { return hay.indexOf(n) < 0; });
      if (miss.length === expectJobs.length) {
        out.push({
          code: 'jobs', ico: '🎯',
          html: '偏好里设了 <b>' + expectJobs.length + ' 个期望岗位</b>（' +
            expectJobs.slice(0, 3).join(' / ') + (expectJobs.length > 3 ? ' …' : '') +
            '），但这次采集的关键词和「岗位期望」里都没有它们。',
          fix: expectJobs.slice(),
        });
      }
    }

    // ③·b 经验档（§五-7）：简历 myYears 落在所选经验档之外 → BOSS 服务端筛掉正好匹配的。
    var myYears = (typeof P.myYears === 'number' && P.myYears > 0) ? P.myYears : null;
    if (myYears !== null && U.asArray(form.experience).length) {
      var expMiss = U.asArray(form.experience).filter(function (e) {
        var b = EXPERIENCE_BAND[e];
        if (!b) return false;
        return myYears < b[0];   // 简历年限低于该档下限 = 该档要求更高，会漏掉低年资岗
      });
      if (expMiss.length && expMiss.length === U.asArray(form.experience).length) {
        var cover = Object.keys(EXPERIENCE_BAND).filter(function (e) {
          var b = EXPERIENCE_BAND[e];
          return myYears >= b[0] && myYears < b[1];
        });
        out.push({
          code: 'experience', ico: '🧭',
          html: '简历写了 <b>' + myYears + ' 年</b>经验，但采集经验档设的是 <b>' +
            U.asArray(form.experience).join(' / ') + '</b> —— 这些档要求的年限都更高，' +
            'BOSS 会在<b>服务端</b>把「' + myYears + ' 年上下」正好匹配的岗位筛掉。',
          fix: cover.length ? cover : ['经验不限'],
        });
      }
    }

    // ③·c 公司规模档（§五-7）：简历/偏好里没直接给规模期望，这里不硬报 ——
    //    规模是「宁缺毋滥」的弱偏好，BOSS 规模档是区间重叠判定，误报比漏报更烦。
    //    所以只在用户**明确选了规模**且与偏好里的行业规模倾向矛盾时才提示（当前偏好无此字段，先留空）。

    /* ④ 参数卡里选的「区 / 商圈」看着像是**别的城市**的
       → 两边对不上，采集后精筛会被筛成空列表（不报错，只是没东西）。
       ⚠️ 只认「它确实出现在另一个城市的行政区划里」这一种强信号，
          不认「我不认识这个词」—— 商圈名（「长河」「文三路」）本来就不在行政区划里，
          按"不认识就报"会误报成一片。 */
    var wantDist = U.asArray(form.district).concat(U.asArray(form.bizArea));
    if (wantDist.length && form.city && global.GEO && global.GEO.DISTRICTS) {
      var city0 = String(form.city).split(/[,，、\s]+/)[0];
      var thisDist = global.GEO.districtsOf(city0, []);
      var otherDist = Object.keys(global.GEO.DISTRICTS).reduce(function (a, k) {
        return a.concat(global.GEO.DISTRICTS[k]);
      }, []).filter(function (d) { return thisDist.indexOf(d) < 0; });
      var bad = wantDist.filter(function (x) {
        return otherDist.some(function (d) { return d === x || d.indexOf(x) >= 0 || x.indexOf(d) >= 0; });
      });
      if (bad.length && bad.length === wantDist.length) {
        out.push({
          code: 'geo', ico: '📍',
          html: '「地点」里填了 <b>' + wantDist.join(' / ') + '</b>，' +
            '但它们都是<b>别的城市</b>的区 —— 采集填的是 <b>' + city0 + '</b>。' +
            '采集后按区/商圈精筛时，这批结果会被筛成<b>空列表</b>（不报错，只是没东西）。',
          fix: 'clear',
        });
      }
    }

    return out;
  }

  /* ==================== BOSS 同款筛选维度（2026-09-30 扩展） ====================

     筛选维度分两类：
     ① 有 BOSS 搜索接口参数的 —— 采集时透传给 pipeline，让 BOSS 只返回符合条件的：
        salary / degree / experience / scale / stage(融资) / jobType(工作类型)
     ② 无 BOSS 接口参数的 —— BOSS 搜索接口没有对应参数，只能采集后本地筛：
        welfare(福利待遇) / activeTime(BOSS活跃度)

     为什么福利/活跃度是「本地筛」而非「透传」：
       BOSS 的 joblist.json 接口参数表里没有 welfare / activeTime 两个字段
       （福利写在岗位的 welfareList、活跃度写在 activeTimeDesc，都是返回结果里的
       展示字段，不是查询条件）。硬塞给 BOSS 只会被忽略或报错，让用户误以为筛了。
       所以这两项在采集时**不过滤**，采集落地后在「④ 采集结果」里自动按它们筛。
   */

  // 学历（BOSS degreeList 实测 code）
  var DEGREE_OPTIONS = ['初中及以下', '中专/中技', '高中', '大专', '本科', '硕士', '博士'];

  // 经验（BOSS experienceList 实测）
  var EXPERIENCE_OPTIONS = ['在校生', '应届生', '经验不限', '1年以内', '1-3年', '3-5年', '5-10年', '10年以上'];

  /* 经验档位 → [下限, 上限]（单位年）。用于「参数体检 · 经验」：判断简历的 myYears
     有没有落在所选经验档之外 —— 简历 2 年却设了「3-5年」，BOSS 会在服务端把
     「1-3年」这类正好匹配的岗位筛掉。上限用 Infinity 表示「以上」。
     「经验不限」「在校生」「应届生」不参与检查（不限 = 不筛，应届/在校 = 用户主动选）。 */
  var EXPERIENCE_BAND = {
    '1年以内': [0, 1], '1-3年': [1, 3], '3-5年': [3, 5],
    '5-10年': [5, 10], '10年以上': [10, Infinity],
  };

  // 公司规模（BOSS scaleList 实测）
  var SCALE_OPTIONS = ['0-20人', '20-99人', '100-499人', '500-999人', '1000-9999人', '10000人以上'];

  // 融资阶段（BOSS stageList 实测）
  var STAGE_OPTIONS = ['未融资', '天使轮', 'A轮', 'B轮', 'C轮', 'D轮及以上', '已上市', '不需要融资'];

  // 工作类型（BOSS jobTypeList 实测）
  var JOBTYPE_OPTIONS = ['全职', '实习', '兼职'];

  /* 福利待遇（BOSS 无查询参数，本地筛）。
     ⚠️ 选项**只在 job-match.js 里维护一份**（WELFARE_OPTIONS）。
        这里原先自己抄了一个字符串数组，两份已经开始对不上 ——
        而且那边带正则（同一个意思在 BOSS 上有「带薪年假 / 年假 / 带薪休假」多种写法），
        精确子串匹配会漏掉一大片。 */
  function welfareOpts() {
    return ((global.JobMatch && global.JobMatch.WELFARE_OPTIONS) || [])
      .map(function (o) { return o.k; });
  }

  // BOSS 活跃度（无查询参数，本地筛。来自岗位 hr_active / activeTimeDesc）
  var ACTIVE_OPTIONS = ['今日活跃', '3日内活跃', '本周活跃', '本月活跃'];

  /* 活跃度 → 时间先后等级（越小越新）。「刚刚/今日」最靠前，「本月」最靠后。
     认不出的（空 / 半年内活跃这种很旧的）按「很旧」算 —— 选「本月活跃」才带得上它。 */
  function activeRank(s) {
    var t = String(s || '');
    if (/刚刚|今日|今天/.test(t)) return 0;
    if (/3日|三天/.test(t)) return 1;
    if (/本周|7日/.test(t)) return 2;
    if (/本月|30日|月内/.test(t)) return 3;
    return 4;
  }

  /* 每个关键词抓多少条 → 合法值。0 = 不限（**不能**被 `|| 30` 吞掉，评审 P2-3：
     以前 `parseInt(x) || 30` 会把用户输入的 0 静默变成 30）；空/非数字 → 默认 30；
     超上限 → 截到 200（输入框只写在 HTML min/max 上，没 JS 校验，填 10000 会原样传）。 */
  function parseCount(v) {
    var n = parseInt(v, 10);
    if (isNaN(n)) return 30;
    if (n === 0) return 0;
    if (n < 1) return 1;
    if (n > 200) return 200;
    return n;
  }

  /**
   * 「自定义薪资区间」的输入解析（单位 K）。
   * 空串 / 非数字 / 0 / 负数一律算「这一头没设」→ null。
   * ⛔ 返回 null 而不是 0：0 会把「我没填」和「我要 0K 以上」混成同一件事
   *    （本项目的老坑：`x || 默认值` 会吞掉 0）。
   */
  function parseK(v) {
    // ⚠️ 同一口径，权威是 view-collect.js 的 parseK()（有 _parseK 测试锚点）
    if (v === null || v === undefined || String(v).trim() === '') return null;
    var n = Number(v);
    return (isFinite(n) && n > 0) ? n : null;
  }

  /**
   * 自定义薪资区间的**单条判定**（结果精筛 / 参数卡提示共用同一份口径）。
   * 语义刻意与岗位库「薪资达标」对齐：**区间重叠即算命中**、**没写薪资的岗位一律保留**。
   * ⛔ 保留「没写薪资」：按"没写就筛掉"处理，用户会以为岗位丢了（同地理筛选的理由）。
   */
  function salaryRangeHit(j, lo, hi) {
    var a = (j && typeof j.salaryMin === 'number') ? j.salaryMin : null;
    var b = (j && typeof j.salaryMax === 'number') ? j.salaryMax : null;
    if (a === null && b === null) return true;       // 面议 / 未标薪资 → 保留
    var low = (a === null) ? b : a;                  // 岗位区间只有一头就用那一头
    var high = (b === null) ? a : b;
    if (lo !== null && high < lo) return false;      // 岗位最高都够不着下限
    if (hi !== null && low > hi) return false;       // 岗位最低已超过上限
    return true;
  }

  /* 页面状态。全部挂在模块上，切换页面再回来不用重新探测。 */
  /**
   * 「② 采集参数」卡里那三行地点（省 / 城市 / 区 / 商圈）的重画入口。
   *
   * ⛔ 为什么需要它：这三行的候选来自 `Store.jobs()`（见 allJobsNow），
   *    但**渲染时只取一次快照**。所以「把采集结果导入岗位库」之后不离开页面，
   *    商圈行会一直停在「还没采到商圈数据」—— 数据其实已经进库了（真机实测：
   *    此时 `GEO.bizAreasOf` 已能返回商圈），用户却会以为这次采集丢了区域数据，
   *    要么白重采一轮、要么放弃按区/商圈筛选。
   *
   * 由 paramCard() 渲染时赋值（它才有那三个 DOM 容器），导入成功后由 doImport()
   * 调一次。⛔ 只重画这三行、**不整页 refresh**（这页有 1500+ DOM 节点），
   *    也不碰 localStorage（重画不是"用户表态"，不能把继承来的值固化）。
   */
  var paintGeoRows = null;

  var S = {
    base: null,        // 探测到的服务地址，如 http://127.0.0.1:8738
    ping: null,        // 最近一次 /api/ping 的结果
    probing: false,    // 是否正在探测（防重复点击）
    probingP: null,    // 进行中的探测 promise —— 重复进入页面时复用它，别拿 S.base 兜底
    since: 0,          // 已经读过的日志行数
    taskKey: null,     // 当前/最近一次任务标识
    timer: null,       // 日志轮询定时器
    wasRunning: null,  // 上一次 poll 时任务是否在跑（做「跑完」边沿检测用）
    result: null,      // /api/jobs 的最近结果
    form: null,        // 参数表单的就地状态
    activePreset: null, // 当前选中的采集方案 id（只是高亮，不是数据源）
    /* 区/商圈是不是「用户自己动过」。
       false = 还跟着求职偏好走（每次打开按偏好带入）；true = 以他改的为准。
       为什么要这个标记：jh.collectForm 里只要出现 district 键就代表"用户表过态"，
       而"打开页面看一眼"不该产生表态 —— 否则继承来的值会被固化下来，
       之后改偏好采集页就不再跟着变（正是要修的那个 bug）。 */
    geoOwned: false,
    /* 是否有一批导入正在跑。⛔ 用来挡住"连点两下" —— 分批导入中间有好几个
       yield 窗口，手快就能点第二下，两条流水线同时往库里塞会让计数翻倍、
       进度条互相打架。 */
    importing: false,
    /* 「② 采集参数」是不是展开的。折叠状态跟着会话走，切页再回来保持不变。 */
    paramOpen: null,
    /* 当前任务到底在不在跑。null = 还没轮询过（此时退回用 ping.busy 兜底）。
       ⛔ 单独存一个字段，是为了让「■ 停止」按钮能跟着任务状态**实时**出现/消失
          （评审 P1-9：以前它按渲染那一刻的 ping.busy 快照决定，而自己发起的采集
           只起 poll、不 refresh ⇒ 按钮永远不出现，只能关掉程序）。 */
    taskRunning: null,
    /* poll 的「代次」与当前那一路的 onFail 回调。
       ⛔ 后来者替换前者时，必须先替前者把 onFail 兜底通知掉（评审 P1-8），
          否则那一路的 promise 永远不 resolve。 */
    pollGen: 0,
    pendingFail: null,
  };

  /* ==================== 与服务通信 ==================== */

  /**
   * 访问令牌（P0-1 安全加固）。
   *
   * 采集器 serve index.html 时会把 token 注入成 `window.__JH_TOKEN__`；所有 /api/*
   * 都要带着它，否则服务端一律 403 —— 这样「浏览器里随便打开的任意网页」就算能发请求，
   * 也读不到你本机的岗位/画像数据。
   *
   * 只有「采集器自己打开的页面」有它。直接双击 index.html（file://）打开的同一份文件
   * 拿不到（文件是磁盘原样），此时页面会给出明确的引导卡，而不是一堆莫名其妙的失败。
   */
  function token() {
    try { return global.__JH_TOKEN__ || ''; } catch (e) { return ''; }
  }

  /** 带超时的 fetch。探测离线服务时不能干等浏览器默认那几十秒。 */
  function req(path, opt) {
    opt = opt || {};
    var url = (opt.absolute || S.base) + path;
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var ms = opt.timeout || 2500;
    var timer = ctl ? setTimeout(function () { ctl.abort(); }, ms) : null;

    var init = { method: opt.method || 'GET', signal: ctl ? ctl.signal : undefined };
    var headers = {};
    if (opt.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(opt.json);
    }
    if (opt.raw) {
      init.body = opt.raw;
      if (opt.headers) { for (var hk in opt.headers) headers[hk] = opt.headers[hk]; }
    }
    var tok = token();
    if (tok) headers['X-JH-Token'] = tok;                     // 每个 /api/* 请求都带令牌
    if (Object.keys(headers).length) init.headers = headers;

    return fetch(url, init).then(function (res) {
      if (timer) clearTimeout(timer);
      return res.text().then(function (txt) {
        var data = null;
        try { data = JSON.parse(txt); } catch (e) { data = null; }
        if (!res.ok) {
          throw new Error((data && data.error) || ('服务返回 ' + res.status));
        }
        return data;
      });
    }).catch(function (e) {
      if (timer) clearTimeout(timer);
      // abort / 网络错误 / CORS 被拦，对用户来说都是同一件事：连不上
      var err = new Error(e && e.name === 'AbortError' ? '连接超时' : (e && e.message) || '连不上');
      err.offline = true;
      throw err;
    });
  }

  /**
   * 依次探每个候选端口，第一个答话的就用它。
   *
   * ⚠️ 探测进行中再次调用，必须**复用同一个 promise**。
   * 早先这里是 `return Promise.resolve(S.base)`，而那一刻 S.base 还是 null，
   * 于是「进采集页 → 马上切走 → 再切回」会被误判成「采集器没启动」，
   * 直接渲染线下卡（真踩过：CDP 端到端验收时抓到的）。
   */
  function detect() {
    if (S.probing && S.probingP) return S.probingP;
    S.probing = true;
    var i = 0;
    function next() {
      if (i >= PORTS.length) {
        S.probing = false;
        S.probingP = null;
        S.base = null;
        S.ping = null;
        return null;
      }
      var base = 'http://127.0.0.1:' + PORTS[i++];
      return req('/api/ping', { absolute: base, timeout: 1600 }).then(function (d) {
        if (!d || !d.ok) return next();
        S.base = base;
        S.ping = d;
        S.probing = false;
        S.probingP = null;
        return base;
      }).catch(function () {
        return next();
      });
    }
    // 用 .then 推迟首次执行，保证 S.probingP 先赋值完再可能同步返回
    S.probingP = Promise.resolve().then(next);
    return S.probingP;
  }

  /* ==================== 日志渲染 ==================== */

  var MAX_LINES = 3000;      // 日志上限，防止长任务把 DOM 撑爆

  function lineClass(t) {
    if (/^\$/.test(t)) return 'ln-cmd';
    if (/\[采集器\]/.test(t)) return 'ln-sys';
    if (/(❌|失败|错误|Error|Traceback|超时)/.test(t)) return 'ln-bad';
    if (/(✅|成功|完成|\[LOGIN_OK\])/.test(t)) return 'ln-ok';
    if (/(⚠|\[LOGIN_NEEDED\]|警告)/.test(t)) return 'ln-warn';
    return '';
  }

  function appendLines(box, lines) {
    if (!lines || !lines.length) return;
    var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
    var frag = document.createDocumentFragment();
    lines.forEach(function (t) {
      var cls = lineClass(t);
      var d = document.createElement('div');
      d.className = 'ln' + (cls ? ' ' + cls : '');
      d.textContent = t === '' ? ' ' : t;
      frag.appendChild(d);
    });
    box.appendChild(frag);
    // 超上限就砍掉最老的，保滚动位置不跳
    var kids = box.children;
    while (kids.length > MAX_LINES) {
      box.removeChild(kids[0]);
    }
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  function stopPoll() {
    if (S.timer) { clearInterval(S.timer); S.timer = null; }
  }

  /** 现在到底有没有任务在跑？poll 每轮同步 S.taskRunning；还没轮询过就用 ping 兜底。 */
  function taskRunning() {
    if (S.taskRunning !== null) return S.taskRunning;
    return !!(S.ping && S.ping.busy);
  }

  /**
   * ③ 卡片顶部那三颗动作按钮 —— 抽成函数是为了能**就地从任务状态重画**（评审 P1-9）。
   *
   * ⚠️ 只重画这一个容器（#cActions），绝不整页 refresh：后者会冲掉日志框的滚动位置，
   *    也会打断用户正在填的表单。
   */
  function actionButtons() {
    var lg = (S.ping && S.ping.login) || {};
    return [
      el('button', {
        class: 'btn' + (lg.value === 'ok' ? '' : ' pri'),
        /* ⛔ 文案必须**诚实**：这个按钮走的是 doLogin() → POST /api/login →
           拉起一个真实 Edge 让你扫码，不是"读一下当前状态"。
           原来已登录时叫「🔑 重新检测登录」，一个"重新检测"让用户以为是便宜操作，
           点下去却弹出一个浏览器窗口 + 扫码提示，非常费解（评审 A7 实测）。
           现在按它实际做的事命名，扫码这个关键信息直接写在按钮上。 */
        html: lg.value === 'ok' ? '🔑 重新登录（扫码）' : '🔑 ① 登录 BOSS',
        title: '会弹出一个真实的 Edge 窗口，请在里面扫码登录',
        onclick: function (e) { doLogin(e.target); },
      }),
      el('button', {
        class: 'btn pri', html: '📡 ② 开始采集',
        onclick: function (e) { doCrawl(e.target); },
      }),
      /* 「■ 停止」只在真的有任务在跑时出现 —— 依据是**轮询回来的实时状态**，
         不是渲染那一刻的快照（评审 P1-9）。 */
      taskRunning()
        ? el('button', { class: 'btn danger', html: '■ 停止',
                         title: '停掉当前任务（连它的 Edge 子进程一起收）',
                         onclick: doStop })
        : null,
    ].filter(Boolean);
  }

  function paintActions() {
    var host = U.$('#cActions');
    if (!host) return;
    host.innerHTML = '';                 // 就地重画，不新建外层容器（保住焦点/滚动）
    actionButtons().forEach(function (n) { host.appendChild(n); });
  }

  /** 任务跑完的统一收尾：弹完成提示 + 搬筛选 + 刷结果。抽出来好测。 */
  function onTaskDone(t, reRenderOnDone) {
    stopPoll();
    S.pendingFail = null;             // 任务已正常收尾，没人需要被兜底通知了
    S.taskKey = null;
    S.taskRunning = false;            // P1-9：跑完了，「■ 停止」要收起来
    paintActions();
    // 跑完的「边沿」：上一次还在跑、这一次结束了 → 给一个明显的完成提示。
    if (S.wasRunning) notifyDone(t);
    S.wasRunning = false;
    // 采集跑完 → 把参数卡里那些「不进 BOSS 搜索条件」的项（区/商圈/福利/活跃度）
    // 搬进结果页筛选，用户在参数卡上写的条件立刻生效。
    try { seedCFFromForm(); } catch (e) { /* 搬不动就不搬，别让采集流程挂在这 */ }
    // 跑完刷新一次 ping（登录态可能变了、运行目录可能换了）
    detect().then(function () {
      if (reRenderOnDone) reRenderOnDone();
      loadResult();
    });
  }

  /**
   * 轮询任务，直到它结束。
   *
   * @param reRenderOnDone 任务**正常跑完**时的回调（原语义不变）
   * @param onFail         轮询**提前放弃**时的回调，参数是原因：
   *                       'offline'（没连采集器）/ 'no-task'（接口说没有任务）/
   *                       'net'（请求失败）/ 'superseded'（被后来的 poll 顶掉了）
   *                       ⛔ 四条路径**每一条都必须通知** —— 少一条就是「静默卡死」。
   *
   * ⛔ 补的这个洞（评审 4.4，实测会让「开始采集」永久禁用）：
   *   原来 `!t` 和 `.catch()` 两条路径都只 `stopPoll()` 然后 return —— **不通知任何人**。
   *   而 `runLoginCheck` 的 promise 只挂在「任务正常结束」这一条路上，于是
   *   「刚 POST 完 /api/login，第一次轮询没读到任务」这一个竞态，就能让那个 promise
   *   **永不 resolve** → `doCrawl` 里 `btn.disabled = false` 永远执行不到 →
   *   按钮永久禁用，且界面上一个字的提示都没有（用户只能刷页面自救）。
   *
   *   ⚠️ 反向约束：**不能**把这里的 onFail 做成「没任务 = 成功」。任务正常结束时
   *   走的是 `!t.running` 那条路，`t` 一定存在 —— 所以 `!t` 只会发生在
   *   「采集器重启了 / 没连上」，它是失败，不是完成。
   */
  function poll(reRenderOnDone, onFail) {
    /* ⛔ 代次（评审 P1-8）：poll 是全模块共用的一个 S.timer 单例，后来的会**无条件**
       把前面的掐掉，而 stopPoll() 只 clearInterval、**从不通知 onFail** ⇒
       被掐掉那一路的 promise 永远不 resolve，只能等下面那条 380 秒保险丝 ——
       期间「开始采集」一直是 disabled，用户只看到"点了没反应"。
       触发场景很日常：点「② 开始采集」进了登录预检，又去点「① 登录 BOSS」或传简历。
       ⇒ 掐之前先把前一路的 onFail 兜底通知掉，并给每轮一个代次，让旧回调彻底停手。 */
    var gen = (S.pollGen || 0) + 1;
    S.pollGen = gen;
    if (S.timer || S.pendingFail) {
      var prevFail = S.pendingFail;
      S.pendingFail = null;
      stopPoll();
      if (prevFail) { try { prevFail('superseded'); } catch (e) { /* noop */ } }
    }
    S.pendingFail = onFail || null;      // 记下来：被后来者顶掉时由它负责通知

    /* 上一次请求还没回来就别再发：请求超时是 4 秒、轮询间隔 1.2 秒，
       网络慢的时候会叠起来发（越慢越发、越发越慢）。 */
    var busy = false;
    function mine() { return S.pollGen === gen; }
    function giveUp(reason) {
      stopPoll();
      S.pendingFail = null;
      if (onFail) onFail(reason);
    }
    function once() {
      if (!mine()) return;               // 已被新的一代替换 → 立刻停手，别再动 UI
      if (busy) return;
      if (!S.base) { giveUp('offline'); return; }
      busy = true;
      req('/api/task?since=' + S.since, { timeout: 4000 }).then(function (d) {
        busy = false;
        if (!mine()) return;
        var t = d && d.task;
        var box = U.$('#cLog');
        if (!t) { giveUp('no-task'); return; }
        if (t.lines && t.lines.length) {
          if (box) appendLines(box, t.lines);
          S.since = t.total;
        }
        /* A 档 · 采集漏斗：同一批行顺手汇进去（任务换了会就地清空重算）。
           放在 if 外面 —— 即使这一轮没新行，也要有机会发现「任务换人了」。 */
        absorbLines(t.lines, t.key);
        var bar = U.$('#cTaskBar');
        if (bar) paintTaskBar(bar, t);
        /* P1-9：把**实时**任务状态同步给顶部按钮行 —— 「■ 停止」靠它出现/消失。
           这是本函数唯一能拿到「任务真的在跑」的地方，别再让按钮去读渲染快照。 */
        S.taskRunning = !!t.running;
        paintActions();
        if (!t.running) {
          onTaskDone(t, reRenderOnDone);
        } else {
          S.wasRunning = true;
        }
      }).catch(function () {
        busy = false;
        if (!mine()) return;
        giveUp('net');
      });
    }
    S.timer = setInterval(once, 1200);
    /* ⚡ 先**立刻**探一次，不要等 1.2 秒：任务卡一进来就该有内容。
       顺带的作用：测试环境的 setInterval 是空桩（`setInterval: () => 0`），
       没有这一下，整个轮询在这套测试里**一次都不会跑** —— 这恰恰是
       「登录预检永不 resolve」能溜过 1587 项测试的原因。 */
    once();
  }

  /**
   * 把「当前任务」渲染成一个带进度条 + 计时的状态块。
   *
   * ⚠️ 采集没有「总进度」这个可靠概念（要翻多少页、每页多少条，跑到一半才知道），
   * 所以进度条用「不确定进度」的滚动动画（.task-pbar-run），再配一个**已用时**，
   * 让用户至少知道「还在动、跑了多久」。完成后进度条拉满、给总耗时。
   */
  function fmtDur(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    if (sec < 60) return sec + ' 秒';
    var m = Math.floor(sec / 60);
    if (m < 60) return m + ' 分 ' + (sec % 60) + ' 秒';
    var h = Math.floor(m / 60);
    return h + ' 小时 ' + (m % 60) + ' 分';
  }

  /**
   * 把服务端算好的预估（estimate_crawl 的返回）说成一句人话（P2-2）。
   *
   * ⚠️ 口径必须和服务端一致，尤其两点（否则用户看到的数是假的）：
   *   ① 详情**整轮封顶**（DETAIL_TOP_N=50，2026-10-05 评审 P0-1.1 后是「整轮共享」
   *      而非「每个关键词 50」）—— 所以 600 条结果不会说「等 50 分钟」，而是
   *      「约 5 分钟，详情只抓优先级最高的 50 个」。
   *   ② count=0 是「不限」，服务端按每位置每城市 300 条估 —— 这里如实标「按不限估」。
   *
   * 返回 null 表示「还估不了」（缺城市或期望），调用方显示引导语而不是「0 分钟」。
   */
  function fmtEstimate(es) {
    if (!es || typeof es.minutes !== 'number') return null;
    var head = '预计约 ' + es.minutes + ' 分钟';
    var parts = ['列表 ' + es.listMinutes + ' 分', '详情 ' + es.detailMinutes + ' 分'];
    var tail = '（' + parts.join(' + ') + '）';
    if (es.detailCapped) {
      // 「优先级最高」而非「最合适」：crawler.detail_priority() 自己声明它不是
      // 「合适度」，只是按列表页客观信号（薪资明确/福利条数/信息完整）排的
      // 「值得优先细看」顺序 —— 用户期望薪资在浏览器里，爬虫读不到。
      tail += '，详情只抓优先级最高的 ' + es.detailCapN + ' 个' +
        '（按你的期望岗位优先；没排上的下次采集接着补，不是丢了）';
    }
    if (es.unlimited) {
      tail += '，条数按「不限」估';
    }
    return head + tail;
  }

  function paintTaskBar(bar, t) {
    bar.innerHTML = '';
    if (!t) {
      bar.appendChild(el('span', { class: 'fs12 muted', text: '（暂无任务）' }));
      return;
    }
    var running = t.running;
    var paused = !!t.paused;              // 一键冻结：进程被挂起，但任务还没结束
    var started = t.started_at ? t.started_at * 1000 : 0;
    var ended = t.ended_at ? t.ended_at * 1000 : 0;
    var now = Date.now();
    var elapsedSec = Math.max(0, ((ended || now) - started) / 1000);

    var wrap = el('div', { class: 'task-block' });

    // 第一行：状态 pill + 任务标题 + 计时
    var top = el('div', { class: 'task-head' });
    top.appendChild(el('span', {
      class: 'pill ' + (!running ? (t.exit_code === 0 ? 'on' : 'off') : (paused ? 'off' : 'wait')),
    }, [el('span', { class: 'dt' }),
        !running ? (t.exit_code === 0 ? '已完成' : '已结束（退出码 ' + (t.exit_code == null ? '?' : t.exit_code) + '）')
                 : (paused ? '⏸ 已暂停' : '进行中')]));
    if (t.title) top.appendChild(el('span', { class: 'fs12 muted', text: t.title }));
    top.appendChild(el('span', { class: 'sp' }));

    // 计时：跑动中实时显示已用时，结束后显示总耗时 + 起止时间
    if (running) {
      top.appendChild(el('span', { class: 'task-time run', text: '⏱ ' + fmtDur(elapsedSec), 'data-started': String(started) }));
    } else if (started) {
      var startTxt = fmtClock(started);
      var endTxt = ended ? fmtClock(ended) : '';
      top.appendChild(el('span', { class: 'task-time done', text: '⏱ 共 ' + fmtDur(elapsedSec) + ' · ' + startTxt + (endTxt ? ' → ' + endTxt : '') }));
    }
    /* 暂停 / 继续：只在任务还在跑时出现。
       这块由 poll 每 1.2 秒重画一次，所以状态天然同步 —— 不要整页 refresh，
       那会把日志框的滚动位置冲掉，也会打断采集页上正在填的输入。 */
    if (running) {
      top.appendChild(paused
        ? el('button', { class: 'btn', html: '▶ 继续',
                         title: '恢复被挂起的采集，从暂停的地方接着跑',
                         onclick: function () { doResume(); } })
        : el('button', { class: 'btn', html: '⏸ 暂停',
                         title: '挂起采集进程（CPU 归零），已采到的一行不丢',
                         onclick: function () { doPause(); } }));
    }

    wrap.appendChild(top);

    // 进度条：进行中 = 滚动动画；暂停 = 静止（真冻住了就别再滚）；完成 = 拉满；失败 = 红色拉满
    var pbarCls = 'task-pbar';
    if (!running) pbarCls += (t.exit_code === 0 ? ' task-pbar-done' : ' task-pbar-fail');
    else if (!paused) pbarCls += ' task-pbar-run';
    var pbar = el('div', { class: pbarCls });
    pbar.appendChild(el('i', {}));
    wrap.appendChild(pbar);

    bar.appendChild(wrap);
  }

  function fmtClock(ms) {
    var d = new Date(ms);
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** 任务完成提示音（Web Audio，无需音频文件）。失败/静音时静默忽略。 */
  function beep() {
    try {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      var ctx = beep._ctx || (beep._ctx = new AC());
      if (ctx.state === 'suspended') ctx.resume();
      var t0 = ctx.currentTime;
      [0, 0.18].forEach(function (off, i) {
        var o = ctx.createOscillator();
        var g = ctx.createGain();
        o.type = 'sine';
        o.frequency.value = i === 0 ? 880 : 1174.66;  // A5 → D6，上扬的「搞定」音
        g.gain.setValueAtTime(0.0001, t0 + off);
        g.gain.exponentialRampToValueAtTime(0.18, t0 + off + 0.02);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + off + 0.22);
        o.connect(g); g.connect(ctx.destination);
        o.start(t0 + off); o.stop(t0 + off + 0.24);
      });
    } catch (e) { /* 忽略 */ }
  }

  /**
   * 任务跑完时的「明显提示」：一个醒目的 toast + 提示音。
   * 抽成独立函数是为了单测能直接驱动它（poll 里的定时器不好在测试里踩）。
   * 返回 true 表示弹了提示（方便测试断言）。
   */
  function notifyDone(t) {
    var ok = t.exit_code === 0;
    var spent = (t.started_at ? (Date.now() / 1000 - t.started_at) : 0);
    // onTaskDone 不区分任务类型，登录检测 / 简历解析也走这里。
    // 它们跑完说「采集完成，去④看结果」会把人搞懵，所以按 key 换措辞；
    // 只有真正的采集任务才提「④ 采集结果」。
    if (t.key === 'login' || t.key === 'parse') {
      var what = t.key === 'login' ? '登录检测' : '简历解析';
      U.toastHtml(
        (ok ? ('<b>' + what + '完成 ✅</b>') : ('<b>' + what + '结束了</b>')) +
        '，耗时 <b>' + fmtDur(spent) + '</b>' +
        (ok ? '。' : '（退出码 ' + (t.exit_code == null ? '?' : t.exit_code) + '）。'),
        ok ? 'ok' : 'warn',
        ok ? 9000 : 8000
      );
      beep();
      return true;
    }
    U.toastHtml(
      (ok ? '<b>采集完成 ✅</b>' : '<b>任务结束了</b>') +
      '，共耗时 <b>' + fmtDur(spent) + '</b>' +
      (ok ? '。结果已就绪，去「④ 采集结果」查看。' : '（退出码 ' + (t.exit_code == null ? '?' : t.exit_code) + '）。'),
      ok ? 'ok' : 'warn',
      ok ? 12000 : 9000
    );
    beep();
    return true;
  }

  /* ==================== 采集结果 ==================== */

  /**
   * 拉一次采集结果。
   *
   * ⚠️ 这里曾经踩过一个坑：早期版本给 loadResult 传了个「拉完就 App.refresh()」的回调，
   * 于是 refresh → 重绘 → 恢复现场又调 loadResult → 又 refresh，转成死循环（整页卡死）。
   * 所以现在的约定是：**loadResult 只就地更新结果卡，绝不触发整页重绘。**
   */
  function loadResult() {
    if (!S.base) return Promise.resolve(null);
    return req('/api/jobs', { timeout: 8000 }).then(function (d) {
      S.result = d;
      paintResultBody(U.$('#cResult'));
      return d;
    }).catch(function () {
      S.result = null;
      paintResultBody(U.$('#cResult'));
      return null;
    });
  }

  /**
   * 一键清空采集结果：服务端把结果文件**归档**（移动到 results-archive/，不是删除）。
   *
   * 用户口径：「导进岗位库之后，这批结果就该能一键清掉」—— 导入后结果区这批
   * 几百条还一直挂着，占地方还容易误点重复导入。清的是**采集器侧的文件**，
   * 岗位库数据在浏览器 localStorage 里，跟这批文件毫无关系，动了也动不到。
   */
  function clearResults() {
    var n = resultJobs().length;
    if (!n) { U.toast('结果区已经是空的，不用清。', 'info'); return; }
    U.confirm(
      '把这批采集结果（' + n + ' 个岗位）从结果区清掉？<br><br>' +
      '· 清的是<b>采集器侧的结果文件</b>，整体归档到 <code>results-archive/</code>，误清可以整批找回<br>' +
      '· <b>岗位库不受影响</b> —— 已导入的数据在你浏览器里，跟这些文件无关<br>' +
      /* ⛔ 这句必须有：详情抓取是**逐轮累积**的（爬虫按「岗位要求和职责是否为空」
         挑下一轮要抓的），而清空会把 post_data/CSV 整体挪走 → 下一轮从空文件重建，
         已抓到的 JD **不会带过来**，累积进度从头开始。
         以前只说"归档、可找回"，听起来像无害的整理动作，用户不会意识到这一点（评审 A10）。
         注意措辞：数据在归档目录里，**不是永久删**，别写成"丢了"。 */
      '· ⚠️ <b>已抓到的岗位详情（JD）不会带到下一轮</b> —— 详情是逐轮累积的，' +
      '清空后下一轮会从零开始补积累（归档目录里那份仍可找回）<br>' +
      '· 清完结果区就是空的，下次采集再攒新的一批',
      { okText: '清空结果', title: '清空采集结果', danger: true }
    ).then(function (go) {
      if (!go) return;
      req('/api/results/clear', { method: 'POST', json: {}, timeout: 20000 })
        .then(function (d) {
          if (!d || !d.ok) throw new Error((d && d.error) || '清空失败');
          U.toastHtml('<b>已清空</b>：' + (d.n || 0) + ' 处结果文件已归档' +
            (d.dest ? '<br><span class="fs11">归档位置：' + U.esc(String(d.dest)) + '</span>' : ''),
            'ok', 9000);
          loadResult();          // 就地刷新结果卡（会显示空结果引导）
        })
        .catch(function (e) {
          U.toast('清空失败：' + (e.message || String(e)), 'bad', 9000);
        });
    });
  }

  /**
   * 采集结果里**已经导进岗位库**的那些岗位。
   * 用去重键跟库里对一遍 —— 只是统计，不写库（为了显示一个数字就往库里塞数据太脏了）。
   */
  function resultStoreJobs() {
    var recs = (S.result && S.result.jobs) || [];
    if (!recs.length) return [];
    var byKey = {};
    Store.jobs({ includeArchived: true }).forEach(function (j) { byKey[Store.jobDedupeKey(j)] = j; });
    var out = [];
    recs.forEach(function (rec) {
      var j = Exporter.fromCrawlerRecord(rec);
      if (!j) return;
      var hit = byKey[Store.jobDedupeKey(j)];
      if (hit) out.push(hit);
    });
    return out;
  }

  /** 采集结果里的岗位还没评分的有几个 */
  function resultUnscored() {
    return global.JobMatch ? global.JobMatch.unscored(resultStoreJobs()) : [];
  }

  /* ==================== 采集结果筛选 ==================== */

  /* 筛选状态（页面级，切页再回来保留）。
     只影响「④ 采集结果」这一张卡的展示，不写库、不动采集器。 */
  var CF = {
    kw: '',          // 关键词（支持「杭州 运营 15k」这种自然语言）
    job: '',         // 岗位名（下拉，选项来自 JOB_MARKET 的真实在招岗位名）
    city: '',        // 城市下拉
    district: [],    // 区（多选，城市下钻，选项只来自这批结果里真实采到的）
    bizArea: [],     // 商圈（比区更细，同上 —— 参数卡里能多选，这里必须也能多选，
                     //        否则「参数卡选 3 个区」会在结果页被悄悄截成 1 个）
    industry: '',    // 行业下拉
    salary: '',      // 薪资档位下拉（BOSS 搜索条件）
    salaryMin: null, // 自定义薪资下限（K）—— 本地精筛，不是搜索条件
    salaryMax: null, // 自定义薪资上限（K）—— 同上
    scored: '',      // '' | scored | unscored
    welfare: [],     // 福利待遇（多选，本地筛）
    active: '',      // BOSS 活跃度（单选，本地筛）
    fit: '',         // 本地「合适度」分级：'' | A | B | C | D（js/job-score.js）
    hideDrop: false, // 隐藏被硬性过滤剔除的岗位
    onlyNew: false,  // 只看本次新增（本轮采到的，不含历史池）
    sort: 'default', // default | fit | salary | score | company
    /* 🎯 精选：最终只保留合适度最高的 N 条（0 = 不限）。
       ⛔ 与上面 `sort` 的区别：sort 只管**显示顺序**，wanted 会真的**砍掉**后面的。
       ⛔ 必须走 pickTop()，别在诸处各写一遍 slice —— 排序口径会飘。 */
    wanted: 0,
    /* 🎯 切合值：连续的最低合适分门槛（0-100，0 = 不限）。
       用户要的「匹配度自由范围 60-100 / 80-100」= 这里填 60 / 80。
       ⛔ 与上面 `fit`（分级 A/B/C/D）的区别：fit 是「只看某一级」（精确到 80-100 或
          60-79），切合值是「≥ N 分」（60 分以上= A+B 两级一起）。
       ⛔ 它是**展示过滤**（可随时改、不写库、不删数据）：把切合值改回 0，被滤掉的
          岗位立刻回来 —— 对应方案「切合值不决定采不采、只决定展示」那条铁律。 */
    minFit: 0,
    /* 🎯 简历匹配度区间（P2）：对**服务端简历匹配**的打分（matchScore）做 0-100 的
       自由范围过滤。用户要的「匹配度自由设计范围 60-100 / 80-100」= 这里填 60/100 或
       80/100。与上面 minFit（本地规则切合值）是两个独立维度：minFit 是本地零成本的
       规则分（随时能算），matchMin/matchMax 是跑完 /api/match 之后由服务端落盘的
       简历匹配分（含 LLM 二筛）。没跑过匹配时这些岗位没有 matchScore，此过滤不生效。
       ⛔ 同为**展示过滤**：改回空就放回全部，不删数据。 */
    matchMin: null, // 匹配度下限（含），null = 不限
    matchMax: null, // 匹配度上限（含），null = 不限
    /* 🤖 AI 清洗判定（P0）：'' | relevant | uncertain | irrelevant。
       ⛔ 纯展示过滤，不写库不删数据；判定本身存在 AI_CONF（按对象引用）。
       选回 '' 就把全部放回来 —— 对应「AI 只打标、不判决」的设计。
       ⛔ 名字带 Clean 前缀：岗位对象上已有一个 `aiVerdict`（前端 AI 评分的
          {score,...}，见下面 sorters.score 与结果列表渲染），两者**不是一回事**，
          撞名会让人以为选了筛选项就把匹配分弄没了。 */
    aiCleanVerdict: '',
  };
  /* 🎯 精选条数是用户的**偏好**（"我最终只要最精准的 50 条"），不是一次性筛选，
     所以落盘、F5 之后还在。读回见 readWanted（它自己会验数字，防 NaN）。 */
  CF.wanted = readWanted();
  /* 切合值同样是偏好（"我只要 60 分以上的"），落盘、F5 之后还在。 */
  CF.minFit = readMinFit();

  /* 本地合适度结果：每批结果算一次就够，别让列表渲染时逐个重算。
     ⚠️ 必须**按对象引用**存，不能拿 j.id 当键 ——
     采集结果走的是 Exporter.fromCrawlerRecord()，出来的对象**还没有 id**
     （id 是入库那一刻由 normJob 才发的）。用 j.id 当键的话，整批岗位会全部落到
     `CF_FIT[undefined]` 同一个键上：最后一条的分数被套给所有人，
     于是它们整齐地一起「被剔除」或一起「是 A 级」，看起来还挺像那么回事。
     （岗位库那边能用 id，是因为它读的是已经入库的 Store.jobs()。） */
  var CF_FIT = new Map();

  /* 结果列表「显示多少条」。
     以前是 filtered.slice(0, 40) 硬截断 —— 456 条结果只能看前 40 条，
     没有分页也没有「查看全部」（体检报告 §3.1）。改成渐增展开：
       默认 RESULT_PAGE 条 → 点「加载更多」每次 +RESULT_PAGE。
     用一个「筛选指纹」判断条件是否变过：一变就回到首屏条数，
     这样用户换了筛选不会突然跳到第 200 条，而「加载更多」本身不触发重置。 */
  var RESULT_PAGE = 40;
  var resultShown = RESULT_PAGE;
  var resultSig = '';
  // 「只看本次新增」默认开关（评审 §五-3 / 3.5）：采集一跑完，用户最想要的是
  // 「我刚采的那批」，不是跨轮累积的历史池。所以有本轮信息时**默认切到只看新增**。
  // 用「已默认过」标志避免用户手动切回「看全部」后又被强行拉回「只看新增」。
  var _onlyNewDefaulted = false;

  function cfSignature() {
    return JSON.stringify([CF.kw, CF.job, CF.city, CF.district, CF.bizArea,
      CF.industry, CF.salary, CF.scored, CF.welfare, CF.active, CF.fit,
      CF.hideDrop, CF.onlyNew, CF.sort, CF.wanted, CF.minFit,
      CF.matchMin, CF.matchMax, CF.aiCleanVerdict]);
  }

  function cfFitAll(list) {
    if (!global.JobScorer) return list;
    var cfg = global.JobScorer.config();
    CF_FIT = new Map();
    list.forEach(function (j) { CF_FIT.set(j, global.JobScorer.score(j, cfg)); });
    return list;
  }

  function cfFitOf(j) {
    if (CF_FIT.has(j)) return CF_FIT.get(j);
    return global.JobScorer.score(j);
  }

  /** 采集结果 → 标准岗位对象（复用文件导入同一套映射） */
  function resultJobs() {
    var recs = (S.result && S.result.jobs) || [];
    return recs.map(function (rec) {
      var j = Exporter.fromCrawlerRecord(rec);
      // 「本轮新增」标记在原始记录上（后端 load_jobs 打的），但 fromCrawlerRecord
      // 是显式字段映射、不会带过来。这里按 url 补回去 —— 不改共用导入器，
      // 免得影响岗位库那条链路。
      if (j && rec && rec._isNew) j.isNew = true;
      // 「简历匹配」结论（P2）：后端把 match_analysis.json / scored_jobs.json 的打分
      // + 原因按 link 挂成 _matchScore/_matchReason/_matchMissing。同样**只在这条
      // 采集结果链路上接走**，不进共用 fromCrawlerRecord（岗位库那条链路的字段
      // 白名单不该被采集页的展示字段污染）。matchScore 是 0-100 的整数。
      if (j && rec) {
        if (rec._matchScore !== undefined && rec._matchScore !== null) {
          j.matchScore = U.asNum(rec._matchScore);
        }
        if (rec._matchReason) j.matchReason = String(rec._matchReason);
        if (rec._matchCategory) j.matchCategory = String(rec._matchCategory);
        if (rec._matchMissing && rec._matchMissing.length) j.matchMissing = U.asArray(rec._matchMissing);
      }
      return j;
    }).filter(Boolean);
  }

  /** 后端是否提供了「本轮新增」信息（采集正常结束时才有 round_links.json）。 */
  function hasRoundInfo() {
    return !!(S.result && S.result.hasRoundInfo);
  }

  /** 本轮真正新增的岗位数（后端在 /api/jobs 里算好）。 */
  function newCount() {
    return (S.result && typeof S.result.newCount === 'number') ? S.result.newCount : 0;
  }

  /** 详情抓取失败统计（P1-3）：{count, reasons:{原因:条数}}；没有就 null。 */
  function detailFailures() {
    var df = S.result && S.result.detailFailures;
    return (df && df.count) ? df : null;
  }

  /** 权威岗位要求命中统计（P1-5 / 评审 P0-2.1）：多少条挂上了 JD 抽出的学历/经验/技能。 */
  function reqHitsInfo() {
    var r = S.result;
    if (!r || typeof r.reqHits !== 'number') return null;
    return { hits: r.reqHits, total: r.reqTotal || 0 };
  }

  /* ---- 采集漏斗：把爬虫 stdout 里的「拿到多少 / 跳过多少 / 详情额度」摊开 ----
     为什么需要它（实证）：用户设「每个关键词 50 条」，跑完却只新增 7 条，第一反应
     是采集器坏了。真相是那 50 条是**新增**上限 —— 库里已有、本轮别的词采过的岗位
     会被跳过，而**跳过的不占额度**。这些数字爬虫一直在打印（翻页行 + 末尾的
     print_crawl_summary + 详情额度行），只是界面从来没汇总过，用户只能靠猜。

     ⛔ 不新增接口、不改服务端：挂载时那一次 `/api/task?since=0` 本来就能把该任务的
        **全部** stdout 拿回来，这里只做解析。
     ⚠️ 解析必须**容错**：认不出来的项一律留 null，绝不猜、绝不填 0 ——
        填 0 会让「日志没这段」和「真的是 0 条」混成同一件事。
     ⚠️ 同一批行喂两次结果必须不变（可重入），因为 poll 的分页与挂载的全量会重叠。 */
  function blankFunnel() {
    return {
      key: null, pages: 0, capHit: false,
      total: null, written: null, skipped: null, runDups: null, knownDups: null,
      dPending: null, dKept: null, dSucc: null, dAsked: null, dExhausted: false,
    };
  }
  var FUNNEL = blankFunnel();

  /* 逐行数值项。左列 = 漏斗字段，右列 = 爬虫打印原文的匹配式。
     ⛔ 改这里必须同时改 crawler.py 的打印、或反过来 —— 只改一边就是静默失效。 */
  var FUNNEL_NUM = [
    ['total', /^\s*获取数据[:：]\s*(\d+)\s*条/],
    ['written', /^\s*写入数据[:：]\s*(\d+)\s*条/],
    ['skipped', /^\s*跳过重复[:：]\s*(\d+)\s*条/],
    ['runDups', /^\s*其中跨关键词重复[:：]\s*(\d+)\s*条/],
    ['knownDups', /^\s*其中历史采过且已有 JD[:：]\s*(\d+)\s*条/],
    ['dPending', /全轮共\s*(\d+)\s*个岗位缺详情/],
    ['dKept', /按全局优先级取前\s*(\d+)\s*个/],
  ];
  var FUNNEL_PAGE = /^\[第(\d+)页\]/;
  var FUNNEL_DONE = /详情爬取完成[:：]\s*成功\s*(\d+)\s*条\s*\/\s*实际请求\s*(\d+)\s*次/;

  /** 把一批日志行汇进漏斗。key 变了就整块清空重算（换任务了）。 */
  function absorbLines(lines, key) {
    if (key != null && key !== FUNNEL.key) {
      FUNNEL = blankFunnel();
      FUNNEL.key = key;
    }
    if (!lines || !lines.length) { paintFunnel(); return; }
    lines.forEach(function (raw) {
      var s = String(raw == null ? '' : raw);
      FUNNEL_NUM.forEach(function (p) {
        var m = s.match(p[1]);
        if (m) FUNNEL[p[0]] = parseInt(m[1], 10);
      });
      var mp = s.match(FUNNEL_PAGE);
      if (mp) FUNNEL.pages = Math.max(FUNNEL.pages, parseInt(mp[1], 10));
      var md = s.match(FUNNEL_DONE);
      if (md) { FUNNEL.dSucc = parseInt(md[1], 10); FUNNEL.dAsked = parseInt(md[2], 10); }
      if (s.indexOf('已达到数量限制') >= 0) FUNNEL.capHit = true;
      if (s.indexOf('详情额度已用完') >= 0) FUNNEL.dExhausted = true;
    });
    paintFunnel();
  }

  /** 有数字才展示 —— 老数据 / 日志已过期时整块不出现（宁可没有，也不瞎猜）。 */
  function funnelReady() {
    return !!(FUNNEL && (FUNNEL.total !== null || FUNNEL.written !== null));
  }

  function funnelNode() {
    var f = FUNNEL;
    var lines = [];
    if (f.total !== null) {
      var s1 = '列表页拿到 <b>' + f.total + '</b> 条';
      if (f.written !== null) s1 += ' → 写入结果池 <b>' + f.written + '</b> 条';
      if (f.skipped !== null) s1 += ' → 直接跳过 ' + f.skipped + ' 条';
      lines.push(s1);
    }
    if (f.runDups !== null || f.knownDups !== null) {
      var sub = [];
      if (f.runDups !== null) {
        sub.push('跨关键词重复 ' + f.runDups + ' 条（几个关键词撞了同一批岗位 —— 减关键词比加关键词有用）');
      }
      if (f.knownDups !== null) {
        sub.push('历史采过且已有 JD ' + f.knownDups + ' 条（这批词/城市已经采过，换词或换城市才拿得到新的）');
      }
      if (sub.length) lines.push('　└ ' + sub.join('；'));
    }
    if (f.dPending !== null) {
      var s2 = '详情：全轮 <b>' + f.dPending + '</b> 个岗位缺详情';
      if (f.dKept !== null) s2 += ' → 本轮按优先级排上 ' + f.dKept + ' 个';
      if (f.dSucc !== null) s2 += '（成功 ' + f.dSucc + ' 条 / 实际请求 ' + f.dAsked + ' 次）';
      if (f.dSucc !== null && f.dPending > f.dSucc) {
        s2 += ' → 还有 <b>' + (f.dPending - f.dSucc) + '</b> 个只有列表页字段';
      }
      lines.push(s2);
    }
    if (f.dExhausted) {
      lines.push('本轮详情额度已用完，剩下的岗位这轮只有列表页字段（下一轮采集会接着补，不是丢了）。');
    }
    if (f.capHit) {
      lines.push('⚠️ 有关键词达到了你设的条数上限 —— 到量就停，不是采不到。');
    }
    lines.push('说明：你设的「每个关键词抓多少条」是<b>新增</b>上限（每个「关键词×城市」各一份），' +
      '库里已有、本轮别的词采过的岗位会被跳过、<b>不占这个额度</b>；' +
      '某页重复率达到 80% 时该关键词剩下的页就不再往下翻 —— ' +
      '所以「实际新增」通常比「列表页最多 N 条」少得多，这是正常的，不是没采到。');
    var box = el('div', { class: 'note info', style: 'margin-top:6px' }, [
      el('div', {}, [
        el('span', { class: 'ico', text: '📊' }),
        el('span', { html: '<b>本轮采集漏斗</b>' + (f.pages ? '（翻了 ' + f.pages + ' 页）' : '') +
          ' · 数字来自采集日志' }),
      ]),
    ]);
    lines.forEach(function (t2) {
      box.appendChild(el('div', { class: 'fs12', style: 'margin-top:4px', html: t2 }));
    });
    return box;
  }

  /**
   * 就地重画漏斗。
   * ⛔ 只动 `#cFunnel` 这一个容器，**禁 App.refresh()**（会冲掉日志框滚动位置，
   *    也会打断用户正在填的表单 —— 与 paintActions 同一套纪律）。
   * host 可显式传入：结果卡是**先构造后挂载**的，构造期 U.$ 还找不到它。
   */
  function paintFunnel(host) {
    host = host || U.$('#cFunnel');
    if (!host) return;
    while (host.firstChild) host.removeChild(host.firstChild);
    if (funnelReady()) host.appendChild(funnelNode());
  }

  /**
   * 「每个关键词抓多少条」那行小字的**纯函数版**。
   *
   * ⛔ 抽出来是为了能被测试**直接断言口径**：以前这段逻辑埋在 paramCard() 的闭包里，
   *    只能靠"渲染出来看文字"间接验，而渲染型断言最容易写成自证式（改坏了也通过）。
   *
   * ⛔ 口径必须和右边「预计 N 分钟」**一致**：那边是 per × 关键词数 × 城市数
   *    （server.py 的 estimate_crawl：per_pos_city * len(pos) * len(cities)）。
   *    以前这里只乘关键词数 —— 同一屏上两个数打架，用户自然会得出
   *    「他抓取的数量和这个的限制数量不匹配」的结论（实测反馈原话）。
   *
   * ⛔ 更要紧的是**语义**：这里的数字只是「捞回多少条候选」，**不是最终结果条数**。
   *    用户真正想要的「我只要最精准的 50 条」在结果页的 🎯 精选 里设 ——
   *    以前界面把这两件事混成一个数，是这轮反馈的根因。
   */
  function countHintText(per, kws, cts) {
    var each = per === 0 ? '不限（按每位置每城市 300 条估）' : (per + ' 条');
    if (!kws) {
      return '🔢 每个关键词 <b>' + each + '</b> —— 填上关键词后这里会算出采集阶段的候选条数';
    }
    if (!cts) {
      return '🔢 ' + kws + ' 个关键词 × 每个 <b>' + each + '</b>' +
        ' —— 再选上城市，这里会算出采集阶段的候选条数（每个城市各有一份额度）';
    }
    var cap = (per === 0 ? 300 : per) * kws * cts;
    return '🔢 采集阶段：' + kws + ' 个关键词 × ' + cts + ' 个城市 × 每个 <b>' + each + '</b>' +
      ' ≈ 最多捞回 <b>' + cap + '</b> 条<b>候选</b>（口径与右边耗时预估一致）' +
      (per === 0 ? '' : '；条数越多越慢，第一次建议 20-30 条试试水') +
      '<br>⛔ 这里管的是「捞多少候选」，<b>不是最终结果条数</b>：库里已有、本轮别的关键词采过的岗位会被跳过，' +
      '跳过的都不占额度。<br>🎯 你要的「最终只要最精准的 N 条」在<b>结果页</b>设（结果计数下面那个「🎯 最终只要最精准的 __ 条」）' +
      '—— 按本地合适度排序取前 N，改数字不用重采。';
  }

  /* ---- 🎯 精选（= 用户口径的"我设 50 条"）--------------------------------
     这是本轮反馈的**正解**：采集阶段只负责把候选捞回来，最终要多少条由这里定。
     它不重跑采集，只在过筛后的候选池里按本地合适度排序取前 N —— 零成本、可反复调。 */

  /**
   * 精选条数落盘。⛔ 这是用户的**偏好**（"我永远只要最精准的 50 条"），
   * 不是一次性的筛选，所以 F5 之后必须还在。
   * ⛔ 读回来必须验数字：`slice(0, NaN)` 会得到**空数组** —— 一旦把 "abc"
   * 或者 null 放进 CF.wanted，用户看到的就是"结果莫名全没了"。
   * （键名内联而不引常量：CF 字面量初始化时就要调它，那时 var 还没赋值。）
   */
  function readWanted() {
    try {
      var v = parseInt(localStorage.getItem('jh.collectWanted'), 10);
      return (isNaN(v) || v < 0) ? 0 : Math.min(v, 500);
    } catch (e) { return 0; }
  }
  function writeWanted(n) {
    try { localStorage.setItem('jh.collectWanted', String(n)); } catch (e) { /* 存不了就只在内存里生效 */ }
  }

  /* 切合值落盘（同 wanted：偏好，不是一次性筛选）。
     ⛔ 读回必须验数字 + 夹在 0~100：`>= NaN` 恒 false（空数组=看起来数据全没了），
        `>= 200` 也恒 false（把好岗位也滤光）。0 = 不限。 */
  function readMinFit() {
    try {
      var v = parseInt(localStorage.getItem('jh.collectMinFit'), 10);
      return (isNaN(v) || v <= 0) ? 0 : Math.min(v, 100);
    } catch (e) { return 0; }
  }
  function writeMinFit(n) {
    try { localStorage.setItem('jh.collectMinFit', String(n)); } catch (e) { /* 存不了就只在内存里生效 */ }
  }

  /**
   * 从候选池里挑出最精准的 N 条（N<=0 = 不限）。
   *
   * ⛔ 与 `CF.sort` 的区别：sort 只改**显示顺序**，这个会真的**砍掉**后面的。
   *    用户说的「我设 50 条 = 最终最精准的 50 条」指的就是这件事。
   * ⛔ 必须**自己按合适度排**，不能沿用 CF.sort —— 用户可能正把显示排序设成
   *    「薪资高到低」，那时候直接切前 N 条 = "薪资最高的 N 条"，跟精准毫无关系。
   * ⛔ 被硬性剔除的（gate.drop）一律沉底后再切，否则会把"明显不该投的"选进来。
   */
  function pickTop(arr) {
    var n = CF.wanted;
    if (typeof n !== 'number' || isNaN(n) || n <= 0) return arr;
    if (!arr || !arr.length) return arr;
    cfFitAll(arr);                       // 先算分，保证候选池里每个都有分数
    var sorted = arr.slice().sort(function (a, b) {
      var x = cfFitOf(a), y = cfFitOf(b);
      var xd = (x && x.gate && x.gate.drop) ? 1 : 0;
      var yd = (y && y.gate && y.gate.drop) ? 1 : 0;
      if (xd !== yd) return xd - yd;
      return ((y && y.total) || 0) - ((x && x.total) || 0);
    });
    return sorted.slice(0, n);
  }

  /**
   * 🎯 精选的状态行文案。⛔ 候选不够时要**明说原因**，别让用户以为筛选坏了 ——
   * 「我要 50 条却只出 7 条」最容易让人得出"这工具不行"的结论。
   */
  function wantedInfoText(pool, picked) {
    var n = CF.wanted;
    if (typeof n !== 'number' || isNaN(n) || n <= 0) return '';
    if (!pool) return '候选池是空的 —— 先放宽筛选，或再采一轮。';
    if (pool <= n) {
      return '⚠️ 候选池只有 ' + pool + ' 条，不够你要的 ' + n + ' 条 —— ' +
        '提高「每个关键词抓多少条」、多加几个关键词，或放宽筛选条件。';
    }
    return '已从 ' + pool + ' 条候选里按合适度选出前 ' + picked + ' 条' +
      '（另 ' + (pool - picked) + ' 条没选上；填 0 可以看全部）。';
  }

  /**
   * 一屏显示多少条。
   * ⛔ 精选开了就至少要能显示出精选的全部 —— 否则"我要 50 条"只看到 40 条
   *    （RESULT_PAGE），还得点一次「加载更多」，观感像没生效。
   */
  function resultPageSize() {
    var n = CF.wanted;
    if (typeof n !== 'number' || isNaN(n) || n <= 0) return RESULT_PAGE;
    return Math.max(RESULT_PAGE, n);
  }

  /* ---- 采集表单「纯前端字段」的 localStorage 兜底（评审 P1-3.1）----
     degree/experience/scale/stage/jobType 这几个由服务端 current_params 回吐
     （crawl_params.json 是权威），不用这里存。
     剩下 welfare/activeTime/expectJobs/district/bizArea 是**纯工作台侧字段**：
     BOSS 搜索接口没有对应参数、爬虫也不写它们，服务端也回吐不出来。
     不落盘的话用户 F5 一下全丢 —— 这里存一份，刷新后恢复。
     清单见下方的 FORM_SAVE_FIELDS（⚠️ 加字段记得往那儿加）。 */
  var FORM_SAVE_KEY = 'jh.collectForm';

  /* 「② 采集参数」的折叠状态。存 localStorage → 刷新/切页回来不弹回。
     ⛔ 只影响那一块的显示，不改任何参数 —— 折叠不是"停用"。 */
  var PARAM_OPEN_KEY = 'jh.collectParamOpen';
  function readParamOpen() {
    try { return localStorage.getItem(PARAM_OPEN_KEY) !== '0'; } catch (e) { return true; }
  }

  /**
   * 「本地优先」的表单字段：这几项的权威在**用户手上**，服务端那份只是回声。
   *
   * 为什么需要它：服务端 `current_params()` 读的是 `crawl_params.json`，而那个文件
   * **只在真正跑过采集之后才被写**。所以「改了参数 → 没跑采集 → 刷新页面」会静默回落，
   * 用户看到的就是「改了没用」。实测（真机 CDP）：
   *   条数改 20 → 同一会话内重画还是 20（内存里对）→ **新会话又变回 50**。
   *
   * ⛔ 故意**不含 city / district / bizArea**：这三项要**自动继承**求职偏好
   *    （见 geoSeedFor / cityJoin），一旦本地优先，「改偏好 → 采集页跟着变」立刻失灵 ——
   *    那正是第 21 轮刚修掉的 bug。校验用的一致性交给 geoSeedFor 的城市比对。
   *    也**不含** expectJobs / welfare / activeTime：它们本来就已经是本地优先（在下面清单里）。
   *
   * ✅ `salaryMin` / `salaryMax`（自定义薪资区间，K）**在**清单里：它们是用户手填的数字，
   *    而且服务端 `current_params()` 根本不回吐它们 —— 不本地优先就是"改了刷新即丢"。
   *    注意它们与 `salary`（BOSS 档位）是**两个独立条件**：档位走那个的是搜索条件，
   *    区间只在采回来后本地精筛（理由见参数卡里薪资那一段的注释）。
   */
  var LOCAL_FIRST_FIELDS = ['count', 'keywords', 'salary', 'crawlMode',
    'degree', 'experience', 'scale', 'stage', 'jobType', 'salaryMin', 'salaryMax'];

  /* ⛔ 落盘字段清单 —— **这里漏一个，那个字段就是刷新即丢**。
     `district` / `bizArea` 曾经不在清单里，而服务端 `current_params()` 也不回吐它们
     （见 采集器/server.py 的注释），于是「采集页选的区 / 商圈」**两条兜底路径都没有**：
     改了不跑采集就刷新 = 白选。这一行就是补那个洞。
     `count` / `keywords` / `salary` / `degree` … 同样补过一轮：它们虽然**在**服务端回吐清单里，
     但那一份只是「上一次采集实际用过的参数」（crawl_params.json 只在跑采集时才写）——
     用户改完不跑采集就刷新，照样静默回落到旧值（实测：条数改 20 → 新会话又变 50）。 */
  var FORM_SAVE_FIELDS = ['welfare', 'activeTime', 'expectJobs', 'district', 'bizArea', 'province',
    'includeKnown']
    .concat(LOCAL_FIRST_FIELDS);

  function readSavedForm() {
    try {
      var raw = localStorage.getItem(FORM_SAVE_KEY);
      var o = raw ? JSON.parse(raw) : null;
      return (o && typeof o === 'object') ? o : {};
    } catch (e) { return {}; }
  }
  function saveForm() {
    var f = S.form;
    if (!f) return;
    var prev = readSavedForm();
    var out = {};
    FORM_SAVE_FIELDS.forEach(function (k) {
      var v = f[k];
      out[k] = Array.isArray(v) ? v.slice() : (v == null ? '' : v);
    });
    /* 区 / 商圈：用户没主动动过就不写（保留上一次存的，或保持"压根没存过"）。
       ⛔ 不加这道闸会出现一个很隐蔽的回归：只要在采集页碰过任何一个控件，
         saveForm 就把**继承来的**区/商圈当成用户的表态固化下来；
         之后他在岗位库改了期望区，采集页却再也不跟着变了 ——
         表现和「继承从来没生效」一模一样，等于白修。 */
    if (!S.geoOwned) {
      ['district', 'bizArea'].forEach(function (k) {
        if (k in prev) out[k] = prev[k]; else delete out[k];
      });
    }
    try { localStorage.setItem(FORM_SAVE_KEY, JSON.stringify(out)); }
    catch (e) { /* 隐私/配额都不该挡采集 */ }
  }

  /* ⛔ 渲染时**绝不**调 saveForm()（只在用户真的动了表单时调，见 touchForm）。
     否则「打开一次采集页」就把当前表单写进 jh.collectForm，而表单初值有一部分是
     从求职偏好继承来的 → 「改偏好 + 打开采集页」就能把继承结果固化，
     看起来就像**偏好把采集页改了**。两边必须互不影响。 */
  function touchForm() {
    if (S.form) saveForm();
  }

  /* ---- 城市：采集页存「逗号分隔字符串」，偏好存数组。
     换算只此一份（js/collect-prefs.js）—— 两处各写一遍必然飘。 ---- */
  function cityList(s) {
    if (global.CollectPrefs) return global.CollectPrefs.splitCity(s);
    return String(s == null ? '' : s).split(/[,，、\/\s]+/)
      .map(function (x) { return x.trim(); }).filter(Boolean);
  }
  function cityJoin(a) {
    if (global.CollectPrefs) return global.CollectPrefs.joinCity(a);
    return (a || []).filter(Boolean).join(', ');
  }

  /**
   * 采集页「省」的初值 —— **由城市反推**，因为城市才是权威（真正传给 BOSS 的东西），
   * 省只是用来收窄城市候选的 UI 状态。两者不自洽时，界面会显示「选了浙江省、
   * 城市却是上海」这种自相矛盾的状态，用户第一反应是"这工具坏了"。
   *
   * 优先级：
   *   ① 城市能推出**唯一**的省（多城市同省才算）→ 用推出来的
   *   ② 推不出来（城市为空 / 跨省多城市 / 城市未收录）→ 用存过的省
   *      ⛔ 跨省多城市时退回存过的值而**不是清空** —— 省表达不了"跨省"这件事，
   *         清空等于顺手删掉用户上次的选择；留着顶多是多一层收窄，看得见、可取消。
   *   ③ 都没有 → 空（=「不限省」，城市候选回到全量）
   */
  function deriveProvince(savedProv, city) {
    var saved = String(savedProv == null ? '' : savedProv).trim();
    var cs = cityList(city);
    if (global.GEO && global.GEO.provinceOfCity && cs.length) {
      var ps = cs.map(function (c) { return global.GEO.provinceOfCity(c); });
      // 每个城市都判得出省，且这些省是同一个 —— 才敢回填
      if (ps[0] && ps.every(function (x) { return x === ps[0]; })) return ps[0];
    }
    return saved;
  }

  /**
   * 采集页「区 / 商圈」的初值（纯函数 —— 测试直接喂）。
   * 优先级：
   *   ① `jh.collectForm` 里显式存过 → 用存的（**空的也算存过**：用户就是清空的）
   *   ② 一次都没存过 → 继承求职偏好，但**只在城市对得上时**
   *   ③ 城市对不上 / 偏好也没有 → 空（不选就是不限）
   *
   * ⛔ 为什么城市对不上就不继承：偏好是「杭州 > 滨江区」，这次却要搜上海 ——
   *    继承过来的区一个都命中不了，采集结果会被精筛成**空列表**（不报错，只是没东西）。
   *    那种"我明明设了筛选却什么都没有"比干脆不继承更糟。
   *
   * ⛔ 为什么判的是「存过没存过」而不是「非空」：用户手动清空过区就得尊重他的清空，
   *    不能下次刷新又从偏好里长回来。想要回来，点「⤓ 从求职偏好带入」。
   *
   * 返回 { district, bizArea, src }，src ∈ saved/prefs/city-mismatch/none（给测试和文案用）。
   */
  function geoSeedFor(saved, city, P) {
    saved = saved || {}; P = P || {};
    if ('district' in saved || 'bizArea' in saved) {
      return { district: U.asArray(saved.district).slice(), bizArea: U.asArray(saved.bizArea).slice(), src: 'saved' };
    }
    var mine = String(city == null ? '' : city).split(/[,，、\/\s]+/).filter(Boolean);
    var theirs = U.asArray(P.cities);
    var matched = !mine.length || !theirs.length || mine.some(function (x) {
      return theirs.some(function (y) { return x.indexOf(y) >= 0 || y.indexOf(x) >= 0; });
    });
    if (!matched) return { district: [], bizArea: [], src: 'city-mismatch' };
    var d = U.asArray(P.districts), b = U.asArray(P.bizAreas);
    return {
      district: d.slice(), bizArea: b.slice(),
      src: (d.length || b.length) ? 'prefs' : 'none',
    };
  }

  /* ==================== 采集条件 ⇄ 求职偏好：手动搬 ====================
     两个方向（⤓ 带入 / ⤒ 存为偏好）共用 js/collect-prefs.js 里的唯一换算表。
     ⛔ 落盘一律在**用户点了确认**之后 —— 不做自动同步（理由见 paramCard 里的注释）。
     薪资的「档位 ⇄ 数字K」换算需要 SALARY_BAND / bandCovering，那两个的主人在这里，
     所以由这边注入，不在 collect-prefs.js 里抄第二份。 */
  function prefOpts() {
    return { bandCovering: bandCovering, salaryBand: SALARY_BAND };
  }

  /** 偏好 → 采集页 的差异计划（没有差异时 steps 为空数组，不是 null）。 */
  function formPullPlan() {
    if (!global.CollectPrefs || !global.JobMatch || !S.form) return null;
    return global.CollectPrefs.planFromPrefs(S.form, global.JobMatch.prefs(), prefOpts());
  }

  /** 「⤓ 从求职偏好带入」：点确认后才把 patch 落进 S.form，并**只写采集侧**的存储。 */
  function pullFromPrefs() {
    var plan = formPullPlan();
    if (!plan) {
      U.toast('偏好模块没加载（js/job-match.js 或 js/collect-prefs.js）', 'bad');
      return;
    }
    Comp.planDialog({
      title: '⤓ 从求职偏好带入采集条件',
      subtitle: '把岗位库「⚙ 我的求职偏好」里<b>已经填了</b>的条件搬到这次的采集表单上。' +
        '<b>不会动偏好本身</b> —— 两边是两套独立数据。',
      steps: plan.steps,
      emptyText: '偏好里这几项要么没填、要么和采集页已经一样，<b>没有要改的</b>。',
      confirmText: '带入这 ' + plan.steps.length + ' 项',
      patch: plan.patch,
      onConfirm: function (patch) {
        global.CollectPrefs.applyFormPatch(S.form, patch);
        /* 区 / 商圈被显式写入 → 从此归用户所有，之后不再自动跟着偏好走
           （否则下次刷新又会用"偏好优先"把刚带进来的值盖回去）。 */
        if (patch.district || patch.bizArea) S.geoOwned = true;
        saveForm();
        U.toastHtml('已从偏好带入 <b>' + plan.steps.length + '</b> 项（偏好本身没动）', 'ok', 5000);
        // 关窗之后再重画（先落值、再关窗、最后重绘）
        setTimeout(function () { App.refresh(); }, 0);
      },
    });
  }

  /** 采集页 → 偏好 的差异计划（给岗位库偏好面板的「⤒」按钮用）。 */
  function prefsPushPlan() {
    if (!global.CollectPrefs || !global.JobMatch) return null;
    /* ⛔ 采集页从来没进过 → S.form 还是 null，"当前采集条件"根本不存在。
       这时候返回空计划会被显示成「没有要改的」，属于撒谎 —— 返回 null 让调用方说实话。 */
    if (!S.form) return null;
    return global.CollectPrefs.planToPrefs(S.form, global.JobMatch.prefs(), prefOpts());
  }

  /* ---- 采集方案（预设）----
     §五-1：把「关键词 + 城市 + 全维度筛选」存成命名方案，一键切换。
     用户实际是在几套「找法」之间来回切（比如「杭州·电商运营·10-20K」vs
     「上海·内容运营·不限」），比单纯持久化表单更进一步 —— 一键回到某套找法，
     不用每次重新点十几个 chip。
     方案本身只存表单字段（纯前端），跟服务端 crawl_params.json 无关：
     切方案 = 改 S.form = 下次「开始采集」时透传对应参数。 */
  var PRESETS_KEY = 'jh.collectPresets';

  /** 需要随方案一起保存的表单字段（全维度筛选，含本地筛的区/商圈/福利/活跃度）。 */
  var PRESET_FIELDS = [
    'province', 'city', 'keywords', 'expectJobs', 'salary', 'salaryMin', 'salaryMax',
    'count', 'crawlMode',
    'degree', 'experience', 'scale', 'stage', 'jobType',
    'welfare', 'activeTime', 'district', 'bizArea',
    'includeKnown',
  ];

  function readPresets() {
    try {
      var raw = localStorage.getItem(PRESETS_KEY);
      var arr = raw ? JSON.parse(raw) : null;
      return Array.isArray(arr) ? arr : [];
    } catch (e) { return []; }
  }
  function writePresets(arr) {
    try { localStorage.setItem(PRESETS_KEY, JSON.stringify(arr)); } catch (e) { /* 配额不足不挡采集 */ }
  }

  /** 从当前 S.form 抽出一份可保存的方案载荷（只取 PRESET_FIELDS，深拷贝数组）。 */
  function presetPayload(f) {
    f = f || S.form || {};
    var out = {};
    PRESET_FIELDS.forEach(function (k) {
      var v = f[k];
      out[k] = Array.isArray(v) ? v.slice() : (v === undefined ? '' : v);
    });
    return out;
  }

  /** 把一份方案载荷灌回 S.form（数组深拷贝，不共享引用）。 */
  function applyPresetToForm(payload) {
    payload = payload || {};
    var f = S.form;
    if (!f) return;
    PRESET_FIELDS.forEach(function (k) {
      var v = payload[k];
      if (Array.isArray(v)) f[k] = v.slice();
      else if (typeof v === 'string') f[k] = v;
      else if (typeof v === 'number') f[k] = v;
      /* ⛔ 布尔字段的 false 也是**有效值**（「采集已采过岗位」没勾就是 false）。
         少了这一行，方案里存的 false 会被当成「不作声」——切方案时清不掉
         上一个方案勾上的 true（`x || 默认值` 吞掉有效值的老坑，布尔版）。 */
      else if (typeof v === 'boolean') f[k] = v;
      /* ⛔ 数值型字段的 null 也是**有效值**（薪资区间没设就是 null）。
         少了这一行，方案里"没设薪资区间"会被当成"不作声"，切方案时就清不掉
         上一个方案留下的区间 —— 正是本项目那条「`x || 默认值` 吞掉有效值」的老坑。 */
      else if (v === null) f[k] = null;
    });
    if (!f.expectJobs) f.expectJobs = [];
  }

  /** 采集结果里的岗位 id 集合（已导入的）。用于「已导入/未导入」筛选。 */
  function importedKeySet() {
    var byKey = {};
    Store.jobs({ includeArchived: true }).forEach(function (j) { byKey[Store.jobDedupeKey(j)] = j; });
    return byKey;
  }

  /** 一个标准岗位对象是否已导入岗位库 */
  function isImported(j, byKey) {
    return !!(byKey && byKey[Store.jobDedupeKey(j)]);
  }

  /** 采集结果里出现的城市列表（去重，用于下拉） */
  function resultCities(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (j) {
      // 城市一般写在 location 开头「杭州 · 西湖区」，取第一个「·」前的部分当城市；
      // 没有「·」就直接用整段（可能是纯「杭州」）。
      var raw = String(j.location || '').trim();
      if (!raw) return;
      var city = raw.split(/[·・\s]/)[0].trim();
      if (!city || seen[city]) return;
      seen[city] = true;
      out.push(city);
    });
    return out;
  }

  /** 采集结果里出现的行业列表（去重，用于下拉） */
  function resultIndustries(list) {
    var seen = {}, out = [];
    (list || []).forEach(function (j) {
      var ind = String(j.industry || '').trim();
      if (!ind || seen[ind]) return;
      seen[ind] = true;
      out.push(ind);
    });
    return out;
  }

  /**
   * 采集结果里出现的「区」。
   * ⛔ **只来自这批结果真实采到的** —— 不复用 GEO.districtsOf（那个会把内置行政区划并进来，
   *    于是下拉里会冒出「选了显示 0 条」的选项，用户会以为筛选坏了）。
   *    要手输更细的，走关键词框。
   */
  function resultDistricts(list, city) {
    var seen = {}, out = [];
    (list || []).forEach(function (j) {
      if (city && String(j.location || '').indexOf(city) < 0) return;
      var d = global.GEO ? global.GEO.extractDistrict(j) : String(j.district || '').trim();
      if (!d || seen[d]) return;
      seen[d] = true;
      out.push(d);
    });
    return out;
  }

  /** 采集结果里出现的「商圈」（同上：只认真实数据，⛔ 绝不内置）。 */
  function resultBizAreas(list, districts) {
    var seen = {}, out = [];
    if (!global.GEO) return out;   // 没有 geo.js 就别猜（老版本的 district 字段不叫商圈）
    var ds = U.asArray(districts);
    (list || []).forEach(function (j) {
      if (ds.length) {
        var d = global.GEO.extractDistrict(j);
        if (!d || !ds.some(function (x) { return d.indexOf(x) >= 0 || x.indexOf(d) >= 0; })) return;
      }
      var b = global.GEO.extractBizArea(j);
      if (!b || seen[b]) return;
      seen[b] = true;
      out.push(b);
    });
    return out;
  }

  /** 当前生效的地理条件（结果页用）。没填就返回 null。 */
  function cfGeo() {
    var ds = U.asArray(CF.district), bs = U.asArray(CF.bizArea);
    if (!ds.length && !bs.length) return null;
    return {
      districts: ds,
      bizAreas: bs,
      landmark: '',
      strict: false,   // ⛔ 没采到区/商圈的不在这里筛掉（标出来，见 listUnknownGeo）
    };
  }

  /** 按 CF 筛采集结果这批岗位 */
  function filterResults(list) {
    var arr = (list || []).slice();

    /* 「只看本次新增」：只保留本轮采集真正写进去的岗位（后端按 round_links.json
       打的 isNew）。旧池里的历史岗位不显示 —— 这是用户区分「我刚采的」与
       「以前攒的」的唯一手段（以前结果区把整个累积池说成「本批」）。 */
    if (CF.onlyNew) arr = arr.filter(function (j) { return !!j.isNew; });

    if (CF.city) arr = arr.filter(function (j) {
      return String(j.location || '').indexOf(CF.city) >= 0;
    });

    /* 区 / 商圈精筛：与岗位库筛选栏同一口径（GEO.geoHit）。
       ⛔ 没引上 geo.js 就整块跳过 —— 宁可放过几条，也不要因为一个脚本没引上把列表筛空。 */
    var g = cfGeo();
    if (g && global.GEO) arr = arr.filter(function (j) { return global.GEO.geoHit(j, g); });

    if (CF.industry) arr = arr.filter(function (j) { return j.industry === CF.industry; });
    // 岗位名（单选）：复用 JobMatch.jobHit —— 双向包含判定，
    // 选「内容运营」能筛到「内容运营主管」，选长标题也能筛到短的。
    if (CF.job && global.JobMatch) {
      arr = arr.filter(function (j) { return global.JobMatch.jobHit(j, [CF.job]); });
    }
    /* A2 · 薪资档位两阶段说明：参数卡选的档位已在采集时透传 BOSS 服务端，
       由服务端决定「这次采多少」；这里是对**跨轮累积的结果池**再筛「显示多少」。
       两处都查 SALARY_BAND、都按区间重叠判定，口径一致，不是重复逻辑 ——
       服务端筛的是「新采的这一批」，这里筛的是「历史 + 新采的全量」。 */
    if (CF.salary) arr = arr.filter(function (j) {
      if (CF.salary === 'none') return j.salaryMin === null && j.salaryMax === null;
      var b = SALARY_BAND[CF.salary];
      if (!b) return true;   // 认不出的档位就不筛（宁可放过，别误杀）
      var v = j.salaryMin !== null ? j.salaryMin : j.salaryMax;
      // BOSS 薪资是区间重叠判定：下限落进档内即算命中（与参数卡口径一致）。
      return v !== null && v >= b[0] && v < b[1];
    });

    /* 自定义薪资区间（本地精筛）：与上面的档位是**两个独立条件**，两个都填就是"与"。
       ⛔ 单独一条 if、不去改写上面那段档位查表 —— 那一行是自证变异的锚点，
          改写它会让那条变异打偏（改了但没改到位 → 假绿）。 */
    var salLo = (typeof CF.salaryMin === 'number' && CF.salaryMin > 0) ? CF.salaryMin : null;
    var salHi = (typeof CF.salaryMax === 'number' && CF.salaryMax > 0) ? CF.salaryMax : null;
    if (salLo !== null || salHi !== null) {
      arr = arr.filter(function (j) { return salaryRangeHit(j, salLo, salHi); });
    }

    if (CF.scored === 'scored') arr = arr.filter(function (j) { return global.JobMatch.hasScore(j); });
    else if (CF.scored === 'unscored') arr = arr.filter(function (j) { return !global.JobMatch.hasScore(j); });

    /* 🤖 AI 清洗判定（P0）：纯展示过滤，选回 '' 立刻放回全部。
       ⛔ 没有 AI 判定的岗位在「按判定筛」时被排除是正确的 ——
          用户主动选了「只看对口」，没有结论的不该混进来充数。
       ⛔ 单独一条 if，不改写上面 scored 那两行（它们是变异锚点）。 */
    if (CF.aiCleanVerdict) {
      arr = arr.filter(function (j) {
        var v = aiVerdictOf(j);
        return !!(v && v.verdict === CF.aiCleanVerdict);
      });
    }

    /* 福利待遇（多选，任一命中即保留）。
       ⚠️ 修一个真 bug：原来写的是 `b.indexOf(w) >= 0`（在 benefits **数组**里找元素），
          但采回来的 benefits 常常是**只有一个元素、里面是一整串**
          （"交通补助 有无线网 工龄奖 … 五险一金"）→ 数组里永远找不到"五险一金"，
          **勾了福利结果就全空**。改用 job-match.js 的统一口径（拼串 + 正则 + 多种写法）。 */
    if (CF.welfare && CF.welfare.length) {
      arr = arr.filter(function (j) { return global.JobMatch.welfareHit(j, CF.welfare, 'any'); });
    }

    // BOSS 活跃度（单选）：按「时间包含」判定 —— 选「3日内活跃」时，「刚刚活跃/今日活跃/
    // 3日内活跃」都命中（今天在 3 日内）。以前 `a.indexOf(CF.active)` 是「岗位字段包含所选词」
    // 的反向包含，选「3日内」会把「今日活跃」的岗位筛掉，注释却写着相反的话（评审 P2-4）。
    if (CF.active) {
      var wantRank = activeRank(CF.active);
      arr = arr.filter(function (j) {
        return activeRank(String(j.active || '')) <= wantRank;
      });
    }

    if (CF.kw) {
      var q = global.JobMatch.parseQuery(CF.kw);
      if (q && q.matched) {
        arr = arr.filter(function (j) { return global.JobMatch.passQuery(j, q); });
      } else {
        var k = CF.kw.toLowerCase();
        arr = arr.filter(function (j) { return global.JobMatch.keywordHay(j).indexOf(k) >= 0; });
      }
    }

    /* 本地合适度：先算分，再按分级 / 是否剔除 / 切合值筛。
       零 token，所以可以每批结果都算一遍，不心疼。 */
    cfFitAll(arr);
    if (CF.hideDrop) arr = arr.filter(function (j) { return !cfFitOf(j).gate.drop; });
    if (CF.fit) {
      arr = arr.filter(function (j) {
        var r = cfFitOf(j);
        return !r.gate.drop && r.level.key === CF.fit;
      });
    }
    /* 🎯 切合值：连续「≥ N 分」过滤（0 = 不限）。
       ⛔ 硬性剔除的（gate.drop）即使分数看着高也**不放行** —— drop 是「实质不符/城市不对」
          这种一票否决，分数是另一回事，两者独立。 */
    if (CF.minFit > 0) {
      arr = arr.filter(function (j) {
        var r = cfFitOf(j);
        return !r.gate.drop && (r.total || 0) >= CF.minFit;
      });
    }

    /* 🎯 简历匹配度区间（P2）：对服务端简历匹配分（j.matchScore，0-100）做自由范围过滤。
       ⛔ 没跑过简历匹配的岗位没有 matchScore —— 设了区间就把它们**筛掉**（用户要的
       是「匹配度落在 60-100 里」的岗位，没分的不算）。与上面 minFit 独立：一个是本地
       规则切合值，一个是服务端简历匹配分（含 LLM 二筛）。 */
    var matchLo = (typeof CF.matchMin === 'number' && !isNaN(CF.matchMin)) ? CF.matchMin : null;
    var matchHi = (typeof CF.matchMax === 'number' && !isNaN(CF.matchMax)) ? CF.matchMax : null;
    if (matchLo !== null || matchHi !== null) {
      arr = arr.filter(function (j) {
        var s = (typeof j.matchScore === 'number') ? j.matchScore : null;
        if (s === null) return false;
        if (matchLo !== null && s < matchLo) return false;
        if (matchHi !== null && s > matchHi) return false;
        return true;
      });
    }

    var sorters = {
      default: function (a, b) { return 0; },   // 保持采集原始顺序
      salary: function (a, b) { return (b.salaryMax || b.salaryMin || 0) - (a.salaryMax || a.salaryMin || 0); },
      score: function (a, b) {
        var x = (a.aiVerdict && a.aiVerdict.score) || -1;
        var y = (b.aiVerdict && b.aiVerdict.score) || -1;
        return y - x;
      },
      // 本地合适度：被硬性剔除的沉底，其余按分数降序
      fit: function (a, b) {
        var x = cfFitOf(a), y = cfFitOf(b);
        var xd = x.gate && x.gate.drop ? 1 : 0, yd = y.gate && y.gate.drop ? 1 : 0;
        if (xd !== yd) return xd - yd;
        return (y.total || 0) - (x.total || 0);
      },
      company: function (a, b) { return String(a.company).localeCompare(String(b.company), 'zh'); },
    };
    return arr.sort(sorters[CF.sort] || sorters.default);
  }

  /** 分级计数（不带分级筛选时这批结果里各级各有多少） */
  function fitSummary(list) {
    var sf = CF.fit, sd = CF.hideDrop;
    var arr;
    try {
      CF.fit = ''; CF.hideDrop = false;
      arr = filterResults(list);
    } finally {
      CF.fit = sf; CF.hideDrop = sd;
    }
    var out = { A: 0, B: 0, C: 0, D: 0, drop: 0, blind: 0, total: arr.length };
    arr.forEach(function (j) {
      var r = cfFitOf(j);
      if (!r) return;
      if (r.gate.drop) { out.drop++; return; }
      out[r.level.key]++;
      if (r.blind) out.blind++;
    });
    return out;
  }

  /** 是否设置了任一采集筛选条件 */
  function collectHasFilter() {
    return !!(CF.kw || CF.job || CF.city ||
      U.asArray(CF.district).length || U.asArray(CF.bizArea).length ||
      CF.industry || CF.salary || CF.scored ||
      /* ⛔ 自定义薪资区间也算「有筛选」—— 漏了它，**只设区间**时「✕ 清空筛选」
         按钮就不出现，用户再也关不掉这个条件。
         （真机实测踩到：设了 15~25K 之后清空按钮消失、条数卡在 2 条。
           本项目的老规矩：能开的功能必须有关掉的地方。）
         判断用 typeof 而不是 `!== null`：undefined 也不能被当成"设过了"。 */
      typeof CF.salaryMin === 'number' || typeof CF.salaryMax === 'number' ||
      (CF.welfare && CF.welfare.length) || CF.active || CF.fit || CF.hideDrop || CF.onlyNew ||
      /* ⛔ 🎯 精选也算「有筛选」—— 漏了它，用户设了"只要 50 条"之后
         「✕ 清空筛选」不出现，这个条件就**再也关不掉**了。
         （本项目老规矩：能开的功能必须有关掉的地方。自定义薪资区间就是这么栽过一次的。） */
      (typeof CF.wanted === 'number' && !isNaN(CF.wanted) && CF.wanted > 0) ||
      /* 切合值同理：设了「≥ 60 分」却没「清空筛选」出口 = 关不掉。 */
      (typeof CF.minFit === 'number' && !isNaN(CF.minFit) && CF.minFit > 0) ||
      /* 简历匹配度区间（P2）也算「有筛选」—— 设了区间就得有关掉的地方。 */
      (typeof CF.matchMin === 'number' && !isNaN(CF.matchMin)) ||
      (typeof CF.matchMax === 'number' && !isNaN(CF.matchMax)) ||
      /* ⛔ 🤖 AI 判定筛选同理：选了「只看对口」却清不掉 = 关不掉。
         本项目已经为「自定义薪资区间」栽过一次，别在同一个坑里摔第二次。 */
      !!CF.aiCleanVerdict);
  }

  /** 清空结果区全部筛选条件 */
  function clearCF() {
    CF.kw = ''; CF.job = ''; CF.city = ''; CF.district = []; CF.bizArea = [];
    CF.industry = ''; CF.salary = '';
    CF.salaryMin = null; CF.salaryMax = null;
    CF.scored = ''; CF.welfare = []; CF.active = ''; CF.sort = 'default';
    CF.fit = ''; CF.hideDrop = false; CF.onlyNew = false;
    CF.wanted = 0; writeWanted(0);      // 🎯 精选也要能关掉（并同步落盘）
    CF.minFit = 0; writeMinFit(0);      // 切合值同理，也要能关掉
    CF.matchMin = null; CF.matchMax = null;   // 简历匹配度区间同理
    CF.aiCleanVerdict = '';                    // 🤖 AI 判定筛选也要能一键清掉
  }

  /**
   * 把采集参数卡里填的「区 / 商圈 / 福利 / 活跃度」搬进结果页筛选。
   * 这几项**不进 BOSS 搜索条件**（见参数卡上的说明），所以采集一跑完就搬过来 ——
   * 用户在参数卡上写了什么，结果出来就该是筛过的；不搬他会以为填了没用。
   * ⛔ 只在「采集刚跑完」时搬一次，不覆盖用户之后在结果页自己改的筛选。
   */
  function seedCFFromForm() {
    var f = S.form || {};
    if (global.GEO) {
      CF.district = U.asArray(f.district).slice();
      CF.bizArea = U.asArray(f.bizArea).slice();
    }
    if (U.asArray(f.welfare).length) CF.welfare = U.asArray(f.welfare).slice();
    if (f.activeTime) CF.active = f.activeTime;
    // 薪资也搬过来（评审 P2-2）：参数卡选了「10-20K」，结果页也该按它筛 —— 以前
    // 只搬区/商圈/福利/活跃度、不搬薪资，用户会在结果页看到一堆不在档内的岗位，
    // 以为筛选没生效。现在结果页与参数卡统一用 BOSS 同款档，所以能直接搬。
    if (f.salary) CF.salary = f.salary;
    /* 自定义薪资区间也搬过去 —— 与档位是**两个独立条件**，两个都搬才对得上参数卡。
       ⚠️ 这两个一律赋值（含 null）：只搬非空的话，用户在参数卡里清掉区间后再跑采集，
          结果页会留着上一次的区间继续筛，看起来就是"清不掉"。 */
    CF.salaryMin = (typeof f.salaryMin === 'number') ? f.salaryMin : null;
    CF.salaryMax = (typeof f.salaryMax === 'number') ? f.salaryMax : null;
  }

  /** 生效中的地理筛选下面，有几条是「因为没采到区/商圈」才被放行的 */
  function listUnknownGeo(list) {
    var g = cfGeo();
    if (!g || !global.GEO) return { n: 0, total: (list || []).length };
    var n = 0;
    (list || []).forEach(function (j) { if (global.GEO.unknownArea(j, g)) n++; });
    return { n: n, total: (list || []).length };
  }

  /** 「🤖 给结果一键评分」—— 只作用于采集结果里的那些岗位 */
  function scoreResults(list) {
    list = list || resultUnscored();
    if (!list.length) {
      U.toast('采集结果里的岗位都已经评过分了。想重跑就点岗位库右上角的「🤖 按简历推荐」。', 'info', 6000);
      return;
    }
    global.JobMatch.openBatch({
      scopes: [{ label: '采集结果里的岗位', jobs: list }],
      afterRun: function () { App.refresh(); },
    });
  }

  /* ==================== AI 采集清洗（P0） ==================== */

  /**
   * AI 清洗的判定结果存在哪。
   * ⛔ **不写库**（不碰 Store.updateJob / save）：采集结果对象还没入库，
   *   而且判定是「可回滚的展示层结论」—— 写库后用户想撤销就撤不掉了。
   * 用 Map 按**对象引用**存，理由与 CF_FIT 完全一样：采集结果对象此时还没有 id，
   * 拿 j.id 当键会让整批落到 `[undefined]`。（见上面 CF_FIT 的注释）
   */
  var AI_CONF = new Map();

  /** 稳定的判定键：用 url（采集结果一定有 url）当键。
      ⛔ 不能用对象引用（评审核实 2026-10-30，P0-8）：
         resultJobs() 每次渲染都用 fromCrawlerRecord 重新 map 出**全新对象**，
         按引用存的 Map 在 App.refresh() 之后全部失配 → 判定消失、筛选条不见，
         再点清洗会对同一批**重新计费**。url 是这批对象里唯一稳定的业务键。 */
  function aiVerdictKey(j) {
    if (!j) return null;
    return String(j.url || j.link || '').trim() || null;
  }

  /** 某个采集结果岗位的 AI 判定（没有就 null） */
  function aiVerdictOf(j) {
    var k = aiVerdictKey(j);
    return (k ? AI_CONF.get(k) : null) || (j && j.aiCollect) || null;
  }

  /** 这批结果里有多少条还没有 AI 判定 */
  function aiPendingCount(list) {
    var n = 0;
    (list || []).forEach(function (j) { if (!aiVerdictOf(j)) n++; });
    return n;
  }

  /** 是否应该显示「AI 清洗」入口：开关开着 + 配了模型 + 有结果 */
  function aiCleanEnabled() {
    var s = (Store.settings().ai || {});
    return !!s.collectClean && !!(global.AI && global.AI.ready());
  }

  /**
   * 打开「AI 清洗」弹窗：先给预估，确认了才花钱。
   * ⚠️ 遵循弹窗三条铁律：① 回调先落值再关窗 ② onClose 用 setTimeout ③ 不调 App.refresh()
   */
  function openAiCleanModal() {
    if (!global.AICollect) {
      U.toast('AI 清洗模块没加载（js/ai-collect.js）。', 'bad');
      return;
    }
    if (!global.AI.ready()) {
      U.toast('还没配置模型接口。去「设置 → ① 大模型接口」填好 API Key。', 'warn', 8000);
      return;
    }

    var all = resultJobs();
    if (!all.length) {
      U.toast('还没有采集结果。先跑一次采集。', 'info');
      return;
    }
    var todo = all.filter(function (j) { return !aiVerdictOf(j); });
    if (!todo.length) {
      U.toast('这批结果都已经 AI 清洗过了。想重跑请先点「🔄 重置判定」。', 'info', 7000);
      return;
    }

    var profile = global.AICollect.profileOf();
    var est = global.AICollect.estimateAll(todo, profile);

    var box = el('div', { class: 'stack', style: 'gap:10px;min-width:min(520px,80vw)' });
    box.appendChild(el('div', { class: 'fs13', html:
      '将对 <b>' + todo.length + '</b> 个岗位做 AI 判断（分 <b>' + est.batches + '</b> 批）。' +
      '<br>判定结果只用来<b>打标和筛选</b>，<b>不删除</b>任何岗位 —— 随时能放回全部。' }));

    box.appendChild(el('div', { class: 'note info' }, [
      el('span', { class: 'ico', text: '💰' }),
      el('div', { html:
        '预计消耗 输入 <b>' + est.inT + '</b> + 输出 <b>' + est.outT + '</b> token，' +
        '约 <b>¥' + est.cost.toFixed(4) + '</b><br>' +
        '<span class="fs11 muted">单价来源：' + U.esc(est.priceFrom) +
        '（' + est.priceIn + ' / ' + est.priceOut + ' 元每百万 token）</span>' }),
    ]));

    if (profile.direction) {
      box.appendChild(el('div', { class: 'fs12 muted', text: '判断依据（求职方向）：' + profile.direction }));
    } else {
      box.appendChild(el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '⚠' }),
        el('div', { html: '设置里没填求职方向关键词，判断会偏保守（大量 uncertain）。' +
          '建议先去设置页填「求职方向」。' }),
      ]));
    }

    U.openModal({
      title: '🤖 AI 清洗这批结果',
      body: box,
      footer: [
        { text: '开始（约 ¥' + est.cost.toFixed(4) + '）', cls: 'pri', onClick: function (c) {
          c();
          // ⚠️ onClose 是异步的，这里用 setTimeout 让弹窗先关干净再跑
          setTimeout(function () { runAiClean(todo, profile); }, 0);
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  /** 真跑 AI 清洗，带进度弹窗 */
  function runAiClean(todo, profile) {
    var total = todo.length;
    var prog = el('div', { class: 'fs13', text: '准备中…' });
    var bar = el('div', { class: 'fs12 muted', text: '' });
    var wrap = el('div', { class: 'stack', style: 'gap:8px;min-width:min(420px,76vw)' }, [prog, bar]);

    U.openModal({
      title: '🤖 正在 AI 清洗…',
      size: 'sm',
      body: wrap,
      footer: [{ text: '后台进行', cls: 'pri', onClick: function (c) { c(); } }],
    });

    global.AICollect.clean(todo, {
      onProgress: function (done, all) {
        prog.textContent = '已完成 ' + done + ' / ' + all + ' 批（' + Math.min(done * global.AICollect.BATCH_SIZE, total) + ' / ' + total + ' 条）';
      },
      onUsage: function (u) {
        if (!u) return;
        bar.textContent = '本批输入 ' + (u.prompt_tokens || 0) + ' / 输出 ' + (u.completion_tokens || 0) + ' token';
      },
    }).then(function (res) {
      // ⛔ 结果写进按 url 存的 Map，**不动原对象**（见 AI_CONF 注释）
      var applied = 0;
      (res.jobs || []).forEach(function (j) { if (j && j.aiCollect) applied++; });
      todo.forEach(function (j, i) {
        var nj = res.jobs[i];
        var k = aiVerdictKey(j);
        if (nj && nj.aiCollect && k) AI_CONF.set(k, nj.aiCollect);
      });

      var msg = 'AI 清洗完成：' + applied + ' 条有结论';
      if (res.failed) msg += '，' + res.failed + ' 批失败（那些岗位保持原样，可重跑）';
      if (res.usage && res.usage.cost) msg += '，实花 ≈¥' + res.usage.cost.toFixed(4);
      U.toast(msg, res.failed ? 'warn' : 'ok', 9000);

      // 弹窗自己关；重画结果卡让筛选条出现（不调 App.refresh，避免整页闪）
      U.closeAllModals(true);
      App.refresh();
    }).catch(function (e) {
      U.closeAllModals(true);
      var m = (e && e.code === 'NO_CONFIG')
        ? '还没配置模型接口。去「设置 → ① 大模型接口」填好 API Key。'
        : ('AI 清洗失败：' + U.esc((e && e.message) || '未知错误'));
      U.toast(m, 'bad', 10000);
    });
  }

  /** 清掉所有 AI 判定（可逆：判定本来就没落库） */
  function resetAiClean() {
    if (!AI_CONF.size) {
      U.toast('还没有 AI 判定结果。', 'info');
      return;
    }
    var n = AI_CONF.size;
    U.confirm('把 ' + n + ' 条岗位的 AI 判定全部清掉？<br>' +
      '<span class="fs12 muted">只是清掉标记，岗位本身一条都不会少。</span>').then(function (yes) {
      if (!yes) return;
      AI_CONF.clear();
      // ⚠️ U.confirm 是「先 resolve、再关窗」⇒ 直接 App.refresh() 会踩空，必须 setTimeout
      setTimeout(function () { App.refresh(); }, 0);
      U.toast('已清掉 ' + n + ' 条 AI 判定。', 'ok');
    });
  }

  /** 发起一次「简历匹配」任务：服务端 pipeline --from match（初筛规则 / 二筛 AI）。
      跑完后 poll 会走到 onTaskDone → loadResult()，把带 _matchScore/_matchReason
      的结果重新拉回来（与采集跑完同一套收尾，不新造轮子）。 */
  function startMatch(payload) {
    if (!S.base) { U.toast('采集器没启动。', 'warn'); return; }
    payload = payload || {};
    S.since = 0;
    var box = U.$('#cLog');
    if (box) box.innerHTML = '';
    req('/api/match', { method: 'POST', json: payload, timeout: 20000 }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '起不了匹配任务');
      var es = d.estimate;
      var mode = payload.matchMode === 'quick' ? '初筛（规则）' : '二筛（AI）';
      U.toast('简历匹配 · ' + mode + ' 已开始。' +
        (es && es.costText ? '预计 ' + es.costText + '。' : ''), 'ok', 9000);
      S.wasRunning = true;
      poll(function () { App.refresh(); }, function (reason) {
        App.refresh();
        U.toast('和采集器的连接断了（' + (reason === 'offline' ? '它可能已经关了'
          : reason === 'net' ? '请求失败' : '任务记录没了') +
          '）。**匹配进程可能还在跑** —— 重新打开页面就能连上看进度。', 'warn', 12000);
      });
    }).catch(function (e) {
      U.toast('匹配没起来：' + e.message, 'bad', 9000);
    });
  }

  /** 「🎯 简历匹配」弹窗：选初筛/二筛、候选数、并发，看成本预估，再开跑。 */
  function openMatchModal() {
    if (!S.base) { U.toast('采集器没启动。', 'warn'); return; }
    if (!resultJobs().length) {
      U.toast('还没有采集结果 —— 先跑一次采集，才有岗位可匹配。', 'warn');
      return;
    }

    var modeSel = el('select', { style: 'width:auto' }, [
      el('option', { value: 'deep', text: '二筛（AI · 逐岗调模型）—— 打分 + 说明原因' }),
      el('option', { value: 'quick', text: '初筛（规则 · 零 token）—— 只打规则分' }),
    ]);
    var topInp = el('input', { type: 'number', min: '1', max: '100', value: '15', style: 'width:72px' });
    var workersInp = el('input', { type: 'number', min: '1', max: '16', value: '4', style: 'width:72px' });
    var estBox = el('div', { class: 'fs12 muted', text: '正在预估…' });

    function curPayload() {
      return {
        matchMode: modeSel.value,
        topN: parseInt(topInp.value, 10) || 0,
        workers: parseInt(workersInp.value, 10) || 0,
      };
    }
    function refreshEst() {
      estBox.textContent = '正在预估…';
      req('/api/match/estimate', { method: 'POST', json: curPayload(), timeout: 8000 })
        .then(function (d) {
          var es = d && d.estimate;
          estBox.textContent = es && es.costText
            ? '预估：' + es.costText + (es.candidates ? '（岗位池 ' + es.pool + ' 行）' : '')
            : '';
        }).catch(function () { estBox.textContent = '估不了（采集器没响应）'; });
    }
    modeSel.addEventListener('change', refreshEst);
    topInp.addEventListener('input', U.debounce(refreshEst, 250));
    workersInp.addEventListener('input', U.debounce(refreshEst, 250));

    // deep 才用得上 topN/workers；切到 quick 时把它们藏起来，别留两个"没用的输入框"
    function syncFields() {
      var deep = modeSel.value === 'deep';
      topInp.style.display = deep ? '' : 'none';
      workersInp.style.display = deep ? '' : 'none';
    }
    modeSel.addEventListener('change', function () { syncFields(); refreshEst(); });

    var row = function (label, node, tip) {
      return el('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
        el('span', { class: 'fs12 muted', style: 'min-width:88px', text: label }),
        node,
        tip ? el('span', { class: 'fs11 muted', text: tip }) : null,
      ].filter(Boolean));
    };

    var box = el('div', { class: 'stack', style: 'gap:10px;min-width:min(500px,84vw)' }, [
      el('div', { class: 'fs12 muted', html:
        '对<b>当前运行目录里已爬好的岗位</b>做简历匹配：初筛先按规则打分，' +
        '二筛把达标的候选逐岗送模型、给出分数和「为什么是这个分」的原因。' }),
      row('匹配模式', modeSel),
      row('二筛候选数', topInp, '个（匹配分最高的前 N 个送模型）'),
      row('并发', workersInp, '个（同时调几个模型）'),
      estBox,
      el('div', { class: 'note info', style: 'margin-top:4px' }, [
        el('span', { class: 'ico', text: '💡' }),
        el('div', { text: '匹配不重新爬取，也不动运行目录；结果按 link 挂回每个岗位，'
          + '匹配分 + 原因会直接显示在结果列表里，并可用「匹配度区间」过滤。' }),
      ]),
    ]);

    U.openModal({
      title: '🎯 简历匹配采集',
      body: box,
      footer: [
        { text: '开始匹配', cls: 'pri', onClick: function (c) {
            /* 先落值再关窗（关窗会销毁节点，顺序反了 curPayload() 会读到空） */
            var p = curPayload();
            c();
            startMatch(p);
          } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
    syncFields();
    refreshEst();
  }

  /**
   * 把采集结果灌进岗位库。规范化交给 Exporter —— 与文件导入同一套映射。
   * opt.list 传了就用它（例如「筛选后的这批」），不传就导全部采集结果。
   */
  /* ==================== 导入采集结果到岗位库 ==================== */

  /** 让出一帧，给浏览器重绘 / 处理点击的机会。
      ⛔ 用 setTimeout(0) 而不是 requestAnimationFrame：rAF 在后台标签页会被暂停，
         导入会莫名停在半路（进度条不动、永远不完成）。 */
  function yieldToUI() {
    return new Promise(function (r) { setTimeout(r, 0); });
  }

  /* 每批处理多少条。60 条约 200~400ms 一段（库里 2000 条时的实测量级）——
     既给主线程留出喘息窗口，又不至于把整件事拖成几百次 yield。 */
  var IMPORT_CHUNK = 60;

  /**
   * 导入采集结果到岗位库。**返回 Promise**（调用方可以不接，但不能同步抛）。
   *
   * ⛔ 必须分批 + 让出主线程：用户报的「导入会卡住」实测是
   *    506 条全在**一个同步任务**里跑完，堵死事件循环 **1885ms**（库里有 2000 条时），
   *    期间页面毫无反应、也看不到任何提示 → 用起来就是"死机了"。
   *    根因是逐条 addJob（每条一次 save + fire + 全库线性扫去重），
   *    现在走 Store.addJobs：整批只落一次盘、只广播一次、只建一次索引。
   * ⛔ 绝不**同步抛**：调用点是 button.onclick，那里没人 `.catch`，
   *    同步抛 = 静默失败（用户只看到"点了没用"）。
   */
  function importResult(btn, opt) {
    return Promise.resolve()
      .then(function () { return doImport(btn, opt); })
      .catch(function (e) {
        S.importing = false;
        if (btn && btn.tagName === 'BUTTON') btn.disabled = false;
        U.toastHtml('导入失败：' + U.esc((e && e.message) || e) +
          '<br>没写坏任何数据，可以直接再点一次。', 'bad', 10000);
        return null;
      });
  }

  function doImport(btn, opt) {
    opt = opt || {};
    if (!S.result || !(S.result.jobs || []).length) {
      U.toast('还没有可导入的采集结果。', 'warn');
      return Promise.resolve(null);
    }
    var jobs = opt.list || resultJobs();
    if (!jobs.length) {
      U.toast('采集结果里没解析出有效岗位（可能字段名对不上）。', 'warn');
      return Promise.resolve(null);
    }
    /* ⛔ 连点两下 = 两条流水线同时往库里塞 → 计数翻倍、进度条互相打架。
       用 S.importing 挡住第二次（一次分批导入有好几个 yield 窗口，够手快点两下）。 */
    if (S.importing) {
      U.toast('上一批还在导入中，稍等一下…', 'warn');
      return Promise.resolve(null);
    }
    S.importing = true;

    var isBtn = !!(btn && btn.tagName === 'BUTTON');
    var originalLabel = isBtn ? btn.innerHTML : '';
    var total = jobs.length;
    var added = 0, dup = 0, ids = [];
    var i = 0;

    if (isBtn) {
      btn.disabled = true;                     // 运行中禁用 → 连点也不会重复导入
      btn.innerHTML = '📥 导入中 0 / ' + total + '…';
    }

    function step() {
      var n = Math.min(IMPORT_CHUNK, total - i);
      var r = Store.addJobs(jobs.slice(i, i + n));
      added += r.added; dup += r.dup;
      ids = ids.concat(r.ids);
      i += n;
      if (isBtn) btn.innerHTML = '📥 导入中 ' + i + ' / ' + total + '…';   // 可见进度
      /* ⛔ 必须**永远返回 Promise**：整批只够一块时这里就是终点，
         返回裸 null 会被外面的 `step().then(...)` 打成
         「Cannot read properties of null (reading 'then')」——
         而且那条路径只在「条数 ≤ IMPORT_CHUNK」时走到，测试稍不小心就漏了。 */
      if (i >= total) return Promise.resolve(null);
      return yieldToUI().then(step);
    }

    return step().then(function () {
      // 导入是显式动作，别留给 260ms 防抖 —— 用户完全可能导入完马上关页面
      Store.flush();
      S.importing = false;
      if (isBtn) { btn.disabled = false; btn.innerHTML = originalLabel; }

      /* ⛔ 导入把岗位写进了库 → 「② 采集参数」卡里那三行地点（省/市/区/商圈）的
         候选跟着变了（它们来自 Store.jobs()）。只重画那三行 —— 不整页 refresh
         （这页 1500+ 节点），也不写 localStorage。不补这一下，用户导入完停留在
         本页时，商圈行会一直显示「还没采到商圈数据」，像是采集丢了区域数据。 */
      if (paintGeoRows) { try { paintGeoRows(); } catch (e) { /* 重画失败不该让导入报错 */ } }

      /* 导入完立刻能评分 —— 不然用户还得自己想起来"去岗位库点那个按钮" */
      var todo = global.JobMatch
        ? global.JobMatch.unscored(ids.map(Store.job).filter(Boolean))
        : [];

      var scopeNote = opt.list ? '（' + total + ' 条筛选结果）' : '';
      U.toastHtml(
        '导入完成：新增 <b>' + added + '</b> 个岗位' + scopeNote +
        (dup ? '，' + dup + ' 个已存在（已合并补空字段）' : '') +
        (todo.length ? '<br>这 ' + todo.length + ' 个还没评分，让简历给它们打个分再挑。' : ''),
        added ? 'ok' : 'warn', todo.length ? 12000 : 7000,
        todo.length ? [{ text: '🤖 现在就评分', cls: 'pri', onClick: function () { scoreResults(todo); } }] : null
      );
      return null;
    });
  }

  /* ==================== 上传简历 ==================== */

  /** 简历文件管理（评审 P2-6）：列出已上传的简历原件，允许删除（归档）。
      以前 data/resume/ 里的简历长期留盘、没有任何删除入口。 */
  function openResumeManager() {
    var box = el('div', { class: 'stack', style: 'gap:10px;min-width:min(520px,80vw)' });
    box.appendChild(el('div', { class: 'fs12 muted', text: '正在读取…' }));

    function fmtSize(b) {
      if (b >= 1024 * 1024) return (b / 1024 / 1024).toFixed(1) + ' MB';
      if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
      return b + ' B';
    }

    function paint(files) {
      box.innerHTML = '';
      if (!files || !files.length) {
        box.appendChild(el('div', { class: 'empty' }, [
          el('b', { text: '还没有上传过简历' }),
          el('p', { text: '上传解析过的简历原件会列在这里。' }),
        ]));
        return;
      }
      box.appendChild(el('div', { class: 'fs12 muted', html:
        '共 <b>' + files.length + '</b> 份简历原件。删除是<b>归档</b>（不是真删），' +
        '误删可到 <code class="mono">采集器/data/resume-archive/</code> 找回。' }));
      var list = el('div', { class: 'stack', style: 'gap:8px;max-height:50vh;overflow:auto' });
      files.forEach(function (f) {
        list.appendChild(el('div', { class: 'job' }, [
          el('div', { class: 'row', style: 'gap:8px;align-items:center' }, [
            el('b', { text: f.name }),
            el('span', { class: 'fs11 muted', text: fmtSize(f.size) + ' · ' + (f.mtime ? U.rel(f.mtime * 1000) : '') }),
            el('span', { class: 'sp' }),
            el('button', {
              class: 'btn xs danger', type: 'button', text: '🗑 删除',
              onclick: function () {
                U.confirm('把 <b>' + U.esc(f.name) + '</b> 从简历目录归档掉？<br>' +
                  '归档到 resume-archive/，误删可找回；不影响已经解析出来的画像。',
                  { okText: '归档', title: '删除简历', danger: true }
                ).then(function (go) {
                  if (!go) return;
                  req('/api/resume/delete', { method: 'POST', json: { name: f.name }, timeout: 10000 })
                    .then(function (d) {
                      if (!d || !d.ok) throw new Error((d && d.error) || '删除失败');
                      U.toast('已归档「' + f.name + '」', 'ok', 4000);
                      req('/api/resumes', { timeout: 8000 }).then(function (r) {
                        paint((r && r.files) || []);
                      });
                    })
                    .catch(function (e) {
                      U.toast('删除失败：' + (e.message || String(e)), 'bad', 8000);
                    });
                });
              },
            }),
          ].filter(Boolean)),
        ]));
      });
      box.appendChild(list);
    }

    U.openModal({
      title: '🗑 管理简历',
      body: box,
      footer: [{ text: '关闭', onClick: function (c) { c(); } }],
    });

    req('/api/resumes', { timeout: 8000 }).then(function (d) {
      paint((d && d.files) || []);
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '⚠️' }),
        el('div', { text: '读不到简历列表：' + ((e && e.message) || '未知错误') }),
      ]));
    });
  }

  function uploadResume() {
    if (!S.base) { U.toast('采集器没启动。', 'warn'); return; }
    U.pickFile('.pdf,.docx,.doc,.txt,.md', false).then(function (picked) {
      // 注意 pickFile 的返回形态随 multiple 变：multiple=false 给的是单个 File，
      // 不是数组。这里只收一份简历，所以走单个分支。
      var f = Array.isArray(picked) ? picked[0] : picked;
      if (!f) return;
      if (f.size > 20 * 1024 * 1024) { U.toast('文件超过 20MB。', 'warn'); return; }
      U.toast('正在上传并解析简历…', 'info', 60000);
      return U.readArrayBuffer(f).then(function (buf) {
        // 文件名走 base64 头，正文是原始字节 —— 服务端不解析 multipart，
        // 因为 Python 3.13 已经把 cgi 模块删了，为一次上传手写 multipart 不划算。
        return req('/api/resume', {
          method: 'POST', raw: buf, timeout: 120000,
          headers: {
            'Content-Type': 'application/octet-stream',
            'X-Filename': U.b64(f.name),
          },
        });
      }).then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || '上传被拒绝');
        U.toast('简历已提交，正在解析…', 'ok');
        S.since = 0;
        S.wasRunning = true;
        var box = U.$('#cLog');
        if (box) box.innerHTML = '';
        poll(function () { App.refresh(); });
      }).catch(function (e) {
        U.toast('上传失败：' + e.message, 'bad', 8000);
      });
    });
  }

  /* ==================== 操作 ==================== */

  function doLogin(btn) {
    if (btn) btn.disabled = true;
    U.toast('正在起浏览器窗口…请在弹出的 Edge 里扫码登录 BOSS', 'info', 12000);
    S.since = 0;
    var box = U.$('#cLog');
    if (box) box.innerHTML = '';
    req('/api/login', { method: 'POST', json: {}, timeout: 15000 }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '起不了登录任务');
      S.wasRunning = true;
      /* ⛔ onFail 必须给：轮询静默死掉时这个按钮会永远禁用（和 4.4 同一个洞）。
         「① 登录 BOSS」是个独立按钮，用户点了没反应 = 以为工具坏了。 */
      poll(function () { App.refresh(); }, function (reason) {
        if (btn) btn.disabled = false;
        U.toast('登录检测中断了：' + (reason === 'offline' ? '没连上采集器'
          : reason === 'net' ? '与采集器的连接断了' : '采集器说没有任务在跑') +
          '。可以直接重试，或刷新页面。', 'bad', 10000);
      });
      setTimeout(function () { App.refresh(); }, 4000);
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      U.toast('登录检测没起来：' + e.message, 'bad', 8000);
    });
  }

  /**
   * 把「手输关键词」和「岗位期望」合成最终搜索词（去重）。
   * 岗位期望来自 BOSS 岗位分类树，用户在采集页勾的岗位会一起作为搜索词。
   */
  function collectKeywords(f) {
    f = f || {};
    var kws = String(f.keywords || '').split(/[\n，,、;；]+/).map(function (s) { return s.trim(); })
      .filter(Boolean);
    (f.expectJobs || []).forEach(function (n) {
      var v = String(n || '').trim();
      if (v && kws.indexOf(v) < 0) kws.push(v);
    });
    return kws;
  }

  /**
   * 登录态是否「已知且新鲜」。
   * ⚠️ TTL **不在这里写死** —— 从 ping 的 login.ttlSec 读，单一来源在服务端
   *    server.py 的 LOGIN_TTL。以前两边各写 45 分钟，改一边忘一边就会出现
   *    「前端以为新鲜、后端说不行」的诡异拦截。读不到 TTL 时才退回 45 分钟兜底。
   * 判定口径：value === 'ok' 且 checkedAt 在 TTL 之内。
   */
  function loginFresh() {
    var lg = (S.ping && S.ping.login) || {};
    var at = Number(lg.checkedAt || 0);
    var ttl = Number(lg.ttlSec) > 0 ? Number(lg.ttlSec) : 45 * 60;
    return lg.value === 'ok' && at > 0 && (Date.now() / 1000 - at) < ttl;
  }

  /**
   * 跑一次登录检测并等它结束（会弹 Edge；已登录的话几秒就完）。
   * 结束后 poll 的完成回调里已顺带刷新过 ping，所以 S.ping.login 是最新的。
   *
   * 返回 Promise<{ok:boolean, why?:string, started?:boolean}>：
   *   {ok:true}                 任务正常跑完（登录成功了没有，看 loginFresh()）
   *   {ok:false,why:'...'}      没跑起来 / 跑挂了 / 没连上 —— **一定要给出人话原因**
   *
   * ⛔ 为什么要返回对象而不是 boolean（评审 4.4）：
   *   以前失败时只 `return false`，`doCrawl` 收到 false 后统一说「还没有登录 BOSS：请扫码」——
   *   可失败原因可能是「采集器没响应」，那时候让人去扫码是**指错方向**的。
   */
  function runLoginCheck() {
    S.since = 0;
    var box = U.$('#cLog');
    if (box) box.innerHTML = '';
    return req('/api/login', { method: 'POST', json: {}, timeout: 20000 }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '起不了登录任务');
      return new Promise(function (resolve) {
        var settled = false;
        function done(res) {
          if (settled) return;      // ⛔ 守卫：poll 的回调与超时兜底谁先到都只算一次
          settled = true;
          clearTimeout(timer);
          resolve(res);
        }
        /* 兜底超时：文案说「几秒就好」，但扫码最长能等 300 秒（脚本侧上限），
           所以给 380 秒。它的作用只有一个 —— 万一 poll 又以某种没预料到的方式静默死掉，
           按钮也不能被永久禁用。
           ⚠️ 必须 unref()：这是个「保险丝」，不该把宿主进程的生命周期也绑上。
              不 unref 的话，Node 里一个挂着的 380 秒定时器会让进程退不出去
              （实测：核心测试跑完 1587 项全绿但进程不退出，被超时杀掉）。
              浏览器里没有 unref，所以先判类型。 */
        var timer = setTimeout(function () {
          stopPoll();
          done({ ok: false, why: '登录检测等太久还没结束（超过 380 秒），已经放弃等待' });
        }, 380000);
        if (timer && typeof timer.unref === 'function') timer.unref();

        poll(function () { done({ ok: true }); }, function (reason) {
          done({
            ok: false,
            why: reason === 'offline' ? '没连上采集器（它可能已经关了）'
              : reason === 'net' ? '与采集器的连接断了'
                : reason === 'superseded'
                  ? '页面上又发起了一次操作（比如又点了一次登录/上传），这次等待被顶掉了 —— 重新点一次「开始采集」即可'
                  : '采集器说当前没有任务在跑 —— 多半是它刚重启过',
          });
        });
      });
    }).catch(function (e) {
      // 让调用方拿到原因去说人话，不再在这里 toast（避免一次失败弹两个提示）
      return { ok: false, why: (e && e.message) || '起不了登录任务', started: false };
    });
  }

  function doCrawl(btn) {
    var f = S.form || {};
    var kws = collectKeywords(f);
    if (!kws.length) { U.toast('至少选一个岗位期望，或填一个搜索关键词。', 'warn'); return; }
    if (!f.city) { U.toast('填一下城市。', 'warn'); return; }

    // 表单校验通过 → 把纯前端筛选字段落盘，下次刷新能恢复（评审 P1-3.1）。
    saveForm();

    if (btn) btn.disabled = true;

    /* 登录态预检（P0-3）：先确认登录，再开跑。
       server.log 实证「10 次采集 3 次手动中断」，很多是二维码过期了还硬跑，
       翻页时才炸 —— 与其白跑十几分钟，不如先花几秒检测一次。
       服务端 _crawl 里也有一道同样的闸（防止刷新后的旧页面绕过）。 */
    if (!loginFresh()) {
      U.toast('先做一次登录检测 —— 会弹出 Edge；已登录的话几秒就好。', 'info', 10000);
      runLoginCheck().then(function (r) {
        if (r && r.ok && loginFresh()) { startCrawl(btn); return; }
        /* ⛔ 无论走哪条失败路径，都必须把按钮恢复 —— 以前只在这里写了一句
           `if (started) toast(...)`，而 promise 一旦不 resolve，按钮就永久禁用。
           现在：失败必恢复 + 必给原因（「去扫码」和「采集器没响应」是两件事）。 */
        if (btn) btn.disabled = false;
        if (r && r.ok) {
          U.toast('还没有登录 BOSS：请在弹出的 Edge 里扫码，然后重新点「开始采集」。', 'warn', 11000);
        } else {
          U.toast('登录检测没跑完：' + ((r && r.why) || '未知原因') +
            '。可以点「① 登录 BOSS」单独跑一次，或刷新页面重试。', 'bad', 12000);
        }
      });
      return;
    }
    startCrawl(btn);
  }

  /**
   * 刷新「开始采集」旁边的预估耗时（P2-2）。
   *
   * 值必须**问服务端要**，不在前端复刻公式 —— 详情封顶（Top N）、
   * count=0 按 300 条估这些口径都在 estimate_crawl 里，前端再写一份必然漂移。
   * 服务端连不上/还没填城市期望时返回 null，那就保持空着（不显示假数字）。
   */
  function refreshEstimate() {
    var box = U.$('#cEstimate');
    if (!box) return Promise.resolve(null);
    var f = S.form || {};
    var kws = collectKeywords(f);
    if (!kws.length || !f.city) { box.textContent = ''; return Promise.resolve(null); }
    return req('/api/estimate', {
      method: 'POST', timeout: 8000,
      json: { city: f.city, keywords: kws, count: parseCount(f.count) },
    }).then(function (d) {
      var line = fmtEstimate(d && d.estimate);
      var node = U.$('#cEstimate');
      if (node) node.textContent = line || '';
      return line;
    }).catch(function () {
      var node = U.$('#cEstimate');
      if (node) node.textContent = '';
      return null;
    });
  }

  /** 真正发起采集任务。doCrawl 完成登录预检后调它。 */
  function startCrawl(btn) {
    var f = S.form || {};
    var kws = collectKeywords(f);
    S.since = 0;
    var box = U.$('#cLog');
    if (box) box.innerHTML = '';

    req('/api/crawl', {
      method: 'POST', timeout: 20000,
      json: {
        city: f.city, keywords: kws, salary: f.salary,
        count: parseCount(f.count), crawlMode: f.crawlMode || 'custom',
        degree: f.degree || [], experience: f.experience || [],
        scale: f.scale || [], stage: f.stage || [], jobType: f.jobType || [],
        /* 详情优先方向 = 采集参数里的「岗位期望」，**原样透传、不做任何转换**。
           详情抓取是封顶的（本轮 50 条），额度给谁决定 JD 覆盖率有没有用：
           原来爬虫只按「信息完整度」排序，额度被"亚马逊运营（信息齐全）"这类
           无关岗位吃掉，而"内容运营"那 46 条相关岗位一条 JD 都没有。
           ⛔ 只影响**详情额度给谁**，不影响采集范围（范围看 keywords）。
           ⛔ 留空时不传（后端 put_list 只在非空时透传）→ 爬虫侧排序口径与以前逐字一致。 */
        expectJobs: f.expectJobs || [],
        // 重新采集历史已采岗位：勾选「采集已采过岗位」时为 true（默认 false = 去重跳过）。
        // 服务端 build_cmd_crawl 据此拼 --include-known，爬虫不再加载全局已知集。
        includeKnown: !!f.includeKnown,
        // 福利/活跃度：BOSS 接口无参数，不传给采集器（由结果区本地筛）
      },
    }).then(function (d) {
      if (!d || !d.ok) throw new Error((d && d.error) || '起不了采集任务');
      /* P2-2：开跑就把「大概要等多久」说出来。
         体检报告 §3.1「用户开跑前不知道要等 30 分钟还是 3 分钟」——
         预估值由服务端 estimate_crawl 算（含详情封顶口径），这里只负责转成人话。 */
      var est = fmtEstimate(d.estimate);
      U.toast(est ? '采集已开始。' + est + '。会弹出 Edge 窗口 —— 按提示操作，别关它。'
                  : '采集已开始。会弹出 Edge 窗口 —— 按提示操作，别关它。', 'ok', 9000);
      S.wasRunning = true;
      /* 采集跑起来后轮询挂了，任务卡会一直停在「进行中」而你完全不知道 ——
         所以这里也要给 onFail：明确告诉你「连接断了、任务可能还在跑」。 */
      poll(function () { App.refresh(); }, function (reason) {
        App.refresh();
        U.toast('和采集器的连接断了（' + (reason === 'offline' ? '它可能已经关了'
          : reason === 'net' ? '请求失败' : '任务记录没了') +
          '）。**采集进程可能还在跑** —— 重新打开页面就能重新连上看进度。', 'warn', 12000);
      });
    }).catch(function (e) {
      if (btn) btn.disabled = false;
      U.toast('采集没起来：' + e.message, 'bad', 9000);
    });
  }

  /**
   * 采集历史列表（P2-1）。以前只能看到 LATEST 那一个目录，想找回以前那批
   * 数据得自己去翻文件系统。这里列出所有 run-dir 与归档，标明时间/是否当前/
   * 有没有产物。**只读** —— 不做「载入某一轮」（改 LATEST 指针在跨轮去重下语义复杂，
   * 容易让用户误以为切过去这批就是他的）。
   */
  function openHistoryDialog() {
    var box = el('div', { class: 'stack', style: 'gap:10px;min-width:min(560px,80vw)' });
    box.appendChild(el('div', { class: 'fs12 muted',
      text: '正在读取…' }));

    function paint(items) {
      box.innerHTML = '';
      if (!items || !items.length) {
        box.appendChild(el('div', { class: 'empty' }, [
          el('b', { text: '还没有采集历史' }),
          el('p', { text: '跑完一次采集后，这里会列出每一轮的目录与产物。' }),
        ]));
        return;
      }
      box.appendChild(el('div', { class: 'fs12 muted', html:
        '共 <b>' + items.length + '</b> 轮。采集结果落在本地文件里，' +
        '「清空结果」是把它们<b>归档</b>（不是删除），所以历史都还在。' }));
      var list = el('div', { class: 'stack', style: 'gap:8px;max-height:56vh;overflow:auto' });
      items.forEach(function (it) {
        list.appendChild(el('div', { class: 'job' }, [
          el('div', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap' }, [
            el('b', { text: it.name }),
            it.current ? el('span', { class: 'tag ok', text: '当前' }) : null,
            it.kind === 'archived' ? el('span', { class: 'tag warn', text: '已归档' }) : null,
            it.hasResult ? el('span', { class: 'tag', text: '有结果 JSON' }) : null,
            it.csvCount ? el('span', { class: 'tag', text: it.csvCount + ' 个 CSV' }) : null,
            el('span', { class: 'sp' }),
            el('a', { class: 'brand-c fs11', style: 'cursor:pointer', text: '复制路径',
              onclick: function () {
                var p = it.path || '';
                if (navigator.clipboard && navigator.clipboard.writeText) {
                  navigator.clipboard.writeText(p).then(function () {
                    U.toast('路径已复制', 'ok', 2500);
                  }).catch(function () { U.toast('复制失败，路径：' + p, 'warn', 9000); });
                } else {
                  U.toast('路径：' + p, 'ok', 9000);
                }
              } }),
          ].filter(Boolean)),
          el('div', { class: 'fs11 muted mono', style: 'word-break:break-all', text: it.path || '' }),
        ]));
      });
      box.appendChild(list);
    }

    U.openModal({
      title: '📁 采集历史',
      body: box,
      // footer 只认 {text, cls, onClick} 对象形式（不能传 DOM 节点）；
      // onClick 收到的 c 就是 close —— 不要在外面引用弹窗对象，那时还没赋值。
      footer: [{ text: '关闭', onClick: function (c) { c(); } }],
    });

    req('/api/history', { timeout: 8000 }).then(function (d) {
      paint((d && d.items) || []);
    }).catch(function (e) {
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '⚠️' }),
        el('div', { text: '读不到采集历史：' + ((e && e.message) || '未知错误') }),
      ]));
    });
  }

  function doStop() {
    req('/api/stop', { method: 'POST', json: {}, timeout: 10000 }).then(function (d) {
      if (!d || !d.ok) {
        U.toast((d && d.error) || '没有在跑的任务', 'warn');
        return;
      }
      /* 停止后最需要的是「已采到的在哪、怎么接着用」——
         以前只弹一句「已请求停止」（体检报告 §3.1）。server.log 实证 10 次采集
         有 3 次是手动中断的，所以这个落点指引不是锦上添花。 */
      var n = resultJobs().length;
      if (n > 0) {
        U.toast('已停止。本轮已采到 ' + n + ' 个岗位（在下方「④ 采集结果」里），' +
                '现在就可以导入岗位库；想继续补采就再点一次「开始采集」。', 'ok', 12000);
      } else {
        U.toast('已停止。本轮还没采到岗位 —— 可以直接重新开始。', 'warn', 9000);
      }
      /* 停止请求已受理 → 立刻收起「■ 停止」，别让它停在"还能再点一次"的样子上。
         ⚠️ 这只控制**按钮显示**；任务是否真的结束、退出码是多少，一律以任务卡
            （每轮 poll 重画）为准 —— 服务端那边最长要 8 秒才会把状态落地（看门狗）。 */
      S.taskRunning = false;
      paintActions();
    }).catch(function (e) {
      U.toast('停止失败：' + e.message, 'bad');
    });
  }

  /* ==================== 暂停 / 继续（一键冻结） ====================

     与「停止」的根本区别：
       · 停止 = 杀进程，任务结束，要继续就得重新跑一遍；
       · 暂停 = 把整棵采集进程树**挂起**（Windows NtSuspendProcess），进程还在、
         内存/连接/页面状态原地保留，点「继续」从原处接着跑，已采到的一行不丢。
     实现见采集器 server.py 的 pause_task / resume_task（连 Edge 一起冻住）。

     ⚠️ 命名坑：`/api/resume` 已经被「上传简历」占了，所以「继续」走 `/api/continue`。 */
  function doPause() {
    req('/api/pause', { method: 'POST', json: {}, timeout: 10000 }).then(function (d) {
      if (!d || !d.ok) {
        U.toast((d && d.error) || '没有在跑的任务', 'warn');
        return;
      }
      U.toast('⏸ 已暂停：采集进程已挂起（CPU 归零），已采到的一行不丢。' +
              '点「继续」从原处接着跑。', 'ok', 9000);
    }).catch(function (e) {
      U.toast('暂停失败：' + e.message, 'bad');
    });
  }

  function doResume() {
    req('/api/continue', { method: 'POST', json: {}, timeout: 10000 }).then(function (d) {
      if (!d || !d.ok) {
        U.toast((d && d.error) || '没有暂停中的任务', 'warn');
        return;
      }
      U.toast('▶ 已继续，从暂停的地方接着跑。', 'ok', 6000);
    }).catch(function (e) {
      U.toast('继续失败：' + e.message, 'bad');
    });
  }

  /* ==================== 未启动时的引导 ==================== */

  function offlineCard(onRetry) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('header', {}, [
      el('h3', { text: '① 先启动本地采集器' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'pill off' }, [el('span', { class: 'dt' }), '未连接']),
    ]));
    card.appendChild(el('div', { class: 'body stack' }, [
      el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '🔌' }),
        el('div', { html:
          '没检测到本地采集器（试过 <code class="mono">' + PORTS.join(' / ') + '</code> 这几个端口）。<br>' +
          '采集功能需要它在本机跑起来才能用 —— 其它的粘贴导入、AI 解析、投递跟踪不受影响。' }),
      ]),
      el('div', { class: 'note info' }, [
        el('span', { class: 'ico', text: '▶' }),
        el('div', { html:
          '<b>怎么启动</b>：回到工作台文件夹，<b>双击 <code class="mono">启动采集器.cmd</code></b>。<br>' +
          '会弹出一个黑窗口（别关它）+ 自动打开本工作台。然后回到这一页点下面的「重新检测」。' }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn pri', html: '🔄 重新检测', onclick: onRetry }),
        el('button', {
          class: 'btn', html: '📥 改成手动导入',
          title: '不用采集器也能用：复制岗位文字粘进岗位库',
          onclick: function () { App.go('jobs'); setTimeout(function () { Views.jobs.importDialog(); }, 260); },
        }),
      ]),
      el('details', { class: 'fold' }, [
        el('summary', { text: '一定要用采集器吗？不用行不行' }),
        el('div', { class: 'fd', text:
          '不用也完全可以。工作台本来就有两条不需要采集器的路：\n' +
          '· 在 BOSS 页面 Ctrl+A 全选 → Ctrl+C → 到岗位库「导入 BOSS 岗位」粘进去，AI 帮你拆字段\n' +
          '· 有 boss-crawler 的历史产物（qualified_jobs.json / csv），用「从爬虫结果导入」\n\n' +
          '采集器的价值只有一个：一次把几十上百个岗位捞回来，省掉你一个个复制粘贴。' }),
      ]),
    ]));
    return card;
  }

  /* ==================== 在线时的主体 ==================== */

  /**
   * 「连上了服务，但当前页面没有访问令牌」的引导卡。
   *
   * 触发条件：页面不是采集器打开的（典型是直接双击 index.html，file:// 打开），
   * 拿不到 window.__JH_TOKEN__，于是所有 /api/* 都会被服务端 403。
   * 与其让用户点半天全是「连不上」，不如把原因和出路一次说清。
   */
  function noTokenCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('header', {}, [
      el('h3', { text: '① 采集功能要用「采集器打开的页面」' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'pill wait' }, [el('span', { class: 'dt' }), '缺访问令牌']),
    ]));
    card.appendChild(el('div', { class: 'body stack' }, [
      el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '🔒' }),
        el('div', { html:
          '你当前这份页面<b>不是采集器打开的</b>（多半是直接双击 index.html 用 <code class="mono">file://</code> 打开的），' +
          '拿不到本机的访问令牌，所以采集相关接口会被一律拒绝。<br>' +
          '这是<b>故意的</b>：没有这道令牌，浏览器里随便一个网页都能偷偷读走你本机的岗位和简历画像。<br>' +
          '请回到工作台文件夹，<b>双击 <code class="mono">启动采集器</code></b>，在它打开的页面里用。' }),
      ]),
      el('div', { class: 'row' }, [
        el('button', { class: 'btn pri', html: '🌐 打开采集器页面',
          title: '采集器打开的页面自带访问令牌',
          onclick: function () {
            try { global.open((S.base || 'http://127.0.0.1:8738') + '/', '_blank'); } catch (e) { /* noop */ }
          } }),
        el('button', { class: 'btn', html: '📥 改成手动导入',
          title: '不用采集器也能用：复制岗位文字粘进岗位库',
          onclick: function () { App.go('jobs'); setTimeout(function () { Views.jobs.importDialog(); }, 260); } }),
      ]),
      el('div', { class: 'hint tiny', html:
        '提醒：<b>file:// 与 http://127.0.0.1 的浏览器数据是分开存的</b> —— ' +
        '你在 file:// 页面里导入的岗位不会自动出现在采集器页面里。建议固定只用采集器页面这一种方式。' }),
    ]));
    return card;
  }

  function statusCard(p) {
    var card = el('div', { class: 'card' });
    var lg = p.login || {};
    var loginPill = lg.value === 'ok'
      ? el('span', { class: 'pill on' }, [el('span', { class: 'dt' }), '已登录'])
      : lg.value === 'needed'
        ? el('span', { class: 'pill off' }, [el('span', { class: 'dt' }), '要先登录'])
        : el('span', { class: 'pill wait' }, [el('span', { class: 'dt' }), '未检测']);

    card.appendChild(el('header', {}, [
      el('h3', { text: '采集器状态' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'pill on' }, [el('span', { class: 'dt' }), '已连接']),
    ]));

    var body = el('div', { class: 'body stack' });
    var kv = el('dl', { class: 'kv' });
    function row(k, v) {
      kv.appendChild(el('dt', { text: k }));
      kv.appendChild(el('dd', {}, Array.isArray(v) ? v : [v]));
    }
    row('服务地址', el('code', { class: 'mono', text: p.base || S.base || '' }));
    // 端口/PID 摆出来：用户报「起没起」时能一眼对上，也方便核对是不是跑了两个实例
    if (p.port) {
      row('进程', el('span', { class: 'fs12 muted',
        text: '端口 ' + p.port + (p.pid ? ' · PID ' + p.pid : '') }));
    }
    row('采集链路', p.skillReady
      ? el('span', { class: 'ok-c', text: '✔ 就绪' })
      : el('span', { class: 'bad-c', text: '✘ 缺失（找不到 boss-crawler 或它的虚拟环境）' }));
    // ⚠️ 这里的 Key 是**采集器服务端**（boss-crawler）的配置，来自它的本地配置文件；
    //    工作台自己的 AI 功能用的是「设置 → ① 大模型接口」里那套（存在浏览器 localStorage）。
    //    两套互不相干，所以标签必须写清楚来源，否则会出现
    //    「采集页说已配 Key，岗位库却提示未配置」这种看着像坏了的矛盾。
    row('模型配置（采集器端）', p.llmReady
      ? el('span', { class: 'ok-c', text: '✔ 已配 Key' })
      : el('span', { class: 'warn-c', text: '⚠ 未配 Key（采集不需要，但后续 AI 匹配要用）' }));
    row('登录状态', loginPill);
    row('运行目录', el('span', { class: 'row', style: 'gap:8px;align-items:center;flex-wrap:wrap' }, [
      el('code', { class: 'mono fs11', text: p.runDir || '（无）' }),
      el('a', { class: 'brand-c fs11', style: 'cursor:pointer', text: '查看采集历史 →',
        onclick: function () { openHistoryDialog(); } }),
    ]));
    var bar = el('div', { class: 'row', id: 'cTaskBar' });
    row('当前任务', bar);
    body.appendChild(kv);

    // 采集频次面板（评审 §五-2 / 3.6）：本日/本周跑了几轮、上次采集时间。
    // 数据来自服务端 ping 的 frequency（读运行目录 + 任务落盘日志，零成本）。
    // 这里把它摆出来，让用户在「要不要再来一轮」之前心里有数 —— 风控阈值是 200 条详情/轮。
    var freq = p.frequency;
    if (freq) {
      var freqLine = el('div', { class: 'hint tiny', style: 'margin-top:4px' });
      var seg = [];
      if (freq.todayRuns) seg.push('本日已跑 <b>' + freq.todayRuns + '</b> 轮');
      if (freq.weekRuns) seg.push('本周 <b>' + freq.weekRuns + '</b> 轮');
      if (freq.lastCrawlAt) seg.push('上次采集 ' + U.rel(freq.lastCrawlAt * 1000));
      /* ⛔ 这两个数以前是分开摆的（这里说"风控阈值约 200"，③ 区那边说"只抓 50 个"），
         用户读到"风控阈值约 200 条/轮"会以为能拿到 ~200 条详情 —— 实际本轮只有 50，
         这正是"为什么只有 9% 有完整 JD"的直接困惑来源（评审 A5）。
         现在把「上限」和「风控线」连在一句里说，并点明"逐轮补齐"这个设计。
         数字一律取自服务端（freq.detailCap / freq.detailThreshold），前端不再硬编码。 */
      var capN = freq.detailCap || 0;
      var thrN = freq.detailThreshold || 0;
      /* ⛔ 「没抓到的下次采集会接着补」这句的成立范围要说准。
         详情是逐轮累积的（爬虫按「岗位要求和职责是否为空」挑下一轮），但
         **全池**缺口 ~495 条、每轮还净增几十条 → 全池口径**永远补不完**。
         而**你的期望岗位**只有百来条，50 条/轮 → 一两轮就补齐。
         所以这句必须带上「优先你的期望岗位」这个前提，才不是空头承诺。
         （本轮起详情额度确实会优先给标题命中期望岗位的岗位 —— 见 --detail-prefer。） */
      seg.push('详情本轮上限 <b>' + capN + '</b> 条' +
        (thrN ? '（BOSS 风控线约 ' + thrN + ' 条，留了余量）' : '') +
        ' · 优先补你的期望岗位，没排上的下次接着补');
      freqLine.appendChild(el('div', { html:
        '📊 采集频次：' + seg.join(' · ') +
        '　<span class="fs11">（连跑太密容易触发风控，建议每天 1-2 轮）</span>' }));
      body.appendChild(freqLine);
    }

    // 断点续采提示（§五-5）：上次采集疑似中断（有采集痕迹但没有正常跑完的 summary）。
    // 不是报错，是让用户知道「上次没跑完」，并说明重跑会自动跳过已抓的岗位。
    var intr = p.interrupted;
    if (intr) {
      body.appendChild(el('div', { class: 'note warn', style: 'margin-top:6px' }, [
        el('span', { class: 'ico', text: '⏸️' }),
        el('div', { html:
          '上一次采集看起来<b>没有跑完</b>（已采到 ' + (intr.roundLinks || 0) + ' 个岗位，但没有正常收尾）。' +
          '不用从头再来：再点一次「开始采集」会<b>自动跳过已经抓过的岗位</b>，只补缺的。' }),
      ]));
    }

    // 把两套 Key 的关系说透，避免用户误以为系统坏了
    body.appendChild(el('div', { class: 'hint tiny', html:
      '两套模型配置互不影响：上面这行是<b>采集器服务端</b>（boss-crawler 配置文件）的；' +
      '工作台自己的 AI 功能（AI 解析、匹配打分、话术）用的是 ' +
      '<b>' + (AI.ready() ? '已经配好了 ✅' : '还没配，去「设置 → ① 大模型接口」填') + '</b>。' }));

    if (!p.hasProfile) {
      body.appendChild(el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '📄' }),
        el('div', { html:
          '<b>还缺简历画像</b>：采集脚本要用它来决定搜什么、以及后续算匹配度。' +
          '把简历传上来解析一次就行。' }),
      ]));
      body.appendChild(el('div', { class: 'row' }, [
        el('button', {
          class: 'btn pri', html: '📄 上传简历并解析',
          onclick: function () { uploadResume(); },
        }),
      ]));
    } else {
      var pf = p.profile || {};
      var chips = el('div', { class: 'chips' });
      if (pf.name) chips.appendChild(el('span', { class: 'tag brand', text: pf.name }));
      if (pf.degree) chips.appendChild(el('span', { class: 'tag', text: pf.degree }));
      if (pf.years) chips.appendChild(el('span', { class: 'tag', text: pf.years + ' 年经验' }));
      if (pf.city) chips.appendChild(el('span', { class: 'tag', text: '期望 ' + pf.city }));
      if (pf.position) chips.appendChild(el('span', { class: 'tag', text: '目标 ' + pf.position }));
      chips.appendChild(el('span', { class: 'tag info', text: '画像关键词 ' + (pf.keywordCount || 0) + ' 个' }));
      body.appendChild(el('div', {}, [
        el('div', { class: 'fs12 muted fw6 mb4', text: '已识别简历画像' }),
        chips,
      ]));
      body.appendChild(el('div', { class: 'row' }, [
        el('button', { class: 'btn sm', html: '🔄 换一份简历重新解析', onclick: function () { uploadResume(); } }),
        el('button', { class: 'btn sm ghost', html: '🗑 管理简历', title: '删除已上传的简历原件（归档，可找回）',
          onclick: function () { openResumeManager(); } }),
      ]));
    }
    card.appendChild(body);
    return card;
  }

  function paramCard() {
    var p = (S.ping && S.ping.params) || {};
    /* 求职偏好（岗位库那份）。城市/区/商圈的**初值**从这里来 ——
       ⛔ 只是初值：采集页自己有一份独立的值，改了**不会**回写偏好。
          想双向搬，用「⤓ 从求职偏好带入」（采集页）/「⤒ 存为偏好」（偏好面板），
          两个都是手动按钮 + 改前给差异清单。 */
    var P = global.JobMatch ? global.JobMatch.prefs() : {};
    if (!S.form) {
      // 纯前端字段（服务端不回吐）→ localStorage 兜底，刷新不丢（评审 P1-3.1）。
      var saved = readSavedForm();
      // 存过区/商圈 = 用户表过态；之后就以他改的为准（见 saveForm 里的闸门）
      S.geoOwned = ('district' in saved) || ('bizArea' in saved);
      var seed = geoSeedFor(saved, p.city || cityJoin(P.cities), P);
      /* ⛔ 这几项「本地优先」而不是「服务端优先」：服务端那份只是**上一次采集的回声**
         （crawl_params.json 只在跑采集时才写）。不做这一步的后果是实测过的 ——
         条数改成 20、不跑采集、刷新 → 又变回 50，用户眼里就是「这个框改了没用」。 */
      var lf = {};
      LOCAL_FIRST_FIELDS.forEach(function (k) {
        if (Object.prototype.hasOwnProperty.call(saved, k)) lf[k] = saved[k];
      });
      function lfOr(k, fb) {
        return Object.prototype.hasOwnProperty.call(lf, k) ? lf[k] : fb;
      }
      S.form = {
        /* 省：**由城市反推**（见 deriveProvince）。只用来收窄「城市」候选，
           ⛔ 不传给 BOSS、也不参与筛选判定 —— 筛选的权威是 city/district/bizArea。
           落盘在 FORM_SAVE_FIELDS 里，但它**不进** CollectPrefs.CONCEPTS：
           偏好面板没有这一级，硬塞进去只会让「⤓ 带入 / ⤒ 存为偏好」多出一项
           谁也对不上的差异。 */
        province: deriveProvince(saved.province, p.city || cityJoin(P.cities)),
        // 城市：服务端有记录就以它为权威；没有就继承偏好（不然新装用户要先手动填一次）。
        // ⛔ 城市**不**走本地优先 —— 它要能跟着偏好变（见 LOCAL_FIRST_FIELDS 的注释）。
        city: p.city || cityJoin(P.cities),
        keywords: String(lfOr('keywords', (p.keywords || []).join('\n')) || ''),
        expectJobs: U.asArray(saved.expectJobs).slice(),  // 岗位期望（从 BOSS 岗位树选，采集时并入关键词）
        salary: String(lfOr('salary', p.salary || '') || ''),
        /* 自定义薪资区间（K）—— **本地精筛**，不进搜索条件（原因见参数卡薪资那一段）。
           走「本地优先」：它是用户手填的，服务端也不回吐它。
           初值可以继承求职偏好，新装用户不用再填一遍。 */
        salaryMin: parseK(lfOr('salaryMin', P.salaryMin)),
        salaryMax: parseK(lfOr('salaryMax', P.salaryMax)),
        count: parseCount(lfOr('count', p.count || 30)),
        crawlMode: String(lfOr('crawlMode', p.crawlMode || 'custom') || 'custom'),
        // 扩展筛选（BOSS 接口支持、透传给采集器）。初值优先取本地存过的 —— 理由同上。
        degree: U.asArray(lfOr('degree', p.degree)).slice(),        // 学历（多选）
        experience: U.asArray(lfOr('experience', p.experience)).slice(),// 经验（多选）
        scale: U.asArray(lfOr('scale', p.scale)).slice(),           // 公司规模（多选）
        stage: U.asArray(lfOr('stage', p.stage)).slice(),           // 融资阶段（多选）
        jobType: U.asArray(lfOr('jobType', p.jobType)).slice(),     // 工作类型（多选）
        // 扩展筛选（BOSS 无接口参数，本地筛）
        welfare: U.asArray(saved.welfare).slice(),  // 福利待遇（多选，本地筛）
        activeTime: saved.activeTime || '',         // BOSS 活跃度（单选，本地筛）
        includeKnown: !!saved.includeKnown,         // 采集已采过岗位（去重开关，默认 false = 跳过）
        /* 区 / 商圈（多选，采集完成后自动按真实「区域 / 商圈」精筛）。
           初值见 geoSeedFor：存过就用存的，没存过就继承求职偏好（城市对得上时）。
           ⛔ 旧代码这里写的是 `U.asArray(p.districts)` —— 而服务端 current_params()
              **根本不回吐 districts/bizAreas**，所以"默认继承偏好"这句话一直是假的。 */
        district: seed.district,
        bizArea: seed.bizArea,
      };
    }
    var f = S.form;
    /* ⛔ 把「数组类字段」补齐成真正的数组。
       为什么不能只靠上面那次初始化（`if (!S.form)`）：
       它只在 **第一次** 建表单时跑；之后 S.form 还会被「方案预设」灌入、
       也被测试用部分对象覆盖。只要有一个字段是 undefined，
       下面 chipGroup 里的 `state.indexOf(k)` 就抛 TypeError，
       整张采集页被 App 的错误兜底卡顶掉（表现是"页面白了"）。
       —— render 不该依赖调用方把每个字段都填齐。 */
    ['expectJobs', 'degree', 'experience', 'scale', 'stage', 'jobType',
      'welfare', 'district', 'bizArea'].forEach(function (k) {
      if (!Array.isArray(f[k])) f[k] = [];
    });
    if (!f.expectJobs) f.expectJobs = [];   // 老会话里可能没有这个字段
    /* 省是**字符串**（同 city），不是数组；老会话 / 方案里没有这个字段 → 补空串。
       ⛔ 补的是 ''（= 不限省）而不是 undefined —— chipsRow 的 selected 要能吃它。 */
    if (typeof f.province !== 'string') f.province = '';
    /* 自定义薪资区间：规格化一遍 —— 老会话 / 方案预设 / 测试灌入的可能是字符串或 undefined，
       不归一的话下面 `f.salaryMin !== null` 这类判断会把 '15' 当成"设过了"。 */
    f.salaryMin = parseK(f.salaryMin);
    f.salaryMax = parseK(f.salaryMax);

    var card = el('div', { class: 'card' });
    /* 「② 采集参数」整块可折叠：内容很多（关键词/条数/期望/地点/一长串筛选），
       填完一遍之后用户往往只想看运行日志和结果 —— 留着占满一屏就是纯干扰。
       折叠状态落 localStorage，刷新/切页回来保持不变。 */
    var chev = el('span', { class: 'chev', text: '▾' });
    /* 收起后仍要能一眼看出"里面填了什么"，否则每次都得展开确认一遍，
       那就等于没折叠（用户的抱怨正是"整页太长"）。 */
    var paramSum = el('span', { class: 'fs11 muted psum', text: '' });
    var head = el('header', { class: 'foldhead' }, [
      chev,
      el('h3', { text: '② 采集参数' }),
      el('span', { class: 'sp' }),
      paramSum,
      p.source ? el('span', { class: 'fs11 muted srcnote', text: '默认值来自 ' + p.source }) : null,
    ].filter(Boolean));
    card.appendChild(head);

    var body = el('div', { class: 'body stack' });

    /** 收起时的一行摘要（纯本地算，不依赖采集器）。 */
    function paintParamSum() {
      if (S.paramOpen) { paramSum.textContent = ''; return; }
      var kws = collectKeywords(f).length;
      var bits = [];
      /* 只在非默认（list）时标注采集方式 —— custom 是默认，写出来反而吵 */
      if (f.crawlMode === 'list') bits.push('🎯 按岗位直采');
      if (f.city) bits.push(f.city);
      /* 只选了省、还没选城市 → 也让人看见。否则收起后摘要里地点那一段是空的，
         用户会以为"我刚点的省没生效"。 */
      else if (f.province) bits.push(f.province);
      var per = parseCount(f.count);
      if (kws) bits.push(kws + ' 个关键词 × ' + (per === 0 ? '不限' : per + ' 条'));
      var n = 0;
      ['degree', 'experience', 'scale', 'stage', 'jobType'].forEach(function (k) {
        if (U.asArray(f[k]).length) n++;
      });
      if (f.salary) n++;
      // 自定义薪资区间也算"一项筛选"—— 否则收起后摘要里看不出你设过它
      if (f.salaryMin !== null || f.salaryMax !== null) n++;
      if (U.asArray(f.welfare).length) n++;
      if (n) bits.push(n + ' 项筛选');
      paramSum.textContent = bits.length ? ('（' + bits.join(' · ') + '）') : '（还没填）';
    }

    function setParamOpen(open) {
      open = !!open;
      S.paramOpen = open;
      try { localStorage.setItem(PARAM_OPEN_KEY, open ? '1' : '0'); } catch (e) { /* 隐私模式不挡用 */ }
      if (open) card.classList.remove('collapsed');
      else card.classList.add('collapsed');
      chev.textContent = open ? '▾' : '▸';
      head.title = (open ? '收起' : '展开') + '「采集参数」（只影响这一块的显示，不改任何参数）';
      paintParamSum();
    }
    head.addEventListener('click', function () { setParamOpen(!S.paramOpen); });


    /* --- 采集方案（预设）栏：把整套找法存成命名方案，一键切换 --- */
    var presets = readPresets();
    var presetSel = el('select', { style: 'min-width:180px' });
    presetSel.appendChild(el('option', { value: '', text: '（未使用方案）' }));
    presets.forEach(function (pr) {
      var o = el('option', { value: pr.id, text: pr.name });
      if (pr.id === S.activePreset) o.selected = true;
      presetSel.appendChild(o);
    });
    presetSel.addEventListener('change', function () {
      var id = presetSel.value;
      if (!id) { S.activePreset = null; return; }
      var pr = presets.filter(function (x) { return x.id === id; })[0];
      if (!pr) return;
      applyPresetToForm(pr.form);
      /* 方案里带了区/商圈 → 这就是用户的明确选择，从此不自动跟着偏好走。
         不落这一笔的话，方案切过去、刷新一下又会被"偏好优先"盖掉。 */
      if (('district' in pr.form) || ('bizArea' in pr.form)) S.geoOwned = true;
      saveForm();
      S.activePreset = id;
      U.toast('已切换方案「' + pr.name + '」', 'ok', 3500);
      App.refresh();   // 表单控件全要按新值重画 —— 就地改十几个 chip 不如整卡重画干净
    });
    var presetNameInp = el('input', { type: 'text', placeholder: '方案名，如「杭州·电商·10-20K」', style: 'min-width:160px' });
    body.appendChild(el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap' }, [
      el('span', { class: 'fs12 muted fw6', text: '🗂️ 方案' }),
      presetSel,
      presetNameInp,
      el('button', {
        class: 'btn xs', type: 'button', text: '💾 存为方案',
        title: '把当前所有筛选条件存成一个命名方案，下次一键切回',
        onclick: function () {
          var name = presetNameInp.value.trim();
          if (!name) { U.toast('先给方案起个名字。', 'warn'); return; }
          var payload = presetPayload(f);
          var arr = readPresets();
          var exist = arr.filter(function (x) { return x.name === name; })[0];
          var id;
          if (exist) { exist.form = payload; id = exist.id; }   // 同名覆盖
          else {
            id = 'pr' + Date.now().toString(36);
            arr.push({ id: id, name: name, form: payload, createdAt: Date.now() });
          }
          writePresets(arr);
          S.activePreset = id;
          presetNameInp.value = '';
          U.toast('已存为方案「' + name + '」' + (exist ? '（覆盖同名）' : ''), 'ok', 3500);
          App.refresh();
        },
      }),
      el('button', {
        class: 'btn xs ghost', type: 'button', text: '🗑 删除',
        title: '删除当前选中的方案（不影响当前已填的参数）',
        onclick: function () {
          var id = presetSel.value;
          if (!id) { U.toast('先在下拉里选一个要删的方案。', 'warn'); return; }
          var arr = readPresets().filter(function (x) { return x.id !== id; });
          writePresets(arr);
          if (S.activePreset === id) S.activePreset = null;
          U.toast('已删除该方案。', 'ok', 3000);
          App.refresh();
        },
      }),
    ]));
    if (!presets.length) {
      body.appendChild(el('div', { class: 'fs11 muted', style: 'margin-top:-6px',
        text: '把常用的「关键词 + 城市 + 筛选」整套存成方案，几套找法一键切换，不用每次重新点。' }));
    }

    /* --- 「⤓ 从求职偏好带入」：把岗位库偏好里已填的条件**手动**搬过来 ---
       ⛔ 为什么不做成自动同步：采集页回答「这一次怎么搜」，偏好回答「我长期要什么」，
          自动同步的后果是「临时换一套条件搜一下，长期设置被冲了」。
          所以做成显式按钮 + 改前给差异清单 —— 改哪几项，用户自己看得见。 */
    var syncBar = el('div', { class: 'syncbar' });
    function paintSyncBar() {
      syncBar.innerHTML = '';
      if (!global.CollectPrefs || !global.JobMatch) return;
      var plan = formPullPlan();
      syncBar.appendChild(el('span', { class: 'fs11 muted', text: '📥 岗位库' }));
      syncBar.appendChild(el('button', {
        class: 'btn xs', type: 'button', html: '⤓ 从求职偏好带入',
        title: '把岗位库「⚙ 我的求职偏好」里已填的城市 / 期望岗位 / 薪资 / 福利 / 区 / 商圈搬到这张表单上；只改这几项，不动偏好本身',
        onclick: pullFromPrefs,
      }));
      var n = plan ? plan.steps.length : 0;
      syncBar.appendChild(el('span', { class: 'fs11 muted',
        text: n ? ('有 ' + n + ' 项和偏好不一致：' +
          plan.steps.map(function (s) { return s.label; }).join('、') + ' —— 点左边可一次带入')
          : '和「我的求职偏好」当前一致。两边是两套独立数据，不会自动同步。' }));
    }

    var grid = el('div', { class: 'grid g2' });

    var salSel = el('select', {});
    salSel.appendChild(el('option', { value: '', text: '不限' }));
    SALARY_OPTIONS.forEach(function (s) {
      var o = el('option', { value: s, text: s });
      if (s === f.salary) o.selected = true;
      salSel.appendChild(o);
    });

    /* --- 自定义薪资区间（K）· 本地精筛 ---
       ⛔ **为什么不把它塞进 BOSS 档位**：BOSS 服务端的薪资筛选只有 6 个固定码
          （boss-crawler/scripts/boss_crawler/config.py 的 FILTER_LABELS['salary'] = 402~407），
          而 utils.resolve_filter_values() 遇到认不出的值**只打一行警告就跳过** ——
          也就是说「15-25K」传下去等于**不带薪资条件**地采，用户会以为筛过了
          （岗位多采一堆、还以为是自己要的范围）。所以细粒度只能落在本地精筛上。 */
    var salMinInp = el('input', { type: 'number', min: '1', step: '1',
      style: 'width:68px', placeholder: '下限', 'data-focus-key': 'sal-min',
      title: '自定义薪资下限（K）。两个框可以只填一个；留空 = 这一头不限',
      value: (f.salaryMin === null || f.salaryMin === undefined) ? '' : String(f.salaryMin) });
    var salMaxInp = el('input', { type: 'number', min: '1', step: '1',
      style: 'width:68px', placeholder: '上限', 'data-focus-key': 'sal-max',
      title: '自定义薪资上限（K）。两个框可以只填一个；留空 = 这一头不限',
      value: (f.salaryMax === null || f.salaryMax === undefined) ? '' : String(f.salaryMax) });

    /* 区间与档位打架时**当场说清楚**。就地重画、**不打网络** ——
       逐字敲数字不能每次都去撞 /api/estimate（关键词输入框当初就踩过这个）。
       两种要报的情况：
         ① 下限 > 上限：这个区间永远筛不出东西（用户大概率敲反了）
         ② 区间伸到档位之外：BOSS 在服务端就把那部分岗位切掉了，
            "我明明筛了 15-25K 却只有 10-20K 的结果" 就是这么来的 */
    var salWarn = el('div', { class: 'fs11 mt4 muted', text: '' });
    function paintSalWarn() {
      var lo = f.salaryMin, hi = f.salaryMax;
      if (lo === null && hi === null) { salWarn.textContent = ''; return; }
      if (lo !== null && hi !== null && lo > hi) {
        salWarn.textContent = '⚠️ 下限（' + lo + 'K）比上限（' + hi + 'K）还大 —— ' +
          '这个区间永远筛不出岗位，八成是敲反了。';
        return;
      }
      var b = SALARY_BAND[f.salary];
      if (b) {
        var out = [];
        if (lo !== null && lo < b[0]) out.push('下限 ' + lo + 'K 在档位外');
        if (hi !== null && hi > b[1]) out.push('上限 ' + hi + 'K 在档位外');
        if (out.length) {
          salWarn.textContent = '⚠️ 档位「' + f.salary + '」只覆盖 ' + b[0] + '~' +
            (b[1] > 999 ? '以上' : b[1] + 'K') + '，而 ' + out.join('、') +
            ' —— BOSS 在服务端就把那部分岗位切掉了，本地区间再宽也筛不到它们。' +
            '要真要这个范围，档位该选「不限」或更宽的那一档。';
          return;
        }
      }
      salWarn.textContent = '只影响采回来之后的本地精筛（' +
        (lo === null ? '不限' : lo + 'K') + ' ~ ' + (hi === null ? '不限' : hi + 'K') +
        '）；没标薪资的岗位会保留（不因为"没写"就丢）。';
    }
    function onSalRangeInput() {
      f.salaryMin = parseK(salMinInp.value);
      f.salaryMax = parseK(salMaxInp.value);
      touchForm();          // 落盘：否则"改了不跑采集就刷新 = 白选"
      paintSalWarn();
      paintParamSum();      // 收起时那一行摘要也要跟着变
    }
    salMinInp.addEventListener('input', onSalRangeInput);
    salMaxInp.addEventListener('input', onSalRangeInput);
    paintSalWarn();

    salSel.addEventListener('change', function () {
      f.salary = salSel.value;
      touchForm();
      paintSalWarn();       // 换档位 → 上面那句"区间在档位外"的提醒可能就该出现/消失
      paintDiag();
    });

    var cntInp = el('input', { type: 'number', value: String(f.count), min: '1', max: '200' });
    /* 走 paintDiag（它本身会调 refreshEstimate）—— 这样改条数会顺带把
       「和偏好差几项」和下面的即时条数提示一起刷新。 */
    cntInp.addEventListener('input', function () { f.count = cntInp.value; touchForm(); paintDiag(); });

    /* 条数的**即时反馈**（纯本地算，不走网络）。
       ⛔ 为什么必须有它：右边那句「预计约 N 分钟」有两个前提 —— 要等 /api/estimate 回来，
          而且**城市和关键词都填了**才会有内容。两个前提不满足时，改条数屏幕上什么都不动，
          用户就会得出「这个框改了没用」的结论。这一行不依赖网络、也不依赖城市，
          敲一下数字立刻变，让这个控件"看得见地活着"。 */
    var cntHint = el('div', { class: 'fs11 muted mt4', text: '' });
    /* 文案与口径都在 countHintText（模块级纯函数，测试直接断它）——
       这里只负责把「条数 / 关键词数 / 城市数」三个数取出来喂进去。 */
    function paintCountHint() {
      cntHint.innerHTML = countHintText(parseCount(f.count),
        collectKeywords(f).length, cityList(f.city).length);
    }

    /* ⛔ 这里原来还有两个「城市」「薪资范围」的格子 —— 但这两个控件**同时又**被
       append 到了下面的筛选区（appendChild 是"移动"，不是"复制"），所以那两个格子
       实际是**空的**：城市/薪资一直只长在筛选区里。去掉这两行死代码。
       城市现在跟区/商圈一起放在「📍 地点」里做三级下钻（它们本来就是一件事）。 */
    grid.appendChild(el('div', { class: 'fld' }, [
      el('label', { class: 'lb', text: '每个关键词抓多少条' }), cntInp, cntHint,
    ]));
    paintCountHint();
    body.appendChild(grid);
    body.appendChild(syncBar);

    /* --- 采集参数体检：把「采集参数」和「我的偏好」摆在一起看有没有打架 ---
       最典型的坑：期望 9-10K，采集档位却选了 10-20K —— BOSS 在服务端就把
       8-12K 这类正好匹配的岗位筛掉了，采回来的全是「薪资更高、要求也更高」的。
       这里只提示 + 给一键修正，不替用户改参数（改不改是用户自己的决定）。 */
    var diagBox = el('div', { class: 'stack', style: 'gap:8px' });
    function paintDiag() {
      diagBox.innerHTML = '';
      /* P2-2：参数一变就顺手刷新旁边的预估耗时（城市/期望/条数都会影响它）。
         refreshEstimate 自己带 8s 超时和 catch，采集器没起来也只是留空，不会打断渲染。 */
      refreshEstimate();
      // 参数一变，「和偏好差几项」也要跟着重算（同步条的文案就是它）
      paintSyncBar();
      // 条数的即时条数提示（纯本地算）也要跟着走
      paintCountHint();
      // 收起状态下的摘要（城市/关键词/条数/筛选项数）也要跟着走
      paintParamSum();
      if (!global.JobMatch) return;
      // 判定逻辑在 paramIssues()（纯函数，单测直接测它，不测这个渲染壳）
      paramIssues(f, global.JobMatch.prefs()).forEach(function (w) {
        var btns = [];
        if (w.code === 'salary') {
          if (w.fix && w.fix !== f.salary) {
            btns.push({ t: '改为「' + w.fix + '」', run: function () { f.salary = w.fix; salSel.value = w.fix; touchForm(); paintDiag(); } });
          }
          btns.push({ t: '改为「不限」', ghost: true, run: function () { f.salary = ''; salSel.value = ''; touchForm(); paintDiag(); } });
        } else if (w.code === 'city') {
          /* ⛔ 城市现在是 chipsRow（不是文本框）→ 必须重建那一行才看得到新值。
             以前这里写的是 `cityInp.value = f.city`，换成 chips 后那个变量已经不存在。 */
          btns.push({ t: '改用 ' + w.fix, run: function () { f.city = w.fix; touchForm(); paintCityRow(); paintGeo(); paintDiag(); } });
        } else if (w.code === 'jobs') {
          btns.push({ t: '一键补上这些岗位', run: function () { f.expectJobs = w.fix.slice(); touchForm(); paintExpect(); paintDiag(); } });
        } else if (w.code === 'experience') {
          // 经验是 chipGroup 就地渲染的，没有单个控件引用 —— 直接改 S.form 后重画整卡。
          if (w.fix && w.fix.length) {
            btns.push({ t: '改为「' + w.fix[0] + '」', run: function () { f.experience = [w.fix[0]]; touchForm(); App.refresh(); } });
          }
          btns.push({ t: '改为「经验不限」', ghost: true, run: function () { f.experience = ['经验不限']; touchForm(); App.refresh(); } });
        } else if (w.code === 'geo') {
          btns.push({ t: '清空这些区/商圈', run: function () { f.district = []; f.bizArea = []; S.geoOwned = true; touchForm(); paintGeo(); paintDiag(); } });
        }
        diagBox.appendChild(el('div', { class: 'note warn' }, [
          el('span', { class: 'ico', text: w.ico }),
          el('div', {}, [
            el('div', { html: w.html }),
            btns.length ? el('div', { class: 'row mt8', style: 'gap:6px;flex-wrap:wrap' },
              btns.map(function (bt) {
                return el('button', {
                  class: 'btn xs' + (bt.ghost ? ' ghost' : ''), type: 'button',
                  text: bt.t, onclick: bt.run,
                });
              })) : null,
          ].filter(Boolean)),
        ]));
      });
    }
    body.appendChild(diagBox);
    paintDiag();

    /* --- 采集方式：🔎 按关键词搜索（custom） / 🎯 按岗位直采（list） ---
       把后端早已支持的 `-m list` 暴露出来（P0）。两者都走 -p 通道（= keywords 合成词），
       区别只在 BOSS 怎么理解 -p：
         · custom = 关键词搜索（query 接口），模糊匹配，同义词岗位也会捞进来
         · list   = 岗位分类直采（position code 接口），只有「官方岗位名」才匹配得上
       ⛔ list 能精确命中的只有「岗位树（JOB_TAXONOMY）」里的官方岗位名 —— 它就是从
         BOSS 官方 post_data.json 生成的；而「真实在招」岗位名（招聘方自拟标题，
         如「抖音短视频运营」）不在官方表里，list 会匹配不到被跳过，那种该走 custom。 */
    var modeBox = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
    var modeHint = el('div', { class: 'fs11 muted mt4', text: '' });
    function paintMode() {
      modeBox.innerHTML = '';
      var cur = (f.crawlMode === 'list') ? 'list' : 'custom';
      [{ v: 'custom', l: '🔎 按关键词搜索', t: 'BOSS 搜索接口：关键词/岗位名模糊匹配，会把同义词岗位也捞进来（默认，最稳）' },
       { v: 'list', l: '🎯 按岗位直采', t: 'BOSS 岗位分类接口：按官方岗位名精确采集，更精准。只能选「岗位树」里的官方岗位名；真实在招的标题名请用关键词模式' }]
        .forEach(function (m) {
          var on = m.v === cur;
          modeBox.appendChild(el('button', {
            class: 'btn xs' + (on ? ' pri' : ' ghost'), type: 'button',
            text: m.l, title: m.t,
            onclick: function () {
              if (f.crawlMode === m.v) return;
              f.crawlMode = m.v;
              touchForm();
              paintMode();
              paintModeHint();
              paintParamSum();
            },
          }));
        });
    }
    function paintModeHint() {
      if (f.crawlMode === 'list') {
        modeHint.innerHTML = '按岗位直采：选中的<b>官方岗位名</b>会按 BOSS 岗位分类精确采集（更精准、更少杂质）。' +
          '⛔ 只能选「岗位树」里的官方名 —— 从「真实在招」选的岗位名（招聘方自拟标题）匹配不到官方分类、会被跳过，那种请改用「🔎 按关键词搜索」。';
      } else {
        modeHint.innerHTML = '按关键词搜索：关键词/岗位名走 BOSS 搜索接口，模糊匹配，同义词岗位也会捞进来（更全，但更杂）。';
      }
    }
    paintMode();
    paintModeHint();
    body.appendChild(el('div', { class: 'fld' }, [
      el('label', { class: 'lb', text: '采集方式' }),
      modeBox,
      modeHint,
    ]));

    /* --- 采集已采过岗位（去重开关） ---
       默认不勾选 = 跳过 known_links 里已有 JD 的历史岗位（去重，省风控额度）。
       勾选 = 重新采集历史岗位（爬虫不加载全局已知集），结果标「本轮新增」。 */
    var cbKnown = el('input', { type: 'checkbox' });
    cbKnown.checked = !!f.includeKnown;
    cbKnown.addEventListener('change', function () {
      f.includeKnown = cbKnown.checked;
      touchForm();
    });
    body.appendChild(el('div', { class: 'fld' }, [
      el('label', { class: 'chk' }, [
        cbKnown,
        el('span', { text: '采集已采过的岗位' }),
      ]),
      el('div', { class: 'fs11 muted mt4', html:
        '默认<b>不勾选</b> = 跳过历史已采岗位（去重，省风控额度）。' +
        '勾选后本轮把它们<b>重新采集</b>一遍，结果里标「本轮新增」，跳过统计为 0。' },
      ),
    ]));

    /* --- 岗位期望（官方分类树 + 真实在招岗位，两份数据共选） --- */
    var expectBox = el('div', { class: 'chips jp-expect' });
    function paintExpect() {
      /* 岗位期望也算「搜索关键词」（采集时两者合并）→ 它的增删要同步那行条数提示。
         放在最前面是因为下面有 early return（空列表直接 return），放后面会漏掉那条路径。 */
      paintCountHint();
      expectBox.innerHTML = '';
      var list = f.expectJobs || [];
      if (!list.length) {
        expectBox.appendChild(el('span', {
          class: 'fs11 muted jp-none',
          text: '还没选 —— 点右边「🔍 本次要搜的岗位」：官方分类 28 大类 / 1098 个岗位，' +
            '外加真实在招岗位名（杭州·运营方向 176 个）',
        }));
        return;
      }
      list.forEach(function (n) {
        expectBox.appendChild(el('span', {
          class: 'chip on jp-cpick', text: n + ' ✕', title: '点击移除「' + n + '」',
          onclick: function () {
            var i = f.expectJobs.indexOf(n);
            if (i >= 0) f.expectJobs.splice(i, 1);
            touchForm();
            paintExpect();
            paintSyncBar();
          },
        }));
      });
    }
    paintExpect();

    /* ⛔ 标题 / 按钮文案刻意和岗位库偏好面板**长得不一样**（那边叫「🎯 长期期望岗位」）。
       以前两边都叫「🎯 选择岗位」，标题也几乎一样 —— 用户点进去分不清自己正在改哪一份，
       改完了不知道改了哪儿。两个概念本来就不同：
         这里   = 这一次要去 BOSS 搜哪些岗位（并进搜索词）
         偏好里 = 长期“我只接受这些岗位”的硬过滤口径 */
    var pickJobBtn = el('button', {
      class: 'btn xs pri', type: 'button', html: '🔍 本次要搜的岗位',
      title: '选中的岗位会作为搜索词一起采集。⚠️ 这是「这一次要搜什么」，不是岗位库的长期期望岗位 —— 两边互不影响',
      onclick: function () {
        if (!global.JobPicker) { U.toast('岗位数据没加载（js/job-taxonomy.js）', 'bad'); return; }
        global.JobPicker.open({
          title: '🔍 本次要搜的岗位 · 官方分类 + 真实在招岗位',
          note: '确认后写入【采集表单】—— 会并进这次的搜索词。岗位库的「长期期望岗位」不受影响。',
          selected: (f.expectJobs || []).slice(),
          multiple: true,
          onConfirm: function (list) {
            f.expectJobs = list;
            touchForm();
            paintExpect();
            paintSyncBar();
            U.toast(list.length
              ? ('本次要搜 ' + list.length + ' 个岗位，会并进搜索词')
              : '已清空「本次要搜的岗位」', list.length ? 'ok' : 'warn', 4000);
          },
        });
      },
    });

    body.appendChild(el('div', { class: 'fld jp-expect-fld' }, [
      el('div', { class: 'row jp-expect-head' }, [
        el('label', { class: 'lb', text: '🔍 岗位期望（本次搜索用）' }),
        Comp.lvlBadge('server'),
        pickJobBtn,
      ].filter(Boolean)),
      expectBox,
      el('div', { class: 'fs11 muted mt4', html:
        '选中的岗位会作为<b>本次</b>搜索词一起采集；也可以只在下面手输关键词。' +
        '岗位库「⚙ 我的求职偏好」里的<b>长期期望岗位是另一份</b>（那边用来做硬过滤），' +
        '两边互不影响 —— 想拿过来点上面的「⤓ 从求职偏好带入」。' }),
    ]));

    /* --- BOSS 同款筛选面板（多级） --- */
    // 一个「点选/取消」的多选标签组：点了切换高亮并回写 state（就地改 class，不重画整卡）。
    function chipGroup(keys, state) {
      var box = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
      keys.forEach(function (k) {
        var on = state.indexOf(k) >= 0;
        var c = el('button', {
          class: 'chip' + (on ? ' on' : ''),
          type: 'button',
          text: k,
          onclick: function () {
            var i = state.indexOf(k);
            if (i >= 0) state.splice(i, 1); else state.push(k);
            c.classList.toggle('on', state.indexOf(k) >= 0);
            /* ⛔ chips 是 <button>，不会触发 input/change —— 落盘必须在这里显式调，
               否则「勾了福利 → 刷新 → 没了」（这类"改了没生效"的投诉就是这么来的）。 */
            touchForm();
            paintSyncBar();
          },
        });
        box.appendChild(c);
      });
      return box;
    }
    // 单选标签组（活跃度这种）：只有一个能亮。
    function chipSingle(keys, getCur, setCur) {
      var box = el('div', { class: 'row', style: 'gap:6px;flex-wrap:wrap' });
      keys.forEach(function (k) {
        var c = el('button', {
          class: 'chip' + (getCur() === k ? ' on' : ''),
          type: 'button',
          text: k,
          onclick: function () {
            setCur(getCur() === k ? '' : k);
            // 就地更新同组所有 chip 的高亮
            Array.prototype.forEach.call(box.children, function (b) {
              b.classList.toggle('on', b.textContent === getCur());
            });
            touchForm();
            paintSyncBar();
          },
        });
        box.appendChild(c);
      });
      return box;
    }
    /* ⛔ `level` 是「这一项在哪生效」的徽章（Comp.lvlBadge）：
       server=透传 BOSS 在服务端筛 / local=采回来再本地筛 / prefs=只影响岗位库。
       同一张卡混着三种，不标出来用户就会以为"我在这里勾什么 BOSS 就搜什么"。
       ⚠️ 徽章必须留在 `.fld` 的**同一层**、不能包一层 div —— `.fld > .lb` 是
          CSS 的直接子选择器，包一层标签样式就全丢了。 */
    function fld(label, kid, hint, level) {
      return el('div', { class: 'fld' }, [
        level ? Comp.lvlBadge(level) : null,
        el('label', { class: 'lb', text: label }), kid,
        hint ? el('div', { class: 'fs11 muted mt4', text: hint }) : null,
      ].filter(Boolean));
    }

    var filterBox = el('div', { class: 'stack', style: 'gap:10px' });

    /* ==================== 地点：省 > 市 > 区 > 商圈（四级级联）====================
       每一级的候选 = 内置区划 ∪ 库里真实采到的。父级一变就**重算下一级的候选**，
       并把下一级的**已选值清空** —— 不清会留下「选了上海、区却还是西湖区」这种
       跨市组合：界面上看着还选着呢，实际一条都命中不了，用户只会以为筛选坏了。

       ⛔ 清空只发生在 onChange（用户真的点了某个 chip）。
          **载入 / 恢复存档 / 继承偏好时绝不清** —— 存档里城市与区本来就是配套的，
          在恢复路径上"顺手清一下"会把用户上次的选择直接删掉。

       ⛔ 省**不传给 BOSS**（BOSS 的地区参数是城市级 code），它存在的唯一理由是让
          「城市」这一级的候选短一点、好找一点。所以它不带「透传 BOSS」徽章 ——
          带上等于撒谎（用户会以为选了省 BOSS 就按省搜）。 */
    var provBox = el('div', { class: 'stack', style: 'gap:6px' });
    var cityBox = el('div', { class: 'stack', style: 'gap:6px' });

    /** 读库。⛔ 包一层 try：库读挂掉时退回「空库」（候选只剩内置区划），
        好过一个异常把整张「② 采集参数」卡顶掉（表现是"页面白了"）。 */
    function allJobsNow() {
      try { return Store.jobs({ includeArchived: false }) || []; }
      catch (e) { return []; }
    }

    /* --- 省（第 1 级）--- */
    function paintProvRow() {
      provBox.innerHTML = '';
      /* geo.js 没引上（老缓存 / 残缺部署）→ 整级静默跳过。
         少这一层只是"城市列表长一点"，功能一点不少 —— 城市那一级会退回全量候选。 */
      if (!global.GEO || !Comp.chipsRow || !global.GEO.provinceChoices) return;
      provBox.appendChild(Comp.chipsRow({
        label: '省 / 自治区 / 直辖市',
        hint: '只用来收窄下面的城市候选，不传给 BOSS（BOSS 只认城市）',
        /* ⛔ 这里**不给手输框**：手写一个没有城市映射的省名，下一级必然空，
           用户会以为"选了省就采不到岗位"。要搜没收录的地方，用城市的输入框。 */
        options: global.GEO.provinceChoices(allJobsNow()),
        selected: cityList(f.province),
        selfPaint: false,
        onChange: function (v) {
          f.province = cityJoin(v);
          // 换省 → 城市 / 区 / 商圈全部作废（它们都属于上一个省）
          f.city = ''; f.district = []; f.bizArea = [];
          S.geoOwned = true;      // 用户表过态了 → 区/商圈从此归他，不再自动跟偏好
          touchForm();
          paintProvRow();         // selfPaint 关掉了 → 这一行的重画由这里负责
          paintCityRow();         // 城市候选跟着省变 → 必须整块重建，不能只重画自己
          paintGeo();
          paintDiag();
        },
      }));
    }

    /* --- 城市（第 2 级）---
       原来是**纯文本框**，而岗位库偏好面板是 chips 多选 —— 同一个概念两种控件，
       用户没法确认"这两边到底是不是一回事"。现在两边共用 GEO 的候选
       和同一个 chipsRow 组件：选项一致、交互一致，只剩「值各存一份」。 */
    function paintCityRow() {
      cityBox.innerHTML = '';
      if (global.GEO && Comp.chipsRow) {
        var allJobs = allJobsNow();
        var provs = cityList(f.province);
        /* 选了省 → 只列该省的城市；没选省 → **原样退回全量候选**（与老行为一字不差，
           否则用户会发现"我什么都没选，城市列表却变短了"）。 */
        var opts = (provs.length && global.GEO.citiesIn)
          ? global.GEO.citiesIn(provs, allJobs)
          : global.GEO.cityChoices(allJobs);
        cityBox.appendChild(Comp.chipsRow({
          label: '城市',
          hint: provs.length
            ? ('已选省：' + provs.join(' / ') + ' → 这里只列该省的城市')
            : '会传给 BOSS 当搜索条件；多个城市 = 多次搜索',
          options: opts,
          selected: cityList(f.city),
          custom: '其他城市，回车添加',
          badge: Comp.lvlBadge('server'),
          onChange: function (v) {
            f.city = cityJoin(v);
            // 换城市 → 区 / 商圈作废（候选和值都属于上一个城市）
            f.district = []; f.bizArea = [];
            S.geoOwned = true;
            touchForm();
            paintGeo();     // 换城市 → 区/商圈的候选跟着换
            paintDiag();
          },
        }));
      } else {
        /* geo.js 没引上（老缓存 / 残缺部署）→ 退回文本框。
           城市是必填项，宁可难看也不能让它消失。 */
        var inp = el('input', { type: 'text', value: f.city, placeholder: '杭州（多个用逗号分隔）' });
        inp.addEventListener('input', function () { f.city = inp.value; touchForm(); paintGeo(); paintDiag(); });
        cityBox.appendChild(el('div', { class: 'fld' }, [
          el('label', { class: 'lb', text: '城市' }), inp,
        ]));
      }
    }

    // 区 / 商圈（采集完成后自动精筛）
    var geoHint = el('div', { class: 'fs11 muted mt4', html:
      '只有<b>城市</b>会传给 BOSS 当搜索条件。<b>区 / 商圈不进搜索条件</b> —— 那需要 BOSS 页面里的地区 code，' +
      '本工具不猜（猜错了你会采回一堆错的还以为正常）。填在下面，' +
      '<b>采集完成后自动按采到的「区域 / 商圈」筛</b>，结果同样是干净的。' });
    var geoBox = el('div', { class: 'stack', style: 'gap:8px' });
    function paintGeo() {
      if (!global.GEO) return;   // geo.js 没引上就别渲染（跳过而不是抛）
      var allJobs = allJobsNow();
      var citiesSel = cityList(f.city);
      geoBox.innerHTML = '';
      geoBox.appendChild(Comp.chipsRow({
        label: '区（采集后精筛）', hint: '可多选；不选就是不限',
        /* 传**整份已选城市**（数组）而不是第一个 —— 选了两个城市时，区候选应该是
           这两个城市的并集，否则第二个城市选出来的区根本不在列表里。 */
        options: global.GEO.districtsOf(citiesSel, allJobs),
        selected: f.district,
        empty: citiesSel.length
          ? '这批数据里还没采到「区」—— 采集一次后会列出来；也可以直接手输'
          : '不选就是不限；也可以直接手输区名',
        custom: '其他区，回车添加',
        badge: Comp.lvlBadge('local'),
        selfPaint: false,
        onChange: function (v) {
          f.district = v;
          /* 换区 → 商圈作废：商圈候选只来自当前所选区（见下一条），
             留着旧的会变成"选了个列表里根本没有的商圈"，筛出来必然 0 条。
             与结果页筛选项同一口径（那边也是 `CF.district = v; CF.bizArea = []`）。 */
          f.bizArea = [];
          // 用户动过区/商圈 → 从此以他改的为准，不再自动跟着偏好走
          S.geoOwned = true;
          touchForm();
          paintGeo(); paintDiag();
        },
      }));
      geoBox.appendChild(Comp.chipsRow({
        label: '商圈 / 地标（采集后精筛）',
        hint: '只列「当前所选区」下真实采到的商圈；没选区就是全部',
        /* ⛔ 商圈**只来自真实数据**，且收窄到当前所选区 —— 见 geo.js 的 bizAreasOf。
           不内置、不跨区：凭印象写一份假清单，用户照着筛会静默漏岗位。 */
        options: global.GEO.bizAreasOf(f.district, allJobs),
        selected: f.bizArea,
        empty: f.district && f.district.length
          ? ('选中的区（' + f.district.join(' / ') + '）下还没采到商圈 —— 采集一次后会列出来；也可以手输')
          : '还没采到商圈数据 —— 采集一次后这里会自动列出真实商圈；也可以手输',
        custom: '商圈名，回车添加',
        badge: Comp.lvlBadge('local'),
        selfPaint: false,
        onChange: function (v) {
          f.bizArea = v;
          S.geoOwned = true;
          touchForm();
          paintGeo(); paintDiag();
        },
      }));
    }
    paintProvRow();
    paintCityRow();
    /* 交给 doImport() 用：导入完成后这三行的候选（省/市/区/商圈）都该跟着更新
       —— 详见文件顶部 paintGeoRows 的注释。 */
    paintGeoRows = function () { paintProvRow(); paintCityRow(); paintGeo(); };
    filterBox.appendChild(fld('📍 地点（省 > 市 > 区 > 商圈）', el('div', {}, [provBox, cityBox, geoHint, geoBox])));
    paintGeo();

    // 福利待遇（多选，本地筛）
    filterBox.appendChild(fld('🎁 福利待遇', chipGroup(welfareOpts(), f.welfare),
      'BOSS 搜索接口没有福利参数，这几项在采集后按结果里的福利标签自动过滤。' +
      '（选项和岗位库偏好共用一份，带同义词匹配：勾「带薪年假」也能命中「年假」）', 'local'));

    // 薪资
    /* 薪资：两个层次**必须分开标** —— 档位是搜索条件、自定义区间只是本地精筛。
       把区间也标成「透传 BOSS」就是撒谎（用户会以为 BOSS 按 15-25K 去搜了）。 */
    filterBox.appendChild(el('div', { class: 'fld' }, [
      el('label', { class: 'lb', text: '💰 薪资范围' }),
      el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap' }, [
        salSel, Comp.lvlBadge('server'),
      ]),
      el('div', { class: 'row', style: 'gap:6px;align-items:center;flex-wrap:wrap;margin-top:6px' }, [
        el('span', { class: 'fs12 muted', text: '自定义' }),
        salMinInp,
        el('span', { class: 'fs12 muted', text: '~' }),
        salMaxInp,
        el('span', { class: 'fs12 muted', text: 'K' }),
        Comp.lvlBadge('local'),
      ]),
      salWarn,
    ]));

    // 学历
    filterBox.appendChild(fld('🎓 学历', chipGroup(DEGREE_OPTIONS, f.degree), null, 'server'));

    // 经验
    filterBox.appendChild(fld('🧭 经验', chipGroup(EXPERIENCE_OPTIONS, f.experience), null, 'server'));

    // 公司规模
    filterBox.appendChild(fld('🏢 公司规模', chipGroup(SCALE_OPTIONS, f.scale), null, 'server'));

    // 融资阶段
    filterBox.appendChild(fld('💹 融资阶段', chipGroup(STAGE_OPTIONS, f.stage), null, 'server'));

    // 工作类型
    filterBox.appendChild(fld('📋 工作类型', chipGroup(JOBTYPE_OPTIONS, f.jobType), null, 'server'));

    // BOSS 活跃度（单选，本地筛）
    filterBox.appendChild(fld('🟢 BOSS 活跃度',
      chipSingle(ACTIVE_OPTIONS, function () { return f.activeTime; }, function (v) { f.activeTime = v; }),
      'BOSS 接口没有活跃度参数，采集后按 HR 活跃度字段自动过滤。', 'local'));

    body.appendChild(el('details', { class: 'fold', open: true }, [
      el('summary', { text: '筛选条件（像 BOSS 里那样筛）' }),
      el('div', { class: 'fd stack', style: 'gap:10px' }, [Comp.lvlLegend(), filterBox]),
    ]));

    var kw = el('textarea', { rows: 6, value: f.keywords, placeholder: '（可选）一行一个关键词，或用逗号分隔 —— 会与上面的「岗位期望」合并\n留空则由 AI 按简历推断（推荐）' });
    /* ⛔ 这里**只刷新本地那行条数提示**，不调 paintDiag —— 后者会打 /api/estimate，
       而这个 textarea 是逐字符 input、没有防抖，敲 6 个字就发 6 次请求。
       条数提示是纯本地算的，跟着走既即时又不要钱。 */
    kw.addEventListener('input', function () { f.keywords = kw.value; touchForm(); paintCountHint(); });
    body.appendChild(el('div', { class: 'fld' }, [
      Comp.lvlBadge('server'),
      el('label', { class: 'lb', text: '搜索关键词' }), kw,
      el('div', { class: 'fs11 muted mt4', html:
        '关键词越多，抓回来的岗位越杂。<b>建议 3-6 个精准词</b>，别把「运营」这种大词和「新媒体运营」混着放 —— ' +
        '大词会把一堆不相关的岗位捞进来。' }),
      /* P1 矩阵能力说明：留空时由模型按简历推「核心词 + 方向词」。
         ⛔ 这里只解释机制，不做任何推断 —— 推断全在服务端 infer 阶段（改提示词即可，
            前端不参与，避免两处口径不一致）。 */
      el('div', { class: 'fs11 muted mt4', html:
        '💡 <b>留空</b>也行：采集时会由模型按简历推断，除了核心岗位名还会补几个' +
        '「同方向的不同叫法」（如 内容运营 / 新媒体运营 / 短视频运营），' +
        '避免只搜一个词把池子收得太窄。想自己控制就填在这里，填了就<b>以你填的为准</b>。' }),
    ].filter(Boolean)));

    /* ⛔ 这条原来写的是「这些筛选是**透传给 BOSS 的搜索条件**」，压整块筛选区底下 ——
       可那一块里明明混着三种生效位置（福利/活跃度/区/商圈都是采回来才筛的）。
       一句话把三件事说成一件，用户就会以为"我勾什么 BOSS 就搜什么"，对不上就以为工具坏了。
       现在改成三种单独说清，并且每一项旁边挂了徽章（见上面的 fld(..., level)）。 */
    body.appendChild(el('div', { class: 'note info' }, [
      el('span', { class: 'ico', text: '💡' }),
      el('div', { html:
        '标 <b>🔎 透传 BOSS</b> 的项会写进 BOSS 的搜索条件（服务端就筛了，<b>真的少采</b>）；' +
        '标 <b>💻 采集后本地筛</b> 的项 BOSS 接口没有对应参数，采回来在结果里过滤（<b>不少采</b>）；' +
        '标 <b>🏠 只影响岗位库</b> 的项（在岗位库「⚙ 我的求职偏好」里）不参与采集，' +
        '只喂「按我的偏好筛选」和「合适度」。' }),
    ]));

    card.appendChild(body);
    /* 折叠状态：会话里以 S.paramOpen 为准（重画不弹回），首次渲染读 localStorage。 */
    setParamOpen(S.paramOpen === null ? readParamOpen() : S.paramOpen);
    return card;
  }

  function actionCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('header', {}, [
      el('h3', { text: '③ 登录与采集' }),
    ]));

    var lg = (S.ping && S.ping.login) || {};
    var body = el('div', { class: 'body stack' });

    /* ⛔ 按钮行必须是**可重画的**（评审 P1-9）：原来 `busy` 取自渲染那一刻的
       S.ping.busy 快照，而 startCrawl 成功只起 poll、**不 refresh** ⇒ 自己发起的采集
       永远看不到「■ 停止」（只有"进页面时后台已有任务"才看得到），用户只能关掉程序。
       现在三颗按钮装进 #cActions，由 poll 每轮调 paintActions() 就地重画。
       ⚠️ `cEstimate` / `cLoginHint` 留在外层**静态**节点：它们各自有独立的刷新写入点
          （refreshEstimate / 登录态变化），跟着一起重画会被清空。 */
    body.appendChild(el('div', { class: 'row' }, [
      el('div', { class: 'row', id: 'cActions', style: 'gap:8px;align-items:center' },
        actionButtons()),
      el('span', { class: 'sp' }),
      /* P2-2：开跑前就能看到「大概要等多久」。值由服务端 /api/estimate 算
         （本地猜一个数会和真实算法漂移）。这里只是它的显示位置，内容见 refreshEstimate()。 */
      el('span', { class: 'fs12 muted', id: 'cEstimate', text: '' }),
      /* ⛔ 这句提示必须跟着登录态走。
         原来无条件写死「首次用请先点『登录 BOSS』」—— 已登录时左边那颗按钮
         已经改名成「🔑 重新登录（扫码）」，页面上根本没有叫「登录 BOSS」的按钮，
         等于让用户去找一个不存在的东西（评审 A6）。
         另外它给一个 id，好让下面的断言/测试能定位到这句（不是靠遍历全页文字猜）。 */
      el('span', { class: 'fs12 muted', id: 'cLoginHint',
        text: lg.value === 'ok'
          ? '已登录。换账号 / 改过密码之后，点左边那颗按钮重新扫码'
          : '首次用请先点「🔑 ① 登录 BOSS」' }),
    ]));

    body.appendChild(el('div', { class: 'note warn' }, [
      el('span', { class: 'ico', text: '⚠' }),
      el('div', { html:
        '采集会<b>真的打开浏览器去翻 BOSS 的页面</b>。<br>' +
        '· 频率别调太猛：一次几十条、别连着跑十几轮，容易被风控限流。' +
        '这不是技术限制，是账号安全。<br>' +
        '· 采集期间<b>别关那个 Edge 窗口</b>，也别在里面手动乱点。' }),
    ]));

    /* B1 · 采集范围提示：把「服务端决定采多少」和「本地决定显示多少」的边界写死在
       页面上，免得用户以为勾了福利/活跃度/区/商圈会让采集变少（实际是采完再筛）。 */
    body.appendChild(el('div', { class: 'fs12 muted', style: 'margin-top:6px' }, [
      el('span', { text:
        '采集范围只由 城市 / 关键词 / 薪资档位 / 学历 / 经验 / 规模 / 融资 / 工作类型 决定；' +
        '福利 / 活跃度 / 区 / 商圈 是采集完成后的本地精筛，不影响这次采多少。' }),
    ]));

    body.appendChild(el('div', { class: 'fs12 muted fw6 mt4', text: '运行日志' }));
    var log = el('div', { class: 'logbox', id: 'cLog' });
    body.appendChild(log);

    card.appendChild(body);
    return card;
  }

  function resultCard() {
    var card = el('div', { class: 'card', id: 'cResult' });
    paintResultBody(card);
    return card;
  }

  /** 只画结果卡的内容。数据变了就单独重画它，不牵连其它卡。 */
  /* ---------------- 重画时保住输入焦点 ----------------
     实现统一放在 js/utils.js（U.captureFocus / U.restoreFocus / U.withFocusKept），
     这里只调用 —— 两个视图各写一份容易出现「一处修了一处没修」。
     背景见 utils.js 里 withFocusKept 的注释（评审 4.1）。 */

  function paintResultBody(card) {
    if (!card) return;
    // 必须在清空**之前**记下焦点（清完 activeElement 已经不是这个框了）
    var focusSnap = U.captureFocus(card);
    card.innerHTML = '';
    var r = S.result;
    var n = r && r.jobs ? r.jobs.length : 0;

    card.appendChild(el('header', {}, [
      el('h3', { text: '④ 采集结果' }),
      el('span', { class: 'sp' }),
      n ? el('span', { class: 'pill on' }, [el('span', { class: 'dt' }), n + ' 个岗位'])
        : el('span', { class: 'pill wait' }, [el('span', { class: 'dt' }), '暂无结果']),
    ]));

    var body = el('div', { class: 'body stack' });
    if (r && r.source) {
      body.appendChild(el('div', { class: 'fs12 muted', text: '数据来源：' + r.source }));
    }

    /* 「N 个岗位还没评分」提示条。
       只在**已经导入、但还没评分**的时候出现：
       一条没导入时提示"还没评分"没意义（下面就是导入按钮），
       全评完了还挂个提示条就是噪音。 */
    if (n) {
      var un = resultUnscored();
      if (un.length) {
        body.appendChild(el('div', { class: 'note info' }, [
          el('span', { class: 'ico', text: '🤖' }),
          el('div', {}, [
            el('div', { html: '<b>' + un.length + '</b> 个采集来的岗位还没评分。' +
              '让简历给它们打个分，才知道哪几个值得投。' }),
            el('div', { class: 'row mt8' }, [
              el('button', {
                class: 'btn pri sm', html: '🤖 给结果一键评分',
                title: '只给采集结果里的这些岗位评分；点开会先看到预计耗时和费用，确认了才会开始花钱',
                onclick: function () { scoreResults(un); },
              }),
            ]),
          ]),
        ]));
      }
    }

    if (!n) {
      body.appendChild(el('div', { class: 'note info' }, [
        el('span', { class: 'ico', text: '📭' }),
        el('div', { html:
          '运行目录里还没有采集结果。跑完一次采集后这里会出现岗位清单，' +
          '点「导入岗位库」就能开始做 AI 匹配、投递跟踪。' }),
      ]));
    } else {
      /* --- 筛选栏：像 BOSS 里那样筛这批采集结果 --- */
      var jobs = resultJobs();
      // 「只看本次新增」默认（§五-3 / 3.5）：第一次拉到「有本轮信息 + 有新增」的结果时，
      // 默认切到只看新增（用户刚采完最想看这批），此后不再强行覆盖用户的选择。
      if (!_onlyNewDefaulted && hasRoundInfo() && newCount() > 0) {
        CF.onlyNew = true;
        _onlyNewDefaulted = true;
      }
      var cities = resultCities(jobs);
      var industries = resultIndustries(jobs);
      /* ⛔ 必须拆成两个：`filteredAll` 是过筛后的**候选池**（分母），
         `filtered` 是再按 🎯 精选切完的**最终结果**（分子）。
         只留一个的话「候选 412 条里选出前 50 条」这句话就没有数可算了。 */
      var filteredAll = filterResults(jobs);
      var filtered = pickTop(filteredAll);
      var g = cfGeo();   // 结果列表里标「📍 区未知」用（同一份条件，不重复判断）

      /* 薪资档位：与参数卡统一用 BOSS 同款档（SALARY_OPTIONS / SALARY_BAND），
         不再另起一套「10K 以下/20-30K」自定档（评审 P2-2）——两套分档会让用户
         参数卡选「10-20K」、结果页却冒出 7K 的岗位，以为筛选没生效。统一后
         seedCFFromForm 能直接把参数卡的薪资搬过来。 */
      var SALARY_BANDS = [{ v: '', l: '薪资不限' }]
        .concat(SALARY_OPTIONS.map(function (s) { return { v: s, l: s }; }))
        .concat([{ v: 'none', l: '未标薪资' }]);

      var kw = el('input', { type: 'text', value: CF.kw,
        // data-focus-key：这张卡整卡重画时靠它把焦点还回来（评审 4.1）
        'data-focus-key': 'cf-kw',
        placeholder: '搜索这批岗位，也可写「杭州 运营 15k」', style: 'max-width:260px' });
      kw.addEventListener('input', U.debounce(function () {
        CF.kw = kw.value.trim();
        paintResultBody(card);
      }, 150));

      var selCity = mkCollectSel([{ v: '', l: '全部城市' }].concat(cities.map(function (c) { return { v: c, l: c }; })),
        CF.city, function (v) {
          CF.city = v;
          // 换城市后原来的区/商圈可能不属于这个城市了 → 一起清掉，避免"选了却 0 条"
          CF.district = []; CF.bizArea = [];
          paintResultBody(card);
        });
      var selIndustry = mkCollectSel([{ v: '', l: '全部行业' }].concat(industries.map(function (i) { return { v: i, l: i }; })),
        CF.industry, function (v) { CF.industry = v; paintResultBody(card); });
      // 岗位名：选项来自 JOB_MARKET（杭州·运营方向 300 条采集样本里的真实岗位标题）
      var mkMeta = (global.JOB_MARKET && global.JOB_MARKET.meta) || {};
      var selJob = marketJobOptions().length > 1
        ? mkCollectSel(marketJobOptions('全部岗位名'), CF.job,
            function (v) { CF.job = v; paintResultBody(card); },
            { title: '按岗位名筛 —— 选项来自 ' + (mkMeta.city || '采集') + ' ' +
              (mkMeta.sample || 0) + ' 条真实采集样本里的 ' + (mkMeta.titles || 0) + ' 个岗位标题' })
        : null;
      var selSalary = mkCollectSel(SALARY_BANDS, CF.salary, function (v) { CF.salary = v; paintResultBody(card); },
        { title: '采集时 BOSS 已在服务端按档筛过；这里对跨轮累积的结果池再筛一遍（口径一致）' });
      /* 自定义薪资区间（本地精筛）：与档位是两个独立条件，两个都填就是"与"。
         data-focus-key → 整卡重画后焦点与光标能还回来（否则敲两个数字就被打断）。 */
      var cfSalMin = el('input', { type: 'number', min: '1', style: 'width:62px', placeholder: '下限K',
        'data-focus-key': 'cf-sal-min',
        title: '自定义薪资下限（K，本地精筛）。留空 = 这一头不限',
        value: (CF.salaryMin === null || CF.salaryMin === undefined) ? '' : String(CF.salaryMin) });
      var cfSalMax = el('input', { type: 'number', min: '1', style: 'width:62px', placeholder: '上限K',
        'data-focus-key': 'cf-sal-max',
        title: '自定义薪资上限（K，本地精筛）。留空 = 这一头不限',
        value: (CF.salaryMax === null || CF.salaryMax === undefined) ? '' : String(CF.salaryMax) });
      function onCfSalInput() {
        CF.salaryMin = parseK(cfSalMin.value);
        CF.salaryMax = parseK(cfSalMax.value);
        paintResultBody(card);
      }
      cfSalMin.addEventListener('input', U.debounce(onCfSalInput, 220));
      cfSalMax.addEventListener('input', U.debounce(onCfSalInput, 220));
      var cfSalBox = el('span', { class: 'row nowrap', style: 'gap:3px;align-items:center' }, [
        el('span', { class: 'fs11 muted', text: '自定义' }), cfSalMin,
        el('span', { class: 'fs11 muted', text: '~' }), cfSalMax,
      ]);
      var selScored = mkCollectSel(
        [{ v: '', l: '评分不限' }, { v: 'scored', l: '已评分' }, { v: 'unscored', l: '未评分' }],
        CF.scored, function (v) { CF.scored = v; paintResultBody(card); });
      // BOSS 活跃度
      var selActive = mkCollectSel(
        [{ v: '', l: '活跃度不限' }].concat(ACTIVE_OPTIONS.map(function (a) { return { v: a, l: a }; })),
        CF.active, function (v) { CF.active = v; paintResultBody(card); });
      var selSort = mkCollectSel(
        [{ v: 'default', l: '原始顺序' }, { v: 'fit', l: '合适度高→低' },
         { v: 'salary', l: '薪资高→低' },
         { v: 'score', l: 'AI 匹配分高→低' }, { v: 'company', l: '按公司' }],
        CF.sort, function (v) { CF.sort = v; paintResultBody(card); });

      /* 本地「合适度」分级：选项从 job-score.js 的 LEVELS 生成，不在这里再抄一份 */
      var FIT_SEL = [{ v: '', l: '合适度不限' }].concat(
        (global.JobScorer ? global.JobScorer.levels() : []).map(function (lv) {
          return { v: lv.key, l: lv.key + ' ' + lv.label + '（≥' + lv.min + '）' };
        }));
      var selFit = mkCollectSel(FIT_SEL, CF.fit, function (v) { CF.fit = v; paintResultBody(card); });

      /* AI 判定筛选（P0）：只在这批结果**已经有 AI 判定**时才出现 ——
         没跑过清洗就摆一个恒为空的筛选项，是纯噪音。
         ⛔ 用 `jobs`（本作用域早就有），不能用 allJobs —— 那个在下面导入按钮
            那段才声明，var 提升后这里是 undefined，会导致整张卡渲染抛错。 */
      var aiSum = global.AICollect ? global.AICollect.summarize(
        jobs.map(function (j) { return { aiCollect: aiVerdictOf(j) }; })) : null;
      var selAi = (aiSum && aiSum.total) ? mkCollectSel(
        [{ v: '', l: 'AI 判定不限' },
         { v: 'relevant', l: '对口（' + aiSum.relevant + '）' },
         { v: 'uncertain', l: '待定（' + aiSum.uncertain + '）' },
         { v: 'irrelevant', l: '不对口（' + aiSum.irrelevant + '）' }],
        CF.aiCleanVerdict,
        function (v) { CF.aiCleanVerdict = v; paintResultBody(card); },
        { title: 'AI 清洗的判定结果。只看不删 —— 选回「不限」就把全部放回来' }) : null;

      body.appendChild(el('div', { class: 'row', style: 'gap:8px;flex-wrap:wrap' }, [
        kw, selJob, selCity, selIndustry, selSalary, cfSalBox, selActive, selScored, selFit,
        selAi, selSort,
        collectHasFilter() ? el('button', {
          class: 'btn xs ghost', text: '✕ 清空筛选',
          onclick: function () { clearCF(); paintResultBody(card); },
        }) : null,
      ].filter(Boolean)));

      /* --- 福利 / 区 / 商圈：多选 chips（chips 要能换行，和上面那排下拉分开）--- */
      var welfareChoices = welfareOpts();
      var districts = resultDistricts(jobs, CF.city);
      var bizAreas = resultBizAreas(jobs, CF.district);
      if (welfareChoices.length || districts.length || bizAreas.length) {
        var geoRow = el('div', { class: 'geo-wrap' });
        var geoSrc = el('div', { class: 'stack', style: 'gap:8px' });

        function paintResultGeo() {
          geoSrc.innerHTML = '';
          /* 福利多选：与参数卡、与区/商圈口径一致（任一命中即保留）。
             ⚠️ 以前这里是单选下拉、只取 CF.welfare[0]，参数卡搬过来多个却只生效 1 个。 */
          if (welfareChoices.length) {
            geoSrc.appendChild(Comp.chipsRow({
              label: '福利（多选 · 任一命中）',
              hint: '选项来自这批结果里真实采到的福利标签',
              options: welfareChoices,
              selected: U.asArray(CF.welfare),
              empty: '还没有福利数据 —— 采集一次后会自动列出',
              selfPaint: false,
              onChange: function (v) { CF.welfare = v; paintResultBody(card); },
            }));
          }
          if (districts.length) {
            geoSrc.appendChild(Comp.chipsRow({
              label: '📍 区（多选）',
              hint: '选项来自这批结果里真实采到的区域',
              options: districts,
              selected: U.asArray(CF.district),
              selfPaint: false,
              onChange: function (v) { CF.district = v; CF.bizArea = []; paintResultBody(card); },
            }));
          }
          if (bizAreas.length) {
            geoSrc.appendChild(Comp.chipsRow({
              label: '📍 商圈（多选）',
              hint: '选「区」后这里只列该区的商圈',
              options: bizAreas,
              selected: U.asArray(CF.bizArea),
              selfPaint: false,
              onChange: function (v) { CF.bizArea = v; paintResultBody(card); },
            }));
          }
        }
        paintResultGeo();
        geoRow.appendChild(geoSrc);
        body.appendChild(geoRow);
      }

      /* --- 合适度分级条：这批结果成色一眼可见 --- */
      var fs = fitSummary(jobs);
      var fitRow = el('div', { class: 'fitbar' });
      fitRow.appendChild(el('span', { class: 'lb', text: '🎯 合适度' }));
      (global.JobScorer ? global.JobScorer.levels() : []).forEach(function (lv) {
        var n = fs[lv.key] || 0;
        var on = CF.fit === lv.key;
        fitRow.appendChild(el('span', {
          class: 'fchip ' + lv.cls + (on ? ' on' : '') + (n ? '' : ' zero'),
          title: lv.label + '：' + lv.advice,
          onclick: function () { CF.fit = on ? '' : lv.key; paintResultBody(card); },
        }, [
          el('span', { text: lv.key + ' ' + lv.label }),
          el('span', { class: 'fchip-n', text: ' ' + n }),
        ]));
      });
      if (fs.drop) {
        fitRow.appendChild(el('span', {
          class: 'fchip bad' + (CF.hideDrop ? ' on' : ''),
          title: '硬性过滤判定为不值得投（城市不符 / 岗位实质不符 / 命中不能接受的点）。点一下隐藏。',
          onclick: function () { CF.hideDrop = !CF.hideDrop; paintResultBody(card); },
        }, [el('span', { text: (CF.hideDrop ? '已隐藏 ' : '剔除 ') + fs.drop })]));
      }
      /* 「只看本次新增」——只在后端确实提供了本轮信息时才给这个开关。
         没有 round_links.json（老数据/采集被中断）时不给，免得点了变成空列表
         让用户以为数据没了。 */
      if (hasRoundInfo() && newCount() > 0) {
        fitRow.appendChild(el('span', {
          class: 'fchip new' + (CF.onlyNew ? ' on' : ''),
          title: '只显示本轮采集真正新增的岗位（不含以前攒下的历史池）',
          onclick: function () { CF.onlyNew = !CF.onlyNew; paintResultBody(card); },
        }, [el('span', { text: (CF.onlyNew ? '只看新增 ' : '本次新增 ') + newCount() })]));
      }
      /* 🎯 切合值：连续「≥ N 分」门槛 —— 用户要的「匹配度自由范围 60-100 / 80-100」
         就是这里填 60 / 80。0 = 不限。它是**展示过滤**（可随时改回 0 放回岗位），
         与上面「分级 A/B/C/D」（只看某一级）互补：分级是粗档，切合值是连续精调。 */
      var geN = CF.minFit > 0
        ? jobs.filter(function (j) {
            var rr = cfFitOf(j);
            return rr && !rr.gate.drop && (rr.total || 0) >= CF.minFit;
          }).length
        : 0;
      var minFitInp = el('input', {
        type: 'number', min: '0', max: '100', value: String(CF.minFit || 0),
        'data-focus-key': 'cf-minfit', style: 'width:56px',
        title: '切合值：只显示合适度 ≥ 这个分的岗位（0 = 不限）。例：填 60 = 只看 60 分以上（A+B 级）；填 80 = 只看强推' });
      minFitInp.addEventListener('input', U.debounce(function () {
        var v = parseInt(minFitInp.value, 10);
        CF.minFit = (isNaN(v) || v < 0) ? 0 : Math.min(v, 100);
        writeMinFit(CF.minFit);
        paintResultBody(card);
      }, 200));
      var minFitBox = el('span', { class: 'row nowrap', style: 'gap:3px;align-items:center' }, [
        el('span', { class: 'fs11 muted', text: '切合值 ≥' }),
        minFitInp,
        el('span', { class: 'fs11 muted', text: '分' }),
      ]);
      if (CF.minFit > 0) {
        minFitBox.appendChild(el('span', {
          class: 'fchip ok' + (geN ? '' : ' zero'),
          title: '合适度 ≥ ' + CF.minFit + ' 分的岗位数（已过滤到只剩这些；填 0 = 放回全部）',
        }, [el('span', { text: '达标 ' + geN })]));
      }
      fitRow.appendChild(minFitBox);
      fitRow.appendChild(el('span', { class: 'sp' }));
      fitRow.appendChild(el('span', { class: 'fs11 muted', html:
        '本地规则打分 · 零成本可解释' + (fs.blind ? '（' + fs.blind + ' 个 JD 没采到，只看了标题）' : '') +
        '　<a class="brand-c" data-fit-help="1" style="cursor:pointer">怎么算的</a>' }));
      fitRow.addEventListener('click', function (e) {
        if (e.target && e.target.getAttribute && e.target.getAttribute('data-fit-help')) {
          global.JobScorer.openHelp();
        }
      });
      body.appendChild(fitRow);

      /* 🎯 简历匹配度区间（P2）：只在对岗位跑过「简历匹配」后出现（有 matchScore
         才筛得动）。与上面「切合值」（本地规则分）是两个独立维度：这是服务端简历
         画像 + 模型算出来的匹配分（含 LLM 二筛），可自由设 60~100 / 80~100。 */
      if (jobs.some(function (j) { return typeof j.matchScore === 'number'; })) {
        var mmLo = el('input', {
          type: 'number', min: '0', max: '100', style: 'width:56px', placeholder: '60',
          'data-focus-key': 'cf-match-min',
          value: (CF.matchMin === null || CF.matchMin === undefined) ? '' : String(CF.matchMin),
          title: '匹配度下限（含，留空 = 不限）。例：填 60 = 只看简历匹配 ≥ 60 分的岗位' });
        var mmHi = el('input', {
          type: 'number', min: '0', max: '100', style: 'width:56px', placeholder: '100',
          'data-focus-key': 'cf-match-max',
          value: (CF.matchMax === null || CF.matchMax === undefined) ? '' : String(CF.matchMax),
          title: '匹配度上限（含，留空 = 不限）。例：填 100 = 只看 100 分' });
        function readMM() {
          var lo = parseInt(mmLo.value, 10), hi = parseInt(mmHi.value, 10);
          CF.matchMin = (isNaN(lo) || lo < 0) ? null : Math.min(lo, 100);
          CF.matchMax = (isNaN(hi) || hi < 0) ? null : Math.min(hi, 100);
        }
        mmLo.addEventListener('input', U.debounce(function () { readMM(); paintResultBody(card); }, 200));
        mmHi.addEventListener('input', U.debounce(function () { readMM(); paintResultBody(card); }, 200));
        body.appendChild(el('div', { class: 'row',
          style: 'margin-top:6px;gap:6px;align-items:center;flex-wrap:wrap' }, [
          el('span', { class: 'fs12 fw6', text: '🎯 简历匹配度' }),
          mmLo,
          el('span', { class: 'fs12 muted', text: '% ~' }),
          mmHi,
          el('span', { class: 'fs12 muted', text: '%' }),
          el('span', { class: 'fs11 muted', text: '（自由范围，如 60~100 / 80~100；留空 = 不限）' }),
        ]));
      }

      /* --- 结果计数 --- */
      /* 文案别再写「本批」——CSV 是按关键词跨轮累积的，这里返回的是**累积池**，
         不是「这一轮采的」。如实说「结果池」+「本次新增 N」，用户才不会被误导
         （体检报告 §1.3）。 */
      var poolLabel = hasRoundInfo()
        ? '结果池共 ' + jobs.length + ' 个 · 本次新增 ' + newCount() + ' 个'
        : '结果池共 ' + jobs.length + ' 个岗位';
      var countLine = collectHasFilter()
        ? '显示 ' + filtered.length + ' 个 · ' + poolLabel
        : poolLabel;
      /* 地理筛选生效时，把「因为没采到区/商圈才被放行」的条数说清楚 ——
         不说的话用户会以为筛选没生效（同「薪资为空的岗位一律保留」的道理）。 */
      var ug = cfGeo() ? listUnknownGeo(filtered) : null;
      if (ug && ug.n) {
        countLine += ' · 其中 ' + ug.n + ' 个没采到区/商圈，先留着';
      }
      body.appendChild(el('div', { class: 'fs12 muted', style: 'margin-top:2px', text: countLine }));

      /* --- 🎯 精选：最终只要最精准的 N 条 -----------------------------------
         这是用户口中「我设 50 条」的**真正含义** —— 不是每个关键词抓多少，而是
         **最终要拿到多少条最合适的**。所以它不重跑采集：只在过筛后的候选池里按
         本地合适度排序取前 N，改一下数字立刻重排（零 token、零风控）。 */
      var wantedInp = el('input', {
        type: 'number', min: '0', max: '500', value: String(CF.wanted || 0),
        // 整卡重画时靠它把焦点还回来（和 cf-kw 同一套机制）
        'data-focus-key': 'cf-wanted', style: 'width:72px' });
      wantedInp.addEventListener('input', U.debounce(function () {
        var v = parseInt(wantedInp.value, 10);
        CF.wanted = (isNaN(v) || v < 0) ? 0 : Math.min(v, 500);
        writeWanted(CF.wanted);
        paintResultBody(card);
      }, 200));
      body.appendChild(el('div', { class: 'row',
        style: 'margin-top:6px;gap:6px;align-items:center;flex-wrap:wrap' }, [
        el('span', { class: 'fs12 fw6', text: '🎯 最终只要最精准的' }),
        wantedInp,
        el('span', { class: 'fs12 muted', text: '条（填 0 = 不限）' }),
        el('span', { class: 'fs12 muted', text: wantedInfoText(filteredAll.length, filtered.length) }),
      ]));

      /* A 档 · 采集漏斗：把「设了 N 条为什么只新增 M 条」当场摊开。
         数值来自采集日志（poll / 挂载时喂进 absorbLines），这里只负责那个容器。 */
      var funnelHost = el('div', { id: 'cFunnel' });
      body.appendChild(funnelHost);
      paintFunnel(funnelHost);

      /* 重采同一组关键词时「本次新增 0」要给解释（评审 P1-3.3）：不是采集坏了，而是
         这组词上次采过、旧岗位全被 skip（skip 不计入 written），再跑只会拿到 BOSS 新发布的。 */
      if (hasRoundInfo() && newCount() === 0 && jobs.length > 0) {
        body.appendChild(el('div', { class: 'note info', style: 'margin-top:6px' }, [
          el('span', { class: 'ico', text: 'ℹ️' }),
          el('div', { text:
            '这次没有新增岗位：这组关键词之前采过，旧岗位都在下面这个「结果池」里（历史累积，不会重新抓一遍）。' +
            '再跑一次只会拿到 BOSS 新发布的岗位。' }),
        ]));
      }

      /* 权威岗位要求命中（评审 P0-2.1）：把「JD 抽出的学历/经验/技能」这条能力
         摆出来 —— 以前 reqHits/reqTotal 后端算了、前端零引用，用户不知道它有没有生效。 */
      var rq = reqHitsInfo();
      if (rq && rq.hits > 0) {
        body.appendChild(el('div', { class: 'fs12 muted', style: 'margin-top:2px',
          text: '其中 ' + rq.hits + ' 个岗位挂上了 JD 抽出的权威要求（学历/经验/技能）' }));
      }

      /* 详情抓取失败明示（P1-3）：以前失败只打一行日志、界面只有小字，
         用户以为数据是全的。这里单独一条，带原因，并说明影响范围。 */
      var df = detailFailures();
      if (df && df.count) {
        var reasons = Object.keys(df.reasons).map(function (r) {
          return r + ' ' + df.reasons[r] + ' 个';
        }).join('；');
        body.appendChild(el('div', { class: 'note warn', style: 'margin-top:6px' }, [
          el('span', { class: 'ico', text: '⚠️' }),
          el('div', {}, [
            el('div', { html:
              '有 <b>' + df.count + '</b> 个岗位的<b>详情没抓到</b>（' + U.esc(reasons) + '）。' +
              '这些岗位只有列表页字段（岗位名 / 公司 / 薪资），没有 JD 和公司简介 —— ' +
              '本地合适度会对它们退化成「只看了标题」。' }),
            /* §五-6：详情按需补抓入口。底层 already 支持增量（detail_existing_links
               会跳过已有详情的岗位），所以「再采集一次」只补缺的、不重复抓 —— 这里
               给一个直达按钮，而不是让用户自己去找「开始采集」。（不是新增风控暴露，
               是复用采集流程补详情，且会跳过已抓的。） */
            el('div', { class: 'row mt8', style: 'gap:6px;flex-wrap:wrap' }, [
              el('button', {
                class: 'btn xs pri', type: 'button', text: '🔄 只补抓这几个详情',
                title: '用当前参数再采集一次：已抓到的详情会自动跳过，只补缺的那几个',
                onclick: function () {
                  U.toast('将复用当前参数补抓详情，已抓到的会自动跳过。' +
                    '请确认浏览器已登录 BOSS。', 'info', 6000);
                  doCrawl();
                },
              }),
            ]),
          ]),
        ]));
      }

      /* --- 岗位列表（按筛选结果）--- */
      if (!filtered.length) {
        body.appendChild(el('div', { class: 'empty' }, [
          el('div', { class: 'big', text: '🔍' }),
          el('b', { text: '没有符合筛选条件的岗位' }),
          el('p', { text: '试着放宽筛选条件，或清空筛选。' }),
          el('button', {
            class: 'btn', text: '清空筛选',
            onclick: function () { clearCF(); paintResultBody(card); },
          }),
        ]));
      } else {
        var byKey = importedKeySet();
        var list = el('div', { class: 'job-list' });
        /* 筛选条件变过 → 回到首屏条数；没变 → 保持用户已展开的数量。
           （放在渲染前算，避免「加载更多」重绘时被误重置。） */
        var sig = cfSignature();
        if (sig !== resultSig) { resultSig = sig; resultShown = resultPageSize(); }
        var visible = filtered.slice(0, resultShown);
        visible.forEach(function (j) {
          var done = isImported(j, byKey);
          var v = j.aiVerdict || {};
          list.appendChild(el('div', { class: 'job' }, [
            el('div', { class: 'row' }, [
              el('b', { text: j.title || '（无岗位名）' }),
              el('span', { class: 'sp' }),
              (v.score !== undefined && v.score !== null)
                ? el('span', { class: 'fs12 brand-c fw6', text: '匹配分 ' + v.score })
                : null,
              el('span', { class: 'fs12 brand-c fw6', text: j.salaryText || '面议' }),
            ].filter(Boolean)),
            el('div', { class: 'fs12 muted row', style: 'gap:6px;flex-wrap:wrap;align-items:center' }, [
              el('span', { text: [j.company, j.location, j.industry].filter(Boolean).join(' · ') }),
              // 地理筛选生效时标明「这条是没数据才留下的」，别让用户以为它匹配上了
              (g && global.GEO && global.GEO.unknownArea(j, g))
                ? el('span', { class: 'tag warn', text: '📍 区未知',
                    title: '这条没采到「区域/商圈」字段，所以筛选时先留着 —— 不是它匹配上了' }) : null,
              j.proxyHire ? el('span', { class: 'tag warn', text: '代招', title: 'BOSS 标注为代招' }) : null,
              j.invalid ? el('span', { class: 'tag bad', text: '已失效', title: 'BOSS 标注已下线' }) : null,
            ]),
            /* 合适度：每一条都写明「为什么是这个分 / 为什么直接剔除」。
               在采集页就能看清成色，不用先导库再回来筛。 */
            Comp.fitLine(cfFitOf(j)),
            /* 🎯 简历匹配（P2）：服务端 run_matcher 产出的打分 + 原因（含 LLM 二筛）。
               与上面的「匹配分」(aiVerdict，前端 AI) 是两条独立链路：这个是简历画像 +
               采集器接的模型 API 算的，可解释（说明为什么是这个分）。 */
            (typeof j.matchScore === 'number')
              ? el('div', { class: 'fs12 row', style: 'gap:6px;align-items:baseline;flex-wrap:wrap' }, [
                  el('span', { class: 'brand-c fw6', text: '🎯 简历匹配 ' + j.matchScore + ' 分' }),
                  j.matchReason ? el('span', { class: 'muted', text: U.esc(j.matchReason) }) : null,
                ].filter(Boolean))
              : null,
            done ? el('div', { class: 'fs11 muted', text: '✔ 已在岗位库' }) : null,
          ].filter(Boolean)));
        });
        body.appendChild(list);
        if (filtered.length > visible.length) {
          /* 还有没显示完的 —— 给「加载更多 / 全部展开」两个出口。
             （体检报告 §3.1：采集页最影响实操的一点就是结果被硬截断。） */
          var remain = filtered.length - visible.length;
          body.appendChild(el('div', {
            class: 'row', style: 'margin-top:8px;gap:8px;align-items:center',
          }, [
            el('button', {
              class: 'btn', text: '加载更多（还有 ' + remain + ' 个）',
              onclick: function () {
                resultShown += resultPageSize();
                paintResultBody(card);
              },
            }),
            el('button', {
              class: 'btn ghost', text: '全部展开（' + filtered.length + ' 个）',
              onclick: function () {
                resultShown = filtered.length;
                paintResultBody(card);
              },
            }),
            el('span', { class: 'fs12 muted', text: '已显示 ' + visible.length + ' / ' + filtered.length }),
          ]));
        } else if (filtered.length > RESULT_PAGE) {
          body.appendChild(el('div', { class: 'fs12 muted', style: 'margin-top:6px',
            text: '已显示全部 ' + filtered.length + ' 个' }));
        }
      }
    }

    /* --- 导入按钮（§五-3 / 3.5）：有本轮信息时主按钮 = 「导入本次新增」，
       无本轮信息（老数据/采集被中断）时退回「导入全部 / 导入筛选结果」。 --- */
    var hasRound = hasRoundInfo();
    var newN = hasRound ? newCount() : 0;
    var allJobs = resultJobs();
    var filteredList = pickTop(collectHasFilter() ? filterResults(allJobs) : allJobs);
    var newList = hasRound ? allJobs.filter(function (j) { return !!j.isNew; }) : [];
    // 主按钮导入的目标：优先「本次新增」；否则「筛选结果」；否则「全部」
    /* 🎯 精选开着时，主按钮直接就是"导入精选那批" —— 用户要的就是这 N 条，
       让他还得先想清楚"本次新增 vs 筛选结果"哪个才是精选，是多余的心智负担。 */
    var picking = (typeof CF.wanted === 'number' && !isNaN(CF.wanted) && CF.wanted > 0);
    var primaryList = picking ? filteredList
      : ((hasRound && newN > 0) ? newList : filteredList);
    var primaryLabel = picking
      ? '📥 导入精选的 ' + filteredList.length + ' 条'
      : ((hasRound && newN > 0)
        ? '📥 导入本次新增（' + newList.length + '）'
        : (collectHasFilter() ? '📥 导入筛选后的岗位（' + filteredList.length + '）'
          : '📥 导入岗位库（' + filteredList.length + '）'));
    body.appendChild(el('div', { class: 'row' }, [
      el('button', {
        class: 'btn pri',
        html: primaryLabel,
        disabled: !primaryList.length,
        onclick: function (e) { importResult(e.target, { list: primaryList }); },
      }),
      // 有本轮信息时，「导入全部」降为次要按钮；否则它就是唯一的导入入口（主按钮已覆盖）
      (hasRound && newN > 0) ? el('button', {
        class: 'btn', html: '📥 导入全部（' + n + '）',
        title: '忽略「只看本次新增」，把结果池里的岗位全部导入',
        onclick: function (e) { importResult(e.target); },
      }) : (n ? el('button', {
        class: 'btn', html: '📥 导入全部（' + n + '）',
        title: '忽略筛选，把采集到的岗位全部导入',
        onclick: function (e) { importResult(e.target); },
      }) : null),
      n ? el('button', {
        class: 'btn', html: '🎯 简历匹配',
        title: '对已采集岗位做简历匹配：初筛（规则 · 零 token）或二筛（AI · 逐岗打分 + 说明原因）',
        onclick: function () { openMatchModal(); },
      }) : null,
      el('button', { class: 'btn', html: '🔄 刷新结果', onclick: function () { loadResult(); } }),
      /* AI 清洗（P0）：只在「设置里开了开关 + 配了模型」时出现。
         ⛔ 默认关闭 —— 它是花钱的功能，不该开箱就跑。 */
      (n && aiCleanEnabled()) ? el('button', {
        class: 'btn', html: '🤖 AI 清洗',
        title: '让模型逐条判断这些岗位是否对口（打标 + 硬性要求抽取）。' +
          '点开会先看到预计费用，确认了才会花钱。判定只用于筛选，不删除任何数据',
        onclick: function () { openAiCleanModal(); },
      }) : null,
      (n && AI_CONF.size) ? el('button', {
        class: 'btn', html: '↺ 重置判定',
        title: '清掉这轮 AI 判定（岗位一条都不会少）',
        onclick: function () { resetAiClean(); },
      }) : null,
      n ? el('button', {
        class: 'btn', html: '🗑 清空结果',
        title: '导入岗位库后把结果区清掉 —— 采集器侧文件会归档（可找回），岗位库不受影响；' +
          '但已抓到的 JD 不会带到下一轮（详情是逐轮累积的）',
        onclick: function () { clearResults(); },
      }) : null,
      n ? el('button', {
        class: 'btn', html: '🗂️ 去岗位库',
        onclick: function () { App.go('jobs'); },
      }) : null,
    ].filter(Boolean)));

    card.appendChild(body);
    /* 重画完了 → 把焦点和光标还回那个还在输入的框（见 utils.js 的 withFocusKept）。
       放在最后：所有子节点都挂好了，querySelector 才找得到替身节点。 */
    U.restoreFocus(focusSnap, card);
  }

  function mkCollectSel(options, value, onChange, attrs) {
    var s = el('select', { style: 'width:auto;min-width:104px' });
    if (attrs) Object.keys(attrs).forEach(function (k) { s[k] = attrs[k]; });
    // 支持 { group: '分类名' } 的分组选项 → optgroup（岗位名筛选用得到）
    var curOpt = s, curGroup;
    options.forEach(function (o) {
      if (o.group) {
        if (o.group !== curGroup) {
          curGroup = o.group;
          curOpt = el('optgroup', { label: o.group });
          s.appendChild(curOpt);
        }
      } else if (curGroup) {
        curGroup = null;
        curOpt = s;
      }
      curOpt.appendChild(el('option', { value: o.v, text: o.l }));
    });
    s.value = value || '';
    s.addEventListener('change', function () { onChange(s.value); });
    return s;
  }

  /**
   * 「岗位名」筛选下拉的选项 —— 来自 js/job-taxonomy.js 的 JOB_MARKET：
   * 杭州 · 运营方向 300 条真实采集样本里的 176 个岗位标题（招聘方原样写的），
   * 按分类分组（optgroup），组内按出现次数降序。
   */
  function marketJobOptions(head) {
    var out = [{ v: '', l: head || '岗位名不限' }];
    var mk = global.JOB_MARKET;
    if (!mk || !mk.groups) return out;
    mk.groups.forEach(function (g) {
      (g.jobs || []).forEach(function (j) {
        out.push({ v: j.name, l: j.name + (j.count > 1 ? '（' + j.count + '）' : ''), group: g.name });
      });
    });
    return out;
  }

  function legalCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('header', {}, [el('h3', { text: '边界说明' })]));
    card.appendChild(el('div', { class: 'body stack' }, [
      el('div', { class: 'note brand' }, [
        el('span', { class: 'ico', text: '🛡️' }),
        el('div', { html:
          '采集器会打开列表页与详情页，<b>调用页面自身的数据接口</b>读取岗位（浏览器加载页面时本来就会请求的接口）。' +
          '比手动翻页更快，请求密度也更高，<b>更容易触发站点风控</b>。' }),
      ]),
      el('div', { class: 'kv' }, [
        el('dt', { text: '登录' }),
        el('dd', { html: '弹出<b>真实 Edge 窗口</b>，你自己扫码。<b>不代填账号密码</b>，也不保存你的登录凭证。' }),
        el('dt', { text: '读取' }),
        el('dd', { html: '调用<b>页面自身的数据接口</b>读取岗位信息（即浏览器加载页面时本来就会请求的那两个接口）。' }),
        el('dt', { text: '不做' }),
        el('dd', { html: '<b>不自动发消息、不自动投递</b>。投递永远是你自己在 BOSS 里手动点 —— 消息一发出去就撤不回来。' }),
        el('dt', { text: '数据' }),
        el('dd', { html: '全部留在本机：采集结果落在本地文件，工作台数据在你的浏览器里。<b>不上传任何服务器</b>。' }),
        el('dt', { text: '风险' }),
        el('dd', { html: '<b>接口级读取比手动浏览更容易触发站点风控</b>。工具已做限速、随机抖动、分批冷却，但<b>不能保证不触发</b>。控制频率、别长时间连续跑。' }),
      ]),
    ]));
    return card;
  }

  /* ==================== 页面入口 ==================== */

  function paint(root, params) {
    var wrap = el('div', { class: 'wrap stack' });

    App.topActions([
      el('button', {
        class: 'btn', html: '🔄 重新检测采集器',
        onclick: function () {
          detect().then(function () { App.refresh(); });
        },
      }),
      el('button', {
        class: 'btn', html: '📥 从文件导入',
        title: '没有采集器也能用：导入 boss-crawler 的历史产物',
        onclick: function () {
          var p = Exporter.importBossCrawler();
          if (!p) return;
          p.then(function (r) {
            if (!r) return;
            U.toastHtml('导入完成：新增 <b>' + r.added + '</b>，已存在 ' + r.dup, r.added ? 'ok' : 'warn', 7000);
            App.refresh();
          });
        },
      }),
    ]);

    wrap.appendChild(el('div', { class: 'note line' }, [
      el('span', { class: 'ico', text: '📡' }),
      el('div', { html:
        '<b>采集岗位</b>：用一个本机小服务调起真实浏览器，把 BOSS 上符合条件的一批岗位捞回来，' +
        '省掉一条条复制粘贴。<b>不自动投递</b> —— 投递永远你自己点。' }),
    ]));

    var loading = el('div', { class: 'card' }, [
      el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '📡' }),
        el('b', { text: '正在检测本地采集器…' }),
        el('p', { text: '在 127.0.0.1 上找采集服务（端口 ' + PORTS.join(' / ') + '）' }),
      ]),
    ]);
    wrap.appendChild(loading);
    root.appendChild(wrap);

    detect().then(function (base) {
      // 探测期间用户可能已经切走了 —— 往脱离文档的节点上画没有意义
      // （页面看起来正常，但白跑一遍整页构建）
      if (!root.contains(wrap)) return;
      wrap.innerHTML = '';
      wrap.appendChild(el('div', { class: 'note line' }, [
        el('span', { class: 'ico', text: '📡' }),
        el('div', { html:
          '<b>采集岗位</b>：用一个本机小服务调起真实浏览器，把 BOSS 上符合条件的一批岗位捞回来，' +
          '省掉一条条复制粘贴。<b>不自动投递</b> —— 投递永远你自己点。' }),
      ]));

      if (!base) {
        wrap.appendChild(offlineCard(function () {
          root.innerHTML = '';
          paint(root, params);
        }));
        wrap.appendChild(legalCard());
        return;
      }

      // 连上了服务，但页面没有访问令牌（不是采集器打开的）→ 采集接口会全被 403。
      // 直接给出原因与出路，别让用户在「点什么都失败」里打转。
      if (!token()) {
        wrap.appendChild(noTokenCard());
        wrap.appendChild(legalCard());
        return;
      }

      wrap.appendChild(statusCard(S.ping));
      wrap.appendChild(paramCard());
      wrap.appendChild(actionCard());
      wrap.appendChild(resultCard());
      wrap.appendChild(legalCard());

      // 恢复现场：刷新页面后如果后台还有任务在跑，接着显示日志。
      // 注意这里完成后**只调 loadResult()**（就地更新结果卡），
      // 千万不要再 App.refresh() —— 那会和本函数形成重绘死循环。
      req('/api/task?since=0', { timeout: 4000 }).then(function (d) {
        var t = d && d.task;
        if (!t) return;
        var box = U.$('#cLog');
        if (box && t.lines) appendLines(box, t.lines);
        S.since = t.total;
        /* A 档 · 采集漏斗：挂载这一次请求是 since=0 —— 拿到的是该任务的**全部**
           stdout，正好把漏斗一次性补齐（包括以前跑完、日志还在的轮次）。 */
        absorbLines(t.lines, t.key);
        var bar = U.$('#cTaskBar');
        if (bar) paintTaskBar(bar, t);
        if (t.running) poll();
      }).catch(function () { /* 拿不到就算了 */ });

      loadResult();
    });
  }

  global.Views.collect = {
    title: '采集岗位',
    render: paint,
    // 测试用：允许注入连接状态，免得单测真去开网络
    _state: S,
    _detect: detect,
    _import: importResult,          // 返回 Promise（分批导入）
    _importChunk: IMPORT_CHUNK,     // 每批条数，测试据此估算 yield 次数
    _yieldToUI: yieldToUI,          // 让出主线程的那一跳
    // A 档 · 采集漏斗：解析 + 渲染 + 状态，测试直接查
    _absorbLines: absorbLines,
    _paintFunnel: paintFunnel,
    _funnelNode: funnelNode,
    _blankFunnel: blankFunnel,
    _funnelState: function () { return FUNNEL; },
    // A 档 · 数量口径：小字文案的纯函数版（口径对不对，直接断它，不靠渲染猜）
    _countHintText: countHintText,
    // A 档 · 🎯 精选：最终只要最精准的 N 条
    _pickTop: pickTop,
    _wantedInfoText: wantedInfoText,
    _resultPageSize: resultPageSize,
    _readWanted: readWanted,
    _writeWanted: writeWanted,
    // A 档 · 🎯 切合值：连续「≥ N 分」门槛（自由匹配度范围）
    _readMinFit: readMinFit,
    _writeMinFit: writeMinFit,
    // 「导入即评分」这条链的中间产物，测试直接查它们
    _resultStoreJobs: resultStoreJobs,
    _resultUnscored: resultUnscored,
    _scoreResults: scoreResults,
    // 🎯 简历匹配（P2）：发起匹配任务 / 打开匹配弹窗（测试直接查）
    _startMatch: startMatch,
    _openMatchModal: openMatchModal,
    // 「采集结果筛选」这条链，测试直接查它们
    _resultJobs: resultJobs,
    _resultCities: resultCities,
    _resultDistricts: resultDistricts,
    _resultBizAreas: resultBizAreas,
    _cfGeo: cfGeo,
    _listUnknownGeo: listUnknownGeo,
    _seedCFFromForm: seedCFFromForm,
    _resultIndustries: resultIndustries,
    _filterResults: filterResults,
    _collectHasFilter: collectHasFilter,
    _clearCF: clearCF,
    _marketJobOptions: marketJobOptions,
    _cf: CF,
    // 本地「合适度」（js/job-score.js）→ 结果卡的筛选与分级条
    _fitSummary: fitSummary, _cfFitOf: cfFitOf, _cfFitAll: cfFitAll,
    // 岗位期望 → 采集关键词（测试直接查）
    _collectKeywords: collectKeywords,
    // 采集参数体检（参数与偏好对不上时提醒）—— 纯函数，测试直接查
    _paramIssues: paramIssues,
    _bandCovering: bandCovering,
    // 自定义薪资区间（K）：输入解析 + 单条判定（纯函数，测试直接喂）
    _parseK: parseK,
    _salaryRangeHit: salaryRangeHit,
    _salaryBand: SALARY_BAND,
    _experienceBand: EXPERIENCE_BAND,
    /* 「采集条件 ⇄ 求职偏好」这条链的中间产物，测试直接查它们：
       ⛔ 这两套数据**必须互不影响** —— 改偏好不许写采集的存储，反之亦然。
          所以下面的读/写入口都单独暴露出来供断言。 */
    _geoSeedFor: geoSeedFor,          // 区/商圈初值（纯函数）
    _readSavedForm: readSavedForm,
    _saveForm: saveForm,
    _touchForm: touchForm,            // 渲染时绝不调它；只有用户真动表单才调
    _formSaveKey: FORM_SAVE_KEY,
    _formSaveFields: FORM_SAVE_FIELDS,
    // 本地优先字段（权威在用户手上，服务端那份只是上次采集的回声）
    _localFirstFields: LOCAL_FIRST_FIELDS,
    // 「② 采集参数」折叠态的读写（测试直接驱动，不靠点 DOM）
    _paramOpenKey: PARAM_OPEN_KEY, _readParamOpen: readParamOpen,
    _cityList: cityList, _cityJoin: cityJoin,
    _deriveProvince: deriveProvince,   // 省的初值（由城市反推，纯函数）
    _formPullPlan: formPullPlan,      // 偏好 → 采集页 的差异清单
    _prefsPushPlan: prefsPushPlan,    // 采集页 → 偏好 的差异清单
    _pullFromPrefs: pullFromPrefs,    // 「⤓ 从求职偏好带入」
    // 测试钩子：直接重画结果卡（真机注入 state 后用它，绕过真实探测）
    _paintResult: function () { paintResultBody(U.$('#cResult')); },
    // 任务状态条（进度条 + 计时）—— 纯渲染函数，测试直接喂任务快照查
    _paintTaskBar: paintTaskBar,
    _fmtDur: fmtDur,
    _notifyDone: notifyDone,
    _onTaskDone: onTaskDone,
    // 清空采集结果（归档）—— 测试直接驱动核心逻辑，绕过 confirm 弹窗
    _clearResults: clearResults,
    // 采集历史（只读列表）—— 测试直接开查
    _openHistoryDialog: openHistoryDialog,
    // 简历文件管理（删除入口）—— 测试直接驱动
    _openResumeManager: openResumeManager,
    // 安全令牌：测试直接查（页面没令牌时采集页应给引导卡，而不是一堆失败）
    _token: token,
    /* 采集器的统一请求封装（自带 X-JH-Token、超时、错误归一）。
       js/apply-boss.js 的「一键打招呼 / 同步回复」要复用同一套 —— 否则它会漏带令牌，
       表现为莫名其妙的 403。 */
    _req: req,
    // 登录态新鲜度判定 —— 纯函数，测试直接喂不同 ping 查
    _loginFresh: loginFresh,
    // 采集入口（含登录预检）—— 测试直接驱动
    _doCrawl: doCrawl,
    // 登录预检 —— 测试直接驱动（它曾经在轮询提前放弃时永不 resolve，见 poll 的注释）
    _runLoginCheck: runLoginCheck,
    _poll: poll,
    // 停止采集（含停止后的落点指引）—— 测试直接驱动
    _doStop: doStop,
    /* P1-9：「■ 停止」按钮行是**就地重画**的（不整页 refresh）。
       这三颗按钮的产出与重画都要能单独驱动 —— 否则测试只能靠"进页面 + 起真任务"，
       而那正是这条缺陷原来溜过去的原因（自己发起的采集根本走不到渲染快照）。
       ⚠️ `_paintActions` 找的是 `#cActions`（全页扫描），测试要先自己造一个容器。 */
    _actionButtons: actionButtons,
    _paintActions: paintActions,
    _taskRunning: taskRunning,
    // 暂停 / 继续（一键冻结）—— 测试直接驱动
    _doPause: doPause,
    _doResume: doResume,
    // 预估耗时格式化（P2-2）—— 纯函数，测试直接喂不同 estimate 查
    _fmtEstimate: fmtEstimate,
    // 采集方案（预设）—— 纯函数，测试直接驱动核心逻辑
    _readPresets: readPresets,
    _writePresets: writePresets,
    _presetPayload: presetPayload,
    _applyPresetToForm: applyPresetToForm,
    _presetFields: PRESET_FIELDS,
  };
})(window);
