/**
 * v1 utils — vitest 输出解析纯函数（领域适配器，零 IO）。
 *
 * 来源：原 `src/cli.ts` `testRunner.run` 闭包内联的解析逻辑（line ~1303-1328）。
 *      解析逻辑是独立的领域规则（vitest 默认 reporter 输出格式），不是 CLI 入口逻辑，
 *      故 extract 到 utils 层以便直接单测。
 *
 * 层职责：utils 层放零 IO、零外部依赖的纯字符串处理函数（输出格式适配器 / 解析器）。
 *      不依赖 node 内置模块以外的任何东西，方便纯函数测试。
 *
 * 不变量：本模块所有函数都是纯函数（输入字符串 → 输出，无副作用、无 IO、无外部状态）。
 */
/**
 * 从 vitest 输出解析通过/失败用例计数。
 *
 * [HISTORICAL] vitest 默认 reporter 输出两行带 passed 的：
 *   Test Files  110 passed (110)      ← 文件数
 *   Tests       936 passed | 1 failed ← 用例数
 * 旧正则 /(\d+)\s+passed/ 贪婪匹配第一个（文件数），导致 passedCount=文件数而非用例数，
 * wave test-cases-executed gate 误判（非 manual 用例数 > 文件数时 false-negative）。
 * 修复：matchAll 取最后一个匹配（Tests 行总在 Test Files 行之后）。
 *
 * 容错：解析不到返回 0（不抛错）。
 *
 * @param out vitest 合并输出（stdout + stderr）
 * @returns passedCount/failedCount；解析不到的字段为 0
 */
export function parseVitestCounts(out: string): {
  passedCount: number;
  failedCount: number;
} {
  let passedCount = 0;
  let failedCount = 0;
  const passMatches = [...out.matchAll(/(\d+)\s+passed/g)];
  const failMatches = [...out.matchAll(/(\d+)\s+failed/g)];
  if (passMatches.length > 0)
    passedCount = Number(passMatches[passMatches.length - 1][1]);
  if (failMatches.length > 0)
    failedCount = Number(failMatches[failMatches.length - 1][1]);
  return { passedCount, failedCount };
}

/**
 * 从 vitest 输出解析失败测试名。
 *
 * vitest 默认 reporter 失败行形如 `× 测试名`（测试级）和 `FAIL  path/file.test.ts`（文件级兜底）。
 * 两类合并去重，每项 trim。容错：解析不到返回空数组。
 *
 * @param out vitest 合并输出（stdout + stderr）
 * @returns 去重后的失败测试名 / 文件路径列表（保持首次出现顺序）
 */
export function parseFailedTestNames(out: string): string[] {
  const failedSet = new Set<string>();
  const failNameRe = /^[×]\s+(.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = failNameRe.exec(out)) !== null) {
    failedSet.add(m[1].trim());
  }
  const failFileRe = /^FAIL\s+(\S+)/gm;
  while ((m = failFileRe.exec(out)) !== null) {
    failedSet.add(m[1].trim());
  }
  return [...failedSet];
}
