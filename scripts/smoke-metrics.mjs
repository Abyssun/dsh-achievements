// dsh-achievements 冒烟测试：只测纯逻辑（lib/fold.js + lib/metrics.js），
// **不需要 DSH、不读任何用户数据**，可在任何机器上跑：npm run smoke
//
// 覆盖：计费口径（互斥计数、reasoning 不重复计）、引用恒等契约（框架靠它省下游工作）、
// 本地日历日、连续天数、最长任务用时、5 张卡片汇总、格式化。

import {
  applyLedger,
  dayKeyOf,
  emptyLedger,
  foldEvents,
  LEDGER_FIELD_VERSION,
} from '../lib/fold.js';
import {
  activeDayKeys,
  computeMetrics,
  currentStreak,
  formatDuration,
  formatTokens,
  longestStreak,
  peakDay,
} from '../lib/metrics.js';

let pass = 0;
let fail = 0;

function ok(name, cond, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${name}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${name}${extra === undefined ? '' : `  → ${typeof extra === 'string' ? extra : JSON.stringify(extra)}`}`);
  }
}
function eq(name, actual, expected) {
  ok(name, Object.is(actual, expected), `实际 ${JSON.stringify(actual)} / 期望 ${JSON.stringify(expected)}`);
}

/** 造一个 assistant/message 事件（字段形状照真实日志）。 */
function assistantMessage(seq, time, opts = {}) {
  const {
    provider = 'deepseek-official',
    model = 'deepseek-v4-pro',
    input = 100,
    output = 10,
    cacheRead,
    cacheWrite,
    reasoning,
  } = opts;
  const usage = { inputTokens: input, outputTokens: output };
  if (cacheRead !== undefined) usage.cacheReadTokens = cacheRead;
  if (cacheWrite !== undefined) usage.cacheWriteTokens = cacheWrite;
  if (reasoning !== undefined) usage.reasoningTokens = reasoning;
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider, model }, id: `m${seq}` },
      stream: [],
      usage,
    },
  };
}

/** 会话头（无 seq、无 time）—— 真实日志的第一行。 */
const SESSION_HEADER = { type: 'session', version: 0, id: 's1', createdAt: 1, cwd: 'F:\\x', origin: 'cli' };
/** 流式块（无 seq）—— 真实日志里大量存在，必须被忽略。 */
const CHUNK = { type: 'reasoning-chunks', data: { chunks: [] } };

const T0 = new Date(2026, 0, 10, 9, 0, 0).getTime(); // 2026-01-10 09:00 本地
const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 86400_000;

console.log('=== 1. 计费口径（互斥计数 / reasoning 不重复计） ===');
{
  const led = foldEvents([
    assistantMessage(1, T0, { input: 1000, output: 100, cacheRead: 200, cacheWrite: 50, reasoning: 30 }),
  ]);
  eq('total = input+output+cacheRead+cacheWrite', led.totals.total, 1350);
  eq('input 只计未缓存输入', led.totals.input, 1000);
  eq('cacheRead 单列', led.totals.cacheRead, 200);
  eq('cacheWrite 单列', led.totals.cacheWrite, 50);
  ok('reasoning 不进 total（1350 而非 1380）', led.totals.total !== 1380);
  eq('messages 计数 +1', led.messages, 1);
  eq('账本字段版本', led.v, LEDGER_FIELD_VERSION);
}
{
  const led = foldEvents([assistantMessage(1, T0, { input: 7, output: 3 })]);
  eq('缺失的 cache 字段当 0', led.totals.total, 10);
  eq('缺失字段不产生 NaN', Number.isFinite(led.totals.cacheWrite), true);
}

console.log('=== 2. 引用恒等契约（Object.is → 零下游工作） ===');
{
  const led = foldEvents([assistantMessage(1, T0)]);
  ok('会话头（无 seq）→ 返回同一引用', applyLedger(led, SESSION_HEADER) === led);
  ok('流式块（无 seq）→ 返回同一引用', applyLedger(led, CHUNK) === led);
  const olderToolCall = { type: 'tool/call', seq: 99, time: T0 - HOUR, data: { turn: 1, step: 1, callId: 'c', name: 'x', arguments: '{}' } };
  ok('更早的其它事件 → 返回同一引用', applyLedger(led, olderToolCall) === led);
  const noUsage = { type: 'assistant/message', seq: 5, time: T0 - HOUR, data: { turn: 1, step: 1, message: { source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [] } };
  ok('无 usage 的 assistant/message（更早）→ 返回同一引用', applyLedger(led, noUsage) === led);
  const notModel = { type: 'assistant/message', seq: 6, time: T0 - HOUR, data: { turn: 1, step: 1, message: { source: { kind: 'user' } }, stream: [], usage: { inputTokens: 1, outputTokens: 1 } } };
  ok('source 不是 model → 不计费且返回同一引用', applyLedger(led, notModel) === led);
}
{
  const led = foldEvents([{ type: 'assistant/message', seq: 1, time: T0, data: { message: { source: { kind: 'model', provider: 'p', model: 'm' } }, stream: [], usage: { inputTokens: 5, outputTokens: 5 } } }]);
  eq('缺 provider/model 之外的字段不炸', led.totals.total, 10);
}

console.log('=== 3. 分桶（日历日 / 小时 / 模型） ===');
{
  const day2 = T0 + DAY;
  const led = foldEvents([
    assistantMessage(1, T0, { input: 100, output: 0 }),
    assistantMessage(2, T0 + HOUR, { input: 200, output: 0 }),
    assistantMessage(3, day2, { input: 400, output: 0, model: 'other-model' }),
  ]);
  const d1 = dayKeyOf(T0);
  const d2 = dayKeyOf(day2);
  eq('第一日本地日历日累计', led.days[d1].total, 300);
  eq('第二日单独一桶', led.days[d2].total, 400);
  eq('小时桶按本地小时 9 点（跨天合并：100 + 次日 400）', led.hours['9'], 500);
  eq('小时桶 10 点', led.hours['10'], 200);
  eq('小时桶跨天聚合，不是按日切分', Object.keys(led.hours).length, 2);
  eq('模型桶按 provider::model', led.models['deepseek-official::deepseek-v4-pro'], 300);
  eq('第二个模型单独一桶', led.models['deepseek-official::other-model'], 400);
  eq('首末时间推进', led.last - led.first, DAY);
}
{
  // 本地日历日必须用本地时区，不能用 toISOString（UTC 会错位）
  const localMidnight = new Date(2026, 0, 10, 0, 30, 0).getTime();
  eq('本地日历日 key 用本地时区', dayKeyOf(localMidnight), '2026-01-10');
}

console.log('=== 4. 连续天数 ===');
{
  eq('最长连续：1,2,3,5 → 3', longestStreak(['2026-01-01', '2026-01-02', '2026-01-03', '2026-01-05']), 3);
  eq('最长连续：空 → 0', longestStreak([]), 0);
  eq('最长连续：单日 → 1', longestStreak(['2026-01-01']), 1);
  eq('最长连续：跨月连续 → 3', longestStreak(['2026-01-30', '2026-01-31', '2026-02-01']), 3);
  eq('最长连续：跨年连续 → 2', longestStreak(['2025-12-31', '2026-01-01']), 2);

  const now = new Date(2026, 0, 10, 12, 0, 0).getTime();
  eq('当前连续：今天有 → 含今天', currentStreak(['2026-01-10', '2026-01-09', '2026-01-08'], now), 3);
  eq('当前连续：今天没但昨天有 → 从昨天数', currentStreak(['2026-01-09', '2026-01-08'], now), 2);
  eq('当前连续：今天昨天都没 → 0', currentStreak(['2026-01-08'], now), 0);
  eq('当前连续：中间断掉 → 只数到断点', currentStreak(['2026-01-10', '2026-01-08'], now), 1);
}

console.log('=== 5. 峰值 / 最长任务 / 汇总 ===');
{
  const led = foldEvents([
    assistantMessage(1, T0, { input: 100, output: 0 }),
    assistantMessage(2, T0 + DAY, { input: 900, output: 0 }),
  ]);
  const p = peakDay(led);
  eq('峰值取当日最大', p.total, 900);
  eq('峰值落在第二天', p.day, dayKeyOf(T0 + DAY));
}
{
  // 会话 A：两个事件间隔 10 分钟（< 30 分钟阈值）→ 一段 10 分钟的作业
  // 会话 B：两个事件间隔 1 天（> 阈值）→ 各自成段，每段 0 → 不计
  const a = foldEvents([
    { type: 'user/message', seq: 1, time: T0, data: {} },
    assistantMessage(2, T0 + 10 * MIN, { input: 10, output: 0 }),
  ]);
  const b = foldEvents([
    { type: 'user/message', seq: 1, time: T0, data: {} },
    assistantMessage(2, T0 + DAY, { input: 20, output: 0 }),
  ]);
  const m = computeMetrics([a, b], T0 + 2 * DAY);
  eq('累计 Token 数', m.cumulativeTokens, 30);
  eq('最长任务用时取密集会话的作业段 = 10 分', m.longestTaskMs, 10 * MIN);
  eq('间隔超阈值的会话不计时长（不再给出“跨天”假值）', b.burstLongestMs, 0);
  eq('会话数', m.sessions, 2);
  eq('活跃天数', m.activeDays, 2);
  eq('有消耗的天才算活跃（0 消耗天被排除）', activeDayKeys({ days: { '2026-01-01': { total: 0 }, '2026-01-02': { total: 5 } } }).length, 1);
}
{
  // 空档切分：两段作业取较长的一段
  const dense = foldEvents([
    { type: 'user/message', seq: 1, time: T0, data: {} },
    assistantMessage(2, T0 + 10 * MIN, { input: 10, output: 0 }),
    assistantMessage(3, T0 + 20 * MIN, { input: 10, output: 0 }),
    assistantMessage(4, T0 + 3 * HOUR, { input: 10, output: 0 }),          // 空档 2h40m → 新段
    assistantMessage(5, T0 + 3 * HOUR + 15 * MIN, { input: 10, output: 0 }),
  ]);
  eq('最长作业段 = 两段中较长的 20 分', dense.burstLongestMs, 20 * MIN);
  eq('段内事件间隔按阈值切分', dense.burstStart, T0 + 3 * HOUR);
  const sparse = foldEvents([
    { type: 'user/message', seq: 1, time: T0, data: {} },
    assistantMessage(2, T0 + HOUR, { input: 5, output: 0 }),
  ]);
  eq('两事件间隔 1 小时（> 阈值）→ 0', sparse.burstLongestMs, 0);
  const m2 = computeMetrics([dense, sparse], T0 + 4 * HOUR);
  eq('跨会话取最长任务用时', m2.longestTaskMs, 20 * MIN);
  eq('作业段不影响 token 累计', m2.cumulativeTokens, 45);
}
{
  const led = foldEvents([
    assistantMessage(1, T0, { input: 0, output: 0, cacheRead: 0 }),
  ]);
  const m = computeMetrics([led], T0);
  eq('全 0 用量 → 不算活跃天', m.activeDays, 0);
  eq('全 0 用量 → 当前连续 0', m.currentStreak, 0);
  eq('空账本不产生 NaN', Number.isFinite(m.cumulativeTokens), true);
  const e = computeMetrics([emptyLedger()], T0);
  eq('空账本累计 = 0', e.cumulativeTokens, 0);
  eq('无会话 → 最长任务 0', e.longestTaskMs, 0);
}

console.log('=== 6. 继承前缀（fork 子会话的父会话副本）必须整段跳过 ===');
{
  const evs = [
    assistantMessage(1, T0, { input: 1000, output: 0 }), // 继承来的
    assistantMessage(2, T0 + MIN, { input: 500, output: 0 }), // 继承来的
    assistantMessage(3, T0 + 2 * MIN, { input: 7, output: 3 }), // 本会话自己的
  ];
  const all = foldEvents(evs);
  eq('不跳前缀 → 全部计入（会与父会话重复）', all.totals.total, 1510);
  eq('不跳前缀 → messages 也全算', all.messages, 3);

  const seeded = foldEvents(evs, emptyLedger(2));
  eq('inheritedEventCount=2 → 只算自己的用量', seeded.totals.total, 10);
  eq('inheritedEventCount=2 → 只算自己的消息数', seeded.messages, 1);
  eq('seen 精确停在前缀长度', seeded.seen, 2);
  eq('前缀不影响作业段（时间边界从自己的事件起算）', seeded.first, T0 + 2 * MIN);

  const zero = foldEvents(evs, emptyLedger(0));
  eq('inheritedEventCount=0 等价于不跳', zero.totals.total, 1510);
  const over = foldEvents(evs, emptyLedger(99));
  eq('inherited 超过事件数 → 全部跳过，不报错', over.totals.total, 0);
}

console.log('=== 7. 格式化 ===');
{
  eq('19.5亿', formatTokens(1_950_000_000), '19.5亿');
  eq('1.1亿', formatTokens(110_000_000), '1.1亿');
  eq('万级', formatTokens(12_345), '1.2万');
  eq('小数字原样', formatTokens(842), '842');
  eq('7 小时 34 分', formatDuration((7 * 60 + 34) * 60_000), '7 小时 34 分');
  eq('整点小时', formatDuration(7 * 3600_000), '7 小时');
  eq('不足 1 分', formatDuration(30_000), '不足 1 分');
  eq('0 → 0 分', formatDuration(0), '0 分');
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
