/**
 * dsh-achievements — Client half（web bundle）。
 *
 * 这是一个**朴素手写 bundle**，与 DSH 官方产物同构：无构建步骤、无 `import`/`export`
 * 关键字、无 JSX、无 TypeScript。页面把它当脚本加载，下面的模块加载器交给它一个
 * `require`，**它只被允许索取 React 与客户端 UI 原语**。
 *
 * 它贡献三件东西：
 *   1. `main`（keyed 槽位）—— 一整页「个人主页」（图一：头像/昵称/@ID + 5 张卡片）
 *   2. `sidebar.panellist`（list 槽位）—— 左栏图标入口，**id 必须等于 main 的 key**
 *   3. `settings.plugins.tab` —— 昵称/头像的配置页
 *
 * 硬约束（都有事故记录，别改）：
 *   - `CLIENT_BUNDLE_ID` 必须与 `__ModuleLoader__.load` 的 id 完全一致，
 *     它同时是 HMR 的样式归属 id（`data-plugin`）。
 *   - `remote.*` 命名空间必须自挂载：官方 `dsh-api-remotes` 只挂那五个官方命名空间。
 *   - 每个 strict codec **必须带 `create()` 工厂**，否则 `$mount` 抛
 *     "has no create() factory" → 命名空间挂不上 → 整页空白。
 *   - `apply()` 整体 try/catch **永不 reject**：client bundle reject 会卡住 web 启动。
 */

const CLIENT_BUNDLE_ID = "dsh-achievements";

window.__ModuleLoader__.load({
  id: CLIENT_BUNDLE_ID,
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const h = React.createElement;

    /** `main` 的 key 与 `sidebar.panellist` 的 id —— 两处必须是同一个字符串。 */
    const PANEL_KEY = "dsh-achievements";
    const RAIL_LABEL = "成就";
    const SETTINGS_TAB_LABEL = "成就";
    const REFRESH_MS = 30000;

    // ---- CSS（全部走 DSH 设计令牌，带兜底色；自动跟随明暗主题）--------------
    const CSS = `
.ach-root {
  --ach-fg: var(--dsw-alias-label-primary, #1d1d1f);
  --ach-fg-dim: var(--dsw-alias-label-secondary, #81858c);
  --ach-bg-1: var(--dsw-alias-bg-layer-1, #ffffff);
  --ach-bg-2: var(--dsw-alias-bg-layer-2, #f5f5f7);
  --ach-border: var(--dsw-alias-border-l1, #e5e5ea);
  --ach-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --ach-ok: var(--dsw-alias-state-success-primary, #22c55e);
  height: 100%;
  overflow: auto;
  color: var(--ach-fg);
  background: var(--ach-bg-1);
}
.ach-wrap { max-width: 760px; margin: 0 auto; padding: 40px 24px 64px; }
.ach-head { display: flex; flex-direction: column; align-items: center; gap: 12px; }
.ach-avatar {
  width: 96px; height: 96px; border-radius: 50%; object-fit: cover;
  background: var(--ach-bg-2); border: 1px solid var(--ach-border);
  display: flex; align-items: center; justify-content: center;
  font-size: 36px; font-weight: 600; color: var(--ach-fg-dim); overflow: hidden;
}
.ach-name { font-size: 24px; font-weight: 600; line-height: 1.2; }
.ach-uid { font-size: 13px; color: var(--ach-fg-dim); font-variant-numeric: tabular-nums; }
.ach-toolbar { display: flex; gap: 8px; margin-top: 4px; }
.ach-ghost {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 6px 12px; font-size: 12px; border-radius: 9999px;
  border: 1px solid var(--ach-border); background: var(--ach-bg-1);
  color: var(--ach-fg-dim); cursor: pointer;
}
.ach-ghost:hover { color: var(--ach-fg); }
.ach-cards {
  display: grid; grid-template-columns: repeat(5, 1fr);
  margin-top: 32px; border: 1px solid var(--ach-border);
  border-radius: 14px; overflow: hidden; background: var(--ach-bg-1);
}
.ach-card { padding: 16px 12px; text-align: center; border-right: 1px solid var(--ach-border); }
.ach-card:last-child { border-right: none; }
.ach-card-value {
  font-size: 20px; font-weight: 600; line-height: 1.3;
  font-variant-numeric: tabular-nums; white-space: nowrap;
}
.ach-card-label { margin-top: 4px; font-size: 12px; color: var(--ach-fg-dim); }
.ach-section { margin-top: 40px; }
.ach-section-title {
  display: flex; align-items: center; justify-content: space-between;
  font-size: 15px; font-weight: 600; margin-bottom: 12px;
}
.ach-placeholder {
  border: 1px solid var(--ach-border); border-radius: 14px;
  background: var(--ach-bg-2); padding: 40px 24px; text-align: center;
  display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.ach-placeholder svg { color: var(--ach-fg-dim); opacity: .55; }
.ach-placeholder-text { font-size: 13px; color: var(--ach-fg-dim); }
.ach-chart {
  border: 1px solid var(--ach-border); border-radius: 14px;
  padding: 16px 16px 8px; background: var(--ach-bg-1);
}
.ach-chart svg { display: block; width: 100%; }
.ach-chart-foot {
  display: flex; justify-content: space-between;
  font-size: 11px; color: var(--ach-fg-dim); padding: 6px 2px 8px;
  font-variant-numeric: tabular-nums;
}
.ach-error {
  margin-top: 24px; padding: 14px 16px; border-radius: 12px;
  border: 1px solid var(--ach-border); background: var(--ach-bg-2);
  font-size: 13px; color: var(--ach-fg-dim);
}
.ach-muted { font-size: 12px; color: var(--ach-fg-dim); margin-top: 8px; text-align: center; }
.ach-form { display: flex; flex-direction: column; gap: 14px; max-width: 460px; }
.ach-field { display: flex; flex-direction: column; gap: 6px; }
.ach-field label { font-size: 12px; color: var(--ach-fg-dim); }
.ach-field input {
  height: 34px; padding: 0 10px; font-size: 13px; border-radius: 8px;
  border: 1px solid var(--ach-border); background: var(--ach-bg-1); color: var(--ach-fg);
}
.ach-primary {
  align-self: flex-start; height: 34px; padding: 0 18px; border-radius: 8px;
  border: none; background: var(--ach-accent); color: #fff; font-size: 13px; cursor: pointer;
}
.ach-primary[disabled] { opacity: .5; cursor: default; }
.ach-ok { font-size: 12px; color: var(--ach-ok); }
`;

    // ---- Remote 描述符（必须与 typert.host.js 的 invocation 一一对应）-------
    // 浏览器没有 zod，所以用 passthrough schema；但**每个 strict codec 都要有
    // create() 工厂**，否则客户端 remote store 会拒载整个描述符。
    const passthrough = () => ({ parse: (v) => v });
    const createPassthrough = () => passthrough();

    const CLIENT_REMOTE = {
      package: "dsh-achievements",
      descriptors: [
        {
          id: "dsh-achievements#achievements/getMetrics",
          service: "achievements",
          namespace: "achievements",
          method: "getMetrics",
          invocation: { kind: "direct" },
          parameters: [],
          result: {
            mode: "strict",
            typeSymbol: "dsh-achievements#MetricsResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
        {
          id: "dsh-achievements#achievements/setProfile",
          service: "achievements",
          namespace: "achievements",
          method: "setProfile",
          invocation: { kind: "direct" },
          parameters: [
            {
              name: "input",
              wire: "input",
              source: "json",
              codec: {
                mode: "strict",
                typeSymbol: "dsh-achievements#achievements/setProfile:input",
                schema: passthrough(),
                create: createPassthrough,
              },
            },
          ],
          result: {
            mode: "strict",
            typeSymbol: "dsh-achievements#ProfileResult",
            schema: passthrough(),
            create: createPassthrough,
          },
        },
      ],
    };

    // ---- 展示格式化 ---------------------------------------------------------
    // ⚠️ 与 lib/metrics.js 的 formatTokens/formatDuration 是**刻意重复**：
    //    浏览器 bundle 不能 import 宿主的 ESM 模块（只允许 require React）。
    function formatTokens(n) {
      if (typeof n !== "number" || !isFinite(n)) return "0";
      const abs = Math.abs(n);
      if (abs >= 1e8) return (n / 1e8).toFixed(1) + "亿";
      if (abs >= 1e4) return (n / 1e4).toFixed(1) + "万";
      return String(Math.round(n));
    }
    function formatDuration(ms) {
      if (typeof ms !== "number" || !isFinite(ms) || ms <= 0) return "0 分";
      const totalMin = Math.floor(ms / 60000);
      if (totalMin < 1) return "不足 1 分";
      const hours = Math.floor(totalMin / 60);
      const mins = totalMin % 60;
      if (hours > 0) return mins > 0 ? hours + " 小时 " + mins + " 分" : hours + " 小时";
      return mins + " 分";
    }

    function logWarn(message, error) {
      try {
        if (typeof console !== "undefined" && console.warn) console.warn(message, error);
      } catch {
        /* ignore */
      }
    }

    // ---- 数据 hook ----------------------------------------------------------
    function useMetrics(remote) {
      const [state, setState] = React.useState({ loading: true, value: null, error: null });
      const aliveRef = React.useRef(true);

      const load = React.useCallback(async () => {
        if (!remote || typeof remote.getMetrics !== "function") {
          if (aliveRef.current) setState({ loading: false, value: null, error: "Remote 未就绪（命名空间未挂载）" });
          return;
        }
        try {
          const res = await remote.getMetrics();
          if (!aliveRef.current) return;
          if (res && res.ok === true) setState({ loading: false, value: res.value, error: null });
          else {
            const m = res && res.error && res.error.message;
            setState({ loading: false, value: null, error: m || "读取失败" });
          }
        } catch (e) {
          if (aliveRef.current) setState({ loading: false, value: null, error: String((e && e.message) || e) });
        }
      }, [remote]);

      React.useEffect(() => {
        aliveRef.current = true;
        load();
        const timer = setInterval(load, REFRESH_MS);
        return () => {
          aliveRef.current = false;
          clearInterval(timer);
        };
      }, [load]);

      return { loading: state.loading, value: state.value, error: state.error, reload: load };
    }

    // ---- 小组件 -------------------------------------------------------------

    function RailIcon(props) {
      const size = typeof props?.size === "number" ? props.size : 16;
      // 奖杯轮廓（Lucide trophy 的简化路径，只取 alpha 由 color 决定）
      return h(
        "svg",
        { width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": "true" },
        h("path", { key: "a", d: "M6 9H4.5a2.5 2.5 0 0 1 0-5H6" }),
        h("path", { key: "b", d: "M18 9h1.5a2.5 2.5 0 0 0 0-5H18" }),
        h("path", { key: "c", d: "M4 22h16" }),
        h("path", { key: "d", d: "M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22" }),
        h("path", { key: "e", d: "M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22" }),
        h("path", { key: "f", d: "M18 2H6v7a6 6 0 0 0 12 0V2Z" }),
      );
    }

    function StatCard(props) {
      return h(
        "div",
        { className: "ach-card" },
        h("div", { className: "ach-card-value", title: props.title || undefined }, props.value),
        h("div", { className: "ach-card-label" }, props.label),
      );
    }

    /** 最近 `days` 个本地日历日的用量柱状图（手写 SVG，零图表库）。 */
    function ActivityChart(props) {
      const byDate = props.byDate || {};
      const dayCount = props.dayCount || 30;
      const series = [];
      const now = new Date();
      for (let i = dayCount - 1; i >= 0; i -= 1) {
        const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
        const p = (n) => String(n).padStart(2, "0");
        const key = d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
        series.push({ date: key, total: typeof byDate[key] === "number" ? byDate[key] : 0 });
      }
      const max = series.reduce((acc, s) => (s.total > acc ? s.total : acc), 0);
      const width = 600;
      const height = 120;
      const gap = 2;
      const barW = (width - gap * (series.length - 1)) / series.length;

      const children = series.map((s, i) => {
        const ratio = max > 0 ? s.total / max : 0;
        const barH = Math.max(s.total > 0 ? 2 : 0, Math.round(ratio * (height - 8)));
        const x = i * (barW + gap);
        const y = height - barH;
        return h("rect", {
          key: s.date,
          x: Number(x.toFixed(2)),
          y,
          width: Number(barW.toFixed(2)),
          height: barH,
          rx: 1.5,
          fill: "var(--ach-accent)",
          opacity: s.total > 0 ? 0.35 + 0.65 * ratio : 0,
        });
      }).concat([
        h("line", { key: "__base", x1: 0, y1: height, x2: width, y2: height, stroke: "var(--ach-border)", strokeWidth: 1 }),
      ]);

      return h(
        "div",
        { className: "ach-chart" },
        h("svg", { viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": "最近 " + dayCount + " 天 Token 用量" }, children),
        h(
          "div",
          { className: "ach-chart-foot" },
          h("span", null, series[0]?.date || ""),
          h("span", null, "峰值 " + formatTokens(max)),
          h("span", null, series[series.length - 1]?.date || ""),
        ),
      );
    }

    function ProfileHeader(props) {
      const identity = props.identity || {};
      const nickname = identity.nickname || "未命名用户";
      const uid = identity.anonymousUserId ? "@" + identity.anonymousUserId : "@未设置";
      const initial = nickname.trim().slice(0, 1) || "?";

      const avatar = identity.avatarUrl
        ? h("img", { className: "ach-avatar", src: identity.avatarUrl, alt: nickname })
        : h("div", { className: "ach-avatar" }, initial);

      return h(
        "div",
        { className: "ach-head" },
        avatar,
        h("div", { className: "ach-name" }, nickname),
        h("div", { className: "ach-uid" }, uid),
        h(
          "div",
          { className: "ach-toolbar" },
          h("button", { className: "ach-ghost", type: "button", onClick: props.onRefresh, title: "立即刷新" }, props.loading ? "刷新中…" : "刷新"),
          h("button", { className: "ach-ghost", type: "button", onClick: props.onToggleEdit, title: "编辑昵称与头像" }, props.editing ? "收起编辑" : "编辑资料"),
        ),
      );
    }

    function Placeholder() {
      return h(
        "div",
        { className: "ach-placeholder" },
        h(
          "svg",
          { width: 72, height: 48, viewBox: "0 0 72 48", fill: "none", stroke: "currentColor", strokeWidth: 1.5 },
          h("rect", { key: "w", x: 8, y: 4, width: 56, height: 40, rx: 4 }),
          h("path", { key: "l", d: "M14 12h14M14 18h10" }),
          h("circle", { key: "c", cx: 40, cy: 26, r: 8 }),
          h("path", { key: "m", d: "M32 26h16M40 18a14 14 0 0 1 0 16M40 18a14 14 0 0 0 0 16" }),
        ),
        h("div", { className: "ach-placeholder-text" }, "在你的个人资料中展示网站"),
        h("button", { className: "ach-ghost", type: "button", disabled: true, title: "即将支持" }, "创建网站"),
      );
    }

    // ---- 整页（图一）-------------------------------------------------------
    function AchievementsPage(props) {
      const remote = props.remote;
      const { loading, value, error, reload } = useMetrics(remote);
      const [editing, setEditing] = React.useState(false);
      const onToggleEdit = React.useCallback(() => setEditing((v) => !v), []);
      const onSaved = React.useCallback(() => {
        setEditing(false);
        reload();
      }, [reload]);

      const cards = value?.cards || {};
      const byDate = React.useMemo(() => {
        const map = {};
        for (const d of value?.days || []) map[d.date] = d.total;
        return map;
      }, [value]);

      const cardNodes = [
        h(StatCard, { key: "c1", label: "累计 Token 数", value: formatTokens(cards.cumulativeTokens), title: String(cards.cumulativeTokens ?? 0) }),
        h(StatCard, { key: "c2", label: "Token 使用峰值", value: formatTokens(cards.peakDayTokens), title: String(cards.peakDay || "") }),
        h(StatCard, { key: "c3", label: "最长任务用时", value: formatDuration(cards.longestTaskMs), title: "相邻事件间隔超过 30 分钟即切分为新的作业段，取最长的一段" }),
        h(StatCard, { key: "c4", label: "最长连续天数", value: (cards.longestStreak ?? 0) + " 天", title: "有 Token 消耗的本地日历日" }),
        h(StatCard, { key: "c5", label: "当前连续天数", value: (cards.currentStreak ?? 0) + " 天", title: "从今天（今天没有消耗则从昨天）往前连续计算" }),
      ];

      const details = value?.details || {};
      const totals = value?.totals || {};

      return h(
        "div",
        { className: "ach-root" },
        h(
          "div",
          { className: "ach-wrap" },
          h(ProfileHeader, { identity: value?.identity, loading, editing, onRefresh: reload, onToggleEdit }),

          h("div", { className: "ach-cards" }, cardNodes),

          error ? h("div", { className: "ach-error" }, "数据不可用：" + error) : null,
          !error && !loading && !value ? h("div", { className: "ach-error" }, "还没有读到会话数据。") : null,

          editing
            ? h(
                "div",
                { className: "ach-section" },
                h("div", { className: "ach-section-title" }, h("span", null, "编辑资料")),
                h(ProfileEditor, { remote, value, onSaved }),
              )
            : null,

          h(
            "div",
            { className: "ach-section" },
            h("div", { className: "ach-section-title" }, h("span", null, "精选作品")),
            h(Placeholder),
          ),

          h(
            "div",
            { className: "ach-section" },
            h(
              "div",
              { className: "ach-section-title" },
              h("span", null, "Token 活动"),
              h("span", { style: { fontSize: 12, fontWeight: 400, color: "var(--ach-fg-dim)" } }, "最近 30 天"),
            ),
            h(ActivityChart, { byDate, dayCount: 30 }),
            h(
              "div",
              { className: "ach-chart-foot", style: { paddingTop: 10 } },
              h("span", null, "会话 " + (details.sessions ?? 0)),
              h("span", null, "活跃 " + (details.activeDays ?? 0) + " 天"),
              h("span", null, "输入 " + formatTokens(totals.input)),
              h("span", null, "输出 " + formatTokens(totals.output)),
              h("span", null, "缓存读 " + formatTokens(totals.cacheRead)),
            ),
          ),

          value
            ? h(
                "div",
                { className: "ach-muted" },
                "截至 " + new Date(value.generatedAt).toLocaleString() +
                  " · 共 " + (details.sessions ?? 0) + " 个会话" +
                  (value.meta?.failed ? " · " + value.meta.failed + " 个会话读取失败" : ""),
              )
            : null,
          value?.error ? h("div", { className: "ach-muted" }, "宿主告警：" + value.error) : null,
        ),
      );
    }

    // ---- 资料编辑器（个人主页内联 + 设置页共用）-----------------------------
    function ProfileEditor(props) {
      const remote = props.remote;
      const identity = props.value?.identity || {};
      const [nickname, setNickname] = React.useState(identity.nickname || "");
      const [avatarUrl, setAvatarUrl] = React.useState(identity.avatarUrl || "");
      const [status, setStatus] = React.useState(null);
      const [busy, setBusy] = React.useState(false);
      const seeded = React.useRef(false);

      // 首次拿到数据后回填一次；之后不再覆盖用户正在输入的内容
      React.useEffect(() => {
        if (seeded.current || !props.value) return;
        seeded.current = true;
        setNickname(props.value.identity?.nickname || "");
        setAvatarUrl(props.value.identity?.avatarUrl || "");
      }, [props.value]);

      const onSave = React.useCallback(async () => {
        if (!remote || typeof remote.setProfile !== "function") {
          setStatus("Remote 未就绪");
          return;
        }
        setBusy(true);
        setStatus(null);
        try {
          const res = await remote.setProfile({
            nickname: nickname.trim() === "" ? null : nickname.trim(),
            avatarUrl: avatarUrl.trim() === "" ? null : avatarUrl.trim(),
          });
          if (res && res.ok === true) {
            setStatus("已保存");
            props.onSaved?.();
          } else {
            setStatus((res && res.error && res.error.message) || "保存失败");
          }
        } catch (e) {
          setStatus(String((e && e.message) || e));
        } finally {
          setBusy(false);
        }
      }, [remote, nickname, avatarUrl, props]);

      return h(
        "div",
        { className: "ach-form" },
        h(
          "div",
          { className: "ach-field" },
          h("label", { htmlFor: "ach-nickname" }, "昵称"),
          h("input", {
            id: "ach-nickname",
            value: nickname,
            placeholder: "显示在个人主页上的名字",
            onChange: (e) => setNickname(e.target.value),
          }),
        ),
        h(
          "div",
          { className: "ach-field" },
          h("label", { htmlFor: "ach-avatar" }, "头像 URL（留空则用昵称首字占位）"),
          h("input", {
            id: "ach-avatar",
            value: avatarUrl,
            placeholder: "https://…",
            onChange: (e) => setAvatarUrl(e.target.value),
          }),
        ),
        h(
          "div",
          { style: { display: "flex", alignItems: "center", gap: 12 } },
          h("button", { className: "ach-primary", type: "button", disabled: busy, onClick: onSave }, busy ? "保存中…" : "保存"),
          status ? h("span", { className: status === "已保存" ? "ach-ok" : "ach-muted" }, status) : null,
        ),
        h(
          "div",
          { className: "ach-muted", style: { textAlign: "left", marginTop: 4 } },
          "唯一标识（@" + (identity.anonymousUserId || "未设置") + "）来自 DSH 的匿名用户 ID，不可修改。",
        ),
      );
    }

    // ---- 设置页：复用同一个编辑器 -------------------------------------------
    function SettingsTab(props) {
      const remote = props.remote;
      const { value, reload } = useMetrics(remote);

      return h(
        "div",
        { className: "ach-root", style: { height: "auto", background: "transparent" } },
        h(
          "div",
          { style: { padding: "4px 0" } },
          h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 14 } }, "个人资料"),
          h(ProfileEditor, { remote, value, onSaved: reload }),
        ),
      );
    }

    // ---- 注册 --------------------------------------------------------------
    async function applyInner(ctx) {
      // ① 自挂载 Remote 命名空间（官方只挂那五个官方命名空间）
      let remote = null;
      try {
        await ctx.remote.$mount(CLIENT_REMOTE);
        remote = ctx.get("remote.achievements") || null;
      } catch (e) {
        logWarn("[dsh-achievements] remote.$mount failed; page will show an error state:", e);
      }

      // ② 样式：必须立刻打 data-plugin 标记 —— 0.2.0 的 claimStyles 会认领
      //    文档里所有**无 data-plugin 属性**的 <style>，不预打标会被后续包认领、
      //    并在别人卸载时被连带删掉。
      try {
        const style = document.createElement("style");
        style.setAttribute("data-plugin", CLIENT_BUNDLE_ID);
        style.textContent = CSS;
        document.head.appendChild(style);
        ctx.effect(() => () => {
          try {
            style.remove();
          } catch {
            /* ignore */
          }
        }, "dsh-achievements.style");
      } catch (e) {
        logWarn("[dsh-achievements] style injection failed:", e);
      }

      // ③ 整页（keyed 槽位）。key 与下一条的 id 必须一致。
      try {
        ctx.slots.inject("main", () =>
          ctx.slots.register({ name: "main", key: PANEL_KEY }, (slotProps) =>
            h(AchievementsPage, { ...(slotProps || {}), remote }),
          ),
        );
      } catch (e) {
        logWarn("[dsh-achievements] main panel registration failed:", e);
      }

      // ④ 侧栏入口（list 槽位，id 必须等于 main 的 key）
      try {
        ctx.slots.inject("sidebar.panellist", () =>
          ctx.slots.register(
            { name: "sidebar.panellist", id: PANEL_KEY, order: 30, label: () => RAIL_LABEL },
            (slotProps) => h(RailIcon, { size: slotProps?.size }),
          ),
        );
      } catch (e) {
        logWarn("[dsh-achievements] sidebar.panellist registration failed:", e);
      }

      // ⑤ 设置里的配置页
      try {
        ctx.slots.inject("settings.plugins.tab", () =>
          ctx.slots.register(
            { name: "settings.plugins.tab", id: "achievements", order: 40, label: () => SETTINGS_TAB_LABEL },
            (slotProps) => h(SettingsTab, { ...(slotProps || {}), remote }),
          ),
        );
      } catch (e) {
        logWarn("[dsh-achievements] settings.plugins.tab registration failed:", e);
      }
    }

    async function apply(ctx) {
      // 整体兜底：client bundle reject 会让整个 web 启动卡住，所以这里**永不 reject**。
      try {
        await applyInner(ctx);
      } catch (e) {
        try {
          if (typeof console !== "undefined" && console.error) {
            console.error("[dsh-achievements] client apply failed; plugin disabled for this session:", e);
          }
        } catch {
          /* ignore */
        }
      }
    }

    exports.apply = apply;
    exports.inject = ["slots", "remote"];
    return module.exports;
  },
});
