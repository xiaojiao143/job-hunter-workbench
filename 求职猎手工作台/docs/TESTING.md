# 测试

> 这个项目最有意思的部分不是功能，是测试。2,470 条断言 + 298 条变异锚点。

## 怎么跑

```bash
cd 求职猎手工作台
node _测试_核心.js
```

输出结尾应该是：

```
────────────────────────────────────
✅ 全部通过（2470 项）
```

**不需要装任何测试框架。** 没有 Jest、没有 Mocha、没有浏览器。

---

## 为什么不开浏览器也能测

核心思路：**在 Node 里搭一个够用的 DOM 桩，把 32 个模块按 `index.html` 的顺序跑起来。**

```js
// 极简选择器：支持 tag / .class / #id / [attr] / :last-child / 后代与 >
function matches(el, sel) { ... }

// 从 index.html 现读脚本顺序（绝不在这里再抄一份，抄一份必然漂移）
const scriptOrder = [...];
scriptOrder.forEach(f => vm.runInThisContext(fs.readFileSync(f, 'utf8')));
```

桩覆盖了：`document.querySelector` / `createElement` / `addEventListener` / `localStorage` / `location.hash` / `setTimeout` 等。

**这样能测到什么**：
- 纯逻辑（数据层、导入导出、统计口径、JSON 容错）
- **把 12 个页面依次真渲染一遍**，看会不会抛异常

第二点价值最大——DOM 渲染错误在浏览器里表现为"整块空白"，光看截图根本不知道是哪行炸的。有这层测试，改完立刻知道有没有炸。

---

## 测试的四个层级

### 1. 纯逻辑断言（大部分）

```js
eq('薪资：8-12K 与期望 9K 有重叠 → 14', 
   JobScorer.salScore(job, cfg).score, 14);
```

数据层、打分、解析、去重、迁移——全部可单测。

### 2. 页面渲染烟测

```js
// 每个页面渲染一遍，抛异常就红
Views.jobs.render(root, {});
ok('岗位库页能渲染', root.children.length > 0);
```

### 3. 契约一致性断言

这类断言防的是"两处各写一遍然后漂移"：

```js
// 凡是 updateJob 要写的字段，normJob 白名单里必须有
const written = 扫描所有 updateJob 调用的字段;
const whitelisted = Object.keys(normJob({}));
written.forEach(k => ok(`${k} 在 normJob 白名单里`, whitelisted.includes(k)));
```

### 4. 源码静态检查

直接在源码里做正则断言，防"重构时改坏关键逻辑"：

```js
ok('静态服务拒绝伺服下划线开头的开发产物',
   /if\s+basename\.startswith\(\('_'\,\s*'\.'\)\):\s*\n\s*return\s+self\._send\(404,/.test(srv));
```

> ⚠️ 这类断言要**查完整语句**而不是查关键字——只查"出现过 `startswith('_')`"会被 `if False and ...` 骗过。

---

## 变异测试：验证测试真的能发现问题

`_回退自证.js`（2,544 行，298 条锚点）。

**问题**：你怎么知道测试是有效的？一个永远通过的测试和没有测试一样。

**做法**：定义 298 条"故意改坏代码"的变异，每条跑一遍，**要求测试必须变红**。如果改坏了代码但测试还是绿的，说明这个变异没被覆盖 → 测试有漏洞。

```js
{
  name: '【31-①】pitfall 去掉否定语境处理（判反会复现）',
  file: 'js/pitfall.js',
  from: "if (negatedInSentence(text, k, w) || negated(...)) continue;",
  to:   "if (false) continue;",
  expect: '「非外包」不再被否定 → 应报外包嫌疑误报',
}
```

跑法：

```bash
node _回退自证.js
```

它会逐条：备份文件 → 应用变异 → 跑测试 → 期望变红 → 还原。最后报告"298 条锚点全部能匹配上（失配 = 静默漏检）"。

**这个机制的价值**：重构时如果改坏了某段被变异覆盖的代码，测试会红；如果没红，说明变异锚点也需要更新。

---

## 断言里写事故档案

每条重要断言旁边注明"这里以前踩过什么坑"。测试同时是历史档案：

```js
/* ⛔ 弹窗内调用 App.refresh() 会销毁弹窗、丢失用户输入。
   这是本轮新增的守卫，别删。 */
ok('弹窗内禁止调 App.refresh()', ...);
```

好处：后人（或三个月后的我）想删这条断言时，会先看到为什么它存在。

---

## CI

`.github/workflows/test.yml` 在每次 push / PR 时跑：

```yaml
- run: node _测试_核心.js
```

另外校验打包副本一致性：

```yaml
- run: cd _打包工程 && python sync_src.py --check
```

---

## 建议的本地开发循环

1. 改代码
2. `node _测试_核心.js` —— 10 秒内知道有没有炸
3. 改了 `js/` 或 `css/` → `python sync_src.py --apply`
4. 改了关键逻辑 → 顺便跑 `node _回退自证.js` 确认变异锚点还能匹配

---

## 已知测试盲区

诚实列出（这些地方测试覆盖弱）：

1. **真实浏览器行为**：`AudioContext` 自动播放策略、`Notification` 权限、`window.open` 返回值——Node 桩测不了
2. **真实网络请求**：AI 调用、采集器 HTTP——测试里都是桩
3. **跨标签页的时序**：`storage` 事件用模拟派发测，真机多标签的竞态覆盖不足
4. **移动端布局**：没有视觉回归测试
5. **`_测试_真机.py`**（真机端到端）不在本仓库，因为它依赖本机安装的采集器
