/**
 * 纯折叠：把一个会话的已提交事件折成「账本」ledger。
 *
 * 契约来自 `@deepseek-ai/dsh-session-projection` 的 `ProjectionDefinition`：
 *  1. **必须同步、纯函数**（异步会撕开 carrier 的一致性切口）；
 *  2. **不感兴趣的事件必须返回同一引用** —— 框架用 `Object.is` 判定「零下游工作」，
 *     返回新对象会让每次无关事件都产生一次 checkpoint 变更；
 *  3. **state 必须是纯 JSON** —— 投影缓存要把它持久化（`ProjectionCheckpointRow.val`）。
 *
 * 事件形状（已用真实会话日志核实，见 tools/inspect-session.mjs）：
 *   SessionEvent = { type, seq, time (epoch 毫秒), data }
 *   'assistant/message'.data = { turn, step, message: { role, content, source, id }, stream, usage?, interrupted? }
 *   usage = { inputTokens, outputTokens, totalTokens?, cacheReadTokens?, cacheWriteTokens?, reasoningTokens? }
 *   message.source = { kind: 'model', provider: '<route id>', model: '<model id>' }
 *
 * ⚠️ 计费语义（dsh-llm TokenUsage 源码注释）：这些计数**互斥** ——
 *   `inputTokens` 只是**未缓存**输入；缓存输入单独报在 cacheRead/cacheWrite。
 *   `计费输入 = inputTokens + cacheReadTokens + cacheWriteTokens`。
 *   `reasoningTokens` 是输出的一部分，**不计入 total，避免重复计数**。
 */

/** 单会话账本的字段版本；改了字段或折叠语义就 +1，否则旧检查点会被前滚成垃圾。 */
export const LEDGER_FIELD_VERSION = 1;

/** 空账本。所有值都是纯 JSON。 */
export function emptyLedger() {
  return {
    v: LEDGER_FIELD_VERSION,
    /** 'YYYY-MM-DD'(本地日历日) → 当日聚合 */
    days: {},
    /** '0'..'23'(本地小时) → token 总量，用于 Peak hour */
    hours: {},
    /** 'provider::model' → token 总量 */
    models: {},
    /** 全会话累计 */
    totals: { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    /** 有 usage 的 assistant/message 数 */
    messages: 0,
    /** 已关闭的步数（权威口径：step/end） */
    steps: 0,
    /** 首/末**真事件**时间（epoch ms），用于「最长任务用时」 */
    first: null,
    last: null,
  };
}

/** 数字兜底：缺失/非法一律当 0。 */
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** 从事件里取模型归属；不是模型产出就返回 null。 */
export function modelOf(event) {
  const src = event?.data?.message?.source;
  if (!src || src.kind !== 'model') return null;
  const provider = typeof src.provider === 'string' ? src.provider : '';
  const model = typeof src.model === 'string' ? src.model : '';
  if (provider === '' && model === '') return null;
  return { provider, model, key: `${provider}::${model}` };
}

/**
 * 本地日历日的 key。
 * ⚠️ 刻意用本地 getFullYear/getMonth/getDate（**不是 UTC**、不用 toISOString），
 *    否则跨时区用户的「今天」会错位，streak 与热力图都会漂。
 */
export function dayKeyOf(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 'YYYY-MM-DD' → 自 epoch 起的**天数序号**（用 UTC 构造规避夏令时导致的 23/25 小时天）。 */
export function dayNumber(dayKey) {
  const [y, m, d] = dayKey.split('-').map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}

/**
 * 折叠一个事件。不改变账本时**返回原引用**。
 * @param {object} state 覆盖此前全部事件的账本
 * @param {object} event 下一个已提交事件
 */
export function applyLedger(state, event) {
  const type = event?.type;
  const time = event?.time;

  // 只有真事件带 time；会话头与流式块（reasoning-chunks 等）没有 seq，此处一并放过。
  if (typeof time !== 'number' || typeof event?.seq !== 'number') return state;

  if (type === 'step/end') {
    return { ...state, steps: state.steps + 1, first: state.first ?? time, last: time };
  }

  if (type !== 'assistant/message') {
    // 其它真事件只推进时间边界（会话首末跨度）。
    if (state.first === null) return { ...state, first: time, last: time };
    if (time > state.last) return { ...state, last: time };
    return state;
  }

  const usage = event.data?.usage;
  const model = modelOf(event);
  // 没有用量（适配器没上报）或不是模型产出 → 只推进时间边界。
  if (!usage || !model) {
    return state.first === null || time > state.last
      ? { ...state, first: state.first ?? time, last: time }
      : state;
  }

  const input = num(usage.inputTokens);
  const output = num(usage.outputTokens);
  const cacheRead = num(usage.cacheReadTokens);
  const cacheWrite = num(usage.cacheWriteTokens);
  const total = input + output + cacheRead + cacheWrite; // reasoning 不重复计入

  const day = dayKeyOf(time);
  const prevDay = state.days[day] ?? { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 };
  const hour = String(new Date(time).getHours());

  return {
    v: state.v,
    days: {
      ...state.days,
      [day]: {
        total: prevDay.total + total,
        input: prevDay.input + input,
        output: prevDay.output + output,
        cacheRead: prevDay.cacheRead + cacheRead,
        cacheWrite: prevDay.cacheWrite + cacheWrite,
        messages: prevDay.messages + 1,
      },
    },
    hours: { ...state.hours, [hour]: (state.hours[hour] ?? 0) + total },
    models: { ...state.models, [model.key]: (state.models[model.key] ?? 0) + total },
    totals: {
      total: state.totals.total + total,
      input: state.totals.input + input,
      output: state.totals.output + output,
      cacheRead: state.totals.cacheRead + cacheRead,
      cacheWrite: state.totals.cacheWrite + cacheWrite,
    },
    messages: state.messages + 1,
    steps: state.steps,
    first: state.first ?? time,
    last: time > (state.last ?? 0) ? time : state.last,
  };
}

/**
 * 把一串事件折成账本（离线/回填用；实时路径由投影框架逐事件驱动 `applyLedger`）。
 * @param {object[]} events 按 seq 升序
 * @param {object} [seed] 从这个账本继续（用于从检查点前滚）
 */
export function foldEvents(events, seed = emptyLedger()) {
  let state = seed;
  for (const ev of events) state = applyLedger(state, ev);
  return state;
}
