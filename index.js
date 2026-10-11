/**
 * dsh-achievements — Host half.
 *
 * 一个 DSH 正式插件（三件套）的 Host 面：注册 `achievements` 服务，把「个人成就」
 * 需要的跨会话指标聚合出来供浏览器半调用。
 *
 * 数据管线（与 docs/03、docs/05 的设计一致）：
 *
 *   ① 官方投影单元（host-only，不带 wire）
 *      `ctx.sessionProjections.register({ key, stateSchema, init, apply, stateVersion })`
 *      —— 框架负责订阅 `session/event`、按会话维护水位线、以及把状态写进
 *      `session_projcache` 持久检查点。**我们不自己实现去重与落盘。**
 *      `init(header, inheritedEventCount)` 直接拿到继承前缀的精确长度：
 *      fork/子会话日志开头那 N 条是父会话的副本，跨会话累加时必须整段跳过，
 *      否则同一笔模型调用会被父子各算一次（详见 docs/05）。
 *
 *   ② 跨会话 rollup（本项目独有，官方没有）
 *      官方的 sessionStats 与投影 seam 都是**按会话**的。累计总量 / 峰值 /
 *      连续天数这类指标只能自己汇总：
 *        - 活会话：`ctx.sessions.list()` 拿到 live Session → `registry.stateOf()`
 *                  （走框架的水位线缓存，增量、便宜）
 *        - 冷会话：`ctx.sessionQuery.readSession(id)` 拿到
 *                  `{ session, inheritedEventCount, events }` → 自己折叠一次并缓存
 *                  （冷日志不会再增长，所以缓存永不失效；一旦它变活就切到 ①）
 *
 *   ③ Typert Remote 把结果发给浏览器半（见 typert.host.js，形状必须逐字段对应）。
 *
 * 契约来源（均为实测，不是推测）：
 *   - `SessionLogSnapshot = { session, inheritedEventCount, events }`
 *     （dsh-session-query/lib/types/types.d.ts:34-41）
 *   - `SessionRecord = { header, live, persisted }`（同文件:14-21）
 *   - `ctx.sessions.list(): Session[]`（dsh-session/lib/types/index.d.ts:26, :424）
 *   - 投影注册表只对 stateSchema 调 `.parse()`（dsh-session-projection/lib/index.js:255,297）
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

const DSH_HOME = process.env.DSH_HOME || join(homedir(), ".dsh");
const CONFIG_PATH = join(DSH_HOME, "data", "dsh-achievements", "config.json");
const ANONYMOUS_ID_PATH = join(DSH_HOME, ".anonymous-user-id");

/* ======================================================================
 * 投影单元的 stateSchema
 *
 * 注册表只对这个 schema 调 `.parse()`（冷启动恢复检查点时 / 读快照时各一次），
 * 用来挡住被前滚的坏数据。它必须与 lib/fold.js 的 emptyLedger() 形状严格一致。
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
  models: z.record(z.string(), z.number()),
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
 * 小工具
 * ==================================================================== */

/** 把任意抛出物压成一行可读文本。 */
function msg(e) {
  if (e === null || e === undefined) return "unknown";
  if (typeof e === "string") return e;
  return String((e && e.message) || e);
}

function num(v) {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Mark one instance method as a Remote export without relying on decorator
 * syntax (Node ESM does not support the proposal decorators here). We drive
 * the same `Remote(name)` decorator manually through a synthetic decorator
 * context and run the registered initializers against the instance.
 *
 * @param {object} instance - live service instance whose prototype is marked.
 * @param {string} method - public instance method name.
 * @param {string} [exportName] - wire export name; defaults to the method name.
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

/** 读 `~/.dsh/.anonymous-user-id`（图一里 `@数字` 的来源）。读不到就是 null。 */
function readAnonymousUserId() {
  try {
    const raw = readFileSync(ANONYMOUS_ID_PATH, "utf8").trim();
    return raw === "" ? null : raw;
  } catch {
    return null;
  }
}

/** 读插件自己的配置（昵称 / 头像）。缺文件或损坏一律当作空配置。 */
function readConfig() {
  try {
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!parsed || typeof parsed !== "object") return { nickname: null, avatarUrl: null };
    return {
      nickname: typeof parsed.nickname === "string" && parsed.nickname !== "" ? parsed.nickname : null,
      avatarUrl: typeof parsed.avatarUrl === "string" && parsed.avatarUrl !== "" ? parsed.avatarUrl : null,
    };
  } catch {
    return { nickname: null, avatarUrl: null };
  }
}

function writeConfig(next) {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2) + "\n", "utf8");
}

/** 从 live Session 上取 id；不同版本可能放在 header.id 或 id 上，两个都试。 */
function idOfSession(session) {
  const a = session && session.id;
  if (typeof a === "string" && a !== "") return a;
  const b = session && session.header && session.header.id;
  if (typeof b === "string" && b !== "") return b;
  return null;
}

/** `"provider::model"` → `{ provider, name }`。 */
function splitModelKey(key) {
  const i = key.indexOf("::");
  if (i < 0) return { provider: "", name: key };
  return { provider: key.slice(0, i), name: key.slice(i + 2) };
}

/* ======================================================================
 * 服务
 * ==================================================================== */

export class AchievementsService extends TypertRemoteService {
  /**
   * 故意**不声明硬依赖**：`sessionProjections` / `sessionQuery` / `sessions` 全部
   * 通过 `ctx.get()` / `ctx.inject()` 软取。缺失时降级成空态而不是让整个 profile 起不来。
   */
  static inject = [];

  constructor(ctx, config) {
    super(ctx, SERVICE_KEY);
  }

  /**
   * Cordis 类插件初始化：构造之后、服务发布之前执行。
   *
   * 容错要求（0.1.7 起）：必需插件激活 reject 会让整个 profile 起不来。
   * 所以**先把内存状态建齐**，后面每一步各自 try/catch，失败只记进 `this._error`，
   * 服务照常注册应答。
   */
  [Service.init]() {
    // —— 状态先行 ——
    this._error = null;
    /** 投影单元是否注册成功。 */
    this._registryReady = false;
    /** 冷会话账本缓存：sessionId -> ledger（冷日志不再增长，故不会失效）。 */
    this._cold = new Map();
    /** 最近一次 rollup 结果与时间。 */
    this._last = null;
    this._lastAt = 0;

    // —— 逐个可选步骤，互不牵连 ——
    try {
      markRemoteMethod(this, "getMetrics", "getMetrics");
    } catch (e) {
      this._error = "getMetrics 未发布: " + msg(e);
    }

    try {
      markRemoteMethod(this, "setProfile", "setProfile");
    } catch (e) {
      this._error = "setProfile 未发布: " + msg(e);
    }

    // 注册投影单元。`ctx.inject` 让这段注册成为可选项：没有投影注册表的部署
    // 不会因此挂掉，只是退化成「冷会话自折叠」这一条路径。
    try {
      this.ctx.inject(["sessionProjections"], (scope) => {
        scope.sessionProjections.register({
          key: PROJECTION_KEY,
          stateSchema: ledgerSchema,
          stateVersion: PROJECTION_STATE_VERSION,
          // 官方把 fork 继承前缀的精确长度交给我们（不是我们自己去解析标记）
          init: (header, inheritedEventCount) => emptyLedger(num(inheritedEventCount)),
          // 纯折叠；不感兴趣的事件必须返回同一引用（框架靠 Object.is 省下游工作）
          apply: applyLedger,
        });
        this._registryReady = true;
      });
    } catch (e) {
      this._error = "投影单元注册失败: " + msg(e);
    }

    // 新的会话事件只把缓存置脏；真正的重算推迟到下一次 getMetrics。
    try {
      this.ctx.on("session/event", () => {
        this._lastAt = 0;
      });
    } catch (e) {
      this._error = (this._error ? this._error + " | " : "") + "session/event 监听未注册: " + msg(e);
    }

    // fiber 释放时清干净（这里没有定时器，但保留挂钩以便后续加节流写入）
    try {
      this.ctx.effect(() => () => {
        this._cold.clear();
        this._last = null;
      }, "dsh-achievements.dispose");
    } catch (e) {
      this._error = (this._error ? this._error + " | " : "") + "disposer 未注册: " + msg(e);
    }
  }

  /* ---------------------------------------------------------------- 取数 */

  /**
   * 收集全部会话的账本。
   *
   * 活会话走官方投影（增量、便宜）；冷会话读一次日志自己折叠并缓存。
   * 这两条路径产出的账本形状完全一致，所以后面的汇总不必区分来源。
   *
   * @returns {Promise<{ledgers: object[], stats: object}>}
   */
  async _collectLedgers() {
    const stats = { listing: 0, liveFromRegistry: 0, coldFromLog: 0, liveFallback: 0, failed: 0 };

    const query = this._getService("sessionQuery");
    if (!query || typeof query.listSessions !== "function") {
      throw new Error("sessionQuery 服务不可用（无法列举会话）");
    }

    const records = (await query.listSessions()) || [];
    stats.listing = records.length;

    // 活会话：id -> live Session
    const liveById = new Map();
    try {
      const store = this._getService("sessions");
      const list = store && typeof store.list === "function" ? store.list() || [] : [];
      for (const s of list) {
        const id = idOfSession(s);
        if (id) liveById.set(id, s);
      }
    } catch {
      /* 没有 sessions 服务也能跑：活会话退化成冷路径 */
    }

    const registry = this._registryReady ? this._getService("sessionProjections") : null;
    const ledgers = [];

    for (const rec of records) {
      const id = rec && rec.header && rec.header.id;
      if (typeof id !== "string" || id === "") continue;

      // ① 活会话优先走官方投影
      if (registry && typeof registry.stateOf === "function") {
        const live = liveById.get(id);
        if (live) {
          try {
            const led = registry.stateOf(live, PROJECTION_KEY);
            if (led) {
              ledgers.push(led);
              stats.liveFromRegistry += 1;
              continue;
            }
          } catch {
            /* 落到冷路径 */
          }
        }
      }

      // ② 冷会话：读一次、折一次、缓存住
      if (!liveById.has(id)) {
        const cached = this._cold.get(id);
        if (cached) {
          ledgers.push(cached);
          continue;
        }
      }

      try {
        const snap = await query.readSession(id);
        const events = (snap && snap.events) || [];
        // 官方直接给出继承前缀长度；没有该字段时退回 0（宁可多算也不错算）
        const inherited = num(snap && snap.inheritedEventCount);
        const ledger = foldEvents(events, emptyLedger(inherited));
        if (!liveById.has(id)) this._cold.set(id, ledger);
        ledgers.push(ledger);
        stats.coldFromLog += 1;
      } catch {
        // 单个会话读失败不该毁掉整页数字
        stats.failed += 1;
      }
    }

    return { ledgers, stats };
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

  /** 组织成给客户端看的 wire 值（形状必须与 typert.host.js 的 schema 逐字段一致）。 */
  _buildValue(ledgers, stats) {
    const m = computeMetrics(ledgers, Date.now());
    const cfg = readConfig();

    return {
      ready: true,
      error: this._error,
      generatedAt: Date.now(),
      identity: {
        anonymousUserId: readAnonymousUserId(),
        nickname: cfg.nickname,
        avatarUrl: cfg.avatarUrl,
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
        .map(([key, total]) => {
          const s = splitModelKey(key);
          return { key, name: s.name, provider: s.provider, total: num(total) };
        })
        .sort((a, b) => b.total - a.total),
      meta: {
        gapMs: TASK_GAP_MS,
        stateVersion: PROJECTION_STATE_VERSION,
        listing: num(stats.listing),
        liveFromRegistry: num(stats.liveFromRegistry),
        liveFallback: num(stats.liveFallback),
        coldFromLog: num(stats.coldFromLog),
        failed: num(stats.failed),
        registryAvailable: this._registryReady,
      },
    };
  }

  /* ------------------------------------------------------------ Remote */

  /**
   * 全量指标快照（图一 5 张卡片 + 图二详细指标 + 热力图/模型明细）。
   * 内部任何失败都转成业务失败信封，绝不抛到网关上。
   *
   * @returns {Promise<{ok: true, value: object} | {ok: false, error: {code: string, message: string}}>}
   */
  async getMetrics() {
    try {
      const { ledgers, stats } = await this._collectLedgers();
      return { ok: true, value: this._buildValue(ledgers, stats) };
    } catch (e) {
      return { ok: false, error: { code: "achievements_unavailable", message: msg(e) } };
    }
  }

  /**
   * 保存个人资料（昵称 / 头像 URL），落到 `<DSH_HOME>/data/dsh-achievements/config.json`。
   *
   * @param {{nickname?: string|null, avatarUrl?: string|null}} input
   * @returns {Promise<{ok: true, value: {saved: boolean, nickname: string|null, avatarUrl: string|null}} | {ok: false, error: {code: string, message: string}}>}
   */
  async setProfile(input) {
    try {
      const patch = input && typeof input === "object" ? input : {};
      const current = readConfig();
      const next = {
        nickname:
          typeof patch.nickname === "string" && patch.nickname.trim() !== ""
            ? patch.nickname.trim()
            : patch.nickname === null
              ? null
              : current.nickname,
        avatarUrl:
          typeof patch.avatarUrl === "string" && patch.avatarUrl.trim() !== ""
            ? patch.avatarUrl.trim()
            : patch.avatarUrl === null
              ? null
              : current.avatarUrl,
      };
      writeConfig(next);
      return { ok: true, value: { saved: true, nickname: next.nickname, avatarUrl: next.avatarUrl } };
    } catch (e) {
      return { ok: false, error: { code: "profile_write_failed", message: msg(e) } };
    }
  }
}

export default AchievementsService;
