/**
 * 跨会话汇总：把多个会话的单会话账本（lib/fold.js）合成全局指标。
 *
 * 为什么必须自己做：官方 `sessionStats` 与投影 seam 都是**按会话**的，
 * 「累计总量 / 峰值 / 连续天数」这类**跨会话**指标没有任何官方实现。
 *
 * 本文件全部是纯函数，不依赖 DSH，可离线测试。
 * 5 张卡片的计算口径（已与用户确认）：
 *   1 累计 Token 数   = Σ(全部会话的 totals.total)
 *   2 Token 使用峰值  = max over 本地日历日 的当日总量
 *   3 最长任务用时    = max over 会话 的「最长连续作业段」
 *                        （相邻事件间隔 > 30 分钟即切成新的一段；见 fold.js 的 TASK_GAP_MS）
 *   4 最长连续天数    = 历史最长的「有消耗的本地日历日」连续段
 *   5 当前连续天数    = 从今天（今天无消耗则从昨天）往前数的连续段
 */

import { dayKeyOf, dayNumber, emptyLedger } from './fold.js';

/** 把一条分日记录累加进目标表。 */
function addDay(target, day, rec) {
  const prev = target[day] ?? { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  target[day] = {
    total: prev.total + (rec?.total ?? 0),
    input: prev.input + (rec?.input ?? 0),
    output: prev.output + (rec?.output ?? 0),
    cacheRead: prev.cacheRead + (rec?.cacheRead ?? 0),
    cacheWrite: prev.cacheWrite + (rec?.cacheWrite ?? 0),
    messages: prev.messages + (rec?.messages ?? 0),
  };
}

/** 建一个空的模型聚合桶。 */
function modelBucket(out, key) {
  if (!out.models[key]) out.models[key] = { total: 0, days: {} };
  return out.models[key];
}

/**
 * 合并多个单会话账本 → 全局账本。
 * @param {object[]} ledgers
 * @param {string|null} modelKey 只统计这个 `provider::model`；null = 全部
 *
 * 筛选模式下：`days` / `totals` / `messages` 都来自该模型的**分日明细**（v3 账本），
 * 所以累计、峰值、连续天数、曲线都是真算的；`hours` / `steps` 没有按模型维度保存，
 * 筛选时留空 —— UI 会把这两项标注为「全局」。
 */
export function mergeLedgers(ledgers, modelKey = null) {
  const filtered = typeof modelKey === 'string' && modelKey !== '';
  const out = {
    days: {},
    hours: {},
    models: {},
    totals: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    messages: 0,
    steps: 0,
    sessions: 0,
    first: null,
    last: null,
  };

  for (const led of ledgers) {
    if (!led || typeof led !== 'object') continue;

    if (filtered) {
      const rec = led.models?.[modelKey];
      if (!rec || typeof rec !== 'object') continue; // 这个会话没用过该模型
      out.sessions += 1;
      const agg = modelBucket(out, modelKey);
      for (const [day, dayRec] of Object.entries(rec.days ?? {})) {
        addDay(out.days, day, dayRec);
        addDay(agg.days, day, dayRec);
        out.totals.total += dayRec?.total ?? 0;
        out.totals.input += dayRec?.input ?? 0;
        out.totals.output += dayRec?.output ?? 0;
        out.totals.cacheRead += dayRec?.cacheRead ?? 0;
        out.totals.cacheWrite += dayRec?.cacheWrite ?? 0;
        out.messages += dayRec?.messages ?? 0;
      }
      agg.total += rec.total ?? 0;
      if (typeof led.first === 'number') out.first = out.first === null ? led.first : Math.min(out.first, led.first);
      if (typeof led.last === 'number') out.last = out.last === null ? led.last : Math.max(out.last, led.last);
      continue;
    }

    out.sessions += 1;
    const t = led.totals ?? {};
    out.totals.total += t.total ?? 0;
    out.totals.input += t.input ?? 0;
    out.totals.output += t.output ?? 0;
    out.totals.cacheRead += t.cacheRead ?? 0;
    out.totals.cacheWrite += t.cacheWrite ?? 0;
    out.messages += led.messages ?? 0;
    out.steps += led.steps ?? 0;
    for (const [day, rec] of Object.entries(led.days ?? {})) addDay(out.days, day, rec);
    for (const [h, v] of Object.entries(led.hours ?? {})) out.hours[h] = (out.hours[h] ?? 0) + v;
    for (const [m, rec] of Object.entries(led.models ?? {})) {
      const agg = modelBucket(out, m);
      // v2 旧形状（纯数字）也认，避免旧的离线产物/检查点炸掉
      if (typeof rec === 'number') {
        agg.total += rec;
        continue;
      }
      agg.total += rec?.total ?? 0;
      for (const [day, dayRec] of Object.entries(rec?.days ?? {})) addDay(agg.days, day, dayRec);
    }
    if (typeof led.first === 'number') out.first = out.first === null ? led.first : Math.min(out.first, led.first);
    if (typeof led.last === 'number') out.last = out.last === null ? led.last : Math.max(out.last, led.last);
  }
  return out;
}

/** 有消耗的本地日历日 key（升序）。**只算 total > 0 的天** —— 0 消耗的天不算活跃。 */
export function activeDayKeys(ledger) {
  return Object.entries(ledger.days ?? {})
    .filter(([, rec]) => (rec?.total ?? 0) > 0)
    .map(([day]) => day)
    .sort();
}

/** 历史最长的连续活跃天数。 */
export function longestStreak(dayKeys) {
  const nums = [...new Set(dayKeys.map(dayNumber))].sort((a, b) => a - b);
  let best = 0;
  let run = 0;
  let prev = null;
  for (const n of nums) {
    run = prev !== null && n === prev + 1 ? run + 1 : 1;
    if (run > best) best = run;
    prev = n;
  }
  return best;
}

/**
 * 当前连续天数。
 * 口径：今天有消耗就从今天往前数；今天没有但昨天有，就从昨天往前数（今天还没用不算断）；
 *       昨天也没有则为 0。
 */
export function currentStreak(dayKeys, now = Date.now()) {
  const set = new Set(dayKeys.map(dayNumber));
  const today = dayNumber(dayKeyOf(now));
  let anchor = null;
  if (set.has(today)) anchor = today;
  else if (set.has(today - 1)) anchor = today - 1;
  if (anchor === null) return 0;
  let n = 0;
  while (set.has(anchor - n)) n += 1;
  return n;
}

/**
 * 单个会话的「任务用时」= 最长连续作业段（由 fold 增量维护的 `burstLongestMs`）。
 * ⚠️ 刻意**不用**「末事件 − 首事件」：会话被恢复后会跨天甚至跨周，
 *    实测该口径给出 1367 小时（57 天），完全不是「一次任务用时」。
 */
export function sessionTaskMs(ledger) {
  const v = ledger?.burstLongestMs;
  return typeof v === 'number' && v > 0 ? v : 0;
}

/** 最长任务用时（毫秒）及其所属会话索引。 */
export function longestTask(ledgers) {
  let ms = 0;
  let index = -1;
  ledgers.forEach((led, i) => {
    const v = sessionTaskMs(led);
    if (v > ms) {
      ms = v;
      index = i;
    }
  });
  return { ms, index };
}

/** 当日总量最高的那天（Token 使用峰值）。 */
export function peakDay(ledger) {
  let day = null;
  let total = 0;
  for (const [k, rec] of Object.entries(ledger.days ?? {})) {
    const v = rec?.total ?? 0;
    if (v > total) {
      total = v;
      day = k;
    }
  }
  return { day, total };
}

/** token 用量最高的那个本地小时（Peak hour）。 */
export function peakHour(ledger) {
  let hour = null;
  let total = 0;
  for (const [h, v] of Object.entries(ledger.hours ?? {})) {
    if (v > total) {
      total = v;
      hour = Number(h);
    }
  }
  return { hour, total };
}

/** 用量最高的模型（Favorite model）。`models` 的值 v3 起是 `{total, days}`。 */
export function favoriteModel(ledger) {
  let model = null;
  let total = 0;
  for (const [m, rec] of Object.entries(ledger.models ?? {})) {
    const v = typeof rec === 'number' ? rec : (rec?.total ?? 0);
    if (v > total) {
      total = v;
      model = m;
    }
  }
  return { model, total };
}

/**
 * 由全部会话账本算出 5 张卡片（图一）+ 图二要用的详细指标。
 * @param {object[]} ledgers 每个会话一个账本
 * @param {number} now 当前时间（epoch ms），测试可注入
 * @param {string|null} modelKey 只统计这个 `provider::model`；null = 全部
 *
 * ⚠️ `models`（选择器的目录）**始终是全部模型**，不随筛选变化 ——
 * 否则一旦筛了某个模型，选择器里就只剩它自己，没法切回去。
 */
export function computeMetrics(ledgers, now = Date.now(), modelKey = null) {
  const filtered = typeof modelKey === 'string' && modelKey !== '';
  const global = mergeLedgers(ledgers, filtered ? modelKey : null);
  const activeDays = activeDayKeys(global);
  const peak = peakDay(global);
  const task = longestTask(ledgers);
  const ph = peakHour(global);
  const fav = favoriteModel(global);
  const catalogue = filtered ? mergeLedgers(ledgers).models : global.models;

  return {
    // —— 图一 5 张卡片 ——
    cumulativeTokens: global.totals.total,
    peakDayTokens: peak.total,
    peakDay: peak.day,
    /** 作业段是会话级的，没有模型维度 —— 筛选时它仍是全局值，UI 需标注 */
    longestTaskMs: task.ms,
    longestStreak: longestStreak(activeDays),
    currentStreak: currentStreak(activeDays, now),
    selectedModel: filtered ? modelKey : null,

    // —— 图二 6 个指标（MVP 之后用）——
    sessions: global.sessions,
    messages: global.messages,
    steps: global.steps,
    activeDays: activeDays.length,
    peakHour: ph.hour,
    favoriteModel: fav.model,

    // —— 可视化数据 ——
    totals: global.totals,
    days: global.days,
    hours: global.hours,
    models: catalogue,
    firstActivity: global.first,
    lastActivity: global.last,
  };
}

// —— 展示用格式化（纯函数；client.js 因 bundle 约束无法 import，会各留一份）——

/** 12345678 → '1234.6万'；1234567890 → '12.3亿'。 */
export function formatTokens(n) {
  if (!Number.isFinite(n)) return '0';
  const abs = Math.abs(n);
  if (abs >= 1e8) return `${(n / 1e8).toFixed(1)}亿`;
  if (abs >= 1e4) return `${(n / 1e4).toFixed(1)}万`;
  return String(Math.round(n));
}

/** 毫秒 → '7 小时 34 分' / '34 分' / '不足 1 分'。 */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '0 分';
  const totalMin = Math.floor(ms / 60000);
  if (totalMin < 1) return '不足 1 分';
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return m > 0 ? `${h} 小时 ${m} 分` : `${h} 小时`;
  return `${m} 分`;
}
