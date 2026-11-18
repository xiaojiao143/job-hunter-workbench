# 贡献指南

感谢你愿意花时间。这个项目不大，规则也简单。

> 参与贡献前，请先阅读 [DISCLAIMER.md](DISCLAIMER.md)。
> 你提交的代码同样以 MIT 许可证发布，且**不附带任何担保**。

## 开发环境

**不需要安装任何东西。**

- 前端：任意现代浏览器 + 一个文本编辑器。直接双击 `求职猎手工作台/index.html` 就能看到改动。
- 测试：需要 Node.js 18+（只用来跑 `node _测试_核心.js`，不参与构建）。
- 后端采集器（可选）：Python 3.9+，只用标准库。

## 提 PR 前请确认

1. **测试全绿**
   ```bash
   cd 求职猎手工作台
   node _测试_核心.js
   ```
   预期 `✅ 全部通过（2470 项）`。

2. **改了 `js/` 或 `css/` 的话，同步打包副本**
   ```bash
   cd _打包工程
   python sync_src.py --check    # 不一致会 exit 1
   python sync_src.py --apply    # 需要同步时执行
   ```
   这一步别跳过——历史上漏同步导致过"打包版缺整个模块、但本地测试全绿"的事故。

3. **新增字段必须进归一白名单**

   `store.js` 的 `normJob` / `normApp` / `normInterview` 等是**重建式**白名单：只返回列出过的键。写了字段但没加进白名单，下次加载就被静默丢弃，表现为"填完刷新就没了"。

   凡是 `updateJob` / `updateApplication` 会写的字段，`norm*` 里必须有对应的一行。

4. **不要引入构建步骤**

   这是硬约束：项目必须保持 `file://` 双击可用。不要加 npm 依赖、不要加打包器、不要加 `package.json` 里的 build 脚本。

## 代码风格

- ES5+ 原生语法，用 `var`（不用 `let/const`，与既有代码一致）
- 模块用 IIFE 包裹，导出挂到 `global.X`
- 页面模块注册到 `window.Views.<id>`，必须提供 `render()`
- 中文注释，重要决策要写**为什么**（不只是写做了什么）
- 样式只用 `css/app.css` 顶部 `:root` 的令牌，不硬编码颜色

## 提交信息

用 Conventional Commits：

```
feat(jobs): 岗位库支持按商圈筛选
fix(store): 跨标签页同步吃掉未落盘编辑
docs(readme): 补技术决策与已知限制
test(core): 补薪资单边区间的断言
```

## 报告 Bug

请附上：
- 复现步骤（越具体越好）
- 浏览器与版本
- 控制台报错（如果有）
- 如果是数据问题，导出一份脱敏的 JSON（**请先删掉真实公司名和简历内容**）

## 安全问题

如果发现安全相关问题（例如本地服务鉴权绕过、XSS），请不要开公开 Issue，走 GitHub Security Advisory 或直接邮件联系。
