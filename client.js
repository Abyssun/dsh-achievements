/**
 * dsh-achievements — Client half（web bundle）。
 *
 * 朴素手写 bundle，与 DSH 官方产物同构：无构建步骤、无 `import`/`export`、无 JSX、无 TS。
 * 页面把它当脚本加载，模块加载器交给它一个 `require`，它只被允许索取 React 与客户端 UI 原语。
 *
 * 贡献三件东西：
 *   1. `main`（keyed 槽位）—— 一整页「个人主页」
 *   2. `sidebar.panellist`（list 槽位）—— 左栏图标，**id 必须等于 main 的 key**
 *   3. `settings.plugins.tab` —— 昵称/头像配置页
 *
 * ## 硬约束（都有踩坑记录，别改）
 *
 *   - **整个 bundle 必须包在 IIFE 里**，顶层不能留任何 `const`/`let`/`function`。
 *     DSH 把多个插件的 client.js 放进**同一个脚本作用域**（合并资源
 *     `dsh-app://app/plugins/??a/client.js,b/client.js,…`）。顶层 `const` 会落进同一个
 *     全局词法作用域，两个插件用同一个名字就是
 *     `SyntaxError: Identifier 'X' has already been declared` —— 整个 client combo 全灭，
 *     界面只报 "web boot: 1 entry did not activate: <某插件>: import failed"。
 *     ⚠️ 这条真出过事：本插件最初把 `CLIENT_BUNDLE_ID` 放在顶层，与另一个已装插件
 *     的同名顶层常量撞车，双方一起把应用打挂（`scripts/smoke-client.mjs` 会守住这条）。
 *   - bundle id 必须与 `__ModuleLoader__.load` 的 id 完全一致；它同时是 HMR 的样式归属
 *     id（`data-plugin`）。
 *   - `remote.achievements` 必须**自挂载**（`ctx.remote.$mount`）；官方 `dsh-api-remotes`
 *     只挂官方命名空间。
 *   - 每个 strict codec **必须带 `create()` 工厂**，否则 `$mount` 抛
 *     "has no create() factory" → 命名空间挂不上 → 整页空白。
 *   - `apply()` 整体 try/catch **永不 reject**：client bundle reject 会卡住 web 启动。
 *   - **所有远程调用都要带超时**：v0.1.2 就是因为 host 端在请求路径里做全量历史 IO，
 *     RPC 永不返回，而这里每 30s 又发一次、还不等上一次结束，界面永远停在「刷新中…」。
 */

(() => {
  const ACH_CLIENT_BUNDLE_ID = "dsh-achievements";

  /** `main` 的 key 与 `sidebar.panellist` 的 id —— 两处必须是同一个字符串。 */
  const PANEL_KEY = "dsh-achievements";
  const RAIL_LABEL = "成就";
  const SETTINGS_TAB_LABEL = "成就";
  /** 轮询间隔。 */
  const REFRESH_MS = 30000;
  /** 单次远程调用的超时；超时按错误处理，绝不无限转圈。 */
  const CALL_TIMEOUT_MS = 15000;
  /** 头像裁剪后的边长。 */
  const AVATAR_SIZE = 256;
  /** 允许的源图片上限。 */
  const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
  /**
   * 账号接口要求的 client 元数据里的 version 字段。
   * 官方客户端由构建期内联；第三方插件没有，这里给一个合法 semver 即可（宿主只做转发）。
   */
  const ACCOUNT_CLIENT_VERSION = "0.2.0-rc.2";

  window.__ModuleLoader__.load({
    id: ACH_CLIENT_BUNDLE_ID,
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;
      Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

      const React = require("react");
      const h = React.createElement;

      // ---- CSS（走 DSH 设计令牌，带兜底色；自动跟随明暗主题）----------------
      const CSS = `
.ach-root {
  --ach-fg: var(--dsw-alias-label-primary, #1d1d1f);
  --ach-fg-dim: var(--dsw-alias-label-secondary, #81858c);
  --ach-bg-1: var(--dsw-alias-bg-layer-1, #ffffff);
  --ach-bg-2: var(--dsw-alias-bg-layer-2, #f5f5f7);
  --ach-border: var(--dsw-alias-border-l1, #e5e5ea);
  --ach-accent: var(--dsw-alias-brand-primary, #4d6bfe);
  --ach-ok: var(--dsw-alias-state-success-primary, #22c55e);
  --ach-warn: var(--dsw-alias-state-warning-primary, #f59e0b);
  height: 100%; overflow: auto; color: var(--ach-fg); background: var(--ach-bg-1);
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
.ach-uid { font-size: 13px; color: var(--ach-fg-dim); font-variant-numeric: tabular-nums; word-break: break-all; text-align: center; }
.ach-toolbar { display: flex; gap: 8px; margin-top: 4px; flex-wrap: wrap; justify-content: center; }
.ach-ghost {
  display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; font-size: 12px;
  border-radius: 9999px; border: 1px solid var(--ach-border); background: var(--ach-bg-1);
  color: var(--ach-fg-dim); cursor: pointer;
}
.ach-ghost:hover { color: var(--ach-fg); }
.ach-ghost[disabled] { opacity: .5; cursor: default; }
.ach-cards {
  display: grid; grid-template-columns: repeat(5, 1fr); margin-top: 32px;
  border: 1px solid var(--ach-border); border-radius: 14px; overflow: hidden; background: var(--ach-bg-1);
}
.ach-card { position: relative; padding: 16px 12px; text-align: center; border-right: 1px solid var(--ach-border); }
.ach-card:last-child { border-right: none; }
/* 有精确值的卡片：鼠标悬停时把「8.04亿」换成逐位精确值 */
.ach-card--exactable { cursor: help; }
.ach-card--exactable:hover { background: var(--ach-bg-2); }
.ach-card-value { font-size: 20px; font-weight: 600; line-height: 1.3; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ach-card-value--exact { font-size: 15px; letter-spacing: -0.2px; }
.ach-card-label { margin-top: 4px; font-size: 12px; color: var(--ach-fg-dim); }
.ach-section { margin-top: 40px; }
.ach-section-title { display: flex; align-items: center; justify-content: space-between; font-size: 15px; font-weight: 600; margin-bottom: 12px; }
.ach-placeholder {
  border: 1px solid var(--ach-border); border-radius: 14px; background: var(--ach-bg-2);
  padding: 40px 24px; text-align: center; display: flex; flex-direction: column; align-items: center; gap: 12px;
}
.ach-placeholder svg { color: var(--ach-fg-dim); opacity: .55; }
.ach-placeholder-text { font-size: 13px; color: var(--ach-fg-dim); }
.ach-heat { border: 1px solid var(--ach-border); border-radius: 14px; padding: 14px 16px 10px; background: var(--ach-bg-1); }
.ach-heat svg { display: block; width: 100%; }
.ach-heat-label { font-size: 9px; fill: var(--ach-fg-dim); }
.ach-heat-foot { display: flex; align-items: center; justify-content: space-between; gap: 10px; font-size: 11px; color: var(--ach-fg-dim); padding-top: 6px; flex-wrap: wrap; }
.ach-heat-legend { display: inline-flex; align-items: center; gap: 4px; }
.ach-heat-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; }
.ach-chart-foot { display: flex; justify-content: space-between; gap: 8px; font-size: 11px; color: var(--ach-fg-dim); padding: 6px 2px 8px; font-variant-numeric: tabular-nums; flex-wrap: wrap; }
.ach-notice { margin-top: 24px; padding: 14px 16px; border-radius: 12px; border: 1px solid var(--ach-border); background: var(--ach-bg-2); font-size: 13px; color: var(--ach-fg-dim); line-height: 1.6; }
.ach-notice code { font-size: 12px; }
.ach-muted { font-size: 12px; color: var(--ach-fg-dim); margin-top: 8px; text-align: center; line-height: 1.6; }
.ach-form { display: flex; flex-direction: column; gap: 14px; max-width: 460px; }
.ach-field { display: flex; flex-direction: column; gap: 6px; }
.ach-field label { font-size: 12px; color: var(--ach-fg-dim); }
.ach-field input[type="text"], .ach-field input:not([type]) {
  height: 34px; padding: 0 10px; font-size: 13px; border-radius: 8px;
  border: 1px solid var(--ach-border); background: var(--ach-bg-1); color: var(--ach-fg);
}
.ach-row { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
.ach-primary { height: 34px; padding: 0 18px; border-radius: 8px; border: none; background: var(--ach-accent); color: #fff; font-size: 13px; cursor: pointer; }
.ach-primary[disabled] { opacity: .5; cursor: default; }
.ach-ok { font-size: 12px; color: var(--ach-ok); }
.ach-err { font-size: 12px; color: var(--ach-warn); }
.ach-avatar-edit { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.ach-avatar-preview { width: 72px; height: 72px; border-radius: 50%; object-fit: cover; border: 1px solid var(--ach-border); background: var(--ach-bg-2); }
.ach-cropper { display: flex; flex-direction: column; gap: 10px; border: 1px solid var(--ach-border); border-radius: 12px; padding: 14px; background: var(--ach-bg-2); }
.ach-crop-stage { display: flex; justify-content: center; }
.ach-crop-canvas { width: 256px; height: 256px; border-radius: 12px; background: var(--ach-bg-1); touch-action: none; cursor: grab; border: 1px solid var(--ach-border); }
.ach-crop-canvas:active { cursor: grabbing; }
.ach-crop-hint { font-size: 11px; color: var(--ach-fg-dim); text-align: center; }
.ach-crop-range { width: 256px; margin: 0 auto; }
.ach-model-list { border: 1px solid var(--ach-border); border-radius: 14px; overflow: hidden; background: var(--ach-bg-1); }
.ach-model-row {
  display: flex; align-items: center; gap: 10px; width: 100%; padding: 10px 14px;
  background: transparent; border: none; border-bottom: 1px solid var(--ach-border);
  cursor: pointer; text-align: left; color: inherit; font-size: 13px; font-family: inherit;
}
.ach-model-row:last-child { border-bottom: none; }
.ach-model-row:hover { background: var(--ach-bg-2); }
.ach-model-row[data-active="true"] { background: var(--ach-bg-2); }
.ach-model-row[data-active="true"] .ach-model-name { font-weight: 600; color: var(--ach-accent); }
.ach-model-name { flex: 0 1 auto; min-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 同名模型（不同 provider/通道）时用来区分，否则两行看起来一模一样 */
.ach-model-provider { margin-left: 6px; font-size: 11px; font-weight: 400; color: var(--ach-fg-dim); }
.ach-model-bar { flex: 1 1 auto; min-width: 60px; height: 6px; border-radius: 3px; background: var(--ach-bg-2); overflow: hidden; }
.ach-model-bar > i { display: block; height: 100%; background: var(--ach-accent); border-radius: 3px; }
.ach-model-total { flex: 0 0 auto; min-width: 66px; text-align: right; color: var(--ach-fg-dim); font-variant-numeric: tabular-nums; }
.ach-model-pct { flex: 0 0 auto; width: 40px; text-align: right; color: var(--ach-fg-dim); font-variant-numeric: tabular-nums; }
.ach-diag { font-size: 11px; color: var(--ach-fg-dim); font-variant-numeric: tabular-nums; }
`;

      // ---- Remote 描述符（必须与 typert.host.js 的 invocation 一一对应）-----
      // 浏览器没有 zod，用 passthrough schema；但**每个 strict codec 都要有 create()**。
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
            parameters: [
              {
                name: "model",
                wire: "model",
                source: "json",
                codec: {
                  mode: "strict",
                  typeSymbol: "dsh-achievements#achievements/getMetrics:model",
                  schema: passthrough(),
                  create: createPassthrough,
                },
              },
            ],
            result: {
              mode: "strict",
              typeSymbol: "dsh-achievements#MetricsSnapshot",
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

      // ---- 展示格式化 -------------------------------------------------------
      // ⚠️ 与 lib/metrics.js 的 formatTokens/formatDuration 刻意重复：
      //    浏览器 bundle 不能 import 宿主 ESM（只允许 require React）。
      function formatTokens(n) {
        if (typeof n !== "number" || !isFinite(n)) return "0";
        const abs = Math.abs(n);
        // 保留 2 位小数：亿位只留 1 位的话，一轮对话涨几百万也看不出变化
        // （曾经因此让人以为「没有在统计」）。
        if (abs >= 1e8) return (n / 1e8).toFixed(2) + "亿";
        if (abs >= 1e4) return (n / 1e4).toFixed(2) + "万";
        return String(Math.round(n));
      }
      /** 精确数值（带千分位），放在 title 里，方便核对具体到个位。 */
      function exactTokens(n) {
        if (typeof n !== "number" || !isFinite(n)) return "0";
        return Math.round(n).toLocaleString("en-US");
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

      /** 给一次远程调用套超时；超时/异常都转成 reject，由调用方显示错误而不是无限转圈。 */
      function callWithTimeout(fn, ms, label) {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error(label + " 超时（" + ms + "ms）")), ms);
          Promise.resolve()
            .then(fn)
            .then(
              (v) => {
                clearTimeout(timer);
                resolve(v);
              },
              (e) => {
                clearTimeout(timer);
                reject(e);
              },
            );
        });
      }

      // ---- DSH 账号资料（默认昵称/头像的来源）-------------------------------
      /**
       * 读官方 `remote.account.getProfile()`。
       * 返回 `{ id, name, contact, avatarUrl }` 或 null（未登录/不可用/失败）。
       * 契约（0.2.0-rc.2 实测）：入参必填 `{version, locale, timezoneOffsetSeconds}`，
       * 出参是信封 `{ok, value}`，`value` 为 `null | {status:'ready', value:{id,name,contact,avatarUrl}} | {status:'failed'}`。
       */
      async function readAccountProfile(namespace) {
        if (!namespace || typeof namespace.getProfile !== "function") return null;
        const locale = (typeof navigator !== "undefined" && navigator.language) || "zh-CN";
        const meta = {
          version: ACCOUNT_CLIENT_VERSION,
          locale,
          timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
        };
        const res = await callWithTimeout(() => namespace.getProfile(meta), CALL_TIMEOUT_MS, "account.getProfile");
        if (!res || res.ok !== true) return null;
        const p = res.value;
        if (!p || p.status !== "ready" || !p.value) return null;
        return {
          id: p.value.id ?? null,
          name: p.value.name ?? null,
          contact: p.value.contact ?? null,
          avatarUrl: p.value.avatarUrl ?? null,
        };
      }

      /**
       * 拿账号资料。两条路都试，任何一条拿不到都只是**少一个默认值**，不影响插件其余功能：
       *  ① `ctx.get("remote.account")` —— 官方命名空间若未在本插件声明 inject，cordis 可能抛，吞掉
       *  ② `ctx.inject(["remote.account"], …)` —— 等它可用（3s 兜底）
       * 刻意**不写进 `exports.inject`**：那会变成硬依赖，命名空间不在的部署里整个插件都不激活。
       */
      async function resolveAccount(ctx) {
        try {
          const direct = ctx.get("remote.account");
          if (direct) {
            const prof = await readAccountProfile(direct);
            if (prof) return prof;
          }
        } catch {
          /* 未声明 inject 时 cordis 会抛，按拿不到处理 */
        }
        try {
          return await new Promise((resolve) => {
            let settled = false;
            const finish = (v) => {
              if (settled) return;
              settled = true;
              resolve(v || null);
            };
            try {
              ctx.inject(["remote.account"], (scope) => {
                readAccountProfile(scope.get("remote.account")).then(finish, () => finish(null));
              });
            } catch {
              finish(null);
            }
            setTimeout(() => finish(null), 3000);
          });
        } catch {
          return null;
        }
      }

      /** 合并「用户自己设的」与「DSH 账号的」：用户优先，账号兜底。 */
      function resolveIdentity(own, account) {
        const ownNickname = own && own.nickname ? own.nickname : null;
        const ownAvatar = own && own.avatar ? own.avatar : null;
        const accName = account && account.name ? account.name : null;
        const accAvatar = account && account.avatarUrl ? account.avatarUrl : null;
        return {
          nickname: ownNickname || accName || null,
          avatar: ownAvatar || accAvatar || null,
          /** 账号身份（id 或 contact）—— 有才显示，不把本机匿名 UUID 当 ID 露在个人主页上 */
          accountId: (account && (account.id || account.contact)) || null,
          /** 本机匿名 id（UUID）：只在设置页当「唯一标识」说明用 */
          anonymousId: (own && own.anonymousUserId) || null,
          nicknameFromAccount: !ownNickname && !!accName,
          avatarFromAccount: !ownAvatar && !!accAvatar,
          accountAvailable: !!account,
        };
      }

      // ---- 数据 hook --------------------------------------------------------
      /**
       * @param {object} remote 已挂载的 `remote.achievements`
       * @param {string} model 模型筛选（`provider::model`）；空串 = 全部
       */
      function useMetrics(remote, model) {
        const [state, setState] = React.useState({ loading: true, value: null, error: null, lastAt: 0 });
        /** 上一次成功的累计值，用来算「本次刷新涨了多少」——这是「真的在统计」最直接的证据 */
        const [delta, setDelta] = React.useState({ amount: 0, at: 0 });
        const prevTotalRef = React.useRef(null);
        const aliveRef = React.useRef(true);
        const inFlightRef = React.useRef(false);

        const load = React.useCallback(async () => {
          // 不并发：上一次没回来之前不再发，避免请求堆积（v0.1.2 的坑）
          if (inFlightRef.current) return;
          if (!remote || typeof remote.getMetrics !== "function") {
            if (aliveRef.current) {
              setState((s) => ({ ...s, loading: false, error: "Remote 未就绪（命名空间未挂载）" }));
            }
            return;
          }
          inFlightRef.current = true;
          if (aliveRef.current) setState((s) => ({ ...s, loading: true }));
          try {
            // ⚠️ 返回值是**原始快照**：`{ok, value}` 信封由传输层加，所以取 res.value。
            //    （曾因 host 自己也套了一层信封，变成双层 → 字段全读不到却不报错。）
            const res = await callWithTimeout(() => remote.getMetrics(model || ""), CALL_TIMEOUT_MS, "getMetrics");
            if (!aliveRef.current) return;
            if (res && res.ok === true) {
              const total = res.value && res.value.cards ? Number(res.value.cards.cumulativeTokens) : null;
              const prev = prevTotalRef.current;
              if (Number.isFinite(total)) {
                if (prev !== null) setDelta({ amount: total - prev, at: Date.now() });
                prevTotalRef.current = total;
              }
              setState({ loading: false, value: res.value, error: null, lastAt: Date.now() });
            } else {
              setState((s) => ({ ...s, loading: false, error: (res && res.error && res.error.message) || "读取失败" }));
            }
          } catch (e) {
            if (aliveRef.current) setState((s) => ({ ...s, loading: false, error: String((e && e.message) || e) }));
          } finally {
            inFlightRef.current = false;
          }
        }, [remote, model]);

        React.useEffect(() => {
          aliveRef.current = true;
          load();
          const timer = setInterval(load, REFRESH_MS);
          return () => {
            aliveRef.current = false;
            clearInterval(timer);
          };
        }, [load]);

        return { loading: state.loading, value: state.value, error: state.error, lastAt: state.lastAt, delta, reload: load };
      }

      /** 每秒重渲染一次，用于显示「N 秒前刷新」——让人一眼看出是在实时刷新。 */
      function useTicker() {
        const [, force] = React.useState(0);
        React.useEffect(() => {
          const timer = setInterval(() => force((n) => n + 1), 1000);
          return () => clearInterval(timer);
        }, []);
      }

      // ---- 小组件 -----------------------------------------------------------

      function RailIcon(props) {
        const size = typeof props?.size === "number" ? props.size : 16;
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

      /**
       * 一张统计卡片。
       * @param props.exact 精确值（逐位，带千分位）。给了它就**鼠标悬停时把缩略值换成它** ——
       *   「8.04亿」看不出在动，悬停一下就能看到 803,xxx,xxx 到底是多少。
       */
      function StatCard(props) {
        const [hover, setHover] = React.useState(false);
        const exactable = typeof props.exact === "string" && props.exact !== "";
        const showExact = hover && exactable;
        const cls = "ach-card" + (exactable ? " ach-card--exactable" : "");
        const valueCls = "ach-card-value" + (showExact ? " ach-card-value--exact" : "");
        const tip = exactable
          ? "精确值：" + props.exact + (props.note ? "（" + props.note + "）" : "")
          : props.hint || undefined;
        return h(
          "div",
          {
            className: cls,
            onMouseEnter: exactable ? () => setHover(true) : undefined,
            onMouseLeave: exactable ? () => setHover(false) : undefined,
            title: tip,
          },
          h("div", { className: valueCls }, showExact ? props.exact : props.value),
          h("div", { className: "ach-card-label" }, props.label),
        );
      }

      /** Date → 'YYYY-MM-DD'（本地日历日，与宿主的 dayKeyOf 口径一致）。 */
      function ymd(d) {
        const p = (n) => String(n).padStart(2, "0");
        return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate());
      }

      /** 热力图几何常量（纯计算，便于离线断言）。 */
      const HEAT_CELL = 10;
      const HEAT_GAP = 3;
      /** 0=无消耗，1..4 由浅到深。 */
      const HEAT_OPACITY = [1, 0.22, 0.45, 0.7, 1];

      /** 按当日总量相对最大值分 4 档（GitHub 的做法）。 */
      function heatLevel(total, max) {
        if (!(total > 0) || !(max > 0)) return 0;
        const ratio = total / max;
        if (ratio <= 0.25) return 1;
        if (ratio <= 0.5) return 2;
        if (ratio <= 0.75) return 3;
        return 4;
      }

      /**
       * 把 `{'YYYY-MM-DD': token}` 摊成热力图网格（**纯函数**，便于离线测试）。
       * 列 = 周（周一起始），行 = 星期一…日；最后一列是「本周」；未来的格子不生成。
       * @param {object} byDate
       * @param {{weeks?: number, today?: Date}} [options]
       */
      function heatmapGrid(byDate, options) {
        const opts = options || {};
        const weeks = opts.weeks || 53;
        const today = opts.today instanceof Date ? opts.today : new Date();
        const pitch = HEAT_CELL + HEAT_GAP;
        const padLeft = 16; // 留给星期标签
        const padTop = 13; // 留给月份标签
        const source = byDate || {};
        const todayKey = ymd(today);
        const dow = (today.getDay() + 6) % 7; // 周一 = 0
        const firstCol = new Date(today.getFullYear(), today.getMonth(), today.getDate() - dow - (weeks - 1) * 7);

        const cells = [];
        let max = 0;
        let active = 0;
        for (let w = 0; w < weeks; w += 1) {
          for (let r = 0; r < 7; r += 1) {
            const d = new Date(firstCol.getFullYear(), firstCol.getMonth(), firstCol.getDate() + w * 7 + r);
            const k = ymd(d);
            if (k > todayKey) continue; // 未来不画
            const total = typeof source[k] === "number" ? source[k] : 0;
            if (total > max) max = total;
            if (total > 0) active += 1;
            cells.push({ w, r, k, total });
          }
        }
        // ⚠️ 分档必须等**扫完全部**拿到最终 max 之后再做。
        //    边扫边算的话，早期日期会拿「当时的 max」去分档 —— 实测因此把
        //    25/100 的那天算成最深档（颜色完全不对）。冒烟测试守住了这条。
        for (const c of cells) {
          c.level = heatLevel(c.total, max);
          c.x = padLeft + c.w * pitch;
          c.y = padTop + c.r * pitch;
        }
        return {
          weeks,
          pitch,
          padLeft,
          padTop,
          width: padLeft + weeks * pitch - HEAT_GAP,
          height: padTop + 7 * pitch - HEAT_GAP,
          firstCol,
          todayKey,
          cells,
          max,
          active,
        };
      }

      /**
       * 贡献热力图（GitHub 那种小方格）：列 = 周，行 = 星期一…日。
       * 手写 SVG、零图表库；颜色用 `--ach-accent` 的不同不透明度分级，明暗主题都成立。
       * @param props.byDate `'YYYY-MM-DD' → token 总量`（已按当前模型筛选过）
       * @param props.weeks  显示多少周（默认 53 = 约一年，正好铺满整行）
       */
      function ActivityHeatmap(props) {
        const grid = heatmapGrid(props.byDate, { weeks: props.weeks || 53 });

        const rects = grid.cells.map((c) =>
          h(
            "rect",
            {
              key: c.k,
              x: c.x,
              y: c.y,
              width: HEAT_CELL,
              height: HEAT_CELL,
              rx: 2,
              fill: c.level === 0 ? "var(--ach-bg-2)" : "var(--ach-accent)",
              opacity: c.level === 0 ? 1 : HEAT_OPACITY[c.level],
              stroke: c.level === 0 ? "var(--ach-border)" : "none",
              strokeWidth: c.level === 0 ? 1 : 0,
            },
            h("title", null, c.k + " · " + (c.total > 0 ? formatTokens(c.total) + "（" + exactTokens(c.total) + "）" : "无消耗")),
          ),
        );

        // 月份标签：只在月份变化的那一列打一个
        const monthNodes = [];
        let lastMonth = -1;
        for (let w = 0; w < grid.weeks; w += 1) {
          const d = new Date(grid.firstCol.getFullYear(), grid.firstCol.getMonth(), grid.firstCol.getDate() + w * 7);
          if (d.getMonth() === lastMonth) continue;
          lastMonth = d.getMonth();
          monthNodes.push(
            h(
              "text",
              { key: "m" + w, x: grid.padLeft + w * grid.pitch, y: 9, className: "ach-heat-label" },
              (d.getMonth() === 0 ? d.getFullYear() + "年" : "") + (d.getMonth() + 1) + "月",
            ),
          );
        }
        // 星期标签：和 GitHub 一样只标 一/三/五
        const DOW = ["一", "二", "三", "四", "五", "六", "日"];
        const dayNodes = [0, 2, 4].map((r) =>
          h("text", { key: "d" + r, x: 0, y: grid.padTop + r * grid.pitch + HEAT_CELL - 1, className: "ach-heat-label" }, DOW[r]),
        );

        return h(
          "div",
          { className: "ach-heat" },
          h(
            "svg",
            {
              viewBox: "0 0 " + grid.width + " " + grid.height,
              width: "100%",
              role: "img",
              "aria-label": "最近 " + grid.weeks + " 周每日 Token 用量热力图",
            },
            monthNodes,
            dayNodes,
            rects,
          ),
          h(
            "div",
            { className: "ach-heat-foot" },
            h("span", null, "近 " + grid.weeks + " 周有消耗 " + grid.active + " 天 · 峰值 " + formatTokens(grid.max)),
            h(
              "span",
              { className: "ach-heat-legend" },
              h("span", null, "少"),
              [0, 1, 2, 3, 4].map((lv) =>
                h("i", {
                  key: lv,
                  className: "ach-heat-swatch",
                  style: {
                    background: lv === 0 ? "var(--ach-bg-2)" : "var(--ach-accent)",
                    opacity: String(HEAT_OPACITY[lv]),
                    border: lv === 0 ? "1px solid var(--ach-border)" : "none",
                  },
                }),
              ),
              h("span", null, "多"),
            ),
          ),
        );
      }

      function Avatar(props) {
        const size = props.size || 96;
        const style = { width: size, height: size, fontSize: Math.round(size * 0.38) };
        if (props.src) {
          return h("img", {
            className: props.className || "ach-avatar",
            style: props.className ? undefined : style,
            src: props.src,
            alt: props.alt || "",
            onError: props.onError,
          });
        }
        const initial = (props.name || "?").trim().slice(0, 1) || "?";
        return h("div", { className: props.className || "ach-avatar", style: props.className ? undefined : style }, initial);
      }

      // ---- 头像裁剪（文件上传 → 缩放/拖动 → 256×256 data URL）----------------
      function AvatarCropper(props) {
        const file = props.file;
        const canvasRef = React.useRef(null);
        const imgRef = React.useRef(null);
        const dragRef = React.useRef(null);
        const [zoom, setZoom] = React.useState(1);
        const [offset, setOffset] = React.useState({ x: 0, y: 0 });
        const [ready, setReady] = React.useState(false);
        const [error, setError] = React.useState(null);

        React.useEffect(() => {
          let url = null;
          let cancelled = false;
          const img = new Image();
          img.onload = () => {
            if (cancelled) return;
            imgRef.current = img;
            setReady(true);
          };
          img.onerror = () => {
            if (!cancelled) setError("图片加载失败，换一张试试");
          };
          try {
            url = URL.createObjectURL(file);
            img.src = url;
          } catch (e) {
            setError(String((e && e.message) || e));
          }
          return () => {
            cancelled = true;
            if (url) {
              try {
                URL.revokeObjectURL(url);
              } catch {
                /* ignore */
              }
            }
          };
        }, [file]);

        /** 把原图按当前 zoom/offset 画进一个 size×size 的画布（居中裁成正方形）。 */
        const paint = React.useCallback(
          (target, size) => {
            const img = imgRef.current;
            if (!img || !target) return;
            const c2d = target.getContext("2d");
            const base = Math.max(size / img.width, size / img.height);
            const scale = base * zoom;
            const w = img.width * scale;
            const hgt = img.height * scale;
            const maxX = Math.max(0, (w - size) / 2);
            const maxY = Math.max(0, (hgt - size) / 2);
            const dx = size / 2 - w / 2 + offset.x * maxX;
            const dy = size / 2 - hgt / 2 + offset.y * maxY;
            c2d.clearRect(0, 0, size, size);
            c2d.imageSmoothingQuality = "high";
            c2d.drawImage(img, dx, dy, w, hgt);
          },
          [zoom, offset],
        );

        React.useEffect(() => {
          if (ready) paint(canvasRef.current, AVATAR_SIZE);
        }, [ready, paint]);

        const onPointerDown = (e) => {
          try {
            e.currentTarget.setPointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
          dragRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
        };
        const onPointerMove = (e) => {
          const d = dragRef.current;
          if (!d) return;
          const rect = e.currentTarget.getBoundingClientRect();
          const nx = d.ox + ((e.clientX - d.x) / rect.width) * 2;
          const ny = d.oy + ((e.clientY - d.y) / rect.height) * 2;
          setOffset({ x: Math.max(-1, Math.min(1, nx)), y: Math.max(-1, Math.min(1, ny)) });
        };
        const onPointerUp = (e) => {
          dragRef.current = null;
          try {
            e.currentTarget.releasePointerCapture(e.pointerId);
          } catch {
            /* ignore */
          }
        };

        const onApply = () => {
          const out = document.createElement("canvas");
          out.width = AVATAR_SIZE;
          out.height = AVATAR_SIZE;
          paint(out, AVATAR_SIZE);
          const type = file && file.type === "image/png" ? "image/png" : "image/jpeg";
          try {
            props.onApply(out.toDataURL(type, type === "image/jpeg" ? 0.9 : undefined));
          } catch (e) {
            props.onError(String((e && e.message) || e));
          }
        };

        if (error) {
          return h(
            "div",
            { className: "ach-cropper" },
            h("div", { className: "ach-crop-hint" }, error),
            h("div", { className: "ach-row" }, h("button", { className: "ach-ghost", type: "button", onClick: props.onCancel }, "取消")),
          );
        }

        return h(
          "div",
          { className: "ach-cropper" },
          h(
            "div",
            { className: "ach-crop-stage" },
            h("canvas", {
              ref: canvasRef,
              className: "ach-crop-canvas",
              width: AVATAR_SIZE,
              height: AVATAR_SIZE,
              onPointerDown,
              onPointerMove,
              onPointerUp,
              onPointerCancel: onPointerUp,
            }),
          ),
          h("div", { className: "ach-crop-hint" }, "拖动调整位置，滑块缩放"),
          h("input", {
            className: "ach-crop-range",
            type: "range",
            min: "1",
            max: "3",
            step: "0.01",
            value: String(zoom),
            onChange: (e) => setZoom(Number(e.target.value)),
            "aria-label": "缩放",
          }),
          h(
            "div",
            { className: "ach-row" },
            h("button", { className: "ach-primary", type: "button", disabled: !ready, onClick: onApply }, "用这张"),
            h("button", { className: "ach-ghost", type: "button", onClick: props.onCancel }, "取消"),
          ),
        );
      }

      // ---- 资料编辑器（个人主页内联 + 设置页共用）----------------------------
      function ProfileEditor(props) {
        const remote = props.remote;
        const own = (props.value && props.value.identity) || {};
        const account = props.account || null;
        const effective = resolveIdentity(own, account);

        const [nickname, setNickname] = React.useState(own.nickname || "");
        const [pendingAvatar, setPendingAvatar] = React.useState(null); // data URL / URL 字符串
        const [cropFile, setCropFile] = React.useState(null);
        const [status, setStatus] = React.useState(null);
        const [error, setError] = React.useState(null);
        const [busy, setBusy] = React.useState(false);
        const fileRef = React.useRef(null);

        // 数据回来后回填一次，之后不覆盖用户正在输入的内容
        const seeded = React.useRef(false);
        React.useEffect(() => {
          if (seeded.current) return;
          seeded.current = true;
          setNickname(own.nickname || "");
        }, [own.nickname]);

        const previewSrc = pendingAvatar || own.avatar || account?.avatarUrl || null;

        const onPickFile = (e) => {
          setError(null);
          setStatus(null);
          const f = e.target.files && e.target.files[0];
          if (!f) return;
          if (!/^image\/(png|jpe?g|webp|gif)$/i.test(f.type)) {
            setError("只支持 PNG / JPEG / WebP / GIF 图片");
            return;
          }
          if (f.size > MAX_SOURCE_BYTES) {
            setError("图片太大（>" + Math.round(MAX_SOURCE_BYTES / 1024 / 1024) + "MB），换一张小的");
            return;
          }
          setCropFile(f);
        };

        const onSave = React.useCallback(async () => {
          if (!remote || typeof remote.setProfile !== "function") {
            setError("Remote 未就绪");
            return;
          }
          setBusy(true);
          setError(null);
          setStatus(null);
          try {
            const patch = { nickname: nickname.trim() === "" ? null : nickname.trim() };
            if (pendingAvatar !== null) patch.avatar = pendingAvatar;
            const res = await callWithTimeout(() => remote.setProfile(patch), CALL_TIMEOUT_MS, "setProfile");
            if (res && res.ok === true) {
              setStatus("已保存");
              setPendingAvatar(null);
              props.onSaved?.();
            } else {
              setError((res && res.error && res.error.message) || "保存失败");
            }
          } catch (e) {
            setError(String((e && e.message) || e));
          } finally {
            setBusy(false);
          }
        }, [remote, nickname, pendingAvatar, props]);

        const onClearAvatar = () => {
          setPendingAvatar(null);
          setStatus(null);
          setError(null);
          // 用空串表示「清掉自己设的，回退到账号头像」
          if (remote && typeof remote.setProfile === "function") {
            setBusy(true);
            callWithTimeout(() => remote.setProfile({ avatar: null }), CALL_TIMEOUT_MS, "setProfile")
              .then((res) => {
                if (res && res.ok === true) {
                  setStatus("已恢复为账号头像");
                  props.onSaved?.();
                } else setError((res && res.error && res.error.message) || "清除失败");
              })
              .catch((e) => setError(String((e && e.message) || e)))
              .finally(() => setBusy(false));
          }
        };

        return h(
          "div",
          { className: "ach-form" },
          h(
            "div",
            { className: "ach-field" },
            h("label", { htmlFor: "ach-avatar-file" }, "头像（JPG / PNG / WebP / GIF，可拖动缩放后裁剪成方形）"),
            h(
              "div",
              { className: "ach-avatar-edit" },
              h(Avatar, { src: previewSrc, name: effective.nickname || "?", className: "ach-avatar-preview", size: 72 }),
              h(
                "div",
                { className: "ach-row" },
                h("button", { className: "ach-ghost", type: "button", onClick: () => fileRef.current && fileRef.current.click() }, "选择图片…"),
                own.avatar ? h("button", { className: "ach-ghost", type: "button", disabled: busy, onClick: onClearAvatar }, "清除（用账号头像）") : null,
                h("input", {
                  id: "ach-avatar-file",
                  ref: fileRef,
                  type: "file",
                  accept: "image/png,image/jpeg,image/webp,image/gif",
                  style: { display: "none" },
                  onChange: onPickFile,
                }),
              ),
            ),
            cropFile
              ? h(AvatarCropper, {
                  file: cropFile,
                  onApply: (dataUrl) => {
                    setPendingAvatar(dataUrl);
                    setCropFile(null);
                    setStatus(null);
                  },
                  onCancel: () => setCropFile(null),
                  onError: (m) => {
                    setCropFile(null);
                    setError(m);
                  },
                })
              : null,
            effective.avatarFromAccount
              ? h("div", { className: "ach-crop-hint", style: { textAlign: "left" } }, "当前用的是 DSH 账号头像；上传图片即可覆盖。")
              : null,
          ),

          h(
            "div",
            { className: "ach-field" },
            h("label", { htmlFor: "ach-nickname" }, "昵称"),
            h("input", {
              id: "ach-nickname",
              value: nickname,
              placeholder: account?.name ? "留空则用账号昵称：" + account.name : "显示在个人主页上的名字",
              onChange: (e) => {
                setNickname(e.target.value);
                setStatus(null);
              },
            }),
            effective.nicknameFromAccount
              ? h("div", { className: "ach-crop-hint", style: { textAlign: "left" } }, "当前用的是 DSH 账号昵称；填一个即可覆盖。")
              : null,
          ),

          h(
            "div",
            { className: "ach-row" },
            h("button", { className: "ach-primary", type: "button", disabled: busy || !!cropFile, onClick: onSave }, busy ? "保存中…" : "保存"),
            status ? h("span", { className: "ach-ok" }, status) : null,
            error ? h("span", { className: "ach-err" }, error) : null,
          ),

          h(
            "div",
            { className: "ach-muted", style: { textAlign: "left", marginTop: 4 } },
            effective.accountAvailable
              ? "默认取 DSH 账号的昵称与头像；你也可以自己改，改完以你的为准。"
              : "没有读到 DSH 账号资料（未登录或该部署未挂载账号服务），这里填的就是最终显示值。",
            effective.accountId
              ? h("div", null, "账号 ID：" + effective.accountId)
              : effective.anonymousId
                ? h("div", null, "本机匿名 ID（仅本地，不对外）：" + effective.anonymousId)
                : null,
          ),
        );
      }

      // ---- 整页 -------------------------------------------------------------
      function AchievementsPage(props) {
        const remote = props.remote;
        const account = props.account || null;
        const [model, setModel] = React.useState("");
        const { loading, value, error, lastAt, delta, reload } = useMetrics(remote, model);
        useTicker();
        /** 距上次成功刷新的秒数（每秒跟着 ticker 重算，所以能看出「在动」）。 */
        const agoSec = lastAt ? Math.max(0, Math.round((Date.now() - lastAt) / 1000)) : null;
        const [editing, setEditing] = React.useState(false);
        const onToggleEdit = React.useCallback(() => setEditing((v) => !v), []);
        /** 点当前已选中的模型 = 取消筛选；点「全部模型」恒为取消。 */
        const chooseModel = React.useCallback((key) => {
          setModel((cur) => (key !== "" && cur === key ? "" : key));
        }, []);
        const onSaved = React.useCallback(() => {
          setEditing(false);
          reload();
        }, [reload]);

        const cards = (value && value.cards) || {};
        const details = (value && value.details) || {};
        const totals = (value && value.totals) || {};
        const meta = (value && value.meta) || {};
        const progress = (value && value.progress) || null;
        const identity = resolveIdentity(value && value.identity, account);

        const byDate = React.useMemo(() => {
          const map = {};
          for (const d of (value && value.days) || []) map[d.date] = d.total;
          return map;
        }, [value]);

        const cardNodes = [
          h(StatCard, {
            key: "c1",
            label: "累计 Token 数",
            value: formatTokens(cards.cumulativeTokens),
            exact: exactTokens(cards.cumulativeTokens),
          }),
          h(StatCard, {
            key: "c2",
            label: "Token 使用峰值",
            value: formatTokens(cards.peakDayTokens),
            exact: exactTokens(cards.peakDayTokens),
            note: cards.peakDay ? "峰值日 " + cards.peakDay : undefined,
          }),
          h(StatCard, {
            key: "c3",
            label: "最长任务用时",
            value: formatDuration(cards.longestTaskMs),
            exact: exactTokens(cards.longestTaskMs) + " ms",
            note: "相邻事件间隔 > 30 分钟即切成新的作业段，取最长的一段",
          }),
          h(StatCard, { key: "c4", label: "最长连续天数", value: (cards.longestStreak ?? 0) + " 天", hint: "有 Token 消耗的本地日历日" }),
          h(StatCard, { key: "c5", label: "当前连续天数", value: (cards.currentStreak ?? 0) + " 天", hint: "从今天（今天没有消耗则从昨天）往前连续计算" }),
        ];

        // 模型目录（**不随筛选变化**，否则筛完就没法切回去）与占比
        const modelList = (value && value.models) || [];
        const grandTotal = modelList.reduce((acc, m) => acc + (m.total || 0), 0);
        const denom = grandTotal > 0 ? grandTotal : 1;

        // 模型 key 是 `provider::model`，**不同 provider 可以有同名模型**
        // （实测 deepseek-account::deepseek-flash 与 deepseek-official::deepseek-flash
        //  是两条通道，数据当然不同）。只显示模型名会让两行看起来一模一样 ——
        // 所以同名时补上 provider 后缀。
        const nameCounts = new Map();
        for (const m of modelList) {
          const label = m.name || m.key;
          nameCounts.set(label, (nameCounts.get(label) || 0) + 1);
        }
        const isAmbiguous = (m) => (nameCounts.get(m.name || m.key) || 0) > 1;
        const shortProvider = (m) => String(m.provider || "unknown").replace(/^deepseek-/, "");
        const plainLabel = (m) => m.name || m.key;
        const labelOf = (m) => (isAmbiguous(m) ? plainLabel(m) + " @" + shortProvider(m) : plainLabel(m));

        const activeModel = (value && value.selectedModel) || model || "";
        const activeName = (() => {
          if (!activeModel) return null;
          const hit = modelList.find((m) => m.key === activeModel);
          return hit ? labelOf(hit) : activeModel;
        })();

        // 状态提示：把「还没好」和「坏了」说清楚，而不是无限转圈
        const collecting = value && value.collecting;
        const hostError = (value && value.error) || null;
        // 只有**真的丢数据**（failed > 0）或调用失败才在个人主页上打扰用户；
        // 「N 个会话走了原始日志兜底」这类信息性说明只在设置页展示。
        const realLoss = Number(meta.failed ?? 0) > 0;

        return h(
          "div",
          { className: "ach-root" },
          h(
            "div",
            { className: "ach-wrap" },
            h(
              "div",
              { className: "ach-head" },
              h(Avatar, { src: identity.avatar, name: identity.nickname || "?" }),
              h("div", { className: "ach-name" }, identity.nickname || "未命名用户"),
              // 只有拿到**账号**身份才显示这一行；本机匿名 UUID 不往主页上摆
              identity.accountId
                ? h("div", { className: "ach-uid" }, identity.accountId.length > 40 ? identity.accountId : "@" + identity.accountId)
                : null,
              h(
                "div",
                { className: "ach-toolbar" },
                h("button", { className: "ach-ghost", type: "button", onClick: reload, title: "立即刷新" }, loading ? "刷新中…" : "刷新"),
                h("button", { className: "ach-ghost", type: "button", onClick: onToggleEdit, title: "编辑昵称与头像" }, editing ? "收起编辑" : "编辑资料"),
              ),
            ),

            h("div", { className: "ach-cards" }, cardNodes),

            activeName
              ? h(
                  "div",
                  { className: "ach-notice", style: { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 } },
                  h("span", null, "当前只看模型：" + activeName),
                  h("button", { className: "ach-ghost", type: "button", onClick: () => chooseModel("") }, "查看全部"),
                )
              : null,

            collecting
              ? h(
                  "div",
                  { className: "ach-notice" },
                  "正在后台扫描历史会话…",
                  progress ? " 已完成 " + progress.done + (progress.total ? " / " + progress.total : "") + " 个" : "",
                  progress && progress.failed ? "（" + progress.failed + " 个失败）" : "",
                  "。数字会随扫描逐步变大，完成后自动刷新。",
                )
              : null,

            (error || (hostError && realLoss)) && !collecting
              ? h(
                  "div",
                  { className: "ach-notice" },
                  h("div", null, error ? "读取失败：" + error : "宿主报告：" + hostError),
                  h(
                    "div",
                    { className: "ach-diag" },
                    "diagnostics: registry=" + String(meta.registryAvailable) + " query=" + String(meta.queryAvailable) + " listing=" + String(meta.listing ?? "?") +
                      " cold=" + String(meta.cold ?? "?") + " live=" + String(meta.live ?? "?") +
                      " failed=" + String(meta.failed ?? "?") + " raw=" + String(meta.raw ?? "?") + " timedOut=" + String(meta.timedOut ?? "?") +
                      " snapshotMs=" + String(meta.snapshotMs ?? "?"),
                  ),
                )
              : null,

            editing
              ? h(
                  "div",
                  { className: "ach-section" },
                  h("div", { className: "ach-section-title" }, h("span", null, "编辑资料")),
                  h(ProfileEditor, { remote, value, account, onSaved }),
                )
              : null,

            h(
              "div",
              { className: "ach-section" },
              h(
                "div",
                { className: "ach-section-title" },
                h("span", null, "模型用量"),
                h("span", { style: { fontSize: 12, fontWeight: 400, color: "var(--ach-fg-dim)" } }, "点一行即可只看该模型"),
              ),
              modelList.length === 0
                ? h("div", { className: "ach-placeholder" }, h("div", { className: "ach-placeholder-text" }, "还没有读到模型用量（等后台扫描完成后就会出现）"))
                : h(
                    "div",
                    { className: "ach-model-list" },
                    h(
                      "button",
                      {
                        key: "__all",
                        type: "button",
                        className: "ach-model-row",
                        "data-active": String(activeModel === ""),
                        onClick: () => chooseModel(""),
                      },
                      h("span", { className: "ach-model-name" }, "全部模型"),
                      h("span", { className: "ach-model-bar" }),
                      h("span", { className: "ach-model-total" }, formatTokens(grandTotal)),
                      h("span", { className: "ach-model-pct" }, grandTotal > 0 ? "100%" : "—"),
                    ),
                    modelList.slice(0, 12).map((m) =>
                      h(
                        "button",
                        {
                          key: m.key,
                          type: "button",
                          className: "ach-model-row",
                          "data-active": String(activeModel === m.key),
                          title: m.key + " · " + exactTokens(m.total) + " token",
                          onClick: () => chooseModel(m.key),
                        },
                        h(
                          "span",
                          { className: "ach-model-name" },
                          plainLabel(m),
                          isAmbiguous(m)
                            ? h("span", { className: "ach-model-provider" }, "@" + shortProvider(m))
                            : null,
                        ),
                        h(
                          "span",
                          { className: "ach-model-bar" },
                          h("i", { style: { width: Math.max(2, Math.round(((m.total || 0) / denom) * 100)) + "%" } }),
                        ),
                        h("span", { className: "ach-model-total" }, formatTokens(m.total)),
                        h("span", { className: "ach-model-pct" }, Math.round(((m.total || 0) / denom) * 100) + "%"),
                      ),
                    ),
                  ),
              activeModel
                ? h("div", { className: "ach-crop-hint", style: { textAlign: "left", marginTop: 8 } }, "「最长任务用时」是会话级指标，没有模型维度，筛选时它仍是全局值。")
                : null,
            ),

            h(
              "div",
              { className: "ach-section" },
              h(
                "div",
                { className: "ach-section-title" },
                h("span", null, "Token 活动"),
                h("span", { style: { fontSize: 12, fontWeight: 400, color: "var(--ach-fg-dim)" } }, "最近一年"),
              ),
              h(ActivityHeatmap, { byDate, weeks: 53 }),
              h(
                "div",
                { className: "ach-chart-foot", style: { paddingTop: 10 } },
                h("span", null, "会话 " + (details.sessions ?? 0)),
                h("span", null, "活跃 " + (details.activeDays ?? 0) + " 天"),
                h("span", null, "输入 " + formatTokens(totals.input)),
                h("span", null, "输出 " + formatTokens(totals.output)),
                h("span", null, "缓存读 " + formatTokens(totals.cacheRead)),
                h(
                  "span",
                  null,
                  "峰值时段 " + (details.peakHour === null || details.peakHour === undefined ? "—" : details.peakHour + " 点"),
                ),
                h(
                  "span",
                  null,
                  "常用模型 " + (details.favoriteModel ? String(details.favoriteModel).split("::").pop() : "—"),
                ),
              ),
            ),

            value
              ? h(
                  "div",
                  { className: "ach-muted" },
                  "会话 " + (details.sessions ?? 0) +
                    "（冷 " + String(meta.cold ?? "?") + " / 活 " + String(meta.live ?? "?") + "）" +
                    (agoSec === null ? "" : " · " + agoSec + " 秒前刷新") +
                    (delta && delta.amount > 0 ? " · 本次 +" + formatTokens(delta.amount) : ""),
                  h(
                    "div",
                    null,
                    "累计精确值 " + exactTokens(cards.cumulativeTokens) + " · 每 " + Math.round(REFRESH_MS / 1000) + " 秒自动刷新 · 数据时间 " + new Date(value.generatedAt).toLocaleTimeString(),
                  ),
                )
              : null,
          ),
        );
      }

      // ---- 设置页：复用同一个编辑器 -----------------------------------------
      function SettingsTab(props) {
        const remote = props.remote;
        const account = props.account || null;
        const { value, reload } = useMetrics(remote);
        const meta = (value && value.meta) || {};
        return h(
          "div",
          { className: "ach-root", style: { height: "auto", background: "transparent" } },
          h(
            "div",
            { style: { padding: "4px 0" } },
            h("div", { style: { fontSize: 14, fontWeight: 600, marginBottom: 14 } }, "个人资料"),
            h(ProfileEditor, { remote, value, account, onSaved: reload }),
            // 统计状态放在设置页：个人主页只在不丢数据时不打扰
            h(
              "div",
              { style: { marginTop: 20 } },
              h("div", { style: { fontSize: 12, color: "var(--ach-fg-dim)", marginBottom: 6 } }, "统计状态"),
              value && value.error
                ? h("div", { className: "ach-crop-hint", style: { textAlign: "left" } }, value.error)
                : h("div", { className: "ach-crop-hint", style: { textAlign: "left" } }, "全部会话统计正常。"),
              h(
                "div",
                { className: "ach-diag" },
                "registry=" + String(meta.registryAvailable ?? "?") +
                  " query=" + String(meta.queryAvailable ?? "?") +
                  " cold=" + String(meta.cold ?? "?") +
                  " live=" + String(meta.live ?? "?") +
                  " failed=" + String(meta.failed ?? "?") +
                  " raw=" + String(meta.raw ?? "?") +
                  " timedOut=" + String(meta.timedOut ?? "?") +
                  " snapshotMs=" + String(meta.snapshotMs ?? "?"),
              ),
            ),
          ),
        );
      }

      // ---- 注册 -------------------------------------------------------------
      async function applyInner(ctx) {
        // ① 自挂载 Remote 命名空间（官方只挂官方命名空间）
        let remote = null;
        try {
          await ctx.remote.$mount(CLIENT_REMOTE);
          remote = ctx.get("remote.achievements") || null;
        } catch (e) {
          logWarn("[dsh-achievements] remote.$mount failed; page will show an error state:", e);
        }

        // ② 读 DSH 账号资料（默认昵称/头像）。拿不到也只是少个默认值。
        let account = null;
        try {
          account = await resolveAccount(ctx);
        } catch (e) {
          logWarn("[dsh-achievements] account profile unavailable:", e);
        }

        // ③ 样式：必须立刻打 data-plugin 标记 —— 0.2.0 的 claimStyles 会认领文档里所有
        //    **无 data-plugin 属性**的 <style>，不预打标会被后续包认领、被别人的卸载连带删掉。
        try {
          const style = document.createElement("style");
          style.setAttribute("data-plugin", ACH_CLIENT_BUNDLE_ID);
          style.textContent = CSS;
          document.head.appendChild(style);
          ctx.effect(
            () => () => {
              try {
                style.remove();
              } catch {
                /* ignore */
              }
            },
            "dsh-achievements.style",
          );
        } catch (e) {
          logWarn("[dsh-achievements] style injection failed:", e);
        }

        // ④ 整页（keyed 槽位）。key 与下一条的 id 必须一致。
        try {
          ctx.slots.inject("main", () =>
            ctx.slots.register({ name: "main", key: PANEL_KEY }, (slotProps) =>
              h(AchievementsPage, { ...(slotProps || {}), remote, account }),
            ),
          );
        } catch (e) {
          logWarn("[dsh-achievements] main panel registration failed:", e);
        }

        // ⑤ 侧栏入口（list 槽位，id 必须等于 main 的 key）
        try {
          ctx.slots.inject("sidebar.panellist", () =>
            ctx.slots.register({ name: "sidebar.panellist", id: PANEL_KEY, order: 30, label: () => RAIL_LABEL }, (slotProps) =>
              h(RailIcon, { size: slotProps?.size }),
            ),
          );
        } catch (e) {
          logWarn("[dsh-achievements] sidebar.panellist registration failed:", e);
        }

        // ⑥ 设置里的配置页
        try {
          ctx.slots.inject("settings.plugins.tab", () =>
            ctx.slots.register({ name: "settings.plugins.tab", id: "achievements", order: 40, label: () => SETTINGS_TAB_LABEL }, (slotProps) =>
              h(SettingsTab, { ...(slotProps || {}), remote, account }),
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
      // 仅供离线冒烟断言**纯计算**部分（热力图网格、格式化、身份合并）。
      // DSH 只读 apply / inject，多挂这几个键没有任何影响。
      exports.__test = { ymd, heatmapGrid, heatLevel, formatTokens, exactTokens, resolveIdentity };
      return module.exports;
    },
  });
})();
