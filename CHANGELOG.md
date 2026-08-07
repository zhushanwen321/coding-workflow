# Changelog

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

