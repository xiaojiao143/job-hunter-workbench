/* ==========================================================================
   interview-sim.js · 模块 10：AI 面试模拟器
   --------------------------------------------------------------------------
   选岗位 + 简历 → AI 扮演面试官**连环追问**（一次只问一题，会顺着你的回答追细节）
   → 答完点「结束并复盘」→ 出逐题点评、更好的答法、下一步准备方向。
   复盘写回岗位（岗位详情里能回看），也可以「另存为一场面试记录」。

   两段提示词在 ai.js：interviewer（面试官扮演，不走 JSON）+ simReview（复盘，走 JSON）。
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  /* ==================== 入口 ==================== */
  function start(jobId, opt) {
    opt = opt || {};
    var j = Store.job(jobId);
    if (!j) { U.toast('岗位不存在', 'warn'); return; }
    if (!AI.ready()) {
      U.toast('模拟面试要用大模型。先到「设置 → ① 大模型接口」填好 API Key。', 'warn', 7000);
      return;
    }
    openSetup(j, opt);
  }

  /* ---------------- 开场设置：轮次 / 简历 / 题量 ---------------- */
  function openSetup(j, opt) {
    var resumes = Store.resumes();
    var f = Comp.fields([
      { key: 'round', label: '模拟哪一轮', type: 'select', options: Store.ROUNDS, value: '一面（技术/业务）' },
      {
        key: 'resumeId', label: '用哪份简历', type: 'select',
        options: resumes.length
          ? resumes.map(function (r) { return { value: r.id, label: r.name + (r.isDefault ? '（默认）' : '') }; })
          : [{ value: '', label: '（还没有简历，将不带简历信息）' }],
        value: resumes.length ? (Store.defaultResume() || resumes[0]).id : '',
      },
      { key: 'count', label: '大概问几题', type: 'select', options: [
        { value: '3', label: '3 题（快速热身，约 5 分钟）' },
        { value: '5', label: '5 题（标准，约 10 分钟）' },
        { value: '8', label: '8 题（压力局，约 20 分钟）' },
      ], value: '5' },
    ], 2);

    U.openModal({
      title: '🎤 模拟面试 · ' + (j.title || ''),
      size: 'wide',
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'note info' }, [
          el('span', { class: 'ico', text: '🎭' }),
          el('div', { html:
            '<b>AI 会扮演这个岗位的面试官，一次只问一个问题，并顺着你的回答追问细节。</b><br>' +
            '它全程不会点评、不会给答案 —— 所有点评留到最后一次性给你。<br>' +
            '<span class="fs12">建议：像真的面试一样**用语音或完整句子回答**，别只敲几个字，否则复盘会失真。</span>' }),
        ]),
        f.node,
        el('div', { class: 'note line fs12', html:
          '这一轮问答会存在本地（岗位详情里能回看）。本工作台依然<b>不代发消息、不代投递</b>。' }),
      ]),
      footer: [
        { text: '开始面试', cls: 'pri', onClick: function (c) {
          var v = f.values();
          var r = v.resumeId ? Store.resume(v.resumeId) : null;
          c();
          runChat(j, {
            round: v.round,
            resume: r,
            count: parseInt(v.count, 10) || 5,
          }, opt);
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  /* ==================== 对话主体 ==================== */
  function runChat(j, setup, opt) {
    var history = [];
    var qs = [];          // 面试官问过的问题
    var answers = [];     // 对应回答
    var transcript = [];  // [{q, a}]
    var busy = false;
    var ended = false;

    var brief =
      '【本场面试背景（候选人看不到，你据此命题）】\n' +
      '岗位：' + (j.title || '') + '　公司：' + (j.company || '') + '\n' +
      '岗位要求：' + [j.reqDegree, j.reqYears].filter(Boolean).join(' / ') +
      ((j.reqSkills || []).length ? '，技能：' + j.reqSkills.join('、') : '') + '\n' +
      ((j.duties || []).length ? '职责：' + j.duties.join('；') + '\n' : '') +
      (setup.resume ? '候选人简历要点：' + U.truncate(AI.resumeToText(setup.resume), 1500) + '\n' : '（候选人没提供简历）\n') +
      '面试轮次：' + setup.round + '\n' +
      '一共问大约 ' + setup.count + ' 个问题，问完最后一个后不要再提问，等候选人点结束。';

    history.push({ role: 'system', content: AI.TPL.interviewer.sys + '\n\n' + brief });

    /* --- 界面 --- */
    var chatBox = el('div', { class: 'bubbles simbox' });
    var ta = el('textarea', { rows: 3, placeholder: '像真面试一样回答（多点细节，AI 会顺着追问）…　Ctrl + Enter 发送' });
    var sendBtn = el('button', { class: 'btn pri', text: '发送回答', onclick: send });
    var doneBtn = el('button', { class: 'btn', html: '🏁 结束并复盘', onclick: endAndReview });
    var skipBtn = el('button', { class: 'btn ghost sm', text: '这题跳过 →', onclick: skip });
    var tip = el('div', { class: 'hint tiny' });
    var countEl = el('span', { class: 'tag', text: '已答 0 题' });

    function setTip(t, cls) { tip.className = 'hint tiny ' + (cls || ''); tip.textContent = t; }

    var m = U.openModal({
      title: '🎤 模拟面试中 · ' + (j.title || ''),
      size: 'wide',
      maskClose: false,
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'tag brand', text: setup.round }),
          countEl,
          setup.resume ? el('span', { class: 'tag', text: '简历：' + setup.resume.name }) : null,
          el('span', { class: 'sp' }),
          el('span', { class: 'hint tiny', text: 'AI 不会中途点评，点评留到最后' }),
        ].filter(Boolean)),
        chatBox,
        el('div', { class: 'fld' }, [ta]),
        el('div', { class: 'row' }, [
          sendBtn, skipBtn, el('span', { class: 'sp' }), doneBtn,
        ]),
        tip,
      ]),
      footer: [{ text: '先退出', onClick: function (c) {
        U.confirm('退出后这轮的问答不会保存（除非你先点「结束并复盘」）。确定退出？',
          { title: '退出模拟面试', danger: true, okText: '退出' }).then(function (ok) { if (ok) c(); });
      } }],
    });

    ta.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); send(); }
    });

    /* ⛔ 这里原来有个 `var pendingBubble = null;` —— 全文件只出现「声明」和
       `ask()` 开头的「置 null」两次，**从未被读取**，是"没有开场提问"留下的死壳。
       已连同 `ask()` 里那句赋值一起删掉（评审 P1-10）。 */

    function bubble(role, html, isMd) {
      var txt = el('div', { class: 'txt' });
      if (isMd) txt.innerHTML = html; else txt.textContent = html;
      var b = el('div', { class: 'bub ' + (role === 'me' ? 'me' : 'ai') }, [
        el('div', { class: 'av', text: role === 'me' ? '我' : 'HR' }),
        txt,
      ]);
      chatBox.appendChild(b);
      chatBox.scrollTop = chatBox.scrollHeight;
      return txt;
    }

    function busyOn(on) {
      busy = on;
      sendBtn.disabled = on;
      skipBtn.disabled = on;
      doneBtn.disabled = on;
      ta.disabled = on;
      countEl.textContent = '已答 ' + answers.length + ' 题';
      if (!on) { try { ta.focus(); } catch (e) { /* noop */ } }
    }

    /** 让面试官开口（第一题 or 追问） */
    function ask(text) {
      bubble('me', text);
      history.push({ role: 'user', content: text });
      busyOn(true);
      setTip('面试官正在想下一个问题…');

      var holder = bubble('ai', '<span class="spin"></span> 正在思考…', true);
      var acc = '';
      AI.chat({
        messages: history,
        timeout: 120,
        onDelta: function (d, full) {
          acc = full;
          holder.innerHTML = App.md(full) + '<span class="cur"></span>';
          chatBox.scrollTop = chatBox.scrollHeight;
        },
      }).then(function (full) {
        var q = String(full || acc || '').trim();
        if (!q) { q = '（面试官没有输出内容，可以直接再问一次，或点结束复盘）'; }
        holder.innerHTML = App.md(q);
        history.push({ role: 'assistant', content: q });
        qs.push(q);
        answers.push(null);
        busyOn(false);
        setTip(answers.length >= setup.count
          ? '已经问完 ' + setup.count + ' 题左右 —— 可以点右下角「结束并复盘」拿结果了。'
          : '把你的回答写进下面的框，点「发送回答」。');
      }).catch(function (e) {
        holder.innerHTML = '<span class="bad-c">面试官出错了：' + U.esc(e.message || String(e)) + '</span>';
        busyOn(false);
        setTip('可以点「发送回答」重试，或直接结束并复盘已答的部分。', 'bad-c');
      });
    }

    function send() {
      if (busy || ended) return;
      var t = ta.value.trim();
      if (!t) { U.toast('先写一下你的回答', 'warn'); return; }
      ta.value = '';
      // 记录上一题的答案（如果有未配对的）
      var i = answers.length - 1;
      if (i >= 0 && answers[i] === null) answers[i] = t;
      transcriptWhenNeeded();
      ask(t);
    }

    function skip() {
      if (busy || ended) return;
      var i = answers.length - 1;
      if (i >= 0 && answers[i] === null) answers[i] = '（跳过没答）';
      ask('这题我答不上来，跳过，下一题吧。');
    }

    function transcriptWhenNeeded() {
      transcript = [];
      qs.forEach(function (q, idx) {
        transcript.push({ q: q, a: answers[idx] === null || answers[idx] === undefined ? '（未回答）' : answers[idx] });
      });
    }

    /* ---------- 结束 → 复盘 ---------- */
    function endAndReview() {
      if (ended) return;
      if (!answers.length) { U.toast('还没开始答呢，先让面试官问第一题', 'warn'); return; }
      if (busy) { U.toast('等面试官把当前这题问完再结束', 'warn'); return; }

      transcriptWhenNeeded();
      var answered = transcript.filter(function (x) { return x.a !== '（未回答）' && x.a !== '（跳过没答）'; }).length;
      if (!answered) { U.toast('一题都没答，没东西可复盘 —— 先答两题试试', 'warn'); return; }

      // 先把问答记录落盘：万一复盘那一步失败，至少这轮没白答
      Store.updateJob(j.id, {
        interviewSim: {
          at: U.now(), round: setup.round,
          resumeId: setup.resume ? setup.resume.id : '',
          transcript: transcript,
          review: null,
        },
      });
      ended = true;
      m.close();
      if (opt.onSaved) { try { opt.onSaved(); } catch (e) { /* noop */ } }
      runReview(j.id, setup, transcript, opt);
    }

    /* ⛔ 进入就请面试官问第一题（评审 P1-10）。
       原来 `ask()` 只在 send() / skip() 里被调用，runChat 结尾**没有初始提问** ⇒
       聊天框是空的，用户得先"回答"一个还没被问的问题。而 endAndReview 里那句
       「还没开始答呢，先让面试官问第一题」本身就证明设计意图是自动出题。
       放在这里（同步调用）而不是 setTimeout：openModal 已经同步把 chatBox 插进了
       文档，不需要等下一拍；而且同步调用才可被测试直接观察到。 */
    try {
      ask('（面试开始）我准备好了，请面试官问第一个问题。');
    } catch (e) {
      // AI.chat 万一是**同步**抛（比如没配模型 Key），别让整个弹窗炸掉
      setTip('出不了第一题：' + ((e && e.message) || String(e)) +
             '　—— 先到「设置」里配一下模型 Key', 'bad-c');
    }
  }

  /** 复盘：让模型按 simReview 模板给结构化结论 */
  function runReview(jobId, setup, transcript, opt) {
    var j = Store.job(jobId) || {};
    var text = transcript.map(function (x, i) {
      return (i + 1) + '. 面试官：' + x.q + '\n   我的回答：' + x.a;
    }).join('\n\n');

    Comp.runAI({
      title: '🎤 模拟面试复盘',
      tpl: 'simReview',
      size: 'xl',
      input: {
        job: AI.jobToText(j),
        resume: setup.resume ? AI.resumeToText(setup.resume) : '',
        round: setup.round,
        transcript: text,
      },
      applyLabel: '保存复盘',
      renderResult: function (data) { return reviewNode(data, transcript); },
      onApply: function (data) {
        var cur = (Store.job(jobId) || {}).interviewSim || {};
        Store.updateJob(jobId, {
          interviewSim: Object.assign({}, cur, {
            at: cur.at || U.now(),
            round: setup.round,
            resumeId: setup.resume ? setup.resume.id : '',
            transcript: transcript,
            review: {
              score: U.asNum(data.score),
              verdict: String(data.verdict || ''),
              highlights: U.asArray(data.highlights),
              problems: U.asArray(data.problems),
              perQuestion: Array.isArray(data.perQuestion) ? data.perQuestion.map(function (x) {
                return {
                  q: String(x.q || ''), comment: String(x.comment || ''),
                  better: String(x.better || ''), tag: String(x.tag || ''),
                };
              }) : [],
              nextSteps: U.asArray(data.nextSteps),
            },
            at2: U.now(),
          }),
        });
        U.toast('复盘已保存 ✅ 岗位详情里能回看', 'ok', 5000);
        if (opt && opt.onSaved) { try { opt.onSaved(); } catch (e) { /* noop */ } }
      },
    });
  }

  /* ==================== 复盘展示 ==================== */
  function tagCls(t) {
    if (t.indexOf('亮点') >= 0) return 'ok';
    if (t.indexOf('失分') >= 0) return 'bad';
    return 'warn';
  }

  function reviewNode(r, transcript) {
    var wrap = el('div', { class: 'stack' });
    var score = U.asNum(r.score);

    wrap.appendChild(el('div', { class: 'row', style: 'gap:14px;align-items:center' }, [
      el('div', { class: 'stat', style: 'min-width:120px' }, [
        el('div', { class: 'k', text: '综合得分' }),
        el('div', {
          class: 'v', style: 'color:var(--' + (score >= 80 ? 'ok' : score >= 60 ? 'warn' : 'bad') + ')',
          text: score === null ? '—' : String(score),
        }),
        el('div', { class: 'd', text: score >= 80 ? '可以打了' : score >= 60 ? '及格，继续练' : '还需要不少准备' }),
      ]),
      el('div', { class: 'flex1' }, [
        el('div', { class: 'fs13 fw6', text: r.verdict || '' }),
        el('div', { class: 'fs12 muted mt4', text: '分数只是这次的表现，不代表录用结果 —— 真题、真面试官、真压力都不一样。' }),
      ]),
    ]));

    if ((r.highlights || []).length) wrap.appendChild(block('✅ 做得好的', r.highlights, 'ok'));
    if ((r.problems || []).length) wrap.appendChild(block('⚠️ 最需要改的', r.problems, 'bad'));

    if ((r.perQuestion || []).length) {
      var card = el('div', { class: 'card' }, [
        el('header', {}, [el('h3', { text: '逐题点评（' + r.perQuestion.length + ' 题）' }), el('span', { class: 'sp' }),
          el('span', { class: 'hint tiny', text: '点标题展开「更好的答法」' })]),
      ]);
      var body = el('div', { class: 'body' });
      r.perQuestion.forEach(function (x, i) {
        body.appendChild(el('details', { class: 'fold', style: 'margin-bottom:7px' }, [
          el('summary', {}, [
            el('b', { text: (i + 1) + '. ' + U.truncate(x.q || '', 60) }),
            x.tag ? el('span', { class: 'tag ' + tagCls(x.tag), text: x.tag }) : null,
          ].filter(Boolean)),
          el('div', { class: 'fd' }, [
            x.comment ? el('div', { class: 'fs12 muted mb8', text: '点评：' + x.comment }) : null,
            (function () {
              var ans = (transcript && transcript[i]) ? transcript[i].a : '';
              return ans ? el('div', { class: 'box mb8 fs12' }, [
                el('div', { class: 'muted fw6 mb4', text: '你当时的回答' }),
                el('div', { class: 'pre-wrap', text: ans }),
              ]) : null;
            })(),
            x.better ? el('div', { class: 'note brand' }, [
              el('span', { class: 'ico', text: '💡' }),
              el('div', {}, [el('b', { text: '更好的答法骨架：' }), el('div', { class: 'pre-wrap mt4', text: x.better })]),
            ]) : null,
          ].filter(Boolean)),
        ]));
      });
      card.appendChild(body);
      wrap.appendChild(card);
    }

    if ((r.nextSteps || []).length) wrap.appendChild(block('🎯 接下来重点准备', r.nextSteps, 'brand'));
    return wrap;
  }

  function block(title, arr, cls) {
    return el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: title })]),
      el('div', { class: 'body' }, [
        el('div', { class: 'stack', style: 'gap:5px' }, arr.map(function (x) {
          return el('div', { class: 'fs13 row', style: 'align-items:flex-start;gap:6px' }, [
            el('span', { class: cls + '-c', text: '•' }),
            el('span', { class: 'flex1 pre-wrap', text: String(x) }),
          ]);
        })),
      ]),
    ]);
  }

  /** 打开已保存的复盘 */
  function openResult(jobId) {
    var j = Store.job(jobId);
    var sim = j && j.interviewSim;
    if (!sim || !(sim.transcript || []).length) { U.toast('这个岗位还没有模拟面试记录', 'warn'); return; }

    var body = el('div', { class: 'stack' });
    if (sim.review) body.appendChild(reviewNode(sim.review, sim.transcript));
    else {
      body.appendChild(el('div', { class: 'note warn' }, [
        el('span', { class: 'ico', text: '⚠️' }),
        el('div', { text: '这轮问答存下来了，但复盘还没生成（当时可能中断了）。' }),
      ]));
      body.appendChild(el('button', {
        class: 'btn pri', text: '现在补一次复盘',
        onclick: function () {
          m.close();
          runReview(jobId, { round: sim.round, resume: sim.resumeId ? Store.resume(sim.resumeId) : null }, sim.transcript, { onSaved: function () { App.refresh(); } });
        },
      }));
    }

    // 原始问答记录
    var qa = el('div', { class: 'card' }, [
      el('header', {}, [el('h3', { text: '完整问答记录（' + sim.transcript.length + ' 题）' }), el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: U.d2t(sim.at || 0) + ' · ' + (sim.round || '') })]),
      el('div', { class: 'body' }, [
        el('div', { class: 'stack' }, sim.transcript.map(function (x, i) {
          return el('div', {}, [
            el('div', { class: 'fs12 fw6 brand-c', text: (i + 1) + '. HR：' + x.q }),
            el('div', { class: 'box mt4 mb12 pre-wrap fs12', text: x.a }),
          ]);
        })),
      ]),
    ]);
    body.appendChild(qa);

    var m = U.openModal({
      title: '模拟面试复盘 · ' + (j.title || ''),
      size: 'xl',
      body: body,
      footer: [
        { text: '复制复盘文字', onClick: function (c) {
          U.copyText(reviewToText(j, sim)).then(function (ok) { U.toast(ok ? '已复制' : '复制失败', ok ? 'ok' : 'warn'); });
          void c;
        } },
        { text: '另存为一场面试记录', onClick: function (c) {
          c();
          saveAsInterview(j, sim);
        } },
        { text: '关闭', cls: 'pri', onClick: function (c) { c(); } },
      ],
    });
    void m;
  }

  function reviewToText(j, sim) {
    var r = sim.review || {};
    var L = ['【' + (j.title || '') + ' · ' + (j.company || '') + '】模拟面试复盘',
      '轮次：' + (sim.round || '') + '　时间：' + U.d2t(sim.at || 0),
      '综合得分：' + (r.score === null || r.score === undefined ? '—' : r.score), r.verdict || '', ''];
    if ((r.highlights || []).length) { L.push('■ 做得好'); r.highlights.forEach(function (x) { L.push('- ' + x); }); L.push(''); }
    if ((r.problems || []).length) { L.push('■ 需要改'); r.problems.forEach(function (x) { L.push('- ' + x); }); L.push(''); }
    (r.perQuestion || []).forEach(function (x, i) {
      L.push((i + 1) + '. ' + x.q);
      if (x.comment) L.push('   点评：' + x.comment);
      if (x.better) L.push('   更好的答法：' + x.better);
    });
    if ((r.nextSteps || []).length) { L.push('', '■ 接下来准备'); r.nextSteps.forEach(function (x) { L.push('- ' + x); }); }
    return L.join('\n');
  }

  /** 把模拟面试存成一条真实的面试记录（状态已完成 + 复盘），方便在看板/面试页统一管理 */
  function saveAsInterview(j, sim) {
    var txt = reviewToText(j, sim);
    /* ⛔ 绝不能按「轮次名相同」直接覆盖真实面试（评审核实 2026-10-30，P0-13）。
       '一面（技术/业务）' 既是模拟默认轮次，也是新建面试的默认轮次 ——
       撞上用户真实的「一面」是常见情形，不是边缘。以前这里 updateInterview
       把 review 整段覆盖 + status 改成 done，用户真实一场面试的复盘被冲掉且不可撤销。
       修法：**只新建**、永不覆盖；如果已经存在同名轮次，提示用户去面试页手动合并。 */
    var exist = Store.interviews({ jobId: j.id }).filter(function (v) { return v.round === sim.round; })[0];
    if (exist) {
      U.toast('该岗位已有「' + sim.round + '」的真实面试记录 —— 模拟复盘不会覆盖它。' +
        '请到面试页把这段复盘手动并进那场面试。', 'warn', 7000);
    }
    Store.addInterview({
      jobId: j.id, at: null, mode: 'online', round: sim.round || '一面（技术/业务）',
      status: 'done', result: 'unknown',
      notes: '（来自 AI 模拟面试，' + (sim.transcript || []).length + ' 题）',
      review: txt,
    });
    U.toast('已另存为一条面试记录（状态：已完成，含复盘）', 'ok', 5000);
    App.updateNavCounts();
    App.refresh();
  }

  global.InterviewSim = {
    start: start, openResult: openResult, reviewToText: reviewToText,
    _runChat: runChat, _reviewNode: reviewNode,
  };
})(window);
