/**
 * 测试环境守卫共享 helper（entry / acceptance-fixes / probe 三处同源）。
 *
 * 为什么静态探测而非 checkSubagentApi 动态 import：守卫只需回答「createSpawnManager
 * 是否在场」。动态 import 真实执行 registry 副本的模块初始化，其依赖链在 Node < 22
 * 上产生 webidl.util.markAsUncloneable unhandled rejection（CI node20 实测，release
 * run 32808200571）——fs 读入口源码匹配导出即可，无任何模块副作用。
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export function staticSubagentApiReady(): boolean {
  try {
    const require = createRequire(import.meta.url);
    const pkgJson = require.resolve("@zhushanwen/pi-subagent-workflow/package.json");
    // 编程 API 在 ./src/index.ts（pi-1 打包实态：包根只 re-export extension default）
    const entry = join(dirname(pkgJson), "src", "index.ts");
    if (!existsSync(entry)) return false;
    return /export.*createSpawnManager|createSpawnManager\s*[,}]/.test(readFileSync(entry, "utf-8"));
  } catch {
    return false;
  }
}
