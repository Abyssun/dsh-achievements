# 更新日志

本项目遵循[语义化版本](https://semver.org/lang/zh-CN/)。

> **发版时必须在这里写一段。** `v*` 标签触发的 `release` 作业会从本文件里
> 抽取**与该标签版本号一致**的段落作为 GitHub Release 正文；
> 抽不到就直接**失败**（宁可发不出去，也不要一个没有更新说明的 Release）。
> 段落格式：`## [<version>] - <date>`，到下一个 `## ` 为止。

## [0.1.4] - 2026-10-12

### 修复

- **修掉致命 bug：`getMetrics` 的返回值被套了两层 `{ok,value}` 信封。**
  DSH 的约定是：manifest 里 `result.schema` 描述**方法的原始返回值**，
  `{ok,value}` 信封由**传输层**加（权威依据：官方 `dsh-api-account-controller`
  的 `getProfile(client) { return this.ctx.deepseekAccount.getProfile(client); }`）。
  我们既在 host 里自己包了一层，又把信封写进了 `result.schema` —— 两边**自洽**，
  strict 校验照样通过，而客户端最终拿到
  `{ok:true, value:{ok:true, value:真正的快照}}`，每个字段都读不到。
  表现：**5 张卡片全 0、`截至 Invalid Date`、诊断全是 `?`、不报任何错**。
  现在 host 直接返回原始值、失败 `throw`，schema 也改回裸值；
  并加了**反证测试**：把信封喂给 schema 必须失败。
- 个人主页头像/昵称/按钮**居中**（补回漏掉的 `.ach-head` 容器）。
- **不再显示本机匿名 UUID**。之前把 `~/.dsh/.anonymous-user-id`（一个 UUID）
  当用户 ID 摆在主页上，容易被误认成账号 ID；现在只有拿到账号 `id`/`contact`
  才显示那一行，匿名 id 挪到设置页并标注「仅本地」。

### 新增

- **模型选择**：新增「模型用量」区块，列出每个模型的用量条与占比，
  点一行即可只看该模型，再点取消。
  这不是把全局数字换个标题：账本升到 **v3**，`models` 从
  `provider::model → 数字` 变成 `{ total, days: { 日期 → 当日完整聚合 } }`，
  筛选后的累计 / 峰值 / 连续天数 / 图表 / 输入输出缓存读全部按该模型分日明细真算。
  选择器目录恒为**全部模型**（否则筛完就切不回去）。
  「最长任务用时」是会话级指标、没有模型维度，筛选时仍是全局值，界面已标注。
- 移除占位区块「精选作品」（源自参考设计、无实际内容），由模型用量取代。

### 说明

- 取代 **0.1.3**。0.1.3 的标签与 Release 已发布且存在上述致命缺陷，请勿使用。

## [0.1.3] - 2026-10-12 ⚠️ 已发布但有致命缺陷，请改用 0.1.4

> 该版本的标签与 Release 已经发布，其中 `dsh-achievements-0.1.3.tgz`
> 打的是带「双层信封」缺陷的代码。**请勿安装**，改用 0.1.4。
> 按「已发布的历史不重写」的原则，此标签保留不动，由 0.1.4 取代。

### 修复

- `getMetrics()` 不再在请求路径里做全量历史 IO（列举 + 逐个 `readSession` + 折叠）。
  之前 95 个会话顺序读取、每次都要解压校验，RPC 几十秒都不返回；而客户端每 30s
  又发一次且不等上一次结束，请求越堆越多，界面永远停在「刷新中…」且数据全 0。
  现在回填在 `[Service.init]` 里后台跑（并发 4、每会话 8s 超时），
  `getMetrics()` 只读内存立即返回，并用 `ready/collecting/progress` 如实上报进度。
- 资料编辑器修好：不再依赖 metrics 数据、保存有 busy/成功/失败状态、
  可单独清除头像回退账号头像。

### 新增

- **默认昵称与头像取 DSH 账号**（`remote.account.getProfile()`，按官方约定传
  `{version, locale, timezoneOffsetSeconds}`）；用户自己设的优先。
  刻意不写进 `exports.inject`（避免变成硬依赖），拿不到就只少个默认值。
- **头像改为文件上传**：PNG / JPEG / WebP / GIF，8MB 上限，
  可拖动平移 + 滑块缩放，导出 256×256。
- 个人主页显示扫描进度与诊断信息，不再让人干等。

## [0.1.2] - 2026-10-11

### 修复

- **client bundle 整体包进 IIFE**，顶层不留任何 `const`/`let`/`function`。
  DSH 会把多个插件的 `client.js` 放进**同一个脚本作用域**，顶层 `const` 撞名就是
  `SyntaxError: Identifier 'X' has already been declared`，整个 client 批次全灭，
  表现为 `web boot: 1 entry did not activate: <插件>: import failed`。
  当时与 `dsh-token-stats` 的 `CLIENT_BUNDLE_ID` 撞名，双方一起把应用打挂。
- 放宽 `@deepseek-ai/dsh-typert-protocol` peer 范围到
  `^0.1.5-rc.2 || ^0.2.0-rc.1`，通过 DSH 0.2.0 起的兼容门校验。

## [0.1.1] - 2026-10-11

### 修复

- 兼容门 peer 范围修正（0.1.0 在 DSH 0.2.0-rc.2 上会被拒绝安装）。

## [0.1.0] - 2026-10-11

### 新增

- 首个可用版本：`main` 整页个人主页（5 张卡片）+ 左栏图标 + 设置页配置。
- Host 侧基于官方 session-projection seam 的投影单元与跨会话 rollup。
- 「最长任务用时」按 30 分钟空档切分（原「末事件 − 首事件」口径会给出 1367 小时这种假值）。
- 继承前缀按官方 `inheritedEventCount` 跳过，累计 Token 不再与父会话重复计。
