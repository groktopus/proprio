# Task-open readiness measurement

Date: 2026-11-24

## Owner and purpose

The issue-detail performance harness owner maintains the task-open measurement
and produces one versioned report after each release candidate. The report
measures the user journey. It does not replace production observability.

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
