# Task-open readiness measurement

Date: 2026-11-24

## Owner and purpose

The board maintainer owns the task-open measurement and produces a versioned
report for each release candidate or startup change. The first comparison
uses a disposable loopback fixture. Keep all attempts, investigate new
visible failures or timeouts, and reproduce an apparent median regression
before setting a timing gate. The first readiness frame should keep the
composer and latest comment visible without a layout jump.

## Required matrix

Run at least five serial attempts for each combination:

| Entry | Task state |
| --- | --- |
| Cold direct URL in a new browser context | live run, saved history |
| Uncached in-app list click | live run, saved history |
| Cached return with the saved read cache | live run, saved history |

Each attempt records the exact source, server, UI asset, and target build
identities, composer/latest-message
readiness, ready/error/timeout/closed outcome, CLS and latest-message movement,
API requests before readiness, pending requests, and the request/server timing
that released readiness when available. Report p50 and p95 over ready attempts,
plus counts for every outcome.

## Repeat and comparison

Store the raw evidence and generated Markdown report under a release evidence
location outside the committed source tree. Run the report generator with the
previous report as its comparison baseline. A p50 delta is shown only when both
builds have ready samples for the same cohort and task state. Re-run after a
release or any change to task bootstrap, task chat, caching, list prefetch,
transcript gating, or layout.

## Scope and limits

The local fixture target is disposable and proves harness behavior and relative
changes only. A staging click target adds real network and server contention but
does not represent every tenant. Managed browser tracing uses sampled ready
spans and a different population, while the harness includes failures,
timeouts, and tab closes. A tab that closes before the browser reports an
outcome is unobservable and must be counted separately when known. Neither
local nor staging evidence alone establishes release-wide latency, provider
execution quality, or object-store tail behavior.

## First test-instance comparison

The baseline was published v0.0.3 at
`4e3525fd8381bc813f1fd9e54b8753e6bd6cd49e`. The comparison build was
`b0a7597a682d24deed624cc469a2e43d0e53764e`. Both runs used production Vite
assets, the same synthetic fixtures, embedded PostgreSQL, and pinned
Chromium 151.0.7922.34 on macOS arm64. The live cohort had a confirmed
running local process during each attempt. The two windows began at
13:42:45 and 13:45:18 UTC on November 24, 2026.

| Entry | Task state | v0.0.3 p50 / p95 | Comparison p50 / p95 |
| --- | --- | ---: | ---: |
| Cold direct | Live run | 496 / 526.2 ms | 485 / 522.8 ms |
| Cold direct | Saved history | 458 / 592.8 ms | 453 / 533 ms |
| Uncached in-app | Live run | 272 / 323.8 ms | 265 / 300.2 ms |
| Uncached in-app | Saved history | 223 / 236.2 ms | 221 / 222.6 ms |
| Cached return | Live run | 236 / 270.6 ms | 247 / 269 ms |
| Cached return | Saved history | 204 / 212.2 ms | 197 / 205.6 ms |

Every cohort reached readiness in all five attempts on each build.
There were zero visible errors, timeouts, tab closes, or observed
post-reveal moves of the latest message. Median changes ranged from
11 ms faster to 11 ms slower. The sample is too small to establish a
performance trend or justify a timing gate.

The comparison retained composer and latest-message marks and request
timings for every attempt. The SHA-256 digests of the raw baseline and
comparison reports are
`f0ec039902bf85f425f71d2140fa2476d583962a76502a7062430d5e757e3492`
and `36d809f35918c916684ef348ce6bcd3a04e9540fb4c52fba09b6d3839bdf741d`.
