/**
 * 求职猎手工作台 · 核心逻辑 + 全页面渲染单测（不开浏览器）
 *
 * 沿用本项目的「前端逻辑单测法」：在 Node 里搭一个够用的 DOM 桩，
 * 把 js/*.js 按 index.html 里的顺序跑起来，然后：
 *   ① 测纯逻辑（数据层 / 导入导出 / JSON 容错 / 统计口径）
 *   ② 把 9 个页面依次真渲染一遍，看会不会抛异常
 *      —— 这类错误在浏览器里表现为「整块空白」，光看截图根本找不到是哪行炸的
 *
 * 跑法：
 *   node "D:/AIshuju/BOSS/求职猎手工作台/_测试_核心.js"
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DIR = __dirname;
// ⚠️ 脚本清单**从 index.html 现读**（见下面的 scriptOrder），别在这里再抄一份 ——
//    抄一份必然漂移：前两轮加进 index.html 的 job-taxonomy / job-picker 就没被静态检查覆盖到。

/* 「打包工程」目录 —— 便携版/安装包的构建现场。
   它是 `求职猎手工作台/` 的**兄弟目录**，不在工作台里，所以先解析一次。
   找不到就明确报红（不静默跳过：静默跳过 = 两份服务端/打包入口漂移了也没人知道）。 */
const PACK_DIR = (function () {
  const cands = [process.env.JH_PACK_DIR,
                 path.join(DIR, '_打包工程'),
                 path.join(DIR, '..', '_打包工程'),
                 'D:/AIshuju/BOSS/_打包工程'];
  for (let i = 0; i < cands.length; i++) {
    const c = cands[i];
    if (!c) continue;
    if (fs.existsSync(path.join(c, 'src', 'server_core.py')) &&
        fs.existsSync(path.join(c, 'crawler_src', 'entry.py'))) return c;
  }
  return '';
})();

/* ======================================================================
   一、DOM / 浏览器环境桩
   ====================================================================== */

/** 极简选择器：支持 tag / .class / #id / [attr] / :last-child / 后代与 > 组合 */
function matches(el, sel) {
  sel = sel.trim();
  if (!sel) return false;
  // 取最后一个简单选择器（后代关系交给 queryAll 处理）
  return sel.split(/[\s>]+/).filter(Boolean).every(() => true) && simpleMatches(el, lastSimple(sel));
}
function lastSimple(sel) {
  const parts = sel.split(/\s+/).filter(Boolean);
  return parts[parts.length - 1].split('>').filter(Boolean).pop();
}
function simpleMatches(el, s) {
  if (!el || el.nodeType !== 1) return false;
  if (s === '*') return true;
  // 拆 tag、#id、.class、[attr]（忽略 :pseudo 里的 last-child 等）
  const pseudoLast = /:last-child/.test(s);
  const pseudoFirst = /:first-child/.test(s);
  const pseudoNot = s.match(/:not\(([^)]+)\)/);
  const bare = s.replace(/:[\w-]+(\([^)]*\))?/g, '');

  if (pseudoLast) {
    const p = el.parentNode;
    if (!p || p.children[p.children.length - 1] !== el) return false;
  }
  if (pseudoFirst) {
    const p = el.parentNode;
    if (!p || p.children[0] !== el) return false;
  }
  if (pseudoNot) {
    const inner = pseudoNot[1];
    if (simpleMatches(el, inner.replace(/\[[^\]]*\]/g, '').trim() || inner)) {
      // 只对 class / tag 做否定
      const m = inner.match(/\.([\w-]+)/);
      if (!m || (el._cls && el._cls.has(m[1]))) return false;
    }
  }

  const tagM = bare.match(/^[a-zA-Z][\w-]*/);
  if (tagM && el.tagName.toLowerCase() !== tagM[0].toLowerCase()) return false;

  const idM = bare.match(/#([\w-]+)/);
  if (idM && el.id !== idM[1]) return false;

  const clsMs = bare.match(/\.([\w-]+)/g) || [];
  for (const c of clsMs) {
    if (!el._cls || !el._cls.has(c.slice(1))) return false;
  }

  const attrs = bare.match(/\[([^\]]+)\]/g) || [];
  for (const a of attrs) {
    let body = a.slice(1, -1);
    const eq = body.indexOf('=');
    if (eq < 0) {
      if (el.getAttribute(body) === null) return false;
    } else {
      const k = body.slice(0, eq);
      const v = body.slice(eq + 1).replace(/^["']|["']$/g, '');
      if (String(el.getAttribute(k)) !== v) return false;
    }
  }
  return true;
}

function queryAll(root, sel) {
  const out = [];
  const groups = sel.split(',').map(s => s.trim()).filter(Boolean);
  for (const g of groups) {
    // 支持 "a b"（后代）与 "a > b"（子级）
    const steps = g.split(/\s+/).filter(Boolean);
    let ctx = [root];
    for (let i = 0; i < steps.length; i++) {
      const step = steps[i];
      const childOnly = step.indexOf('>') === 0 || (i > 0 && steps[i - 1] === '>');
      const s = step.replace(/^>/, '');
      if (s === '>') continue;
      const next = [];
      for (const c of ctx) {
        const pool = childOnly ? c.children : descendants(c);
        for (const el of pool) if (simpleMatches(el, s)) next.push(el);
      }
      ctx = next;
    }
    for (const el of ctx) if (out.indexOf(el) < 0) out.push(el);
  }
  return out;
}
function descendants(node) {
  const out = [];
  (function walk(n) {
    for (const c of n.children) { out.push(c); walk(c); }
  })(node);
  return out;
}

let EL_ID = 0;
class El {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag || 'div').toUpperCase();
    this._cls = new Set();
    this._attrs = {};
    this.children = [];
    this.childNodes = [];
    this.parentNode = null;
    this._listeners = {};
    this._html = '';
    /* style 也要像真的：除了 el.style.xxx = '' 这种写法，
       代码里还会用 setProperty 写 CSS 变量（简历导出预览就靠它套主题色）。
       桩少了这两个方法 → 功能没坏却报 "setProperty is not a function"。 */
    this.style = new Proxy({ cssText: '' }, {
      get: (t, k) => {
        if (k === 'setProperty') return (n, v) => { t[n] = String(v); };
        if (k === 'getPropertyValue') return (n) => (t[n] === undefined ? '' : t[n]);
        if (k === 'removeProperty') return (n) => { delete t[n]; };
        return k in t ? t[k] : '';
      },
      set: (t, k, v) => { t[k] = v; return true; },
    });
    this.dataset = {};
    this._id = ++EL_ID;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.files = [];
    this.scrollTop = 0;
    this.scrollHeight = 0;
    this.clientHeight = 0;
    this.clientWidth = 1200;
    this.classList = {
      add: (c) => { this._cls.add(c); },
      remove: (c) => { this._cls.delete(c); },
      toggle: (c, f) => { const on = f === undefined ? !this._cls.has(c) : !!f; on ? this._cls.add(c) : this._cls.delete(c); return on; },
      contains: (c) => this._cls.has(c),
    };
  }
  get className() { return Array.from(this._cls).join(' '); }
  set className(v) { this._cls = new Set(String(v || '').split(/\s+/).filter(Boolean)); }
  get id() { return this._attrs.id || ''; }
  set id(v) { this._attrs.id = v; }
  get innerHTML() { return this._html; }
  set innerHTML(v) {
    this._html = String(v == null ? '' : v);
    // 真实 DOM 会把被移除的子树解绑（parentNode 置空）——
    // 桩也要照做，否则 `root.contains(oldNode)` 会一直为真，
    // 让「切页后异步回调还在往废节点上画」这类 bug 查不出来。
    this.childNodes.forEach(c => { if (c) c.parentNode = null; });
    this.children = [];
    this.childNodes = [];
  }
  get textContent() {
    if (this._html && !this.childNodes.length) return this._html.replace(/<[^>]*>/g, '');
    return this.childNodes.map(c => (c.nodeType === 1 ? c.textContent : String(c.textContent || ''))).join('');
  }
  set textContent(v) { this._html = String(v == null ? '' : v); this.children = []; this.childNodes = []; }
  get firstChild() { return this.childNodes[0] || null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
  getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; }
  setAttribute(k, v) { this._attrs[k] = String(v); if (k === 'class') this.className = v; if (k === 'id') this.id = v; }
  removeAttribute(k) { delete this._attrs[k]; }
  hasAttribute(k) { return k in this._attrs; }
  /** 只有元素节点进 children（和真实 DOM 一致），文本节点只进 childNodes */
  _sync() { this.children = this.childNodes.filter(c => c.nodeType === 1); }
  /** ⚠️ 真实 DOM 会校验参数类型，桩也必须校验 —— 否则「appendChild(null)」
   *  这类 bug 会被静默吞掉，单测全绿但浏览器照样炸（本项目真踩过）。 */
  _mustBeNode(c, method) {
    if (c && typeof c.nodeType === 'number') return c;
    throw new TypeError("Failed to execute '" + method +
      "' on 'Node': parameter 1 is not of type 'Node'.");
  }
  appendChild(c) {
    this._mustBeNode(c, 'appendChild');
    if (c._isFragment) { c.children.slice().forEach(x => this.appendChild(x)); return c; }
    if (c.parentNode) c.parentNode.removeChild(c);
    c.parentNode = this; this.childNodes.push(c); this._sync();
    return c;
  }
  removeChild(c) {
    this.childNodes = this.childNodes.filter(x => x !== c);
    this._sync();
    if (c) c.parentNode = null;
    return c;
  }
  replaceChild(nw, old) {
    this._mustBeNode(nw, 'replaceChild');
    const i = this.childNodes.indexOf(old);
    if (i >= 0) { this.childNodes[i] = nw; nw.parentNode = this; old.parentNode = null; this._sync(); }
    return old;
  }
  insertBefore(nw, ref) {
    this._mustBeNode(nw, 'insertBefore');
    const i = ref ? this.childNodes.indexOf(ref) : this.childNodes.length;
    const at = i < 0 ? this.childNodes.length : i;
    this.childNodes.splice(at, 0, nw); nw.parentNode = this; this._sync();
    return nw;
  }
  querySelector(s) { return queryAll(this, s)[0] || null; }
  querySelectorAll(s) { return queryAll(this, s); }
  closest(s) {
    let n = this;
    while (n && n.nodeType === 1) {
      if (simpleMatches(n, lastSimple(s))) return n;
      n = n.parentNode;
    }
    return null;
  }
  contains(n) {
    while (n) { if (n === this) return true; n = n.parentNode; }
    return false;
  }
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); }
  removeEventListener(t, fn) {
    if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter(f => f !== fn);
  }
  dispatchEvent(e) {
    (this._listeners[e.type] || []).forEach(fn => fn(e));
    if (e.type === 'click' && typeof this.onclick === 'function' && !(this._listeners.click || []).includes(this.onclick)) this.onclick(e);
    return true;
  }
  click() { this.dispatchEvent({ type: 'click', target: this, stopPropagation() {}, preventDefault() {} }); }
  /* ⛔ 焦点必须真的模拟出来，不能是空的 no-op。
     原来 `focus() {}` 让「重画把输入框换掉 → 焦点和光标全丢」这类 bug
     **在测试里永远不可见**（评审 4.1 就是这么漏掉的）。
     现在 focus() 记住 activeElement，blur() 清掉；selectionStart/End 可读写，
     于是「重画后焦点还在不在、光标位置对不对」变成可断言的事。 */
  focus() { document.activeElement = this; }
  blur() { if (document.activeElement === this) document.activeElement = null; }
  select() { this.selectionStart = 0; this.selectionEnd = String(this.value || '').length; }
  setSelectionRange(a, b) { this.selectionStart = a; this.selectionEnd = b; }
  scrollIntoView() {}
  insertAdjacentHTML(_, html) { const d = document.createElement('div'); d.innerHTML = html; d.children.slice().forEach(c => this.appendChild(c)); }
  appendChildHTML() {}
  get outerHTML() { return serialize(this); }
}

function serialize(el) {
  const cls = el.className ? ' class="' + el.className + '"' : '';
  const id = el.id ? ' id="' + el.id + '"' : '';
  const attrs = Object.keys(el._attrs).filter(k => k !== 'class' && k !== 'id')
    .map(k => ' ' + k + '="' + el._attrs[k] + '"').join('');
  const inner = el._html || el.children.map(serialize).join('');
  return '<' + el.tagName.toLowerCase() + id + cls + attrs + '>' + inner + '</' + el.tagName.toLowerCase() + '>';
}

/* ---- 从真实 index.html 解析出页面骨架，这样「JS 引用了不存在的 id」也能被抓到 ---- */
const VOID_TAGS = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'area', 'base', 'col', 'embed', 'param', 'track', 'wbr']);

function parseAttrs(s) {
  const out = [];
  const re = /([^\s"'>=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) {
    if (!m[1]) continue;
    out.push([m[1], m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4] !== undefined ? m[4] : '']);
  }
  return out;
}

function parseHTML(html) {
  const roots = [];
  const stack = [];
  const re = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?)*)\s*(\/?)>/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[0].lastIndexOf('<!--', 0) === 0) continue;
    const tag = m[2].toLowerCase();
    if (m[1] === '/') {
      for (let k = stack.length - 1; k >= 0; k--) {
        if (stack[k].tagName.toLowerCase() === tag) { stack.length = k; break; }
      }
      continue;
    }
    const node = new El(tag);
    parseAttrs(m[3] || '').forEach(a => node.setAttribute(a[0], a[1]));
    const parent = stack.length ? stack[stack.length - 1] : null;
    if (parent) parent.appendChild(node); else roots.push(node);
    if (!VOID_TAGS.has(tag) && m[4] !== '/') stack.push(node);
  }
  return roots;
}

const documentElement = new El('html');
documentElement.setAttribute('data-theme', 'light');

const document = {
  nodeType: 9,
  readyState: 'loading',
  documentElement,
  body: new El('body'),
  // 当前获得焦点的元素。真实浏览器里由 focus()/blur() 维护 ——
  // 桩里必须也有，否则「重画丢焦点」永远测不出来（见 El.focus 上的注释）。
  activeElement: null,
  _listeners: {},
  createElement: (t) => new El(t),
  createTextNode: (t) => ({ nodeType: 3, textContent: String(t == null ? '' : t) }),
  createDocumentFragment: () => { const f = new El('frag'); f._isFragment = true; return f; },
  getElementById(id) { return queryAll(documentElement, '#' + id)[0] || queryAll(this.body, '#' + id)[0] || null; },
  querySelector(s) { return queryAll(documentElement, s)[0] || queryAll(this.body, s)[0] || null; },
  querySelectorAll(s) {
    const a = queryAll(documentElement, s);
    const b = queryAll(this.body, s).filter(x => a.indexOf(x) < 0);
    return a.concat(b);
  },
  addEventListener(t, fn) { (this._listeners[t] = this._listeners[t] || []).push(fn); },
  removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter(f => f !== fn); },
  _fire(t) { (this._listeners[t] || []).forEach(fn => fn({ type: t })); },
};
// body 挂在 documentElement 上，好让 document.querySelector 能找到 #view 等
// 先把 index.html 里的静态骨架塞进 body（此时脚本还没加载，不需要 id 已存在）
const _htmlSrc = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const _bodyMatch = _htmlSrc.match(/<body>([\s\S]*)<\/body>/);
const _shellHtml = (_bodyMatch ? _bodyMatch[1] : '').replace(/<script[\s\S]*?<\/script>/g, '');
parseHTML(_shellHtml).forEach(n => document.body.appendChild(n));

documentElement.appendChild(document.body);

const localStorageMap = new Map();
const localStorage = {
  getItem: k => (localStorageMap.has(k) ? localStorageMap.get(k) : null),
  setItem: (k, v) => localStorageMap.set(k, String(v)),
  removeItem: k => localStorageMap.delete(k),
  clear: () => localStorageMap.clear(),
};

// sessionStorage 也要有：Comp.aiReadyNote() 的「本页不再提示」靠它记状态。
// 不留桩的话那边 try/catch 会把 ReferenceError 吞掉 —— 功能看着正常、实际没生效。
const sessionStorageMap = new Map();
const sessionStorage = {
  getItem: k => (sessionStorageMap.has(k) ? sessionStorageMap.get(k) : null),
  setItem: (k, v) => sessionStorageMap.set(k, String(v)),
  removeItem: k => sessionStorageMap.delete(k),
  clear: () => sessionStorageMap.clear(),
};

const notifications = [];
function Notification(title, opts) { notifications.push({ title, opts }); }
Notification.permission = 'granted';
Notification.requestPermission = () => Promise.resolve('granted');

const sandbox = {
  console,
  setTimeout,
  clearTimeout,
  setInterval: () => 0,
  clearInterval: () => {},
  Promise, JSON, Math, Date, Object, Array, String, Number, Boolean, Error, RegExp, Set, Map,
  parseFloat, parseInt, isNaN, isFinite, encodeURIComponent, decodeURIComponent, TextDecoder,
  document, localStorage, sessionStorage, Notification,
  navigator: { clipboard: { writeText: () => Promise.resolve() }, userAgent: 'node' },
  location: { hash: '', href: 'file:///test/index.html', reload() {} },
  getComputedStyle: () => ({ getPropertyValue: () => '' }),
  Blob: class { constructor(p) { this.parts = p; } },
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL: () => {} },
  FileReader: class {},
  fetch: () => Promise.reject(new Error('测试环境不发真实请求')),
  AbortController: class { constructor() { this.signal = { aborted: false, addEventListener() {} }; } abort() { this.signal.aborted = true; } },
  alert: () => {},
  confirm: () => true,
  /* window.open —— 应用里「去 BOSS 投递」就是靠它开新标签页。
     桩里不留的话，那个按钮一被点到就抛「open is not a function」，
     而且**测不出跳转到底有没有发生**。留成可观测的：调用过就记下 URL。 */
  open: (url) => { sandbox.__openedUrl = url; return { opener: null, document: null }; },
  __notifications: notifications,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.self = sandbox;
sandbox.addEventListener = (t, fn) => document.addEventListener(t, fn);
sandbox.removeEventListener = (t, fn) => document.removeEventListener(t, fn);
sandbox.focus = () => {};
// index.html 里有一行内联脚本 <script>window.Views = {};</script>，这里等价还原
sandbox.Views = {};
/* 访问令牌：真实环境里由采集器 serve index.html 时注入（window.__JH_TOKEN__）。
   桩里默认给一个，等价于「页面是采集器打开的」——否则采集页会渲染「缺访问令牌」引导卡，
   下面所有在线态断言都会红。专门的「缺令牌」用例会临时把它删掉再验。 */
sandbox.__JH_TOKEN__ = 'unit-test-token';

const ctx = vm.createContext(sandbox);

/* ======================================================================
   二、按 index.html 的顺序加载脚本
   ====================================================================== */
const indexHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const scriptOrder = (indexHtml.match(/<script src="([^"]+)"><\/script>/g) || [])
  .map(x => x.replace(/.*src="([^"]+)".*/, '$1'));

let loadErrors = [];
scriptOrder.forEach(rel => {
  const p = path.join(DIR, rel);
  if (!fs.existsSync(p)) { loadErrors.push('缺文件：' + rel); return; }
  try {
    vm.runInContext(fs.readFileSync(p, 'utf8'), ctx, { filename: rel });
  } catch (e) {
    loadErrors.push(rel + ' → ' + e.message);
  }
});
if (loadErrors.length) {
  console.log('❌ 脚本加载失败：');
  loadErrors.forEach(e => console.log('   ' + e));
  process.exit(1);
}

/* ======================================================================
   三、断言工具
   ====================================================================== */
let pass = 0, fail = 0;
const failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; failures.push(name + (extra ? '　→ ' + extra : '')); console.log('  ✗ ' + name + (extra ? '　→ ' + extra : '')); }
}
function eq(name, a, b) { ok(name + '（期望 ' + JSON.stringify(b) + '）', JSON.stringify(a) === JSON.stringify(b), '实际 ' + JSON.stringify(a)); }
function section(t) { console.log('\n' + t); }

const { U, Store, AI, Exporter, Charts, Comp, Views, App, Compare, ApplyBoss } = sandbox;

/* ======================================================================
   四、启动 App（触发 boot → 侧边导航 + 路由 + 首屏渲染）
   ====================================================================== */
section('【0】启动与路由');

// 采集页那两个节点是**渲染时动态建**的，不该出现在 index.html 里，
// 所以静态 id 检查要把它们排除掉。新增动态 id 时记得往这里加。
const DYNAMIC_IDS = new Set(['cLog', 'cTaskBar', 'cResult', 'cEstimate', 'cActions', 'cFunnel']);

// 静态检查：JS 里 $('  #xxx ') 引用的 id，必须在 index.html 里真实存在
(function checkIds() {
  const ids = new Set();
  scriptOrder.map(p => p.replace(/^js\//, '')).forEach(rel => {
    const p = path.join(DIR, 'js', rel);
    if (!fs.existsSync(p)) return;
    const src = fs.readFileSync(p, 'utf8');
    const re = /\$\$?\(\s*'#([\w-]+)'/g;
    let m;
    while ((m = re.exec(src))) ids.add(m[1]);
  });
  const missing = [...ids].filter(id => !document.getElementById(id) && !DYNAMIC_IDS.has(id));
  ok('JS 里引用的 ' + ids.size + ' 个静态 id 都在 index.html 中存在', missing.length === 0,
    '缺：' + missing.join(', '));
})();

document.readyState = 'complete';
let bootErr = null;
try { document._fire('DOMContentLoaded'); } catch (e) { bootErr = e; }
ok('App 能正常启动', !bootErr, bootErr && bootErr.message);
/* ⚠️ 条数**不写死**：加一个页面就得改一次数字，改烦了就会顺手改成新数字，
   那就再也发现不了「某个页面的入口丢了」。改成跟 App.NAV 的分组外条目数对齐 ——
   两边不一致才是要抓的（NAV 里加了页、导航没渲染出来）。 */
ok('侧边导航的入口数跟 App.NAV 对齐',
  U.$$('.nav-i').length === App.NAV.filter(n => !n.grp).length,
  '渲染 ' + U.$$('.nav-i').length + ' / NAV ' + App.NAV.filter(n => !n.grp).length);
ok('导航里有「待跟进」入口', !!U.$('[data-nav="followup"]'));
ok('导航里有「公司背调」入口', !!U.$('[data-nav="company"]'));
ok('首屏默认进岗位库', U.$('#pgTitle').textContent === '岗位库', U.$('#pgTitle').textContent);
ok('localStorage 桩可用', document.querySelectorAll('.nav-i').length > 0);

/* ======================================================================
   五、数据层（Store）
   ====================================================================== */
section('【1】数据层 · 岗位增删改查与去重');

const r1 = Store.addJob({ source: 'boss', title: '短视频运营', company: 'A公司', url: 'https://www.zhipin.com/job_detail/x1.html', rawJD: '职责：做内容' });
ok('新增岗位成功', r1.job && !r1.dup);
const r2 = Store.addJob({ source: 'boss', title: '短视频运营（急招）', company: 'A公司', url: 'https://www.zhipin.com/job_detail/x1.html', salaryText: '12-18K' });
ok('同 URL 再导入 → 识别为重复并合并', r2.dup === true);
eq('合并后总数仍为 1', Store.jobs().length, 1);
eq('合并时补上了薪资', Store.job(r1.job.id).salaryText, '12-18K');

const r3 = Store.addJob({ source: 'manual', title: '内容运营', company: 'B公司', salaryMin: 9, salaryMax: 13 });
ok('新增手动岗位', !r3.dup && Store.jobs().length === 2);

Store.toggleJobFlag(r1.job.id, 'favorite');
ok('收藏开关生效', Store.job(r1.job.id).favorite === true);
Store.addJobTag(r1.job.id, '急招');
Store.addJobTag(r1.job.id, '急招');
eq('标签去重', Store.job(r1.job.id).tags, ['急招']);
Store.removeJobTag(r1.job.id, '急招');
eq('标签可移除', Store.job(r1.job.id).tags, []);

section('【2】数据层 · 投递状态流转与漏斗口径');

const app1 = Store.addApplication({ jobId: r1.job.id, status: 'todo', channel: 'BOSS 直聘' });
ok('新增投递记录', !!app1);
eq('一个岗位只有一条投递记录', Store.addApplication({ jobId: r1.job.id }).id, app1.id);

ok('待投递不算已投递', Store.hasApplied(Store.application(app1.id)) === false);
Store.moveApplication(app1.id, 'applied');
ok('移到已投递后算已投递', Store.hasApplied(Store.application(app1.id)) === true);
ok('投递时间被自动记录', !!Store.application(app1.id).appliedAt);
Store.moveApplication(app1.id, 'round1');
ok('时间线记了 2 次状态变更', Store.application(app1.id).timeline.length === 3, '实际 ' + Store.application(app1.id).timeline.length);

// 回退再前进：漏斗要认「曾经到过的最远位置」
Store.moveApplication(app1.id, 'rejected');
eq('拒绝后仍记得曾到一面', Store.reachedIndex(Store.application(app1.id)), Store.chainIndex('round1'));

const app2 = Store.addApplication({ jobId: r3.job.id, status: 'offer' });
Store.updateApplication(app2.id, { appliedAt: U.now() - 86400000 });
const st = Store.stats();
eq('岗位总数', st.jobTotal, 2);
eq('已投递数（含 offer）', st.appliedTotal, 2);
eq('漏斗第一层 = 后一个岗位', st.funnel[0].n, 2);
ok('offer 数统计正确（含已拒绝但曾拿到 offer 的）', st.offerTotal >= 1, '实际 ' + st.offerTotal);
eq('收藏数', st.jobFavorite, 1);

section('【3】数据层 · 面试联动');

const itv = Store.addInterview({ jobId: r3.job.id, at: U.now() + 7200000, round: '一面（技术/业务）' });
ok('新增面试成功', !!itv);
ok('面试会把投递推进到「邀约面试」', Store.chainIndex(Store.appOfJob(r3.job.id).status) >= Store.chainIndex('invited'),
  Store.appOfJob(r3.job.id).status);
ok('待进行面试数 = 1', Store.stats().interviewUpcoming === 1);
Store.updateInterview(itv.id, { status: 'done', review: '聊得不错' });
ok('标记完成后不再计入待进行', Store.stats().interviewUpcoming === 0);

section('【4】数据层 · 简历与素材');

const cv1 = Store.addResume({ name: '通用版', content: '我会做短视频'.repeat(30) });
ok('第一份简历自动成为默认', cv1.isDefault === true);
const cv2 = Store.addResume({ name: 'AIGC 版', content: 'AIGC 内容生产'.repeat(30), isDefault: true });
ok('第二份设为默认后，第一份被取消默认', Store.resume(cv1.id).isDefault === false && Store.resume(cv2.id).isDefault === true);
eq('默认简历取到的是第二份', Store.defaultResume().id, cv2.id);
Store.removeResume(cv2.id);
ok('删掉默认后自动补一个默认', Store.defaultResume() && Store.defaultResume().id === cv1.id);

Store.addMaterial({ kind: 'cover', title: '打招呼模板', content: '您好…' });
eq('素材计数', Store.materials().length, 1);

section('【5】数据层 · 备份导出与导入');

const backup = Store.exportObject();
ok('备份包含全部实体字段', ['jobs', 'applications', 'interviews', 'resumes', 'materials', 'chats'].every(k => Array.isArray(backup[k])));
ok('备份是深拷贝（不受后续新增数据影响）', backup.jobs.length === 2, '实际 ' + backup.jobs.length);
const jobsBefore = Store.jobs().length;

Store.addJob({ source: 'boss', title: '临时岗位', company: 'C公司' });
const withExtra = Store.jobs().length;
eq('新增一个后总数 +1', withExtra, jobsBefore + 1);
const rep = Store.importObject(backup, 'merge');
eq('合并导入不会删掉本地多出来的岗位', Store.jobs().length, withExtra);
ok('备份里的 2 个岗位被识别为已存在并跳过', rep.skipped >= 2, JSON.stringify(rep));
eq('合并没有把重复岗位再插一遍', rep.jobs, 0);

Store.clearAll(true);
eq('清空后岗位为 0', Store.jobs().length, 0);
ok('清空后保留设置', !!Store.settings().ai);
Store.importObject(backup, 'replace');
eq('覆盖导入恢复岗位数', Store.jobs().length, jobsBefore);
ok('覆盖导入恢复了投递记录', Store.applications().length > 0);

/* ---- 【5.1】多账号数据隔离（本机沙箱切换，非安全认证） ---- */
section('【5.1】多账号数据隔离');

eq('初始账号是 default', Store.currentAccount(), 'default');
ok('账号名校验：合法', Store.validAccountName('小号A') === true);
ok('账号名校验：拒绝空格', Store.validAccountName('a b') === false);
ok('账号名校验：拒绝路径符', Store.validAccountName('a/b') === false);
ok('账号名校验：拒绝空', Store.validAccountName('   ') === false);

const _before = Store.jobs().length;
ok('default 账号有岗位数据', _before > 0);

const _createA = Store.createAccount('测试小号', 'pw123');
ok('创建新账号成功', _createA.ok === true, JSON.stringify(_createA));
ok('重名账号被拒绝', Store.createAccount('测试小号', '') .ok === false);

const _swA = Store.switchAccount('测试小号', 'pw123');
ok('切换到新账号成功（带正确密码）', _swA.ok === true);
ok('切换后当前账号变了', Store.currentAccount() === '测试小号');
eq('新账号从零开始（岗位为空）', Store.jobs().length, 0);
ok('新账号有默认设置', !!Store.settings().ai);

// 新账号里加一条数据
Store.addJob({ source: 'manual', title: '小号专属岗位', company: 'D公司' });
eq('新账号加了一条岗位', Store.jobs().length, 1);

const _swBack = Store.switchAccount('default');
ok('切回 default 成功', _swBack.ok === true);
eq('切回 default 数据完整恢复（不被覆盖）', Store.jobs().length, _before);
ok('default 里没有小号的岗位', Store.jobs().every(j => j.title !== '小号专属岗位'));

const _swPwdErr = Store.switchAccount('测试小号', '错密码');
ok('密码错误拒绝切换', _swPwdErr.ok === false);

const _swNoPwd = Store.switchAccount('测试小号');
ok('不输密码也能被拒（设了密码的账号）', _swNoPwd.ok === false);

// 未注册名字直接「创建并登录」
const _swNew = Store.switchAccount('临时号');
ok('未注册名字直接创建并登录', _swNew.ok === true && Store.currentAccount() === '临时号');

const _del = Store.deleteAccount('临时号');
ok('删除账号成功', _del.ok === true);

// 恢复 default，别让后续测试跑在小号上
Store.switchAccount('default');
eq('回到 default', Store.currentAccount(), 'default');

/* ======================================================================
   六、JSON 容错 & 导入解析
   ====================================================================== */
section('【6】大模型输出容错（extractJSON）');

eq('标准 JSON', U.extractJSON('{"a":1}').a, 1);
eq('```json 围栏', U.extractJSON('好的：\n```json\n{"score":88}\n```').score, 88);
eq('前后带解释文字', U.extractJSON('这是结果：{"score":77} 希望有帮助').score, 77);
eq('尾逗号', U.extractJSON('{"a":[1,2,],}').a.length, 2);
eq('中文引号', U.extractJSON('{“a”: “值”}').a, '值');
eq('嵌套数组', U.extractJSON('{"q":[{"q":"x","a":"y"}]}').q[0].a, 'y');
ok('完全不是 JSON 时返回 null', U.extractJSON('我觉得还行') === null);
ok('空输入返回 null', U.extractJSON('') === null);

eq('asArray 处理换行文本', U.asArray('- 抖音\n- 视频号').length, 2);
eq('asArray 处理布尔对象', U.asArray({ a: true, b: false }), ['a']);
eq('asArray 处理对象数组', U.asArray([{ text: '短' }, { name: '视频' }]), ['短', '视频']);
eq('asNum 从 "10-15K" 提取', U.asNum('10-15K'), 10);

section('【7】爬虫结果导入解析');

eq('薪资 "15-25K·14薪"', Exporter.parseSalary('15-25K·14薪'), { min: 15, max: 25, months: 14 });
eq('薪资 "20-40K"', Exporter.parseSalary('20-40K'), { min: 20, max: 40, months: null });
eq('薪资 "面议"', Exporter.parseSalary('面议'), { min: null, max: null, months: null });

/* --- 整改：薪资单位必须作用到**区间的两个端点**（评审 4.7，我实测复现过） ---
   老写法把数字和单位一起 match，于是 "1-2万" 抠出 ["1","2万"] ——
   单位只加在第二个数上 → min=1, max=20；原始元还会被当 K（差 1000 倍）。
   这两条都会经 job-score 的「起点就 ≥ 期望」档位影响排序。 */
eq('⛔ "1-2万" → 10~20（不是 1~20：单位要作用于两个端点）',
  Exporter.parseSalary('1-2万'), { min: 10, max: 20, months: null });
eq('"1万-2万" → 10~20（两端都写了单位）',
  Exporter.parseSalary('1万-2万'), { min: 10, max: 20, months: null });
eq('"1.5-2万" → 15~20（支持小数）',
  Exporter.parseSalary('1.5-2万'), { min: 15, max: 20, months: null });
eq('⛔ "10000-20000"（原始元，无单位）→ 10~20K，不是当成 10000K',
  Exporter.parseSalary('10000-20000'), { min: 10, max: 20, months: null });
eq('"8000-13000元" → 8~13K（明确标了元）',
  Exporter.parseSalary('8000-13000元'), { min: 8, max: 13, months: null });
eq('"15K" 单值 → 15~15',
  Exporter.parseSalary('15K'), { min: 15, max: 15, months: null });
eq('⛔ "300-500元/天"（日结）→ 明确返回 null，不给一个像月薪的假数字',
  Exporter.parseSalary('300-500元/天'), { min: null, max: null, months: null });
eq('"12-18K" 仍照旧（没改坏常规写法）',
  Exporter.parseSalary('12-18K'), { min: 12, max: 18, months: null });
ok('⛔ 区间端点是单调的：min 永远 ≤ max（1-2万 那种写法以前会反）',
  Exporter.parseSalary('1-2万').min < Exporter.parseSalary('1-2万').max);

const csvTxt = '职位,公司,薪资,城市,技能标签,岗位要求和职责,link\n' +
  '短视频运营,"某公司,杭州",12-18K,杭州,"抖音,剪映","【岗位职责】：\n做内容\n做投放",https://www.zhipin.com/job_detail/c1.html';
const fromCsv = Exporter.parseBossCrawlerFile(csvTxt, 'a.csv');
eq('CSV 解析出 1 条', fromCsv.length, 1);
eq('CSV 字段里的逗号被正确处理', fromCsv[0].company, '某公司,杭州');
eq('CSV 薪资解析', [fromCsv[0].salaryMin, fromCsv[0].salaryMax], [12, 18]);
eq('CSV 技能标签拆分', fromCsv[0].reqSkills, ['抖音', '剪映']);

const jsonTxt = JSON.stringify([
  { position: '内容运营', brand_name: 'D公司', salary: '9-13K', city: '杭州', link: 'https://www.zhipin.com/job_detail/c2.html' },
]);
const fromJson = Exporter.parseBossCrawlerFile(jsonTxt, 'a.json');
eq('JSON 解析（英文别名字段）', fromJson[0].title, '内容运营');
eq('JSON 解析公司别名 brand_name', fromJson[0].company, 'D公司');

const dictTxt = JSON.stringify({ 'https://www.zhipin.com/job_detail/c3.html': { position: '品牌策划', brand_name: 'E公司' } });
const fromDict = Exporter.parseBossCrawlerFile(dictTxt, 'a.json');
eq('{link: {...}} 字典形式也能读', fromDict[0].title, '品牌策划');

/* ======================================================================
   7.1 详情字段回填 —— 这几列采回来过却在导入/写库时被丢掉（体检清单第 8 轮）
   ====================================================================== */
section('【7.1】详情字段回填（代招 / 已失效 / 地址 / 公司简介 / HR）');

const detailCsv =
  '职位,公司,城市,区域,地址,公司信息,已失效,代招,HR活跃度,HR在线,HR职位,HR姓名,规模,link\n' +
  '直播运营,某MCN,杭州,滨江区,杭州滨江区智汇中心A座3楼,深耕新媒体传媒全产业链,否,是,今日活跃,是,人力资源总监,张三,100-499人,https://www.zhipin.com/job_detail/d1.html\n' +
  '短视频运营,某传媒,杭州,西湖区,杭州西湖区文三路1号,一家做内容的公司,是,否,3日内活跃,否,HR,李四,20-99人,https://www.zhipin.com/job_detail/d2.html';
const dRecs = Exporter.parseBossCrawlerFile(detailCsv, 'd.csv');
eq('详情 CSV 解析出 2 条', dRecs.length, 2);
const dRec = dRecs[0];
eq('代招「是」→ proxyHire=true', dRec.proxyHire, true);
eq('已失效「否」→ invalid=false', dRec.invalid, false);
eq('区域回填', dRec.district, '滨江区');
eq('详细地址回填', dRec.address, '杭州滨江区智汇中心A座3楼');
eq('公司简介回填', dRec.companyInfo, '深耕新媒体传媒全产业链');
eq('HR 职位回填', dRec.hrTitle, '人力资源总监');
eq('HR 姓名仍走 hr 字段', dRec.hr, '张三');
eq('HR 在线「是」→ hrOnline=true', dRec.hrOnline, true);
eq('公司规模回填', dRec.scale, '100-499人');
eq('已失效「是」→ invalid=true', dRecs[1].invalid, true);
eq('代招「否」→ proxyHire=false', dRecs[1].proxyHire, false);

/* ⚠️ 光映射不够 —— 上一版就是「映射了但 normJob 写库时又丢了」，这里必须查到库里 */
const stJob = Store.addJob(dRec).job;
eq('入库后 proxyHire 还在', stJob.proxyHire, true);
eq('入库后 address 还在', stJob.address, '杭州滨江区智汇中心A座3楼');
eq('入库后 companyInfo 还在', stJob.companyInfo, '深耕新媒体传媒全产业链');
eq('入库后 hrTitle 还在', stJob.hrTitle, '人力资源总监');
eq('入库后 scale 还在', stJob.scale, '100-499人');
ok('入库后 invalid 为假（「否」不是真值）', stJob.invalid === false);

/* 同名岗位重复采集：布尔标记只能变强，不能被后来那条「否」抹回 false */
const dp = Store.addJob({
  source: 'boss', title: '直播运营', company: '某MCN', proxyHire: true,
  url: 'https://www.zhipin.com/job_detail/dp.html',
}).job;
Store.addJob({
  source: 'boss', title: '直播运营', company: '某MCN', proxyHire: false,
  url: 'https://www.zhipin.com/job_detail/dp.html',
});
eq('重复采集时「代招」标记不会被后一条抹掉', Store.job(dp.id).proxyHire, true);
const dn = Store.addJob({
  source: 'boss', title: '内容运营', company: '某文化', proxyHire: false,
  url: 'https://www.zhipin.com/job_detail/dn.html',
}).job;
Store.addJob({
  source: 'boss', title: '内容运营', company: '某文化', proxyHire: true,
  url: 'https://www.zhipin.com/job_detail/dn.html',
});
eq('后采到的那条带「代招」时会被合并进来', Store.job(dn.id).proxyHire, true);

/* 「排除外包」要能靠 BOSS 权威字段命中，而不是去 JD 正文里猜 */
ok('代招岗位被「排除外包」命中',
  sandbox.JobMatch.dealHit({ proxyHire: true, tags: [], title: '直播运营', company: '某MCN' }, ['外包']) === true);
ok('非代招岗位不被「排除外包」误伤',
  sandbox.JobMatch.dealHit({ proxyHire: false, tags: [], title: '直播运营', company: '某MCN' }, ['外包']) === false);

/* 技能标签语义：AI 不能再把它当「硬性技能」喂模型（会系统性压低匹配分） */
{
  const jt = AI.jobToText({ title: '直播运营', reqSkills: ['接受无经验牛人'] });
  ok('jobToText 把 reqSkills 标成招聘标签', jt.indexOf('招聘标签') >= 0);
  ok('jobToText 不再出现「硬性技能」', jt.indexOf('硬性技能') < 0);
  ok('JD 解析模板叮嘱 reqSkills 不当硬门槛', AI.TPL.jobParse.sys.indexOf('不是硬性技能要求') >= 0);
}

/* ======================================================================
   7.2 采集参数体检 —— 参数与偏好打架时提醒（治「投了白投」的源头）
   ====================================================================== */
section('【7.2】采集参数体检（参数与偏好对不上时提醒）');

const VC = sandbox.Views.collect;
eq('薪资档位表覆盖 6 档', Object.keys(VC._salaryBand).length, 6);
eq('9K 落在「5-10K」档', VC._bandCovering(9), '5-10K');
eq('25K 落在「20-50K」档', VC._bandCovering(25), '20-50K');
eq('60K 落在「50K以上」档', VC._bandCovering(60), '50K以上');

const pi1 = VC._paramIssues(
  { salary: '10-20K', city: '杭州', keywords: '', expectJobs: [] },
  { cities: ['杭州'], salaryMin: 9, expectJobs: [] });
eq('期望 9K 但采集档位 10-20K → 报警 1 条', pi1.length, 1);
/* ⚠️ 一律 (x[0] || {}) —— 万一上面那条红了（数组为空），这里不能再抛异常，
   否则整个测试进程会崩，失败项统计不全（回退自证会显示「变红 0 项」）。 */
eq('报警类型是薪资', (pi1[0] || {}).code, 'salary');
eq('给出的修正档位是「5-10K」', (pi1[0] || {}).fix, '5-10K');

ok('期望薪资落在档位内 → 不报警',
  VC._paramIssues({ salary: '5-10K', city: '杭州' }, { cities: ['杭州'], salaryMin: 9, expectJobs: [] }).length === 0);
ok('薪资选「不限」→ 不报警',
  VC._paramIssues({ salary: '', city: '杭州' }, { cities: ['杭州'], salaryMin: 9, expectJobs: [] }).length === 0);
ok('没填期望薪资 → 不报警',
  VC._paramIssues({ salary: '10-20K', city: '杭州' }, { cities: [], salaryMin: null, expectJobs: [] }).length === 0);

const pi2 = VC._paramIssues(
  { salary: '', city: '上海' }, { cities: ['杭州'], salaryMin: null, expectJobs: [] });
eq('采集城市与目标城市对不上 → 报警', pi2.length, 1);
eq('报警类型是城市', (pi2[0] || {}).code, 'city');
eq('修正值是目标城市', (pi2[0] || {}).fix, '杭州');
ok('城市有交集 → 不报警',
  VC._paramIssues({ salary: '', city: '杭州, 上海' }, { cities: ['杭州'], salaryMin: null, expectJobs: [] }).length === 0);

const pi3 = VC._paramIssues(
  { salary: '', city: '', keywords: '运营', expectJobs: [] },
  { cities: [], salaryMin: null, expectJobs: ['新媒体运营', '直播运营'] });
eq('偏好有期望岗位但这次没带上 → 报警', pi3.length, 1);
eq('报警类型是岗位', (pi3[0] || {}).code, 'jobs');
eq('修正值带全 2 个岗位', ((pi3[0] || {}).fix || []).length, 2);
ok('岗位期望里带上了 → 不报警',
  VC._paramIssues({ salary: '', city: '', keywords: '', expectJobs: ['新媒体运营', '直播运营'] },
    { cities: [], salaryMin: null, expectJobs: ['新媒体运营', '直播运营'] }).length === 0);

/* ======================================================================
   【7.3】本地「合适度」打分引擎（js/job-score.js）
   落地《采集器优化修改思路》§7：硬性过滤 → 5 维加权打分 → 动态加减分 → A/B/C/D
   零 token、可解释、可重放。
   ⚠️ 逐维验，别只验总分 —— 总分对了但某一维算错，照样是 bug（而且更难查）。
   ====================================================================== */
section('【7.3】本地「合适度」打分引擎');

const JS0 = sandbox.JobScorer;
ok('job-score.js 已加载', !!JS0);

/* 打分口径全部来自「设置 → ② 求职偏好」，测试里直接摆一份 */
const setPrefs = o => Object.keys(o).forEach(k => Store.setSetting('prefs.' + k, o[k]));
setPrefs({
  cities: ['杭州'], salaryMin: 9, salaryMax: 10, myYears: 2, myDegree: '大专',
  focusKeywords: ['视频号', '起号', '脚本撰写'], expectJobs: [],
  industries: [], dealBreakers: ['外包'],
});
let JSEQ = 0;
const mkJob = o => Object.assign({
  id: 'fz' + (++JSEQ), title: '', company: '某某公司', industry: '', location: '杭州 · 西湖区',
  salaryText: '', salaryMin: null, salaryMax: null, benefits: [], duties: [], rawJD: '',
  reqDegree: '', reqYears: '', tags: [], active: '', proxyHire: false, invalid: false,
}, o);

/* -------- 口径 -------- */
let fc = JS0.config();
eq('口径：期望薪资上限读到 10', fc.salaryMax, 10);
eq('口径：我的年限读到 2', fc.myYears, 2);
eq('口径：我的学历读到 大专', fc.myDegree, '大专');
eq('口径：关键词 = 设置里填的 3 个', fc.keywords.length, 3);
ok('口径：填了关键词就不走内置兜底', fc.usingDefaultKeywords === false);
ok('口径：来源计数 focus=3', fc.keywordsFrom.focus === 3, JSON.stringify(fc.keywordsFrom));
ok('口径：方向词里没有裸「运营」（含了粒度就全丢）', fc.directions.indexOf('运营') < 0);

setPrefs({ focusKeywords: [], expectJobs: ['短视频运营'] });
let fc1 = JS0.config();
ok('口径：关键词留空 → 内置画像词兜底', fc1.usingDefaultKeywords === true);
eq('口径：内置画像词条数 = DEFAULT_FOCUS', fc1.keywords.length, JS0.DEFAULT_FOCUS.length);
ok('口径：期望岗位自动并进关键词', fc1.keywords.indexOf('短视频运营') >= 0);
ok('口径：期望岗位也并进方向词', fc1.directions.indexOf('短视频运营') >= 0);
ok('口径：去重（期望岗位不会出现两次）', fc1.keywords.filter(k => k === '短视频运营').length === 1);
setPrefs({ focusKeywords: ['视频号', '起号', '脚本撰写'], expectJobs: [] });
const cfgF = JS0.config();

/* -------- 硬性过滤（§7.2）-------- */
ok('过滤：上海岗位 → 剔除', JS0.gate(mkJob({ location: '上海 · 浦东' }), cfgF).drop);
ok('过滤：剔除原因写明了城市', /上海/.test(JS0.gate(mkJob({ location: '上海 · 浦东' }), cfgF).reason));
ok('过滤：地点为空 → **不剔**（信息不全就砍，用户会以为岗位丢了）',
  !JS0.gate(mkJob({ location: '' }), cfgF).drop);
ok('过滤：地点为空 → 但仍给一条提醒',
  JS0.gate(mkJob({ location: '' }), cfgF).warn.some(w => w.code === 'locEmpty'));
ok('过滤：标题「电话销售」→ 剔除', JS0.gate(mkJob({ title: '电话销售' }), cfgF).drop);
ok('过滤：标题「行政专员」→ 剔除', JS0.gate(mkJob({ title: '行政专员' }), cfgF).drop);
ok('过滤：标题「销售运营」不含方向词 → 剔除',
  JS0.gate(mkJob({ title: '销售运营' }), cfgF).drop);
ok('过滤：标题「内容运营」→ 留', !JS0.gate(mkJob({ title: '内容运营' }), cfgF).drop);
ok('过滤：标题「抖音短视频运营」→ 留', !JS0.gate(mkJob({ title: '抖音短视频运营' }), cfgF).drop);
ok('过滤：代招 + 偏好写了外包 → 剔除',
  JS0.gate(mkJob({ title: '内容运营', proxyHire: true }), cfgF).drop);
setPrefs({ dealBreakers: ['大小周'] });
ok('过滤：偏好没写外包 → 代招不剔（只扣分）',
  !JS0.gate(mkJob({ title: '内容运营', proxyHire: true }), JS0.config()).drop);
setPrefs({ dealBreakers: ['外包'] });

ok('过滤：要求本科（我大专）→ 标黄降级',
  JS0.gate(mkJob({ title: '内容运营', reqDegree: '本科' }), cfgF).warn.some(w => w.code === 'degree'));
ok('过滤：要求硕士 → 降级文案更重（差距大）',
  /差距大/.test((JS0.gate(mkJob({ title: '内容运营', reqDegree: '硕士' }), cfgF).warn.filter(w => w.code === 'degree')[0] || {}).text || ''));
ok('过滤：要求大专 = 我的学历 → 不降级',
  JS0.gate(mkJob({ title: '内容运营', reqDegree: '大专' }), cfgF).warn.length === 0);
ok('过滤：学历不限 → 不降级',
  JS0.gate(mkJob({ title: '内容运营', reqDegree: '学历不限' }), cfgF).warn.length === 0);
ok('过滤：薪资上限 6K 远低于期望 9K → 降级',
  JS0.gate(mkJob({ title: '内容运营', salaryMin: 5, salaryMax: 6 }), cfgF).warn.some(w => w.code === 'salaryLow'));
ok('过滤：经验要求 5 年以上（我 2 年）→ 降级',
  JS0.gate(mkJob({ title: '内容运营', reqYears: '5年以上' }), cfgF).warn.some(w => w.code === 'years'));
ok('过滤：已失效 → 降级提醒',
  JS0.gate(mkJob({ title: '内容运营', invalid: true }), cfgF).warn.some(w => w.code === 'invalid'));
eq('过滤：通过了就是空结果（drop=false / 无 warn）',
  JSON.stringify((() => { const g = JS0.gate(mkJob({ title: '内容运营' }), cfgF); return [g.drop, g.warn.length]; })()),
  JSON.stringify([false, 0]));

/* -------- ① 岗位方向 30 -------- */
eq('方向：标题命中「短视频运营」→ 30', JS0.dirScore(mkJob({ title: '短视频运营' }), cfgF), 30);
eq('方向：标题命中「内容运营」→ 30', JS0.dirScore(mkJob({ title: '内容运营' }), cfgF), 30);
eq('方向：只在职责里命中 → 20',
  JS0.dirScore(mkJob({ title: '内容专员', duties: ['负责短视频内容策划'] }), cfgF), 20);
eq('方向：只有泛「运营」→ 14', JS0.dirScore(mkJob({ title: '运营专员' }), cfgF), 14);
eq('方向：只有职责里有「运营」→ 10',
  JS0.dirScore(mkJob({ title: '业务助理', duties: ['协助运营日常'] }), cfgF), 10);
eq('方向：完全不沾 → 0', JS0.dirScore(mkJob({ title: 'Java 开发', duties: ['写后端接口'] }), cfgF), 0);
ok('方向：标题优先级高于职责（不会因为职责里多而反超）',
  JS0.dirScore(mkJob({ title: '新媒体运营', duties: ['无关'] }), cfgF) === 30);

/* -------- ② 关键词命中 30 -------- */
eq('关键词：命中 1 个 → 6', JS0.keyScore(mkJob({ rawJD: '需要会做视频号' }), cfgF).score, 6);
eq('关键词：命中 2 个 → 12', JS0.keyScore(mkJob({ rawJD: '视频号起号经验' }), cfgF).score, 12);
eq('关键词：命中 3 个 → 18', JS0.keyScore(mkJob({ rawJD: '视频号起号 + 脚本撰写' }), cfgF).score, 18);
eq('关键词：命中列表 = 命中的词', JSON.stringify(JS0.keyScore(mkJob({ rawJD: '视频号起号经验' }), cfgF).hits),
  JSON.stringify(['视频号', '起号']));
setPrefs({ focusKeywords: ['视频号', '起号', '脚本撰写', '抖音', '剪辑', '直播', '小红书'] });
eq('关键词：7 个命中封顶 30', JS0.keyScore(mkJob({ rawJD: '视频号 起号 脚本撰写 抖音 剪辑 直播 小红书' }), JS0.config()).score, 30);
setPrefs({ focusKeywords: ['视频号', '起号', '脚本撰写'] });
ok('关键词：一个字都没命中 → 0 分且 hits 为空',
  JS0.keyScore(mkJob({ rawJD: '写 Java 接口' }), cfgF).score === 0 &&
  JS0.keyScore(mkJob({ rawJD: '写 Java 接口' }), cfgF).hits.length === 0);

/* -------- ③ 薪资匹配 20 -------- */
eq('薪资：面议 → 中性 10', JS0.salScore(mkJob({}), cfgF).score, 10);
ok('薪资：面议的说明里写清了「按中性算」', /面议/.test(JS0.salScore(mkJob({}), cfgF).note));
eq('薪资：10-20K，起点就 ≥ 期望 9K → 20', JS0.salScore(mkJob({ salaryMin: 10, salaryMax: 20 }), cfgF).score, 20);
eq('薪资：8-12K 与期望 9K 有重叠 → 14', JS0.salScore(mkJob({ salaryMin: 8, salaryMax: 12 }), cfgF).score, 14);
ok('薪资：给得比期望高**不扣分**（12-20K vs 期望 9K）',
  JS0.salScore(mkJob({ salaryMin: 12, salaryMax: 20 }), cfgF).score === 20);
eq('薪资：6-8K 差一点 → 6', JS0.salScore(mkJob({ salaryMin: 6, salaryMax: 8 }), cfgF).score, 6);
eq('薪资：3-4K 够不着 → 0', JS0.salScore(mkJob({ salaryMin: 3, salaryMax: 4 }), cfgF).score, 0);
eq('薪资：只写了「9K」（单边上限，起点未知）→ 与期望 9K 有重叠 14',
  JS0.salScore(mkJob({ salaryMax: 9 }), cfgF).score, 14);
ok('薪资：只写上上限时 note 明说「只写了上限」',
  /只写了上限/.test(JS0.salScore(mkJob({ salaryMax: 9 }), cfgF).note));
setPrefs({ salaryMin: null });
eq('薪资：没填期望薪资 → 中性 10', JS0.salScore(mkJob({ salaryMin: 3, salaryMax: 4 }), JS0.config()).score, 10);
setPrefs({ salaryMin: 9 });

/* -------- ④ 经验匹配 10 -------- */
eq('经验：1-3 年（我 2 年）→ 10', JS0.expScore(mkJob({ reqYears: '1-3年' }), cfgF).score, 10);
eq('经验：经验不限 → 6', JS0.expScore(mkJob({ reqYears: '经验不限' }), cfgF).score, 6);
eq('经验：1年以上（我 2 年够）→ 10', JS0.expScore(mkJob({ reqYears: '1年以上' }), cfgF).score, 10);
eq('经验：3-5 年（我 2 年略欠）→ 4', JS0.expScore(mkJob({ reqYears: '3-5年' }), cfgF).score, 4);
eq('经验：5 年以上（差距 3 年）→ 0', JS0.expScore(mkJob({ reqYears: '5年以上' }), cfgF).score, 0);
eq('经验：3 年以上（差距 1 年）→ 6', JS0.expScore(mkJob({ reqYears: '3年以上' }), cfgF).score, 6);
eq('经验：没写明 → 中性 5', JS0.expScore(mkJob({ reqYears: '' }), cfgF).score, 5);
eq('经验：1年以下（我超配）→ 8', JS0.expScore(mkJob({ reqYears: '1年以下' }), cfgF).score, 8);

/* -------- ⑤ 福利稳定 10 -------- */
eq('福利：一个都没采到 → 中性 5', JS0.welScore(mkJob({ benefits: [] })).score, 5);
eq('福利：只有双休 → 5', JS0.welScore(mkJob({ benefits: ['双休'] })).score, 5);
eq('福利：双休 + 五险一金 → 8', JS0.welScore(mkJob({ benefits: ['双休', '五险一金'] })).score, 8);
eq('福利：双休 + 五险一金 + 年终奖 → 10',
  JS0.welScore(mkJob({ benefits: ['双休', '五险一金', '年终奖'] })).score, 10);
eq('福利：只有下午茶（不算正经福利）→ 2', JS0.welScore(mkJob({ benefits: ['下午茶'] })).score, 2);

/* -------- 动态加减分（§7.4）-------- */
ok('加减分：HR 今日活跃 → +4', JS0.delta(mkJob({ active: '今日活跃' }), cfgF).value === 4);
ok('加减分：HR 3 日内活跃 → +2', JS0.delta(mkJob({ active: '3日内活跃' }), cfgF).value === 2);
ok('加减分：HR 半年前活跃 → -3', JS0.delta(mkJob({ active: '半年前活跃' }), cfgF).value === -3);
ok('加减分：标注「急招」→ +3', JS0.delta(mkJob({ title: '急招内容运营' }), cfgF).value >= 3);
ok('加减分：行业对口（MCN）→ +3', JS0.delta(mkJob({ industry: 'MCN' }), cfgF).value === 3);
ok('加减分：学历门槛高 1 级 → -3', JS0.delta(mkJob({ reqDegree: '本科' }), cfgF).value === -3);
ok('加减分：学历门槛高 2 级 → -6', JS0.delta(mkJob({ reqDegree: '硕士' }), cfgF).value === -6);
ok('加减分：代招 → -3', JS0.delta(mkJob({ proxyHire: true }), cfgF).value === -3);
ok('加减分：信息残缺（只填了标题）→ -3',
  JS0.delta(mkJob({ title: '内容运营', company: '', location: '', salaryText: '', industry: '', reqYears: '', reqDegree: '' }), cfgF).why.some(w => /信息残缺/.test(w)));
ok('加减分：原因列表和数值对得上（why 非空时 value 不为 0）',
  (() => { const d = JS0.delta(mkJob({ active: '今日活跃' }), cfgF); return d.why.length > 0 && d.value !== 0; })());
ok('加减分：HR 今日活跃 + 急招 + 对口行业可叠加 → +10',
  JS0.delta(mkJob({ active: '今日活跃', title: '急招短视频运营', industry: 'MCN' }), cfgF).value === 10);

/* -------- 分级（§7.5）-------- */
eq('分级：80 → A', JS0.levelOf(80).key, 'A');
eq('分级：79 → B', JS0.levelOf(79).key, 'B');
eq('分级：60 → B', JS0.levelOf(60).key, 'B');
eq('分级：59 → C', JS0.levelOf(59).key, 'C');
eq('分级：40 → C', JS0.levelOf(40).key, 'C');
eq('分级：39 → D', JS0.levelOf(39).key, 'D');
eq('分级：0 → D', JS0.levelOf(0).key, 'D');

/* -------- 端到端：文档 §7.6 那个示例岗位应落在 A 级 ——---- */
const docJob = mkJob({
  title: '短视频运营', company: '某某文化传媒', industry: 'MCN',
  location: '杭州 · 滨江区', salaryText: '8-12K', salaryMin: 8, salaryMax: 12,
  reqDegree: '大专', reqYears: '1-3年',
  benefits: ['五险一金', '双休', '年终奖', '弹性工作'],
  duties: ['负责视频号从 0 到 1 起号', '独立完成脚本撰写与剪辑', '跟踪数据复盘'],
  rawJD: '岗位职责：负责视频号从 0 到 1 起号，脚本撰写、拍摄与剪辑，跟踪数据复盘。任职要求：大专及以上，1-3 年经验。',
  active: '今日活跃',
});
const rDoc = JS0.score(docJob, JS0.config());
eq('文档示例：五维合计 82（30 + 18 + 14 + 10 + 10）', rDoc.base, 82);
eq('文档示例：加减分 +7（今日活跃 +4 / MCN +3）', rDoc.delta.value, 7);
eq('文档示例：总分 89', rDoc.total, 89);
eq('文档示例：落在 A 级', rDoc.level.key, 'A');
eq('文档示例：命中的关键词', JSON.stringify(rDoc.hits), JSON.stringify(['视频号', '起号', '脚本撰写']));
ok('文档示例：一句话依据把「方向 + 关键词 + 薪资」都说清了',
  /运营方向/.test(rDoc.reason) && /关键词命中/.test(rDoc.reason) && /薪资/.test(rDoc.reason),
  rDoc.reason);
ok('文档示例：依据一行含分数/命中/薪资',
  JS0.line(rDoc).indexOf('89 分') === 0 && JS0.line(rDoc).indexOf('视频号') > 0);
ok('端到端：总分被夹在 0-100（不会出现负数或 120）',
  (() => {
    const bad = mkJob({ title: '销售', location: '上海', salaryMin: 1, salaryMax: 2, reqDegree: '博士', reqYears: '10年以上' });
    const t = JS0.score(bad, JS0.config()).total;
    return t >= 0 && t <= 100;
  })());
ok('端到端：JD 和职责都没有的岗位被标成 blind（分数只看了标题）',
  JS0.score(mkJob({ title: '内容运营' }), JS0.config()).blind === true);
ok('端到端：有 JD 的岗位不算 blind',
  JS0.score(mkJob({ title: '内容运营', rawJD: '岗位职责：' + '负责视频号运营，脚本撰写。'.repeat(5) }), JS0.config()).blind === false);
ok('端到端：被硬性剔除的岗位，level 仍然算出来但 gate.drop 为真',
  (() => { const r = JS0.score(mkJob({ title: '行政专员' }), JS0.config()); return r.gate.drop === true; })());
eq('rank()：按合适度降序',
  JSON.stringify(JS0.rank([mkJob({ title: '行政专员' }), docJob, mkJob({ title: '运营专员' })], JS0.config())
    .filter(x => !x.fit.gate.drop).map(x => x.fit.total)).length >= 2, true);
ok('rank()：被剔除的排在（或至少被标记）不参与 A/B/C/D',
  JS0.rank([mkJob({ title: '行政专员' })], JS0.config())[0].fit.gate.drop === true);
eq('summary()：分级计数之和 + 剔除 = 总数',
  (() => {
    const list = [docJob, mkJob({ title: '运营专员' }), mkJob({ title: '行政专员' }), mkJob({ title: 'Java 开发' })];
    const s = JS0.summary(list, JS0.config());
    return s.A + s.B + s.C + s.D + s.drop;
  })(), 4);
ok('reasonOf 不会为空（每条岗位都得说得出「为什么」）',
  [docJob, mkJob({ title: '运营专员' }), mkJob({ title: 'Java 开发' })].every(j => JS0.score(j, JS0.config()).reason.length > 0));

/* -------- UI：岗位库（同步渲染；点击交互在【15】异步段里真点） -------- */
const VJ = Views.jobs;
const seed = [
  ['短视频运营', '杭州 · 滨江区', 8, 12, 'MCN', '今日活跃', '大专', '1-3年', ['五险一金', '双休', '年终奖']],
  ['运营专员', '杭州 · 余杭区', 6, 9, '电商', '3日内活跃', '本科', '3-5年', ['双休']],
  ['行政专员', '杭州 · 上城区', 5, 7, '贸易', '', '大专', '1-3年', []],
];
const seedIds = seed.map(s => Store.addJob({
  title: s[0], company: '测试公司' + s[0], location: s[1], salaryText: s[2] + '-' + s[3] + 'K',
  salaryMin: s[2], salaryMax: s[3], industry: s[4], active: s[5], reqDegree: s[6], reqYears: s[7],
  benefits: s[8], rawJD: '岗位职责：负责视频号从 0 到 1 起号，脚本撰写、剪辑。任职要求：' + s[6] + '，' + s[7] + '。',
}).job.id);
/* ⚠️ addJob 返回的是 { job, dup }，**不是**岗位本身 ——
   写成 Store.addJob(...).id 会静默拿到 undefined，
   后面 Views.jobs.detail(undefined) 只吐一句「岗位不存在」就早退 → .fitpanel 永远是 0 条。 */

/* ⚠️ 库里还留着前面测试节加过的岗位（含 3 条 proxyHire 的），
   而下面这些断言只关心 seed 这 3 条 → 先把范围锁死。
   用公司名前缀走**真实的关键词通道**（keywordHay 含 company），
   并关掉自然语言解析，免得「测试公司」被解析成结构化条件。 */
VJ.filters.kw = '测试公司';
VJ.filters.nlOff = true;

const rJob = inspectPage('jobs');
ok('岗位库：渲染出合适度分级条 .fitbar', !rJob.crashed && U.$$('#view .fitbar').length === 1);
eq('岗位库：分级条上有 4 个 A/B/C/D 胶囊',
  U.$$('#view .fitbar .fchip').filter(c => /^[ABCD] /.test(c.textContent)).length, 4);
ok('岗位库：还有一个「剔除 N」胶囊（因为有行政专员）',
  U.$$('#view .fitbar .fchip').some(c => /剔除/.test(c.textContent)),
  JSON.stringify(U.$$('#view .fitbar .fchip').map(c => c.textContent)));
ok('岗位库：卡片上有合适度徽标 .fbadge', U.$$('#view .fbadge').length >= 2, String(U.$$('#view .fbadge').length));
ok('岗位库：卡片上写了「为什么」的理由 .fitreason', U.$$('#view .fitreason').length >= 2);
ok('岗位库：被剔除的岗位卡片写的是**原因**（不是 0 分）',
  U.$$('#view .fitreason-drop').length === 1 &&
  /行政|不属于|不是运营/.test(U.$$('#view .fitreason-drop')[0].textContent),
  U.$$('#view .fitreason-drop').map(x => x.textContent).join(' / '));
ok('岗位库：被剔除的岗位不给分（徽标写「剔除」而不是「D · 12」）',
  U.$$('#view .fitbox').some(b => {
    const bad = b.querySelector('.fbadge');
    return bad && bad.textContent === '剔除';
  }),
  U.$$('#view .fbadge').map(b => b.textContent).join(' | '));
ok('岗位库：筛选项里有「合适度不限」下拉',
  U.$$('#view select').some(s => /合适度不限/.test(s.textContent || '')));
ok('岗位库：排序下拉里有「合适度由高到低」',
  U.$$('#view select').some(s => /合适度由高到低/.test(s.textContent || '')));

/* 筛选栏默认折叠（「更多筛选」）—— 页面太长，高级筛选收进折叠面板 */
ok('岗位库：默认是「更多筛选」折叠态（有 data-more 面板）', !!U.$('#view [data-more]'));
ok('岗位库：默认折叠时高级面板是隐藏的', U.$('#view [data-more]').classList.contains('hide'));
ok('岗位库：折叠态按钮写「更多筛选」', U.$$('#view [data-more-toggle]').some(b => /更多筛选/.test(b.textContent)));
ok('岗位库：折叠态也保留「重置」按钮', U.$$('#view button').some(b => b.textContent === '重置'));
ok('岗位库：核心筛选（关键词框）在折叠态仍可见', !!U.$('#view input[type="text"]'));
// 点「更多筛选」展开（App.refresh 是同步重建 DOM，点完立即断言）
U.$$('#view [data-more-toggle]')[0].click();
ok('岗位库：点「更多筛选」后高级面板展开', !U.$('#view [data-more]').classList.contains('hide'));
ok('岗位库：展开后按钮变「收起筛选」', U.$$('#view [data-more-toggle]').some(b => /收起筛选/.test(b.textContent)));
// 再点收起
U.$$('#view [data-more-toggle]')[0].click();
ok('岗位库：再点收起后高级面板重新隐藏', U.$('#view [data-more]').classList.contains('hide'));

/* 分级筛选：走的就是 filterJobs 这条真实路径 */
VJ.filters.fit = 'A';
App.refresh();
eq('岗位库：F.fit="A" → 只剩 A 级', U.$$('#view .job').length, 1, String(U.$$('#view .job').length));
ok('岗位库：剩下的那条确实是短视频运营',
  U.$$('#view .job')[0].textContent.indexOf('短视频运营') >= 0);
VJ.filters.fit = 'D';
App.refresh();
eq('岗位库：F.fit="D" → 0 条（这次的样本里没有 D 级）', U.$$('#view .job').length, 0);
VJ.filters.fit = '';
App.refresh();

VJ.filters.hideDrop = true;
App.refresh();
eq('岗位库：hideDrop → 剔掉行政专员，剩 2 条', U.$$('#view .job').length, 2, String(U.$$('#view .job').length));
VJ.filters.hideDrop = false;
App.refresh();

VJ.filters.sort = 'fit';
App.refresh();
const orderTitles = U.$$('#view .job').map(c => (c.textContent.match(/短视频运营|运营专员|行政专员/) || [''])[0]);
ok('岗位库：按合适度排序 → 短视频运营在最前', orderTitles[0] === '短视频运营', JSON.stringify(orderTitles));
ok('岗位库：被剔除的沉底（行政专员在最后）',
  orderTitles[orderTitles.length - 1] === '行政专员', JSON.stringify(orderTitles));
VJ.filters.sort = 'new';
App.refresh();

VJ.filters.view = 'table';
App.refresh();
ok('岗位库：紧凑列表有「合适度」列',
  U.$$('#view th').some(th => th.textContent === '合适度'),
  U.$$('#view th').map(th => th.textContent).join('|'));
ok('岗位库：紧凑列表里也显示分级徽标', U.$$('#view .fbadge').length >= 2, String(U.$$('#view .fbadge').length));
VJ.filters.view = 'card';
App.refresh();

/* 顶部的激活筛选条要认出「合适度」这个条件 */
VJ.filters.fit = 'B';
VJ.filters.hideDrop = true;
App.refresh();
ok('岗位库：激活筛选条列出了「合适度 B 级」',
  /合适度 B 级/.test(U.$('#view').textContent));
ok('岗位库：激活筛选条列出了「已隐藏被剔除的岗位」',
  /已隐藏被剔除的岗位/.test(U.$('#view').textContent));
ok('岗位库：清单个条件能把 hideDrop 也清掉（clearOne 走的是同一份实现）',
  (() => {
    const tag = U.$$('#view .fbar .tag').filter(t => /已隐藏被剔除/.test(t.textContent))[0];
    if (!tag) return false;
    tag.click();
    return VJ.filters.hideDrop === false;
  })());
VJ.filters.fit = ''; VJ.filters.hideDrop = false;
App.refresh();
/* 还给后面的测试节：把「锁到 seed」的范围条件摘掉 */
VJ.filters.kw = ''; VJ.filters.nlOff = false;
App.refresh();

/* 详情弹窗里的合适度拆解面板 */
Views.jobs.detail(seedIds[0], () => { });
ok('详情弹窗里有合适度拆解面板 .fitpanel', U.$$('.fitpanel').length === 1,
  '实际 ' + U.$$('.fitpanel').length);
eq('详情面板里有 5 条维度进度条', U.$$('.fitpanel .fp-dim').length, 5);
ok('详情面板里有分数圆环', U.$$('.fitpanel .fp-score').length === 1);
ok('详情面板里列出了命中的关键词', /命中关键词/.test((U.$$('.fitpanel')[0] || {}).textContent || ''));
ok('详情面板里写出了加分原因（HR 今日活跃 / 行业对口）',
  /今日活跃|行业对口/.test((U.$$('.fitpanel')[0] || {}).textContent || ''));
U.closeAllModals();

/* 被剔除的岗位进详情，给的是「不值得投」而不是一个分数 */
Views.jobs.detail(seedIds[2], () => { });
ok('被剔除的岗位详情里给出「不值得投」+ 原因',
  /不值得投/.test((U.$$('.fitpanel')[0] || {}).textContent || ''),
  (U.$$('.fitpanel')[0] || {}).textContent);
U.closeAllModals();

/* 「怎么算的」说明弹窗 —— 口径不是黑箱 */
JS0.openHelp();
ok('说明弹窗能打开，并写出「五维加权」',
  U.$$('.modal').some(m => /五维加权/.test(m.textContent)));
ok('说明弹窗里列出了当前用的关键词',
  U.$$('.modal').some(m => /当前用的关键词/.test(m.textContent)));
ok('说明弹窗里写清了硬性过滤的三条',
  U.$$('.modal').some(m => /蹭「运营」词/.test(m.textContent)));
U.closeAllModals();

/* -------- UI：岗位库里的「⚙ 我的求职偏好」面板（本轮从设置页搬过来） --------
   搬家的理由见 view-jobs.js 的注释：这份偏好决定的就是本页的两件事
   （「按我的偏好筛选」和「合适度」）。测试跟着功能走，功能搬到哪就测到哪。 */

/* 第 23 轮：设置页那张「② 求职偏好」指路牌**整卡删除**（用户要求）。
   ⛔ 这里守的是那条不变量的**本体**：「设置页不得出现第二份偏好表单」。
     原来守的是"指路牌存在" —— 那只是副产品；指路牌删了，两份表单照样可能被搬回来，
     而反向断言（表单字段不得出现）无论 UI 怎么改都成立。 */
const rSetPointer = inspectPage('settings');
ok('⛔ 设置页：不得出现求职偏好表单字段（关键词框等）—— 两份表单 = 早晚不一致',
  rSetPointer.txt.indexOf('求职方向关键词') < 0, rSetPointer.txt.slice(0, 80));
ok('设置页：那张「② 求职偏好」卡没了（连"已移到岗位库"都不该再有）',
  rSetPointer.txt.indexOf('已移到岗位库') < 0, rSetPointer.txt.slice(0, 120));
ok('设置页：跳转指路牌按钮也一并删掉（入口统一在岗位库筛选栏）',
  !U.$$('#view button').some(b => (b.textContent || '').indexOf('去岗位库调整偏好') >= 0));
/* 删掉的是**重复导航**：岗位库那个入口必须还在、而且真能用（就地展开面板）。
   ⛔ 这里直接调真函数 openPrefs()，不要只手写 `filters.prefsOpen = true` ——
     openPrefs() 还会顺手把「更多筛选」展开（F.moreOpen = true），后面
     「点面板头能收起 / 再点一次能展开」那两条**依赖这个前置**：
     moreOpen 是 false 时，展开那一下走的是整页重建分支（元素被换掉），
     于是断言拿到的是旧节点、恒不 open。本次就是踩了这个坑。 */
VJ.filters.prefsOpen = false;
VJ.filters.moreOpen = false;
VJ.openPrefs();
const rPrefStillThere = inspectPage('jobs');
ok('⛔ 删的是重复导航：岗位库的「⚙ 我的求职偏好」入口仍在，且 openPrefs() 会就地展开面板',
  U.$$('#view .prefsbox').length === 1 &&
  VJ.filters.prefsOpen === true && VJ.filters.moreOpen === true,
  JSON.stringify({ box: U.$$('#view .prefsbox').length,
    open: VJ.filters.prefsOpen, more: VJ.filters.moreOpen }));

Store.setSetting('prefs.focusKeywords', []);
Store.setSetting('prefs.myYears', null);
Store.setSetting('prefs.myDegree', '');
VJ.filters.prefsOpen = true;
const rJobPref = inspectPage('jobs');
ok('岗位库：渲染出「⚙ 我的求职偏好」面板 .prefsbox',
  !rJobPref.crashed && U.$$('#view .prefsbox').length === 1,
  '实际 ' + U.$$('#view .prefsbox').length);
ok('岗位库：prefsOpen=true 时面板是展开态',
  U.$$('#view .prefsbox').length === 1 && /(^|\s)open(\s|$)/.test(U.$$('#view .prefsbox')[0].className || ''),
  (U.$$('#view .prefsbox')[0] || {}).className);
ok('岗位库：面板头写明「改完即时生效」（不再有"改完忘点保存"）',
  /即时生效/.test(U.$('#view').textContent));
ok('岗位库：面板里有「本地合适度打分口径」分组', /本地合适度打分口径/.test(rJobPref.txt));
ok('岗位库：面板里有「怎么算的」入口（分数不是黑箱）',
  U.$$('#view .prefsbox button').some(b => (b.textContent || '').indexOf('怎么算的') >= 0));
ok('岗位库：面板里**没有**「保存偏好」按钮（已经是即时生效）',
  !U.$$('#view button').some(b => (b.textContent || '').indexOf('保存偏好') >= 0));

/* ⚠️ 按 label 文案找控件，**不按位置** —— 本项目踩过这个坑：
   新增一个 select 插到最前面，按 index 取就整体错位，而且错位后断言照样可能是绿的。 */
const fldOf = lab => U.$$('#view .fld').filter(d => (d.textContent || '').indexOf(lab) >= 0)[0];
const ctlIn = (kw, sel) => { const f = fldOf(kw); return f ? f.querySelector(sel) : null; };
const fireInput = elm => elm.dispatchEvent({ type: 'input', target: elm, stopPropagation() {}, preventDefault() {} });
const fireChange = elm => elm.dispatchEvent({ type: 'change', target: elm, stopPropagation() {}, preventDefault() {} });

const taFocus = ctlIn('求职方向关键词', 'textarea');
const inSalaryMax = ctlIn('期望薪资上限', 'input');
const inYears = ctlIn('我的工作年限', 'input');
const selDegree = ctlIn('我的最高学历', 'select');
const inIndustry = ctlIn('对口行业', 'input');
ok('岗位库：五个口径字段都在（关键词 / 上限 / 年限 / 学历 / 行业）',
  !!(taFocus && inSalaryMax && inYears && selDegree && inIndustry),
  U.$$('#view .fld').map(f => (f.textContent || '').slice(0, 10)).join(' | '));
ok('岗位库：关键词框写着「每命中一个 +6 分」',
  /\+6 分/.test((fldOf('求职方向关键词') || {}).textContent || ''));
ok('岗位库：学历下拉里有「大专」（就是画像里的那一档）',
  !!selDegree && selDegree.textContent.indexOf('大专') >= 0);

/* 真改 → **不点任何按钮** → 落盘 + 打分口径立刻跟着走。
   这条是"即时生效"这个设计的核心断言：没有保存按钮，就没有"忘了点"这回事。 */
taFocus.value = '视频号, 起号';
fireInput(taFocus);
ok('岗位库：改关键词不点保存也立刻落盘',
  JSON.stringify(Store.settings().prefs.focusKeywords) === JSON.stringify(['视频号', '起号']),
  JSON.stringify(Store.settings().prefs.focusKeywords));
inYears.value = '3';
fireInput(inYears);
eq('岗位库：工作年限落盘为数字 3', Store.settings().prefs.myYears, 3);
ok('岗位库：打分口径立刻用上新关键词（不用刷新页面）',
  JS0.config().keywords.indexOf('起号') >= 0 && JS0.config().usingDefaultKeywords === false,
  JSON.stringify(JS0.config().keywords));
inSalaryMax.value = '12';
fireInput(inSalaryMax);
ok('岗位库：期望薪资上限落盘为数字 12', Store.settings().prefs.salaryMax === 12,
  typeof Store.settings().prefs.salaryMax + ':' + Store.settings().prefs.salaryMax);
inIndustry.value = 'MCN, 电商';
fireInput(inIndustry);
ok('岗位库：对口行业落盘',
  JSON.stringify(Store.settings().prefs.industries) === JSON.stringify(['MCN', '电商']),
  JSON.stringify(Store.settings().prefs.industries));
selDegree.value = '本科';
fireChange(selDegree);
ok('岗位库：最高学历落盘', Store.settings().prefs.myDegree === '本科', String(Store.settings().prefs.myDegree));
ok('岗位库：打分口径立刻跟上（学历不再走默认的「大专」）', JS0.config().myDegree === '本科');

/* 「用内置画像词」按钮 —— 走的是"清空 → 兜底"这条路，别只测直接改 prefs */
const btnUseDefault = U.$$('#view .prefsbox button')
  .filter(b => (b.textContent || '').indexOf('用内置画像词') >= 0)[0];
ok('岗位库：有「用内置画像词」按钮', !!btnUseDefault);
btnUseDefault.click();
ok('岗位库：点一下会把关键词框清空', ctlIn('求职方向关键词', 'textarea').value === '');
ok('岗位库：并且如实说明「打分时会用内置画像词兜底」',
  U.$$('#toasts .toast').some(t => /内置画像词/.test(t.textContent || '')));
const cfgDef = JS0.config();
ok('岗位库：清空后 → 打分真的回落到内置画像词',
  cfgDef.usingDefaultKeywords === true && cfgDef.keywords.length === JS0.DEFAULT_FOCUS.length,
  JSON.stringify({ using: cfgDef.usingDefaultKeywords, n: cfgDef.keywords.length }));

/* ⚠️ clearToasts() 是后面异步段才定义的（const，有时间死区），本段是同步段，用不了 */
const dropToasts = () => { const b = U.$('#toasts'); if (b) b.innerHTML = ''; };
dropToasts();

/* 折叠 / 展开：只切 class，**不重建筛选卡** —— 重建会打断正在输入的框 */
const prefBox0 = U.$$('#view .prefsbox')[0];
ok('岗位库：点面板头能收起', (function () {
  U.$$('#view .prefshead')[0].click();
  return !/(^|\s)open(\s|$)/.test(prefBox0.className) && VJ.filters.prefsOpen === false;
})(), prefBox0.className);
ok('岗位库：再点一次能展开', (function () {
  U.$$('#view .prefshead')[0].click();
  return /(^|\s)open(\s|$)/.test(prefBox0.className) && VJ.filters.prefsOpen === true;
})(), prefBox0.className);

/* 关键路径：偏好没填时点「按我的偏好筛选」→ **就地展开面板**，不再跳设置页。
   跳页 = 让用户自己跑到另一个页面找刚才想填的字段，是最容易劝退的一种交互。 */
setPrefs({ cities: [], salaryMin: null, dealBreakers: [], expectJobs: [] });
VJ.filters.prefsOpen = false;
VJ.filters.pref = false;
inspectPage('jobs');
U.$$('#view button').filter(b => (b.textContent || '').indexOf('按我的偏好筛选') >= 0)[0].click();
ok('岗位库：偏好没填时点「按偏好筛选」→ 就地展开面板（而不是跳去设置页）',
  VJ.filters.prefsOpen === true && VJ.filters.pref === false,
  JSON.stringify({ open: VJ.filters.prefsOpen, pref: VJ.filters.pref }));
ok('岗位库：展开后确实还停在岗位库（没被跳走）',
  U.$('#pgTitle').textContent === '岗位库', U.$('#pgTitle').textContent);
ok('岗位库：并且明确提示"面板已经展开"',
  U.$$('#toasts .toast').some(t => /面板已经展开/.test(t.textContent || '')));
dropToasts();

/* 不合适度：卡片上每条都要有「为什么」。徽标只说明"几级"，原因行才说明"凭什么是这个级" */
VJ.filters.prefsOpen = false;
inspectPage('jobs');
ok('岗位库：每张卡片的合适度都有原因行 .fitreason',
  U.$$('#view .job').length > 0 &&
  U.$$('#view .job').every(c => ((c.querySelector('.fitreason') || {}).textContent || '').length > 4),
  U.$$('#view .job').length + ' 张卡片 / ' + U.$$('#view .fitreason').length + ' 个原因行 / ' +
  U.$$('#view .job').map(c => ((c.querySelector('.fitreason') || {}).textContent || '（无）').slice(0, 12)).join(' | '));
ok('岗位库：原因行里既有正面也有反面（只吹好的原因行会把 C 级包装成 A 级）',
  U.$$('#view .fitreason').some(x => /⚠/.test(x.textContent || '')),
  U.$$('#view .fitreason').map(x => x.textContent).slice(0, 2).join(' || '));
ok('岗位库：卡片上还摆出了五维得分（不用点进详情才知道为什么）',
  U.$$('#view .fitparts .fpart').length >= 5,
  '实际 ' + U.$$('#view .fitparts .fpart').length);

/* 清场：别把测试塞进去的岗位和偏好留给后面的用例 */
seedIds.forEach(id => Store.removeJob(id));
setPrefs({
  cities: ['杭州'], salaryMin: null, salaryMax: null, myYears: null, myDegree: '',
  focusKeywords: [], expectJobs: [], industries: [], dealBreakers: ['外包', '派遣', '驻场'],
});
ok('清场：测试岗位已移除', !Store.jobs().some(j => seedIds.indexOf(j.id) >= 0));
App.refresh();

section('【8】导出格式');

const csvOut = Exporter.toCSV([{ key: 'a', label: '列一' }, { key: 'b', label: '列二' }], [{ a: '含,逗号', b: '含"引号' }]);
ok('CSV 转义逗号', csvOut.indexOf('"含,逗号"') >= 0);
ok('CSV 转义引号', csvOut.indexOf('"含""引号"') >= 0);
ok('CSV 带表头', csvOut.indexOf('列一') === 0);

const xls = Exporter.toExcelXML([
  { name: '岗位库', headers: [{ key: 'a', label: '岗位名' }, { key: 'b', label: '薪资' }], rows: [{ a: '短视频运营', b: 12 }] },
  { name: '投递记录', headers: [{ key: 'x', label: '状态' }], rows: [{ x: '已投递' }] },
]);
ok('Excel XML 头正确', xls.indexOf('<?mso-application progid="Excel.Sheet"?>') > 0);
eq('Excel 含两个工作表', (xls.match(/<Worksheet ss:Name=/g) || []).length, 2);
ok('Excel 数字写成 Number 类型', xls.indexOf('<Data ss:Type="Number">12</Data>') > 0);
ok('Excel 转义 XML 特殊字符', Exporter.toExcelXML([{ name: 'x', headers: [{ key: 'a', label: 'x' }], rows: [{ a: '<a>&"b' }] }]).indexOf('&lt;a&gt;&amp;&quot;b') > 0);
ok('工作表名过滤非法字符', Exporter.toExcelXML([{ name: 'a/b:c*d', headers: [{ key: 'a', label: 'x' }], rows: [] }]).indexOf('ss:Name="a_b_c_d"') > 0);

section('【9】AI 层');

ok('未配 Key 时 ready() 为 false', AI.ready() === false);
Store.setSetting('ai.apiKey', 'sk-test');
ok('填了 Key 后 ready() 为 true', AI.ready() === true);
eq('endpoint 自动补 /chat/completions', AI.endpoint(), 'https://api.deepseek.com/v1/chat/completions');
Store.setSetting('ai.baseUrl', 'https://api.test.com');
eq('没写 /v1 时自动补', AI.endpoint(), 'https://api.test.com/v1/chat/completions');
Store.setSetting('ai.baseUrl', 'https://api.deepseek.com/v1');

ok('岗位 → 文本上下文包含关键字段', AI.jobToText(Store.job(r1.job.id)).indexOf('岗位名称') >= 0);
ok('resumeToText 超长会截断', AI.resumeToText(Store.resume(cv1.id), 50).length <= 51);

const jobTpl = AI.TPL.jobParse.user({ text: 'ABC', url: 'http://x' });
ok('JD 模板把原文塞进去了', jobTpl.indexOf('ABC') > 0 && jobTpl.indexOf('http://x') > 0);
/* 断言必有的模板名，而不是断言"一共 N 个" ——
   数个数会因为加模板就红一片，而那条红并不代表坏了。 */
{
  const need = ['jobParse', 'match', 'greeting', 'interviewPrep', 'review', 'rejection', 'compare',
    'followup', 'interviewer', 'simReview', 'free'];
  const miss = need.filter(k => !AI.TPL[k]);
  ok('11 套提示词模板齐全', miss.length === 0,
    miss.length ? '缺 ' + miss.join(',') : Object.keys(AI.TPL).join(','));
  const badSys = need.filter(k => !AI.TPL[k].sys || !AI.TPL[k].user);
  ok('每个模板都有 sys 和 user', badSys.length === 0, badSys.join(','));
}
/* 提示词里的硬约束是功能的一部分（模型不照做，功能就废了），所以锁住 */
ok('模拟面试官模板要求「一次只问一题」', AI.TPL.interviewer.sys.indexOf('一次只问') >= 0);
ok('模拟面试官模板要求「不中途点评」', AI.TPL.interviewer.sys.indexOf('不要评价') >= 0);
ok('复盘模板要求只输出 JSON', AI.TPL.simReview.sys.indexOf('只输出一个 JSON') >= 0);
ok('复盘模板要求逐题点评', AI.TPL.simReview.sys.indexOf('perQuestion') >= 0);
ok('跟进话术模板禁止姿态过低的措辞', AI.TPL.followup.sys.indexOf('跪求') >= 0);

/* ======================================================================
   七、全页面渲染（最关键的一步）
   ====================================================================== */
section('【10】十个页面逐个真渲染');

// 先塞点数据，让每个页面都有东西可渲染（空态和有数据态都测）
Store.loadDemo();

// 页面 → 必须出现的关键词（渲染出来没这些字，说明这页是空的或者炸了）
const viewExpect = {
  // 「在库岗位」是原来的「岗位总数」——改名的原因：这个数其实是未归档岗位数，
  // 归档后显示 0 会让人以为岗位丢了（见功能体检报告 二.3 / 三.2）
  jobs: ['在库岗位', '全部来源', '导入 BOSS 岗位'],
  // 采集页首屏是**异步**的（要先探本地服务），同步这一轮只能看到加载态；
  // 真正的在线/离线两种样子在【14】里异步测。
  collect: ['正在检测本地采集器', '采集岗位'],
  kanban: ['待收藏', '待投递', '已投递', '拿到 offer'],
  interview: ['最近的面试', '新建面试'],
  // 待跟进：四张摘要卡是**恒定渲染**的（哪怕一条待办都没有），所以拿它当关键字最稳。
  // 之前这一页漏在名单外面 —— 加进来看门，别再漏。
  followup: ['待跟进', '面试相关', '投递后没动静', '该投还没投'],
  // 公司背调：四张统计卡 + 清单卡 + 配置卡都是恒定渲染的，拿它们当门牌最稳。
  // ⚠️ 这一页必须留在名单里 —— 新增页面漏掉就只剩专项断言，没有通用兜底（待跟进页漏过一次）。
  company: ['要背调的公司', '红灯', '黄灯', '背调配置', '不构成法律意见'],
  resume: ['简历版本', '新增简历版本'],
  assistant: ['快捷任务', '对话记录'],
  compare: ['对比篮里还不到'],
  dashboard: ['求职漏斗', '投递状态分布', '岗位行业分布'],
  settings: ['大模型接口', '数据与备份', '自定义提示词'],
};
// 空态 / 加载态页面本来就短，单独放宽长度门槛
const viewMinLen = { compare: 250, collect: 200 };

/**
 * 渲染一个页面，并给出「到底炸没炸」的判定素材。
 *
 * ⚠️ 不能只看「有没有抛异常」——`App.go()` 内部会把异常 catch 掉，
 * 换成一张「这个页面渲染出错了」的兜底卡片（`app.js:104-116`）。
 * 所以 `try { App.go(id) } catch` 永远拿不到 err，断言会假绿。
 * **必须检查 DOM 里究竟渲染出了什么。**
 */
function inspectPage(id) {
  const view = U.$('#view');
  view.innerHTML = '';
  let err = null;
  try { App.go(id); } catch (e) { err = e; }
  const html = serialize(view);
  const txt = view.textContent;
  const idx = txt.indexOf('这个页面渲染出错了');
  return {
    err: err,
    html: html,
    txt: txt,
    crashed: idx >= 0,
    crashMsg: idx >= 0 ? txt.slice(idx + 9, idx + 130).trim() : '',
  };
}

['jobs', 'collect', 'kanban', 'interview', 'followup', 'company', 'resume', 'assistant', 'compare', 'dashboard', 'settings'].forEach(id => {
  const r = inspectPage(id);
  const title = Views[id].title;
  const minLen = viewMinLen[id] || 400;
  ok('页面「' + title + '」没被错误兜底卡顶掉', !r.crashed && !r.err,
    r.err ? (r.err.message + ' @ ' + String(r.err.stack).split('\n')[1])
          : ('内部抛异常被吞：' + r.crashMsg));
  ok('页面「' + title + '」有实际内容', r.html.length > minLen, '实际长度 ' + r.html.length + '（门槛 ' + minLen + '）');
  // 注意：页面标题栏按钮由 App.topActions() 渲染到 #topActions，
  // 不在 #view 里。所以断言要连顶栏一起看，否则会误判「缺文案」。
  const top = U.$('#topActions');
  const txt = r.txt + '\n' + (top ? top.textContent : '');
  const miss = (viewExpect[id] || []).filter(k => txt.indexOf(k) < 0);
  ok('页面「' + title + '」关键内容齐全', miss.length === 0, '缺：' + miss.join(' / '));
});

section('【11】关键交互路径');

// 岗位详情弹窗
let detErr = null;
try { Views.jobs.detail(Store.jobs()[0].id); } catch (e) { detErr = e; }
ok('打开岗位详情弹窗不抛异常', !detErr, detErr && detErr.message);
ok('详情弹窗出现在 DOM 里', U.$$('.mask').length === 1, '弹窗数 ' + U.$$('.mask').length);
ok('详情里显示「投递记录」', U.$('.mask .modal').textContent.indexOf('投递记录') >= 0);
U.closeAllModals();
ok('关闭弹窗后 DOM 清干净', U.$$('.mask').length === 0);

// 投递看板详情
let kbErr = null;
try { Views.kanban.openDetail(Store.applications()[0].id); } catch (e) { kbErr = e; }
ok('打开投递详情不抛异常', !kbErr, kbErr && kbErr.message);
ok('投递详情里有进展轨迹', U.$('.mask .modal').textContent.indexOf('进展轨迹') >= 0);
U.closeAllModals();

// 面试表单
let ivErr = null;
try { Views.interview.openForm(null, { jobId: Store.jobs()[0].id }); } catch (e) { ivErr = e; }
ok('打开新建面试表单不抛异常', !ivErr, ivErr && ivErr.message);
U.closeAllModals();

// 投递表单
let afErr = null;
try { Views.kanban.openForm(null, { jobId: Store.jobs()[1].id }); } catch (e) { afErr = e; }
ok('打开新增投递表单不抛异常', !afErr, afErr && afErr.message);
U.closeAllModals();

// 简历表单
let rfErr = null;
try { Views.resume.openResumeForm(null); } catch (e) { rfErr = e; }
ok('打开简历表单不抛异常', !rfErr, rfErr && rfErr.message);
U.closeAllModals();

// 素材表单
let mfErr = null;
try { Views.resume.openMaterialForm(null); } catch (e) { mfErr = e; }
ok('打开素材表单不抛异常', !mfErr, mfErr && mfErr.message);
U.closeAllModals();

// 导入 BOSS 岗位弹窗
let imErr = null;
try { Views.jobs.importDialog(); } catch (e) { imErr = e; }
ok('打开「导入 BOSS 岗位」不抛异常', !imErr, imErr && imErr.message);
ok('导入弹窗里写了边界说明', U.$('.mask .modal').textContent.indexOf('不自动发消息') >= 0,
  '实际：' + U.$('.mask .modal').textContent.slice(0, 120));
U.closeAllModals();

// 状态切换对话框
let csErr = null;
try { Views.jobs.changeStatus(Store.applications()[0].id); } catch (e) { csErr = e; }
ok('打开状态切换对话框不抛异常', !csErr, csErr && csErr.message);
ok('状态选项有 11 个', U.$$('.mask .box').length === 11, '实际 ' + U.$$('.mask .box').length);
U.closeAllModals();

// AI 面板：未配置 key 时应走友好报错，而不是崩
Store.setSetting('ai.apiKey', '');
let aiErr = null;
try {
  Comp.runAI({ title: '测试', tpl: 'jobParse', input: { text: 'x' }, autoRun: true });
} catch (e) { aiErr = e; }
ok('打开 AI 面板不抛异常', !aiErr, aiErr && aiErr.message);
U.closeAllModals();
Store.setSetting('ai.apiKey', 'sk-test');

section('【12】岗位对比');

Compare.add(Store.jobs()[0].id);
Compare.add(Store.jobs()[1].id);
eq('对比篮收集到 2 个', Compare.basket().length, 2);
let cpErr = null;
try { App.go('compare'); } catch (e) { cpErr = e; }
ok('对比页渲染不抛异常', !cpErr, cpErr && cpErr.message);
ok('对比表维度 >= 9 项', Views.compare.dims().length >= 9, '实际 ' + Views.compare.dims().length);
ok('对比页显示了横向对比表', U.$('#view').textContent.indexOf('横向对比表') >= 0);

/* --- 本轮新增：公司规模 / 公司福利 / 假期 / 五险一金 / 作息 --- */
const cDims = Views.compare.dims();
const cDim = k => cDims.filter(d => d.k === k)[0];
['scale', 'welfare', 'holiday', 'insurance', 'hours'].forEach(k => {
  ok('对比维度里有「' + k + '」', !!cDim(k));
});
ok('对比页把「公司规模」「假期 / 休息」「五险一金」都列出来了',
  ['公司规模', '假期 / 休息', '五险一金', '公司福利', '作息 / 加班']
    .every(lab => U.$('#view').textContent.indexOf(lab) >= 0),
  U.$$('#view tbody td').filter(td => td.textContent).slice(0, 8).map(td => td.textContent).join(' | '));

/* ⚠️ 这一组是本轮最该守的东西：对比表和「合适度」用的是**同一份福利口径**。
   两处各写一套正则的话，同一个岗位在打分页和对比页会给出不一样的说法。 */
const cJob = mkJob({
  title: '短视频运营', company: '测试公司', location: '杭州', salaryMin: 9, salaryMax: 12,
  scale: '1000-9999人', companyInfo: '一家做内容矩阵的公司',
  benefits: ['双休 五险一金 年终奖 法定节假日三薪 带薪年假 弹性工作 下午茶'],
  rawJD: '岗位职责：' + '负责视频号起号、脚本撰写。'.repeat(4),
});
const sW = JS0.welfareOf(cJob);
eq('福利拆解：扒出「双休」', sW.rest.key, '双休');
eq('福利拆解：双休 rank=3（只有 rank 3 才算福利）', sW.rest.rank, 3);
eq('福利拆解：识别到五险一金', sW.insurance.key, '五险一金');
ok('福利拆解：识别到法定节假日', sW.legal === true);
ok('福利拆解：识别到带薪年假', sW.annual === true);
ok('福利拆解：识别到弹性工作', sW.flexible === true);
ok('福利拆解：软福利（下午茶）单独归一类，不混进加分档',
  sW.softs.length >= 1 && sW.items.indexOf('下午茶') >= 0, JSON.stringify(sW.softs));
eq('福利拆解：四项都命中 → 满档 level=4', sW.level, 4);
eq('福利拆解：顺手把挤在一起的长串拆成逐项（BOSS 列表页就是这个形态）',
  JS0.welfareItems({ benefits: ['交通补助 有无线网 工龄奖 年终奖 五险一金'] }).length, 5);

eq('对比表·假期：双休 → 排到「双休 · 法定节假日 · 带薪年假」',
  cDim('holiday').get(cJob).text, '双休 · 法定节假日 · 带薪年假');
eq('对比表·假期：分数 = 双休 rank 3', cDim('holiday').get(cJob).score, 3);
ok('对比表·假期：给了「双休，作息最稳」这种人话解释',
  /双休/.test(cDim('holiday').get(cJob).sub));
eq('对比表·五险一金：给 3 分（满档）', cDim('insurance').get(cJob).score, 3);
eq('对比表·公司规模：原样显示采集值', cDim('scale').get(cJob).text, '1000-9999人');
ok('对比表·公司规模：副标题翻译成「千人级中大型」',
  cDim('scale').get(cJob).sub === '千人级中大型', cDim('scale').get(cJob).sub);
ok('对比表·公司规模**不参与**评优（规模大 ≠ 更适合你）',
  cDim('scale').get(cJob).score === undefined, String(cDim('scale').get(cJob).score));
/* ⚠️ 用**精确值**比，不用「文本里含某个词」——
   早先写成 /五险一金/.test(text)，结果"把整串福利原样糊上去"这种改坏也能通过
   （整串里当然含「五险一金」）。这类断言看着严、其实等于没断言。 */
eq('对比表·公司福利：逐项列出来（不是把整串糊上去）',
  cDim('welfare').get(cJob).text,
  '双休、五险一金、年终奖、法定节假日三薪、带薪年假、弹性工作、下午茶');
eq('对比表·作息：写了弹性工作',
  cDim('hours').get(cJob).text.indexOf('弹性工作') >= 0, true);

/* 边界：福利**完全没采到**的岗位不能崩，也不能假装有福利 */
const bareJob = mkJob({ title: '内容运营', benefits: [] });
eq('对比表·福利没采到 → 明说「没采到福利标签」', cDim('welfare').get(bareJob).text, '没采到福利标签');
eq('对比表·福利没采到 → 给 -1（好让「有数据」那条能被标优）',
  cDim('welfare').get(bareJob).score, -1);
eq('对比表·假期没采到 → 给 -1', cDim('holiday').get(bareJob).score, -1);

/* 单个休名单要能认出「大小周」，而且不该被当成福利加分 */
const dxz = JS0.welfareOf(mkJob({ benefits: ['大小周 五险一金'] }));
eq('福利拆解：认出「大小周」', dxz.rest.key, '大小周');
eq('福利拆解：「大小周」rank 只有 2（是妥协不是福利）', dxz.rest.rank, 2);
ok('福利拆解：只有大小周 + 五险一金 → 只算 1 档（五险一金），大小周不加分',
  dxz.level === 1, String(dxz.level));
ok('对比表·假期：把大小周翻译成「是妥协」而不是加分',
  /隔周单休/.test(cDim('holiday').get(mkJob({ benefits: ['大小周'] })).sub));

section('【13】看板拖拽的状态迁移函数');

const apps = Store.applications();
if (apps.length) {
  const before = apps[0].status;
  Store.moveApplication(apps[0].id, 'viewed');
  eq('拖到「HR 已查看」', Store.application(apps[0].id).status, 'viewed');
  Store.moveApplication(apps[0].id, before);
  eq('再移回去', Store.application(apps[0].id).status, before);
  const tlLen = Store.application(apps[0].id).timeline.length;
  Store.moveApplication(apps[0].id, before);
  eq('原地移动不重复写时间线', Store.application(apps[0].id).timeline.length, tlLen);
}

section('【14】采集模块（本地采集器通道）');

// --- 14.1 纯逻辑：原始记录 → 岗位对象（与文件导入共用同一套映射）---
// 这条最要紧：采集接口回吐的是 boss-crawler 的中文列名，
// 一旦别名表改动而这里没跟上，采集回来的岗位就会变成一堆空壳。
(function testFromCrawlerRecord() {
  const rec = {
    '职位': '短视频运营', '公司': '某文化传媒', '薪资': '12-18K·13薪',
    '城市': '杭州', '领域': '文化传媒', '学历': '大专', '经验': '1-3年',
    '技能标签': '抖音,剪映,爆款内容', '福利标签': '五险一金,双休',
    '岗位要求和职责': '【岗位职责】\n1. 负责账号日常运营\n2. 策划选题',
    'link': 'https://www.zhipin.com/job_detail/abc.html',
    '规模': '100-499人', 'HR姓名': '张女士', 'HR活跃度': '本周活跃',
  };
  const j = Exporter.fromCrawlerRecord(rec);
  ok('采集记录能转成岗位对象', !!j);
  eq('岗位名映射', j.title, '短视频运营');
  eq('公司映射', j.company, '某文化传媒');
  eq('薪资文本映射', j.salaryText, '12-18K·13薪');
  eq('薪资下限解析（K）', j.salaryMin, 12);
  eq('薪资上限解析（K）', j.salaryMax, 18);
  eq('年终薪月数解析', j.salaryMonths, 13);
  eq('城市映射', j.location, '杭州');
  eq('领域映射', j.industry, '文化传媒');
  eq('技能标签按逗号拆开', j.reqSkills, ['抖音', '剪映', '爆款内容']);
  eq('福利标签按逗号拆开', j.benefits, ['五险一金', '双休']);
  eq('HR活跃度映射', j.active, '本周活跃');
  eq('link 映射到 url', j.url, 'https://www.zhipin.com/job_detail/abc.html');
  eq('来源标记为 boss', j.source, 'boss');
  ok('职责从 JD 里粗提出来了', Array.isArray(j.duties) && j.duties.length >= 2,
    'duties=' + JSON.stringify(j.duties));
  eq('空记录返回 null', Exporter.fromCrawlerRecord(null), null);
  eq('没有岗位名也没有公司 → 丢弃', Exporter.fromCrawlerRecord({ '薪资': '10K' }), null);

  /* P1-5 权威岗位要求兜底：BOSS 列表页没写学历/经验时，用 JD 抽出的要求补上。
     job-score 的硬性过滤读的正是 reqDegree/reqYears —— 补上它，门槛判断才生效。 */
  const jr = Exporter.fromCrawlerRecord({
    '岗位': '直播运营', '公司': '某公司', 'link': 'https://x/1.html',
    _reqAuthoritative: { '学历要求': '本科', '经验要求': '3-5年', '技能要求': ['中控', '复盘'] },
  });
  eq('列表页没写学历 → 用 JD 抽出的补上', jr.reqDegree, '本科');
  eq('列表页没写经验 → 用 JD 抽出的补上', jr.reqYears, '3-5年');
  eq('权威技能要求单独留一列（不混进 reqSkills）',
    (jr.reqSkillsAuthoritative || []).join('/'), '中控/复盘');

  /* ⛔ 列表页写了就以列表页为准（那是 BOSS 官方口径），不能被覆盖 */
  const jr2 = Exporter.fromCrawlerRecord({
    '岗位': '直播运营', '公司': '某公司', 'link': 'https://x/2.html',
    '学历': '大专', '经验': '1-3年',
    _reqAuthoritative: { '学历要求': '本科', '经验要求': '3-5年' },
  });
  eq('⛔ 列表页有学历时不覆盖', jr2.reqDegree, '大专');
  eq('⛔ 列表页有经验时不覆盖', jr2.reqYears, '1-3年');

  /* 没有权威要求时不该凭空造字段 */
  const jr3 = Exporter.fromCrawlerRecord({ '岗位': '运营', '公司': 'X公司', 'link': 'https://x/3.html' });
  eq('没有权威要求 → 经验仍是空', jr3.reqYears, '');
  ok('没有权威要求 → 不凭空冒出 reqSkillsAuthoritative',
    jr3.reqSkillsAuthoritative === undefined);
})();

// --- 14.2 离线态：探测不到服务时要给出「怎么启动」的引导，而不是白屏 ---
// fetch 桩默认就是 reject（模拟服务没起），所以这里直接用默认桩即可。
/* 采集器接口的假响应 —— 14.3 与 14.5 共用。
   ⚠️ 必须放文件级：早先写在 `.then()` 块里，14.5 在下一个块就访问不到
   （报 `fakePing is not defined`，害我绕了一大圈才定位）。 */
const fakePing = {
  ok: true, version: '1.0.0', skillReady: true, llmReady: true,
  runDir: 'C:\\fake\\assets\\2026-09-25_16-42-15',
  hasProfile: true,
  profile: { name: '测试同学', degree: '大专', years: '2', city: '杭州',
    position: '运营', keywordCount: 19, keywords: ['运营'] },
  params: { city: '杭州', keywords: ['新媒体运营', '短视频运营'], salary: '10-20K',
    count: 30, crawlMode: 'custom', source: 'preferences.json' },
  login: { value: 'ok', checkedAt: 1 }, busy: false,
  chromePath: 'C:\\Edge\\msedge.exe',
};
const fakeJobs = {
  ok: true, source: 'scored_jobs.json（已初步评分）', total: 1,
  jobs: [{ '职位': '短视频运营', '公司': '采集来的公司', '薪资': '12-18K',
    '城市': '杭州', 'link': 'https://www.zhipin.com/job_detail/collected1.html' }],
};

function withFetch(fn, run) {
  const original = sandbox.fetch;
  sandbox.fetch = fn;
  return run().then(r => { sandbox.fetch = original; return r; },
    e => { sandbox.fetch = original; throw e; });
}
const tick = () => new Promise(r => setTimeout(r, 0));

withFetch(
  () => Promise.reject(new Error('connect ECONNREFUSED')),
  () => {
    App.go('collect');
    ok('采集页首屏先显示加载态', U.$('#view').textContent.indexOf('正在检测本地采集器') >= 0);
    return tick().then(tick).then(tick).then(() => {
      const txt = U.$('#view').textContent;
      ok('连不上采集器时渲染引导卡', txt.indexOf('先启动本地采集器') >= 0, '实际：' + txt.slice(0, 80));
      ok('引导卡里写了启动方式', txt.indexOf('启动采集器') >= 0);
      ok('离线时也说明了「不用它也完全可以用」', txt.indexOf('改成手动导入') >= 0);
      ok('离线时仍然展示边界说明', txt.indexOf('不自动发消息') >= 0);
      ok('离线态不该崩成报错页', txt.indexOf('这个页面渲染出错了') < 0);
    });
  }
).then(() => {
  // --- 14.3 在线态：喂一个假服务，看四张卡能不能正常长出来 ---
  // （fakePing / fakeJobs 已提到文件级，14.5 也要用）
  const stub = (url) => {
    const path = String(url).replace(/^https?:\/\/[^/]+/, '');
    let body = { ok: false, error: 'no stub: ' + path };
    if (path.indexOf('/api/ping') === 0) body = fakePing;
    else if (path.indexOf('/api/task') === 0) {
      body = { ok: true, task: { key: 'crawl', title: '采集岗位', running: false, exit_code: 0,
        started_at: 1, ended_at: 2, total: 2, lines: ['$ python pipeline.py', '✅ 采集完成'] } };
    } else if (path.indexOf('/api/jobs') === 0) body = fakeJobs;
    else if (path.indexOf('/api/results/clear') === 0) {
      body = { ok: true, n: 1, dest: 'C:\\fake\\assets\\results-archive\\2026-09-30_20-00-00' };
    }
    return Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify(body)),
    });
  };

  return withFetch(stub, () => {
    App.go('collect');
    // detect → ping → 渲染主卡 → 恢复现场(/api/task) → loadResult(/api/jobs)
    // 链子有五六层，多滴几个 tick 让它跑完。
    return tick().then(tick).then(tick).then(tick).then(tick).then(tick);
  });
}).then(async () => {
  const txt = U.$('#view').textContent;
  ok('在线时显示「采集器状态」卡', txt.indexOf('采集器状态') >= 0);
  ok('在线时显示「未连接」以外的连接状态', txt.indexOf('已连接') >= 0);
  ok('显示采集链路是否就绪', txt.indexOf('采集链路') >= 0);
  ok('显示登录状态', txt.indexOf('已登录') >= 0);
  ok('显示已识别的简历画像', txt.indexOf('测试同学') >= 0 && txt.indexOf('已识别简历画像') >= 0);
  ok('显示「采集参数」卡', txt.indexOf('采集参数') >= 0);
  ok('参数默认值回填了城市', txt.indexOf('杭州') >= 0);
  ok('显示「登录与采集」卡', txt.indexOf('登录与采集') >= 0);
  ok('显示「采集结果」卡', txt.indexOf('采集结果') >= 0);
  ok('结果卡里能看到采集回来的岗位数', txt.indexOf('1 个岗位') >= 0, '实际片段：' + txt.slice(0, 100));

  // BOSS 同款筛选面板（2026-09-30 扩展）：多级筛选维度都要有入口
  ok('采集参数卡有「筛选条件」折叠区', txt.indexOf('筛选条件') >= 0);
  ok('有学历筛选维度', txt.indexOf('学历') >= 0 && txt.indexOf('本科') >= 0);
  ok('有经验筛选维度', txt.indexOf('经验') >= 0 && txt.indexOf('3-5年') >= 0);
  ok('有公司规模筛选维度', txt.indexOf('公司规模') >= 0 && txt.indexOf('100-499人') >= 0);
  ok('有融资阶段筛选维度', txt.indexOf('融资阶段') >= 0 && txt.indexOf('A轮') >= 0);
  ok('有工作类型筛选维度', txt.indexOf('工作类型') >= 0 && txt.indexOf('全职') >= 0);
  ok('有福利待遇筛选维度（本地筛）', txt.indexOf('福利待遇') >= 0 && txt.indexOf('周末双休') >= 0);

  /* P0：采集方式切换（🔎 按关键词搜索=custom / 🎯 按岗位直采=list）。
     ⛔ 要判「按钮真的渲染 + 默认态高亮对」—— 不能只查文字出现，否则删掉按钮
        只剩提示文案也能绿。 */
  const modeBtns = U.$$('#view button').filter(b => {
    const t = b.textContent || '';
    return t.indexOf('按关键词搜索') >= 0 || t.indexOf('按岗位直采') >= 0;
  });
  ok('采集方式两个选项都渲染成按钮', modeBtns.length === 2, '按钮数=' + modeBtns.length);
  const customBtn = modeBtns.filter(b => (b.textContent || '').indexOf('按关键词搜索') >= 0)[0];
  const listBtn = modeBtns.filter(b => (b.textContent || '').indexOf('按岗位直采') >= 0)[0];
  ok('默认「按关键词搜索」高亮、list 未高亮（默认 custom）',
    !!customBtn && /(^| )pri( |$)/.test(customBtn.className || '') &&
    !!listBtn && !/(^| )pri( |$)/.test(listBtn.className || ''),
    'custom=' + (customBtn && customBtn.className) + ' list=' + (listBtn && listBtn.className));
  // 点「按岗位直采」→ 就地重画：高亮切到 list，且表单 crawlMode 落成 list
  if (listBtn) listBtn.click();
  const modeBtns2 = U.$$('#view button').filter(b => {
    const t = b.textContent || '';
    return t.indexOf('按关键词搜索') >= 0 || t.indexOf('按岗位直采') >= 0;
  });
  const listBtn2 = modeBtns2.filter(b => (b.textContent || '').indexOf('按岗位直采') >= 0)[0];
  ok('点「按岗位直采」后高亮切到 list',
    !!listBtn2 && /(^| )pri( |$)/.test(listBtn2.className || ''),
    'list=' + (listBtn2 && listBtn2.className));
  ok('切换后表单 crawlMode = list', Views.collect._state.form.crawlMode === 'list',
    'crawlMode=' + Views.collect._state.form.crawlMode);
  ok('有BOSS活跃度筛选维度（本地筛）', txt.indexOf('活跃度') >= 0 && txt.indexOf('今日活跃') >= 0);
  /* 第 21 轮：福利/活跃度/区/商圈这些「本地筛」项不再靠标题后缀说明，
     改成统一的生效层级徽章（Comp.lvlBadge）。所以这里断言的是
     **三种层级的图例真的渲染出来了** —— 比原来那句「出现过某串」强：
     原来只要页面上任何地方出现「采集后自动筛」就绿，现在必须三层都齐。 */
  ok('筛选区给了三种生效层级的图例（透传 BOSS / 采集后本地筛 / 只影响岗位库）',
    txt.indexOf('透传 BOSS') >= 0 && txt.indexOf('采集后本地筛') >= 0 &&
    txt.indexOf('只影响岗位库') >= 0,
    '透传BOSS=' + (txt.indexOf('透传 BOSS') >= 0) + ' 本地筛=' + (txt.indexOf('采集后本地筛') >= 0) +
    ' 岗位库=' + (txt.indexOf('只影响岗位库') >= 0));
  // 边界说明：2026-10-05 由「不逆向接口」的假承诺改为如实披露。
  // 断言随之升级：不再检查含糊的「不逆向」字样，而是检查
  // ① 仍明确声明不做自动发消息/投递 ② 仍明确声明不代填密码
  // ③ **必须如实告知接口级读取更易触发风控** —— 这一条才是用户做风险判断的依据。
  //    若有人把风险提示删掉、只留下「不做」清单，这里必须变红。
  ok('边界说明四要素齐全',
    txt.indexOf('不自动发消息') >= 0 && txt.indexOf('不代填账号密码') >= 0);
  ok('边界说明如实披露了接口级读取的风控风险',
    txt.indexOf('数据接口') >= 0 && txt.indexOf('风控') >= 0,
    '页面里必须写明读取的是页面数据接口、且更易触发风控');
  ok('在线态没渲染成报错页', txt.indexOf('这个页面渲染出错了') < 0);

  // 两套模型 Key 的来源必须写清楚：以前只写「模型配置」，于是出现
  // 「采集页说已配 Key、岗位库却提示未配置」这种看着像坏了的矛盾（体检报告 三.7）
  ok('采集页的模型配置标签写明了来源是「采集器端」',
    txt.indexOf('模型配置（采集器端）') >= 0, '实际附近文本：' + txt.slice(0, 160));
  ok('采集页说明了两套模型配置互不影响', txt.indexOf('两套模型配置互不影响') >= 0);

  // 日志恢复：假 task 带了两行，应该出现在日志窗里
  const log = U.$('#cLog');
  ok('后台任务的日志被恢复出来了', !!log && log.textContent.indexOf('采集完成') >= 0,
    log ? '实际：' + JSON.stringify(log.textContent.slice(0, 60)) : '没找到 #cLog');

  // 导入：把采集结果灌进岗位库
  // ⛔ _import 现在是**异步**的（分批 + 让出主线程，见第 22 轮"导入卡住"的修复），
  //    必须 await —— 否则断言读到的是还没开始写的库，会得到"导入了 0 条"的假失败。
  const before = Store.jobs().length;
  await Views.collect._import();
  const after = Store.jobs().length;
  eq('导入采集结果后岗位库 +1', after - before, 1);
  const found = Store.jobs().filter(j => j.company === '采集来的公司');
  ok('导入的岗位带着正确的公司名', found.length === 1);
  ok('导入的岗位带了链接', !!found[0] && /zhipin\.com/.test(found[0].url || ''));

  // 重复导入应该走合并（去重），而不是再加一条
  await Views.collect._import();
  eq('再次导入同一批 → 不重复新增', Store.jobs().length, after);

  // 「一键清空采集结果」：有结果时应渲染「清空结果」按钮
  ok('结果卡有「清空结果」按钮',
    U.$$('#view button').some(b => (b.textContent || '').indexOf('清空结果') >= 0));

  // 点「清空结果」→ 弹确认框（danger 主按钮文案「清空结果」+「取消」）
  U.$$('#view button').filter(b => (b.textContent || '').indexOf('清空结果') >= 0)[0].click();
  ok('点「清空结果」弹出确认框',
    U.$$('.mask .mfoot button').some(b => (b.textContent || '').indexOf('清空结果') >= 0),
    '弹窗按钮：' + U.$$('.mask .mfoot button').map(b => b.textContent).join(' / '));
  ok('确认框有「取消」按钮',
    U.$$('.mask .mfoot button').some(b => (b.textContent || '').trim() === '取消'));

  // 点「取消」→ 确认框关闭、不发清空请求
  U.$$('.mask .mfoot button').filter(b => (b.textContent || '').trim() === '取消')[0].click();
  ok('点「取消」后确认框关闭', U.$$('.mask').length === 0);

  /* --- 14.5 探测进行中重复进入采集页：不能误判成离线 ---
     真实场景：进采集页 → 探测还没回来就切走 → 再切回来。
     早先 detect() 在探测进行中返回 `Promise.resolve(S.base)`，而那一刻 S.base 还是 null
     → 直接渲染「先启动本地采集器」（明明服务是活的）。
     这个 bug 是 CDP 真机端到端验收抓到的，当时的单测完全测不出来。 */
  const CS = Views.collect._state;

  let fetchCount = 0;
  const fetchUrls = [];
  const diag = () => 'base=' + CS.base + ' probing=' + CS.probing + ' 请求=' + fetchUrls.join(' ');
  /** 只答 ping 的桩，故意慢 50ms —— 制造出「探测进行中」的窗口 */
  const pingStub = (url) => {
    fetchCount++;
    fetchUrls.push(String(url).replace(/^https?:\/\/[^/]+/, '') + '#' + fetchCount);
    return new Promise(resolve => setTimeout(() => resolve({
      ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(fakePing)),
    }), 50));
  };
  const resetCollect = () => {
    CS.base = null; CS.ping = null; CS.probing = false; CS.probingP = null;
  };

  // ① 隔离验证：先手测桩本身能不能被 req 消化，再测 detect
  resetCollect();
  return withFetch(pingStub, () => {
    return sandbox.fetch('http://127.0.0.1:8738/api/ping', {})
      .then(res => res.text())
      .then(txt => {
        ok('①-a 桩返回的文本能解析出 ok:true', String(txt).indexOf('"ok":true') >= 0,
          '实际：' + String(txt).slice(0, 70));
        return Views.collect._detect();
      });
  }).then(base => {
    ok('①-b detect 单独调用能探到服务', base === 'http://127.0.0.1:8738',
      'base=' + base + '，请求=' + fetchUrls.join(' '));

    // ② 场景复现：进采集页 → 探测没回来就切走 → 再切回
    resetCollect();
    fetchUrls.length = 0;
    return withFetch(pingStub, () => {
      App.go('collect');
      ok('② 首次进入：探测中显示加载态', U.$('#view').textContent.indexOf('正在检测本地采集器') >= 0);
      App.go('jobs');              // 探测还没回来就切走
      App.go('collect');           // 再切回来
      return tick().then(tick)
        .then(() => new Promise(r => setTimeout(r, 220)))   // 等 50ms 的桩真的返回
        .then(tick).then(tick);
    });
  }).then(() => {
    const txt = U.$('#view').textContent;
    ok('② 探测中切走再切回 → 不误判为离线', txt.indexOf('先启动本地采集器') < 0, diag() + ' | ' + txt.slice(0, 50));
    ok('② 切回来后最终渲染出在线态', txt.indexOf('已连接') >= 0, diag() + ' | ' + txt.slice(0, 50));
  });
}).then(async () => {
  /* ==================================================================
     【14.6】采集器安全：访问令牌 + 采集前登录预检（2026-10-05 评审 P0-1 / P0-3）
     ------------------------------------------------------------------
     令牌：只有「采集器 serve 的页面」才有 window.__JH_TOKEN__，所有 /api/* 都要带
     X-JH-Token（服务端没有就 403）。缺令牌时采集页必须给引导卡 —— 不让用户在一堆
     「连不上」里打转。
     预检：登录过期 / 没测过时，点「开始采集」应先跑登录检测，而不是把任务起起来白跑。
     ================================================================== */
  section('【14.6】采集器安全：访问令牌 + 采集前登录预检');

  eq('桩里模拟「采集器打开的页面」→ 有访问令牌', VC._token(), 'unit-test-token');

  // --- 请求确实带上了 X-JH-Token ---
  {
    const seen = [];
    const rec = (url, init) => {
      seen.push({ url: String(url), h: (init && init.headers) || {} });
      return Promise.resolve({ ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true, task: null })) });
    };
    const CS0 = VC._state;
    CS0.base = null; CS0.ping = null; CS0.probing = false; CS0.probingP = null;
    await withFetch(rec, () => VC._detect());
    const withTok = seen.filter(x => x.h['X-JH-Token'] === 'unit-test-token');
    ok('探测请求带上了 X-JH-Token', seen.length > 0 && withTok.length === seen.length,
      '请求数=' + seen.length + '，带令牌=' + withTok.length);
  }

  // --- 缺令牌：采集页给「缺访问令牌」引导卡，而不是一堆失败 ---
  {
    const CS = VC._state;
    const stub = (url) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      let body = { ok: false, error: '403' };
      if (p.indexOf('/api/ping') === 0) body = Object.assign({}, fakePing, { port: 8738, pid: 999 });
      else if (p.indexOf('/api/jobs') === 0) body = { ok: true, jobs: [], total: 0 };
      else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    const saved = sandbox.__JH_TOKEN__;
    delete sandbox.__JH_TOKEN__;
    CS.base = null; CS.ping = null; CS.probing = false; CS.probingP = null;
    await withFetch(stub, () => {
      App.go('collect');
      return tick().then(tick).then(tick).then(tick).then(tick).then(tick);
    });
    const txt = U.$('#view').textContent;
    ok('缺令牌时渲染「缺访问令牌」引导卡', txt.indexOf('缺访问令牌') >= 0, '实际：' + txt.slice(0, 90));
    ok('引导卡说明了原因（页面不是采集器打开的）', txt.indexOf('不是采集器打开的') >= 0);
    ok('引导卡给出两条出路（打开采集器页面 / 手动导入）',
      txt.indexOf('打开采集器页面') >= 0 && txt.indexOf('改成手动导入') >= 0);
    ok('缺令牌时不渲染成报错页', txt.indexOf('这个页面渲染出错了') < 0);
    sandbox.__JH_TOKEN__ = saved;
    CS.base = null; CS.ping = null; CS.probing = false; CS.probingP = null;
  }

  // --- 登录新鲜度判定（TTL 由服务端 ping 下发，前端不写死）---
  {
    const CS = VC._state;
    const keep = CS.ping;
    const now = Date.now() / 1000;

    CS.ping = { login: { value: 'ok', checkedAt: now, ttlSec: 6 * 3600 } };
    ok('登录态 ok 且刚测过 → loginFresh()=true', VC._loginFresh() === true);

    /* 关键：TTL 放宽后，1 小时前测的**仍算新鲜**（以前 45 分钟就过期，
       用户每 45 分钟被拦一次去扫码 —— 这是本轮要消灭的摩擦）。 */
    CS.ping = { login: { value: 'ok', checkedAt: now - 3600, ttlSec: 6 * 3600 } };
    ok('TTL 放宽后，1 小时前测过的仍算新鲜（不用重新扫码）',
      VC._loginFresh() === true);

    CS.ping = { login: { value: 'ok', checkedAt: now - 7 * 3600, ttlSec: 6 * 3600 } };
    ok('超过 6 小时 TTL → loginFresh()=false（要求重测）', VC._loginFresh() === false);

    /* ⛔ TTL 必须来自服务端下发，不能在前端写死 ——
       两边各写一个值，改一边忘一边就会出现「前端以为新鲜、后端说不行」的诡异拦截。 */
    CS.ping = { login: { value: 'ok', checkedAt: now - 3600, ttlSec: 60 } };
    ok('⛔ TTL 是服务端下发的（ttlSec=60 时 1 小时前测的算过期）',
      VC._loginFresh() === false);
    CS.ping = { login: { value: 'ok', checkedAt: now, ttlSec: undefined } };
    ok('ping 没带 ttlSec 时退回 45 分钟兜底（不会崩、也不会永远新鲜）',
      VC._loginFresh() === true);

    CS.ping = { login: { value: 'needed', checkedAt: now, ttlSec: 6 * 3600 } };
    ok('登录态 needed → loginFresh()=false', VC._loginFresh() === false);
    CS.ping = { login: {} };
    ok('从没测过 → loginFresh()=false', VC._loginFresh() === false);
    CS.ping = keep;
  }

  // --- 采集前登录预检：未登录先跑 /api/login，别直接起采集 ---
  {
    const CS = VC._state;
    const paths = [];
    const stub = (url) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      paths.push(p);
      let body = { ok: true };
      if (p.indexOf('/api/login') === 0) body = { ok: true, key: 'login' };
      else if (p.indexOf('/api/crawl') === 0) body = { ok: true, key: 'crawl' };
      else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
      else if (p.indexOf('/api/ping') === 0) body = fakePing;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    const keepPing = CS.ping, keepForm = CS.form, keepBase = CS.base;
    CS.base = 'http://127.0.0.1:8738';        // 有 base 才拼得出完整请求地址
    CS.form = { city: '杭州', keywords: '运营', count: 30 };

    // ① 登录过期 → 先登录检测，且**不能**直接起采集（否则又白跑）
    CS.ping = { login: { value: 'needed', checkedAt: 0 } };
    await withFetch(stub, () => { VC._doCrawl(null); return tick().then(tick); });
    ok('登录过期时点「开始采集」→ 先请求 /api/login',
      paths.some(p => p.indexOf('/api/login') === 0), '实际请求：' + paths.join(' '));
    ok('登录过期时**不**直接起采集任务（不白跑）',
      !paths.some(p => p.indexOf('/api/crawl') === 0), '实际请求：' + paths.join(' '));

    // ② 登录新鲜 → 直接起采集，不再多跑一次登录检测
    paths.length = 0;
    CS.ping = { login: { value: 'ok', checkedAt: Date.now() / 1000 } };
    await withFetch(stub, () => { VC._doCrawl(null); return tick().then(tick); });
    ok('登录新鲜时点「开始采集」→ 直接请求 /api/crawl',
      paths.some(p => p.indexOf('/api/crawl') === 0), '实际请求：' + paths.join(' '));
    ok('登录新鲜时不再多跑一次登录检测',
      !paths.some(p => p.indexOf('/api/login') === 0), '实际请求：' + paths.join(' '));

    CS.ping = keepPing; CS.form = keepForm; CS.base = keepBase;
    CS.base = null; CS.ping = null; CS.probing = false; CS.probingP = null;
    U.closeAllModals();
  }
}).then(async () => {
  U.closeAllModals();

  /* ==================================================================
     【15】带真实数据的九个页面渲染
     —— 空库渲染测不出真实问题：很多分支只在「有条目」时才走到
     （列表循环、分组、图表、时间线、卡片里的可选子节点…）。
     这里灌入真实采集结果，再把九个页面全渲染一遍。
     ================================================================== */
  section('【15】带真实数据的九个页面渲染');

  (function renderWithRealData() {
    const BACKUP = path.join(DIR, '采集结果_2026-09-25.json');
    if (!fs.existsSync(BACKUP)) {
      console.log('  （跳过：没找到 ' + BACKUP + '）');
      return;
    }
    let rep = null;
    try {
      rep = Store.importObject(JSON.parse(fs.readFileSync(BACKUP, 'utf8')), 'replace');
    } catch (e) {
      return ok('导入真实采集结果', false, e && e.message);
    }
    ok('导入真实采集结果 ' + rep.jobs + ' 条', rep.jobs > 0);
    eq('岗位库条数', Store.jobs().length, rep.jobs);

    ['jobs', 'kanban', 'interview', 'resume', 'assistant', 'compare', 'dashboard', 'settings', 'collect']
      .forEach(id => {
        const r = inspectPage(id);
        const title = (Views[id] && Views[id].title) || id;
        ok('有数据时「' + title + '」没被错误兜底卡顶掉', !r.crashed && !r.err,
          r.err ? r.err.message : ('内部抛异常被吞：' + r.crashMsg));
      });

    // 岗位库是最容易在「有数据」时才炸的一页，单独多验一层：
    // 十五条岗位应当渲染出十五条卡片，而不是一张错误兜底卡。
    App.go('jobs');
    const cards = U.$$('#view .job');
    ok('岗位库渲染出 ' + Store.jobs().length + ' 张岗位卡', cards.length === Store.jobs().length,
      '实际 ' + cards.length + ' 张');
    const cardTxt = cards.length ? cards[0].textContent : '';
    ok('岗位卡里有公司名和薪资', !!cardTxt && cardTxt.length > 6, '首卡文本：' + cardTxt.slice(0, 60));
  })();

  /* ==================================================================
     【16】弹窗确认按钮 · 回归
     ------------------------------------------------------------------
     曾经的一个系统性 bug：openModal 的 close() 会【同步】调 onClose，
     而所有确认型弹窗的按钮回调都是「先 c() 关窗、再 resolve(成功值)」，
     于是 onClose 里的 resolve(null/false) 抢先落地（Promise 只认第一次）
     —— 点「确认」等于点「取消」。表现为：删除岗位删不掉、新建面试进不去表单、
     打招呼选岗位没反应、投递绑简历绑不上、清空数据/导入覆盖静默失效。
     这里必须**真的点按钮**才测得出来，光调 API 是测不到的。
     ================================================================== */
  section('【16】弹窗确认按钮（回归：点「确认」曾经等于点「取消」）');

  // footer 里按文案找按钮（弹窗内的按钮是动态建的，没法按 id 找）
  const mBtn = (text) => U.$$('.mask .mfoot button').filter(b => (b.textContent || '').trim() === text)[0] || null;
  /* toast 淡出要 260ms 才从 DOM 摘掉，所以上一个用例的「撤销」按钮可能还挂着。
     每个用例开头清一次，并且永远取"最后一个"——否则会点到上一条的撤销，
     而它拿的是已经还原过的快照（putBack 会把重复 id 跳过，表现成"点了没反应"）。 */
  const clearToasts = () => { const box = U.$('#toasts'); if (box) box.innerHTML = ''; };
  const undoBtn = () => {
    const all = U.$$('#toasts .toast-act button').filter(b => (b.textContent || '').trim() === '撤销');
    return all.length ? all[all.length - 1] : null;
  };
  // 弹窗内任意位置的按钮
  const anyBtn = (kw) => U.$$('.mask button').filter(b => (b.textContent || '').indexOf(kw) >= 0)[0] || null;

  /* --- 16.1 基础原语：U.confirm 的两条分支都要对 --- */
  {
    let got = 'unset';
    U.confirm('回归测试：确认吗？').then(v => { got = v; });
    const b = mBtn('确认');
    ok('U.confirm 渲染出「确认」按钮', !!b);
    b.click();
    await tick();
    eq('点「确认」→ resolve(true)', got, true);
    eq('点「确认」后弹窗自行关闭', U.$$('.mask').length, 0);
  }
  {
    let got = 'unset';
    U.confirm('回归测试：取消吗？').then(v => { got = v; });
    mBtn('取消').click();
    await tick();
    eq('点「取消」→ resolve(false)', got, false);
  }
  {
    let got = 'unset';
    U.confirm('回归测试：叉掉呢？').then(v => { got = v; });
    U.closeAllModals();
    await tick();
    eq('叉掉 / Esc / 点遮罩关闭 → resolve(false)', got, false);
  }

  /* --- 16.2 U.prompt：确定要回填输入框里的值 --- */
  {
    let got = 'unset';
    U.prompt('回归：输入点东西', '标签', '我填的内容').then(v => { got = v; });
    await tick();
    mBtn('确定').click();
    await tick();
    eq('U.prompt 点「确定」→ 返回输入框的值', got, '我填的内容');
  }

  /* --- 16.3 真实业务路径：删除岗位 → 撤销（报告里第一个报的功能） ---
     链路变了：单个删除不再弹确认框，改成「直接删 + toast 里给撤销窗口」。
     所以这里既要验"删掉了"，也要验"能撤回"——只验前者会漏掉最危险的那半边。 */
  {
    clearToasts();
    App.go('jobs');
    const target = Store.jobs()[0];
    const before = Store.jobs().length;
    const keepId = Store.jobs()[1].id;
    Views.jobs.detail(target.id);

    // 危险操作现在收在底栏「⋯ 更多」里
    const moreBtn = mBtn('⋯ 更多');
    ok('岗位详情底栏有「⋯ 更多」', !!moreBtn);
    ok('详情里不再直接摆着「删除这个岗位」（避免误点）', !anyBtn('删除这个岗位'));

    moreBtn.click();
    await tick();
    const delItem = U.$$('.menu .mi').filter(b => (b.textContent || '').indexOf('删除这个岗位') >= 0)[0] || null;
    ok('「⋯ 更多」菜单里有「删除这个岗位」', !!delItem);

    delItem.click();
    await tick();
    eq('点删除后岗位真的少了一个', Store.jobs().length, before - 1);

    const undo = undoBtn();
    ok('删除后弹出带「撤销」按钮的 toast', !!undo);
    ok('删除 toast 说明了删的是哪个岗位',
      U.$$('#toasts .toast .flex1').some(n => (n.textContent || '').indexOf('已删除岗位') >= 0));

    undo.click();
    await tick();
    eq('点「撤销」后岗位回来了', Store.jobs().length, before);
    ok('恢复的是同一条（不能变成新 id）', !!Store.job(target.id));
    ok('没被牵连删除的那条也还在', !!Store.job(keepId));

    U.closeAllModals();
    await tick();
  }

  /* --- 16.3b 撤销要能连带把投递和面试一起接回来 ---
     删岗位时 takeOut 会顺手删掉它的投递与面试，撤销必须整包还原，
     否则用户会看到"岗位回来了但看板里没了"。 */
  {
    clearToasts();
    const j = Store.jobs()[0];
    const app = Store.addApplication({ jobId: j.id, status: 'applied' });
    const iv = Store.addInterview({ jobId: j.id, at: U.now() + 86400000, round: '一面（技术/业务）' });
    Views.jobs.deleteWithUndo(j.id, null, null);
    await tick();
    ok('删除岗位时连带删掉了投递', !Store.application(app.id));
    ok('删除岗位时连带删掉了面试', !Store.interview(iv.id));

    undoBtn().click();
    await tick();
    ok('撤销后投递也回来了', !!Store.application(app.id));
    ok('撤销后面试也回来了', !!Store.interview(iv.id));
    U.closeAllModals();
    await tick();
  }

  /* --- 16.4 jobPicker：点「确定」必须吐出选中的岗位 id --- */
  {
    App.go('jobs');
    let picked = 'unset';
    Comp.jobPicker({ title: '回归：选岗位' }).then(v => { picked = v; });
    await tick();
    const rows = U.$$('.mask .box.pointer');
    ok('岗位选择器列出了可选岗位', rows.length > 0, '实际 ' + rows.length + ' 行');
    rows[0].click();
    await tick();
    mBtn('确定').click();
    await tick();
    ok('jobPicker 点「确定」→ 返回岗位 id（不是 null）',
      typeof picked === 'string' && picked.length > 0, '实际 ' + JSON.stringify(picked));
  }

  /* --- 16.5 resumePicker：点一行必须吐出该简历 id --- */
  {
    const rr = Store.addResume({ name: '回归测试用简历', content: '测试内容'.repeat(40) });
    App.go('resume');
    let got = 'unset';
    Comp.resumePicker({}).then(v => { got = v; });
    await tick();
    const rows = U.$$('.mask .box.pointer');
    ok('简历选择器列出了可选简历', rows.length > 0, '实际 ' + rows.length + ' 行');
    /* ⛔ 点的那一行必须**就是** rr 那一行，不能默认 rows[0]。
       简历库里其它用例也会加简历，rows[0] 未必是刚建的这份 ——
       以前取 rows[0] 再断言等于 `rr.id`，一旦库里有多份就必然红（且是测试自身的问题，
       不是产品 bug）。改成按行上的 data-id 找到 rr 那一行。 */
    let target = null;
    for (let i = 0; i < rows.length; i++) {
      const id = rows[i].getAttribute ? rows[i].getAttribute('data-id') : null;
      if (id && id === rr.id) { target = rows[i]; break; }
    }
    /* 桩里若没打 data-id，就退回"点完再看返回的 id 是否是库里合法的简历 id" */
    const row = target || rows[0];
    row.click();
    await tick();
    await tick();                                  // Promise 回调可能落在下一个 tick
    ok('resumePicker 点一行 → 返回一个真实存在的简历 id',
      typeof got === 'string' && !!Store.resume(got),
      'got=' + JSON.stringify(got) + ' rows=' + rows.length + ' 目标=' + (target ? 'rr' : 'rows[0]'));
  }

  /* --- 16.6 AI 未配 Key：必须给出可见错误，不能永久卡在「正在调用…」 --- */
  {
    Store.setSetting('ai.apiKey', '');
    App.go('jobs');
    Comp.runAI({ title: '回归：未配 Key', tpl: 'jobParse', input: { text: 'x' }, autoRun: true });
    await new Promise(r => setTimeout(r, 260));   // runAI 里是 setTimeout(start, 120)
    await tick();
    const modalTxt = U.$('.mask .modal') ? U.$('.mask .modal').textContent : '';
    ok('未配 Key 时 AI 弹窗显示了真实原因（而不是停在「正在调用」）',
      modalTxt.indexOf('还没配置模型接口') >= 0, '弹窗文本尾部：' + modalTxt.slice(-140));
    ok('未配 Key 时给了「去设置页填 API Key」的入口', !!anyBtn('去设置页填 API Key'));
    ok('未配 Key 时「重新生成」按钮恢复可用（没被永久禁用）',
      !!mBtn('重新生成') && mBtn('重新生成').disabled !== true);
    U.closeAllModals();
    await tick();
    Store.setSetting('ai.apiKey', 'sk-test');
  }

  /* --- 16.6b AI 结果面板的小标题必须是中文 ---
     ⛔ 回归点：模型返回的 JSON 键是英文（score / verdict / category / matched …），
        defaultRender 曾经**直接拿它当小标题** → 整个弹窗中英混排。
        这里**真跑一次渲染**再断言屏幕上的文字 —— 只断言源码里「有张映射表」是自证，
        把 defaultRender 里的 aiKeyLabel(k) 改回 k 照样能绿。 */
  {
    const origRun = AI.runTemplate;
    AI.runTemplate = () => Promise.resolve({
      text: '',
      data: {
        score: 78,
        verdict: '有短板但值得投',
        category: 'need_optimization',
        matched: ['短视频全流程能力匹配'],
        missing: ['出镜意愿'],
        suggestions: ['补一条出镜作品'],
        remote: false,
      },
    });
    App.go('jobs');
    Comp.runAI({ title: '回归：结果面板中文标题', tpl: 'match', input: { resume: 'r', job: 'j' }, autoRun: true });
    await new Promise(r => setTimeout(r, 260));   // runAI 里是 setTimeout(start, 120)
    await tick();
    const panel = U.$('.mask .modal') ? U.$('.mask .modal').textContent : '';

    ok('16.6b 结果面板：score 的小标题是「综合评分」',
      panel.indexOf('综合评分') >= 0, '面板文本：' + panel.slice(0, 160));
    ok('16.6b 结果面板：verdict 的小标题是「一句话结论」', panel.indexOf('一句话结论') >= 0);
    ok('16.6b 结果面板：matched 的小标题是「匹配上的点」', panel.indexOf('匹配上的点') >= 0);
    ok('16.6b 结果面板：正文里不再出现英文键 verdict / category / matched',
      panel.indexOf('verdict') < 0 && panel.indexOf('category') < 0 && panel.indexOf('matched') < 0,
      '面板文本：' + panel.slice(0, 220));
    ok('16.6b 结果面板：枚举值 need_optimization 已翻成中文',
      panel.indexOf('need_optimization') < 0 && panel.indexOf('优化简历后可投') >= 0);
    ok('16.6b 结果面板：布尔值 remote=false 显示成「非远程」（不是 false）',
      panel.indexOf('是否远程') >= 0 && panel.indexOf('非远程') >= 0);

    U.closeAllModals();
    await tick();
    AI.runTemplate = origRun;
  }

  /* --- 16.6c/16.6e AI 助手页：JSON 模板的回复必须渲染成中文面板 ---
     ⛔ 这是**另一条渲染路径**：助手页的气泡走 App.md(原文)，跟弹窗的 defaultRender 毫不相干。
        只修弹窗的话，助手页点「简历匹配打分 / 粘贴 JD 解析」照样满屏英文键。
     16.6c 测历史气泡；16.6e 真点一次按钮，把 streamReply 那条路也走通（两条都会渲染气泡）。 */
  {
    const cc = Store.addChat({ kind: 'match', title: '回归：助手页中文标题' });
    Store.pushMessage(cc.id, 'user', '帮我看看匹配度');
    Store.pushMessage(cc.id, 'assistant', JSON.stringify({
      score: 78, verdict: '有短板但值得投', category: 'need_optimization',
      matched: ['短视频全流程能力匹配'], missing: ['出镜意愿'],
      suggestions: ['补一条出镜作品'], remote: false,
    }), { tpl: 'match' });
    App.go('assistant', { chatId: cc.id });
    await tick();
    const bubTxt = U.$('#view .bubbles') ? U.$('#view .bubbles').textContent : '';
    ok('16.6c 助手页气泡：score 的小标题是「综合评分」',
      bubTxt.indexOf('综合评分') >= 0, '气泡文本：' + bubTxt.slice(0, 160));
    ok('16.6c 助手页气泡：verdict 的小标题是「一句话结论」', bubTxt.indexOf('一句话结论') >= 0);
    ok('16.6c 助手页气泡：正文里不再出现英文键 verdict / category / matched',
      bubTxt.indexOf('verdict') < 0 && bubTxt.indexOf('category') < 0 && bubTxt.indexOf('matched') < 0,
      '气泡文本：' + bubTxt.slice(0, 220));
    ok('16.6c 助手页气泡：枚举值 need_optimization 已翻成中文',
      bubTxt.indexOf('need_optimization') < 0 && bubTxt.indexOf('优化简历后可投') >= 0);
  }

  /* --- 16.6e 真点助手页「简历匹配打分」：streamReply 那条路也要出中文面板 --- */
  {
    const origChat = AI.chat;
    AI.chat = () => Promise.resolve(JSON.stringify({
      score: 66, verdict: '可以投，但要补一句出镜经历', category: 'qualified',
      matched: ['运营经验'], missing: [], suggestions: ['补数据'],
    }));
    const cc2 = Views.assistant.openWithChat('match', '回归：打分任务', '');
    await tick();
    const taskBtn = U.$$('#view button').filter(b => (b.textContent || '').indexOf('简历匹配打分') >= 0)[0];
    ok('16.6e 前置：助手页有「简历匹配打分」按钮', !!taskBtn);
    if (taskBtn) {
      taskBtn.click();
      await tick();
      const rows = U.$$('.mask .box.pointer');
      ok('16.6e 前置：弹出了岗位选择器', rows.length > 0, '实际 ' + rows.length + ' 行');
      if (rows.length) {
        rows[0].click();
        await tick();
        if (mBtn('确定')) { mBtn('确定').click(); await tick(); }
        // 简历多于一份时还会弹简历选择器
        if (U.$$('.mask .box.pointer').length) {
          U.$$('.mask .box.pointer')[0].click();
          await tick();
          if (mBtn('确定')) { mBtn('确定').click(); await tick(); }
        }
      }
      await new Promise(r => setTimeout(r, 320));
      const t2 = U.$('#view .bubbles') ? U.$('#view .bubbles').textContent : '';
      ok('16.6e streamReply 路径：score 的小标题是「综合评分」',
        t2.indexOf('综合评分') >= 0, '气泡文本：' + t2.slice(0, 200));
      ok('16.6e streamReply 路径：正文里不再出现英文键 verdict / category',
        t2.indexOf('verdict') < 0 && t2.indexOf('category') < 0, '气泡文本：' + t2.slice(0, 220));
    }
    AI.chat = origChat;
  }

  /* --- 16.7 弹窗不该跨页面残留 --- */
  {
    App.go('jobs');
    Views.jobs.detail(Store.jobs()[0].id);
    eq('岗位详情已打开', U.$$('.mask').length, 1);
    App.go('dashboard');
    await tick();
    eq('切页后开着的弹窗被自动收掉', U.$$('.mask').length, 0);
  }

  /* --- 16.8 仪表盘「收藏岗位」口径 --- */
  {
    const jj = Store.jobs()[0];
    if (!jj.favorite) Store.toggleJobFlag(jj.id, 'favorite');
    const st = Store.stats();
    ok('测试数据里「收藏数」和「在库岗位数」不相等（否则测不出误用 jobTotal）',
      st.jobFavorite !== st.jobTotal, '收藏 ' + st.jobFavorite + ' / 在库 ' + st.jobTotal);

    App.go('dashboard');
    const favCard = U.$$('#view .stat').filter(s => s.textContent.indexOf('收藏岗位') >= 0)[0];
    ok('仪表盘有「收藏岗位」卡片', !!favCard);
    const v = favCard && favCard.querySelector('.v');
    eq('仪表盘「收藏岗位」显示的是收藏数（不是岗位总数）', v && v.textContent, String(st.jobFavorite));
    ok('仪表盘「收藏岗位」的描述里说明了归档不计入',
      !!favCard && favCard.textContent.indexOf('已归档') >= 0,
      '实际：' + (favCard ? favCard.textContent : ''));
  }

  /* --- 16.9 详情弹窗里收藏后，宿主页面要即时更新 --- */
  {
    App.go('jobs');
    const target = Store.jobs().filter(j => !j.favorite)[0] || Store.jobs()[0];
    Views.jobs.detail(target.id);
    const favBtn = anyBtn('收藏');
    ok('详情弹窗里有收藏按钮', !!favBtn);
    favBtn.click();
    await tick();
    const nowFav = Store.stats().jobFavorite;
    const strip = U.$$('#view .stat').filter(s => s.textContent.indexOf('收藏') >= 0)[0];
    const sv = strip && strip.querySelector('.v');
    eq('详情里收藏后，岗位页顶部「收藏」数字即时更新', sv && sv.textContent, String(nowFav));
    U.closeAllModals();
    await tick();
  }

  /* --- 16.10 岗位卡 JD 只给摘要 + 展开入口 --- */
  {
    App.go('jobs');
    const allCards = U.$$('#view .job');
    const longCard = allCards.filter(c => c.querySelector('.jd-more'))[0];
    ok('长 JD 的岗位卡带「展开全文」按钮', !!longCard,
      '15 条里 rawJD 最长 735 字，应当至少有一张需要展开');

    const card = longCard || allCards[0];
    ok('岗位卡有 JD 摘要容器', !!card && !!card.querySelector('.jd'));
    const shortTxt = card.querySelector('.jd').textContent;
    ok('JD 摘要是截断过的（不会把整段 JD 铺满卡片）', shortTxt.length <= 130,
      '摘要长度 ' + shortTxt.length + '：' + shortTxt.slice(0, 60));
    ok('摘要默认带着省略号', shortTxt.slice(-1) === '…', '尾部：' + shortTxt.slice(-12));

    if (longCard) {
      longCard.querySelector('.jd-more').click();
      const fullTxt = longCard.querySelector('.jd').textContent;
      ok('点「展开全文」后显示完整 JD', fullTxt.length > shortTxt.length,
        '展开后 ' + fullTxt.length + ' 字（摘要 ' + shortTxt.length + ' 字）');
      ok('展开后去掉了 2 行截断限制', longCard.querySelector('.jd').className.indexOf('clamp2') < 0,
        '实际 class：' + longCard.querySelector('.jd').className);
      longCard.querySelector('.jd-more').click();
      eq('再点一次收起，回到摘要', longCard.querySelector('.jd').textContent.length, shortTxt.length);
    }
  }

  /* --- 16.11 未配置 AI 的提示条：要说清来源，并且能关掉 --- */
  {
    Store.setSetting('ai.apiKey', '');
    try { sessionStorage.clear(); } catch (e) { /* noop */ }

    App.go('jobs');
    const note = U.$('#view .note.warn');
    ok('未配 Key 时岗位库顶部有提示条', !!note);
    ok('提示条点明是「这个工作台」的配置（不是采集器那套）',
      !!note && note.textContent.indexOf('这个工作台') >= 0,
      note ? note.textContent.slice(0, 70) : '');
    ok('提示条里说明了采集页的 Key 是另一套',
      !!note && note.textContent.indexOf('采集器服务端') >= 0);

    const x = note && note.querySelector('.note-x');
    ok('提示条带「本页不再提示」的关闭按钮', !!x);
    if (x) {
      x.click();
      ok('点关闭后提示条当场消失', !U.$('#view .note.warn'));
      App.go('kanban');
      ok('关掉之后其它页面也不再出现（本次会话内）', !U.$('#view .note.warn'));
      App.go('dashboard');
      ok('切到仪表盘同样不再出现', !U.$('#view .note.warn'));
    }

    Store.setSetting('ai.apiKey', 'sk-test');
    try { sessionStorage.clear(); } catch (e) { /* noop */ }
  }

  /* --- 16.12 简历编辑弹窗的字数要实时更新（以前是渲染时算一次的静态文本） --- */
  {
    App.go('resume');
    Views.resume.openResumeForm(null);
    await tick();
    const modal = U.$('.mask .modal');
    const ta = modal ? modal.querySelector('textarea') : null;
    ok('简历表单里有内容输入框', !!ta);
    const hintOf = () => U.$$('.mask .hint').map(n => n.textContent).filter(t => t.indexOf('当前') >= 0)[0] || '';
    ok('初始字数提示是「当前 0 字」', hintOf().indexOf('当前 0 字') >= 0, '实际：' + hintOf());
    if (ta) {
      ta.value = '一二三四五六七八九十';
      ta.dispatchEvent({ type: 'input', target: ta, stopPropagation() {}, preventDefault() {} });
      ok('输入后字数提示跟着更新到 10 字', hintOf().indexOf('当前 10 字') >= 0, '实际：' + hintOf());
    }
    U.closeAllModals();
    await tick();
  }

  /* --- 16.13 快捷键帮助：侧边栏有入口，弹窗内容齐全 --- */
  {
    const helpBtn = U.$('#btnHelp');
    ok('侧边栏有「快捷键 / 帮助」入口（不再只藏在设置页最底部）', !!helpBtn);
    App.openHelp();
    await tick();
    const t = U.$('.mask .modal') ? U.$('.mask .modal').textContent : '';
    ok('帮助弹窗列出了 Ctrl + K', t.indexOf('Ctrl + K') >= 0);
    ok('帮助弹窗列出了 Esc', t.indexOf('Esc') >= 0);
    ok('帮助弹窗重申了「不自动投递」的边界', t.indexOf('不自动发消息') >= 0 || t.indexOf('不自动投递') >= 0);
    U.closeAllModals();
    await tick();
  }

  /* --- 16.14 岗位库的筛选计数文案不再自相矛盾 --- */
  {
    App.go('jobs');
    const headOf = () => (U.$('#view .row b.fs13') || {}).textContent || '';
    ok('未筛选时是「共 N 个岗位」', /^共 \d+ 个岗位/.test(headOf()), '实际：' + headOf());
    Views.jobs.filters.kw = '运营';
    App.go('jobs');
    const filtered = headOf();
    ok('筛选后改成「显示 N 个 · 在库共 M 个」',
      /^显示 \d+ 个 · 在库共 \d+ 个/.test(filtered), '实际：' + filtered);
    ok('筛选后不再出现「已筛选，总共」这种绕的说法', filtered.indexOf('已筛选，总共') < 0);
    Views.jobs.filters.kw = '';
  }

  /* ==================================================================
     【16.15】跨标签页同步：不能再「重复 toast + 无限对刷 + 每次新开一个页面」
     ------------------------------------------------------------------
     用户现象（截图）：同一条 toast「检测到另一个标签页修改了数据，正在重新载入…」
     叠了三层，页面反复重载。根因有三层，每一层都要被钉住：

       ① store.js 一次 save() 要写**两个** key（`jobhunter.db.v1.<账号>` 和它的 .bak），
          而 app.js 的监听原来用**前缀匹配** → 一次保存算成两个事件 → 两条一样的 toast。
       ② 收到事件就 `location.reload()`；而 reload 会触发 beforeunload / pagehide
          → flush() → 又一次 setItem → 对端再 reload → **两个标签页无限对刷**。
       ③ 「使用时又多开一个页面」来自 launcher：找到采集组件时把 JH_NO_CRAWLER pop 掉了，
          于是 launcher 与 server_core 各开一次浏览器（这条在 Python 侧，由
          `_测试_真机.py` 与源码断言兜，这里只管前端两个）。
     ================================================================== */
  section('【16.15】跨标签页同步（重复 toast / 无限对刷）');
  {
    const SYNC_KEY = 'jobhunter.db.v1.' + Store.currentAccount();

    /* --- A. 「内容没变就不写盘」：这是对刷死循环的断点 --- */
    {
      Store.flush();                    // 先让基线与磁盘对齐（这次不计入）
      const origSet = localStorage.setItem;
      const writes = [];
      localStorage.setItem = (k, v) => { writes.push(k); return origSet.call(localStorage, k, v); };
      try { Store.flush(); Store.flush(); Store.flush(); }
      finally { localStorage.setItem = origSet; }
      ok('16.15A ⛔ 内容没变时 flush() 一次都不写盘（跨页对刷的环断在这里）',
        writes.length === 0, '实际写了 ' + writes.length + ' 次：' + writes.slice(0, 4).join(','));

      // 反证：真改了内容就必须写 —— 否则上面那条可能只是 save 彻底坏了（假绿）
      Store.addJob({ title: '同步用例岗位', company: '甲', source: 'manual' });
      const writes2 = [];
      localStorage.setItem = (k, v) => { writes2.push(k); return origSet.call(localStorage, k, v); };
      try { Store.flush(); } finally { localStorage.setItem = origSet; }
      ok('16.15A 反证：改成内容变了就必须落盘',
        writes2.indexOf(SYNC_KEY) >= 0, '实际写了：' + writes2.join(','));
    }

    /* --- B. applyExternal：只认当前账号的 key，只换内存不写盘 --- */
    {
      const baseObj = JSON.parse(JSON.stringify(Store.raw()));
      const extJob = {
        id: 'sync_ext_job_1', source: 'manual', title: '别的标签页加进来的岗位', company: '乙',
        industry: '', location: '', remote: false, salaryText: '', salaryMin: 0, salaryMax: 0,
        salaryMonths: 0, benefits: [], duties: [], reqDegree: '', reqYears: '', reqSkills: [],
        keywords: [], pros: [], cons: [], tags: [], flags: {}, notes: '', status: 'wish',
        createdAt: Date.now(), updatedAt: Date.now(),
      };
      const extObj = JSON.parse(JSON.stringify(baseObj));
      extObj.jobs = (extObj.jobs || []).concat([extJob]);
      const extRaw = JSON.stringify(extObj);

      const origSet2 = localStorage.setItem;
      const wrote = [];
      localStorage.setItem = (k, v) => { wrote.push(k); return origSet2.call(localStorage, k, v); };
      let okBak, okOther, okReal;
      try {
        okBak = Store.applyExternal(SYNC_KEY + '.bak', extRaw);
        okOther = Store.applyExternal('jobhunter.db.v1.别的账号', extRaw);
        okReal = Store.applyExternal(SYNC_KEY, extRaw);
        /* ⛔ 计数窗口必须**包住软同步之后的 flush()**。
           只数 applyExternal 内部有没有写盘是**假绿**：那个函数压根不调 save()，
           数出来恒为 0。真正会炸的是「同步完没把基线对齐 → 对端随手一次 flush
           （beforeunload / pagehide / visibilitychange 都会触发它）又写盘
           → 第二个 storage 事件 → 对端也收到 → 对刷」。
           变异「applyExternal 故意把 lastSavedJSON 置空」就是靠这两行才变红的。 */
        Store.flush();
        Store.flush();
      } finally { localStorage.setItem = origSet2; }

      ok('16.15B ⛔ .bak（同一次保存的副产物）不被当成「数据被改了」', okBak === false,
        'applyExternal 返回 ' + okBak);
      ok('16.15B ⛔ 别的账号的 key 不能被套到当前账号上（多账号会串数据）', okOther === false,
        'applyExternal 返回 ' + okOther);
      ok('16.15B 当前账号的 key 会被就地应用',
        okReal === true && Store.jobs().some(j => j.id === 'sync_ext_job_1'),
        '返回 ' + okReal + ' 岗位数 ' + (baseObj.jobs || []).length + ' → ' + Store.jobs().length);
      ok('16.15B ⛔ 软同步（含随后的 flush）全程不写盘（一写就又触发对端事件 = 对刷）',
        wrote.length === 0, '实际写了 ' + wrote.length + ' 次：' + wrote.slice(0, 4).join(','));
      Store.removeJob('sync_ext_job_1');      // 收尾：别污染后面的用例
    }

    /* --- C. 真派发 storage 事件，走 app.js 那条监听 --- */
    {
      const listeners = (document._listeners.storage || []).slice();
      ok('16.15C 前置：app.js 真的在 document 上注册了 storage 监听', listeners.length >= 1,
        '实际 ' + listeners.length + ' 个');

      /* ⛔ 把 sandbox.setTimeout 临时换成「同步执行」，否则 `setTimeout(reload, 900)`
         在这次断言里根本还没跑 → `reloads === 0` 无条件为真 = 假绿。 */
      const fire = (ev) => {
        let reloads = 0;
        const oR = sandbox.location.reload;
        const oT = sandbox.setTimeout;
        sandbox.location.reload = () => { reloads++; };
        sandbox.setTimeout = (fn) => { fn(); return 0; };
        try { listeners.forEach(fn => fn(Object.assign({ type: 'storage' }, ev))); }
        finally { sandbox.location.reload = oR; sandbox.setTimeout = oT; }
        return reloads;
      };

      const raw1 = JSON.stringify(Store.raw());
      const oToast = U.toast;
      let toasts = [];
      U.toast = function (msg) { toasts.push(String(msg)); return oToast.apply(U, arguments); };
      try {
        /* 正向对照：账号切换那条**必须**弹 toast、**必须**重载。
           没有这一条，下面「不弹 / 不重载」在桩失效时就是假绿。 */
        toasts = [];
        const nAcct = fire({ key: 'jobhunter.current.v1', oldValue: 'default', newValue: 'x' });
        ok('16.15C 正向对照：账号切换事件仍然整页重载', nAcct === 1, '重载 ' + nAcct + ' 次');
        ok('16.15C 正向对照：账号切换确实弹了 toast（证明桩接得住）', toasts.length >= 1,
          '捕到 ' + toasts.length + ' 条');

        toasts = [];
        const nBak = fire({ key: SYNC_KEY + '.bak', oldValue: 'x', newValue: raw1 });
        ok('16.15C ⛔ 收到 .bak 事件不再整页重载（旧代码在这里就 reload 了）',
          nBak === 0, '重载 ' + nBak + ' 次');
        ok('16.15C ⛔ 收到 .bak 事件不弹 toast（一次保存写两个 key，旧代码弹两条）',
          toasts.length === 0, '弹了 ' + toasts.length + ' 条：' + toasts.join(' | '));

        const ext2 = JSON.parse(raw1);
        ext2.jobs = (ext2.jobs || []).concat([{
          id: 'sync_ext_job_2', source: 'manual', title: '来自另一个标签页', company: '丙',
          industry: '', location: '', remote: false, salaryText: '', salaryMin: 0, salaryMax: 0,
          salaryMonths: 0, benefits: [], duties: [], reqDegree: '', reqYears: '', reqSkills: [],
          keywords: [], pros: [], cons: [], tags: [], flags: {}, notes: '', status: 'wish',
          createdAt: Date.now(), updatedAt: Date.now(),
        }]);
        const nReal = fire({ key: SYNC_KEY, oldValue: raw1, newValue: JSON.stringify(ext2) });
        ok('16.15C ⛔ 收到当前账号的 key 也不整页重载（改成就地软同步）',
          nReal === 0, '重载 ' + nReal + ' 次');
        ok('16.15C 软同步的数据已经就地在内存里生效',
          Store.jobs().some(j => j.id === 'sync_ext_job_2')) ;
        ok('16.15C ⛔ 整轮跨页同步一条 toast 都没弹（用户截图里叠了三层）',
          toasts.length === 0, '弹了 ' + toasts.length + ' 条：' + toasts.join(' | '));

        /* ④ 软同步之后再 flush 也必须是空转 —— 环才真的断了 */
        const origSet3 = localStorage.setItem;
        const wrote3 = [];
        localStorage.setItem = (k, v) => { wrote3.push(k); return origSet3.call(localStorage, k, v); };
        try { Store.flush(); } finally { localStorage.setItem = origSet3; }
        ok('16.15C ⛔ 软同步之后的 flush() 是空转（否则对端又会被触发）',
          wrote3.length === 0, '写了 ' + wrote3.length + ' 次：' + wrote3.slice(0, 4).join(','));

        Store.removeJob('sync_ext_job_2');
      } finally { U.toast = oToast; }
    }
  }

  /* ==================================================================
     【16.16】冲突台账不能被 migrate() 丢掉（读一下也不该把数据改脏）
     ------------------------------------------------------------------
     顺藤摸出来的真 bug：migrate() 是**重建对象**（白名单），它漏了 `conflicts`，
     而 blank() 里有 —— 于是界面增删改都正常、save() 也确实写进了 localStorage，
     但下次 load() 一过 migrate() 台账就没了，且毫无报错。
     更阴的是 ensureConflicts() 惰性补空数组 → 「读」变成「写」→ 任何一次
     flush() 都写盘 → 对端收到 storage 事件 → 跨标签页互相刷。
     ================================================================== */
  section('【16.16】冲突台账不能丢 + 读不该改脏');
  {
    /* ⛔ 不引用 16.15 里的 SYNC_KEY：那是 `const` 声明在另一个块里，块级作用域拿不到
       （第一次就这么炸的：SYNC_KEY is not defined）。 */
    const K16 = 'jobhunter.db.v1.' + Store.currentAccount();
    const pure = Store.migrate({
      jobs: [],
      conflicts: [{ id: 'cf_probe', jobId: 'j_probe', fields: [{ key: 'salaryText', old: 'a', new: 'b' }] }],
    });
    ok('16.16 ⛔ migrate() 保留 conflicts（漏了它 = 冲突台账每次刷新就消失）',
      Array.isArray(pure.conflicts) && pure.conflicts.length === 1,
      '实际 ' + JSON.stringify(pure.conflicts));

    /* 端到端：写进去 → 原样读回来 → 再 migrate → 还在不在 */
    Store.recordConflicts(
      { id: 'cf_e2e_job', title: '台账岗位', company: '丁', salaryText: '10-20K' },
      { id: 'cf_e2e_job', salaryText: '20-30K' }, 'unit');
    Store.flush();
    const round = Store.migrate(JSON.parse(localStorage.getItem(K16)));
    ok('16.16 端到端：落盘的冲突台账能重新加载回来（不是「存进去、读出来没了」）',
      (round.conflicts || []).some(c => c.jobId === 'cf_e2e_job'),
      '重载后的 jobId：' + JSON.stringify((round.conflicts || []).map(c => c.jobId)));

    /* ⛔ 只读访问不该改数据：否则「打开页面看一眼」本身就是一次写盘。
       ⚠️ 前置状态必须是「DB 里**根本没有** conflicts 字段」——那正是 migrate()
          漏掉 conflicts 时 load() 走出来的形态。若在已经有 conflicts 的 DB 上测，
          ensureConflicts() 无事可做 → 断言恒真 = **假绿**
          （变异「migrate() 再次漏掉 conflicts」第一次就是这么漏过去的）。
       做法：从磁盘上取回存档、删掉 conflicts 字段，再用 applyExternal 灌回内存，
       这一步等价于「用旧版本存档启动」——不会真的写盘，也不会污染别的用例。 */
    const legacy = JSON.parse(localStorage.getItem(K16));
    delete legacy.conflicts;
    ok('16.16 前置：造出的「旧版存档」里确实没有 conflicts 字段',
      !('conflicts' in legacy), '字段：' + Object.keys(legacy).join(','));

    Store.applyExternal(K16, JSON.stringify(legacy));   // 内存 DB = migrate(旧版存档)
    Store.flush();                                     // 基线对齐，这一步不计入

    const origSet4 = localStorage.setItem;
    const wrote4 = [];
    localStorage.setItem = (k, v) => { wrote4.push(k); return origSet4.call(localStorage, k, v); };
    try { Store.conflicts(); Store.conflictCount(); Store.flush(); }
    finally { localStorage.setItem = origSet4; }
    ok('16.16 ⛔ 读冲突台账不会把数据改脏（ensureConflicts 惰性补空数组的副作用）',
      wrote4.length === 0, '写了 ' + wrote4.length + ' 次：' + wrote4.join(','));
  }

  /* ==================================================================
     【16.17】备面材料的「保存入口」必须显眼、且点了就真存
     ------------------------------------------------------------------
     改之前的现状（用户截图里点的是行尾那个小字「🗎 备面材料」）：
       ① 页面顶部工具栏**只有**「＋ 新建面试」和提醒开关 —— 备面材料
          的入口只在**每一行末尾**一个 `btn xs`（11px 字）上，扫视时看不见；
       ② 唯一的保存入口是 AI 弹窗 `.mfoot` 里第 3 个**同权重**按钮
          （`重新生成 / 复制输出 / 保存到这场面试 / 关闭` 长得一样）；
       ③ 结果区往往好几屏，用户读完在底部随手点 ✕ —— 保存键在最底下的
          footer 里，整段内容白生成（这就是「生成了却没保存」的主路径）；
       ④ 生成期间那个按钮是灰的，用户不知道那就是保存键；
       ⑤ 保存后毫无痕迹，再打开看不出「这场已经有材料了」；
       ⑥ `openPrep` 那个弹窗**完全只读** —— 想改面试官备注 / 现场笔记 /
          复盘得关掉弹窗回列表点「编辑」，等于「保存入口找不到」。

     改后：结果区顶部一条 `position:sticky` 的保存条（三态 + 图标 + 文案），
           页面顶部工具栏前置 `💾 备面材料` 主按钮，`openPrep` 顶栏加
           `✏️ 编辑面试记录`。

     ⛔ 本组**逐跳断言**（发 → 入口 → 写盘 → 读回），只断言"源码里有
        setSaveState"是自证式断言 —— 把 `barBtn.onclick = doApply` 删掉、
        或把 `settled` 那道门去掉，照样能绿。
     ================================================================== */
  section('【16.17】备面材料保存入口：显眼 + 真落盘 + 状态一致');
  {
    /* --- ① 页面顶部工具栏必须有「💾 备面材料」主按钮，且排在第一位 --- */
    {
      App.go('interview');
      await tick();
      const topBtns = U.$$('#topActions button');
      const topTxt = topBtns.map(b => (b.textContent || '').trim());
      const prepIdx = topTxt.findIndex(t => t.indexOf('备面材料') >= 0);
      ok('16.17A 面试页顶部工具栏有「备面材料」入口（原来只在每行末尾的小字按钮上）',
        prepIdx >= 0, '顶栏按钮：' + topTxt.join(' / '));
      ok('16.17A ⛔ 它排在第一个（视线起点，不是排在最后要划过一排按钮才看到）',
        prepIdx === 0, '实际位置 ' + prepIdx + '，顺序：' + topTxt.join(' / '));
      ok('16.17A ⛔ 它是主按钮 pri（灰按钮扫视时会被跳过）',
        !!topBtns[prepIdx] && /(^|\s)pri(\s|$)/.test(topBtns[prepIdx].className),
        'class="' + (topBtns[prepIdx] ? topBtns[prepIdx].className : '?') + '"');
      ok('16.17A ⛔ 图标 + 文字标签同时有（不是只有一个 💾 图标，也不是纯文字）',
        prepIdx >= 0 && topTxt[prepIdx].indexOf('💾') >= 0 && topTxt[prepIdx].indexOf('备面材料') >= 0,
        '文案：' + (topTxt[prepIdx] || '?'));

      /* --- ② 静态：CSS 里保存条必须真的 sticky（否则「固定」是嘴上说说） --- */
      const css17 = fs.readFileSync(path.join(DIR, 'css', 'app.css'), 'utf8');
      const barRule = css17.match(/\.ai-savebar[^{]*\{([^}]*)\}/);
      ok('16.17A css 里有 .ai-savebar 规则', !!barRule);
      ok('16.17A ⛔ 保存条是 position:sticky（滚长结果时它必须留在原地）',
        !!barRule && /position:\s*sticky/.test(barRule[1]),
        barRule ? barRule[1].trim().slice(0, 160) : '没抓到规则');
      const prepRule = css17.match(/\.ai-prepbar[^{]*\{([^}]*)\}/);
      ok('16.17A ⛔ 只读材料弹窗的顶栏也是 sticky（长材料滚动时「编辑」入口要一直在）',
        !!prepRule && /position:\s*sticky/.test(prepRule[1]),
        prepRule ? prepRule[1].trim().slice(0, 160) : '没抓到规则');
      /* ⛔ 移动端必须**并进已有的 820 断点块**：另开一块的话，既有的
         「⛔ 820 断点里有 #topActions 的规则」会被非贪婪正则抓错块 → 当场红。 */
      const bp17 = css17.match(/@media \(max-width:\s*820px\)\s*\{([\s\S]*?)\n\}/);
      ok('16.17A 能定位到 820 断点块', !!bp17);
      ok('16.17A ⛔ 移动端规则在**同一个** 820 块里（另开一块会破坏既有断言）',
        !!bp17 && /\.ai-savebar/.test(bp17[1]) && /#topActions\s*\{[^}]*flex-wrap:\s*wrap/.test(bp17[1]),
        bp17 ? bp17[1].slice(0, 200) : '找不到断点块');
      ok('16.17A ⛔ 窄屏下保存按钮占满整行（不能被 wrap 挤成半宽、还落到第二行）',
        !!bp17 && /\.ai-savebar\s+\.ai-savebar-btn[^{]*\{[^}]*width:\s*100%/.test(bp17[1]),
        bp17 ? (bp17[1].match(/\.ai-savebar[^{]*\{[^}]*\}/g) || []).join(' ') : '');
    }

    /* --- ③ 真跑一次生成流程，逐跳断言保存入口 --- */
    const j17 = Store.jobs()[0];
    const iv17 = Store.addInterview({ jobId: j17.id, at: U.now() + 3 * 86400000, round: '二面（主管）' });
    const origRun17 = AI.runTemplate;
    AI.runTemplate = () => Promise.resolve({
      text: '',
      data: {
        selfIntro: '开场自我介绍：我做过三年短视频全流程。',
        questions: [
          { q: '为什么从上家离职', why: '看稳定性', a: '项目结束，主动交接' },
          { q: '你的数据是怎么来的', why: '看是否真做过', a: '自己跑后台统计' },
        ],
        askHr: ['有没有 HC 冻结期'],
        points: ['能独立出镜'],
        avoid: ['别说"随时到岗"'],
        questionsToCompany: ['团队多少人'],
      },
    });
    try {
      clearToasts();
      App.go('interview');
      await tick();
      /* ⚠️ 这里必须**多份简历**时也不该弹选择器干扰 —— 桩里 resumes 可能 >1，
         prepFor 会先弹 resumePicker。真跑它，断言完再处理。 */
      Views.interview.prepFor(j17.id, { interviewId: iv17.id, onSaved: App.refresh });
      await new Promise(r => setTimeout(r, 200));
      await tick();

      /* 若弹了简历选择器（Store.resumes().length > 1），选第一行关掉它再继续。
         ⚠️ resumePicker 是**点一行即返回**的形态（`.box.pointer`），没有「确定」按钮；
         但 jobPicker 那类有。两种形态都可能出现，所以这里必须容错：
         先试点行，点完若还有 footer 的确定按钮才点（无则说明已经关掉了）。
         以前直接 `mBtn('确定').click()` —— 在"点行即返回"的形态下拿到 null → 抛 TypeError，
         把整段后续断言全部吞掉（测试只报"异步测试抛异常"，看不出根因）。 */
      if (U.$('.mask .mfoot') || U.$('.mask .box.pointer')) {
        const pickBtns = U.$$('.mask .box.pointer');
        if (pickBtns.length) { pickBtns[0].click(); await tick(); }
        const okBtn = mBtn('确定');
        if (okBtn) { okBtn.click(); await tick(); }
        await new Promise(r => setTimeout(r, 220));
        await tick();
      }

      const modal17 = U.$('.mask .modal');
      ok('16.17B 前置：备面材料的 AI 弹窗真的打开了', !!modal17);
      if (modal17) {
        const mbody = modal17.querySelector('.mbody');
        const mfoot = modal17.querySelector('.mfoot');
        const bar = mbody ? mbody.querySelector('.ai-savebar') : null;

        /* --- 保存条的位置：在结果区顶部（内容容器的**第一个**子节点），不在 footer ---
           ⚠️ mbody 的直接子节点是那个无 class 的 `body` 容器（runAI 里
              `el('div', {}, [saveBar, statusLine, ...])`），保存条是它的第一个孩子。
              断言必须打到**这一层**：只查 `mbody.children[0] === bar` 会永远红。 */
        ok('16.17B ⛔ 结果区顶部有那条保存条（视线起点，不是塞在页脚）',
          !!bar, 'mbody 里没找到 .ai-savebar');
        const bodyBox = mbody ? mbody.children[0] : null;
        ok('16.17B ⛔ 它是结果容器的第一个子节点（结果正文排在它后面 ⇒ 滚动时先看到它）',
          !!bar && !!bodyBox && bodyBox.children[0] === bar,
          bodyBox ? ('结果容器子节点序：' + Array.prototype.map.call(bodyBox.children, c => c.className || '(无名div)').join(' | ')) : '无');
        ok('16.17B ⛔ 它不在 footer 里（footer 只有「重新生成/复制输出/保存/关闭」）',
          !!bar && !!(mfoot && mfoot.querySelector('.ai-savebar')) === false);
        ok('16.17B ⛔ 带 💾 图标（纯文字按钮在扫视时被跳过）',
          !!bar && bar.textContent.indexOf('💾') >= 0,
          bar ? bar.textContent.slice(0, 80) : '无');
        ok('16.17B ⛔ 文案里点明「保存到这场面试」（按钮自带动词，不是「应用」）',
          !!bar && bar.textContent.indexOf('保存到这场面试') >= 0,
          bar ? bar.textContent.slice(0, 120) : '无');

        /* --- 生成完成后的状态：可点 --- */
        const barBtn = bar ? bar.querySelector('.ai-savebar-btn') : null;
        ok('16.17B ⛔ 保存条上有一个真按钮（不是一段说明文字）', !!barBtn);
        ok('16.17B ⛔ 生成完成后可点（生成期间就该是灰的，这是"知道它是保存键"的关键）',
          !!barBtn && barBtn.disabled !== true,
          barBtn ? ('disabled=' + barBtn.disabled) : '无按钮');
        ok('16.17B ⛔ 状态文案提示内容已生成（不再是"正在生成…"骗人）',
          !!bar && bar.textContent.indexOf('已生成') >= 0,
          bar ? bar.textContent.slice(0, 120) : '无');

        /* --- ⛔ 逐跳：真点它 → onApply → updateInterview → save() → localStorage --- */
        ok('16.17B 前置：点之前这场面试确实还没有 prep（否则"点一下就存上了"是假象）',
          !Store.interview(iv17.id).prep, '已有：' + JSON.stringify(Store.interview(iv17.id).prep));

        const key17 = 'jobhunter.db.v1.' + Store.currentAccount();
        const origSet17 = localStorage.setItem;
        const wrote17 = [];
        localStorage.setItem = (k, v) => { wrote17.push(k); return origSet17.call(localStorage, k, v); };
        let clickedErr = null;
        try { if (barBtn) barBtn.click(); }
        catch (e) { clickedErr = e; }
        finally {
          /* ⛔⛔ **不能在这里就摘掉打桩** —— `Store.save()` 是**防抖 260ms** 的
             （`saveTimer = setTimeout(doIt, 260)`），点完立刻摘钩子必然数到 0 次。
             这就是 Phase C 记的「计数窗口只包到调用那一刻 = 恒 0」的同一种假绿。
             ⇒ 打桩必须**跨过防抖落盘**（await 340ms）再摘。 */
          await new Promise(r => setTimeout(r, 340));
          localStorage.setItem = origSet17;
        }
        ok('16.17B ⛔ 点顶部保存条不抛异常', !clickedErr, clickedErr ? (clickedErr.message + ' @ ' + (clickedErr.stack || '').split('\n')[1]) : '');
        await tick();

        /* 跳 1：内存 */
        const mem = Store.interview(iv17.id);
        ok('16.17B ⛔ 点一下 → Store 里 prep 写进去了（内存跳）',
          !!(mem && mem.prep) && String(mem.prep.selfIntro || '').indexOf('短视频全流程') >= 0,
          'prep=' + JSON.stringify(mem && mem.prep ? { s: String(mem.prep.selfIntro).slice(0, 20), q: (mem.prep.questions || []).length } : null));
        ok('16.17B ⛔ 面试官提问 / 评价要点 / 避雷 都按原结构存（数据结构一个字没改）',
          !!(mem && mem.prep) && Array.isArray(mem.prep.questions) && mem.prep.questions.length === 2
            && Array.isArray(mem.prep.askHr) && mem.prep.askHr.length === 1
            && Array.isArray(mem.prep.points) && mem.prep.points.length === 1
            && Array.isArray(mem.prep.avoid) && mem.prep.avoid.length === 1,
          mem && mem.prep ? ('keys=' + Object.keys(mem.prep).join(',')) : '无 prep');
        ok('16.17B ⛔ prepAt 也落了（"生成于"要能显示）', !!(mem && mem.prepAt), 'prepAt=' + (mem && mem.prepAt));

        /* 跳 2：真写盘 */
        ok('16.17B ⛔ 保存动作真的写到了 localStorage（不是只在内存里看着像）',
          wrote17.indexOf(key17) >= 0, '写了这些 key：' + wrote17.join(','));

        /* 跳 3：能从磁盘原样读回来（migrate 不吃掉它） */
        const disk17 = Store.migrate(JSON.parse(localStorage.getItem(key17)));
        const dIv = (disk17.interviews || []).filter(v => v.id === iv17.id)[0];
        ok('16.17B ⛔ 从 localStorage 重新读回来，prep 还在（存进去、读出来没丢）',
          !!(dIv && dIv.prep) && (dIv.prep.questions || []).length === 2,
          '磁盘上的 prep=' + JSON.stringify(dIv && dIv.prep ? { q: (dIv.prep.questions || []).length } : null));

        /* --- 保存后的反馈：条上留痕迹 + 两处状态一致 + 防连点 --- */
        const barAfter = modal17.querySelector('.ai-savebar');
        ok('16.17B ⛔ 保存后顶部条变「✅ 已保存」（留下痕迹，再打开看得出存过）',
          !!barAfter && barAfter.textContent.indexOf('已保存') >= 0,
          barAfter ? barAfter.textContent.slice(0, 120) : '无');
        ok('16.17B ⛔ 已保存后按钮禁用（防连点重复覆盖）',
          !!barAfter && barAfter.querySelector('.ai-savebar-btn').disabled === true,
          barAfter ? ('disabled=' + barAfter.querySelector('.ai-savebar-btn').disabled) : '无');
        /* ⛔ 两处保存入口共用 setSaveState ⇒ 不可能出现「上面说已保存、下面还能点」 */
        const footApply = mBtn('✅ 已保存') || null;
        ok('16.17B ⛔ footer 的保存按钮**同时**变成「✅ 已保存」且禁用（两处状态一致）',
          !!footApply && footApply.disabled === true,
          'footer 按钮：' + U.$$('.mask .mfoot button').map(b => (b.textContent || '').trim() + (b.disabled ? '(禁用)' : '')).join(' / '));

        /* 再点一次不应重复写（doApply 的第三道门）。
           ⛔ 同样要跨过 260ms 防抖再数，否则「没写」是因为还没到落盘时间 = 恒真。 */
        const writesBefore = wrote17.length;
        const barBtn2 = barAfter.querySelector('.ai-savebar-btn');
        localStorage.setItem = (k, v) => { wrote17.push(k); return origSet17.call(localStorage, k, v); };
        try { barBtn2.click(); await new Promise(r => setTimeout(r, 340)); }
        catch (e) { /* noop */ }
        finally { localStorage.setItem = origSet17; }
        ok('16.17B ⛔ 已保存后再点不会重复写（saveState===\'done\' 那道门）',
          wrote17.length === writesBefore, '多写了 ' + (wrote17.length - writesBefore) + ' 次');

        /* --- ④ 只读弹窗顶栏必须有「编辑面试记录」入口（原来整个弹窗只读） --- */
        U.closeAllModals();
        await tick();
        Views.interview.openPrep(iv17.id);
        await tick();
        const prepModal = U.$('.mask .modal');
        const prepbar = prepModal ? prepModal.querySelector('.ai-prepbar') : null;
        ok('16.17C ⛔ 只读材料弹窗顶部有 .ai-prepbar 顶栏', !!prepbar);
        ok('16.17C ⛔ 顶栏带「✏️ 编辑面试记录」（面试官备注/现场笔记/复盘原来在这里无处可改）',
          !!prepbar && prepbar.textContent.indexOf('编辑面试记录') >= 0,
          prepbar ? prepbar.textContent.slice(0, 120) : '无');
        ok('16.17C ⛔ 顶栏带「↻ 重新生成」（重新生成后仍要能从顶部那条保存）',
          !!prepbar && prepbar.textContent.indexOf('重新生成') >= 0);
        ok('16.17C ⛔ 顶栏是内容容器的第一个子节点（视线起点）',
          !!prepbar && prepModal.querySelector('.mbody').children[0].children[0] === prepbar,
          prepbar ? ('子节点序：' + Array.prototype.map.call(prepModal.querySelector('.mbody').children[0].children, c => c.className || '(无名)').join(' | ')) : '无');
        ok('16.17C ⛔ 编辑按钮是真能点的（点了会打开表单弹窗，不是死按钮）',
          !!prepbar && !!prepbar.querySelector('button'));
        const editBtn = prepbar ? Array.prototype.filter.call(prepbar.querySelectorAll('button'),
          b => (b.textContent || '').indexOf('编辑面试记录') >= 0)[0] : null;
        /* ⚠️ 判据不是「弹窗数变 2」：onclick 是 `m.close(); openForm(...)` ——
           **先关掉自己**再开表单，栈里始终只有 1 个。要判的是
           「关掉只读弹窗后，出现了带面试官/现场笔记字段的**表单**」。 */
        let formTxt = '';
        if (editBtn) {
          try { editBtn.click(); } catch (e) { /* noop */ }
          await tick();
          await tick();
          const forms = U.$$('.mask .modal');
          formTxt = forms.map(f => (f.textContent || '')).join(' ¦ ');
        }
        ok('16.17C ⛔ 点「编辑面试记录」真的打开了编辑表单（面试官备注/笔记/复盘在那里保存）',
          formTxt.indexOf('面试官') >= 0 && formTxt.indexOf('复盘') >= 0,
          '弹窗文本前 200：' + formTxt.slice(0, 200));
      }
    } finally {
      AI.runTemplate = origRun17;
      U.closeAllModals();
      await tick();
    }

    /* --- ⑤ 反证：把保存条的 onclick 拆掉，断言必须红（否则上面全是自证） --- */
    {
      const srcC = fs.readFileSync(path.join(DIR, 'js', 'components.js'), 'utf8');
        ok('16.17D ⛔ 顶部条按钮真的接到了同一个 doApply（源码层面）',
        /barBtn\.onclick\s*=\s*doApply/.test(srcC) && /bApply\s*=\s*btn\(applyLabel,\s*'pri',\s*doApply\)/.test(srcC),
        'barBtn.onclick=' + (/barBtn\.onclick\s*=\s*doApply/.test(srcC)) +
        ' bApply=' + (/bApply\s*=\s*btn\(applyLabel,\s*'pri',\s*doApply\)/.test(srcC)));
      /* ⛔⛔ 这条是**真机测试查出来的真缺陷**（不是预防性加的）：
         真机第一版断言「滚到底后保存条仍在视口里」红了 —— bar.top = -2071。
         根因：包着结果的普通 div 就是 sticky 的**包含块**，它跟内容一样高，
         滚到接近底部时它的底边进入视口，bar 就被顶出去了。
         修法是给它 `display:contents`（不生成盒子 ⇒ 包含块上浮成 .mbody 滚动容器）。
         真机复测：从顶滚到底 bar.top 恒定 90，全程吸住。
         ⚠️ 桩测查不出这个（没有布局引擎），所以只能用源码钉住 ——
            改回普通 div，真机那 3 条会红，这里也会红。 */
      ok('16.17D ⛔⛔ 包住保存条/结果的 div 是 display:contents（sticky 包含块问题）',
        /var body = el\('div',\s*\{\s*style:\s*'display:contents'\s*\},/.test(srcC),
        'body 容器声明：' + (srcC.match(/var body = el\('div',[^,]*,/) || ['?'])[0]);
      const srcI = fs.readFileSync(path.join(DIR, 'js', 'view-interview.js'), 'utf8');
      ok('16.17D ⛔ prepFor 传了 saveHint（条上文案要说清「存进这场面试」而不是含糊的「存下来」）',
        /saveHint:\s*'这场面试'/.test(srcI));
      ok('16.17D ⛔ prepFor 仍走 Store.updateInterview + prep/prepAt（保存逻辑没被改）',
        /onApply:\s*function\s*\(\s*data\s*\)[\s\S]*?Store\.updateInterview\(iv\.id,/.test(srcI)
        && /prep:\s*\{[\s\S]*?resumeId:/.test(srcI)
        && /prepAt:\s*U\.now\(\)/.test(srcI),
        'updateInterview=' + /Store\.updateInterview\(iv\.id,/.test(srcI)
        + ' prepAt=' + /prepAt:\s*U\.now\(\)/.test(srcI));
    }
    Store.removeInterview(iv17.id);
  }

  /* ==================================================================
     【17】《功能与体验优化建议》本轮落地
     —— 待跟进 / 批量操作 / 公司聚合 / 简历导出 / AI 面试模拟器
        + 筛选汇总条 / 详情分组 / 删除可撤销 / 未保存提示 / 备份提醒
     ================================================================== */
  const { FollowUp, InterviewSim, ResumeDoc } = sandbox;
  const jobsView = () => Views.jobs;
  const F = Views.jobs.filters;
  const SEL = Views.jobs.selection;
  const viewText = () => (U.$('#view') || {}).textContent || '';

  /* --- 17.1 数据层：批量改字段只落盘一次 --- */
  {
    const ids = Store.jobs().slice(0, 3).map(j => j.id);
    let fired = 0;
    const un = Store.subscribe(() => { fired++; });
    const n = Store.updateJobs(ids, { favorite: true });
    un();
    eq('updateJobs 返回改动的条数', n, ids.length);
    ok('updateJobs 让每个岗位都改了', ids.every(id => Store.job(id).favorite === true));
    eq('批量改只广播一次（不是每条一次）', fired, 1);
    ok('updateJobs 传空数组 → 0 条、不广播',
      (() => { let f2 = 0; const u2 = Store.subscribe(() => { f2++; }); const r = Store.updateJobs([], { favorite: false }); u2(); return r === 0 && f2 === 0; })());
  }

  /* --- 17.2 数据层：标签改名 / 摘掉 --- */
  {
    const j1 = Store.jobs()[0], j2 = Store.jobs()[1];
    Store.updateJob(j1.id, { tags: ['远程', '急招'] });
    Store.updateJob(j2.id, { tags: ['远程', '稳定'] });
    Store.renameTag('远程', '支持远程');
    ok('改名后旧标签没了', (Store.allTags().some(t => t.tag === '远程')) === false);
    ok('改名后新标签出现在两个岗位上',
      Store.job(j1.id).tags.indexOf('支持远程') >= 0 && Store.job(j2.id).tags.indexOf('支持远程') >= 0);
    ok('改名不动其它标签', Store.job(j2.id).tags.indexOf('稳定') >= 0);

    Store.dropTag('支持远程');
    ok('摘掉标签后从所有岗位移除',
      Store.job(j1.id).tags.indexOf('支持远程') < 0 && Store.job(j2.id).tags.indexOf('支持远程') < 0);
    ok('摘掉一个标签不影响别的', Store.job(j2.id).tags.indexOf('稳定') >= 0);
  }

  /* --- 17.3 数据层：稍后提醒 --- */
  {
    const k = 'unit-snooze:' + Store.jobs()[0].id;
    ok('没设稍后时不处于稍后状态', Store.isSnoozed(k) === false);
    Store.snooze(k, 3);
    ok('设了稍后 → 处于稍后状态', Store.isSnoozed(k) === true);
    Store.snooze(k, -1);                       // 负天数 = 立刻过期
    ok('过期后自动不再是稍后', Store.isSnoozed(k) === false);
    Store.snooze(k, 3); Store.wakeUp(k);
    ok('wakeUp 立刻解除稍后', Store.isSnoozed(k) === false);
  }

  /* --- 17.4 数据层：导出台账 --- */
  {
    Store.setSetting('backup.lastExportAt', null);
    eq('从没导出过时 daysSinceExport 返回 null（不是 0、不是 -1）', Store.daysSinceExport(), null);
    Store.markExported();
    eq('导出当天算 0 天', Store.daysSinceExport(), 0);
    Store.setSetting('backup.lastExportAt', U.now() - 9 * 86400000);
    eq('9 天前导出过一次 → 9 天', Store.daysSinceExport(), 9);
  }

  /* --- 17.5 U.dirtyGuard：没保存的修改要拦一次 --- */
  {
    let v;
    const g = U.dirtyGuard(() => v);
    ok('还没 mark 时不脏（否则一打开弹窗就拦人）', g.isDirty() === false);
    ok('还没 mark 时 check 放行（不确认）', g.check() === true);
    v = 'a';
    g.mark();
    ok('mark 之后立刻是干净的', g.isDirty() === false);
    v = 'b';
    ok('改了值就算脏', g.isDirty() === true);

    // 桩里 confirm 恒为 true → 脏时 check 应该放行（用户点了"确定放弃"）
    sandbox.confirm = () => true;
    ok('脏 + 用户确认放弃 → 放行', g.check() === true);
    sandbox.confirm = () => false;
    ok('脏 + 用户取消 → 拦住这次关闭', g.check() === false);
    sandbox.confirm = () => true;
    g.mark();
    ok('再 mark 一次回到干净', g.isDirty() === false);

    // openModal 的否决链路（beforeClose 返回 false 时弹窗必须留着）
    const gu = U.openModal({ title: '守卫测试', body: 'x', beforeClose: () => false });
    await tick();
    ok('弹窗开出来了', !!U.$('.mask'));
    U.closeAllModals();
    await tick();
    eq('beforeClose 返回 false → 连 closeAllModals 也关不掉（守卫真的生效）', U.$$('.mask').length, 1);
    gu.close(true);
    await tick();
    eq('显式 close(true) 能绕过守卫（「保存」按钮走的就是这条路）', U.$$('.mask').length, 0);

    // 持续否决的守卫不能把整页锁死 —— 所以程序化跳页要 force 关
    U.openModal({ title: '守卫测试2', body: 'x', beforeClose: () => false });
    await tick();
    App.go('dashboard');
    await tick();
    eq('跳页时强制关掉弹窗（否则一个否决型守卫会把整页卡住）', U.$$('.mask').length, 0);
    App.go('jobs');
    await tick();

    // getValues 抛异常时不能把用户锁死在弹窗里
    const bad = U.dirtyGuard(() => { throw new Error('boom'); });
    bad.mark();
    ok('取值函数抛异常时按"不脏"处理（不能锁死弹窗）', bad.check() === true);

    /* 真表单也要接上：简历编辑弹窗改了内容再关，应该问一句。
       ⚠️ 必须用「点 ✕」来关，不能用 closeAllModals()：
          点 ✕ 时浏览器会把 MouseEvent 当第一个实参传进 close(event)，
          而 close 的第一个形参恰好是 skipOnClose —— 一旦写成 `onclick: close`，
          就会把事件对象当成"跳过守卫"，守卫被静默绕过。
          真机上就是这么漏掉的（桩的 click() 会传事件，所以桩也照得出来，
          前提是真的去点 ✕ 而不是调 closeAllModals）。 */
    const cv0 = Store.resumes()[0];
    ok('测试数据里有简历（否则未保存提示测不到）', !!cv0);
    if (cv0) {
      let asked = 0;
      sandbox.confirm = () => { asked++; return false; };
      Views.resume.openResumeForm(cv0.id);
      await tick();
      const ta = (U.$$('.mask textarea') || [])[0];
      const xBtn = U.$('.mask .x');
      ok('简历表单里有内容框', !!ta);
      ok('弹窗标题栏有 ✕ 关闭按钮', !!xBtn);
      if (ta && xBtn) {
        ta.value = ta.value + '（临时改的）';
        if (ta._fire) ta._fire('input');
        xBtn.click();
        await tick();
        ok('改了内容点 ✕ → 会拦一次问"要不要放弃"', asked === 1, '被调用 ' + asked + ' 次');
        eq('用户选了"不放弃" → 弹窗留着（内容没丢）', U.$$('.mask').length, 1);
        ok('内容确实还在', (U.$$('.mask textarea')[0] || {}).value === ta.value);

        sandbox.confirm = () => true;
        U.$('.mask .x').click();
        await tick();
        eq('用户选了"放弃" → 弹窗才关掉', U.$$('.mask').length, 0);
      }
      sandbox.confirm = () => true;
      U.closeAllModals(true);
      await tick();
    }

    /* 干净没改过就点 ✕：不该打扰用户（守卫不能变成"每次关窗都问"） */
    if (cv0) {
      let asked2 = 0;
      sandbox.confirm = () => { asked2++; return true; };
      Views.resume.openResumeForm(cv0.id);
      await tick();
      U.$('.mask .x').click();
      await tick();
      eq('原样打开又原样关掉 → 不该弹确认框', asked2, 0);
      eq('弹窗正常关掉', U.$$('.mask').length, 0);
      sandbox.confirm = () => true;
    }
  }

  /* --- 17.6 浮层菜单 --- */
  {
    const anchor = U.el('button', { text: '锚点' });
    U.$('#view').appendChild(anchor);
    let clicked = 0;

    ok('空 items → 不渲染菜单', U.menu(anchor, []) === null && !U.$('.menu'));

    U.menu(anchor, [
      { icon: '✎', text: '编辑字段', onClick: () => { clicked++; } },
      { divider: true },
      { text: '删除这个岗位', danger: true, onClick: () => { clicked++; } },
    ]);
    ok('菜单渲染出来了', !!U.$('.menu'));
    eq('菜单项数（divider 不算项）', U.$$('.menu .mi').length, 2);
    eq('divider 渲染成 .mdiv', U.$$('.menu .mdiv').length, 1);
    ok('危险项带 danger 样式', U.$$('.menu .mi.danger').length === 1);

    U.$$('.menu .mi')[0].click();
    eq('点菜单项会执行回调', clicked, 1);
    ok('点菜单项后菜单自动收掉', !U.$('.menu'));

    U.menu(anchor, [{ text: 'A' }]);
    ok('再开一次', !!U.$('.menu'));
    U.menu(anchor, [{ text: 'A' }]);
    ok('再点同一个锚点 → 开关式收起', !U.$('.menu'));

    U.menu(anchor, [{ text: 'A' }]);
    U.closeMenu();
    ok('closeMenu 能关掉', !U.$('.menu'));
    anchor.parentNode.removeChild(anchor);
  }

  /* --- 17.7 筛选条件汇总条 --- */
  {
    App.go('jobs');
    Store.jobs().forEach(j => Store.updateJob(j.id, { archived: false }));
    F.kw = ''; F.source = ''; F.status = ''; F.salary = ''; F.tag = ''; F.fav = false; F.archived = false; F.sort = 'new';
    App.go('jobs');
    ok('没有任何筛选时不显示汇总条', !U.$('#view .fbar'));

    F.kw = '运营'; F.salary = '10-20';
    App.go('jobs');
    ok('有筛选时出现汇总条', !!U.$('#view .fbar'));
    ok('汇总条写明了「已筛选」', viewText().indexOf('已筛选') >= 0);
    ok('汇总条里有关键词条件', viewText().indexOf('关键词：运营') >= 0);
    eq('两个硬条件 → 两个 chip', U.$$('#view .fbar .tag').length, 2);
    ok('硬条件用 brand 样式（不是排序那种 .line）', U.$$('#view .fbar .tag.brand').length === 2);
    // chip 内部是拼出来的 html（桩不会把它解析成子元素），所以查源码而不是查 DOM
    ok('每个 chip 都带 ✕ 可以单独摘掉',
      U.$$('#view .fbar .tag').every(t => (t.innerHTML || '').indexOf('class="x"') >= 0));

    // 点 chip 只摘掉它自己
    U.$$('#view .fbar .tag')[0].click();
    await tick();
    eq('点第一个 chip → 关键词被清掉', F.kw, '');
    eq('点第一个 chip 不影响薪资条件', F.salary, '10-20');

    // 排序不算"筛选"，标签文案要区分开
    F.kw = ''; F.salary = ''; F.sort = 'score';
    App.go('jobs');
    ok('只调排序时标签写「排序」而不是「已筛选」',
      U.$('#view .fbar').textContent.indexOf('排序') >= 0 &&
      U.$('#view .fbar').textContent.indexOf('已筛选') < 0);
    ok('排序 chip 用 .line 样式（和硬条件区分）', U.$$('#view .fbar .tag.line').length === 1);

    U.$$('#view .fbar button').filter(b => (b.textContent || '').indexOf('清除全部') >= 0)[0].click();
    await tick();
    eq('「✕ 清除全部」把排序也恢复了', F.sort, 'new');
    ok('清完之后汇总条消失', !U.$('#view .fbar'));
    App.go('jobs');
  }

  /* --- 17.8 视图切换 + 偏好记忆 --- */
  {
    localStorageMap.delete('jh.jobs.pref');
    F.view = 'card'; F.kw = ''; App.go('jobs');
    ok('卡片视图渲染出 .job-list', !!U.$('#view .job-list'));

    // 偏好是靠点按钮写进去的（直接改 F.view 不落盘 —— 不落盘是刻意的：
    // 只有用户主动切视图才值得记住）
    const viewBtn = t => U.$$('#view .seg button').filter(b => (b.textContent || '').indexOf(t) >= 0)[0] || null;
    ok('筛选条里有 3 个视图切换按钮', U.$$('#view .seg button').length === 3);
    ok('筛掉了「卡片 / 紧凑列表 / 按公司」三种',
      ['卡片', '紧凑列表', '按公司'].every(x => !!viewBtn(x)));
    viewBtn('紧凑列表').click();
    await tick();
    eq('点视图按钮 → 状态切到 table', F.view, 'table');
    ok('紧凑列表视图渲染出 table.tb', !!U.$('#view table.tb'));
    ok('紧凑列表下不再渲染卡片墙', !U.$('#view .job-list'));

    const raw = localStorageMap.get('jh.jobs.pref');
    ok('视图偏好写进了 localStorage', !!raw);
    const pref = JSON.parse(raw || '{}');
    eq('偏好里记了视图', pref.view, 'table');
    eq('偏好里记了排序', pref.sort, 'new');
    ok('偏好里【没有】筛选条件（否则下次打开看到空列表却不知为何空）',
      !('kw' in pref) && !('salary' in pref) && !('status' in pref));

    viewBtn('按公司').click();
    await tick();
    eq('点「按公司」→ 状态切到 company', F.view, 'company');
    ok('公司视图渲染出折叠分组', U.$$('#view .grp-co').length > 0);
    ok('公司分组里列出了岗位行', U.$$('#view .co-row').length > 0);
    ok('公司分组 summary 给了「N 个岗位」', viewText().indexOf('个岗位') >= 0);
    ok('公司分组底部有「只看这家公司」', viewText().indexOf('只看这家公司') >= 0);

    // 刷新页面后能读回来
    eq('偏好能被读回（restorePref 认这个 key）',
      JSON.parse(localStorageMap.get('jh.jobs.pref')).view, 'company');

    viewBtn('卡片').click();
    await tick();
    eq('切回卡片视图', F.view, 'card');
  }

  /* --- 17.9 批量操作 --- */
  {
    // 先确保有一批未收藏、未归档的岗位，且当前没有筛选
    F.kw = ''; F.source = ''; F.status = ''; F.salary = ''; F.tag = ''; F.fav = false; F.archived = false; F.sort = 'new';
    F.view = 'card';
    const pool = Store.jobs().filter(j => !j.archived);
    Store.updateJobs(pool.map(j => j.id), { favorite: false, archived: false });
    App.go('jobs');

    ok('没进批量模式时不显示批量条', !U.$('#view .bbar'));
    ok('列表头有「批量操作」入口', viewText().indexOf('批量操作') >= 0);

    SEL.on = true; SEL.ids = pool.slice(0, 2).map(j => j.id);
    App.go('jobs');
    ok('进入批量模式后出现批量条', !!U.$('#view .bbar'));
    ok('批量条写了已选数量', U.$('#view .bbar').textContent.indexOf('已选 2 个') >= 0);
    eq('批量模式下卡片显示勾选框', U.$$('#view .job .pick').length, pool.length);
    ok('已选中的卡片带 picked 样式', U.$$('#view .job.picked').length === 2);

    const barBtn = t => U.$$('#view .bbar button').filter(b => (b.textContent || '').indexOf(t) >= 0)[0] || null;

    barBtn('全选本页').click();
    await tick();
    eq('「全选本页」选中当前筛选下的全部岗位', SEL.ids.length, pool.length);

    barBtn('反选').click();
    await tick();
    eq('「反选」在当前全选状态下变空', SEL.ids.length, 0);

    barBtn('清空').click();
    await tick();
    eq('「清空」把选中清掉', SEL.ids.length, 0);

    // 收藏
    SEL.ids = pool.slice(0, 3).map(j => j.id);
    App.go('jobs');
    barBtn('收藏').click();
    await tick();
    ok('批量收藏生效', SEL.ids.every(id => Store.job(id).favorite === true));
    ok('批量收藏后按钮变成「取消收藏」',
      U.$$('#view .bbar button').some(b => (b.textContent || '').indexOf('取消收藏') >= 0));

    // 归档
    App.go('jobs');
    barBtn('归档').click();
    await tick();
    ok('批量归档生效', SEL.ids.every(id => Store.job(id).archived === true));

    // 一个都不选也要给提示（而不是静默失败）
    clearToasts();
    App.go('jobs');
    SEL.ids = [];
    barBtn('收藏').click();
    await tick();
    ok('没选中任何岗位时点批量操作会给提示',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('选中') >= 0));

    // 批量删除也要可撤销
    clearToasts();
    // ⚠️ Store.jobs() 不含归档岗位，所以这里必须挑"在库"的来算增量，
    //    否则删掉两个归档岗位，总数一点没变，断言会莫名其妙地红。
    const remain = Store.jobs().slice(0, 2).map(j => j.id);
    SEL.ids = remain.slice();
    App.go('jobs');
    const beforeN = Store.jobs().length;
    barBtn('删除').click();
    await tick();
    eq('批量删除后岗位数减少', Store.jobs().length, beforeN - 2);
    ok('被删的两条确实不在了', remain.every(id => !Store.job(id)));
    ok('批量删除也给了撤销入口', !!undoBtn());
    undoBtn().click();
    await tick();
    eq('批量删除可以整体撤销', Store.jobs().length, beforeN);

    SEL.on = false; SEL.ids = [];
    Store.updateJobs(pool.map(j => j.id), { favorite: false, archived: false });
    App.go('jobs');
  }

  /* --- 17.9b 一键清空岗位库 --- */
  {
    // 先清干净筛选，回到无筛选的岗位库
    F.kw = ''; F.source = ''; F.status = ''; F.salary = ''; F.tag = ''; F.fav = false; F.archived = false; F.sort = 'new';
    F.fit = ''; F.hideDrop = false; F.pref = false;
    App.go('jobs');

    const beforeAll = Store.jobs({ includeArchived: true }).length;
    const beforeActive = Store.jobs().length;
    // 造一条归档岗位，验证「一键清空」会连归档一起删（而不是只删在库的）
    const arch = Store.jobs()[0];
    Store.toggleJobFlag(arch.id, 'archived', true);
    App.go('jobs');

    ok('列表头有「一键清空」入口', viewText().indexOf('一键清空') >= 0);
    const clearBtn = U.$$('#view button').filter(b => (b.textContent || '').indexOf('一键清空') >= 0)[0] || null;
    ok('「一键清空」按钮真实渲染出来了', !!clearBtn);

    // 点它 → 弹危险确认框（主按钮「全部删除」+「取消」）
    clearBtn.click();
    await tick();
    ok('点「一键清空」弹出确认框', !!U.$('.mask'));
    ok('确认框主按钮写「全部删除」',
      U.$$('.mask .mfoot button').some(b => (b.textContent || '').indexOf('全部删除') >= 0));

    // 点「取消」→ 弹窗关、岗位一个没少
    anyBtn('取消').click();
    await tick();
    eq('点「取消」后弹窗关闭', U.$$('.mask').length, 0);
    eq('取消后岗位没少', Store.jobs({ includeArchived: true }).length, beforeAll);

    // 再来一次，这次真确认 → 全库清空（含归档）、连带投递/面试、可撤销
    clearToasts();
    U.$$('#view button').filter(b => (b.textContent || '').indexOf('一键清空') >= 0)[0].click();
    await tick();
    anyBtn('全部删除').click();
    await tick();
    eq('确认后岗位库清空（含归档）', Store.jobs({ includeArchived: true }).length, 0);
    ok('清空后给了撤销入口', !!undoBtn());

    // 撤销 → 全部回来（含归档那条）
    undoBtn().click();
    await tick();
    eq('撤销后全部岗位回来', Store.jobs({ includeArchived: true }).length, beforeAll);
    ok('归档那条也回来了', !!Store.job(arch.id) && Store.job(arch.id).archived === true);

    // 恢复到「不归档」状态，别影响后面的用例
    Store.toggleJobFlag(arch.id, 'archived', false);
    App.go('jobs');
  }

  /* --- 17.10 标签管理面板 --- */
  {
    const a = Store.jobs()[0], b = Store.jobs()[1];
    Store.updateJob(a.id, { tags: ['重点', '急招'] });
    Store.updateJob(b.id, { tags: ['重点'] });
    App.go('jobs');
    Views.jobs.filters.tag = '';
    Views.jobs.tagManager();
    await tick();
    ok('标签管理面板打开了', !!U.$('.mask'));
    ok('面板里列出了标签名', U.$('.mask').textContent.indexOf('重点') >= 0);
    ok('面板里给了「只看这些」「改名」「删除」三个动作',
      ['只看这些', '改名', '删除'].every(x => U.$('.mask').textContent.indexOf(x) >= 0));
    ok('每个标签显示了用它的岗位数', U.$('.mask').textContent.indexOf('个岗位在用') >= 0);
    ok('面板里说明了改名会自动合并（不会产生重复标签）',
      U.$('.mask').textContent.indexOf('合并') >= 0);
    U.closeAllModals();
    await tick();
  }

  /* --- 17.11 待跟进：聚合口径 --- */
  {
    Store.applications().slice().forEach(a => Store.removeApplication(a.id));
    const j = Store.jobs().find(x => !x.archived);
    const app = Store.addApplication({
      jobId: j.id, status: 'applied',
      appliedAt: U.now() - 12 * 86400000,           // 投了 12 天没动静
    });

    const items = FollowUp.build();
    const stale = items.filter(x => x.cat === 'staleApplied' && x.appId === app.id);
    eq('投了 12 天没动静 → 出现在「投递后没动静」里', stale.length, 1);
    ok('这一条带上建议动作', !!stale[0].act);
    ok('这一条带了「几天」', stale[0].days >= 12);
    eq('count() 与 build().length 同口径', FollowUp.count(), items.length);

    // 稍后提醒要把噪音压下去
    Store.snooze(stale[0].key, 3);
    ok('「稍后提醒」后这条不再出现',
      FollowUp.build().filter(x => x.key === stale[0].key).length === 0);
    Store.wakeUp(stale[0].key);
    ok('wakeUp 后这条回来',
      FollowUp.build().filter(x => x.key === stale[0].key).length === 1);

    // 归档的岗位不该出现在待跟进里
    Store.toggleJobFlag(j.id, 'archived', true);
    ok('已归档的岗位不参与待跟进',
      FollowUp.build().filter(x => x.jobId === j.id).length === 0);
    Store.toggleJobFlag(j.id, 'archived', false);

    // 类别顺序 = 紧急度顺序
    eq('第一个类别是最紧急的「面试快到了」', FollowUp.CATS[0].id, 'interviewSoon');
    ok('类别都带图标 / 名称 / 配色',
      FollowUp.CATS.every(c => c.icon && c.name && c.cls));
    ok('阈值有默认值', !!FollowUp.DAYS.appliedDays && !!FollowUp.DAYS.favoriteDays);

    // scoreJob 要和 build 同口径：待跟进页说该跟，岗位库排序就不能把它排最后
    ok('该跟进的岗位 scoreJob > 0', FollowUp.scoreJob(Store.job(j.id)) > 0);
    ok('归档岗位 scoreJob = 0（归档等于不跟了）',
      (() => {
        Store.toggleJobFlag(j.id, 'archived', true);
        const s = FollowUp.scoreJob(Store.job(j.id));
        Store.toggleJobFlag(j.id, 'archived', false);
        return s === 0;
      })());

    // 页面能真渲染出来
    App.go('followup');
    const topText = (U.$('#topActions') || {}).textContent || '';
    ok('待跟进页正常渲染（没被兜底卡顶掉）', viewText().indexOf('渲染出错') < 0);
    ok('待跟进页给了「稍后提醒」的入口（把噪音压下去）',
      topText.indexOf('稍后') >= 0 || viewText().indexOf('稍后') >= 0);
    ok('待跟进页顶部有调阈值的入口', topText.indexOf('阈值') >= 0 || viewText().indexOf('阈值') >= 0);
    ok('待跟进页顶部能把当前列表整体推后', topText.indexOf('全部稍后') >= 0);
    ok('待跟进页没渲染成报错页', viewText().indexOf('渲染出错') < 0);
    ok('导航徽标上能显示待跟进条数', (() => {
      const n = U.$('[data-cnt="followup"]');
      return !!n && n.textContent === String(FollowUp.count());
    })());

    Store.removeApplication(app.id);
    App.go('jobs');
  }

  /* --- 17.12 AI 面试模拟器 --- */
  {
    const j = Store.jobs().find(x => !x.archived);
    const oldKey = AI.cfg().apiKey;

    // 没配 Key 要拦住并给出去处，不能开个空窗
    Store.setSetting('ai.apiKey', '');
    clearToasts();
    ok('没配 Key 时 AI.ready() 为 false', AI.ready() === false);
    InterviewSim.start(j.id);
    await tick();
    ok('没配 Key 时明确提示要去设置页填 Key，而不是打开一个空弹窗',
      !U.$('.mask') && U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('API Key') >= 0));

    // 配好之后应该先出「开场设置」
    Store.setSetting('ai.apiKey', 'sk-test');
    ok('配好 Key 后 AI.ready() 为 true', AI.ready() === true);
    InterviewSim.start(j.id);
    await tick();
    const t1 = (U.$('.mask') || {}).textContent || '';
    ok('模拟面试先出「开场设置」弹窗', t1.indexOf('模拟面试') >= 0);
    ok('设置里有「模拟哪一轮」', t1.indexOf('模拟哪一轮') >= 0);
    ok('设置里有「用哪份简历」', t1.indexOf('用哪份简历') >= 0);
    ok('设置里有「大概问几题」', t1.indexOf('大概问几题') >= 0);
    ok('说明了 AI 不会中途点评（避免用户误解为"它怎么不评价"）',
      t1.indexOf('不会点评') >= 0 || t1.indexOf('留到最后') >= 0);
    ok('重申了不代投递的边界', t1.indexOf('不代发消息') >= 0 || t1.indexOf('不代投递') >= 0);
    U.closeAllModals();
    await tick();

    // 复盘渲染
    const fakeReview = {
      score: 72,
      verdict: '表达清楚，但缺数字。',
      highlights: ['结构完整', '语气自然'],
      problems: ['成果没有量化', '反问环节太客套'],
      perQuestion: [
        { q: '介绍一下你最有成就感的项目', comment: '流水账', better: '用 STAR：背景一句、动作两句、结果给数字。', tag: '明显失分' },
        { q: '为什么想做短视频运营', comment: '动机可信', better: '补一句"我做过什么验证过这个判断"。', tag: '一般' },
      ],
      nextSteps: ['给每个项目补一个数字', '准备 3 个反问'],
    };
    const transcript = [
      { q: '介绍一下你最有成就感的项目', a: '我做过一个账号。' },
      { q: '为什么想做短视频运营', a: '因为我喜欢。' },
    ];
    const node = InterviewSim._reviewNode(fakeReview, transcript);
    const html = node.textContent || '';
    ok('复盘里有综合得分', html.indexOf('72') >= 0);
    ok('复盘里有总评', html.indexOf('表达清楚') >= 0);
    ok('复盘里有「做得好的」', html.indexOf('做得好的') >= 0);
    ok('复盘里有「最需要改的」', html.indexOf('最需要改的') >= 0);
    ok('复盘里有逐题点评', html.indexOf('逐题点评') >= 0);
    ok('逐题点评带了更好的答法骨架', html.indexOf('更好的答法') >= 0);
    ok('逐题点评里回显了当时的回答', html.indexOf('我做过一个账号') >= 0);
    ok('复盘里有「接下来重点准备」', html.indexOf('接下来重点准备') >= 0);
    ok('复盘里明确写了"分数不代表录用结果"（别让用户误读）',
      html.indexOf('不代表录用结果') >= 0);

    // 写回岗位 → 回看
    Store.updateJob(j.id, {
      interviewSim: { at: U.now(), round: '一面（技术/业务）', resumeId: '', transcript, review: fakeReview },
    });
    ok('模拟面试记录落到了岗位上', !!(Store.job(j.id).interviewSim || {}).transcript);
    InterviewSim.openResult(j.id);
    await tick();
    const t2 = (U.$('.mask') || {}).textContent || '';
    ok('回看复盘能打开', t2.indexOf('72') >= 0);
    ok('回看里带完整问答记录', t2.indexOf('完整问答记录') >= 0);
    U.closeAllModals();
    await tick();

    const txt = InterviewSim.reviewToText(Store.job(j.id), Store.job(j.id).interviewSim);
    ok('复盘转成文字后包含得分', txt.indexOf('72') >= 0);
    ok('复盘转成文字后包含逐题', txt.indexOf('逐题') >= 0 || txt.indexOf('介绍一下') >= 0);

    // 没有记录时点回看 → 给提示而不是空窗
    const j2 = Store.jobs().find(x => x.id !== j.id && !x.archived);
    if (j2) {
      Store.updateJob(j2.id, { interviewSim: null });
      InterviewSim.openResult(j2.id);
      await tick();
      ok('没有模拟面试记录时点回看 → 给提示而不是空弹窗',
        !U.$('.mask') && U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('还没有') >= 0));
    }

    Store.updateJob(j.id, { interviewSim: null });
    Store.setSetting('ai.apiKey', oldKey || '');
  }

  /* --- 17.13 简历解析与导出 --- */
  {
    const sample = [
      '张三',
      '意向：短视频运营',
      '电话：13800000000',
      '邮箱：zhang@example.com',
      '',
      '【工作经历】',
      '- 2022-2024 某公司｜短视频运营',
      '- 负责抖音账号，3 个月涨粉 10 万',
      '',
      '【教育背景】',
      '- 2018-2022 某大学 新闻学 本科',
    ].join('\n');

    const r = ResumeDoc.parse(sample);
    eq('解析出姓名', r.name, '张三');
    ok('解析出意向岗位（当作 headline，不是联系方式）', (r.headline || '').indexOf('短视频运营') >= 0);
    ok('解析出电话', r.contacts.some(c => c.k === '电话' && c.v === '13800000000'));
    ok('解析出邮箱', r.contacts.some(c => c.k === '邮箱'));
    eq('解析出两个小节', r.sections.length, 2);
    eq('第一个小节标题对', r.sections[0].title, '工作经历');

    ok('三种排版主题都在', Object.keys(ResumeDoc.THEMES).length >= 3);
    ok('每个主题都有名字和主色',
      Object.keys(ResumeDoc.THEMES).every(k => ResumeDoc.THEMES[k].name && ResumeDoc.THEMES[k].accent));

    const doc = ResumeDoc.toDocument(r, { theme: 'brand' });
    ok('导出的文档是完整 HTML', doc.indexOf('<!doctype html>') === 0 && doc.indexOf('</html>') > 0);
    ok('导出文档声明了 A4 页面', doc.indexOf('@page') >= 0 && doc.indexOf('A4') >= 0);
    ok('导出文档带打印样式（Ctrl+P 直接存 PDF）', doc.indexOf('@media print') >= 0);
    ok('导出文档里放了姓名', doc.indexOf('张三') >= 0);
    ok('导出文档里放了联系方式', doc.indexOf('13800000000') >= 0);
    ok('主题主色被写进文档', doc.indexOf(ResumeDoc.THEMES.brand.accent) >= 0);
    ok('导出文档是自包含的（不引用外部 css/js，双击就能看）',
      doc.indexOf('<link') < 0 && doc.indexOf('<script') < 0);

    const body = ResumeDoc.bodyHtml(r);
    ok('正文里有联系方式块', body.indexOf('rd-contacts') >= 0);
    ok('正文里有小节', body.indexOf('<section') >= 0);

    // 导出面板（必须用自己造的那份简历 —— 库里的第一条可能没内容，
    // 那就测不到"识别正常"这条分支，只会看到警告）
    const cv = Store.addResume({ name: '张三的简历', content: sample });
    ResumeDoc.openExportDialog(cv.id);
    await tick();
    const panel = (U.$('.mask') || {}).textContent || '';
    ok('导出面板打开了', !!U.$('.mask'));
    ok('面板里有实时预览容器', !!U.$('.rd-preview .rd-doc.rd-mini'));
    ok('预览里渲染出了简历正文', (U.$('.rd-preview').textContent || '').indexOf('张三') >= 0);
    /* 预览必须套上所选主题的主色，否则三套主题看着一模一样，
       "切换主题"就成了假按钮 —— 这个属性只有查 CSS 变量能验出来。 */
    const mini = U.$('.rd-preview .rd-doc.rd-mini');
    eq('默认主题（brand）的主色被套进预览', mini.style.getPropertyValue('--rd-accent'), ResumeDoc.THEMES.brand.accent);
    // 主题按钮文案里就带着「黑白」，这里按名字找
    const simpleBtn = U.$$('.mask .seg button').filter(b => (b.textContent || '').indexOf('黑白') >= 0)[0];
    ok('能找到「黑白」那套主题的按钮', !!simpleBtn);
    simpleBtn.click();
    await tick();
    const mini2 = U.$('.rd-preview .rd-doc.rd-mini');
    eq('切到黑白主题后预览主色跟着变', mini2.style.getPropertyValue('--rd-accent'), ResumeDoc.THEMES.simple.accent);
    ok('切换主题后预览内容还在（不是被清空）',
      (U.$('.rd-preview').textContent || '').indexOf('张三') >= 0);
    eq('面板里有 3 个主题切换按钮', U.$$('.mask .seg button').length, 3);
    ok('面板里有 4 个导出动作（PDF / Word / Markdown / HTML）',
      ['导出 PDF', '导出 Word', '导出 Markdown', '导出 HTML'].every(x => panel.indexOf(x) >= 0));
    ok('面板里说明了 PDF 是走浏览器打印（不装任何东西）',
      panel.indexOf('打印') >= 0 && panel.indexOf('另存为 PDF') >= 0);
    ok('识别正常时给的是绿色提示，不是警告',
      !!U.$('.mask .note.ok') && !U.$('.mask .note.warn'));
    U.closeAllModals();
    await tick();

    // 解析不出小节时要提醒，但别挡住导出
    const blank = Store.addResume({ name: '空简历', content: '随便写点没结构的东西' });
    ResumeDoc.openExportDialog(blank.id);
    await tick();
    const warn = U.$('.mask .note.warn');
    ok('识别不出结构时给出警告提示', !!warn);
    ok('警告里点名缺了什么', !!warn && /名称|联系方式|小节/.test(warn.textContent || ''));
    ok('警告说要怎么改（给了 【小节】 这种写法）',
      U.$('.mask').textContent.indexOf('【') >= 0);
    ok('警告不挡导出（按钮还在）',
      U.$$('.mask .mfoot button').some(b => (b.textContent || '').indexOf('导出 PDF') >= 0));
    U.closeAllModals();
    await tick();
  }

  /* --- 17.14 备份提醒 --- */
  {
    ok('dataAgeDays 能算出数据攒了多久', App.dataAgeDays() >= 0);

    // 从没导出过 → 要提醒（而且不能因为 null 比较恒为 false 就永远不提醒）
    Store.setSetting('backup.lastExportAt', null);
    Store.setSetting('backup.lastRemindedAt', null);
    Store.setSetting('backup.remindDays', 7);
    Store.jobs()[0].createdAt = U.now() - 30 * 86400000;
    clearToasts();
    App.checkBackupReminder();
    await tick();
    ok('从没导出过 → 会提醒备份',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('还没导出过备份') >= 0));
    ok('提醒里带了「去导出」的直接入口',
      U.$$('#toasts .toast button').some(b => (b.textContent || '').indexOf('去导出') >= 0));

    clearToasts();
    App.checkBackupReminder();
    await tick();
    ok('同一个周期内不重复提醒（否则用户会先去关提醒）', U.$$('#toasts .toast').length === 0);

    // 刚导出过 → 不提醒
    Store.markExported();
    Store.setSetting('backup.lastRemindedAt', null);
    clearToasts();
    App.checkBackupReminder();
    await tick();
    ok('刚导出过 → 不提醒', U.$$('#toasts .toast').length === 0);

    // 超过阈值 → 提醒，且说明几天了
    Store.setSetting('backup.lastExportAt', U.now() - 20 * 86400000);
    clearToasts();
    App.checkBackupReminder();
    await tick();
    ok('超过阈值 → 提醒，并说清已经多少天',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('20 天') >= 0));
    clearToasts();

    /* --- remindDays = 0 表示「用户关掉了」 ---
       ⚠️ 这里曾经是个真 bug：app.js 写的是 `cfg.remindDays || 7`，
       0 被 || 吞成 7 → 设置页关掉提醒后照样弹，成了「关不掉的提醒」。
       所以必须有这条断言把 0 的口径钉死。 */
    Store.setSetting('backup.remindDays', 0);
    Store.setSetting('backup.lastExportAt', U.now() - 60 * 86400000);
    Store.setSetting('backup.lastRemindedAt', null);
    clearToasts();
    App.checkBackupReminder();
    await tick();
    ok('remindDays 设成 0 → 彻底不提醒（0 不能被当成默认值 7）',
      U.$$('#toasts .toast').length === 0, '弹了 ' + U.$$('#toasts .toast').length + ' 条');

    // 恢复成 7 天，下一个用例继续
    Store.setSetting('backup.remindDays', 7);
    Store.setSetting('backup.lastRemindedAt', null);
    clearToasts();
  }

  /* --- 17.14b 设置页里的备份提醒开关 --- */
  {
    /* 一个会主动弹 toast 的提醒，必须给用户关掉的地方。
       这里真的渲染设置页，然后去 DOM 里找那个开关 —— 而不是只断言函数存在。 */
    Store.setSetting('backup.remindDays', 7);
    Store.setSetting('backup.lastExportAt', U.now() - 3 * 86400000);
    const r = inspectPage('settings');
    ok('设置页能渲染出来（备份开关所在的那一页）', !r.crashed && !r.err, r.crashMsg);

    const cbRemind = U.$$('#view input[type=checkbox]').filter(c => {
      const lab = c.parentNode;
      return lab && (lab.textContent || '').indexOf('定期提醒我导出备份') >= 0;
    })[0];
    ok('设置页有「定期提醒我导出备份」勾选框', !!cbRemind);
    ok('有备份提醒开关时，默认是勾上的（remindDays=7 视为开）', !!cbRemind && cbRemind.checked === true);

    /* ⚠️ 按结构特征找，不按 index —— 设置页随时会加下拉（这次就加了「我的最高学历」），
       `U.$$('#view select')[0]` 会静默取到错的控件，而**断言还是绿的**（当年踩过一次）。 */
    const selDays = U.$$('#view select').filter(s => (s.textContent || '').indexOf('每隔') >= 0)[0];
    ok('旁边有选间隔的下拉（3 / 7 / 14 / 30 天）', !!selDays);
    ok('下拉里确实有 4 个间隔选项', !!selDays && selDays.children.length === 4);
    ok('下拉默认选中当前的 7 天', !!selDays && String(selDays.value) === '7', selDays && selDays.value);

    ok('设置页写清了「上次导出是几天前」',
      (r.txt || '').indexOf('上次导出是') >= 0, r.txt.slice(0, 120));

    // 真的把勾去掉 → remindDays 落成 0
    if (cbRemind) {
      cbRemind.checked = false;
      cbRemind.dispatchEvent({ type: 'change', target: cbRemind, stopPropagation() {}, preventDefault() {} });
      await tick();
      ok('取消勾选 → remindDays 落成 0（真把提醒关掉，不只是 UI 变样）',
        Store.settings().backup.remindDays === 0, '实际 ' + Store.settings().backup.remindDays);
      ok('取消勾选后，间隔下拉被禁用（避免看着还能调）', !!selDays && selDays.disabled === true);

      // 再勾回来 → 恢复成下拉里的值
      cbRemind.checked = true;
      cbRemind.dispatchEvent({ type: 'change', target: cbRemind, stopPropagation() {}, preventDefault() {} });
      await tick();
      ok('重新勾上 → 提醒恢复', Store.settings().backup.remindDays > 0,
        '实际 ' + Store.settings().backup.remindDays);
    }

    // 改间隔 → 落盘 + 清掉限流时间戳（否则改了间隔当天还是不提醒，像是没生效）
    if (selDays) {
      Store.setSetting('backup.lastRemindedAt', U.now());
      selDays.value = '3';
      selDays.dispatchEvent({ type: 'change', target: selDays, stopPropagation() {}, preventDefault() {} });
      await tick();
      ok('改间隔 → 落盘为 3 天', Store.settings().backup.remindDays === 3,
        '实际 ' + Store.settings().backup.remindDays);
      ok('改间隔后清掉了「刚提醒过」的时间戳（否则改了也不生效）',
        !Store.settings().backup.lastRemindedAt);
    }

    clearToasts();
  }

  /* --- 17.15 index.html 真的引了三个新脚本 --- */
  {
    ['js/view-followup.js', 'js/interview-sim.js', 'js/resume-doc.js'].forEach(f => {
      ok('index.html 引入了 ' + f, scriptOrder.indexOf(f) >= 0);
    });
    ok('三个新脚本都挂在 window 上了',
      !!(sandbox.FollowUp && sandbox.InterviewSim && sandbox.ResumeDoc));
    ok('待跟进注册成了可路由页面', !!Views.followup && typeof Views.followup.render === 'function');
    ok('脚本顺序与 index.html 一致（否则同一文件里的 global.XXX 会拿不到）',
      indexHtml.indexOf('js/view-followup.js') < indexHtml.indexOf('js/view-collect.js'));
  }

  /* --- 17.16 样式表覆盖：JS 用到的 class 必须真有样式 --- */
  {
    /* 这条是防"看着加了功能、其实没样式"的兜底。
       加了一堆 class 但 css 里一个都没有，页面上就是一堆裸元素。 */
    const css = fs.readFileSync(path.join(DIR, 'css/app.css'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    const need = ['.fbar', '.toast-act', '.menu', '.mi', '.mdiv', '.bbar',
      '.grp-co', '.co-body', '.co-row', '.co-foot', '.dbar', '.dwrap', '.dgroup',
      '.rd-preview', '.rd-mini', '.simbox', '.nl', '.fs14'];
    const miss = need.filter(c => css.indexOf(c) < 0);
    ok('本轮新增的样式类都在 app.css 里', miss.length === 0, miss.join(' '));

    ok('.dbar 用的是 sticky 定位（高频操作要粘住不滚）',
      /\.dbar\s*\{[^}]*position:\s*sticky/.test(css));
    ok('.bbar 也是 sticky（批量条不能跟着列表滚走）',
      /\.bbar\s*\{[^}]*position:\s*sticky/.test(css));
    ok('.menu 用 fixed 定位（JS 会写内联 left/top）',
      /\.menu\s*\{[^}]*position:\s*fixed/.test(css));
    ok('简历预览强制白底黑字（深色主题下也要看得出"打出来什么样"）',
      /\.rd-doc\.rd-mini\s*\{[^}]*background:\s*#fff/.test(css));
  }

  /* --- 17.17 类名体检：不能出现带小数点的伪类名 --- */
  {
    /* 'fs12.5' 这种字符串在 CSS 里选不中（. 是类名分隔符），
       写了等于没写，而且不报错 —— 只能靠扫源码抓。 */
    const bad = [];
    fs.readdirSync(path.join(DIR, 'js')).filter(f => f.endsWith('.js')).forEach(f => {
      const src = fs.readFileSync(path.join(DIR, 'js', f), 'utf8');
      src.split('\n').forEach((line, i) => {
        const m = line.match(/class:\s*'[^']*\b[a-z]{2}\d+\.\d+/);
        if (m) bad.push(f + ':' + (i + 1));
      });
    });
    ok('没有带小数点的类名（如 fs12.5 —— CSS 里选不中）', bad.length === 0, bad.join(' | '));

    /* 用了 el(...) 却没建 `var el = Comp.el` 的文件 ——
       resume-doc.js 就踩过：功能全在，一点「导出 PDF」直接 ReferenceError。
       只测打开弹窗是查不出来的（弹窗构造在异常点之前），只能靠扫源码。 */
    const noAlias = [];
    fs.readdirSync(path.join(DIR, 'js')).filter(f => f.endsWith('.js')).forEach(f => {
      const src = fs.readFileSync(path.join(DIR, 'js', f), 'utf8');
      const usesEl = /(^|[^.\w'"])el\(/.test(src);          // 排除 Comp.el( / U.el( 和字符串里的 'el('
      // 有的文件是自己定义 el（utils.js 定义、components.js 转发、app.js 里的局部工具），
      // 它们不需要 Comp.el 这个别名
      const hasAlias = /var\s+el\s*=\s*(Comp|U)\.el|function\s+el\s*\(/.test(src);
      if (usesEl && !hasAlias) noAlias.push(f);
    });
    ok('每个用到 el() 的文件都建了 el 别名（否则运行时 ReferenceError）',
      noAlias.length === 0, noAlias.join(', '));

    /* 反过来：建了别名却没用，说明是复制粘贴的残留，也该清掉 */
    const deadAlias = [];
    fs.readdirSync(path.join(DIR, 'js')).filter(f => f.endsWith('.js')).forEach(f => {
      const src = fs.readFileSync(path.join(DIR, 'js', f), 'utf8');
      if (/var\s+el\s*=\s*Comp\.el/.test(src) && !/(^|[^.\w'"])el\(/.test(src)) deadAlias.push(f);
    });
    ok('没有"建了 el 别名却没用"的残留文件', deadAlias.length === 0, deadAlias.join(', '));
  }

  /* ==================================================================
     【18】《筛选功能修改要求》本轮落地
     —— 一键按偏好筛选 / 快捷 chips / 自然语言搜索 / 批量匹配评分 / 导入即评分
     ================================================================== */
  const JM = sandbox.JobMatch;

  ok('job-match.js 挂到了 window 上', !!JM && typeof JM.parseQuery === 'function');

  /* ---------- 期望福利 welfareHit（第 11 轮新增，这里补纯逻辑断言） ----------
     ⑸ ⑹ 两处回退自证都栽在「没直接测 welfareHit」上，这里一次性补死。 */
  ok('福利：没勾任何项 → 一律放行', JM.welfareHit({ benefits: ['双休'] }, [], 'all') === true
    && JM.welfareHit({ benefits: [] }, null, 'all') === true);
  ok('福利：没采到（benefits 空 / 缺字段）→ 保留，不筛掉',
    JM.welfareHit({}, ['双休'], 'all') === true
    && JM.welfareHit({ benefits: [] }, ['双休'], 'all') === true);
  ok('福利：any 命中一项即达标',
    JM.welfareHit({ benefits: ['双休', '五险一金'] }, ['双休', '年终奖'], 'any') === true);
  ok('福利：all 要全命中，只中一项不算',
    JM.welfareHit({ benefits: ['双休', '五险一金'] }, ['双休', '年终奖'], 'all') === false
    && JM.welfareHit({ benefits: ['双休', '五险一金', '年终奖'] }, ['双休', '年终奖'], 'all') === true);

  /* 造一批**可控**岗位，并打上专属标签隔离。
     断言直接用示例数据的话，条数和顺序都不确定，测出来的是"碰巧"。 */
  const TAG18 = '__t18';
  const mk18 = function (o) {
    return Store.addJob(Object.assign({
      source: 'manual', title: '岗位', company: '公司', location: '杭州',
      salaryMin: 12, salaryMax: 18, salaryText: '12-18K', tags: [TAG18],
    }, o)).job.id;
  };
  const JX = {
    hzGood: mk18({ title: '杭州运营A', company: '杭州甲', location: '杭州·西湖区' }),
    hzOut: mk18({ title: '杭州运营B', company: '乙外包公司' }),
    sh: mk18({ title: '上海运营C', company: '上海丙', location: '上海' }),
    lowPay: mk18({ title: '杭州运营D', company: '杭州丁', salaryMin: 6, salaryMax: 8, salaryText: '6-8K' }),
    noPay: mk18({ title: '杭州运营E', company: '杭州戊', salaryMin: null, salaryMax: null, salaryText: '面议' }),
  };
  const R18 = { id: 'resume18', name: '测试用简历', content: '运营 3 年' };

  /* 每次重置到"干净"的筛选状态，避免上一节留下的条件串味 */
  function resetF18() {
    Object.assign(F, {
      kw: '', source: '', tag: '', salary: '', status: '',
      fav: false, archived: false, sort: 'new',
      pref: false, quick: {}, nlOff: false,
      view: 'card',           // 统一卡片视图 —— 表格/公司视图的 DOM 结构不同，数不出 .job
    });
    F.tag = TAG18;      // 只在自己这批里断言
  }
  const idsOfList = () => U.$$('#view .job').length;

  /* 先渲染一次，让 _pageRebuild / _pageRepaint 就位 */
  resetF18();
  App.go('jobs');

  /* --- 18.1 偏好规则：城市 / 薪资 / 不能接受的点 --- */
  {
    const j = id => Store.job(id);

    ok('城市做包含匹配（「杭州」命中「杭州·西湖区」）', JM.cityHit(j(JX.hzGood), ['杭州']));
    ok('城市不命中别的城市（上海岗位不通过杭州偏好）', !JM.cityHit(j(JX.sh), ['杭州']));
    ok('城市匹配不分大小写', JM.cityHit({ location: 'HangZhou' }, ['hangzhou']));
    ok('地点为空 → 不命中任何目标城市', !JM.cityHit({ location: '' }, ['杭州']));
    ok('没填城市偏好时，任何地点都放行', JM.cityHit({ location: '火星' }, []));

    ok('薪资达标（下限 12 ≥ 底线 10）', JM.salaryHit(j(JX.hzGood), 10));
    ok('薪资不达标（6-8K 低于底线 10）', !JM.salaryHit(j(JX.lowPay), 10));
    /* ⚠️ 这条最关键：采集回来的岗位常常没薪资，
       因为"没写"就筛掉，用户会以为岗位丢了 */
    ok('薪资字段为空的岗位**保留**（不能因为没写薪资就筛掉）', JM.salaryHit(j(JX.noPay), 10));
    ok('底线没填（null）时全部放行', JM.salaryHit(j(JX.lowPay), null));

    ok('「不能接受的点」能命中公司名里的「外包」', JM.dealHit(j(JX.hzOut), ['外包']));
    ok('干净的岗位不会被误杀', !JM.dealHit(j(JX.hzGood), ['外包']));
    ok('「不能接受的点」能命中标签', JM.dealHit({ tags: ['派遣'] }, ['派遣']));
    /* 有意不扫 JD 正文：JD 里"本岗位非外包"这种反向表述会误杀 */
    ok('「不能接受的点」不扫 JD 正文（避免反向表述误杀）',
      !JM.dealHit({ title: '运营', company: '甲', rawJD: '本岗位非外包，正式编制' }, ['外包']));

    const P = { cities: ['杭州'], salaryMin: 10, dealBreakers: ['外包'] };
    ok('偏好全通过：杭州 + 薪资够 + 不是外包',
      JM.passPref(j(JX.hzGood), P) && JM.passPref(j(JX.noPay), P));
    ok('偏好卡掉：非目标城市', !JM.passPref(j(JX.sh), P));
    ok('偏好卡掉：薪资不够', !JM.passPref(j(JX.lowPay), P));
    ok('偏好卡掉：命中不能接受的点', !JM.passPref(j(JX.hzOut), P));

    ok('偏好能写成一句人话',
      JM.describePref(P) === '杭州 · 10K 以上 · 排除 外包', JM.describePref(P));
    ok('空偏好也有人话（不返回空串）', JM.describePref({ cities: [], salaryMin: null, dealBreakers: [] }).length > 0);
  }

  /* --- 18.2 「⚙ 按我的偏好筛选」开关 --- */
  {
    Store.setSetting('prefs.cities', ['杭州']);
    Store.setSetting('prefs.salaryMin', 10);
    Store.setSetting('prefs.dealBreakers', ['外包']);

    resetF18();
    Views.jobs.refresh();
    const before = idsOfList();
    eq('偏好关闭时，这批 5 个岗位都在', before, 5);

    const btnPref = U.$$('#view button').filter(b => (b.textContent || '').indexOf('按我的偏好筛选') >= 0)[0];
    ok('筛选区有「⚙ 按我的偏好筛选」按钮', !!btnPref);
    ok('按钮上写明了当前偏好（让用户知道会按什么筛）',
      !!btnPref && (btnPref.getAttribute('title') || '').indexOf('杭州') >= 0,
      btnPref && btnPref.getAttribute('title'));

    btnPref.click();
    await tick();
    eq('点一下 → 只剩杭州 + 薪资够 + 非外包（hzGood / noPay）', idsOfList(), 2);
    ok('按钮变成已开启态（高亮 + 文案）',
      (U.$$('#view button').filter(b => (b.textContent || '').indexOf('已开启') >= 0)[0] || null) !== null);
    ok('汇总条里出现「按我的偏好」',
      viewText().indexOf('按我的偏好') >= 0);

    const again = U.$$('#view button').filter(b => (b.textContent || '').indexOf('按我的偏好筛选') >= 0)[0];
    again.click();
    await tick();
    eq('再点一下 → 恢复全量', idsOfList(), 5);
    ok('取消后按钮不再显示已开启',
      (U.$$('#view button').filter(b => (b.textContent || '').indexOf('已开启') >= 0)[0] || null) === null);

    /* 偏好筛到 0 条时，必须说清"是偏好筛的"，并给出口 */
    F.pref = true;
    Store.setSetting('prefs.cities', ['不存在的城市xyz']);
    Views.jobs.refresh();
    ok('偏好筛空时给出「没有符合你偏好的岗位」',
      viewText().indexOf('没有符合你偏好的岗位') >= 0, viewText().slice(0, 120));
    ok('空态里给了「去调整偏好」的入口',
      U.$$('#view button').some(b => (b.textContent || '').indexOf('去调整偏好') >= 0));
    ok('空态里给了「取消偏好筛选」的入口',
      U.$$('#view button').some(b => (b.textContent || '').indexOf('取消偏好筛选') >= 0));

    Store.setSetting('prefs.cities', ['杭州']);
    F.pref = true;
    Views.jobs.refresh();
    /* 「重置」必须连偏好开关一起清 —— 否则用户以为重置了，其实还开着 */
    const btnReset = U.$$('#view button').filter(b => (b.textContent || '').trim() === '重置')[0];
    ok('筛选区有「重置」按钮', !!btnReset);
    btnReset.click();
    await tick();
    ok('「重置」把偏好开关一起清掉', F.pref === false);
    ok('「重置」也清掉了手动条件（这里表现为标签被清空）', F.tag === '');
    /* 重置把标签条件也清了，所以这里的 5 要自己把标签隔离补回来再数 */
    F.tag = TAG18;
    Views.jobs.refresh();
    eq('重置之后列表回到完整范围', idsOfList(), 5);
    ok('重置后偏好按钮回到未开启',
      (U.$$('#view button').filter(b => (b.textContent || '').indexOf('已开启') >= 0)[0] || null) === null);

    /* 偏好是空的时候点按钮 → **就地展开偏好面板**（不跳设置页），而不是静默无效 */
    Store.setSetting('prefs.cities', []);
    Store.setSetting('prefs.salaryMin', null);
    Store.setSetting('prefs.dealBreakers', []);
    resetF18();
    App.go('jobs');
    await tick();
    Views.jobs.refresh();
    clearToasts();
    const btnEmpty = U.$$('#view button').filter(b => (b.textContent || '').indexOf('按我的偏好筛选') >= 0)[0];
    btnEmpty.click();
    await tick();
    ok('偏好没填 → 有 toast 引导（不是点了没反应）',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('求职偏好') >= 0),
      U.$$('#toasts .toast').map(t => t.textContent).join(' | '));
    ok('偏好没填 → 筛不会真的打开（不会拿空条件假装筛过）', F.pref === false);
    eq('偏好没填 → 就地展开偏好面板去填（不跳页）', U.$('#pgTitle').textContent, Views.jobs.title);
    ok('偏好没填 → 面板确实是展开的',
      U.$$('#view .prefsbox').length === 1 &&
      /(^|\s)open(\s|$)/.test(U.$$('#view .prefsbox')[0].className || ''),
      (U.$$('#view .prefsbox')[0] || {}).className);
    clearToasts();

    // 回岗位库，恢复成有值的偏好，后面的用例还要用
    App.go('jobs');
    await tick();
    Store.setSetting('prefs.cities', ['杭州']);
    Store.setSetting('prefs.salaryMin', 10);
    Store.setSetting('prefs.dealBreakers', ['外包']);
    resetF18();
    Views.jobs.refresh();
  }

  /* --- 18.3 快捷筛选 chips --- */
  {
    resetF18();
    Views.jobs.refresh();
    const chips = () => U.$$('#view .qchip');
    /* ⚠️ **不写死条数** —— 跟 QUICK 配置走。
       写死数字的话，「加了一个 chip」和「漏渲染了」长得一模一样，都是变红，
       这条断言就没什么信息量了（本项目踩过：写死的数字会掩盖真 bug）。 */
    eq('快速筛选的 chip 数跟 QUICK 配置一致', chips().length, sandbox.JobMatch.QUICK.length);
    ok('chip 文案齐（含本轮新增的「福利达标」「我的区域」）',
      ['高匹配', '本周新', '薪资达标', '未投', '排除不能接受的点', '福利达标', '我的区域']
        .every(t => chips().some(c => (c.textContent || '').indexOf(t) >= 0)));
    ok('每个 chip 都带一个岗位数（点下去会剩几个，一眼可见）',
      chips().every(c => /\d/.test(c.textContent || '')));

    const chipOf = t => chips().filter(c => (c.textContent || '').indexOf(t) >= 0)[0];

    /* 💰 薪资达标：底线 10，lowPay(6-8) 出局，noPay(面议) 保留 */
    chipOf('薪资达标').click();
    await tick();
    eq('「💰 薪资达标」生效（6-8K 出局、面议保留）', idsOfList(), 4);
    ok('chip 进入选中态', chipOf('薪资达标').className.indexOf('on') >= 0);
    chipOf('薪资达标').click();
    await tick();
    eq('再点一次取消', idsOfList(), 5);

    /* 🚫 排除不能接受的点 */
    chipOf('排除不能接受的点').click();
    await tick();
    eq('「🚫 排除不能接受的点」把外包公司筛掉', idsOfList(), 4);

    /* 📨 未投：给一个岗位建投递记录，它就该被筛掉 */
    Store.addApplication({ jobId: JX.hzGood, status: 'applied' });
    Views.jobs.refresh();
    const beforeNoApp = idsOfList();
    chips().filter(c => (c.textContent || '').indexOf('未投') >= 0)[0].click();
    await tick();
    eq('「📨 未投」把已投递的岗位筛掉',
      idsOfList(), beforeNoApp - 1);

    /* 叠加（AND）：薪资达标 + 排除不能接受的点，两个一起生效 */
    chipOf('薪资达标').click();
    await tick();
    const both = idsOfList();
    ok('多个 chip 叠加后只剩同时满足的（AND）', both <= 3, '实际 ' + both);
    ok('汇总条把两个 chip 都列出来了',
      viewText().indexOf('薪资达标') >= 0 && viewText().indexOf('排除不能接受的点') >= 0);

    /* 偏好没填时，依赖偏好的 chip 不能假装生效 */
    Store.setSetting('prefs.salaryMin', null);
    Store.setSetting('prefs.dealBreakers', []);
    resetF18();
    Views.jobs.refresh();
    clearToasts();
    const chipSal = chips().filter(c => (c.textContent || '').indexOf('薪资达标') >= 0)[0];
    ok('偏好没填 → 该 chip 标成"未就绪"样式', chipSal.className.indexOf('need') >= 0);
    chipSal.click();
    await tick();
    ok('点了未就绪的 chip → 引导去填偏好，而不是假装筛了',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('求职偏好') >= 0));
    ok('未就绪的 chip 不会真的被选中（F.quick 里没它）', !F.quick.salary);
    eq('就地展开偏好面板去填（不跳页）', U.$('#pgTitle').textContent, Views.jobs.title);
    ok('就地展开：面板确实开了',
      U.$$('#view .prefsbox').length === 1 &&
      /(^|\s)open(\s|$)/.test(U.$$('#view .prefsbox')[0].className || ''));
    clearToasts();

    // 收起面板再看渲染结果
    F.prefsOpen = false;
    App.go('jobs');
    await tick();
    resetF18();
    Views.jobs.refresh();
    eq('回到岗位库，列表没被那次点击筛成 0', idsOfList(), 5);
    ok('未就绪的 chip 渲染成"未就绪"样式而不是选中态',
      U.$$('#view .qchip').filter(c => (c.textContent || '').indexOf('薪资达标') >= 0)[0]
        .className.indexOf('on') < 0);

    Store.setSetting('prefs.salaryMin', 10);
    Store.setSetting('prefs.dealBreakers', ['外包']);
    resetF18();
    Views.jobs.refresh();
  }

  /* --- 18.4 自然语言搜索 --- */
  {
    const q1 = JM.parseQuery('杭州 运营 15k');
    eq('解析出城市', q1.cities.join('/'), '杭州');
    eq('解析出薪资下限', q1.salaryMin, 15);
    eq('剩下的词当关键词', q1.kwTokens.join('/'), '运营');
    ok('解析出了结构 → matched 为真', q1.matched === true);

    eq('15k-20k → 下限 15', JM.parseQuery('15k-20k').salaryMin, 15);
    eq('15k-20k → 上限 20', JM.parseQuery('15k-20k').salaryMax, 20);
    eq('1.5w → 15K（万要换算）', JM.parseQuery('1.5w').salaryMin, 15);
    eq('1.5万 → 15K', JM.parseQuery('1.5万').salaryMin, 15);
    eq('10k以上 → 下限 10', JM.parseQuery('10k以上').salaryMin, 10);
    eq('不要外包 → 排除词', JM.parseQuery('不要外包').exclude.join('/'), '外包');
    eq('排除外包 也认', JM.parseQuery('排除外包').exclude.join('/'), '外包');
    ok('排除词会从关键词里去掉（不会又当关键词又当排除）',
      JM.parseQuery('不要外包').kwTokens.indexOf('外包') < 0);

    const q2 = JM.parseQuery('运营');
    ok('纯关键词输入 → matched 为假（要退回原来的搜索行为）', q2.matched === false);
    const q3 = JM.parseQuery('');
    ok('空输入不炸', q3.matched === false && q3.kwTokens.length === 0);
    ok('奇怪输入不炸', JM.parseQuery('!!! ??? ...').matched === false);

    /* 城市剔除只许吃掉「省 / 市」后缀和行政区尾巴，不能顺带把岗位名一起吞了。
       这条是防回归：早先正则里写 '\s'（字符串里会被 JS 吃成字母 s）+
       用 [^…]* 一路匹配，会把「杭州 运营」整串吃掉，城市和关键词同时消失。 */
    eq('杭州 + 岗位名 → 城市吃掉、岗位名留着',
      JM.parseQuery('杭州 运营').kwTokens.join('/'), '运营');
    eq('紧贴的「杭州市」也认得', JM.parseQuery('杭州市运营').cities.join('/'), '杭州');
    eq('紧贴的「杭州市」不吞岗位名', JM.parseQuery('杭州市运营').kwTokens.join('/'), '运营');
    ok('「杭州西湖区」的行政区尾巴一并剔除',
      JM.parseQuery('杭州西湖区 运营').kwTokens.indexOf('运营') >= 0 &&
      JM.parseQuery('杭州西湖区 运营').kwTokens.join('/').indexOf('区') < 0,
      JM.parseQuery('杭州西湖区 运营').kwTokens.join('/'));
    ok('多城市都认得',
      JM.parseQuery('杭州 上海 运营').cities.join('/') === '上海/杭州' ||
      JM.parseQuery('杭州 上海 运营').cities.join('/') === '杭州/上海',
      JM.parseQuery('杭州 上海 运营').cities.join('/'));

    /* 两个以上的关键词 → 也要走自然语言模式（多词 AND），
       否则搜「运营 短视频」会退化成整串子串匹配，永远搜不到东西。 */
    ok('两个关键词 → matched 为真（否则退回整串匹配就搜不到了）',
      JM.parseQuery('运营 短视频').matched === true);
    ok('单个关键词 → 仍走原来的子串搜索', JM.parseQuery('运营').matched === false);
    ok('排除词不会被当成关键词',
      JM.parseQuery('运营 不要外包').kwTokens.join('/') === '运营' &&
      JM.parseQuery('运营 不要外包').exclude.join('/') === '外包',
      JM.parseQuery('运营 不要外包').kwTokens.join('/'));
    ok('城市 + 薪资 + 排除 + 关键词 全串一起也能拆',
      (function () {
        const q = JM.parseQuery('杭州 运营 15k 不要外包');
        return q.cities.join('/') === '杭州' && q.salaryMin === 15 &&
          q.exclude.join('/') === '外包' && q.kwTokens.join('/') === '运营' && q.matched === true;
      })(), JSON.stringify(JM.parseQuery('杭州 运营 15k 不要外包')));

    ok('解析结果有人话说明',
      JM.describeQuery(q1).indexOf('城市=杭州') >= 0 && JM.describeQuery(q1).indexOf('薪资≥15K') >= 0,
      JM.describeQuery(q1));

    /* 多关键词是 AND —— 整串匹配的话「运营 短视频」几乎永远匹配不上 */
    const jA = { title: '短视频运营', company: '甲', rawJD: '', tags: [], duties: [], reqSkills: [], industry: '', location: '杭州' };
    const jB = { title: '运营专员', company: '乙', rawJD: '', tags: [], duties: [], reqSkills: [], industry: '', location: '杭州' };
    const qq = JM.parseQuery('运营 短视频');
    ok('「运营 短视频」→ 两个词都要命中', JM.passQuery(jA, qq) && !JM.passQuery(jB, qq));

    /* 页面上的表现 */
    resetF18();
    F.tag = '';
    App.go('jobs');
    await tick();
    /* ⛔ 必须按 data-focus-key 取搜索框，不能用「第一个 text input」——
       岗位库页还有偏好面板等其他 text input，DOM 顺序会因数据/折叠状态而变，
       取第一个会 flaky 地拿到错误元素 → 输入不触发搜索框监听器 → 「理解为」小字不出现。 */
    const kwInput = U.$('#view input[data-focus-key="job-kw"]');
    ok('搜索框还在', !!kwInput);
    ok('搜索框提示里给了自然语言的例子（否则没人知道能这么用）',
      (kwInput.getAttribute('placeholder') || '').indexOf('15k') >= 0, kwInput.getAttribute('placeholder'));

    kwInput.value = '杭州 运营 15k';
    kwInput.dispatchEvent({ type: 'input', target: kwInput, stopPropagation() { }, preventDefault() { } });
    /* ⛔ 固定 260ms 不够：input 有 180ms 防抖，repaint 又是 60ms 防抖，两层共 240ms，
       再加 App.refresh 的渲染时间，高负载下 260ms 会踩在临界点上 flaky（实测 5 跑 3 红）。
       改成轮询等「理解为」出现（最多 2s），条件满足就立刻往下，不再赌固定时长。 */
    for (let _i = 0; _i < 40 && viewText().indexOf('理解为') < 0; _i++) {
      await new Promise(r => setTimeout(r, 50));
    }
    ok('输入后解析小字出现（告诉用户被怎么理解了）', viewText().indexOf('理解为') >= 0, viewText().slice(0, 150));
    ok('小字里写明了城市 / 薪资', viewText().indexOf('城市=杭州') >= 0 && viewText().indexOf('薪资≥15K') >= 0);

    /* 退出方式：解码出错时能一键退回普通关键词搜索 */
    const plain = U.$('#view .nlhint .nl-clear');
    ok('给了「当普通关键词搜」的退路', !!plain);
    plain.click();
    await tick();
    ok('点了之后解析小字消失（退回纯关键词搜索）', viewText().indexOf('理解为') < 0);

    F.kw = '';
    F.nlOff = false;
    resetF18();
    Views.jobs.refresh();
  }

  /* --- 18.5 批量评分：runBatch --- */
  {
    const realRun = sandbox.AI.runTemplate;
    const plan = {};
    let callLog = [];
    sandbox.AI.runTemplate = function (tpl, input) {
      const m = /岗位名称：([^\n]+)/.exec(String(input && input.job));
      const title = m ? m[1].trim() : '?';
      callLog.push(title);
      const mode = plan[title] || 'ok';
      if (mode === 'fail') return Promise.reject(new Error('模型挂了'));
      if (mode === 'failOnce') { plan[title] = 'ok'; return Promise.reject(new Error('第一次失败')); }
      return Promise.resolve({
        text: '{}',
        data: {
          score: 88, verdict: '强匹配，建议投', category: 'qualified',
          matched: ['运营经验'], missing: ['缺数据能力'], risks: ['学历偏低'],
          suggestions: ['补一条数据成果'], keywordsToAdd: ['AIGC'], greetingHint: '我做过短视频',
        },
      });
    };
    try {
      const uiLog = { ticks: [], fails: [], asked: null };
      const ui = {
        isCanceled: () => false,
        tick: (done) => uiLog.ticks.push(done),
        ok: () => { },
        fail: (list) => { uiLog.fails = list; },
        askContinue: (n) => { uiLog.asked = n; return Promise.resolve(true); },
      };

      const r1 = await JM.runBatch({ ids: [JX.hzGood, JX.hzOut], resume: R18, ui });
      eq('全部成功 → ok 数等于岗位数', r1.ok, 2);
      eq('全部成功 → 没有失败项', r1.fails.length, 0);
      eq('岗位 1 的分数写进去了', Store.job(JX.hzGood).aiVerdict.score, 88);
      eq('岗位 2 的分数也写了', Store.job(JX.hzOut).aiVerdict.score, 88);
      eq('结论原文保存', Store.job(JX.hzGood).aiVerdict.verdict, '强匹配，建议投');
      ok('匹配点 / 缺口 / 风险 / 建议都存了',
        Store.job(JX.hzGood).aiVerdict.matched.length === 1 &&
        Store.job(JX.hzGood).aiVerdict.missing.length === 1 &&
        Store.job(JX.hzGood).aiVerdict.risks.length === 1 &&
        Store.job(JX.hzGood).aiVerdict.suggestions.length === 1);
      eq('记下了用的是哪份简历（便于判断新旧）',
        Store.job(JX.hzGood).aiVerdict.resumeId, R18.id);
      ok('记下了评分时间', !!Store.job(JX.hzGood).aiVerdictAt);
      eq('每个岗位都 tick 一次（进度条要靠它）', uiLog.ticks.length, 2);

      /* 单个失败不中断整体 */
      plan['杭州运营B'] = 'fail';
      uiLog.fails = [];
      const r2 = await JM.runBatch({ ids: [JX.hzGood, JX.hzOut, JX.sh], resume: R18, ui });
      eq('一个岗位失败 → 其它照常跑完', r2.ok, 2);
      eq('失败项被记录下来', r2.fails.length, 1);
      ok('失败项记的是哪个岗位', r2.fails[0].job.id === JX.hzOut);
      ok('失败回调把清单给了 UI（要显示出来）', uiLog.fails.length === 1);
      ok('失败不会把已成功的覆盖成空', Store.job(JX.hzGood).aiVerdict.score === 88);

      /* 失败自动重试 1 次 */
      plan['上海运营C'] = 'failOnce';
      callLog = [];
      const r3 = await JM.runBatch({ ids: [JX.sh], resume: R18, ui });
      eq('第一次失败、重试成功 → 算成功', r3.ok, 1);
      eq('确实调用两次（1 次失败 + 1 次重试）',
        callLog.filter(t => t === '上海运营C').length, 2);

      /* 连续失败会停下来问一句，而不是一路瞎跑 */
      plan['杭州运营A'] = 'fail';
      plan['杭州运营B'] = 'fail';
      plan['上海运营C'] = 'fail';
      uiLog.asked = null;
      const uiNo = Object.assign({}, ui, {
        askContinue: (n) => { uiLog.asked = n; return Promise.resolve(false); },
      });
      const r4 = await JM.runBatch({ ids: [JX.hzGood, JX.hzOut, JX.sh], resume: R18, ui: uiNo });
      eq('连续 3 个失败 → 会问「要不要继续」', uiLog.asked, 3);
      eq('回答「不继续」→ 立刻停，成功数 0', r4.ok, 0);
      ok('停止后标记为已取消', r4.canceled === true);

      /* 取消：已评的保留 */
      Store.updateJob(JX.hzGood, { aiVerdict: null, aiVerdictAt: null });
      Store.updateJob(JX.hzOut, { aiVerdict: null, aiVerdictAt: null });
      plan['杭州运营A'] = 'ok';
      plan['杭州运营B'] = 'ok';
      let cancel2 = false;
      const uiCancel = {
        isCanceled: () => cancel2,
        tick: (done) => { if (done === 2) cancel2 = true; },   // 第 2 个刚开始就取消
        ok: () => { }, fail: () => { }, askContinue: () => Promise.resolve(true),
      };
      const r6 = await JM.runBatch({ ids: [JX.hzGood, JX.hzOut], resume: R18, ui: uiCancel });
      eq('中途取消 → 已经评好的那个保留', r6.ok, 1);
      ok('取消时给出 canceled 标记（UI 要据此改文案）', r6.canceled === true);
      ok('取消后第 2 个没有被评分', Store.job(JX.hzOut).aiVerdict === null);

      /* 边界：空列表 / 岗位被删 */
      const r7 = await JM.runBatch({ ids: [], resume: R18, ui });
      eq('空列表 → 直接完成，不报错', r7.ok, 0);
      const r8 = await JM.runBatch({ ids: ['__不存在的岗位__', JX.hzGood], resume: R18, ui });
      eq('岗位已被删 → 跳过它继续跑下一个', r8.ok, 1);
      eq('跳过的不算失败', r8.fails.length, 0);

      /* 纯函数：估算时长 */
      ok('估算时长有输出（让用户知道要等多久）',
        JM.estimateText(10).indexOf('约') >= 0 && JM.estimateText(90).indexOf('分钟') >= 0,
        JM.estimateText(10) + ' / ' + JM.estimateText(90));
      ok('0 个岗位不显示时长', JM.estimateText(0) === '');

      /* 成本预估（费用不可控整改）：token 估算 / 单价来源 / 真实 usage 逐跳透传 */
      ok('token 估算：中文按 0.6 token/字', sandbox.AI.estTokens('一二三四五六七八九十') === 6);
      ok('token 估算：英文按 0.25 token/字符', sandbox.AI.estTokens('abcdefgh') === 2);
      ok('token 估算：空串为 0', sandbox.AI.estTokens('') === 0);

      const realModel = Store.settings().ai.model;
      Store.setSetting('ai.model', 'deepseek-chat');
      ok('deepseek 命中内置价格表（输入 2 / 输出 8 元每百万）',
        sandbox.AI.pricing().in === 2 && sandbox.AI.pricing().out === 8,
        JSON.stringify(sandbox.AI.pricing()));
      Store.setSetting('ai.priceIn', 5);
      Store.setSetting('ai.priceOut', 20);
      const pc = sandbox.AI.pricing();
      ok('设置里填了单价 → 覆盖价格表', pc.in === 5 && pc.out === 20, JSON.stringify(pc));
      Store.setSetting('ai.priceIn', 0);
      Store.setSetting('ai.priceOut', 0);
      Store.setSetting('ai.model', realModel);

      const jc = JM.costEstimate([Store.job(JX.hzGood), Store.job(JX.hzOut)], R18);
      ok('成本预估：输入 token 是正数（按真实提示词拼装估的）', jc.inT > 0, 'inT=' + jc.inT);
      ok('成本预估：输出按经验值估（每岗位一份）', jc.outT === sandbox.AI.OUT_EST_TOKENS * 2);
      const ct = JM.costText([Store.job(JX.hzGood)], R18);
      ok('费用文案：有 token 也有钱，还注明了单价来源',
        ct.indexOf('token') >= 0 && ct.indexOf('¥') >= 0 && ct.indexOf('——') >= 0, ct);
      ok('一分钱以下也显示非零（4 位小数）', JM.fmtCost(0.0004) === '¥0.0004');

      /* 真实 usage 要从模型层一路传到 UI —— 多跳链路只测两端等于没测：
         runTemplate 收 opt.onUsage → callMatch 传 → runBatch 透传 → ui.onUsage 收到 */
      let usageHops = 0;
      const realRun2 = sandbox.AI.runTemplate;
      sandbox.AI.runTemplate = function (tpl, input, opt2) {
        if (opt2 && opt2.onUsage) {
          usageHops++;
          opt2.onUsage({ prompt_tokens: 1000, completion_tokens: 200 });
        }
        return Promise.resolve({
          text: '{}',
          data: { score: 88, verdict: 'x', category: 'qualified',
            matched: [], missing: [], risks: [], suggestions: [], keywordsToAdd: [], greetingHint: '' },
        });
      };
      let uIn = 0, uOut = 0;
      await JM.runBatch({
        ids: [JX.hzGood, JX.hzOut], resume: R18,
        ui: { ok: () => { }, fail: () => { }, askContinue: () => Promise.resolve(true),
          onUsage: (u) => { uIn += u.prompt_tokens; uOut += u.completion_tokens; } },
      });
      eq('每个岗位的 usage 都透传给了 UI（费用实时累计的钩子）', usageHops, 2);
      eq('usage 累计：输入', uIn, 2000);
      eq('usage 累计：输出', uOut, 400);
      sandbox.AI.runTemplate = realRun2;

      /* 确认弹窗要真把费用这行渲染出来（文案在不在只有真渲染才知道） */
      const realReady2 = sandbox.AI.ready;
      sandbox.AI.ready = () => true;
      const rsNow = Store.resumes();
      if (rsNow.length) Store.updateResume(rsNow[0].id, { isDefault: true });
      else Store.addResume(Object.assign({}, R18, { isDefault: true }));
      Store.updateJob(JX.hzGood, { aiVerdict: null, aiVerdictAt: null });   // redo 关着 → 得是"没评过"才会显示费用行
      JM.openBatch({ scopes: [{ label: '采集结果', jobs: [Store.job(JX.hzGood)] }] });
      await tick();
      const modalTxt = U.$$('.mask').map(m => m.textContent || '').join('');
      ok('确认弹窗里渲染出了费用预估（预计消耗 + ¥）',
        modalTxt.indexOf('预计消耗') >= 0 && modalTxt.indexOf('¥') >= 0,
        modalTxt.slice(0, 260));
      U.closeAllModals();
      sandbox.AI.ready = realReady2;

      /* hasnScore 不能用 truthy 判 —— 0 分也是分 */
      ok('0 分算"已评分"（不能用 truthy 判断）', JM.hasScore({ aiVerdict: { score: 0 } }) === true);
      ok('没有 aiVerdict 算"未评分"', JM.hasScore({}) === false);
      eq('unscored 只挑没分的',
        JM.unscored([{ aiVerdict: { score: 0 } }, {}, { aiVerdict: { score: 80 } }]).length, 1);
    } finally {
      sandbox.AI.runTemplate = realRun;
    }
  }

  /* --- 18.6 批量入口的异常路径（不能白点、不能卡死） --- */
  {
    clearToasts();
    const realReady = sandbox.AI.ready;
    const realRun = sandbox.AI.runTemplate;

    // 未配 Key
    sandbox.AI.ready = () => false;
    JM.openBatch({ scopes: [{ label: '全库', jobs: Store.jobs() }] });
    await tick();
    ok('未配模型 → 有明确提示', U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('还没配置模型接口') >= 0));
    ok('未配模型 → 不打开任何弹窗', U.$$('.mask').length === 0, '弹窗数 ' + U.$$('.mask').length);
    clearToasts();
    sandbox.AI.ready = realReady;

    // 没有可评分岗位
    JM.openBatch({ scopes: [{ label: '空的', jobs: [] }] });
    await tick();
    ok('没有候选岗位 → 提示而不是弹一个空进度窗',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('没有可评分的岗位') >= 0));
    eq('且没有弹窗', U.$$('.mask').length, 0);
    clearToasts();

    // 一份简历都没有
    const savedResumes = Store.resumes();
    savedResumes.slice().forEach(r => Store.removeResume(r.id));
    JM.openBatch({ scopes: [{ label: '全库', jobs: Store.jobs().slice(0, 2) }] });
    await tick();
    ok('没有简历 → 引导去简历素材库',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('简历') >= 0),
      U.$$('#toasts .toast').map(t => t.textContent).join(' | '));
    eq('没有简历 → 不弹进度窗', U.$$('.mask').length, 0);
    clearToasts();
    sandbox.AI.runTemplate = realRun;

    /* 有默认简历 → 直接进设置弹窗（不该再多问一次用哪份） */
    savedResumes.forEach(r => Store.addResume(r));
    Store.updateResume(savedResumes[0].id, { isDefault: true });
    JM.openBatch({ scopes: [{ label: '全库', jobs: Store.jobs().slice(0, 2) }] });
    await tick();
    ok('有默认简历 → 直接进「开始评分」设置弹窗', U.$$('.mask').length === 1);
    ok('设置弹窗里写清了用哪份简历、几个岗位、预计多久',
      U.$('.mask .modal').textContent.indexOf('将用') >= 0 &&
      U.$('.mask .modal').textContent.indexOf('预计') >= 0,
      U.$('.mask .modal').textContent.slice(0, 160));
    ok('给了「重新评分」勾选（默认跳过已评分的）',
      U.$('.mask .modal').textContent.indexOf('重新评分') >= 0);
    U.closeAllModals();
    await tick();
    eq('弹窗能正常关掉', U.$$('.mask').length, 0);
  }

  /* --- 18.7 评分后与「待跟进」闭环 --- */
  {
    /* 「高匹配还没投」的口径是 aiVerdict.score >= 75 且没投递，
       所以这里挑一个没投过、也没被评分的岗位，评完分之后它必须冒出来 */
    const target = mk18({ title: '闭环验证岗', company: '闭环公司', location: '杭州' });
    const before = FollowUp.build().filter(x => x.cat === 'highMatchNoApp' && x.jobId === target).length;
    eq('评分前：这个岗位不在「高匹配还没投」里', before, 0);

    Store.updateJob(target, {
      aiVerdict: { score: 88, verdict: '强匹配', category: 'qualified', resumeId: R18.id },
      aiVerdictAt: U.now(),
    });
    const after = FollowUp.build().filter(x => x.cat === 'highMatchNoApp' && x.jobId === target).length;
    eq('评完分 → 自动进「高匹配还没投」（采集→推荐→投递→跟进闭环）', after, 1);
  }

  /* --- 18.8 采集页：导入即评分 --- */
  {
    const collect = Views.collect;
    const savedResult = collect._state.result;

    /* 造一份"采集结果"，其中一条与库里已有岗位同键（走去重合并），一条是新的 */
    const dupRec = { 岗位: '杭州运营A', 公司: '杭州甲', 城市: '杭州', 薪资: '12-18K' };
    const newRec = { 岗位: '采集新岗位X', 公司: '采集公司X', 城市: '杭州', 薪资: '20-30K' };
    collect._state.result = { source: '（测试）', jobs: [dupRec, newRec] };
    collect._state.base = 'http://127.0.0.1:8738';

    const mapped = collect._resultStoreJobs();
    ok('采集结果能按去重键对上库里的岗位', mapped.some(j => j.id === JX.hzGood));
    eq('还没导入的那条不会被算进来（只统计已入库的）', mapped.length, 1);

    /* 导入：新增 1 个 + 合并 1 个 */
    Store.updateJob(JX.hzGood, { aiVerdict: null, aiVerdictAt: null });
    clearToasts();
    await collect._import();       // 异步（分批导入），必须 await
    await tick();
    ok('导入后的 toast 追加了评分引导',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('还没评分') >= 0),
      U.$$('#toasts .toast').map(t => t.textContent).join(' | '));
    ok('toast 上直接给了「现在就评分」的按钮（不用自己去找入口）',
      U.$$('#toasts .toast button').some(b => (b.textContent || '').indexOf('现在就评分') >= 0));

    const after = collect._resultStoreJobs();
    eq('导入后两条都能对上库里的岗位', after.length, 2);
    eq('两条都还没评分 → 都算待评分', collect._resultUnscored().length, 2);

    /* 评过分的不能再算「待评分」—— 否则每次导入都会把已评完的重新送进去烧 token */
    Store.updateJob(JX.hzGood, { aiVerdict: { score: 88 }, aiVerdictAt: Date.now() });
    eq('给其中一条评过分 → 待评分只剩 1 条', collect._resultUnscored().length, 1);
    Store.updateJob(JX.hzGood, { aiVerdict: null, aiVerdictAt: null });

    /* 空结果时不提示 */
    collect._state.result = { source: '（测试）', jobs: [] };
    eq('采集结果为空 → 没有未评分岗位', collect._resultUnscored().length, 0);

    /* 「给结果一键评分」在没有可评岗位时给提示，而不是弹空进度窗 */
    clearToasts();
    collect._scoreResults([]);
    await tick();
    ok('没有可评分的岗位 → 给提示，不弹进度窗',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('都已经评过分') >= 0) && U.$$('.mask').length === 0);
    clearToasts();

    collect._state.result = savedResult;
    collect._state.base = null;
  }

  /* --- 18.8b 采集页：结果筛选 --- */
  {
    const collect = Views.collect;
    const CF = collect._cf;
    const saved = collect._state.result;

    /* 造一批有城市/行业/薪资差异的采集结果 */
    collect._state.result = { source: '（测试）', jobs: [
      { 岗位: '新媒体运营', 公司: '甲公司', 城市: '杭州', 行业: '互联网', 薪资: '12-18K',
        福利: '五险一金,双休,年终奖', HR活跃度: '今日活跃' },
      { 岗位: '产品经理',   公司: '乙公司', 城市: '杭州', 行业: '互联网', 薪资: '25-40K',
        福利: '五险一金,弹性工作', HR活跃度: '本周活跃' },
      { 岗位: '销售经理',   公司: '丙公司', 城市: '上海', 行业: '消费品', 薪资: '8-12K',
        福利: '五险,房补', HR活跃度: '本月活跃' },
      { 岗位: '财务专员',   公司: '丁公司', 城市: '杭州', 行业: '人力资源', 薪资: '面议',
        福利: '五险一金,餐补', HR活跃度: '3日内活跃' },
    ] };

    const jobs = collect._resultJobs();
    eq('采集结果全部转成标准岗位对象', jobs.length, 4);

    const cities = collect._resultCities(jobs);
    ok('城市下拉能枚举出「杭州」「上海」', cities.indexOf('杭州') >= 0 && cities.indexOf('上海') >= 0, cities.join('/'));
    const inds = collect._resultIndustries(jobs);
    eq('行业下拉去重后 3 个', inds.length, 3);

    /* 城市筛选 */
    CF.city = '杭州'; CF.industry = ''; CF.salary = ''; CF.scored = ''; CF.kw = ''; CF.sort = 'default';
    eq('按城市「杭州」筛 → 3 个', collect._filterResults(jobs).length, 3);
    CF.city = '上海';
    eq('按城市「上海」筛 → 1 个', collect._filterResults(jobs).length, 1);
    CF.city = '';

    /* 薪资筛选：面议岗位要能筛出来（结果页档位与参数卡统一为 BOSS 同款档） */
    CF.salary = 'none';
    eq('按「未标薪资」筛 → 只留面议那 1 个', collect._filterResults(jobs).length, 1);
    CF.salary = '10-20K';
    const sal10 = collect._filterResults(jobs);
    eq('按「10-20K」筛 → 命中 12-18K 那 1 个', sal10.length, 1);
    eq('10-20K 命中的是「新媒体运营」', sal10[0].title, '新媒体运营');
    CF.salary = '';

    /* 关键词（自然语言）筛选 */
    CF.kw = '运营';
    const kw = collect._filterResults(jobs);
    eq('关键词「运营」命中「新媒体运营」', kw.length, 1);
    eq('命中的是新媒体运营', kw[0].title, '新媒体运营');
    CF.kw = '';

    /* 排序 */
    CF.sort = 'salary';
    const bySal = collect._filterResults(jobs);
    eq('按薪资降序排，第一个是 25-40K 的产品经理', bySal[0].title, '产品经理');
    CF.sort = 'company';
    const byCo = collect._filterResults(jobs);
    ok('按公司排序返回同批 4 个', byCo.length === 4);
    CF.sort = 'default';

    /* 福利待遇筛选（多选，本地筛） */
    CF.welfare = ['双休'];
    const w1 = collect._filterResults(jobs);
    eq('按福利「双休」筛 → 命中 1 个', w1.length, 1);
    eq('福利「双休」命中的是新媒体运营', w1[0].title, '新媒体运营');
    CF.welfare = ['五险一金'];
    const w2 = collect._filterResults(jobs);
    eq('按福利「五险一金」筛 → 命中 3 个（甲/乙/丁）', w2.length, 3);
    CF.welfare = [];

    /* BOSS 活跃度筛选（单选，本地筛）。按「时间包含」判定：选「本周活跃」时，
       「今日/3日内/本周」都命中（评审 P2-4 修的反向包含 bug）。 */
    CF.active = '今日活跃';
    const a1 = collect._filterResults(jobs);
    eq('按活跃度「今日活跃」筛 → 命中 1 个', a1.length, 1);
    eq('活跃度命中的是新媒体运营', a1[0].title, '新媒体运营');
    CF.active = '本周活跃';
    const a2 = collect._filterResults(jobs);
    eq('按活跃度「本周活跃」筛 → 命中 3 个（今日/3日内/本周都算本周内）', a2.length, 3);
    eq('活跃度「本周活跃」命中的第一个是新媒体运营（今日活跃最靠前）', a2[0].title, '新媒体运营');
    CF.active = '本月活跃';
    const a3 = collect._filterResults(jobs);
    eq('按活跃度「本月活跃」筛 → 命中全部 4 个（时间包含）', a3.length, 4);
    CF.active = '';

    /* 清空筛选后 hasFilter 应为 false */
    CF.kw = ''; CF.city = ''; CF.industry = ''; CF.salary = ''; CF.scored = '';
    CF.welfare = []; CF.active = '';
    ok('清空后没有生效筛选', collect._collectHasFilter() === false);
    CF.kw = '运营';
    ok('有关键词时算有筛选', collect._collectHasFilter() === true);
    CF.kw = '';
    CF.welfare = ['双休'];
    ok('有福利筛选时算有筛选', collect._collectHasFilter() === true);
    CF.welfare = [];
    CF.active = '今日活跃';
    ok('有活跃度筛选时算有筛选', collect._collectHasFilter() === true);
    CF.active = '';

    /* 区 / 商圈精筛（本轮新增）。
       关键：**选项只来自这批结果真实采到的** —— 不能把内置行政区划并进来，
       否则会冒出「选了显示 0 条」的假选项，用户会以为筛选坏了。 */
    collect._state.result = { source: '（测试）', jobs: [
      { 岗位: '新媒体运营', 公司: '甲公司', 城市: '杭州', 区域: '滨江区', 商圈: '长河',
        行业: '互联网', 薪资: '12-18K' },
      { 岗位: '产品经理',   公司: '乙公司', 城市: '杭州', 区域: '西湖区', 商圈: '文三路',
        行业: '互联网', 薪资: '25-40K' },
      { 岗位: 'UI设计',     公司: '戊公司', 城市: '杭州', 区域: '滨江区', 商圈: '江南大道',
        行业: '互联网', 薪资: '10-15K' },
      // 这条**故意不写区域/商圈** —— 模拟 BOSS 没吐出来。它有城市、有岗位名，
      // 是「没数据」不是「不匹配」，所以筛选时必须留着并标出来。
      { 岗位: '数据运营',   公司: '己公司', 城市: '杭州', 行业: '互联网', 薪资: '9-14K' },
    ] };
    const geoJobs = collect._resultJobs();
    eq('地理用样本 4 条都转成标准岗位对象', geoJobs.length, 4);

    const dists = collect._resultDistricts(geoJobs, '');
    eq('区候选只来自真实采到的（滨江区/西湖区，2 个）', dists.length, 2);
    ok('区候选含滨江区', dists.indexOf('滨江区') >= 0, dists.join('/'));
    ok('区候选含西湖区', dists.indexOf('西湖区') >= 0, dists.join('/'));
    ok('⛔ 区候选不含内置行政区划里没采到的（如上城区）', dists.indexOf('上城区') < 0, dists.join('/'));
    eq('按城市「杭州」看区候选，还是这 2 个', collect._resultDistricts(geoJobs, '杭州').length, 2);
    eq('按城市「上海」看区候选 → 0 个（这批没有上海岗位）',
      collect._resultDistricts(geoJobs, '上海').length, 0);

    const bas = collect._resultBizAreas(geoJobs, []);
    eq('商圈候选去重后 3 个', bas.length, 3);
    ok('商圈候选含长河', bas.indexOf('长河') >= 0, bas.join('/'));
    const basBin = collect._resultBizAreas(geoJobs, ['滨江区']);
    eq('限定「滨江区」后商圈只剩该区的 2 个', basBin.length, 2);
    ok('滨江区的商圈含长河 / 江南大道',
      basBin.indexOf('长河') >= 0 && basBin.indexOf('江南大道') >= 0, basBin.join('/'));
    ok('滨江区的商圈不含西湖区的「文三路」', basBin.indexOf('文三路') < 0, basBin.join('/'));

    /* 精筛：命中 2 个滨江区岗位 + 1 个「没采到区」的（默认保留），共 3 个；
       西湖区那条被排除。 */
    CF.district = ['滨江区']; CF.bizArea = [];
    eq('cfGeo 把多选区组装成 districts 数组', collect._cfGeo().districts.join('/'), '滨江区');
    const gd = collect._filterResults(geoJobs);
    eq('按「滨江区」精筛 → 2 个滨江 + 1 个没采到区的都留着', gd.length, 3);
    ok('西湖区那条被排出去了', !gd.some(j => j.title === '产品经理'), gd.map(j => j.title).join('/'));
    const unkD = collect._listUnknownGeo(gd);
    eq('其中 1 个是「没采到区/商圈」才被放行的', unkD.n, 1);

    /* 商圈精筛比区更细（命中的只有滨江那两个里带「长河」的 1 条） */
    CF.district = []; CF.bizArea = ['长河'];
    const gb = collect._filterResults(geoJobs);
    eq('按商圈「长河」精筛 → 1 个命中 + 1 个没采到的留着', gb.length, 2);
    ok('命中商圈的是新媒体运营', gb.some(j => j.title === '新媒体运营'), gb.map(j => j.title).join('/'));

    /* 区 + 商圈同时设：两个条件是「与」关系 */
    CF.district = ['西湖区']; CF.bizArea = ['长河'];
    eq('区=西湖区 与 商圈=长河 同时设 → 都不满足，只剩没采到的那条',
      collect._filterResults(geoJobs).length, 1);

    CF.district = []; CF.bizArea = [];
    ok('区/商圈清空后 cfGeo 返回 null', collect._cfGeo() === null);
    eq('清空后 4 条全在', collect._filterResults(geoJobs).length, 4);

    CF.district = ['滨江区'];
    ok('只设区也算有筛选条件（导入按钮会变成导筛选结果）', collect._collectHasFilter() === true);
    collect._clearCF();
    eq('clearCF 把区清成空数组', collect._cfGeo(), null);
    ok('clearCF 把 bizArea 也清成空数组', Array.isArray(CF.bizArea) && CF.bizArea.length === 0);

    /* seedCFFromForm：参数卡里那些「不进 BOSS 搜索条件」的项，采集跑完要搬进结果页筛选 */
    const savedForm = collect._state.form;
    collect._state.form = { city: '杭州', district: ['滨江区'], bizArea: ['长河'],
      welfare: ['双休'], activeTime: '今日活跃' };
    collect._seedCFFromForm();
    eq('采集跑完把参数卡的区搬进结果页筛选', CF.district.join('/'), '滨江区');
    eq('采集跑完把参数卡的商圈搬进结果页筛选', CF.bizArea.join('/'), '长河');
    eq('采集跑完把参数卡的福利搬进结果页筛选', (CF.welfare || []).join('/'), '双休');
    eq('采集跑完把参数卡的活跃度搬进结果页筛选', CF.active, '今日活跃');
    collect._clearCF();
    collect._state.form = savedForm || { city: '', district: [], bizArea: [], welfare: [], activeTime: '' };

    /* 参数体检第 ④ 条：区/商圈跟采集城市对不上 → 提前说，别等筛成空列表才发现 */
    const issGeo = collect._paramIssues(
      { city: '上海', keywords: '运营', district: ['滨江区'], bizArea: [] },
      { cities: ['上海'], expectJobs: [], salaryMin: null });
    ok('采上海却选了杭州的「滨江区」→ 体检报出来',
      issGeo.some(i => i.code === 'geo'), JSON.stringify(issGeo.map(i => i.code)));
    const issOk = collect._paramIssues(
      { city: '杭州', keywords: '运营', district: ['滨江区'], bizArea: [] },
      { cities: ['杭州'], expectJobs: [], salaryMin: null });
    ok('城市与区对得上 → 不误报 geo', !issOk.some(i => i.code === 'geo'),
      JSON.stringify(issOk.map(i => i.code)));
    const issBiz = collect._paramIssues(
      { city: '杭州', keywords: '运营', district: [], bizArea: ['长河'] },
      { cities: ['杭州'], expectJobs: [], salaryMin: null });
    ok('只填商圈（商圈名本来就未必是区名）→ 不误报',
      !issBiz.some(i => i.code === 'geo'), JSON.stringify(issBiz.map(i => i.code)));

    collect._state.result = saved;
  }

  /* --- 18.8c 采集页：本地「合适度」分级（结果卡上的分级条 + 下拉）--- */
  {
    const collect = Views.collect;
    const CF = collect._cf;
    const saved = collect._state.result;

    /* 刻意挑两种「蹭词」岗位（销售 / 财务）—— 结果页也得能看出它们被硬性剔除 */
    const RECORDS = [
      { 岗位: '新媒体运营', 公司: '甲公司', 城市: '杭州', 行业: '互联网', 薪资: '12-18K',
        福利: '五险一金,双休,年终奖', HR活跃度: '今日活跃' },
      { 岗位: '产品经理',   公司: '乙公司', 城市: '杭州', 行业: '互联网', 薪资: '25-40K',
        福利: '五险一金,弹性工作', HR活跃度: '本周活跃' },
      { 岗位: '销售经理',   公司: '丙公司', 城市: '上海', 行业: '消费品', 薪资: '8-12K',
        福利: '五险,房补', HR活跃度: '本月活跃' },
      { 岗位: '财务专员',   公司: '丁公司', 城市: '杭州', 行业: '人力资源', 薪资: '面议',
        福利: '五险一金,餐补', HR活跃度: '3日内活跃' },
    ];
    collect._state.result = { source: '（测试）', jobs: RECORDS };
    const jobs = collect._resultJobs();
    eq('合适度：采集结果转成标准岗位对象', jobs.length, 4);

    collect._cfFitAll(jobs);
    const f0 = collect._cfFitOf(jobs[0]);
    ok('_cfFitOf 给出完整打分（分数 / 分级 / 五维齐全）',
      !!f0 && typeof f0.total === 'number' && !!f0.level && !!f0.dims &&
      typeof f0.dims.direction === 'number',
      JSON.stringify(f0 && { total: f0.total, lv: f0.level.key }));

    const sum = collect._fitSummary(jobs);
    eq('分级计数 + 剔除 = 结果总数', sum.A + sum.B + sum.C + sum.D + sum.drop, jobs.length);
    ok('「销售经理」被硬性剔除（蹭「销售」又不是运营方向）',
      collect._cfFitOf(jobs.filter(j => j.title === '销售经理')[0]).gate.drop === true);
    ok('「财务专员」被硬性剔除',
      collect._cfFitOf(jobs.filter(j => j.title === '财务专员')[0]).gate.drop === true);
    eq('剔除数 = 2', sum.drop, 2);

    CF.kw = ''; CF.city = ''; CF.industry = ''; CF.salary = ''; CF.scored = '';
    CF.welfare = []; CF.active = ''; CF.sort = 'default'; CF.hideDrop = false;

    /* 分级筛的条数必须和分级条上的数字对得上（不一致就是"条数骗人"） */
    CF.fit = 'A';
    eq('按 A 级筛 → 条数 = 分级条上的 A', collect._filterResults(jobs).length, sum.A);
    CF.fit = 'C';
    eq('按 C 级筛 → 条数 = 分级条上的 C', collect._filterResults(jobs).length, sum.C);
    CF.fit = 'D';
    ok('fit 分级筛会把被剔除的排除在外（不会混进 D）',
      collect._filterResults(jobs).every(j => collect._cfFitOf(j).gate.drop === false));
    CF.fit = '';

    CF.hideDrop = true;
    eq('隐藏被剔除的 → 剩 总数 - 剔除数', collect._filterResults(jobs).length, jobs.length - sum.drop);
    ok('隐藏后列表里没有「销售经理」',
      collect._filterResults(jobs).every(j => j.title !== '销售经理'));
    CF.hideDrop = false;

    CF.sort = 'fit';
    const sorted = collect._filterResults(jobs);
    ok('按合适度排序：被剔除的一律沉底',
      sorted.length === jobs.length &&
      collect._cfFitOf(sorted[0]).gate.drop === false &&
      collect._cfFitOf(sorted[sorted.length - 1]).gate.drop === true,
      sorted.map(j => j.title + ':' + collect._cfFitOf(j).total).join(' | '));
    CF.sort = 'default';

    ok('只设「合适度」也算有筛选',
      (function () { CF.fit = 'B'; const v = collect._collectHasFilter(); CF.fit = ''; return v; })());
    ok('只设「隐藏被剔除」也算有筛选',
      (function () { CF.hideDrop = true; const v = collect._collectHasFilter(); CF.hideDrop = false; return v; })());
    ok('clearCF 会把 fit / hideDrop 一起清掉',
      (function () {
        CF.fit = 'A'; CF.hideDrop = true;
        collect._clearCF();
        return CF.fit === '' && CF.hideDrop === false;
      })());

    /* --- 🎯 切合值：连续「≥ N 分」门槛（用户要的自由匹配度范围 60-100 / 80-100）---
       分级是粗档（A=80-100 / B=60-79 / C=40-59），切合值是连续精调。
       「≥60」= A+B 两级一起，「≥80」= 只有 A。下面钉死这个口径。 */
    CF.minFit = 60;
    eq('切合值 ≥60 → 只剩 A+B 级（≥60 分）', collect._filterResults(jobs).length, sum.A + sum.B);
    CF.minFit = 80;
    eq('切合值 ≥80 → 只剩 A 级（≥80 分）', collect._filterResults(jobs).length, sum.A);
    /* ⛔ 这条是「切合值过滤」的分叉断言：设 100（无人能达标）→ 必须 0 条。
       没有它，「≥60」在「无低于 60 分的非 drop 岗位」的数据上是个 no-op ——
       变异把过滤改坏（不过滤低于 minFit 的）时，结果不变，测试照样绿 = 假绿。 */
    CF.minFit = 100;
    eq('切合值 = 100（无人达标）→ 0 条', collect._filterResults(jobs).length, 0);
    CF.minFit = 0;
    eq('切合值 = 0（不限）→ 全部回来', collect._filterResults(jobs).length, jobs.length);
    ok('只设切合值也算有筛选（✕ 清空筛选按钮要出现）',
      (function () { CF.minFit = 60; const v = collect._collectHasFilter(); CF.minFit = 0; return v; })());
    ok('clearCF 会把切合值一起清掉',
      (function () {
        CF.minFit = 60;
        collect._clearCF();
        const v = CF.minFit === 0;
        CF.minFit = 0;   // 兜底：不管 clearCF 清没清，都不污染后续 UI 测试
        return v;
      })());
    ok('切合值落盘：写 70 读回 70（F5 之后还在）',
      (function () {
        collect._writeMinFit(70);
        const v = collect._readMinFit();
        collect._writeMinFit(0);   // 还原，别污染后续断言
        return v === 70;
      })());
    ok('切合值落盘防越界：写 200 夹回 100（否则 ≥200 恒 false = 好岗位也滤光）',
      (function () {
        collect._writeMinFit(200);
        const v = collect._readMinFit();
        collect._writeMinFit(0);
        return v === 100;
      })());

    /* --- 🎯 简历匹配（P2）：服务端 match_score + 原因挂载 + 匹配度区间过滤 --- */
    const savedMatch = collect._state.result;
    collect._state.result = { source: '（测试）', jobs: [
      { 岗位: '新媒体运营', 公司: '甲公司', 城市: '杭州', 薪资: '12-18K', link: 'https://a/1.html',
        _matchScore: 82, _matchReason: '技能高度契合', _matchMissing: ['SQL'] },
      { 岗位: '产品经理', 公司: '乙公司', 城市: '杭州', 薪资: '25-40K', link: 'https://a/2.html',
        _matchScore: 65, _matchReason: '经验略欠', _matchMissing: ['B端产品'] },
      { 岗位: '销售经理', 公司: '丙公司', 城市: '上海', 薪资: '8-12K', link: 'https://a/3.html',
        _matchScore: 45, _matchReason: '方向不符' },
      { 岗位: '财务专员', 公司: '丁公司', 城市: '杭州', 薪资: '面议', link: 'https://a/4.html' },
    ] };
    const mjobs = collect._resultJobs();
    eq('简历匹配分挂上：第 1 条 matchScore=82', mjobs[0].matchScore, 82);
    eq('原因也挂上：第 1 条 matchReason', mjobs[0].matchReason, '技能高度契合');
    ok('缺项数组挂上：第 1 条 matchMissing[0]=SQL',
      Array.isArray(mjobs[0].matchMissing) && mjobs[0].matchMissing[0] === 'SQL');
    eq('没有匹配分的岗位 matchScore 为 undefined', mjobs[3].matchScore === undefined, true);

    CF.matchMin = 60; CF.matchMax = null;
    eq('匹配度 ≥60 → 2 条（82/65）', collect._filterResults(mjobs).length, 2);
    CF.matchMin = 80; CF.matchMax = 100;
    let mf = collect._filterResults(mjobs);
    eq('匹配度 80~100 → 1 条', mf.length, 1);
    eq('命中的是新媒体运营', mf[0].title, '新媒体运营');
    CF.matchMin = 90; CF.matchMax = 100;
    eq('匹配度 90~100（无人达标）→ 0 条（分叉断言，防假绿）',
      collect._filterResults(mjobs).length, 0);
    CF.matchMin = null; CF.matchMax = null;
    eq('清空区间 → 全部回来', collect._filterResults(mjobs).length, mjobs.length);

    ok('只设匹配度区间也算有筛选（✕ 清空筛选按钮要出现）',
      (function () { CF.matchMin = 60; const v = collect._collectHasFilter(); CF.matchMin = null; return v; })());
    ok('clearCF 会把匹配度区间一起清掉',
      (function () {
        CF.matchMin = 60; CF.matchMax = 100;
        collect._clearCF();
        const v = CF.matchMin === null && CF.matchMax === null;
        CF.matchMin = null; CF.matchMax = null;   // 兜底，防污染后续 UI 测试
        return v;
      })());

    collect._state.result = savedMatch;

    /* --- UI：结果卡上真有分级条和「合适度」下拉 --- */
    const stubFit = (url) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      let body = { ok: false, error: 'no stub: ' + p };
      if (p.indexOf('/api/ping') === 0) body = fakePing;
      else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
      else if (p.indexOf('/api/jobs') === 0) body = fakeJobs;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    await withFetch(stubFit, () => {
      App.go('collect');
      return tick().then(tick).then(tick).then(tick).then(tick).then(tick);
    });

    if (!U.$('#cResult')) {
      ok('采集结果卡 #cResult 没渲染出来（后面的 UI 断言跳过）', false,
        U.$('#view').textContent.slice(0, 120));
    } else {
      collect._state.result = { source: '（测试）', jobs: RECORDS };
      collect._paintResult();
      ok('结果卡渲染出合适度分级条 .fitbar', U.$$('#view .fitbar').length === 1,
        String(U.$$('#view .fitbar').length));
      eq('分级条上有 4 个 A/B/C/D 胶囊',
        U.$$('#view .fitbar .fchip').filter(c => /^[ABCD] /.test(c.textContent)).length, 4);
      ok('分级条上还有「剔除 N」胶囊',
        U.$$('#view .fitbar .fchip').some(c => /剔除/.test(c.textContent)),
        JSON.stringify(U.$$('#view .fitbar .fchip').map(c => c.textContent)));
      ok('分级条上写着数字（不是一排 0）',
        U.$$('#view .fitbar .fchip-n').some(n => Number(String(n.textContent).trim()) > 0));
      ok('筛选栏里有「合适度不限」下拉',
        U.$$('#view select').some(s => /合适度不限/.test(s.textContent || '')));
      ok('排序下拉里有「合适度」这项',
        U.$$('#view select').some(s => /合适度/.test(s.textContent || '')));
      ok('结果卡没被错误兜底卡顶掉',
        U.$('#view').textContent.indexOf('这个页面渲染出错了') < 0);

      /* 「合适度，每一条标明原因」在采集页也要成立：
         在采集页就能看清成色，不用先导库再回来筛。 */
      ok('采集页：每条结果都带合适度徽标',
        U.$$('#view .job').length > 0 &&
        U.$$('#view .job').every(c => !!c.querySelector('.fbadge')),
        U.$$('#view .job').length + ' 条 / ' +
        U.$$('#view .job').filter(c => c.querySelector('.fbadge')).length + ' 条带徽标');
      ok('采集页：每条结果都写了原因 .fitreason',
        U.$$('#view .job').every(c => ((c.querySelector('.fitreason') || {}).textContent || '').length > 4));
      ok('采集页：被剔除的那两条给的是**原因**而不是 0 分',
        U.$$('#view .fitreason-drop').length === 2 &&
        U.$$('#view .fitreason-drop').every(x => /🚫/.test(x.textContent || '')),
        U.$$('#view .fitreason-drop').map(x => x.textContent).join(' | '));
      ok('采集页：卡片上摆了五维得分',
        U.$$('#view .fitparts .fpart').length >= 5,
        String(U.$$('#view .fitparts .fpart').length));

      /* 真点「剔除」胶囊 → 变成「已隐藏」，列表少 2 条 */
      const before = U.$$('#view .job').length;
      const dropChip = U.$$('#view .fitbar .fchip').filter(c => /剔除/.test(c.textContent))[0];
      dropChip.click();
      ok('点「剔除 2」胶囊 → 状态变成「已隐藏」',
        /已隐藏/.test(U.$$('#view .fitbar .fchip').map(c => c.textContent).join('|')),
        U.$$('#view .fitbar .fchip').map(c => c.textContent).join('|'));
      eq('点完之后结果列表少了 2 条', U.$$('#view .job').length, before - 2,
        before + ' → ' + U.$$('#view .job').length);

      /* 真点 A 级胶囊 → 只留 A 级。
         ⚠️ 条数**不写死**：样本换一个 A 级数量就变了，写死只会掩盖"胶囊数字和列表对不上"。
         改成跟 JS 侧同级判定对齐 —— 两处不一致才是要抓的 bug。 */
      CF.hideDrop = false;
      collect._paintResult();
      const aChip = U.$$('#view .fitbar .fchip').filter(c => /^A /.test(c.textContent))[0];
      aChip.click();
      ok('点 A 级胶囊 → CF.fit 变成 A', CF.fit === 'A', String(CF.fit));
      ok('点了之后 A 级胶囊是选中态',
        U.$$('#view .fitbar .fchip').some(c => /^A /.test(c.textContent) && /(^|\s)on(\s|$)/.test(c.className || '')),
        U.$$('#view .fitbar .fchip').map(c => c.className + ':' + c.textContent).join(' | '));
      const aTitles = jobs.filter(j => {
        const r = collect._cfFitOf(j);
        return !r.gate.drop && r.level.key === 'A';
      }).map(j => j.title);
      eq('只剩 A 级 → 条数 = JS 侧判定的 A 级数量', U.$$('#view .job').length, aTitles.length,
        'A 级：' + aTitles.join('/'));
      ok('留下的确实都是 A 级岗位（不是别的级混进来）',
        U.$$('#view .job').every(c => aTitles.some(t => c.textContent.indexOf(t) >= 0)),
        '列表：' + U.$$('#view .job').map(c => c.textContent.slice(0, 18)).join(' | '));
      ok('被硬性剔除的岗位一条都没留下',
        U.$$('#view .job').every(c => c.textContent.indexOf('销售经理') < 0 &&
          c.textContent.indexOf('财务专员') < 0));

      /* 🎯 切合值输入框：真渲染 + 真输入（连续「≥ N 分」自由范围） */
      CF.fit = ''; CF.minFit = 0;
      collect._paintResult();
      const minFitInp = U.$('#view input[data-focus-key="cf-minfit"]');
      ok('分级条上有「切合值」输入框', !!minFitInp, minFitInp ? '找到' : '没找到');
      if (minFitInp) {
        minFitInp.value = '80';
        minFitInp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 260));   // debounce 200ms，等它落值
        ok('输入切合值 80 → CF.minFit 落成 80', CF.minFit === 80, String(CF.minFit));
        collect._paintResult();
        eq('切合值 80 → 列表只剩 A 级', U.$$('#view .job').length, aTitles.length,
          U.$$('#view .job').length + ' / 期望 ' + aTitles.length);
        ok('输入后分级条出现「达标 N」胶囊',
          U.$$('#view .fitbar .fchip').some(c => /达标/.test(c.textContent)),
          U.$$('#view .fitbar .fchip').map(c => c.textContent).join('|'));
        CF.minFit = 0;
        collect._paintResult();
      }
    }

    collect._state.result = saved;
    CF.fit = ''; CF.hideDrop = false; CF.sort = 'default';
    CF.kw = ''; CF.city = ''; CF.industry = ''; CF.salary = ''; CF.scored = '';
    CF.welfare = []; CF.active = '';
    clearToasts();
  }

  /* --- 18.8d 采集页：区 / 商圈精筛的 UI（真渲染 + 真点） --- */
  {
    const collect = Views.collect;
    const CF = collect._cf;
    const saved = collect._state.result;

    /* 一批有区/商圈的采集结果 + 一条故意没有区/商圈的（模拟 BOSS 没吐出来） */
    const RECORDS = [
      { 岗位: '新媒体运营', 公司: '甲公司', 城市: '杭州', 区域: '滨江区', 商圈: '长河',
        行业: '互联网', 薪资: '12-18K', 福利: '五险一金,双休' },
      { 岗位: 'UI设计师',   公司: '戊公司', 城市: '杭州', 区域: '滨江区', 商圈: '江南大道',
        行业: '互联网', 薪资: '10-15K', 福利: '五险一金' },
      { 岗位: '产品经理',   公司: '乙公司', 城市: '杭州', 区域: '西湖区', 商圈: '文三路',
        行业: '互联网', 薪资: '25-40K', 福利: '五险一金' },
      { 岗位: '数据运营',   公司: '己公司', 城市: '杭州', 行业: '互联网', 薪资: '9-14K',
        福利: '五险一金' },
    ];

    const stub = (url) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      let body = { ok: false, error: 'no stub: ' + p };
      if (p.indexOf('/api/ping') === 0) body = fakePing;
      else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
      else if (p.indexOf('/api/jobs') === 0) body = { ok: true, source: '（测试）', jobs: RECORDS };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    await withFetch(stub, () => {
      App.go('collect');
      return tick().then(tick).then(tick).then(tick).then(tick).then(tick);
    });
    collect._state.result = { source: '（测试）', jobs: RECORDS };
    collect._paintResult();

    if (!U.$('#cResult')) {
      ok('采集结果卡 #cResult 没渲染出来（后面的地理 UI 断言跳过）', false,
        U.$('#view').textContent.slice(0, 120));
    } else {
      /* ⚠️ 选择器**必须收窄到 #cResult 内** —— 上面的「② 采集参数」卡里也有一组
         `.geo-chips`（期望地点，候选含内置行政区划），不加范围会把它一起数进来，
         于是"结果页只有真实采到的选项"这条断言永远抓不到东西。 */
      const chips = () => U.$$('#cResult .geo-chips .geo-chip')
        .map(c => String(c.textContent).replace(/\s*✕$/, ''));
      const jobTitles = () => U.$$('#cResult .job').map(c => c.textContent);
      const before = U.$$('#cResult .job').length;

      ok('结果筛选栏里渲染出了「📍 区（多选）」',
        U.$$('#cResult .geo-lb').some(l => /📍 区/.test(l.textContent)),
        U.$$('#cResult .geo-lb').map(l => l.textContent).join('/'));
      ok('结果筛选栏里渲染出了「📍 商圈（多选）」',
        U.$$('#cResult .geo-lb').some(l => /📍 商圈/.test(l.textContent)),
        U.$$('#cResult .geo-lb').map(l => l.textContent).join('/'));
      ok('区 chips 里有真实采到的「滨江区」和「西湖区」',
        chips().indexOf('滨江区') >= 0 && chips().indexOf('西湖区') >= 0, chips().join('/'));
      /* ⛔ 内置行政区划**不并进来** —— 否则会冒出「选了显示 0 条」的假选项 */
      ok('⛔ 区 chips 里没有内置行政区划里没采到的「上城区」',
        chips().indexOf('上城区') < 0, chips().join('/'));
      ok('商圈 chips 里有真实采到的「长河」', chips().indexOf('长河') >= 0, chips().join('/'));

      eq('未筛时 4 条都在', before, 4);

      /* 真点「滨江区」→ 2 条滨江 + 1 条没采到区的留着，西湖区那条走 */
      const binChip = U.$$('#cResult .geo-chips .geo-chip')
        .filter(c => c.textContent.indexOf('滨江区') === 0)[0];
      binChip.click();
      eq('点「滨江区」→ CF.district 记成数组', (CF.district || []).join('/'), '滨江区');
      eq('点「滨江区」→ 列表剩 3 条（2 滨江 + 1 条没采到区的）', U.$$('#cResult .job').length, 3);
      ok('西湖区的「产品经理」被排掉了',
        jobTitles().every(t => t.indexOf('产品经理') < 0),
        jobTitles().map(t => t.slice(0, 14)).join(' | '));
      ok('被放行的那条挂了「📍 区未知」标记（不是假装匹配上了）',
        U.$$('#cResult .job .tag').some(t => /区未知/.test(t.textContent)),
        U.$$('#cResult .job .tag').map(t => t.textContent).join('/'));
      ok('计数行说明了「其中 N 个没采到区/商圈，先留着」',
        /没采到区\/商圈，先留着/.test(U.$('#cResult').textContent),
        U.$('#cResult').textContent.slice(0, 200));

      /* 再点一次取消 */
      U.$$('#cResult .geo-chips .geo-chip')
        .filter(c => c.textContent.indexOf('滨江区') === 0)[0].click();
      eq('再点一次「滨江区」→ 取消选中', (CF.district || []).length, 0);
      eq('取消后 4 条都回来了', U.$$('#cResult .job').length, 4);

      /* 点「西湖区」→ 选中西湖区时应只剩 1 条命中 + 1 条没采到的 */
      U.$$('#cResult .geo-chips .geo-chip')
        .filter(c => c.textContent.indexOf('西湖区') === 0)[0].click();
      eq('点「西湖区」→ 2 条（1 命中 + 1 没采到的）', U.$$('#cResult .job').length, 2);
      ok('西湖区命中「产品经理」', jobTitles().some(t => t.indexOf('产品经理') >= 0));

      ok('结果卡没被错误兜底卡顶掉',
        U.$('#view').textContent.indexOf('这个页面渲染出错了') < 0);

      /* --- 换城市 → 清掉旧区/商圈（⑽ 盯着这条） ---
         结果页城市下拉的选项来自**这批结果真实采到的城市**，
         所以这里换一套含「杭州 + 上海」的记录，让城市下拉真的出现两个城市可换。 */
      const RECORDS2 = [
        { 岗位: '新媒体运营', 公司: '甲公司', 城市: '杭州', 区域: '滨江区', 商圈: '长河',
          行业: '互联网', 薪资: '12-18K', 福利: '五险一金,双休' },
        { 岗位: '产品经理',   公司: '乙公司', 城市: '上海', 区域: '浦东新区', 商圈: '陆家嘴',
          行业: '互联网', 薪资: '25-40K', 福利: '五险一金' },
      ];
      collect._state.result = { source: '（测试·换城市）', jobs: RECORDS2 };
      CF.city = ''; CF.district = []; CF.bizArea = [];
      collect._paintResult();
      // 先点「滨江区」选中一个区
      U.$$('#cResult .geo-chips .geo-chip')
        .filter(c => c.textContent.indexOf('滨江区') === 0)[0].click();
      ok('换城市前：区筛选已选中「滨江区」', (CF.district || []).join('/') === '滨江区',
        (CF.district || []).join('/'));
      // 真点城市下拉 → 换成「上海」
      // ⚠️ 结果页筛选栏里有好几个 select（岗位名 / 城市 / 行业 / 薪资…），
      //    城市下拉是唯一「选项 value 含『上海』」的那个，按这个特征找才稳，别按 index。
      //    （DOM 桩的 option 没有 .value getter，要读 getAttribute('value')。）
      const citySel = U.$$('#cResult select')
        .filter(s => U.$$('option', s).some(o => o.getAttribute('value') === '上海'))[0];
      ok('结果页城市下拉里同时有「杭州」和「上海」',
        !!citySel && /上海/.test(citySel.textContent || ''), citySel ? citySel.textContent.slice(0, 40) : '没有下拉');
      if (citySel) {
        citySel.value = '上海';
        citySel.dispatchEvent({ type: 'change', target: citySel });
        eq('换城市后旧区被清掉（不再是杭州的滨江区）', (CF.district || []).join('/'), '');
        eq('换城市后旧商圈也被清掉', (CF.bizArea || []).join('/'), '');
        eq('换城市后 CF.city = 上海', CF.city, '上海');
      }

      ok('结果卡没被错误兜底卡顶掉',
        U.$('#view').textContent.indexOf('这个页面渲染出错了') < 0);
    }

    collect._state.result = saved;
    collect._clearCF();
    clearToasts();
  }

  /* --- 18.8d2 采集页：结果池文案 + 「只看本次新增」+ 结果不再硬截断 40 ---
     背景（体检报告 §1.3 / §3.1）：
       · CSV 按关键词跨轮累积，结果区返回的是**累积池**，以前文案写「本批 N 个」
         会误导用户以为那是刚采的；
       · 结果列表被 filtered.slice(0, 40) 硬截断，456 条只能看前 40。
     这一组断言盯住这三件事，改坏了必须变红。 */
  {
    const collect = Views.collect;
    const CF = collect._cf;

    /* 一批带 _isNew 标记的结果：3 条本轮新增 + 2 条历史池 */
    const mk = (title, isNew) => ({
      岗位: title, 公司: '某公司', 城市: '杭州', 行业: '互联网', 薪资: '10-20K',
      福利: '五险一金', _isNew: isNew,
    });
    const RECS = [
      mk('新增岗位A', true), mk('新增岗位B', true), mk('新增岗位C', true),
      mk('历史岗位D', false), mk('历史岗位E', false),
    ];

    collect._state.result = {
      source: '（测试·新增）', jobs: RECS, hasRoundInfo: true, newCount: 3,
    };
    CF.onlyNew = false;
    collect._paintResult();

    const card0 = U.$('#cResult');
    ok('结果池文案不再写「本批」（改说「结果池共 N 个」）',
      /结果池共 5 个/.test(card0.textContent) && !/本批共/.test(card0.textContent),
      card0.textContent.slice(0, 160));
    ok('计数行如实说明「本次新增 3 个」',
      /本次新增 3 个/.test(card0.textContent), card0.textContent.slice(0, 160));

    const newChip = U.$$('#cResult .fchip').filter(c => /新增|只看新增/.test(c.textContent))[0];
    ok('渲染出了「本次新增」开关', !!newChip,
      U.$$('#cResult .fchip').map(c => c.textContent).join('/'));

    /* ⛔ 新语义（§五-3 / 3.5）：有本轮信息 + 有新增时，**默认切到「只看新增」** ——
       用户刚采完最想看的是「我刚采的那批」，不是跨轮累积的历史池。所以第一次
       渲染就应该只剩 3 条新增。用户点开关能切回「看全部」。 */
    eq('默认就只看新增 → 只剩 3 条新增', U.$$('#cResult .job').length, 3);
    eq('默认置位了 CF.onlyNew', CF.onlyNew, true);
    const titles0 = U.$$('#cResult .job').map(c => c.textContent);
    ok('默认显示的都是新增岗位',
      titles0.every(t => t.indexOf('历史岗位') < 0) &&
      titles0.filter(t => t.indexOf('新增岗位') >= 0).length === 3,
      titles0.map(t => t.slice(0, 10)).join(' | '));

    /* 点开关取消「只看新增」→ 5 条全回来 */
    if (newChip) {
      newChip.click();
      eq('点开关取消 → CF.onlyNew 清除', CF.onlyNew, false);
      eq('点开关取消 → 5 条都回来', U.$$('#cResult .job').length, 5);
      /* 再点一次 → 又只剩 3 条 */
      const chip2 = U.$$('#cResult .fchip').filter(c => /新增|只看新增/.test(c.textContent))[0];
      chip2.click();
      eq('再点一次 → 又只看 3 条新增', U.$$('#cResult .job').length, 3);
    }

    /* ⛔ 没有本轮信息（老数据 / 采集中断）时**不给**开关 ——
       给了会点了变空列表，用户以为数据丢了。 */
    collect._state.result = {
      source: '（测试·无本轮信息）', jobs: RECS, hasRoundInfo: false, newCount: 0,
    };
    CF.onlyNew = false;
    collect._paintResult();
    ok('⛔ 没有本轮信息时不渲染「本次新增」开关',
      !U.$$('#cResult .fchip').some(c => /本次新增|只看新增/.test(c.textContent)),
      U.$$('#cResult .fchip').map(c => c.textContent).join('/'));
    ok('无本轮信息时文案退回「结果池共 N 个岗位」',
      /结果池共 5 个岗位/.test(U.$('#cResult').textContent),
      U.$('#cResult').textContent.slice(0, 160));

    /* 结果不再硬截断 40：造 55 条，默认可看 40，且有「加载更多」出口 */
    const many = [];
    for (let i = 0; i < 55; i++) many.push(mk('岗位' + i, true));
    collect._state.result = {
      source: '（测试·多条）', jobs: many, hasRoundInfo: true, newCount: 55,
    };
    CF.onlyNew = false; CF.kw = '';
    collect._paintResult();
    eq('55 条结果默认显示 40 条', U.$$('#cResult .job').length, 40);
    const moreBtn = U.$$('#cResult button').filter(b => /加载更多/.test(b.textContent))[0];
    ok('超过 40 条时给出「加载更多」出口（不再只有一句提示）', !!moreBtn,
      U.$$('#cResult button').map(b => b.textContent).join('/'));
    if (moreBtn) {
      moreBtn.click();
      ok('点「加载更多」→ 看到的不止 40 条', U.$$('#cResult .job').length > 40,
        String(U.$$('#cResult .job').length));
      const allBtn = U.$$('#cResult button').filter(b => /全部展开/.test(b.textContent))[0];
      if (allBtn) {
        allBtn.click();
        eq('点「全部展开」→ 55 条全出来', U.$$('#cResult .job').length, 55);
      }
    }

    /* 福利在结果区必须是**多选**（P2）：参数卡是多选，搬过来会带多个，
       以前结果区只取 CF.welfare[0] → 选了 3 个只生效 1 个。 */
    const wfRecs = [
      { 岗位: 'A', 公司: '甲', 城市: '杭州', 福利: ['五险一金', '双休'], _isNew: true },
      { 岗位: 'B', 公司: '乙', 城市: '杭州', 福利: ['五险一金'], _isNew: true },
      { 岗位: 'C', 公司: '丙', 城市: '杭州', 福利: ['年终奖'], _isNew: true },
    ];
    collect._state.result = {
      source: '（测试·福利多选）', jobs: wfRecs, hasRoundInfo: true, newCount: 3,
    };
    CF.onlyNew = false; CF.welfare = [];
    collect._paintResult();
    eq('福利未筛时 3 条都在', U.$$('#cResult .job').length, 3);
    /* 真点两个福利 chip（五险一金 + 双休）→ 任一命中即保留 → A、B 留下 */
    const wfChips = () => U.$$('#cResult .geo-chips .geo-chip')
      .filter(c => /五险一金|双休|年终奖/.test(c.textContent));
    const c1 = wfChips().filter(c => c.textContent.indexOf('五险一金') === 0)[0];
    const c2 = wfChips().filter(c => c.textContent.indexOf('双休') === 0)[0];
    ok('福利渲染成可多选的 chips（不再是单选下拉）', !!c1 && !!c2,
      wfChips().map(c => c.textContent).join('/'));
    if (c1 && c2) {
      c1.click();
      c2.click();
      eq('点两个福利 → CF.welfare 记成两个（不是只留一个）',
        (CF.welfare || []).slice().sort().join('/'), '五险一金/双休');
      /* 五险一金命中 A、B；双休命中 A → 任一命中 → A、B 两条 */
      eq('多选福利生效：A、B 留下，C 被排掉', U.$$('#cResult .job').length, 2);
      ok('被排掉的是只有「年终奖」的 C',
        U.$$('#cResult .job').every(c => c.textContent.indexOf('年终奖') < 0 ||
          c.textContent.indexOf('五险一金') >= 0 || c.textContent.indexOf('双休') >= 0));
    }

    collect._state.result = null;
    collect._clearCF();
    clearToasts();
  }


  /* --- 18.8d3 采集页：详情抓取失败要「看得见」（P1-3）---
     以前详情失败只打一行日志，界面上只有一个不起眼的小字，用户以为数据是全的。
     现在要在结果区明示 N 个失败 + 原因。改回静默必须变红。 */
  {
    const collect = Views.collect;
    const CF = collect._cf;

    const RECS = [
      { 岗位: '岗位A', 公司: '某公司', 城市: '杭州', 薪资: '10-20K', _isNew: true },
      { 岗位: '岗位B', 公司: '某公司', 城市: '杭州', 薪资: '10-20K', _isNew: true },
    ];

    /* ① 有失败：必须明示条数 + 原因 */
    collect._state.result = {
      source: '（测试·有失败）', jobs: RECS, hasRoundInfo: true, newCount: 2,
      detailFailures: { count: 3, reasons: { '等待登录恢复超时': 3 } },
    };
    CF.onlyNew = false;
    collect._paintResult();
    const txt1 = U.$('#cResult').textContent;
    ok('详情失败时明示「有 N 个岗位的详情没抓到」',
      /3\s*个岗位/.test(txt1) && txt1.indexOf('详情没抓到') >= 0,
      txt1.slice(0, 300));
    ok('失败提示带上了原因（等待登录恢复超时）',
      txt1.indexOf('等待登录恢复超时') >= 0, txt1.slice(0, 300));
    ok('失败提示说明了影响（本地合适度退化成只看标题）',
      txt1.indexOf('只看了标题') >= 0, txt1.slice(0, 300));

    /* ② 无失败：不该冒这条提示 */
    collect._state.result = {
      source: '（测试·无失败）', jobs: RECS, hasRoundInfo: true, newCount: 2,
      detailFailures: { count: 0, reasons: {} },
    };
    collect._paintResult();
    ok('⛔ 没有失败时不该冒「详情没抓到」提示',
      U.$('#cResult').textContent.indexOf('详情没抓到') < 0,
      U.$('#cResult').textContent.slice(0, 200));

    collect._state.result = null;
    collect._clearCF();
    clearToasts();
  }


  /* --- 18.8d4 采集页：采集历史列表（P2-1）+ 停止后的落点指引（P2-3）--- */
  {
    const collect = Views.collect;

    /* 采集历史：接口返回若干轮 → 弹窗要列出来、标出「当前」、给复制路径 */
    const HIST = {
      ok: true,
      items: [
        { name: '2026-10-05_15-07-55', kind: 'active', current: true,
          csvCount: 0, hasResult: true, mtime: 2, path: 'C:/x/2026-10-05_15-07-55' },
        { name: '2026-09-30_21-29-12', kind: 'archived', current: false,
          csvCount: 18, hasResult: false, mtime: 1, path: 'C:/x/archive/2026-09-30_21-29-12' },
      ],
    };
    const stubH = (url) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      let body = { ok: false, error: 'no stub: ' + p };
      if (p.indexOf('/api/history') === 0) body = HIST;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    /* ⚠️ 必须 await：这不是纯粹的一次调用，中间要等 /api/history 的 promise 落地。
       不 await 的话本块还没跑完，脚本已经走进下一块的 App.go()（它会 closeAllModals），
       弹窗被关掉 → 断言看到「没打开」的假红。 */
    ok('采集历史入口已导出（_openHistoryDialog）', typeof collect._openHistoryDialog === 'function');
    await withFetch(stubH, () => {
      collect._openHistoryDialog();
      return tick().then(tick).then(tick);
    });

    const modal = U.$('.modal');
    ok('采集历史弹窗打开了', !!modal, modal ? 'ok' : '没打开');
    if (modal) {
      const t = modal.textContent;
      ok('列出了当前那轮', t.indexOf('2026-10-05_15-07-55') >= 0, t.slice(0, 200));
      ok('列出了归档那轮', t.indexOf('2026-09-30_21-29-12') >= 0);
      ok('标出了「当前」', t.indexOf('当前') >= 0);
      ok('标出了「已归档」', t.indexOf('已归档') >= 0);
      ok('显示了 CSV 数量', /18\s*个 CSV/.test(t), t.slice(0, 300));
      ok('给了复制路径入口', t.indexOf('复制路径') >= 0);
      ok('说明了清空是归档不是删除', t.indexOf('归档') >= 0 && t.indexOf('不是删除') >= 0,
        t.slice(0, 300));
      /* 关掉，别留一堆弹窗给后面的用例 */
      const x = U.$('.modal .x');
      if (x) x.click();
      await tick();
      eq('关掉后弹窗清干净', U.$$('.mask').length, 0);
    }

    /* 停止后的落点指引（P2-3）：有结果时要说「已采到 N 条、在哪、可导入」 */
    const CS = collect._state;
    CS.ping = { login: { value: 'ok', checkedAt: Date.now() / 1000, ttlSec: 3600 } };
    CS.result = {
      source: '（测试）',
      jobs: [{ 岗位: 'A', 公司: 'X', 城市: '杭州' }, { 岗位: 'B', 公司: 'Y', 城市: '杭州' }],
    };
    const stubS = (url) => Promise.resolve({
      ok: true, status: 200,
      text: () => Promise.resolve(JSON.stringify({ ok: true })),
    });
    await withFetch(stubS, () => {
      collect._doStop();
      return tick().then(tick);
    });
    const toasts = Array.from(sandbox.document.querySelectorAll('.toast'))
      .map(n => n.textContent).join(' | ');
    ok('停止后提示里带上了「已采到 N 个岗位」',
      /已采到\s*2\s*个岗位/.test(toasts), toasts.slice(0, 200));
    ok('停止后指出了结果在哪（④ 采集结果）',
      toasts.indexOf('采集结果') >= 0, toasts.slice(0, 200));
    CS.result = null;
    clearToasts();
  }

  /* --- 18.8e 采集页：任务进度条 + 计时 + 完成提示（纯渲染 + 边沿逻辑） --- */
  {
    const collect = Views.collect;

    /* 纯函数 fmtDur：秒 → 可读时长 */
    eq('fmtDur 0 秒', collect._fmtDur(0), '0 秒');
    eq('fmtDur 59 秒', collect._fmtDur(59), '59 秒');
    eq('fmtDur 90 秒 → 1 分 30 秒', collect._fmtDur(90), '1 分 30 秒');
    eq('fmtDur 3600 秒 → 1 小时 0 分', collect._fmtDur(3600), '1 小时 0 分');
    eq('fmtDur 负数 → 归 0', collect._fmtDur(-5), '0 秒');
    eq('fmtDur 非数字 → 归 0', collect._fmtDur(null), '0 秒');

    /* paintTaskBar 三种状态的真渲染 */
    const mkBar = () => {
      const bar = sandbox.document.createElement('div');
      bar.id = 'cTaskBar';
      return bar;
    };

    // ① 进行中：滚动进度条 + ⏱ 计时
    const barRun = mkBar();
    const nowSec = Math.floor(Date.now() / 1000);
    collect._paintTaskBar(barRun, { key: 'crawl', title: '采集岗位', running: true,
      started_at: nowSec - 30, ended_at: null, exit_code: null, total: 5, lines: [] });
    ok('进行中显示「进行中」pill', (barRun.textContent || '').indexOf('进行中') >= 0);
    ok('进行中显示任务标题', (barRun.textContent || '').indexOf('采集岗位') >= 0);
    ok('进行中显示计时图标 ⏱', (barRun.textContent || '').indexOf('⏱') >= 0);
    ok('进行中渲染了滚动进度条', !!barRun.querySelector && !!barRun.querySelector('.task-pbar-run'),
      'barRun.className 树：' + (barRun.innerHTML || '').slice(0, 200));
    ok('进行中进度条不是「完成」态（不拉满）', !barRun.querySelector || !barRun.querySelector('.task-pbar-done'));

    // ② 完成：拉满进度条 + 总耗时
    const barDone = mkBar();
    collect._paintTaskBar(barDone, { key: 'crawl', title: '采集岗位', running: false,
      started_at: nowSec - 65, ended_at: nowSec, exit_code: 0, total: 10, lines: [] });
    ok('完成显示「已完成」pill', (barDone.textContent || '').indexOf('已完成') >= 0);
    ok('完成显示总耗时「共」', (barDone.textContent || '').indexOf('共') >= 0);
    ok('完成渲染拉满进度条', !!barDone.querySelector && !!barDone.querySelector('.task-pbar-done'),
      (barDone.innerHTML || '').slice(0, 200));
    ok('完成态不显示「进行中」', (barDone.textContent || '').indexOf('进行中') < 0);

    // ③ 失败：红色进度条 + 退出码
    const barFail = mkBar();
    collect._paintTaskBar(barFail, { key: 'crawl', title: '采集岗位', running: false,
      started_at: nowSec - 10, ended_at: nowSec, exit_code: 2, total: 3, lines: [] });
    ok('失败显示「已结束」+ 退出码', (barFail.textContent || '').indexOf('已结束') >= 0 &&
      (barFail.textContent || '').indexOf('退出码 2') >= 0, barFail.textContent);
    ok('失败渲染红色进度条', !!barFail.querySelector && !!barFail.querySelector('.task-pbar-fail'));

    // ④ 无任务：显示占位
    const barNone = mkBar();
    collect._paintTaskBar(barNone, null);
    ok('无任务显示占位', (barNone.textContent || '').indexOf('暂无任务') >= 0);

    /* CSS 类名都在样式表里（避免裸元素） */
    const css = fs.readFileSync(path.join(DIR, 'css', 'app.css'), 'utf8');
    ['task-block', 'task-head', 'task-time', 'task-pbar', 'task-pbar-run', 'task-pbar-done', 'task-pbar-fail']
      .forEach(c => ok('样式表定义了 .' + c, css.indexOf('.' + c) >= 0));

    /* 边沿检测字段存在（完成提示依赖它） */
    ok('采集状态里有 wasRunning 字段（跑完边沿检测用）',
      'wasRunning' in collect._state, JSON.stringify(Object.keys(collect._state)));

    /* 完成提示 notifyDone：成功弹「采集完成」、失败弹「任务结束」 */
    dropToasts();
    const now2 = Math.floor(Date.now() / 1000);
    const rOk = collect._notifyDone({ key: 'crawl', title: '采集岗位', running: false,
      started_at: now2 - 45, ended_at: now2, exit_code: 0, total: 8, lines: [] });
    ok('notifyDone 返回 true（弹了提示）', rOk === true);
    ok('成功时提示文案带「采集完成」',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('采集完成') >= 0));
    ok('成功时提示带总耗时',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('共耗时') >= 0));

    dropToasts();
    collect._notifyDone({ key: 'crawl', title: '采集岗位', running: false,
      started_at: now2 - 5, ended_at: now2, exit_code: 2, total: 3, lines: [] });
    ok('失败时提示文案带「任务结束」',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('任务结束') >= 0));
    ok('失败时提示带退出码',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('退出码 2') >= 0));
    dropToasts();

    /* poll 完成分支真的会弹提示（onTaskDone 的边沿接线，⑸ 变异盯这里） */
    // 需要 fetch 桩兜住 onTaskDone 里的 detect().then(loadResult) —— 用默认 reject 桩即可
    collect._state.wasRunning = true;
    collect._onTaskDone({ key: 'crawl', title: '采集岗位', running: false,
      started_at: now2 - 40, ended_at: now2, exit_code: 0, total: 6, lines: [] }, null);
    ok('任务从「跑动」转「完成」时弹了完成提示（边沿）',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('采集完成') >= 0));
    ok('弹完提示后 wasRunning 归位为 false（下次不会重复弹）',
      collect._state.wasRunning === false);
    dropToasts();
    collect._state.wasRunning = null;
  }

  /* --- 18.8f 采集页：开跑前的预估耗时（P2-2）---
     体检报告 §3.1：「用户开跑前不知道要等 30 分钟还是 3 分钟」。
     预估值**由服务端算**（estimate_crawl），前端只做格式化 —— 所以这里守两件事：
       ① fmtEstimate 的口径（尤其「详情只抓 Top N」这条，不许说成几十小时）
       ② 服务端 estimate_crawl 与 skill 常量一致、且尊重详情封顶
     改回「不显示预估」或「详情按全量估」都要变红。 */
  {
    const collect = Views.collect;
    const readText = rel => fs.readFileSync(path.join(DIR, rel), 'utf8');
    const fmtEstimate = collect._fmtEstimate;
    ok('采集页导出了预估格式化函数 _fmtEstimate', typeof fmtEstimate === 'function');

    /* ① 缺预估（还没填城市/期望）→ 返回 null，不要显示「0 分钟」 */
    eq('没有预估值 → null（不显示 0 分钟）', fmtEstimate(null), null);
    eq('预估值格式不对 → null', fmtEstimate({ minutes: 'x' }), null);

    /* ② 正常的预估：说清「约几分钟」，且拆出列表/详情 */
    const e1 = fmtEstimate({ minutes: 5.2, listMinutes: 1, detailMinutes: 4.2,
      detailCapped: true, detailCapN: 50, unlimited: false });
    ok('说出总预估分钟', /预计约\s*5\.2\s*分钟/.test(e1), e1);
    ok('拆出了列表与详情两段', e1.indexOf('列表 1 分') >= 0 && e1.indexOf('详情 4.2 分') >= 0, e1);
    ok('⛔ 详情封顶时必须说明「只抓优先级最高的 N 个」', /只抓优先级最高的 50 个/.test(e1), e1);

    /* ③ 「不限」条数要标出来（否则用户以为数字是准的） */
    const e2 = fmtEstimate({ minutes: 5.2, listMinutes: 1, detailMinutes: 4.2,
      detailCapped: true, detailCapN: 50, unlimited: true });
    ok('条数按「不限」估时要如实标注', e2.indexOf('按「不限」估') >= 0, e2);

    /* ④ 没封顶（条数 < 50）时不该冒「只抓前 N 个」的话 */
    const e3 = fmtEstimate({ minutes: 0.6, listMinutes: 0.2, detailMinutes: 0.4,
      detailCapped: false, detailCapN: 50, unlimited: false });
    ok('⛔ 没封顶时不许说「只抓优先级最高的 N 个」', e3.indexOf('只抓优先级最高') < 0, e3);

    /* ⑤ 服务端 estimate_crawl 的常量必须和 skill 一致（复刻就得防漂移） */
    const srvEst = readText('采集器/server.py');
    const cfgPy = fs.readFileSync(
      'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/config.py', 'utf8');
    const numOf = (s, re) => { const m = s.match(re); return m ? m[1] : null; };
    eq('server 的每页条数与 skill PER_PAGE 一致',
      numOf(srvEst, /_EST_PER_PAGE\s*=\s*(\d+)/), numOf(cfgPy, /^PER_PAGE\s*=\s*(\d+)/m));
    eq('server 的翻页等待与 skill PER_PAGE_TIME 一致',
      numOf(srvEst, /_EST_PER_PAGE_SEC\s*=\s*(\d+)/), numOf(cfgPy, /^PER_PAGE_TIME\s*=\s*(\d+)/m));
    eq('server 的详情等待与 skill PER_DETAIL_TIME 一致',
      numOf(srvEst, /_EST_PER_DETAIL_SEC\s*=\s*(\d+)/), numOf(cfgPy, /^PER_DETAIL_TIME\s*=\s*(\d+)/m));
    eq('server 的详情封顶与 skill DETAIL_TOP_N 一致',
      numOf(srvEst, /_EST_DETAIL_TOP_N\s*=\s*(\d+)/), numOf(cfgPy, /^DETAIL_TOP_N\s*=\s*(\d+)/m));

    /* ⑥ 预估算法真的用了封顶（而不是把 total_items 全乘 PER_DETAIL_TIME） */
    ok('estimate_crawl 里详情时间用的是封顶后的条数（不是总条数）',
      /detail_sec\s*=\s*detail_n\s*\*\s*_EST_PER_DETAIL_SEC/.test(srvEst));
    ok('estimate_crawl 里有封顶分支（items > 上限时取上限）',
      /if _EST_DETAIL_TOP_N and items > _EST_DETAIL_TOP_N:/.test(srvEst));

    /* ⑦ /api/crawl 的响应里带上预估，前端不用多发一次请求 */
    ok('/api/crawl 成功后把 estimate 一起返回',
      /res\['estimate'\]\s*=\s*estimate_crawl\(payload\)/.test(srvEst));
    ok('单独提供了 /api/estimate 入口（开跑前也能问）',
      /path == '\/api\/estimate'/.test(readText('采集器/server.py')));

    /* ⑧ 前端真的把预估说给了用户（接线，不是死代码） */
    const vc = readText('js/view-collect.js');
    ok('startCrawl 成功回调里用了 fmtEstimate（预估真的会显示）',
      /fmtEstimate\(d\.estimate\)/.test(vc));
    ok('参数卡里有个 #cEstimate 显示位（开跑前就能看到）',
      /id:\s*'cEstimate'/.test(vc));
    ok('refreshEstimate 会问服务端要数（不在前端复刻公式）',
      /function refreshEstimate\(\)/.test(vc) && /req\('\/api\/estimate'/.test(vc));
    ok('城市/期望/条数一变就刷新预估（paintDiag 里调了 refreshEstimate）',
      /function paintDiag\(\)\s*\{[\s\S]{0,600}?refreshEstimate\(\);/.test(vc) &&
      /f\.count = cntInp\.value; touchForm\(\); paintDiag\(\)/.test(vc));
    /* 第 21 轮新增：参数一变，「和偏好差几项」的提示也要重算 ——
       不重算的话用户改完参数，同步条会一直停在旧的差异上（"改了没反应"的观感）。 */
    ok('参数一变，同步条也重算（paintDiag 里调了 paintSyncBar）',
      /function paintDiag\(\)\s*\{[\s\S]{0,600}?paintSyncBar\(\);/.test(vc));
  }

  /* --- 18.8g 采集侧：参数透传不许让模型替用户决定（P2-4，报告 §1.4）---
     模型能推断 6 个字段（keywords/cities/degree/experience/salary/job_type）。
     `不传 flag` = 交给模型推；`传空串` = 明确「不筛这一项」（infer_params 的契约）。
     用户故意留空薪资（=不限）时，必须走后者，否则模型塞一个区间进去、BOSS 按它硬筛。 */
  {
    const readText = rel => fs.readFileSync(path.join(DIR, rel), 'utf8');
    const srvEst = readText('采集器/server.py');
    ok('server.py 有 put_or_blank（用户留空时显式传空串，而不是省略 flag）',
      /def put_or_blank\(/.test(srvEst));
    ok('薪资用 put_or_blank（「不限」必须明确告诉 infer，不能被模型填成区间）',
      /put_or_blank\('--salary'/.test(srvEst));
    ok('学历/经验/工作类型也用 put_or_blank（同样是模型能推断的）',
      /put_or_blank\('--degree'/.test(srvEst) &&
      /put_or_blank\('--experience'/.test(srvEst) &&
      /put_or_blank\('--job-type'/.test(srvEst));
    ok('scale/stage 也显式传（语义一致，复盘命令行不用猜）',
      /put_or_blank\('--scale'/.test(srvEst) && /put_or_blank\('--stage'/.test(srvEst));
    /* count 是 type=int，传空串会让 argparse 报错 —— 它必须继续用 put() */
    ok('⛔ count 不能用 put_or_blank（argparse 是 type=int，空串会崩）',
      /put\('--count'/.test(srvEst) && !/put_or_blank\('--count'/.test(srvEst));
    ok('put_or_blank 对空值一律转成空串（不是省略、不是 None）',
      /if value in \(None, \[\], \(\)\):\s*\n\s*value = ''/.test(srvEst));
    /* 空串→清字段 的契约来自 infer_params，这里确认它没被改掉（改了就得同步这里） */
    const ip = fs.readFileSync(
      'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/infer_params.py', 'utf8');
    ok('infer_params 仍然「显式传空串 = 不筛这一项」（透传契约的前提）',
      /params\.pop\(field, None\)\s*#\s*显式传空串 = 不筛这一项/.test(ip));
  }

  /* --- 18.8h 采集链路评审（2026-10-05）的关键修复 ---
     这份评审的核心批评是「单测测的是函数本身，没测服务端实际吐的键名/有没有重复/下游
     有没有消费者」。所以这里每条都盯「真实代码结构」，不是手工构造对象喂映射函数。 */
  {
    const readText = rel => fs.readFileSync(path.join(DIR, rel), 'utf8');
    const srv = readText('采集器/server.py');
    const vc = readText('js/view-collect.js');

    /* P0-2.1：键名必须带下划线，且前后端一致（曾写成 reqAuthoritative → 断链） */
    ok('server.py 写权威要求用 _reqAuthoritative（带下划线，和 _isNew 同款内部字段）',
      /item\['_reqAuthoritative'\]\s*=\s*r/.test(srv));
    ok('server.py 不再有漏下划线的 reqAuthoritative 键（那条断链的根）',
      !/item\['reqAuthoritative'\]\s*=/.test(srv));
    ok('export.js 读的也是 _reqAuthoritative（前后端拼写一致，白名单才接得上）',
      /o\._reqAuthoritative/.test(readText('js/export.js')));

    /* P1-3.1：current_params 回吐 5 个筛选维度（以前刷新 F5 就丢、要手点 14 次） */
    ok('current_params 回吐 degree/experience/scale/stage/jobType',
      /out\['degree'\]\s*=\s*as_list\(cp\.get\('degree'\)\)/.test(srv) &&
      /out\['experience'\]\s*=\s*as_list\(cp\.get\('experience'\)\)/.test(srv) &&
      /out\['scale'\]\s*=\s*as_list\(cp\.get\('scale'\)\)/.test(srv) &&
      /out\['stage'\]\s*=\s*as_list\(cp\.get\('stage'\)\)/.test(srv) &&
      /out\['jobType'\]\s*=\s*as_list\(cp\.get\('job_type'\)\)/.test(srv));
    ok('前端 S.form 用 p.degree / p.jobType 做初值（不再硬编码空数组）',
      /degree:\s*U\.asArray\(lfOr\('degree',\s*p\.degree\)\)/.test(vc) &&
      /jobType:\s*U\.asArray\(lfOr\('jobType',\s*p\.jobType\)\)/.test(vc));

    /* P1-3.2：new_run_dir 挪到并发检查之后（任务没起来不动 LATEST 指针） */
    ok('_crawl 先查并发再 new_run_dir（评审 P1-3.2）',
      /评审 P1-3\.2[\s\S]{0,1000}?rd = new_run_dir\(\)/.test(srv));

    /* P1-3.6：_pump 把任务输出落盘（以前只存内存，跑完没法复盘） */
    ok('_pump 把 stdout 落盘到 data/task-*.log',
      /task-%s-%s\.log/.test(srv) && /log_file\.write\(line/.test(srv));

    /* P2-2.2：reqSkillsAuthoritative 接给 job-score（以前算出来没人读，两端都断） */
    ok('job-score 读了 reqSkillsAuthoritative（下游消费者接上了）',
      /reqSkillsAuthoritative/.test(readText('js/job-score.js')));

    /* P2-3：count 解析保留 0=不限（不再被 parseInt || 30 吞成 30） */
    ok('view-collect 有 parseCount 且保留 0=不限',
      /function parseCount\(/.test(vc) && /n === 0\) return 0;/.test(vc));
    ok('count 传参改走 parseCount（不再 parseInt || 30）',
      /count:\s*parseCount\(f\.count\)/.test(vc));

    /* P0-2.1 附带：reqHits 显示到结果卡（后端算了、前端零引用 → 现在摆出来） */
    ok('采集结果卡显示权威要求命中数（reqHits 不再零引用）',
      /reqHitsInfo\(\)/.test(vc));
  }

  /* --- 18.8i 暂缓项收尾（2026-10-06）：方案预设 / 频次面板 / 只看新增默认 /
     薪资分档统一 / 经验体检 / 回复率归因 / 简历删除 / 下划线静态拦截 --- */
  {
    const readText = rel => fs.readFileSync(path.join(DIR, rel), 'utf8');
    const srv = readText('采集器/server.py');
    const vc = readText('js/view-collect.js');
    const store = readText('js/store.js');
    const dash = readText('js/view-dashboard.js');

    /* §五-1 采集方案预设：存/取/应用/字段清单四件套齐活 */
    ok('方案预设四件套都在（readPresets/writePresets/presetPayload/applyPresetToForm）',
      /function readPresets\(/.test(vc) && /function writePresets\(/.test(vc) &&
      /function presetPayload\(/.test(vc) && /function applyPresetToForm\(/.test(vc));
    ok('方案保存字段含全维度筛选（城市/关键词/学历/经验/规模/薪资等）',
      /PRESET_FIELDS\s*=\s*\[[\s\S]*?'city'[\s\S]*?'keywords'[\s\S]*?'degree'[\s\S]*?'experience'[\s\S]*?'scale'[\s\S]*?'salary'/.test(vc));

    /* §五-2 频次面板：服务端统计 + 前端展示 */
    ok('server.py 有 collect_frequency 统计本日/本周轮数',
      /def collect_frequency\(/.test(srv) && /todayRuns/.test(srv) && /weekRuns/.test(srv));
    ok('ping 回吐 frequency 与 interrupted 探针',
      /'frequency':\s*collect_frequency\(\)/.test(srv) && /'interrupted':\s*detect_interrupted\(\)/.test(srv));

    /* §五-3 只看新增默认：_onlyNewDefaulted 逻辑存在 */
    ok('「只看新增默认」的守卫标志在（第一次拉到新增就切过去，之后不覆盖）',
      /_onlyNewDefaulted/.test(vc) && /CF\.onlyNew = true;/.test(vc));

    /* P2-2 薪资分档统一：结果页薪资档用 BOSS 同款 SALARY_OPTIONS，不再自定档 */
    ok('结果页薪资档统一为 BOSS 同款（SALARY_OPTIONS + SALARY_BAND，不再 10-20 自定档）',
      /SALARY_OPTIONS\.map\(/.test(vc) && /SALARY_BAND\[CF\.salary\]/.test(vc));
    ok('seedCFFromForm 也搬薪资（参数卡选了结果页就该筛）',
      /seedCFFromForm[\s\S]*?CF\.salary = f\.salary/.test(vc));

    /* §五-7 参数体检扩经验维：EXPERIENCE_BAND + experience 检查 */
    ok('参数体检扩了经验维（EXPERIENCE_BAND + experience code）',
      /EXPERIENCE_BAND\s*=\s*\{/.test(vc) && /code: 'experience'/.test(vc));

    /* §五-8 投递闭环：store 有 replyStats（回复率 + 归因切片） */
    ok('store 有 replyStats（回复率 + 按行业/薪资/规模/渠道/匹配分归因）',
      /function replyStats\(/.test(store) && /byIndustry/.test(store) &&
      /bySalary/.test(store) && /byScale/.test(store) && /byChannel/.test(store) && /byFit/.test(store));
    ok('回复判定口径 = reachedIndex >= viewed（HR 查看过才算回复）',
      /reachedIndex\(a\) >= chainIndex\('viewed'\)/.test(store));
    /* ⛔ 上面那条只是**文本**断言，不足以守住口径（评审复核时逮到的假绿）：
       `chainIndex('viewed')` 在 store.js 里出现在 **3 处**（replyStats / sliceBy / hasApplied），
       把 replyStats 的阈值改成 'invited' 之后，**别处的文本照样满足那条正则** → 它不红。
       所以必须**行为**验证：造三条不同状态的投递，直接看 replyStats() 报出来的数。 */
    const unwrapR = r => (r && r.job) ? r.job : r;
    const rsBefore = Store.replyStats();
    const mkResp = t => unwrapR(Store.addJob({ title: t, company: '口径测试公司', source: 'manual' }));
    const jR1 = mkResp('口径-A 只投没被看');
    const jR2 = mkResp('口径-B 被看过');
    const jR3 = mkResp('口径-C 已邀约');
    Store.addApplication({ jobId: jR1.id, status: 'applied', appliedAt: U.now() });
    Store.addApplication({ jobId: jR2.id, status: 'viewed', appliedAt: U.now() });
    Store.addApplication({ jobId: jR3.id, status: 'invited', appliedAt: U.now() });
    const rsAfter = Store.replyStats();
    eq('⛔ 口径行为验证：只投递没被查看 **不算**回复（viewed + invited 才算 → 2 条）',
      rsAfter.repliedTotal - rsBefore.repliedTotal, 2);
    eq('⛔ 口径行为验证：深度回复只认「邀约」及以上（applied/viewed 不算 → 1 条）',
      rsAfter.deepRepliedTotal - rsBefore.deepRepliedTotal, 1);
    [jR1.id, jR2.id, jR3.id].forEach(function (jid) {
      var a = Store.appOfJob(jid); if (a) Store.removeApplication(a.id);
      Store.removeJob(jid);
    });
    ok('dashboard 渲染投递归因卡片',
      /Store\.replyStats\(\)/.test(dash) && /投递回复率/.test(dash));

    /* P2-6 简历删除入口：后端 list/delete + 前端管理弹窗 */
    ok('server.py 有简历 list_resumes + delete_resume（归档，不硬删）',
      /def list_resumes\(/.test(srv) && /def delete_resume\(/.test(srv) && /resume-archive/.test(srv));
    ok('前端有 openResumeManager 删除入口',
      /function openResumeManager\(/.test(vc));

    /* P2-8 开发产物：静态服务拒绝下划线开头的文件。
       弱断言坑：只查「出现过 basename.startswith」会被 `if False and basename…`
       这类改坏骗过（子串还在、拦截已失效）→ 必须查「这一行紧跟 return 拒绝」，
       整段拒绝逻辑断了才算坏。
       （评审核实 2026-10-30：拦截从 `('_')` 扩成 `('_', '.')`，点开头的
        `.impeccable.md` 也一并挡掉。） */
    ok('静态服务拒绝伺服下划线开头的开发产物（_测试_*.js 等不再可直读）',
      /if\s+basename\.startswith\(\('_'\,\s*'\.'\)\):\s*\n\s*return\s+self\._send\(404,/.test(srv));
  }

  /* --- 18.8j 采集「一键冻结」暂停/继续 + 输出熔断 + 翻页防死循环（2026-10-06） ---
     起因是现场真事故：浏览器连接断开后 crawler 在翻页循环里「失败就 continue」，
     页号不变、无上限、无退避 → 1 分钟把日志刷到 424MB，内存和前端一起被拖死。
     所以这一组同时守三件事：① 翻页失败必须封顶 ② 能主动暂停（挂起整棵进程树）
     ③ 失控刷屏会被自动熔断兜住。 */
  {
    const readText = rel => fs.readFileSync(path.join(DIR, rel), 'utf8');
    const srv = readText('采集器/server.py');
    const vc = readText('js/view-collect.js');
    // 采集内核在 skill 目录（不在本仓库），读不到就按空串处理 —— 断言会因
    // 「找不到」而红，而不是让整个测试崩掉。
    const SKILL = 'C:/Users/1/.workbuddy/skills/boss-crawler';
    const readMaybe = p => { try { return fs.readFileSync(p, 'utf8'); } catch (e) { return ''; } };
    const crawler = readMaybe(SKILL + '/scripts/boss_crawler/crawler.py');
    const cfg = readMaybe(SKILL + '/scripts/boss_crawler/config.py');

    /* ① 翻页滚动失败必须封顶 —— 防死循环的根因 */
    ok('config 声明了 SCROLL_FAIL_LIMIT（翻页滚动失败封顶）',
      /SCROLL_FAIL_LIMIT\s*=\s*\d+/.test(cfg));
    ok('crawler 真的引入了 SCROLL_FAIL_LIMIT', /SCROLL_FAIL_LIMIT/.test(crawler));
    /* 弱断言坑（两次踩）：
       ① 只查「文件里出现过 scroll_fail」会被「只 +1 不 break」的版本骗过；
       ② 用 `scroll_fail >= SCROLL_FAIL_LIMIT` 这种**裸子串**匹配，会被
          `if False and scroll_fail >= …` 骗过（子串还在、判断已被短路失效）。
       所以上限判断必须要求「行首就是 if」（m 标志），且后面真跟着 break。 */
    ok('滚动失败有计数（scroll_fail += 1）', /^\s*scroll_fail \+= 1/m.test(crawler));
    ok('滚动失败到上限的判断**未被短路**（行首就是 if，不是 `if False and`）',
      /^\s*if scroll_fail >= SCROLL_FAIL_LIMIT:/m.test(crawler));
    ok('到上限后真的 break 停止本轮（不是无限 continue 空转）',
      /if scroll_fail >= SCROLL_FAIL_LIMIT:[\s\S]{0,300}?break/.test(crawler));
    ok('滚动失败后会退避再试（不裸 continue 空转刷屏）',
      /滚动失败[\s\S]{0,500}?sleep_config\.sleep\(/.test(crawler));

    /* ② 主动暂停 = 挂起整棵进程树（含浏览器），不是杀进程 */
    ok('server 用 ntdll 的 NtSuspendProcess / NtResumeProcess 做挂起与恢复',
      /NtSuspendProcess/.test(srv) && /NtResumeProcess/.test(srv));
    ok('server 有 _suspend_tree 挂整棵树（venv 的 python.exe 是 shim，会多一层进程）',
      /def _suspend_tree\(/.test(srv) && /_windows_process_tree\(root\)/.test(srv));
    ok('server 有 pause_task / resume_task',
      /def pause_task\(/.test(srv) && /def resume_task\(/.test(srv));
    ok('路由有 /api/pause 与 /api/continue（/api/resume 已被「上传简历」占用）',
      /\/api\/pause/.test(srv) && /\/api\/continue/.test(srv));
    ok('Task.snapshot 把 paused 带给前端（否则按钮状态永远不同步）',
      /'paused':\s*self\.paused/.test(srv));
    ok('停止前先把挂起的进程解冻（避免留下冻住的孤儿浏览器进程）',
      /if was_paused:[\s\S]{0,250}?_suspend_tree\(proc\.pid, False\)/.test(srv));

    ok('pause_task 里真的调用了挂起（不是只改个 paused 标志骗人）',
      /def pause_task\([\s\S]{0,1600}?_suspend_tree\(root, True\)/.test(srv));
    ok('挂起/恢复走的是 ntdll 那两个 API（行首精确匹配，防被 `if False and` 短路）',
      /^\s*fn = ntdll\.NtSuspendProcess if suspend else ntdll\.NtResumeProcess/m.test(srv));

    /* ③ 输出熔断：失控刷屏会被自动挂起兜住 */
    ok('server 有输出熔断阈值（RATE_MAX_LINES）', /RATE_MAX_LINES\s*=\s*\d+/.test(srv));
    /* 同样是防短路：要求这几行**行首精确**就是它们，而不是被 `and False` 挂掉。 */
    ok('熔断的触发条件未被短路（到阈值且任务未暂停才熔断）',
      /^\s*elif win_lines >= RATE_MAX_LINES and not task\.paused:/m.test(srv));
    ok('熔断后真的挂起整棵进程树',
      /^\s*okn, tot = _suspend_tree\(proc\.pid, True\)/m.test(srv));
    ok('熔断后真的把任务置为 paused', /^\s*task\.paused = True/m.test(srv));
    ok('熔断给的是人话提示（说清已自动暂停、怎么恢复）',
      /已自动暂停以保护内存与磁盘/.test(srv));

    /* ④ 前端：暂停/继续入口与暂停态都可见 */
    ok('前端有 doPause / doResume 且走对接口（pause / continue）',
      /function doPause\(/.test(vc) && /function doResume\(/.test(vc) &&
      /\/api\/pause/.test(vc) && /\/api\/continue/.test(vc));
    ok('前端导出 _doPause / _doResume / _paintTaskBar 供测试直驱',
      /_doPause:\s*doPause/.test(vc) && /_doResume:\s*doResume/.test(vc) &&
      /_paintTaskBar:\s*paintTaskBar/.test(vc));
    ok('任务卡按 paused 显示「⏸ 已暂停」（暂停了还写「进行中」会把人骗了）',
      /paused\s*\?\s*'⏸ 已暂停'\s*:\s*'进行中'/.test(vc));
    ok('任务卡在跑动时给出「⏸ 暂停」/「▶ 继续」按钮',
      /html:\s*'⏸ 暂停'/.test(vc) && /html:\s*'▶ 继续'/.test(vc));
    ok('暂停时进度条静止（真冻住了就别再滚）',
      /else if \(!paused\) pbarCls \+= ' task-pbar-run';/.test(vc));

    /* ⑤ 行为层：paintTaskBar 真的按 paused 渲染出不同东西（不只是源码里有字） */
    {
      const bar = U.el('div', {});
      const base = { running: true, paused: false, title: '采集', started_at: Date.now() / 1000,
                     exit_code: null, key: 'crawl' };
      Views.collect._paintTaskBar(bar, base);
      const runningTxt = (bar.textContent || '');
      const runBars = U.$$('.task-pbar-run', bar).length;
      ok('跑动中：状态写「进行中」', runningTxt.indexOf('进行中') >= 0, runningTxt.slice(0, 120));
      ok('跑动中：进度条带滚动动画 task-pbar-run', runBars === 1, String(runBars));
      ok('跑动中：给出「⏸ 暂停」按钮', runningTxt.indexOf('⏸ 暂停') >= 0, runningTxt.slice(0, 160));

      Views.collect._paintTaskBar(bar, Object.assign({}, base, { paused: true }));
      const pausedTxt = (bar.textContent || '');
      const pausedRunBars = U.$$('.task-pbar-run', bar).length;
      ok('暂停中：状态改写「⏸ 已暂停」', pausedTxt.indexOf('⏸ 已暂停') >= 0, pausedTxt.slice(0, 120));
      ok('暂停中：不再有滚动动画（进度条静止）', pausedRunBars === 0, String(pausedRunBars));
      ok('暂停中：按钮变成「▶ 继续」', pausedTxt.indexOf('▶ 继续') >= 0, pausedTxt.slice(0, 160));
    }
  }

  /* --- 18.8k 岗位库 → BOSS 投递全链路（阶段 1/2/3/4，2026-10-06） ---
     这一轮把「岗位库里筛好的岗位」一路打通到 BOSS 聊天页，并让投递状态/回复/邀约/待跟进
     四处联动。守四件事：
       ① 深链地基（link → url → encryptJobId）真的落库了
       ② 「去投递」只记 todo，**不得**污染投递统计（hasApplied）
       ③ 「我已投了」推进 applied 并且**不 snooze**（snooze 会把待跟进页那条藏起来，正好相反）
       ④ 危险功能（一键打招呼 / 同步回复）必须默认关闭，且关的时候入口真的消失
     ——④ 是重点：用户能开的功能，必须有能把它关掉的地方，而且要有测试真去关它。 */
  {
    /* ---- ① 数据层：link → url → encryptJobId ---- */
    const AB = sandbox.ApplyBoss;      // ← 必须最先取，后面到处用（const 有 TDZ）
    const BOSS_URL = 'https://www.zhipin.com/job_detail/6bcc237af9aa45320nJ60tu6ElJU.html';
    eq('从 BOSS 链接抠职位 ID',
      Store.bossJobIdOf(BOSS_URL), '6bcc237af9aa45320nJ60tu6ElJU');
    eq('带 query / hash 也抠得出来',
      Store.bossJobIdOf(BOSS_URL + '?lid=1#x'), '6bcc237af9aa45320nJ60tu6ElJU');
    eq('不是 BOSS 的链接 → 空串（不编 ID）', Store.bossJobIdOf('https://example.com/a'), '');
    eq('空值不炸', Store.bossJobIdOf(''), '');

    const savedJobs = Store.jobs().slice();
    /* ⚠️ addJob 的返回形状是**两种**：新岗位返回 job 本身，命中同名岗位时返回
       {job, dup:true}（走 mergeJobInto 合并）。测试里必须兼容两种，
       否则第一句就读到 undefined，后面全跟着崩 —— 而且看起来像产品坏了。 */
    const unwrap = r => (r && r.job) ? r.job : r;
    const jBoss = unwrap(Store.addJob({ title: '亚马逊精品运营', company: '文秀智造', url: BOSS_URL, source: 'boss' }));
    eq('写库时 encryptJobId 自动从 url 解析并落库', jBoss.encryptJobId, '6bcc237af9aa45320nJ60tu6ElJU');
    const jManual = unwrap(Store.addJob({ title: '手动岗位', company: '某公司', source: 'manual' }));
    eq('手动新增的岗位没有职位 ID（就是空串，不瞎编）', jManual.encryptJobId, '');
    /* 老数据的回填：一个只有 url、没有 encryptJobId 的岗位，重新导入时必须补上，
       否则「按职位 ID 定位岗位」这条链对老用户永远不生效。 */
    const jOld = Store.job(jBoss.id);
    ok('mergeJobInto 的白名单包含 encryptJobId（否则老岗位永远补不上这个字段）',
      /'encryptJobId',/.test(fs.readFileSync(path.join(DIR, 'js/store.js'), 'utf8')));
    eq('老岗位（只有 url）也能现解析出职位 ID（兜底路径，不依赖落库字段）',
      AB.jobIdOf({ url: BOSS_URL }), '6bcc237af9aa45320nJ60tu6ElJU');
    eq('岗位对象上确实带着 encryptJobId', Store.job(jOld.id).encryptJobId, '6bcc237af9aa45320nJ60tu6ElJU');

    /* ---- ② 「去 BOSS 投递」的闸门（AB 已在块首取好） ---- */
    ok('apply-boss.js 已加载并对外暴露', !!AB);
    eq('有链接的岗位可以跳', AB.canOpen(jBoss).ok, true);
    const manualGate = AB.canOpen(jManual);
    eq('没链接的岗位不能跳', manualGate.ok, false);
    ok('不能跳时必须给中文原因（而不是静默失败）',
      typeof manualGate.reason === 'string' && manualGate.reason.indexOf('没有 BOSS 链接') >= 0,
      manualGate.reason);

    /* ---- ③ 记 todo，且**不得**进投递统计 ---- */
    const beforeApps = Store.applications().length;
    const visit = Store.recordBossVisit(jBoss.id);
    eq('点「去投递」会建一条记录', Store.applications().length, beforeApps + 1);
    eq('这条记录的状态是 todo（只是"打开过"，不是"投出去了"）', visit.status, 'todo');
    eq('⛔ todo 不得被算成「已投递」（否则投递数/回复率会虚增）',
      Store.hasApplied(visit), false);
    ok('时间线里写清了「还没确认投出去」',
      (visit.timeline || []).some(t => String(t.note).indexOf('还没确认') >= 0),
      JSON.stringify(visit.timeline));
    const stBefore = Store.stats().appliedTotal;
    eq('投递总数不因 todo 变化', Store.stats().appliedTotal, stBefore);
    const again = Store.recordBossVisit(jBoss.id);
    eq('重复点不重复建记录', again.id, visit.id);

    /* ---- ④ 「我已投了」推进 applied ---- */
    const applied = Store.markAppliedByUser(jBoss.id);
    eq('确认后状态变 applied', applied.status, 'applied');
    ok('确认后 appliedAt 有值（待跟进页靠它算天数）', !!applied.appliedAt, String(applied.appliedAt));
    eq('确认后它才被算进「已投递」', Store.hasApplied(applied), true);
    /* ⚠️ 关键反向断言：不能 snooze。
       待跟进页的 staleApplied 是「appliedAt 超过 followUp.appliedDays 天」自动出现；
       若这里 snooze，等于把它从待跟进页藏起来 —— 和用户想要的正好相反。 */
    const appId = applied.id;
    eq('⛔ 确认投递**不得**顺手 snooze（snooze = 把它从待跟进页藏起来）',
      Store.isSnoozed('staleApplied:' + appId), false);
    eq('幂等：再点一次不重复推进', Store.markAppliedByUser(jBoss.id).status, 'applied');

    /* ---- ⑤ 危险开关：默认关 + 关的时候入口真的没有 ---- */
    const cfg0 = Store.settings().boss;
    ok('设置里存在 boss 配置块', !!cfg0);
    eq('「一键打招呼」默认关闭', !!cfg0.autoGreet, false);
    eq('「同步回复」默认关闭', !!cfg0.syncReply, false);

    const cardOff = Views.jobs._bossActBar(jBoss, Store.appOfJob(jBoss.id), null);
    const txtOff = cardOff ? cardOff.textContent : '';
    ok('开关关着时：卡片上有「去 BOSS 投递」', txtOff.indexOf('去 BOSS 投递') >= 0, txtOff);
    eq('开关关着时：**没有**「一键打招呼」入口', txtOff.indexOf('一键打招呼') >= 0, false);

    AB.setAutoGreet(true);
    eq('开关能打开并落盘', Store.settings().boss.autoGreet, true);
    const cardOn = Views.jobs._bossActBar(jBoss, Store.appOfJob(jBoss.id), null);
    ok('开关打开后：卡片上出现「⚡ 一键打招呼」',
      (cardOn.textContent || '').indexOf('一键打招呼') >= 0, cardOn.textContent);
    AB.setAutoGreet(false);
    eq('开关能关掉（能被关掉才算真的能关）', Store.settings().boss.autoGreet, false);
    const cardOff2 = Views.jobs._bossActBar(jBoss, Store.appOfJob(jBoss.id), null);
    eq('关掉后入口真的消失（不是只是变灰）',
      (cardOff2.textContent || '').indexOf('一键打招呼') >= 0, false);

    /* 开关必须能跨「重载」活下来 —— mergeSettings 漏了 boss 块时，
       页面上能切、toast 也弹，但一刷新就回默认关闭。 */
    const reloaded = Store.settings();
    ok('boss 块参与 mergeSettings（否则刷新就丢开关）',
      /if \(s\.boss\) base\.boss = Object\.assign\(base\.boss/.test(
        fs.readFileSync(path.join(DIR, 'js/store.js'), 'utf8')));

    /* ---- ⑥ 一键打招呼的冷却闸门（纯函数） ---- */
    AB.setAutoGreet(true);
    const now = Date.now();
    eq('开关开着 + 合法岗位 + 没冷却 → 放行', AB.canAutoGreet(jBoss, now).ok, true);
    eq('开关关着 → 拦住', (AB.setAutoGreet(false), AB.canAutoGreet(jBoss, now).ok), false);
    AB.setAutoGreet(true);
    const jCool = Store.updateJob(jBoss.id, { greetAt: now - 3600000 });   // 1 小时前打过
    const cool = AB.canAutoGreet(jCool || Store.job(jBoss.id), now);
    eq('24 小时内重复打招呼 → 拦住', cool.ok, false);
    ok('拦住时说明还剩多久', cool.reason.indexOf('小时') >= 0, cool.reason);
    eq('没链接 → 拦住', AB.canAutoGreet(jManual, now).ok, false);

    /* 招呼语取值：手填 > 岗位存的 AI 话术 > 空 */
    eq('手填优先', AB.greetingFor(jBoss, '  手填的话  '), '手填的话');
    const jg = Store.updateJob(jBoss.id, { aiGreeting: 'AI 生成的话' });
    eq('没手填就用岗位上存的 AI 话术', AB.greetingFor(jg || Store.job(jBoss.id), ''), 'AI 生成的话');
    eq('两样都没有 → 空串（服务端会拒发，不拿空话去烧额度）',
      AB.greetingFor(jManual, ''), '');

    /* ---- ⑦ 同步回复：默认全部「忽略」，绝不自动写 ---- */
    AB.setSyncReply(true);
    const jobsPool = Store.jobs().slice();
    const cands = [
      { company: '文秀智造', hr: '李女士', lastText: '方便下周来面试吗？', unread: true, invited: true },
      { company: '根本不存在的公司', hr: 'x', lastText: '你好', unread: false, invited: false },
    ];
    const plan = AB.planSyncActions(cands, jobsPool);
    eq('候选条数对得上', plan.length, 2);
    eq('⛔ 默认动作必须是 ignore（不是帮你猜好再让你取消）', plan[0].action, 'ignore');
    eq('第二批也默认 ignore', plan[1].action, 'ignore');
    eq('匹配得上本地岗位的行会标出来', plan[0].matched, true);
    eq('匹配不上本地岗位的行也标出来', plan[1].matched, false);
    eq('匹配不上时 jobId 为空（不许瞎指一个岗位）', plan[1].jobId, '');

    /* 匹配不上 → 就算用户手滑选了动作，也必须跳过 */
    const out1 = AB.applySyncPlan(plan, { 0: 'ignore', 1: 'viewed' });
    eq('没选动作 → 一条都不写', out1.updated, 0);
    eq('匹配不上的行即使选了动作也被跳过', out1.skipped, 1);

    /* 选「已回复」→ 推进 viewed；选「邀约」→ 推进 invited + 可选建面试 */
    const appJ = Store.appOfJob(jBoss.id);
    const out2 = AB.applySyncPlan(plan, { 0: 'viewed' });
    eq('选了「已回复」→ 写入 1 条', out2.updated, 1);
    eq('状态被推进到 viewed', Store.application(appJ.id).status, 'viewed');
    ok('时间线记了来源（从 BOSS 同步）',
      (Store.application(appJ.id).timeline || []).some(t => String(t.note).indexOf('从 BOSS 同步') >= 0));

    plan[0].curIndex = Store.reachedIndex(Store.application(appJ.id));
    const out3 = AB.applySyncPlan(plan, { 0: 'viewed' });
    eq('⛔ 已经在这个状态或更远 → 不倒退', out3.updated, 0);
    eq('并且如实报告跳过', out3.skipped, 1);

    const ivBefore = Store.interviews().length;
    const plan2 = AB.planSyncActions(
      [{ company: '文秀智造', hr: '李女士', lastText: '来面试', unread: true, invited: true }], jobsPool);
    plan2[0].makeInterview = true;
    const out4 = AB.applySyncPlan(plan2, { 0: 'invited' });
    eq('选「邀约」→ 状态推进到 invited', Store.application(appJ.id).status, 'invited');
    eq('同时在面试管理里建了一条', Store.interviews().length, ivBefore + 1);
    eq('建出来的面试是「待安排」（没时间，用户去填）',
      Store.interviews().slice(-1)[0].at, null);
    /* ⚠️ 轮次不能写死「一面」：一条聊天消息读不出是第几轮。
       写「一面」会经 autoSyncInterview → roundToStatus 把状态从「邀约」推到「一面」，
       而面试时间都还没定 —— 把进度说过头，会污染漏斗与回复率。 */
    eq('轮次写「待定」（不冒充第几轮）', Store.interviews().slice(-1)[0].round, '待定');
    eq('⛔ 建了待安排的面试**也不得**把状态从「邀约」偷推到「一面」',
      Store.application(appJ.id).status, 'invited');
    /* 已经有待安排面试 → 不重复建 */
    const plan3 = AB.planSyncActions(
      [{ company: '文秀智造', hr: '李女士', lastText: '来面试', invited: true }], jobsPool);
    plan3[0].makeInterview = true;
    const out5 = AB.applySyncPlan(plan3, { 0: 'invited' });
    eq('已经有待安排的面试 → 不重复建', Store.interviews().length, ivBefore + 1);
    ok('并且说明了为什么没建',
      out5.details.some(d => d.indexOf('已经有待安排的面试') >= 0), JSON.stringify(out5.details));

    /* 从没投过的岗位：有一条聊天记录也不能凭空认定"投过" */
    const jNever = Store.addJob({ title: '从没投过的岗位', company: '文秀智造', url: BOSS_URL, source: 'boss' });
    const planNever = AB.planSyncActions([{ company: '文秀智造', lastText: 'hi' }], Store.jobs());
    const rowNever = planNever[0];
    ok('匹配到了那个岗位', !!rowNever.jobId);
    rowNever.jobId = jNever.id;                       // 强制指到"没投过"的岗位
    const out6 = AB.applySyncPlan([rowNever], { 0: 'viewed' });
    eq('本地没有投递记录 → 跳过（不能凭空认定投过）', out6.skipped, 1);
    eq('没有产生任何投递记录', Store.appOfJob(jNever.id), null);

    AB.setAutoGreet(false); AB.setSyncReply(false);
    eq('同步开关也能关掉', Store.settings().boss.syncReply, false);

    /* ---- ⑧ 采集页不因新模块而挂 ---- */
    const vcSrc = fs.readFileSync(path.join(DIR, 'js/view-collect.js'), 'utf8');
    ok('apply-boss.js 在 index.html 里被引入',
      indexHtml.indexOf('js/apply-boss.js') >= 0);
    ok('apply-boss.js 排在 view-jobs.js 之前（卡片要用它的 canOpen）',
      indexHtml.indexOf('js/apply-boss.js') < indexHtml.indexOf('js/view-jobs.js'));
    ok('view-collect 导出了 _req（否则 apply-boss 自己写 fetch 会漏带令牌 → 莫名 403）',
      /_req:\s*req/.test(vcSrc));

    /* 清理：把本轮建的岗位/记录撤掉，别污染后面跑的用例 */
    Store.removeApplication(Store.appOfJob(jBoss.id).id);
    Store.removeJob(jBoss.id); Store.removeJob(jManual.id); Store.removeJob(jNever.id);
    Store.setSetting('boss.lastGreetAt', 0);
  }

  /* --- 18.8L 设置页的两个危险开关 + 服务端闸门（真点） ---
     「用户能关的功能必须给关掉的地方 + 有测试真点它」是项目铁律。
     所以这里不查文本出现过关键词，而是**真的去勾那个 checkbox、真的读落盘值**。 */
  {
    const AB2 = sandbox.ApplyBoss;
    const prevGreet = Store.settings().boss.autoGreet;
    const prevSync = Store.settings().boss.syncReply;
    Store.setSetting('boss.autoGreet', false);
    Store.setSetting('boss.syncReply', false);

    App.go('settings');
    await tick();
    const stxt = viewText();
    ok('设置页有「自动触达 BOSS」这一节', stxt.indexOf('自动触达 BOSS') >= 0, stxt.slice(0, 200));
    ok('设置页写明了「消息撤不回」这个后果', stxt.indexOf('撤不回') >= 0);
    ok('设置页写明了「沟通条数有限」', stxt.indexOf('沟通条数') >= 0);
    ok('设置页写明了自动化可能违反 BOSS 用户协议（风险自负要直说）',
      stxt.indexOf('用户协议') >= 0);

    /* ⚠️ 选择器必须收窄到 **label 本身**，不能爬到 parentNode.parentNode：
       那会拿到整个 .body 的文本，于是「同步回复」也能匹配上「一键打招呼」那个勾选框，
       两个查询都返回同一个元素 —— 测试看起来在测两个开关，其实只碰了第一个。
       （这就是「选择器不收窄到容器」那条反模式，又踩了一次。） */
    const findChk = (kw) => U.$$('#view input[type=checkbox]').filter(c => {
      const lab = c.parentNode;
      return lab && (lab.textContent || '').indexOf(kw) >= 0;
    })[0];

    const cg = findChk('一键打招呼');
    const cs = findChk('同步回复');
    ok('找得到「一键打招呼」的开关', !!cg);
    ok('找得到「同步回复 / 邀约」的开关', !!cs);
    ok('⛔ 两个开关是**不同**的元素（收窄选择器的证据）', cg && cs && cg !== cs);

    /* 真点开 */
    cg.checked = true;
    cg.dispatchEvent({ type: 'change', target: cg, stopPropagation() { }, preventDefault() { } });
    await tick();
    eq('勾上「一键打招呼」→ 真的落盘成 true', Store.settings().boss.autoGreet, true);
    eq('并且 ApplyBoss 读到的也是开', AB2.autoGreetOn(), true);

    cs.checked = true;
    cs.dispatchEvent({ type: 'change', target: cs, stopPropagation() { }, preventDefault() { } });
    await tick();
    eq('勾上「同步回复」→ 真的落盘成 true', Store.settings().boss.syncReply, true);
    eq('并且 ApplyBoss 读到的也是开', AB2.syncReplyOn(), true);

    /* 真点关 —— 这才是「能关掉」的证据 */
    App.go('settings');
    await tick();
    const cg2 = U.$$('#view input[type=checkbox]').filter(c => {
      const lab = c.parentNode;
      return lab && (lab.textContent || '').indexOf('一键打招呼') >= 0;
    })[0];
    ok('重新进设置页，开关是勾上的（状态没丢）', cg2 && cg2.checked === true);
    cg2.checked = false;
    cg2.dispatchEvent({ type: 'change', target: cg2, stopPropagation() { }, preventDefault() { } });
    await tick();
    eq('取消勾选 → 真的落盘成 false', Store.settings().boss.autoGreet, false);
    eq('并且 ApplyBoss 读到的也是关', AB2.autoGreetOn(), false);

    /* 投递面板的「同步回复」按钮：开关关着时不该出现。
       ⚠️ 按钮在顶栏 #topActions，**不在 #view 里** —— 查 viewText() 永远是空，
       这条断言就会"永远失败"或"永远通过"，两种情况都没意义。 */
    const topTxt = () => (U.$('#topActions') || {}).textContent || '';
    Store.setSetting('boss.syncReply', false);      // ← 上面点开关时把它打开过，这里显式复位
    App.go('kanban');
    await tick();
    eq('开关关着时：投递面板**没有**「同步回复」入口',
      topTxt().indexOf('同步回复') >= 0, false);
    Store.setSetting('boss.syncReply', true);
    // ⚠️ 用 App.refresh() 而不是再调一次 App.go('kanban')：
    //    App.go 对"已经在同一页"会走捷径不重画，于是按钮永远不会出现 —— 假红。
    App.refresh();
    await tick();
    ok('开关打开后：投递面板出现「同步回复」入口', topTxt().indexOf('同步回复') >= 0,
      topTxt().slice(0, 180));

    Store.setSetting('boss.autoGreet', prevGreet);
    Store.setSetting('boss.syncReply', prevSync);
    clearToasts();
  }

  /* --- 18.8M 服务端：打招呼的闸门 + 命令构造（静态查真源，不靠印象） --- */
  {
    const srv = fs.readFileSync(path.join(DIR, '采集器/server.py'), 'utf8');
    const one = fs.readFileSync('C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/boss_apply_one.py', 'utf8');
    const chat = fs.readFileSync('C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/boss_chat_sync.py', 'utf8');

    ok('server.py 有 /api/apply-one 路由', /path == '\/api\/apply-one'/.test(srv));
    ok('server.py 有 /api/sync-reply 路由', /path == '\/api\/sync-reply'/.test(srv));
    ok('两个路由都挂在 POST 上（前端 doAutoGreet 用的 method 是 POST）',
      srv.indexOf("'/api/apply-one'") > srv.indexOf('def do_POST'),
      'apply-one 必须出现在 do_POST 之后');
    ok('打招呼的等待上限 > 300（脚本内部等扫码最多 300s，短了会把正在扫码的请求掐掉）',
      /APPLY_WAIT_SEC\s*=\s*(\d+)/.test(srv) && Number(/APPLY_WAIT_SEC\s*=\s*(\d+)/.exec(srv)[1]) > 300,
      (/(APPLY_WAIT_SEC\s*=\s*\d+)/.exec(srv) || [])[0]);

    /* 闸门每一条都要有独立的一行判断 —— 弱断言会被"注释里提一句"骗过 */
    ok('闸门校验：链接必须是 BOSS 职位详情页（行首就是 if，后面真 return False）',
      /^\s*if not BOSS_JOB_URL_RE\.match\(url\):\s*\n\s*return False/m.test(srv));
    ok('闸门校验：招呼语为空必须拦（行首 if + 真 return）',
      /^\s*if not greeting:\s*\n\s*return False/m.test(srv) && /招呼语是空的/.test(srv));
    ok('闸门校验：招呼语超长必须拦（行首 if len>500 + 真 return）',
      /^\s*if len\(greeting\) > 500:\s*\n\s*return False/m.test(srv));
    ok('闸门校验：没有岗位名也没公司名要拦（行首 if + 真 return）',
      /^\s*if not \(payload\.get\('title'\) or payload\.get\('company'\)\):\s*\n\s*return False/m.test(srv));
    ok('⚠️ 闸门里**不接受数组**（一次只能一个岗位，批量是明确不做的）',
      !/for\s+\w+\s+in\s+payload\.get\('urls'/.test(srv) && /一次只处理一个岗位/.test(srv));

    /* 脚本侧：不可逆动作的三条硬约束 */
    ok('打招呼脚本一次只发一个（max_applications=1）',
      /max_applications=1/.test(one), (/(max_applications=\d+)/.exec(one) || [])[0]);
    ok('打招呼脚本失败**不重试**（有明确声明）', /绝不重试|不会重试|_不会重试_/.test(one));
    ok('打招呼脚本自己复刻了一遍闸门（纵深防御，不依赖服务端）',
      /def gate\(/.test(one) && /BOSS_JOB_RE\.match/.test(one));
    ok('打招呼脚本的日志目录**不碰**采集的运行目录（否则会推进 LATEST 指针）',
      /_apply-one/.test(one) && /不要.*LATEST|推进 LATEST|create_run_dir/.test(one));

    /* 读聊天脚本：读不到必须报"需要校准"，不能返回空数组假装"没有新消息" */
    ok('读聊天脚本区分「读不到结构」和「真的没有新消息」（退出码 4 + needCalibration）',
      /needCalibration/.test(chat) && /return 4/.test(chat));
    ok('读聊天脚本提供了 --dump 校准模式（不猜选择器）',
      /--dump/.test(chat) && /DUMP_JS/.test(chat));
    ok('⛔ 读聊天脚本不编造时间：折不出来必须 return None',
      /^\s*except ValueError:\s*\n\s*return None\s*$/m.test(chat) && /不要编一个"现在"上去/.test(chat));
    /* 反向断言：源码里不能出现「折不出来就塞 now」这种兜底。
       ⚠️ 不能用 `/return int(now)/` 直接取反 —— 「刚刚」那一处**合法地**就是
       `return int(now)`。所以改成**计数**：它只允许出现 1 次（就是「刚刚」），
       多出来的那一处必是「折不出来就编一个现在」的兜底。
       这也解释了为什么只搜 `return None` 抓不住这条变异：文件里另外两处 return None
       （空串早返回）会替它顶包。 */
    eq('⛔ `return int(now)` 只允许出现 1 次（「刚刚」那处）；多一处就是编造时间的兜底',
      (chat.match(/return int\(now\)/g) || []).length, 1);
    ok('读聊天脚本只产出候选、不写任何数据（不 import Store 那套）',
      !/localStorage/.test(chat) && !/Store\./.test(chat));
    ok('⚠️ 疑似邀约只做关键词提示，绝不自动建面试记录',
      /INVITE_WORDS/.test(chat) && /绝不.*自动建面试记录|不.*据此自动建面试记录/.test(chat));

    /* ---- 整改：task-*.log 保留策略 / new_run_dir 失败可见化（评审 3.1 + 复核新增）---- */
    ok('server.py 有 prune_task_logs（任务日志保留策略）', /def prune_task_logs\(/.test(srv));
    ok('启动时会调用 prune_task_logs（不是在别处定义完就没人用）',
      /prune_task_logs\(\)/.test(srv.slice(srv.indexOf('def main()'))),
      'main() 里没调用');
    const trimFn = srv.slice(srv.indexOf('def _trim_task_log('), srv.indexOf('def prune_task_logs('));
    ok('超限日志会被截断（先比大小，没超就直接返回不动它）',
      /getsize\(/.test(trimFn) && /size\s*<=\s*max_bytes/.test(trimFn) && /return False/.test(trimFn),
      '函数体里没找到大小判断');
    ok('⛔ 截断保留的是**尾部**（失败现场），不是头部',
      /seek\(-keep,\s*os\.SEEK_END\)/.test(srv));
    ok('截断后会写一行说明（不能悄悄改用户盘上的文件）',
      /已自动截断|自动截断/.test(srv));
    ok('有保留份数上限常量', /TASK_LOG_KEEP\s*=\s*\d+/.test(srv));

    /* new_run_dir 的两个静默失败点必须堵上 */
    const nrd = srv.slice(srv.indexOf('def new_run_dir()'), srv.indexOf('def state_path('));
    /* ⚠️ 这里必须切片到**代码区**：函数 docstring 里也反复提到 LATEST.txt，
       按 `indexOf('LATEST.txt') ±200` 那个窗口取，取到的是注释、根本盖不到代码 ——
       上一版就是这么写成了假绿（改坏了也照样绿，只有锚点守卫变红）。
       现在用「计数」判：代码区里 `except OSError` 只允许出现 1 次
       （那一处在「复制简历画像」上，是合理的非致命失败）；
       LATEST 指针写入被改成 try/except 吞掉就会变成 2 次。 */
    const nrdCode = nrd.slice(nrd.lastIndexOf('"""') + 3);
    eq('⛔ new_run_dir 的代码区只允许有 1 处 except OSError（写 LATEST 失败必须抛，不能吞）',
      (nrdCode.match(/except OSError/g) || []).length, 1);
    ok('⛔ _crawl 会校验 new_run_dir 的返回值（拿不到目录就拒绝开跑，避免写进上一轮目录）',
      /rd = new_run_dir\(\)/.test(srv) && /建不了本轮运行目录/.test(srv));
  }

  /* 等一段真实时间（防抖/轮询都要用）。放在块**外面** —— sleep 在下面的块里各定义一份
     会互相看不见（const 是块作用域）。 */
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  /* --- 18.8N 整改：搜索框丢焦点 / 登录预检永不 resolve（评审 4.1 / 4.4） ---
     这两条是「界面看起来正常、实际用不了」的典型，之前 1587 项测试全绿也没抓到 ——
     因为桩里的 focus() 是空的、而 poll 的失败路径根本没人断言过。
     这里顺便把桩补成了「focus 真的记 activeElement」，否则这类 bug 永远测不出来。 */
  {

    /* ---- A2-1 岗位库：打字后焦点还在、光标位置也还原 ---- */
    App.go('jobs');
    await tick();
    const kwJ = U.$('#view input[data-focus-key="job-kw"]');
    ok('岗位库搜索框带 data-focus-key（重画后靠它找回替身节点）', !!kwJ);
    if (kwJ) {
      kwJ.focus();
      // ⚠️ 别把 DOM 节点本身丢给 eq() 当实参：失败信息会 JSON 序列化它，
      //    节点是循环结构 → 抛「Converting circular structure to JSON」，
      //    把整块测试炸掉（比断言失败更难查）。要比就比布尔。
      ok('focus() 之后 document.activeElement 就是它（桩真的在模拟焦点了）',
        document.activeElement === kwJ);
      kwJ.value = '运营';
      kwJ.dispatchEvent({ type: 'input', target: kwJ, stopPropagation() { }, preventDefault() { } });
      await sleep(320);                       // 等过防抖（180ms）+ 一次渲染
      const afterJ = U.$('#view input[data-focus-key="job-kw"]');
      ok('⛔ 打字后焦点**仍在**搜索框（以前整页重建会把它丢掉）',
        document.activeElement === afterJ, String(document.activeElement && document.activeElement.tagName));
      ok('重画后拿到的是**新**节点（说明真的重建过，不是"没重画"蒙对的）',
        !!afterJ && afterJ !== kwJ);
      eq('重画后输入框的值就是刚打的字（没被清空）', afterJ && afterJ.value, '运营');
    }

    /* ---- A2-2 采集结果区：整卡重画也要保住焦点 ----
       ⚠️ 必须先把采集页弄成**真的在线态**：结果卡只在「已连上采集器」那条分支里挂上去，
          离线/缺令牌会提前 return，输入框根本不存在。
          上一版手改 CS.ping 是不行的 —— 渲染链里的 detect() 会把它覆盖掉。
          所以复用文件级的 fakePing / fakeJobs 桩，走完 detect → ping → 渲染 → loadResult。
       （教训与评审第六节同一个：断言看着在，其实没跑到 → 只能靠锚点失配变红 = 假绿。） */
    const savedResultForFocus = VC._state.result;
    VC._state.result = {
      source: '（焦点测试）',
      jobs: [{ '职位': '短视频运营', '公司': '焦点测试公司', '薪资': '12-18K',
               '城市': '杭州', link: 'https://www.zhipin.com/job_detail/focus1.html' }],
    };
    await withFetch(function (url) {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      let body = fakePing;
      if (p.indexOf('/api/task') === 0) {
        body = { ok: true, task: { key: 'crawl', running: false, exit_code: 0,
          started_at: 1, ended_at: 2, total: 2, lines: [] } };
      } else if (p.indexOf('/api/jobs') === 0) body = fakeJobs;
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    }, function () {
      App.go('collect');
      return tick().then(tick).then(tick).then(tick).then(tick).then(tick);
    });
    ok('结果卡 #cResult 已渲染出来（结果区输入框挂在它里面）', !!U.$('#cResult'));
    const kwC = U.$('#view input[data-focus-key="cf-kw"]');
    ok('结果区搜索框已渲染出来（有结果时才有，这条是前提）', !!kwC);
    if (kwC) {
      kwC.focus();
      kwC.value = 'amazon';
      kwC.selectionStart = 3; kwC.selectionEnd = 3;
      kwC.dispatchEvent({ type: 'input', target: kwC, stopPropagation() { }, preventDefault() { } });
      await sleep(300);
      const afterC = U.$('#view input[data-focus-key="cf-kw"]');
      ok('⛔ 结果区打字后焦点仍在（整卡重建也会被还原）',
        !!afterC && document.activeElement === afterC,
        String(document.activeElement && document.activeElement.tagName));
      ok('重画后是**新**节点（证明真的重建过，不是"没重画"蒙对了）',
        !!afterC && afterC !== kwC);
      eq('结果区光标位置被还原到 3', afterC && afterC.selectionStart, 3);
    }
    VC._state.result = savedResultForFocus;
    await tick();

    /* ---- A1: runLoginCheck 在「轮询提前放弃」时必须 resolve ---- */
    // 场景：POST /api/login 成功，但 /api/task 一直说「没有任务」——
    // 旧实现在这里 stopPoll() 就返回、什么都不通知 → promise 永久挂着 → 按钮永久禁用。
    //
    // ⚠️ 必须先把 base 设上：S.base 为空时 poll 会走 'offline' 那条分支，
    //    根本不会去请求 /api/task，就测不到「接口说没有任务」这个场景了。
    const savedBase = VC._state.base;
    VC._state.base = 'http://127.0.0.1:8738/';
    const resolveResult = await withFetch(function (url, init) {
      if (String(url).indexOf('/api/login') >= 0) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ ok: true, key: 'login' })),
        });
      }
      // /api/task：永远「没有任务」
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true, task: null })),
      });
    }, function () {
      return new Promise(function (resolve) {
        let done = false;
        VC._runLoginCheck().then(function (r) { done = true; resolve(r); });
        // 1.6 秒内必须 resolve（轮询间隔 1.2 秒）；给到 3 秒是为了稳
        setTimeout(function () { if (!done) resolve('⛔ 没 resolve（永久挂住）'); }, 3000);
      });
    });
    ok('⛔ 轮询提前放弃时 runLoginCheck 也会 resolve（不再永久挂住 → 按钮不会永久禁用）',
      resolveResult !== '⛔ 没 resolve（永久挂住）', String(resolveResult));
    ok('并且返回 ok=false + 人话原因（而不是静默 false）',
      resolveResult && resolveResult.ok === false && typeof resolveResult.why === 'string'
      && resolveResult.why.length > 4,
      JSON.stringify(resolveResult));

    // 正常路径：任务跑完要返回 ok=true
    const doneResult = await withFetch(function (url) {
      if (String(url).indexOf('/api/login') >= 0) {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ ok: true, key: 'login' })),
        });
      }
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({
          ok: true, task: { key: 'login', running: false, exit_code: 0, total: 0, lines: [] },
        })),
      });
    }, function () { return VC._runLoginCheck(); });
    eq('任务正常跑完 → ok=true（成功路径没被改坏）', !!doneResult && doneResult.ok, true);

    /* ---- A1-b: poll 的 onFail 是真的被回调（不是只加了个参数） ---- */
    let failReason = null;
    await withFetch(function () {
      return Promise.resolve({
        ok: true, status: 200,
        text: () => Promise.resolve(JSON.stringify({ ok: true, task: null })),
      });
    }, function () {
      return new Promise(function (resolve) {
        VC._poll(null, function (why) { failReason = why; resolve(); });
        setTimeout(resolve, 2500);
      });
    });
    eq('poll 在「接口说没有任务」时回调 onFail，并带上原因', failReason, 'no-task');

    VC._state.base = savedBase;      // 还原，别影响后面的用例

    clearToasts();
    await tick();
  }

  /* --- 18.8P 投递看板卡片也能「去 BOSS 投递」（本轮需求） ---
     看板是每天真正干活的那一屏，从这儿回 BOSS 以前要「切岗位库 → 找同一个岗位 → 点链接」。
     口径与岗位库完全一致（共用 js/apply-boss.js），所以这里主要守**三件事**：
       · 有链接才给跳，没链接置灰并说明原因
       · 卡片是可拖拽的，按钮必须 stopPropagation（不能点按钮变成开详情）
       · 危险功能（一键打招呼）跟着开关走 */
  {
    const BOSS_URL2 = 'https://www.zhipin.com/job_detail/6bcc237af9aa45320nJ60tu6ElJU.html';
    // 显式把两个开关关掉，别依赖前面用例留下的状态（否则这条断言的结论取决于执行顺序）
    ApplyBoss.setAutoGreet(false);
    ApplyBoss.setSyncReply(false);
    App.go('kanban');
    await tick();

    const jkRaw = Store.addJob({ title: '看板跳转测试岗', company: '文秀智造', url: BOSS_URL2, source: 'boss' });
    const jkNoRaw = Store.addJob({ title: '看板无链接岗', company: '某公司', source: 'manual' });
    // ⚠️ addJob 的返回形状有两种：新岗位返回 job 本身，命中同名岗位返回 {job, dup:true}。
    //    不解包的话下面 addApplication 会因为 jobId 为空而返回 null → 后面全是莫名其妙的下标错误。
    const unwrapK = r => (r && r.job) ? r.job : r;
    const jk = unwrapK(jkRaw), jkNo = unwrapK(jkNoRaw);
    const ak = Store.addApplication({ jobId: jk.id, status: 'todo' });
    ok('测试前置：岗位与投递记录都建好了', !!jk.id && !!ak, 'jobId=' + jk.id);

    const row = Views.kanban._bossRow(ak, Store.job(jk.id), function () { }, function () { return null; });
    ok('投递卡上能渲染出「去 BOSS」操作条', !!row);
    const rtxt = row ? row.textContent : '';
    ok('操作条带「去 BOSS 投递」', rtxt.indexOf('去 BOSS 投递') >= 0, rtxt);
    ok('未投递的卡也给「我已投了」', rtxt.indexOf('我已投了') >= 0, rtxt);
    // ⚠️ 这里必须用 eq(actual, false)，不能写 ok(name, actual, false) ——
    //    后者的第二个参数是 cond，"实际值"当条件传进去永远是 true，断言等于没有。
    eq('开关关着时**没有**「一键打招呼」', rtxt.indexOf('一键打招呼') >= 0, false);

    /* 每个按钮都必须把点击/拖拽拦在自己身上 —— 否则点按钮会变成"开详情"甚至"拖到别的列"。
       ⚠️ 这一轮是**真点**，会触发真实副作用（「我已投了」会把状态推到 applied），
       所以拿一条**一次性岗位**来点，别污染后面要用状态断言的 jk。
       ⚠️⚠️ 它的链接必须和 jk **不同**：addJob 是按「链接/岗位名+公司」去重的，
          用同一个 URL 会被 merge 成同一条岗位 → 这边点一下「我已投了」就把 jk 也改成 applied 了
          （实测踩过：断言拿到 "applied" 才发现两条岗位其实是同一条）。 */
    const SCRATCH_URL = 'https://www.zhipin.com/job_detail/scratch0000000000.html';
    const jkScratch = unwrapK(Store.addJob({ title: '看板点击隔离岗', company: '另一家公司', url: SCRATCH_URL, source: 'boss' }));
    ok('隔离岗位确实是**另一条**岗位（没被去重合并）', jkScratch.id !== jk.id,
      jkScratch.id + ' vs ' + jk.id);
    const akScratch = Store.addApplication({ jobId: jkScratch.id, status: 'todo' });
    const scratchRow = Views.kanban._bossRow(akScratch, Store.job(jkScratch.id), function () { }, function () { return null; });
    const btns = [];
    (function walk(n) { if (!n) return; (n.children || []).forEach(function (c) { if (c.tagName === 'BUTTON') btns.push(c); walk(c); }); })(scratchRow);
    ok('操作条上的按钮都是真的 button 元素', btns.length >= 2, String(btns.length));
    ok('⛔ 每个按钮都 stopPropagation 了 click（不然点按钮会开详情）',
      btns.every(function (b) {
        const ev = { type: 'click', target: b, _stopped: false, stopPropagation() { this._stopped = true; }, preventDefault() { } };
        b.dispatchEvent(ev);
        return ev._stopped === true;
      }));

    /* 点「去 BOSS 投递」必须真的把岗位链接交给浏览器新标签页打开 ——
       这条是**端到端**的：从按钮点击一路走到 window.open，
       而不是只断言"按钮存在"。jk 没被上面那轮点到，状态应该还是 todo。 */
    sandbox.__openedUrl = null;
    const rowK = Views.kanban._bossRow(ak, Store.job(jk.id), function () { }, function () { return null; });
    const openBtnK = (function walk2(n, acc) {
      if (!n) return acc;
      (n.children || []).forEach(function (c) {
        if (c.tagName === 'BUTTON' && (c.textContent || '').indexOf('去 BOSS') >= 0) acc.push(c);
        walk2(c, acc);
      });
      return acc;
    })(rowK, [])[0];
    if (openBtnK) openBtnK.dispatchEvent({ type: 'click', target: openBtnK, stopPropagation() { }, preventDefault() { } });
    eq('⛔ 点「去 BOSS 投递」真的把该岗位的 BOSS 链接交给了新标签页',
      sandbox.__openedUrl, BOSS_URL2);
    eq('点完记的是「打开过」（todo），不是「已投递」',
      Store.appOfJob(jk.id) && Store.appOfJob(jk.id).status, 'todo');

    /* 无链接的岗位：置灰 + 给原因 */
    const akNo = Store.addApplication({ jobId: jkNo.id, status: 'todo' });
    const rowNo = Views.kanban._bossRow(akNo, Store.job(jkNo.id), function () { }, function () { return null; });
    let openNo = null;
    (function walk(n) { if (!n) return; (n.children || []).forEach(function (c) {
      if (c.tagName === 'BUTTON' && (c.textContent || '').indexOf('去 BOSS') >= 0) openNo = c; walk(c); }); })(rowNo);
    ok('没链接的岗位：跳转按钮被置灰', !!openNo && openNo.disabled === true,
      openNo ? ('disabled=' + openNo.disabled) : '找不到按钮');
    ok('并且 title 里写清了为什么不能跳',
      !!openNo && String(openNo.getAttribute('title') || '').indexOf('没有 BOSS 链接') >= 0,
      openNo && openNo.getAttribute('title'));

    /* 开关打开后要出现「一键打招呼」，行为与岗位库卡片一致 */
    ApplyBoss.setAutoGreet(true);
    const rowOn = Views.kanban._bossRow(ak, Store.job(jk.id), function () { }, function () { return null; });
    ok('开关打开后：投递卡上也出现「⚡ 一键打招呼」',
      (rowOn.textContent || '').indexOf('一键打招呼') >= 0, rowOn.textContent);
    ApplyBoss.setAutoGreet(false);

    /* 已投递的卡片：primary 按钮文案变成「看进度」，且不再重复给「我已投了」 */
    Store.markAppliedByUser(jk.id);
    const rowDone = Views.kanban._bossRow(Store.appOfJob(jk.id), Store.job(jk.id), function () { }, function () { return null; });
    const dtxt = rowDone.textContent || '';
    ok('已投递的卡按钮改成「去 BOSS 看进度」', dtxt.indexOf('看进度') >= 0, dtxt);
    eq('已投递后不再重复给「我已投了」', dtxt.indexOf('我已投了') >= 0, false);

    /* 整卡渲染也带上操作条（不是只有单独调 _bossRow 才有） */
    const whole = Views.kanban._cardEl(Store.appOfJob(jk.id), function () { });
    ok('整张投递卡里确实包含操作条', !!whole && (whole.textContent || '').indexOf('去 BOSS') >= 0,
      whole && (whole.textContent || '').slice(0, 80));
    ok('卡片仍然保持可拖拽（加按钮没把拖拽弄丢）', !!whole && whole.getAttribute('draggable') === 'true',
      whole && whole.getAttribute('draggable'));

    // 清理
    [jk.id, jkScratch.id, jkNo.id].forEach(function (jid) {
      var app = Store.appOfJob(jid);
      if (app) Store.removeApplication(app.id);
      Store.removeJob(jid);
    });
    await tick();
  }

  /* --- 18.8O 整改：配额耗尽后不能永久停写（评审 2.2） ---
     这条以前**完全没被覆盖**：桩里的 setItem 从不失败，所以「写失败之后怎么办」
     根本没进过测试。而真实后果是「界面一切正常、一条都不落盘、用户无感」。 */
  {
    const KEY = 'jobhunter.db.v1.default';
    const realSet = localStorage.setItem;
    const keepJobs = Store.jobs().length;

    // ① 让下一次写入抛 QuotaExceededError（模拟存储满）
    let boom = true;
    localStorage.setItem = (k, v) => {
      if (boom && k === KEY) {
        const e = new Error('QuotaExceededError: exceeded the quota');
        e.name = 'QuotaExceededError';
        throw e;
      }
      return realSet(k, v);
    };

    clearToasts();
    const before = localStorageMap.get(KEY);
    const jq = Store.addJob({ title: '配额测试岗位', company: '某公司' });
    Store.markAppliedByUser(jq.id);            // 触发一次真正落盘
    await sleep(320);
    eq('写失败后 persistOK 变 false（设置页会标红）', Store.persistOK, false);
    ok('并且给出了中文原因（不是静默）',
      typeof Store.persistError === 'string' && Store.persistError.indexOf('写入本地存储失败') >= 0,
      Store.persistError);
    ok('弹过一次醒目提示（告诉用户「这之后的操作刷新会丢」）',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('刷新会丢') >= 0),
      U.$$('#toasts .toast').map(t => t.textContent).join(' | ').slice(0, 160));
    eq('确实没写进去（桩真的在抛）', localStorageMap.get(KEY), before);

    // ② 存储恢复 → 下一次保存必须**重试并复位**（以前是永久停写，这里永远回不来）
    boom = false;
    clearToasts();
    Store.addJob({ title: '配额恢复后岗位', company: '某公司' });
    await sleep(320);
    eq('⛔ 写成功一次就把 persistOK 复位（不再永久停写）', Store.persistOK, true);
    eq('错误信息被清掉', Store.persistError, '');
    ok('明确告诉用户「已恢复落盘」',
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('恢复') >= 0),
      U.$$('#toasts .toast').map(t => t.textContent).join(' | ').slice(0, 160));
    var savedRaw = localStorageMap.get(KEY) || '';
    ok('⛔ 失败期间改的数据也一起补写进去了（不是只补了最后一次）',
      savedRaw.indexOf('配额测试岗位') >= 0 && savedRaw.indexOf('配额恢复后岗位') >= 0,
      'len=' + savedRaw.length);

    localStorage.setItem = realSet;
    // 清理：把这两条测试岗位删掉，别污染后面的用例
    Store.jobs().filter(j => j.title === '配额测试岗位' || j.title === '配额恢复后岗位')
      .forEach(j => Store.removeJob(j.id));
    await sleep(320);
    eq('清理后岗位数回到原值', Store.jobs().length, keepJobs);
    clearToasts();
  }

  /* --- 18.8Q schema 一致性：导出层产出的**每一个**键，都必须能穿过「写库」活下来 ---
     为什么专门加这一条（评审 2.1 + 第六节那个元问题）：
     「字段白名单忘了加」这个坑已经踩了三次 ——
       ① `reqAuthoritative` 键名不一致  ② `greetAt` / `encryptJobId`  ③ `reqSkillsAuthoritative`
     靠纪律收不住了。所以做成**结构性防护**：
     断言由「导出层自己产出的键」驱动 —— 以后再加字段，**自动进覆盖范围**，不用人记得来补测试。

     ⛔ 与旧用例的关键区别：必须真的走 `Store.addJob`（入库 + 二次导入合并**两条**路），
        不能像原来那样只断言 `Exporter.fromCrawlerRecord()` 的**返回值** ——
        那是「测了导出层、断的是入库层」，全绿也没有意义（实测确认过）。 */
  {
    const unwrapJ = r => (r && r.job) ? r.job : r;
    const BOSS_U = 'https://www.zhipin.com/job_detail/schema000000001.html';

    /* 用**所有别名**喂一条「最大记录」：这样导出层会把它支持的所有键都吐出来。
       ⚠️ 这些值同时也是"活不活得下来"的判据，所以必须**互不相同**且非空。 */
    const maximal = {
      '岗位': 'Schema 一致性测试岗', '公司': 'Schema 公司', '领域': '互联网',
      '城市': '杭州', '薪资': '8-13K·14薪', '学历': '本科', '经验': '3-5年',
      '技能标签': '抖音,剪映', '福利标签': '五险一金,双休',
      '岗位要求和职责': '【岗位职责】\n负责内容策划与投放\n【任职要求】\n三年以上经验',
      'link': BOSS_U, '公司规模': '100-499人', 'HR姓名': '张女士', 'HR职位': 'HRBP',
      'HR在线': '是', 'HR活跃度': '今日活跃', '区域': '滨江区', '商圈': '长河',
      '位置': "{'longitude': 120.17466, 'latitude': 30.18683}",
      '详细地址': '杭州市滨江区长河路 1 号', '公司信息': '一家做内容的公司',
      '已失效': '否', '代招': '否',
      /* 权威技能要求要**能命中用户画像关键词**才会加分（打分逻辑是
         「技能文本里包含某个画像关键词」→ 计 1 次命中）。所以这里刻意用
         「抖音运营 / 短视频剪辑」这种含默认画像词（抖音 / 短视频）的写法，
         否则拿不到命中，④ 那条端到端断言就会假失败。 */
      '_reqAuthoritative': { '学历要求': '本科', '经验要求': '3-5年', '技能要求': ['抖音运营', '短视频剪辑'] },
    };
    const rec = Exporter.fromCrawlerRecord(maximal);
    ok('最大记录能被导出层解析出来（后面断言的前提）', !!rec,
      rec ? '' : 'fromCrawlerRecord 返回了 null');
    const recKeys = rec ? Object.keys(rec) : [];
    ok('导出层产出的键足够多（说明别名都喂到了）', recKeys.length >= 25, String(recKeys.length));

    /* ---- ① 入库这一条路：键不能丢 ---- */
    const first = unwrapJ(Store.addJob(rec));
    const lostOnInsert = recKeys.filter(k => !(k in first));
    eq('⛔ schema 一致性：导出层产出的键**一个都不能**在入库时被白名单吃掉',
      lostOnInsert.join(', '), '');

    /* ---- ② 不只是"键在"，值也要活下来 ---- */
    const lostValue = [];
    recKeys.forEach(function (k) {
      const v = rec[k];
      if (v === '' || v === null || v === undefined) return;      // 空值不参与（没得比）
      if (Array.isArray(v)) {
        if (!(first[k] || []).length) lostValue.push(k + '(数组空了)');
        return;
      }
      if (typeof v === 'object') {
        if (!first[k]) lostValue.push(k + '(对象没了)');
        return;
      }
      if (first[k] !== v) lostValue.push(k + '(' + JSON.stringify(first[k]) + '≠' + JSON.stringify(v) + ')');
    });
    eq('⛔ 非空字段的**值**也都活下来了（不是只有键在）', lostValue.join(' | '), '');

    /* ---- ③ 二次导入这一条路：走 mergeJobInto，空字段必须被回填 ----
       「二次采集同一批岗位」是最常见的路径，而它走的是**另一张白名单**。
       构造：先建一条只有链接的"空壳岗位"，再把完整记录导入一次 → 应该全部补上。 */
    const bareUrl = 'https://www.zhipin.com/job_detail/schema000000002.html';
    const bare = unwrapJ(Store.addJob({ title: '空壳岗', company: 'Schema 公司', url: bareUrl, source: 'boss' }));
    const full2 = Object.assign({}, rec, { url: bareUrl });
    const again = unwrapJ(Store.addJob(full2));
    eq('二次导入命中的是同一个岗位（走的是合并路径，不是新建）', again.id, bare.id);
    const notMerged = [];
    Object.keys(full2).forEach(function (k) {
      const v = full2[k];
      if (v === '' || v === null || v === undefined) return;
      // ⚠️ 布尔要单独判：`false` 是**合法值**，不是"没回填"。
      //    上一版把 false 当空值处理 → 报 invalid/proxyHire 没回填（假失败）。
      if (typeof v === 'boolean') { if (again[k] !== v) notMerged.push(k); return; }
      if (Array.isArray(v)) { if (!(again[k] || []).length) notMerged.push(k); return; }
      if (typeof v === 'object') { if (!again[k]) notMerged.push(k); return; }
      if (!again[k]) notMerged.push(k);
    });
    eq('⛔ 二次导入能回填的字段一个都不能少（mergeJobInto 那张白名单）',
      notMerged.join(', '), '');

    /* ---- ④ 最要紧的那个字段：reqSkillsAuthoritative 必须真的到得了 job-score ----
       它曾经是「功能整条是死的」：导出写 → 入库丢 → 打分永远读不到。
       这里断言**端到端**：库里读得到，而且打分真的会用它。
       ⚠️ 用 `JobScorer.score` 而不是 `Views.jobs.fitOf` —— 后者带 FITMAP 缓存，
          改完库里数据再调它会拿到旧值，断言就成了假失败。 */
    ok('⛔ reqSkillsAuthoritative 入库后还在（导出→入库这条链是通的）',
      Array.isArray(first.reqSkillsAuthoritative) && first.reqSkillsAuthoritative.length === 2,
      JSON.stringify(first.reqSkillsAuthoritative));

    const withAuth = sandbox.JobScorer.score(Store.job(first.id));
    Store.updateJob(first.id, { reqSkillsAuthoritative: [] });
    const noAuth = sandbox.JobScorer.score(Store.job(first.id));
    ok('⛔ 权威技能要求真的参与了打分（把它清空 → 合适度结果必须跟着变）',
      JSON.stringify(withAuth) !== JSON.stringify(noAuth),
      '带上=' + JSON.stringify(withAuth).slice(0, 80) + ' 清空=' + JSON.stringify(noAuth).slice(0, 80));

    // 清理
    Store.removeJob(first.id); Store.removeJob(bare.id);
    await tick();
  }

  /* --- 18.8R 老数据迁移：default 已有数据时必须**合并**，不能删（评审 2.4）---
     旧实现是 `if (没有 default) { 拷贝 } ; removeItem(老 key)` —— 删除是**无条件**的。
     于是只要 default 已经有数据（先点过新版 / 手动操作过），老单 key 里的岗位就被
     **直接删掉**而不是合并进来：用户看到"我的岗位没了"，没有报错、没有提示。 */
  {
    const ROOT = 'jobhunter.db.v1';
    const DEF = ROOT + '.default';
    const savedDef = localStorageMap.get(DEF);
    const savedRoot = localStorageMap.get(ROOT);

    // 造两份**互不相同**的数据：default 里是"新岗位"，老 key 里是"老岗位"
    const mkDb = (jobTitle, jobId) => JSON.stringify({
      schema: 1, createdAt: 1, updatedAt: 1, settings: {},
      jobs: [{ id: jobId, title: jobTitle, company: 'X 公司', createdAt: 1, updatedAt: 1 }],
      applications: [], interviews: [], resumes: [], materials: [], chats: [], checks: [],
    });
    localStorageMap.set(DEF, mkDb('新岗位', 'job_new1'));
    localStorageMap.set(ROOT, mkDb('老岗位', 'job_old1'));

    const merged = Store.mergeRootIntoDefault(localStorageMap.get(ROOT), localStorageMap.get(DEF));
    const parsed = JSON.parse(merged.json);
    eq('⛔ 合并后两条岗位都在（老数据没被删）',
      parsed.jobs.map(j => j.title).sort().join(','), '新岗位,老岗位');
    ok('并且报告了补进来几条', merged.added === 1, String(merged.added));

    // 同 id 时以 default 现有数据为准（不重复、不覆盖）
    const sameId = Store.mergeRootIntoDefault(mkDb('改了名的老岗位', 'job_new1'), mkDb('新岗位', 'job_new1'));
    const p2 = JSON.parse(sameId.json);
    eq('同 id 不重复', p2.jobs.length, 1);
    eq('保的是 default 那份（不覆盖现有数据）', p2.jobs[0].title, '新岗位');

    // 还原
    if (savedDef === undefined) localStorageMap.delete(DEF); else localStorageMap.set(DEF, savedDef);
    if (savedRoot === undefined) localStorageMap.delete(ROOT); else localStorageMap.set(ROOT, savedRoot);

    // 源码层：删老 key 不能是"无条件"的（必须在合并之后）+ 迁移要有记录
    const storeSrc = fs.readFileSync(path.join(DIR, 'js/store.js'), 'utf8');
    const initSrc = storeSrc.slice(storeSrc.indexOf('function init()'),
      storeSrc.indexOf('CURRENT_ACCOUNT = currentAccount();'));
    ok('⛔ 迁移里「删老 key」前面有合并分支（不是无脑删）',
      /mergeRootIntoDefault\(/.test(initSrc), '没走合并');
    ok('⛔ 合并失败时**保留**老数据不删（宁可留着也不能丢）',
      /已保留原数据未删除/.test(initSrc));
    ok('迁移过程有记录（以前静默到"岗位被删了都没人知道"）',
      /noteMigrate\(/.test(initSrc) && /get migrateNotes\(\)/.test(storeSrc));
  }

  /* --- 18.8S AI 重新解析不能清空用户手打的字段（评审 2.5）---
     以前 fromParsed 把没返回的字段写成 undefined，而 updateJob 是
     `Object.assign({}, j, patch)` → undefined 覆盖旧值 → 手打的标签/公司名/薪资/福利
     在点「AI 重新解析」之后凭空消失，且没有任何提示。 */
  {
    const unwrapP = r => (r && r.job) ? r.job : r;
    const jp = unwrapP(Store.addJob({
      title: '手打岗位', company: '我手打的公司', source: 'manual',
      salaryText: '15-20K', benefits: ['五险一金', '双休'], tags: ['重点跟进'],
      note: '和 HR 聊过，等消息', reqSkills: ['剪映'],
    }));
    // 模拟"模型只返回了标题和公司，别的什么都没给"
    Store.updateJob(jp.id, Views.jobs._fromParsed({ title: 'AI 解析出来的标题', company: 'AI 给的公司' }));
    const afterP = Store.job(jp.id);
    eq('模型返回的字段被写进去了（新值生效）', afterP.title, 'AI 解析出来的标题');
    eq('⛔ 模型没返回的手打字段**不能**被清掉：薪资', afterP.salaryText, '15-20K');
    eq('⛔ 手打的福利不能清掉', (afterP.benefits || []).join('/'), '五险一金/双休');
    eq('⛔ 手打的标签不能清掉', (afterP.tags || []).join('/'), '重点跟进');
    eq('⛔ 手打的笔记不能清掉', afterP.note, '和 HR 聊过，等消息');
    eq('⛔ 手打的技能不能清掉', (afterP.reqSkills || []).join('/'), '剪映');

    // 模型**确实返回**了某个数组 → 那种情况照常写入（不是"永远不覆盖"的另一个极端）
    Store.updateJob(jp.id, Views.jobs._fromParsed({ title: 'T2', benefits: ['年终奖'] }));
    eq('模型真返回了数组时照常写入（不是"什么都不覆盖"的另一个极端）',
      (Store.job(jp.id).benefits || []).join('/'), '年终奖');

    // 根因就在这条：补丁里不允许有 undefined 的键
    const p3 = Views.jobs._fromParsed({ title: '只有标题' });
    eq('⛔ 补丁里不允许出现 undefined 的键（这就是覆盖旧值的根因）',
      Object.keys(p3).filter(k => p3[k] === undefined).join(','), '');

    Store.removeJob(jp.id);
    await tick();
  }

  /* --- 18.9 设置页：文案与行为一致 --- */
  {
    App.go('settings');
    await tick();
    const txt = viewText();
    ok('偏好卡文案不再写「筛选默认值」（行为已经真的接上了）',
      txt.indexOf('筛选默认值') < 0, txt.slice(0, 200));
    ok('⛔ 设置页连指路牌都没有了（第 23 轮整卡删除）—— 偏好只此一处，在岗位库',
      txt.indexOf('已移到岗位库') < 0 && txt.indexOf('求职方向关键词') < 0, txt.slice(0, 200));

    /* ---- 18.9b 设置页整卡折叠（第 23 轮） ----
       ⛔ 这一段在桩里只能验**行为**（class / 落盘 / 摘要 / 能来回切）；
          「CSS 真的把 .body 藏住了」桩里验不了（直接子选择器 + DOM 层级），
          那一条交给 _测试_真机.py【18】读 getComputedStyle。 */
    try { localStorage.removeItem(Views.settings._foldKey); } catch (e) { /* 隐私模式 */ }
    App.go('settings');
    await tick();

    const setCards = U.$$('#view .card');
    const foldHeads = U.$$('#view header.foldhead');
    ok('⛔ 设置页**每一张**卡都可折叠（没有漏网的，数量跟着卡片数走而不是写死）',
      setCards.length > 0 && foldHeads.length === setCards.length,
      'foldhead=' + foldHeads.length + ' / 卡=' + setCards.length);
    ok('默认：第一张卡是展开的（新用户第一件要填的事，不该被藏起来）',
      !setCards[0].classList.contains('collapsed'));
    ok('默认：其余卡是收起的（设置页不再一屏拉到底）',
      setCards.slice(1).every(c => c.classList.contains('collapsed')),
      setCards.map(c => c.classList.contains('collapsed') ? '收' : '展').join(''));

    const psumOf = c => {
      const kids = c.children || [];
      for (let i = 0; i < kids.length; i++) {
        const h = kids[i];
        if (String(h.tagName || '').toUpperCase() !== 'HEADER') continue;
        const ps = U.$$('span.psum', h);
        return ps.length ? (ps[0].textContent || '') : null;
      }
      return null;
    };
    /* ⛔ 收起时必须留摘要 —— 否则"这一块"等于从页面上消失了（第 22 轮的教训） */
    ok('收起时每张卡都留了一行摘要（不是只剩一个标题）',
      setCards.slice(1).every(c => (psumOf(c) || '').trim().length >= 2),
      setCards.map(c => JSON.stringify(psumOf(c))).join(' | ').slice(0, 200));

    /* 真点一下收起的卡 → 展开；再点一下 → 收起。**必须真派发 click**，
       "有监听器" ≠ "点了会动"。 */
    const h2 = foldHeads[1];
    h2.click();
    await tick();
    ok('真点一下收起的卡 → 展开了', !setCards[1].classList.contains('collapsed'));
    ok('展开后箭头变成 ▾', ((U.$$('span.chev', h2)[0] || {}).textContent) === '▾');

    h2.click();
    await tick();
    ok('再点一下 → 又收起了', setCards[1].classList.contains('collapsed'));
    ok('收起后箭头变成 ▸', ((U.$$('span.chev', h2)[0] || {}).textContent) === '▸');

    /* 落盘：⛔ 状态不落盘 = 刷新就弹回来 = 等于没折 */
    const foldMap = Views.settings._readFolds();
    ok('⛔ 折叠状态落盘了（收起 = 0）', foldMap['自动触达 BOSS'] === 0,
      JSON.stringify(foldMap));

    /* 重画一次（≈刷新）：状态必须保持 —— 这才叫真的落盘，而不是只活在内存里 */
    App.go('settings');
    await tick();
    const setCards2 = U.$$('#view .card');
    ok('⛔ 重画（≈刷新）后折叠状态保持 —— 不是只改了内存',
      setCards2[1].classList.contains('collapsed') && !setCards2[0].classList.contains('collapsed'));

    /* 摘要要是"现场算的"，不能是写死的一句：把开关打开，摘要必须跟着变。 */
    const sumBefore = psumOf(setCards2[1]) || '';
    Store.setSetting('boss.autoGreet', true);
    App.go('settings');
    await tick();
    const sumAfter = psumOf(U.$$('#view .card')[1]) || '';
    ok('⛔ 收起时的摘要是现算的（打开「一键打招呼」后摘要跟着变，不是写死一句）',
      sumBefore !== sumAfter && /1 个开关开着/.test(sumAfter),
      JSON.stringify(sumBefore) + ' → ' + JSON.stringify(sumAfter));
    Store.setSetting('boss.autoGreet', false);
    try { localStorage.removeItem(Views.settings._foldKey); } catch (e) { /* noop */ }
    App.go('settings');
    await tick();


    /* 表单搬到了岗位库 —— 那几个字段的"空态 / 单位 / 勾选"到那边去验。
       这一段真正要守的是：设置页**不再维护第二份表单**。 */
    App.go('jobs');
    await tick();
    Views.jobs.openPrefs();
    await tick();
    const jtxt = viewText();
    ok('岗位库：偏好面板里标了单位「薪资底线（K）」', jtxt.indexOf('薪资底线（K）') >= 0);
    /* 空态写「未设置」—— placeholder 就是用户在空格子里看到的那行字，
       所以这里查属性而不是查 textContent（textContent 读不到 placeholder）。 */
    const salInput = U.$$('#view input[type=number]').filter(inp => {
      const fld = inp.parentNode;
      return fld && (fld.textContent || '').indexOf('薪资底线') >= 0;
    })[0];
    ok('岗位库：找得到薪资底线的输入框', !!salInput,
      U.$$('#view input[type=number]').map(i => i.parentNode && i.parentNode.textContent).join(' | '));
    ok('岗位库：薪资底线的空态写「未设置」而不是留个空框',
      salInput && (salInput.getAttribute('placeholder') || '').indexOf('未设置') >= 0,
      salInput && salInput.getAttribute('placeholder'));
    ok('岗位库：写明「留空 = 不按薪资筛」（空着到底算什么意思要直说）',
      jtxt.indexOf('留空') >= 0, jtxt.slice(jtxt.indexOf('薪资底线'), jtxt.indexOf('薪资底线') + 200));

    const autoLab = () => U.$$('#view input[type=checkbox]').filter(c => {
      const lab = c.parentNode;
      return lab && (lab.textContent || '').indexOf('默认应用') >= 0;
    })[0];
    ok('岗位库：有「进入岗位库时默认应用这些偏好」的勾选', !!autoLab());

    const cbAuto = autoLab();
    cbAuto.checked = true;
    cbAuto.dispatchEvent({ type: 'change', target: cbAuto, stopPropagation() { }, preventDefault() { } });
    await tick();
    ok('勾上「默认应用」→ 落盘成 true', Store.settings().prefs.autoApply === true);
    cbAuto.checked = false;
    cbAuto.dispatchEvent({ type: 'change', target: cbAuto, stopPropagation() { }, preventDefault() { } });
    await tick();
    ok('取消勾选 → 落盘成 false', Store.settings().prefs.autoApply === false);
    F.prefsOpen = false;
    clearToasts();
  }

  /* --- 18.10 版本变更提示（旧标签页跑旧代码的问题） --- */
  {
    const KEY = 'jh.appVersion';
    const saved = localStorage.getItem(KEY);

    localStorage.removeItem(KEY);
    clearToasts();
    const first = App.checkVersionChange();
    ok('第一次打开 → 不提醒（不然新用户一进来就被吓一跳）', first === false);
    eq('第一次就把当前版本记下了', localStorage.getItem(KEY), App.APP_VERSION);

    localStorage.setItem(KEY, '很久以前的版本');
    clearToasts();
    const changed = App.checkVersionChange();
    ok('版本变了 → 提醒刷新', changed === true);
    ok('提示里明确给了 Ctrl + F5', U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('Ctrl + F5') >= 0));
    eq('提醒后版本号被更新（不会每次进页面都唠叨）', localStorage.getItem(KEY), App.APP_VERSION);
    clearToasts();

    if (saved === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, saved);
  }

  /* --- 18.11 静态检查：脚本引入 / 顺序 / 新样式 --- */
  {
    ok('index.html 引入了 js/job-match.js', scriptOrder.indexOf('js/job-match.js') >= 0);
    ok('job-match.js 排在所有 view-* 之前（view 们运行时要用它）',
      indexHtml.indexOf('js/job-match.js') < indexHtml.indexOf('js/view-jobs.js'));
    ok('脚本顺序与 index.html 一致（否则同一文件里的 global.XXX 会拿不到）',
      scriptOrder.indexOf('js/components.js') < scriptOrder.indexOf('js/job-match.js'));

    /* 本轮新增的类名必须在样式表里有定义，否则是"裸元素" */
    const css = fs.readFileSync(path.join(DIR, 'css', 'app.css'), 'utf8');
    ['qchips', 'qchip', 'qchip-n', 'nlhint', 'nl-clear', 'pbar', 'pfill'].forEach(c => {
      ok('样式表定义了 .' + c, css.indexOf('.' + c) >= 0);
    });

    /* 主题适配：预设筛选条 / chip 选中态都得用主题变量，不能写死颜色 */
    ok('chip 选中态用的是品牌色变量（深浅主题都对）', /\.qchip\.on\s*\{[^}]*var\(--brand\)/.test(css));
  }

  /* --- 18.12 岗位期望：BOSS 岗位分类树 → 选择器 → 采集 / 偏好 --- */
  {
    /* 数据与脚本 */
    ok('index.html 引入了 js/job-taxonomy.js', scriptOrder.indexOf('js/job-taxonomy.js') >= 0);
    ok('index.html 引入了 js/job-picker.js', scriptOrder.indexOf('js/job-picker.js') >= 0);
    ok('岗位数据排在 job-match 之前（筛选要用到）',
      indexHtml.indexOf('js/job-taxonomy.js') < indexHtml.indexOf('js/job-match.js'));

    const tax = sandbox.JOB_TAXONOMY;
    ok('JOB_TAXONOMY 已经挂到 window 上', Array.isArray(tax) && tax.length > 0);
    ok('JobPicker 已经挂到 window 上', !!(sandbox.JobPicker && typeof sandbox.JobPicker.open === 'function'));

    const st = sandbox.JobPicker.stats();
    ok('岗位树有 28 个行业', st.industries === 28, '实际 ' + st.industries);
    ok('岗位树有 1000+ 个具体岗位', st.jobs >= 1000, '实际 ' + st.jobs);
    ok('岗位树有 150+ 个职能', st.sections >= 150, '实际 ' + st.sections);
    ok('每个行业都至少有一个职能',
      tax.every(ind => (ind.subs || []).length > 0));

    /* 搜索 */
    const hitYunying = sandbox.JobPicker.search('运营');
    ok('搜「运营」能命中一批岗位', hitYunying.length >= 10, '实际 ' + hitYunying.length);
    ok('搜「运营」命中里有「新媒体运营」',
      hitYunying.some(x => x.name === '新媒体运营'),
      hitYunying.slice(0, 8).map(x => x.name).join('/'));
    ok('搜索大小写不敏感（java → Java）',
      sandbox.JobPicker.search('java').some(x => /^java$/i.test(x.name)));
    ok('搜不到时返回空数组，不报错',
      sandbox.JobPicker.search('这个岗位根本不存在xyz').length === 0);
    ok('空关键词返回空数组',
      sandbox.JobPicker.search('').length === 0 && sandbox.JobPicker.search(null).length === 0);
    ok('搜索结果带路径（知道它在哪个行业 / 职能下）',
      (sandbox.JobPicker.pathOf('新媒体运营') || '').indexOf('运营') >= 0,
      sandbox.JobPicker.pathOf('新媒体运营'));
    ok('isKnown 认得出树里的岗位', sandbox.JobPicker.isKnown('产品经理') === true);
    ok('isKnown 不认树外的词', sandbox.JobPicker.isKnown('我瞎编的岗位123') === false);

    /* 偏好筛选接上了「期望岗位」 */
    const J = sandbox.JobMatch;
    ok('未设期望岗位时任何岗位都放行', J.jobHit({ title: '随便什么' }, []) === true);
    ok('岗位名命中期望岗位', J.jobHit({ title: '新媒体运营专员' }, ['新媒体运营']) === true);
    ok('岗位名不命中期望岗位', J.jobHit({ title: 'Java 开发' }, ['新媒体运营']) === false);
    ok('岗位名为空时保留（不能因为没标题就丢掉）',
      J.jobHit({ title: '' }, ['新媒体运营']) === true);
    ok('期望岗位写得更长时反向也认',
      J.jobHit({ title: '新媒体运营' }, ['新媒体运营专员']) === true);
    ok('hasPref 认得期望岗位这一项',
      J.hasPref({ cities: [], salaryMin: null, dealBreakers: [], expectJobs: ['运营'] }) === true);
    ok('describePref 会把期望岗位写进去',
      (J.describePref({ cities: [], salaryMin: null, dealBreakers: [], expectJobs: ['新媒体运营'] }) || '')
        .indexOf('新媒体运营') >= 0);
    ok('passPref 用上期望岗位（不匹配的被卡掉）',
      J.passPref({ title: 'Java 开发', location: '', salaryMin: null, salaryMax: null },
        { cities: [], salaryMin: null, dealBreakers: [], expectJobs: ['新媒体运营'] }) === false);

    /* 采集页：岗位期望 → 搜索关键词 */
    const collect = Views.collect;
    eq('岗位期望会并入采集关键词',
      collect._collectKeywords({ keywords: '运营', expectJobs: ['产品经理'] }).join(','),
      '运营,产品经理');
    ok('关键词与岗位期望重复时去重',
      collect._collectKeywords({ keywords: '运营', expectJobs: ['运营'] }).length === 1,
      JSON.stringify(collect._collectKeywords({ keywords: '运营', expectJobs: ['运营'] })));
    ok('只选岗位期望、不填关键词也能开采集',
      collect._collectKeywords({ keywords: '', expectJobs: ['新媒体运营'] }).length === 1);
    ok('关键词按逗号 / 换行 / 顿号拆开',
      collect._collectKeywords({ keywords: '运营,产品、设计\n数据' }).length === 4);
    ok('什么都没有时返回空数组（好让 doCrawl 提示必填）',
      collect._collectKeywords({}).length === 0);

    /* 入口在**岗位库的偏好面板**里（原来在设置页，本轮搬过去了） */
    App.go('jobs');
    await tick();
    Views.jobs.openPrefs();
    await tick();
    const stxt = viewText();
    ok('岗位库偏好面板有「期望岗位」区块', stxt.indexOf('期望岗位') >= 0, stxt.slice(0, 160));
    /* 第 21 轮：两处的选岗位按钮原来都叫「➕ 选择岗位」，用户点进去分不清在改哪一份。
       现在必须**各叫各的**，而且都不许再出现那个含糊的旧文案。 */
    ok('岗位库偏好面板的选岗位按钮叫「🎯 长期期望岗位」',
      U.$$('#view button').some(b => (b.textContent || '').indexOf('长期期望岗位') >= 0));
    ok('⛔ 偏好面板里不再有含糊的「选择岗位」（那是采集页和偏好共用同一句文案的老问题）',
      U.$$('#view button').every(b => (b.textContent || '').indexOf('选择岗位') < 0));
    ok('面板说明了期望岗位会用在偏好筛选上',
      stxt.indexOf('按我的偏好筛选') >= 0 || stxt.indexOf('偏好筛选') >= 0);
    /* ⛔ 第 23 轮：设置页那张「② 求职偏好」整卡已删（含里面的「期望岗位」）。
       这条守的不变量没变——**设置页不得出现第二份表单**——只是不再有"指路牌"这回事。 */
    ok('设置页不再有第二份「期望岗位」表单（那张整卡已删，入口只在岗位库）',
      inspectPage('settings').txt.indexOf('期望岗位') < 0);
    F.prefsOpen = false;
    clearToasts();

    /* 选择器弹窗：能打开、带入已选、能关掉 */
    let mApi = null;
    try {
      mApi = sandbox.JobPicker.open({ title: '测试选择器', selected: ['产品经理', 'Java'] });
      ok('岗位选择器能打开（不抛异常）', !!(mApi && typeof mApi.close === 'function'));
    } catch (e) {
      ok('岗位选择器能打开（不抛异常）', false, e && e.message);
    }
    await tick();
    ok('选择器带入了已选中的岗位',
      mApi && mApi.picked().join(',') === '产品经理,Java',
      mApi && mApi.picked().join(','));
    if (mApi) mApi.close();
    await tick();

    /* 落盘 / 读取这条链 */
    Store.setSetting('prefs.expectJobs', ['新媒体运营', '产品经理']);
    ok('期望岗位能落盘并被 prefs() 读到',
      J.prefs().expectJobs.join(',') === '新媒体运营,产品经理',
      JSON.stringify(J.prefs().expectJobs));
    Store.setSetting('prefs.expectJobs', []);   // 还原

    /* 采集页有入口 —— 参数卡只在「已连接」时才长出来，喂个假服务 */
    const stubJobPick = (url) => {
      const path = String(url).replace(/^https?:\/\/[^/]+/, '');
      let body = { ok: false, error: 'no stub: ' + path };
      if (path.indexOf('/api/ping') === 0) body = fakePing;
      else if (path.indexOf('/api/jobs') === 0) body = { ok: true, source: '（测试）', jobs: [], total: 0 };
      else if (path.indexOf('/api/task') === 0) body = { ok: true, task: null };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    await withFetch(stubJobPick, () => {
      App.go('collect');
      return tick().then(tick).then(tick).then(tick).then(tick).then(tick);
    });
    const ctxt = viewText();
    ok('采集页有「岗位期望」区块', ctxt.indexOf('岗位期望') >= 0, ctxt.slice(0, 160));
    ok('采集页的选岗位按钮叫「🔍 本次要搜的岗位」',
      U.$$('#view button').some(b => (b.textContent || '').indexOf('本次要搜的岗位') >= 0));
    ok('⛔ 采集页里不再有含糊的「选择岗位」',
      U.$$('#view button').every(b => (b.textContent || '').indexOf('选择岗位') < 0));
    ok('采集页空态提示了去哪里选岗位',
      ctxt.indexOf('还没选') >= 0 || ctxt.indexOf('1098') >= 0);
    ok('采集页说明了岗位期望会并入搜索词',
      ctxt.indexOf('搜索词') >= 0 || ctxt.indexOf('一起采集') >= 0);
    ok('采集页没渲染成报错页', ctxt.indexOf('这个页面渲染出了错') < 0);
    clearToasts();

    /* ==================================================================
       【21】采集条件 ⇄ 求职偏好：两套数据必须**互不影响**
       —— 回归本轮修掉的两个实锤 bug（见 _诊断_采集条件与求职偏好混乱_2026-10-06.md）
          ① 「采集页的区/商圈默认继承偏好」一直是**假的**：读的是服务端
             current_params() 根本不回吐的 districts/bizAreas 两个键
          ② 采集页的区/商圈两条兜底路径都没有 → 改了不跑采集就刷新 = 白选

       ⛔ 这里断言一律走**行为**（造数据 → 跑真函数 → 查结果）。
          不写「源码里出现过某个字符串」那种 —— 它会被 `if False and <原条件>` 骗过，
          而且别处有同样文本就照样满足。
       ================================================================== */
    {
      const CP = sandbox.CollectPrefs;
      const S2 = collect._state;
      const FKEY = collect._formSaveKey;

      ok('collect-prefs.js 挂到 window 上了（两边共用的唯一换算表）',
        !!CP && typeof CP.planFromPrefs === 'function' && typeof CP.planToPrefs === 'function');
      ok('index.html 引入了 js/collect-prefs.js',
        scriptOrder.indexOf('js/collect-prefs.js') >= 0);

      /* ---------- ① geoSeedFor：区/商圈初值，四种来源分别钉住 ---------- */
      const P1 = { cities: ['杭州'], districts: ['滨江区'], bizAreas: ['长河'] };
      const s1 = collect._geoSeedFor({}, '杭州', P1);
      eq('⛔ 修好的「继承」：没存过 + 城市对得上 → 区来自偏好', s1.district, ['滨江区']);
      eq('商圈同样继承过来', s1.bizArea, ['长河']);
      eq('来源标注为 prefs', s1.src, 'prefs');

      // ⛔ 反向断言：偏好里没有 → 必须是空数组（防止把默认值写死成"总有区"）
      eq('偏好也没填 → 区必须为空（反向断言，防写死）',
        collect._geoSeedFor({}, '杭州', { cities: ['杭州'] }).district, []);
      eq('偏好也没填 → 商圈必须为空（反向断言）',
        collect._geoSeedFor({}, '杭州', { cities: ['杭州'] }).bizArea, []);

      eq('城市对不上就不继承（否则采集后精筛必成空列表）',
        collect._geoSeedFor({}, '上海', { cities: ['杭州'], districts: ['滨江区'] }).district, []);
      eq('城市对不上时来源标记为 city-mismatch',
        collect._geoSeedFor({}, '上海', { cities: ['杭州'], districts: ['滨江区'] }).src, 'city-mismatch');
      eq('城市为空 → 不判"对不上"，照常继承',
        collect._geoSeedFor({}, '', { cities: ['杭州'], districts: ['滨江区'] }).district, ['滨江区']);
      eq('存过（非空）→ 以存的为准，不看偏好',
        collect._geoSeedFor({ district: ['西湖区'] }, '杭州', P1).district, ['西湖区']);
      eq('存过空数组 → 尊重"用户清空了"，不许从偏好长回来',
        collect._geoSeedFor({ district: [], bizArea: [] }, '杭州', P1).district, []);

      /* ---------- ② 落盘清单：区/商圈真的在里面 ---------- */
      ok('落盘清单含 district', collect._formSaveFields.indexOf('district') >= 0);
      ok('落盘清单含 bizArea', collect._formSaveFields.indexOf('bizArea') >= 0);

      /* ---------- ③ 真渲染一遍：偏好里的区要出现在表单上 ---------- */
      // 记下原值，测完还原，别污染后面的用例
      const keep = {
        cities: J.prefs().cities, districts: J.prefs().districts,
        bizAreas: J.prefs().bizAreas, salaryMin: J.prefs().salaryMin,
      };
      localStorage.removeItem(FKEY);
      S2.form = null;              // 强制重新初始化表单
      S2.geoOwned = false;
      Store.setSetting('prefs.cities', ['杭州']);
      Store.setSetting('prefs.districts', ['滨江区']);
      Store.setSetting('prefs.bizAreas', ['长河']);

      await withFetch(stubJobPick, () => {
        App.go('jobs');
        return tick().then(tick).then(() => {
          App.go('collect');
          return tick().then(tick).then(tick).then(tick).then(tick).then(tick);
        });
      });
      ok('表单真的重建了（否则下面两条断言测的是旧对象）', !!(S2.form && S2.form.district));
      eq('⛔ 修好的「继承」在真渲染里也成立：表单上出现偏好里的区',
        S2.form.district, ['滨江区']);
      eq('表单上也出现偏好里的商圈', S2.form.bizArea, ['长河']);
      ok('⛔ 渲染时不许写 localStorage（否则"改偏好 + 打开页面"就把继承值固化了）',
        localStorage.getItem(FKEY) === null, String(localStorage.getItem(FKEY)));

      /* ---------- ④ 用户真改区 → 才落盘 ---------- */
      S2.form.district = ['西湖区'];
      S2.geoOwned = true;
      collect._saveForm();
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(FKEY) || 'null'); } catch (e) { saved = null; }
      ok('用户改过的区落盘了', !!saved && JSON.stringify(saved.district) === JSON.stringify(['西湖区']),
        JSON.stringify(saved));
      ok('落盘里同时有 bizArea 键（别再漏）', !!saved && ('bizArea' in saved));

      /* ---------- ⑤ 互不影响：双向都断言 ---------- */
      const formBlob = localStorage.getItem(FKEY);
      Store.setSetting('prefs.districts', ['上城区']);
      ok('⛔ 改「求职偏好」不许写采集侧的 jh.collectForm',
        localStorage.getItem(FKEY) === formBlob, String(localStorage.getItem(FKEY)));

      const prefsBlob = JSON.stringify(J.prefs());
      S2.form.district = ['拱墅区'];
      collect._saveForm();
      ok('⛔ 采集侧落盘不许改「求职偏好」', JSON.stringify(J.prefs()) === prefsBlob);

      /* ---------- ⑥ 差异计划：只搬源里非空的项 ---------- */
      const opt = { bandCovering: collect._bandCovering, salaryBand: collect._salaryBand };
      const pf = CP.planFromPrefs(
        { city: '上海', expectJobs: [], salary: '', welfare: [], district: [], bizArea: [] },
        { cities: ['杭州'], expectJobs: ['新媒体运营'], salaryMin: 12,
          welfare: ['带薪年假'], districts: ['滨江区'], bizAreas: [] }, opt);
      ok('薪资换算对了：偏好写 12K → 采集档位 10-20K',
        pf.patch.salary === '10-20K', JSON.stringify(pf.patch));
      ok('城市按"逗号分隔字符串"写回（采集页就是存字符串的）',
        pf.patch.city === '杭州', String(pf.patch.city));
      eq('期望岗位整份搬过来', pf.patch.expectJobs, ['新媒体运营']);
      eq('区也搬过来', pf.patch.district, ['滨江区']);
      ok('⛔ 源里为空的项（商圈）不进 patch —— 否则"带入"会把采集页清空',
        !('bizArea' in pf.patch), JSON.stringify(Object.keys(pf.patch)));
      ok('差异清单只列会变的项（这里 5 项：城市/岗位/薪资/福利/区）',
        pf.steps.length === 5, pf.steps.map(s => s.key).join(','));

      const pt = CP.planToPrefs(
        { city: '杭州', expectJobs: ['直播运营'], salary: '10-20K', welfare: [], district: [], bizArea: [] },
        { cities: [], expectJobs: [], salaryMin: null, welfare: [], districts: [], bizAreas: [] }, opt);
      ok('反方向：采集档位 10-20K → 偏好薪资底线 10K',
        pt.patch.salaryMin === 10, JSON.stringify(pt.patch));
      ok('⛔ 只写 salaryMin，不碰 salaryMax（档位上限 ≠ 我能接受的最高薪资）',
        !('salaryMax' in pt.patch), JSON.stringify(Object.keys(pt.patch)));

      /* 还原（别把偏好/表单留在测试造的状态上） */
      Store.setSetting('prefs.cities', keep.cities);
      Store.setSetting('prefs.districts', keep.districts);
      Store.setSetting('prefs.bizAreas', keep.bizAreas);
      Store.setSetting('prefs.salaryMin', keep.salaryMin);
      localStorage.removeItem(FKEY);
      clearToasts();
    }

    /* ==================================================================
       【30】采集页「地点」：省 > 市 > 区 > 商圈 四级级联
       —— 改省 → 清市/区/商 + 重算城市候选；改市 → 清区/商；改区 → 只留该区的商圈；
          商圈候选**只来自当前所选区**；空数据 / geo.js 缺失 / 默认值都要有交代

       ⛔ 一律**造真实数据 + 真点 DOM + 查结果**，不写"源码里出现过某串"那种断言。
       ⛔ 选择器**收窄到「地点」那一个 .fld 内** —— 结果筛选栏和偏好面板里都有
          `.geo-chip`，不收窄就会把别处的 chip 一起数进来。
       ⛔ 状态前置必须**显式清零并断言**（表单是跨用例残留的内存态）。
       ================================================================== */
    {
      const G = sandbox.GEO;
      const VC = Views.collect;
      const St = VC._state;
      const FKEY = VC._formSaveKey;

      ok('geo.js 暴露了省份层（PROVINCES / provinceOfCity / citiesOfProvince / citiesIn / provinceChoices）',
        !!(G && Array.isArray(G.PROVINCES) && G.PROVINCES.length === 27 &&
          typeof G.provinceOfCity === 'function' && typeof G.citiesOfProvince === 'function' &&
          typeof G.citiesIn === 'function' && typeof G.provinceChoices === 'function'));

      /* ---------- ① 纯函数：省 ⇄ 市 ---------- */
      eq('省 → 城市（浙江省只有杭州 / 宁波）', G.citiesOfProvince('浙江省'), ['杭州', '宁波']);
      eq('城市 → 省（「杭州市」归一后也认）', G.provinceOfCity('杭州市'), '浙江省');
      eq('直辖市自成一级（北京 → 北京市）', G.provinceOfCity('北京'), '北京市');
      eq('⛔ 没收录的城市不瞎猜（未知 → 空省）', G.provinceOfCity('火星市'), '');

      /* ---------- ② 城市候选：不选省必须**原样退回**老口径 ---------- */
      eq('⛔ 不选省 → 城市候选与老口径完全一致（一个候选都不能少）',
        JSON.stringify(G.citiesIn([], [])) === JSON.stringify(G.cityChoices([])), true);
      eq('选了省 → 候选只剩该省的城市', G.citiesIn(['浙江省'], []), ['杭州', '宁波']);
      eq('选两个省 → 候选是并集', G.citiesIn(['浙江省', '上海市'], []), ['杭州', '宁波', '上海']);
      eq('未知省 → 候选为空（不能退回全量，否则「选了省却什么都没变」）',
        G.citiesIn(['不存在的省'], []), []);
      ok('省候选全来自内置区划（没有人手编的假省）',
        G.provinceChoices([]).every(p => G.PROVINCES.some(x => x.name === p)),
        G.provinceChoices([]).join('/'));

      /* ---------- ③ 省初值：由城市反推（默认值场景） ---------- */
      eq('省初值由城市反推（杭州 → 浙江省）', VC._deriveProvince('', '杭州'), '浙江省');
      eq('城市为空 → 保留存过的省（不替用户清空）', VC._deriveProvince('广东省', ''), '广东省');
      eq('跨省多城市 → 省表达不了，退回存过的值而不是清空',
        VC._deriveProvince('浙江省', '杭州, 上海'), '浙江省');
      /* ⛔ 上面那条**照不出**"不校验同省"的变异：跨省时真实现和"取第一个城市的省"
         恰好都得到「浙江省」（因为存的就是它）。要照出它，输入的"存过的省"必须
         和第一个城市的省**不同** —— 只有这样两条路径才会分叉。 */
      eq('⛔ 跨省多城市 → 退回存过的省，不能拿第一个城市的省顶上',
        VC._deriveProvince('广东省', '杭州, 上海'), '广东省');
      eq('⛔ 存过的省为空 + 跨省 → 只能是空（不许顺手拿第一个城市的省）',
        VC._deriveProvince('', '杭州, 上海'), '');
      eq('城市未收录 → 退回存过的值', VC._deriveProvince('广东省', '火星'), '广东省');
      eq('城市能推出省 → 省的权威是城市（存过的旧省被纠正）',
        VC._deriveProvince('广东省', '杭州'), '浙江省');

      /* ---------- ④ 真渲染 + 真点 ---------- */
      const ins = Store.addJobs([
        { source: 'boss', title: '短视频运营', company: '甲', location: '杭州·西湖区',
          district: '西湖区', bizArea: '文三路', url: 'https://www.zhipin.com/job_detail/geoA.html' },
        { source: 'boss', title: '内容运营', company: '乙', location: '杭州·滨江区',
          district: '滨江区', bizArea: '长河', url: 'https://www.zhipin.com/job_detail/geoB.html' },
        { source: 'boss', title: '产品经理', company: '丙', location: '上海·浦东新区',
          district: '浦东新区', bizArea: '陆家嘴', url: 'https://www.zhipin.com/job_detail/geoC.html' },
      ]);
      const geoIds = ins.ids.slice();
      ok('前置：三条带区/商圈的岗位真的进库了（否则下面全是空渲染）',
        Store.jobs({ includeArchived: false }).filter(j => geoIds.indexOf(j.id) >= 0).length === 3);

      const stub = (url) => {
        const p = String(url).replace(/^https?:\/\/[^/]+/, '');
        let body = { ok: false, error: 'no stub: ' + p };
        if (p.indexOf('/api/ping') === 0) body = fakePing;
        else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
        else if (p.indexOf('/api/estimate') === 0) body = { ok: false, error: 'test' };
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
      };

      await withFetch(stub, async () => {
        /* ⛔ 强制重建表单：不这样做，测的是上一个用例留下的表单对象 */
        St.form = null;
        St.geoOwned = false;
        localStorage.removeItem(FKEY);
        App.go('collect');
        await tick(); await tick(); await tick(); await tick(); await tick(); await tick();

        const f = St.form;
        ok('采集表单真的重建了（否则下面断言测的是旧对象）', !!(f && 'province' in f));
        eq('默认值：省由（偏好 / 服务端的）城市反推出来',
          f.province, VC._deriveProvince('', f.city));

        const geoFld = () => U.$$('#view .fld')
          .filter(x => (x.textContent || '').indexOf('省 > 市 > 区 > 商圈') >= 0)[0];
        ok('「地点」那一栏的标题写了四级（省 > 市 > 区 > 商圈）', !!geoFld(),
          U.$$('#view .fld').map(x => (x.textContent || '').slice(0, 16)).join(' | '));

        const rows = () => U.$$('.georow', geoFld());
        const chipsAt = (i) => U.$$('.geo-chip', rows()[i])
          .map(c => String(c.textContent).replace(/\s*✕$/, ''));
        const chipAt = (i, t) => U.$$('.geo-chip', rows()[i])
          .filter(c => String(c.textContent).replace(/\s*✕$/, '') === t)[0];
        const lblOf = (i) => (U.$('.geo-lb', rows()[i]) || {}).textContent || '';

        eq('地点这一栏渲染出 4 级', rows().length, 4);
        eq('第 1 级是省 / 自治区 / 直辖市', lblOf(0), '省 / 自治区 / 直辖市');
        eq('第 2 级是城市', lblOf(1), '城市');
        ok('第 3 级是「区（采集后精筛）」', /^区/.test(lblOf(2)), lblOf(2));
        ok('第 4 级是「商圈 / 地标（采集后精筛）」', /^商圈/.test(lblOf(3)), lblOf(3));
        ok('省那一级**没有**手输框（手写一个没城市映射的省只会让下一级变空）',
          !U.$('.geo-add', rows()[0]),
          String((U.$('.geo-add', rows()[0]) || {}).placeholder));

        /* --- 建立前置状态：城市=上海 / 区=浦东新区 / 商圈=陆家嘴 --- */
        f.province = '';
        f.city = '上海';
        f.district = ['浦东新区'];
        f.bizArea = ['陆家嘴'];
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('前置② 上海 / 浦东新区 / 陆家嘴 都渲染成选中态（否则下面的"清空"测了个寂寞）',
          chipsAt(1).indexOf('上海') >= 0 && chipsAt(2).indexOf('浦东新区') >= 0 &&
          chipsAt(3).indexOf('陆家嘴') >= 0,
          chipsAt(1).join('/') + ' ‖ ' + chipsAt(2).join('/') + ' ‖ ' + chipsAt(3).join('/'));

        /* --- A. 改省 → 清空市 / 区 / 商圈，并重算城市候选 --- */
        ok('前置③ 省那一级有「浙江省」可点', !!chipAt(0, '浙江省'), chipsAt(0).join('/'));
        chipAt(0, '浙江省').click();
        eq('改省 → 城市被清空', f.city, '');
        eq('改省 → 区被清空', f.district, []);
        eq('改省 → 商圈被清空', f.bizArea, []);
        ok('改省 → 城市候选收窄到该省（上海 chip 消失）',
          chipsAt(1).indexOf('上海') < 0, chipsAt(1).join('/'));
        ok('改省 → 城市候选里有杭州 / 宁波',
          chipsAt(1).indexOf('杭州') >= 0 && chipsAt(1).indexOf('宁波') >= 0, chipsAt(1).join('/'));
        eq('改省 → 省真的落盘了（改了不跑采集就刷新 = 白选）',
          JSON.parse(localStorage.getItem(FKEY) || '{}').province, '浙江省');
        ok('省也在预设字段里（切方案不会把它丢掉）',
          VC._presetFields.indexOf('province') >= 0, VC._presetFields.join(','));

        /* --- B. 改市 → 清区 / 商圈，并重算区候选 ---
           ⛔ 前置必须是**非空**的：A 步刚把区/商圈清空过，如果就这么点下去，
              "有没有清"和"本来就是空的"分辨不出来 —— 定向变异会证明这种断言
              是**假绿**（改坏了照样通过）。所以先显式塞上下级的值，再断言它非空。 */
        f.district = ['浦东新区'];
        f.bizArea = ['陆家嘴'];
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('前置③ 改市前区/商圈都是非空的（否则下面测不出"清空"）',
          f.district.length === 1 && f.bizArea.length === 1,
          JSON.stringify(f.district) + ' / ' + JSON.stringify(f.bizArea));

        chipAt(1, '杭州').click();
        eq('改市 → 城市记为杭州', f.city, '杭州');
        eq('改市 → 区被清空', f.district, []);
        eq('改市 → 商圈被清空', f.bizArea, []);
        ok('改市 → 区候选里有真实采到的「滨江区」·「西湖区」',
          chipsAt(2).indexOf('滨江区') >= 0 && chipsAt(2).indexOf('西湖区') >= 0, chipsAt(2).join('/'));
        ok('⛔ 改市 → 上一个城市的「浦东新区」不能留在候选里',
          chipsAt(2).indexOf('浦东新区') < 0, chipsAt(2).join('/'));

        /* --- C. 改区 → 商圈候选**只来自当前所选区** --- */
        /* ⛔ 同上：先把商圈塞成非空，才测得出"改区会清空商圈"。 */
        f.bizArea = ['陆家嘴'];
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('前置④ 改区前商圈是非空的', f.bizArea.length === 1, JSON.stringify(f.bizArea));

        chipAt(2, '滨江区').click();
        eq('改区 → 区记为滨江区', f.district, ['滨江区']);
        eq('改区 → 商圈被清空（否则会留下列表里没有的商圈，筛出来必然 0 条）', f.bizArea, []);
        ok('改区 → 商圈候选里有该区的「长河」', chipsAt(3).indexOf('长河') >= 0, chipsAt(3).join('/'));
        ok('⛔ 改区 → 别的区的商圈（文三路 / 陆家嘴）不能出现在候选里',
          chipsAt(3).indexOf('文三路') < 0 && chipsAt(3).indexOf('陆家嘴') < 0, chipsAt(3).join('/'));

        /* --- D. 选商圈 --- */
        chipAt(3, '长河').click();
        eq('商圈能选中并落到表单', f.bizArea, ['长河']);

        /* --- E. 空数据：库清干净后仍要能选（内置区划兜底 + 如实说"还没采到"）--- */
        /* ⛔ 先**取消商圈的选中**：chipsRow 会把「已选但已不在候选里」的项照样列出来
           （这是刻意的，否则用户看不见自己选过什么），留着它就永远看不到空态文案。 */
        chipAt(3, '长河').click();
        eq('再点一次商圈可以取消选中', f.bizArea, []);
        Store.removeJobs(geoIds);
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('空库：省 / 市 仍渲染（内置候选兜底，不是一片空白）',
          chipsAt(0).length > 0 && chipsAt(1).length > 0,
          chipsAt(0).length + '/' + chipsAt(1).length);
        ok('空库 + 已选杭州：区候选退回**内置行政区划**（滨江区还在）',
          chipsAt(2).indexOf('滨江区') >= 0, chipsAt(2).join('/'));
        ok('空库：商圈候选为空时给出**可照做**的说明（不是沉默的空行）',
          chipsAt(3).length === 0 && /还没采到商圈/.test((rows()[3] || {}).textContent || ''),
          '候选=' + chipsAt(3).join('/') + ' ‖ 文案=' + ((rows()[3] || {}).textContent || '').slice(0, 60));

        /* --- F. geo.js 没引上（老缓存 / 残缺部署）→ 不许把整页搞崩 --- */
        /* ⛔ 必须用 vm.runInContext 在**上下文内**摘掉 GEO。
           从外面 `delete sandbox.GEO` 是摘不掉的（已用 vm 探针验证过：
           外层的 delete 对脚本里的 window 不可见），那样这份"缺失"用例
           会在 GEO 明明还在的情况下**假绿**。 */
        vm.runInContext('window.__GEO_KEEP__ = window.GEO; window.GEO = null;', ctx);
        ok('前置：上下文里的 GEO 真的摘掉了（否则下面测的是"没缺"）',
          vm.runInContext('!window.GEO', ctx) === true,
          'window.GEO=' + vm.runInContext('String(window.GEO)', ctx));
        let crashed = '';
        try { App.refresh(); await tick(); await tick(); } catch (e) { crashed = String(e && e.message); }
        eq('geo.js 缺失时不抛异常', crashed, '');
        /* ⛔ placeholder 是走 setAttribute 写的 → 桩里要读 getAttribute（不是属性）。 */
        const phOf = (i) => String(i.getAttribute('placeholder') || '');
        ok('geo.js 缺失时「地点」栏还在，城市退回文本框（宁可难看也不能没有）',
          !!geoFld() && U.$$('input', geoFld()).some(i => phOf(i).indexOf('杭州') >= 0),
          'geoFld=' + !!geoFld() + ' ‖ 输入框=' +
            U.$$('input', geoFld() || document).map(phOf).join('|'));
        const keepForm = St.form;
        vm.runInContext('window.GEO = window.__GEO_KEEP__; delete window.__GEO_KEEP__;', ctx);
        eq('geo.js 回来后 GEO 复原（后面的用例还要用）',
          vm.runInContext('window.GEO && window.GEO.PROVINCES ? window.GEO.PROVINCES.length : 0', ctx), 27);
        App.refresh();
        await tick(); await tick();
        ok('geo.js 回来后表单对象没被换掉（还是同一份，值没丢）', St.form === keepForm);
      });

      /* ---------- 还原：别把库 / 存档留在测试造的状态上 ---------- */
      Store.removeJobs(geoIds);
      localStorage.removeItem(FKEY);
      St.form = null;
      St.geoOwned = false;
      clearToasts();
    }

    /* ==================================================================
       【31】薪资「自定义区间」（K）—— 档位透传 BOSS，细粒度只能本地精筛

       ⛔ 这一条**约束**是整个功能的地基，先把它钉死：
           BOSS 服务端的薪资筛选只有 6 个固定码（boss-crawler 的
           config.py FILTER_LABELS['salary'] = 402~407），而 resolve_filter_values()
           遇到认不出的值**只打一行警告就跳过** —— 自定义区间（如 15-25K）
           传下去 = **不带薪资条件**地采，用户会以为筛过了。
           ⇒ 所以自定义区间只能落在本地精筛；档位仍然是唯一的搜索条件。
       ⛔ 断言一律走**行为**（造数据 → 跑真函数 → 查结果 / 真渲染真输入），
          不写"源码里出现过某串"那种（会被 `if False and …` 骗过）。
       ================================================================== */
    {
      const VC = Views.collect;
      const S3 = VC._state;
      const FKEY = VC._formSaveKey;

      /* 收窄到「薪资范围」那一个 .fld —— ⛔ 页面别处也有 select / number 输入框
         （条数、关键词…），不收窄就会数错、点错。 */
      const salFld = () => U.$$('#view .fld')
        .filter(x => (x.textContent || '').indexOf('薪资范围') >= 0)[0];
      /* 那一栏的最后一段文字 = 冲突/说明提示（结构与 fld() 一致：提示在末尾） */
      const warnOf = () => {
        const f = salFld();
        if (!f) return '';
        const k = f.children;
        return String((k[k.length - 1] && k[k.length - 1].textContent) || '');
      };

      /* ---------- ① 输入解析：空 / 非法一律算「这一头没设」 ---------- */
      eq('parseK：空串 → null', VC._parseK(''), null);
      eq('parseK：null → null', VC._parseK(null), null);
      eq('parseK：undefined → null', VC._parseK(undefined), null);
      eq('parseK：0 → null（0 不能当成"我要 0K 以上"）', VC._parseK(0), null);
      eq('parseK：负数 → null', VC._parseK(-5), null);
      eq('parseK：非数字 → null', VC._parseK('abc'), null);
      eq('parseK：数字字符串 → 数字', VC._parseK('15'), 15);
      eq('parseK：数字 → 原样', VC._parseK(15), 15);

      /* ---------- ② 单条判定：区间重叠即命中；没标薪资一律保留 ---------- */
      const mk = (lo, hi) => ({ salaryMin: lo, salaryMax: hi });
      ok('⛔ 没标薪资（面议）→ 保留（不能因为"没写"就丢，否则用户以为岗位没了）',
        VC._salaryRangeHit(mk(null, null), 15, 25) === true);
      ok('岗位 8-12K vs 下限 15K → 剔（最高都够不着）',
        VC._salaryRangeHit(mk(8, 12), 15, null) === false);
      ok('岗位 10-20K vs 下限 15K → 留（有重叠）',
        VC._salaryRangeHit(mk(10, 20), 15, null) === true);
      ok('岗位 15-25K vs 下限 15K → 留（端点算命中）',
        VC._salaryRangeHit(mk(15, 25), 15, null) === true);
      ok('岗位 25-40K vs 上限 20K → 剔（最低已超过上限）',
        VC._salaryRangeHit(mk(25, 40), null, 20) === false);
      ok('岗位 8-12K vs 上限 20K → 留', VC._salaryRangeHit(mk(8, 12), null, 20) === true);
      ok('岗位 30-45K vs 区间 15~25K → 剔', VC._salaryRangeHit(mk(30, 45), 15, 25) === false);
      ok('岗位 15-25K vs 区间 15~25K → 留', VC._salaryRangeHit(mk(15, 25), 15, 25) === true);
      ok('⛔ 岗位只有一头薪资（salaryMin 空、max 20）也按 20 判 → 留',
        VC._salaryRangeHit(mk(null, 20), 15, 25) === true);
      ok('⛔ 同上但只有 max 12 vs 下限 15 → 剔',
        VC._salaryRangeHit(mk(null, 12), 15, null) === false);

      /* ---------- ③ 换算表：档位与区间要**一起**搬 ---------- */
      const CP = sandbox.CollectPrefs;
      const opt3 = { bandCovering: VC._bandCovering, salaryBand: VC._salaryBand };
      const fromPlan = CP.planFromPrefs(
        { city: '', expectJobs: [], salary: '', salaryMin: null, salaryMax: null, welfare: [], district: [], bizArea: [] },
        { cities: [], expectJobs: [], salaryMin: 15, salaryMax: 25, welfare: [], districts: [], bizAreas: [] }, opt3);
      eq('带入：档位按期望下限折算（15K → 10-20K）', fromPlan.patch.salary, '10-20K');
      eq('带入：自定义下限也搬过来', fromPlan.patch.salaryMin, 15);
      eq('带入：自定义上限也搬过来', fromPlan.patch.salaryMax, 25);
      eq('带入：薪资仍只占 1 条差异（不因为多了两个字段就变成 3 条）',
        fromPlan.steps.filter(s => s.key === 'salary').length, 1);
      /* ⛔ 档位相同、区间不同 → 仍须进差异清单，否则区间永远同步不过去 */
      const sameBandPlan = CP.planFromPrefs(
        { city: '', expectJobs: [], salary: '10-20K', salaryMin: 10, salaryMax: 20, welfare: [], district: [], bizArea: [] },
        { cities: [], expectJobs: [], salaryMin: 15, salaryMax: 25, welfare: [], districts: [], bizAreas: [] }, opt3);
      eq('⛔ 档位一样但区间不同 → 仍进清单（否则"带入"看着像没生效）',
        sameBandPlan.steps.filter(s => s.key === 'salary').length, 1);
      const sameAllPlan = CP.planFromPrefs(
        { city: '', expectJobs: [], salary: '10-20K', salaryMin: 15, salaryMax: 25, welfare: [], district: [], bizArea: [] },
        { cities: [], expectJobs: [], salaryMin: 15, salaryMax: 25, welfare: [], districts: [], bizAreas: [] }, opt3);
      eq('完全一致 → 不进清单（不做无意义的改写）',
        sameAllPlan.steps.filter(s => s.key === 'salary').length, 0);

      const toPlan = CP.planToPrefs(
        { salary: '10-20K', salaryMin: 15, salaryMax: 25, expectJobs: [], city: '' },
        { cities: [], expectJobs: [], salaryMin: null, salaryMax: null, welfare: [], districts: [], bizAreas: [] }, opt3);
      eq('存为偏好：自定义下限优先于档位折算', toPlan.patch.salaryMin, 15);
      eq('存为偏好：用户填了上限 → 也写进偏好', toPlan.patch.salaryMax, 25);
      const toPlan2 = CP.planToPrefs(
        { salary: '10-20K', expectJobs: [], city: '' },
        { cities: [], expectJobs: [], salaryMin: null, welfare: [], districts: [], bizAreas: [] }, opt3);
      eq('⛔ 只选了档位 → 退回档位下限（老行为不变）', toPlan2.patch.salaryMin, 10);
      ok('⛔ 只选了档位时**绝不**写 salaryMax（档位上限 ≠ 我能接受的最高薪资）',
        !('salaryMax' in toPlan2.patch), JSON.stringify(Object.keys(toPlan2.patch)));

      /* ---------- ④ 真渲染 + 真输入：参数卡的薪资那一栏 ---------- */
      S3.form = null;
      S3.geoOwned = false;
      localStorage.removeItem(FKEY);
      await withFetch((url) => {
        const p = String(url).replace(/^https?:\/\/[^/]+/, '');
        let body = { ok: false, error: 'no stub: ' + p };
        if (p.indexOf('/api/ping') === 0) body = fakePing;
        else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
        else if (p.indexOf('/api/estimate') === 0) body = { ok: false, error: 'test' };
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
      }, async () => {
        App.go('collect');
        await tick(); await tick(); await tick(); await tick(); await tick(); await tick();

        const f = S3.form;
        ok('薪资那一栏渲染出来了', !!salFld(), U.$$('#view .fld').map(x => (x.textContent || '').slice(0, 14)).join(' | '));
        if (!salFld()) return;

        const sel = U.$('select', salFld());
        const numInps = U.$$('input[type="number"]', salFld());
        ok('档位下拉在薪资栏里', !!sel);
        eq('自定义区间是两个数字框（下限 / 上限）', numInps.length, 2);
        ok('两个数字框都带 data-focus-key（整卡重画后焦点与光标要能还回来，否则敲一半就被打断）',
          numInps.every(i => !!i.getAttribute('data-focus-key')),
          numInps.map(i => i.getAttribute('data-focus-key')).join('/'));

        /* ⛔ 决定性差异（透传 BOSS vs 本地筛）必须是**可见文字**，不能只塞 title */
        const badges = U.$$('.lvlb', salFld()).map(b => String(b.textContent));
        eq('薪资栏有 2 个生效层级徽章（档位一个、自定义区间一个）', badges.length, 2);
        ok('档位那颗标的是「透传 BOSS」', badges.some(b => b.indexOf('透传 BOSS') >= 0), badges.join(' | '));
        ok('自定义区间那颗标的是「采集后本地筛」',
          badges.some(b => b.indexOf('采集后本地筛') >= 0), badges.join(' | '));
        ok('⛔ 两颗徽章文字**不一样**（把区间也标成"透传 BOSS"就等于骗用户）',
          badges[0] !== badges[1], badges.join(' | '));

        /* ⛔ 档位下拉里绝不能出现自定义值 —— 那证明自定义进不了搜索条件 */
        eq('⛔ 档位下拉只有「不限 + BOSS 那 6 档」，没有任何自定义值',
          U.$$('option', sel).map(o => o.getAttribute('value')),
          ['', '3K以下', '3-5K', '5-10K', '10-20K', '20-50K', '50K以上']);

        /* 真派发 input 事件填区间（不用编程改 f，要走真事件链） */
        numInps[0].value = '15';
        numInps[0].dispatchEvent({ type: 'input', target: numInps[0] });
        numInps[1].value = '25';
        numInps[1].dispatchEvent({ type: 'input', target: numInps[1] });
        eq('真输入 → 下限落到表单', f.salaryMin, 15);
        eq('真输入 → 上限落到表单', f.salaryMax, 25);

        /* ⛔ 反向：自定义值绝不能跑进 `salary`（那是唯一传给 BOSS 的字段） */
        ok('⛔ 自定义区间**没有**污染 f.salary（它只能是档位或空）',
          f.salary === '' || ['3K以下', '3-5K', '5-10K', '10-20K', '20-50K', '50K以上'].indexOf(f.salary) >= 0,
          'f.salary=' + JSON.stringify(f.salary));

        /* 落盘：否则"改了不跑采集就刷新 = 白选" */
        f.salary = '5-10K';
        VC._saveForm();
        let savedSal = {};
        try { savedSal = JSON.parse(localStorage.getItem(FKEY) || '{}'); } catch (e) { savedSal = {}; }
        eq('自定义区间落盘了（改了不跑采集也不丢）', savedSal.salaryMin, 15);
        eq('上限也落盘了', savedSal.salaryMax, 25);

        /* 冲突提示：区间伸到档位之外 → 必须当场说清"BOSS 服务端会切掉" */
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('⛔ 档位「5-10K」+ 区间 15~25K → 提示里点明"在档位外 / 服务端就切掉了"',
          /档位外/.test(warnOf()) && /服务端/.test(warnOf()),
          warnOf().slice(-120));

        /* 档位改「不限」→ 冲突消失，改成中性说明 */
        const f4 = S3.form;
        f4.salary = '';
        VC._saveForm();
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('档位改成「不限」→ 不再报"档位外"，改成中性说明',
          !/档位外/.test(warnOf()) && /本地精筛/.test(warnOf()),
          warnOf().slice(-120));

        /* 反向：下限 > 上限 → 必须报"永远筛不出" */
        const f5 = S3.form;
        f5.salaryMin = 30; f5.salaryMax = 10;
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('⛔ 下限比上限大 → 提示"永远筛不出岗位"（用户八成敲反了）',
          /永远筛不出/.test(warnOf()), warnOf().slice(-120));

        /* 两个框都清空 → 提示消失（不留一句僵尸文案） */
        const f6 = S3.form;
        f6.salaryMin = null; f6.salaryMax = null;
        App.refresh();
        await tick(); await tick(); await tick(); await tick();
        ok('区间清空后提示也清掉（不留僵尸文案）',
          !/档位外/.test(warnOf()) && !/永远筛不出/.test(warnOf()) && !/本地精筛/.test(warnOf()),
          warnOf().slice(-120));
      });

      /* ---------- ⑤ 结果页精筛：真造数据 → 真跑 _filterResults ---------- */
      const SAL_RECS = [
        { 岗位: '低薪运营', 公司: '甲', 城市: '杭州', 行业: '互联网', 薪资: '8-12K', 福利: '五险一金' },
        { 岗位: '中薪运营', 公司: '乙', 城市: '杭州', 行业: '互联网', 薪资: '15-25K', 福利: '五险一金' },
        { 岗位: '高薪运营', 公司: '丙', 城市: '杭州', 行业: '互联网', 薪资: '30-45K', 福利: '五险一金' },
        { 岗位: '面议运营', 公司: '丁', 城市: '杭州', 行业: '互联网', 福利: '五险一金' },
      ];
      const savedResult = S3.result;
      S3.result = { source: '（测试）', jobs: SAL_RECS };
      const rjobs = VC._resultJobs();
      eq('前置：4 条结果都转成标准岗位（否则下面的计数是"空对空"）', rjobs.length, 4);
      eq('前置：15-25K 真的解析成 15/25',
        [rjobs[1].salaryMin, rjobs[1].salaryMax], [15, 25]);
      eq('前置：面议那条两头都是 null',
        [rjobs[3].salaryMin, rjobs[3].salaryMax], [null, null]);

      const CFx = VC._cf;
      const cntWith = (lo, hi, band) => {
        /* ⛔ 显式清零其它筛选 —— 表单/筛选是跨用例残留的内存态，
           不清零的话"条数不对"分不清是薪资筛的还是别的条件筛的。 */
        CFx.kw = ''; CFx.job = ''; CFx.city = ''; CFx.industry = '';
        CFx.welfare = []; CFx.active = ''; CFx.scored = ''; CFx.fit = '';
        CFx.hideDrop = false; CFx.onlyNew = false; CFx.district = []; CFx.bizArea = [];
        CFx.salary = band || '';
        CFx.salaryMin = lo; CFx.salaryMax = hi;
        return VC._filterResults(rjobs).length;
      };

      eq('不设任何薪资条件 → 4 条都在（前置）', cntWith(null, null, ''), 4);
      eq('区间 15~25K → 留 15-25K + 没标薪资的那条（2 条）', cntWith(15, 25), 2);
      eq('只给下限 20K → 15-25K / 30-45K / 没标薪资（3 条）', cntWith(20, null), 3);
      eq('只给上限 20K → 8-12K / 15-25K / 没标薪资（3 条）', cntWith(null, 20), 3);
      eq('区间 50~60K（谁都够不着）→ 只剩没标薪资那条（1 条）', cntWith(50, 60), 1);
      eq('两个框都空 → 等于没设，4 条都在', cntWith(null, null, ''), 4);
      /* 档位与区间是"与"关系：打架时可能一条不剩 —— 参数卡那句提醒正是为这个场景写的 */
      eq('⛔ 档位「20-50K」+ 区间 15~25K 同时生效（与关系）→ 0 条（区间与档位打架）',
        cntWith(15, 25, '20-50K'), 0);
      eq('档位「20-50K」单独用 → 只剩 30-45K 那条（1 条）', cntWith(null, null, '20-50K'), 1);
      eq('档位「5-10K」+ 区间 8~12K → 只剩 8-12K 那条（1 条）',
        cntWith(8, 12, '5-10K'), 1);

      /* ---------- ⑥ ⛔ 真机抓到的真 bug：只设区间时「清空筛选」按钮不出现 ----------
         成因：collectHasFilter() 漏了 CF.salaryMin/salaryMax → 用户只设了自定义区间时
         它返回 false → 那一枚「✕ 清空筛选」按钮**根本渲染不出来** →
         这个条件再也关不掉（而且条数一直卡在筛后的数量）。
         这条断言就是钉住那个洞：只要漏掉，collectHasFilter 就会返回 false。 */
      VC._clearCF();
      ok('前置：清空后"有没有筛选"必须是 false（否则下面测不出东西）',
        VC._collectHasFilter() === false, String(VC._collectHasFilter()));
      VC._cf.salaryMin = 15;
      ok('⛔ 只设了**下限**也算「有筛选」（否则清空按钮不出现，用户关不掉它）',
        VC._collectHasFilter() === true, String(VC._collectHasFilter()));
      VC._cf.salaryMin = null;
      VC._cf.salaryMax = 25;
      ok('⛔ 只设了**上限**也算「有筛选」', VC._collectHasFilter() === true,
        String(VC._collectHasFilter()));
      VC._cf.salaryMin = 15; VC._cf.salaryMax = 25;
      ok('两个都设了当然也算', VC._collectHasFilter() === true);
      VC._clearCF();
      ok('⛔ 清空筛选真的能把两个区间一起清掉（能关得掉，不是单向开关）',
        VC._cf.salaryMin === null && VC._cf.salaryMax === null &&
        VC._collectHasFilter() === false,
        JSON.stringify([VC._cf.salaryMin, VC._cf.salaryMax, VC._collectHasFilter()]));
      /* ⛔ 反向：不能因为区间是 undefined 就被当成"设过了"（那会让按钮一直亮着） */
      VC._cf.salaryMin = undefined; VC._cf.salaryMax = undefined;
      ok('⛔ undefined 不算「设过了」（否则按钮会一直亮着，清不掉）',
        VC._collectHasFilter() === false, String(VC._collectHasFilter()));
      VC._clearCF();

      S3.result = savedResult;
      VC._clearCF();
      localStorage.removeItem(FKEY);
      S3.form = null;
      S3.geoOwned = false;
      clearToasts();
    }

    /* ==================================================================
       【32】外部评审报告（2026-10-07）所报问题的**修复**回归

       这一节覆盖 13 条"确实成立"的问题的修法。⛔ 断言一律走**行为**
       （真派发事件 / 真渲染 / 真调用），静态断言只用在校验"死代码是否真的没了"
       这类"缺省即正确"的事上。
       ================================================================== */
    {
      const VC = Views.collect;
      const S4 = VC._state;
      const FKEY = VC._formSaveKey;

      /* ---------- ① Ctrl+K 必须是「切换」，不是只唤起 ---------- */
      /* 直接驱动 app.js 注册在 document 上的 keydown 监听器（桩里 _listeners 是
         普通属性）。真实按键路径由 _测试_真机.py 的【21】再验一遍。 */
      const fireKey = (ev) => {
        const ls = (document._listeners && document._listeners.keydown) || [];
        ls.forEach(fn => { try { fn(Object.assign({ preventDefault() {} }, ev)); } catch (e) { /* noop */ } });
      };
      const quickEl = U.$('#quick');
      ok('前置：#quick 在页面骨架里（否则下面测不了）', !!quickEl);
      if (quickEl) {
        fireKey({ key: 'Escape' });                       // 先确保是收起态
        const hiddenAtStart = quickEl.classList.contains('hide');
        fireKey({ key: 'k', ctrlKey: true });
        const openedByFirst = !quickEl.classList.contains('hide');
        fireKey({ key: 'k', ctrlKey: true });
        const closedBySecond = quickEl.classList.contains('hide');
        ok('前置：起始是收起态', hiddenAtStart, String(hiddenAtStart));
        ok('Ctrl+K 第一次 → 唤起', openedByFirst, String(openedByFirst));
        ok('⛔ Ctrl+K 第二次 → **收起**（原来只调 quickOpen，第二次毫无反应）',
          closedBySecond, '第二次按下后还开着 = 没修好');
        fireKey({ key: 'k', ctrlKey: true });
        ok('⛔ 再按一次又能唤起（是切换，不是单向开关）',
          !quickEl.classList.contains('hide'));
      }

      /* ---------- ② #btnMenu 死代码：真的没了 ---------- */
      const idxHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
      const appJs = fs.readFileSync(path.join(DIR, 'js', 'app.js'), 'utf8');
      ok('⛔ index.html 里没有 #btnMenu 了（它是 display:none 且无 CSS 覆盖，永远不显示）',
        idxHtml.indexOf('btnMenu') < 0);
      ok('⛔ app.js 里也没有它的 onclick 了（避免给不存在的元素绑事件）',
        appJs.indexOf('btnMenu') < 0);
      ok('页面骨架仍然完整（没把 topbar 改坏）',
        idxHtml.indexOf('id="topActions"') >= 0 && idxHtml.indexOf('id="btnCollapse"') >= 0);

      /* ---------- ③ 窄屏顶栏换行：820 断点里真的有这条规则 ---------- */
      const css = fs.readFileSync(path.join(DIR, 'css', 'app.css'), 'utf8');
      const bp = css.match(/@media \(max-width:\s*820px\)\s*\{([\s\S]*?)\n\}/);
      ok('能定位到 820px 断点块', !!bp);
      if (bp) {
        ok('⛔ 820 断点里有 #topActions 的规则（原来完全没有 → 顶栏把页面撑到 668px）',
          /#topActions\s*\{[^}]*flex-wrap:\s*wrap/.test(bp[1]), bp[1].slice(0, 400));
      } else {
        ok('⛔ 820 断点里有 #topActions 的规则', false, '找不到断点块');
      }

      /* ---------- ④ 登录提示 / 按钮文案必须跟着登录态走 ---------- */
      /* ⛔ 登录态来自 /api/ping（`S4.ping.login`），而渲染时会**重新探测**一次并覆盖
         S4.ping —— 所以不能"渲染完再改 S4.ping"，必须让**桩**直接回吐想要的登录态。
         （第一版就是这么写错的：断言读到的一直是 fakePing 里的 ok 态。） */
      const renderCollectWithLogin = async (v) => {
        await withFetch((url) => {
          const p = String(url).replace(/^https?:\/\/[^/]+/, '');
          let body = { ok: false, error: 'no stub: ' + p };
          if (p.indexOf('/api/ping') === 0) {
            body = Object.assign({}, fakePing, {
              login: { value: v, checkedAt: Math.floor(Date.now() / 1000),
                       ttlSec: 21600, fresh: v === 'ok' },
            });
          } else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
          else if (p.indexOf('/api/estimate') === 0) body = { ok: false, error: 'test' };
          return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
        }, async () => {
          S4.form = null;
          App.go('collect');
          await tick(); await tick(); await tick(); await tick(); await tick(); await tick();
        });
      };
      const hintTxt = () => {
        const h = U.$('#cLoginHint');
        return h ? String(h.textContent) : '';
      };
      const loginBtnTxt = () => U.$$('#view button')
        .filter(b => /登录/.test(String(b.textContent)))
        .map(b => String(b.textContent))[0] || '';

      await renderCollectWithLogin('needed');
      ok('前置：桩回吐的登录态确实是"未登录"（否则下面测的是另一条分支）',
        String((S4.ping || {}).login && S4.ping.login.value) === 'needed',
        JSON.stringify((S4.ping || {}).login));
      ok('未登录：提示让用户去点「登录 BOSS」那颗按钮',
        /首次用请先点/.test(hintTxt()) && /登录 BOSS/.test(hintTxt()), hintTxt());
      ok('未登录：那颗按钮就叫「① 登录 BOSS」（提示与按钮对得上）',
        /① 登录 BOSS/.test(loginBtnTxt()), loginBtnTxt());

      /* 已登录态 —— 这里是原 bug：提示写死让他去找一个不存在的按钮 */
      await renderCollectWithLogin('ok');
      ok('前置：桩回吐的登录态是"已登录"', String((S4.ping || {}).login.value) === 'ok',
        JSON.stringify((S4.ping || {}).login));
      ok('⛔ 已登录：按钮改名为「重新登录（扫码）」—— 说的是它真做的事（会开浏览器）',
        /重新登录/.test(loginBtnTxt()) && /扫码/.test(loginBtnTxt()), loginBtnTxt());
      ok('⛔ 已登录：提示**不再**让用户去找「登录 BOSS」那颗不存在的按钮',
        hintTxt().indexOf('首次用请先点') < 0, hintTxt());
      ok('已登录：提示改说"已登录 / 换账号重新扫码"',
        /已登录/.test(hintTxt()), hintTxt());

      /* ---------- ⑤ 200 / 50 两个数：同一来源 + 讲清关系 ---------- */
      const srv = fs.readFileSync(path.join(DIR, '采集器', 'server.py'), 'utf8');
      const vcJs = fs.readFileSync(path.join(DIR, 'js', 'view-collect.js'), 'utf8');
      ok('⛔ 风控线 200 在服务端有具名常量（不再是散落的字面量）',
        /_EST_DETAIL_THRESHOLD\s*=\s*200/.test(srv));
      ok('⛔ collect_frequency 不再硬编码 200（改用常量）',
        !/'detailThreshold':\s*200/.test(srv) && /'detailThreshold':\s*_EST_DETAIL_THRESHOLD/.test(srv));
      ok('frequency 把「本轮上限」也一起给前端（好把两个数讲清）',
        /'detailCap':\s*_EST_DETAIL_TOP_N/.test(srv));
      ok('⛔ 前端不再硬编码 200（原来写 `freq.detailThreshold || 200`）',
        !/detailThreshold\s*\|\|\s*200/.test(vcJs));
      /* ⛔ 判**代码里的字符串字面量组合**，不是"整个文件里出现过某串" ——
         第一版写的就是后者，结果我只把文案改了个说法，断言依然绿（因为
         旧的措辞恰好还留在我的注释里）。注释不能喂养断言。 */
      ok('⛔ 频次行把「本轮上限 + 风控线」连在一句里说，并点明"优先期望岗位、没排上的接着补"',
        /seg\.push\('详情本轮上限 <b>' \+ capN/.test(vcJs) &&
        /风控线约 ' \+ thrN/.test(vcJs) &&
        /优先补你的期望岗位，没排上的下次接着补/.test(vcJs));
      ok('⛔ 频次行不再出现"全池都会补完"式的空头承诺（相关口径才成立）',
        !/没抓到的下次采集会接着补/.test(vcJs.replace(/\/\*[\s\S]*?\*\//g, '')
          .split('\n').filter(l => !/^\s*(\/\/|\*)/.test(l)).join('\n')));
      /* 预估值那句也要说明"不是丢了" */
      const e4 = VC._fmtEstimate({ minutes: 5.2, listMinutes: 1, detailMinutes: 4.2,
        detailCapped: true, detailCapN: 50, unlimited: false });
      ok('⛔ 预估值说明"没抓到的下次采集接着补"（否则用户以为 50 就是上限、永远只有 9%）',
        /接着补/.test(e4), e4);
      ok('原有的「只抓优先级最高的 N 个」口径没被改坏（老断言仍成立）',
        /只抓优先级最高的 50 个/.test(e4), e4);

      /* ---------- ⑥ 「清空结果」要把 JD 不延续这件事说清 ---------- */
      const savedR = S4.result;
      S4.result = { source: '（测试）', jobs: [{ 岗位: '运营', 公司: '甲', 城市: '杭州', 薪资: '10-20K' }] };
      let confirmMsg = '';
      const okConfirm = U.confirm;
      U.confirm = function (msg) { confirmMsg = String(msg); return Promise.resolve(false); };
      try { VC._clearResults(); } catch (e) { /* 关掉确认框即可 */ }
      await tick();
      U.confirm = okConfirm;
      ok('⛔ 清空结果的确认框里写明「已抓到的 JD 不会带到下一轮」',
        /JD/.test(confirmMsg) && /不会带到下一轮/.test(confirmMsg), confirmMsg.slice(0, 240));
      ok('⛔ 措辞不能说成"数据丢了"（归档里还在，只是不延续）',
        !/数据丢|永久删|丢失/.test(confirmMsg), confirmMsg.slice(0, 240));
      S4.result = savedR;

      /* ---------- ⑦ AI 助手空输入要有反馈 ---------- */
      const sendBtn = U.$('#quickSend');
      ok('前置：#quickSend 在页面骨架里', !!sendBtn);
      if (sendBtn) {
        const inp = U.$('#quickInput');
        const AI_KEEP = sandbox.AI.ready;
        sandbox.AI.ready = () => true;          // 让它跳过"没配 Key"那条分支
        clearToasts();
        if (inp) inp.value = '';
        try { sendBtn.click(); } catch (e) { /* noop */ }
        await tick();
        sandbox.AI.ready = AI_KEEP;
        /* ⛔ 断言的载体是 #toasts 的**渲染文本**（不是那个 Notification 数组 ——
           那个数组是给 `new Notification()` 用的，跟 U.toast 不是一回事）。 */
        const toastTxt = String((U.$('#toasts') || {}).textContent || '');
        ok('⛔ 空输入点发送 → 至少给一条提示（原来直接 return，屏幕上什么都不发生）',
          toastTxt.length > 0, JSON.stringify(toastTxt.slice(0, 80)));
        ok('提示是可照做的（"先写点什么"）',
          /写点什么/.test(toastTxt), toastTxt.slice(0, 80));
        clearToasts();
      }

      /* ---------- ⑧ 账号 chip：没密码的账号点一下**真的**切换 ---------- */
      const A = sandbox.Account;
      ok('前置：Account.openSwitch 可用', !!(A && typeof A.openSwitch === 'function'));
      if (A && typeof A.openSwitch === 'function') {
        /* ⛔ 不能拿"另一个已有账号"来测：它可能设了密码，那样走的是"需先输密码"分支，
           断言会被 gate 掉（第一版就是这么漏的 —— 变异把单击直切换成"只填输入框"都没红）。
           所以**自己造一个无密码账号**，测完删掉。 */
        const curAcct = Store.currentAccount ? Store.currentAccount() : null;
        const probeName = 'qa单击直切探针';
        const created = Store.createAccount(probeName, '');
        ok('前置：造出一个无密码的测试账号（否则测不到"单击直切"那条分支）',
          !!(created && created.ok), JSON.stringify(created));
        if (created && created.ok) {
          const names = Store.listAccounts().map(x => x.name);
          ok('前置：账号列表里确实有它，且没设密码',
            names.indexOf(probeName) >= 0 &&
            !(Store.listAccounts().filter(x => x.name === probeName)[0] || {}).hasPwd,
            names.join('/'));
          try { A.openSwitch(); } catch (e) { /* noop */ }
          await tick();
          const chips = U.$$('.acct-chip');
          ok('账号弹窗渲染出了 chip', chips.length >= 1, String(chips.length));
          const target = chips.filter(c => String(c.textContent).indexOf(probeName) >= 0)[0];
          ok('找得到目标账号的 chip', !!target, chips.map(c => c.textContent).join('|'));
          if (target) {
            const cur0 = Store.currentAccount ? Store.currentAccount() : '';
            try { target.click(); } catch (e) { /* noop */ }
            await tick();
            const cur1 = Store.currentAccount ? Store.currentAccount() : '';
            ok('⛔ 点一下 chip 就**真的**切换到那个账号（原来只是把名字填进输入框，毫无反应）',
              cur1 === probeName,
              '当前账号 ' + cur0 + ' → ' + cur1);
            /* 切回去并删掉探针账号，别把后面的用例留在别的账号上 */
            try { Store.switchAccount(curAcct); } catch (e) { /* noop */ }
          }
          try { U.closeAllModals(true); } catch (e) { /* noop */ }
          try { Store.deleteAccount(probeName); } catch (e) { /* noop */ }
          ok('探针账号已清理（不留垃圾账号）',
            Store.listAccounts().map(x => x.name).indexOf(probeName) < 0,
            Store.listAccounts().map(x => x.name).join('/'));
        }
      }

      /* ---------- ⑨ 存储占用要说清"其中约一半是备份" ---------- */
      const u = Store.usage();
      ok('Store.usage() 报出备份占用 bakBytes（不再只给一个总数）',
        typeof u.bakBytes === 'number', JSON.stringify({ bytes: u.bytes, bak: u.bakBytes }));
      ok('同时给出人能读的 bakText', typeof u.bakText === 'string', String(u.bakText));
      const setJs = fs.readFileSync(path.join(DIR, 'js', 'view-settings.js'), 'utf8');
      ok('⛔ 设置页占用那行会说明"其中约 X 是上一版备份"',
        /是上一版备份/.test(setJs), '');
      const storeJs = fs.readFileSync(path.join(DIR, 'js', 'store.js'), 'utf8');
      ok('备份的口径来自真实落盘键（KEY_BAK）', /localStorage\.getItem\(KEY_BAK\(\)\)/.test(storeJs));

      /* ---------- ⑩ 换端口要提示（否则旧书签静默失效） ---------- */
      /* ⛔ 必须判**结构**，不能judge"出现过某串"：第一版只查 /上次的端口是/ 是否出现，
         把那段包进 `if False:` 之后字符串还在文件里 → 变异照样绿（本项目写明的反模式）。 */
      ok('⛔ 服务端在端口和上次不同时会打印提示——判的是那个 if 守卫本身（不是"文中出现过"）',
        /if _prev_port and _prev_port != port:/.test(srv), '');
      ok('提示里同时给出新旧端口与要更新的书签',
        /上次的端口是/.test(srv) && /书签/.test(srv) &&
        /这次换成了/.test(srv));
      ok('⛔ 那段提示没有被 `if False` / `if 0` 之类的恒定假条件关掉',
        !/if\s+(False|0)\s*:\s*\n\s*print\('  \[注意\] 上次的端口是/.test(srv));
      ok('⛔ 读旧端口发生在**覆盖** PORT_PATH 之前（否则读到的是自己）',
        srv.indexOf('_prev_port = int(') < srv.indexOf('with open(PORT_PATH, \'w\''));

      /* ---------- ⑪ 导入后商圈行要重绘（原来导入完停留在本页看到"还没采到商圈"） ---------- */
      /* ⛔ 顺序很关键：必须**先把页面渲染出来**（此时库里还没有这颗探针商圈），
         再走导入 → 库里多一条带商圈的数据 → 商圈行应当就地更新。
         第一版我把 addJobs 写在渲染之前，前置断言自然不成立（页面本来就带着它渲染了）。 */
      await withFetch((url) => {
        const p = String(url).replace(/^https?:\/\/[^/]+/, '');
        let body = { ok: false, error: 'no stub: ' + p };
        if (p.indexOf('/api/ping') === 0) body = fakePing;
        else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
        else if (p.indexOf('/api/estimate') === 0) body = { ok: false, error: 'test' };
        return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
      }, async () => {
        S4.form = null;
        App.go('collect');
        await tick(); await tick(); await tick(); await tick(); await tick(); await tick();
        const bizRowText = () => {
          const f = U.$$('#view .fld').filter(x => (x.textContent || '').indexOf('省 > 市 > 区 > 商圈') >= 0)[0];
          if (!f) return '';
          const rows = U.$$('.georow', f);
          return rows.length >= 4 ? String(rows[3].textContent) : '';
        };
        const before = bizRowText();
        ok('前置：这颗探针商圈此刻**不在**参数卡候选里（页面是入库之前的快照）',
          before.indexOf('重绘探针商圈ZZZ') < 0, before.slice(0, 140));

        /* 真跑一次导入（_import 就是导入按钮 onclick 调的那个入口） */
        S4.result = { source: '（测试）', jobs: [{ 岗位: '重绘探针岗', 公司: '探针公司',
          城市: '杭州', 区域: '滨江区', 商圈: '重绘探针商圈ZZZ', 薪资: '10-20K' }] };
        try { VC._import(null); } catch (e) { /* noop */ }
        await tick(); await tick(); await tick(); await tick();
        const after = bizRowText();
        ok('⛔ 导入完成后，商圈行**就地**更新了（不再要"离开页面再回来"才刷新）',
          after.indexOf('重绘探针商圈ZZZ') >= 0,
          'before=' + before.slice(0, 60) + ' ‖ after=' + after.slice(0, 140));
        ok('⛔ 导入没有把参数卡整块搞坏（地点四行还在）',
          U.$$('#view .georow').length === 4, String(U.$$('#view .georow').length));
      });
      /* 清掉这次导入带进来的探针岗位（按标题找，不依赖 id 是否被记下来） */
      try {
        Store.removeJobs(Store.jobs().filter(j => j.title === '重绘探针岗').map(j => j.id));
      } catch (e) { /* noop */ }
      S4.result = savedR;
      localStorage.removeItem(FKEY);
      S4.form = null;
      S4.geoOwned = false;
      clearToasts();
    }

    /* ==================================================================
       【34】详情额度「给对的人」：方向词从采集参数 → 命令行 → 爬虫

       问题本质是「额度给谁」而不是「额度多大」：详情是封顶的（本轮 50 条），
       而 crawler 的 detail_priority() 原来只按「信息完整度」排序，**不知道方向** ——
       于是额度被「亚马逊运营（信息齐全）」这类无关岗位吃掉。
       实测（真实 13 个 CSV / 545 行、预算 50）：
           旧口径入选里方向相关只有  6 条（12%）
           新口径入选里方向相关    50 条（100%）
           方向相关覆盖率 33% → 85%（宽口径）/ 100%（窄口径）
       ⛔ 详情请求数不变（50 → 50）→ 风控暴露不变。

       本节钉住**链路**：采集参数里的「岗位期望」必须原样走到命令行上，
       且为空时不能改变任何既有行为。
       ================================================================== */
    {
      const vcJs2 = fs.readFileSync(path.join(DIR, 'js', 'view-collect.js'), 'utf8');
      const srv2 = fs.readFileSync(path.join(DIR, '采集器', 'server.py'), 'utf8');
      /* ⛔ 爬虫源码的位置不能写死本机绝对路径（那会让别人 clone 下来必然红）。
         优先用仓库内自带的 `_打包工程/crawler_src/scripts/boss_crawler/`
         （它随仓库分发，是 crawl 链路的真实来源）；
         找不到才回退到历史的本机 skill 目录（老环境仍可用）。 */
      const SK2 = (function () {
        const cands = [];
        if (PACK_DIR) cands.push(path.join(PACK_DIR, 'crawler_src', 'scripts', 'boss_crawler') + path.sep);
        cands.push('C:/Users/1/.workbuddy/skills/boss-crawler/scripts/boss_crawler/');
        for (let i = 0; i < cands.length; i++) {
          if (fs.existsSync(path.join(cands[i], 'crawler.py'))) return cands[i];
        }
        return cands[cands.length - 1];
      })();
      /* 爬虫源码若两处都找不到（极端裁剪的 clone），这一节的爬虫侧断言降级为
         「跳过并说明」，而不是抛异常把后面所有断言一起吞掉。 */
      const hasCrawlerSrc = fs.existsSync(path.join(SK2, 'crawler.py')) &&
                            fs.existsSync(path.join(SK2, 'cli.py'));
      const crawlerPy = hasCrawlerSrc ? fs.readFileSync(path.join(SK2, 'crawler.py'), 'utf8') : '';
      const cliPy = hasCrawlerSrc ? fs.readFileSync(path.join(SK2, 'cli.py'), 'utf8') : '';
      ok('能定位到爬虫源码（crawler.py / cli.py）', hasCrawlerSrc,
        hasCrawlerSrc ? SK2 : '两处都没找到：' + SK2);

      /* ---------- ① 前端：payload 里必须带 expectJobs，且**原样透传** ---------- */
      const crawlReq = vcJs2.match(/req\('\/api\/crawl',\s*\{([\s\S]*?)\n    \}\)/);
      ok('能定位到 /api/crawl 的请求体', !!crawlReq);
      if (crawlReq) {
        ok('⛔ 采集 payload 带上采集参数里的「岗位期望」（expectJobs）',
          /expectJobs:\s*f\.expectJobs/.test(crawlReq[1]));
        ok('⛔ 是**原样**透传：没有 map/filter/split/join 之类加工（不做任何转换/推导）',
          /expectJobs:\s*f\.expectJobs\s*\|\|\s*\[\]/.test(crawlReq[1]),
          crawlReq[1].slice(-200));
        ok('⛔ 采集 payload 带上 includeKnown（勾选=重采历史；默认 false=去重）',
          /includeKnown:\s*!!f\.includeKnown/.test(crawlReq[1]));
      }

      /* ---------- ② 服务端：拼成 --detail-prefer（且在正确的函数里） ---------- */
      const bcc = srv2.match(/def build_cmd_crawl\([\s\S]*?\n(?=\ndef )/);
      ok('能定位到 build_cmd_crawl 函数体', !!bcc);
      if (bcc) {
        ok('⛔ build_cmd_crawl 里把 expectJobs 拼成 --detail-prefer',
          /put_list\('--detail-prefer',\s*p\.get\('expectJobs'\)\)/.test(bcc[0]));
        ok('⛔ 用 put_list（值可能是数组，必须转成逗号串；用 put 会拼出 list 的字面形式）',
          /put_list\('--detail-prefer'/.test(bcc[0]) &&
          !/put\('--detail-prefer'/.test(bcc[0]));
        ok('⛔ 空值保护：put_list 只在非空时透传 → 没填期望岗位时命令里**不出现**该 flag',
          /def put_list\(flag, value\):/.test(srv2) &&
          /if value not in \(None, '', \[\], \(\)\):/.test(srv2));
      }
      ok('⛔ --detail-prefer 不参与采集范围（范围仍然只由 --keywords 决定）',
        !/put_or_blank\('--keywords'[^)]*detail-prefer/.test(srv2));

      /* ---------- ②b 采集已采过岗位：--include-known 透传（store_true 布尔，不带值） ---------- */
      ok('⛔ build_cmd_crawl 按 includeKnown 拼 --include-known（只有勾选才透传）',
        /if\s+p\.get\('includeKnown'\):\s*\n\s*cmd\s*\+=\s*\['--include-known'\]/.test(srv2));
      ok('⛔ 用 store_true 语义（不带值），不拼出 `--include-known <值>` 这种怪参数',
        !/put\('--include-known'/.test(srv2) && !/put_or_blank\('--include-known'/.test(srv2));

      /* ---------- ③ 爬虫：方向加权 + 透传链完整 ----------
         ⚠️ 爬虫源码找不到时这些**跳过**（上面已有一条专门的红/绿断言说明原因），
            不能让十几条连带失败把真正的失败点淹没。 */
      if (hasCrawlerSrc) {
      ok('detail_priority 多了可选的 prefer 参数（默认 None → 旧行为）',
        /def detail_priority\(row, prefer=None\):/.test(crawlerPy));
      ok('⛔ 命中方向词加的是 +10（必须压过原有五个信号的满分 9）',
        /score \+= 10/.test(crawlerPy));
      ok('⛔ **两个** detail_priority 调用点都传了 prefer（只改一处 = 静默失效）',
        (crawlerPy.match(/detail_priority\(row, prefer\)/g) || []).length === 2,
        String((crawlerPy.match(/detail_priority\(row, prefer\)/g) || []).length));
      ok('select_detail_targets 把 prefer 下传',
        /def select_detail_targets\(file_paths, existing_links, budget, known=None, prefer=None\)/.test(crawlerPy) &&
        /known=known, prefer=prefer/.test(crawlerPy));
      ok('⛔ execute_crawl_iteration 收 detail_prefer 并用在**全局分配那一处**',
        /detail_prefer=None,\s*include_known=False\):/.test(crawlerPy) &&
        /* ⛔ 不能只查「文件里有没有 prefer=detail_prefer」—— 这个串在 crawler.py 里有**两处**
           （① 全局分配 select_detail_targets；② 逐岗位 crawl_job_details）。
           只查存在性时，把 ① 改掉、② 还在 → 断言照样绿。
           实测：【33-⑭】【35-⑧】两条变异（改的都是 ①）就是这么假绿的。
           所以必须把 `select_detail_targets(` 这个调用点一起钉住。 */
        /select_detail_targets\(\s*\n\s*detail_files,\s*detail_existing_links,\s*detail_budget,\s*known=known,\s*\n\s*prefer=detail_prefer\)/.test(crawlerPy));
      ok('CLI 定义并透传 --detail-prefer',
        /* ⛔ 必须**精确**匹配参数名：第一版写的是 `/--detail-prefer/`，
           而 `--detail-prefer-XXX` 也含这个子串 → 变异把参数名改了照样绿（假绿）。
           定向变异当场照出来了。 */
        /'--detail-prefer',\s*dest='detail_prefer'/.test(cliPy) &&
        /_expand_arg\(getattr\(args,\s*'detail_prefer',\s*None\)\)/.test(crawlerPy));
      ok('⛔ 爬虫按 include_known 置空全局已知集（known=None 短路 = 重采历史岗位）',
        /known\s*=\s*None\s+if\s+include_known\s+else\s+known_links\.load\(ASSETS_DIR\)/.test(crawlerPy));
      }   /* end if (hasCrawlerSrc) */

      /* ---------- ④ UI 文案：说准"优先期望岗位"，不留空头承诺 ---------- */
      ok('⛔ 频次行说明详情额度**优先给期望岗位**（这才让"接着补"成立）',
        /优先补你的期望岗位/.test(vcJs2));
      ok('预估值同样说明按期望岗位优先',
        /按你的期望岗位优先/.test(vcJs2));

      /* ---------- ⑤ 真跑一次：命令行里确实有 --detail-prefer ---------- */
      /* ⛔ 这是本节最硬的一条 —— 前面都是"源码里有"，这条是"跑出来真的在"。
         ⛔ 不能用 `spawnSync(..., {encoding:'utf8'})`：那会建**管道**，而本机
            node 派生子进程只要走管道就 EBUSY（本项目 2026-10-07 踩过两次）。
            改用「stdout/stderr 都写文件描述符」，跑完读回来。 */
      const scratch = path.join(DIR, '_scratch');
      try { fs.mkdirSync(scratch, { recursive: true }); } catch (e) { /* noop */ }
      const tmpOut = path.join(scratch, '_prefer_cmdcheck.json');
      const tmpErr = path.join(scratch, '_prefer_cmdcheck.err');
      const pyCode = [
        'import sys, json',
        'sys.path.insert(0, ' + JSON.stringify(path.join(DIR, '采集器')) + ')',
        'import server as srv',
        'base = {"city":"杭州","keywords":["内容运营"],"count":50,"crawlMode":"custom"}',
        'out = {}',
        'out["with"] = srv.build_cmd_crawl(dict(base, expectJobs=["短视频运营","内容运营"]))',
        'out["empty"] = srv.build_cmd_crawl(dict(base, expectJobs=[]))',
        'out["none"] = srv.build_cmd_crawl(dict(base))',
        'out["list_mode"] = srv.build_cmd_crawl(dict(base, crawlMode="list"))',
        'out["incl"] = srv.build_cmd_crawl(dict(base, includeKnown=True))',
        'out["noincl"] = srv.build_cmd_crawl(dict(base, includeKnown=False))',
        'out["keywords_same"] = (',
        '    out["with"][out["with"].index("--keywords")+1]',
        '    == out["none"][out["none"].index("--keywords")+1])',
        'open(' + JSON.stringify(tmpOut) + ', "w", encoding="utf-8").write(json.dumps(out, ensure_ascii=False))',
      ].join('\n');
      const pyExe = fs.existsSync('C:/Users/1/.workbuddy/binaries/python/envs/boss-crawler/Scripts/python.exe')
        ? 'C:/Users/1/.workbuddy/binaries/python/envs/boss-crawler/Scripts/python.exe' : 'python';
      try { fs.unlinkSync(tmpOut); } catch (e) { /* noop */ }
      const fdErr = fs.openSync(tmpErr, 'w');
      try {
        require('child_process').spawnSync(pyExe, ['-c', pyCode],
          { cwd: DIR, stdio: ['ignore', fdErr, fdErr], timeout: 60000 });
      } finally { fs.closeSync(fdErr); }
      let cmdOut = null;
      try { cmdOut = JSON.parse(fs.readFileSync(tmpOut, 'utf8')); } catch (e) { cmdOut = null; }
      let errTxt = '';
      try { errTxt = fs.readFileSync(tmpErr, 'utf8').slice(-240); } catch (e) { /* noop */ }
      ok('能用真实 python 跑出 build_cmd_crawl 的结果', !!cmdOut, errTxt);
      if (cmdOut) {
        const valOf = (cmd, f) => (cmd.indexOf(f) >= 0 ? cmd[cmd.indexOf(f) + 1] : null);
        ok('⛔ 真跑：期望岗位有值时，命令行里确实有 --detail-prefer',
          (cmdOut['with'] || []).indexOf('--detail-prefer') >= 0, JSON.stringify(cmdOut['with']));
        ok('⛔ 真跑：值是原样的逗号串（不做任何加工）',
          valOf(cmdOut['with'], '--detail-prefer') === '短视频运营,内容运营',
          String(valOf(cmdOut['with'], '--detail-prefer')));
        ok('⛔ 真跑：空数组 / 缺失时**不出现**该 flag（向后兼容：命令与以前逐字一致）',
          (cmdOut['empty'] || []).indexOf('--detail-prefer') < 0 &&
          (cmdOut['none'] || []).indexOf('--detail-prefer') < 0,
          JSON.stringify(cmdOut['empty']));
        ok('⛔ 真跑：加上它**没有改变**采集范围参数（--keywords 值一致）',
          cmdOut['keywords_same'] === true, String(cmdOut['keywords_same']));
        ok('⛔ 真跑：crawlMode=list 会透传 --crawl-mode list',
          valOf(cmdOut['list_mode'], '--crawl-mode') === 'list', JSON.stringify(cmdOut['list_mode']));
        ok('⛔ 真跑：includeKnown=True 时命令行里有 --include-known（不带值）',
          (cmdOut['incl'] || []).indexOf('--include-known') >= 0, JSON.stringify(cmdOut['incl']));
        ok('⛔ 真跑：includeKnown=False / 缺失时**不出现** --include-known（保持去重）',
          (cmdOut['noincl'] || []).indexOf('--include-known') < 0 &&
          (cmdOut['none'] || []).indexOf('--include-known') < 0,
          JSON.stringify(cmdOut['noincl']));
        ok('⛔ 真跑：crawlMode=custom 会透传 --crawl-mode custom',
          valOf(cmdOut['none'], '--crawl-mode') === 'custom', JSON.stringify(cmdOut['none']));
      }
      try { fs.unlinkSync(tmpOut); } catch (e) { /* noop */ }
      try { fs.unlinkSync(tmpErr); } catch (e) { /* noop */ }
    }

    /* ==================================================================
       【43】简历匹配（P2）：server 接 match 阶段 + 打分/原因挂载 + 成本预估
       ================================================================== */
    {
      const srvTxt = fs.readFileSync(path.join(DIR, '采集器', 'server.py'), 'utf8');

      /* ---------- ① 源码：POST /api/match 与 /api/match/estimate 都注册了 ---------- */
      ok('服务端注册了 POST /api/match',
        /if path == '\/api\/match':\s*\n\s*return self\._match\(/.test(srvTxt));
      ok('服务端注册了 POST /api/match/estimate',
        /if path == '\/api\/match\/estimate':/.test(srvTxt));

      /* ---------- ② 前端：结果卡有「简历匹配」按钮 + 发起 /api/match ---------- */
      const vcTxt = fs.readFileSync(path.join(DIR, 'js', 'view-collect.js'), 'utf8');
      ok('前端有 openMatchModal（选初筛/二筛）', /function openMatchModal\(/.test(vcTxt));
      ok('前端发起匹配走 /api/match', /req\('\/api\/match',\s*\{/.test(vcTxt));
      ok('前端把 matchMode 透传给服务端', /matchMode:\s*modeSel\.value/.test(vcTxt));

      /* ---------- ③ 真跑：build_cmd_match / estimate_match / match_map / load_jobs ---------- */
      const scratch = path.join(DIR, '_scratch');
      try { fs.mkdirSync(scratch, { recursive: true }); } catch (e) { /* noop */ }
      const mOut = path.join(scratch, '_match_check.json');
      const mErr = path.join(scratch, '_match_check.err');
      const pyCode = [
        'import sys, json, os, tempfile',
        'sys.path.insert(0, ' + JSON.stringify(path.join(DIR, '采集器')) + ')',
        'import server as srv',
        'out = {}',
        // build_cmd_match：quick / deep / deep(缺 topN) / 非法 mode
        'out["q"] = srv.build_cmd_match({"matchMode":"quick"}, "RD")',
        'out["d"] = srv.build_cmd_match({"matchMode":"deep","topN":20,"workers":6}, "RD")',
        'out["d0"] = srv.build_cmd_match({"matchMode":"deep"}, "RD")',
        'out["bad"] = srv.build_cmd_match({"matchMode":"xxx"}, "RD")',
        // estimate_match
        'out["eq"] = srv.estimate_match({"matchMode":"quick"})',
        'out["ed"] = srv.estimate_match({"matchMode":"deep","topN":10,"workers":2})',
        // match_map（深度：match_analysis.json） + load_jobs 挂载
        'tmp = tempfile.mkdtemp(prefix="jh_match_")',
        'os.makedirs(os.path.join(tmp,"state"), exist_ok=True)',
        'L1, L2 = "https://a/1.html", "https://a/2.html"',
        'json.dump([{"link":L1,"职位":"运营","公司":"甲","城市":"杭州","薪资":"12-18K"},',
        '           {"link":L2,"职位":"产品","公司":"乙","城市":"杭州","薪资":"25-40K"}],',
        '          open(os.path.join(tmp,"state","qualified_jobs.json"),"w",encoding="utf-8"), ensure_ascii=False)',
        'json.dump({L1:{"match_score":82,"application_category":"qualified","application_category_reason":"技能契合","missing_items":["SQL"]},',
        '           L2:{"match_score":45,"application_category":"cannot_apply","application_category_reason":"方向不符","missing_items":[]}},',
        '          open(os.path.join(tmp,"state","match_analysis.json"),"w",encoding="utf-8"), ensure_ascii=False)',
        'mm = srv.match_map(tmp)',
        'out["mm_deep"] = mm.get(L1,{}).get("match_score")',
        'lj = srv.load_jobs(tmp)',
        'out["lj_total"] = lj.get("total")',
        'out["lj_matched"] = lj.get("matchedCount")',
        'out["lj_hasMatch"] = lj.get("hasMatch")',
        'j0 = (lj.get("jobs") or [{}])[0]',
        'out["lj_score"] = j0.get("_matchScore")',
        'out["lj_reason"] = j0.get("_matchReason")',
        'out["lj_missing"] = j0.get("_matchMissing")',
        // match_map（快速：无 match_analysis，退 scored_jobs）
        'tmp2 = tempfile.mkdtemp(prefix="jh_match2_")',
        'os.makedirs(os.path.join(tmp2,"state"), exist_ok=True)',
        'json.dump({"tier1":[{"link":L1,"match_score":88,"application_category":"qualified","application_category_reason":"强匹配","missing_skills":["x"]}],',
        '           "tier2":[],"tier3":[]},',
        '          open(os.path.join(tmp2,"state","scored_jobs.json"),"w",encoding="utf-8"), ensure_ascii=False)',
        'out["mm_quick"] = srv.match_map(tmp2).get(L1,{}).get("match_score")',
        'json.dump(out, open(' + JSON.stringify(mOut) + ',"w",encoding="utf-8"), ensure_ascii=False)',
      ].join('\n');
      const pyExe = fs.existsSync('C:/Users/1/.workbuddy/binaries/python/envs/boss-crawler/Scripts/python.exe')
        ? 'C:/Users/1/.workbuddy/binaries/python/envs/boss-crawler/Scripts/python.exe' : 'python';
      try { fs.unlinkSync(mOut); } catch (e) { /* noop */ }
      const fdErr = fs.openSync(mErr, 'w');
      try {
        require('child_process').spawnSync(pyExe, ['-c', pyCode],
          { cwd: DIR, stdio: ['ignore', fdErr, fdErr], timeout: 60000 });
      } finally { fs.closeSync(fdErr); }
      let mRes = null;
      try { mRes = JSON.parse(fs.readFileSync(mOut, 'utf8')); } catch (e) { mRes = null; }
      let mErrTxt = '';
      try { mErrTxt = fs.readFileSync(mErr, 'utf8').slice(-400); } catch (e) { /* noop */ }
      ok('能用真实 python 跑出 build_cmd_match / estimate_match / match_map / load_jobs', !!mRes, mErrTxt);
      if (mRes) {
        const cmdHas = (c, f) => (c || []).indexOf(f) >= 0;
        const valOf = (c, f) => (cmdHas(c, f) ? c[c.indexOf(f) + 1] : null);
        ok('⛔ quick 命令：--from match --to merge --match-mode quick，不带 --top-n',
          cmdHas(mRes.q, '--from') && valOf(mRes.q, '--from') === 'match' &&
          valOf(mRes.q, '--to') === 'merge' && valOf(mRes.q, '--match-mode') === 'quick' &&
          !cmdHas(mRes.q, '--top-n'), JSON.stringify(mRes.q));
        ok('⛔ deep 命令：--match-mode deep + --top-n 20 + --workers 6',
          valOf(mRes.d, '--match-mode') === 'deep' && valOf(mRes.d, '--top-n') === '20' &&
          valOf(mRes.d, '--workers') === '6', JSON.stringify(mRes.d));
        ok('⛔ deep 缺 topN 时不硬塞 --top-n（交给 pipeline 默认 15）',
          !cmdHas(mRes.d0, '--top-n'), JSON.stringify(mRes.d0));
        ok('⛔ 非法 mode 兜回 deep（不拼出 pipeline 不认的 --match-mode）',
          valOf(mRes.bad, '--match-mode') === 'deep', JSON.stringify(mRes.bad));
        ok('⛔ 预估 quick：零 token、0 分钟',
          mRes.eq && mRes.eq.mode === 'quick' && mRes.eq.tokens === 0 && mRes.eq.minutes === 0,
          JSON.stringify(mRes.eq));
        ok('⛔ 预估 deep：候选 10、token = 10×4000、分钟 > 0',
          mRes.ed && mRes.ed.mode === 'deep' && mRes.ed.candidates === 10 &&
          mRes.ed.tokens === 40000 && mRes.ed.minutes > 0, JSON.stringify(mRes.ed));
        ok('⛔ match_map 读深度 match_analysis.json（分=82）', mRes.mm_deep === 82, String(mRes.mm_deep));
        ok('⛔ match_map 无 match_analysis 时退 scored_jobs（分=88）', mRes.mm_quick === 88, String(mRes.mm_quick));
        ok('⛔ load_jobs 把匹配分+原因挂上（_matchScore=82 / _matchReason=技能契合）',
          mRes.lj_total === 2 && mRes.lj_matched === 2 && mRes.lj_hasMatch === true &&
          mRes.lj_score === 82 && mRes.lj_reason === '技能契合',
          JSON.stringify({ total: mRes.lj_total, matched: mRes.lj_matched, score: mRes.lj_score, reason: mRes.lj_reason }));
        ok('⛔ load_jobs 缺项数组挂上（_matchMissing=[SQL]）',
          Array.isArray(mRes.lj_missing) && mRes.lj_missing[0] === 'SQL', JSON.stringify(mRes.lj_missing));
      }
      try { fs.unlinkSync(mOut); } catch (e) { /* noop */ }
      try { fs.unlinkSync(mErr); } catch (e) { /* noop */ }
    }

    /* ---------- 18.13 真实在招岗位（Excel 统计）并入岗位库 / 筛选 ---------- */
    const mk = sandbox.JOB_MARKET;
    ok('JOB_MARKET 已经挂到 window 上（真实在招岗位数据）',
      !!(mk && mk.groups && mk.groups.length), String(mk && mk.groups && mk.groups.length));
    ok('真实在招岗位名 176 个', mk.meta.titles === 176, String(mk.meta.titles));
    ok('采集样本 300 条', mk.meta.sample === 300, String(mk.meta.sample));
    ok('样本城市是杭州', mk.meta.city === '杭州', String(mk.meta.city));
    ok('每个分组都带 total / jobs',
      mk.groups.every(g => typeof g.total === 'number' && Array.isArray(g.jobs) && g.jobs.length));

    const st2 = sandbox.JobPicker.stats();
    ok('stats 报出真实在招岗位数', st2.marketTitles === 176, String(st2.marketTitles));
    ok('stats 报出样本量', st2.marketSample === 300, String(st2.marketSample));

    /* 官方目录 7 个缺口已补齐（Excel 的「官方职位分类目录」比 post_data.json 全） */
    ['SEO/SEM', '风控合规', '柜员', '稽查', '放映员', '广告策划经理', '游戏推广'].forEach(n => {
      ok('官方目录补齐的岗位「' + n + '」现在在库', sandbox.JobPicker.isKnown(n) === true);
    });

    /* 搜索两份数据都能命中 */
    const mhit = sandbox.JobPicker.search('抖音短视频运营');
    ok('搜「抖音短视频运营」能命中真实在招岗位',
      mhit.some(x => x.name === '抖音短视频运营' && x.kind === 'market'),
      mhit.slice(0, 5).map(x => x.name + '/' + x.kind).join(','));
    ok('真实在招岗位的路径标着「真实在招」',
      (sandbox.JobPicker.pathOf('抖音短视频运营') || '').indexOf('真实在招') >= 0,
      sandbox.JobPicker.pathOf('抖音短视频运营'));
    ok('sourceOf 分得出官方树 / 真实在招',
      sandbox.JobPicker.sourceOf('产品经理') === 'taxonomy' &&
      sandbox.JobPicker.sourceOf('抖音短视频运营') === 'market');
    ok('两边同名的岗位只出现一次（官方树优先，不重复）',
      sandbox.JobPicker.search('新媒体运营').filter(x => x.name === '新媒体运营').length === 1);
    ok('真实在招岗位也算 isKnown',
      sandbox.JobPicker.isKnown('抖音短视频运营') === true);
    ok('官方树里也没有、真实在招也没有的词仍然不认',
      sandbox.JobPicker.isKnown('我瞎编的岗位xyz') === false);

    /* 选择器里真的渲染出「真实在招」块 */
    let mktPicker = null;
    try {
      mktPicker = sandbox.JobPicker.open({ title: '真实在招渲染测试' });
      ok('带真实在招数据的选择器能打开', !!mktPicker);
    } catch (e) {
      ok('带真实在招数据的选择器能打开', false, e && e.message);
    }
    await tick();
    ok('选择器里渲染出了「真实在招岗位」块', U.$$('.jp-mkt').length === 1, String(U.$$('.jp-mkt').length));
    const mktGroups = U.$$('.jp-mkt-g');
    ok('真实在招块按分类分组（10 组）', mktGroups.length === mk.groups.length, String(mktGroups.length));
    if (mktGroups.length) {
      // 展开第一组 → 应该按需渲染出 chip
      mktGroups[0].open = true;
      mktGroups[0].dispatchEvent({ type: 'toggle', target: mktGroups[0], stopPropagation() {}, preventDefault() {} });
      const chips = U.$$('.jp-mkt-c');
      ok('展开分类后渲染出真实在招岗位 chip', chips.length === mk.groups[0].jobs.length,
        chips.length + ' vs ' + mk.groups[0].jobs.length);
      if (chips.length) {
        ok('chip 上带出现次数角标', U.$$('.jp-cnt').length === chips.length);
        chips[0].click();
        ok('点真实在招 chip 能选中', mktPicker.picked().length === 1, JSON.stringify(mktPicker.picked()));
        ok('选中的是 chip 上的岗位名，不带次数',
          mktPicker.picked()[0] === mk.groups[0].jobs[0].name, mktPicker.picked()[0]);
        chips[0].click();
        ok('再点一次取消选中', mktPicker.picked().length === 0);
        // 「本组全加」
        const addBtn = mktGroups[0].querySelector('.jp-mkt-ops button');
        ok('真实在招分组有「本组全加」按钮', !!addBtn && (addBtn.textContent || '').indexOf('本组全加') >= 0,
          addBtn && addBtn.textContent);
        if (addBtn) {
          addBtn.click();
          ok('「本组全加」把整组岗位都选中了',
            mktPicker.picked().length === mk.groups[0].jobs.length,
            mktPicker.picked().length + ' vs ' + mk.groups[0].jobs.length);
        }
      }
    }
    if (mktPicker) mktPicker.close();
    await tick();

    /* 搜索命中里带「真实在招」标签 */
    let mktSearch = null;
    try {
      mktSearch = sandbox.JobPicker.open({ title: '搜真实在招', selected: [] });
    } catch (e) { /* 上面已经断言过能打开了 */ }
    await tick();
    const sInp = U.$$('.jp-inp')[0];
    if (sInp && mktSearch) {
      sInp.value = '抖音短视频运营';
      sInp.dispatchEvent({ type: 'input', target: sInp, stopPropagation() {}, preventDefault() {} });
      ok('搜索面板里给真实在招命中打了标签', U.$$('.jp-badge').length >= 1, String(U.$$('.jp-badge').length));
      ok('搜索面板里真实在招命中带 jp-hit-mkt 标记', U.$$('.jp-hit-mkt').length >= 1);
    } else {
      ok('搜索面板里给真实在招命中打了标签', false, '没找到搜索框');
    }
    if (mktSearch) mktSearch.close();
    await tick();

    /* 采集结果筛选：岗位名下拉 + 真的筛得动 */
    const jOpts = collect._marketJobOptions();
    ok('岗位名下拉 = 1 个「不限」+ 176 个真实在招岗位',
      jOpts.length === 177, String(jOpts.length));
    ok('岗位名下拉首项是「不限」', jOpts[0].v === '', JSON.stringify(jOpts[0]));
    ok('岗位名下拉按分类分组（optgroup）',
      jOpts.filter(o => o.group).length === 176, String(jOpts.filter(o => o.group).length));
    ok('岗位名下拉带出现次数',
      jOpts.some(o => o.l.indexOf('（28）') >= 0),
      jOpts.slice(1, 4).map(o => o.l).join(' / '));

    const fakeRes = [
      { title: '新媒体运营', company: 'A', location: '杭州', salaryMin: 8, salaryMax: 12, benefits: [], industry: '互联网' },
      { title: 'Java 开发工程师', company: 'B', location: '上海', salaryMin: 20, salaryMax: 30, benefits: [], industry: '互联网' },
      { title: '抖音短视频运营', company: 'C', location: '杭州', salaryMin: 6, salaryMax: 10, benefits: [], industry: '文化传媒' },
    ];
    const CFx = collect._cf;
    const resetCF = () => {
      CFx.kw = ''; CFx.job = ''; CFx.city = ''; CFx.industry = '';
      CFx.salary = ''; CFx.scored = ''; CFx.welfare = []; CFx.active = ''; CFx.sort = 'default';
    };
    resetCF();
    ok('不设岗位名时三个岗位全留', collect._filterResults(fakeRes).length === 3,
      String(collect._filterResults(fakeRes).length));

    CFx.job = '抖音短视频运营';
    const onlyOne = collect._filterResults(fakeRes).map(j => j.title);
    ok('岗位名筛「抖音短视频运营」只留它',
      onlyOne.length === 1 && onlyOne[0] === '抖音短视频运营', onlyOne.join(','));

    CFx.job = '内容运营';
    ok('岗位名筛样本里没有的岗位 → 0 条（不是全量泄漏）',
      collect._filterResults(fakeRes).length === 0,
      String(collect._filterResults(fakeRes).length));

    CFx.job = '新媒体运营';
    ok('岗位名筛「新媒体运营」命中标题更长的（双向包含）',
      collect._filterResults(fakeRes).map(j => j.title).join(',') === '新媒体运营');
    ok('设了岗位名就算「有筛选条件」（导入按钮会变成导筛选结果）',
      collect._collectHasFilter() === true);
    resetCF();
    ok('清空后不再算有筛选条件', collect._collectHasFilter() === false);
    CFx.job = '新媒体运营';
    CFx.city = '杭州';
    collect._clearCF();
    ok('clearCF（清空筛选按钮）会把岗位名一起清掉',
      CFx.job === '' && CFx.city === '' && collect._collectHasFilter() === false,
      JSON.stringify({ job: CFx.job, city: CFx.city }));
    resetCF();

    /* 新 class 都在 CSS 里有定义（防「看着能跑、样式全丢」） */
    const cssAll = fs.readFileSync(path.join(DIR, 'css', 'app.css'), 'utf8');
    ['.jp-mkt', '.jp-mkt-head', '.jp-mkt-t', '.jp-mkt-sub', '.jp-mkt-g',
     '.jp-mkt-ops', '.jp-mkt-jobs', '.jp-mkt-c', '.jp-mkt-n', '.jp-cnt',
     '.jp-badge', '.jp-hit-mkt', '.jp-hits-tip'].forEach(sel => {
      const hit = new RegExp(sel.replace('.', '\\.') + '(?=[\\s,{:.])').test(cssAll);
      ok('css 里有 ' + sel + ' 的样式定义', hit);
    });
  }


  /* ---- 18.13 公司背调（路线 A 跳转 + 档案 + 绿黄红预警 + 组合预警）---- */
  section('【19】公司背调');

  {
    const CC = sandbox.CompanyCheck;
    const CV = sandbox.CompanyView;
    const DAY = 86400000;
    ok('公司背调能力模块已加载', !!CC);
    ok('公司背调页面已注册', !!CV && !!(sandbox.Views.company));

    /* ---------- 19.1 路线 A：一键跳转 ---------- */
    eq('目标站有 3 个（天眼查 / 爱企查 / gsxt）', CC.SITES.length, 3);
    ok('天眼查是可深链的（能带公司名）', CC.site('tianyancha').url('杭州云栖科技有限公司')
      .indexOf('tianyancha.com/search?key=') >= 0);
    ok('公司名做了 URL 编码（否则「&」「空格」会把搜索词截断）',
      CC.site('tianyancha').url('A&B 科技').indexOf('A%26B%20') >= 0,
      CC.site('tianyancha').url('A&B 科技'));
    /* ⛔ gsxt 是 POST 检索，**不支持带公司名的链接** —— 必须标成 manual。
       假装能深链的话，用户点进去看到空白搜索框，会以为工具坏了。 */
    ok('gsxt 标记为 manual（不支持深链，只能复制公司名）', CC.site('gsxt').manual === true);
    ok('gsxt 的链接就是首页，没有伪造成搜索页',
      CC.site('gsxt').url('任何公司') === 'https://www.gsxt.gov.cn/index.html');
    ok('gsxt 的说明里写清了「不支持带公司名」', /不支持/.test(CC.site('gsxt').note));

    eq('未知站点 → 明确失败，不静默', CC.openSite('nope', '某公司').ok, false);
    eq('空公司名 → 明确失败', CC.openSite('tianyancha', '   ').ok, false);

    /* ---------- 19.2 公司名归并 ---------- */
    eq('归一化去括号注释（「（杭州）」是 BOSS 的显示习惯，不是公司名的一部分）',
      CC.normName('云栖科技（杭州）有限公司'), '云栖科技有限公司');
    eq('归一化去空白/中点', CC.normName(' 云栖 · 科技 '), '云栖科技');
    ok('companyKey 大小写不敏感 + 括号无关',
      CC.companyKey('ABC（杭州）有限公司') === CC.companyKey('abc有限公司'),
      CC.companyKey('ABC（杭州）有限公司') + ' vs ' + CC.companyKey('abc有限公司'));
    /* ⛔ 刻意不剥离「有限公司」后缀 —— 剥离会把不同主体合成一家，
       那就把两家公司的背调结果合成一份了，比多几条档案危险得多。 */
    ok('⛔ companyKey 不剥离「有限公司」后缀（防误并不同主体）',
      CC.companyKey('云栖科技有限公司') !== CC.companyKey('云栖科技有限公司杭州分公司'),
      CC.companyKey('云栖科技有限公司'));

    /* ---------- 19.3 成立年限：没有成立时间必须是 null，不能是 0 ---------- */
    eq('没有成立时间 → ageYears 返回 null（不是 0）', CC.ageYears(null), null);
    eq('成立时间填成未来 → 也当没填（返回 null）', CC.ageYears(Date.parse('2027-01-01T00:00:00'), Date.parse('2026-09-30T00:00:00')), null);
    const y3 = CC.ageYears(Date.parse('2023-09-30T00:00:00'), Date.parse('2026-09-30T00:00:00'));
    ok('整三年 ≈ 3.0 年', y3 > 2.99 && y3 < 3.01, String(y3));

    /* ---------- 19.4 预警分级（§4）---------- */
    const T = Date.parse('2026-09-30T00:00:00');
    function rec(patch) {
      return Object.assign(CC.blankCheck('测试公司'), patch || {});
    }
    function reg(patch) { return { reg: Object.assign(rec().reg, patch) }; }
    function rsk(patch) { return { risk: Object.assign(rec().risk, patch) }; }
    /* 6 项风险**全部「查过且为 0」**—— 绿灯的硬前提（评审核实 2026-10-12 P1-2：
       以前 blankCheck 给 0、「没查」与「0 条」同值，于是只填成立日期就亮绿灯）。 */
    const RK_ZERO = { zhixing: 0, shixin: 0, court: 0, abnormal: 0, penalty: 0, labor: 0 };

    /* ⛔ 最要紧的一条：**没数据 = 未评定，不是绿灯**。
       把"没查"显示成"没问题"，用户会拿着一个假的安全感去投。 */
    eq('什么都没填 → 未评定（unknown），绝不是绿灯', CC.verdict(rec()).level, 'unknown');
    ok('未评定的理由说的是「还没查过」',
      /还没查过/.test(CC.verdict(rec()).reasons.join('')),
      CC.verdict(rec()).reasons.join(''));

    eq('失信 → 红灯',
      CC.verdict(rec(Object.assign({}, rsk({ shixin: 1 }), reg({ establishedAt: T - 5 * 365 * DAY, paidIn: 100, capital: 100 })), T)).level, 'red');
    eq('被执行 → 红灯',
      CC.verdict(rec(Object.assign({}, rsk({ zhixing: 2 }), reg({ establishedAt: T - 5 * 365 * DAY }))), T).level, 'red');
    eq('行政处罚 ≥3 次 → 红灯',
      CC.verdict(rec(Object.assign({}, rsk({ penalty: 3 }), reg({ establishedAt: T - 5 * 365 * DAY }))), T).level, 'red');
    eq('劳动仲裁 ≥3 起 → 红灯',
      CC.verdict(rec(Object.assign({}, rsk({ labor: 3 }), reg({ establishedAt: T - 5 * 365 * DAY }))), T).level, 'red');
    eq('经营异常 ≥3 条 → 红灯（对文档的外推：多次被列入不是「人工确认一下」能解决的）',
      CC.verdict(rec(Object.assign({}, rsk({ abnormal: 3 }), reg({ establishedAt: T - 5 * 365 * DAY }))), T).level, 'red');
    eq('经营状态「注销」→ 红灯',
      CC.verdict(rec(Object.assign({}, reg({ status: '注销', establishedAt: T - 5 * 365 * DAY }))), T).level, 'red');
    /* 状态直接红灯要**压过**其它一切 —— 公司都不在了，讨论仲裁多少没意义 */
    eq('注销 + 一切正常 → 还是红灯',
      CC.verdict(rec(Object.assign({}, rsk({}), reg({ status: '吊销', establishedAt: T - 9 * 365 * DAY, paidIn: 500 }))), T).level, 'red');

    eq('成立不足 1 年 → 黄灯',
      CC.verdict(rec(reg({ establishedAt: T - 200 * DAY, capital: 100, paidIn: 50 })), T).level, 'yellow');
    eq('经营异常 1 条 → 黄灯',
      CC.verdict(rec(Object.assign({}, rsk({ abnormal: 1 }), reg({ establishedAt: T - 5 * 365 * DAY, paidIn: 50 }))), T).level, 'yellow');
    eq('实缴为 0（认缴 > 0）→ 黄灯',
      CC.verdict(rec(reg({ establishedAt: T - 5 * 365 * DAY, capital: 100, paidIn: 0 })), T).level, 'yellow');
    /* ✅ 新增（P1-2 回归）：成立时间够了、但**风险项一项没查** → 绝不能给绿灯。
       这是本轮修掉的「假绿灯」：以前 blankCheck + normCheck 把「没查」写成 0，
       判据 `shixin===0 && zhixing===0` 于是恒真 ⇒ 只填成立日期就得到「🟢 可正常跟进」。 */
    eq('⛔ 只填成立日期、风险项一项没查 → 不给绿灯（修掉的假绿灯）',
      CC.verdict(rec(reg({ establishedAt: T - 5 * 365 * DAY })), T).level, 'unknown');
    ok('⛔ 空档案的风险项是 null（= 还没查），不是 0',
      CC.blankCheck('X').risk.zhixing === null && CC.blankCheck('X').risk.labor === null,
      JSON.stringify(CC.blankCheck('X').risk));
    /* ⚠️ 只填了注册资本、没填实缴 → **不能**当成"实缴 0"来报警（那是两件事） */
    eq('实缴留空（不知道）→ 不按「实缴 0」报黄灯（风险项已查全时才判灯）',
      CC.verdict(rec(Object.assign({}, rsk(RK_ZERO),
        reg({ establishedAt: T - 5 * 365 * DAY, capital: 100, paidIn: null }))), T).level, 'green');

    eq('成立 3 年+风险项查全且全 0+实缴到位 → 绿灯',
      CC.verdict(rec(Object.assign({}, rsk(RK_ZERO),
        reg({ establishedAt: T - 3 * 365 * DAY, capital: 100, paidIn: 100 }))), T).level, 'green');
    eq('成立 2 年以上但只有实缴 0 → 黄灯（不是绿灯）',
      CC.verdict(rec(reg({ establishedAt: T - 3 * 365 * DAY, capital: 100, paidIn: 0 })), T).level, 'yellow');
    /* 只有工商状态、没有成立时间 → **不给绿灯**（给不出结论就不给结论） */
    eq('有数据但缺成立时间 → 也不给绿灯',
      CC.verdict(rec(reg({ status: '存续' })), T).level, 'unknown',
      CC.verdict(rec(reg({ status: '存续' })), T).level);
    ok('数据不全时理由说明了缺什么',
      /数据不全/.test(CC.verdict(rec(reg({ status: '存续' })), T).reasons.join('')),
      CC.verdict(rec(reg({ status: '存续' })), T).reasons.join(''));

    /* ---------- 19.5 组合预警 ---------- */
    ok('「底薪加提成」这类话术能认出来', CC.suspiciousTalk('无责底薪3000+提成上不封顶'));
    ok('普通岗位描述不会误判', !CC.suspiciousTalk('负责公众号内容运营，双休，五险一金'));

    const comboAll = CC.comboRisk(
      rec(Object.assign({}, rsk({ labor: 5 }), reg({ establishedAt: T - 100 * DAY, capital: 100, paidIn: 0 }))),
      '无责底薪 + 高提成');
    eq('四项全中 → 记 4 项', comboAll.n, 4);
    ok('四项全中 → 判高危', comboAll.danger === true);

    const comboOne = CC.comboRisk(rec(reg({ paidIn: 0, establishedAt: T - 5 * 365 * DAY })), '');
    eq('只命中「实缴 0」→ 记 1 项', comboOne.n, 1);
    /* ⛔ 文档写「任一命中即慎入」，这里**故意收紧**：实缴 0 在初创里极常见，
       单凭它喊慎入 = 把所有创业公司劝退，用户会连真高危一起无视。 */
    ok('⛔ 只命中 1 项**不**判高危（收紧为 ≥3 项，理由见 company-check.js 注释）',
      comboOne.danger === false);

    /* ---------- 19.6 展示小工具 ---------- */
    eq('注册资本格式化', CC.fmtMoney(100), '100 万');
    ok('成立时间进了工商摘要', CC.regLine({ reg: { establishedAt: T - 3 * 365 * DAY, capital: 100, paidIn: 50 } }, T).indexOf('成立 3') >= 0,
      CC.regLine({ reg: { establishedAt: T - 3 * 365 * DAY, capital: 100, paidIn: 50 } }, T));
    eq('⛔ 风险项一项没填 → 风险行说「还没查」，**不能**说「都是 0」',
      CC.riskLine(rec()), '风险项还没查（或没查全）');
    eq('风险项全填了 0 → 风险行如实说「都是 0」',
      CC.riskLine(rec(rsk(RK_ZERO))), '风险项都是 0');
    ok('风险行列出命中的项', CC.riskLine(rec(rsk({ labor: 3, zhixing: 1 }))).indexOf('劳动纠纷 3') >= 0);
    const cl = CC.checklist(rec(rsk({ shixin: 1 })), null);
    ok('「该查什么」清单里，已查到的项标 got=true',
      cl.filter(x => x.k === 'zhixing')[0].got === true);
    ok('「该查什么」清单每一项都写了为什么该查',
      cl.every(x => x.why && x.why.length > 6));
    ok('话术命中时，「该查什么」会多列一项',
      CC.checklist(rec(), { title: '无责底薪加提成' }).some(x => x.k === 'talk'));

    /* ---------- 19.7 数据层：档案 CRUD ---------- */
    const beforeN = Store.checks().length;
    const a1 = Store.addCheck(CC.blankCheck('云栖科技有限公司'));
    eq('新增档案落库', Store.checks().length, beforeN + 1);
    const a2 = Store.addCheck(CC.blankCheck('云栖科技（杭州）有限公司'));
    ok('同一家公司的两种写法 → 合成一条（不造两份互相矛盾的档案）',
      a2.dup === true && Store.checks().length === beforeN + 1,
      'dup=' + a2.dup + ' n=' + Store.checks().length);
    ok('按归一化键能查回来', !!Store.checkByCompany('云栖科技有限公司'));
    ok('带括号的写法也查得回来', !!Store.checkByCompany('云栖科技（杭州）有限公司'));

    /* ⛔ 「实缴 0」和「实缴没填」必须分得开 —— 统一转 0 会把"没查"伪装成"查了没问题" */
    const pa = Store.upsertCheck('实缴测试公司', { reg: { paidIn: 0, capital: 100 } });
    eq('实缴填 0 → 存下来就是 0', pa.rec.reg.paidIn, 0);
    const pb = Store.upsertCheck('实缴测试公司', { reg: { paidIn: null, capital: 100 } });
    ok('实缴留空 → 存下来是 null 不是 0', pb.rec.reg.paidIn === null, String(pb.rec.reg.paidIn));
    eq('upsert 同一家公司不新增记录（还是那一条）', Store.checks().filter(c => c.company === '实缴测试公司').length, 1);

    const idBefore = a1.rec.id, createdBefore = a1.rec.createdAt;
    Store.updateCheck(idBefore, { risk: { labor: 4 } });
    const after = Store.check(idBefore);
    eq('更新后 labor 落库', after.risk.labor, 4);
    eq('更新不会改 id', after.id, idBefore);
    eq('更新不会重置 createdAt', after.createdAt, createdBefore);

    /* ---------- 19.8 导出/导入：Key 不能随备份外流 ---------- */
    Store.setSetting('bgCheck.apiKey', 'SECRET-BG-KEY');
    Store.setSetting('ai.apiKey', 'sk-keep-me');
    const exported = Store.exportObject();
    eq('⛔ 导出备份里背调的 Key 被抹掉（备份常被扔网盘 / 发人）', exported.settings.bgCheck.apiKey, '');
    /* ⛔ 这一条本轮**改了断言的期望值**（评审 2.3）：
       以前断言的是「模型 Key 保持原样」，把"默认带 Key 外发"写成了契约。
       现在默认**脱敏**，想连 Key 一起备份必须显式 `keepApiKey: true`。
       理由是设置页写着「Key 只存在你自己的浏览器里」，而备份的用途就是发出去 ——
       默认带 Key 等于把那句承诺作废。 */
    eq('⛔ 模型 Key 默认也**不**导出（以前是原样带出，等于把"Key 只在你浏览器里"作废）',
      exported.settings.ai.apiKey, '');
    ok('导出文件里标明「哪些 Key 被抹掉了」（恢复时能告诉用户要重填）',
      Array.isArray(exported._keyRedacted) && exported._keyRedacted.indexOf('ai.apiKey') >= 0,
      JSON.stringify(exported._keyRedacted));
    const exportedKeep = Store.exportObject({ keepApiKey: true });
    eq('显式要求时才保留模型 Key（完整迁移到另一台机器要用）',
      exportedKeep.settings.ai.apiKey, 'sk-keep-me');
    eq('⛔ 但背调 Key 连"保留"的选项都没有（它是更敏感的那类）',
      exportedKeep.settings.bgCheck.apiKey, '');
    ok('背调档案本身在导出对象里', Array.isArray(exported.checks) && exported.checks.length > 0);
    Store.setSetting('bgCheck.apiKey', '');

    /* 合并导入：同一家公司按**公司键**合并，而不是按 id（两台机器上 id 天然不同） */
    const importPayload = {
      jobs: [], applications: [], interviews: [], resumes: [], materials: [], chats: [],
      checks: [Object.assign(CC.blankCheck('云栖科技有限公司'), {
        id: 'chk-from-other-machine', key: '', updatedAt: U.now() + 1000,
        risk: { zhixing: 1, shixin: 0, court: 0, abnormal: 0, penalty: 0, labor: 0 },
      })],
    };
    const rep = Store.importObject(importPayload, 'merge');
    const mergedList = Store.checks().filter(c => c.key === CC.companyKey('云栖科技有限公司'));
    eq('合并导入后同一家公司仍只有 1 条', mergedList.length, 1);
    eq('合并取的是更新的那份数据（被执行 1 落库）', mergedList[0].risk.zhixing, 1);
    ok('合并计入 skipped（不是新增）', rep.skipped >= 1 && rep.checks === 0,
      JSON.stringify({ checks: rep.checks, skipped: rep.skipped }));

    /* 可撤销删除也要覆盖背调档案（人工一项项填的，误删最恼火） */
    const delId = Store.checks()[0].id;
    const nBeforeDel = Store.checks().length;
    const snap = Store.takeOut({ checks: [delId] });
    eq('takeOut 拿掉一条背调档案', Store.checks().length, nBeforeDel - 1);
    eq('快照里记着这条档案', snap.checks.length, 1);
    Store.putBack(snap);
    eq('撤销后档案回来了', Store.checks().length, nBeforeDel);

    /* ---------- 19.9 页面：真渲染 + 真点 ---------- */
    const savedChecks = Store.checks().map(c => U.deepClone(c));
    Store.checks().forEach(c => Store.removeCheck(c.id));

    /* 造一批岗位，覆盖四种情况 */
    const mkJob = (title, company) => ({
      source: 'boss', title: title, company: company, location: '杭州 · 滨江区',
      salaryText: '12-18K', salaryMin: 12, salaryMax: 18, industry: '互联网',
    });
    const jobA = Store.addJob(mkJob('新媒体运营', '杭州绿灯科技有限公司')).job;
    const jobB = Store.addJob(mkJob('内容运营', '杭州红灯网络有限公司')).job;
    Store.addJob(mkJob('短视频运营', '杭州未查文化有限公司'));
    // 第四家：有档案但档案里啥都没填（用户点了录入又空着保存）—— 必须不挂灰灯
    Store.addJob(mkJob('直播运营', '杭州空档案科技有限公司'));

    Store.addCheck(Object.assign(CC.blankCheck('杭州绿灯科技有限公司'), {
      reg: { name: '杭州绿灯科技有限公司', establishedAt: T - 3 * 365 * DAY, capital: 200, paidIn: 200, status: '存续' },
      // 绿灯的硬前提：6 项风险都查过且为 0（见 §19.4 的「没查不得绿灯」）
      risk: { zhixing: 0, shixin: 0, court: 0, abnormal: 0, penalty: 0, labor: 0 },
    }));
    Store.addCheck(Object.assign(CC.blankCheck('杭州红灯网络有限公司'), {
      reg: { name: '杭州红灯网络有限公司', establishedAt: T - 5 * 365 * DAY, capital: 100, paidIn: 0, status: '存续' },
      risk: { zhixing: 2, shixin: 1, court: 0, abnormal: 0, penalty: 0, labor: 6 },
      // 招聘话术也一起填 —— 让组合预警凑够 3 项（实缴 0 + 劳动仲裁 6 + 高提成话术）
      talk: '无责底薪 3000 + 提成上不封顶',
    }));
    // 空档案：只建档、不填任何字段 → hasData=false → 卡片上**不该**挂灰灯
    Store.addCheck(CC.blankCheck('杭州空档案科技有限公司'));

    App.go('company');
    await tick();
    ok('背调页渲染出统计卡与清单', U.$$('#view .stat').length >= 4 && U.$$('#view .ckrow').length >= 3,
      '统计卡 ' + U.$$('#view .stat').length + ' / 清单行 ' + U.$$('#view .ckrow').length);
    ok('背调页没被错误兜底卡顶掉', U.$('#view').textContent.indexOf('这个页面渲染出错了') < 0);
    ok('页面上写明了免责边界（仅供参考 / 不构成法律意见）',
      /不构成法律意见/.test(U.$('#view').textContent));
    ok('页面上写明了官方站是最终依据', /gsxt/.test(U.$('#view').textContent));

    const rowOf = (name) => U.$$('#view .ckrow').filter(r => r.textContent.indexOf(name) >= 0)[0];
    ok('绿灯公司显示「绿灯」', /绿灯/.test(rowOf('杭州绿灯科技有限公司').textContent));
    ok('红灯公司显示「红灯」', /红灯/.test(rowOf('杭州红灯网络有限公司').textContent));
    /* ⛔ 没查过的公司必须显示「未评定」，不能默认绿灯 */
    const un = rowOf('杭州未查文化有限公司');
    ok('没查过的公司显示「未评定」而不是绿灯',
      /未评定/.test(un.textContent) && !/绿灯/.test(un.textContent), un.textContent.slice(0, 80));
    ok('红灯公司列出了判定理由（只给灯不说为什么 = 没说）',
      /失信|被执行|劳动/.test(rowOf('杭州红灯网络有限公司').textContent));
    ok('红灯公司有组合预警条', U.$$('#view .ck-combo').length >= 1);
    ok('高危组合条带 bad 样式', U.$$('#view .ck-combo.bad').length >= 1);

    /* 真点「录入结果」→ 弹窗 → 填 → 点保存 → 档案真的落库（回归：点保存≠点取消） */
    const unRow = rowOf('杭州未查文化有限公司');
    const editBtn = U.$$('button', rowOf('杭州未查文化有限公司'))
      .filter(b => /录入结果/.test(b.textContent || ''))[0];
    ok('没查过的公司上有「✍️ 录入结果」按钮', !!editBtn, unRow.textContent.slice(0, 60));
    editBtn.click();
    await tick();
    const modal = U.$('.mask .modal');
    ok('点「录入结果」弹出录入弹窗', !!modal && /背调/.test(modal.textContent));
    ok('弹窗里有实时预警预览', !!U.$('.mask .ck-prev'));
    ok('弹窗里明确写了「查不到就留空，别填 0」',
      /留空/.test(modal.textContent) && /别填 0|填 0/.test(modal.textContent));

    /* 填：成立 5 年 + 失信 1 条 → 应该判红灯。
       ⚠️ 字段**按 label 定位**，不按 index —— 加一个字段就会错位，
          而且错位后填进别的框里，"预览没变红"这种失败看起来像逻辑 bug（踩过一次）。 */
    const fldOf = (txt) => U.$$('.mask .fld').filter(d => (d.textContent || '').indexOf(txt) >= 0)[0];
    const inputOf = (txt) => { const f = fldOf(txt); return f ? f.querySelector('input') : null; };
    const dateInput = inputOf('成立日期');
    ok('弹窗里有成立日期输入框', !!dateInput);
    ok('弹窗里有「失信被执行」计数框', !!inputOf('失信被执行'), '找不到失信输入框');
    dateInput.value = U.d2(T - 5 * 365 * DAY);
    dateInput.dispatchEvent({ type: 'input', target: dateInput, stopPropagation() {}, preventDefault() {} });
    const shixinInput = inputOf('失信被执行');
    shixinInput.value = '1';
    shixinInput.dispatchEvent({ type: 'input', target: shixinInput, stopPropagation() {}, preventDefault() {} });
    await tick();
    ok('边填边更新预览：填了失信 → 预览立刻变红灯',
      /红灯/.test(U.$('.mask .ck-prev').textContent), U.$('.mask .ck-prev').textContent.slice(0, 90));

    const saveBtn = U.$$('.mask .modal button, .mask button').filter(b => /^保存$/.test((b.textContent || '').trim()))[0];
    ok('弹窗里有「保存」按钮', !!saveBtn);
    saveBtn.click();
    await tick();
    eq('点保存后弹窗关闭', U.$$('.mask').length, 0);
    const savedRec = Store.checkByCompany('杭州未查文化有限公司');
    ok('⛔ 点「保存」真的把档案存下来了（不是等于点取消）', !!savedRec);
    ok('存下来的成立日期对得上', !!(savedRec.reg && savedRec.reg.establishedAt),
      String(savedRec && savedRec.reg && savedRec.reg.establishedAt));
    eq('存下来的失信计数是 1', savedRec.risk.shixin, 1);
    eq('新档案的预警等级按填的内容算出来 = 红灯', CC.verdict(savedRec).level, 'red');
    eq('档案只新增 1 条（同公司不重复）',
      Store.checks().filter(c => c.key === CC.companyKey('杭州未查文化有限公司')).length, 1);

    App.go('company');
    await tick();
    ok('重画后这家变成红灯', /红灯/.test(rowOf('杭州未查文化有限公司').textContent),
      rowOf('杭州未查文化有限公司').textContent.slice(0, 70));

    /* 岗位卡片上的公司名可点（路线 A 的入口就在卡片上）。
       ⚠️ 先把岗位库筛选清干净 —— 前面的用例会留下 kw / 合适度分级 / 隐藏剔除，
          不清的话这里只会看到上一段 fixture 的那几张卡，新加的岗位根本不在列表里。 */
    const FJ = sandbox.Views.jobs.filters;
    Object.assign(FJ, {
      kw: '', source: '', tag: '', salary: '', status: '', fav: false, archived: false,
      sort: 'new', view: 'card', pref: false, quick: {}, fit: '', hideDrop: false,
      district: '', bizArea: '', nlOff: false,
    });
    App.go('jobs');
    await tick();
    const coNames = U.$$('#view .co-name');
    ok('岗位卡片上的公司名渲染成可点元素', coNames.length >= 3, String(coNames.length));
    ok('可点元素带了说明 title', /背调/.test(coNames[0].getAttribute('title') || ''),
      coNames[0].getAttribute('title'));
    /* 已查过的公司在卡片上直接挂灯，一眼可见 */
    const lamped = U.$$('#view .co-lamp');
    /* 条数**不写死**：跟 JS 侧「这家公司有没有带数据的档案」对齐 ——
       两边不一致才是要抓的（挂漏了 / 给没查过的也挂了）。 */
    const shouldLamp = coNames
      .map(n => n.textContent)
      .filter(c => { const r = Store.checkByCompany(c); return !!(r && CC.hasData(r)); });
    eq('卡片上的灯数 = 有数据的档案数', lamped.length, shouldLamp.length,
      '灯 ' + lamped.length + ' / 应有 ' + shouldLamp.length + '（' + shouldLamp.join(',') + '）');
    /* ⛔ 没查过的公司**不该**挂灰灯 —— 几百张卡片挂同一个灰点纯噪音 */
    ok('没查过的公司不挂灯（避免满屏灰点）', lamped.length >= 1 && lamped.length < U.$$('#view .job').length,
      '灯 ' + lamped.length + ' / 卡 ' + U.$$('#view .job').length);
    /* ⛔ 有档案但档案是空的（点过录入又空着保存）也不挂灰灯：
       空档案 hasData=false → 不在 shouldLamp 里，所以灯数必须仍 = 有数据的档案数（2），
       不能因为「有 rec」就多挂一个灰点。这条专治去掉 hasData 守卫的退化。 */
    eq('空档案公司不挂灰灯（灯数 = 有数据的档案数，空档案不凑数）',
      lamped.length, shouldLamp.length,
      '灯 ' + lamped.length + ' / 应有 ' + shouldLamp.length + '（空档案『空档案科技』不在其列）');
    ok('卡片上的灯带说明', !!lamped[0] && /背调/.test(lamped[0].getAttribute('title') || ''),
      lamped[0] ? lamped[0].getAttribute('title') : '没有灯');

    /* 真点公司名 → 打开背调小弹窗 */
    coNames[0].click();
    await tick();
    ok('点公司名弹出背调弹窗', !!U.$('.mask .modal') && /背调/.test(U.$('.mask .modal').textContent));
    const siteBtns = U.$$('.mask button').filter(b => /天眼查|爱企查/.test(b.textContent || ''));
    eq('弹窗里给了天眼查 + 爱企查两个跳转按钮', siteBtns.length, 2);
    ok('弹窗里有「录入 / 改结果」入口',
      U.$$('.mask button').some(b => /录入 \/ 改结果/.test(b.textContent || '')));
    ok('弹窗里有免责说明', /不构成法律意见/.test(U.$('.mask .modal').textContent));
    U.closeAllModals();

    /* 清理：把这一段造的数据删掉，别污染后面的断言 */
    Store.takeOut({ jobs: [jobA.id, jobB.id] });
    Store.checks().forEach(c => Store.removeCheck(c.id));
    savedChecks.forEach(c => Store.addCheck(c));
    U.closeAllModals();

    /* ---------- 19.10 新 class 都在 CSS 里有定义 ---------- */
    const cssBg = fs.readFileSync(path.join(DIR, 'css', 'app.css'), 'utf8');
    ['.co-name', '.co-lamp', '.ck-bar', '.ck-q', '.ck-list', '.ckrow', '.ck-head',
     '.ck-lamp', '.ck-name', '.ck-meta', '.ck-note', '.ck-ops', '.ck-combo', '.ck-prev',
     '.stat.c-bad'].forEach(sel => {
      const hit = new RegExp(sel.replace(/\./g, '\\.') + '(?=[\\s,{:.])').test(cssBg);
      ok('css 里有 ' + sel + ' 的样式定义', hit);
    });
  }

  /* ==================================================================
     【22】第 22 轮：导入不再卡死 · 条数改了不丢 · 采集参数可折叠

     —— 用户报的三件事，逐条用**行为断言**（造数据 → 跑真函数 → 查结果）：
         ①「导入会卡住。而且没有提示」
            真机实测（库里有 2000 条时导入 506 条）：fire() 被调 **507 次**，
            整批在**一个同步任务**里跑完，事件循环被堵死 **1885ms**。
            根因 = 逐条 addJob（每条一次 save + fire + 全库线性扫去重）。
         ②「每个关键词抓多少条 好像没有效果」
            真机实测：改 20 → 同一会话重画还是 20（内存对）→ **新会话又变回 50**。
            根因 = count 不在落盘清单里，而服务端那份只是"上一次采集的回声"
            （crawl_params.json 只在跑采集时才写）。
         ③「② 采集参数 整页可以折叠」
     ================================================================== */
  {
    const VC = Views.collect;
    const S3 = VC._state;
    const CH = VC._importChunk;
    const savedKey = VC._formSaveKey;
    const keepSaved = localStorage.getItem(savedKey);
    const keepOpen = localStorage.getItem(VC._paramOpenKey);

    const mkRaw = (i, extra) => Object.assign({
      title: '批量岗位' + i, company: '批量公司' + i,
      url: 'https://www.zhipin.com/job_detail/batch' + i + '.html',
      location: '杭州', salaryText: '10-20K',
    }, extra || {});
    const dropBatch = () => Store.takeOut({
      jobs: Store.jobs().filter(j => /^(批量公司|本地优先公司)/.test(j.company)).map(j => j.id),
    });

    /* ---------- 22.1 Store.addJobs：整批只落一次盘、只广播一次 ---------- */
    const fireN = { n: 0 };
    Store.subscribe(() => { fireN.n++; });

    const batchA = [];
    for (let i = 0; i < 7; i++) batchA.push(mkRaw(i));
    batchA.push(mkRaw(0));                 // 同批内再来一条同键的 → 也必须被认出去重

    const beforeAll = Store.jobs().length;
    fireN.n = 0;
    const rB = Store.addJobs(batchA);
    ok('addJobs 返回 {added, dup, ids}',
      !!rB && typeof rB.added === 'number' && typeof rB.dup === 'number' && Array.isArray(rB.ids),
      JSON.stringify(rB && { added: rB.added, dup: rB.dup }));
    eq('8 条 = 7 新增 + 1 条批内去重（索引边加边更新）', [rB.added, rB.dup], [7, 1]);
    eq('岗位库真的多了 7 条', Store.jobs().length, beforeAll + 7);
    ok('⛔ 整批只广播一次 —— 这正是"导入卡住"的根因（逐条 addJob 会广播 8 次）',
      fireN.n === 1, '实际广播 ' + fireN.n + ' 次');

    const rB2 = Store.addJobs([mkRaw(0, { rawJD: '二次导入补上的 JD 文本' })]);
    eq('同键再导 → 走合并（dup=1、不新增）', [rB2.added, rB2.dup], [0, 1]);
    ok('合并把空字段补上了（rawJD 不再是空的）',
      (Store.jobs().filter(j => j.company === '批量公司0')[0] || {}).rawJD === '二次导入补上的 JD 文本');

    /* ⛔ 语义必须与逐条 addJob 一致 —— 否则「导入本次新增」和「导入全部」会给出不同结果 */
    const listX = [mkRaw(90), mkRaw(91), mkRaw(90)];
    const oneByOne = [0, 0];
    listX.forEach(raw => { const r = Store.addJob(raw); if (r.dup) oneByOne[1]++; else oneByOne[0]++; });
    dropBatch();
    const rX = Store.addJobs(listX);
    eq('addJobs 与逐条 addJob 的 (新增/重复) 计数一致', [rX.added, rX.dup], oneByOne);
    dropBatch();

    const rF = Store.addJobs([mkRaw(0)], { forceNew: true });
    eq('forceNew:true → 同键也当新增（闸门用得上）', [rF.added, rF.dup], [1, 0]);
    dropBatch();

    /* ---------- 22.2 条数：落盘 + 「本地优先」而不是「服务端回声优先」 ---------- */
    ok('落盘清单含 count（不补这一条 → 新会话必回落）',
      VC._formSaveFields.indexOf('count') >= 0, VC._formSaveFields.join(','));
    ok('清单也含 degree / experience / scale / stage / jobType / keywords / salary',
      ['degree', 'experience', 'scale', 'stage', 'jobType', 'keywords', 'salary']
        .every(k => VC._formSaveFields.indexOf(k) >= 0), VC._formSaveFields.join(','));
    ok('⛔ 本地优先清单**不含** city / district / bizArea —— 那三项要能**自动跟着偏好变**，' +
       '一旦本地优先，「改偏好 → 采集页跟着变」立刻失灵（第 21 轮刚修好）',
      ['city', 'district', 'bizArea'].every(k => VC._localFirstFields.indexOf(k) < 0),
      VC._localFirstFields.join(','));

    const stubAll = (params) => (url) => {
      const p = String(url).replace(/^https?:\/\/[^/]+/, '');
      let body = { ok: true };
      if (p.indexOf('/api/ping') === 0) body = Object.assign({}, fakePing, { params: params });
      else if (p.indexOf('/api/jobs') === 0) body = { ok: true, source: '（测试）', jobs: [], total: 0 };
      else if (p.indexOf('/api/task') === 0) body = { ok: true, task: null };
      else if (p.indexOf('/api/estimate') === 0) body = { ok: true, estimate: null };
      return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(JSON.stringify(body)) });
    };
    const SRV = { city: '杭州', keywords: ['运营'], count: 50, source: '（测试）' };
    const enterCollect = (run) => withFetch(stubAll(SRV), async () => {
      App.go('collect');
      for (let i = 0; i < 6; i++) await tick();
      return await run();
    });

    /* 用户改过条数（存 20），服务端那份还是 50 → 刷新后必须是 20 */
    localStorage.setItem(savedKey, JSON.stringify({ count: '20' }));
    S3.form = null;
    await enterCollect(async () => {});
    ok('⛔ 用户存过的条数优先于服务端的旧值（改 20 → 刷新后还是 20，不回落到 50）',
      S3.form && S3.form.count === 20, '实际 ' + (S3.form && S3.form.count));

    /* 反向断言：本地从没存过 → 必须用服务端的值（别把"本地优先"做成"本地独裁"） */
    localStorage.setItem(savedKey, JSON.stringify({}));
    S3.form = null;
    await enterCollect(async () => {});
    ok('本地没存过时用服务端的 count（本地优先 ≠ 忽略服务端）',
      S3.form && S3.form.count === 50, '实际 ' + (S3.form && S3.form.count));

    /* 反向断言：city 依旧服务端/偏好优先 —— 不能顺手把它也变成本地优先 */
    localStorage.setItem(savedKey, JSON.stringify({ city: '上海' }));
    S3.form = null;
    await enterCollect(async () => {});
    ok('⛔ city 不走本地优先：服务端说杭州就是杭州（存过"上海"也不采纳）',
      S3.form && S3.form.city === '杭州', '实际 ' + (S3.form && S3.form.city));

    /* ---------- 22.3 条数的即时反馈（纯本地算，不依赖采集器/城市） ---------- */
    localStorage.removeItem(VC._paramOpenKey);
    S3.form = null; S3.paramOpen = null;
    await enterCollect(async () => {
      /* --- 折叠：22.5 --- */
      const head0 = U.$$('#view header.foldhead')[0];
      ok('采集参数卡的标题行是折叠开关（header.foldhead）', !!head0,
        U.$$('#view .card > header').map(h => (h.textContent || '').slice(0, 8)).join(' | '));
      const cardEl = head0 && head0.parentNode;
      ok('默认展开（第一次进来不该把参数藏起来）',
        S3.paramOpen === true && !cardEl.classList.contains('collapsed'));
      head0.click();
      await tick();
      ok('点标题行 → 收起：卡片带 collapsed', S3.paramOpen === false &&
        cardEl.classList.contains('collapsed'));
      ok('收起后仍有一行摘要（否则每次都得展开确认，等于没折叠）',
        (cardEl.querySelector('.psum') || {}).textContent.length > 0,
        JSON.stringify((cardEl.querySelector('.psum') || {}).textContent));
      ok('折叠状态落盘（刷新不弹回）', localStorage.getItem(VC._paramOpenKey) === '0',
        String(localStorage.getItem(VC._paramOpenKey)));
      App.go('collect');
      await tick();
      const head1 = U.$$('#view header.foldhead')[0];
      ok('重画后保持收起（否则"切个页回来又摊开"）',
        S3.paramOpen === false && head1.parentNode.classList.contains('collapsed'));
      ok('三角方向跟着变（收起 ▸ / 展开 ▾）',
        (head1.querySelector('.chev') || {}).textContent === '▸',
        (head1.querySelector('.chev') || {}).textContent);
      head1.click();                       // 展开，方便下面验条数
      await tick();
      ok('再点一下又展开（可来回切）', S3.paramOpen === true &&
        !head1.parentNode.classList.contains('collapsed'));

      /* --- 条数即时反馈 --- */
      S3.form.count = 20;
      S3.form.keywords = '';
      S3.form.expectJobs = ['运营', '产品经理'];
      const cntInput = ctlIn('每个关键词抓多少条', 'input');
      ok('找得到「每个关键词抓多少条」输入框', !!cntInput);
      cntInput.value = '20';
      fireInput(cntInput);
      await tick();
      const h1 = (fldOf('每个关键词抓多少条') || {}).textContent || '';
      ok('改条数 → 提示里**立刻**出现算好的总条数（2 个关键词 × 20 = 40）',
        h1.indexOf('2 个关键词') >= 0 && h1.indexOf('40') >= 0, h1.slice(0, 96));
      cntInput.value = '5';
      fireInput(cntInput);
      await tick();
      const h2 = (fldOf('每个关键词抓多少条') || {}).textContent || '';
      ok('再改成 5 → 总条数跟着变 10（控件真的"活着"，不是摆设）',
        h2.indexOf('10') >= 0 && h2.indexOf('40') < 0, h2.slice(0, 96));
      ok('⛔ 这条提示是纯本地算的（文案里没有"预计"，不依赖采集器也不依赖城市）',
        h2.indexOf('预计') < 0);
      return null;
    });

    /* ---------- 22.4 导入：异步 + 分批让出主线程 + 进度 + 防连点 + 失败不静默 ---------- */
    S3.result = { jobs: [{ title: 'x' }] };       // 过 importResult 的前置检查
    S3.importing = false;
    clearToasts();

    const big = [];
    for (let i = 0; i < CH * 2 + 5; i++) big.push(mkRaw(1000 + i));
    const jobsBefore = Store.jobs().length;
    const pr = VC._import(null, { list: big });
    ok('导入接口返回 thenable（异步 —— 调用方只能 await，不能当同步函数用）',
      !!pr && typeof pr.then === 'function');
    ok('调用返回时**还没写库**（说明没在一个同步任务里把活干完）',
      Store.jobs().length === jobsBefore, String(Store.jobs().length - jobsBefore));
    await tick();
    const midN = Store.jobs().length - jobsBefore;
    ok('⛔ 中途已经落了一部分（0 < ' + midN + ' < ' + big.length + '）—— 这才叫"分批 + 让出主线程"；' +
       '一次跑完的实现这里只会是 0 或者全部',
      midN > 0 && midN < big.length, 'mid=' + midN + ' / ' + big.length);
    await pr;
    eq('await 之后全部到位', Store.jobs().length - jobsBefore, big.length);
    const toastTxt = U.$$('#toasts .toast').map(t => t.textContent || '').join(' | ');
    ok('提示是一句人话（不只是一个数字），且说的是「导入完成」',
      toastTxt.indexOf('导入完成') >= 0, toastTxt.slice(0, 60));
    /* ⛔ 只查「出现过『导入完成』『新增』」是**弱断言**：把新增数算成 0、提示照样是
       「导入完成：新增 0 个岗位」，两个子串都在 → 改坏了也通过。
       断言名字里写了"带数量"，就必须真把数字抠出来跟实际导入数对上。 */
    const mAdded = /新增\s*(\d+)\s*个/.exec(toastTxt);
    eq('⛔ 提示里的**新增数 == 实际导入数**（数字算错也变红，不只是看措辞）',
      mAdded ? Number(mAdded[1]) : null, big.length);
    ok('跑完把运行中的进度文案清掉了（按钮回到原样）',
      U.$$('#view button').every(b => (b.textContent || '').indexOf('导入中') < 0));
    dropBatch();

    /* 连点两下：第二条流水线必须被挡住 */
    S3.importing = false;
    const g1 = [];
    for (let i = 0; i < CH * 2; i++) g1.push(mkRaw(3000 + i));
    const pG = VC._import(null, { list: g1 });
    await tick();
    ok('导入进行中 S.importing 为 true（按钮同时也是 disabled）',
      S3.importing === true);
    const before2 = Store.jobs().length;
    await VC._import(null, { list: [mkRaw(9999)] });
    eq('⛔ 连点第二下被挡住（否则两条流水线同时写、计数翻倍）',
      Store.jobs().length, before2);
    await pG;
    ok('第一轮跑完 importing 归位', S3.importing === false);
    dropBatch();

    /* 失败路径：绝不能同步抛（onclick 里没人 .catch → 同步抛 = 静默失败） */
    S3.importing = false;
    clearToasts();
    const origAddJobs = Store.addJobs;
    let threwSync = false, pf = null;
    Store.addJobs = function () { throw new Error('模拟落盘炸了'); };
    try { pf = VC._import(null, { list: [mkRaw(4000)] }); } catch (e) { threwSync = true; }
    ok('⛔ 导入内部抛错时**不同步抛**（同步抛会变成用户眼里的"点了没反应"）', !threwSync);
    let rf = undefined;
    try { rf = await pf; } catch (e) { rf = 'rejected:' + e.message; }
    /* ⚠️ 必须等 await 之后再还原：doImport 跑在微任务里，
       同步就还原的话「抛错」这一步根本不会发生，测试会绿得毫无意义。 */
    Store.addJobs = origAddJobs;
    ok('错误被转成 catch 分支：返回 null + 弹红 toast + 状态复位',
      rf === null && S3.importing === false &&
      U.$$('#toasts .toast').some(t => (t.textContent || '').indexOf('导入失败') >= 0),
      'returns=' + JSON.stringify(rf) + ' importing=' + S3.importing);

    /* 还原这一段改过的持久化状态，别污染后面的断言 */
    if (keepSaved === null) localStorage.removeItem(savedKey);
    else localStorage.setItem(savedKey, keepSaved);
    if (keepOpen === null) localStorage.removeItem(VC._paramOpenKey);
    else localStorage.setItem(VC._paramOpenKey, keepOpen);
    U.closeAllModals();
    clearToasts();
  }

  /* ==================================================================
     【20】启动器 / 采集器服务 · 结构断言（第 15 轮 · 复核修复）
     —— 这几个 .vbs / .cmd / server.py 的坑，跑前端单测永远碰不到，
        但正是它们让「双击 25 次 / 弹了已停止其实还在跑 / 403 只回 2 字节」
        一路活到今天。所以这里直接对**源文件内容**做断言。
        （_回退自证.js 里每一条都有对应的「改坏」变异，保证真能抓到。）
     ================================================================== */
  {
    const readText = rel => fs.readFileSync(path.join(DIR, rel), 'utf8');
    const readVbs = rel => {
      const buf = fs.readFileSync(path.join(DIR, rel));
      return { buf: buf, text: buf.toString('utf16le') };
    };
    // 注释里会提到这些词（比如"删掉 pythonw 兜底"），断言"不存在"前必须先把注释剥掉
    const stripVbs = t => t.split(/\r?\n/).filter(l => !/^\s*'/.test(l)).join('\n');
    const stripCmd = t => t.split(/\r?\n/).filter(l => !/^\s*REM\b/i.test(l)).join('\n');
    const stripPy = t => t.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');

    const srvRaw = readText('采集器/server.py');
    const srv = stripPy(srvRaw);
    const vbsStop = readVbs('后台停止采集器.vbs');
    const vbsStart = readVbs('后台启动采集器.vbs');
    const stopCode = stripVbs(vbsStop.text);
    const startCode = stripVbs(vbsStart.text);
    const cmdCode = stripCmd(readText('启动采集器.cmd'));

    /* --- 20.1 §四：pick_port 不能拿 SO_REUSEADDR 当"端口空闲" --- */
    ok('server.py 不再调 setsockopt（Windows 上 SO_REUSEADDR = 抢占正在监听的端口）',
      srv.indexOf('setsockopt') < 0);
    ok('server.py 改用 connect 试连判断端口占用（port_busy）',
      /def port_busy\(/.test(srv) && /connect_ex\(/.test(srv));
    ok('服务类关掉 allow_reuse_address（否则绑被占端口也会"成功"，变成沉默僵尸）',
      /allow_reuse_address\s*=\s*False/.test(srv));

    /* --- 20.2 §二：_send 必须能接 dict，否则 403 体被截成 2 字节 --- */
    ok('_send 把非 str/bytes 的 body 转成 JSON（dict 不再触发 TypeError + Content-Length=2）',
      /isinstance\(body,\s*\(str,\s*bytes/.test(srv));
    ok('_json 与 _send 走同一入口（响应体只有一条编码路径）',
      /def _json\(self[\s\S]{0,160}?self\._send\(/.test(srv));

    /* --- 20.3 §三：PID 文件写"根进程"（venv shim），停止才能 /T 全收 --- */
    ok('server.py 有 root_pid()（Windows 上 venv 的 python.exe 是 shim，一个服务两个进程）',
      /def root_pid\(/.test(srv));
    ok('PID 文件写的是 ROOT_PID 而不是 os.getpid()',
      /f\.write\(str\(ROOT_PID\s+or\s+os\.getpid\(\)\)\)/.test(srv));

    /* --- 20.4 §一：停止脚本的兜底不能有 ForEach-Object 里的 exit 0 --- */
    // PowerShell 里 ForEach-Object 内的 exit 会终止整条管道 → 只杀第一个、exit 2 永不执行
    ok('停止脚本没有「ForEach-Object { …; exit 0 }」（那会终止整条管道 → 只杀第一个）',
      !/ForEach-Object\s*\{[^}]*exit\s+0/.test(stopCode));
    ok('停止脚本用 taskkill /F /T 连子树一起停（Stop-Process 不带 /T 会留下父 shim）',
      /taskkill\.exe\s+\/F\s+\/T\s+\/PID/.test(stopCode));
    /* ⛔ 上面那条是**弱断言**（评审复核时发现，并已确认是假绿）：
       停止脚本里有**两处** taskkill —— 第一处按 collector.pid（`$rootPid`）、
       第二处按进程树兜底（`([int]$r.ProcessId)`）。只判「出现过一次 /F /T /PID」的话，
       把**第二处**的 /T 去掉，第一处照样满足正则 → 断言不红。
       所以要判「**每一处** taskkill 都带 /T」。
       （之前这条只靠"锚点失配"兜底 → 改成真正能抓住变异的功能断言。） */
    const tkCalls = stopCode.match(/taskkill\.exe[^\r\n]*/g) || [];
    ok('⛔ 停止脚本里**每一处** taskkill 都带 /T（少一处就会留下父 shim → "改了没反应"）',
      tkCalls.length >= 2 && tkCalls.every(function (s) { return /\/F\b/.test(s) && /\/T\b/.test(s); }),
      '共 ' + tkCalls.length + ' 处：' + tkCalls.join(' | '));
    ok('停止脚本杀完复验端口（TcpClient 试连），判据是"端口空没空"而不是"杀了几个"',
      /TcpClient/.test(stopCode));
    /* 评审 P1-3.4：优先读 collector.pid（server.py 已写根 PID）精确停，不再只靠命令行
       `*server.py*` 字符串匹配 —— 那会误杀同机其他项目的 server.py（本机就有旧线
       「求职/工作台/server.py」）。 */
    ok('停止脚本优先读 collector.pid（根 PID 精确停，不误杀别的 server.py）',
      /\$pidFile=Join-Path \$d 'collector\.pid'/.test(stopCode));
    ok('停止脚本用 -File 跑临时 ps1（长脚本不进 -Command 串，免得被二次展开）',
      /-File/.test(stopCode) && /\.ps1/.test(stopCode));

    /* --- 20.5 §五：启动脚本必须定编码 + 失败原因读结构化文件 --- */
    ok('启动脚本设了 PYTHONIOENCODING（否则 GBK 写日志，一个 ✅ 就把启动炸掉）',
      /PYTHONIOENCODING/.test(startCode));
    ok('启动脚本设了 PYTHONUTF8', /PYTHONUTF8/.test(startCode));
    ok('启动脚本读 status.json 拿失败原因（这个文件就是为此设计的）',
      /StatusError\(statusFile\)/.test(startCode));
    ok('启动脚本也读 server.log（log() 显式 utf-8，与代码页无关）',
      /TailText\(logFile/.test(startCode));
    ok('启动脚本按 utf-8 读文件（ADODB.Stream），不是 OpenTextFile 的 ACP',
      /ADODB\.Stream/.test(startCode));

    /* --- 20.6 §六.2 / §六.3：删掉冗余的 pythonw 兜底与 CHROME_PATH --- */
    ok('启动脚本不再退到 pythonw.exe（缺 venv 就明确报"环境不完整"）',
      startCode.indexOf('pythonw') < 0);
    ok('启动脚本不再自己设 CHROME_PATH（交给 server.py 的 subprocess_env）',
      startCode.indexOf('CHROME_PATH') < 0);
    ok('cmd 启动器也不设 CHROME_PATH，且缺 venv 时报错而不是退到 PATH 上的 python',
      cmdCode.indexOf('CHROME_PATH') < 0 && /virtualenv not found/.test(cmdCode));

    /* --- 20.7 §六.1：端口列表单一来源（四处必须一致，改一处要改全） --- */
    const nums = s => (String(s).match(/\d+/g) || []).join(',');
    const portsPy = (srvRaw.match(/PORT_CANDIDATES\s*=\s*\[([^\]]*)\]/) || [])[1];
    ok('server.py 的 PORT_CANDIDATES = 8738,8739,8740', nums(portsPy) === '8738,8739,8740');
    const portsStart = (vbsStart.text.match(/Array\(([\d,\s]+)\)/) || [])[1];
    ok('启动 VBS 的探活端口与 server.py 一致', nums(portsStart) === nums(portsPy));
    const portsStop = (vbsStop.text.match(/foreach\s*\(\$p\s+in\s+([\d,]+)\s*\)/) || [])[1];
    ok('停止 VBS 的复验端口与 server.py 一致', nums(portsStop) === nums(portsPy));
    const portsCmd = (cmdCode.match(/set\s+"PORTS=([\d\s]+)"/) || [])[1];
    ok('cmd 的探活端口与 server.py 一致', nums(portsCmd) === nums(portsPy));

    /* --- 20.8 编码：两个 VBS 必须 UTF-16LE+BOM；cmd 必须纯 ASCII --- */
    ok('后台停止采集器.vbs 是 UTF-16LE + BOM（否则 wscript 读中文乱码、匹配不上进程）',
      vbsStop.buf[0] === 0xFF && vbsStop.buf[1] === 0xFE);
    ok('后台启动采集器.vbs 是 UTF-16LE + BOM',
      vbsStart.buf[0] === 0xFF && vbsStart.buf[1] === 0xFE);
    ok('启动采集器.cmd 保持纯 ASCII（中文写进 .cmd 会被 GBK 控制台弄乱）',
      fs.readFileSync(path.join(DIR, '启动采集器.cmd')).every(b => b < 128));
  }

  /* ==================================================================
     【32】P0 令牌泄露防线 + P1-1 默认转义（评审核实 2026-10-12）
     —— `Origin: null` 是所有「不透明来源」文档的统称（沙箱 iframe / file:// / data:）。
        它曾在 CORS 白名单里，而静态页对**任何来源**都注入令牌 ⇒ 任何网页都能读到
        带令牌的 HTML，再带 X-JH-Token 调全部 /api/*（含会真实发消息的 /api/apply-one）。
     ⛔ 源码与打包孪生（server_core.py）**必须同时**被钉住：只修一份 = 用户那份没修
        （便携版的前端与服务端都打包进 exe）。所以两份各断言一遍。
     ================================================================== */
  {
    ok('【32】打包工程目录已解析（否则孪生那份会被静默跳过 = 假绿）', !!PACK_DIR, String(PACK_DIR));
    const twins32 = [
      ['采集器/server.py', fs.readFileSync(path.join(DIR, '采集器', 'server.py'), 'utf8')],
      ['_打包工程/src/server_core.py', fs.readFileSync(path.join(PACK_DIR, 'src', 'server_core.py'), 'utf8')],
    ];
    twins32.forEach(function (pair) {
      const rel = pair[0], src = pair[1];
      const m = src.match(/ALLOWED_ORIGINS\s*=\s*set\(\[([\s\S]*?)\]\)/);
      ok('【32】' + rel + ' 的 Origin 白名单**不含** null（含了 = 任何网页都能读到带令牌的 HTML）',
        !!m && m[1].indexOf("'null'") < 0 && m[1].indexOf('"null"') < 0,
        m ? m[1].trim() : '未找到 ALLOWED_ORIGINS');
      ok('【32】' + rel + ' 有 _is_same_origin()（令牌只注入同源页面）',
        /def _is_same_origin\(self\)/.test(src) &&
        /return \(not origin\) or \(origin in ALLOWED_ORIGINS\)/.test(src));
      ok('【32】' + rel + ' 的静态页注入令牌前先判同源',
        /if ext in \('\.html', '\.htm'\) and self\._is_same_origin\(\):/.test(src));
      ok('【32】' + rel + ' 不再无条件 inject_token（旧写法必须消失）',
        !/if ext in \('\.html', '\.htm'\):\n\s+data = inject_token\(data\)/.test(src));
    });

    /* --- P1-1：toast / 弹窗标题默认转义（行为断言，比"源码里出现过某字符串"硬） --- */
    const tbox32 = U.$('#toasts');
    if (tbox32) tbox32.innerHTML = '';
    const tn32 = U.toast('<img src=x onerror="window.__pwn=1">hi<b>粗</b>', 'info');
    const tAll32 = U.$$('#toasts .toast .flex1');
    const tEsc32 = tAll32[tAll32.length - 1];
    ok('【32】U.toast 默认转义：第三方数据里的标签不会变成真元素',
      !!tEsc32 && tEsc32.innerHTML.indexOf('<img') < 0 && /&lt;img/.test(tEsc32.innerHTML),
      tEsc32 ? tEsc32.innerHTML.slice(0, 90) : '没找到 toast 节点');
    const th32 = U.toastHtml('<b>粗</b>', 'info');
    const tAll32b = U.$$('#toasts .toast .flex1');
    const tHtml32 = tAll32b[tAll32b.length - 1];
    ok('【32】U.toastHtml 仍按 HTML 渲染（需要加粗时有出口）',
      !!tHtml32 && tHtml32.innerHTML.indexOf('<b>') >= 0, tHtml32 ? tHtml32.innerHTML : '无');
    /* 收掉这两条（否则 3 秒的自动消失定时器会把进程多挂一会儿） */
    [tn32, th32].forEach(function (n) { if (n && n._kill) n._kill(); });
    if (tbox32) tbox32.innerHTML = '';

    U.openModal({ title: '<img src=x onerror="window.__pwn=2">', body: 'x' });
    const h3_32 = U.$('.mask .modal h3');
    ok('【32】弹窗标题默认转义（岗位名 / 公司名 / 简历名不会变成 HTML）',
      !!h3_32 && h3_32.innerHTML.indexOf('<img') < 0 && /&lt;img/.test(h3_32.innerHTML),
      h3_32 ? h3_32.innerHTML.slice(0, 90) : '没找到 h3');
    U.closeAllModals(true);
  }

  /* ==================================================================
     【21】桌面快速启动 · favicon.ico + 创建桌面快捷方式.vbs（第 16 轮）
     —— 快捷方式一旦建错（目标写错、图标丢了、跑第二遍叠两个），
        用户看到的就是"双击没反应"。所以这里对**产物 + 生成脚本**直接断言。
        （_回退自证.js 里每条都有对应变异。）
     ================================================================== */
  {
    const readText21 = rel => fs.readFileSync(path.join(DIR, rel), 'utf8');
    const readVbs21 = rel => {
      const buf = fs.readFileSync(path.join(DIR, rel));
      return { buf: buf, text: buf.toString('utf16le') };
    };
    const stripVbs21 = t => t.split(/\r?\n/).filter(l => !/^\s*'/.test(l)).join('\n');

    /* --- 21.1 favicon.ico 的结构（Windows 靠这几项决定认不认） --- */
    const icoPath = path.join(DIR, 'favicon.ico');
    ok('favicon.ico 存在（快捷方式图标靠它）', fs.existsSync(icoPath));
    const ico = fs.readFileSync(icoPath);
    ok('favicon.ico 头部合法：reserved=0、type=1(图标)',
      ico.readUInt16LE(0) === 0 && ico.readUInt16LE(2) === 1);
    const icoCount = ico.readUInt16LE(4);
    ok('favicon.ico 打包了 7 个尺寸', icoCount === 7);

    const dirW = (i) => ico.readUInt8(6 + i * 16) || 256;   // 0 表示 256
    const sizes = [];
    for (let i = 0; i < icoCount; i++) sizes.push(dirW(i) + 'x' + dirW(i));
    ok('favicon.ico 尺寸齐全 16/24/32/48/64/128/256（任务栏/桌面/列表各取所需）',
      sizes.join(',') === '16x16,24x24,32x32,48x48,64x64,128x128,256x256');

    let allPng = true;
    for (let i = 0; i < icoCount; i++) {
      const dataOff = ico.readUInt32LE(6 + i * 16 + 12);
      if (ico.slice(dataOff, dataOff + 8).toString('hex') !== '89504e470d0a1a0a') allPng = false;
    }
    ok('favicon.ico 每个条目都是 PNG 压缩（Vista+ 才认，16 位 BMP 更麻烦）', allPng);

    // 最大的那张（第 7 个）PNG 头里的宽高必须真是 256
    const bigOff = ico.readUInt32LE(6 + 6 * 16 + 12);
    ok('favicon.ico 的 256 条目确实是 256×256 的 PNG（不是被撑大的小图）',
      ico.slice(bigOff + 12, bigOff + 16).toString('ascii') === 'IHDR' &&
      ico.readUInt32BE(bigOff + 16) === 256 && ico.readUInt32BE(bigOff + 20) === 256);

    const genPy = readText21('_生成图标.py');
    ok('_生成图标.py 用与 index.html 同款的蓝底 #1d4ed8（图标和网页 logo 是一个色）',
      /#1d4ed8/.test(genPy) && /29,\s*78,\s*216/.test(genPy));
    // 生成器与产物必须同步：不然"改了生成器忘了重跑"，图标还是旧的，谁也发现不了
    const pySizes = (genPy.match(/SIZES\s*=\s*\[([\d,\s]+)\]/) || [])[1];
    ok('_生成图标.py 声明的 SIZES 与 favicon.ico 实际打包的尺寸一致（改了生成器必须重跑图标）',
      !!pySizes && pySizes.split(',').map(s => s.trim() + 'x' + s.trim()).join(',') === sizes.join(','));

    /* --- 21.2 创建桌面快捷方式.vbs（生成器本体） --- */
    const vbsMk = readVbs21('创建桌面快捷方式.vbs');
    const mk = stripVbs21(vbsMk.text);
    ok('创建桌面快捷方式.vbs 是 UTF-16LE + BOM（里面全是中文名，ANSI 会乱码）',
      vbsMk.buf[0] === 0xFF && vbsMk.buf[1] === 0xFE);
    ok('用 WScript.Shell 的 CreateShortcut 建（Windows 原生能力，零依赖）',
      /CreateShortcut\(/.test(mk));
    ok('桌面路径取 SpecialFolders("Desktop")，不写死 %USERPROFILE%\\Desktop（兼容 OneDrive 重定向）',
      /SpecialFolders\("Desktop"\)/.test(mk) && mk.indexOf('USERPROFILE') < 0);
    ok('目标显式指向 %SystemRoot%\\System32\\wscript.exe（不赌 .vbs 的文件关联）',
      /TargetPath\s*=\s*wscriptExe/.test(mk) && /ExpandEnvironmentStrings\(.*wscript\.exe/.test(mk));
    ok('参数是引号包住的 .vbs 绝对路径（路径带空格也照跑）',
      /Arguments\s*=\s*"{4}\s*&/.test(mk));
    ok('工作目录设成本目录', /WorkingDirectory\s*=\s*base/.test(mk));
    ok('图标指向本目录 favicon.ico', /BuildPath\(base,\s*"favicon\.ico"\)/.test(mk));
    ok('IconLocation 真的用上图标（没图标时不设，退回系统默认）',
      /If\s+iconPath\s+<>\s+""\s+Then\s+\w+\.IconLocation/.test(mk));
    ok('建之前先删同名旧快捷方式（跑几遍都不重复、不叠加）',
      /DeleteFile\s+lnkPath/.test(mk));
    ok('建完自检文件是否真落盘，没落盘就报错（不假装成功）',
      /If\s+Not\s+fso\.FileExists\(lnkPath\)/.test(mk));

    /* --- 21.3 指向的两个脚本必须真存在，名字不能打错 --- */
    ok('快捷方式名是「求职猎手工作台」与「停止采集器」',
      /MakeLink\s+"求职猎手工作台"/.test(mk) && /MakeLink\s+"停止采集器"/.test(mk));
    ok('指向 后台启动采集器.vbs 与 后台停止采集器.vbs（按文件名找，不写死绝对路径）',
      /FindIn\(base,\s*"后台启动采集器\.vbs"\)/.test(mk) &&
      /FindIn\(base,\s*"后台停止采集器\.vbs"\)/.test(mk));
    ok('被指向的两个脚本确实躺在仓库里',
      fs.existsSync(path.join(DIR, '后台启动采集器.vbs')) &&
      fs.existsSync(path.join(DIR, '后台停止采集器.vbs')));

    /* --- 21.4 纯 COM，不引 PowerShell；静默模式与结果文件 --- */
    ok('生成器不引 PowerShell（纯 VBS/COM，少一层会坏的东西）',
      mk.toLowerCase().indexOf('powershell') < 0);
    // 判"真的读了变量并拿它挡弹窗"，不是判"文件里出现过 JH_QUIET 这个词"
    // （失焦写法：只在注释/Fail 里出现 JH_QUIET 也能骗过弱断言）
    ok('JH_QUIET 静默模式真的生效：读进 quiet 变量，且用它挡住弹窗',
      /quiet\s*=\s*\(shell\.Environment\("Process"\)\("JH_QUIET"\)\s*=\s*"1"\)/.test(mk) &&
      /If\s+Not\s+quiet\s+Then/.test(mk));
    ok('结果写 shortcut-result.txt（可被脚本核对建了几个）',
      /shortcut-result\.txt/.test(mk));
  }

  /* ==================================================================
     【24】第 24 轮：简历素材库「上传 PDF / Word」（不再让用户复制粘贴）
     —— 用户原话：「这个地方应该可以上传其他文件（pdf，word等等），
        而不是去复制粘贴」。以前只认 .txt/.md，PDF / Word 只能让用户
        自己在别的软件里 Ctrl+A → Ctrl+C。
        这条链横跨四处：前端选文件 → /api/extract-text 路由 → skill stage 抽取
        → entry.py 子命令分发。任一处漏了，用户看到的就是"选了文件没反应"。
        ⛔ 逐条对**断言名承诺的值**比 —— 只判"文件里出现过某串"会被注释骗过。
     ================================================================== */
  {
    const rd24 = rel => fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(DIR, rel), 'utf8');
    /* 便携版的孪生服务端在 `_打包工程/` 下 —— 它是 `求职猎手工作台/` 的**兄弟目录**，
       不在工作台目录里。所以先解析打包工程根；找不到就明确报红，不静默跳过
       （静默跳过 = 两份服务端漂移了也没人知道）。 */
    const PACK = PACK_DIR;
    ok('能找到「打包工程」目录（便携版孪生服务端所在，用于验两份同步）',
      !!PACK, PACK || '都试过（JH_PACK_DIR / ./_打包工程 / ../_打包工程 / D:/AIshuju/BOSS/_打包工程）');

    const devPy = rd24('采集器/server.py');
    const vr = rd24('js/view-resume.js');
    const corePy = PACK ? rd24(path.join(PACK, 'src', 'server_core.py')) : '';
    const entryPy = PACK ? rd24(path.join(PACK, 'crawler_src', 'entry.py')) : '';
    const stagePath = 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts/stages/extract_resume_text.py';
    const stagePy = fs.readFileSync(stagePath, 'utf8');

    /* ---- 24.1 前端：accept 真含 PDF / Word（值比对，不是"出现过"）---- */
    const accRaw = (vr.match(/var RESUME_ACCEPT\s*=\s*'([^']*)'/) || [])[1] || '';
    const acc = accRaw.split(',').map(s => s.trim()).filter(Boolean);
    ok('前端 RESUME_ACCEPT 含 .pdf 与 .docx（用户能直接选到 PDF / Word）',
      acc.indexOf('.pdf') >= 0 && acc.indexOf('.docx') >= 0, accRaw);
    ok('前端选文件走 RESUME_ACCEPT（不是写死旧的 .txt/.md 过滤器）',
      /U\.pickFile\(RESUME_ACCEPT\)/.test(vr));
    ok('前端没有残留的旧过滤器（U.pickFile(\'.txt,.md…\') 已删）',
      !/U\.pickFile\(\s*'\.txt,\.md/.test(vr));

    /* ---- 24.2 前端分工：txt/md 本地读 · pdf/docx 走服务端 · .doc 明确拦下 ---- */
    ok('前端 .txt/.md 走本地 U.readText（离线可用，不必先开采集器）',
      /TEXT_EXTS\.indexOf\(ext\)\s*>=\s*0[\s\S]{0,90}U\.readText\(f\)/.test(vr));
    ok('前端 .doc（旧版二进制）明确拦下，并提示「另存为 .docx」',
      /ext === '\.doc'[\s\S]{0,150}另存为/.test(vr));
    ok('前端 PDF / Word 走 /api/extract-text（不是 /api/resume —— 那个会起任务调模型）',
      /collectorReq\('\/api\/extract-text'/.test(vr));
    ok('前端整份文件里不出现 /api/resume（素材库不该把简历塞进采集链路）',
      vr.indexOf('/api/resume') < 0);
    ok('前端发请求前先确保有 base（否则会拼出 "null/api/extract-text"）',
      /st\.base \? Promise\.resolve\(st\.base\) : VC\._detect\(\)/.test(vr));

    /* ---- 24.3 三处白名单必须一致（值比对，不是"都含 .pdf"这种弱判）---- */
    const listOf24 = (s, name) => {
      const m = s.match(new RegExp(name + '\\s*=\\s*\\(([^)]*)\\)')) ||
                s.match(new RegExp(name + '\\s*=\\s*\\[([^\\]]*)\\]'));
      if (!m) return null;
      return (m[1].match(/'[^']*'|"[^"]*"/g) || []).map(x => x.slice(1, -1)).sort();
    };
    const extSrv = listOf24(devPy, 'EXTRACT_EXTS');
    const extStage = listOf24(stagePy, 'OK_EXTS');
    if (PACK) {
      const extCore = listOf24(corePy, 'EXTRACT_EXTS');
      ok('两套服务端的 EXTRACT_EXTS 完全相同（孪生副本必须同步）',
        !!extSrv && !!extCore && extSrv.join(',') === extCore.join(','),
        'dev=[' + extSrv + '] / core=[' + extCore + ']');
    }
    ok('服务端白名单 == 前端 accept（少任何一个都是"前端选得到、服务端拒收"）',
      !!extSrv && extSrv.join(',') === acc.slice().sort().join(','),
      '前端=[' + acc.slice().sort().join(',') + '] / 服务端=[' + extSrv + ']');
    ok('stage 的 OK_EXTS 正好是服务端白名单去掉 .doc（python-docx 读不了旧版 .doc）',
      !!extStage && !!extSrv && extStage.join(',') === extSrv.filter(x => x !== '.doc').join(','),
      'stage=[' + extStage + ']');

    /* ---- 24.4 stage 的 MARK 必须与两套服务端认的前缀是同一个字符串 ---- */
    const markStage = (stagePy.match(/MARK = '([^']*)'/) || [])[1];
    const markDev = (devPy.match(/line\.startswith\('([^']*)'\)/) || [])[1];
    ok('stage 的 MARK == 开发版服务端认的前缀（两处是同一个字符串）',
      !!markStage && markStage === markDev, 'stage=' + markStage + ' dev=' + markDev);
    if (PACK) {
      const markCore = (corePy.match(/line\.startswith\('([^']*)'\)/) || [])[1];
      ok('stage 的 MARK == 便携版服务端认的前缀', !!markStage && markStage === markCore,
        'stage=' + markStage + ' core=' + markCore);
    }

    /* ---- 24.5 两套服务端：路由 + 只认前缀行 + 白名单 + 清理 + 上限 ---- */
    const srvPairs = [['dev', devPy]].concat(PACK ? [['core', corePy]] : []);
    srvPairs.forEach(function (pair) {
      const which = pair[0], s = pair[1];
      ok('[' + which + '] 有 POST /api/extract-text 路由 → self._extract_text()',
        /path == '\/api\/extract-text'[\s\S]{0,60}self\._extract_text\(\)/.test(s));
      ok('[' + which + '] 只认 __JH_TEXT__ 前缀行（混杂日志里找回结果）',
        /line\.startswith\('__JH_TEXT__'\)/.test(s) &&
        /json\.loads\(line\[len\('__JH_TEXT__'\):\]\)/.test(s));
      ok('[' + which + '] 落盘前过白名单（防止把任意字节写成任意扩展名）',
        /def extract_text\(raw, name\):[\s\S]{0,700}if ext not in EXTRACT_EXTS/.test(s));
      ok('[' + which + '] 抽完删临时文件（finally + os.remove）',
        /def extract_text\(raw, name\):[\s\S]{0,2800}finally:[\s\S]{0,90}os\.remove\(tmp\)/.test(s));
      ok('[' + which + '] 有 20MB 上限（前端也拦，但服务端才是真闸门）',
        /_read_body\(limit=20 \* 1024 \* 1024\)|len\(raw\) > 20 \* 1024 \* 1024/.test(s));
      ok('[' + which + '] 文件名走 base64 的 X-Filename 头，且经 basename + 净化',
        /base64\.b64decode\(self\.headers\.get\('X-Filename'\)/.test(s) &&
        /os\.path\.basename\(name/.test(s) &&
        /re\.sub\(r'\[<>:"\/\\\\\|\?\*\]', '_', name\)/.test(s));
    });

    /* ---- 24.6 孪生副本的 extract_text 函数体逐句一致（只有 cwd 写法刻意不同）---- */
    const bodyOf24 = (s) => {
      if (!s) return null;
      const m = s.match(/\ndef extract_text\(raw, name\):([\s\S]*?)(?=\n# =)/);
      if (!m) return null;
      return m[1].split(/\r?\n/).map(l => l.trim())
        .filter(l => l && !l.startsWith('#'))
        .join('\n')
        // 把两处**刻意不同**的写法归一：dev 是常量 SCRIPTS，core 是 (SCRIPTS or None)
        .replace(/\s*or\s+None/g, '')
        .replace(/cwd=\(SCRIPTS\)/g, 'cwd=SCRIPTS');
    };
    if (PACK) {
      const bDev = bodyOf24(devPy), bCore = bodyOf24(corePy);
      ok('dev 与 core 的 extract_text 函数体逐句一致（只 cwd=(SCRIPTS or None) 一处刻意不同）',
        !!bDev && !!bCore && bDev === bCore,
        bDev === null ? 'dev 没抠出函数体'
          : (bCore === null ? 'core 没抠出函数体'
            : 'dev 长度=' + bDev.length + ' core 长度=' + bCore.length));
    }

    /* ---- 24.7 stage：复用现成抽取器，不重复实现 ---- */
    ok('stage 复用 resume_matcher.parsers.parse_resume_file（抽取逻辑一行都不重写）',
      /from resume_matcher\.parsers import parse_resume_file/.test(stagePy) &&
      /parse_resume_file\(path\)/.test(stagePy));
    /* ⛔ 别用 indexOf('PyPDF2') 判 —— stage 的**docstring 里**就写着「PyPDF2 + python-docx」
       （说明抽取是谁干的）。判"有没有 import"才是结构断言，判"有没有出现过这串"会被注释骗过。 */
    const stageCode = stagePy.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
    ok('stage 自己不 import PyPDF2 / docx（抽取交给 parsers.py，不重复实现）',
      !/^\s*(?:import|from)\s+(?:PyPDF2|pypdf|docx)\b/m.test(stageCode) &&
      !/^\s*from\s+resume_matcher[\s\S]{0,60}\bimport\b[\s\S]{0,60}\b(PyPDF2|docx)\b/m.test(stageCode));
    ok('stage 抽不出文字时返回 ok:false 并提示扫描件需 OCR（不假装成功）',
      /if not text:[\s\S]{0,320}'ok': False[\s\S]{0,220}OCR/.test(stagePy));
    ok('stage 明确拦 .doc（不走 OK_EXTS 分支）', /ext == '\.doc'/.test(stagePy));
    ok('extract_resume_text.py 真躺在 skill 的 scripts/stages/ 下（构建时全量收 scripts/）',
      fs.existsSync(stagePath));

    /* ---- 24.8 便携版分发：entry.py 认新子命令 + PORTABLE_SUBCMD 有映射 ---- */
    if (PACK) {
      ok('entry.py ROUTES 注册 extract_text → stages/extract_resume_text.py',
        /'extract_text':\s*'stages\/extract_resume_text\.py'/.test(entryPy));
      ok('entry.py 同时认连字符写法 extract-text',
        /'extract-text':\s*'stages\/extract_resume_text\.py'/.test(entryPy));
      const helpList = (entryPy.match(/for k in \(([\s\S]*?)\):/) || [])[1] || '';
      ok('entry.py 帮助列表里真的列了 extract_text（否则 --help 与实际能力不符）',
        /'extract_text'/.test(helpList), helpList.replace(/\s+/g, ' ').trim());
      ok('便携版服务端 PORTABLE_SUBCMD 有 extract_resume_text.py → extract_text 映射',
        /'extract_resume_text\.py':\s*'extract_text'/.test(corePy));
      ok('便携版 build_cmd_extract 走 script_cmd(…) 显式子命令（不是拼出空子命令）',
        /def build_cmd_extract\(path\):[\s\S]{0,400}script_cmd\([\s\S]{0,140}'extract_text'\)/.test(corePy));
    }
    ok('开发版 build_cmd_extract 走源码模式 [PY, 脚本绝对路径, path]',
      /def build_cmd_extract\(path\):[\s\S]{0,220}return \[PY, os\.path\.join\(SCRIPTS, 'stages', 'extract_resume_text\.py'\), path\]/.test(devPy));

    /* ---- 24.9 前端导出了这条链（测试能直接驱动，不必点真实文件框）---- */
    ['_readResumeFile', '_pickResumeText', '_collectorReq', '_uploadResume', '_textExts', '_accept']
      .forEach(function (k) {
        ok('前端导出 ' + k + '（测试可直接驱动文件读取链）',
          new RegExp('^\\s*' + k + ':', 'm').test(vr));
      });

    /* ---- 24.10 用户能看见的入口：按钮文案点明 PDF / Word ---- */
    ok('页头按钮明说「上传简历文件」（不是只写"上传文本文件"）',
      /html: '📄 上传简历文件'/.test(vr));
    ok('空态里有「📄 上传 PDF / Word」这一键（不用先进表单）',
      /上传 PDF \/ Word/.test(vr));
    ok('表单里的按钮改成「上传 PDF / Word 自动转文字」，且调 pickResumeText',
      /上传 PDF \/ Word 自动转文字/.test(vr) &&
      /pickResumeText\(\)\.then/.test(vr));
  }

  /* ==================================================================
     【25】打包工装：清空 crawler_src 时不能把「打包入口」一起删掉
     —— 血教训（2026-10-07 真踩过）：按交付文档跑「第 1 步
        build_crawler_src.py」，它开头就 shutil.rmtree(crawler_src/)，
        而**手写的打包入口 `entry.py` 恰好住在 crawler_src/ 里**、又不是
        从技能拷来的 → 被一起删掉 → PyInstaller 报"找不到入口文件"。
        （这次侥幸从回收站捞回来了；下次不一定。）
        所以这里把「构建脚本必须保住打包入口」钉成结构断言：
        采集组件.spec 的 Analysis 入口是谁 → 它就必须在 KEEP_IN_DST 里。
     ================================================================== */
  {
    ok('能找到「打包工程」目录（【25】的前置）', !!PACK_DIR, PACK_DIR || '没找到');
    if (PACK_DIR) {
      const RD = rel => fs.readFileSync(path.join(PACK_DIR, rel), 'utf8');
      const spec = RD('采集组件.spec');
      const build = RD('build_crawler_src.py');

      /* --- 25.1 spec 的打包入口是谁 --- */
      const em = spec.match(/Analysis\(\s*\[\s*'([^']+)'/);
      const specEntry = em ? em[1] : '';
      ok('采集组件.spec 的打包入口是 crawler_src/entry.py',
        specEntry === 'crawler_src/entry.py', specEntry || '（没解析出 Analysis 的第一个参数）');

      /* --- 25.2 build_crawler_src.py 的 KEEP_IN_DST 必须含它 --- */
      const keepSrc = (build.match(/KEEP_IN_DST\s*=\s*\[([^\]]*)\]/) || [])[1];
      const keepList = keepSrc === undefined ? null
        : (keepSrc.match(/'[^']*'|"[^"]*"/g) || []).map(s => s.slice(1, -1));
      const specBase = specEntry.replace(/^crawler_src[\/\\]/, '');
      ok('⛔ build_crawler_src.py 的 KEEP_IN_DST 含 spec 的入口文件名（否则清空时被删）',
        !!keepList && specBase && keepList.indexOf(specBase) >= 0,
        'spec 入口=' + specEntry + ' / KEEP_IN_DST=[' + (keepList || '没解析出来') + ']');

      /* --- 25.3 「先读出 → 再清空 → 后写回」的顺序真的是对的 ---
         光判"文件里出现过 read 和 write"没用：把 read 写到 rmtree 之后，
         字符串照样都在，但捞到的是空 → 入口文件消失。所以判**位置先后**。
         ⛔ 定位前必须剥掉注释行 —— KEEP_IN_DST 那段注释里就写着
            `shutil.rmtree(DST)`，indexOf 会先命中它（本轮真踩了一次）。 */
      const buildCode = build.split(/\r?\n/).filter(l => !/^\s*#/.test(l)).join('\n');
      const iRead = buildCode.indexOf('kept[name] = f.read()');
      const iRm = buildCode.indexOf('shutil.rmtree(DST)');
      const iWr = buildCode.indexOf('f.write(blob)');
      ok('⛔ 清空前把 KEEP_IN_DST 读进内存、清空后才写回（顺序真的对）',
        iRead > 0 && iRm > 0 && iWr > 0 && iRead < iRm && iRm < iWr,
        'read@' + iRead + ' rmtree@' + iRm + ' write@' + iWr);

      /* --- 25.4 缺入口时要明确停下，别闷头往下跑 --- */
      ok('缺打包入口时构建脚本会明确停下并提示（不是静默继续）',
        /KEEP_IN_DST[\s\S]{0,900}?打包入口/.test(build) && /\breturn\s+4\b/.test(build));

      /* --- 25.5 磁盘上现在真的有这个入口，且不是空壳 --- */
      const entryPath = path.join(PACK_DIR, 'crawler_src', 'entry.py');
      ok('crawler_src/entry.py 真在磁盘上（刚被清过一次，这条防的就是它消失）',
        fs.existsSync(entryPath));
      if (fs.existsSync(entryPath)) {
        const entrySrc = fs.readFileSync(entryPath, 'utf8');
        ok('crawler_src/entry.py 不是空壳（有 ROUTES 表，且条数 >= 10）',
          (entrySrc.match(/^\s*'[a-z_-]+':\s*'[^']+\.py',/gm) || []).length >= 10,
          '匹配到 ' + (entrySrc.match(/^\s*'[a-z_-]+':\s*'[^']+\.py',/gm) || []).length + ' 条路由');
        ok('crawler_src/entry.py 里 extract_text 路由还在（本轮新增的没丢）',
          /'extract_text':\s*'stages\/extract_resume_text\.py'/.test(entrySrc));
      }
    }
  }

  /* ==================================================================
     【26】便携版「assets 路径」必须处处认 JH_BOSS_ASSETS
     —— 血教训（2026-10-07，用户实测踩到，代价是「上传简历并解析」全程无效）：
        build_crawler_src.py 的 `patch_paths()` 原是一份**硬编码 4 个文件**的
        清单，漏了 `resume_matcher/config.py`（运行目录真源）与 `preferences.py`
        （采集参数）。后果不是"少一个功能"：
          · pipeline 把运行目录写进 PyInstaller 的 _internal/assets/
          · 采集器服务端读的是 exe 旁边的 assets/
          → LATEST.txt 永远读不到 → runDir 恒 None → hasProfile 恒 false
          → 界面永远显示「还缺简历画像」，**连 profile.json 已生成都看不出来**。
        而且这类 bug 在开发目录里跑（两者恰好是同一处）永远复现不了。

        这里守三件事：
          ① 打包副本里**没有**"拼 assets 但不认 JH_BOSS_ASSETS"的漏网文件（静态）
          ② 构建脚本自检失败时会**中止**（静态）—— 不是只打一句警告往下跑
          ③ 真 import 一次、把路径算出来，确认落点（运行时）
        ⛔ ③ 才是抓 bug 的那条：本轮就是它抓出「把 join 的第一个实参换成
           JH_BOSS_ASSETS」导致的 `assets\assets` 双重目录 ——
           `JH_BOSS_ASSETS` 本身就是 assets 目录，不是根。静态字符串断言看不见。
     ================================================================== */
  {
    ok('能找到「打包工程」目录（【26】的前置）', !!PACK_DIR, PACK_DIR || '没找到');
    if (PACK_DIR) {
      const PKG_SCRIPTS = path.join(PACK_DIR, 'crawler_src', 'scripts');
      const BUILD = path.join(PACK_DIR, 'build_crawler_src.py');
      const buildSrc = fs.existsSync(BUILD) ? fs.readFileSync(BUILD, 'utf8') : '';

      /* --- 26.1 静态：打包副本里不能有漏网文件 ---
         判据只看「真的出现 'assets' 字面量」的文件（早先拿
         `os.path.dirname(os.path.dirname(` 当判据，把 `_SCRIPTS = ...` 的定义
         也算进去，一口气误报 19 个 —— 那种守卫没人会当真，等于没有）。
         已知「看着像、其实是对的」用显式白名单，且必须写明理由。 */
      const SAFE = {
        'stages/boss_apply_one.py':
          'dirname(dirname(_SCRIPTS)) 在便携版正好是数据根，再包一层会变 assets/assets',
        'showcv/_browser.py': '工作台前端不调用 showcv（纯 skill 侧编辑器）',
        'showcv/delete_resumes.py': '同上',
        'showcv/export_images.py': '同上',
        'showcv/storage.py': '同上',
        'showcv/serve.py': '同上',
        'showcv/sync_app.py': '同上',
      };
      /* 白名单必须和构建脚本里的两份名单对得上 —— 两边各写一份、慢慢漂移，
         就会出现"测试放行、构建拦下"这种自相矛盾。 */
      ['SKIP_WRAP', 'KNOWN_SAFE'].forEach(name => {
        ok('【26】build_crawler_src.py 里有 ' + name + ' 名单',
          new RegExp(name + '\\s*=').test(buildSrc));
      });
      ['boss_apply_one.py', 'showcv/_browser.py'].forEach(f => {
        ok('【26】' + f + ' 同时出现在两边的白名单里（构建/测试口径不许漂移）',
          buildSrc.indexOf(f) >= 0, '构建脚本里没写 ' + f);
      });

      const loose = [];
      /* ⛔ 必须先剥掉注释与 docstring 再判断 ——
         「注释里出现过 JH_BOSS_ASSETS」会把检查骗过去（本轮真踩：
         resume_matcher/config.py 的说明注释里就写着这两个变量名，
         于是把 OUTPUT_DIR 的环境变量摘掉后，这条断言依然是绿的）。 */
      const stripPy = s => s
        .replace(/"""[\s\S]*?"""/g, '""')
        .replace(/'''[\s\S]*?'''/g, "''")
        .split('\n').map(l => l.replace(/#.*$/, '')).join('\n');
      const walk = dir => {
        fs.readdirSync(dir, { withFileTypes: true }).forEach(e => {
          const fp = path.join(dir, e.name);
          if (e.isDirectory()) return walk(fp);
          if (!e.name.endsWith('.py')) return;
          const rel = path.relative(PKG_SCRIPTS, fp).replace(/\\/g, '/');
          if (SAFE[rel]) return;
          const code = stripPy(fs.readFileSync(fp, 'utf8'));
          /* 认 JH_BOSS_ASSETS 或 JH_BOSS_ROOT 都算合格 ——
             `_SKILL_ROOT = JH_BOSS_ROOT or (...)` + `join(_SKILL_ROOT,'assets')`
             这条链在便携版同样是对的。这里防的是**一个都不认**。 */
          if (/['"]assets['"]/.test(code)
              && code.indexOf('JH_BOSS_ASSETS') < 0
              && code.indexOf('JH_BOSS_ROOT') < 0) {
            loose.push(rel);
          }
        });
      };
      try { walk(PKG_SCRIPTS); } catch (e) { loose.push('（扫描失败：' + e.message + '）'); }
      ok('⛔ 打包副本里没有"拼 assets 但不认 JH_BOSS_ASSETS"的漏网文件',
        loose.length === 0, loose.join('；'));

      /* --- 26.2 静态：构建脚本自检失败必须**中止** ---
         漏一个模块 = 便携版读写错目录，而开发目录永远复现不了，
         最后是用户在用的时候才发现。只打警告等于没守。 */
      ok('【26】构建脚本自检失败时中止构建（不是只打一句警告）',
        /missed[\s\S]{0,600}?return\s+5/.test(buildSrc),
        'patch_paths 的 missed 没有接到 main() 的失败返回');

      /* --- 26.3 静态：启动器注入的变量名要和上面认的对得上 --- */
      const entryPath = path.join(PACK_DIR, 'crawler_src', 'entry.py');
      let entrySrc = '';
      try { entrySrc = fs.readFileSync(entryPath, 'utf8'); } catch (e) { entrySrc = ''; }
      ok("【26】entry.py 注入 JH_BOSS_ROOT", /os\.environ\['JH_BOSS_ROOT'\]\s*=/.test(entrySrc));
      ok("【26】entry.py 注入 JH_BOSS_ASSETS", /os\.environ\['JH_BOSS_ASSETS'\]\s*=/.test(entrySrc));

      /* --- 26.4 运行时：真 import，真算路径 ---
         把 JH_BOSS_ASSETS 指向一个假数据目录，再看每个模块算出来的落点。
         ① 凡是"用户数据"必须在假数据目录下
         ② 凡是"包内脚本"（_SHOWCV_DIR）**不许**被挪进数据目录
         ③ 不许出现 `assets\assets`（本轮的踩坑）
         跑不了就明确报红 —— 静默跳过等于这条断言是摆设。 */
      const probePy = [
        '# -*- coding: utf-8 -*-',
        'import json, os, sys',
        'SCRIPTS = sys.argv[1]',
        'DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "__jh_fake_data__")',
        'os.environ["JH_BOSS_ROOT"] = DATA',
        'os.environ["JH_BOSS_ASSETS"] = os.path.join(DATA, "assets")',
        'os.environ.pop("BOSS_SKILL_ASSETS", None)',
        'sys.path.insert(0, SCRIPTS)',
        'sys.path.insert(0, os.path.join(SCRIPTS, "deliver"))',
        'out = {}',
        'def P(name, fn):',
        '    try: out[name] = str(fn())',
        '    except Exception as e: out[name] = "ERR: %s: %s" % (type(e).__name__, e)',
        'P("resume_matcher.OUTPUT_DIR", lambda: __import__("resume_matcher.config", fromlist=["x"]).OUTPUT_DIR)',
        'P("preferences.prefs_path", lambda: __import__("preferences").prefs_path())',
        'P("llm.config.CONFIG_PATH", lambda: __import__("llm.config", fromlist=["x"]).CONFIG_PATH)',
        'P("boss_crawler.config.ASSETS_DIR", lambda: __import__("boss_crawler.config", fromlist=["x"]).ASSETS_DIR)',
        'P("boss_crawler.config.USER_DATA_DIR", lambda: __import__("boss_crawler.config", fromlist=["x"]).USER_DATA_DIR)',
        'P("write_application_md.POST_DATA_DIR", lambda: __import__("write_application_md").POST_DATA_DIR)',
        'P("render_images.EXPECTED_PROFILE", lambda: __import__("render_images").EXPECTED_PROFILE)',
        'P("render_images._SHOWCV_DIR", lambda: __import__("render_images")._SHOWCV_DIR)',
        'print(json.dumps(out, ensure_ascii=False))',
      ].join('\n');
      const probePath = path.join(require('os').tmpdir(), 'jh_paths_probe_' + process.pid + '.py');
      const probeOut = path.join(require('os').tmpdir(), 'jh_paths_probe_' + process.pid + '.out');
      let pj = null, raw = '';
      try {
        fs.writeFileSync(probePath, probePy, 'utf8');
        /* ⛔ 不能用 `spawnSync(..., {encoding:'utf8'})` —— 那会建**管道**，
           而本机 node 派生子进程只要走管道就 EBUSY（2026-10-07 踩过两次，
           连 node→python / node→cmd 都失败；inherit / 文件描述符都正常）。
           所以把 stdout/stderr 一起写进文件，再读回来。 */
        const fd = fs.openSync(probeOut, 'w');
        try {
          require('child_process').spawnSync(
            'C:/Users/1/.workbuddy/binaries/python/envs/boss-crawler/Scripts/python.exe',
            [probePath, PKG_SCRIPTS], { stdio: ['ignore', fd, fd], timeout: 90000 });
        } finally {
          fs.closeSync(fd);
        }
        raw = (fs.readFileSync(probeOut, 'utf8') || '').trim();
        if (!raw) raw = '（子进程没有输出）';
      } catch (e) { raw = 'probe 抛异常：' + e.message; }
      try { pj = JSON.parse(raw); } catch (e) { pj = null; }

      if (!pj) {
        ok('【26】能真跑一次 Python 把路径算出来（前置）', false, 'probe 输出：' + (raw || '（空）'));
      } else {
        const DATA_KEY = '__jh_fake_data__';
        /* ① 用户数据 → 必须在假数据目录的 assets 下，且**不能**双重 assets */
        ['resume_matcher.OUTPUT_DIR', 'preferences.prefs_path',
         'llm.config.CONFIG_PATH', 'boss_crawler.config.ASSETS_DIR',
         'boss_crawler.config.USER_DATA_DIR', 'write_application_md.POST_DATA_DIR',
         'render_images.EXPECTED_PROFILE'].forEach(k => {
          const v = (pj[k] || '').replace(/\\/g, '/');
          ok('【26】运行时 · ' + k + ' 落在数据目录的 assets 下',
            v.indexOf(DATA_KEY) >= 0 && v.indexOf('assets') >= 0, v);
          ok('【26】运行时 · ' + k + ' 没有 assets/assets 双重目录',
            v.indexOf('/assets/assets') < 0, v);
        });
        /* ② 包内脚本路径不许被挪进数据目录 */
        const showcv = (pj['render_images._SHOWCV_DIR'] || '').replace(/\\/g, '/');
        ok('【26】运行时 · render_images._SHOWCV_DIR 仍是**包内** scripts/showcv（没被挪进数据目录）',
          showcv.indexOf(DATA_KEY) < 0 && /\/showcv$/.test(showcv), showcv);
      }
    }
  }

  /* ==================================================================
     【27】投递看板「用哪个浏览器」+ AI 提示词的两个真缺口（第 28 轮）

     起因（用户原话）：「采集功能的登陆boss和其他的boss登录非一致，需要重新打开减少风险」
     定位：投递看板**同一屏**上两个按钮走的是两个浏览器 ——
       「去投递」      = window.open → 系统默认浏览器（用户日常 Edge，本来就登录着）
       「打招呼/同步回复」= 工具另起窗口（独立 profile，要单独扫码）
     修法：加 `browser_profile.py` 作**单一真源**；daily 模式复用日常 Edge 的 profile。

     这里守四件事：
       ① 判据是 **lockfile**（不是进程名）—— 进程名会误报：本工具自己也会起 msedge
       ② daily 在 Edge 没退时必须**明确拒绝**，且话说得能照着做（不静默失败）
       ③ **两个脚本都要接**（只接一个 = 还是"非一致"，那正是病根）
       ④ 前端默认 own（daily 要求用户先退 Edge，默认开会让第一次用的人以为坏了）
     ================================================================== */
  {
    const SKILL_SCRIPTS = 'C:/Users/1/.workbuddy/skills/boss-crawler/scripts';
    const rdSkill = rel => {
      try { return fs.readFileSync(path.join(SKILL_SCRIPTS, rel), 'utf8'); }
      catch (e) { return ''; }
    };

    /* --- 27.1 单一真源文件必须存在，且关键函数齐 --- */
    const bp = rdSkill('browser_profile.py');
    ok('【27】browser_profile.py 存在（「用哪个浏览器」的单一真源）', !!bp,
      SKILL_SCRIPTS + '/browser_profile.py 读不到');
    ['resolve_mode', 'profile_in_use', 'check_ready', 'apply_to_options',
     'daily_user_data_dir', 'user_data_dir_for'].forEach(fn => {
      ok('【27】browser_profile 有 ' + fn + '()', bp.indexOf('def ' + fn) >= 0);
    });

    /* --- 27.2 判据必须是 lockfile，不能只查进程名 ---
       进程名判据的错法：本工具自己也会起 msedge（采集/打招呼），
       「有 msedge 进程 → daily 不可用」会把用户在自己用采集器的时候误拦。
       lockfile 是 Chrome/Edge 对**那个 profile** 的独占锁，精确得多。 */
    ok('【27】profile_in_use 用 lockfile 判据（不是只看进程名）',
      bp.indexOf('lockfile') >= 0);
    ok('【27】profile_in_use 明确处理 PermissionError（被锁住 = 在用）',
      /except\s+PermissionError/.test(bp));
    ok('【27】profile_in_use 对不存在的目录返回 False（首次使用不该被拦）',
      /not\s+os\.path\.isdir\(path\)/.test(bp));

    /* --- 27.3 daily 不可用时必须**明确拒绝**且给可操作的话 --- */
    ok('【27】check_ready 会拦下 daily（返回 ok=False）',
      /MODE_DAILY[\s\S]{0,2000}?return\s*\(False/.test(bp));
    /* own 也要查占用：上一轮窗口没退干净 / 并发起两次时，
       提前给一句能看懂的话，而不是让 DrissionPage 卡在启动超时上。 */
    ok('【27】check_ready(own) 也查占用（不静默卡在启动超时）',
      /MODE_OWN[\s\S]{0,800}?profile_in_use/.test(bp));
    ok('【27】拒绝时给出的提示里有「彻底退出」（能照着做，不是「失败了」）',
      bp.indexOf('彻底退出') >= 0);
    ok('【27】daily 模式强制非 headless（用户要看得见那个窗口）',
      /headless\s+and\s+mode\s*!=\s*MODE_DAILY/.test(bp));

    /* --- 27.4 ⛔ 两个脚本**都要接**（病根就是"一条接了一条没接"）--- */
    const aa = rdSkill('resume_matcher/auto_apply.py');
    const cs = rdSkill('stages/boss_chat_sync.py');
    ok('【27】auto_apply.py 接了 browser_profile（打招呼）',
      aa.indexOf('from browser_profile import') >= 0 && aa.indexOf('check_ready') >= 0);
    ok('【27】boss_chat_sync.py 接了 browser_profile（同步回复）',
      cs.indexOf('from browser_profile import') >= 0 && cs.indexOf('check_ready') >= 0);
    ok('【27】auto_apply 拒绝时**不带着坏配置往下走**（直接 return）',
      /check_ready[\s\S]{0,500}?return\s+results/.test(aa));
    ok('【27】chat_sync 拒绝时给出非 0 退出码（别退化成"成功但没数据"）',
      /check_ready[\s\S]{0,500}?SystemExit\(3\)/.test(cs));

    /* --- 27.5 两份服务端都要把「设置」注入给子进程 ---
       ⛔ 开发版与打包版是手工同步的孪生副本 —— 只改一处 = 另一处静默失效
          （第 25 轮那个 bug 就是这么来的）。 */
    const DEV_SRV = path.join(DIR, '采集器', 'server.py');
    const CORE = PACK_DIR ? path.join(PACK_DIR, 'src', 'server_core.py') : '';
    [['开发版', DEV_SRV], ['打包版', CORE]].forEach(([tag, p]) => {
      if (!p) { ok('【27】' + tag + '服务端可读（前置）', false, '路径为空'); return; }
      let src = '';
      try { src = fs.readFileSync(p, 'utf8'); } catch (e) { src = ''; }
      if (!src) { ok('【27】' + tag + '服务端可读（前置）', false, p); return; }
      ok('【27】' + tag + '服务端有 browser_mode_env（把设置注入子进程）',
        src.indexOf('def browser_mode_env') >= 0);
      /* ⛔ 必须**两处**调用点都传（打招呼 + 同步回复）——
         只传一处 = 另一个功能还是老样子，用户看到的就是"还是不一致"。 */
      const n = (src.match(/env_extra=browser_mode_env\(payload\)/g) || []).length;
      ok('【27】' + tag + '服务端的**两个**调用点都传了 env_extra（实际 ' + n + ' 处）',
        n === 2);
      ok('【27】' + tag + '服务端 subprocess_env 支持 extra 注入',
        /def subprocess_env\(extra=None\)/.test(src));
    });

    /* --- 27.6 前端：默认 own，且两个请求都带上模式 --- */
    const st = fs.readFileSync(path.join(DIR, 'js', 'store.js'), 'utf8');
    ok("【27】store.js 里 boss.browserMode 默认是 'own'（不是 daily）",
      /browserMode:\s*'own'/.test(st));
    const ab = fs.readFileSync(path.join(DIR, 'js', 'apply-boss.js'), 'utf8');
    ok('【27】apply-boss 有 browserMode() 读取 + 脏值收敛成 own',
      /function browserMode\(\)[\s\S]{0,200}?'daily'\s*:\s*'own'/.test(ab));
    ok('【27】/api/apply-one 请求带上了 browserMode',
      /apply-one[\s\S]{0,400}?browserMode:\s*browserMode\(\)/.test(ab));
    ok('【27】/api/sync-reply 请求带上了 browserMode',
      /sync-reply[\s\S]{0,200}?browserMode:\s*browserMode\(\)/.test(ab));

    /* 设置页里那段说明必须是**可见文字**，不能塞进 title 属性。
       「零扫码 vs 要扫码」是决定性差异，藏在悬停提示里等于没说
       （本轮第一版就是塞 title，验证时 textContent 读不到才发现）。 */
    const vs = fs.readFileSync(path.join(DIR, 'js', 'view-settings.js'), 'utf8');
    ok('【27】浏览器模式的说明是**可见文字**（不是 title 悬停才显示）',
      vs.indexOf('title: x[2]') < 0 && vs.indexOf("text: x[2] }") >= 0,
      'title: x[2] 出现=' + (vs.indexOf('title: x[2]') >= 0) +
      ' / 可见文本=' + (vs.indexOf("text: x[2] }") >= 0));

    /* --- 27.7 AI 提示词：借来的两条方法论真的写进去了 ---
       greeting  ← job_killer「前 18 字」/ technical-job-search「用 JD 原词」
       followup  ← job_killer hr-communicator 的 8 类场景 */
    const ai = fs.readFileSync(path.join(DIR, 'js', 'ai.js'), 'utf8');
    const gBlock = (ai.match(/greeting:\s*\{[\s\S]*?\n    \},/) || [''])[0];
    /* ⛔ 查**完整表述**，不是「15 个字」这个碎片 ——
       碎片会命中同一模板里另一句话（"前 15 个字里就要出现…"），
       于是把上面那句方法论删掉、断言照样绿（本轮定向变异 M6 真踩到）。
       这正是「断言的名字比断言本身强」：名字承诺的是整句方法论，
       就必须拿整句去比。 */
    ok('【27】greeting 提示词写了「开头 15 个字决定 HR 会不会点开」这条方法论',
      gBlock.indexOf('开头 15 个字决定 HR 会不会点开') >= 0,
      '没命中完整表述 —— 方法论被削弱了');
    ok('【27】greeting 提示词要求「用岗位描述里的原词」（别换同义词）',
      gBlock.indexOf('岗位描述里的原词') >= 0);
    ok('【27】greeting 提示词里有反虚构约束（材料没有的数字一律不写）',
      gBlock.indexOf('一律不写') >= 0);
    const fBlock = (ai.match(/followup:\s*\{[\s\S]*?\n    \},/) || [''])[0];
    ok('【27】followup 提示词块被正确定位（前置：正则没抓空）',
      fBlock.length > 200, 'gBlock=' + gBlock.length + ' fBlock=' + fBlock.length);
    /* ⛔ 用完整场景名，不用泛化词：只查「跟进」两个字，等于没补。 */
    const scenes = ['投了没回音', '约面试', '面试后等结果', '谈薪资',
                    '离职原因', '要材料', 'Offer 沟通', '婉拒'];
    const hit = scenes.filter(s => fBlock.indexOf(s) >= 0);
    ok('【27】followup 提示词覆盖 HR 场景 ≥5 类（实际 ' + hit.length + ' 类）',
      hit.length >= 5, '命中：' + hit.join('、'));

    /* --- 27.8 运行时：真 import 一次，把行为验出来 ---
       静态查"有没有写 check_ready"是必要的，但**不够** ——
       第 26 轮的教训：静态断言看不见"算出来是错的"。 */
    const probe = [
      '# -*- coding: utf-8 -*-',
      'import json, os, sys',
      'SCRIPTS = sys.argv[1]',
      'sys.path.insert(0, SCRIPTS)',
      'out = {}',
      'import browser_profile as B',
      'out["MODES"] = list(B.MODES)',
      'os.environ.pop("JH_BOSS_BROWSER_MODE", None)',
      'out["default"] = B.resolve_mode()',
      'out["dirty"] = B.resolve_mode("\\u6bcf\\u5929")',
      'out["blank"] = B.resolve_mode("")',
      'out["daily"] = B.resolve_mode("daily")',
      'out["own"] = B.resolve_mode("own")',
      'out["ghost"] = B.profile_in_use("C:\\\\__jh_ghost_profile__")[0]',
      'out["own_ok"] = B.check_ready("own", "C:\\\\x")[0]',
      'out["daily_dir"] = B.daily_user_data_dir()',
      /* 交叉验证：对日常 profile 而言，「有 msedge 进程」与「profile 被锁」应当一致。
         这条才是**功能**断言 —— 只查源码里有没有 "lockfile" 三个字（注释里也有！）
         会被一个恒返回 False 的假实现骗过去。 */
      'import subprocess',
      'try:',
      '    _r = subprocess.run(["tasklist", "/FI", "IMAGENAME eq msedge.exe", "/FO", "CSV", "/NH"], capture_output=True, timeout=15)',
      '    out["msedge_n"] = (len([1 for _l in (_r.stdout or b"").decode("utf-8", "replace").splitlines() if "msedge.exe" in _l.lower()]))',
      'except Exception:',
      '    out["msedge_n"] = -1',
      'out["daily_in_use"] = B.profile_in_use(out["daily_dir"])[0] if out["daily_dir"] else None',
      'out["cross_agree"] = ((out["msedge_n"] > 0) == bool(out["daily_in_use"])) if out["msedge_n"] >= 0 else None',
      'print(json.dumps(out, ensure_ascii=False))',
    ].join('\n');
    const pPath = path.join(require('os').tmpdir(), 'jh_bp_probe_' + process.pid + '.py');
    const pOut = path.join(require('os').tmpdir(), 'jh_bp_probe_' + process.pid + '.out');
    let bj = null, braw = '';
    try {
      fs.writeFileSync(pPath, probe, 'utf8');
      const fd = fs.openSync(pOut, 'w');
      try {
        require('child_process').spawnSync(
          'C:/Users/1/.workbuddy/binaries/python/envs/boss-crawler/Scripts/python.exe',
          [pPath, SKILL_SCRIPTS], { stdio: ['ignore', fd, fd], timeout: 60000 });
      } finally { fs.closeSync(fd); }
      braw = (fs.readFileSync(pOut, 'utf8') || '').trim();
      if (!braw) braw = '（子进程没有输出）';
    } catch (e) { braw = 'probe 抛异常：' + e.message; }
    try { bj = JSON.parse(braw); } catch (e) { bj = null; }

    if (!bj) {
      ok('【27】能真跑一次 browser_profile（前置）', false, 'probe 输出：' + (braw || '（空）'));
    } else {
      ok('【27】运行时 · 没设环境变量时默认 own（安全默认）',
        bj.default === 'own', '实际 ' + bj.default);
      ok('【27】运行时 · 脏值 / 空值都收敛成 own（脏设置不能把请求送到跑不起来的模式）',
        bj.dirty === 'own' && bj.blank === 'own',
        'dirty=' + bj.dirty + ' blank=' + bj.blank);
      ok('【27】运行时 · own/daily 两个合法值原样通过',
        bj.own === 'own' && bj.daily === 'daily');
      ok('【27】运行时 · 不存在的 profile 判为「没被占用」（首次使用不该被拦）',
        bj.ghost === false, '实际 ' + bj.ghost);
      ok('【27】运行时 · check_ready(own) 永远放行（默认模式不能被误拦）',
        bj.own_ok === true, '实际 ' + JSON.stringify(bj.own_ok));
      ok('【27】运行时 · 能定位到日常 Edge profile 目录',
        !!bj.daily_dir && /Edge/.test(bj.daily_dir), bj.daily_dir || '(空)');
      ok('【27】运行时 · ⛔ 交叉验证：进程存在 ⟺ profile 被判占用（判据真的有效）',
        bj.cross_agree === true,
        'msedge 进程=' + bj.msedge_n + ' / profile 判占用=' + bj.daily_in_use +
        '  —— 两者不一致说明检测是假的（比如恒返回 False）');
    }
  }
  /* ==================================================================
     【28】两个「能建但删不掉」的模块补上删除（第 30 轮）
     —— 用户原话：「这2个功能模块里面要有删除功能」。
        实测定位：全项目扫「渲染了用户数据但没有删除入口」的页面，只剩两个 ——
          · 面试管理（Store.interviews() 渲染，0 个删除入口）
            ⛔ 而 Store.removeInterview / takeOut({interviews}) **早就支持**
              —— 数据层有、界面没接，典型的"漏了一半"。
          · 待跟进（渲染投递/面试/岗位，0 个删除入口）
       交互按用户要求：**先确认、再给撤销**（双保险）。
       ⚠️ 注意这与项目其他删除位「只给撤销、不弹确认」是**有意不一致**
          （见 Comp.trashToast 注释），面试/提醒都是人工一条条填的，误删最恼人。

     ⛔ 待跟进不能无脑给「删岗位」：它的 9 类提醒来源分三种 ——
        背后是**投递记录** / 是**面试记录** / **只有岗位本身**
        （「高匹配还没投」「收藏了还没投」是从岗位推出来的，压根没有"记录"）。
        所以 28.3 专门守「只有岗位的行**不许**出现删除按钮」。
     ================================================================== */
  {
    /* --- 28.1 待跟进 · 投递类：删除要真删掉投递记录，且先确认、可撤销 --- */
    clearToasts();
    /* ⛔ Store.addJob 返回的是 **{job, dup} 包装对象**，不是岗位本身 ——
       这里必须 .job，否则 jobId 是 undefined、addApplication 直接返回 null。 */
    const jFU = Store.addJob({
      title: '回归·待跟进删投递', company: '回归测试公司A',
      url: 'https://www.zhipin.com/job_detail/reg_fu_a.html',
    }).job;
    const appFU = Store.addApplication({
      jobId: jFU.id, status: 'applied', appliedAt: U.now() - 30 * 86400000,
    });
    App.go('followup');
    await tick();

    /* ⛔ 必须**收窄到本用例那一行**再找按钮。
       待跟进页里还挂着别的测试留下的提醒行，用 '#view button' 取第一个会删到别人那条
       （本轮第一次跑就是这么错的：删了另一行的投递 → "投递记录真的被删了"自然红）。
       这正是「选择器不收窄到容器」那条反模式。 */
    const fuRow = U.$$('#view .li').filter(li =>
      (li.textContent || '').indexOf('回归·待跟进删投递') >= 0)[0];
    ok('待跟进：能定位到本用例那一行（前置）', !!fuRow);
    const delBtn = fuRow
      ? U.$$('button', fuRow).filter(b => (b.textContent || '').trim() === '🗑 删除')[0]
      : null;
    ok('待跟进：有可删记录的行里出现了「🗑 删除」按钮', !!delBtn);

    if (delBtn) {
      delBtn.click();
      await tick();
      ok('待跟进：点删除会先弹确认框（用户要求"两者都要"）', U.$$('.mask').length > 0);
      const okBtn = mBtn('删除');
      ok('待跟进：确认框的按钮是「删除」', !!okBtn);
      if (okBtn) {
        okBtn.click();
        await tick();
        ok('待跟进：确认后投递记录**真的**被删了', !Store.application(appFU.id));
        ok('待跟进：删除后给了「撤销」入口', !!undoBtn());
        if (undoBtn()) {
          undoBtn().click();
          await tick();
          ok('待跟进：撤销后投递记录回来了', !!Store.application(appFU.id));
        }
      }
    }
    U.closeAllModals();
    await tick();

    /* --- 28.2 待跟进 · 面试类：删除要删掉的是**面试记录**（不是投递） --- */
    clearToasts();
    const ivFU = Store.addInterview({ jobId: jFU.id, round: '一面（技术/业务）' });  // 没填时间 → interviewNoTime
    App.go('followup');
    await tick();
    /* 28.2 这条走静态断言更稳：DOM 上「同一条岗位」可能同时出现多条提醒，
       点第一个不一定命中面试那条。这里只钉「面试来源走 interviews」这个映射。 */
    const fuSrc = fs.readFileSync(path.join(DIR, 'js', 'view-followup.js'), 'utf8');
    ok('待跟进：面试类提醒的删除指向 interviews（不是 applications）',
      /interviewId[\s\S]{0,120}?kind:\s*'interviews'/.test(fuSrc));
    ok('待跟进：投递类提醒的删除指向 applications',
      /appId[\s\S]{0,120}?kind:\s*'applications'/.test(fuSrc));
    ok('待跟进：删除都走 Store.takeOut（=可撤销）', /Store\.takeOut\(spec\)/.test(fuSrc));
    ok('待跟进：删除前必弹确认框（U.confirm）', /U\.confirm\(/.test(fuSrc));
    ok('待跟进：删完给撤销 toast（Comp.trashToast）', /Comp\.trashToast\(/.test(fuSrc));

    /* --- 28.3 ⛔ 只有岗位的行不许出现「删除」（没有记录可删，会误导） ---
       ⛔ 这里必须**真渲染出来查按钮**，不能只查源码里有没有 `return null;` ——
          定向变异 M4 就是要证明这点：把 deletableOf 改成"永远返回 jobs"之后，
          「源码里有 return null」照样成立、断言照样绿（弱断言）。
          只有"渲染那一行、看它有没有删除按钮"才真的守得住。 */
    const jFav = Store.addJob({
      title: '回归·只有岗位的行', company: '回归测试公司B',
      url: 'https://www.zhipin.com/job_detail/reg_fu_b.html',
      favorite: true, createdAt: U.now() - 10 * 86400000,
    }).job;
    App.go('followup');
    await tick();
    const favRow = U.$$('#view .li').filter(li =>
      (li.textContent || '').indexOf('回归·只有岗位的行') >= 0)[0];
    ok('待跟进：收藏超期（只有岗位）的提醒能渲染出来（前置）', !!favRow);
    if (favRow) {
      const favBtns = U.$$('button', favRow).map(b => (b.textContent || '').trim());
      ok('待跟进：⛔ 只有岗位的行**不许**有「🗑 删除」',
        favBtns.indexOf('🗑 删除') < 0, '实际按钮：' + favBtns.join(' / '));
      ok('待跟进：只有岗位的行给的是「🚫 不再提醒」',
        favBtns.indexOf('🚫 不再提醒') >= 0, '实际按钮：' + favBtns.join(' / '));
    }
    /* 「不再提醒」必须是 snooze（岗位还在），不是把岗位删掉 */
    ok('待跟进：「不再提醒」用的是 snooze，不是删岗位',
      /不再提醒[\s\S]{0,400}?Store\.snooze\(/.test(fuSrc));
    ok('待跟进：有 deletableOf() 做「这条到底有没有可删记录」的判断',
      /function deletableOf/.test(fuSrc));
    Store.removeJob(jFav.id);

    /* --- 28.4 面试管理页：条目上要有删除按钮，且删的是**本用例那一场** --- */
    clearToasts();
    App.go('interview');
    await tick();
    /* 同样收窄到本用例那一行（面试页也可能有别的测试留下的场次）。 */
    const ivRow = U.$$('#view .li').filter(li =>
      (li.textContent || '').indexOf('回归·待跟进删投递') >= 0)[0];
    ok('面试管理：能定位到本用例那一场（前置）', !!ivRow);
    const ivDel = ivRow
      ? U.$$('button', ivRow).filter(b => (b.textContent || '').indexOf('删除') >= 0)[0]
      : null;
    ok('面试管理：面试条目上有「删除」按钮（此前一个都没有）', !!ivDel);

    if (ivDel) {
      ivDel.click();
      await tick();
      const ivOk = mBtn('删除');
      ok('面试管理：点删除先弹确认框', !!ivOk);
      if (ivOk) {
        ivOk.click();
        await tick();
        ok('面试管理：确认后**这一场**面试真的没了', !Store.interview(ivFU.id));
        ok('面试管理：删除后给了「撤销」入口', !!undoBtn());
        if (undoBtn()) {
          undoBtn().click();
          await tick();
          ok('面试管理：撤销后这一场面试回来了', !!Store.interview(ivFU.id));
        }
      }
    }
    U.closeAllModals();
    await tick();

    /* --- 28.5 静态：面试页的删除不许误删岗位 --- */
    const ivSrc = fs.readFileSync(path.join(DIR, 'js', 'view-interview.js'), 'utf8');
    ok('面试管理：删除走 takeOut({interviews})，不碰岗位',
      /takeOut\(\{\s*interviews:\s*\[v\.id\]\s*\}\)/.test(ivSrc));
    ok('面试管理：删除按钮标了 danger 样式（视觉上能看出是危险操作）',
      /class:\s*'btn xs danger',\s*text:\s*'🗑 删除'/.test(ivSrc));

    // 清理
    Store.removeApplication(appFU.id);
    Store.removeJob(jFU.id);
    App.go('jobs');
    await tick();
  }
  /* ==================================================================
     【29】找工作避坑雷达（第 31 轮）
     —— 用户：「我想加入找工作壁坑的功能」。方案 P0 = 纯本地规则扫描 + 卡片徽章 + 依据展开。

     ⛔⛔ 本模块最贵的一条、也是这一整块测试的重心：**假阳性比漏报更不能忍**。
        两个实测踩到的误报，各自钉一条断言：
          · 第 29 轮：「公司直招，**非**外包」被 `'外包' in jd` 判成外包嫌疑 —— 判反了。
          · 第 31 轮：「试用期**缴纳**五险一金；完善的新人**培训**」——
            「缴纳」落在「培训」的窗口里 → 把一条正常 JD 判成「招聘收费」**红灯**。
        所以测试必须同时守两边：**该报的要报，不该报的绝不报**。
        只测"能报"是不够的 —— 一个"全都报"的规则也能通过那种测试。
     ================================================================== */
  {
    const PIT = sandbox.Pitfall;
    ok('【29】pitfall.js 已加载并挂到 window.Pitfall', !!PIT);

    if (!PIT) {
      // 后面全依赖它，直接跳过（但上面的断言已经报红了）
    } else {
      const pv = (jd, title, extra) => PIT.verdict(Object.assign(
        { id: 'pit-t', rawJD: jd, title: title || '运营专员' }, extra || {}));
      const ids = v => v.items.map(x => x.id);

      /* ---------- 29.1 该报必须报（真阳性） ---------- */
      const TP = [
        ['收服装费', '入职需缴纳服装费 200 元。', 'fee'],
        ['收押金', '需交押金 500 元，离职时退还。', 'fee'],
        ['培训费自理', '培训费自理，上岗后从工资扣。', 'fee'],
        ['体检自理（光杆词+紧邻掏钱动词）', '入职体检自理。', 'fee'],
        ['先买后报', '需先购买工具，工作满一个月后报销。', 'buyfirst'],
        ['索要银行卡正反面', '入职需提供银行卡正反面照片。', 'secret'],
        ['转账给指定老师', '报名后转账给指定老师即可。', 'privpay'],
        ['派驻外场', '本岗位需派驻甲方现场办公。', 'outsource'],
        ['薪资含糊', '薪资上不封顶，多劳多得，能力越强收入越高。', 'salaryVague'],
        ['门槛与报酬不匹配', '工作轻松简单，无需经验，月入过万不是梦。', 'tooGood'],
        ['制造紧迫感', '急招！当天入职，名额有限，月入 2 万。', 'urgent'],
      ];
      TP.forEach(function (c) {
        const v = pv(c[1]);
        ok('【29】规则命中 · ' + c[0], ids(v).indexOf(c[2]) >= 0,
          '期望 ' + c[2] + '，实际 ' + (ids(v).join('/') || '(无)'));
      });
      /* 岗位名对不上：要 3 个销售词 + 标题是职能岗 */
      {
        const v = pv('负责社群维护、客户开发与拉新，有业绩提成。', '社群运营');
        ok('【29】规则命中 · 岗位名与正文对不上', ids(v).indexOf('mismatch') >= 0);
      }
      /* 结构化字段：代招 / 已失效 */
      {
        const vp = PIT.verdict({ id: 'a', title: '运营', rawJD: '正常描述', proxyHire: true });
        ok('【29】代招字段 → 命中 proxy', ids(vp).indexOf('proxy') >= 0);
        /* ⛔ 代招默认必须是**黄灯** —— 代招不违法，只是「你签的不是这家公司」。
           用户明确选了这个尺度；想改成红灯就改 Pitfall.config.proxyHireLevel。 */
        ok('【29】代招默认判黄灯（不是红灯 —— 不违法，只提醒）',
          vp.items.filter(x => x.id === 'proxy')[0].level === 'yellow',
          '实际 ' + (vp.items.filter(x => x.id === 'proxy')[0] || {}).level);
        ok("【29】config.proxyHireLevel 默认是 'yellow'（唯一开关，便于改口径）",
          PIT.config.proxyHireLevel === 'yellow');
        const vi = PIT.verdict({ id: 'b', title: '运营', rawJD: '正常描述', invalid: true });
        ok('【29】已失效字段 → 命中 invalid', ids(vi).indexOf('invalid') >= 0);
      }

      /* ---------- 29.2 ⛔ 绝不能报（假阳性 —— 比漏报更不能忍） ---------- */
      const FP = [
        ['缴纳五险一金 + 新人培训（本轮踩到的红灯误报）',
          '试用期缴纳五险一金；完善的新人培训及运营指导；团队提供内容策划、摄影、造型支持。', 'fee'],
        ['公司直招，非外包（第 29 轮的判反）',
          '公司直招，非外包。福利：高提成，上不封顶。', 'outsource'],
        ['体检由公司承担', '入职体检由公司统一安排，费用公司承担。', 'fee'],
        ['依法缴纳社保', '公司依法为员工缴纳社会保险和住房公积金，工资准时发放。', 'fee'],
        ['培训体系完善', '公司有完善的培训体系和带教机制，新人快速上手。', 'fee'],
        ['不接受居家办公（否定）', '本岗位需到岗办公，不接受居家办公，请知悉。', 'outsource'],
        ['拒绝中介（否定）', '本岗位为公司直招，拒绝中介，不收取任何费用。', 'outsource'],
      ];
      FP.forEach(function (c) {
        const v = pv(c[1]);
        ok('【29】⛔ 不误报 · ' + c[0], ids(v).indexOf(c[2]) < 0,
          '不该报的 ' + c[2] + ' 报了：' +
          (v.items.filter(x => x.id === c[2]).map(x => x.evidence).join(' | ') || ''));
      });
      /* 岗位名对不上的两个防误报闸 */
      {
        const v1 = pv('负责客户开发、带看成交，收取佣金，有业绩提成和销售奖励。', '销售岗（房屋视频号拍摄运营）');
        ok('【29】⛔ 不误报 · 标题已写销售岗 = 诚实告知，不算挂羊头',
          ids(v1).indexOf('mismatch') < 0);
        const v2 = pv('负责直播运营与数据复盘，提升直播间营收。任职要求：有销售相关经验优先。', '抖音运营');
        ok('【29】⛔ 不误报 · 任职要求里顺带提销售，不算挂羊头',
          ids(v2).indexOf('mismatch') < 0);
      }
      /* 一条完全干净的 JD 不该有任何命中 */
      {
        const v = pv('岗位职责：负责公众号与小红书的日常内容更新、选题策划与数据复盘。' +
          '任职要求：大专以上学历，1 年以上新媒体运营经验，熟悉剪映与后台数据工具。福利：五险一金、双休、带薪年假。');
        ok('【29】⛔ 一条干净的 JD 零命中（不是"全都报"）', v.items.length === 0,
          '实际命中：' + ids(v).join('/'));
      }

      /* ---------- 29.3 「未扫描 ≠ 没问题」 ---------- */
      {
        const v = PIT.verdict({ id: 'u', title: '某岗位' });
        ok('【29】没有任何材料 → unknown（未扫描），**绝不默认绿灯**', v.level === 'unknown',
          '实际 ' + v.level);
        ok('【29】unknown 的说明里明写「未扫描不等于没问题」',
          PIT.LEVELS.unknown.tip.indexOf('未扫描') >= 0);
        const g = PIT.verdict({ id: 'g', title: '某岗位', rawJD: '负责日常运营工作，五险一金，双休。' });
        ok('【29】有材料且没触发 → green（未发现问题）', g.level === 'green', '实际 ' + g.level);
      }

      /* ---------- 29.4 ⛔ 否定语境是本模块的地基，必须单独钉住 ---------- */
      ok('【29】hits() 对「非外包」不命中（第 29 轮判反的直接回归）',
        PIT.hits('公司直招，非外包。', ['外包']).length === 0);
      ok('【29】hits() 对「外包」照常命中（去掉否定后不能失守）',
        PIT.hits('本岗位属于外包性质。', ['外包']).length === 1);
      ok('【29】否定词表覆盖 非/不/无/免/拒绝 等常见写法',
        ['非', '不', '无', '拒绝'].every(w => PIT.TABLES.NEG.indexOf(w) >= 0));
      ok('【29】「非常轻松」里的「非」不该被当成否定（只认紧邻的词）',
        PIT.negated('非常') === false, 'negated("非常") 实际 = ' + PIT.negated('非常'));

      /* ---------- 29.5 命中必须**回引原文**（否则没法验证也没法反驳） ---------- */
      {
        const v = pv('入职需缴纳服装费 200 元，另需提供担保人。');
        const it = v.items.filter(x => x.id === 'fee')[0];
        ok('【29】每条命中都带 evidence（回引原文）', !!(it && it.evidence));
        ok('【29】evidence 里有原文片段（不是凭空判的）',
          !!(it && it.evidence.indexOf('服装费') >= 0), it ? it.evidence : '');
        ok('【29】每条命中都带 why（依据）', !!(it && it.why && it.why.length > 4));
        ok('【29】每条命中都带 ask（建议怎么问）', !!(it && it.ask && it.ask.length > 4));
        ok('【29】收费类引的是《劳动合同法》第 9 条',
          !!(it && it.why.indexOf('第 9 条') >= 0), it ? it.why : '');
      }

      /* ---------- 29.6 措辞必须留余地（不能写成"这是骗局"） ---------- */
      {
        /* ⚠️ 这条 JD 要真能触发「用工主体」那条规则，否则验的是空气。
           用「派驻甲方现场」而不是「非外包」—— 后者会被否定语境正确地放掉。 */
        const all = pv('需交押金 500 元。本岗位需派驻甲方现场。薪资上不封顶。')
          .items.map(x => x.title + x.why + x.ask).join(' ');
        ok('【29】⛔ 措辞里不出现「骗局 / 骗子 / 诈骗」这类断言',
          !/骗局|骗子|诈骗/.test(all));
        ok('【29】用工主体那条措辞说明「不代表有问题」（前置：这条规则真被触发了）',
          /不代表有问题|本身不违法/.test(all), '实际文案：' + all);
      }

      /* ---------- 29.7 接界面：卡片徽章 + 详情折叠块 ---------- */
      const idxHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
      ok('【29】index.html 引入了 js/pitfall.js', idxHtml.indexOf('js/pitfall.js') >= 0);
      ok('【29】pitfall.js 在 components.js 之后（要用 Comp.el）',
        idxHtml.indexOf('js/components.js') < idxHtml.indexOf('js/pitfall.js'));

      const vjs = fs.readFileSync(path.join(DIR, 'js', 'view-jobs.js'), 'utf8');
      ok('【29】岗位卡片上挂了避坑徽章（走 Comp.fitLine 的 extra 挂点）',
        /Pitfall\.badge\(/.test(vjs));
      ok('【29】详情抽屉里有避坑折叠块（Pitfall.panel）', /Pitfall\.panel\(/.test(vjs));
      /* ⛔ 红灯/黄灯要放在「合适度」**前面** —— 有问题就得第一眼看到 */
      const hotBefore = /if \(hot\) left\.appendChild\(pitFold\);/.test(vjs);
      ok('【29】红灯/黄灯时避坑块排在「合适度」之前（位置有条件）', hotBefore);
      /* ⛔ 非红灯/黄灯时要放到左栏**最后**。
         不能只说"放在合适度之后" —— fitPanel 不是 foldGroup，
         紧跟其后会让「🛡 避坑检查」成为**第一个折叠组**，把「① 结构化信息」挤下去
         （真机测试的「第一个分组默认展开」当场就红了）。用行号做结构断言。 */
      const lineOf = re => {
        const m = vjs.match(re);
        return m ? vjs.slice(0, m.index).split('\n').length : -1;
      };
      const lHot = lineOf(/if \(hot\) left\.appendChild\(pitFold\);/);
      const lFit = lineOf(/left\.appendChild\(fitPanel\(fitOf\(j\)\)\);/);
      const lInfo = lineOf(/left\.appendChild\(infoFold\);/);
      const lCold = lineOf(/if \(pitFold && pit\.level !== 'red' && pit\.level !== 'yellow'\) left\.appendChild\(pitFold\);/);
      ok('【29】红灯时避坑块的行号在「合适度」之前', lHot > 0 && lFit > 0 && lHot < lFit,
        'hot=' + lHot + ' fit=' + lFit);
      ok('【29】非红灯时避坑块排在「① 结构化信息」之后（不抢首屏、不抢第一个折叠组）',
        lCold > 0 && lInfo > 0 && lCold > lInfo, 'cold=' + lCold + ' info=' + lInfo);

      /* 真渲染一条带红线的岗位，查卡片上**真的**有徽章 */
      clearToasts();
      const jPit = Store.addJob({
        source: 'manual', title: '回归·避坑红线岗位', company: '回归测试公司P',
        url: 'https://www.zhipin.com/job_detail/reg_pit.html',
        rawJD: '入职需缴纳服装费 200 元，另收培训费 300 元。工作满三个月退还押金。',
      }).job;
      App.go('jobs');
      await tick();
      const cardPit = U.$$('#view .job, #view .jcard, #view .card').filter(c =>
        (c.textContent || '').indexOf('回归·避坑红线岗位') >= 0)[0];
      ok('【29】带红线的岗位卡片能渲染出来（前置）', !!cardPit);
      if (cardPit) {
        const badges = U.$$('.fbadge', cardPit).map(b => (b.textContent || '').trim());
        ok('【29】卡片上出现了「需注意」徽章（数字来自规则命中数）',
          badges.some(b => b.indexOf('需注意') >= 0), '实际徽章：' + badges.join(' / '));
        ok('【29】徽章用 bad 样式（红灯视觉上能区分）',
          U.$$('.fbadge.bad', cardPit).length > 0);
      }
      /* 打开详情，查「需注意」折叠块里**真的**列了原文和问法。
         用 .dwrap（detailContent 的根，项目里已有测试在用）而不是 #detailBody。 */
      Views.jobs.detail(jPit.id, function () { });
      await tick();
      const dRoot = U.$$('.dwrap')[0];
      ok('【29】详情抽屉能打开（前置）', !!dRoot,
        '没找到 .dwrap；实际 modal 数 = ' + U.$$('.modal').length);
      if (dRoot) {
        const dTxt = dRoot.textContent || '';
        ok('【29】详情里有「需注意」块', dTxt.indexOf('需注意') >= 0);
        ok('【29】详情里**列出了原文片段**（事实，可核对）',
          dTxt.indexOf('服装费') >= 0, '正文里没找到原文回引');
        ok('【29】详情里**给出了建议问法**（可执行）',
          dTxt.indexOf('💬') >= 0 && dTxt.indexOf('问') >= 0);
        ok('【29】详情里说明了「这是事实不是结论」',
          dTxt.indexOf('不是结论') >= 0 || dTxt.indexOf('规则会误报') >= 0);
      }
      U.closeAllModals();
      await tick();
      Store.removeJob(jPit.id);
      App.go('jobs');
      await tick();
    }
  }

  /* ==================================================================
     【30】S1 · 采集冲突台账 + 去重键补城市（第 37 轮）

     ⛔ 为什么这几条必须钉在**核心测试**里（而不是只留在
        `_验证_s1_冲突台账.js`）：核心测试是每次改动都会跑的主防线；
        只放独立脚本的话，将来有人重构 store.js 会把它们悄悄改坏而无感知。

     设计的核心取舍（这几条断言就是照它写的）：
       · **S1 只做"可见化"，不改合并结果** —— 老规矩「先写的赢」必须原样保留
         （断言会同时查冲突被记下 + 库里值没被新值覆盖，两条一起才说明白）
       · 只有"两边都有值且不同"才算冲突；旧值为空 = 回填，不算
       · 同岗位同字段只留一条（并进已存在那条），不堆条数
       · 有上限，不能无限涨（localStorage 撑爆不可逆）
     ================================================================== */
  {
    Store.init();
    const accS1 = 'unit_s1_' + Date.now();
    Store.createAccount(accS1);
    Store.switchAccount(accS1);

    /* ---- ① 表存在且为空 ---- */
    ok('【30】Store 暴露了 conflicts 相关 API',
      typeof Store.conflicts === 'function' && typeof Store.conflictCount === 'function' &&
      typeof Store.dismissConflict === 'function' && typeof Store.clearConflicts === 'function',
      'conflicts=' + typeof Store.conflicts + ' count=' + typeof Store.conflictCount);
    Store.clearConflicts();
    eq('【30】清空后冲突为 0（下面断言的前置必须是干净的）', Store.conflictCount(), 0);

    /* ---- ② 首次入库不产生冲突 ---- */
    const u1 = 'https://www.zhipin.com/job_detail/s1c001.html';
    Store.addJob({ url: u1, title: '短视频运营', company: '甲科技',
      location: '深圳·南山区', salaryText: '15-25K', rawJD: '负责抖音账号运营。' });
    eq('【30】首次入库无冲突', Store.conflictCount(), 0);

    /* ---- ③ 二次入库、薪资变了 → 记一条，且旧值新值都在 ---- */
    Store.addJob({ url: u1, title: '短视频运营', company: '甲科技',
      location: '深圳·南山区', salaryText: '20-30K', rawJD: '负责抖音账号运营，有爆款经验优先。' });
    eq('【30】薪资+JD 变化 → 记 1 条冲突', Store.conflictCount(), 1);
    const cf1 = Store.conflicts()[0];
    const j1 = Store.jobs().filter(j => j.url === u1)[0];
    ok('【30】冲突挂在正确的岗位 id 上', !!cf1 && cf1.jobId === j1.id,
      'cf.jobId=' + (cf1 && cf1.jobId) + ' job.id=' + j1.id);
    const fSal = cf1 && cf1.fields.filter(f => f.key === 'salaryText')[0];
    ok('【30】冲突同时留下了旧值与新值（这才叫"看得见"）',
      !!fSal && fSal.old === '15-25K' && fSal.new === '20-30K', JSON.stringify(fSal));
    /* ⛔ 这条和上一条必须**同时**成立，才说明"S1 只做可见化不改行为" */
    ok('【30】⛔ 合并结果仍是「先写的赢」（S1 不改行为，只记账）',
      j1.salaryText === '15-25K', 'got ' + j1.salaryText);

    /* ---- ④ 同字段再变 → 覆盖成最新，不堆条数 ---- */
    Store.addJob({ url: u1, title: '短视频运营', company: '甲科技',
      location: '深圳·南山区', salaryText: '25-35K' });
    eq('【30】同岗位同字段再次冲突 → 仍是 1 条（不堆条数）', Store.conflictCount(), 1);
    const fSal2 = Store.conflicts()[0].fields.filter(f => f.key === 'salaryText')[0];
    ok('【30】该字段被更新为最新一次的值', !!fSal2 && fSal2.new === '25-35K', JSON.stringify(fSal2));

    /* ---- ⑤ 完全一致 / 空值回填 都不算冲突 ---- */
    Store.addJob({ url: u1, title: '短视频运营', company: '甲科技',
      location: '深圳·南山区', salaryText: '25-35K' });
    eq('【30】完全一致 → 不新增冲突', Store.conflictCount(), 1);
    const u2 = 'https://www.zhipin.com/job_detail/s1c002.html';
    Store.addJob({ url: u2, title: '产品经理', company: '乙科技', location: '北京·海淀区' });
    Store.addJob({ url: u2, title: '产品经理', company: '乙科技',
      location: '北京·海淀区', salaryText: '30-40K' });
    eq('【30】旧值为空 = 回填，不算冲突', Store.conflictCount(), 1);

    /* ---- ⑥ addJobs 批量路径也必须记（两条独立代码路径，各测各的）---- */
    Store.addJobs([{ url: u2, title: '产品经理', company: '乙科技',
      location: '北京·海淀区', salaryText: '35-45K' }]);
    const cf2 = Store.conflicts().filter(c => c.jobId === Store.jobs().filter(j => j.url === u2)[0].id)[0];
    const fSalB = cf2 && cf2.fields.filter(f => f.key === 'salaryText')[0];
    ok('【30】⛔ addJobs 批量路径也记冲突（addJob/addJobs 是两套代码，都要钉）',
      !!fSalB && fSalB.old === '30-40K' && fSalB.new === '35-45K', JSON.stringify(fSalB));

    /* ---- ⑦ dismiss / clear ---- */
    const anyId = Store.conflicts()[0].id;
    const nBefore = Store.conflictCount();
    ok('【30】dismissConflict 真删（返回 true 且条数 -1）',
      Store.dismissConflict(anyId) === true && Store.conflictCount() === nBefore - 1,
      'before=' + nBefore + ' after=' + Store.conflictCount());
    ok('【30】dismiss 不存在的 id 返回 false 且不误删',
      Store.dismissConflict('__nope__') === false);

    /* ---- ⑧ 上限封顶 ---- */
    for (let i = 0; i < 520; i++) {
      const uu = 'https://www.zhipin.com/job_detail/s1cap' + i + '.html';
      Store.addJob({ url: uu, title: '岗' + i, company: '丁', location: '上海', salaryText: '10-20K' });
      Store.addJob({ url: uu, title: '岗' + i, company: '丁', location: '上海', salaryText: '11-21K' });
    }
    ok('【30】冲突条数被上限封顶（不能无限涨，localStorage 撑爆不可逆）',
      Store.conflictCount() <= 500, 'got ' + Store.conflictCount());

    /* ---- ⑨ 落盘 ----
       ⛔ 用 `localStorage` 而不是 `global.localStorage`：本文件跑在 vm 上下文里，
          `localStorage` 由沙箱提供（见文件顶部 sandbox 定义），而 `global` 在
          vm 上下文里**不等于**沙箱全局 → 写 `global.localStorage` 会 undefined 崩。
          （这里踩过一次：整块 async 抛异常，把后面所有断言都带走了。） */
    Store.flush ? Store.flush() : Store.save();
    const rawS1 = JSON.parse(localStorage.getItem('jobhunter.db.v1.' + accS1) || '{}');
    ok('【30】conflicts 表真的落进了 localStorage',
      Array.isArray(rawS1.conflicts) && rawS1.conflicts.length === Store.conflictCount(),
      'disk=' + (rawS1.conflicts || []).length + ' mem=' + Store.conflictCount());

    /* ---- ⑩ jobDedupeKey 补城市 ---- */
    const kSZ = Store.jobDedupeKey({ title: '销售', company: '丙', location: '深圳·福田区' });
    const kBJ = Store.jobDedupeKey({ title: '销售', company: '丙', location: '北京·朝阳区' });
    const kSZ2 = Store.jobDedupeKey({ title: '销售', company: '丙', location: '深圳·宝安区' });
    ok('【30】⛔ 同公司同岗位名、城市不同 → 去重键不同（老版会误并成一条）',
      kSZ !== kBJ, kSZ + ' vs ' + kBJ);
    eq('【30】同城不同区 → 仍是同一个键（只取城市段）', kSZ, kSZ2);
    eq('【30】无 location → 退化成老版键（不会把老库的键全改掉）',
      Store.jobDedupeKey({ title: '销售', company: '丙' }), 'n:丙||销售||');
    ok('【30】有 url 时走 url 键，不受城市逻辑影响',
      Store.jobDedupeKey({ url: 'https://x.com/a', title: '销售', company: '丙', location: '深圳' })
        .indexOf('u:') === 0);
    /* 真场景：同公司两地同名岗位必须能并存两条 */
    const n0 = Store.jobs().length;
    Store.addJob({ title: '销售', company: '丙公司', location: '深圳·福田区' });
    Store.addJob({ title: '销售', company: '丙公司', location: '北京·朝阳区' });
    eq('【30】⛔ 同公司两地同名岗位真的并存成两条（老版被误并成一条）',
      Store.jobs().length - n0, 2);

    Store.clearConflicts();
    Store.switchAccount('default');
  }
  /* ==================================================================
     【22】回退自证自身的守卫：每条变异的锚点必须**能匹配上**
     —— 血教训（2026-10-05）：㊿ 和 ⒃ 两条变异的锚点在代码演进后失配，
        自证脚本「静默跳过」它们，直到 10 分钟跑完才报「锚点失效」。
        更糟的是：如果没人看最后那两行，会以为「抓到 121/123 = 只差 2 条断言」，
        实际是「有 2 条变异压根没跑」—— 等于自证的有效性被悄悄削弱。
        所以把「锚点能不能匹配」提到第一层来守：失配时**1 秒内**就红，
        而且消息直接点出是哪个文件、哪条变异、锚点开头是什么。
        （自证脚本自己也会判锚点并 exit 1，但那是 10 分钟后的事。）
     ================================================================== */
  {
    const selfPath = path.join(DIR, '_回退自证.js');
    ok('_回退自证.js 存在（第三层验证的载体）', fs.existsSync(selfPath));
    const selfSrc = fs.readFileSync(selfPath, 'utf8');

    /* 把 MUTATIONS 数组整段抠出来，在沙箱里 eval 成真数组 —— 不引模块、不改自证脚本。
       用 new Function 而不是 JSON.parse：数组里是对象字面量 + 字符串拼接，不是 JSON。
       `MUTATIONS` 后面紧跟 `;` 与换行，取到第一个 `\n];` 为止。
       ⚠️ 数组里可以引用 `PACK_TWIN`（便携版孪生服务端的**绝对路径** —— 它在工作台目录
          之外，相对路径会被当成"文件不存在"而静默跳过）。所以这里必须把它当参数喂进去，
          否则整段 eval 会抛 "PACK_TWIN is not defined"，看起来像"自证脚本坏了"。 */
    const PACK_TWIN_PATH = PACK_DIR
      ? path.join(PACK_DIR, 'src', 'server_core.py')
      : path.join(DIR, '..', '_打包工程', 'src', 'server_core.py');
    let muts = null;
    try {
      const m = selfSrc.match(/const MUTATIONS\s*=\s*\[([\s\S]*?)\n\];/);
      if (m) muts = new Function('PACK_TWIN', 'return [' + m[1] + '];')(PACK_TWIN_PATH);
    } catch (e) {
      ok('能把 _回退自证.js 的 MUTATIONS 解析成数组', false, e.message);
    }
    ok('能解析出自证变异清单（数量 > 100）', Array.isArray(muts) && muts.length > 100,
      Array.isArray(muts) ? String(muts.length) : '没解析出来');

    if (Array.isArray(muts)) {
      const normalize = s => String(s).replace(/\r\n/g, '\n');
      const missing = [];
      muts.forEach(function (m2) {
        // 变异目标可以是仓库外的绝对路径（如 boss-crawler skill 里的 crawler.py）
        const fp = path.isAbsolute(m2.file) ? m2.file : path.join(DIR, m2.file);
        if (!fs.existsSync(fp)) { missing.push(m2.name + '（文件不存在：' + m2.file + '）'); return; }
        const enc = m2.enc || 'utf8';
        const src = fs.readFileSync(fp, enc);
        if (normalize(src).indexOf(normalize(m2.from)) < 0) {
          missing.push(m2.name + '（' + m2.file + ' 里找不到锚点）');
        }
        /* ⛔ 组合变异的第二个站点（`also`）**也必须检查** ——
           上一版只看 m.from，`also` 里的锚点过期了完全没人报，
           于是「组合变异」实际只剩一半（单层变异 = no-op = 静默漏检）。
           实例：【38-⑨】就是用它去删 view-conflicts 里那处 save 的。 */
        (m2.also || []).forEach(function (a2, ai) {
          const afp = path.isAbsolute(a2.file) ? a2.file : path.join(DIR, a2.file);
          if (!fs.existsSync(afp)) {
            missing.push(m2.name + ' 的 also[' + ai + ']（文件不存在：' + a2.file + '）');
            return;
          }
          const asrc = fs.readFileSync(afp, a2.enc || 'utf8');
          if (normalize(asrc).indexOf(normalize(a2.from)) < 0) {
            missing.push(m2.name + ' 的 also[' + ai + ']（' + a2.file + ' 里找不到锚点）');
          }
        });
      });
      ok('⛔ 自证的 ' + muts.length + ' 条变异锚点全部能匹配上（失配 = 静默漏检）',
        missing.length === 0,
        missing.length ? '失配 ' + missing.length + ' 条：' + missing.join('；') : '');

      /* 锚点还必须**唯一** —— replace 只改第一处，重复锚点会让变异打在错误的位置，
         结果是"改了但没改到位"，测试照样绿 → 假绿。 */
      const dup = [];
      muts.forEach(function (m2) {
        const fp = path.isAbsolute(m2.file) ? m2.file : path.join(DIR, m2.file);
        if (!fs.existsSync(fp)) return;
        const src = normalize(fs.readFileSync(fp, m2.enc || 'utf8'));
        const from = normalize(m2.from);
        if (!from) return;
        const n = src.split(from).length - 1;
        if (n > 1) dup.push(m2.name + '（在 ' + m2.file + ' 里出现 ' + n + ' 次）');
      });
      ok('自证变异锚点全部唯一（重复锚点会让 replace 打偏 → 假绿）',
        dup.length === 0, dup.length ? dup.join('；') : '');

      /* ⛔⛔ 自证脚本**必须**把"只有锚点守卫红"算成漏检。
         否则：变异一改文件，上面那条锚点守卫必然变红 ⇒ 只看 `!r.ok` 会把 268 条
         **全部**判成"抓到"，自证等于摆设。这是本项目铁律点名的假绿形态之一。
         （实测：2026-10-12 新增的 19 条，只看 !r.ok 是 21/21；
           剔除守卫后才知道功能断言有没有真的红 —— 那次结论是 21/21 真红。） */
      ok('⛔ _回退自证.js 把「只有锚点守卫红」按漏检计（否则 268 条会被判成全部抓到 = 自证是摆设）',
        /const GUARD_PAT\s*=\s*\/变异锚点全部能匹配上/.test(selfSrc) &&
        /const isCaught = !r\.ok && realFails\.length > 0;/.test(selfSrc) &&
        /guardOnly\+\+/.test(selfSrc));
      /* 守卫的判定字样必须与上面那两条断言名对得上 —— 只改一边 = 守卫失效，
         而失效的方向很危险：它会退回"268 条全判成抓到"。所以把这条也钉住。 */
      const gpSrc = (selfSrc.match(/const GUARD_PAT\s*=\s*(\/.*\/);/) || [])[1] || '';
      let gp = null;
      try { gp = new Function('return ' + gpSrc + ';')(); } catch (e) { gp = null; }
      const guardNames = [
        '⛔ 自证的 ' + muts.length + ' 条变异锚点全部能匹配上（失配 = 静默漏检）',
        '自证变异锚点全部唯一（重复锚点会让 replace 打偏 → 假绿）',
      ];
      ok('⛔ 自证脚本的 GUARD_PAT 能认出本文件这两条守卫断言（认不出 = 守卫被当成功能断言 → 假绿）',
        !!gp && guardNames.every(n => gp.test(n)),
        'GUARD_PAT=' + (gpSrc || '（没抠到）') + ' / 认出 '
        + (gp ? guardNames.filter(n => gp.test(n)).length : 0) + ' / 2');
    }
  }

  /* ==================================================================
     【31】S1-B · 采集冲突待处理面板（第 38 轮）

     前置：【30】已把 S1 数据层钉死（冲突会被记录、旧值新值都在）。
     【31】钉的是 **S1 的收尾** —— 让那批数据真正在界面上可见、可处理。

     ⛔ 为什么这一块必须存在：
        S1 落盘后 `DB.conflicts` 只写不读 —— 没有任何视图调 `Store.conflicts()`。
        等于把「静默丢弃」换成了「静默记录」，从用户视角问题**依然没解决**。
        这块断言就是钉住"数据能被看见、并且能被处理"。

     两类断言缺一不可：
       · **结构类**：真渲染节点、真 querySelectorAll —— 不靠源码字符串子串
         （血教训：判"源码里有没有某串"会被注释/死分支骗过）
       · **行为类**：真调采纳/忽略，查岗位字段真的变了、冲突真的被摘掉

     ⛔ 本块踩过的坑（都写进断言了）：
       · 全局名是 **Exporter** 不是 Export（写错被 try/catch 静默吞掉）
       · normJob **不从 salaryText 反推** salaryMin/Max → 采纳薪资必须联动
       · 撤「不落盘」的变异必须**组合**（单点改会被后面的 save 顺手补上）
       · 判落盘要等 260ms 防抖跑完，且**不能自己调 flush**（那等于替被测补落盘）
     ================================================================== */
  {
    Store.init();
    const accS1B = 'unit_s1b_' + Date.now();
    Store.createAccount(accS1B);
    Store.switchAccount(accS1B);

    ok('【31】view-conflicts.js 已加载并挂到 window.Views.conflicts',
      !!(Views && Views.conflicts) &&
      typeof Views.conflicts.open === 'function' &&
      typeof Views.conflicts.entryChip === 'function' &&
      typeof Views.conflicts.adoptField === 'function',
      'Views.conflicts=' + typeof (Views && Views.conflicts));
    /* ⛔ 这条断言最初写的是「view-conflicts.js 必须排在 view-jobs.js **之前**」——
       那是**错的**，实测发现补丁把它插在了 view-collect.js 之前（第 93 行），
       位置在 view-jobs.js（第 88 行）**之后**。
       查证后确认：加载顺序**无关紧要**，因为 view-jobs.js 里的引用是
       **惰性**的（`if (!global.Views.conflicts) return null;` 在**调用时**才读），
       不是加载时就解引用。所以我改的是**断言**（回到真实必要约束），
       没有为了迁就断言去改产品顺序 —— 那属于「断言的名字比断言本身强」的反面。 */
    ok('【31】index.html 真的引用了 view-conflicts.js（且与 view-jobs.js 都在同一批脚本里）',
      indexHtml.indexOf('js/view-conflicts.js') >= 0 &&
      indexHtml.indexOf('js/view-jobs.js') >= 0);
    /* 真正必要的那条：view-jobs.js 对 conflicts 模块的引用必须是**惰性**的，
       否则一旦加载顺序反了就会在启动时炸。这条钉住"不许改成加载时解引用"。 */
    ok('【31】⛔ view-jobs.js 对 Views.conflicts 的引用是惰性守卫（加载顺序就无所谓了）',
      /if\s*\(\s*!global\.Views\.conflicts\s*\)\s*return\s+null/.test(
        fs.readFileSync(path.join(DIR, 'js', 'view-jobs.js'), 'utf8')));

    const VC = Views.conflicts;

    /* ---------- ① 入口徽章：无冲突时必须彻底消失 ---------- */
    Store.clearConflicts();
    eq('【31】前置：无冲突', VC.pendingCount(), 0);
    /* ⛔ 断言"返回 null"而不是"渲染出 0"：这个徽章是待办性质，
       常态下应该不占位。挂一个「⚖ 冲突 0」在那儿只会变噪音。 */
    ok('【31】⛔ 无冲突时入口徽章是 null（不占位、不打扰）',
      VC.entryChip(function () {}) === null,
      'got ' + String(VC.entryChip(function () {})));

    /* ---------- ② 造两条冲突（字段数不同，好验逐字段渲染） ---------- */
    const bU1 = 'https://www.zhipin.com/job_detail/s1bT001.html';
    Store.addJob({ url: bU1, title: '短视频运营', company: '甲科技',
      location: '深圳·南山区', salaryText: '15-25K' });
    Store.addJob({ url: bU1, title: '短视频运营', company: '甲科技',
      location: '深圳·宝安区', salaryText: '20-30K' });   // 薪资 + 地点都变
    const bU2 = 'https://www.zhipin.com/job_detail/s1bT002.html';
    Store.addJob({ url: bU2, title: '产品经理', company: '乙科技',
      location: '北京·海淀区', salaryText: '30-40K' });
    Store.addJob({ url: bU2, title: '产品经理', company: '乙科技',
      location: '北京·海淀区', salaryText: '35-45K' });    // 只有薪资变
    eq('【31】前置：造出 2 条冲突', VC.pendingCount(), 2);

    /* ---------- ③ 入口徽章承载真实条数 ---------- */
    const bChip = VC.entryChip(function () {});
    ok('【31】有冲突时入口徽章是节点（不是 null）', !!bChip && bChip.nodeType === 1);
    ok('【31】⛔ 徽章上写着真实条数 2（写死常量 / 写死 0 都会红）',
      String(bChip.textContent).indexOf('2') >= 0, 'text=' + JSON.stringify(bChip.textContent));
    /* ⛔ 用属性判，不判"文案里出现过 ⚖" —— 后者换个图标就失效 */
    ok('【31】徽章带 data-cf-entry=1（测试与真机都靠它收窄，不靠文案）',
      bChip.getAttribute('data-cf-entry') === '1');

    /* ---------- ④ 真渲染面板：结构必须对 ---------- */
    let bh = null;
    try { bh = VC.open(function () {}); }
    catch (e) { ok('【31】⛔ open() 不能抛异常（抛了整个面板就废了）', false, e.message); }
    ok('【31】open() 返回弹窗句柄（含 body / close）',
      !!bh && !!bh.body && typeof bh.close === 'function');

    if (bh) {
      const bCards = U.$$('[data-cf-job]', bh.body);
      eq('【31】⛔ 面板渲染出 2 张岗位冲突卡（不多不少）', bCards.length, 2);
      /* ⛔ 收窄到弹窗容器：全页 U.$$('button') 会把筛选栏/工具栏按钮一起扫进来 */
      const bRows = U.$$('[data-cf-field]', bh.body);
      eq('【31】⛔ 字段行总数 = 薪资×2 + 地点×1 = 3', bRows.length, 3);

      const bJ1 = Store.jobs().filter(j => j.url === bU1)[0];
      const bCard1 = bCards.filter(n => n.getAttribute('data-cf-job') === bJ1.id)[0];
      ok('【31】⛔ 同岗位的字段挂在自己那张卡里（不串卡）',
        !!bCard1 && U.$$('[data-cf-field]', bCard1).length === 2,
        'got ' + (bCard1 ? U.$$('[data-cf-field]', bCard1).length : 'no-card'));
      const bJ2 = Store.jobs().filter(j => j.url === bU2)[0];
      const bCard2 = bCards.filter(n => n.getAttribute('data-cf-job') === bJ2.id)[0];
      ok('【31】另一张卡里只有 1 个字段（薪资）',
        !!bCard2 && U.$$('[data-cf-field]', bCard2).length === 1);
      /* 面板挂在 .mask 里（真机点按钮要靠这个容器收窄） */
      ok('【31】⛔ 面板挂在 .mask 弹窗容器里', !!document.querySelector('.mask'));
      bh.close(true);
    }

    /* ---------- ⑤ 采纳：唯一会改数据的动作 ---------- */
    const bJ1Id = Store.jobs().filter(j => j.url === bU1)[0].id;
    /* ⛔⛔ 记下采纳前的岗位总数 —— 下面要钉「采纳不许多造岗位」。
       只查 `pendingCount()` 是不够的，原因见紧接着那条注释。 */
    const bJobsBeforeAdopt = Store.jobs().length;
    ok('【31】采纳薪资返回 true（真的改了）', VC.adoptField(bJ1Id, 'salaryText') === true);
    /* ⛔⛔ 为什么「pendingCount 不变」抓不到「采纳走 addJob」：
       addJob 造出来的是**新 id 的岗位**，冲突台账里没有它的记录
       ⇒ pendingCount 照样是 2 ⇒ 上一版那条断言照样绿（实测【38-⑦】就是这么假绿的）。
       而 addJob 每采纳一次就多一条"幽灵岗位"（新值被写进一条新记录，旧记录原封不动），
       所以必须直接数岗位总数。 */
    eq('⛔⛔【31】采纳不能多造岗位（走 updateJob 而非 addJob —— 否则每采纳一次多一条幽灵岗位）',
      Store.jobs().length, bJobsBeforeAdopt);
    const bJ1b = Store.job(bJ1Id);
    ok('【31】⛔ 采纳后岗位的 salaryText 变成新值',
      bJ1b.salaryText === '20-30K', 'got ' + bJ1b.salaryText);
    /* ⛔⛔ normJob 对 salaryMin/Max 是 U.asNum(j.salaryMin)，**不从 salaryText 反推**。
       只 patch salaryText → 「显示按文本 / 筛选按 minmax」两边打架。
       （这条真抓到过 bug：模块里把全局名写成 Export（应为 Exporter），
         TypeError 被 try/catch 吞掉，min/max 全 null，只有这条断言看得见。） */
    ok('【31】⛔⛔ 采纳薪资必须联动 salaryMin/salaryMax（只改文本 = 显示与筛选打架）',
      bJ1b.salaryMin === 20 && bJ1b.salaryMax === 30,
      'min=' + bJ1b.salaryMin + ' max=' + bJ1b.salaryMax + '（期望 20/30）');

    const bCfA = Store.conflicts().filter(c => c.jobId === bJ1Id)[0] || null;
    ok('【31】⛔ 已采纳字段从冲突里摘掉',
      !!bCfA && !bCfA.fields.some(f => f.key === 'salaryText'));
    ok('【31】⛔ 同岗位其他字段仍留着（不能因为采纳一个就把整条删掉）',
      !!bCfA && bCfA.fields.some(f => f.key === 'location'),
      bCfA ? bCfA.fields.map(f => f.key).join(',') : '整条没了');
    /* ⛔ 防坑 2：采纳动作本身**不能**再制造新冲突（否则死循环） */
    eq('【31】⛔⛔ 采纳动作不再产生新冲突（走 updateJob 而非 addJob）', VC.pendingCount(), 2);

    VC.adoptField(bJ1Id, 'location');
    const bJ1c = Store.job(bJ1Id);
    ok('【31】采纳地点后 location 变成新值',
      bJ1c.location === '深圳·宝安区', 'got ' + bJ1c.location);
    eq('【31】⛔ 该岗位字段全采纳完 → 整条冲突被删（2 → 1）', VC.pendingCount(), 1);

    /* ---------- ⑥ 底层 updateJob 返回 null → 采纳必须返回 false ----------
       构造：**绕开 aliveConflicts 的前置过滤**，直接让冲突指向已不在库的 jobId
       （模拟"面板打开后，另一个标签页把岗位删了"）。
       正常 UI 路径下 aliveConflicts 已过滤掉这种条目，
       但 adoptField 作为 API 必须自己扛住 —— 否则返回 true 会让调用方
       以为采纳成功、还顺手摘掉冲突，实际什么都没写。 */
    Store.clearConflicts();
    const bG = 'https://www.zhipin.com/job_detail/s1bT301.html';
    Store.addJob({ url: bG, title: 'G岗', company: '戊', salaryText: '10-20K' });
    const bGId = Store.jobs().filter(j => j.url === bG)[0].id;
    Store.addJob({ url: bG, title: 'G岗', company: '戊', salaryText: '12-22K' });
    Store.removeJob(bGId);   // 岗位没了，冲突还留着
    ok('【31】前置：岗位已删但冲突仍在（模拟并发删除）',
      !Store.job(bGId) && Store.conflicts().some(c => c.jobId === bGId));
    ok('【31】⛔⛔ 对"冲突还在但岗位已删"的条目采纳 → 必须返回 false（不能假装成功）',
      VC.adoptField(bGId, 'salaryText') === false);
    ok('【31】⛔ 失败的采纳不能把冲突顺手摘掉（数据留着让用户能看到）',
      Store.conflicts().some(c => c.jobId === bGId && c.fields.some(f => f.key === 'salaryText')));

    /* ---------- ⑦ 岗位被删 → 面板不能显示它的冲突 ---------- */
    Store.clearConflicts();
    const bD = 'https://www.zhipin.com/job_detail/s1bT401.html';
    Store.addJob({ url: bD, title: 'D岗', company: '丁', salaryText: '10-20K' });
    Store.addJob({ url: bD, title: 'D岗', company: '丁', salaryText: '12-22K' });
    eq('【31】前置：1 条冲突', VC.pendingCount(), 1);
    Store.removeJob(Store.jobs().filter(j => j.url === bD)[0].id);
    eq('【31】⛔ 岗位被删后，面板条数跟着归零（幽灵冲突不显示）', VC.pendingCount(), 0);
    ok('【31】⛔ aliveConflicts 里不含已删岗位（防 updateJob 一个不存在的 id 静默失败）',
      VC.aliveConflicts().every(c => !!Store.job(c.jobId)));

    /* ---------- ⑧ 薪资无法解析 → 不许"半采纳" ----------
       ⛔ normJob 不从 salaryText 反推 min/max。解析不出端点却仍写 salaryText，
       就会得到「有薪资文本、没有 min/max」——界面显示一个数、筛选按另一个口径。
       正解是整条拒绝（返回 false），而不是改一半。 */
    Store.clearConflicts();
    const bY = 'https://www.zhipin.com/job_detail/s1bT501.html';
    Store.addJob({ url: bY, title: 'Y岗', company: '己', salaryText: '15-25K' });
    Store.addJob({ url: bY, title: 'Y岗', company: '己', salaryText: '面议' });   // 解析不出端点
    const bYId = Store.jobs().filter(j => j.url === bY)[0].id;
    const bYCf = Store.conflicts().filter(c => c.jobId === bYId)[0] || null;
    ok('【31】前置：薪资文本变化被记成冲突（new = 面议）',
      !!bYCf && bYCf.fields.some(f => f.key === 'salaryText' && f.new === '面议'));
    const bYSal = Store.job(bYId).salaryText;
    ok('【31】⛔⛔ 薪资解析不出端点 → 采纳返回 false（不许半采纳）',
      VC.adoptField(bYId, 'salaryText') === false);
    ok('【31】⛔ 半采纳的代价：salaryText 不能被改',
      Store.job(bYId).salaryText === bYSal,
      'got ' + Store.job(bYId).salaryText + '（原 ' + bYSal + '）');
    ok('【31】⛔ 冲突仍在（拒绝采纳不等于把冲突丢掉）',
      Store.conflicts().some(c => c.jobId === bYId && c.fields.some(f => f.key === 'salaryText')));

    /* ---------- ⑨ JD 文本字段不许采纳 ----------
       recordConflicts 对 rawJD 只存「（N 字）」摘要，**不存正文** →
       拿不到新 JD 全文，点了必然改不了。这时必须返回 false 而不是假装成功。 */
    Store.clearConflicts();
    const bJd = 'https://www.zhipin.com/job_detail/s1bT601.html';
    Store.addJob({ url: bJd, title: 'C岗', company: '丙', rawJD: 'aaaa' });
    Store.addJob({ url: bJd, title: 'C岗', company: '丙', rawJD: 'aaaaaaaaaaaaaaaaaaaa' });
    const bJdId = Store.jobs().filter(j => j.url === bJd)[0].id;
    const bJdCf = Store.conflicts().filter(c => c.jobId === bJdId)[0] || null;
    ok('【31】前置：JD 变化被记成冲突', !!bJdCf && bJdCf.fields.some(f => f.key === 'rawJD'));
    ok('【31】⛔ JD 采纳返回 false（正文没留存，不能假装改成功）',
      VC.adoptField(bJdId, 'rawJD') === false);

    /* ---------- ⑩ 忽略出口 ---------- */
    Store.clearConflicts();
    const bW1 = 'https://www.zhipin.com/job_detail/s1bT701.html';
    Store.addJob({ url: bW1, title: 'A岗', company: '甲', salaryText: '10-20K' });
    Store.addJob({ url: bW1, title: 'A岗', company: '甲', salaryText: '12-22K' });
    const bW2 = 'https://www.zhipin.com/job_detail/s1bT702.html';
    Store.addJob({ url: bW2, title: 'B岗', company: '乙', salaryText: '10-20K' });
    Store.addJob({ url: bW2, title: 'B岗', company: '乙', salaryText: '12-22K' });
    /* ⛔ 忽略类断言的前置必须**非空** —— 空表分辨不出"清了"和"本来就空" */
    eq('【31】前置：2 条冲突（不清空则断言不出"真删了"）', VC.pendingCount(), 2);
    ok('【31】dismiss 单条后条数 -1',
      Store.dismissConflict(Store.conflicts()[0].id) === true && VC.pendingCount() === 1);
    const bCleared = Store.clearConflicts();
    ok('【31】⛔ clearConflicts 返回真删掉的条数（不能返回 0 蒙混）',
      bCleared === 1 && VC.pendingCount() === 0, 'cleared=' + bCleared);
    ok('【31】清空后入口徽章重新变回 null', VC.entryChip(function () {}) === null);

    /* ---------- ⑪ 工具函数 ---------- */
    ok('【31】fmtVal 空值显示为（空）而不是 undefined/null',
      VC._fmtVal('location', '') === '（空）' && VC._fmtVal('location', null) === '（空）');
    ok('【31】fmtVal 薪资数字补 K 单位', VC._fmtVal('salaryMin', 20) === '20K');
    const bZ = 'https://www.zhipin.com/job_detail/s1bT801.html';
    Store.clearConflicts();
    Store.addJob({ url: bZ, title: 'Z岗', company: '丁', salaryText: '10-20K' });
    Store.addJob({ url: bZ, title: 'Z岗', company: '丁', salaryText: '15-25K' });
    const bZCard = VC._conflictCard(Store.conflicts()[0],
      Store.jobs().filter(j => j.url === bZ)[0], function () {});
    ok('【31】_conflictCard 产出真节点且带 data-cf-job',
      !!bZCard && bZCard.nodeType === 1 && !!bZCard.getAttribute('data-cf-job'));
    ok('【31】⛔ 卡里字段行数与冲突字段数一致',
      U.$$('[data-cf-field]', bZCard).length === Store.conflicts()[0].fields.length,
      'rows=' + U.$$('[data-cf-field]', bZCard).length);

    Store.clearConflicts();
    Store.switchAccount('default');
  }

  /* ==================================================================
     【31.1】⛔ 采纳必须真落盘（只改内存 = 刷新就丢，用户以为改了）
     ------------------------------------------------------------------
     ⛔ 这条**必须单独一段、单独账号**，不能混在【31】里：
        只要流程里还有 dismissConflict / addJob 在跑，它们各自的 save()
        会把直改的内容**顺手落盘**，于是"没走 updateJob"就看不出来。
        （实测：把这条塞在采纳流程中间时，组合变异"完全不落盘"照样绿。）
     ⛔ 也不能自己调 Store.flush() 再看盘 —— 那等于**替被测补上落盘**。
        正解：让 Store 自己的 260ms 防抖定时器真的跑完，再读盘。
        所以这一段是 **async**；主流程末尾会 await 它。
     ================================================================== */
  async function s1bDurability() {
    /* 由下面直接 await 调用。为什么是独立 async 函数而不是内联 await：
       这样【31】同步块能拿到自己的语句块作用域（const bJ1 ... 不会和别处撞名），
       而落盘检查又能真的等 260ms 防抖跑完。 */
    const accDisk = 'unit_s1b_disk_' + Date.now();
    Store.createAccount(accDisk);
    Store.switchAccount(accDisk);
    const dU = 'https://www.zhipin.com/job_detail/s1bT901.html';
    Store.addJob({ url: dU, title: '盘岗', company: '庚',
      location: '广州·天河区', salaryText: '10-20K' });
    Store.addJob({ url: dU, title: '盘岗', company: '庚',
      location: '广州·越秀区', salaryText: '12-22K' });
    const dId = Store.jobs().filter(j => j.url === dU)[0].id;
    /* 先把「采纳前」的基线刷出来，并清掉待写的防抖定时器 */
    Store.flush ? Store.flush() : Store.save();
    const dBefore = JSON.parse(localStorage.getItem('jobhunter.db.v1.' + accDisk) || '{}');
    const dBeforeJob = (dBefore.jobs || []).filter(j => j.id === dId)[0];
    ok('【31.1】前置：采纳前磁盘上是旧值（否则断言不出"这次真的写了"）',
      !!dBeforeJob && dBeforeJob.salaryText === '10-20K',
      'disk=' + (dBeforeJob ? dBeforeJob.salaryText : 'no-job'));

    /* 只采纳**一个**字段：salary。location 还留着 → 走 else 分支（不 dismiss） */
    const dAdopt = Views.conflicts.adoptField(dId, 'salaryText') === true;
    const dCf = Store.conflicts().filter(c => c.jobId === dId)[0] || null;
    ok('【31.1】只采纳 salary，且该岗位仍留着 location 未处理（走 else 分支，不触发 dismiss）',
      dAdopt && !!dCf && dCf.fields.some(f => f.key === 'location'),
      'adopt=' + dAdopt + ' 剩余=' + (dCf ? dCf.fields.map(f => f.key).join(',') : '整条没了'));

    await new Promise(r => setTimeout(r, 420));   // > 260ms 防抖窗口

    const dAfter = JSON.parse(localStorage.getItem('jobhunter.db.v1.' + accDisk) || '{}');
    const dJob = (dAfter.jobs || []).filter(j => j.id === dId)[0];
    ok('【31.1】⛔⛔ 采纳后的新值已落进 localStorage（只改内存 = 刷新就丢）',
      !!dJob && dJob.salaryText === '12-22K' && dJob.salaryMin === 12,
      'disk=' + (dJob ? dJob.salaryText + ' min=' + dJob.salaryMin : 'no-job'));

    Store.switchAccount('default');
  }

  /* ==================================================================
     【39】第 2 步结构性小修（P1-3 / P1-4 / P1-5 / P1-7 / P1-8 / P1-9 / P1-10 + P2-1）
     ------------------------------------------------------------------
     这批改动的共同点：修的都是**安静失效** —— 出问题时界面看起来完全正常，
     用户只会觉得「点了没反应 / 刷新就没了 / 明明关着却发出去了」。
     所以每条都必须有一个能真的把那个安静失效照出来的断言，
     而不是只查「源码里出现过某个字符串」。
     ⛔ 服务端（采集器/server.py）与便携版孪生（_打包工程/src/server_core.py）**各断言一遍**：
        只修一份 = 用户那份没修（便携版把服务端打包进 exe）。
     ================================================================== */
  async function s39Step2() {
    /* ---------------- 39.1 服务端源码：两份孪生逐条钉住 ---------------- */
    {
      const rd39 = rel => fs.readFileSync(path.isAbsolute(rel) ? rel : path.join(DIR, rel), 'utf8');
      ok('【39】打包工程目录已解析（否则孪生那份会被静默跳过 = 假绿）', !!PACK_DIR, String(PACK_DIR));
      const twins39 = [['采集器/server.py', rd39('采集器/server.py')]];
      if (PACK_DIR) twins39.push(['_打包工程/src/server_core.py', rd39(path.join(PACK_DIR, 'src', 'server_core.py'))]);

      twins39.forEach(function (pair) {
        const rel = pair[0], s = pair[1];

        /* ---- P1-3：退出时不抹掉别的实例的运行文件 ---- */
        ok('【39】' + rel + ' 有 INSTANCE_ID = secrets.token_hex(8)（实例归属标记）',
          /^INSTANCE_ID\s*=\s*secrets\.token_hex\(8\)/m.test(s));
        ok('【39】' + rel + ' write_status 里写了 instance 字段（否则认领无从谈起）',
          /def write_status\([\s\S]{0,1200}?['"]instance['"]\s*:\s*INSTANCE_ID/.test(s));
        ok('【39】' + rel + ' 有 _runtime_files_are_mine()',
          /def _runtime_files_are_mine\(\)/.test(s));
        ok('【39】' + rel + ' cleanup_runtime_files() 第一步就验归属，不是自己的直接 return',
          /def cleanup_runtime_files\([\s\S]{0,400}?if not _runtime_files_are_mine\(\):[\s\S]{0,200}?return/.test(s));
        ok('【39】' + rel + ' 认领时比对 pid 文件（老版本 status 没 instance 也能兜住）',
          /def _runtime_files_are_mine\([\s\S]{0,1400}?PID_PATH[\s\S]{0,300}?str\(ROOT_PID or os\.getpid\(\)\)/.test(s));
        ok('【39】' + rel + ' 退出改 status 时摘掉 instance（作废标记，免得下次又被当成自己）',
          /prev\.pop\(['"]instance['"]/.test(s));

        /* ---- P1-4：taskkill 真看返回码 + 看门狗兜底 ---- */
        ok('【39】' + rel + ' stop_task 真读 taskkill 的返回码（不再 capture_output 丢掉）',
          /subprocess\.run\(\['taskkill'[\s\S]{0,240}?encoding='utf-8'[\s\S]{0,160}?rc = r\.returncode/.test(s));
        ok('【39】' + rel + ' 并按返回码区分提示文案（rc 非 0 时说明在兜底处理）',
          /rc in \(None, 0\)[\s\S]{0,200}?taskkill 返回码/.test(s));
        ok('【39】' + rel + ' 有 _stop_watchdog 且 stop_task 真的挂上它',
          /def _stop_watchdog\(task, proc\)/.test(s) &&
          /threading\.Thread\(target=_stop_watchdog/.test(s));
        ok('【39】' + rel + ' 看门狗强制结束时用 exit_code = -1（0 会被读成「采集成功」）',
          /def _stop_watchdog\([\s\S]{0,1800}?task\.exit_code = -1/.test(s));
        ok('【39】' + rel + ' 看门狗从我们这端关掉读管道（让卡在 readline 的 _pump 立刻退出）',
          /def _stop_watchdog\([\s\S]{0,1200}?proc\.stdout\.close\(\)/.test(s));

        /* ---- P1-5：限流真的长在服务端 ---- */
        ok('【39】' + rel + ' 有 greet_conf() / greet_log() / greet_record() / _greet_rate_gate()',
          /def greet_conf\(\)/.test(s) && /def greet_log\(\)/.test(s) &&
          /def greet_record\(job_id, url\)/.test(s) && /def _greet_rate_gate\(payload\)/.test(s));
        ok('【39】' + rel + ' ‼ _greet_gate 第一件事就是读服务端那份配置（没同步过 → 直接拒）',
          /def _greet_gate\(payload\):[\s\S]{0,1500}?conf = greet_conf\(\)[\s\S]{0,200}?if conf is None:/.test(s));
        ok('【39】' + rel + ' _greet_gate 里开关关了就直接拒（不再只是前端那遍）',
          /if not conf\.get\(['"]autoGreet['"]\):/.test(s));
        ok('【39】' + rel + ' _greet_gate 真的调了 _greet_rate_gate（不是空函数）',
          /def _greet_gate\(payload\):[\s\S]{0,2400}?rate_ok, rate_why = _greet_rate_gate\(payload\)/.test(s));
        ok('【39】' + rel + ' 限流三条齐：最小间隔 / 同岗位冷却 / 单日上限',
          /两次自动打招呼至少间隔/.test(s) &&
          /小时内已经自动打过招呼/.test(s) &&
          /服务端单日上限/.test(s));
        ok('【39】' + rel + ' /api/greet-conf 路由存在且走到 _set_greet_conf',
          /path == '\/api\/greet-conf'[\s\S]{0,80}self\._set_greet_conf\(/.test(s));
        ok('【39】' + rel + ' _set_greet_conf 只收白名单字段、写完落 GREET_CONF_PATH',
          /def _set_greet_conf\(self, payload\):[\s\S]{0,1600}?write_json\(GREET_CONF_PATH, conf\)/.test(s));
        ok('【39】' + rel + ' 打招呼成功后由服务端记台账（前端计时器挡不住伪造请求）',
          /greet_record\(payload\.get\(['"]jobId['"]\), payload\.get\(['"]url['"]\)\)/.test(s));
      });
    }

    /* ---------------- 39.2 P1-8：被顶掉的那一路必须收到 'superseded' ---------------- */
    {
      const savedBase8 = VC._state.base;
      VC._state.base = 'http://127.0.0.1:8738/';
      const got8 = [];
      await withFetch(function () {
        /* /api/task 一直说「有任务在跑」→ 两条 poll 谁都不会自己放弃，
           于是第 2 条**只能**通过「顶掉前一条」这条路来打断它。 */
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            ok: true, task: { key: 'p18', running: true, total: 0, lines: [] },
          })),
        });
      }, function () {
        return new Promise(function (resolve) {
          VC._poll(null, function (why) { got8.push('A:' + why); });
          VC._poll(null, function (why) { got8.push('B:' + why); });
          setTimeout(resolve, 40);
        });
      });
      ok('【39】P1-8：第 1 条 poll 被第 2 条顶掉时必须收到 superseded（而不是永久挂着 → 按钮永久禁用）',
        got8.indexOf('A:superseded') >= 0, JSON.stringify(got8));
      ok('【39】P1-8：被顶掉的是**前一条**，后一条仍在跑（不该顺手把新的也掐了）',
        got8.indexOf('B:superseded') < 0, JSON.stringify(got8));
      VC._state.pendingFail = null;
      VC._state.taskRunning = null;
      VC._state.base = savedBase8;
    }

    /* ---------------- 39.3 P1-9：「■ 停止」跟着**实时**任务状态出现 ---------------- */
    {
      /* ⛔ `#cActions` 是运行时创建的（不在 index.html 里，见 _测试_核心.js 的 DYNAMIC_IDS）。
         这里要单独驱动它，所以先确保页面上有一个该容器可用。 */
      let host9 = U.$('#cActions');
      const injected9 = !host9;
      if (!host9) {
        host9 = document.createElement('div');
        host9.id = 'cActions';
        document.body.appendChild(host9);
      }
      const has9 = () => Array.prototype.some.call(
        host9.querySelectorAll('button'),
        b => (b.textContent || '').indexOf('停止') >= 0);

      const savedPing9 = VC._state.ping;
      const savedRun9 = VC._state.taskRunning;
      const savedBase9 = VC._state.base;

      VC._state.ping = { login: { value: 'ok' } };
      VC._state.taskRunning = false;
      VC._paintActions();
      ok('【39】P1-9：没有任务在跑时**不该**出现「■ 停止」', !has9());
      VC._state.taskRunning = true;
      VC._paintActions();
      ok('【39】P1-9：有任务在跑时出现「■ 停止」', has9());
      VC._state.taskRunning = null;
      VC._state.ping = { login: { value: 'ok' }, busy: true };
      VC._paintActions();
      ok('【39】P1-9：还没轮询过就用 ping.busy 兜底（进页面时后台已有任务也看得到）', has9());

      /* ⛔ 这条是重点（评审原话：自己发起的采集**永远**看不到「■ 停止」）：
         必须由 **poll 每轮**把实时的 running 同步过来 —— 按钮不去读渲染快照。 */
      VC._state.taskRunning = false;
      VC._state.ping = { login: { value: 'ok' } };
      VC._state.base = 'http://127.0.0.1:8738/';
      await withFetch(function () {
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({
            ok: true, task: { key: 'p19', running: true, total: 0, lines: [] },
          })),
        });
      }, function () {
        return new Promise(function (resolve) {
          VC._poll(null, function () { /* 故意不理会：这条只测按钮行 */ });
          setTimeout(resolve, 40);
        });
      });
      ok('【39】P1-9：⛔ 轮询把**实时** running 同步给了按钮行（否则自己发起的采集永远看不到「■ 停止」）',
        VC._state.taskRunning === true && has9(),
        'taskRunning=' + VC._state.taskRunning + ' / 有停止按钮=' + has9());

      VC._state.pendingFail = null;
      VC._state.base = savedBase9;
      VC._state.taskRunning = savedRun9;
      VC._state.ping = savedPing9;
      if (injected9) {
        /* ⚠️ 测试环境的 DOM 是个精简实现，**没有** `Element.remove()`
           （直接调它会抛 "host9.remove is not a function" 把整段异步流程带崩），
           所以走标准的 parentNode.removeChild。 */
        if (host9.parentNode) host9.parentNode.removeChild(host9);
      } else {
        VC._paintActions();
      }
    }

    /* ---------------- 39.4 P1-5 前端：开关一变就同步给服务端 ---------------- */
    {
      const savedBase5 = VC._state.base;
      VC._state.base = 'http://127.0.0.1:8738/';
      let hit5 = null;
      await withFetch(function (url, init) {
        if (String(url).indexOf('/api/greet-conf') >= 0) {
          hit5 = { url: String(url), method: (init || {}).method, body: (init || {}).body };
        }
        return Promise.resolve({
          ok: true, status: 200,
          text: () => Promise.resolve(JSON.stringify({ ok: true })),
        });
      }, function () {
        return Promise.resolve(ApplyBoss.setAutoGreet(true)).then(tick).then(tick);
      });
      ok('【39】P1-5：改「一键打招呼」开关时会 POST /api/greet-conf（否则服务端读的是一份过期配置）',
        !!hit5, hit5 ? hit5.url : '没发出请求');
      ok('【39】P1-5：是 POST 而不是 GET', !!hit5 && hit5.method === 'POST', hit5 ? hit5.method : '');
      let body5 = {};
      try { body5 = JSON.parse((hit5 || {}).body || '{}'); } catch (e) { /* 非 JSON 就算空 */ }
      ok('【39】P1-5：同步了 autoGreet / intervalSec / cooldownH / dailyCap 四项（少一项服务端就只能用默认值）',
        body5.autoGreet === true &&
        typeof body5.intervalSec === 'number' &&
        typeof body5.cooldownH === 'number' &&
        typeof body5.dailyCap === 'number',
        JSON.stringify(body5));
      ok('【39】P1-5：⚠️ 同步的是**白名单**，正好这 4 个键，没有把整包 settings 塞进去（里面有模型 Key）',
        Object.keys(body5).sort().join(',') === 'autoGreet,cooldownH,dailyCap,intervalSec' &&
        String((hit5 || {}).body).indexOf('apiKey') < 0 &&
        String((hit5 || {}).body).indexOf('settings') < 0,
        'keys=' + Object.keys(body5).sort().join(',') + ' / body=' + String((hit5 || {}).body).slice(0, 160));
      ApplyBoss.setAutoGreet(false);
      VC._state.base = savedBase5;
    }

    /* ---------------- 39.5 P1-7：合并备份时本地简历 id 必须保住 ---------------- */
    {
      const accR = 'unit_p17_' + Date.now();
      Store.createAccount(accR);
      Store.switchAccount(accR);

      const locR = Store.addResume({ name: '本地简历P1-7', content: '本地正文内容' });
      const jRraw = Store.addJob({ title: 'P1-7 岗位', company: '甲', url: 'https://example.com/p17', source: 'manual' });
      const jR = (jRraw && jRraw.job) ? jRraw.job : jRraw;
      const aR = Store.addApplication({ jobId: jR.id, status: 'todo' });
      ok('【39】P1-7 前置：本地简历与投递记录都建好了', !!locR && !!locR.id && !!aR);

      /* 备份来自「另一台机器」：同一份简历、**另一个 id**（两台机器 id 天然不同）。 */
      const backup17 = {
        jobs: [],
        applications: [{ id: 'app_remote17', jobId: jR.id, status: 'todo',
                        resumeId: 'cv_remote17', timeline: [] }],
        interviews: [], materials: [], chats: [], checks: [],
        resumes: [{ id: 'cv_remote17', name: '本地简历P1-7', content: '', tags: [],
                    isDefault: false, note: '远端备注', createdAt: 1 }],
      };
      Store.importObject(backup17, 'merge');

      ok('【39】P1-7：⛔ 本地简历 id 没被远端的换掉（换了 = 所有 resumeId 变悬空外键）',
        Store.resume(locR.id) !== null, 'Store.resume(' + locR.id + ') = ' + Store.resume(locR.id));
      ok('【39】P1-7：只补空字段（本地正文没被远端的空串覆盖）',
        (Store.resume(locR.id) || {}).content === '本地正文内容',
        (Store.resume(locR.id) || {}).content);
      ok('【39】P1-7：真·空洞才补（远端备注补进来了）',
        (Store.resume(locR.id) || {}).note === '远端备注',
        (Store.resume(locR.id) || {}).note);

      const aAfter = Store.applications().filter(x => x.jobId === jR.id)[0] || {};
      ok('【39】P1-7：⛔ 备份里指向**远端简历 id** 的 resumeId 被重映射回本地 id（否则又是悬空外键）',
        aAfter.resumeId === locR.id, 'resumeId=' + aAfter.resumeId + ' 期望=' + locR.id);
      ok('【39】P1-7：重映射后的 resumeId 真能查到简历（这正是不修时的症状）',
        !!Store.resume(aAfter.resumeId),
        String(Store.resume(aAfter.resumeId)));

      Store.switchAccount('default');
    }

    /* ---------------- 39.6 P2-1：onboardEstimate 过白名单后必须还在 ---------------- */
    {
      const accE = 'unit_p21_' + Date.now();
      Store.createAccount(accE);
      Store.switchAccount(accE);

      const jEraw = Store.addJob({ title: 'P2-1 岗位', company: '乙', url: 'https://example.com/p21', source: 'manual' });
      const jE = (jEraw && jEraw.job) ? jEraw.job : jEraw;
      const aE = Store.addApplication({ jobId: jE.id, status: 'todo' });
      Store.updateApplication(aE.id, { onboardEstimate: '预计 3 月 1 日到岗' });
      ok('【39】P2-1 前置：写入后当场读得到（这是「填完刷新就没了」的隐蔽之处）',
        (Store.application(aE.id) || {}).onboardEstimate === '预计 3 月 1 日到岗',
        JSON.stringify((Store.application(aE.id) || {}).onboardEstimate));

      /* ⛔ normApp 是**重建式白名单**：字段不登记就会被下一次 normApp 静默丢掉。
         导出 → 再导入（replace）正好走一遍 normApp。 */
      const dumpE = Store.exportObject();
      Store.importObject(dumpE, 'replace');
      const backE = Store.application(aE.id) || {};
      ok('【39】P2-1：⛔ 过一遍 normApp（等于刷新页面）后 onboardEstimate 仍在',
        backE.onboardEstimate === '预计 3 月 1 日到岗',
        JSON.stringify(backE.onboardEstimate));

      Store.switchAccount('default');
    }

    /* ---------------- 39.7 P1-10：进模拟面试就请面试官问第一题 ---------------- */
    {
      const j10 = Store.jobs().find(x => !x.archived);
      if (j10) {
        const orig10 = AI.chat;
        AI.chat = () => Promise.resolve('第一题：先做个自我介绍吧。');
        try {
          U.closeAllModals(true);
          sandbox.InterviewSim._runChat(j10,
            { round: '一面（技术/业务）', count: 3, resume: null }, {});
          const mask10 = U.$('.mask');
          const txt10 = mask10 ? (mask10.textContent || '') : '';
          ok('【39】P1-10：⛔ 弹窗一打开就有「（面试开始）…请面试官问第一个问题」这句（否则用户得先回答一个还没被问的问题）',
            txt10.indexOf('我准备好了') >= 0 && txt10.indexOf('第一个问题') >= 0,
            '弹窗文字：' + txt10.slice(0, 120));
          await tick(); await tick();
          const txt10b = (U.$('.mask') || {}).textContent || '';
          ok('【39】P1-10：第一题真的问了回来（AI 那一侧有内容，不是只有一个空气泡）',
            txt10b.indexOf('自我介绍') >= 0, txt10b.slice(0, 160));
        } finally {
          AI.chat = orig10;
          U.closeAllModals(true);
          await tick();
        }
      } else {
        ok('【39】P1-10：跳过（库里没有岗位可用作模拟面试对象）', false, '需要至少一个非归档岗位');
      }
    }
  }

  /* 直接 await（这里就在 async 链里）：等它跑完再往下走，
     否则主流程先 finish()，落盘断言会被当成"没通过"甚至整个丢掉。 */
  /* --- 【40】A 档：采集数量口径 + 采集漏斗 + 🎯 精选 -------------------
     背景（用户实测反馈原话）：
       「他抓取的数量和这个的限制数量不匹配」
       「我说的 50 条是自己可以自由设置采集最后结果，最精准的 50 条……
         采集先把合适的度采集到，再通过匹配度选出最精准自定义的多少条」
     根因是两个**不同的量**被界面混成了一个：
       · 采集阶段的「每个关键词抓多少条」= 候选池大小
       · 结果阶段的「我最终只要最精准的 N 条」= 按合适度排序后取前 N
     这两件事现在各归各位，下面把它们分别钉住。 */
  {
    const collect = Views.collect;
    const CF = collect._cf;

    /* ⛔ 自己造 `#cResult` 容器：它是**动态节点**（不在 index.html 里），
       而跑到这一段时视图往往已经不是采集页了（前面若干段 App.go 去过别的页，
       整块 #view 被换掉）⇒ `U.$('#cResult')` 是 null，`_paintResult()` 会
       **静默 no-op**（它开头 `if (!host) return`），接着读 textContent 就抛
       "Cannot read properties of null"。
       和 `#cActions` 那条老坑同一个处理方式：测试自己造容器。 */
    function host42() {
      let h = document.getElementById('cResult');
      if (!h) {
        h = document.createElement('div');
        h.id = 'cResult';
        document.body.appendChild(h);
      }
      return h;
    }

    /* ---- 40.1 条数小字的口径：乘城市数，且必须讲清「候选 ≠ 最终」 ---- */
    const h1 = collect._countHintText(50, 56, 3);
    ok('【40】条数小字把城市数乘进去了（50 × 56 个关键词 × 3 个城市 = 8400）',
      h1.indexOf('8400') >= 0 && h1.indexOf('3 个城市') >= 0, h1.slice(0, 180));
    ok('【40】条数小字说的口径必须和右边耗时预估一致',
      h1.indexOf('口径与右边耗时预估一致') >= 0, h1.slice(0, 200));
    ok('⛔【40】条数小字必须写明「这里管的是候选、不是最终结果条数」',
      h1.indexOf('候选') >= 0 && h1.indexOf('不是最终结果条数') >= 0, h1.slice(0, 320));
    ok('【40】条数小字要指路到结果页的 🎯 精选（否则用户还是不知道该在哪设"最终 50 条"）',
      h1.indexOf('🎯') >= 0 && h1.indexOf('结果页') >= 0, h1.slice(0, 400));
    const h2 = collect._countHintText(50, 56, 1);
    ok('【40】单城市时口径跟着变（50 × 56 × 1 = 2800），不是写死的 2800',
      h2.indexOf('2800') >= 0 && h2.indexOf('1 个城市') >= 0, h2.slice(0, 180));
    const h4 = collect._countHintText(20, 5, 2);
    ok('【40】口径是算出来的（20 × 5 × 2 = 200），不是照抄某个常数',
      h4.indexOf('200') >= 0, h4.slice(0, 160));
    const h3 = collect._countHintText(50, 56, 0);
    ok('【40】还没选城市时提示去选城市，而不是默默只乘关键词数',
      h3.indexOf('再选上城市') >= 0 && h3.indexOf('8400') < 0, h3.slice(0, 180));
    const h5 = collect._countHintText(0, 10, 2);
    ok('【40】「不限」按每位置每城市 300 估（300 × 10 × 2 = 6000）',
      h5.indexOf('6000') >= 0, h5.slice(0, 180));

    /* ---- 40.2 漏斗解析：喂爬虫**真打印出来的原话**（格式照抄 crawler.py） ---- */
    const LOG = [
      '==================================================',
      '正在爬取: 内容运营 - 杭州',
      '[第1页] 获取到 15 条数据，已写入 12 条（跳过 3 条重复）',
      '已达到数量限制 50 条',
      '',
      '=================================================================',
      '                          爬取完成',
      '=================================================================',
      '',
      '数据统计:',
      '  获取数据: 412 条',
      '  写入数据: 68 条',
      '  跳过重复: 344 条',
      '    其中跨关键词重复: 210 条（关键词命中同一批岗位，可考虑减少关键词数量）',
      '    其中历史采过且已有 JD: 134 条（该拿的都拿到了，这次不再碰；换关键词/城市能拿到更多新岗位）',
      '',
      '==================================================',
      '详情抓取：全轮共 305 个岗位缺详情 → 按全局优先级取前 50 个（涉及 3 个关键词文件）',
      '  其余 255 个本轮只保留列表页字段 —— 下次采集会接着补（详情是逐轮累积的，不是丢了）',
      '==================================================',
      '',
      '详情爬取完成: 成功 47 条 / 实际请求 52 次',
      '  本轮详情额度已用完，其余岗位只保留列表页字段（避免触发风控）',
    ];

    /* ⛔⛔ 必须**先**把 `#cResult` 造出来。
       `_paintResult()` 内部是 `paintResultBody(U.$('#cResult'))`，而 `paintResultBody`
       第一行就是 `if (!card) return` —— 容器不在时**整卡静默 no-op**：不只是没内容，
       连 `#cFunnel` 这个容器都不会被创建，于是后面 `absorbLines → paintFunnel()` 找不到
       挂载点、什么也不画，5 条"渲染出来了吗"的断言全红且**毫无线索**（报错信息里
       只有 textContent 片段为空，看不出根因是容器缺失）。
       真机上 `#cResult` 由采集页渲染时创建；测试环境没有这个视图 ⇒ 必须先自造。
       （和 `#cActions` 那条老坑同一个成因。） */
    host42();
    collect._absorbLines([], 'tk-reset');          // 先清一次，别受别的用例影响
    /* ⛔ `jobs` **不能**是空数组：结果卡在 n===0 时走的是「运行目录里还没有采集结果」
       那条分支，于是结果计数行 / 🎯 精选行 / 漏斗容器**一个都不会渲染** ⇒
       下面所有"渲染出来了吗"的断言必然红。
       （这不是产品缺陷，是用例前提没造到"缺陷真会显现"的形态 —— 本项目的老坑。） */
    collect._state.result = {
      source: '（测试·漏斗）',
      jobs: [
        { 岗位: '内容运营', 公司: 'A公司', 城市: '杭州', 薪资: '10-20K', _isNew: true },
        { 岗位: '短视频运营', 公司: 'C公司', 城市: '杭州', 薪资: '12-18K', _isNew: true },
      ],
      hasRoundInfo: true, newCount: 68,
    };
    collect._paintResult();                        // 挂上 #cFunnel 容器
    const before = host42().textContent || '';
    ok('⛔【40】没有日志时漏斗整块不出现（不瞎猜、不填 0）',
      before.indexOf('本轮采集漏斗') < 0, before.slice(0, 200));

    collect._absorbLines(LOG, 'tk-a');
    const f = collect._funnelState();
    eq('【40】漏斗解析·获取总数', f.total, 412);
    eq('【40】漏斗解析·写入数', f.written, 68);
    eq('【40】漏斗解析·跳过数', f.skipped, 344);
    eq('【40】漏斗解析·跨关键词重复', f.runDups, 210);
    eq('【40】漏斗解析·历史采过且已有 JD', f.knownDups, 134);
    eq('【40】漏斗解析·缺详情总数', f.dPending, 305);
    eq('【40】漏斗解析·本轮详情额度', f.dKept, 50);
    eq('【40】漏斗解析·详情成功条数', f.dSucc, 47);
    eq('【40】漏斗解析·详情实际请求次数', f.dAsked, 52);
    eq('【40】漏斗解析·翻页数', f.pages, 1);
    eq('⛔【40】漏斗解析·「已达到数量限制」被记下（到量即停 ≠ 采不到）', f.capHit, true);
    eq('【40】漏斗解析·详情额度用完被记下', f.dExhausted, true);

    const t1 = host42().textContent || '';
    ok('【40】漏斗渲染出「列表页拿到 412 → 写入结果池 68 → 直接跳过 344」',
      t1.indexOf('列表页拿到') >= 0 && t1.indexOf('412') >= 0 &&
      t1.indexOf('写入结果池') >= 0 && t1.indexOf('68') >= 0, t1.slice(0, 320));
    ok('【40】漏斗把跳过拆成两类（跨关键词重复 210 / 历史采过 134）',
      t1.indexOf('210') >= 0 && t1.indexOf('134') >= 0, t1.slice(0, 420));
    ok('⛔【40】漏斗写出了「跳过的都不占额度」这条关键事实（否则用户永远以为漏采）',
      t1.indexOf('不占这个额度') >= 0, t1.slice(0, 420));
    ok('【40】漏斗把详情缺口算净额（305 缺 → 成功 47 → 还有 258 只有列表页字段）',
      t1.indexOf('258') >= 0, t1.slice(0, 520));
    ok('【40】漏斗把「到量即停」也说成一句人话',
      t1.indexOf('到量就停') >= 0, t1.slice(0, 520));

    /* ---- 40.3 可重入：poll 的分页与挂载的全量会重叠喂同一批行 ---- */
    collect._absorbLines(LOG, 'tk-a');
    eq('⛔【40】同一批日志喂两次不累加（可重入）', collect._funnelState().total, 412);
    eq('⛔【40】重复喂后写入数也没翻倍', collect._funnelState().written, 68);

    /* ---- 40.4 换任务（key 变了）必须清空 ---- */
    collect._absorbLines(['  获取数据: 7 条', '  写入数据: 5 条'], 'tk-b');
    const f2 = collect._funnelState();
    eq('⛔【40】换任务后漏斗清空重算', f2.total, 7);
    eq('⛔【40】换任务后旧数字不残留（跳过数回到 null）', f2.skipped, null);
    const t2 = host42().textContent || '';
    ok('⛔【40】换任务后界面上不再出现旧值（344 不该还在）',
      t2.indexOf('344') < 0, t2.slice(0, 320));

    /* ---- 40.5 认不出来的项必须是 null，且**不能渲染成 0** ---- */
    collect._absorbLines(['  获取数据: 100 条'], 'tk-c');
    eq('⛔【40】日志里没有写入行 → written 是 null 而不是 0',
      collect._funnelState().written, null);
    const t3 = host42().textContent || '';
    ok('⛔【40】没有写入数时不许渲染出「写入结果池 0 条」（把"没这段"说成"采到 0 条"）',
      t3.indexOf('写入结果池') < 0, t3.slice(0, 320));

    /* ---- 40.6 🎯 精选：最终只要最精准的 N 条 ----
       造 3 条**合适度有区分度**的候选（福利档不同 → 福利维 2/5/8/10），
       并且故意让"分最高的"不在数组第一位 —— 否则"按原序切前 N"也能假装通过。 */
    const J3 = [
      { 岗位: '销售代表', 公司: 'B公司', 城市: '杭州', 薪资: '3-5K', 福利: '', _isNew: true },
      { 岗位: '内容运营', 公司: 'A公司', 城市: '杭州', 薪资: '20-30K',
        福利: '双休 五险一金 年终奖 年假 法定节假日', _isNew: true },
      { 岗位: '短视频运营', 公司: 'C公司', 城市: '杭州', 薪资: '10-20K',
        福利: '双休 五险一金', _isNew: true },
    ];
    collect._state.result = { source: '（测试·精选）', jobs: J3, hasRoundInfo: true, newCount: 3 };
    CF.onlyNew = true;
    CF.fit = ''; CF.hideDrop = false;
    collect._paintResult();

    const pool = collect._resultJobs();
    eq('【40】前置：3 条候选都进池', pool.length, 3);
    collect._cfFitAll(pool);
    const totals = pool.map(function (j) { return collect._cfFitOf(j).total; });
    ok('⛔【40】前置守卫：候选的合适度**不能全相等**，否则下面的排序断言形同虚设',
      new Set(totals).size > 1, JSON.stringify(totals));
    const byScore = pool.slice().sort(function (a, b) {
      return collect._cfFitOf(b).total - collect._cfFitOf(a).total;
    });
    ok('⛔【40】前置守卫：分最高的那条**不在数组第一位**（否则"按原序切"也能通过）',
      byScore[0] !== pool[0], '最高分=' + totals[pool.indexOf(byScore[0])]);

    /* ⛔⛔ 这条守卫比上一条**更狠**，是踩过坑才加的：
       `pickTop` 的比较函数是**两层** —— 先按硬性过滤（`gate.drop`）分组，再按合适度序号降序。
       只破坏第二层时，第一层仍可能把最高分顶到首位 ⇒ 变异退化成 no-op、断言全绿（实测踩到过，
       见 _chk_mut_a.js 的【40-④】"只有锚点守卫红"）。
       所以这里直接钉住"按**原序**切前 N"与"按**合适度**切前 N"**结果不同** ——
       只要不同，任何"该排没排"的缺陷都必然被下面的精选断言逮住。 */
    const byScoreTop2 = byScore.slice(0, 2).map(function (j) { return collect._cfFitOf(j).total; }).join(',');
    const byOrigTop2 = pool.slice(0, 2).map(function (j) { return collect._cfFitOf(j).total; }).join(',');
    ok('⛔【40】前置守卫：按原序切前 2 条 ≠ 按合适度切前 2 条（否则"不排序"这条缺陷检查不出来）',
      byOrigTop2 !== byScoreTop2, '原序=' + byOrigTop2 + ' / 合适度=' + byScoreTop2);

    CF.wanted = 0;
    eq('【40】精选填 0 = 不限（原样返回，一条不砍）', collect._pickTop(pool).length, 3);
    CF.wanted = NaN;
    eq('⛔【40】精选是 NaN 时不砍（slice(0, NaN) 会得到空数组 —— 那等于"结果莫名全没了"）',
      collect._pickTop(pool).length, 3);
    CF.wanted = -5;
    eq('⛔【40】精选是负数时不砍', collect._pickTop(pool).length, 3);
    CF.wanted = 99;
    eq('⛔【40】要的比候选还多时，给全部（不报错、不补空位）', collect._pickTop(pool).length, 3);

    CF.wanted = 1;
    const top1 = collect._pickTop(pool);
    eq('【40】精选 1 条 → 就 1 条', top1.length, 1);
    ok('⛔【40】精选选出的**必须是分最高的那条**（不是最先采到的那条）',
      top1[0] === byScore[0],
      '选到「' + (top1[0] || {}).title + '」，最高分是「' + (byScore[0] || {}).title + '」');
    CF.wanted = 2;
    const top2 = collect._pickTop(pool);
    eq('【40】精选 2 条 → 2 条，且按合适度降序',
      top2.map(function (j) { return collect._cfFitOf(j).total; }).join(','),
      byScore.slice(0, 2).map(function (j) { return collect._cfFitOf(j).total; }).join(','));

    /* --- 精选的状态行：候选不够时必须**明说**，别让用户以为工具坏了 ---
       ⛔ 每次调用前都要把 CF.wanted 对到这条断言要验的那个数 ——
          状态行读的是 CF.wanted，不是参数，对不齐就是"断言名 > 实做"的假绿。 */
    CF.wanted = 0;
    eq('【40】精选填 0 时状态行为空（不占版面）', collect._wantedInfoText(3, 3), '');
    CF.wanted = 2;
    ok('【40】候选足够（3 条选 2 条）→ 说明"已从 3 条候选里选出前 2 条"',
      collect._wantedInfoText(3, 2).indexOf('已从 3 条候选里按合适度选出前 2 条') >= 0,
      collect._wantedInfoText(3, 2));
    CF.wanted = 12;
    ok('⛔【40】候选不足（池 3 条 / 要 12 条）→ 明说「不够你要的 12 条」并给出三条出路',
      (function () {
        var s = collect._wantedInfoText(3, 3);
        return s.indexOf('不够你要的 12 条') >= 0 && s.indexOf('关键词') >= 0 &&
          s.indexOf('放宽筛选') >= 0;
      })(),
      collect._wantedInfoText(3, 3));

    /* --- 渲染：界面上的「已从 M 条候选里选出前 N 条」要真出现 --- */
    CF.wanted = 1;
    collect._paintResult();
    const t4 = host42().textContent || '';
    ok('【40】界面上出现 🎯 精选的输入口和说明',
      t4.indexOf('最终只要最精准的') >= 0 && t4.indexOf('已从') >= 0 &&
      t4.indexOf('选出前 1 条') >= 0, t4.slice(0, 400));
    CF.wanted = 10;
    collect._paintResult();
    const t5 = host42().textContent || '';
    ok('⛔【40】要 10 条但池里只有 3 条 → 界面明说「不够你要的 10 条」',
      t5.indexOf('不够你要的 10 条') >= 0, t5.slice(0, 400));

    /* --- 分页：要 50 条就不能只显示 40 条（RESULT_PAGE）--- */
    CF.wanted = 0;
    const ps0 = collect._resultPageSize();
    CF.wanted = 50;
    const ps50 = collect._resultPageSize();
    ok('⛔【40】精选开了以后一屏条数要 ≥ 精选条数（否则"我要 50 条"只看到 40 条，像没生效）',
      ps50 >= 50 && ps0 < 50, '不限时=' + ps0 + ' / 精选 50 时=' + ps50);

    /* --- 偏好落盘：F5 之后「我只要 50 条」还得在 --- */
    collect._writeWanted(30);
    eq('【40】精选条数会落盘（刷新后还在）', collect._readWanted(), 30);
    try { localStorage.setItem('jh.collectWanted', 'abc'); } catch (e) { /* noop */ }
    eq('⛔【40】盘里存了脏数据（abc）时读回 0，绝不读成 NaN',
      collect._readWanted(), 0);

    /* --- 能开就得能关：精选必须让「✕ 清空筛选」出现，并且真的被清掉 ---
       ⛔ 必须先证明"不设精选时是 false"：否则前面用例残留的 CF.onlyNew / CF.fit
          会把这条断言**带绿**（改了 wanted 那一段也照样通过 = 假绿）。 */
    CF.onlyNew = false; CF.fit = ''; CF.hideDrop = false; CF.kw = ''; CF.job = '';
    CF.city = ''; CF.industry = ''; CF.salary = ''; CF.active = ''; CF.scored = '';
    CF.wanted = 0;
    eq('【40】前置守卫：不设任何条件时「有筛选」必须是 false（否则下面那条会被带绿）',
      collect._collectHasFilter(), false);
    CF.wanted = 25;
    ok('⛔【40】只设了精选也算「有筛选」（否则 ✕ 清空筛选按钮不出现 = 关不掉）',
      collect._collectHasFilter() === true, 'collectHasFilter=' + collect._collectHasFilter());
    collect._clearCF();
    eq('⛔【40】清空筛选会把精选一起清掉', CF.wanted, 0);
    eq('【40】清空筛选后落盘值也归零', collect._readWanted(), 0);
    ok('【40】清空后「有筛选」回到 false', collect._collectHasFilter() === false);

    /* ---- 清理 ---- */
    collect._absorbLines([], 'tk-zzz');
    CF.wanted = 0;
    CF.onlyNew = false;
    collect._state.result = null;
    collect._paintResult();
  }

  await s39Step2();
  await s1bDurability();

  finish();
}).catch(e => {
  console.log('  ✗ 采集模块异步测试自身抛异常：' + (e && e.message));
  fail++; failures.push('采集模块异步测试抛异常：' + (e && e.message));
  finish();
});

/* ======================================================================
   八、汇总
   ====================================================================== */
function finish() {
  console.log('\n' + '─'.repeat(64));
  if (failures.length) {
    console.log('❌ 失败 ' + fail + ' 项 / 通过 ' + pass + ' 项');
    failures.forEach(f => console.log('   · ' + f));
    process.exit(1);
  }
  console.log('✅ 全部通过（' + pass + ' 项）');
}
