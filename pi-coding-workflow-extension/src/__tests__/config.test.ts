/**
 * u-i2-c：配置面解析（R5 最小集）。
 */
import { describe, expect, it } from "vitest";

import { loadRunnerConfig } from "../config.js";

describe("loadRunnerConfig", () => {
  it("默认值：并发 2 / poll 5000 / noClarify false", () => {
    const c = loadRunnerConfig({});
    expect(c).toMatchObject({ maxConcurrency: 2, noClarify: false, pollMs: 5000 });
    expect(c.warnings).toEqual([]);
  });

  it("env 覆盖生效", () => {
    const c = loadRunnerConfig({ CW_RUNNER_MAX_CONCURRENCY: "4", CW_RUNNER_POLL_MS: "250", CW_RUNNER_NO_CLARIFY: "1" });
    expect(c).toMatchObject({ maxConcurrency: 4, pollMs: 250, noClarify: true });
  });

  it("非法值回落默认 + warning", () => {
    const c = loadRunnerConfig({ CW_RUNNER_MAX_CONCURRENCY: "abc", CW_RUNNER_POLL_MS: "-1" });
    expect(c.maxConcurrency).toBe(2);
    expect(c.pollMs).toBe(5000);
    expect(c.warnings).toHaveLength(2);
  });
});
