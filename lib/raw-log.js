/**
 * 原始会话日志兜底读取（host-only，**不要**被 client.js 引用）。
 *
 * ## 为什么需要它
 *
 * 少数历史会话，`ctx.sessionQuery.readSession()` 会直接拒绝，例如：
 *
 *   failed to read stored session "…": subagent/descriptor 0 uses unsupported
 *   descriptor version 2; source v0 artifact remains unchanged
 *
 * 被拒的是 **descriptor 元数据版本**，而日志正文里的事件形状是兼容的
 * （实测同一份日志：`assistant/message` 带 `data.usage`
 * `{inputTokens, outputTokens, cacheReadTokens, reasoningTokens}`、
 * `data.message.source` 为 `{kind:'model', provider, model}`，与 DSH 读得出来的那些完全一致）。
 *
 * 所以这里自己解多帧 zstd、按 `seq` 取真事件，再交给 lib/fold.js 折叠。
 * 只在 `readSession()` **失败**时使用 —— 它仍然是首选路径，因为它带格式迁移与回放校验。
 *
 * ## 两个必须做对的地方
 *
 * 1. **多帧 zstd**：DSH 的 `session.jsonl.zstd` 是多个 zstd frame 拼接的，
 *    而且里面**不全是事件**（`reasoning-chunks` / `tool-call-chunks` / `text-chunks`
 *    这些流式块没有 `seq`）。直接整文件解压会失败，按行 JSON.parse 又会把流式块当事件。
 * 2. **继承前缀**：fork / 子会话日志开头有一段从父会话复制来的事件，
 *    跨会话累加时必须整段跳过，否则同一笔调用被父子各算一次。
 *    判定规则（= 官方 `SessionLogScan.inheritedEventCount` 的推导）：
 *    取**最后一个带 `{inherited:true}` 的 `session/end-seed`** 的 seq 作为切口，
 *    该 seq 及之前的事件条数就是前缀长度。
 *    ⚠️ 不带 `inherited` 的 `session/end-seed` 是 resume/replay 边界，**不能**当切口。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 逐帧解开拼接的 zstd。
 * 先在 magic 处切分；某段解不开（magic 只是压缩数据里的巧合）就并入下一段重试。
 * @param {Buffer} buf
 * @returns {{ text: string, frames: number, decoded: number }}
 */
export function decompressZstdFrames(buf) {
  if (typeof zstdDecompressSync !== 'function') {
    throw new Error('当前 Node 不支持 zstd（需要 Node 23.8+ 的 zlib.zstdDecompressSync）');
  }
  const cuts = [];
  let i = buf.indexOf(ZSTD_MAGIC, 0);
  while (i >= 0) {
    cuts.push(i);
    i = buf.indexOf(ZSTD_MAGIC, i + 4);
  }
  if (cuts.length === 0) throw new Error('未找到 zstd frame magic');

  const parts = [];
  let pending = null;
  for (let n = 0; n < cuts.length; n += 1) {
    const start = cuts[n];
    const end = n + 1 < cuts.length ? cuts[n + 1] : buf.length;
    const chunk = pending ? Buffer.concat([pending, buf.subarray(start, end)]) : buf.subarray(start, end);
    try {
      parts.push(zstdDecompressSync(chunk));
      pending = null;
    } catch {
      pending = chunk; // 这个 magic 是巧合，并进下一段
    }
  }
  if (pending) parts.push(zstdDecompressSync(pending));
  return { text: Buffer.concat(parts).toString('utf8'), frames: cuts.length, decoded: parts.length };
}

/**
 * 日志文本 → **真事件**（有 `seq`），按 seq 升序。
 * 流式块与坏行直接丢掉（与 readSession 只给真事件的语义一致）。
 * @param {string} text
 * @returns {object[]}
 */
export function eventsFromLogText(text) {
  const events = [];
  for (const line of text.split('\n')) {
    if (line === '' || line === '\r') continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec && typeof rec.seq === 'number') events.push(rec);
  }
  events.sort((a, b) => a.seq - b.seq);
  return events;
}

/**
 * 继承前缀长度（= 官方 `inheritedEventCount` 的推导规则）。
 * 见文件头第 2 条。
 * @param {object[]} events 已按 seq 升序
 * @returns {number}
 */
export function inheritedCountFromEvents(events) {
  let cut = null;
  for (const ev of events) {
    if (ev.type === 'session/end-seed' && ev.data && ev.data.inherited === true) cut = ev.seq;
  }
  if (cut === null) return 0;
  let n = 0;
  for (const ev of events) if (ev.seq <= cut) n += 1;
  return n;
}

/** 会话日志文件名 → 版本号；`session.jsonl.zstd` 视为 0。 */
const LOG_NAME_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/**
 * 一个会话目录里**权威**的日志文件：版本号最高的那个
 * （低版本是格式迁移留下的历史产物，会重复计）。
 * @returns {{ name: string, version: number } | null}
 */
export function pickLogFile(dir) {
  let best = null;
  let names = [];
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  for (const name of names) {
    const m = LOG_NAME_RE.exec(name);
    if (!m) continue;
    const version = m[1] === undefined ? 0 : Number(m[1]);
    if (best === null || version > best.version) best = { name, version };
  }
  return best;
}

/**
 * 把 cwd 编成 DSH 的会话目录名。
 * 实测：`F:\0dsh\edu-pentest` → `--F-0dsh-edu-pentest--`、`F:\0dsh` → `--F-0dsh--`。
 */
export function encodeWorkspaceDir(cwd) {
  if (typeof cwd !== 'string' || cwd === '') return null;
  return '--' + cwd.replace(/:/g, '').replace(/[\\/]+/g, '-') + '--';
}

/**
 * 定位某个会话的日志文件。
 * 先按 `cwd` 猜目录名（快），猜不中再扫一遍所有工作区目录（会话不过百，很便宜）。
 * @param {string} sessionsRoot `<DSH_HOME>/sessions`
 * @param {string} sessionId
 * @param {string} [cwd] 会话头里的 cwd
 * @returns {string | null}
 */
export function findSessionLogFile(sessionsRoot, sessionId, cwd) {
  const guess = encodeWorkspaceDir(cwd);
  if (guess !== null) {
    const dir = join(sessionsRoot, guess, sessionId);
    const hit = existsSync(dir) ? pickLogFile(dir) : null;
    if (hit) return join(dir, hit.name);
  }

  let workspaces = [];
  try {
    workspaces = readdirSync(sessionsRoot);
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    const dir = join(sessionsRoot, ws, sessionId);
    if (!existsSync(dir)) continue;
    const hit = pickLogFile(dir);
    if (hit) return join(dir, hit.name);
  }
  return null;
}

/**
 * 读一个会话的原始日志。
 * @param {string} file
 * @returns {{ events: object[], inheritedEventCount: number, frames: number }}
 */
export function readSessionLog(file) {
  const buf = readFileSync(file);
  const { text, frames } = decompressZstdFrames(buf);
  const events = eventsFromLogText(text);
  return { events, inheritedEventCount: inheritedCountFromEvents(events), frames };
}
