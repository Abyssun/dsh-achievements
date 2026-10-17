/**
 * 兼容门自检：把 `package.json` 声明的版本范围拿去和**真实运行时版本**对一遍。
 *
 * 为什么需要它：DSH 0.2.0 起，安装/启动时会校验 `engines.dsh` 与**全部**
 * `@deepseek-ai/dsh*` peer；任意一条不命中就**拒绝安装并回滚**
 * （实测报错：`Plugin dsh-achievements@0.1.0 is incompatible with dsh 0.2.0-rc.2:
 * peerDependencies {"@deepseek-ai/dsh-typert-protocol":"^0.1.5-rc.2"}`）。
 * 这个失败**语法完全合法**，`npm run check` 抓不住 —— 只能像这样把范围喂给 semver 验。
 *
 * 用法：
 *   node scripts/smoke-compat.mjs                       # 默认检查已知的运行时版本
 *   node scripts/smoke-compat.mjs 0.2.0-rc.2            # 只检查指定版本
 *   DSH_RUNTIME_VERSION=0.2.0-rc.2 node scripts/smoke-compat.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 开发过的运行时版本。
 * 0.1.5-rc.2：早期 npm 目录里那份；0.2.0-rc.2：桌面应用 2026-10-12 那版；
 * 0.2.1-rc.2：桌面应用 2026-10-17 更新后的当前版本。
 */
const DEFAULT_TARGETS = ["0.1.5-rc.2", "0.2.0-rc.2", "0.2.1-rc.2"];

async function importSemver() {
  try {
    return await import("semver");
  } catch {
    /* 落到显式路径 */
  }
  const candidates = [];
  if (process.env.DSH_NODE_MODULES) {
    candidates.push(join(process.env.DSH_NODE_MODULES, "semver", "index.js"));
  }
  candidates.push(join(pkgRoot, "node_modules", "semver", "index.js"));
  const hit = candidates.find((c) => existsSync(c));
  if (hit === undefined) return undefined;
  return import(pathToFileURL(hit).href);
}

const semver = await importSemver();
if (semver === undefined) {
  console.error("smoke:compat — 无法解析 semver（把它装到 ./node_modules，或用 DSH_NODE_MODULES 指向部署的 node_modules）。");
  process.exit(1);
}

const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));
const cliTargets = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const targets = cliTargets.length > 0
  ? cliTargets
  : process.env.DSH_RUNTIME_VERSION
    ? [process.env.DSH_RUNTIME_VERSION]
    : DEFAULT_TARGETS;

/** 兼容门检查的对象：engines.dsh + 所有 @deepseek-ai/dsh* peer。 */
const ranges = [];
if (pkg.engines && typeof pkg.engines.dsh === "string") {
  ranges.push({ what: "engines.dsh", range: pkg.engines.dsh });
} else {
  console.error("smoke:compat — package.json 缺少 engines.dsh");
  process.exit(1);
}
for (const [name, range] of Object.entries(pkg.peerDependencies || {})) {
  if (name.startsWith("@deepseek-ai/dsh")) ranges.push({ what: `peer ${name}`, range });
}

console.log(`smoke:compat — 对 ${targets.length} 个运行时版本检查 ${ranges.length} 条范围`);
for (const r of ranges) console.log(`  · ${r.what.padEnd(46)} ${r.range}`);

let fail = 0;
for (const version of targets) {
  const bad = [];
  for (const r of ranges) {
    // 与 DSH 的兼容门一致：rc 阶段必须带 includePrerelease，否则 0.2.0-rc.2 判不出来
    let okFlag = false;
    try {
      okFlag = semver.satisfies(version, r.range, { includePrerelease: true });
    } catch (e) {
      bad.push(`${r.what} 范围非法（${String((e && e.message) || e)}）`);
      continue;
    }
    if (!okFlag) bad.push(`${r.what} = "${r.range}"`);
  }
  if (bad.length === 0) {
    console.log(`  ✓ dsh ${version} → 全部命中`);
  } else {
    fail += 1;
    console.error(`  ✗ dsh ${version} → 不命中：${bad.join("; ")}`);
    console.error("    该版本上安装会被兼容门拒绝（并回滚）。放宽对应范围后重试。");
  }
}

if (fail > 0) process.exit(1);
console.log(`smoke:compat — OK：${targets.join(", ")} 全部通过。`);
