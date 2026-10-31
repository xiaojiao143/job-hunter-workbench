# 采集功能板块 · 去重复 / 去无用功能重构方案

> 架构师：高见远（Bob）｜ 范围：`js/view-collect.js`、`js/collect-prefs.js`、`采集器/server.py`
> 性质：**已上线运行的增量重构**。只做「合并重复 + 删冗余 + 加标注」，不引入新架构层。
> 所有行号以当前工作区为准，落地前建议用 `git diff` 复核。

---

## 0. 总原则（重构时必须守住）

1. **最小变更**：能删一行不删一段；能加注释不改数据流。
2. **测试锚点极敏感**：`Views.collect._xxx` 的导出名不能删/不能改名（`_parseK` / `_salaryRangeHit` / `_cf` / `_paintTaskBar` / `_seedCFFromForm` / `_paramIssues` 全被 `_测试_核心.js` 钉住）。改数据流就要同步改测试，方案里逐条列明。
3. **两套数据隔离**：`S.form`（采集页表单）与 `JobMatch.prefs()`（求职偏好）**永不自动双向同步**。注意：`S.form` 与 `CF`（结果页筛选）都是「采集页内部状态」，二者**不受**这条隔离铁律约束 —— 这正是 A1/A3 能合并数据源的依据。
4. **口径唯一来源**：福利口径权威在 `job-match.js` 的 `WELFARE_OPTIONS`；薪资档位权威在 `view-collect.js` 的 `SALARY_OPTIONS / SALARY_BAND`。

---

## 1. 问题总览与处置策略（先看这张表）

| 编号 | 问题 | 性质 | 处置 | 测试风险 |
|---|---|---|---|---|
| A1 | 自定义薪资区间两套输入 | 真重复 | 收敛为单一数据源 `S.form` | **需同步改测试** |
| A2 | 薪资档位双重筛选 | **伪重复**（同一值两阶段各用一次） | 不改代码，补注释澄清 | 零 |
| A3 | 福利/活跃度/区/商圈两入口 | 真重复（最深） | 阶段一：加标注；阶段二（可选）：与 A1 同法合并 | 阶段二需改测试 |
| A4 | 薪资区间解析函数重复 | 近似重复（行为已一致） | 对齐口径 + 交叉注释（可选 `opt.parseK` 注入） | 零 |
| A5 | 导出对象键重复 | 死代码 | 删一行 | 零 |
| B1 | 参数卡福利/活跃度/区/商圈「不起作用」误导 | 误导 | 已有徽章，补一句采集范围说明 | 零 |
| B2 | 参数体检 geo 分支只报警不修正 | 缺功能 | 补 `fix` + `paintDiag` 按钮分支 | 零 |
| B3 | `S.ping.base = S.base` 冗余 | 死代码 | 删一行 | 零 |

**一句话结论**：A5、B3、B2、B1、A4（注释对齐）可**安全先做，零测试风险**；A2 是审计误判为「重复」，实质是「采集期服务端筛 + 展示期本地筛」两件事，**不能删本地筛**，只需澄清；A1 是唯一值得**真合并**的项，需带着测试一起改，放最后谨慎做。

---

## 2. A 组：重复的功能

### A1 · 自定义薪资区间两套输入（真重复）

**1) 现有不足**
同一个「下限K ~ 上限K」本地精筛，在参数卡（`view-collect.js:2979-2986` 的 `salMinInp/salMaxInp`）和结果卡（`:3730-3737` 的 `cfSalMin/cfSalMax`）各存一份，靠 `seedCFFromForm()`（`:1797-1798`）搬运。数据存在 `S.form.salaryMin/Max` 和 `CF.salaryMin/Max` **两处**，改一边不同步另一边就飘。

**2) 改进做法（收敛为单一数据源 `S.form`，结果卡是它的第二个视图）**

- `view-collect.js` 结果卡输入 `cfSalMin/cfSalMax`（`:3730-3744`）的读写对象，从 `CF.salaryMin/Max` 改为 **`S.form.salaryMin/Max`**：
  ```js
  // onCfSalInput() 里改为：
  f.salaryMin = parseK(cfSalMin.value);   // f = S.form（该作用域已有引用）
  f.salaryMax = parseK(cfSalMax.value);
  touchForm();                             // 落盘：结果卡改区间 = 改采集条件里的本地精筛项
  paintResultBody(card);
  ```
- `filterResults()`（`:1626-1630`）读区间的两行改为读 `S.form`：
  ```js
  var salLo = (typeof S.form.salaryMin === 'number' && S.form.salaryMin > 0) ? S.form.salaryMin : null;
  var salHi = (typeof S.form.salaryMax === 'number' && S.form.salaryMax > 0) ? S.form.salaryMax : null;
  ```
- 删除三处 `CF` 副本相关代码：
  - `CF` 定义里的 `salaryMin/salaryMax` 两行（`:863-864`）；
  - `seedCFFromForm()` 里搬区间的两行（`:1797-1798`）；
  - `clearCF()` 里清区间的两行（`:1768`）。
- `collectHasFilter()`（`:1751`）里对 `CF.salaryMin/Max` 的判断改为对 `S.form.salaryMin/Max`。

**3) 收益**
- 区间数据从「两处」降为「一处」：少维护 `seedCFFromForm` 的搬运 + 少维护 `CF` 两个字段 + 少一处 `clearCF` 清理，共约 **6~8 行**，且彻底消除「结果卡改完、参数卡没跟」的漂移隐患。
- 结果卡改区间现在会持久化（`touchForm` 落 `FORM_SAVE_FIELDS`），行为更一致（与 `wanted/minFit` 等偏好一致）。

**4) 风险与规避**
- **必须同步改测试**（否则 `_测试_核心.js` 会红），涉及锚点：
  - `:7525-7529`：`cntWith(15,25,...)` 这类用例目前通过 `VC._cf.salaryMin/Max` 喂区间，需改为 `VC._state.form.salaryMin/Max`；
  - `:7539-7556`：直接设 `VC._cf.salaryMin = 15` 断言 `_collectHasFilter()` / `_clearCF()` 的一组回归，需整体改写为操作 `VC._state.form`。
- **行为变化要明示**：区间从此跨 F5 保留（原来结果卡区间是内存态、刷新即丢）。这是正向收敛，但要写进交付说明，避免被当回归。
- 规避：此项**单独一个 commit**，先跑 `_测试_核心.js` 里 7525-7556 这一节，确认同步改完再合入。

> 若想「零测试改动」的过渡版：保留 `CF.salaryMin/Max` 两个字段不变，仅在 `seedCFFromForm` 顶部与两处输入框各加一行注释「⛔ 与 `S.form.salaryMin/Max` 是同一概念的两个视图，改口径必须同步」。**不推荐**长期保留，只作为应急缓冲。

---

### A2 · 薪资档位双重筛选（**伪重复，不要删本地筛**）

**1) 现有不足**
审计认为「参数卡选档位透传 BOSS（`server.py` `build_cmd_crawl` 的 `--salary`，`:1056`），采集后 `seedCFFromForm`（`:1793`）又搬进 `CF.salary`，`filterResults()`（`:1614-1621`）再本地筛一遍」是重复。**但两者作用阶段和作用对象不同，不能合并。**

**2) 改进做法（不改逻辑，只补澄清注释）**
- 在 `filterResults()` 档位查表段（`:1614-1621`）顶部补注释，把两阶段说透：
  ```
  /* 服务端 --salary 决定「这次采多少」（BOSS 结果集已在服务端被切过一次）；
     本地 CF.salary 决定「累积池里显示多少」。结果池是跨轮累积的（含历史轮次），
     历史轮次可能用了别的档位，所以本地必须再筛一遍 —— 这不是重复，是两件事。 */
  ```
- 结果卡薪资下拉（`:3727`）旁加一个 `title` 提示：「采集时 BOSS 已在服务端按档位筛过；此处是对跨轮累积池再筛一遍，口径一致」。
- **不要**动 `:1614-1621` 那行档位查表 —— 它是自证变异的锚点（源码注释已标明）。

**3) 收益**
- 消除「筛了两遍」的认知误导（A2 本质是困惑，不是多余代码）；不动任何行为，`filterResults` 变异锚点安全。

**4) 风险与规避**
- 零测试风险（不改数据流、不改导出名）。唯一风险是「误删本地筛」—— 方案明确禁止删，规避掉。

---

### A3 · 福利 / 活跃度 / 区 / 商圈：参数卡 + 结果卡两个入口（真重复，最深）

**1) 现有不足**
四个「本地精筛」项在参数卡（`f.welfare/f.activeTime/f.district/f.bizArea`）和结果卡（`CF.welfare/CF.active/CF.district/CF.bizArea`）各一套，靠 `seedCFFromForm()`（`:1784-1789`）搬运，本质同一套本地筛（`filterResults` 只认 `CF.*`）。

**2) 改进做法（分两阶段，阶段一零风险，阶段二需测试同步）**

**阶段一（本次做，零风险）：加标注，不改数据流**
- 在 `seedCFFromForm()`（`:1776-1781`）注释里补一句：「这四项是采集页『本地精筛项』在参数卡与结果卡之间的**预填**，不是新增第二套存储；结果卡是同一意图的第二视图」。
- 参数卡已有 `Comp.lvlBadge('local')` 与「采集后本地筛」文案，确认覆盖全部四项（区/商圈/福利/活跃度已覆盖，见 `:3429/:3453/:3483/:3523`），无需改 UI。

**阶段二（可选，较大收益，需测试同步）：与 A1 同法收敛**
- 结果卡四个 chips 的 `onChange` 改读写 `S.form.welfare/activeTime/district/bizArea`；`filterResults`/`cfGeo`/`resultBizAreas` 改读 `S.form`；删除 `CF` 里这四个字段与 `seedCFFromForm` 整体。
- 测试改动面较大：`_测试_核心.js` `:4626-4630`（`CF.district` 直接操作）、`:4632-4640`（`seedCFFromForm` 搬运断言）、`:5600-5601`（`seedCFFromForm[\s\S]*?CF.salary = f.salary` 正则）、以及所有 `_cf.welfare/_cf.district/_cf.active` 断言。

**3) 收益**
- 阶段二可彻底删掉 `seedCFFromForm` 整个搬运函数（约 20 行）与 `CF` 四个字段，是 A 组里体量最大的去重；阶段一先消除认知误导。

**4) 风险与规避**
- 阶段一：零风险。
- 阶段二：锚点密集（`_seedCFFromForm` 是导出名、`CF.district/bizArea` 被地理筛链路多处引用），**建议与 A1 分开两个 commit**，各自跑对应测试节；若工期紧，阶段二可长期搁置，A1 已覆盖「区间」这个最疼的重复。

---

### A4 · 薪资区间解析函数重复（近似重复，行为已一致）

**1) 现有不足**
`view-collect.js:238` 的 `parseK()` 与 `collect-prefs.js:127` 的 `rangeOf()` 内部 `k(v)` 几乎逐字一致。**实测二者在所有输入上行为已完全一致**（`null/undefined/''/' '/'0'/负数/非数字 → null`，数字/数字字符串 → 数字；`Number(' ')===0` 使 `k(' ')` 也落 null）。差异仅在空串判断写法（`parseK` 用 `String(v).trim()===''`，`k` 用 `v===''`），结果相同。

**2) 改进做法（二选一，优先 a）**

- **(a) 对齐口径 + 交叉注释（零风险，推荐）**
  - `collect-prefs.js` 的 `k(v)` 空串判断改为 `String(v).trim() === ''`，与 `parseK` 逐字一致；
  - 两处各加一行：「⚠️ 与对端 `parseK`（view-collect.js）/ `rangeOf.k`（collect-prefs.js）是同一口径，改一边必须同步另一边。权威实现是 `parseK`（有 `_parseK` 测试锚点）」。
- **(b) `opt.parseK` 注入（可选，真去重）**
  - `collect-prefs.js` 的 `rangeOf(o, opt)` 增加 `var k = (opt && opt.parseK) || defaultK;`，`planFromPrefs/planToPrefs` 内部调用 `rangeOf(x, opt)` 时透传 `opt`；
  - `view-collect.js` 调用 `CollectPrefs.planFromPrefs/planToPrefs` 的 `opt` 里补 `parseK: parseK`（现已在传 `bandCovering/salaryBand`，加一个键即可）。

**3) 收益**
- 口径「唯一实现」化，未来改薪资解析只需改 `parseK` 一处（(b) 方案），或至少两处不再因写法差异产生隐性分歧（(a) 方案）。

**4) 风险与规避**
- (a) 零风险：`rangeOf` 行为不变，`CollectPrefs.rangeOf` 导出名不变，测试无感知。
- (b) 低风险：`rangeOf` 保留 `defaultK` 兜底，`CollectPrefs.rangeOf(x)` 被测试裸调时仍走老逻辑。**不要**把 `rangeOf` 硬依赖 `global.Views.collect._parseK`（会破坏 collect-prefs.js「不碰 DOM/不读存储/纯计算」的独立性）。

---

### A5 · 导出对象键重复（死代码）

**1) 现有不足**
`view-collect.js:4424` 和 `:4459` 都导出 `_paintTaskBar: paintTaskBar`，JS 对象重复键后者覆盖前者（值相同，无功能影响），纯死代码。

**2) 改进做法**
删掉 `:4459` 的 `_paintTaskBar: paintTaskBar,`（保留 `:4424` 那一处）。`paintTaskBar` 函数本体不动。

**3) 收益**
少一处「看着像有两个导出」的误导，减 1 行。

**4) 风险与规避**
- 测试 `:5719-5721` 用正则 `/_paintTaskBar:\s*paintTaskBar/` 只断言「存在」，删除一个重复项后正则仍命中 `:4424`，**零风险**。`:5342-5371/:5734-5741` 直接调 `Views.collect._paintTaskBar(...)`，重复键删除后仍指向同一函数，**零风险**。

---

## 3. B 组：没作用 / 误导的功能

### B1 · 参数卡「福利待遇 / 活跃度 / 区 / 商圈」采集时不起作用（误导）

**1) 现有不足**
`startCrawl()`（`:2337-2362`）提交的 json 里没有 `welfare/activeTime/district/bizArea`，它们不进 BOSS 搜索条件（`server.py build_cmd_crawl` 也没拼这四项），采回来才在结果卡本地筛。用户容易误以为「参数里筛了 = 采集时过滤了」。

**2) 改进做法**
- 现状已有 `Comp.lvlBadge('local')` 徽章 + 逐项文案（`:3429/:3453/:3483/:3523`）+ 末尾三色说明（`:3547-3553`）。**补强一处**：在「③ 登录与采集」的「开始采集」按钮区（`actionCard()` 内，或 `refreshEstimate()` 的提示行）加一句静态提示：
  > 本次采集的**采集范围**只由 城市 / 关键词 / 薪资档位 / 学历 / 经验 / 规模 / 融资 / 工作类型 决定；福利 / 活跃度 / 区 / 商圈是**采集后本地筛**，不影响「采多少」。
- 该文案与 `:2361` 已存在的注释「福利/活跃度：BOSS 接口无参数，不传给采集器」呼应，纯 UI 说明。

**3) 收益**
- 消除最高频的用户误判（「我筛了福利怎么还采回来一堆没福利的」）；不碰数据流，零测试面。

**4) 风险与规避**
- 零风险。注意文案与 `server.py` `build_cmd_crawl` docstring（`:1001-1005`）口径一致，别写成「透传 BOSS」。

---

### B2 · 参数体检 geo 分支只报警不给修正（缺功能）

**1) 现有不足**
`paramIssues()`（`:128-152`）的 `code='geo'` 分支 `fix: ''`（`:149`），而 `paintDiag()`（`:3086-3117`）只给 `salary/city/jobs/experience` 四种 `code` 渲染按钮，geo 报警后无「一键修正」。

**2) 改进做法**
- `paramIssues()` geo 分支 `fix: ''` 改为 `fix: 'clear'`（哨兵值，语义 = 清空跨城区的区/商圈）；
- `paintDiag()` 增加分支：
  ```js
  } else if (w.code === 'geo') {
    btns.push({ t: '清空这些区 / 商圈', run: function () {
      f.district = []; f.bizArea = []; S.geoOwned = true;
      touchForm(); paintGeo(); paintDiag();
    } });
  }
  ```

**3) 收益**
- 补齐第 ④ 条体检的「一键修正」，与 salary/city/jobs/experience 四条体验对齐；消除「报了不改不了」的挫败。

**4) 风险与规避**
- 测试 `:4645-4659` 只断言 `i.code === 'geo'` 的出现/不误报，**不碰 `i.fix`**，改 `fix` 值零风险。按钮 `run` 里调 `paintGeo()`（该作用域内已存在）重建 chips，避免残留旧值。

---

### B3 · `S.ping.base = S.base` 冗余（死代码）

**1) 现有不足**
`view-collect.js:4316` 写 `S.ping.base = S.base`；而 `statusCard`（`:2621`）已写 `p.base || S.base` 兜底，其中 `p` 就是 `S.ping`。全局检索 `S.ping.base` 只此一处赋值、无任何读取方，纯冗余。

**2) 改进做法**
删掉 `:4316` 的 `S.ping.base = S.base;`。`statusCard` 的 `p.base || S.base` 在 `p.base` 为 undefined 时自动落到 `S.base`，显示不受影响。

**3) 收益**
减 1 行死代码；避免后续读者以为 `S.ping.base` 是有效字段。

**4) 风险与规避**
- 测试文件对 `ping.base` 零引用，`statusCard` 有 `|| S.base` 兜底，**零风险**。删除后无需改任何测试。

---

## 4. 实施顺序建议

**第一批（安全先做，零测试改动，可一个 PR）**
1. **A5** 删重复导出 `_paintTaskBar`（`:4459`）
2. **B3** 删 `S.ping.base = S.base`（`:4316`）
3. **A4(a)** 对齐 `parseK` 与 `rangeOf.k` + 交叉注释
4. **B2** geo 分支补 `fix: 'clear'` + `paintDiag` 按钮分支
5. **B1** 采集范围说明文案
6. **A2** `filterResults` 档位段补澄清注释 + 结果卡薪资下拉 `title`
→ 跑一遍 `_测试_核心.js` 与 `_回退自证.js`，应全绿、无 diff 到测试文件。

**第二批（谨慎做，需同步改测试，各一个独立 commit）**
7. **A1** 区间收敛到 `S.form` 单数据源（连同 `_测试_核心.js` `:7525-7556` 同步改）
8. **A3 阶段二（可选）** welfare/active/district/bizArea 收敛 + 删 `seedCFFromForm`（连同 `:4626-4640/:5600-5601` 同步改）—— 工期紧可长期搁置。

**第三批（可选，顺手但不强求）**
9. **A4(b)** `opt.parseK` 注入做真正去重（在 A1/A3 稳定后再做，避免一次性动太多）。

---

## 5. 共享知识（工程师落地须知）

- 测试文件是 67 万字符的 `_测试_核心.js` + `_回退自证.js`，**所有导出名 `Views.collect._xxx` 一律不动**；`_cf`、`_seedCFFromForm`、`_parseK`、`_salaryRangeHit`、`_paintTaskBar`、`_paramIssues` 是锚点。
- 源码里「⛔ 这是变异锚点，别改写」的段落（尤其 `filterResults` 档位查表 `:1614-1621`）**只加注释、不改逻辑**。
- 两套数据隔离只约束 `S.form` ↔ `JobMatch.prefs()`；`S.form` ↔ `CF` 是采集页内部，可合并。
- 采集范围（服务端真正筛的）只有：`city/keywords/salary/degree/experience/scale/stage/jobType` + `expectJobs`（仅影响详情额度方向）+ `includeKnown`（去重开关）；`welfare/activeTime/district/bizArea/salaryMin/salaryMax` 全是本地精筛。
- 自定义薪资区间**只作用于本地精筛**，绝不塞进 BOSS（`resolve_filter_values` 遇到非档位值只警告跳过，会静默退化成「不带薪资条件」）。
