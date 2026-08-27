#!/bin/bash
# GP4 探针：测试文件 → import 闭包 依赖图分析
# 复跑：bash docs/rewrite/probes/gp4-import-closure.sh（自包含，不改仓库文件）
# 依赖：仓库 node_modules 内的 typescript（devDependency）
set -e

REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
cd "$REPO_ROOT"

PROBE_DIR="/tmp/gp4-probe-$$"
mkdir -p "$PROBE_DIR"

cat > "$PROBE_DIR/import-closure.cjs" << 'PROBE_SCRIPT'
#!/usr/bin/env node
/**
 * GP4 探针：测试文件 → import 闭包 依赖图分析
 * 三种实现路径对比：tsc API / madge / 轻量正则
 */

const { readFileSync, readdirSync, statSync } = require("node:fs");
const { resolve, relative, dirname, join, extname } = require("node:path");
const { performance } = require("node:perf_hooks");
const { execSync } = require("node:child_process");
const { createRequire } = require("node:module");

const repoRoot = resolve(process.argv[2] || ".");
const tsconfigPath = resolve(repoRoot, "tsconfig.test.json");

// 用仓库内的 typescript
const repoRequire = createRequire(resolve(repoRoot, "package.json"));
let ts;
try {
  ts = repoRequire("typescript");
} catch (e) {
  console.error(`无法加载仓库的 typescript：${e.message}`);
  process.exit(1);
}

// ─── 工具函数 ─────────────────────────────────────────────────

function findTestFiles(root) {
  const testDir = join(root, "tests");
  const results = [];
  function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else if (entry.endsWith(".test.ts")) results.push(full);
    }
  }
  walk(testDir);
  return results.sort();
}

function walkTs(dir, results = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkTs(full, results);
    else if (entry.endsWith(".ts") && !entry.endsWith(".d.ts")) results.push(full);
  }
  return results;
}

function resolveFilePath(candidate) {
  try { statSync(candidate); return candidate; } catch {}
  const ext = extname(candidate);
  const withoutExt = ext ? candidate.slice(0, -ext.length) : candidate;
  for (const tryExt of [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"]) {
    const p = withoutExt + tryExt;
    try { statSync(p); return p; } catch {}
  }
  if (!ext) {
    for (const tryExt of [".ts", ".tsx", ".js", ".jsx", "/index.ts", "/index.js"]) {
      const p = candidate + tryExt;
      try { statSync(p); return p; } catch {}
    }
  }
  return null;
}

function resolveImportPath(importPath, fromFile, tsconfig) {
  if (importPath.startsWith("node:")) return null;
  if (!importPath.startsWith(".")) {
    if (tsconfig.paths) {
      for (const [pattern, mappings] of Object.entries(tsconfig.paths)) {
        const prefix = pattern.replace(/\*$/, "");
        if (importPath.startsWith(prefix)) {
          const suffix = importPath.slice(prefix.length);
          for (const m of mappings) {
            const resolved = m.replace("*", suffix);
            const candidate = resolve(repoRoot, resolved);
            const found = resolveFilePath(candidate);
            if (found) return found;
          }
        }
      }
    }
    return null;
  }
  const base = dirname(fromFile);
  const candidate = resolve(base, importPath);
  return resolveFilePath(candidate);
}

// ─── 路径 A：tsc API ──────────────────────────────────────────

function closureViaTsc(testFile, program, compilerOptions) {
  const sourceFile = program.getSourceFile(testFile);
  if (!sourceFile) return { files: [], error: "sourceFile not found in program" };

  const visited = new Set();
  const queue = [testFile];

  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);

    const sf = program.getSourceFile(current);
    if (!sf) continue;

    function visit(node) {
      if (ts.isImportDeclaration(node) && node.moduleSpecifier) {
        const spec = node.moduleSpecifier.text;
        const resolved = ts.resolveModuleName(spec, current, compilerOptions, ts.sys);
        const resolvedFile = resolved.resolvedModule?.resolvedFileName;
        if (resolvedFile && !resolvedFile.includes("node_modules") && !resolvedFile.endsWith(".d.ts")) {
          if (!visited.has(resolvedFile)) queue.push(resolvedFile);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(sf);
  }
  return { files: [...visited].sort() };
}

// ─── 路径 B：轻量正则 + 手工 resolve ──────────────────────────

function closureViaRegex(testFile, tsconfigObj) {
  const visited = new Set();
  const queue = [testFile];

  while (queue.length > 0) {
    const current = queue.pop();
    if (visited.has(current)) continue;
    visited.add(current);

    let content;
    try { content = readFileSync(current, "utf8"); } catch { continue; }

    const specifiers = new Set();
    const fromRe = /from\s+["']([^"']+)["']/g;
    const bareRe = /import\s+["']([^"']+)["']/g;
    const reqRe = /require\s*\(\s*["']([^"']+)["']\s*\)/g;
    let m;
    while ((m = fromRe.exec(content)) !== null) specifiers.add(m[1]);
    while ((m = bareRe.exec(content)) !== null) specifiers.add(m[1]);
    while ((m = reqRe.exec(content)) !== null) specifiers.add(m[1]);

    for (const specifier of specifiers) {
      const resolved = resolveImportPath(specifier, current, tsconfigObj);
      if (resolved && !visited.has(resolved)) {
        queue.push(resolved);
      }
    }
  }
  return { files: [...visited].sort() };
}

// ─── 主流程 ───────────────────────────────────────────────────

console.log(`\n=== GP4 探针：import 闭包依赖图分析 ===`);
console.log(`仓库：${repoRoot}`);
console.log(`TypeScript 版本：${ts.version}\n`);

const tsconfigContent = readFileSync(tsconfigPath, "utf8");
const tsconfigObj = JSON.parse(tsconfigContent);
const baseTsconfigPath = resolve(repoRoot, tsconfigObj.extends || "tsconfig.json");
const baseTsconfig = JSON.parse(readFileSync(baseTsconfigPath, "utf8"));
const mergedCompilerOptions = { ...baseTsconfig.compilerOptions, ...tsconfigObj.compilerOptions };
const paths = mergedCompilerOptions.paths || {};

const testFiles = findTestFiles(repoRoot);
console.log(`测试文件总数：${testFiles.length}`);
console.log(`tsconfig paths：${Object.keys(paths).length > 0 ? JSON.stringify(paths) : "（无）"}\n`);

// 样本选取
const targetNames = [
  "al-1-nice.test.ts", "dispatch.test.ts", "u2-create.test.ts",
  "wt5-parallel-contamination.test.ts", "fx1-loop-dispatch.test.ts",
  "u4a-verify.test.ts", "gp1-golden-replay.test.ts", "mx5-4-developer-rename.test.ts",
];
const sampleFiles = [
  ...targetNames.map(n => testFiles.find(f => f.endsWith("/" + n))).filter(Boolean),
  testFiles[0],
].filter((v, i, a) => a.indexOf(v) === i).slice(0, 8);

console.log(`样本文件（${sampleFiles.length} 个）：`);
for (const f of sampleFiles) console.log(`  ${relative(repoRoot, f)}`);
console.log();

// ─── 路径 A：tsc API ──────────────────────────────────────────

console.log("--- 路径 A：tsc API（program + ts.resolveModuleName）---");
const tscResults = [];
try {
  const srcFiles = walkTs(resolve(repoRoot, "src"));
  const allEntryFiles = [...testFiles, ...srcFiles];

  const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config, ts.sys, repoRoot, undefined, tsconfigPath
  );

  const t0 = performance.now();
  const program = ts.createProgram(allEntryFiles, { ...parsedConfig.options, noEmit: true });
  const tProgram = performance.now() - t0;
  console.log(`createProgram（${allEntryFiles.length} 入口）耗时：${tProgram.toFixed(0)}ms`);

  for (const tf of sampleFiles) {
    const start = performance.now();
    const result = closureViaTsc(tf, program, parsedConfig.options);
    const elapsed = performance.now() - start;
    const relPath = relative(repoRoot, tf);
    const closureFiles = result.files.map(f => relative(repoRoot, f));
    const srcCount = closureFiles.filter(f => f.startsWith("src/")).length;
    tscResults.push({ file: relPath, total: result.files.length, srcCount, elapsed, files: closureFiles, error: result.error });
    console.log(`  ${relPath} → 闭包 ${result.files.length} 文件（src: ${srcCount}），${elapsed.toFixed(1)}ms${result.error ? " ERR: " + result.error : ""}`);
  }
} catch (e) {
  console.log(`  tsc 错误：${e.message?.slice(0, 300)}`);
  for (const tf of sampleFiles) tscResults.push({ file: relative(repoRoot, tf), error: e.message?.slice(0, 200) });
}

// ─── 路径 B：轻量正则 ─────────────────────────────────────────

console.log("\n--- 路径 B：轻量正则 + 手工 resolve ---");
const regexResults = [];
for (const tf of sampleFiles) {
  const start = performance.now();
  const result = closureViaRegex(tf, { ...mergedCompilerOptions, paths });
  const elapsed = performance.now() - start;
  const relPath = relative(repoRoot, tf);
  const closureFiles = result.files.map(f => relative(repoRoot, f));
  const srcCount = closureFiles.filter(f => f.startsWith("src/")).length;
  regexResults.push({ file: relPath, total: result.files.length, srcCount, elapsed, files: closureFiles });
  console.log(`  ${relPath} → 闭包 ${result.files.length} 文件（src: ${srcCount}），${elapsed.toFixed(1)}ms`);
}

// ─── 交叉对比 ─────────────────────────────────────────────────

console.log("\n--- 交叉对比（tsc vs regex）---");
for (let i = 0; i < sampleFiles.length; i++) {
  const tsc = tscResults[i];
  const regex = regexResults[i];
  if (!tsc || !regex || tsc.error || regex.error) {
    console.log(`  ${tsc?.file || regex?.file}：跳过（错误）`);
    continue;
  }
  const tscSet = new Set(tsc.files);
  const regexSet = new Set(regex.files);
  const onlyInTsc = tsc.files.filter(f => !regexSet.has(f));
  const onlyInRegex = regex.files.filter(f => !tscSet.has(f));
  const match = onlyInTsc.length === 0 && onlyInRegex.length === 0;
  console.log(`  ${tsc.file}：${match ? "一致 ✓" : `差异(tsc多${onlyInTsc.length} regex多${onlyInRegex.length})`}`);
}

// ─── 汇总 ─────────────────────────────────────────────────────

console.log("\n=== 汇总 ===");
const validTsc = tscResults.filter(r => !r.error);
const avgTsc = validTsc.length > 0 ? validTsc.reduce((s, r) => s + r.total, 0) / validTsc.length : 0;
const avgRegex = regexResults.reduce((s, r) => s + r.total, 0) / (regexResults.length || 1);
console.log(`tsc 平均闭包大小：${avgTsc.toFixed(1)} 文件`);
console.log(`regex 平均闭包大小：${avgRegex.toFixed(1)} 文件`);
if (validTsc.length > 0) console.log(`tsc 单文件耗时：${validTsc.map(r => r.elapsed?.toFixed(1) + "ms").join(", ")}`);
console.log(`regex 单文件耗时：${regexResults.map(r => r.elapsed?.toFixed(1) + "ms").join(", ")}`);
console.log(`别名路径：${Object.keys(paths).length > 0 ? "有" : "无"}`);

console.log("\n=== 探针结束 ===");
PROBE_SCRIPT

echo "=== 运行 GP4 探针 ==="
echo "仓库：$REPO_ROOT"
echo "探针脚本：$PROBE_DIR/import-closure.cjs"
echo ""

node "$PROBE_DIR/import-closure.cjs" "$REPO_ROOT"

# 清理
rm -rf "$PROBE_DIR"
