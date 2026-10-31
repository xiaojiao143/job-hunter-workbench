/* ==========================================================================
   utils.js · 通用工具（无依赖）
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------- DOM ---------- */
  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  /** 创建元素：el('div', {class:'x', html:'..'}, [child...]) */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (!Object.prototype.hasOwnProperty.call(attrs, k)) continue;
      var v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class' || k === 'className') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
      else if (k.slice(0, 2) === 'on' && typeof v === 'function') n.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset' && typeof v === 'object') { for (var d in v) n.dataset[d] = v[d]; }
      else n.setAttribute(k, v === true ? '' : v);
    }
    if (kids) addKids(n, kids);
    return n;
  }

  /**
   * 递归挂子节点。
   * ⚠️ 必须支持**嵌套数组**：`el('div', {}, [a, b.map(...), c])` 是极常见的写法，
   * 只压平一层会把内层数组当成节点直接 appendChild，浏览器抛
   * 「Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'」，
   * 整个页面被错误兜底取代。本项目真踩过：`view-jobs.js` 的岗位卡，
   * **只要岗位库非空这一页就必崩**（空数组也是数组，照样炸）。
   */
  function addKids(n, list) {
    [].concat(list).forEach(function (c) {
      if (c === null || c === undefined || c === false || c === true) return;
      if (Array.isArray(c)) { addKids(n, c); return; }   // 嵌套数组自动展开
      n.appendChild(typeof c === 'string' || typeof c === 'number'
        ? document.createTextNode(String(c)) : c);
    });
  }

  /* ---------- 文本 ---------- */
  function esc(s) {
    if (s === null || s === undefined) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function truncate(s, n) {
    s = String(s || '');
    return s.length > n ? s.slice(0, n) + '…' : s;
  }
  function stripTags(s) { return String(s || '').replace(/<[^>]*>/g, ''); }
  /** 把任意文本切成行数组，去掉空行 */
  function lines(s) {
    return String(s || '').replace(/\r\n?/g, '\n').split('\n')
      .map(function (x) { return x.trim(); }).filter(Boolean);
  }
  /** 取公司名简称（去掉"有限公司"等尾巴，用来看板展示） */
  function shortCompany(name) {
    if (!name) return '';
    var s = String(name).trim();
    return s.length > 12 ? s.replace(/(股份|责任|集团|科技|网络|信息|技术)*有限(责任)?公司$/, '') || s : s;
  }

  /* ---------- 日期 ---------- */
  function now() { return Date.now(); }
  function pad2(n) { return n < 10 ? '0' + n : '' + n; }
  function toDate(ts) { return ts instanceof Date ? ts : new Date(ts); }
  /** 2026-09-25 */
  function d2(ts) {
    if (!ts) return '';
    var d = toDate(ts); if (isNaN(d)) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }
  /** 2026-09-25 17:03 */
  function d2t(ts) {
    if (!ts) return '';
    var d = toDate(ts); if (isNaN(d)) return '';
    return d2(d) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  /** HH:MM */
  function hm(ts) {
    if (!ts) return '';
    var d = toDate(ts); if (isNaN(d)) return '';
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  /** datetime-local 输入框需要的格式 */
  function toLocalInput(ts) {
    if (!ts) return '';
    var d = toDate(ts); if (isNaN(d)) return '';
    return d2(d) + 'T' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
  }
  function fromLocalInput(v) { return v ? new Date(v).getTime() : null; }
  /** 相对时间：3 分钟前 / 2 天前 */
  function rel(ts) {
    if (!ts) return '';
    var s = (now() - toDate(ts).getTime()) / 1000;
    if (s < 0) return futureRel(-s);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    return d2(ts);
  }
  function futureRel(s) {
    if (s < 3600) return Math.ceil(s / 60) + ' 分钟后';
    if (s < 86400) return Math.ceil(s / 3600) + ' 小时后';
    return Math.ceil(s / 86400) + ' 天后';
  }
  /** 距离目标时间还有多久（给面试提醒用） */
  function untilText(ts) {
    if (!ts) return '';
    var s = (toDate(ts).getTime() - now()) / 1000;
    if (s < 0) return '已过 ' + rel(ts);
    return futureRel(s);
  }
  function isSameDay(a, b) { return d2(a) === d2(b); }
  function weekLabel(ts) {
    var d = toDate(ts);
    return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
  }

  /* ---------- 数字 ---------- */
  function num(v, dft) { var n = parseFloat(v); return isNaN(n) ? (dft === undefined ? null : dft) : n; }
  function clamp(n, a, b) { return Math.max(a, Math.min(b, n)); }
  function pct(a, b) { return b > 0 ? Math.round((a / b) * 1000) / 10 : 0; }
  /** 15.2 → 15.2k，15 → 15k，15000 → 15k */
  function kFmt(n) {
    if (n === null || n === undefined || n === '') return '';
    var v = Number(n);
    if (isNaN(v)) return String(n);
    return v >= 1000 ? (v % 1 === 0 ? v : Math.round(v * 10) / 10) + 'k' : String(v);
  }

  /* ---------- 数组 ---------- */
  function uniq(arr) {
    var seen = {}, out = [];
    (arr || []).forEach(function (x) {
      var k = String(x == null ? '' : x).trim();
      if (!k || seen[k.toLowerCase()]) return;
      seen[k.toLowerCase()] = 1; out.push(k);
    });
    return out;
  }
  function uniqBy(arr, fn) {
    var seen = {}, out = [];
    (arr || []).forEach(function (x) {
      var k = fn(x); if (seen[k]) return; seen[k] = 1; out.push(x);
    });
    return out;
  }
  function groupBy(arr, fn) {
    var m = {};
    (arr || []).forEach(function (x) { var k = fn(x); (m[k] = m[k] || []).push(x); });
    return m;
  }
  function sum(arr, fn) {
    return (arr || []).reduce(function (a, x) { return a + (fn ? fn(x) : x) || 0; }, 0);
  }
  function sortBy(arr, fn, desc) {
    return (arr || []).slice().sort(function (a, b) {
      var x = fn(a), y = fn(b);
      if (x === y) return 0;
      var r = x > y ? 1 : -1;
      return desc ? -r : r;
    });
  }
  function take(arr, n) { return (arr || []).slice(0, n); }

  /* ---------- 对象 ---------- */
  function deepClone(o) { return o === undefined ? o : JSON.parse(JSON.stringify(o)); }
  function pick(o, keys) {
    var r = {}; keys.forEach(function (k) { if (o && o[k] !== undefined) r[k] = o[k]; }); return r;
  }
  function uid(prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function debounce(fn, ms) {
    var t = null;
    return function () {
      var self = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, ms || 220);
    };
  }
  function throttle(fn, ms) {
    var last = 0, timer = null;
    return function () {
      var self = this, args = arguments, wait = ms - (Date.now() - last);
      if (wait <= 0) { last = Date.now(); fn.apply(self, args); }
      else if (!timer) timer = setTimeout(function () { last = Date.now(); timer = null; fn.apply(self, args); }, wait);
    };
  }

  /* ---------- JSON 容错 ---------- */
  /**
   * 从大模型回复里抠出 JSON。
   * 大模型经常裹 ```json 代码块、加解释、或者把中文引号写进去，所以这里要能扛。
   */
  function extractJSON(text) {
    if (!text) return null;
    var s = String(text).trim();

    // 去掉 ``` 围栏
    var fence = s.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fence) s = fence[1].trim();

    // 直接解析
    try { return JSON.parse(s); } catch (e) { /* 继续 */ }

    // 截取第一个 { 到最后一个 }（或 [ ]）
    var pairs = [['{', '}'], ['[', ']']];
    for (var i = 0; i < pairs.length; i++) {
      var a = s.indexOf(pairs[i][0]), b = s.lastIndexOf(pairs[i][1]);
      if (a >= 0 && b > a) {
        var chunk = s.slice(a, b + 1);
        var r = tryParseLoose(chunk);
        if (r !== null) return r;
      }
    }
    return null;
  }

  function tryParseLoose(chunk) {
    var variants = [
      chunk,
      chunk.replace(/,\s*([}\]])/g, '$1'),                       // 尾逗号
      chunk.replace(/[\u201c\u201d]/g, '"').replace(/[\u2018\u2019]/g, "'"), // 中文引号
      chunk.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, ''), // 注释
    ];
    for (var i = 0; i < variants.length; i++) {
      var v = variants[i].replace(/,\s*([}\]])/g, '$1').replace(/[\u201c\u201d]/g, '"');
      try { return JSON.parse(v); } catch (e) { /* 下一个 */ }
    }
    return null;
  }

  /**
   * 把可能是字符串/数组/数字的值统一成字符串数组。
   * opt === true 或 {comma:true} 时，额外按逗号拆分
   * （用户手填的"急招, 远程"、爬虫 CSV 里的 "抖音,剪映" 都要拆开；
   *   而 AI 返回的 risk 句子里的逗号不能被拆，所以默认不拆）
   */
  function asArray(v, opt) {
    var comma = opt === true || (opt && opt.comma);
    if (v === null || v === undefined || v === '') return [];
    if (Array.isArray(v)) {
      return v.map(function (x) {
        if (x === null || x === undefined) return '';
        if (typeof x === 'object') {
          return String(x.text || x.name || x.title || x.item || x.label || x.value ||
            x.skill || x.point || x.desc || JSON.stringify(x));
        }
        return String(x);
      }).map(function (s) { return s.trim(); }).filter(Boolean);
    }
    if (typeof v === 'object') {
      var ks = Object.keys(v);
      // {a:true, b:false} 这种开关型对象 → 只取值为真的键
      if (ks.length && ks.every(function (k) { return typeof v[k] === 'boolean'; })) {
        return ks.filter(function (k) { return v[k]; });
      }
      return ks.map(function (k) { return String(v[k]); }).filter(Boolean);
    }
    var sep = comma ? /[\n\r;；、|,，]+/ : /[\n\r;；、|]+/;
    return String(v).split(sep).map(function (s) { return s.trim(); })
      .map(function (s) { return s.replace(/^[-–—*·•\d.、)\s]+/, '').trim(); })
      .filter(function (s) { return s && s !== '无' && s !== '暂无'; });
  }

  /** 把可能是字符串/数字的值统一成数字或 null */
  function asNum(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isNaN(v) ? null : v;
    var m = String(v).replace(/[,，\s]/g, '').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  }

  /** 只保留白名单键（防止模型返回里的奇怪字段污染数据库） */
  function whitelist(obj, keys) {
    var o = obj || {}, r = {};
    keys.forEach(function (k) { if (o[k] !== undefined) r[k] = o[k]; });
    return r;
  }

  /* ---------- 文件 ---------- */
  function download(filename, content, mime) {
    var blob = content instanceof Blob ? content
      : new Blob([content], { type: (mime || 'text/plain') + ';charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 400);
    return true;
  }

  function pickFile(accept, multiple) {
    return new Promise(function (resolve) {
      var inp = document.createElement('input');
      inp.type = 'file';
      if (accept) inp.accept = accept;
      if (multiple) inp.multiple = true;
      inp.style.display = 'none';
      document.body.appendChild(inp);
      inp.addEventListener('change', function () {
        var files = Array.prototype.slice.call(inp.files || []);
        document.body.removeChild(inp);
        resolve(multiple ? files : (files[0] || null));
      });
      inp.click();
    });
  }

  function readText(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsText(file, 'utf-8');
    });
  }
  function readDataURL(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(String(fr.result || '')); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsDataURL(file);
    });
  }

  /** 读成 ArrayBuffer。上传二进制（比如简历 PDF）时用得上 —— 
   *  走 readText 会被 UTF-8 解码搞坏字节。 */
  function readArrayBuffer(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { reject(fr.error); };
      fr.readAsArrayBuffer(file);
    });
  }

  /** UTF-8 安全的 base64。注意 btoa 直接喂中文会抛 InvalidCharacterError，
   *  必须先编码成字节再逐字节 fromCharCode。用来把文件名塞进 HTTP 头。 */
  function b64(str) {
    var s = String(str == null ? '' : str);
    try {
      var bytes = new TextEncoder().encode(s);
      var bin = '';
      for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
      return btoa(bin);
    } catch (e) {
      return '';
    }
  }
  function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(text).then(function () { return true; })
        .catch(function () { return legacyCopy(text); });
    }
    return Promise.resolve(legacyCopy(text));
  }
  function legacyCopy(text) {
    try {
      var ta = document.createElement('textarea');
      ta.value = text; ta.style.cssText = 'position:fixed;top:-1000px;opacity:0';
      document.body.appendChild(ta); ta.select();
      var ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  /* ---------- Toast ---------- */
  /**
   * toast(msg, type, ms, actions)
   * actions: [{ text, cls, onClick }] —— 用来做「撤销」这类即时补救。
   * 带 actions 的 toast 会被钉住不自动消失（用户还没决定，自动收掉等于逼他重来）。
   *
   * ⛔ 内容**默认按纯文本渲染**（走 esc）—— 评审 P1-1：
   *   岗位名 / 公司名来自 BOSS 抓取、粘贴导入，是**第三方可控**的。
   *   直接塞进 innerHTML 就是一个存储型 XSS（脚本一旦执行，能读走同一 localStorage 里的
   *   模型 API Key，还能带着令牌去调采集器的全部接口）。
   *   真要加粗 / 换行，请用 toastHtml() **显式**声明，并自己负责转义其中的插值。
   */
  function toast(msg, type, ms, actions) {
    return _toast(msg, type, ms, actions, false);
  }

  /**
   * toastHtml(msg, type, ms, actions)
   * 与 toast 同参，但内容按 **HTML** 渲染（允许 <b>/<br> 等）。
   * ⛔ 调用方**必须**自己保证 msg 安全 —— 里面插了第三方数据就先用 U.esc 包住。
   */
  function toastHtml(msg, type, ms, actions) {
    return _toast(msg, type, ms, actions, true);
  }

  function _toast(msg, type, ms, actions, isHtml) {
    var box = $('#toasts');
    if (!box) { box = el('div', { id: 'toasts' }); document.body.appendChild(box); }
    var icons = { ok: '✅', warn: '⚠️', bad: '⛔', info: 'ℹ️' };
    var acts = [].concat(actions || []).filter(Boolean);
    var kids = [
      el('span', { class: 'ico', text: icons[type] || '💬' }),
      el('div', { class: 'flex1', html: isHtml ? msg : esc(msg) }),
    ];
    if (acts.length) {
      kids.push(el('div', { class: 'toast-act' }, acts.map(function (a) {
        return el('button', {
          class: 'btn xs ' + (a.cls || ''), text: a.text,
          onclick: function (e) {
            if (e && e.stopPropagation) e.stopPropagation();
            if (a.onClick) { try { a.onClick(); } catch (err) { console.error(err); } }
            if (a.keepOpen !== true) kill();
          },
        });
      })));
    }
    var t = el('div', { class: 'toast ' + (type || '') }, kids);
    box.appendChild(t);

    var dead = false;
    function kill() {
      if (dead) return;
      dead = true;
      t.style.transition = 'opacity .25s, transform .25s';
      t.style.opacity = '0'; t.style.transform = 'translateX(12px)';
      setTimeout(function () { if (t.parentNode) t.parentNode.removeChild(t); }, 260);
    }
    // 有操作按钮就多给点时间（撤销窗口），且鼠标悬停时不倒计时
    var life = ms || (acts.length ? 10000 : type === 'bad' ? 6200 : type === 'warn' ? 5200 : 3000);
    var timer = setTimeout(kill, life);
    if (acts.length) {
      t.addEventListener('mouseenter', function () { clearTimeout(timer); });
      t.addEventListener('mouseleave', function () { timer = setTimeout(kill, 4000); });
    }
    t._kill = kill;
    return t;
  }

  /* ---------- 重画时保住输入焦点 ---------- */

  /**
   * 记下「此刻正在输入的那个框」，供 restoreFocus 之后还原。
   *
   * 靠 `[data-focus-key]` 认框，**不能靠 id**：重画后那是个全新的节点，
   * 而我们要判断的正是「这个新框是不是刚才那个框的替身」。
   * 只认显式标了这个属性的元素 —— 否则「点了某个按钮」的焦点也会被当成要恢复的目标。
   *
   * 为什么要有这东西（评审 4.1，实测确认）：防抖里走整页/整卡重建时
   * （`view.innerHTML=''` / `card.innerHTML=''`），输入框节点被换掉，
   * 用户每敲一个字就丢焦点、后一个字落在空处。
   */
  function captureFocus(box) {
    var d = global.document;
    var a = d && d.activeElement;
    if (!a || !a.getAttribute) return null;
    // 给了 box 就要求焦点本来就在它里面；没给（整页重建）就任意位置都算
    if (box && (!box.contains || !box.contains(a))) return null;
    var key = a.getAttribute('data-focus-key');
    if (!key) return null;
    var sel = null;
    try {
      if (typeof a.selectionStart === 'number') sel = [a.selectionStart, a.selectionEnd];
    } catch (e) { sel = null; }        // 某些 input type 读选区会抛，忽略
    return { key: key, sel: sel };
  }

  function restoreFocus(snap, box) {
    if (!snap) return;
    var d = global.document;
    var root = box || d;
    if (!root || !root.querySelector) return;
    var n;
    try { n = root.querySelector('[data-focus-key="' + snap.key + '"]'); } catch (e) { n = null; }
    if (!n || typeof n.focus !== 'function') return;
    try {
      n.focus();
      if (snap.sel && typeof n.setSelectionRange === 'function' && snap.sel[0] != null) {
        n.setSelectionRange(snap.sel[0], snap.sel[1]);
      }
    } catch (e) { /* 选区还原不了不要紧，焦点回来才是关键 */ }
  }

  /** 跑一段「会重画 DOM」的代码，跑完把我原来正在输入的框重新聚焦、光标位置还原。 */
  function withFocusKept(fn) {
    var snap = captureFocus(null);
    var out;
    try {
      out = fn();
    } catch (e) {
      restoreFocus(snap);
      throw e;                          // 出错也要把焦点还回去，但异常照抛
    }
    restoreFocus(snap);
    return out;
  }

  /* ---------- 弹窗 ---------- */
  var _modalStack = [];

  /**
   * openModal({title, body:node|html, footer:[{text,cls,onClick(close)}], size:'sm'|'wide'|'xl', onClose})
   */
  function openModal(opt) {
    opt = opt || {};
    var title = opt.title || '';
    var bodyNode = opt.body || '';
    var footer = opt.footer || [];

    var mbody = el('div', { class: 'mbody' });
    // ⚠️ body 传字符串 → 按 HTML 渲染（confirmBox 就是这么用 <b>/<span> 的）。
    //    这是**受信任内容**通道：调用方插第三方数据时**必须**先用 U.esc 包住。
    //    （评审核实 2026-10-12 P2-32：51 个调用点里只有 confirmBox 传字符串。）
    if (typeof bodyNode === 'string') mbody.innerHTML = bodyNode;
    else if (bodyNode) mbody.appendChild(bodyNode);

    // ⛔ 标题**默认转义**（评审 P1-1）：标题里插的常是岗位名 / 公司名 / 简历名，
    //    都是第三方可控数据（如 `title: 'AI 解析岗位 · ' + j.title`）。
    //    实测全项目 49 个弹窗标题**没有一个**是故意写 HTML 的，所以默认转义零副作用。
    var head = el('header', {}, [el('h3', { html: esc(title) })]);
    var modal = el('div', { class: 'modal ' + (opt.size || '') }, [head]);

    var mask = el('div', { class: 'mask' });
    mask.appendChild(modal);

    function close(skipOnClose) {
      if (!mask.parentNode) return;

      // beforeClose 可以否决这次关闭（返回 false）—— 用来拦「有没保存的修改」。
      // 注意调用方在否决后自己负责再调一次 close()，否则弹窗就再也关不掉了。
      if (opt.beforeClose && !skipOnClose) {
        var allow = true;
        try { allow = opt.beforeClose() !== false; } catch (e) { allow = true; }
        if (!allow) return;
      }

      document.removeEventListener('keydown', onKey);
      mask.parentNode.removeChild(mask);
      _modalStack = _modalStack.filter(function (x) { return x !== close; });
      // ⚠️ onClose 必须【异步】触发，绝不能同步调。
      // 本项目所有「确认型」弹窗（confirmBox / promptBox / jobPicker / resumePicker）
      // 的按钮回调写法都是「先 c() 关窗，再 resolve(成功值)」。
      // 如果 onClose 同步执行，onClose 里的 resolve(null/false) 会抢先落地，
      // 而 Promise 只认第一次 resolve —— 结果点「确认」等于点「取消」，
      // 删除岗位 / 新建面试 / 清空数据 / 导入覆盖 / 绑定简历全部静默失效。
      // 放到下一个宏任务，让按钮回调自己的 resolve(成功值) 先跑完。
      if (opt.onClose && !skipOnClose) {
        setTimeout(function () { try { opt.onClose(); } catch (e) { /* noop */ } }, 0);
      }
    }
    /* ⚠️ 必须包一层，不能写成 onclick: close。
       当成事件处理器直接挂上去时，浏览器会把 MouseEvent 当作第一个实参传进来，
       而 close(skipOnClose) 的第一个形参恰好是"跳过守卫"——
       结果就是点 ✕ 永远绕过 beforeClose，「有修改没保存」的拦截形同虚设。
       （这个 bug 在自写 DOM 桩里查不出来：桩的 .click() 不造事件对象。） */
    var xBtn = el('button', { class: 'x', title: '关闭', html: '✕', onclick: function () { close(); } });
    head.appendChild(el('span', { class: 'sp' }));
    head.appendChild(xBtn);

    // 只要「传了 footer」就创建 .mfoot 容器（哪怕传的是空数组）——
    // 调用方经常先传 [] 再自己往 .mfoot 里 append 按钮。
    // 空的时候靠 CSS 的 .mfoot:empty 藏起来，不会留一条空白条。
    if (Array.isArray(opt.footer)) {
      // 主按钮置右：如果第一个按钮是主按钮，挪到最后
      if (footer.length > 1 && (footer[0].cls || '').indexOf('pri') >= 0) {
        footer = footer.slice(1).concat([footer[0]]);
      }
      var mfoot = el('div', { class: 'mfoot' });
      footer.forEach(function (b) {
        if (!b) return;
        var btn = el('button', {
          class: 'btn ' + (b.cls || ''),
          text: b.text,
          onclick: function () { if (b.onClick) b.onClick(close, btn); else close(); },
        });
        if (b.id) btn.id = b.id;
        mfoot.appendChild(btn);
      });
      modal.appendChild(mbody);
      modal.appendChild(mfoot);
    } else {
      modal.appendChild(mbody);
    }

    function onKey(e) {
      if (e.key === 'Escape' && _modalStack[_modalStack.length - 1] === close) close();
    }
    document.addEventListener('keydown', onKey);
    mask.addEventListener('mousedown', function (e) { if (e.target === mask && opt.maskClose !== false) close(); });

    document.body.appendChild(mask);
    _modalStack.push(close);

    setTimeout(function () {
      var f = mbody.querySelector('[autofocus],input:not([type=hidden]),textarea,select');
      if (f) { try { f.focus(); } catch (e) { /* noop */ } }
    }, 60);

    return { close: close, body: mbody, modal: modal, header: head };
  }

  /**
   * 脏检查守卫 —— 给 openModal 的 beforeClose 用。
   *
   * 为什么需要：表单弹窗点「✕」「取消」、按 Esc、点遮罩都会直接关掉，
   * 用户敲了半天的内容一声不响就没了。这里拦一次，让他确认。
   *
   * ⚠️ 关键用法：mark() 必须在 openModal() **返回之后**再调。
   *    如果在 openModal 调用前 mark()，基线拿到的是建好的空输入框，
   *    而 openModal 内部会把初值填进控件（见各表单），等于「一打开就是脏的」，
   *    每次关窗都弹确认，比不拦还烦。
   *
   *    反过来说，「保存」按钮走的是 close(true)（跳过 beforeClose），
   *    所以保存成功绝不会被自己拦下 —— 不需要额外的 savedOnce 标志位。
   *
   * @param {Function} getValues 返回当前表单值的函数，结果需可 JSON 序列化
   * @param {Object} [opt] { msg, when } when() 返回 false 时整体不生效
   */
  function dirtyGuard(getValues, opt) {
    opt = opt || {};
    var base = null;

    function snap() {
      try { return JSON.stringify(getValues()); }
      catch (e) { return null; }     // 值里有循环引用之类 → 当作不脏，别误拦
    }

    function isDirty() {
      if (base === null) return false;      // 还没 mark，不拦
      var s = snap();
      if (s === null) return false;
      return s !== base;
    }

    return {
      /** 把当前表单值记为「已保存」基线 */
      mark: function () { base = snap(); },
      isDirty: isDirty,
      /** 直接传进 openModal({ beforeClose: guard.check }) */
      check: function () {
        if (opt.when && !opt.when()) return true;
        if (!isDirty()) return true;
        return global.confirm(opt.msg || '有修改还没保存，确定放弃吗？');
      },
    };
  }

  function confirmBox(msg, opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      // settled 守卫：按钮回调与 onClose 都会 resolve，只让第一个生效
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      openModal({
        title: opt.title || '请确认',
        size: 'sm',
        body: '<div style="font-size:13.5px;line-height:1.7">' + msg + '</div>',
        footer: [
          // 顺序要紧：先 resolve(成功值)，再关窗
          { text: opt.okText || '确认', cls: opt.danger ? 'danger' : 'pri', onClick: function (c) { done(true); c(); } },
          { text: '取消', onClick: function (c) { done(false); c(); } },
        ],
        onClose: function () { done(false); },
      });
    });
  }

  function promptBox(title, label, value, opt) {
    opt = opt || {};
    return new Promise(function (resolve) {
      var settled = false;
      function done(v) { if (settled) return; settled = true; resolve(v); }
      var ta = el('textarea', { class: opt.mono ? 'mono' : '', rows: opt.rows || 3, placeholder: opt.placeholder || '' });
      ta.value = value || '';
      var wrap = el('div', {}, [
        el('div', { class: 'fld' }, [el('label', { class: 'lb', text: label || '' }), ta]),
      ]);
      openModal({
        title: title,
        body: wrap,
        footer: [
          { text: '确定', cls: 'pri', onClick: function (c) { done(ta.value); c(); } },
          { text: '取消', onClick: function (c) { done(null); c(); } },
        ],
        onClose: function () { done(null); },
      });
    });
  }

  /**
   * 关掉所有还开着的弹窗。
   * @param {Boolean} [skipBeforeClose] true = 强制关（跳过 beforeClose 守卫）。
   *   程序化跳页时要传 true：守卫是拦"手滑关掉"的（✕ / Esc / 遮罩 / 取消），
   *   而不是拦"用户明确要离开这一页"。不传的话，一个持续否决的守卫
   *   会让整页卡在弹窗上出不来。
   */
  function closeAllModals(skipBeforeClose) {
    _modalStack.slice().forEach(function (f) { f(skipBeforeClose); });
  }

  /* ---------- 浮层菜单（「⋯ 更多」） ---------- */
  /**
   * menu(anchor, [{icon,text,danger,onClick}|{divider:true}], {align:'left'|'right', width})
   * 把低频 / 危险操作收进菜单，界面上只留高频操作。
   * 再点同一个锚点会关掉（开关式）；点别处、按 Esc、窗口尺寸变化都会关。
   */
  var _menuEl = null;
  function _menuDoc(e) { if (_menuEl && !_menuEl.contains(e.target)) closeMenu(); }
  function _menuKey(e) { if (e.key === 'Escape') closeMenu(); }

  function closeMenu() {
    if (_menuEl && _menuEl.parentNode) _menuEl.parentNode.removeChild(_menuEl);
    _menuEl = null;
    document.removeEventListener('mousedown', _menuDoc, true);
    document.removeEventListener('keydown', _menuKey);
    if (global.removeEventListener) global.removeEventListener('resize', closeMenu);
  }

  function menu(anchor, items, opt) {
    opt = opt || {};
    if (_menuEl && _menuEl._anchor === anchor) { closeMenu(); return null; }
    closeMenu();
    var box = el('div', { class: 'menu' });
    [].concat(items || []).forEach(function (it) {
      if (!it) return;
      if (it.divider) { box.appendChild(el('div', { class: 'mdiv' })); return; }
      box.appendChild(el('button', {
        class: 'mi' + (it.danger ? ' danger' : ''), type: 'button',
        html: (it.icon ? '<span class="ic">' + it.icon + '</span>' : '') + esc(it.text),
        onclick: function () { closeMenu(); if (it.onClick) it.onClick(); },
      }));
    });
    if (!box.children.length) return null;

    document.body.appendChild(box);
    box._anchor = anchor;
    _menuEl = box;

    // 定位：优先贴着锚点；拿不到位置信息（测试桩 / 极端环境）就落到右下角
    var W = opt.width || 196;
    var r = anchor && typeof anchor.getBoundingClientRect === 'function' ? anchor.getBoundingClientRect() : null;
    if (r && (r.left || r.top)) {
      var vw = global.innerWidth || 1200, vh = global.innerHeight || 800, M = 10;
      var left = opt.align === 'left' ? r.left : (r.right - W);
      left = clamp(left, M, Math.max(M, vw - W - M));
      var h = box.clientHeight || (box.children.length * 36 + 14);
      var top = r.bottom + 6;
      if (top + h > vh - M) top = Math.max(M, r.top - h - 6);
      box.style.left = left + 'px';
      box.style.top = top + 'px';
    } else {
      box.style.right = '22px';
      box.style.bottom = '84px';
    }

    document.addEventListener('mousedown', _menuDoc, true);
    document.addEventListener('keydown', _menuKey);
    if (global.addEventListener) global.addEventListener('resize', closeMenu);
    return box;
  }

  /* ---------- 高亮 ---------- */
  function highlight(text, kw) {
    var t = esc(text);
    if (!kw) return t;
    var k = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    try { return t.replace(new RegExp('(' + k + ')', 'gi'), '<mark style="background:#fff3b0;color:inherit;padding:0 1px;border-radius:2px">$1</mark>'); }
    catch (e) { return t; }
  }

  /* ---------- 其他 ---------- */
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function bytes(n) {
    if (!n) return '0 B';
    var u = ['B', 'KB', 'MB', 'GB'], i = 0;
    while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
    return (Math.round(n * 10) / 10) + ' ' + u[i];
  }

  global.U = {
    $: $, $$: $$, el: el,
    esc: esc, truncate: truncate, stripTags: stripTags, lines: lines, shortCompany: shortCompany,
    now: now, d2: d2, d2t: d2t, hm: hm, toLocalInput: toLocalInput, fromLocalInput: fromLocalInput,
    rel: rel, untilText: untilText, isSameDay: isSameDay, weekLabel: weekLabel, pad2: pad2,
    num: num, clamp: clamp, pct: pct, kFmt: kFmt,
    uniq: uniq, uniqBy: uniqBy, groupBy: groupBy, sum: sum, sortBy: sortBy, take: take,
    deepClone: deepClone, pick: pick, uid: uid, debounce: debounce, throttle: throttle,
    extractJSON: extractJSON, asArray: asArray, asNum: asNum, whitelist: whitelist,
    download: download, pickFile: pickFile, readText: readText, readDataURL: readDataURL,
    readArrayBuffer: readArrayBuffer, b64: b64,
    copyText: copyText,
    toast: toast, toastHtml: toastHtml, openModal: openModal, confirm: confirmBox, prompt: promptBox,
    // 重画时保住输入焦点（评审 4.1）
    captureFocus: captureFocus, restoreFocus: restoreFocus, withFocusKept: withFocusKept,
    dirtyGuard: dirtyGuard,
    closeAllModals: closeAllModals, menu: menu, closeMenu: closeMenu, highlight: highlight,
    sleep: sleep, bytes: bytes,
  };
})(window);
