/**
 * installer 纯逻辑回归（design-hi-monorepo-split §4 单测锚：幂等替换、清单解析）。
 * 零 mock：真实 tmp 目录 + 真实 tar/npm 子进程（与根仓测试规范同族）。
 * 涉及真实 pi 的探针测试走 e2e 手验（A2/A3），不进单测。
 */

import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  atomicReplaceDir,
  copyDirFiltered,
  extractTarball,
  parseArgs,
  readPkgVersion,
  resolveTargetDir,
  writeManifest,
} from "../installer/core.mjs";

const execFileP = promisify(execFile);
let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "pi-cw-ext-test-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe("parseArgs", () => {
  it("解析 install 子命令与各 flag", () => {
    const opts = parseArgs([
      "install",
      "--agent-dir",
      "/tmp/x",
      "--profile",
      "controlled",
      "--ask-user-source",
      "path",
      "--ask-user-path",
      "/src/ask-user",
      "--pi-bin",
      "/usr/local/bin/pi",
      "--timeout-ms",
      "5000",
    ]);
    expect(opts.command).toBe("install");
    expect(opts.agentDir).toBe("/tmp/x");
    expect(opts.profile).toBe("controlled");
    expect(opts.askUserSource).toBe("path");
    expect(opts.askUserPath).toBe("/src/ask-user");
    expect(opts.piBin).toBe("/usr/local/bin/pi");
    expect(opts.timeoutMs).toBe(5000);
  });

  it("缺省 = main profile + PATH pi + 120s 探针超时", () => {
    const opts = parseArgs(["install"]);
    expect(opts.profile).toBe("main");
    expect(opts.piBin).toBe("pi");
    expect(opts.timeoutMs).toBe(120_000);
  });

  it("非法 profile / ask-user-source 拒绝", () => {
    expect(() => parseArgs(["install", "--profile", "nope"])).toThrow(/profile/);
    expect(() => parseArgs(["install", "--ask-user-source", "git"])).toThrow(/ask-user-source/);
  });
});

describe("resolveTargetDir", () => {
  it("main → <home>/.pi/agent；controlled → <home>/.cw/agent-dir；--agent-dir 覆盖", () => {
    const home = "/home/tester";
    expect(resolveTargetDir({ profile: "main", agentDir: undefined }, home)).toBe(
      path.join(home, ".pi", "agent"),
    );
    expect(resolveTargetDir({ profile: "controlled", agentDir: undefined }, home)).toBe(
      path.join(home, ".cw", "agent-dir"),
    );
    expect(resolveTargetDir({ profile: "main", agentDir: "rel/dir" }, home)).toBe(
      path.resolve("rel/dir"),
    );
  });
});

describe("atomicReplaceDir（幂等替换）", () => {
  it("重复替换无旧版本残留", async () => {
    const dest = path.join(workDir, "atomic", "pkg");
    const src1 = path.join(workDir, "atomic", "v1");
    const src2 = path.join(workDir, "atomic", "v2");
    await mkdir(path.join(src1, "old-asset"), { recursive: true });
    await writeFile(path.join(src1, "old-asset", "stale.txt"), "v1");
    await mkdir(src2, { recursive: true });
    await writeFile(path.join(src2, "index.ts"), "v2");

    await atomicReplaceDir(src1, dest);
    await expect(stat(path.join(dest, "old-asset", "stale.txt"))).resolves.toBeTruthy();

    await atomicReplaceDir(src2, dest); // 第二次：旧内容应被整体替换
    await expect(readFile(path.join(dest, "index.ts"), "utf8")).resolves.toBe("v2");
    await expect(stat(path.join(dest, "old-asset"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("copyDirFiltered", () => {
  it("跳过 node_modules / .git / .tmp*", async () => {
    const src = path.join(workDir, "copysrc");
    await mkdir(path.join(src, "node_modules", "dep"), { recursive: true });
    await mkdir(path.join(src, ".git"), { recursive: true });
    await mkdir(path.join(src, ".tmp-stage"), { recursive: true });
    await mkdir(path.join(src, "src"), { recursive: true });
    await writeFile(path.join(src, "package.json"), "{}");
    await writeFile(path.join(src, "src", "index.ts"), "x");
    const dest = path.join(workDir, "copydest");
    await copyDirFiltered(src, dest);
    await expect(readFile(path.join(dest, "package.json"), "utf8")).resolves.toBe("{}");
    await expect(stat(path.join(dest, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(dest, ".git"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(path.join(dest, ".tmp-stage"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("tarball 解包 + 清单解析", () => {
  it("extractTarball 去 package/ 顶层；readPkgVersion 抽 name/version", async () => {
    const pkgDir = path.join(workDir, "tarball-src", "package");
    await mkdir(pkgDir, { recursive: true });
    await writeFile(
      path.join(pkgDir, "package.json"),
      JSON.stringify({ name: "@zhushanwen/fake", version: "9.9.9" }),
    );
    const tarball = path.join(workDir, "tarball-src", "fake.tgz");
    await execFileP("tar", ["-czf", tarball, "-C", path.dirname(pkgDir), "package"]);
    const dest = path.join(workDir, "tarball-out");
    await extractTarball(tarball, dest);
    await expect(readPkgVersion(dest)).resolves.toEqual({
      name: "@zhushanwen/fake",
      version: "9.9.9",
    });
  });

  it("readPkgVersion 拒缺 name/version 与缺文件", async () => {
    const bad = path.join(workDir, "bad-pkg");
    await mkdir(bad, { recursive: true });
    await writeFile(path.join(bad, "package.json"), JSON.stringify({ name: "x" }));
    await expect(readPkgVersion(bad)).rejects.toThrow(/name\/version/);
    await expect(readPkgVersion(path.join(workDir, "no-such"))).rejects.toThrow();
  });
});

describe("writeManifest（清单合并）", () => {
  it("首写创建、重写合并保留既有包条目", async () => {
    const dir = path.join(workDir, "manifest-dir");
    const m1 = await writeManifest(dir, { "@zhushanwen/pi-ask-user": "2.0.0" });
    expect(m1.manifestVersion).toBe(1);
    expect(m1.packages["@zhushanwen/pi-ask-user"]).toBe("2.0.0");
    const m2 = await writeManifest(dir, { "@zhushanwen/other": "1.0.0" });
    expect(m2.packages).toEqual({
      "@zhushanwen/pi-ask-user": "2.0.0",
      "@zhushanwen/other": "1.0.0",
    });
    // 持久化可重读
    const raw = JSON.parse(await readFile(path.join(dir, "manifest.json"), "utf8"));
    expect(raw.packages).toEqual(m2.packages);
  });
});
