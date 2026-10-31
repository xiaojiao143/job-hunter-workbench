/* ==========================================================================
   store.js · 数据层
   全部数据存 localStorage，不上传任何服务器。

   多账号隔离（本机沙箱切换，非安全认证）：
     · 每个账号一份数据，key = jobhunter.db.v1.<账号>
     · 账号元数据（账号名 / 可选密码 / 创建时间）统一存 jobhunter.accounts.v1
     · 老版本单 key「jobhunter.db.v1」在首次升级时自动归属 default 账号
     · 密码仅防误操作（本地文件本就可读），不加密、不校验强度
   ========================================================================== */
(function (global) {
  'use strict';

  var KEY_ROOT = 'jobhunter.db.v1';               // 老版本单 key（升级迁移用）
  var ACCOUNTS_KEY = 'jobhunter.accounts.v1';     // 账号元数据（账号列表 + 密码）
  var CURRENT_KEY = 'jobhunter.current.v1';       // 当前登录账号名指针
  var SCHEMA = 1;

  /** 当前账号名（数据沙箱的名字）。切换账号会重建整个数据 key 上下文。 */
  var CURRENT_ACCOUNT = 'default';
  function KEY() { return KEY_ROOT + '.' + CURRENT_ACCOUNT; }
  function KEY_BAK() { return KEY() + '.bak'; }

  /* ==================== 枚举定义 ==================== */

  /** 投递状态（泳道顺序即求职推进顺序） */
  var STATUSES = [
    { id: 'wish',     name: '待收藏',      color: '#8b95ad', short: '待收藏' },
    { id: 'todo',     name: '待投递',      color: '#5b7cf0', short: '待投递' },
    { id: 'applied',  name: '已投递',      color: '#1d4ed8', short: '已投递' },
    { id: 'viewed',   name: 'HR 已查看',   color: '#0b6fa4', short: '已查看' },
    { id: 'invited',  name: '邀约面试',    color: '#6d3fc4', short: '邀约' },
    { id: 'round1',   name: '一面',        color: '#8b5cf6', short: '一面' },
    { id: 'round2',   name: '二面',        color: '#a855f7', short: '二面' },
    { id: 'final',    name: '终面',        color: '#c026d3', short: '终面' },
    { id: 'waiting',  name: '等待 offer',  color: '#b06300', short: '等 offer' },
    { id: 'offer',    name: '拿到 offer',  color: '#0d8a52', short: 'offer' },
    { id: 'rejected', name: '拒绝 / 已结束', color: '#c62828', short: '结束' },
  ];
  var STATUS_MAP = {};
  STATUSES.forEach(function (s, i) { STATUS_MAP[s.id] = Object.assign({ order: i }, s); });

  /** 推进链（不含 rejected）—— 用来算漏斗 */
  var CHAIN = ['todo', 'applied', 'viewed', 'invited', 'round1', 'round2', 'final', 'waiting', 'offer'];
  function chainIndex(st) { return CHAIN.indexOf(st); }
  function statusName(id) { return (STATUS_MAP[id] || {}).name || id || '—'; }
  function statusColor(id) { return (STATUS_MAP[id] || {}).color || '#8b95ad'; }

  /** 投递渠道 */
  var CHANNELS = ['BOSS 直聘', '官网', '猎聘', '智联招聘', '拉勾', '内推', '脉脉', '其他'];
  /** 面试形式 */
  var INTERVIEW_MODES = [
    { id: 'online', name: '线上' }, { id: 'offline', name: '线下' }, { id: 'phone', name: '电话' },
  ];
  /** 面试轮次 */
  var ROUNDS = ['HR 初筛', '一面（技术/业务）', '二面（主管）', '三面（总监/交叉）', '终面（HRBP/高管）', '笔试', '群面'];

  /* ==================== 默认设置 ==================== */
  /**
   * 默认 AI 配置：DeepSeek（用户已在项目里配过，开箱即用）
   * 用户可以随时在设置页换成别的 OpenAI 兼容端点。
   */
  var DEFAULT_SETTINGS = {
    theme: 'light',
    ai: {
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: '',
      model: 'deepseek-chat',
      temperature: 0.3,
      stream: true,
      timeout: 120,
      /* 单价（元 / 百万 token），0 = 按 ai.js 内置价格表估。
         ⚠️ 必须放在 DEFAULT_SETTINGS.ai 里 —— mergeSettings 对 ai 是白名单合并
         （U.pick 只认 Object.keys(DEFAULT_SETTINGS.ai)），放外面保存后会被静默洗掉。 */
      priceIn: 0,
      priceOut: 0,
      /* AI 采集清洗（P0）开关。默认**关闭**：它是花钱的功能，不该开箱就跑。
         开启后采集页结果区才出现「🤖 AI 清洗」按钮。
         ⚠️ 必须放在 DEFAULT_SETTINGS.ai 里 —— mergeSettings 对 ai 是白名单合并
         （U.pick 只认 Object.keys(DEFAULT_SETTINGS.ai)），放外面保存后会被静默洗掉。 */
      collectClean: false,
    },
    notify: false,
    notifyAhead: { day: true, hour: true },
    // ⏰ 待跟进页的判定阈值（天数）。放设置里是为了让用户按自己的节奏调，
    // 不同行业 "多久没动静算凉了" 差别很大。
    followUp: { appliedDays: 5, invitedDays: 3, favoriteDays: 7, waitingDays: 7, offerDays: 5 },
    snooze: {},                 // { '<类别>:<id>': 时间戳 } —— 「稍后提醒」到点再冒出来
    backup: { lastExportAt: null, remindDays: 7, lastRemindedAt: null },
    prefs: {
      cities: ['杭州'],
      salaryMin: null,
      salaryMax: null,  // 期望薪资上限（只用来给人看，不参与硬过滤）
      dealBreakers: ['外包', '派遣', '驻场'],
      expectJobs: [],   // 期望岗位（从 BOSS 岗位分类树里选，见 js/job-taxonomy.js）
      // 求职方向关键词 —— 本地「合适度」打分的口径（见 js/job-score.js）。
      // 空着就用 job-score.js 里的内置画像词兜底，设置页能改也能一键恢复。
      focusKeywords: [],
      industries: [],   // 加分用的对口行业（MCN/电商/内容机构…），空着用内置表
      myYears: null,
      myDegree: '',
      /* —— 福利待遇（多选）——
         空数组 = 不按福利筛。⛔ 刻意**不给默认值**：默认勾几项等于替用户做决定，
         而福利标签在列表页本来就常缺失，一上来就筛会让人以为工具坏了。 */
      welfare: [],          // 选项 key，见 js/job-match.js 的 WELFARE_OPTIONS
      welfareMode: 'all',   // 'all' 全部满足 / 'any' 任一满足
      /* —— 地理下钻（城市 > 区 > 商圈 / 地标）——
         cities 是第一级（上面那行），这三个是比城市更细的一层。 */
      districts: [],        // 期望区，「杭州 > 滨江区」的第二级
      bizAreas: [],         // 期望商圈（第三级；只有真实采到过的才列得出来）
      landmark: '',         // 地标 / 地铁关键词（在 商圈+地址+城市 里做子串匹配）
      geoStrict: false,     // 严格模式：把「没采到区/商圈」的岗位也筛掉（默认保留并标注）
      // 打开岗位库时自动套用上面的偏好（用户嫌每次都要点一下才开的）
      autoApply: false,
    },

    /* —— 公司背调（js/company-check.js）——
       路线 A（一键跳转）不需要任何配置就能用；这里是路线 B 的配置位。
       ⚠️ apiKey 是敏感信息，**只存本地 localStorage**，不上传、不写进任何导出文件
          （见 exportObject —— 导出时会把它抹掉，免得一份备份发出去就等于把 Key 送人）。 */
    bgCheck: {
      provider: 'tianyancha',  // 'tianyancha' | 'qcc'
      apiKey: '',
      maxCalls: 2,             // 每家公司最多调几次接口（防手抖烧钱）
      scope: 'all',            // 触发范围：all 全部 / todo 待投递 / AB 仅 A、B 级岗位
    },

    prompts: {},   // 空 = 用 ai.js 里的内置模板

    /* —— 去 BOSS 投递 / 回写（js/apply-boss.js）——
       这两个开关**默认全关**，是刻意的：
         · autoGreet  = 「一键打招呼」—— 会让采集器驱动真实浏览器点「立即沟通」并发送招呼语。
                        这是**不可逆动作**（消息发出撤不回、BOSS 每天沟通条数有限），
                        所以必须用户自己在设置页明确打开才生效。
         · syncReply  = 「同步回复/邀约」—— 会让采集器去读 BOSS 聊天列表。
                        读回来的候选**一律要用户逐条确认**才写进投递/面试，绝不自动写。 */
    boss: {
      autoGreet: false,        // B 方案开关（默认关）
      syncReply: false,        // 阶段 4 开关（默认关）
      greetIntervalSec: 20,    // 两次自动打招呼之间的最小间隔（秒）
      greetCooldownH: 24,      // 同一岗位多久内不允许重复自动打招呼（小时）
      /* 上一次自动打招呼的时间戳。
         ⛔ 它只是**前端预检**（省一次开浏览器），不要把防线建在它上面 ——
            它在 localStorage 里，一个请求就能绕过去。真限流在服务端：
            间隔 / 同岗位冷却 / 单日上限由 server.py 的 _greet_rate_gate 判，
            台账（greet_log.json）由服务端自己记（通过 /api/greet-conf 同步这三个数）。
         （这句注释原来写的是「服务端也会独立校验一次」，而当时服务端**根本没读这些
            设置** —— autoGreet 等字段在 server.py 全文件 0 命中，评审 P1-5。） */
      lastGreetAt: 0,
      /* 「一键打招呼 / 同步回复」用哪个浏览器（第 28 轮）。
         ⛔ 为什么默认 own 而不是 daily：daily 要求「先彻底退出 Edge」，
            这是个用户必须配合的前置动作。默认打开会让第一次用的人直接撞上
            「点了没反应」，反而像坏了。所以默认隔离，用户明确选了才切。
         · own   = 工作台自己的浏览器（assets/chrome_user_data，与日常浏览隔离）
         · daily = 你平时的 Edge（零扫码、指纹一致；前提：已彻底退出 Edge） */
      browserMode: 'own',
    },
  };

  /* ==================== 运行时状态 ==================== */
  var DB = null;
  var persistOK = true;
  var persistError = '';

  function blank() {
    return {
      schema: SCHEMA,
      createdAt: U.now(),
      updatedAt: U.now(),
      settings: U.deepClone(DEFAULT_SETTINGS),
      jobs: [],
      applications: [],
      interviews: [],
      resumes: [],
      materials: [],
      chats: [],
      checks: [],      // 公司背调档案（js/company-check.js）
      /* 采集冲突台账（S1）。
         ⚠️ 刻意**不进 SCHEMA 版本号** —— 老库里没有这个键，靠惰性初始化补上
         （见 conflicts() / ensureConflicts），避免为一个可空的表触发整库迁移。
         每条：{ id, jobId, at, fields:[{key,label,old,new}] } */
      conflicts: [],
    };
  }

  /* ---------- 读写 ---------- */
  function canUseLS() {
    try {
      var k = '__jh_probe__';
      global.localStorage.setItem(k, '1');
      global.localStorage.removeItem(k);
      return true;
    } catch (e) { return false; }
  }

  function load() {
    if (!canUseLS()) {
      persistOK = false;
      lsUsable = false;          // 整个 localStorage 都不可用 → 后续 save 不再重复弹提示
      persistError = '当前环境不允许浏览器本地存储（localStorage）。' +
        '数据只保存在内存里，刷新页面就没了 —— 请改用本地服务器方式打开，或换 Chrome / Edge。';
      DB = blank();
      return DB;
    }
    var raw = null;
    try { raw = global.localStorage.getItem(KEY()); } catch (e) { raw = null; }
    if (!raw) {
      // 试试备份
      try { raw = global.localStorage.getItem(KEY_BAK()); } catch (e) { raw = null; }
      if (raw) U.toast('主数据损坏，已从自动备份恢复。', 'warn');
    }
    if (!raw) { DB = blank(); return DB; }

    try {
      var d = JSON.parse(raw);
      DB = migrate(d);
      return DB;
    } catch (e) {
      persistError = '本地数据解析失败：' + e.message;
      U.toast('本地数据无法解析，已用空数据启动（旧数据仍保留在 localStorage 里）。', 'bad');
      DB = blank();
      return DB;
    }
  }

  /** 结构补齐 + 版本迁移 */
  function migrate(d) {
    var b = blank();
    d = d || {};
    var out = {
      schema: SCHEMA,
      createdAt: d.createdAt || b.createdAt,
      updatedAt: d.updatedAt || b.updatedAt,
      settings: mergeSettings(d.settings),
      jobs: Array.isArray(d.jobs) ? d.jobs.map(normJob) : [],
      applications: Array.isArray(d.applications) ? d.applications.map(normApp) : [],
      interviews: Array.isArray(d.interviews) ? d.interviews.map(normInterview) : [],
      resumes: Array.isArray(d.resumes) ? d.resumes.map(normResume) : [],
      materials: Array.isArray(d.materials) ? d.materials.map(normMaterial) : [],
      chats: Array.isArray(d.chats) ? d.chats.map(normChat) : [],
      checks: Array.isArray(d.checks) ? d.checks.map(normCheck) : [],
      /* ⛔ 采集冲突台账（S1）**必须在这一行**。这个白名单漏一个 key，就等于
         「这个集合永远留不住」：界面增删改都正常、save() 也确实把它写进了
         localStorage，但下次 load() 走到 migrate() 重建对象时**没有这一行**
         → 数据当场消失，而且没有任何报错。
         更阴的是 ensureConflicts() 会惰性补一个空数组，于是「读一下」就把内存
         改脏 → 紧跟着任何一次 save()/flush() 都要写盘 → 另一个标签页收到
         storage 事件 → 互相刷（本次要修的正是这个）。
         blank() 里有 conflicts，这里必须与它对齐。 */
      conflicts: Array.isArray(d.conflicts) ? d.conflicts : [],
    };
    return out;
  }

  function mergeSettings(s) {
    var base = U.deepClone(DEFAULT_SETTINGS);
    if (!s || typeof s !== 'object') return base;
    base.theme = s.theme === 'dark' ? 'dark' : 'light';
    if (s.ai) base.ai = Object.assign(base.ai, U.pick(s.ai, Object.keys(DEFAULT_SETTINGS.ai)));
    if (s.notifyAhead) base.notifyAhead = Object.assign(base.notifyAhead, s.notifyAhead);
    if (s.prefs) base.prefs = Object.assign(base.prefs, s.prefs);
    if (s.followUp) base.followUp = Object.assign(base.followUp, U.pick(s.followUp, Object.keys(DEFAULT_SETTINGS.followUp)));
    if (s.bgCheck) base.bgCheck = Object.assign(base.bgCheck, U.pick(s.bgCheck, Object.keys(DEFAULT_SETTINGS.bgCheck)));
    /* ⚠️ 忘了这行会出很隐蔽的 bug：开关在页面上能切、toast 也弹了，
       但一刷新就回到默认关闭 —— 因为 base 是 DEFAULT_SETTINGS 的深拷贝，
       存下来的 s.boss 根本没被读回来。 */
    if (s.boss) base.boss = Object.assign(base.boss, U.pick(s.boss, Object.keys(DEFAULT_SETTINGS.boss)));
    if (s.backup) base.backup = Object.assign(base.backup, U.pick(s.backup, Object.keys(DEFAULT_SETTINGS.backup)));
    base.snooze = (s.snooze && typeof s.snooze === 'object') ? s.snooze : {};
    base.notify = !!s.notify;
    base.prompts = (s.prompts && typeof s.prompts === 'object') ? s.prompts : {};
    return base;
  }

  var saveTimer = null;
  var saveListeners = [];
  /* 「上一次真正写到磁盘上的那份 JSON」。save() 靠它判断内容有没有真的变 ——
     见 save() 里的短路注释，那是跨标签页死循环的断点。 */
  var lastSavedJSON = null;

  /** 保存（轻量防抖，避免连续操作时疯狂写盘） */
  /**
   * 落盘。
   *
   * ⛔ 这里以前是 `if (!persistOK) { fire(); return; }` —— 一个**会静默丢全部数据**的坑
   *    （评审 2.2，我逐行确认过）：`persistOK` 全文件没有任何地方复位成 true，
   *    所以某次 `setItem` 抛 `QuotaExceededError`（比如导入一批岗位正好超 5MB）之后：
   *      · 界面增删改一切正常、toast 也弹过一次；
   *      · 但 `save()` 全都在这一行 return，**一条都不落盘**；
   *      · 连关页面时的 `flush()` 也被同一行挡掉；
   *      · 用户完全无感，下次打开才发现全没了。
   *
   *   现在改成「**每次都重试**」：
   *      · 写失败只影响这一次，下一次照样试；
   *      · 成功一次就把 persistOK 复位，并明确告诉用户「恢复落盘了」（否则他以为还在丢）；
   *      · 失败提示做节流（60 秒最多一次），不然每点一下弹一次会更烦。
   *   配额超限往往是「刚导入了一大批岗位」这种**瞬时**状态，用户删掉几条就又有空间了 ——
   *   没有任何理由因为一次失败就永久放弃落盘。
   */
  var persistFailAt = 0;        // 上次「写失败」提示的时间（节流用）
  var lsUsable = true;          // localStorage 本身能不能用（不能用时 load() 已经说过一次，别再刷屏）

  function save(immediate) {
    var doIt = function () {
      try {
        var s = JSON.stringify(DB);
        /* ⛔ 「内容没变就不写」—— 这一条是**跨标签页无限对刷**那个死循环的断点。
           两个标签页靠 storage 事件同步，而同步动作是 location.reload()，
           reload 又会触发 beforeunload / pagehide → flush() → 又是一次 setItem
           → 对端再收到事件、再 reload …… 两边永远停不下来
           （用户截图：同一条 toast 叠了三层）。
           有了这层短路，reload 前后的 flush() 变成空转，环就断了。
           ⚠️ 必须在**比较之后**才 bump updatedAt：否则每次 stringify 都因为
              updatedAt 变了而「看起来内容变了」，这层保护直接失效。
           ⚠️ 基线是「归一化后的内存形态」（见 init / switchAccount / applyExternal），
              不能拿磁盘上的原始字符串当基线 —— migrate() 会重建对象、补默认值、
              丢未知字段，归一化后的 JSON 与磁盘上的字符串本来就不一样。 */
        if (s === lastSavedJSON) {        // 内容没变 → 不写盘、不触发 storage 事件
          if (saveListeners.length) saveListeners.forEach(function (fn) { try { fn(); } catch (e) { /* noop */ } });
          return;
        }
        DB.updatedAt = U.now();
        s = JSON.stringify(DB);
        // 写入前把上一版留作备份（防止半截写入把数据弄坏）
        try {
          var old = global.localStorage.getItem(KEY());
          if (old && old.length > 2) global.localStorage.setItem(KEY_BAK(), old);
        } catch (e) { /* 备份失败无所谓 */ }
        global.localStorage.setItem(KEY(), s);
        lastSavedJSON = s;
        if (!persistOK) {                        // 从失败里恢复了
          persistOK = true;
          persistError = '';
          U.toast('本地存储恢复正常，数据已经能存下来了 ✅', 'ok', 6000);
        }
        if (saveListeners.length) saveListeners.forEach(function (fn) { try { fn(); } catch (e) { /* noop */ } });
      } catch (e) {
        var wasOK = persistOK;
        persistOK = false;
        persistError = '写入本地存储失败：' + e.message +
          '（可能是浏览器存储空间已满，建议先导出 JSON 备份）';
        // localStorage 整个不可用时，load() 已经给过明确的说明 —— 这里不再每次操作都弹
        var now = U.now();
        if (lsUsable && (wasOK || now - persistFailAt > 60000)) {
          persistFailAt = now;
          U.toast(persistError + '　⚠️ 这之后的操作只存在内存里，刷新会丢。', 'bad', 12000);
        }
      }
    };
    if (immediate) { clearTimeout(saveTimer); saveTimer = null; doIt(); return; }
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doIt, 260);
  }

  /** 立即落盘（关页面前调用） */
  function flush() { save(true); }

  /**
   * 把「另一个标签页写进来的数据」应用到内存里 —— **不写盘**。
   *
   * ⛔ 为什么必须有它：跨标签页同步原来是 `location.reload()`。
   *    而 reload 会触发 beforeunload / pagehide → `flush()` → 又是一次 setItem
   *    → 对端也收到 storage 事件 → 对端也 reload → 两边**无限对刷**，
   *    用户看到的就是「检测到另一个标签页修改了数据，正在重新载入…」堆成一片。
   *    改成「就地换内存 + 重画」之后，同步动作本身不再产生写盘，环就断了。
   *
   * ⛔ 只认**当前账号**的 key。多账号是同一台机器上的数据沙箱，
   *    别的账号那份数据套到当前账号上就是数据错乱。
   *    `.bak` / `.premerge` 这类派生 key 也因此被这一条挡掉 ——
   *    它们只是一次写入的副产物，不代表「数据被改了」。
   *
   * 返回 true 表示接受并应用了。
   */
  function applyExternal(key, raw) {
    if (key !== KEY()) return false;
    if (typeof raw !== 'string' || raw.length < 3) return false;
    try {
      var incoming = migrate(JSON.parse(raw));
      /* ⛔ 别让对端的整份数据盖掉本页「还没落盘」的编辑（评审核实 2026-10-30，P0）。
         复现路径（已实测）：
           ① 本页改了东西，落在 260ms 防抖窗口里 → 磁盘上**还没有**这次编辑；
           ② 对端写盘 → 本页收到 storage 事件 → 这里把 DB 整份替换成对端版本
              → 本页那次编辑**当场消失**；
           ③ 之后本页再 save()：JSON.stringify(DB) 与 lastSavedJSON 相同（都被换成对端版了）
              → 走「内容没变」短路 → **永远不写盘**，连 flush() 也救不回来。
         也就是：用户在 A 标签页填了一半的表单，B 标签页随便存一下，A 的编辑就没了。

         修法：合并而不是替换 —— 以对端为底，把本页**尚未落盘**的差异补回去。
         判断「尚未落盘」用的是 save() 同一套基线（lastSavedJSON），所以两边口径一致。
         ⚠️ 不能简单地「本页赢了就整份用本页」：那样对端的新增又会被本页盖掉，
            对刷问题会以另一种形式回来。这里做的是**按表合并**，只补差异项。 */
      var localRaw = lastSavedJSON;
      var localDirty = !!(localRaw && localRaw !== JSON.stringify(DB));
      DB = localDirty ? mergePendingEdits(incoming, DB) : incoming;
      /* 同步基线：让下一次 flush() 因为「内容没变」而空转（16.15C 硬约束）。
         但本页**有未落盘编辑**且该编辑没被对端吸收时，不能把基线对齐成合并结果
         —— 那会让这次编辑永远停在内存里（save 认为「没变」而短路，原始 bug 的第③步）。
         判断「编辑是否被吸收」用 JSON.stringify(DB) 与 JSON.stringify(incoming) 比较：
         两者都经过 migrate/合并的同一套处理，不会被 migrate 的字段规范化干扰
         （不能用 raw —— 那是磁盘原始字符串，与 migrate 后的形态天然不一致）。
         ⚠️ 这里**不能**直接 setItem 补落盘：16.15B/C 要求「软同步 + 随后的 flush
            全程零写盘」（一写就触发对端事件 = 对刷）。置空基线把落盘延后到下一次
            save/flush，语义更干净，也满足测试约束。 */
      var merged = JSON.stringify(DB);
      var incomingStr = JSON.stringify(incoming);
      lastSavedJSON = (merged === incomingStr) ? merged : '';
      fire('all');
      return true;
    } catch (e) {
      return false;             // 解析失败就当没收到，绝不破坏内存里的数据
    }
  }

  /**
   * 把「本页还没落盘」的编辑合并到对端数据上 —— 按表按 id 处理，对端新增保留、本页改动优先。
   *
   * ⚠️ 只做「本页新增 / 本页改动」的补回，**不做删除**（删一条记录后对端又把它带回来，
   *    比丢一条编辑的伤害小；而且删除操作本身会立即落盘，不会留在防抖窗口里）。
   */
  function mergePendingEdits(incoming, local) {
    var out = incoming;
    [['jobs', 'id'], ['applications', 'id'], ['interviews', 'id'],
     ['resumes', 'id'], ['materials', 'id'], ['chats', 'id'],
     ['checks', 'key'], ['conflicts', 'id']].forEach(function (pair) {
      var table = pair[0], keyField = pair[1];
      var inList = (out[table] || []).slice();
      var localList = local[table] || [];
      var index = {};
      inList.forEach(function (x, i) {
        if (x && x[keyField] != null) index[x[keyField]] = i;
      });
      localList.forEach(function (x) {
        if (!x || x[keyField] == null) return;
        var at = index[x[keyField]];
        if (at === undefined) {
          inList.push(x);                       // 本页新增的
        } else {
          inList[at] = x;                       // 本页改过的，以本页为准
        }
      });
      out[table] = inList;
    });
    // 设置里最难判定的是「键到底改没改」：直接取本页的（设置项都是显式操作，不会被防抖吞掉）
    if (local.settings) out.settings = local.settings;
    return out;
  }

  /* ---------- 订阅（页面重渲染） ---------- */
  var subs = [];
  function subscribe(fn) {
    subs.push(fn);
    return function () { subs = subs.filter(function (f) { return f !== fn; }); };
  }
  function fire(changed) {
    subs.forEach(function (fn) { try { fn(changed || 'all'); } catch (e) { console.error(e); } });
  }

  /* ==================== 规范化（写库统一入口，防脏数据） ==================== */

  /**
   * 从 BOSS 职位链接里抠出职位 ID。
   * 链接形如 https://www.zhipin.com/job_detail/6bcc237af9aa45320nJ60tu6ElJU.html
   * 也兼容不带 .html、带 query、带 #hash 的写法。
   * 抠不出来返回 ''（手动新增的岗位、或别的平台链接）。
   */
  function bossJobIdOf(url) {
    var s = String(url || '');
    var m = /\/job_detail\/([A-Za-z0-9_~-]+)/.exec(s);
    return m ? m[1] : '';
  }

  function normJob(j) {
    j = j || {};
    return {
      id: j.id || U.uid('job'),
      source: j.source === 'manual' ? 'manual' : 'boss',
      title: String(j.title || '').trim(),
      company: String(j.company || '').trim(),
      industry: String(j.industry || '').trim(),
      location: String(j.location || '').trim(),
      remote: !!j.remote,
      salaryText: String(j.salaryText || '').trim(),
      salaryMin: U.asNum(j.salaryMin),
      salaryMax: U.asNum(j.salaryMax),
      salaryMonths: U.asNum(j.salaryMonths),          // 年终奖月数
      benefits: U.asArray(j.benefits),
      duties: U.asArray(j.duties),
      reqDegree: String(j.reqDegree || '').trim(),
      reqYears: String(j.reqYears || '').trim(),
      reqSkills: U.asArray(j.reqSkills),
      /* 「从 JD 正文抽出的权威技能要求」（采集器挂在 _reqAuthoritative 上，
         export.js 的 fromCrawlerRecord 会把它抽成 reqSkillsAuthoritative）。
         ⛔ 它曾经在这条链上**第三次**被白名单吃掉：
              export.js 写 → normJob 没有这一行（字段静默消失）→ job-score.js 去读（永远读到空）
            →「JD 技能要求命中 +1/+3」这个打分维度**整条是死的**。
         更要紧的是它为什么能溜过 1587 项测试：那条用例断言的是
         `Exporter.fromCrawlerRecord()` 的**返回值**，从头到尾没经过 addJob ——
         测的是导出层、断的是入库层。这一轮加了「schema 一致性」测试专门堵这个口子
         （见 _测试_核心.js 的 18.8Q），以后再加字段忘了进白名单会**自动变红**。 */
      reqSkillsAuthoritative: U.asArray(j.reqSkillsAuthoritative),
      risks: U.asArray(j.risks),
      pros: U.asArray(j.pros),
      cons: U.asArray(j.cons),
      keywords: U.asArray(j.keywords),
      tags: U.asArray(j.tags),
      url: String(j.url || '').trim(),
      /* BOSS 职位 ID（形如 6bcc237af9aa45320nJ60tu6ElJU）。以前只存了整条 url，
         真正要用的时候（深链到聊天页、按 jobId 回写状态）还得每次现解析一遍。
         这里落库一次，下游直接用；解析不出来就空串（手动新增的岗位本来就没有）。 */
      encryptJobId: String(j.encryptJobId || '') || bossJobIdOf(j.url),
      rawJD: String(j.rawJD || ''),
      note: String(j.note || ''),
      // —— 采集侧已经带回、以前写库这一步却被丢掉的字段（详情 API 才有）——
      scale: String(j.scale || '').trim(),           // 公司规模
      district: String(j.district || '').trim(),     // 区（城市下钻）
      /* ⚠️ 商圈在采集 CSV 里本来就有，之前 export.js 没接、这里也没白名单，
         于是「按区/商圈精筛」永远少一半数据。这一轮两处一起补。 */
      bizArea: String(j.bizArea || '').trim(),       // 商圈（比区更细的一层）
      latlng: (j.latlng && typeof j.latlng === 'object') ? j.latlng : null,  // 经纬度（列表页自带）
      address: String(j.address || '').trim(),       // 详细地址（通勤判断）
      companyInfo: String(j.companyInfo || '').trim(), // 公司简介
      hr: String(j.hr || '').trim(),                 // HR 姓名
      hrTitle: String(j.hrTitle || '').trim(),       // HR 职位
      hrOnline: !!j.hrOnline,                        // HR 是否在线
      active: String(j.active || '').trim(),         // HR 活跃度
      invalid: !!j.invalid,                          // 岗位已下线
      proxyHire: !!j.proxyHire,                      // 代招/外包（用工主体）
      favorite: !!j.favorite,
      archived: !!j.archived,
      aiAt: j.aiAt || null,                            // 上次 AI 解析时间
      aiModel: j.aiModel || '',
      aiVerdict: (j.aiVerdict && typeof j.aiVerdict === 'object') ? j.aiVerdict : null,  // AI 简历匹配结论
      aiVerdictAt: j.aiVerdictAt || null,
      aiGreeting: String(j.aiGreeting || ''),          // 上次生成的打招呼话术
      /* 「一键打招呼」的冷却时间戳。⚠️ 它必须在本白名单里 —— 否则 updateJob 写进去
         会被 normJob 丢掉，表现为「冷却完全失效」：同一个岗位可以反复自动打招呼，
         烧掉 N 条沟通额度才发现。这是拿「用户看不见的兜底」换来的教训：
         凡是 updateJob 要写的字段，normJob 必须有对应的一行。 */
      greetAt: j.greetAt || null,
      interviewSim: (j.interviewSim && typeof j.interviewSim === 'object') ? j.interviewSim : null,  // AI 面试模拟记录
      createdAt: j.createdAt || U.now(),
      updatedAt: j.updatedAt || j.createdAt || U.now(),
    };
  }

  function normApp(a) {
    a = a || {};
    var st = STATUS_MAP[a.status] ? a.status : 'todo';
    return {
      id: a.id || U.uid('app'),
      jobId: a.jobId || '',
      status: st,
      outcome: a.outcome || '',                        // rejected 时：self / company
      channel: a.channel || 'BOSS 直聘',
      resumeId: a.resumeId || '',
      note: String(a.note || ''),
      hrSummary: String(a.hrSummary || ''),
      contact: String(a.contact || ''),
      appliedAt: a.appliedAt || null,
      salaryAsk: String(a.salaryAsk || ''),
      /* 「预计到岗时间」—— view-compare.js 的横向对比表可以就地编辑它。
         ⛔ 必须在白名单里（评审 P2-1）：本白名单是**重建式**的（每次 normApp 只
            返回这里列出的键），不在其中的字段会在下一次 normApp（加载 / 新建投递）
            时被静默丢掉，表现成「填完刷新就没了」。
            判断口径同上面 greetAt 那条：凡是 updateApplication 要写的字段，这里必须有。 */
      onboardEstimate: String(a.onboardEstimate || ''),
      timeline: Array.isArray(a.timeline) ? a.timeline.map(function (t) {
        return { at: t.at || U.now(), status: t.status || st, note: String(t.note || '') };
      }) : [{ at: a.createdAt || U.now(), status: st, note: '创建' }],
      createdAt: a.createdAt || U.now(),
      updatedAt: a.updatedAt || a.createdAt || U.now(),
    };
  }

  function normInterview(v) {
    v = v || {};
    return {
      id: v.id || U.uid('itv'),
      jobId: v.jobId || '',
      appId: v.appId || '',
      at: v.at || null,
      mode: v.mode || 'online',
      link: String(v.link || ''),
      place: String(v.place || ''),
      interviewers: String(v.interviewers || ''),
      round: v.round || '一面（技术/业务）',
      status: v.status || 'scheduled',                 // scheduled / done / canceled
      result: v.result || '',                          // pass / fail / pending / unknown
      notes: String(v.notes || ''),
      review: String(v.review || ''),
      prep: v.prep && typeof v.prep === 'object' ? v.prep : null,  // {selfIntro, questions:[], askHr:[]}
      prepAt: v.prepAt || null,
      notified: v.notified && typeof v.notified === 'object' ? v.notified : {},
      createdAt: v.createdAt || U.now(),
      updatedAt: v.updatedAt || v.createdAt || U.now(),
    };
  }

  function normResume(r) {
    r = r || {};
    return {
      id: r.id || U.uid('cv'),
      name: String(r.name || '未命名简历').trim(),
      content: String(r.content || ''),
      tags: U.asArray(r.tags),
      isDefault: !!r.isDefault,
      note: String(r.note || ''),
      createdAt: r.createdAt || U.now(),
      updatedAt: r.updatedAt || U.now(),
    };
  }

  function normMaterial(m) {
    m = m || {};
    return {
      id: m.id || U.uid('mat'),
      kind: m.kind || 'cover',                         // cover / portfolio / project / other
      title: String(m.title || '').trim(),
      content: String(m.content || ''),
      url: String(m.url || ''),
      tags: U.asArray(m.tags),
      jobIds: U.asArray(m.jobIds),
      createdAt: m.createdAt || U.now(),
      updatedAt: m.updatedAt || U.now(),
    };
  }

  function normChat(c) {
    c = c || {};
    return {
      id: c.id || U.uid('chat'),
      kind: c.kind || 'free',                          // free / jobparse / match / greeting / interview / rejection / review / compare
      title: String(c.title || '新对话'),
      jobId: c.jobId || '',
      resumeId: c.resumeId || '',
      messages: Array.isArray(c.messages) ? c.messages.map(function (m) {
        return { role: m.role || 'user', content: String(m.content || ''), at: m.at || U.now(), meta: m.meta || null };
      }) : [],
      createdAt: c.createdAt || U.now(),
      updatedAt: c.updatedAt || U.now(),
    };
  }

  /**
   * 背调档案（js/company-check.js）。
   * ⚠️ reg / risk 里**一律保留 null**（而不是塞 0）——
   *    「实缴 0」和「不知道实缴多少」是两件事，前者是预警信号、后者是没数据。
   *    统一转成 0 会把"没查"伪装成"查了没问题"。
   */
  function normCheck(c) {
    c = c || {};
    var reg = c.reg || {}, risk = c.risk || {};
    function nv(v) {
      if (v === null || v === undefined || v === '') return null;
      var n = typeof v === 'number' ? v : parseFloat(String(v));
      return isNaN(n) ? null : n;
    }
    return {
      id: c.id || U.uid('chk'),
      company: String(c.company || '').trim(),
      key: c.key || normCheckKey(c.company),
      source: String(c.source || 'manual'),
      reg: {
        name: String(reg.name || c.company || '').trim(),
        creditCode: String(reg.creditCode || '').trim(),
        establishedAt: nv(reg.establishedAt),
        capital: nv(reg.capital),
        paidIn: nv(reg.paidIn),
        status: String(reg.status || '').trim(),
        industry: String(reg.industry || '').trim(),
        address: String(reg.address || '').trim(),
      },
      risk: {
        // ⛔ 不再 `|| 0`（评审核实 2026-10-12，P1-2）：`nv()` 已经保证「没填 → null」，
        //   再 `|| 0` 就正好把「没查」和「查了是 0 条」抹平成同一个值 ——
        //   而这个函数**上面那段注释**的红线写的就是「统一转成 0 会把『没查』伪装成
        //   『查了没问题』」。风险项保持 null，由 company-check 的 verdict 判
        //   「null = 未知，不得给绿灯」。
        zhixing: nv(risk.zhixing),
        shixin: nv(risk.shixin),
        court: nv(risk.court),
        abnormal: nv(risk.abnormal),
        penalty: nv(risk.penalty),
        labor: nv(risk.labor),
      },
      talk: String(c.talk || ''),
      note: String(c.note || ''),
      jobIds: U.asArray(c.jobIds),
      queriedAt: c.queriedAt || null,   // 真正查过（打开过站点 / 拉过 API）的时间
      createdAt: c.createdAt || U.now(),
      updatedAt: c.updatedAt || U.now(),
    };
  }

  /** 公司名归并键。与 js/company-check.js 的 companyKey 同一口径，
   *  但那边的实现要能在 store 之前加载 —— 所以这里自带一份最小实现，
   *  并由 Store 在初始化时优先用 CompanyCheck.companyKey（见 init）。 */
  function normCheckKey(name) {
    return String(name || '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[\s\u3000·・]+/g, '')
      .trim()
      .toLowerCase();
  }

  /* ==================== 岗位 ==================== */

  function jobs(opt) {
    opt = opt || {};
    var arr = DB.jobs.slice();
    if (opt.includeArchived !== true) arr = arr.filter(function (j) { return !j.archived; });
    return arr;
  }
  function job(id) { return DB.jobs.filter(function (j) { return j.id === id; })[0] || null; }

  /** 去重键：URL 优先，否则 公司+岗位 */
  function jobDedupeKey(j) {
    if (j.url) return 'u:' + j.url.replace(/[?#].*$/, '').replace(/\/+$/, '').toLowerCase();
    /* ⛔ 兜底键必须**带城市**：老版是「公司 + 岗位名」，导致
         「深圳·销售」和「北京·销售」被当成同一条误并（同一家公司多地招人很常见）。
         主要影响手动新增 / Excel 导入（采集来的都带 url，走不到这里）。
         城市取 location 的首段（「深圳·南山区」→「深圳」），拿不到就退化成空串
         —— 退化成空串时行为与老版一致，不会把老库的键突然全改掉。 */
    var city = '';
    var loc = String(j.location || '');
    if (loc) city = loc.split(/[·\-\/\s]/)[0].toLowerCase();
    return 'n:' + (j.company || '').toLowerCase() + '||' + (j.title || '').toLowerCase()
         + '||' + city;
  }
  function findJobByKey(key, exceptId) {
    return DB.jobs.filter(function (j) { return j.id !== exceptId && jobDedupeKey(j) === key; })[0] || null;
  }

  /**
   * 新增岗位。重复则合并（补空字段、并集数组），返回 {job, dup:boolean}
   */
  function addJob(data, opt) {
    opt = opt || {};
    var j = normJob(data);
    var key = jobDedupeKey(j);
    var exist = findJobByKey(key);
    if (exist && !opt.forceNew) {
      recordConflicts(exist, j, opt.source || 'addJob');
      mergeJobInto(exist, j);
      exist.updatedAt = U.now();
      save();
      fire('jobs');
      return { job: exist, dup: true, conflicts: conflictCount() };
    }
    DB.jobs.unshift(j);
    save(); fire('jobs');
    return { job: j, dup: false };
  }

  /**
   * 批量新增（导入采集结果专用）。
   *
   * ⛔ 为什么必须单有一个入口，而不是循环调 addJob：
   *   addJob 是「一条 = 一次 save + 一次 fire」，并且**每条都拿 DB.jobs 全量线性扫一遍**算去重键。
   *   实测（真机 CDP，库里有 2000 条时导入 506 条）：
   *     · fire() 被调用 **507 次**
   *     · 整批在**一个同步任务**里跑完，事件循环被堵死 **1885ms** —— 页面完全不响应
   *   这就是用户报的「导入会卡住」。这里改成：只为这一批建**一次**索引（O(n+m) 而不是 O(n·m)），
   *   整批只落一次盘、只广播一次。
   *
   * ⚠️ 语义必须与逐条 addJob 完全一致（否则「导入全部」和「导入本次新增」会给出不同结果）：
   *   · 同一批里后面的条目能命中前面刚加进去的（索引边加边更新）
   *   · 命中重复时**第一个**匹配赢（与 findJobByKey 的 `[0]` 同序）
   *
   * @param {Array} list 原始记录（采集结果那条链路出来的形状）
   * @param {Object} [opt] { forceNew: true 时不去重，一律当新增 }
   * @returns {{added:number, dup:number, ids:string[]}}
   */
  function addJobs(list, opt) {
    opt = opt || {};
    var index = Object.create(null);
    DB.jobs.forEach(function (j) {
      var k = jobDedupeKey(j);
      if (!(k in index)) index[k] = j;
    });

    var added = 0, dup = 0, ids = [];
    (list || []).forEach(function (raw) {
      var j = normJob(raw);
      var key = jobDedupeKey(j);
      var exist = opt.forceNew ? null : index[key];
      if (exist) {
        recordConflicts(exist, j, 'addJobs');
        mergeJobInto(exist, j);
        exist.updatedAt = U.now();
        dup++; ids.push(exist.id);
        return;
      }
      DB.jobs.unshift(j);
      index[key] = j;          // 同批里的重复也要能被后面的条目命中
      added++; ids.push(j.id);
    });

    if (added || dup) { save(); fire('jobs'); }
    return { added: added, dup: dup, ids: ids };
  }

  /* ================= S1 · 采集冲突台账 =================
     ⛔ 背景：mergeJobInto 是「先写的赢」（只在旧值为空时回填）→ 同一 url 二次采集时
     薪资 / 地点 / JD 的更新**全部被静默丢弃**，且没有任何「发生过冲突」的记录。
     用户原话：「采集结果与已有岗位库存在大量重复和冲突，导致后续处理浪费大量时间。」
     去重（known_links）解决的是「重复」，这里解决的是「冲突看得见」。

     设计取舍（三条）：
       1. **不改变合并结果**。老规矩 `先写的赢` 原样保留 —— 本轮只做「可见化」，
          不做「自动选一个赢」。理由是：哪边数据更可信机器判不了（采集侧的薪资
          可能更旧，手填的可能更糙），贸然覆盖是另一种静默错误。
       2. **只记「真实的差异」**。旧值为空 → 属于「回填」不是「冲突」，不记。
          新旧相等 → 不记。只有两边都有值且不同才记。
       3. **有界**。CONFLICT_CAP 封顶，超出丢最旧的 —— localStorage 撑爆是不可逆伤害。

     字段口径：只比对**会变且用户在意**的字段。刻意**不比对** rawJD 的全文
     （JD 动辄几千字，逐字符比对既慢又没意义）→ 只记「JD 长度变化」这种粗信号。
     ================================================== */
  var CONFLICT_CAP = 500;
  var CONFLICT_FIELDS = [
    { key: 'salaryText', label: '薪资' },
    { key: 'salaryMin', label: '薪资下限' },
    { key: 'salaryMax', label: '薪资上限' },
    { key: 'location', label: '工作地点' },
    { key: 'title', label: '岗位名称' },
    { key: 'company', label: '公司' },
    { key: 'reqDegree', label: '学历要求' },
    { key: 'reqYears', label: '经验要求' },
    { key: 'address', label: '详细地址' },
    { key: 'bizArea', label: '商圈' }
  ];

  function ensureConflicts() {
    if (!DB) return [];
    if (!Array.isArray(DB.conflicts)) DB.conflicts = [];
    return DB.conflicts;
  }
  function conflicts() { return ensureConflicts().slice(); }
  function conflictCount() { return ensureConflicts().length; }

  /** 取一条差异（null = 不构成冲突） */
  function diffField(target, src, f) {
    var o = target[f.key], n = src[f.key];
    /* ⚠️ 不能用 `o && n` 判「两边都有值」：薪资下限/上限可能是 0（合法的数字）。
       用显式的「非空」判据 —— 0 是有效值，null/undefined/'' 才是空。 */
    var oHas = !(o === null || o === undefined || o === '');
    var nHas = !(n === null || n === undefined || n === '');
    if (!oHas || !nHas) return null;
    if (String(o) === String(n)) return null;
    return { key: f.key, label: f.label, old: o, new: n };
  }

  /**
   * 记录一次合并里发生的字段冲突（同岗位 + 同字段只保留最新一条）。
   * @returns {number} 本次记下的新增冲突条数
   */
  function recordConflicts(target, src, source) {
    var cs = ensureConflicts();
    var fields = [];
    CONFLICT_FIELDS.forEach(function (f) {
      var d = diffField(target, src, f);
      if (d) fields.push(d);
    });
    /* JD 长度变化：粗信号（不做全文比对，见上方口径说明） */
    var ojd = target.rawJD || '', njd = src.rawJD || '';
    if (ojd && njd && ojd !== njd) {
      fields.push({
        key: 'rawJD', label: 'JD 文本',
        old: '（' + ojd.length + ' 字）', new: '（' + njd.length + ' 字）'
      });
    }
    if (!fields.length) return 0;

    /* 同岗位合并：把新差异并进已存在的那条，避免同一岗位堆十几条 */
    var idx = -1;
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].jobId === target.id) { idx = i; break; }
    }
    if (idx >= 0) {
      var ex = cs[idx];
      fields.forEach(function (d) {
        var hit = -1;
        for (var k = 0; k < ex.fields.length; k++) {
          if (ex.fields[k].key === d.key) { hit = k; break; }
        }
        if (hit >= 0) ex.fields[hit] = d;   // 同字段覆盖成最新
        else ex.fields.push(d);
      });
      ex.at = U.now();
      ex.source = source || ex.source;
      /* 提到最前（最新在前） */
      cs.splice(idx, 1);
      cs.unshift(ex);
      return 0;
    }

    cs.unshift({
      id: U.uid ? U.uid('cf') : ('cf' + Date.now() + Math.floor(Math.random() * 1e6)),
      jobId: target.id,
      at: U.now(),
      source: source || 'merge',
      fields: fields
    });
    while (cs.length > CONFLICT_CAP) cs.pop();
    return 1;
  }

  function dismissConflict(id) {
    var cs = ensureConflicts();
    for (var i = 0; i < cs.length; i++) {
      if (cs[i].id === id) {
        cs.splice(i, 1);
        save(); fire('jobs');
        return true;
      }
    }
    return false;
  }
  function clearConflicts() {
    var cs = ensureConflicts();
    if (!cs.length) return 0;
    var n = cs.length;
    DB.conflicts = [];
    save(); fire('jobs');
    return n;
  }

  function mergeJobInto(target, src) {
    /* ⚠️ 这张白名单和 normJob 的那张是**两回事**，很容易只改一个（本文件已经踩过三次）：
         · normJob：决定字段**能不能进库**（漏了 = 字段静默消失）
         · 这里：决定**重复导入同一岗位时能不能回填**（漏了 = 库里有，但永远补不上）
       两张表都要维护同一个字段。以下是这一轮补齐的（评审只点了 bizArea/latlng，
       我核对导出层的全部 28 个键后发现实际漏了 4 个）：
         · rawJD —— 漏了最要命：二次采集不回填 JD 文本 → 合适度退化成"只看标题"（blind）
         · bizArea / latlng —— 漏了商圈与坐标（按商圈精筛、算通勤都少一半数据）
         · reqSkillsAuthoritative —— 漏了权威技能要求 */
    ['title', 'company', 'industry', 'location', 'salaryText', 'reqDegree', 'reqYears', 'url',
     'encryptJobId', 'rawJD', 'bizArea',
     'scale', 'district', 'address', 'companyInfo', 'hr', 'hrTitle', 'active'].forEach(function (k) {
      if (!target[k] && src[k]) target[k] = src[k];
    });
    /* latlng 是个对象（不是字符串），`!target[k]` 那套判空对它是够的，
       但单独列出来是为了让"经纬度也在回填范围内"这件事一眼可见。 */
    if (!target.latlng && src.latlng) target.latlng = src.latlng;
    // 布尔类：任一为真即为真（同名岗位重复采集时「代招/失效」不能因为后来一条是「否」就被抹掉）
    ['invalid', 'proxyHire', 'hrOnline'].forEach(function (k) {
      if (!target[k] && src[k]) target[k] = true;
    });
    ['salaryMin', 'salaryMax', 'salaryMonths'].forEach(function (k) {
      if (target[k] === null && src[k] !== null) target[k] = src[k];
    });
    ['benefits', 'duties', 'reqSkills', 'risks', 'pros', 'cons', 'keywords', 'tags',
     'reqSkillsAuthoritative'].forEach(function (k) {
      target[k] = U.uniq((target[k] || []).concat(src[k] || []));
    });
    if (!target.rawJD && src.rawJD) target.rawJD = src.rawJD;
    if (!target.remote && src.remote) target.remote = true;
    if (src.aiAt && (!target.aiAt || src.aiAt > target.aiAt)) { target.aiAt = src.aiAt; target.aiModel = src.aiModel; }
    if (!target.aiVerdict && src.aiVerdict) { target.aiVerdict = src.aiVerdict; target.aiVerdictAt = src.aiVerdictAt; }
    if (!target.aiGreeting && src.aiGreeting) target.aiGreeting = src.aiGreeting;
    return target;
  }

  function updateJob(id, patch) {
    var j = job(id); if (!j) return null;
    Object.assign(j, normJob(Object.assign({}, j, patch, { id: j.id, createdAt: j.createdAt })));
    j.updatedAt = U.now();
    save(); fire('jobs');
    return j;
  }

  function removeJob(id) { return removeJobs([id]); }

  function removeJobs(ids) {
    var set = {};
    ids.forEach(function (i) { set[i] = 1; });
    var n = DB.jobs.length;
    DB.jobs = DB.jobs.filter(function (j) { return !set[j.id]; });
    DB.applications = DB.applications.filter(function (a) { return !set[a.jobId]; });
    DB.interviews = DB.interviews.filter(function (v) { return !set[v.jobId]; });
    save(); fire('all');
    return n - DB.jobs.length;
  }

  /** 批量改字段：只落一次盘、只广播一次（批量操作别循环调 updateJob） */
  function updateJobs(ids, patch) {
    var n = 0;
    ids.forEach(function (id) {
      var j = job(id); if (!j) return;
      Object.assign(j, normJob(Object.assign({}, j, patch, { id: j.id, createdAt: j.createdAt })));
      j.updatedAt = U.now(); n++;
    });
    if (n) { save(); fire('jobs'); }
    return n;
  }

  /* ==================== 可撤销删除 ==================== */
  /**
   * 把记录「拿出来」而不是直接抹掉，返回快照；putBack(快照) 原样放回。
   * UI 侧配合带「撤销」按钮的 toast —— 误删不用重新录入。
   *
   * spec = { jobs:[id], applications:[id], interviews:[id], resumes:[id], materials:[id], chats:[id] }
   * 删岗位会**连带**它的投递与面试：只删岗位会留下指向空岗位的孤儿记录，
   * 看板上会冒出一条「(岗位已删除)」的卡。
   */
  var KINDS = ['jobs', 'applications', 'interviews', 'resumes', 'materials', 'chats', 'checks'];

  function takeOut(spec) {
    spec = spec || {};
    var snap = { at: U.now() };
    KINDS.forEach(function (k) { snap[k] = []; });

    function want(k) {
      var set = {};
      (spec[k] || []).filter(Boolean).forEach(function (id) { set[id] = 1; });
      return set;
    }

    var jobWanted = want('jobs');
    DB.jobs.forEach(function (j) { if (jobWanted[j.id]) snap.jobs.push(j); });
    DB.applications.forEach(function (a) { if (jobWanted[a.jobId]) snap.applications.push(a); });
    DB.interviews.forEach(function (v) { if (jobWanted[v.jobId]) snap.interviews.push(v); });

    ['applications', 'interviews', 'resumes', 'materials', 'chats', 'checks'].forEach(function (k) {
      var w = want(k);
      if (!Object.keys(w).length) return;
      DB[k].forEach(function (x) { if (w[x.id]) snap[k].push(x); });
    });

    KINDS.forEach(function (k) {
      var kill = {};
      snap[k].forEach(function (x) { kill[x.id] = 1; });
      if (!Object.keys(kill).length) return;
      DB[k] = DB[k].filter(function (x) { return !kill[x.id]; });
    });

    snap.count = KINDS.reduce(function (n, k) { return n + snap[k].length; }, 0);
    snap.sideEffect = (snap.jobs.length && (snap.applications.length || snap.interviews.length))
      ? { apps: snap.applications.length, interviews: snap.interviews.length } : null;

    save(); fire('all');
    return snap;
  }

  /** 撤销：把 takeOut 的快照放回去（已存在的同 id 记录不重复插） */
  function putBack(snap) {
    if (!snap) return 0;
    var n = 0;
    KINDS.forEach(function (k) {
      (snap[k] || []).forEach(function (x) {
        if (DB[k].some(function (y) { return y.id === x.id; })) return;
        DB[k].push(U.deepClone(x)); n++;
      });
    });
    if (n) { save(true); fire('all'); }
    return n;
  }

  function toggleJobFlag(id, field, val) {
    var j = job(id); if (!j) return;
    j[field] = val === undefined ? !j[field] : val;
    j.updatedAt = U.now();
    save(); fire('jobs');
  }

  function addJobTag(id, tag) {
    var j = job(id); if (!j || !tag) return;
    j.tags = U.uniq(j.tags.concat([tag]));
    j.updatedAt = U.now(); save(); fire('jobs');
  }
  function removeJobTag(id, tag) {
    var j = job(id); if (!j) return;
    j.tags = j.tags.filter(function (t) { return t !== tag; });
    j.updatedAt = U.now(); save(); fire('jobs');
  }
  /** 全部已用标签 */
  function allTags() {
    var m = {};
    DB.jobs.forEach(function (j) { (j.tags || []).forEach(function (t) { m[t] = (m[t] || 0) + 1; }); });
    return Object.keys(m).map(function (k) { return { tag: k, n: m[k] }; })
      .sort(function (a, b) { return b.n - a.n; });
  }

  /** 标签管理：改名（合并到已有标签时自动去重） */
  function renameTag(from, to) {
    from = String(from || '').trim(); to = String(to || '').trim();
    if (!from || !to || from === to) return 0;
    var n = 0;
    DB.jobs.forEach(function (j) {
      if ((j.tags || []).indexOf(from) < 0) return;
      j.tags = U.uniq(j.tags.map(function (t) { return t === from ? to : t; }));
      j.updatedAt = U.now(); n++;
    });
    if (n) { save(); fire('jobs'); }
    return n;
  }

  /** 标签管理：从所有岗位上摘掉某个标签 */
  function dropTag(tag) {
    var n = 0;
    DB.jobs.forEach(function (j) {
      if ((j.tags || []).indexOf(tag) < 0) return;
      j.tags = j.tags.filter(function (t) { return t !== tag; });
      j.updatedAt = U.now(); n++;
    });
    if (n) { save(); fire('jobs'); }
    return n;
  }

  /* ==================== 投递记录 ==================== */

  function applications(filter) {
    filter = filter || {};
    var arr = DB.applications.slice();
    if (filter.status) arr = arr.filter(function (a) { return a.status === filter.status; });
    if (filter.jobId) arr = arr.filter(function (a) { return a.jobId === filter.jobId; });
    if (filter.source) {
      arr = arr.filter(function (a) { var j = job(a.jobId); return j && j.source === filter.source; });
    }
    return arr;
  }
  function application(id) { return DB.applications.filter(function (a) { return a.id === id; })[0] || null; }
  function appOfJob(jobId) { return DB.applications.filter(function (a) { return a.jobId === jobId; })[0] || null; }

  function addApplication(data) {
    var a = normApp(data);
    if (!a.jobId) return null;
    var exist = appOfJob(a.jobId);
    if (exist) return exist;   // 一个岗位一条投递记录
    DB.applications.push(a);
    save(); fire('apps');
    return a;
  }

  function updateApplication(id, patch) {
    var a = application(id); if (!a) return null;
    var prevStatus = a.status;
    Object.assign(a, normApp(Object.assign({}, a, patch, { id: a.id, createdAt: a.createdAt })));
    if (a.status !== prevStatus) {
      a.timeline.push({ at: U.now(), status: a.status, note: patch.statusNote || ('状态改为「' + statusName(a.status) + '」') });
      if (a.status === 'applied' && !a.appliedAt) a.appliedAt = U.now();
    }
    a.updatedAt = U.now();
    save(); fire('apps');
    return a;
  }

  /** 看板拖拽用：只有状态变化 + 写时间线 */
  function moveApplication(id, status, note) {
    if (!STATUS_MAP[status]) return null;
    var a = application(id); if (!a) return null;
    if (a.status === status) return a;
    var prev = a.status;
    a.status = status;
    a.timeline.push({ at: U.now(), status: status, note: note || ('从「' + statusName(prev) + '」移到「' + statusName(status) + '」') });
    if (status === 'applied' && !a.appliedAt) a.appliedAt = U.now();
    a.updatedAt = U.now();
    save(); fire('apps');
    return a;
  }

  function removeApplication(id) {
    DB.applications = DB.applications.filter(function (a) { return a.id !== id; });
    save(); fire('apps');
  }

  /**
   * 用户点了岗位卡上的「去 BOSS 投递」—— 只记一笔「去过」，**不代表已经投出去了**。
   *
   * ⚠️ 为什么状态是 todo 而不是 applied：
   *   点按钮只是把页面打开，用户完全可能看了一眼觉得不合适就关掉。若直接记 applied，
   *   投递数、回复率、漏斗全部会被虚增。`hasApplied()` 的门槛是越过 applied，
   *   所以 todo 记录**不进任何投递口径统计**，只是留个痕、提醒用户「这个你打开过」。
   *
   * 已有记录时**什么都不改**（不覆盖用户已经推进到 viewed/invited 的状态）。
   */
  function recordBossVisit(jobId) {
    if (!jobId) return null;
    var exist = appOfJob(jobId);
    if (exist) return exist;
    return addApplication({
      jobId: jobId,
      status: 'todo',
      timeline: [{ at: U.now(), status: 'todo',
        note: '点了「去 BOSS 投递」（只是打开了页面，还没确认投出去）' }],
    });
  }

  /**
   * 用户从 BOSS 投完回来点「我已投了」—— 这才是真正的「已投递」。
   * 没有记录就先建一条（手动新增的岗位也可能直接被投）；已经有了就推进状态。
   * 幂等：已经是 applied 就直接返回，不重复写时间线。
   */
  function markAppliedByUser(jobId, note) {
    if (!jobId) return null;
    var a = appOfJob(jobId);
    if (!a) {
      return addApplication({
        jobId: jobId,
        status: 'applied',
        appliedAt: U.now(),
        timeline: [{ at: U.now(), status: 'applied', note: note || '手动确认已投递' }],
      });
    }
    if (a.status === 'applied') return a;                 // 幂等
    return updateApplication(a.id, { status: 'applied', statusNote: note || '手动确认已投递' });
  }

  /** 某条投递达到过的最远链上位置（用于漏斗） */
  function reachedIndex(a) {
    var max = chainIndex(a.status);
    (a.timeline || []).forEach(function (t) {
      var i = chainIndex(t.status);
      if (i > max) max = i;
    });
    return max;
  }

  /** 是否投递过（状态越过 todo） */
  function hasApplied(a) {
    if (a.status === 'rejected') return !!a.appliedAt || reachedIndex(a) >= chainIndex('applied') || (a.timeline || []).length > 1;
    return reachedIndex(a) >= chainIndex('applied');
  }

  /* ==================== 面试 ==================== */

  function interviews(filter) {
    filter = filter || {};
    var arr = DB.interviews.slice();
    if (filter.jobId) arr = arr.filter(function (v) { return v.jobId === filter.jobId; });
    if (filter.status) arr = arr.filter(function (v) { return v.status === filter.status; });
    if (filter.upcoming) arr = arr.filter(function (v) { return v.at && v.at > U.now() && v.status === 'scheduled'; });
    return arr;
  }
  function interview(id) { return DB.interviews.filter(function (v) { return v.id === id; })[0] || null; }

  function addInterview(data) {
    var v = normInterview(data);
    DB.interviews.push(v);
    save(); fire('interviews');
    autoSyncInterview(v);
    return v;
  }
  function updateInterview(id, patch) {
    var v = interview(id); if (!v) return null;
    Object.assign(v, normInterview(Object.assign({}, v, patch, { id: v.id, createdAt: v.createdAt })));
    v.updatedAt = U.now();
    save(); fire('interviews');
    return v;
  }
  function removeInterview(id) {
    DB.interviews = DB.interviews.filter(function (v) { return v.id !== id; });
    save(); fire('interviews');
  }

  /**
   * 面试创建后，顺手把对应投递状态推进到「邀约面试」（如果还没到）
   * 这样看板和面试模块不会各说各话。
   */
  function autoSyncInterview(v) {
    if (!v.jobId) return;
    var a = appOfJob(v.jobId);
    if (!a) a = addApplication({ jobId: v.jobId, status: 'invited' });
    if (!a) return;
    if (chainIndex(a.status) < chainIndex('invited')) {
      moveApplication(a.id, 'invited', '已安排面试：' + (v.round || ''));
    } else {
      var target = roundToStatus(v.round);
      if (target && chainIndex(target) > chainIndex(a.status)) {
        moveApplication(a.id, target, '面试轮次：' + (v.round || ''));
      }
    }
  }

  function roundToStatus(round) {
    var r = String(round || '');
    if (/终面|HRBP|高管/.test(r)) return 'final';
    if (/二面|主管/.test(r)) return 'round2';
    if (/一面/.test(r)) return 'round1';
    return 'invited';
  }

  /** 即将到来的面试（按时间升序） */
  function upcomingInterviews(limit) {
    var arr = DB.interviews.filter(function (v) { return v.at && v.at > U.now() && v.status === 'scheduled'; });
    arr.sort(function (a, b) { return a.at - b.at; });
    return limit ? arr.slice(0, limit) : arr;
  }

  /* ==================== 简历 ==================== */

  function resumes() {
    return DB.resumes.slice().sort(function (a, b) {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      return b.updatedAt - a.updatedAt;
    });
  }
  function resume(id) { return DB.resumes.filter(function (r) { return r.id === id; })[0] || null; }
  function defaultResume() { return DB.resumes.filter(function (r) { return r.isDefault; })[0] || DB.resumes[0] || null; }

  function addResume(data) {
    var r = normResume(data);
    if (r.isDefault) DB.resumes.forEach(function (x) { x.isDefault = false; });
    else if (!DB.resumes.length) r.isDefault = true;
    DB.resumes.unshift(r);
    save(); fire('resumes');
    return r;
  }
  function updateResume(id, patch) {
    var r = resume(id); if (!r) return null;
    Object.assign(r, normResume(Object.assign({}, r, patch, { id: r.id, createdAt: r.createdAt })));
    if (patch.isDefault) DB.resumes.forEach(function (x) { if (x.id !== id) x.isDefault = false; });
    r.updatedAt = U.now();
    save(); fire('resumes');
    return r;
  }
  function removeResume(id) {
    DB.resumes = DB.resumes.filter(function (r) { return r.id !== id; });
    if (DB.resumes.length && !DB.resumes.some(function (r) { return r.isDefault; })) DB.resumes[0].isDefault = true;
    DB.applications.forEach(function (a) { if (a.resumeId === id) a.resumeId = ''; });
    save(); fire('resumes');
  }

  /* ==================== 素材 ==================== */

  function materials(filter) {
    filter = filter || {};
    var arr = DB.materials.slice();
    if (filter.kind) arr = arr.filter(function (m) { return m.kind === filter.kind; });
    if (filter.jobId) arr = arr.filter(function (m) { return (m.jobIds || []).indexOf(filter.jobId) >= 0; });
    return arr.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }
  function material(id) { return DB.materials.filter(function (m) { return m.id === id; })[0] || null; }
  function addMaterial(data) {
    var m = normMaterial(data);
    DB.materials.unshift(m); save(); fire('materials'); return m;
  }
  function updateMaterial(id, patch) {
    var m = material(id); if (!m) return null;
    Object.assign(m, normMaterial(Object.assign({}, m, patch, { id: m.id, createdAt: m.createdAt })));
    m.updatedAt = U.now(); save(); fire('materials'); return m;
  }
  function removeMaterial(id) {
    DB.materials = DB.materials.filter(function (m) { return m.id !== id; });
    save(); fire('materials');
  }

  /* ==================== 对话 ==================== */

  function chats(filter) {
    filter = filter || {};
    var arr = DB.chats.slice();
    if (filter.kind) arr = arr.filter(function (c) { return c.kind === filter.kind; });
    if (filter.jobId) arr = arr.filter(function (c) { return c.jobId === filter.jobId; });
    return arr.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
  }
  function chat(id) { return DB.chats.filter(function (c) { return c.id === id; })[0] || null; }
  function addChat(data) {
    var c = normChat(data);
    DB.chats.unshift(c); save(); fire('chats'); return c;
  }
  function updateChat(id, patch) {
    var c = chat(id); if (!c) return null;
    Object.assign(c, normChat(Object.assign({}, c, patch, { id: c.id, createdAt: c.createdAt })));
    c.updatedAt = U.now(); save(); fire('chats'); return c;
  }
  function pushMessage(chatId, role, content, meta) {
    var c = chat(chatId); if (!c) return null;
    c.messages.push({ role: role, content: String(content || ''), at: U.now(), meta: meta || null });
    // 自动命名
    if (c.title === '新对话' && role === 'user' && content) c.title = U.truncate(String(content).replace(/\s+/g, ' '), 18);
    c.updatedAt = U.now();
    save(); fire('chats');
    return c;
  }
  function removeChat(id) {
    DB.chats = DB.chats.filter(function (c) { return c.id !== id; });
    save(); fire('chats');
  }

  /* ==================== 公司背调 ==================== */

  function checkKey(name) {
    // 优先用能力模块的口径（只有一份实现），拿不到就退回自带的 —— 保证两边不会跑偏
    if (global.CompanyCheck && global.CompanyCheck.companyKey) return global.CompanyCheck.companyKey(name);
    return normCheckKey(name);
  }

  function checks(filter) {
    filter = filter || {};
    var arr = DB.checks.slice();
    if (filter.q) {
      var q = String(filter.q).toLowerCase();
      arr = arr.filter(function (c) {
        return (c.company + ' ' + c.reg.creditCode + ' ' + c.note).toLowerCase().indexOf(q) >= 0;
      });
    }
    return arr.sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
  }
  function check(id) { return DB.checks.filter(function (c) { return c.id === id; })[0] || null; }
  function checkByCompany(name) {
    var k = checkKey(name);
    if (!k) return null;
    return DB.checks.filter(function (c) { return c.key === k; })[0] || null;
  }
  function addCheck(data) {
    var c = normCheck(data);
    c.key = checkKey(c.company);
    // 同一家公司只留一份 —— 重复录入会造出两份互相矛盾的档案，红灯绿灯各说各话
    var exist = DB.checks.filter(function (x) { return x.key === c.key; })[0];
    if (exist) {
      Object.assign(exist, normCheck(Object.assign({}, exist, data, { id: exist.id, createdAt: exist.createdAt })));
      exist.key = c.key;
      exist.updatedAt = U.now();
      save(); fire('checks');
      return { rec: exist, dup: true };
    }
    DB.checks.unshift(c); save(); fire('checks');
    return { rec: c, dup: false };
  }
  /** 按公司名 upsert（背调页「保存」走这条 —— 它不知道有没有旧档案） */
  function upsertCheck(company, patch) {
    var exist = checkByCompany(company);
    if (exist) return addCheck(Object.assign({}, exist, patch, { id: exist.id, company: exist.company }));
    return addCheck(Object.assign({ company: company }, patch || {}));
  }
  function updateCheck(id, patch) {
    var c = check(id); if (!c) return null;
    Object.assign(c, normCheck(Object.assign({}, c, patch, { id: c.id, company: c.company, createdAt: c.createdAt })));
    c.key = checkKey(c.company);
    c.updatedAt = U.now(); save(); fire('checks'); return c;
  }
  function removeCheck(id) {
    DB.checks = DB.checks.filter(function (c) { return c.id !== id; });
    save(); fire('checks');
  }

  /* ==================== 稍后提醒 / 备份台账 ==================== */

  /** 「稍后提醒」：key 形如 'applied:<jobId>'，days 天后重新出现在待跟进页 */
  function snooze(key, days) {
    var s = DB.settings.snooze = DB.settings.snooze || {};
    s[key] = U.now() + (days || 3) * 86400000;
    save(); fire('settings');
    return s[key];
  }
  function isSnoozed(key) {
    var s = (DB.settings.snooze || {})[key];
    return !!(s && s > U.now());
  }
  function wakeUp(key) {
    var s = DB.settings.snooze || {};
    if (s[key]) { delete s[key]; save(); fire('settings'); }
  }

  /** 导出成功时记一笔，启动时用来做「该备份了」的提醒 */
  function markExported() {
    DB.settings.backup = DB.settings.backup || {};
    DB.settings.backup.lastExportAt = U.now();
    DB.settings.backup.lastRemindedAt = U.now();
    save(); fire('settings');
  }
  /** 距上次导出天数；从没导出过返回 null */
  function daysSinceExport() {
    var t = (DB.settings.backup || {}).lastExportAt;
    return t ? Math.floor((U.now() - t) / 86400000) : null;
  }

  /* ==================== 统计 ==================== */

  function stats() {
    var allJobs = DB.jobs;
    var activeJobs = allJobs.filter(function (j) { return !j.archived; });
    var bossJobs = activeJobs.filter(function (j) { return j.source === 'boss'; });
    var apps = DB.applications;
    var appliedList = apps.filter(hasApplied);

    var reachedChain = function (st) {
      return appliedList.filter(function (a) { return reachedIndex(a) >= chainIndex(st); }).length;
    };

    var funnel = [
      { key: 'applied', name: '投递', n: appliedList.length },
      { key: 'viewed', name: '被查看', n: reachedChain('viewed') },
      { key: 'invited', name: '邀约面试', n: reachedChain('invited') },
      { key: 'round1', name: '实际面试', n: reachedChain('round1') },
      { key: 'offer', name: '拿到 offer', n: reachedChain('offer') },
    ];

    var byStatus = {};
    STATUSES.forEach(function (s) { byStatus[s.id] = 0; });
    apps.forEach(function (a) { byStatus[a.status] = (byStatus[a.status] || 0) + 1; });

    var byIndustry = U.groupBy(activeJobs.filter(function (j) { return j.industry; }), function (j) { return j.industry; });
    var industryDist = Object.keys(byIndustry).map(function (k) { return { name: k, n: byIndustry[k].length }; })
      .sort(function (a, b) { return b.n - a.n; });

    // 薪资区间分布（按 salaryMin 落档，单位 k）
    var BUCKETS = [
      { name: '5k 以下', lo: 0, hi: 5 }, { name: '5-10k', lo: 5, hi: 10 },
      { name: '10-15k', lo: 10, hi: 15 }, { name: '15-20k', lo: 15, hi: 20 },
      { name: '20-30k', lo: 20, hi: 30 }, { name: '30k 以上', lo: 30, hi: 1e9 },
    ];
    var salaryDist = BUCKETS.map(function (b) { return { name: b.name, n: 0 }; });
    activeJobs.forEach(function (j) {
      var v = j.salaryMin;
      if (v === null || v === undefined) return;
      for (var i = 0; i < BUCKETS.length; i++) {
        if (v >= BUCKETS[i].lo && v < BUCKETS[i].hi) { salaryDist[i].n++; break; }
      }
    });

    var byTag = {};
    activeJobs.forEach(function (j) { (j.tags || []).forEach(function (t) { byTag[t] = (byTag[t] || 0) + 1; }); });

    var byChannel = {};
    appliedList.forEach(function (a) { byChannel[a.channel || '其他'] = (byChannel[a.channel || '其他'] || 0) + 1; });

    var ivs = DB.interviews;
    var now = U.now();

    return {
      jobTotal: activeJobs.length,
      jobBoss: bossJobs.length,
      jobManual: activeJobs.length - bossJobs.length,
      jobFavorite: activeJobs.filter(function (j) { return j.favorite; }).length,
      jobArchived: allJobs.filter(function (j) { return j.archived; }).length,
      jobNoApp: activeJobs.filter(function (j) { return !appOfJob(j.id); }).length,

      appTotal: apps.length,
      appliedTotal: appliedList.length,
      appTodo: byStatus.todo || 0,
      appActive: apps.filter(function (a) {
        return a.status !== 'rejected' && a.status !== 'offer' && hasApplied(a);
      }).length,

      interviewTotal: ivs.length,
      interviewUpcoming: ivs.filter(function (v) { return v.at && v.at > now && v.status === 'scheduled'; }).length,
      interviewDone: ivs.filter(function (v) { return v.status === 'done'; }).length,

      offerTotal: apps.filter(function (a) { return a.status === 'offer' || reachedIndex(a) >= chainIndex('offer'); }).length,
      rejectTotal: apps.filter(function (a) { return a.status === 'rejected'; }).length,

      resumeTotal: DB.resumes.length,
      materialTotal: DB.materials.length,
      chatTotal: DB.chats.length,
      checkTotal: DB.checks.length,

      funnel: funnel,
      byStatus: byStatus,
      industryDist: industryDist,
      salaryDist: salaryDist,
      byChannel: byChannel,
      byTag: byTag,

      // 转化率
      viewRate: U.pct(funnel[1].n, funnel[0].n),
      inviteRate: U.pct(funnel[2].n, funnel[0].n),
      offerRate: U.pct(funnel[4].n, funnel[0].n),
      interviewRate: U.pct(funnel[3].n, funnel[2].n),
    };
  }

  /* ==================== 投递闭环：回复率 + 归因 ====================
     评审 §五-8 / 9-30 评审「真正空白、价值最高」：所有数据（状态流转 + 时间戳 +
     岗位属性）都在本地库里，不需要任何新采集。这里把「HR 有没有回你」显式算出来，
     并按岗位属性切片，帮用户看清「哪类岗位更愿意回我」，据此调整投递方向。

     回复的判定口径：投递后 HR 有「被查看」及以上动作（reachedIndex >= viewed）。
     这是现有数据能拿到的、最接近「回复」的客观信号 —— 纯「已投递、石沉大海」的
     就是没回复。邀约/面试是「更积极的回复」，单独再给一个「深度回复」口径。 */
  function replyStats() {
    var applied = DB.applications.filter(hasApplied);
    var replied = applied.filter(function (a) { return reachedIndex(a) >= chainIndex('viewed'); });
    var deeply = applied.filter(function (a) { return reachedIndex(a) >= chainIndex('invited'); });

    // 一条投递的岗位属性（归因切片用）。岗位可能已删 → 空对象兜底。
    function jobOf(a) { return job(a.jobId) || {}; }

    // 按某维度对「已投递」切片，算每片的回复率。返回 [{ name, n, replied, rate }]，
    // 按 n 降序、只保留 n>=minN 的片（样本太小没参考价值）。
    function sliceBy(getKey, minN) {
      minN = minN || 1;
      var by = {};
      applied.forEach(function (a) {
        var k = getKey(jobOf(a), a) || '（未填）';
        if (!by[k]) by[k] = { n: 0, replied: 0 };
        by[k].n++;
        if (reachedIndex(a) >= chainIndex('viewed')) by[k].replied++;
      });
      return Object.keys(by).map(function (k) {
        var d = by[k];
        return { name: k, n: d.n, replied: d.replied, rate: d.n ? Math.round(d.replied / d.n * 100) : 0 };
      }).filter(function (d) { return d.n >= minN; })
        .sort(function (a, b) { return b.n - a.n; });
    }

    // 薪资档（用 salaryMin 落档，与 stats() 的 BUCKETS 口径一致）
    var salBuckets = [
      { name: '5k 以下', lo: 0, hi: 5 }, { name: '5-10k', lo: 5, hi: 10 },
      { name: '10-15k', lo: 10, hi: 15 }, { name: '15-20k', lo: 15, hi: 20 },
      { name: '20-30k', lo: 20, hi: 30 }, { name: '30k 以上', lo: 30, hi: 1e9 },
    ];
    function salName(j) {
      if (j.salaryMin === null || j.salaryMin === undefined) return null;
      for (var i = 0; i < salBuckets.length; i++) {
        if (j.salaryMin >= salBuckets[i].lo && j.salaryMin < salBuckets[i].hi) return salBuckets[i].name;
      }
      return null;
    }

    return {
      appliedTotal: applied.length,
      repliedTotal: replied.length,
      replyRate: applied.length ? Math.round(replied.length / applied.length * 100) : 0,
      deepRepliedTotal: deeply.length,
      deepReplyRate: applied.length ? Math.round(deeply.length / applied.length * 100) : 0,
      // 各维度归因切片
      byIndustry: sliceBy(function (j) { return j.industry; }, 2),
      bySalary: sliceBy(salName, 2),
      byScale: sliceBy(function (j) { return j.scale; }, 2),
      byChannel: sliceBy(function (j, a) { return a.channel; }, 2),
      byFit: sliceBy(function (j) {
        var v = j.aiVerdict;
        return (v && typeof v.score === 'number') ? (v.score >= 80 ? 'A（≥80）' : v.score >= 60 ? 'B（60-79）' : v.score >= 40 ? 'C（40-59）' : 'D（<40）') : null;
      }, 2),
      // 没有回复的（石沉大海）—— 按「停留已投递且超 7 天」算「疑似凉了」
      silentTotal: applied.filter(function (a) {
        return reachedIndex(a) < chainIndex('viewed');
      }).length,
      silentOver7d: applied.filter(function (a) {
        return reachedIndex(a) < chainIndex('viewed') && a.appliedAt && (U.now() - a.appliedAt) > 7 * 86400000;
      }).length,
    };
  }

  /* ==================== 导入 / 导出 ==================== */

  /**
   * 导出用对象。必须深拷贝 —— 否则调用方拿到的是活引用，
   *  后续新增的数据会「凭空」出现在已导出的快照里（测试就抓到这个坑）。
   *
   * @param opt { keepApiKey: true } 才保留模型 Key；**默认抹掉**。
   *
   * ⛔ 为什么默认改成抹掉（评审 2.3，三个子代理各自独立都点到了同一条）：
   *    导出物的实际用途是「丢进网盘 / 发给别人帮看」，而设置页上写着
   *    「Key 只存在你自己的浏览器里，不上传任何服务器」——
   *    一份带 Key 的备份发出去，那句承诺就成了假的。
   *    以前只抹背调的 Key、不动 ai.apiKey，注释理由是"改了会让人以为备份把 Key 弄丢了"。
   *    这个顾虑是真的，但**默认安全**更重要：想连 Key 一起备份的人可以显式勾选，
   *    而"默认带 Key 外发"这种事一旦发生就收不回来。所以：
   *      · 默认脱敏；勾了「连 Key 一起导出」才保留；
   *      · 两种情况下导出文件里都会写一条 `_keyRedacted` 标记，
   *        恢复备份时能明确告诉用户"这份备份里没有 Key"。
   */
  function exportObject(opt) {
    opt = opt || {};
    var s = U.deepClone(DB.settings);
    var redacted = [];
    /* 背调的 Key 一直是抹的（§5：仅本地保存、勿外传）—— 它连"保留"的选项都不给。 */
    if (s && s.bgCheck && s.bgCheck.apiKey) { s.bgCheck.apiKey = ''; redacted.push('bgCheck.apiKey'); }
    if (s && s.ai && s.ai.apiKey) {
      if (opt.keepApiKey) {
        // 用户显式要求保留 —— 尊重，但要他自己承担
      } else {
        s.ai.apiKey = '';
        redacted.push('ai.apiKey');
      }
    }
    return U.deepClone({
      _app: '求职猎手工作台',
      _schema: SCHEMA,
      _exportedAt: new Date().toISOString(),
      // 恢复时据此提示「这份备份里没有 Key，要重新填一次」
      _keyRedacted: redacted,
      settings: s,
      jobs: DB.jobs,
      applications: DB.applications,
      interviews: DB.interviews,
      resumes: DB.resumes,
      materials: DB.materials,
      chats: DB.chats,
      checks: DB.checks,
      /* ⛔ 采集冲突台账也要导（评审核实 2026-10-30，P0-5）。
         以前这里漏了 conflicts —— blank() 有 9 张表、这里只导 8 张，
         于是「备份 → 恢复」之后冲突台账整表消失，而岗位已经被合并过，
         用户再也看不到「这条岗位哪些字段被覆盖过」。
         ⚠️ 这张表刻意不进 SCHEMA 版本号（见 blank() 的注释），
            老备份里没有这个键 → migrate() 补空数组，所以导入侧不需要额外兼容。 */
      conflicts: DB.conflicts,
    });
  }

  /**
   * 导入备份。mode: 'merge'（合并，默认）| 'replace'（覆盖）
   */
  function importObject(obj, mode) {
    if (!obj || typeof obj !== 'object') throw new Error('文件内容不是合法的 JSON 对象');
    var incoming = migrate(obj);
    var rep = { jobs: 0, apps: 0, interviews: 0, resumes: 0, materials: 0, chats: 0, checks: 0, skipped: 0 };

    if (mode === 'replace') {
      DB.jobs = incoming.jobs;
      DB.applications = incoming.applications;
      DB.interviews = incoming.interviews;
      DB.resumes = incoming.resumes;
      DB.materials = incoming.materials;
      DB.chats = incoming.chats;
      DB.checks = incoming.checks;
      /* ⛔ conflicts 必须一起换（评审核实 2026-10-30，P0-5）。
         以前 replace 只换 7 张表、不碰 conflicts ⇒ 覆盖导入后 DB.conflicts 里
         还是**旧库的** jobId，而那些岗位对象已经被整表替换掉了 →
         view-conflicts.js:40 的 alive[c.jobId] 过滤把它们全判成死记录，
         冲突面板直接空掉，且这些孤儿数据会永久留在库里。
         新备份没这个键时 migrate() 会补空数组，所以这里直接用 incoming 的值。 */
      DB.conflicts = incoming.conflicts || [];
      if (incoming.settings) DB.settings = incoming.settings;
      rep.jobs = DB.jobs.length; rep.apps = DB.applications.length;
      rep.interviews = DB.interviews.length; rep.resumes = DB.resumes.length;
      rep.materials = DB.materials.length; rep.chats = DB.chats.length;
      rep.checks = DB.checks.length;
      save(true); fire('all');
      return rep;
    }

    // 合并模式：按 id / 去重键
    var jobIdMap = {};        // 旧 id → 新 id（关联要跟着改）
    incoming.jobs.forEach(function (j) {
      var key = jobDedupeKey(j);
      var exist = findJobByKey(key) || DB.jobs.filter(function (x) { return x.id === j.id; })[0];
      if (exist) {
        mergeJobInto(exist, j);
        jobIdMap[j.id] = exist.id;
        rep.skipped++;
      } else {
        DB.jobs.unshift(j);
        jobIdMap[j.id] = j.id;
        rep.jobs++;
      }
    });

    /* ⛔ 合并简历时**必须保住本地 id**（评审 P1-7）。
       原来直接 `Object.assign(hit, r)` 会把远端的 `r.id` 一起写进本地 ⇒ 本地简历
       id 被悄悄换掉，而所有 `application.resumeId` 还指着旧 id ⇒ **悬空外键**，
       `Store.resume(id)` 返回 null（已复现）。同一个函数里 checks 的合并就显式
       保住了 id/createdAt（见下面 `var id = exist.id, createdAt = exist.createdAt`），
       这里是漏写。
       策略：① id 命中 → 保本地 id/createdAt，只补空字段（不覆盖本地正文）；
            ② name 命中（同一人、两台机器 id 天然不同）→ 同样保本地 id，
               并把进来的 resumeId 引用重映射回本地 id。 */
    var resumeIdMap = {};        // 远端简历 id → 本地简历 id
    function fillEmptyResume(dst, src) {
      Object.keys(src).forEach(function (k) {
        if (k === 'id' || k === 'createdAt') return;       // 归属字段一律不碰
        var v = src[k], cur = dst[k];
        var empty = (cur === undefined || cur === null || cur === '' ||
                     (Array.isArray(cur) && !cur.length));
        if (empty && v !== undefined && v !== null && v !== '') dst[k] = v;
      });
    }
    incoming.resumes.forEach(function (r) {
      var idHit = DB.resumes.filter(function (x) { return x.id === r.id; })[0];
      var nameHit = DB.resumes.filter(function (x) { return x.name === r.name; })[0];
      var hit = idHit || nameHit;
      if (!hit) { DB.resumes.push(r); rep.resumes++; resumeIdMap[r.id] = r.id; return; }
      fillEmptyResume(hit, r);
      resumeIdMap[r.id] = hit.id;                          // 引用要跟着改回本地 id
    });

    function mapResume(id) { return resumeIdMap[id] || id; }

    function mapJob(id) { return jobIdMap[id] || id; }

    incoming.applications.forEach(function (a) {
      a.jobId = mapJob(a.jobId);
      // ⛔ 简历引用也要重映射（评审 P1-7）：合并时本地简历保住了自己的 id，
      //    所以备份里指向远端 id 的 resumeId 必须改回本地 id，否则又是悬空外键。
      a.resumeId = mapResume(a.resumeId);
      var exist = appOfJob(a.jobId);
      if (exist) {
        // 取"更靠前"的状态，避免合并时把进度倒退
        if (chainIndex(a.status) > chainIndex(exist.status)) exist.status = a.status;
        exist.timeline = U.uniqBy(exist.timeline.concat(a.timeline || []), function (t) { return t.at + '|' + t.status; })
          .sort(function (x, y) { return x.at - y.at; });
        if (!exist.note && a.note) exist.note = a.note;
        if (!exist.appliedAt && a.appliedAt) exist.appliedAt = a.appliedAt;
        if (!exist.resumeId && a.resumeId) exist.resumeId = a.resumeId;
        rep.skipped++;
      } else { DB.applications.push(a); rep.apps++; }
    });

    incoming.interviews.forEach(function (v) {
      v.jobId = mapJob(v.jobId);
      if (DB.interviews.some(function (x) { return x.id === v.id; })) { rep.skipped++; return; }
      DB.interviews.push(v); rep.interviews++;
    });

    incoming.materials.forEach(function (m) {
      m.jobIds = (m.jobIds || []).map(mapJob);
      if (DB.materials.some(function (x) { return x.id === m.id; })) { rep.skipped++; return; }
      DB.materials.push(m); rep.materials++;
    });

    incoming.chats.forEach(function (c) {
      c.jobId = mapJob(c.jobId);
      if (DB.chats.some(function (x) { return x.id === c.id; })) { rep.skipped++; return; }
      DB.chats.unshift(c); rep.chats++;
    });

    /* 背调档案按「公司归并键」合并（不是按 id）——
       同一家公司在两台机器上录过，id 天然不同，按 id 会变成两条互相矛盾的档案。 */
    incoming.checks.forEach(function (c) {
      c.jobIds = (c.jobIds || []).map(mapJob);
      c.key = checkKey(c.company);
      var exist = DB.checks.filter(function (x) { return x.key === c.key; })[0];
      if (!exist) { DB.checks.unshift(c); rep.checks++; return; }
      // 两边都录过 → 取「填得更全 + 更新」的那份字段，别把已查到的数据覆盖成空的
      if ((c.updatedAt || 0) > (exist.updatedAt || 0)) {
        var id = exist.id, createdAt = exist.createdAt;
        Object.assign(exist, c);
        exist.id = id; exist.createdAt = createdAt;
      }
      exist.jobIds = U.uniq((exist.jobIds || []).concat(c.jobIds || []));
      rep.skipped++;
    });

    save(true); fire('all');
    return rep;
  }

  function clearAll(keepSettings) {
    var settings = keepSettings ? DB.settings : U.deepClone(DEFAULT_SETTINGS);
    DB = blank();
    DB.settings = settings;
    save(true); fire('all');
  }

  /** 存储占用 */
  function usage() {
    var bytes = 0;
    try { bytes = (JSON.stringify(DB) || '').length; } catch (e) { bytes = 0; }
    // 浏览器没有标准 API 能查 localStorage 真实配额（多数 5MB，Safari 隐私模式
    // 直接抛 QuotaExceededError）。这里用 5MB 作**估计分母**，只用于显示占用百分比。
    // （曾写成 `try { total = 5*1024*1024 } catch { total = 0 }` —— 包住常量赋值的
    //   死代码，catch 永远进不去，评审 P2-7 揪出后改成直白赋值。）
    var total = 5 * 1024 * 1024;
    /* 「其中有多少是上一版备份」也要能说出来。
       save() 每次写主键前都会把**上一版整份**复制到 `<key>.bak`（见 save()），
       所以占用里约一半其实是备份 —— 用户看到"占用 1.28 MB"会以为数据真有那么大。
       配额逼近 5MB 时这个数字很关键（评审 A13）。 */
    var bak = 0;
    try { bak = (global.localStorage.getItem(KEY_BAK()) || '').length; } catch (e) { bak = 0; }
    return { bytes: bytes, bakBytes: bak, total: total,
             text: U.bytes(bytes), bakText: bak ? U.bytes(bak) : '0 B',
             pct: U.pct(bytes, total) };
  }

  /* ==================== 示例数据（首次体验用） ==================== */

  function loadDemo() {
    var now = U.now();
    var demoJobs = [
      {
        source: 'boss', title: '短视频运营（0-1 起号）', company: '杭州云栖数字科技有限公司',
        industry: '互联网', location: '杭州 · 西湖区', salaryText: '10-15K', salaryMin: 10, salaryMax: 15,
        salaryMonths: 13, benefits: ['五险一金', '双休', '弹性工作', '零食下午茶'],
        duties: ['负责抖音 / 视频号账号从 0 到 1 搭建与内容规划', '独立完成选题、脚本、拍摄统筹与剪辑', '跟踪数据表现并迭代内容策略'],
        reqDegree: '大专', reqYears: '1-3年', reqSkills: ['抖音', '视频号', '剪映', '内容策划', '数据分析'],
        risks: [], pros: ['双平台同时起号，成长空间大'], cons: ['要求独立完成全流程'],
        keywords: ['抖音', '视频号', '起号'], tags: ['急招'],
        url: 'https://www.zhipin.com/job_detail/demo0001.html',
        rawJD: '【岗位职责】\n1. 负责抖音、视频号账号从 0 到 1 搭建与内容规划；\n2. 独立完成选题、脚本、拍摄统筹与剪辑；\n3. 跟踪数据表现并迭代内容策略。\n【任职要求】\n1. 大专及以上，1-3 年短视频运营经验；\n2. 熟练使用剪映，有爆款视频案例优先；\n3. 有 AI 工具（如 Claude、DeepSeek）辅助内容生产经验加分。',
        favorite: true,
      },
      {
        source: 'boss', title: '新媒体内容运营', company: '杭州拾光文化传媒有限公司',
        industry: '广告/传媒', location: '杭州 · 滨江区', salaryText: '9-13K', salaryMin: 9, salaryMax: 13,
        salaryMonths: 12, benefits: ['五险一金', '双休', '定期体检'],
        duties: ['负责公众号、小红书内容运营', '撰写图文与短视频脚本', '参与品牌活动策划'],
        reqDegree: '本科', reqYears: '1-3年', reqSkills: ['公众号', '小红书', '文案', '脚本'],
        risks: ['JD 描述较宽泛'], pros: ['内容方向多元'], cons: ['要求本科'],
        keywords: ['小红书', '公众号'], tags: [],
        rawJD: '【岗位职责】\n1. 负责公众号、小红书平台内容运营；\n2. 撰写图文与短视频脚本；\n3. 参与品牌活动策划。\n【任职要求】\n1. 本科及以上学历，中文 / 新闻 / 传播类专业优先；\n2. 1-3 年新媒体内容经验，文案功底扎实；\n3. 熟悉小红书平台调性。',
      },
      {
        source: 'boss', title: 'AIGC 内容运营（AI 工具方向）', company: '极睿智能科技（杭州）有限公司',
        industry: '人工智能', location: '杭州 · 余杭区', remote: true, salaryText: '12-20K', salaryMin: 12, salaryMax: 20,
        salaryMonths: 14, benefits: ['五险一金', '双休', '远程办公', '股票期权'],
        duties: ['用 AI 工具批量生产图文 / 短视频内容', '搭建内容生产 SOP 与提示词库', '跟踪 AIGC 行业动态'],
        reqDegree: '大专', reqYears: '经验不限', reqSkills: ['AIGC', 'Prompt', 'Midjourney', '视频剪辑', '自动化'],
        risks: ['初创公司，稳定性待观察'], pros: ['远程办公', '方向新', '薪资上限高'], cons: ['团队规模小'],
        keywords: ['AIGC', 'AI 运营', '远程'], tags: ['远程', '初创'],
        rawJD: '【岗位职责】\n1. 熟练运用 AI 工具批量生产图文 / 短视频内容；\n2. 搭建内容生产 SOP 与提示词库；\n3. 跟踪 AIGC 行业动态并输出方法论。\n【任职要求】\n1. 大专及以上，经验不限，看重实际产出；\n2. 熟悉主流 AIGC 工具，有提效案例优先；\n3. 支持远程办公。',
      },
      {
        source: 'boss', title: '用户增长运营', company: '杭州象屿人力资源服务有限公司',
        industry: '人力资源', location: '杭州 · 江干区', salaryText: '8-12K', salaryMin: 8, salaryMax: 12,
        salaryMonths: 12, benefits: ['五险一金'],
        duties: ['负责社群拉新与留存', '策划增长活动', '数据分析与复盘'],
        reqDegree: '大专', reqYears: '1-3年', reqSkills: ['社群运营', '用户增长', '私域'],
        risks: ['外包 / 派驻岗，需确认用工主体'], pros: [], cons: ['外包性质'],
        keywords: ['社群', '私域'], tags: ['外包'],
        rawJD: '【岗位职责】\n1. 负责社群拉新与留存；\n2. 策划并执行增长活动；\n3. 数据分析与复盘。\n【任职要求】\n1. 大专及以上，1-3 年社群 / 用户运营经验；\n2. 熟悉企业微信私域玩法。\n（注：本岗位为派驻甲方职场，用工主体为人力资源公司）',
      },
      {
        source: 'boss', title: '品牌内容策划', company: '杭州拾贝品牌管理有限公司',
        industry: '消费品', location: '杭州 · 拱墅区', salaryText: '11-16K', salaryMin: 11, salaryMax: 16,
        salaryMonths: 13, benefits: ['五险一金', '双休', '带薪年假'],
        duties: ['品牌内容策略制定', '跨部门协同产出传播物料', 'KOL 内容合作'],
        reqDegree: '本科', reqYears: '3-5年', reqSkills: ['品牌策划', 'KOL', '内容策略'],
        risks: ['要求 3-5 年经验，可能偏高'], pros: ['品牌体系成熟'], cons: ['经验年限要求高'],
        keywords: ['品牌', '内容策划'], tags: [],
        rawJD: '【岗位职责】\n1. 制定品牌内容策略；\n2. 跨部门协同产出传播物料；\n3. 负责 KOL 内容合作。\n【任职要求】\n1. 本科及以上，3-5 年品牌内容经验；\n2. 有消费品行业背景优先。',
      },
    ];

    var ids = [];
    demoJobs.forEach(function (j) {
      var r = addJob(Object.assign({}, j, { createdAt: now }), { forceNew: true });
      ids.push(r.job.id);
    });

    addApplication({ jobId: ids[0], status: 'round1', channel: 'BOSS 直聘', appliedAt: now - 86400000 * 9,
      note: 'HR 回复很快，直接约了一面', hrSummary: 'HR 说团队 6 人，负责两个账号' });
    updateApplication(appOfJob(ids[0]).id, {});
    addApplication({ jobId: ids[2], status: 'offer', channel: 'BOSS 直聘', appliedAt: now - 86400000 * 16,
      note: '已发 offer，薪资 13K × 14 个月', hrSummary: '两轮面试，反馈很快' });
    addApplication({ jobId: ids[3], status: 'rejected', channel: 'BOSS 直聘', appliedAt: now - 86400000 * 20,
      outcome: 'self', note: '确认是外包派驻岗，我主动放弃' });
    addApplication({ jobId: ids[1], status: 'applied', channel: 'BOSS 直聘', appliedAt: now - 86400000 * 2 });

    addInterview({ jobId: ids[0], at: now + 86400000 * 2 + 3600000 * 3, mode: 'offline',
      place: '杭州市西湖区文三路 90 号东部软件园 3 号楼 8 层', interviewers: '运营负责人 + HR',
      round: '一面（技术/业务）', notes: '带上作品集，重点讲 0-1 起号数据' });

    addResume({
      name: '通用版（新媒体 / 短视频运营）', isDefault: true,
      content: '【个人信息】\n姓名：示例\n城市：杭州\n期望岗位：新媒体运营 / 短视频运营\n期望薪资：10-13K\n\n【核心技能】\n- 短视频：抖音、视频号双平台 0-1 起号，选题 / 脚本 / 拍摄 / 剪辑全流程\n- 内容工具：剪映专业版、Photoshop、秀米、稿定\n- AI 提效：Claude、Claude Code、DeepSeek、Midjourney，能把 AI 嵌入内容生产流水线\n- 数据：账号数据看板搭建、爆款拆解\n\n【工作经历】\n某文化传媒 | 短视频运营 | 2023.03-2025.08\n- 从 0 搭建公司抖音号，12 个月做到 8.6 万粉，单条最高 320 万播放\n- 主导视频号同步分发，月均涨粉 2000+\n- 沉淀选题库与 SOP，内容产出效率提升 3 倍\n\n【教育背景】\n某高职院校 | 电子商务 | 大专',
      tags: ['新媒体', '短视频'],
    });
    addResume({
      name: 'AI 运营专项版', isDefault: false,
      content: '【定位】AIGC 内容运营 / AI 提效方向\n\n【差异化能力】\n- 熟练使用 Claude Code、DeepSeek 完成选题生成、脚本批量产出、素材整理\n- 自建提示词库 60+ 条，单条内容生产时间从 90 分钟压缩到 25 分钟\n- 用 Midjourney / 可灵 生成封面与配图，替代外部设计依赖\n\n【可量化产出】\n- 内容月产量从 12 条提升到 40 条\n- 单条内容平均制作成本下降 60%',
      tags: ['AIGC', 'AI 运营'],
    });

    addMaterial({ kind: 'cover', title: 'BOSS 打招呼话术 · 短视频运营版',
      content: '您好，我做过抖音和视频号双平台 0-1 起号，一年做到 8.6 万粉，单条最高 320 万播放。\n看到贵司这个岗位需要独立负责内容全流程，我正好是从选题到剪辑都能自己走通的类型，也沉淀了一套选题库和 SOP。\n方便的话想跟您聊聊账号目前的阶段和接下来的目标，我可以先出一版内容方向的想法。' });
    addMaterial({ kind: 'portfolio', title: '作品集（在线）', url: 'https://example.com/portfolio',
      content: '包含 3 个账号案例、爆款拆解 5 篇、内容 SOP 截图' });

    // 示例对话
    var c = addChat({ kind: 'greeting', title: 'BOSS 打招呼话术', jobId: ids[0] });
    pushMessage(c.id, 'user', '帮我生成一段 BOSS 打招呼话术');
    pushMessage(c.id, 'assistant', '您好，我做过抖音和视频号双平台 0-1 起号……（示例数据，点右上角可清空全部数据重新开始）');

    save(true); fire('all');
    return { jobs: ids.length };
  }

  /* ==================== 多账号（本机沙箱切换，非安全认证） ==================== */
  /**
   * 一个账号 = 一份独立数据（key = jobhunter.db.v1.<账号>）。
   * 「登录 / 切换」只是改数据指针 + 重建 DB，不涉及任何网络或加密。
   * 密码仅做防误操作校验（本地文件本就可读），明文存 localStorage，不加密、不校验强度。
   */

  /** 读账号元数据。返回 { default:'default', list:[{name, createdAt, hasPwd}] } */
  function readAccounts() {
    var meta = null;
    try { meta = global.localStorage.getItem(ACCOUNTS_KEY); } catch (e) { meta = null; }
    var acc = { default: 'default', list: [] };
    if (!meta) return acc;
    try {
      var m = JSON.parse(meta);
      if (m && typeof m === 'object') {
        acc.default = m.default || 'default';
        acc.list = Array.isArray(m.list) ? m.list : [];
      }
    } catch (e) { /* 元数据损坏则当空 */ }
    return acc;
  }

  /** 写账号元数据 */
  function writeAccounts(acc) {
    try {
      global.localStorage.setItem(ACCOUNTS_KEY, JSON.stringify({
        default: acc.default || 'default',
        list: acc.list || [],
      }));
    } catch (e) { /* noop */ }
  }

  /** 校验账号名合法（目录名风格：字母/数字/中文/下划线/短横，去首尾空格，非空） */
  function validAccountName(name) {
    if (!name) return false;
    var s = String(name).trim();
    if (!s) return false;
    if (s.length > 32) return false;
    if (/[\\/:*?"<>|\s]/.test(s)) return false;   // 禁止路径分隔符、通配符、空白
    return true;
  }

  /** 规范化账号名（去空格，转小写兜底 default） */
  function normAccount(name) {
    var s = String(name || '').trim();
    return s || 'default';
  }

  /** 读当前账号指针。缺失/损坏 → default */
  function currentAccount() {
    var n = null;
    try { n = global.localStorage.getItem(CURRENT_KEY); } catch (e) { n = null; }
    var name = normAccount(n);
    return name === 'default' || accountExists(name) ? name : 'default';
  }

  function accountExists(name) {
    return readAccounts().list.some(function (a) { return a.name === name; });
  }

  /** 账号列表（含「是否当前」标记） */
  function listAccounts() {
    var acc = readAccounts();
    var cur = CURRENT_ACCOUNT;
    return acc.list.map(function (a) {
      return { name: a.name, createdAt: a.createdAt || null, hasPwd: !!a.pwd, current: a.name === cur };
    });
  }

  /** 创建账号。返回 {ok, name, error}。密码可选，明文存（仅防误操作）。 */
  function createAccount(name, pwd) {
    if (!validAccountName(name)) {
      return { ok: false, error: '账号名不能为空，且不能包含空格、/ \\ : * ? " < > | 等字符（≤32 字）' };
    }
    var nm = normAccount(name);
    var acc = readAccounts();
    if (acc.list.some(function (a) { return a.name === nm; })) {
      return { ok: false, error: '账号「' + nm + '」已存在，直接切换即可' };
    }
    acc.list.push({ name: nm, createdAt: U.now(), pwd: pwd ? String(pwd) : '' });
    writeAccounts(acc);
    return { ok: true, name: nm };
  }

  /**
   * 切换账号。切换前先 flush 当前数据，再改指针、重建 DB。
   * 返回 {ok, name, error}。调用方成功后应 location.reload() 让整页从新账号重读。
   */
  function switchAccount(name, pwd) {
    var nm = normAccount(name);
    if (!validAccountName(nm)) return { ok: false, error: '账号名不合法' };
    var acc = readAccounts();
    var rec = acc.list.filter(function (a) { return a.name === nm; })[0];
    if (!rec) {
      // 未注册的账号 → 视为「创建并登录」（登录框里输个新名字就直接建）
      var r = createAccount(nm, pwd);
      if (!r.ok) return r;
      rec = acc.list.filter(function (a) { return a.name === nm; })[0] || { name: nm, pwd: pwd || '' };
      acc = readAccounts();
    }
    // 密码校验：设了密码的账号，切换时要求匹配（防误切，非安全认证）
    if (rec.pwd && String(pwd || '') !== String(rec.pwd)) {
      return { ok: false, error: '密码不对（这个账号设了密码，请输入正确密码才能切换）' };
    }

    flush();                                   // 先落盘当前账号
    CURRENT_ACCOUNT = nm;
    try { global.localStorage.setItem(CURRENT_KEY, nm); } catch (e) { /* noop */ }
    DB = null; load();                         // 从新账号的 key 重建
    lastSavedJSON = JSON.stringify(DB);        // 换了数据源 → 基线跟着换
    return { ok: true, name: nm };
  }

  /** 登出：切回 default（default 永远存在，是最低门槛的兜底账号） */
  function logoutAccount() {
    return switchAccount('default');
  }

  /** 删除账号（连同它的数据）。default 不可删。 */
  function deleteAccount(name) {
    var nm = normAccount(name);
    if (nm === 'default') return { ok: false, error: 'default 是兜底账号，不能删除' };
    var acc = readAccounts();
    var before = acc.list.length;
    acc.list = acc.list.filter(function (a) { return a.name !== nm; });
    if (acc.list.length === before) return { ok: false, error: '账号「' + nm + '」不存在' };
    writeAccounts(acc);
    // 删数据（当前账号不能删自己，需先切走；这里允许删非当前账号）
    if (CURRENT_ACCOUNT !== nm) {
      try { global.localStorage.removeItem(KEY_ROOT + '.' + nm); } catch (e) { /* noop */ }
      try { global.localStorage.removeItem(KEY_ROOT + '.' + nm + '.bak'); } catch (e) { /* noop */ }
    }
    return { ok: true };
  }

  /* ==================== 初始化 ==================== */

  /* 迁移过程的记录。以前迁移是**静默**的 —— 旧 key 被删、岗位没了，用户和我都看不到
     任何痕迹（这正是评审 2.4 那个坑能潜伏这么久的原因）。现在每一步都留一条，
     设置页可以展示、测试也能断言。 */
  var migrateNotes = [];
  function noteMigrate(msg) {
    try { migrateNotes.push({ at: U.now(), msg: String(msg) }); } catch (e) { /* noop */ }
    try { console.log('[迁移] ' + msg); } catch (e) { /* noop */ }
  }

  /**
   * 把「老单 key」里的数据**合并**进 default 账号（评审 2.4）。
   *
   * 为什么需要它：老版本迁移原来是
   *   `if (没有 default) { 拷贝 } ; removeItem(老 key)`  ← 删除是**无条件**的。
   * 于是只要 `jobhunter.db.v1.default` 已经有数据（用户先点过新版、或手动操作过），
   * 老单 key 里的岗位就被**直接删掉**，而不是合并进来。用户看到的是"我的岗位没了"，
   * 而且没有报错、没有提示。
   *
   * 现在：两边都有数据 → 合并（按 id 去重，**default 现有数据优先**，老数据里多出来的补进去）；
   * 合并成功才删老 key；合并失败就**保留**老 key（宁可下次再试，也不能删）。
   * 合并前还会把原来那份 default 另存一份 `.premerge`，出问题能找回来。
   */
  function mergeRootIntoDefault(rootRaw, defRaw) {
    var oldDb = migrate(JSON.parse(rootRaw));
    var curDb = migrate(JSON.parse(defRaw));
    var report = { added: 0 };
    // 只按 id 去重：这里的两份数据都来自同一个用户，id 就是唯一真源。
    // 刻意**不做字段级合并** —— 迁移阶段求的是"一条都不丢"，不是"取最新值"。
    ['jobs', 'applications', 'interviews', 'resumes', 'materials', 'chats', 'checks'].forEach(function (coll) {
      var have = {};
      curDb[coll].forEach(function (x) { if (x && x.id) have[x.id] = 1; });
      (oldDb[coll] || []).forEach(function (x) {
        if (x && x.id && !have[x.id]) { curDb[coll].push(x); report.added++; }
      });
    });
    return { json: JSON.stringify(curDb), added: report.added };
  }

  function init() {
    /* 老版本单 key 升级迁移：把「jobhunter.db.v1」里的数据搬进 default 账号。
       ⛔ 关键：default 已经有数据时必须**合并**，而且**合并成功才删老 key**。 */
    try {
      var rootKey = KEY_ROOT;
      var defKey = KEY_ROOT + '.default';
      var rootRaw = global.localStorage.getItem(rootKey);
      if (rootRaw) {
        var defRaw = global.localStorage.getItem(defKey);
        if (!defRaw) {
          global.localStorage.setItem(defKey, rootRaw);          // default 是空的 → 直接搬
        } else {
          try {
            var merged = mergeRootIntoDefault(rootRaw, defRaw);
            global.localStorage.setItem(defKey + '.premerge', defRaw);   // 合并前留底
            global.localStorage.setItem(defKey, merged.json);
            noteMigrate('已把旧版数据合并进 default（多补进 ' + merged.added + ' 条）');
          } catch (e) {
            // 合并失败 → **保留**老 key，绝不删（下次启动还能再试）。宁可留着，也不能丢。
            noteMigrate('旧版数据合并失败，已保留原数据未删除：' + e.message);
            throw e;
          }
        }
        global.localStorage.removeItem(rootKey);
      }
      // 老备份同理：**别覆盖**已有的那份（原来无条件 setItem 会把更新的备份冲掉）
      var obak = global.localStorage.getItem(rootKey + '.bak');
      if (obak) {
        if (!global.localStorage.getItem(defKey + '.bak')) {
          global.localStorage.setItem(defKey + '.bak', obak);
        }
        global.localStorage.removeItem(rootKey + '.bak');
      }
      // 确保 default 账号元数据存在（挪到 if 外面：老 key 不在、但元数据可能也缺）
      if (global.localStorage.getItem(defKey)) {
        var _acc = readAccounts();
        if (!_acc.list.some(function (a) { return a.name === 'default'; })) {
          _acc.list.unshift({ name: 'default', createdAt: U.now(), pwd: '' });
          writeAccounts(_acc);
        }
      }
    } catch (e) { /* 迁移失败不阻断启动 */ }

    CURRENT_ACCOUNT = currentAccount();
    load();
    /* 落盘基线：此刻内存里的规范形态就是磁盘上应当是什么。
       save() 靠它判断「内容有没有真的变」，别删 —— 见 save() 里的短路注释。 */
    lastSavedJSON = JSON.stringify(DB);
    // 关页面 / 切后台前落盘
    global.addEventListener('beforeunload', flush);
    global.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'hidden') flush();
    });
    return DB;
  }

  function raw() { return DB; }

  global.Store = {
    // 常量
    STATUSES: STATUSES, STATUS_MAP: STATUS_MAP, CHAIN: CHAIN,
    CHANNELS: CHANNELS, INTERVIEW_MODES: INTERVIEW_MODES, ROUNDS: ROUNDS,
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    statusName: statusName, statusColor: statusColor, chainIndex: chainIndex,
    roundToStatus: roundToStatus,

    // 生命周期
    init: init, raw: raw, save: save, flush: flush, subscribe: subscribe, fire: fire,
    applyExternal: applyExternal,
    blank: blank, migrate: migrate,
    get persistOK() { return persistOK; },
    // 迁移记录 + 迁移合并函数（测试要能直接驱动「default 已有数据时怎么合并」）
    get migrateNotes() { return migrateNotes.slice(); },
    mergeRootIntoDefault: mergeRootIntoDefault,
    get persistError() { return persistError; },

    // 多账号（本机沙箱切换）
    currentAccount: currentAccount, listAccounts: listAccounts,
    createAccount: createAccount, switchAccount: switchAccount,
    logoutAccount: logoutAccount, deleteAccount: deleteAccount,
    validAccountName: validAccountName,

    // 岗位
    jobs: jobs, job: job, addJob: addJob, addJobs: addJobs,
    updateJob: updateJob, removeJob: removeJob,
    removeJobs: removeJobs, updateJobs: updateJobs, toggleJobFlag: toggleJobFlag,
    addJobTag: addJobTag, removeJobTag: removeJobTag, allTags: allTags,
    renameTag: renameTag, dropTag: dropTag,
    jobDedupeKey: jobDedupeKey, mergeJobInto: mergeJobInto,

    // S1 · 采集冲突台账
    conflicts: conflicts, conflictCount: conflictCount,
    dismissConflict: dismissConflict, clearConflicts: clearConflicts,
    recordConflicts: recordConflicts,

    // 可撤销删除
    takeOut: takeOut, putBack: putBack,

    // 投递
    applications: applications, application: application, appOfJob: appOfJob,
    addApplication: addApplication, updateApplication: updateApplication,
    moveApplication: moveApplication, removeApplication: removeApplication,
    recordBossVisit: recordBossVisit, markAppliedByUser: markAppliedByUser,
    bossJobIdOf: bossJobIdOf,
    hasApplied: hasApplied, reachedIndex: reachedIndex,

    // 面试
    interviews: interviews, interview: interview, addInterview: addInterview,
    updateInterview: updateInterview, removeInterview: removeInterview,
    upcomingInterviews: upcomingInterviews,

    // 简历 / 素材 / 对话
    resumes: resumes, resume: resume, defaultResume: defaultResume, addResume: addResume,
    updateResume: updateResume, removeResume: removeResume,
    materials: materials, material: material, addMaterial: addMaterial,
    updateMaterial: updateMaterial, removeMaterial: removeMaterial,
    chats: chats, chat: chat, addChat: addChat, updateChat: updateChat,
    pushMessage: pushMessage, removeChat: removeChat,

    // 公司背调档案
    checks: checks, check: check, checkByCompany: checkByCompany,
    checkKey: checkKey, addCheck: addCheck, upsertCheck: upsertCheck,
    updateCheck: updateCheck, removeCheck: removeCheck,

    // 统计 / 备份
    stats: stats, replyStats: replyStats, exportObject: exportObject, importObject: importObject,
    clearAll: clearAll, usage: usage, loadDemo: loadDemo,

    // 稍后提醒 / 备份台账
    snooze: snooze, isSnoozed: isSnoozed, wakeUp: wakeUp,
    markExported: markExported, daysSinceExport: daysSinceExport,

    // 设置
    settings: function () { return DB.settings; },
    setSetting: function (path, val) {
      var parts = path.split('.'), o = DB.settings;
      for (var i = 0; i < parts.length - 1; i++) o = o[parts[i]] = o[parts[i]] || {};
      o[parts[parts.length - 1]] = val;
      save(); fire('settings');
    },
  };
})(window);
