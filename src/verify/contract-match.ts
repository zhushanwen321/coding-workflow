/**
 * 契约机器比对（canon《design-rewrite-architecture.md》§3.3 D6「集成 = 内部节点的
 * verify」：跨节点契约机器比对，签名 ≡ spec 冻结文本；§1.3「机器能验切得闭不闭合
 * 中的契约配对」）。u8 验收文档 docs/rewrite/acceptance/u8-acceptance.md 规格锁定 1；
 * rv3 验收文档 docs/rewrite/acceptance/rv3-acceptance.md 强化（文档宿主排除 + 归一化比对）；
 * rv4 验收文档 docs/rewrite/acceptance/rv4-acceptance.md 升级为两道独立比对（配对 +
 * 树内），废除「同 id root 优先去重」（全量带 owner 保留，同 id 冲突由两道组合暴露）。
 *
 * 「纯函数」口径：对同一 (contracts, frozenByUnit, checkoutDir) 结果恒定——只读文件
 * 系统、不写任何状态、无时间/随机输入（与 nameMatch 的无 IO 纯函数不同，本函数的
 * 判定输入就是 checkout 树的文件内容，读树是职责本身）。
 *
 * 两道独立，任一 fail 即契约 fail（rv4-acceptance §4 锁定）：
 *   - 第一道·配对比对（frozenByUnit 提供时）：对每条契约 C（owner = 声明它的
 *     unit）——C.provider 非空且 ≠ owner 时，在 frozenByUnit[provider] 中找同 id
 *     条目 PC：无 → failure「契约无 provider 声明」（consumer 记了账、provider
 *     从未承诺）；有 → 归一化全等（trim + 空白折叠）比对 C.signature ≡
 *     PC.signature，不等 → failure「契约漂移」（消息含两侧归一化文本）。provider
 *     为空或 = owner（self-provider，root 集成契约形态）→ 跳过配对。frozenByUnit
 *     省略时本道整体跳过（纯函数测试只测树内语义；真实调用方恒传入）。
 *   - 第二道·树内验证（rv-3 语义不变，逐条独立不短路）：
 *     - 契约含 file：file 指向文档类宿主（.md/.txt/.rst/.adoc 扩展；README、
 *       CONTRIBUTING、CHANGELOG 前缀文件名（任意扩展）；docs 目录）→ failure（文档
 *       类文件不是契约宿主——封堵「把签名写进 README 即过比对」的作弊面。注意排除
 *       的是宿主资格而非文件存在性，此判定先于存在性检查）；否则
 *       join(checkoutDir, file) 的文件内容包含 signature（空白归一化后）→ 过；
 *       文件不存在 / 不含 → failure（含契约 id + 期望文件 + 恢复动作）。
 *     - 契约缺 file：全树文本搜索（深度遍历，跳过 node_modules / .git / docs/ 目录 /
 *       文档类文件 / 二进制 / 符号链接），任一文件命中 → 过；无命中 → failure
 *       （含契约 id + 恢复动作）。
 *     - 同 id 多 owner 版本（去重废除后可能出现）：任一 owner 版本命中即该 id 树内
 *       通过（rv4-acceptance §2：同 id 冲突的暴露交给配对道 + 组合判定，树内不
 *       因多版本并存的「其中一份未命中」而误报）。
 *   - 空契约列表 → ok=true（无承诺需要配对）。
 *
 * 文档类清单是封闭集合（上述扩展 + 前缀名 + docs 目录名，不做启发式内容判断）。
 * .json/.yaml 等不在集合内——schema 类契约的合法宿主。宿主资格判定大小写不敏感
 * （防 Readme.MD 式绕过）；这与下方「比对不折叠大小写」不矛盾——后者锁定的是
 * signature 文本比对语义。
 *
 * 归一化比对：文件内容与 signature 双侧 `replace(/\s+/g, " ")`（连续空白含换行/
 * 缩进折叠为单空格）后 indexOf——防格式化工具/缩进/换行风格差异造成假 fail。只
 * 折叠空白，不做大小写折叠、不做 token 化（`Foo` ≠ `foo` 仍判不命中）。配对道的
 * 全等比对在同一归一化上再叠 trim（首尾空白是纯粹的书写风格差异）。
 *
 * 已知残余作弊面（如实记录）：代码内注释命中（把签名写进 .ts 文件注释仍算命中）
 * ——本层不做语义解析，防线 = review + 红阶段测试。
 *
 * 二进制探测用 NUL 字节嗅探（文本文件不含 0x00；与 git 的启发式同族）。
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Contract } from "../events/types.js";

/** 带归属的契约条目（rv-4：废除同 id root 优先去重——全量保留，owner 标记声明方） */
export interface OwnedContract {
  contract: Contract;
  /** 声明该契约的 unitId（root 或某子；同 id 可多 owner 并存） */
  ownerUnitId: string;
}

export interface ContractMatchInput {
  /** 集成方收集的全量契约（root ∪ 各子 spec 冻结，带 owner；同 id 不去重） */
  contracts: readonly OwnedContract[];
  /**
   * 各 unit 冻结 spec 的契约集（配对第一道的比对基准）。省略 = 只做树内验证
   * （纯函数测试口径）；真实调用方（integrate.ts）恒传入——由入参 contracts 按
   * owner 聚合即可还原，无第二个数据源。
   */
  frozenByUnit?: ReadonlyMap<string, readonly Contract[]>;
  /** 干净 checkout 树根（树内验证的文件系统输入） */
  checkoutDir: string;
}

export interface ContractMatchResult {
  ok: boolean;
  /** 每条含契约 id + 期望文件（或两侧签名文本）+ 恢复动作 */
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
  // 第一道·配对比对（frozenByUnit 缺席时整体跳过——两道独立，第二道照常执行）
  if (input.frozenByUnit !== undefined) {
    for (const entry of input.contracts) {
      const failure = pairCheck(entry, input.frozenByUnit);
      if (failure !== null) {
        failures.push(failure);
      }
    }
  }
  // 第二道·树内验证：同 id 的多个 owner 版本（去重废除后可能并存）任一命中即该 id
  // 通过；全未命中才逐条产出 failure（消息自带 owner 语境可区分多版本）
  const groupsById = new Map<string, OwnedContract[]>();
  for (const entry of input.contracts) {
    const group = groupsById.get(entry.contract.id) ?? [];
    group.push(entry);
    groupsById.set(entry.contract.id, group);
  }
  for (const group of groupsById.values()) {
    const misses: string[] = [];
    for (const entry of group) {
      const failure = matchOne(entry.contract, input.checkoutDir);
      if (failure !== null) {
        misses.push(failure);
      }
    }
    if (misses.length === group.length) {
      failures.push(...misses);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * 第一道·单条配对判定：consumer 侧签名 ≡ provider 冻结版。命中或跳过返回 null，
 * 失配返回 failure 文本。self-provider（provider 为空或 = owner，root 集成契约
 * 形态）无外部承诺可配对，跳过——其兑现与否由第二道树内验证承担。
 */
function pairCheck(
  entry: OwnedContract,
  frozenByUnit: ReadonlyMap<string, readonly Contract[]>,
): string | null {
  const { contract, ownerUnitId } = entry;
  const provider = contract.provider.trim();
  if (provider === "" || provider === ownerUnitId) {
    return null;
  }
  const providerVersion = (frozenByUnit.get(provider) ?? []).find(
    (p) => p.id === contract.id,
  );
  if (providerVersion === undefined) {
    return (
      `契约无 provider 声明：${contract.id}（owner ${ownerUnitId} 的冻结 spec 声明 provider=` +
      `${provider}，但 ${provider} 的冻结 spec 中不存在同 id 契约——consumer 记了账、provider 从未承诺）。` +
      `恢复动作：补齐 provider 侧的契约声明（在 ${provider} 的 spec 中声明契约 ${contract.id} 并过审），` +
      "或修正 owner 侧契约的 provider 指向后重新走 spec 冻结。"
    );
  }
  const ownerSig = normalizePairText(contract.signature);
  const providerSig = normalizePairText(providerVersion.signature);
  if (ownerSig !== providerSig) {
    return (
      `契约漂移：契约 ${contract.id}（owner ${ownerUnitId}，provider=${provider}）的 signature 与 ` +
      `provider 冻结版不一致（归一化后全等比对失败；owner 侧期望文件 ${contract.file ?? "（全树搜索）"}）` +
      `——owner 侧 "${ownerSig}" vs provider ${provider} 冻结侧 "${providerSig}"。` +
      `恢复动作：二选一——① 语义等价但文本不等 → 修正 owner 侧签名后重新提交 spec 过审；` +
      `② provider 冻结版才是正确承诺 → 修正 owner ${ownerUnitId} 的契约文本对齐 provider。`
    );
  }
  return null;
}

/** 配对道的归一化：空白折叠（normalizeText）+ 首尾 trim——书写风格差异不判漂移 */
function normalizePairText(text: string): string {
  return normalizeText(text).trim();
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
        `恢复动作：让提供方 ${contract.provider} 落实该文件后经处置链路重跑集成` +
        "（rv-4 起集成首次 fail 即转 designer 处置，无自动重试）；" +
        "或修正契约 file 指向实际宿主文件后重新走 spec 冻结。"
      );
    }
    if (!containsText(raw, contract.signature)) {
      return (
        `契约 ${contract.id} 未命中：signature "${contract.signature}" 不在期望文件 ${contract.file} 中。` +
        `恢复动作：让提供方 ${contract.provider} 在 ${contract.file} 落实该签名后经处置链路重跑集成` +
        "（rv-4 起集成首次 fail 即转 designer 处置，无自动重试）；" +
        "签名确已变更则走重新 spec 冻结（改契约而非改实现要经 review）。"
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
    `signature "${contract.signature}"。恢复动作：让提供方 ${contract.provider} 落实该签名后经处置链路 ` +
    "重跑集成（rv-4 起集成首次 fail 即转 designer 处置，无自动重试）；" +
    "确无固定宿主文件时在契约上补 file 字段收窄定位。"
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
