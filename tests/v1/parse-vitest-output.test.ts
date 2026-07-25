/**
 * v1 utils — parseVitestCounts / parseFailedTestNames 纯函数测试。
 *
 * 来源：原 `src/cli.ts` `testRunner.run` 闭包内联解析逻辑（line ~1303-1328）extract 为纯函数后，
 *      补直接单测（之前只能在 gates 层做间接契约测试）。
 *
 * 纯字符串处理，零 IO，零 mock。覆盖正常输出 / 容错（空输入 / 解析不到）/ [REGRESSION] 反证测试。
 */
import { describe, expect, it } from "vitest";

import { parseFailedTestNames, parseVitestCounts } from "../../src/v1/utils/parse-vitest-output.js";

describe("parseVitestCounts", () => {
  it("标准 vitest 输出（Test Files 行 + Tests 行）取 Tests 行用例数（非文件数）", () => {
    const out = [
      "✓ src/a.test.ts (3 tests)",
      "✓ src/b.test.ts (2 tests)",
      "",
      "Test Files  2 passed (2)",
      "     Tests  5 passed (5)",
      "  Start at  ...",
    ].join("\n");
    expect(parseVitestCounts(out)).toEqual({ passedCount: 5, failedCount: 0 });
  });

  it("只有 Tests 行（无 Test Files 行，部分 reporter）→ 取该行的数", () => {
    const out = ["Tests  10 passed (10)", "done"].join("\n");
    expect(parseVitestCounts(out)).toEqual({ passedCount: 10, failedCount: 0 });
  });

  it("带失败（Tests N passed | M failed）→ passed/failed 都取 Tests 行", () => {
    const out = [
      "Test Files  3 passed | 1 failed (4)",
      "     Tests  10 passed | 2 failed (12)",
    ].join("\n");
    expect(parseVitestCounts(out)).toEqual({ passedCount: 10, failedCount: 2 });
  });

  it("[REGRESSION] 936 用例 / 110 文件场景 → passedCount=936（非 110）", () => {
    // 直接复现历史 bug 场景：旧正则贪婪取第一个 match 会拿到文件数 110。
    const out = [
      "Test Files  110 passed (110)",
      "     Tests  936 passed (936)",
    ].join("\n");
    const result = parseVitestCounts(out);
    expect(result.passedCount).toBe(936); // 关键：不是 110
    expect(result.failedCount).toBe(0);
  });

  it("空输出 → { passedCount: 0, failedCount: 0 }", () => {
    expect(parseVitestCounts("")).toEqual({ passedCount: 0, failedCount: 0 });
  });

  it("无 passed/failed 关键字 → { 0, 0 }（容错不抛错）", () => {
    const out = "some random test output\nno counts here";
    expect(parseVitestCounts(out)).toEqual({ passedCount: 0, failedCount: 0 });
  });

  it("只有 failed 计数 → failedCount 正确，passedCount=0", () => {
    const out = "Tests  2 failed (2)";
    expect(parseVitestCounts(out)).toEqual({ passedCount: 0, failedCount: 2 });
  });
});

describe("parseFailedTestNames", () => {
  it("含 `× 测试名` 行 → 抓到测试名（每项 trim）", () => {
    // 正则 `/^[×]\s+(.+)$/gm` 锚定行首（列 0），故 × 行须顶格无缩进。
    // 注意：本输入不含 FAIL 行，避免文件路径被一并抓入（见下条测试）。
    const out = [
      "✓ src/a.test.ts",
      "× should do thing",
      "×   has extra spaces  ",
    ].join("\n");
    expect(parseFailedTestNames(out)).toEqual([
      "should do thing",
      "has extra spaces", // trim 去掉首尾空白
    ]);
  });

  it("含 `FAIL  path` 行 → 抓到文件路径", () => {
    const out = ["FAIL  src/deep/c.test.ts [ src/deep/c.test.ts ]", "passed stuff"].join("\n");
    expect(parseFailedTestNames(out)).toEqual(["src/deep/c.test.ts"]);
  });

  it("两类都有 → 去重合并", () => {
    // 正则 × 行锚定行首（列 0），故 × 行须顶格无缩进。
    // 顺序：先 × 测试名（failNameRe 先跑），再 FAIL 文件路径（failFileRe 后跑），保留首次出现序。
    const out = [
      "FAIL  src/a.test.ts",
      "× should work",
      "× should work", // 重复测试名 → 去重
      "FAIL  src/a.test.ts", // 重复文件路径 → 去重
    ].join("\n");
    expect(parseFailedTestNames(out)).toEqual(["should work", "src/a.test.ts"]);
  });

  it("空输出 → []", () => {
    expect(parseFailedTestNames("")).toEqual([]);
  });

  it("无失败行 → []（容错不抛错）", () => {
    const out = ["✓ src/a.test.ts", "Test Files 1 passed"].join("\n");
    expect(parseFailedTestNames(out)).toEqual([]);
  });
});
