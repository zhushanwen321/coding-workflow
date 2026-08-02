# Changelog

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

