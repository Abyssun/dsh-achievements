/**
 * Host 半冒烟：不需要 DSH 就能验的那些「语法合法但契约错」。
 *
 * 最有价值的一条：把 `getMetrics()` 真实产出的 value 拿 **typert.host.js 里的真
 * zod schema** `parse()` 一遍 —— 这正好复现网关的 strict 校验，能在重启之前就抓到
 * 「返回值与 schema 不对应」（网关会直接拒掉，页面表现为没数据）。
 *
 * 另外覆盖：
 *   - `[Service.init]()` 在坏 seam 下不抛（0.1.7 起插件激活 reject 会拖垮整个 profile）
 *   - `inheritedEventCount` 是否真的被用来跳 fork 继承前缀
 *   - 冷会话缓存：第二次调用不重复读日志
 *   - 服务不可用时 `getMetrics()` 返回业务失败信封而不是抛
 *   - `setProfile()` 落盘 / 读回
 *
 * ⚠️ `index.js` 在 **模块加载期**就读 `process.env.DSH_HOME`，所以必须在 import
 *    之前设好环境变量（这也是它可测性的代价，见 docs/02 对参考实现的同类批评）。
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

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

const T0 = new Date(2026, 0, 10, 9, 0, 0).getTime();
const MIN = 60_000;

/** 造一个 assistant/message 事件（字段形状照真实日志）。 */
function am(seq, time, input, model = "deepseek-v4-pro") {
  return {
    type: "assistant/message",
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [], source: { kind: "model", provider: "deepseek-official", model }, id: `m${seq}` },
      stream: [],
      usage: { inputTokens: input, outputTokens: 0 },
    },
  };
}

const dshHome = mkdtempSync(join(tmpdir(), "dsh-ach-"));
process.env.DSH_HOME = dshHome;
// `.anonymous-user-id` 也放在这个临时 DSH_HOME 里
const { writeFileSync } = await import("node:fs");
writeFileSync(join(dshHome, ".anonymous-user-id"), "1335052546\n", "utf8");

const { AchievementsService } = await import(pathToFileURL(join(pkgRoot, "index.js")).href);
const { TYPERT } = await import(pathToFileURL(join(pkgRoot, "typert.host.js")).href);
const { Service } = await import("@deepseek-ai/cordis");

const metricsResultSchema = TYPERT.invocations.find((i) => i.method === "getMetrics").result.schema;
const profileResultSchema = TYPERT.invocations.find((i) => i.method === "setProfile").result.schema;

/** 造一个记录型 ctx。 */
function makeCtx(opts = {}) {
  const state = {
    registered: null,
    readSessionCalls: [],
    listSessionsCalls: 0,
    effects: [],
    listeners: [],
  };

  const snapshots = opts.snapshots || {};
  const registry = opts.withRegistry === false ? null : {
    register: (def) => {
      state.registered = def;
      return () => {};
    },
    stateOf: () => undefined,
  };

  const sessionQuery = opts.withSessionQuery === false ? null : {
    listSessions: async () => {
      state.listSessionsCalls += 1;
      return Object.keys(snapshots).map((id) => ({ header: { id }, live: false, persisted: true }));
    },
    readSession: async (id) => {
      state.readSessionCalls.push(id);
      return snapshots[id];
    },
  };

  const ctx = {
    reflect: { provide: () => {} },
    get: (name) => {
      if (name === "sessionQuery") return sessionQuery;
      if (name === "sessionProjections") return registry;
      if (name === "sessions") return { list: () => [] };
      return null;
    },
    inject: (deps, cb) => {
      if (opts.injectThrows) throw new Error("inject boom");
      return cb({ sessionProjections: registry });
    },
    on: (name, fn) => {
      if (opts.onThrows) throw new Error("on boom");
      state.listeners.push({ name, fn });
      return () => {};
    },
    effect: (fn) => {
      if (opts.effectThrows) throw new Error("effect boom");
      state.effects.push(fn);
      return () => {};
    },
  };
  return { ctx, state };
}

function svc(opts) {
  const { ctx, state } = makeCtx(opts);
  const s = new AchievementsService(ctx, {});
  s[Service.init]();
  return { s, state };
}

console.log("=== 1. init 契约 ===");
{
  const { s, state } = svc({});
  ok("[Service.init]() 不抛", true);
  ok("注册了投影单元", !!state.registered);
  ok("投影 key 正确", state.registered?.key === "dsh-achievements.ledger", String(state.registered?.key));
  ok("投影 init(header, n) 接受继承前缀长度", typeof state.registered?.init === "function" && state.registered.init({}, 2).inherited === 2);
  ok("投影 apply 是纯折叠函数", typeof state.registered?.apply === "function");
  ok("投影 stateSchema 能 parse 自己的 init 结果（形状自洽）", (() => {
    try {
      state.registered.stateSchema.parse(state.registered.init({}, 0));
      return true;
    } catch (e) {
      console.log("      parse 失败：" + String(e && e.message));
      return false;
    }
  })());
  ok("注册了 session/event 监听", state.listeners.some((l) => l.name === "session/event"));
  ok("注册了 disposer effect", state.effects.length > 0);
}
for (const key of ["injectThrows", "onThrows", "effectThrows"]) {
  let threw = null;
  try {
    svc({ [key]: true });
  } catch (e) {
    threw = e;
  }
  ok(`${key} 下 init 仍不抛`, threw === null, threw && threw.message);
}

console.log("=== 2. getMetrics 产出必须能被真 schema 接受（= 网关 strict 校验）===");
{
  const { s } = svc({
    snapshots: {
      "session-a": { session: { id: "session-a" }, inheritedEventCount: 0, events: [am(1, T0, 1000), am(2, T0 + 10 * MIN, 500)] },
      "session-b": { session: { id: "session-b" }, inheritedEventCount: 0, events: [am(1, T0, 250)] },
    },
  });
  const res = await s.getMetrics();
  ok("getMetrics 返回 ok:true", res && res.ok === true, JSON.stringify(res && res.error));

  let parsed = null;
  let parseError = null;
  try {
    parsed = metricsResultSchema.parse(res);
  } catch (e) {
    parseError = e;
  }
  ok("★ 返回值通过 typert.host.js 的 strict schema（字段逐项对应）", parseError === null, parseError && String(parseError.message).slice(0, 600));
  ok("累计 Token 数正确（1000+500+250）", res.value?.cards?.cumulativeTokens === 1750, String(res.value?.cards?.cumulativeTokens));
  ok("匿名 ID 从临时 DSH_HOME 读到", res.value?.identity?.anonymousUserId === "1335052546", String(res.value?.identity?.anonymousUserId));
  ok("days 是数组且已排序", Array.isArray(res.value?.days) && res.value.days.length > 0);
  ok("models 按总量降序", Array.isArray(res.value?.models) && res.value.models[0]?.total >= (res.value.models[1]?.total ?? 0));
  ok("meta.registryAvailable 为 true", res.value?.meta?.registryAvailable === true);
  ok("parsed 结果是对象（schema 真的跑过）", parsed !== null && typeof parsed === "object");
}

console.log("=== 3. inheritedEventCount 必须真的被用来跳继承前缀 ===");
{
  // 3 条事件，官方说前 2 条是 fork 继承来的 → 只应计第 3 条
  const { s } = svc({
    snapshots: {
      "session-fork": { session: { id: "session-fork" }, inheritedEventCount: 2, events: [am(1, T0, 9999), am(2, T0 + MIN, 9999), am(3, T0 + 2 * MIN, 42)] },
    },
  });
  const res = await s.getMetrics();
  ok("只统计自己的用量（42，而不是 20040）", res.value?.cards?.cumulativeTokens === 42, String(res.value?.cards?.cumulativeTokens));
  ok("messages 也只算自己的（1）", res.value?.details?.messages === 1, String(res.value?.details?.messages));
}

console.log("=== 4. 冷会话缓存：第二次不重复读日志 ===");
{
  const { s, state } = svc({ snapshots: { "session-a": { session: { id: "session-a" }, inheritedEventCount: 0, events: [am(1, T0, 100)] } } });
  await s.getMetrics();
  await s.getMetrics();
  await s.getMetrics();
  ok("readSession 只被调用 1 次", state.readSessionCalls.length === 1, `实际 ${state.readSessionCalls.length}`);
  ok("listSessions 每次都调用（用于发现新会话）", state.listSessionsCalls === 3, String(state.listSessionsCalls));
}

console.log("=== 5. 服务缺席时给业务失败信封而不是抛 ===");
{
  const { s } = svc({ withSessionQuery: false });
  let threw = null;
  let res = null;
  try {
    res = await s.getMetrics();
  } catch (e) {
    threw = e;
  }
  ok("getMetrics 不抛", threw === null, threw && threw.message);
  ok("返回 ok:false 且带 code", res?.ok === false && typeof res?.error?.code === "string", JSON.stringify(res));
  ok("失败信封同样通过 strict schema", (() => {
    try {
      metricsResultSchema.parse(res);
      return true;
    } catch {
      return false;
    }
  })());
}
{
  const { s } = svc({ withRegistry: false });
  const res = await s.getMetrics();
  ok("没有投影注册表时仍能出数（退化成冷折叠）", res?.ok === true, JSON.stringify(res?.error));
  ok("meta.registryAvailable=false 如实上报", res?.value?.meta?.registryAvailable === false);
}

console.log("=== 6. setProfile 落盘 / 读回 ===");
{
  const { s } = svc({ snapshots: {} });
  const saved = await s.setProfile({ nickname: "李雨", avatarUrl: "https://example.com/a.png" });
  ok("setProfile 返回 ok:true", saved?.ok === true, JSON.stringify(saved));
  ok("返回值通过 strict schema", (() => {
    try {
      profileResultSchema.parse(saved);
      return true;
    } catch {
      return false;
    }
  })());

  const onDisk = JSON.parse(readFileSync(join(dshHome, "data", "dsh-achievements", "config.json"), "utf8"));
  ok("配置真的写到了 DSH_HOME/data/dsh-achievements/config.json", onDisk.nickname === "李雨" && onDisk.avatarUrl === "https://example.com/a.png", JSON.stringify(onDisk));

  const res = await s.getMetrics();
  ok("getMetrics 读回昵称", res.value?.identity?.nickname === "李雨", String(res.value?.identity?.nickname));

  const cleared = await s.setProfile({ nickname: null });
  ok("nickname: null 清空该字段", cleared?.value?.nickname === null, JSON.stringify(cleared?.value));
  ok("清空 nickname 不动 avatarUrl", cleared?.value?.avatarUrl === "https://example.com/a.png", JSON.stringify(cleared?.value));
}

rmSync(dshHome, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
