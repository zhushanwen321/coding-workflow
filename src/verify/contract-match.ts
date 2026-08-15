/**
 * 契约机器比对（canon《design-rewrite-architecture.md》§3.3 D6「集成 = 内部节点的
 * verify」：跨节点契约机器比对，签名 ≡ spec 冻结文本；§1.3「机器能验切得闭不闭合
 * 中的契约配对」）。u8 验收文档 docs/rewrite/acceptance/u8-acceptance.md 规格锁定 1。
 *
 * 「纯函数」口径：对同一 (contracts, checkoutDir) 结果恒定——只读文件系统、不写
 * 任何状态、无时间/随机输入（与 nameMatch 的无 IO 纯函数不同，本函数的判定输入
 * 就是 checkout 树的文件内容，读树是职责本身）。
 *
 * 判定规则（逐条独立，不短路）：
 *   - 契约含 file：join(checkoutDir, file) 的文件内容包含 signature 文本 → 过；
 *     文件不存在 / 不含 → failure（含契约 id + 期望文件 + 恢复动作）。
 *   - 契约缺 file：全树文本搜索（深度遍历，跳过 node_modules / .git / 二进制 /
 *     符号链接），任一文件命中 → 过；无命中 → failure（含契约 id + 恢复动作）。
 *   - 空契约列表 → ok=true（无承诺需要配对）。
 *
 * 字节级搜索而非按行/按 UTF-8 解码：signature 是源码文本（UTF-8），Buffer.indexOf
 * 字节串匹配对 ASCII 与多字节字符同样精确，且天然跳过「解码失败要不要算命中」的
 * 边界问题。二进制探测用 NUL 字节嗅探（文本文件不含 0x00；与 git 的启发式同族）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Contract } from "../events/types.js";

export interface ContractMatchInput {
  /** root spec 冻结的契约（集成方收集后传入） */
  contracts: Contract[];
  /** 干净 checkout 树根（判定的文件系统输入） */
  checkoutDir: string;
}

export interface ContractMatchResult {
  ok: boolean;
  /** 每条含契约 id + 期望文件（或全树）+ 恢复动作 */
  failures: string[];
}

/** 全树搜索跳过的目录名（依赖安装产物与仓库元数据都不是契约宿主） */
const SKIP_DIR_NAMES = new Set(["node_modules", ".git"]);
/** 二进制嗅探窗口：前 N 字节含 NUL 即视为二进制跳过（完整文件无须读完） */
const BINARY_SNIFF_BYTES = 8_000;

export function matchContracts(input: ContractMatchInput): ContractMatchResult {
  const failures: string[] = [];
  for (const contract of input.contracts) {
    const failure = matchOne(contract, input.checkoutDir);
    if (failure !== null) {
      failures.push(failure);
    }
  }
  return { ok: failures.length === 0, failures };
}

/** 单契约判定：命中返回 null，未命中返回 failure 文本（含恢复动作） */
function matchOne(contract: Contract, checkoutDir: string): string | null {
  if (contract.signature.trim() === "") {
    return (
      `契约 ${contract.id}（provider=${contract.provider}）signature 为空，无从比对。` +
      "恢复动作：在提供方 unit 的 spec 中补齐签名文本（signature 是集成 verify 的机器比对对象）。"
    );
  }
  if (contract.file !== undefined) {
    const path = join(checkoutDir, contract.file);
    const raw = readOrNull(path);
    if (raw === null) {
      return (
        `契约 ${contract.id} 未命中：期望文件 ${contract.file} 在集成树中不存在（${path}）。` +
        `恢复动作：让提供方 ${contract.provider} 落实该文件后重新提交 build/verify，` +
        "集成会在下轮自动重试；或修正契约 file 指向实际宿主文件后重新走 spec 冻结。"
      );
    }
    if (!containsText(raw, contract.signature)) {
      return (
        `契约 ${contract.id} 未命中：signature "${contract.signature}" 不在期望文件 ${contract.file} 中。` +
        `恢复动作：让提供方 ${contract.provider} 在 ${contract.file} 落实该签名后重新提交 ` +
        "build/verify，集成会在下轮自动重试；签名确已变更则走重新 spec 冻结（改契约而非改实现要经 review）。"
      );
    }
    return null;
  }
  const hitPath = searchTree(checkoutDir, contract.signature);
  if (hitPath !== null) {
    return null;
  }
  return (
    `契约 ${contract.id} 未命中：全树搜索（跳过 node_modules/.git/二进制）未找到 signature ` +
    `"${contract.signature}"。恢复动作：让提供方 ${contract.provider} 落实该签名后重新提交 ` +
    "build/verify，集成会在下轮自动重试；确无固定宿主文件时在契约上补 file 字段收窄定位。"
  );
}

/** 深度优先遍历目录树找 signature；命中返回该文件绝对路径，无命中返回 null */
function searchTree(root: string, signature: string): string | null {
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue; // 不可读目录视作不含目标（判定输入是不完整树，交由上层失败项暴露）
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIR_NAMES.has(entry.name)) {
          stack.push(full);
        }
      } else if (entry.isFile()) {
        const raw = readOrNull(full);
        if (raw !== null && !isBinary(raw) && containsText(raw, signature)) {
          return full;
        }
      }
      // 符号链接等其余类型跳过：全树搜索只认 checkout 树自身文件，防环防逃逸
    }
  }
  return null;
}

function readOrNull(path: string): Buffer | null {
  try {
    return readFileSync(path);
  } catch {
    return null;
  }
}

function containsText(raw: Buffer, signature: string): boolean {
  return raw.indexOf(signature, "utf-8") !== -1;
}

/** NUL 字节嗅探：文本文件（任何编码）不含 0x00，出现即二进制 */
function isBinary(raw: Buffer): boolean {
  const window = raw.subarray(0, BINARY_SNIFF_BYTES);
  return window.includes(0);
}
