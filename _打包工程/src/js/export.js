/* ==========================================================================
   export.js · 导出（Excel / CSV / JSON）+ 导入
   纯前端生成，不依赖任何库。Excel 用 SpreadsheetML 2003（Excel 原生可开）
   ========================================================================== */
(function (global) {
  'use strict';

  /* ---------------- 通用 ---------------- */
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function stamp() {
    var d = new Date();
    return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '_' +
      pad(d.getHours()) + pad(d.getMinutes());
  }

  /** 值归一成可写进表格的字符串 */
  function cell(v) {
    if (v === null || v === undefined) return '';
    if (Array.isArray(v)) return v.join('、');
    if (typeof v === 'object') { try { return JSON.stringify(v); } catch (e) { return String(v); } }
    if (v === true) return '是';
    if (v === false) return '否';
    return String(v);
  }

  /* ---------------- CSV ---------------- */
  function toCSV(headers, rows) {
    var esc = function (v) {
      var s = cell(v);
      return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    var out = [headers.map(function (h) { return esc(h.label !== undefined ? h.label : h); }).join(',')];
    rows.forEach(function (r) {
      out.push(headers.map(function (h) {
        var k = h.key !== undefined ? h.key : h;
        return esc(r[k]);
      }).join(','));
    });
    return out.join('\r\n');
  }

  function downloadCSV(filename, headers, rows) {
    // 加 BOM，否则 Excel 打开中文会乱码
    U.download(filename, '\ufeff' + toCSV(headers, rows), 'text/csv');
  }

  /* ---------------- Excel（SpreadsheetML 2003） ---------------- */
  function xmlEsc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;')
      // 去掉 XML 非法控制字符（不然 Excel 打不开）
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
  }
  function sheetName(s) {
    return String(s || 'Sheet').replace(/[\[\]\*\/\\\?:]/g, '_').slice(0, 31);
  }
  function colName(i) {
    // 0 → A, 25 → Z, 26 → AA
    var s = '';
    i = i + 1;
    while (i > 0) {
      var m = (i - 1) % 26;
      s = String.fromCharCode(65 + m) + s;
      i = Math.floor((i - 1) / 26);
    }
    return s;
  }
  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  /**
   * sheets = [ {name, headers:[{key,label,width?}], rows:[obj]} ]
   */
  function toExcelXML(sheets) {
    var head = '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<?mso-application progid="Excel.Sheet"?>\n' +
      '<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"' +
      ' xmlns:o="urn:schemas-microsoft-com:office:office"' +
      ' xmlns:x="urn:schemas-microsoft-com:office:excel"' +
      ' xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"' +
      ' xmlns:html="http://www.w3.org/TR/REC-html40">\n' +
      '<Styles>\n' +
      '  <Style ss:ID="def"><Font ss:FontName="微软雅黑" ss:Size="10"/><Alignment ss:Vertical="Top" ss:WrapText="1"/></Style>\n' +
      '  <Style ss:ID="hdr"><Font ss:FontName="微软雅黑" ss:Size="10" ss:Bold="1" ss:Color="#17203A"/>' +
      '<Interior ss:Color="#E7EDFB" ss:Pattern="Solid"/>' +
      '<Alignment ss:Vertical="Center" ss:Horizontal="Center" ss:WrapText="1"/>' +
      '<Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#B9C6E4"/></Borders></Style>\n' +
      '  <Style ss:ID="num"><Font ss:FontName="微软雅黑" ss:Size="10"/><Alignment ss:Vertical="Top" ss:Horizontal="Right"/></Style>\n' +
      '</Styles>\n';

    var body = sheets.map(function (sh) {
      var headers = sh.headers || [];
      var rows = sh.rows || [];
      var cols = headers.map(function (h) {
        return '<Column ss:Width="' + (h.width || 130) + '"/>';
      }).join('');
      var hr = '<Row ss:Height="24">' + headers.map(function (h) {
        return '<Cell ss:StyleID="hdr"><Data ss:Type="String">' + xmlEsc(h.label !== undefined ? h.label : h.key) + '</Data></Cell>';
      }).join('') + '</Row>';
      var bodyRows = rows.map(function (r) {
        return '<Row>' + headers.map(function (h) {
          var k = h.key !== undefined ? h.key : h;
          var v = r[k];
          if (isNum(v)) return '<Cell ss:StyleID="num"><Data ss:Type="Number">' + v + '</Data></Cell>';
          return '<Cell ss:StyleID="def"><Data ss:Type="String">' + xmlEsc(cell(v)) + '</Data></Cell>';
        }).join('') + '</Row>';
      }).join('');
      return '<Worksheet ss:Name="' + xmlEsc(sheetName(sh.name)) + '">' +
        '<Table ss:DefaultRowHeight="17" ss:DefaultColumnWidth="90">' + cols + hr + bodyRows + '</Table>' +
        '<WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">' +
        '<FreezePanes/><FrozenNoSplit/><SplitHorizontal>1</SplitHorizontal><TopRowBottomPane>1</TopRowBottomPane>' +
        '<ActivePane>2</ActivePane></WorksheetOptions>' +
        '</Worksheet>';
    }).join('\n');

    return head + body + '</Workbook>';
  }

  function downloadExcel(filename, sheets) {
    U.download(filename, toExcelXML(sheets), 'application/vnd.ms-excel');
  }

  /* ---------------- 业务导出 ---------------- */

  function jobHeaders() {
    return [
      { key: 'title', label: '岗位名称', width: 160 },
      { key: 'company', label: '公司', width: 190 },
      { key: 'industry', label: '行业', width: 100 },
      { key: 'location', label: '地点', width: 110 },
      { key: 'salaryText', label: '薪资', width: 85 },
      { key: 'salaryMin', label: '薪资下限(K)', width: 80 },
      { key: 'salaryMax', label: '薪资上限(K)', width: 80 },
      { key: 'remote', label: '远程', width: 50 },
      { key: 'reqDegree', label: '学历要求', width: 75 },
      { key: 'reqYears', label: '经验要求', width: 80 },
      { key: 'reqSkills', label: '招聘标签', width: 190 },
      { key: 'benefits', label: '福利', width: 150 },
      { key: 'tags', label: '标签', width: 100 },
      { key: 'risks', label: '风险点', width: 190 },
      { key: 'pros', label: '优势', width: 160 },
      { key: 'cons', label: '顾虑', width: 160 },
      { key: 'statusText', label: '投递状态', width: 95 },
      { key: 'matchScore', label: '匹配分', width: 65 },
      { key: 'source', label: '来源', width: 60 },
      { key: 'url', label: '岗位链接', width: 240 },
      { key: 'createdAt', label: '录入时间', width: 130 },
    ];
  }

  /** 把岗位 + 投递记录拼成一行（给 Excel 用） */
  function jobRows(jobs) {
    return jobs.map(function (j) {
      var a = Store.appOfJob(j.id);
      var v = (j.aiVerdict || {});
      return {
        title: j.title, company: j.company, industry: j.industry, location: j.location,
        salaryText: j.salaryText,
        salaryMin: j.salaryMin === null ? '' : j.salaryMin,
        salaryMax: j.salaryMax === null ? '' : j.salaryMax,
        remote: j.remote ? '是' : '',
        reqDegree: j.reqDegree, reqYears: j.reqYears,
        reqSkills: j.reqSkills, benefits: j.benefits, tags: j.tags,
        risks: j.risks, pros: j.pros, cons: j.cons,
        statusText: a ? Store.statusName(a.status) : '未投递',
        matchScore: v.score || '',
        source: j.source === 'boss' ? 'BOSS' : '手动',
        url: j.url,
        createdAt: U.d2t(j.createdAt),
      };
    });
  }

  function appHeaders() {
    return [
      { key: 'job', label: '岗位', width: 170 },
      { key: 'company', label: '公司', width: 190 },
      { key: 'statusText', label: '当前状态', width: 95 },
      { key: 'channel', label: '投递渠道', width: 85 },
      { key: 'resumeName', label: '使用简历', width: 150 },
      { key: 'appliedAt', label: '投递时间', width: 130 },
      { key: 'salaryAsk', label: '沟通薪资', width: 100 },
      { key: 'note', label: '备注', width: 220 },
      { key: 'hrSummary', label: 'HR 沟通摘要', width: 240 },
      { key: 'progress', label: '进展轨迹', width: 280 },
      { key: 'updatedAt', label: '最近更新', width: 130 },
    ];
  }

  function appRows(apps) {
    return apps.map(function (a) {
      var j = Store.job(a.jobId) || {};
      var r = a.resumeId ? Store.resume(a.resumeId) : null;
      return {
        job: j.title || '(岗位已删除)',
        company: j.company || '',
        statusText: Store.statusName(a.status) + (a.status === 'rejected' && a.outcome
          ? '（' + (a.outcome === 'self' ? '我拒公司' : '公司拒我') + '）' : ''),
        channel: a.channel,
        resumeName: r ? r.name : '',
        appliedAt: a.appliedAt ? U.d2(a.appliedAt) : '',
        salaryAsk: a.salaryAsk,
        note: a.note,
        hrSummary: a.hrSummary,
        progress: (a.timeline || []).map(function (t) { return U.d2(t.at) + ' ' + Store.statusName(t.status); }).join(' → '),
        updatedAt: U.d2t(a.updatedAt),
      };
    });
  }

  function interviewHeaders() {
    return [
      { key: 'at', label: '面试时间', width: 140 },
      { key: 'job', label: '岗位', width: 170 },
      { key: 'company', label: '公司', width: 180 },
      { key: 'round', label: '轮次', width: 130 },
      { key: 'modeText', label: '形式', width: 60 },
      { key: 'link', label: '会议链接 / 地点', width: 220 },
      { key: 'interviewers', label: '面试官', width: 130 },
      { key: 'statusText', label: '状态', width: 70 },
      { key: 'resultText', label: '结果', width: 70 },
      { key: 'notes', label: '面试记录', width: 260 },
      { key: 'review', label: '复盘', width: 300 },
    ];
  }

  function interviewRows(list) {
    var MODE = { online: '线上', offline: '线下', phone: '电话' };
    var ST = { scheduled: '待进行', done: '已完成', canceled: '已取消' };
    var RS = { pass: '通过', fail: '未通过', pending: '等结果', unknown: '' };
    return list.map(function (v) {
      var j = Store.job(v.jobId) || {};
      return {
        at: v.at ? U.d2t(v.at) : '',
        job: j.title || '', company: j.company || '',
        round: v.round,
        modeText: MODE[v.mode] || v.mode,
        link: v.mode === 'offline' ? v.place : v.link,
        interviewers: v.interviewers,
        statusText: ST[v.status] || v.status,
        resultText: RS[v.result] || '',
        notes: v.notes, review: v.review,
      };
    });
  }

  /**
   * 一键导出「全量 Excel」（多工作表）
   */
  function exportExcel() {
    var allJobs = Store.jobs({ includeArchived: true });
    var apps = Store.applications();
    var ivs = Store.interviews();
    var st = Store.stats();

    var summary = [
      { k: '统计项', v: '数值' },
      { k: '岗位总数（不含归档）', v: st.jobTotal },
      { k: '　其中 BOSS 导入', v: st.jobBoss },
      { k: '　其中手动新增', v: st.jobManual },
      { k: '收藏岗位', v: st.jobFavorite },
      { k: '投递记录数', v: st.appTotal },
      { k: '实际投递数', v: st.appliedTotal },
      { k: '面试场次', v: st.interviewTotal },
      { k: '待进行面试', v: st.interviewUpcoming },
      { k: 'Offer 数', v: st.offerTotal },
      { k: '简历版本数', v: st.resumeTotal },
      { k: '素材数', v: st.materialTotal },
      { k: 'AI 对话数', v: st.chatTotal },
      { k: '查看转化率', v: st.viewRate + '%' },
      { k: '面试邀约率', v: st.inviteRate + '%' },
      { k: 'Offer 转化率', v: st.offerRate + '%' },
      { k: '导出时间', v: U.d2t(U.now()) },
    ];

    var funnelRows = st.funnel.map(function (f, i) {
      return { step: f.name, n: f.n, rate: i === 0 ? '100%' : U.pct(f.n, st.funnel[0].n) + '%' };
    });

    downloadExcel('求职猎手_全量数据_' + stamp() + '.xls', [
      { name: '总览', headers: [{ key: 'k', label: '统计项', width: 190 }, { key: 'v', label: '数值', width: 130 }], rows: summary },
      { name: '岗位库', headers: jobHeaders(), rows: jobRows(allJobs) },
      { name: '投递记录', headers: appHeaders(), rows: appRows(apps) },
      { name: '面试记录', headers: interviewHeaders(), rows: interviewRows(ivs) },
      { name: '求职漏斗', headers: [{ key: 'step', label: '环节', width: 110 }, { key: 'n', label: '数量', width: 70 }, { key: 'rate', label: '占投递比', width: 90 }], rows: funnelRows },
      { name: '状态分布', headers: [{ key: 's', label: '状态', width: 120 }, { key: 'n', label: '数量', width: 70 }], rows: Store.STATUSES.map(function (s) { return { s: s.name, n: st.byStatus[s.id] || 0 }; }) },
      { name: '行业分布', headers: [{ key: 'name', label: '行业', width: 150 }, { key: 'n', label: '岗位数', width: 80 }], rows: st.industryDist },
      { name: '薪资分布', headers: [{ key: 'name', label: '薪资区间', width: 110 }, { key: 'n', label: '岗位数', width: 80 }], rows: st.salaryDist },
    ]);
    return true;
  }

  function exportJobsCSV() {
    downloadCSV('岗位库_' + stamp() + '.csv', jobHeaders(), jobRows(Store.jobs({ includeArchived: true })));
    return true;
  }
  function exportAppsCSV() {
    downloadCSV('投递记录_' + stamp() + '.csv', appHeaders(), appRows(Store.applications()));
    return true;
  }

  /**
   * 导出 JSON 备份。**默认脱敏**（不写模型 Key）—— 见 store.js 里 exportObject 的注释。
   * keepApiKey=true 时才连 Key 一起导出（用户显式勾选）。
   */
  function exportJSON(keepApiKey) {
    U.download('求职猎手_备份_' + stamp() + '.json',
      JSON.stringify(Store.exportObject({ keepApiKey: !!keepApiKey }), null, 2), 'application/json');
    return true;
  }

  /**
   * 「导出 JSON 备份」的入口：本地有模型 Key 时先问一句要不要连它一起导出。
   *
   * 为什么每次都要问：这是**不可撤回的外发动作** —— 文件一旦落进网盘或聊天记录，
   * Key 就等于交出去了。所以默认选项是安全的那一侧（不导出 Key）。
   * 本地根本没有 Key 时不问、直接导（问了也是白问）。
   */
  function exportJSONFlow() {
    var S = Store.settings() || {};
    if (!(S.ai && S.ai.apiKey)) { exportJSON(false); return null; }
    var body =
      '<div class="note warn"><span class="ico">⚠️</span><div>' +
      '备份文件常被丢进网盘、或发给别人帮看。<b>默认不导出大模型 API Key</b> ——' +
      '这样别人拿到这份文件也用不了你的额度。</div></div>' +
      '<label class="chk mt12" style="display:flex;align-items:center;gap:8px">' +
      '<input type="checkbox" id="expKeepKey">' +
      '<span>连 API Key 一起导出（只在你要把完整配置迁到另一台机器时才需要）</span></label>';
    return U.openModal({
      title: '导出 JSON 备份',
      size: 'sm',
      body: body,
      maskClose: false,
      footer: [
        { text: '导出', cls: 'pri', onClick: function (c) {
          var chk = global.document.getElementById('expKeepKey');
          var keep = !!(chk && chk.checked);
          c();                                     // 先关窗再干活（本项目弹窗约定）
          exportJSON(keep);
        } },
        { text: '取消', onClick: function (c) { c(); } },
      ],
    });
  }

  /**
   * 导入 JSON 备份。返回 Promise<报告>
   */
  function importJSON(mode) {
    mode = mode || 'merge';
    return U.pickFile('.json,application/json').then(function (f) {
      if (!f) return null;
      return U.readText(f).then(function (txt) {
        var obj;
        try { obj = JSON.parse(txt); }
        catch (e) { throw new Error('这个文件不是合法的 JSON：' + e.message); }
        return Store.importObject(obj, mode);
      });
    });
  }

  /**
   * 导入 boss-crawler 爬取产出的岗位文件（JSON / CSV）
   * 兼容 qualified_jobs.json / scored_jobs.json / postdata/*.csv
   */
  function importBossCrawler() {
    return U.pickFile('.json,.csv', true).then(function (files) {
      if (!files || !files.length) return null;
      var all = [];
      var jobs = files.map(function (f) {
        return U.readText(f).then(function (txt) {
          var arr = parseBossCrawlerFile(txt, f.name);
          all = all.concat(arr);
          return arr.length;
        });
      });
      return Promise.all(jobs).then(function () {
        // ⛔ 必须走**批量**入口（评审 P1-6）：逐条 addJob 是「一条 = 一次 save + 一次 fire，
        //   且每条都拿 DB.jobs 全量线性扫一遍算去重键」⇒ 库上千条时导入会假死
        //   （store.js 的 addJobs 注释里有真机实测：506 条 → fire 507 次 → 事件循环堵死 1885ms）。
        //   addJobs 整批只建一次索引、只落一次盘、只广播一次，语义与逐条完全一致
        //   （同一批里后面的能命中前面刚加的、重复时第一个匹配赢）。
        //   ⛔ 广播由 addJobs 内部负责，这里**不能再补一次 Store.fire('jobs')** —— 那是两次广播。
        var r = Store.addJobs(all);
        return { files: files.length, total: all.length, added: r.added, dup: r.dup };
      });
    });
  }

  /** 中文字段别名（跟 boss-crawler 的 CSV_FIELDS 对齐） */
  var ALIAS = {
    title: ['title', 'position', 'job_name', 'jobName', '岗位', '岗位名称', '职位', '职位名称'],
    company: ['company', 'brand_name', 'brandName', '公司', '公司名称'],
    salaryText: ['salary', 'salary_desc', '薪资', '薪资范围'],
    location: ['location', 'city', 'area', '城市', '地点', '工作地点'],
    industry: ['industry', '领域', '行业'],
    reqDegree: ['degree', '学历', '学历要求'],
    reqYears: ['experience', 'exp', '经验', '经验要求'],
    reqSkills: ['skills', 'skill_tags', '技能标签', '技能'],
    benefits: ['welfare', 'benefits', 'welfare_tags', '福利标签', '福利'],
    rawJD: ['jd', 'job_desc', 'description', '岗位要求和职责', '岗位描述', 'jd_text'],
    url: ['link', 'url', 'job_url', '链接', '岗位链接'],
    scale: ['scale', '公司规模', '规模'],
    hr: ['hr', 'hr_name', 'HR姓名'],
    active: ['active', 'active_time', 'activeTimeDesc', 'hr_active', 'HR活跃度', '活跃度'],
    // —— 详情 API 才有、以前采回来却被丢掉的列（列名对齐 boss-crawler 的 CSV_FIELDS）——
    district: ['district', '区域'],                       // 区（城市下钻）
    /* ⚠️ 商圈本来就在采集 CSV 里（「商圈」列），但之前**没接** —— 于是
       「按区/商圈精筛」这件事一直缺一半数据。这一轮补上。 */
    bizArea: ['biz_area', 'businessDistrict', '商圈'],
    lngLat: ['位置', 'geo', 'latlng', 'location_geo'],    // 经纬度（Python dict 字符串，见 parseLatLng）
    address: ['address', '地址', '详细地址'],
    companyInfo: ['company_info', 'companyIntro', '公司信息', '公司简介'],
    invalid: ['invalid', 'expired', '已失效'],            // 岗位已下线
    proxyHire: ['proxy_hire', 'proxyHire', '代招', '代招/外包'],  // 代招/外包（用工主体）
    hrTitle: ['hr_title', 'hrTitle', 'HR职位'],
    hrOnline: ['hr_online', 'hrOnline', 'HR在线'],
  };

  function pickField(obj, names) {
    var lower = {};
    Object.keys(obj).forEach(function (k) { lower[String(k).toLowerCase().trim()] = obj[k]; });
    for (var i = 0; i < names.length; i++) {
      var n = names[i].toLowerCase();
      if (lower[n] !== undefined && lower[n] !== null && lower[n] !== '') return lower[n];
    }
    return '';
  }

  function parseBossCrawlerFile(txt, filename) {
    var t = String(txt || '').trim();
    if (!t) return [];
    var arr = [];

    if (t.charAt(0) === '{' || t.charAt(0) === '[') {
      var data = U.extractJSON(t);
      if (!data) return [];
      if (Array.isArray(data)) arr = data;
      else if (Array.isArray(data.jobs)) arr = data.jobs;
      else if (Array.isArray(data.qualified_jobs)) arr = data.qualified_jobs;
      else if (Array.isArray(data.items)) arr = data.items;
      else if (typeof data === 'object') {
        // {link: {...}} 形式
        var vals = Object.keys(data).map(function (k) {
          var v = data[k];
          if (v && typeof v === 'object' && !v.title && !v['职位']) { v = Object.assign({ link: k }, v); }
          return v;
        });
        arr = vals.filter(function (v) { return v && typeof v === 'object'; });
      }
    } else {
      arr = parseCSV(t);
    }

    return arr.map(fromCrawlerRecord).filter(Boolean);
  }

  /**
   * 把**一条** boss-crawler 原始记录（中文列名）规范化成工作台的岗位对象。
   *
   * 抽出来是为了让「文件导入」和「在线采集」共用同一套映射 —— 否则两处
   * 各维护一份字段对照表，改一处忘一处，早晚对不上。
   * 采集接口 /api/jobs 直接回吐原始记录，到这里再翻译。
   */
  function fromCrawlerRecord(o) {
    if (!o || typeof o !== 'object') return null;
    var sal = String(pickField(o, ALIAS.salaryText) || '');
    var r = parseSalary(sal);
    var jd = String(pickField(o, ALIAS.rawJD) || '');
    var skills = U.asArray(pickField(o, ALIAS.reqSkills), true);
    // 「已失效」「代招」「HR在线」在 CSV 里是「是 / 否」文本，不是布尔 —— 只有明确是「是」才算真
    var isYes = function (v) { return /^(是|有|yes|y|true|1)$/i.test(String(v == null ? '' : v).trim()); };
    var out = {
      source: 'boss',
      title: String(pickField(o, ALIAS.title) || '').trim(),
      company: String(pickField(o, ALIAS.company) || '').trim(),
      industry: String(pickField(o, ALIAS.industry) || '').trim(),
      location: String(pickField(o, ALIAS.location) || '').trim(),
      salaryText: sal,
      salaryMin: r.min, salaryMax: r.max, salaryMonths: r.months,
      benefits: U.asArray(pickField(o, ALIAS.benefits), true),
      reqDegree: String(pickField(o, ALIAS.reqDegree) || '').trim(),
      reqYears: String(pickField(o, ALIAS.reqYears) || '').trim(),
      reqSkills: skills,
      keywords: skills.slice(0, 12),
      duties: extractDuties(jd),
      rawJD: jd,
      url: String(pickField(o, ALIAS.url) || '').trim(),
      scale: String(pickField(o, ALIAS.scale) || '').trim(),
      hr: String(pickField(o, ALIAS.hr) || '').trim(),
      active: String(pickField(o, ALIAS.active) || '').trim(),
      // —— 以前采到了却在这里被丢掉、现在接上 ——
      district: String(pickField(o, ALIAS.district) || '').trim(),
      bizArea: String(pickField(o, ALIAS.bizArea) || '').trim(),
      latlng: parseLatLng(pickField(o, ALIAS.lngLat)),
      address: String(pickField(o, ALIAS.address) || '').trim(),
      companyInfo: String(pickField(o, ALIAS.companyInfo) || '').trim(),
      invalid: isYes(pickField(o, ALIAS.invalid)),
      proxyHire: isYes(pickField(o, ALIAS.proxyHire)),
      hrTitle: String(pickField(o, ALIAS.hrTitle) || '').trim(),
      hrOnline: isYes(pickField(o, ALIAS.hrOnline)),
    };

    /* 权威岗位要求兜底（P1-5）：采集器会把 assets/job_requirements.json 里
       「从 JD 抽出的结构化要求」挂在 _reqAuthoritative 上。BOSS 列表页的
       学历/经验常为空或写得很粗，这里**只在原字段为空时**用它兜底 ——
       不覆盖已有值（列表页写了的就以列表页为准，那是 BOSS 的官方口径）。
       技能要求会拼成文本放进 reqSkillsText，供合适度打分参考。 */
    var ra = o._reqAuthoritative;
    if (ra && typeof ra === 'object') {
      if (!out.reqDegree && ra['学历要求']) out.reqDegree = String(ra['学历要求']).trim();
      if (!out.reqYears && ra['经验要求']) out.reqYears = String(ra['经验要求']).trim();
      var rskills = U.asArray(ra['技能要求'], true);
      if (rskills.length) out.reqSkillsAuthoritative = rskills;
    }

    return (out.title || out.company) ? out : null;
  }

  /**
   * CSV 的「位置」列长这样：{'longitude': 120.17466, 'latitude': 30.18683}
   * —— 是 **Python dict 的 repr，不是 JSON**（单引号、键没引号），JSON.parse 会炸。
   * 所以用两个正则抠数字。拿不到就返回 null（**不编造坐标** —— 编了比没有更糟，
   * 用户会拿它算通勤距离）。
   */
  function parseLatLng(v) {
    if (!v) return null;
    if (typeof v === 'object') {
      var lo = v.lng !== undefined ? v.lng : v.longitude;
      var la = v.lat !== undefined ? v.lat : v.latitude;
      return (lo !== undefined && la !== undefined) ? { lng: Number(lo), lat: Number(la) } : null;
    }
    var s = String(v);
    var m1 = s.match(/['"]?(?:lng|longitude)['"]?\s*:\s*(-?\d+(?:\.\d+)?)/i);
    var m2 = s.match(/['"]?(?:lat|latitude)['"]?\s*:\s*(-?\d+(?:\.\d+)?)/i);
    if (!m1 || !m2) return null;
    var lng = parseFloat(m1[1]), lat = parseFloat(m2[1]);
    if (!isFinite(lng) || !isFinite(lat)) return null;
    return { lng: lng, lat: lat };
  }

  /**
   * "15-25K·14薪" / "1-2万" / "20-40K" / "10000-20000" / "面议" → {min,max,months}
   * **min/max 统一换算成 K（千元/月）**。
   *
   * ⛔ 这里踩过一个很隐蔽的坑（评审 4.7，我实测复现过）：
   *    老写法是先 `s.match(/(\d+(?:\.\d+)?)\s*[kK千万]?/g)` 把数字全抠出来，
   *    再「谁带『万』谁 ×10」。于是：
   *      · `"1-2万"` 抠出 `["1", "2万"]` —— **单位只作用在第二个数上** → min=1, max=20（应 10~20）
   *      · `"10000-20000"`（原始元，没有任何单位）→ 被当 K 用，**差 1000 倍**
   *    两者都会经 job-score 的「起点就 ≥ 期望」档位影响排序。
   *
   *    现在改成：先抠「区间 + 它后面的单位」，**同一个单位同时作用于两个端点**；
   *    完全没有单位时，用数值大小判断是元还是 K（BOSS 自己只会写 K 或 万，这条是防别的来源）。
   */
  function parseSalary(s) {
    s = String(s || '');
    var months = null;
    var mm = s.match(/(\d+)\s*薪/);
    if (mm) months = parseInt(mm[1], 10);

    // 日结（"300-500元/天"）不是「K/月」的语义，硬换算只会得到错的数 →
    // 明确当「没采到」（null），而不是给一个看着像月薪的假数字。
    if (/\/\s*[天日]/.test(s)) return { min: null, max: null, months: months };

    // 「14薪」「13薪」是奖金月数、不是薪资 —— 先摘掉，免得被当成区间端点
    var body = mm ? s.replace(mm[0], ' ') : s;

    // 端点 + 可选单位。单位可能只写在后一个上面（1-2万 / 1万-2万 / 8-13K）
    var re = /(\d+(?:\.\d+)?)\s*([kK千万元]?)\s*(?:[-~－—到至]\s*(\d+(?:\.\d+)?)\s*([kK千万元]?))?/;
    var m = re.exec(body);
    if (!m) return { min: null, max: null, months: months };

    function toK(numStr, unit) {
      var v = parseFloat(numStr);
      if (!isFinite(v) || v <= 0) return null;
      var u = String(unit || '');
      if (/万/.test(u)) return v * 10;          // 1 万/月 = 10K
      if (/[kK千]/.test(u)) return v;           // K / 千 都是千元
      if (/元/.test(u)) return v / 1000;        // 明确标了元 → 换算成 K
      // 没写单位：BOSS 只会写 K 或 万，走到这里多半是别的来源给的原始元
      return v >= 1000 ? v / 1000 : v;
    }

    var u2 = m[4] || m[2];                      // 「1-2万」的单位落在后一个数上
    var a = toK(m[1], m[2] || u2);              // 单位只写一次时，两个端点共用它
    var b = (m[3] != null) ? toK(m[3], u2) : null;

    if (a != null && b != null) return { min: Math.min(a, b), max: Math.max(a, b), months: months };
    if (a != null) return { min: a, max: a, months: months };
    return { min: null, max: null, months: months };
  }

  /** 从 JD 文本里粗提职责（【岗位职责】段） */
  function extractDuties(jd) {
    if (!jd) return [];
    var m = String(jd).match(/【?岗位职责】?[：:]?\s*([\s\S]{0,600}?)(?=【|任职要求|岗位要求|$)/);
    var seg = m ? m[1] : '';
    return U.lines(seg).slice(0, 12);
  }

  /** 极简 CSV 解析（支持引号包裹、字段内逗号与换行） */
  function parseCSV(text) {
    var rows = [], cur = [], val = '', q = false;
    for (var i = 0; i < text.length; i++) {
      var c = text[i];
      if (q) {
        if (c === '"') {
          if (text[i + 1] === '"') { val += '"'; i++; }
          else q = false;
        } else val += c;
      } else {
        if (c === '"') q = true;
        else if (c === ',') { cur.push(val); val = ''; }
        else if (c === '\n') { cur.push(val); rows.push(cur); cur = []; val = ''; }
        else if (c === '\r') { /* skip */ }
        else val += c;
      }
    }
    if (val !== '' || cur.length) { cur.push(val); rows.push(cur); }
    if (!rows.length) return [];
    var head = rows[0].map(function (h) { return String(h).replace(/^\ufeff/, '').trim(); });
    return rows.slice(1).filter(function (r) { return r.some(function (x) { return String(x).trim(); }); })
      .map(function (r) {
        var o = {};
        head.forEach(function (h, i) { o[h] = r[i] === undefined ? '' : r[i]; });
        return o;
      });
  }

  global.Exporter = {
    toCSV: toCSV, toExcelXML: toExcelXML, downloadCSV: downloadCSV, downloadExcel: downloadExcel,
    exportExcel: exportExcel, exportJobsCSV: exportJobsCSV, exportAppsCSV: exportAppsCSV,
    exportJSON: exportJSON, exportJSONFlow: exportJSONFlow,
    importJSON: importJSON, importBossCrawler: importBossCrawler,
    parseBossCrawlerFile: parseBossCrawlerFile, fromCrawlerRecord: fromCrawlerRecord,
    parseSalary: parseSalary, parseCSV: parseCSV, parseLatLng: parseLatLng,
    jobHeaders: jobHeaders, jobRows: jobRows, appHeaders: appHeaders, appRows: appRows,
    interviewHeaders: interviewHeaders, interviewRows: interviewRows, stamp: stamp,
  };
})(window);
