# Roadmap

Proprio begins with a stability cleanup, not a compatibility promise or a catalog of new features.

1. Establish a reproducible Linux build and end-to-end run.
2. Make stalled work explainable: show the last useful step, what was preserved, and what action could unblock it.
3. Verify stop, restart, and resume without duplicate execution or lost work.
4. Bound storage growth and make disk pressure visible before it stops the runner.
5. Validate dependable harness support before adding more integrations.

See [STABILITY.md](STABILITY.md) for bug and patch intake. Later architecture work should document who can delegate, when peer agents can coordinate directly, and when authority must be escalated.
