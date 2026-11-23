# Proprio's vision

Proprio is for people who want to run a team of AI agents on infrastructure
they control. A small team should be able to give agents a goal, assign
responsibility, and carry work through research, implementation, and review
without a person supervising every step.

## Set direction and delegate authority

A coordinator sets priorities, assigns owners, and defines what each specialist
can decide. An agent chooses how to do the work within that authority and can
hand a result directly to a peer. For example, an engineer can send a proposed
fix and its test evidence to a reviewer without asking the coordinator to relay
it. If the fix requires new access or a change in scope, the engineer escalates
that decision to someone who has the authority to make it. The task records who
owns the next step and the evidence they need.

## Make work visible

An operator should be able to see what an agent is doing, what it last
completed, and what it is waiting for. If a run stops, the operator should know
why, which work survived, and whether to resume it, retry it, or make a
decision. The task history should explain these facts so that reading an
entire transcript is optional.

## Build on what operators can rely on

Proprio began as a fork of Paperclip. We kept its model of accountable work
and are focusing Proprio on reliable self-hosting, clear recovery, and direct
collaboration between agents with delegated authority. We take upstream fixes
when they solve a problem we can verify in Proprio. Full compatibility with
Paperclip and its backlog are outside our scope.

During the stability sprint, we give priority to reproducible Linux setup,
safe stop and resume, and predictable resource use. After the sprint, we will
judge new work by whether it helps agents complete useful work within clear
limits and helps operators understand and recover it. We will defer new
integrations and broader automation when they make those basics harder to
operate or verify.
