/**
 * Host 半冒烟：不需要 DSH 就能验的那些「语法合法但契约错」。
 *
 * 覆盖两类最贵的事故：
 *  1. **返回值与 typert.host.js 的 strict schema 不对应** —— 拿真 zod schema `parse()`
 *     一遍就等价于网关校验，能在重启之前抓到（网关会直接拒掉，页面表现为没数据）。
 *  2. **请求路径里做重 IO → RPC 永不返回** —— v0.1.2 就是这么把界面卡在「刷新中…」的。
 *     所以这里专门断言 `getMetrics()` **不 await 任何 IO**、立刻返回 `collecting:true`。
 *
 * 另外覆盖：后台回填并发 + 超时保护（一个坏会话不能拖死全局）、继承前缀、
 * 活/冷会话去重、活账本缓存、服务缺席时的降级、setProfile 的头像校验。
 *
 * ⚠️ `index.js` 在**模块加载期**读 `process.env.DSH_HOME` 与 `DSH_ACH_READ_TIMEOUT_MS`，
 *    所以必须在 import 之前设好。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
process.env.DSH_ACH_READ_TIMEOUT_MS = "150"; // 让超时保护可测
writeFileSync(join(dshHome, ".anonymous-user-id"), "84cf07e5-c68e-4cd0-9c39-dadcc038686e\n", "utf8");

const { AchievementsService } = await import(pathToFileURL(join(pkgRoot, "index.js")).href);
const { TYPERT } = await import(pathToFileURL(join(pkgRoot, "typert.host.js")).href);
const { Service } = await import("@deepseek-ai/cordis");

const metricsResultSchema = TYPERT.invocations.find((i) => i.method === "getMetrics").result.schema;
const profileResultSchema = TYPERT.invocations.find((i) => i.method === "setProfile").result.schema;

/** 造一个记录型 ctx。 */
function makeCtx(opts = {}) {
  const state = { registered: null, readSessionCalls: [], listSessionsCalls: 0, effects: [], listeners: [], stateOfCalls: 0 };

  const registry =
    opts.withRegistry === false
      ? null
      : {
          register: (def) => {
            state.registered = def;
            return () => {};
          },
          stateOf: (session, key) => {
            state.stateOfCalls += 1;
            if (opts.stateOfThrows) throw new Error("stateOf boom");
            const id = (session && session.id) || (session && session.header && session.header.id);
            return opts.liveLedgers && id && opts.liveLedgers[id] ? opts.liveLedgers[id] : undefined;
          },
        };

  const sessionQuery =
    opts.withSessionQuery === false
      ? null
      : {
          listSessions: async () => {
            state.listSessionsCalls += 1;
            if (opts.listSessionsThrows) throw new Error("listSessions boom");
            return Object.keys(opts.snapshots || {}).map((id) => ({ header: { id }, live: false, persisted: true }));
          },
          readSession: async (id) => {
            state.readSessionCalls.push(id);
            if (opts.readSessionNever) return new Promise(() => {});
            if (opts.readSessionThrows) throw new Error("readSession boom");
            if (opts.readSessionThrowsFor && opts.readSessionThrowsFor === id) throw new Error("readSession boom for " + id);
            return opts.snapshots[id];
          },
        };

  const liveSessions = opts.liveSessions || [];

  const ctx = {
    reflect: { provide: () => {} },
    get: (name) => {
      if (name === "sessionQuery") return sessionQuery;
      if (name === "sessionProjections") return registry;
      if (name === "sessions") return { list: () => liveSessions };
      return null;
    },
    inject: (deps, cb) => {
      if (opts.injectThrows) throw new Error("inject boom");
      return cb({ sessionProjections: registry, get: () => null });
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

/** 等回填结束（或超时）。 */
async function settle(s, ms = 4000) {
  await Promise.race([s._backfillPromise, new Promise((r) => setTimeout(r, ms))]);
}

console.log("=== 1. init 契约 ===");
{
  const { s, state } = svc({});
  ok("[Service.init]() 不抛", true);
  ok("注册了投影单元", !!state.registered);
  ok("投影 key 正确", state.registered?.key === "dsh-achievements.ledger", String(state.registered?.key));
  ok("init(header, n) 消费继承前缀长度", state.registered?.init({}, 2).inherited === 2);
  ok("投影 stateSchema 能 parse 自己的 init 结果", (() => {
    try {
      state.registered.stateSchema.parse(state.registered.init({}, 0));
      return true;
    } catch (e) {
      console.log("      parse 失败：" + String(e && e.message));
      return false;
    }
  })());
  ok("注册了 disposer effect", state.effects.length > 0);
  await settle(s);
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

console.log("=== 2. ★ getMetrics 必须在请求路径里不 await 任何 IO ===");
{
  // readSession 永远不 resolve：只要 getMetrics 里还有 IO，这里就会挂住
  const { s } = svc({ snapshots: { "s-1": { session: { id: "s-1" }, inheritedEventCount: 0, events: [am(1, T0, 100)] } }, readSessionNever: true });
  const t0 = Date.now();
  const res = await Promise.race([s.getMetrics(), new Promise((r) => setTimeout(() => r("TIMEOUT"), 1500))]);
  const elapsed = Date.now() - t0;
  ok("getMetrics 在 1.5s 内返回（没有卡在 IO 上）", res !== "TIMEOUT", `实际 ${elapsed}ms`);
  ok("返回 ok:true", res !== "TIMEOUT" && res.ok === true, JSON.stringify(res && res.error));
  ok("collecting=true（回填还没完）", res !== "TIMEOUT" && res.value.collecting === true);
  ok("ready=false", res !== "TIMEOUT" && res.value.ready === false);
  ok("立刻返回（<300ms）", elapsed < 300, `${elapsed}ms`);
  await settle(s);
}

console.log("=== 3. 回填完成后：数字 + strict schema ===");
{
  const { s, state } = svc({
    snapshots: {
      "session-a": { session: { id: "session-a" }, inheritedEventCount: 0, events: [am(1, T0, 1000), am(2, T0 + 10 * MIN, 500)] },
      "session-b": { session: { id: "session-b" }, inheritedEventCount: 0, events: [am(1, T0, 250)] },
    },
  });
  await settle(s);
  ok("readSession 两个会话都读到了", state.readSessionCalls.length === 2, JSON.stringify(state.readSessionCalls));

  const res = await s.getMetrics();
  ok("ready=true", res.value.ready === true);
  ok("collecting=false", res.value.collecting === false);
  ok("累计 Token 数 = 1750", res.value.cards.cumulativeTokens === 1750, String(res.value.cards.cumulativeTokens));
  ok("progress.done = 2", res.value.progress.done === 2, JSON.stringify(res.value.progress));
  ok("meta.cold = 2", res.value.meta.cold === 2, JSON.stringify(res.value.meta));

  let parseError = null;
  try {
    metricsResultSchema.parse(res);
  } catch (e) {
    parseError = e;
  }
  ok("★ 通过 typert.host.js 的 strict schema（= 网关校验）", parseError === null, parseError && String(parseError.message).slice(0, 500));
  ok("identity.anonymousUserId 读到了", res.value.identity.anonymousUserId === "84cf07e5-c68e-4cd0-9c39-dadcc038686e", String(res.value.identity.anonymousUserId));
  ok("identity.avatar 字段存在（改名后）", Object.prototype.hasOwnProperty.call(res.value.identity, "avatar"));
}

console.log("=== 4. inheritedEventCount 必须真的跳继承前缀 ===");
{
  const { s } = svc({
    snapshots: {
      "session-fork": { session: { id: "session-fork" }, inheritedEventCount: 2, events: [am(1, T0, 9999), am(2, T0 + MIN, 9999), am(3, T0 + 2 * MIN, 42)] },
    },
  });
  await settle(s);
  const res = await s.getMetrics();
  ok("只统计自己的（42，而非 20040）", res.value.cards.cumulativeTokens === 42, String(res.value.cards.cumulativeTokens));
  ok("messages 也只算自己的（1）", res.value.details.messages === 1, String(res.value.details.messages));
}

console.log("=== 5. 超时 / 失败保护：坏会话不能拖死整轮 ===");
{
  const { s } = svc({
    snapshots: { "never-1": { session: { id: "never-1" }, inheritedEventCount: 0, events: [] } },
    readSessionNever: true,
  });
  await settle(s);
  const res = await s.getMetrics();
  ok("回填仍然结束了（没挂死）", res.value.ready === true, JSON.stringify(res.value.progress));
  ok("记账了 failed", res.value.progress.failed >= 1, JSON.stringify(res.value.progress));
  ok("error 里带得出原因", typeof res.value.error === "string" && res.value.error.includes("超时"), String(res.value.error));
  ok("ok 仍是 true（错误走 error 字段而不是整包失败）", res.ok === true);
}
{
  const { s } = svc({ snapshots: { x: {} }, readSessionThrows: true });
  await settle(s);
  const res = await s.getMetrics();
  ok("readSession 抛错也记账且继续", res.value.ready === true && res.value.progress.failed >= 1, JSON.stringify(res.value.progress));
}
{
  const { s } = svc({ snapshots: { x: {} }, listSessionsThrows: true });
  await settle(s);
  const res = await s.getMetrics();
  ok("listSessions 抛错 → ready=true 且 error 有原因", res.value.ready === true && String(res.value.error).includes("listSessions"), String(res.value.error));
}

console.log("=== 6. 活 / 冷会话去重（同一会话绝不能算两次） ===");
{
  const liveLedger = {
    v: 2, inherited: 0, seen: 0, days: { "2026-01-10": { total: 777, input: 777, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } },
    hours: { "9": 777 }, models: { "deepseek-official::deepseek-v4-pro": 777 },
    totals: { total: 777, input: 777, output: 0, cacheRead: 0, cacheWrite: 0 },
    messages: 1, steps: 0, first: T0, last: T0, burstStart: T0, burstLongestMs: 0,
  };
  // 同一个 id 既是冷的（已回填 100），又是活的（stateOf 给 777）
  const { s, state } = svc({
    snapshots: { "dup-1": { session: { id: "dup-1" }, inheritedEventCount: 0, events: [am(1, T0, 100)] } },
    liveSessions: [{ id: "dup-1", header: { id: "dup-1" } }],
    liveLedgers: { "dup-1": liveLedger },
  });
  await settle(s);
  const res = await s.getMetrics();
  ok("只计活会话那份（777）", res.value.cards.cumulativeTokens === 777, String(res.value.cards.cumulativeTokens));
  ok("meta.live = 1", res.value.meta.live === 1, JSON.stringify(res.value.meta));
  ok("meta.cold 不含它", res.value.meta.cold === 0, JSON.stringify(res.value.meta));
  ok("stateOf 被调用过", state.stateOfCalls >= 1);
}
{
  // stateOf 抛错 → 回退到冷账本，不丢数据
  const { s } = svc({
    snapshots: { "l-1": { session: { id: "l-1" }, inheritedEventCount: 0, events: [am(1, T0, 55)] } },
    liveSessions: [{ id: "l-1" }],
    stateOfThrows: true,
    liveLedgers: {},
  });
  await settle(s);
  const res = await s.getMetrics();
  ok("stateOf 抛错 → 回退冷账本（55）", res.value.cards.cumulativeTokens === 55, String(res.value.cards.cumulativeTokens));
}
{
  // 活账本缓存：5s 内重复调用不再打 stateOf
  const { s, state } = svc({
    snapshots: {},
    liveSessions: [{ id: "c-1" }],
    liveLedgers: {
      "c-1": {
        v: 2, inherited: 0, seen: 0, days: {}, hours: {}, models: {},
        totals: { total: 5, input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
        messages: 1, steps: 0, first: T0, last: T0, burstStart: T0, burstLongestMs: 0,
      },
    },
  });
  await settle(s);
  await s.getMetrics();
  const after1 = state.stateOfCalls;
  await s.getMetrics();
  await s.getMetrics();
  ok("活账本命中缓存（stateOf 调用次数没随 getMetrics 增长）", state.stateOfCalls === after1, `${after1} → ${state.stateOfCalls}`);
}

console.log("=== 7. 服务缺席时的降级 ===");
{
  const { s } = svc({ withSessionQuery: false });
  await settle(s);
  const res = await s.getMetrics();
  ok("没有 sessionQuery → ok:true + error 说明原因", res.ok === true && String(res.value.error).includes("sessionQuery"), String(res.value.error));
  ok("ready=true（明确结束，不是一直转圈）", res.value.ready === true);
  ok("失败信封/成功信封都过 strict schema", (() => {
    try {
      metricsResultSchema.parse(res);
      return true;
    } catch {
      return false;
    }
  })());
}
{
  const { s } = svc({ withRegistry: false, snapshots: { a: { session: { id: "a" }, inheritedEventCount: 0, events: [am(1, T0, 9)] } } });
  await settle(s);
  const res = await s.getMetrics();
  ok("没有投影注册表仍能出数（退化成冷折叠）", res.value.cards.cumulativeTokens === 9, String(res.value.cards.cumulativeTokens));
  ok("meta.registryAvailable=false 如实上报", res.value.meta.registryAvailable === false);
}

console.log("=== 8. setProfile：昵称 / 头像（含文件上传的 data URL）===");
{
  const { s } = svc({ snapshots: {} });
  const png1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const saved = await s.setProfile({ nickname: "李雨", avatar: png1x1 });
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
  ok("data URL 头像落盘", onDisk.avatar === png1x1);
  ok("昵称落盘", onDisk.nickname === "李雨");

  const res = await s.getMetrics();
  ok("getMetrics 读回昵称", res.value.identity.nickname === "李雨", String(res.value.identity.nickname));
  ok("getMetrics 读回头像", res.value.identity.avatar === png1x1);

  const https = await s.setProfile({ avatar: "https://example.com/a.png" });
  ok("http(s) URL 头像也接受", https?.ok === true && https.value.avatar === "https://example.com/a.png");

  const bad = await s.setProfile({ avatar: "javascript:alert(1)" });
  ok("非法头像格式被拒", bad?.ok === false && bad.error.code === "avatar_invalid", JSON.stringify(bad));
  ok("被拒后原头像不变", (await s.getMetrics()).value.identity.avatar === "https://example.com/a.png");

  const huge = await s.setProfile({ avatar: "data:image/png;base64," + "A".repeat(700001) });
  ok("超大图片被拒（带可读原因）", huge?.ok === false && String(huge.error.message).includes("过大"), JSON.stringify(huge && huge.error));

  const cleared = await s.setProfile({ avatar: null, nickname: null });
  ok("null 清空两个字段", cleared?.value?.avatar === null && cleared?.value?.nickname === null, JSON.stringify(cleared && cleared.value));

  const clearedRes = await s.getMetrics();
  ok("清空后 identity 为 null（客户端会回退账号头像/昵称）", clearedRes.value.identity.avatar === null && clearedRes.value.identity.nickname === null);
}

rmSync(dshHome, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
