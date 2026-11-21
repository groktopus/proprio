# Hermes Gateway Adapter Compatibility Shim

`@groktopus/adapter-hermes-gateway` is a deprecated compatibility shim.

Use `@groktopus/hermes-proprio-adapter` for new installs and import gateway
entrypoints from `@groktopus/hermes-proprio-adapter/gateway`. The adapter
type remains `hermes_gateway`; only package ownership changed.

`hermes_gateway` is for an already-running Hermes API server. It does not start
the local Hermes CLI. If Proprio should launch local `hermes chat` as a child
process, use `hermes_local` from `@groktopus/hermes-proprio-adapter`
instead.

The shim preserves the legacy exports for one release:

- `.`
- `./server`
- `./ui`
- `./cli`
- `./ui-parser`

These exports forward to the unified Hermes package. Existing
`@groktopus/adapter-hermes-gateway` plugin installs should continue to load
during the compatibility window, but should migrate to
`@groktopus/hermes-proprio-adapter` before the shim is removed.
