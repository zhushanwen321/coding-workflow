/**
 * mx-2 pytest 适配器单测（docs/rewrite/acceptance/mx2-acceptance.md §5 T1-T3）。
 *
 * fixture 全部真实（零 mock）：tmp 建真实 pytest 项目（conftest.py + test 文件），
 * `python3 -m pytest` 真实子进程执行（本机 python3.12 + pytest 8.3.0），stdout
 * 落盘后交 parse——与 py 项目验收的最终形态一致。
 *
 * 实测口径披露（验收文档 §2/§4 与实测语义的两处偏差，按实测实现）：
 *   - `-v` 条目行行尾带 `[NN%]` 进度标记、SKIPPED 带 `(reason)` 尾注——文档
 *     正则的行尾 $ 锚不匹配实测输出，ENTRY_RE 放开尾部；
 *   - 零测试的 pytest 项目实测 exit 5（no tests ran）而非文档预期的 exit 0
 *     ——T3 的「exit 0 + 零条目行」防线锚用 echo 类假命令构造（防线的目标
 *     场景），真实空项目锁定「exit≠0 + 零条目行 → 单条 fail case」。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AcceptanceItem } from "../src/events/types.js";
import { pytestAdapter } from "../src/testrun/pytest.js";
import { nameMatch } from "../src/verify/name-match.js";

const tmpRoot = mkdtempSync(join(tmpdir(), "cw-mx2-pytest-"));

/** conftest.py：真实 pytest 项目的最小配置（声明 tmp 为 rootdir） */
const CONFTEST = "# mx-2 真实 pytest fixture 项目\n";

/** 2 条测试：1 条真实断言通过（函数名含验收 id）+ 1 条真实断言失败 */
const MIXED_TEST = `import pytest

def test_A1_feature_works():
    assert 1 + 1 == 2

def test_feature_broken():
    assert 1 + 1 == 3
`;

/** 真实 skip：@pytest.mark.skip 装饰（T3 的 skipped→fail 口径） */
const SKIP_TEST = `import pytest

@pytest.mark.skip
def test_A1_skipped_case():
    assert True
`;

function acc(id: string, command?: string): AcceptanceItem {
  return { id, core: false, title: "pytest 适配器验收", type: "unit", command, runner: "pytest" };
}

/** tmp 内建真实 pytest 项目（conftest.py + 指定测试文件）并返回项目目录 */
function makeProject(name: string, testSource?: string): string {
  const dir = join(tmpRoot, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "conftest.py"), CONFTEST);
  if (testSource !== undefined) {
    writeFileSync(join(dir, "test_mx2.py"), testSource);
  }
  return dir;
}

/** 真实子进程跑 pytest（cwd = 项目目录），stdout 落盘后返回产物路径与 exitCode */
function runPytest(cwd: string, args: readonly string[]): { out: string; status: number } {
  const res = spawnSync("python3", ["-m", "pytest", ...args], {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });
  if (res.error !== undefined) {
    throw new Error(`python3 -m pytest 无法启动（环境前置：本机须有 python3 + pytest）: ${res.error.message}`);
  }
  const out = join(tmpRoot, `stdout-${Math.random().toString(36).slice(2)}.txt`);
  writeFileSync(out, res.stdout ?? "");
  return { out, status: res.status ?? -1 };
}

afterAll(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("T2 翻译幂等与纪律", () => {
  it("已含全部三 flag 的 command 原样返回（不重复追加）", () => {
    const command = "python3 -m pytest tests/ -v --tb=no -p no:cacheprovider";
    expect(pytestAdapter.translate(acc("A1", command))).toBe(command);
  });

  it("部分 flag 缺失 → 只追加缺失项（幂等）", () => {
    expect(pytestAdapter.translate(acc("A1", "python3 -m pytest tests/"))).toBe(
      "python3 -m pytest tests/ -v --tb=no -p no:cacheprovider",
    );
    expect(pytestAdapter.translate(acc("A1", "python3 -m pytest tests/ -v"))).toBe(
      "python3 -m pytest tests/ -v --tb=no -p no:cacheprovider",
    );
  });

  it("无 command → 默认全量命令（含三 flag）", () => {
    expect(pytestAdapter.translate(acc("A1"))).toBe("python3 -m pytest -v --tb=no -p no:cacheprovider");
  });

  it("translate 后真实跑完 tmp 项目内无 .pytest_cache（对照：不带 flag 会产生）", () => {
    // translate 产物含 -p no:cacheprovider（纪律 flag 的字符串断言）
    const command = pytestAdapter.translate(acc("A1", "python3 -m pytest test_mx2.py"));
    expect(command).toBe("python3 -m pytest test_mx2.py -v --tb=no -p no:cacheprovider");

    // 等价 args 真实跑 translate 后的命令语义：跑完项目内无 .pytest_cache
    const project = makeProject("t2-cache", "def test_ok():\n    assert True\n");
    runPytest(project, ["test_mx2.py", "-v", "--tb=no", "-p", "no:cacheprovider"]);
    expect(existsSync(join(project, ".pytest_cache"))).toBe(false);

    // 对照组：同项目不带 no:cacheprovider 真实产生 .pytest_cache——证明 flag
    // 确实在起作用（环境隔离纪律），而非环境本身不写缓存
    const controlDir = makeProject("t2-cache-control", "def test_ok():\n    assert True\n");
    runPytest(controlDir, ["test_mx2.py", "-v", "--tb=no"]);
    expect(existsSync(join(controlDir, ".pytest_cache"))).toBe(true);
  });
});

describe("T1 真实通过/失败判定（真实 python3 子进程 + tmp pytest 项目）", () => {
  it("1 pass + 1 真实断言失败 → cases 2 条、fail 条 status=fail、exitCode 非 0；id 在测试函数名 → nameMatch 命中", () => {
    const project = makeProject("t1-mixed", MIXED_TEST);
    const { out, status } = runPytest(project, ["test_mx2.py", "-v", "--tb=no", "-p", "no:cacheprovider"]);
    expect(status).toBe(1);

    const report = pytestAdapter.parse(out, status, acc("A1"));
    expect(report.exitCode).toBe(1);
    expect(report.rawPath).toBe(out);
    expect(report.cases).toHaveLength(2);

    const passed = report.cases.filter((c) => c.status === "pass");
    const failed = report.cases.filter((c) => c.status === "fail");
    expect(passed).toHaveLength(1);
    expect(failed).toHaveLength(1);
    // name 是条目行原文：含 file.py::test_name 锚
    expect(passed[0].name).toContain("test_mx2.py::test_A1_feature_works");
    expect(failed[0].name).toContain("test_mx2.py::test_feature_broken");
    // 全部 case 的 id 恒为验收 id（u5 vitest 同构语义）
    expect(report.cases.every((c) => c.id === "A1")).toBe(true);

    // 名字比对：验收 id 出现在测试函数名（snake_case 的 _ 是词边界）→ pass 命中
    const verdict = nameMatch(acc("A1"), report);
    expect(verdict.pass).toBe(true);
  });
});

describe("T3 无区分力防线", () => {
  it("echo ok 类假命令 stdout（exit 0、零条目行）→ parse 抛错且消息含恢复动作", () => {
    const fake = spawnSync("bash", ["-c", "echo ok"], { encoding: "utf8" });
    const out = join(tmpRoot, "t3-echo.txt");
    writeFileSync(out, fake.stdout ?? "");
    expect(fake.status).toBe(0);
    expect(() => pytestAdapter.parse(out, 0, acc("A1"))).toThrow(/零条目行且 exitCode=0.*恢复动作.*pytest/s);
  });

  it("真实零测试 pytest 项目（exit 5、零条目行）→ 单条 fail case（exit≠0 家族语义），不抛错", () => {
    const project = makeProject("t3-empty"); // 只有 conftest.py，无测试文件
    const { out, status } = runPytest(project, ["-v", "--tb=no", "-p", "no:cacheprovider"]);
    expect(status).toBe(5); // pytest no-tests-ran 的 exit code（实测口径，见文件头披露）

    const report = pytestAdapter.parse(out, status, acc("A1"));
    expect(report.exitCode).toBe(5);
    expect(report.cases).toEqual([{ id: "A1", name: "no-results", status: "fail" }]);
  });

  it("真实 @pytest.mark.skip → status=fail（M0 不认 skip 口径）", () => {
    const project = makeProject("t3-skip", SKIP_TEST);
    const { out, status } = runPytest(project, ["test_mx2.py", "-v", "--tb=no", "-p", "no:cacheprovider"]);
    expect(status).toBe(0); // 全 skip 的 pytest 进程级 exit 0——条目级如实折 fail

    const report = pytestAdapter.parse(out, status, acc("A1"));
    expect(report.cases).toHaveLength(1);
    expect(report.cases[0].status).toBe("fail");
    expect(report.cases[0].name).toContain("SKIPPED");
    // 口径后果：全 skip 的验收在 nameMatch 判 fail（skip 无法逃逸验收）
    expect(nameMatch(acc("A1"), report).pass).toBe(false);
  });
});
