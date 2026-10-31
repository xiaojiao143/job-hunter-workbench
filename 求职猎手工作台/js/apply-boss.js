/* ==========================================================================
   apply-boss.js · 模块：从岗位库触达 BOSS（跳转 / 半自动打招呼 / 同步回复）
   --------------------------------------------------------------------------
   三个阶段，风险从低到高，后两个**默认关闭**、必须用户手动开：

     阶段 1（永远可用 · 零风险）
       「🚀 去 BOSS 投递」= 新标签打开岗位的 BOSS 详情页，投递动作完全由人来做。
       点击会记一条 todo（只是「打开过」，不计入投递统计）。
       → 用户回来点「我已投了」，才推进到 applied。

     阶段 2（永远可用）
       「我已投了」= 确认投递，写入 appliedAt。
       待跟进页会**自动**在达到阈值（设置里的 followUp.appliedDays）后把它捞出来。
       ⚠️ 这里刻意**不做 snooze**：snooze 的语义是「别烦我」，用它去"安排"跟进
          会把这条从待跟进页藏起来，正好和用户想要的相反。

     阶段 3（需开 autoGreet 开关）
       「⚡ 一键打招呼」= 让采集器驱动真实浏览器点「立即沟通」并发送招呼语。
       ⚠️ 不可逆：消息发出撤不回、BOSS 每天沟通条数有限。
       服务端有六道闸门（见 采集器/server.py 的 apply_one）。

     阶段 4（需开 syncReply 开关）
       「同步回复/邀约」= 读 BOSS 聊天列表，产出**候选**。
       ⚠️ 候选一律要用户逐条确认才写库，绝不自动写。
   ========================================================================== */
(function (global) {
  'use strict';

  var U = global.U;

  /* ==================== 基础：链接 ==================== */

  /** 这个岗位有没有可跳转的 BOSS 链接（手动新增的多半没有） */
  function hasUrl(job) {
    return !!(job && typeof job.url === 'string' && /^https?:\/\//i.test(job.url.trim()));
  }

  /** 岗位的 BOSS 链接（没有就空串）。 */
  function urlOf(job) {
    return hasUrl(job) ? job.url.trim() : '';
  }

  /** 岗位的 BOSS 职位 ID（先读落库字段，没有再从 url 现解析一次兜底）。 */
  function jobIdOf(job) {
    if (!job) return '';
    if (job.encryptJobId) return job.encryptJobId;
    return Store.bossJobIdOf ? Store.bossJobIdOf(job.url) : '';
  }

  /* ==================== 开关 ==================== */

  function bossCfg() {
    return (Store.settings() || {}).boss || {};
  }
  function autoGreetOn() { return !!bossCfg().autoGreet; }
  function syncReplyOn() { return !!bossCfg().syncReply; }
  function greetIntervalSec() {
    var v = bossCfg().greetIntervalSec;
    return typeof v === 'number' && v >= 0 ? v : 20;
  }
  function greetCooldownH() {
    var v = bossCfg().greetCooldownH;
    return typeof v === 'number' && v > 0 ? v : 24;
  }
  function setAutoGreet(on) {
    Store.setSetting('boss.autoGreet', !!on);
    syncGreetConf();          // ⛔ 开关一变就同步给服务端，别让服务端读着一份过期配置
  }
  function setSyncReply(on) { Store.setSetting('boss.syncReply', !!on); }

  /**
   * 把「一键打招呼」的开关 / 间隔 / 冷却 / 单日上限同步给服务端落盘。
   *
   * ⛔ 为什么必须同步（评审 P1-5）：
   *   服务端那道闸门要能**自己**读到开关，否则「服务端会独立再查一遍」就只是注释里的
   *   空话 —— 这套配置本来只活在 localStorage 里，服务端读不到，结果就是
   *   「开关关着，照样能用接口把招呼发出去」。真正的限流必须长在服务端。
   *   调用时机：① 应用启动（app.js）② 用户改这几个设置时（view-settings.js）。
   *   同步失败**不弹提示**：服务端会给出一句可操作的说明（刷新页面即可），
   *   在这里再弹一次只会变成噪音。
   */
  function syncGreetConf() {
    var cfg = bossCfg();
    var daily = cfg.greetDailyCap;
    return req('/api/greet-conf', {
      method: 'POST',
      timeout: 8000,
      json: {
        autoGreet: autoGreetOn(),
        intervalSec: greetIntervalSec(),
        cooldownH: greetCooldownH(),
        dailyCap: (typeof daily === 'number' && daily > 0) ? daily : 20,
      },
    }).then(function (d) { return !!(d && d.ok); },
            function () { return false; });     // 连不上服务端 = 没同步，不是错误
  }

  /* 「打招呼 / 同步回复」用哪个浏览器（见 store.js 的 boss.browserMode）。
     ⛔ 不认识的值一律收敛成 own —— 别让一个脏设置把请求送到一个跑不起来的模式上。
     默认 own 是刻意的：daily 要求「先彻底退出 Edge」，默认打开会让第一次用的人
     直接撞上「点了没反应」，反而像工具坏了。 */
  function browserMode() {
    return bossCfg().browserMode === 'daily' ? 'daily' : 'own';
  }
  function setBrowserMode(v) {
    Store.setSetting('boss.browserMode', v === 'daily' ? 'daily' : 'own');
  }
  function browserModeLabel() {
    return browserMode() === 'daily' ? '你平时的 Edge' : '工作台自己的浏览器';
  }

  /* ==================== 阶段 1：去 BOSS 投递 ==================== */

  /**
   * 纯计算：这次点击能不能跳。
   * 返回 { ok, url, reason } —— reason 是给人看的中文原因（ok=false 时非空）。
   * 抽成纯函数是为了单测能直接喂各种脏数据，不用真去开窗口。
   */
  function canOpen(job) {
    if (!job) return { ok: false, url: '', reason: '岗位不存在' };
    if (!hasUrl(job)) {
      return { ok: false, url: '',
        reason: '这个岗位没有 BOSS 链接' +
          (job.source === 'manual' ? '（手动新增的岗位本来就没有）' : '（采集时没拿到）') };
    }
    var id = jobIdOf(job);
    // 有 url 但抠不出职位 ID：多半不是 BOSS 的职位详情页 —— 提醒但仍允许打开，
    // 因为用户可能自己粘了个别的链接（比如官网投递页）。只是不让它走自动流程。
    if (!id) return { ok: true, url: urlOf(job), reason: '链接里没有职位 ID，只能手动投' };
    return { ok: true, url: urlOf(job), reason: '' };
  }

  /**
   * 打开 BOSS 详情页 + 记一笔「打开过」。
   * ⚠️ 用 window.open 而不是 location.href：不能让用户丢掉当前工作台（筛选条件、滚动位置）。
   */
  function openOnBoss(job, onChange) {
    var c = canOpen(job);
    if (!c.ok) { U.toast(c.reason, 'bad', 3200); return false; }
    var w = global.open(c.url, '_blank', 'noopener');
    // 有些浏览器/沙箱会拦弹窗 → 别假装成功
    if (!w) {
      U.toast('浏览器拦了新标签页。请允许本站弹出窗口，或直接右键复制链接打开。', 'bad', 4000);
      return false;
    }
    try { w.opener = null; } catch (e) { /* 跨源时拿不到 opener，忽略 */ }
    if (c.reason) U.toast(c.reason, 'warn', 3000);
    Store.recordBossVisit(job.id);
    U.toast('已在新标签页打开 BOSS 岗位页。投完回来点「我已投了」记一笔 ✅', 'ok', 3600);
    onChange && onChange();
    return true;
  }

  /* ==================== 阶段 2：确认投递 ==================== */

  /** 用户从 BOSS 回来点「我已投了」。幂等（已经是 applied 就只提示一下）。 */
  function confirmApplied(job, onChange) {
    if (!job || !job.id) { U.toast('岗位不存在', 'bad'); return null; }
    var before = Store.appOfJob(job.id);
    var a = Store.markAppliedByUser(job.id);
    if (!a) { U.toast('记录投递失败（岗位 ID 异常）', 'bad'); return null; }
    if (before && before.status === 'applied') {
      U.toast('这个岗位已经是「已投递」了', 'info', 2400);
    } else {
      var d = (Store.settings().followUp || {}).appliedDays;
      d = (typeof d === 'number' && d > 0) ? d : 5;
      U.toast('已记为投递 ✅　' + d + ' 天后还没动静，它会自己出现在「待跟进」里', 'ok', 4200);
    }
    onChange && onChange();
    return a;
  }

  /* ==================== 阶段 3：一键打招呼（需开关） ==================== */

  /**
   * 纯计算：这个岗位现在能不能「一键打招呼」。
   * 与服务端闸门**故意做两遍**（前端先拦是为了少开一次浏览器；服务端那道才是真闸门，
   * 因为前端可以绕过）。返回 { ok, reason }。
   */
  function canAutoGreet(job, ts) {
    if (!autoGreetOn()) return { ok: false, reason: '「一键打招呼」开关没开（设置页可开）' };
    if (!job) return { ok: false, reason: '岗位不存在' };
    if (!hasUrl(job)) return { ok: false, reason: '这个岗位没有 BOSS 链接，去不了' };
    if (!jobIdOf(job)) return { ok: false, reason: '链接里没有职位 ID，没法定位到具体岗位' };

    var cdH = greetCooldownH();
    var last = job.greetAt || 0;
    if (last && (ts - last) < cdH * 3600000) {
      var leftH = Math.ceil((cdH * 3600000 - (ts - last)) / 3600000);
      return { ok: false, reason: '这个岗位 ' + cdH + ' 小时内已经打过招呼了（还有约 ' + leftH + ' 小时）' };
    }
    return { ok: true, reason: '' };
  }

  /** 两次自动打招呼之间的最小间隔（同一个工作台内，跨刷新生效）。 */
  function greetGapLeft(ts) {
    var last = bossCfg().lastGreetAt || 0;
    if (!last) return 0;
    var left = greetIntervalSec() * 1000 - (ts - last);
    return left > 0 ? left : 0;
  }

  /** 招呼语：优先用户现填，其次岗位上存的 AI 话术。都没有 → 空串（服务端会拒发）。 */
  function greetingFor(job, typed) {
    var s = String(typed || '').trim();
    if (s) return s;
    return String((job && job.aiGreeting) || '').trim();
  }

  /**
   * 真正发起「一键打招呼」。**这是不可逆动作**，所以：
   *   · 调用前必须已经过二次确认（UI 层做）
   *   · 失败**绝不重试**（重试 = 白耗一条沟通额度）
   *   · 无论成败都写时间线，注明是自动发的
   */
  function doAutoGreet(job, typed, hooks) {
    hooks = hooks || {};
    var ts = U.now();
    var gate = canAutoGreet(job, ts);
    if (!gate.ok) { hooks.onFail && hooks.onFail(gate.reason); return Promise.resolve({ ok: false, error: gate.reason }); }

    var gap = greetGapLeft(ts);
    if (gap > 0) {
      var r = '两次打招呼至少间隔 ' + greetIntervalSec() + ' 秒，还要等 ' + Math.ceil(gap / 1000) + ' 秒';
      hooks.onFail && hooks.onFail(r);
      return Promise.resolve({ ok: false, error: r });
    }

    var text = greetingFor(job, typed);
    if (!text) {
      var r2 = '没有招呼语 —— 先写一句，或在岗位详情里生成话术';
      hooks.onFail && hooks.onFail(r2);
      return Promise.resolve({ ok: false, error: r2 });
    }
    if (text.length > 500) {
      var r3 = '招呼语太长了（' + text.length + ' 字），BOSS 聊天框会截断，压到 500 字以内';
      hooks.onFail && hooks.onFail(r3);
      return Promise.resolve({ ok: false, error: r3 });
    }

    // ⛔ 冷却标记**不能在这里写**（评审核实 2026-10-12，P2-18 的真凶）：
    //   `boss.lastGreetAt` 是「两次打招呼的最小间隔」，`job.greetAt` 是该岗位的 24h 冷却。
    //   以前它们（还有下面那次 recordBossVisit）写在**请求发出之前**，于是任何一次失败
    //   —— 服务端拒发、没登录态、脚本缺失 —— 都会把岗位锁死 24 小时，
    //   还凭空造出一条「打开过」的投递记录。只有真的发出去了才该记账（见下面的 ok 分支）。
    hooks.onStart && hooks.onStart(text);

    return req('/api/apply-one', {
      method: 'POST',
      json: { jobId: jobIdOf(job), url: urlOf(job), greeting: text, title: job.title || '', company: job.company || '',
              browserMode: browserMode() },
      /* ⛔ 前端超时必须 > 服务端 APPLY_WAIT_SEC（420 秒）+ 余量（评审核实 2026-10-30，P0）。
         以前写 180000 → 180 秒一到前端先报「发送失败」，但服务端那边还在等浏览器
         把消息发出去（最多 420 秒）。结果是「前端报失败、消息其实已发出」→ 用户手动
         重试 = 对同一个 HR 连发两条招呼，白耗一条沟通额度。改成 480 秒，宁等不误报。 */
      timeout: 480000,
    }).then(function (d) {
      var ok = !!(d && d.ok);
      if (ok) {
        // 只有发送成功才更新「间隔 / 岗位冷却」两个计时器
        Store.setSetting('boss.lastGreetAt', U.now());
        Store.updateJob(job.id, { greetAt: U.now() });
      }
      // 时间线照写（docstring 的承诺）—— 但失败时**不再**凭空造记录：
      // 已经有投递记录就补一条失败说明；没有就不新建（没发出去 = 没有这次投递）
      var a = Store.appOfJob(job.id) || (ok ? Store.recordBossVisit(job.id) : null);
      if (a) {
        Store.updateApplication(a.id, {
          statusNote: ok ? '自动打招呼已发送' : '自动打招呼失败：' + ((d && d.error) || '未知原因'),
        });
      }
      if (ok) {
        // 招呼语发出去 = 已经沟通上了。推到 viewed？不 —— 那是「HR 看过」的意思，
        // 不能自己冒充。保持原状态，只由用户在收到回复后手动推进。
        U.toast('招呼语已发送 ✅　HR 回复后记得在投递面板推进状态', 'ok', 4200);
      } else {
        U.toast('发送失败：' + ((d && d.error) || '未知原因'), 'bad', 5200);
      }
      hooks.onDone && hooks.onDone(d);
      return d;
    }, function (e) {
      var msg = (e && e.message) || '请求失败';
      U.toast('发送失败：' + msg, 'bad', 5200);
      hooks.onDone && hooks.onDone({ ok: false, error: msg });
      return { ok: false, error: msg };
    });
  }

  /* ==================== 阶段 4：同步回复 / 邀约（需开关） ==================== */

  /**
   * 拉一次 BOSS 聊天列表，产出**候选**（不写库）。
   * 每条候选带 confidence：high 表示岗位能唯一匹配上，low 表示靠名字模糊匹配、要人确认。
   */
  function fetchReplyCandidates() {
    if (!syncReplyOn()) {
      return Promise.resolve({ ok: false, error: '「同步回复」开关没开（设置页可开）' });
    }
    return req('/api/sync-reply', { method: 'POST', json: { browserMode: browserMode() }, timeout: 480000 })
      .then(function (d) { return d || { ok: false, error: '空响应' }; },
        function (e) { return { ok: false, error: (e && e.message) || '请求失败' }; });
  }

  /** 用候选人名 + 公司名去本地岗位库里找最可能的那个岗位。找不到返回 null。 */
  function matchJob(cand, jobs) {
    if (!cand) return null;
    var cname = String(cand.company || '').trim();
    var jid = String(cand.jobId || '').trim();
    if (!jobs || !jobs.length) return null;
    // 1) 职位 ID 精确命中 —— 最可靠
    if (jid) {
      var byId = jobs.filter(function (j) { return jobIdOf(j) === jid; })[0];
      if (byId) return byId;
    }
    // 2) 公司名完全相同 —— 也够可靠
    if (cname) {
      var byCo = jobs.filter(function (j) { return String(j.company || '').trim() === cname; });
      if (byCo.length === 1) return byCo[0];
      // 多家同名公司：挑唯一一条投递过的，其余情况不敢猜
      if (byCo.length > 1) {
        var withApp = byCo.filter(function (j) { return !!Store.appOfJob(j.id); });
        if (withApp.length === 1) return withApp[0];
      }
    }
    return null;
  }

  /**
   * 纯计算：把服务端返回的原始候选，整理成**待用户逐条确认**的行。
   *
   * 关键设计：每行的 `action` 默认是 **'ignore'**。
   * 不是"自动猜一个动作让你取消"，而是"默认什么都不做，你要它做什么就点什么"。
   * 这是「保守」的具体落地 —— 错误的自动更新会污染投递统计和面试安排，
   * 而这两样东西恰恰是用户拿来复盘求职效果的全部依据。
   */
  function planSyncActions(items, jobs) {
    var list = Array.isArray(items) ? items : [];
    var pool = Array.isArray(jobs) ? jobs : Store.jobs();
    return list.map(function (raw, i) {
      var it = raw || {};
      var hit = matchJob(it, pool);
      var app = hit ? Store.appOfJob(hit.id) : null;
      return {
        idx: i,
        company: String(it.company || '').trim(),
        hr: String(it.hr || '').trim(),
        lastText: String(it.lastText || '').trim(),
        unread: !!it.unread,
        at: it.at || null,
        invited: !!it.invited,                       // 采集侧判定的「疑似邀约」
        jobId: hit ? hit.id : '',
        jobTitle: hit ? (hit.title || '') : '',
        matched: !!hit,
        // 匹配不到岗位 → 只能忽略；匹配到了也默认忽略，由用户挑
        action: 'ignore',
        makeInterview: false,
        // 已经有投递记录且已经推进到更远的状态 → 提示用户不必再动
        curStatus: app ? app.status : '',
        curIndex: app ? Store.reachedIndex(app) : -1,
      };
    });
  }

  /**
   * 执行用户逐条确认后的写入。**只有这里会真的改数据。**
   * rows: planSyncActions 的结果；decisions: { <idx>: 'ignore'|'viewed'|'invited' }
   * 返回 { updated, interviewed, skipped, details }。
   */
  function applySyncPlan(rows, decisions) {
    decisions = decisions || {};
    var out = { updated: 0, interviewed: 0, skipped: 0, details: [] };
    (rows || []).forEach(function (r) {
      var act = decisions[r.idx] || 'ignore';
      if (act === 'ignore') return;
      if (!r.jobId) { out.skipped++; out.details.push(r.company + '：没匹配到本地岗位，跳过'); return; }
      var app = Store.appOfJob(r.jobId);
      if (!app) {
        // 从没投过这个岗位 → 不能凭一条聊天记录就认定"投过"
        out.skipped++;
        out.details.push((r.jobTitle || r.company) + '：本地没有投递记录，跳过（先去 BOSS 投了再记）');
        return;
      }
      var target = act === 'invited' ? 'invited' : 'viewed';
      var ti = Store.chainIndex(target);
      // 不要因为一次同步把用户手动推进得更远的状态**倒退**回去
      var cur = Store.reachedIndex(app);
      if (cur >= ti) {
        out.skipped++;
        out.details.push((r.jobTitle || r.company) + '：已经是「' + Store.statusName(app.status) + '」或更靠后，没动它');
      } else {
        Store.updateApplication(app.id, {
          status: target,
          statusNote: '从 BOSS 同步：' + (act === 'invited' ? '收到邀约' : '已有回复') +
            (r.lastText ? '（最新消息：' + r.lastText.slice(0, 40) + '）' : ''),
        });
        out.updated++;
      }
      if (act === 'invited' && r.makeInterview) {
        var exist = Store.interviews({ jobId: r.jobId }).some(function (v) { return v.status === 'scheduled'; });
        if (exist) {
          out.details.push((r.jobTitle || r.company) + '：已经有待安排的面试，没重复建');
        } else {
          Store.addInterview({
            jobId: r.jobId, appId: app.id, at: null, status: 'scheduled',
            /* ⚠️ round 刻意不写「一面」：一条聊天消息里**读不出**这是第几轮面试。
               写死「一面」会经 store.autoSyncInterview → roundToStatus 把投递状态
               从「邀约」直接推到「一面」，而面试连时间都还没定 —— 那是把进度说过头了，
               会污染漏斗和回复率。用「待定」则 roundToStatus 返回 invited，
               状态停在「邀约」，等用户在面试管理里填了真实轮次再推进。 */
            round: '待定',
            notes: '从 BOSS 同步的邀约，具体时间待定' + (r.hr ? '（HR：' + r.hr + '）' : ''),
          });
          out.interviewed++;
        }
      }
    });
    return out;
  }

  /* ==================== 复用工作台自己的 req ==================== */

  /**
   * 借采集页那套请求封装（自带 X-JH-Token、超时、错误归一）。
   * 这里**必须复用**而不是自己写 fetch —— 自己写十有八九会漏带令牌，
   * 然后表现为「接口 403」这种看不出原因的失败。
   */
  function req(path, opt) {
    var VC = global.Views && global.Views.collect;
    if (VC && typeof VC._req === 'function') return VC._req(path, opt);
    // 采集器模块没加载 / 没在运行：给一句能照着做的话，而不是静默挂住
    return Promise.resolve({
      ok: false,
      error: '采集器模块没就绪 —— 请用「启动采集器」方式打开工作台，这两个功能都要它代劳。',
    });
  }

  global.ApplyBoss = {
    // 链接
    hasUrl: hasUrl, urlOf: urlOf, jobIdOf: jobIdOf, canOpen: canOpen,
    // 开关
    autoGreetOn: autoGreetOn, syncReplyOn: syncReplyOn,
    setAutoGreet: setAutoGreet, setSyncReply: setSyncReply,
    syncGreetConf: syncGreetConf,
    greetIntervalSec: greetIntervalSec, greetCooldownH: greetCooldownH,
    // 用哪个浏览器（第 28 轮）
    browserMode: browserMode, setBrowserMode: setBrowserMode,
    browserModeLabel: browserModeLabel,
    // 阶段 1/2
    openOnBoss: openOnBoss, confirmApplied: confirmApplied,
    // 阶段 3
    canAutoGreet: canAutoGreet, greetGapLeft: greetGapLeft, greetingFor: greetingFor, doAutoGreet: doAutoGreet,
    // 阶段 4
    fetchReplyCandidates: fetchReplyCandidates, matchJob: matchJob,
    planSyncActions: planSyncActions, applySyncPlan: applySyncPlan,
  };
})(window);
