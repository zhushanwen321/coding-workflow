/**
 * scripts/install-skill.sh + scripts/uninstall-skill.sh 分发逻辑测试。
 *
 * 零 mock：child_process 真实执行脚本，目标目录全部由 $HOME 派生，
 * 用临时 HOME 完全隔离（绝不触碰真实 ~/.pi/agent/agents 等用户资产）。
 * 源目录是仓库真实 skills/ + agents/（脚本按 SCRIPT_DIR 派生，不可重定向）。
 *
 * 覆盖 S-3 关键分支：带 .md 后缀 agent symlink 创建（MF-1 回归）、
 * 非 symlink 用户资产保护、悬空 symlink 重建、frontmatter 过滤、uninstall 对称。
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const INSTALL_SCRIPT = join(REPO_ROOT, "scripts", "install-skill.sh");
const UNINSTALL_SCRIPT = join(REPO_ROOT, "scripts", "uninstall-skill.sh");
const AGENT_SOURCE = join(REPO_ROOT, "skills", "tech-design", "agents", "tech-design-review.md");

const AGENT_TARGETS = [".agents/agents", ".pi/agent/agents", ".claude/agents"] as const;
const SKILL_TARGETS = [".agents/skills", ".claude/skills"] as const;

const tmpHomes: string[] = [];

function makeHome(): string {
  const home = mkdtempSync(join(tmpdir(), "cw-skill-install-"));
  tmpHomes.push(home);
  return home;
}

function runScript(script: string, home: string): string {
  return execFileSync("bash", [script], {
    env: { ...process.env, HOME: home },
    encoding: "utf8",
  });
}

function isSymlink(p: string): boolean {
  return lstatSync(p).isSymbolicLink();
}

/** 断言三个 agent 目标目录都装上了带 .md 后缀的 symlink，且不存在无后缀旧坏 symlink（MF-1 回归） */
function expectAgentInstalled(home: string): void {
  for (const base of AGENT_TARGETS) {
    const link = join(home, base, "tech-design-review.md");
    expect(isSymlink(link), `${link} 应为 symlink`).toBe(true);
    expect(realpathSync(link), `${link} 应指向真实源文件`).toBe(realpathSync(AGENT_SOURCE));
    expect(existsSync(join(home, base, "tech-design-review")), `${base} 不应存在无 .md 后缀的旧 symlink`).toBe(false);
  }
}

afterEach(() => {
  for (const home of tmpHomes.splice(0)) {
    rmSync(home, { recursive: true, force: true });
  }
});

describe("install-skill.sh", () => {
  it("把 agent 安装为带 .md 后缀的 symlink（pi agent 发现要求 endsWith .md）", () => {
    const home = makeHome();
    runScript(INSTALL_SCRIPT, home);
    expectAgentInstalled(home);
  });

  it("skill 本体 symlink 到两个 skill 目标目录", () => {
    const home = makeHome();
    runScript(INSTALL_SCRIPT, home);
    for (const base of SKILL_TARGETS) {
      for (const skill of ["cw-cli", "tech-design"]) {
        const link = join(home, base, skill);
        expect(isSymlink(link), `${link} 应为 symlink`).toBe(true);
        expect(realpathSync(link)).toBe(realpathSync(join(REPO_ROOT, "skills", skill)));
      }
    }
  });

  it("保护非 symlink 用户资产：同名实体文件不被覆盖", () => {
    const home = makeHome();
    const link = join(home, ".pi", "agent", "agents", "tech-design-review.md");
    mkdirSync(dirname(link), { recursive: true });
    writeFileSync(link, "user custom agent content\n");
    runScript(INSTALL_SCRIPT, home);
    expect(isSymlink(link)).toBe(false);
    expect(readFileSync(link, "utf8")).toBe("user custom agent content\n");
    // 其余目标目录照常安装
    for (const base of AGENT_TARGETS.filter((b) => b !== ".pi/agent/agents")) {
      expect(isSymlink(join(home, base, "tech-design-review.md"))).toBe(true);
    }
  });

  it("重建悬空 symlink（指向不存在目标的旧链接）", () => {
    const home = makeHome();
    const link = join(home, ".pi", "agent", "agents", "tech-design-review.md");
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(join(home, "nonexistent", "old.md"), link);
    runScript(INSTALL_SCRIPT, home);
    expect(isSymlink(link)).toBe(true);
    expect(realpathSync(link)).toBe(realpathSync(AGENT_SOURCE));
  });

  it("frontmatter 过滤：非 --- 开头的 .md（顶层 agents/README.md）不安装", () => {
    const home = makeHome();
    const readme = join(REPO_ROOT, "agents", "README.md");
    expect(readFileSync(readme, "utf8").startsWith("#")).toBe(true);
    runScript(INSTALL_SCRIPT, home);
    for (const base of AGENT_TARGETS) {
      expect(existsSync(join(home, base, "README.md")), `${base}/README.md 不应安装`).toBe(false);
      // 顶层 agents/ 只有 README.md（被过滤），目录里只应有 tech-design-review.md
      expect(readdirSync(join(home, base)).sort()).toEqual(["tech-design-review.md"]);
    }
  });
});

describe("uninstall-skill.sh", () => {
  it("删除带 .md 后缀的 symlink，保留非 symlink 用户资产", () => {
    const home = makeHome();
    runScript(INSTALL_SCRIPT, home);
    const userAsset = join(home, ".claude", "agents", "user-asset.md");
    writeFileSync(userAsset, "user data\n");
    runScript(UNINSTALL_SCRIPT, home);
    for (const base of AGENT_TARGETS) {
      expect(existsSync(join(home, base, "tech-design-review.md")), `${base} 的 agent symlink 应被删除`).toBe(false);
    }
    expect(readFileSync(userAsset, "utf8")).toBe("user data\n");
    expect(existsSync(join(home, ".agents", "skills", "tech-design"))).toBe(false);
  });
});
