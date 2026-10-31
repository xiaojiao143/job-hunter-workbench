/* ==========================================================================
   resume-doc.js · 模块 11：简历排版与导出（PDF / Word / Markdown / HTML）
   --------------------------------------------------------------------------
   纯本地、零依赖：
     · PDF  → 生成 A4 排版页面后调浏览器打印，在打印对话框里「另存为 PDF」
     · Word → 生成 .doc（HTML 内容 + Word 命名空间），Word / WPS 直接打开可编辑
     · MD / HTML → 直接下载，方便贴到别处
   解析的是「纯文本简历」，所以尽量做容错：认【小节】/ ## / 一、 三种标题写法，
   认 "键：值" 联系方式，认 - · • 开头的条目，其它当段落。
   ========================================================================== */
(function (global) {
  'use strict';

  // 本文件用到 el 的地方只有导出面板（预览 + 弹窗），但别名必须建：
  // 少了这一行，点「导出 PDF / Word」会直接 ReferenceError: el is not defined。
  var el = Comp.el;

  /* ==================== 解析 ==================== */
  var BULLET = /^\s*(?:[-*·•–—]|\u25cf|\u25aa)\s+/;

  function isHeader(line) {
    var s = line.trim();
    if (!s || s.length > 20) return false;
    var m = s.match(/^[【\[]\s*([^】\]]{1,16})\s*[】\]]$/);          // 【个人信息】
    if (m) return m[1];
    m = s.match(/^#{1,4}\s*(.{1,16})$/);                            // ## 工作经历
    if (m) return m[1].trim();
    m = s.match(/^[一二三四五六七八九十]+\s*[、.．:：]\s*(.{1,16})$/);   // 一、教育背景
    if (m) return m[1].trim();
    // 独占一行、以冒号结尾的短句：「工作经历：」
    m = s.match(/^([^：:]{2,14})[：:]\s*$/);
    if (m && !/[，。；,.、]/.test(m[1])) return m[1].trim();
    return false;
  }

  function isKV(line) {
    var m = line.trim().match(/^([^：:]{1,8})[：:]\s*(.+)$/);
    if (!m) return null;
    var k = m[1].trim();
    if (/^(https?|mailto)/i.test(k)) return null;
    return { k: k, v: m[2].trim() };
  }

  /**
   * 纯文本 → { name, headline, contacts:[{k,v}], sections:[{title, items:[{type,...}]}] }
   */
  function parse(text) {
    var lines = U.lines(text);
    var out = { name: '', headline: '', contacts: [], sections: [], raw: text || '' };
    var cur = null;      // 当前小节
    var pre = [];        // 第一个小节之前的内容（通常是姓名 + 联系方式）

    function ensure() {
      if (!cur) { cur = { title: '', items: [] }; out.sections.push(cur); }
      return cur;
    }

    lines.forEach(function (raw, idx) {
      var line = raw.trim();
      var h = isHeader(line);
      if (h) { cur = { title: h, items: [] }; out.sections.push(cur); return; }

      var kv = isKV(line);
      if (kv) {
        // 「求职意向：xxx」这类放进 headline，其它联系方式进 contacts
        if (/意向|目标岗位|期望岗位|求职/.test(kv.k)) { out.headline = kv.v; return; }
        if (cur) cur.items.push({ type: 'kv', k: kv.k, v: kv.v });
        else { pre.push({ type: 'kv', k: kv.k, v: kv.v }); out.contacts.push({ k: kv.k, v: kv.v }); }
        return;
      }

      if (BULLET.test(line)) {
        ensure().items.push({ type: 'li', text: line.replace(BULLET, '').trim() });
        return;
      }

      // 第一个非空行、短、不含标点 → 姓名
      if (!out.name && !cur && !out.contacts.length && line.length <= 8 && !/[，。、；:：]/.test(line) && idx < 3) {
        out.name = line;
        return;
      }
      // 紧跟在姓名后面的短行 → 一句话定位
      if (out.name && !out.headline && !cur && !out.contacts.length && line.length <= 30) {
        out.headline = line;
        return;
      }

      // 「公司 | 岗位 | 时间」这种用竖线的写法 → 当条目标题
      if (/[|｜]/.test(line) && line.split(/[|｜]/).length >= 2) {
        ensure().items.push({ type: 'entry', text: line.replace(/\s*[|｜]\s*/g, '　·　') });
        return;
      }

      ensure().items.push({ type: 'p', text: line });
    });

    // 没识别出姓名时，从个人信息小节里再捞一次
    if (!out.name) {
      var hit = out.contacts.filter(function (c) { return /姓名|名字|name/i.test(c.k); })[0];
      if (hit) { out.name = hit.v; out.contacts = out.contacts.filter(function (c) { return c !== hit; }); }
    }
    // 把空标题的首个小节内容并进 contacts（避免出现一个没有标题的块）
    out.sections = out.sections.filter(function (s) {
      if (!s.title && !s.items.length) return false;
      if (!s.title) {
        s.items.filter(function (it) { return it.type === 'kv'; }).forEach(function (it) {
          if (!out.contacts.some(function (c) { return c.k === it.k; })) out.contacts.push({ k: it.k, v: it.v });
        });
        s.title = '其他';
      }
      return s.items.length > 0;
    });
    return out;
  }

  /* ==================== 排版 ==================== */
  var THEMES = {
    simple: { name: '极简（黑白，适合投递）', accent: '#111111', rule: true },
    brand: { name: '稳重（深蓝主色，适合正式投递）', accent: '#1d4ed8', rule: true },
    compact: { name: '紧凑（内容多时用，字号更小）', accent: '#1d4ed8', rule: false },
  };

  function esc(s) { return U.esc(s); }

  function contactsLine(r) {
    if (!r.contacts.length) return '';
    return '<div class="rd-contacts">' + r.contacts.map(function (c) {
      return '<span><b>' + esc(c.k) + '</b>' + esc(c.v) + '</span>';
    }).join('<i>·</i>') + '</div>';
  }

  function sectionHtml(s) {
    var body = [];
    var buf = [];
    function flush() {
      if (!buf.length) return;
      body.push('<ul>' + buf.map(function (t) { return '<li>' + esc(t) + '</li>'; }).join('') + '</ul>');
      buf = [];
    }
    s.items.forEach(function (it) {
      if (it.type === 'li') { buf.push(it.text); return; }
      flush();
      if (it.type === 'entry') body.push('<h3>' + esc(it.text) + '</h3>');
      else if (it.type === 'kv') body.push('<p class="rd-kv"><b>' + esc(it.k) + '</b>' + esc(it.v) + '</p>');
      else body.push('<p>' + esc(it.text) + '</p>');
    });
    flush();
    return '<section><h2>' + esc(s.title) + '</h2>' + body.join('') + '</section>';
  }

  function bodyHtml(r) {
    return (r.name ? '<h1>' + esc(r.name) + '</h1>' : '') +
      (r.headline ? '<div class="rd-headline">' + esc(r.headline) + '</div>' : '') +
      contactsLine(r) +
      r.sections.map(sectionHtml).join('');
  }

  /** 可打印 / 可贴进 Word 的完整 HTML 文档 */
  function toDocument(r, opt) {
    opt = opt || {};
    var th = THEMES[opt.theme] || THEMES.brand;
    var fs = opt.theme === 'compact' ? 10.6 : 11.4;
    return '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">' +
      '<title>' + esc(r.name || '简历') + ' - 简历</title>' +
      '<style>' +
      '@page{size:A4;margin:14mm 16mm;}' +
      '*{box-sizing:border-box}' +
      'body{margin:0;color:#1a1a1a;background:#fff;' +
      'font:' + fs + 'pt/1.62 -apple-system,"Segoe UI","Microsoft YaHei",SimSun,sans-serif;}' +
      '.rd-doc{max-width:186mm;margin:0 auto;padding:6mm 0;}' +
      'h1{font-size:' + (fs + 9) + 'pt;margin:0 0 2pt;letter-spacing:1px;color:' + th.accent + ';}' +
      '.rd-headline{font-size:' + (fs + 0.6) + 'pt;color:#444;margin-bottom:4pt;}' +
      '.rd-contacts{margin:0 0 10pt;padding-bottom:7pt;border-bottom:2px solid ' + th.accent + ';' +
      'font-size:' + (fs - 0.8) + 'pt;color:#333;display:flex;flex-wrap:wrap;gap:3pt 10pt;align-items:center}' +
      '.rd-contacts b{color:#666;font-weight:600;margin-right:2pt}' +
      '.rd-contacts i{color:#bbb;font-style:normal;margin:0 2pt}' +
      'section{margin-bottom:9pt;page-break-inside:avoid}' +
      'h2{font-size:' + (fs + 0.8) + 'pt;margin:10pt 0 5pt;padding-bottom:3pt;' +
      (th.rule ? 'border-bottom:1px solid ' + th.accent + '33;' : '') +
      'color:' + th.accent + ';letter-spacing:.5px}' +
      'h3{font-size:' + (fs + 0.2) + 'pt;margin:7pt 0 2pt;font-weight:650;color:#111}' +
      'p{margin:2pt 0}' +
      '.rd-kv{margin:1pt 0}' +
      '.rd-kv b{color:#666;font-weight:600;margin-right:4pt}' +
      'ul{margin:2pt 0 2pt 0;padding-left:15pt}' +
      'li{margin:1.5pt 0}' +
      '@media print{body{background:#fff}.rd-doc{padding:0}}' +
      '</style></head><body><div class="rd-doc">' + bodyHtml(r) + '</div></body></html>';
  }

  /* ==================== 导出动作 ==================== */

  /** 打印 → 用户在打印对话框选「另存为 PDF」 */
  function printResume(r, opt) {
    var html = toDocument(r, opt);
    var ok = false;
    try {
      var w = global.open('', '_blank');
      if (w && w.document) {
        w.document.open(); w.document.write(html); w.document.close();
        setTimeout(function () { try { w.focus(); w.print(); } catch (e) { /* 用户可能拦了弹窗 */ } }, 400);
        ok = true;
      }
    } catch (e) { ok = false; }

    if (!ok) {
      // 弹窗被拦时退回隐藏 iframe 打印
      try {
        var f = document.createElement('iframe');
        f.setAttribute('style', 'position:fixed;right:0;bottom:0;width:0;height:0;border:0');
        document.body.appendChild(f);
        var d = f.contentDocument || (f.contentWindow && f.contentWindow.document);
        if (d) {
          d.open(); d.write(html); d.close();
          setTimeout(function () {
            try { f.contentWindow.focus(); f.contentWindow.print(); } catch (e2) { /* noop */ }
            setTimeout(function () { if (f.parentNode) f.parentNode.removeChild(f); }, 2000);
          }, 400);
          ok = true;
        } else if (f.parentNode) f.parentNode.removeChild(f);
      } catch (e) { ok = false; }
    }

    if (ok) {
      Store.markExported();
      U.toastHtml('打印窗口已打开 —— 在「目标打印机」里选 <b>另存为 PDF</b> 就能存成 PDF', 'ok', 9000);
    } else {
      U.toast('浏览器拦住了打印窗口。已改为下载 HTML，打开后按 Ctrl+P 也能存成 PDF。', 'warn', 9000);
      downloadHtml(r, opt);
    }
    return ok;
  }

  /** Word：.doc（Word/WPS 能直接打开并继续编辑） */
  function exportWord(r, opt) {
    var th = (THEMES[(opt || {}).theme] || THEMES.brand);
    var html = toDocument(r, opt)
      // Word 的页边距要写在它自己的命名空间里，用 @page 不生效
      .replace('<head><meta charset="utf-8">',
        '<head><meta charset="utf-8">' +
        '<!--[if gte mso 9]><xml><w:WordDocument><w:View>Print</w:View>' +
        '<w:Zoom>100</w:Zoom></w:WordDocument></xml><![endif]-->' +
        '<xml><w:WordDocument><w:DoNotOptimizeForBrowser/></w:WordDocument></xml>')
      .replace('@page{size:A4;margin:14mm 16mm;}',
        '@page WordSection1{size:210mm 297mm;margin:14mm 16mm 14mm 16mm;}');
    var style = 'mso-page-border-surround-header:no;mso-page-border-surround-footer:no;';
    html = html.replace('<body>', '<body style="' + style + '">');

    U.download(fileName(r, 'doc'), '\ufeff' + html, 'application/msword');
    Store.markExported();
    U.toast('已导出 Word —— 用 Word / WPS 打开可直接编辑，也能再另存为 PDF。主色：' +
      (opt && opt.theme === 'simple' ? '黑白' : '深蓝'), 'ok', 8000);
    void th;
  }

  function downloadHtml(r, opt) {
    U.download(fileName(r, 'html'), toDocument(r, opt), 'text/html');
    Store.markExported();
  }

  function exportMarkdown(r) {
    var L = [];
    if (r.name) L.push('# ' + r.name);
    if (r.headline) L.push('', '*' + r.headline + '*');
    if (r.contacts.length) L.push('', r.contacts.map(function (c) { return c.k + '：' + c.v; }).join('  |  '));
    r.sections.forEach(function (s) {
      L.push('', '## ' + s.title);
      var buf = [];
      function flush() { if (buf.length) { buf.forEach(function (t) { L.push('- ' + t); }); buf = []; } }
      s.items.forEach(function (it) {
        if (it.type === 'li') { buf.push(it.text); return; }
        flush();
        if (it.type === 'entry') L.push('', '### ' + it.text);
        else if (it.type === 'kv') L.push('- **' + it.k + '**' + it.v);
        else L.push('', it.text);
      });
      flush();
    });
    U.download(fileName(r, 'md'), '\ufeff' + L.join('\n'), 'text/markdown');
    Store.markExported();
    U.toast('已导出 Markdown（可贴进飞书 / Notion / Obsidian）', 'ok');
  }

  function fileName(r, ext) {
    return '简历_' + String(r.name || '未命名').replace(/[\\/:*?"<>|]/g, '_') + '.' + ext;
  }

  /* ==================== 导出面板 ==================== */
  function openExportDialog(resumeId) {
    var r = Store.resume(resumeId);
    if (!r) { U.toast('简历不存在', 'warn'); return; }
    var parsed = parse(r.content || '');
    var theme = 'brand';

    var preview = el('div', { class: 'rd-preview' });
    function paintPreview() {
      preview.innerHTML = '';
      var d = el('div', { class: 'rd-doc rd-mini' });
      d.innerHTML = bodyHtml(parsed);
      // 预览里把主色套上（打印文档用的是独立的 <style>，这里手动补一下）
      var accent = (THEMES[theme] || THEMES.brand).accent;
      d.style.setProperty('--rd-accent', accent);
      preview.appendChild(d);
    }

    var seg = el('div', { class: 'seg' });
    Object.keys(THEMES).forEach(function (k) {
      seg.appendChild(el('button', {
        class: k === theme ? 'on' : '', text: THEMES[k].name,
        onclick: function () {
          theme = k;
          Array.prototype.slice.call(seg.children).forEach(function (b) { b.classList.toggle('on', b.textContent === THEMES[k].name); });
          paintPreview();
        },
      }));
    });

    var missing = [];
    if (!parsed.name) missing.push('姓名');
    if (!parsed.contacts.length) missing.push('联系方式');
    if (!parsed.sections.length) missing.push('小节标题（如【工作经历】）');

    paintPreview();

    U.openModal({
      title: '导出简历 · ' + r.name,
      size: 'xl',
      body: el('div', { class: 'stack' }, [
        el('div', { class: 'row' }, [
          el('span', { class: 'fs12 muted', text: '排版主题：' }),
          seg,
        ]),
        missing.length ? el('div', { class: 'note warn' }, [
          el('span', { class: 'ico', text: '⚠️' }),
          el('div', { html:
            '这份简历里没识别出：<b>' + missing.join('、') + '</b>。<br>' +
            '不影响导出，但排版会朴素一些。想让排版更好看，回到编辑页按这种写法整理一下：<br>' +
            '<code class="mono fs12">【个人信息】</code> → <code class="mono fs12">姓名：张三</code> / <code class="mono fs12">电话：138…</code>；' +
            '小节用 <code class="mono fs12">【工作经历】</code>；每条用 <code class="mono fs12">- </code> 开头。' }),
        ]) : el('div', { class: 'note ok' }, [
          el('span', { class: 'ico', text: '✅' }),
          el('div', { html: '解析正常：识别到 <b>' + parsed.sections.length + '</b> 个小节、' +
            parsed.contacts.length + ' 项联系方式。下面就是导出后的样子。' }),
        ]),
        el('div', { class: 'rd-shell' }, [preview]),
        el('div', { class: 'hint tiny' }, [
          el('span', { html: '导出 PDF 的做法：点「导出 PDF」→ 弹出打印窗口 → 目标打印机选 <b>另存为 PDF</b> → 保存。这是浏览器内置能力，不用装任何东西。' }),
        ]),
      ]),
      footer: [
        { text: '导出 PDF', cls: 'pri', onClick: function (c) { printResume(parsed, { theme: theme }); c(); } },
        { text: '导出 Word', onClick: function () { exportWord(parsed, { theme: theme }); } },
        { text: '导出 Markdown', onClick: function () { exportMarkdown(parsed); } },
        { text: '导出 HTML', onClick: function () { downloadHtml(parsed, { theme: theme }); U.toast('已下载 HTML（双击打开可 Ctrl+P 存 PDF）', 'ok'); } },
      ],
    });
  }

  global.ResumeDoc = {
    parse: parse, toDocument: toDocument, bodyHtml: bodyHtml, THEMES: THEMES,
    printResume: printResume, exportWord: exportWord, exportMarkdown: exportMarkdown,
    downloadHtml: downloadHtml, openExportDialog: openExportDialog,
  };
})(window);
