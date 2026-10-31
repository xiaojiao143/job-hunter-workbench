/* ==========================================================================
   account.js · 本机多账号数据沙箱
   --------------------------------------------------------------------------
   「登录 / 切换账号」= 切换数据沙箱（localStorage 按账号分 key），
   不是安全认证 —— 本地文件本就可读，密码仅防误操作（不加密、不校验强度）。

   职责：
     · 侧边栏底部渲染账号区（未登录：登录按钮；已登录：账号名 + 切换 + 登出）
     · 登录 / 新建账号 / 切换 / 登出 的弹窗交互
     · 切换成功后 location.reload()，整页从新账号数据重读
   ========================================================================== */
(function (global) {
  'use strict';

  function $id(id) { return document.getElementById(id); }

  /** 当前账号名（拿 Store 的） */
  function current() { return global.Store.currentAccount(); }

  /* ---------------- 渲染账号区 ---------------- */

  function renderAccount() {
    var box = $id('sideAccount');
    if (!box) return;
    box.innerHTML = '';
    var acct = current();
    var list = global.Store.listAccounts();

    box.appendChild(U.el('div', { class: 'acct-line' }, [
      U.el('span', { class: 'acct-ico', text: '👤' }),
      U.el('span', { class: 'acct-name', text: acct, title: '当前账号（数据沙箱）' }),
      U.el('span', { class: 'sp' }),
      U.el('button', {
        class: 'btn xs ghost', text: '切换', title: '切换或新建账号',
        onclick: function () { openSwitch(); },
      }),
      U.el('button', {
        class: 'btn xs ghost', text: '登出', title: '切回 default 账号',
        onclick: function () { doLogout(); },
      }),
    ]));

    // 其它账号入口（点名字直接切）
    var others = list.filter(function (a) { return a.name !== acct; });
    if (others.length) {
      var ch = U.el('div', { class: 'acct-others' });
      others.forEach(function (a) {
        ch.appendChild(U.el('span', {
          class: 'acct-chip', text: a.name,
          title: '切换到「' + a.name + '」' + (a.hasPwd ? '（设了密码）' : ''),
          onclick: function () { doSwitch(a.name); },
        }));
      });
      box.appendChild(ch);
    }
  }

  /* ---------------- 交互 ---------------- */

  /** 切换 / 新建账号弹窗 */
  function openSwitch() {
    var acct = current();
    var list = global.Store.listAccounts();
    var nameInp = U.el('input', { type: 'text', placeholder: '输入账号名（新名字会直接创建）', value: '' });
    var pwdInp = U.el('input', { type: 'password', placeholder: '密码（可选，设了密码的账号切换时要输）', value: '' });
    var errBox = U.el('div', { class: 'fs12', style: 'color:var(--bad);min-height:16px;margin-top:6px' });

    // 已有账号快捷点选
    var chips = null;
    if (list.length) {
      chips = U.el('div', { class: 'acct-pick' }, [
        /* ⛔ 文案必须和实际行为一致。
           原来写「点一下切换」，但 chip 的 onclick 只做了 `nameInp.value = a.name`
           —— 既不切换、也不重绘（高亮是渲染时按当前账号算的），所以第一下**毫无反馈**，
           用户以为坏了，实际要点两下（评审 A8 实测）。
           现在：没密码的账号**点一下真切换**；设了密码的才退回两步（并说清原因）。 */
        U.el('span', { class: 'fs12 muted', text: '已有账号（点一下直接切换；带 🔒 的需先输密码）' }),
        U.el('div', { class: 'acct-others', style: 'margin-top:4px' },
          list.map(function (a) {
            return U.el('span', {
              class: 'acct-chip' + (a.name === acct ? ' on' : ''),
              text: a.name + (a.name === acct ? '（当前）' : '') + (a.hasPwd ? ' 🔒' : ''),
              onclick: function () {
                if (a.name === acct) { errBox.textContent = '已经是当前账号了'; return; }
                if (a.hasPwd) {
                  // 有密码 → 只能走两步（密码得人输）。这一下也必须有反馈。
                  nameInp.value = a.name;
                  errBox.textContent = '「' + a.name + '」设了密码，填在下面输入框后点右下角「切换」';
                  pwdInp.focus();
                  return;
                }
                /* 无密码 → 直接切。
                   先关掉弹窗：finishSwitch 之后 400ms 会 location.reload()，
                   留着面具层会短暂盖住页面。注意用 skipBeforeClose=true（强制关），
                   这里没有"未保存的修改"需要拦。 */
                try { U.closeAllModals(true); } catch (e) { /* 关不掉也别挡切换 */ }
                finishSwitch(a.name);
              },
            });
          })),
      ]);
    }

    var body = U.el('div', { class: 'stack', style: 'gap:8px' }, [
      U.el('div', { class: 'fs12 muted', html:
        '账号是<b>本机数据沙箱</b>：每个账号一份独立数据，换号即换数据、换回即恢复。<br>' +
        '新名字会直接创建；密码仅防误操作，<b>不加密、不联网</b>。' }),
      nameInp,
      pwdInp,
      chips || null,
      errBox,
    ].filter(Boolean));

    var done = false;
    U.openModal({
      title: '切换 / 新建账号',
      size: 'sm',
      body: body,
      footer: [
        { text: '取消', onClick: function (c) { c(); } },
        { text: '切换', cls: 'pri', onClick: function (c) { submit(c); } },
      ],
    });

    function submit(c) {
      if (done) return;
      var name = nameInp.value.trim();
      if (!name) { errBox.textContent = '请输入账号名'; nameInp.focus(); return; }
      if (!global.Store.validAccountName(name)) {
        errBox.textContent = '账号名不能含空格、/ \\ : * ? " < > |，且不超过 32 字';
        nameInp.focus(); return;
      }
      var r = global.Store.switchAccount(name, pwdInp.value);
      if (!r.ok) {
        errBox.textContent = r.error || '切换失败';
        return;
      }
      done = true;
      c();                                   // 关窗
      U.toast('已切换到账号「' + r.name + '」，正在载入数据…', 'ok', 3000);
      setTimeout(function () { location.reload(); }, 400);
    }
  }

  /** 直接切换（侧边栏点其它账号 chip） */
  function doSwitch(name) {
    var acct = current();
    if (name === acct) { U.toast('已经是当前账号「' + name + '」', 'info'); return; }
    var rec = global.Store.listAccounts().filter(function (a) { return a.name === name; })[0];
    if (rec && rec.hasPwd) {
      // 设了密码 → 弹输入框
      var pwdInp = U.el('input', { type: 'password', placeholder: '输入「' + name + '」的密码', value: '' });
      var err = U.el('div', { class: 'fs12', style: 'color:var(--bad);min-height:16px;margin-top:6px' });
      U.openModal({
        title: '切换到「' + name + '」',
        size: 'sm',
        body: U.el('div', { class: 'stack', style: 'gap:8px' }, [pwdInp, err]),
        footer: [
          { text: '取消', onClick: function (c) { c(); } },
          { text: '切换', cls: 'pri', onClick: function (c) {
              var r = global.Store.switchAccount(name, pwdInp.value);
              if (!r.ok) { err.textContent = r.error || '密码不对'; return; }
              c();
              U.toast('已切换到账号「' + name + '」', 'ok', 3000);
              setTimeout(function () { location.reload(); }, 400);
            } },
        ],
      });
      return;
    }
    finishSwitch(name);
  }

  function finishSwitch(name) {
    var r = global.Store.switchAccount(name);
    if (!r.ok) { U.toast(r.error || '切换失败', 'bad'); return; }
    U.toast('已切换到账号「' + name + '」', 'ok', 3000);
    setTimeout(function () { location.reload(); }, 400);
  }

  function doLogout() {
    var r = global.Store.logoutAccount();
    if (!r.ok) { U.toast(r.error || '登出失败', 'bad'); return; }
    U.toast('已登出，回到 default 账号', 'ok', 3000);
    setTimeout(function () { location.reload(); }, 400);
  }

  /* ---------------- 启动 ---------------- */

  function bootAccount() {
    renderAccount();
    // 数据变化后账号区不依赖数据，但切换账号后整页会 reload，无需额外订阅
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootAccount);
  else bootAccount();

  global.Account = {
    render: renderAccount,
    current: current,
    openSwitch: openSwitch,
  };
})(window);
