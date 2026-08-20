# Changelog

## [v2.0.0] - 2026-08-20

Complete 2.0 rewrite of the engine (PR #17): append-only event ledger + fold projection state machine + runner dispatch loop + acceptance-grade machine verification. The 1.x codebase is archived under `archive/`. Wave-level development history lives in `docs/rewrite/ledger.md`.

### Features
- feat(gates): mx5-5 rule-9 completeness closure — audit S1-S5 fixed (6aeb255)
- feat(frontier): mx5-2 contract-replan projection, dispatch chain, and D6 timeout honesty (9703d9f)
- feat(runner): mx5-3 adversarial reviewer brief — five-dimension checklist + graded output format (9fd2c87)
- feat(gates): mx5-1 rule 9 acceptance-command contract gate + parseFailedAcceptanceIds extraction (e29238e)
- feat(engine,runner): mx-4 — widen spec-review rejection budget to 10, configurable via --max-spec-rejects (e62d426)
- feat(engine,runner): mx-3 — spec-review role enforcement, generation-based deadlock count, spawn session retention (31ffa49)
- feat(runner): mx-1 independent spec-review dispatch — reviewer spawn, role field, model chain (59cca38)
- feat(verify,runner): rv-5 — flake escalation + nondeterministic exemption (ef4ee67)
- feat(verify,runner): rv-4 — red-phase default wiring, first-fail integration disposal, contract pairing (145ee96)
- feat(testrun): mx-2 pytest + playwright adapters with explicit runner routing (edae57f)
- feat(engine): rv-2 engine fixpack — id charset gate, marker unification, exec-review evidence enforcement (1af974a)
- feat(runner): rv-1 spawn/loop robustness — EPERM exemption + signal-driven child reclaim (3256bcf)
- feat(verify): rv-3 contract-match hardening — doc-host exclusion + whitespace-normalized matching (1bbbf4d)
- feat(runner): fx-4 spawn artifacts relocate to ~/.cw/topic — worktree purification (66fc7e0)
- feat(runner): wt-4 integration merge into root branch + worktree reclaim (23780f1)
- feat(runner): wt-2 spawn chain worktree split — behavior switch point (c3b4fc5)
- feat(runner): wt-1 worktree infra — lifecycle wrapper + path layout + CW_PROJECT_DIR (ac30e67)
- feat(m2): u8 integration verify - commits reachability + subtree acceptance rerun + contract matching (verified) - M2 complete (4e3c84c)
- feat(m2): contract.file field + u8 integration-verify acceptance baseline (21da1e1)
- feat(m1): u7 backend-agnostic run loop (verified after rework) - M1 complete (469310c)
- feat(m1): u6b human adapter on the spawn seam (verified) (3ed963b)
- feat(m1): u6c pi adapter - first real harness on the spawn seam (verified) (34ce8dc)
- feat(m1): u6a agent-spawn lifecycle primitive (verified, two-builder relay) (0d34bbb)
- feat(m1): agent-spawn contract layer + u6a acceptance baseline (78fa351)
- feat(m0): u4b name-level matching + red-phase gate (verified) - M0 complete (0061b26)
- feat(m0): u5b human-mode loop - cw run --spawn human (verified) (4c481ce)
- feat(m0): u4a cw verify clean-checkout rerun framework (verified after rework) (df432b0)
- feat(m0): u5 testrun adapters - vitest/e2e-sh pure functions (verified) (22e0ffe)
- feat(m0): testrun contract layer + acceptance baselines for u4a/u5 (115e52c)
- feat(m0): u1b read-only commands - status/frontier/tree/report (verified) (efa7f04)
- feat(m0): u2 write commands - create/evidence submit/review submit (verified) (cb7d344)
- feat(m0): dispatch contract layer + acceptance baselines for u2/u1b (552ae90)
- feat(m0): u1 event ledger + fold projection (verified) (a47e46c)
- feat(m0): u3 spec gate five rules (verified) (71f60a9)
- feat(rewrite): acceptance baselines for u1/u3 + shared domain type contract (01fd577)

### Bug Fixes
- fix: fx-7 pr-cr-fix review wave — spawn error guard, ledger envelope validation, exit-2 contract (881880a)
- fix(runner): fx-6 minor cleanup — stable-signature escalation dedup + final settlement line + static debts (ee1bbcb)
- fix(runner): fx-5 paired unit-resource reclaim, merge point free of side effects (187f7df)
- fix: repair design-consistency findings wave 3 (runner loop semantics) (8a1f846)
- fix: repair design-consistency findings wave 2 (ledger/projection semantics) (f24782d)
- fix: repair design-consistency findings wave 1 (CLI/gate/verify-exec domains) (1fc5e8c)
- fix(final): fx-3 decomposition-establishment gap R5 (verified, 22/22 adversarial) (8e0bf13)
- fix(final): fx-2 integration-layer deadlock R4a/R4b (verified, shadow-repo red-green) (4a3c7fd)
- fix(final): fx-1 deadlock root causes R1/R2/R3 (verified, shadow-repo red-green) (c699786)
- docs(rewrite): tighten orchestration role boundary - main agent dispatches only (431ced7)
- fix(dispatch): token-prefix command matching so flags resolve correctly (fe514f4)

### Refactoring
- refactor(runner): fx-6 F1 escalation family moved to escalations.ts — loop.ts back under max-lines, byte-identical migration (bb44207)
- refactor(role): mx5-4 builder->developer rename across 267 occurrences / 37 files + mx5-2 R1/R2 coverage assertions (e1aa49b)
- refactor(runner): wt-3 remove legacy shared-cwd reset approximation (dc5326b)
- refactor(fold): single-source the tree-aware closed predicate (0da5aa0)


## [v1.6.4] - 2026-08-14

### Features
- feat(report): revive recursive WorkUnit tree HTML report (W1) (d0176bd)
- feat(report): wire cw report CLI command (W2) (0af4ada)

### Bug Fixes
- fix(closeout): planning-layer closeout drift check treats commit artifacts as file paths (3bf1291)

### Miscellaneous
- docs(optimization): add 2026-08 optimization direction docs (A/C/B) (050e247)

## [v1.6.3] - 2026-08-11

### Features
- feat(skill): add quick-release pipeline for markdown-only changes (09293a3)

## [v1.6.2] - 2026-08-10

### Features
- feat(store): normalize store-key to git-common-dir, decouple workspace (a90e8e8)
- feat(validate): reject absolute testCwd in design/replan input (wave2) (63c48e3)
- feat(cli): startup deprecation warning for legacy per-cwd store (wave3) (6d8e479)
- feat(tech-design): add mandatory acceptance section + expression-optimization use case (58c76d3)
- feat(tech-design): strengthen acceptance principle with industry best practices (9337f7a)

### Bug Fixes
- fix(cli): skip false deprecation warning for non-git workspaces (e7b16f7)
- fix(skills): pr-cr-fix content review fixes (6 items) (3291ef0)

### Refactoring
- refactor(skills): consolidate code-review + pull-request into pr-cr-fix (8e97455)

### Miscellaneous
- docs: cw store/workspace decoupling design + adversarial review (aa4949b)
- docs: fold cw-tool cross-review findings (R2-1/R2-2) into store design (eb182c9)
- docs: drop store migration (deprecation-only), add ADR-0014 (ac3dc74)
- chore(skills): remove project-level remove-worktree skill (4f983d0)
- chore(skills): remove global cr-fix, self-contain grouping rules in pr-cr-fix (8840486)
- chore: silence lint warnings with documented rationale (f3afb4f)

## [v1.5.2] - 2026-08-08

### Bug Fixes
- fix: review batch 1 round 1 — 2 must-fix (9852b3f)

### Miscellaneous
- docs(skill): align recursive-orchestration with cw-tool builtin agents+pi-cw (4b0dc16)
- docs: align all docs/skill/src with E1 design action; purge legacy clarify/plan (ef83492)

## [v1.5.0] - 2026-08-07

### Refactoring
- refactor(cli): remove legacy compatibility paths (D1/D3/D9/D10) (5446b3a)
- refactor: remove legacy layer string param and noopStore default (D4/D7/D8) (bdd0d6c)
- refactor: drop ExecuteInput.changedFiles, make testCommand/failedTests required (zero-compat cleanup) (a31e9ab)

### Bug Fixes
- fix: gates.test.ts TestRunResult literals + testCommand undefined case (D5/D6 leftover) (9156b56)

### Miscellaneous
- chore: remove legacy v1 store migration and read-side schemaVersion compat (34a6635)
- docs: sync docs with zero historical compatibility cleanup (cbf18e8)
- docs: remove TBD placeholders in v1.4.0 changelog entries (9ee93de)

## [v1.4.0] - 2026-08-07

### Refactoring
- refactor: align cross-layer.ts with v5 (G5-crossLayer) — orchestration-aware routing (f8ce3ea)
- refactor(cli): export internal functions for layer-2 test access (test layering Step 0) (b99557f)

### Bug Fixes
- fix: address review suggestions (S-3/S-4/I-1/I-2/S-5) (7a1778d)
- fix: review batch 1 round 1 — 1 must-fix (99a6bec)
- fix(guidance): rename chain-agent → merge-agent to align with xyz-agent (c0b1e57)

### Features
- feat: rethink cw architecture (E1: clarify merged into design, plan→design rename, G5 cross-layer orchestration-aware routing) (7d3ffa5)

### Miscellaneous
- test: cover recursive orchestration mode (S-2) (7a9fab9)
- test: cover fan-out/inherited-declared gates + fix stale JSDoc counts (S-1) (8fd12f9)
- test: migrate cli wiring tests to layer-2 in-process (Step 1) (e94b0ec)
- test: slim cli.test.ts to layer-3 smoke tests only (Step 2) (ff468f3)
- docs: sync 4 main docs to E1 (clarify merged into design, plan→design) (52dcf11)
- chore: bump version 1.3.0 → 1.4.0 (89c1c28)

## [v1.1.0] - 2026-08-02

### Features
- feat(c1): add children field to ActionResult for recursive scheduling (47e5b97)
- feat(c2): add cw frontier readonly command for recursive BFS scheduling (522bcd0)
- feat(c3-c6): handoff FR/AC, layerSpecific schema, retrospect optional, dup-slug gate (e943383)
- feat(frontier): expose lastStatusHistoryAction for replan detection (a7f0af1)

### Bug Fixes
- fix: address review suggestions (S1/S2/INFO-1/INFO-2) (974e117)
- fix: handoff guidance command uses current action (not nextAction) (a2a5ba9)
- fix: address review suggestions (S1/S2/S5/S7/S8) (6083a9c)

### Miscellaneous
- feat(pr-cr-fix): add adaptive worktree/flock isolation for parallel worker commits (1cb50c3)
- docs: sync all docs with recursive cw enhancements (C1-C6 + frontier) (63a97ef)
- docs(cw-cli skill): fix --input/execute flags + add frontier command (c98a77e)
- chore: gitignore .review/ (pr-cr-fix review artifacts, machine-consumed) (adc7d7a)

## [v1.0.3] - 2026-07-27

### Features
- feat(v1): implement cascade exception + replan guidance + abandon teaching (e5f06fa)
- feat(v1): add parseAbandonMarkers + abandonedParentItems field (3841f6e)
- feat(v1): add --scope to cw v1 handoff (self/upstream/full) (a9b1780)
- feat(v1): enhance cw v1 list with cross-cwd/pagination/grouping/grep (8fd79d9)
- feat(v1): add schemaVersion + repoMeta to _v1.json for cross-cwd resume (2e7d944)

### Bug Fixes
- fix(review): address PR #2 code review findings (C1-C2, M1-M5, m1-m8) (83cc7e9)
- fix(v1): closeout artifact drift check supports commit kind (4625d3f)
- fix(v1): address Wave B code review (C1/C2/M4/M5/m6/m7) (f51b484)
- fix(v1): address Wave A code review (C1/C2/M1-M4/m1/m4) (f9c80f0)

### Refactoring
- refactor(wave3): remove v1 prefix, add buildCommand helper (4d858cb)
- refactor(wave2): flatten src/v1/ to src/ root level (b1c0229)
- refactor(wave1): remove 0.x legacy + engine, decouple CwError (a2aaecb)

### Documentation
- docs(wave4): update skill + add ADR 0009 for 0.x cleanup (056e775)

### Tests
- test(v1): add parseAbandonMarkers unit tests + cascade exception tests (7d0615a)

## [v1.0.4] - 2026-07-27

### Features
- Merge pull request #3 from zhushanwen321/feat-replan-process-refactor (9b78b2d)
- feat(replan): cross-layer abandon parent items declaration (ADR-0010) (2ff1158)

### Bug Fixes
- fix(lint): zero warnings + implement skipped TC-B6 test (437c127)
- fix(replan): address all CR findings (C1-C2, M1-M8, m1-m8) (a15ab53)
- fix(skills): inline remove-worktree + fix merge skill fetch tracking-ref bug (46a0148)


## [v1.0.6] - 2026-07-30

### Features
- feat(skills): add pr-cr-fix + upgrade code-review to multi-subagent review (b961172)
- feat(guidance): redirect intermediate artifacts to .cw/<slug>/ + cleanup v1 docs (59e9b15)

### Bug Fixes
- fix(store): migrate ~/.v1 to ~/.cw + cleanup legacy artifacts script (b9bef2b)

### Refactoring
- Merge pull request #5 from zhushanwen321/feat-optimize-root-json-file (4c19f84)
- refactor: cleanup v1 naming residuals (comments, error msg, test renames) (5762657)
- refactor(tests): flatten tests/v1/ → tests/ + rename helpers/v1-env.ts → env.ts (f7d6891)
- refactor(store): rename _v1.json → store.json + filename migration (0fb1f83)
- refactor: rename V1* identifiers to Cw* + cleanup stale docs + fix migrate lint (bb28e31)


## [v1.2.0] - 2026-08-03

### Features
- Merge pull request #7 from zhushanwen321/cw-hardening-w1w2 (95a7a0f)
- feat(W3): execute commitHash pre-check, readonly aggregation, replan prefix consistency (#8/#10/#12) (e9727a4)
- feat(cli): flag whitelist + per-command help + input shape validation + prefix strip (W2 #5/#6/#9) (f75bfbe)
- feat(cli): add help and version commands (71709d0)
- feat(schema-injector): cross-file type resolution for outer Input wrappers (gap 1, A1) (2edf4b5)
- feat(recursive): parallel scheduling + cross-wave file conflict gate (65b0425)

### Bug Fixes
- fix(review): address round-1 suggestions S1-S9 (20336aa)
- fix(W3-review): replan prefix status fallback (?? unit.status) to match project convention (1ce9c02)
- fix(W1): schema nextAction alignment, create idempotency, retrospect gate keys, testCwd e2e lock (ddf0955)
- fix(guidance): execute command render + abandonParentItems schema (gap 5 & 6) (8de2263)

### Reverts
- revert(recursive): drop parallelTargets scheduling and recursive-subagent guidance (0583666)

### Miscellaneous
- docs(closeout): distill cw-guidance-hardening conclusions (ADR-0012 + NFR O-2/O-3 + ARCHITECTURE + TEST-STRATEGY RB-5) (c0027eb)
- docs(skill): fix wave plan structure, failure hint threshold, schema block note (gap 2/3) (48329a8)

## [v1.3.0] - 2026-08-04

### Features
- feat(test-command): w3 guidance + replan testCommand bypass + tests (060af56)
- feat(test-command): w2 testRunner flip to per-wave testCommand + config deprecation + fail hint split (7a127f4)
- feat(test-command): w1 schema layer + testCommandNonEmpty gate (28ec77a)

### Bug Fixes
- fix(replan): executing content-replan no-return guidance + schema non-empty guard (efa2ec3)

### Miscellaneous


## [v1.4.0] - 2026-08-07

### Features
- Merge pull request #9 from zhushanwen321/feat-rethink-cw-architecture (7d3ffa5)
- feat(engine): orchestration modes (G5) + dispatch guidance (G1) (696fdb3)
- feat(gates): E3 split fan-out limit gates + E6 inheritedItemIdsDeclared warn gate (1ebc075)
- feat(store): bump schemaVersion to 2 with SCHEMA_VERSION constant (d67585c)

### Bug Fixes
- fix(guidance): rename chain-agent → merge-agent to align with xyz-agent (c0b1e57)
- fix: address review suggestions (S-3/S-4/I-1/I-2/S-5) (7a1778d)
- fix: review batch 1 round 1 — 1 must-fix (99a6bec)

### Refactoring
- refactor: align cross-layer.ts with v5 (G5-crossLayer) — orchestration-aware routing (f8ce3ea)


## [v1.6.0] - 2026-08-08

### Features
- feat(skill): add tech-design skill for writing + reviewing design docs (5822b0c)

### Bug Fixes
- fix: address review info items + verify agent install (round 2) (1a71e92)
- fix: address review must-fix/suggestions (round 1) (850a571)
- fix: address review suggestions (round 1) (ec623d6)

### Refactoring
- refactor(skill): adapt code-review/pr-cr-fix to pi review-fix-loop (e6b1714)
- refactor(skill): restructure distribution layout to skills/ + agents/ (7acf9c1)
- refactor(merge-skill): self-contained, dynamic path resolution, sync main only (ac0522a)

### Miscellaneous
- docs(skill): pr-cr-fix stage-2 direct env dispatch (fc39772)


## [v1.6.1] - 2026-08-09

### Bug Fixes
- fix(config): preserve testCwd on progressive design replace (review must-fix) (6baebbd)
- fix(wave2): remove dead dispatchGuidance field + correct ADR-0013 attribution (exec-review) (04dd9b7)
- fix(wave1): correct test gate hint to reachable recovery path (exec-review) (d657cd0)

### Refactoring
- Merge pull request #14 from zhushanwen321/fix-cw-config-json (15b6840)
- refactor(config): remove orchestration dead config + deprecate cw.config.json (wave 2) (fa67f3b)
- refactor(config): sink testRunner.cwd to per-wave testCwd (wave 1) (3e29a00)

- quick-release skill for fast markdown-only publishing; tech-design problem-definition-first + review fact-severity grading (#16)
