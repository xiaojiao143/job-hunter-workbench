/* ==========================================================================
   geo.js · 地理筛选（省 > 市 > 区 > 商圈 / 地标）
   --------------------------------------------------------------------------
   给三处共用：岗位库筛选、采集页筛选、求职偏好里的「期望城市」。

   ⚠️ 数据来源分三层，按可靠性排序 —— 这是整个模块的设计前提：
     ① **内置行政区划**：只写公开、稳定、能查证的省市辖区（主要城市）。
        它只是「候选」不是真理 —— 行政区划会调整，换城市也可能过时。
     ② **库里真实枚举**（岗位的 district / bizArea）：永远优先，因为是真采回来的。
     ③ **用户手输**：兜底。

   ⛔ **省 / 市 / 区 只作候选，绝不参与匹配判定**（判定只认 cityHit / geoHit）。
      拿候选名单去筛岗位的后果是**静默漏掉**岗位，而用户不知道是名单的问题。

   ⛔ **商圈和地铁一律不内置。** 每个城市的商圈名没有权威公开清单，
      凭印象写一份 = 编造；用户照着一份假清单去筛，会**静默漏掉岗位**，
      而且他不会知道是清单的问题。商圈只从真实采集数据里枚举；
      地铁用「地标关键词」在 商圈 / 地址 / 城市 里做子串匹配（见 landmarkHit）。

   ⛔ 匹配口径与「城市包含匹配」保持一致（job-match.js 的 cityHit）：
      **子串包含 + 大小写不敏感**，不用精确相等。

   ⛔ **没采到区 / 商圈的岗位默认保留**（strict=false），但会被显式标出来
      （见 unknownArea）。理由同「薪资为空的岗位一律保留」：
      按"没写就筛掉"处理，用户会以为岗位丢了。想只看明确命中的，开严格模式。
   ========================================================================== */
(function (global) {
  'use strict';

  function trim(s) { return String(s === null || s === undefined ? '' : s).trim(); }
  function low(s) { return trim(s).toLowerCase(); }

  /* ==================== 城市 ==================== */

  /* 与 job-match.js 的自然语言解析同一份名单（那边解析「杭州 运营 15k」要用）。
     顺序按「求职者密度」大致排，靠前的在偏好面板里优先露出。 */
  var CITIES = [
    '北京', '上海', '广州', '深圳', '杭州', '成都', '武汉', '南京', '西安', '苏州',
    '长沙', '重庆', '天津', '郑州', '青岛', '合肥', '福州', '厦门', '济南', '宁波',
    '无锡', '东莞', '佛山', '珠海', '南昌', '昆明', '贵阳', '南宁', '石家庄', '太原',
    '沈阳', '大连', '哈尔滨', '长春', '兰州', '乌鲁木齐', '海口', '三亚',
  ];

  /* ==================== 区（市辖区）====================
     ⚠️ 只作**候选**：用户可以在下面手输；库里采到的区永远优先合并进来。
     只写能查证的地级市市辖区，不写开发区/高新区这类会变的功能区名
     （那些让真实数据来补）。 */

  var DISTRICTS = {
    '杭州': ['上城区', '拱墅区', '西湖区', '滨江区', '萧山区', '余杭区', '临平区',
      '钱塘区', '富阳区', '临安区', '桐庐县', '淳安县', '建德市'],
    '上海': ['黄浦区', '徐汇区', '长宁区', '静安区', '普陀区', '虹口区', '杨浦区',
      '闵行区', '宝山区', '嘉定区', '浦东新区', '金山区', '松江区', '青浦区',
      '奉贤区', '崇明区'],
    '北京': ['东城区', '西城区', '朝阳区', '丰台区', '石景山区', '海淀区',
      '门头沟区', '房山区', '通州区', '顺义区', '昌平区', '大兴区', '怀柔区',
      '平谷区', '密云区', '延庆区'],
    '深圳': ['福田区', '罗湖区', '南山区', '宝安区', '龙岗区', '盐田区', '龙华区',
      '坪山区', '光明区'],
    '广州': ['荔湾区', '越秀区', '海珠区', '天河区', '白云区', '黄埔区', '番禺区',
      '花都区', '南沙区', '从化区', '增城区'],
  };

  /* ==================== 省（省 / 自治区 / 直辖市）====================
     ⚠️ 同 DISTRICTS：**只作候选**，只收录本项目城市名单（CITIES）覆盖得到的省。
     顺序大致按求职者密度，与 CITIES 同源。

     ⛔ 它**绝不参与匹配判定**（匹配只认 cityHit / geoHit），只用来**收窄下一级
        「城市」的候选**。理由是同一个：省级名单比城市名单更容易滞后，
        一旦拿它去筛岗位，用户会**静默漏掉**岗位还不知道是名单的问题。

     ⛔ 直辖市（北京/上海/天津/重庆）自成一级：省名 = 市名 + 「市」。
        这样「省 → 市」永远是同一套两级结构，不用给它开特例分支。 */
  var PROVINCES = [
    { name: '北京市', cities: ['北京'] },
    { name: '上海市', cities: ['上海'] },
    { name: '广东省', cities: ['深圳', '广州', '东莞', '佛山', '珠海'] },
    { name: '浙江省', cities: ['杭州', '宁波'] },
    { name: '江苏省', cities: ['南京', '苏州', '无锡'] },
    { name: '天津市', cities: ['天津'] },
    { name: '重庆市', cities: ['重庆'] },
    { name: '四川省', cities: ['成都'] },
    { name: '湖北省', cities: ['武汉'] },
    { name: '陕西省', cities: ['西安'] },
    { name: '湖南省', cities: ['长沙'] },
    { name: '河南省', cities: ['郑州'] },
    { name: '山东省', cities: ['青岛', '济南'] },
    { name: '安徽省', cities: ['合肥'] },
    { name: '福建省', cities: ['福州', '厦门'] },
    { name: '江西省', cities: ['南昌'] },
    { name: '云南省', cities: ['昆明'] },
    { name: '贵州省', cities: ['贵阳'] },
    { name: '广西壮族自治区', cities: ['南宁'] },
    { name: '河北省', cities: ['石家庄'] },
    { name: '山西省', cities: ['太原'] },
    { name: '辽宁省', cities: ['沈阳', '大连'] },
    { name: '黑龙江省', cities: ['哈尔滨'] },
    { name: '吉林省', cities: ['长春'] },
    { name: '甘肃省', cities: ['兰州'] },
    { name: '新疆维吾尔自治区', cities: ['乌鲁木齐'] },
    { name: '海南省', cities: ['海口', '三亚'] },
  ];

  /* 去行政后缀的归一形：「杭州市」「杭州地区」都 → 「杭州」。
     只在**查表**时用，不改变对外展示的值。 */
  function normCity(s) {
    return trim(s).replace(/(市|地区|自治州|盟)$/, '');
  }

  /* 城市 → 省 的反查表（建一次）。键是归一形，所以「杭州」与「杭州市」都能查到。 */
  var CITY_PROVINCE = (function () {
    var m = {};
    PROVINCES.forEach(function (p) {
      (p.cities || []).forEach(function (c) { m[normCity(c)] = p.name; });
    });
    return m;
  })();

  /** 城市 → 省名。⛔ 查不到就返回 ''（不瞎猜）——「未知」是有效答案，调用方自己决定怎么办。 */
  function provinceOfCity(city) {
    return CITY_PROVINCE[normCity(city)] || '';
  }

  /** 省名 → 该省内置的城市候选（省名未知则空数组）。 */
  function citiesOfProvince(name) {
    var n = trim(name);
    var hit = PROVINCES.filter(function (p) { return p.name === n; })[0];
    return hit ? hit.cities.slice() : [];
  }

  /* 「杭州·西湖区」「西湖区」「杭州 滨江区」都能取出「西湖区」。
     刻意**不认**以「市」结尾的片段 —— 「杭州市」会被误当区名。 */
  var DIST_RE = /([\u4e00-\u9fa5]{2,6}?(?:区|县))/;

  /**
   * 取出岗位的「区」。
   * ① 优先用显式字段（采集 CSV 的「区域」列 → job.district）
   * ② 没有再回落到 location 里猜（历史数据 / 手动粘贴的岗位常常只有「杭州·西湖区」）
   */
  function extractDistrict(job) {
    if (!job) return '';
    var d = trim(job.district) || trim(job.areaDistrict);
    if (d) return d;
    var loc = trim(job.location);
    if (!loc) return '';
    var m = loc.match(DIST_RE);
    return m ? m[1] : '';
  }

  /** 取出岗位的「商圈」。只有采集数据里才有（CSV 的「商圈」列 → job.bizArea）。 */
  function extractBizArea(job) {
    if (!job) return '';
    return trim(job.bizArea) || trim(job.businessDistrict);
  }

  /* ==================== 从真实数据枚举 ==================== */

  function uniq(arr) {
    var seen = {};
    return (arr || []).filter(function (x) {
      x = trim(x);
      if (!x || seen[x]) return false;
      seen[x] = 1;
      return true;
    });
  }

  /** 岗位所在地点命中的**内置城市**（判不出就返回 ''）。用于把岗位归到省。 */
  function cityOf(job) {
    var loc = trim(job && job.location);
    if (!loc) return '';
    for (var i = 0; i < CITIES.length; i++) { if (loc.indexOf(CITIES[i]) >= 0) return CITIES[i]; }
    return '';
  }

  /** 库里出现过的城市（从岗位 location 里取，按出现次数降序） */
  function citiesOf(jobs) {
    var cnt = {};
    (jobs || []).forEach(function (j) {
      var loc = trim(j && j.location);
      if (!loc) return;
      CITIES.forEach(function (c) { if (loc.indexOf(c) >= 0) cnt[c] = (cnt[c] || 0) + 1; });
      // 没命中内置名单的也留着（防止只做小城市的人一个选项都没有）
      if (!CITIES.some(function (c) { return loc.indexOf(c) >= 0; })) {
        var g = loc.split(/[·\s\-—,，、/|]+/)[0];
        if (g) cnt[g] = (cnt[g] || 0) + 1;
      }
    });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
  }

  /**
   * 某个城市（或某组城市）的「区」候选 = 内置行政区划 ∪ 库里真的采到过的区。
   * 顺序：真实数据在前（更可信、也更贴近这个人实际在看的范围）。
   *
   * ⚠️ `city` 允许传**字符串或数组**（多选城市时传数组 = 这些城市的区并集）。
   *    换城市时区候选跟着换，所以调用方必须把上一轮的区清掉 —— 否则会留下
   *    「上海 + 西湖区」这种跨市组合，界面上看着有选、实际一条都命中不了。
   */
  function districtsOf(city, jobs) {
    var cs = Array.isArray(city)
      ? city.map(trim).filter(Boolean)
      : (trim(city) ? [trim(city)] : []);
    var real = [];
    (jobs || []).forEach(function (j) {
      if (cs.length) {
        var loc = trim(j && j.location);
        // 指定了城市就只收这些城市的岗位；没指定就全收
        if (loc && !cs.some(function (c) { return loc.indexOf(c) >= 0; })) return;
      }
      var d = extractDistrict(j);
      if (d) real.push(d);
    });
    /* 内置区划：城市名可能是「杭州」也可能是「杭州市」→ 两种键都试一下，
       否则用户手输过「杭州市」时，内置区划会**静默消失**（看着像"这个市没区"）。 */
    var builtin = [];
    cs.forEach(function (c) {
      builtin = builtin.concat(DISTRICTS[c] || DISTRICTS[normCity(c)] || []);
    });
    return uniq(real).concat(
      uniq(builtin).filter(function (d) { return real.indexOf(d) < 0; })
    );
  }

  /**
   * 省的候选 = **全部内置省**，库里有岗位的排前面（其余保持密度序）。
   * ⛔ 这里**不提供手输兜底**：手写一个没有城市映射的省名，下一级必然空，
   *    用户会以为「选了省就采不到岗位」。要搜没收录的地方，走「城市」的手输框
   *    （城市才是真正传给 BOSS 的搜索条件）。
   */
  function provinceChoices(jobs) {
    var has = {};
    (jobs || []).forEach(function (j) {
      var p = provinceOfCity(cityOf(j));
      if (p) has[p] = 1;
    });
    var inLib = [], rest = [];
    PROVINCES.forEach(function (p) { (has[p.name] ? inLib : rest).push(p.name); });
    return inLib.concat(rest);
  }

  /**
   * 选中若干省后的「城市」候选 = 这些省内置城市的并集 ∪ 库里真实采到、且能判出
   * 属于这些省的城市。
   *
   * ⛔ `provinces` 为空（用户没选省）→ **原样退回 cityChoices(jobs)**，
   *    也就是"不限省"时的老行为，一个候选都不能少 —— 否则用户会发现
   *    「我什么都没选，城市列表却变短了」。
   */
  function citiesIn(provinces, jobs) {
    var ps = Array.isArray(provinces) ? provinces.map(trim).filter(Boolean)
      : (trim(provinces) ? [trim(provinces)] : []);
    if (!ps.length) return cityChoices(jobs);
    var out = [];
    ps.forEach(function (p) { out = out.concat(citiesOfProvince(p)); });
    /* 内置名单会滞后：库里真实出现、且能判出省的，也并进来。 */
    (jobs || []).forEach(function (j) {
      var c = cityOf(j);
      if (c && ps.indexOf(provinceOfCity(c)) >= 0) out.push(c);
    });
    return uniq(out);
  }

  /**
   * 某个区（或某组区）的「商圈」候选。
   * ⛔ **只来自真实数据** —— 没采到就是空，前端要如实说"还没采到"，
   * 而不是给一份猜的清单。district 为空时收全部（用户还没选区）。
   */
  function bizAreasOf(districts, jobs) {
    var ds = Array.isArray(districts) ? districts.filter(Boolean) : (districts ? [districts] : []);
    var cnt = {};
    (jobs || []).forEach(function (j) {
      var b = extractBizArea(j);
      if (!b) return;
      if (ds.length) {
        var d = extractDistrict(j);
        if (!d || !ds.some(function (x) { return d.indexOf(x) >= 0 || x.indexOf(d) >= 0; })) return;
      }
      cnt[b] = (cnt[b] || 0) + 1;
    });
    return Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
  }

  /* ==================== 匹配 ==================== */

  /** 城市命中：岗位 location **包含**任一目标城市（口径同 job-match.js 的 cityHit） */
  function cityHit(job, cities) {
    if (!cities || !cities.length) return true;
    var loc = low(job && job.location);
    if (!loc) return false;               // 地点为空 → 不能算命中目标城市（与旧口径一致）
    return cities.some(function (c) {
      var cc = low(c);
      return cc && loc.indexOf(cc) >= 0;
    });
  }

  function anyHit(value, wanted) {
    if (!wanted || !wanted.length) return true;
    var v = low(value);
    if (!v) return null;                  // null = 没数据（调用方决定保不保留）
    return wanted.some(function (x) {
      var xx = low(x);
      return xx && (v.indexOf(xx) >= 0 || xx.indexOf(v) >= 0);   // 双向包含：「滨江」能命中「滨江区」
    });
  }

  /** 地标 / 地铁关键词：在 商圈 + 地址 + 城市 里找子串 */
  function landmarkHit(job, kw) {
    var k = low(kw);
    if (!k) return true;
    var hay = low([extractBizArea(job), job && job.address, job && job.location].join(' '));
    return hay.indexOf(k) >= 0;
  }

  /**
   * 地理总判定。g = { cities[], districts[], bizAreas[], landmark, strict }
   * strict=false（默认）：没采到区/商圈的岗位**保留**（不因为"没写"就丢）
   * strict=true：只留明确命中的 —— 适合"我就只要滨江区，没写区的不要"
   */
  function geoHit(job, g) {
    if (!g) return true;
    if (!cityHit(job, g.cities)) return false;

    var strict = !!g.strict;
    var dh = anyHit(extractDistrict(job), g.districts);
    if (dh === false) return false;
    if (dh === null && strict) return false;

    var bh = anyHit(extractBizArea(job), g.bizAreas);
    if (bh === false) return false;
    if (bh === null && strict) return false;

    return landmarkHit(job, g.landmark);
  }

  /**
   * 这条岗位是不是「因为地理信息没采到，才被放行」的。
   * 前端拿它标一个「📍 区未知」并计数 —— 让用户知道这条不是"匹配上了"，
   * 而是"没数据、先留着"。不标的话，用户会以为筛选没生效。
   */
  function unknownArea(job, g) {
    if (!g) return false;
    g = g || {};
    var needD = (g.districts || []).length > 0;
    var needB = (g.bizAreas || []).length > 0;
    var lm = trim(g.landmark);
    if (!needD && !needB && !lm) return false;
    if (needD && !extractDistrict(job)) return true;
    if (needB && !extractBizArea(job)) return true;
    return false;
  }

  /** 地理条件写成给人看的一行（偏好面板摘要 / 筛选条件条共用） */
  function describeGeo(g) {
    if (!g) return '';
    var parts = [];
    if ((g.cities || []).length) parts.push(g.cities.join('/'));
    if ((g.districts || []).length) parts.push(g.districts.join('/'));
    if ((g.bizAreas || []).length) parts.push(g.bizAreas.join('/'));
    if (trim(g.landmark)) parts.push('“' + trim(g.landmark) + '”');
    return parts.join(' > ');
  }

  /**
   * 城市候选 = 常用内置 ∪ 库里真出现过的（排前面）∪ 手输兜底。
   * ⛔ **采集页和岗位库偏好面板共用这一个** —— 原来两处各拼一份
   *    （采集页是纯文本框、偏好面板是 chips），"选项不一致"就是这么来的；
   *    候选清单一飘，用户就再也分不清两边到底是不是同一件事。
   */
  function cityChoices(jobs) {
    return uniq(['杭州']
      .concat(citiesOf(jobs))
      .concat(CITIES.slice(0, 12)));
  }

  global.GEO = {
    CITIES: CITIES,
    DISTRICTS: DISTRICTS,
    PROVINCES: PROVINCES,
    extractDistrict: extractDistrict,
    extractBizArea: extractBizArea,
    citiesOf: citiesOf,
    cityOf: cityOf,
    cityChoices: cityChoices,
    citiesIn: citiesIn,
    provinceOfCity: provinceOfCity,
    citiesOfProvince: citiesOfProvince,
    provinceChoices: provinceChoices,
    districtsOf: districtsOf,
    bizAreasOf: bizAreasOf,
    cityHit: cityHit,
    anyHit: anyHit,
    landmarkHit: landmarkHit,
    geoHit: geoHit,
    unknownArea: unknownArea,
    describeGeo: describeGeo,
    uniq: uniq,
  };
})(window);
