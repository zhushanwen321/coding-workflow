/**
 * 契约机器比对（canon《design-rewrite-architecture.md》§3.3 D6「集成 = 内部节点的
 * verify」：跨节点契约机器比对，签名 ≡ spec 冻结文本；§1.3「机器能验切得闭不闭合
 * 中的契约配对」）。u8 验收文档 docs/rewrite/acceptance/u8-acceptance.md 规格锁定 1；
 * rv3 验收文档 docs/rewrite/acceptance/rv3-acceptance.md 强化（文档宿主排除 + 归一化比对）。
 *
 * 「纯函数」口径：对同一 (contracts, checkoutDir) 结果恒定——只读文件系统、不写
 * 任何状态、无时间/随机输入（与 nameMatch 的无 IO 纯函数不同，本函数的判定输入
 * 就是 checkout 树的文件内容，读树是职责本身）。
 *
 * 判定规则（逐条独立，不短路）：
 *   - 契约含 file：file 指向文档类宿主（.md/.txt/.rst/.adoc 扩展；README、
 *     CONTRIBUTING、CHANGELOG 前缀文件名（任意扩展）；docs 目录）→ failure（文档
 *     类文件不是契约宿主——封堵「把签名写进 README 即过比对」的作弊面。注意排除
 *     的是宿主资格而非文件存在性，此判定先于存在性检查）；否则
 *     join(checkoutDir, file) 的文件内容包含 signature（空白归一化后）→ 过；
 *     文件不存在 / 不含 → failure（含契约 id + 期望文件 + 恢复动作）。
 *   - 契约缺 file：全树文本搜索（深度遍历，跳过 node_modules / .git / docs/ 目录 /
 *     文档类文件 / 二进制 / 符号链接），任一文件命中 → 过；无命中 → failure
 *     （含契约 id + 恢复动作）。
 *   - 空契约列表 → ok=true（无承诺需要配对）。
 *
 * 文档类清单是封闭集合（上述扩展 + 前缀名 + docs 目录名，不做启发式内容判断）。
 * .json/.yaml 等不在集合内——schema 类契约的合法宿主。宿主资格判定大小写不敏感
 * （防 Readme.MD 式绕过）；这与下方「比对不折叠大小写」不矛盾——后者锁定的是
 * signature 文本比对语义。
 *
 * 归一化比对：文件内容与 signature 双侧 `replace(/\s+/g, " ")`（连续空白含换行/
 * 缩进折叠为单空格）后 indexOf——防格式化工具/缩进/换行风格差异造成假 fail。只
 * 折叠空白，不做大小写折叠、不做 token 化（`Foo` ≠ `foo` 仍判不命中）。
 *
 * 已知残余作弊面（如实记录）：代码内注释命中（把签名写进 .ts 文件注释仍算命中）
 * ——本层不做语义解析，防线 = review + 红阶段测试。
 *
 * 二进制探测用 NUL 字节嗅探（文本文件不含 0x00；与 git 的启发式同族）。
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
/** 文档类目录名（小写）：docs/ 目录整棵不入全树搜索，也不是显式 file 的合法宿主 */
const DOC_DIR_NAMES = new Set(["docs"]);
/** 文档类扩展名（小写）：文档不是契约宿主 */
const DOC_EXTENSIONS = new Set(["md", "txt", "rst", "adoc"]);
/** 文档类文件名前缀（小写）：任意扩展、以 README/CONTRIBUTING/CHANGELOG 开头的文件名 */
const DOC_NAME_PREFIXES = ["readme", "contributing", "changelog"] as const;
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
    // 宿主资格先于存在性：指向文档类路径时，无论文件是否存在都是同一失败态
    const relSegments = contract.file.split("/").filter((seg) => seg !== "");
    if (isDocHost(relSegments)) {
      return (
        `契约 ${contract.id} 的期望文件 ${contract.file} 是文档类文件` +
        "（.md/.txt/.rst/.adoc 扩展、README*/CONTRIBUTING*/CHANGELOG* 文件名、docs/ 目录），" +
        `文档类文件不是契约宿主，签名写进文档不构成契约命中。` +
        `恢复动作：让提供方 ${contract.provider} 把签名落实到真实代码/配置文件` +
        "（如 .ts/.js/.json），并修正契约 file 指向该文件后重新走 spec 冻结。"
      );
    }
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
    `契约 ${contract.id} 未命中：全树搜索（跳过 node_modules/.git/docs/二进制/文档类文件）未找到 ` +
    `signature "${contract.signature}"。恢复动作：让提供方 ${contract.provider} 落实该签名后重新提交 ` +
    "build/verify，集成会在下轮自动重试；确无固定宿主文件时在契约上补 file 字段收窄定位。"
  );
}

/**
 * 相对路径 segments（POSIX 风格）是否文档类宿主。封闭集合：任一目录段名为 docs、
 * 文件名以 README/CONTRIBUTING/CHANGELOG 前缀开头（任意扩展）、扩展名为
 * .md/.txt/.rst/.adoc。大小写不敏感（防 Readme.MD 绕过）。
 */
function isDocHost(segments: string[]): boolean {
  for (const segment of segments.slice(0, -1)) {
    if (DOC_DIR_NAMES.has(segment.toLowerCase())) {
      return true;
    }
  }
  const fileName = segments[segments.length - 1];
  if (fileName === undefined) {
    return false;
  }
  const lower = fileName.toLowerCase();
  if (DOC_NAME_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return true;
  }
  const dot = lower.lastIndexOf(".");
  // dot <= 0：无扩展名（`README` 已被前缀规则覆盖；`.gitignore` 类点开头文件无扩展语义）
  return dot > 0 && DOC_EXTENSIONS.has(lower.slice(dot + 1));
}

/** 深度优先遍历目录树找 signature；命中返回该文件绝对路径，无命中返回 null */
function searchTree(root: string, signature: string): string | null {
  const stack: Array<{ abs: string; rel: string[] }> = [{ abs: root, rel: [] }];
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined) break;
    let entries;
    try {
      entries = readdirSync(current.abs, { withFileTypes: true });
    } catch {
      continue; // 不可读目录视作不含目标（判定输入是不完整树，交由上层失败项暴露）
    }
    for (const entry of entries) {
      const full = join(current.abs, entry.name);
      const rel = [...current.rel, entry.name];
      if (entry.isDirectory()) {
        const lower = entry.name.toLowerCase();
        if (!SKIP_DIR_NAMES.has(entry.name) && !DOC_DIR_NAMES.has(lower)) {
          stack.push({ abs: full, rel });
        }
      } else if (entry.isFile()) {
        // 文档类文件不是契约宿主，直接跳过（与显式 file 的排除口径一致）
        if (isDocHost(rel)) {
          continue;
        }
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

/** 空白归一化：连续空白（含换行/缩进/制表符）折叠为单空格。只折叠空白——不做
 *  大小写折叠、不做 token 化（rv3-acceptance §4 锁定：`Foo` ≠ `foo` 仍不命中） */
function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ");
}

function containsText(raw: Buffer, signature: string): boolean {
  return normalizeText(raw.toString("utf8")).indexOf(normalizeText(signature)) !== -1;
}

/** NUL 字节嗅探：文本文件（任何编码）不含 0x00，出现即二进制 */
function isBinary(raw: Buffer): boolean {
  const window = raw.subarray(0, BINARY_SNIFF_BYTES);
  return window.includes(0);
}
