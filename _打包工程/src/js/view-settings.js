/* ==========================================================================
   view-settings.js · 模块 8：设置
   模型 API / 自定义提示词 / 通知 / 数据备份与恢复 / 主题
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  var PRESETS = [
    { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat',
      note: '国内直连、便宜，兼容 OpenAI 格式（默认推荐）' },
    { name: '通义千问（阿里云）', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus',
      note: 'DashScope 兼容模式，新用户有免费额度' },
    { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-plus',
      note: 'GLM-4 系列，也有免费额度' },
    { name: '月之暗面 Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k', note: '长文本能力强' },
    { name: '硅基流动', baseUrl: 'https://api.siliconflow.cn/v1', model: 'deepseek-ai/DeepSeek-V3', note: '聚合平台，模型多' },
    { name: '本地 Ollama', baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5:7b',
      note: '完全离线，key 随便填一个（如 ollama）' },
  ];

  /* ==================== 卡片折叠（第 23 轮） ====================
     设置页 7 张卡一路叠下来太长，用户要求"能折起来"。
     复用采集页那套（`.card.collapsed > .body`，见 css/app.css 第 22 轮），不另起炉灶。
     ⛔ 三条硬规矩都是第 22 轮踩出来的，任何一条漏了都会"看起来像做了、其实是坏的"：
       ① 只藏 .body，header 必须留着 —— 否则收起后没有东西可以点回来
       ② 收起时必须在 header 里留一行摘要 —— 否则"这一块"等于从页面上消失了
       ③ 状态必须落盘 —— 否则刷新就弹回来，等于没折
     ⛔ 摘要不能和 header 原有的 hint 同时出现：展开看 hint、收起看摘要（CSS 切换）。 */
  var FOLD_KEY = 'jh.setFold';

  function readFolds() {
    try { return JSON.parse(localStorage.getItem(FOLD_KEY) || '{}') || {}; } catch (e) { return {}; }
  }
  function writeFold(key, open) {
    try {
      var m = readFolds();
      m[key] = open ? 1 : 0;
      localStorage.setItem(FOLD_KEY, JSON.stringify(m));
    } catch (e) { /* 隐私模式不挡用 */ }
  }

  /** 取直接子节点里的第一个 <header>。
   *  ⛔ 不用 `:scope > header` —— DOM 桩（_测试_核心.js）里不保证支持，
   *     写成 `card.querySelector('header')` 又会抓到嵌套卡片里的 header。 */
  function firstHeader(card) {
    var kids = card.children || [];
    for (var i = 0; i < kids.length; i++) {
      if (String(kids[i].tagName || '').toUpperCase() === 'HEADER') return kids[i];
    }
    return null;
  }

  /**
   * 让一张卡可折叠。
   * @param {Element} card     卡片（结构必须是 card > header + .body）
   * @param {string}  key      落盘键，同时用作 title 里的名字
   * @param {boolean} defOpen  首次访问时的默认状态（之后以落盘为准）
   * @param {string|Function} summary  收起时那一行摘要（函数=每次收起时现算）
   */
  function foldCard(card, key, defOpen, summary) {
    var head = firstHeader(card);
    if (!head) return card;
    var psum = el('span', { class: 'psum', text: '' });
    var chev = el('span', { class: 'chev' });
    head.appendChild(psum);
    head.appendChild(chev);
    head.classList.add('foldhead');

    var stored = readFolds();
    var open = (key in stored) ? !!stored[key] : !!defOpen;   // ⛔ 用 in，不能用 ||：存过 0 也是有效状态

    function apply(o) {
      open = !!o;
      if (open) card.classList.remove('collapsed'); else card.classList.add('collapsed');
      chev.textContent = open ? '\u25be' : '\u25b8';
      psum.textContent = open ? ''
        : String(typeof summary === 'function' ? summary() : (summary || ''));
      head.title = (open ? '收起' : '展开') + '「' + key + '」';
    }
    head.addEventListener('click', function () { apply(!open); writeFold(key, open); });
    apply(open);
    return card;
  }

  function render(root) {
    var wrap = el('div', { class: 'wrap narrow stack' });
    root.appendChild(wrap);

    App.topActions([
      el('button', { class: 'btn', html: '⤓ 导出 JSON 备份', onclick: function () { Exporter.exportJSONFlow(); } }),
      el('button', { class: 'btn', html: '📥 导入 JSON', onclick: function () { importFlow(); } }),
    ]);

    var S = Store.settings();
    var ai = S.ai;

    /* ==================== 1. 模型 API ==================== */
    var aiCard = el('div', { class: 'card' });
    aiCard.appendChild(el('header', {}, [
      el('h3', { text: '① 大模型接口' }),
      el('span', { class: 'sp' }),
      AI.ready()
        ? el('span', { class: 'pill on' }, [el('span', { class: 'dt' }), '已配置'])
        : el('span', { class: 'pill off' }, [el('span', { class: 'dt' }), '未配置']),
    ]));

    var aiBody = el('div', { class: 'body' });

    aiBody.appendChild(el('div', { class: 'note info mb12' }, [
      el('span', { class: 'ico', text: '🔐' }),
      el('div', { html:
        '<b>Key 只存在你这个浏览器里</b>（localStorage），请求从你的浏览器直连模型服务商，' +
        '不经过任何中间服务器。换台电脑用，把配置文件重新填一次就行。' }),
    ]));

    // 预设
    aiBody.appendChild(el('div', { class: 'fs12 muted fw6 mb4', text: '快速选择服务商' }));
    var preRow = el('div', { class: 'chips mb12' });
    PRESETS.forEach(function (p) {
      preRow.appendChild(el('button', {
        class: 'btn sm' + (ai.baseUrl === p.baseUrl ? ' pri' : ''),
        text: p.name, title: p.note,
        onclick: function () {
          Store.setSetting('ai.baseUrl', p.baseUrl);
          Store.setSetting('ai.model', p.model);
          U.toast('已切到 ' + p.name + '，别忘了填 API Key', 'info');
          App.refresh();
        },
      }));
    });
    aiBody.appendChild(preRow);

    var fBase = Comp.field({ key: 'baseUrl', label: '接口地址（Base URL）', value: ai.baseUrl,
      placeholder: 'https://api.deepseek.com/v1', hint: '只填到 /v1 即可，程序会自动拼 /chat/completions' });
    var fKey = Comp.field({ key: 'apiKey', label: 'API Key *', type: 'password', value: ai.apiKey,
      placeholder: 'sk-…', hint: '点右边眼睛可显示/隐藏' });
    var keyRow = el('div', { class: 'row nowrap', style: 'align-items:flex-end;gap:7px' }, [
      el('div', { class: 'flex1' }, [fKey.node]),
      el('button', {
        class: 'btn icon', html: '👁', title: '显示 / 隐藏',
        onclick: function (e) {
          var i = fKey.input;
          i.type = i.type === 'password' ? 'text' : 'password';
          e.target.textContent = i.type === 'password' ? '👁' : '🙈';
        },
      }),
    ]);

    var models = AI.MODELS_HINT[ai.baseUrl] || [];
    var fModel = Comp.field({ key: 'model', label: '模型名称 *', value: ai.model,
      placeholder: 'deepseek-chat', hint: models.length ? '这个服务商常用：' + models.join('、') : '' });
    var fTemp = Comp.field({ key: 'temperature', label: '温度', type: 'number', value: ai.temperature,
      hint: '0 = 更稳定，0.7 = 更发散。解析类建议 0.2-0.4' });
    var fTimeout = Comp.field({ key: 'timeout', label: '超时（秒）', type: 'number', value: ai.timeout });
    /* 单价：给「批量评分费用预估」用。价格表只求量级正确，填了这里就以这里为准。 */
    var fPriceIn = Comp.field({ key: 'priceIn', label: '输入单价（元/百万token）', type: 'number', value: ai.priceIn,
      hint: '0 或留空 = 按「' + (AI.PRICE_TABLE[0] || {}).in + '」这类内置价格表估。批量评分弹窗里的费用预估以此为准，建议填服务商最新价' });
    var fPriceOut = Comp.field({ key: 'priceOut', label: '输出单价（元/百万token）', type: 'number', value: ai.priceOut,
      hint: '输出通常比输入贵几倍，两个都要填才算准' });

    var cbStream = el('input', { type: 'checkbox' });
    cbStream.checked = ai.stream !== false;
    cbStream.addEventListener('change', function () { Store.setSetting('ai.stream', cbStream.checked); });
    var fStream = el('label', { class: 'chk' }, [
      cbStream,
      el('span', { text: '流式输出（打字机效果，推荐开）' }),
    ]);

    aiBody.appendChild(el('div', { class: 'grid g2', style: 'gap:12px' }, [fBase.node, fModel.node]));
    aiBody.appendChild(el('div', { class: 'mt12' }, [keyRow]));
    aiBody.appendChild(el('div', { class: 'grid g2 mt12', style: 'gap:12px' }, [fTemp.node, fTimeout.node]));
    aiBody.appendChild(el('div', { class: 'grid g2 mt12', style: 'gap:12px' }, [fPriceIn.node, fPriceOut.node]));
    aiBody.appendChild(el('div', { class: 'row mt12' }, [fStream]));

    var testOut = el('div', {});
    aiBody.appendChild(el('div', { class: 'row mt12' }, [
      el('button', {
        class: 'btn pri', html: '💾 保存配置',
        onclick: function () {
          Store.setSetting('ai.baseUrl', fBase.get());
          Store.setSetting('ai.apiKey', fKey.get());
          Store.setSetting('ai.model', fModel.get());
          Store.setSetting('ai.temperature', U.num(fTemp.get(), 0.3));
          Store.setSetting('ai.timeout', U.num(fTimeout.get(), 120) || 120);
          Store.setSetting('ai.priceIn', U.num(fPriceIn.get(), 0) || 0);
          Store.setSetting('ai.priceOut', U.num(fPriceOut.get(), 0) || 0);
          U.toast('配置已保存 ✅', 'ok');
          App.refresh();
        },
      }),
      el('button', {
        class: 'btn', html: '🔌 测试连通（不花钱）',
        onclick: function (e) {
          // 先静默保存，避免用户忘了点保存
          Store.setSetting('ai.baseUrl', fBase.get());
          Store.setSetting('ai.apiKey', fKey.get());
          Store.setSetting('ai.model', fModel.get());
          Store.flush();
          var btn = e.target;
          btn.disabled = true;
          testOut.innerHTML = '';
          testOut.appendChild(el('div', { class: 'row fs12 muted mt8' }, [el('span', { class: 'spin' }), '正在请求模型…']));
          AI.testConnection().then(function (r) {
            btn.disabled = false;
            testOut.innerHTML = '';
            testOut.appendChild(el('div', { class: 'note ok mt8' }, [
              el('span', { class: 'ico', text: '✅' }),
              el('div', { html: '<b>通了</b>（' + r.ms + ' ms）。模型 <code class="mono">' + U.esc(r.model) + '</code> 回复：' + U.esc(r.reply) }),
            ]));
            App.updateNavCounts();
          }).catch(function (err) {
            btn.disabled = false;
            testOut.innerHTML = '';
            testOut.appendChild(el('div', { class: 'note bad mt8' }, [
              el('span', { class: 'ico', text: '⛔' }),
              el('div', { html: U.esc(err.message).replace(/\n/g, '<br>') }),
            ]));
          });
        },
      }),
      el('span', { class: 'sp' }),
      el('a', { class: 'hint tiny', href: 'https://api-docs.deepseek.com/zh-cn/', target: '_blank', rel: 'noreferrer', text: 'DeepSeek 文档 ↗' }),
    ]));
    aiBody.appendChild(testOut);

    aiCard.appendChild(aiBody);
    /* ① 默认**展开** —— 它是新用户第一件要填的事，收起来等于让人多找一步。 */
    wrap.appendChild(foldCard(aiCard, '大模型接口', true, function () {
      return global.AI && AI.ready()
        ? '已配置 · ' + ((Store.settings().ai || {}).model || '')
        : '未配置（点开填 Key）';
    }));

    /* ==================== 2.（整卡已删除 · 第 23 轮） ====================
       这里原本是「② 求职偏好」的指路牌（一句"已移到岗位库" + 一个跳转按钮 + 一行"当前生效"）。
       按用户要求整卡删除。理由：偏好入口在岗位库筛选栏上已经有一个「⚙ 我的求职偏好」，
       那边（view-jobs.js）自己就有 10 多处调用点，设置页再摆一块指路牌属于**重复导航**。

       ⛔ 删卡时**故意保留**那条真正要守的不变量：「**设置页不得再出现第二份偏好表单**」。
         它现在由 _测试_核心.js 用**反向断言**守着（查"求职方向关键词"这类字段在设置页不存在），
         比原来"证明指路牌存在"更直接 —— 指路牌本来就是那句不变量的副产品。
       偏好数据本身一直在 `DB.settings.prefs`，编辑入口在岗位库，这条链一行都没动。 */

    /* ==================== 2.5 自动触达 BOSS（危险功能总闸门） ====================
       这两个开关**默认全关**。为什么放在最显眼的位置、还配一大段警告：
       它们是全项目**唯二**会"代替你对外发出动作 / 去读你的私人消息"的功能，
       一旦误开，后果分别是「不可撤回的消息」和「账号被风控」。 */
    var bossCard = el('div', { class: 'card' });
    bossCard.appendChild(el('header', {}, [
      el('h3', { text: '② 自动触达 BOSS' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'hint', text: '默认关闭' }),
    ]));
    var bb = el('div', { class: 'body' });
    var cfg = (S.boss || {});

    bb.appendChild(el('div', { class: 'note warn mb12' }, [
      el('span', { class: 'ico', text: '⚠️' }),
      el('div', { html: '下面两个开关会让<b>采集器驱动真实浏览器</b>去操作 BOSS。' +
        '请先确认你接受：<b>消息发出去撤不回</b>、<b>BOSS 每天沟通条数有限</b>、' +
        '以及<b>自动化操作可能违反 BOSS 用户协议（风险自负）</b>。' }),
    ]));

    /* --- 开关 1：一键打招呼（会发消息）--- */
    var cbGreet = el('input', { type: 'checkbox' });
    cbGreet.checked = !!(global.ApplyBoss ? global.ApplyBoss.autoGreetOn() : cfg.autoGreet);
    cbGreet.addEventListener('change', function () {
      if (global.ApplyBoss) global.ApplyBoss.setAutoGreet(cbGreet.checked);
      else Store.setSetting('boss.autoGreet', cbGreet.checked);
      /* ⛔ 无论走哪条分支都同步给服务端（评审 P1-5）：服务端闸门读的是自己那份
         greet_conf.json，不同步就等于它拿着旧开关状态做判断。
         （setAutoGreet 内部也会同步，这里再补一次是为了 else 那条路 —— 幂等，便宜。） */
      if (global.ApplyBoss && global.ApplyBoss.syncGreetConf) global.ApplyBoss.syncGreetConf();
      U.toast(cbGreet.checked
        ? '已开启「一键打招呼」—— 岗位卡上会出现 ⚡ 按钮，每次都要你确认才发'
        : '已关闭「一键打招呼」，⚡ 按钮已从岗位卡上撤下', cbGreet.checked ? 'warn' : 'info', 4200);
      App.refresh();
    });
    bb.appendChild(el('label', { class: 'chk mb4' }, [
      cbGreet, el('span', { text: '① 「⚡ 一键打招呼」：让采集器替你点「立即沟通」并发送招呼语' }),
    ]));
    bb.appendChild(el('div', { class: 'hint tiny mb12', html:
      '逐个岗位手动触发、绝不批量、绝不重试。发送前会弹窗让你看到<b>即将发出的原话</b>。' }));

    /* --- 开关 2：同步回复/邀约（会读你的消息）--- */
    var cbSync = el('input', { type: 'checkbox' });
    cbSync.checked = !!(global.ApplyBoss ? global.ApplyBoss.syncReplyOn() : cfg.syncReply);
    cbSync.addEventListener('change', function () {
      if (global.ApplyBoss) global.ApplyBoss.setSyncReply(cbSync.checked);
      else Store.setSetting('boss.syncReply', cbSync.checked);
      U.toast(cbSync.checked
        ? '已开启「同步回复」—— 投递面板会出现「同步一次」按钮，读回来的内容都要你逐条确认才入库'
        : '已关闭「同步回复」', cbSync.checked ? 'warn' : 'info', 4200);
      App.refresh();
    });
    bb.appendChild(el('label', { class: 'chk mb4' }, [
      cbSync, el('span', { text: '② 「同步回复 / 邀约」：读 BOSS 聊天列表，把回复和邀约捞回来' }),
    ]));
    bb.appendChild(el('div', { class: 'hint tiny', html:
      '⚠️ 读回来的<b>不会自动写进你的数据</b> —— 会话和岗位的对应关系靠名字匹配、可能认错，' +
      '所以每条都要你点「确认」才生效。这一步只在你点按钮时跑，不做后台巡检。' }));

    /* --- 选择：上面这两个动作用哪个浏览器（第 28 轮）---
       起因：同一屏的「去投递」走的是**你平时的 Edge**（本来就在用、也登录着），
       而这两个动作却另起窗口、还要单独扫码 —— 用户的原话是「登录非一致、需要重新打开」。 */
    bb.appendChild(el('hr', { style: 'border:none;border-top:1px solid var(--line);margin:14px 0 10px' }));
    bb.appendChild(el('div', { class: 'fs12 muted fw6 mb6', html:
      '③ 上面这两个动作用<b>哪个浏览器</b>' }));
    var bmNow = global.ApplyBoss
      ? global.ApplyBoss.browserMode()
      : (cfg.browserMode === 'daily' ? 'daily' : 'own');
    var bmBox = el('div', { class: 'stack', style: 'gap:8px' });
    [['own', '工作台自己的浏览器（默认）',
      '与你的日常浏览完全隔离。首次要扫码一次，之后一次能用 6 小时。'],
     ['daily', '你平时的 Edge',
      '零扫码、浏览器指纹和你日常完全一致。前提：跑之前必须先彻底退出 Edge。'],
    ].forEach(function (x) {
      var rb = el('input', { type: 'radio', name: 'bossBrowserMode' });
      rb.checked = (bmNow === x[0]);
      rb.addEventListener('change', function () {
        if (!rb.checked) return;
        if (global.ApplyBoss) global.ApplyBoss.setBrowserMode(x[0]);
        else Store.setSetting('boss.browserMode', x[0]);
        U.toast('已切成「' + x[1] + '」', 'info', 3600);
        App.refresh();
      });
      /* ⛔ 说明文字要**直接可见**，不能塞进 title（悬停才出现）——
         这是「零扫码 / 要扫码」这种决定性差异，藏起来等于没说。
         ⛔ 也注意 el() 的孩子只吃「字符串 / 节点」，不吃 {text:...} 对象 ——
            写成孩子会 appendChild 一个普通对象直接抛错（本轮真踩过）。 */
      bmBox.appendChild(el('div', {}, [
        el('label', { class: 'chk' }, [rb, el('span', { text: x[1] })]),
        el('div', { class: 'hint tiny', style: 'margin:2px 0 0 24px', text: x[2] }),
      ]));
    });
    bb.appendChild(bmBox);
    bb.appendChild(el('div', { class: 'hint tiny mt6', html:
      '⚠️ 选「你平时的 Edge」时，跑之前必须<b>彻底退出 Edge</b> —— 不是只关窗口，' +
      '要到右下角<b>托盘图标上右键退出</b>（Edge 会常驻后台）。' +
      '没退干净会直接提示你该怎么做，<b>不会闷头失败</b>。' }));

    bossCard.appendChild(bb);
    /* ② 默认**收起**：这是全项目最危险的两个开关，平时不该占版面；
       收起时把"开着几个"写在标题行上 —— 收起来也不能让人忘了它开着。 */
    wrap.appendChild(foldCard(bossCard, '自动触达 BOSS', false, function () {
      var ab = global.ApplyBoss;
      var g = ab && ab.autoGreetOn ? ab.autoGreetOn() : !!cfg.autoGreet;
      var s = ab && ab.syncReplyOn ? ab.syncReplyOn() : !!cfg.syncReply;
      var n = (g ? 1 : 0) + (s ? 1 : 0);
      return n ? '\u26a0\ufe0f 有 ' + n + ' 个开关开着' : '两个开关都关着（安全默认）';
    }));

    /* ==================== 3. 提醒 ==================== */
    var notifyCard = el('div', { class: 'card' }, [el('header', {}, [el('h3', { text: '③ 面试提醒' })])]);
    var nb = el('div', { class: 'body' });
    var cbNotify = el('input', { type: 'checkbox' });
    cbNotify.checked = !!S.notify;
    cbNotify.addEventListener('change', function () {
      if (cbNotify.checked) App.askNotifyPermission();
      else { Store.setSetting('notify', false); U.toast('已关闭面试提醒', 'info'); }
    });
    nb.appendChild(el('label', { class: 'chk mb12' }, [cbNotify, el('span', { text: '开启面试提醒（浏览器通知 + 页面内提示）' })]));

    var ahead = S.notifyAhead || {};
    var aheadRow = el('div', { class: 'row', style: 'gap:14px' });
    [['day', '提前 1 天'], ['hour', '提前 2 小时'], ['min', '提前 30 分钟']].forEach(function (x) {
      var cb = el('input', { type: 'checkbox' });
      cb.checked = ahead[x[0]] !== false;
      cb.addEventListener('change', function () {
        var a = Object.assign({}, Store.settings().notifyAhead);
        a[x[0]] = cb.checked;
        Store.setSetting('notifyAhead', a);
      });
      aheadRow.appendChild(el('label', { class: 'chk' }, [cb, el('span', { text: x[1] })]));
    });
    nb.appendChild(el('div', { class: 'fs12 muted fw6 mb4', text: '提醒时机' }));
    nb.appendChild(aheadRow);
    nb.appendChild(el('div', { class: 'hint tiny mt8', html:
      '⚠️ 浏览器通知需要<b>这个页面保持打开</b>（可以最小化，但别关掉标签页）。' +
      '系统不允许网页在完全关闭后唤起通知 —— 这是浏览器的安全限制，无解。' }));
    notifyCard.appendChild(nb);
    wrap.appendChild(foldCard(notifyCard, '面试提醒', false, function () {
      var st = Store.settings();
      if (!st.notify) return '未开启';
      var a = st.notifyAhead || {};
      var bits = [];
      if (a.day !== false) bits.push('1 天');
      if (a.hour !== false) bits.push('2 小时');
      if (a.min !== false) bits.push('30 分钟');
      return bits.length ? '已开启 · 提前 ' + bits.join(' / ') : '已开启 · 没选提醒时机';
    }));

    /* ==================== 5. 外观 ==================== */
    var themeCard = el('div', { class: 'card' }, [el('header', {}, [el('h3', { text: '④ 外观' })])]);
    var tb = el('div', { class: 'body row' });
    [['light', '☀️ 浅色'], ['dark', '🌙 深色']].forEach(function (t) {
      tb.appendChild(el('button', {
        class: 'btn' + (S.theme === t[0] ? ' pri' : ''), text: t[1],
        onclick: function () { Store.setSetting('theme', t[0]); App.applyTheme(t[0]); App.refresh(); },
      }));
    });
    tb.appendChild(el('span', { class: 'sp' }));
    tb.appendChild(el('button', {
      class: 'btn', text: '收起 / 展开侧边栏',
      onclick: function () { U.$('#btnCollapse').click(); },
    }));
    themeCard.appendChild(tb);
    wrap.appendChild(foldCard(themeCard, '外观', false, function () {
      return Store.settings().theme === 'dark' ? '🌙 深色' : '☀️ 浅色';
    }));

    /* ==================== 6. 提示词 ==================== */
    var promptCard = el('div', { class: 'card' });
    promptCard.appendChild(el('header', {}, [
      el('h3', { text: '⑤ 自定义提示词' }),
      el('span', { class: 'sp' }),
      el('span', { class: 'hint', text: '留空 = 用内置模板' }),
    ]));
    var pb = el('div', { class: 'body' });
    pb.appendChild(el('div', { class: 'note warn mb12' }, [
      el('span', { class: 'ico', text: '⚠️' }),
      el('div', { html: '内置模板已经调过很多轮，<b>除非你明确知道自己在改什么，否则不建议动</b>。' +
        '尤其是「只输出 JSON、不要编造」这两条约束，去掉会让功能直接坏掉。' }),
    ]));

    Object.keys(AI.TPL).forEach(function (k) {
      var t = AI.TPL[k];
      var cur = (S.prompts || {})[k] || '';
      var ta = el('textarea', { rows: 6, class: 'mono', placeholder: '（留空使用内置模板）' });
      ta.value = cur;
      pb.appendChild(el('details', { class: 'fold mb8' }, [
        el('summary', { html: '<b>' + U.esc(t.label) + '</b> <span class="muted fs12">' + U.esc(t.desc || '') + '</span>' +
          (cur ? ' <span class="tag warn">已自定义</span>' : '') }),
        el('div', { class: 'fd' }, [
          ta,
          el('div', { class: 'row mt8' }, [
            el('button', {
              class: 'btn sm pri', text: '保存这段提示词',
              onclick: function () {
                var p = Object.assign({}, Store.settings().prompts);
                if (ta.value.trim()) p[k] = ta.value; else delete p[k];
                Store.setSetting('prompts', p);
                U.toast('已保存', 'ok');
                App.refresh();
              },
            }),
            el('button', {
              class: 'btn sm', text: '查看内置默认',
              onclick: function () {
                ta.value = t.sys;
                U.toast('已填入内置默认内容，确认后点保存', 'info');
              },
            }),
            (S.prompts || {})[k] ? el('button', {
              class: 'btn sm danger', text: '恢复默认（清空自定义）',
              onclick: function () {
                var p = Object.assign({}, Store.settings().prompts);
                delete p[k];
                Store.setSetting('prompts', p);
                ta.value = '';
                U.toast('已恢复内置模板', 'ok');
                App.refresh();
              },
            }) : null,
          ].filter(Boolean)),
        ]),
      ]));
    });
    promptCard.appendChild(pb);
    /* ③ 默认收起：11 个模板摊开就是 11 行，绝大多数人从不改。
       收起时把"改过几条"写在标题上 —— 自己改过什么，不能等展开才知道。 */
    wrap.appendChild(foldCard(promptCard, '自定义提示词', false, function () {
      var n = Object.keys(Store.settings().prompts || {}).length;
      var total = Object.keys(AI.TPL).length;
      return n ? '⚠️ 已自定义 ' + n + ' / ' + total + ' 项' : '全部用内置模板（' + total + ' 项）';
    }));

    /* ==================== 7. 数据 ==================== */
    var usage = Store.usage();
    var dataCard = el('div', { class: 'card' });
    dataCard.appendChild(el('header', {}, [el('h3', { text: '⑥ 数据与备份' }), el('span', { class: 'sp' }),
      el('span', { class: 'hint',
        /* 「其中约一半是备份」要说出来：save() 每次写主键前会把上一版整份复制到
           `<key>.bak`，所以占用数字天然是"数据 + 备份"。不说的话用户会以为
           自己的数据真有这么大，逼近 5MB 配额时也不知道该清什么（评审 A13）。 */
        text: '占用 ' + usage.text + '（浏览器上限约 5 MB）' +
          (usage.bakBytes ? '，其中约 ' + usage.bakText + ' 是上一版备份' : '') })]));
    var db = el('div', { class: 'body' });

    db.appendChild(el('div', { class: 'box mb12' }, [
      el('div', { class: 'row' }, [
        el('span', { class: 'fs13 fw6', text: '数据存在哪？' }),
        el('span', { class: 'sp' }),
        el('span', { class: Store.persistOK ? 'pill on' : 'pill off' }, [
          el('span', { class: 'dt' }), Store.persistOK ? '本地存储正常' : '本地存储不可用',
        ]),
      ]),
      el('div', { class: 'fs12 muted mt4', html:
        '全部数据保存在你浏览器的 <code class="mono">localStorage</code> 里，' +
        '<b>不上传任何服务器</b>。副作用：换浏览器、换电脑、清缓存都会丢 —— ' +
        '<b>所以请定期导出 JSON 备份</b>。' }),
      !Store.persistOK ? el('div', { class: 'note bad mt8' }, [
        el('span', { class: 'ico', text: '⛔' }),
        el('div', { text: Store.persistError }),
      ]) : null,
    ].filter(Boolean)));

    db.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'btn pri', html: '⤓ 导出全部数据（JSON）', onclick: function () {
        Exporter.exportJSONFlow();
      } }),
      el('button', { class: 'btn', html: '⤓ 导出全量 Excel', onclick: function () {
        Exporter.exportExcel(); U.toast('已导出多工作表 Excel', 'ok', 5000);
      } }),
      el('button', { class: 'btn', html: '📥 导入 JSON（合并）', onclick: function () { importFlow('merge'); } }),
      el('button', { class: 'btn', html: '📥 导入 JSON（覆盖）', onclick: function () { importFlow('replace'); } }),
    ]));

    /* ------------------------------------------------------------------
       备份提醒开关。
       ⚠️ 这个提醒会**主动弹 toast 催人**，所以必须给一个关掉的地方 ——
       一个关不掉的提醒等于骚扰。remindDays === 0 表示关掉（app.js 里按 0 判断）。
       ------------------------------------------------------------------ */
    var bk = S.backup || {};
    var bkDays = typeof bk.remindDays === 'number' ? bk.remindDays : 7;
    var cbRemind = el('input', { type: 'checkbox' });
    cbRemind.checked = bkDays > 0;

    var selDays = el('select', { class: 'inp', style: 'width:auto;min-width:118px' });
    [3, 7, 14, 30].forEach(function (d) {
      selDays.appendChild(el('option', { value: String(d), text: '每隔 ' + d + ' 天' }));
    });
    if (bkDays > 0) selDays.value = String(bkDays);
    selDays.disabled = bkDays <= 0;

    cbRemind.addEventListener('change', function () {
      if (cbRemind.checked) {
        var d = Number(selDays.value) || 7;
        Store.setSetting('backup.remindDays', d);
        Store.setSetting('backup.lastRemindedAt', null);   // 重开时按新口径立刻重算
        selDays.disabled = false;
        U.toast('会每隔 ' + d + ' 天提醒你备份', 'ok');
      } else {
        Store.setSetting('backup.remindDays', 0);
        selDays.disabled = true;
        U.toast('已关掉备份提醒', 'info');
      }
    });
    selDays.addEventListener('change', function () {
      Store.setSetting('backup.remindDays', Number(selDays.value));
      Store.setSetting('backup.lastRemindedAt', null);
    });

    var bkSince = Store.daysSinceExport();
    db.appendChild(el('div', { class: 'box mt12' }, [
      el('div', { class: 'row' }, [
        el('label', { class: 'chk' }, [cbRemind, el('span', { text: '定期提醒我导出备份' })]),
        el('span', { class: 'sp' }),
        selDays,
      ]),
      el('div', { class: 'fs12 muted mt4', html:
        (bkSince === null
          ? '你<b>还没导出过备份</b>。'
          : '上次导出是 <b>' + bkSince + ' 天前</b>。') +
        '提醒在打开工作台几秒后弹出，点里面的「去导出」能直接跳到这一页。' }),
    ]));

    db.appendChild(el('div', { class: 'divider' }));

    db.appendChild(el('div', { class: 'row' }, [
      el('button', { class: 'btn', html: '🎬 载入示例数据', onclick: function () {
        U.confirm('载入一套示例数据（5 个岗位 + 投递 + 面试 + 简历）？<br>' +
          '<span class="muted fs12">会加到你现有数据里，不会覆盖。想清掉可以随时用「清空全部数据」。</span>').then(function (ok) {
          if (!ok) return;
          var r = Store.loadDemo();
          U.toast('已载入 ' + r.jobs + ' 个示例岗位 ✅', 'ok');
          App.updateNavCounts(); App.refresh();
        });
      } }),
      el('button', { class: 'btn danger', html: '🗑 清空全部数据', onclick: function () {
        U.confirm('确定要<b>清空全部数据</b>吗？<br>' +
          '<span class="muted fs12">岗位、投递、面试、简历、素材、对话全部删除，无法恢复。</span><br>' +
          '<b>强烈建议先导出 JSON 备份。</b>', { danger: true, okText: '我确定，清空' }).then(function (ok) {
          if (!ok) return;
          Store.clearAll(false);
          U.toast('已清空', 'ok');
          App.applyTheme(Store.settings().theme);
          App.updateNavCounts();
          App.go('jobs');
        });
      } }),
    ]));

    db.appendChild(el('div', { class: 'divider' }));

    db.appendChild(el('details', { class: 'fold' }, [
      el('summary', { text: '⚙️ 高级：和本地 boss-crawler 脚本配合' }),
      el('div', { class: 'fd', html:
        '你这个项目里还装了一个本地技能 <code class="mono">boss-crawler</code>（命令行版），' +
        '它能真的去 BOSS 把岗位抓回来（需要扫码登录，跑一轮几十分钟）。<br><br>' +
        '<b>现在不用手动导文件了</b>：到侧边栏 <b>📡 采集岗位</b>，双击工作台文件夹里的 ' +
        '<code class="mono">启动采集器.cmd</code>，就能在网页上直接触发采集、实时看日志、一键导入。<br><br>' +
        '想手动导也行 —— 到<b>岗位库 → 「从爬虫结果导入」</b>，选它的产物文件：<br>' +
        '<code class="mono fs12">~/.workbuddy/skills/boss-crawler/assets/&lt;时间戳&gt;/qualified_jobs.json</code><br>' +
        '或同目录下的 <code class="mono fs12">postdata/*.csv</code>。<br><br>' +
        '两个工具的分工：<b>采集器负责把岗位捞回来，这个网页负责解析、跟踪、复盘、统计</b>。' }),
    ]));

    dataCard.appendChild(db);
    wrap.appendChild(foldCard(dataCard, '数据与备份', false, function () {
      return '占用 ' + Store.usage().text;
    }));

    /* ==================== 8. 关于 ==================== */
    var aboutCard = el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '⑦ 关于这个工作台' })]),
      el('div', { class: 'body fs12 muted', html:
        '<b>求职猎手工作台</b> · 单页应用，纯前端，零依赖，数据全在本地。<br><br>' +
        '<b>岗位从哪来</b>：默认靠你从 BOSS 页面复制粘贴。想要批量的话，可以启用本地采集器' +
        '（<b>📡 采集岗位</b> 页 → 双击 <code class="mono">启动采集器.cmd</code>）：' +
        '它弹一个真实浏览器让你自己扫码登录，通过页面自身的数据接口读取岗位（浏览器加载页面时本来就会请求的接口）。<br><br>' +
        '<b>不做的事</b>：不代填你的账号密码、' +
        '<b>不自动发消息、不自动投递</b> —— 投递永远是你自己在 BOSS 里手动点。' +
        '注意：接口级读取比手动翻页更易触发风控，工具已做限速与冷却，但不能保证不触发。' +
        '所有 AI 生成的文案（打招呼话术、沟通文案）也都由你手动复制发送。<br><br>' +
        '数据格式版本：schema v' + (Store.raw().schema || 1) + ' · 创建于 ' + U.d2(Store.raw().createdAt) }),
      // 快捷键原来只以纯文本埋在上面那段话里，基本没人会翻到。
      // 这里给一个明确的按钮入口（和侧边栏底部那个是同一个弹窗）。
      el('div', { class: 'body tight row', style: 'gap:8px;border-top:1px solid var(--line-2)' }, [
        el('span', { class: 'fs12 muted', html: '快捷键：<code class="mono">Ctrl + K</code> 唤起 AI 快速问答 · <code class="mono">Esc</code> 关闭弹窗' }),
        el('span', { class: 'sp' }),
        el('button', { class: 'btn xs', html: '⌨ 看全部快捷键', onclick: function () { App.openHelp(); } }),
      ]),
    ]);
    wrap.appendChild(foldCard(aboutCard, '关于这个工作台', false, function () {
      return 'schema v' + (Store.raw().schema || 1);
    }));
  }

  function importFlow(mode) {
    mode = mode || 'merge';
    var desc = mode === 'replace'
      ? '<b>覆盖模式</b>：当前所有数据会被文件里的内容完全替换。建议先导出备份。'
      : '<b>合并模式</b>：按链接 / 公司+岗位去重，重复的只补空字段，不覆盖你已经改过的内容。';
    U.confirm(desc + '<br><br>选择 JSON 备份文件继续？', { okText: '选文件', title: '导入备份' }).then(function (ok) {
      if (!ok) return;
      Exporter.importJSON(mode).then(function (r) {
        if (!r) return;
        U.toast('导入完成：新增 岗位 ' + r.jobs + ' / 投递 ' + r.apps + ' / 面试 ' + r.interviews +
          ' / 简历 ' + r.resumes + '，合并跳过 ' + r.skipped + ' 条', 'ok', 7000);
        Store.fire('all');
        App.updateNavCounts();
        App.refresh();
      }).catch(function (e) { U.toast('导入失败：' + e.message, 'bad', 8000); });
    });
  }

  global.Views.settings = {
    title: '设置',
    render: render,
    PRESETS: PRESETS,
    // 「整卡折叠」的落盘键与读法（测试直接驱动，不靠猜 localStorage 键名）
    _foldKey: FOLD_KEY,
    _readFolds: readFolds,
  };
})(window);
