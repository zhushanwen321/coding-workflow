#!/usr/bin/env python3
"""metrics-gate.py — pr-cr-fix 阶段 1.5 确定性度量门禁（Gate-1.5，CRAP 向）。

包装 `fallow audit`（机器计算），按显式双轨规则判定（脚本判定而非 fallow verdict）：
- FAIL：introduced 函数圈复杂度 > maxCyclomatic
- WARN：introduced 认知复杂度 > maxCognitive 或 CRAP >= maxCrap

为什么不直接用 fallow 的 verdict：fallow 的 complexity findings 超阈值即 fail、无 warn
档；且 cw 无 coverage 基建，CRAP 是 fallow 静态估算（无测试路径的文件 cov≈0，CC>=5 即
触发 CRAP>=30），把 CRAP 放进 fail 档会误杀。故门禁与报告用同一份 audit JSON、两套阈值
在脚本内显式判定：圈复杂度是纯结构指标（fail），CRAP/认知复杂度带估算噪声（warn，注入
阶段 2 review 消费）。对比 xyz-agent 版：本版为 cw 单包精简形态，无 coverage 联动分流
（cw 无 Gate-1.6），死代码/循环依赖/重复块轨不启用（未点名不搬）。

用法：python3 metrics-gate.py [--base main]
退出码：0 = pass/warn（放行）；1 = fail（打回）；2 = 工具/运行错误（中止）
产出：.review/metrics.json（fail/warn 清单 + high_crap 靶子清单，阶段 2 review 消费）
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

DEFAULTS = {"maxCyclomatic": 15, "maxCognitive": 15, "maxCrap": 30.0}

TARGET_TOP_N = 20


def load_thresholds(repo_root: Path) -> dict:
    config = repo_root / ".fallowrc.json"
    if not config.is_file():
        return dict(DEFAULTS)
    try:
        health = json.loads(config.read_text()).get("health", {})
    except json.JSONDecodeError:
        print(f"WARN: .fallowrc.json 解析失败，用默认阈值 {DEFAULTS}", file=sys.stderr)
        return dict(DEFAULTS)
    return {k: health.get(k, v) for k, v in DEFAULTS.items()}


def run_audit(repo_root: Path, base: str) -> dict:
    cmd = ["fallow", "audit", "--changed-since", base, "--format", "json", "--quiet"]
    proc = subprocess.run(cmd, cwd=repo_root, capture_output=True, text=True)
    if proc.returncode not in (0, 1):
        # fallow 自身 verdict fail 时 exit 1（JSON 仍完整产出）；只有 >=2 才是运行错误
        print(f"ERROR: fallow audit 运行失败：\n{proc.stderr.strip()}", file=sys.stderr)
        sys.exit(2)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        print(f"ERROR: fallow 输出非 JSON（exit={proc.returncode}）：{proc.stderr.strip()[:500]}",
              file=sys.stderr)
        sys.exit(2)


def judge(report: dict, thresholds: dict) -> dict:
    max_cc = thresholds["maxCyclomatic"]
    max_cog = thresholds["maxCognitive"]
    max_crap = thresholds["maxCrap"]
    fail: list[dict] = []
    warn: list[dict] = []
    targets: list[dict] = []

    for f in report.get("complexity", {}).get("findings", []):
        if not f.get("introduced"):
            continue
        entry = {
            "type": "complexity",
            "path": f["path"],
            "line": f["line"],
            "name": f["name"],
            "cyclomatic": f["cyclomatic"],
            "cognitive": f["cognitive"],
            "crap": f.get("crap"),
            "coverage_tier": f.get("coverage_tier"),
            "coverage_basis": "fallow-static (cw 无 coverage 基建，CRAP 为估算值)",
        }
        # CRAP 为估算值时仅作排序/审查靶子，不进 fail 判定
        if f["cyclomatic"] > max_cc:
            fail.append({**entry, "reason": f"cyclomatic {f['cyclomatic']} > {max_cc}"})
        elif f["cognitive"] > max_cog or (f.get("crap") or 0) >= max_crap:
            warn.append({**entry, "reason": f"cognitive {f['cognitive']} / crap {f.get('crap')}"})
        if f.get("crap") is not None:
            targets.append(entry)

    targets.sort(key=lambda e: -(e.get("crap") or 0))
    verdict = "fail" if fail else ("warn" if warn else "pass")
    return {
        "verdict": verdict,
        "fail": fail,
        "warn": warn,
        "targets": {"high_crap": targets[:TARGET_TOP_N]},
        "stats": {
            "fail": len(fail),
            "warn": len(warn),
            "coverage_basis": "fallow-static",
            "thresholds": thresholds,
        },
    }


def main() -> None:
    base = "main"
    if "--base" in sys.argv:
        base = sys.argv[sys.argv.index("--base") + 1]
    if shutil.which("fallow") is None:
        print("ERROR: 未找到 fallow。安装：npm i -g fallow（实测版本 2.88.2）", file=sys.stderr)
        sys.exit(2)

    repo_root = Path(subprocess.check_output(
        ["git", "rev-parse", "--show-toplevel"], text=True).strip())
    thresholds = load_thresholds(repo_root)
    report = run_audit(repo_root, base)
    result = judge(report, thresholds)
    result["base"] = base

    out_dir = repo_root / ".review"
    out_dir.mkdir(exist_ok=True)
    (out_dir / "metrics.json").write_text(json.dumps(result, indent=2, ensure_ascii=False))

    s = result["stats"]
    print(f"Gate-1.5 verdict={result['verdict']}  fail={s['fail']} warn={s['warn']} "
          f"({s['coverage_basis']})  (base={base}, thresholds={s['thresholds']})")
    for item in result["fail"][:10]:
        print(f"  FAIL [{item['type']}] {item['path']}:{item['line']} {item['name']} — {item['reason']}")
    print(f"报告: {out_dir / 'metrics.json'}")
    sys.exit(1 if result["verdict"] == "fail" else 0)


if __name__ == "__main__":
    main()
