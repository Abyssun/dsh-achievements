/**
 * `lib/raw-log.js` 冒烟：不需要 DSH。
 *
 * 覆盖的都是「错了就会静默算错数」的点：
 *  - **多帧 zstd**：DSH 的日志是多个 frame 拼接的（实测 471 行 / 315 帧），
 *    而且一个 frame 里可能有多行 —— 必须先把所有帧解出来拼成文本再按行切。
 *  - **非事件过滤**：`reasoning-chunks` / `tool-call-chunks` / `text-chunks` 没有 `seq`，
 *    当事件处理会直接算错。
 *  - **继承前缀**：最后一个带 `{inherited:true}` 的 `session/end-seed` 才是切口；
 *    不带 `inherited` 的是 resume/replay 边界，**不能**当切口（否则会漏算用户自己的用量）。
 *  - **版本选择**：同一目录里 `session.jsonl.zstd` / `.v3.` / `.v4.` 并存时取版本最高的，
 *    取错会重复计。
 *  - **目录名编码**：`F:\0dsh\edu-pentest` ↔ `--F-0dsh-edu-pentest--`。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

const { decompressZstdFrames, eventsFromLogText, inheritedCountFromEvents, pickLogFile, encodeWorkspaceDir, findSessionLogFile, readSessionLog } = await import(
  pathToFileURL(join(pkgRoot, "lib/raw-log.js")).href
);
const { emptyLedger, foldEvents } = await import(pathToFileURL(join(pkgRoot, "lib/fold.js")).href);

const T0 = new Date(2026, 0, 10, 9, 0, 0).getTime();
const MIN = 60_000;

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

/** 每行一个 frame（真实文件就是这样多帧拼接的）。 */
function encodeLog(records, perFrame = 1) {
  const lines = records.map((r) => JSON.stringify(r));
  const frames = [];
  for (let i = 0; i < lines.length; i += perFrame) {
    frames.push(zstdCompressSync(Buffer.from(lines.slice(i, i + perFrame).join("\n") + "\n", "utf8")));
  }
  return Buffer.concat(frames);
}

console.log("=== 1. 多帧 zstd 切分 ===");
{
  const records = [{ type: "session", id: "s1" }, am(1, T0, 100), { type: "text-chunks", data: {} }, am(2, T0 + MIN, 200)];
  const buf = encodeLog(records, 1);
  const { text, frames } = decompressZstdFrames(buf);
  ok("帧数与写入一致", frames === 4, String(frames));
  ok("文本含全部 4 行", text.trim().split("\n").length === 4);
}
{
  // 一个 frame 里塞多行（实测存在），必须把它们拼成文本后再按行切
  const buf = encodeLog([am(1, T0, 100), am(2, T0 + MIN, 200), am(3, T0 + 2 * MIN, 300)], 3);
  const { text, frames } = decompressZstdFrames(buf);
  ok("单帧多行也能解出 3 行", frames === 1 && text.trim().split("\n").length === 3, `frames=${frames}`);
}
{
  let threw = null;
  try {
    decompressZstdFrames(Buffer.from("not zstd at all", "utf8"));
  } catch (e) {
    threw = e;
  }
  ok("不是 zstd 时明确抛错", threw !== null, threw && threw.message);
}

console.log("=== 2. 只取真事件（有 seq）、按 seq 升序、忽略坏行 ===");
{
  const records = [
    am(3, T0 + 2 * MIN, 300), // 故意乱序
    { type: "reasoning-chunks", data: { text: "…" } }, // 无 seq
    { type: "tool-call-chunks", data: {} }, // 无 seq
    am(1, T0, 100),
    { type: "session", id: "s1" }, // 头，无 seq
    am(2, T0 + MIN, 200),
  ];
  const text = records.map((r) => JSON.stringify(r)).join("\n") + "\n{坏 JSON\n";
  const events = eventsFromLogText(text);
  ok("只有 3 条真事件", events.length === 3, String(events.length));
  ok("按 seq 升序", events.map((e) => e.seq).join(",") === "1,2,3", events.map((e) => e.seq).join(","));
  ok("坏 JSON 行被忽略（不抛）", true);
}

console.log("=== 3. 继承前缀判定（算错就会重复计或漏计） ===");
{
  const withSeed = [am(1, T0, 111), { type: "session/end-seed", seq: 2, time: T0, data: { inherited: true } }, am(3, T0 + MIN, 222)];
  ok("带 {inherited:true} 的 end-seed → 跳过 seq<=2 的 2 条", inheritedCountFromEvents(withSeed) === 2, String(inheritedCountFromEvents(withSeed)));

  const plainSeed = [am(1, T0, 111), { type: "session/end-seed", seq: 2, time: T0, data: {} }, am(3, T0 + MIN, 222)];
  ok("不带 inherited 的 end-seed（resume 边界）**不**作为切口", inheritedCountFromEvents(plainSeed) === 0, String(inheritedCountFromEvents(plainSeed)));

  const twoSeeds = [
    am(1, T0, 1),
    { type: "session/end-seed", seq: 2, time: T0, data: { inherited: true } },
    am(3, T0 + MIN, 3),
    { type: "session/end-seed", seq: 4, time: T0 + MIN, data: { inherited: true } },
    am(5, T0 + 2 * MIN, 5),
  ];
  ok("多个 inherited 种子 → 取**最后**一个作切口（跳过 4 条）", inheritedCountFromEvents(twoSeeds) === 4, String(inheritedCountFromEvents(twoSeeds)));

  ok("没有种子 → 0", inheritedCountFromEvents([am(1, T0, 1)]) === 0);
}

console.log("=== 4. 端到端：读原始日志 → 折叠 ===");
{
  const events = [
    am(1, T0, 111),
    { type: "session/end-seed", seq: 2, time: T0, data: { inherited: true } },
    am(3, T0 + MIN, 222),
    { type: "step/end", seq: 4, time: T0 + MIN, data: {} },
  ];
  const buf = encodeLog(events, 1);
  const tmp = mkdtempSync(join(tmpdir(), "rawlog-"));
  const file = join(tmp, "session.jsonl.zstd");
  writeFileSync(file, buf);

  const { events: parsed, inheritedEventCount, frames } = readSessionLog(file);
  ok("解出 4 条真事件", parsed.length === 4, String(parsed.length));
  ok("继承前缀 = 2", inheritedEventCount === 2, String(inheritedEventCount));
  ok("帧数上报", frames === 4, String(frames));

  const ledger = foldEvents(parsed, emptyLedger(inheritedEventCount));
  ok("只算自己的 222（前缀 111 被跳过）", ledger.totals.total === 222, String(ledger.totals.total));
  ok("steps 计到 1", ledger.steps === 1, String(ledger.steps));

  rmSync(tmp, { recursive: true, force: true });
}

console.log("=== 5. 版本选择（取最高版本，避免重复计） ===");
{
  const tmp = mkdtempSync(join(tmpdir(), "rawlog-"));
  writeFileSync(join(tmp, "session.jsonl.zstd"), encodeLog([am(1, T0, 1)]));
  writeFileSync(join(tmp, "session.v3.jsonl.zstd"), encodeLog([am(1, T0, 3)]));
  writeFileSync(join(tmp, "session.v4.jsonl.zstd"), encodeLog([am(1, T0, 4)]));
  const hit = pickLogFile(tmp);
  ok("选 v4", hit && hit.name === "session.v4.jsonl.zstd" && hit.version === 4, JSON.stringify(hit));
  rmSync(tmp, { recursive: true, force: true });

  const empty = mkdtempSync(join(tmpdir(), "rawlog-"));
  ok("目录里没有日志 → null", pickLogFile(empty) === null);
  ok("目录不存在 → null（不抛）", pickLogFile(join(empty, "nope")) === null);
  rmSync(empty, { recursive: true, force: true });
}

console.log("=== 6. 工作区目录名编码（实测值） ===");
{
  ok("F:\\0dsh\\edu-pentest → --F-0dsh-edu-pentest--", encodeWorkspaceDir("F:\\0dsh\\edu-pentest") === "--F-0dsh-edu-pentest--", encodeWorkspaceDir("F:\\0dsh\\edu-pentest"));
  ok("F:\\0dsh → --F-0dsh--", encodeWorkspaceDir("F:\\0dsh") === "--F-0dsh--", encodeWorkspaceDir("F:\\0dsh"));
  ok("空 cwd → null", encodeWorkspaceDir("") === null);
}

console.log("=== 7. 定位日志文件（cwd 快路径 + 扫描兜底） ===");
{
  const root = mkdtempSync(join(tmpdir(), "sessions-"));
  const id = "1117a871-ddd9-48c2-891f-d59176db54a5";
  const dir = join(root, "--F-0dsh-edu-pentest--", id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "session.jsonl.zstd"), encodeLog([am(1, T0, 42)]));

  const byCwd = findSessionLogFile(root, id, "F:\\0dsh\\edu-pentest");
  ok("按 cwd 猜目录名找到", byCwd === join(dir, "session.jsonl.zstd"), String(byCwd));

  const byScan = findSessionLogFile(root, id, "Z:\\wrong\\cwd");
  ok("cwd 不对时扫描兜底也能找到", byScan === join(dir, "session.jsonl.zstd"), String(byScan));

  ok("不存在的会话 → null", findSessionLogFile(root, "no-such-id", "F:\\0dsh") === null);

  const { events } = readSessionLog(byCwd);
  ok("通过定位到的文件能折叠出 42", foldEvents(events, emptyLedger(0)).totals.total === 42);

  rmSync(root, { recursive: true, force: true });
}

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
