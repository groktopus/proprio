# Proprio Eval Kernel

`@groktopus/proprio-eval-kernel` is the workspace-private, provider-neutral
matrix orchestrator owned by Proprio Evals. It contains no Proprio scenario
corpus, provider configuration, product fixture, scorer, or report template.

Consumers pass scenario and candidate values plus execution and scoring
callbacks. Candidate `preflight` hooks should call the runner package's
`assertProprioRunnerCompatibility` before any provider work starts. This keeps
catalog, protocol, runner-client, control-plane-adapter, testkit, corpus, and
provider-operation incompatibilities explicit.

Proprio App may consume this package only as a development dependency for CI
or parity tests. `@groktopus/proprio-runner` has no runtime dependency on it.
