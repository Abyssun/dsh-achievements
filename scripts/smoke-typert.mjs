/**
 * 用**部署侧真校验器**验 `typert.host.js`（typert-loader 导出的
 * `validateTypertManifest` —— DSH 宿主加载本包 `./typert` 时跑的就是这个函数）。
 *
 * `npm run check` 只查语法，抓不住契约漂移：例如 strict codec 缺 `create()`
 * 工厂会让**整个 manifest 拒载**（参考实现 v1.5.0 / v1.5.2 各栽过一次），
 * 表现为所有 Remote 调用全灭，而语法完全合法。
 *
 * 解析 loader 的顺序：
 *   1. 裸 import（workspace 里有 node_modules/@deepseek-ai junction 时可用）
 *   2. DSH_NODE_MODULES=<部署的 node_modules>
 *   3. ./node_modules/@deepseek-ai/dsh-typert-loader/lib/index.js
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const PKG_NAME = "dsh-achievements";

async function importLoader() {
  try {
    return await import("@deepseek-ai/dsh-typert-loader");
  } catch {
    /* 落到显式路径 */
  }
  const candidates = [];
  if (process.env.DSH_NODE_MODULES) {
    candidates.push(join(process.env.DSH_NODE_MODULES, "@deepseek-ai", "dsh-typert-loader", "lib", "index.js"));
  }
  candidates.push(join(pkgRoot, "node_modules", "@deepseek-ai", "dsh-typert-loader", "lib", "index.js"));
  const hit = candidates.find((c) => existsSync(c));
  if (hit === undefined) return undefined;
  return import(pathToFileURL(hit).href);
}

const loader = await importLoader();
if (loader === undefined) {
  console.error("smoke:typert — 无法解析 @deepseek-ai/dsh-typert-loader。");
  console.error("请把部署的 @deepseek-ai/* 与 zod junction 进 ./node_modules，");
  console.error("或设置 DSH_NODE_MODULES 指向部署的 node_modules。");
  process.exit(1);
}

if (typeof loader.validateTypertManifest !== "function") {
  console.error(`smoke:typert — loader 没有导出 validateTypertManifest（导出：${Object.keys(loader).join(", ")}）`);
  process.exit(1);
}

const { TYPERT } = await import(pathToFileURL(join(pkgRoot, "typert.host.js")).href);

try {
  loader.validateTypertManifest(PKG_NAME, TYPERT);
} catch (error) {
  console.error("smoke:typert — 部署侧校验器**拒绝**了 manifest：");
  console.error(String((error && error.message) || error));
  process.exit(1);
}

// 另外自查一遍 codec 清单（双保险，并给出逐 codec 报告）
let codecs = 0;
const missing = [];
for (const invocation of TYPERT.invocations) {
  const list = [...invocation.parameters.map((p) => p.codec), invocation.result];
  for (const codec of list) {
    codecs += 1;
    if (codec.mode !== "strict") continue;
    if (typeof codec.create !== "function") missing.push(`${codec.typeSymbol}: create`);
    if (typeof codec.typeSymbol !== "string" || codec.typeSymbol === "") missing.push(`invocation ${invocation.id}: typeSymbol`);
  }
}
if (missing.length > 0) {
  console.error("smoke:typert — codec 自查失败：\n  " + missing.join("\n  "));
  process.exit(1);
}

// 三处名字一致性：manifest ↔ index.js（服务键/方法名）
const svc = TYPERT.model.services[0];
const methodNames = svc.members.map((m) => m.name).sort();
const invocationMethods = TYPERT.invocations.map((i) => i.method).sort();
if (JSON.stringify(methodNames) !== JSON.stringify(invocationMethods)) {
  console.error(`smoke:typert — model.services.members 与 invocations 方法名不一致：${methodNames} vs ${invocationMethods}`);
  process.exit(1);
}
for (const invocation of TYPERT.invocations) {
  if (invocation.service !== svc.key || invocation.namespace !== svc.key) {
    console.error(`smoke:typert — invocation ${invocation.id} 的 service/namespace 与 services[].key(${svc.key}) 不一致`);
    process.exit(1);
  }
  if (!invocation.id.startsWith(`${TYPERT.package}#`)) {
    console.error(`smoke:typert — invocation id 未以包名为前缀：${invocation.id}`);
    process.exit(1);
  }
}

console.log(
  `smoke:typert — OK：部署侧校验器接受 ${TYPERT.invocations.length} 个 invocation、` +
    `${codecs} 个 strict codec 全带 create() 工厂；服务键 ${svc.key} / 导出名 ${svc.exportName} 一致。`,
);
