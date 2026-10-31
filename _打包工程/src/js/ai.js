/* ==========================================================================
   ai.js · 大模型调用层
   直连 OpenAI 兼容端点（DeepSeek / 通义千问 / 智谱 / Kimi / Ollama …）
   流式 SSE，打字机效果。Key 只存在你自己的浏览器里。
   ========================================================================== */
(function (global) {
  'use strict';

  /* ==================== 提示词模板 ==================== */
  /**
   * 每个模板：{ label, desc, sys, user(input) }
   * input 是已经拼好的文本上下文。用户可在设置页覆盖 sys。
   */

  var GROUND_RULE =
    '硬性要求：\n' +
    '1. 只根据我提供的材料作答，**绝对不要编造**材料里没有的信息（公司名、薪资、年限、技能等）。\n' +
    '2. 材料里没有的字段，值填 null 或空数组，不要猜。\n' +
    '3. 全部输出用简体中文。';

  var TPL = {

    /* ---------- 1. JD 结构化解析 ---------- */
    jobParse: {
      label: 'JD 解析',
      desc: '把 BOSS 岗位原始文本拆成结构化字段',
      sys:
        '你是资深招聘分析师，擅长把招聘网站的原始岗位描述拆解成结构化信息。\n\n' +
        GROUND_RULE + '\n' +
        '4. 风险标记要克制、有依据：只有原文确实出现相关表述才标记，并给出依据。\n' +
        '5. 薪资解析：把"15-25K·14薪"这类文本拆成数字（单位 K），年终奖月数写进 salaryMonths。\n' +
        '6. reqSkills 是招聘平台自带的「技能标签」，实际内容多是招聘卖点（如「接受无经验牛人」' +
        '「不接受居家办公」），**不是硬性技能要求** —— 照抄原文即可，别把它当录用门槛；' +
        '真正的技能要求请从 JD 正文提炼，写进 duties 和 keywords。\n' +
        '7. 严格只输出一个 JSON 对象，不要任何解释文字、不要 markdown 代码块。\n\n' +
        '输出 JSON 结构（字段固定，未知填 null / 空数组）：\n' +
        '{\n' +
        '  "title": "岗位名称",\n' +
        '  "company": "公司名称",\n' +
        '  "industry": "所属行业（如 互联网 / 人工智能 / 广告传媒）",\n' +
        '  "location": "工作地点，格式：城市 · 区域",\n' +
        '  "remote": false,\n' +
        '  "salaryText": "原始薪资文本",\n' +
        '  "salaryMin": 10,\n' +
        '  "salaryMax": 15,\n' +
        '  "salaryMonths": 13,\n' +
        '  "benefits": ["五险一金", "双休"],\n' +
        '  "duties": ["职责1", "职责2"],\n' +
        '  "reqDegree": "学历要求",\n' +
        '  "reqYears": "经验要求",\n' +
        '  "reqSkills": ["照抄平台自带的技能标签，如「接受无经验」，是招聘卖点、不是录用门槛"],\n' +
        '  "keywords": ["用于检索简历的关键词"],\n' +
        '  "risks": ["风险点，每条写清依据，如：JD 提到派驻甲方 → 可能是外包"],\n' +
        '  "pros": ["这个岗位的吸引力"],\n' +
        '  "cons": ["需要注意的短板"],\n' +
        '  "tags": ["可用的预设标签，从这些里选：外包/派遣/国企/远程/急招/初创/大厂/技术岗/销售岗" ]\n' +
        '}',
      user: function (i) {
        return '请解析下面这段 BOSS 直聘岗位文本。\n\n' +
          (i.url ? '岗位链接：' + i.url + '\n\n' : '') +
          '===== 岗位原文开始 =====\n' + (i.text || '') + '\n===== 岗位原文结束 =====';
      },
    },

    /* ---------- 2. 简历 - JD 匹配 ---------- */
    match: {
      label: '简历匹配评估',
      desc: '给一份简历和岗位打分，指出缺口和优化点',
      sys:
        '你是资深求职顾问，负责冷静客观地评估"这份简历投这个岗位"的胜算。\n\n' +
        GROUND_RULE + '\n' +
        '4. 打分要狠一点、真实一点。不要为了安慰而虚高：明显不匹配就给低分。\n' +
        '5. 评分口径：90+ 几乎完美匹配；80-89 强匹配；70-79 有短板但值得投；' +
        '60-69 需要改简历或补技能；60 以下不建议投。\n' +
        '6. 每条判断都要能追溯到简历或 JD 里的具体内容。\n' +
        '7. 严格只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。\n\n' +
        '输出 JSON 结构：\n' +
        '{\n' +
        '  "score": 82,\n' +
        '  "verdict": "一句话结论，例如：强匹配，建议投递",\n' +
        '  "category": "qualified | need_optimization | cannot_apply 三选一",\n' +
        '  "matched": ["已匹配上的关键点"],\n' +
        '  "missing": ["简历里缺失 / 不明确的硬性要求"],\n' +
        '  "risks": ["投递风险，如学历不符、年限不足"],\n' +
        '  "suggestions": ["具体可执行的简历修改建议，要能直接改"],\n' +
        '  "keywordsToAdd": ["建议补进简历的关键词"],\n' +
        '  "greetingHint": "针对这个岗位打招呼时最该强调的一句话"\n' +
        '}',
      user: function (i) {
        return '【简历内容】\n' + (i.resume || '（无）') + '\n\n' +
          '【目标岗位】\n' + (i.job || '（无）') + '\n\n' +
          '请评估这份简历投这个岗位的匹配度。';
      },
    },

    /* ---------- 3. BOSS 打招呼开场白 ---------- */
    /* 方法论借自 github.com/AfterMaxQ/job_killer 的 greeting-generator 与
       github/awesome-copilot 的 technical-job-search（"用 JD 的原词，别换同义词"）。 */
    greeting: {
      label: 'BOSS 打招呼话术',
      desc: '生成可以直接粘贴到 BOSS 聊天框的开场白',
      sys:
        '你是擅长写 BOSS 直聘开场白的求职教练。\n\n' +
        GROUND_RULE + '\n' +
        '4. **开头 15 个字决定 HR 会不会点开**（BOSS 消息列表只显示这么长）——' +
        '   前 15 个字里就要出现「你和他最对口的那一个点」，不要拿问候语占位。\n' +
        '5. 用**岗位描述里的原词**，不要换成同义词。HR 是按关键词看人的：' +
        '   JD 写「分布式系统」你就别写「大型系统」。\n' +
        '6. 三句话以内、120-180 字，手机上三四行读完。结构：\n' +
        '   ① 最强匹配点（带一个真实数字；材料里没有就不带，**绝不编**）\n' +
        '   ② 你能解决他哪个问题（对着 JD 里那条硬要求说）\n' +
        '   ③ 一个轻量的推进动作（不要「期待您的回复」这种空话）\n' +
        '7. 不要用「贵司」「鄙人」「此致」等书面语，要像真人聊天。\n' +
        '8. 只讲我提供的经历。材料里没有的数字、项目、头衔**一律不写** ——' +
        '   宁可少一个亮点，也不要发一句面试时圆不回来的话。\n' +
        '9. 直接输出话术正文，不要标题、不要解释、不要 markdown。',
      user: function (i) {
        return '【岗位信息】\n' + (i.job || '') + '\n\n' +
          '【我的简历要点】\n' + (i.resume || '(未提供，只按岗位要求写通用版)') + '\n\n' +
          '请写一段可以直接粘贴到 BOSS 聊天框的打招呼话术。' +
          (i.style ? '\n风格要求：' + i.style : '');
      },
    },

    /* ---------- 4. 面试准备材料 ---------- */
    interviewPrep: {
      label: '面试准备材料',
      desc: '生成自我介绍、高频面试题、反问清单',
      sys:
        '你是资深面试教练，帮求职者准备一场具体岗位的面试。\n\n' +
        GROUND_RULE + '\n' +
        '4. 高频题要贴这个岗位的真实考点，不要泛泛的"你的优缺点是什么"。\n' +
        '5. 参考答案要结合候选人简历里的真实经历写成可以照读的口语，不要模板腔。\n' +
        '6. 反问 HR 的问题要能真的获取有用信息（团队构成、考核方式、业务阶段），不要问"公司发展前景如何"。\n' +
        '7. 严格只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。\n\n' +
        '输出 JSON 结构：\n' +
        '{\n' +
        '  "selfIntro": "60-90 秒自我介绍的口语稿，直接用简历里的真实经历",\n' +
        '  "questions": [\n' +
        '    { "q": "面试官可能问的问题", "why": "他想考什么", "a": "参考回答（口语，可照读）" }\n' +
        '  ],\n' +
        '  "askHr": ["值得反问 HR 的问题"],\n' +
        '  "points": ["这场面试必须讲到的加分点"],\n' +
        '  "avoid": ["千万别说的内容"],\n' +
        '  "questionsToCompany": ["关于岗位本身要确认清楚的问题，如是否外包、加班情况"]\n' +
        '}',
      user: function (i) {
        return '【岗位信息】\n' + (i.job || '') + '\n\n' +
          '【我的简历】\n' + (i.resume || '(未提供)') + '\n\n' +
          (i.round ? '【面试轮次】' + i.round + '\n' : '') +
          (i.extra ? '【补充说明】' + i.extra + '\n' : '') +
          '请生成本场面试的准备材料。questions 给 8 条，askHr 给 6 条。';
      },
    },

    /* ---------- 5. 面试复盘 ---------- */
    review: {
      label: '面试复盘',
      desc: '把面试感受和记录整理成结构化复盘 + 改进动作',
      sys:
        '你是面试复盘教练。基于候选人记下的面试流水账，整理成有价值的复盘。\n\n' +
        GROUND_RULE + '\n' +
        '4. 要指出他可能没意识到的信号（面试官的态度、问题的指向、时间长短）。\n' +
        '5. 改进动作要具体，下次面试前能照着练。\n' +
        '6. 用 Markdown 输出，结构见下（不要额外解释）：\n\n' +
        '## 一句话结论\n（这场面试大概率是什么结果，为什么）\n\n' +
        '## 面试官信号解读\n（从对话里能读出的信息，逐条）\n\n' +
        '## 我答得好的地方\n\n' +
        '## 我答砸的地方 + 更好的答法\n\n' +
        '## 岗位真实情况（我从这场面试了解到的）\n\n' +
        '## 下一步动作\n（3-5 条，可执行，含时间点）',
      user: function (i) {
        return '【岗位】\n' + (i.job || '') + '\n\n' +
          '【面试轮次】' + (i.round || '未填') + '\n\n' +
          '【我的面试记录 / 感受】\n' + (i.notes || '(空)') + '\n\n' +
          '请帮我做结构化复盘。';
      },
    },

    /* ---------- 6. 拒绝 / 沟通文案 ---------- */
    rejection: {
      label: '沟通文案',
      desc: '拒 offer、婉拒面试、延期、催进度',
      sys:
        '你是职场沟通文案专家，帮求职者写体面、专业、留后路的消息。\n\n' +
        GROUND_RULE + '\n' +
        '4. 语气真诚、简洁、有分寸；拒 offer 要明确表达感谢 + 说明原因 + 留未来合作可能。\n' +
        '5. 不要找明显假的借口（如"家里有事"），用"岗位方向与我长期规划不符"这类真实又不伤人的说法。\n' +
        '6. 长度 100-200 字，微信 / BOSS 聊天框能直接发。\n' +
        '7. 直接输出文案正文，不要标题、不要解释。如果场景需要，可以给 2 个语气版本（稳妥版 / 更简短版），用"【稳妥版】"分隔。',
      user: function (i) {
        return '【场景】' + (i.scene || '拒绝 offer') + '\n\n' +
          '【岗位 / 公司】\n' + (i.job || '') + '\n\n' +
          (i.reason ? '【我想表达的原因】' + i.reason + '\n\n' : '') +
          (i.extra ? '【补充】' + i.extra + '\n\n' : '') +
          '请写一段可直接发送的文案。';
      },
    },

    /* ---------- 7. 岗位对比总结 ---------- */
    compare: {
      label: '岗位对比结论',
      desc: '多个 offer 横向对比，给推荐排序',
      sys:
        '你是职业决策顾问。我会给你几个岗位的结构化信息，请给出冷静、有取舍建议的对比结论。\n\n' +
        GROUND_RULE + '\n' +
        '4. 要敢下判断，明确推荐一个首选和理由，不要"各有各的好"。\n' +
        '5. 要指出被我忽略的隐性因素（成长曲线、履历价值、风险）。\n' +
        '6. 用 Markdown 输出：\n\n' +
        '## 推荐结论\n（首选 + 一句话理由）\n\n' +
        '## 排序\n（1/2/3… 每个一行，附一句理由）\n\n' +
        '## 横向看\n（薪资 / 成长 / 稳定 / 通勤 四个维度的对比要点；' +
        '另外把「公司规模 / 福利与假期（双休还是大小周 / 五险一金 / 年假）/ 加班风险」单独说清，' +
        '数据没采到就直说「未提及」，不要替它猜）\n\n' +
        '## 要警惕的点\n（每个岗位各一条风险）\n\n' +
        '## 建议的决策动作\n（3 条，比如要问清楚什么、什么时间点做决定）',
      user: function (i) {
        return '【待对比岗位】\n' + (i.jobs || '') +
          (i.pref ? '\n【我的偏好】' + i.pref + '\n' : '') +
          '\n请给出对比结论。';
      },
    },

    /* ---------- 8. 跟进话术（投递后没回音时催一句） ---------- */
    /* 场景清单借自 github.com/AfterMaxQ/job_killer 的 hr-communicator
       （8 类 HR 场景 × 每类一条策略）。原来只覆盖"催进度"一种，其余场景
       用户只能自己瞎写 —— 而"被问离职原因/空窗期"这种恰恰最容易答砸。 */
    followup: {
      label: '跟进话术',
      desc: '投递后没动静 / 等结果 / 谈薪资 / 回 HR 等场景，写一条得体的沟通消息',
      sys:
        '你是求职沟通顾问，帮中国求职者写发给 HR 的沟通消息。\n\n' +
        GROUND_RULE + '\n' +
        '4. 先判断【目前在哪个环节】属于下面哪一类，**按那一类的策略**写：\n' +
        '   · 投了没回音 → 轻确认 + 补一条最能打的对口点；不催、不质问\n' +
        '   · 约面试 → 快速确认时间与形式，主动给 2 个可选时段，别让对方追着你问\n' +
        '   · 面试后等结果 → 表达持续兴趣 + 问下一步节奏；不施压、不暗示别家\n' +
        '   · 谈薪资 → 给区间不给死数，先问对方的预算口径；被追问就给锚点 + 一句理由\n' +
        '   · 被问离职原因 / 空窗期 → 只讲事实和方向，不抱怨前东家、不编理由\n' +
        '   · 要材料 → 一次给全，并主动问「还需要别的吗」，减少来回\n' +
        '   · Offer 沟通 → 明确态度 + 只谈 1-2 个关键项 + 给出答复期限\n' +
        '   · 婉拒 → 干脆、致谢、留后路，不要长篇解释\n' +
        '5. 语气要求：礼貌但不卑微，不催不逼，给对方台阶；长度 80-150 字，像正常人发微信。\n' +
        '6. 必须包含：我是谁（一句话）+ 对应的是哪个岗位 + 这一场景的核心动作。\n' +
        '7. 只写一条消息。不要编造我没提供的经历、数据、时间。\n' +
        '8. 绝对不要出现「跪求」「拜托」「给个机会」这类姿态过低的表达，也不要任何形式的威胁或催促。\n' +
        '9. 直接输出**可以复制发送的成品消息**，不要写解释、不要写"你可以这样说"、不要 Markdown 标题。',
      user: function (i) {
        return '【岗位信息】\n' + (i.job || '') +
          '\n【目前在哪个环节】' + (i.stage || '已投递') +
          '\n【已经过去多少天】' + (i.days || '几天') + ' 天' +
          (i.hr ? '\n【和 HR 之前的沟通】' + i.hr : '') +
          (i.note ? '\n【我自己的备注】' + i.note : '') +
          '\n\n请写一条跟进消息。';
      },
    },

    /* ---------- 9. 模拟面试官（多轮追问，不走 JSON 模板） ---------- */
    interviewer: {
      label: '模拟面试官',
      desc: 'AI 扮演面试官连环追问，一次只问一题',
      sys:
        '你是一场**模拟面试**的面试官，正在面试坐在你对面的人。\n\n' +
        '硬性规则：\n' +
        '1. 一次只问**一个**问题，绝不一次抛多个问题。\n' +
        '2. 基于候选人的上一个回答追问或换题，追问要具体（问到细节、数字、你的具体动作）。\n' +
        '3. 全程**不要评价**他的回答（不说"回答得不错"），不要给答案，不要给建议，不要总结。\n' +
        '4. 语气像真实面试官：专业、简洁、有压迫感但不失礼貌。\n' +
        '5. 单条回复控制在 60 字以内。\n' +
        '6. 问完 5 个问题后，如果候选人还没结束，就继续问第 6、7 个，直到他说结束。\n' +
        '7. 全部用简体中文。',
      user: function (i) { return i.text || ''; },
    },

    /* ---------- 10. 模拟面试复盘 ---------- */
    simReview: {
      label: '模拟面试复盘',
      desc: '根据模拟面试问答，给出逐题点评与改进建议',
      sys:
        '你是资深面试辅导老师。我会给你一场模拟面试的完整问答记录，请给出复盘。\n\n' +
        GROUND_RULE + '\n' +
        '4. 点评要具体到"哪句话该改"，不要给"多练习"这种正确的废话。\n' +
        '5. 严格只输出一个 JSON 对象，不要解释文字、不要 markdown 代码块。\n\n' +
        '输出 JSON 结构：\n' +
        '{\n' +
        '  "score": 0-100 的整数（这次表现的综合分，要求严格，60 分算勉强合格）,\n' +
        '  "verdict": "一句话总评（30 字以内）",\n' +
        '  "highlights": ["做得好的地方，最多 4 条；没有就给空数组"],\n' +
        '  "problems": ["最需要改的问题，按严重程度排，最多 5 条"],\n' +
        '  "perQuestion": [\n' +
        '    {\n' +
        '      "q": "问题原文",\n' +
        '      "comment": "他答得怎么样（30 字以内）",\n' +
        '      "better": "更好的答法骨架（60-120 字，给可以照着说的结构，不要编造我没提供的经历）",\n' +
        '      "tag": "亮点 | 一般 | 明显失分"\n' +
        '    }\n' +
        '  ],\n' +
        '  "nextSteps": ["接下来重点准备什么，3 条以内，每条要可执行"]\n' +
        '}',
      user: function (i) {
        return '【岗位信息】\n' + (i.job || '') +
          '\n【候选人简历要点】' + U.truncate(i.resume || '', 1200) +
          '\n【面试轮次】' + (i.round || '') +
          '\n\n===== 模拟面试问答记录 =====\n' + (i.transcript || '') +
          '\n===== 记录结束 =====\n\n请复盘。';
      },
    },

    /* ---------- 11. 自由对话 ---------- */
    free: {
      label: '自由问答',
      desc: '通用求职问题咨询',
      sys:
        '你是求职顾问，帮中国求职者解决找工作过程中的具体问题。\n\n' +
        GROUND_RULE + '\n' +
        '4. 回答要具体、可执行，避免正确的废话。\n' +
        '5. 适当用 Markdown 小标题和列表，但别把短回答写成论文。',
      user: function (i) { return i.text || ''; },
    },
  };

  /* ==================== 调用核心 ==================== */

  var MODELS_HINT = {
    'https://api.deepseek.com/v1': ['deepseek-chat', 'deepseek-reasoner'],
    'https://dashscope.aliyuncs.com/compatible-mode/v1': ['qwen-plus', 'qwen-max', 'qwen-turbo'],
    'https://open.bigmodel.cn/api/paas/v4': ['glm-4-plus', 'glm-4-flash'],
    'https://api.moonshot.cn/v1': ['moonshot-v1-8k', 'moonshot-v1-32k'],
    'https://api.siliconflow.cn/v1': ['deepseek-ai/DeepSeek-V3'],
    'http://localhost:11434/v1': ['qwen2.5:7b', 'llama3.1:8b'],
  };

  function cfg() { return Store.settings().ai || {}; }

  function endpoint() {
    var c = cfg();
    var b = (c.baseUrl || '').trim().replace(/\/+$/, '');
    if (!b) return '';
    // 允许用户只填 https://api.deepseek.com，自动补 /v1
    // ⛔ 若用户已经填到 /chat/completions，直接返回，别再拼一层（评审核实 2026-10-30，P0-4）：
    //   以前是无条件 return b + '/chat/completions'，填完整端点会得到
    //   .../chat/completions/chat/completions，必然 404。
    if (/\/chat\/completions$/.test(b)) return b;
    if (!/\/v\d+$/.test(b)) b += '/v1';
    return b + '/chat/completions';
  }

  function ready() {
    var c = cfg();
    return !!(c.baseUrl && c.apiKey && c.model);
  }

  function assertReady() {
    if (!ready()) {
      var e = new Error('这个工作台还没配置模型接口。请到「设置 → ① 大模型接口」填好 API Key（顺便点一下「测试连通」确认能通）。');
      e.code = 'NO_CONFIG';
      throw e;
    }
  }

  /**
   * 调用模型。
   * opt = { messages, onDelta, json, temperature, maxTokens, signal, timeout }
   * 返回 Promise<string>（完整文本）
   *
   * ⚠️ 对外**永远返回 Promise**，绝不同步抛。
   * assertReady() 是同步抛的（没配 Key 就走这里），如果直接漏出去，
   * 调用方挂在 `.catch` 上的处理不会执行，界面会永久卡在"正在调用…"，
   * 真实原因只出现在控制台 —— 本项目真踩过这个坑。
   */
  function chat(opt) {
    try { return chatInner(opt); }
    catch (e) { return Promise.reject(e); }
  }

  function chatInner(opt) {
    opt = opt || {};
    assertReady();
    var c = cfg();
    var url = endpoint();
    var body = {
      model: c.model,
      messages: opt.messages,
      temperature: opt.temperature !== undefined ? opt.temperature : (c.temperature === undefined ? 0.3 : c.temperature),
      stream: c.stream !== false,
    };
    if (opt.json) body.response_format = { type: 'json_object' };
    if (opt.maxTokens) body.max_tokens = opt.maxTokens;
    /* 批量评分想知道真实花费 → 向服务商要 usage（流式的最后一个 chunk 会带）。
       只在调用方明确要（onUsage）时才加这个参数 —— 别为一条路径给所有调用加风险；
       本地 Ollama 之类对 stream_options 支持参差，也不需要它（本地不花钱）。 */
    if (opt.onUsage && body.stream && !/\/\/(localhost|127\.0\.0\.1)/.test(url)) {
      body.stream_options = { include_usage: true };
    }

    var ctrl = new AbortController();
    var timeoutMs = (opt.timeout || c.timeout || 120) * 1000;
    var timer = setTimeout(function () { ctrl.abort(); }, timeoutMs);
    if (opt.signal) {
      if (opt.signal.aborted) ctrl.abort();
      else opt.signal.addEventListener('abort', function () { ctrl.abort(); });
    }

    var settled = false;
    function done() { if (!settled) { settled = true; clearTimeout(timer); } }

    return fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + c.apiKey,
      },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw buildHttpError(res.status, t); });
      if (body.stream && res.body && res.body.getReader) return readStream(res, opt.onDelta, opt.onUsage);
      return res.text().then(function (t) { return parseNonStream(t, opt.onDelta, opt.onUsage); });
    }).then(function (text) { done(); return text; })
      .catch(function (err) {
        done();
        if (err && err.name === 'AbortError') {
          if (opt.signal && opt.signal.aborted) throw makeErr('已取消。', 'ABORT');
          throw makeErr('请求超时（' + Math.round(timeoutMs / 1000) + ' 秒）。' +
            '可能是网络慢或提示词太长，可以在设置里调大超时时间。', 'TIMEOUT');
        }
        if (err && err.code) throw err;
        throw makeErr('请求失败：' + (err && err.message ? err.message : '未知错误') +
          '（若提示 Failed to fetch，检查网络、Base URL 是否可访问，以及浏览器是否拦截了跨域请求）', 'NETWORK');
      });
  }

  /* ==================== 成本估算（¥ 与 token） ==================== */

  /* 价格表：¥ / 1M token。⚠️ 模型价格随时会调，这张表只求「量级正确」，
     让用户在下单前心里有数 —— 精确单价请到设置里覆盖（ai.priceIn / ai.priceOut）。
     匹配规则：模型名（小写）contains 表里的 k，先命中先用。 */
  var PRICE_TABLE = [
    { k: 'deepseek', in: 2, out: 8 },
    { k: 'qwen-plus', in: 0.8, out: 2 },
    { k: 'qwen-max', in: 2.4, out: 9.6 },
    { k: 'qwen-turbo', in: 0.3, out: 0.6 },
    { k: 'qwen', in: 1, out: 4 },
    { k: 'glm-4-flash', in: 0, out: 0 },
    { k: 'glm-4', in: 7, out: 7 },
    { k: 'moonshot', in: 12, out: 12 },
    { k: 'kimi', in: 12, out: 12 },
  ];
  var DEFAULT_PRICE = { in: 2, out: 8 };

  /** 当前生效的单价。设置里填了（>0）就用用户的；否则查表；查不到用默认价。 */
  function pricing() {
    var c = cfg();
    var pi = Number(c.priceIn), po = Number(c.priceOut);
    if (pi > 0 || po > 0) {
      return {
        in: pi > 0 ? pi : DEFAULT_PRICE.in,
        out: po > 0 ? po : DEFAULT_PRICE.out,
        from: '你在设置里填的单价',
      };
    }
    var m = String(c.model || '').toLowerCase();
    for (var i = 0; i < PRICE_TABLE.length; i++) {
      if (m.indexOf(PRICE_TABLE[i].k.toLowerCase()) >= 0) {
        return { in: PRICE_TABLE[i].in, out: PRICE_TABLE[i].out,
          from: '内置价格表 · ' + PRICE_TABLE[i].k + '（以服务商最新价为准）' };
      }
    }
    return { in: DEFAULT_PRICE.in, out: DEFAULT_PRICE.out, from: '默认价（可在设置里填单价估得更准）' };
  }

  /* 中文字 ≈ 0.6 token/字，英文 ≈ 0.25 token/字符（各家分词器不同，估个量级用） */
  var CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
  function estTokens(text) {
    var s = String(text === null || text === undefined ? '' : text);
    if (!s) return 0;
    var cjk = (s.match(CJK_RE) || []).length;
    return Math.ceil(cjk * 0.6 + (s.length - cjk) * 0.25);
  }

  /* match 模板输出的 JSON（matched/missing/risks/suggestions…）经验值（估） */
  var OUT_EST_TOKENS = 700;

  /**
   * 估算「给这个岗位评一次分」要花多少 token。
   * ⚠️ 必须用与 runTemplate('match') **同一套拼装**（含设置里覆盖的 sys），
   *    否则估的就是另一个提示词，数字失去意义。
   */
  function matchPromptTexts(job, resume) {
    var t = TPL.match;
    var sys = (Store.settings().prompts || {}).match || t.sys;
    var user = t.user({ resume: resumeToText(resume), job: jobToText(job, true) });
    return sys + '\n' + user;
  }

  function estimateMatchCall(job, resume) {
    return { inT: estTokens(matchPromptTexts(job, resume)), outT: OUT_EST_TOKENS };
  }

  /** token → 钱。usage 里的字段名是 OpenAI 口径：prompt_tokens / completion_tokens。 */
  function costOf(inT, outT) {
    var p = pricing();
    inT = inT || 0; outT = outT || 0;
    return {
      inT: inT, outT: outT,
      cost: inT / 1e6 * p.in + outT / 1e6 * p.out,
      priceFrom: p.from, priceIn: p.in, priceOut: p.out,
    };
  }

  function makeErr(msg, code) { var e = new Error(msg); e.code = code; return e; }

  function buildHttpError(status, text) {
    var detail = '';
    try { var j = JSON.parse(text); detail = (j.error && (j.error.message || j.error.code)) || j.message || text; }
    catch (e) { detail = text; }
    detail = String(detail || '').slice(0, 300);

    var msg;
    if (status === 401 || status === 403) {
      msg = 'API Key 无效或没有权限（HTTP ' + status + '）。请到设置页检查 Key 是否填对、是否已过期。';
    } else if (status === 402) {
      msg = '账户余额不足（HTTP 402）。请先去模型服务商那边充值。';
    } else if (status === 404) {
      msg = '接口地址或模型名不对（HTTP 404）。检查 Base URL 是否含 /v1、模型名是否正确。';
    } else if (status === 429) {
      msg = '请求太频繁或超出额度（HTTP 429）。等一会儿再试，或在设置里降低并发。';
    } else if (status >= 500) {
      msg = '模型服务端出错（HTTP ' + status + '）。通常是临时的，稍后重试。';
    } else {
      msg = '调用失败（HTTP ' + status + '）。';
    }
    if (detail) msg += '\n服务端返回：' + detail;
    return makeErr(msg, 'HTTP_' + status);
  }

  /** 读取 SSE 流。usage：带 stream_options 时最后一帧只含 usage、choices 为空 ——
      现有「!d 就 continue」会跳过它，所以在判 d 之前先接住。 */
  function readStream(res, onDelta, onUsage) {
    var reader = res.body.getReader();
    var decoder = new TextDecoder('utf-8');
    var buf = '';
    var full = '';
    var reasoning = '';
    var usage = null;

    function pump() {
      return reader.read().then(function (r) {
        if (r.done) {
          if (usage && onUsage) { try { onUsage(usage); } catch (e) { /* noop */ } }
          return full;
        }
        buf += decoder.decode(r.value, { stream: true });
        var parts = buf.split('\n');
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) {
          var line = parts[i].trim();
          if (!line || line.charAt(0) === ':') continue;
          if (line.indexOf('data:') !== 0) continue;
          var payload = line.slice(5).trim();
          if (payload === '[DONE]') continue;
          var obj = null;
          try { obj = JSON.parse(payload); } catch (e) { continue; }
          if (obj.usage) usage = obj.usage;      // 有些服务商最后一帧同时带 choices + usage
          var d = obj.choices && obj.choices[0] && obj.choices[0].delta;
          if (!d) continue;
          if (d.reasoning_content) reasoning += d.reasoning_content;
          if (d.content) {
            full += d.content;
            if (onDelta) { try { onDelta(d.content, full); } catch (e) { /* noop */ } }
          }
        }
        return pump();
      });
    }
    return pump().then(function (t) { return t; });
  }

  function parseNonStream(text, onDelta, onUsage) {
    try {
      var j = JSON.parse(text);
      var t = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
      if (j.usage && onUsage) { try { onUsage(j.usage); } catch (e) { /* noop */ } }
      if (onDelta && t) onDelta(t, t);
      return t;
    } catch (e) {
      throw makeErr('返回内容不是合法 JSON，可能是接口地址配错了。原始返回：' + String(text).slice(0, 200), 'BAD_RESPONSE');
    }
  }

  /**
   * 按模板调用并解析出 JSON 结果。
   * tplKey, input, { onDelta, onRaw }
   */
  function runTemplate(tplKey, input, opt) {
    opt = opt || {};
    // ⚠️ 用 Promise.resolve().then() 包一层：chat() 里的 assertReady() 是**同步抛**，
    // 不包的话「没配 Key」会同步冲出调用方，调用方挂在 .then/.catch 上的处理器
    // 一个都不会执行 —— 表现就是弹窗永久卡在"正在调用…"，界面上看不到任何原因。
    // 包一层后，无论同步失败还是异步失败，都统一变成 rejected promise。
    return Promise.resolve().then(function () {
      var t = TPL[tplKey];
      if (!t) throw new Error('未知模板：' + tplKey);
      var customSys = (Store.settings().prompts || {})[tplKey];
      var messages = [
        { role: 'system', content: customSys || t.sys },
        { role: 'user', content: t.user(input || {}) },
      ];
      var wantJson = ['jobParse', 'match', 'interviewPrep', 'simReview'].indexOf(tplKey) >= 0;
      return chat({
        messages: messages,
        json: wantJson,
        onDelta: opt.onDelta,
        onUsage: opt.onUsage,
        temperature: opt.temperature,
        maxTokens: opt.maxTokens,
        signal: opt.signal,
      }).then(function (text) {
        if (opt.onRaw) opt.onRaw(text);
        if (!wantJson) return { text: text, data: null };

        var data = U.extractJSON(text);
        if (data === null) {
          // JSON 解析失败 → 再让模型修一次（便宜且成功率高）
          return repairJson(text, tplKey).then(function (fixed) {
            if (fixed) return { text: text, data: fixed };
            var e = makeErr('模型返回的内容不是合法 JSON，自动修复也失败了。可以重试一次。', 'BAD_JSON');
            e.raw = text;
            throw e;
          });
        }
        return { text: text, data: data };
      });
    });
  }

  function repairJson(badText, tplKey) {
    var sys = '你是 JSON 修复器。用户会给你一段"本应是 JSON 但有语法错误"的文本，' +
      '请只输出修复后的合法 JSON 对象，不要任何解释、不要 markdown 代码块、不要增删字段内容。';
    return chat({
      messages: [
        { role: 'system', content: sys },
        { role: 'user', content: String(badText).slice(0, 6000) },
      ],
      json: true,
      temperature: 0,
      maxTokens: 2000,
    }).then(function (t) { return U.extractJSON(t); })
      .catch(function () { return null; });
  }

  /** 连通性测试：发一个最小请求 */
  function testConnection() {
    try {
      assertReady();
    } catch (e) {
      return Promise.reject(e);
    }
    var t0 = U.now();
    return chat({
      messages: [{ role: 'user', content: '只回复两个字：可用' }],
      temperature: 0,
      maxTokens: 20,
      timeout: 30,
    }).then(function (t) {
      return { ok: true, ms: U.now() - t0, reply: (t || '').trim(), model: cfg().model };
    });
  }

  /* ==================== 场景化封装 ==================== */

  /** 把岗位对象压成一段给模型看的文本 */
  function jobToText(job, withRaw) {
    if (!job) return '';
    var L = [];
    L.push('岗位名称：' + (job.title || '未填'));
    L.push('公司：' + (job.company || '未填') + (job.industry ? '（' + job.industry + '）' : ''));
    L.push('地点：' + (job.location || '未填') + (job.remote ? '（支持远程）' : ''));
    L.push('薪资：' + (job.salaryText || '面议') +
      (job.salaryMonths ? '，年终约 ' + job.salaryMonths + ' 个月' : ''));
    /* 公司规模 / 地址 / 公司简介 —— 这些是采集侧早就带回来、
       但一直没进提示词的字段。做「offer 横向对比」时规模是很关键的一票。 */
    if (job.scale) {
      L.push('公司规模：' + job.scale +
        (global.JobScorer ? '（' + global.JobScorer.scaleLabel(job.scale) + '）' : ''));
    }
    if (job.district || job.address) L.push('通勤：' + [job.district, job.address].filter(Boolean).join(' '));
    if (job.benefits && job.benefits.length) {
      var w = global.JobScorer ? global.JobScorer.welfareOf(job) : null;
      L.push('福利标签：' + job.benefits.join('、'));
      /* 把福利串拆成"休息 / 保障 / 奖金补贴 / 作息"再说一遍 ——
         BOSS 的福利串是挤在一起的（"交通补助 有无线网 工龄奖…"），
         不拆开的话模型很容易漏掉「双休」这种关键项。 */
      if (w && w.has) {
        var bits = [];
        bits.push('休息=' + w.rest.text);
        bits.push('五险一金=' + w.insurance.text);
        bits.push('法定节假日=' + (w.legal ? '有' : '未提及'));
        bits.push('带薪年假=' + (w.annual ? '有' : '未提及'));
        if (w.flexible) bits.push('弹性/不加班=提到');
        L.push('福利拆解：' + bits.join('；'));
      }
    }
    if (job.companyInfo) L.push('公司简介：' + U.truncate(job.companyInfo, 260));
    if (job.duties && job.duties.length) L.push('岗位职责：\n- ' + job.duties.join('\n- '));
    L.push('学历要求：' + (job.reqDegree || '不限'));
    L.push('经验要求：' + (job.reqYears || '不限'));
    // ⚠️ BOSS 的「技能标签」多是招聘卖点（「接受无经验」「不接受居家办公」），不是硬性技能要求
    // —— 明确告诉模型，别让这些标签被当成录用门槛，系统性地压低匹配分。
    if (job.reqSkills && job.reqSkills.length) L.push('招聘标签（平台自动打，多为招聘卖点、非硬性要求）：' + job.reqSkills.join('、'));
    if (job.keywords && job.keywords.length) L.push('关键词：' + job.keywords.join('、'));
    if (job.risks && job.risks.length) L.push('已识别风险：' + job.risks.join('；'));
    if (withRaw && job.rawJD) L.push('\n===== 原始 JD =====\n' + U.truncate(job.rawJD, 3000));
    return L.join('\n');
  }

  /** 把简历压成文本（过长就截断，控制 token） */
  function resumeToText(resume, max) {
    if (!resume) return '';
    return U.truncate(resume.content || '', max || 3500);
  }

  global.AI = {
    TPL: TPL, MODELS_HINT: MODELS_HINT,
    chat: chat, runTemplate: runTemplate, testConnection: testConnection,
    ready: ready, endpoint: endpoint, cfg: cfg,
    jobToText: jobToText, resumeToText: resumeToText,
    // 成本估算 / 真实花费
    estTokens: estTokens, pricing: pricing, costOf: costOf,
    estimateMatchCall: estimateMatchCall, PRICE_TABLE: PRICE_TABLE,
    OUT_EST_TOKENS: OUT_EST_TOKENS,
  };
})(window);
