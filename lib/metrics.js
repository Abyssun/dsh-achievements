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
 *   3 最长任务用时    = max over 会话 (末事件时间 − 首事件时间)
 *   4 最长连续天数    = 历史最长的「有消耗的本地日历日」连续段
 *   5 当前连续天数    = 从今天（今天无消耗则从昨天）往前数的连续段
 */

import { dayKeyOf, dayNumber, emptyLedger } from './fold.js';

/** 合并多个单会话账本 → 全局账本。 */
export function mergeLedgers(ledgers) {
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
    out.sessions += 1;
    const t = led.totals ?? {};
    out.totals.total += t.total ?? 0;
    out.totals.input += t.input ?? 0;
    out.totals.output += t.output ?? 0;
    out.totals.cacheRead += t.cacheRead ?? 0;
    out.totals.cacheWrite += t.cacheWrite ?? 0;
    out.messages += led.messages ?? 0;
    out.steps += led.steps ?? 0;
    for (const [day, rec] of Object.entries(led.days ?? {})) {
      const prev = out.days[day] ?? { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
      out.days[day] = {
        total: prev.total + (rec.total ?? 0),
        input: prev.input + (rec.input ?? 0),
        output: prev.output + (rec.output ?? 0),
        cacheRead: prev.cacheRead + (rec.cacheRead ?? 0),
        cacheWrite: prev.cacheWrite + (rec.cacheWrite ?? 0),
        messages: prev.messages + (rec.messages ?? 0),
      };
    }
    for (const [h, v] of Object.entries(led.hours ?? {})) out.hours[h] = (out.hours[h] ?? 0) + v;
    for (const [m, v] of Object.entries(led.models ?? {})) out.models[m] = (out.models[m] ?? 0) + v;
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

/** 单个会话的任务用时（末事件 − 首事件）；不足两个事件时按 0 计。 */
export function sessionTaskMs(ledger) {
  const { first, last } = ledger ?? {};
  if (typeof first !== 'number' || typeof last !== 'number') return 0;
  return Math.max(0, last - first);
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

/** 用量最高的模型（Favorite model）。 */
export function favoriteModel(ledger) {
  let model = null;
  let total = 0;
  for (const [m, v] of Object.entries(ledger.models ?? {})) {
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
 */
export function computeMetrics(ledgers, now = Date.now()) {
  const global = mergeLedgers(ledgers);
  const activeDays = activeDayKeys(global);
  const peak = peakDay(global);
  const task = longestTask(ledgers);
  const ph = peakHour(global);
  const fav = favoriteModel(global);

  return {
    // —— 图一 5 张卡片 ——
    cumulativeTokens: global.totals.total,
    peakDayTokens: peak.total,
    peakDay: peak.day,
    longestTaskMs: task.ms,
    longestStreak: longestStreak(activeDays),
    currentStreak: currentStreak(activeDays, now),

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
    models: global.models,
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
