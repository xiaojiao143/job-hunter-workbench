/* ==========================================================================
   charts.js · 纯手绘 SVG 图表（零依赖，离线可用）
   ========================================================================== */
(function (global) {
  'use strict';

  var PALETTE = ['#1d4ed8', '#0b6fa4', '#6d3fc4', '#0d8a52', '#b06300',
    '#c62828', '#8b5cf6', '#0891b2', '#a855f7', '#65a30d', '#db2777', '#475569'];

  function color(i) { return PALETTE[i % PALETTE.length]; }

  function cssVar(name, dft) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || dft;
  }

  /** 环形图（甜甜圈）。data = [{name, n, color?}] */
  function donut(data, opt) {
    opt = opt || {};
    var size = opt.size || 172;
    var thick = opt.thick || 22;
    var r = (size - thick) / 2;
    var cx = size / 2, cy = size / 2;
    var total = data.reduce(function (a, d) { return a + d.n; }, 0);
    var bg = cssVar('--chip', '#f2f5fb');
    var track = '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' + bg + '" stroke-width="' + thick + '"/>';

    if (!total) {
      return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '">' +
        track +
        '<text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" font-size="13" fill="' +
        cssVar('--muted', '#7b869e') + '">暂无数据</text></svg>';
    }

    var C = 2 * Math.PI * r;
    var off = 0;
    var arcs = '';
    data.forEach(function (d, i) {
      if (!d.n) return;
      var frac = d.n / total;
      var len = frac * C;
      arcs += '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="none" stroke="' +
        (d.color || color(i)) + '" stroke-width="' + thick + '"' +
        ' stroke-dasharray="' + (len - 1.5) + ' ' + (C - len + 1.5) + '"' +
        ' stroke-dashoffset="' + (-off) + '"' +
        ' transform="rotate(-90 ' + cx + ' ' + cy + ')" stroke-linecap="butt">' +
        '<title>' + U.esc(d.name) + '：' + d.n + '（' + U.pct(d.n, total) + '%）</title></circle>';
      off += len;
    });

    var center = opt.centerText !== undefined ? opt.centerText : total;
    var sub = opt.centerSub || '合计';
    return '<svg viewBox="0 0 ' + size + ' ' + size + '" width="' + size + '" height="' + size + '" style="flex:none">' +
      track + arcs +
      '<text x="' + cx + '" y="' + (cy - 1) + '" text-anchor="middle" font-size="23" font-weight="700" fill="' +
      cssVar('--text', '#17203a') + '">' + U.esc(center) + '</text>' +
      '<text x="' + cx + '" y="' + (cy + 16) + '" text-anchor="middle" font-size="11" fill="' +
      cssVar('--muted', '#7b869e') + '">' + U.esc(sub) + '</text>' +
      '</svg>';
  }

  /** 图例 */
  function legend(data, opt) {
    opt = opt || {};
    var total = data.reduce(function (a, d) { return a + d.n; }, 0);
    return '<div class="legend">' + data.map(function (d, i) {
      return '<div class="lg"><span class="sw" style="background:' + (d.color || color(i)) + '"></span>' +
        '<span>' + U.esc(d.name) + '</span>' +
        '<span class="vl">' + d.n + (opt.showPct !== false && total ? ' · ' + U.pct(d.n, total) + '%' : '') + '</span></div>';
    }).join('') + '</div>';
  }

  /** 横向条形图。data = [{name, n, color?}] */
  function bars(data, opt) {
    opt = opt || {};
    if (!data || !data.length) {
      return '<div class="empty" style="padding:22px"><p style="margin:0">暂无数据</p></div>';
    }
    var max = Math.max.apply(null, data.map(function (d) { return d.n; })) || 1;
    var limit = opt.limit || 8;
    var shown = data.slice(0, limit);
    var rest = data.slice(limit);
    var html = shown.map(function (d, i) {
      var w = Math.max(2, (d.n / max) * 100);
      return '<div class="bar-row"><span class="nm" title="' + U.esc(d.name) + '">' + U.esc(d.name) + '</span>' +
        '<span class="tr"><i class="fl" style="width:' + w + '%;background:' + (d.color || color(i)) + '"></i></span>' +
        '<span class="vv">' + d.n + '</span></div>';
    }).join('');
    if (rest.length) {
      var restN = rest.reduce(function (a, d) { return a + d.n; }, 0);
      html += '<div class="bar-row"><span class="nm" style="color:var(--muted)">其他 ' + rest.length + ' 项</span>' +
        '<span class="tr"><i class="fl" style="width:' + Math.max(2, (restN / max) * 100) + '%;background:var(--muted)"></i></span>' +
        '<span class="vv">' + restN + '</span></div>';
    }
    return html;
  }

  /** 漏斗 */
  function funnel(steps, opt) {
    opt = opt || {};
    if (!steps || !steps.length) return '<div class="empty" style="padding:22px"><p style="margin:0">暂无数据</p></div>';
    var top = steps[0].n || 1;
    return '<div class="funnel">' + steps.map(function (s, i) {
      var w = Math.max(4, (s.n / top) * 100);
      var rate = i === 0 ? '' : U.pct(s.n, top) + '%';
      return '<div class="fn-step"><span class="nm">' + U.esc(s.name) + '</span>' +
        '<span class="bar"><i style="width:' + w + '%;background:' +
        'linear-gradient(90deg,' + color(i) + ',' + color(i) + 'cc)">' + s.n + '</i></span>' +
        '<span class="rt">' + rate + '</span></div>';
    }).join('') + '</div>' +
      (opt.footNote ? '<div class="hint tiny mt8">' + opt.footNote + '</div>' : '');
  }

  /** 迷你趋势折线（近 N 周投递量） */
  function sparkline(values, opt) {
    opt = opt || {};
    var w = opt.width || 260, h = opt.height || 52, pad = 4;
    if (!values.length) values = [0];
    var max = Math.max.apply(null, values) || 1;
    var stepX = (w - pad * 2) / Math.max(1, values.length - 1);
    var pts = values.map(function (v, i) {
      return [pad + i * stepX, h - pad - (v / max) * (h - pad * 2)];
    });
    var line = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join(' ');
    var area = line + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + (h - pad) + ' L' + pts[0][0].toFixed(1) + ' ' + (h - pad) + ' Z';
    var c = opt.color || cssVar('--brand', '#1d4ed8');
    return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '" preserveAspectRatio="none">' +
      '<path d="' + area + '" fill="' + c + '" opacity=".12"/>' +
      '<path d="' + line + '" fill="none" stroke="' + c + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>' +
      pts.map(function (p, i) {
        return '<circle cx="' + p[0].toFixed(1) + '" cy="' + p[1].toFixed(1) + '" r="2.6" fill="' + c + '"><title>' +
          U.esc(opt.labels ? opt.labels[i] : '') + '：' + values[i] + '</title></circle>';
      }).join('') +
      '</svg>';
  }

  /** 进度条（单值） */
  function progress(value, max, opt) {
    opt = opt || {};
    var p = max > 0 ? U.clamp((value / max) * 100, 0, 100) : 0;
    var c = opt.color || cssVar('--brand', '#1d4ed8');
    return '<div style="height:' + (opt.height || 8) + 'px;background:var(--chip);border-radius:5px;overflow:hidden">' +
      '<div style="height:100%;width:' + p + '%;background:' + c + ';border-radius:5px;transition:width .4s"></div></div>';
  }

  global.Charts = {
    PALETTE: PALETTE, color: color,
    donut: donut, legend: legend, bars: bars, funnel: funnel,
    sparkline: sparkline, progress: progress,
  };
})(window);
