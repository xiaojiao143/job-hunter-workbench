/* ==========================================================================
   view-resume.js · 模块 4：简历素材库
   多版本简历 / AI 匹配打分 / 求职信·作品集素材 / 绑定岗位
   ========================================================================== */
(function (global) {
  'use strict';

  var el = Comp.el;

  var MAT_KINDS = [
    { id: 'cover', name: '求职信 / 打招呼稿', icon: '✉️' },
    { id: 'portfolio', name: '作品集链接', icon: '🔗' },
    { id: 'project', name: '项目描述片段', icon: '🧩' },
    { id: 'other', name: '其他素材', icon: '📎' },
  ];

  var F = { tab: 'resume', matKind: '' };

  /* ==================== 从文件读简历（第 24 轮） ====================
     用户的原话：「这个地方应该可以上传其他文件（pdf，word等等），而不是去复制粘贴」。
     以前只认 .txt / .md，PDF / Word 只能让用户自己在别的软件里 Ctrl+A → Ctrl+C。

     ⛔ **PDF / Word 的抽取必须借本机采集器代劳** —— 工作台本体是纯前端，
        浏览器里没有任何解析 PDF / Word 的办法（不引第三方 JS 库是这个项目的底线）。
        采集器那边本来就有 `resume_matcher.parsers.parse_resume_file`
        （PyPDF2 + python-docx），新开的 `/api/extract-text` 只抽文字，
        **不发给大模型、不起任务、不落 resume 目录**。
     ⛔ 纯文本（txt / md）走**本地读**，不需要采集器 —— 能离线用的就别给用户加前置。 */

  var TEXT_EXTS = ['.txt', '.md', '.markdown'];
  var RESUME_ACCEPT = '.pdf,.docx,.doc,.txt,.md,.markdown';

  /** 借采集页那套请求封装（自带 X-JH-Token / 超时 / 错误归一）。 */
  function collectorReq(path, opt) {
    var VC = global.Views && global.Views.collect;
    if (!VC || typeof VC._req !== 'function') {
      return Promise.reject(new Error('采集模块没加载 —— 请用「启动采集器」打开工作台。'));
    }
    // ⚠️ S.base 可能还是 null（用户没进过采集页）→ 先探一次端口再发请求，
    //    否则会拼出 "null/api/extract-text" 这种请求。
    var st = VC._state || {};
    var ready = st.base ? Promise.resolve(st.base) : VC._detect();
    return ready.then(function (base) {
      if (!base) {
        throw new Error('采集器没在运行 —— 双击「启动采集器.cmd」后再试；' +
          '也可以直接把简历文字粘进来。');
      }
      return VC._req(path, opt);
    });
  }

  function extOf(name) {
    return (String(name || '').match(/\.[^.]+$/) || [''])[0].toLowerCase();
  }

  /** 读一个简历文件 → { name, text, via }。via: 'local'（本地读）/ 'server'（采集器抽的） */
  function readResumeFile(f) {
    var name = String((f && f.name) || '');
    var ext = extOf(name);
    if (TEXT_EXTS.indexOf(ext) >= 0) {
      return U.readText(f).then(function (t) { return { name: name, text: t, via: 'local' }; });
    }
    // ⛔ 旧版二进制 .doc 明确拦下：python-docx 只认 OOXML 的 .docx，
    //    喂 .doc 进去必然失败，静默返回空串会让人以为"文件坏了"。
    if (ext === '.doc') {
      return Promise.reject(new Error('旧版 .doc 读不了 —— 用 Word 打开后「另存为 .docx」再上传。'));
    }
    if (ext !== '.pdf' && ext !== '.docx') {
      return Promise.reject(new Error('支持 PDF / Word(.docx) / txt / md，这个格式不支持。'));
    }
    return U.readArrayBuffer(f).then(function (buf) {
      return collectorReq('/api/extract-text', {
        method: 'POST', raw: buf, timeout: 90000,
        headers: {
          'Content-Type': 'application/octet-stream',
          'X-Filename': U.b64(name),   // 文件名走 base64 头（服务端不解析 multipart）
        },
      }).then(function (d) {
        if (!d || !d.ok) throw new Error((d && d.error) || '抽取失败');
        return { name: name, text: String(d.text || ''), via: 'server', chars: d.chars };
      });
    });
  }

  /** 选文件 → 读出文字。两处入口（页头按钮 / 表单里）共用这一条。 */
  function pickResumeText() {
    return U.pickFile(RESUME_ACCEPT).then(function (f) {
      if (!f) return null;
      if (f.size > 20 * 1024 * 1024) { U.toast('文件超过 20MB。', 'warn'); return null; }
      if (TEXT_EXTS.indexOf(extOf(f.name)) < 0) U.toast('正在抽取文字…', 'info', 30000);
      return readResumeFile(f);
    });
  }

  function readErrToast(e) {
    U.toast('读取失败：' + ((e && e.message) || String(e)), 'bad', 9000);
  }

  function render(root) {
    var wrap = el('div', { class: 'wrap stack' });
    root.appendChild(wrap);

    App.topActions([
      el('button', {
        class: 'btn pri', html: F.tab === 'resume' ? '＋ 新增简历版本' : '＋ 新增素材',
        onclick: function () { F.tab === 'resume' ? openResumeForm(null) : openMaterialForm(null); },
      }),
      el('button', {
        class: 'btn', html: '📄 上传简历文件',
        onclick: uploadResume,
        title: '支持 PDF / Word(.docx) / txt / md —— 自动转成文字存进来',
      }),
    ]);

    var note = Comp.aiReadyNote();
    if (note) wrap.appendChild(note);

    // 分段
    var seg = el('div', { class: 'seg' });
    [['resume', '简历版本'], ['material', '求职素材']].forEach(function (x) {
      seg.appendChild(el('button', {
        class: F.tab === x[0] ? 'on' : '', text: x[1],
        onclick: function () { F.tab = x[0]; App.refresh(); },
      }));
    });
    wrap.appendChild(el('div', { class: 'row' }, [seg, el('span', { class: 'sp' })]));

    var box = el('div', {});
    wrap.appendChild(box);

    if (F.tab === 'resume') paintResumes(box);
    else paintMaterials(box);
  }

  /* ==================== 简历 ==================== */
  function paintResumes(box) {
    var list = Store.resumes();
    if (!list.length) {
      /* 第 24 轮：这里以前写的是「把简历文字粘进来（或上传 .txt / .md）」，还要用户
         自己 Ctrl+A → Ctrl+C。现在 PDF / Word 直接选文件就能抽成文字，
         所以按钮直接摆在空态里，不用先点「新增」再在里面找上传。 */
      var em = Comp.empty('📄', '还没有简历',
        '选一个 <b>PDF / Word / txt / md</b> 文件就能自动转成文字；也可以直接把文字粘进来。<br>' +
        '<span class="fs12">PDF / Word 的文字抽取由本机采集器代劳（先把「启动采集器.cmd」跑起来即可）。</span>',
        '＋ 手动添加一份', function () { openResumeForm(null); });
      em.appendChild(el('div', { class: 'row', style: 'justify-content:center;margin-top:10px' }, [
        el('button', { class: 'btn pri', html: '📄 上传 PDF / Word', onclick: uploadResume }),
      ]));
      box.appendChild(em);
      return;
    }

    // 匹配记录概览
    var matched = Store.jobs().filter(function (j) { return j.aiVerdict && j.aiVerdict.score; });
    if (matched.length) {
      var avg = Math.round(U.sum(matched, function (j) { return j.aiVerdict.score; }) / matched.length);
      box.appendChild(el('div', { class: 'card' }, [el('div', { class: 'body tight row' }, [
        el('span', { class: 'fs13', html: '已对 <b>' + matched.length + '</b> 个岗位做过匹配评估' }),
        el('span', { class: 'muted', text: '·' }),
        el('span', { class: 'fs13', html: '平均匹配分 <b>' + avg + '</b>' }),
        el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: '匹配分越高越值得投' }),
      ])]));
    }

    var grid = el('div', { class: 'grid g2' });
    list.forEach(function (r) { grid.appendChild(resumeCard(r, box)); });
    box.appendChild(grid);
  }

  function resumeCard(r, box) {
    var used = Store.applications().filter(function (a) { return a.resumeId === r.id; });
    var scores = Store.jobs().filter(function (j) { return j.aiVerdict && j.aiVerdict.resumeId === r.id && j.aiVerdict.score; });

    var card = el('div', { class: 'card' });
    card.appendChild(el('header', {}, [
      el('h3', { text: r.name }),
      r.isDefault ? el('span', { class: 'tag brand', text: '默认' }) : null,
      el('span', { class: 'sp' }),
      el('span', { class: 'hint tiny', text: r.content.length + ' 字' }),
    ].filter(Boolean)));

    var body = el('div', { class: 'body' });
    if (r.tags.length) body.appendChild(el('div', { class: 'mb8' }, [Comp.tagList(r.tags, 'info')]));
    body.appendChild(el('div', { class: 'box pre-wrap fs12 clamp3', style: 'max-height:76px;overflow:hidden', text: U.truncate(r.content, 220) || '（空）' }));

    body.appendChild(el('div', { class: 'row fs12 muted mt8', style: 'gap:11px' }, [
      el('span', { text: '被 ' + used.length + ' 条投递使用' }),
      scores.length ? el('span', { text: '已评估 ' + scores.length + ' 个岗位' }) : null,
      el('span', { text: '更新于 ' + U.d2(r.updatedAt) }),
    ].filter(Boolean)));

    body.appendChild(el('div', { class: 'row mt12' }, [
      el('button', { class: 'btn pri sm', html: '🎯 拿它去匹配岗位', onclick: function () { matchFlow(r); } }),
      el('button', { class: 'btn sm', html: '⤓ 导出 PDF / Word', title: '排版成标准简历，导出打印稿或可编辑的 Word', onclick: function () { ResumeDoc.openExportDialog(r.id); } }),
      el('button', { class: 'btn sm', text: '查看全文', onclick: function () { openResumeView(r.id); } }),
      el('button', { class: 'btn sm', text: '编辑', onclick: function () { openResumeForm(r.id, function () { App.refresh(); }); } }),
      el('span', { class: 'sp' }),
      !r.isDefault ? el('button', {
        class: 'btn sm ghost', text: '设为默认',
        onclick: function () { Store.updateResume(r.id, { isDefault: true }); U.toast('已设为默认简历', 'ok'); App.refresh(); },
      }) : null,
      el('button', {
        class: 'btn sm danger', text: '删除',
        onclick: function () {
          var used = Store.applications().filter(function (a) { return a.resumeId === r.id; }).length;
          var snap = Store.takeOut({ resumes: [r.id] });
          App.updateNavCounts();
          Comp.trashToast('已删除简历「' + r.name + '」' + (used ? '（有 ' + used + ' 条投递绑着它）' : ''), snap);
        },
      }),
    ].filter(Boolean)));

    card.appendChild(body);
    void box;
    return card;
  }

  function openResumeView(id) {
    var r = Store.resume(id);
    if (!r) return;
    U.openModal({
      title: r.name,
      size: 'wide',
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'row' }, [
          Comp.tagList(r.tags, 'info'),
          el('span', { class: 'sp' }),
          Comp.copyBtn(r.content, '复制全文'),
        ]),
        el('div', { class: 'box pre-wrap fs13', style: 'max-height:56vh;overflow-y:auto', text: r.content || '（空）' }),
      ]),
      footer: [
        { text: '编辑', onClick: function (c) { c(); openResumeForm(id, function () { App.refresh(); }); } },
        { text: '关闭', cls: 'pri', onClick: function (c) { c(); } },
      ],
    });
  }

  function openResumeForm(id, after) {
    var r = id ? Store.resume(id) : null;
    var nameInp = el('input', { type: 'text', placeholder: '如：通用版 / 短视频运营专项版' });
    nameInp.value = r ? r.name : '';
    var tagsInp = el('input', { type: 'text', placeholder: '逗号分隔，如：运营, 短视频' });
    tagsInp.value = r && r.tags.length ? r.tags.join(', ') : '';
    var ta = el('textarea', { rows: 16, placeholder: '把简历内容整段粘进来…' });
    ta.value = r ? r.content : '';
    var cbDefault = null;   // 在下面的 children 里赋值，保存时读它

    // 字数要**实时**跟着输入走。之前写成渲染时算一次的静态文本，
    // 用户敲了半天看到还是「当前 0 字」，会以为没输进去。
    var countEl = el('span', { class: 'hint tiny', text: '当前 ' + ta.value.length + ' 字' });
    function syncCount() { countEl.textContent = '当前 ' + ta.value.length + ' 字'; }
    ta.addEventListener('input', syncCount);
    ta.addEventListener('change', syncCount);
    ta.addEventListener('paste', function () { setTimeout(syncCount, 0); });

    // 关窗前拦一次没保存的修改（点 ✕ / 取消 / 遮罩 / Esc 都会走到 beforeClose）
    var guard = U.dirtyGuard(function () {
      return [nameInp.value, tagsInp.value, ta.value, !!(cbDefault && cbDefault.checked)];
    });

    U.openModal({
      title: id ? '编辑简历版本' : '新增简历版本',
      size: 'wide',
      beforeClose: guard.check,
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'grid g2', style: 'gap:12px' }, [
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '版本名称 *' }), nameInp]),
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '标签' }), tagsInp]),
        ]),
        el('div', { class: 'fld' }, [
          el('label', { class: 'lb', text: '简历内容 *（纯文本，AI 分析的就是这段）' }),
          ta,
          el('div', { class: 'hint tiny mt4', html: '从 Word / PDF 里 <b>Ctrl+A → Ctrl+C</b> 粘进来即可保留结构；也可以直接上传文件自动转文字。' }),
        ]),
        el('div', { class: 'row' }, [
          el('button', { class: 'btn sm', html: '📄 上传 PDF / Word 自动转文字', onclick: function () {
            pickResumeText().then(function (r) {
              if (!r) return;
              if (!r.text.trim()) { U.toast('这个文件里没有文字内容', 'warn'); return; }
              ta.value = r.text;
              if (!nameInp.value) nameInp.value = r.name.replace(/\.[^.]+$/, '');
              countEl.textContent = '当前 ' + r.text.length + ' 字';
              U.toast('已读入 ' + r.text.length + ' 字' +
                (r.via === 'server' ? '（采集器抽取）' : ''), 'ok');
            }).catch(readErrToast);
          } }),
          countEl,
        ]),
        (function () {
          // 注意：不能在 el(...) 的 children 里引用正在构造中的变量（TDZ/undefined），
          // 所以 checkbox 必须先建好、先赋给具名变量，再放进 label。
          var cb = el('input', { type: 'checkbox' });
          cb.checked = r ? r.isDefault : Store.resumes().length === 0;
          cbDefault = cb;
          return el('label', { class: 'chk' }, [
            cb,
            el('span', { text: '设为默认简历（做匹配和生成话术时优先用它）' }),
          ]);
        })(),
      ]),
      footer: [
        { text: '保存', cls: 'pri', onClick: function (close) {
          var nm = nameInp.value.trim();
          if (!nm) { U.toast('请给这个版本起个名字', 'warn'); return; }
          if (!ta.value.trim()) { U.toast('简历内容不能为空', 'warn'); return; }
          var patch = {
            name: nm,
            content: ta.value,
            tags: U.asArray(tagsInp.value, true),
            isDefault: !!(cbDefault && cbDefault.checked),
          };
          try {
            if (id) Store.updateResume(id, patch);
            else Store.addResume(patch);
          } catch (e) {
            U.toast('保存失败：' + e.message, 'bad', 7000);
            return;      // 失败就别关窗，让用户能改
          }
          // ⚠️ 形参名是 close，这里曾经误写成 c()（未定义）→ 抛异常中断，
          //    结果「已保存 ✅」弹了、弹窗却留着、列表也不刷新。
          close();
          U.toast('已保存 ✅', 'ok');
          App.updateNavCounts();
          if (after) after(); else App.refresh();
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });

    // 基线只能在弹窗建好之后取 —— openModal 会把初值填进控件，
    // 提前 mark 的话一打开就算「脏」，每次关窗都弹确认，比不拦还烦。
    guard.mark();
  }

  function uploadResume() {
    pickResumeText().then(function (r) {
      if (!r) return;
      if (!r.text.trim()) { U.toast('这个文件里没有文字内容', 'warn'); return; }
      Store.addResume({ name: r.name.replace(/\.[^.]+$/, '') || '简历', content: r.text });
      U.toast('已导入 ' + r.text.length + ' 字的简历 ✅' +
        (r.via === 'server' ? '（PDF / Word 由采集器抽取）' : ''), 'ok');
      App.updateNavCounts(); App.refresh();
    }).catch(readErrToast);
  }

  /* ---------------- 匹配流程 ---------------- */
  function matchFlow(r) {
    Comp.jobPicker({ title: '用「' + r.name + '」匹配哪些岗位？（可多选）', multiple: true }).then(function (ids) {
      if (!ids || !ids.length) return;
      runMatchBatch(r, ids);
    });
  }

  function runMatchBatch(r, ids) {
    var idx = 0;
    var results = [];

    function next() {
      if (idx >= ids.length) {
        showBatchResult(r, results);
        return;
      }
      var j = Store.job(ids[idx]);
      idx++;
      var progress = el('div', { class: 'typer', style: 'display:none' });
      var m = Comp.runAI({
        title: '匹配评估 ' + idx + '/' + ids.length + ' · ' + (j.title || ''),
        tpl: 'match',
        input: { resume: AI.resumeToText(r), job: AI.jobToText(j, true) },
        applyLabel: '保存并继续下一个',
        onApply: function (data) {
          Store.updateJob(j.id, {
            aiVerdict: {
              score: U.asNum(data.score),
              verdict: String(data.verdict || ''),
              category: String(data.category || ''),
              matched: U.asArray(data.matched),
              missing: U.asArray(data.missing),
              risks: U.asArray(data.risks),
              suggestions: U.asArray(data.suggestions),
              keywordsToAdd: U.asArray(data.keywordsToAdd, true),
              greetingHint: String(data.greetingHint || ''),
              resumeId: r.id,
            },
            aiVerdictAt: U.now(),
          });
          results.push({ jobId: j.id, score: U.asNum(data.score), verdict: data.verdict, category: data.category });
          m.close();
          next();
        },
      });
      void progress;
    }

    next();
  }

  function showBatchResult(r, results) {
    results.sort(function (a, b) { return (b.score || 0) - (a.score || 0); });
    var wrap = el('div', { class: 'stack' });
    wrap.appendChild(el('div', { class: 'note ok' }, [
      el('span', { class: 'ico', text: '✅' }),
      el('div', { html: '用「' + U.esc(r.name) + '」评估了 <b>' + results.length + '</b> 个岗位，结果已存到各岗位上。' }),
    ]));
    var tb = el('table', { class: 'tb' }, [
      el('thead', {}, [el('tr', {}, [
        el('th', { text: '岗位' }), el('th', { text: '公司' }),
        el('th', { class: 'num', text: '匹配分' }), el('th', { text: '结论' }),
      ])]),
    ]);
    var tbody = el('tbody');
    results.forEach(function (x) {
      var j = Store.job(x.jobId) || {};
      tbody.appendChild(el('tr', {
        class: 'pointer', style: 'cursor:pointer',
        onclick: function () { m.close(); Views.jobs.detail(x.jobId); },
      }, [
        el('td', { text: j.title || '' }),
        el('td', { class: 'muted', text: j.company || '' }),
        el('td', { class: 'num' }, [el('b', {
          class: x.score >= 80 ? 'ok-c' : x.score >= 70 ? 'brand-c' : 'warn-c',
          text: String(x.score === null ? '—' : x.score),
        })]),
        el('td', { class: 'fs12', text: (x.verdict || '') + (x.category === 'cannot_apply' ? '（不建议投）' : '') }),
      ]));
    });
    tb.appendChild(tbody);
    wrap.appendChild(el('div', { class: 'tb-wrap', style: 'max-height:48vh' }, [tb]));

    var m = U.openModal({
      title: '匹配结果汇总',
      size: 'wide',
      body: wrap,
      footer: [
        { text: '只看值得投的', onClick: function (c) { c(); Views.jobs.filters.sort = 'score'; Views.jobs.filters.status = ''; App.go('jobs'); } },
        { text: '关闭', cls: 'pri', onClick: function (c) { c(); App.refresh(); } },
      ],
    });
  }

  /* ==================== 素材 ==================== */
  function paintMaterials(box) {
    var seg = el('div', { class: 'row' });
    seg.appendChild(el('button', {
      class: 'btn sm' + (F.matKind ? '' : ' pri'), text: '全部',
      onclick: function () { F.matKind = ''; App.refresh(); },
    }));
    MAT_KINDS.forEach(function (k) {
      seg.appendChild(el('button', {
        class: 'btn sm' + (F.matKind === k.id ? ' pri' : ''), html: k.icon + ' ' + k.name,
        onclick: function () { F.matKind = k.id; App.refresh(); },
      }));
    });
    box.appendChild(seg);

    var list = Store.materials(F.matKind ? { kind: F.matKind } : {});
    if (!list.length) {
      box.appendChild(Comp.empty('🧰', '还没有求职素材',
        '求职信、作品集链接、项目描述片段都可以存在这里，投递时直接复制。',
        '＋ 新增素材', function () { openMaterialForm(null); }));
      return;
    }

    var grid = el('div', { class: 'grid g2' });
    list.forEach(function (m) {
      var kind = MAT_KINDS.filter(function (k) { return k.id === m.kind; })[0] || MAT_KINDS[3];
      var card = el('div', { class: 'card' });
      card.appendChild(el('header', {}, [
        el('h3', { html: kind.icon + ' ' + U.esc(m.title || '未命名素材') }),
        el('span', { class: 'tag', text: kind.name }),
        el('span', { class: 'sp' }),
        el('span', { class: 'hint tiny', text: U.d2(m.updatedAt) }),
      ]));
      var body = el('div', { class: 'body' });
      if (m.content) body.appendChild(el('div', { class: 'box pre-wrap fs12 clamp3', style: 'max-height:80px;overflow:hidden', text: m.content }));
      if (m.url) body.appendChild(el('div', { class: 'mt8' }, [el('a', { href: m.url, target: '_blank', rel: 'noreferrer', text: m.url })]));
      if (m.jobIds && m.jobIds.length) {
        var row = el('div', { class: 'row fs12 muted mt8', style: 'gap:5px' });
        row.appendChild(el('span', { text: '关联岗位：' }));
        m.jobIds.forEach(function (jid) {
          var j = Store.job(jid);
          if (j) row.appendChild(el('span', { class: 'tag', text: j.title }));
        });
        body.appendChild(row);
      }
      body.appendChild(el('div', { class: 'row mt12' }, [
        m.content ? Comp.copyBtn(m.content, '复制内容') : null,
        el('button', {
          class: 'btn sm', text: '关联岗位',
          onclick: function () {
            Comp.jobPicker({ title: '这份素材要用在哪些岗位？', multiple: true, exclude: m.jobIds }).then(function (ids) {
              if (!ids || !ids.length) return;
              Store.updateMaterial(m.id, { jobIds: U.uniq(m.jobIds.concat(ids)) });
              U.toast('已关联 ' + ids.length + ' 个岗位', 'ok'); App.refresh();
            });
          },
        }),
        el('button', { class: 'btn sm', text: '编辑', onclick: function () { openMaterialForm(m.id); } }),
        el('span', { class: 'sp' }),
        el('button', {
          class: 'btn sm danger', text: '删除',
          onclick: function () {
            var snap = Store.takeOut({ materials: [m.id] });
            Comp.trashToast('已删除素材「' + m.title + '」', snap);
          },
        }),
      ].filter(Boolean)));
      card.appendChild(body);
      grid.appendChild(card);
    });
    box.appendChild(grid);
  }

  function openMaterialForm(id) {
    var m = id ? Store.material(id) : null;
    var titleInp = el('input', { type: 'text', placeholder: '给这个素材起个名字' });
    titleInp.value = m ? m.title : '';
    var kindSel = el('select');
    MAT_KINDS.forEach(function (k) { kindSel.appendChild(el('option', { value: k.id, text: k.name })); });
    kindSel.value = m ? m.kind : (F.matKind || 'cover');
    var urlInp = el('input', { type: 'text', placeholder: 'https://...（作品集、在线简历等）' });
    urlInp.value = m ? m.url : '';
    var ta = el('textarea', { rows: 9, placeholder: '素材内容…' });
    ta.value = m ? m.content : '';

    U.openModal({
      title: id ? '编辑素材' : '新增素材',
      size: 'wide',
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'grid g2', style: 'gap:12px' }, [
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '名称 *' }), titleInp]),
          el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '类型' }), kindSel]),
        ]),
        el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '链接（选填）' }), urlInp]),
        el('div', { class: 'fld' }, [el('label', { class: 'lb', text: '内容' }), ta]),
      ]),
      footer: [
        { text: '保存', cls: 'pri', onClick: function (c) {
          var t = titleInp.value.trim();
          if (!t) { U.toast('请填名称', 'warn'); return; }
          var patch = { title: t, kind: kindSel.value, url: urlInp.value.trim(), content: ta.value };
          if (id) Store.updateMaterial(id, patch); else Store.addMaterial(patch);
          U.toast('已保存 ✅', 'ok');
          c(); App.updateNavCounts(); App.refresh();
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  global.Views.resume = {
    title: '简历素材库',
    render: render,
    openResumeForm: openResumeForm,
    openMaterialForm: openMaterialForm,
    matchFlow: matchFlow,
    filters: F,
    MAT_KINDS: MAT_KINDS,
    // 文件读取这条链（测试直接驱动，不靠点真实文件选择框）
    _readResumeFile: readResumeFile,
    _pickResumeText: pickResumeText,
    _collectorReq: collectorReq,
    _uploadResume: uploadResume,
    _textExts: TEXT_EXTS,
    _accept: RESUME_ACCEPT,
  };
})(window);
