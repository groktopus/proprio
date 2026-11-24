# Critical-journey QA report

UTC window `2026-11-17T00:00:00.000Z` inclusive through `2026-11-24T00:00:00.000Z` exclusive.

| Journey | Merged PRs | Timed PRs | Median minutes to green | Missing pass | Cancelled attempts | Infrastructure | Other nonpassing | Retry-confirmed flakes | Recorded escapes |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| Install and update | 15 | 15 | 12.4 | 0 | 2 | 0 | 0 | unknown | 1 |
| Backup and restore | 21 | 21 | 14.6 | 0 | 1 | 0 | 0 | unknown | 1 |
| Execution recovery | 19 | 19 | 9.9 | 0 | 4 | 0 | 1 | unknown | 1 |

## Escapes and regression coverage

- Install and update on `v0.0.1`. Assert that an older managed Git update cannot reclaim an activation already owned by a newer update. [Issue #107](https://github.com/groktopus/proprio/issues/107) · [Regression PR #228](https://github.com/groktopus/proprio/pull/228)
- Backup and restore on `v0.0.1`. Restore a backup with unvalidated foreign keys and assert that their validation state survives. [Issue #109](https://github.com/groktopus/proprio/issues/109) · [Regression PR #229](https://github.com/groktopus/proprio/pull/229)
- Execution recovery on `v0.0.1`. Exercise ambiguous Pause and Clear outcomes against the persisted goal and confirmed runner state. [Issue #122](https://github.com/groktopus/proprio/issues/122) · [Regression PR #253](https://github.com/groktopus/proprio/pull/253)

## Repeat flakes

[Repository owner](https://github.com/groktopus/proprio/blob/main/.github/CODEOWNERS) reviews repeated exact cases by 2026-12-01.


## Coverage gaps

- 0 journey PRs had no retained smoke job.
- 0 workspace regression runs found, 0 missing or incomplete profile groups. With no matching executed cases, retry rates are unknown.
- Escape counts cover only registered issues. Untagged defects and projects outside the chosen path groups have unknown coverage.

## Evidence

- [PR #251](https://github.com/groktopus/proprio/pull/251) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45283316983/job/138089337212) · `2472c1fdf563`
- [PR #250](https://github.com/groktopus/proprio/pull/250) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45283130594/job/138089114584) · `4b8da3962b37`
- [PR #252](https://github.com/groktopus/proprio/pull/252) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45283133337/job/138090624518) · `aabca716b764`
- [PR #254](https://github.com/groktopus/proprio/pull/254) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45279367783/job/138074698217) · `b5fd76d492a0`
- [PR #227](https://github.com/groktopus/proprio/pull/227) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45246182965/job/137965702595) · `9bee326c6d43`
- [PR #248](https://github.com/groktopus/proprio/pull/248) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45239055809/job/137919152936) · `af46d508075f`
- [PR #232](https://github.com/groktopus/proprio/pull/232) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45227379994/job/137877398864) · `1678252158dd`
- [PR #247](https://github.com/groktopus/proprio/pull/247) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45227762030/job/137878751290) · `208ddd0d3415`
- [PR #231](https://github.com/groktopus/proprio/pull/231) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45226091601/job/137872852927) · `3257c41930eb`
- [PR #233](https://github.com/groktopus/proprio/pull/233) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45226088839/job/137880346323) · `ad6725c146dd`
- [PR #246](https://github.com/groktopus/proprio/pull/246) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45209309412/job/137813469212) · `fded06a6ac80`
- [PR #229](https://github.com/groktopus/proprio/pull/229) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45207067279/job/137805536958) · `ee8bb1c6fa08`
- [PR #230](https://github.com/groktopus/proprio/pull/230) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45207075589/job/137805563684) · `a6dd199db23d`
- [PR #228](https://github.com/groktopus/proprio/pull/228) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45198930865/job/137776832845) · `79606e25aa2a`
- [PR #219](https://github.com/groktopus/proprio/pull/219) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45199464184/job/137778717171) · `a88a870f25d4`
- [PR #204](https://github.com/groktopus/proprio/pull/204) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45191440850/job/137750533550) · `9f79090ea013`
- [PR #97](https://github.com/groktopus/proprio/pull/97) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45132772925/job/137551856847) · `b4aef8f72c12`
- [PR #99](https://github.com/groktopus/proprio/pull/99) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45128953198/job/137539742880) · `4248170ccd1b`
- [PR #94](https://github.com/groktopus/proprio/pull/94) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45123273087/job/137521724953) · `cdcbf7deb85b`
- [PR #86](https://github.com/groktopus/proprio/pull/86) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45119795500/job/137510709624) · `83739aac5056`
- [PR #80](https://github.com/groktopus/proprio/pull/80) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45117182327/job/137502574625) · `fb96360772ad`
- [PR #81](https://github.com/groktopus/proprio/pull/81) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45117632246/job/137503997233) · `dec1ca1cecae`
- [PR #71](https://github.com/groktopus/proprio/pull/71) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45116542718/job/137500675189) · `c8bb31144304`
- [PR #54](https://github.com/groktopus/proprio/pull/54) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45106721629/job/137469672808) · `759fade5e19e`
- [PR #51](https://github.com/groktopus/proprio/pull/51) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45098560878/job/137443831277) · `996492f51f9b`
- [PR #47](https://github.com/groktopus/proprio/pull/47) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45094599949/job/137431488634) · `3c04c5099dfc`
- [PR #43](https://github.com/groktopus/proprio/pull/43) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45093921897/job/137429386797) · `69a08aac7333`
- [PR #49](https://github.com/groktopus/proprio/pull/49) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45093303903/job/137427525821) · `640045f7cd09`
- [PR #46](https://github.com/groktopus/proprio/pull/46) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45093076582/job/137426858940) · `0c7046c7bf3f`
- [PR #44](https://github.com/groktopus/proprio/pull/44) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45092102271/job/137423735281) · `2c9dd83a157f`
- [PR #48](https://github.com/groktopus/proprio/pull/48) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45092213815/job/137424085450) · `f9e3232c4d74`
- [PR #42](https://github.com/groktopus/proprio/pull/42) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45090183263/job/137417737175) · `faf9d694f108`
- [PR #41](https://github.com/groktopus/proprio/pull/41) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45088582579/job/137412716342) · `7d416c5c3670`
- [PR #27](https://github.com/groktopus/proprio/pull/27) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45071243498/job/137358443946) · `29f6fd4fe1e2`
- [PR #24](https://github.com/groktopus/proprio/pull/24) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45045888922/job/137280293354) · `e5ad777b48d0`
- [PR #30](https://github.com/groktopus/proprio/pull/30) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/45045899400/job/137280325352) · `2c49922786bc`
- [PR #25](https://github.com/groktopus/proprio/pull/25) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/44987458116/job/137101063990) · `447d4c3a5672`
- [PR #29](https://github.com/groktopus/proprio/pull/29) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/44987190395/job/137100236551) · `e59143db2a30`
- [PR #28](https://github.com/groktopus/proprio/pull/28) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/44981324078/job/137082227095) · `328e2095c5d7`
- [PR #26](https://github.com/groktopus/proprio/pull/26) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/44979807781/job/137077610339) · `33a44b2b696d`
- [PR #21](https://github.com/groktopus/proprio/pull/21) · [executed smoke](https://github.com/groktopus/proprio/actions/runs/44977318008/job/137069997408) · `2d21eea4376a`
