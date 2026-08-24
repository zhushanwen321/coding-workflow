import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

/** 与 package.json version 同步维护（jiti 环境下 import json 断言不可靠，硬编码） */
const EXT_VERSION = "0.5.0";

/**
 * pi-cw-runner extension factory（ph-i0 哨兵骨架）。
 *
 * 本波次只验证「安装→loader 发现→jiti 加载」全链：注册哨兵命令 /cw-ping，
 * 输出含固定锚串 `cw-extension-alive`。业务功能（frontier widget / 派发循环
 * 库化接入，D3 A+B）在 ph-i2 交付。
 */
export default function cwRunnerExtension(pi: ExtensionAPI): void {
  pi.registerCommand("cw-ping", {
    description: "Sentinel: verify the coding-workflow extension is loaded (ph-i0).",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      ctx.ui.notify(
        `cw-extension-alive: pi-coding-workflow-extension loaded (${EXT_VERSION})`,
        "info",
      );
    },
  });
}
