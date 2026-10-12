/**
 * Host 半冒烟：不需要 DSH 就能验的那些「语法合法但契约错」。
 *
 * 覆盖三类最容易犯、代价最高的错误：
 *
 *  1. ★★ **Remote 方法的返回值形状**。`result.schema` 描述的是**方法的原始返回值**，
 *     `{ok, value}` 信封由传输层加（权威依据：官方 `dsh-api-account-controller`
 *     的 `#account/getProfile` 声明裸的 `{status:'ready',value:{…}}`，实现直接 return）。
 *     我曾在 host 里自己套了一层信封，于是客户端拿到双层信封 → 字段全读不到 →
 *     页面「全 0 + Invalid Date + 不报错」。那时 host 与 schema 是自洽的，strict 校验
 *     照样通过，所以这里专门断言：**原始返回值能过 schema，而信封形状过不了**。
 *
 *  2. **请求路径里做重 IO → RPC 永不返回**。断言 `getMetrics()` 不 await 任何 IO、
 *     立刻返回 `collecting:true`（用一个永不 resolve 的 readSession 证明）。
 *
 *  3. **模型筛选**必须真算：v3 账本带按模型分日明细，筛选后的累计/峰值/连续天数
 *     都要来自该模型的明细，而选择器目录始终是全部模型。
 *
 * 另外覆盖：后台回填并发 + 超时保护（一个坏会话不能拖死全局）、继承前缀、
 * 活/冷会话去重、活账本缓存、服务缺席时的降级、setProfile 的头像校验。
 *
 * ⚠️ `index.js` 在**模块加载期**读 `process.env.DSH_HOME` 与 `DSH_ACH_READ_TIMEOUT_MS`，
 *    所以必须在 import 之前设好。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { zstdCompressSync } from "node:zlib";

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
const PRO = "deepseek-official::deepseek-v4-pro";
const FLASH = "deepseek-official::deepseek-v4-flash";

/** 造一个 assistant/message 事件（字段形状照真实日志）。 */
function am(seq, time, input, modelKey = PRO) {
  const i = modelKey.indexOf("::");
  const provider = modelKey.slice(0, i);
  const model = modelKey.slice(i + 2);
  return {
    type: "assistant/message",
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: "assistant", content: [], source: { kind: "model", provider, model }, id: `m${seq}` },
      stream: [],
      usage: { inputTokens: input, outputTokens: 0 },
    },
  };
}

/** 把若干条记录写成真实的多帧 zstd 日志缓冲（每行一个 frame）。 */
function encodeLog(records) {
  return Buffer.concat(records.map((r) => zstdCompressSync(Buffer.from(JSON.stringify(r) + "\n", "utf8"))));
}

const dshHome = mkdtempSync(join(tmpdir(), "dsh-ach-"));
process.env.DSH_HOME = dshHome;
process.env.DSH_ACH_READ_TIMEOUT_MS = "150"; // 让超时保护可测
writeFileSync(join(dshHome, ".anonymous-user-id"), "84cf07e5-c68e-4cd0-9c39-dadcc038686e\n", "utf8");

const { AchievementsService } = await import(pathToFileURL(join(pkgRoot, "index.js")).href);
const { TYPERT } = await import(pathToFileURL(join(pkgRoot, "typert.host.js")).href);
const { Service } = await import("@deepseek-ai/cordis");

const invocationOf = (m) => TYPERT.invocations.find((i) => i.method === m);
const metricsResultSchema = invocationOf("getMetrics").result.schema;
const profileResultSchema = invocationOf("setProfile").result.schema;

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
            return Object.keys(opts.snapshots || {}).map((id) => ({
              header: { id, cwd: opts.cwdOf ? opts.cwdOf(id) : undefined },
              live: false,
              persisted: true,
            }));
          },
          readSession: async (id) => {
            state.readSessionCalls.push(id);
            if (opts.readSessionNever) return new Promise(() => {});
            // 按 id 精确模拟「DSH reader 拒绝这个会话」（descriptor 版本不受支持等）
            if (opts.readSessionThrowsFor === id) {
              throw new Error(opts.readSessionThrowsForMessage || "readSession boom");
            }
            if (opts.readSessionThrows) throw new Error("readSession boom");
            return opts.snapshots[id];
          },
        };

  const liveSessions = opts.liveSessions || [];
  const sessionsService = { list: () => liveSessions };

  const ctx = {
    reflect: { provide: () => {} },
    get: (name) => {
      // ★ 刻意让 ctx.get("sessionQuery") 返回 null：真实环境里
      //   dsh-session-query 比我们晚加载，init 阶段 ctx.get 就是拿不到它
      //   （踩过的坑：diagnostics 显示 listing=1 / cold=0）。
      //   如果实现退回用 ctx.get，下面所有回填断言都会失败。
      if (name === "sessionQuery") return null;
      if (name === "sessionProjections") return registry;
      if (name === "sessions") return sessionsService;
      return null;
    },
    inject: (deps, cb) => {
      if (opts.injectThrows) throw new Error("inject boom");
      const available = opts.withSessionQuery !== false;
      const scope = {
        sessionProjections: registry,
        sessionQuery: available ? sessionQuery : null,
        sessions: sessionsService,
        get: (n) => {
          if (n === "sessionQuery") return available ? sessionQuery : null;
          if (n === "sessionProjections") return registry;
          if (n === "sessions") return sessionsService;
          return null;
        },
      };
      return cb(scope);
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
  return { s, state, ctx };
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
  ok(
    "投影 stateSchema 能 parse 自己的 init 结果",
    (() => {
      try {
        state.registered.stateSchema.parse(state.registered.init({}, 0));
        return true;
      } catch (e) {
        console.log("      parse 失败：" + String(e && e.message));
        return false;
      }
    })(),
  );
  ok("账本版本已升到 3（models 带分日明细）", state.registered?.init({}, 0).v === 3, String(state.registered?.init({}, 0).v));
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

console.log("=== 2. ★★ 返回值形状：原始值，不是 {ok,value} 信封 ===");
{
  const { s } = svc({ snapshots: {}, readSessionNever: true });
  await settle(s);
  const raw = await s.getMetrics("");

  ok("返回的不是信封（没有 ok 字段）", raw.ok === undefined, String(raw.ok));
  ok("返回的不是信封（没有 value 字段）", raw.value === undefined, String(raw.value).slice(0, 80));
  ok("是快照本体（有 ready/collecting/cards/meta）", typeof raw.ready === "boolean" && typeof raw.collecting === "boolean" && !!raw.cards && !!raw.meta);
  ok(
    "★ 原始值直接通过 manifest 的 result schema（= 网关校验）",
    (() => {
      try {
        metricsResultSchema.parse(raw);
        return true;
      } catch (e) {
        console.log("      parse 失败：" + String(e && e.message).slice(0, 400));
        return false;
      }
    })(),
  );
  ok(
    "★ 反证：把信封喂给该 schema 会失败（防止再退回双层信封）",
    (() => {
      try {
        metricsResultSchema.parse({ ok: true, value: raw });
        return false;
      } catch {
        return true;
      }
    })(),
  );
}

console.log("=== 3. getMetrics 必须在请求路径里不 await 任何 IO ===");
{
  const { s } = svc({ snapshots: { "s-1": { session: { id: "s-1" }, inheritedEventCount: 0, events: [am(1, T0, 100)] } }, readSessionNever: true });
  const t0 = Date.now();
  const res = await Promise.race([s.getMetrics(""), new Promise((r) => setTimeout(() => r("TIMEOUT"), 1500))]);
  const elapsed = Date.now() - t0;
  ok("getMetrics 在 1.5s 内返回（没有卡在 IO 上）", res !== "TIMEOUT", `实际 ${elapsed}ms`);
  ok("collecting=true（回填还没完）", res !== "TIMEOUT" && res.collecting === true);
  ok("ready=false", res !== "TIMEOUT" && res.ready === false);
  ok("立刻返回（<300ms）", elapsed < 300, `${elapsed}ms`);
  await settle(s);
}

console.log("=== 4. 回填完成后：数字 ===");
{
  const { s, state, ctx } = svc({
    snapshots: {
      "session-a": { session: { id: "session-a" }, inheritedEventCount: 0, events: [am(1, T0, 1000), am(2, T0 + 10 * MIN, 500)] },
      "session-b": { session: { id: "session-b" }, inheritedEventCount: 0, events: [am(1, T0, 250, FLASH)] },
    },
  });
  await settle(s);
  ok("★ ctx.get('sessionQuery') 拿不到（这就是真实加载顺序）", ctx.get("sessionQuery") === null);
  ok("★ 但回填仍读到全部历史会话（证明走的是 ctx.inject）", state.readSessionCalls.length === 2, JSON.stringify(state.readSessionCalls));

  const res = await s.getMetrics("");
  ok("meta.queryAvailable=true", res.meta.queryAvailable === true, JSON.stringify(res.meta));
  ok("ready=true", res.ready === true);
  ok("collecting=false", res.collecting === false);
  ok("累计 Token 数 = 1750", res.cards.cumulativeTokens === 1750, String(res.cards.cumulativeTokens));
  ok("progress.done = 2", res.progress.done === 2, JSON.stringify(res.progress));
  ok("meta.cold = 2", res.meta.cold === 2, JSON.stringify(res.meta));
  ok("identity.anonymousUserId 读到了", res.identity.anonymousUserId === "84cf07e5-c68e-4cd0-9c39-dadcc038686e", String(res.identity.anonymousUserId));
  ok("identity.avatar 字段存在", Object.prototype.hasOwnProperty.call(res.identity, "avatar"));
  ok("days 有 1 天", res.days.length === 1, JSON.stringify(res.days.map((d) => d.date)));
  ok("models 有 2 个", res.models.length === 2, JSON.stringify(res.models.map((m) => m.name)));
}

console.log("=== 5. inheritedEventCount 必须真的跳继承前缀 ===");
{
  const { s } = svc({
    snapshots: {
      "session-fork": { session: { id: "session-fork" }, inheritedEventCount: 2, events: [am(1, T0, 9999), am(2, T0 + MIN, 9999), am(3, T0 + 2 * MIN, 42)] },
    },
  });
  await settle(s);
  const res = await s.getMetrics("");
  ok("只统计自己的（42，而非 20040）", res.cards.cumulativeTokens === 42, String(res.cards.cumulativeTokens));
  ok("messages 也只算自己的（1）", res.details.messages === 1, String(res.details.messages));
}

console.log("=== 6. 模型筛选（v3 分日明细）===");
{
  const { s } = svc({
    snapshots: {
      "m-1": { session: { id: "m-1" }, inheritedEventCount: 0, events: [am(1, T0, 100, PRO), am(2, T0 + 10 * MIN, 500, PRO)] },
      "m-2": { session: { id: "m-2" }, inheritedEventCount: 0, events: [am(1, T0, 250, FLASH)] },
    },
  });
  await settle(s);

  const all = await s.getMetrics("");
  ok("全部：850（pro 600 + flash 250）", all.cards.cumulativeTokens === 850, String(all.cards.cumulativeTokens));
  ok("全部：selectedModel=null", all.selectedModel === null, String(all.selectedModel));

  const pro = await s.getMetrics(PRO);
  ok("只看 pro：600", pro.cards.cumulativeTokens === 600, String(pro.cards.cumulativeTokens));
  ok("只看 pro：selectedModel 回填", pro.selectedModel === PRO, String(pro.selectedModel));
  ok("只看 pro：会话数 1", pro.details.sessions === 1, String(pro.details.sessions));
  ok("只看 pro：图表只有该模型那天、总量 600", pro.days.length === 1 && pro.days[0].total === 600, JSON.stringify(pro.days));
  ok("★ 选择器目录仍是**全部模型**（否则筛完切不回去）", pro.models.length === 2, JSON.stringify(pro.models.map((m) => m.name)));
  ok("pro 的 messages 计入筛选结果", pro.details.messages === 2, String(pro.details.messages));

  const flash = await s.getMetrics(FLASH);
  ok("只看 flash：250", flash.cards.cumulativeTokens === 250, String(flash.cards.cumulativeTokens));

  const none = await s.getMetrics("deepseek-official::does-not-exist");
  ok("未知模型 → 0（而不是回退成全部）", none.cards.cumulativeTokens === 0, String(none.cards.cumulativeTokens));

  ok(
    "筛选结果也过 strict schema",
    (() => {
      try {
        metricsResultSchema.parse(pro);
        return true;
      } catch (e) {
        console.log("      " + String(e && e.message).slice(0, 300));
        return false;
      }
    })(),
  );
}

console.log("=== 7. 超时 / 失败保护：坏会话不能拖死整轮 ===");
{
  const { s } = svc({
    snapshots: { "never-1": { session: { id: "never-1" }, inheritedEventCount: 0, events: [] } },
    readSessionNever: true,
  });
  await settle(s);
  const res = await s.getMetrics("");
  ok("回填仍然结束了（没挂死）", res.ready === true, JSON.stringify(res.progress));
  ok("记账了 failed", res.progress.failed >= 1, JSON.stringify(res.progress));
  ok("error 里带得出原因", typeof res.error === "string" && res.error.includes("超时"), String(res.error));
}
{
  const { s } = svc({ snapshots: { x: {} }, readSessionThrows: true });
  await settle(s);
  const res = await s.getMetrics("");
  ok("readSession 抛错也记账且继续", res.ready === true && res.progress.failed >= 1, JSON.stringify(res.progress));
}
{
  const { s } = svc({ snapshots: { x: {} }, listSessionsThrows: true });
  await settle(s);
  const res = await s.getMetrics("");
  ok("listSessions 抛错 → ready=true 且 error 有原因", res.ready === true && String(res.error).includes("listSessions"), String(res.error));
}

console.log("=== 8. 活 / 冷会话去重（同一会话绝不能算两次）===");
{
  const liveLedger = {
    v: 3,
    inherited: 0,
    seen: 0,
    days: { "2026-01-10": { total: 777, input: 777, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } },
    hours: { "9": 777 },
    models: { [PRO]: { total: 777, days: { "2026-01-10": { total: 777, input: 777, output: 0, cacheRead: 0, cacheWrite: 0, messages: 1 } } } },
    totals: { total: 777, input: 777, output: 0, cacheRead: 0, cacheWrite: 0 },
    messages: 1,
    steps: 0,
    first: T0,
    last: T0,
    burstStart: T0,
    burstLongestMs: 0,
  };
  const { s, state } = svc({
    snapshots: { "dup-1": { session: { id: "dup-1" }, inheritedEventCount: 0, events: [am(1, T0, 100)] } },
    liveSessions: [{ id: "dup-1", header: { id: "dup-1" } }],
    liveLedgers: { "dup-1": liveLedger },
  });
  await settle(s);
  const res = await s.getMetrics("");
  ok("只计活会话那份（777）", res.cards.cumulativeTokens === 777, String(res.cards.cumulativeTokens));
  ok("meta.live = 1", res.meta.live === 1, JSON.stringify(res.meta));
  ok("meta.cold 不含它", res.meta.cold === 0, JSON.stringify(res.meta));
  ok("stateOf 被调用过", state.stateOfCalls >= 1);
}
{
  const { s } = svc({
    snapshots: { "l-1": { session: { id: "l-1" }, inheritedEventCount: 0, events: [am(1, T0, 55)] } },
    liveSessions: [{ id: "l-1" }],
    stateOfThrows: true,
    liveLedgers: {},
  });
  await settle(s);
  const res = await s.getMetrics("");
  ok("stateOf 抛错 → 回退冷账本（55）", res.cards.cumulativeTokens === 55, String(res.cards.cumulativeTokens));
}
{
  const { s, state } = svc({
    snapshots: {},
    liveSessions: [{ id: "c-1" }],
    liveLedgers: {
      "c-1": {
        v: 3, inherited: 0, seen: 0, days: {}, hours: {}, models: {},
        totals: { total: 5, input: 5, output: 0, cacheRead: 0, cacheWrite: 0 },
        messages: 1, steps: 0, first: T0, last: T0, burstStart: T0, burstLongestMs: 0,
      },
    },
  });
  await settle(s);
  await s.getMetrics("");
  const after1 = state.stateOfCalls;
  await s.getMetrics("");
  await s.getMetrics("");
  ok("活账本命中缓存（stateOf 调用次数没随 getMetrics 增长）", state.stateOfCalls === after1, `${after1} → ${state.stateOfCalls}`);
}

console.log("=== 9. 服务缺席时的降级 ===");
{
  const { s } = svc({ withSessionQuery: false });
  await settle(s);
  const res = await s.getMetrics("");
  ok("没有 sessionQuery → 有 error 说明原因", String(res.error).includes("sessionQuery"), String(res.error));
  ok("ready=true（明确结束，不是一直转圈）", res.ready === true);
  ok(
    "仍然通过 strict schema",
    (() => {
      try {
        metricsResultSchema.parse(res);
        return true;
      } catch {
        return false;
      }
    })(),
  );
}
{
  const { s } = svc({ withRegistry: false, snapshots: { a: { session: { id: "a" }, inheritedEventCount: 0, events: [am(1, T0, 9)] } } });
  await settle(s);
  const res = await s.getMetrics("");
  ok("没有投影注册表仍能出数（退化成冷折叠）", res.cards.cumulativeTokens === 9, String(res.cards.cumulativeTokens));
  ok("meta.registryAvailable=false 如实上报", res.meta.registryAvailable === false);
}

console.log("=== 10. setProfile：昵称 / 头像（含文件上传的 data URL）===");
{
  const { s } = svc({ snapshots: {} });
  const png1x1 =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

  const saved = await s.setProfile({ nickname: "李雨", avatar: png1x1 });
  ok("setProfile 返回原始值（不是信封）", saved.ok === undefined && saved.value === undefined && saved.saved === true, JSON.stringify(saved).slice(0, 120));
  ok(
    "原始值通过 strict schema",
    (() => {
      try {
        profileResultSchema.parse(saved);
        return true;
      } catch {
        return false;
      }
    })(),
  );

  const onDisk = JSON.parse(readFileSync(join(dshHome, "data", "dsh-achievements", "config.json"), "utf8"));
  ok("data URL 头像落盘", onDisk.avatar === png1x1);
  ok("昵称落盘", onDisk.nickname === "李雨");

  const res = await s.getMetrics("");
  ok("getMetrics 读回昵称", res.identity.nickname === "李雨", String(res.identity.nickname));
  ok("getMetrics 读回头像", res.identity.avatar === png1x1);

  const https = await s.setProfile({ avatar: "https://example.com/a.png" });
  ok("http(s) URL 头像也接受", https.saved === true && https.avatar === "https://example.com/a.png");

  // 校验失败必须是**抛错**（传输层会转成 {ok:false,error}），而不是返回一个 ok:false 的值
  let rejected = null;
  try {
    await s.setProfile({ avatar: "javascript:alert(1)" });
  } catch (e) {
    rejected = e;
  }
  ok("非法头像格式 → 抛错", rejected !== null, rejected && rejected.message);
  ok("抛出的原因可读", rejected !== null && String(rejected.message).includes("格式"), rejected && rejected.message);
  ok("被拒后原头像不变", (await s.getMetrics("")).identity.avatar === "https://example.com/a.png");

  let hugeErr = null;
  try {
    await s.setProfile({ avatar: "data:image/png;base64," + "A".repeat(700001) });
  } catch (e) {
    hugeErr = e;
  }
  ok("超大图片被拒（带可读原因）", hugeErr !== null && String(hugeErr.message).includes("过大"), hugeErr && hugeErr.message);

  const cleared = await s.setProfile({ avatar: null, nickname: null });
  ok("null 清空两个字段", cleared.avatar === null && cleared.nickname === null, JSON.stringify(cleared));

  const clearedRes = await s.getMetrics("");
  ok("清空后 identity 为 null（客户端会回退账号头像/昵称）", clearedRes.identity.avatar === null && clearedRes.identity.nickname === null);
}

console.log("=== 11. readSession 被拒时，用原始日志兜底 ===");
{
  const id = "1117a871-ddd9-48c2-891f-d59176db54a5";
  const cwd = "F:\\0dsh\\edu-pentest";
  const dir = join(dshHome, "sessions", "--F-0dsh-edu-pentest--", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "session.jsonl.zstd"),
    encodeLog([
      am(1, T0, 5000),
      { type: "session/end-seed", seq: 2, time: T0, data: { inherited: true } },
      am(3, T0 + MIN, 700),
    ]),
  );

  const { s } = svc({
    snapshots: { [id]: { session: { id }, inheritedEventCount: 0, events: [] } },
    cwdOf: (x) => (x === id ? cwd : undefined),
    readSessionThrowsFor: id,
    readSessionThrowsForMessage:
      'failed to read stored session "' + id + '": subagent/descriptor 0 uses unsupported descriptor version 2',
  });
  await settle(s);
  const res = await s.getMetrics("");

  ok("★ 兜底成功：只算自己的 700（继承前缀 5000 已跳）", res.cards.cumulativeTokens === 700, String(res.cards.cumulativeTokens));
  ok("★ 不再计入 failed", res.progress.failed === 0, JSON.stringify(res.progress));
  ok("meta.raw = 1", res.meta.raw === 1, JSON.stringify(res.meta));
  ok("说明里写清了「已用原始日志兜底」", typeof res.error === "string" && res.error.includes("原始日志兜底"), String(res.error));
  ok("说明里保留了底层原因（供诊断）", typeof res.error === "string" && res.error.includes("unsupported descriptor version"), String(res.error));
  ok("说明足够短（不再是整条报错糊上去）", typeof res.error === "string" && res.error.length < 400, String(res.error && res.error.length));
  ok(
    "仍通过 strict schema",
    (() => {
      try {
        metricsResultSchema.parse(res);
        return true;
      } catch {
        return false;
      }
    })(),
  );

  rmSync(join(dshHome, "sessions"), { recursive: true, force: true });
}

rmSync(dshHome, { recursive: true, force: true });
console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
