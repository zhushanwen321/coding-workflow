# Changelog

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
