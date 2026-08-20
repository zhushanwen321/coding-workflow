import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { getVersion } from "../src/index.js";

const CLI_PATH = new URL("../dist/cli.js", import.meta.url);

function runCli(args: readonly string[]): { stdout: string; status: number } {
  try {
    const stdout = execFileSync("node", [fileURLToPath(CLI_PATH), ...args], {
      encoding: "utf8",
    });
    return { stdout, status: 0 };
  } catch (error) {
    const err = error as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? "", status: err.status ?? -1 };
  }
}

describe("脚手架冒烟（真实子进程跑 dist/cli.js）", () => {
  it("--help 输出用法且 exit 0", () => {
    const { stdout, status } = runCli(["--help"]);
    expect(status).toBe(0);
    expect(stdout).toContain("Usage: cw <command>");
  });

  it("--version 输出 package.json 版本且 exit 0", () => {
    const { stdout, status } = runCli(["--version"]);
    expect(status).toBe(0);
    expect(stdout.trim()).toBe(getVersion());
  });

  it("未知命令 exit 1 且错误指向 --help", () => {
    const { status } = runCli(["no-such-command"]);
    expect(status).toBe(1);
  });
});
