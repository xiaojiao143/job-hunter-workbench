/**
 * AI 采集清洗（P0）—— 对**已采集**的岗位做 AI 判断，不改采集链路。
 *
 * 为什么单独一个文件：
 *   1. 采集页 view-collect.js 已经 4483 行，再往里塞 AI 逻辑会失控；
 *   2. 核心测试按 index.html 顺序全量加载，新文件必须**自包含**（不依赖加载顺序）；
 *   3. 出问题时能整文件关掉（index.html 删一行），采集链路零影响。
 *
 * ⛔ 铁律：本文件**只读** job 对象、**不写库**、**不删任何数据**。
 *   判定结果挂在 `job.aiCollect` 上，由 UI 按它过滤 —— 随时能一键放回全部。
 *   理由：AI 会误判，而"误判 + 物理删除"= 用户永远不知道丢了什么。
 *
 * ⛔ 降级：没配模型接口（AI.ready() 为 false）时，所有按钮灰掉、函数 reject，
 *   原有采集/评分链路完全不受影响。
 */
(function (global) {
  'use strict';

  /* ---------- 成本常量 ---------- */

  /** 每批送多少条岗位给模型。20 是「上下文够长、又不会一次吐太多 JSON」的折中 */
  var BATCH_SIZE = 20;
  /** 每条岗位结果的经验输出 token（verdict + tags + mustHave + reason） */
  var OUT_TOKENS_PER_JOB = 45;
  /** 单次批量清洗超过这个金额（元）就先弹确认框 */
  var COST_WARN_YUAN = 0.5;
  /** JD 截断长度：给模型看开头就够了，避免长 JD 把上下文吃满 */
  var JD_SLICE = 400;

  /* ---------- 提示词 ---------- */

  var SYS =
    '你是求职岗位筛选助手。用户会给你一批岗位摘要和求职者方向，逐条判断。\n\n' +
    '1. 只依据给到的信息判断。信息不足（JD 为空或太短）就填 uncertain，**不要猜**。\n' +
    '2. verdict 只有三个值：relevant（方向对口）/ irrelevant（明显不对口）' +
    '/ uncertain（信息不足或边界情况）。\n' +
    '3. tags 从这些里选（可多选，没有就空数组）：外包嫌疑 / 派遣 / 急招 / 大厂 / 初创' +
    '/ 远程 / 销售岗 / 技术岗 / 国企 / 驻场。只有原文有依据才打标。\n' +
    '4. mustHave 是**硬性门槛**（学历/年限/必备技能），从 JD 原文抄，不要自己编。\n' +
    '5. reason 控制在 20 字内，写清判断依据。\n' +
    '6. 严格只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。\n' +
    '7. 全部输出用简体中文。';

  function userPrompt(input) {
    return '求职者方向：' + (input.direction || '未提供') + '\n' +
      '期望城市：' + (input.cities || '未提供') + '\n' +
      '期望薪资：' + (input.salary || '未提供') + '\n\n' +
      '岗位列表（JSON 数组，每条有 idx / title / company / jd）：\n' +
      JSON.stringify(input.jobs) + '\n\n' +
      '请按下面格式输出（results 必须与输入条数一致，idx 一一对应）：\n' +
      '{"results":[{"idx":0,"verdict":"relevant|irrelevant|uncertain",' +
      '"tags":["外包嫌疑"],"mustHave":["3年经验","Python"],' +
      '"reason":"20字内依据"}]}';
  }

  /* ---------- 内部工具 ---------- */

  function AI_() { return global.AI; }
  function U_() { return global.U; }

  /** 岗位对象 → 送模型的紧凑摘要（压 token：只留 title/company/jd） */
  function compact(j, i) {
    var U = U_();
    return {
      idx: i,
      title: String(j.title || j['职位'] || '').trim(),
      company: String(j.company || j['公司'] || '').trim(),
      jd: U.truncate(String(j.rawJD || j['岗位要求和职责'] || ''), JD_SLICE),
    };
  }

  /**
   * 从采集配置里拼出「求职者方向」。
   * ⛔ 不新造配置项：全部读已有 prefs（见 js/store.js 的 DEFAULT_SETTINGS.prefs），
   *   没有就留空 —— 让模型按 uncertain 处理，而不是拿默认值硬判。
   */
  function profileOf(opt) {
    var Store = global.Store;
    var p = (Store && Store.settings && (Store.settings().prefs || {})) || {};
    opt = opt || {};
    var kws = U_().asArray(p.focusKeywords);
    if (!kws.length) {
      // 兜底：期望岗位（从 BOSS 岗位树选的，见 js/job-taxonomy.js）
      kws = U_().asArray(p.expectJobs);
    }
    var cities = U_().asArray(p.cities);
    var sal = '';
    if (p.salaryMin !== null && p.salaryMin !== undefined && p.salaryMin !== '') {
      sal = String(p.salaryMin) + 'K';
      if (p.salaryMax !== null && p.salaryMax !== undefined && p.salaryMax !== '') {
        sal += '-' + String(p.salaryMax) + 'K';
      }
    }
    return {
      direction: kws.join('、'),
      cities: cities.join('、'),
      salary: sal,
    };
  }

  /**
   * 估算一批的 token 与费用。
   * ⚠️ 必须与 splitBatches + callModel **同一套拼装**，否则估的是另一个提示词。
   */
  function estimateBatch(jobs, profile) {
    var AI = AI_();
    var input = {
      direction: profile.direction,
      cities: profile.cities,
      salary: profile.salary,
      jobs: jobs.map(compact),
    };
    var inT = AI.estTokens(SYS + userPrompt(input));
    var outT = OUT_TOKENS_PER_JOB * jobs.length;
    return AI.costOf(inT, outT);
  }

  function splitBatches(list, size) {
    var out = [];
    for (var i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
    return out;
  }

  /**
   * 整批的成本（所有批次加起来）。
   * 注意：分批的提示词里岗位数更少，所以逐批算再求和比一次性算更准。
   */
  function estimateAll(list, profile) {
    var batches = splitBatches(list, BATCH_SIZE);
    var inT = 0, outT = 0, cost = 0, priceFrom = '', priceIn = 0, priceOut = 0;
    batches.forEach(function (b) {
      var r = estimateBatch(b, profile);
      inT += r.inT; outT += r.outT; cost += r.cost;
      priceFrom = r.priceFrom; priceIn = r.priceIn; priceOut = r.priceOut;
    });
    return {
      jobs: list.length, batches: batches.length,
      inT: inT, outT: outT, cost: cost,
      priceFrom: priceFrom, priceIn: priceIn, priceOut: priceOut,
    };
  }

  /** 一次模型调用，返回 [{idx, verdict, tags, mustHave, reason}] */
  function callModel(batch, profile, onUsage) {
    var AI = AI_();
    var input = {
      direction: profile.direction,
      cities: profile.cities,
      salary: profile.salary,
      jobs: batch.map(compact),
    };
    return AI.chat({
      messages: [
        { role: 'system', content: SYS },
        { role: 'user', content: userPrompt(input) },
      ],
      json: true,
      temperature: 0,
      onUsage: onUsage,
    }).then(function (text) {
      var data = U_().extractJSON(text);
      if (!data || !Array.isArray(data.results)) {
        throw new Error('模型返回的不是预期的 JSON 结构');
      }
      return data.results;
    });
  }

  /** 把一条模型结果并回岗位对象（**不改原对象**，返回副本） */
  function mergeOne(job, r) {
    var out = {};
    Object.keys(job).forEach(function (k) { out[k] = job[k]; });
    r = r || {};
    var verdict = String(r.verdict || '').toLowerCase();
    if (['relevant', 'irrelevant', 'uncertain'].indexOf(verdict) < 0) verdict = 'uncertain';
    out.aiCollect = {
      verdict: verdict,
      tags: U_().asArray(r.tags),
      mustHave: U_().asArray(r.mustHave),
      reason: String(r.reason || ''),
      at: Date.now(),
    };
    return out;
  }

  /**
   * 对一批岗位跑 AI 清洗。
   * @param {Array} jobs
   * @param {Object} [opt] {onProgress(done,total), onUsage(u), signal}
   * @returns Promise<{jobs, usage, failed}>
   *   失败**不抛**整体：某一批挂了就那批保持原样（返回的 job 没有 aiCollect），
   *   其余批次照常返回。这样一次网络抖动不会让几十条结果白判。
   */
  function clean(jobs, opt) {
    var AI = AI_();
    opt = opt || {};
    jobs = (jobs || []).slice();
    if (!jobs.length) return Promise.resolve({ jobs: [], usage: null, failed: 0 });

    // ⛔ 没配模型 → 直接 reject 一个**带 code** 的错，调用方据此给「去设置」引导
    if (!AI || !AI.ready()) {
      var e = new Error('还没配置模型接口，AI 清洗用不了。去「设置 → ① 大模型接口」填好 API Key。');
      e.code = 'NO_CONFIG';
      return Promise.reject(e);
    }

    var profile = profileOf(opt);
    var batches = splitBatches(jobs, BATCH_SIZE);
    var out = jobs.slice();
    var done = 0, failed = 0;
    var usage = { inT: 0, outT: 0, cost: 0 };

    // 串行跑：并发会把同一 key 打到限流，而且进度条会乱跳
    var chain = Promise.resolve();
    batches.forEach(function (batch, bi) {
      chain = chain.then(function () {
        if (opt.signal && opt.signal.aborted) throw { __abort: true };
        return callModel(batch, profile, function (u) {
          if (u) {
            usage.inT += (u.prompt_tokens || 0);
            usage.outT += (u.completion_tokens || 0);
          }
          if (opt.onUsage) opt.onUsage(u);
        }).then(function (results) {
          var byIdx = {};
          results.forEach(function (r) {
            if (r && typeof r.idx === 'number') byIdx[r.idx] = r;
          });
          batch.forEach(function (job, i) {
            var globalIdx = bi * BATCH_SIZE + i;
            out[globalIdx] = mergeOne(job, byIdx[i]);
          });
        }).catch(function (err) {
          // 单批失败：保留原样，继续下一批。整轮结束时用 failed 告诉用户。
          if (err && err.__abort) throw err;
          failed++;
        }).then(function () {
          done++;
          if (opt.onProgress) opt.onProgress(done, batches.length);
        });
      });
    });

    return chain.then(function () {
      usage.cost = AI.costOf(usage.inT, usage.outT).cost;
      return { jobs: out, usage: usage, failed: failed };
    }).catch(function (err) {
      if (err && err.__abort) {
        var e2 = new Error('已取消');
        e2.code = 'ABORTED';
        throw e2;
      }
      throw err;
    });
  }

  /** 统计判定分布，给 UI 画摘要用 */
  function summarize(jobs) {
    var s = { total: 0, relevant: 0, irrelevant: 0, uncertain: 0, tagged: 0 };
    (jobs || []).forEach(function (j) {
      if (!j || !j.aiCollect) return;
      s.total++;
      var v = j.aiCollect.verdict;
      if (v === 'relevant') s.relevant++;
      else if (v === 'irrelevant') s.irrelevant++;
      else s.uncertain++;
      if ((j.aiCollect.tags || []).length) s.tagged++;
    });
    return s;
  }

  /** 某个岗位是否有 AI 结论 */
  function hasVerdict(j) { return !!(j && j.aiCollect && j.aiCollect.verdict); }

  /** 按判定过滤（UI 用）。verdict 传 '' = 不过滤 */
  function filterByVerdict(list, verdict) {
    if (!verdict) return list;
    return (list || []).filter(function (j) { return j && j.aiCollect && j.aiCollect.verdict === verdict; });
  }

  global.AICollect = {
    BATCH_SIZE: BATCH_SIZE,
    COST_WARN_YUAN: COST_WARN_YUAN,
    SYS: SYS,
    clean: clean,
    estimateAll: estimateAll,
    estimateBatch: estimateBatch,
    summarize: summarize,
    hasVerdict: hasVerdict,
    filterByVerdict: filterByVerdict,
    profileOf: profileOf,
  };
})(window);
