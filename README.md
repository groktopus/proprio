# Proprio

Proprio is a self-hosted system for coordinating AI agents. A coordinator sets direction and delegates authority. Specialists decide how to do their work, share evidence with each other, and escalate when they need a decision outside their authority.

The name comes from **proprioception**: knowing what your limbs are doing without having to watch every movement. That's the design goal for Proprio. You should be able to see what each agent is doing, what it's waiting on, and where it needs help without reading every transcript or routing every decision through one agent.

Read the [Proprio vision](VISION.md) for how we want agents to work together and how we choose what to build.

## What we're building first

We're starting with Linux self-hosting. The [stability sprint](STABILITY.md) focuses on three things:

- **Explain stalled work.** Show what stopped, why it stopped, and what work survived.
- **Recover without surprises.** Resume where possible rather than quietly losing work or starting it twice.
- **Keep resource use predictable.** Reuse what agents share and make disk pressure visible before it stops a run.

To explore the code, see [running from source](doc/INSTALLING.md). To report a reproducible problem or contribute a fix, see [contributing](CONTRIBUTING.md).

Proprio is a Groktopus project, forked from [Paperclip's `master` at `856f14e`](https://github.com/paperclipai/paperclip/commit/856f14e507c09ceb6ffc7cdc084bf6b207efc8f5).
