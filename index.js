/**
 * dsh-achievements — Host half.
 *
 * 一个 DSH 正式插件（三件套）的 Host 面：注册 `achievements` 服务，
 * 把「个人成就」需要的跨会话指标聚合出来供浏览器半调用。
 *
 * ## 数据管线
 *
 *   ① 官方投影单元（host-only，不带 wire）
 *      `ctx.sessionProjections.register({ key, stateSchema, init, apply, stateVersion })`
 *      框架负责订阅 `session/event`、按会话维护水位线、把状态写进 `session_projcache`。
 *      `init(header, inheritedEventCount)` 直接拿到继承前缀的精确长度 —— fork/子会话日志
 *      开头那 N 条是父会话的副本，跨会话累加时必须整段跳过（见 docs/05）。
 *
 *   ② 跨会话 rollup（官方没有，本项目独有）
 *      官方的 sessionStats 与投影 seam 都是**按会话**的。
 *      · 活会话：`ctx.sessions.list()` → `registry.stateOf()`（走框架水位线缓存，增量）
 *      · 冷会话：**启动时后台回填**一次 `sessionQuery.readSession()` 并缓存
 *
 *   ③ Typert Remote 把结果发给浏览器半（见 typert.host.js，形状必须逐字段对应）
 *
 * ## ⚠️ 这里曾经有一个致命设计错误（v0.1.3 起修正）
 *
 * 早期版本把「列举 + 逐个 readSession + 折叠」全做在 `getMetrics()` 里面。
 * 95 个会话顺序读取、每个都要解压+校验 → 这个 RPC 几十秒都不返回；而客户端每 30s
 * 又发起一次、还不等上一次结束，于是请求越堆越多，界面永远停在「刷新中…」、数据全 0。
 * **请求路径里绝不能做重量级/不确定的 IO。**
 *
 * 现在：回填在 `[Service.init]` 里后台跑（并发 4、每会话 8s 超时、失败只记账），
 * `getMetrics()` **只读内存**、立刻返回，并用 `ready/collecting/progress/error`
 * 如实上报进度 —— 这样即使没数据，界面也能告诉你卡在哪一步。
 */

import { Remote, TypertRemoteService } from "@deepseek-ai/dsh-typert-protocol";
import { Service } from "@deepseek-ai/cordis";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { applyLedger, emptyLedger, foldEvents, LEDGER_FIELD_VERSION, TASK_GAP_MS } from "./lib/fold.js";
import { computeMetrics } from "./lib/metrics.js";

/** 服务的 Remote 命名空间 / Typert service key。必须与 typert.host.js、client.js 三处一致。 */
const SERVICE_KEY = "achievements";
/** 投影单元的状态键。 */
const PROJECTION_KEY = "dsh-achievements.ledger";
/** 投影状态版本：字段形状或折叠语义一变就要 +1，否则旧检查点会被前滚成垃圾。 */
const PROJECTION_STATE_VERSION = LEDGER_FIELD_VERSION;

/** 单个会话读取的超时：一个坏会话不能拖死整轮回填。可用 DSH_ACH_READ_TIMEOUT_MS 覆盖（测试/调试用）。 */
const READ_TIMEOUT_MS = Number(process.env.DSH_ACH_READ_TIMEOUT_MS || 8000);
/** 回填并发。 */
const BACKFILL_CONCURRENCY = 4;
/** 回填完成后周期性重扫（只为发现新会话，很便宜）。 */
const RESCAN_INTERVAL_MS = 60000;
/** 活会话账本缓存时间，避免每 30s 轮询都重算大日志。 */
const LIVE_TTL_MS = 5000;
/** 等依赖服务到位的兜底上限。 */
const SERVICE_WAIT_MS = 5000;
/** 头像上限：约 512 KB 的 data URL（客户端会先缩到 256×256，正常只有几十 KB）。 */
const AVATAR_MAX_CHARS = 700000;

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const CONFIG_PATH = join(DSH_HOME, "data", "dsh-achievements", "config.json");
const ANONYMOUS_ID_PATH = join(DSH_HOME, ".anonymous-user-id");

/* ======================================================================
 * 投影单元的 stateSchema（注册表只对它调 .parse()）
 * 必须与 lib/fold.js 的 emptyLedger() 形状严格一致。
 * ==================================================================== */

const dayRecordSchema = z.object({
  total: z.number(),
  input: z.number(),
  output: z.number(),
  cacheRead: z.number(),
  cacheWrite: z.number(),
  messages: z.number(),
});

const ledgerSchema = z.object({
  v: z.number(),
  inherited: z.number(),
  seen: z.number(),
  days: z.record(z.string(), dayRecordSchema),
  hours: z.record(z.string(), z.number()),
  /** v3 起：`provider::model` → { total, days: { 'YYYY-MM-DD' → 当日聚合 } } */
  models: z.record(
    z.string(),
    z.object({
      total: z.number(),
      days: z.record(z.string(), dayRecordSchema),
    }),
  ),
  totals: z.object({
    total: z.number(),
    input: z.number(),
    output: z.number(),
    cacheRead: z.number(),
    cacheWrite: z.number(),
  }),
  messages: z.number(),
  steps: z.number(),
  first: z.union([z.number(), z.null()]),
  last: z.union([z.number(), z.null()]),
  burstStart: z.union([z.number(), z.null()]),
  burstLongestMs: z.number(),
});

/* ======================================================================
 * 工具
 * ==================================================================== */

function msg(e) {
  if (e === null || e === undefined) return "unknown";
  if (typeof e === "string") return e;
  return String((e && e.message) || e);
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/** 给 promise 套超时；超时以 reject 暴露，便于记账。 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    if (timer && typeof timer.unref === "function") timer.unref();
    Promise.resolve(promise).then(
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

/**
 * Mark one instance method as a Remote export without relying on decorator
 * syntax (Node ESM does not support the proposal decorators here). We drive
 * the same `Remote(name)` decorator manually through a synthetic decorator
 * context and run the registered initializers against the instance.
 */
function markRemoteMethod(instance, method, exportName) {
  const decorator = Remote(method, undefined);
  const initializers = [];
  decorator(undefined, {
    kind: "method",
    name: method,
    static: false,
    private: false,
    addInitializer: (fn) => initializers.push(fn),
  });
  for (const fn of initializers) fn.call(instance);
}

/**
 * 从一个 `ctx.inject(deps, scope => …)` 的回调 scope 里取服务。
 * 优先 `scope.get()`；有些 cordis 版本直接把服务挂在 scope 上，所以也认属性。
 */
function resolveService(scope, name) {
  if (!scope) return null;
  try {
    if (typeof scope.get === "function") {
      const viaGet = scope.get(name);
      if (viaGet) return viaGet;
    }
  } catch {
    /* 继续尝试属性访问 */
  }
  try {
    return scope[name] || null;
  } catch {
    return null;
  }
}

/** 读 `~/.dsh/.anonymous-user-id`（本机实测是 UUID）。读不到就是 null。 */
function readAnonymousUserId() {
  try {
    const raw = readFileSync(ANONYMOUS_ID_PATH, "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** 读插件自己的配置。兼容旧的 `avatarUrl` 字段名。 */
function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { nickname: null, avatar: null };
    const avatar =
      typeof parsed.avatar === "string" && parsed.avatar !== ""
        ? parsed.avatar
        : typeof parsed.avatarUrl === "string" && parsed.avatarUrl !== ""
          ? parsed.avatarUrl
          : null;
    return {
      nickname: typeof parsed.nickname === "string" && parsed.nickname !== "" ? parsed.nickname : null,
      avatar,
    };
  } catch {
    return { nickname: null, avatar: null };
  }
}

function writeConfig(next) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/** `"provider::model"` → `{ provider, name }`。 */
function splitModelKey(key) {
  const i = key.indexOf("::");
  if (i < 0) return { provider: "", name: key };
  return { provider: key.slice(0, i), name: key.slice(i + 2) };
}

/** 校验头像：允许 http(s) URL 或 data:image/(png|jpeg|webp|gif)。 */
function normalizeAvatar(value) {
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") return { ok: false, reason: "头像必须是字符串或 null" };
  const v = value.trim();
  if (v === "") return { ok: true, value: null };
  if (/^https?:\/\//i.test(v)) {
    if (v.length > 2048) return { ok: false, reason: "头像 URL 过长（>2048）" };
    return { ok: true, value: v };
  }
  if (/^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(v)) {
    if (v.length > AVATAR_MAX_CHARS) {
      return { ok: false, reason: `头像图片过大（${v.length} 字符 > ${AVATAR_MAX_CHARS}），请换更小的图` };
    }
    return { ok: true, value: v };
  }
  return { ok: false, reason: "头像格式不支持（只接受 http(s) URL 或 data:image/png|jpeg|webp|gif）" };
}

/* ======================================================================
 * 服务
 * ==================================================================== */

export class AchievementsService extends TypertRemoteService {
  /** 故意不声明硬依赖：全部通过 ctx.get() / ctx.inject() 软取，缺失时降级。 */
  static inject = [];

  constructor(ctx, config) {
    super(ctx, SERVICE_KEY);
  }

  /**
   * Cordis 类插件初始化：构造之后、服务发布之前。
   * 先把内存状态建齐，后面每步各自 try/catch —— 0.1.7 起激活 reject 会拖垮整个 profile。
   */
  [Service.init]() {
    // —— 状态先行 ——
    this._error = null;
    this._registryReady = false;
    this._disposed = false;

    /** 冷会话账本：sessionId -> ledger（后台回填产物，只增量补新会话）。 */
    this._cold = new Map();
    /** 活会话账本缓存：sessionId -> { ledger, at }。 */
    this._live = new Map();

    /** 回填进度。 */
    this._backfill = {
      startedAt: 0,
      finishedAt: 0,
      done: false,
      total: 0,
      doneCount: 0,
      failed: 0,
      timedOut: 0,
      error: null,
    };
    this._backfillPromise = null;
    this._rescanTimer = null;
    this._lastMs = 0;
    /** 会话查询服务：**必须靠 ctx.inject 拿**（见下方注释） */
    this._query = null;
    /** 活会话列表服务 */
    this._sessions = null;
    /** 等待服务到位期间的兜底定时器 */
    this._waitTimer = null;

    // —— 逐个可选步骤，互不牵连 ——
    try {
      markRemoteMethod(this, "getMetrics", "getMetrics");
    } catch (e) {
      this._error = "getMetrics 未发布: " + msg(e);
    }

    try {
      markRemoteMethod(this, "setProfile", "setProfile");
    } catch (e) {
      this._error = (this._error ? this._error + " | " : "") + "setProfile 未发布: " + msg(e);
    }

    try {
      this.ctx.inject(["sessionProjections"], (scope) => {
        scope.sessionProjections.register({
          key: PROJECTION_KEY,
          stateSchema: ledgerSchema,
          stateVersion: PROJECTION_STATE_VERSION,
          init: (header, inheritedEventCount) => emptyLedger(num(inheritedEventCount)),
          apply: applyLedger,
        });
        this._registryReady = true;
      });
    } catch (e) {
      this._error = (this._error ? this._error + " | " : "") + "投影单元注册失败: " + msg(e);
    }

    try {
      this.ctx.effect(
        () => () => {
          this._disposed = true;
          if (this._rescanTimer) {
            clearInterval(this._rescanTimer);
            this._rescanTimer = null;
          }
          if (this._waitTimer) {
            clearTimeout(this._waitTimer);
            this._waitTimer = null;
          }
          this._cold.clear();
          this._live.clear();
        },
        "dsh-achievements.dispose",
      );
    } catch (e) {
      this._error = (this._error ? this._error + " | " : "") + "disposer 未注册: " + msg(e);
    }

    // ⚠️ 关键（踩过的坑）：`ctx.get("sessionQuery")` 在 [Service.init] 阶段**拿不到**。
    //    插件按顺序加载，`@deepseek-ai/dsh-session-query` 提供服务比我们晚，
    //    而 `ctx.get()` **不会等待**服务出现 —— 于是回填直接报
    //    「sessionQuery 服务不可用」，diagnostics 表现为 listing=1 / cold=0：
    //    只有当前活会话有数据，历史会话一个都没统计到。
    //    `sessions`（由更早加载的 dsh-session 提供）能拿到，差异就来自加载顺序。
    //    `sessionProjections` 一直好用，正因为它是用 ctx.inject 拿的。
    try {
      this.ctx.inject(["sessionQuery"], (scope) => {
        this._query = resolveService(scope, "sessionQuery");
        this._startBackfill();
      });
    } catch (e) {
      this._backfill.error = "sessionQuery 依赖注入失败: " + msg(e);
      this._backfill.done = true;
    }

    // 活会话列表也 inject 一份（dsh-session 通常比我们早，ctx.get 往往也拿得到，双保险）
    try {
      this.ctx.inject(["sessions"], (scope) => {
        this._sessions = resolveService(scope, "sessions");
      });
    } catch {
      /* 拿不到就退化到 ctx.get */
    }

    // 兜底：万一 sessionQuery 始终没出现，别让界面永远停在「正在后台扫描…」
    try {
      this._waitTimer = setTimeout(() => {
        if (this._backfillPromise) return;
        this._backfill.error = "等待 sessionQuery 服务超时（" + SERVICE_WAIT_MS + "ms）：无法列举历史会话";
        this._backfill.done = true;
      }, SERVICE_WAIT_MS);
      if (this._waitTimer && typeof this._waitTimer.unref === "function") this._waitTimer.unref();
    } catch {
      /* 定时器不可用不影响主流程 */
    }
  }

  /** 软取一个服务；缺失返回 null 而不是抛。 */
  _getService(name) {
    try {
      if (typeof this.ctx.get === "function") return this.ctx.get(name) || null;
    } catch {
      /* inject 未声明等情况会抛，按缺失处理 */
    }
    return null;
  }

  /** 当前活会话 id 集合。 */
  _liveIdSet() {
    const ids = new Set();
    try {
      const store = this._sessions || this._getService("sessions");
      const list = store && typeof store.list === "function" ? store.list() || [] : [];
      for (const s of list) {
        const id = (s && s.id) || (s && s.header && s.header.id);
        if (typeof id === "string" && id !== "") ids.add(id);
      }
    } catch {
      /* 没有 sessions 服务也能跑：全部走冷路径 */
    }
    return ids;
  }

  /**
   * 启动后台回填。幂等：依赖注入回调可能触发多次，已经在跑就直接返回。
   * 这是**唯一**做重 IO 的地方，而且它在请求路径之外。
   */
  _startBackfill() {
    if (this._disposed) return;
    if (this._backfillPromise) return;
    if (this._waitTimer) {
      clearTimeout(this._waitTimer);
      this._waitTimer = null;
    }
    this._backfill.done = false;
    this._backfill.error = null;
    try {
      this._backfillPromise = this._backfillAll();
      if (this._backfillPromise && typeof this._backfillPromise.catch === "function") {
        this._backfillPromise.catch((e) => {
          this._backfill.error = "回填异常: " + msg(e);
          this._backfill.done = true;
        });
      }
    } catch (e) {
      this._backfill.error = "回填启动失败: " + msg(e);
      this._backfill.done = true;
    }
  }

  /** 后台回填：把会话逐个读一遍、折叠、缓存。唯一做重 IO 的地方。 */
  async _backfillAll() {
    this._backfill.startedAt = Date.now();

    const query = this._query || this._getService("sessionQuery");
    if (!query || typeof query.listSessions !== "function") {
      this._backfill.error = "sessionQuery 服务不可用（无法列举会话）";
      this._backfill.done = true;
      this._backfill.finishedAt = Date.now();
      return;
    }

    let records = [];
    try {
      records = (await withTimeout(query.listSessions(), 15000, "listSessions")) || [];
    } catch (e) {
      this._backfill.error = "listSessions 失败: " + msg(e);
      this._backfill.done = true;
      this._backfill.finishedAt = Date.now();
      return;
    }

    await this._foldMissing(records, query);

    this._backfill.done = true;
    this._backfill.finishedAt = Date.now();

    // 回填完再起周期性重扫：只为发现**新**会话，通常一次几毫秒。
    try {
      this._rescanTimer = setInterval(() => {
        if (this._disposed) return;
        this._rescan().catch(() => {});
      }, RESCAN_INTERVAL_MS);
      if (this._rescanTimer && typeof this._rescanTimer.unref === "function") this._rescanTimer.unref();
    } catch {
      /* 定时器不可用也不影响已回填的数据 */
    }
  }

  /** 周期性重扫：只补 `_cold` 里还没有、且当前不活的会话。 */
  async _rescan() {
    const query = this._query || this._getService("sessionQuery");
    if (!query || typeof query.listSessions !== "function") return;
    const records = (await withTimeout(query.listSessions(), 15000, "listSessions")) || [];
    await this._foldMissing(records, query);
  }

  /**
   * 对给定列表里「还没折过」的会话做并发折叠。
   *
   * 活会话**也折一份**当兜底：快照里对活会话优先用 `stateOf()`（更新），
   * 并在遍历 `_cold` 时**跳过当前活着的 id**，所以不会重复计。
   * 这样即使某个活会话的 `stateOf()` 抛错/返回空，也还有数据可显示，而不是整块为 0。
   */
  async _foldMissing(records, query) {
    const pending = [];
    for (const rec of records) {
      const id = rec && rec.header && rec.header.id;
      if (typeof id !== "string" || id === "") continue;
      if (this._cold.has(id)) continue;
      pending.push(id);
    }

    this._backfill.total += pending.length;
    if (pending.length === 0) return;

    let cursor = 0;
    const worker = async () => {
      while (cursor < pending.length) {
        if (this._disposed) return;
        const id = pending[cursor++];
        try {
          const snap = await withTimeout(query.readSession(id), READ_TIMEOUT_MS, `readSession(${id})`);
          const events = (snap && snap.events) || [];
          const ledger = foldEvents(events, emptyLedger(num(snap && snap.inheritedEventCount)));
          this._cold.set(id, ledger);
        } catch (e) {
          this._backfill.failed += 1;
          if (msg(e).includes("超时")) this._backfill.timedOut += 1;
          if (!this._backfill.error) this._backfill.error = `readSession(${id}) 失败: ` + msg(e);
        }
        this._backfill.doneCount += 1;
      }
    };

    const workers = Math.max(1, Math.min(BACKFILL_CONCURRENCY, pending.length));
    await Promise.all(Array.from({ length: workers }, worker));
  }

  /** 取活会话账本（带 5s 缓存）。失败返回 null，由调用方回退。 */
  _liveLedger(id, session, registry) {
    const hit = this._live.get(id);
    const now = Date.now();
    if (hit && now - hit.at < LIVE_TTL_MS) return hit.ledger;

    let ledger = null;
    if (registry && typeof registry.stateOf === "function") {
      try {
        ledger = registry.stateOf(session, PROJECTION_KEY) || null;
      } catch {
        ledger = null;
      }
    }
    if (ledger) {
      this._live.set(id, { ledger, at: now });
      return ledger;
    }
    return hit ? hit.ledger : null;
  }

  /**
   * 组织成给客户端看的 wire 值（形状必须与 typert.host.js 的 schema 逐字段一致）。
   * @param {string|null} modelKey 只统计这个 `provider::model`；null = 全部
   */
  _snapshot(modelKey = null) {
    const started = Date.now();
    const liveIds = this._liveIdSet();
    const registry = this._registryReady ? this._getService("sessionProjections") : null;

    const ledgers = [];
    let cold = 0;
    let live = 0;

    // 冷会话（跳过当前已变活的，避免与 stateOf 重复计）
    for (const [id, ledger] of this._cold) {
      if (liveIds.has(id)) continue;
      ledgers.push(ledger);
      cold += 1;
    }

    // 活会话
    try {
      const store = this._sessions || this._getService("sessions");
      const list = store && typeof store.list === "function" ? store.list() || [] : [];
      for (const s of list) {
        const id = (s && s.id) || (s && s.header && s.header.id);
        if (typeof id !== "string" || id === "") continue;
        const ledger = this._liveLedger(id, s, registry);
        if (ledger) {
          ledgers.push(ledger);
          live += 1;
        } else if (this._cold.has(id)) {
          // stateOf 暂时拿不到 → 用回填那份，至少不丢数据
          ledgers.push(this._cold.get(id));
          cold += 1;
        }
      }
    } catch {
      /* 活会话取不到就只报冷会话 */
    }

    const m = computeMetrics(ledgers, Date.now(), modelKey);
    const cfg = readConfig();
    this._lastMs = Date.now() - started;

    return {
      ready: this._backfill.done,
      collecting: !this._backfill.done,
      /** 当前筛选的模型（null = 全部） */
      selectedModel: typeof m.selectedModel === "string" ? m.selectedModel : null,
      progress: {
        done: num(this._backfill.doneCount),
        total: num(this._backfill.total),
        failed: num(this._backfill.failed),
      },
      error: this._backfill.error || this._error,
      generatedAt: Date.now(),
      identity: {
        anonymousUserId: readAnonymousUserId(),
        nickname: cfg.nickname,
        avatar: cfg.avatar,
      },
      cards: {
        cumulativeTokens: num(m.cumulativeTokens),
        peakDayTokens: num(m.peakDayTokens),
        peakDay: typeof m.peakDay === "string" ? m.peakDay : null,
        longestTaskMs: num(m.longestTaskMs),
        longestStreak: num(m.longestStreak),
        currentStreak: num(m.currentStreak),
      },
      details: {
        sessions: num(m.sessions),
        messages: num(m.messages),
        steps: num(m.steps),
        activeDays: num(m.activeDays),
        peakHour: typeof m.peakHour === "number" ? m.peakHour : null,
        favoriteModel: typeof m.favoriteModel === "string" ? m.favoriteModel : null,
      },
      totals: {
        total: num(m.totals.total),
        input: num(m.totals.input),
        output: num(m.totals.output),
        cacheRead: num(m.totals.cacheRead),
        cacheWrite: num(m.totals.cacheWrite),
      },
      days: Object.entries(m.days)
        .map(([date, r]) => ({
          date,
          total: num(r.total),
          input: num(r.input),
          output: num(r.output),
          cacheRead: num(r.cacheRead),
          cacheWrite: num(r.cacheWrite),
          messages: num(r.messages),
        }))
        .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)),
      models: Object.entries(m.models)
        .map(([key, rec]) => {
          const s = splitModelKey(key);
          const total = typeof rec === "number" ? rec : num(rec && rec.total);
          return { key, name: s.name, provider: s.provider, total };
        })
        .sort((a, b) => b.total - a.total),
      meta: {
        gapMs: TASK_GAP_MS,
        stateVersion: PROJECTION_STATE_VERSION,
        registryAvailable: this._registryReady,
        /** sessionQuery 是否已到位（拿不到就说明注入没成功，历史会话统计不到） */
        queryAvailable: this._query !== null,
        listing: num(liveIds.size + this._cold.size),
        cold: num(cold),
        live: num(live),
        failed: num(this._backfill.failed),
        timedOut: num(this._backfill.timedOut),
        snapshotMs: num(this._lastMs),
        backfillMs: num((this._backfill.finishedAt || Date.now()) - (this._backfill.startedAt || Date.now())),
      },
    };
  }

  /* ------------------------------------------------------------ Remote */

  /**
   * 指标快照。**只读内存**，立刻返回 —— 重量级 IO 全在后台回填里。
   *
   * ⚠️⚠️ **必须返回原始值，不要自己套 `{ok, value}` 信封。**
   * 信封是**传输层**加的：官方 `dsh-api-account-controller` 的实现就是
   * `getProfile(client) { return this.ctx.deepseekAccount.getProfile(client); }`，
   * 而它 manifest 里的 `result` schema 描述的正是这个**原始返回值**。
   * 我在这里自己包了一层，客户端于是拿到
   * `{ok:true, value:{ok:true, value:真正的快照}}` —— 每个字段都读不到，
   * 界面表现成「5 张卡片全 0、`截至 Invalid Date`、诊断全是 `?`、**而且不报任何错**」。
   * 失败请直接 `throw`，传输层会转成 `{ok:false, error}`。
   *
   * @param {string|null} model 只统计这个 `provider::model`；null/省略 = 全部
   * @returns {Promise<object>} 原始快照
   */
  async getMetrics(model) {
    const modelKey = typeof model === "string" && model !== "" ? model : null;
    try {
      return this._snapshot(modelKey);
    } catch (e) {
      throw new Error("achievements 聚合失败: " + msg(e));
    }
  }

  /**
   * 保存个人资料（昵称 / 头像），落到 `<DSH_HOME>/data/dsh-achievements/config.json`。
   * 头像可以是 http(s) URL，也可以是客户端裁好的 `data:image/...;base64,...`。
   * 同样**返回原始值**（见 getMetrics 的说明）；校验失败直接 throw。
   *
   * @param {{nickname?: string|null, avatar?: string|null}} input
   * @returns {Promise<{saved: boolean, nickname: string|null, avatar: string|null}>}
   */
  async setProfile(input) {
    const patch = input && typeof input === "object" ? input : {};
    const current = readConfig();

    let nickname = current.nickname;
    if (Object.prototype.hasOwnProperty.call(patch, "nickname")) {
      if (patch.nickname === null) nickname = null;
      else if (typeof patch.nickname === "string") {
        const t = patch.nickname.trim();
        nickname = t === "" ? null : t.slice(0, 64);
      }
    }

    let avatar = current.avatar;
    if (Object.prototype.hasOwnProperty.call(patch, "avatar")) {
      const norm = normalizeAvatar(patch.avatar);
      if (!norm.ok) throw new Error(norm.reason);
      avatar = norm.value;
    }

    try {
      writeConfig({ nickname, avatar });
    } catch (e) {
      throw new Error("写入资料失败: " + msg(e));
    }
    return { saved: true, nickname, avatar };
  }
}

export default AchievementsService;
