# Submit-to-first-visible-agent-activity measurement

Issue #177 adds a release-level user-wait measure to the native run baseline.
The existing run-created activity measure remains the narrower speed-budget
diagnostic. This plan records the metric boundary and the evidence limits.

## Metric definitions

- Submit is the accepted input span: `comment.to_run_created` or
  `question_response.to_run_created`. For a deferred wake, the accepted wake
  request is the trace anchor when the trace records it.
- Queue wait is the accepted-input to run-created segment. It is reported
  separately because it is the time spent behind an active turn.
- First visible activity is the end of
  `task.time_to_first_agent_activity`. It includes text deltas, tool-call
  starts, and reasoning activity that the board can render.
- Submit-to-first-visible-activity is queue wait plus the existing
  run-created-to-activity metric. It is the user-wait proxy.
- First text is the end of `task.time_to_first_token`, reported separately.
  Tool-first turns can have first activity but no first text.
- The run-created activity value remains the speed-budget diagnostic. It must
  not be substituted for submit-to-first-visible-activity in release reports.

## Reporter and evidence

`tests/restart-chaos/ttft-baseline.ts --report` now prints an exact-build
baseline with adapter, environment, and cold/warm rows. Each row includes
attempts, failed or timed-out run records, no-visible-activity records, and
p50/p95 for submit-to-activity and submit-to-first-text. The raw report keeps
the trace/run evidence and queue, preparation, runner, and provider spans.

The driver records the checked-out Git SHA. A timed-out task remains in the
attempt accounting even when it has no stable run record. Missing activity is
never converted to a latency value.

For a browser cross-check, run the opt-in Playwright spec
`tests/perf/agent-activity/submit-to-first-visible.spec.ts` against an
authenticated seeded checkout. It records the time from the browser submit to
the first new task-chat row. This is a UI visibility proxy, not provider proof.
Join it to the run trace by run ID and report any mismatch. The spec is not a
replacement for the native trace.

## Baseline and follow-up

Run a baseline from an exact build with representative local adapters and a
supported remote environment when credentials and a signed image are
available. Retain the JSON, Markdown report, and browser cross-check artifact.
Repeat the same sample plan after release and compare by adapter, environment,
and cold/warm state. A missing adapter or environment is an explicit gap, not
an inferred zero.

The native-runtime owner reviews this report at each release qualification.
The review cadence is one report per release, with follow-up when p95 or the
no-visible-activity count regresses.
