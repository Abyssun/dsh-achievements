/**
 * Client 半冒烟：把 `client.js` 当成加载器会加载的**经典脚本**跑一遍。
 *
 * 检查的是那些「语法合法但运行时契约错」的问题 —— `npm run check` 抓不住：
 *   1. bundle 是否通过 `window.__ModuleLoader__.load({id, factory})` 注册，且 id === 包名；
 *      （加载了却没注册 → 宿主抛 "loaded without registering ... via __ModuleLoader__.load"）
 *   2. factory 只靠 `require("react")` 能不能返回 exports
 *   3. `apply(ctx)` 在**正常与恶劣 seam 下都不得 reject**
 *      （client bundle reject 会把整个 web 启动卡住）
 *   4. 三个槽位是否按契约注册：`main` 的 key === `sidebar.panellist` 的 id
 *   5. CLIENT_REMOTE 的**每个 strict codec 都带 create() 工厂**
 *      （缺了 `$mount` 抛 "has no create() factory" → 命名空间挂不上 → 整页空白）
 *
 * 全部离线，不需要 DSH、不读用户数据。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_NAME = "dsh-achievements";
const source = readFileSync(join(pkgRoot, "client.js"), "utf8");

let pass = 0;
let fail = 0;
function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? "" : `  → ${extra}`}`);
  }
}

/** 极简 React 替身：apply 阶段只用到 createElement，钩子不会被调用（不渲染）。 */
const fakeReact = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol("Fragment"),
  useState: (v) => [v, () => {}],
  useEffect: () => {},
  useRef: (v) => ({ current: v }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};

/**
 * 把 bundle 当经典脚本执行，拿到它注册的 {id, factory}。
 * @param {{withDocument?: boolean}} opts
 */
function loadBundle(opts = {}) {
  const captured = [];
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load: (entry) => captured.push(entry),
      },
    },
  };
  if (opts.withDocument !== false) {
    const styles = [];
    sandbox.document = {
      head: { appendChild: (el) => styles.push(el) },
      createElement: () => ({ setAttribute() {}, remove() {}, textContent: "" }),
    };
  }
  sandbox.console = { warn: () => {}, error: () => {}, log: () => {} };
  // vm 沙箱里没有宿主定时器，而 bundle 的 callWithTimeout 依赖它们 —— 不注入的话
  // 会在 promise executor 里 ReferenceError，导致远程调用根本没发生（测试假阳性）
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.setInterval = setInterval;
  sandbox.clearInterval = clearInterval;
  vm.createContext(sandbox);
  new vm.Script(source, { filename: "client.js" }).runInContext(sandbox);
  return { captured, sandbox };
}

/** 造一个记录型 ctx。 */
function makeCtx(opts = {}) {
  const registrations = [];
  const effects = [];
  const accountCalls = [];
  let mounted = null;

  /** 官方账号命名空间替身：记录 getProfile 的入参，回一个 ready 资料。 */
  const accountNamespace = {
    getProfile: async (meta) => {
      accountCalls.push(meta);
      if (opts.accountFails) return { ok: false, error: { code: "x", message: "boom" } };
      if (opts.accountSignedOut) return { ok: true, value: null };
      return { ok: true, value: { status: "ready", value: { id: "1335052546", name: "李雨", contact: null, avatarUrl: "https://example.com/acc.png" } } };
    },
  };

  const ctx = {
    remote: {
      $mount: async (descriptor) => {
        if (opts.mountThrows) throw new Error("$mount boom");
        mounted = descriptor;
      },
    },
    get: (name) => {
      if (opts.noRemote && name.startsWith("remote.")) return undefined;
      if (name === "remote.achievements") {
        return { getMetrics: async () => ({ ok: true, value: null }), setProfile: async () => ({ ok: true, value: {} }) };
      }
      // 默认**不**直接给账号命名空间，逼着走 ctx.inject 那条路（更贴近真实 inject 语义）
      if (name === "remote.account" && opts.accountViaGet) return accountNamespace;
      return undefined;
    },
    slots: {
      inject: (name, fn) => {
        if (opts.injectThrows) throw new Error("inject boom");
        return fn();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return () => {};
      },
    },
    effect: (fn) => {
      if (opts.effectThrows) throw new Error("effect boom");
      effects.push(fn);
      return () => {};
    },
  };
  // 让 ctx.inject 回调拿到一个「有 get() 的 scope」，这样账号那条路能真正跑通
  const innerInject = ctx.inject;
  ctx.inject = (deps, cb) => {
    if (opts.injectThrows) throw new Error("inject boom");
    if (Array.isArray(deps) && deps.includes("remote.account")) {
      if (opts.accountUnavailable) return cb({ get: () => undefined });
      return cb({ get: (n) => (n === "remote.account" ? accountNamespace : undefined) });
    }
    return innerInject(deps, cb);
  };
  return { ctx, registrations, effects, accountCalls, getMounted: () => mounted };
}

console.log("=== 1. bundle 注册契约 ===");
{
  const { captured } = loadBundle();
  ok("通过 __ModuleLoader__.load 注册了一次", captured.length === 1, `captured=${captured.length}`);
  const entry = captured[0] || {};
  ok(`load 的 id === 包名（${PKG_NAME}）`, entry.id === PKG_NAME, String(entry.id));
  ok("factory 是函数", typeof entry.factory === "function");

  const exports = entry.factory((name) => {
    if (name === "react") return fakeReact;
    throw new Error(`bundle 索取了非白名单模块: ${name}`);
  });
  ok("只靠 react 就能拿到 exports", !!exports);
  ok("exports.apply 是函数", typeof exports.apply === "function");
  ok('exports.inject 含 "slots" 与 "remote"', Array.isArray(exports.inject) && exports.inject.includes("slots") && exports.inject.includes("remote"), JSON.stringify(exports.inject));
}

console.log("=== 2. apply() 在正常 seam 下 ===");
{
  const { captured } = loadBundle();
  const exports = captured[0].factory(() => fakeReact);
  const { ctx, registrations, effects, getMounted } = makeCtx();
  let rejected = null;
  await exports.apply(ctx).catch((e) => {
    rejected = e;
  });
  ok("apply() 未 reject", rejected === null, rejected && rejected.message);

  const mounted = getMounted();
  ok("$mount 收到了描述符", !!mounted);
  ok("描述符 package 正确", mounted?.package === PKG_NAME, String(mounted?.package));

  const codecs = [];
  for (const d of mounted?.descriptors || []) {
    for (const p of d.parameters || []) codecs.push({ owner: d.id, codec: p.codec });
    codecs.push({ owner: d.id, codec: d.result });
  }
  ok("描述符 codec 数量 > 0", codecs.length > 0, String(codecs.length));
  const noCreate = codecs.filter((c) => c.codec.mode === "strict" && typeof c.codec.create !== "function");
  ok("每个 strict codec 都带 create() 工厂", noCreate.length === 0, noCreate.map((c) => c.owner).join(", "));
  const badSymbol = codecs.filter((c) => typeof c.codec.typeSymbol !== "string" || c.codec.typeSymbol === "");
  ok("每个 codec 都有非空 typeSymbol", badSymbol.length === 0);
  const ids = (mounted?.descriptors || []).map((d) => d.id);
  ok("描述符 id 以包名为前缀", ids.every((id) => id.startsWith(`${PKG_NAME}#`)), ids.join(", "));

  const main = registrations.find((r) => r.options.name === "main");
  const rail = registrations.find((r) => r.options.name === "sidebar.panellist");
  const tab = registrations.find((r) => r.options.name === "settings.plugins.tab");
  ok("注册了 main 槽位", !!main);
  ok("注册了 sidebar.panellist 槽位", !!rail);
  ok("注册了 settings.plugins.tab 槽位", !!tab);
  ok("main 用了 key（keyed 槽位）", typeof main?.options.key === "string" && main.options.key !== "", JSON.stringify(main?.options));
  ok("panellist 用了 id（list 槽位）", typeof rail?.options.id === "string" && rail.options.id !== "", JSON.stringify(rail?.options));
  ok("★ sidebar.panellist 的 id === main 的 key（否则图标点不到页面）", rail?.options.id === main?.options.key, `id=${rail?.options.id} key=${main?.options.key}`);
  ok("panellist 的 label 是函数", typeof rail?.options.label === "function");
  ok("label() 返回非空字符串", typeof rail?.options.label?.() === "string" && rail.options.label().length > 0);
  ok("三个槽位都传了可渲染组件", [main, rail, tab].every((r) => typeof r?.component === "function"));
  ok("注册了样式清理 effect（data-plugin 预打标）", effects.length > 0, String(effects.length));
}

console.log("=== 3. apply() 在恶劣 seam 下必须仍然不 reject ===");
for (const scenario of [
  { key: "mountThrows", label: "$mount 抛错" },
  { key: "injectThrows", label: "slots.inject 抛错" },
  { key: "effectThrows", label: "ctx.effect 抛错" },
  { key: "withDocument", label: "没有 document（非浏览器环境）" },
]) {
  const opts = scenario.key === "withDocument" ? { withDocument: false } : { [scenario.key]: true };
  const { captured } = loadBundle(opts);
  const exports = captured[0].factory(() => fakeReact);
  const { ctx } = makeCtx(opts);
  let rejected = null;
  await exports.apply(ctx).catch((e) => {
    rejected = e;
  });
  ok(`${scenario.label} → apply() 仍不 reject`, rejected === null, rejected && rejected.message);
}

console.log("=== 4. 顶层作用域卫生（防与别的插件撞名 —— 踩过的坑的回归测试） ===");
{
  // DSH 把多个插件的 client.js 放进**同一个脚本作用域**。顶层 const/let/class 会落进
  // 同一个全局词法作用域，两个插件用同名就是 SyntaxError，整个 client combo 全灭。
  const topLevel = source
    .split("\n")
    .map((line, i) => ({ line, n: i + 1 }))
    .filter((x) => /^(?:const|let|var|function|class)\s/.test(x.line));
  ok(
    "client.js 顶层没有任何 const/let/var/function/class 声明",
    topLevel.length === 0,
    topLevel.map((x) => `L${x.n}: ${x.line.trim().slice(0, 60)}`).join(" | "),
  );
  ok("整个 bundle 包在 IIFE 里（首）", /\(\(\)\s*=>\s*\{/.test(source));
  ok("整个 bundle 包在 IIFE 里（尾）", /\}\)\(\);\s*$/.test(source.trim()));
  ok("顶层不再出现裸标识符 CLIENT_BUNDLE_ID", !/^const CLIENT_BUNDLE_ID/m.test(source));
}

console.log("=== 5. DSH 账号默认值（昵称/头像）的读取契约 ===");
{
  const { captured } = loadBundle();
  const exports = captured[0].factory(() => fakeReact);
  const { ctx, accountCalls } = makeCtx({ accountViaGet: true });
  let rejected = null;
  await exports.apply(ctx).catch((e) => {
    rejected = e;
  });
  ok("apply() 未 reject", rejected === null, rejected && rejected.message);
  ok("调用了 remote.account.getProfile", accountCalls.length >= 1, String(accountCalls.length));
  const meta = accountCalls[0] || {};
  ok(
    "★ 传了必填参数 version / locale / timezoneOffsetSeconds",
    typeof meta.version === "string" && meta.version !== "" &&
      typeof meta.locale === "string" && meta.locale !== "" &&
      typeof meta.timezoneOffsetSeconds === "number",
    JSON.stringify(meta),
  );
  ok("时区偏移是秒（本地时区反号）", Math.abs(meta.timezoneOffsetSeconds) <= 86400, String(meta.timezoneOffsetSeconds));
}
{
  // ctx.get 拿不到 → 退到 ctx.inject 那条路（官方命名空间未声明 inject 时的真实情形）
  const { captured } = loadBundle();
  const exports = captured[0].factory(() => fakeReact);
  const { ctx, accountCalls } = makeCtx({});
  let rejected = null;
  await exports.apply(ctx).catch((e) => {
    rejected = e;
  });
  ok("ctx.get 拿不到时仍能经 inject 取到账号资料", rejected === null && accountCalls.length >= 1, `calls=${accountCalls.length}`);
}
for (const [label, opts] of [
  ["账号命名空间不可用", { accountUnavailable: true }],
  ["账号调用失败", { accountFails: true }],
  ["未登录", { accountSignedOut: true }],
]) {
  const { captured } = loadBundle();
  const exports = captured[0].factory(() => fakeReact);
  const { ctx, registrations } = makeCtx(opts);
  let rejected = null;
  await exports.apply(ctx).catch((e) => {
    rejected = e;
  });
  const names = registrations.map((r) => r.options.name).sort().join(",");
  ok(
    `${label} → apply 仍不 reject，三个槽位照常注册`,
    rejected === null && names === "main,settings.plugins.tab,sidebar.panellist",
    `${rejected && rejected.message} / ${names}`,
  );
}

console.log("=== 6. 热力图网格（纯计算，离线可断言） ===");
{
  const { captured } = loadBundle();
  const exports = captured[0].factory(() => fakeReact);
  const t = exports.__test;
  ok("bundle 暴露了 __test（便于离线断言纯计算）", !!t && typeof t.heatmapGrid === "function");

  const today = new Date(2026, 9, 13); // 2026-10-13
  const todayKey = t.ymd(today);
  ok("ymd 输出本地日历日", todayKey === "2026-10-13", todayKey);

  const empty = t.heatmapGrid({}, { weeks: 53, today });
  ok("53 周 = 371 格减去本周未来几天", empty.cells.length > 360 && empty.cells.length <= 371, String(empty.cells.length));
  ok("第一列从周一开始", (empty.firstCol.getDay() + 6) % 7 === 0, String(empty.firstCol.getDay()));
  ok("没有未来日期", empty.cells.every((c) => c.k <= todayKey));
  ok("最后一格是今天", empty.cells[empty.cells.length - 1].k === todayKey, empty.cells[empty.cells.length - 1].k);
  ok("空数据：active / max 都是 0", empty.active === 0 && empty.max === 0);
  ok("空数据：所有格子 level=0", empty.cells.every((c) => c.level === 0));

  const byDate = { "2026-10-13": 100, "2026-10-12": 50, "2026-10-06": 80, "2026-09-30": 25 };
  const grid = t.heatmapGrid(byDate, { weeks: 53, today });
  const cellOf = (k) => grid.cells.find((c) => c.k === k);
  ok("max = 100", grid.max === 100, String(grid.max));
  ok("active = 4", grid.active === 4, String(grid.active));
  ok("最大值那天是最深一档（level 4）", cellOf("2026-10-13")?.level === 4, JSON.stringify(cellOf("2026-10-13")));
  ok("50% 那天 level 2", cellOf("2026-10-12")?.level === 2, String(cellOf("2026-10-12")?.level));
  ok("80% 那天 level 4", cellOf("2026-10-06")?.level === 4, String(cellOf("2026-10-06")?.level));
  ok("25% 那天 level 1", cellOf("2026-09-30")?.level === 1, String(cellOf("2026-09-30")?.level));
  ok(
    "相隔 7 天 → 同一行、相邻列",
    cellOf("2026-10-06")?.r === cellOf("2026-10-13")?.r && cellOf("2026-10-06")?.w === cellOf("2026-10-13")?.w - 1,
    JSON.stringify([cellOf("2026-10-06"), cellOf("2026-10-13")]),
  );
  ok("跨月 → 列递增", cellOf("2026-09-30")?.w < cellOf("2026-10-06")?.w, `${cellOf("2026-09-30")?.w} < ${cellOf("2026-10-06")?.w}`);
  ok(
    "格子 x/y 与 (列, 行) 一致",
    cellOf("2026-10-13")?.x === grid.padLeft + cellOf("2026-10-13")?.w * grid.pitch,
    JSON.stringify(cellOf("2026-10-13")),
  );

  const levels = [0, 25, 26, 50, 51, 75, 76, 100].map((v) => t.heatLevel(v, 100)).join(",");
  ok("heatLevel 档位边界正确", levels === "0,1,2,2,3,3,4,4", levels);
  ok("max=0 不会除零（全部 0 档）", t.heatLevel(5, 0) === 0 && t.heatLevel(0, 0) === 0);

  const narrow = t.heatmapGrid({}, { weeks: 13, today });
  ok("weeks 参数生效（13 周 ≈ 91 格）", narrow.cells.length > 85 && narrow.cells.length <= 91, String(narrow.cells.length));
  ok("周数变了宽度跟着变", narrow.width < empty.width, `${narrow.width} vs ${empty.width}`);
  ok("高度恒为 7 行", narrow.height === empty.height, `${narrow.height} vs ${empty.height}`);
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
