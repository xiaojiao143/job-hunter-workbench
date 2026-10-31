/* ==========================================================================
   view-assistant.js · 模块 5：AI 求职助手
   独立对话页 + 六个快捷任务（结果全部落进对话历史，可绑定岗位）
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;
  var cur = null;            // 当前对话 id
  var busy = false;
  var convEl = null;         // 当前对话的滚动容器（流式输出时直接操作它，不整页重绘）

  /* ⛔ 这几个模板的输出是 JSON（见 aiBubbleNode）。**必须放模块级**：
     放进 render() 里的话，`paintSide(); paintMain();` 在这一行执行之前就被调用了，
     `var` 提升拿到的是 undefined → `JSON_TPLS.indexOf` 抛错、整页掉进兜底卡。实测踩过。 */
  var JSON_TPLS = ['jobParse', 'match', 'interviewPrep', 'simReview'];

  function lastChatId() {
    try { return localStorage.getItem('jh.assistant.lastChat'); } catch (e) { return null; }
  }
  function rememberChat(id) {
    try { localStorage.setItem('jh.assistant.lastChat', id); } catch (e) { /* noop */ }
  }

  function kindLabel(k) {
    return {
      free: '自由问答', jobparse: 'JD 解析', match: '匹配评估', greeting: '打招呼话术',
      interview: '面试材料', rejection: '沟通文案', review: '面试复盘', compare: '岗位对比',
    }[k] || '对话';
  }

  /* ==================== 页面 ==================== */
  function render(root, params) {
    var wrap = el('div', { class: 'wrap' });
    root.appendChild(wrap);

    App.topActions([
      el('button', { class: 'btn pri', html: '＋ 新对话', onclick: newChat }),
      el('button', { class: 'btn', html: '🗑 清空全部对话', onclick: clearAllChats }),
    ]);

    var note = Comp.aiReadyNote();
    if (note) wrap.appendChild(note);

    var layout = el('div', { class: 'grid', style: 'grid-template-columns:250px minmax(0,1fr);gap:14px;align-items:start' });
    wrap.appendChild(layout);

    var sideBox = el('div', { class: 'card' });
    var mainBox = el('div', { class: 'card' });
    layout.appendChild(sideBox);
    layout.appendChild(mainBox);

    // 定当前对话
    if (params && params.chatId && Store.chat(params.chatId)) cur = params.chatId;
    if (!cur && lastChatId() && Store.chat(lastChatId())) cur = lastChatId();
    if (!cur && Store.chats()[0]) cur = Store.chats()[0].id;
    if (cur) rememberChat(cur);

    paintSide();
    paintMain();

    /* ---------------- 左侧：对话列表 ---------------- */
    function paintSide() {
      sideBox.innerHTML = '';
      sideBox.appendChild(el('header', {}, [
        el('h3', { text: '对话记录' }),
        el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: Store.chats().length + ' 个' }),
      ]));
      var list = Store.chats();
      if (!list.length) {
        sideBox.appendChild(el('div', { class: 'body' }, [
          el('div', { class: 'muted fs12', text: '还没有对话。右边挑个快捷任务开始。' }),
        ]));
        return;
      }
      var box = el('div', { style: 'max-height:64vh;overflow-y:auto' });
      list.forEach(function (c) {
        var j = c.jobId ? Store.job(c.jobId) : null;
        box.appendChild(el('div', {
          class: 'li pointer', style: 'cursor:pointer;' + (c.id === cur ? 'background:var(--brand-soft)' : ''),
          onclick: function () { cur = c.id; rememberChat(cur); paintSide(); paintMain(); },
        }, [
          el('div', { class: 'li-main' }, [
            el('div', { class: 'li-t' }, [el('span', { class: 'fs13', text: U.truncate(c.title, 16) })]),
            el('div', { class: 'li-s' }, [
              el('span', { text: kindLabel(c.kind) }),
              j ? el('span', { text: U.truncate(j.title || '', 10) }) : null,
              el('span', { text: U.rel(c.updatedAt) }),
            ].filter(Boolean)),
          ]),
          el('button', {
            class: 'btn xs ghost', text: '✕', title: '删除这个对话',
            onclick: function (e) {
              e.stopPropagation();
              var wasCur = cur === c.id;
              var snap = Store.takeOut({ chats: [c.id] });
              if (wasCur) cur = Store.chats()[0] ? Store.chats()[0].id : null;
              if (cur) rememberChat(cur);
              paintSide(); paintMain(); App.updateNavCounts();
              Comp.trashToast('已删除对话「' + U.truncate(c.title || '', 12) + '」', snap, function () {
                paintSide(); paintMain(); App.updateNavCounts();
              });
            },
          }),
        ]));
      });
      sideBox.appendChild(box);
    }

    function ensureChat() {
      if (!cur || !Store.chat(cur)) {
        var c = Store.addChat({ kind: 'free', title: '新对话' });
        cur = c.id; rememberChat(cur);
      }
      return Store.chat(cur);
    }

    /* ---------------- 右侧：对话区 ---------------- */
    function paintMain() {
      mainBox.innerHTML = '';
      var c = ensureChat();
      var j = c.jobId ? Store.job(c.jobId) : null;

      /* 头部 */
      var head = el('div', { class: 'body tight bb' });
      head.appendChild(el('div', { class: 'row' }, [
        el('b', { class: 'fs14', text: c.title }),
        el('span', { class: 'sp' }),
        el('span', { class: 'fs12 muted', text: '绑定岗位：' }),
        j ? el('span', {
          class: 'tag brand', html: U.esc(j.title || '') + ' <span class="x">✕</span>', title: '点 ✕ 解除绑定',
          onclick: function () { Store.updateChat(c.id, { jobId: '' }); paintMain(); },
        }) : el('button', {
          class: 'btn xs', text: '＋ 选择岗位',
          onclick: function () {
            Comp.jobPicker({ title: '把这个对话绑定到哪个岗位？' }).then(function (jid) {
              if (!jid) return;
              var jj = Store.job(jid);
              Store.updateChat(c.id, {
                jobId: jid,
                title: (c.title === '新对话' || c.title === '快速问答') ? (jj.title || '岗位对话') : c.title,
              });
              paintSide(); paintMain();
            });
          },
        }),
      ]));

      /* 快捷任务 */
      var tasks = el('div', { class: 'row mt8', style: 'gap:6px' });
      tasks.appendChild(el('span', { class: 'fs12 muted', text: '快捷任务：' }));
      [
        { l: '📋 粘贴 JD 解析', fn: taskParseJD },
        { l: '🎯 简历匹配打分', fn: taskMatch },
        { l: '👋 打招呼话术', fn: taskGreeting },
        { l: '🎙️ 面试准备材料', fn: taskPrep },
        { l: '✉️ 沟通 / 拒绝文案', fn: taskRejection },
        { l: '🔍 面试复盘', fn: taskReview },
      ].forEach(function (t) {
        tasks.appendChild(el('button', { class: 'btn xs', text: t.l, onclick: t.fn }));
      });
      head.appendChild(tasks);
      mainBox.appendChild(head);

      /* 对话内容 */
      convEl = el('div', { class: 'body', style: 'max-height:56vh;overflow-y:auto;min-height:230px' });
      if (!c.messages.length) {
        convEl.appendChild(emptyState());
      } else {
        convEl.appendChild(el('div', { class: 'bubbles' },
          c.messages.map(function (m) { return bubble(m); })));
      }
      mainBox.appendChild(convEl);
      setTimeout(function () { if (convEl) convEl.scrollTop = convEl.scrollHeight; }, 30);

      /* 输入区 */
      var ta = el('textarea', { rows: 2, placeholder: '问点什么…（Ctrl + Enter 发送）', style: 'min-height:52px' });
      ta.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); send(); }
      });
      mainBox.appendChild(el('div', { class: 'body tight bt row', style: 'align-items:flex-end' }, [
        el('div', { class: 'flex1' }, [ta]),
        el('button', { class: 'btn pri', text: '发送', onclick: send }),
      ]));

      function send() {
        if (busy) return;
        var text = ta.value.trim();
        if (!text) return;
        if (!AI.ready()) {
          U.toast('还没配置模型 API，请先到设置页填 Key。', 'warn');
          App.go('settings');
          return;
        }
        ta.value = '';
        var chat = ensureChat();
        Store.pushMessage(chat.id, 'user', text);
        paintMain();                                   // 先把用户消息画出来
        streamReply(chat.id, { history: true }, paintSide);
      }
    }

    function emptyState() {
      return el('div', { class: 'empty' }, [
        el('div', { class: 'big', text: '🤖' }),
        el('b', { text: '想聊点什么？' }),
        el('p', { html:
          '· 点上面的<b>快捷任务</b>，一键生成话术 / 面试题 / 匹配评估<br>' +
          '· 或者直接在下面<b>打字提问</b>，比如「面试被问空窗期怎么答」' }),
      ]);
    }

    /** 把对话容器换成 bubbles 结构，返回 bubbles 节点 */
    function bubblesOf() {
      if (!convEl) return null;
      var b = convEl.querySelector('.bubbles');
      if (!b) {
        convEl.innerHTML = '';
        b = el('div', { class: 'bubbles' });
        convEl.appendChild(b);
      }
      return b;
    }

    /* ---------------- 气泡 ---------------- */
    /* ⛔ JSON 模板产出的是**对象**，不是散文。以前直接 App.md(原文) 渲染，
       于是模型给的英文键（score / verdict / category …）被当成 Markdown 摆到界面上。
       现在先解析出对象、交给 Comp.aiResultNode 出中文面板；解析不出来才退回 Markdown。 */
    function aiBubbleNode(tpl, text) {
      if (JSON_TPLS.indexOf(tpl) < 0) return null;
      var data = U.extractJSON(text);
      return (data && typeof data === 'object') ? Comp.aiResultNode(data) : null;
    }

    function bubble(m) {
      var isMe = m.role === 'user';
      var tpl = m.meta && m.meta.tpl;
      /* 历史回复也要走中文面板 —— 只在 streamReply 里改的话，
         切走再切回来（走这条历史渲染）英文标题就又冒出来了。 */
      var node = isMe ? null : aiBubbleNode(tpl, m.content);
      var inner = [node ? el('div', { class: 'txt' }, [node])
                       : el('div', { class: 'txt', html: App.md(m.content) })];
      if (!isMe) inner.push(extraRow(m.content, tpl, paintMain));
      return el('div', { class: 'bub ' + (isMe ? 'me' : 'ai') }, [
        el('div', { class: 'av', text: isMe ? '我' : 'AI' }),
        el('div', { class: 'flex1' }, inner),
      ]);
    }

    /** AI 消息下方的操作行：复制 / 存到岗位库 */
    function extraRow(content, tpl, repaint) {
      var row = el('div', { class: 'row mt4', style: 'gap:5px' });
      row.appendChild(Comp.copyBtn(content, '复制'));
      if (tpl === 'jobParse') {
        var parsed = U.extractJSON(content);
        if (parsed) {
          row.appendChild(el('button', {
            class: 'btn xs pri', html: '存到岗位库',
            onclick: function () {
              var r = Store.addJob(parsed);
              U.toast(r.dup ? '已合并到已有岗位（识别到重复）' : '已存入岗位库 ✅', 'ok');
              App.updateNavCounts();
              if (repaint) repaint();
            },
          }));
        }
      }
      return row;
    }

    /* ---------------- 流式回答 ----------------
       关键：不重绘整个页面，直接把 AI 气泡 append 进 .bubbles，
       拿到 .txt 的直接引用去改内容 —— 打字机不闪，滚动位置也稳。
    --------------------------------------------- */
    function streamReply(chatId, opt, repaintSide) {
      if (!AI.ready()) { U.toast('还没配置模型 API', 'warn'); return; }
      var c = Store.chat(chatId);
      if (!c) return;

      var sysText = (Store.settings().prompts || {})[opt.tpl] || (AI.TPL[opt.tpl] || AI.TPL.free).sys;
      var msgs = [{ role: 'system', content: sysText }];
      if (opt.history) {
        c.messages.slice(-10).forEach(function (m) { msgs.push({ role: m.role, content: m.content }); });
      } else if (opt.prompt) {
        msgs.push({ role: 'user', content: opt.prompt });
      }

      var bubbles = bubblesOf();
      if (!bubbles) return;

      var txt = el('div', { class: 'txt' }, [el('span', { class: 'spin' }), ' 正在生成…']);
      var holder = el('div', { class: 'flex1' }, [txt]);
      bubbles.appendChild(el('div', { class: 'bub ai' }, [el('div', { class: 'av', text: 'AI' }), holder]));
      if (convEl) convEl.scrollTop = convEl.scrollHeight;

      busy = true;
      var acc = '';

      AI.chat({
        messages: msgs,
        json: !!opt.json,
        onDelta: function (d, full) {
          acc = full;
          txt.innerHTML = App.md(full) + '<span class="cur"></span>';
          if (convEl) convEl.scrollTop = convEl.scrollHeight;
        },
      }).then(function (full) {
        busy = false;
        var text = full || acc || '';
        // JSON 模板：别把裸 JSON 摆进气泡（英文键会被当成标题）
        var node = aiBubbleNode(opt.tpl, text);
        if (node) { txt.innerHTML = ''; txt.appendChild(node); }
        else { txt.innerHTML = App.md(text); }
        holder.appendChild(extraRow(text, opt.tpl, null));
        Store.pushMessage(chatId, 'assistant', text, { tpl: opt.tpl || '' });
        Store.flush();
        if (convEl) convEl.scrollTop = convEl.scrollHeight;
        paintSide();
        App.updateNavCounts();
        if (repaintSide) repaintSide();
      }).catch(function (e) {
        busy = false;
        txt.innerHTML = '<span class="bad-c">⚠️ ' + U.esc(e.message) + '</span>';
        if (convEl) convEl.scrollTop = convEl.scrollHeight;
      });
    }

    /* ---------------- 快捷任务 ---------------- */
    function taskParseJD() {
      var ta = el('textarea', { rows: 9, placeholder: '把 BOSS 上的岗位文字整段粘进来…' });
      U.openModal({
        title: '粘贴 JD → AI 解析',
        size: 'wide',
        body: el('div', { class: 'fld' }, [
          el('label', { class: 'lb', text: '岗位原始文字' }),
          ta,
          el('div', { class: 'hint tiny mt4', text: '解析结果会出现在对话里，可以直接点「存到岗位库」。' }),
        ]),
        footer: [
          { text: '开始解析', cls: 'pri', onClick: function (c2) {
            var t = ta.value.trim();
            if (t.length < 15) { U.toast('内容太短，至少把岗位名称和任职要求粘进来', 'warn'); return; }
            c2();
            var chat = ensureChat();
            Store.pushMessage(chat.id, 'user', '📋 帮我解析这个岗位：\n' + U.truncate(t, 500));
            if (chat.title === '新对话') Store.updateChat(chat.id, { kind: 'jobparse', title: 'JD 解析' });
            paintSide(); paintMain();
            streamReply(chat.id, {
              tpl: 'jobParse', json: true,
              prompt: AI.TPL.jobParse.user({ text: t }),
            }, paintSide);
          } },
          { text: '取消', onClick: function (c2) { c2(); } },
        ],
      });
    }

    /** 先确定岗位（优用当前绑定），再交给 cb */
    function pickJobThen(title, cb) {
      var c = ensureChat();
      var curJob = c.jobId ? Store.job(c.jobId) : null;
      if (curJob) {
        U.confirm('就用当前绑定的岗位「<b>' + U.esc(curJob.title || '') + '</b>」吗？<br>' +
          '<span class="muted fs12">点「取消」可以改选别的岗位。</span>', { okText: '就用它' })
          .then(function (yes) {
            if (yes) cb(curJob.id);
            else Comp.jobPicker({ title: title }).then(function (jid) { if (jid) cb(jid); });
          });
      } else {
        Comp.jobPicker({ title: title }).then(function (jid) { if (jid) cb(jid); });
      }
    }

    /** 有多个简历时先让用户挑 */
    function pickResumeThen(cb) {
      if (Store.resumes().length > 1) {
        Comp.resumePicker({ title: '用哪份简历？' }).then(function (rid) { if (rid) cb(rid); });
      } else {
        var d = Store.defaultResume();
        cb(d ? d.id : null);
      }
    }

    function taskMatch() {
      pickJobThen('给哪个岗位做匹配评估？', function (jobId) {
        var j = Store.job(jobId);
        pickResumeThen(function (rid) {
          var r = rid ? Store.resume(rid) : null;
          if (!r) { U.toast('还没有简历，先去「简历素材库」添加一份', 'warn'); return; }
          var chat = ensureChat();
          Store.pushMessage(chat.id, 'user', '🎯 用「' + r.name + '」评估我投「' + (j.title || '') + '」的匹配度');
          if (chat.title === '新对话') Store.updateChat(chat.id, { kind: 'match', jobId: jobId, title: '匹配评估' });
          else Store.updateChat(chat.id, { jobId: jobId });
          paintSide(); paintMain();
          streamReply(chat.id, {
            tpl: 'match', json: true,
            prompt: AI.TPL.match.user({ resume: AI.resumeToText(r), job: AI.jobToText(j, true) }),
          }, paintSide);
        });
      });
    }

    function taskGreeting() {
      pickJobThen('给哪个岗位写打招呼话术？', function (jobId) {
        var j = Store.job(jobId);
        pickResumeThen(function (rid) {
          var r = rid ? Store.resume(rid) : null;
          var chat = ensureChat();
          Store.pushMessage(chat.id, 'user', '👋 给「' + (j.title || '') + '」写一段 BOSS 打招呼话术');
          if (chat.title === '新对话') Store.updateChat(chat.id, { kind: 'greeting', jobId: jobId, title: '打招呼话术' });
          else Store.updateChat(chat.id, { jobId: jobId });
          paintSide(); paintMain();
          streamReply(chat.id, {
            tpl: 'greeting',
            prompt: AI.TPL.greeting.user({
              job: AI.jobToText(j), resume: r ? AI.resumeToText(r, 1600) : '',
            }),
          }, paintSide);
        });
      });
    }

    function taskPrep() {
      pickJobThen('给哪个岗位生成面试准备材料？', function (jobId) {
        // 复用面试管理里的完整实现（会直接存进面试记录）
        AIInterview.prepFor(jobId, {
          onSaved: function () { App.updateNavCounts(); App.refresh(); },
        });
      });
    }

    function taskRejection() {
      var scenes = ['拒绝 offer', '婉拒面试邀约', '面试后不想去了', '催 HR 反馈进度', '要求涨薪 / 谈 offer', '延后入职时间'];
      var sceneSel = el('select');
      scenes.forEach(function (s) { sceneSel.appendChild(el('option', { value: s, text: s })); });
      var reasonTa = el('textarea', { rows: 3, placeholder: '你想表达的原因（选填），比如：拿到更匹配的岗位 / 通勤太远 / 薪资差距大' });
      U.openModal({
        title: '生成沟通文案',
        body: el('div', { class: 'stack' }, [
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '场景' }), sceneSel]),
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '原因（选填）' }), reasonTa]),
        ]),
        footer: [
          { text: '下一步：选岗位', cls: 'pri', onClick: function (c2) {
            c2();
            pickJobThen('这段文案是发给哪个岗位的？', function (jobId) {
              var j = Store.job(jobId);
              var chat = ensureChat();
              Store.pushMessage(chat.id, 'user', '✉️ ' + sceneSel.value + '：' + (j.title || ''));
              if (chat.title === '新对话') Store.updateChat(chat.id, { kind: 'rejection', jobId: jobId, title: '沟通文案' });
              else Store.updateChat(chat.id, { jobId: jobId });
              paintSide(); paintMain();
              streamReply(chat.id, {
                tpl: 'rejection',
                prompt: AI.TPL.rejection.user({
                  scene: sceneSel.value, job: AI.jobToText(j), reason: reasonTa.value.trim(),
                }),
              }, paintSide);
            });
          } },
          { text: '取消', onClick: function (c2) { c2(); } },
        ],
      });
    }

    function taskReview() {
      var all = Store.interviews();
      if (!all.length) { U.toast('还没有面试记录，先去「面试管理」记一场', 'warn'); return; }
      var list = all.filter(function (v) { return v.status === 'done' || v.notes; });
      if (!list.length) list = all;

      var body = el('div', { class: 'stack', style: 'gap:7px;max-height:50vh;overflow-y:auto' });
      var m = null;
      list.forEach(function (v) {
        var j = Store.job(v.jobId) || {};
        body.appendChild(el('div', {
          class: 'box pointer', style: 'cursor:pointer',
          onclick: function () {
            if (m) m.close();
            var chat = ensureChat();
            Store.pushMessage(chat.id, 'user', '🔍 帮我复盘这场面试：' + (j.title || '') + ' · ' + v.round);
            if (chat.title === '新对话') Store.updateChat(chat.id, { kind: 'review', jobId: v.jobId, title: '面试复盘' });
            else Store.updateChat(chat.id, { jobId: v.jobId });
            paintSide(); paintMain();
            streamReply(chat.id, {
              tpl: 'review',
              prompt: AI.TPL.review.user({ job: AI.jobToText(j), round: v.round, notes: v.notes }),
            }, paintSide);
          },
        }, [
          el('div', { class: 'row' }, [
            el('b', { class: 'fs13', text: (j.title || '') + ' · ' + v.round }),
            el('span', { class: 'sp' }),
            el('span', { class: 'muted fs12', text: v.at ? U.d2(v.at) : '未定时间' }),
          ]),
          el('div', { class: 'fs12 muted clamp2', text: U.truncate(v.notes || '（这场面试没有记录内容）', 90) }),
        ]));
      });
      m = U.openModal({
        title: '选一场面试做复盘',
        size: 'wide',
        body: body,
        footer: [{ text: '取消', onClick: function (c2) { c2(); } }],
      });
    }

    function newChat() {
      var c = Store.addChat({ kind: 'free', title: '新对话' });
      cur = c.id; rememberChat(cur);
      paintSide(); paintMain(); App.updateNavCounts();
    }

    function clearAllChats() {
      U.confirm('确定清空<b>全部 AI 对话记录</b>吗？<br><span class="muted fs12">岗位、投递、面试数据不受影响。</span>',
        { danger: true, okText: '清空' }).then(function (ok) {
        if (!ok) return;
        Store.chats().forEach(function (c) { Store.removeChat(c.id); });
        cur = null;
        paintSide(); paintMain(); App.updateNavCounts();
        U.toast('已清空对话记录', 'ok');
      });
    }
  }

  /** 供其他页面开一个新对话 */
  function openWithChat(kind, title, jobId) {
    var c = Store.addChat({ kind: kind, title: title || '新对话', jobId: jobId || '' });
    App.go('assistant', { chatId: c.id });
    return c;
  }

  global.Views.assistant = {
    title: 'AI 求职助手',
    render: render,
    openWithChat: openWithChat,
    kindLabel: kindLabel,
  };
})(window);
