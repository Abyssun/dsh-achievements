# dsh-achievements

为 [DeepSeek Harness（DSH）](https://github.com/deepseek-ai/deepseek-harness) Web UI 打造的**个人成就**插件：
左栏一个图标入口 → **一整页「个人主页」**，把历史 Token 用量摊成 5 张卡片，下面跟一条近 30 天的活动柱状图。

> 与 `dsh-token-stats` 那种「设置页里的技术仪表盘」不同：本插件走的是 **`main` keyed 整页槽位**，
> 形态就是截图里那种「个人主页」；两者可以同时安装，槽位 id 不冲突。

## 功能

| 功能 | 说明 |
|---|---|
| 🖼 整页个人主页 | 头像 / 昵称 / `@唯一标识` + 编辑资料（内联表单） |
| 🗂 5 张卡片 | 累计 Token 数 · Token 使用峰值 · 最长任务用时 · 最长连续天数 · 当前连续天数 |
| 📊 近 30 天活动图 | 手写 SVG 柱状图，零图表库 |
| 🧩 侧栏入口 | `sidebar.panellist` 图标，点击切到整页 |
| ⚙️ 设置页 | `settings.plugins.tab` 里同一套资料编辑器 |
| 🌗 主题 | 全部走 DSH 设计令牌（`--dsw-alias-*`），明暗自动跟随 |

## 安装

本插件是**标准 DSH bundle**：`package.json` 声明 `dsh.bundle.patch`，包内自带 `cordis.patch.yml`。

```bash
# 从 GitHub 安装（把 <owner> 换成你的 GitHub 用户名）
# 应用内的插件市场/插件管理同样接受 github: 来源——它就是在 profile 目录里跑 pnpm add
pnpm add "github:<owner>/dsh-achievements"

# 本地开发：软链到本仓库，改代码后仍**需要重启** DSH
dsh plugin --profile <profile> add /path/to/dsh-achievements

# 卸载
dsh plugin --profile <profile> remove dsh-achievements
```

> ⚠️ 用 **桌面应用（Electron）** 时，它的 `desktop` profile 由应用独占管理，
> `dsh plugin` 命令会直接拒绝（`profile "desktop" is managed exclusively by the Electron application`）。
> 这种情况下请用**应用内的插件市场/插件管理**安装（来源填 `github:<owner>/dsh-achievements`）。

**必须重启 DSH**：已安装插件没有热重载（typert loader 的包判定永不失效），
Host 加载、typert 注册、client bundle 注入都发生在启动时。

重启后：左栏出现一个奖杯图标 → 点击 → 中间整页变成个人主页。

## 指标口径（重要）

| 卡片 | 口径 |
|---|---|
| 累计 Token 数 | 全部会话的 `inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`。**计数互斥**（`inputTokens` 只含未缓存输入），`reasoningTokens` 是输出的一部分，**不重复计入** |
| Token 使用峰值 | 按**本地日历日**聚合后取最大的那一天 |
| 最长任务用时 | **空档切分**：相邻事件间隔 > 30 分钟即切成新的作业段，取最长的一段 |
| 最长连续天数 | 历史最长的「有 Token 消耗的本地日历日」连续段 |
| 当前连续天数 | 从今天往前数；今天没有消耗则从昨天起算（今天还没用不算断） |

### 为什么「最长任务用时」不用「末事件 − 首事件」

会话被恢复后会跨天甚至跨周。实测那个口径会给出 **1367 小时（57 天）**，
完全不是「一次任务用时」；换成空档切分后是 **1 小时 57 分**，量级才对。

### 去重：同一笔调用会出现在多份日志里

fork / 子会话的日志开头有一段**从父会话复制来的继承前缀**。实测 4431 条
`assistant/message` 里只有 3920 个唯一 `message.id`。跨会话累加时若不去重，
同一笔模型调用会被父子各算一次（相差约 23%）。

本插件按官方契约处理：`ctx.sessionQuery.readSession()` 返回的
`SessionLogSnapshot` 直接带 `inheritedEventCount`，投影单元用它跳过前缀
（`emptyLedger(inheritedEventCount)`）。运行时不自己解析标记。

## 已知限制

- **联网搜索的 Token 统计不到**：`web/deepseek-search-llm-request` 事件**不带 `usage`**，
  所以那部分消耗无法计入（实测 54 条这样的请求）。
- **数字会漂**：只要有新对话在写日志，聚合结果就会变。页面底部标注了「截至 …」。
- **冷会话首次读取较慢**：历史会话需要读一次日志并折叠，之后按 id 缓存；
  活会话走官方投影（增量、便宜）。
- 头像需要填 URL（支持 `https://…`）；没填时用昵称首字占位。

## 本地开发

```bash
npm run check      # node --check × 5 个文件
npm run smoke      # 全部离线冒烟（128 项断言 + 真 manifest 校验）
npm run e2e        # check + smoke
```

四个冒烟脚本各有分工：

| 脚本 | 验什么 | 需要 DSH？ |
|---|---|---|
| `smoke:metrics` | 计费口径、引用恒等契约、连续天数、格式化 | 不需要 |
| `smoke:host` | **真 zod schema 校验 `getMetrics()` 的产出**、继承前缀、缓存、失败降级、`setProfile` 落盘 | 不需要 |
| `smoke:client` | bundle 注册契约、`apply()` 在坏 seam 下不 reject、槽位 id/key 一致、codec 带 `create` | 不需要 |
| `smoke:typert` | 用**部署侧真 `validateTypertManifest`** 验 manifest | 需要部署的 `@deepseek-ai` |

后两个脚本要解析部署侧模块，所以本地开发需要把部署的 `@deepseek-ai/*` 与 `zod`
junction 进 `./node_modules`（已 gitignore）：

```powershell
# 在 plugins/dsh-achievements/ 下
New-Item -ItemType Junction -Path node_modules\@deepseek-ai `
  -Target "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\@deepseek-ai"
New-Item -ItemType Junction -Path node_modules\zod `
  -Target "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules\zod"
```

或设 `DSH_NODE_MODULES` 指向部署的 `node_modules`。

### 用真实会话离线重放

仓库根目录的 `tools/replay-metrics.mjs` 会把本机 `~/.dsh/sessions` 里的真实日志
按本插件的折叠逻辑重放一遍，打印 5 张卡片的实际数值，并与 `dsh-token-stats`
落盘的 `stats.json` 交叉校验。

## 架构

```
main[keyed, key="dsh-achievements"]     整页个人主页（图一）
sidebar.panellist[id="dsh-achievements"] 左栏图标（id 必须 === main 的 key）
settings.plugins.tab                     资料编辑器
        ▲ ctx.remote.achievements（自挂载 $mount）
┌───────┴──────────────────────────────────────────────┐
│ Host: AchievementsService                            │
│  ① 投影单元 dsh-achievements.ledger（host-only）      │
│     框架负责订阅/水位线/持久检查点；init 拿到继承前缀长度 │
│  ② 跨会话 rollup（官方没有，本项目独有）                │
│     活会话 → registry.stateOf()；冷会话 → readSession() │
│  ③ Typert Remote（strict codec × create 工厂）        │
└──────────────────────────────────────────────────────┘
```

三处名字必须逐字一致：`index.js` 的类名/服务键、`typert.host.js` 的
`model.services[].key`/`exportName`、`client.js` 的 `CLIENT_REMOTE` 描述符 id。
`npm run smoke:typert` + `smoke:client` 会守住这一点。

## License

MIT
