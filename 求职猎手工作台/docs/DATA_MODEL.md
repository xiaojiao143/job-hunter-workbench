# 数据模型

> 所有数据存在浏览器 `localStorage`，一个账号一份。本文是字段契约。

## 存储键

| 键 | 用途 |
|---|---|
| `jobhunter.db.v1.<账号>` | 主数据（9 张表） |
| `jobhunter.db.v1.<账号>.bak` | 上一次保存的完整快照（防半截写入） |
| `jobhunter.current.v1` | 当前账号名 |
| `jobhunter.accounts.v1` | 账号列表 |
| `jh.appVersion` | 上次打开的版本号（用于"代码已更新"提示） |

**多账号 = 同一台机器上的数据沙箱**，靠键名后缀隔离。切换账号只换 key，不混数据。

## 九张表

```
DB = {
  schema, createdAt, updatedAt,
  settings,       // 设置（单对象）
  jobs,           // 岗位
  applications,   // 投递记录
  interviews,     // 面试
  resumes,        // 简历
  materials,      // 简历素材
  chats,          // AI 对话
  checks,         // 公司背调档案
  conflicts,      // 采集冲突台账（惰性初始化，不进 schema 版本）
}
```

### `jobs`（岗位）

关键字段：
- `id` / `source`（`boss` | `manual`）/ `url` / `encryptJobId`
- `title` / `company` / `industry` / `location` / `district` / `bizArea`
- `salaryText` / `salaryMin` / `salaryMax` / `salaryMonths`
- `reqDegree` / `reqYears` / `reqSkills` / `reqSkillsAuthoritative`
- `rawJD` / `duties` / `benefits` / `pros` / `cons` / `keywords` / `tags`
- `aiVerdict`（AI 匹配结论）/ `aiAt` / `aiModel` / `aiGreeting`
- `greetAt`（打招呼冷却时间戳）
- `invalid` / `proxyHire` / `favorite` / `archived`

**去重键**：`jobDedupeKey(job)` —— 优先用 `encryptJobId`，回退到规范化后的 `url`。

### `applications`（投递）

- `status`：`wish` / `todo` / `applied` / `viewed` / `invited` / `interview` / `offer` / `rejected`
- `timeline`：`[{ at, status, note }]` —— **状态变更历史，可追溯**
- `appliedAt` / `outcome`（rejected 时是 `self` | `company`）/ `channel` / `resumeId`
- `note` / `contact` / `salaryAsk` / `onboardEstimate`

> `timeline` 是"待跟进"计算状态持续时间的基础。任何需要判断"停留在某状态多久"的逻辑都该读它，而不是读 `appliedAt`。

### `interviews`（面试）

- `jobId` / `appId`（关联投递）/ `at` / `round` / `mode` / `link` / `place`
- `status`：`scheduled` / `done` / `canceled`
- `result`：`pass` / `fail` / `pending` / `unknown`
- `notes` / `review`（复盘）/ `prep`（AI 备面材料）/ `notified`（已提醒标记）

### `checks`（背调）

- `key` / `company`（归并键：规范化公司名）
- `reg`：工商照面（`status` / `establishedAt` / `capital` / `paidIn`）
- `risk`：6 项风险计数（`zhixing` / `shixin` / `court` / `abnormal` / `penalty` / `labor`）
- **`null` = 没查，`0` = 查过且为 0** —— 这个区别决定了能不能判绿灯

### `conflicts`（采集冲突台账）

同一 URL 二次采集时记录的字段差异：`{ id, jobId, at, fields: [{ key, label, old, new }] }`。

**刻意不进 schema 版本号**：老库里没这个键，靠惰性初始化补上，避免为一个可空的表触发整库迁移。

---

## 归一化契约（最重要的一节）

`store.js` 里所有 `normX()` 都是**重建式**的：

```js
function normApp(a) {
  return {
    id: a.id || U.uid('app'),
    status: STATUS_MAP[a.status] ? a.status : 'todo',
    note: String(a.note || ''),
    // ⚠️ 只返回列出的键，其余全部丢弃
  };
}
```

**这意味着：写了字段但没加进白名单 → 下次加载静默丢失。**

判断口径很简单：

> **凡是 `updateJob` / `updateApplication` / `updateInterview` 会写的字段，对应 `norm*` 里必须有一行。**

这条规则踩过至少 6 次坑，每处都在源码里留了注释（搜 `⛔` 能看到）。测试里也有专门的一致性断言兜底。

---

## 迁移 `migrate()`

加载数据的唯一入口。职责：
1. 补缺失的表和字段
2. 丢弃未知字段
3. 修复历史格式差异
4. 重置 `schema` 版本

**新增字段的正确做法**：在 `norm*` 里加一行，并在 `migrate` 里确认老数据能补上默认值。**不需要**升级 schema 版本——重建式白名单本身就兼容。

---

## 导入导出

`exportObject()` 导出 9 张表 + 设置，**默认脱敏 AI 与背调的 API Key**（`_keyRedacted` 记录抹了哪些）。

导入两种模式：
- **`merge`**（默认）：按去重键合并，冲突时保留本地
- **`replace`**：整库替换，**包括 `conflicts`**（否则旧 jobId 会悬空）

> 备份文件是纯 JSON，可以存到任何地方。**这是跨设备/跨浏览器迁移的唯一正路**。
