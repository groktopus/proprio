# Proprio CLI

This CLI is available from the source checkout. Proprio does not publish an npm package or install script yet. Do not install an identically named registry package or use an installer from a different project.

From the repository root, after following the [local development prerequisites](../doc/DEVELOPING.md#prerequisites):

```sh
pnpm install --frozen-lockfile
pnpm proprio --help
```

For inputs containing text or file paths, follow the [CLI reference](../doc/CLI.md) to invoke the local source directly without a package-manager command wrapper. See [provenance and licensing](../PROVENANCE.md) for the source baseline.
