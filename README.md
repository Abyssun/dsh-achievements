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
# 从 GitHub 安装（应用内的插件市场/插件管理同样接受 github: 来源——它就是在 profile 目录里跑 pnpm add）
pnpm add "github:Abyssun/dsh-achievements"

# 本地开发：软链到本仓库，改代码后仍**需要重启** DSH
dsh plugin --profile <profile> add /path/to/dsh-achievements

# 卸载
dsh plugin --profile <profile> remove dsh-achievements
```

> ⚠️ **版本兼容门**：DSH 0.2.0 起会在安装时校验 `engines.dsh` 与**全部**
> `@deepseek-ai/dsh*` peer，不命中就**拒绝安装**（并回滚 package.json / lockfile / node_modules），
> 提示形如 `Plugin <name>@<ver> is incompatible with dsh <runtime>`。
> 本插件的声明覆盖 0.1.5-rc.2 ~ 0.2.x：
> `@deepseek-ai/dsh: ">=0.1.5-rc.2 <0.3.0"`、
> `@deepseek-ai/dsh-typert-protocol: "^0.1.5-rc.2 || ^0.2.0-rc.1"`。
> **改支持范围时这两处和 `engines.dsh` 必须同步改**。

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
| `smoke:compat` | 把 `engines.dsh` / `@deepseek-ai/dsh*` peer 范围喂给 semver，验证**兼容门**放行 | 需要 `semver` |

`smoke` 的默认检查对象是 `0.1.5-rc.2` 与 `0.2.0-rc.2` 两个运行时版本（本机实测：npm 目录里是前者，
桌面应用真正跑的是后者）。换版本时直接传参或设 `DSH_RUNTIME_VERSION`。

后三个脚本要解析部署侧模块，所以本地开发需要把部署的 `@deepseek-ai/*`、`zod` 与 `semver`
junction 进 `./node_modules`（已 gitignore）：

```powershell
# 在 plugins/dsh-achievements/ 下
$dep = "$env:APPDATA\npm\node_modules\@deepseek-ai\dsh\node_modules"
New-Item -ItemType Junction -Path node_modules\@deepseek-ai -Target "$dep\@deepseek-ai"
New-Item -ItemType Junction -Path node_modules\zod           -Target "$dep\zod"
New-Item -ItemType Junction -Path node_modules\semver        -Target "$dep\semver"
```

或设 `DSH_NODE_MODULES` 指向部署的 `node_modules`。

> ⚠️ **两个坑**（都实测踩过）：
> 1. `%APPDATA%\npm\...\@deepseek-ai\` 那份可能只是 **0.1.5-rc.2**，而桌面应用真正跑的是
>    **0.2.0-rc.2**。对着旧那份跑冒烟会得出错误结论。
> 2. 应用的插件管理器安装/回滚时会重写 `node_modules`，那份 junction 目标**可能被清空**，
>    于是 `smoke:host` / `smoke:typert` 突然报 `ERR_MODULE_NOT_FOUND`。
>
> 可靠做法：从 `app.asar` 里解出真实运行时（仓库根的 `tools/asar-read.mjs`）：
>
> ```powershell
> # 在仓库根
> node tools/asar-read.mjs extract '^dsh/node_modules/@deepseek-ai/' F:\0dsh\dsh-runtime-@deepseek-ai --strip 'dsh/node_modules/'
> node tools/asar-read.mjs extract '^dsh/node_modules/zod/' <同一个输出目录> --strip 'dsh/node_modules/'
> # 然后把 node_modules\{@deepseek-ai,zod,semver} 三个 junction 指向 <输出目录>\{@deepseek-ai,zod,semver}
> ```
>
> 解出来的是 289 个 `@deepseek-ai` 包（0.2.0-rc.2），与 GUI 里跑的版本严格一致。
> 现成的一份在 `F:\0dsh\dsh-0.2.0-rc.2-@deepseek-ai-repair-kit\`。

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

## 发版

推 `v*` 标签即自动发版（`.github/workflows/release.yml`）：

```bash
# 1) 改 package.json 的 version → 提交 → 推 main
git push https://github.com/Abyssun/dsh-achievements.git main

# 2) 打标签并推送 —— 这一步触发 workflow
git tag -a v0.1.3 -m "dsh-achievements v0.1.3"
git push https://github.com/Abyssun/dsh-achievements.git v0.1.3
```

workflow 做三件事：**校验**（`node --check` + 三项离线冒烟：计费口径 / client 顶层作用域卫生 /
兼容门范围）→ **`npm pack`** → **建 GitHub Release**（正文给出 `github:` spec 与 Release
产物两种安装方式）。

| 想做的事 | 怎么做 |
|---|---|
| 先试跑、不发 Release | Actions 页手动 **Run workflow**（只校验 + 上传 artifact） |
| 同时发到 npm | 在 npmjs.com 给这个包配好 **Trusted Publisher**（repo + workflow 路径），再把仓库**变量** `PUBLISH_NPM` 设为 `true`；`publish-npm` 作业走 OIDC，不需要静态 token |
| 本地验证发版产物 | `npm pack --silent` → 产物名是 `dsh-achievements-<version>.tgz`（semver，**不带 v**）；`tar -tzf` 看内容 |

> ⚠️ workflow 里有**三个别"顺手优化"掉**的点，理由都写在文件注释里：
> ① 不能开 `cache: npm`（仓库没有 lockfile，setup-node 会直接失败）；
> ② `pack` 作业不能装依赖（peer 与自动 peer 解析会 ERESOLVE）；
> ③ `publish` 作业不能写 `registry-url`（setup-node 会塞 `${NODE_AUTH_TOKEN}` 占位，
> OIDC 场景下该变量为空会报错）。
>
> 另外产物名要用 `package.json` 的版本算，**不要**用 `${GITHUB_REF_NAME#v}` 拼 ——
> `npm pack` 的产物名不带 v，而 tag 名带 v，拼错就是 Release 里安装链接 404。

## License

MIT
